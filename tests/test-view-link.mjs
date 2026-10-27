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
  cam: { target: [12.3456789, -4, 1e-7], dist: 1234.56789, q: [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)], ortho: true, up: 'z' },
  style: 'hiddengrey', section: { axis: 'z', t: 0.4321, flip: true }, hidden: [7, 1, 2, 3, 3], selected: [5],
};

test('runs and back', () => {
  assert.equal(runs([7, 1, 2, 3, 3, 10, 9]), '1-3,7,9-10');
  assert.deepEqual(parseRuns('1-3,7,9-10'), [1, 2, 3, 7, 9, 10]);
  assert.equal(runs([]), '');
});
test('a view round-trips to 6 significant digits', () => {
  const s = encodeView(view);
  assert.ok(s.startsWith('c:12.3457,-4,1e-7,1234.57,'), s);
  const d = decodeView(s);
  assert.deepEqual(d.cam.target, [12.3457, -4, 1e-7]);
  assert.equal(d.cam.dist, 1234.57);
  assert.ok(d.cam.q.every((x, i) => Math.abs(x - view.cam.q[i]) < 1e-5));
  assert.equal(d.cam.ortho, true);
  assert.equal(d.cam.up, 'z');
  assert.equal(d.style, 'hiddengrey');
  assert.deepEqual(d.section, { axis: 'z', t: 0.4321, flip: true });
  assert.deepEqual(d.hidden, [1, 2, 3, 7]);
  assert.deepEqual(d.selected, [5]);
});
test('defaults stay out of the link', () => {
  const s = encodeView({ cam: { target: [0, 0, 0], dist: 1, q: [0, 0, 0, 1], ortho: false, up: 'y' }, section: { axis: 'off' } });
  assert.equal(s, 'c:0,0,0,1,0,0,0,1');
  const d = decodeView(s);
  assert.equal(d.cam.ortho, false);
  assert.equal(d.cam.up, 'y');
  assert.equal(d.section, undefined);
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
