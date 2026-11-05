// CAD viewer front end: backend selection (WebGPU -> WebGL2 -> WebGL1), loading
// (.cadmesh direct; .stp/.step/.igs/.brep through the OpenCascade worker; the
// meshes -- STL, OBJ, PLY, OFF, 3MF, glTF -- a 2D DXF or DWG, and a zip of one
// through their readers, loaded on first use), orbit camera, part tree,
// picking, section plane. Rendering is on demand.

import { DEFAULT_TESSELLATION, MAX_FILE_BYTES, MM, bodyLabels, noSurfaces, decodeCadmesh, deflateCadmesh, gunzip, hashName, inflateCadmesh, isGzip, writtenSizeLimit, cadmeshToSave } from './cadmesh.js';
import { SNIFF_BYTES, extOf, formatOfName, sniffFormat, isDWGBytes, isCompanion, fileNameOfUrl, acceptList, opensShort, opensText } from './formats.js';
import { directFor, fileUrl } from './open-url.js';
import { samePlace } from './same-place.js';
import { withoutBom } from './step-text.js';
import { stepProducts } from './step-meta.js';
import { cacheAvailable, cacheClear, cacheDelete, cacheGet, cacheKey, cacheList, cachePut } from './mesh-cache.js';
import { PALETTES, bodyColours, hexToRgb, rgbToHex, schemeColours } from './palettes.js';
import { entryByName, fetchModelLists, isRelative, modelNameFrom, modelUrlFrom, posterAsked, readCapped, timedFetch } from './model-list.js';
import { earlyFetch, earlyLists, releaseEarly } from './early-fetch.js';
import { camDir, camUp, eyeOf, fitBox, fitDistance, levelOrbitBy, nearFar, orbitBy, panBy, pinchStep, qFromBasis, qMul, quatFromView, refitForAspect, sphereOf, turnAbout, zoomAt, zoomBy } from './camera.js';
import { DEFAULT_ORIENT, PORTRAIT, VIEWS as VIEW_ROWS, VIEW_PRESETS, Z_UP_ORIENT, isoView, orientOrNull, orientQuat, orientUp } from './orient.js';
import { deviceFactor, forecast, forecastDone, forecastTotal, rateText, stepOf, timeLeft } from './import-progress.js';
import { browserEnv, useThreads } from './converter-choice.js';
import { DISPLAY_UNITS, MM_PER, autoUnit, displayUnit, fmtArea, fmtMass, fmtNum, fmtVolume, unitWord } from './units.js';
import { bodyTable, edgeInstances, silhouetteInstances, FACTS_RULE, SILHOUETTE_CAP, overSilhouetteCap, flagsSaid, factsCurrent, momentaryFailure } from './edges.js';
import { MAX_NOTES, bodyKeys, decodeView, encodeView, resolveBodies, roundCamera, roundFraction, roundNotePoint } from './view-link.js';
import { aboveBelow, rangesFrom } from './datum.js';
import { EXPORTS, NOTHING_TO_EXPORT, exportBasis, exportable } from './export-mesh.js';
import { drawingSVG } from './drawing-svg.js';
import { createMeasure } from './measure-ui.js';
import { mergeModels, modelRanges, sceneEdgesFacts, staleModels, edgesUsable } from './scene.js';
import { clearance } from './clearance.js';
import { CUT_FILL, EMBED_DARK_BG, PAPER, STYLES, VIEW_BG, edgePasses, rgb, styleById, styleFor, toggleEdges } from './styles.js';
import { lookAt, multiply, perspective, ortho } from './mat4.js';
import { getPref, getPrefJSON, setPref, setPrefJSON } from './prefs.js';
import { MAX_TOUR_BYTES, namesFor, parseTour, partIndex, readingScale, resolveParts, tourAt, tourNames } from './tour.js';
import { createTourRecorder } from './tour-recorder.js';
import { EASE, poseAt } from './tour-path.js';
import { clearestDirection, meshFaceBoxes, obstaclesFor } from './tour-sight.js';
import { WebGLRenderer } from './renderer-webgl.js';

// The format readers and the 2D view, loaded when a file needs them, not before the page's first
// card: a .cadmesh.gz shown in an embed loaded the DWG, DXF and mesh-format readers first (1.16 MB
// in 46 modules, "Loading the 3D viewer…" for 33.9 s on a throttled 3G link from a server that does
// not compress: tests/test-first-phase.mjs, the round-51 review). Each is fetched once; a failed
// fetch is tried again by the next file that needs it, and said in plain words (the browser's
// "Failed to fetch dynamically imported module: …/js/mesh-formats.js" was the card's error: r52 A8, Q8).
const once = (load, what) => {
  let p = null;
  // (a failed download -- import()'s TypeError -- in those words; any other failure, a module that
  // does not run, said as itself, and its cause kept in the console: every failure was "check the
  // connection" -- r53 A6, Q7)
  return () => (p ||= load().catch((e) => {
    p = null;
    console.error(e);
    throw new Error(e instanceof TypeError
      ? `the viewer's reader for ${what} could not be downloaded: check the connection, then open the file again`
      : `the viewer's reader for ${what} did not load: ${e?.message || e}`);
  }));
};
const meshReaders = once(() => import('./mesh-formats.js'), 'meshes and zips');
const fileReaders = once(() => import('./read-file.js'), 'this file');
// (in hand before show2D, which draws at once: loadDxf awaits them)
let dxfLib = null, dxfViewLib = null;
const twoD = once(async () => { [dxfLib, dxfViewLib] = await Promise.all([import('./dxf.js'), import('./dxf-view.js')]); }, '2D drawings');

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const STATE_W = 1024;
// (index.html's head script set html.dark already: an embed in a dark page)
const BG = rgb(document.documentElement.classList.contains('dark') ? EMBED_DARK_BG : VIEW_BG);
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
  edgeJobs: new Map(), // base -> { stop, promise }: each model's running edge build (edgesOf, stopEdgeJobs)
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
    const p = getPref('cadv.palette');
    return PALETTES.some((x) => x.id === p) ? p : 'file';
  })(),
  // the display unit chosen (js/units.js); only an explicit choice is
  // remembered, so 'auto' (the file's declared unit) is the absence of one
  unitChoice: (() => {
    const u = getPref('cadv.units');
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
  styleChoice: new URLSearchParams(location.search).get('style') || getPref('cadv.style'),
  showSilhouettes: true, // the outline styles' silhouettes; a test turns them off for a control
  // colours picked for single parts of the loaded model: body index -> [r, g, b],
  // remembered in this browser under the model's key (modelKey)
  overrides: new Map(),
  modelKey: '',
};

// A model's key for its remembered part colours: its bodies' names and vertex and index counts,
// so the same model opened again (from STEP or from a saved .cadmesh) finds
// them, and a different one does not.
const modelKeyOf = (header) => `cadv.colours.${header.meshes.length}-${
  hashName(JSON.stringify(header.meshes.map((m) => [m.name, m.vtxCount, m.idxCount]))).toString(36)}`;

function loadOverrides(key, bodies) {
  const out = new Map();
  // (storage off or a damaged entry: no remembered colours)
  const saved = getPrefJSON(key, {});
  if (!saved || typeof saved !== 'object') return out;
  for (const [i, hex] of Object.entries(saved)) {
    const n = Number(i);
    if (Number.isInteger(n) && n >= 0 && n < bodies && /^#[0-9a-f]{6}$/i.test(hex)) out.set(n, hexToRgb(hex));
  }
  return out;
}

// (storage off or full: the colours last while the model is open)
// The VISITOR's colours: while a tour plays, app.overrides is the tour's map (its step's colours,
// every other part grey), which the visitor's own colours are kept under app.tour.base
const ownOverrides = () => (app.tour ? app.tour.base.overrides : app.overrides);
// ...and Paint's face colours, set aside while a tour plays (startTour)
const ownFaces = () => (app.tour ? app.tour.base.faceOverrides : app.faceOverrides);
function saveOverrides() {
  if (!app.modelKey) return;
  const own = ownOverrides();
  setPrefJSON(app.modelKey, own.size ? Object.fromEntries([...own].map(([i, c]) => [i, rgbToHex(c)])) : null);
}
window.__cadv = app;
app.redraw = () => viewChanged(); // for tests that change a display flag
app.refreshState = () => pushState(); // for tests that change a body's facts

// The model as drawn in the current colour scheme and part colours: the
// decoded model itself for the file's colours with nothing overridden, else a
// copy that differs only in its colours.
const inScheme = (base, overrides = app.overrides, faces = app.faceOverrides || new Map()) => (app.palette === 'file' && overrides.size === 0 && !faces.size
  ? base : { ...base, color: schemeColours(base, app.palette, overrides, faces) });

// The ONE writer of the #announce live region. Every write takes a sequence
// number; a write deferred to the next frame (to repeat the last text, which a
// screen reader only hears again after the region was emptied) lands only if
// nothing newer was said meanwhile -- else a queued "loading x" could land
// after "ready" or an error (a fast failure, or a background tab, where frames
// do not run), and be the last thing said.
// (What is said in one moment is said together, in order: a later write in the same task replaced
// an earlier one unheard -- the tour's "lacks parts", a scene's missing faces, a drawing's unit
// -- r45 Q2. The moment is the task, awaits within it included: a microtask's flush let a write
// after an await replace the one before -- a re-read's "read in inch", a ?tour='s lines -- r46 Q2.)
let saySeq = 0, sayParts = null;
function announce(text) {
  if (sayParts) { if (!sayParts.includes(text)) sayParts.push(text); return; }
  sayParts = [text];
  setTimeout(() => { const t = sayParts.join(' · '); sayParts = null; sayNow(t); }, 0);
}
function sayNow(text) {
  const el = $('announce');
  const seq = ++saySeq;
  if (el.textContent !== text) { el.textContent = text; return; }
  el.textContent = '';
  requestAnimationFrame(() => { if (seq === saySeq) el.textContent = text; });
}

// A note for the user: shown where the view's short notes go (the hover line, for ms) and read
// out (`said`, if it says it otherwise). The one way a note reaches anyone: a note only shown --
// "export failed", "the picture could not be copied" -- was never heard, and the status line is not
// drawn (r45 A1, Q1). flashHover is called only from here.
// (text empty: read out only -- Measure off; said null: shown only, the words said beside it by the
// caller in its own words -- a tour step's)
function tell(text, ms = 1500, said = text) {
  if (text) flashHover(text, ms);
  if (said) announce(said);
}

// A note added to the ready line: the line is the ready text with these words after it -- written
// only while the page is ready (a load, an error or a GPU recovery keeps its own state and line:
// one of these met during a load set 'ready' under it, hid its progress and put the old model's
// line back; one during a recovery stopped "recovered on …" -- r46 A2, Q1) -- and the words, only
// they, not what the ready line always carries, told either way (the whole line after "ready · "
// was shown and read again on every rewrite: r45 A2, Q4)
function tellReady(words, ms = 6000) {
  if (app.status === 'ready') setStatus('ready', `${readyText()} · ${words}`);
  tell(words, ms);
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
  // (#status is not drawn -- the footer that held it is hidden: words a writer adds to the ready
  // line while ready reach the user as a note -- tellReady, sayNoFacts -- r44 Q1)
  const text = msg || s;
  if (!PROGRESS_STATES.has(s) && (s !== app.status || (s === 'error' && text !== app.statusMsg))) announce(text);
  // (an error while a model or drawing stays is shown in the view: the error card shows it only
  // when nothing does, and the line is not drawn -- a load's failure over a model was read out
  // and drawn nowhere: r47 Q1)
  if (s === 'error' && somethingShown()) tell(text, 6000, null);
  app.status = s;
  app.statusMsg = msg || s; // (what the line says: sayNoFacts writes its word in place, showBase takes it back)
  $('status').textContent = msg || s;
  $('status').title = msg || s; // the whole message, where the line is cut short
  $('status').dataset.state = s;
  if (!PROGRESS_STATES.has(s)) $('progress').hidden = true;
  // (a card, a model or an error is now the view's to show: index.html's
  // "Loading the 3D viewer…" goes)
  // ("?.": tests/test-scene.mjs runs this function's own code with no page)
  if (s === 'ready' || s === 'idle' || s === 'error') globalThis.document?.documentElement.classList.add('started');
  showEmpty();
}

// (every kind of file the page opens, as its empty card says)
const IDLE_MSG = `open or drop ${opensShort()}`;
const mb = (n) => (n / 1e6).toFixed(1);

// Whether a model or a 2D drawing is shown: the one test, for the empty card, Cancel, a failure
// apart from the load, the GPU recovery's end and an error shown in the view (three of them
// asked app.mesh alone, and a drawing read as nothing shown: r47 A2, Q3)
function somethingShown() { return !!(app.mesh || app.dxf); }

// A failure that is not the running or shown load's own -- a file refused for its size, a tour
// that could not be read, a GPU error: told while something is shown or a load runs, their state
// and line kept; else the page's error (the card shows it), read out again when it repeats. One
// rule: the tour's end asked app.header and the GPU error set 'error' whatever ran, so a tour
// unread over a drawing, or a GPU error under a load's "convert it?" question, made the page's
// error -- the question and its buttons hidden, the load hung (r48 A1, Q1, Q2, Q10)
// (the page's error only when nothing is shown and nothing runs: an error up -- a load's own, on the
// card -- is kept, the new failure told beside it, and a recovery is left to end: the card lost why
// the model failed, and a recovery ended on an error with a working renderer -- r49 Q3, Q4, A5)
// (an embed's poster counts as shown: its card hidden behind the poster, the error was heard only and
// then replaced unseen by View in 3D -- r50 Q5)
// (the GPU still starting is nothing running: a file over the size picked then, opened first since
// r51 A11, was told and then lost under the idle line)
// (a list read for the model it names hides the card: a failure then is told -- shown and read
// out -- not left to a card no one sees: r52 Q3)
function failApart(msg) {
  if (somethingShown() || posterUp() || app.readingList || !(app.status === 'idle' || app.status === 'init')) tellReady(msg);
  else { setStatus('error', msg); announce(msg); }
}
// an embed's poster up: its picture stands in for the model until View in 3D
const posterUp = () => !!app.embed && !!$('poster') && !$('poster').hidden;

// The GPU recovery's start: the page 'recovering' -- but a load under way keeps its state, its card
// and its question, and the loss is told (written over it, a load's "convert it?" question was
// hidden and the load hung: r49 Q1)
// (an error up kept too, as failApart keeps it: a failed ?src's 404 went recovering, then idle, and
// the card lost it -- r50 A3, Q4)
function recoveryStarts(why) {
  const text = `GPU context lost (${why}); recovering`;
  if (PROGRESS_STATES.has(app.status) || app.status === 'error') tell(text, 6000);
  else setStatus('recovering', text);
}
// The recovery's end on a renderer that cannot hold the shown model: the page's error -- but under a
// load, which keeps its state, told, and noted (app.gpuLacks) so that a Cancel, which leaves the old
// model shown, says it is not drawn rather than "ready" over an empty view (r50 A4, Q2: a third
// copy of the rule, untested; Cancel then wrote "ready" over a model the renderer did not hold)
// (noted with no load running too: the note follows the model, not the moment -- "cannot hold", a
// load, then Cancel wrote "ready" over a model the renderer did not hold: r51 A1)
function cannotHold() {
  const msg = `recovered on ${app.backend}, but it cannot hold this model: ${app.error}`;
  app.gpuLacks = { mesh: app.mesh, msg };
  if (PROGRESS_STATES.has(app.status)) tell(msg, 6000);
  else setStatus('error', msg);
}
// Whether the shown model is the one the recovered renderer could not hold (a drawing is no model:
// a note of none matched it, and Cancel over a drawing said its model could not be held -- r51 Q3 c)
const shownLacksGpu = () => !!app.mesh && !!app.gpuLacks && app.gpuLacks.mesh === app.mesh;
// The GPU recovery's end: back to ready, or idle when nothing is shown, and "recovered on …" told
// (it was written into the undrawn line, and with nothing shown the line read the bare word
// "idle": r48 A7). A load that started meanwhile owns the state: nothing is written over it, and
// it is told all the same (r49 Q1).
// (a recovery that holds the model ends an earlier one's "cannot hold" -- its note, and the page's
// error it made: the page stayed 'error' over a drawn model, and a Cancel said it was not drawn --
// r51 A2, Q3 a, b; the idle words those of the page: r51 Q5)
function recovered() {
  const lacked = app.gpuLacks;
  app.gpuLacks = null;
  if (app.status === 'recovering' || (app.status === 'error' && lacked && app.statusMsg === lacked.msg)) {
    if (somethingShown()) setStatus('ready', readyText());
    else setStatus('idle', idleText());
  }
  tell(`recovered on ${app.backend}`, 4000);
}
// What the line says with nothing shown: an embed's poster its own words, an embed none of the
// open-a-file words (its visitor chose nothing to open), else what the page opens (r51 Q5: read out
// in an embed by the recovery's end and by Cancel)
const POSTER_MSG = 'View in 3D loads the model';
const idleText = () => (posterUp() ? POSTER_MSG : app.embed ? 'no model to show' : IDLE_MSG);

// The empty-state card: shown while there is no model and no load running (and,
// by CSS, during a drag over the view). After a failed load it carries the error.
function showEmpty() {
  const busy = PROGRESS_STATES.has(app.status) || app.status === 'init' || app.status === 'recovering' || app.readingList;
  // (an embed's poster stands in for it until the visitor asks for the model: posterUp, the one test
  // of it -- r51 A7)
  $('empty').hidden = somethingShown() || busy || posterUp();
  $('emptyerr').hidden = app.status !== 'error';
  $('emptyerr').textContent = app.status === 'error' ? $('status').textContent : '';
  // In an embed the card is for the host page's visitor, who chose nothing to
  // open: it says the model could not be shown, and why, and offers the full
  // viewer -- never "Choose a file…" or the drop hint
  if (app.embed) {
    const failed = app.status === 'error';
    document.querySelector('#empty h2').textContent = failed ? 'This model could not be shown' : 'No model to show';
    for (const sel of ['.drop-hint', '.drop-now', '#emptyopen', '#empty .note']) {
      const el = document.querySelector(sel);
      if (el) el.hidden = true;
    }
    let a = $('emptyfull');
    if (!a) {
      a = document.createElement('a');
      a.id = 'emptyfull';
      a.className = 'btn';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open in cad.place ↗';
      $('emptyerr').before(a);
    }
    // (the full viewer with the same address, but not ?embed: it may open
    // there, and its message is in full)
    const u = new URL(location.href);
    u.searchParams.delete('embed');
    a.href = u.href;
    a.hidden = !failed;
  }
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
  document.documentElement.classList.add('started'); // (index.html's "Loading the 3D viewer…" goes)
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
  const forced = params.get('backend');
  const order = { webgpu: ['webgpu'], webgl2: ['webgl2'], webgl1: ['webgl1'] }[forced]
    || ['webgpu', 'webgl2', 'webgl1'];
  // a software WebGPU adapter is passed over for WebGL, and taken only when
  // WebGL fails too (or ?backend=webgpu asks for WebGPU whatever it runs on)
  let softwareGpu = false;
  for (const name of [...order, 'webgpu-software']) {
    if (name === 'webgpu-software' && !softwareGpu) break;
    // A canvas keeps the first context type it hands out, so every attempt gets a fresh one.
    const old = $('view');
    const canvas = old.cloneNode(false);
    old.replaceWith(canvas);
    try {
      let r;
      if (name === 'webgpu' || name === 'webgpu-software') {
        const { WebGPURenderer } = await import('./renderer-webgpu.js');
        r = await WebGPURenderer.create(canvas, { allowSoftware: name === 'webgpu-software' || forced === 'webgpu' });
      } else {
        // ?gl-without=instancing,float,vtf,uint: act as a WebGL GPU without
        // those (the fallbacks' tests; SwiftShader has them all)
        const without = (params.get('gl-without') || '').split(',').filter(Boolean);
        r = WebGLRenderer.create(canvas, name === 'webgl2' ? 2 : 1, { without });
      }
      app.attempts.push({ backend: name === 'webgpu-software' ? 'webgpu' : name, ok: true });
      return r;
    } catch (e) {
      if (e.software) softwareGpu = true;
      app.attempts.push({ backend: name === 'webgpu-software' ? 'webgpu' : name, ok: false, error: String(e.message || e) });
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
  r.onerror = (msg) => { if (app.renderer === r) { app.error = msg; failApart(`GPU error: ${msg}`); } };
  // lost between creation and here (onlost was not wired yet): report it now
  if (isDead(r)) queueMicrotask(() => r.onlost && r.onlost('lost before it was adopted'));
  $('backend').textContent = app.backend.toUpperCase();
  // the attempts behind THIS renderer (makeRenderer empties app.attempts when
  // a recovery starts), and the ? box's graphics line follows the swap
  // (showInfo writes it).
  app.adoptedAttempts = app.attempts.slice();
  showInfo();
}

// The graphics line, in the words the info panel and the badge's tooltip share:
// "graphics WebGL 2 -- WebGPU not available: no WebGPU adapter".
function graphicsNote() {
  const NAMES = { webgpu: 'WebGPU', webgl2: 'WebGL 2', webgl1: 'WebGL 1' };
  if (gaveUp) return `none -- ${gaveUp}`;
  if (!app.backend) return '';
  const skipped = (app.adoptedAttempts || []).filter((a) => !a.ok)
    .map((a) => `${NAMES[a.backend] || a.backend} not available: ${a.error}`);
  const lost = app.status === 'recovering' ? ' (lost; recovering)' : '';
  return `${NAMES[app.backend] || app.backend}${lost}${skipped.length ? ` -- ${skipped.join('; ')}` : ''}`;
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

const isDead = (r) => !r || r.isLost();

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

// The drawn mesh's edge instances onto renderer r. Built once per mesh and edge
// value -- a build's edges replacing a file's drawn before are built again (a
// recolour makes a new mesh, whose instances carry the new colours). Never
// throws: edges the GPU cannot hold are left out, and the model stays.
const edgeData = new WeakMap();

// ---------- Explode (plan feature 8) ----------
// Each body's direction, summed down the assembly tree: (a node's centre -
// its parent's) at each level, then (the body's centre - its node's), so
// subassemblies part first and their bodies then part within them. A flat
// tree (no subassembly) gives the radial direction from the model's centre,
// which suits few models, so it starts along the view's up axis instead.
// X / Y / Z keep one file axis of it. Scaled so the farthest-moving body
// travels one model diagonal at 100 %. The directions go in the body table
// (js/edges.js bodyTable's slot 0..2, which the vertex shaders read); the
// fraction is the frame's `explode`. Every renderer offers it: a WebGL1 with
// no vertex textures takes the directions as a vertex attribute instead
// (js/renderer-webgl.js aXd).
app.explode = { on: false, t: 0.4, mode: null, dirs: null, len: 0, flat: false, for: null };
const cen = (b) => [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);

function explodeDirs(mode) {
  const h = app.header;
  const n = h.meshes.length;
  const raw = new Float64Array(n * 3);
  // each node's box, bottom up, once: collected per node, every body was walked again at each level
  // of the tree (a million bodies under 256 levels: 12.9 s on the page's thread)
  const boxes = new Map();
  const boxOfNode = (node) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const grow = (b) => { if (b) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); } };
    for (const mi of node.meshes) grow(h.meshes[mi].bbox);
    for (const ch of node.children) grow(boxOfNode(ch));
    const b = min[0] === Infinity ? null : { min, max };
    boxes.set(node, b);
    return b;
  };
  boxOfNode(h.root);
  const walk = (node, parentC, acc) => {
    const b = boxes.get(node);
    const c = b ? cen(b) : parentC;
    const a = [0, 1, 2].map((k) => acc[k] + c[k] - parentC[k]);
    for (const mi of node.meshes) {
      const bb = h.meshes[mi].bbox;
      if (!bb) continue;
      const bc = cen(bb);
      for (let k = 0; k < 3; k++) raw[mi * 3 + k] = a[k] + bc[k] - c[k];
    }
    for (const ch of node.children) walk(ch, c, a);
  };
  const rc = h.bbox ? cen(h.bbox) : [0, 0, 0];
  walk(h.root, rc, [0, 0, 0]);
  const keep = { x: 0, y: 1, z: 2 }[mode];
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (keep !== undefined) for (let k = 0; k < 3; k++) if (k !== keep) raw[i * 3 + k] = 0;
    max = Math.max(max, Math.hypot(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]));
  }
  const b = h.bbox;
  const diag = b ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : 1;
  const s = max > 0 ? diag / max : 0;
  const dirs = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) dirs[i] = raw[i] * s;
  return { dirs, len: max > 0 ? diag : 0 };
}

// a flat tree: no node under the root holds more than one body
const flatTree = () => !app.header.root.children.some((c) => collect(c).length > 1);

// The body table for `mesh` with the explode directions in it
function bodiesWithExplode(mesh) {
  const t = bodyTable(mesh.header);
  const x = app.explode;
  if (x.dirs && x.for === app.header) {
    for (let i = 0; i < mesh.header.meshes.length; i++) {
      for (let k = 0; k < 3; k++) t[(i + 1) * 8 + k] = x.dirs[i * 3 + k];
    }
  }
  return t;
}

// The table on the GPU for the drawn mesh (again after a mode change)
function syncBodies(force = false) {
  const r = app.renderer;
  if (!r || !app.mesh) return;
  try {
    if (force || r.bodiesFor !== app.mesh) r.setBodies(app.mesh, bodiesWithExplode(app.mesh));
  } catch (e) {
    app.edgeError = String(e.message || e);
  }
}

// The bounding sphere the view uses (depth range, Fit, zoom limits): the
// model's, grown by how far the farthest body has moved, while exploded
function syncExplodeSphere() {
  const base = app.sphereBase || app.sphere;
  const x = app.explode;
  app.sphere = x.on ? { center: base.center, radius: base.radius + x.t * x.len } : base;
}

function setExplodeMode(mode) {
  const x = app.explode;
  const fitted = x.on && atLastFit();
  x.mode = mode;
  const d = explodeDirs(mode);
  x.dirs = d.dirs;
  x.len = d.len;
  x.for = app.header;
  syncBodies(true);
  syncExplodeSphere();
  syncExplodeRow();
  if (fitted) fitTo(drawnBox(null));
  viewChanged();
}

function setExplode(on, focus = false) {
  const x = app.explode;
  if (on && (!app.header || !app.renderer)) return;
  if (on === x.on) return;
  // Measure and Explode exclude each other: Measure's points are where the
  // bodies are, not where Explode draws them
  // (told, not kept on the ready line, which stayed with Measure back on: r47 A6; read out too -- its
  // reason reached no screen reader, Measure saying only "measure off": r48 Q8)
  if (on && app.measure && app.measure.on) {
    app.measure.setOn(false);
    tell('Measure is off while exploded: it measures the parts where they are, not where Explode draws them', 6000);
  }
  // (Paint picks the faces where they are: off while exploded)
  if (on && app.paintFaces) setPaint(false);
  // a view as Fit left it is fitted again, around the parts where they go
  const fitted = atLastFit();
  x.on = on;
  if (on && (x.for !== app.header || !x.dirs)) {
    x.flat = flatTree();
    const upAxis = 'xyz'[orientUp(app.cam.orient).findIndex((v) => v !== 0)];
    setExplodeMode(x.flat ? upAxis : 'assembly');
  } else {
    syncExplodeSphere();
    syncExplodeRow();
    viewChanged();
  }
  if (fitted) fitTo(drawnBox(null));
  announce(on ? `exploded ${Math.round(x.t * 100)} %` : 'explode off');
  // (off: the focus goes to the button, or to the menu it is folded into)
  if (focus) (on ? $('xpoff') : toolFocus('explode')).focus();
}

function syncExplodeRow() {
  const x = app.explode;
  $('xpopt').hidden = !x.on;
  $('explode').setAttribute('aria-pressed', String(x.on));
  $('explode').hidden = !app.renderer;
  $('explode').disabled = !app.header;
  for (const b of $('xpmode').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === x.mode));
  $('xpmode').querySelector('[data-mode="assembly"]').textContent = x.flat ? 'Radial (flat file)' : 'Assembly';
  $('xppos').value = String(Math.round(x.t * 100));
  $('xpval').textContent = `${Math.round(x.t * 100)} %`;
  $('xppos').setAttribute('aria-valuetext', `${Math.round(x.t * 100)} %`);
  syncOptbar();
}

async function syncEdges(r, mesh) {
  const v = mesh.edgeInfo?.value;
  // (the instances keyed on the arrays they were made from, not the mesh alone: a file's edges drawn
  // while its facts are built, then the build's, uploaded the file's only -- r40 A1)
  let data = edgeData.get(mesh);
  const same = data && data.from === v?.edges && data.fromSil === v?.silhouettes;
  if (!r.canDrawEdges || !v || (r.edgesFor === mesh && same)) return;
  // the body table, for the cull of bodies too small to show edges. A table
  // the GPU will not hold costs the cull, never the model: no throw from here
  try {
    if (r.bodiesFor !== mesh) r.setBodies(mesh, bodiesWithExplode(mesh));
  } catch (e) {
    app.edgeError = String(e.message || e);
  }
  if (!same) {
    // the silhouettes too, so a change to an outline style needs no upload
    data = { from: v.edges, fromSil: v.silhouettes, edges: edgeInstances(mesh, v.edges),
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
  recoveryStarts(why);
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
      recovered();
    }, (e) => {
      if (app.renderer !== r) return; // superseded by a further recovery
      // r died too: the GPU, not the model, is the problem, and the recovery
      // that follows (or giveUp) owns the status line
      if (isDead(r)) return;
      app.error = String(e.message || e);
      // the renderer is live; it is the model that does not fit (e.g. after
      // falling back to a smaller backend)
      cannotHold();
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
// passes (js/styles.js edgePasses)
const PAPER_RGB = rgb(PAPER);
const FILL_RGB = rgb(CUT_FILL);
// light: drawn on a light ground (the Light background option, or a white or
// transparent picture)
function styleFrame(s, scale, light = false) {
  const passes = edgePasses(s.id, { scale, onLight: light || app.lightBg });
  return { background: s.paper || app.lightBg ? PAPER_RGB : BG, style: { faces: s.faces, faceAlpha: s.faceAlpha ?? 1, outline: s.outline && app.showSilhouettes }, edgePasses: passes,
    fill: s.faces === 'depth' ? FILL_RGB : null,
    // a body too small to draw edges is collapsed in the face and pick passes too
    cullFaces: !!s.paper };
}

// pic (a picture's tile, renderPicture): { W, H, x0, y0, tw, th, scale } --
// the whole picture's size in px, this tile's place in it, and px per CSS
// px. The projection is the whole picture's, cropped to the tile, so every
// screen-space value (edge width, the 6 px cull) is in picture px and
// nothing jumps at a seam.
function frameState(pic = null) {
  const c = app.cam;
  const r = app.renderer;
  const d = camDir(c);
  const eye = eyeOf(c, app.sphere);
  const view = lookAt(eye, c.target, camUp(c));
  const w = pic ? pic.W : r.canvas.width || 1, h = pic ? pic.H : r.canvas.height || 1;
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
  // a tile: clip x' = sx x + tx w, y' = sy y + ty w maps the tile's part of
  // the picture onto the whole clip square (column-major)
  let vp = multiply(proj, view);
  if (pic) {
    const sx = pic.W / pic.tw, sy = pic.H / pic.th;
    const tx = (pic.W - 2 * pic.x0 - pic.tw) / pic.tw, ty = -(pic.H - 2 * pic.y0 - pic.th) / pic.th;
    vp = multiply([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1], vp);
  }
  const ps = pic ? pic.scale : pxScale(r);
  return {
    viewProj: vp, eye: eye4, light, up, clip: sectionPlane(), highlight: [...HIGHLIGHT, app.selected.size ? 1 : 0],
    ...styleFrame(currentStyle(), ps, !!(pic && pic.light)),
    // the face boundaries over the shaded faces, in device px: the canvas's
    // own scale, not devicePixelRatio, which the canvas size caps
    edges: app.showEdges && currentStyle().edges ? { widthPx: EDGE_PX * ps, hoverPx: EDGE_HOVER_PX * ps, minPx: app.edgeMinPx * ps } : null,
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
    // Explode: the fraction of each body's direction (the body table) it moves
    explode: app.explode.on && app.explode.for === app.header ? app.explode.t : 0,
    // the hidden parts drawn faintly (a style with faces only)
    // (or a tour step that dims the rest as ghosts)
    ghost: (app.ghostHidden || app.tourGhost) && app.hidden.size && currentStyle().faces !== 'none' ? GHOST_ALPHA : 0,
    ground: groundShadow(),
    // a picture's own background (white; black then white for transparent)
    ...(pic && pic.bg ? { background: pic.bg } : {}),
  };
}

// The model's X, Y and Z (the file's own axes) in a corner of the view,
// turned as the camera is: each axis drawn from the middle toward where it
// points on screen, the ones pointing away from the viewer dimmer and drawn
// first, so which way is which reads at a glance after any orbit (feature
// review item 16)
const TRIAD = [['X', [1, 0, 0], '#ff5c5c'], ['Y', [0, 1, 0], '#5fd35f'], ['Z', [0, 0, 1], '#5f9dff']];
function drawTriad() {
  const svg = $('triad');
  // (an <svg> has no hidden property, only the attribute)
  const off = !app.header || app.embed;
  svg.toggleAttribute('hidden', off);
  if (off) return;
  const c = app.cam;
  const view = lookAt([0, 0, 0], camDir(c).map((v) => -v), camUp(c));
  const right = [view[0], view[4], view[8]], up = [view[1], view[5], view[9]], toward = camDir(c);
  const ax = TRIAD.map(([n, a, col]) => ({ n, col, x: a[0] * right[0] + a[1] * right[1] + a[2] * right[2],
    y: -(a[0] * up[0] + a[1] * up[1] + a[2] * up[2]), z: a[0] * toward[0] + a[1] * toward[1] + a[2] * toward[2] }));
  ax.sort((p, q) => p.z - q.z); // the far ones first
  const R = 24;
  const ns = 'http://www.w3.org/2000/svg';
  svg.replaceChildren();
  for (const a of ax) {
    const op = a.z < -0.05 ? 0.45 : 1;
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', 0); l.setAttribute('y1', 0);
    l.setAttribute('x2', (a.x * R).toFixed(1)); l.setAttribute('y2', (a.y * R).toFixed(1));
    l.setAttribute('stroke', a.col); l.setAttribute('opacity', op);
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', (a.x * (R + 8)).toFixed(1)); t.setAttribute('y', (a.y * (R + 8)).toFixed(1));
    t.setAttribute('fill', a.col); t.setAttribute('opacity', op);
    t.textContent = a.n;
    svg.append(l, t);
  }
}

// The view as Measure needs it (js/measure-ui.js): the frame's matrices for
// the stage's CSS size, and the camera's axes
function measureView() {
  const c = app.cam;
  const box = $('stage');
  const w = Math.max(1, box.clientWidth), h = Math.max(1, box.clientHeight);
  const eye = eyeOf(c, app.sphere);
  const view = lookAt(eye, c.target, camUp(c));
  const [near, far] = nearFar(c, app.sphere);
  const tv = Math.tan(c.fov / 2);
  const proj = c.ortho ? ortho(c.dist * tv * (w / h), c.dist * tv, near, far, false) : perspective(c.fov, w / h, near, far, false);
  return { vp: multiply(proj, view), eye, dir: camDir(c), right: [view[0], view[4], view[8]], up: [view[1], view[5], view[9]],
    ortho: !!c.ortho, tanV: tv, w, h, target: c.target, dist: c.dist };
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
  const { min, max } = sectionBox();
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

// Where the camera goes to frame bbox seen with orientation q, for the stage
// as it is now: -> { target, dist, bar }. The box as this view sees it
// (js/camera.js fitBox), not its bounding sphere: the portrait Iso of a board
// needs it. `cover` px at the bottom of the view are covered (the options
// bar, a tour's caption card): fit in the part above them (a narrower
// vertical angle, the same width), and centre there by moving the target down
// by half of them, so the model sits above.
function fitPose(bbox, q, margin = 1.05, cover = optbarHeight()) {
  const c = { ...app.cam, q };
  const box = $('stage');
  const h = Math.max(1, box.clientHeight);
  const bar = Math.max(0, Math.min(cover, h - 1));
  const vis = h - bar;
  const f = fitBox(c, bbox, 2 * Math.atan(Math.tan(c.fov / 2) * vis / h), box.clientWidth / vis, margin);
  let target = f.target;
  if (bar > 0) {
    const perPx = (2 * f.dist * Math.tan(c.fov / 2)) / h; // world units per CSS px at the target
    const up = camUp(c);
    target = target.map((v, k) => v - up[k] * (bar / 2) * perPx);
  }
  return { target, dist: f.dist, bar };
}

function fitTo(bbox) {
  if (!bbox) return;
  const c = app.cam;
  const s = sphereOf(bbox);
  // the zoom's limits follow the sphere: what is framed, whatever the view
  c.viewRadius = s.radius;
  // the header as it will be drawn: a row that a load's changes made wrap
  // is refolded by an observer only after this task, so the stage measured
  // here was the two-line header's, and the view, back at its own size by
  // the next frame, never reported a change (a tour's first step framed for
  // 980 x 729 in a 980 x 761 view). Only a WRAPPING row: the narrow one
  // scrolls, never changes the header's height, and may overflow on purpose
  // (a refold on every Fit there reset its scroll and could move the focus)
  const tb = $('tb');
  if (getComputedStyle(tb).flexWrap !== 'nowrap' && !toolbarFits(tb)) refold();
  const box = $('stage');
  const h = Math.max(1, box.clientHeight);
  const aspect = box.clientWidth / h;
  const { target, dist, bar } = fitPose(bbox, c.q);
  c.dist = dist;
  c.target = target;
  // what this fit framed, so the options bar coming or going can frame it
  // again while the view is untouched (syncOptbar)
  app.lastFit = { bbox, q: c.q, dist: c.dist, target: c.target.slice(), bar };
  // this fit is for the stage as it is NOW: the resize refit must measure
  // later aspect changes from here, or a layout change in the same task
  // (the parts drawer growing as a load fills the tree) is applied twice
  app.stageAspect = aspect;
  viewChanged();
}

const VIEWS = VIEW_PRESETS; // (js/orient.js: the one table of named views)

// Number-key views (Blender's numpad layout): 1 front, 3 right, 7 top,
// 0 iso, 5 Ortho on/off, 9 the opposite of the preset nearest the view.
// (from the one table of views, js/orient.js VIEWS)
const VIEW_KEYS = { ...Object.fromEntries(VIEW_ROWS.filter((v) => v.key).map((v) => [v.key, v.id])), 5: 'ortho', 9: 'opposite' };
const OPPOSITE = Object.fromEntries(VIEW_ROWS.filter((v) => v.opposite).map((v) => [v.id, v.opposite]));
const VIEW_NAMES = Object.fromEntries(VIEW_ROWS.map((v) => [v.id, v.name]));

// The View presets and the Export as buttons, built from their tables (js/orient.js VIEWS,
// js/export-mesh.js EXPORTS) into index.html's empty groups, before anything wires them
for (const v of VIEW_ROWS) {
  const b = document.createElement('button');
  b.dataset.view = v.id;
  b.textContent = v.name;
  if (v.key) {
    b.title = `${v.name} view (${v.key})`;
    b.setAttribute('aria-keyshortcuts', v.key);
    const k = document.createElement('kbd');
    k.textContent = v.key;
    b.append(k);
  }
  document.querySelector('.presets').append(b);
  // and its key in the ? box, before "the opposite side"
  if (v.key) {
    const dt = document.createElement('dt');
    const k = document.createElement('kbd');
    k.textContent = v.key;
    dt.append(k);
    const dd = document.createElement('dd');
    dd.textContent = v.name;
    $('viewkeys').insertBefore(dt, $('viewkey9'));
    $('viewkeys').insertBefore(dd, $('viewkey9'));
  }
}
for (const [fmt, x] of Object.entries(EXPORTS)) {
  const b = document.createElement('button');
  b.dataset.fmt = fmt;
  b.disabled = true;
  b.title = `${x.label}: ${x.about}`;
  b.textContent = x.label;
  $('exportmesh').append(b);
}

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
  tell(name, 1500, `${name} view`);
}

// A short note where the hovered part's name goes, for 1.5 s (or ms; or until
// the next hover replaces it)
// (a note of 4 s or more -- a failure, a link's note, the touch hint -- holds the line for its time:
// the next part under the pointer or a tap erased it, never to come back -- r46 Q5)
// (a note's end puts back the last label a view handed hoverLabel -- the 3D part under the pointer
// or the 2D view's layer or snap: it read app.hover, 3D only, and a drawing's label, sent once on a
// change, never came back -- r47 A3, Q5)
let noteHeldUntil = 0, lastLabel = '';
function flashHover(text, ms = 1500) {
  const hov = $('hover');
  hov.textContent = text;
  noteHeldUntil = ms >= 4000 ? performance.now() + ms : 0;
  clearTimeout(viewNameTimer);
  viewNameTimer = setTimeout(() => { noteHeldUntil = 0; if (hov.textContent === text) hov.textContent = lastLabel; }, ms);
}
// the hover line's label (a part's name, a layer, a snap), unless a note holds it -- kept for the
// note's end; `asked`: a tap that asks for the name, shown through a hold (it was swallowed under
// the touch hint that says "tap names a part": r47 Q5)
// (a tap on the background asks for nothing: it no longer erases a held note -- r48 A8; a tap
// while the touch hint shows has followed it: the hint counted as seen -- r48 Q9)
function hoverLabel(text, asked = false) {
  lastLabel = text;
  if (asked && text && $('hover').textContent === TOUCH_HINT) setPref('cadv.touchHint', '1');
  if (!(asked && text) && performance.now() < noteHeldUntil) return;
  noteHeldUntil = 0;
  $('hover').textContent = text;
}
// the hover line emptied, a note's hold and the last label with it (a model or drawing left)
function clearHover() {
  noteHeldUntil = 0;
  lastLabel = '';
  $('hover').textContent = '';
}

// The first model this browser shows on a touch-only screen: the gestures,
// where they can be seen. Their help sits in the parts panel, which a phone
// keeps closed, so a first visitor saw none of it (feature review
// 2026-10-29). Once per browser; a note already showing (a view link's) wins.
const TOUCH_HINT = 'one finger turns · two pinch and pan · tap names a part · ☰ for parts';
function touchHintOnce() {
  if (app.embed || !coarseOnly() || $('hover').textContent) return; // (embedded: its own hint)
  // (storage off: shown every time, which is harmless)
  if (getPref('cadv.touchHint')) return;
  tell(TOUCH_HINT, 6000);
  // (counted as seen only if it held its time: a 6 s note right after the load replaced it, and it
  // was recorded as shown and never came back -- r47 Q7)
  setTimeout(() => { if ($('hover').textContent === TOUCH_HINT) setPref('cadv.touchHint', '1'); }, 5000);
}

// ---------- view links (js/view-link.js) ----------

// the view as js/view-link.js encodes it
function currentView() {
  const c = app.cam;
  return {
    // (copies, never the live objects: a view kept -- a tour's starting view, put back as it
    // ends -- must not change as the viewer moves on)
    cam: { target: [...c.target], dist: c.dist, q: [...camQ(c)], ortho: !!c.ortho, orient: c.orient },
    // always the style shown, the default too: a link without one opens in
    // the recipient's remembered style, not the view that was shared
    style: currentStyle().id,
    aspect: stageAspectNow(), // (a link opened on another shape is reframed)
    section: { ...app.section }, hidden: [...app.hidden], selected: [...app.selected],
    // Explode: how far and how, while it is on for this model
    explode: app.explode.on && app.explode.for === app.header ? { t: app.explode.t, mode: app.explode.mode } : null,
    keys: app.bodyKeys,
    notes: app.measure ? app.measure.notes() : [],
  };
}

// a decoded view onto the loaded model; ids past its bodies are dropped
// link: a view link being opened (its selected part is named on arrival)
function applyView(v, link = false) {
  if (!app.header) return;
  // the bodies it names: by id while the model is the one the link was made
  // on, else the selection by name (js/view-link.js resolveBodies)
  const bodies = resolveBodies(v, app.bodyKeys || app.header.meshes.map((m) => m.name));
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
  // (the Section button's axis -- last -- is only ever a real axis: set to "off" it turned the
  // button into one that does nothing)
  if (v.section) Object.assign(app.section, v.section, v.section.axis !== 'off' ? { last: v.section.axis } : {});
  else if (v.cam) app.section.axis = 'off';
  if (v.hidden || v.cam) { app.hidden = new Set(bodies.hidden); syncTreeChecks(); }
  // Explode as the link has it (a whole link without it: off), how far
  // first, then on, then how
  if (v.explode && app.renderer) {
    app.explode.t = v.explode.t;
    setExplode(true);
    if (app.explode.on && app.explode.mode !== v.explode.mode) setExplodeMode(v.explode.mode);
    syncExplodeRow();
  } else if (v.cam && app.explode.on) setExplode(false);
  select(bodies.selected, false);
  // A view made on another shape (a desktop link opened on a phone): its
  // selected parts framed afresh from the same side, with room around them,
  // or with nothing selected, as far out as keeps all the link showed in
  // view (its camera alone cut the part off at the edge of a narrow screen:
  // UI organization review, features rank 1)
  const a1 = stageAspectNow();
  if (v.cam && v.aspect > 0 && Math.abs(a1 / v.aspect - 1) > 0.05) {
    const c = app.cam;
    const box = bodies.selected.length ? drawnBox(bodies.selected) : null;
    if (box) {
      const f = fitPose(box, c.q, 2.2);
      c.target = f.target;
      c.dist = f.dist;
    } else c.dist *= Math.max(1, v.aspect / a1);
    c.viewRadius = Math.min(app.sphere.radius, c.dist / fitDistance(1, c.fov, a1));
  }
  // its notes (a link with none leaves the notes there are)
  if (v.notes && app.measure) app.measure.setNotes(v.notes);
  updateButtons();
  viewChanged();
  // the part a link points at, named as it opens (on a phone the info panel
  // is in the closed drawer)
  if (link && bodies.selected.length && !bodies.changed) {
    const ids = bodies.selected;
    const name = ids.length === 1 ? meshLabel(ids[0]) : `${ids.length} parts`;
    tell(`linked: ${name}`, 4000, `the link points at ${name}`);
  }
  if (bodies.changed) {
    const note = `this model has changed since the link was made: ${v.selNames?.length
      ? `${bodies.selected.length} of ${v.selNames.length} selected parts found by name` : 'its parts are not selected'}${v.hidden?.length ? ', hidden parts not applied' : ''}`;
    tell(note, 6000);
  }
}

app.exportMesh = (fmt) => exportMesh(fmt); // (for tests/ui-checks.py)
// (for tests/ui-checks.py tour-leaves-no-state: a tour from an object, the tour maker's capture,
// a load from a URL without leaving the page)
// (both through the page's one start, startTourIn: an arm that took startTour tested a path the page never takes)
app.playTour = (t) => startTourIn(parseTour(JSON.stringify(t), location.href), null);
app.playTourIn = app.playTour;
app.captureStep = (o) => captureStep(o);
app.openUrl = (u) => loadUrl(u);
// Export the parts shown (not hidden) as STL, 3MF or GLB (js/export-mesh.js),
// in their drawn colours, turned the way the model opens: Z up for STL and
// 3MF (a printer's convention), Y up for GLB (glTF's)
// A saved file's name from the model's: its .gz, then its extension, off ("board.stp.gz" ->
// "board"). The one rule for exports and Save .cadmesh (which named it "board.stp.cadmesh")
// (a scene of several models, "a.stp + b.stl": each name's base, joined -- "a.stp + b" before)
const saveBase = (name) => (name || 'model').split(' + ').map((n) => n.replace(/\.gz$/i, '').replace(/\.[^.]+$/, '')).filter(Boolean).join('+') || 'model';
// a picture's name: the model's or the drawing's, and when it was taken (a drawing's had its own
// rule, no time and its .gz kept)
function pictureName(source) {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${saveBase(source)}-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}.png`;
}
// Whether body mi (0-based) of a mesh is closed: the facts' flag, and not closed while the facts are
// not known (the edges worker still working, or failed) -- what the view draws then (no cut face).
// The one answer for the view's cut fill, Measure's cut-face point and clearance's containment (the
// three answered three ways while the facts were absent)
function closedOf(mesh, mi) {
  const c = mesh?.edgeInfo?.value?.facts?.closed;
  return c ? !!c[mi] : false;
}
async function exportMesh(fmt) {
  if (!app.header || !EXPORTS[fmt]) return;
  const model = { ...app.baseMesh, color: app.mesh.color };
  // (the bodies shown that have a triangle: what is written, counted and said -- js/export-mesh.js)
  const ids = exportable(model, app.header.meshes.map((_, i) => i + 1).filter((id) => !app.hidden.has(id)));
  if (!ids.length) { tell(NOTHING_TO_EXPORT); return; }
  const names = ids.map((id) => meshLabel(id));
  const base = saveBase(app.sourceName);
  // (its progress and its end through tellReady, the one guard of the ready line: told always,
  // written only while ready -- its own two setStatus('ready') turned a load, its "convert it?"
  // question or a GPU recovery to 'ready' under it: r47 A1, Q2; told, as a ready-to-ready line is
  // not heard: r46 A6)
  tellReady(`exporting ${fmtInt(ids.length)} ${ids.length === 1 ? 'body' : 'bodies'} as ${fmt.toUpperCase()}…`, 4000);
  await new Promise((r) => setTimeout(r, 0)); // the note paints first
  let bytes;
  try {
    bytes = await EXPORTS[fmt].write(model, ids, exportBasis(app.cam.orient, EXPORTS[fmt].up), { names, base });
  } catch (e) {
    // (on the ready line and told: shown 1.5 s and never heard, the export's failure reached a
    // screen reader as "ready" -- r45 Q1, A1)
    tellReady(`export failed: ${e.message || e}`);
    return;
  }
  const name = `${base}.${fmt}`;
  downloadBlob(new Blob([bytes], { type: EXPORTS[fmt].type }), name);
  app.lastExport = { fmt, bytes: bytes.length, bodies: ids.length, name }; // (for tests)
  tellReady(`saved ${name}: ${fmtInt(ids.length)} ${ids.length === 1 ? 'body' : 'bodies'}, ${(bytes.length / 1048576).toFixed(1)} MB`, 3000);
}

// Save picture (P): the view as a PNG at the picture options' size and
// background (renderPicture: in tiles, capped at 8192 px and 16.7 Mpx),
// hover left out, the selection unless the options include it, with
// Measure's results and the hole table's markers drawn in.
// print: the picture printed (File > Print) instead of saved
async function savePicture(print = false) {
  // a drawing: its canvas as it is drawn
  if (app.dxf) {
    const blob = await new Promise((res) => $('view2d').toBlob(res, 'image/png'));
    if (!blob) return;
    if (print) return printPng(blob);
    const name = pictureName(app.dxf.name);
    downloadBlob(blob, name);
    tell(`saved ${name}`, 3000);
    return;
  }
  if (!app.header || !app.renderer) return;
  const pic = await renderPicture();
  if (!pic) { tell('the picture could not be read from the GPU', 4000); return; }
  const out = pic.canvas;
  const png = await new Promise((ok) => out.toBlob(ok, 'image/png'));
  if (print) return printPng(png);
  const name = pictureName(app.sourceName);
  const save = () => {
    const url = downloadBlob(png, name);
    app.lastPicture = { name, width: out.width, height: out.height, url, cssW: pic.cssW, cssH: pic.cssH, tiles: pic.tiles, capped: pic.capped }; // (for tests)
    // (a size the view has grown too big for saves at the largest allowed)
    tell(`saved ${name}, ${out.width} × ${out.height}${pic.capped ? ` (the largest a picture of this view can be at ${app.pic.scale}×)` : ''}`, 3000);
  };
  // A touch-only device: the render has used up the tap's gesture, and the
  // share sheet needs a fresh one, so "Picture ready: Share / Save" waits 8 s
  // for a tap of its own (Share only where files can be shared)
  if (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches) {
    const file = new File([png], name, { type: 'image/png' });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const toast = $('pictoast');
    const done = () => { toast.hidden = true; clearTimeout(app.picToastTimer); };
    $('picshare').hidden = !canShare;
    $('picshare').onclick = () => { done(); navigator.share({ files: [file], title: name }).catch(() => {}); };
    $('picsave').onclick = () => { done(); save(); };
    toast.hidden = false;
    clearTimeout(app.picToastTimer);
    app.picToastTimer = setTimeout(done, 8000);
    announce(`picture ready: ${canShare ? 'share or ' : ''}save it`);
    return;
  }
  save();
}

// The view rendered at twice its size (less where the GPU or memory cannot),
// without the hover and selection highlights, Measure's results painted in:
// -> { canvas, scale, cssW, cssH } or null when the GPU gave nothing back.
// Save picture and a tour's pictures use it.
// The picture's size: N x the view's CSS size, capped at 8192 px on the long
// side and 16.7 Mpx -> { s, W, H, capped }
const PIC_LONG = 8192, PIC_AREA = 16.7e6, TILE = 2048;
function pictureSize(n, cw, ch) {
  const s = Math.min(n, PIC_LONG / Math.max(cw, ch), Math.sqrt(PIC_AREA / (cw * ch)));
  return { s, W: Math.max(1, Math.round(cw * s)), H: Math.max(1, Math.round(ch * s)), capped: s < n - 1e-9 };
}

// The options group shown or not (▾), its buttons in step with app.pic: a
// size the view is too big for is greyed, its tooltip giving the limit
function setPicOpts(open) {
  $('picopts').hidden = !open;
  $('picmore').setAttribute('aria-expanded', String(open));
  if (open) syncPicOpts();
}
function syncPicOpts() {
  const box = $('stage');
  const cw = Math.max(1, box.clientWidth), ch = Math.max(1, box.clientHeight);
  for (const b of $('picopts').querySelectorAll('[data-scale]')) {
    const n = Number(b.dataset.scale), sz = pictureSize(n, cw, ch);
    b.setAttribute('aria-pressed', String(app.pic.scale === n));
    b.setAttribute('aria-disabled', String(sz.capped));
    b.title = sz.capped ? `this view is too big for ${n}×: a picture is at most ${PIC_LONG} px long and ${PIC_AREA / 1e6} Mpx (it would save at ${sz.W} × ${sz.H})`
      : `${sz.W} × ${sz.H} px`;
  }
  for (const b of $('picopts').querySelectorAll('[data-bg]')) b.setAttribute('aria-pressed', String(app.pic.bg === b.dataset.bg));
  $('picbgview').textContent = currentStyle().paper || app.lightBg ? 'view (paper)' : 'view';
  $('picsel').setAttribute('aria-pressed', String(app.pic.sel));
}
function savePicOpts() {
  setPrefJSON('cadv.pic', app.pic);
  syncPicOpts();
}

// Copy image: the picture to the clipboard. The ClipboardItem is made in the
// click's own task with a promise for the PNG, so the clipboard still takes
// it when the render finishes.
function copyPicture() {
  if (!app.header || !app.renderer) return;
  const png = renderPicture().then((pic) => {
    if (!pic) throw new Error('the picture could not be read from the GPU');
    return new Promise((ok) => pic.canvas.toBlob(ok, 'image/png'));
  });
  navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(
    () => tell('picture copied', 3000),
    (e) => tell(`the picture could not be copied: ${e.message || e}`, 4000));
}

// The picture options (File > Save picture ▾), remembered in this browser:
// scale 1 | 2 | 4, bg 'view' | 'white' | 'transparent', sel (draw the
// selection as selected)
app.pic = { scale: 2, bg: 'view', sel: false };
{
  const p = getPrefJSON('cadv.pic');
  if (p && [1, 2, 4].includes(p.scale)) app.pic.scale = p.scale;
  if (p && ['view', 'white', 'transparent'].includes(p.bg)) app.pic.bg = p.bg;
  if (p && typeof p.sel === 'boolean') app.pic.sel = p.sel;
}

// The view rendered at app.pic.scale x its CSS size, in tiles of at most
// 2048 px: each tile is the whole picture's projection cropped to it
// (frameState's pic), drawn on the view's own canvas at the tile's size and
// copied into the picture in the same task, before the browser presents or
// clears the canvas. Hover is always left out, the selection unless
// app.pic.sel. Background: the view's, white, or transparent -- each tile
// drawn on black and on white (the canvas has no alpha), alpha = 1 - (white
// - black), colour = black / alpha, so antialiased edges and X-ray come out
// partly transparent. -> { canvas, scale, cssW, cssH, tiles, capped } or
// null when the GPU could not give a tile its size.
async function renderPicture(opts = app.pic) {
  const r = app.renderer, box = $('stage');
  const cw = Math.max(1, box.clientWidth), ch = Math.max(1, box.clientHeight);
  const { s, W, H, capped } = pictureSize(opts.scale || 2, cw, ch);
  const T = Math.min(TILE, r.maxCanvasSize || 4096);
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const out = canvas(W, H);
  const ctx = out.getContext('2d');
  // transparent: the white pass's picture beside the black one in `out`
  const clear = opts.bg === 'transparent';
  const onWhite = clear ? canvas(W, H) : null;
  const wctx = onWhite && onWhite.getContext('2d');
  const passes = clear ? [[0, 0, 0], [1, 1, 1]] : [opts.bg === 'white' ? [1, 1, 1] : null];
  // hover is of the moment; the selection's tint too, unless asked for
  const hov = app.hover;
  const sel = [...app.selected];
  app.hover = 0;
  if (!opts.sel) app.selected.clear();
  pushState();
  let ok = true, tiles = 0;
  try {
    for (let y0 = 0; y0 < H && ok; y0 += T) {
      for (let x0 = 0; x0 < W && ok; x0 += T) {
        const tw = Math.min(T, W - x0), th = Math.min(T, H - y0);
        r.resize(tw, th);
        // (a drawing buffer smaller than asked would stretch the tile)
        if (r.canvas.width !== tw || r.canvas.height !== th) { ok = false; break; }
        passes.forEach((bg, i) => {
          r.render(frameState({ W, H, x0, y0, tw, th, scale: s, bg, light: opts.bg !== 'view' }));
          (i ? wctx : ctx).drawImage(r.canvas, 0, 0, tw, th, x0, y0, tw, th);
        });
        tiles++;
      }
    }
  } catch {
    ok = false;
  } finally {
    app.hover = hov;
    for (const id of sel) app.selected.add(id);
    pushState();
    resize(); // its own size again (r.requested differs now)
    app.viewGen++;
    queueFrame();
  }
  if (!ok) return null;
  if (clear) {
    const b = ctx.getImageData(0, 0, W, H), w = wctx.getImageData(0, 0, W, H).data, d = b.data;
    for (let i = 0; i < d.length; i += 4) {
      // the coverage each channel shows, averaged; colour un-blended from black
      const a = 1 - ((w[i] - d[i]) + (w[i + 1] - d[i + 1]) + (w[i + 2] - d[i + 2])) / 765;
      if (a <= 1 / 255) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; continue; }
      d[i] = Math.min(255, d[i] / a); d[i + 1] = Math.min(255, d[i + 1] / a); d[i + 2] = Math.min(255, d[i + 2] / a);
      d[i + 3] = Math.round(a * 255);
    }
    ctx.putImageData(b, 0, 0);
  }
  // Measure's chips: the light palette on a light picture (paper, white,
  // transparent: a page it lands on is most often light)
  app.measure.paint(ctx, s, !!currentStyle().paper || opts.bg !== 'view');
  return { canvas: out, scale: s, cssW: cw, cssH: ch, tiles, capped };
}

// The copies of body `id` (1-based ids, itself included): the same name, the
// same triangle count and the same size to 1 µm (a copy turned is still the
// same size on some axis order: the sizes are compared sorted)
function sameParts(id) {
  const ms = app.header.meshes;
  const key = (m) => {
    const s = m.bbox ? [0, 1, 2].map((k) => Math.round((m.bbox.max[k] - m.bbox.min[k]) * 1000)).sort((a, b) => a - b).join(',') : '';
    return `${m.name}\u0000${m.idxCount}\u0000${s}`;
  };
  const want = key(ms[id - 1]);
  const out = [];
  ms.forEach((m, i) => { if (key(m) === want) out.push(i + 1); });
  return out;
}
const instancesOf = (id) => sameParts(id).length;
app.sameParts = sameParts; // (for tests)
app.select = (ids) => select(ids, false); // (for tests: a selection as a click makes it)

// Per-face paint (feature review item 24): Paint beside the part colour turns
// it on; a click paints the clicked b-rep face in the swatch's colour (kept
// while this model is open; Reset with nothing selected clears it too)
app.faceOverrides = new Map();
function setPaint(on) {
  // (one click mode at a time; Paint picks the faces where they are, so not
  // while exploded)
  // (not while a tour plays: no step holds face colours, and they are set aside meanwhile -- refused
  // first, before it turns Measure or the step's Explode off for nothing)
  if (on && app.tour) { tell('Paint is off while a tour plays: a tour step holds no face colours', 3000); on = false; }
  if (on && app.measure && app.measure.on) app.measure.setOn(false);
  if (on && app.explode.on) setExplode(false);
  app.paintFaces = on && !!(app.baseMesh && app.baseMesh.faces);
  $('paintbtn').setAttribute('aria-pressed', String(app.paintFaces));
  if (on && !app.paintFaces) tell('this model has no b-rep faces to paint', 3000);
  else if (on) tell('Paint: click a face to paint it in the swatch\'s colour', 3000);
  updateButtons();
}
function paintFace(f) {
  app.faceOverrides.set(f, hexToRgb($('partcolour').value));
  updateButtons();
  recolour(`face painted`);
}

// File > Print (feature review item 24): the picture Save picture makes, alone
// on the page (print CSS shows only #printimg), with the model's name under it
async function printPng(png) {
  const img = $('printimg');
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(png);
  await img.decode().catch(() => {});
  $('printname').textContent = app.dxf ? app.dxf.name : app.sourceName || '';
  app.lastPrint = { width: img.naturalWidth, height: img.naturalHeight }; // (for tests)
  if (!app.noPrintDialog) window.print();
}

// Save drawing (SVG): the selected parts (else every one shown) at 1:1 in mm,
// straight along the preset view nearest the camera's (Top, Front, …): their
// b-rep edges, holes as true circles (js/drawing-svg.js). Every edge of the
// parts is drawn, hidden ones too: a board alone gives its outline and holes.
function saveDrawing() {
  if (!app.header || !app.baseMesh?.faces) return;
  const ids = app.selected.size ? [...app.selected] : app.header.meshes.map((_, i) => i + 1).filter((id) => !app.hidden.has(id));
  if (!ids.length) { tell('nothing shown to draw'); return; }
  const preset = nearestPreset(app.cam);
  const [yaw, pitch] = VIEWS[preset];
  const c = { q: presetQuat(yaw, pitch, app.cam.orient) };
  const view = lookAt([0, 0, 0], camDir(c).map((v) => -v), camUp(c));
  const right = [view[0], view[4], view[8]], up = [view[1], view[5], view[9]];
  const parts = ids.map((id) => ({ id: `body-${id}`, name: meshLabel(id), geom: app.measure.geometry(id - 1) }));
  const base = saveBase(app.sourceName);
  const label = $('model').querySelector('.mname')?.textContent || base;
  const d = drawingSVG(parts, right, up, {
    title: `${label}: ${VIEW_NAMES[preset]} view, 1:1, mm${app.selected.size ? ` (${fmtInt(ids.length)} selected ${ids.length === 1 ? 'part' : 'parts'})` : ''}` });
  const name = `${base}-${VIEW_NAMES[preset].toLowerCase()}.svg`;
  downloadBlob(new Blob([d.svg], { type: 'image/svg+xml' }), name);
  app.lastDrawing = { name, preset, width: d.width, height: d.height, lines: d.lines, circles: d.circles, svg: d.svg }; // (for tests)
  tell(`saved ${name}: ${VIEW_NAMES[preset]} view, ${d.width.toFixed(1)} × ${d.height.toFixed(1)} mm`, 3000);
}

// The model in the address, one way only: with a ?list=, a model the list
// names is ?model=<its id> when its entry has one (a name that survives the
// list's reordering), else ?index=<n>, its place in the list (1 = its first
// model); any other model is ?src=<its URL>. So ?src always means a URL.
const MODEL_PARAMS = ['model', 'index', 'src'];
function setModelParam(u, url) {
  const list = url && params.getAll('list').length ? app.listEntries || [] : [];
  const i = list.findIndex((e) => e.url === url);
  for (const k of MODEL_PARAMS) u.searchParams.delete(k);
  u.searchParams.delete('unit'); // (another model, or the same named again: read as it reads)
  if (i >= 0 && list[i].id) u.searchParams.set('model', list[i].id);
  else if (i >= 0) u.searchParams.set('index', String(i + 1));
  else if (url) u.searchParams.set('src', url);
}
// ...and back, from an address's query: the URL of the model it names, by this page's lists
// (js/model-list.js modelUrlFrom, the rule js/early.js reads the address by too)
function modelUrlIn(search) {
  return modelUrlFrom(search, params.getAll('list'), app.listEntries, location.href);
}
// (what an address names by the list, which must be read before it opens)
const modelNameIn = (search) => modelNameFrom(search, params.getAll('list'));

// A link to this model at this view, in the full viewer (never ?embed=)
function viewLink() {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  // the model lists too, in their order, so the link keeps the drop-down
  for (const l of params.getAll('list')) u.searchParams.append('list', l);
  if (app.sourceUrl) setModelParam(u, app.sourceUrl);
  if (app.sourceUrl && readUnit() !== 'mm') u.searchParams.set('unit', readUnit());
  // the added models opened from a URL, and where they were moved to
  for (const m of linkAdds().carried) {
    u.searchParams.append('add', m.url);
    u.searchParams.append('addat', m.offset.map((o) => +o.toFixed(4)).join(','));
  }
  for (const k of ['backend']) if (params.get(k)) u.searchParams.set(k, params.get(k));
  // (a drawing: its URL alone, named once above as any model is (show2D sets app.sourceUrl);
  // the 3D view's camera does not apply to it)
  if (app.dxf) return u.toString();
  u.hash = `view=${encodeView(currentView())}`;
  return u.toString();
}

// The added models a view link carries (those opened from a URL, a model from a URL first) and how
// many it leaves out (those opened from this device): one answer for viewLink and for what Copy
// view link says of it (each kept its own copy of the test: r52 A5)
function linkAdds() {
  const added = app.sourceUrl && app.scene ? app.scene.slice(1) : [];
  return { carried: added.filter((m) => m.url), left: added.filter((m) => !m.url).length };
}

// Copy a link to this model at this view. A model opened from this device has
// no URL: the link then holds the view alone, and the note says so.
async function shareView() {
  if (!app.header && !(app.dxf && app.dxf.url)) return;
  const link = viewLink();
  let copied = false;
  try {
    await navigator.clipboard.writeText(link);
    copied = true;
  } catch { /* no clipboard (not a secure context, or refused) */ }
  if (!copied) window.prompt('Copy this link to the view:', link);
  app.lastViewLink = link;
  // (a link carries the first MAX_NOTES notes: said, not left for the visitor to find)
  const nNotes = app.measure ? app.measure.notes().length : 0;
  // (copied only when the clipboard took it: a refusal, or a prompt the visitor cancelled, read
  // "View link copied" -- r47 A5; with the box shown it says the link itself, and a note after it
  // came once the box had closed -- what the box does not say is told: r48 Q11)
  // (the added models opened from this device, which viewLink leaves out: said too -- a scene of a
  // URL's case and a board added from the device copied a link to the case alone, "View link
  // copied" told: r51 A6)
  const said = linkToldText(copied, !!app.sourceUrl, nNotes, linkAdds().left);
  if (said) tell(said, copied ? 3000 : 4000);
}
// What Copy view link tells: copied, and what the link does not carry -- its clauses a list, joined
// ("View link copied:  (with the first 20…": r49 A6, Q6); with the box shown, only those clauses;
// '' when there is nothing to tell (a function, its text tested as said: r50 Q6)
function linkToldText(copied, hasUrl, nNotes, nLocal = 0) {
  const clauses = [hasUrl ? '' : 'it holds the view, not the file (opened from this device)',
    hasUrl && nLocal ? `it leaves out the ${nLocal === 1 ? 'added model' : `${nLocal} added models`} opened from this device` : '',
    nNotes > MAX_NOTES ? `it carries the first ${MAX_NOTES} of its ${nNotes} notes (a link is short)` : ''].filter(Boolean);
  if (copied) return `View link copied${clauses.length ? `: ${clauses.join('; ')}` : ''}`;
  return clauses.length ? `The view link: ${clauses.join('; ')}` : '';
}

// ---------- tours (js/tour.js) ----------
// A .cadtour.json played over the model (?tour=<url>): each step flies the
// camera to its view and shows its caption in a card over the view; ◀ ▶ (and
// ← →) step, ✕ (Esc) leaves and puts back the view the visitor had. A step's
// camera is a preset (the whole model framed from it), a fixed camera, or
// "frame these parts from here", fitted to the window it plays in, above the
// card; a step with none keeps the camera where it is. Reduced motion: a cut.

// the bottom of the view the caption card covers (frames sit above it)
const tourCover = () => (app.tour && !$('tourcard').hidden ? $('tourcard').offsetHeight + 16 : 0);

function tourParts(names) {
  if (app.tourIdxFor !== app.header) { app.tourIdx = partIndex(app.header, app.partLabels, firstModelBodies()); app.tourIdxFor = app.header; }
  return resolveParts(names, app.tourIdx);
}

async function readTour(url) {
  let abs;
  // (a tour shared as a GitHub page or a Dropbox link is read from the file, and its model
  // resolves against that file: js/open-url.js fileUrl)
  try { abs = fileUrl(new URL(url, location.href).href); } catch { return { error: `"${url}" is not a URL` }; }
  let text;
  try {
    const r = await timedFetch(abs);
    if (!r.ok) return { error: `${r.status === 404 ? 'not found' : 'refused'} (${r.status}): ${abs}` };
    // (read up to its limit, as it arrives: js/model-list.js readCapped, js/tour.js MAX_TOUR_BYTES)
    try { text = await readCapped(r, MAX_TOUR_BYTES); } catch (e) { return { error: `${e.message}: ${abs}` }; }
  } catch (e) {
    // (the site answered without CORS -- the tour is not there, or not
    // shared -- or did not answer: fetchFailedText tells which)
    return { error: await fetchFailedText(abs, 'the tour', e, 'could not be read') };
  }
  try { return { tour: parseTour(text, abs) }; } catch (e) { return { error: e.message }; }
}

// The camera a step asks for -> { pose: { target, dist, q }, ortho } or null
// (a step with no camera of its own)
function stepPose(s) {
  const c = app.cam;
  let q = camQ(c);
  // the projection: the step's own ("ortho", or its view's camera), else the visitor's as the
  // tour began -- never the step before's, so stepping back gives the same picture
  const base = app.tour && app.tour.base && app.tour.base.view && app.tour.base.view.cam;
  let ortho = s.ortho !== undefined ? s.ortho : base ? !!base.ortho : !!c.ortho;
  let pose = null;
  const preset = (v) => { const [y, p] = presetView(v); return presetQuat(y, p, c.orient); };
  if (typeof s.view === 'string') q = preset(s.view);
  else if (s.view) {
    q = s.view.cam.q.slice();
    pose = { target: s.view.cam.target.slice(), dist: s.view.cam.dist, q };
    if (s.view.cam.ortho !== undefined) ortho = s.view.cam.ortho;
  }
  if (s.from) q = Array.isArray(s.from) ? s.from.slice() : s.from === 'outside' ? preset('iso') : preset(s.from);
  if (s.frame || typeof s.view === 'string' || (s.from && !pose)) {
    let ids = null;
    if (Array.isArray(s.frame)) {
      const r = tourParts(s.frame);
      if (r.missing.length) app.tourMissing.push(...r.missing);
      ids = r.ids.length ? r.ids : null;
    }
    // (a frame given as a box: the box itself)
    const box = s.frame && s.frame.min ? { min: s.frame.min.slice(), max: s.frame.max.slice() } : drawnBox(ids) || drawnBox(null);
    if (!box) return null;
    if (s.from === 'outside') q = outsideQuat(box, ids, s) || q;
    const f = fitPose(box, q, s.margin ?? 1.05, optbarHeight() + tourCover());
    pose = { target: f.target, dist: f.dist, q };
  }
  return pose ? { pose, ortho } : null;
}

// The grey a step's dim: "grey" draws the parts it is not about in
const TOUR_GREY = [0.62, 0.64, 0.67];

// A step's emphasis: its part colours, the rest dimmed
// (ghost: hidden and drawn faintly; grey; hide), show / hide / isolate, style,
// section and callouts. Each step is applied to the state the visitor had
// before the tour, never stacked on the step before, so stepping back is
// exact. The colours are the tour's only: they are never saved as the
// visitor's part colours. Explode is moved by the flight (flyTo).
function applyStepState(s) {
  const base = app.tour.base;
  const n = app.header.meshes.length;
  const ids = (names) => (names ? tourParts(names).ids : []);
  // ("show": "all": nothing hidden, whatever the page hid)
  let hidden = s.show === 'all' ? new Set() : new Set(base.hidden);
  if (s.isolate) {
    const keep = new Set(ids(s.isolate));
    hidden = new Set();
    for (let id = 1; id <= n; id++) if (!keep.has(id)) hidden.add(id);
  }
  for (const id of ids(s.hide)) hidden.add(id);
  if (Array.isArray(s.show)) for (const id of ids(s.show)) hidden.delete(id);
  // what the step is about: the parts it colours, else the parts it frames
  const subject = new Set(s.colour ? ids(Object.keys(s.colour)) : Array.isArray(s.frame) ? ids(s.frame) : []);
  const overrides = new Map(base.overrides);
  for (const [name, hex] of Object.entries(s.colour || {})) for (const id of tourParts([name]).ids) overrides.set(id - 1, hexToRgb(hex));
  app.tourGhost = false;
  // (what the dim alone did, so the tour maker records the step and not its dimming: captureStep)
  const dimmed = { grey: new Set(), hidden: new Set() };
  if (subject.size && s.dim !== 'none') {
    for (let id = 1; id <= n; id++) {
      if (subject.has(id)) { hidden.delete(id); continue; }
      if (s.dim === 'grey') { overrides.set(id - 1, TOUR_GREY); dimmed.grey.add(id); } else if (!hidden.has(id)) { hidden.add(id); dimmed.hidden.add(id); }
    }
    app.tourGhost = s.dim === 'ghost';
  }
  app.tour.dimmed = dimmed;
  app.hidden = hidden;
  syncTreeChecks();
  const same = overrides.size === app.overrides.size && [...overrides].every(([k, v]) => app.overrides.get(k)?.every((x, j) => x === v[j]));
  if (!same) { app.overrides = overrides; recolour(); }
  setStyle(s.style || base.view.style, false);
  if (s.section) Object.assign(app.section, s.section, s.section.axis !== 'off' ? { last: s.section.axis } : {});
  else Object.assign(app.section, base.view.section);
  // (a step's own callouts are pinned by showTourStep, where the parts will be)
  // (the visitor's own notes shown as the page's while the tour plays: they
  // do not open Measure's bar over it; leaving gives them back as theirs)
  if (app.measure && !s.callouts) app.measure.setNotes((base.view.notes || []).map((n) => ({ ...n, own: false })));
  pushState();
  updateButtons();
  viewChanged();
}

// A step's "from": "outside": the camera where the part is least hidden by
// the rest of the model (js/tour-sight.js): from the side of the model it
// lies on, 30° up, when that is clear; higher, from another side, or from
// underneath (a part on a board's bottom face) when it is not. The model's
// up axis stays up on screen. Worked out once per step (ids: the step's
// parts, whose own bodies never hide them; with none, a box frame, the
// bodies inside the box).
const sightOf = new WeakMap();
function outsideQuat(box, ids = null, step = null) {
  const up = orientUp(app.cam.orient);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let z = step && sightOf.get(step);
  if (!z || z.orient !== app.cam.orient) {
    const h = app.header;
    const whole = drawnBox(null) || h.bbox;
    const m = [0, 1, 2].map((k) => (whole.min[k] + whole.max[k]) / 2);
    const mine = new Set(ids || []);
    // (what the step shows: the visitor's hidden parts, plus the step's own
    // hide -- a heatsink taken off its chip -- less its show)
    const hidden = step && step.show === 'all' ? new Set() : new Set(app.tour ? app.tour.base.hidden : app.hidden);
    if (step && step.hide) for (const id of tourParts(step.hide).ids) hidden.add(id);
    if (step && Array.isArray(step.show)) for (const id of tourParts(step.show).ids) hidden.delete(id);
    const within = (b) => [0, 1, 2].every((k) => {
      const c = (b.min[k] + b.max[k]) / 2;
      return c >= box.min[k] && c <= box.max[k];
    });
    const bodies = [];
    h.meshes.forEach((mesh, i) => {
      const b = mesh.bbox;
      if (!b || mine.has(i + 1) || hidden.has(i + 1) || within(b)) return;
      bodies.push({ i, box: b });
    });
    // (a body whose box holds the part, a board thickened by what is fused
    // to it, counts by its faces' boxes: js/tour-sight.js obstaclesFor)
    const bm = app.baseMesh;
    const obstacles = obstaclesFor(box, bodies, (i) => (bm && bm.faces && h.meshes[i].faceCount
      ? meshFaceBoxes(h.meshes[i], bm.position, bm.index, bm.faces) : null));
    z = { dir: clearestDirection(box, up, m, obstacles).dir, orient: app.cam.orient };
    if (step) sightOf.set(step, z);
  }
  z = z.dir; // toward the eye
  let y = up.map((v, k) => v - dot(up, z) * z[k]);
  const yn = Math.hypot(...y);
  y = y.map((v) => v / yn);
  const x = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
  return qFromBasis(x, y, z);
}

function cancelFlight() {
  if (app.tourRaf) cancelAnimationFrame(app.tourRaf);
  app.tourRaf = 0;
}

// Fly the camera to `to` over `secs` (eased), and Explode to `explodeTo`
// (0-1; 0 puts the parts back); a visitor's drag, wheel or key on the view
// during the flight takes over (the flight stops where it is)
function flyTo(to, ortho, secs, ease, explodeTo = 0, done = null) {
  cancelFlight();
  const x = app.explode;
  const ex0 = x.on && x.for === app.header ? x.t : 0;
  const ex1 = app.renderer ? explodeTo : 0;
  if (ex1 > 0 && !x.on) { x.t = 0; setExplode(true); }
  const explodeAt = (e) => {
    if (!x.on || ex0 === ex1) return;
    x.t = ex0 + (ex1 - ex0) * e;
    syncExplodeSphere();
    syncExplodeRow();
  };
  const c = app.cam;
  const from = { target: c.target.slice(), dist: c.dist, q: camQ(c) };
  // (a cut: reduced motion, or a tour's pictures being taken)
  const ms = reducedMotion() || app.tour?.cut ? 0 : secs * 1000;
  const t0 = performance.now();
  const input0 = app.lastInput;
  const settle = () => {
    // the zoom's floor follows what is framed (as applyView sets it)
    const box = $('stage');
    c.viewRadius = Math.min(app.sphere.radius, c.dist / fitDistance(1, c.fov, box.clientWidth / Math.max(1, box.clientHeight)));
    app.stageAspect = box.clientWidth / Math.max(1, box.clientHeight);
  };
  const frame = (now) => {
    if (app.lastInput !== input0) { // the visitor took the camera: a playing tour pauses
      app.tourRaf = 0; explodeAt(1); if (ex1 === 0 && x.on) setExplode(false); settle();
      setTourPlaying(false);
      return;
    }
    const t = ms ? Math.min(1, (now - t0) / ms) : 1;
    const e = (EASE[ease] || EASE.inOut)(t);
    explodeAt(e);
    if (t >= 1 && ex1 === 0 && x.on) setExplode(false);
    if (!to) { // no camera of its own: the explode alone
      viewChanged();
      if (t < 1) app.tourRaf = requestAnimationFrame(frame); else { app.tourRaf = 0; if (done) done(); }
      return;
    }
    const p = poseAt(from, to, e);
    c.target = p.target; c.dist = p.dist; c.q = p.q;
    // projection changes at the midpoint (it cannot be blended)
    if (!!c.ortho !== ortho && t >= 0.5) { c.ortho = ortho; updateButtons(); }
    viewChanged();
    if (t < 1) app.tourRaf = requestAnimationFrame(frame);
    else { app.tourRaf = 0; settle(); if (done) done(); }
  };
  app.tourRaf = requestAnimationFrame(frame);
}

// A playing tour's hold: the step's `hold` seconds, turning `orbit` degrees
// about the model's up axis (not where the system asks for reduced motion),
// then the next step (the first again for a looping tour; the end of one that
// does not loop stops it). The visitor's own drag, wheel or key pauses it.
function holdStep() {
  const t = app.tour;
  if (!t || !t.playing) return;
  cancelFlight();
  const s = t.tour.steps[t.i];
  const t0 = performance.now();
  let last = t0;
  const input0 = app.lastInput;
  const up = orientUp(app.cam.orient);
  const rate = reducedMotion() ? 0 : ((s.orbit || 0) * Math.PI) / 180 / Math.max(0.001, s.hold);
  const frame = (now) => {
    if (app.tour !== t || !t.playing) { app.tourRaf = 0; return; }
    if (app.lastInput !== input0) { app.tourRaf = 0; setTourPlaying(false); return; }
    if (rate) { turnAbout(app.cam, up, (rate * (now - last)) / 1000); viewChanged(); }
    last = now;
    if (now - t0 >= s.hold * 1000) {
      app.tourRaf = 0;
      if (t.i < t.tour.steps.length - 1) showTourStep(t.i + 1);
      else if (t.tour.loop && !t.recording) showTourStep(0); // (a video plays it once)
      else setTourPlaying(false);
      return;
    }
    app.tourRaf = requestAnimationFrame(frame);
  };
  app.tourRaf = requestAnimationFrame(frame);
}

// Play / Pause: playing, each step holds and then the next flies in; paused,
// the tour waits for ◀ ▶. Play resumes from the view as it is.
function setTourPlaying(on) {
  const t = app.tour;
  if (!t) return;
  t.playing = on;
  const b = $('tourplay');
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? 'Pause the tour' : 'Play the tour');
  b.title = on ? 'Pause (Space)' : 'Play: each step in turn (Space)';
  b.classList.toggle('playing', on);
  // (a flight under way goes on, and holds when it lands; a hold stops itself)
  if (on && !app.tourRaf) {
    // at the end of a tour that does not loop, Play starts it again
    if (t.i === t.tour.steps.length - 1 && !t.tour.loop && t.ended) { t.ended = false; showTourStep(0); } else holdStep();
  }
  if (!on && t.i === t.tour.steps.length - 1) t.ended = true;
}

// A tour step's missing parts, told -- but not in the moment of the tour's start, which told every
// part it lacks: whatever step is shown in that moment, the start's own or the one a picture, a
// video or the maker's "Show this step" shows next (the flag spent by step 1 left those saying both
// notes at once: r46 A4, r47 A7, r48 Q7, r49 A3, Q2)
function tellStepMissing(t) {
  if (app.tourMissing.length && !t.startedNow) tell(`not in this model: ${[...new Set(app.tourMissing)].join(', ')}`, 4000);
}
function markStarted(t, told) {
  if (!told) return;
  t.startedNow = true;
  setTimeout(() => { t.startedNow = false; }, 0);
}

function showTourStep(i) {
  const t = app.tour;
  const n = t.tour.steps.length;
  t.i = Math.max(0, Math.min(n - 1, i));
  const s = t.tour.steps[t.i];
  $('tourtitle').textContent = s.title || (t.i === 0 ? t.tour.title : '');
  $('tourtitle').hidden = !$('tourtitle').textContent;
  $('tourbody').textContent = s.text;
  $('tourbody').hidden = !s.text;
  $('tourcount').textContent = `${t.i + 1} / ${n}`;
  $('tourprev').disabled = t.i === 0;
  $('tournext').disabled = t.i === n - 1;
  app.tourMissing = [];
  // the emphasis first (a dim that hides parts changes what "all" frames),
  // then the camera; the card is already filled: its height is what the
  // frame keeps clear
  applyStepState(s);
  // a frame where the parts will be: framed at the step's explode, flown
  // there from the explode they are at now
  const x = app.explode;
  const ex1 = app.renderer ? s.explode ?? 0 : 0;
  if (ex1 > 0 && !(x.on && x.for === app.header)) { x.t = 0; setExplode(true); }
  // the way the step explodes, as it was recorded (as a view link sets it)
  if (ex1 > 0 && x.on && s.explodeAlong && x.mode !== s.explodeAlong) setExplodeMode(s.explodeAlong);
  const exNow = x.t;
  if (x.on) x.t = ex1;
  const to = stepPose(s);
  // callouts at the top of their parts as they will be drawn (exploded too)
  if (app.measure && s.callouts) {
    app.measure.setNotes(s.callouts.map((c) => ({ p: c.at || topOfBox(drawnBox(tourParts([c.part]).ids)), text: c.text })).filter((c) => c.p));
  }
  if (x.on) x.t = exNow;
  flyTo(to ? to.pose : null, to ? to.ortho : !!app.cam.ortho, s.transition, s.ease, ex1, holdStep);
  // (not right after the tour's start, which told every part it lacks -- the two said in one moment,
  // in two wordings, the start's 6 s note replaced at once: r46 A4, Q4; keyed on that, not on the
  // index: step 1 shown again by ◀, a loop or a replay never named its missing parts -- r47 A7)
  tellStepMissing(t);
  // (a step with no text read without a trailing space: r49 Q7)
  announce(`Step ${t.i + 1} of ${n}${$('tourtitle').textContent ? `: ${$('tourtitle').textContent}` : ''}.${s.text ? ` ${s.text}` : ''}`);
}

// only: a step id (?step=<id>, a v2 tour): that step alone, held, with no
// card (the page around the viewer says what it shows). A tour without it
// leaves the model as it is; returns whether the tour started.
function startTour(tour, url, only = null) {
  if (!app.header) return false;
  // (the whole tour, kept beside a one-step copy: File > Make a tour… edits the whole, not the copy
  // ?step= shows -- it saved one step under the tour's title)
  const full = tour;
  if (only) {
    const s = tour.steps.find((x) => x.id === only);
    if (!s) {
      tellReady(`the tour has no step "${only}"`);
      return false;
    }
    tour = { ...tour, steps: [s], mode: 'static', loop: false };
  }
  // (one tour in place of another, as from File: what the visitor had
  // before the first, not the first tour's step)
  const prev = app.tour;
  endTour(false);
  const saved = prev ? prev.saved : currentView();
  // what the visitor had: each step is applied to it, and leaving puts it back
  // (styleChoice: the visitor's own choice of style, which a step's style is
  // not; leaving puts it back as it was)
  const base = prev ? prev.base : { view: saved, hidden: [...app.hidden], overrides: new Map(app.overrides), faceOverrides: app.faceOverrides, styleChoice: app.styleChoice,
    explode: { on: app.explode.on && app.explode.for === app.header, t: app.explode.t, mode: app.explode.mode, mine: app.explode.for === app.header }, walk: !!app.walk };
  app.tour = { tour, full, url, i: 0, saved, base, playing: false };
  // (in place of another tour: the visitor's orientation, not that tour's,
  // unless this one sets its own below)
  if (prev && saved.cam && saved.cam.orient && saved.cam.orient !== app.cam.orient) {
    app.cam.orient = saved.cam.orient;
    updateButtons();
  }
  // Walk off while it plays (its keys would move the camera off the step);
  // leaving puts it back, the camera with it
  if (app.walk) { app.walk = false; $('walk').setAttribute('aria-pressed', 'false'); }
  // nothing selected while it plays: a selection greys every other part, so Preview and the
  // tour's video showed the maker's "frame the selection" pick, not the step (its pictures
  // drop the selection); leaving puts it back with the rest of the view (saved.selected)
  if (app.selected.size) select([], false);
  app.hover = 0;
  // Paint's face colours are the visitor's, and no step holds them: not drawn while it plays, so
  // the maker's Show and Preview show what the saved tour will (leaving puts them back)
  if (app.paintFaces) setPaint(false);
  if (app.faceOverrides.size) { app.faceOverrides = new Map(); recolour(); }
  // and Measure's distances and angles, and the hole table: a step holds notes only, and they
  // were drawn into the tour's pictures and video (leaving puts them back)
  if (!prev) {
    base.measured = app.measure ? app.measure.setAside() : null;
    base.holesFor = app.holesFor;
    if (app.holesFor && app.measure) showHoles(null);
  }
  // the tour's orientation while it plays (leaving puts the visitor's back,
  // with the rest of their view)
  if (tour.orient && tour.orient !== app.cam.orient) {
    app.cam.orient = tour.orient;
    updateButtons();
  }
  $('tourcard').hidden = !!only;
  // an animated tour plays from the start; a static one waits for ▶
  setTourPlaying(tour.mode === 'animated');
  $('stage').classList.add('touring');
  // the names it uses that this model lacks, once (a tour outlives a model update)
  const missing = tourParts(tourNames(tour)).missing;
  if (missing.length) tellReady(`the tour names parts this model lacks: ${missing.join(', ')}`);
  markStarted(app.tour, missing.length > 0);
  showTourStep(0);
  return true;
}

// Explode as the visitor had it before a tour: on or off, AND its amount and direction (a tour's
// step left them where it put them: Explode off, then on, read "exploded 0 %" and moved nothing,
// or moved the parts along the step's axis)
function restoreExplode(bx) {
  const x = app.explode;
  if (!bx.on) setExplode(false);
  x.t = bx.t;
  if (bx.mine && bx.mode && x.mode !== bx.mode) setExplodeMode(bx.mode);
  else if (!bx.mine) { x.for = null; x.dirs = null; x.mode = bx.mode; } // (the default direction, chosen when next turned on)
  if (bx.on) { if (x.on) { syncBodies(true); syncExplodeSphere(); syncExplodeRow(); viewChanged(); } else setExplode(true); }
}

// Leave the tour: the card goes and the view the visitor had comes back
function endTour(restore = true) {
  if (!app.tour) return;
  cancelFlight();
  const { saved, base } = app.tour;
  app.tour = null;
  app.tourGhost = false;
  $('tourcard').hidden = true;
  $('stage').classList.remove('touring');
  if (restore && saved && app.header) {
    app.overrides = base.overrides;
    if (base.faceOverrides) app.faceOverrides = base.faceOverrides;
    recolour();
    restoreExplode(base.explode);
    applyView(saved); // camera, style, section, hidden and selected parts, notes
    if (app.measure) app.measure.putBack(base.measured);
    if (base.holesFor && app.measure) showHoles(base.holesFor);
    // Walk as the visitor had it: back on, or off if they turned it on in the
    // tour (its eye was placed for a step, not for the view put back)
    if (!!app.walk !== base.walk) { app.walk = base.walk; $('walk').setAttribute('aria-pressed', String(base.walk)); }
    updateButtons();
    viewChanged();
  }
  // the visitor's own style choice and Explode amount and direction, however the tour ends (a new
  // model or a drawing ending it kept the last step's style pinned over the next model and its
  // list entry's style, and its explode: the next Explode read "exploded 0 %")
  app.styleChoice = base.styleChoice;
  if (!restore) { app.explode.t = base.explode.t; app.explode.mode = base.explode.mode; }
  announce('tour closed');
}

// The view as a tour step (the tour maker, js/tour-recorder.js): the camera
// (exactly, or the selected parts framed from this side), the part colours,
// what is hidden, explode, section, style, and Measure's notes as callouts.
// Parts are named by namesFor: the fewest names that cover exactly them.
function captureStep({ camera = 'exact' } = {}) {
  if (!app.header) return null;
  const c = app.cam;
  const n = app.header.meshes.length;
  tourParts([]); // (the name index for this model)
  const names = (ids) => namesFor(ids, app.header, app.tourIdx, app.partLabels);
  // (rounded as a link rounds it: roundCamera, the one rule)
  const rc = roundCamera({ target: c.target, dist: c.dist, q: camQ(c) });
  const q = rc.q;
  const s = {};
  if (camera === 'frame') {
    if (!app.selected.size) return null;
    s.frame = names([...app.selected]);
    s.from = q;
    s.margin = 1.3;
    s.ortho = !!c.ortho; // (the projection it was taken in: a framed step carries no camera)
  } else {
    s.view = { cam: { target: rc.target, dist: rc.dist, q, ortho: !!c.ortho } };
  }
  // with a tour shown (the maker's Show or Preview), the view is the step as played: what its dim
  // did (every other part grey, or hidden) is the dim field's, which the editor keeps, not a
  // colour or a hide of the step's -- recording it named every other part #9ea3ab, or hid them
  const dim = app.tour && app.tour.dimmed;
  const overrides = new Map(app.overrides);
  let hiddenNow = app.hidden;
  if (dim) {
    for (const id of dim.grey) {
      const own = app.tour.base.overrides.get(id - 1);
      if (own) overrides.set(id - 1, own); else overrides.delete(id - 1);
    }
    hiddenNow = new Set([...app.hidden].filter((id) => !dim.hidden.has(id)));
  }
  const byHex = new Map();
  for (const [i, rgb] of overrides) {
    const h = rgbToHex(rgb);
    if (!byHex.has(h)) byHex.set(h, []);
    byHex.get(h).push(i + 1);
  }
  if (byHex.size) {
    s.colour = {};
    for (const [h, ids] of byHex) for (const nm of names(ids)) s.colour[nm] = h;
  }
  // (every field the step takes is written, "nothing" included: a field left out means "keep
  // the page's", so a step taken after Show all says "show": "all", and a step with no cut
  // "section": "off" -- else a list's hidden parts and a visitor's cut stayed in the tour)
  if (hiddenNow.size) {
    if (hiddenNow.size > n / 2) {
      const shown = [];
      for (let id = 1; id <= n; id++) if (!hiddenNow.has(id)) shown.push(id);
      s.isolate = names(shown);
    } else s.hide = names([...hiddenNow]);
  } else s.show = 'all';
  if (app.explode.on && app.explode.for === app.header && app.explode.t > 0) {
    s.explode = roundFraction(app.explode.t); // (as a link keeps it: js/view-link.js)
    if (app.explode.mode) s.explodeAlong = app.explode.mode;
  }
  s.section = app.section.axis !== 'off' ? { axis: app.section.axis, t: roundFraction(app.section.t), flip: !!app.section.flip } : { axis: 'off' };
  s.style = currentStyle().id;
  // (the visitor's own notes: a model list's are the page's, shown again whatever the tour says)
  const notes = app.measure ? app.measure.notes().filter((nt) => nt.own) : [];
  // (and, with a tour shown, the shown step's own callouts, as it names them: they are on the
  // view, as the tour's notes, so the visitor-only filter above left them out)
  const shownStep = app.tour && app.tour.tour.steps[app.tour.i];
  // (each point by the one rounding: the shown step's too, scaled by a reading's unit)
  const shown = (shownStep && shownStep.callouts ? shownStep.callouts : []).map((c) => (c.at ? { ...c, at: roundNotePoint(c.at) } : c));
  const callouts = [...shown, ...notes.map((nt) => ({ text: nt.text, at: roundNotePoint(nt.p) }))];
  if (callouts.length) s.callouts = callouts;
  return s;
}

// Every file the viewer saves goes through here (exports, pictures, drawings, a .cadmesh, a
// tour): the object URL lives a minute, long enough for the browser to take it -> the URL
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  app.lastDownload = { name, bytes: blob.size, blob }; // (for tests)
  return url;
}
function downloadText(text, name, type) {
  downloadBlob(new Blob([text], { type }), name);
  app.lastDownload.text = text;
}

// A step's caption painted into a picture or a video frame, as the card
// shows it: bottom left, title over text, wrapped to the card's width
function paintCaption(ctx, w, h, scale, title, text) {
  if (!title && !text) return;
  const pad = 12 * scale, maxW = Math.min(440 * scale, w - 24 * scale);
  const font = (px, bold) => `${bold ? '600 ' : ''}${px * scale}px system-ui, sans-serif`;
  const wrap = (s, f) => {
    ctx.font = f;
    const lines = [];
    for (const para of s.split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width > maxW - 2 * pad && line) { lines.push(line); line = word; } else line = next;
      }
      lines.push(line);
    }
    return lines;
  };
  const tl = title ? wrap(title, font(15, true)) : [];
  const xl = text ? wrap(text, font(13)) : [];
  const lh1 = 20 * scale, lh2 = 18 * scale;
  const boxW = Math.min(maxW, 2 * pad + Math.max(...[...tl.map((l) => { ctx.font = font(15, true); return ctx.measureText(l).width; }),
    ...xl.map((l) => { ctx.font = font(13); return ctx.measureText(l).width; })]));
  const boxH = 2 * pad + tl.length * lh1 + xl.length * lh2;
  const x = 12 * scale, y = h - 12 * scale - boxH;
  ctx.save();
  ctx.fillStyle = 'rgba(37,42,50,.94)';
  ctx.strokeStyle = '#343b46';
  ctx.lineWidth = scale;
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 10 * scale);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#d8dde5';
  ctx.textBaseline = 'top';
  let yy = y + pad;
  ctx.font = font(15, true);
  for (const l of tl) { ctx.fillText(l, x + pad, yy); yy += lh1; }
  ctx.font = font(13);
  for (const l of xl) { ctx.fillText(l, x + pad, yy); yy += lh2; }
  ctx.restore();
}

const slugOf = (s) => (s || 'tour').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tour';
const nextFrame = () => new Promise((ok) => requestAnimationFrame(() => ok()));

// A tour as pictures: each step applied at once (no flight), its colours on
// the GPU, rendered at twice the view's size with its caption painted in;
// the pictures zipped, in order. -> the number of pictures
async function tourPictures(tour) {
  endTour();
  startTourIn(tour, null); // (scaled to the reading, as Show and Preview are: js/tour.js tourAt)
  if (!app.tour) return 0;
  setTourPlaying(false);
  app.tour.cut = true;
  const files = [];
  try {
    for (let i = 0; i < tour.steps.length; i++) {
      showTourStep(i);
      for (let k = 0; k < 100 && app.tourRaf; k++) await nextFrame();
      await gpuSync().catch(() => {});
      await nextFrame();
      await nextFrame();
      // (the tour's pictures keep their own settings, not Save picture's)
      const pic = await renderPicture({ scale: 2, bg: 'view', sel: false });
      if (!pic) break;
      const s = tour.steps[i];
      paintCaption(pic.canvas.getContext('2d'), pic.canvas.width, pic.canvas.height, pic.scale, s.title || (i === 0 ? tour.title : ''), s.text);
      const png = await new Promise((ok) => pic.canvas.toBlob(ok, 'image/png'));
      files.push([`${String(i + 1).padStart(2, '0')}-${slugOf(s.title || `step ${i + 1}`)}.png`, new Uint8Array(await png.arrayBuffer())]);
    }
  } finally {
    endTour();
  }
  if (!files.length) return 0;
  const { zip } = await import('./export-mesh.js');
  downloadBlob(new Blob([await zip(files)], { type: 'application/zip' }), `${slugOf(tour.title)}-pictures.zip`);
  return files.length;
}

// A tour as a video: played from the start (its holds and orbits, once
// through, whatever its mode and loop), each frame drawn with Measure's
// notes and the step's caption into a canvas that MediaRecorder records as
// WebM, in this browser. The visitor's own input stops it where it is.
// -> the video's size in bytes, or a reason it could not be made
async function tourVideo(tour) {
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = window.MediaRecorder && types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime || !HTMLCanvasElement.prototype.captureStream) return 'this browser cannot record video';
  endTour();
  startTourIn(tour, null); // (scaled to the reading, as Show and Preview are)
  if (!app.tour) return 'no model';
  const t = app.tour;
  t.recording = true;
  const r = app.renderer, box = $('stage');
  const out = document.createElement('canvas');
  out.width = r.canvas.width;
  out.height = r.canvas.height;
  const ctx = out.getContext('2d');
  const rec = new MediaRecorder(out.captureStream(30), { mimeType: mime, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((ok) => { rec.onstop = ok; });
  let raf = 0;
  const draw = () => {
    // (rendered and copied in one task: a WebGL canvas keeps no frame to copy later)
    r.render(frameState());
    ctx.drawImage(r.canvas, 0, 0, out.width, out.height);
    const scale = out.width / Math.max(1, box.clientWidth);
    app.measure.paint(ctx, scale, !!currentStyle().paper);
    const s = app.tour === t ? t.tour.steps[t.i] : null;
    if (s) paintCaption(ctx, out.width, out.height, scale, s.title || (t.i === 0 ? t.tour.title : ''), s.text);
    raf = requestAnimationFrame(draw);
  };
  rec.start(250);
  draw();
  showTourStep(0);
  setTourPlaying(true);
  // until it has played through (or the visitor stopped it), and never past
  // the tour's own length with room to spare (a stalled play must not record
  // forever)
  const limit = performance.now() + 1000 * (10 + 1.5 * tour.steps.reduce((s, x) => s + x.transition + x.hold, 0));
  while (app.tour === t && t.playing && performance.now() < limit) await new Promise((ok) => setTimeout(ok, 100));
  cancelAnimationFrame(raf);
  rec.stop();
  await stopped;
  endTour();
  const blob = new Blob(chunks, { type: 'video/webm' });
  if (!blob.size) return 'the recording came out empty';
  downloadBlob(blob, `${slugOf(tour.title)}.webm`);
  return blob.size;
}

// ---------- ?embed=1 ----------
// The model alone in another site's page: no toolbar, parts panel or footer;
// Fit, full screen and "Open in cad.place ↗" (the full viewer at this view)
// over the view. Until a click or tap makes it active it takes nothing from
// the page around it: the wheel and a finger's drag scroll the page, and a
// hint says how to start; Esc gives the wheel back.
// &active=1: active from the start (a page that shows the model as an
// overlay of its own, not in a scrolling page, has no page to give the wheel
// to). &noopen=1: no "Open in cad.place ↗" (a page in an app, where a new tab
// has nowhere to open).
const embedParams = new URLSearchParams(location.search);
app.embed = embedParams.get('embed') === '1';
app.embedActive = !app.embed || embedParams.get('active') === '1';
function setupEmbed() {
  if (!app.embed) return;
  document.body.classList.add('embed');
  document.body.classList.toggle('active', app.embedActive);
  // no header here: ? and Full screen over the view's top right corner
  $('stage').append($('hdend'));
  $('embedbar').hidden = false;
  $('embedhint').hidden = app.embedActive;
  $('embedfit').onclick = () => fitTo(drawnBox(null));
  if (embedParams.get('noopen') === '1') { $('embedopen').remove(); return; }
  // &maximize=1 (a product page's inline viewer): "Open in cad.place" is a
  // maximize icon in the top right, beside ?, in place of Full screen -- the
  // way to the whole viewer is the one way to make it bigger
  if (embedParams.get('maximize') === '1') {
    const a = $('embedopen');
    a.classList.add('maxopen');
    a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>';
    a.setAttribute('aria-label', 'Open the full viewer');
    a.title = 'Open the full viewer, at this view, in a new tab (cad.place)';
    $('helpbtn').after(a);
    document.body.classList.add('embedmax');
  }
  // the link is made when it is about to be followed, so it holds the view now
  const fresh = () => { $('embedopen').href = app.header ? viewLink() : location.href.replace(/([?&])embed=1&?/, '$1'); };
  for (const ev of ['pointerenter', 'focus', 'pointerdown']) $('embedopen').addEventListener(ev, fresh);
  fresh();
}
function setEmbedActive(on) {
  if (!app.embed || app.embedActive === on) return;
  app.embedActive = on;
  document.body.classList.toggle('active', on);
  $('embedhint').hidden = on;
  announce(on ? 'the model now turns and zooms with the pointer; Esc gives the page its wheel back' : 'the page scrolls again');
}

// the style in force: the select's choice, else the model list's style for
// the model, else the file type's default
const currentStyle = () => styleById(styleFor(app.styleChoice || (app.header && listEntry(app.sourceUrl)?.style) || null));

// remember: only a choice made in the select is kept (E is not)
function setStyle(id, remember) {
  if (!styleById(id)) return;
  app.styleChoice = id;
  if (remember) {
    setPref('cadv.style', id);
    // (the visitor's own choice, made during a tour: kept when it ends, as it is remembered)
    if (app.tour) { app.tour.base.styleChoice = id; if (app.tour.saved) app.tour.saved.style = id; }
  }
  $('style').value = id;
  syncStyleBg();
  queueFrame();
}

// the paper styles' overlay palette (#hover, notices): dark on a light chip
function syncStyleBg() {
  if (currentStyle().paper || app.lightBg) $('stage').dataset.bg = 'paper';
  else delete $('stage').dataset.bg;
}

// ---------- looks (feature review item 22) ----------
// light background (the shaded styles on paper), ghosted hidden parts, and
// the turntable: the model turned slowly about its up axis while the view is
// left alone for IDLE_MS. Never under prefers-reduced-motion (not offered).
const GHOST_ALPHA = 0.15;
const TURN_RAD_S = 0.35; // about 18 s a turn
const IDLE_MS = 2500;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function readLooks() {
  app.lightBg = getPref('cadv.bg') === 'light';
  // ?embed=1&theme=light|dark: the framing page's theme, as index.html's head
  // script painted the frame; the Light button still turns it, and nothing
  // is remembered here
  const theme = app.embed ? embedParams.get('theme') : null;
  if (theme === 'light' || theme === 'dark') app.lightBg = theme === 'light';
  app.ghostHidden = getPref('cadv.ghost') === '1';
  app.levelOrbit = getPref('cadv.level') === '1';
  app.turntable = params.get('turntable') === '1' && !reducedMotion();
  app.lastInput = performance.now();
}
function wireLooks() {
  const press = () => {
    $('lightbg').setAttribute('aria-pressed', String(!!app.lightBg));
    $('ghost').setAttribute('aria-pressed', String(!!app.ghostHidden));
    $('turntable').setAttribute('aria-pressed', String(!!app.turntable));
    $('level').setAttribute('aria-pressed', String(!!app.levelOrbit));
  };
  press();
  $('level').onclick = () => {
    app.levelOrbit = !app.levelOrbit;
    setPref('cadv.level', app.levelOrbit ? '1' : '0');
    press();
    announce(app.levelOrbit ? 'level orbit: the model\'s up stays up' : 'free orbit');
  };
  $('lightbg').onclick = () => {
    app.lightBg = !app.lightBg;
    setPref('cadv.bg', app.lightBg ? 'light' : 'dark');
    press();
    syncStyleBg();
    queueFrame();
  };
  $('ghost').onclick = () => {
    app.ghostHidden = !app.ghostHidden;
    setPref('cadv.ghost', app.ghostHidden ? '1' : '0');
    press();
    queueFrame();
  };
  $('turntable').onclick = () => { app.turntable = !app.turntable && !reducedMotion(); press(); turn(); };
  // any input is the visitor taking the view: the turntable waits
  for (const t of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
    window.addEventListener(t, () => { app.lastInput = performance.now(); }, { capture: true, passive: true });
  }
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const sync = () => {
    $('turntable').hidden = mq.matches;
    if (mq.matches) { app.turntable = false; press(); }
  };
  mq.addEventListener?.('change', sync);
  sync();
  turn();
}
// The ground shadow on the light background (the shaded styles): an ellipse
// on the plane under the model's drawn box, along its up axis, a little wider
// than its footprint, darkest under its middle; faded out as the eye comes
// down to the ground, so it never shows from the side or below
const GROUND_ALPHA = 0.3;
app.groundShadow = () => groundShadow(); // (for tests/ui-checks.py)
function groundShadow() {
  if (!app.lightBg || !app.header || !['shade', 'xray'].includes(currentStyle().faces)) return null;
  const b = drawnBox(null);
  if (!b) return null;
  const up = orientUp(app.cam.orient);
  const k = up.findIndex((v) => v !== 0);
  const s = Math.sign(up[k]);
  const d = camDir(app.cam);
  const above = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
  const alpha = GROUND_ALPHA * Math.min(1, Math.max(0, (above - 0.05) * 2.5));
  if (alpha < 0.01) return null;
  const size = [0, 1, 2].map((j) => b.max[j] - b.min[j]);
  const diag = Math.hypot(...size) || 1;
  const c = [0, 1, 2].map((j) => (b.min[j] + b.max[j]) / 2);
  c[k] = (s > 0 ? b.min[k] : b.max[k]) - s * 0.002 * diag; // just under the model
  const [i, j] = [0, 1, 2].filter((x) => x !== k);
  const ax = [0, 0, 0], ay = [0, 0, 0];
  ax[i] = size[i] * 0.62 + 0.06 * diag;
  ay[j] = size[j] * 0.62 + 0.06 * diag;
  return { c, ax, ay, alpha };
}

// A drag's (or an arrow key's) orbit: free, or with Level on the model's up
// axis kept upright on screen (js/camera.js levelOrbitBy)
function orbit(c, dx, dy) {
  // Walk: the view turns about the eye (looking around), not the model
  const eye0 = app.walk ? [0, 1, 2].map((k) => c.target[k] + camDir(c)[k] * c.dist) : null;
  if (app.levelOrbit || app.walk) levelOrbitBy(c, orientUp(c.orient), app.walk ? -dx : dx, app.walk ? -dy : dy);
  else orbitBy(c, dx, dy);
  if (eye0) { const d = camDir(c); c.target = [0, 1, 2].map((k) => eye0[k] - d[k] * c.dist); }
}

// Walk (feature review item 24): W A S D move forward, left, back, right, Q
// and E down and up, a step of a fiftieth of the model's size (Shift: five);
// the view keeps the model's up upright and a drag looks around
const WALK_KEYS = { w: [0, 1], s: [0, -1], a: [-1, 0], d: [1, 0], q: [2, -1], e: [2, 1] };
function walkKey(k, shift) {
  const c = app.cam;
  const m = WALK_KEYS[k];
  if (!m || !app.header) return false;
  const step = (app.sphereBase || app.sphere).radius * 0.04 * (shift ? 5 : 1);
  const up = orientUp(c.orient);
  const fwd = camDir(c).map((v) => -v);
  // forward along the ground (walking does not climb where the view looks)
  const dot = fwd[0] * up[0] + fwd[1] * up[1] + fwd[2] * up[2];
  let g = fwd.map((v, i) => v - up[i] * dot);
  const gl = Math.hypot(...g) || 1;
  g = g.map((v) => v / gl);
  const right = [g[1] * up[2] - g[2] * up[1], g[2] * up[0] - g[0] * up[2], g[0] * up[1] - g[1] * up[0]];
  const dir = m[0] === 2 ? up.map((v) => v * m[1]) : m[0] ? right.map((v) => v * m[0]) : g.map((v) => v * m[1]);
  c.target = c.target.map((v, i) => v + dir[i] * step);
  viewChanged();
  return true;
}
function setWalk(on) {
  app.walk = on;
  $('walk').setAttribute('aria-pressed', String(on));
  if (on) {
    // stand where the eye is: a near orbit distance, so a look-around turns in place
    const c = app.cam, d = camDir(c);
    if (c.ortho) { c.ortho = false; updateButtons(); } // (a walk has a viewpoint: perspective)
    const eye = [0, 1, 2].map((k) => c.target[k] + d[k] * c.dist);
    c.dist = Math.max(1e-3, (app.sphereBase || app.sphere).radius * 0.05);
    c.target = [0, 1, 2].map((k) => eye[k] - d[k] * c.dist);
    levelOrbitBy(c, orientUp(c.orient), 0, 0);
    viewChanged();
  }
  tell(on ? 'Walk: W A S D move, Q E down and up, drag to look (Shift: faster)' : 'walk off', 3000, on ? 'walk on' : 'walk off');
}

// one animation frame of the turntable; runs only while it is on
let turnLast = 0, turnRaf = 0;
function turn() {
  if (turnRaf || !app.turntable) return;
  turnRaf = requestAnimationFrame((t) => {
    turnRaf = 0;
    if (!app.turntable) return;
    const dt = turnLast ? Math.min(0.1, (t - turnLast) / 1000) : 0;
    turnLast = t;
    // (not while a tour is shown: a step's camera is the step's -- a static step spun off it, an
    // orbit step turned faster than recorded, and its pictures were taken off it)
    if (app.header && !app.tour && !document.hidden && performance.now() - app.lastInput > IDLE_MS) {
      turnAbout(app.cam, orientUp(app.cam.orient), TURN_RAD_S * dt);
      viewChanged();
    }
    turn();
  });
}

// E: Shaded <-> Shaded + edges; elsewhere it says why nothing happened
function edgesKey() {
  const next = toggleEdges(currentStyle().id);
  if (!next) { tell('E switches edges in the Shaded styles'); return; }
  setStyle(next, false);
  const s = styleById(next);
  tell(s.label, 1500, `${s.label} style`);
}

// A preset's camera orientation, taken in the model's orientation
// (js/orient.js): the preset in the viewer's own frame, turned into the file's
const presetQuat = (yaw, pitch, orient) => qMul(orientQuat(orient), quatFromView(yaw, pitch, 'y'));
// the camera's turn: its own, else the preset its yaw and pitch name (the one fallback: written at
// four callers, a fifth that forgot it made roundCamera throw)
function camQ(c) { return c.q || presetQuat(c.yaw, c.pitch, c.orient); }
// (and the page's camera has its turn from the start: camera.js's own fallback, by `cam.up`,
// which app.cam never has, turned it as if Y were up)
app.cam.q = camQ(app.cam);

// Iso on a tall view looks along a long model (js/orient.js isoView)
const stageAspectNow = () => { const s = $('stage'); return s.clientWidth / Math.max(1, s.clientHeight); };
const presetView = (v) => (v === 'iso' && app.header ? isoView(app.cam.orient, app.header.bbox, stageAspectNow()) : VIEWS[v]);

function setView(v) {
  [app.cam.yaw, app.cam.pitch] = presetView(v);
  app.cam.q = presetQuat(app.cam.yaw, app.cam.pitch, app.cam.orient);
  fitTo(drawnBox(null));
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
    if (app.measure) app.measure.draw(); // its layer follows the camera
    drawTriad();
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
// (and a DXF's 2D canvas, which takes its own pointer input: js/dxf-view.js)
const OVER_VIEW = '.card, #optbar, #hdend, #helppop, #embedbar, #view2d, #tourcard, #touredit, #pictoast';
// (Display, the menu after Style, is always a menu where View stands in the
// row, and its items are View's panel's where View folds: no fold step)
const MENUS = [...FOLD_ORDER, 'displaymenu'];

const narrowLayout = () => getComputedStyle($('tb')).flexWrap === 'nowrap';

// Open… stands in the row (wide), or is File's first item (narrow)
function placeOpen(narrow) {
  const lbl = $('open').parentElement;
  const menu = $('filemenu');
  const panel = $('filepanel');
  const btn = menu.querySelector('.menu-btn');
  // (a move takes the focus: given back where it lands, r20)
  const had = document.activeElement === lbl;
  if (narrow && lbl.parentElement !== panel) $('fhopen').after(lbl); // under File's Open heading
  else if (!narrow && lbl.parentElement === panel) menu.before(lbl);
  if (had && document.activeElement !== lbl) focusBeside(lbl);
  // a model list goes where Open… goes, and in the narrow layout stands in
  // the row before File while the row has room for it (refold folds it in
  // after Open… where it has not): a short window (800 x 500) is narrow by
  // its height alone, and folded the list away with the row half empty (UI
  // organization review rank 5). Moved only when it must: a move takes the
  // focus from it.
  const ml = $('modellist');
  if (narrow) { if (ml.nextElementSibling !== menu) menu.before(ml); } else if (lbl.nextElementSibling !== ml) lbl.after(ml);
  // "File" at every width: it holds Copy view link too, which a menu named
  // Save hid on the desktop (live end-to-end review); refold sets the title
  btn.textContent = 'File';
  panel.setAttribute('aria-label', 'File');
}

// The tools (Measure, Section, Explode) in the row after Fit, or (folded)
// first in View's panel; moved only when they must, the focus kept (a move
// takes it)
function placeMeasure(folded) {
  const m = $('tools');
  const had = m.contains(document.activeElement) ? document.activeElement : null;
  if (folded && m.parentElement !== $('viewpanel')) $('viewpanel').prepend(m);
  else if (!folded && m.previousElementSibling !== $('fit')) $('fit').after(m);
  else return;
  if (had && document.activeElement !== had) had.focus();
}

// where the focus goes when a tool's "× " toggle turns it off: the tool's
// button, or View's when the tools are folded into its closed panel
const toolFocus = (id) => ($('viewpanel').contains($('tools')) && $('viewmenu').classList.contains('folded')
  ? $('viewmenu').querySelector('.menu-btn') : $(id));

// a folded menu with nothing it could do is disabled, like its items
function syncMenuButtons() {
  $('showmenu').querySelector('.menu-btn').disabled = ['isolate', 'hide', 'showall', 'undo'].every((id) => $(id).disabled);
  // (Copy view link is in it too: a model opened from a URL has nothing to
  // save, and its link is then the menu's one live item)
  $('filemenu').querySelector('.menu-btn').disabled = $('export').disabled && $('sharelink').disabled && $('download').hidden && $('checklist').hidden && $('exportmesh').querySelector('button').disabled && $('savepic').disabled && $('savedrawing').disabled && $('addmodelbtn').disabled && $('gallerybtn').hidden
    && !$('filepanel').contains($('open')) && ($('modellist').hidden || !$('filepanel').contains($('modellist')));
}

function toolbarFits(tb) {
  if (getComputedStyle(tb).flexWrap === 'nowrap') return tb.scrollWidth <= tb.clientWidth + 1;
  const cs = getComputedStyle(tb);
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  let row = 0;
  for (const el of tb.querySelectorAll('button, select, label.btn, a.btn, input')) row = Math.max(row, el.offsetHeight);
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
  // File is a menu at every width: it holds Save .cadmesh, Copy view link,
  // Save picture, Export, Save drawing, Browse models and Download, which
  // standing in a wide row folded the view presets even at 1920 px
  for (const id of MENUS) $(id).classList.toggle('folded', id === 'filemenu' || id === 'displaymenu');
  // Measure stands in the row after Fit (back there before measuring)
  placeMeasure(false);
  tb.classList.add('measuring');
  // the model list is a step of its own, after View and before Show: it
  // folds into File's panel (it stood outside every group, so the wide row
  // could not shed it: review r16 L3). On a page given a list the list is
  // how a visitor finds the other models, so View folds first: before View
  // it folded on a 1024 px tablet whose row had room for it once View had
  // (live end-to-end review). At 1280 px it fits beside a folded File.
  // The tools (Measure, Section, Explode) show their names where the row has
  // room; before View folds they drop to their icons (as on a phone), which
  // keeps View and a model list in a 1280 px row and a 1024 px tablet's.
  $('tools').classList.remove('compact');
  // The page's name goes next, before View: a 1280 px row with a model list
  // and ? and Full screen at its end had room for View only without it
  tb.classList.remove('notitle');
  // Show folds before the model list: its four buttons do nothing until a
  // part is selected, while the list is how a visitor reaches the other
  // models (UI organization review rank 6)
  for (const id of [FOLD_ORDER[0], 'tools', 'title', ...FOLD_ORDER.slice(1), 'modellist']) {
    if (toolbarFits(tb)) break;
    if (id === 'tools') {
      $('tools').classList.add('compact');
      continue;
    }
    if (id === 'title') {
      tb.classList.add('notitle');
      continue;
    }
    if (id === 'modellist') {
      // (into File: first there, or after Open… where Open… is File's)
      if (!$('modellist').hidden) {
        if (narrow) $('open').parentElement.after($('modellist')); else $('fhopen').after($('modellist'));
      }
      continue;
    }
    $(id).classList.add('folded');
  }
  // the last step: a row that still does not fit (a 320 px phone with touch
  // targets: 348 px) takes Measure into View's panel, as its first item (M
  // still reaches it)
  if (!toolbarFits(tb) && $('viewmenu').classList.contains('folded')) placeMeasure(true);
  // a folded View holds the presets as its panel's grid, and Display's items,
  // not menus in a menu
  if ($('viewmenu').classList.contains('folded')) for (const id of ['presetmenu', 'displaymenu']) $(id).classList.remove('folded');
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
    if (focusFirst) [...panel.querySelectorAll('button:not(:disabled), select, label.btn, a.btn')].find((e) => e.getClientRects().length)?.focus();
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
  const all = [...$('tb').querySelectorAll('button, label.btn, a.btn')];
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
  // (the info block's Details fold is not a place to land: it is rebuilt
  // with the values on every selection)
  const all = [...$('parts').querySelectorAll('button, summary, input[type=color], #tree .label[tabindex="0"]')]
    .filter((e) => !e.closest('#infomore'));
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
      const b = e.target.closest('button, label.btn, a.btn');
      if (!b) return;
      const back = e.detail === 0 && focusIn;
      // in the row: an item that disabled itself (Hide, Undo) gives the focus
      // to its neighbour, not to the page (review r19)
      if (!m.classList.contains('folded')) { if (back && b.disabled) focusBeside(b); return; }
      // (a toggle, and a disclosure -- Save picture's ▾ -- leave it open)
      if (b.hasAttribute('aria-pressed') || b.hasAttribute('aria-expanded')) return;
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
  // The bar came or grew over a view still as Fit left it: fit again, above
  // the bar. A tight fit put a model's near corner under a bar that appeared
  // later (Measure turned on), where no click can reach it. A bar that goes
  // or shrinks covers nothing: the view stays (closing a tool must not move it).
  if (!card && app.header && atLastFit() && Math.min(optbarHeight(), $('stage').clientHeight - 1) > app.lastFit.bar) fitTo(app.lastFit.bbox);
}

// the camera is where the last Fit put it (nothing has moved it since)
function atLastFit() {
  const f = app.lastFit, c = app.cam;
  return !!f && !!app.header && c.q === f.q && c.dist === f.dist && c.target.every((v, k) => v === f.target[k]);
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
  else if (axis === 'off') toolFocus('section').focus();
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
  // the name and the counts in spans of their own: the narrow footer drops
  // the counts (the info panel has them), so a phone shows the whole name
  // (it read "Le Potato AML-S905X-CC · 2,833 bodies…": feature review 2026-10-29)
  const nm = document.createElement('span');
  nm.className = 'mname';
  nm.textContent = label;
  const st = document.createElement('span');
  st.className = 'mstats';
  st.textContent = ` · ${fmtInt(s.meshes)} ${s.meshes === 1 ? 'body' : 'bodies'} · ${fmtInt(s.triangles)} triangles`;
  $('model').replaceChildren(nm, st);
  $('model').title = entry ? `${$('model').textContent} (${app.sourceName})` : $('model').textContent; // the narrow footer truncates it
  document.title = `${label} — ${SHORT_TITLE}`;
  // the 3D view's name, for a screen reader: what it shows, and how to move it
  const b = app.header.bbox;
  const size = b ? `${[0, 1, 2].map((k) => lenNum(b.max[k] - b.min[k], 'size')).join(' by ')} ${lenUnit()}` : '';
  $('view').setAttribute('aria-label', `3D view of ${label}${size ? `, ${size}` : ''}, ${fmtInt(s.meshes)} ${s.meshes === 1 ? 'part' : 'parts'}. `
    + 'Arrow keys turn it, Shift and the arrows pan, plus and minus zoom; 1, 3, 7 and 0 set the views.');
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
  $('gallerybtn').hidden = entries.length < 2; // Browse models: a list to browse
  syncModelList();
  refold();
  showModelName(); // a model shown before the list came is named from it now
  if (app.header) applyListEntry(); // ...and given what its entry says
  // and turned as its entry says, if the view is still the one it opened at
  // (the camera's orientation untouched: a pan or a zoom is not kept, an orbit,
  // a preset or a view link is)
  if (app.header && app.cam.q === app.loadQ && orientFor(app.sourceUrl) !== app.cam.orient) {
    app.cam.orient = orientFor(app.sourceUrl);
    updateButtons();
    showInfo(); // above / below are along the new up
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
  const e = listEntry(src);
  return (e && e.orient) || (url && app.urlOrient) || app.userOrient;
}

// Where a list's note for a part goes: the top of that part, at the middle of its box, along
// the view's up; null for a name the model does not have. The part is named as a list's "hide"
// and a tour's callouts name one (js/tour.js resolveParts: a label, any case, a path, "#<id>")
function notePoint(part) {
  if (!part || !app.header) return null;
  return topOf(tourParts([part]).ids);
}

// The top of these bodies along the model's up axis, at their middle: where
// a note pinned to a part sits
function topOf(ids) {
  return topOfBox(ids && ids.length ? bboxOf(ids) : null);
}
function topOfBox(b) {
  if (!b) return null;
  const up = orientUp(app.cam.orient);
  const k = up.findIndex((v) => v !== 0);
  const p = [0, 1, 2].map((j) => (b.min[j] + b.max[j]) / 2);
  p[k] = up[k] > 0 ? b.max[k] : b.min[k];
  return p;
}

// The model list's entry for a model URL (js/model-list.js), or null
function listEntry(src) {
  let url = null;
  try { url = src ? new URL(src, location.href).href : null; } catch { /* no URL */ }
  return (url && (app.listEntries || []).find((x) => x.url === url)) || null;
}

// What the list says of the model on screen: its step, page, author,
// license, labels, style; the info panel, File and the tree show them. Run
// on a load and when a list arrives after its model opened.
function applyListEntry() {
  const e = app.header ? listEntry(app.sourceUrl) : null;
  // Download STEP: the entry's source file, else the file itself when the
  // model was opened from a STEP / IGES / BREP URL -- an http(s) one or this
  // page's own (a ?src=data:… one is never handed back as a link)
  let own = null;
  try { own = app.sourceUrl ? new URL(app.sourceUrl, location.href) : null; } catch { /* no URL */ }
  // (by the readers' one rule, js/same-place.js: not URL.origin, which is "null" for a file:
  // or data: URL and for every app scheme)
  if (own && !samePlace(own.href, location.href)) own = null;
  // (a CAD source by the one table, its name read as the loader reads it: "get?file=a.stp" too)
  const cadOf = (url) => { const f = formatOfName(fileNameOfUrl(url)); return f && f.kind === 'cad' ? f : null; };
  const src = e && e.step ? e.step : own && cadOf(own.href) ? own.href : null;
  const a = $('download');
  a.hidden = !src;
  if (src) {
    a.href = src;
    a.textContent = `Download ${(cadOf(src) || { label: 'STEP' }).label}`;
    a.title = `The source CAD file this model was made from: ${src}`;
  }
  // its tours: one File item each, under Open
  const tl = $('tourlinks');
  tl.textContent = '';
  for (const t of (e && e.tours) || []) {
    const b = document.createElement('button');
    b.textContent = `Tour: ${t.name}`;
    b.title = `Play the tour "${t.name}" of this model`;
    b.onclick = async () => {
      closeMenus();
      const r = await readTour(t.url);
      if (r.error) { failApart(`the tour ${r.error}`); return; } // (as ?tour='s: one handling, failApart -- r46 A5, r48 A1)
      startTourIn(r.tour, t.url);
    };
    tl.append(b);
  }
  // a listed model with a tour plays it as soon as the list names it: once
  // per model opened, never over a view link's view or ?tour='s own tour
  // (the visitor's ✕ ends it for this model)
  // (keyed by the model's URL, not its data: a re-read in another unit is the same model opened,
  // and replayed the tour the visitor had closed; a new open of it resets the key: loadUrl)
  if (app.header && app.autoTourFor !== autoTourKey()) {
    if (app.pendingView || app.urlTourPending) app.autoTourFor = autoTourKey();
    else if (e && e.tours && e.tours.length && !app.tour) {
      app.autoTourFor = autoTourKey();
      const h = app.header;
      const t = e.tours[0];
      readTour(t.url).then((r) => { if (!r.error && app.header === h && !app.tour) startTourIn(r.tour, t.url); });
    }
  }
  syncMenuButtons();
  // its part labels, when they differ from what the tree shows
  const labels = (e && e.labels) || null;
  if (app.header && JSON.stringify(labels) !== JSON.stringify(app.partLabels || null)) {
    app.partLabels = labels;
    app.tourIdxFor = null; // (part names resolve by label too: tourParts)
    buildTree();
  }
  // its hidden parts (a heatsink over the chips), once per model opened and
  // not over a view link's view; ahead of its tour, which starts from them
  // (keyed as the auto tour is, by the model's URL: a re-read in another unit is not a new open,
  // and laid the list's hide over the visitor's own hide / show)
  if (app.header && e && e.hide && app.listHideFor !== autoTourKey() && !app.pendingView) {
    app.listHideFor = autoTourKey();
    const ids = tourParts(e.hide).ids;
    if (ids.length) {
      for (const id of ids) app.hidden.add(id);
      syncTreeChecks();
      pushState();
      updateButtons();
      viewChanged();
    }
  }
  // its notes, where the model has none yet (a view link's come first)
  if (app.header && e && e.notes && app.measure && !app.measure.notes().length) {
    // (a note's "at" is written for the mm reading: scaled to this one, as a tour's callouts are --
    // after "this file is in: in" it floated 25.4 times off its part)
    const k = readingScale(tourReading());
    app.measure.setNotes(e.notes.map((n) => ({ p: n.at ? n.at.map((x) => x * k) : notePoint(n.part), text: n.text })).filter((n) => n.p));
  }
  // its style, where this browser has no choice of its own
  if (app.header) {
    $('style').value = currentStyle().id;
    syncStyleBg();
    queueFrame();
  }
  showInfo();
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

// Open a model of the list: the drop-down names it from the start, and the
// download's card shows its entry's picture
function loadListed(url) {
  const img = listEntry(url)?.image;
  $('pimg').hidden = !img;
  $('pimg').onerror = () => { $('pimg').hidden = true; }; // (served without CORS: no picture)
  if (img) $('pimg').src = img;
  const p = startLoad(() => loadUrl(url));
  const mine = { url, seq: app.loadSeq };
  app.listPending = mine;
  syncModelList();
  return p.finally(() => {
    if (app.listPending === mine) { app.listPending = null; $('pimg').hidden = true; }
    syncModelList();
  });
}

// File > Browse models: the list as pictures (an entry's image, else a
// placeholder) with their names; a pick opens it, Esc or × closes
function openGallery() {
  const grid = $('gallerygrid');
  grid.replaceChildren();
  const cur = listedNow();
  for (const e of app.listEntries || []) {
    const b = document.createElement('button');
    b.type = 'button';
    if (e.url === cur) b.setAttribute('aria-current', 'true');
    const placeholder = () => {
      const d = document.createElement('span');
      d.className = 'noimg';
      d.setAttribute('aria-hidden', 'true'); // the name says it; the glyph is decoration
      d.textContent = '▢';
      return d;
    };
    if (e.image) {
      const im = new Image();
      im.crossOrigin = 'anonymous'; // the page is cross-origin isolated
      im.loading = 'lazy';
      im.alt = '';
      // a picture its site does not serve with CORS cannot load here: the
      // placeholder, not a broken-image icon
      im.onerror = () => im.replaceWith(placeholder());
      im.src = e.image;
      b.append(im);
    } else b.append(placeholder());
    const t = document.createElement('span');
    t.textContent = e.name;
    b.append(t);
    b.onclick = () => { closeGallery(false); if (e.url !== listedNow()) openListed(e.url); };
    grid.append(b);
  }
  closeMenus();
  $('gallery').hidden = false;
  (grid.querySelector('[aria-current]') || grid.firstElementChild)?.focus();
}
function closeGallery(focusBack = true) {
  if ($('gallery').hidden) return false;
  $('gallery').hidden = true;
  if (focusBack) ($('filemenu').classList.contains('folded') ? $('filemenu').querySelector('.menu-btn') : $('gallerybtn')).focus();
  return true;
}

let listPick = 0;
// refocus: a keyboard pick made inside the narrow layout's File menu gives
// the focus to File's button as the menu closes (it fell to the page)
function openListed(url, refocus = false, keepMenu = false) {
  const before = location.href;
  const u = new URL(before);
  setModelParam(u, url);
  u.hash = ''; // a view of the last model is not a view of this one
  // a pick is a step in the history: Back opens the model before it again
  // (feature review item 21; it replaced the entry, so Back left the page)
  if (u.href !== before) history.pushState({ cadvPick: true }, '', u);
  app.pendingView = null;
  if (!keepMenu) closeMenus(refocus); // the narrow layout's File menu: the pick is made
  const pick = ++listPick;
  loadListed(url).then(() => {
    // failed or cancelled, and no newer pick: the address and the drop-down
    // name the model still shown, so the pick can be made again (and the
    // step it pushed is taken back, so Back does not land on it)
    if (pick !== listPick || app.sourceUrl === url) return;
    if (location.href === u.href) {
      if (history.state && history.state.cadvPick) { app.skipPop = true; history.back(); } else history.replaceState(null, '', before);
    }
    syncModelList();
  });
}

// Back / Forward between list picks: the entry's ?src opened again (and its
// #view=, applied when it has), unless it is the model shown
function wireHistory() {
  window.addEventListener('popstate', () => {
    if (app.skipPop) { app.skipPop = false; return; }
    // (an entry with no ?src is the page as first opened, which opened the
    // list's first model)
    const src = modelUrlIn(new URLSearchParams(location.search)) || app.listEntries?.[0]?.url;
    if (!src || src === app.sourceUrl) { syncModelList(); return; }
    let view = null;
    if (location.hash.startsWith('#view=')) {
      try { view = decodeView(decodeURIComponent(location.hash.slice(6))); } catch { /* a bad link: no view */ }
    }
    app.pendingView = view ? { src, view } : null;
    listPick++;
    loadListed(src);
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

// The cut at a position along its axis (mm, model coordinates), clamped to the
// model's extent
function setSectionAtMm(mm) {
  const s = app.section;
  if (s.axis === 'off' || !app.header) return;
  const k = { x: 0, y: 1, z: 2 }[s.axis];
  const { min, max } = sectionBox();
  s.t = max[k] > min[k] ? Math.min(1, Math.max(0, (mm - min[k]) / (max[k] - min[k]))) : 0.5;
  updateButtons();
  viewChanged();
}

// The readout turned into a field: type the cut position in the display
// unit, Enter puts the cut there, Esc (or leaving it) keeps it where it was
function secEdit() {
  const p = sectionPlane();
  if (!p || app.secEditing) return;
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.step = 'any';
  inp.id = 'secin';
  inp.value = lenNum(p[3] * (app.section.flip ? -1 : 1), 'section');
  inp.setAttribute('aria-label', `Cut position along ${app.section.axis.toUpperCase()}, in ${lenUnit()} (Enter puts the cut there)`);
  app.secEditing = true;
  $('secval').replaceChildren(inp);
  inp.focus();
  inp.select();
  let over = false;
  const done = (apply) => {
    if (over) return;
    over = true;
    app.secEditing = false;
    const v = Number(inp.value);
    if (apply && inp.value.trim() && Number.isFinite(v)) setSectionAtMm(geomMm() ? v * MM_PER[curUnit()] : v);
    else updateButtons();
    $('secval').focus();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
  });
  inp.addEventListener('blur', () => done(false));
}

function wireOptbar() {
  $('secval').addEventListener('click', secEdit);
  $('secval').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === $('secval')) { e.preventDefault(); secEdit(); } });
  $('secsel').onclick = () => {
    const b = app.selected.size && drawnBox([...app.selected]);
    if (!b) return;
    const k = { x: 0, y: 1, z: 2 }[app.section.axis];
    setSectionAtMm((b.min[k] + b.max[k]) / 2);
  };
  $('section').onclick = () => {
    closeMenus();
    setSection(app.section.axis === 'off' ? app.section.last : 'off', true);
  };
  $('secoff').onclick = () => setSection('off', true);
  for (const b of document.querySelectorAll('[data-axis]')) b.onclick = () => setSection(b.dataset.axis);
  // Explode
  $('explode').onclick = () => { closeMenus(); setExplode(!app.explode.on, true); };
  $('xpoff').onclick = () => setExplode(false, true);
  for (const b of $('xpmode').querySelectorAll('button')) b.onclick = () => setExplodeMode(b.dataset.mode);
  $('xppos').addEventListener('input', () => {
    app.explode.t = Number($('xppos').value) / 100;
    syncExplodeSphere();
    $('xpval').textContent = `${$('xppos').value} %`;
    $('xppos').setAttribute('aria-valuetext', `${$('xppos').value} %`);
    viewChanged();
  });
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
  $('fit').disabled = !has && !app.dxf;
  // (a button about to disable hands the focus on, as Hide's does)
  if (!has && app.measure && app.measure.on) app.measure.setOn(false);
  $('measure').disabled = !has && !app.dxf;
  // Explode: on every renderer (the directions as a table texture or an attribute); off with no model
  if (!has && app.explode.on) { app.explode.on = false; syncExplodeSphere(); $('xpopt').hidden = true; }
  $('explode').hidden = !app.renderer;
  $('explode').disabled = !has;
  $('explode').setAttribute('aria-pressed', String(app.explode.on));
  for (const b of $('exportmesh').querySelectorAll('button')) b.disabled = !has;
  $('tourmake').disabled = !has;
  $('addmodelbtn').disabled = !has || !app.scene;
  $('savepic').disabled = !has && !app.dxf;
  $('printbtn').disabled = $('savepic').disabled;
  // (a drawing saves its own canvas: the options are the 3D view's)
  $('picmore').disabled = !has || !!app.dxf;
  if ($('picmore').disabled) setPicOpts(false);
  // (the drawing needs the b-rep faces: a .cadmesh written before they were kept has none)
  $('savedrawing').disabled = !has || !(app.baseMesh && app.baseMesh.faces);
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
  // (not while its position is being typed: secEdit)
  if (!app.secEditing) $('secval').textContent = p ? `${app.section.axis.toUpperCase()} = ${lenNum(p[3] * (app.section.flip ? -1 : 1), 'section')} ${lenUnit()}` : '';
  $('secsel').disabled = !on || !app.selected.size;
  // a screen reader speaks the cut position, not the slider's 0-1000 step
  if (p) $('secpos').setAttribute('aria-valuetext', $('secval').textContent);
  else $('secpos').removeAttribute('aria-valuetext');
  // the part colour: on with a selection, showing the first selected body's
  // colour; Reset only while a selected body has a picked colour
  const sel = app.header ? [...app.selected] : [];
  // (Paint on: the swatch is the paint's colour, selection or not)
  $('partcolour').disabled = !sel.length && !app.paintFaces;
  if (sel.length && !app.paintFaces) $('partcolour').value = rgbToHex(partColourOf(sel[0]));
  $('paintbtn').disabled = !(app.baseMesh && app.baseMesh.faces);
  const all = !sel.length;
  $('partreset').disabled = all ? !ownOverrides().size && !ownFaces().size : !sel.some((id) => ownOverrides().has(id - 1));
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
  // a: the body is closed (closedOf), for the cut fill in the paper styles
  const n = app.header ? app.header.meshes.length : 0;
  for (let i = 0; i < n; i++) if (closedOf(app.baseMesh, i)) bytes[(i + 1) * 4 + 3] = 255;
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
  // (every load's card offers Cancel: hidden for a list's own read, it stayed hidden over a file the
  // visitor opened during it, a large STEP's conversion then not to be stopped -- r52 Q7)
  if ($('pcancel')) $('pcancel').hidden = false;
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
  setPref('cadv.palette', id);
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
    tellReady(`could not recolour: ${e.message || e}`);
  });
}

// The colour of the selected parts: pick one (every selected body takes it),
// or reset them to the scheme's colours. Kept for this model while it is open.
function setPartColour(hex) {
  if (!app.selected.size) return;
  const c = hexToRgb(hex);
  // (shown now, and -- in a tour -- kept as the visitor's own, which leaving the tour puts back)
  for (const id of app.selected) { app.overrides.set(id - 1, c); if (app.tour) app.tour.base.overrides.set(id - 1, c); }
  saveOverrides();
  updateButtons();
  recolour(`${app.selected.size} part${app.selected.size > 1 ? 's' : ''} recoloured`);
}

// Reset: the selected parts' picked colours, or with nothing selected every
// picked colour of this model; the parts take the scheme's colours again
function resetPartColour() {
  let n = 0;
  const own = ownOverrides(), faces = ownFaces();
  if (app.selected.size) {
    for (const id of app.selected) { if (own.delete(id - 1)) n++; if (!app.tour) app.overrides.delete(id - 1); }
  } else {
    n = own.size + faces.size;
    own.clear();
    faces.clear(); // and the painted faces
  }
  saveOverrides();
  // in a tour, the visitor's colours are under the step's: the step is drawn again from them (its
  // colours and dimming kept; clearing the shown map dropped the step's emphasis mid-tour)
  if (app.tour) applyStepState(app.tour.tour.steps[app.tour.i]);
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
  clearModel();
  app.error = msg;
  setStatus('error', msg);
}

// The 3D model gone from the UI and the GPU (a failed load; a DXF opened)
function clearModel() {
  app.mesh = null;
  showBase(null, [], 'stopped: another model was opened');
  app.scene = null;
  app.overrides = new Map();
  app.modelKey = '';
  endTour(false);
  app.header = null;
  app.wanted = null;
  app.sphere = { center: [0, 0, 0], radius: 1 };
  app.selected.clear();
  app.ref = null;
  app.holesFor = null;
  app.partLabels = null;
  // (and the cleared model's bytes and part data: a drawing shown next held them until the next 3D load)
  app.meshSource = null;
  app.stepMeta = null;
  $('download').hidden = true;
  $('sheetsrow').hidden = true;
  $('view').setAttribute('aria-label', '3D view: no model open');
  if (app.measure) app.measure.reset(true); // (Measure too: a drawing has its own)
  // the tools that belong to the model shown go with it -- the section's cut,
  // Walk's viewpoint, Paint -- or a 2D drawing (or the next model) opens with
  // them on and their controls hidden (Explode is reset where the new mesh
  // lands; a view link sets the section again after this). Turntable and the
  // Display looks are preferences and stay.
  app.section.axis = 'off';
  app.explode.on = false;
  app.explode.for = null;
  $('xpopt').hidden = true;
  if (app.walk) { app.walk = false; $('walk').setAttribute('aria-pressed', 'false'); }
  if (app.paintFaces) setPaint(false);
  app.hidden.clear();
  app.visUndo = [];
  app.hover = 0;
  app.hoverSeq++;
  app.viewGen++;
  app.lastStepBuffer = null;
  app.unmeshedFaces = 0;
  // and what loadBuffer set for it: no link to a model not shown (its edge builds stopped above)
  app.sourceUrl = null;
  app.stats = null;
  syncModelList();
  $('sharelink').disabled = true;
  syncMenuButtons();
  $('export').disabled = true;
  $('tree').textContent = '';
  $('treefilter').hidden = true;
  updateButtons();
  clearHover();
  $('model').textContent = '';
  document.title = BASE_TITLE;
  $('model').title = '';
  showInfo();
  gpuSync().catch(() => {});
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
// converter returned without triangles, named in the info panel and read out
// with the ready line, and whether it ran on the multi-core converter.
async function loadBuffer(buf, name, seq, stepBuf = null, conversion = null) {
  const unmeshedFaces = conversion?.unmeshedFaces || 0;
  // Each step names itself (the loading card) and lets that paint first:
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
  // (faces the converter could not mesh are not "no faces": r23; the words js/cadmesh.js noSurfaces)
  const none = noSurfaces(base.header.indexCount, name, conversion && conversion.unmeshedFaces);
  if (none) throw new Error(none);
  // File > Add model… (or ?add=): merged into the scene beside the shown model
  if (app.adding && app.adding.seq === seq) return addToScene(base, name, seq);
  // one holder, shared by every palette copy made from base (they spread it)
  base.edgeInfo = { value: null, ready: null };
  // part colours belong to the model they were picked on: this model's own
  const key = modelKeyOf(base.header);
  const overrides = loadOverrides(key, base.header.meshes.length);
  const mesh = inScheme(base, overrides, new Map()); // (painted faces are the old model's)
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
  if (app.clearanceRun) app.clearanceRun.stop(); // (and a clearance run of the scene before)
  leave2D(); // a 3D model replaces a drawing shown
  app.mesh = mesh;
  // (the edge builds of the model or scene this one replaces have no one to answer)
  showBase(base, [base], 'stopped: another model was opened');
  app.overrides = overrides;
  app.faceOverrides = new Map();
  if (app.paintFaces) setPaint(false);
  app.stepMeta = app.stepMetaOf && app.stepMetaOf.seq === seq ? app.stepMetaOf.map : null;
  app.modelKey = key;
  endTour(false); // a tour plays over the model it was started on
  app.header = mesh.header;
  app.sphere = sphereOf(mesh.header.bbox);
  app.sphereBase = app.sphere; // (Explode grows app.sphere from it)
  app.explode.on = false; // a new model opens together
  app.explode.for = null;
  // nor with the last one's cut or Walk viewpoint (a view link sets the
  // section again below; updateButtons syncs the section's controls)
  app.section.axis = 'off';
  if (app.walk) { app.walk = false; $('walk').setAttribute('aria-pressed', 'false'); }
  app.sourceName = name;
  // the URL it came from, for a view link (null: a local file, which a link cannot carry)
  app.sourceUrl = app.urlOfLoad && app.urlOfLoad.seq === seq ? app.urlOfLoad.url : null;
  // the models in the view: this one alone (Add model… appends)
  app.scene = [{ base, name, url: app.sourceUrl, offset: [0, 0, 0] }];
  app.meshSource = null; // (a unit-less mesh file sets it again after: meshFromSource)
  syncUnitParam(); // (another model's ?unit= is not this one's)
  $('clearval').textContent = '';
  forgetAddressModel();
  app.lastStepBuffer = stepBuf;
  app.unmeshedFaces = unmeshedFaces;
  $('export').disabled = !stepBuf;
  $('sharelink').disabled = false;
  syncModelList();
  syncMenuButtons(); // a folded Save menu now has something in it
  app.selected.clear();
  app.ref = null; // a part of the old model is no reference for this one
  app.holesFor = null;
  if (app.measure) app.measure.reset(); // nor are its measurements and holes
  app.hidden.clear();
  app.visUndo = [];
  app.hover = 0;
  app.hoverSeq++; // a hover answer computed against the old model must not apply
  app.viewGen++; // and neither may a click aimed at it
  clearHover();
  pushState();
  // the model list's labels before the tree is built (it is built once)
  app.partLabels = listEntry(app.sourceUrl)?.labels || null;
  buildTree();
  syncSheets(); // the flat-sheets row, for this model
  app.cam.orient = orientFor(app.sourceUrl);
  setView('iso');
  app.loadQ = app.cam.q; // the view it opened at (fillModelList)
  // (recolour refuses while an upload is under way, so the pick waited here)
  if (app.palette !== scheme) recolour();
  // a view link (#view=…) applies to the model the page opened with; a link
  // with no ?src (its model was opened from a device) to the next one opened
  // from a device, never to a model list's first (review r16 M2)
  // (with ?add= models still to come, after them: its ids are the scene's)
  if (app.pendingView && !app.addsPending && (app.pendingView.src ? app.sourceUrl === app.pendingView.src : !app.sourceUrl)) {
    applyView(app.pendingView.view, true);
    app.pendingView = null;
  }
  const tris = mesh.header.indexCount / 3;
  app.stats = { meshes: mesh.header.meshes.length, triangles: tris, vertices: mesh.header.vertexCount,
    uploadMs: Math.round(performance.now() - t0), decodeMs: Math.round(decodeMs),
    inflateMs: Math.round(inflateMs), fileBytes: buf.byteLength, fetchMs: app.fetchMs ?? null, unmeshedFaces,
    converter: conversion ? (conversion.threads ? 'multi-core' : 'one thread') : null, convertMs: conversion?.ms ?? null,
    convertPhases: conversion?.phases ?? null };
  showModelName();
  showInfo();
  app.gpuLacks = null; // (this model is on the GPU: cannotHold's note of the one before goes)
  setStatus('ready', readyText()); // announced with the change into ready
  applyListEntry(); // its step, page, author, license, style from the model list
  touchHintOnce();
  // the facts' closed flags go into the state texture too (the cut fill)
  // (a build keeps its own on the model, edgesOf: a scene it joins merges them, a move builds nothing)
  base.edgeInfo.ready = edgesOf(base).then((v) => {
    if (app.baseMesh === base) { pushState(); showInfo(); } // (the facts: volume, area, mass)
    refreshEdges();
    return v;
  });
}

// a model's worker-built edges and facts, kept on it as a file's are (today's rule)
function keepEdges(base, v) {
  base.edges = v.edges;
  base.silhouettes = v.silhouettes;
  base.silhouetteNormals = v.silhouetteNormals;
  base.header.silhouettesOmitted = v.silhouettesOmitted || 0;
  base.header.facts = v.facts;
  base.header.factsRule = FACTS_RULE;
  // (a written failure gone with the facts built: never beside facts -- the decoder's rule, r45 A9)
  delete base.header.edgesFailed;
}

// A big CAD file on a phone (a touch-only device) is converted only once
// asked (feature review item 21): it can take minutes and more memory than
// the browser gives a tab, which then reloads the page with no word said.
// Resolves true to convert, false when cancelled or superseded. A saved
// conversion never asks (the cache is read before this).
const BIG_PHONE_MB = 20;
function askBigConversion(buf, name, seq) {
  const mbs = buf.byteLength / 1e6;
  // (app.bigAsk: { mb } makes any device ask past that size: tests/ui-checks.py)
  if (app.bigAsk ? mbs < app.bigAsk.mb : !coarseOnly() || mbs < BIG_PHONE_MB) return Promise.resolve(true);
  // the reference machine's time from the size alone, rounded up
  const secs = forecastTotal(forecast({ bytes: buf.byteLength }));
  const mins = Math.max(1, Math.ceil(secs / 60));
  setStatus('loading', `${name} is ${mbs.toFixed(0)} MB: convert it?`);
  showProgress(`Convert ${name}?`, 0, `${mbs.toFixed(0)} MB to convert on this device. A computer takes about ${mins} min; a phone takes several times that and may run out of memory, reloading the page.`,
    'Its .cadmesh, saved from a computer (File > Save .cadmesh), opens here in seconds.');
  $('pgo').hidden = false;
  announce(`${name} is ${mbs.toFixed(0)} MB: Convert anyway, or Cancel`);
  $('pgo').focus();
  return new Promise((resolve) => {
    const finish = (v) => { clearInterval(t); $('pgo').hidden = true; $('pgo').onclick = null; resolve(v); };
    // Cancel (or any newer load) makes this load stale
    const t = setInterval(() => { if (stale(seq)) finish(false); }, 200);
    $('pgo').onclick = () => finish(!stale(seq));
  });
}

// ---------- more than one model (feature review item 18; js/scene.js) ----------
// app.scene: [{ base (the model as decoded), name, url, offset [x,y,z] mm }],
// the first the model opened, the rest added (File > Add model…, ?add=).
// With more than one, app.baseMesh is their merge: one top-level tree node
// per model, ids running on, so every body tool works across them. Moving an
// added model merges again (its ids stay the same).

// Start a load whose model joins the scene instead of replacing it
function startAdd(fn) {
  if (!app.scene) return Promise.resolve();
  return startLoad(() => {
    app.startingAdd = true; // (loadUrl, run by fn: an added model's load keeps the first's list keys)
    let p;
    try { p = fn(); } finally { app.startingAdd = false; }
    app.adding = { seq: app.loadSeq }; // (fn's beginLoad numbered it; loadBuffer reads this later)
    return p;
  });
}

async function addToScene(base, name, seq) {
  app.adding = null;
  if (!app.scene || stale(seq)) return;
  const url = app.urlOfLoad && app.urlOfLoad.seq === seq ? app.urlOfLoad.url : null;
  // (named as its model list entry names it, when one does)
  if (url && listEntry(url)?.name) name = listEntry(url).name;
  if (app.scene.length === 1 && app.scene[0].url && listEntry(app.scene[0].url)?.name) app.scene[0].name = listEntry(app.scene[0].url).name;
  const models = [...app.scene, { base, name, url, offset: app.addOffset ? app.addOffset.slice() : [0, 0, 0] }];
  app.addOffset = null;
  setStatus('loading', `adding ${name}`);
  showProgress(`Adding ${name}`, null, `uploading ${fmtInt(base.header.indexCount / 3)} more triangles to the GPU`);
  await nextPaint();
  if (stale(seq)) return;
  if (!(await showScene(models, { newTree: true }))) return;
  setView('iso');
  setStatus('ready', readyText());
  announce(`${name} added: ${models.length} models in the view`);
}

// Draw `models` as the scene: merged, uploaded, then made the shown model.
// newTree: the tree is built again (a model added); a move keeps the
// selection, the hidden parts and the tree. Resolves false if superseded.
async function showScene(models, { newTree = false } = {}) {
  // a tour plays over the model it was started on (as a new model ends it in loadBuffer): it is
  // left, the visitor's view put back, before the scene changes under its step
  endTour();
  const merged = mergeModels(models, { silhouetteCap: silhouetteCapHere() });
  merged.edgeInfo = { value: null, ready: null };
  // (gone: settles with GONE once another model or scene replaces this one -- showBase)
  merged.edgeInfo.gone = new Promise((res) => { merged.edgeInfo.leave = () => res(GONE); });
  const mesh = inScheme(merged, app.overrides);
  checkFits(app.renderer, mesh);
  app.wanted = mesh;
  try {
    await gpuSync();
  } catch (e) {
    handBack(mesh);
    throw e;
  }
  if (app.wanted !== mesh) return false; // a newer load or move took the GPU
  if (app.clearanceRun) app.clearanceRun.stop();
  app.scene = models;
  // (a clearance read is of the scene before: cleared here, where every scene change passes --
  // Add model kept "1.65 mm" for a scene whose new case touched)
  $('clearval').textContent = '';
  $('clearval').title = '';
  app.lastClearance = null;
  // "this file is in" re-reads the first model alone, which would drop the others: a scene has
  // none (a mesh opened alone gets it again)
  if (models.length > 1) app.meshSource = null;
  syncUnitParam(); // (the first model's unit stays in the address: readUnit)
  app.mesh = mesh;
  // (the builds of models this scene still holds go on: a move changes none of them)
  showBase(merged, models.map((m) => m.base), 'stopped: the scene changed');
  app.header = mesh.header;
  // (part colours are kept by index: the first model's stay its own; a
  // scene's are not saved, so its later indices never land on that model)
  app.modelKey = '';
  app.sphere = sphereOf(mesh.header.bbox);
  app.sphereBase = app.sphere;
  app.explode.on = false;
  app.explode.for = null;
  $('xpopt').hidden = true;
  app.holesFor = null;
  $('holes').hidden = true;
  app.lastStepBuffer = null; // (Save .cadmesh writes one converted file, not a scene)
  $('export').disabled = true;
  app.hover = 0;
  app.hoverSeq++;
  app.viewGen++;
  if (app.measure) app.measure.reset(); // its points were on bodies that may have moved
  app.sourceName = models.map((m) => m.name).join(' + ');
  if (newTree) {
    app.selected.clear();
    app.hidden.clear();
    app.visUndo = [];
    app.ref = null;
    buildTree();
    syncSheets();
  }
  pushState();
  const tris = mesh.header.indexCount / 3;
  if (app.stats) Object.assign(app.stats, { meshes: mesh.header.meshes.length, triangles: tris, vertices: mesh.header.vertexCount });
  showModelName();
  showInfo();
  updateButtons();
  queueFrame();
  merged.edgeInfo.ready = sceneEdges(merged, models).catch((e) => {
    // (a backstop: sceneEdges catches the merge's failure itself and nothing known throws past it;
    // anything that did would be said on the panel, never a rejection nobody handles -- r41 Q3)
    merged.edgeInfo.error = String(e?.message || e);
    return merged.edgeInfo.value;
  }).then((v) => {
    if (app.baseMesh === merged) { pushState(); showInfo(); }
    refreshEdges();
    return v;
  });
  return true;
}

// A scene's edges and facts: each model without today's built on its own, unmoved, one after
// another (and kept on it: a move or the next Add model then builds nothing), and the scene's
// merged from the models' (js/scene.js sceneEdgesFacts). (The whole scene built on its moved
// float32 copy and split back gave a model moved 100,000 mm a volume 1 % low, and rebuilt every
// model already current.) A model whose build fails or is stopped leaves the scene without.
async function sceneEdges(merged, models) {
  const stale = staleModels(models);
  const cap = silhouetteCapHere();
  // (the edges in hand -- every model carries its own -- drawn now, as a model's alone are; the
  // facts to come: the scene drew nothing until every build had settled -- r40 Q3)
  if (stale.length && merged.edges && !merged.edgeInfo.value) {
    merged.edgeInfo.value = fileEdgesValue(merged, cap);
    if (app.baseMesh === merged) refreshEdges();
  }
  const failed = [];
  for (const m of stale) {
    m.base.edgeInfo ||= { value: null, ready: null, error: null };
    // (a scene replaced while it waits ends here, merging nothing: each move typed during a
    // build kept the whole scene before it, about 85 MB a move, until the build ended)
    const v = await Promise.race([edgesOf(m.base), merged.edgeInfo.gone]);
    if (v === GONE) return null;
    // (a build keeps its own on its model, edgesOf; a model's failure noted and the others built
    // on -- stopping at it left a later model without its edges, and the scene without any)
    if (!v?.facts) failed.push(m);
  }
  // (merged again only when a model's were built here: mergeModels merged them already; a merge
  // that fails -- it allocates the scene's arrays again -- is the scene's failure, said, not a
  // rejection nobody handles that left the panel at "computing…": r41 Q3)
  // (mergeModels' own merge failing is the same failure: js/scene.js keeps its error on the scene)
  let mergeError = merged.mergeError || null;
  if (stale.length) {
    try {
      sceneEdgesFacts(merged, models, { silhouetteCap: cap });
      mergeError = null;
    } catch (e) {
      mergeError = e;
    }
  }
  // (with the models that failed, not in their place: a model's failure remembered, then the merge's
  // of the moment, advised a move that could never give the scene its facts -- r42 A1, Q2)
  if (mergeError) failed.push({ name: 'the scene\'s merge', merge: true, base: { edgeInfo: { error: String(mergeError?.message || mergeError), failed: !momentaryFailure(mergeError), stopped: false } } });
  if (!failed.length) return edgesOf(merged);
  return sceneFailed(merged, failed, cap);
}

// A scene whose facts are missing: its state from every model that failed (the first's alone gave
// "move a model to try again" while a later one's failure was remembered, and left a later one's
// first failure unsaid: r41 A2, Q1) -- remembered if any is (no try can then give the scene its
// facts), stopped only if all were; its error the first's, its model named, the others counted
function sceneFailed(merged, failed, cap) {
  const infos = failed.map((m) => m.base.edgeInfo);
  // (the merge's failure named as itself, not counted as a model: r43 A6)
  const others = failed.slice(1), n = others.filter((m) => !m.merge).length;
  const also = [n && `${n} more model${n > 1 ? 's' : ''}`, others.some((m) => m.merge) && 'the scene\'s merge'].filter(Boolean);
  const more = also.length ? ` (and ${also.join(', ')})` : '';
  Object.assign(merged.edgeInfo, { error: `${failed[0].name}: ${infos[0].error}${more}`, failed: infos.some((i) => i.failed), stopped: infos.every((i) => i.stopped) });
  // (the scene's edges still drawn when every model carries its own: only the facts are missing)
  merged.edgeInfo.value = merged.edges ? fileEdgesValue(merged, cap) : null;
  // (the word kept for the scene unless every failure is a stop -- the next scene owns a stop --
  // and told; worded by what is missing -- the edges are drawn when only the facts are. A move
  // with a failure said before kept no word, and its ready line read "ready": r42 Q3. Told again
  // after each move that leaves it -- the move the panel advises -- the same words not twice.)
  if (app.baseMesh === merged && !merged.edgeInfo.stopped) sayNoFacts(`${merged.edgeInfo.value ? 'no volume' : 'no edges'} for this scene: ${merged.edgeInfo.error}`);
  return merged.edgeInfo.value;
}

// A model's or a scene's edges in hand, as edgesOf resolves to them: its silhouettes under the
// device's cap (a scene's were capped by the merge: then none over), its facts only when built by
// today's rule (an older file's or kept conversion's volume was the signed sum, unflagged). (Built
// at two places, a model's and a scene's, that a field added to one would miss: r40 A5.)
function fileEdgesValue(base, cap) {
  const over = !!base.silhouettes && overSilhouetteCap(base.silhouettes.length / 2, cap);
  return { edges: base.edges, silhouettes: over ? null : base.silhouettes,
    silhouetteNormals: over ? null : base.silhouetteNormals,
    silhouettesOmitted: over ? base.silhouettes.length / 2 : (base.header.silhouettesOmitted || 0),
    facts: factsCurrent(base.header) ? base.header.facts : null, source: 'file', ms: 0 };
}

// The status line's word that the shown model or scene has no facts (app.noFacts, its text): kept,
// and so in every ready line (readyText), after the missing faces and the list's note (r40 Q8),
// until the shown model or scene changes -- showBase, its one owner, takes it back then (a model's
// facts arrive only in a build of its own, which a model or scene shown is given once: no other
// take-back can meet it -- r44 A5, Q4).
// sayNoFacts: the word kept whatever the line says now (a failure met while a load was under way,
// the load then cancelled, read "ready": r42 Q3), and told at once when it is new, whatever the line
// is (one that came during an export waited for the export's end, whose ready-to-ready line no one
// hears: r46 A1); written into the line in place only when it is the ready line, its own words
// after the ready text kept (a tour's note was lost: r43 A2) -- an export's progress is left alone.
function sayNoFacts(text) {
  const fresh = app.noFacts !== text; // (with a word said before, if any)
  if (fresh) tell(text, 6000);
  rewriteReady(() => { app.noFacts = text; });
}
// A word of the ready text changed (`change`: the missing facts' word, the list's note), and a ready
// line rewritten in place: the ready text before it replaced, the words other writers added after it
// kept; nothing written unless the page is ready and its line starts with that ready text. The one
// rule sayNoFacts, showBase and listsRead call (it was written out in each: r51 A8)
function rewriteReady(change) {
  const msg = app.statusMsg || '', before = readyText();
  change();
  if (app.status !== 'ready' || !msg.startsWith(before)) return;
  const line = readyText() + msg.slice(before.length);
  if (line !== msg) setStatus('ready', line);
}

// The one change of the shown model or scene (loadBuffer, showScene, clearModel): the edge builds
// of every model not kept stopped (why: the reason said), the scene shown before ended -- its
// sceneEdges still waiting on a build settles GONE -- then `next` shown. (Written out at three
// places in two orders, each one line a mutant could drop unseen.)
const GONE = Symbol('gone');
function showBase(next, keep, why) {
  stopEdgeJobs(new Set(keep), why);
  app.baseMesh?.edgeInfo?.leave?.();
  // (the "no volume" word of the one left taken back, the line's own words after it kept: a move
  // that gave the scene its facts kept "no edges for this scene" on the line -- r43 A1)
  if (app.noFacts) rewriteReady(() => { app.noFacts = null; });
  app.baseMesh = next;
}

// the info panel's volume while there are no facts: a build that failed or was stopped said, not
// "computing…" for good
// (the advice only where a try can work: a failure of the moment, not remembered -- a move builds
// the scene's stale models again, a model alone is opened again. None for a failure remembered --
// the model's own, no module worker, or the moment's past its tries -- which fails the same way
// again; "add the model again" left the failed one in the scene, whose facts need every model: r40
// A4, Q5)
const pendingVolume = (info, inScene) => (info?.error
  ? `not computed: ${info.error}${!info.failed && !info.stopped ? (inScene ? ' (move a model to try again)' : ' (open the file again to try again)') : ''}`
  : 'computing…');

// the device's silhouette cap: a coarse-pointer device's smaller one, else edges.js's
const silhouetteCapHere = () => (coarseOnly() ? COARSE_SILHOUETTE_CAP : SILHOUETTE_CAP);

// The info panel's models: each by name, the added ones with their offset
function syncScene() {
  const many = !!app.scene && app.scene.length > 1 && !!app.header;
  $('scene').hidden = !many;
  if (!many) return;
  const list = $('scenelist');
  // rebuilt only when the models change (a typed offset keeps its focus)
  const key = app.scene.map((m) => m.name).join('\n');
  if (list.dataset.key === key) {
    app.scene.forEach((m, i) => list.querySelectorAll('li')[i]?.querySelectorAll('input').forEach((inp, k) => {
      if (document.activeElement !== inp) inp.value = String(+m.offset[k].toFixed(3));
    }));
    return;
  }
  list.dataset.key = key;
  list.replaceChildren();
  app.scene.forEach((m, i) => {
    const li = document.createElement('li');
    const nm = document.createElement('span');
    nm.textContent = `${i + 1}. ${m.name}`;
    nm.title = m.name;
    li.append(nm);
    if (i > 0) {
      const at = document.createElement('div');
      at.append('moved by ');
      'XYZ'.split('').forEach((ax, k) => {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = 'any';
        inp.value = String(m.offset[k]);
        inp.setAttribute('aria-label', `${m.name}: move along ${ax} (mm)`);
        inp.title = `Move ${m.name} along ${ax}, in mm from where its file puts it`;
        inp.addEventListener('change', () => {
          const v = Number(inp.value);
          if (!Number.isFinite(v)) return;
          moveModel(i, k, v);
        });
        at.append(`${ax} `, inp, ' ');
      });
      at.append('mm');
      li.append(at);
    }
    list.append(li);
  });
}

// Move added model i along axis k to v mm from where its file puts it
let moveSeq = 0;
async function moveModel(i, k, v) {
  if (!app.scene || !app.scene[i] || i === 0) return;
  const models = app.scene.map((m, j) => (j === i ? { ...m, offset: m.offset.map((o, a) => (a === k ? v : o)) } : m));
  const mine = ++moveSeq;
  try {
    if (!(await showScene(models)) || mine !== moveSeq) return;
    announce(`${models[i].name} moved to ${models[i].offset.map((o) => +o.toFixed(3)).join(', ')} mm`);
  } catch (e) {
    tellReady(`could not move ${models[i].name}: ${e.message || e}`);
  }
}

// Clearance in js/clearance-worker.js, on copies of the model's arrays: two triangle trees over
// millions of triangles held the tab for seconds (9.6 M triangles, 10.8 s). A run started while
// one is going stops it (STOPPED). A run that failed in the worker run again on the page froze
// the tab and, when it threw, left the readout at "checking …" for good. Always settles.
const STOPPED = Symbol('stopped');

// One run of a module worker (the facts' js/edges-worker.js, Clearance's js/clearance-worker.js):
// make() builds the message and its transfer list (the model's copies: in a try -- they may not
// fit, a big model on a small device: said, not a rejected promise); the worker says it has
// started, so a failure before that is one that cannot start and after it the run's own. Settles
// once, the worker ended: { ok: data } | { error, transient? } (transient: a failure of the
// moment -- no room for the copy, a worker that died, a failure the worker says the moment's
// (js/edges.js momentaryFailure) -- tried again at the next ask, edgesOf up to MOMENT_TRIES) |
// { stopped: why } | { noWorker: why }; each
// caller says what no worker means for its job. (Each worker had its own launch, and a copy that
// failed had to be fixed in each.)
function workerJob(file, make) {
  let stopIt = () => {};
  const promise = new Promise((resolve) => {
    let w;
    try { w = new Worker(new URL(file, import.meta.url), { type: 'module' }); } catch (e) { resolve({ noWorker: String(e?.message || e) }); return; }
    let finished = false, started = false;
    const finish = (v) => { if (finished) return; finished = true; w.terminate(); resolve(v); };
    stopIt = (why) => finish({ stopped: why || 'stopped' });
    w.onmessage = (ev) => {
      if (ev.data.started) { started = true; return; }
      finish(ev.data.ok ? { ok: ev.data } : { error: ev.data.error, ...(ev.data.transient ? { transient: true } : {}) });
    };
    w.onerror = (e) => {
      e.preventDefault?.();
      finish(started ? { error: `the worker failed: ${e.message || 'out of memory?'}`, transient: true } : { noWorker: e.message || 'could not start' });
    };
    try {
      const [msg, transfer] = make();
      w.postMessage(msg, transfer);
    } catch (e) {
      // (the moment's by the worker's own rule, js/edges.js momentaryFailure)
      finish({ error: `no room for the model's copy: ${e?.message || e}`, ...(momentaryFailure(e) ? { transient: true } : {}) });
    }
  });
  return { promise, stop: (why) => stopIt(why) };
}

// Clearance off the page: a worker that cannot start (a file:// page, an old browser) hands it to
// the page; a run that fails in the worker is said, never run again here.
function clearanceOffPage(base, trisA, trisB, solidA, solidB) {
  if (app.clearanceRun) app.clearanceRun.stop();
  const job = workerJob('./clearance-worker.js', () => {
    const position = base.position.slice(), index = base.index.slice(), normal = base.normal ? base.normal.slice() : null;
    return [{ position, index, normal, trisA, trisB, solidA, solidB }, [position.buffer, index.buffer, ...(normal ? [normal.buffer] : [])]];
  });
  const run = { stop: () => job.stop() };
  app.clearanceRun = run;
  return job.promise.then((v) => {
    if (app.clearanceRun === run) app.clearanceRun = null;
    if (v.stopped) return STOPPED;
    if (v.noWorker) {
      app.lastClearanceVia = 'page';
      try { return clearance(base.position, base.index, trisA, trisB, { solidA, solidB, normal: base.normal }); } catch (e) { return { error: String(e?.message || e) }; }
    }
    app.lastClearanceVia = 'worker';
    return v.ok ? v.ok.result : { error: v.error };
  });
}

// Clearance: the smallest gap between the selected parts (when they all lie in one model; else
// the first model) and the other models' shown parts, on the tessellation (js/clearance.js), drawn
// as a Measure distance.
async function runClearance() {
  if (!app.scene || app.scene.length < 2 || !app.baseMesh) return;
  if (app.explode.on) setExplode(false); // the gap is measured where the parts are
  const ranges = modelRanges(app.scene);
  const modelOf = (id) => ranges.findIndex((r) => id >= r.first && id < r.first + r.count);
  const sel = [...app.selected];
  const inOne = sel.length && sel.every((id) => modelOf(id) === modelOf(sel[0]));
  const mA = inOne ? modelOf(sel[0]) : 0;
  const shown = (id) => !app.hidden.has(id);
  const A = (inOne ? sel : Array.from({ length: ranges[0].count }, (_, j) => j + 1)).filter(shown);
  const B = [];
  ranges.forEach((r, m) => { if (m !== mA) for (let id = r.first; id < r.first + r.count; id++) if (shown(id)) B.push(id); });
  const tris = (ids) => ids.map((id) => { const m = app.header.meshes[id - 1]; return [m.idxStart / 3, m.idxCount / 3]; });
  const what = inOne ? `the ${sel.length === 1 ? 'selected part' : `${fmtInt(sel.length)} selected parts`}` : app.scene[0].name;
  // (every state of the read in one place, its tooltip with it: "nothing shown to measure between"
  // kept the run before's "N triangle pairs compared", and app.lastClearance its result)
  const say = (text, title = '') => { $('clearval').textContent = text; $('clearval').title = title; };
  app.lastClearance = null;
  if (!A.length || !B.length) { say('nothing shown to measure between'); return; }
  say(`checking ${what}…`);
  await nextPaint();
  const base = app.baseMesh;
  // (each set's closed bodies, for a part lying wholly inside one: closedOf -- the facts awaited
  // when they are on their way: skipped, a pin inside a block read 4 mm after every scene change)
  // (on the facts, not the value: a scene's edges in hand are its value before its facts arrive)
  if (!base.edgeInfo?.value?.facts && base.edgeInfo?.ready) { try { await base.edgeInfo.ready; } catch { /* no facts: no containment */ } }
  // (the scene changed while it waited: said, not left at "checking …")
  const stopped = () => { if (app.baseMesh !== base) { say('stopped: the scene changed'); return true; } return false; };
  if (stopped()) return;
  const t0 = performance.now();
  const solids = (ids) => tris(ids.filter((id) => closedOf(base, id - 1)));
  const r = await clearanceOffPage(base, tris(A), tris(B), solids(A), solids(B));
  if (r === STOPPED) { stopped(); return; } // (a newer run took over and says its own state; or the scene changed)
  if (stopped()) return;
  // (a set with no triangle -- a selected body with none: clearance() has nothing; it was left at
  // "checking …")
  if (!r) { say('nothing shown to measure between'); return; }
  if (r.error) { say(`clearance failed: ${r.error}`); return; }
  const ms = Math.round(performance.now() - t0);
  // (with no facts -- their worker could not start or failed -- no body is known closed and a part
  // inside another is not asked: said, a pin inside a block read as its gap)
  const noFacts = !base.edgeInfo?.value?.facts;
  // the bodies the two nearest triangles belong to
  const bodyOf = (t) => {
    const i = t * 3;
    const k = app.header.meshes.findIndex((m) => i >= m.idxStart && i < m.idxStart + m.idxCount);
    return k + 1;
  };
  const a = bodyOf(r.triA), b = bodyOf(r.triB);
  // a part, and the model it is in (a board's parts are often just "SOLID")
  const nm = (id) => `${app.header.meshes[id - 1].name || `part ${id}`} (${modelOf(id) + 1})`;
  const text = r.distance === 0
    ? `0: ${nm(a)} touches or overlaps ${nm(b)}`
    : `${lenNum(r.distance, 'measure')} ${lenUnit()} from ${nm(a)} to ${nm(b)}${noFacts ? ' (a part inside another not checked: no body facts)' : ''}`;
  say(`clearance ${text}`, `${what} against the other models' shown parts: ${fmtInt(r.pairs)} triangle pairs compared in ${ms} ms`);
  if (r.distance > 0 && app.measure) app.measure.addDistance(r.pa, r.pb, 'clearance');
  app.lastClearance = { distance: r.distance, a, b, ms, pairs: r.pairs, pa: r.pa, pb: r.pb }; // (for tests)
  announce(`clearance ${text}`);
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
  const cap = silhouetteCapHere();
  // the file's edges and its facts when current (fileEdgesValue): its edges are shown either way --
  // a build of the facts that failed dropped the edges the file carries too
  if (edgesUsable(base)) {
    info.value = fileEdgesValue(base, cap);
    return Promise.resolve(info.value);
  }
  // (the edges now, drawn now -- the draw came only once the facts' build ended; the facts built
  // below, and the build's edges drawn in their place when it ends: syncEdges keys on the arrays)
  if (base.edges && !info.value) { info.value = fileEdgesValue(base, cap); if (app.baseMesh === base) refreshEdges(); }
  // (built by the worker on copies: the model's own buffers stay with the page and the GPU upload;
  // with no module worker there are none -- not built on the page, where a big model's would hold
  // the tab -- and the volume, the cut fill and Clearance's part-inside test go without, said)
  // (one build a model: a build already going for it is awaited, not stopped and begun again --
  // every move restarted a stale model's from nothing)
  const going = app.edgeJobs.get(base);
  if (going) return going.promise;
  // (a build that failed for the model itself -- the worker's own refusal, no module worker -- is
  // not tried again for it: every move started a worker that failed the same way and said so
  // again; opening the file again tries. A failure of the moment -- no room for the copy, a worker
  // that died, an allocation the worker could not make -- is tried again at the next ask, up to
  // MOMENT_TRIES)
  if (info.failed) return Promise.resolve(info.value);
  // (a build before that was stopped or failed for the moment: this one says its own)
  info.error = null; info.stopped = false;
  // a build that failed: its state, and told where it shows (and the info panel says it too),
  // worded by what is missing -- the file's edges are drawn when only the facts failed; the same
  // words are not told twice (sayNoFacts)
  const fail = (v) => {
    // (no module worker: said as why there are neither edges nor volume -- the page builds neither,
    // in its read either: r44 Q3; "could start here", not "this browser runs none": a file:// page
    // or a worker file that fails to load is no browser's want -- r45 A5)
    info.error = v.stopped || v.error || `no module worker could start here, and the page builds no edges or volume itself (${v.noWorker})`;
    // (a stop is no failure -- the one test of it, sceneEdges' too; a failure of the model itself
    // is remembered, one of the moment not -- until its second try: one that fails the same way
    // every time started a worker and copied the model at every move -- r40 A3, Q2)
    info.stopped = !!v.stopped;
    if (v.transient) info.tries = (info.tries || 0) + 1;
    if (!v.stopped && (!v.transient || info.tries >= MOMENT_TRIES)) info.failed = true;
    if (!info.stopped && app.baseMesh === base) sayNoFacts(`${info.value ? 'no volume' : 'no edges'} for this model: ${info.error}`);
    return info.value; // (the file's edges, when it carries them; else null)
  };
  // (a build that met a size limit when the file was read -- js/cadmesh.js edgesFailed -- fails the
  // same way here: remembered at once, not built again, nor again at each open of a kept
  // conversion -- r43 A3)
  if (writtenSizeLimit(base.header)) return Promise.resolve(fail({ error: `${base.header.edgesFailed.error} (when it was read)` }));
  const job = workerJob('./edges-worker.js', () => {
    const position = base.position.slice(), index = base.index.slice();
    return [{ position, index, meshes: base.header.meshes, silhouetteCap: cap }, [position.buffer, index.buffer]];
  });
  // (kept by its model, stopped when no model or scene shown holds it any longer -- stopEdgeJobs,
  // stop(why): the reason said -- its worker and its copies of the arrays would otherwise run on;
  // keyed on the job, so a stopped one never clears a newer one's)
  // (a stop takes it out of the map at once: a build asked for again before the stopped one
  // settles starts its own, not the stopped one's)
  const entry = { stop: (why) => { if (app.edgeJobs.get(base) === entry) app.edgeJobs.delete(base); job.stop(why); }, promise: null };
  entry.promise = job.promise.then((v) => {
    if (app.edgeJobs.get(base) === entry) app.edgeJobs.delete(base);
    const value = v.ok ? { ...v.ok.result, source: 'worker', ms: Math.round(v.ok.ms) } : null;
    // (only the model's current build writes its state: a stopped one settling after the next had
    // begun left "not computed: stopped…" over it, and kept it after that one succeeded)
    if (info.job !== entry) return value || info.value;
    info.job = null;
    if (value) {
      // (kept on the model as a file's would be, here where every build ends: a model opened alone
      // and then added to a scene built nothing again)
      keepEdges(base, value);
      info.value = value;
      return value;
    }
    return fail(v);
  });
  info.job = entry;
  app.edgeJobs.set(base, entry);
  return entry.promise;
}

// a model's builds that failed for the moment before its failure is remembered (edgesOf)
const MOMENT_TRIES = 2;

// stop the edge builds of the models not in `keep` (a Set of bases): no one is left to answer
function stopEdgeJobs(keep, why) {
  for (const [b, j] of [...app.edgeJobs]) if (!keep.has(b)) j.stop(why);
}

// "ready", or with faces the conversion could not mesh, what is missing; the list's note; and while
// the shown model or scene has no facts and has said so, why (sayNoFacts) -- every writer of the
// ready line keeps it (only sayNoFacts carried it, and an export's end, the model list's note or
// the tour's dropped it with the facts still missing: r41 A4, Q2)
// (a 2D drawing's word too: its own line, written apart, became plain "ready" when the model list
// arrived, and dropped the list's note in the other order -- r42 A6)
function readyText() {
  const d = app.dxf;
  return (d ? `ready · 2D drawing${d.drawing.units ? '' : ' (its unit is not stored)'}` : app.unmeshedFaces
    ? `ready · ${fmtInt(app.unmeshedFaces)} face${app.unmeshedFaces > 1 ? 's' : ''} could not be meshed and ${app.unmeshedFaces > 1 ? 'are' : 'is'} missing`
    : 'ready') + (app.listNote ? ` · ${app.listNote}` : '')
    + (app.noFacts ? ` · ${app.noFacts}` : '');
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

// extras: the companions picked, dropped or zipped with the file (an OBJ's .mtl, a .gltf's .bin),
// carried with it down to its reader -- in a global, a refused pick, an Add model… over the size or a
// superseded zip wrote over them while the load ran, the .obj then read without its .mtl or with
// another zip's (r52 A1, Q2)
async function loadAny(buf, name, seq, extras = []) {
  // a load superseded while it was reading/fetching must not start a worker
  // (it would also take over app.cancelTess from the newer load)
  if (stale(seq)) return;
  // A name that says no format this viewer opens (a URL with no extension; x.gz with nothing
  // inside its name, r20) is opened by what its bytes are (js/formats.js sniffFormat), gzipped
  // ones unpacked first (r19), and named for it. The name changes only for what it turned out
  // to be: an unknown x.gz is refused as "x.gz", not "x" (r21); it is unpacked once, whatever
  // it is (a .cadmesh opens raw, anything else is refused below in plain words)
  if (!formatOfName(name)) {
    let body = buf;
    if (isGzip(buf) && !(body = await unpackGz(buf, name, seq))) return;
    const said = sniffFormat(new Uint8Array(body, 0, Math.min(SNIFF_BYTES, body.byteLength)));
    if (said) name = `${name.replace(/\.gz$/i, '')}.${said.ext[0]}`;
    buf = body;
  }
  // every format by the one table (js/formats.js): a mesh (STL, OBJ, PLY, OFF, 3MF, glTF / GLB;
  // gzipped too) is read into a .cadmesh (js/mesh-formats.js); a DXF or DWG opens in 2D; a zip
  // for the model in it; a STEP / IGES / BREP is converted; a .cadmesh opens
  const fmt = formatOfName(name);
  if (fmt && fmt.kind === '2d' && app.adding && app.adding.seq === seq) {
    // a drawing has no place in a 3D scene: refused, not opened over it (the scene went)
    app.adding = null;
    throw new Error(`${name} is a 2D drawing: Add model… adds a 3D model (open the drawing on its own with Open…)`);
  }
  if (fmt && fmt.kind === 'mesh') return loadMeshFile(buf, name, seq, extras);
  if (fmt && fmt.kind === '2d') return loadDxf(buf, name, seq);
  if (fmt && fmt.kind === 'zip') return loadZip(buf, name, seq);
  // A compressed STEP / IGES / BREP (part.stp.gz, a fraction of the size to
  // download: README "Load"): unpacked here, then opened as the file inside it
  // (served with Content-Encoding: gzip, fetch has unpacked it already)
  if (fmt && fmt.kind === 'cad' && /\.gz$/i.test(name)) {
    if (isGzip(buf) && !(buf = await unpackGz(buf, name, seq))) return;
    name = name.replace(/\.gz$/i, '');
  }
  const ext = extOf(name);
  if (fmt && fmt.kind === 'cad') {
    const format = fmt.cad;
    // a gzip under a plain .stp name (it reached the converter compressed)
    // is unpacked; a UTF-8 byte-order mark first is dropped: OpenCascade
    // refuses it ("unexpected QUID, expecting STEP"), as stp2mesh does (r21)
    if (isGzip(buf) && !(buf = await unpackGz(buf, name, seq))) return;
    const kept = withoutBom(new Uint8Array(buf));
    if (kept.byteOffset) buf = buf.slice(kept.byteOffset);
    // the parts' ids and descriptions, from the STEP text itself (the
    // converter keeps only names; js/step-meta.js), for the info panel
    app.stepMetaOf = { seq, map: format === 'step' ? stepProducts(buf) : null };
    // A conversion of these exact bytes saved in this browser skips
    // OpenCascade (js/mesh-cache.js: everything stays on this device). The
    // key is hashed before the worker takes the buffer (posting detaches it).
    let key = null;
    if (cacheAvailable()) {
      setStatus('loading', `checking for a saved conversion of ${name}`);
      // (the converter build is part of what the mesh depends on: a new build is a new key)
      key = await cacheKey(buf, format, { ...DEFAULT_TESSELLATION, converter: await converterBuild() }).catch(() => null);
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
    if (!(await askBigConversion(buf, name, seq))) return;
    const tConv = performance.now();
    const conversion = await convert(buf, format, seq, name);
    conversion.ms = Math.round(performance.now() - tConv); // (in app.stats: the selftest's)
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
    throw new Error(`${name} is not a file this viewer opens (.${innerExt}.gz): ${OPENS}, or one of them gzipped`);
  }
  if (!cadm && !isGzip(buf)) {
    // a .cadmesh by name that is not one by its bytes is damaged, not of the
    // wrong kind (it was told to open a .cadmesh file: review r22)
    if (ext === 'cadmesh') throw new Error(`${name} is damaged or not a .cadmesh file inside: save it again from the viewer, or open the STEP it came from`);
    throw new Error(`${name} is not a file this viewer opens${ext ? ` (.${ext})` : ''}: ${OPENS}`);
  }
  await loadBuffer(buf, name, seq);
}

// A mesh file read into a .cadmesh, then opened as one: Save .cadmesh keeps
// it. drop: the other files dropped, picked or zipped with it (an OBJ's
// .mtl, a .gltf's .bin), this load's alone (a re-read in another unit keeps
// them in app.meshSource)
async function loadMeshFile(buf, name, seq, drop = []) {
  if (isGzip(buf) && !(buf = await unpackGz(buf, name, seq))) return;
  name = name.replace(/\.gz$/i, '');
  const { meshFormatOf } = await meshReaders();
  if (stale(seq)) return;
  const format = meshFormatOf(name, buf);
  if (!format) throw new Error(`${name} is not a file this viewer opens: ${OPENS}`);
  setStatus('loading', `reading ${name}`);
  showProgress(`Opening ${name}`, null, `reading ${mb(buf.byteLength)} MB of ${format.toUpperCase()} mesh`);
  await nextPaint();
  if (stale(seq)) return;
  const extras = new Map();
  for (const f of drop) extras.set(f.name.toLowerCase(), await f.arrayBuffer());
  if (stale(seq)) return;
  // (read in the unit the address gives for this file: a reload or a view link of a re-read one)
  // (a mesh added to a scene is read in the first model's unit: the scene's size)
  const url = app.urlOfLoad && app.urlOfLoad.seq === seq ? app.urlOfLoad.url : null;
  const adding = app.adding && app.adding.seq === seq;
  return meshFromSource({ buf, name, format, extras }, adding ? readUnit() : addressUnit(url), seq);
}

// A mesh file's bytes as a model in `unit` (a file that stores none -- STL,
// OBJ, PLY, OFF -- is read as mm until the units row's "file is in" says
// otherwise: plan feature 14). app.meshSource keeps the bytes for that.
async function meshFromSource(src, unit, seq) {
  // read off the page's thread (readInWorker; the bytes are copied, not moved: they are kept for
  // a re-read in another unit), else here
  const got = await readInWorker({ kind: 'mesh', buf: src.buf, format: src.format, name: src.name, extras: src.extras, unit }, src.name);
  if (stale(seq)) return;
  // (the same read, js/read-file.js, here where no worker could be made -- without the edges and
  // facts, which are never built on the page: a 980,000-triangle STL held the tab 1.1 s longer for
  // them -- edgesOf's rule, r43 A4)
  const { raw, unitless } = got || await (await fileReaders()).readMeshFile({ ...src, unit, edges: false });
  if (stale(seq)) return;
  await loadBuffer(raw, src.name, seq, raw);
  // (a model added to a scene keeps the scene's units: no choice there)
  if (app.baseMesh && !stale(seq) && app.scene && app.scene.length === 1) {
    app.meshSource = unitless ? { ...src, unit } : null;
    app.scene[0].unit = unitless ? unit : undefined;
    app.scene[0].unitless = unitless; // (it HAS a reading -- tours scale to it -- even in a scene, where it cannot be re-read)
    syncUnitParam();
    showInfo();
  }
}

// The unit a unit-less mesh was read in is part of WHICH model is shown: the address carries it
// (?unit=, beside ?src), so a reload and a view link open the file at that size -- a link's
// camera, taken in inches, sat 25.4 times off a model opened in mm
// (kept on the scene's first model: a scene drops meshSource -- no re-read there -- and the address,
// a view link and the tour maker still name the first model at its size)
const readUnit = () => (app.scene && app.scene[0] && app.scene[0].unit) || 'mm';
function syncUnitParam() {
  const u = new URL(location.href);
  const want = readUnit() !== 'mm' && app.sourceUrl ? readUnit() : null;
  if ((u.searchParams.get('unit') || null) === want) return;
  if (want) u.searchParams.set('unit', want); else u.searchParams.delete('unit');
  history.replaceState(history.state, '', u);
}
// which model a list's tour auto-played for: the URL it was opened from (else its data)
const autoTourKey = () => app.sourceUrl || app.header;
// the unit the address asks a URL load to be read in: only for the model the address names
function addressUnit(url) {
  const q = new URLSearchParams(location.search);
  const unit = q.get('unit');
  if (!unit || !Object.hasOwn(MM_PER, unit) || !url) return 'mm';
  try {
    const named = modelUrlIn(q);
    return named && new URL(named, location.href).href === new URL(url, location.href).href ? unit : 'mm';
  } catch { return 'mm'; }
}

// the units row's "file is in": the same bytes read again in that unit
function setMeshUnit(u) {
  const src = app.meshSource;
  if (!src || u === src.unit || !MM_PER[u]) return Promise.resolve();
  // (a tour shown is left first, the visitor's view put back: the re-read ends it anyway, and the
  // hidden parts kept below were then the step's -- a "hide" step left every other part hidden)
  if (app.tour) endTour();
  // (the same file, read again: it keeps the URL it came from -- the address, the view link, the
  // list entry and a saved tour all name it by that; a new seq dropped it)
  const url = app.sourceUrl;
  return startLoad(() => {
    const seq = beginLoad();
    if (url) app.urlOfLoad = { seq, url };
    setStatus('loading', `reading ${src.name} in ${u}`);
    // (the same bodies, at another size: the visitor's hidden parts stay hidden)
    const hidden = new Set(app.hidden);
    return meshFromSource(src, u, seq).then(() => {
      if (stale(seq)) return;
      if (hidden.size) { app.hidden = hidden; syncTreeChecks(); pushState(); updateButtons(); viewChanged(); }
      announce(`${src.name} read in ${u}`);
    });
  });
}

// A tour over a unit-less mesh read in another unit than the tour was made in plays at this
// reading's size: its cameras, frames and callouts scaled (js/tour.js tourAt). The file is not read
// again: that reset the visitor's view before the tour saved it, and left the model in the tour's
// unit after ✕. A model with no reading to choose (no meshSource: a STEP, a .cadmesh) plays it as made.
// (whether the first model has a reading at all -- a unit-less mesh, alone or in a scene -- not
// whether it can be re-read now, meshSource: a scene's tour was saved with no unit and played 25.4x off)
const tourReading = () => (app.scene && app.scene[0] && app.scene[0].unitless ? readUnit() : null);
function startTourIn(tour, url, only = null) {
  return startTour(tourAt(tour, tourReading()), url, only);
}
// A zip (feature review item 24): the first model in it that the viewer
// opens is opened, with its companions (an .mtl, a .bin) beside it
// A zip's companions for its model, each by its file name as the reader asks for it: those in the
// model's own folder first, so a same-named file in another folder (a zip of red/chair.obj with
// red/chair.mtl, and blue/chair.obj with blue/chair.mtl) never takes the model's place -- the last
// one read won, and the red chair opened blue (r53 Q1). A companion elsewhere (a textures/ folder)
// still serves when the model's folder has none of its name.
function zipCompanions(files, model) {
  const dir = (n) => n.slice(0, n.lastIndexOf('/') + 1);
  const own = dir(model), seen = new Set(), out = [];
  for (const n of [...files.filter((f) => dir(f) === own), ...files.filter((f) => dir(f) !== own)]) {
    const base = n.split('/').pop().toLowerCase();
    if (n === model || !isCompanion(n) || seen.has(base)) continue;
    seen.add(base);
    out.push(n);
  }
  return out;
}
async function loadZip(buf, name, seq) {
  setStatus('loading', `unpacking ${name}`);
  showProgress(`Opening ${name}`, null, `unpacking ${mb(buf.byteLength)} MB`);
  await nextPaint();
  if (stale(seq)) return;
  const { unzip } = await meshReaders();
  // (superseded while the reader was fetched: stopped -- it went on, r52 Q2)
  if (stale(seq)) return;
  const z = await unzip(buf);
  const files = z.names.filter((n) => !n.endsWith('/') && !/(^|\/)__MACOSX\//i.test(n));
  const opens = (n) => { const f = formatOfName(n); return !!f && f.kind !== 'zip'; };
  const model = files.find(opens);
  if (!model) throw new Error(`${name} holds no model this viewer opens: ${OPENS}`);
  const others = files.filter((n) => n !== model && opens(n)).length;
  const extras = zipCompanions(files, model).map((n) => ({ name: n.split('/').pop(), arrayBuffer: () => z.get(n) }));
  const inner = await z.get(model);
  if (stale(seq)) return;
  if (others) announce(`opening ${model} from ${name} (${others} more in it not opened)`);
  return loadAny(inner, model.split('/').pop(), seq, extras);
}

// ---------- 2D DXF (plan feature 23; js/dxf.js, js/dxf-view.js) ----------
// A DXF opens in 2D mode: the 3D model goes, the drawing is drawn on its own
// canvas (#view2d) on paper, the parts list lists its layers (a checkbox
// shows or hides one, a click on its name selects it, as a click on one of
// its lines does), and the 3D-only controls step aside (body.mode2d).
async function loadDxf(buf, name, seq) {
  if (isGzip(buf) && !(buf = await unpackGz(buf, name, seq))) return;
  name = name.replace(/\.gz$/i, '');
  setStatus('loading', `reading ${name}`);
  // a DWG by its bytes ("AC10..": an unread version is refused by name by the reader), or by
  // its name (a .dwg that is not one is refused by the reader as "not a DWG file")
  const dwg = isDWGBytes(new Uint8Array(buf, 0, Math.min(6, buf.byteLength))) || /\.dwg$/i.test(name);
  showProgress(`Opening ${name}`, null, `reading ${mb(buf.byteLength)} MB of ${dwg ? 'DWG' : 'DXF'}`);
  await nextPaint();
  if (stale(seq)) return;
  // a DWG (js/dwg.js) is read into the group-code pairs a DXF holds; a DXF is passed as its
  // bytes: parseDXF reads a binary one from them, an ASCII one in the drawing's own code page.
  // Off the page's thread (readInWorker), else here.
  const got = await readInWorker({ kind: '2d', buf, dwg }, name);
  if (stale(seq)) return;
  await twoD();
  const drawing = got ? got.drawing : (await fileReaders()).readDrawing({ buf, dwg });
  if (dxfLib.drawsNothing(drawing)) throw new Error(`${name} has nothing to draw`);
  if (stale(seq)) return;
  show2D(drawing, name, app.urlOfLoad && app.urlOfLoad.seq === seq ? app.urlOfLoad.url : null);
}

// The 2D view on a sheet: -1 model space, else layout i (its paper space and
// what its viewports show). The layers are the drawing's: which are off
// carries over; a Measure in progress does not
function setSheet(i) {
  const d = app.dxf.drawing;
  const L = i >= 0 ? d.layouts[i] : null;
  const shown = L ? { ...d, paths: L.paths, texts: L.texts, extents: L.extents } : d;
  const old = app.dxf.view;
  const off = old ? d.layers.filter((l) => !old.layerOn(l.name)).map((l) => l.name) : [];
  if (old) old.destroy();
  app.dxf.sheet = i;
  app.dxf.shown = shown;
  $('sheet').value = String(i);
  app.dxf.view = dxfViewLib.createDxfView($('view2d'), shown, {
    onSelect: (layer) => { syncLayerRows(); showInfo(); announce(layer ? `layer ${layer} selected` : 'nothing selected'); },
    onHover: (what, snap) => hoverLabel(!what ? '' : snap ? what : `layer ${what}`),
    onMeasure: (r) => tell(r.text, 4000),
  });
  for (const n of off) app.dxf.view.setLayerOn(n, false);
  $('measure').setAttribute('aria-pressed', 'false');
  if (old) { buildLayerList(); showInfo(); announce(L ? `${L.name}: paper space` : 'model space'); }
}

// A model or drawing from the device is not the ?model / ?index / ?src (and ?unit) a list
// pick or a link left in the address: a reload would open that instead (review r16 L7; a drawing
// opened from the device kept them -- the one rule for both, loadBuffer and show2D)
function forgetAddressModel() {
  const q = new URLSearchParams(location.search);
  if (app.sourceUrl || ![...MODEL_PARAMS, 'unit'].some((k) => q.has(k))) return;
  const u = new URL(location.href);
  for (const k of [...MODEL_PARAMS, 'unit']) u.searchParams.delete(k);
  history.replaceState(null, '', u);
}

function show2D(drawing, name, url) {
  leave2D();
  clearModel();
  document.body.classList.add('mode2d');
  const cv = $('view2d');
  cv.hidden = false;
  app.dxf = { drawing, name, url, sheet: -1 };
  app.sourceName = name;
  app.sourceUrl = url;
  forgetAddressModel();
  // the sheets: model space, then each layout that draws anything; a
  // drawing with nothing in model space opens on its first layout
  const sheets = dxfLib.sheetsOf(drawing);
  const sel = $('sheet');
  sel.replaceChildren(...[['-1', 'Model'], ...sheets.map(({ l, i }) => [String(i), l.name])].map(([v, t]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = t; return o;
  }));
  sel.hidden = !sheets.length;
  setSheet(dxfLib.sheetDraws(drawing) || !sheets.length ? -1 : sheets[0].i);
  $('measure').setAttribute('aria-pressed', 'false');
  updateButtons(); // (clearModel ran them before app.dxf: Measure, Fit and Print come on for the drawing)
  buildLayerList();
  $('model').textContent = name;
  document.title = `${name} — ${SHORT_TITLE}`;
  cv.setAttribute('aria-label', `2D drawing ${name}: ${drawing.layers.length} layers`);
  $('sharelink').disabled = !url;
  // (Save picture, Print and the picture options: updateButtons above sets them from app.dxf)
  syncMenuButtons();
  showInfo();
  setStatus('ready', readyText());
  announce(`${name} opened: a 2D drawing, ${drawing.layers.length} layers`);
}

// 2D Measure on or off: two clicks give a distance with ΔX and ΔY in the
// drawing's unit, snapping to line ends, middles and circle centres; off
// clears its results
function toggle2DMeasure() {
  if (!app.dxf) return;
  const v = app.dxf.view, on = !v.measuring;
  v.setMeasure(on);
  if (!on) v.clearMeasure();
  $('measure').setAttribute('aria-pressed', String(on));
  tell(on ? 'Measure: click two points (they snap to line ends, middles and circle centres)' : 'measure off', 3000, on ? 'measure on' : 'measure off');
}

// out of 2D mode (a 3D model opened, or a new DXF replacing this one)
function leave2D() {
  if (!app.dxf) return;
  app.dxf.view.destroy();
  app.dxf = null;
  document.body.classList.remove('mode2d');
  $('view2d').hidden = true;
  $('sheet').hidden = true;
  clearHover();
}

// the parts list as the drawing's layers: colour, name, line count, a box
function buildLayerList() {
  const tree = $('tree');
  tree.textContent = '';
  $('treefilter').hidden = true;
  // (the sheet shown: a layout lists the layers it draws)
  const d = app.dxf.shown || app.dxf.drawing;
  const count = new Map();
  for (const p of d.paths) if (!p.outline) count.set(p.layer, (count.get(p.layer) || 0) + 1); // (an outline is its polyline's)
  for (const t of d.texts) count.set(t.layer, (count.get(t.layer) || 0) + 1);
  for (const l of d.layers) {
    if (!count.get(l.name)) continue; // an empty layer: nothing to show or hide
    const li = document.createElement('li');
    li.dataset.layer = l.name;
    const row = document.createElement('div');
    row.className = 'row';
    const wrap = document.createElement('label');
    wrap.className = 'cbwrap';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = app.dxf.view.layerOn(l.name);
    cb.setAttribute('aria-label', `Show layer ${l.name}`);
    cb.onchange = () => app.dxf.view.setLayerOn(l.name, cb.checked);
    wrap.append(cb);
    const lab = document.createElement('span');
    lab.className = 'label';
    lab.tabIndex = 0;
    const sw = document.createElement('span');
    sw.className = 'layer-swatch';
    sw.style.background = dxfLib.onPaper(l.colour);
    lab.append(sw, l.name);
    lab.onclick = () => app.dxf.view.select(app.dxf.view.selected === l.name ? null : l.name);
    lab.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lab.onclick(); } };
    const n = document.createElement('span');
    n.className = 'count';
    n.textContent = fmtInt(count.get(l.name));
    row.append(wrap, lab, n);
    li.append(row);
    tree.append(li);
  }
  syncLayerRows();
}
function syncLayerRows() {
  for (const li of $('tree').children) li.querySelector('.row').classList.toggle('sel', !!app.dxf && li.dataset.layer === app.dxf.view.selected);
}

// the info panel in 2D mode: the drawing's size, unit, layers and contents
function fillInfo2D(el) {
  // (the sheet shown: model space, or a layout)
  const d = app.dxf.shown || app.dxf.drawing, full = app.dxf.drawing;
  const row = (k, v) => { const p = document.createElement('div'); const b = document.createElement('b'); b.textContent = k; p.append(b, ` ${v}`); el.append(p); };
  row('file', `${app.dxf.name} · 2D drawing`);
  if (app.dxf.sheet >= 0) row('sheet', `${full.layouts[app.dxf.sheet].name} (paper space, and model space through its viewports)`);
  const e = d.extents;
  if (e) {
    const u = d.units ? unitWord(d.units) : 'units';
    // in the drawing's own unit, to 6 significant figures
    const n = (v) => String(Number(v.toPrecision(6)));
    row(`size (${u})`, `${n(e.max[0] - e.min[0])} × ${n(e.max[1] - e.min[1])}`);
  }
  row('units', d.units ? `${unitWord(d.units)} ($INSUNITS ${d.insunits})` : 'not stored in the file');
  row('layers', `${fmtInt(d.layers.length)}`);
  // (a wide polyline's outline is its polyline's, a viewport's frame is not the drawing's: neither
  // a shape -- the layer list still counts a frame, so its layer can be hidden)
  row('contents', `${fmtInt(d.paths.filter(dxfLib.isShape).length)} lines and shapes, ${fmtInt(d.texts.length)} texts`);
  // what the drawing holds that is not drawn here, by kind (it was left out without a word)
  const nd = Object.entries(full.notDrawn || {});
  if (nd.length) row('not drawn', nd.map(([k, n]) => `${fmtInt(n)} ${k}`).join(', '));
  // (a DWG whose format checks failed: what is drawn may be wrong, said as dwg-check says it)
  if (full.checkFailures && full.checkFailures.length) row('checks failed', full.checkFailures.join('; '));
  // (model space is drawn; a layout's sheet, title block and viewport frames
  // are paper space, left out)
  if (app.dxf.sheet < 0 && full.paperSpace) {
    row('paper space', `${fmtInt(full.paperSpace)} ${full.paperSpace === 1 ? 'entity' : 'entities'} not shown here (model space is drawn${dxfLib.sheetsOf(full).length ? '; the Sheet menu shows the layouts' : ''})`);
  }
  if (app.dxf.view.selected) {
    const l = app.dxf.view.selected;
    // (its texts too, as its row in the layer list counts them: a layer of notes read "0 lines")
    const np = d.paths.filter((p) => p.layer === l && dxfLib.isShape(p)).length, nt = d.texts.filter((t) => t.layer === l).length;
    row('selection', `layer ${l}: ${fmtInt(np)} lines and shapes${nt ? `, ${fmtInt(nt)} ${nt === 1 ? 'text' : 'texts'}` : ''}`);
  }
}

// what Open… and a drop take, for the messages that say so
const OPENS = opensText();

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

// A mesh or 2D file read off the page's thread (js/read-worker.js), so no file -- a damaged one,
// a hostile one, one too big -- freezes the tab: past READ_LIMIT_S the worker is terminated and
// the file refused in words; one that runs the worker out of memory takes only the worker; Cancel
// (and any newer load) terminates it through app.cancelTess, as a conversion's. -> the worker's
// answer, or null where no module worker can be made (an old browser: read here, as before)
// (?readlimit=<s> shortens it, for tests/ui-checks.py read-worker only)
const READ_LIMIT_S = Number(params.get('readlimit')) > 0 ? Number(params.get('readlimit')) : 60;
function readInWorker(msg, name) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./read-worker.js', import.meta.url), { type: 'module' }); } catch { app.lastReadVia = 'page'; resolve(null); return; }
    app.lastReadVia = 'worker'; // (for tests)
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.terminate();
      if (app.cancelTess === cancel) app.cancelTess = null;
      fn(v);
    };
    const cancel = () => done(reject, new Error('superseded by a newer load'));
    app.cancelTess = cancel;
    const timer = setTimeout(() => done(reject, new Error(`${name} took over ${READ_LIMIT_S} s to read, and was stopped: a damaged file, or one too large for this viewer`)), READ_LIMIT_S * 1000);
    let ready = false;
    w.onmessage = (ev) => {
      if (ev.data.ready) { ready = true; return; }
      if (ev.data.ok) done(resolve, ev.data); else done(reject, new Error(ev.data.message));
    };
    // A worker that dies before it is ready could not load its modules (an installed app offline
    // before the worker was ever fetched, a deploy without it): the file is read here instead.
    // One that dies after ran out of memory on this file.
    w.onerror = (e) => {
      if (e.preventDefault) e.preventDefault();
      if (!ready) { app.lastReadVia = 'page'; done(resolve, null); return; }
      done(reject, new Error(`${name} could not be read: the reader stopped (${e.message || 'it ran out of memory'})`));
    };
    // (the copy posted to the reader may not fit: said, and the worker, its timer and the load's
    // cancel let go -- it rejected with the engine's words, the worker left running 60 s: r48 A4.
    // A launch of its own, beside workerJob, as a reader that dies before it is ready hands the
    // file to the page)
    try { w.postMessage(msg); } catch (e) { done(reject, new Error(`${name} could not be read: no room for its copy (${e?.message || e})`)); }
  });
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
    const stepTimes = []; // [step, ms] as each step began
    // seconds per step (read, transfer, mesh, write), from the converter's
    // own progress; before the first: loading the converter
    const phaseSecs = (end) => {
      const out = { load: +(((stepTimes[0]?.[1] ?? end) - t0) / 1000).toFixed(2) };
      stepTimes.forEach(([s, t], i) => {
        const k = ['read', 'transfer', 'mesh', 'write'][s];
        out[k] = +((out[k] || 0) + ((stepTimes[i + 1]?.[1] ?? end) - t) / 1000).toFixed(2);
      });
      return out;
    };
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
          stepTimes.push([st, t]); // when each step began (the selftest's phase times)
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
      else if (m.type === 'done') done(resolve, { buffer: m.buffer, unmeshedFaces: m.unmeshedFaces || 0, threads, phases: phaseSecs(performance.now()) });
      else done(reject, new Error(crashText(m.message)));
    };
    w.onerror = (e) => done(reject, new Error(crashText(e.message || 'the worker stopped')));
    show();
    // the multi-core try is sent a copy, so the bytes are still here for the
    // single-threaded one if it fails -- a copy that does not fit is a failure of this try, the
    // worker and its progress timer ended (unguarded, the one-thread retry succeeded and the leaked
    // timer set the page back to "tessellating" every second: r49 A1)
    try { w.postMessage({ buffer: buf, format, threads }, threads ? [] : [buf]); } catch (e) { done(reject, new Error(`no room for the file's copy: ${e?.message || e}`)); }
  });
}

// The converter build staged beside the page (fetch-deps.sh writes its VERSION), read once: a
// saved conversion's key names it, so a page on a new build converts again rather than serving
// meshes the old one made. "unknown" when it cannot be read.
let converterBuildP = null;
const converterBuild = () => converterBuildP || (converterBuildP = fetch(new URL('vendor/occt-import-js/VERSION', location.href))
  .then((r) => (r.ok ? r.text() : ''), () => '').then((t) => t.trim().slice(0, 80) || 'unknown'));

// The file name a URL names: js/formats.js fileNameOfUrl (check.html reads the same)
const fileName = fileNameOfUrl;

// A fetch that throws had no usable answer. From another site, a HEAD in
// "no-cors" mode then tells whether the site answered at all: if it did, it
// did not let this page read the answer -- it sends no CORS for that file,
// or the file is not there (a site that sends CORS only for files it has,
// as libre.computer does, reports a missing file this way: the browser
// hides the 404 too). If it did not, the site is down or unreachable.
// lead: how the sentence starts ("could not download part.stp"; a tour's: "could not be read")
async function fetchFailedText(url, name, e, lead = `could not download ${name}`) {
  let host = null;
  try {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin) host = u.host;
  } catch { /* an unparsable URL: treated as this site's */ }
  if (!host) return `${lead}: the server did not answer (${e.message || e})`;
  // (a cross-origin isolated page -- cad.place is -- refuses a no-cors answer
  // that carries no Cross-Origin-Resource-Policy, so there the probe cannot
  // tell an answer from silence: the message names all three)
  if (self.crossOriginIsolated) {
    return `${lead} from ${host}: the file is not there, the site does not let other web pages load its files `
      + '(no CORS), or it did not answer -- the browser does not say which. Check the address, or download the file and open it here.';
  }
  let answered = false;
  try {
    const timeout = typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(8000) } : {};
    await fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', ...timeout });
    answered = true;
  } catch { /* no answer at all */ }
  return answered
    ? `${lead} from ${host}: the site answered but would not let this page read it -- the file is not there, `
      + 'or the site does not let other web pages load its files (no CORS). Check the address, or download the file and open it here.'
    : `${lead}: ${host} did not answer (it may be down, or the address is wrong).`;
}

async function loadUrl(url) {
  const seq = beginLoad();
  // (a model opened again: its list's tour plays again, once, and its list's hide is applied again
  // -- applyListEntry; not for a model added beside it, which left the first's keys reset)
  if (!app.startingAdd) { app.autoTourFor = null; app.listHideFor = null; }
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
  // a host's share page (a GitHub blob, a Dropbox ?dl=0, a Drive file page)
  // fetched as the file it shares (js/open-url.js); the address keeps the link
  // (fileUrl's own rule, with the host it was rewritten from, for the message: js/open-url.js)
  const direct = directFor(url);
  if (direct.from) announce(`${direct.from} link: opening the file it shares`);
  try {
    // (the download js/early.js started for it, when there is one: it began before main.js ran)
    res = await earlyFetch(direct.url, ac ? { signal: ac.signal } : {});
  } catch (e) {
    if (stale(seq)) return; // aborted: a newer load, or Cancel
    const text = await fetchFailedText(url, name, e);
    if (stale(seq)) return;
    throw new Error(text);
  }
  // (an early download is not this load's to abort: its body is let go, which ends it)
  if (stale(seq)) { res.body?.cancel().catch(() => {}); return; }
  if (!res.ok) {
    // the whole URL tried, not only the file's name: a site owner whose
    // ?src= went wrong could not see where it pointed (feature review
    // 2026-10-29). A relative ?src= is a URL of this page, so it resolves
    // against the page, as every link does; a list's files resolve against
    // the list. Given a list, the error says so.
    const tried = res.url || new URL(url, location.href).href;
    // (one test of "relative", js/model-list.js isRelative: a //host address is not -- r53 A7; one the
    // list names was read from the list, and came here absolute)
    const relative = isRelative(url) && new URLSearchParams(location.search).has('list');
    const hint = relative ? ' (a relative address the model list does not name is read from this page\'s address: give the full URL)' : '';
    throw new Error((res.status === 404 ? `file not found (404): ${tried}`
      : `could not download ${tried}: the server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`) + hint);
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
        throw new Error(oversizeText(name));
      }
      // through setStatus, so a recovery that ends mid-fetch sees a load in
      // progress (app.status 'loading') and does not paint "ready" over it
      setStatus('loading', pct
        ? `fetching ${Math.min(100, Math.round((100 * got) / total))}% of ${(total / 1e6).toFixed(1)} MB`
        : `fetching ${(got / 1e6).toFixed(1)} MB`);
      const secs = (performance.now() - tf) / 1000;
      const rate = secs > 0.5 ? ` · ${rateText(got / secs, pct ? total - got : null)}` : '';
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
  // (told: these refusals were heard and never shown -- r49 A4)
  if (!f) { tell(`Nothing to open: drop ${opensShort()}`, 4000); return null; }
  const item = dt.items && dt.items[0];
  if (item && item.webkitGetAsEntry && item.webkitGetAsEntry()?.isDirectory) {
    tell(`${f.name} is a folder: drop the model file in it`, 4000);
    return null;
  }
  return pickModelFile([...files]);
}

// Of several files dropped or picked together, the model (the first that is
// not a companion: an .mtl, a .bin, a picture), the companions kept for it
// with it (companionsOf: an OBJ's colours, a .gltf's buffers), which its
// load takes (loadFile) whatever else is picked or loaded meanwhile
const companionsOf = new WeakMap();
function pickModelFile(files) {
  const f = files.find((x) => !isCompanion(x.name)) || files[0];
  const extras = files.filter((x) => x !== f && isCompanion(x.name));
  companionsOf.set(f, extras);
  const rest = files.length - 1 - extras.length;
  if (rest > 0) announce(`opening ${f.name}; the viewer opens one model at a time (${rest} more not opened)`);
  return f;
}

// A file over the size, refused before anything starts -- for Open…, a drop and Add model… alike
// (Add model… called loadFile, whose own check came after beginLoad: an over-size file added
// cancelled a running conversion, and over a model made the page's error -- r50 A1). Says whether.
function refusedForSize(f) {
  if (f.size <= MAX_FILE_BYTES) return false;
  failApart(oversizeText(f.name));
  return true;
}
// (the words once, for a file refused and a download cut at the size: r51 A9, Q8)
const oversizeText = (name) => `${name} is over ${(MAX_FILE_BYTES / 2 ** 30).toFixed(0)} GB, more than this viewer opens`;

// A file from the device (Open…, a drop). One too big is refused before
// anything starts: in loadFile the refusal came after the running load was
// cancelled, so it also killed a conversion in progress (review r21)
// (on an embed's poster -- a drop -- the file is the visitor's ask, as View in 3D is: the poster
// goes, not left over the model drawn under it, and View in 3D then opening ?src= over it: r52 Q6)
function openFile(f) {
  if (refusedForSize(f)) return;
  if (posterUp()) { $('poster').hidden = true; setEmbedActive(true); }
  startLoad(() => loadFile(f));
}

// (every caller refuses a file over the size first, refusedForSize -- its own check here came after
// beginLoad, so it cancelled the running load: r21, r50 A1; dead since, and gone: r51 A9)
// extras: the companions picked with it (pickModelFile), carried down to its reader
async function loadFile(file, extras = companionsOf.get(file) || []) {
  const seq = beginLoad();
  app.fetchMs = null;
  setStatus('loading', `reading ${file.name}`);
  showProgress(`Opening ${file.name}`, null, `reading ${mb(file.size)} MB from disk`);
  announce(`loading ${file.name}`); // a new load is news even mid-load
  const buf = await file.arrayBuffer();
  if (stale(seq)) return;
  return loadAny(buf, file.name, seq, extras);
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
  const labels = bodyLabels(app.header);
  // a view link names its selection by the file's own names, so a list's
  // labels never change what an old link selects
  app.bodyKeys = bodyKeys(labels);
  // the model list's labels for its parts ("HDMI_1_3" -> "HDMI"), each piece
  // of "owner › body" on its own
  app.meshLabel = app.partLabels ? labels.map((l, i) => (i < firstModelBodies() ? l.split(' › ').map(partLabel).join(' › ') : l)) : labels;
}

const meshLabel = (id) => app.meshLabel[id - 1];

// A name as the model list labels it (its entry's labels), else as is. Matched as tours, notes and
// "hide" match a name (js/tour.js partIndex: trimmed, any case), so "hdmi_1_3": "HDMI" labels the
// tree's HDMI_1_3 as the tour that names "HDMI" finds it
let labelIndex = { of: null, map: new Map() };
const partLabel = (s) => {
  if (!app.partLabels) return s;
  if (labelIndex.of !== app.partLabels) {
    labelIndex = { of: app.partLabels, map: new Map(Object.entries(app.partLabels).map(([k, v]) => [k.trim().toLowerCase(), v])) };
  }
  return labelIndex.map.get(String(s).trim().toLowerCase()) ?? s;
};

// The bodies the list entry's labels and the STEP file's part data describe: the first model's,
// which a scene's added models follow (their own bodies named alike -- COMPONENT1, Body1 -- took
// the first model's label and part number)
const firstModelBodies = () => (app.scene && app.scene.length > 1 ? app.scene[0].base.header.meshes.length : Infinity);
const ofFirstModel = (ids) => ids.every((id) => id <= firstModelBodies());

// The name a tree node shows: its own, else its one body's, else "(unnamed)";
// as the model list labels it (ids: its bodies, the labels being the first model's)
const nodeName = (n, ids = null) => {
  const s = n.name || (n.meshes.length === 1 && !n.children.length ? app.header.meshes[n.meshes[0]].name : '') || '(unnamed)';
  return !ids || ofFirstModel(ids) ? partLabel(s) : s;
};

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
  // a node's bodies, gathered once (kidsOf's filter and mk both asked for every node's)
  const gathered = new Map();
  const idsOf = (node) => {
    let ids = gathered.get(node);
    if (!ids) gathered.set(node, (ids = collect(node)));
    return ids;
  };
  // A node's own bodies get a row each when the node also has children or
  // several bodies: otherwise a pick of one of them has no row to show (the
  // rack's 19-body assembly node had none).
  const kidsOf = (node) => {
    const own = node.meshes.length && (node.children.length || node.meshes.length > 1)
      ? node.meshes.map((i) => ({ name: app.header.meshes[i].name || `body ${i + 1}`, meshes: [i], children: [] }))
      : [];
    return [...node.children, ...own].filter((c) => idsOf(c).length);
  };
  const mk = (node, depth, name) => {
    const ids = idsOf(node);
    if (!ids.length) return null;
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';
    row.style.paddingLeft = `${depth * 12 + 4}px`;
    const items = node.meshes.length === 1 && !node.children.length ? [] : kidsOf(node);
    const names = numberRepeats(items.map((c) => nodeName(c, idsOf(c))));
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
    // (and, for a part the model list labels, the file's own name)
    const own = node.name || (node.meshes.length === 1 && !node.children.length ? app.header.meshes[node.meshes[0]].name : '');
    label.title = `${label.textContent}${own && ofFirstModel(ids) && partLabel(own) !== own ? ` (${own} in the file)` : ''} · ${ids.length} bod${ids.length === 1 ? 'y' : 'ies'}`;
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
    label.ondblclick = () => fitTo(drawnBox(ids));
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
  const top = mk(start, 0, nodeName(start, idsOf(start)));
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
// The model's flat sheet bodies (the converter's b-rep kind "sheet": a
// board's pads, silkscreen and labels), ids
const sheetIds = () => (app.header ? app.header.meshes.flatMap((m, i) => (m.kind === 'sheet' ? [i + 1] : [])) : []);

// the sheets row: shown only for a model that has sheets; checked while none
// is hidden, half-checked while some are
function syncSheets() {
  const ids = sheetIds();
  $('sheetsrow').hidden = !ids.length;
  if (!ids.length) return;
  const hidden = ids.filter((id) => app.hidden.has(id)).length;
  $('sheets').checked = hidden < ids.length;
  $('sheets').indeterminate = hidden > 0 && hidden < ids.length;
  $('sheetscount').textContent = fmtInt(ids.length);
}

function setSheets(show) {
  const ids = sheetIds();
  if (!ids.length) return;
  rememberVisibility();
  for (const id of ids) {
    if (show) app.hidden.delete(id);
    else app.hidden.add(id);
  }
  syncTreeChecks();
  pushState();
  updateButtons();
  showInfo();
  viewChanged();
  announce(`${fmtInt(ids.length)} flat sheets ${show ? 'shown' : 'hidden'}`);
}

function syncTreeChecks() {
  syncSheets();
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

// The box Fit frames: bboxOf where the bodies are DRAWN, so while exploded
// each body's box is moved as its shader moves it (ids null: every body).
// Measuring (the size, the datum, Explode's own directions) keeps bboxOf.
function drawnBox(ids) {
  const h = app.header;
  if (!h) return null;
  const x = app.explode;
  if (!(x.on && x.dirs && x.for === h && x.t)) return ids ? bboxOf(ids) : h.bbox;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const n = ids ? ids.length : h.meshes.length;
  for (let j = 0; j < n; j++) {
    const id = ids ? ids[j] : j + 1;
    const b = h.meshes[id - 1].bbox;
    if (!b) continue;
    for (let k = 0; k < 3; k++) {
      const o = x.t * x.dirs[(id - 1) * 3 + k];
      min[k] = Math.min(min[k], b.min[k] + o);
      max[k] = Math.max(max[k], b.max[k] + o);
    }
  }
  return min[0] === Infinity ? null : { min, max };
}

// The section's range: the model's box, or while exploded the drawn one (so
// the cut reaches every moved body), kept until the explode changes
let secBoxKey = null, secBox = null;
function sectionBox() {
  const x = app.explode;
  if (!(x.on && x.t && x.for === app.header)) return app.header.bbox;
  const key = `${x.mode}:${x.t}`;
  if (secBoxKey !== key || secBox?.h !== app.header) { secBox = { ...drawnBox(null), h: app.header }; secBoxKey = key; }
  return secBox;
}

app.sectionBox = () => sectionBox(); // (for tests: the section's range)

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
// ('mm': a mesh file's .cadmesh saved before the mesh readers wrote MM)
const geomMm = () => !app.header || app.header.units === MM || app.header.units === 'mm';
// (the model's largest extent, in mm, for Auto's choice: units.js autoUnit)
const modelSizeMm = () => {
  const b = app.header && app.header.bbox;
  return b ? Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : Infinity;
};
const curUnit = () => displayUnit(app.unitChoice, app.header?.sourceUnits, modelSizeMm());
const lenUnit = () => (geomMm() ? curUnit() : app.header.units);
const lenNum = (v, kind) => (geomMm() ? fmtNum(v, kind, curUnit()) : v.toFixed(1));

// What the file declares, as a reader spells it (js/units.js unitWord)
const UNIT_WORDS = { mixed: 'mixed (its parts disagree)' };

// The info block's units row: its select lives outside the rebuilt values,
// so a refresh (a selection, a load) never closes an open picker. Only its
// text is set here.
function syncUnitsRow() {
  const row = $('infounits');
  row.hidden = !app.header;
  if (!app.header) return;
  const declared = app.header.sourceUnits;
  $('unitsrc').textContent = !geomMm() ? `${app.header.units} (not converted)`
    : declared ? (UNIT_WORDS[declared] || unitWord(declared)) : 'not recorded';
  const sel = $('unitsel');
  sel.disabled = !geomMm();
  sel.options[0].text = `Auto (${autoUnit(declared, modelSizeMm())})`;
  sel.value = app.unitChoice;
  // a mesh file that stores no unit: which unit it is in, chosen here
  const src = app.meshSource;
  $('meshunitrow').hidden = !src;
  if (src) {
    $('unitsrc').textContent = 'not stored in the file';
    $('meshunit').value = src.unit;
    // (its title says the reading it is: it said "read as mm" whatever was chosen)
    $('meshunit').title = `This mesh file stores no unit: it is read as ${unitWord(src.unit)}. Pick the unit it was made in and it is read again at that size`;
  }
}

function setUnitChoice(u) {
  app.unitChoice = DISPLAY_UNITS.includes(u) ? u : 'auto';
  setPref('cadv.units', app.unitChoice === 'auto' ? null : app.unitChoice);
  showInfo();
  updateButtons(); // the section readout
}

function showInfo() {
  // the ? box's graphics line: the renderer in words, and why a faster one
  // was skipped (as text, not a tooltip: a touch screen shows no tooltip)
  $('gfxnote').textContent = graphicsNote();
  syncUnitsRow();
  syncRefRow();
  const el = $('infovals');
  el.innerHTML = '';
  if (app.dxf) fillInfo2D(el); else fillInfo(el);
  syncMassRow();
  syncScene();
  // no renderer and no model: no blank box or double rule
  $('info').hidden = !el.childElementCount;
}

// "measured from": the whole model's corner, or the parts chosen with
// Measure from selection; its buttons are never rebuilt (the focus stays)
// mass: the selection's closed bodies times the material's density (mm³ /
// 1000 = cm³); with nothing selected it says why it waits (a whole model is
// rarely one material)
// The density in g/cm³: the material picked, or the one typed after
// "other…"; null while the typed one is not a usable number
function density() {
  if ($('material').value !== 'custom') return Number($('material').value);
  const d = Number($('density').value);
  return Number.isFinite(d) && d > 0 && d <= 25 ? d : null;
}

function syncMassRow() {
  const f = app.factsNow;
  const show = !!app.header && !!f && app.selected.size > 0;
  $('infomass').hidden = !show;
  $('densitybox').hidden = $('material').value !== 'custom';
  if (!show) return;
  const d = density();
  if (!f.closed) { $('massval').textContent = 'none closed: no volume'; return; }
  if (d === null) { $('massval').textContent = 'type a density (g/cm³, water is 1)'; return; }
  const g = (f.vol / 1000) * d;
  $('massval').textContent = `${fmtMass(g, lenUnit())}${f.closed < f.of ? ` (the ${fmtInt(f.closed)} closed of ${fmtInt(f.of)})` : ''}`;
}

function syncRefRow() {
  $('inforef').hidden = !app.header;
  if (!app.header) return;
  $('refname').textContent = app.ref ? app.ref.name : 'the whole model';
  $('refset').disabled = !app.selected.size;
  // (a button about to hide hands the focus on, as the toolbar's do)
  if ($('refclear').hidden !== !app.ref && document.activeElement === $('refclear')) $('refset').focus();
  $('refclear').hidden = !app.ref;
  // holes need the b-rep faces (a .cadmesh written before they were kept has none)
  $('holesbtn').disabled = !app.selected.size || !(app.baseMesh && app.baseMesh.faces);
  // an open hole table follows the reference and the display unit
  if (app.holesFor && app.measure) showHoles(app.holesFor);
}

// The hole table of the parts `f.ids` ({ ids, name }), positions from the reference
function showHoles(f) {
  app.holesFor = f;
  if (!f) { app.measure.showHoles(null); return; }
  const ref = { ...(app.ref ? bboxOf(app.ref.ids) : app.header.bbox), name: app.ref ? app.ref.name : 'the whole model' };
  app.measure.showHoles(f.ids, ref, f.name);
}

function setRef(on) {
  if (on && app.selected.size) {
    const ids = [...app.selected];
    app.ref = { ids, name: app.selName || (ids.length === 1 ? meshLabel(ids[0]) : `${ids.length} bodies`) };
  } else app.ref = null;
  showInfo();
  announce(app.ref ? `positions measured from ${app.ref.name}` : 'positions measured from the whole model');
}

// The info block leads with what a visitor asks of a part (the selection, its
// size and position, volume and mass); the file, the graphics backend, the
// triangle count and the converter are in a Details fold at its foot (UI
// organization review rank 3: the panel opened on "graphics WebGL 2 --
// WebGPU not available" and pushed the parts list down). The fold is rebuilt
// with the values, so whether it is open is kept here.
function fillInfo(el) {
  const line = (k, v) => {
    const d = document.createElement('div');
    const a = document.createElement('b');
    a.textContent = k;
    d.append(a, ' ', ...v);
    return d;
  };
  const add = (k, ...v) => el.append(line(k, v));
  const more = document.createElement('details');
  more.id = 'infomore';
  more.open = !!app.infoMoreOpen;
  more.ontoggle = () => { app.infoMoreOpen = more.open; };
  const sum = document.createElement('summary');
  sum.textContent = 'Details';
  more.append(sum);
  const addMore = (k, ...v) => more.append(line(k, v));
  // the file, in full: the narrow footer truncates it, and its title tooltip
  // never shows on a touch screen; and the site it came from (a model opened
  // by URL), so a visitor knows whose model it is
  if (app.header) {
    let host = '';
    try { host = app.sourceUrl ? new URL(app.sourceUrl, location.href).host : ''; } catch { /* no URL */ }
    if (host === location.host) host = '';
    addMore('file', `${app.sourceName} · ${fmtInt(app.header.meshes.length)} ${app.header.meshes.length === 1 ? 'body' : 'bodies'}${host ? ` · from ${host}` : ''}`);
    // what the model list says of it: its page, who made it, on what terms
    // (in the lead: whose model it is, and the way back to its page)
    const e = listEntry(app.sourceUrl);
    const outLink = (url, text) => {
      const l = document.createElement('a');
      l.href = url;
      l.target = '_blank';
      l.rel = 'noopener';
      l.textContent = text;
      return l;
    };
    if (e && e.page) {
      const u = new URL(e.page);
      add('page', outLink(e.page, `${u.host}${u.pathname.replace(/\/$/, '')} ↗`));
    }
    // its other pages (the list's `links`), each by its name and its host:
    // a list on any site can name any page, so whose page it is always shows
    if (e && e.links && e.links.length) {
      const items = [];
      for (const k of e.links) {
        if (items.length) items.push(' · ');
        items.push(outLink(k.url, `${k.name} ↗`), ` (${new URL(k.url).host})`);
      }
      add('see', ...items);
    }
    if (e && (e.author || e.license)) add('model', [e.author && `by ${e.author}`, e.license].filter(Boolean).join(' · '));
  }
  // (the graphics line is the ? box's: showInfo)
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
  // instance count (feature review item 24): one part selected, how many
  // copies of it the model holds (the same name, triangle count and size), on
  // the selection's own line (a line more squeezed the parts list below)
  const n = ids.length === 1 ? instancesOf(ids[0]) : 0;
  if (n > 1) {
    const sel = document.createElement('button');
    sel.className = 'mini';
    sel.textContent = `1 of ${fmtInt(n)}`;
    sel.title = `${fmtInt(n)} copies of this part in the model: select them all`;
    sel.setAttribute('aria-label', `one of ${n} copies: select all ${n}`);
    sel.onclick = () => select(sameParts(ids[0]), false);
    add('selection', `${title} `, sel);
  } else add('selection', title);
  // the part's id and description from the STEP file (js/step-meta.js), when
  // it carries more than the name
  // (the STEP file's part data is the first model's: an added model's body of the same name is not it)
  const meta = ids.length === 1 && ofFirstModel(ids) && app.stepMeta && app.stepMeta.get(app.header.meshes[ids[0] - 1].name);
  if (meta) add('part', [meta.id, meta.description].filter(Boolean).join(' · '));
  // "size (mm)" rather than "extent X × Y × Z (mm)": the longer label wrapped
  // the third value onto a line of its own in the 300 px panel
  add(`size (${lenUnit()})`, dims);
  // where it is: from the reference's corner (js/datum.js), and how far it
  // stands above and below a reference part (a board)
  const ref = app.ref ? bboxOf(app.ref.ids) : app.header.bbox;
  if (ids.length && b && ref) {
    add(`position (${lenUnit()})`, rangesFrom(b, ref)
      .map(([lo, hi], k) => `${'XYZ'[k]} ${lenNum(lo, 'size')} to ${lenNum(hi, 'size')}`).join(' · '));
  }
  if (app.ref && b && ref) {
    // (how far it stands out past the reference's top and its bottom; a part
    // that does not reach past one says so, rather than a negative number
    // nobody can read -- UI review: "6.2 / -0.7")
    const ab = aboveBelow(b, ref, orientUp(app.cam.orient));
    const past = (v, side) => (v > 0.005 ? `${lenNum(v, 'size')} ${side}` : `none ${side}`);
    add(`above / below it (${lenUnit()})`, `${past(ab.above, 'above')} · ${past(ab.below, 'below')}`);
  }
  addMore('triangles', fmtInt(tris));
  // volume and area (js/edges.js facts: from the file, or the worker's once it
  // answers): the volume of the closed bodies only, an open sheet having none;
  // the bodies counted by their b-rep kind
  const facts = app.baseMesh?.edgeInfo?.value?.facts;
  const which = ids.length ? ids : app.header.meshes.map((_, i) => i + 1);
  if (!facts) {
    app.factsNow = null;
    add('volume', pendingVolume(app.baseMesh?.edgeInfo, app.scene?.length > 1));
  } else {
    let vol = 0, area = 0, closed = 0, capped = 0, sheets = 0, open = 0;
    for (const id of which) {
      const i = id - 1, kind = app.header.meshes[i].kind;
      area += facts.area[i] || 0;
      if (facts.closed[i]) {
        vol += facts.volume[i] || 0; closed++;
        if (kind === 'capped') capped++;
      } else if (kind === 'sheet') sheets++; else open++;
    }
    const u = lenUnit();
    const counts = [`${fmtInt(closed)} closed${capped ? ` (${fmtInt(capped)} capped)` : ''}`, sheets && `${fmtInt(sheets)} ${sheets === 1 ? 'sheet' : 'sheets'}`,
      open && `${fmtInt(open)} open`].filter(Boolean).join(' / ');
    // (a body whose volume may not be its material's -- its shells touch or cross, or too large to
    // check -- said, as what it is: each flag's count and words, js/edges.js flagsSaid, as stp2mesh)
    add('volume', `≈ ${fmtVolume(vol, u)} · ${counts}${flagsSaid(facts, which.map((id) => id - 1), ' · ')}`);
    add('area', `≈ ${fmtArea(area, u)}`);
    addMore('volume counts', volumeCounts(which.length, closed, capped, sheets, open));
    app.factsNow = { vol, closed, of: which.length };
    if (!ids.length) add('mass', 'select parts (a whole model is rarely one material)');
  }
  if (app.unmeshedFaces) add('missing faces', `${fmtInt(app.unmeshedFaces)} (the converter could not mesh them)`);
  // converted in this tab just now: on how many threads (js/converter-choice.js)
  if (app.stats?.converter) addMore('converted on', app.stats.converter);
  el.append(more);
}

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

// What the volume counts, in words (Details, under the volume): "the 305
// closed bodies; 1,082 are flat sheets (pads, labels) and 4 are open surface
// models", with "(12 of them closed by the converter's caps)" when some are
function volumeCounts(n, closed, capped, sheets, open) {
  const bodies = (k) => `${fmtInt(k)} ${k === 1 ? 'body' : 'bodies'}`;
  let s = closed === n ? (n === 1 ? 'the one body, closed' : `all ${bodies(n)}, every one closed`)
    : closed ? `the ${fmtInt(closed)} closed ${closed === 1 ? 'body' : 'bodies'}` : 'no body: none is closed';
  if (capped) s += ` (${fmtInt(capped)} of them closed by the converter's caps)`;
  const rest = [sheets && `${fmtInt(sheets)} ${sheets === 1 ? 'is a flat sheet' : 'are flat sheets'} (pads, labels)`,
    open && `${fmtInt(open)} ${open === 1 ? 'is an open surface model' : 'are open surface models'}`].filter(Boolean);
  return rest.length ? `${s}; ${rest.join(' and ')}` : s;
}

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
  // the pickers offer what the loader opens (js/formats.js): Open… every format, Add model… the
  // 3D ones (a drawing is refused there)
  $('open').accept = acceptList();
  $('dropwhat').textContent = opensShort();
  $('addmodel').accept = acceptList(['cad', 'cadmesh', 'mesh', 'zip']);
  // Measure (js/measure-ui.js): this input feeds it while it is on
  app.measure = createMeasure({
    $, view: measureView, sectionPlane,
    // whether a body is closed (the facts, as the cut fill reads them): only a closed one shows a cut face
    closed: (mi) => closedOf(app.baseMesh, mi),
    // the model as Measure reads it, at the time it reads it
    scene: {
      get mesh() { return app.baseMesh; },
      get header() { return app.header; },
      get hidden() { return app.hidden; },
      get sphere() { return app.sphere; },
    },
    lenText: (mm) => `${lenNum(mm, 'measure')} ${lenUnit()}`,
    num: (mm) => lenNum(mm, 'measure'), unit: () => lenUnit(),
    announce, tell, queueFrame, syncOptbar,
    coarse: () => matchMedia('(pointer: coarse)').matches,
    // where hidden edges are drawn, everything drawn can be snapped
    showsHidden: () => currentStyle().seesHidden,
    // Measure's points are where the bodies are, not where Explode draws them
    // (Measure, Paint and Explode exclude each other: a click goes to one,
    // and Measure and Paint pick the parts where they are, not where Explode
    // draws them)
    beforeOn: () => {
      // (no note of its own: setExplode says "explode off", and Measure's hint replaced a note here in
      // the same task, unseen -- r46 Q4, r48 A5)
      if (app.explode.on) setExplode(false);
      if (app.paintFaces) setPaint(false);
    },
  });
  app.measureView = measureView; // (and for tests/ui-checks.py, which projects points with it)
  // a drawing open: Measure is the drawing's own (js/dxf-view.js)
  const measure3d = $('measure').onclick;
  $('measure').onclick = (e) => (app.dxf ? toggle2DMeasure() : measure3d(e));
  // The view is a tab stop (its arrows turn it), but a mouse press does not
  // focus it: the press blurs whatever had the focus, as it did when the
  // canvas took no focus at all (a click on the view leaves the page focused)
  $('view').addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  });
  const stageXY = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  // a finger covers what it aims at: on a touch screen, a held finger aims
  // this far above itself
  const AIM_LIFT = 48;
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
  let embedPress = null;
  const endPointer = (e) => {
    if (embedPress && e.pointerId === embedPress.id) embedPress = null; // the page took it (a scroll)
    if (drag && e.pointerId === drag.id) {
      // (a dragged dot stays where it got to; a loupe goes)
      if (drag.dot && drag.moved) app.measure.endDot(drag.dot);
      if (drag.aim || drag.dot) app.measure.loupe(null);
      drag = null;
    }
    releaseTouch(e.pointerId);
  };
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    // The cards (empty state, progress) and the options bar sit inside the
    // view: a press on them is theirs. Capturing it for an orbit retargeted
    // the click to the view, so "Choose a file…" and Cancel never received it.
    if (e.target.closest(OVER_VIEW)) return;
    // embedded and not yet active: no capture, no gesture; a press that
    // lifts where it went down (a click, a tap) makes it active
    if (app.embed && !app.embedActive) { embedPress = { id: e.pointerId, x: e.clientX, y: e.clientY }; return; }
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      stage.setPointerCapture(e.pointerId);
      if (touches.size >= 2 && !pinch && (!drag || drag.type === 'touch')) {
        if (drag && drag.dot && drag.moved) app.measure.endDot(drag.dot);
        if (drag && (drag.aim || drag.dot)) app.measure.loupe(null);
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
    // Measure: a press on a placed end dot (a 22 px target) drags it, and
    // wins over the orbit; the dot keeps its offset from the pointer, so it
    // does not jump under the finger
    if (app.measure.on && !pan && (e.button === 0 || e.pointerType === 'touch') && !dismiss) {
      const [x, y] = stageXY(e);
      const h = app.measure.dotAt(x, y);
      if (h) {
        drag.dot = h;
        drag.off = [h.at[0] - x, h.at[1] - y];
        return;
      }
    }
    // Measure on a touch screen: a finger held still 300 ms (inside the tap
    // slop) aims -- the snap marker shows above it as it slides, and lifting
    // places the point; moving sooner orbits as ever
    if (e.pointerType === 'touch' && app.measure.on) {
      const d = drag;
      d.aimTimer = setTimeout(() => {
        if (drag !== d || d.moved) return;
        d.aim = true;
        const [x, y] = stageXY(e);
        app.measure.hover(x, y - AIM_LIFT);
        app.measure.loupe(x, y, x, y - AIM_LIFT);
      }, 300);
    }
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
  let measXY = null;
  let measRaf = 0;
  const setHover = (id) => {
    if (id === app.hover) return;
    app.hover = id;
    hoverLabel(id ? meshLabel(id) : '');
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
    if (app.measure.on) app.measure.hover(null);
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
        // zoomed about where the fingers were, then panned as they moved:
        // the point between them stays between them
        const r = stage.getBoundingClientRect();
        zoomAt(app.cam, st.scale, app.sphere.radius, app.stageAspect,
          (a0[0] + b0[0]) / 2 - (r.left + r.width / 2), (a0[1] + b0[1]) / 2 - (r.top + r.height / 2), stage.clientHeight);
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
      // Measure's snap marker follows the pointer (one search per frame)
      if (app.measure.on) {
        measXY = stageXY(e);
        if (!measRaf) measRaf = requestAnimationFrame(() => { measRaf = 0; if (measXY) app.measure.hover(...measXY); });
        // over a placed end dot: it can be dragged
        stage.classList.toggle('grab', !!app.measure.dotAt(...measXY));
      } else if (stage.classList.contains('grab')) stage.classList.remove('grab');
      const wait = 60 - (performance.now() - hoverT);
      if (wait <= 0) hoverPick();
      else if (!hoverTimer) hoverTimer = setTimeout(hoverPick, wait);
      return;
    }
    if (e.pointerId !== drag.id) return;
    // dragging a Measure end dot: it snaps where it goes, its result follows;
    // a finger also gets the loupe
    if (drag.dot) {
      const [x, y] = stageXY(e);
      const slop = drag.type === 'touch' ? 10 : 3;
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > slop) drag.moved = true;
      if (!drag.moved) return;
      const tx = x + drag.off[0], ty = y + drag.off[1];
      app.measure.moveDot(drag.dot, tx, ty);
      if (drag.type === 'touch') app.measure.loupe(x, y, tx, ty);
      return;
    }
    // aiming a Measure point: the finger slides the marker, the view stays
    if (drag.aim) {
      const [x, y] = stageXY(e);
      app.measure.hover(x, y - AIM_LIFT);
      app.measure.loupe(x, y, x, y - AIM_LIFT);
      return;
    }
    // A fingertip tap drifts 3-8 px: touch gets a 10 px slop, and until it is
    // passed the finger neither orbits nor stops being a tap.
    const slop = drag.type === 'touch' ? 10 : 3;
    if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > slop) drag.moved = true;
    if (!drag.moved) return;
    if (drag.aimTimer) { clearTimeout(drag.aimTimer); drag.aimTimer = 0; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    const c = app.cam;
    if (drag.pan) {
      panBy(c, dx, dy, stage.clientHeight);
    } else {
      orbit(c, dx, dy); // free about every axis (no pole clamp, upside down allowed), or Level's
    }
    viewChanged();
  });
  stage.addEventListener('pointerup', (e) => {
    if (embedPress && e.pointerId === embedPress.id) {
      const still = Math.hypot(e.clientX - embedPress.x, e.clientY - embedPress.y) < 10;
      embedPress = null;
      if (still) setEmbedActive(true);
      return;
    }
    releaseTouch(e.pointerId);
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (d.aimTimer) clearTimeout(d.aimTimer);
    // resolves true only when this gesture was a click whose pick applied:
    // a drag, or a pick dropped by a camera change, must not trigger the
    // dblclick fit of an older selection
    lastClick = Promise.resolve(false);
    // a dragged end dot: the result as it now reads (a press on a dot that
    // did not move places nothing)
    if (d.dot) {
      if (d.moved) app.measure.endDot(d.dot);
      lastType = d.type;
      lastTap = null;
      return;
    }
    // Measure: a click or tap places a point (never selects); a held finger
    // places where it aimed. Double-click and double-tap zoom are off meanwhile.
    if (app.measure.on && !d.moved && (e.button === 0 || d.type === 'touch') && app.mesh && !d.dismiss) {
      const [x, y] = stageXY(e);
      app.measure.place(x, d.aim ? y - AIM_LIFT : y);
      if (d.aim) app.measure.loupe(null);
      if (d.type === 'touch') app.measure.hover(null);
      lastType = d.type;
      lastTap = null;
      return;
    }
    // Paint (feature review item 24): a click paints the b-rep face under it
    // in the swatch's colour, instead of selecting
    if (!d.moved && e.button === 0 && app.mesh && !d.dismiss && app.paintFaces) {
      const hit = app.measure.faceAt(...stageXY(e));
      if (hit && hit.face >= 0) paintFace(hit.face);
      else tell('no face there to paint');
      return;
    }
    if (!d.moved && e.button === 0 && app.mesh && !d.dismiss) {
      const additive = e.ctrlKey || e.metaKey;
      app.hoverSeq++; // a click supersedes any pending hover answer
      lastClick = app.pickAt(...devicePx(e)).then((id) => {
        if (id === null) return false;
        select(id ? [id] : [], additive);
        if (id) revealRow(id);
        // a finger has no hover: the view's name label shows what a tap picked
        if (d.type === 'touch') hoverLabel(id ? meshLabel(id) : '', true);
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
    if (clicked && app.selected.size) fitTo(drawnBox([...app.selected]));
  });
  stage.addEventListener('dblclick', (e) => {
    if (lastType === 'touch' || e.target.closest(OVER_VIEW) || app.measure.on || !app.embedActive) return; // a double-tap / a card's or the bar's own clicks / measuring
    fitAfterClick();
  });
  stage.addEventListener('wheel', (e) => {
    if (e.target.closest(OVER_VIEW)) return; // a card scrolls (a long error), the bar scrolls sideways; the view stays put
    // embedded and not active: the page scrolls (not prevented); the hint shows
    if (app.embed && !app.embedActive) { $('embedhint').hidden = false; return; }
    e.preventDefault();
    // per unit of deltaY: pixels (0), lines (1, ~3 per notch), pages (2, ~1 per notch);
    // toward the pointer
    const r = stage.getBoundingClientRect();
    zoomAt(app.cam, Math.exp(e.deltaY * ([0.0015, 0.05, 0.15][e.deltaMode] ?? 0.0015)), app.sphere.radius, app.stageAspect,
      e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), stage.clientHeight);
    viewChanged();
  }, { passive: false });
  // The stage changes size with the window, a phone rotating, or the parts
  // drawer opening: redraw, and keep the same part of the scene framed when
  // the aspect changes (a narrow view is width-limited).
  app.stageAspect = stage.clientWidth / Math.max(1, stage.clientHeight);
  new ResizeObserver(() => {
    const a = stage.clientWidth / Math.max(1, stage.clientHeight);
    // a phone turned between portrait and landscape while the view is still
    // the one the model opened at: the Iso that suits the new shape
    // (js/orient.js isoView), framed afresh
    if (a > 0 && app.header && app.cam.q === app.loadQ && (a < PORTRAIT) !== (app.stageAspect < PORTRAIT)) {
      setView('iso');
      app.loadQ = app.cam.q;
      queueFrame();
      return;
    }
    // a view still as Fit left it is fitted again for the new shape: exact,
    // where scaling the distance (below) holds a sphere's framing, not the box's
    if (a > 0 && a !== app.stageAspect && atLastFit()) {
      fitTo(app.lastFit.bbox);
      queueFrame();
      return;
    }
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
    // ...and ends at ? and Full screen, beside the row
    header.style.setProperty('--endw', `${$('hdend').offsetWidth}px`);
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
  // File > Add model…: the picked file joins the scene
  $('addmodelbtn').onclick = () => { closeMenus(); $('addmodel').click(); };
  $('addmodel').addEventListener('change', () => {
    const files = [...$('addmodel').files];
    $('addmodel').value = '';
    addPicked(files);
  });
  $('clearbtn').onclick = () => runClearance();
  $('paintbtn').onclick = () => setPaint(!app.paintFaces);
  $('walk').onclick = () => setWalk(!app.walk);
  // the installed app opened with a file (manifest.webmanifest file_handlers)
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (p) => {
      if (p.files && p.files.length) openFile(pickModelFile(await Promise.all(p.files.map((h) => h.getFile()))));
    });
  }
  // offline install (sw.js): not in an embed (another site's page), and only
  // where a service worker may run
  if ('serviceWorker' in navigator && !app.embed && window.isSecureContext && !params.has('nosw')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* the viewer works without it */ });
  }
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
    // (a model the renderer could not hold after a recovery under this load is not drawn: said,
    // not "ready" over an empty view -- r50 Q2)
    if (shownLacksGpu()) setStatus('error', app.gpuLacks.msg);
    else if (somethingShown()) setStatus('ready', readyText());
    else setStatus('idle', idleText());
  };
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('drop');
    const f = droppedFile(e);
    if (f) openFile(f);
  });
  $('open').onchange = (e) => {
    const files = [...e.target.files];
    e.target.value = ''; // so choosing the same file again fires change
    if (files.length) openFile(pickModelFile(files));
  };
  document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  $('fit').onclick = () => (app.dxf ? app.dxf.view.fit() : fitTo(drawnBox(app.selected.size ? [...app.selected] : null)));
  // Ortho, Z up and Flip are on/off toggles: the label names the option, the
  // pressed look (and aria-pressed, for a screen reader) says whether it is on
  $('proj').onclick = () => { app.cam.ortho = !app.cam.ortho; updateButtons(); viewChanged(); };
  // Z up: the file's +z up and -y toward the viewer, or back to its own frame
  // (y up); the choice holds for the next model that names no orientation
  $('up').onclick = () => {
    app.userOrient = app.cam.orient.startsWith('+z') ? DEFAULT_ORIENT : Z_UP_ORIENT;
    app.cam.orient = app.userOrient;
    updateButtons();
    showInfo(); // above / below are along the new up
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
  $('sheets').onchange = (e) => setSheets(e.target.checked);
  $('savepic').onclick = () => { closeMenus(); savePicture(); };
  // the picture options (▾): pressing one keeps the group open
  $('picmore').onclick = () => setPicOpts($('picopts').hidden);
  for (const b of $('picopts').querySelectorAll('[data-scale]')) {
    b.onclick = () => { if (b.getAttribute('aria-disabled') !== 'true') { app.pic.scale = Number(b.dataset.scale); savePicOpts(); } };
  }
  for (const b of $('picopts').querySelectorAll('[data-bg]')) b.onclick = () => { app.pic.bg = b.dataset.bg; savePicOpts(); };
  $('picsel').onclick = () => { app.pic.sel = !app.pic.sel; savePicOpts(); };
  // Copy image: where the clipboard takes a picture (ClipboardItem with a
  // promise, so the gesture still holds when the render finishes)
  $('piccopy').hidden = typeof ClipboardItem !== 'function' || !navigator.clipboard?.write;
  $('piccopy').onclick = () => copyPicture();
  $('printbtn').onclick = () => { closeMenus(); savePicture(true); };
  $('savedrawing').onclick = () => { closeMenus(); saveDrawing(); };
  $('skipview').onclick = () => $('view').focus();
  $('tourprev').onclick = () => app.tour && showTourStep(app.tour.i - 1);
  $('tournext').onclick = () => app.tour && showTourStep(app.tour.i + 1);
  $('tourexit').onclick = () => endTour();
  $('tourplay').onclick = () => app.tour && setTourPlaying(!app.tour.playing);
  // the tour maker: File > Make a tour… (a tour playing is opened in it)
  app.recorder = createTourRecorder({
    capture: captureStep,
    preview: (tour, from, play) => { endTour(); if (!startTourIn(tour, null)) return; if (from) showTourStep(from); setTourPlaying(play); },
    stopPreview: () => endTour(),
    modelUrl: () => {
      try { const u = app.sourceUrl ? new URL(app.sourceUrl, location.href) : null; return u && samePlace(u.href, location.href) ? u.href : null; } catch { return null; }
    },
    orient: () => app.cam.orient || null,
    // the model open now, by its content (the same file opened again is the same model)
    // (and the unit it was read in: the same file read in inches is another size, which steps
    // taken in mm do not fit)
    // (and the unit it is read in, where it has a reading to choose: null for a STEP or a .cadmesh)
    model: () => (app.header ? { key: modelKeyOf(app.header), unit: tourReading(), name: app.sourceName || 'another model' } : null),
    save: (text, name) => downloadText(text, name, 'application/json'),
    validate: (text) => parseTour(text, location.href),
    pictures: tourPictures,
    video: tourVideo,
    announce,
  });
  $('tourmake').onclick = () => { closeMenus(); app.recorder.show(true, app.tour ? app.tour.full || app.tour.tour : null); };
  $('gallerybtn').onclick = () => openGallery();
  $('galleryclose').onclick = () => closeGallery();
  $('gallery').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeGallery(); } });
  // Export as STL / 3MF / GLB: one button each (a drop-down among buttons,
  // which needed its own keyboard rules: UI organization review rank 7)
  for (const b of $('exportmesh').querySelectorAll('button')) b.onclick = () => { closeMenus(); exportMesh(b.dataset.fmt); };
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
    for (const k of document.querySelectorAll('#helppop kbd')) if (k.textContent === 'Ctrl+Z') k.textContent = '⌘Z';
  }
  pal.onchange = () => setPalette(pal.value);
  wireModelList();
  wireHistory();
  wireLooks();
  syncStyleBg();
  const sty = $('style');
  for (const s of STYLES) sty.add(new Option(s.label, s.id));
  sty.value = currentStyle().id;
  syncStyleBg();
  blurAfterPick(sty);
  sty.onchange = () => setStyle(sty.value, true);
  // the unit pickers' choices, from the one table (js/units.js DISPLAY_UNITS)
  for (const u of DISPLAY_UNITS) { $('unitsel').add(new Option(u, u)); $('meshunit').add(new Option(u, u)); }
  blurAfterPick($('unitsel'));
  $('unitsel').onchange = (e) => setUnitChoice(e.target.value);
  // the 2D drawing's sheet: model space or a layout (a pick from the list is
  // blurred, so the keys reach the drawing)
  blurAfterPick($('sheet'));
  $('sheet').onchange = (e) => { if (app.dxf) setSheet(Number(e.target.value)); };
  $('meshunit').onchange = (e) => setMeshUnit(e.target.value);
  // the material: remembered in this browser; a pick from the list is blurred
  // (the number keys then reach the view)
  const material = getPref('cadv.material');
  if (material && [...$('material').options].some((o) => o.value === material)) $('material').value = material;
  blurAfterPick($('material'));
  $('material').onchange = () => {
    setPref('cadv.material', $('material').value);
    syncMassRow();
    // "other…": the density is typed next (the pick's blur has run already)
    if ($('material').value === 'custom') $('density').focus();
  };
  // a typed density, remembered as the material is
  const density = getPref('cadv.density');
  if (density) $('density').value = density;
  $('density').oninput = () => {
    setPref('cadv.density', $('density').value);
    syncMassRow();
  };
  $('refset').onclick = () => setRef(true);
  $('refclear').onclick = () => setRef(false);
  $('holesbtn').onclick = () => {
    const ids = [...app.selected];
    showHoles({ ids, name: app.selName || (ids.length === 1 ? meshLabel(ids[0]) : `${ids.length} bodies`) });
  };
  $('holesclose').onclick = () => { showHoles(null); $('holesbtn').focus(); };
  // 'change', not 'input': a picker drag fires input continuously, and each
  // recolour re-uploads the model
  $('partcolour').onchange = (e) => setPartColour(e.target.value);
  $('partreset').onclick = () => resetPartColour();
  $('sharelink').onclick = () => shareView();
  $('export').onclick = async () => {
    if (!app.lastStepBuffer) return;
    const name = app.sourceName;
    // (js/cadmesh.js cadmeshToSave: gzipped where the browser can, without a written edges
    // failure -- it is this browser's reading)
    let bytes;
    try {
      bytes = await cadmeshToSave(app.lastStepBuffer);
    } catch (e) {
      tellReady(`could not save ${name}: ${e.message || e}`);
      return;
    }
    downloadBlob(new Blob([bytes]), `${saveBase(name)}.cadmesh`);
  };
  $('cacheclear').onclick = async () => {
    const err = await cacheClear().then(() => null, (e) => e);
    await refreshCacheBar();
    tell(err ? `could not clear the saved conversions: ${err.message || err}` : 'saved conversions cleared', err ? 6000 : 3000); // (told: r49 A4)
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
    // ...and the ? box, giving the focus back to ? when it was in the box
    if (e.key === 'Escape' && helpOpen()) { e.preventDefault(); setHelp(false, $('helppop').contains(document.activeElement)); return; }
    const typed = (t.tagName === 'INPUT' && !NOT_TYPED.includes(t.type))
      || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
    // ...but Esc in the slide-out's field (an empty Filter parts: a filled one
    // clears first, in its own handler) closes the slide-out, as from its tree
    if (typed && e.key === 'Escape' && panelOpen() && $('parts').contains(t)) { e.preventDefault(); setPanel(false, true); return; }
    if (typed) return;
    // ? opens and closes the ? box (a typed ?: Shift+/ on most layouts)
    if (e.key === '?') { e.preventDefault(); if (!e.repeat) setHelp(!helpOpen(), true); return; }
    // a tour: → / PageDown the next step, ← / PageUp the one before, Esc
    // leaves it (ahead of the camera's arrows; a control's own arrows win)
    if (app.tour && !e.defaultPrevented && !(t.type === 'range' || (t instanceof Node && $('tree').contains(t)))) {
      const go = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }[e.key];
      if (go) { e.preventDefault(); showTourStep(app.tour.i + go); return; }
      if (e.key === 'Escape') { e.preventDefault(); endTour(); return; }
      // Space plays / pauses (a focused button's own Space presses it)
      if (e.key === ' ' && !(t instanceof Element && t.closest('button, a, summary'))) { e.preventDefault(); setTourPlaying(!app.tour.playing); return; }
    }
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
    // The camera from the keyboard: arrows turn the view as a drag does,
    // Shift+arrows pan, + and - zoom; where the focus is the 3D view itself
    // or nowhere (a control's own arrows win: the tree, a slider, a select).
    // Only presets moved it from the keyboard before (feature review r2).
    const onView = t === $('view') || t === document.body || t === document.documentElement || !(t instanceof Node);
    if (app.header && onView && !e.defaultPrevented) {
      const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      const zoom = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' ? 1 / 1.2
        : e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract' ? 1.2 : 0;
      if (arrow || zoom) {
        e.preventDefault();
        if (zoom) zoomBy(app.cam, zoom, app.sphere.radius, app.stageAspect);
        else if (e.shiftKey) panBy(app.cam, arrow[0] * 24, arrow[1] * 24, $('stage').clientHeight);
        else orbit(app.cam, arrow[0] * 18, arrow[1] * 18);
        viewChanged();
        return;
      }
    }
    // then an open parts panel (the narrow layout's slide-out); the next Esc
    // clears the selection. Letters match in either case, so Caps Lock does
    // not turn the shortcuts off.
    // A layout whose keys type no Latin letter (Cyrillic, Greek) goes by the
    // key's place, as QWERTY names it.
    // Esc, one thing a press: the panel, then Measure's results list, its
    // half-made point, Measure itself, then Paint, Walk, Explode and the
    // Section (each a mode the view is in), then the selection
    const escTool = () => (app.paintFaces ? (setPaint(false), true) : app.walk ? (setWalk(false), true)
      : app.explode.on ? (setExplode(false, true), true) : app.section.axis !== 'off' ? ($('secoff').click(), true) : false);
    const acts = { f: () => $('fit').click(), Escape: () => (panelOpen() ? setPanel(false, true) : app.dxf ? (app.dxf.view.escapeMeasure() || (app.dxf.view.measuring ? (toggle2DMeasure(), true) : app.dxf.view.select(null))) : app.measure.escape()
        || escTool() || (app.embed && app.embedActive && !app.selected.size ? (setEmbedActive(false), true) : false) || select([], false)),
      h: () => $('hide').click(), i: () => $('isolate').click(), a: () => $('showall').click(), e: () => edgesKey(),
      m: () => { if (app.dxf) toggle2DMeasure(); else if (!$('measure').disabled) app.measure.setOn(!app.measure.on, true); },
      p: () => { if (!$('savepic').disabled) savePicture(); },
      x: () => { if (!$('explode').disabled && !$('explode').hidden) setExplode(!app.explode.on, true); } };
    let k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // (a LETTER of another script only: punctuation on a Latin layout keeps
    // its own meaning; on Dvorak "." sits at KeyE and toggled the edges, r18)
    if (nonLatinLetter(k) && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
    // Walk: its keys move (a held key keeps moving), before their usual meaning
    if (app.walk && WALK_KEYS[k] && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); walkKey(k, e.shiftKey); return; }
    const act = acts[k];
    if (!act) return;
    // the key's own browser action (Quick Find on ' / Firefox, ...) is not run
    // too, and a held key acts once: a repeat would toggle E on and off
    e.preventDefault();
    if (e.repeat) return;
    act();
  });
}

// ---------- the ? box ----------
//
// The controls and shortcuts, and the renderer (WebGPU / WebGL 2 / WebGL 1)
// with why a faster one was skipped, in a box that opens from ? in the view's
// top right, beside Full screen (they were a fold at the foot of the parts panel, which took the
// list's room, and a badge whose explanation was a tooltip a touch screen
// never shows). ? (the button or the key) opens and closes it; so do Esc and
// a press anywhere else. Opened from the keyboard it takes the focus, and
// closing it gives the focus back to ?.
const helpOpen = () => !$('helppop').hidden;
function setHelp(open, focus = false) {
  const pop = $('helppop'), btn = $('helpbtn');
  if (open === helpOpen()) return;
  const inside = pop.contains(document.activeElement);
  if (open) {
    closeMenus();
    const r = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom) + 4}px`;
    pop.hidden = false;
    // under ?, its right edge with ?'s, but inside the window: a phone's box
    // is nearly the window's width, and aligned to ? it ran off the left
    pop.style.right = `${Math.max(8, Math.min(Math.round(innerWidth - r.right), innerWidth - 8 - pop.offsetWidth))}px`;
  }
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open && focus) pop.focus();
  else if (!open && (focus || inside)) btn.focus();
}
function wireHelp() {
  // detail 0: a keyboard press (Enter / Space) takes the focus into the box
  $('helpbtn').onclick = (e) => setHelp(!helpOpen(), e.detail === 0);
  addEventListener('pointerdown', (e) => {
    if (helpOpen() && !e.target.closest('#helppop, #helpbtn')) setHelp(false);
  }, true);
  addEventListener('resize', () => setHelp(false));
}

// ---------- boot ----------

async function main() {
  setStatus('init', 'starting GPU');
  $('export').disabled = true; // a browser may restore the last page's state
  setupEmbed(); // ?embed=1: before the first layout, so it never shows the toolbar
  readLooks(); // the light background before the first frame
  updateButtons();
  wireHelp();
  // A file chosen or dropped while the GPU starts (Open… works from the
  // first paint): kept and opened once the input is wired. It was ignored,
  // and a drop made the browser leave the page for the file (review r21)
  let early = null;
  const keep = (f) => { if (f) { early = f; setStatus('init', `starting GPU, then opening ${f.name}`); } };
  const over = (e) => e.preventDefault();
  const drop = (e) => { e.preventDefault(); keep(droppedFile(e)); };
  window.addEventListener('dragover', over);
  window.addEventListener('drop', drop);
  $('open').onchange = (e) => { keep(earlyPick([...e.target.files])); e.target.value = ''; };
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
  await startFromUrl(early);
}

// The start-up's own loads (the address's model, its adds, a tour's model, a list's first) and the
// one test, untouched(), of whether the visitor opened something since: none of them goes over it
// (the list's named model and the next ?add= did, cancelling the visitor's file: r51 A4, Q1)
const untouched = () => app.loadSeq === app.startSeq;
function startUpLoad(url) {
  const p = loadListed(url);
  app.startSeq = app.loadSeq; // (loadListed numbered it at once: beginLoad)
  return p;
}
// ?src= and then its ?add=s (each with an optional ?addat=x,y,z in mm, in the same order), and a view
// link (#view=) that waits for them, its part ids the scene's: the one chain, at start-up or from
// View in 3D (behind an embed's poster every ?add= was dropped: r51 A5)
function openStart(src) {
  const opening = startUpLoad(src);
  const adds = params.getAll('add'), ats = params.getAll('addat');
  if (!adds.length) return opening;
  app.addsPending = true;
  return opening.then(async () => {
    for (const [i, u] of adds.entries()) {
      if (!app.scene || !untouched()) break;
      const at = (ats[i] || '').split(',').map(Number);
      app.addOffset = at.length === 3 && at.every(Number.isFinite) ? at : null;
      const p = startAdd(() => loadUrl(u));
      app.startSeq = app.loadSeq;
      await p;
    }
    app.addsPending = false;
    if (app.pendingView && app.header && app.pendingView.src === app.sourceUrl) {
      applyView(app.pendingView.view, true);
      app.pendingView = null;
    }
  });
}
// View in 3D on an embed's poster: the model and its adds, then a ?tour= read while the poster was up
// (it was told "open its 3D model" and never played, urlTourPending left set -- r50 Q3)
// (src null: the list's first model, once the list has been read -- a ?list= embed's poster waits
// for View in 3D too: r53 Q2)
async function viewIn3D(src) {
  $('poster').hidden = true;
  setEmbedActive(true);
  if (!src && app.listRead) await app.listRead;
  src = src || app.listEntries?.[0]?.url || null;
  app.startSeq = app.loadSeq; // (the visitor's own ask)
  if (!src) { if (app.status !== 'error') setStatus('idle', idleText()); return; }
  await openStart(src);
  const w = app.tourWaiting;
  app.tourWaiting = null;
  if (w && app.header) { startTourIn(w.tour, w.url, w.step); app.autoTourFor = autoTourKey(); app.urlTourPending = false; }
}
// A file picked or dropped while the GPU starts: the model of those picked, its companions kept
// with it (pickModelFile) (the first file was taken, an .obj with its .mtl opened the .mtl: r50 A2;
// the .mtl lost to a load started before it: r51 A3, Q2)
const earlyPick = (files) => (files.length ? pickModelFile(files) : null);
// File › Add model…: the picked model joins the scene; one over the size refused before anything
// starts (Add model… called loadFile, whose own check came after beginLoad: r50 A1)
function addPicked(files) {
  if (!files.length || !app.scene) return;
  const f = pickModelFile(files);
  if (!refusedForSize(f)) startAdd(() => loadFile(f));
}

// The page's start from its address, once the renderer is up: the file the visitor chose meanwhile,
// ?list= (and the ?model= / ?index= of it), ?src=, an embed's ?poster=, ?add=, ?tour=. Its contract
// is the start-up table, tests/test-scene.mjs START_CASES (r51).
async function startFromUrl(early) {
  // the file the visitor chose while the GPU started: the newest ask, opened first, and nothing the
  // address names opens over it (it waited behind the list read, its line replaced, and the list's
  // model started and was cancelled: r51 A11)
  app.startSeq = app.loadSeq;
  // (refused for its size, it is the visitor's ask all the same: nothing the address names opens
  // over the refusal, which stands on the card -- the address's model opened over it, the refusal
  // painted nowhere: r52 A3, Q3)
  if (early) { openFile(early); app.startSeq = -1; }
  // ?model=<id> or ?index=<n> beside a ?list=: a model the list names
  // (modelUrlIn), so the list is read first; a name it does not have opens
  // its first model and says so. Else ?src=, a URL.
  const lists = params.getAll('list');
  // File › Check this list…: the list check (check.html) on this page's
  // lists, for their owner, whether or not they read
  if (lists.length && !app.embed) {
    const c = new URL('check.html', location.href);
    for (const l of lists) c.searchParams.append('list', new URL(l, location.href).href);
    $('checklist').href = c.href;
    $('checklist').hidden = false;
    syncMenuButtons();
  }
  let listed = null;
  let src = params.get('src');
  const place = modelNameIn(params);
  if (place) {
    // the model is on its way: its card says so, not "No model to show" for
    // the list's round trip (seconds, on a slow link). No Cancel: the list is
    // read whatever is pressed; a file the visitor opens meanwhile is theirs,
    // and the list's model does not open over it (untouched). With the
    // visitor's file already opening, its line and card are left to it.
    const reading = untouched();
    if (reading) {
      setStatus('idle', 'reading the model list…');
      app.readingList = true;
      showProgress('Opening the 3D model', null, 'reading the model list');
      $('pcancel').hidden = true;
    }
    try {
      listed = readLists(lists, () => false);
      await listed;
    } finally {
      if (reading) {
        app.readingList = false;
        $('pcancel').hidden = false;
        showEmpty(); // (the card again, with a list's error on it: it stayed hidden -- r50 Q1)
      }
    }
    src = modelUrlIn(params) || app.listEntries?.[0]?.url || null;
    // (told: r49 A4; behind a poster it opens with View in 3D, not now -- r51 Q7)
    if (src && !modelUrlIn(params) && untouched()) {
      tell(`the model list has no model ${place}: ${app.embed && params.get('poster') ? 'View in 3D opens its first' : 'its first opens'}`, 6000);
    }
  }
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
    // (no src: a model from the device, or the list's first, which the page
    // as first opened shows and Back returns to)
    const now = modelUrlIn(new URLSearchParams(location.search));
    const first = app.listEntries?.[0]?.url;
    if (viewHash() && app.header && (now ? app.sourceUrl === now : !app.sourceUrl || app.sourceUrl === first)) applyView(decodeView(viewHash()), true);
  });
  // ?src opens at once; ?list= (one or more) is read beside it, never in its
  // way. With no ?src the list's first model opens, unless the visitor opened
  // something meanwhile (untouched). Through loadListed, so a list read
  // meanwhile names it while it opens and a pick of it does not start it
  // again: review r19.
  // ?embed=1&poster=<image>: the picture, and the model only when the visitor
  // asks for it (View in 3D) -- a page of several embeds downloads none of
  // their models until one is wanted. Asked by js/model-list.js posterAsked, the rule js/early.js
  // holds its download back by; for a ?src= and for a list's first model alike (a ?list= embed
  // opened its first at once, poster or not: r53 Q2). A tour's own model is not held behind it.
  const poster = posterAsked(params) && (src || lists.length > 0) && untouched() && params.get('poster');
  let opening = null;
  if (poster) {
    try { $('posterimg').src = new URL(poster, location.href).href; } catch { /* a bad URL: the button alone */ }
    $('poster').hidden = false;
    setStatus('idle', POSTER_MSG);
    showEmpty();
    $('posterload').onclick = () => viewIn3D(src);
  } else if (src && untouched()) opening = openStart(src);
  // ?tour=<url> (js/tour.js): read beside the model; with no ?src the
  // tour's own model opens (ahead of a list's first), and the tour starts
  // once a model is shown
  const tourUrl = params.get('tour');
  const touring = tourUrl ? readTour(tourUrl) : null;
  // (its own tour, not the list's, plays over the first model: applyListEntry)
  app.urlTourPending = !!tourUrl;
  let tourOwn = false; // (the tour's own model opened: its failure is the one that holds the tour's note back)
  if (touring && !src && !poster) {
    opening = touring.then((r) => {
      if (!(r.tour && r.tour.model && untouched())) return null;
      tourOwn = true;
      return startUpLoad(r.tour.model);
    });
  }
  // (not over an error: a list read above and failed left the page's error, which this wrote over --
  // "reading the model list…" for good, the card with no error: r50 Q1. The page is still 'init'
  // here otherwise, "starting GPU", and this is what moves it on -- unless the visitor's own file is
  // opening, whose line it is.)
  if (!src && !poster && app.status !== 'error' && untouched()) {
    setStatus('idle', lists.length && !place ? 'reading the model list…' : tourUrl ? 'reading the tour…' : idleText());
  }
  // (already read when ?src was a place in it; its first not opened behind a poster)
  listed = listed || (lists.length ? readLists(lists, () => !src && !poster && untouched() && !touring) : null);
  app.listRead = listed; // (View in 3D on a list's poster waits for it)
  await Promise.all([opening, listed]);
  // (each load the address names has taken its early download by now: one left over -- the visitor
  // opened a file of their own instead -- is let go, not downloaded for no one: r53 Q3)
  releaseEarly();
  if (touring) {
    const r = await touring;
    if (r.error) failApart(`the tour ${r.error}`);
    else {
      // a tour with no model of its own, on a page given only a list: the
      // list's first model, as without a tour
      if (!app.header && !src && !poster && !tourOwn && untouched() && app.listEntries?.length) await startUpLoad(app.listEntries[0].url);
      // (a tour made for its own model, with the visitor's own file opened instead: not played over
      // it, and nothing said -- its cameras and parts played over the visitor's file: r52 A2, Q1)
      const notOurs = !!r.tour.model && !untouched();
      if (notOurs) app.urlTourPending = false;
      else if (app.header) startTourIn(r.tour, tourUrl, params.get('step'));
      // (behind an embed's poster: kept for View in 3D, nothing said -- r50 Q3)
      else if (poster) app.tourWaiting = { tour: r.tour, url: tourUrl, step: params.get('step') };
      // (told, whatever is shown: written idle to idle it was heard by no one, and over a drawing
      // nothing was said -- r48 A1, A2; not after its own model failed to open, whose error stands --
      // r49 Q5 -- but over any other failure, a list's or a ?src='s, it is: r50 A5, r51 Q4; never the
      // open-a-file words in an embed, whose visitor chose nothing to open)
      else if (!(tourOwn && app.status === 'error')) tell(`the tour is ready: open its 3D model${somethingShown() || app.embed ? '' : ` (${IDLE_MSG})`}`, 6000);
    }
    // (the next model picked from the list plays its own tour)
    if (app.header) { app.autoTourFor = autoTourKey(); app.urlTourPending = false; }
    // (read: the line no longer says it is being read -- r51, the start-up table)
    if (app.status === 'idle' && app.statusMsg === 'reading the tour…') setStatus('idle', idleText());
  }
}

// The model lists: fill the drop-down, open the first model when wanted (no
// other load started), and tell which lists could not be read, or that they
// name no models (the status line, not drawn, carries it too)
async function readLists(lists, openFirst) {
  // (read already when js/early.js started it, before main.js ran; read here again if that read
  // failed outright -- each list's own failure is in its answer, not a rejection)
  const early = earlyLists(lists);
  const r = await (early ? early.catch(() => fetchModelLists(lists, location.href, timedFetch)) : fetchModelLists(lists, location.href, timedFetch));
  fillModelList(r.entries);
  if (listsRead(r, openFirst())) await startUpLoad(r.entries[0].url);
}
// What the model lists' answer says, and whether to open their first model: a list with nothing in
// it to open is a failure apart from the load (failApart's one rule: its own put it on the card and
// in a note at once, and kept a failed load's error where a tour's replaced it -- r49 A2); one that
// failed beside lists that answered is told; the ready line carries it (app.listNote)
function listsRead(r, openFirst) {
  const note = r.errors.length ? listNote(r.errors) : r.entries.length ? '' : 'the model list names no models';
  // (the answer is in: the read for a model it names is over, and its own failure is the page's --
  // told only, as a refusal of another file during the read is, the card was left with no error)
  app.readingList = false;
  app.listNote = '';
  if (note && !r.entries.length) failApart(note);
  else if (note) tell(note, 6000);
  // (after failApart: its ready line already says it once; a first model to open writes its own)
  if (!note || !r.entries.length || openFirst) app.listNote = note;
  // (the note written into a ready line in place, the words others added after it kept -- the line
  // was rewritten whole: r50 A6)
  else rewriteReady(() => { app.listNote = note; });
  return !!openFirst && r.entries.length > 0;
}

// ?selftest=1: after loading, pick the canvas centre and publish one JSON line
// in <pre id="selftest"> so a headless run can grade the backend
// (tests/browser-smoke.sh). Runs on success and on failure.
async function selftest() {
  // (the adapter: a software one -- SwiftShader, lavapipe -- explains a slow
  // frame before any profile does)
  const out = { status: app.status, backend: app.backend, adapter: app.renderer?.adapterInfo || app.renderer?.detail || null,
    attempts: app.attempts, error: app.error || null, gpuLosses: app.gpuLosses || 0 };
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
        // (the file's edges kept while its facts failed: the edges reported, the facts' error beside)
        closed: e.facts ? e.facts.closed.filter(Boolean).length : null, ...(e.facts ? {} : { factsError: app.baseMesh?.edgeInfo?.error || 'none' }) }
        : { error: app.baseMesh?.edgeInfo?.error || 'none' };
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
