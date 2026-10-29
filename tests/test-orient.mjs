#!/usr/bin/env node
// The orientation (js/orient.js): parsing, and the presets it gives.
//   node tests/test-orient.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { DEFAULT_ORIENT, ISO, PORTRAIT, Z_UP_ORIENT, isoView, orientOrNull, orientQuat, orientRoles, orientUp, parseOrient } from '../js/orient.js';
import { camDir, camUp, qMul, quatFromView } from '../js/camera.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
const close = (a, b, msg) => a.forEach((v, k) => assert.ok(Math.abs(v - b[k]) < 1e-9, `${msg}: ${a} vs ${b}`));
// a preset's camera in an orientation, as main.js composes it
const preset = (o, yaw, pitch) => ({ q: qMul(orientQuat(o), quatFromView(yaw, pitch, 'y')) });
const VIEWS = { iso: [0.7, 0.45], front: [0, 0], back: [Math.PI, 0], left: [-Math.PI / 2, 0], right: [Math.PI / 2, 0], top: [0, Math.PI / 2 - 1e-4], bottom: [0, -Math.PI / 2 + 1e-4] };

test('two roles in any order, "right" too, canonical up+front', () => {
  assert.equal(parseOrient('up:+z,front:-y'), '+z-y');
  assert.equal(parseOrient('front:-y, up:z'), '+z-y'); // a bare axis is +
  assert.equal(parseOrient('up:+z;right:+x'), '+z-y');
  assert.equal(parseOrient('right:+x,front:-y'), '+z-y');
  assert.equal(parseOrient('UP=+Z,FRONT=-Y'), '+z-y');
  assert.equal(parseOrient('+z-y'), '+z-y');
  assert.equal(parseOrient('up:+z,right:+y'), '+z+x'); // a board drawn along y
});
test('refused: one role, three, a role twice, parallel axes, junk', () => {
  for (const bad of ['up:+z', 'up:+z,front:-y,right:+x', 'up:+z,up:-z', 'up:+z,front:-z', 'up:+z,front:+q', 'up:+z,back:+y', '', '+z+z']) {
    assert.throws(() => parseOrient(bad), undefined, bad);
    assert.equal(orientOrNull(bad), null, bad);
  }
  assert.equal(orientOrNull(undefined), null);
});
test('roles and the up vector', () => {
  assert.deepEqual(orientRoles('+z-y'), { up: '+z', front: '-y', right: '+x' });
  assert.deepEqual(orientRoles(DEFAULT_ORIENT), { up: '+y', front: '+z', right: '+x' });
  assert.deepEqual(orientUp('+z+x'), [0, 0, 1]);
});
test('the default orientation is the presets as they were (y up)', () => {
  for (const [v, [yaw, pitch]] of Object.entries(VIEWS)) {
    const a = preset(DEFAULT_ORIENT, yaw, pitch), b = { q: quatFromView(yaw, pitch, 'y') };
    close(camDir(a), camDir(b), v);
    close(camUp(a), camUp(b), v);
  }
});
test('+z-y is the Z up toggle exactly: every preset as quatFromView(…, "z")', () => {
  assert.equal(Z_UP_ORIENT, '+z-y');
  for (const [v, [yaw, pitch]] of Object.entries(VIEWS)) {
    const a = preset(Z_UP_ORIENT, yaw, pitch), b = { q: quatFromView(yaw, pitch, 'z') };
    close(camDir(a), camDir(b), v);
    close(camUp(a), camUp(b), v);
  }
});
test('Front looks at the named front, up on screen is the named up, Top looks down it', () => {
  for (const o of ['+z-y', '+z+x', '-x+y', '+y-z', '-z+x']) {
    const { up, front } = orientRoles(o);
    const v = (a) => [0, 1, 2].map((k) => ('xyz'[k] === a[1] ? (a[0] === '-' ? -1 : 1) : 0));
    const f = preset(o, ...VIEWS.front);
    close(camDir(f), v(front), `${o} front: the eye on the front side`);
    close(camUp(f), v(up), `${o} front: up on screen`);
    const t = camDir(preset(o, ...VIEWS.top));
    close(t.map((x) => Math.round(x * 1e3) / 1e3), v(up), `${o} top: the eye above`);
  }
});
test('two files drawn differently, oriented to match, give the same picture', () => {
  // a board along x with z up, and the same board drawn along y with z up
  // (turned 90° about z: its +y is the first one's +x, its -x the first's +y)
  const a = preset(parseOrient('up:+z,front:-y'), ...VIEWS.iso);
  // (a's front, -y, is b's +x)
  const b = preset(parseOrient('up:+z,front:+x'), ...VIEWS.iso);
  // map b's world vectors into a's frame: (x, y, z)_b -> (y, -x, z)_a
  const toA = (w) => [w[1], -w[0], w[2]];
  close(toA(camDir(b)), camDir(a), 'eye');
  close(toA(camUp(b)), camUp(a), 'screen up');
});

// ---- the portrait Iso: a long model seen along its length on a tall view ----
const board = { min: [0, 0, 0], max: [85, 56, 20] }; // long along x
test('a wide or square view keeps the usual iso; so does a model without a long side', () => {
  assert.deepEqual(isoView(Z_UP_ORIENT, board, 1.6), ISO);
  assert.deepEqual(isoView(Z_UP_ORIENT, board, PORTRAIT), ISO);
  assert.deepEqual(isoView(Z_UP_ORIENT, { min: [0, 0, 0], max: [50, 45, 9] }, 0.5), ISO);
  assert.deepEqual(isoView(Z_UP_ORIENT, null, 0.5), ISO);
});
test('on a tall view a board long left to right is seen from its left end, steeply; long front to back, from the front', () => {
  // Z up, front -y: right is +x, the board's long side
  assert.deepEqual(isoView(Z_UP_ORIENT, board, 0.55), [-Math.PI / 2, 1.0]);
  // the same board turned (front +x): its long side now runs front to back
  assert.deepEqual(isoView(parseOrient('up:+z,front:+x'), board, 0.55), [0, 1.0]);
  // seen that way, the long side runs up the screen: the view looks along x
  const q = qMul(orientQuat(Z_UP_ORIENT), quatFromView(-Math.PI / 2, 1.0, 'y'));
  const d = camDir({ q });
  assert.ok(Math.abs(d[0]) > Math.abs(d[1]) && d[0] < 0, `eye toward ${d.map((v) => v.toFixed(2))}: from the -x end`);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
