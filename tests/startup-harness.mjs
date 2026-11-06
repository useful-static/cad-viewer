// main.js's own start from the address, run in node: startFromUrl, openStart, viewIn3D, earlyPick,
// addPicked, openListed and the history (Back, #view=), with every function they reach cut from
// js/main.js as written, and the load's own rules (LOAD_RULES) run where the load runs them. One case
// runs and returns what was seen. The start-up table (tests/test-scene.mjs START_CASES) states
// per-case answers through it; the generated sweep (tests/test-startup-sweep.mjs) states invariants
// (r57). What stands in for main.js, and what it leaves out (r59 A7, Q6):
// - the network (fetch): served paths, timeouts, redirects, each answered a few ticks on; the lists
//   read early, as js/early.js reads them, while the GPU starts (earlyLists), the model's early
//   download not (each model is "loaded" by fakeLoad, below);
// - main() itself: its GPU start is a few ticks; an act's moment comes once it is past them;
// - the load's own work (fakeLoad): numbered, "loading", then the model shown, a failure thrown; a
//   device file shown with no URL (sourceUrl null), as main.js shows it; nothing drawn;
// - the browser's history and address: a stack of entries, Back / Forward / go(n) firing popstate
//   and, when the fragment alone changed (the rest of the address the same), hashchange, as Chromium
//   does; a #view= edit a new entry, firing both;
//   a reload (the visitor's, or location.reload()) ends the run with the history kept, every entry
//   with its state; the next page is a new run on that history (c.prior), the sweep's runStart
//   chaining them -- the old page's timers still run, writing nothing (r64 Q3);
// - a view (decodeView / applyView): the fragment's text itself, so which view landed is seen;
// - the DOM: elements that take what is set; the parts tree and the renderer not at all.
//
// A case:
// - q, hash: the address;
// - serve: path -> body, or 'TIMEOUT' / 'BODY-TIMEOUT'; a path not served answers 404;
// - redirect: path -> the path that answered;
// - fails: the model files whose load fails;
// - slow: paths read or loaded slowly;
// - files: the model paths served (any other a 404);
// - early: the files picked while the GPU starts;
// - during: [{ at, act... }], where at is a path read, a model file loaded, 'loaded <file>', or
//   'model' (the first model the address loads). An act is one of: file / size (the visitor opens
//   a file), click (View in 3D), add (Add model…), pick (a list entry, by place, through the
//   select's own rule), back / forward (the history), hash (a #view= edit), unhash (the #view=
//   taken out), cancel (the card's Cancel), unit ("this file is in"), reload (the visitor's).
// - prior: { stack: [{ href, state }], at }, the history a reloaded page starts on (its entry the
//   address q and hash).
// - after: [act...], the same acts once the start has settled.
// Stand-ins this header does not otherwise name: a tour takes no camera (its steps here have no
// view of their own); a load's failure is one sentence with its path, not the page's words and
// hint; a model's unit is the one its address asks for (addressUnit), else millimetres -- its file
// says nothing of its own (r61 Q8, Q9); "this file is in" is main.js's own setMeshUnit, its re-read
// (meshFromSource) stood in for by the same file shown again, the load's rules run, then read in the
// unit -- no new header, nothing parsed (r64 A4); a tour ends (endTour) as an event, nothing put back.

import { readFileSync } from 'node:fs';
import { answeredFrom, entryByName, fetchModelLists, isRelative, isTimeout, listedUrlFrom, modelNameFrom, modelUrlFrom, posterAsked, readCapped } from '../js/model-list.js';
import { fileUrl } from '../js/open-url.js';
import { MAX_TOUR_BYTES, parseTour } from '../js/tour.js';
import { orientOrNull } from '../js/orient.js';
import { isCompanion } from '../js/formats.js';
import { MM_PER } from '../js/units.js';

export const SITE = 'https://site.example/v/';

const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
// (a cut whose head main.js no longer has is named, and the run refused, not cut to nothing in
// silence -- a reflowed line made the sweep report a page fault: r61 A6. The fallbacks for an older
// main.js are optional; CV_HARNESS_OLD=1 runs an older main.js with what it has.)
const MISSING = [];
const miss = (head, optional) => { if (!optional) MISSING.push(head); return ''; };
const cutIf = (head, optional = false) => { const at = src.indexOf(head); return at < 0 ? miss(head, optional) : src.slice(at, src.indexOf('\n}\n', at) + 2); };
const line = (head, optional = false) => { const at = src.indexOf(head); return at < 0 ? miss(head, optional) : src.slice(at, src.indexOf('\n', at) + 1); };
// (these three refuse a missing head too: they cut nothing in silence -- a Cancel moved made every
// Cancel act do nothing, and a reworded announce reported a page fault: r62 Q7)
const arrow = (head) => { const at = src.indexOf(head); return at < 0 ? miss(head) : src.slice(at, src.indexOf('\n};\n', at) + 4); };
// (addToScene's own tail, after its scene is shown: what it does once a model has joined -- the
// harness called landPendingView itself, and a mutant that took it out of addToScene passed: r60)
const ADD_TAIL = (() => {
  const head = '  announce(`${name} added: ${models.length} models in the view`);\n';
  const at = src.indexOf(head);
  return at < 0 ? miss(head) : src.slice(at + head.length, src.indexOf('\n}\n', at));
})();
// (a block inside a function, from its head to its own close two spaces in)
const block = (head, optional = false) => { const at = src.indexOf(head); return at < 0 ? miss(head, optional) : src.slice(at, src.indexOf('\n  }\n', at) + 5); };
// The load's own rules, run where the real load runs them (the stand-in skipped them, and a view a
// page opens with, and a list entry's own tour, were never seen: r58 A6, Q4): a new open resets the
// entry's keys (loadUrl); the view link's view applies at the load (loadBuffer); the entry's own tour
// plays, or is held back (applyListEntry).
const LOAD_RULES = 'function loadOpens() {\n' + line('  if (!app.startingAdd) { app.autoTourFor = null;') + '}\n'
  // (the rule as round 57 wrote it, for a run on that code)
  // (the address forgets its model when a device file shows, as loadBuffer has it -- the harness kept
  // it, and every Back and #view= after a drop read the address's model: r60 A6, the differential)
  // (and the address's ?unit= rewritten as loadBuffer rewrites it, before the model's unit is read --
  // the first entry's text changed under it, which Back compared: r61 A1)
  // (twice, as the page does: once before the model's unit is read -- ?unit= dropped --, once after,
  // the unit the address asked for this model read and put back, at the address's end: r61, the
  // differential)
  + 'let unitRead = \'mm\';\nfunction readUnit() { return unitRead; }\n'
  // ("this file is in": the shown model read in another unit, its ?unit= written as the re-read writes it)
  + 'function setUnitRead(u) { unitRead = u; syncUnitParam(); }\n'
  // (main.js's own setMeshUnit runs it -- its rules, the wait for the ?add=s and the tour ended, were
  // the harness's copy, which a mutant taking the wait out of main.js passed: r64 A4 -- with the
  // re-read stood in for: the same file loaded again, the load's rules run, then read in the unit)
  + 'function endTour() { app.tour = null; tourEnded(); }\n'
  + 'async function meshFromSource(s, unit, seq) { return fakeReread(s, unit, seq, { stale, setStatus, readyText, loadShown, entryShown, setUnitRead }); }\n'
  + 'function loadShown() {\n  const asked = addressUnit(app.sourceUrl);\n  forgetAddressModel();\n  unitRead = \'mm\';\n  syncUnitParam();\n  unitRead = asked;\n  syncUnitParam();\n' + (src.includes('function landPendingView() {') ? '  landPendingView();\n' : block('  if (!app.addsPending && pendingViewIsFor()) {', true) || block('  if (app.pendingView && !app.addsPending && viewIsFor(app.pendingView.src)) {', true)) + '}\n'
  + 'function entryShown() {\n  const e = app.header ? listEntry(app.sourceUrl) : null;\n' + block('  if (app.header && app.autoTourFor !== autoTourKey()) {')
  // (and its hidden parts, held back as its tour is: r59 Q4)
  + block('  if (app.header && e && e.hide && app.listHideFor !== autoTourKey()') + '}\n';
const BODY = line('let saySeq = 0') + line('let listPick = 0') + LOAD_RULES + [src.includes('async function viewIn3D(src) {') ? 'async function viewIn3D(src) {' : 'function viewIn3D(src) {',
  'async function startFromUrl(early) {', 'async function startFromAddress(early) {', 'function applyLinkView(view) {', 'function addPicked(files) {',
  'async function readLists(lists, openFirst) {', 'function listsRead(r, openFirst) {', 'function loadListed(url) {', 'function startLoad(fn) {',
  'function guard(p, seq = null) {', 'function beginLoad() {', 'function stale(seq) {', 'function announce(text) {', 'function sayNow(text) {',
  'function tell(text, ms = 1500, said = text) {', 'function tellReady(words, ms = 6000) {', 'function setStatus(s, msg) {', 'function readyText() {',
  'function failApart(msg', 'function showEmpty() {', 'function openFile(f', 'function refusedForSize(f) {', 'function modelUrlIn(search) {',
  'async function readTour(url) {', 'function listEntry(src) {', 'function listedNow() {', 'function forgetAddressModel() {', 'function dropAddressModel(u) {', 'function syncUnitParam() {', 'function addressUnit(url) {',
  src.includes('async function unwindPick(c) {') ? 'async function unwindPick(c) {' : 'async function unwindPick(n, before) {',
  'function setPendingView(search, hash) {', 'function landPendingView() {', 'function startAdd(fn) {', 'function pickModelFile(files) {',
  'function startUpLoad(url) {', 'function openStart(src) {', 'function rewriteReady(change) {', 'function tourOver() {', 'function tourReadyNote() {',
  'function openListed(url, refocus = false, keepMenu = false) {', 'function wireHistory() {', 'function addressTourEnds(r, ownFailed) {',
  'function viewIsFor(search) {', 'function linkViewOf(hash) {', 'function setModelParam(u, url) {', 'function setMeshUnit(u) {',
  src.includes('function lackingNote(place, opened) {') ? 'function lackingNote(place, opened) {' : 'function lackingNote(place, firstOpens) {'].map((h) => cutIf(h)).join('')
  + line('const tourPlaysHere = ') + line('const addressModel = ') + line('const viewIsFor = ', true) + line('const MODEL_PARAMS = ') + line('const ADDRESS_MODEL_PARAMS = ')
  + line('const pendingViewIsFor = ') + line('const linkViewOver = ')
  + line('const listNote = ') + line('const posterUp = ') + line('function somethingShown() {')
  + line('const autoTourKey = ') + line('const unitName = ') + line('const newPageId = ') + line('const ownEntry = ') + line('const otherPages = ') + line('const nextEntry = ', true) + line('const earlyPick = ') + line('const untouched = ') + line('const idleText = ')
  + line('const POSTER_MSG = ') + line('const oversizeText = ') + line('const companionsOf = ')
  + (src.includes('modelNameFrom(search') ? line('const modelNameIn = ') : arrow('const modelNameIn = '))
  // (as the real ones: a URL brings no companions; a file takes those its pick kept for it)
  + 'async function loadUrl(url) { loadOpens(); return fakeLoad(url, { beginLoad, stale, setStatus, readyText, loadShown, entryShown, addShown, readUnit }, [], false); }\n'
  + 'async function loadFile(f, extras = companionsOf.get(f) || []) { return fakeLoad(f.name, { beginLoad, stale, setStatus, readyText, loadShown, entryShown, addShown, readUnit }, extras, true); }\n'
  + `function addShown() {\n${ADD_TAIL}\n}\n`;

// (Cancel on the load's card, as main.js wires it)
const CANCEL = (() => { const head = "  $('pcancel').onclick = () => {"; const at = src.indexOf(head); return at < 0 ? miss(head) : src.slice(at, src.indexOf('\n  };\n', at) + 5); })();

const tick = () => new Promise((res) => setTimeout(res, 1));
const settle = async (n) => { for (let i = 0; i < n; i++) await tick(); };

export async function runStart(c) {
  if (MISSING.length && !process.env.CV_HARNESS_OLD) throw new Error(`startup-harness: main.js has no ${MISSING.map((h) => JSON.stringify(h.trim())).join(', ')} -- a cut's head changed`);
  const params = new URLSearchParams(c.q);
  const app = { status: 'init', statusMsg: 'starting GPU', mesh: null, dxf: null, header: null, embed: params.get('embed') === '1', loadSeq: 0,
    listEntries: null, listNote: '', unmeshedFaces: 0, noFacts: null, hidden: new Set(), backend: 'webgl2', scene: null, cam: { orient: 'z' } };
  // events: the visitor's acts and the address's tour starting, in order; pendingAtList: each list
  // entry shown, with the address's tour still pending or not then (applyListEntry holds a list
  // model's own tour back while it is)
  const o = { shown: [], opened: [], loadedUrls: [], progress: [], cancelHidden: [], acted: [], events: [], pendingAtList: [], tour: false, views: 0,
    released: 0, embedActive: false, threw: null, app };
  // (a window's listeners, each type a list, `once` kept: unwindPick waits on a popstate of its own)
  const frames = [], listeners = {};
  const listen = (ev, fn, opt) => { (listeners[ev] ||= []).push({ fn, once: !!(opt && opt.once) }); };
  const emit = (ev) => {
    const ls = listeners[ev] || [];
    listeners[ev] = ls.filter((l) => !l.once);
    for (const l of ls) l.fn();
  };
  const el = () => ({ textContent: '', title: '', dataset: {}, hidden: false, before() {}, classList: { add() {}, remove() {} } });
  const dom = new Proxy({ poster: { hidden: true } }, { get: (t, k) => (k in t ? t[k] : (t[k] = el())) });
  o.dom = dom;
  const doc = { querySelector: () => el(), createElement: () => el(), documentElement: { classList: { add() {} } } };
  const serve = c.serve || {};
  // (the address and the history, as a browser keeps them: entries pushed and replaced, Back to the
  // one before firing popstate and, when the fragment differs, hashchange; a fragment edited in is a
  // new entry, firing both -- r59 A7, Q2, Q6)
  let cur = new URL(`${SITE}?${c.q}${c.hash || ''}`);
  // (a reload -- the visitor's, or the page's for an entry another page wrote -- ends this page: the
  // history as it was then is kept, and nothing the old page still runs changes it; the sweep opens
  // the entry shown again on that history, c.prior -- r64 Q3)
  const reloadNow = () => { if (o.reloaded) return; o.reloaded = true; o.frozen = { stack: stack.map((e) => ({ ...e })), at, href: cur.href }; };
  const loc = { get href() { return cur.href; }, get search() { return cur.search; }, get hash() { return cur.hash; }, reload: reloadNow };
  // (the history a run starts on: its own entry alone, or the entries a page before a reload left)
  const stack = c.prior ? c.prior.stack.map((e) => ({ ...e })) : [{ state: null, href: cur.href }];
  let at = c.prior ? c.prior.at : 0;
  if (c.prior && stack[at].href !== cur.href) throw new Error(`startup-harness: c.prior's entry ${stack[at].href} is not the address ${cur.href}`);
  // (hashchange only when the fragment alone changed, the rest of the address the same, as Chromium
  // fires it -- measured: an entry differing in search and fragment fires popstate alone; the
  // harness fired both: r60 Q2)
  const fire = (hrefBefore) => {
    const was = new URL(hrefBefore);
    emit('popstate');
    if (cur.hash !== was.hash && cur.search === was.search) emit('hashchange');
  };
  const history = {
    get state() { return stack[at].state; },
    pushState(state, _t, u) { if (o.reloaded) return; stack.splice(at + 1); cur = new URL(String(u), cur); stack.push({ state, href: cur.href }); at++; },
    replaceState(state, _t, u) { if (o.reloaded) return; cur = new URL(String(u), cur); stack[at] = { state, href: cur.href }; },
    // (n entries on, or back: back past the first entry leaves the page, as from a fresh tab; past the
    // last, nothing -- r60 Q5 Forward, r62 go)
    go(n) {
      if (o.reloaded) return;
      if (at + n < 0) { o.left = true; o.leftBy = o.acting ? 'visitor' : 'page'; return; }
      if (!n || at + n > stack.length - 1) return;
      const before = cur.href;
      at += n;
      cur = new URL(stack[at].href);
      setTimeout(() => fire(before), 0);
    },
    back() { history.go(-1); },
    forward() { history.go(1); },
  };
  let run = null, modelSeen = false;
  const loadsOf = {};
  const act = (d) => {
    o.acted.push(d); // (an act set for a moment that never comes -- no model loads -- is not one)
    // (a pick needs an entry to pick: before the list has answered there is none)
    // (a pick's event once it is made, or not: it waits for its entry -- below)
    if (!d.pick) o.events.push(d.add ? `add${app.scene ? '' : ' (no scene)'}`
      : d.click ? 'click' : d.back ? 'back' : d.forward ? 'forward' : d.reload ? 'reload' : d.hash ? 'hash' : d.unhash ? 'unhash' : d.cancel ? 'cancel' : d.unit ? (app.header && app.meshSource && app.meshSource.unit !== d.unit && app.addsPending && app.addsChain ? 'unit while adds wait' : app.header && app.meshSource && app.meshSource.unit !== d.unit && !(app.addsPending && app.addsChain) && o.opening != null && o.opening === app.loadSeq ? 'unit while another opens' : 'unit') : `file ${d.file}`);
    if (d.click) return dom.posterload.onclick && dom.posterload.onclick();
    // (Add model… with one name, or the files a case picks)
    if (d.add) return run.addPicked([].concat(d.add).map((a) => (typeof a === 'string' ? { name: a, size: d.size || 10 } : a)));
    // (through the select's own rule: a pick of the model shown or opening is nothing -- the harness
    // opened it all the same, and pushed an entry the page never does: r60, the differential)
    // (the history as it was before the first pick, for the take-back's check: I20)
    if (d.pick && !o.pickSnap) o.pickSnap = { stack: stack.map((s) => s.href), at };
    // (from the drop-down, which fills when the list answers: the visitor waits for the entry, a
    // while -- ui-diff's page waits at most 1.5 s; picked at once, the page's pick before a
    // redirected list's answer was nothing: r66)
    if (d.pick) {
      return (async () => {
        for (let k = 0; k < 40 && !app.listEntries?.[d.pick - 1]; k++) await tick();
        const e = app.listEntries?.[d.pick - 1];
        o.events.push(e ? 'pick' : 'pick (no entry)');
        if (!e) return null;
        return e.url !== run.listedNow() && run.openListed(e.url);
      })();
    }
    // (Back: the entry before, as the history keeps it -- with its #view=, r58 Q4)
    if (d.back) { o.acting = true; try { return history.back(); } finally { o.acting = false; } }
    if (d.forward) return history.forward();
    // (the visitor's reload: this page ends, the history kept -- r64 Q3)
    if (d.reload) return reloadNow();
    // (a #view= edited into the address: a new entry, popstate then hashchange)
    if (d.hash) { const before = cur.href; cur = new URL(cur); cur.hash = '#view=v2'; history.pushState(null, '', cur.href); return fire(before); }
    // (the #view= taken out of the address: a new entry, as an edit is -- r60 A4)
    if (d.unhash) { const before = cur.href; cur = new URL(cur); cur.hash = ''; history.pushState(null, '', cur.href); return fire(before); }
    // ("this file is in": another unit for the model shown -- r62 Q2)
    // (as setMeshUnit: after the address's ?add=s, the tour ended, the model read in the unit -- the
    // re-read itself, a load of the same bodies, stood in for by syncUnitParam: r63 A3, Q6)
    // (main.js's own setMeshUnit, the units row's handler: shown only while a model is -- r64 A4)
    // (andThen: a second choice in the same task, the first's re-read just begun -- r66 A2)
    if (d.unit) {
      if (!app.header) return null;
      const first = run.setMeshUnit(d.unit);
      return d.andThen ? Promise.all([first, run.setMeshUnit(d.andThen)]) : first;
    }
    // (Cancel on the load's card, as wired)
    if (d.cancel) return dom.pcancel.onclick && dom.pcancel.onclick();
    return run.openFile({ name: d.file, size: d.size || 10 });
  };
  // (an act's own throw, or its promise's, is the run's: recorded, not the process ended)
  const safe = (d) => { try { return Promise.resolve(act(d)).catch((e) => { o.threw ||= e.message; }); } catch (e) { o.threw ||= e.message; return null; } };
  // (each "during" act once: a moment that comes again -- Back reloading the act's file -- looped: r60 Q8)
  const fired = new Set();
  // (the page wired -- main() past its GPU start --: an act's moment comes no sooner, as in the page,
  // where js/early.js reads before main.js has wired a thing; a read whose moment it is waits to
  // answer until the act is done, as tests/ui-diff.py holds it -- r60, the differential)
  let wired = null;
  const wiredP = new Promise((res) => { wired = res; });
  // (js/early.js's read of the lists, taken once by readLists: earlyLists)
  const listsQ = params.getAll('list');
  let earlyRead = null;
  const earlyListsOf = (urls) => {
    if (!earlyRead || urls.join('\n') !== listsQ.join('\n')) return null;
    const r = earlyRead;
    earlyRead = null;
    return r;
  };
  const visit = (at) => {
    const ds = [].concat(c.during || []).filter((d) => d.at === at && !fired.has(d));
    for (const d of ds) fired.add(d);
    if (!ds.length) return null;
    // (a task on, as a page act comes: what the start does at once -- readLists taking the early
    // read -- is done by then)
    return wiredP.then(() => new Promise((res) => setTimeout(() => { for (const d of ds) if (!o.reloaded) safe(d); res(); }, 0)));
  };
  const fetchFake = async (u) => {
    const path = String(u).startsWith(SITE) ? String(u).slice(SITE.length) : String(u);
    const acting = visit(path);
    // (a read that times out gives up after its limit: later than a slow answer, as in the page --
    // 900 ms against 600 --, so a model shown meanwhile is shown when it does. It gave up in 3
    // ticks, before a model loaded, and its note went to the status line alone where the page also
    // told it: r66, the differential)
    await settle(serve[path] === 'TIMEOUT' ? 35 : (c.slow || []).includes(path) ? 30 : 3);
    if (acting) { await acting; await settle(1); }
    if (serve[path] === 'TIMEOUT') { const e = new Error('signal timed out'); e.name = 'TimeoutError'; throw e; }
    if (serve[path] === 'BODY-TIMEOUT') {
      return new Response(new ReadableStream({ start(ctl) { ctl.error(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })); } }), { status: 200 });
    }
    if (!(path in serve)) return new Response('', { status: 404 });
    const res = new Response(serve[path], { status: 200 });
    if (c.redirect && c.redirect[path]) Object.defineProperty(res, 'url', { value: SITE + c.redirect[path] });
    return res;
  };
  // (the harness's own knowledge of a model opening: the newest load it began, until that load ends --
  // the "this file is in" act's event read main.js's guard restated, PROGRESS_STATES and rereadSeq,
  // which judged the page by its own rule: r66 A8)
  const fakeLoad = async (url, k, extras, fromFile) => {
    const adding = !!app.startingAdd;
    o.loadedUrls.push(String(url));
    o.events.push(`load ${String(url).split('/').pop()}`);
    const seq = k.beginLoad();
    o.opening = seq;
    try { return await loadBody(url, k, extras, fromFile, adding, seq); } finally { if (o.opening === seq) o.opening = null; }
  };
  const loadBody = async (url, k, extras, fromFile, adding, seq) => {
    if (dom.pcancel.hidden) o.cancelHidden.push(String(url));
    const file = String(url).split('/').pop();
    o.opened.push(fromFile && extras.length ? [file, ...extras.map((x) => x.name)].join('+') : file);
    k.setStatus('loading', `downloading ${file}`);
    visit(file);
    // (and its nth load's own moment, "<file>#n": a retry of a failed model -- r63 Q1)
    loadsOf[file] = (loadsOf[file] || 0) + 1;
    visit(`${file}#${loadsOf[file]}`);
    if (!fromFile && !adding && !modelSeen) { modelSeen = true; visit('model'); }
    await settle((c.slow || []).includes(file) ? 30 : 2);
    if (k.stale(seq)) return;
    // (the failure names the path tried, as the page's does -- not the file alone, which made a 404 from
    // the wrong directory compare equal to one from the right: r61 Q8; the page's hint after it is its
    // own words, not stood in for)
    const path = String(url).startsWith(SITE) ? String(url).slice(SITE.length) : String(url);
    if ((c.fails || []).includes(file)) throw new Error(`could not download ${path}: not found (404)`);
    // (a model at a URL nothing serves is not found, as the network says: c.files, the model paths
    // served -- a list or tour resolved against the wrong base loaded all the same: r58 Q4)
    if (!fromFile && c.files && !c.files.includes(path)) { o.events.push(`missing ${path}`); throw new Error(`could not download ${path}: not found (404)`); }
    // (an added model at the offset its ?addat= gave; a device file shown with no URL, as main.js
    // shows it -- the stand-in named it, and a view meant for a named model passed as a device
    // file's: r59 A7)
    // (the scene's header made anew for the scene with it, as showScene makes it: r59 A6)
    // (and, as showScene does, the tour over the scene ended and the camera put back to the preset:
    // a model joining ends a tour, and the view a link set is gone -- r60, the differential)
    // (a model shown or joining ends the tour, as loadBuffer and showScene do; a unit-less mesh alone
    // keeps its bytes for a re-read in another unit -- meshFromSource --, a scene none: r64 A4)
    app.tour = null;
    if (adding) {
      app.meshSource = null;
      app.scene.push({ url, at: app.addOffset ? app.addOffset.join(',') : null });
      app.header = { meshes: app.scene.map(() => ({})) };
      o.events.push('added');
      k.addShown(); // (addToScene's end: a view waiting lands on the scene -- r60 A3)
    }
    else Object.assign(app, { header: { meshes: [{}] }, mesh: {}, scene: [{ url }], sourceUrl: fromFile ? null : url });
    if (!adding && (app.listEntries || []).some((e) => e.url === url)) o.pendingAtList.push([file, !!app.urlTourPending]);
    if (!adding) { o.events.push(`shown ${file}`); k.loadShown(); app.meshSource = { name: file, unit: k.readUnit() }; }
    k.setStatus('ready', k.readyText());
    if (!adding) k.entryShown();
    visit(`loaded ${file}`);
  };
  // the re-read of "this file is in" (meshFromSource), seq already begun by setMeshUnit: the same
  // file shown again, the load's rules run, then the unit it was read in (r64 A4)
  const fakeReread = async (s, unit, seq, k) => {
    o.events.push(`reread ${s.name}`);
    // (its own moment, "reread <file>": a second choice made during it -- r66 A2)
    visit(`reread ${s.name}`);
    k.setStatus('loading', `reading ${s.name} in ${unit}`);
    await settle((c.slow || []).includes(s.name) ? 30 : 2);
    if (k.stale(seq)) return;
    // (the tour is main.js's to end, setMeshUnit's endTour -- ended here too, a mutant taking that
    // out of main.js passed: r66 Q5)
    // (the model shown again: loadBuffer sets the view to its preset, as at any load -- the link's
    // view the start landed is gone; the harness kept it, and 22 runs differed: r66, the differential)
    o.events.push(`reshown ${s.name}`);
    k.loadShown();
    k.setUnitRead(unit);
    app.meshSource = { ...s, unit };
    k.setStatus('ready', k.readyText());
    k.entryShown();
  };
  run = new Function('app', '$', 'flashHover', 'PROGRESS_STATES', 'requestAnimationFrame', 'fmtInt', 'IDLE_MSG', 'MAX_FILE_BYTES', 'params',
    'location', 'document', 'window', 'fetch', 'fetchModelLists', 'fillModelList', 'entryByName', 'fileUrl', 'readCapped', 'parseTour', 'MAX_TOUR_BYTES',
    'fetchFailedText', 'fakeLoad', 'startTourIn', 'syncModelList', 'showProgress', 'syncMenuButtons', 'setEmbedActive', 'applyView', 'decodeView',
    'orientOrNull', 'isCompanion', 'gaveUp', 'console', 'modelUrlFrom', 'modelNameFrom', 'earlyLists', 'posterAsked', 'timedFetch', 'releaseEarly',
    'isRelative', 'listedUrlFrom', 'isTimeout', 'answeredFrom', 'history', 'closeMenus', 'tourParts', 'syncTreeChecks', 'pushState', 'updateButtons',
    'viewChanged', 'shownLacksGpu', 'MM_PER', 'tourEnded', 'fakeReread',
    `${BODY}; function wireCancel() { ${CANCEL} }
    return { startFromUrl, viewIn3D, addPicked, earlyPick, openFile, openListed, wireHistory, entryShown, wireCancel, listedNow, setMeshUnit, unitNow: () => unitRead };`)(
    app, (id) => dom[id], (t) => o.shown.push(t), new Set(['loading', 'tessellating']), (f) => frames.push(f), (n) => String(n), 'IDLE', 2 * 2 ** 30, params,
    // (the list filled: the entry's rules for a model already shown, as fillModelList runs them --
    // a list answering after its model never played the entry's tour: r59 Q6)
    loc, doc, { addEventListener: listen }, fetchFake, fetchModelLists, (e) => { app.listEntries = e; if (app.header) run.entryShown(); }, entryByName, fileUrl,
    // (a tour started: the address's ?tour= or a list entry's own, by the file it came from)
    readCapped, parseTour, MAX_TOUR_BYTES, async () => 'could not be read', fakeLoad, (t, u) => { o.tour = true; app.tour = { url: u }; o.events.push(`tour ${String(u || '').split('/').pop()}`); }, () => {},
    (t, f, d) => o.progress.push(`${d}${dom.pcancel.hidden ? ', no Cancel' : ''}`), () => {}, (on) => { o.embedActive = on; },
    // (a view: the fragment's own text, so which one landed is seen)
    (v) => { o.views++; o.events.push(`view ${v}`); }, (s) => s, orientOrNull, isCompanion, null, { error() {} }, modelUrlFrom, modelNameFrom, earlyListsOf,
    posterAsked, fetchFake, () => { o.released++; return 0; }, isRelative, listedUrlFrom, isTimeout, answeredFrom,
    history, () => {}, () => ({ ids: ['hidden-part'] }), () => {}, () => {}, () => {}, () => { o.events.push('hide'); }, () => false, MM_PER, () => o.events.push('tour-end'), fakeReread);
  try {
    if (typeof run.wireHistory === 'function') run.wireHistory();
    run.wireCancel();
    // (js/early.js reads the address's lists before main.js has started: while the GPU starts, the
    // list is read -- the harness read it only from startFromUrl, and a pick during the tour's read
    // found no entry the page had: r60, the differential)
    if (listsQ.length) earlyRead = fetchModelLists(listsQ, loc.href, fetchFake);
    await settle(5); // (the GPU starting)
    wired();
    const early = c.early ? run.earlyPick(c.early) : null;
    await run.startFromUrl(early);
    await settle(c.settle || 40);
    // (to a reload: the acts after it are the next page's -- o.afterDone, how many ran here)
    o.afterDone = 0;
    for (const d of [].concat(c.after || [])) { if (o.reloaded) break; o.afterDone++; await safe(d); await settle(40); }
    for (const f of frames.splice(0)) f();
  } catch (e) { o.threw = e.message; }
  o.status = app.status;
  o.msg = app.statusMsg;
  o.card = [!dom.empty.hidden, dom.emptyerr.hidden ? '' : dom.emptyerr.textContent];
  o.posterUp = !dom.poster.hidden;
  o.href = cur.href; // (the address at the end)
  o.entries = stack.length; // (the history's entries, as many as the page's: r61 A3)
  o.stack = stack.map((e) => e.href); // (and their addresses)
  o.at = at; // (and the one shown)
  // (a page that reloaded: its history as it was then, every entry with its state, for the next page)
  if (o.reloaded) Object.assign(o, { href: o.frozen.href, stack: o.frozen.stack.map((e) => e.href), at: o.frozen.at, entries: o.frozen.stack.length, prior: { stack: o.frozen.stack, at: o.frozen.at } });
  o.unitRead = run && run.unitNow ? run.unitNow() : 'mm'; // (the unit the model shown was read in: I23, r64 A4)
  return o;
}
