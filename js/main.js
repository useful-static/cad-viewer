// CAD viewer front end: backend selection (WebGPU -> WebGL2 -> WebGL1), loading
// (.cadmesh direct, .stp/.step/.igs/.brep through the OpenCascade worker),
// orbit camera, part tree, picking, section plane. Rendering is on demand.

import { DEFAULT_TESSELLATION, MAX_FILE_BYTES, decodeCadmesh, deflateCadmesh, gunzip, hashName, inflateCadmesh, isGzip } from './cadmesh.js';
import { cacheAvailable, cacheClear, cacheDelete, cacheGet, cacheKey, cacheList, cachePut } from './mesh-cache.js';
import { PALETTES, bodyColours, hexToRgb, rgbToHex, schemeColours } from './palettes.js';
import { fetchModelLists } from './model-list.js';
import { camDir, camUp, eyeOf, fitDistance, nearFar, orbitBy, panBy, pinchStep, qMul, quatFromView, refitForAspect, sphereOf, zoomBy } from './camera.js';
import { DEFAULT_ORIENT, Z_UP_ORIENT, orientOrNull, orientQuat, orientUp } from './orient.js';
import { deviceFactor, forecast, forecastDone, forecastTotal, stepOf, timeLeft } from './import-progress.js';
import { browserEnv, useThreads } from './converter-choice.js';
import { DISPLAY_UNITS, autoUnit, displayUnit, fmtNum } from './units.js';
import { bodyTable, edgeInstances, silhouetteInstances } from './edges.js';
import { decodeView, encodeView } from './view-link.js';
import { CUT_FILL, PAPER, PAPER_EDGES, STYLES, defaultStyle, rgb, styleById, styleFor, toggleEdges } from './styles.js';
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
  stopEdges: null, // { base, stop }: the running edge worker, stopped when its model is replaced
  listPending: null, // { url, seq }: a model of the model list being opened (listedNow)
  fetchAbort: null, // the running download's AbortController (beginLoad aborts it)
  wanted: null,
  selected: new Set(),
  hidden: new Set(),
  hover: 0,
  hoverSeq: 0,
  viewGen: 0,
  cam: { target: [0, 0, 0], dist: 1000, yaw: 0.7, pitch: 0.45, fov: Math.PI / 4, ortho: false, orient: DEFAULT_ORIENT, viewRadius: 500 },
  // the orientation chosen here (Z up), and the page's ?orient=: orientFor
  userOrient: DEFAULT_ORIENT,
  urlOrient: null,
  section: { axis: 'off', t: 0.5, flip: false, last: 'z' }, // last: the axis it turns on at
  frameQueued: false,
  frameCount: 0,
  // the colour scheme shown (js/palettes.js), remembered in this browser;
  // app.mesh is the model drawn in it, app.baseMesh the model as converted
  palette: (() => {
    let p = null;
    try { p = localStorage.getItem('cadv.palette'); } catch { /* storage off */ }
    return PALETTES.some((x) => x.id === p) ? p : 'file';
  })(),
  // the display unit chosen (js/units.js); only an explicit choice is
  // remembered, so 'auto' (the file's declared unit) is the absence of one
  unitChoice: (() => {
    let u = null;
    try { u = localStorage.getItem('cadv.units'); } catch { /* storage off */ }
    return DISPLAY_UNITS.includes(u) ? u : 'auto';
  })(),
  baseMesh: null,
  // the face boundaries drawn over the shaded faces (the display styles,
  // feature 7, will set this; on until then)
  showEdges: new URLSearchParams(location.search).get('edges') !== '0', // ?edges=0: off, for a control
  edgeMinPx: 6, // EDGE_MIN_BODY_PX; a test sets 0 to see the cull's control
  // the display style chosen in the select (js/styles.js), remembered in this
  // browser; null until a choice, when the file type's default applies
  // (?style=<id> picks one for this page only, for tests and screenshots)
  styleChoice: (() => {
    let s = new URLSearchParams(location.search).get('style');
    if (s) return s;
    try { s = localStorage.getItem('cadv.style'); } catch { /* storage off */ }
    return s;
  })(),
  isMeshFile: false, // a mesh format (feature 14): Shaded by default
  showSilhouettes: true, // the outline styles' silhouettes; a test turns them off for a control
  // colours picked for single parts of the loaded model: body index -> [r, g, b],
  // remembered in this browser under the model's key (modelKey)
  overrides: new Map(),
  modelKey: '',
};

// A model's key for its remembered part colours: its bodies' names and sizes,
// so the same model opened again (from STEP or from a saved .cadmesh) finds
// them, and a different one does not.
const modelKeyOf = (header) => `cadv.colours.${header.meshes.length}-${
  hashName(JSON.stringify(header.meshes.map((m) => [m.name, m.vtxCount, m.idxCount]))).toString(36)}`;

function loadOverrides(key, bodies) {
  const out = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    for (const [i, hex] of Object.entries(saved)) {
      const n = Number(i);
      if (Number.isInteger(n) && n >= 0 && n < bodies && /^#[0-9a-f]{6}$/i.test(hex)) out.set(n, hexToRgb(hex));
    }
  } catch { /* storage off or a damaged entry: no remembered colours */ }
  return out;
}

function saveOverrides() {
  if (!app.modelKey) return;
  try {
    if (!app.overrides.size) localStorage.removeItem(app.modelKey);
    else localStorage.setItem(app.modelKey, JSON.stringify(Object.fromEntries([...app.overrides].map(([i, c]) => [i, rgbToHex(c)]))));
  } catch { /* storage off or full: the colours last while the model is open */ }
}
window.__cadv = app;
app.redraw = () => viewChanged(); // for tests that change a display flag
app.refreshState = () => pushState(); // for tests that change a body's facts

// The model as drawn in the current colour scheme and part colours: the
// decoded model itself for the file's colours with nothing overridden, else a
// copy that differs only in its colours.
const inScheme = (base, overrides = app.overrides) => (app.palette === 'file' && overrides.size === 0
  ? base : { ...base, color: schemeColours(base, app.palette, overrides) });

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
  app.filterOpened = false; // (keepFilter sets it after: the slide-out it opened itself)
  document.body.classList.toggle('panel-open', open);
  $('panelbtn').setAttribute('aria-expanded', String(open));
  // closed from inside (Esc): focus would otherwise sit in a hidden panel
  if (!open && focusBack && $('parts').contains(document.activeElement)) $('panelbtn').focus();
}

// Where the keyboard enters the parts panel: the parts list's tab stop, or
// with no model (no tree) the panel's first control
const partsStop = () => [$('tree').querySelector('.label[tabindex="0"]'),
  ...$('parts').querySelectorAll('button, select, input, summary')].find((c) => c && !c.disabled && c.getClientRects().length);

// Filter parts while typing: a browser that shrinks the page for the
// on-screen keyboard took a tablet's window under 500 px tall, the sidebar
// became the closed slide-out, the field lost the focus (to ☰), the keyboard
// closed and the layout came back: nothing could be typed there (review r22).
// The slide-out opens around the field instead. (Every other way the slide-out
// closes moves the focus out of it first.) Returns whether it did.
// It closes again once the window is wide (refold): left open, the next
// narrow window (a tablet turned to portrait) showed it over the view, which
// the user had never opened (review r23).
function keepFilter(f) {
  if (f !== $('treefilter') || f.hidden || !narrowLayout() || document.body.classList.contains('panel-open')) return false;
  setPanel(true);
  app.filterOpened = true;
  f.focus();
  return true;
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
        // ?gl-without=instancing,float,vtf,uint: act as a WebGL GPU without
        // those (the fallbacks' tests; SwiftShader has them all)
        const without = (params.get('gl-without') || '').split(',').filter(Boolean);
        r = WebGLRenderer.create(canvas, name === 'webgl2' ? 2 : 1, { without });
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
        // its edges, when they are known already (a recolour, a recovery)
        await syncEdges(cur, want);
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

// The drawn mesh's edge instances onto renderer r. Built once per mesh (a
// recolour makes a new mesh, whose instances carry the new colours). Never
// throws: edges the GPU cannot hold are left out, and the model stays.
const edgeData = new WeakMap();
async function syncEdges(r, mesh) {
  const v = mesh.edgeInfo?.value;
  if (!r.canDrawEdges || !v || r.edgesFor === mesh) return;
  // the body table, for the cull of bodies too small to show edges. A table
  // the GPU will not hold costs the cull, never the model: no throw from here
  try {
    if (r.bodiesFor !== mesh) r.setBodies(mesh, bodyTable(mesh.header));
  } catch (e) {
    app.edgeError = String(e.message || e);
  }
  let data = edgeData.get(mesh);
  if (!data) {
    // the silhouettes too, so a change to an outline style needs no upload
    data = { edges: edgeInstances(mesh, v.edges),
      sil: v.silhouettes && v.silhouettes.length ? silhouetteInstances(mesh, v.silhouettes, v.silhouetteNormals) : null };
    edgeData.set(mesh, data);
  }
  try {
    await r.uploadEdges(mesh, data.edges, data.sil);
  } catch (e) {
    app.edgeError = String(e.message || e);
  }
}

// After the edge list arrives (the worker answers after the model is shown):
// upload it in the GPU queue's turn, so it never races a model upload.
function refreshEdges() {
  gpuChain = gpuChain.then(async () => {
    const r = app.renderer;
    if (r.drawn && r.drawn === app.mesh) await syncEdges(r, r.drawn);
    queueFrame();
  }).catch(() => {});
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

// Edge width in CSS px, and how much wider the hovered body's edges are
const EDGE_PX = 1.5;
const EDGE_HOVER_PX = 1;
// (app.edgeMinPx: a body under that projected radius, CSS px, draws no
// edges; they would only darken it)
const pxScale = (r) => (r.canvas.clientWidth ? r.canvas.width / r.canvas.clientWidth : 1);

// A style's part of the frame: the background, which faces pass, and the edge
// passes (each a depth test, a colour mode, a dash period, the paper colours)
const PAPER_RGB = rgb(PAPER);
const FILL_RGB = rgb(CUT_FILL);
const PAPER_COLS = (k) => ({ plain: rgb(PAPER_EDGES.plain[k]), selected: rgb(PAPER_EDGES.selected[k]), faded: rgb(PAPER_EDGES.faded[k]) });
const DASH_PX = 6; // the hidden edges: 3 px drawn, 3 px gap
function styleFrame(s, scale) {
  const visible = { depth: 'lequal', mode: 1, colours: PAPER_COLS(0) };
  const passes = {
    edges: [{ depth: 'lequal', mode: 0 }],
    hidden: [visible],
    // the hidden edges first, so a visible edge wins where they cross; only
    // the selected or hovered parts' (every part's is a grey thicket on a
    // dense model), so with nothing selected it reads as Hidden line
    hiddengrey: [{ depth: 'greater', mode: 1, dash: DASH_PX * scale, colours: PAPER_COLS(1), selectedOnly: true }, visible],
    wire: [{ ...visible, depth: 'always' }],
    xray: [{ depth: 'always', mode: 2 }],
  }[s.id] || null;
  return { background: s.paper ? PAPER_RGB : BG, style: { faces: s.faces, outline: s.outline && app.showSilhouettes }, edgePasses: passes,
    fill: s.faces === 'depth' ? FILL_RGB : null,
    // a body too small to draw edges is collapsed in the face and pick passes too
    cullFaces: !!s.paper };
}

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
  const up = orientUp(c.orient);
  // eye.w = 1: a point (perspective: view vector = eye - p); w = 0: the
  // direction to the viewer (ortho: one view vector for every pixel)
  const eye4 = c.ortho ? [d[0], d[1], d[2], 0] : [eye[0], eye[1], eye[2], 1];
  return {
    viewProj: multiply(proj, view), eye: eye4, light, up, clip: sectionPlane(), highlight: [...HIGHLIGHT, app.selected.size ? 1 : 0],
    ...styleFrame(currentStyle(), pxScale(r)),
    // the face boundaries over the shaded faces, in device px: the canvas's
    // own scale, not devicePixelRatio, which the canvas size caps
    edges: app.showEdges && currentStyle().edges ? { widthPx: EDGE_PX * pxScale(r), hoverPx: EDGE_HOVER_PX * pxScale(r), minPx: app.edgeMinPx * pxScale(r) } : null,
    // device px per model unit at w = 1: the projection's y scale times half
    // the height (a body's projected radius is radius * focalPx / w)
    focalPx: proj[5] * h / 2,
    hoverId: app.hover || 0,
    // the GPU holds a model the UI does not show (a superseded load mid-hand-
    // back): its ids do not match the state texture, so draw background only.
    // A colour copy of the shown model (a recolour still uploading: ~8 s for
    // the rack on WebGPU over SwiftShader) is the same geometry and ids, so
    // its old colours keep drawing meanwhile.
    drawModel: sameModel(r.drawn, app.mesh),
  };
}

// the same geometry (and so the same body ids): a model, or a colour copy of
// it (inScheme shares every array but the colours)
function sameModel(a, b) {
  return !!a && !!b && (a === b || (a.position === b.position && a.index === b.index));
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
  const h = Math.max(1, box.clientHeight);
  const aspect = box.clientWidth / h;
  // The options bar covers the bottom of the view: fit in the part above it
  // (a narrower vertical angle, the same width), and centre there by moving
  // the target down by half the bar, so the model sits above the bar.
  const bar = Math.min(optbarHeight(), h - 1);
  if (bar > 0) {
    const vis = h - bar;
    const fov = 2 * Math.atan(Math.tan(c.fov / 2) * vis / h);
    c.dist = fitDistance(s.radius, fov, box.clientWidth / vis);
    const perPx = (2 * c.dist * Math.tan(c.fov / 2)) / h; // world units per CSS px at the target
    const up = camUp(c);
    c.target = s.center.map((v, k) => v - up[k] * (bar / 2) * perPx);
  } else {
    c.dist = fitDistance(s.radius, c.fov, aspect);
  }
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

// Number-key views (Blender's numpad layout): 1 front, 3 right, 7 top,
// 0 iso, 5 Ortho on/off, 9 the opposite of the preset nearest the view.
const VIEW_KEYS = { 1: 'front', 3: 'right', 7: 'top', 0: 'iso', 5: 'ortho', 9: 'opposite' };
const OPPOSITE = { front: 'back', back: 'front', left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
const VIEW_NAMES = { iso: 'Iso', front: 'Front', back: 'Back', left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom' };

// the axis preset whose view direction is nearest the camera's (after a
// free orbit too)
function nearestPreset(cam) {
  const d = camDir(cam);
  let best = 'front', bestDot = -2;
  for (const v of Object.keys(OPPOSITE)) {
    const p = camDir({ q: presetQuat(VIEWS[v][0], VIEWS[v][1], cam.orient) });
    const dot = d[0] * p[0] + d[1] * p[1] + d[2] * p[2];
    if (dot > bestDot) { bestDot = dot; best = v; }
  }
  return best;
}

let viewNameTimer = null;
function viewKey(digit) {
  if (!app.header) return;
  const what = VIEW_KEYS[digit];
  let name;
  if (what === 'ortho') {
    $('proj').click();
    name = app.cam.ortho ? 'Orthographic' : 'Perspective';
  } else {
    const v = what === 'opposite' ? OPPOSITE[nearestPreset(app.cam)] : what;
    setView(v);
    name = VIEW_NAMES[v];
  }
  // name the result where the hovered part's name goes, so 9's is never a
  // guess; the next hover replaces it
  flashHover(name);
  announce(`${name} view`);
}

// A short note where the hovered part's name goes, for 1.5 s (or until the
// next hover replaces it)
function flashHover(text) {
  const hov = $('hover');
  hov.textContent = text;
  clearTimeout(viewNameTimer);
  viewNameTimer = setTimeout(() => { if (hov.textContent === text) hov.textContent = app.hover ? meshLabel(app.hover) : ''; }, 1500);
}

// ---------- view links (js/view-link.js) ----------

// the view as js/view-link.js encodes it
function currentView() {
  const c = app.cam;
  return {
    cam: { target: c.target, dist: c.dist, q: c.q || presetQuat(c.yaw, c.pitch, c.orient), ortho: !!c.ortho, orient: c.orient },
    // always the style shown, the default too: a link without one opens in
    // the recipient's remembered style, not the view that was shared
    style: currentStyle().id,
    section: app.section, hidden: [...app.hidden], selected: [...app.selected],
  };
}

// a decoded view onto the loaded model; ids past its bodies are dropped
function applyView(v) {
  if (!app.header) return;
  const n = app.header.meshes.length;
  const ids = (a) => (a || []).filter((i) => i >= 1 && i <= n);
  if (v.cam) {
    const c = app.cam;
    c.target = v.cam.target.slice();
    c.dist = v.cam.dist;
    c.q = v.cam.q.slice();
    c.ortho = v.cam.ortho;
    c.orient = v.cam.orient;
    // the radius this distance frames, the zoom's floor: a link zoomed onto
    // a small part kept the whole model's, and the first wheel notch in (or
    // a resize) jumped far out (review r16 M4)
    const box = $('stage');
    const aspect = box.clientWidth / Math.max(1, box.clientHeight);
    c.viewRadius = Math.min(app.sphere.radius, c.dist / fitDistance(1, c.fov, aspect));
  }
  if (v.style && styleById(v.style)) setStyle(v.style, false);
  // a link leaves out "section off" and "nothing hidden": a whole link (one
  // with a camera) means those where it names none, or a link pasted into a
  // tab keeps that tab's cut and hidden parts
  if (v.section) Object.assign(app.section, v.section, { last: v.section.axis });
  else if (v.cam) app.section.axis = 'off';
  if (v.hidden || v.cam) { app.hidden = new Set(ids(v.hidden)); syncTreeChecks(); }
  select(ids(v.selected), false);
  updateButtons();
  viewChanged();
}

// Copy a link to this model at this view. A model opened from this device has
// no URL: the link then holds the view alone, and the note says so.
async function shareView() {
  if (!app.header) return;
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  // the model lists too, in their order, so the link keeps the drop-down
  for (const l of params.getAll('list')) u.searchParams.append('list', l);
  if (app.sourceUrl) u.searchParams.set('src', app.sourceUrl);
  for (const k of ['backend']) if (params.get(k)) u.searchParams.set(k, params.get(k));
  u.hash = `view=${encodeView(currentView())}`;
  const link = u.toString();
  let copied = false;
  try {
    await navigator.clipboard.writeText(link);
    copied = true;
  } catch { /* no clipboard (not a secure context, or refused) */ }
  if (!copied) window.prompt('Copy this link to the view:', link);
  app.lastViewLink = link;
  const note = app.sourceUrl ? 'View link copied'
    : 'View link copied: it holds the view, not the file (opened from this device)';
  flashHover(note);
  announce(note);
}

// the styles built so far; the rest join the select as they are
const BUILT_STYLES = ['shaded', 'edges', 'hidden', 'hiddengrey', 'wire', 'xray'];
const currentStyle = () => {
  const id = styleFor(app.styleChoice, app.isMeshFile);
  return styleById(BUILT_STYLES.includes(id) ? id : defaultStyle(app.isMeshFile));
};

// remember: only a choice made in the select is kept (E is not)
function setStyle(id, remember) {
  if (!BUILT_STYLES.includes(id)) return;
  app.styleChoice = id;
  if (remember) {
    try { localStorage.setItem('cadv.style', id); } catch { /* storage off */ }
  }
  $('style').value = id;
  syncStyleBg();
  queueFrame();
}

// the paper styles' overlay palette (#hover, notices): dark on a light chip
function syncStyleBg() {
  if (currentStyle().paper) $('stage').dataset.bg = 'paper';
  else delete $('stage').dataset.bg;
}

// E: Shaded <-> Shaded + edges; elsewhere it says why nothing happened
function edgesKey() {
  const next = toggleEdges(currentStyle().id);
  if (!next) { flashHover('E switches edges in the Shaded styles'); return; }
  setStyle(next, false);
  const s = styleById(next);
  flashHover(s.label);
  announce(`${s.label} style`);
}

// A preset's camera orientation, taken in the model's orientation
// (js/orient.js): the preset in the viewer's own frame, turned into the file's
const presetQuat = (yaw, pitch, orient) => qMul(orientQuat(orient), quatFromView(yaw, pitch, 'y'));

function setView(v) {
  [app.cam.yaw, app.cam.pitch] = VIEWS[v];
  app.cam.q = presetQuat(app.cam.yaw, app.cam.pitch, app.cam.orient);
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

// ---------- toolbar menus ----------
// The view presets, the Save group, the rest of View and Show stand in the
// toolbar row where it has room for them and fold behind a menu button where
// it has not, in that order (FOLD_ORDER): the seven presets are the widest
// and the least needed in the row (the number keys reach four of them), so
// they go first, and the modes (Ortho, Z up, Section, Style) stay in view on
// a laptop-width window. The presets are a menu inside View: once View folds
// they are unfolded again, into its panel. Whether the row fits is MEASURED
// (one row on a wrapping desktop toolbar, no sideways scroll on the narrow
// one), so a width breakpoint cannot go stale as labels or fonts change.
// It is measured with
// Save .cadmesh counted as shown, so a load that enables it never refolds
// the row. The toolbar holds only modes and actions; a tool's own controls
// are in the options bar, so turning a tool on never refolds it either.
// In the narrow layout the Save group is File: Open… moves into it, and it
// is always folded.

const FOLD_ORDER = ['presetmenu', 'filemenu', 'viewmenu', 'showmenu'];
// what sits over the 3D view and takes its own pointer input
const OVER_VIEW = '.card, #optbar, #fullscreen';
const MENUS = FOLD_ORDER;

const narrowLayout = () => getComputedStyle($('tb')).flexWrap === 'nowrap';

// Open… stands in the row (wide), or is File's first item (narrow)
function placeOpen(narrow) {
  const lbl = $('open').parentElement;
  const menu = $('filemenu');
  const panel = $('filepanel');
  const btn = menu.querySelector('.menu-btn');
  // (a move takes the focus: given back where it lands, r20)
  const had = document.activeElement === lbl;
  if (narrow && lbl.parentElement !== panel) panel.prepend(lbl);
  else if (!narrow && lbl.parentElement === panel) menu.before(lbl);
  if (had && document.activeElement !== lbl) focusBeside(lbl);
  // a model list goes where Open… goes (moved only when it must: a move
  // takes the focus from it)
  if (lbl.nextElementSibling !== $('modellist')) lbl.after($('modellist'));
  // "File" at every width: it holds Copy view link too, which a menu named
  // Save hid on the desktop (live end-to-end review); refold sets the title
  btn.textContent = 'File';
  panel.setAttribute('aria-label', 'File');
}

// a folded menu with nothing it could do is disabled, like its items
function syncMenuButtons() {
  $('showmenu').querySelector('.menu-btn').disabled = ['isolate', 'hide', 'showall', 'undo'].every((id) => $(id).disabled);
  // (Copy view link is in it too: a model opened from a URL has nothing to
  // save, and its link is then the menu's one live item)
  $('filemenu').querySelector('.menu-btn').disabled = $('export').disabled && $('sharelink').disabled
    && !$('filepanel').contains($('open')) && ($('modellist').hidden || !$('filepanel').contains($('modellist')));
}

function toolbarFits(tb) {
  if (getComputedStyle(tb).flexWrap === 'nowrap') return tb.scrollWidth <= tb.clientWidth + 1;
  const cs = getComputedStyle(tb);
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  let row = 0;
  for (const el of tb.querySelectorAll('button, select, label.btn, input')) row = Math.max(row, el.offsetHeight);
  return tb.clientHeight <= row + pad + 2;
}

// keep: the control that had the focus before the resize closed a menu (the
// close may have moved it to the menu's button)
// what has the focus, or what had it until the layout hid it
const focusNow = () => (document.activeElement !== document.body ? document.activeElement : (app.lostFocus && app.lostFocus()) || document.body);

function refold(keep = focusNow()) {
  const tb = $('tb');
  const was = MENUS.map((id) => $(id).classList.contains('folded'));
  const narrow = narrowLayout();
  if (!narrow && app.filterOpened) setPanel(false); // the slide-out keepFilter opened
  placeOpen(narrow);
  for (const id of MENUS) $(id).classList.toggle('folded', narrow && id === 'filemenu');
  tb.classList.add('measuring');
  // the model list is a step of its own, after View and before Show: it
  // folds into File's panel (it stood outside every group, so the wide row
  // could not shed it: review r16 L3). On a page given a list the list is
  // how a visitor finds the other models, so View folds first: before View
  // it folded on a 1024 px tablet whose row had room for it once View had
  // (live end-to-end review). At 1280 px it fits beside a folded File.
  for (const id of [...FOLD_ORDER.slice(0, 3), 'modellist', ...FOLD_ORDER.slice(3)]) {
    if (toolbarFits(tb)) break;
    if (id === 'modellist') {
      if (!narrow && !$('modellist').hidden) $('filepanel').prepend($('modellist'));
      continue;
    }
    $(id).classList.add('folded');
  }
  // a folded View holds the presets as its panel's grid, not a menu in a menu
  if ($('viewmenu').classList.contains('folded')) $('presetmenu').classList.remove('folded');
  tb.classList.remove('measuring');
  MENUS.forEach((id, i) => { if (was[i] && !$(id).classList.contains('folded')) setMenu($(id), false); });
  // a Save menu holding the model list is the File menu
  // (its tooltip and panel name too: they still said "Save the converted model")
  {
    // the tooltip names what the panel holds
    const holds = [narrow ? 'open a file' : null,
      $('filepanel').contains($('modellist')) && !$('modellist').hidden ? 'open a model from the list' : null,
      'save the converted model', 'copy a link to this view'].filter(Boolean);
    const t = holds.join(', ').replace(/, ([^,]*)$/, ', or $1');
    $('filemenu').querySelector('.menu-btn').title = t[0].toUpperCase() + t.slice(1);
  }
  syncMenuButtons();
  refoldFocus(keep, narrow);
}

// A refold folds or unfolds what has the focus, and the focus watcher sees
// only disabled / hidden: Hide folded into a closed Show menu, the View button
// gone as View unfolds (a rotation with View open), a tree row in a sidebar
// that became the closed slide-out, all dropped the focus to the page; a menu
// a rotation unfolded left it on that menu's button, not on the item that was
// focused and now stands in the row (review r21). The model list too: the
// measuring moves it, and a move takes the focus.
// So: the control itself where it is still shown, else the folded menu's
// button (focusBeside), else ☰ for the parts panel.
function refoldFocus(keep, narrow) {
  if (!keep || keep === document.body || !keep.isConnected) return;
  const inParts = $('parts').contains(keep);
  if (!inParts && !$('tb').contains(keep)) return;
  if (keepFilter(keep)) return;
  // (a closing slide-out keeps visibility for its .22 s slide: hidden by layout)
  const shown = usable(keep) && !(inParts && narrow && !document.body.classList.contains('panel-open'));
  if (shown) { if (document.activeElement !== keep) keep.focus(); return; }
  const a = document.activeElement;
  if (a !== keep && a !== document.body && usable(a)) return; // already given a neighbour (a menu's button)
  if (inParts) { if (usable($('panelbtn'))) $('panelbtn').focus(); return; }
  focusBeside(keep);
}

function setMenu(menu, open, focusFirst = false) {
  const btn = menu.querySelector('.menu-btn');
  const panel = menu.querySelector('.menu-panel');
  if (open) {
    closeMenus(false, menu);
    menu.classList.add('open');
    // under the toolbar, at the button's left edge, kept on screen
    const r = btn.getBoundingClientRect();
    const top = document.querySelector('header').getBoundingClientRect().bottom + 4;
    panel.style.top = `${top}px`;
    panel.style.left = `${Math.max(8, Math.min(r.left, innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.maxHeight = `${innerHeight - top - 8}px`;
    panel.style.overflowY = 'auto';
    // the first item SHOWN: in a folded View the presets' own menu button
    // is there but not displayed, and focusing it did nothing
    if (focusFirst) [...panel.querySelectorAll('button:not(:disabled), select, label.btn')].find((e) => e.getClientRects().length)?.focus();
  } else {
    // closed with the focus inside (a resize or rotation refolds and closes
    // it; the focus watcher sees only disabled / hidden): its button, or the
    // focus fell to the page (review r20)
    const had = menu.querySelector('.menu-panel').contains(document.activeElement);
    menu.classList.remove('open');
    if (had && !usable(document.activeElement)) focusBeside(menu.querySelector('.menu-btn'));
  }
  btn.setAttribute('aria-expanded', String(open));
}

// Focus el, or where it cannot take the focus (disabled), the toolbar's next
// button that can, else the one before it. Buttons only: a select (Style)
// would take the letter shortcuts as type-ahead.
const usable = (e) => !e.disabled && e.isConnected && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
function focusBeside(el) {
  const live = usable;
  if (live(el)) { el.focus(); return; }
  // ☰ gone as the window widens: what it opened is the sidebar now, so its
  // list (the focus went to Open…, and a tree row → ☰ → row round trip of
  // resizes ended there: review r22)
  const ps = el === $('panelbtn') && !narrowLayout() && partsStop();
  if (ps) { ps.focus(); return; }
  // inside a folded menu's closed panel (Open… in the narrow File): its
  // menu's button, not the next button along (View, skipping File: r20).
  // A menu in a menu goes out to the first button shown: a view preset in a
  // View folded around its Views menu, whose button is not shown there, to
  // View's (the focus went on along the row to Show: r23)
  for (let m = el.closest('.menu-panel')?.closest('.menu'); m; m = m.parentElement.closest('.menu')) {
    const mb = m.querySelector(':scope > .menu-btn');
    if (live(mb)) { mb.focus(); return; }
  }
  const all = [...$('tb').querySelectorAll('button, label.btn')];
  const before = all.filter((e) => e.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  const after = all.filter((e) => e !== el && !before.includes(e));
  (after.find(live) || before.reverse().find(live))?.focus();
}

// The one net under all of them (review r19 L8): a focused control that
// disables itself or is hidden (a card's Cancel or "Choose a file…" when the
// card goes, a toolbar button its own action disables) drops the focus to the
// page, and the next Tab starts over. Fixing that control by control left one
// new case a round; this watches for it anywhere and gives the focus to the
// nearest usable toolbar control. Not after a pointer press: there the user
// put the focus where they meant to.
// The control watched is the one that HAS the focus: one the focus left for
// the page while still usable (a click on the footer or the view, a select
// blurred after a pick) is forgotten, and so is one a pointer press disabled.
// Remembered, a Hide clicked with the mouse took the focus long after, at the
// next button any key enabled or disabled (A, Esc): the focus ring jumped to
// Undo or Section, which the next Enter or Space pressed (review r20).
// In the parts panel the focus stays in the panel: a Reset (hidden once used)
// or a colour swatch Esc disabled sent it to the toolbar's Open…, a dozen Tabs
// from where the user was; the row of a tree a new model replaced, to the new
// tree's row (r20).
function focusInPanel(f, wasInTree) {
  const all = [...$('parts').querySelectorAll('button, summary, input[type=color], #tree .label[tabindex="0"]')];
  const row = $('tree').querySelector('.label[tabindex="0"]');
  if (!f.isConnected) return wasInTree && row && usable(row) ? (row.focus(), true) : false;
  const before = all.filter((e) => e.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING);
  const after = all.filter((e) => e !== f && !before.includes(e));
  const to = before.reverse().find(usable) || after.find(usable);
  if (to) to.focus();
  return !!to;
}

function keepFocus() {
  let last = null;
  let inTree = false;
  let pointerAt = -1e9;
  document.addEventListener('focusin', (e) => { last = e.target; inTree = $('tree').contains(last); });
  // (read a task later: a row whose tree is being replaced blurs while it is
  // still in the page)
  document.addEventListener('focusout', (e) => {
    const t = e.target;
    // (also forgotten when a pointer press just came: iOS runs a tap's blur
    // and click in one task, and with Reduce Motion the slide-out hid in it,
    // so the filter stayed remembered and a later rotation reopened the
    // slide-out around it: review r23)
    if (!e.relatedTarget) setTimeout(() => { if (t === last && document.activeElement !== t && (usable(t) || performance.now() - pointerAt < 600)) last = null; });
  });
  document.addEventListener('pointerdown', () => { pointerAt = performance.now(); }, true);
  // the control a layout change just hid while it had the focus (CSS hides
  // ☰ as the window widens, and the browser drops the focus to the page
  // before the resize is handled: review r22), for refold to put it back
  app.lostFocus = () => (document.activeElement === document.body && last && last.isConnected && !usable(last)
    && performance.now() - pointerAt > 600 ? last : null);
  const lost = () => {
    const f = last;
    if (!f || f === document.body) return;
    const a = document.activeElement;
    if (a && a !== document.body && a !== f) return; // the focus went on somewhere
    if (usable(f)) return;
    if (performance.now() - pointerAt < 600) { last = null; return; }
    // a row of a tree a load is replacing: wait for the new tree
    if (inTree && !f.isConnected && !$('progress').hidden) return;
    last = null;
    if (keepFilter(f)) return;
    if ((inTree || $('parts').contains(f)) && focusInPanel(f, inTree)) return;
    focusBeside($('tb').contains(f) ? f : $('open').parentElement);
  };
  new MutationObserver(lost).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'] });
}

// A resize or rotation that leaves the focused control outside the window
// scrolls it back into view: the help's summary at the foot of the open
// slide-out stayed below the window's edge after 390x844 -> 844x390 (r23).
// Only at a resize: a control the user scrolled away from stays where it is.
function showFocus() {
  const a = document.activeElement;
  if (!a || a === document.body || !a.getClientRects().length) return;
  const r = a.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Close every open menu (but `except`); returns whether one was open.
// refocus: give focus back to the closed menu's button (Esc from the keyboard)
function closeMenus(refocus = false, except = null) {
  let closed = false;
  for (const id of MENUS) {
    const m = $(id);
    if (m === except || !m.classList.contains('open')) continue;
    const inside = m.contains(document.activeElement);
    setMenu(m, false);
    if (refocus && inside) m.querySelector('.menu-btn').focus();
    closed = true;
  }
  return closed;
}

// presses that closed an open menu: the view's own handler skips their pick
const dismissPresses = new WeakSet();

function wireMenus() {
  for (const id of MENUS) {
    const m = $(id);
    const btn = m.querySelector('.menu-btn');
    // detail 0 = a keyboard press (Enter / Space): focus moves into the panel
    btn.onclick = (e) => setMenu(m, !m.classList.contains('open'), e.detail === 0);
    // an action (Open… included) closes its menu; a toggle (Ortho, Z up)
    // leaves it open to show its new state
    // A keyboard pick (Enter / Space: a click with no pointer, detail 0) made
    // inside the panel gives the focus to the menu's button: closing the panel
    // dropped it to the page, with no focus shown (review r18). Whether the
    // focus was in the menu is read before the item acts: Hide disables
    // itself, and the browser then moves the focus off it to the page.
    const panel = m.querySelector('.menu-panel');
    let focusIn = false;
    panel.addEventListener('click', () => { focusIn = m.contains(document.activeElement); }, true);
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('button, label.btn');
      if (!b) return;
      const back = e.detail === 0 && focusIn;
      // in the row: an item that disabled itself (Hide, Undo) gives the focus
      // to its neighbour, not to the page (review r19)
      if (!m.classList.contains('folded')) { if (back && b.disabled) focusBeside(b); return; }
      if (b.hasAttribute('aria-pressed')) return;
      setMenu(m, false);
      // a menu left with nothing to do is disabled (Undo, Show's last live
      // item): its neighbour then; the focus fell to the page and the next
      // Tab went to the full-screen button, past the toolbar (review r19)
      if (back) focusBeside(btn);
    });
    // Tab out of an open menu closes it
    m.addEventListener('focusout', (e) => { if (e.relatedTarget && !m.contains(e.relatedTarget)) setMenu(m, false); });
  }
  // A press outside closes an open menu, and that press is spent on it: on the
  // view it no longer also picks a part or clears the selection (review r22)
  document.addEventListener('pointerdown', (e) => {
    // (the event itself is marked: a time window could pass on a long layout, r23)
    if (!e.target.closest('.menu') && closeMenus() && $('stage').contains(e.target)) dismissPresses.add(e);
  }, true);
  $('tb').addEventListener('scroll', () => closeMenus());
  addEventListener('resize', () => { const f = focusNow(); closeMenus(); refold(f); showFocus(); });
  new ResizeObserver(() => refold()).observe(document.querySelector('header'));
  refold();
}

// ---------- options bar ----------
// Along the bottom of the 3D view, the controls of each tool that is on (one
// .opt row each). It is hidden while a card (empty state, loading) shows, and
// its height is published as --optbar-h, which lifts #hover above it and
// insets Fit.

function syncOptbar() {
  const bar = $('optbar');
  const card = !$('empty').hidden || !$('progress').hidden;
  bar.hidden = card || ![...bar.children].some((o) => !o.hidden);
  $('stage').style.setProperty('--optbar-h', `${optbarHeight()}px`);
  for (const o of bar.children) optFade(o);
}

const optbarHeight = () => ($('optbar').hidden ? 0 : $('optbar').offsetHeight);

// a row's right edge fades while more of it lies past the edge (as #tb's)
function optFade(o) {
  const row = o.firstElementChild;
  o.classList.toggle('more-right', !o.hidden && row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
  o.style.setProperty('--sbh', `${Math.max(0, row.offsetHeight - row.clientHeight)}px`);
}

// Section on (at the axis last used in this session, else Z) or off. Turned
// on, focus goes to its toggle in the options bar ("Section ×"); turned off
// from there, back to where it was turned on.
function setSection(axis, focus = false) {
  const was = app.section.axis;
  app.section.axis = axis;
  if (axis !== 'off') app.section.last = axis;
  updateButtons();
  viewChanged();
  if (!focus) return;
  if (axis !== 'off' && was === 'off') $('secoff').focus();
  else if (axis === 'off') ($('viewmenu').classList.contains('folded') ? $('viewmenu').querySelector('.menu-btn') : $('section')).focus();
}

// A select is blurred after a choice picked from its list, so a focused
// select does not swallow the number keys. Not after a choice TYPED into it:
// a closed select changes on each letter (type-ahead), and blurred there the
// next letter fell through to a shortcut ("hi" for Hidden line picked it,
// then I isolated the selection).
// A key that typed a letter, but not a Latin one (Cyrillic, Greek, …): the
// shortcuts then go by the key's place, as QWERTY names it
// (Latin by script, so "ğ" on Turkish F or "é" keeps its own place: r19)
const nonLatinLetter = (k) => k.length === 1 && /\p{L}/u.test(k) && !/\p{Script=Latin}/u.test(k);

// The inputs that take no typed text, so leave the shortcuts on (a focused
// colour swatch or slider is not a text field)
const NOT_TYPED = ['checkbox', 'radio', 'button', 'file', 'range', 'color'];

function blurAfterPick(sel) {
  let typing = false;
  sel.addEventListener('keydown', () => { typing = true; });
  for (const t of ['keyup', 'blur', 'pointerdown']) sel.addEventListener(t, () => { typing = false; });
  sel.addEventListener('change', () => { if (!typing) sel.blur(); });
}

// The model shown, by its name: the model list's name for it when it is one
// of the list's (a product name, as a shop's list gives it), else its file
// name; in the footer and the tab's title. The board was never named: the
// title was the viewer's and the footer the file's (live end-to-end review).
const BASE_TITLE = document.title;
const SHORT_TITLE = BASE_TITLE.split(' — ')[0]; // "CAD viewer"
function showModelName() {
  if (!app.header || !app.stats) return;
  const sel = $('modellist');
  const cur = app.sourceUrl ? listedNow() : null;
  const entry = cur && [...sel.options].find((o) => o.value && o.value === cur);
  const label = entry ? entry.textContent : app.sourceName;
  const s = app.stats;
  // (counted as the info panel counts: "1,391 bodies", and "1 body")
  $('model').textContent = `${label} · ${fmtInt(s.meshes)} ${s.meshes === 1 ? 'body' : 'bodies'} · ${fmtInt(s.triangles)} triangles`;
  $('model').title = entry ? `${$('model').textContent} (${app.sourceName})` : $('model').textContent; // the narrow footer truncates it
  document.title = `${label} — ${SHORT_TITLE}`;
}

// ---------- model lists (?list=, js/model-list.js) ----------
// The models a site offers, by name, in a drop-down beside Open…; picking
// one opens it as ?src= would (and puts it in ?src=, so a reload or a view
// link opens the same model).

function fillModelList(entries) {
  app.listEntries = entries;
  const sel = $('modellist');
  sel.textContent = '';
  for (const e of entries) sel.add(new Option(e.name, e.url));
  // shown while the model on screen is not one of the list's (a file opened
  // from the device): a blank select said nothing of what it was. Last, so
  // the models keep their indices; disabled and hidden, so it cannot be picked
  const none = new Option('Open from list…', '');
  none.disabled = true;
  none.hidden = true;
  sel.add(none);
  sel.hidden = entries.length === 0;
  syncModelList();
  refold();
  showModelName(); // a model shown before the list came is named from it now
  // and turned as its entry says, if the view is still the one it opened at
  // (the camera's orientation untouched: a pan or a zoom is not kept, an orbit,
  // a preset or a view link is)
  if (app.header && app.cam.q === app.loadQ && orientFor(app.sourceUrl) !== app.cam.orient) {
    app.cam.orient = orientFor(app.sourceUrl);
    updateButtons();
    setView('iso');
    app.loadQ = app.cam.q;
  }
}

// The orientation a model opens in (js/orient.js): its list entry's, else
// the page's ?orient= for a model opened from a URL, else the one chosen
// here (the Z up toggle; the file's own frame at first). A file opened from
// the device has no URL, so the page's ?orient= is not for it.
function orientFor(src) {
  let url = null;
  try { url = src ? new URL(src, location.href).href : null; } catch { /* no URL */ }
  const e = url && (app.listEntries || []).find((x) => x.url === url);
  return (e && e.orient) || (url && app.urlOrient) || app.userOrient;
}

// the drop-down names the model on screen: its entry, or "Open from list…"
// when the model shown is not in the list (a file opened from the device)
function syncModelList() {
  const sel = $('modellist');
  if (sel.hidden) return;
  const cur = listedNow();
  const i = [...sel.options].findIndex((o) => o.value && o.value === cur);
  sel.selectedIndex = i >= 0 ? i : sel.options.length - 1;
  // the whole name on hover, where the list's width cuts it
  sel.title = i >= 0 ? sel.options[i].textContent : 'Open another model from the list this page was given';
}

// The model the list stands for: the one being opened from a URL while a
// load runs (a pick, or the list's first), else the one on screen. Against
// the model on screen alone, a pick of it during another's download did
// nothing (and the pending one replaced it), and the list's first model
// showed as no entry while it opened (review r17)
// (pending: the list's own load, held from its start to its end and only
// while no newer load has begun; read from the status line, a GPU error or a
// recovery mid-download made it look settled: review r18)
function listedNow() {
  const p = app.listPending;
  const u = p && p.seq === app.loadSeq ? p.url : app.sourceUrl;
  try { return u ? new URL(u, location.href).href : null; } catch { return null; }
}

// Open a model of the list: the drop-down names it from the start
function loadListed(url) {
  const p = startLoad(() => loadUrl(url));
  const mine = { url, seq: app.loadSeq };
  app.listPending = mine;
  syncModelList();
  return p.finally(() => {
    if (app.listPending === mine) app.listPending = null;
    syncModelList();
  });
}

let listPick = 0;
// refocus: a keyboard pick made inside the narrow layout's File menu gives
// the focus to File's button as the menu closes (it fell to the page)
function openListed(url, refocus = false, keepMenu = false) {
  const before = location.href;
  const u = new URL(before);
  u.searchParams.set('src', url);
  u.hash = ''; // a view of the last model is not a view of this one
  history.replaceState(null, '', u);
  app.pendingView = null;
  if (!keepMenu) closeMenus(refocus); // the narrow layout's File menu: the pick is made
  const pick = ++listPick;
  loadListed(url).then(() => {
    // failed or cancelled, and no newer pick: the address and the drop-down
    // name the model still shown, so the pick can be made again
    if (pick !== listPick || app.sourceUrl === url) return;
    if (location.href === u.href) history.replaceState(null, '', before);
    syncModelList();
  });
}

// A pointer pick opens at once. A keyboard change does not: a closed select
// changes on each arrow, Home / End and type-ahead letter, and each would be
// a download (or a conversion). It opens on Enter, on leaving the list, or
// after a pause in the keys. Esc before then drops the choice (it opened the
// model anyway: the 1 s pause, or in the File menu the blur as Esc closed
// it). Enter gives the focus back like a pointer pick: left on the list,
// the next letter (F to fit) picked a model by type-ahead and opened it.
function wireModelList() {
  const ml = $('modellist');
  let typing = false;
  let timer = 0;
  // keepMenu: the focus moved on to another item of the open File menu (Tab
  // from the list there): the menu stays open and the focus where it went
  const go = (keyboard = false, keepMenu = false) => {
    clearTimeout(timer);
    timer = 0;
    if (ml.value && ml.value !== listedNow()) openListed(ml.value, keyboard && document.activeElement === ml, keepMenu);
  };
  ml.addEventListener('keydown', (e) => {
    typing = true;
    // (Esc then goes on to the window's keydown, which closes the File menu)
    if (e.key === 'Escape' && timer) { clearTimeout(timer); timer = 0; syncModelList(); }
    if (e.key === 'Enter' && timer) { e.preventDefault(); go(true); ml.blur(); }
    // Enter with nothing new chosen, in the File menu: done, the menu closes
    // with the focus on its button (it stayed open, the focus on the page: r19)
    else if (e.key === 'Enter' && ml.closest('.menu-panel')) { e.preventDefault(); closeMenus(true); }
  });
  for (const t of ['keyup', 'pointerdown']) ml.addEventListener(t, () => { typing = false; });
  ml.addEventListener('blur', (e) => {
    typing = false;
    if (timer) go(false, !!e.relatedTarget && ml.closest('.menu-panel')?.contains(e.relatedTarget));
  });
  ml.addEventListener('change', () => {
    if (!typing) { go(); ml.blur(); return; }
    clearTimeout(timer);
    // the pause opens the model and leaves the list as it is, in the File
    // menu as in the row: closing it there lost the reader's place (r19)
    timer = setTimeout(() => go(true, !!ml.closest('.menu-panel') && document.activeElement === ml), 1000);
  });
}

// a list that could not be read, said where it shows: its entries are missing
const listNote = (errors) => errors.map((e) => `model list ${e.url}: ${e.message}`).join('; ');

// ---------- full screen ----------
// The whole page, toolbar and parts panel included. The standard API, or
// WebKit's prefixed one (iPadOS before 16.4); the button is hidden where
// there is neither (iPhone). The browser takes Esc to leave full screen, so
// nothing the viewer does relies on Esc alone.

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const fsApi = () => !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);

function syncFullscreen() {
  const on = !!fsElement();
  const b = $('fullscreen');
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  b.title = on ? 'Exit full screen' : 'Full screen';
  queueFrame();
}

function wireFullscreen() {
  const b = $('fullscreen');
  b.hidden = !fsApi();
  if (b.hidden) return;
  b.onclick = () => {
    const el = document.documentElement;
    const p = fsElement()
      ? (document.exitFullscreen || document.webkitExitFullscreen).call(document)
      : (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    // refused (no user gesture, a policy): nothing changes, the button says so
    if (p && p.catch) p.catch(() => syncFullscreen());
  };
  document.addEventListener('fullscreenchange', syncFullscreen);
  document.addEventListener('webkitfullscreenchange', syncFullscreen);
  syncFullscreen();
}

function wireOptbar() {
  $('section').onclick = () => {
    closeMenus();
    setSection(app.section.axis === 'off' ? app.section.last : 'off', true);
  };
  $('secoff').onclick = () => setSection('off', true);
  for (const b of document.querySelectorAll('[data-axis]')) b.onclick = () => setSection(b.dataset.axis);
  for (const o of $('optbar').children) {
    const row = o.firstElementChild;
    row.addEventListener('scroll', () => optFade(o));
    // a plain mouse wheel scrolls the row sideways, as on #tb
    row.addEventListener('wheel', (e) => {
      if (row.scrollWidth <= row.clientWidth || e.deltaX || !e.deltaY) return;
      e.preventDefault();
      row.scrollLeft += e.deltaY * ([1, 16, row.clientWidth][e.deltaMode] ?? 1);
    }, { passive: false });
  }
  new ResizeObserver(syncOptbar).observe($('optbar'));
  // the cards come and go in setStatus; the bar follows them
  const cards = new MutationObserver(syncOptbar);
  for (const id of ['empty', 'progress']) cards.observe($(id), { attributes: true, attributeFilter: ['hidden'] });
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
  $('up').setAttribute('aria-pressed', String(app.cam.orient.startsWith('+z')));
  syncMenuButtons();
  const on = app.section.axis !== 'off';
  $('section').setAttribute('aria-pressed', String(on));
  $('secopt').hidden = !on;
  for (const b of document.querySelectorAll('[data-axis]')) b.setAttribute('aria-pressed', String(b.dataset.axis === app.section.axis));
  $('secpos').disabled = !on;
  // the slider follows the state (a view link sets it without the slider)
  const sv = String(Math.round(app.section.t * 1000));
  if ($('secpos').value !== sv) $('secpos').value = sv;
  $('secflip').disabled = !on;
  $('secflip').setAttribute('aria-pressed', String(!!app.section.flip));
  syncOptbar();
  const p = sectionPlane();
  $('secval').textContent = p ? `${app.section.axis.toUpperCase()} = ${lenNum(p[3] * (app.section.flip ? -1 : 1), 'section')} ${lenUnit()}` : '';
  // a screen reader speaks the cut position, not the slider's 0-1000 step
  if (p) $('secpos').setAttribute('aria-valuetext', $('secval').textContent);
  else $('secpos').removeAttribute('aria-valuetext');
  // the part colour: on with a selection, showing the first selected body's
  // colour; Reset only while a selected body has a picked colour
  const sel = app.header ? [...app.selected] : [];
  $('partcolour').disabled = !sel.length;
  if (sel.length) $('partcolour').value = rgbToHex(partColourOf(sel[0]));
  const all = !sel.length;
  $('partreset').disabled = all ? !app.overrides.size : !sel.some((id) => app.overrides.has(id - 1));
  $('partreset').hidden = $('partreset').disabled; // shown only when there is something to reset
  $('partreset').textContent = all ? 'Reset all' : 'Reset';
  $('partreset').title = all ? 'Give every recoloured part its scheme colour again'
    : 'Give the selected parts their scheme colour again';
}

function pushState() {
  updateButtons();
  if (!app.header || !app.renderer) return;
  const H = stateHeight(app.header.meshes.length);
  const bytes = new Uint8Array(STATE_W * H * 4);
  for (const id of app.selected) bytes[id * 4] = 255;
  for (const id of app.hidden) bytes[id * 4 + 1] = 255;
  if (app.hover) bytes[app.hover * 4 + 2] = 255;
  // a: the body is closed (the facts), for the cut fill in the paper styles
  const closed = app.baseMesh?.edgeInfo?.value?.facts?.closed;
  if (closed) closed.forEach((c, i) => { if (c) bytes[(i + 1) * 4 + 3] = 255; });
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
  // and a superseded download: one whose server never answers otherwise
  // kept its load (and a model-list pick of it) waiting for ever (review r19)
  if (app.fetchAbort) { app.fetchAbort.abort(); app.fetchAbort = null; }
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
  recolour(`colours: ${PALETTES.find((p) => p.id === id).label}`);
}

// Draw the loaded model in the current scheme and part colours. Returns the
// GPU sync's promise (resolved at once when nothing changes or a load is under
// way); on a failure the drawn colours stay as they were.
function recolour(announcement) {
  if (!app.baseMesh || app.wanted !== app.mesh) return Promise.resolve();
  const before = app.mesh;
  const view = inScheme(app.baseMesh);
  if (view === before) return Promise.resolve();
  app.mesh = view;
  app.wanted = view;
  return gpuSync().then(() => {
    if (announcement) announce(announcement);
  }, (e) => {
    // the GPU would not take it: keep showing the colours it holds
    if (app.wanted !== view) return;
    app.mesh = before;
    app.wanted = before;
    setStatus('ready', `could not recolour: ${e.message || e}`);
  });
}

// The colour of the selected parts: pick one (every selected body takes it),
// or reset them to the scheme's colours. Kept for this model while it is open.
function setPartColour(hex) {
  if (!app.selected.size) return;
  const c = hexToRgb(hex);
  for (const id of app.selected) app.overrides.set(id - 1, c);
  saveOverrides();
  updateButtons();
  recolour(`${app.selected.size} part${app.selected.size > 1 ? 's' : ''} recoloured`);
}

// Reset: the selected parts' picked colours, or with nothing selected every
// picked colour of this model; the parts take the scheme's colours again
function resetPartColour() {
  let n = 0;
  if (app.selected.size) {
    for (const id of app.selected) if (app.overrides.delete(id - 1)) n++;
  } else {
    n = app.overrides.size;
    app.overrides.clear();
  }
  saveOverrides();
  updateButtons();
  if (n) recolour(`${n} part colour${n > 1 ? 's' : ''} reset`);
}

// What the picker shows: the first selected body's colour as drawn
function partColourOf(id) {
  if (app.overrides.has(id - 1)) return app.overrides.get(id - 1);
  const per = bodyColours(app.header, app.palette);
  if (per) return per[id - 1];
  const m = app.header.meshes[id - 1];
  if (m.color) return m.color;
  const c = app.baseMesh.color, v = 4 * m.vtxStart;
  return [c[v] / 255, c[v + 1] / 255, c[v + 2] / 255];
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
  app.overrides = new Map();
  app.modelKey = '';
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
  app.unmeshedFaces = 0;
  // and what loadBuffer set for it: no link to a model not shown, no edge
  // worker running on for it
  if (app.stopEdges) { app.stopEdges.stop(); app.stopEdges = null; }
  app.sourceUrl = null;
  app.stats = null;
  syncModelList();
  $('sharelink').disabled = true;
  syncMenuButtons();
  $('export').disabled = true;
  $('tree').textContent = '';
  $('treefilter').hidden = true;
  updateButtons();
  $('hover').textContent = '';
  $('model').textContent = '';
  document.title = BASE_TITLE;
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
// conversion (a conversion only): { unmeshedFaces, threads } -- the faces the
// converter returned without triangles, shown in the status line and the info
// panel, and whether it ran on the multi-core converter.
async function loadBuffer(buf, name, seq, stepBuf = null, conversion = null) {
  const unmeshedFaces = conversion?.unmeshedFaces || 0;
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
  // a file with no surfaces (a STEP or IGES of curves or points only) is
  // refused in plain words, the model on screen kept: it opened "ready" with
  // 0 bodies, an empty tree and a blank view (review r22)
  if (!base.header.indexCount) {
    // (faces the converter could not mesh are not "no faces": r23)
    const unmeshed = conversion && conversion.unmeshedFaces;
    throw new Error(unmeshed
      ? `none of the ${fmtInt(unmeshed)} faces of ${name} could be meshed: the converter failed on them, or this device ran out of memory`
      : `${name} has no surfaces to show: it holds no faces (only curves or points, or nothing). Export the solids or surfaces from the CAD program`);
  }
  // one holder, shared by every palette copy made from base (they spread it)
  base.edgeInfo = { value: null, ready: null };
  // part colours belong to the model they were picked on: this model's own
  const key = modelKeyOf(base.header);
  const overrides = loadOverrides(key, base.header.meshes.length);
  const mesh = inScheme(base, overrides);
  const scheme = app.palette; // a scheme picked during the upload is drawn after it
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
  // the edge worker of the model this one replaces has no one to answer
  if (app.stopEdges && app.stopEdges.base !== base) app.stopEdges.stop();
  app.mesh = mesh;
  app.baseMesh = base;
  app.overrides = overrides;
  app.modelKey = key;
  app.header = mesh.header;
  app.sphere = sphereOf(mesh.header.bbox);
  app.sourceName = name;
  // the URL it came from, for a view link (null: a local file, which a link cannot carry)
  app.sourceUrl = app.urlOfLoad && app.urlOfLoad.seq === seq ? app.urlOfLoad.url : null;
  // a model from the device is not the ?src a list pick left in the address:
  // a reload would open that instead (review r16 L7)
  if (!app.sourceUrl && new URLSearchParams(location.search).has('src')) {
    const u = new URL(location.href);
    u.searchParams.delete('src');
    history.replaceState(null, '', u);
  }
  app.lastStepBuffer = stepBuf;
  app.unmeshedFaces = unmeshedFaces;
  $('export').disabled = !stepBuf;
  $('sharelink').disabled = false;
  syncModelList();
  syncMenuButtons(); // a folded Save menu now has something in it
  app.selected.clear();
  app.hidden.clear();
  app.visUndo = [];
  app.hover = 0;
  app.hoverSeq++; // a hover answer computed against the old model must not apply
  app.viewGen++; // and neither may a click aimed at it
  $('hover').textContent = '';
  pushState();
  buildTree();
  app.cam.orient = orientFor(app.sourceUrl);
  setView('iso');
  app.loadQ = app.cam.q; // the view it opened at (fillModelList)
  // (recolour refuses while an upload is under way, so the pick waited here)
  if (app.palette !== scheme) recolour();
  // a view link (#view=…) applies to the model the page opened with; a link
  // with no ?src (its model was opened from a device) to the next one opened
  // from a device, never to a model list's first (review r16 M2)
  if (app.pendingView && (app.pendingView.src ? app.sourceUrl === app.pendingView.src : !app.sourceUrl)) {
    applyView(app.pendingView.view);
    app.pendingView = null;
  }
  const tris = mesh.header.indexCount / 3;
  app.stats = { meshes: mesh.header.meshes.length, triangles: tris, vertices: mesh.header.vertexCount,
    uploadMs: Math.round(performance.now() - t0), decodeMs: Math.round(decodeMs),
    inflateMs: Math.round(inflateMs), fileBytes: buf.byteLength, fetchMs: app.fetchMs ?? null, unmeshedFaces,
    converter: conversion ? (conversion.threads ? 'multi-core' : 'one thread') : null };
  showModelName();
  showInfo();
  setStatus('ready', readyText()); // announced with the change into ready
  // the facts' closed flags go into the state texture too (the cut fill)
  base.edgeInfo.ready = edgesOf(base).then((v) => { if (app.baseMesh === base) pushState(); refreshEdges(); return v; });
}

// Past this many silhouette candidates a coarse-pointer device (a phone,
// a tablet) leaves them out; js/edges.js's SILHOUETTE_CAP elsewhere
const COARSE_SILHOUETTE_CAP = 500_000;
const coarseOnly = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;

// The edge list and body facts of a loaded model: from the file when it
// carries them, else built by a worker from copies of its arrays. Resolves
// to base.edgeInfo.value ({ edges, silhouettes, silhouetteNormals,
// silhouettesOmitted, facts, source, ms }), or null when the build failed.
function edgesOf(base) {
  const info = base.edgeInfo;
  const cap = coarseOnly() ? COARSE_SILHOUETTE_CAP : 0;
  if (base.edges && base.header.facts) {
    const over = cap && base.silhouettes && base.silhouettes.length / 2 > cap;
    info.value = { edges: base.edges, silhouettes: over ? null : base.silhouettes,
      silhouetteNormals: over ? null : base.silhouetteNormals,
      silhouettesOmitted: over ? base.silhouettes.length / 2 : (base.header.silhouettesOmitted || 0),
      facts: base.header.facts, source: 'file', ms: 0 };
    return Promise.resolve(info.value);
  }
  return new Promise((resolve) => {
    let w;
    try {
      w = new Worker(new URL('./edges-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      info.error = `no module worker: ${e.message || e}`;
      resolve(null); // no edges, which nothing needs yet
      return;
    }
    let finished = false;
    const done = (v) => {
      if (finished) return;
      finished = true;
      w.terminate();
      info.value = v;
      if (app.stopEdges && app.stopEdges.base === base) app.stopEdges = null;
      // said where it shows, or the edge styles silently draw none
      if (!v && info.error && app.baseMesh === base && app.status === 'ready') setStatus('ready', `no edges for this model: ${info.error}`);
      resolve(v);
    };
    // stopped when another model replaces this one on screen (loadBuffer):
    // its worker and its copies of the arrays would otherwise run on
    app.stopEdges = { base, stop: () => { info.error = 'stopped: another model was opened'; done(null); } };
    w.onmessage = (ev) => {
      if (!ev.data.ok) info.error = ev.data.error;
      done(ev.data.ok ? { ...ev.data.result, source: 'worker', ms: Math.round(ev.data.ms) } : null);
    };
    w.onerror = (e) => { info.error = `worker failed: ${e.message || 'could not start'}`; done(null); };
    // copies: the model's own buffers stay with the page and the GPU upload
    const position = base.position.slice();
    const index = base.index.slice();
    w.postMessage({ position, index, meshes: base.header.meshes, silhouetteCap: cap || undefined },
      [position.buffer, index.buffer]);
  });
}

// "ready", or with faces the conversion could not mesh, what is missing
const readyText = () => (app.unmeshedFaces
  ? `ready · ${fmtInt(app.unmeshedFaces)} face${app.unmeshedFaces > 1 ? 's' : ''} could not be meshed and ${app.unmeshedFaces > 1 ? 'are' : 'is'} missing`
  : 'ready') + (app.listNote ? ` · ${app.listNote}` : '');

const STEP_EXT = { stp: 'step', step: 'step', igs: 'iges', iges: 'iges', brep: 'brep' };

// The CAD format a file's first bytes say ('stp', 'igs', 'brep'), or null: a
// STEP file opens "ISO-10303-21;", a BREP "DBRep_DrawableShape", and an IGES
// file's first line is an 80-column record with "S" in column 73
function sniffCad(buf) {
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(200, buf.byteLength)));
  // (a UTF-8 byte-order mark first is read as Latin-1 "ï»¿": skipped, r20)
  const text = head.replace(/^ï»¿/, '');
  if (/^\s*ISO-10303-21\s*;/.test(text)) return 'stp';
  if (/^\s*DBRep_DrawableShape/.test(text)) return 'brep';
  const line = text.split(/\r?\n/)[0];
  if (line.length >= 73 && line[72] === 'S') return 'igs';
  return null;
}

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

// One gzip layer unpacked, with its step on the progress card (loadAny's
// three paths each had their own, and one showed none: review r22). null:
// a newer load took over meanwhile.
async function unpackGz(buf, name, seq) {
  setStatus('loading', `unpacking ${name}`);
  showProgress(`Opening ${name}`, null, `unpacking ${mb(buf.byteLength)} MB`);
  await nextPaint();
  if (stale(seq)) return null;
  const out = await gunzip(buf);
  return stale(seq) ? null : out;
}

async function loadAny(buf, name, seq) {
  // a load superseded while it was reading/fetching must not start a worker
  // (it would also take over app.cancelTess from the newer load)
  if (stale(seq)) return;
  // A compressed STEP / IGES / BREP (part.stp.gz, about a fifth of the size
  // to download): unpacked here, then opened as the file inside it
  // (served with Content-Encoding: gzip, fetch has unpacked it already)
  const inner = name.replace(/\.gz$/i, '');
  if (inner !== name && STEP_EXT[extOf(inner)]) {
    if (isGzip(buf) && !(buf = await unpackGz(buf, name, seq))) return;
    name = inner;
  }
  // A name that says nothing (a URL with no extension) opened by what the
  // bytes are: a STEP, IGES or BREP file starts in a way of its own; gzipped,
  // it is unpacked first (review r19)
  // (x.gz with nothing inside its name counts as saying nothing too, r20)
  const said = extOf(name.replace(/\.gz$/i, ''));
  if (!STEP_EXT[said] && said !== 'cadmesh' && !(/\.gz$/i.test(name) && said)) {
    let body = buf;
    if (isGzip(buf) && !(body = await unpackGz(buf, name, seq))) return;
    const kind = sniffCad(body);
    const base = name.replace(/\.gz$/i, '');
    // (the name changes only for what it turned out to be: an unknown x.gz
    // is refused as "x.gz", not "x", r21)
    if (kind) name = `${base}.${kind}`;
    // unpacked once, whatever it is: a .cadmesh opens raw, anything else is
    // refused below in plain words (it was inflated a second time first)
    buf = body;
  }
  const ext = extOf(name);
  if (STEP_EXT[ext]) {
    const format = STEP_EXT[ext];
    // a gzip under a plain .stp name (it reached the converter compressed)
    // is unpacked; a UTF-8 byte-order mark first is dropped: OpenCascade
    // refuses it ("unexpected QUID, expecting STEP"), as stp2mesh does (r21)
    if (isGzip(buf) && !(buf = await unpackGz(buf, name, seq))) return;
    const b3 = new Uint8Array(buf, 0, Math.min(3, buf.byteLength));
    if (b3[0] === 0xef && b3[1] === 0xbb && b3[2] === 0xbf) buf = buf.slice(3);
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
        try {
          await loadBuffer(hit, name, seq, hit);
          return;
        } catch (e) {
          // a saved copy that no longer decodes is dropped and the file
          // converted again; it failed on every open until Clear (r17)
          if (!/^cadmesh:/.test(e.message || '')) throw e;
          if (stale(seq)) return;
          await cacheDelete(key);
          announce(`the saved copy of ${name} could not be read: converting it again`);
        }
      }
    }
    const conversion = await convert(buf, format, seq, name);
    if (stale(seq)) return;
    const out = conversion.buffer;
    // an incomplete conversion is shown (it is what the converter could do)
    // but never saved as if it were the model
    // (nor one loadBuffer refuses, such as a file with no surfaces: saved
    // once it is shown, in the background, r22)
    await loadBuffer(out, name, seq, out, conversion);
    if (key && !conversion.unmeshedFaces && !stale(seq)) saveConversion(key, out, name);
    return;
  }
  if (stale(seq)) return;
  // Not a STEP/IGES/BREP name: it must BE a .cadmesh (raw or gzipped), checked
  // by its first bytes -- a URL may have no extension at all. Anything else is
  // refused in plain words, not as a .cadmesh decode error ("bad magic").
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  const cadm = b.length === 4 && String.fromCharCode(...b) === 'CADM';
  // a gzip of some other file (part.obj.gz) is refused by the name inside,
  // not inflated and then failed as a .cadmesh ("bad magic", review r18)
  const innerExt = /\.gz$/i.test(name) ? extOf(name.replace(/\.gz$/i, '')) : '';
  if (innerExt && innerExt !== 'cadmesh' && !cadm) {
    throw new Error(`${name} is not a file this viewer opens (.${innerExt}.gz): `
      + 'open a STEP (.stp, .step), IGES (.igs, .iges), BREP (.brep) or .cadmesh file, or one of them gzipped');
  }
  if (!cadm && !isGzip(buf)) {
    // a .cadmesh by name that is not one by its bytes is damaged, not of the
    // wrong kind (it was told to open a .cadmesh file: review r22)
    if (ext === 'cadmesh') throw new Error(`${name} is damaged or not a .cadmesh file inside: save it again from the viewer, or open the STEP it came from`);
    throw new Error(`${name} is not a file this viewer opens${ext ? ` (.${ext})` : ''}: `
      + 'open a STEP (.stp, .step), IGES (.igs, .iges), BREP (.brep) or .cadmesh file');
  }
  await loadBuffer(buf, name, seq);
}

// The conversion runs in this tab, in one call; the card shows the step it is
// on, the time so far, and what to expect.
const TESS_HINT = 'The file is converted in this tab, on this device. A large assembly can take a minute or more. '
  + 'The result is kept in this browser, so opening the same file again is instant; Save .cadmesh keeps a copy.';

// A converter failure in plain words: the converter's own refusal (import
// failed: …) as it is, anything else (out of memory, a crash) said as such,
// with the engine's text kept in brackets (it was shown alone: review r22)
const crashText = (msg) => (/^(import failed|converter unavailable)/.test(msg || '') ? msg
  : `the conversion stopped: the converter crashed or this device ran out of memory (${msg}). `
    + 'A smaller export, or a computer with more memory, may work');

// On the multi-core converter where this device can take it
// (js/converter-choice.js); if that fails, or leaves faces unmeshed, once more
// on the single-threaded one, which needs less memory.
// (a multi-core build that could not be loaded, remembered for the session:
// a site that ships only the single-threaded one failed every file on it
// first, review r23)
let threadsUnavailable = false;
async function convert(buf, format, seq, name) {
  if (!useThreads(browserEnv()) || threadsUnavailable) return tessellate(buf, format, seq, name, false);
  let why;
  let partial = null;
  try {
    const r = await tessellate(buf, format, seq, name, true);
    if (!r.unmeshedFaces) return r;
    partial = r;
    why = `${fmtInt(r.unmeshedFaces)} face${r.unmeshedFaces > 1 ? 's' : ''} could not be meshed`;
  } catch (e) {
    if (stale(seq)) throw e; // cancelled or superseded: no second try
    // a file the converter cannot read fails the same way on one thread:
    // said at once, not after a second conversion (review r22)
    if (/^import failed/.test(e.message || '')) throw e;
    why = e.message;
    if (/^converter unavailable/.test(why)) threadsUnavailable = true;
  }
  if (stale(seq)) throw new Error('superseded by a newer load');
  console.warn(`multi-core conversion of ${name}: ${why}; converting again on one thread`);
  announce(threadsUnavailable ? 'the multi-core converter is not available here: converting on one thread'
    : 'converting again on one thread, which needs less memory');
  try {
    return await tessellate(buf, format, seq, name, false);
  } catch (e) {
    // the second try failing keeps the first's result with its missing faces
    // (it was thrown away for the second's error: review r22)
    if (partial && !stale(seq)) return partial;
    throw e;
  }
}

function tessellate(buf, format, seq, name, threads) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./step-worker.js', import.meta.url));
    const t0 = performance.now();
    const bytes = buf.byteLength; // read now: posting buf to the worker detaches it (length 0)
    const size = mb(bytes);
    let stage = 'starting the converter';
    if (!stale(seq)) announce('converting'); // its ticks are progress, not news
    // The forecast from the file's contents (js/import-progress.js), until the
    // worker has counted them: from the size alone.
    let fc = forecast({ bytes, step: false }, threads);
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
        fc = forecast(m.features, threads);
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
      else if (m.type === 'done') done(resolve, { buffer: m.buffer, unmeshedFaces: m.unmeshedFaces || 0, threads });
      else done(reject, new Error(crashText(m.message)));
    };
    w.onerror = (e) => done(reject, new Error(crashText(e.message || 'the worker stopped')));
    show();
    // the multi-core try is sent a copy, so the bytes are still here for the
    // single-threaded one if it fails
    w.postMessage({ buffer: buf, format, threads }, threads ? [] : [buf]);
  });
}

// The file name a URL names -- what is shown, announced, offered by Save and
// read by extOf:
//   rack.cadmesh?v=2                        -> rack.cadmesh   (path part, query dropped)
//   /api/download?file=part.step&token=abc  -> part.step      (a query value naming a model file)
//   /api/download?id=7                      -> download       (no extension anywhere)
const MODEL_EXT = /\.(?:stp|step|igs|iges|brep|cadmesh)(?:\.gz)?$/i;
const fileName = (url) => {
  const [path, query = ''] = url.split('#')[0].split('?');
  // decoded, so "my%20part.stp" shows and saves as "my part.stp" (r22)
  let tail = path.split('/').pop();
  try { tail = decodeURIComponent(tail); } catch { /* keep it raw */ }
  if (/\.[a-z0-9]+$/i.test(tail)) return tail;
  for (const kv of query.split('&')) {
    let v = kv.slice(kv.indexOf('=') + 1);
    try { v = decodeURIComponent(v); } catch { /* keep it raw */ }
    v = v.split('/').pop();
    if (MODEL_EXT.test(v)) return v;
  }
  return tail;
};

// A fetch that throws had no usable answer. From another site the usual
// cause is that the site does not allow other web pages to read its files
// (no CORS headers) -- the browser hides which, so the message names both.
function fetchFailedText(url, name, e) {
  let host = null;
  try {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin) host = u.host;
  } catch { /* an unparsable URL: treated as this site's */ }
  return host
    ? `could not download ${name} from ${host}: that site does not let other web pages load its files (no CORS), `
      + 'or it did not answer. Download the file and open it here instead.'
    : `could not download ${name}: the server did not answer (${e.message || e})`;
}

async function loadUrl(url) {
  const seq = beginLoad();
  app.urlOfLoad = { seq, url }; // a view link can name a model loaded from a URL
  setStatus('loading', `fetching ${url}`);
  announce(`loading ${fileName(url)}`); // a new load is news even mid-load
  const tf = performance.now();
  app.fetchMs = null;
  const name = fileName(url);
  showProgress(`Downloading ${name}`, null, 'connecting…');
  let res;
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  app.fetchAbort = ac;
  try {
    res = await fetch(url, ac ? { signal: ac.signal } : {});
  } catch (e) {
    if (stale(seq)) return; // aborted: a newer load, or Cancel
    throw new Error(fetchFailedText(url, name, e));
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
      let step;
      try {
        step = await rd.read();
      } catch (e) {
        if (stale(seq)) return; // aborted mid-body
        throw e;
      }
      const { done, value } = step;
      if (done) break;
      if (stale(seq)) { rd.cancel(); return; }
      chunks.push(value);
      got += value.length;
      if (got > MAX_FILE_BYTES) {
        rd.cancel();
        throw new Error(`${name} is over ${(MAX_FILE_BYTES / 2 ** 30).toFixed(0)} GB, more than this viewer opens`);
      }
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

// The file a drop carries, or null with the reason said: a link, text or a
// page's image carries none; a folder is a file with no bytes to read; of
// several, the first opens. One function for the startup drop and the wired
// one (the startup one opened a folder, and said nothing of the rest: r23).
function droppedFile(e) {
  const dt = e.dataTransfer;
  const files = dt ? dt.files : [];
  const f = files[0];
  if (!f) { announce('Nothing to open: drop a model file (STEP, IGES, BREP or .cadmesh)'); return null; }
  const item = dt.items && dt.items[0];
  if (item && item.webkitGetAsEntry && item.webkitGetAsEntry()?.isDirectory) {
    announce(`${f.name} is a folder: drop the model file in it`);
    return null;
  }
  if (files.length > 1) announce(`opening ${f.name}; the viewer opens one file at a time (${files.length - 1} more not opened)`);
  return f;
}

// A file from the device (Open…, a drop). One too big is refused before
// anything starts: in loadFile the refusal came after the running load was
// cancelled, so it also killed a conversion in progress (review r21)
function openFile(f) {
  if (f.size > MAX_FILE_BYTES) {
    const msg = `${f.name} is over ${(MAX_FILE_BYTES / 2 ** 30).toFixed(0)} GB, more than this viewer opens`;
    announce(msg);
    if (!PROGRESS_STATES.has(app.status)) setStatus(app.mesh ? 'ready' : 'error', app.mesh ? `${readyText()} · ${msg}` : msg);
    return;
  }
  startLoad(() => loadFile(f));
}

async function loadFile(file) {
  const seq = beginLoad();
  app.fetchMs = null;
  // the cap downloads and gzip have, for a file from the device too (r20)
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is over ${(MAX_FILE_BYTES / 2 ** 30).toFixed(0)} GB, more than this viewer opens`);
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
      tw.onclick = () => { setOpen(ul.hidden); keepTabStop(); };
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
  keepTabStop();
}

// The tree's one tab stop on a row that is shown: the row last focused, or
// when a filter or a collapsed branch hides it the first shown row (else Tab
// skipped the whole tree)
function keepTabStop() {
  const root = $('tree');
  const cur = root.querySelector('.label[tabindex="0"]');
  if (cur && !cur.closest('[hidden]')) return;
  const first = [...root.querySelectorAll('.label')].find((l) => !l.closest('[hidden]'));
  if (cur) cur.tabIndex = -1;
  if (first) first.tabIndex = 0;
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

// The display unit in force, and a length (model units) in it. The geometry
// is in mm (OpenCascade converts on import); a file whose header names
// another unit is shown in that unit, unconverted.
const geomMm = () => !app.header || app.header.units === 'millimeter';
// (the model's largest extent, in mm, for Auto's choice: units.js autoUnit)
const modelSizeMm = () => {
  const b = app.header && app.header.bbox;
  return b ? Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : Infinity;
};
const curUnit = () => displayUnit(app.unitChoice, app.header?.sourceUnits, modelSizeMm());
const lenUnit = () => (geomMm() ? curUnit() : app.header.units);
const lenNum = (v, kind) => (geomMm() ? fmtNum(v, kind, curUnit()) : v.toFixed(1));

// What the file declares, in the picker's spelling where it has one
const UNIT_WORDS = { mixed: 'mixed (its parts disagree)', um: 'µm', uin: 'µin' };

// The info block's units row: its select lives outside the rebuilt values,
// so a refresh (a selection, a load) never closes an open picker. Only its
// text is set here.
function syncUnitsRow() {
  const row = $('infounits');
  row.hidden = !app.header;
  if (!app.header) return;
  const declared = app.header.sourceUnits;
  $('unitsrc').textContent = !geomMm() ? `${app.header.units} (not converted)`
    : declared ? (UNIT_WORDS[declared] || declared) : 'not recorded';
  const sel = $('unitsel');
  sel.disabled = !geomMm();
  sel.options[0].text = `Auto (${autoUnit(declared, modelSizeMm())})`;
  sel.value = app.unitChoice;
}

function setUnitChoice(u) {
  app.unitChoice = DISPLAY_UNITS.includes(u) ? u : 'auto';
  try {
    if (app.unitChoice === 'auto') localStorage.removeItem('cadv.units');
    else localStorage.setItem('cadv.units', app.unitChoice);
  } catch { /* storage off */ }
  showInfo();
  updateButtons(); // the section readout
}

function showInfo() {
  syncUnitsRow();
  const el = $('infovals');
  el.innerHTML = '';
  fillInfo(el);
  // no renderer and no model: no blank box or double rule
  $('info').hidden = !el.childElementCount;
}

function fillInfo(el) {
  const add = (k, v) => {
    const d = document.createElement('div');
    const a = document.createElement('b');
    a.textContent = k;
    d.append(a, ` ${v}`);
    el.append(d);
  };
  // the file, in full: the narrow footer truncates it, and its title tooltip
  // never shows on a touch screen
  if (app.header) add('file', `${app.sourceName} · ${fmtInt(app.header.meshes.length)} ${app.header.meshes.length === 1 ? 'body' : 'bodies'}`);
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
  const dims = b ? [0, 1, 2].map((k) => lenNum(b.max[k] - b.min[k], 'size')).join(' × ') : '-';
  let title = 'whole model';
  // a tree row chosen on its own: its full name (the row truncates it)
  if (ids.length && app.selName) title = ids.length > 1 ? `${app.selName} · ${ids.length} bodies` : app.selName;
  else if (ids.length === 1) title = meshLabel(ids[0]);
  else if (ids.length > 1) title = `${ids.length} bodies`;
  const tris = (ids.length ? ids.map((id) => app.header.meshes[id - 1].idxCount) : [app.header.indexCount]).reduce((a, x) => a + x, 0) / 3;
  add('selection', title);
  // "size (mm)" rather than "extent X × Y × Z (mm)": the longer label wrapped
  // the third value onto a line of its own in the 300 px panel
  add(`size (${lenUnit()})`, dims);
  add('triangles', fmtInt(tris));
  if (app.unmeshedFaces) add('missing faces', `${fmtInt(app.unmeshedFaces)} (the converter could not mesh them)`);
  // converted in this tab just now: on how many threads (js/converter-choice.js)
  if (app.stats?.converter) add('converted on', app.stats.converter);
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
    if (!res || !app.mesh || !sameModel(res.mesh, app.mesh)) return null;
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
    // The cards (empty state, progress) and the options bar sit inside the
    // view: a press on them is theirs. Capturing it for an orbit retargeted
    // the click to the view, so "Choose a file…" and Cancel never received it.
    if (e.target.closest(OVER_VIEW)) return;
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
    // dismiss: this press closed an open menu (the capture listener, just
    // before): it may still orbit, but a click does not pick
    const dismiss = dismissPresses.has(e);
    drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan, moved: false, id: e.pointerId, type: e.pointerType, dismiss };
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
      if (e.target.closest(OVER_VIEW)) { // over the bar: nothing of the model is hovered
        hoverXY = null;
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        app.hoverSeq++;
        setHover(0);
        return;
      }
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
    if (!d.moved && e.button === 0 && app.mesh && !d.dismiss) {
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
    if (lastType === 'touch' || e.target.closest(OVER_VIEW)) return; // a double-tap / a card's or the bar's own clicks
    fitAfterClick();
  });
  stage.addEventListener('wheel', (e) => {
    if (e.target.closest(OVER_VIEW)) return; // a card scrolls (a long error), the bar scrolls sideways; the view stays put
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
  // ☰ from the keyboard (Enter / Space, detail 0) moves the focus into the
  // slide-out, to the parts list: left on ☰, the list was 7 Tabs away on a
  // 390 px window and 11 on 844 x 390, past the whole toolbar (review r18).
  // Esc there gives it back to ☰.
  $('panelbtn').onclick = (e) => {
    const open = !panelOpen();
    setPanel(open);
    // (no model, no tree: the slide-out's first control, else the focus stayed
    // on ☰ and its controls were past File and View: review r19)
    if (open && e.detail === 0) partsStop()?.focus();
  };
  // (focus back to ☰ if it was in the panel: left in the hidden panel it fell
  // to the page, and the next Tab went to the full-screen button: r21)
  // Closed on the click, not the press: closed at the press the scrim stopped
  // catching the touch at once, and the tap's click went through to what lay
  // under it (Cancel, discarding a conversion; full screen: review r22)
  $('scrim').addEventListener('pointerdown', (e) => e.preventDefault());
  $('scrim').addEventListener('click', (e) => { e.preventDefault(); setPanel(false, true); });
  // the Open… label is the file picker's only visible control: make it
  // reachable and operable from the keyboard
  const openLbl = $('open').parentElement;
  openLbl.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('open').click(); }
  };
  wireMenus();
  wireOptbar();
  wireFullscreen();
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
  // Esc in the filter clears it (and stays in the field); a second Esc closes
  // the slide-out where there is one (the window's keydown)
  $('treefilter').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ''; filterTree(''); }
  });
  // Cancel a running load: making it stale stops its fetch at the next chunk,
  // terminates a tessellation worker (beginLoad), and keeps any upload from
  // being shown. What was on screen before stays.
  $('pcancel').onclick = () => {
    beginLoad();
    announce('loading cancelled');
    if (app.mesh) setStatus('ready', readyText());
    else setStatus('idle', IDLE_MSG);
  };
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('drop');
    const f = droppedFile(e);
    if (f) openFile(f);
  });
  $('open').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = ''; // so choosing the same file again fires change
    if (f) openFile(f);
  };
  document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  $('fit').onclick = () => fitTo(app.selected.size ? bboxOf([...app.selected]) : app.header && app.header.bbox);
  // Ortho, Z up and Flip are on/off toggles: the label names the option, the
  // pressed look (and aria-pressed, for a screen reader) says whether it is on
  $('proj').onclick = () => { app.cam.ortho = !app.cam.ortho; updateButtons(); viewChanged(); };
  // Z up: the file's +z up and -y toward the viewer, or back to its own frame
  // (y up); the choice holds for the next model that names no orientation
  $('up').onclick = () => {
    app.userOrient = app.cam.orient.startsWith('+z') ? DEFAULT_ORIENT : Z_UP_ORIENT;
    app.cam.orient = app.userOrient;
    updateButtons();
    setView('iso');
  };
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
  $('secpos').oninput = (e) => { app.section.t = Number(e.target.value) / 1000; updateButtons(); viewChanged(); };
  $('secflip').onclick = () => { app.section.flip = !app.section.flip; updateButtons(); viewChanged(); };
  const pal = $('palette');
  for (const p of PALETTES) pal.add(new Option(p.label, p.id));
  pal.value = app.palette;
  blurAfterPick(pal);
  // Undo's key as this OS names it (both work everywhere)
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
    $('undo').title = $('undo').title.replace('Ctrl+Z', '⌘Z');
    for (const k of document.querySelectorAll('#help .keys')) k.textContent = k.textContent.replace('Ctrl+Z', '⌘Z');
  }
  pal.onchange = () => setPalette(pal.value);
  wireModelList();
  const sty = $('style');
  for (const s of STYLES) if (BUILT_STYLES.includes(s.id)) sty.add(new Option(s.label, s.id));
  sty.value = currentStyle().id;
  syncStyleBg();
  blurAfterPick(sty);
  sty.onchange = () => setStyle(sty.value, true);
  blurAfterPick($('unitsel'));
  $('unitsel').onchange = (e) => setUnitChoice(e.target.value);
  // 'change', not 'input': a picker drag fires input continuously, and each
  // recolour re-uploads the model
  $('partcolour').onchange = (e) => setPartColour(e.target.value);
  $('partreset').onclick = () => resetPartColour();
  $('sharelink').onclick = () => shareView();
  $('export').onclick = async () => {
    if (!app.lastStepBuffer) return;
    const name = app.sourceName;
    // gzipped (about a sixth of the raw size); a browser without
    // CompressionStream saves the raw layout, which loads the same. A model
    // opened from the browser's saved conversions is gzipped already.
    const buf = app.lastStepBuffer;
    let bytes;
    try {
      bytes = isGzip(buf) || typeof CompressionStream !== 'function' ? buf : await deflateCadmesh(buf);
    } catch (e) {
      setStatus(app.status, `could not save ${name}: ${e.message || e}`);
      return;
    }
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([bytes]));
    a.href = url;
    a.download = `${name.replace(/\.[^.]+$/, '')}.cadmesh`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  $('cacheclear').onclick = async () => {
    const err = await cacheClear().then(() => null, (e) => e);
    await refreshCacheBar();
    announce(err ? `could not clear the saved conversions: ${err.message || err}` : 'saved conversions cleared');
  };
  window.addEventListener('keydown', (e) => {
    // leave browser shortcuts (Ctrl/Cmd/Alt+key) and typing in fields alone
    // ...except Ctrl/Cmd+Z, which undoes a visibility change (outside text fields)
    // (Z by the key's place on a layout that types no Latin letter, as the
    // letter shortcuts below: review r17)
    const zKey = e.key.toLowerCase() === 'z' || (nonLatinLetter(e.key) && e.code === 'KeyZ');
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && zKey) {
      const t0 = e.target;
      const field = (t0.tagName === 'INPUT' && !NOT_TYPED.includes(t0.type))
        || t0.tagName === 'TEXTAREA' || t0.isContentEditable;
      if (!field && app.visUndo.length) { e.preventDefault(); undoVisibility(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // only fields that take typed text swallow the letters; a focused tree
    // checkbox or button must not disable the shortcuts
    const t = e.target;
    // Esc closes an open toolbar menu first, wherever focus is
    if (e.key === 'Escape' && closeMenus(true)) { e.preventDefault(); return; }
    const typed = (t.tagName === 'INPUT' && !NOT_TYPED.includes(t.type))
      || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
    // ...but Esc in the slide-out's field (an empty Filter parts: a filled one
    // clears first, in its own handler) closes the slide-out, as from its tree
    if (typed && e.key === 'Escape' && panelOpen() && $('parts').contains(t)) { e.preventDefault(); setPanel(false, true); return; }
    if (typed) return;
    // number keys: the digit row by the character typed (AZERTY types a
    // digit with Shift), the numpad by its key code (whatever NumLock says)
    // A digit row that types other digits (Persian, Arabic-Indic) goes by the
    // key's place (review r19)
    // With NumLock off a numpad key types End, PageUp, an arrow…: a view key
    // then only where no control has the focus (End on the section slider
    // jumped to Front; PageUp in the tree: review r20)
    // (controls that move by those keys: a slider, a select, the parts tree;
    // a focused button, as after a click on a view preset, does not)
    const navKey = e.key.length > 1;
    // (t may be the window itself, for a key sent to it: not a Node)
    const onControl = t.type === 'range' || t.tagName === 'SELECT' || (t instanceof Node && $('tree').contains(t));
    const digit = /^[0-9]$/.test(e.key) ? e.key
      : /^Numpad[0-9]$/.test(e.code) && !(navKey && onControl) ? e.code.slice(6)
        : /^\p{Nd}$/u.test(e.key) && /^Digit[0-9]$/.test(e.code) ? e.code.slice(5) : null;
    // ...unless a control used the key already (with NumLock off the numpad's
    // 1 is End, 2 ↓, 8 ↑, which the parts tree moves by)
    if (digit !== null && digit in VIEW_KEYS && !e.defaultPrevented) {
      e.preventDefault();
      // a held key acts once, as the letters: 5 toggled Ortho on and off (r19)
      if (!e.repeat) viewKey(digit);
      return;
    }
    // then an open parts panel (the narrow layout's slide-out); the next Esc
    // clears the selection. Letters match in either case, so Caps Lock does
    // not turn the shortcuts off.
    // A layout whose keys type no Latin letter (Cyrillic, Greek) goes by the
    // key's place, as QWERTY names it.
    const acts = { f: () => $('fit').click(), Escape: () => (panelOpen() ? setPanel(false, true) : select([], false)), h: () => $('hide').click(),
      i: () => $('isolate').click(), a: () => $('showall').click(), e: () => edgesKey() };
    let k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // (a LETTER of another script only: punctuation on a Latin layout keeps
    // its own meaning; on Dvorak "." sits at KeyE and toggled the edges, r18)
    if (nonLatinLetter(k) && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
    const act = acts[k];
    if (!act) return;
    // the key's own browser action (Quick Find on ' / Firefox, ...) is not run
    // too, and a held key acts once: a repeat would toggle E on and off
    e.preventDefault();
    if (e.repeat) return;
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
  // A file chosen or dropped while the GPU starts (Open… works from the
  // first paint): kept and opened once the input is wired. It was ignored,
  // and a drop made the browser leave the page for the file (review r21)
  let early = null;
  const keep = (f) => { if (f) { early = f; setStatus('init', `starting GPU, then opening ${f.name}`); } };
  const over = (e) => e.preventDefault();
  const drop = (e) => { e.preventDefault(); keep(droppedFile(e)); };
  window.addEventListener('dragover', over);
  window.addEventListener('drop', drop);
  $('open').onchange = (e) => { keep(e.target.files[0]); e.target.value = ''; };
  // (Open… from the keyboard too, as wireInput makes it: r22)
  const openKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('open').click(); } };
  const openLbl = $('open').parentElement;
  openLbl.addEventListener('keydown', openKey);
  try {
    adoptRenderer(await makeRenderer());
  } finally {
    // (also when no GPU starts: left in place, a file chosen then turned the
    // error into "starting GPU, then opening …" for ever: r22)
    window.removeEventListener('dragover', over);
    window.removeEventListener('drop', drop);
    openLbl.removeEventListener('keydown', openKey);
    if (!app.renderer) {
      // no GPU: nothing can be shown, so nothing offers to open a file (the
      // card's "Choose a file…" did nothing, a chosen file vanished), and a
      // drop is caught (the browser left the page for it): review r23
      $('open').onchange = null;
      openLbl.hidden = true;
      $('emptyopen').hidden = true;
      window.addEventListener('dragover', over);
      window.addEventListener('drop', (e) => { e.preventDefault(); announce('this browser has no GPU the viewer can use, so it cannot open a model'); });
    }
  }
  wireInput();
  keepFocus();
  queueFrame();
  refreshCacheBar();
  const src = params.get('src');
  // ?orient=up:+z,front:-y: which of the file's axes is up and which faces the
  // viewer, for a model this page opens from a URL that its list entry does
  // not orient (orientFor). A bad one is no orientation, never an error.
  app.urlOrient = orientOrNull(params.get('orient'));
  // #view=…: the view a shared link names, applied when its model has loaded
  // (the model its own ?src names; with none, the next one opened from the
  // device, never the model list's first). A bad escape (a hand-edited or cut
  // link) is no view, never an error: decodeURIComponent throws on it, which
  // here stopped the model loading
  const viewHash = () => {
    if (!location.hash.startsWith('#view=')) return null;
    try { return decodeURIComponent(location.hash.slice(6)); } catch { return null; }
  };
  if (viewHash()) app.pendingView = { src, view: decodeView(viewHash()) };
  window.addEventListener('hashchange', () => {
    // (the model now in ?src=: a pick from the model list changes it)
    const now = new URLSearchParams(location.search).get('src');
    if (viewHash() && app.header && (now ? app.sourceUrl === now : !app.sourceUrl)) applyView(decodeView(viewHash()));
  });
  // ?src opens at once; ?list= (one or more) is read beside it, never in its
  // way. With no ?src the list's first model opens, unless the user opened
  // something meanwhile.
  const seq0 = app.loadSeq;
  // (through loadListed, so a list read meanwhile names it while it opens and
  // a pick of it does not start it again: review r19)
  const opening = src ? loadListed(src) : null;
  const lists = params.getAll('list');
  if (!src) setStatus('idle', lists.length ? 'reading the model list…' : IDLE_MSG);
  const listed = lists.length ? readLists(lists, () => !src && app.loadSeq === seq0) : null;
  // the file the user chose while the GPU started: the newest ask, so it
  // supersedes ?src (and the list's first model does not open after it)
  if (early) openFile(early);
  await Promise.all([opening, listed]);
}

// The model lists: fill the drop-down, open the first model when wanted (no
// other load started), and say on the status line which lists could not be
// read, or that they name no models
async function readLists(lists, openFirst) {
  const timed = (u) => fetch(u, typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(20000) } : {});
  const r = await fetchModelLists(lists, location.href, timed);
  fillModelList(r.entries);
  app.listNote = r.errors.length ? listNote(r.errors) : r.entries.length ? '' : 'the model list names no models';
  if (app.listNote) announce(app.listNote);
  if (openFirst() && r.entries.length) {
    await loadListed(r.entries[0].url);
  } else if (app.status === 'ready') setStatus('ready', readyText());
  else if (app.status === 'idle') setStatus(app.listNote && !r.entries.length ? 'error' : 'idle', app.listNote || IDLE_MSG);
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
      // the edge list: from the file, or how long the worker took to build it
      const e = await app.baseMesh?.edgeInfo?.ready;
      out.edges = e ? { source: e.source, ms: e.ms, boundary: e.edges.length / 2,
        silhouettes: e.silhouettes ? e.silhouettes.length / 2 : 0, omitted: e.silhouettesOmitted,
        closed: e.facts.closed.filter(Boolean).length } : { error: app.baseMesh?.edgeInfo?.error || 'none' };
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
