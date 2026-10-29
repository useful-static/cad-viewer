#!/usr/bin/env node
// The shareable view (js/view-link.js).   node tests/test-view-link.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { decodeView, encodeView, parseRuns, runs } from '../js/view-link.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

const view = {
  cam: { target: [12.3456789, -4, 1e-7], dist: 1234.56789, q: [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)], ortho: true, orient: '+z-y' },
  style: 'hiddengrey', section: { axis: 'z', t: 0.4321, flip: true }, hidden: [7, 1, 2, 3, 3], selected: [5],
};

test('runs and back', () => {
  assert.equal(runs([7, 1, 2, 3, 3, 10, 9]), '1-3,7,9-10');
  assert.deepEqual(parseRuns('1-3,7,9-10'), [1, 2, 3, 7, 9, 10]);
  assert.equal(runs([]), '');
});
test('a view round-trips: the target to a millionth of the distance, the rest to 6 significant digits', () => {
  const s = encodeView(view);
  // dist 1234.57: the target to 0.001
  assert.ok(s.startsWith('c:12.346,-4,0,1234.57,'), s);
  const d = decodeView(s);
  assert.deepEqual(d.cam.target, [12.346, -4, 0]);
  assert.equal(d.cam.dist, 1234.57);
  assert.ok(d.cam.q.every((x, i) => Math.abs(x - view.cam.q[i]) < 1e-5));
  assert.equal(d.cam.ortho, true);
  assert.equal(d.cam.orient, '+z-y');
  assert.ok(s.includes(';u:z;'), s); // Z up as the older links wrote it
  assert.equal(d.style, 'hiddengrey');
  assert.deepEqual(d.section, { axis: 'z', t: 0.4321, flip: true });
  assert.deepEqual(d.hidden, [1, 2, 3, 7]);
  assert.deepEqual(d.selected, [5]);
});
test('far from the origin, the target keeps the precision the view needs (review r14)', () => {
  // 100 m out, looked at from 10 mm: 6 significant digits would be 1 mm off
  const far = { cam: { target: [100000.1234567, -250000.7654321, 3.3333333], dist: 10, q: [0, 0, 0, 1], ortho: false } };
  const d = decodeView(encodeView(far));
  far.cam.target.forEach((t, i) => assert.ok(Math.abs(d.cam.target[i] - t) <= 10 * 1e-6, `${d.cam.target[i]} vs ${t}`));
  // and a huge view keeps whole numbers, never more digits than it needs
  const huge = decodeView(encodeView({ cam: { target: [1.5, 2.25, 3], dist: 1e9, q: [0, 0, 0, 1] } }));
  assert.deepEqual(huge.cam.target, [2, 2, 3]);
});

test('defaults stay out of the link', () => {
  const s = encodeView({ cam: { target: [0, 0, 0], dist: 1, q: [0, 0, 0, 1], ortho: false, orient: '+y+z' }, section: { axis: 'off' } });
  assert.equal(s, 'c:0,0,0,1,0,0,0,1');
  const d = decodeView(s);
  assert.equal(d.cam.ortho, false);
  assert.equal(d.cam.orient, '+y+z');
  assert.equal(d.section, undefined);
});
test('any orientation round-trips; old u:z / u:y links still read; a bad one is the default', () => {
  const cam = { target: [0, 0, 0], dist: 1, q: [0, 0, 0, 1] };
  const s = encodeView({ cam: { ...cam, orient: '+z+x' } });
  assert.ok(s.endsWith(';u:+z+x'), s);
  assert.equal(decodeView(s).cam.orient, '+z+x');
  assert.equal(decodeView('c:0,0,0,1,0,0,0,1;u:z').cam.orient, '+z-y');
  assert.equal(decodeView('c:0,0,0,1,0,0,0,1;u:y').cam.orient, '+y+z');
  assert.equal(decodeView('c:0,0,0,1,0,0,0,1;u:+z+z').cam.orient, '+y+z');
  // a link written by the page goes through URL.hash, which keeps "+"
  const u = new URL('https://cad.place/');
  u.hash = `view=${s}`;
  assert.equal(decodeView(decodeURIComponent(u.hash.slice(6))).cam.orient, '+z+x');
});
test('a hand-edited or broken link drops what it cannot read, never throws', () => {
  assert.deepEqual(decodeView('c:1,2,3;s:Bad Style;x:w,2;zz:1;h:a-b,4'), { hidden: [4] });
  assert.deepEqual(decodeView(''), {});
  assert.deepEqual(decodeView('c:0,0,0,-5,0,0,0,1'), {}, 'a negative distance');
  assert.equal(parseRuns('1-1000000000', 10).length, 10, 'a huge run is capped');
});
test('a quaternion is renormalised', () => {
  const d = decodeView('c:0,0,0,10,0,0,0,2');
  assert.deepEqual(d.cam.q, [0, 0, 0, 1]);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
