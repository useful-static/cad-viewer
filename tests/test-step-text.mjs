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

test('one 1 MB record of "#1=A" repeats, and of "=ADVANCED_FACE(\'n\',(" repeats: each scanner reads it once', () => {
  const head = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n';
  const t0 = Date.now();
  assert.equal(stepUnits(enc(`${head}${'#1=A'.repeat(262144)};\nENDSEC;`)), null);
  const f = stepFeatures(enc(`${head}${"=ADVANCED_FACE('n',(".repeat(52428)};`));
  assert.equal(f.faces, 0);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms (was 112 s and 56 s)`);
});
test('1,000 unit contexts naming one 3.9 MB unit record: the record is read once', () => {
  const parts = ['ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n', `#1=(LENGTH_UNIT()NAMED_UNIT(*)${'X'.repeat(3_900_000)}SI_UNIT(.MILLI.,.METRE.));\n`];
  for (let k = 0; k < 1000; k++) parts.push(`#${k + 10}=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#1))REPRESENTATION_CONTEXT('',''));\n`);
  parts.push('ENDSEC;\nEND-ISO-10303-21;\n');
  const t0 = Date.now();
  assert.equal(stepUnits(enc(parts.join(''))), 'mm');
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms (was 8.3 s at 6 MB)`);
});
test('a real ADVANCED_FACE is still counted, with its bounds', () => {
  const f = stepFeatures(enc("ISO-10303-21;\nDATA;\n#5=ADVANCED_FACE('',(#6,#7,#8),#9,.T.);\n#6=FACE_OUTER_BOUND('',#10,.T.);\nENDSEC;"));
  assert.equal(f.faces, 1);
  assert.equal(f.bounds2, 9);
});

done();
