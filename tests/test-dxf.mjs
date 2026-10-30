#!/usr/bin/env node
// The DXF reader (js/dxf.js) on a drawing built here, whose answers are
// known: units, layer colours, a bulge, an OCS-mirrored circle, a scaled and
// rotated insert, a MINSERT array, BYBLOCK, a solid hatch, an ellipse, a
// spline, TEXT and MTEXT, and the paper colours.
//   node tests/test-dxf.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { parseDXF, bulgePts, mtextPlain, aciColour, onPaper } from '../js/dxf.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

const dxf = (groups) => `${groups.map(([c, v]) => `${c}\n${v}`).join('\n')}\n`;
const D = [
  [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'],
  [0, 'LAYER'], [2, 'OUTLINE'], [70, 0], [62, 1],
  [0, 'LAYER'], [2, 'HOLES'], [70, 0], [62, 5],
  [0, 'LAYER'], [2, 'OFF'], [70, 0], [62, -3],
  [0, 'ENDTAB'], [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'BLOCKS'],
  [0, 'BLOCK'], [2, 'BOLT'], [10, 0], [20, 0],
  [0, 'CIRCLE'], [8, '0'], [62, 0], [10, 0], [20, 0], [40, 2],
  [0, 'ENDBLK'],
  [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'ENTITIES'],
  // a 10 mm segment with a semicircle bulge (positive: CCW), then closed back
  [0, 'LWPOLYLINE'], [8, 'OUTLINE'], [90, 2], [70, 0], [10, 0], [20, 0], [42, 1], [10, 10], [20, 0],
  // a circle seen from -Z: its OCS x runs the other way
  [0, 'CIRCLE'], [8, 'HOLES'], [10, 10], [20, 0], [40, 1], [210, 0], [220, 0], [230, -1],
  // the block scaled 2, rotated 90°, at (80, 25), on HOLES with a true colour
  [0, 'INSERT'], [8, 'HOLES'], [2, 'BOLT'], [10, 80], [20, 25], [41, 2], [42, 2], [50, 90], [420, 0x00ff00],
  // the block as a 2 x 1 array, 10 apart
  [0, 'INSERT'], [8, 'OUTLINE'], [2, 'BOLT'], [10, 0], [20, 100], [70, 2], [71, 1], [44, 10],
  [0, 'LINE'], [8, 'OUTLINE'], [62, 7], [10, 0], [20, 0], [11, 100], [21, 0],
  [0, 'ELLIPSE'], [8, 'OUTLINE'], [10, 50], [20, 50], [11, 10], [21, 0], [40, 0.5], [41, 0], [42, 6.283185307179586],
  [0, 'SPLINE'], [8, 'OUTLINE'], [70, 0], [71, 1], [72, 4], [73, 2], [40, 0], [40, 0], [40, 1], [40, 1], [10, 0], [20, 200], [10, 10], [20, 210],
  [0, 'HATCH'], [8, 'HOLES'], [70, 1], [91, 1], [92, 2], [72, 0], [73, 1], [93, 4], [10, 0], [20, 0], [10, 5], [20, 0], [10, 5], [20, 5], [10, 0], [20, 5],
  [0, 'TEXT'], [8, 'OUTLINE'], [10, 1], [20, 2], [40, 3], [1, 'Hello %%c5'],
  [0, 'MTEXT'], [8, 'OUTLINE'], [10, 1], [20, 10], [40, 2], [1, '{\\fArial|b1;Line1}\\PLine2'],
  [0, 'ENDSEC'], [0, 'EOF'],
];

const d = parseDXF(dxf(D));
const layer = (n) => d.layers.find((l) => l.name === n);
const range = (p, k) => { let lo = Infinity, hi = -Infinity; for (let i = k; i < p.pts.length; i += 2) { lo = Math.min(lo, p.pts[i]); hi = Math.max(hi, p.pts[i]); } return [lo, hi]; };

test('units and layers', () => {
  assert.equal(d.units, 'mm');
  assert.deepEqual([layer('OUTLINE').colour.r, layer('OUTLINE').colour.aci], [255, 1]);
  assert.equal(layer('HOLES').colour.b, 255);
  assert.equal(layer('OFF').on, false, 'a negative colour is a layer turned off');
});
test('the bulge: a semicircle below the chord, to y = -5', () => {
  const p = d.paths.find((x) => x.layer === 'OUTLINE' && x.pts.length > 8 && range(x, 1)[0] < -1);
  assert.ok(p, 'the bulged polyline');
  const [lo] = range(p, 1);
  assert.ok(Math.abs(lo + 5) < 0.05, `lowest y ${lo}`);
  const pts = bulgePts([0, 10], [0, 0], [-1, 0], false);
  assert.ok(Math.max(...pts.filter((_, i) => i % 2)) > 4.95, 'a negative bulge goes above');
});
test('the OCS-mirrored circle lands at x = -10', () => {
  const p = d.paths.find((x) => x.layer === 'HOLES' && x.closed && Math.abs(range(x, 0)[1] - range(x, 0)[0] - 2) < 0.01);
  assert.ok(p);
  const [lo, hi] = range(p, 0);
  assert.ok(Math.abs((lo + hi) / 2 + 10) < 1e-6, `centre x ${(lo + hi) / 2}`);
});
test('the insert: radius 4 at (80, 25), its BYBLOCK circle in the insert\'s true colour', () => {
  const p = d.paths.find((x) => x.closed && Math.abs(range(x, 0)[0] - 76) < 1e-6);
  assert.ok(p, 'a circle from x 76');
  assert.ok(Math.abs(range(p, 0)[1] - 84) < 1e-6 && Math.abs(range(p, 1)[0] - 21) < 1e-6);
  assert.deepEqual([p.colour.r, p.colour.g, p.colour.b], [0, 255, 0]);
  assert.equal(p.layer, 'HOLES', 'layer 0 inside a block takes the insert\'s');
});
test('the MINSERT: two circles 10 apart', () => {
  const xs = d.paths.filter((x) => x.closed && Math.abs(range(x, 1)[0] - 98) < 1e-6).map((x) => (range(x, 0)[0] + range(x, 0)[1]) / 2).sort((a, b) => a - b);
  assert.deepEqual(xs.map((x) => +x.toFixed(6)), [0, 10]);
});
test('the hatch is filled; the ellipse spans 20 x 10; the spline is a line', () => {
  assert.ok(d.paths.some((x) => x.fill && x.layer === 'HOLES'));
  const e = d.paths.find((x) => Math.abs(range(x, 0)[0] - 40) < 0.01 && Math.abs(range(x, 0)[1] - 60) < 0.01);
  assert.ok(e && Math.abs(range(e, 1)[1] - range(e, 1)[0] - 10) < 0.01, 'ellipse');
  const s = d.paths.find((x) => range(x, 1)[0] === 200);
  assert.ok(s && Math.abs(range(s, 0)[1] - 10) < 1e-9, 'spline');
});
test('texts: %%c, MTEXT formatting stripped; extents', () => {
  assert.deepEqual(d.texts.map((t) => t.text), ['Hello Ø5', 'Line1\nLine2']);
  assert.equal(mtextPlain('\\A1;{\\H2.5x;big}\\~x'), 'big x');
  // (the spline's end is evaluated a hair inside its last knot)
  assert.ok(Math.abs(d.extents.min[0] + 11) < 1e-6 && Math.abs(d.extents.max[1] - 210) < 1e-6, JSON.stringify(d.extents));
});
test('colours on paper: ACI 7 black, yellow darkened to 3:1', () => {
  assert.equal(onPaper(aciColour(7)), '#000000');
  const y = onPaper(aciColour(2));
  assert.notEqual(y, '#ffff00');
  assert.equal(aciColour(250).r, 51);
});
test('not a DXF: refused in words', () => {
  assert.throws(() => parseDXF('AC1015 binary'), /not an ASCII DXF/);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
