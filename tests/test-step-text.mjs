#!/usr/bin/env node
// The STEP slice reader every STEP scanner shares (js/step-text.js): records cut by a slice are
// completed, and a file with no ";" at all costs one pass, not an ever-longer carried string.
//   node tests/test-step-text.mjs   -> "RESULT: N passed, 0 failed"

import assert from 'node:assert/strict';
import { STEP_SLICE, forEachStepSlice } from '../js/step-text.js';
import { stepFeatures } from '../js/step-features.js';
import { stepUnits } from '../js/source-units.js';
import { test, done } from './harness.mjs';

const enc = (s) => new TextEncoder().encode(s);

test('a record across a slice edge reaches the scan whole, every record once', () => {
  const rec = '#1=CARTESIAN_POINT(\'\',(0.,0.,0.));\n';
  const n = Math.ceil((2.5 * STEP_SLICE) / rec.length);
  const seen = [];
  forEachStepSlice(enc(rec.repeat(n)), (t) => seen.push(...(t.match(/#1=CARTESIAN_POINT\([^;]*\);/g) || [])));
  assert.equal(seen.length, n);
});
test('64 MB with no ";" is one pass for all three scanners, no engine error', () => {
  const head = enc('ISO-10303-21;\nHEADER;\n');
  const big = new Uint8Array(64 << 20);
  big.fill(0x41);
  big.set(head);
  const t0 = Date.now();
  const f = stepFeatures(big);
  assert.equal(f.step, true);
  assert.equal(stepUnits(big), null);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
});

done();
