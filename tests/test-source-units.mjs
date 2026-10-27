#!/usr/bin/env node
// The unit a file declares (js/source-units.js): constructed STEP and IGES
// texts, plus a real inch file when CADV_INCH_STEP names one.
//   node tests/test-source-units.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { igesUnits, sourceUnits, unitOfFactor } from '../js/source-units.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
const enc = (s) => new TextEncoder().encode(s);
const step = (data) => enc(`ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`);

// one context and the shape representation that uses it; `len` is the length
// unit's record(s), its id #10
const ctx = (cid, len, rep = 'ADVANCED_BREP_SHAPE_REPRESENTATION') => `
#${cid}=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${cid + 1}))
GLOBAL_UNIT_ASSIGNED_CONTEXT((${len},#${cid + 3},#${cid + 4}))REPRESENTATION_CONTEXT
('ID1','3'));
#${cid + 2}=${rep}('',(#${cid + 5}),#${cid});`;
const angles = (cid) => `
#${cid + 3}=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#${cid + 4}=(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT());`;
const MM = '#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));';
const M = '#11=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.));';
// an inch the AS1 way: a conversion-based unit on an SI millimetre base
const INCH = `#12=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#13=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(2.54E1),#12);
#14=(CONVERSION_BASED_UNIT('INCH',#13)LENGTH_UNIT()NAMED_UNIT(#15));`;

test('an SI millimetre file is mm', () => {
  assert.equal(sourceUnits(step(MM + ctx(100, '#10') + angles(100)), 'step'), 'mm');
});
test('an SI metre file (no prefix) is m', () => {
  assert.equal(sourceUnits(step(M + ctx(100, '#11') + angles(100)), 'step'), 'm');
});
test('an inch defined on a mm base is in, not mm', () => {
  assert.equal(sourceUnits(step(INCH + ctx(100, '#14') + angles(100)), 'step'), 'in');
});
test('the factor decides, not the name: a unit called INCH of 304.8 mm is ft', () => {
  const ft = INCH.replace('2.54E1', '3.048E2');
  assert.equal(sourceUnits(step(ft + ctx(100, '#14') + angles(100)), 'step'), 'ft');
});
test('a forward reference resolves (the context before its units)', () => {
  assert.equal(sourceUnits(step(ctx(100, '#14') + angles(100) + INCH), 'step'), 'in');
});
test('a degree angle unit does not mislead it', () => {
  const deg = `#103=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#120=PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(1.745329251994E-2),#103);
#121=(CONVERSION_BASED_UNIT('DEGREE',#120)NAMED_UNIT(*)PLANE_ANGLE_UNIT());
#104=(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT());`;
  // the angle unit listed FIRST in the context
  const c = ctx(100, '#14').replace('((#14,#103,#104))', '((#121,#14,#104))');
  assert.equal(sourceUnits(step(INCH + deg + c), 'step'), 'in');
});
test('two shape contexts that disagree are mixed', () => {
  assert.equal(sourceUnits(step(MM + INCH + ctx(100, '#10') + angles(100) + ctx(200, '#14') + angles(200)), 'step'), 'mixed');
});
test('a context no shape representation uses does not count', () => {
  // the inch context's representation is a draughting one, not a shape one
  const other = ctx(200, '#14', 'DRAUGHTING_MODEL');
  assert.equal(sourceUnits(step(MM + INCH + ctx(100, '#10') + angles(100) + other + angles(200)), 'step'), 'mm');
});
test('a record wrapped mid-keyword still reads', () => {
  const wrapped = ctx(100, '#14').replace('GLOBAL_UNIT_ASSIGNED', 'GLOBAL_UN\nIT_ASSIGNED');
  assert.equal(sourceUnits(step(INCH + wrapped + angles(100)), 'step'), 'in');
});
test('no unit context: unknown (null), never mm', () => {
  assert.equal(sourceUnits(step('#1=CARTESIAN_POINT(\'\',(0.,0.,0.));'), 'step'), null);
  assert.equal(sourceUnits(enc('not a step file'), 'step'), null);
  assert.equal(sourceUnits(enc('DBRep_DrawableShape'), 'brep'), null);
});
test('unitOfFactor knows the common units and refuses others', () => {
  assert.equal(unitOfFactor(25.4), 'in');
  assert.equal(unitOfFactor(25.4 * (1 + 1e-9)), 'in');
  assert.equal(unitOfFactor(10), 'cm');
  assert.equal(unitOfFactor(7), null);
  assert.equal(unitOfFactor(null), null);
});

// IGES: 80-column lines, G in column 73
const iges = (g) => {
  const lines = [];
  lines.push(`${'a test'.padEnd(72)}S      1`);
  for (let i = 0, n = 1; i < g.length; i += 72, n++) lines.push(`${g.slice(i, i + 72).padEnd(72)}G${String(n).padStart(7)}`);
  return enc(lines.join('\n') + '\n');
};
// parameters 1..15: delimiters, product ids, file name, system, preprocessor,
// integer/float sizes (7..11), scale (13), units flag (14), units name (15)
const G = (flag, name) => `1H,,1H;,4HPART,8Hpart.igs,9HSome, CAD,3H1.0,32,38,6,308,15,4HPART,1.0,${flag},${name};`;
test('IGES units flag 2 is mm, 1 is in, 10 is cm', () => {
  assert.equal(igesUnits(iges(G(2, '2HMM'))), 'mm');
  assert.equal(igesUnits(iges(G(1, '4HINCH'))), 'in');
  assert.equal(igesUnits(iges(G(10, '2HCM'))), 'cm');
});
test('IGES flag 3 reads the unit name; a comma inside a Hollerith string is not a delimiter', () => {
  assert.equal(igesUnits(iges(G(3, '4HINCH'))), 'in');
});
test('IGES default delimiters (parameters 1 and 2 empty)', () => {
  assert.equal(igesUnits(iges(',,4HPART,8Hpart.igs,3HCAD,3H1.0,32,38,6,308,15,4HPART,1.0,6,1HM;')), 'm');
});

// a real inch file (an AP203 sample whose inch is a CONVERSION_BASED_UNIT on
// an SI millimetre): CADV_INCH_STEP=<file.stp>
const inchFile = process.env.CADV_INCH_STEP;
if (inchFile && existsSync(inchFile)) {
  test(`${inchFile} reads in (its inch is a CONVERSION_BASED_UNIT on mm)`, () => {
    assert.equal(sourceUnits(readFileSync(inchFile), 'step'), 'in');
  });
} else {
  console.log('SKIP inch file: set CADV_INCH_STEP=<an inch STEP file>');
}

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
