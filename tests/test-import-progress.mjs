#!/usr/bin/env node
// The conversion's overall fraction (js/import-progress.js):
//   node tests/test-import-progress.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { STEP_SHARE, importFraction } from '../js/import-progress.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('shares leave room for writing the result', () => {
  const sum = STEP_SHARE.reduce((s, x) => s + x, 0);
  assert.ok(sum > 0.5 && sum < 1, `sum ${sum}`);
});
test('reading has no fraction: 0 at its start and its end', () => {
  near(importFraction(1, 0), 0);
  near(importFraction(1, 1), 0);
});
test('each step starts where the one before it ends', () => {
  near(importFraction(2, 0), STEP_SHARE[0]);
  near(importFraction(3, 0), importFraction(2, 1));
});
test('meshing at 100% is below 1: the result is still being written', () => {
  const end = importFraction(3, 1);
  assert.ok(end < 1, `${end}`);
  near(end, STEP_SHARE[0] + STEP_SHARE[1] + STEP_SHARE[2]);
});
test('monotone across the steps', () => {
  let last = -1;
  for (const p of [1, 2, 3]) {
    for (const f of [0, 0.25, 0.5, 1]) {
      const v = importFraction(p, f);
      assert.ok(v >= last, `phase ${p} fraction ${f}: ${v} < ${last}`);
      last = v;
    }
  }
});
test('out-of-range input is clamped', () => {
  near(importFraction(9, 2), importFraction(3, 1));
  near(importFraction(0, -1), 0);
  near(importFraction(2, NaN), importFraction(2, 0));
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
