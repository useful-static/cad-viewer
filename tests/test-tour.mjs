#!/usr/bin/env node
// Tours (js/tour.js, js/tour-path.js):  node tests/test-tour.mjs  (exit 0 = all pass)
// The file format is checked both ways (the plan's example is read, each kind
// of mistake is refused naming its step and field); part names resolve by
// label, node, body and path; the camera flight starts and ends exactly on
// its poses and moves steadily between them.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCadmesh } from '../js/cadmesh.js';
import { parseTour, partIndex, readingScale, resolveParts, tourAt, tourNames, namesFor, DEFAULTS, DIMS, MODES, MAX_TOUR_BYTES, PART_NAME_MAX, PART_NAMES_MAX, RANGES } from '../js/tour.js';
import { checkTour } from '../js/list-check.js';
import { parseModelList } from '../js/model-list.js';
import { EXPLODE_MODES } from '../js/view-link.js';
import { EASE, poseAt, slerp, turnAngle } from '../js/tour-path.js';
import { CARRIED_FIELDS, draftToTour, stepFromView } from '../js/tour-recorder.js';
import { blockedShare, obstacleTree, clearestDirection, meshFaceBoxes, obstaclesFor, rayHitsBox } from '../js/tour-sight.js';

import { test, done } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// the plan's example, as written there
const EXAMPLE = {
  cadtour: 1,
  title: 'Le Potato: a tour of the board',
  model: 'https://libre.computer/products/aml-s905x-cc/AML-S905X-CC-V1.0.cadmesh.gz',
  mode: 'animated',
  loop: false,
  defaults: { transition: 1.2, hold: 4, ease: 'inOut', dim: 'ghost' },
  steps: [
    { title: 'Le Potato', text: 'A credit-card-sized computer: 85 × 56 mm.', view: 'iso', frame: 'all', orbit: 20 },
    { title: 'HDMI 2.0', text: '4K60 output.', frame: ['HDMI'], from: 'front', margin: 1.6,
      colour: { HDMI: '#ff8c1a' }, dim: 'ghost', callouts: [{ part: 'HDMI', text: 'HDMI 2.0' }] },
    { title: 'Four USB 2.0 ports', frame: ['USB 2.0 ×2'], from: 'left', colour: { 'USB 2.0 ×2': '#2f7bff' } },
    { title: 'Underneath', view: { cam: { target: [42, 28, 0], dist: 140, q: [0, 0.97, 0.24, 0], ortho: false } }, transition: 2.0, explode: 0.3 },
  ],
};

test('parse-example', () => {
  const t = parseTour(JSON.stringify(EXAMPLE));
  assert.equal(t.mode, 'animated');
  assert.equal(t.steps.length, 4);
  assert.equal(t.steps[0].hold, 4);
  assert.equal(t.steps[0].dim, 'ghost'); // the tour's default
  assert.equal(t.steps[3].transition, 2.0); // the step's own
  assert.deepEqual(t.steps[1].frame, ['HDMI']);
  assert.equal(t.steps[1].colour.HDMI, '#ff8c1a');
  // the quaternion normalised
  assert.ok(Math.abs(Math.hypot(...t.steps[3].view.cam.q) - 1) < 1e-12);
});

await test('a tour over MAX_TOUR_BYTES is refused before it is parsed, in words; checkTour stops reading at the cap', async () => {
  const big = '{"cadtour":1,"steps":[{"title":"' + 'x'.repeat(MAX_TOUR_BYTES) + '"}]}';
  assert.throws(() => parseTour(big), /over 4 MB/);
  // counted in bytes, as the page's read counts them: 1.8 M CJK characters are 5 MB
  const cjk = '{"cadtour":1,"steps":[{"title":"' + '漢'.repeat(1.8e6) + '"}]}';
  assert.ok(cjk.length < MAX_TOUR_BYTES);
  assert.throws(() => parseTour(cjk), /over 4 MB/);
  // a lone high surrogate before a 3-byte character is 3 + 3 bytes, not a 4-byte pair (which
  // skipped the next character: 6.3 MB of real bytes passed)
  const lone = '{"cadtour":1,"steps":[{"title":"' + '\ud800漢'.repeat(7e5) + '"}]}';
  assert.ok(lone.length < MAX_TOUR_BYTES);
  assert.throws(() => parseTour(lone), /over 4 MB/);
  // a streamed body: the reader is cancelled at the cap, not read whole
  let pulled = 0, cancelled = false;
  const chunk = new Uint8Array(2 ** 20).fill(32);
  const res = { ok: true, status: 200, body: { getReader: () => ({
    read: async () => { pulled++; return pulled > 64 ? { done: true } : { done: false, value: chunk }; },
    cancel: async () => { cancelled = true; } }) } };
  const r = await checkTour('https://example.org/t.cadtour.json', async () => res);
  assert.equal(r.level, 'bad');
  assert.match(r.detail, /over 4 MB/);
  assert.ok(cancelled && pulled <= 6, `read ${pulled} MB before refusing`);
});

test('one part-name limit for lists and tours: what a list allows, the tour maker writes and the parser takes', () => {
  const N = 1300;
  const header = { root: { name: '', meshes: [...Array(N).keys()], children: [] }, meshes: Array.from({ length: N }, (_, i) => ({ name: `part${i + 1}` })) };
  // a list hides 600 bodies; the maker names them in a step; the tour parses
  const hide = namesFor(Array.from({ length: 600 }, (_, i) => i + 1), header, partIndex(header));
  assert.equal(parseModelList(JSON.stringify({ 'a.stl': { name: 'A', hide } }), 'https://x.example/l.json')[0].hide.length, 600);
  const step = { view: { cam: { target: [0, 0, 0], dist: 10, q: [0, 0, 0, 1], ortho: false } }, hide, section: { axis: 'off' }, title: '', text: '', dim: 'none', transition: 1.2, hold: 4 };
  assert.equal(parseTour(JSON.stringify(draftToTour({ title: 't', mode: 'static', loop: false, orient: null, steps: [step] }))).steps[0].hide.length, 600);
  // over the limit: refused in words that name it
  const many = Array.from({ length: PART_NAMES_MAX + 1 }, (_, i) => `p${i}`);
  assert.throws(() => parseTour(JSON.stringify({ cadtour: 2, steps: [{ hide: many }] })), new RegExp(`at most ${PART_NAMES_MAX} part names`));
  assert.throws(() => parseModelList(JSON.stringify({ 'a.stl': { name: 'A', hide: many } }), 'https://x.example/l.json'), new RegExp(`at most ${PART_NAMES_MAX}`));
  // a label (which a tour then names the part by) and a colour key: the same length limit
  const long = 'L'.repeat(PART_NAME_MAX + 50);
  assert.throws(() => parseModelList(JSON.stringify({ 'a.stl': { name: 'A', labels: { part1: long } } }), 'https://x.example/l.json'), /labels/);
  assert.throws(() => parseTour(JSON.stringify({ cadtour: 2, steps: [{ colour: { [long]: '#ff0000' } }] })), /colour/);
});

test('check-tour.mjs plays a local tour over the model its "model" names beside it, as the page does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cv-checktour-'));
  try {
    const quad = { name: 'plate', color: null, positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0), normals: null, colors: null, indices: Uint32Array.of(0, 1, 2) };
    writeFileSync(join(dir, 'm.cadmesh'), new Uint8Array(encodeCadmesh({ meshes: [quad], root: { name: 'asm', meshes: [0], children: [] } })));
    writeFileSync(join(dir, 't.cadtour.json'), JSON.stringify({ cadtour: 2, model: 'm.cadmesh', steps: [{ frame: ['plate'] }] }));
    const out = execFileSync(process.execPath, [join(HERE, 'check-tour.mjs'), join(dir, 't.cadtour.json')], { encoding: 'utf8' });
    assert.match(out, /^OK {2}.*1 steps, 1 part names, 0 not in the model/);
    // a tour over an OBJ (the page plays one over any format it opens): read as the page reads it
    writeFileSync(join(dir, 'm.obj'), 'o plate\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    writeFileSync(join(dir, 'o.cadtour.json'), JSON.stringify({ cadtour: 2, model: 'm.obj', steps: [{ frame: ['plate'] }] }));
    assert.match(execFileSync(process.execPath, [join(HERE, 'check-tour.mjs'), join(dir, 'o.cadtour.json')], { encoding: 'utf8' }), /^OK {2}.*0 not in the model/);
    // a STEP model: a FAIL line saying what to do, not a stack trace
    writeFileSync(join(dir, 'm.stp'), 'ISO-10303-21;\nHEADER;\nENDSEC;\n');
    writeFileSync(join(dir, 's.cadtour.json'), JSON.stringify({ cadtour: 2, model: 'm.stp', steps: [{}] }));
    let failed = '';
    try { execFileSync(process.execPath, [join(HERE, 'check-tour.mjs'), join(dir, 's.cadtour.json')], { encoding: 'utf8' }); } catch (e) { failed = e.stdout; }
    assert.match(failed, /^FAIL .*m\.stp: a STEP \/ IGES \/ BREP: convert it first/);
    // --labels with nothing after it: a usage error (exit 2), not a pass without the labels
    let rc = 0;
    try { execFileSync(process.execPath, [join(HERE, 'check-tour.mjs'), join(dir, 't.cadtour.json'), '--labels'], { encoding: 'utf8' }); } catch (e) { rc = e.status; }
    assert.equal(rc, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a list\'s labels name the first model\'s bodies only: an added model\'s part of the same name keeps its own', () => {
  // board (bodies 1, 2: PART_7, PART_8) + case (body 3: PART_7), labels { PART_7: "Fan" }
  const header = { root: { name: 'scene', meshes: [], children: [
    { name: 'board', meshes: [0, 1], children: [] }, { name: 'case', meshes: [2], children: [] }] },
  meshes: [{ name: 'PART_7' }, { name: 'PART_8' }, { name: 'PART_7' }] };
  const labels = { PART_7: 'Fan' };
  const idx = partIndex(header, labels, 2);
  assert.deepEqual(resolveParts(['Fan'], idx).ids, [1]);
  assert.deepEqual(resolveParts(['PART_7'], idx).ids.sort(), [1, 3]);
  // the maker names body 1 by its label (round 10: it was "#1"), and both PART_7s by names that
  // resolve to exactly them ("Fan" alone names body 1 only)
  assert.deepEqual(namesFor([1], header, idx, labels), ['Fan']);
  assert.deepEqual(resolveParts(namesFor([1, 3], header, idx, labels), idx).ids.sort(), [1, 3]);
  assert.deepEqual(resolveParts(namesFor([3], header, idx, labels), idx).ids, [3]);
  // one model (no limit): as before
  assert.deepEqual(resolveParts(['Fan'], partIndex(header, labels)).ids.sort(), [1, 3]);
});

test('partIndex in a scene: 1000 labels naming one assembly of 100,000 bodies, each node tested once', () => {
  const N = 100000;
  const top = { name: 'Top', meshes: [...Array(N - 1).keys()], children: [] };
  const header = { root: { name: 'scene', meshes: [N - 1], children: [top] }, meshes: Array.from({ length: N }, (_, i) => ({ name: `b${i}` })) };
  // 1000 keys that all fold to "top": its letters' cases, then trailing spaces
  const keys = [];
  for (let s = 0; keys.length < 1000; s++) for (let m = 0; m < 8 && keys.length < 1000; m++) keys.push('top'.split('').map((c, k) => (m >> k & 1 ? c.toUpperCase() : c)).join('') + ' '.repeat(s));
  const labels = Object.fromEntries(keys.map((k, i) => [k, `label ${i}`]));
  const t0 = Date.now();
  partIndex(header, labels, N - 1);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms (it was 8.4 s)`);
});

test('namesFor on a flat assembly of 40,000 bodies, half of them wanted: each name tested once, fast', () => {
  const N = 40000;
  // (each body its own name under one named root: the root is tested for every wanted body)
  const header = { root: { name: 'asm', meshes: [...Array(N).keys()], children: [] }, meshes: Array.from({ length: N }, (_, i) => ({ name: `part ${i + 1}` })) };
  const idx = partIndex(header);
  const want = Array.from({ length: N / 2 }, (_, i) => 2 * i + 1); // every other body
  const t0 = Date.now();
  const names = namesFor(want, header, idx);
  const ms = Date.now() - t0;
  assert.equal(names.length, N / 2);
  assert.equal(names[0], 'part 1');
  assert.ok(ms < 1000, `${ms} ms (it was 4.9 s)`);
});

test('tourAt: a tour made in inches, played over the mm reading, has its sizes scaled by 1/25.4; fractions are not sizes', () => {
  const t = parseTour(JSON.stringify({ cadtour: 2, unit: 'in', steps: [
    { id: 'a', view: { cam: { target: [254, 0, 25.4], dist: 2540, q: [0, 0, 0, 1] } }, section: { axis: 'z', t: 0.3 }, explode: 0.5,
      callouts: [{ text: 'p', at: [25.4, 50.8, 0] }, { text: 'q', part: 'x' }] },
    { id: 'b', frame: { min: [0, 0, 0], max: [254, 254, 25.4] }, margin: 1.5 }] }));
  const m = tourAt(t, 'mm');
  assert.equal(m.unit, 'mm');
  const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  assert.ok(near(m.steps[0].view.cam.target, [10, 0, 1]));
  assert.ok(Math.abs(m.steps[0].view.cam.dist - 100) < 1e-9);
  assert.ok(near(m.steps[0].callouts[0].at, [1, 2, 0]));
  assert.deepEqual(m.steps[0].callouts[1], { text: 'q', part: 'x' });
  assert.deepEqual([m.steps[0].section.t, m.steps[0].explode, m.steps[1].margin], [0.3, 0.5, 1.5]);
  assert.ok(near(m.steps[1].frame.max, [10, 10, 1]));
  // the same unit, or a model with no reading to choose (null): as made
  assert.equal(tourAt(t, 'in'), t);
  assert.equal(tourAt(t, null), t);
  // and back: mm to inches
  assert.ok(near(tourAt(m, 'in').steps[0].view.cam.target, [254, 0, 25.4]));
  // the same rule for a model list's note points, written for the mm reading
  assert.equal(readingScale('in'), 25.4);
  assert.equal(readingScale('mm'), 1);
  assert.equal(readingScale(null), 1);
  assert.equal(readingScale('mm', 'in'), 1 / 25.4);
});

test('a tour made over a mesh read in inches says so ("unit"), and the parser takes only a known unit', () => {
  const step = { view: { cam: { target: [0, 0, 0], dist: 10, q: [0, 0, 0, 1], ortho: false } }, title: '', text: '', dim: 'none', transition: 1.2, hold: 4 };
  const t = draftToTour({ title: 't', mode: 'static', loop: false, orient: null, unit: 'in', steps: [step] });
  assert.equal(t.unit, 'in');
  assert.equal(parseTour(JSON.stringify(t)).unit, 'in');
  assert.equal(draftToTour({ title: 't', mode: 'static', loop: false, orient: null, unit: 'mm', steps: [step] }).unit, undefined);
  assert.equal(parseTour(JSON.stringify({ cadtour: 2, steps: [{}] })).unit, 'mm');
  assert.throws(() => parseTour(JSON.stringify({ cadtour: 2, unit: 'furlong', steps: [{}] })), /"unit"/);
});

test('a new step carries the step before\'s dimming AND timing, ease included', () => {
  const prev = { dim: 'grey', transition: 2, hold: 1, ease: 'linear', title: 'not carried', id: 'x' };
  const s = stepFromView({ view: {} }, Object.fromEntries(CARRIED_FIELDS.map((k) => [k, prev[k]])));
  assert.deepEqual([s.dim, s.transition, s.hold, s.ease, s.title], ['grey', 2, 1, 'linear', '']);
  assert.equal(s.id, undefined);
});

test('parse-defaults', () => {
  const t = parseTour(JSON.stringify({ cadtour: 1, steps: [{ title: 'one' }] }));
  assert.equal(t.mode, 'static');
  assert.equal(t.loop, false);
  assert.deepEqual(t.defaults, DEFAULTS);
  assert.equal(t.steps[0].transition, DEFAULTS.transition);
  assert.equal(t.model, null);
});

test('parse-model-url', () => {
  const t = parseTour(JSON.stringify({ cadtour: 1, model: 'board.cadmesh.gz', steps: [{}] }), 'https://example.com/tours/a.cadtour.json');
  assert.equal(t.model, 'https://example.com/tours/board.cadmesh.gz');
});

test('parse-v2-step-ids', () => {
  const t = parseTour(JSON.stringify({ cadtour: 2, steps: [{ id: 'microsd', title: 'microSD card slot' }, { title: 'no id' }, { id: 'uart' }] }));
  assert.equal(t.version, 2);
  assert.deepEqual(t.steps.map((s) => s.id), ['microsd', undefined, 'uart']);
  assert.equal(parseTour(JSON.stringify({ cadtour: 1, steps: [{}] })).version, 1);
});

test('recorder-round-trip of the field forms: section "off" and a cut, explode, parts, callouts, timing', () => {
  const src = { cadtour: 2, steps: [
    { id: 'a', view: 'front', section: 'off', explode: 0.5, explodeAlong: 'z', hide: ['fan'], callouts: [{ text: 'here', part: 'fan' }, { text: 'there', at: [1, 2, 3] }], ease: 'linear', orbit: 45 },
    { view: 'top', section: { axis: 'z', t: 0.3, flip: true }, isolate: ['board'], dim: 'grey', transition: 2, hold: 1 },
    // "show": "all" -- a step taken with nothing hidden, whatever the page hides
    { view: 'iso', show: 'all', section: 'off' },
    // a framed step's projection
    { frame: ['fan'], from: 'top', margin: 1.3, ortho: true },
  ] };
  const t = parseTour(JSON.stringify(src));
  assert.equal(t.steps[0].explodeAlong, 'z');
  const back = parseTour(JSON.stringify(draftToTour({ title: '', mode: 'static', loop: false, orient: null, steps: t.steps.map((s) => ({ ...s })) }, null)));
  assert.deepEqual(back.steps, t.steps);
  assert.throws(() => parseTour(JSON.stringify({ cadtour: 2, steps: [{ explodeAlong: 'w' }] })), /explodeAlong.*must be one of assembly, x, y, z/);
});
test('recorder-round-trip: an opened tour saved again keeps its step ids, its orient and every step field', () => {
  const src = { cadtour: 2, title: 'Board', orient: '+y-z', mode: 'static', loop: true,
    steps: [{ id: 'microsd', title: 'microSD', view: 'top', style: 'wire', hold: 3 }, { title: 'no id', dim: 'ghost' }] };
  const t = parseTour(JSON.stringify(src));
  const draft = { title: t.title, mode: t.mode, loop: t.loop, orient: t.orient, steps: t.steps.map((s) => ({ ...s })) };
  const back = parseTour(JSON.stringify(draftToTour(draft, null)));
  assert.equal(back.version, 2);
  assert.equal(back.orient, '+y-z');
  assert.equal(back.loop, true);
  assert.deepEqual(back.steps.map((s) => s.id), ['microsd', undefined]);
  assert.deepEqual(back.steps, t.steps);
});

test('recorder-update-view: re-taking a step\'s view keeps its id, words, dimming, timing, ease and orbit', () => {
  const old = { id: 'uart', title: 'UART', text: 'pins', dim: 'ghost', transition: 2, hold: 7, ease: 'linear', orbit: 90, view: 'top' };
  const s = stepFromView({ view: 'front', show: ['a'] }, old);
  assert.deepEqual(s, { view: 'front', show: ['a'], id: 'uart', title: 'UART', text: 'pins', dim: 'ghost', transition: 2, hold: 7, ease: 'linear', orbit: 90 });
  // a new step: the defaults, and no id copied from the step before it
  const n = stepFromView({ view: 'iso' }, { dim: 'grey', transition: 3, hold: 5 });
  assert.equal(n.id, undefined);
  assert.deepEqual([n.title, n.dim, n.transition, n.hold], ['', 'grey', 3, 5]);
  // and the result is a step the parser takes
  parseTour(JSON.stringify({ cadtour: 2, steps: [s, n] }));
});

test('a callout whose part is not text, or only spaces, takes its point; one with neither is refused in words', () => {
  const t = parseTour(JSON.stringify({ cadtour: 2, steps: [{ callouts: [{ text: 'a', part: 5, at: [1, 2, 3] }, { text: 'b', part: '  ', at: [4, 5, 6] }, { text: 'c', part: ' X ' }] }] }));
  assert.deepEqual(t.steps[0].callouts, [{ text: 'a', at: [1, 2, 3] }, { text: 'b', at: [4, 5, 6] }, { text: 'c', part: 'X' }]);
  assert.throws(() => parseTour(JSON.stringify({ cadtour: 2, steps: [{ callouts: [{ text: 'a', part: 5 }] }] })), /callouts/);
});
test('partIndex: 300,000 bodies under one node (no spread onto the stack)', () => {
  const n = 300000;
  const header = { meshes: Array.from({ length: n }, (_, i) => ({ name: `b${i}` })), root: { name: '', meshes: [], children: [{ name: 'all', meshes: Array.from({ length: n }, (_, i) => i), children: [] }] } };
  const idx = partIndex(header);
  assert.equal(idx.get('all').size, n);
});

test('the tour maker\'s menus offer exactly the values the parser takes (DIMS, MODES)', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const values = (id) => [...new RegExp(`<select id="${id}"[\\s\\S]*?</select>`).exec(html)[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values('tes-dim'), DIMS);
  assert.deepEqual(values('temode'), MODES);
  // the step fields' ranges are the parser's (RANGES), and the maker sets its inputs from them
  assert.throws(() => parseTour(JSON.stringify({ cadtour: 2, steps: [{ orbit: RANGES.orbit[1] + 1 }] })), /orbit/);
  assert.equal(parseTour(JSON.stringify({ cadtour: 2, steps: [{ orbit: RANGES.orbit[1] }] })).steps[0].orbit, RANGES.orbit[1]);
  const rec = readFileSync(new URL('../js/tour-recorder.js', import.meta.url), 'utf8');
  assert.match(rec, /input\.min = RANGES\[k\]\[0\]; input\.max = RANGES\[k\]\[1\]/);
  // and Explode's direction buttons offer exactly the modes links and tours take (EXPLODE_MODES)
  const seg = /<span class="seg" id="xpmode"[\s\S]*?<\/span>/.exec(html)[0];
  assert.deepEqual([...seg.matchAll(/data-mode="([^"]+)"/g)].map((m) => m[1]), EXPLODE_MODES);
});

test('partIndex on a 200-deep named tree over 100,000 bodies: built at once, a name\'s ids gathered when asked', () => {
  const n = 100000;
  const meshes = Array.from({ length: n }, () => ({}));
  let node = { name: 'leaf', meshes: Array.from({ length: n }, (_, i) => i), children: [] };
  for (let d = 199; d >= 0; d--) node = { name: `level${d}`, meshes: [], children: [node] };
  const t0 = Date.now();
  const idx = partIndex({ meshes, root: node });
  assert.equal(idx.get('level0').size, n);
  assert.equal(idx.get('level150').size, n);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms (gathered up front: 200 x 100,000)`);
});

// an app serving the viewer and its files from its own scheme (lc://app/)
// names its model there; nothing else that is not http(s) passes. URL.origin
// is "null" for every one of these, which is why it is not the test.
test('model-on-the-tours-own-scheme-and-host', () => {
  const T = 'lc://app/data/cad/le-potato/tour.cadtour.json';
  const ok = parseTour(JSON.stringify({ cadtour: 2, model: '/data/cad/le-potato/model.cadmesh.gz', steps: [{}] }), T);
  assert.equal(ok.model, 'lc://app/data/cad/le-potato/model.cadmesh.gz');
  const refuse = (model, base) => assert.throws(() => parseTour(JSON.stringify({ cadtour: 2, model, steps: [{}] }), base), /"model"/);
  refuse('lc://other/x.cadmesh.gz', T);
  refuse('foo://app/x.cadmesh.gz', T);
  refuse('foo://evil/x', T);
  refuse('x.cadmesh.gz', 'file:///srv/tour.cadtour.json');
  refuse('file:///etc/passwd', 'file:///srv/tour.cadtour.json');
});

// each mistake refused, and the message names where it is
const REFUSE = [
  ['not JSON', '{', /not JSON/],
  ['no version', { steps: [{}] }, /"cadtour"/],
  ['no steps', { cadtour: 1, steps: [] }, /"steps"/],
  ['unknown top field', { cadtour: 1, step: [], steps: [{}] }, /"step": not a tour field/],
  ['misspelt step field', { cadtour: 1, steps: [{}, { color: { A: '#ffffff' } }] }, /step 2 "color": not a step field/],
  ['bad preset', { cadtour: 1, steps: [{ view: 'up' }] }, /step 1 "view"/],
  ['bad view object', { cadtour: 1, steps: [{ view: { cam: { target: [0, 0], dist: 1, q: [0, 0, 0, 1] } } }] }, /step 1 "view"/],
  ['bad colour', { cadtour: 1, steps: [{ colour: { A: 'red' } }] }, /step 1 "colour"/],
  ['explode out of range', { cadtour: 1, steps: [{ explode: 2 }] }, /step 1 "explode"/],
  ['bad dim', { cadtour: 1, steps: [{ dim: 'blur' }] }, /step 1 "dim"/],
  ['negative transition', { cadtour: 1, steps: [{ transition: -1 }] }, /step 1 "transition"/],
  ['bad default', { cadtour: 1, defaults: { speed: 2 }, steps: [{}] }, /"defaults.speed"/],
  ['callout without a place', { cadtour: 1, steps: [{ callouts: [{ text: 'x' }] }] }, /step 1 "callouts"/],
  ['bad mode', { cadtour: 1, mode: 'auto', steps: [{}] }, /"mode"/],
  ['not http', { cadtour: 1, model: 'file:///etc/passwd', steps: [{}] }, /"model"/],
  ['an id in a v1 tour', { cadtour: 1, steps: [{ id: 'uart' }] }, /step 1 "id": not a step field/],
  ['a bad id', { cadtour: 2, steps: [{ id: 'UART header' }] }, /step 1 "id"/],
  ['an id used twice', { cadtour: 2, steps: [{ id: 'uart' }, { id: 'uart' }] }, /step 2 "id": "uart" is used by an earlier step/],
  ['version 3', { cadtour: 3, steps: [{}] }, /"cadtour"/],
];
for (const [name, t, re] of REFUSE) {
  test(`refuse-${name.replace(/ /g, '-')}`, () => {
    assert.throws(() => parseTour(typeof t === 'string' ? t : JSON.stringify(t), 'https://example.com/'), re);
  });
}

// a small model: an assembly "BOARD" holding the PCB and an "HDMI_1_3" node
// of two bodies, and a free body "SOLID"
const HEADER = {
  meshes: [{ name: 'PCB' }, { name: 'SHELL' }, { name: 'PINS' }, { name: 'SOLID' }],
  root: { name: '', meshes: [], children: [
    { name: 'BOARD', meshes: [0], children: [{ name: 'HDMI_1_3', meshes: [1, 2], children: [] }] },
    { name: '', meshes: [3], children: [] },
  ] },
};

test('resolve-names', () => {
  const idx = partIndex(HEADER, { HDMI_1_3: 'HDMI', SOLID: 'USB 2.0 ×2' });
  assert.deepEqual(resolveParts(['HDMI'], idx), { ids: [2, 3], missing: [] }); // a label
  assert.deepEqual(resolveParts(['hdmi_1_3'], idx), { ids: [2, 3], missing: [] }); // a node, any case
  assert.deepEqual(resolveParts(['BOARD'], idx), { ids: [1, 2, 3], missing: [] }); // a node with its children
  assert.deepEqual(resolveParts(['PINS'], idx), { ids: [3], missing: [] }); // a body
  assert.deepEqual(resolveParts(['BOARD › HDMI_1_3'], idx), { ids: [2, 3], missing: [] }); // a path
  assert.deepEqual(resolveParts(['USB 2.0 ×2', 'nope'], idx), { ids: [4], missing: ['nope'] });
});

test('names-for', () => {
  // the recorder's names: an assembly whose bodies are all chosen is named
  // once; a body whose name is its own by it; a body whose name is shared
  // (SOLID, twice) by its number; a labelled name by its label
  const H = {
    meshes: [{ name: 'PCB' }, { name: 'SHELL' }, { name: 'PINS' }, { name: 'SOLID' }, { name: 'SOLID' }],
    root: { name: '', meshes: [], children: [
      { name: 'BOARD', meshes: [0], children: [{ name: 'HDMI_1_3', meshes: [1, 2], children: [] }] },
      { name: '', meshes: [3, 4], children: [] },
    ] },
  };
  const idx = partIndex(H, { HDMI_1_3: 'HDMI' });
  assert.deepEqual(namesFor([2, 3], H, idx, { HDMI_1_3: 'HDMI' }), ['HDMI']);
  assert.deepEqual(namesFor([1, 2, 3], H, idx), ['BOARD']);
  assert.deepEqual(namesFor([3], H, idx), ['PINS']);
  assert.deepEqual(namesFor([4], H, idx), ['#4']);
  assert.deepEqual(namesFor([4, 5], H, idx), ['SOLID']);
  // and they resolve back to exactly the bodies chosen
  for (const ids of [[2, 3], [1, 2, 3], [3], [4], [1, 4], [2, 3, 5]]) {
    assert.deepEqual(resolveParts(namesFor(ids, H, idx, { HDMI_1_3: 'HDMI' }), idx).ids, ids);
  }
  assert.deepEqual(resolveParts(['#9'], idx).missing, ['#9']); // past the model's bodies
});

test('from-orientation', () => {
  const t = parseTour(JSON.stringify({ cadtour: 1, steps: [{ frame: ['A'], from: [0, 0, 0, 2] }, { from: 'top' }, { frame: ['A'], from: 'outside' }] }));
  assert.deepEqual(t.steps[0].from, [0, 0, 0, 1]);
  assert.equal(t.steps[1].from, 'top');
  assert.equal(t.steps[2].from, 'outside');
  // a frame as a box (a part with no name of its own)
  const b = parseTour(JSON.stringify({ cadtour: 1, steps: [{ frame: { min: [0, 0, 1], max: [10, 5, 2] }, from: 'outside' }] }));
  assert.deepEqual(b.steps[0].frame, { min: [0, 0, 1], max: [10, 5, 2] });
  assert.deepEqual(tourNames(b), []);
  assert.throws(() => parseTour(JSON.stringify({ cadtour: 1, steps: [{ frame: { min: [5, 0, 0], max: [1, 1, 1] } }] })), /step 1 "frame"/);
  assert.throws(() => parseTour(JSON.stringify({ cadtour: 1, steps: [{ from: [1, 2] }] })), /step 1 "from"/);
});

test('orient', () => {
  // the model's orientation for the tour, in any spelling ?orient= takes
  assert.equal(parseTour(JSON.stringify({ cadtour: 1, orient: '+z-y', steps: [{}] })).orient, '+z-y');
  assert.equal(parseTour(JSON.stringify({ cadtour: 1, orient: 'up:+z,front:-y', steps: [{}] })).orient, '+z-y');
  assert.equal(parseTour(JSON.stringify({ cadtour: 1, steps: [{}] })).orient, null);
  assert.throws(() => parseTour(JSON.stringify({ cadtour: 1, orient: 'up', steps: [{}] })), /"orient"/);
  assert.throws(() => parseTour(JSON.stringify({ cadtour: 1, orient: '+z+z', steps: [{}] })), /"orient"/);
});

test('sight', () => {
  // a board 100 x 60 x 1.6 in x-y, +z up; a part near its +x edge
  const up = [0, 0, 1];
  const board = { min: [0, 0, 0], max: [100, 60, 1.6] };
  const centre = [50, 30, 5];
  const top = { min: [80, 25, 1.6], max: [90, 35, 4] };
  assert.ok(rayHitsBox([0, 0, 0], [1, 0, 0], { min: [5, -1, -1], max: [6, 1, 1] }));
  assert.ok(!rayHitsBox([0, 0, 0], [-1, 0, 0], { min: [5, -1, -1], max: [6, 1, 1] }));
  // nothing in the way: from its own side (+x), 30° up, as before
  let r = clearestDirection(top, up, centre, [board]);
  assert.equal(r.blocked, 0);
  assert.ok(r.dir[0] > 0.86 && Math.abs(r.dir[2] - 0.5) < 1e-9, `${r.dir}`);
  // on the bottom face: the board hides it from above, so from underneath
  const bottom = { min: [80, 25, -2.4], max: [90, 35, 0] };
  r = clearestDirection(bottom, up, centre, [board]);
  assert.equal(r.blocked, 0);
  assert.ok(r.dir[2] < 0, `${r.dir}`);
  // a tall row of pins between it and its own side, 30° up: another side
  // or higher, and clear
  const pins = { min: [92, 0, 1.6], max: [95, 60, 12] };
  assert.ok(blockedShare(top, [Math.cos(Math.PI / 6), 0, 0.5], [board, pins]) > 0.5);
  r = clearestDirection(top, up, centre, [board, pins]);
  assert.equal(r.blocked, 0);
  assert.ok(blockedShare(top, r.dir, [board, pins]) === 0);
});

test('sight-thick-board', () => {
  // a board body whose box runs 4 mm past each face (what is fused to it
  // reaches past them), and a chip on its bottom face inside that box
  const up = [0, 0, 1];
  const centre = [50, 30, 0.8];
  const chip = { min: [40, 20, -1], max: [55, 35, 0] };
  const thick = { min: [0, 0, -4], max: [100, 60, 5.6] };
  const faces = [{ min: [0, 0, 1.6], max: [100, 60, 1.6] }, { min: [0, 0, 0], max: [100, 60, 0] },
    { min: [0, 0, -4], max: [0, 60, 5.6] }];
  const bodies = [{ i: 0, box: thick }];
  // the box alone holds the chip's points, so it never counts: any side will
  // do, and the preferred one is from above, through the board
  let r = clearestDirection(chip, up, centre, obstaclesFor(chip, bodies, () => null));
  assert.ok(r.dir[2] > 0, `box only: ${r.dir}`);
  // by its faces: the board's faces stand in the way above, so from below
  const obs = obstaclesFor(chip, bodies, () => faces);
  assert.deepEqual(obs, faces);
  r = clearestDirection(chip, up, centre, obs);
  assert.ok(r.dir[2] < 0, `by faces: ${r.dir}`);
  assert.equal(r.blocked, 0);
  // a body whose box holds none of the chip's points stays its box
  const far = { min: [70, 0, 1.6], max: [90, 10, 8] };
  assert.deepEqual(obstaclesFor(chip, [{ i: 1, box: far }], () => faces), [far]);
  // the faces' boxes from the cadmesh sections: two faces, one triangle each
  const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 3, 0, 2, 0, 4, 2]);
  const index = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const fc = new Uint32Array([0, 1, 1, 1]);
  assert.deepEqual(meshFaceBoxes({ faceStart: 0, faceCount: 2 }, position, index, fc),
    [{ min: [0, 0, 0], max: [1, 1, 0] }, { min: [0, 0, 2], max: [3, 4, 2] }]);
});

test('tour-names', () => {
  const t = parseTour(JSON.stringify(EXAMPLE));
  assert.deepEqual(tourNames(t).sort(), ['HDMI', 'USB 2.0 ×2']);
});

const A = { target: [0, 0, 0], dist: 100, q: [0, 0, 0, 1] };
const B = { target: [10, -4, 2], dist: 1, q: [0, Math.sin(1.2), 0, Math.cos(1.2)] };

test('flight-endpoints', () => {
  const p0 = poseAt(A, B, 0), p1 = poseAt(A, B, 1);
  assert.deepEqual(p0.target, A.target);
  assert.ok(Math.abs(p0.dist - A.dist) < 1e-9 && Math.abs(p1.dist - B.dist) < 1e-9);
  assert.ok(p1.target.every((v, k) => Math.abs(v - B.target[k]) < 1e-12));
  assert.ok(turnAngle(p0.q, A.q) < 1e-6 && turnAngle(p1.q, B.q) < 1e-6);
});

test('flight-steady', () => {
  // the distance shrinks by the same factor each equal step (log-linear), and
  // the turn grows by the same angle each step (slerp)
  const n = 10;
  const poses = Array.from({ length: n + 1 }, (_, i) => poseAt(A, B, i / n));
  const ratios = poses.slice(1).map((p, i) => p.dist / poses[i].dist);
  assert.ok(ratios.every((r) => Math.abs(r - ratios[0]) < 1e-9), `${ratios}`);
  const turns = poses.slice(1).map((p, i) => turnAngle(poses[i].q, p.q));
  assert.ok(turns.every((t) => Math.abs(t - turns[0]) < 1e-6), `${turns}`);
  assert.ok(poses.every((p) => Math.abs(Math.hypot(...p.q) - 1) < 1e-9));
});

test('slerp-short-way', () => {
  // q and -q are the same turn: from A to -A is no turn at all
  const q = slerp(A.q, A.q.map((v) => -v), 0.5);
  assert.ok(turnAngle(q, A.q) < 1e-6);
});

test('ease', () => {
  for (const e of Object.values(EASE)) {
    assert.equal(e(0), 0);
    assert.equal(e(1), 1);
    for (let i = 1; i <= 10; i++) assert.ok(e(i / 10) >= e((i - 1) / 10)); // never back
  }
  assert.ok(EASE.inOut(0.1) < 0.1 && EASE.inOut(0.9) > 0.9); // slow at both ends
});

test('the outside view\'s box tree blocks as the list does, and 100,000 bodies take a fraction of a second', () => {
  // seeded boxes round a part at the origin
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const boxes = Array.from({ length: 3000 }, () => { const c = [rnd() * 200 - 100, rnd() * 200 - 100, rnd() * 200 - 100]; return { min: c.map((v) => v - 2), max: c.map((v) => v + 2) }; });
  const part = { min: [-1, -1, -1], max: [1, 1, 1] };
  const tree = obstacleTree(boxes);
  for (const d of [[1, 0, 0], [0, 0, 1], [0.6, 0.48, 0.64], [-0.36, 0.48, 0.8]]) assert.equal(blockedShare(part, d, tree), blockedShare(part, d, boxes), `direction ${d}`);
  const many = Array.from({ length: 100000 }, () => { const c = [rnd() * 2000 - 1000, rnd() * 2000 - 1000, rnd() * 2000 - 1000]; return { min: c.map((v) => v - 1), max: c.map((v) => v + 1) }; });
  const t0 = Date.now();
  clearestDirection(part, [0, 0, 1], [0, 0, 0], many);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
});

done();
