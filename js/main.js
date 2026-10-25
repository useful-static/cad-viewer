// CAD viewer front end: backend selection (WebGPU -> WebGL2 -> WebGL1), loading
// (.cadmesh direct, .stp/.step/.igs/.brep through the OpenCascade worker),
// orbit camera, part tree, picking, section plane. Rendering is on demand.

import { DEFAULT_TESSELLATION, decodeCadmesh, deflateCadmesh, inflateCadmesh, isGzip } from './cadmesh.js';
import { cacheAvailable, cacheClear, cacheGet, cacheKey, cacheList, cachePut } from './mesh-cache.js';
import { PALETTES, schemeColours } from './palettes.js';
import { camDir, camUp, eyeOf, fitDistance, nearFar, orbitBy, panBy, pinchStep, quatFromView, refitForAspect, sphereOf, zoomBy } from './camera.js';
import { deviceFactor, forecast, forecastDone, forecastTotal, stepOf, timeLeft } from './import-progress.js';
import { lookAt, multiply, perspective, ortho } from './mat4.js';
import { WebGLRenderer } from './renderer-webgl.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const STATE_W = 1024;
const BG = [0.114, 0.129, 0.153];
// Selection tint (cyan; the 4th value is set per frame: 1 = something is
// selected, so the shaders grey out everything else).
const HIGHLIGHT = [0.1, 0.78, 1.0];

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
  // the colour scheme shown (js/palettes.js), remembered in this browser;
  // app.mesh is the model drawn in it, app.baseMesh the model as converted
  palette: (() => {
    let p = null;
    try { p = localStorage.getItem('cadv.palette'); } catch { /* storage off */ }
    return PALETTES.some((x) => x.id === p) ? p : 'file';
  })(),
  baseMesh: null,
};
window.__cadv = app;

// The model as drawn in the current colour scheme: the decoded model itself
// for the file's colours, else a copy that differs only in its colours.
const inScheme = (base) => (app.palette === 'file' ? base : { ...base, color: schemeColours(base, app.palette) });

// The ONE writer of the #announce live region. Every write takes a sequence
// number; a write deferred to the next frame (to repeat the last text, which a
// screen reader only hears again after the region was emptied) lands only if
// nothing newer was said meanwhile -- else a queued "loading x" could land
// after "ready" or an error (a fast failure, or a background tab, where frames
// do not run), and be the last thing said.
let saySeq = 0;
function announce(text) {
  const el = $('announce');
  const seq = ++saySeq;
  if (el.textContent !== text) { el.textContent = text; return; }
  el.textContent = '';
  requestAnimationFrame(() => { if (seq === saySeq) el.textContent = text; });
}

// States whose status text is progress, rewritten per fetch chunk or per
// tessellation tick: never announced by setStatus (the start of a load or a
// tessellation is announced once, explicitly, where it starts).
const PROGRESS_STATES = new Set(['loading', 'tessellating']);

function setStatus(s, msg) {
  // Screen readers hear an EVENT through the polite live region: a state
  // change into ready / idle / error / recovering / init, and a new error
  // after an error (the shown model dropped after a failed load; "GPU lost
  // repeatedly; reload"). #status itself is rewritten on every progress tick.
  if (!PROGRESS_STATES.has(s) && (s !== app.status || (s === 'error' && (msg || s) !== $('announce').textContent))) {
    announce(msg || s);
  }
  app.status = s;
  $('status').textContent = msg || s;
  $('status').title = msg || s; // the whole message, where the line is cut short
  $('status').dataset.state = s;
  if (!PROGRESS_STATES.has(s)) $('progress').hidden = true;
  showEmpty();
}

const IDLE_MSG = 'open or drop a STEP, IGES, BREP or .cadmesh file';
const mb = (n) => (n / 1e6).toFixed(1);

// The empty-state card: shown while there is no model and no load running (and,
// by CSS, during a drag over the view). After a failed load it carries the error.
function showEmpty() {
  const busy = PROGRESS_STATES.has(app.status) || app.status === 'init' || app.status === 'recovering';
  $('empty').hidden = !!app.mesh || busy;
  $('emptyerr').hidden = app.status !== 'error';
  $('emptyerr').textContent = app.status === 'error' ? $('status').textContent : '';
}

// The narrow layout's parts panel, a slide-out over the view. It is "open"
// only where the slide-out exists (the Parts button is shown): a class left
// on from a phone-sized window must not swallow Esc on the desktop layout.
const panelOpen = () => document.body.classList.contains('panel-open')
  && getComputedStyle($('panelbtn')).display !== 'none';
function setPanel(open, focusBack = false) {
  document.body.classList.toggle('panel-open', open);
  $('panelbtn').setAttribute('aria-expanded', String(open));
  // closed from inside (Esc): focus would otherwise sit in a hidden panel
  if (!open && focusBack && $('parts').contains(document.activeElement)) $('panelbtn').focus();
}

// The progress card over the view, for a load in progress. frac is 0..1, or
// null when the length is unknown (tessellation; a stream with no size).
// setStatus hides it on any state that is not a load in progress.
function showProgress(title, frac, detail = '', hint = '') {
  $('progress').hidden = false;
  $('ptitle').textContent = title;
  const bar = $('pbar');
  bar.classList.toggle('busy', frac == null);
  if (frac == null) {
    bar.removeAttribute('aria-valuenow');
    $('pfill').style.width = '';
  } else {
    const p = Math.round(Math.min(1, Math.max(0, frac)) * 100);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(p));
    $('pfill').style.width = `${p}%`;
  }
  $('pdetail').textContent = detail;
  $('phint').textContent = hint;
  $('phint').hidden = !hint;
  showEmpty();
}

// Let the browser paint a progress update before a long synchronous step
// (inflate, decode, upload). requestAnimationFrame never fires in a hidden
// tab, so a timeout bounds the wait: a background load must not stall.
const nextPaint = () => new Promise((resolve) => {
  const t = setTimeout(resolve, 50);
  requestAnimationFrame(() => { clearTimeout(t); setTimeout(resolve, 0); });
});

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
  // the attempts behind THIS renderer (makeRenderer empties app.attempts when
  // a recovery starts), and the info panel's renderer line follows the swap
  app.adoptedAttempts = app.attempts.slice();
  showInfo();
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
  showInfo(); // its renderer line must stop naming the dead renderer
}
async function recoverRenderer(why) {
  app.gpuLosses = (app.gpuLosses || 0) + 1; // the selftest reports it: a smoke run that recovered is not a normal load
  if (recovering) { lossPending = why; return; }
  if (recoveries >= 3) {
    giveUp(`GPU lost repeatedly (${why}); reload the page`);
    return;
  }
  recovering = true;
  recoveries++;
  setStatus('recovering', `GPU context lost (${why}); recovering`);
  showInfo(); // the renderer line says it is lost until a new one is adopted
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
    viewProj: multiply(proj, view), eye: eye4, light, up, clip: sectionPlane(), highlight: [...HIGHLIGHT, app.selected.size ? 1 : 0], background: BG,
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
  const aspect = box.clientWidth / Math.max(1, box.clientHeight);
  c.dist = fitDistance(s.radius, c.fov, aspect);
  // this fit is for the stage as it is NOW: the resize refit must measure
  // later aspect changes from here, or a layout change in the same task
  // (the parts drawer growing as a load fills the tree) is applied twice
  app.stageAspect = aspect;
  viewChanged();
}

const VIEWS = {
  iso: [0.7, 0.45], front: [0, 0], back: [Math.PI, 0], left: [-Math.PI / 2, 0],
  right: [Math.PI / 2, 0], top: [0, Math.PI / 2 - 1e-4], bottom: [0, -Math.PI / 2 + 1e-4],
};

function setView(v) {
  [app.cam.yaw, app.cam.pitch] = VIEWS[v];
  app.cam.q = quatFromView(app.cam.yaw, app.cam.pitch, app.cam.up);
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

// Visibility history: Hide, Isolate, Show all and a tree checkbox each save
// the hidden set first, and Undo (Ctrl/Cmd+Z) steps back through them. A new
// model starts a new history.
app.visUndo = [];
function rememberVisibility() {
  app.visUndo.push(new Set(app.hidden));
  if (app.visUndo.length > 100) app.visUndo.shift();
}
function undoVisibility() {
  if (!app.visUndo.length || !app.header) return;
  app.hidden = app.visUndo.pop();
  syncTreeChecks();
  pushState();
  showInfo();
  viewChanged();
  announce(`undone: ${app.hidden.size ? `${app.hidden.size} hidden` : 'everything shown'}`);
}

// Toolbar state: a button that would do nothing is disabled (Hide / Isolate
// with nothing selected, Show all with nothing hidden), the toggles show
// whether they are on, and the section slider says where the cut is.
function updateButtons() {
  const has = !!app.header;
  $('isolate').disabled = $('hide').disabled = !app.selected.size;
  $('showall').disabled = !app.hidden.size;
  $('undo').disabled = !app.visUndo.length;
  $('fit').disabled = !has;
  $('proj').setAttribute('aria-pressed', String(!!app.cam.ortho));
  $('up').setAttribute('aria-pressed', String(app.cam.up === 'z'));
  const on = app.section.axis !== 'off';
  $('secpos').disabled = !on;
  $('secflip').disabled = !on;
  $('secflip').setAttribute('aria-pressed', String(!!app.section.flip));
  const p = sectionPlane();
  const unit = !app.header ? '' : app.header.units === 'millimeter' ? 'mm' : app.header.units || '';
  $('secval').textContent = p ? `${app.section.axis.toUpperCase()} = ${(p[3] * (app.section.flip ? -1 : 1)).toFixed(1)} ${unit}` : '';
}

function pushState() {
  updateButtons();
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
// Show the model in colour scheme id (js/palettes.js) and remember the choice.
// Only the colours change: the drawn model becomes a copy of the converted
// one with the scheme's colours, uploaded as a load's model would be (and so
// re-uploaded the same way after a GPU loss). While a load is under way it
// only records the choice: that load draws in it.
function setPalette(id) {
  if (!PALETTES.some((p) => p.id === id)) return;
  app.palette = id;
  try { localStorage.setItem('cadv.palette', id); } catch { /* storage off */ }
  if (!app.baseMesh || app.wanted !== app.mesh) return;
  const before = app.mesh;
  const view = inScheme(app.baseMesh);
  if (view === before) return;
  app.mesh = view;
  app.wanted = view;
  gpuSync().then(() => {
    announce(`colours: ${PALETTES.find((p) => p.id === id).label}`);
  }, (e) => {
    // the GPU would not take it: keep showing the scheme it holds
    if (app.wanted !== view) return;
    app.mesh = before;
    app.wanted = before;
    setStatus('ready', `could not recolour: ${e.message || e}`);
  });
}

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
  app.baseMesh = null;
  app.header = null;
  app.wanted = null;
  app.sphere = { center: [0, 0, 0], radius: 1 };
  app.selected.clear();
  app.hidden.clear();
  app.visUndo = [];
  app.hover = 0;
  app.hoverSeq++;
  app.viewGen++;
  app.lastStepBuffer = null;
  $('export').disabled = true;
  $('tree').textContent = '';
  $('treefilter').hidden = true;
  updateButtons();
  $('hover').textContent = '';
  $('model').textContent = '';
  $('model').title = '';
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
  // Each step names itself (card and status line) and lets that paint first:
  // on a phone, inflate + decode + upload of a big model is a second or more
  // of a frozen page that would otherwise read as "stuck at 100%".
  const phase = async (what, detail) => {
    if (stale(seq)) return false; // a superseded load paints nothing over the newer one
    setStatus('loading', `${what} ${name}`);
    showProgress(`Opening ${name}`, null, detail);
    await nextPaint();
    return !stale(seq);
  };
  const t0 = performance.now();
  if (isGzip(buf) && !(await phase('unpacking', `unpacking ${mb(buf.byteLength)} MB`))) return;
  const raw = await inflateCadmesh(buf);
  if (stale(seq)) return;
  const inflateMs = performance.now() - t0;
  if (!(await phase('reading', `reading ${mb(raw.byteLength)} MB of geometry`))) return;
  const t1 = performance.now();
  const base = decodeCadmesh(raw);
  const mesh = inScheme(base);
  const decodeMs = performance.now() - t1;
  checkFits(app.renderer, mesh);
  if (stale(seq)) return; // a newer load owns app.wanted; never upload a stale model
  if (!(await phase('uploading', `uploading ${fmtInt(mesh.header.indexCount / 3)} triangles to the GPU`))) return;
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
  app.baseMesh = base;
  app.header = mesh.header;
  app.sphere = sphereOf(mesh.header.bbox);
  app.sourceName = name;
  app.lastStepBuffer = stepBuf;
  $('export').disabled = !stepBuf;
  app.selected.clear();
  app.hidden.clear();
  app.visUndo = [];
  app.hover = 0;
  app.hoverSeq++; // a hover answer computed against the old model must not apply
  app.viewGen++; // and neither may a click aimed at it
  $('hover').textContent = '';
  pushState();
  buildTree();
  setView('iso');
  const tris = mesh.header.indexCount / 3;
  app.stats = { meshes: mesh.header.meshes.length, triangles: tris, vertices: mesh.header.vertexCount,
    uploadMs: Math.round(performance.now() - t0), decodeMs: Math.round(decodeMs),
    inflateMs: Math.round(inflateMs), fileBytes: buf.byteLength, fetchMs: app.fetchMs ?? null };
  $('model').textContent = `${name} · ${mesh.header.meshes.length} bodies · ${fmtInt(tris)} triangles`;
  $('model').title = $('model').textContent; // the narrow footer truncates it
  showInfo();
  setStatus('ready', 'ready');
}

const STEP_EXT = { stp: 'step', step: 'step', igs: 'iges', iges: 'iges', brep: 'brep' };

// Keep a conversion in this browser, gzipped where the browser can (about a
// sixth of the raw size), then update the panel's line. Never throws.
async function saveConversion(key, raw, name) {
  try {
    const data = typeof CompressionStream === 'function' ? await deflateCadmesh(raw) : raw.slice(0);
    await cachePut(key, data, name);
  } catch { /* the cache is an optimisation */ }
  refreshCacheBar();
}

// The parts panel's "Saved conversions" line: how many, how much space, and
// a Clear button. Hidden when there are none (or no IndexedDB).
async function refreshCacheBar() {
  const list = await cacheList();
  const bytes = list.reduce((s, e) => s + e.size, 0);
  $('cachebar').hidden = !list.length;
  $('cacheinfo').textContent = `Saved conversions: ${list.length} · ${mb(bytes)} MB`;
  $('cacheinfo').title = list.map((e) => `${e.name} (${mb(e.size)} MB)`).join('\n');
}

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
    const format = STEP_EXT[ext];
    // A conversion of these exact bytes saved in this browser skips
    // OpenCascade (js/mesh-cache.js: everything stays on this device). The
    // key is hashed before the worker takes the buffer (posting detaches it).
    let key = null;
    if (cacheAvailable()) {
      setStatus('loading', `checking for a saved conversion of ${name}`);
      key = await cacheKey(buf, format, DEFAULT_TESSELLATION).catch(() => null);
      const hit = key && await cacheGet(key);
      if (stale(seq)) return;
      if (hit) {
        announce(`${name} was converted before: opening the copy saved in this browser`);
        await loadBuffer(hit, name, seq, hit);
        return;
      }
    }
    const out = await tessellate(buf, format, seq, name);
    if (stale(seq)) return;
    if (key) saveConversion(key, out, name); // in the background: the model shows meanwhile
    await loadBuffer(out, name, seq, out);
    return;
  }
  if (stale(seq)) return;
  // Not a STEP/IGES/BREP name: it must BE a .cadmesh (raw or gzipped), checked
  // by its first bytes -- a URL may have no extension at all. Anything else is
  // refused in plain words, not as a .cadmesh decode error ("bad magic").
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  const cadm = b.length === 4 && String.fromCharCode(...b) === 'CADM';
  if (!cadm && !isGzip(buf)) {
    throw new Error(`${name} is not a file this viewer opens${ext ? ` (.${ext})` : ''}: `
      + 'open a STEP (.stp, .step), IGES (.igs, .iges), BREP (.brep) or .cadmesh file');
  }
  await loadBuffer(buf, name, seq);
}

// The conversion runs in this tab, in one call; the card shows the step it is
// on, the time so far, and what to expect.
const TESS_HINT = 'The file is converted in this tab, on this device. A large assembly can take a minute or more. '
  + 'The result is kept in this browser, so opening the same file again is instant; Save .cadmesh keeps a copy.';

function tessellate(buf, format, seq, name) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./step-worker.js', import.meta.url));
    const t0 = performance.now();
    const bytes = buf.byteLength; // read now: posting buf to the worker detaches it (length 0)
    const size = mb(bytes);
    let stage = 'starting the converter';
    if (!stale(seq)) announce('converting'); // its ticks are progress, not news
    // The forecast from the file's contents (js/import-progress.js), until the
    // worker has counted them: from the size alone.
    let fc = forecast({ bytes, step: false });
    let tStart = 0; // when the conversion started (after the converter loaded)
    const fmt = (s) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`);
    // REAL progress from our converter build (occt-progress/): which step it
    // is on, and how far through it. The stock build sends none, and the
    // forecast alone stands in.
    let conv = null; // { phase, fraction, moved }
    let step = -1, stepAt = 0, readAt = 0, readSecs = 0, barMax = 0, overStep = -1;
    const STEPS = ['reading the file', 'building the parts', 'meshing', 'writing the result'];
    const show = () => {
      if (stale(seq)) return;
      const now = performance.now();
      const clock = fmt((now - t0) / 1000);
      let frac = null, detail = `${stage} · ${clock}`;
      if (!conv && tStart && forecastTotal(fc) > 3) {
        // the stock converter reports nothing: the forecast alone, never shown as done
        const run = (now - tStart) / 1000, tot = forecastTotal(fc);
        barMax = Math.max(barMax, Math.min(0.95, run / tot));
        frac = barMax;
        detail = `${run < tot ? `~${fmt(tot - run)} left (estimate)` : 'taking longer than expected'} · ${clock} so far`;
      } else if (conv) {
        // Time left for the WHOLE conversion: the forecast for the steps to
        // come, scaled by this device's speed (read off the first step), plus
        // the current step's, which leans toward the step's own pace as it
        // advances. When a step outlasts both, the card says so rather than
        // count down to a number that is wrong.
        const factor = deviceFactor(fc, readSecs);
        const st = step;
        const inStep = (now - stepAt) / 1000;
        const f = conv.fraction;
        const quiet = (now - conv.moved) / 1000;
        // once a step has said "longer than expected" it keeps saying so: a 1%
        // twitch after a long stall would otherwise bring back a short pace
        const left = overStep === st ? { over: true } : timeLeft(fc, factor, st, f, inStep, quiet);
        if (typeof left !== 'number') overStep = st;
        // the bar: the forecast's share of the conversion done, never moving back
        const total = forecastTotal(fc) * factor;
        const doneSecs = forecastDone(fc, factor, st, f, inStep);
        barMax = Math.max(barMax, Math.min(0.97, total > 0 ? doneSecs / total : 0));
        frac = barMax;
        const leftText = typeof left !== 'number' ? 'taking longer than expected'
          : left < 1 ? 'almost done' : `~${fmt(left)} left (estimate)`;
        const pct = (st === 1 || st === 2) && f < 1 ? ` · ${Math.round(f * 100)}%` : '';
        detail = `step ${Math.min(st + 1, 3)} of 3: ${STEPS[st]}${pct} · ${leftText} · ${clock} so far`;
      }
      setStatus('tessellating', conv
        ? `${STEPS[step]}${(step === 1 || step === 2) && conv.fraction < 1 ? ` ${Math.round(conv.fraction * 100)}%` : ''} · ${clock}`
        : `${stage} · ${clock}`);
      showProgress(`Converting ${name} (${size} MB)`, frac, detail, bytes > 2e6 ? TESS_HINT : '');
    };
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
      if (m.type === 'progress') {
        stage = m.stage;
        if (!tStart && m.converting) tStart = performance.now();
        show();
      }
      else if (m.type === 'features') {
        fc = forecast(m.features);
      }
      else if (m.type === 'occt') {
        const f = Math.min(1, Math.max(0, +m.fraction || 0));
        const t = performance.now();
        const p = Math.min(3, Math.max(1, m.phase | 0));
        const st = stepOf(p, f);
        if (st !== step) {
          stepAt = t;
          if (st === 0 && !readAt) readAt = t;
          if (st >= 1 && !readSecs && readAt) readSecs = (t - readAt) / 1000; // the device's speed
        }
        const same = conv && st === step;
        conv = { phase: p, fraction: f,
          moved: same && conv.fraction === f ? conv.moved : t }; // when the fraction last changed
        step = st;
        show();
      }
      else if (m.type === 'done') done(resolve, m.buffer);
      else done(reject, new Error(m.message));
    };
    w.onerror = (e) => done(reject, new Error(e.message || 'worker failed'));
    show();
    w.postMessage({ buffer: buf, format }, [buf]);
  });
}

// The file name a URL names -- what is shown, announced, offered by Save and
// read by extOf:
//   rack.cadmesh?v=2                        -> rack.cadmesh   (path part, query dropped)
//   /api/download?file=part.step&token=abc  -> part.step      (a query value naming a model file)
//   /api/download?id=7                      -> download       (no extension anywhere)
const MODEL_EXT = /\.(?:stp|step|igs|iges|brep|cadmesh)$/i;
const fileName = (url) => {
  const [path, query = ''] = url.split('#')[0].split('?');
  const tail = path.split('/').pop();
  if (/\.[a-z0-9]+$/i.test(tail)) return tail;
  for (const kv of query.split('&')) {
    let v = kv.slice(kv.indexOf('=') + 1);
    try { v = decodeURIComponent(v); } catch { /* keep it raw */ }
    v = v.split('/').pop();
    if (MODEL_EXT.test(v)) return v;
  }
  return tail;
};

async function loadUrl(url) {
  const seq = beginLoad();
  setStatus('loading', `fetching ${url}`);
  announce(`loading ${fileName(url)}`); // a new load is news even mid-load
  const tf = performance.now();
  app.fetchMs = null;
  const name = fileName(url);
  showProgress(`Downloading ${name}`, null, 'connecting…');
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`could not download ${name}: the server did not answer (${e.message || e})`);
  }
  if (stale(seq)) return;
  if (!res.ok) {
    throw new Error(res.status === 404 ? `file not found (404): ${name}`
      : `could not download ${name}: the server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  }
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
      const secs = (performance.now() - tf) / 1000;
      const rate = secs > 0.5 ? ` · ${mb(got / secs)} MB/s` : '';
      showProgress(`Downloading ${name}`, pct ? Math.min(1, got / total) : null,
        pct ? `${mb(got)} of ${mb(total)} MB${rate}` : `${mb(got)} MB${rate}`);
    }
    const all = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    buf = all.buffer;
  } else {
    buf = await res.arrayBuffer();
  }
  app.fetchMs = Math.round(performance.now() - tf);
  return loadAny(buf, name, seq);
}

async function loadFile(file) {
  const seq = beginLoad();
  app.fetchMs = null;
  setStatus('loading', `reading ${file.name}`);
  showProgress(`Opening ${file.name}`, null, `reading ${mb(file.size)} MB from disk`);
  announce(`loading ${file.name}`); // a new load is news even mid-load
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
  if (gaveUp) { setStatus('error', gaveUp); announce(`not loaded: ${gaveUp}`); return Promise.resolve(); }
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

// The name a tree node shows: its own, else its one body's, else "(unnamed)".
const nodeName = (n) => n.name
  || (n.meshes.length === 1 && !n.children.length ? app.header.meshes[n.meshes[0]].name : '') || '(unnamed)';

// Repeated names among siblings get a number ("L000", "L000 #2", …): a row
// that reads exactly like eleven others cannot be told apart.
function numberRepeats(names) {
  const total = new Map(), seen = new Map();
  for (const n of names) total.set(n, (total.get(n) || 0) + 1);
  return names.map((n) => {
    if (total.get(n) < 2) return n;
    const k = (seen.get(n) || 0) + 1;
    seen.set(n, k);
    return k === 1 ? n : `${n} #${k}`;
  });
}

function buildTree() {
  labelMeshes();
  const root = $('tree');
  root.textContent = '';
  app.rowOf = new Map(); // body id -> the most specific row holding only it (picks reveal it)
  // A node's own bodies get a row each when the node also has children or
  // several bodies: otherwise a pick of one of them has no row to show (the
  // rack's 19-body assembly node had none).
  const kidsOf = (node) => {
    const own = node.meshes.length && (node.children.length || node.meshes.length > 1)
      ? node.meshes.map((i) => ({ name: app.header.meshes[i].name || `body ${i + 1}`, meshes: [i], children: [] }))
      : [];
    return [...node.children, ...own].filter((c) => collect(c).length);
  };
  const mk = (node, depth, name) => {
    const ids = collect(node);
    if (!ids.length) return null;
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';
    row.style.paddingLeft = `${depth * 12 + 4}px`;
    const items = node.meshes.length === 1 && !node.children.length ? [] : kidsOf(node);
    const names = numberRepeats(items.map(nodeName));
    const kids = items.map((c, j) => mk(c, depth + 1, names[j])).filter(Boolean);
    if (ids.length === 1 && !app.rowOf.has(ids[0])) app.rowOf.set(ids[0], li); // the deepest wins
    const tw = document.createElement('span');
    tw.className = 'tw';
    tw.textContent = kids.length ? (depth < 2 ? '▾' : '▸') : '';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.tabIndex = -1; // the row is ONE tab stop (its name); Space on the name toggles this box
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = name;
    // the full name (the row truncates it) and the body count
    label.title = `${label.textContent} · ${ids.length} bod${ids.length === 1 ? 'y' : 'ies'}`;
    cb.setAttribute('aria-label', `Show ${label.textContent}`); // a screen reader names the part
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = ids.length > 1 ? ids.length : '';
    // the checkbox sits in a <label>, which on touch fills the row height, so a
    // tap anywhere in that column toggles it (a label click toggles its box)
    const cbw = document.createElement('label');
    cbw.className = 'cbwrap';
    cbw.append(cb);
    row.append(tw, cbw, label, cnt);
    li.append(row);
    li._ids = ids;
    li._cb = cb;
    if (kids.length) {
      const ul = document.createElement('ul');
      // one at a time: spreading a huge flat assembly into one call passes the
      // engine's argument limit (RangeError) after the UI has switched models
      for (const k of kids) ul.append(k);
      li.append(ul);
      // The twisty is the expand control for assistive tech (a button with
      // aria-expanded, out of the tab order); the name is the select button,
      // with → / ← as its keyboard shortcuts for the same expand/collapse.
      tw.setAttribute('role', 'button');
      tw.tabIndex = -1;
      const setOpen = (open) => {
        ul.hidden = !open;
        tw.textContent = open ? '▾' : '▸';
        tw.setAttribute('aria-expanded', String(open));
        tw.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${label.textContent}`);
      };
      // the top two levels start open -- but not a node whose rows are only its
      // own bodies (19 "COMPONENTn" rows would push every other part away);
      // a pick inside it opens it (revealRow)
      setOpen(depth < 2 && node.children.length > 0);
      tw.onclick = () => setOpen(ul.hidden);
      label._setOpen = setOpen;
      label.setAttribute('aria-keyshortcuts', 'ArrowRight ArrowLeft');
    } else {
      tw.setAttribute('aria-hidden', 'true'); // a leaf's empty twisty
    }
    // Keyboard: the whole tree is ONE tab stop (a roving tabindex: the row
    // last focused keeps it). ↑ / ↓ move between shown rows, Home / End jump,
    // Enter selects (ctrl/shift adds), Space shows / hides, → / ← expand / collapse.
    label.tabIndex = -1;
    label.setAttribute('role', 'button');
    label.setAttribute('aria-pressed', 'false'); // syncTreeChecks keeps it current
    label.onfocus = () => {
      for (const l of root.querySelectorAll('.label[tabindex="0"]')) if (l !== label) l.tabIndex = -1;
      label.tabIndex = 0;
    };
    label.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        select(ids, e.shiftKey || e.ctrlKey || e.metaKey, label.textContent);
      } else if (e.key === ' ') {
        e.preventDefault();
        cb.click();
      } else if (label._setOpen && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        label._setOpen(e.key === 'ArrowRight');
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        // the rows a user can see: not inside a collapsed or filtered-out branch
        const shown = [...root.querySelectorAll('.label')].filter((l) => !l.closest('[hidden]'));
        const i = shown.indexOf(label);
        const j = e.key === 'Home' ? 0 : e.key === 'End' ? shown.length - 1
          : Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        shown[j].focus();
        shown[j].scrollIntoView({ block: 'nearest' });
      }
    };
    cb.onchange = () => {
      rememberVisibility();
      for (const id of ids) (cb.checked ? app.hidden.delete(id) : app.hidden.add(id));
      syncTreeChecks();
      pushState();
      viewChanged();
    };
    label.onclick = (e) => select(ids, e.shiftKey || e.ctrlKey || e.metaKey, label.textContent);
    label.ondblclick = () => fitTo(bboxOf(ids));
    return li;
  };
  // an unnamed root with a single branch (a typical STEP wrapper) is skipped:
  // a "(unnamed)" row above everything says nothing
  let start = app.header.root;
  for (;;) {
    const k = kidsOf(start);
    if (start.name || start.meshes.length || k.length !== 1) break;
    start = k[0];
  }
  const top = mk(start, 0, nodeName(start));
  if (top) {
    root.append(top);
    top.querySelector('.label').tabIndex = 0; // the tree's one tab stop
  }
  $('treefilter').value = '';
  $('treefilter').hidden = !top;
}

// Show only the rows whose name contains q (case-insensitive), with their
// ancestors (expanded) and, under a matching row, all of its descendants.
function filterTree(q) {
  q = q.trim().toLowerCase();
  const walk = (li, force) => {
    const lab = li.querySelector(':scope > .row > .label');
    const hit = force || !q || lab.textContent.toLowerCase().includes(q);
    const ul = li.querySelector(':scope > ul');
    let any = false;
    if (ul) for (const c of ul.children) any = walk(c, hit && !!q) || any;
    li.hidden = !(hit || any);
    if (q && any && lab._setOpen) lab._setOpen(true);
    return hit || any;
  };
  const top = $('tree').firstElementChild;
  if (top) walk(top, false);
}

// Bring a body's row into view after a pick in the scene: expand its
// branch, clear a filter that hides it, and scroll the tree to it.
function revealRow(id) {
  const li = app.rowOf && app.rowOf.get(id);
  if (!li) return;
  if (li.closest('[hidden]') && $('treefilter').value) {
    $('treefilter').value = '';
    filterTree('');
  }
  for (let p = li.parentElement.closest('li'); p; p = p.parentElement.closest('li')) {
    const lab = p.querySelector(':scope > .row > .label');
    if (lab._setOpen) lab._setOpen(true);
  }
  li.querySelector('.row').scrollIntoView({ block: 'nearest' });
}

// One source of truth for every row: a node is checked while any body under it
// is visible (half-checked while only some are), and highlighted while every
// body under it is selected.
function syncTreeChecks() {
  document.querySelectorAll('#tree li').forEach((li) => {
    const shown = li._ids.filter((id) => !app.hidden.has(id)).length;
    li._cb.checked = shown > 0;
    li._cb.indeterminate = shown > 0 && shown < li._ids.length;
  });
  document.querySelectorAll('#tree .row').forEach((row) => {
    const li = row.parentElement;
    const sel = li._ids.length > 0 && li._ids.every((id) => app.selected.has(id));
    row.classList.toggle('sel', sel);
    // the name is a toggle-like button: a screen reader says whether it is selected
    row.querySelector('.label').setAttribute('aria-pressed', String(sel));
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

// name: the tree node's name when a tree row was chosen on its own, so the
// info panel can show it in full (the row truncates it); any other selection
// change forgets it.
function select(ids, additive, name = null) {
  const before = app.selected.size;
  if (!additive) app.selected.clear();
  for (const id of ids) app.selected.add(id);
  // an additive pick that added nothing leaves the selection, and its name, as they were
  if (!additive) app.selName = name;
  else if (app.selected.size !== before) app.selName = null;
  pushState();
  syncTreeChecks();
  showInfo();
}

function showInfo() {
  const el = $('info');
  el.innerHTML = '';
  const add = (k, v) => {
    const d = document.createElement('div');
    const a = document.createElement('b');
    a.textContent = k;
    d.append(a, ` ${v}`);
    el.append(d);
  };
  // the file, in full: the narrow footer truncates it, and its title tooltip
  // never shows on a touch screen
  if (app.header) add('file', `${app.sourceName} · ${fmtInt(app.header.meshes.length)} bodies`);
  // the backend, and why any faster one was skipped -- with or without a model
  // (it explains a slow first load too): the badge's tooltip says so as well,
  // but a tooltip never shows on a touch screen or to the keyboard
  // (in plain words: "graphics WebGL 2 -- WebGPU not available: no WebGPU adapter")
  const NAMES = { webgpu: 'WebGPU', webgl2: 'WebGL 2', webgl1: 'WebGL 1' };
  if (gaveUp) {
    add('graphics', `none -- ${gaveUp}`); // the adopted one is dead; never name it as in use
  } else if (app.backend) {
    const skipped = (app.adoptedAttempts || []).filter((a) => !a.ok)
      .map((a) => `${NAMES[a.backend] || a.backend} not available: ${a.error}`);
    const lost = app.status === 'recovering' ? ' (lost; recovering)' : '';
    add('graphics', `${NAMES[app.backend] || app.backend}${lost}${skipped.length ? ` -- ${skipped.join('; ')}` : ''}`);
  }
  if (!app.header) return;
  const ids = [...app.selected];
  const b = ids.length ? bboxOf(ids) : app.header.bbox;
  const dims = b ? [0, 1, 2].map((k) => (b.max[k] - b.min[k]).toFixed(1)).join(' × ') : '-';
  let title = 'whole model';
  // a tree row chosen on its own: its full name (the row truncates it)
  if (ids.length && app.selName) title = ids.length > 1 ? `${app.selName} · ${ids.length} bodies` : app.selName;
  else if (ids.length === 1) title = meshLabel(ids[0]);
  else if (ids.length > 1) title = `${ids.length} bodies`;
  const tris = (ids.length ? ids.map((id) => app.header.meshes[id - 1].idxCount) : [app.header.indexCount]).reduce((a, x) => a + x, 0) / 3;
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
  // clicks it. A second MOUSE/PEN pointer is ignored instead of hijacking the
  // first. A second FINGER turns a one-finger orbit into a pinch (zoom) +
  // two-finger pan; the orbit it interrupts is dropped (no click). A finger
  // left alone after a pinch does nothing until it is lifted (it has no
  // drag), so lifting one finger does not jerk the view into an orbit. Fingers
  // never take over a mouse or pen drag.
  let drag = null;
  const touches = new Map(); // pointerId -> [clientX, clientY], fingers on the stage
  let pinch = null; // { ids: [a, b] } while two fingers are down
  const startPinch = () => {
    pinch = touches.size >= 2 ? { ids: [...touches.keys()].slice(0, 2) } : null;
  };
  // A lifted finger leaves the pinch on pointerup itself, and again (a no-op)
  // on lostpointercapture / pointercancel, so the release never depends on
  // capture events alone. A pinch finger lifting with two others still down
  // (a third was resting): the remaining two pinch on, from their current
  // positions.
  const releaseTouch = (id) => {
    if (touches.delete(id) && pinch && pinch.ids.includes(id)) startPinch();
  };
  const endPointer = (e) => {
    if (drag && e.pointerId === drag.id) drag = null;
    releaseTouch(e.pointerId);
  };
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    // The cards (empty state, progress) sit inside the view: a press on them
    // is theirs. Capturing it for an orbit retargeted the click to the view,
    // so "Choose a file…" and Cancel never received it.
    if (e.target.closest('.card')) return;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      stage.setPointerCapture(e.pointerId);
      if (touches.size >= 2 && !pinch && (!drag || drag.type === 'touch')) {
        drag = null; // the orbit becomes a pinch
        startPinch();
        app.hoverSeq++;
        return;
      }
      if (touches.size > 1) return;
    }
    if (drag || pinch) {
      // a mouse or pen does not start a gesture mid-gesture; and the dblclick
      // the browser still fires for two such ignored clicks must not fit an
      // OLDER click's selection
      lastClick = Promise.resolve(false);
      return;
    }
    stage.setPointerCapture(e.pointerId);
    const pan = e.button === 1 || e.button === 2 || e.shiftKey;
    drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan, moved: false, id: e.pointerId, type: e.pointerType };
  });
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('lostpointercapture', endPointer);

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
    if (touches.has(e.pointerId)) {
      const prev = touches.get(e.pointerId);
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pinch.ids.includes(e.pointerId)) {
        const [ia, ib] = pinch.ids;
        const a0 = ia === e.pointerId ? prev : touches.get(ia);
        const b0 = ib === e.pointerId ? prev : touches.get(ib);
        const st = pinchStep(a0, b0, touches.get(ia), touches.get(ib));
        zoomBy(app.cam, st.scale, app.sphere.radius, app.stageAspect);
        panBy(app.cam, st.dx, st.dy, stage.clientHeight);
        viewChanged();
        return;
      }
      if (!drag) return; // a finger left over after a pinch, or a third one
    }
    if (!drag) {
      if (!app.mesh || e.pointerType === 'touch') return;
      hoverXY = devicePx(e);
      const wait = 60 - (performance.now() - hoverT);
      if (wait <= 0) hoverPick();
      else if (!hoverTimer) hoverTimer = setTimeout(hoverPick, wait);
      return;
    }
    if (e.pointerId !== drag.id) return;
    // A fingertip tap drifts 3-8 px: touch gets a 10 px slop, and until it is
    // passed the finger neither orbits nor stops being a tap.
    const slop = drag.type === 'touch' ? 10 : 3;
    if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > slop) drag.moved = true;
    if (!drag.moved) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    const c = app.cam;
    if (drag.pan) {
      panBy(c, dx, dy, stage.clientHeight);
    } else {
      orbitBy(c, dx, dy); // free about every axis: no pole clamp, upside down allowed
    }
    viewChanged();
  });
  stage.addEventListener('pointerup', (e) => {
    releaseTouch(e.pointerId);
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
        if (id) revealRow(id);
        // a finger has no hover: the view's name label shows what a tap picked
        if (d.type === 'touch') $('hover').textContent = id ? meshLabel(id) : '';
        return true;
      });
    }
    lastType = d.type;
    // Double-tap is detected here, not left to dblclick, which touch browsers
    // fire inconsistently (and not at all on some): two taps within 350 ms
    // and 30 px. It fits exactly like a double-click.
    if (d.type === 'touch' && !d.moved) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap = null;
        fitAfterClick();
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    }
  });
  // Fit only after this gesture's click pick has selected: a WebGPU pick is a
  // GPU round trip still in flight when dblclick fires, and fitting first
  // zoomed to the OLD selection (and its viewGen bump dropped both picks).
  let lastClick = Promise.resolve(false);
  let lastType = '';
  let lastTap = null;
  const fitAfterClick = () => lastClick.catch(() => false).then((clicked) => {
    if (clicked && app.selected.size) fitTo(bboxOf([...app.selected]));
  });
  stage.addEventListener('dblclick', (e) => {
    if (lastType === 'touch' || e.target.closest('.card')) return; // a double-tap / a card's own clicks
    fitAfterClick();
  });
  stage.addEventListener('wheel', (e) => {
    if (e.target.closest('.card')) return; // a card scrolls (a long error), the view stays put
    e.preventDefault();
    // per unit of deltaY: pixels (0), lines (1, ~3 per notch), pages (2, ~1 per notch)
    zoomBy(app.cam, Math.exp(e.deltaY * ([0.0015, 0.05, 0.15][e.deltaMode] ?? 0.0015)), app.sphere.radius, app.stageAspect);
    viewChanged();
  }, { passive: false });
  // The stage changes size with the window, a phone rotating, or the parts
  // drawer opening: redraw, and keep the same part of the scene framed when
  // the aspect changes (a narrow view is width-limited).
  app.stageAspect = stage.clientWidth / Math.max(1, stage.clientHeight);
  new ResizeObserver(() => {
    const a = stage.clientWidth / Math.max(1, stage.clientHeight);
    if (a > 0 && a !== app.stageAspect) {
      app.cam.dist = refitForAspect(app.cam.dist, app.cam.viewRadius, app.cam.fov, app.stageAspect, a);
      // the zoom limits scale with aspect by the same ratio as the refit, so
      // this clamp only catches float rounding: a dist inside the limits stays
      // inside them, and an aspect round trip returns it exactly
      zoomBy(app.cam, 1, app.sphere.radius, a);
      app.stageAspect = a;
      viewChanged();
    }
    queueFrame();
  }).observe(stage);
  window.addEventListener('resize', queueFrame); // devicePixelRatio changes (browser zoom) keep the CSS size
  $('panelbtn').onclick = () => setPanel(!panelOpen());
  $('scrim').addEventListener('pointerdown', (e) => { e.preventDefault(); setPanel(false); });
  // the Open… label is the file picker's only visible control: make it
  // reachable and operable from the keyboard
  const openLbl = $('open').parentElement;
  openLbl.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('open').click(); }
  };
  // A preset is an action, not a state: the dropdown goes back to "View" as
  // it is opened by mouse or touch (pointerdown) and when it loses focus, so
  // the same preset can be chosen again even though orbiting, pinching or the
  // wheel never take focus from it. It is NOT reset on change: arrow keys
  // fire change per press, and a reset there snapped every press back.
  $('viewsel').onchange = (e) => { if (e.target.value) setView(e.target.value); };
  $('viewsel').onblur = (e) => { e.target.value = ''; };
  $('viewsel').addEventListener('pointerdown', (e) => { e.target.value = ''; });
  // The narrow toolbar is one scrolling row: let a plain mouse wheel scroll it
  // sideways, and fade its right edge while more controls lie past it.
  // #tb is the scrolling row; the fade is an overlay on the header around it.
  const header = document.querySelector('header');
  const tb = $('tb');
  const moreHint = () => {
    header.classList.toggle('more-right', tb.scrollLeft + tb.clientWidth < tb.scrollWidth - 1);
    // the overlay stops above #tb's classic scrollbar (0 for overlay
    // scrollbars); a style on the HEADER, which the observer below (on #tb)
    // does not watch, so writing it cannot re-trigger moreHint
    header.style.setProperty('--sbh', `${Math.max(0, tb.offsetHeight - tb.clientHeight)}px`);
  };
  tb.addEventListener('wheel', (e) => {
    if (tb.scrollWidth <= tb.clientWidth || e.deltaX || !e.deltaY) return;
    e.preventDefault();
    tb.scrollLeft += e.deltaY * ([1, 16, tb.clientWidth][e.deltaMode] ?? 1);
  }, { passive: false });
  tb.addEventListener('scroll', moreHint);
  new ResizeObserver(moreHint).observe(tb);
  // contents can widen without the row resizing (Save appears once a STEP
  // import enables it, and hides again for a .cadmesh)
  new MutationObserver(moreHint).observe(tb, { attributes: true, subtree: true, childList: true, characterData: true });
  // A drop anywhere on the page loads the file: left to the browser, a drop on
  // the sidebar or header would open or download it and lose the view.
  window.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
  // dragleave also fires when the pointer moves onto a child (the cards):
  // only leaving the view itself ends the drag highlight
  stage.addEventListener('dragleave', (e) => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('drop'); });
  $('emptyopen').onclick = () => $('open').click();
  $('treefilter').addEventListener('input', (e) => filterTree(e.target.value));
  // Esc in the filter clears it (and stays in the field); a second Esc leaves
  $('treefilter').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ''; filterTree(''); }
  });
  // Cancel a running load: making it stale stops its fetch at the next chunk,
  // terminates a tessellation worker (beginLoad), and keeps any upload from
  // being shown. What was on screen before stays.
  $('pcancel').onclick = () => {
    beginLoad();
    announce('loading cancelled');
    if (app.mesh) setStatus('ready', 'ready');
    else setStatus('idle', IDLE_MSG);
  };
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
  // Ortho, Z up and Flip are on/off toggles: the label names the option, the
  // pressed look (and aria-pressed, for a screen reader) says whether it is on
  $('proj').onclick = () => { app.cam.ortho = !app.cam.ortho; updateButtons(); viewChanged(); };
  $('up').onclick = () => { app.cam.up = app.cam.up === 'y' ? 'z' : 'y'; updateButtons(); setView('iso'); };
  $('undo').onclick = undoVisibility;
  $('isolate').onclick = () => {
    if (!app.selected.size) return;
    rememberVisibility();
    app.hidden = new Set(app.header.meshes.map((_, i) => i + 1).filter((id) => !app.selected.has(id)));
    syncTreeChecks();
    pushState();
    viewChanged();
  };
  $('hide').onclick = () => {
    if (!app.selected.size) return;
    rememberVisibility();
    for (const id of app.selected) app.hidden.add(id);
    app.selected.clear();
    syncTreeChecks();
    pushState();
    showInfo();
    viewChanged();
  };
  $('showall').onclick = () => {
    if (!app.hidden.size) return;
    rememberVisibility();
    app.hidden.clear();
    syncTreeChecks();
    pushState();
    viewChanged();
  };
  $('secaxis').onchange = (e) => { app.section.axis = e.target.value; updateButtons(); viewChanged(); };
  $('secpos').oninput = (e) => { app.section.t = Number(e.target.value) / 1000; updateButtons(); viewChanged(); };
  $('secflip').onclick = () => { app.section.flip = !app.section.flip; updateButtons(); viewChanged(); };
  const pal = $('palette');
  for (const p of PALETTES) pal.add(new Option(p.label, p.id));
  pal.value = app.palette;
  pal.onchange = () => setPalette(pal.value);
  $('export').onclick = async () => {
    if (!app.lastStepBuffer) return;
    const name = app.sourceName;
    // gzipped (about a sixth of the raw size); a browser without
    // CompressionStream saves the raw layout, which loads the same. A model
    // opened from the browser's saved conversions is gzipped already.
    const buf = app.lastStepBuffer;
    const bytes = isGzip(buf) || typeof CompressionStream !== 'function' ? buf : await deflateCadmesh(buf);
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([bytes]));
    a.href = url;
    a.download = `${name.replace(/\.[^.]+$/, '')}.cadmesh`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  $('cacheclear').onclick = async () => {
    await cacheClear().catch(() => {});
    await refreshCacheBar();
    announce('saved conversions cleared');
  };
  window.addEventListener('keydown', (e) => {
    // leave browser shortcuts (Ctrl/Cmd/Alt+key) and typing in fields alone
    // ...except Ctrl/Cmd+Z, which undoes a visibility change (outside text fields)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
      const t0 = e.target;
      const field = (t0.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file', 'range'].includes(t0.type))
        || t0.tagName === 'TEXTAREA' || t0.isContentEditable;
      if (!field && app.visUndo.length) { e.preventDefault(); undoVisibility(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // only fields that take typed text swallow the letters; a focused tree
    // checkbox or button must not disable the shortcuts
    const t = e.target;
    // The View preset dropdown keeps focus after a pick (it is an action
    // menu, not a field): the shortcuts stay live there, and preventDefault
    // stops its type-ahead from turning f into Front and i into Iso.
    const typed = (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file', 'range'].includes(t.type))
      || (t.tagName === 'SELECT' && t.id !== 'viewsel') || t.tagName === 'TEXTAREA' || t.isContentEditable;
    if (typed) return;
    // Esc closes an open parts panel first (the narrow layout's slide-out);
    // the next Esc clears the selection
    const act = { f: () => $('fit').click(), Escape: () => (panelOpen() ? setPanel(false, true) : select([], false)), h: () => $('hide').click(),
      i: () => $('isolate').click(), a: () => $('showall').click() }[e.key];
    if (!act) return;
    if (t.id === 'viewsel') e.preventDefault();
    act();
  });
}

// ---------- boot ----------

async function main() {
  setStatus('init', 'starting GPU');
  $('export').disabled = true; // a browser may restore the last page's state
  updateButtons();
  // on a short window the controls help starts folded: the parts list needs the room
  if (innerHeight < 640) $('help').open = false;
  adoptRenderer(await makeRenderer());
  wireInput();
  queueFrame();
  refreshCacheBar();
  const src = params.get('src');
  if (src) await startLoad(() => loadUrl(src));
  else setStatus('idle', IDLE_MSG);
}

// ?selftest=1: after loading, pick the canvas centre and publish one JSON line
// in <pre id="selftest"> so a headless run can grade the backend
// (tests/browser-smoke.sh). Runs on success and on failure.
async function selftest() {
  const out = { status: app.status, backend: app.backend, attempts: app.attempts, error: app.error || null, gpuLosses: app.gpuLosses || 0 };
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
        wanted: fileName(want),
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
      // ?bench=N: orbit the camera one step per animation frame for N frames
      // (each step redraws the whole model) and report the frame intervals.
      // Frames run on the display's vsync, so a GPU that keeps up reads as the
      // refresh rate; a slower one shows as longer intervals.
      const n = Math.min(2000, Number(params.get('bench')) || 0);
      if (n > 0) {
        const f0 = app.frameCount;
        const ts = [];
        for (let i = 0; i < n; i++) {
          orbitBy(app.cam, -2.5, 0); // 0.02 rad a frame
          viewChanged();
          ts.push(await new Promise((r) => requestAnimationFrame(r)));
        }
        await new Promise((r) => requestAnimationFrame(r));
        const iv = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
        const q = (p) => +iv[Math.min(iv.length - 1, Math.floor(p * iv.length))].toFixed(2);
        const secs = (ts[ts.length - 1] - ts[0]) / 1000;
        out.bench = { steps: n, drawn: app.frameCount - f0, seconds: +secs.toFixed(2),
          fps: +((n - 1) / secs).toFixed(1), msP50: q(0.5), msP95: q(0.95), msMax: q(1 - 1e-9) };
      }
      // ?gpubench=N: N full redraws back to back in one task, then wait for the
      // GPU: ms per frame with no vsync cap, so it shows the headroom that
      // ?bench cannot (a GPU that keeps vsync always reads as the refresh rate).
      const g = Math.min(1000, Number(params.get('gpubench')) || 0);
      if (g > 0) {
        resize();
        app.renderer.render(frameState());
        await app.renderer.sync();
        const t0 = performance.now();
        for (let i = 0; i < g; i++) {
          orbitBy(app.cam, -2.5, 0);
          app.renderer.render(frameState());
        }
        await app.renderer.sync();
        const ms = performance.now() - t0;
        const c = app.renderer.canvas;
        out.gpubench = { frames: g, size: [c.width, c.height], msPerFrame: +(ms / g).toFixed(3),
          mtrisPerSec: +((app.stats.triangles * g) / ms / 1e3).toFixed(1) };
      }
    }
  } catch (e) {
    out.error = String(e.message || e);
  }
  const pre = document.createElement('pre');
  pre.id = 'selftest';
  pre.hidden = true;
  pre.textContent = `SELFTEST ${JSON.stringify(out)}`;
  document.body.append(pre);
  // ?report=1: also POST the line to the SAME origin (tests/report-server.py),
  // for a browser that cannot be driven over DevTools (iOS Simulator Safari)
  if (params.get('report')) {
    fetch('/__selftest', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: pre.textContent })
      .catch(() => {});
  }
}

guard(main()).then(() => { if (params.get('selftest')) return selftest(); });
