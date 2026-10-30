#!/usr/bin/env node
// Tours (js/tour.js, js/tour-path.js):  node tests/test-tour.mjs  (exit 0 = all pass)
// The file format is checked both ways (the plan's example is read, each kind
// of mistake is refused naming its step and field); part names resolve by
// label, node, body and path; the camera flight starts and ends exactly on
// its poses and moves steadily between them.

import assert from 'node:assert/strict';
import { parseTour, partIndex, resolveParts, tourNames, namesFor, DEFAULTS } from '../js/tour.js';
import { EASE, poseAt, slerp, turnAngle } from '../js/tour-path.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

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

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
