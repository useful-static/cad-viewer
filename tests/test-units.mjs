#!/usr/bin/env node
// The unit formatter (js/units.js).   node tests/test-units.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { autoUnit, displayUnit, fmtArea, fmtLength, fmtMass, fmtNum, fmtVolume } from '../js/units.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

test('fixed decimals per unit: a measurement', () => {
  assert.equal(fmtLength(25.4, 'measure', 'mm'), '25.40 mm');
  assert.equal(fmtLength(25.4, 'measure', 'cm'), '2.540 cm');
  assert.equal(fmtLength(25.4, 'measure', 'm'), '0.0254 m');
  assert.equal(fmtLength(25.4, 'measure', 'in'), '1.000 in');
});
test('a size or section position has one decimal fewer', () => {
  assert.equal(fmtNum(5080, 'size', 'mm'), '5080.0');
  assert.equal(fmtNum(5080, 'size', 'in'), '200.00');
  assert.equal(fmtLength(-12.345, 'section', 'cm'), '-1.23 cm');
});
test('Auto: the declared unit, its nearest display unit, else mm', () => {
  assert.equal(autoUnit('in'), 'in');
  assert.equal(autoUnit('ft'), 'in');
  assert.equal(autoUnit('m'), 'm');
  assert.equal(autoUnit('um'), 'mm');
  assert.equal(autoUnit('mixed'), 'mm');
  assert.equal(autoUnit(null), 'mm');
  assert.equal(autoUnit(undefined), 'mm');
});
test('an explicit choice wins over Auto; anything else is Auto', () => {
  assert.equal(displayUnit('cm', 'in'), 'cm');
  assert.equal(displayUnit('auto', 'in'), 'in');
  assert.equal(displayUnit(null, null), 'mm');
  assert.equal(displayUnit('furlong', 'in'), 'in');
});
test('volume: the AS1 sample in inches reads in ft³ (765,095 in³)', () => {
  assert.equal(fmtVolume(765095 * 25.4 ** 3, 'in'), '442.8 ft³');
  assert.equal(fmtVolume(99999 * 25.4 ** 3, 'in'), '100,000 in³');
  assert.equal(fmtVolume(500, 'mm'), '500 mm³');
  assert.equal(fmtVolume(2.5e6, 'mm'), '2,500 cm³');
  assert.equal(fmtVolume(12.549e9, 'mm'), '12.55 m³');
});
test('area: in² then ft²; mm², cm², m²', () => {
  assert.equal(fmtArea(645.16, 'in'), '1 in²');
  assert.equal(fmtArea(2e4 * 645.16, 'in'), '138.9 ft²');
  assert.equal(fmtArea(5000, 'cm'), '5,000 mm²');
  assert.equal(fmtArea(5e5, 'm'), '5,000 cm²');
  assert.equal(fmtArea(3e8, 'mm'), '300 m²');
});
test('mass: g, kg, or lb for inches', () => {
  assert.equal(fmtMass(12.34, 'mm'), '12.34 g');
  assert.equal(fmtMass(12345, 'm'), '12.35 kg');
  assert.equal(fmtMass(453.59237, 'in'), '1 lb');
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
