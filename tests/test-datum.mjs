#!/usr/bin/env node
// Positions from a reference (js/datum.js).   node tests/test-datum.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { aboveBelow, rangesFrom } from '../js/datum.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

// a 85 x 56 x 1.6 board at z 0..1.6; a connector overhanging its -x edge by
// 1.5 mm, standing 7.8 mm above it; a part underneath, 2 mm below
const pcb = { min: [10, 20, 0], max: [95, 76, 1.6] };
const hdmi = { min: [8.5, 30, 1.6], max: [23.5, 45, 9.4] };
const under = { min: [40, 40, -2], max: [50, 50, 0] };
const whole = { min: [8.5, 20, -2], max: [95, 76, 9.4] };

test('ranges from the reference corner, an overhang reads negative', () => {
  assert.deepEqual(rangesFrom(hdmi, pcb).map((r) => r.map((v) => +v.toFixed(6))), [[-1.5, 13.5], [10, 25], [1.6, 9.4]]);
});
test('above / below along +z', () => {
  const ab = aboveBelow(whole, pcb, [0, 0, 1]);
  assert.ok(Math.abs(ab.above - 7.8) < 1e-9 && Math.abs(ab.below - 2) < 1e-9, JSON.stringify(ab));
  // a part that stops short of the top reads negative above
  assert.ok(aboveBelow(under, pcb, [0, 0, 1]).above < 0);
});
test('above / below along -y (a file drawn with -y up) and +y', () => {
  // with -y up the "top" is the smallest y
  const ab = aboveBelow(hdmi, pcb, [0, -1, 0]);
  assert.equal(ab.above, 20 - 30);
  assert.equal(ab.below, 45 - 76);
  const up = aboveBelow(hdmi, pcb, [0, 1, 0]);
  assert.equal(up.above, 45 - 76);
  assert.equal(up.below, 20 - 30);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
