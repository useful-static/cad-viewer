#!/usr/bin/env node
// The unit formatter (js/units.js).   node tests/test-units.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DISPLAY_UNITS, MM_PER, autoUnit, displayUnit, fmtArea, fmtMass, fmtNum, fmtUnconverted, fmtVolume, lengthUnitOf, unconvertedBack, unconvertedNum, unconvertedUnit, unitSaid, unitWord } from '../js/units.js';

import { test, done } from './harness.mjs';

test('a geometry unit by its one name, and a volume or area in a unit not converted (r86 A4, A5, A8)', () => {
  assert.deepEqual(['in', 'inch', 'INCH', 'Inches', 'millimeter', 'mm', 'metre', 'cm', 'furlong', 7].map(lengthUnitOf), ['in', 'in', 'in', 'in', 'mm', 'mm', 'm', 'cm', null, null]);
  // (a short name folded only in one case; the viewer's own µm -- "Mm" was mm, "µm" unknown: r88 A7)
  assert.deepEqual(['Mm', 'MM', 'IN', 'µm', 'μm'].map(lengthUnitOf), [null, 'mm', 'in', 'um', 'um']);
  // (each name's plural too: "inches" was one and "millimeters" not -- r87 A1)
  assert.deepEqual(['millimeters', 'meters', 'centimetres', 'inches', 'feet'].map(lengthUnitOf), ['mm', 'm', 'cm', 'in', 'ft']);
  // (a unit in a sentence by one table: "read in cm" beside "in centimetres" -- r87 A5)
  assert.deepEqual(['mm', 'cm', 'in', 'um', 'furlong'].map(unitSaid), ['millimetres', 'centimetres', 'inches', 'micrometres', 'furlong']);
  // (a length in such a unit to 4 significant digits, typed back as it reads: "2.3 × 1.5 × 0.1" of a
  // 2.25 × 1.5 × 0.062 in board -- r87 Q3)
  // (by that unit's own decimals where it is a display unit, as converted: 4 significant digits read
  // 120.375 in "120.4" -- r88 A3; else 6 significant digits)
  assert.deepEqual([2.25, 0.062, 120.375, 1234.5].map((x) => unconvertedNum(x, 'measure', 'inch')), ['2.250', '0.062', '120.375', '1234.500']);
  assert.deepEqual([2.25, 1234.567891].map((x) => unconvertedNum(x, 'measure', 'furlong')), ['2.25', '1234.57']);
  // (in Auto's display unit for the header's, as converted: a 0.123 m board in mm, its 0.4 mm part
  // "0.4", its section field typed back in mm -- must fire: "0.000" m, a cut moved 0.34 mm, r89 Q1)
  assert.equal(unconvertedUnit('m', 0.123), 'mm');
  assert.equal(unconvertedUnit('m', 2), 'm');
  assert.equal(unconvertedUnit('furlong', 1), null);
  assert.deepEqual([0.0004, 0.0016, 0.123].map((x) => unconvertedNum(x, 'size', 'm', 0.123)), ['0.4', '1.6', '123.0']);
  assert.equal(unconvertedNum(0.0004, 'size', 'm', 2), '0.000');
  const shown = unconvertedNum(0.01234, 'section', 'm', 0.123);
  assert.equal(shown, '12.3');
  assert.ok(Math.abs(unconvertedBack(Number(shown), 'm', 0.123) - 0.0123) < 1e-12);
  assert.equal(unconvertedBack(2.5, 'inch', 3), 2.5);
  assert.equal(unconvertedBack(2.5, 'furlong', 3), 2.5);
  // (the one rule for 2D too: a site plan in mm by mm's decimals, "123457" in 2D Measure beside 3D's
  // "123456.79"; a drawing's noise floor -- r89 A5, Q3)
  assert.equal(unconvertedNum(123456.789, 'measure', 'mm'), '123456.79');
  assert.equal(unconvertedNum(1e-12, 'measure', 'furlong', Infinity, 1e-9), '0');
  assert.equal(unconvertedNum(1e-12, 'measure', 'mm', Infinity, 1e-9), '0.00');
  assert.equal(unconvertedNum(0.5, 'measure', 'm', Infinity), '0.5000');
  // (must fire: an inch cube's volume "≈ 1 mm³", its area "≈ 6 mm²")
  assert.equal(fmtUnconverted(1, 'inch', 3), '1 inch³ (not converted)');
  assert.equal(fmtUnconverted(6, 'inch', 2), '6 inch² (not converted)');
});
test('fixed decimals per unit: a measurement', () => {
  assert.deepEqual(['mm', 'cm', 'm', 'in'].map((u) => fmtNum(25.4, 'measure', u)), ['25.40', '2.540', '0.0254', '1.000']);
});
test('a size or section position has one decimal fewer', () => {
  assert.equal(fmtNum(5080, 'size', 'mm'), '5080.0');
  assert.equal(fmtNum(5080, 'size', 'in'), '200.00');
  assert.equal(fmtNum(-12.345, 'section', 'cm'), '-1.23');
  // (zero as shown is zero, no minus: float noise read "-0.0" as an overhang -- must fire, r90 A5)
  assert.deepEqual([fmtNum(-1e-6, 'size', 'mm'), fmtNum(-1e-6, 'measure', 'in'), fmtNum(-0.06, 'size', 'mm')], ['0.0', '0.000', '-0.1']);
  assert.equal(unconvertedNum(-1e-9, 'size', 'furlong', 3, 3e-9), '0');
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
test('Auto: a model declared in metres but under a metre across is shown in mm', () => {
  // a 123 mm board whose STEP declares metres read "0.123 × 0.072 × 0.012 m" (e2e review)
  assert.equal(autoUnit('m', 123), 'mm');
  assert.equal(autoUnit('m', 999.9), 'mm');
  assert.equal(autoUnit('m', 5080), 'm'); // a rack: metres it says, metres it is
  assert.equal(autoUnit('km', 50), 'mm');
  assert.equal(autoUnit('in', 50), 'in'); // only metres: an inch file stays in inches
  assert.equal(displayUnit('auto', 'm', 123), 'mm');
  assert.equal(displayUnit('m', 'm', 123), 'm'); // an explicit choice still wins
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

test('a unit as written for a reader: µm and µin typeset, the rest as named', () => {
  assert.equal(unitWord('um'), 'µm');
  assert.equal(unitWord('uin'), 'µin');
  assert.equal(unitWord('mm'), 'mm');
});
test('every display unit has decimals and a system; the pickers carry no unit list of their own', () => {
  for (const u of DISPLAY_UNITS) {
    assert.ok(Number.isFinite(MM_PER[u]), u);
    assert.match(fmtNum(1, 'measure', u), /^\d+\.\d+$/);
  }
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['unitsel', 'meshunit']) {
    const sel = new RegExp(`<select id="${id}"[\\s\\S]*?</select>`).exec(html)[0];
    assert.ok(!/<option value="(mm|cm|m|in)"/.test(sel), `${id}: ${sel}`);
  }
});

test('Auto, derived from the tables: each declared unit to itself or its system\'s nearest display unit', () => {
  const want = { nm: 'mm', 'Å': 'mm', um: 'mm', mm: 'mm', cm: 'cm', dm: 'cm', m: 'm', dam: 'm', hm: 'm', km: 'm', Gm: 'm',
    AU: 'm', ly: 'm', pc: 'm', uin: 'in', mil: 'in', in: 'in', ft: 'in', 'US ft': 'in', yd: 'in', mi: 'in' };
  for (const [u, w] of Object.entries(want)) assert.equal(autoUnit(u), w, u);
  assert.equal(autoUnit(null), 'mm');
  assert.equal(autoUnit('mixed'), 'mm');
});

done();
