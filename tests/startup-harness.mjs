// main.js's own start from the address, run in node: startFromUrl, openStart, viewIn3D, earlyPick,
// addPicked, openListed and the history (Back, #view=), with every function they reach cut from
// js/main.js as written. The network and the load itself are the only stand-ins. One case runs and
// returns what was seen. The start-up table (tests/test-scene.mjs START_CASES) states per-case
// answers through it; the generated sweep (tests/test-startup-sweep.mjs) states invariants (r57).
//
// A case:
// - q, hash: the address;
// - serve: path -> body, or 'TIMEOUT' / 'BODY-TIMEOUT'; a path not served answers 404;
// - redirect: path -> the path that answered;
// - fails: the model files whose load fails;
// - slow: paths read or loaded slowly;
// - early: the files picked while the GPU starts;
// - during: [{ at, act... }], where at is a path read, a model file loaded, 'loaded <file>', or
//   'model' (the first model the address loads). An act is one of: file / size (the visitor opens
//   a file), click (View in 3D), add (Add model…), pick (a list entry, by place), back (Back to the
//   first entry), hash (a #view= edit).
// - click / add / drop / pick / back / hash: the same acts after the start.

import { readFileSync } from 'node:fs';
import { answeredFrom, entryByName, fetchModelLists, isRelative, isTimeout, listedUrlFrom, modelNameFrom, modelUrlFrom, posterAsked, readCapped } from '../js/model-list.js';
import { fileUrl } from '../js/open-url.js';
import { MAX_TOUR_BYTES, parseTour } from '../js/tour.js';
import { orientOrNull } from '../js/orient.js';
import { isCompanion } from '../js/formats.js';

export const SITE = 'https://site.example/v/';

const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const cutIf = (head) => { const at = src.indexOf(head); return at < 0 ? '' : src.slice(at, src.indexOf('\n}\n', at) + 2); };
const line = (head) => { const at = src.indexOf(head); return at < 0 ? '' : src.slice(at, src.indexOf('\n', at) + 1); };
const arrow = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n};\n', at) + 4); };
const BODY = line('let saySeq = 0') + line('let listPick = 0') + [src.includes('async function viewIn3D(src) {') ? 'async function viewIn3D(src) {' : 'function viewIn3D(src) {',
  'async function startFromUrl(early) {', 'function addPicked(files) {',
  'async function readLists(lists, openFirst) {', 'function listsRead(r, openFirst) {', 'function loadListed(url) {', 'function startLoad(fn) {',
  'function guard(p, seq = null) {', 'function beginLoad() {', 'function stale(seq) {', 'function announce(text) {', 'function sayNow(text) {',
  'function tell(text, ms = 1500, said = text) {', 'function tellReady(words, ms = 6000) {', 'function setStatus(s, msg) {', 'function readyText() {',
  'function failApart(msg', 'function showEmpty() {', 'function openFile(f', 'function refusedForSize(f) {', 'function modelUrlIn(search) {',
  'async function readTour(url) {', 'function listEntry(src) {', 'function startAdd(fn) {', 'function pickModelFile(files) {',
  'function startUpLoad(url) {', 'function openStart(src) {', 'function rewriteReady(change) {', 'function tourOver() {', 'function tourReadyNote() {',
  'function openListed(url, refocus = false, keepMenu = false) {', 'function wireHistory() {', 'function addressTourEnds(r, ownFailed) {',
  'function lackingNote(place, firstOpens) {'].map(cutIf).join('')
  + line('const tourPlaysHere = ') + line('const addressModel = ') + line('const listsGiven = ') + line('const viewIsFor = ')
  + line('const listNote = ') + line('const posterUp = ') + line('function somethingShown() {') + line('const isPlace = ') + line('const isRelative = ')
  + line('const autoTourKey = ') + line('const earlyPick = ') + line('const untouched = ') + line('const idleText = ')
  + line('const POSTER_MSG = ') + line('const oversizeText = ') + line('const companionsOf = ')
  + (src.includes('modelNameFrom(search') ? line('const modelNameIn = ') : arrow('const modelNameIn = '))
  // (as the real ones: a URL brings no companions; a file takes those its pick kept for it)
  + 'async function loadUrl(url) { return fakeLoad(url, { beginLoad, stale, setStatus, readyText }, [], false); }\n'
  + 'async function loadFile(f, extras = companionsOf.get(f) || []) { return fakeLoad(f.name, { beginLoad, stale, setStatus, readyText }, extras, true); }\n';

const tick = () => new Promise((res) => setTimeout(res, 1));
const settle = async (n) => { for (let i = 0; i < n; i++) await tick(); };

export async function runStart(c) {
  const params = new URLSearchParams(c.q);
  const app = { status: 'init', statusMsg: 'starting GPU', mesh: null, dxf: null, header: null, embed: params.get('embed') === '1', loadSeq: 0,
    listEntries: null, listNote: '', unmeshedFaces: 0, noFacts: null, hidden: new Set(), backend: 'webgl2', scene: null, cam: { orient: 'z' } };
  // events: the visitor's acts and the address's tour starting, in order; pendingAtList: each list
  // entry shown, with the address's tour still pending or not then (applyListEntry holds a list
  // model's own tour back while it is)
  const o = { shown: [], opened: [], loadedUrls: [], progress: [], cancelHidden: [], acted: [], events: [], pendingAtList: [], tour: false, views: 0,
    released: 0, embedActive: false, threw: null, app };
  const frames = [], listeners = {};
  const el = () => ({ textContent: '', title: '', dataset: {}, hidden: false, before() {}, classList: { add() {}, remove() {} } });
  const dom = new Proxy({ poster: { hidden: true } }, { get: (t, k) => (k in t ? t[k] : (t[k] = el())) });
  o.dom = dom;
  const doc = { querySelector: () => el(), createElement: () => el(), documentElement: { classList: { add() {} } } };
  const serve = c.serve || {};
  const loc = { href: `${SITE}?${c.q}${c.hash || ''}`, hash: c.hash || '', search: `?${c.q}` };
  let run = null, modelSeen = false;
  const act = (d) => {
    o.acted.push(d); // (an act set for a moment that never comes -- no model loads -- is not one)
    // (a pick needs an entry to pick: before the list has answered there is none)
    o.events.push(d.pick ? (app.listEntries?.[d.pick - 1] ? 'pick' : 'pick (no entry)') : d.add ? `add${app.scene ? '' : ' (no scene)'}` : d.click ? 'click' : d.back ? 'back' : d.hash ? 'hash' : `file ${d.file}`);
    if (d.click) return dom.posterload.onclick && dom.posterload.onclick();
    // (Add model… with one name, or the files a case picks)
    if (d.add) return run.addPicked([].concat(d.add).map((a) => (typeof a === 'string' ? { name: a, size: d.size || 10 } : a)));
    if (d.pick) { const e = app.listEntries?.[d.pick - 1]; return e && run.openListed(e.url); }
    if (d.back) { loc.search = `?${c.q}`; loc.hash = ''; return listeners.popstate && listeners.popstate(); }
    if (d.hash) { loc.hash = '#view=v'; return listeners.hashchange && listeners.hashchange(); }
    return run.openFile({ name: d.file, size: d.size || 10 });
  };
  // (an act's own throw, or its promise's, is the run's: recorded, not the process ended)
  const safe = (d) => { try { return Promise.resolve(act(d)).catch((e) => { o.threw ||= e.message; }); } catch (e) { o.threw ||= e.message; return null; } };
  const visit = (at) => { for (const d of [].concat(c.during || [])) if (d.at === at) setTimeout(() => safe(d), 0); };
  const fetchFake = async (u) => {
    const path = String(u).startsWith(SITE) ? String(u).slice(SITE.length) : String(u);
    visit(path);
    await settle((c.slow || []).includes(path) ? 30 : 3);
    if (serve[path] === 'TIMEOUT') { const e = new Error('signal timed out'); e.name = 'TimeoutError'; throw e; }
    if (serve[path] === 'BODY-TIMEOUT') {
      return new Response(new ReadableStream({ start(ctl) { ctl.error(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })); } }), { status: 200 });
    }
    if (!(path in serve)) return new Response('', { status: 404 });
    const res = new Response(serve[path], { status: 200 });
    if (c.redirect && c.redirect[path]) Object.defineProperty(res, 'url', { value: SITE + c.redirect[path] });
    return res;
  };
  const fakeLoad = async (url, k, extras, fromFile) => {
    const adding = !!app.startingAdd;
    o.loadedUrls.push(String(url));
    o.events.push(`load ${String(url).split('/').pop()}`);
    const seq = k.beginLoad();
    if (dom.pcancel.hidden) o.cancelHidden.push(String(url));
    const file = String(url).split('/').pop();
    o.opened.push(fromFile && extras.length ? [file, ...extras.map((x) => x.name)].join('+') : file);
    k.setStatus('loading', `downloading ${file}`);
    visit(file);
    if (!fromFile && !adding && !modelSeen) { modelSeen = true; visit('model'); }
    await settle((c.slow || []).includes(file) ? 30 : 2);
    if (k.stale(seq)) return;
    if ((c.fails || []).includes(file)) throw new Error(`could not download ${file}: not found (404)`);
    if (adding) app.scene.push({ url });
    else Object.assign(app, { header: { meshes: [{}] }, mesh: {}, scene: [{ url }], sourceUrl: url });
    if (!adding && (app.listEntries || []).some((e) => e.url === url)) o.pendingAtList.push([file, !!app.urlTourPending]);
    if (!adding) o.events.push(`shown ${file}`);
    k.setStatus('ready', k.readyText());
    visit(`loaded ${file}`);
  };
  run = new Function('app', '$', 'flashHover', 'PROGRESS_STATES', 'requestAnimationFrame', 'fmtInt', 'IDLE_MSG', 'MAX_FILE_BYTES', 'params',
    'location', 'document', 'window', 'fetch', 'fetchModelLists', 'fillModelList', 'entryByName', 'fileUrl', 'readCapped', 'parseTour', 'MAX_TOUR_BYTES',
    'fetchFailedText', 'fakeLoad', 'startTourIn', 'syncModelList', 'showProgress', 'syncMenuButtons', 'setEmbedActive', 'applyView', 'decodeView',
    'orientOrNull', 'isCompanion', 'gaveUp', 'console', 'modelUrlFrom', 'modelNameFrom', 'earlyLists', 'posterAsked', 'timedFetch', 'releaseEarly',
    'isRelative', 'listedUrlFrom', 'isTimeout', 'answeredFrom', 'setModelParam', 'history', 'closeMenus',
    `${BODY}; return { startFromUrl, viewIn3D, addPicked, earlyPick, openFile, openListed, wireHistory };`)(
    app, (id) => dom[id], (t) => o.shown.push(t), new Set(['loading', 'tessellating']), (f) => frames.push(f), (n) => String(n), 'IDLE', 2 * 2 ** 30, params,
    loc, doc, { addEventListener: (ev, fn) => { listeners[ev] = fn; } }, fetchFake, fetchModelLists, (e) => { app.listEntries = e; }, entryByName, fileUrl,
    readCapped, parseTour, MAX_TOUR_BYTES, async () => 'could not be read', fakeLoad, () => { o.tour = true; o.events.push('tour'); }, () => {},
    (t, f, d) => o.progress.push(`${d}${dom.pcancel.hidden ? ', no Cancel' : ''}`), () => {}, (on) => { o.embedActive = on; },
    () => { o.views++; }, () => ({ view: 1 }), orientOrNull, isCompanion, null, { error() {} }, modelUrlFrom, modelNameFrom, () => null,
    posterAsked, fetchFake, () => { o.released++; return 0; }, isRelative, listedUrlFrom, isTimeout, answeredFrom,
    (u, url) => { loc.search = `?model=${encodeURIComponent(url)}`; }, { pushState() {}, replaceState() {}, back() {}, state: null }, () => {});
  try {
    if (typeof run.wireHistory === 'function') run.wireHistory();
    const early = c.early ? run.earlyPick(c.early) : null;
    await run.startFromUrl(early);
    await settle(c.settle || 40);
    for (const d of [].concat(c.after || [])) { await safe(d); await settle(40); }
    for (const f of frames.splice(0)) f();
  } catch (e) { o.threw = e.message; }
  o.status = app.status;
  o.msg = app.statusMsg;
  o.card = [!dom.empty.hidden, dom.emptyerr.hidden ? '' : dom.emptyerr.textContent];
  o.posterUp = !dom.poster.hidden;
  return o;
}
