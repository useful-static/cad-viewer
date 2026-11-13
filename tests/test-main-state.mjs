#!/usr/bin/env node
// main.js's own code, cut out of it as written and run with stand-ins, for state that crosses an
// await or outlives the action that set it (round 117's main.js review):
//  - tourPictures stops where the tour ends (the maker closed, Esc, another model) and keeps the
//    pictures taken; it threw on the ended tour and saved nothing (r117 M1)
//  - an address add's ?addat= offset is that add's own: one that never arrived does not move the
//    visitor's next Add model… (r117 M2)
//  - a unit-less mesh's reading is on the scene as loadBuffer makes it, so its list entry's notes,
//    placed inside the load, scale to it (r117 M3)
//  - the scene's "missing faces" are every model's, an added STEP's too (r117 M4)
//
//   node tests/test-main-state.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readingScale } from '../js/tour.js';
import { test, done } from './harness.mjs';

const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
// a top-level function, from its head to the first "\n}\n" after it
const cut = (head) => { const i = src.indexOf(head); if (i < 0) throw new Error(`main.js has no ${head}`); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
// one line, from its start
const line = (head) => { const i = src.indexOf(head); if (i < 0) throw new Error(`main.js has no ${head}`); return src.slice(i, src.indexOf('\n', i)); };

await test('tourPictures: the tour ended while step 2\'s picture is taken -- no throw, step 1\'s picture zipped and saved (r117 M1)', async () => {
  const code = [cut('async function tourPictures(tour) {'), cut('function showTourStep(i) {'), cut('function endTour(restore = true) {')].join('\n')
    .replace("await import('./export-mesh.js')", 'await importExport()');
  const el = () => ({ textContent: '', hidden: false, disabled: false, classList: { add() {}, remove() {} } });
  const els = {};
  const app = { tour: null, header: { meshes: [1] }, explode: { on: false }, renderer: {}, measure: null, tourRaf: 0, cam: { ortho: false } };
  let renders = 0, zipped = null, saved = null, endTourRef = null;
  const env = {
    $: (id) => (els[id] ||= el()), app,
    startTourIn: (tour) => { app.tour = { tour, i: 0, saved: null, base: { styleChoice: null, explode: { t: 0, mode: null } }, playing: false }; },
    setTourPlaying() {}, applyStepState() {}, stepPose: () => null, flyTo() {}, tellStepMissing() {}, announce() {},
    cancelFlight() {}, setExplode() {}, setExplodeMode() {}, holdStep() {}, topOfBox() {}, drawnBox() {}, tourParts: () => ({ ids: [] }),
    nextFrame: () => new Promise((r) => setTimeout(r, 1)), gpuSync: () => Promise.resolve(),
    // step 2's picture: while it renders, the visitor closes the tour maker (stopPreview -> endTour)
    renderPicture: async () => {
      renders++;
      if (renders === 2) setTimeout(() => endTourRef(), 0);
      await new Promise((r) => setTimeout(r, 5));
      return { canvas: { width: 1, height: 1, getContext: () => ({}), toBlob: (ok) => ok({ arrayBuffer: async () => new ArrayBuffer(1) }) }, scale: 1 };
    },
    paintCaption() {}, slugOf: (s) => s,
    importExport: async () => ({ zip: async (files) => { zipped = files.map((f) => f[0]); return new Uint8Array(1); } }),
    downloadBlob: (b, name) => { saved = name; },
    Blob: class { constructor(parts, o) { this.parts = parts; this.o = o; } },
  };
  const { tourPictures, endTour } = new Function(...Object.keys(env), `${code}\nreturn { tourPictures, endTour };`)(...Object.values(env));
  endTourRef = endTour;
  const n = await tourPictures({ title: 't', steps: [{ title: 'a', text: '' }, { title: 'b', text: '' }, { title: 'c', text: '' }] });
  assert.equal(n, 1);
  assert.deepEqual(zipped, ['01-a.png']);
  assert.equal(saved, 't-pictures.zip');
  assert.equal(app.tour, null);
});

await test('an address add\'s offset (?addat=) is its own: one that never reached the scene leaves the next Add model… at the origin (r117 M2)', async () => {
  const app = { scene: [{ base: {}, name: 'case.stp', url: 'https://s/case.stp', offset: [0, 0, 0] }], sceneAsked: null, urlOfLoad: null, loadSeq: 7, adding: null };
  let shown = null;
  const env = {
    app, stale: (s) => s !== app.loadSeq, listEntry: () => null, sceneNow: () => app.sceneAsked || app.scene,
    sceneUnitsRefusal: () => null, setStatus() {}, showProgress() {}, fmtInt: String, nextPaint: async () => {},
    showScene: async (models) => { shown = models; return true; }, setView() {}, readyText: () => 'ready', announce() {}, landPendingView() {},
  };
  const addToScene = new Function(...Object.keys(env), `${cut('async function addToScene(')}\nreturn addToScene;`)(...Object.values(env));
  // the ?add=board.stl&addat=0,0,12 load, begun (seq 6) and never shown: a 404
  app.adding = { seq: 6, offset: [0, 0, 12] };
  // the visitor's own Add model…, seq 7: no offset of its own
  app.adding = { seq: 7, offset: null };
  await addToScene({ header: {} }, 'lid.stl', 7, 0);
  assert.deepEqual(shown[1].offset, [0, 0, 0]);
  assert.equal(app.adding, null);
  // and one that did carry its offset keeps it
  app.adding = { seq: 7, offset: [0, 0, 12] };
  await addToScene({ header: {} }, 'board.stl', 7, 0);
  assert.deepEqual(shown[shown.length - 1].offset, [0, 0, 12]);
});

test('a unit-less mesh read in inches: the note scale inside its load is 25.4, a mm one 1, a STEP 1 (r117 M3)', () => {
  const code = [line('const readUnit = () =>'), line('const tourReading = () =>'), line('  app.scene = [{ base, name, url: app.sourceUrl'), line('    const k = readingScale(tourReading());')].join('\n');
  const k = (reading) => new Function('app', 'readingScale', 'base', 'name', 'reading', 'unmeshedFaces', `${code}\nreturn k;`)({ sourceUrl: 'x' }, readingScale, {}, 'board.stl', reading, 0);
  assert.equal(k({ unit: 'in', unitless: true }), 25.4);
  assert.equal(k({ unit: 'mm', unitless: true }), 1);
  assert.equal(k(null), 1);
  assert.equal(k({ unit: 'in', unitless: false }), 1);
  // and meshFromSource hands loadBuffer the reading it read in
  assert.match(cut('async function meshFromSource('), /await loadBuffer\(raw, src\.name, seq, raw, null, \{ unit, unitless \}\)/);
});

test('the scene\'s missing faces are every model\'s: a first model with none and an added STEP with 3 read 3 (r117 M4)', () => {
  const sum = line('  app.unmeshedFaces = models.reduce(');
  const app = {};
  new Function('app', 'models', sum)(app, [{ unmeshed: 0 }, { unmeshed: 3 }]);
  assert.equal(app.unmeshedFaces, 3);
  new Function('app', 'models', sum)(app, [{ unmeshed: 2 }, {}]);
  assert.equal(app.unmeshedFaces, 2);
  // the added model carries its count into the scene, and loadBuffer gives it
  assert.match(src, /return addToScene\(base, name, seq, unmeshedFaces\)/);
  assert.match(cut('async function addToScene('), /offset: offset \? offset\.slice\(\) : \[0, 0, 0\], unmeshed \}/);
});

done();
