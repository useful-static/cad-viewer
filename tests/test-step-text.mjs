#!/usr/bin/env node
// The STEP slice reader every STEP scanner shares (js/step-text.js): records cut by a slice are
// completed, and a file with no ";" at all costs one pass, not an ever-longer carried string.
//   node tests/test-step-text.mjs   -> "RESULT: N passed, 0 failed"

import assert from 'node:assert/strict';
import { STEP_SLICE, forEachStepSlice, withoutBom } from '../js/step-text.js';
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

// (r112 M step-text-B0, step-text-C5) a ;-less run longer than a slice is dropped; one of exactly a
// slice is still carried (the drop is for "longer than", not "as long as")
test('a ;-less run past a slice is dropped, one of exactly a slice is carried (r112 M step-text-B0, step-text-C5)', () => {
  const lens = (s) => { const got = []; forEachStepSlice(enc(s), (t) => got.push(t.length)); return got; };
  assert.deepEqual(lens(`${'x'.repeat(2 * STEP_SLICE + 10)};#1=A;`), [0, 0, 16]);
  assert.deepEqual(lens(`${'x'.repeat(STEP_SLICE)}#1=A;`), [0, STEP_SLICE + 5]);
});
// (r112 M step-text-C0, C1, C2, O2, O4, O8) withoutBom drops exactly the three BOM bytes, and only
// when all three are there
test('withoutBom drops exactly ef bb bf and nothing else (r112 M step-text-C0, step-text-C1, step-text-C2, step-text-O2, step-text-O4, step-text-O8)', () => {
  const wb = (a) => Array.from(withoutBom(new Uint8Array(a)));
  assert.deepEqual(wb([0xef, 0xbb, 0xbf, 0x49, 0x53]), [0x49, 0x53]);
  assert.deepEqual(wb([0xef, 0x00, 0xbf, 0x49]), [0xef, 0x00, 0xbf, 0x49]);
  assert.deepEqual(wb([0xef, 0xbb, 0x00, 0x49]), [0xef, 0xbb, 0x00, 0x49]);
  assert.deepEqual(wb([0x00, 0xbb, 0xbf, 0x49]), [0x00, 0xbb, 0xbf, 0x49]);
});

done();
