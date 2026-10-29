#!/usr/bin/env node
// The orientation (js/orient.js): parsing, and the presets it gives.
//   node tests/test-orient.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { DEFAULT_ORIENT, Z_UP_ORIENT, orientOrNull, orientQuat, orientRoles, orientUp, parseOrient } from '../js/orient.js';
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

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
