// CAD viewer front end: backend choice, loading (readers on first use), camera, part tree,
// picking, section. Rendering is on demand.

import { DEFAULT_TESSELLATION, MAX_FILE_BYTES, OVERSIZE_WORDS, bodyLabels, noSurfaces, decodeCadmesh, deflateCadmesh, gunzip, hashName, inflateCadmesh, isGzip, writtenSizeLimit, cadmeshToSave, StopRead, geomIsMm, notMmWords } from './cadmesh.js';
import { SNIFF_BYTES, extOf, formatOfName, drawingReaderOf, isCompanion, fileNameOfUrl, acceptList, opensShort, opensText, mbTenth, zipModel, zipCompanions, takesCompanions, openedName } from './formats.js';
import { companionsOverText, readCompanions } from './companions.js';
import { directFor, fileUrl } from './open-url.js';
import { samePlace } from './same-place.js';
import { withoutBom } from './step-text.js';
import { stepProducts } from './step-meta.js';
import { cacheAvailable, cacheClear, cacheDelete, cacheGet, cacheKey, cacheList, cachePut } from './mesh-cache.js';
import { PALETTES, bodyColours, hexToRgb, rgbToHex, schemeColours } from './palettes.js';
import { READ_TIMEOUT_MS, answeredFrom, entryByName, fetchModelLists, isRelative, isTimeout, listedUrlFrom, modelNameFrom, modelUrlFrom, posterAsked, readCapped, timedFetch } from './model-list.js';
import { earlyFetch, earlyLists, releaseEarly } from './early-fetch.js';
import { camDir, camUp, eyeOf, fitBox, fitDistance, levelOrbitBy, nearFar, orbitBy, panBy, pinchStep, qAxis, qFromBasis, qMul, qNorm, qRotate, quatFromView, refitForAspect, sphereOf, turnAbout, zoomAt, zoomBy } from './camera.js';
import { DEFAULT_ORIENT, PORTRAIT, VIEWS as VIEW_ROWS, VIEW_PRESETS, Z_UP_ORIENT, isoView, orientOrNull, orientQuat, orientRoles, orientTurn, orientUp } from './orient.js';
import { deviceFactor, forecast, forecastDone, forecastTotal, percentKnown, rateText, stepOf, timeLeft } from './import-progress.js';
import { browserEnv, useThreads } from './converter-choice.js';
import { DISPLAY_UNITS, MM_PER, autoUnit, displayUnit, fmtArea, fmtMass, fmtNum, fmtUnconverted, fmtVolume, headerUnitWord, unconvertedBack, unconvertedNum, unconvertedWord, unitSaid, unitWord } from './units.js';
import { bodyTable, edgeInstances, silhouetteInstances, FACTS_RULE, SILHOUETTE_CAP, overSilhouetteCap, flagsSaid, factsCurrent, momentaryFailure } from './edges.js';
import { MAX_NOTES, bodyKeys, decodeView, encodeView, resolveBodies, roundCamera, roundFraction, roundNotePoint } from './view-link.js';
import { aboveBelow, pastWords, rangesFrom } from './datum.js';
import { EXPORTS, NOTHING_TO_EXPORT, exportBasis, exportable } from './export-mesh.js';
import { drawingSVG } from './drawing-svg.js';
import { createMeasure, TOUCH_ONLY } from './measure-ui.js';
import { copiesOf, mergeModels, sceneUnitsRefusal, modelRanges, modelOfBody, sceneEdgesFacts, staleModels, edgesUsable, turnBox } from './scene.js';
import { clearance } from './clearance.js';
import { CUT_FILL, EMBED_DARK_BG, PAPER, STYLES, VIEW_BG, edgePasses, rgb, styleById, styleFor, toggleEdges } from './styles.js';
import { lookAt, multiply, perspective, ortho } from './mat4.js';
import { forgetPrefs, getPref, getPrefJSON, setPref, setPrefJSON } from './prefs.js';
import { MAX_TOUR_BYTES, namesFor, parseTour, partIndex, readingScale, resolveParts, tourAt, tourNames, tourSlug } from './tour.js';
import { EASE, poseAt } from './tour-path.js';
import { clearestDirection, meshFaceBoxes, obstaclesFor } from './tour-sight.js';
import { WebGLRenderer } from './renderer-webgl.js';

// The format readers and the 2D view, loaded when a file needs them, not before the first card
// (tests/test-first-phase.mjs, round 51); fetched once, a failure retried and said plainly (r52 A8, Q8)
const once = (load, what) => {
  let p = null;
  // (a failed download told by import()'s own words for one, any other failure as itself, the cause
  // in the console -- r53 A6, r54 A9)
  return () => (p ||= load().catch((e) => {
    p = null;
    console.error(e);
    throw new Error(DOWNLOAD_FAILED.test(String(e?.message || ''))
      ? `the viewer's reader for ${what} could not be downloaded: check the connection, then try again`
      : `the viewer's reader for ${what} did not load: ${e?.message || e}`);
  }));
};
const DOWNLOAD_FAILED = /dynamically imported module|Importing a module script failed|error loading dynamically imported/i;
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
  pageId: null, // this page's id, in each history entry it writes (cadvEntry: wireHistory)
  entryState: null, // the state of the history entry shown, as last seen
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

// What this tab last read or wrote for each model's colours (key -> body -> hex): a save writes only
// what changed since, over what is stored now, so another tab's picks are kept (R171-4)
const coloursSeen = new Map();
function loadOverrides(key, bodies) {
  const out = new Map();
  // (storage off or a damaged entry: no remembered colours)
  const saved = getPrefJSON(key, {});
  coloursSeen.set(key, new Map());
  if (!saved || typeof saved !== 'object') return out;
  for (const [i, hex] of Object.entries(saved)) {
    const n = Number(i);
    if (Number.isInteger(n) && n >= 0 && n < bodies && /^#[0-9a-f]{6}$/i.test(hex)) { out.set(n, hexToRgb(hex)); coloursSeen.get(key).set(n, hex.toLowerCase()); }
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
  const own = ownOverrides(), seen = coloursSeen.get(app.modelKey) || new Map();
  const stored = getPrefJSON(app.modelKey, {});
  const out = stored && typeof stored === 'object' ? { ...stored } : {};
  const now = new Map([...own].map(([i, c]) => [i, rgbToHex(c).toLowerCase()]));
  for (const [i, hex] of now) if (seen.get(i) !== hex) out[i] = hex;
  for (const i of seen.keys()) if (!now.has(i)) delete out[i];
  setPrefJSON(app.modelKey, Object.keys(out).length ? out : null);
  coloursSeen.set(app.modelKey, now);
}
window.__cadv = app;
app.redraw = () => viewChanged(); // for tests that change a display flag
app.refreshState = () => pushState(); // for tests that change a body's facts

// The model as drawn in the current colour scheme and part colours: the
// decoded model itself for the file's colours with nothing overridden, else a
// copy that differs only in its colours.
const inScheme = (base, overrides = app.overrides, faces = app.faceOverrides || new Map()) => (app.palette === 'file' && overrides.size === 0 && !faces.size
  ? base : { ...base, color: schemeColours(base, app.palette, overrides, faces) });

// The ONE writer of #announce: each write numbered, a deferred repeat landing only if nothing newer
// was said; one task's words together, in order (r45 Q2, r46 Q2)
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

// A note for the user, shown on the hover line for ms and read out (`said`, if it differs): the one
// way a note reaches anyone (r45 A1); flashHover only from here. Empty text: read only; said null
// or '': shown only.
// (a long note held long enough to read it: 6 s and 60 ms a character, at most 20 s -- R167-1)
function tell(text, ms = 1500, said = text, firm = false) {
  if (text) flashHover(text, ms >= 6000 ? Math.min(20000, Math.max(ms, 6000 + 60 * text.length)) : ms, firm);
  if (said) announce(said);
}

// A note added to the ready line, written only while the page is ready (a load, an error or a
// recovery keeps its own line), and the words alone told (r45 A2, Q4, r46 A2, Q1)
function tellReady(words, ms = 6000, firm = false) {
  if (app.status === 'ready') setStatus('ready', `${readyText()} · ${words}`);
  tell(words, ms, words, firm);
}

// States whose status text is progress, rewritten per fetch chunk or per
// tessellation tick: never announced by setStatus (the start of a load or a
// tessellation is announced once, explicitly, where it starts).
const PROGRESS_STATES = new Set(['loading', 'tessellating']);

function setStatus(s, msg) {
  // The live region hears an EVENT: a change into ready / idle / error / recovering / init, or a
  // new error; #status (not drawn) is rewritten every tick; ready-line words go as notes (r44 Q1)
  const text = msg || s;
  if (!PROGRESS_STATES.has(s) && (s !== app.status || (s === 'error' && text !== app.statusMsg))) announce(text);
  // (an error while a model or drawing stays is shown in the view: the error card shows it only
  // when nothing does, and the line is not drawn -- a load's failure over a model was read out
  // and drawn nowhere: r47 Q1)
  if (s === 'error' && somethingShown()) tell(text, 6000, null, true);
  app.status = s;
  app.statusMsg = msg || s; // (what the line says: sayNoFacts writes its word in place, showBase takes it back)
  $('status').textContent = msg || s;
  $('status').title = msg || s; // the whole message, where the line is cut short
  $('status').dataset.state = s;
  if (!PROGRESS_STATES.has(s)) { $('progress').hidden = true; const pd = $('pdetail'); if (pd?.style) pd.style.minHeight = ''; }
  // (a card, a model or an error is now the view's to show: index.html's
  // "Loading the 3D viewer…" goes)
  // ("?.": tests/test-scene.mjs runs this function's own code with no page)
  if (s === 'ready' || s === 'idle' || s === 'error') globalThis.document?.documentElement.classList.add('started');
  showEmpty();
}

// (every kind of file the page opens, as its empty card says)
const IDLE_MSG = `open or drop ${opensShort()}`;
// (MB of 2^20, as the limits and their words count: "546.4 MB" while loading, then refused as "521 MB
// of text" -- r72 Q8; a tenth kept, for a progress line that moves)
const mb = mbTenth; // (rounded up to a tenth, as the limits' words say a size: r73 Q4)
// a saved file's size: KB under 1 MB ("0.0 MB" for 31 KB -- R141-4)
const sizeText = (n) => (n < 2 ** 20 ? `${Math.max(1, Math.ceil(n / 1024)).toLocaleString('en')} KB` : `${mb(n)} MB`);
// (and what has come of a download rounded down: rounded up, it read "12.1 of 12.1 MB" still downloading -- r74 A10)
const mbSoFar = (n) => (Math.floor((n / 2 ** 20) * 10) / 10).toFixed(1);

// Whether a model or a 2D drawing is shown: the one test (r47 A2, Q3)
function somethingShown() { return !!(app.mesh || app.dxf); }

// A failure not the running or shown load's own: told while something is shown or a load runs,
// else the page's error (r48-r52); own: the start's own read failed (r57 I2, r58 Q7).
function failApart(msg, own = false) {
  if (somethingShown() || posterUp() || !(app.status === 'idle' || app.status === 'init') || (!own && (app.readingList || app.starting))) {
    tellReady(msg, 6000, true);
    // (behind a poster too: a tour alone takes it down with nothing behind it)
    if (app.starting && !own) app.heldFailure = msg;
  } else { setStatus('error', msg); announce(msg); }
}
// an embed's poster up: its picture stands in for the model until View in 3D
const posterUp = () => !!app.embed && !!$('poster') && !$('poster').hidden;

// The GPU recovery's start: the page 'recovering', but a load under way or an error up keeps its
// state, card and question, the loss told (r49 Q1, r50 A3, Q4)
// (the reason, often the browser's raw words, only in the ? box's graphics line: R169-5)
function recoveryStarts(why) {
  app.lossWhy = why;
  if (quietLoss()) return;
  const text = 'the graphics stopped; restarting them';
  if (PROGRESS_STATES.has(app.status) || app.status === 'error') tell(text, 6000);
  else setStatus('recovering', text);
}
// The recovery's end on a renderer that cannot hold the model: the page's error, or told under a load;
// noted (app.gpuLacks) so a Cancel says the model is not drawn (r50 A4, Q2, r51 A1)
function cannotHold() {
  const msg = 'the graphics restarted but cannot draw this model: close other tabs or apps, or open it on a computer';
  app.gpuReason = app.error;
  app.gpuLacks = { mesh: app.mesh, msg };
  if (PROGRESS_STATES.has(app.status)) tell(msg, 6000);
  else setStatus('error', msg);
  showInfo(); // (the ? box no longer says "recovering": R169-6)
}
// Whether the shown model is the one the recovered renderer could not hold (a drawing is no model:
// a note of none matched it, and Cancel over a drawing said its model could not be held -- r51 Q3 c)
const shownLacksGpu = () => !!app.mesh && !!app.gpuLacks && app.gpuLacks.mesh === app.mesh;
// The GPU recovery's end: ready, or idle with nothing shown, "recovered on …" told; a load started
// meanwhile keeps its state; an earlier "cannot hold" and its error ended (r48 A7, r49 Q1, r51)
function recovered() {
  const lacked = app.gpuLacks;
  app.gpuLacks = null;
  if (app.status === 'recovering' || (app.status === 'error' && lacked && app.statusMsg === lacked.msg)) {
    if (somethingShown()) setStatus('ready', readyText());
    else setStatus('idle', idleText());
  }
  if (!quietLoss()) tell('the graphics restarted; your view is as it was', 4000);
  showInfo(); // (the ? box no longer says "recovering": R169-6)
}
// A file from this device shown with measurements: leaving it loses them, and a reload or Back cannot
// open the file again (R171-1, R172-1)
const deviceWorkAtRisk = () => somethingShown() && !app.sourceUrl && (app.dxf ? app.dxf.view.results?.length : app.measure?.results?.length) > 0;
// A drawing shown, no load running: nothing on screen changes through a loss, so nothing is said (R170-4)
const quietLoss = () => !!app.dxf && !PROGRESS_STATES.has(app.status);
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
  // (a view link of a file from its sender's device names the file, and its view lands once it is
  // opened: the plain card said nothing of either -- R161-2)
  const pv = !app.embed && app.pendingView && !app.pendingView.search.get('src') && !modelNameIn(app.pendingView.search) ? app.pendingView.search.get('file') || 'its model' : null;
  $('emptyview').hidden = !pv;
  if (pv) $('emptyview').textContent = `This link holds a view of ${pv}, a file it cannot carry: open that file and the view comes back.`;
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
  if (!open) app.unspaceParts?.(); // (R49-2)
  document.body.classList.toggle('panel-open', open);
  $('panelbtn').setAttribute('aria-expanded', String(open));
  // closed from inside (Esc): focus would otherwise sit in a hidden panel
  if (!open && focusBack && $('parts').contains(document.activeElement)) $('panelbtn').focus();
  // a short drawer's first open of a new list, nothing selected, scrolls to the list where under about
  // three rows would show; with a selection, to its values at the top (R17-3, R18-2)
  if (open) requestAnimationFrame(() => {
    const a = $('parts'), t = $('tree');
    const fresh = app.listFresh;
    app.listFresh = false;
    if (!t.firstElementChild) return;
    if (app.selected.size) { if (!t.contains(document.activeElement)) a.scrollTop = 0; return; } // (R19-2)
    if (fresh && a.getBoundingClientRect().bottom - t.getBoundingClientRect().top < 100) {
      a.scrollTop += $('colours').getBoundingClientRect().top - a.getBoundingClientRect().top;
    }
  });
}

// Where the keyboard enters the parts panel: the parts list's tab stop, or
// with no model (no tree) the panel's first control
const partsStop = () => [$('tree').querySelector('.label[tabindex="0"]'),
  ...$('parts').querySelectorAll('button, select, input, summary')].find((c) => c && !c.disabled && c.getClientRects().length);

// Filter parts while typing: a window an on-screen keyboard shrank keeps the slide-out open (r22, r23)
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
  // (a forced backend tried first, then the others: one the browser lacks left a dead "No 3D" page,
  // its failure now only in the ? box -- R169-9)
  const all = ['webgpu', 'webgl2', 'webgl1'];
  const order = all.includes(forced) ? [forced, ...all.filter((b) => b !== forced)] : all;
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
  r.onerror = (msg) => { if (app.renderer === r) { app.error = msg; app.gpuReason = msg; failApart('the graphics could not draw the model: close other tabs or apps, then reload the page'); } };
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
  // (the recovery itself, not the status line, which a load keeps: R169-6); the loss's and a GPU
  // failure's own reasons are kept here, out of the visitor's notes (R169-4, R169-5)
  const lost = recovering ? ` (lost: ${app.lossWhy}; recovering)` : '';
  const why = app.gpuReason ? ` -- last GPU failure: ${app.gpuReason}` : '';
  return `${NAMES[app.backend] || app.backend}${lost}${skipped.length ? ` -- ${skipped.join('; ')}` : ''}${why}`;
}

// ---------- GPU model sync ----------
//
// app.wanted is the ONE model the GPU should hold; only gpuSync() uploads it, one at a time, so a
// superseded load never uploads; pickAt takes answers about app.mesh only.
let gpuChain = Promise.resolve();
const rendererWaiters = [];

const isDead = (r) => !r || r.isLost();

// Resolves once app.renderer is no longer `old`, rejects when recovery gives up; the timeout a
// backstop past recovery's ~25 s
function nextRenderer(old, ms = 120000) {
  if (app.renderer !== old) return Promise.resolve();
  // recovery is over: no renderer will come, so fail now rather than at the backstop
  if (gaveUp) return Promise.reject(new Error(gaveUpWords));
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

// The drawn mesh's edge instances onto renderer r, once per mesh and edges; never throws (edges the
// GPU cannot hold left out)
const edgeData = new WeakMap();

// ---------- Explode (plan feature 8) ----------
// Each body's direction summed down the tree (subassemblies part first); the farthest travels one
// diagonal at 100 %. Directions in bodyTable slots 0..2 (aXd on WebGL1), the fraction `explode`.
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

// The visitor's cut kept in place across a change of Explode, held while t is keepingCut's own; a
// tour step and a view link landing keep their fraction (r126 L3, r135 M1)
let viewLanding = false;
function keepingCut(fn) {
  const s = app.section;
  const k = { x: 0, y: 1, z: 2 }[s.axis];
  const keep = k !== undefined && !app.tour && !viewLanding && app.header && app.header.bbox;
  let at = null;
  if (keep) {
    // (held for the model or scene it was taken on, until the visitor sets the cut: another model, an
    // Add model or a move, or the slider back at its end, took the stale place -- r136 M1-M3)
    const h = s.held;
    if (h && h.axis === s.axis && h.t === s.t && h.header === app.header) at = h.at;
    else { const { min, max } = sectionBox(); at = min[k] + (max[k] - min[k]) * s.t; }
  }
  const out = fn();
  // (clamped to the box, as the slider is: a cut kept past the gathered model, below it, cut the whole
  // model away and its link -- t out of 0..1 -- opened uncut: r134 M1)
  if (at !== null && app.section.axis === s.axis) {
    setSectionAt(at);
    s.held = { axis: s.axis, t: s.t, at, header: app.header };
  }
  return out;
}

function setExplodeMode(mode) {
  return keepingCut(() => setExplodeModeNow(mode));
}
function setExplodeModeNow(mode) {
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

// Explode set by a tour's step or a link's view, not by the visitor: unsaid (R130-4, R131-5, R131-7)
const quietly = (fn) => { app.quietExplode = true; try { return fn(); } finally { app.quietExplode = false; } };
function setExplode(on, focus = false) {
  if (on === app.explode.on) return;
  return keepingCut(() => setExplodeNow(on, focus));
}
function setExplodeNow(on, focus) {
  const x = app.explode;
  if (on && (!app.header || !app.renderer)) return;
  // Measure and Explode exclude each other (Measure's points are where the bodies are), told and
  // read out (r47 A6, r48 Q8)
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
  if (!app.quietExplode) announce(on ? `exploded ${Math.round(x.t * 100)} %` : 'explode off');
  // (off: the focus goes to the button, or to the menu it is folded into)
  if (focus) (on ? $('xpoff') : toolFocus('explode')).focus();
}

// Explode off for a new model (or none), its row and button with it (r111 H2-M1)
function explodeOffForModel() {
  const x = app.explode;
  x.on = false;
  x.for = null;
  $('xpopt').hidden = true;
  $('explode').setAttribute('aria-pressed', 'false');
}

function syncExplodeRow() {
  const x = app.explode;
  $('xpopt').hidden = !x.on;
  $('explode').setAttribute('aria-pressed', String(x.on));
  $('explode').hidden = !app.renderer;
  $('explode').disabled = !app.header || app.header.meshes.length < 2;
  for (const b of $('xpmode').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === x.mode));
  const asm = $('xpmode').querySelector('[data-mode="assembly"]');
  asm.textContent = x.flat ? 'Radial (flat file)' : 'Assembly';
  // (its tooltip with its label: a flat file has no subassemblies -- R136-10)
  asm.title = x.flat ? 'Each part straight out from the middle: this file has no subassemblies' : 'Each subassembly away from the rest, then its parts within it';
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

// A lost GPU: a new renderer (the fallback order again) with app.wanted synced onto it; a loss during
// recovery re-runs it after, up to 3 attempts
let recovering = false;
let lossPending = null;
let recoveries = 0;
const RECOVERY_QUIET_MS = 5000;

// Recovery is over without a renderer: say so, and fail every load waiting on
// one, now and later (the page needs a reload).
// gaveUp: the technical reason (the ? box); gaveUpWords: the visitor's. The 3D model goes and the
// card says what to do, with a Reload button; a drawing stays (R169-1).
let gaveUp = null;
let gaveUpWords = '';
function giveUp(msg) {
  gaveUp = msg;
  const name = app.mesh && app.sourceName, device = !!name && !app.sourceUrl;
  // (an embed's only button opens the model in cad.place: R170-5)
  gaveUpWords = `The graphics stopped working and did not restart: reload the page${device ? `, then open ${name} again` : app.embed ? ', or open the model in cad.place' : ''}`;
  beginLoad(); // a load still fetching or tessellating goes stale and stops painting progress
  failRendererWaiters(gaveUpWords);
  $('backend').textContent = 'no 3D';
  if (app.dxf) { tellReady(`${gaveUpWords} to see 3D models`, 6000, true); showInfo(); return; }
  if (app.mesh) clearModel();
  document.body.classList.add('nogpu');
  const h2 = document.querySelector('#empty h2');
  if (h2) h2.textContent = 'The 3D graphics stopped';
  const b = $('emptyopen');
  b.textContent = 'Reload the page';
  b.onclick = () => location.reload();
  b.hidden = false;
  setStatus('error', gaveUpWords);
  announce(gaveUpWords);
  showInfo(); // its renderer line must stop naming the dead renderer
  // (the focused tool went with the tools: the focus to the card's button, not the page -- R170-3)
  const to = !b.hidden ? b : $('emptyfull');
  if (to && !to.hidden && document.hasFocus() && document.activeElement !== to) to.focus({ preventScroll: true }); // (never taken from a host page)
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
      // only a re-upload that then draws some seconds resets the count (else a loss on every draw recovers forever)
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
// With a section on, a cut face is drawn this share of the model's radius nearer along its ray
// (renderer-webgl.js VS), under the corpus's thinnest walls (r109 R1, r110 E1 and its sweep)
const CUT_PULL = 5e-4;
// ... and at most this share of the cut body's own radius: a small part's lead drew its inside
// (r111 G1; the round's audit has the lengths measured)
const CUT_PULL_BODY = 1.1e-3;
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

// pic (a picture's tile): { W, H, x0, y0, tw, th, scale }, the whole picture's projection cropped to
// the tile, so nothing jumps at a seam
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
    cutPull: CUT_PULL * (app.sphereBase || app.sphere).radius, cutPullBody: CUT_PULL_BODY,
    ...styleFrame(currentStyle(), ps, !!(pic && pic.light)),
    // the face boundaries over the shaded faces, in device px: the canvas's
    // own scale, not devicePixelRatio, which the canvas size caps
    edges: app.showEdges && currentStyle().edges ? { widthPx: EDGE_PX * ps, hoverPx: EDGE_HOVER_PX * ps, minPx: app.edgeMinPx * ps } : null,
    // device px per model unit at w = 1: the projection's y scale times half
    // the height (a body's projected radius is radius * focalPx / w)
    focalPx: proj[5] * h / 2,
    hoverId: app.hover || 0,
    // the GPU holding a model the UI does not show: background only (a colour copy of the shown
    // model, a recolour still uploading, keeps drawing)
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

// The model's X, Y and Z in a corner, turned as the camera is, those pointing away dimmer and under
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
    l.setAttribute('stroke', a.col); l.setAttribute('opacity', op); l.setAttribute('class', `a${a.n}`);
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', (a.x * (R + 8)).toFixed(1)); t.setAttribute('y', (a.y * (R + 8)).toFixed(1));
    t.setAttribute('fill', a.col); t.setAttribute('opacity', op); t.setAttribute('class', `a${a.n}`);
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

// What changes what a pixel hits (camera, cut, visibility) moves app.viewGen; a pick in flight from
// before is dropped
function viewChanged() {
  app.viewGen++;
  queueFrame();
}

// The camera framing bbox seen with q -> { target, dist, bar }, above `cover` px; pad >= 0 (a tour
// step) by fitWindow (R82-4, R90-1, R91-1, R91-2), pad < 0 (Fit) by fitBox.
function fitPose(bbox, q, margin = 1.05, cover = viewCover(), pad = -1, ortho = app.cam.ortho, top = 0) {
  const c = { ...app.cam, q, ortho };
  const box = $('stage');
  const h = Math.max(1, box.clientHeight), w = Math.max(1, box.clientWidth);
  const bar = Math.max(0, Math.min(cover, h - 1));
  const vis = h - bar - top;
  if (pad >= 0) return { ...fitWindow(c, bbox, margin, w, h, bar, vis < 200 ? Math.min(pad, 8) : pad, top), bar };
  const f = fitBox(c, bbox, 2 * Math.atan(Math.tan(c.fov / 2) * vis / h), w / vis, margin);
  let target = f.target;
  if (bar > 0) {
    const perPx = (2 * f.dist * Math.tan(c.fov / 2)) / h; // world units per CSS px at the target
    const up = camUp(c);
    target = target.map((v, k) => v - up[k] * (bar / 2) * perPx);
  }
  return { target, dist: f.dist, bar };
}
// The box centred in the window [pad, w - pad] x [top + pad, h - bar - pad], at the least distance its
// margin-scaled corners fit; a corner at depth D - z, eye offset e, draws at (x - e) / (D - z).
function fitWindow(c, bbox, margin, w, h, bar, pad, top = 0) {
  const d = camDir(c), u = camUp(c);
  const r = [u[1] * d[2] - u[2] * d[1], u[2] * d[0] - u[0] * d[2], u[0] * d[1] - u[1] * d[0]];
  const ctr = [0, 1, 2].map((k) => (bbox.min[k] + bbox.max[k]) / 2);
  const tv = Math.tan(c.fov / 2), th = tv * (w / h);
  const pts = [], raw = []; // (raw: the box itself, which is centred; pts: with the margin, which fits -- R93-5)
  for (let i = 0; i < 8; i++) {
    const p = [0, 1, 2].map((k) => ((i >> k) & 1 ? bbox.max[k] : bbox.min[k]) - ctr[k]);
    const dot = (a) => p[0] * a[0] + p[1] * a[1] + p[2] * a[2];
    pts.push([dot(r) * margin, dot(u) * margin, c.ortho ? 0 : dot(d)]);
    raw.push([dot(r), dot(u), c.ortho ? 0 : dot(d)]);
  }
  // each axis's window as tangents: x across the width, y from the bar's top to the view's top
  const p2 = Math.min(pad, w / 4, Math.max(0, (h - bar - top) / 4));
  const ax = [[-th * (1 - 2 * p2 / w), th * (1 - 2 * p2 / w)], [tv * (-1 + 2 * (bar + p2) / h), tv * (1 - 2 * (top + p2) / h)]];
  // the least D any offset could fit (each axis's bound), the eye in front of every corner
  let D = 0;
  ax.forEach(([lo, hi], j) => {
    const a = Math.max(...pts.map((p) => p[j] + hi * p[2])), b = Math.min(...pts.map((p) => p[j] + lo * p[2]));
    D = Math.max(D, (a - b) / Math.max(1e-9, hi - lo));
  });
  if (!c.ortho) D = Math.max(D, ...pts.map((p) => p[2] * 1.01 + 1e-6));
  // each axis's offset centring the box itself, bisected (R92-2, R93-5); then the least D at which the
  // margin's corners fit, so centred (R94-2)
  const R = Math.max(...raw.map((p) => Math.hypot(...p))) + 1e-9;
  const centre = (D) => ax.map(([lo, hi], j) => {
    let e0 = -R - 4 * D * (hi - lo), e1 = -e0;
    for (let k = 0; k < 50; k++) {
      const m = (e0 + e1) / 2, s = raw.map((p) => (p[j] - m) / (D - p[2]));
      if (Math.max(...s) + Math.min(...s) > lo + hi) e0 = m; else e1 = m;
    }
    return (e0 + e1) / 2;
  });
  const fits = (D) => { const e = centre(D); return ax.every(([lo, hi], j) => pts.every((p) => { const s = (p[j] - e[j]) / (D - p[2]); return s >= lo - 1e-9 && s <= hi + 1e-9; })); };
  if (!fits(D)) {
    let D0 = D, D1 = D * 1.05 + 1e-9;
    for (let k = 0; k < 40 && !fits(D1); k++) { D0 = D1; D1 *= 1.25; }
    for (let k = 0; k < 40; k++) { const m = (D0 + D1) / 2; if (fits(m)) D1 = m; else D0 = m; }
    D = D1;
  }
  const e = centre(D);
  // (the drawn box's left and right edges in px, for what it must keep clear of: R92-4)
  const xs = raw.map((p) => w / 2 + ((p[0] - e[0]) / (D - p[2]) / th) * (w / 2));
  return { target: [0, 1, 2].map((k) => ctr[k] + r[k] * e[0] + u[k] * e[1]), dist: D > 0 ? D : 1, xs: [Math.min(...xs), Math.max(...xs)] };
}

function fitTo(bbox) {
  if (!bbox) return;
  if (app.walk) setWalk(false); // (every fit ends Walk -- Fit, a view, a double-click: R121-2, R122-2)
  const c = app.cam;
  const s = sphereOf(bbox);
  // the zoom's limits follow the sphere: what is framed, whatever the view
  c.viewRadius = s.radius;
  // the header as it will be drawn: a wrapping row refolded now, not after this task (a step framed
  // for the two-line header's view); a scrolling row left alone (its scroll and focus kept)
  const tb = $('tb');
  if (getComputedStyle(tb).flexWrap !== 'nowrap' && !toolbarFits(tb)) refold();
  const box = $('stage');
  const h = Math.max(1, box.clientHeight);
  const aspect = box.clientWidth / h;
  // (the target at the box's middle, the model's turning point, though its nearer corner draws
  // larger: the exact fit would move the pivot off the model -- R92-1)
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
    b.title = v.id === 'iso' ? `Iso view, as the model opened (${v.key})` : `${v.name} view (${v.key})`; // (the way back to the start named: R164-4)
    b.setAttribute('aria-keyshortcuts', v.key);
    const k = document.createElement('kbd');
    k.textContent = v.key;
    b.append(k);
  } else b.title = `${v.name} view (9 from the opposite view)`; // (no key of its own: R140-6)
  document.querySelector('.presets').append(b);
  // and its key in the ? box, before "the opposite view"
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

// A short note where the hovered part's name goes, for ms (1.5 s); one of 4 s or more holds the line
// for its time, and its end puts back the last label a view gave (r46 Q5, r47 A3, Q5)
let noteHeldUntil = 0, lastLabel = '', noteFirm = false;
// firm: a failure's words, which a tap's part name does not replace while held (R167-1)
function flashHover(text, ms = 1500, firm = false) {
  const hov = $('hover');
  hov.textContent = text;
  noteHeldUntil = ms >= 4000 ? performance.now() + ms : 0;
  noteFirm = firm && !!noteHeldUntil;
  clearTimeout(viewNameTimer);
  viewNameTimer = setTimeout(() => { noteHeldUntil = 0; if (hov.textContent === text) hov.textContent = lastLabel; }, ms);
}
// the hover line's label unless a note holds it (kept for the note's end); `asked`: a tap asking for
// the name, shown through a hold (r47 Q5, r48 A8, Q9)
function hoverLabel(text, asked = false) {
  lastLabel = text;
  if (asked && text && $('hover').textContent === TOUCH_HINT) setPref('cadv.touchHint', '1');
  if ((!(asked && text) || noteFirm) && performance.now() < noteHeldUntil) return;
  noteHeldUntil = 0;
  $('hover').textContent = String(text ?? '').replace(/ #(\d)/g, ' #$1'); // (" #3" kept with its name: R39-7)
}
// the hover line emptied, a note's hold and the last label with it (a model or drawing left)
let carriedNote = ''; // (a note about the load itself, kept through its clear: R143-1)
function clearHover() {
  lastLabel = '';
  if (typeof carriedNote === 'string' && carriedNote && $('hover').textContent === carriedNote && performance.now() < noteHeldUntil) return;
  noteHeldUntil = 0;
  $('hover').textContent = '';
}

// The first model this browser shows on a touch-only screen: the gestures, once per browser, unless
// a note is showing ("☰ for parts" only where the ☰ is: R6-2)
let TOUCH_HINT = 'one finger turns · two pinch and pan · tap selects a part · ☰ for parts'; // (as the ? box: R151-14)
function touchHintOnce() {
  // (after the load's own note, not instead of it: R144-3)
  if (carriedNote && $('hover').textContent === carriedNote && performance.now() < noteHeldUntil) { setTimeout(touchHintOnce, noteHeldUntil - performance.now() + 50); return; }
  if (app.embed || !coarseOnly() || $('hover').textContent || !$('touredit').hidden) return; // (embedded: its own hint; not over the maker, R163-4)
  // (storage off: shown every time, which is harmless)
  if (getPref('cadv.touchHint')) return;
  TOUCH_HINT = `one finger turns · two pinch and pan · tap selects a part${$('panelbtn').getClientRects().length ? ' · ☰ for parts' : ''}`;
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
    // (a view's t is the scene's, whatever box a tour's step measured it in: a link copied mid-tour)
    section: { ...app.section, t: sectionTOf(null), of: null }, hidden: [...app.hidden], selected: [...app.selected],
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
  // a whole link (with a camera) naming no cut or hidden parts means none (the Section button's
  // last axis stays a real one)
  if (v.section) Object.assign(app.section, { of: null, held: null }, v.section, v.section.axis !== 'off' ? { last: v.section.axis } : {});
  else if (v.cam) app.section.axis = 'off';
  if (v.hidden || v.cam) { app.hidden = new Set(bodies.hidden); syncTreeChecks(); }
  // Explode as the link has it (none: off), how far first, then on, then how; a link's own cut is
  // the link's, not kept through its Explode (r135-r137)
  const landExplode = () => {
    if (v.explode && app.renderer) {
      app.explode.t = v.explode.t;
      quietly(() => setExplode(true));
      if (app.explode.on && app.explode.mode !== v.explode.mode) setExplodeMode(v.explode.mode);
      // (the sphere grown by the link's amount, which neither call above does when on in that mode: r111 H2-M2)
      syncExplodeSphere();
      syncExplodeRow();
    } else if (v.cam && app.explode.on) quietly(() => setExplode(false));
  };
  viewLanding = !!v.section;
  try {
    if (v.section) landExplode(); else keepingCut(landExplode);
  } finally { viewLanding = false; }
  select(bodies.selected, false);
  // A view made on another shape (a desktop link on a phone): its selection, else all it showed,
  // framed afresh from the same side (its camera alone cut the part off on a narrow screen)
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
  // (and the list opened at it, as a pick in the view opens it: a link's part was in a closed branch,
  // nothing in the list lit -- R36-4)
  if (bodies.selected.length) revealRow(bodies.selected[0]);
  // the part a link points at, named as it opens (on a phone the info panel
  // is in the closed drawer)
  if (link && bodies.selected.length && !bodies.changed) {
    const ids = bodies.selected;
    const name = ids.length === 1 ? meshLabel(ids[0]) : `${ids.length} parts`;
    tell(`linked: ${name}`, 4000, `the link points at ${name}`);
  }
  if (bodies.changed) {
    // (only what the link held: "its parts are not selected" from a link that selected none -- R131-4)
    const lost = [v.selNames?.length ? `${bodies.selected.length} of ${v.selNames.length} selected ${v.selNames.length === 1 ? 'part' : 'parts'} found by name` : v.selected?.length ? 'its parts are not selected' : '',
      v.hidden?.length ? 'hidden parts not applied' : ''].filter(Boolean);
    const note = `this model has changed since the link was made${lost.length ? `: ${lost.join(', ')}` : ''}`;
    tell(note, 6000);
  }
}

app.exportMesh = (fmt) => exportMesh(fmt); // (for tests/ui-checks.py)
// (for tests/ui-checks.py tour-leaves-no-state, through the page's one start, startTourIn)
app.playTour = (t) => startTourIn(parseTour(JSON.stringify(t), location.href), null);
app.playTourIn = app.playTour;
app.captureStep = (o) => captureStep(o);
app.openUrl = (u) => loadUrl(u);
// Export the parts shown as STL, 3MF (Z up) or GLB (Y up), in their colours, whole (js/export-mesh.js).
// A saved file's name: the model's without .gz and extension, a scene's bases joined
const saveBase = (name) => (name || 'model').split(' + ').map((n) => n.replace(/\.gz$/i, '').replace(/\.[^.]+$/, '')).filter(Boolean).join('+') || 'model';
// a picture's name: the model's or the drawing's, and when it was taken (a drawing's had its own
// rule, no time and its .gz kept)
function pictureName(source) {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${saveBase(source)}-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.png`; // (to the second: two in a minute took the browser's "(1)" -- R156-10)
}
// Whether body mi of a mesh is closed (the facts' flag; not while they are unknown): the one answer
// for the cut fill, Measure's cut-face point and clearance's containment
function closedOf(mesh, mi) {
  const c = mesh?.edgeInfo?.value?.facts?.closed;
  return c ? !!c[mi] : false;
}
// What an export or Save drawing writes: the visitor's own parts and colours, a playing tour's kept
// under app.tour.base, not the step's (r70 Q2, r71 A1, r72 A4)
const ownHidden = () => (app.tour ? new Set(app.tour.base.hidden) : app.hidden);
const exportState = () => (app.tour ? { hidden: ownHidden(), color: inScheme(app.baseMesh, ownOverrides(), ownFaces() || new Map()).color } : { hidden: app.hidden, color: app.mesh.color });
async function exportMesh(fmt) {
  if (!app.header || !Object.hasOwn(EXPORTS, fmt)) return;
  // (the writers write millimetres: a model in another unit refused in words -- r84 A5)
  const notMm = notMmWords(app.header, `a ${fmt.toUpperCase()} file is`);
  if (notMm) { tellReady(`export refused: ${notMm}`); return; }
  const own = exportState();
  const model = { ...app.baseMesh, color: own.color };
  // (the bodies shown that have a triangle: what is written, counted and said -- js/export-mesh.js)
  const ids = exportable(model, app.header.meshes.map((_, i) => i + 1).filter((id) => !own.hidden.has(id)));
  if (!ids.length) { tell(NOTHING_TO_EXPORT); return; }
  const names = ids.map((id) => meshLabel(id));
  const base = saveBase(app.sourceName);
  // (its progress and end through tellReady, the ready line's one guard -- r46 A6, r47 A1, Q2)
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
  // (the parts written whole, said when a cut or explode is on; a cut only if it removes something
  // of the bodies written, as drawn -- r128 L2, r134 3D L2, r138 L1, r139 L2)
  const pl = sectionPlane(), sb = pl && drawnBox(ids);
  const cuts = !!pl && !!sb && [0, 1, 2].reduce((m, k) => m + Math.max(pl[k] * sb.min[k], pl[k] * sb.max[k]), 0) > pl[3] + 1e-9 * (1 + Math.abs(pl[3]));
  const viewOnly = [cuts ? 'uncut' : '', app.explode.on && app.explode.for === app.header && app.explode.t > 0 ? 'unexploded' : ''].filter(Boolean);
  // (only what is on named: a section alone read "the section and Explode" -- R141-9)
  const what = viewOnly.length === 2 ? 'the section and Explode change' : cuts ? 'the section changes' : 'Explode changes';
  const whole = viewOnly.length ? ` (${viewOnly.join(', ')}: ${what} the view, not the file)` : '';
  app.lastExport = { fmt, bytes: bytes.length, bodies: ids.length, name, whole }; // (for tests)
  tellReady(`saved ${name}: ${fmtInt(ids.length)} ${ids.length === 1 ? 'body' : 'bodies'}, ${bytes.length < 1048576 ? `${Math.max(1, Math.ceil(bytes.length / 1024))} KB` : `${(Math.ceil(bytes.length / 104857.6) / 10).toFixed(1)} MB`}${whole}` /* (up, as every save's: R142-8) */, whole ? 6000 : 3000);
}

// A note given a frame to draw before work that freezes the view (100 ms at most: a hidden tab)
const notePainted = () => new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 100); });

// Save picture (P): a PNG at the options' size and background (in tiles, to 8192 px / 16.7 Mpx),
// Measure's results and hole markers drawn in; print: printed instead of saved
async function savePicture(print = false) {
  // a drawing: its canvas without the hover and selection; on a phone the same Share / Save as a
  // model's picture (UI design round 11 R11-5)
  if (app.dxf) {
    const png = await app.dxf.view.png();
    if (!png) return;
    if (print) return printPng(png);
    const name = pictureName(app.dxf.name);
    return offerPicture(png, name, () => { downloadBlob(png, name); tell(`saved ${name}`, 3000); });
  }
  if (!app.header || !app.renderer) return;
  // (said, and a frame drawn to say it, before the view freezes for the picture: R119-3)
  if (!print) { tell('preparing the picture…', 30000); await notePainted(); }
  const pic = await renderPicture(print ? { ...app.pic, bg: 'white' } : app.pic); // (paper: R20-2)
  if (!pic) { tell('the picture could not be made: try again, or with a smaller window', 6000); return; }
  const out = pic.canvas;
  const png = await new Promise((ok) => out.toBlob(ok, 'image/png'));
  if (print) return printPng(png);
  if ($('hover').textContent === 'preparing the picture…') tell('preparing the picture…', 1, ''); // (its note ended)
  const name = pictureName(app.sourceName);
  offerPicture(png, name, () => {
    const url = downloadBlob(png, name);
    app.lastPicture = { name, width: out.width, height: out.height, url, cssW: pic.cssW, cssH: pic.cssH, tiles: pic.tiles, capped: pic.capped }; // (for tests)
    // (a size the view has grown too big for saves at the largest allowed)
    tell(`saved ${name}, ${out.width} × ${out.height}${pic.capped ? ` (the largest a picture of this view can be at ${app.pic.scale}×)` : ''}`, 3000);
  });
}

// A picture made: saved, or on a touch-only device offered: the share sheet needs a fresh tap, so
// "Picture ready: Share / Save" waits 8 s for one (Share only where files can be shared)
function offerPicture(png, name, save) {
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

// The view rendered at N× (capped 8192 px / 16.7 Mpx), no hover or selection tint, Measure painted
// in: -> { canvas, scale, cssW, cssH } | null; pictureSize -> { s, W, H, capped }
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
  $('picbgview').textContent = currentStyle().paper || app.lightBg ? 'View (paper)' : 'View';
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
    if (!pic) throw new Error('the picture could not be made: try again, or with a smaller window');
    return new Promise((ok) => pic.canvas.toBlob(ok, 'image/png'));
  });
  navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(
    () => tell('picture copied', 3000),
    (e) => tell(`the picture could not be copied (${e.message || e}): use Save picture instead`, 6000)); // (R167-8)
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

// The view at app.pic.scale x its size, in tiles of up to 2048 px; transparent by a black and a white
// render (alpha = 1 - (white - black)). -> { canvas, scale, cssW, cssH, tiles, capped } or null
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
  app.measure.paint(ctx, s, !!currentStyle().paper || !!app.lightBg || opts.bg !== 'view'); // (Light background too: R156-1)
  return { canvas: out, scale: s, cssW: cw, cssH: ch, tiles, capped };
}

// The copies of body `id` (1-based ids, itself included): js/scene.js copiesOf
function sameParts(id) {
  return copiesOf(app.header.meshes, id, app.header.bbox);
}
const instancesOf = (id) => sameParts(id).length;
app.sameParts = sameParts; // (for tests)
app.select = (ids) => select(ids, false); // (for tests: a selection as a click makes it)

// Per-face paint (feature review item 24): Paint beside the part colour turns
// it on; a click paints the clicked b-rep face in the swatch's colour (kept
// while this model is open; Reset with nothing selected clears it too)
app.faceOverrides = new Map();
function setPaint(on) {
  // (one click mode at a time; not while exploded, nor while a tour plays -- refused first)
  if (on && app.tour) { tell('Paint is off while a tour plays: a tour step holds no face colours', 3000); on = false; }
  if (on && app.measure && app.measure.on) app.measure.setOn(false);
  if (on && app.explode.on) setExplode(false);
  const was = app.paintFaces;
  app.paintFaces = on && !!(app.baseMesh && app.baseMesh.faces);
  if (was && !app.paintFaces) tell('paint off', 3000); // (R65-1, R66-3)
  $('paintbtn').setAttribute('aria-pressed', String(app.paintFaces));
  if (on && !app.paintFaces) tell('this model has no b-rep faces to paint', 3000);
  else if (on) tell(`Paint: ${tapWord()} a face to paint it in the swatch's colour`, 3000);
  updateButtons();
}
function paintFace(f) {
  const c = hexToRgb($('partcolour').value), old = app.faceOverrides.get(f);
  // (no Undo step for a face already that colour: R136-6)
  if (old && old.every((v, i) => Math.abs(v - c[i]) < 1e-6)) { tell('that face is that colour already', 2000); return; }
  rememberColours('Paint'); // (a wrong face undone by Ctrl+Z, not only by Reset all: R135-3)
  app.faceOverrides.set(f, c);
  updateButtons();
  recolour(`face painted`);
  if (app.selected.size) tell('face painted: it shows once deselected', 3000, ''); // (R134-5)
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

// Save drawing (SVG): the selection (else all shown) 1:1 in mm along the nearest preset view, every
// b-rep edge, holes as circles (js/drawing-svg.js)
function saveDrawing() {
  if (!app.header || !app.baseMesh?.faces) return;
  // (the visitor's own parts during a tour, as an export writes them: r72 A4)
  const hidden = ownHidden();
  // (a selected part hidden is not drawn, as the view and the exports leave it out: R156-6)
  const sel = [...app.selected].filter((id) => !hidden.has(id));
  const ids = sel.length ? sel : app.header.meshes.map((_, i) => i + 1).filter((id) => !hidden.has(id));
  if (!ids.length) { tell('nothing shown to draw'); return; }
  // (a drawing at 1:1 in mm: a model in another unit refused in words -- r84 A5)
  const notMm = notMmWords(app.header, 'a drawing is');
  if (notMm) { tell(notMm); return; }
  const preset = nearestPreset(app.cam);
  const [yaw, pitch] = VIEWS[preset];
  const c = { q: presetQuat(yaw, pitch, app.cam.orient) };
  const view = lookAt([0, 0, 0], camDir(c).map((v) => -v), camUp(c));
  const right = [view[0], view[4], view[8]], up = [view[1], view[5], view[9]];
  const parts = ids.map((id) => ({ id: `body-${id}`, name: meshLabel(id), geom: app.measure.geometry(id - 1) }));
  const base = saveBase(app.sourceName);
  const label = $('model').querySelector('.mname')?.textContent || base;
  const d = drawingSVG(parts, right, up, {
    title: `${label}: ${VIEW_NAMES[preset]} view, 1:1, mm${sel.length ? ` (${fmtInt(ids.length)} selected ${ids.length === 1 ? 'part' : 'parts'})` : ''}` });
  const name = `${base}-${VIEW_NAMES[preset].toLowerCase()}.svg`;
  downloadBlob(new Blob([d.svg], { type: 'image/svg+xml' }), name);
  app.lastDrawing = { name, preset, width: d.width, height: d.height, lines: d.lines, circles: d.circles, svg: d.svg }; // (for tests)
  tell(`saved ${name}: ${VIEW_NAMES[preset]} view, ${d.width.toFixed(1)} × ${d.height.toFixed(1)} mm`, 3000);
}

// The model in the address, one way only: a list's by ?model=<id>, else ?index=<n> (1-based); any
// other ?src=<URL>
const MODEL_PARAMS = ['model', 'index', 'src'];
function setModelParam(u, url) {
  const list = url && params.getAll('list').length ? app.listEntries || [] : [];
  const i = list.findIndex((e) => e.url === url);
  for (const k of MODEL_PARAMS) u.searchParams.delete(k);
  u.searchParams.delete('unit'); // (another model, or the same named again: read as it reads)
  if (i >= 0 && list[i].id) u.searchParams.set('model', list[i].id);
  else if (i >= 0) u.searchParams.set('index', String(i + 1));
  else if (url) u.searchParams.set('src', url);
  // (the query as typed, not "models%2F…": searchParams escapes / and : that a query may hold -- R147-5)
  u.search = u.search.replace(/%2F/gi, '/').replace(/%3A/gi, ':');
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
  else if (app.sourceName && !app.dxf) u.searchParams.set('file', app.sourceName); // (named on the empty page: R161-2)
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

// The added models a view link carries (from a URL) and how many it leaves out: one answer (r52 A5)
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
  // ("copied" only when the clipboard took it, r47 A5; the box says what it holds, r48 Q11; models
  // added from this device, which the link leaves out, said too: r51 A6)
  const nMeas = app.dxf ? app.dxf.view.results?.length || 0 // (a drawing's too: R25-6)
    : app.measure ? app.measure.results.filter((r) => r.mode !== 'note').length : 0; // (R24-7)
  const said = linkToldText(copied, !!app.sourceUrl, nNotes, linkAdds().left, nMeas, !!app.dxf, !app.dxf && (app.overrides?.size || 0) > 0, !app.dxf && (app.faceOverrides?.size || 0) > 0, !app.dxf && !!app.ref && app.section.axis !== 'off');
  if (said) tell(said, copied ? 3000 : 4000);
}
// File > Embed in a page…: the iframe for this model at this view, its theme, Copy and a look as a
// visitor (only a guide's example iframe and an unnamed &theme= led there: R161-1)
function embedCode() {
  const u = new URL(viewLink());
  u.searchParams.set('embed', '1');
  if ($('embedtheme').value === 'light') u.searchParams.set('theme', 'light');
  // (named as the viewer names it, a list's name: R162-6)
  const title = `${app.dxf ? app.dxf.name : listEntry(app.sourceUrl)?.name || app.sourceName || 'A model'} in cad.place`.replace(/["<>&]/g, ''); // (not the toolbar's counts: R163-6)
  return { url: u.href, code: `<iframe src="${u.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" width="640" height="420" style="border:0; max-width:100%" allow="fullscreen" allowfullscreen title="${title}"></iframe>` };
}
function syncEmbed() {
  const ok = !!(app.dxf ? app.dxf.url : app.sourceUrl), e = ok ? embedCode() : { url: '', code: '' };
  $('embedcode').value = e.code;
  // (a drawing's code carries no view: R162-5)
  $('embedwhat').textContent = `Paste this into your page's HTML: it shows ${app.dxf ? 'this drawing, fitted to its frame' : 'this model at this view'}, and visitors can ${app.dxf ? 'zoom it' : 'turn it'} and open it here.`;
  $('embedsee').hidden = !ok;
  if (ok) $('embedsee').href = e.url;
  $('embedcopy').disabled = !ok;
  $('embednote').hidden = ok;
  $('embednote').textContent = ok ? '' : 'This model was opened from this device: an embed needs it at a web address. Put the file on your site, open it from there, then embed it.';
}
function openEmbed() {
  closeMenus();
  syncEmbed();
  $('embedcard').hidden = false;
  // (the code follows the view while the card is open: a drag beside it left the old view's -- R162-1)
  clearInterval(app.embedTick);
  app.embedTick = setInterval(() => { if ($('embedcard').hidden) clearInterval(app.embedTick); else if (embedCode().code !== $('embedcode').value) syncEmbed(); }, 400);
  ($('embedcopy').disabled ? $('embedclose') : $('embedcopy')).focus();
}
function closeEmbed(focusBack = true) {
  if ($('embedcard').hidden) return false;
  $('embedcard').hidden = true;
  if (focusBack) ($('filemenu').classList.contains('folded') ? $('filemenu').querySelector('.menu-btn') : $('embedbtn')).focus();
  return true;
}
async function copyEmbed() {
  let copied = false;
  try { await navigator.clipboard.writeText($('embedcode').value); copied = true; } catch { /* no clipboard */ }
  if (!copied) { $('embedcode').focus(); $('embedcode').select(); }
  tell(copied ? 'Embed code copied: paste it into your page' : 'Copy the selected code (Ctrl+C)', 3000);
}

// What Copy view link tells: copied, and what the link does not carry (r49 A6, Q6; r50 Q6)
function linkToldText(copied, hasUrl, nNotes, nLocal = 0, nMeas = 0, is2d = false, coloured = false, painted = false, refd = false) {
  const meas = nMeas === 1 ? 'measurement' : `${nMeas} measurements`; // (a drawing has no notes or list: R26-3)
  const clauses = [hasUrl ? '' : 'it holds the view, not the file (opened from this device)',
    hasUrl && nLocal ? `it leaves out the ${nLocal === 1 ? 'added model' : `${nLocal} added models`} opened from this device` : '',
    nNotes > MAX_NOTES ? `it carries the first ${MAX_NOTES} of its ${nNotes} notes (a link is short)` : '',
    !nMeas ? '' : is2d ? `it leaves out the ${meas}` : `it carries notes, not the ${meas} (copy them from the results list)`,
    // (R131-2, R132-6; both in one clause, not two "it leaves out" in a 3 s note: R133-9)
    coloured && painted ? 'it leaves out the part colours and painted faces'
      : coloured ? 'it leaves out the part colours (they stay in this browser)'
        : painted ? 'it leaves out the painted faces (they last while this model is open)' : '',
    // (the cut's number read from the selection's corner opened from the model's, unsaid: R136-1)
    refd ? "its cut's position reads from the whole model's corner, not the selection's" : ''].filter(Boolean);
  if (copied) return `View link copied${clauses.length ? `: ${clauses.join('; ')}` : ''}`;
  return clauses.length ? `The view link: ${clauses.join('; ')}` : '';
}

// ---------- tours (js/tour.js) ----------
// A .cadtour.json over the model (?tour=<url>): a step flies to its view (a preset, a camera, or
// parts framed above the card) with its caption; ◀ ▶ step, ✕ (Esc) puts the view back.

// the bottom of the view the caption card covers (frames sit above it)
const tourCover = () => (app.tour && !$('tourcard').hidden ? $('tourcard').offsetHeight + 16 : 0);

// a name with its owner, as compared: lower case, one space either side of each ›
const pathKey = (s) => s.split('›').map((x) => x.trim().toLowerCase()).join(' › ');

function tourParts(names) {
  // (a name with its owner matched whole, else by its last two pieces, never its last alone -- R37-1, R38-1)
  if (app.tourIdxFor !== app.header) {
    const idx = partIndex(app.header, app.partLabels, firstModelBodies());
    // (the file's names first; then the list's, numbered: "COMPOUND #2" named nothing -- R36-5)
    app.tourIdx = { bodies: idx.bodies, get: (k) => idx.get(k) ?? app.rowNames?.get(k) };
    app.tourIdxFor = app.header;
  }
  // (every ending, then the whole name: R39-3)
  const lacking = [];
  names = names.flatMap((n) => {
    if (typeof n !== 'string' || !n.includes('›')) return [n];
    const k = pathKey(n), parts = k.split(' › ');
    let ids = null;
    for (let i = 0; !ids && i < parts.length - 1; i++) ids = app.rowPaths?.get(parts.slice(i).join(' › '));
    ids ||= app.tourIdx.get(n.trim().toLowerCase()) || app.tourIdx.get(k);
    if (ids) return [...ids].map((id) => `#${id}`);
    if (app.rowPaths?.size) { lacking.push(n); return []; }
    return [n];
  });
  const r = resolveParts(names, app.tourIdx);
  return lacking.length ? { ...r, missing: [...r.missing, ...lacking] } : r;
}

async function readTour(url) {
  // (carried in the link itself, z:…: js/tour-link.js -- R163-5)
  if (url.startsWith('z:')) {
    try { return { tour: parseTour(await (await import('./tour-link.js')).unpackTour(url), location.href) }; } catch (e) { return { error: `in the link could not be read: ${e.message}` }; }
  }
  let abs;
  // (a tour shared as a GitHub page or a Dropbox link is read from the file, and its model
  // resolves against that file: js/open-url.js fileUrl)
  try { abs = fileUrl(new URL(url, location.href).href); } catch { return { error: `"${url}" is not a URL` }; }
  let text, from = abs;
  try {
    const r = await timedFetch(abs);
    // (each error a verb's clause after "the tour": it read "the tour not JSON: …" -- R108-2)
    if (!r.ok) return { error: `could not be read: ${r.status === 404 ? 'not found' : 'refused'} (${r.status}): ${abs}` };
    // (its model resolves against the URL that answered, as a list's files do: r56 A1)
    from = answeredFrom(r, abs);
    // (read up to its limit, as it arrives: js/model-list.js readCapped, js/tour.js MAX_TOUR_BYTES)
    // (the time running out while the body still came is the same timeout: r55 A5, Q7)
    try { text = await readCapped(r, MAX_TOUR_BYTES); } catch (e) { return { error: isTimeout(e) ? `gave no answer in time: ${abs}` : `could not be read: ${e.message}: ${abs}` }; }
  } catch (e) {
    // (given up after its time: said so, as a list's read says it -- it read "not there, or no
    // CORS": r54 A5)
    if (isTimeout(e)) return { error: `gave no answer in time: ${abs}` };
    // (the site answered without CORS -- the tour is not there, or not
    // shared -- or did not answer: fetchFailedText tells which)
    return { error: await fetchFailedText(abs, 'the tour', e, 'could not be read') };
  }
  try { return { tour: parseTour(text, from) }; } catch (e) { return { error: `could not be read: ${e.message}` }; }
}

// (each step's own bars, the tallest kept: R131-1; measured again on a new shape: R154-3)
function tourFloor(tour) {
  let floor = 0;
  const sets = new Set(tour.steps.map((s) => [s.explode ? 'xpopt' : '', s.section && s.section.axis !== 'off' ? 'secopt' : ''].filter(Boolean).join(' ')));
  for (const set of sets) {
    if (!set) continue;
    // (the set's bars alone: one still shown for Measure counted too -- R155-4)
    const o = $('optbar'), bars = [...o.children], on = set.split(' ').map($), was = [o.hidden, ...bars.map((b) => b.hidden)];
    o.style.visibility = 'hidden'; o.hidden = false; for (const b of bars) b.hidden = !on.includes(b);
    floor = Math.max(floor, o.offsetHeight);
    o.hidden = was[0]; bars.forEach((b, i) => { b.hidden = was[i + 1]; }); o.style.visibility = '';
  }
  $('stage').style.setProperty('--tour-floor', `${floor}px`);
}
// the camera still where the tour's step left it (landed, untouched; q and -q one turn: R94-1)
function atStepPose() {
  const c = app.cam, t = app.tour, L = t && !app.tourFlying && t.landed;
  if (!L) return false;
  const tol = L.dist * 1e-6, q = camQ(c);
  return Math.abs(c.dist - L.dist) <= tol && c.target.every((v, k) => Math.abs(v - L.target[k]) <= tol)
    && Math.abs(L.q.reduce((s, v, k) => s + v * q[k], 0)) >= 1 - 1e-9;
}
// that step framed again, at once, for the projection or the view's shape now (R92-3; R154-3)
function restep() {
  const c = app.cam, t = app.tour, to = stepPose(t.tour.steps[t.i], !!c.ortho);
  if (to) { c.target = to.pose.target.slice(); c.dist = to.pose.dist; c.q = to.pose.q.slice(); t.landed = to.pose; } // (q: an Iso step's turn is the new shape's)
}

// The camera a step asks for -> { pose: { target, dist, q }, ortho } or null
// (a step with no camera of its own)
// (proj: the visitor's projection, when Ortho is pressed on a step -- R92-3)
function stepPose(s, proj) {
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
  if (proj !== undefined) ortho = proj;
  if (s.frame || typeof s.view === 'string' || (s.from && !pose)) {
    let ids = null;
    if (Array.isArray(s.frame)) {
      const r = tourParts(s.frame);
      if (r.missing.length && proj === undefined) app.tourMissing.push(...r.missing);
      ids = r.ids.length ? r.ids : null;
    }
    // (a frame given as a box: the box itself)
    const box = s.frame && s.frame.min ? { min: s.frame.min.slice(), max: s.frame.max.slice() } : drawnBox(ids) || drawnBox(null);
    if (!box) return null;
    if (s.from === 'outside') q = outsideQuat(box, ids, s) || q;
    const eb = $('embedbar'), top = eb && !eb.hidden ? eb.offsetTop + eb.offsetHeight : 0; // (R91-2)
    const pad = s.margin === undefined ? 16 : 0, cover = optbarHeight() + tourCover();
    let f = fitPose(box, q, s.margin ?? 1.05, cover, pad, ortho, top);
    if (top) {
      // (the space under the embed's bars kept only where the model meets them, not the full width: R92-4)
      const f0 = fitPose(box, q, s.margin ?? 1.05, cover, pad, ortho, 0), he = $('hdend');
      const left = eb.offsetLeft + eb.offsetWidth + 8, right = he && he.offsetWidth ? he.offsetLeft - 8 : Infinity;
      if (f0.xs && f0.xs[0] > left && f0.xs[1] < right) f = f0;
    }
    pose = { target: f.target, dist: f.dist, q };
  }
  return pose ? { pose, ortho } : null;
}

// The grey a step's dim: "grey" draws the parts it is not about in
const TOUR_GREY = [0.62, 0.64, 0.67];

// A step's emphasis (colours, the rest dimmed, visibility, style, section, callouts), applied to the
// visitor's own pre-tour state, never stacked; its colours never saved; Explode moved by flyTo.
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
  const overrides = new Map(base.clean ? [] : base.overrides);
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
  // (a step's t is a fraction of the tour's own model, the scene's first: sectionBox)
  if (s.section) Object.assign(app.section, s.section, { of: 'first', held: null }, s.section.axis !== 'off' ? { last: s.section.axis } : {});
  else Object.assign(app.section, { of: null }, base.view.section);
  // (a step's own callouts are pinned by showTourStep, where the parts will be)
  // (the visitor's own notes shown as the page's while the tour plays: they
  // do not open Measure's bar over it; leaving gives them back as theirs)
  if (app.measure && !s.callouts) app.measure.setNotes((base.clean ? [] : base.view.notes || []).map((n) => ({ ...n, own: false })));
  pushState();
  updateButtons();
  viewChanged();
}

// A step's "from": "outside": the camera where its parts are least hidden (js/tour-sight.js), the
// model's up kept up; once per step (ids: its parts; with none, the bodies inside a box frame).
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
    // (a copy of the one rule's set, as this adds to it: ownHidden -- written out here a second time, r73 A5)
    const hidden = step && step.show === 'all' ? new Set() : new Set(ownHidden());
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
  app.tourRaf = 0; app.tourFlying = false;
}

// Fly the camera to `to` over `secs` (eased), and Explode to `explodeTo`
// (0-1; 0 puts the parts back); a visitor's drag, wheel or key on the view
// during the flight takes over (the flight stops where it is)
function flyTo(to, ortho, secs, ease, explodeTo = 0, done = null) {
  cancelFlight();
  const x = app.explode;
  const ex0 = x.on && x.for === app.header ? x.t : 0;
  const ex1 = app.renderer ? explodeTo : 0;
  if (ex1 > 0 && !x.on) { x.t = 0; quietly(() => setExplode(true)); }
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
      app.tourRaf = 0; app.tourFlying = false; explodeAt(1); if (ex1 === 0 && x.on) quietly(() => setExplode(false)); settle();
      setTourPlaying(false);
      return;
    }
    const t = ms ? Math.min(1, (now - t0) / ms) : 1;
    const e = (EASE[ease] || EASE.inOut)(t);
    explodeAt(e);
    if (t >= 1 && ex1 === 0 && x.on) quietly(() => setExplode(false));
    if (!to) { // no camera of its own: the explode alone
      viewChanged();
      if (t < 1) app.tourRaf = requestAnimationFrame(frame); else { app.tourRaf = 0; app.tourFlying = false; if (done) done(); }
      return;
    }
    // (landing exactly on the step's pose, not -q: R94-1)
    const p = t >= 1 ? { target: to.target.slice(), dist: to.dist, q: to.q.slice() } : poseAt(from, to, e);
    c.target = p.target; c.dist = p.dist; c.q = p.q;
    // projection changes at the midpoint (it cannot be blended)
    if (!!c.ortho !== ortho && t >= 0.5) { c.ortho = ortho; updateButtons(); }
    viewChanged();
    if (t < 1) app.tourRaf = requestAnimationFrame(frame);
    else { app.tourRaf = 0; app.tourFlying = false; settle(); if (done) done(); }
  };
  // (a flight, apart from a step's hold, which also runs on tourRaf: R93-1)
  app.tourFlying = true;
  app.tourRaf = requestAnimationFrame(frame);
}

// A playing tour's hold: `hold` seconds turning `orbit` degrees (not with reduced motion), then the
// next step; the visitor's input pauses it
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
      else if (t.tour.loop && !t.recording && t.i > 0) showTourStep(0); // (a video plays it once; one step does not loop: R84-1)
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

// A tour step's missing parts, told -- but not at the tour's start, which told them all (r46 A4 .. r49 Q2)
function tellStepMissing(t) {
  if (app.tourMissing.length && !t.startedNow) tell(`not in this model: ${[...new Set(app.tourMissing)].join(', ')}`, 4000);
}
function markStarted(t, told) {
  if (!told) return;
  t.startedNow = true;
  setTimeout(() => { t.startedNow = false; }, 0);
}

// a step's title on the card, a picture and a video (R87-5, R88-2, R88-3)
const stepTitle = (tour, i) => { const s = tour.steps[i]; return s.title || (i === 0 ? tour.title : '') || (s.text || tour.steps.length > 1 ? '' : 'Step 1'); };
// (R87-1, R88-1)
// (and .lines past one -- measured as one line would be laid: R90-3)
const markScrolls = (cb) => { cb.classList.remove('scrolls', 'lines'); cb.classList.toggle('lines', cb.scrollHeight > 41); cb.classList.toggle('scrolls', cb.scrollHeight > cb.clientHeight); };
function showTourStep(i) {
  const t = app.tour;
  const n = t.tour.steps.length;
  t.i = Math.max(0, Math.min(n - 1, i));
  const s = t.tour.steps[t.i];
  // (a step's "not in this model" ends with it: it stayed over the next -- R130-7)
  const was = $('hover').textContent;
  if (was.startsWith('not in this model')) tell(was, 1, '');
  $('tourtitle').textContent = stepTitle(t.tour, t.i);
  $('tourtitle').hidden = !$('tourtitle').textContent;
  const cb = $('tourbody'), had = document.activeElement === cb, ring = had && cb.matches(':focus-visible');
  cb.textContent = s.text;
  cb.hidden = !s.text;
  cb.scrollTop = 0; // (each caption from its start: R81-2)
  markScrolls(cb);
  $('tourcount').textContent = `${t.i + 1} / ${n}`;
  $('tourcard').classList.toggle('one', n === 1);
  $('tourprev').disabled = t.i === 0;
  $('tournext').disabled = t.i === n - 1;
  // (a focused caption that no longer scrolls hands the focus on, ringed after a key: R81-5, R82-2, R82-3)
  if (had && !(cb.scrollHeight > cb.clientHeight)) $(t.i === n - 1 ? 'tourprev' : 'tournext').focus({ focusVisible: ring || !!app.stepKey });
  app.tourMissing = [];
  // the emphasis first (a dim that hides parts changes what "all" frames),
  // then the camera; the card is already filled: its height is what the
  // frame keeps clear
  applyStepState(s);
  // a frame where the parts will be: framed at the step's explode, flown
  // there from the explode they are at now
  const x = app.explode;
  const ex1 = app.renderer ? s.explode ?? 0 : 0;
  if (ex1 > 0 && !(x.on && x.for === app.header)) { x.t = 0; quietly(() => setExplode(true)); }
  // the way the step explodes, as it was recorded (as a view link sets it)
  if (ex1 > 0 && x.on && s.explodeAlong && x.mode !== s.explodeAlong) setExplodeMode(s.explodeAlong);
  const exNow = x.t;
  if (x.on) x.t = ex1;
  const to = stepPose(s);
  t.landed = to ? to.pose : null; // (where the step leaves the camera: R92-3)
  // callouts at the top of their parts as they will be drawn (exploded too)
  if (app.measure && s.callouts) {
    app.measure.setNotes(s.callouts.map((c) => ({ p: c.at || topOfBox(drawnBox(tourParts([c.part]).ids)), text: c.text })).filter((c) => c.p));
  }
  if (x.on) x.t = exNow;
  flyTo(to ? to.pose : null, to ? to.ortho : !!app.cam.ortho, s.transition, s.ease, ex1, holdStep);
  // (not right after the tour's start, which told every part it lacks: r46 A4, r47 A7)
  tellStepMissing(t);
  // (a step with no text read without a trailing space: r49 Q7)
  // (one step: no count said, as none is shown -- R84-4)
  const head = [n > 1 ? `Step ${t.i + 1} of ${n}` : '', $('tourtitle').textContent].filter(Boolean).join(': ');
  announce(head ? `${head}.${s.text ? ` ${s.text}` : ''}` : s.text || '');
}

// only: a step id (?step=<id>, a v2 tour): that step alone, held, with no
// card (the page around the viewer says what it shows). A tour without it
// leaves the model as it is; returns whether the tour started.
function startTour(tour, url, only = null, at = 0) {
  if (!app.header) return false;
  if (!app.inMaker) app.watched = null;
  // (the whole tour, kept beside a ?step= one-step copy: the maker edits the whole)
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
  // (the card above the tour's Explode and Section bars throughout: R44-3, R130-2)
  tourFloor(tour);
  const saved = prev ? prev.saved : currentView();
  // what the visitor had: each step is applied to it, and leaving puts it back
  // (styleChoice: the visitor's own, not a step's; leaving puts it back)
  const base = prev ? prev.base : { view: saved, hidden: [...app.hidden], overrides: new Map(app.overrides), faceOverrides: app.faceOverrides, styleChoice: app.styleChoice,
    explode: { on: app.explode.on && app.explode.for === app.header, t: app.explode.t, mode: app.explode.mode, mine: app.explode.for === app.header }, walk: !!app.walk,
    // (the maker's steps played over the file's own colours and no notes, as the saved tour opens: the
    // author's showed on every step without its own -- R155-3)
    clean: !!app.inMaker };
  app.tour = { tour, full, url, i: 0, saved, base, playing: false };
  // (in place of another tour: the visitor's orientation, unless this one sets its own)
  if (prev && saved.cam && saved.cam.orient && saved.cam.orient !== app.cam.orient) {
    app.cam.orient = saved.cam.orient;
    updateButtons();
  }
  // Walk off while it plays; leaving puts it back
  if (app.walk) walkMark(false);
  // nothing selected while it plays (a selection greys the rest); leaving puts it back
  if (app.selected.size) select([], false);
  app.hover = 0;
  // Paint, Measure and the hole table set aside while it plays (R66-1)
  if (!prev) base.paint = app.paintFaces;
  if (app.paintFaces) setPaint(false);
  if (app.faceOverrides.size) { app.faceOverrides = new Map(); recolour(); }
  if (!prev) {
    base.measured = app.measure ? app.measure.setAside() : null;
    base.measureOn = !!(app.measure && app.measure.on);
    if (base.measureOn) app.measure.setOn(false);
    base.holesFor = app.holesFor;
    if (app.holesFor && app.measure) showHoles(null);
  }
  // the tour's orientation while it plays (leaving puts the visitor's back)
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
  showTourStep(at < tour.steps.length ? at : 0); // (a tour given back opens at its step alone: R77-2)
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
  app.lastInput = performance.now(); // (the turntable waits after a tour, as after any input: R85-6)
  const { saved, base } = app.tour;
  const wasPreview = app.tour === app.previewing;
  app.tour = null;
  app.tourGhost = false;
  // (a step's "not in this model" ends with the tour too: it stayed after "tour closed" -- R146-6)
  if ($('hover').textContent.startsWith('not in this model')) tell($('hover').textContent, 1, '');
  $('tourcard').hidden = true;
  $('stage').classList.remove('touring');
  if (restore && saved && app.header) {
    app.overrides = base.overrides;
    if (base.faceOverrides) app.faceOverrides = base.faceOverrides;
    recolour();
    quietly(() => restoreExplode(base.explode)); // (the tour's own explode undone unsaid: R146-5)
    applyView(saved); // camera, style, section, hidden and selected parts, notes
    if (app.measure) app.measure.putBack(base.measured);
    if (base.measureOn && app.measure && !app.measure.on) app.measure.setOn(true);
    else if (base.paint && !app.paintFaces && !app.measure?.on) setPaint(true);
    if (base.holesFor && app.measure) showHoles(base.holesFor);
    // Walk as the visitor had it: back on, or off if they turned it on in the
    // tour (its eye was placed for a step, not for the view put back)
    if (!!app.walk !== base.walk) walkMark(base.walk);
    updateButtons();
    viewChanged();
  }
  // the visitor's own style and Explode back, however the tour ends
  app.styleChoice = base.styleChoice;
  if (!restore) { app.explode.t = base.explode.t; app.explode.mode = base.explode.mode; }
  // (a preview ended from its card, the maker still open: the focus back to Preview, not File or none
  // -- R120-2)
  if (wasPreview && app.recorder?.isOpen() && !$('touredit').contains(document.activeElement)) $('teplay').focus();
  // (an embed has no File to take it: the focus fell to the page -- R130-6)
  else if (app.embed && (document.activeElement === document.body || $('tourcard').contains(document.activeElement))) $('view').focus?.();
  announce('tour closed');
}

// The view as a tour step (js/tour-recorder.js): camera, colours, hidden, explode, section, style,
// notes; parts named by namesFor. captureNote: what the capture had to change ('' none)
let captureNote = '';
function captureStep({ camera = 'exact' } = {}) {
  captureNote = '';
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
  // with a tour shown, the step's dim is the dim field's, not recorded as colours or hides
  const dim = app.tour && app.tour.dimmed;
  const overrides = new Map(app.overrides);
  let hiddenNow = app.hidden;
  if (dim) {
    for (const id of dim.grey) {
      const own = !app.tour.base.clean && app.tour.base.overrides.get(id - 1);
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
  // (every field written, "nothing" too: one left out means "keep the page's")
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
  // (t of the tour's own model, the scene's first, as a step plays it: sectionBox)
  s.section = app.section.axis !== 'off' ? { axis: app.section.axis, t: roundFraction(sectionTOf('first')), flip: !!app.section.flip } : { axis: 'off' };
  // (a cut past the tour's own model -- through an added one only -- is kept at that model's edge,
  // which the tour maker says: it moved there unsaid, r129 L1)
  const raw = app.section.axis !== 'off' ? sectionTOf('first', false) : 0.5;
  captureNote = raw < -1e-9 || raw > 1 + 1e-9 ? `its cut is past ${app.scene && app.scene[0] ? app.scene[0].name : 'the model'}, the tour's own model: kept at its edge` : '';
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

const slugOf = tourSlug; // (the one rule: js/tour.js -- r76 A8)
const nextFrame = () => new Promise((ok) => requestAnimationFrame(() => ok()));

// A tour as pictures, each step at twice the view's size with its caption, zipped. -> how many
// the maker's tour (Show, Preview, an export); its close gives back the watched one (R74-2, R76-1)
function makerTour(tour, at = 0) {
  const t = app.tour;
  if (t && t !== app.previewing) app.watched = { t: t.full || t.tour, u: t.url, i: t.i, p: t.playing, h: app.header, o: t.full && t.tour !== t.full ? t.tour.steps[0].id : null };
  endTour(); app.inMaker = true;
  startTourIn(tour, null, null, at); // (scaled to the reading: js/tour.js tourAt)
  app.inMaker = false;
  return (app.previewing = app.tour);
}
async function tourPictures(tour, base = null) {
  if (!makerTour(tour)) return 0;
  setTourPlaying(false);
  app.tour.cut = true;
  // (the tour ended meanwhile: the pictures stop there, those taken kept -- r117 M1)
  const t = app.tour;
  const files = [];
  try {
    for (let i = 0; i < tour.steps.length; i++) {
      if (app.tour !== t) break;
      showTourStep(i);
      for (let k = 0; k < 100 && app.tourRaf; k++) await nextFrame();
      await gpuSync().catch(() => {});
      await nextFrame();
      await nextFrame();
      if (app.tour !== t) break;
      // (the tour's pictures keep their own settings, not Save picture's)
      const pic = await renderPicture({ scale: 2, bg: 'view', sel: false });
      if (!pic || app.tour !== t) break;
      const s = tour.steps[i];
      paintCaption(pic.canvas.getContext('2d'), pic.canvas.width, pic.canvas.height, pic.scale, stepTitle(tour, i), s.text);
      const png = await new Promise((ok) => pic.canvas.toBlob(ok, 'image/png'));
      files.push([`${String(i + 1).padStart(2, '0')}-${slugOf(stepTitle(tour, i) || `step ${i + 1}`)}.png`, new Uint8Array(await png.arrayBuffer())]);
    }
  } finally {
    // (its own tour only: one the visitor started meanwhile is theirs to leave -- r118 L2)
    if (app.tour === t) endTour();
  }
  if (!files.length) return 0;
  const { zip } = await import('./export-mesh.js');
  downloadBlob(new Blob([await zip(files)], { type: 'application/zip' }), `${base ?? (tour.title ? slugOf(tour.title) : saveBase(app.sourceName))}-pictures.zip`); // (the maker's one name for its files: R156-9)
  return files.length;
}

// A tour as a WebM video: played once from the start, notes and captions drawn in, recorded by
// MediaRecorder; the visitor's input stops it. -> its size in bytes, or why it could not be made
async function tourVideo(tour, base = null) {
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = window.MediaRecorder && types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime || !HTMLCanvasElement.prototype.captureStream) return 'this browser cannot record video';
  if (!makerTour(tour)) return 'no model';
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
    app.measure.paint(ctx, scale, !!currentStyle().paper || !!app.lightBg);
    const s = app.tour === t ? t.tour.steps[t.i] : null;
    if (s) paintCaption(ctx, out.width, out.height, scale, stepTitle(t.tour, t.i), s.text);
    raf = requestAnimationFrame(draw);
  };
  rec.start(250);
  const t0 = performance.now();
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
  const ms = performance.now() - t0;
  await stopped;
  if (app.tour === t) endTour(); // (its own only, as tourPictures: r118 L2)
  let blob = new Blob(chunks, { type: 'video/webm' });
  if (!blob.size) return 'the recording came out empty';
  // (its length written in, so a player shows it and can scrub: R156-5)
  try {
    const { withDuration } = await import('./webm-duration.js'), n = 1 << 16;
    blob = new Blob([withDuration(new Uint8Array(await blob.slice(0, n).arrayBuffer()), ms), blob.slice(n)], { type: 'video/webm' });
  } catch { /* the recording as it came */ }
  downloadBlob(blob, `${base ?? (tour.title ? slugOf(tour.title) : saveBase(app.sourceName))}.webm`);
  return blob.size;
}

// ---------- ?embed=1 ----------
// The model alone in another site's page; inactive until a click or tap, Esc or leaving the frame
// gives the page back. &active=1: always active; &noopen=1: no "Open in cad.place ↗".
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
  // (a touch-only device taps: UI design round 5 V-3)
  embedHint();
  // the hint rises past the hover's line only where they meet (R39-4, R39-5)
  {
    const hint = $('embedhint'), hover = $('hover');
    const place = () => {
      hint.style.bottom = '';
      if (hint.hidden || !hover.textContent) return;
      const a = hover.getBoundingClientRect(), b = hint.getBoundingClientRect();
      if (a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom) {
        hint.style.bottom = `${parseFloat(getComputedStyle(hover).bottom) + hover.offsetHeight + 8}px`;
      }
    };
    new MutationObserver(place).observe(hover, { childList: true, characterData: true, subtree: true });
    new MutationObserver(place).observe(hint, { attributes: true, attributeFilter: ['hidden'] });
    addEventListener('resize', place);
  }
  // (the frame losing the focus -- a click or tap on the host page -- gives the page its wheel and its
  // drag back: a phone has no Esc, and a click outside kept the wheel caught -- R145-1, R145-3;
  // &active=1 stays active)
  if (embedParams.get('active') !== '1') addEventListener('blur', () => setEmbedActive(false));
  // (a drawing fits by its own view: drawnBox is the 3D model's, null in 2D -- round 10 R10-1)
  $('embedfit').onclick = () => (app.dxf ? $('fit').click() : fitTo(drawnBox(null)));
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
  if (!on && embedParams.get('active') === '1') return; // (&active=1 stays active, Esc too: R147-10)
  app.embedActive = on;
  // (the frame takes the keyboard on its activating press: the 3D view's press takes no focus, so its
  // Esc and keys went to the host page -- R145-1)
  if (on) try { window.focus(); } catch { /* a frame that cannot be focused: the pointer still works */ }
  document.body.classList.toggle('active', on);
  $('embedhint').hidden = on;
  announce(on ? `${app.dxf ? 'the drawing now pans' : 'the model now turns'} and zooms with the pointer; Esc gives the page its wheel back` : 'the page scrolls again');
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
  // (Hidden grey draws the selection's hidden edges only: R140-1)
  if (remember && id === 'hiddengrey' && !app.selected.size) tell('Hidden grey: select a part to see its hidden edges', 3500);
}

// the paper styles' overlay palette (#hover, notices): dark on a light chip
const LIGHT_TITLE = document.getElementById('lightbg')?.title || '';
function syncStyleBg() {
  const paper = !!currentStyle().paper;
  if (paper || app.lightBg) $('stage').dataset.bg = 'paper';
  else delete $('stage').dataset.bg;
  // (off in the paper styles, where it changed nothing: R120-10)
  $('lightbg').disabled = paper;
  $('lightbg').title = paper ? 'The paper styles are always drawn light' : LIGHT_TITLE;
}

// ---------- looks (feature review item 22) ----------
// light background, ghosts, and the turntable (after IDLE_MS left alone; never with reduced motion)
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
  // (the wheel over a focused number field scrolls, never steps its value unsaid -- a density
  // 1.84 became 1.85: R97-2, R121-1)
  addEventListener('wheel', (e) => { if (e.target.matches?.('input[type=number]') && e.target === document.activeElement) e.target.blur(); }, { capture: true, passive: true });
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
    announce(app.lightBg ? 'light background' : 'dark background'); // (each toggle said, as Level is: R140-7)
  };
  $('ghost').onclick = () => {
    app.ghostHidden = !app.ghostHidden;
    setPref('cadv.ghost', app.ghostHidden ? '1' : '0');
    press();
    queueFrame();
    announce(app.ghostHidden ? 'hidden parts shown as ghosts' : 'hidden parts not drawn');
  };
  $('turntable').onclick = () => { app.turntable = !app.turntable && !reducedMotion(); press(); turn(); announce(app.turntable ? 'turntable on' : 'turntable off'); };
  // any input is the visitor taking the view: the turntable waits -- but not a press on a tour's
  // card, whose Pause it paused and whose click then played again (R79-1)
  for (const t of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
    window.addEventListener(t, (e) => {
      // (nor a tour's step key: R84-2)
      if (app.tour && /^(Arrow(Left|Right)|Page(Up|Down))$/.test(e.key) && !(e.target instanceof Element && e.target.closest('input, select, textarea, #tree'))) return; // (R85-5)
      if (!(e.target instanceof Element && e.target.closest('#tourcard'))) app.lastInput = performance.now();
    }, { capture: true, passive: true });
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
// The light background's ground shadow: an ellipse under the model, faded as the eye nears the ground
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
// Walk's flag, button and bar together, however it ends (a new model left the bar up: R141-2)
function walkMark(on) {
  app.walk = on;
  $('walk').setAttribute('aria-pressed', String(on));
  const wo = $('walkopt');
  if (wo) { wo.hidden = !on; syncOptbar(); }
}
function setWalk(on) {
  walkMark(on);
  let turned = false;
  if (on) {
    // stand where the eye is: a near orbit distance, so a look-around turns in place
    const c = app.cam, d = camDir(c);
    if (c.ortho) { c.ortho = false; updateButtons(); } // (a walk has a viewpoint: perspective)
    const eye = [0, 1, 2].map((k) => c.target[k] + d[k] * c.dist);
    c.dist = Math.max(1e-3, (app.sphereBase || app.sphere).radius * 0.05);
    c.target = [0, 1, 2].map((k) => eye[k] - d[k] * c.dist);
    levelOrbitBy(c, orientUp(c.orient), 0, 0);
    viewChanged();
  } else {
    // (the eye kept, the turning point moved out to the model's depth: R124-2, R125-1)
    const c = app.cam, d = camDir(c), s = app.sphereBase || app.sphere;
    const eye = [0, 1, 2].map((k) => c.target[k] + d[k] * c.dist);
    const v = s.center.map((x, k) => x - eye[k]), far = Math.hypot(...v);
    const ahead = [0, 1, 2].reduce((a, k) => a + v[k] * -d[k], 0);
    // (the middle against the view's own edges: a cone of the narrower half-angle turned a middle
    // still on screen near the wide edge -- R126-1, R127-4)
    const tv = Math.tan(c.fov / 2), sx = qRotate(c.q, [1, 0, 0]), sy = qRotate(c.q, [0, 1, 0]);
    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    turned = far > 1e-9 && (ahead <= 0 || Math.abs(dot3(v, sx)) > ahead * tv * (app.stageAspect || 1) || Math.abs(dot3(v, sy)) > ahead * tv);
    if (turned) {
      const nd = v.map((x) => -x / far);
      const ax = [d[1] * nd[2] - d[2] * nd[1], d[2] * nd[0] - d[0] * nd[2], d[0] * nd[1] - d[1] * nd[0]];
      const n = Math.hypot(...ax), ang = Math.acos(Math.max(-1, Math.min(1, d[0] * nd[0] + d[1] * nd[1] + d[2] * nd[2])));
      const axis = n > 1e-9 ? ax.map((x) => x / n) : qRotate(c.q, [0, 1, 0]);
      c.q = qNorm(qMul(qAxis(axis, ang), c.q));
      levelOrbitBy(c, orientUp(c.orient), 0, 0);
      c.dist = Math.max(s.radius * 0.05, far);
      c.target = s.center.slice();
    } else {
      c.dist = Math.max(s.radius * 0.05, ahead);
      c.target = [0, 1, 2].map((k) => eye[k] - d[k] * c.dist);
    }
    viewChanged();
  }
  const off = turned ? 'walk off: turned to the model' : 'walk off'; // (the cut said: R126-3)
  // (the keys in Walk's bar alone, not a second time in the note: R141-8)
  tell(on ? 'walk on' : off, 3000, on ? 'walk on: W A S D move, Q E down and up, drag to look, Shift faster' : off);
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
    // (not while a tour is shown, nor walking -- R123-1)
    if (app.header && !app.tour && !app.walk && !document.hidden && performance.now() - app.lastInput > IDLE_MS) {
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
// (each step named, so Undo says what it took back: "undone: everything shown" after a Hide read as
// the opposite step -- R136-5)
function rememberVisibility(what = 'the last change') {
  const s = new Set(app.hidden);
  s.what = what;
  app.visUndo.push(s);
  if (app.visUndo.length > 100) app.visUndo.shift();
}
// (a part colour, a painted face and Reset in the same history: Reset all wiped every colour with no
// way back, and Ctrl+Z after a colour undid an older Hide -- R135-3)
function rememberColours(what = 'Colours') { // (one form, capitalised, as Hide: R137-7)
  app.visUndo.push({ ov: new Map(ownOverrides()), fo: new Map(ownFaces()), what });
  if (app.visUndo.length > 100) app.visUndo.shift();
}
function undoVisibility() {
  if (!app.visUndo.length || !app.header) return;
  const e = app.visUndo.pop();
  if (!(e instanceof Set)) {
    const ov = ownOverrides(), fo = ownFaces();
    ov.clear(); for (const [k, c] of e.ov) ov.set(k, c);
    fo.clear(); for (const [k, c] of e.fo) fo.set(k, c);
    saveOverrides();
    if (app.tour) applyStepState(app.tour.tour.steps[app.tour.i]);
    updateButtons();
    recolour(`undone: ${e.what}`);
    tell(`undone: ${e.what}`, 2500, '');
    return;
  }
  app.hidden = e;
  syncTreeChecks();
  pushState();
  showInfo();
  viewChanged();
  tell(`undone: ${e.what} (${app.hidden.size ? `${fmtInt(app.hidden.size)} hidden` : 'everything shown'})`, 2500); // (counts as the tree writes them: R150-3)
}

// ---------- toolbar menus ----------
// Toolbar groups fold behind menu buttons in FOLD_ORDER when the row (MEASURED, never a
// breakpoint) has no room; narrow, the Save group is File, always folded.

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
  // a model list goes where Open… goes; narrow, in the row before File while it has room (moved only
  // when it must: a move takes the focus)
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
  $('embedbtn').disabled = $('sharelink').disabled; // (and why not, said in the card: openEmbed)
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
  // Measure stands in the row after Fit (back there before measuring), and a drawing's sheet
  // select after it (File holds it where the row is short)
  placeMeasure(false);
  if ($('sheet').parentElement !== tb) $('tools').after($('sheet'));
  $('fhsheet').hidden = true;
  tb.classList.add('measuring');
  // the model list folds into File's panel, after View (r16 L3); the tools drop to their icons
  // before View folds, keeping View and a list in a 1280 px row
  $('tools').classList.remove('compact');
  // The page's name goes next, before View: a 1280 px row with a model list
  // and ? and Full screen at its end had room for View only without it
  tb.classList.remove('notitle');
  // Show folds before the model list: its four buttons do nothing until a
  // part is selected, while the list is how a visitor reaches the other
  // models (UI organization review rank 6)
  tb.classList.remove('nobadge');
  for (const id of [FOLD_ORDER[0], 'tools', 'title', ...FOLD_ORDER.slice(1), 'modellist', 'badge', 'sheet']) {
    if (toolbarFits(tb)) break;
    if (id === 'badge') {
      tb.classList.add('nobadge');
      continue;
    }
    if (id === 'sheet') {
      // a drawing's sheet select, last, into File's panel under a "Sheet" heading (R8-1, R9-6)
      if (!$('sheet').hidden) { $('fhsheet').hidden = false; $('fhsheet').after($('sheet')); }
      continue;
    }
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
  // the last step: a row that still does not fit takes Measure into View's panel, first (never in 2D,
  // where View is hidden: R7-1)
  if (!document.body.classList.contains('mode2d') && !toolbarFits(tb) && $('viewmenu').classList.contains('folded')) placeMeasure(true);
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
      app.dxf ? 'save a picture of the drawing' : 'save the converted model', 'copy a link to this view'].filter(Boolean);
    const t = holds.join(', ').replace(/, ([^,]*)$/, ', or $1');
    $('filemenu').querySelector('.menu-btn').title = t[0].toUpperCase() + t.slice(1);
  }
  syncMenuButtons();
  refoldFocus(keep, narrow);
}

// A refold folds or unfolds what has the focus (review r21): the focus goes to
// the control itself where still shown, else the folded menu's button
// (focusBeside), else ☰ for the parts panel.
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
  // inside a folded menu's closed panel: its menu's button, or the first one shown of a menu in a
  // menu (r20, r23)
  for (let m = el.closest('.menu-panel')?.closest('.menu'); m; m = m.parentElement.closest('.menu')) {
    const mb = m.querySelector(':scope > .menu-btn');
    if (live(mb)) { mb.focus(); return; }
  }
  const all = [...$('tb').querySelectorAll('button, label.btn, a.btn')];
  const before = all.filter((e) => e.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  const after = all.filter((e) => e !== el && !before.includes(e));
  (after.find(live) || before.reverse().find(live))?.focus();
}

// The one net (r19 L8, r20): the focused control disabled or hidden gives the focus to the nearest
// usable toolbar control (in the parts panel, to the panel), never after a pointer press.
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

// A scroll box's foot spacer: R48-1, R54-3, R55-3
const spacerOf = (box) => box._sp || 0;
function setSpacer(box, s) {
  if (!box._sp) box._pb0 = parseFloat(getComputedStyle(box).paddingBottom);
  box._sp = s > 0.5 ? s : 0;
  box.style.paddingBottom = box._sp ? `${box._pb0 + box._sp}px` : '';
}
function trimSpacer(box) {
  if (!box._sp) return;
  // (none at the top: R57-1)
  const need = box.scrollTop < 1 ? 0 : box.scrollTop + box.clientHeight - (box.scrollHeight - box._sp);
  if (need < box._sp - 1) setSpacer(box, Math.max(0, Math.ceil(need))); // (R56-2)
}

// A row's press focuses its name (R59-3)
function pressFocus(row, name) {
  const calm = () => name.focus({ preventScroll: true, focusVisible: false });
  row.addEventListener('mousedown', (e) => {
    if (e.button > 2) return;
    if (!e.button) e.preventDefault();
    if (name.matches(':focus-visible')) name.blur(); // (R60-5)
    calm();
  });
  // (R60-1, R61-1, R61-2)
  row.addEventListener('focusin', (e) => { if (e.target !== name) calm(); });
  row.addEventListener('mouseup', (e) => { if (e.button) calm(); });
}

// `change` keeps `el` in place (R55-1)
function keepRowPlace(el, change) {
  const tree = $('tree');
  const box = tree.scrollHeight > tree.clientHeight + 1 && getComputedStyle(tree).overflowY !== 'visible' ? tree : $('parts');
  const top = el.getBoundingClientRect().top;
  change();
  const d = el.getBoundingClientRect().top - top;
  if (d < 0.5) return;
  const want = box.scrollTop + d;
  const last = [...box.children].reverse().find((c) => c.getClientRects().length);
  const end = last ? last.getBoundingClientRect().bottom - box.getBoundingClientRect().top - box.clientTop + box.scrollTop : 0;
  const pb0 = box._sp ? box._pb0 : parseFloat(getComputedStyle(box).paddingBottom);
  const sp = want + box.clientHeight - end - pb0;
  if (sp > spacerOf(box)) setSpacer(box, sp);
  box.scrollTop = want;
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
    // (also forgotten after a pointer press: iOS runs a tap's blur and click in one task -- review r23)
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
    // (a card File opens: back to File, R43-4; else Open…)
    const fromFile = ['gallery', 'touredit', 'tourcard'].some((id) => $(id)?.contains(f));
    focusBeside($('tb').contains(f) ? f : fromFile ? $('filemenu').querySelector('.menu-btn') : $('open').parentElement);
  };
  new MutationObserver(lost).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'] });
}

// A resize that leaves the focused control outside the window scrolls it back into view (r23); only
// at a resize
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
    // an action closes its menu, a toggle leaves it open; a keyboard pick gives the focus to the
    // menu's button, read before the item acts (Hide disables itself) -- review r18
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
      // a menu with nothing left to do is disabled: its neighbour then (review r19)
      // (not when the item moved it itself: R43-1)
      if (back && (document.activeElement === document.body || m.contains(document.activeElement))) focusBeside(btn);
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
// Along the 3D view's foot, one .opt row per tool on; hidden under a card; its height is --optbar-h.

// Undo pressable whenever it has something to take back -- Measure's too, as Ctrl+Z does (R137-6)
function syncUndo() {
  const m = app.measure;
  $('undo').disabled = !app.visUndo.length && !(m?.on && (m.pending.length || m.results.length));
}
function syncOptbar() {
  syncUndo();
  // (Section and Explode open together: Explode's slider Section's width, which its row's buttons set
  // -- at 390 they were 159 and 335 px, R136-3, R137-1)
  const sp = $('secpos'), xp = $('xppos');
  if (sp?.style && xp?.style) {
    xp.style.flex = ''; xp.style.width = ''; $('xpval').style.minWidth = '';
    if (!$('secopt').hidden && !$('xpopt').hidden && !$('optbar').hidden) {
      xp.style.flex = '0 0 auto'; xp.style.width = `${sp.getBoundingClientRect().width}px`;
      // (the groups after them aligned too, R140-8 -- where the row has room: at 320 Explode's "90 %"
      // was pushed to a line of its own, R148-2)
      if (innerWidth >= 360) $('xpval').style.minWidth = `${$('secval').getBoundingClientRect().width}px`;
    }
  }
  const bar = $('optbar');
  const card = !$('empty').hidden || !$('progress').hidden;
  bar.hidden = card || ![...bar.children].some((o) => !o.hidden);
  $('stage').style.setProperty('--optbar-h', `${optbarHeight()}px`);
  for (const o of bar.children) optFade(o);
  // A bar that came or grew over a view still as Fit left it fits again above it; one that goes or
  // shrinks leaves the view; nor under a measurement (R133-6)
  // (nor while walking: a fit ends Walk)
  const measuring = (app.measure?.on && app.measure.results?.length) || app.walk;
  if (!card && !measuring && app.header && atLastFit() && Math.min(viewCover(), $('stage').clientHeight - 1) > app.lastFit.bar) fitTo(app.lastFit.bbox);
}

// the camera is where the last Fit put it (nothing has moved it since)
function atLastFit() {
  const f = app.lastFit, c = app.cam;
  return !!f && !!app.header && c.q === f.q && c.dist === f.dist && c.target.every((v, k) => v === f.target[k]);
}

const optbarHeight = () => ($('optbar').hidden ? 0 : $('optbar').offsetHeight);
// and the tour maker where it sits over the view's foot (a phone): a fit frames above both (R163-4)
const viewCover = () => optbarHeight() + (!$('touredit').hidden && innerWidth < 520 && !$('stage').classList.contains('touring') ? $('touredit').offsetHeight + 8 : 0);

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
  if ((was === 'off') !== (axis === 'off') && !app.tour) announce(`section ${axis === 'off' ? 'off' : 'on'}`); // (as Measure and Walk: R127-6)
  if (!focus) return;
  if (axis !== 'off' && was === 'off') $('secoff').focus();
  else if (axis === 'off') toolFocus('section').focus();
}

// A select blurred after a choice picked from its list (not one typed into it: type-ahead); a
// non-Latin letter's shortcut goes by the key's place, as QWERTY names it (r19)
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

// The model shown by its name (the list's, else its file's), in the footer and the tab's title
const BASE_TITLE = document.title;
const SHORT_TITLE = BASE_TITLE.split(' — ')[0]; // "CAD viewer"
function showModelName() {
  if (!app.header || !app.stats) return;
  const sel = $('modellist');
  const cur = app.sourceUrl ? listedNow() : null;
  const entry = cur && [...sel.options].find((o) => o.value && o.value === cur);
  const label = entry ? entry.textContent : app.sourceName;
  const s = app.stats;
  // (counted as the info panel counts; name and counts in spans, a narrow footer dropping the counts)
  const nm = document.createElement('span');
  nm.className = 'mname';
  nm.textContent = label;
  const st = document.createElement('span');
  st.className = 'mstats';
  st.textContent = ` · ${fmtInt(s.meshes)} ${s.meshes === 1 ? 'body' : 'bodies'} · ${fmtInt(s.triangles)} ${s.triangles === 1 ? 'triangle' : 'triangles'}`; // (R142-9)
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
// The models a site offers, in a drop-down; a pick opens it as ?src= would.

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
  // Browse models: a list with pictures to browse (R24-5)
  $('gallerybtn').hidden = entries.length < 2 || !entries.some((e) => e.image);
  // (a list's Add model… offers its boards, put beside: its file wording did not fit -- R161-4)
  const am = $('addmodelbtn');
  am.dataset.t ||= am.title;
  am.title = entries.length && !app.embed ? 'Put one of the list\'s models beside this one, upright as the list stands it, or a file of your own: then move it in the info panel, and check the clearance' : am.dataset.t;
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

// The orientation a model opens in: its list entry's, else ?orient= for a URL's model, else Z up's
function orientFor(src) {
  let url = null;
  try { url = src ? new URL(src, location.href).href : null; } catch { /* no URL */ }
  const e = listEntry(src);
  return (e && e.orient) || (url && app.urlOrient) || app.fileOrient || app.userOrient;
}

// Where a list's note for a part goes (its top, along the view's up), the part named as tour.js
// resolveParts names one; null for a name the model lacks
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

// What the list says of the model on screen (step, page, author, license, labels, style), for the
// info panel, File and the tree; on a load and on a late list. A view link's view keyed by URL (r58 A3, r59 A6).
const linkViewOver = () => (!!app.header && app.viewLinkedFor === autoTourKey()) || pendingViewIsFor();
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
    b.title = `Play the tour “${t.name}” of this model`;
    b.onclick = async () => {
      closeMenus();
      // (only over the model it is for, after the ?add=s, a visitor's tour first -- r67 A1, r68 A2)
      const key = autoTourKey(), open = app.openCount;
      app.tourPicked = open;
      const r = await entryTourRead(t.url);
      const still = entryTourOn(key, open);
      if (r.error) { if (still) failApart(`the tour ${r.error}`); else tell(`the tour ${r.error}`, 6000); return; } // (as ?tour='s: one handling, failApart -- r46 A5, r48 A1)
      if (still) startTourIn(r.tour, t.url);
    };
    tl.append(b);
  }
  // a listed model's tour plays once per open (keyed by its URL), never over a link's view or ?tour=
  if (app.header && app.autoTourFor !== autoTourKey()) {
    if (linkViewOver() || app.urlTourPending) app.autoTourFor = autoTourKey();
    else if (e && e.tours && e.tours.length && !app.tour) {
      app.autoTourFor = autoTourKey();
      // (still this model's open, by its key: the header is made anew by every ?add= and Add model…,
      // and a list model with an ?add= never played its tour -- r59, the sweep's I15)
      const key = autoTourKey();
      const t = e.tours[0];
      // (after the address's ?add=s, which end a tour as they join, and still this open's: r60, r62)
      const open = app.openCount;
      // (and held back, when it would start, by a link's view landed meanwhile -- a #view= edited in
      // during the ?add=s landed, then the tour took the camera: r61 Q2)
      entryTourRead(t.url).then((r) => {
        // (nor while the visitor's pick downloads: the model shown is on its way out -- the tour
        // started over it, waiting for an ?add= the pick had cancelled: r62 -- nor over a tour the
        // visitor picked from File meanwhile: r68 A2)
        if (!r.error && app.autoTourFor === key && entryTourOn(key, open) && !app.tour && !linkViewOver() && app.tourPicked !== open) startTourIn(r.tour, t.url);
      });
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
  // its hidden parts (a heatsink), once per open by the model's URL, as the auto tour; not over a
  // view link's view, but decided for this open all the same (r59 Q4); ahead of its tour
  if (app.header && e && e.hide && app.listHideFor !== autoTourKey()) {
    app.listHideFor = autoTourKey();
    const ids = linkViewOver() ? [] : tourParts(e.hide).ids;
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

// The model the list stands for: the one being opened from a URL while a load runs, else the one
// on screen (review r17); pending: the list's own load, until a newer one begins (r18).
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

// File > Browse models: the list as pictures; a pick opens it (add: joins the view, R160-2)
function openGallery(add = false) {
  const grid = $('gallerygrid');
  grid.replaceChildren();
  app.galleryAdd = add;
  $('gallerytitle').textContent = add ? 'Add a model' : 'Models';
  const cur = add ? null : listedNow();
  for (const e of [...(app.listEntries || []), ...(add ? [{ file: true, name: 'A file…' }] : [])]) {
    const b = document.createElement('button');
    b.type = 'button';
    if (e.url === cur) b.setAttribute('aria-current', 'true');
    if (e.file) {
      b.append(Object.assign(document.createElement('span'), { className: 'noimg', textContent: '+' }), Object.assign(document.createElement('span'), { textContent: e.name }));
      b.firstChild.setAttribute('aria-hidden', 'true');
      b.onclick = () => { closeGallery(false); $('addmodel').click(); };
      grid.append(b);
      continue;
    }
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
    b.onclick = () => { closeGallery(false); if (add) { addWith(() => loadUrl(e.url), true); $('view').focus(); } else if (e.url !== listedNow()) openListed(e.url); };
    grid.append(b);
  }
  closeMenus();
  $('gallery').hidden = false;
  (grid.querySelector('[aria-current]') || grid.firstElementChild)?.focus();
}
function closeGallery(focusBack = true) {
  if ($('gallery').hidden) return false;
  $('gallery').hidden = true;
  if (focusBack) ($('filemenu').classList.contains('folded') ? $('filemenu').querySelector('.menu-btn') : $(app.galleryAdd ? 'addmodelbtn' : 'gallerybtn')).focus();
  return true;
}

let listPick = 0;
// refocus: a keyboard pick made inside the narrow layout's File menu gives
// the focus to File's button as the menu closes (it fell to the page)
function openListed(url, refocus = false, keepMenu = false) {
  // (a pick's steps a chain, undone to the address before its first on failure; a pick during another's
  // download continues that chain: r62 A2)
  const chain = app.pickPending && app.pickChain ? app.pickChain : null;
  const u = new URL(location.href);
  // (the pick's address names its model alone, with the lists: r59 A4, Q1; dropAddressModel)
  dropAddressModel(u);
  setModelParam(u, url);
  // a pick is a step in the history: Back opens the model before it again
  // (feature review item 21; it replaced the entry, so Back left the page)
  const pick = ++listPick;
  const c = chain || { id: pick, before: location.href, at: 0 };
  app.pickChain = c;
  // (each entry stamped with its depth, a failure stepping back as deep; compared by what the
  // address says, not its spelling: r62 A1, Q1)
  const spelled = (h) => { const x = new URL(h); x.search = new URLSearchParams(x.search).toString(); return x.href; };
  if (spelled(u.href) !== spelled(location.href)) {
    c.at++;
    history.pushState({ cadvPick: c.id, depth: c.at, cadvEntry: app.pageId }, '', u);
    app.entrySearch = u.search;
    app.entryState = history.state;
  }
  app.pickPending = pick;
  setPendingView(null, ''); // (a view of the last model is not a view of this one)
  // (the visitor's pick ends the address's tour: the model picked plays its own -- picked while the
  // address's tour was read, neither tour played: r56 Q3)
  tourOver();
  if (!app.addressUrl) app.visitorFirst = true; // (before any of the address's was shown: addressModel)
  if (!keepMenu) closeMenus(refocus); // the narrow layout's File menu: the pick is made
  loadListed(url).then(async () => {
    if (pick !== listPick) return; // (a newer pick, or Back: theirs to end)
    app.pickPending = 0;
    if (app.sourceUrl === url) { app.pickChain = null; return; }
    // failed or cancelled: the address and the drop-down name the model
    // still shown, so the pick can be made again (and the steps it made are
    // taken back, so neither Back nor Forward lands on them)
    await unwindPick(c);
    app.pickChain = null;
    // (back on the page as first opened, its ?add=s cancelled by the pick: opened again with them --
    // the address named them, the scene had the first model alone: r62 Q3)
    const adds = params.getAll('add').length;
    // (only over the first model: a file of the visitor's shown is theirs -- r63 Q2)
    if (ownEntry(history.state) && history.state.cadvFirst && adds && (app.scene || []).length < 1 + adds && addressModel() && app.sourceUrl === addressModel()) openStart(addressModel());
    syncModelList();
  });
}
// A failed pick's chain taken back by its stamp's depth, to the entry before it, and the entries ahead
// dropped by pushing a copy of the address before (r61 A2, Q3, r62 A1, Q1)
async function unwindPick(c) {
  const step = (go) => new Promise((res) => {
    window.addEventListener('popstate', res, { once: true });
    app.skipPop = true;
    go();
  });
  const k = ownEntry(history.state) && history.state.cadvPick === c.id ? history.state.depth : 0;
  if (k > 0) await step(() => history.go(-k));
  history.pushState(history.state, '', c.before);
  await step(() => history.back());
  app.entrySearch = new URL(c.before).search;
}

// Back / Forward between list picks reopen the entry's model and #view= (viewIsFor), a fragment alone
// an edit of the view; every entry carries this page's id (r59 A8, Q2, r64 Q3, Q6)
const newPageId = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const ownEntry = (s) => !!(s && s.cadvEntry && s.cadvEntry === app.pageId);
// (an entry another page wrote -- before a reload --: its marks are not this page's)
const otherPages = (s) => !!(s && s.cadvEntry && s.cadvEntry !== app.pageId);
function wireHistory() {
  app.pageId = newPageId();
  app.entrySearch = location.search;
  // (the first page marked in its entry's state, its address rewritten under it; every entry carries
  // app.pageId, a #view= edit takes its entry's marks; a reload's old marks dropped -- r61 A1, r63)
  const { cadvFirst: _f, cadvEntry: _e, cadvPick: _p, depth: _d, ...kept } = history.state || {};
  history.replaceState({ ...kept, cadvFirst: true, cadvEntry: app.pageId }, '', location.href);
  app.entryState = history.state;
  const startHref = location.href;
  window.addEventListener('popstate', () => {
    if (ownEntry(history.state)) app.entryState = history.state;
    if (app.skipPop) { app.skipPop = false; return; }
    // (an entry from before a reload: its address opened as it opens fresh -- its model, lists,
    // tour, ?add=s and view --, by loading it: this page's start and first model are not its)
    if (otherPages(history.state)) { location.reload(); return; }
    // (the last step's "not kept" note ends with it: it stayed through two more Back presses -- R172-7)
    if (carriedNote.endsWith('is not kept: open it again with Open…') || carriedNote.startsWith('the tour in this address waits')) { if ($('hover').textContent === carriedNote) tell(carriedNote, 1, ''); carriedNote = ''; }
    // (an entry a #view= edit just made is not yet marked: it is the step it was edited on)
    const wasFile = app.entryFile || null, file = ownEntry(history.state) ? history.state.cadvFile || null : wasFile;
    app.entryFile = file;
    if (location.search === app.entrySearch && file === wasFile) return; // (the fragment alone: hashchange's)
    // (Back or Forward off a measured file from this device asks first, as leaving the page does; kept,
    // its step is put back -- R172-1)
    if (wasFile && app.fileHref && deviceWorkAtRisk()
      && !confirm(`Leave ${wasFile}? Its measurements will be lost: a file opened from this device cannot be opened again from here.`)) {
      history.pushState(app.fileState, '', app.fileHref);
      app.entryState = app.fileState;
      app.entrySearch = new URL(app.fileHref).search;
      app.entryFile = wasFile;
      return;
    }
    app.entrySearch = location.search;
    // (an entry naming a tour opens as the address opens fresh, the tour played: Back reopened its model
    // alone -- R172-2)
    // (not over a tour being made: the reload would lose its unsaved steps, which nothing asked about --
    // the model opens alone and the tour is said to wait -- R173-1)
    if (new URLSearchParams(location.search).get('tour') && !app.tour) {
      if (!app.recorder?.unsaved?.()) { app.leaveOk = true; location.reload(); return; }
      // (naming the steps' own model, the one they can be saved on, and carried through this entry's
      // load: "save it" was refused over the model opened here, and the note was gone by ready -- R174-1)
      const on = app.recorder.madeOn?.(), t = on
        ? `the tour in this address waits: your unsaved tour was made on ${on} -- open ${on} again to save it, then come back to play this one`
        : 'the tour in this address waits while your tour has unsaved steps: save it, then come back to play this one';
      tell((carriedNote = t), 8000, t, true);
    }
    // (onto a device file's step: still shown, kept; else the file is not kept, which is said, and the
    // entry's address opens as the page's would -- R171-2)
    if (file) {
      if (somethingShown() && !app.sourceUrl && app.sourceName === file) { syncModelList(); return; }
      const t = `${file} was opened from this device and is not kept: open it again with Open…`;
      tell((carriedNote = t), 8000, t, true); // (carried through the load of the entry's own model, as the list's note is)
    }
    const search = new URLSearchParams(location.search);
    // (an entry with no ?src is the page as first opened: the model its start opened from the
    // address -- the tour's own model ahead of the list's first, not the list's first always: r56 A2)
    const src = modelUrlIn(search) || addressModel();
    // (the page as first opened is its model with its ?add=s: shown alone -- a pick of it reopened it
    // alone -- it opens again with them: r59 A3)
    const first = !!(history.state && history.state.cadvFirst);
    const whole = !first || !params.getAll('add').length || (app.scene || []).length > 1;
    // (the model shown OR opening, r60 Q1; Back onto the one still shown while a pick downloads, or
    // an entry naming none, cancels the pick and keeps what is shown: r61 Q6, r63 Q4)
    const cancelPick = () => {
      listPick++;
      app.pickPending = 0;
      app.pickChain = null;
      beginLoad();
      if (somethingShown()) setStatus('ready', readyText()); else setStatus('idle', idleText());
      syncModelList();
    };
    if (!src) { if (app.pickPending) cancelPick(); else syncModelList(); return; }
    if (src === listedNow() && whole) { syncModelList(); return; }
    if (src === app.sourceUrl && whole && PROGRESS_STATES.has(app.status)) { cancelPick(); return; }
    // (the entry's #view= is for the model its address names, as when the page opened (viewIsFor):
    // with none named, a device file's, not the list's first that Back reopens -- r58 Q1)
    setPendingView(search, location.hash);
    listPick++;
    app.pickPending = 0; // (a pick downloading is no longer the step shown: its entries are not unwound)
    app.pickChain = null;
    // (the page as first opened, its ?add=s too, under the start's address: r59 A3, Q1, r62 Q4)
    if (first) {
      // (the start's model and ?add=s, the entry's own ?unit= and view kept -- "this file is in" was
      // lost, and the start's #view= put back that never landed: r63 A2, Q5)
      const back = new URL(startHref);
      // (with the model it names beside it: "this file is in" named the model, and its ?unit= alone
      // was read as naming none -- syncUnitParam's rule)
      const here = new URLSearchParams(location.search);
      const unit = here.get('unit');
      if (unit) {
        for (const k of MODEL_PARAMS) { back.searchParams.delete(k); if (here.get(k)) back.searchParams.set(k, here.get(k)); }
        back.searchParams.set('unit', unit);
      } else back.searchParams.delete('unit');
      back.hash = location.hash;
      history.replaceState(history.state, '', back);
      app.entrySearch = back.search;
      setPendingView(new URLSearchParams(back.search), back.hash);
      openStart(src);
    } else loadListed(src);
  });
  // (a #view= edited in waits for its model as the start's does; taken out, none waits -- r59 A2, Q3, r60 A4)
  window.addEventListener('hashchange', () => {
    // (a pick downloading: where the page now is in its chain -- an entry of the chain's at its own
    // depth, an edit made on one of them one deeper, anything else outside it: unwindPick)
    const c = app.pickPending && app.pickChain;
    const s = history.state;
    // (an entry another page wrote is popstate's: reloaded there)
    if (otherPages(s)) return;
    if (ownEntry(s)) {
      app.entryState = s;
      if (c) c.at = s.cadvPick === c.id ? s.depth : 0;
    } else {
      const prev = app.entryState || {};
      const own = { cadvEntry: app.pageId };
      if (prev.cadvFirst) own.cadvFirst = true;
      if (prev.cadvFile) own.cadvFile = prev.cadvFile; // (a device file's step keeps its mark through a #view= edit: R171-2)
      if (c && prev.cadvPick === c.id) { c.at = prev.depth + 1; own.cadvPick = c.id; own.depth = c.at; } else if (c) c.at = 0;
      history.replaceState(own, '', location.href);
      app.entryState = own;
    }
    setPendingView(new URLSearchParams(location.search), location.hash);
    if (!PROGRESS_STATES.has(app.status)) landPendingView();
  });
}
// The view a link's address waits with, or none: one setter for the start, Back and an edit (r60 A4)
function setPendingView(search, hash) {
  const view = linkViewOf(hash);
  app.pendingView = view ? { search, view } : null;
  app.badLinkView = hash.startsWith('#view=') && !(view && Object.keys(view).length); // (said when the model is in; a cut one decodes to {}: R167-10, R168-2)
}
// The waiting view lands when it is for the scene shown and its ?add=s are in (viewIsFor; r60 A3)
function landPendingView() {
  if (app.badLinkView && app.header) { app.badLinkView = false; tellReady('the view in the link could not be read (cut short or changed): the model opens at its first view', 8000); }
  if (app.header && !app.addsPending && pendingViewIsFor()) {
    applyLinkView(app.pendingView.view);
    app.pendingView = null;
  } else if (app.header && !app.sourceUrl && app.pendingView?.search.get('file')) {
    tell(`The link's view is of ${app.pendingView.search.get('file')}: open that file to see it`, 5000);
  }
}

// A pointer pick opens at once; a keyboard change on Enter, on leaving the list or after a pause
// (each arrow would be a download); Esc first drops it; Enter gives the focus back as a pick does.
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
// The whole page; the standard API or WebKit's, the button hidden where neither works

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
// (and allowed here: a frame without allowfullscreen showed the button, which did nothing -- R145-2)
const fsApi = () => !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)
  && (document.fullscreenEnabled ?? document.webkitFullscreenEnabled ?? true);

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

// The cut at a position along its axis (model units: mm where the geometry is, else the header's
// unit -- r89 A7), clamped to the model's extent
function setSectionAt(at) {
  const s = app.section;
  s.held = null; // (the visitor's cut, set: no position held for it -- keepingCut holds its own after)
  if (s.axis === 'off' || !app.header) return;
  const k = { x: 0, y: 1, z: 2 }[s.axis];
  const { min, max } = sectionBox();
  s.t = max[k] > min[k] ? Math.min(1, Math.max(0, (at - min[k]) / (max[k] - min[k]))) : 0.5;
  updateButtons();
  viewChanged();
}

// The readout as a field: the cut's position from the reference's corner, Enter sets it (R112-1)
function secOrigin() {
  const ref = app.ref ? bboxOf(app.ref.ids) : app.header?.bbox;
  return ref ? ref.min[{ x: 0, y: 1, z: 2 }[app.section.axis]] || 0 : 0;
}
const secShown = (p) => p[3] * (app.section.flip ? -1 : 1) - secOrigin();

function secEdit() {
  const p = sectionPlane();
  if (!p || app.secEditing) return;
  const inp = document.createElement('input');
  // (text, a decimal keypad: the wheel never steps it, and never blurs away what is typed -- R122-4)
  inp.type = 'text';
  inp.inputMode = 'decimal';
  inp.autocomplete = 'off';
  inp.spellcheck = false; // (as the other typed fields: R123-7)
  inp.id = 'secin';
  inp.value = lenNum(secShown(p), 'section');
  inp.defaultValue = inp.value;
  inp.setAttribute('aria-label', `Cut position along ${app.section.axis.toUpperCase()}, in ${lenUnit()} (Enter puts the cut there)`);
  app.secEditing = true;
  $('secval').replaceChildren(inp);
  inp.focus();
  inp.select();
  let over = false;
  // (a lone comma a decimal point: R123-2; a unit after it taken and converted, "25.4 mm" or "1 in",
  // as the readout itself writes one: R148-4)
  const val = () => {
    const m = inp.value.trim().replace(/^(-?\d*),(\d*)/, '$1.$2').match(/^(-?[\d.]+(?:e-?\d+)?)\s*(mm|cm|m|in|inch|inches|")?$/i);
    if (!m) return NaN;
    const u = m[2] ? m[2].toLowerCase().replace(/^(inch|inches|")$/, 'in') : null;
    // (no unit to convert from: refused, not ignored -- R149-8 -- but the file's own taken: R150-9)
    if (u && !geomMm()) return u === lenUnit() ? Number(m[1]) : NaN;
    return u && MM_PER[u] ? (Number(m[1]) * MM_PER[u]) / MM_PER[curUnit()] : Number(m[1]);
  };
  const done = (apply) => {
    if (over) return;
    const v = val();
    // (not a number: the field kept open and said so, not closed with nothing done -- R123-2)
    if (apply && inp.value.trim() && !Number.isFinite(v)) {
      inp.setAttribute('aria-invalid', 'true');
      tell(`type a position in ${lenUnit() === 'in' ? 'inches' : lenUnit()}, e.g. 12.5`, 4000); // ("in in": R150-9)
      return;
    }
    over = true;
    app.secEditing = false;
    // (its note gone with it: R124-5)
    if ($('hover').textContent.startsWith('type a position')) tell($('hover').textContent, 1, '');
    // (Enter on the readout as it was filled in keeps the cut: the rounded readout put it up to its
    // rounding away -- r126 L3)
    if (apply && inp.value.trim() && inp.value !== inp.defaultValue) setSectionAt(lenBack(v) + secOrigin());
    else updateButtons();
    $('secval').focus();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
    // (the arrows step it, as the number fields: 1, Shift 10 -- R123-3)
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && Number.isFinite(val())) {
      e.preventDefault();
      // (the number as typed stepped, its unit kept: "1 in" became "26.4" -- R149-6)
      const m = inp.value.trim().replace(/^(-?\d*),(\d*)/, '$1.$2').match(/^(-?[\d.]+(?:e-?\d+)?)(.*)$/);
      inp.value = `${+(Number(m[1]) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)).toFixed(6)}${m[2]}`;
      inp.removeAttribute('aria-invalid');
    }
  });
  // (the refused mark cleared by an edit only: an arrow on "abc" cleared it -- R124-6)
  inp.addEventListener('input', () => inp.removeAttribute('aria-invalid'));
  inp.addEventListener('blur', () => done(false));
}

function wireOptbar() {
  $('secval').addEventListener('click', secEdit);
  $('secval').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === $('secval')) { e.preventDefault(); secEdit(); } });
  $('secsel').onclick = () => {
    const b = app.selected.size && drawnBox([...app.selected]);
    if (!b) return;
    const k = { x: 0, y: 1, z: 2 }[app.section.axis];
    setSectionAt((b.min[k] + b.max[k]) / 2);
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
    keepingCut(() => { app.explode.t = Number($('xppos').value) / 100; }); // (the cut stays put: r126 L3)
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
  syncUndo();
  $('fit').disabled = !has && !app.dxf;
  // (no model: the views, Ortho, Z up, Walk and Turntable greyed as Fit is -- they acted and said
  // "walk on" over the empty page: R142-2)
  if (!has && app.walk) walkMark(false);
  for (const b of [$('proj'), $('up'), $('walk'), $('turntable'), $('presetmenu')?.querySelector('.menu-btn'), ...document.querySelectorAll('#viewpanel .presets button')]) if (b) b.disabled = !has;
  if (!has && app.measure && app.measure.on) app.measure.setOn(false);
  $('measure').disabled = !has && !app.dxf;
  if (!app.dxf) { const mb = $('measure'); mb.dataset.t ||= mb.title; mb.title = has && !app.baseMesh?.faces ? 'Measure distances and angles, or pin a note: this file has no CAD faces, so points snap to the surface (M)' : mb.dataset.t; } // (R153-1, R154-6)
  // Explode: on every renderer (the directions as a table texture or an attribute); off with no model
  if (!has && app.explode.on) { app.explode.on = false; syncExplodeSphere(); $('xpopt').hidden = true; }
  $('explode').hidden = !app.renderer;
  const oneBody = has && app.header.meshes.length < 2;
  $('explode').disabled = !has || oneBody; // (one body: nothing to spread -- R136-2)
  // (and the reason in its title: R137-5)
  $('explode').title = oneBody ? 'Exploded view: this model is one part, so there is nothing to pull apart' : 'Exploded view: pull the parts apart; how far, and along what, show along the bottom of the view (X)';
  $('explode').setAttribute('aria-pressed', String(app.explode.on));
  $('section').disabled = !has && app.section.axis === 'off'; // (no model: nothing to cut, as Explode -- R20-3)
  for (const b of $('exportmesh').querySelectorAll('button')) b.disabled = !has;
  $('tourmake').disabled = !has;
  $('addmodelbtn').disabled = !has || !app.scene;
  $('savepic').disabled = !has && !app.dxf;
  $('printbtn').disabled = $('savepic').disabled;
  // (a drawing saves its own canvas: the options are the 3D view's)
  $('picmore').disabled = !has || !!app.dxf;
  if ($('picmore').disabled) setPicOpts(false);
  // (the drawing needs the b-rep faces: a .cadmesh written before they were kept has none)
  const sd = $('savedrawing'), faceless = has && !app.baseMesh?.faces;
  sd.dataset.t ||= sd.title;
  sd.disabled = !has || faceless; // (and why, as Explode's: R142-11)
  // (a mesh file is not "a .cadmesh": R143-2)
  sd.title = !faceless ? sd.dataset.t : /\.cadmesh(\.gz)?$/i.test(app.sourceName || '')
    ? 'Save drawing: this .cadmesh was written without its faces, so it has no edges to draw; open the model it came from'
    : 'Save drawing: a mesh has no CAD faces to draw edges from; open the model as STEP, IGES or BREP';
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
  if (!app.secEditing) $('secval').textContent = p ? `${app.section.axis.toUpperCase()} = ${lenNum(secShown(p), 'section')} ${lenUnit()}` : '';
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
  $('paintbtn').hidden = $('paintbtn').disabled; // (no faces: R55-4)
  const all = !sel.length;
  $('partreset').disabled = all ? !ownOverrides().size && !ownFaces().size : !sel.some((id) => ownOverrides().has(id - 1));
  $('partreset').textContent = all ? 'Reset all' : 'Reset';
  $('partreset').title = all ? 'Give every recoloured part its scheme colour again, and clear the painted faces' // (R134-8)
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

// Every load takes a sequence number, a load finishing after a newer one discarded; Save changes only
// when a model actually loads
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

// Show the model in colour scheme id (js/palettes.js), remembered: a copy of
// the converted model in its colours, uploaded as a load's would be. During a
// load it only records the choice.
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
  // (with Paint on the swatch is the paint's colour, not the selection's: choosing it recoloured the
  // selected part and lost its own -- high R134-2)
  if (app.paintFaces) { tell(`paint colour set: ${tapWord()} a face to paint it`, 3000); return; }
  if (!app.selected.size) return;
  rememberColours('Colour');
  const c = hexToRgb(hex);
  // (shown now, and -- in a tour -- kept as the visitor's own, which leaving the tour puts back)
  for (const id of app.selected) { app.overrides.set(id - 1, c); if (app.tour) app.tour.base.overrides.set(id - 1, c); }
  saveOverrides();
  updateButtons();
  const w = `${app.selected.size} part${app.selected.size > 1 ? 's' : ''} recoloured`;
  recolour(w);
  tell(`${w}: it shows once deselected`, 3000, ''); // (under the selection's tint it did not show: R134-5)
}

// Reset: the selected parts' picked colours, or with nothing selected every
// picked colour of this model; the parts take the scheme's colours again
function resetPartColour() {
  let n = 0, nf = 0;
  const own = ownOverrides(), faces = ownFaces();
  if (app.selected.size ? [...app.selected].some((id) => own.has(id - 1)) : own.size || faces.size) rememberColours(app.selected.size ? 'Reset' : 'Reset all');
  if (app.selected.size) {
    for (const id of app.selected) { if (own.delete(id - 1)) n++; if (!app.tour) app.overrides.delete(id - 1); }
  } else {
    n = own.size; nf = faces.size;
    own.clear();
    faces.clear(); // and the painted faces
  }
  saveOverrides();
  // in a tour, the visitor's colours are under the step's: the step is drawn again from them (its
  // colours and dimming kept; clearing the shown map dropped the step's emphasis mid-tour)
  if (app.tour) applyStepState(app.tour.tour.steps[app.tour.i]);
  updateButtons();
  // (shown too: a link's "leaves out the part colours" stayed over it -- R132-11)
  // (a painted face named as one, as Copy view link names them: "1 part colour reset" -- R133-8)
  const w = [n ? `${n} part colour${n > 1 ? 's' : ''}` : '', nf ? `${nf} painted face${nf > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
  if (w) { recolour(`${w} reset`); tell(`${w} reset`, 2500, ''); }
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
    dropModel(gpuFull(e, app.sourceName).message);
  });
}

// A model the graphics could not hold, in the visitor's words; the renderer's own reason kept for the
// ? box's graphics line. Anything else is passed through as it is (R169-4).
const GPU_FAULT = /GPU|WebGL|state texture|allocating/;
function gpuFull(e, name) {
  const m = String(e?.message || e);
  if (!GPU_FAULT.test(m)) return e;
  app.gpuReason = m;
  showInfo();
  return new Error(`${name || 'this model'} is too big for this device's graphics memory: close other tabs or apps, or open it on a computer`);
}

function dropModel(msg) {
  clearModel();
  app.error = msg;
  setStatus('error', msg);
}

// The 3D model gone from the UI and the GPU (a failed load; a DXF opened)
function clearModel() {
  app.releaseInfo?.(); // (the panel of the model before is not the height to hold)
  app.mesh = null;
  showBase(null, [], 'stopped: another model was opened');
  app.scene = null;
  app.sceneAsked = null;
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
  // the shown model's tools go with it (the cut, Walk, Paint; Explode where the next mesh lands);
  // Turntable and the Display looks are preferences and stay
  app.section.axis = 'off';
  app.section.of = null; // (a tour step's box with it: r134 M2)
  explodeOffForModel();
  if (app.walk) walkMark(false);
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

// stepBuf: a STEP import's tessellated buffer (Save .cadmesh's), null for a .cadmesh; conversion:
// { unmeshedFaces, threads }; reading: a unit-less mesh's { unit, unitless } (r117 M3)
async function loadBuffer(buf, name, seq, stepBuf = null, conversion = null, reading = null) {
  const unmeshedFaces = conversion?.unmeshedFaces || 0;
  // Each step names itself (the loading card) and lets that paint first:
  // on a phone, inflate + decode + upload of a big model is a second or more
  // of a frozen page that would otherwise read as "stuck at 100%".
  const phase = async (what, detail) => {
    if (stale(seq)) return false; // a superseded load paints nothing over the newer one
    setStatus('loading', `${what} ${name}`);
    showProgress(`Opening ${name}`, null, detail);
    // (no Cancel through the upload: the page is frozen, and an Esc landed after the model opened -- R143-6)
    if (what === 'uploading') $('pcancel').hidden = true;
    await nextPaint();
    return !stale(seq);
  };
  const t0 = performance.now();
  if (isGzip(buf) && !(await phase('unpacking', `unpacking ${sizeText(buf.byteLength)}`))) return; // (KB under a MB, as every size on the card: R144-4)
  // (stopped once the load is, as unpackGz's: Cancel waited for the whole of a .cadmesh.gz -- r78 A6)
  let raw;
  try { raw = await inflateCadmesh(buf, () => stale(seq)); } catch (e) {
    if (e instanceof StopRead) return;
    throw e;
  }
  if (stale(seq)) return;
  const inflateMs = performance.now() - t0;
  if (!(await phase('reading', `reading ${sizeText(raw.byteLength)} of geometry`))) return;
  const t1 = performance.now();
  const base = decodeCadmesh(raw);
  // a file of curves or points only refused in plain words, the model shown kept (r22, r23; cadmesh.js noSurfaces)
  const none = noSurfaces(base.header.indexCount, name, conversion && conversion.unmeshedFaces);
  if (none) throw new Error(none);
  // File > Add model… (or ?add=): merged into the scene beside the shown model
  if (app.adding && app.adding.seq === seq) return addToScene(base, name, seq, unmeshedFaces);
  // one holder, shared by every palette copy made from base (they spread it)
  base.edgeInfo = { value: null, ready: null };
  // part colours belong to the model they were picked on: this model's own
  const key = modelKeyOf(base.header);
  const overrides = loadOverrides(key, base.header.meshes.length);
  const mesh = inScheme(base, overrides, new Map()); // (painted faces are the old model's)
  const scheme = app.palette; // a scheme picked during the upload is drawn after it
  const decodeMs = performance.now() - t1;
  try { checkFits(app.renderer, mesh); } catch (e) { throw gpuFull(e, name); }
  if (stale(seq)) return; // a newer load owns app.wanted; never upload a stale model
  if (!(await phase('uploading', `uploading ${fmtInt(mesh.header.indexCount / 3)} ${mesh.header.indexCount === 3 ? 'triangle' : 'triangles'} to the GPU`))) return;
  app.wanted = mesh;
  try {
    // Rejects on a GPU allocation/validation failure; the renderer then still
    // holds the current model (uploads build first and swap on success).
    await gpuSync();
  } catch (e) {
    handBack(mesh);
    throw isDead(app.renderer) || gaveUp ? e : gpuFull(e, name);
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
  explodeOffForModel(); // a new model opens together
  // nor with the last one's cut or Walk viewpoint, and the cut's box the scene's (r134 M2)
  app.section.axis = 'off';
  app.section.of = null;
  if (app.walk) walkMark(false);
  app.sourceName = name;
  // the URL it came from, for a view link (null: a local file, which a link cannot carry)
  app.sourceUrl = app.urlOfLoad && app.urlOfLoad.seq === seq ? app.urlOfLoad.url : null;
  // the models in the view: this one alone (Add model… appends)
  app.scene = [{ base, name, url: app.sourceUrl, offset: [0, 0, 0], unmeshed: unmeshedFaces, ...(reading ? { unit: reading.unitless ? reading.unit : undefined, unitless: reading.unitless } : {}) }];
  app.sceneAsked = null;
  app.meshSource = null; // (a unit-less mesh file sets it again after: meshFromSource)
  syncUnitParam(); // (another model's ?unit= is not this one's)
  forgetClearance();
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
  app.fileOrient = app.pendingOrient?.seq === seq ? app.pendingOrient.orient : null;
  app.cam.orient = orientFor(app.sourceUrl);
  setView('iso');
  app.loadQ = app.cam.q; // the view it opened at (fillModelList)
  // (recolour refuses while an upload is under way, so the pick waited here)
  if (app.palette !== scheme) recolour();
  // a view link applies to the model the page opened with (a device's link to the next device file,
  // never a list's first), after any ?add=s (r16 M2)
  landPendingView();
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
  // (named, as a drawing is: "ready" alone said nothing of what opened -- R143-5)
  announce(`${name} opened: ${fmtInt(app.stats.meshes)} ${app.stats.meshes === 1 ? 'body' : 'bodies'}${readyText() === 'ready' ? '' : `, ${readyText().replace(/^ready · /, '')}`}`);
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

// A big CAD file on a touch-only device converted only once asked (minutes, and a tab out of memory
// reloads unsaid). -> true to convert, false cancelled or superseded; a saved conversion never asks
const BIG_PHONE_MB = 20;
function askBigConversion(buf, name, seq) {
  const mbs = buf.byteLength / 2 ** 20; // (as the download's and conversion's cards: "26 MB" here, "24.5 MB" there -- R133-2)
  // (app.bigAsk: { mb } makes any device ask past that size: tests/ui-checks.py)
  if (app.bigAsk ? mbs < app.bigAsk.mb : !coarseOnly() || mbs < BIG_PHONE_MB) return Promise.resolve(true);
  // the reference machine's time from the size alone, rounded up
  const secs = forecastTotal(forecast({ bytes: buf.byteLength }));
  const mins = Math.max(1, Math.ceil(secs / 60));
  if (panelOpen()) setPanel(false); // (the question under a phone's open drawer, its button covered: R134-3)
  setStatus('loading', `${name} is ${mb(buf.byteLength)} MB: convert it?`);
  showProgress(`Convert ${name}?`, 0, `${mb(buf.byteLength)} MB to convert on this device. A computer takes about ${mins} min; a phone takes several times that and may run out of memory, reloading the page.`,
    app.embed ? '' : 'Its .cadmesh, saved from a computer (File > Save .cadmesh), opens here in seconds.'); // (an embed has no File menu: R125-6)
  $('pgo').hidden = false;
  announce(`${name} is ${mb(buf.byteLength)} MB: Convert anyway, or Cancel`);
  $('pgo').focus();
  return new Promise((resolve) => {
    const finish = (v) => { clearInterval(t); $('pgo').hidden = true; $('pgo').onclick = null; resolve(v); };
    // Cancel (or any newer load) makes this load stale
    const t = setInterval(() => { if (stale(seq)) finish(false); }, 200);
    $('pgo').onclick = () => finish(!stale(seq));
  });
}

// ---------- more than one model (feature review item 18; js/scene.js) ----------
// app.scene: [{ base, name, url, offset }], the first opened, the rest added; with more than one,
// app.baseMesh is their merge (a tree node each, ids running on), merged again on a move.

// Start a load whose model joins the scene instead of replacing it
// (offset: where ?addat= puts it, the add's own and ended with it: r117 M2)
function startAdd(fn, offset = null, beside = false) {
  if (!app.scene) return Promise.resolve();
  const p = startLoad(() => {
    app.startingAdd = true; // (loadUrl, run by fn: an added model's load keeps the first's list keys)
    let q;
    try { q = fn(); } finally { app.startingAdd = false; }
    app.adding = { seq: app.loadSeq, offset, beside }; // (fn's beginLoad numbered it; loadBuffer reads this later)
    return q;
  });
  // (held while it loads, for an entry's tour to wait for: entryTourWait)
  const held = (app.addLoad = p.then(() => { if (app.addLoad === held) app.addLoad = null; }));
  return p;
}

// the scene a move or add builds on: the last asked for (r114 R4-M3)
const sceneNow = () => app.sceneAsked || app.scene;
async function addToScene(base, name, seq, unmeshed = 0) {
  let offset = app.adding && app.adding.seq === seq ? app.adding.offset : null;
  const beside = !offset && app.adding?.seq === seq && app.adding.beside;
  app.adding = null;
  if (!app.scene || stale(seq)) return;
  const url = app.urlOfLoad && app.urlOfLoad.seq === seq ? app.urlOfLoad.url : null;
  // (named as its model list entry names it, when one does)
  if (url && listEntry(url)?.name) name = listEntry(url).name;
  if (app.scene.length === 1 && app.scene[0].url && listEntry(app.scene[0].url)?.name) app.scene[0].name = listEntry(app.scene[0].url).name;
  // (a list board added stands as its own entry says, in the view's frame: Le Potato lay upside down
  // beside a board of another frame -- R160-3)
  const turn = url && listEntry(url)?.orient ? orientTurn(listEntry(url).orient, app.cam.orient) : null;
  // (a list board picked to compare stands beside the view's models, 10 mm off, on the same ground --
  // at its own origin it lay through the first: R160-2)
  const s = app.header?.bbox, b0 = base.header.bbox;
  if (beside && s && b0 && geomMm() && geomIsMm(base.header)) {
    const b = turn ? turnBox(turn, b0) : b0, r = orientRoles(app.cam.orient);
    const side = 'xyz'.indexOf(r.right[1]), up = 'xyz'.indexOf(r.up[1]);
    offset = [0, 1, 2].map((k) => (k === side ? (r.right[0] === '+' ? s.max[k] - b.min[k] + 10 : s.min[k] - b.max[k] - 10)
      : k === up ? (r.up[0] === '+' ? s.min[k] - b.min[k] : s.max[k] - b.max[k]) : (s.min[k] + s.max[k] - b.min[k] - b.max[k]) / 2)).map((v) => Math.round(v * 10) / 10);
  }
  const models = [...sceneNow(), { base, name, url, offset: offset ? offset.slice() : [0, 0, 0], unmeshed, turn }];
  // (one unit to a scene: refused before anything is shown, as a 2D drawing is -- r85 A1)
  const unitsClash = sceneUnitsRefusal(models);
  if (unitsClash) throw new Error(unitsClash);
  setStatus('loading', `adding ${name}`);
  showProgress(`Adding ${name}`, null, `uploading ${fmtInt(base.header.indexCount / 3)} more ${base.header.indexCount === 3 ? 'triangle' : 'triangles'} to the GPU`);
  await nextPaint();
  if (stale(seq)) return;
  try { if (!(await showScene(models, { newTree: true }))) return; } catch (e) { throw isDead(app.renderer) || gaveUp ? e : gpuFull(e, name); }
  setView('iso');
  setStatus('ready', readyText());
  // (two versions of one part laid over each other, one colour: the way to tell them apart said -- R163-3)
  const o = offset || [0, 0, 0], a = s && b0 && geomMm() ? turn ? turnBox(turn, b0) : b0 : null;
  const vol = (lo, hi) => [0, 1, 2].reduce((p, k) => p * Math.max(0, hi[k] - lo[k]), 1);
  const lap = a ? vol(a.min.map((v, k) => Math.max(v + o[k], s.min[k])), a.max.map((v, k) => Math.min(v + o[k], s.max[k]))) / Math.max(1e-12, Math.min(vol(a.min, a.max), vol(s.min, s.max))) : 0;
  if (lap > 0.5) tell(`${name} added over the model it joins: the X-ray style shows both, Colours › By assembly gives each its own colour`, 7000, `${name} added over the model it joins: ${models.length} models in the view`);
  else announce(`${name} added: ${models.length} models in the view`);
  // (a #view= edited in while it loaded lands on the scene it joined: r60 A3)
  landPendingView();
}

// Draw `models` as the scene: merged, uploaded, then made the shown model.
// newTree: the tree is built again (a model added); a move keeps the
// selection, the hidden parts and the tree. Resolves false if superseded.
async function showScene(models, { newTree = false, quiet = false } = {}) {
  // (one that supersedes an add still uploading builds the add's tree: a move typed meanwhile took
  // the GPU from it, and the added model's bodies had no rows -- r115 R5-M3)
  newTree = newTree || !!(app.sceneAsked && app.sceneAskedTree);
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
  app.sceneAsked = models; // (sceneNow: r114 R4-M3)
  app.sceneAskedTree = newTree;
  try {
    await gpuSync();
  } catch (e) {
    if (app.sceneAsked === models) app.sceneAsked = null;
    handBack(mesh);
    throw e;
  }
  if (app.wanted !== mesh) return false; // a newer load or move took the GPU
  if (app.clearanceRun) app.clearanceRun.stop();
  app.scene = models;
  if (app.sceneAsked === models) app.sceneAsked = null;
  // (the faces the converter could not mesh, of every model in it: an added STEP's were never told,
  // its holes shown under a "ready" and a "missing faces" row of the first model's alone -- r117 M4)
  app.unmeshedFaces = models.reduce((s, m) => s + (m.unmeshed || 0), 0);
  // (a clearance read is of the scene before: cleared here, where every scene change passes --
  // Add model kept "1.65 mm" for a scene whose new case touched)
  forgetClearance();
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
  explodeOffForModel();
  app.holesFor = null;
  $('holes').hidden = true;
  app.lastStepBuffer = null; // (Save .cadmesh writes one converted file, not a scene)
  $('export').disabled = true;
  app.hover = 0;
  app.hoverSeq++;
  app.viewGen++;
  // (said, as Clear says it: a pinned note went unsaid -- R155-12)
  const gone = app.measure ? app.measure.results.length : 0, cleared = gone ? `, ${gone} Measure result${gone === 1 ? '' : 's'} cleared` : '';
  if (app.measure) app.measure.reset(); // its points were on bodies that may have moved
  app.sourceName = models.map((m) => m.name).join(' + ');
  // (said: hidden parts came back and Undo emptied unsaid -- R135-4)
  const afresh = newTree && app.hidden.size && app.scene?.length > 1;
  if (!quiet && (afresh || cleared)) tell(afresh ? `the scene starts afresh: every part shown, Undo cleared${cleared}` : `the scene changed${cleared}`, 4000);
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

// A scene's edges and facts: each model built on its own, unmoved, and kept; the scene's merged
// from them (js/scene.js sceneEdgesFacts); a model whose build fails leaves the scene without.
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
  // (merged again only when a model's were built here; a failed merge, here or in mergeModels, is
  // the scene's failure, said -- r41 Q3)
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

// A scene whose facts are missing: its state from every failed model (remembered if any is, stopped
// only if all were), its error the first's, the others counted (r41 A2, Q1)
function sceneFailed(merged, failed, cap) {
  const infos = failed.map((m) => m.base.edgeInfo);
  // (the merge's failure named as itself, not counted as a model: r43 A6)
  const others = failed.slice(1), n = others.filter((m) => !m.merge).length;
  const also = [n && `${n} more model${n > 1 ? 's' : ''}`, others.some((m) => m.merge) && 'the scene\'s merge'].filter(Boolean);
  const more = also.length ? ` (and ${also.join(', ')})` : '';
  Object.assign(merged.edgeInfo, { error: `${failed[0].name}: ${infos[0].error}${more}`, failed: infos.some((i) => i.failed), stopped: infos.every((i) => i.stopped) });
  // (the scene's edges still drawn when every model carries its own: only the facts are missing)
  merged.edgeInfo.value = merged.edges ? fileEdgesValue(merged, cap) : null;
  // (the word kept unless every failure is a stop, worded by what is missing, told again after each
  // move that leaves it, never twice the same: r42 Q3)
  if (app.baseMesh === merged && !merged.edgeInfo.stopped) sayNoFacts(`${merged.edgeInfo.value ? 'no volume' : 'no edges'} for this scene: ${merged.edgeInfo.error}`);
  return merged.edgeInfo.value;
}

// A model's or scene's edges in hand (edgesOf): silhouettes under the device's cap, facts only by
// today's rule; one builder for both (r40 A5)
function fileEdgesValue(base, cap) {
  const over = !!base.silhouettes && overSilhouetteCap(base.silhouettes.length / 2, cap);
  return { edges: base.edges, silhouettes: over ? null : base.silhouettes,
    silhouetteNormals: over ? null : base.silhouetteNormals,
    silhouettesOmitted: over ? base.silhouettes.length / 2 : (base.header.silhouettesOmitted || 0),
    facts: factsCurrent(base.header) ? base.header.facts : null, source: 'file', ms: 0 };
}

// app.noFacts, the "no facts" word, in every ready line until the model changes (showBase owns it);
// sayNoFacts tells it once when new and writes it only into the ready line (r40-r46)
function sayNoFacts(text) {
  const fresh = app.noFacts !== text; // (with a word said before, if any)
  if (fresh) tell(text, 6000);
  rewriteReady(() => { app.noFacts = text; });
}
// A ready-text word changed and the ready line rewritten in place, later writers' words kept, only
// while ready; sayNoFacts', showBase's and listsRead's one rule (r51 A8)
function rewriteReady(change) {
  const msg = app.statusMsg || '', before = readyText();
  change();
  if (app.status !== 'ready' || !msg.startsWith(before)) return;
  const line = readyText() + msg.slice(before.length);
  if (line !== msg) setStatus('ready', line);
}

// The one change of the shown model or scene: other models' edge builds stopped (why said), the
// scene before ended (its waiting sceneEdges settle GONE), then `next` shown
const GONE = Symbol('gone');
function showBase(next, keep, why) {
  stopEdgeJobs(new Set(keep), why);
  app.baseMesh?.edgeInfo?.leave?.();
  // (the "no volume" word of the one left taken back, the line's own words after it kept: a move
  // that gave the scene its facts kept "no edges for this scene" on the line -- r43 A1)
  if (app.noFacts) rewriteReady(() => { app.noFacts = null; });
  app.baseMesh = next;
}

// the info panel's volume with no facts: a failed or stopped build said, its advice only where a try
// can work (r40 A4, Q5)
const pendingVolume = (info, inScene) => (info?.error
  ? `not computed: ${info.error}${!info.failed && !info.stopped ? (inScene ? ' (move a model to try again)' : ' (open the file again to try again)') : ''}`
  : 'computing…');

// the device's silhouette cap: a coarse-pointer device's smaller one, else edges.js's
const silhouetteCapHere = () => (coarseOnly() ? COARSE_SILHOUETTE_CAP : SILHOUETTE_CAP);

// a move field as wide as a long value (metres' "0.00314" was cut to "0.0031" at 390: R140-3)
// (one width, four decimals, the exact value in its title: a widened field sent Z to its own line -- R141-3)
const fitField = (inp, exact, uw) => { inp.title = `${inp.title.split(' — ')[0]} — ${+exact.toPrecision(12)} ${uw}`; };
// The info panel's models: each by name, the added ones with their offset
function syncScene() {
  const many = !!app.scene && app.scene.length > 1 && !!app.header;
  $('scene').hidden = !many;
  if (!many) return;
  const list = $('scenelist');
  // (in the page's unit, not always mm: R137-3)
  const f = geomMm() ? MM_PER[curUnit()] : 1, uw = geomMm() ? curUnit() : 'mm', dp = 4; // (R138-10, R139-3, R141-3: the exact value in the title)
  // rebuilt only when the models or the unit change (a typed offset keeps its focus)
  const key = `${app.scene.map((m) => m.name).join('\n')}\n${uw}`;
  if (list.dataset.key === key) {
    app.scene.forEach((m, i) => list.querySelectorAll('li')[i]?.querySelectorAll('input').forEach((inp, k) => {
      // (a typed value kept as typed while it says the same: 12.34567 came back 12.346 -- R137-8)
      const v = m.offset[k] / f;
      if (document.activeElement !== inp && Math.abs(Number(inp.value) - v) > 1e-9 * Math.max(1, Math.abs(v))) inp.value = String(+v.toFixed(dp));
      fitField(inp, v, uw);
    }));
    return;
  }
  list.dataset.key = key;
  list.replaceChildren();
  app.scene.forEach((m, i) => {
    const li = document.createElement('li');
    const nm = document.createElement('span'), t = document.createElement('span');
    t.textContent = `${i + 1}. ${m.name}`;
    t.title = m.name;
    nm.append(t);
    li.append(nm);
    // (an added model taken out again: only File > Open, dropping the whole scene, did it -- R137-4)
    if (i > 0) {
      const x = document.createElement('button');
      x.className = 'mini';
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${m.name} from the scene`);
      x.title = `Remove ${m.name} from the scene`;
      x.onclick = async () => {
        const now = sceneNow();
        if (!now || !now[i]) return;
        const k = app.measure?.results.length || 0, kb = x.matches(':focus-visible'), hid = app.hidden.size > 0;
        if (!(await showScene(now.filter((_, j) => j !== i), { newTree: true, quiet: true }))) return;
        // (the results it clears said: R138-1, once, showScene quiet: R160-5; the address without its
        // ?add=, so a reload does not bring it back: R138-6)
        tell(`${m.name} removed${hid ? '; every part shown, Undo cleared' : ''}${k ? `; ${k} measurement${k > 1 ? 's' : ''} cleared` : ''}`, 3000);
        const u = new URL(location.href);
        u.searchParams.delete('add'); u.searchParams.delete('addat');
        for (const c of linkAdds().carried) { u.searchParams.append('add', c.url); u.searchParams.append('addat', c.offset.map((o) => +o.toFixed(4)).join(',')); }
        history.replaceState(history.state, '', u);
        // (by keys, to the next ×, else the view: R138-7)
        const nx = kb && document.querySelectorAll('#scenelist li button')[i - 1];
        ((nx && nx.getClientRects?.().length) ? nx : $('view')).focus?.(); // (a shown one: the last gone, List holes took it -- R139-5)
      };
      nm.append(x);
    }
    if (i > 0) {
      const at = document.createElement('div');
      at.append('moved by ');
      'XYZ'.split('').forEach((ax, k) => {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = 'any';
        inp.value = String(+(m.offset[k] / f).toFixed(dp));
        inp.setAttribute('aria-label', `${m.name}: move along ${ax} (${uw})`);
        inp.title = `Move ${m.name} along ${ax}, in ${uw === 'in' ? 'inches' : uw}, from where its file puts it`; // ("in in": R142-6)
        fitField(inp, m.offset[k] / f, uw);
        inp.addEventListener('change', () => {
          const v = Number(inp.value);
          if (!Number.isFinite(v)) return;
          moveModel(i, k, v * f);
        });
        // (the wheel over it: the page-wide rule, wireLooks -- R97-2)
        const u = document.createElement('span');
        u.append(`${ax} `, inp, k === 2 ? ` ${uw}` : '');
        at.append(u);
        /* (u, above: a letter, its field and Z's "mm" never parted -- R96-1)  */
      });
      li.append(at);
    }
    list.append(li);
  });
}

// Move added model i along axis k to v mm from where its file puts it
let moveSeq = 0;
async function moveModel(i, k, v) {
  const now = app.scene && sceneNow();
  if (!now || !now[i] || i === 0) return;
  const models = now.map((m, j) => (j === i ? { ...m, offset: m.offset.map((o, a) => (a === k ? v : o)) } : m));
  const mine = ++moveSeq;
  try {
    if (!(await showScene(models)) || mine !== moveSeq) return;
    // (a move that took the GPU from an Add still uploading shows the added model too, and ends the
    // add's "adding X": the add returned superseded and left it, with its progress card -- r118 L1)
    if (app.status === 'loading' && (app.statusMsg || '').startsWith('adding ') && !app.sceneAsked) setStatus('ready', readyText());
    const f = geomMm() ? MM_PER[curUnit()] : 1;
    announce(`${models[i].name} moved to ${models[i].offset.map((o) => +(o / f).toPrecision(6)).join(', ') /* (no unit change's tail digits: R142-7) */} ${geomMm() ? curUnit() : 'mm'}`);
  } catch (e) {
    tellReady(`could not move ${models[i].name}: ${e.message || e}`);
  }
}

// Clearance in js/clearance-worker.js on copies of the arrays (on the page it held the tab 10.8 s);
// a new run stops a going one (STOPPED); never retried on the page; always settles.
const STOPPED = Symbol('stopped');

// One run of a module worker (edges, clearance); make() builds the message in a try. Settles once:
// { ok } | { error, transient? (retried, MOMENT_TRIES) } | { stopped } | { noWorker }
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

// Clearance: the smallest gap from the selected parts to the other models' shown parts
// (js/clearance.js), a Measure distance; after the model's facts, not its edges alone (r40 Q3, r67)
const factsReady = (base) => (!base.edgeInfo?.value?.facts && base.edgeInfo?.ready ? base.edgeInfo.ready.then(() => {}, () => {}) : Promise.resolve());
async function runClearance() {
  if (!app.scene || app.scene.length < 2 || !app.baseMesh) return;
  if (app.explode.on) setExplode(false); // the gap is measured where the parts are
  const ranges = modelRanges(app.scene);
  const modelOf = (id) => modelOfBody(ranges, id);
  const sel = [...app.selected];
  const inOne = sel.length && sel.every((id) => modelOf(id) === modelOf(sel[0]));
  const mA = inOne ? modelOf(sel[0]) : 0;
  const shown = (id) => !app.hidden.has(id);
  const A = (inOne ? sel : Array.from({ length: ranges[0].count }, (_, j) => j + 1)).filter(shown);
  const B = [];
  ranges.forEach((r, m) => { if (m !== mA) for (let id = r.first; id < r.first + r.count; id++) if (shown(id)) B.push(id); });
  const tris = (ids) => ids.map((id) => { const m = app.header.meshes[id - 1]; return [m.idxStart / 3, m.idxCount / 3]; });
  const what = inOne ? `the ${sel.length === 1 ? 'selected part' : `${fmtInt(sel.length)} selected parts`}` : app.scene[0].name;
  // (every state of the read in one place, its tooltip with it; said once, by announce -- R157-2)
  const say = (text, title = '') => { $('clearval').textContent = text; $('clearval').title = title; announce(text); };
  app.lastClearance = null;
  if (!A.length || !B.length) { say('nothing shown to measure between'); return; }
  say(`checking ${what}…`);
  await nextPaint();
  const base = app.baseMesh;
  // (each set's closed bodies, closedOf, the facts awaited when on their way)
  await factsReady(base);
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
  app.lastClearance = { distance: r.distance, a, b, ms, pairs: r.pairs, pa: r.pa, pb: r.pb, what, noFacts }; // (and for tests)
  const text = sayClearance(app.lastClearance);
  if (r.distance > 0 && app.measure) app.measure.addDistance(r.pa, r.pb, 'clearance');
  announce(`clearance ${text}`);
}
// A clearance read forgotten whole (line, tooltip, result) by a new model or scene (r92 A2, r93 A7)
function forgetClearance() {
  $('clearval').textContent = '';
  $('clearval').title = '';
  app.lastClearance = null;
}
// The clearance line of a run's result, in the unit shown now: by the run, and again when the unit
// picker changes (it kept "1.00 mm" beside Measure's "0.039 in" of the same distance -- r92 A2)
function sayClearance(lc) {
  // a part and its model (scene.js modelOfBody), named as the tree names it, meshLabel (r92 .. r94 A5)
  const ranges = modelRanges(app.scene);
  const nm = (id) => `${meshLabel(id) || `body ${id}`} (${modelOfBody(ranges, id) + 1})`; // (unnamed: the tree's "body N")
  const text = lc.distance === 0
    ? `0 ${lenUnit()}: ${nm(lc.a)} touches or overlaps ${nm(lc.b)}` // (its unit, as every length: R120-8)
    : `${lenNum(lc.distance, 'measure')} ${lenUnit()} from ${nm(lc.a)} to ${nm(lc.b)}${lc.noFacts ? ' (a part inside another not checked: no body facts)' : ''}`;
  $('clearval').textContent = `clearance ${text}`;
  $('clearval').title = `${lc.what} against the other models' shown parts: ${fmtInt(lc.pairs)} triangle pairs compared in ${lc.ms} ms`;
  return text;
}

// Past this many silhouette candidates a coarse-pointer device (a phone,
// a tablet) leaves them out; js/edges.js's SILHOUETTE_CAP elsewhere
const COARSE_SILHOUETTE_CAP = 500_000;
const coarseOnly = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
// "tap" or "click", by the stylesheet's touch-only test
const tapWord = () => (matchMedia(TOUCH_ONLY).matches ? 'tap' : 'click');
// the last press's pointer: a finger names a tapped layer on any device (R12-4)
addEventListener('pointerdown', (e) => { app.pointerType = e.pointerType; }, { capture: true, passive: true });

// The info panel keeps its height while the pointer or focus is in the list (it moved under the
// pointer), let go on leaving, a press elsewhere, a resize or a new list (rounds 15-17)
{
  const info = $('info'), tree = $('tree');
  const parts = $('parts');
  // (R51-2)
  const gutter = () => { const w = info.offsetWidth - info.clientWidth; if (info.offsetWidth) document.documentElement.style.setProperty('--infosb', `${Math.max(0, w)}px`); };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(gutter).observe(info);
  // (R53-2)
  const treeGutter = () => { const w = tree.offsetWidth - tree.clientWidth; if (tree.offsetWidth) document.documentElement.style.setProperty('--treesb', `${Math.max(0, w)}px`); };
  // (R56-1, R57-1)
  const onTree = () => { treeGutter(); trimSpacer(parts); trimSpacer(tree); };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(onTree).observe(tree);
  new MutationObserver(onTree).observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style'] });
  const hold = () => {
    if (info.style.height || !info.offsetHeight) return;
    info.style.height = `${info.getBoundingClientRect().height}px`; // (unrounded: R48-2; spacer kept: R49-1)
  };
  // (the height it gives up kept at the drawer's foot: R48-1, R49-2)
  const release = () => {
    if (!info.style.height) return;
    const was = spacerOf(parts), scrolls = parts.scrollHeight > parts.clientHeight + 1;
    const h = info.getBoundingClientRect().height;
    setSpacer(parts, was + h);
    info.style.height = '';
    const lost = h - info.getBoundingClientRect().height;
    setSpacer(parts, scrolls ? was + lost : 0);
  };
  const unspace = () => { setSpacer(parts, 0); setSpacer(tree, 0); };
  // (not dropped at a key: R55-2)
  for (const box of [parts, tree]) box.addEventListener('scroll', () => trimSpacer(box), { passive: true });
  addEventListener('resize', unspace);
  app.unspaceParts = unspace; // (the drawer closed: setPanel)
  tree.addEventListener('pointerenter', hold);
  tree.addEventListener('pointerdown', hold);
  let keyAt = -1e9; // (focus held only after a focus-moving key: not a refocus, nor Alt+Left -- R17-1, R18-1)
  const MOVES = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
  addEventListener('keydown', (e) => { if (MOVES.has(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) keyAt = performance.now(); }, { capture: true, passive: true });
  tree.addEventListener('focusin', () => { if (performance.now() - keyAt < 1000) hold(); });
  tree.addEventListener('keydown', (e) => { // (a key's selection that cuts the panel lets go, no mouse in the list: R18-3, R19-1)
    if (e.key !== 'Enter' && e.key !== ' ') return;
    setTimeout(() => {
      if (info.scrollHeight <= info.clientHeight + 1 || overBelow()) return;
      release();
      document.activeElement?.scrollIntoView?.({ block: 'nearest' });
    }, 0);
  });
  // (R17-2, R54-1)
  const below = (n) => n instanceof Node && parts.contains(n) && !info.contains(n);
  const overBelow = () => parts.matches(':hover') && !info.matches(':hover');
  parts.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') release(); });
  info.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') release(); });
  // (to the held panel itself the hold stays: R46-2, R47-1)
  parts.addEventListener('focusout', (e) => { if (below(e.target) && e.relatedTarget !== info && !below(e.relatedTarget) && !overBelow()) release(); });
  info.addEventListener('focusout', (e) => { if (e.target === info && !below(e.relatedTarget) && !overBelow()) release(); });
  addEventListener('pointerdown', (e) => { if (!below(e.target)) release(); }, { capture: true, passive: true });
  addEventListener('resize', release);
  app.releaseInfo = () => { release(); unspace(); keyAt = -1e9; }; // (a new list forgets the last key: R19-3)
}

// A model's edges and body facts, the file's or a worker's build -> base.edgeInfo.value, or null
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
  // (built by the worker on copies; with no module worker none, the volume, cut fill and inside test
  // going without, said; one build a model, a running one awaited)
  const going = app.edgeJobs.get(base);
  if (going) return going.promise;
  // (a build failing for the model itself is not tried again; a failure of the moment is, up to
  // MOMENT_TRIES)
  if (info.failed) return Promise.resolve(info.value);
  // (a build before that was stopped or failed for the moment: this one says its own)
  info.error = null; info.stopped = false;
  // a build that failed: its state, and told where it shows (and the info panel says it too),
  // worded by what is missing -- the file's edges are drawn when only the facts failed; the same
  // words are not told twice (sayNoFacts)
  const fail = (v) => {
    // (no module worker: said as why there are no edges nor volume -- r44 Q3, r45 A5)
    // (the browser's reason kept for the console only: R169-8)
    if (v.noWorker) console.warn('no module worker:', v.noWorker);
    info.error = v.stopped || v.error || 'this browser could not run the part of the viewer that works this out: reload the page, or try a newer browser'; // (R170-6)
    // (a stop is no failure; the model's own failure remembered, a momentary one not: r40 A3, Q2)
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
  // (kept by its model, stopped -- stopEdgeJobs, out of the map at once -- when nothing shown holds it)
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

// "ready" with what is missing, the list's note, a drawing's word and why facts are missing
// (sayNoFacts): every writer of the ready line keeps them (r41 A4, Q2, r42 A6)
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
  // (each named with its size and last use, KB under a megabyte: two files of one name told apart -- R171-6)
  $('cacheinfo').textContent = `Saved conversions: ${list.length} · ${sizeText(bytes)}`;
  const when = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('cacheinfo').title = list.map((e) => `${e.name}, ${sizeText(e.size)}, opened ${when(e.used)}`).join('\n');
}

// One gzip layer unpacked, with its step on the progress card (loadAny's
// three paths each had their own, and one showed none: review r22). null:
// a newer load took over meanwhile.
async function unpackGz(buf, name, seq) {
  setStatus('loading', `unpacking ${name}`);
  showProgress(`Opening ${name}`, null, `unpacking ${sizeText(buf.byteLength)}`);
  await nextPaint();
  if (stale(seq)) return null;
  // (the thread given turns as it unpacks, and the unpack stopped once the load is: a Cancel or a new
  // file meanwhile waited for the whole of it -- r77 Q1, Q3)
  let out;
  try { out = await gunzip(buf, undefined, () => stale(seq)); } catch (e) {
    if (e instanceof StopRead) return null;
    throw e;
  }
  return stale(seq) ? null : out;
}

// extras: the file's companions (an OBJ's .mtl, a .gltf's .bin) carried down to its reader, not in a
// global another pick wrote over (r52 A1, Q2)
// A file's bytes opened by their kind. Refused first: an empty file, and a web page given for a
// model (a sign-in or error page, R167-4, R167-5); a reader's failure gets what to do next (R167-2)
async function loadAny(buf, name, seq, extras = []) {
  if (!buf.byteLength) throw new Error(`${name} is empty (0 bytes): export or download it again`);
  const page = webPage(buf);
  if (page) throw new Error(`${name} is a web page${page.title ? ` (“${page.title}”)` : ''}, not a model file: save the model file itself, then open it here`);
  try { return await readAny(buf, name, seq, extras); } catch (e) { throw nextStep(e, name); }
}
// (a page's first bytes, its title if it has one; null for anything else)
function webPage(buf) {
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(4096, buf.byteLength))).trimStart();
  if (!/^(<!doctype html|<html|<head)/i.test(head)) return null;
  const t = /<title[^>]*>([^<]{1,80})/i.exec(head);
  return { title: t ? t[1].trim() : '' };
}
// (words that already say what to do, or are not about the file, are kept as they are)
const KEEPS_NEXT_STEP = /again|re-export|this viewer opens|may work|Add model|Make a tour|graphics|memory|browser|GB, more than/i;
// (said once: a reader's "cadmesh: " dropped, and a reason that already says damaged gets only the
// next step -- R168-1, R168-3)
function nextStep(e, name) {
  const raw = String(e && e.message || e), m = raw.replace(/^cadmesh: /, '');
  if (!(e instanceof Error)) return e;
  // (a kept reason the reader prefixed: the prefix dropped and the file named -- R170-2)
  if (KEEPS_NEXT_STEP.test(m)) return m === raw ? e : new Error(m.includes(name) ? m : `${name}: ${m}`);
  const said = /\.\w+ is damaged/.test(m) ? m : m.includes(name) ? m : `${name}: ${m}`;
  return new Error(`${said} -- ${/damaged|cut short/.test(m) ? '' : 'it may be damaged or cut short: '}download it again, or export it again`);
}
async function readAny(buf, name, seq, extras) {
  // a load superseded while it was reading/fetching must not start a worker
  // (it would also take over app.cancelTess from the newer load)
  if (stale(seq)) return;
  // A name that says no format is opened by its bytes (sniffFormat), gzip unpacked once first, and
  // renamed only for what it turned out to be (r19-r21)
  if (!formatOfName(name)) {
    let body = buf;
    if (isGzip(buf) && !(body = await unpackGz(buf, name, seq))) return;
    name = openedName(name, new Uint8Array(body, 0, Math.min(SNIFF_BYTES, body.byteLength))); // (js/formats.js, check-tour's too: r79 A5)
    buf = body;
  }
  // every format by the one table (js/formats.js)
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
    // (an incomplete conversion is shown, never saved; nor one loadBuffer refuses: r22)
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
    // (a tour this viewer saved: where it opens, not "not a file this viewer opens" -- R124-3)
    if (/\.cadtour\.json$/i.test(name)) throw new Error(app.embed ? `${name} is a tour: open it in cad.place with its model` : app.header ? `${name} is a tour: Make a tour… > Open… plays or edits it over this model` : `${name} is a tour: open its model, then Make a tour… > Open… plays or edits it`);
    throw new Error(`${name} is not a file this viewer opens${ext ? ` (.${ext})` : ''}: ${OPENS}`);
  }
  await loadBuffer(buf, name, seq);
}

// A mesh file read into a .cadmesh, then opened as one. drop: its companions (an OBJ's .mtl)
async function loadMeshFile(buf, name, seq, drop = []) {
  if (isGzip(buf) && !(buf = await unpackGz(buf, name, seq))) return;
  name = name.replace(/\.gz$/i, '');
  const { meshFormatOf } = await meshReaders();
  if (stale(seq)) return;
  const format = meshFormatOf(name, buf);
  if (!format) throw new Error(`${name} is not a file this viewer opens: ${OPENS}`);
  setStatus('loading', `reading ${name}`);
  showProgress(`Opening ${name}`, null, `reading ${sizeText(buf.byteLength)} of ${format.toUpperCase()} mesh`);
  await nextPaint();
  if (stale(seq)) return;
  // (companions, for a reader that takes them, together under a file's size: r54 Q8, r78-r80)
  let extras;
  try { extras = await readCompanions(takesCompanions(formatOfName(`m.${format}`)?.label) ? drop : [], name, () => stale(seq), MAX_FILE_BYTES); } catch (e) {
    if (e instanceof StopRead) return;
    throw e;
  }
  if (!extras) return;
  if (stale(seq)) return;
  // (read in the unit the address gives for this file: a reload or a view link of a re-read one)
  // (a mesh added to a scene is read in the first model's unit: the scene's size)
  const url = app.urlOfLoad && app.urlOfLoad.seq === seq ? app.urlOfLoad.url : null;
  const adding = app.adding && app.adding.seq === seq;
  // (a file that says it is Z up, a 3MF or an STL we wrote, opens Z up: R156-2)
  const head = new TextDecoder().decode(new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, Math.min(17, buf.byteLength)));
  if (!adding) app.pendingOrient = { seq, orient: format === '3mf' || (format === 'stl' && head === 'cad.place export:') ? Z_UP_ORIENT : null };
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
  // (its reading goes in with it: it HAS one -- tours and notes scale to it -- even in a scene, where
  // it cannot be re-read; a model added to a scene keeps the scene's units: no choice there)
  await loadBuffer(raw, src.name, seq, raw, null, { unit, unitless });
  if (app.baseMesh && !stale(seq) && app.scene && app.scene.length === 1) {
    app.meshSource = unitless ? { ...src, unit } : null;
    syncUnitParam();
    showInfo();
  }
}

// A unit-less mesh's read unit is part of which model is shown: the address carries it (?unit=), so
// a reload and a link open it at that size; kept on a scene's first model
const readUnit = () => (app.scene && app.scene[0] && app.scene[0].unit) || 'mm';
function syncUnitParam() {
  const u = new URL(location.href);
  const want = readUnit() !== 'mm' && app.sourceUrl ? readUnit() : null;
  if ((u.searchParams.get('unit') || null) === want) return;
  // (a ?unit= and a #view= are the named model's: the address names the model shown -- r62 Q2, r63)
  if (want && !modelUrlIn(u.searchParams)) { setModelParam(u, app.sourceUrl); u.hash = ''; }
  if (want) u.searchParams.set('unit', want); else u.searchParams.delete('unit');
  history.replaceState(history.state, '', u);
  app.entrySearch = u.search; // (the entry shown, rewritten, as forgetAddressModel keeps it: r60 Q7)
}
// which model a list's tour auto-played for: the URL it was opened from (else its data)
const autoTourKey = () => app.sourceUrl || app.header;
// An entry's tour, by one rule: it waits for the adds, a re-read and Add model…, then starts only over
// the model asked for, by its URL's key and open (r68-r71)
const entryTourWait = () => { const w = [app.addsPending && app.addsChain, rereading() && app.rereadChain, app.addLoad].filter(Boolean); return w.length ? Promise.all(w.map((p) => Promise.resolve(p).catch(() => {}))) : null; };
// The tour's file read, then every load it waits for ended, up to four rounds (r71 A2, Q4, A9)
async function entryTourRead(url) {
  const [r] = await Promise.all([readTour(url), entryTourWait()]);
  await entryTourSettled();
  return r;
}
// (the rounds themselves, the address's tour's too -- addressTourEnds: the loop was written twice, r73 A5)
async function entryTourSettled() {
  for (let k = 0, w = entryTourWait(); w && k < 4; k++, w = entryTourWait()) await w;
}
const entryTourOn = (key, open) => !!app.header && autoTourKey() === key && app.openCount === open && !app.pickPending && !rereading();
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

// a unit as words read it ("read in in" -- r65 A8), by the one table: js/units.js unitSaid (r87 A5)
const unitName = (u) => unitSaid(u);
// whether a re-read of the shown mesh is under way (the load under way is setMeshUnit's): the one
// test, written three times in setMeshUnit -- r68 A6
const rereading = () => PROGRESS_STATES.has(app.status) && app.rereadSeq === app.loadSeq;
// the units row's "file is in": the same bytes read again in that unit
function setMeshUnit(u) {
  const src = app.meshSource;
  // (against the unit it is in, or the one a re-read under way is reading: r66 A2, Q1)
  if (!src || u === (rereading() ? app.rereadUnit : src.unit) || !MM_PER[u]) return Promise.resolve();
  // (after the address's ?add=s; a scene has no unit to choose, which is said -- r63 A3, r65 Q9)
  if (app.addsPending && app.addsChain) {
    return app.addsChain.then(() => (app.meshSource ? setMeshUnit(u) : tell(`not read in ${unitName(u)}: models were added beside it`)));
  }
  // (nor over another model opening, whose load the re-read would end -- r64 A4)
  if (PROGRESS_STATES.has(app.status) && !rereading()) {
    syncMeshUnitRow();
    tell(`not read in ${unitName(u)}: another model is opening`);
    return Promise.resolve();
  }
  // (a tour shown is left first, the visitor's view put back: the re-read ends it anyway, and the
  // hidden parts kept below were then the step's -- a "hide" step left every other part hidden)
  if (app.tour) endTour();
  // (the same file, read again: it keeps the URL it came from -- the address, the view link, the
  // list entry and a saved tour all name it by that; a new seq dropped it)
  const url = app.sourceUrl;
  return startLoad(() => {
    const seq = beginLoad();
    app.rereadSeq = seq;
    app.rereadUnit = u;
    if (url) app.urlOfLoad = { seq, url };
    app.pendingOrient = { seq, orient: app.fileOrient }; // (its Z up kept: R156-2)
    setStatus('loading', `reading ${src.name} in ${unitName(u)}`);
    // (the same bodies, at another size: the visitor's hidden parts stay hidden)
    const hidden = new Set(app.hidden);
    // (its end, what an entry's tour asked for meanwhile waits for: entryTourWait)
    return (app.rereadChain = meshFromSource(src, u, seq)).then(() => {
      if (stale(seq)) return;
      if (hidden.size) { app.hidden = hidden; syncTreeChecks(); pushState(); updateButtons(); viewChanged(); }
      announce(`${src.name} read in ${unitName(u)}`);
    }).finally(() => {
      // (a re-read that never landed: the select says the reading again -- r67 Q3)
      if (!rereading()) syncMeshUnitRow();
    });
  });
}

// A tour over a unit-less mesh plays at this reading's size, scaled (tourAt), not re-read; the first
// model's reading, alone or in a scene (a scene's tour played 25.4x off)
const tourReading = () => (app.scene && app.scene[0] && app.scene[0].unitless ? readUnit() : null);
function startTourIn(tour, url, only = null, at = 0) {
  uncover(); // (R67-1)
  return startTour(tourAt(tour, tourReading()), url, only, at);
}
// A zip (feature review item 24): the first model in it that the viewer
// opens is opened, with its companions (an .mtl, a .bin) beside it
// (its companions: js/formats.js zipCompanions, the list check's choice too -- r77 A3)
async function loadZip(buf, name, seq) {
  // (a gzipped zip unpacked first, as every other kind is: "not a zip file" said a model.zip.gz the
  // list check called ok -- r76 A1)
  if (isGzip(buf) && !(buf = await unpackGz(buf, name, seq))) return;
  name = name.replace(/\.gz$/i, '');
  setStatus('loading', `unpacking ${name}`);
  showProgress(`Opening ${name}`, null, `unpacking ${sizeText(buf.byteLength)}`);
  await nextPaint();
  if (stale(seq)) return;
  const { unzip } = await meshReaders();
  // (superseded while the reader was fetched: stopped -- it went on, r52 Q2)
  if (stale(seq)) return;
  // (its entries' inflates stopped once the load is: r78 A6)
  const z = await unzip(buf, () => stale(seq));
  // (the entry it opens by the one choice, the list check's too: js/formats.js zipModel -- r75 A2)
  const { files, opens, model, threeMf, others } = zipModel(z.names);
  // (a 3MF by its directory, whatever its name: opened as one -- r76 A6)
  if (threeMf) return readAny(buf, `${name.replace(/\.[^./]*$/, '')}.3mf`, seq);
  if (!model) throw new Error(`${name} holds no model this viewer opens: ${OPENS}`);
  // (each read to the budget the ones before it leave, loadMeshFile's `max`, refused in its words past
  // it: each was inflated whole before the total was held, and a 2.9 MB zip held 3000 MB first -- r79 A7)
  const over = () => new Error(companionsOverText(model.split('/').pop().replace(/\.gz$/i, '')));
  const extras = zipCompanions(files, model, opens).map((c) => ({ name: c.name, arrayBuffer: (max = MAX_FILE_BYTES) => z.get(c.path, max, over) }));
  let inner;
  try { inner = await z.get(model); } catch (e) {
    if (e instanceof StopRead) return;
    throw e;
  }
  if (stale(seq)) return;
  if (others) announce(`opening ${model} from ${name} (${others} more in it not opened)`);
  return readAny(inner, model.split('/').pop(), seq, extras);
}

// ---------- 2D DXF (plan feature 23; js/dxf.js, js/dxf-view.js) ----------
// A DXF opens in 2D: drawn on its own canvas (#view2d), its layers in the parts list, the 3D-only
// controls stepping aside (body.mode2d).
async function loadDxf(buf, name, seq) {
  if (isGzip(buf) && !(buf = await unpackGz(buf, name, seq))) return;
  name = name.replace(/\.gz$/i, '');
  setStatus('loading', `reading ${name}`);
  // a DWG by its tag, a DXF by its start, else by its name: formats.js drawingReaderOf (r70, r80, r108)
  const format = drawingReaderOf(name, new Uint8Array(buf, 0, Math.min(SNIFF_BYTES, buf.byteLength)))?.label || 'DXF';
  showProgress(`Opening ${name}`, null, `reading ${sizeText(buf.byteLength)} of ${format}`);
  await nextPaint();
  if (stale(seq)) return;
  // a DWG read into a DXF's group codes, a DXF as its bytes, off the page's thread where it can be
  // (one that draws nothing refused by readDrawing: r87 A2)
  // (a DXF with no EOF is cut short: what was read is shown, and that said -- R167-11)
  const ended = format !== 'DXF' || /EOF/.test(new TextDecoder('latin1').decode(new Uint8Array(buf, Math.max(0, buf.byteLength - 64))));
  const got = await readInWorker({ kind: '2d', buf, format, name }, name);
  if (stale(seq)) return;
  await twoD();
  const drawing = got ? got.drawing : (await fileReaders()).readDrawing({ buf, format, name });
  if (stale(seq)) return;
  show2D(drawing, name, app.urlOfLoad && app.urlOfLoad.seq === seq ? app.urlOfLoad.url : null);
  if (!ended) tellReady(`${name} may be cut short (it has no end mark): only what was read is shown -- download it again`, 8000);
}

// the 2D view's name, the layers the shown sheet draws on as the panel counts them, on opening and
// on a sheet's change (R144-5, R145-6) -> the layers' words
function sheetLabel() {
  const sh = app.dxf.shown || app.dxf.drawing, tl = layerTally(sh), nl = sh.layers.filter((l) => tl.get(l.name)).length;
  const ln = `${nl} ${nl === 1 ? 'layer' : 'layers'}`;
  $('view2d').setAttribute('aria-label', `${$('model').textContent}: ${ln}; arrows pan, plus and minus zoom`);
  return ln;
}
// The 2D view on a sheet: -1 model space, else layout i; which layers are off carries over
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
    // (a touch has no hover, so the layer a tap selects is named in the view, as a tapped part is:
    // UI design round 11 R11-4)
    // (a press on blank paper with nothing selected says nothing; a layer let go, 3D's words -- R129-3)
    onSelect: (layer) => { const had = app.dxf.selSaid; app.dxf.selSaid = layer || ''; syncLayerRows(); showInfo(); if (layer || had) announce(layer ? `layer ${layer} selected` : 'selection cleared'); if (layer && app.pointerType === 'touch') tell(`layer ${layer}`, 2500, ''); }, // (shown, said once: R130-5)
    onHover: (what, snap) => hoverLabel(!what ? '' : snap ? what : `layer ${what}`),
    onMeasure: (r) => { tell(r.text, 4000); app.measure?.sync2D(app.dxf?.view); },
    onPending: () => app.measure?.sync2D(app.dxf?.view),
  });
  for (const n of off) app.dxf.view.setLayerOn(n, false);
  $('measure').setAttribute('aria-pressed', 'false');
  if (old) { buildLayerList(); showInfo(); sheetLabel(); announce(L ? `layout ${L.name}` : 'the drawing'); } // (in the visitor's words: R159-5, R160-7)
  app.measure?.sync2D(app.dxf.view); // (R45-2)
}

// A model or drawing from the device clears the address's model keys, or a reload opens that (r16 L7)
function forgetAddressModel() {
  const q = new URLSearchParams(location.search);
  if (app.sourceUrl) return;
  // (a second file over a device file's step: the step names the file shown now -- it kept the first's
  // name, and Back asked to leave the wrong one -- R173-3)
  if (ownEntry(history.state) && history.state.cadvFile) {
    const s = { ...history.state, cadvFile: app.sourceName || 'the file' }, u = new URL(location.href);
    dropAddressModel(u); // (and the first file's #view=, not this one's)
    history.replaceState(s, '', u);
    app.entryState = app.fileState = s;
    app.entryFile = s.cadvFile;
    app.fileHref = u.href;
    app.entrySearch = u.search;
    return;
  }
  if (![...ADDRESS_MODEL_PARAMS].some((k) => q.has(k)) && !location.hash.startsWith('#view=')) return;
  const u = new URL(location.href);
  dropAddressModel(u);
  // (a file from the device over a model the address names takes its own step, marked as a file's:
  // rewritten in place, Back met an entry of the same address and did nothing -- R171-2)
  history.pushState({ cadvEntry: app.pageId, cadvFile: app.sourceName || 'the file' }, '', u);
  app.entryState = app.fileState = history.state;
  app.fileHref = u.href; // (put back if Back off it is refused: R172-1)
  app.entrySearch = u.search; // (the entry shown, rewritten: wireHistory -- r60 A1)
  app.entryFile = history.state.cadvFile;
}
// What an address loses when another model (a pick or a device file) replaces the one it names:
// its model, unit, ?add=s and places, tour and view, by one rule for both (r59 A4, r60 A2, I6).
const ADDRESS_MODEL_PARAMS = [...MODEL_PARAMS, 'unit', 'add', 'addat', 'tour', 'step'];
function dropAddressModel(u) {
  for (const k of ADDRESS_MODEL_PARAMS) u.searchParams.delete(k);
  u.hash = '';
}

// A drawing's tooltips for the controls it keeps; the 3D ones are put back on leaving (rounds 9-12)
// Print's key in a title as this page has it: ⌘P on a Mac, none when framed (the host's: R118-1, R118-5)
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
let FRAMED = false;
try { FRAMED = window.self !== window.top; } catch { FRAMED = true; }
const keyTitle = (t) => (FRAMED ? t.replace(/ \((Ctrl|⌘)\+P\)/, '') : IS_MAC ? t.replace('Ctrl+P', '⌘P') : t);
const TITLES_2D = [
  ['measure', 'Measure the drawing: two points, which snap to line ends, middles and circle centres (M)'],
  ['savepic', 'Save the drawing as a PNG picture, as it is shown without the selection and the hover (P)'],
  ['fit', 'Fit the drawing in view (F)'],
  ['embedfit', 'Fit the drawing in view'],
  ['embedopen', 'Open this drawing in the full viewer, in a new tab'],
  ['sharelink', 'Copy a link that opens this drawing'],
  ['printbtn', 'Print the drawing, without the selection and the hover, with its name (Ctrl+P)'],
  ['panelbtn', 'Layers list'],
];

// The words naming what is shown: ☰, the drawer and the skip link (round 11-12)
function modeWords(is2d) {
  $('panelbtn').setAttribute('aria-label', is2d ? 'Layers' : 'Parts');
  $('panelbtn').querySelector('.lbl').textContent = is2d ? 'Layers' : 'Parts';
  $('skipview').textContent = is2d ? 'Skip to the drawing' : 'Skip to the 3D view';
  $('parts').setAttribute('aria-label', is2d ? 'Layers' : 'Parts');
}

// An embed's hint for what is shown: a drawing pans, a model turns (round 9 R9-1)
function embedHint() {
  const verb = tapWord() === 'tap' ? 'Tap' : 'Click';
  $('embedhint').textContent = app.dxf ? `${verb} to pan and zoom the drawing` : `${verb} to turn and zoom the model`;
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
  embedHint();
  // (an embed's overlay buttons and hint lie over the view's edges: the drawing fits inside them)
  $('view2d').dataset.fitInset = app.embed ? '44' : '0';
  // the kept controls' tooltips in a drawing's words (Measure's named faces and hole centres,
  // Save picture the options ▾ that 2D hides: UI design round 9 R9-9)
  for (const [id, t] of TITLES_2D) { const b = $(id); if (b) { b.dataset.title3d ??= b.title; b.title = keyTitle(t); } } // (?noopen=1 removes embedopen)
  modeWords(true);
  // (the row changed -- View out, the 2D badge and the sheet select in -- and the header's size
  // may not have: after the select is shown, so the fold counts it, UI design round 8 R8-1)
  refold();
  setSheet(dxfLib.sheetDraws(drawing) || !sheets.length ? -1 : sheets[0].i);
  $('measure').setAttribute('aria-pressed', 'false');
  updateButtons(); // (clearModel ran them before app.dxf: Measure, Fit and Print come on for the drawing)
  buildLayerList();
  $('model').textContent = name;
  document.title = `${name} — ${SHORT_TITLE}`;
  const ln = sheetLabel();
  $('sharelink').disabled = !url;
  // (and why not, as a 3D model from this device has a link: R144-6)
  $('sharelink').title = url ? 'Copy a link that opens this drawing' : 'Copy view link: this drawing was opened from this device, so no link can open it; put it on a web page to share it';
  // (Save picture, Print and the picture options: updateButtons above sets them from app.dxf)
  syncMenuButtons();
  showInfo();
  setStatus('ready', readyText());
  announce(`${name} opened: ${ln}`); // (after "ready · 2D drawing", not "2D drawing" twice: R145-7)
}

// 2D Measure on or off: two clicks give a distance with ΔX and ΔY in the
// drawing's unit, snapping to line ends, middles and circle centres; off
// clears its results
function toggle2DMeasure() {
  if (!app.dxf) return;
  const v = app.dxf.view, on = !v.measuring, n = on ? 0 : (v.results?.length || 0);
  const kb = $('measoff').matches(':focus-visible'); // (its ×: the focus to Measure)
  v.setMeasure(on);
  if (!on) v.clearMeasure();
  $('measure').setAttribute('aria-pressed', String(on));
  app.measure?.sync2D(v);
  if (kb && !on) toolFocus('measure').focus();
  // (a drawing's results go with Measure: said, as nothing else did -- R23-3)
  const off = n ? `measure off: ${n} ${n === 1 ? 'result' : 'results'} cleared` : 'measure off';
  tell(on ? `Measure: ${tapWord()} two points (they snap to line ends, middles and circle centres${tapWord() === 'click' ? '; Esc to stop' : ''})` : off, 3000, on ? 'measure on' : off); // (as 3D's: R129-5)
}

// out of 2D mode (a 3D model opened, or a new DXF replacing this one)
function leave2D() {
  if (!app.dxf) return;
  app.dxf.view.destroy();
  app.dxf = null;
  app.measure?.sync2D(null); // (its bar goes with it)
  document.body.classList.remove('mode2d');
  $('view2d').hidden = true;
  $('sheet').hidden = true;
  clearHover();
  for (const [id] of TITLES_2D) { const b = $(id); if (b && b.dataset.title3d !== undefined) b.title = b.dataset.title3d; }
  modeWords(false);
  embedHint();
  refold();
}

// a sheet's items per layer, under each layer it answers to (r65 A3), by dxf.js isShape (R144-1)
function layerTally(d) {
  const count = new Map();
  const tally = (it) => { for (const n of dxfLib.layersOf(it)) count.set(n, (count.get(n) || 0) + 1); };
  for (const p of d.paths) if (dxfLib.isShape(p)) tally(p);
  for (const t of d.texts) tally(t);
  return count;
}

// the parts list as the drawing's layers: colour, name, line count, a box
function buildLayerList() {
  app.releaseInfo?.(); // (a list built afresh: the old panel's height is not this one's)
  app.listFresh = true; // (the drawer's first open scrolls to it: setPanel)
  const tree = $('tree');
  tree.textContent = '';
  $('treefilter').hidden = true;
  // (the sheet shown: a layout lists the layers it draws)
  const d = app.dxf.shown || app.dxf.drawing;
  const count = layerTally(d);
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
    cb.onchange = () => {
      app.dxf.view.setLayerOn(l.name, cb.checked);
      // (a layer hidden is let go, as a hidden part is: it stayed tinted and named -- R129-9)
      if (!cb.checked && app.dxf.view.selected === l.name) app.dxf.view.select(null);
    };
    cb.tabIndex = -1; // (Space on the row shows / hides: one tab stop, as the parts list)
    wrap.append(cb);
    const lab = document.createElement('span');
    lab.className = 'label';
    lab.tabIndex = tree.children.length ? -1 : 0;
    const sw = document.createElement('span');
    sw.className = 'layer-swatch';
    sw.style.background = dxfLib.onPaper(l.colour);
    lab.append(sw, l.name);
    const pick = () => app.dxf.view.select(app.dxf.view.selected === l.name ? null : l.name);
    pressFocus(row, lab);
    row.onclick = (e) => { if (!e.target.closest('.cbwrap')) pick(); };
    // (the row focused by a click takes the one tab stop, as a parts row does: a click then ↓ left
    // two -- round 13 R13-1)
    lab.onfocus = () => {
      for (const x of tree.querySelectorAll('.label[tabindex="0"]')) if (x !== lab) x.tabIndex = -1;
      lab.tabIndex = 0;
    };
    lab.setAttribute('role', 'button'); // (a named button with a pressed state, as a parts row: R13-2)
    lab.setAttribute('aria-pressed', 'false');
    // the parts list's keys: one tab stop for the list, ↑ ↓ Home End move (a roving tabindex),
    // Enter selects, Space shows / hides (each row was two tab stops, with no arrows: round 12 R12-6)
    lab.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); pick(); return; }
      if (e.key === ' ') { e.preventDefault(); cb.click(); return; }
      const labs = [...tree.querySelectorAll('.label')], i = labs.indexOf(lab);
      const j = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: labs.length - 1 }[e.key];
      if (j === undefined || !labs[j]) return;
      e.preventDefault();
      lab.tabIndex = -1; labs[j].tabIndex = 0; labs[j].focus();
    };
    const n = document.createElement('span');
    n.className = 'cnt'; // (the parts list's count style: R14-2)
    lab.title = l.name; // (R14-3)
    n.textContent = fmtInt(count.get(l.name));
    row.append(wrap, lab, n);
    li.append(row);
    tree.append(li);
  }
  syncLayerRows();
}
function syncLayerRows() {
  for (const li of $('tree').children) {
    const on = !!app.dxf && li.dataset.layer === app.dxf.view.selected;
    li.querySelector('.row').classList.toggle('sel', on);
    li.querySelector('.label')?.setAttribute('aria-pressed', String(on));
  }
}

// the info panel in 2D mode: the drawing's size, unit, layers and contents
function fillInfo2D(el) {
  // (the sheet shown: model space, or a layout)
  const d = app.dxf.shown || app.dxf.drawing, full = app.dxf.drawing;
  const row = (k, v) => { const p = document.createElement('div'); const b = document.createElement('b'); b.textContent = k; p.append(b, ` ${v}`); el.append(p); };
  row('file', `${app.dxf.name} · 2D drawing`);
  if (app.dxf.sheet >= 0) row('sheet', `${full.layouts[app.dxf.sheet].name} (a layout: its sheet, and the drawing seen through its windows)`);
  const e = d.extents;
  if (e) {
    // (Auto's unit by js/units.js, 2D Measure's words; a chosen layer's size in the row's place: R162-3)
    const l = app.dxf.view.selected, of = (it) => dxfLib.layersOf(it).includes(l);
    const lb = l ? dxfLib.itemsBox({ paths: d.paths.filter((p) => of(p) && dxfLib.isShape(p)), texts: [] }) : null;
    const [k, v] = dxfViewLib.sizeRow(lb || e, d.units);
    row(k.replace(/^size/, lb ? `size of layer ${l}` : 'size of all it draws'), v);
  }
  row('units', d.units ? `${unitWord(d.units)} ($INSUNITS ${d.insunits})` : 'not stored in the file');
  // (the layers the list shows, of the sheet shown: "layers 2" over one row -- R129-2)
  const tl = layerTally(d);
  row('layers', `${fmtInt(d.layers.filter((l) => tl.get(l.name)).length)}`);
  // (no outline or viewport frame a shape; what layers off or frozen hold said apart: dxf.js
  // openCounts -- r65 A3, r67 A5)
  const oc = dxfLib.openCounts(d, full.layers);
  row('contents', `${fmtInt(oc.shapes)} ${oc.shapes === 1 ? 'line or shape' : 'lines and shapes'}, ${fmtInt(oc.texts)} ${oc.texts === 1 ? 'text' : 'texts'}${oc.hidden ? ` (and ${fmtInt(oc.hidden)} on layers off or frozen)` : ''}`);
  // what the drawing holds that is not drawn here, by kind (it was left out without a word)
  const nd = Object.entries(full.notDrawn || {});
  if (nd.length) row('not drawn', nd.map(([k, n]) => `${fmtInt(n)} ${k}`).join(', '));
  // (a DWG whose format checks failed: what is drawn may be wrong, said as dwg-check says it)
  if (full.checkFailures && full.checkFailures.length) row('checks failed', full.checkFailures.join('; '));
  // (model space is drawn; a layout's sheet, title block and viewport frames
  // are paper space, left out)
  if (app.dxf.sheet < 0 && full.paperSpace) {
    row('layouts', `${fmtInt(full.paperSpace)} ${full.paperSpace === 1 ? 'line or shape' : 'lines and shapes'} on the layouts, not shown here${dxfLib.sheetsOf(full).length ? ` (${$('fhsheet').hidden ? 'the' : 'File >'} sheet menu, now "Model", shows a layout)` : ''}`); // (R159-5, R160-7) // (folded into File on a phone: R129-8) // (named as it reads on screen; where it stands -- the row, or File on a phone -- moves: round 9 R9-7)
  }
  if (app.dxf.view.selected) {
    const l = app.dxf.view.selected;
    // (its texts and a frozen reference's items too, as its row counts them; no viewport frame: r66, r67)
    const of = (it) => dxfLib.layersOf(it).includes(l);
    const np = d.paths.filter((p) => of(p) && dxfLib.isShape(p)).length, nt = d.texts.filter(of).length;
    row('selection', `layer ${l}: ${fmtInt(np)} ${np === 1 ? 'line or shape' : 'lines and shapes'}${nt ? `, ${fmtInt(nt)} ${nt === 1 ? 'text' : 'texts'}` : ''}`);
  } else row('selection', `none: ${tapWord()} a line or a layer`); // (a row either way: round 14 R14-1)
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

// The multi-core converter where the device can take it (js/converter-choice.js), else, or on a
// failure, the single-threaded one; a multi-core build that failed to load remembered (r23)
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

// A mesh or 2D file read off the page's thread (js/read-worker.js): past READ_LIMIT_S (?readlimit= in
// tests) the worker is ended and the file refused; Cancel ends it. -> its answer, or null (no worker)
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
    // (a copy that does not fit: said, the worker, timer and cancel let go -- r48 A4)
    try { w.postMessage(msg); } catch (e) { done(reject, new Error(`${name} could not be read: no room for its copy (${e?.message || e})`)); }
  });
}

function tessellate(buf, format, seq, name, threads) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./step-worker.js', import.meta.url));
    const t0 = performance.now();
    const bytes = buf.byteLength; // read now: posting buf to the worker detaches it (length 0)
    const size = sizeText(bytes); // (R144-4)
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
    let detailH = 0;
    const show = () => {
      if (stale(seq)) return;
      const now = performance.now();
      const clock = fmt((now - t0) / 1000);
      let frac = null, detail = `${stage} · ${clock}`, almost = false;
      if (!conv && tStart && forecastTotal(fc) > 3) {
        // the stock converter reports nothing: the forecast alone, never shown as done
        const run = (now - tStart) / 1000, tot = forecastTotal(fc);
        barMax = Math.max(barMax, Math.min(0.95, run / tot));
        frac = barMax;
        detail = `${run < tot ? `~${fmt(tot - run)} left (estimate)` : 'taking longer than expected'} · ${clock} so far`;
      } else if (conv) {
        // Time left for the whole conversion: the steps to come by this device's speed, plus the
        // current step's own pace; a step outlasting both said, not counted down wrongly
        const factor = deviceFactor(fc, readSecs);
        const st = step;
        const inStep = (now - stepAt) / 1000;
        const f = conv.fraction;
        const quiet = (now - conv.moved) / 1000;
        // once a step has said "longer than expected" it keeps saying so, the steps after too (R133-4)
        const left = overStep >= 0 && st >= overStep ? { over: true } : timeLeft(fc, factor, st, f, inStep, quiet);
        if (typeof left !== 'number') overStep = st;
        // the bar: the forecast's share of the conversion done, never moving back
        const total = forecastTotal(fc) * factor;
        const doneSecs = forecastDone(fc, factor, st, f, inStep);
        barMax = Math.max(barMax, Math.min(0.97, total > 0 ? doneSecs / total : 0));
        frac = barMax;
        // (no "longer than expected" in the first 3 s, and no step % beside "almost done": R73-3)
        const early = now - t0 < 3000;
        const leftText = typeof left !== 'number' ? (early ? '' : 'taking longer than expected')
          : left < 1 ? 'almost done' : `~${fmt(left)} left (estimate)`;
        almost = leftText === 'almost done';
        const pct = (st === 1 || st === 2) && Math.round(f * 100) >= 1 && f < 1 && !almost ? ` · ${Math.round(f * 100)}%` : ''; // (no "· 0%" under a bar at 58 %: R133-11, R134-6)
        detail = `step ${st + 1} of ${STEPS.length}: ${STEPS[st]}${pct}${leftText ? ` · ${leftText}` : ''} · ${clock} so far`;
      }
      setStatus('tessellating', conv
        ? `${STEPS[step]}${(step === 1 || step === 2) && Math.round(conv.fraction * 100) >= 1 && conv.fraction < 1 && !almost ? ` · ${Math.round(conv.fraction * 100)}%` : ''}${almost ? ' · almost done' : ''} · ${clock}` // (as the card: R80-5, R128-6)
        : `${stage} · ${clock}`);
      showProgress(`Converting ${name} (${size})`, frac, detail, bytes > 2e6 ? TESS_HINT : '');
      // (the detail line only grows while it converts: Cancel moved 9 px as it rewrapped -- R133-4)
      const pd = globalThis.document?.getElementById('pdetail'); // ("?.": test-scene runs this with no page)
      if (pd) { pd.style.minHeight = ''; detailH = Math.max(detailH, pd.offsetHeight); pd.style.minHeight = `max(${detailH}px, 2.8em)`; } // (two lines from the first tick: R134-7)
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
    let heard = false;
    w.onmessage = (ev) => {
      const m = ev.data;
      heard = true;
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
      else done(reject, new Error(crashText(m.message).replace('could not read this file', `could not read ${name}`))); // (named: R142-3)
    };
    // (a worker that never spoke was never downloaded: said as the converter's own download is, not
    // as a crash -- R169-7)
    w.onerror = (e) => done(reject, new Error(heard ? crashText(e.message || 'the worker stopped')
      : 'converter unavailable: it could not be downloaded (offline, or the connection dropped). Reconnect and open the file again'));
    show();
    // the multi-core try is sent a copy (the bytes kept for a one-thread retry); a copy that does not
    // fit fails this try, its worker and timer ended (r49 A1)
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

// A fetch that threw: a no-cors HEAD tells no CORS / no file from down or unreachable; lead starts it
async function fetchFailedText(url, name, e, lead = `could not download ${name}`.trim()) {
  let host = null;
  try {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin) host = u.host;
  } catch { return `${lead}: “${url}” is not a web address: give the file's full URL`; } // (R167-13)
  // (offline, said so: it read "the server did not answer (Failed to fetch)" -- R167-7)
  if (navigator.onLine === false) return `${lead}: this device is offline -- open a file from this device, or try again when online`;
  if (!host) return `${lead}: this site did not answer -- check the connection, then try again`;
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
  if (!app.startingAdd) { app.autoTourFor = null; app.listHideFor = null; app.viewLinkedFor = null; app.openCount = (app.openCount || 0) + 1; }
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
  // a host's share page fetched as the file it shares (js/open-url.js fileUrl)
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
    // the whole URL tried, not only the name (a relative ?src= against the page, a list's files
    // against the list, which the error then names)
    const tried = res.url || new URL(url, location.href).href;
    // (one test of "relative", js/model-list.js isRelative: a //host address is not -- r53 A7; one the
    // list names was read from the list, and came here absolute)
    const relative = isRelative(url) && new URLSearchParams(location.search).has('list');
    // (a list that could not be read named nothing: said so, not "does not name" -- r54 Q10)
    const unread = !app.listEntries?.length && app.listNote;
    // (one list of several that failed may be the one naming it: said so -- r56 A7, Q10)
    const hint = !relative ? '' : unread
      // ("gave no models": a list read and empty too -- "could not be read" said that of it: r55 Q10)
      ? ` (the model list gave no models -- ${app.listNote} -- so a relative address is read from this page's address: give the full URL)`
      : app.listNote
        ? ` (no model list that was read names it, so it is read from this page's address -- ${app.listNote}: give the full URL)`
        : ' (a relative address the model list does not name is read from this page\'s address: give the full URL)';
    throw new Error((res.status === 404 ? `file not found (404): ${tried}`
      : `could not download ${tried}: the server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`) + hint);
  }
  // content-length is the size ON THE WIRE: with a content-encoding (gzip,
  // br) it is the compressed size and the decoded bytes overshoot it, so a
  // percentage is shown only for an unencoded body.
  const total = Number(res.headers.get('content-length')) || 0;
  // (a percent while js/import-progress.js percentKnown holds, chunk by chunk: r85 Q4)
  const encoded = !!res.headers.get('content-encoding');
  let buf;
  if (res.body) {
    const chunks = [];
    let got = 0;
    const rd = res.body.getReader();
    let frac = null;
    for (;;) {
      let step, quiet, stop;
      // (nothing coming: said after 5 s, given up after a list's wait -- it sat frozen: R167-6)
      const t0 = performance.now(), STALLED = {};
      try {
        quiet = setInterval(() => {
          const s = Math.floor((performance.now() - t0) / 1000);
          if (s >= 5 && !stale(seq)) showProgress(`Downloading ${name}`, frac, `nothing has come for ${s} s: the connection may have stopped -- wait, or Cancel`);
        }, 1000);
        step = await Promise.race([rd.read(), new Promise((_, no) => { stop = setTimeout(() => no(STALLED), READ_TIMEOUT_MS); })]);
      } catch (e) {
        if (stale(seq)) return; // aborted mid-body
        if (e === STALLED) { rd.cancel().catch(() => {}); throw new Error(`the download of ${name} stopped: nothing came for ${READ_TIMEOUT_MS / 1000} s -- check the connection, then reload the page to try again`); } // (R168-5)
        throw e;
      } finally { clearInterval(quiet); clearTimeout(stop); }
      const { done, value } = step;
      if (done) break;
      if (stale(seq)) { rd.cancel(); return; }
      chunks.push(value);
      got += value.length;
      const pct = percentKnown(got, total, encoded);
      if (got > MAX_FILE_BYTES) {
        rd.cancel();
        throw new Error(oversizeText(name));
      }
      // through setStatus (a recovery mid-fetch sees a load); come and percent rounded down, KB under
      // a megabyte (r73 A6, r74 A10, r75 Q7, R145-5)
      const kb = (pct ? total : got) < 2 ** 20;
      // (all of it come reads as its total, rounded up as that is: "0 KB of 1 KB" for 375 bytes -- R146-3)
      const allIn = pct && got >= total;
      const soFar = kb ? (allIn ? `${Math.max(1, Math.ceil(got / 1024))}` : `${Math.floor(got / 1024).toLocaleString('en')}`) : allIn ? mb(got) : mbSoFar(got), unit = kb ? 'KB' : 'MB';
      const all = pct ? (kb ? sizeText(total) : `${mb(total)} MB`) : '';
      setStatus('loading', pct ? `fetching ${Math.min(100, Math.floor((100 * got) / total))}% of ${all}` : `fetching ${soFar} ${unit}`);
      const secs = (performance.now() - tf) / 1000;
      const rate = secs > 0.5 ? ` · ${rateText(got / secs, pct ? total - got : null)}` : '';
      frac = pct ? Math.min(1, got / total) : null;
      showProgress(`Downloading ${name}`, frac,
        pct ? `${soFar}${kb ? ' KB' : ''} of ${all}${rate}` : `${soFar} ${unit}${rate}`);
    }
    const all = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    buf = all.buffer;
  } else {
    buf = await res.arrayBuffer();
  }
  app.fetchMs = Math.round(performance.now() - tf);
  const page = buf.byteLength ? webPage(buf) : null; // (a sign-in or error page at the address: R167-5)
  if (page) throw new Error(`the address gave a web page${page.title ? ` (“${page.title}”)` : ''}, not the model file: use the file's direct download link, or download it and open it here`);
  return loadAny(buf, name, seq);
}

// The file a drop carries, or null with the reason said (a link, text, a folder); of several, the
// first. One function for the startup drop and the wired one (r23)
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

// Of several files together, the model (the first non-companion) and its companions kept with it
const companionsOf = new WeakMap();
function pickModelFile(files) {
  // (the model by formats.js zipModel: a format it opens, then a zip, else the first non-companion,
  // refused in its own words -- r80 A3, r81 A3)
  const chosen = zipModel(files.map((x) => x.name)).model;
  const f = files.find((x) => x.name === chosen) || files.find((x) => formatOfName(x.name)) || files.find((x) => !isCompanion(x.name)) || files[0];
  const extras = files.filter((x) => x !== f && isCompanion(x.name));
  companionsOf.set(f, extras);
  // (the others the viewer would open, not every file: "1 more" of a .pdf -- r81 A10)
  const rest = files.filter((x) => x !== f && !extras.includes(x) && formatOfName(x.name)).length;
  // (shown as well as said: only a screen reader heard it -- R142-1)
  if (rest > 0) tell((carriedNote = `opening ${f.name}; the viewer opens one model at a time (${rest} more not opened)`), 6000);
  return f;
}

// A file over the size refused before anything starts, for Open…, a drop and Add model… alike (r50 A1)
function refusedForSize(f) {
  if (f.size <= MAX_FILE_BYTES) return false;
  failApart(oversizeText(f.name));
  return true;
}
// (the words once, for a file refused and a download cut at the size: r51 A9, Q8)
const oversizeText = (name) => `${name} is ${OVERSIZE_WORDS}`; // (the list check's words too: js/cadmesh.js, r72 A8)

// A file from the device (Open…, a drop): one too big refused before anything starts (r21); on an
// embed's poster it is the visitor's ask, and the poster goes (r52 Q6)
function openFile(f) {
  if (refusedForSize(f)) return;
  // (and the address's tour is over: View in 3D, which plays it, will not run -- r55 A3, Q2)
  if (posterUp()) { $('poster').hidden = true; setEmbedActive(true); tourOver(); }
  if (!app.addressUrl) app.visitorFirst = true; // (before any of the address's was shown: addressModel)
  startLoad(() => loadFile(f));
}

// (every caller refuses a file over the size first: refusedForSize, r51 A9)
// extras: the companions picked with it (pickModelFile), carried down to its reader
async function loadFile(file, extras = companionsOf.get(file) || []) {
  const seq = beginLoad();
  app.fetchMs = null;
  setStatus('loading', `reading ${file.name}`);
  showProgress(`Opening ${file.name}`, null, `reading ${sizeText(file.size)} from disk`); // (KB under a MB: R143-9)
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
    // no GPU: a plain reason on the card, the backends' errors in the help box's graphics line (R22-5, R22-6)
    if (app.noGpu) {
      $('backend').textContent = 'no 3D';
      $('gfxnote').textContent = app.error;
      setStatus('error', 'This browser could not start its 3D graphics: turn on hardware acceleration, or try another browser');
      return;
    }
    setStatus('error', app.error);
  });
}

// Start a load and report its failure only if it is still the newest load.
// fn() calls beginLoad() synchronously, so app.loadSeq here is that load's.
function startLoad(fn) {
  // with no GPU left there is nothing to load onto: refuse before a fetch or a
  // long tessellation, and keep the give-up message on the status line
  if (gaveUp) { setStatus('error', gaveUpWords); announce(`not loaded: ${gaveUpWords}`); return Promise.resolve(); }
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
  app.meshLabel = shownLabels(app.header);
}

// Each body's label as the list shows its owner: the model list's labels for its parts ("HDMI_1_3" ->
// "HDMI"), and repeated sibling names numbered ("COMPOUND #2": the hover and a note said "COMPOUND"
// of the list's second -- R35-1)
function shownLabels(header) {
  const labels = header.meshes.map((m) => m.name);
  const pl = (s, i) => (app.partLabels && i < firstModelBodies() ? partLabel(s) : s);
  const walk = (n, nm) => {
    for (const i of n.meshes) { const mn = pl(header.meshes[i].name, i); labels[i] = nm && nm !== mn ? `${nm} › ${mn}` : mn; }
    const kids = numberRepeats(n.children.map((c) => (c.name ? pl(c.name, c.meshes[0] ?? 0) : '')));
    n.children.forEach((c, k) => walk(c, (c.name && kids[k]) || nm));
  };
  if (header.root) walk(header.root, header.root.name ? pl(header.root.name, 0) : '');
  return labels;
}

const meshLabel = (id) => app.meshLabel[id - 1];

// A name as the model list labels it, else as is; matched as js/tour.js partIndex matches
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
  // (every model opened builds its list -- Back, a drop, a list pick, a scene -- and a hold kept
  // from the model before stuck the panel at its height: round 16 R16-3)
  app.releaseInfo?.();
  app.listFresh = true;
  labelMeshes();
  const root = $('tree');
  root.textContent = '';
  app.rowOf = new Map(); // body id -> the most specific row holding only it (picks reveal it)
  app.rowNames = new Map(); // a row's name as shown, lower case -> its bodies
  app.rowPaths = new Map(); // "owner › row" as a label reads, pathKey -> its bodies
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
  const mk = (node, depth, name, up = '') => {
    const ids = idsOf(node);
    if (!ids.length) return null;
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';
    row.style.paddingLeft = `${depth * 12 + 4}px`;
    const items = node.meshes.length === 1 && !node.children.length ? [] : kidsOf(node);
    const names = numberRepeats(items.map((c) => nodeName(c, idsOf(c))));
    const kids = items.map((c, j) => mk(c, depth + 1, names[j], name)).filter(Boolean);
    // the deepest wins; and the body is labelled by it and the row above, as the list names them
    // ("bolt #2", "COMPOUND #2 › mesh 12": the hover, selection, holes and links said "bolt" -- R36-1)
    if (ids.length === 1 && !app.rowOf.has(ids[0])) { app.rowOf.set(ids[0], li); app.meshLabel[ids[0] - 1] = up && up !== name ? `${up} › ${name}` : name; }
    // (the names the list shows, each with every row so named -- R36-5, R37-1)
    const put = (m, key) => { let s = m.get(key); if (!s) m.set(key, (s = new Set())); for (const id of ids) s.add(id); };
    put(app.rowNames, name.trim().toLowerCase());
    if (up) put(app.rowPaths, pathKey(`${up} › ${name}`));
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
    cnt.textContent = ids.length > 1 ? fmtInt(ids.length) : ''; // (as the panel's counts: "1790" beside "1,461" -- R139-6)
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
      const mark = (open) => {
        ul.hidden = !open;
        tw.textContent = open ? '▾' : '▸';
        tw.setAttribute('aria-expanded', String(open));
        tw.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${label.textContent}`);
      };
      // (a row closed stays put: R54-3)
      const setOpen = (open) => {
        if (!open && !ul.hidden && row.isConnected) keepRowPlace(row, () => mark(false));
        else mark(open);
      };
      // the top two levels start open -- but not a node whose rows are only its
      // own bodies (19 "COMPONENTn" rows would push every other part away);
      // a pick inside it opens it (revealRow)
      setOpen(depth < 2 && node.children.length > 0);
      tw.onclick = () => { label._byFilter = false; setOpen(ul.hidden); keepTabStop(); }; // (the visitor's: kept after a filter)
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
        sayIfUnseen(ids, label.textContent);
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
      rememberVisibility(cb.checked ? 'Show' : 'Hide');
      for (const id of ids) (cb.checked ? app.hidden.delete(id) : app.hidden.add(id));
      syncTreeChecks();
      pushState();
      viewChanged();
      announce(`${fmtInt(ids.length)} ${cb.checked ? 'shown' : 'hidden'}`); // (as H says it: R139-7)
    };
    // (R58-1)
    const ctl = (e) => e.target.closest('.tw[role=button], .cbwrap');
    pressFocus(row, label);
    row.onclick = (e) => { if (!ctl(e)) { select(ids, e.shiftKey || e.ctrlKey || e.metaKey, label.textContent); sayIfUnseen(ids, label.textContent); } };
    row.ondblclick = (e) => { if (!ctl(e)) fitParts(ids); };
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
  $('treenone').hidden = true;
}

// Show only the rows whose name contains q (case-insensitive), with their
// ancestors (expanded) and, under a matching row, all of its descendants.
function filterTree(q) {
  q = q.trim().toLowerCase();
  // (the matches from their first: after a pick the list stayed scrolled to its end, #94-#108 of 108 -- R151-3)
  if (globalThis.document && $('tree')) $('tree').scrollTop = 0;
  const walk = (li, force) => {
    const lab = li.querySelector(':scope > .row > .label');
    const hit = force || !q || lab.textContent.toLowerCase().includes(q);
    const ul = li.querySelector(':scope > ul');
    let any = false;
    if (ul) for (const c of ul.children) any = walk(c, hit && !!q) || any;
    li.hidden = !(hit || any);
    // (a branch the filter opened is closed again when it is cleared, one the visitor opened kept:
    // 3 rows became 22 -- R119-6)
    if (q && any && lab._setOpen && ul.hidden) { lab._byFilter = true; lab._setOpen(true); }
    if (!q && lab._byFilter) { lab._byFilter = false; lab._setOpen(false); }
    return hit || any;
  };
  const top = $('tree').firstElementChild;
  const found = top ? walk(top, false) : true;
  // (no match said, not an empty list: R119-2)
  $('treenone').hidden = !q || found;
  const none = q && !found ? `No part's name contains “${q}”` : '';
  $('treenone').textContent = none;
  // (said once typing pauses, and only when it changed: a live line said it at every key -- R157-3)
  clearTimeout(filterTree.t);
  if (!none) filterTree.said = '';
  else if (none !== filterTree.said) filterTree.t = setTimeout(() => { if ($('treenone').textContent === none) { filterTree.said = none; announce(none); } }, 700);
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

// Every row from one truth: checked while any body under it shows (half: some), lit while all are selected
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
  rememberVisibility(show ? 'Show sheets' : 'Hide sheets');
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
  syncHoles();
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

// The section's range: the model's box, the drawn one while exploded, or for a tour step's cut the
// scene's first model's, the tour's own (r127 M1)
let secBoxKey = null, secBox = null;
function sectionBox() {
  const x = app.explode;
  const first = app.section.of === 'first' && app.scene && app.scene.length > 1 && app.scene[0].base.header.bbox ? app.scene[0] : null;
  const exploded = x.on && x.t && x.for === app.header;
  if (!exploded) return first ? first.base.header.bbox : app.header.bbox;
  const key = `${x.mode}:${x.t}:${first ? 'first' : 'all'}`;
  if (secBoxKey !== key || secBox?.h !== app.header) {
    const ids = first ? Array.from({ length: first.base.header.meshes.length }, (_, j) => j + 1) : null;
    secBox = { ...drawnBox(ids), h: app.header };
    secBoxKey = key;
  }
  return secBox;
}

// A cut's position along its axis -> its fraction of the box `of` names (null: the scene's, the
// view's own), for a tour step to keep (captureStep) or a view to keep (currentView)
function sectionTOf(of, clamp = true) {
  const s = app.section;
  if (s.axis === 'off' || !app.header || (s.of || null) === of) return s.t;
  const k = { x: 0, y: 1, z: 2 }[s.axis];
  const a = sectionBox();
  const pos = a.min[k] + (a.max[k] - a.min[k]) * s.t;
  const was = s.of;
  s.of = of;
  const b = sectionBox();
  s.of = was;
  const t = b.max[k] > b.min[k] ? (pos - b.min[k]) / (b.max[k] - b.min[k]) : 0.5;
  return clamp ? Math.min(1, Math.max(0, t)) : t;
}

app.sectionBox = () => sectionBox(); // (for tests: the section's range)
app.sectionPlane = () => sectionPlane(); // (for tests: the plane drawn)
app.currentView = () => currentView(); // (for tests: the view a link or a tour's start keeps)

// name: the tree node's name when a tree row was chosen on its own, so the
// info panel can show it in full (the row truncates it); any other selection
// change forgets it.
function select(ids, additive, name = null) {
  const before = app.selected.size;
  // (a recolour's "it shows once deselected" gone with the selection it spoke of: R149-9)
  // (and a part's "inside or behind" note with the choice it spoke of: R160-1)
  if (globalThis.document && /shows once deselected$| behind other parts: Isolate/.test($('hover').textContent)) tell($('hover').textContent, 1, '');
  if (!additive) app.selected.clear();
  for (const id of ids) app.selected.add(id);
  // an additive pick that added nothing leaves the selection, and its name, as they were
  // (one body: its full label, as a pick in the view or a link names it -- the list's "bolt #2"
  // read the same for either bracket's: R38-2)
  if (!additive) app.selName = ids.length === 1 && meshLabel(ids[0]) ? meshLabel(ids[0]) : name;
  else if (app.selected.size !== before) app.selName = null;
  pushState();
  syncTreeChecks();
  showInfo();
  // (on touch the view's label names what was picked: a row picked after a tap left the tapped
  // part's name up -- R139-2)
  if (app.pointerType === 'touch' && lastLabel) hoverLabel(app.selected.size === 1 ? meshLabel([...app.selected][0]) : app.selName || '', true); // ("all 4": its name, R140-9)
}

// The display unit in force, and a length (model units) in it.
// ('mm': a mesh file's .cadmesh saved before the mesh readers wrote MM)
const geomMm = () => geomIsMm(app.header);
// (the model's largest extent, in mm, for Auto's choice: units.js autoUnit)
const modelSizeMm = () => {
  const b = app.header && app.header.bbox;
  return b ? Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : Infinity;
};
const curUnit = () => displayUnit(app.unitChoice, app.header?.sourceUnits, modelSizeMm());
// (geometry not converted: Auto's unit where the header's is a display row, else the header's own;
// the word by units.js unconvertedWord -- r88 A8, r89 Q1, r92 A3)
const lenUnit = () => (geomMm() ? curUnit() : unconvertedWord(app.header.units, modelSizeMm()));
// (and a noise floor at float32's resolution, a ten-millionth of the model's reach from the origin,
// converted too -- r90 A5, r91 Q5, r92 A4)
const LEN_NOISE = 1e-7;
const lenNoise = () => {
  const b = app.header && app.header.bbox;
  const reach = b ? Math.max(modelSizeMm(), ...b.min.map(Math.abs), ...b.max.map(Math.abs)) : 0;
  return Number.isFinite(reach) ? reach * LEN_NOISE : 0;
};
const lenNum = (v, kind) => {
  const noise = lenNoise();
  return geomMm() ? fmtNum(Math.abs(v) < noise ? 0 : v, kind, curUnit()) : unconvertedNum(v, kind, app.header.units, modelSizeMm(), noise); // (r87 Q3, r88 A3)
};
// a length typed in lenUnit, back in model units (the section field)
const lenBack = (v) => (geomMm() ? v * MM_PER[curUnit()] : unconvertedBack(v, app.header.units, modelSizeMm()));

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
  $('unitsrc').textContent = !geomMm() ? `${headerUnitWord(app.header.units)} (not converted)`
    : declared ? (UNIT_WORDS[declared] || unitWord(declared)) : 'not recorded';
  const sel = $('unitsel');
  sel.disabled = !geomMm();
  // (geometry not converted: the unit its lengths are shown in, lenUnit's, and no choice -- the row
  // said "Auto (mm)" of an inch model shown in inches, "[in]" of one shown in mm: r90 A1)
  sel.options[0].text = `Auto (${geomMm() ? autoUnit(declared, modelSizeMm()) : lenUnit()})`;
  sel.value = geomMm() ? app.unitChoice : sel.options[0].value;
  // a mesh file that stores no unit: which unit it is in, chosen here
  const unit = syncMeshUnitRow();
  if (unit) {
    $('unitsrc').textContent = 'not stored in the file';
    // (its title says the reading it is: it said "read as mm" whatever was chosen)
    $('meshunit').title = `This mesh file stores no unit: it is read as ${unitWord(unit)}. Pick the unit it was made in and it is read again at that size`;
  }
}
// The "this file is in" row for a unit-less mesh, its select the unit read in (or being read): its one
// writer, at every showInfo and an unlanded re-read (r66-r69). -> the unit written, or null
function syncMeshUnitRow() {
  const src = app.meshSource;
  $('meshunitrow').hidden = !src;
  if (!src) return null;
  const unit = rereading() ? app.rereadUnit : src.unit;
  $('meshunit').value = unit;
  return unit;
}

function setUnitChoice(u) {
  app.unitChoice = DISPLAY_UNITS.includes(u) ? u : 'auto';
  setPref('cadv.units', app.unitChoice === 'auto' ? null : app.unitChoice);
  showInfo();
  updateButtons(); // the section readout
  app.measure?.relabel(); // (and Measure's results: r91 Q1)
  // (and the clearance line and the 3D view's spoken size: r92 A2)
  if (app.lastClearance) sayClearance(app.lastClearance);
  showModelName();
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

// "measured from": the model's corner or Measure from selection's parts (its buttons never rebuilt);
// mass: the selection's closed bodies × density (g/cm³: the material's, or a typed one, else null)
function density() {
  if ($('material').value !== 'custom') return Number($('material').value);
  const d = Number($('density').value);
  return Number.isFinite(d) && d >= 0.01 && d <= 25 ? d : null; // (the field's own range: 0.005 weighed -- R121-4)
}

function syncMassRow() {
  const f = app.factsNow;
  // (shown with or without a selection, so the panel keeps its rows as one is made -- round 14 R14-1)
  const show = !!app.header && !!f;
  $('infomass').hidden = !show;
  $('densitybox').hidden = $('material').value !== 'custom';
  if (!show) return;
  // (short, one line as a mass is: the longer words wrapped to two, and the list moved 17 px as the
  // first part was picked -- round 14 R14-1; the reason in its tooltip)
  if (!app.selected.size) {
    $('massval').textContent = 'select parts'; // (one piece: "parts" wrapped alone at 320 px -- R16-6)
    $('massval').title = 'A whole model is rarely one material: select the parts made of it';
    return;
  }
  $('massval').title = '';
  const d = density();
  // (a volume in mm³ weighed: another unit said first, whatever else is missing -- weighed 16,387x off
  // before: r84 A5)
  if (!geomMm()) { $('massval').textContent = notMmWords(app.header, 'a mass is'); return; }
  if (!f.closed) { $('massval').textContent = 'none closed: no volume'; return; }
  // (a value out of range said as such, not as an empty field: R120-6)
  if (d === null) { $('massval').textContent = Number($('density').value) ? 'a density from 0.01 to 25 g/cm³' : 'type a density (g/cm³, water is 1)'; return; }
  const g = (f.vol / 1000) * d;
  $('massval').textContent = `${fmtMass(g, lenUnit())}${f.closed < f.of ? ` (the ${fmtInt(f.closed)} closed of ${fmtInt(f.of)})` : ''}`;
}

const REFSET_TITLE = document.getElementById('refset')?.title || '';
function syncRefRow() {
  $('inforef').hidden = !app.header;
  if (!app.header) return;
  // (R39-2)
  // (its × on the name's last line, as "all N" -- R40-3, R41-3; its focus read before it moves: R42-2)
  const hadX = document.activeElement === $('refclear');
  $('refname').replaceChildren(...nameWithButton(!app.ref ? 'the whole model' : isSel(app.ref.ids) ? 'the selection' : app.ref.name, $('refclear')));
  // (off while the selection is the reference, its focus to the ×: R114-1)
  const hadSet = document.activeElement === $('refset'), same = !!app.ref && isSel(app.ref.ids);
  $('refset').disabled = !app.selected.size || same;
  // (a button about to hide hands the focus on, as the toolbar's do)
  if (hadX && !app.ref) $('refset').focus();
  $('refclear').hidden = !app.ref;
  $('refline').hidden = !app.ref; // (the whole model: the selection row already says it)
  // (after its line is shown: focused while hidden, the focus fell to List holes -- R115-1)
  if (hadSet && same) $('refclear').focus();
  // (the title says why it is off: R115-3)
  $('refset').title = same ? 'Positions are already measured from the selection (× measures from the whole model again)' : REFSET_TITLE;
  syncHoles();
  // an open hole table follows the reference and the display unit
  if (app.holesFor && app.measure) showHoles(app.holesFor);
}

// List holes' state and an open "parts shown" table after a selection or visibility change (R25-3..5)
const shownIds = () => app.header.meshes.map((_, i) => i + 1).filter((id) => !app.hidden.has(id));
function syncHoles() {
  if (!app.header) return;
  const faces = !!(app.baseMesh && app.baseMesh.faces), shown = shownIds();
  $('holesbtn').disabled = !faces || (!app.selected.size && !shown.length);
  $('holesbtn').title = faces
    ? 'List the holes of the selected parts, or of every part shown: diameter, position from the corner of the whole model (or of the parts chosen with Measure from selection), and how far apart they lie'
    : 'Holes need a CAD file\'s faces: a STEP, IGES or BREP file, or a .cadmesh saved with them';
  if (app.holesFor?.shown && app.measure) {
    if (!shown.length) { showHoles(null); return; }
    if (shown.length !== app.holesFor.ids.length || shown.some((id, i) => id !== app.holesFor.ids[i])) showHoles({ ...app.holesFor, ids: shown });
  }
}

// The hole table of the parts `f.ids` ({ ids, name }), positions from the reference
// these bodies are the selection, exactly
const isSel = (ids) => ids.length === app.selected.size && ids.every((id) => app.selected.has(id));
function showHoles(f) {
  app.holesFor = f;
  if (!f) { app.measure.showHoles(null); return; }
  const ref = { ...(app.ref ? bboxOf(app.ref.ids) : app.header.bbox), name: app.ref ? (isSel(app.ref.ids) ? 'the selection' : nameWords(app.ref.name)) : 'the whole model' };
  app.measure.showHoles(f.ids, ref, !f.shown && isSel(f.ids) ? 'the selection' : nameWords(f.name));
}

function setRef(on) {
  if (on && app.selected.size) {
    const ids = [...app.selected];
    app.ref = { ids, name: app.selName || (ids.length === 1 ? meshLabel(ids[0]) : `${ids.length} bodies`) };
  } else app.ref = null;
  showInfo();
  updateButtons(); // (the Section readout in the new corner's frame, as the panel: R113-1)
  announce(app.ref ? `positions measured from ${app.ref.name}` : 'positions measured from the whole model');
}

// a name as shown: " #2" kept with it (R39-1; its "-" left breakable, a copy pasting as typed: R40-2)
const nameWords = (s) => String(s).replace(/ #(\d)/g, ' #$1');
// (a copy of text alone pastes plain spaces, R40-2; over controls, the browser's own, R41-2)
document.addEventListener('copy', (e) => {
  const sel = getSelection(), s = String(sel);
  if (!s.includes(' ') || !e.clipboardData || !sel.rangeCount) return;
  const c = sel.getRangeAt(0).cloneContents();
  if (c.querySelector('select, input, textarea, a, table, details')) return;
  e.clipboardData.setData('text/plain', s.replace(/ /g, ' '));
  e.preventDefault();
});
// a name and its button on one line, with its last word (R39-1, R40-1, R41-1)
function nameWithButton(text, btn) {
  const t = nameWords(text);
  let cut = t.lastIndexOf(' ') + 1;
  const word = t.slice(cut), num = (/ #\d+$/.exec(word) || [''])[0];
  // (moved, it keeps the focus -- unless it is gone or hidden by then: R42-2)
  if (document.activeElement === btn) queueMicrotask(() => { if (btn.isConnected && !btn.hidden) btn.focus(); });
  // (a long word: its last few letters, its " #N" and the button kept together -- "#3 all 6" began a
  // line, apart from its name: R41-4, R42-3)
  if (word.length - num.length > 16) cut = t.length - num.length - 4;
  const g = document.createElement('span');
  g.style.whiteSpace = 'nowrap';
  g.append(`${t.slice(cut)} `, btn);
  return [t.slice(0, cut), g];
}

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
      add('page', outLink(e.page, `${u.host}${u.pathname.replace(/\/$/, '')} ↗`)); // (R148-7)
    }
    // its other pages (the list's `links`), each by its name and its host:
    // a list on any site can name any page, so whose page it is always shows
    if (e && e.links && e.links.length) {
      const items = [];
      for (const k of e.links) {
        if (items.length) items.push(' · ');
        items.push(outLink(k.url, `${k.name} ↗`), ` (${new URL(k.url).host})`); // (the arrow kept with its name: R147-13)
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
  let title = app.scene?.length > 1 ? 'whole scene' : 'whole model'; // (as the parts list names it: R137-11)
  // a tree row chosen on its own: its full name (the row truncates it)
  // (a part's copies called so, as "all N" calls them: R141-11)
  const copies = ids.length > 1 && sameParts(ids[0]).length === ids.length && sameParts(ids[0]).every((id) => ids.includes(id));
  // (counts as the panel writes them, and every body by the panel's name for that set: "Scene · 1790
  // bodies" beside "whole scene" and "1,790" -- R149-2)
  const everything = ids.length > 1 && ids.length === app.header.meshes.length;
  if (everything) title = `${title} · ${fmtInt(ids.length)} bodies`;
  else if (ids.length && app.selName) title = ids.length > 1 ? `${app.selName} · ${fmtInt(ids.length)} ${copies ? 'copies' : 'bodies'}` : app.selName;
  else if (ids.length === 1) title = meshLabel(ids[0]);
  else if (ids.length > 1) title = `${fmtInt(ids.length)} bodies`;
  const tris = (ids.length ? ids.map((id) => app.header.meshes[id - 1].idxCount) : [app.header.indexCount]).reduce((a, x) => a + x, 0) / 3;
  // instance count (feature review item 24): one part selected, how many
  // copies of it the model holds (the same name, triangle count and size), on
  // the selection's own line (a line more squeezed the parts list below)
  const n = ids.length === 1 ? instancesOf(ids[0]) : 0;
  if (n > 1) {
    const sel = document.createElement('button');
    sel.className = 'mini';
    sel.textContent = `all ${fmtInt(n)}`; // ("bolt #2 [1 of 6]": two numbers for one part -- R37-3)
    sel.title = `${fmtInt(n)} copies of this part in the model: select them all`;
    sel.setAttribute('aria-label', `select all ${fmtInt(n)} copies`); // (R38-6, R150-3)
    // (from a key, the focus to Measure from selection: R42-1)
    // (the copies named, and only a key press moves the focus on: R139-8; said: R150-8)
    sel.onclick = (e) => {
      const kb = e.detail === 0, name = meshLabel(ids[0]).replace(/ #\d+$/, '');
      select(sameParts(ids[0]), false, name);
      announce(`${name}: ${fmtInt(n)} copies selected`);
      if (kb) ($('refset').disabled ? $('refclear') : $('refset')).focus();
    }; // (off: the ×, R115-4)
    add('selection', ...nameWithButton(title, sel));
  } else add('selection', nameWords(title));
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
  // (the whole model's too: a row that came with the first selection moved the parts list under the
  // pointer, so a second click or a double-click landed on the row above -- UI design round 14 R14-1)
  if (b && ref) {
    add(`position (${lenUnit()})`, rangesFrom(b, ref)
      // (no-break spaces inside an axis's range: the only break is between axes, at " · " -- it broke
      // "· Z" from "0.0 to 84.0": round 15 R15-4)
      .map(([lo, hi], k) => `${'XYZ'[k]} ${lenNum(lo, 'size')} to ${lenNum(hi, 'size')}`).join(' · '));
  }
  if (app.ref && b && ref) {
    // (how far it stands out past the reference's top and its bottom; a part
    // that does not reach past one says so, rather than a negative number
    // nobody can read -- UI review: "6.2 / -0.7")
    const ab = aboveBelow(b, ref, orientUp(app.cam.orient));
    const past = (v, side) => pastWords(v, side, (x) => lenNum(x, 'size')); // (r88 A4)
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
    let vol = 0, area = 0, closed = 0, capped = 0, sheets = 0, open = 0, empty = 0;
    for (const id of which) {
      const i = id - 1, kind = app.header.meshes[i].kind;
      area += facts.area[i] || 0;
      // (no area: neither closed nor open -- R33-1)
      if (!(facts.area[i] > 0)) { empty++; continue; }
      if (facts.closed[i]) {
        vol += facts.volume[i] || 0; closed++;
        if (kind === 'capped') capped++;
      } else if (kind === 'sheet') sheets++; else open++;
    }
    const u = lenUnit();
    const counts = [`${fmtInt(closed)} closed${capped ? ` (${fmtInt(capped)} capped)` : ''}`, sheets && `${fmtInt(sheets)} ${sheets === 1 ? 'sheet' : 'sheets'}`,
      open && `${fmtInt(open)} open`, empty && `${fmtInt(empty)} empty`].filter(Boolean).map((c) => c.replace(/ /g,' ')).join(' / '); // (each one piece, a break after " / ": R34-3, R35-5)
    // (a volume that may not be the material's said by its flags, edges.js flagsSaid; in the header's
    // unit when not converted -- r86 A4, r89 Q1)
    const hu = geomMm() ? u : headerUnitWord(app.header.units);
    const volWords = geomMm() ? fmtVolume(vol, u) : fmtUnconverted(vol, hu, 3), areaWords = geomMm() ? fmtArea(area, u) : fmtUnconverted(area, hu, 2);
    // (none closed: no number, as mass -- R31-1)
    const others = counts.replace(/^0 closed( \/ )?/, '');
    add('volume', `${closed ? `≈ ${volWords} · ${counts}` : `none closed${others ? ` · ${others}` : ''}`}${flagsSaid(facts, which.map((id) => id - 1), ' · ').replace(/(\d) /g, '$1 ')}`);
    add('area', area > 0 ? `≈ ${areaWords}` : 'none'); // (R33-3)
    addMore('volume counts', volumeCounts(which.length, closed, capped, sheets, open, empty));
    app.factsNow = { vol, closed, of: which.length }; // (R34-4)
  }
  if (app.unmeshedFaces) add('missing faces', `${fmtInt(app.unmeshedFaces)} (the converter could not mesh them)`);
  // converted in this tab just now: on how many threads (js/converter-choice.js)
  if (app.stats?.converter) addMore('converted on', app.stats.converter);
  el.append(more);
}

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

// What the volume counts, in words (Details, under the volume; R34-2)
function noSurface(ids, then) {
  const area = app.baseMesh?.edgeInfo?.value?.facts?.area;
  if (!area || !ids.length || ids.some((id) => area[id - 1] > 0)) return false;
  if (panelOpen()) setPanel(false, true); // (the focus to ☰, not the page: R35-2)
  tell(`${ids.length === 1 ? `${meshLabel(ids[0])} has` : `these ${fmtInt(ids.length)} have`} no surface: ${then}`, 4000);
  return true;
}
// Fit, F, a row's double-click (R34-1)
// (an open drawer closed, so what it does is seen: one rule with noSurface's -- R35-3, R36-2)
const uncover = () => { if (panelOpen()) setPanel(false, true); };
if (self.ResizeObserver) { // (R69-1..R71-3)
  let h = 0, open = false;
  // (the writes wait a frame, so they never resize what is being observed mid-callback: R89-4)
  let raf = 0;
  const st = $('stage'), c = $('tourcard'), te = $('touredit'), ro = new ResizeObserver(() => {
    // (the classes at once, so the triad never shows a frame under the card: R90-4)
    st.classList.toggle('tournarrow', st.clientWidth < 798); st.classList.toggle('tourtriad', c.offsetWidth + 102 > st.clientWidth);
    if (!raf) raf = requestAnimationFrame(sync);
  });
  const sync = () => {
    raf = 0;
    if (open !== !te.hidden) { open = !te.hidden; h = 0; te.scrollTop = 0; syncOptbar(); } // (a phone's maker opened: the view framed above it, R163-4)
    h = st.classList.contains('touring') ? Math.max(h, c.offsetHeight) : c.offsetHeight;
    if (st.style.getPropertyValue('--tourcard-h') !== `${h}px`) st.style.setProperty('--tourcard-h', `${h}px`);
    if (!c.hidden) markScrolls($('tourbody'));
    const f = document.activeElement; if (te.contains(f)) f.scrollIntoView({ block: 'nearest' });
  };
  ro.observe(c); ro.observe(st); ro.observe(te);
}
function fitParts(ids) {
  if (noSurface(ids, 'the whole model fitted')) { fitTo(drawnBox(null)); return; }
  uncover();
  fitTo(drawnBox(ids.length ? ids : null));
}

function volumeCounts(n, closed, capped, sheets, open, empty = 0) {
  const bodies = (k) => `${fmtInt(k)} ${k === 1 ? 'body' : 'bodies'}`;
  let s = closed === n ? (n === 1 ? 'the one body, closed' : `all ${bodies(n)}, every one closed`)
    : closed ? `the ${fmtInt(closed)} closed ${closed === 1 ? 'body' : 'bodies'}` : 'no body: none is closed';
  if (capped) s += ` (${fmtInt(capped)} of them closed by the converter's caps)`;
  const rest = [sheets && `${fmtInt(sheets)} ${sheets === 1 ? 'is a flat sheet' : 'are flat sheets'} (pads, labels)`,
    open && `${fmtInt(open)} ${open === 1 ? 'is an open surface model' : 'are open surface models'}`,
    empty && `${fmtInt(empty)} ${empty === 1 ? 'has' : 'have'} no surface (empty)`].filter(Boolean);
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

// -> the body id under (x, y), 0 for background, or null with no answer (GPU lost, the model since
// replaced, the view it aimed at gone: app.viewGen) -- null is not "nothing"
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

// A part chosen in the list that lies inside or behind others is said so, with Isolate (R159-1): by
// its own pixels in a pick over its box on screen (R160-1)
async function sayIfUnseen(ids, name) {
  const want = ids.filter((id) => !app.hidden.has(id));
  if (!want.length || app.dxf || app.section.axis !== 'off' || !app.renderer?.pickRect || !globalThis.requestAnimationFrame) return;
  const sel = new Set(app.selected), same = () => app.selected.size === sel.size && [...sel].every((id) => app.selected.has(id));
  await new Promise((r) => requestAnimationFrame(r));
  const b = drawnBox(want);
  if (!b || !same()) return;
  const m = measureView().vp, c = app.renderer.canvas;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let n = 0; n < 8; n++) {
    const p = [0, 1, 2].map((k) => (n >> k & 1 ? b.max[k] : b.min[k]));
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 1e-9) return;
    const x = ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w + 1) / 2 * c.width, y = (1 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) / 2 * c.height;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(c.width, Math.ceil(x1)); y1 = Math.min(c.height, Math.ceil(y1));
  if ((x1 - x0) * (y1 - y0) < 100) return; // (too small on screen to tell: a 1 px chip is not "inside")
  const gen = app.viewGen;
  let res = null;
  try { res = await app.renderer.pickRect(x0, y0, x1 - x0, y1 - y0, frameState); } catch (e) { console.warn('pick failed:', e); }
  if (!res || gen !== app.viewGen || !app.mesh || !sameModel(res.mesh, app.mesh) || !same()) return;
  // (seen: 2 % of its box or 400 px, the less; not a few through a grille)
  let px = 0;
  for (const [id, n] of res.counts) if (sel.has(id)) px += n;
  app.lastUnseen = { px, area: (x1 - x0) * (y1 - y0) }; // (for tests)
  if (px >= Math.min(400, 0.02 * (x1 - x0) * (y1 - y0))) return;
  tell(`${name} is ${px > 20 ? 'mostly hidden behind' : 'inside or behind'} other parts: Isolate${coarseOnly() ? '' : ' (I)'} shows it alone`, 5000); // (a lit stripe: R161-3)
}
app.sayIfUnseen = sayIfUnseen; // (for tests)

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
    announce, tell, queueFrame, syncOptbar, toolFocus,
    view2d: () => (app.dxf ? app.dxf.view : null), toggle2D: () => toggle2DMeasure(), // (R44-4)
    coarse: () => matchMedia('(pointer: coarse)').matches,
    // where hidden edges are drawn, everything drawn can be snapped
    showsHidden: () => currentStyle().seesHidden,
    // Measure, Paint and Explode exclude each other: points are where the bodies are
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
    // (an embed's press takes the keyboard into the frame, the first or any: an &active=1 frame
    // never took it, its keys going to whatever had the focus -- R146-1)
    if (app.embed) try { window.focus(); } catch { /* not focusable: the pointer still works */ }
    // (not off the note field a tap just opened -- R138-4; any other focus goes: R139-1)
    if (document.activeElement === $('measnotetext')) return;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  });
  const stageXY = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  // a finger covers what it aims at: on a touch screen, a held finger aims
  // this far above itself
  const AIM_LIFT = 48;
  // One gesture at a time, the starting pointer's: a second mouse / pen is ignored; a second finger
  // makes a pinch + pan (the orbit dropped), and the finger left after it does nothing till lifted.
  let drag = null;
  const touches = new Map(); // pointerId -> [clientX, clientY], fingers on the stage
  let pinch = null; // { ids: [a, b] } while two fingers are down
  const startPinch = () => {
    pinch = touches.size >= 2 ? { ids: [...touches.keys()].slice(0, 2) } : null;
  };
  // A lifted finger leaves the pinch on pointerup (and, a no-op, on capture loss); with two others
  // still down, those two pinch on from where they are
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
    // (R59-2, R60-2, R60-4)
    const r = stage.getBoundingClientRect();
    const out = e.pointerType === 'touch' && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
    // embedded and not yet active: no capture, no gesture; a press that
    // lifts where it went down (a click, a tap) makes it active
    if (app.embed && !app.embedActive) { if (!out) embedPress = { id: e.pointerId, x: e.clientX, y: e.clientY }; return; }
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
      if (touches.size > 1 || out) return;
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

  // Hover: one pick per 60 ms and one in flight, plus a trailing pick at the last position.
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
      // (Shift too, as the parts list: a Shift press that does not move is a click, not a pan -- R149-1)
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      app.hoverSeq++; // a click supersedes any pending hover answer
      lastClick = app.pickAt(...devicePx(e)).then((id) => {
        if (id === null) return false;
        const had = app.selected.size;
        select(id ? [id] : [], additive);
        if (id) revealRow(id);
        // (said, as a list pick is: a screen reader heard nothing of a pick in the view -- R149-10)
        // (what changed: an added click on the background keeps the selection, one on a part already in
        // it adds nothing -- R150-2)
        if (id && app.selected.size === had && additive) announce(`${meshLabel(id)} already selected: ${fmtInt(had)} selected`);
        else if (id) announce(app.selected.size > 1 ? `${meshLabel(id)} added: ${fmtInt(app.selected.size)} selected` : `${meshLabel(id)} selected`);
        else if (had && !app.selected.size) announce('selection cleared');
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
    // a tour's step, untouched, framed again for the new shape (it stayed framed for the old: R154-3)
    if (a > 0 && a !== app.stageAspect && app.tour) tourFloor(app.tour.tour);
    if (a > 0 && a !== app.stageAspect && atStepPose()) {
      app.stageAspect = a;
      restep();
      viewChanged();
      queueFrame();
      return;
    }
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
  // (a window dragged to a sharper screen fires no resize: drawn at the old sharpness until a turn --
  // R169-10; a query for the ratio now, armed again at each change)
  const sharp = () => {
    const q = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    q?.addEventListener?.('change', () => { queueFrame(); app.dxf?.view.draw(); sharp(); }, { once: true });
  };
  sharp();
  // ☰ from the keyboard moves the focus into the slide-out's parts list; Esc gives it back (review r18)
  $('panelbtn').onclick = (e) => {
    const open = !panelOpen();
    setPanel(open);
    // (no model, no tree: the slide-out's first control, else the focus stayed
    // on ☰ and its controls were past File and View: review r19)
    if (open && e.detail === 0) partsStop()?.focus();
  };
  // (focus back to ☰ if it was in the panel, r21; closed on the click, not the press, so the tap goes
  // to nothing under it: r22)
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
  // contents widen without the row resizing; checked once a frame at most, where it scrolls (R150-6)
  let hintQueued = false;
  new MutationObserver(() => {
    if (hintQueued) return;
    hintQueued = true;
    requestAnimationFrame(() => { hintQueued = false; if (getComputedStyle(tb).flexWrap === 'nowrap' || header.classList.contains('more-right')) moreHint(); });
  }).observe(tb, { attributes: true, subtree: true, childList: true, characterData: true });
  // A drop anywhere on the page loads the file: left to the browser, a drop on
  // the sidebar or header would open or download it and lose the view.
  window.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
  // dragleave also fires when the pointer moves onto a child (the cards):
  // only leaving the view itself ends the drag highlight
  stage.addEventListener('dragleave', (e) => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('drop'); });
  $('emptyopen').onclick = () => $('open').click();
  // File > Add model…: the picked file joins the scene
  $('addmodelbtn').onclick = () => {
    closeMenus();
    if (PROGRESS_STATES.has(app.status)) { tell('wait for the model that is loading, then Add model…', 4000); return; }
    if (app.listEntries?.length && !app.embed) openGallery(true); else $('addmodel').click();
  };
  $('addmodel').addEventListener('change', () => {
    const files = [...$('addmodel').files];
    $('addmodel').value = '';
    // (not while a model loads, by the button or a pick: it silently ended the download -- R133-5)
    if (PROGRESS_STATES.has(app.status)) { tell('wait for the model that is loading, then Add model…', 4000); return; }
    addPicked(files);
  });
  $('clearbtn').onclick = () => runClearance();
  $('paintbtn').onclick = () => setPaint(!app.paintFaces);
  // (on, the Display menu closed over the view and the focus to Walk's own bar: R148-9)
  $('walk').onclick = () => { setWalk(!app.walk); if (app.walk) { closeMenus(); $('walkoff')?.focus(); } };
  $('walkoff').onclick = () => { setWalk(false); $('view').focus?.(); };
  // the installed app opened with a file (manifest.webmanifest file_handlers)
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (p) => {
      if (p.files && p.files.length) openFile(pickModelFile(await Promise.all(p.files.map((h) => h.getFile()))));
    });
  }
  // offline install (sw.js): not in an embed (another site's page), and only
  // where a service worker may run
  // (a browser naming a service worker it cannot give, navigator.serviceWorker undefined, stopped the
  // page at start: R169-2)
  if (navigator.serviceWorker && !app.embed && window.isSecureContext && !params.has('nosw')) {
    // (a new version taken while the page is open: said, not silent -- its later parts would load
    // beside this page's -- R171-7. Not the first visit's own worker taking control, nor an update this
    // page's own load found: the worker fetches network first, so this page is that version -- R172-4)
    let had = !!navigator.serviceWorker.controller;
    let own = false;
    const t0 = performance.now(), mine = () => performance.now() - t0 < 5000; // (from the registration, not the page's start: a slow load)
    try {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        if (reg.installing && mine()) own = true;
        reg.addEventListener?.('updatefound', () => { if (mine()) own = true; });
      }).catch(() => { /* the viewer works without it */ });
    } catch { /* nor this */ }
    // (each change of worker judged once: this page's own update consumed, and a page that began with
    // none, or with its own, told of the next deploy -- R173-2)
    navigator.serviceWorker.addEventListener?.('controllerchange', () => {
      if (had && !own) tellReady('the viewer was updated: reload the page to use the new version', 8000);
      had = true;
      own = false;
    });
  }
  $('treefilter').addEventListener('input', (e) => filterTree(e.target.value));
  // Esc in the filter clears it (and stays in the field); a second Esc closes
  // the slide-out where there is one (the window's keydown)
  $('treefilter').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ''; filterTree(''); }
    // (↓ to the first row whose name matches, past the rows shown for context: R162-8)
    if (e.key === 'ArrowDown') {
      const q = e.target.value.trim().toLowerCase(), rows = [...$('tree').querySelectorAll('.label')].filter((l) => !l.closest('[hidden]'));
      const to = rows.find((l) => q && l.textContent.toLowerCase().includes(q)) || rows[0];
      if (to) { e.preventDefault(); to.focus(); to.scrollIntoView({ block: 'nearest' }); }
    }
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
  // (named as its key names it: R143-8)
  document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => { setView(b.dataset.view); tell(VIEW_NAMES[b.dataset.view], 1500, `${VIEW_NAMES[b.dataset.view]} view`); }; });
  $('fit').onclick = () => {
    if (app.dxf) { uncover(); return app.dxf.view.fit(); }
    fitParts([...app.selected]);
  };
  // Ortho, Z up and Flip are on/off toggles: the label names the option, the
  // pressed look (and aria-pressed, for a screen reader) says whether it is on
  $('proj').onclick = () => {
    // (a walk's eye is a few mm from the model: Ortho there ends Walk and fits -- R122-1)
    if (app.walk) { app.cam.ortho = !app.cam.ortho; fitTo(drawnBox(null)); updateButtons(); viewChanged(); return; }
    // (on a step's own fitted view, untouched -- held or paused, not turned: the step fitted again in
    // the new projection -- R92-3, R93-1, R93-2)
    const still = atStepPose();
    app.cam.ortho = !app.cam.ortho;
    if (still) restep();
    updateButtons(); viewChanged();
  };
  // Z up: the file's +z up and -y toward the viewer, or back to its own frame
  // (y up); the choice holds for the next model that names no orientation
  $('up').onclick = () => {
    app.userOrient = app.cam.orient.startsWith('+z') ? DEFAULT_ORIENT : Z_UP_ORIENT;
    app.fileOrient = null; // (the visitor's choice over the file's own, a re-read too: R157-6)
    app.cam.orient = app.userOrient;
    updateButtons();
    showInfo(); // above / below are along the new up
    setView('iso');
  };
  // (greyed by its own press, the focus to the view, not the next menu button an Enter would open: R120-5)
  // (in a folded menu, the menu's own rule hands the focus on: r19)
  $('undo').onclick = () => {
    const kb = document.activeElement === $('undo') && !$('undo').closest('.menu.folded');
    // (as Ctrl+Z, whose key its tooltip names: R136-7)
    if (app.measure?.on && (app.measure.pending.length || app.measure.results.length)) app.measure.undo(); else undoVisibility();
    setTimeout(() => { if (kb && $('undo').disabled) (app.dxf ? $('view2d') : $('view')).focus({ preventScroll: true }); }, 0);
  };
  $('isolate').onclick = () => {
    if (!app.selected.size) return;
    const next = new Set(app.header.meshes.map((_, i) => i + 1).filter((id) => !app.selected.has(id)));
    // (no Undo step for an Isolate that changes nothing: R135-6)
    if (next.size === app.hidden.size && [...next].every((id) => app.hidden.has(id))) { tell('only the selection is shown already', 2500); return; }
    rememberVisibility('Isolate');
    app.hidden = next;
    syncTreeChecks();
    pushState();
    viewChanged();
    // (a part far smaller than the model is left small at the model's framing: the note names Fit, R159-3)
    const diag = (b) => (b ? Math.hypot(...[0, 1, 2].map((k) => b.max[k] - b.min[k])) : 0);
    const small = diag(drawnBox([...app.selected])) < 0.25 * diag(drawnBox(null));
    tell(`isolated: ${fmtInt(app.selected.size)} shown${small ? ` · ${coarseOnly() ? 'Fit frames' : 'Fit (F) frames'} ${app.selected.size === 1 ? 'it' : 'them'}` : ''}`, small ? 4000 : 1500); // (said, as its Undo is: R135-5)
    if (!noSurface([...app.selected], 'nothing to show')) uncover(); // (blank, unsaid: R33-2)
  };
  $('hide').onclick = () => {
    if (!app.selected.size) return;
    rememberVisibility('Hide');
    const n = app.selected.size;
    for (const id of app.selected) app.hidden.add(id);
    app.selected.clear();
    syncTreeChecks();
    pushState();
    showInfo();
    viewChanged();
    announce(`${fmtInt(n)} hidden`);
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
  // Ctrl/Cmd+P is File > Print, one at a time; framed, the key and the print are the host page's
  // (R116-1, R117-1..7, R118-1..5)
  const framed = FRAMED;
  $('printbtn').title = keyTitle($('printbtn').title);
  if (framed) {
    for (const k of document.querySelectorAll('#helppop kbd')) if (/^(Ctrl|⌘)\+P$/.test(k.textContent)) { k.parentElement.nextElementSibling?.remove(); k.parentElement.remove(); }
    $('printbtn').removeAttribute('aria-keyshortcuts');
  } else if (IS_MAC) {
    $('printbtn').setAttribute('aria-keyshortcuts', 'Meta+P Control+P');
    // (the ? box in a Mac's keys: it kept "Ctrl+click" and Ctrl+A / Z / P -- R151-6)
    for (const k of document.querySelectorAll('#helppop kbd')) k.textContent = k.textContent.replace(/^Ctrl\+/, '⌘');
    for (const d of document.querySelectorAll('#helppop dd')) if (d.textContent.includes('Ctrl+click')) d.textContent = d.textContent.replace('Ctrl+click', '⌘-click');
  }
  let printing = false;
  const startPrint = () => {
    if (printing || $('printbtn').disabled) return;
    printing = true;
    closeMenus();
    tell('preparing the print…', 30000);
    notePainted()
      .then(() => savePicture(true))
      .finally(() => { printing = false; if ($('hover').textContent === 'preparing the print…') tell('preparing the print…', 1, ''); });
  };
  $('printbtn').onclick = startPrint;
  addEventListener('keydown', (e) => {
    const pKey = e.key.toLowerCase() === 'p' || (nonLatinLetter(e.key) && e.code === 'KeyP');
    if (framed || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !pKey || $('printbtn').disabled) return;
    e.preventDefault();
    if (!e.repeat) startPrint();
  });
  const hintNow = () => (framed ? ''
    : !app.header && !app.dxf ? (app.embed ? 'There is no model to print.' : 'Open a model to print it.')
      : app.embed ? `To print the ${app.dxf ? 'drawing' : 'model'}, ${coarseOnly() ? "use the browser's Print" : `press ${IS_MAC ? '⌘P' : 'Ctrl+P'}`}.` // (R119-4; no keys on a phone: R141-10)
        : `To print the ${app.dxf ? 'drawing' : 'model'}, use Print… in the File menu.`);
  addEventListener('beforeprint', () => { if (!$('printimg').getAttribute('src')) $('printname').textContent = hintNow(); });
  addEventListener('afterprint', () => {
    const img = $('printimg');
    if (img.src) { URL.revokeObjectURL(img.src); img.removeAttribute('src'); }
    $('printname').textContent = hintNow();
  });
  if (framed) $('printname').textContent = '';
  $('savedrawing').onclick = () => { closeMenus(); saveDrawing(); };
  $('skipview').onclick = () => (app.dxf ? $('view2d') : $('view')).focus();
  // (Next greyed at the end, Previous at the start: the focus to the other, R43-3)
  const stepBy = (d, b, other) => () => {
    if (!app.tour) return;
    const kb = b.matches(':focus-visible'); // (R44-6)
    showTourStep(app.tour.i + d);
    if (kb && b.disabled) other.focus();
  };
  $('tourprev').onclick = stepBy(-1, $('tourprev'), $('tournext'));
  $('tournext').onclick = stepBy(1, $('tournext'), $('tourprev'));
  // a sideways swipe on the card steps, as a phone's cards do (only its buttons did: R146-7)
  {
    let sw = null;
    $('tourcard').addEventListener('pointerdown', (e) => { sw = e.pointerType === 'touch' ? [e.clientX, e.clientY] : null; });
    $('tourcard').addEventListener('pointerup', (e) => {
      if (!sw || !app.tour) return;
      const dx = e.clientX - sw[0], dy = e.clientY - sw[1];
      sw = null;
      const to = app.tour.i + (dx < 0 ? 1 : -1);
      if (Math.abs(dx) > 50 && Math.abs(dy) < Math.abs(dx) / 2 && to >= 0 && to < app.tour.tour.steps.length) showTourStep(to);
    });
  }
  $('tourexit').onclick = () => endTour();
  $('tourplay').onclick = () => app.tour && setTourPlaying(!app.tour.playing);
  // Leaving the page asks first when it would throw away work: unsaved tour steps, or measurements
  // on a file from this device, which a reload cannot open again (R171-1)
  addEventListener('beforeunload', (e) => {
    if (app.embed || app.leaveOk) return;
    if (app.recorder?.unsaved?.() || deviceWorkAtRisk()) { e.preventDefault(); e.returnValue = ''; }
  });
  // (a playing tour paused while its tab is hidden, and played on when it is shown: it went on
  // stepping unseen -- R169-11)
  document.addEventListener('visibilitychange', () => {
    const t = app.tour;
    if (!t) return;
    if (document.hidden && t.playing) { setTourPlaying(false); t.hiddenPaused = true; }
    else if (!document.hidden && t.hiddenPaused) { t.hiddenPaused = false; t.ended = false; if (!t.playing) setTourPlaying(true); }
  });
  // a press in a caption that scrolls takes the focus there, so the keys scroll it (R72-3)
  $('tourbody').addEventListener('click', (e) => { const b = e.currentTarget; if (b.scrollHeight > b.clientHeight) b.focus({ preventScroll: true, focusVisible: false }); });
  // the tour maker: File > Make a tour… (a tour playing is opened in it), loaded on its first open
  const recorderApi = {
    capture: captureStep,
    captureNote: () => captureNote,
    preview: (tour, from, play) => { if (makerTour(tour, from || 0)) setTourPlaying(play); }, // (at its step: R79-5)
    stopPreview: () => { // (R73-1, R74-1)
      const w = app.watched;
      if (app.tour && app.tour === app.previewing) endTour(); // (R75-1..3: its step, its play, on its model only)
      if (!app.tour && w && w.h === app.header && startTourIn(w.t, w.u, w.o, w.o ? 0 : w.i)) setTourPlaying(w.p);
      app.previewing = app.watched = null;
    },
    isPreviewing: () => !!app.tour && app.tour === app.previewing,
    modelUrl: () => {
      try { const u = app.sourceUrl ? new URL(app.sourceUrl, location.href) : null; return u && samePlace(u.href, location.href) ? u.href : null; } catch { return null; }
    },
    orient: () => app.cam.orient || null,
    // the model open now, by its content, and the unit it is read in (null for a STEP or a .cadmesh)
    model: () => (app.header ? { key: modelKeyOf(app.header), unit: tourReading(), name: app.sourceName || 'another model' } : null),
    save: (text, name) => downloadText(text, name, 'application/json'),
    link: async (text) => {
      const { packTour, MAX_TOUR_LINK } = await import('./tour-link.js');
      const u = new URL(location.pathname, location.href);
      u.searchParams.set('tour', await packTour(text));
      const url = u.href.replace('tour=z%3A', 'tour=z:');
      if (url.length > MAX_TOUR_LINK) return { error: `the tour is too long for a link (${url.length} characters, at most ${MAX_TOUR_LINK}): Save tour and send the file` };
      try { await navigator.clipboard.writeText(url); return { url, copied: true }; } catch { window.prompt('Copy this link to the tour:', url); return { url, copied: false }; }
    },
    validate: (text) => parseTour(text, location.href),
    pictures: tourPictures,
    video: tourVideo,
    announce,
  };
  app.loadRecorder = async () => (app.recorder ||= (await import('./tour-recorder.js')).createTourRecorder(recorderApi));
  $('tourmake').onclick = async () => { closeMenus(); uncover(); app.previewing = app.watched = null;
    await app.loadRecorder();
    const t = app.tour, f = t && (t.full || t.tour);
    app.recorder.show(true, f, f ? f.steps.indexOf(t.tour.steps[t.i]) : 0);
  };
  $('gallerybtn').onclick = () => openGallery();
  $('galleryclose').onclick = () => closeGallery();
  // (the arrows by card -- a row by the grid's columns -- Home / End to the ends, and Tab kept in the
  // open gallery: it answered only Tab, which left it for the page under it -- R147-4)
  $('gallery').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeGallery(); return; }
    const cards = [...$('gallerygrid').children], at = cards.indexOf(document.activeElement);
    const all = [$('galleryclose'), ...cards];
    if (e.key === 'Tab') {
      const i = all.indexOf(document.activeElement), to = e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : (i + 1) % all.length;
      e.preventDefault(); all[to]?.focus(); return;
    }
    if (at < 0) return;
    const cols = getComputedStyle($('gallerygrid')).gridTemplateColumns.split(' ').length;
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + cols, ArrowUp: at - cols, Home: 0, End: cards.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    cards[Math.max(0, Math.min(cards.length - 1, to))].focus();
  });
  // Export as STL / 3MF / GLB: one button each (a drop-down among buttons,
  // which needed its own keyboard rules: UI organization review rank 7)
  for (const b of $('exportmesh').querySelectorAll('button')) b.onclick = () => { closeMenus(); exportMesh(b.dataset.fmt); };
  $('showall').onclick = () => {
    if (!app.hidden.size) return;
    rememberVisibility('Show all');
    app.hidden.clear();
    syncTreeChecks();
    pushState();
    viewChanged();
    announce('everything shown');
  };
  $('secpos').oninput = (e) => { app.section.t = Number(e.target.value) / 1000; app.section.held = null; updateButtons(); viewChanged(); };
  // the arrows and the wheel step the cut by the readout's last digit (Shift: ten): a thousandth of a
  // thin board moved "Z = 9.4 mm" not at all, and the wheel did nothing -- R148-3, R148-8
  const secStep = (dir, big) => {
    const p = sectionPlane();
    if (!p) return;
    const dec = ($('secval').textContent.match(/\d\.(\d+)/)?.[1].length) ?? 0;
    app.section.held = null;
    // (Shift no further than PageUp's tenth of the model: 1.0 mm on a 2 mm plate -- R149-7)
    const k = { x: 0, y: 1, z: 2 }[app.section.axis], { min, max } = sectionBox();
    const step = Math.min(lenBack(10 ** -dec * (big ? 10 : 1)), big ? (max[k] - min[k]) / 10 : Infinity);
    setSectionAt(p[3] * (app.section.flip ? -1 : 1) + dir * step);
  };
  $('secpos').addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (dir) { e.preventDefault(); secStep(dir, e.shiftKey); }
  });
  // (either axis, one step a ~100 px notch or a mouse notch of any size, the rest let go on a reversal
  // or a pause -- R149-4, R149-5, R150-5)
  let secWheel = 0, secWheelAt = 0;
  $('secpos').addEventListener('wheel', (e) => {
    e.preventDefault();
    let d = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    if (!d) return;
    const gap = e.timeStamp - secWheelAt;
    if (Math.sign(d) !== Math.sign(secWheel) || gap > 300) secWheel = 0;
    secWheelAt = e.timeStamp;
    // (a whole notch only for a line / page event or one that comes apart: a trackpad flick's ten 60 px
    // events stepped ten times -- R151-11)
    if (Math.abs(d) >= 50 && (e.deltaMode || gap > 60)) d = Math.sign(d) * 100;
    secWheel += d;
    while (Math.abs(secWheel) >= 100) { secStep(secWheel < 0 ? 1 : -1, e.shiftKey); secWheel -= Math.sign(secWheel) * 100; }
  }, { passive: false });
  $('secflip').onclick = () => { app.section.flip = !app.section.flip; updateButtons(); viewChanged(); };
  const pal = $('palette');
  for (const p of PALETTES) pal.add(new Option(p.label, p.id));
  pal.value = app.palette;
  blurAfterPick(pal);
  // Undo's key as this OS names it (both work everywhere)
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
    $('undo').title = $('undo').title.replace('Ctrl+Z', '⌘Z');
    for (const k of document.querySelectorAll('#helppop kbd')) k.textContent = k.textContent.replace(/^Ctrl\+([ZP])$/, '⌘$1');
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
    // (nothing selected: the parts shown -- a one-part board's List holes was greyed with nothing
    // saying to pick it first, R24-4)
    const ids = app.selected.size ? [...app.selected] : shownIds();
    const name = app.selected.size ? app.selName || (ids.length === 1 ? meshLabel(ids[0]) : `${ids.length} bodies`) : 'the parts shown';
    const kb = $('holesbtn').matches(':focus-visible');
    showHoles({ ids, name, shown: !app.selected.size });
    // (its head in view; from a key, the focus to its Copy: R44-2)
    if (!$('holes').hidden) {
      $('holestitle').scrollIntoView({ block: 'nearest' });
      // (and a first row with it: a landscape phone's drawer showed the head alone -- R128-2)
      const r0 = $('holesrows').firstElementChild;
      let sc = $('holes').parentElement; // (the panel's scroll, not the table's own)
      while (sc && !(sc.scrollHeight > sc.clientHeight && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
      if (r0 && sc && r0.getBoundingClientRect().bottom > sc.getBoundingClientRect().bottom) $('holestitle').scrollIntoView({ block: 'start' });
      if (kb) $('holescsv').focus({ preventScroll: true });
    }
  };
  $('holesclose').onclick = () => { showHoles(null); $('holesbtn').focus(); };
  // 'change', not 'input': a picker drag fires input continuously, and each
  // recolour re-uploads the model
  $('partcolour').onchange = (e) => setPartColour(e.target.value);
  $('partreset').onclick = () => resetPartColour();
  $('sharelink').onclick = () => shareView();
  $('embedbtn').onclick = () => openEmbed();
  $('embedclose').onclick = () => closeEmbed();
  $('embedcopy').onclick = () => copyEmbed();
  $('embedtheme').onchange = () => syncEmbed();
  // (Esc closes it, Tab stays in it, as the gallery's)
  $('embedcard').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEmbed(); return; }
    if (e.key !== 'Tab') return;
    const all = [...$('embedcard').querySelectorAll('button, select, textarea, a[href]')].filter((x) => !x.disabled && x.getClientRects().length);
    const i = all.indexOf(document.activeElement);
    e.preventDefault();
    all[e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : (i + 1) % all.length]?.focus();
  });
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
    // (.gz on gzipped bytes, as the lists serve them: R156-13)
    const file = `${saveBase(name)}.cadmesh${isGzip(bytes) ? '.gz' : ''}`;
    downloadBlob(new Blob([bytes]), file);
    tell(`saved ${file}, ${sizeText(bytes.byteLength ?? bytes.length)}`, 3000); // (R133-10, R134-4)
  };
  $('cacheclear').onclick = async () => {
    const err = await cacheClear().then(() => null, (e) => e);
    await refreshCacheBar();
    tell(err ? `could not clear the saved conversions: ${err.message || err}` : 'saved conversions cleared', err ? 6000 : 3000); // (told: r49 A4)
  };
  // (the ? box's Forget all: every setting and colour, and the saved conversions; what is open stays
  // as it is until the page is left -- R171-5)
  $('forgetall').onclick = async () => {
    // (asked first: the ? box's first Tab stop, and no undo -- R173-6)
    if (!confirm('Forget everything this browser keeps for the viewer: your display choices, the colours you picked and the saved conversions?')) return;
    forgetPrefs();
    coloursSeen.clear();
    // (the open model's colours, still shown, counted as written: the next pick stores itself alone, not
    // every forgotten colour again -- R172-3)
    if (app.modelKey) coloursSeen.set(app.modelKey, new Map([...ownOverrides()].map(([i, c]) => [i, rgbToHex(c).toLowerCase()])));
    const err = await cacheClear().then(() => null, (e) => e);
    await refreshCacheBar();
    tell(err ? `the settings and colours were forgotten, but not the saved conversions: ${err.message || err}`
      : 'everything this browser kept for the viewer was removed', 6000);
  };
  window.addEventListener('keydown', (e) => {
    // browser shortcuts and typing left alone, but Ctrl/Cmd+Z outside a field undoes a visibility
    // change (Z by the key's place on a layout that types no Latin letter, as the
    // letter shortcuts below: review r17)
    const zKey = e.key.toLowerCase() === 'z' || (nonLatinLetter(e.key) && e.code === 'KeyZ');
    // Ctrl/⌘+A outside a field: every body shown selected, not the page's text (R150-1)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 'a' || (nonLatinLetter(e.key) && e.code === 'KeyA'))) {
      const t0 = e.target;
      if ((t0.tagName === 'INPUT' && !NOT_TYPED.includes(t0.type)) || t0.tagName === 'TEXTAREA' || t0.isContentEditable) return;
      e.preventDefault();
      // (never the page's text -- a drawing's and the empty page's turned blue, R151-2 -- and nothing
      // behind the ? box, a menu or the gallery: R151-7)
      if (!app.header || app.dxf || helpOpen() || document.querySelector('.menu-btn[aria-expanded="true"]') || !$('gallery').hidden || !$('embedcard').hidden) return;
      const ids = [];
      for (let id = 1; id <= app.header.meshes.length; id++) if (!app.hidden.has(id)) ids.push(id);
      select(ids, false);
      announce(`${fmtInt(ids.length)} ${ids.length === 1 ? 'body' : 'bodies'} selected`);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && zKey) {
      const t0 = e.target;
      const field = (t0.tagName === 'INPUT' && !NOT_TYPED.includes(t0.type))
        || t0.tagName === 'TEXTAREA' || t0.isContentEditable;
      // (while measuring with something to take back, Measure's own Undo: R135-7)
      // (a drawing's measuring too: R136-8)
      if (!field && app.dxf?.view?.measuring) { e.preventDefault(); $('measundo').click(); } else if (!field && app.measure?.on && (app.measure.pending.length || app.measure.results.length)) { e.preventDefault(); app.measure.undo(); } else if (!field && app.visUndo.length) { e.preventDefault(); undoVisibility(); }
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
    // ...and a load's Cancel while its card offers it, as Esc closes the rest (R142-14)
    if (e.key === 'Escape' && !$('progress').hidden && $('pcancel').offsetParent && !$('pcancel').disabled) { e.preventDefault(); $('pcancel').click(); return; }
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
      // (PageDown / PageUp page a focused caption that scrolls, as its arrows do: R80-3)
      const cap = t.id === 'tourbody' && t.scrollHeight > t.clientHeight;
      const go = cap && /^Page/.test(e.key) ? 0 : { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }[e.key];
      if (go) {
        // (a step button the key disabled: the focus to the other one -- R82-1)
        e.preventDefault();
        const to = app.tour.i + go; // (past either end: nothing -- R83-1)
        if (to < 0 || to >= app.tour.tour.steps.length) return;
        app.stepKey = true; showTourStep(to); app.stepKey = false;
        if (t.disabled && (t.id === 'tourprev' || t.id === 'tournext')) $(t.id === 'tourprev' ? 'tournext' : 'tourprev').focus();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); endTour(); return; }
      // Space plays / pauses (a focused button's own Space presses it)
      if (e.key === ' ' && app.tour.tour.steps.length > 1 && !(t instanceof Element && t.closest('button, a, summary'))) { e.preventDefault(); setTourPlaying(!app.tour.playing); return; }
    }
    // number keys: the digit row by the character typed, other digit scripts by place, the numpad by
    // its code -- with NumLock off, only where no slider, select or tree has the focus (r19, r20)
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
    // The camera from the keyboard (arrows turn, Shift pans, + - zoom) where the focus is the view or
    // nowhere; a control's own arrows win
    const onView = t === $('view') || t === $('view2d') || t === document.body || t === document.documentElement || !(t instanceof Node);
    // a drawing from the keyboard: arrows pan (as a drag), + and - zoom about the middle; it had
    // only F, so a keyboard user could not move it (UI design round 11 R11-1)
    if (app.dxf && onView && !e.defaultPrevented) {
      const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      const zoom = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' ? 1.2
        : e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract' ? 1 / 1.2 : 0;
      if (arrow || zoom) {
        e.preventDefault();
        const v = $('view2d');
        if (zoom) app.dxf.view.zoomAt(zoom, v.clientWidth / 2, v.clientHeight / 2);
        else app.dxf.view.panBy(arrow[0] * 40, arrow[1] * 40); // (← moves it left, as Shift+← moves a model: round 12 R12-3)
        return;
      }
    }
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
    // Letters in either case or by place; Esc closes one thing a press (Walk by its ×: R149-3)
    const escTool = () => (app.paintFaces ? (setPaint(false), true) : app.walk ? ($('walkoff').click(), true)
      : app.explode.on ? (setExplode(false, true), true) : app.section.axis !== 'off' ? ($('secoff').click(), true) : false);
    const acts = { f: () => $('fit').click(), Escape: () => (panelOpen() ? setPanel(false, true) : app.dxf ? ((app.dxf.view.escapeMeasure() && (app.measure?.sync2D(app.dxf.view), tell('point dropped', 2000), true)) /* (as 3D: R129-4) */ || (app.dxf.view.measuring ? (toggle2DMeasure(), true)
        // (then a selected layer, then an active embed lets the page have the wheel back, as in 3D: round 10 R10-2)
        : app.dxf.view.selected ? app.dxf.view.select(null) : app.embed && app.embedActive ? (setEmbedActive(false), true) : false)) : app.measure.escape()
        || escTool() || (app.embed && app.embedActive && !app.selected.size ? (setEmbedActive(false), true) : false)
        || (app.selected.size ? (select([], false), announce('selection cleared'), true) : select([], false))), // (said: R127-6)
      h: () => $('hide').click(), i: () => $('isolate').click(), a: () => $('showall').click(), e: () => { if (!app.dxf) edgesKey(); }, // (not a drawing's: it switched the 3D style unseen -- R136-8)
      m: () => { if (app.dxf) toggle2DMeasure(); else if (!$('measure').disabled) app.measure.setOn(!app.measure.on, true); },
      p: () => { if (!$('savepic').disabled) savePicture(); },
      x: () => { if (!$('explode').disabled && !$('explode').hidden) setExplode(!app.explode.on, true); else if (app.header?.meshes.length === 1) tell('this model is one part: nothing to explode', 2500); } };
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
// The controls, shortcuts and renderer, in a box from ? (Esc or a press elsewhere closes it).
const helpOpen = () => !$('helppop').hidden;
// under ?, its right edge with ?'s, but inside the window: a phone's box
// is nearly the window's width, and aligned to ? it ran off the left
function placeHelp() {
  const pop = $('helppop'), r = $('helpbtn').getBoundingClientRect();
  pop.style.top = `${Math.round(r.bottom) + 4}px`;
  pop.hidden = false;
  pop.style.right = `${Math.max(8, Math.min(Math.round(innerWidth - r.right), innerWidth - 8 - pop.offsetWidth))}px`;
}
function setHelp(open, focus = false) {
  const pop = $('helppop'), btn = $('helpbtn');
  if (open === helpOpen()) return;
  const inside = pop.contains(document.activeElement);
  if (open) { closeMenus(); placeHelp(); }
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
  // (Tab off either end of the box closes it, the focus back on ? (R157-4, R158-1); Tab from ? goes
  // into an open box (R158-2))
  const helpStops = () => [...$('helppop').querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])')].filter((x) => x.getClientRects().length);
  $('helppop').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = helpStops(), a = document.activeElement, pop = $('helppop');
    if (e.shiftKey ? (a === pop || a === f[0]) : (a === f[f.length - 1] || (a === pop && !f.length))) { e.preventDefault(); setHelp(false, true); }
  });
  $('helpbtn').addEventListener('keydown', (e) => {
    const f = e.key === 'Tab' && !e.shiftKey && helpOpen() && helpStops();
    if (f && f.length) { e.preventDefault(); f[0].focus(); }
  });
  // (a phone turned keeps the box, placed again under ?; closed only if ? left the window: R154-5)
  addEventListener('resize', () => {
    if (!helpOpen()) return;
    const r = $('helpbtn').getBoundingClientRect();
    if (r.width && r.left >= 0 && r.right <= innerWidth) placeHelp(); else setHelp(false);
  });
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
      app.noGpu = true;
      document.body?.classList.add('nogpu'); // (the unwired toolbar's tools did nothing: R21-2)
      const h2 = document.querySelector?.('#empty h2');
      if (h2) h2.textContent = 'No 3D in this browser';
      for (const id of ['view', 'view2d']) if ($(id)) $(id).tabIndex = -1; // (an empty canvas as a Tab stop: R23-2)
      // (Esc closes the help, as on a working page, whose key map is never wired here: R24-8)
      addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('helppop') && !$('helppop').hidden) $('helpbtn').click(); });
      openLbl.hidden = true;
      $('emptyopen').hidden = true;
      window.addEventListener('dragover', over);
      window.addEventListener('drop', (e) => { e.preventDefault(); announce('this browser has no GPU the viewer can use, so it cannot open a model'); });
    }
  }
  wireInput();
  // (the toolbar shown once it is wired: set at the module's end it flashed unfolded and dead for a
  // second while main() waited for the GPU -- R133-1, high R134-1)
  document.documentElement.classList.add('booted');
  keepFocus();
  queueFrame();
  refreshCacheBar();
  await startFromUrl(early);
}

// The start-up's own loads, none over a file the visitor opened since (untouched(): r51 A4, Q1)
const untouched = () => app.loadSeq === app.startSeq;
function startUpLoad(url) {
  const p = loadListed(url);
  app.startSeq = app.loadSeq; // (loadListed numbered it at once: beginLoad)
  // (the model the page first showed from its address -- addressModel: recorded once shown, not when
  // its load began; one the visitor superseded was never shown -- r57 Q4)
  return p.then(() => {
    if (!app.addressUrl && !app.visitorFirst && app.header && app.sourceUrl === url) app.addressUrl = url;
  });
}
// Whether a view link's #view= is for the model shown, by its address: one naming a model is for it
// once its list has it; one naming none, for a model from the device (r16 M2, r57 A2, r58 A4, r59 A1)
function viewIsFor(search) {
  const names = !!(search.get('src') || modelNameIn(search));
  // (a device file's link waits for the file it names: another file opened first took the view, and
  // the right one then opened bare -- R162-2)
  if (!names) return !app.sourceUrl && (!search.get('file') || search.get('file') === app.sourceName);
  const url = modelUrlIn(search);
  return !!url && app.sourceUrl === url;
}
const pendingViewIsFor = () => !!app.pendingView && viewIsFor(app.pendingView.search);
// The view a #view= fragment names, or null (a bad escape -- a hand-edited or cut link -- is no view,
// never an error). Read once, for the start, Back and an edit (written twice: r59 A8).
function linkViewOf(hash) {
  if (!hash.startsWith('#view=')) return null;
  try { return decodeView(decodeURIComponent(hash.slice(6))); } catch { return null; }
}
// The model the page as first opened shows from its address (its start's first load, else the list's
// first): Back's and a #view='s first page; none for a file or pick shown first (r56 A2, r57 Q4)
const addressModel = () => app.addressUrl || (app.visitorFirst ? null : app.listEntries?.[0]?.url) || null;
// ?src=, its ?add=s (each with an optional ?addat=x,y,z in mm) and a #view= that waits for them: the one
// chain, at start-up or from View in 3D (r51 A5)
function openStart(src) {
  const opening = startUpLoad(src);
  const adds = params.getAll('add'), ats = params.getAll('addat');
  if (!adds.length) return opening;
  app.addsPending = true;
  // (one chain at a time: a second start of the page as first opened -- Back to it -- ends the first,
  // whose loop went on beside it under the one shared guard: r60 Q3)
  const chain = (app.startChain = {});
  // (kept: an Add model… meanwhile waits for it -- addPicked)
  return (app.addsChain = opening.then(async () => {
    const lists = params.getAll('list');
    // (the adds join the model this start opened, and no other: when it failed and the visitor picked
    // another, the ?add=s joined the pick, under an address that named the first -- r61 Q1)
    const joins = () => app.sourceUrl === src;
    for (const [i, raw] of adds.entries()) {
      if (!joins()) break;
      // (a relative ?add= is the list's entry: the list read first, unless it opened this -- r54, r58)
      if (lists.length && isRelative(raw) && app.listRead && !app.listEntries) await app.listRead;
      if (!app.scene || !untouched() || app.startChain !== chain) break;
      const u = (lists.length && listedUrlFrom(raw, lists, app.listEntries, location.href)) || raw;
      const at = (ats[i] || '').split(',').map(Number);
      const p = startAdd(() => loadUrl(u), at.length === 3 && at.every(Number.isFinite) ? at : null);
      app.startSeq = app.loadSeq;
      await p;
    }
    if (app.startChain !== chain) return; // (a newer start's adds are its own to end)
    app.addsPending = false;
    landPendingView();
  }));
}
// A view link's view applied to the model shown -- at its load, after the address's ?add=s, or on a
// #view= edit -- and the model marked as showing it, so its list entry's tour and hidden parts do not
// go over it (linkViewOver; r58 A3)
function applyLinkView(view) {
  applyView(view, true);
  app.viewLinkedFor = autoTourKey();
}
// View in 3D on an embed's poster: the model and its adds in the start-up's order (?src=, the
// tour's model, the list's first), then a ?tour= read meanwhile (r50 Q3, r53 Q2, r54 Q2).
async function viewIn3D(src) {
  $('poster').hidden = true;
  setEmbedActive(true);
  $('view').focus?.({ preventScroll: true }); // (the poster's button gone: the focus to the view -- R122-8)
  // (the visitor's ask is the press: a file they open while the tour or list is read is theirs, and
  // nothing the address names opens over it -- the list's first did: r54 A1, Q3)
  app.startSeq = app.loadSeq;
  // (a ?src= opens at once, beside the tour's read, as at start-up: it waited for the tour, up to its
  // 20 s, under no card, then opened over a file the visitor had opened meanwhile -- r55 A1, Q1, Q5)
  const opening = src ? openStart(src) : null;
  if (!src && (app.tourRead || app.listRead)) {
    // (the card says what is read, not a blank view under "View in 3D loads the model": r54 A7, Q5)
    const what = app.listRead ? 'the model list' : 'the tour';
    setStatus('idle', `reading ${what}…`);
    // (a refusal of a file during either read is told, the card being the read's: it was the page's
    // error during the tour's read, and the tour's model opened over it -- r56 Q5)
    app.readingList = true;
    $('pcancel').hidden = true; // (no Cancel: the read goes on whatever is pressed)
    showProgress('Opening the 3D model', null, `reading ${what}`);
    try {
      await Promise.all([app.tourRead, app.listRead]);
    } finally {
      app.readingList = false;
      $('pcancel').hidden = false;
      showEmpty();
    }
    // (the visitor's own file during the wait: the tour by the one rule, as at start-up and with a
    // ?src= -- returning here, a tour with no model never played over it: r57 A4, Q2)
    if (!untouched()) { addressTourEnds(app.tourRead ? await app.tourRead : null, false); return; }
  }
  const r = app.tourRead ? await app.tourRead : null;
  const tourOwn = !src && !!r?.tour?.model;
  if (!src) {
    // (a name the list was read for, behind the poster: r57 Q5 -- one it lacks said now, its first opening)
    const named = modelNameIn(params) && modelUrlIn(params);
    src = named || r?.tour?.model || app.listEntries?.[0]?.url || null;
    lackingNote(modelNameIn(params), src);
    if (!src) {
      // (a tour alone that names no model: the poster had nothing behind it -- the page as without
      // one, as when the tour was read before the press: r56 A3, Q2)
      if (r?.tour && !params.getAll('list').length) setStatus('idle', idleText());
      // (a list that failed or names nothing: its words on the card, not "no model to show": r54 Q4)
      else if (app.status !== 'error') setStatus('error', app.listNote || (r?.error ? `the tour ${r.error}` : 'the address names no model to show'));
      // (a tour read, whatever the list did: said -- a failed list kept it unsaid: r57 A3)
      addressTourEnds(r, false);
      return;
    }
    // (a tour that could not be read is over before the list's first opens, which then plays its own,
    // as at start-up: r57, the start-up sweep's I11)
    if (r?.error) tourOver();
    await openStart(src);
  } else await opening;
  addressTourEnds(r, tourOwn && app.status === 'error');
}
// "The model list has no model X", when the address names a place its list lacks and something else
// opens there (`opened`, or null); one rule for the start-up and View in 3D (r57 A7, r58 A5, Q8)
function lackingNote(place, opened) {
  if (!place || !opened || modelUrlIn(params) || !app.listEntries?.length) return;
  // (kept through the load's clear, as the dropped-files note is: gone at ready, never seen -- R147-7)
  tell((carriedNote = `the model list has no model ${place}${opened === app.listEntries[0].url ? ': its first opens' : ''}`), 8000);
}
// The address's tour, once read and its model loaded: played (tourPlaysHere) while still the address's,
// else said ready; the start-up's and View in 3D's ending (r57 A1, Q1, r72 A1, r73 A8)
async function addressTourEnds(r, ownFailed) {
  try {
    if (r?.tour && app.urlTourPending && entryTourWait()) await entryTourSettled();
    if (r?.tour && app.urlTourPending) {
      if (!tourPlaysHere(r.tour)) { /* its own model's, not the visitor's file's: nothing said */ }
      else if (app.header) startTourIn(r.tour, params.get('tour'), params.get('step'));
      else if (!ownFailed) tourReadyNote();
    }
  } catch (e) {
    console.error(e);
    failApart(`the tour could not be played: ${e && e.message ? e.message : e}`);
  } finally {
    tourOver();
  }
}
// "The tour is ready", said where it has no model to play over: never the open-a-file words in an
// embed, whose visitor chose nothing to open (r48 A1, A2; r49 Q5). The start-up and View in 3D's.
function tourReadyNote() {
  tell(`the tour is ready: open its 3D model${somethingShown() || app.embed ? '' : ` (${IDLE_MSG})`}`, 6000);
}
// Whether the address's tour plays over the model shown: its own model's only, a modelless one over
// any (r52 A2, Q1, r55 Q3)
const tourPlaysHere = (tour) => !(tour.model && !untouched());
// The address's tour is over, played or not: the next model a list opens plays its own (the flag
// stayed set after a file dropped on the poster, or opened during View in 3D's wait, and no list
// model's tour played again -- r55 A3, Q2)
function tourOver() {
  if (!app.urlTourPending) return;
  app.urlTourPending = false;
  if (app.header) app.autoTourFor = autoTourKey();
}
// A file picked or dropped while the GPU starts: the model, its companions kept (r50 A2, r51 A3)
const earlyPick = (files) => (files.length ? pickModelFile(files) : null);
// File › Add model…: the picked model joins the scene; one over the size refused before anything
// starts (Add model… called loadFile, whose own check came after beginLoad: r50 A1)
function addPicked(files) {
  if (!files.length || !app.scene) return;
  const f = pickModelFile(files);
  if (refusedForSize(f)) return;
  addWith(() => loadFile(f));
}
// a model added (a file, or a list board: load, beside the others) joins the one shown
function addWith(load, beside = false) {
  if (!app.scene) return;
  // (a model added joins the one shown, the address's own still there: not the visitor opening
  // something else -- the tour did not play over the address's model: r56 Q7)
  const go = () => {
    const was = untouched();
    startAdd(load, null, beside);
    if (was) app.startSeq = app.loadSeq;
  };
  // (after the address's ?add=s, neither cancelling the other; dropped for a newer open, not for a
  // Cancel of an ?add= -- r57 A5, Q3, r58 A1, Q2, r59 Q5)
  const over = app.sourceUrl;
  if (app.addsPending && app.addsChain) {
    app.addsChain.then(() => { if (untouched() || (app.sourceUrl === over && app.scene && !PROGRESS_STATES.has(app.status))) go(); });
  } else go();
}

// The page's start from its address once the renderer is up (?list=, ?src=, ?poster=, ?add=, ?tour=):
// its contract tests/test-startup-sweep.mjs and START_CASES; app.starting cleared at its end (r51-r58)
async function startFromUrl(early) {
  try {
    await startFromAddress(early);
  } finally {
    app.starting = false;
    const held = app.heldFailure;
    app.heldFailure = null;
    if (held && !somethingShown() && !posterUp() && (app.status === 'idle' || app.status === 'init')) { setStatus('error', held); announce(held); }
  }
}
async function startFromAddress(early) {
  // the file the visitor chose while the GPU started: the newest ask, opened first, and nothing the
  // address names opens over it (it waited behind the list read, its line replaced, and the list's
  // model started and was cancelled: r51 A11)
  app.startSeq = app.loadSeq;
  // (refused for its size, it is the visitor's ask all the same: nothing the address names opens
  // over the refusal, which stands on the card -- the address's model opened over it, the refusal
  // painted nowhere: r52 A3, Q3)
  if (early) { openFile(early); app.startSeq = -1; }
  // (from here to the start's end, a failure apart from it is told: failApart -- r57)
  app.starting = true;
  // ?model=<id> or ?index=<n> beside a ?list=: a model the list names
  // (modelUrlIn), so the list is read first; a name it does not have opens
  // its first model and says so. Else ?src=, a URL.
  const lists = params.getAll('list');
  // File › Check this list…: the list check (check.html) on this page's
  // lists, for their owner, whether or not they read
  if (lists.length && !app.embed) {
    const c = new URL('check.html', location.href);
    // (a list that is not a URL passed as written, for check.html to refuse in words: it threw here
    // and stopped the start -- r58 Q6 --, then was left out and the check named nothing wrong: r59 A5, Q8)
    for (const l of lists) { let h = l; try { h = new URL(l, location.href).href; } catch { /* as written */ } c.searchParams.append('list', h); }
    $('checklist').href = c.href;
    $('checklist').hidden = false;
    syncMenuButtons();
  }
  let listed = null;
  let src = params.get('src');
  const place = modelNameIn(params);
  // (behind a poster the list is read beside it, and View in 3D opens the name or the place's entry
  // once it has answered: r57 Q5, r58 Q3)
  if (place && posterAsked(params) && untouched()) { listed = readLists(lists, () => false); src = null; }
  else if (place) {
    // the model on its way said on its card for the list's round trip; a file the visitor opens
    // meanwhile is theirs, the list's model not opened over it (untouched)
    const reading = untouched();
    if (reading) {
      setStatus('idle', 'reading the model list…');
      app.readingList = true;
      $('pcancel').hidden = true;
      showProgress('Opening the 3D model', null, 'reading the model list');
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
    // (a name the list lacks: the start-up's order from there -- the tour's own model ahead of the
    // list's first, which opened ahead of it and had the tour played over it: r55 A4)
    const named = modelUrlIn(params);
    src = named || (params.get('tour') ? null : app.listEntries?.[0]?.url) || null;
    // (told: r49 A4; behind a poster it opens with View in 3D, not now -- r51 Q7; "its first opens"
    // only when it does)
    // (beside a tour, said once what opens is known: at the tour's end)
    if (untouched() && !params.get('tour')) lackingNote(place, src);
  }
  // ?orient=up:+z,front:-y: which of the file's axes is up and which faces the
  // viewer, for a model this page opens from a URL that its list entry does
  // not orient (orientFor). A bad one is no orientation, never an error.
  app.urlOrient = orientOrNull(params.get('orient'));
  // #view=…: a shared link's view, applied when its model has loaded (viewIsFor); a bad escape is no view
  setPendingView(params, location.hash);
  // ?src opens at once, ?list= read beside it (no ?src: its first, r19); a poster shows the picture
  // until View in 3D (r53, r54); ?tour= read beside, its own model opened without a ?src
  const tourUrl = params.get('tour');
  const touring = tourUrl ? readTour(tourUrl) : null;
  app.tourRead = touring; // (View in 3D on a poster reads it too)
  // (its own tour, not the list's, plays over the first model: applyListEntry)
  app.urlTourPending = !!tourUrl;
  let poster = posterAsked(params) && (src || lists.length > 0 || !!tourUrl) && untouched() && params.get('poster');
  let opening = null;
  if (poster) {
    try { $('posterimg').src = new URL(poster, location.href).href; } catch { /* a bad URL: the button alone */ }
    $('poster').hidden = false;
    setStatus('idle', POSTER_MSG);
    showEmpty();
    $('posterload').onclick = () => viewIn3D(src);
  } else if (src && untouched()) opening = openStart(src);
  let tourOwn = false; // (the tour's own model opened: its failure is the one that holds the tour's note back)
  if (touring && !src && !poster) {
    opening = touring.then((r) => {
      if (!(r.tour && r.tour.model && untouched())) return null;
      tourOwn = true;
      return openStart(r.tour.model); // (with the address's ?add=s: r58 A2)
    });
  }
  // (not over an error, nor the visitor's own file opening: this moves an 'init' page on -- r50 Q1)
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
    // (a poster with nothing behind it -- a tour alone, naming no model -- comes down, the page as
    // without one: View in 3D ended on an error card where the page said "the tour is ready": r55 Q11)
    if (poster && !src && !lists.length && !r.error && !r.tour.model && posterUp()) {
      $('poster').hidden = true;
      poster = false;
      setStatus('idle', idleText());
    }
    // a modelless or unread tour over only a list: the list's first, a lacking name said (r56 Q1, A6, Q9)
    let firstOpened = false;
    if (!app.header && !src && !poster && !tourOwn && untouched() && app.listEntries?.length) {
      firstOpened = true;
      // (a tour that failed is over before the list's first opens, which then plays its own -- the
      // flag still set held it back: r57 A6)
      if (r.error) tourOver();
      // (with the address's ?add=s, as every first model the start opens: openStart -- r58 A2)
      await openStart(app.listEntries[0].url);
    }
    if (!poster) lackingNote(place, firstOpened ? app.listEntries[0].url : tourOwn ? r.tour.model : null);
    // (the address's tour failing after the visitor left that address: told, not written into the
    // picked model's ready line -- r60, r66)
    if (r.error) {
      if (params.get('tour') && !new URLSearchParams(location.search).has('tour')) tell(`the tour ${r.error}`, 6000);
      else failApart(`the tour ${r.error}`, true);
    }
    // (behind a poster View in 3D plays it; else addressTourEnds, the one ending: r48-r57)
    if (!poster) addressTourEnds(r.error ? null : r, tourOwn && app.status === 'error');
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
  // (the list's first, with the address's ?add=s: openStart -- they were never opened beside it, and
  // behind a poster View in 3D opened them: r58 A2)
  if (listsRead(r, openFirst())) await openStart(r.entries[0].url);
}
// What the lists' answer says and whether to open their first model: nothing to open is a failure
// apart (failApart, r49 A2); a failed one beside others told, on the ready line (app.listNote)
function listsRead(r, openFirst) {
  const note = r.errors.length ? listNote(r.errors) : r.entries.length ? '' : 'the model list names no models';
  // (the answer is in: the read for a model it names is over, and its own failure is the page's --
  // told only, as a refusal of another file during the read is, the card was left with no error)
  app.readingList = false;
  app.listNote = '';
  if (note && !r.entries.length) failApart(note, true);
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
      // ?bench=N: orbit one step a frame for N frames and report the intervals (vsync-bound)
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

// (main() failing before it wired the toolbar still shows it: never hidden for good)
guard(main()).finally(() => document.documentElement.classList.add('booted')).then(() => { if (params.get('selftest')) return selftest(); });
// (the module's last statement: every one above it ran -- js/boot-check.js's sign the page started;
// window.__cadv, set early, missed a throw in any later top-level statement: r74 Q7)
window.__cadvStarted = true;
document.getElementById('bootslow')?.remove(); // (index.html's no-script card: r76 Q4)
