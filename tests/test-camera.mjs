#!/usr/bin/env node
// Orbit-camera math (js/camera.js):  node tests/test-camera.mjs  (exit 0 = all pass)
// Each test names the review finding it guards (2026-10-24 review round 1).

import assert from 'node:assert/strict';
import { camDir, camUp, eyeDist, eyeOf, fitDistance, nearFar, sphereOf } from '../js/camera.js';
import { lookAt, ortho, perspective } from '../js/mat4.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// screen-up of the rendered view, as the view matrix carries it
const screenUp = (cam) => { const v = lookAt(eyeOf(cam), cam.target, camUp(cam)); return [v[1], v[5], v[9]]; };
const cam = (o) => ({ target: [0, 0, 0], dist: 100, yaw: 0.7, pitch: 0, fov: Math.PI / 4, up: 'y', ...o });

for (const up of ['y', 'z']) {
  for (const [pole, sign] of [['top', 1], ['bottom', -1]]) {
    test(`no image roll crossing into the ${pole} pole region (${up}-up)`, () => {
      // just outside vs just inside the |pitch| > 1.5 special case
      const a = screenUp(cam({ up, pitch: sign * 1.499 }));
      const b = screenUp(cam({ up, pitch: sign * 1.501 }));
      assert.ok(dot(a, b) > 0.99, `screen-up flips: dot=${dot(a, b).toFixed(3)}`);
    });
    test(`${pole} preset (pitch at the clamp) keeps orientation (${up}-up)`, () => {
      const a = screenUp(cam({ up, pitch: sign * 1.45 }));
      const b = screenUp(cam({ up, pitch: sign * (Math.PI / 2 - 1e-4) }));
      assert.ok(dot(a, b) > 0.95, `dot=${dot(a, b).toFixed(3)}`);
    });
  }
}

test('mutation control: the old fixed-sign pole up DOES roll at the bottom pole', () => {
  // the pre-fix formula, to prove the test above can fail
  const oldUp = (c) => (Math.abs(c.pitch) > 1.5 ? [-Math.sin(c.yaw), 0, -Math.cos(c.yaw)] : [0, 1, 0]);
  const su = (c) => { const v = lookAt(eyeOf(c), c.target, oldUp(c)); return [v[1], v[5], v[9]]; };
  assert.ok(dot(su(cam({ pitch: -1.499 })), su(cam({ pitch: -1.501 }))) < 0);
});

test('camDir is a unit vector', () => {
  for (const up of ['y', 'z']) for (const p of [-1.5, 0, 0.7, 1.5]) {
    assert.ok(Math.abs(Math.hypot(...camDir(cam({ up, pitch: p }))) - 1) < 1e-12);
  }
});

const model = sphereOf({ min: [-1000, -1000, -1000], max: [1000, 1000, 1000] });

// depth of the model's bounding sphere along the view: [front, back]
function modelDepth(c) {
  const e = eyeOf(c);
  const fwd = camDir(c).map((v) => -v);
  const dcen = dot([0, 1, 2].map((k) => model.center[k] - e[k]), fwd);
  return [dcen - model.radius, dcen + model.radius];
}

test('near/far contain the model after panning the target off it', () => {
  for (const yaw of [0, 0.3, Math.PI / 2, Math.PI / 2 + 0.3, Math.PI]) {
    const c = cam({ target: [2 * model.radius, 0, 0], dist: 3 * model.radius, yaw });
    const [near, far] = nearFar(c, model);
    const [front, back] = modelDepth(c);
    assert.ok(back <= far, `yaw ${yaw}: far ${far.toFixed(0)} < model back ${back.toFixed(0)}`);
    assert.ok(front <= 0 || front >= near, `yaw ${yaw}: near ${near.toFixed(0)} > model front ${front.toFixed(0)}`);
  }
});

test('mutation control: the old target-relative planes DO clip after that pan', () => {
  const c = cam({ target: [2 * model.radius, 0, 0], dist: 3 * model.radius, yaw: Math.PI / 2 + 0.3 });
  const oldFar = c.dist + model.radius * 2.5;
  const [, back] = modelDepth(c);
  assert.ok(back > oldFar);
});

test('zooming onto a 2 mm part in a 2 m model does not near-clip the part', () => {
  const part = sphereOf({ min: [0, 0, 0], max: [2, 2, 2] });
  const dist = (part.radius / Math.sin(Math.PI / 8)) * 1.05;
  const c = cam({ target: part.center, dist });
  const [near] = nearFar(c, model);
  assert.ok(near < dist - part.radius, `near ${near.toFixed(3)} cuts the part front at ${(dist - part.radius).toFixed(3)}`);
});

test('near stays positive and below far for an eye inside the model', () => {
  const [near, far] = nearFar(cam({ dist: 10 }), model);
  assert.ok(near > 0 && far > near);
});

// ---- review round 2 ----

test('fit frames the sphere horizontally on a tall, narrow canvas', () => {
  const fov = Math.PI / 4;
  for (const aspect of [0.3, 0.5, 1, 2]) {
    const d = fitDistance(100, fov, aspect);
    const hHalf = Math.atan(Math.tan(fov / 2) * aspect);
    // sphere's angular half-size from that distance must fit both half-angles
    const ang = Math.asin(100 / d);
    assert.ok(ang <= hHalf + 1e-12 && ang <= fov / 2 + 1e-12, `aspect ${aspect}: sphere ${ang.toFixed(3)} > h ${hHalf.toFixed(3)}`);
  }
});

test('mutation control: the old vertical-only fit DOES crop at aspect 0.3', () => {
  const fov = Math.PI / 4;
  const d = (100 / Math.sin(fov / 2)) * 1.05;
  assert.ok(Math.asin(100 / d) > Math.atan(Math.tan(fov / 2) * 0.3));
});

test('ortho zoomed far in keeps the eye outside the model and the near plane before it', () => {
  const s = sphereOf({ min: [-500, -500, -500], max: [500, 500, 500] });
  for (const dist of [25, 1, 0.01]) {
    const c = cam({ ortho: true, dist });
    const e = eyeOf(c, s);
    assert.ok(Math.hypot(...e) > s.radius, `dist ${dist}: eye inside the model`);
    const [near] = nearFar(c, s);
    const front = eyeDist(c, s) - s.radius; // model front along the axis (target = centre)
    assert.ok(near <= front, `dist ${dist}: near ${near.toFixed(1)} past model front ${front.toFixed(1)}`);
  }
});

// ---- review round 10 ----

// target panned off along x, then orbited 90 degrees: the model centre is t
// in front of the target along the view axis
const orthoPanned = (t) => cam({ ortho: true, dist: 1, yaw: Math.PI / 2, target: [-t, 0, 0] });
const unit = sphereOf({ min: [-1, -1, -1], max: [1, 1, 1] }); // radius sqrt(3)

test('ortho after a long pan and an orbit does not near-clip the model front', () => {
  for (const t of [0, 5, 10, 50, 500]) {
    const c = orthoPanned(t * unit.radius);
    const [near] = nearFar(c, unit);
    const e = eyeOf(c, unit);
    const front = dot([0, 1, 2].map((k) => unit.center[k] - e[k]), camDir(c).map((v) => -v)) - unit.radius;
    assert.ok(near <= front, `t ${t}r: near ${near.toFixed(3)} past model front ${front.toFixed(3)}`);
  }
});

test('mutation control: the old distance-scaled ortho floor DOES clip at t = 50r', () => {
  const c = orthoPanned(50 * unit.radius);
  const e = eyeOf(c, unit);
  const front = dot([0, 1, 2].map((k) => unit.center[k] - e[k]), camDir(c).map((v) => -v)) - unit.radius;
  assert.ok(eyeDist(c, unit) * 0.01 > front);
});

// ---- review round 11: reverse-Z (WebGPU) ----

// NDC depth of a view-space point at distance z in front of the eye
const ndcZ = (m, z) => (m[10] * -z + m[14]) / (m[11] * -z + m[15]);

test('reversed projections map near -> 1 and far -> 0, monotonically decreasing', () => {
  const [n, f] = [0.08, 2000];
  for (const m of [perspective(Math.PI / 4, 1.5, n, f, true, true), ortho(10, 10, n, f, true, true)]) {
    assert.ok(Math.abs(ndcZ(m, n) - 1) < 1e-6 && Math.abs(ndcZ(m, f)) < 1e-6, `near ${ndcZ(m, n)} far ${ndcZ(m, f)}`);
    assert.ok(ndcZ(m, 1) > ndcZ(m, 10) && ndcZ(m, 10) > ndcZ(m, 1000));
  }
});

test('reverse-Z separates surfaces 0.5 mm apart at 1 m where 24-bit standard depth cannot', () => {
  // near 0.08 mm, far 2000 mm: zoomed onto a 3 mm part inside a 1 m rack
  const [n, f] = [0.08, 2000];
  const f32 = (x) => Math.fround(x);
  const rev = perspective(Math.PI / 4, 1, n, f, true, true);
  const std = perspective(Math.PI / 4, 1, n, f, true, false);
  assert.notEqual(f32(ndcZ(rev, 1000)), f32(ndcZ(rev, 1000.5)), 'depth32float reversed');
  const q24 = (d) => Math.round(d * (2 ** 24 - 1));
  assert.equal(q24(ndcZ(std, 1000)), q24(ndcZ(std, 1000.5)), 'mutation control: 24-bit standard depth DOES merge them');
});

test('perspective keeps eyeDist == dist (ortho push-back is ortho-only)', () => {
  const s = sphereOf({ min: [-500, -500, -500], max: [500, 500, 500] });
  assert.equal(eyeDist(cam({ dist: 25 }), s), 25);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
