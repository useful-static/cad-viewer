#!/usr/bin/env node
// Orbit-camera math (js/camera.js):  node tests/test-camera.mjs  (exit 0 = all pass)
// Each test names the review finding it guards (2026-10-24 review round 1).

import assert from 'node:assert/strict';
import {
  camDir, camUp, eyeDist, eyeOf, fitBox, fitDistance, nearFar, orbitBy, panBy, pinchStep, quatFromView, refitForAspect, sphereOf, zoomAt, zoomBy,
} from '../js/camera.js';
import { lookAt, ortho, perspective } from '../js/mat4.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// screen-up of the rendered view, as the view matrix carries it
const screenUp = (cam) => { const v = lookAt(eyeOf(cam), cam.target, camUp(cam)); return [v[1], v[5], v[9]]; };
// screen-right of the rendered view
const screenRight = (cam) => { const v = lookAt(eyeOf(cam), cam.target, camUp(cam)); return [v[0], v[4], v[8]]; };
const cam = (o) =>({ target: [0, 0, 0], dist: 100, yaw: 0.7, pitch: 0, fov: Math.PI / 4, up: 'y', ...o });

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

// ---- touch / narrow layout ----

test('pinch: fingers spreading apart zoom in, pinching together zooms out', () => {
  const apart = pinchStep([100, 100], [200, 100], [50, 100], [250, 100]);
  assert.ok(Math.abs(apart.scale - 0.5) < 1e-12 && apart.dx === 0 && apart.dy === 0);
  const together = pinchStep([50, 100], [250, 100], [100, 100], [200, 100]);
  assert.ok(Math.abs(together.scale - 2) < 1e-12);
});

test('pinch: a two-finger drag pans by the midpoint move and does not zoom', () => {
  const st = pinchStep([100, 100], [200, 100], [130, 80], [230, 80]);
  assert.ok(Math.abs(st.scale - 1) < 1e-12 && st.dx === 30 && st.dy === -20);
});

test('pinch: coincident fingers give scale 1, never 0 / Infinity / NaN', () => {
  assert.equal(pinchStep([5, 5], [5, 5], [9, 9], [20, 20]).scale, 1);
  assert.equal(pinchStep([5, 5], [6, 6], [9, 9], [9, 9]).scale, 1);
});

test('zoomBy clamps to [0.05 framed radius, 50 model radii]', () => {
  const c = cam({ dist: 100, viewRadius: 10 });
  zoomBy(c, 1e-9, 1000);
  assert.equal(c.dist, 0.5);
  zoomBy(c, 1e12, 1000);
  assert.equal(c.dist, 50000);
});

test('panBy moves the target in the screen plane, by one px of image per px', () => {
  for (const [up, pitch] of [['y', 0.4], ['z', -0.3], ['y', 1.55]]) {
    const c = cam({ up, pitch, dist: 100, target: [0, 0, 0] });
    panBy(c, 40, -25, 400);
    const dir = camDir(c);
    // the screen axes come from a Float32 view matrix: relative 1e-6, not exact
    const len = Math.hypot(...c.target);
    assert.ok(Math.abs(dot(c.target, dir)) < 1e-6 * len, `${up}/${pitch}: target left the screen plane`);
    const pxPerUnit = 400 / (2 * 100 * Math.tan(Math.PI / 8));
    assert.ok(Math.abs(len * pxPerUnit - Math.hypot(40, 25)) < 1e-4);
    // the picture follows the finger: a drag RIGHT moves the target to the
    // screen's left, a drag UP (dy < 0) moves it toward the screen's bottom
    assert.ok(dot(c.target, screenRight(c)) < 0, `${up}/${pitch}: wrong horizontal pan direction`);
    assert.ok(dot(c.target, screenUp(c)) < 0, `${up}/${pitch}: wrong vertical pan direction`);
    // and in proportion: 40 px across, 25 px up
    assert.ok(Math.abs(dot(c.target, screenRight(c)) / dot(c.target, screenUp(c)) - 40 / 25) < 1e-4);
  }
});

test('an aspect round trip at a zoom limit returns dist exactly (refit + clamp, as main.js does it)', () => {
  // main.js on each stage resize: dist = refitForAspect(...); zoomBy(cam, 1, R, aNew)
  const resize = (c, a0, a1) => {
    c.dist = refitForAspect(c.dist, c.viewRadius, c.fov, a0, a1);
    zoomBy(c, 1, 1000, a1);
  };
  for (const [a0, a1] of [[0.54, 0.97], [0.46, 3.0], [3.0, 0.46]]) {
    for (const end of ['floor', 'ceiling']) {
      const c = cam({ dist: 100, viewRadius: 10 });
      zoomBy(c, end === 'floor' ? 1e-9 : 1e12, 1000, a0);
      const d0 = c.dist;
      resize(c, a0, a1);
      resize(c, a1, a0);
      assert.ok(Math.abs(c.dist / d0 - 1) < 1e-9, `${end} ${a0}->${a1}->${a0}: dist ${d0} -> ${c.dist}`);
    }
  }
});

test('mutation control: aspect-blind limits (the round-5 clamp) DO lose zoom on that round trip', () => {
  const c = cam({ dist: 100, viewRadius: 10 });
  const clamp = () => { c.dist = Math.max(c.viewRadius * 0.05, Math.min(1000 * 50, c.dist)); };
  c.dist = c.viewRadius * 0.05;
  const d0 = c.dist;
  c.dist = refitForAspect(c.dist, c.viewRadius, c.fov, 0.54, 0.97); clamp();
  c.dist = refitForAspect(c.dist, c.viewRadius, c.fov, 0.97, 0.54); clamp();
  assert.ok(c.dist / d0 > 1.5, `ratio ${c.dist / d0}`);
});

test('refitForAspect keeps the framed sphere fitting when a view narrows, and is identity when wide', () => {
  const fov = Math.PI / 4;
  const d0 = fitDistance(100, fov, 1.6);
  assert.equal(refitForAspect(d0, 100, fov, 1.6, 2.0), d0); // both wide: vertical fit governs
  const d1 = refitForAspect(d0, 100, fov, 1.6, 0.46); // landscape -> portrait phone
  assert.ok(Math.abs(d1 - fitDistance(100, fov, 0.46)) < 1e-9);
  assert.ok(Math.abs(refitForAspect(d1, 100, fov, 0.46, 1.6) - d0) < 1e-9); // and back
  assert.equal(refitForAspect(d0, 100, fov, 0, 1), d0); // a 0-size stage changes nothing
});

test('perspective keeps eyeDist == dist (ortho push-back is ortho-only)', () => {
  const s = sphereOf({ min: [-500, -500, -500], max: [500, 500, 500] });
  assert.equal(eyeDist(cam({ dist: 25 }), s), 25);
});

// ---- free rotation (2026-10-25: "infinite rotation on all axes") ----

const near = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const PRESETS = [[0.7, 0.45], [0, 0], [Math.PI, 0], [-Math.PI / 2, 0], [Math.PI / 2, 0],
  [0, Math.PI / 2 - 1e-4], [0, -Math.PI / 2 + 1e-4], [2.1, -1.2]];

test('a preset as a quaternion looks and stands exactly like its yaw/pitch (both up axes)', () => {
  for (const up of ['y', 'z']) {
    for (const [yaw, pitch] of PRESETS) {
      const old = cam({ up, yaw, pitch });
      const q = { ...old, q: quatFromView(yaw, pitch, up) };
      assert.ok(near(camDir(q), camDir(old), 1e-9), `${up} ${yaw},${pitch}: direction`);
      // the up vector itself differs (orthonormalised); the SCREEN up is what must match
      assert.ok(near(screenUp(q), screenUp(old), 1e-6), `${up} ${yaw},${pitch}: screen up`);
    }
  }
});

test('a horizontal drag from a level preset turns like the old yaw orbit', () => {
  for (const up of ['y', 'z']) {
    const c = cam({ up, yaw: 0.7, pitch: 0, q: quatFromView(0.7, 0, up) });
    orbitBy(c, 40, 0); // old code: yaw -= 40 * 0.008
    assert.ok(near(camDir(c), camDir(cam({ up, yaw: 0.7 - 0.32, pitch: 0 })), 1e-9), up);
  }
});

test('a vertical drag goes over the pole with no clamp, and on to upside down', () => {
  const c = cam({ q: quatFromView(0, 0, 'y') }); // front, looking along -z
  orbitBy(c, 0, 1); // drag down a little: the eye rises (old pitch += dy * rate)
  assert.ok(camDir(c)[1] > 0, 'eye rises on a downward drag');
  const steps = Math.round(Math.PI / 0.008); // half a turn in 1 px steps
  for (let i = 1; i < steps; i++) orbitBy(c, 0, 1);
  // half a turn about the screen's horizontal axis: behind the model, upside down
  const d = camDir(c), u = camUp(c);
  assert.ok(d[2] < -0.99, `eye behind: dir ${d.map((v) => v.toFixed(3))}`);
  assert.ok(u[1] < -0.99, `upside down: up ${u.map((v) => v.toFixed(3))}`);
});

test('a full turn about either screen axis comes back to the start', () => {
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1]]) {
    const q0 = quatFromView(0.7, 0.45, 'y');
    const c = cam({ q: q0 });
    const steps = Math.round(2 * Math.PI / 0.008);
    // a turn about ONE fixed axis closes; the diagonal drag is checked for unit length only
    for (let i = 0; i < steps; i++) orbitBy(c, dx, dy, (2 * Math.PI) / steps);
    if (!(dx && dy)) {
      assert.ok(near(camDir(c), camDir({ q: q0 }), 1e-6), `${dx},${dy}: direction after a full turn`);
      assert.ok(near(camUp(c), camUp({ q: q0 }), 1e-6), `${dx},${dy}: up after a full turn`);
    }
    assert.ok(Math.abs(Math.hypot(...c.q) - 1) < 1e-12, `${dx},${dy}: q stays unit (${steps} steps)`);
  }
});

test('the view stays orthonormal after 10,000 mixed drag steps', () => {
  const c = cam({ q: quatFromView(0.7, 0.45, 'z') });
  for (let i = 0; i < 10000; i++) orbitBy(c, Math.sin(i * 0.37) * 7, Math.cos(i * 0.11) * 5);
  const d = camDir(c), u = camUp(c);
  assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-9 && Math.abs(Math.hypot(...u) - 1) < 1e-9);
  assert.ok(Math.abs(dot(d, u)) < 1e-9);
});

test('a cam with no q orbits from its yaw/pitch (the first drag before any preset)', () => {
  const c = cam({ yaw: 0.7, pitch: 0.45 });
  orbitBy(c, 0, 0);
  assert.ok(near(camDir(c), camDir(cam({ yaw: 0.7, pitch: 0.45 })), 1e-9));
});

// ---- zoomAt: the wheel and the pinch zoom toward the pointer (feature review 2026-10-29) ----
// Where a world point lands, in CSS px from the view's centre, through the
// same view and projection matrices main.js draws with (column-major).
function screenPx(c, sphere, p, w, h) {
  const view = lookAt(eyeOf(c, sphere), c.target, camUp(c));
  const [n, f] = nearFar(c, sphere);
  const proj = c.ortho
    ? ortho(c.dist * Math.tan(c.fov / 2) * (w / h), c.dist * Math.tan(c.fov / 2), n, f, false)
    : perspective(c.fov, w / h, n, f, false);
  const mul = (m, v) => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
  const cl = mul(proj, mul(view, [...p, 1]));
  return [(cl[0] / cl[3]) * w / 2, -(cl[1] / cl[3]) * h / 2];
}
// the point of the target's plane under (cx, cy)
function underPx(c, cx, cy, h) {
  const s = (2 * c.dist * Math.tan(c.fov / 2)) / h;
  const r = screenRight(c), u = screenUp(c);
  return [0, 1, 2].map((k) => c.target[k] + (cx * r[k] - cy * u[k]) * s);
}
for (const ortho_ of [false, true]) {
  const sphere = { center: [0, 0, 0], radius: 50 };
  const w = 800, h = 500, aspect = w / h;
  test(`zoomAt keeps the point under the pointer there (${ortho_ ? 'ortho' : 'perspective'})`, () => {
    for (const [cx, cy, f] of [[250, -120, 0.8], [-300, 180, 0.6], [120, 90, 1.25], [0, 0, 0.7]]) {
      const c = cam({ q: quatFromView(0.7, 0.45, 'z'), up: 'z', ortho: ortho_, viewRadius: 50 });
      const p = underPx(c, cx, cy, h);
      const before = screenPx(c, sphere, p, w, h);
      // (to 1e-3 px: the projection's float rounding is ~1e-5 px)
      assert.ok(Math.abs(before[0] - cx) < 1e-3 && Math.abs(before[1] - cy) < 1e-3, `setup: ${before}`);
      const d0 = c.dist;
      zoomAt(c, f, sphere.radius, aspect, cx, cy, h);
      assert.ok(Math.abs(c.dist - d0 * f) < 1e-9, 'the distance scales as zoomBy does');
      const after = screenPx(c, sphere, p, w, h);
      assert.ok(Math.hypot(after[0] - cx, after[1] - cy) < 1e-3, `(${cx}, ${cy}) x${f}: now at ${after.map((v) => v.toFixed(3))}`);
    }
  });
  test(`zoomBy alone moves an off-centre point (the arm zoomAt must beat, ${ortho_ ? 'ortho' : 'perspective'})`, () => {
    const c = cam({ q: quatFromView(0.7, 0.45, 'z'), up: 'z', ortho: ortho_, viewRadius: 50 });
    const p = underPx(c, 250, -120, h);
    zoomBy(c, 0.6, sphere.radius, aspect);
    const after = screenPx(c, sphere, p, w, h);
    assert.ok(Math.hypot(after[0] - 250, after[1] + 120) > 50, `moved only to ${after}`);
  });
}
// ---- fitBox: Fit frames the box as the view sees it, not its bounding sphere ----
test('fitBox: every corner in view at once in perspective and ortho, any view and aspect; not loose', () => {
  const board = { min: [10, 20, -2], max: [95, 76, 18] };
  const sphere = sphereOf(board);
  for (const [yaw, pitch] of [[0.7, 0.45], [0, 0], [0, Math.PI / 2 - 1e-4], [2.3, -0.8], [-Math.PI / 2, 1.0]]) {
    for (const [w, h] of [[390, 700], [1280, 760], [800, 500]]) {
      const f = fitBox(cam({ q: quatFromView(yaw, pitch, 'z'), up: 'z' }), board, Math.PI / 4, w / h);
      // one distance serves both projections (a switch never cuts the model);
      // the tighter of the two is at the margin
      let tightest = 0;
      for (const o of [false, true]) {
        const c = cam({ q: quatFromView(yaw, pitch, 'z'), up: 'z', ortho: o });
        c.target = f.target; c.dist = f.dist;
        let worst = 0;
        for (let i = 0; i < 8; i++) {
          const p = [0, 1, 2].map((k) => ((i >> k) & 1 ? board.max[k] : board.min[k]));
          const [x, y] = screenPx(c, sphere, p, w, h);
          worst = Math.max(worst, Math.abs(x) / (w / 2), Math.abs(y) / (h / 2));
        }
        const tag = `yaw ${yaw.toFixed(2)} pitch ${pitch.toFixed(2)} ${w}x${h} ${o ? 'ortho' : 'persp'}`;
        assert.ok(worst <= 1 + 1e-9, `${tag}: a corner outside, at ${worst.toFixed(4)}`);
        tightest = Math.max(tightest, worst);
      }
      assert.ok(tightest > 1 / 1.05 - 1e-6, `yaw ${yaw} ${w}x${h}: loose in both, ${tightest.toFixed(4)}`);
    }
  }
});
test('fitBox never frames farther than the sphere fit', () => {
  const board = { min: [0, 0, 0], max: [85, 56, 20] };
  for (const [yaw, pitch] of [[0.7, 0.45], [-Math.PI / 2, 1.0], [0, 0]]) {
    for (const a of [390 / 700, 1.6]) {
      const c = cam({ q: quatFromView(yaw, pitch, 'z'), up: 'z' });
      const f = fitBox(c, board, c.fov, a);
      const s = fitDistance(sphereOf(board).radius, c.fov, a);
      assert.ok(f.dist <= s + 1e-9, `yaw ${yaw} aspect ${a.toFixed(2)}: box ${f.dist.toFixed(1)} > sphere ${s.toFixed(1)}`);
    }
  }
});
test('zoomAt at a zoom limit moves nothing', () => {
  const c = cam({ q: quatFromView(0.7, 0.45, 'z'), up: 'z', viewRadius: 50 });
  c.dist = 50 * 0.05; // the closest zoomBy allows at aspect 1
  const t = [...c.target];
  zoomAt(c, 0.5, 50, 1, 200, 100, 500);
  assert.deepEqual(c.target, t);
  assert.equal(c.dist, 50 * 0.05);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
