#!/usr/bin/env node
// The conversion-time forecast and time left (js/import-progress.js) and the
// STEP feature count it reads (js/step-features.js):
//   node tests/test-import-progress.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import {
  COEF, QUIET_S, deviceFactor, forecast, forecastDone, forecastTotal, stepOf, timeLeft,
} from '../js/import-progress.js';
import { stepFeatures } from '../js/step-features.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const enc = (s) => new TextEncoder().encode(s);

// a 25.7 MB assembly's counts (the large file the coefficients were fitted on)
const BIG = { step: true, bytes: 25668576, entities: 556028, faces: 15364, bounds: 27771, bounds15: 886585, bounds2: 65498007 };

test('features: records, faces, wires per face, curved surfaces', () => {
  const s = `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=ADVANCED_FACE('',(#2,#3,#4),#9,.T.);\n`
    + `#2=FACE_OUTER_BOUND('',#5,.T.);\n#3=FACE_BOUND('',#6,.F.);\n#4=FACE_BOUND('',#7,.F.);\n`
    + `#8=ADVANCED_FACE('it''s',(#2),#9,.T.);\n#9=B_SPLINE_SURFACE_WITH_KNOTS(1);\nENDSEC;\nEND-ISO-10303-21;\n`;
  const f = stepFeatures(enc(s));
  assert.equal(f.step, true);
  assert.equal(f.entities, 6);
  assert.equal(f.faces, 2);
  assert.equal(f.bounds, 3);
  assert.equal(f.bounds2, 9 + 1);
  near(f.bounds15, 3 * Math.sqrt(3) + 1);
  assert.equal(f.bsplines, 1);
});
test('features: a record split across the scan slices still counts once', () => {
  const pad = '#0=X(' + "'".padEnd(10, 'a') + "');\n";
  let s = 'ISO-10303-21;\nDATA;\n';
  while (s.length < (4 << 20) - 20) s += pad;
  s += "#1=ADVANCED_FACE('',(#2,#3),#9,.T.);\n";
  const f = stepFeatures(enc(s));
  assert.equal(f.faces, 1);
  assert.equal(f.bounds2, 4);
});
test('features: not STEP text gives the size only', () => {
  const s = 'S     1IGES file';
  const f = stepFeatures(enc(s));
  assert.equal(f.step, false);
  assert.equal(f.bytes, s.length);
});
test('forecast: the large assembly comes to about 35 s on the reference machine', () => {
  const t = forecastTotal(forecast(BIG));
  assert.ok(t > 30 && t < 40, `${t}`);
  near(forecast(BIG).read, COEF.read * 25.668576, 1e-6);
});
test('forecast: more wires on a face costs more to build', () => {
  assert.ok(forecast({ ...BIG, bounds15: 2e6 }).transfer > forecast(BIG).transfer);
});
test('forecast: a non-STEP file is forecast from its size', () => {
  const fc = forecast({ step: false, bytes: 10e6 });
  near(forecastTotal(fc), 7, 1e-9);
});
test('device factor: from the reading step, clamped, 1 when it says too little', () => {
  const fc = forecast(BIG);
  near(deviceFactor(fc, fc.read * 3), 3);
  assert.equal(deviceFactor(fc, 0.2), 1);
  assert.equal(deviceFactor(fc, fc.read * 50), 10);
});
test('step: meshing at 100% is writing the result', () => {
  assert.equal(stepOf(1, 0), 0);
  assert.equal(stepOf(2, 0.5), 1);
  assert.equal(stepOf(3, 0.99), 2);
  assert.equal(stepOf(3, 1), 3);
});
test('time left counts the steps still to come', () => {
  const fc = forecast(BIG);
  const left = timeLeft(fc, 1, 1, 0, 0);
  near(left, fc.transfer + fc.mesh + fc.write, 1e-6);
});
test('time left scales with the device', () => {
  const fc = forecast(BIG);
  near(timeLeft(fc, 2, 2, 0, 0), 2 * timeLeft(fc, 1, 2, 0, 0), 1e-6);
});
test('time left leans toward the step pace as the step advances', () => {
  const fc = forecast(BIG);
  const later = fc.mesh + fc.write;
  // half way through building the parts in 30 s: pace says 30 s more
  const left = timeLeft(fc, 1, 1, 0.5, 30, 0) - later;
  near(left, 0.5 * Math.max(0, fc.transfer - 30) + 0.5 * 30, 1e-6);
});
test('over: a step past its forecast with no pace', () => {
  const fc = forecast(BIG);
  assert.deepEqual(timeLeft(fc, 1, 0, 0, fc.read + 1), { over: true });
  assert.equal(typeof timeLeft(fc, 1, 0, 0, fc.read - 1), 'number');
});
test('over: the fraction has not moved for longer than the quiet limit', () => {
  const fc = forecast(BIG);
  assert.deepEqual(timeLeft(fc, 1, 1, 0.24, 30, QUIET_S + 1), { over: true });
});
test('over: standing still past what the pace promised', () => {
  const fc = forecast(BIG);
  // 68% after 1.2 s promised ~0.6 s more; 5 s of nothing since
  assert.deepEqual(timeLeft(fc, 1, 2, 0.68, 6.2, 5), { over: true });
  assert.equal(typeof timeLeft(fc, 1, 2, 0.68, 1.4, 0.2), 'number');
});
test('the bar: done grows through the steps and stays under the total', () => {
  const fc = forecast(BIG);
  let last = -1;
  for (const [st, f, t] of [[0, 0, 1], [0, 0, 4], [1, 0, 0], [1, 0.5, 10], [1, 1, 20], [2, 0, 0], [2, 0.7, 5], [3, 0, 1]]) {
    const d = forecastDone(fc, 1, st, f, t);
    assert.ok(d >= last, `step ${st} fraction ${f}: ${d} < ${last}`);
    assert.ok(d <= forecastTotal(fc));
    last = d;
  }
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
