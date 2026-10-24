// CAD viewer front end: backend selection (WebGPU -> WebGL2 -> WebGL1), loading
// (.cadmesh direct, .stp/.step/.igs/.brep through the OpenCascade worker),
// orbit camera, part tree, picking, section plane. Rendering is on demand.

import { decodeCadmesh } from './cadmesh.js';
import { camDir, camUp, eyeOf, fitDistance, nearFar, sphereOf } from './camera.js';
import { lookAt, multiply, perspective, ortho } from './mat4.js';
import { WebGLRenderer } from './renderer-webgl.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const STATE_W = 1024;
const BG = [0.114, 0.129, 0.153];
const HIGHLIGHT = [1.0, 0.55, 0.1, 1];

const app = {
  status: 'init',
  backend: null,
  attempts: [],
  renderer: null,
  mesh: null,
  header: null,
  sphere: { center: [0, 0, 0], radius: 1 },
  sourceName: '',
  lastStepBuffer: null,
  loadSeq: 0,
  cancelTess: null,
  wanted: null,
  selected: new Set(),
  hidden: new Set(),
  hover: 0,
  hoverSeq: 0,
  viewGen: 0,
  cam: { target: [0, 0, 0], dist: 1000, yaw: 0.7, pitch: 0.45, fov: Math.PI / 4, ortho: false, up: 'y', viewRadius: 500 },
  section: { axis: 'off', t: 0.5, flip: false },
  frameQueued: false,
  frameCount: 0,
};
window.__cadv = app;

function setStatus(s, msg) {
  app.status = s;
  $('status').textContent = msg || s;
  $('status').dataset.state = s;
}

// ---------- backend ----------

async function makeRenderer() {
  app.attempts = [];
  const order = { webgpu: ['webgpu'], webgl2: ['webgl2'], webgl1: ['webgl1'] }[params.get('backend')]
    || ['webgpu', 'webgl2', 'webgl1'];
  for (const name of order) {
    // A canvas keeps the first context type it hands out, so every attempt gets a fresh one.
    const old = $('view');
    const canvas = old.cloneNode(false);
    old.replaceWith(canvas);
    try {
      let r;
      if (name === 'webgpu') {
        const { WebGPURenderer } = await import('./renderer-webgpu.js');
        r = await WebGPURenderer.create(canvas);
      } else {
        r = WebGLRenderer.create(canvas, name === 'webgl2' ? 2 : 1);
      }
      app.attempts.push({ backend: name, ok: true });
      return r;
    } catch (e) {
      app.attempts.push({ backend: name, ok: false, error: String(e.message || e) });
      console.warn(`backend ${name} unavailable:`, e);
    }
  }
  throw new Error(`no GPU backend: ${app.attempts.map((a) => `${a.backend}: ${a.error}`).join('; ')}`);
}

function adoptRenderer(r) {
  const old = app.renderer;
  app.renderer = r;
  app.backend = r.name;
  app.viewGen++; // picks aimed at the old renderer's frame no longer apply
  // The replaced renderer must neither report losses (its later eviction would
  // tear down this live one) nor keep its context/device alive.
  if (old && old !== r) {
    old.onlost = null;
    old.onerror = null;
    try { old.destroy(); } catch (e) { /* already gone */ }
  }
  for (const w of rendererWaiters.splice(0)) w();
  // One report per renderer, and only while it is the current one: a WebGL
  // context already lost at adoption is reported both by the check below and
  // by its queued webglcontextlost event.
  let reported = false;
  r.onlost = (why) => {
    if (reported || app.renderer !== r) return;
    reported = true;
    recoverRenderer(why);
  };
  r.onerror = (msg) => { if (app.renderer === r) { app.error = msg; setStatus('error', `GPU error: ${msg}`); } };
  // lost between creation and here (onlost was not wired yet): report it now
  if (isDead(r)) queueMicrotask(() => r.onlost && r.onlost('lost before it was adopted'));
  $('backend').textContent = app.backend.toUpperCase();
  $('backend').title = `${r.adapterInfo || ''}\n${r.detail || ''}\n` +
    app.attempts.map((a) => `${a.backend}: ${a.ok ? 'ok' : a.error}`).join('\n');
}

// ---------- GPU model sync ----------
//
// app.wanted is the ONE model the GPU should hold. Only gpuSync() uploads, one
// at a time in call order, and it uploads app.wanted as it stands when it runs.
// A superseded load therefore never uploads, and nothing ever has to be
// "restored" (the restore re-uploads raced newer loads in every arrangement
// review rounds 2-3 tried). Each pick reports the mesh it drew, and pickAt
// rejects answers about any mesh but app.mesh.
let gpuChain = Promise.resolve();
const rendererWaiters = [];

const isDead = (r) => !r || r.lost || (r.gl && r.gl.isContextLost());

// Resolves once app.renderer is no longer `old` (recovery adopted a new one);
// rejects when recovery gives up (failRendererWaiters). The timeout is only a
// backstop: recovery with its retries and backoff can take ~25 s, and a fixed
// 20 s wait used to drop a load that recovery was about to serve.
function nextRenderer(old, ms = 120000) {
  if (app.renderer !== old) return Promise.resolve();
  // recovery is over: no renderer will come, so fail now rather than at the backstop
  if (gaveUp) return Promise.reject(new Error(gaveUp));
  return new Promise((resolve, reject) => {
    const w = (err) => { clearTimeout(t); err ? reject(err) : resolve(); };
    const t = setTimeout(() => {
      const i = rendererWaiters.indexOf(w);
      if (i >= 0) rendererWaiters.splice(i, 1);
      reject(new Error('GPU lost and not recovered'));
    }, ms);
    rendererWaiters.push(w);
  });
}

function failRendererWaiters(msg) {
  for (const w of rendererWaiters.splice(0)) w(new Error(msg));
}

function gpuSync() {
  const run = gpuChain.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const r = app.renderer;
      if (isDead(r)) await nextRenderer(r); // a load during recovery waits for it
      const cur = app.renderer;
      const want = app.wanted;
      if (!want) {
        // nothing should be drawn (e.g. the only model was superseded mid-upload
        // and its successor failed): drop whatever the GPU still holds, and
        // repaint so the old picture does not linger until the next input
        if (cur.drawn) { await cur.clear(); queueFrame(); }
        return;
      }
      if (cur.drawn === want) return;
      // checked against the renderer that will hold it, which after a recovery
      // can be a smaller backend than the one the load was checked on
      checkFits(cur, want);
      try {
        await cur.upload(want);
        // a model the UI already shows (recovery re-upload): its state texture
        // goes in before any pick queued behind this job can run
        if (want === app.mesh) pushState();
        queueFrame();
        return;
      } catch (e) {
        // lost mid-upload: retry once on the recovered renderer
        if (attempt === 0 && isDead(cur)) { await nextRenderer(cur); continue; }
        throw e;
      }
    }
  });
  gpuChain = run.catch(() => {});
  return run;
}

// A lost GPU device / WebGL context takes every buffer with it: make a new
// renderer (the fallback order applies again) and sync app.wanted onto it.
// A loss that arrives while recovering (the NEW renderer dying) is not dropped:
// it re-runs recovery once the current attempt ends, up to 3 attempts.
let recovering = false;
let lossPending = null;
let recoveries = 0;
const RECOVERY_QUIET_MS = 5000;

// Recovery is over without a renderer: say so, and fail every load waiting on
// one, now and later (the page needs a reload).
let gaveUp = null;
function giveUp(msg) {
  gaveUp = msg;
  beginLoad(); // a load still fetching or tessellating goes stale and stops painting progress
  setStatus('error', msg);
  failRendererWaiters(msg);
}
async function recoverRenderer(why) {
  if (recovering) { lossPending = why; return; }
  if (recoveries >= 3) {
    giveUp(`GPU lost repeatedly (${why}); reload the page`);
    return;
  }
  recovering = true;
  recoveries++;
  setStatus('recovering', `GPU context lost (${why}); recovering`);
  let adopted = false;
  try {
    await new Promise((r) => setTimeout(r, 250));
    adoptRenderer(await makeRenderer());
    adopted = true;
  } catch (e) {
    app.error = String(e.message || e);
    // the GPU process may still be restarting: try again (backing off) while
    // attempts remain, instead of giving up after one failed creation
    if (recoveries < 3 && lossPending === null) {
      lossPending = `${why}; retry after: ${app.error}`;
      await new Promise((r) => setTimeout(r, 1000 * recoveries));
    } else if (lossPending === null || recoveries >= 3) {
      giveUp(`GPU lost and not recovered: ${app.error}`);
    }
    // else: a loss reported meanwhile re-runs recovery below
  } finally {
    // Recovery ends at ADOPTION and does not wait for the re-upload: the
    // upload can itself wait for a further recovery (the new device dying),
    // which could never start while this one was still "recovering".
    recovering = false;
  }
  if (adopted) {
    const r = app.renderer;
    queueFrame();
    gpuSync().then(() => {
      queueFrame();
      // only a renderer that survives its re-upload AND some seconds of
      // drawing counts as a clean recovery and resets the attempt count: a
      // device lost on every draw (a watchdog reset on a huge model) would
      // otherwise reset it each cycle and recover forever
      setTimeout(() => { if (app.renderer === r && !isDead(r)) recoveries = 0; }, RECOVERY_QUIET_MS);
      // a load that started meanwhile owns the status line; do not paint over it
      if (app.status === 'recovering') {
        setStatus(app.mesh ? 'ready' : 'idle', app.mesh ? `ready (recovered on ${app.backend})` : 'idle');
      }
    }, (e) => {
      if (app.renderer !== r) return; // superseded by a further recovery
      // r died too: the GPU, not the model, is the problem, and the recovery
      // that follows (or giveUp) owns the status line
      if (isDead(r)) return;
      app.error = String(e.message || e);
      // the renderer is live; it is the model that does not fit (e.g. after
      // falling back to a smaller backend)
      setStatus('error', `recovered on ${app.backend}, but it cannot hold this model: ${app.error}`);
    });
  }
  if (lossPending !== null) {
    const again = lossPending;
    lossPending = null;
    if (recoveries < 3) recoverRenderer(again);
    else giveUp(`GPU lost repeatedly (${again}); reload the page`);
  }
}

// ---------- camera ----------

function frameState() {
  const c = app.cam;
  const r = app.renderer;
  const d = camDir(c);
  const eye = eyeOf(c, app.sphere);
  const view = lookAt(eye, c.target, camUp(c));
  const w = r.canvas.width || 1, h = r.canvas.height || 1;
  const [near, far] = nearFar(c, app.sphere);
  const zo = r.name === 'webgpu';
  const proj = c.ortho
    ? ortho(c.dist * Math.tan(c.fov / 2) * (w / h), c.dist * Math.tan(c.fov / 2), near, far, zo, !!r.reverseZ)
    : perspective(c.fov, w / h, near, far, zo, !!r.reverseZ);
  // key light: above and to the left of the viewer
  const right = [view[0], view[4], view[8]];
  const upv = [view[1], view[5], view[9]];
  const light = [0, 1, 2].map((k) => d[k] + upv[k] * 0.6 - right[k] * 0.4);
  const up = c.up === 'z' ? [0, 0, 1] : [0, 1, 0];
  // eye.w = 1: a point (perspective: view vector = eye - p); w = 0: the
  // direction to the viewer (ortho: one view vector for every pixel)
  const eye4 = c.ortho ? [d[0], d[1], d[2], 0] : [eye[0], eye[1], eye[2], 1];
  return {
    viewProj: multiply(proj, view), eye: eye4, light, up, clip: sectionPlane(), highlight: HIGHLIGHT, background: BG,
    // the GPU holds a model the UI does not show (a superseded load mid-hand-
    // back): its ids do not match the state texture, so draw background only
    drawModel: r.drawn === app.mesh,
  };
}

function sectionPlane() {
  const s = app.section;
  if (s.axis === 'off' || !app.header || !app.header.bbox) return null;
  const k = { x: 0, y: 1, z: 2 }[s.axis];
  const { min, max } = app.header.bbox;
  const pos = min[k] + (max[k] - min[k]) * s.t;
  const n = [0, 0, 0];
  n[k] = s.flip ? -1 : 1;
  return [n[0], n[1], n[2], s.flip ? -pos : pos];
}

// Anything that changes WHAT is under a given pixel -- the camera, the section
// plane, visibility -- moves app.viewGen, so a pick still in flight from before
// is dropped instead of being applied to whatever is there now. (Hover and
// selection highlights do not: they change colour, not what a pixel hits.)
function viewChanged() {
  app.viewGen++;
  queueFrame();
}

function fitTo(bbox) {
  if (!bbox) return;
  const c = app.cam;
  const s = sphereOf(bbox);
  c.target = s.center;
  c.viewRadius = s.radius;
  const box = $('stage');
  c.dist = fitDistance(s.radius, c.fov, box.clientWidth / Math.max(1, box.clientHeight));
  viewChanged();
}

const VIEWS = {
  iso: [0.7, 0.45], front: [0, 0], back: [Math.PI, 0], left: [-Math.PI / 2, 0],
  right: [Math.PI / 2, 0], top: [0, Math.PI / 2 - 1e-4], bottom: [0, -Math.PI / 2 + 1e-4],
};

function setView(v) {
  [app.cam.yaw, app.cam.pitch] = VIEWS[v];
  fitTo(app.header && app.header.bbox);
}

// ---------- drawing ----------

function queueFrame() {
  if (app.frameQueued || !app.renderer) return;
  app.frameQueued = true;
  requestAnimationFrame(() => {
    app.frameQueued = false;
    resize();
    app.renderer.render(frameState());
    app.frameCount++;
  });
}

function resize() {
  const r = app.renderer;
  const box = $('stage');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Never ask the GPU for a render target larger than it supports -- and scale
  // BOTH sides by the same factor, so the canvas keeps the aspect of the box it
  // is stretched over (clamping each side alone distorted the picture).
  const lim = r.maxCanvasSize || 4096;
  const cw = Math.max(1, box.clientWidth * dpr);
  const ch = Math.max(1, box.clientHeight * dpr);
  const s = Math.min(1, lim / cw, lim / ch);
  const w = Math.max(1, Math.round(cw * s));
  const h = Math.max(1, Math.round(ch * s));
  // a renderer that was never sized (a fresh one on a cloned canvas that
  // already has the right width/height) still resizes once, so its own
  // drawing-buffer checks run
  const req = r.requested;
  if (!req || req[0] !== w || req[1] !== h) {
    r.resize(w, h);
    app.viewGen++; // a pick aimed at the old size's pixels no longer applies
  }
}

// State-texture rows for n bodies (ids 1..n, texel 0 unused), rounded up to a
// power of two: the shader samples row y at (y + 0.5) / H, which is exact in
// fp16 (mediump-only GPUs) only when H is a power of two.
function stateHeight(n) {
  const rows = Math.ceil((n + 1) / STATE_W);
  return 2 ** Math.ceil(Math.log2(Math.max(1, rows)));
}

function pushState() {
  if (!app.header || !app.renderer) return;
  const H = stateHeight(app.header.meshes.length);
  const bytes = new Uint8Array(STATE_W * H * 4);
  for (const id of app.selected) bytes[id * 4] = 255;
  for (const id of app.hidden) bytes[id * 4 + 1] = 255;
  if (app.hover) bytes[app.hover * 4 + 2] = 255;
  app.renderer.setState(bytes, STATE_W, H);
  queueFrame();
}

// ---------- loading ----------

// Every load takes a sequence number; a load that finishes after a newer one
// started is discarded instead of replacing the newer model.
// The Save button and its buffer change only when a new model actually loads
// (in loadBuffer): a failed load leaves the old model, and Save, as they were.
function beginLoad() {
  app.loadSeq++;
  // settle a superseded tessellation (a terminated worker fires no events,
  // so its timer and promise would otherwise live forever)
  if (app.cancelTess) app.cancelTess();
  return app.loadSeq;
}

function stale(seq) {
  return seq !== app.loadSeq;
}

// Give the GPU back to the model the UI shows, if `mesh` (a load that failed or
// was superseded) still holds the claim. If even that re-upload fails -- e.g.
// out of memory, since an upload builds before it frees -- the UI and the GPU
// would disagree with no error shown, so drop the model and say why.
function handBack(mesh) {
  if (app.wanted !== mesh) return; // a newer load has claimed the GPU
  app.wanted = app.mesh;
  gpuSync().catch((e) => {
    if (app.wanted !== app.mesh || !app.mesh) return; // superseded meanwhile
    // no GPU at all (recovery gave up, or it is still recovering): the model
    // is not the problem, so keep it and the status line's GPU message
    if (gaveUp || isDead(app.renderer)) return;
    dropModel(`could not put ${app.sourceName} back on the GPU: ${e.message || e}`);
  });
}

function dropModel(msg) {
  app.mesh = null;
  app.header = null;
  app.wanted = null;
  app.sphere = { center: [0, 0, 0], radius: 1 };
  app.selected.clear();
  app.hidden.clear();
  app.hover = 0;
  app.hoverSeq++;
  app.viewGen++;
  app.lastStepBuffer = null;
  $('export').disabled = true;
  $('tree').textContent = '';
  $('hover').textContent = '';
  $('model').textContent = '';
  showInfo();
  gpuSync().catch(() => {});
  app.error = msg;
  setStatus('error', msg);
}

// Body ids travel as 3 bytes (shaders and pick read-back), so 2^24 - 1 bodies max.
const MAX_BODIES = 0xffffff;

// Throws unless renderer r can address every body of mesh in its state texture.
function checkFits(r, mesh) {
  const bodies = mesh.header.meshes.length;
  if (bodies > MAX_BODIES) throw new Error(`${bodies} bodies: over the ${MAX_BODIES} this viewer can address`);
  if (r && r.maxStateHeight && stateHeight(bodies) > r.maxStateHeight) {
    throw new Error(`${bodies} bodies exceed this GPU's state texture (${STATE_W * r.maxStateHeight - 1} max)`);
  }
}

// stepBuf: the tessellated buffer when this load came from a STEP import (what
// Save .cadmesh writes), null for a .cadmesh load.
async function loadBuffer(buf, name, seq, stepBuf = null) {
  const t0 = performance.now();
  const mesh = decodeCadmesh(buf);
  checkFits(app.renderer, mesh);
  if (stale(seq)) return; // a newer load owns app.wanted; never upload a stale model
  app.wanted = mesh;
  try {
    // Rejects on a GPU allocation/validation failure; the renderer then still
    // holds the current model (uploads build first and swap on success).
    await gpuSync();
  } catch (e) {
    handBack(mesh);
    throw e;
  }
  if (stale(seq)) {
    // superseded during our upload: if no newer load has claimed the GPU yet
    // (it may still be fetching or fail before it does), hand it back to the
    // model the UI shows. A newer load that did claim it uploads after us.
    handBack(mesh);
    return;
  }
  app.mesh = mesh;
  app.header = mesh.header;
  app.sphere = sphereOf(mesh.header.bbox);
  app.sourceName = name;
  app.lastStepBuffer = stepBuf;
  $('export').disabled = !stepBuf;
  app.selected.clear();
  app.hidden.clear();
  app.hover = 0;
  app.hoverSeq++; // a hover answer computed against the old model must not apply
  app.viewGen++; // and neither may a click aimed at it
  $('hover').textContent = '';
  pushState();
  buildTree();
  setView('iso');
  const tris = mesh.header.indexCount / 3;
  app.stats = { meshes: mesh.header.meshes.length, triangles: tris, vertices: mesh.header.vertexCount, uploadMs: Math.round(performance.now() - t0) };
  $('model').textContent = `${name} · ${mesh.header.meshes.length} bodies · ${fmtInt(tris)} triangles`;
  showInfo();
  setStatus('ready', 'ready');
}

const STEP_EXT = { stp: 'step', step: 'step', igs: 'iges', iges: 'iges', brep: 'brep' };

function extOf(name) {
  const m = /\.([a-z0-9]+)(?:$|\?)/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

async function loadAny(buf, name, seq) {
  // a load superseded while it was reading/fetching must not start a worker
  // (it would also take over app.cancelTess from the newer load)
  if (stale(seq)) return;
  const ext = extOf(name);
  if (STEP_EXT[ext]) {
    const out = await tessellate(buf, STEP_EXT[ext], seq);
    if (stale(seq)) return;
    await loadBuffer(out, name, seq, out);
    return;
  }
  if (stale(seq)) return;
  await loadBuffer(buf, name, seq);
}

function tessellate(buf, format, seq) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./step-worker.js', import.meta.url));
    const t0 = performance.now();
    let stage = 'starting OpenCascade worker';
    const show = () => { if (!stale(seq)) setStatus('tessellating', `${stage} · ${Math.round((performance.now() - t0) / 1000)} s`); };
    const tick = setInterval(show, 1000);
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      w.terminate();
      if (app.cancelTess === cancel) app.cancelTess = null;
      fn(v);
    };
    const cancel = () => done(reject, new Error('superseded by a newer load'));
    app.cancelTess = cancel;
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') { stage = m.stage; show(); }
      else if (m.type === 'done') done(resolve, m.buffer);
      else done(reject, new Error(m.message));
    };
    w.onerror = (e) => done(reject, new Error(e.message || 'worker failed'));
    show();
    w.postMessage({ buffer: buf, format }, [buf]);
  });
}

async function loadUrl(url) {
  const seq = beginLoad();
  setStatus('loading', `fetching ${url}`);
  const res = await fetch(url);
  if (stale(seq)) return;
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  // content-length is the size ON THE WIRE: with a content-encoding (gzip,
  // br) it is the compressed size and the decoded bytes overshoot it, so a
  // percentage is shown only for an unencoded body.
  const total = Number(res.headers.get('content-length')) || 0;
  const pct = total && !res.headers.get('content-encoding');
  let buf;
  if (res.body) {
    const chunks = [];
    let got = 0;
    const rd = res.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      if (stale(seq)) { rd.cancel(); return; }
      chunks.push(value);
      got += value.length;
      // through setStatus, so a recovery that ends mid-fetch sees a load in
      // progress (app.status 'loading') and does not paint "ready" over it
      setStatus('loading', pct
        ? `fetching ${Math.min(100, Math.round((100 * got) / total))}% of ${(total / 1e6).toFixed(1)} MB`
        : `fetching ${(got / 1e6).toFixed(1)} MB`);
    }
    const all = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    buf = all.buffer;
  } else {
    buf = await res.arrayBuffer();
  }
  return loadAny(buf, url.split('/').pop(), seq);
}

async function loadFile(file) {
  const seq = beginLoad();
  setStatus('loading', `reading ${file.name}`);
  const buf = await file.arrayBuffer();
  if (stale(seq)) return;
  return loadAny(buf, file.name, seq);
}

// A failure is reported only if it belongs to the newest load (or to no load).
function guard(p, seq = null) {
  return p.catch((e) => {
    if (seq !== null && stale(seq)) return;
    console.error(e);
    app.error = String(e.message || e);
    setStatus('error', app.error);
  });
}

// Start a load and report its failure only if it is still the newest load.
// fn() calls beginLoad() synchronously, so app.loadSeq here is that load's.
function startLoad(fn) {
  // with no GPU left there is nothing to load onto: refuse before a fetch or a
  // long tessellation, and keep the give-up message on the status line
  if (gaveUp) { setStatus('error', gaveUp); return Promise.resolve(); }
  const p = fn();
  return guard(p, app.loadSeq);
}

// ---------- tree ----------

function collect(node, out = []) {
  for (const i of node.meshes) out.push(i + 1);
  for (const c of node.children) collect(c, out);
  return out;
}

// Label a body by the part that owns it: CAD exporters name bodies generically
// (some exporters: COMPONENT1..n), while the tree carries the real part names.
function labelMeshes() {
  const labels = app.header.meshes.map((m) => m.name);
  const walk = (n, owner) => {
    const nm = n.name || owner;
    for (const i of n.meshes) {
      const mn = app.header.meshes[i].name;
      labels[i] = nm && nm !== mn ? `${nm} › ${mn}` : mn;
    }
    for (const c of n.children) walk(c, nm);
  };
  walk(app.header.root, '');
  app.meshLabel = labels;
}

const meshLabel = (id) => app.meshLabel[id - 1];

function buildTree() {
  labelMeshes();
  const root = $('tree');
  root.textContent = '';
  const mk = (node, depth) => {
    const ids = collect(node);
    if (!ids.length) return null;
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';
    row.style.paddingLeft = `${depth * 12 + 4}px`;
    const kids = node.children.map((c) => mk(c, depth + 1)).filter(Boolean);
    const tw = document.createElement('span');
    tw.className = 'tw';
    tw.textContent = kids.length ? (depth < 2 ? '▾' : '▸') : '';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    const label = document.createElement('span');
    label.className = 'label';
    const meshName = !node.name && node.meshes.length === 1 ? app.header.meshes[node.meshes[0]].name : '';
    label.textContent = node.name || meshName || '(unnamed)';
    label.title = `${ids.length} bod${ids.length === 1 ? 'y' : 'ies'}`;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = ids.length > 1 ? ids.length : '';
    row.append(tw, cb, label, cnt);
    li.append(row);
    li._ids = ids;
    li._cb = cb;
    if (kids.length) {
      const ul = document.createElement('ul');
      // one at a time: spreading a huge flat assembly into one call passes the
      // engine's argument limit (RangeError) after the UI has switched models
      for (const k of kids) ul.append(k);
      ul.hidden = depth >= 2;
      li.append(ul);
      tw.onclick = () => { ul.hidden = !ul.hidden; tw.textContent = ul.hidden ? '▸' : '▾'; };
    }
    cb.onchange = () => {
      for (const id of ids) (cb.checked ? app.hidden.delete(id) : app.hidden.add(id));
      syncTreeChecks();
      pushState();
      viewChanged();
    };
    label.onclick = (e) => select(ids, e.shiftKey || e.ctrlKey || e.metaKey);
    label.ondblclick = () => fitTo(bboxOf(ids));
    return li;
  };
  const top = mk(app.header.root, 0);
  if (top) root.append(top);
}

// One source of truth for every row: a node is checked while any body under it
// is visible, and highlighted while every body under it is selected.
function syncTreeChecks() {
  document.querySelectorAll('#tree li').forEach((li) => {
    li._cb.checked = li._ids.some((id) => !app.hidden.has(id));
  });
  document.querySelectorAll('#tree .row').forEach((row) => {
    const li = row.parentElement;
    row.classList.toggle('sel', li._ids.length > 0 && li._ids.every((id) => app.selected.has(id)));
  });
}

// ---------- selection ----------

function bboxOf(ids) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const id of ids) {
    const b = app.header.meshes[id - 1].bbox;
    if (!b) continue;
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); }
  }
  return min[0] === Infinity ? null : { min, max };
}

function select(ids, additive) {
  if (!additive) app.selected.clear();
  for (const id of ids) app.selected.add(id);
  pushState();
  syncTreeChecks();
  showInfo();
}

function showInfo() {
  const el = $('info');
  if (!app.header) { el.textContent = ''; return; }
  const ids = [...app.selected];
  const b = ids.length ? bboxOf(ids) : app.header.bbox;
  const dims = b ? [0, 1, 2].map((k) => (b.max[k] - b.min[k]).toFixed(1)).join(' × ') : '-';
  let title = 'whole model';
  if (ids.length === 1) title = meshLabel(ids[0]);
  else if (ids.length > 1) title = `${ids.length} bodies`;
  const tris = (ids.length ? ids.map((id) => app.header.meshes[id - 1].idxCount) : [app.header.indexCount]).reduce((a, x) => a + x, 0) / 3;
  el.innerHTML = '';
  const add = (k, v) => {
    const d = document.createElement('div');
    const a = document.createElement('b');
    a.textContent = k;
    d.append(a, ` ${v}`);
    el.append(d);
  };
  add('selection', title);
  add(`extent X × Y × Z (${app.header.units === 'millimeter' ? 'mm' : app.header.units})`, dims);
  add('triangles', fmtInt(tris));
}

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

// ---------- input ----------

function devicePx(e) {
  const c = app.renderer.canvas;
  const r = c.getBoundingClientRect();
  return [
    Math.min(c.width - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * c.width))),
    Math.min(c.height - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * c.height))),
  ];
}

// Resolves to the body id under (x, y), 0 for background, or null when no
// answer is available (GPU lost): callers must not treat null as "nothing".
// An answer computed against a model that has since been replaced is also null:
// its id would index the new model's bodies.
// A pick is valid only if the VIEW it was aimed at still stands when it
// answers: app.viewGen moves whenever the shown model, its camera/state, or
// the renderer changes, so a click made on model A that resolves after model B
// took over (even though the GPU drew B for it) is dropped, not applied to B.
app.pickAt = async (x, y) => {
  const gen = app.viewGen;
  try {
    // the renderer evaluates the frame when the pick runs, and says which mesh
    // it drew; an answer about anything but the model the UI shows is null
    const res = await app.renderer.pick(x, y, frameState);
    if (gen !== app.viewGen) return null;
    if (!res || !app.mesh || res.mesh !== app.mesh) return null;
    return res.id <= app.mesh.header.meshes.length ? res.id : null;
  } catch (e) {
    console.warn('pick failed:', e);
    return null;
  }
};

function wireInput() {
  const stage = $('stage');
  // One gesture at a time: only the pointer that started it moves, ends or
  // clicks it. A second finger is ignored instead of hijacking the first.
  let drag = null;
  const endDrag = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    if (drag) return;
    stage.setPointerCapture(e.pointerId);
    const pan = e.button === 1 || e.button === 2 || e.shiftKey;
    drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan, moved: false, id: e.pointerId };
  });
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('lostpointercapture', endDrag);

  // Hover: at most one pick per 60 ms AND one in flight at a time (a WebGPU
  // pick slower than 60 ms would otherwise pile up in the renderer's queue
  // ahead of a click), and always a trailing pick at the last position, so
  // stopping on the background clears the highlight.
  let hoverT = 0;
  let hoverTimer = null;
  let hoverXY = null;
  let hoverBusy = false;
  let hoverAgain = false;
  const setHover = (id) => {
    if (id === app.hover) return;
    app.hover = id;
    $('hover').textContent = id ? meshLabel(id) : '';
    pushState();
  };
  const hoverPick = () => {
    hoverTimer = null;
    if (!app.mesh || !hoverXY || drag) return;
    if (hoverBusy) { hoverAgain = true; return; } // run once more when it answers
    hoverBusy = true;
    hoverT = performance.now();
    const seq = ++app.hoverSeq;
    app.pickAt(...hoverXY).then((id) => {
      // drop answers overtaken by a newer hover pick, a click, or a load
      if (seq === app.hoverSeq && id !== null) setHover(id);
    }, () => {}).finally(() => {
      hoverBusy = false;
      if (hoverAgain) { hoverAgain = false; hoverPick(); }
    });
  };
  stage.addEventListener('pointerleave', () => {
    hoverXY = null;
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    app.hoverSeq++;
    if (app.mesh) setHover(0);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) {
      if (!app.mesh) return;
      hoverXY = devicePx(e);
      const wait = 60 - (performance.now() - hoverT);
      if (wait <= 0) hoverPick();
      else if (!hoverTimer) hoverTimer = setTimeout(hoverPick, wait);
      return;
    }
    if (e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 3) drag.moved = true;
    const c = app.cam;
    if (drag.pan) {
      // same screen axes as the view matrix, poles included
      const view = lookAt([0, 0, 0], camDir(c).map((v) => -v), camUp(c));
      const s = (2 * c.dist * Math.tan(c.fov / 2)) / stage.clientHeight;
      for (let k = 0; k < 3; k++) c.target[k] += (-dx * view[k * 4] + dy * view[k * 4 + 1]) * s;
    } else {
      c.yaw -= dx * 0.008;
      c.pitch = Math.max(-Math.PI / 2 + 1e-4, Math.min(Math.PI / 2 - 1e-4, c.pitch + dy * 0.008));
    }
    viewChanged();
  });
  stage.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    // resolves true only when this gesture was a click whose pick applied:
    // a drag, or a pick dropped by a camera change, must not trigger the
    // dblclick fit of an older selection
    lastClick = Promise.resolve(false);
    if (!d.moved && e.button === 0 && app.mesh) {
      const additive = e.ctrlKey || e.metaKey;
      app.hoverSeq++; // a click supersedes any pending hover answer
      lastClick = app.pickAt(...devicePx(e)).then((id) => {
        if (id === null) return false;
        select(id ? [id] : [], additive);
        return true;
      });
    }
  });
  // Fit only after this gesture's click pick has selected: a WebGPU pick is a
  // GPU round trip still in flight when dblclick fires, and fitting first
  // zoomed to the OLD selection (and its viewGen bump dropped both picks).
  let lastClick = Promise.resolve(false);
  stage.addEventListener('dblclick', () => {
    lastClick.catch(() => false).then((clicked) => {
      if (clicked && app.selected.size) fitTo(bboxOf([...app.selected]));
    });
  });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const c = app.cam;
    // per unit of deltaY: pixels (0), lines (1, ~3 per notch), pages (2, ~1 per notch)
    c.dist *= Math.exp(e.deltaY * ([0.0015, 0.05, 0.15][e.deltaMode] ?? 0.0015));
    // zoom range follows what is framed (a small part can be approached) and the
    // model (never further out than 50 model radii)
    c.dist = Math.max(c.viewRadius * 0.05, Math.min(app.sphere.radius * 50, c.dist));
    viewChanged();
  }, { passive: false });
  window.addEventListener('resize', queueFrame);
  // A drop anywhere on the page loads the file: left to the browser, a drop on
  // the sidebar or header would open or download it and lose the view.
  window.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('drop');
    const f = e.dataTransfer.files[0];
    if (f) startLoad(() => loadFile(f));
  });
  $('open').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = ''; // so choosing the same file again fires change
    if (f) startLoad(() => loadFile(f));
  };
  document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  $('fit').onclick = () => fitTo(app.selected.size ? bboxOf([...app.selected]) : app.header && app.header.bbox);
  $('proj').onclick = () => { app.cam.ortho = !app.cam.ortho; $('proj').textContent = app.cam.ortho ? 'ortho' : 'persp'; viewChanged(); };
  $('up').onclick = () => { app.cam.up = app.cam.up === 'y' ? 'z' : 'y'; $('up').textContent = `${app.cam.up.toUpperCase()}-up`; setView('iso'); };
  $('isolate').onclick = () => {
    if (!app.selected.size) return;
    app.hidden = new Set(app.header.meshes.map((_, i) => i + 1).filter((id) => !app.selected.has(id)));
    syncTreeChecks();
    pushState();
    viewChanged();
  };
  $('hide').onclick = () => {
    for (const id of app.selected) app.hidden.add(id);
    app.selected.clear();
    syncTreeChecks();
    pushState();
    showInfo();
    viewChanged();
  };
  $('showall').onclick = () => { app.hidden.clear(); syncTreeChecks(); pushState(); viewChanged(); };
  $('secaxis').onchange = (e) => { app.section.axis = e.target.value; $('secpos').disabled = app.section.axis === 'off'; viewChanged(); };
  $('secpos').oninput = (e) => { app.section.t = Number(e.target.value) / 1000; viewChanged(); };
  $('secflip').onclick = () => { app.section.flip = !app.section.flip; viewChanged(); };
  $('export').onclick = () => {
    if (!app.lastStepBuffer) return;
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([app.lastStepBuffer]));
    a.href = url;
    a.download = `${app.sourceName.replace(/\.[^.]+$/, '')}.cadmesh`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  window.addEventListener('keydown', (e) => {
    // leave browser shortcuts (Ctrl/Cmd/Alt+key) and typing in fields alone
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // only fields that take typed text swallow the letters; a focused tree
    // checkbox or button must not disable the shortcuts
    const t = e.target;
    const typed = (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file', 'range'].includes(t.type))
      || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
    if (typed) return;
    if (e.key === 'f') $('fit').click();
    if (e.key === 'Escape') select([], false);
    if (e.key === 'h') $('hide').click();
    if (e.key === 'i') $('isolate').click();
    if (e.key === 'a') $('showall').click();
  });
}

// ---------- boot ----------

async function main() {
  setStatus('init', 'starting GPU');
  $('export').disabled = true; // a browser may restore the last page's state
  adoptRenderer(await makeRenderer());
  wireInput();
  queueFrame();
  const src = params.get('src');
  if (src) await startLoad(() => loadUrl(src));
  else setStatus('idle', 'open or drop a .stp / .step / .igs / .cadmesh file');
}

// ?selftest=1: after loading, pick the canvas centre and publish one JSON line
// in <pre id="selftest"> so a headless run can grade the backend
// (tests/browser-smoke.sh). Runs on success and on failure.
async function selftest() {
  const out = { status: app.status, backend: app.backend, attempts: app.attempts, error: app.error || null };
  try {
    // ?race=<url>: start a load of <url> (pick a slower one), then immediately
    // re-load ?src. The newer load must win, and the GPU must hold the model
    // the UI shows (review rounds 1-3: superseded loads raced the newer one).
    const race = params.get('race');
    if (race && app.status === 'ready') {
      const want = params.get('src');
      const first = startLoad(() => loadUrl(race));
      const second = startLoad(() => loadUrl(want));
      await Promise.all([first, second]);
      await gpuSync().catch(() => {});
      out.race = {
        shown: app.sourceName,
        wanted: want.split('/').pop(),
        gpuMatchesUi: app.renderer.drawn === app.mesh,
        status: app.status,
      };
      out.status = app.status;
    }
    if (app.status === 'ready') {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const c = app.renderer.canvas;
      const id = await app.pickAt(c.width >> 1, c.height >> 1);
      Object.assign(out, { stats: app.stats, frames: app.frameCount, pickId: id, pickName: id ? meshLabel(id) : null });
    }
  } catch (e) {
    out.error = String(e.message || e);
  }
  const pre = document.createElement('pre');
  pre.id = 'selftest';
  pre.hidden = true;
  pre.textContent = `SELFTEST ${JSON.stringify(out)}`;
  document.body.append(pre);
}

guard(main()).then(() => { if (params.get('selftest')) return selftest(); });
