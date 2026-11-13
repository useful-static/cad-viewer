#!/usr/bin/env node
// The DXF reader (js/dxf.js) on a drawing built here, whose answers are
// known: units, layer colours, a bulge, an OCS-mirrored circle, a scaled and
// rotated insert, a MINSERT array, BYBLOCK, a solid hatch, an ellipse, a
// spline, TEXT and MTEXT, and the paper colours.
//   node tests/test-dxf.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { UNITS, blockKey, parseDXF, inOutline, insideFlat, edgeOverlaps, layersOf, drawsNothing, sheetsOf, bulgePts, mtextPlain, textCodes, textCorners, unescapeDxf, wrapLines, valueKind, aciColour, onPaper, caret, uncaret, openCounts, insidePieces, bandPolys, outlineIndex, TEXT_CAP, emOf, pitchOf } from '../js/dxf.js';
import { unescapeDxf as dwgCompareUnescape } from './dwg-compare.mjs';
import { sniffFormat } from '../js/formats.js';
import { addedReversed, measureText, nearestPoint, nearestSegment, pickAt, pointTree, segmentIndex, sizeRow, snapPoints, textIndex } from '../js/dxf-view.js';
import { boxTree, nearestItem } from '../js/box-tree.js';
import { DWG_CODEPAGES, codePageLabel, cp1252Over, decoderFor } from '../js/codepages.js';

import { test, done } from './harness.mjs';

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
test('$INSUNITS 22-24, the US survey inch, yard and mile, are units (r88 Q3)', () => {
  // (must fire: "not stored in the file" of a file that stores its unit)
  assert.deepEqual([22, 23, 24].map((c) => UNITS[c] && UNITS[c][0]), ['US in', 'US yd', 'US mi']);
  assert.ok(Math.abs(UNITS[22][1] / 25.4 - 1) < 3e-6 && UNITS[22][1] !== 25.4);
});
test('a layer or block named in another case is that layer or block (r87 Q4)', () => {
  const p = (...a) => new TextEncoder().encode(a.join('\n') + '\n').buffer;
  const line = (l) => ['0', 'LINE', '8', l, '10', '0', '20', '0', '11', '1', '21', '1'];
  const d = parseDXF(p('0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '0', 'LAYER', '2', 'WALLS', '70', '1', '62', '7', '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'Door', '10', '0', '20', '0', ...line('0'), '0', 'ENDBLK', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', ...line('walls'), '0', 'INSERT', '2', 'door', '8', '0', '10', '5', '20', '5', '0', 'ENDSEC', '0', 'EOF'));
  // (must fire: a second, visible "walls" layer, and the door drawing nothing)
  assert.deepEqual(d.layers.map((l) => l.name), ['WALLS', '0']);
  assert.deepEqual(d.paths.map((x) => x.layer), ['WALLS', '0']);
  // (a name whose upper case is longer keeps its own characters: "Straße" and "STRASSE", "oﬁce" and
  // "OFICE", two blocks and two layers -- must fire: both inserts drew the second's line, r89 Q2;
  // "Tür" / "TÜR" one, as before)
  const pairs = (a) => p(...a.flatMap(([c, v]) => [String(c), String(v)]));
  const block = (name, x1) => [[0, 'BLOCK'], [8, '0'], [2, name], [10, 0], [20, 0], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, x1], [21, 0], [0, 'ENDBLK']];
  const insert = (name, y) => [[0, 'INSERT'], [8, name], [2, name], [10, 0], [20, y]];
  for (const [a, b, want] of [['Straße', 'STRASSE', [10, 99]], ['oﬁce', 'OFICE', [10, 99]], ['Tür', 'TÜR', [99, 99]]]) {
    const q = parseDXF(pairs([[0, 'SECTION'], [2, 'BLOCKS'], ...block(a, 10), ...block(b, 99), [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'], ...insert(a, 0), ...insert(b, 5), [0, 'ENDSEC'], [0, 'EOF']]));
    assert.deepEqual(q.paths.map((x) => Math.abs(x.pts[2] - x.pts[0])), want, `${a} / ${b}`);
  }
  assert.equal(blockKey(' Straße '), 'STRAßE');
});
test('2D Measure\'s readout by the 3D panel\'s rule: its unit\'s decimals, Auto\'s unit by size, the noise floor (r89 Q3, r90 A2)', () => {
  // (must fire: "123457 mm", r89 Q3; a 0.04 mm gap in a 0.1 m drawing in metres "0.0000 m", r90 A2)
  assert.equal(measureText(123456.789, 123456.789, 0, 'mm', 200000), '123456.79 mm · ΔX 123456.79 · ΔY 0.00');
  assert.equal(measureText(0.00004, 0.00004, 1e-12, 'm', 0.1), '0.04 mm · ΔX 0.04 · ΔY 0.00');
  assert.equal(measureText(4, 4, 0, 'm', 5), '4.0000 m · ΔX 4.0000 · ΔY 0.0000');
  assert.equal(measureText(1.5, 1.5, 1e-12, 'US ft', 10), '1.5 US ft · ΔX 1.5 · ΔY 0');
  // (no unit: "units", as the size row and the 3D panel say -- it wrote no word: r93 A4)
  assert.equal(measureText(1.5, 0, 1.5, null, 10), '1.5 units · ΔX 0 · ΔY 1.5');
});
test('the 2D info\'s size row by 2D Measure\'s unit and span: a drawing in metres 0.1 m across in mm, 5 m across in m (r91 Q3)', () => {
  // (must fire: "size (m) 0.100 × 0.050" beside 2D Measure's mm -- r90 A2's fault in the info panel)
  const ext = (w, h) => ({ min: [0, 0], max: [w, h] });
  assert.deepEqual(sizeRow(ext(0.1, 0.05), 'm'), ['size (mm)', '100.0 × 50.0']);
  assert.deepEqual(sizeRow(ext(5, 2), 'm'), ['size (m)', '5.000 × 2.000']);
  assert.deepEqual(sizeRow(ext(100, 50), 'mm'), ['size (mm)', '100.0 × 50.0']);
  assert.deepEqual(sizeRow(ext(3, 1), null), ['size (units)', '3 × 1']);
});
test('texts: %%c, MTEXT formatting stripped; extents', () => {
  // (a column break is a new line, as a paragraph is -- drawn as the two characters: r85 Q5)
  assert.equal(mtextPlain(String.raw`one\Ncol`), 'one\ncol');
  assert.deepEqual(d.texts.map((t) => t.text), ['Hello Ø5', 'Line1\nLine2']);
  assert.equal(mtextPlain('\\A1;{\\H2.5x;big}\\~x'), 'big x');
  // (the spline's end is evaluated a hair inside its last knot)
  assert.ok(Math.abs(d.extents.min[0] + 11) < 1e-6 && Math.abs(d.extents.max[1] - 210) < 1e-6, JSON.stringify(d.extents));
});
test('colours on paper: ACI 7 black, yellow darkened to 3:1', () => {
  assert.equal(onPaper(aciColour(7)), '#000000');
  const y = onPaper(aciColour(2));
  assert.notEqual(y, '#ffff00');
  assert.equal(aciColour(250).r, 51);
});
test('the ACI palette: the standard shades and greys (truncated levels)', () => {
  const hex = (i) => { const c = aciColour(i); return [c.r, c.g, c.b].map((x) => x.toString(16).padStart(2, '0')).join(''); };
  const want = { 10: 'ff0000', 11: 'ff7f7f', 12: 'cc0000', 13: 'cc6666', 14: '990000', 15: '994c4c', 16: '7f0000', 17: '7f3f3f', 18: '4c0000', 19: '4c2626', 20: 'ff3f00', 251: '5b5b5b', 253: 'adadad', 254: 'd6d6d6' };
  for (const [i, h] of Object.entries(want)) assert.equal(hex(Number(i)), h, `ACI ${i}`);
});
test('line types and weights: BYLAYER pattern x $LTSCALE, the layer weight, an entity override', () => {
  const L = [
    [0, 'SECTION'], [2, 'HEADER'], [9, '$LTSCALE'], [40, 2], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LTYPE'],
    [0, 'LTYPE'], [2, 'DASHED'], [70, 0], [73, 2], [40, 7.5], [49, 5], [49, -2.5],
    [0, 'ENDTAB'], [0, 'TABLE'], [2, 'LAYER'],
    [0, 'LAYER'], [2, 'DASH'], [70, 0], [62, 3], [6, 'DASHED'], [370, 50],
    [0, 'ENDTAB'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LINE'], [8, 'DASH'], [10, 0], [20, 0], [11, 100], [21, 0],
    [0, 'LINE'], [8, 'DASH'], [6, 'CONTINUOUS'], [370, 25], [10, 0], [20, 5], [11, 100], [21, 5],
    [0, 'ENDSEC'], [0, 'EOF'],
  ];
  const d2 = parseDXF(dxf(L));
  const [a, b] = d2.paths;
  assert.deepEqual(a.dash, [10, 5], `dash ${a.dash}`);
  assert.equal(a.weight, 0.5);
  assert.equal(b.dash, null);
  assert.equal(b.weight, 0.25);
  // (dashes by how much each shape is stretched as drawn: by the insert's x axis alone, a dashed line
  // along y in a 1 x 4 insert was drawn 40 long with 1-unit dashes, and in one tilted 45° about y
  // shortened to 7.071 with its dashes full -- r97 A2)
  const inserted = (ins) => parseDXF(dxf([...L.slice(0, L.findIndex(([c, v], i) => c === 0 && v === 'ENDSEC' && i > 5) + 1),
    [0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [2, 'B'], [10, 0], [20, 0], [0, 'LINE'], [8, 'DASH'], [10, 0], [20, 0], [11, 0], [21, 10], [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, '0'], [2, 'B'], [10, 0], [20, 0], ...ins, [0, 'ENDSEC'], [0, 'EOF']])).paths[0];
  const tall = inserted([[41, 1], [42, 4]]);
  assert.deepEqual([tall.pts[3], tall.dash], [40, [40, 20]], 'stretched 4 along y: dashes 4 x');
  // (shapes of one pattern and one stretch share one dash array -- measured per shape, rounding gave
  // each its own and split one stroke into thousands: r97 Q2)
  const many = parseDXF(dxf([...L.slice(0, L.findIndex(([c, v], i) => c === 0 && v === 'ENDSEC' && i > 5) + 1),
    [0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [2, 'B'], [10, 0], [20, 0],
    ...[3, 7.3, 11.1, 0.37].flatMap((len, i) => [[0, 'LINE'], [8, 'DASH'], [10, i], [20, 0], [11, i + len * 0.6], [21, len * 0.8]]), [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], ...[3, 7.3, 11.1, 0.37].flatMap((len, i) => [[0, 'LINE'], [8, 'DASH'], [10, i], [20, 0], [11, i + len * 0.6], [21, len * 0.8]]),
    [0, 'INSERT'], [8, '0'], [2, 'B'], [10, 0], [20, 0], [41, 1.3], [42, 3.7], [0, 'ENDSEC'], [0, 'EOF']])).paths;
  assert.equal(new Set(many.slice(0, 4).map((p) => JSON.stringify(p.dash))).size, 1, 'flat: one dash array');
  assert.equal(new Set(many.slice(4).map((p) => JSON.stringify(p.dash))).size, 1, `stretched alike: one dash array, got ${JSON.stringify(many.slice(4).map((p) => p.dash))}`);
  // (a shape not flat in the view's plane takes no uniform-scale shortcut: a tilted CIRCLE and the
  // ELLIPSE drawn the same dashed 0.8125 and 1; a 3D LINE dashed 1.0 in a 1 x 1 insert and 0.6 in a
  // 1 x 1.1 one, a y stretch it does not touch -- r98 A3)
  const T = L.slice(0, L.findIndex(([c, v], i) => c === 0 && v === 'ENDSEC' && i > 5) + 1);
  const tN = [[210, 0.6], [220, 0], [230, 0.8]];
  const [ci, el] = parseDXF(dxf([...T, [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'CIRCLE'], [8, 'DASH'], [10, 0], [20, 0], [40, 5], ...tN,
    // (the same circle as an ELLIPSE of ratio 1: its major the circle's OCS x in world, (0, 1, 0) for N (0.6, 0, 0.8))
    [0, 'ELLIPSE'], [8, 'DASH'], [10, 0], [20, 0], [30, 0], [11, 0], [21, 5], [31, 0], [40, 1], ...tN,
    [0, 'ENDSEC'], [0, 'EOF']])).paths;
  assert.ok(Math.abs(ci.dash[0] / el.dash[0] - 1) < 1e-3, `circle ${ci.dash}, ellipse ${el.dash}`);
  const line3 = (sy) => parseDXF(dxf([...T, [0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [2, 'B'], [10, 0], [20, 0],
    [0, 'LINE'], [8, 'DASH'], [10, 0], [20, 0], [30, 0], [11, 3], [21, 0], [31, 4], [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, '0'], [2, 'B'], [10, 0], [20, 0], [41, 1], [42, sy], [0, 'ENDSEC'], [0, 'EOF']])).paths[0].dash;
  assert.deepEqual([line3(1), line3(1.1)], [[6, 3], [6, 3]], 'a 3D line dashed by its drawn length over its own, 3 of 5');
  const tilt = inserted([[210, Math.SQRT1_2], [220, 0], [230, Math.SQRT1_2]]);
  const seen = Math.hypot(tilt.pts[2] - tilt.pts[0], tilt.pts[3] - tilt.pts[1]);
  assert.ok(Math.abs(seen / 10 - tilt.dash[0] / 10) < 1e-9, `seen ${seen}, dash ${tilt.dash}`);
});
test('not a DXF: refused in words', () => {
  assert.throws(() => parseDXF('AC1015 binary'), /not a DXF file/);
});

// A binary DXF of the same groups, as AutoCAD writes one: the sentinel, then
// each group code (2 bytes from R13; 1 byte, 255 escaping, in R12) and its
// value typed by the code (strings null-terminated, doubles, int16/32, bools)
function binaryDXF(groups, oneByte = false) {
  const parts = [new TextEncoder().encode('AutoCAD Binary DXF\r\n\x1a\x00')];
  // (the reader's own table of value kinds: this writer's copy wrote 310 chunks as strings and 160
  // int64s as int16, so the reader's 'bin' and 'i64' branches were never run)
  const kind = valueKind;
  for (const [c, v] of groups) {
    const code = oneByte ? (c < 255 ? Uint8Array.of(c) : Uint8Array.of(255, c & 255, c >> 8)) : Uint8Array.of(c & 255, c >> 8);
    parts.push(code);
    const k = kind(c);
    if (k === 's') parts.push(new TextEncoder().encode(`${v}\0`));
    else if (k === 'bin') {
      // a binary chunk: a length byte, then the bytes (the value given as hex)
      const hex = String(v);
      const bytes = Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));
      parts.push(Uint8Array.of(bytes.length), bytes);
    } else if (k === 'i64') {
      const b = new DataView(new ArrayBuffer(8));
      b.setBigInt64(0, BigInt(v), true);
      parts.push(new Uint8Array(b.buffer));
    } else {
      const b = new DataView(new ArrayBuffer(k === 'd' ? 8 : k === 'i32' ? 4 : k === 'b' ? 1 : 2));
      if (k === 'd') b.setFloat64(0, Number(v), true);
      else if (k === 'i32') b.setInt32(0, Number(v), true);
      else if (k === 'b') b.setUint8(0, Number(v));
      else b.setInt16(0, Number(v), true);
      parts.push(new Uint8Array(b.buffer));
    }
  }
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

test('a binary DXF reads as its ASCII twin (R13+ two-byte codes, R12 one-byte)', () => {
  const text = parseDXF(dxf(D));
  for (const one of [false, true]) {
    const bin = parseDXF(binaryDXF(D, one));
    assert.equal(bin.units, text.units, `units (${one ? 'R12' : 'R13+'})`);
    assert.deepEqual(bin.layers.map((l) => [l.name, l.colour, l.on]), text.layers.map((l) => [l.name, l.colour, l.on]));
    assert.equal(bin.paths.length, text.paths.length, 'paths');
    assert.equal(bin.texts.length, text.texts.length, 'texts');
    assert.deepEqual(bin.extents, text.extents, 'extents');
  }
});

test('a binary DXF with 310 binary chunks and 160 int64 values between drawn entities reads them as data', () => {
  const G = [[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LINE'], [8, '0'], [160, '123456789012'], [10, 0], [20, 0], [11, 3], [21, 4],
    [0, 'OLE2FRAME'], [8, '0'], [310, '0001020304ff'], [310, 'deadbeef'], [1004, 'cafe'],
    [0, 'LINE'], [8, '0'], [10, 1], [20, 1], [11, 2], [21, 2],
    [0, 'ENDSEC'], [0, 'EOF']];
  const d = parseDXF(binaryDXF(G));
  assert.equal(d.paths.length, 2, 'both lines, the chunks and the int64 read past as their own lengths');
  assert.deepEqual([...d.paths[0].pts], [0, 0, 3, 4]);
  assert.deepEqual([...d.paths[1].pts], [1, 1, 2, 2]);
});
// (r113 M2 dxf-C47) the value-kind table against the DXF reference's "group code value types",
// written out here (binaryDXF above takes the reader's own table, so it cannot see a change to it),
// and a binary DXF whose bytes are spelled out: every value's width typed by hand
test('valueKind matches the DXF reference\'s group-code ranges, and a hand-spelled binary DXF reads (r113 M2 dxf-C47)', () => {
  const REF = [
    [0, 9, 's'], [10, 39, 'd'], [40, 59, 'd'], [60, 79, 'i16'], [90, 99, 'i32'], [100, 100, 's'], [102, 102, 's'], [105, 105, 's'],
    [110, 149, 'd'], [160, 169, 'i64'], [170, 179, 'i16'], [210, 239, 'd'], [270, 289, 'i16'], [290, 299, 'b'],
    [300, 309, 's'], [310, 319, 'bin'], [320, 369, 's'], [370, 389, 'i16'], [390, 399, 's'], [400, 409, 'i16'],
    [410, 419, 's'], [420, 429, 'i32'], [430, 439, 's'], [440, 459, 'i32'], [460, 469, 'd'], [470, 481, 's'],
    [999, 999, 's'], [1000, 1003, 's'], [1004, 1004, 'bin'], [1005, 1009, 's'], [1010, 1059, 'd'], [1060, 1070, 'i16'], [1071, 1071, 'i32'],
  ];
  const wrong = [];
  for (const [a, b, k] of REF) for (let c = a; c <= b; c++) if (valueKind(c) !== k) wrong.push(`${c}: ${valueKind(c)} (want ${k})`);
  assert.deepEqual(wrong, []);
  // the groups, code then value, as hex bytes little-endian (a string's bytes then its 00)
  const str = (s) => [...s].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('') + '00';
  const hex = [
    '0000', str('SECTION'), '0200', str('HEADER'), '0900', str('$INSUNITS'), '4600', '0400', '0000', str('ENDSEC'),
    '0000', str('SECTION'), '0200', str('ENTITIES'),
    '0000', str('LINE'), '0800', str('0'),
    '3e00', '0100', // 62 (int16): colour 1
    '5a00', '07000000', // 90 (int32)
    'a000', '0807060504030201', // 160 (int64)
    '2201', '01', // 290 (bool, one byte)
    '0a00', '0000000000000000', '1400', '0000000000000000', // 10, 20: 0.0
    '0b00', '0000000000000840', '1500', '0000000000001040', // 11: 3.0, 21: 4.0
    '0000', str('ENDSEC'), '0000', str('EOF'),
  ].join('');
  const sentinel = new TextEncoder().encode('AutoCAD Binary DXF\r\n\x1a\x00');
  const body = Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
  const buf = new Uint8Array(sentinel.length + body.length);
  buf.set(sentinel); buf.set(body, sentinel.length);
  const d = parseDXF(buf.buffer);
  assert.equal(d.units, parseDXF(dxf([[0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 3], [21, 4], [0, 'ENDSEC'], [0, 'EOF']])).units);
  assert.ok(d.units, 'the header\'s $INSUNITS 4 read');
  assert.equal(d.paths.length, 1);
  assert.deepEqual([...d.paths[0].pts], [0, 0, 3, 4]);
});
test('paper space is not drawn in the model: a 67 = 1 entity is left out and counted', () => {
  const ents = [[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 10], [21, 0],
    [0, 'LINE'], [8, '0'], [67, 1], [10, 500], [20, 500], [11, 600], [21, 500],
    [0, 'ENDSEC'], [0, 'EOF']];
  const d = parseDXF(dxf(ents));
  assert.equal(d.paths.length, 1, 'only the model-space line');
  assert.equal(d.paperSpace, 1, 'one paper-space entity counted');
  assert.ok(d.extents.max[0] <= 10, `extents ${JSON.stringify(d.extents)} not stretched by paper space`);
});

test('a layout: its paper space, and model space through its viewport, scaled and clipped', () => {
  const ents = [[0, 'SECTION'], [2, 'ENTITIES'],
    // model: a line 0..100 along x, and one far off to the right (outside the viewport's view)
    [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 100], [21, 0],
    [0, 'LINE'], [8, '0'], [10, 1000], [20, 0], [11, 1100], [21, 0],
    // an aligned text from (40, 10) along 20: through the 0.5 viewport, 10 wide (round 13)
    [0, 'TEXT'], [8, '0'], [10, 40], [20, 10], [11, 60], [21, 10], [40, 4], [72, 3], [1, 'FIT'],
    // paper: the sheet's own viewport (id 1, not drawn), a title frame, a viewport
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 148], [20, 105], [40, 297], [41, 210], [69, 1], [12, 148], [22, 105], [45, 210],
    [0, 'LWPOLYLINE'], [8, 'TITLE'], [67, 1], [90, 4], [70, 1], [10, 0], [20, 0], [10, 297], [20, 0], [10, 297], [20, 210], [10, 0], [20, 210],
    // centre (50, 40), 60 x 40 on paper; it shows model (50, 0), 80 high: scale 0.5
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 50], [22, 0], [45, 80],
    [0, 'ENDSEC'], [0, 'EOF']];
  const d = parseDXF(dxf(ents));
  assert.equal(d.paths.length, 2, 'model space: both lines');
  assert.equal(d.layouts.length, 1, 'one layout');
  const L = d.layouts[0];
  // the title frame, and the first line through the viewport (the far one
  // clipped away), besides the viewport's own frame
  const drawn = L.paths.filter((p) => !p.frame);
  assert.equal(drawn.length, 2, `paths ${drawn.map((p) => p.layer).join(',')}`);
  assert.equal(L.paths.filter((p) => p.frame).length, 1, 'one viewport frame (the sheet\'s id-1 viewport has none)');
  const line = drawn.find((p) => p.layer === '0');
  const xs = [line.pts[0], line.pts[2]].sort((a, b) => a - b);
  // model 0..100 at scale 0.5 about (50, 0) -> paper 25..75 at y 40; the
  // viewport spans x 20..80, so all of it shows
  assert.ok(Math.abs(xs[0] - 25) < 1e-9 && Math.abs(xs[1] - 75) < 1e-9, `x ${xs}`);
  assert.ok(Math.abs(line.pts[1] - 40) < 1e-9, `y ${line.pts[1]}`);
  assert.ok(L.extents.max[0] <= 297 + 1e-9, 'the sheet');
  // the aligned text's height and width both scaled (its width unscaled drew it twice too long)
  const ft = L.texts.find((t) => t.text === 'FIT');
  assert.deepEqual([ft.h, ft.fit], [2, 10]);
  // a layer only a layout uses (no LAYER table here) is in the drawing's list
  assert.ok(d.layers.some((l) => l.name === 'TITLE'), `layers ${d.layers.map((l) => l.name)}`);
});

test('a viewport clips what it shows to its frame', () => {
  const ents = [[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LINE'], [8, '0'], [10, -200], [20, 0], [11, 200], [21, 0],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40],
    [0, 'ENDSEC'], [0, 'EOF']];
  const L = parseDXF(dxf(ents)).layouts[0];
  const line = L.paths.find((p) => !p.frame);
  // scale 1 about (0, 0) -> paper x -150..250, whole, the frame as its clip outline: the view clips
  // it to the frame's 20..80, and the frame shows x 20..80 of it (since r103 a frame is an outline of
  // four points, clipped by the canvas as an outline is)
  const xs = [line.pts[0], line.pts[2]].sort((a, b) => a - b);
  assert.ok(Math.abs(xs[0] + 150) < 1e-9 && Math.abs(xs[1] - 250) < 1e-9, `x ${xs}`);
  assert.deepEqual(Array.from(line.clipPoly), [20, 20, 80, 20, 80, 60, 20, 60]);
  const shown = [];
  for (let x = -150; x <= 250; x += 0.5) if (inOutline(line.clipPoly, x, 40)) shown.push(x);
  assert.deepEqual([shown[0], shown[shown.length - 1]], [20, 80]);
});
test('a layer frozen in one viewport (341, by its handle) is not drawn through it, nor a reference on it; another viewport draws them (r98 Q2)', () => {
  // (must fire: every model layer was drawn through every viewport -- a kitchen's equipment tags
  // frozen on its electrical sheet, 123 paths)
  const d = parseDXF(dxf([[0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'],
    [0, 'LAYER'], [5, '8D'], [2, 'A'], [70, 0], [62, 1], [0, 'LAYER'], [5, '8E'], [2, 'B'], [70, 0], [62, 2], [0, 'ENDTAB'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [2, 'K'], [10, 0], [20, 0], [0, 'LINE'], [8, 'B'], [10, 0], [20, 5], [11, 1], [21, 5], [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LINE'], [8, 'A'], [10, -1], [20, 0], [11, 1], [21, 0],
    [0, 'INSERT'], [8, 'A'], [2, 'K'], [10, 0], [20, 0],
    [0, 'LINE'], [8, 'B'], [10, -1], [20, -5], [11, 1], [21, -5],
    // (one viewport freezing A, by its handle 8D; one beside it freezing nothing)
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [341, '8D'],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 150], [20, 40], [40, 60], [41, 40], [69, 3], [12, 0], [22, 0], [45, 40],
    [0, 'ENDSEC'], [0, 'EOF']]));
  const drawn = d.layouts[0].paths.filter((p) => !p.frame);
  const inFirst = drawn.filter((p) => p.pts[0] < 100), inSecond = drawn.filter((p) => p.pts[0] >= 100);
  assert.deepEqual(inFirst.map((p) => p.layer).sort(), ['B'], 'the first viewport: only the line on B not under A');
  assert.deepEqual(inSecond.map((p) => p.layer).sort(), ['A', 'B', 'B'], 'the second: all three');
  // (and the ATTRIB values after a reference on A, though on B: hidden with it -- its line was, its
  // value still drawn: r99 A1)
  const at = parseDXF(dxf([[0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'],
    [0, 'LAYER'], [5, '8D'], [2, 'A'], [70, 0], [62, 1], [0, 'LAYER'], [5, '8E'], [2, 'B'], [70, 0], [62, 2], [0, 'ENDTAB'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [2, 'K'], [10, 0], [20, 0], [0, 'LINE'], [8, 'B'], [10, 0], [20, 5], [11, 1], [21, 5], [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'INSERT'], [8, 'A'], [66, 1], [2, 'K'], [10, 0], [20, 0],
    [0, 'ATTRIB'], [8, 'B'], [10, 0], [20, 2], [40, 1], [1, 'TAG-VALUE'], [2, 'TAG'], [70, 0], [0, 'SEQEND'],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [341, '8D'],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 150], [20, 40], [40, 60], [41, 40], [69, 3], [12, 0], [22, 0], [45, 40],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0].texts;
  assert.deepEqual(at.map((t) => [t.text, t.x < 100 ? 'first' : 'second']), [['TAG-VALUE', 'second']]);
  // (and named by 331, as ODA and LibreDWG write an R2007+ drawing's: read by 341 alone, they were
  // drawn -- r100 Q2)
  const d331 = parseDXF(dxf([[0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'],
    [0, 'LAYER'], [5, '8D'], [2, 'A'], [70, 0], [62, 1], [0, 'ENDTAB'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, 'A'], [10, -1], [20, 0], [11, 1], [21, 0],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [331, '8D'],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0].paths.filter((p) => !p.frame);
  assert.deepEqual(d331, []);
});
test('a clip boundary that is not convex cuts fills and texts to itself, not its box (r99 Q2); a viewport turned off draws its frame alone (r99 Q3)', () => {
  // (must fire, Q2: by the L's box, a hatch and a TEXT in its notch were drawn where a line beside
  // them was not; model (x, y) is paper (x + 50, y + 40))
  const disc = (cx, cy, r) => [[0, 'HATCH'], [8, 'M'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 1], [72, 2], [10, cx], [20, cy], [40, r], [50, 0], [51, 360], [73, 1], [97, 0]];
  const square = [[0, 'HATCH'], [8, 'S'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 4],
    [72, 1], [10, -10], [20, -10], [11, 20], [21, -10], [72, 1], [10, 20], [20, -10], [11, 20], [21, 10],
    [72, 1], [10, 20], [20, 10], [11, -10], [21, 10], [72, 1], [10, -10], [20, 10], [11, -10], [21, -10], [97, 0]];
  const L = [[20, 20], [80, 20], [80, 40], [50, 40], [50, 60], [20, 60]];
  const d = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'],
    ...disc(15, 10, 3), ...square,
    [0, 'LINE'], [8, 'M'], [10, 5], [20, 10], [11, 25], [21, 10],
    [0, 'TEXT'], [8, 'M'], [10, 10], [20, 10], [40, 2], [1, 'IN-NOTCH'],
    [0, 'TEXT'], [8, 'M'], [10, -20], [20, -10], [40, 2], [1, 'IN-L'],
    [0, 'LWPOLYLINE'], [5, 'L1'], [8, 'B'], [67, 1], [90, 6], [70, 1], ...L.flatMap(([x, y]) => [[10, x], [20, y]]),
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 65536], [340, 'L1'],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0];
  // (since r103 a path seen through an outline is whole, with the outline, and the canvas clips it
  // there even-odd: every case of r99 to r102 is judged on what is shown -- what of a fill is inside
  // both it and the outline (a 0.05 grid), how much of a line the outline shows (inOutline, the
  // view's own test, as its snaps and hover ask it), what of a text's box is inside)
  const H = 0.05;
  const area = (ps) => {
    let n = 0;
    for (const p of ps) {
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      for (let k = 0; k < p.pts.length; k += 2) { b[0] = Math.min(b[0], p.pts[k]); b[2] = Math.max(b[2], p.pts[k]); b[1] = Math.min(b[1], p.pts[k + 1]); b[3] = Math.max(b[3], p.pts[k + 1]); }
      if (p.clip) { b[0] = Math.max(b[0], p.clip[0]); b[1] = Math.max(b[1], p.clip[1]); b[2] = Math.min(b[2], p.clip[2]); b[3] = Math.min(b[3], p.clip[3]); }
      for (let x = Math.floor(b[0] / H) * H + H / 2; x < b[2]; x += H) for (let y = Math.floor(b[1] / H) * H + H / 2; y < b[3]; y += H) {
        if (insideFlat(p.pts, x, y) && (!p.clipPoly || insideFlat(p.clipPoly, x, y))) n++;
      }
    }
    return n * H * H;
  };
  const near = (got, want) => Math.abs(got - want) <= 0.01 * want + 1;
  const shownLength = (ps) => ps.reduce((s, p) => {
    for (let k = 2; k < p.pts.length; k += 2) {
      const ax = p.pts[k - 2], ay = p.pts[k - 1], bx = p.pts[k], by = p.pts[k + 1], L = Math.hypot(bx - ax, by - ay), m = 1000;
      let shown = 0;
      for (let i = 0; i < m; i++) { const t = (i + 0.5) / m; if (!p.clipPoly || inOutline(p.clipPoly, ax + (bx - ax) * t, ay + (by - ay) * t)) shown++; }
      s += (L * shown) / m;
    }
    return s;
  }, 0);
  const textShown = (t) => {
    const c = textCorners(t);
    const x0 = Math.min(...c.map((q) => q[0])), x1 = Math.max(...c.map((q) => q[0])), y0 = Math.min(...c.map((q) => q[1])), y1 = Math.max(...c.map((q) => q[1]));
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 10; j++) { const x = x0 + ((x1 - x0) * i) / 40, y = y0 + ((y1 - y0) * j) / 10; if (!t.clipPoly || insideFlat(t.clipPoly, x, y)) return true; }
    return false;
  };
  const fills = d.paths.filter((p) => p.fill);
  assert.ok(near(area(fills.filter((p) => p.layer === 'M')), 0), `the disc in the notch shown: ${area(fills.filter((p) => p.layer === 'M'))}`);
  const sq = fills.filter((p) => p.layer === 'S');
  // (the square shows what of it the L holds, 400 -- written with its first point repeated at its end
  // too, r100 A1)
  assert.ok(near(area(sq), 400), `the square shows ${area(sq)}`);
  assert.ok(shownLength(d.paths.filter((p) => p.layer === 'M' && !p.fill)) < 1e-9, 'the line in the notch shown');
  // (r103 A3: and not kept at all -- what the outline shows nothing of is not drawn, counted or listed;
  // kept whole, the notch's line and disc counted as drawn and listed their layer)
  assert.deepEqual(d.paths.filter((p) => p.layer === 'M').length, 0, 'the notch\'s line and disc kept');
  assert.deepEqual(d.texts.map((t) => t.text), ['IN-L']);
  // (r103 A2: one box culls paths and texts, the outline's -- a viewport rectangle inside the L's box
  // culled the paths by itself, and a line beside its text was dropped)
  const small = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LINE'], [8, 'W'], [10, -25], [20, 12], [11, -15], [21, 12],
    [0, 'TEXT'], [8, 'W'], [10, -25], [20, 13], [40, 1], [1, 'ROOM'],
    [0, 'LWPOLYLINE'], [5, 'L1'], [8, 'B'], [67, 1], [90, 6], [70, 1], ...L.flatMap(([x, y]) => [[10, x], [20, y]]),
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 20], [41, 20], [69, 2], [12, 0], [22, 0], [45, 20], [90, 65536], [340, 'L1'],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0];
  assert.deepEqual([small.paths.some((p) => p.layer === 'W'), small.texts.some((t) => t.text === 'ROOM')], [true, true], 'the line and its text through a viewport smaller than its outline');
  // (r103 A1: a wall's snaps are the same through a frame and through an outline of the frame's own
  // four points -- one mechanism: a frame's lines were cut, and offered the cut's end)
  const wallVia = (clipped) => parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LINE'], [8, 'W'], [10, -20], [20, 10], [11, 20], [21, 10],
    ...(clipped ? [[0, 'LWPOLYLINE'], [5, 'F1'], [8, 'B'], [67, 1], [90, 4], [70, 1], [10, 20], [20, 20], [10, 50], [20, 20], [10, 50], [20, 60], [10, 20], [20, 60]] : []),
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 35], [20, 40], [40, 30], [41, 40], [69, 2], [12, -15], [22, 0], [45, 40], ...(clipped ? [[90, 65536], [340, 'F1']] : []),
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0].paths.filter((p) => p.layer === 'W');
  const snapsOf = (ps) => { const sp = snapPoints(ps, [0, 0]); const s = []; for (let i = 0; i < sp.n; i++) s.push(`${sp.kind[i]} ${sp.xy[2 * i].toFixed(6)}, ${sp.xy[2 * i + 1].toFixed(6)}`); return s.sort(); };
  assert.deepEqual(snapsOf(wallVia(false)), snapsOf(wallVia(true)), 'the wall\'s snaps through the frame and through the same outline');
  assert.deepEqual(d.texts.filter(textShown).map((t) => t.text), ['IN-L']);
  // (and the view clips each by the outline: every one seen through it carries it)
  const seenVia = d.paths.filter((p) => !p.frame && p.layer !== 'B');
  assert.ok(seenVia.length && seenVia.every((p) => p.clipPoly && p.clipPoly === seenVia[0].clipPoly && p.clipPoly.length >= 2 * L.length), 'a path through the L without its outline');
  const Lr = [...L, L[0]];
  const d2 = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], ...square,
    [0, 'LWPOLYLINE'], [5, 'L1'], [8, 'B'], [67, 1], [90, 7], [70, 1], ...Lr.flatMap(([x, y]) => [[10, x], [20, y]]),
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 65536], [340, 'L1'],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0];
  assert.ok(near(area(d2.paths.filter((p) => p.fill)), 400), `with its first point repeated: ${area(d2.paths.filter((p) => p.fill))}`);
  // (a text an outline's edge crosses with no vertex in its box is drawn, cut by the outline -- by
  // its vertices alone, it was dropped where the line beside it was kept: r100 A2; model (x, y) is
  // paper (x + 50, y + 40), and a thin strip runs through the text's box above its centre, missing
  // its corners and its centre)
  const strip = [[0, 40.8], [100, 40.8], [100, 41.2], [0, 41.2]];
  const d3 = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'TEXT'], [8, 'M'], [10, -2], [20, -1.5], [40, 3], [1, 'CROSSED'],
    [0, 'LWPOLYLINE'], [5, 'S1'], [8, 'B'], [67, 1], [90, 4], [70, 1], ...strip.flatMap(([x, y]) => [[10, x], [20, y]]),
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 65536], [340, 'S1'],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0];
  assert.deepEqual(d3.texts.filter(textShown).map((t) => t.text), ['CROSSED']);
  // (a fill with its corners in a U's two arms is cut by the U, 200 of its 500: kept whole by its
  // corners, it was drawn across the gap -- r100 Q1)
  const U = [[20, 20], [80, 20], [80, 60], [65, 60], [65, 35], [35, 35], [35, 60], [20, 60]];
  const bar = [[0, 'HATCH'], [8, 'S'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 4],
    [72, 1], [10, -25], [20, 5], [11, 25], [21, 5], [72, 1], [10, 25], [20, 5], [11, 25], [21, 15],
    [72, 1], [10, 25], [20, 15], [11, -25], [21, 15], [72, 1], [10, -25], [20, 15], [11, -25], [21, 5], [97, 0]];
  const d4 = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], ...bar,
    [0, 'LWPOLYLINE'], [5, 'U1'], [8, 'B'], [67, 1], [90, 8], [70, 1], ...U.flatMap(([x, y]) => [[10, x], [20, y]]),
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 65536], [340, 'U1'],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0];
  assert.ok(near(area(d4.paths.filter((p) => p.fill)), 200), `the bar across the U covers ${area(d4.paths.filter((p) => p.fill))}`);
  // (a fill entering an upside-down U's notch through one outline vertex and leaving by another is cut
  // by the line cut's own rule, 315 of its 690: the fill's own crossing test, strict at an edge's
  // ends, saw no crossing and drew it whole, 375 of it in the notch -- r101 A1)
  const Ud = [[20, 60], [80, 60], [80, 20], [65, 20], [65, 45], [35, 45], [35, 20], [20, 20]];
  const tri = [[29, 50], [65, 20], [75, 50]].map(([x, y]) => [x - 50, y - 40]);
  const triH = [[0, 'HATCH'], [8, 'S'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 3],
    ...tri.flatMap((p, i) => { const q = tri[(i + 1) % 3]; return [[72, 1], [10, p[0]], [20, p[1]], [11, q[0]], [21, q[1]]]; }), [97, 0]];
  const d5 = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], ...triH,
    [0, 'LWPOLYLINE'], [5, 'U2'], [8, 'B'], [67, 1], [90, 8], [70, 1], ...Ud.flatMap(([x, y]) => [[10, x], [20, y]]),
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 65536], [340, 'U2'],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0];
  assert.ok(near(area(d5.paths.filter((p) => p.fill)), 315), `the triangle into the notch covers ${area(d5.paths.filter((p) => p.fill))}`);
  // (a fill over the whole frame, through outlines that are not simple: an L with its inner corner
  // written twice keeps 1800 -- the doubled corner hid its turn and the L read as convex, 600: r101
  // Q1; a bowtie keeps 900 by the even-odd rule its lines are cut by -- its triangles covered its
  // box, 1800: r101 Q2; a star drawn in one stroke keeps its five points and not its middle)
  const cover = [[0, 'HATCH'], [8, 'S'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 4],
    [72, 1], [10, -30], [20, -20], [11, 30], [21, -20], [72, 1], [10, 30], [20, -20], [11, 30], [21, 20],
    [72, 1], [10, 30], [20, 20], [11, -30], [21, 20], [72, 1], [10, -30], [20, 20], [11, -30], [21, -20], [97, 0]];
  const through = (outline) => area(parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], ...cover,
    [0, 'LWPOLYLINE'], [5, 'O1'], [8, 'B'], [67, 1], [90, outline.length], [70, 1], ...outline.flatMap(([x, y]) => [[10, x], [20, y]]),
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 65536], [340, 'O1'],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0].paths.filter((p) => p.fill));
  const L2 = [[20, 20], [80, 20], [80, 40], [50, 40], [50, 40], [50, 60], [20, 60]];
  assert.ok(near(through(L2), 1800), `the L, its inner corner twice: ${through(L2)}`);
  const bow = [[25, 22], [75, 58], [75, 22], [25, 58]];
  assert.ok(near(through(bow), 900), `the bowtie: ${through(bow)}`);
  const star = [0, 2, 4, 1, 3].map((k) => [50 + 18 * Math.sin((2 * Math.PI * k) / 5), 40 + 18 * Math.cos((2 * Math.PI * k) / 5)]);
  const pent = [0, 1, 2, 3, 4].map((k) => [50 + 18 * Math.sin((2 * Math.PI * k) / 5), 40 + 18 * Math.cos((2 * Math.PI * k) / 5)]);
  // (its five points: the star, ten triangles from the middle, less the pentagon inside -- 251.32, a
  // grid count by insideFlat at 0.01 read 251.28; a piece's two edges meeting a hair crossed at a
  // band's end cut a point's half away, 232.12)
  const inner = 18 * Math.cos((2 * Math.PI) / 5) / Math.cos(Math.PI / 5);
  const pentArea = (r) => 2.5 * r * r * Math.sin((2 * Math.PI) / 5);
  const want = 5 * 18 * inner * Math.sin(Math.PI / 5) - pentArea(inner);
  assert.ok(near(through(star), want), `the star: ${through(star)}, want ${want}`);
  assert.ok(near(through(pent), pentArea(18)), `the pentagon: ${through(pent)}`);
  // (outlines not simple with no crossing: two rectangles meeting at a corner, drawn through it twice,
  // keep 500 -- triangles spanned the gap, 800; a square with a slit walked out and back keeps 1200
  // -- it read as convex and its fill was cut to nothing: r102 A2)
  const touch = [[30, 30], [50, 30], [50, 40], [70, 40], [70, 55], [50, 55], [50, 40], [30, 40]];
  assert.ok(near(through(touch), 500), `two rectangles at a corner: ${through(touch)}`);
  const slit = [[30, 25], [70, 25], [70, 55], [50, 55], [50, 40], [50, 55], [30, 55]];
  assert.ok(near(through(slit), 1200), `a square with a slit: ${through(slit)}`);
  // (r102 Q2: an outline of 2,403 points costs no pieces at all now -- the fill is one path; its
  // inside test is charged, points x the outline's points, r99 A4)
  const comb2 = (teeth) => { const top = []; for (let i = 0; i < teeth; i++) { const x = 20 + (60 * i) / teeth, w = 60 / teeth; top.push([x, 25 + i * 1e-4], [x + w / 4, 58 - i * 1e-4], [x + w / 2, 25.5 + i * 1e-4]); } return [[20, 22], [80, 22], [80, 25], ...top.reverse()]; };
  const viaOutline = (outline) => parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], ...cover,
    [0, 'LWPOLYLINE'], [5, 'O1'], [8, 'B'], [67, 1], [90, outline.length], [70, 1], ...outline.flatMap(([x, y]) => [[10, x], [20, y]]),
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 65536], [340, 'O1'],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0].paths.filter((p) => p.fill);
  assert.equal(viaOutline(comb2(800)).length, 1, 'the comb\'s fill cut into pieces');
  // (r102 Q3: a fill's snaps are its own points the outline shows -- the cut's pieces offered their
  // corners and middles, "middle (35, 40)" inside the L's fill on a seam never drawn; now there are
  // no seams, and a point the outline hides is not offered)
  const Lf = viaOutline(L2);
  const sp = snapPoints(Lf, [0, 0]);
  const snaps = [];
  for (let i = 0; i < sp.n; i++) snaps.push(`${sp.xy[2 * i]}, ${sp.xy[2 * i + 1]}`);
  // (the hatch is the frame, 20..80 x 20..60: its corners and middles but (80, 60), in the L's
  // notch -- (80, 40) and (50, 60) lie on the L's edges, which show them)
  assert.deepEqual([...new Set(snaps)].sort(), ['20, 20', '20, 40', '20, 60', '50, 20', '50, 60', '80, 20', '80, 40'].sort(), 'the snaps the L shows');
  // (r102 Q1: walls drawn on a clip outline's four edges, all kept, as a viewport's frame keeps them --
  // even-odd alone dropped the top and the right, BOTTOM 40, RIGHT 0, TOP 0, LEFT 30)
  const box = [[30, 25], [70, 25], [70, 55], [30, 55]];
  const wall = (x1, y1, x2, y2) => [[0, 'LINE'], [8, 'W'], [10, x1 - 50], [20, y1 - 40], [11, x2 - 50], [21, y2 - 40]];
  const walls = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], ...wall(30, 25, 70, 25), ...wall(70, 25, 70, 55), ...wall(70, 55, 30, 55), ...wall(30, 55, 30, 25),
    [0, 'LWPOLYLINE'], [5, 'O1'], [8, 'B'], [67, 1], [90, 4], [70, 1], ...box.flatMap(([x, y]) => [[10, x], [20, y]]),
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 65536], [340, 'O1'],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0].paths.filter((p) => p.layer === 'W');
  assert.ok(Math.abs(shownLength(walls) - 140) < 1e-9, `the walls on the outline show ${shownLength(walls)}`);
  // (r103 Q4: a boundary that gives no outline -- a REGION, which VPCLIP takes: nothing through it, no
  // frame, counted -- read as none, it drew the whole rectangle and a frame AutoCAD does not)
  const reg = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, 'M'], [10, -5], [20, 0], [11, 5], [21, 0],
    [0, 'REGION'], [5, 'G1'], [8, 'B'], [67, 1], [70, 1], [1, 'ACIS'],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 65536], [340, 'G1'],
    [0, 'ENDSEC'], [0, 'EOF']]));
  assert.deepEqual([reg.layouts[0].paths.filter((p) => p.layer !== 'B').length, reg.notDrawn['VIEWPORT (its clip boundary not read)']], [0, 1]);
  // (Q3: turned off, 90 bit 0x20000: its frame, nothing through it -- it drew model space)
  const off = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, 'M'], [10, -5], [20, 0], [11, 5], [21, 0],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 0x20000],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0].paths;
  assert.deepEqual(off.map((p) => !!p.frame), [true]);
});
test('a viewport\'s clip boundary found by handle, not by a scan of every record (r99 A3); a polygon clip charged points x vertices (r99 A4)', () => {
  // (must fire, A3: 16,000 viewports each scanning the sheet ran quadratic -- 20.5 s here, against
  // 0.6 s by the handle index; the bound leaves the index ten times its time)
  const vps = [];
  const n = 16000;
  for (let i = 0; i < n; i++) {
    vps.push([0, 'LWPOLYLINE'], [5, `B${i.toString(16)}`], [8, '0'], [67, 1], [90, 3], [70, 1], [10, i], [20, 0], [10, i + 1], [20, 0], [10, i + 0.5], [20, 1],
      [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, i + 0.5], [20, 0.5], [40, 1], [41, 1], [69, i + 2], [12, 0], [22, 0], [45, 1], [90, 65536], [340, `B${i.toString(16)}`]);
  }
  const t0 = performance.now();
  parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 0], ...vps, [0, 'ENDSEC'], [0, 'EOF']]));
  const ms = performance.now() - t0;
  assert.ok(ms < 6000, `${n} clipped viewports took ${ms.toFixed(0)} ms`);
  // (A4: a path of 5,000 points through a boundary of 4,000 vertices is 20 million clips, over
  // MAX_CLIPPED's 10 million though its points alone are not -- refused, not run)
  const big = Array.from({ length: 5000 }, (_, i) => [[10, Math.cos(i) * 0.4], [20, Math.sin(i) * 0.4]]).flat();
  const ring = Array.from({ length: 4000 }, (_, i) => [[10, 50 + 30 * Math.cos((2 * Math.PI * i) / 4000)], [20, 40 + 20 * Math.sin((2 * Math.PI * i) / 4000)]]).flat();
  assert.throws(() => parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LWPOLYLINE'], [8, 'M'], [90, 5000], [70, 0], ...big,
    [0, 'LWPOLYLINE'], [5, 'R1'], [8, 'B'], [67, 1], [90, 4000], [70, 1], ...ring,
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 65536], [340, 'R1'],
    [0, 'ENDSEC'], [0, 'EOF']])), /too large to draw here \(its viewports clip over 10 million points\)/);
});
test('a viewport whose clip boundary is a polygon (90 0x10000, 340) cuts what it shows to it, and draws no rectangle of its own (r98 Q3)', () => {
  // (must fire: clipped to its rectangle, a line came back x 20..80 where the triangle keeps 35..65,
  // and a frame AutoCAD does not draw was added)
  const d = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LINE'], [8, 'M'], [10, -200], [20, 0], [11, 200], [21, 0],
    [0, 'CIRCLE'], [8, 'M'], [10, 0], [20, -5], [40, 2],
    [0, 'LWPOLYLINE'], [5, 'C1'], [8, 'B'], [67, 1], [90, 3], [70, 1], [10, 20], [20, 20], [10, 80], [20, 20], [10, 50], [20, 60],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 65536], [340, 'C1'],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0];
  const line = d.paths.filter((p) => p.layer === 'M' && !p.closed);
  assert.equal(line.length, 1, JSON.stringify(d.paths.map((p) => [p.layer, p.closed, p.frame])));
  // (whole, with the triangle, which the view clips it to and asks the snaps of: the triangle shows
  // x 35..65 of it -- r103: shown by the outline, not cut)
  assert.ok(line[0].clipPoly, 'the line seen through the triangle without it');
  const xs = [];
  for (let x = -200; x <= 300; x += 0.5) if (inOutline(line[0].clipPoly, x, 40)) xs.push(x);
  assert.deepEqual([xs[0], xs[xs.length - 1]], [35, 65]);
  assert.equal(d.paths.filter((p) => p.frame).length, 0, 'a rectangle drawn');
  // (a circle inside the triangle: whole, closed, a circle)
  const circ = d.paths.filter((p) => p.layer === 'M' && p.closed);
  assert.ok(circ.length === 1 && circ[0].circle, JSON.stringify(circ.map((p) => [p.closed, !!p.circle])));
});
test('a circle seen whole through a viewport stays a closed circle; one the frame cuts is open runs, no circle (r97 Q1)', () => {
  // (must fire: cut into runs, the whole one came back open, with no centre and no Ø in 2D Measure)
  const ents = [[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'CIRCLE'], [8, '0'], [10, 0], [20, 0], [40, 5],
    [0, 'CIRCLE'], [8, '0'], [10, 25], [20, 0], [40, 10],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40],
    [0, 'ENDSEC'], [0, 'EOF']];
  // (since r103 judged by 2D Measure's snaps: both whole and closed, the frame clipping the second in
  // the view; the one it shows whole offers its centre and Ø, the one it cuts none)
  const centres = (ps) => { const sp = snapPoints(ps, [0, 0]); const c = []; for (let i = 0; i < sp.n; i++) if (sp.kind[i] === 2) c.push(sp.path[i]); return c; };
  const ps = parseDXF(dxf(ents)).layouts[0].paths.filter((p) => !p.frame);
  assert.ok(ps.length === 2 && ps.every((p) => p.closed && p.circle), JSON.stringify(ps.map((p) => [p.closed, !!p.circle, p.pts.length])));
  assert.deepEqual(centres(ps), [0], 'the centres offered');
  // (and a filled circle -- a solid hatch's -- the frame cuts offers none; one inside does: r98 Q4)
  const disc = (cx) => [[0, 'HATCH'], [8, '0'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 1], [72, 2], [10, cx], [20, 0], [40, 5], [50, 0], [51, 360], [73, 1], [97, 0]];
  const fl = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], ...disc(0), ...disc(28),
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0].paths.filter((p) => !p.frame && p.fill);
  assert.equal(fl.length, 2);
  assert.deepEqual(centres(fl), [0], JSON.stringify(fl.map((p) => [!!p.circle, p.pts.length])));
});

test('caret notation: "^C" is U+0003, "^ " a caret, and caret() writes them back', () => {
  const ents = [[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, 'a^Cb^ c'],
    [0, 'ENDSEC'], [0, 'EOF']];
  assert.equal(parseDXF(dxf(ents)).texts[0].text, 'a\x03b^c');
  assert.equal(uncaret('a^Cb^ c^J'), 'a\x03b^c\n');
  assert.equal(caret('a\x03b^c\n'), 'a^Cb^ c^J');
  assert.equal(uncaret(caret('^^\x00\x1f x')), '^^\x00\x1f x');
  // must fire: a caret before a character outside @.._ and space is kept as written
  assert.equal(uncaret('2^3'), '2^3');
  assert.notEqual(uncaret('a^Cb'), 'a^Cb');
});

// --- an untrusted drawing: bounded, and damaged values left out ---
const ents = (...e) => dxf([[0, 'SECTION'], [2, 'ENTITIES'], ...e.flat(), [0, 'ENDSEC'], [0, 'EOF']]);
const blocks = (...b) => [[0, 'SECTION'], [2, 'BLOCKS'], ...b.flat(), [0, 'ENDSEC']];
test('a 32767 × 32767 array of inserts is refused at once, not drawn until memory runs out', () => {
  const s = dxf([...blocks([[0, 'BLOCK'], [2, 'B'], [10, 0], [20, 0], [0, 'ENDBLK']]), [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'INSERT'], [8, '0'], [2, 'B'], [10, 0], [20, 0], [70, 32767], [71, 32767], [0, 'ENDSEC'], [0, 'EOF']]);
  const t0 = Date.now();
  assert.throws(() => parseDXF(s), /too large to draw here \(an array of 32767 × 32767/);
  assert.ok(Date.now() - t0 < 1000);
});
test('blocks nested to fan out stop at the drawing budget', () => {
  // each level inserts the one below 40 times: 40^5 = 1e8 lines
  const lv = (k) => [[0, 'BLOCK'], [2, `L${k}`], [10, 0], [20, 0], ...Array.from({ length: 40 }, (_, i) => (k === 0
    ? [[0, 'LINE'], [8, '0'], [10, i], [20, 0], [11, i], [21, 1]] : [[0, 'INSERT'], [8, '0'], [2, `L${k - 1}`], [10, i], [20, 0]])).flat(), [0, 'ENDBLK']];
  const s = dxf([...blocks(...[0, 1, 2, 3, 4].map(lv)), [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, '0'], [2, 'L4'], [10, 0], [20, 0], [0, 'ENDSEC'], [0, 'EOF']]);
  assert.throws(() => parseDXF(s), /too large to draw here/);
});
test('an arc of 1e12° is one turn at most (it asked for 2e11 points); 370° is 10°', () => {
  const d = parseDXF(ents([[0, 'ARC'], [8, '0'], [10, 0], [20, 0], [40, 1], [50, 0], [51, 1e12]]));
  assert.ok(d.paths[0].pts.length < 200, `${d.paths[0].pts.length}`);
  const q = parseDXF(ents([[0, 'ARC'], [8, '0'], [10, 0], [20, 0], [40, 1], [50, 0], [51, 370]])).paths[0].pts;
  // a 10° arc: it ends at (cos 10°, sin 10°)
  assert.ok(Math.abs(q[q.length - 2] - Math.cos(Math.PI / 18)) < 1e-9 && Math.abs(q[q.length - 1] - Math.sin(Math.PI / 18)) < 1e-9);
});
test('a clockwise hatch arc edge, 0° to 90° stored, is the quarter from 360° down to 270°', () => {
  // a loop of one clockwise arc edge (73 = 0), radius 1 about the origin
  const d = parseDXF(ents([[0, 'HATCH'], [8, '0'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 1], [72, 2], [10, 0], [20, 0], [40, 1], [50, 0], [51, 90], [73, 0]]));
  const p = d.paths[0].pts;
  // starts at angle 0 (1, 0), ends at 270° (0, -1), every point in the fourth quadrant
  assert.ok(Math.abs(p[0] - 1) < 1e-9 && Math.abs(p[1]) < 1e-9, `start ${p[0]},${p[1]}`);
  assert.ok(Math.abs(p[p.length - 2]) < 1e-9 && Math.abs(p[p.length - 1] + 1) < 1e-9, `end ${p[p.length - 2]},${p[p.length - 1]}`);
  for (let k = 0; k < p.length; k += 2) assert.ok(p[k] >= -1e-9 && p[k + 1] <= 1e-9, `point ${p[k]},${p[k + 1]}`);
});
test('a clockwise hatch ELLIPSE edge, 0° to 90° stored, is the quarter from 360° down to 270° (it drew the mirrored quarter)', () => {
  // major axis (2, 0), ratio 0.5: the ellipse x = 2 cos t, y = sin t
  const d = parseDXF(ents([[0, 'HATCH'], [8, '0'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 1], [72, 3], [10, 0], [20, 0], [11, 2], [21, 0], [40, 0.5], [50, 0], [51, 90], [73, 0]]));
  const p = d.paths[0].pts;
  assert.ok(Math.abs(p[0] - 2) < 1e-9 && Math.abs(p[1]) < 1e-9, `start ${p[0]},${p[1]}`);
  assert.ok(Math.abs(p[p.length - 2]) < 1e-9 && Math.abs(p[p.length - 1] + 1) < 1e-9, `end ${p[p.length - 2]},${p[p.length - 1]}`);
  for (let k = 0; k < p.length; k += 2) assert.ok(p[k] >= -1e-9 && p[k + 1] <= 1e-9, `point ${p[k]},${p[k + 1]}`);
  // and counter-clockwise (73 = 1) is the first quadrant, from (2, 0) to (0, 1)
  const c = parseDXF(ents([[0, 'HATCH'], [8, '0'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 1], [72, 3], [10, 0], [20, 0], [11, 2], [21, 0], [40, 0.5], [50, 0], [51, 90], [73, 1]])).paths[0].pts;
  assert.ok(Math.abs(c[c.length - 2]) < 1e-9 && Math.abs(c[c.length - 1] - 1) < 1e-9, `ccw end ${c[c.length - 2]},${c[c.length - 1]}`);
});
test('MTEXT\'s point and direction are WORLD coordinates (extrusion 0,0,-1 drew it mirrored); TEXT\'s are its own', () => {
  const mt = parseDXF(ents([[0, 'MTEXT'], [8, '0'], [10, 50], [20, 0], [40, 2], [210, 0], [220, 0], [230, -1], [1, 'A']])).texts[0];
  assert.deepEqual([mt.x, mt.y], [50, 0]);
  // (with no 11, its 50 is an angle in the OCS, as ezdxf maps it: OCS x runs along world -x here;
  // seen from -Z it is mirrored: read backward, as the TEXT below -- it was drawn turned 180°)
  assert.ok(mt.mirrorX && Math.abs(Math.sin(mt.rot)) < 1e-9 && Math.cos(mt.rot) > 0, `rot ${mt.rot}, mirrorX ${mt.mirrorX}`);
  // with a direction (1, 0): mirrored, upside down along +x (mirrorX with a half turn)
  const mh = parseDXF(ents([[0, 'MTEXT'], [8, '0'], [10, 50], [20, 0], [11, 1], [21, 0], [40, 2], [210, 0], [220, 0], [230, -1], [1, 'H']])).texts[0];
  assert.ok(mh.mirrorX && Math.abs(Math.cos(mh.rot) + 1) < 1e-9, `rot ${mh.rot}, mirrorX ${mh.mirrorX}`);
  const md = parseDXF(ents([[0, 'MTEXT'], [8, '0'], [10, 50], [20, 0], [11, 0], [21, 1], [40, 2], [210, 0], [220, 0], [230, -1], [1, 'B']])).texts[0];
  assert.ok(md.mirrorX && Math.abs(md.rot + Math.PI / 2) < 1e-9, `direction rot ${md.rot}`);
  // a TEXT with the same extrusion: its point is in the OCS, whose x runs along world -x
  const tx = parseDXF(ents([[0, 'TEXT'], [8, '0'], [10, 50], [20, 0], [40, 2], [210, 0], [220, 0], [230, -1], [1, 'C']])).texts[0];
  assert.deepEqual([tx.x, tx.y], [-50, 0]);
  assert.deepEqual([tx.mirrorX, Math.round(Math.cos(tx.rot))], [mt.mirrorX, Math.round(Math.cos(mt.rot))], 'the MTEXT and the TEXT alike');
});
test('a block inserted with a tilted extrusion: its contents\' z, its base\'s z and its z scale reach the view (r96 A1, Q1)', () => {
  // (must fire: the transform passed down was 2D, so every z inside was dropped -- a CIRCLE at
  // elevation 5 in a block inserted along +X drawn at x 0, not x 5)
  // (along +X the arbitrary-axis rule gives the insert's x axis world +Y, its y world +Z, its z +X:
  // from +Z a block's z is seen as world x)
  const boxes = (contents, insert = [], base = [0, 0, 0]) => {
    const d = parseDXF(dxf([...blocks([[0, 'BLOCK'], [2, 'B'], [10, base[0]], [20, base[1]], [30, base[2]], ...contents, [0, 'ENDBLK']]),
      [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, '0'], [2, 'B'], [10, 0], [20, 0], [30, 0], [210, 1], [220, 0], [230, 0], ...insert, [0, 'ENDSEC'], [0, 'EOF']]));
    return d.paths.map((p) => {
      const xs = [], ys = [];
      for (let k = 0; k < p.pts.length; k += 2) { xs.push(p.pts[k]); ys.push(p.pts[k + 1]); }
      return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map((v) => +v.toFixed(3) + 0);
    });
  };
  const items = [
    [0, 'CIRCLE'], [8, '0'], [10, 0], [20, 0], [30, 5], [40, 1],
    [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [30, 7], [11, 1], [21, 0], [31, 7],
    [0, 'LWPOLYLINE'], [8, '0'], [90, 2], [70, 0], [38, 4], [10, 0], [20, 0], [10, 1], [20, 1],
    // (an ELLIPSE at z 2, its major (4, 0, 0): seen at x 2, its major along world y)
    [0, 'ELLIPSE'], [8, '0'], [10, 0], [20, 0], [30, 2], [11, 4], [21, 0], [31, 0], [40, 0.5],
  ];
  assert.deepEqual(boxes(items), [[5, 5, -1, 1], [7, 7, 0, 1], [4, 4, 0, 1], [2, 2, -4, 4]]);
  // (its z scale, 43, and its base's z: z 5 scaled 2 from a base at z 1 is seen at x 8)
  assert.deepEqual(boxes([[0, 'CIRCLE'], [8, '0'], [10, 0], [20, 0], [30, 5], [40, 1]], [[43, 2]], [0, 0, 1]), [[8, 8, -1, 1]]);
});
test('a TEXT and an MTEXT in one tilted plane are one size, as the view sees that plane (r97 A3)', () => {
  // (must fire: tilted 45° about y, the TEXT read 7.071 high and the MTEXT 10 -- its sizes were taken
  // in world XY; along the plane's x (world +Y here) both keep their 10)
  const N = [[210, Math.SQRT1_2], [220, 0], [230, Math.SQRT1_2]];
  const t = parseDXF(ents(
    [[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 10], [1, 'T'], ...N],
    [[0, 'MTEXT'], [8, '0'], [10, 0], [20, 0], [40, 10], [11, 0], [21, 1], [31, 0], [1, 'M'], ...N],
  )).texts;
  const h = (x) => +x.h.toFixed(3);
  assert.deepEqual(t.map(h), [7.071, 7.071], JSON.stringify(t.map((x) => [x.text, x.h, x.widthFactor])));
  // (a baseline seen end-on, written two ways -- a TEXT at 50=90 and an MTEXT along world z, both
  // extruded along +X -- is one text, in a plane seen edge-on: neither drawn, nor one at 89.9° in it.
  // They read heights 0 and 2 -- r97 Q5 --, and as width 0 the view drew them whole -- r98 Q1; at
  // 89.9° it was not drawn and at 90° drawn whole)
  const eo = parseDXF(ents(
    [[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 2], [50, 90], [1, 'T'], [210, 1], [220, 0], [230, 0]],
    [[0, 'MTEXT'], [8, '0'], [10, 0], [20, 0], [40, 2], [11, 0], [21, 0], [31, 1], [1, 'M'], [210, 1], [220, 0], [230, 0]],
    [[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 2], [50, 89.9], [1, 'T'], [210, 1], [220, 0], [230, 0]],
  )).texts;
  assert.deepEqual(eo, []);
  // (a control: the same text at 90° in a plane tilted 45°, not edge-on, is drawn)
  const tilted = parseDXF(ents([[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 2], [50, 90], [1, 'T'], [210, Math.SQRT1_2], [220, 0], [230, Math.SQRT1_2]])).texts;
  assert.equal(tilted.length, 1);
  assert.ok(tilted[0].h > 0 && tilted[0].widthFactor !== 0, JSON.stringify(tilted[0]));
  // (a control: flat, both 10)
  const f = parseDXF(ents([[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 10], [1, 'T']], [[0, 'MTEXT'], [8, '0'], [10, 0], [20, 0], [40, 10], [11, 1], [21, 0], [1, 'M']])).texts;
  assert.deepEqual(f.map(h), [10, 10]);
});
test('a tilted extrusion: the elevation along it, and an ELLIPSE\'s minor axis by it, as seen from +Z (r95 Q1)', () => {
  // (each drawn as if it lay flat: a CIRCLE extruded along +X at elevation 5 at x 0, an ellipse seen
  // edge-on drawn whole -- must fire)
  const box = (e) => {
    const p = parseDXF(ents(e)).paths[0].pts;
    const xs = [], ys = [];
    for (let k = 0; k < p.length; k += 2) { xs.push(p[k]); ys.push(p[k + 1]); }
    return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map((v) => +v.toFixed(3) + 0);
  };
  const X = [[210, 1], [220, 0], [230, 0]];
  // a CIRCLE, centre OCS (2, 3, 5), r 1, along +X: world centre (5, 2, 3), from +Z the segment x 5
  assert.deepEqual(box([[0, 'CIRCLE'], [8, '0'], [10, 2], [20, 3], [30, 5], [40, 1], ...X]), [5, 5, 1, 3]);
  // one along (1, 0, 1), centre OCS (0, 0, 10): world (7.071, 0, 7.071)
  const d = box([[0, 'CIRCLE'], [8, '0'], [10, 0], [20, 0], [30, 10], [40, 1], [210, 1], [220, 0], [230, 1]]);
  assert.ok(Math.abs((d[0] + d[1]) / 2 - 7.071) < 1e-3 && Math.abs((d[2] + d[3]) / 2) < 1e-3, JSON.stringify(d));
  // a LWPOLYLINE at elevation 5 along +X: at x 5
  assert.deepEqual(box([[0, 'LWPOLYLINE'], [8, '0'], [90, 2], [70, 0], [38, 5], [10, 0], [20, 0], [10, 1], [20, 1], ...X]), [5, 5, 0, 1]);
  // an ELLIPSE, centre (3, 0, 0), major (0, 10, 0), ratio 0.5, along +X: the segment x 3, y -10..10
  assert.deepEqual(box([[0, 'ELLIPSE'], [8, '0'], [10, 3], [20, 0], [30, 0], [11, 0], [21, 10], [31, 0], [40, 0.5], ...X]), [3, 3, -10, 10]);
  // one with major (0, 0, 10) along +X: the segment y -5..5
  assert.deepEqual(box([[0, 'ELLIPSE'], [8, '0'], [10, 0], [20, 0], [30, 0], [11, 0], [21, 0], [31, 10], [40, 0.5], ...X]), [0, 0, -5, 5]);
  // (one rule for "drawn as a circle": a CIRCLE and an ELLIPSE of ratio 1 tilted 1e-4 rad alike --
  // the ellipse lost its centre the circle kept: r96 A2)
  const centres = (e) => parseDXF(ents(e)).paths.map((p) => !!p.circle);
  const tilt = [[210, 1e-4], [220, 0], [230, 1]];
  assert.deepEqual([...centres([[0, 'CIRCLE'], [8, '0'], [10, 0], [20, 0], [40, 5], ...tilt]), ...centres([[0, 'ELLIPSE'], [8, '0'], [10, 0], [20, 0], [11, 5], [21, 0], [40, 1], ...tilt])], [true, true]);
  // (a zero-length extrusion is +Z: it collapsed every point to (0, 0), a circle read Ø 0 -- r96 Q4)
  assert.deepEqual(box([[0, 'CIRCLE'], [8, '0'], [10, 2], [20, 3], [40, 1], [210, 0], [220, 0], [230, 0]]), [1, 3, 2, 4]);
  // (controls: flat, and seen from -Z, as before)
  assert.deepEqual(box([[0, 'ELLIPSE'], [8, '0'], [10, 0], [20, 0], [11, 10], [21, 0], [40, 0.5]]), [-10, 10, -5, 5]);
  assert.deepEqual(box([[0, 'CIRCLE'], [8, '0'], [10, 2], [20, 3], [30, 5], [40, 1], [210, 0], [220, 0], [230, -1]]), [-3, -1, 2, 4]);
});
test('an INSERT\'s ATTRIBs are drawn as text (a title block\'s values), an invisible one is not; 3DFACE draws its visible edges', () => {
  const d = parseDXF(ents(
    [[0, 'INSERT'], [8, '0'], [2, 'NOBLOCK'], [66, 1], [10, 0], [20, 0]],
    [[0, 'ATTRIB'], [8, '0'], [10, 5], [20, 6], [40, 2], [1, 'PN-12345'], [2, 'PARTNO'], [70, 0]],
    [[0, 'ATTRIB'], [8, '0'], [10, 5], [20, 9], [40, 2], [1, 'hidden'], [2, 'NOTE'], [70, 1]],
    [[0, 'SEQEND'], [8, '0']],
    [[0, '3DFACE'], [8, '0'], [10, 0], [20, 0], [30, 0], [11, 4], [21, 0], [31, 0], [12, 4], [22, 3], [32, 0], [13, 0], [23, 3], [33, 0], [70, 0]],
    [[0, '3DFACE'], [8, '0'], [10, 0], [20, 0], [30, 0], [11, 4], [21, 0], [31, 0], [12, 4], [22, 3], [32, 0], [13, 0], [23, 3], [33, 0], [70, 5]],
  ));
  assert.deepEqual(d.texts.map((t) => [t.text, t.x, t.y]), [['PN-12345', 5, 6]]);
  // the closed quad, then the second face's two visible edges (bits 1 and 4 hide edges 1 and 3)
  assert.equal(d.paths.length, 3);
  assert.deepEqual([...d.paths[0].pts], [0, 0, 4, 0, 4, 3, 0, 3]);
  assert.ok(d.paths[0].closed);
  assert.deepEqual(d.paths.slice(1).map((p) => [...p.pts]), [[4, 0, 4, 3], [0, 3, 0, 0]]);
});
test('an entity marked invisible (60 = 1) is not drawn, nor what belongs to it (a dynamic block\'s hidden states)', () => {
  const d = parseDXF(ents(
    [[0, 'LINE'], [8, '0'], [60, 1], [10, 0], [20, 0], [11, 1], [21, 1]],
    [[0, '3DFACE'], [8, '0'], [60, 1], [10, 0], [20, 0], [11, 4], [21, 0], [12, 4], [22, 3], [13, 0], [23, 3]],
    [[0, 'TEXT'], [8, '0'], [60, 1], [10, 0], [20, 0], [40, 1], [1, 'hidden']],
    [[0, 'POLYLINE'], [8, '0'], [60, 1], [66, 1], [70, 0]], [[0, 'VERTEX'], [8, '0'], [10, 0], [20, 0]], [[0, 'VERTEX'], [8, '0'], [10, 5], [20, 5]], [[0, 'SEQEND'], [8, '0']],
    [[0, 'INSERT'], [8, '0'], [60, 1], [2, 'NOBLOCK'], [66, 1], [10, 0], [20, 0]], [[0, 'ATTRIB'], [8, '0'], [10, 1], [20, 1], [40, 1], [1, 'att'], [2, 'T'], [70, 0]], [[0, 'SEQEND'], [8, '0']],
    [[0, 'LINE'], [8, '0'], [60, 0], [10, 0], [20, 0], [11, 2], [21, 0]],
  ));
  assert.equal(d.paths.length, 1, 'only the visible LINE');
  assert.deepEqual([...d.paths[0].pts], [0, 0, 2, 0]);
  assert.equal(d.texts.length, 0);
});
test('an invisible ATTRIB is left out alone: the visible ATTRIBs after it are drawn (a dynamic block\'s title block)', () => {
  const d = parseDXF(ents(
    [[0, 'INSERT'], [8, '0'], [2, 'NOBLOCK'], [66, 1], [10, 0], [20, 0]],
    [[0, 'ATTRIB'], [8, '0'], [60, 1], [10, 1], [20, 1], [40, 1], [1, 'state A'], [2, 'VIS'], [70, 0]],
    [[0, 'ATTRIB'], [8, '0'], [10, 1], [20, 2], [40, 1], [1, 'PN-1'], [2, 'PN'], [70, 0]],
    [[0, 'ATTRIB'], [8, '0'], [10, 1], [20, 3], [40, 1], [1, 'REV B'], [2, 'REV'], [70, 0]],
    [[0, 'SEQEND'], [8, '0']],
  ));
  assert.deepEqual(d.texts.map((t) => t.text), ['PN-1', 'REV B']);
});
test('TEXT, ATTRIB and MTEXT control codes: %%c %%d %%p %%u %%o %%k %%% %%nnn and \\U+nnnn', () => {
  assert.equal(textCodes('%%c10 %%d %%p0.1 %%uUnder%%u %%oOver%%o %%kX%%k 50%%% %%065 45\\U+00B0 \\U+2300'), 'Ø10 ° ±0.1 Under Over X 50% A 45° ⌀');
  const d = parseDXF(ents([[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, '%%UTITLE%%U 90\\U+00B0']],
    [[0, 'MTEXT'], [8, '0'], [10, 0], [20, 5], [40, 1], [1, '{\\fArial;45\\U+00B0}\\P%%c3']]));
  assert.deepEqual(d.texts.map((t) => t.text), ['TITLE 90°', '45°\nØ3']);
});
test('MTEXT escapes are read in one pass: an escaped backslash or brace is text, not the start of a code', () => {
  assert.equal(mtextPlain('C:\\\\Projects\\\\A1.dwg'), 'C:\\Projects\\A1.dwg');
  assert.equal(mtextPlain('C:\\\\Lib\\\\Std'), 'C:\\Lib\\Std');
  assert.equal(mtextPlain('\\{3\\} holes'), '{3} holes');
  assert.equal(mtextPlain('typed \\\\U+00B0'), 'typed \\U+00B0', 'an escaped backslash before U+ is not a Unicode escape');
  assert.equal(mtextPlain('45\\U+00B0 {\\fArial;x}\\Pnext'), '45° x\nnext');
});
test('round 11: \\M+ double-byte escapes, ^ stacks, %%nnn in the code page, a 999 comment first, a multi-line ATTRIB', () => {
  // \M+18277 is shift_jis 82 77 (a hiragana); the comparator and the page share the one rule
  assert.equal(textCodes('\\M+18277'), new TextDecoder('shift_jis').decode(Uint8Array.of(0x82, 0x77)));
  assert.equal(mtextPlain('{\\M+18277}x'), `${new TextDecoder('shift_jis').decode(Uint8Array.of(0x82, 0x77))}x`);
  assert.equal(dwgCompareUnescape, unescapeDxf, 'tests/dwg-compare.mjs uses the viewer\'s own unescapeDxf');
  // ^ stacks: a superscript, a subscript, a tolerance; / and # stay fractions
  assert.deepEqual(['6,5 m\\S2^;', '\\S^2;', '0,2\\S+0.1^-0;', '\\S1/2;', '\\S3#4;'].map((x) => mtextPlain(x)), ['6,5 m2', '2', '0,2 +0.1 -0', '1/2', '3/4']);
  // %%nnn above 127: the drawing's code page (1252 unless it says otherwise)
  assert.equal(textCodes('%%128'), '€');
  assert.equal(textCodes('%%065'), 'A');
  // a DXF that starts with a 999 comment (LibreDWG writes one): opened, and sniffed as a DXF
  const withComment = `999\nLibreDWG 0.13\n${dxf([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 1], [0, 'ENDSEC'], [0, 'EOF']])}`;
  assert.equal(parseDXF(withComment).paths.length, 1);
  assert.equal(sniffFormat(new TextEncoder().encode(withComment)).label, 'DXF');
  // an R2018 multi-line ATTRIB: its embedded MTEXT is the value, not group 1's first line
  const d = parseDXF(ents([[0, 'INSERT'], [8, '0'], [2, 'NOBLOCK'], [66, 1], [10, 0], [20, 0]],
    [[0, 'ATTRIB'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, 'LINE ONE'], [2, 'T'], [70, 0], [101, 'Embedded Object'], [10, 0], [20, 0], [40, 1], [1, 'LINE ONE\\PLINE TWO']],
    [[0, 'SEQEND'], [8, '0']]));
  assert.deepEqual(d.texts.map((t) => t.text), ['LINE ONE\nLINE TWO']);
});
test('round 12: text placement -- aligned / fit from the first point, vertical alignment, MTEXT attachment, a multi-line ATTRIB as its MTEXT', () => {
  const d = parseDXF(ents(
    // aligned (72=3): from (0,0) along to (10,0), fitted to 10
    [[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [11, 10], [21, 0], [40, 1], [72, 3], [1, 'ABCDE']],
    // fit (72=5) along a slope
    [[0, 'TEXT'], [8, '0'], [10, 0], [20, 5], [11, 3], [21, 9], [40, 1], [72, 5], [1, 'FIT']],
    // middle (73=2) and top (73=3), left, by the second point
    [[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [11, 7], [21, 8], [40, 1], [73, 2], [1, 'MID']],
    [[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 2], [40, 1], [72, 2], [73, 3], [1, 'TOPRIGHT']],
    // an MTEXT attached middle-centre (71=5: a dimension's value), and bottom-right (9)
    [[0, 'MTEXT'], [8, '0'], [10, 20], [20, 30], [40, 2], [71, 5], [1, 'dim']],
    [[0, 'MTEXT'], [8, '0'], [10, 20], [20, 30], [40, 2], [71, 9], [1, 'br']],
    // a multi-line ATTRIB: placed as its embedded MTEXT (point, height, attachment), not its own
    [[0, 'INSERT'], [8, '0'], [2, 'NOBLOCK'], [66, 1], [10, 0], [20, 0]],
    [[0, 'ATTRIB'], [8, '0'], [10, 100], [20, 100], [40, 9], [1, 'one'], [2, 'T'], [70, 0], [72, 1],
      [101, 'Embedded Object'], [10, 5], [20, 6], [40, 2], [71, 1], [72, 1], [1, 'one\\Ptwo']],
    [[0, 'SEQEND'], [8, '0']],
  ));
  const by = Object.fromEntries(d.texts.map((t) => [t.text, t]));
  assert.deepEqual([by.ABCDE.x, by.ABCDE.y, by.ABCDE.align, by.ABCDE.fit, by.ABCDE.fitMode], [0, 0, 'left', 10, 'aligned']);
  assert.deepEqual([by.FIT.x, by.FIT.y, by.FIT.fit, by.FIT.fitMode], [0, 5, 5, 'fit']);
  assert.ok(Math.abs(by.FIT.rot - Math.atan2(4, 3)) < 1e-12);
  assert.deepEqual([by.MID.x, by.MID.y, by.MID.valign, by.MID.align], [7, 8, 'middle', 'left']);
  assert.deepEqual([by.TOPRIGHT.x, by.TOPRIGHT.y, by.TOPRIGHT.valign, by.TOPRIGHT.align], [1, 2, 'top', 'right']);
  assert.deepEqual([by.dim.valign, by.dim.align, by.br.valign, by.br.align], ['middle', 'center', 'bottom', 'right']);
  const m = by['one\ntwo'];
  assert.deepEqual([m.x, m.y, m.h, m.mtext, m.align, m.valign], [5, 6, 2, true, 'left', 'top']);
});
test('code pages: the DWG numbers the drawings at hand show, 850 decoded, and a DWG writes its $DWGCODEPAGE for %%nnn', () => {
  assert.deepEqual([12, 28, 29, 30, 39].map((n) => DWG_CODEPAGES[n]), ['DOS850', 'ANSI_1250', 'ANSI_1251', 'ANSI_1252', 'ANSI_936']);
  assert.equal(decoderFor(codePageLabel('dos850')).decode(Uint8Array.of(0x48, 0x99)), 'HÖ');
  // (0x80 the first of 850's upper half: Ç, not the control U+0080 -- r112 M codepages-O2)
  assert.equal(decoderFor('ibm850').decode(Uint8Array.of(0x43, 0x80, 0x61)), 'CÇa');
  // (a segment touching a triangle only at its apex: no piece inside, the two edges' one crossing
  // not counted twice -- r112 M dxf-C194; through a square's side, the piece inside)
  assert.deepEqual(insidePieces([-1, 0, 1, 0, 0, 1], -1, 1, 1, 1), []);
  assert.deepEqual(insidePieces([0, 0, 2, 0, 2, 2, 0, 2], -1, 1, 3, 1), [0.25, 0.75]);
  assert.equal(codePageLabel('ANSI_1251'), 'windows-1251');
  // %%192 in a 1251 drawing is "А" (Cyrillic), in a 1252 one "À"
  const ru = parseDXF(dxf([[0, 'SECTION'], [2, 'HEADER'], [9, '$DWGCODEPAGE'], [3, 'ANSI_1251'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, '%%192'], [0, 'ENDSEC'], [0, 'EOF']]));
  assert.equal(ru.texts[0].text, 'А');
  assert.equal(textCodes('%%192'), 'À');
  // (r111 H2-M3: the whole table, the R2007 boundary, the double-byte pages -- each could be wrong
  // and every test passed. 38 is Japanese: 7 corpus DWGs carry it, read as GBK their text is wrong)
  assert.deepEqual(DWG_CODEPAGES, { 12: 'DOS850', 28: 'ANSI_1250', 29: 'ANSI_1251', 30: 'ANSI_1252', 32: 'ANSI_1253', 33: 'ANSI_1254',
    34: 'ANSI_1255', 35: 'ANSI_1256', 36: 'ANSI_1257', 37: 'ANSI_874', 38: 'ANSI_932', 39: 'ANSI_936', 40: 'ANSI_949', 41: 'ANSI_950' });
  const hd = (ver, cp) => [[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, ver], [9, '$DWGCODEPAGE'], [3, cp], [0, 'ENDSEC']];
  const one = (t) => [[0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, t], [0, 'ENDSEC'], [0, 'EOF']];
  // an R2007 file is UTF-8 whatever page it names; an R2004 one is read in its page
  assert.equal(parseDXF(new TextEncoder().encode(dxf([...hd('AC1021', 'ANSI_1252'), ...one('Ø20')])).buffer).texts[0].text, 'Ø20');
  assert.equal(parseDXF(Uint8Array.from([...dxf([...hd('AC1018', 'ANSI_1252'), ...one('\xd820')])].map((c) => c.charCodeAt(0))).buffer).texts[0].text, 'Ø20');
  // %%200 in a GBK drawing: one byte is no GBK character, read as 1252's
  const gb = parseDXF(dxf([...hd('AC1015', 'ANSI_936'), ...one('%%200')]));
  assert.equal(gb.texts[0].text, 'È');
  // (r112 b: 1252's 0x80..0x9F as the Encoding standard's index has them on every runtime -- Node 20's
  // TextDecoder read them as Latin-1, 0x80 "\u0080"; the cover for such a runtime asked of a Latin-1
  // decoder here, as Node 22 has none to cover)
  const HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
  const hi = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
  assert.equal(decoderFor('windows-1252').decode(hi), HIGH);
  const latin = { decode: (u8) => String.fromCharCode(...u8) };
  assert.equal(cp1252Over(latin).decode(Uint8Array.of(0x41, 0x80, 0x9f, 0xa0, 0xff)), 'A€Ÿ ÿ');
  assert.equal(parseDXF(Uint8Array.from([...dxf([...hd('AC1015', 'ANSI_1252'), ...one('\x80 \x99')])].map((c) => c.charCodeAt(0))).buffer).texts[0].text, '€ ™');
});
test('eight drawing rules no test held (r111 H2-M4): a full-turn ARC, a part ELLIPSE\'s side, TEXT Middle, MTEXT\'s rows, a turned MINSERT\'s rows, a mirrored dimension, a twisted viewport\'s texts, a BYBLOCK weight', () => {
  // an ARC 0..360 (some exporters' circle): a whole turn, not nothing
  const arc = parseDXF(ents([[0, 'ARC'], [8, '0'], [10, 0], [20, 0], [40, 5], [50, 0], [51, 360]])).paths[0].pts;
  const ax = arc.filter((_, i) => i % 2 === 0);
  assert.ok(Math.min(...ax) < -4.99 && Math.max(...ax) > 4.99, `x ${Math.min(...ax)} .. ${Math.max(...ax)}`);
  // an ELLIPSE's quarter from its major axis end: the minor is N x major, (0, 5) -- not (0, -5)
  const el = parseDXF(ents([[0, 'ELLIPSE'], [8, '0'], [10, 0], [20, 0], [30, 0], [11, 10], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, Math.PI / 2]])).paths[0].pts;
  assert.ok(Math.hypot(el[el.length - 2], el[el.length - 1] - 5) < 1e-9, `ends at ${el[el.length - 2]}, ${el[el.length - 1]}`);
  // TEXT 72 = 4 (Middle): centred both ways
  const mid = parseDXF(ents([[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [11, 5], [21, 5], [40, 1], [72, 4], [1, 'M']])).texts[0];
  assert.deepEqual([mid.align, mid.valign, mid.x, mid.y], ['center', 'middle', 5, 5]);
  // MTEXT 71 = 1..9: rows of three, top to bottom
  const va = [];
  for (let a = 1; a <= 9; a++) va.push(parseDXF(ents([[0, 'MTEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [71, a], [1, 'T']])).texts[0].valign);
  assert.deepEqual(va, ['top', 'top', 'top', 'middle', 'middle', 'middle', 'bottom', 'bottom', 'bottom']);
  // a MINSERT turned 90 degrees, two rows 10 apart: the rows go along the turned y, -x
  const blk = blocks([[0, 'BLOCK'], [2, 'B'], [10, 0], [20, 0], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 0], [0, 'ENDBLK']]);
  const mi = parseDXF(dxf([...blk, [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [100, 'AcDbMInsertBlock'], [8, '0'], [2, 'B'], [10, 0], [20, 0], [50, 90], [70, 1], [71, 2], [44, 0], [45, 10], [0, 'ENDSEC'], [0, 'EOF']]));
  const starts = mi.paths.map((p) => [+p.pts[0].toFixed(6) + 0, +p.pts[1].toFixed(6) + 0].join(',')).sort();
  assert.deepEqual(starts, ['-10,0', '0,0']);
  // a dimension written with extrusion 0,0,-1: its block is in world coordinates, not its OCS
  const dblk = blocks([[0, 'BLOCK'], [2, '*D1'], [10, 0], [20, 0], [0, 'LINE'], [8, '0'], [10, 5], [20, 0], [11, 6], [21, 0], [0, 'ENDBLK']]);
  const dm = parseDXF(dxf([...dblk, [0, 'SECTION'], [2, 'ENTITIES'], [0, 'DIMENSION'], [8, '0'], [2, '*D1'], [10, 0], [20, 0], [70, 0], [210, 0], [220, 0], [230, -1], [0, 'ENDSEC'], [0, 'EOF']]));
  const dx = dm.paths.flatMap((p) => [p.pts[0], p.pts[2]]).sort((a, b) => a - b);
  assert.deepEqual(dx, [5, 6]);
  // a text seen through a viewport twisted 30 degrees turns with it
  const vp = (tw) => parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 2], [1, 'TW'],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [51, tw], [0, 'ENDSEC'], [0, 'EOF']])).layouts[0].texts.find((t) => t.text === 'TW').rot;
  const turned = vp(30) - vp(0);
  assert.ok(Math.abs(turned - Math.PI / 6) < 1e-9 || Math.abs(turned - 30) < 1e-9, `turned by ${turned}`);
  // a BYBLOCK weight (370 = -2) inside a block inserted at 0.50 mm: 0.5
  const wb = blocks([[0, 'BLOCK'], [2, 'W'], [10, 0], [20, 0], [0, 'LINE'], [8, '0'], [370, -2], [10, 0], [20, 0], [11, 1], [21, 0], [0, 'ENDBLK']]);
  const wd = parseDXF(dxf([...wb, [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, '0'], [2, 'W'], [10, 0], [20, 0], [370, 50], [0, 'ENDSEC'], [0, 'EOF']]));
  assert.equal(wd.paths[0].weight, 0.5);
});
test('round 13: a binary R2000 DXF in its code page, a header behind a long comment, text extents', () => {
  // binary R2000, 1252: its strings in the drawing's code page, not UTF-8
  const G = [[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [9, '$DWGCODEPAGE'], [3, 'ANSI_1252'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, 'Ø20 ±0.1'], [0, 'ENDSEC'], [0, 'EOF']];
  const parts = binaryDXF(G.map(([c, v]) => [c, v]));
  // (the writer encodes strings as UTF-8: re-encode the TEXT's value as 1252 bytes in place)
  const u8 = new Uint8Array(parts);
  const at = Buffer.from(u8).indexOf(Buffer.from('Ø20 ±0.1', 'utf8'));
  const latin = Buffer.from('Ø20 ±0.1', 'latin1');
  const fixed = Buffer.concat([Buffer.from(u8.subarray(0, at)), latin, Buffer.from(u8.subarray(at + Buffer.byteLength('Ø20 ±0.1', 'utf8')))]);
  assert.equal(parseDXF(fixed.buffer.slice(fixed.byteOffset, fixed.byteOffset + fixed.length)).texts[0].text, 'Ø20 ±0.1');
  // an ASCII DXF whose header (1251) follows a 9000-byte comment: its text read in 1251
  const body = dxf([[0, 'SECTION'], [2, 'HEADER'], [9, '$DWGCODEPAGE'], [3, 'ANSI_1251'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, 'X'], [0, 'ENDSEC'], [0, 'EOF']]);
  const head = `999\n${'c'.repeat(9000)}\n`;
  // (the text's value as 1251 bytes: "При")
  const [before, after] = body.split('\nX\n');
  const bytes = Buffer.concat([Buffer.from(head + before + '\n', 'latin1'), Buffer.from([0xcf, 0xf0, 0xe8]), Buffer.from(`\n${after}`, 'latin1')]);
  assert.equal(parseDXF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)).texts[0].text, 'При');
  // text extents: a right-aligned text extends left of its point, a 20-line MTEXT below its point
  const right = parseDXF(ents([[0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 100], [21, 0]],
    [[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [11, 100], [21, 0], [40, 2], [72, 2], [1, 'NOTE']]));
  assert.ok(right.extents.max[0] <= 100 + 1e-9, `right-aligned text ends at its point: ${right.extents.max[0]}`);
  const tall = parseDXF(ents([[0, 'MTEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [71, 1], [1, Array(20).fill('l').join('\\P')]]));
  assert.ok(tall.extents.min[1] < -26 && tall.extents.max[1] <= 1e-9, `the block hangs below: ${tall.extents.min[1]}..${tall.extents.max[1]}`);
});
test('round 13 (quality): an R2018 MTEXT\'s own groups end at its 101; a TEXT\'s 71 (backward / upside down) and 41 (width) are read', () => {
  const d = parseDXF(ents(
    // an MTEXT whose embedded object's 11 is a point, not its direction
    [[0, 'MTEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [71, 1], [1, 'BB707'], [11, 1], [21, 0], [101, 'Embedded Object'], [70, 1], [10, 1], [20, 0], [11, 120.5], [21, 415.9]],
    [[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [71, 2], [1, 'BACK']],
    [[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [71, 6], [1, 'BOTH']],
    [[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [41, 0.7], [1, 'NARROW']],
  ));
  const by = Object.fromEntries(d.texts.map((t) => [t.text, t]));
  assert.ok(Math.abs(by.BB707.rot) < 1e-12, `MTEXT direction from its own 11: rot ${by.BB707.rot}`);
  assert.deepEqual([!!by.BACK.mirrorX, !!by.BACK.mirrorY, !!by.BOTH.mirrorX, !!by.BOTH.mirrorY], [true, false, true, true]);
  assert.equal(by.NARROW.widthFactor, 0.7);
  // a backward text stands left of its point (the extents follow it)
  const back = parseDXF(ents([[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [71, 2], [1, 'BACK']]));
  assert.ok(back.extents.max[0] <= 1e-9 && back.extents.min[0] < -1, `backward: ${back.extents.min[0]}..${back.extents.max[0]}`);
});
test('round 14: text in a mirrored / stretched block, a text-only layer, one code page choice, an anchored header search, 300k lines, an ATTRIB\'s own 71', () => {
  const blk = [[0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [8, '0'], [2, 'B'], [70, 0], [10, 0], [20, 0],
    [0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, 'T'], [0, 'ENDBLK'], [0, 'ENDSEC']];
  const withInsert = (ins) => parseDXF(dxf([...blk, [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, '0'], [2, 'B'], [10, 0], [20, 0], ...ins, [0, 'ENDSEC'], [0, 'EOF']]));
  // mirrored in x: backward, along -x (rot pi - pi = 0 with the mirror), upright
  const mx = withInsert([[41, -1]]).texts[0];
  assert.ok(mx.mirrorX && Math.abs(Math.cos(mx.rot) - 1) < 1e-9, `x-mirrored: rot ${mx.rot}, mirrorX ${mx.mirrorX}`);
  // mirrored in y: mirrored (with a half turn: upside down)
  const my = withInsert([[42, -1]]).texts[0];
  assert.ok(my.mirrorX && Math.abs(Math.cos(my.rot) + 1) < 1e-9, `y-mirrored: rot ${my.rot}`);
  // stretched 2 in x: twice as wide
  assert.equal(withInsert([[41, 2]]).texts[0].widthFactor, 2);
  // a layer only a text uses is a layer
  const tl = parseDXF(ents([[0, 'TEXT'], [8, 'NOTES'], [10, 0], [20, 0], [40, 1], [1, 'n']]));
  assert.ok(tl.layers.some((l) => l.name === 'NOTES'));
  // no code page named: ASCII and binary choose alike (UTF-8 when it is, else 1252)
  const G = [[0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, 'Ø20 ±0.1'], [0, 'ENDSEC'], [0, 'EOF']];
  const ascii = new TextEncoder().encode(dxf(G));
  assert.equal(parseDXF(ascii.buffer).texts[0].text, 'Ø20 ±0.1');
  assert.equal(parseDXF(binaryDXF(G)).texts[0].text, 'Ø20 ±0.1');
  // a comment naming $DWGCODEPAGE before the header: the header's own value is read (1251)
  const H = `999\nsee $DWGCODEPAGE\n${dxf([[0, 'SECTION'], [2, 'HEADER'], [9, '$DWGCODEPAGE'], [3, 'ANSI_1251'], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, 'X'], [0, 'ENDSEC'], [0, 'EOF']])}`;
  const [pre, post] = H.split('\nX\n');
  const bytes = Buffer.concat([Buffer.from(`${pre}\n`, 'latin1'), Buffer.from([0xcf, 0xf0, 0xe8]), Buffer.from(`\n${post}`, 'latin1')]);
  assert.equal(parseDXF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)).texts[0].text, 'При');
  // 300k lines of MTEXT: boxed without a stack overflow
  assert.ok(textCorners({ x: 0, y: 0, h: 1, rot: 0, text: '\n'.repeat(300000), align: 'left', valign: 'top', mtext: true }).length === 4);
  // an R2018 ATTRIB's AcDbAttribute 71 (its type) is not its generation
  const at = parseDXF(ents([[0, 'INSERT'], [8, '0'], [2, 'NOBLOCK'], [66, 1], [10, 0], [20, 0]],
    [[0, 'ATTRIB'], [100, 'AcDbText'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, 'V'], [100, 'AcDbAttribute'], [2, 'T'], [70, 0], [71, 1], [72, 0]],
    [[0, 'SEQEND'], [8, '0']])).texts[0];
  assert.ok(!at.mirrorX && !at.mirrorY, 'type 1 is not "backward"');
});
test('round 14 (quality): oblique, polyline widths, LEADER drawn and the rest counted, MTEXT wrap', () => {
  const d = parseDXF(ents(
    [[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [51, 12], [1, 'SLANT']],
    [[0, 'LWPOLYLINE'], [8, '0'], [90, 2], [70, 0], [43, 2.5], [10, 0], [20, 0], [10, 10], [20, 0]],
    [[0, 'LWPOLYLINE'], [8, '0'], [90, 2], [70, 0], [10, 0], [20, 5], [40, 1], [41, 3], [10, 10], [20, 5]],
    [[0, 'POLYLINE'], [8, '0'], [66, 1], [70, 0], [40, 4], [41, 4]], [[0, 'VERTEX'], [8, '0'], [10, 0], [20, 9]], [[0, 'VERTEX'], [8, '0'], [10, 9], [20, 9]], [[0, 'SEQEND'], [8, '0']],
    [[0, 'LEADER'], [8, '0'], [76, 3], [10, 0], [20, 20], [10, 5], [20, 25], [10, 9], [20, 25]],
    [[0, 'WIPEOUT'], [8, '0']], [[0, 'MLINE'], [8, '0']], [[0, 'MLINE'], [8, '0']],
    [[0, 'MTEXT'], [8, '0'], [10, 0], [20, 40], [40, 1], [41, 20], [71, 1], [1, 'word '.repeat(12).trim()]],
  ));
  const slant = d.texts.find((t) => t.text === 'SLANT');
  assert.ok(Math.abs(slant.oblique - (12 * Math.PI) / 180) < 1e-12);
  // one width: stroked at it; a taper (1 to 3, then 0): its line and its outline from 1 to 3 wide
  assert.deepEqual(d.paths.filter((p) => !p.fill).slice(0, 3).map((p) => p.width), [2.5, undefined, 4]);
  const taper = d.paths.find((p) => p.fill);
  assert.deepEqual([...taper.pts], [0, 5.5, 10, 6.5, 10, 3.5, 0, 4.5], 'half of 1 at its start, half of 3 at its end');
  assert.deepEqual([...d.paths.find((p) => p.pts[1] === 20).pts], [0, 20, 5, 25, 9, 25], 'the LEADER as its vertices');
  assert.deepEqual(d.notDrawn, { WIPEOUT: 1, MLINE: 2 });
  // the MTEXT wraps at 20 units (12 words of 4, ~0.6 a character): more than one line in the extents
  const m = d.texts.find((t) => t.mtext);
  assert.equal(m.wrap, 20);
  const c = textCorners(m);
  assert.ok(Math.max(...c.map((q) => q[0])) <= 20 + 1e-9, 'within its width');
  assert.ok(Math.min(...c.map((q) => q[1])) < 40 - 2, 'more than one line');
  assert.deepEqual(wrapLines(['aa bb cc'], (l) => l.length, 5), ['aa bb', 'cc']);
});
test('a text seen through a layout viewport is kept when its box meets the frame, clipped to it', () => {
  const G = [[0, 'SECTION'], [2, 'ENTITIES'],
    // model: a long text from the view's centre, and one starting just left of the view
    [0, 'TEXT'], [8, '0'], [10, 50], [20, 0], [40, 2], [1, 'L'.repeat(50)],
    [0, 'TEXT'], [8, '0'], [10, -1], [20, 0], [40, 2], [1, 'ACROSS'],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 148], [20, 105], [40, 297], [41, 210], [69, 1], [12, 148], [22, 105], [45, 210],
    // a viewport 10 x 10 on paper at (5, 5) showing model (50, 0), 10 high: scale 1, model x 45..55
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 5], [20, 5], [40, 10], [41, 10], [69, 2], [12, 50], [22, 0], [45, 10],
    [0, 'ENDSEC'], [0, 'EOF']];
  const L = parseDXF(dxf(G)).layouts[0];
  const long = L.texts.find((t) => t.text.startsWith('LLL'));
  assert.ok(long && long.clip, 'the long text kept, clipped to the frame');
  assert.deepEqual(long.clip, [0, 0, 10, 10]);
  assert.ok(!L.texts.some((t) => t.text === 'ACROSS'), 'a text wholly outside is left out');
  // the layout's extents count only what is drawn of a clipped text (its whole box made them 65 wide)
  assert.deepEqual([L.extents.min[0], L.extents.max[0]], [0, 10], `extents ${JSON.stringify(L.extents)}`);
});
test('round 15: a block stretch taken along the text; a viewport scales width and wrap; clipped extents; tables and arc dimensions drawn', () => {
  const blk = (ent) => [[0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [8, '0'], [2, 'B'], [70, 0], [10, 0], [20, 0], ...ent, [0, 'ENDBLK'], [0, 'ENDSEC']];
  const ins = (ent, g) => parseDXF(dxf([...blk(ent), [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, '0'], [2, 'B'], [10, 0], [20, 0], ...g, [0, 'ENDSEC'], [0, 'EOF']]));
  // a TEXT turned 90° in a block stretched 2 in x: twice as TALL (its height lies along x), not wider
  const t = ins([[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [50, 90], [1, 'T']], [[41, 2]]).texts[0];
  assert.ok(Math.abs(t.h - 2) < 1e-9 && Math.abs(t.widthFactor - 0.5) < 1e-9, `h ${t.h}, widthFactor ${t.widthFactor}`);
  // an MTEXT turned 90° likewise; its wrap width lies along y, unstretched
  const m = ins([[0, 'MTEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [41, 10], [11, 0], [21, 1], [1, 'M']], [[41, 2]]).texts[0];
  assert.ok(Math.abs(m.h - 2) < 1e-9 && Math.abs(m.wrap - 10) < 1e-9, `h ${m.h}, wrap ${m.wrap}`);
  // a uniform scale: no width factor
  assert.equal(ins([[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [50, 30], [1, 'T']], [[41, 3], [42, 3]]).texts[0].widthFactor, undefined);
  // through a 0.1 viewport: a polyline's width and an MTEXT's wrap scaled with it
  const V = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LWPOLYLINE'], [8, '0'], [90, 2], [70, 0], [43, 5], [10, 0], [20, 0], [10, 10], [20, 0],
    [0, 'MTEXT'], [8, '0'], [10, 0], [20, 20], [40, 5], [41, 40], [71, 1], [1, 'w'],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 148], [20, 105], [40, 297], [41, 210], [69, 1], [12, 148], [22, 105], [45, 210],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 50], [40, 100], [41, 100], [69, 2], [12, 0], [22, 0], [45, 1000],
    [0, 'ENDSEC'], [0, 'EOF']])).layouts[0];
  assert.ok(Math.abs(V.paths.find((p) => p.width).width - 0.5) < 1e-9, 'the width scaled');
  assert.ok(Math.abs(V.texts[0].wrap - 4) < 1e-9 && Math.abs(V.texts[0].h - 0.5) < 1e-9, `wrap ${V.texts[0].wrap}`);
  // a table: its *T block inserted at its point (its AcDbTable 41 / 70 / 71 are not a scale or an array)
  const T = parseDXF(dxf([[0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [8, '0'], [2, '*T1'], [70, 1], [10, 0], [20, 0],
    [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 0], [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'ACAD_TABLE'], [8, '0'], [100, 'AcDbBlockReference'], [2, '*T1'], [10, 5], [20, 5],
    [100, 'AcDbTable'], [41, 9], [70, 4], [71, 4], [91, 2], [92, 2], [0, 'ARC_DIMENSION'], [8, '0'], [2, '*T1'], [0, 'ENDSEC'], [0, 'EOF']]));
  assert.equal(T.paths.length, 2, 'the table and the arc dimension each draw their block');
  assert.deepEqual([...T.paths[0].pts], [5, 5, 6, 5]);
  assert.deepEqual(T.notDrawn, {});
});
test('round 16: one width through a stretch; outlines apart; hatch islands even-odd; a missing block counted; wrap tokens', () => {
  const blk = (ent) => [[0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [8, '0'], [2, 'B'], [70, 0], [10, 0], [20, 0], ...ent, [0, 'ENDBLK'], [0, 'ENDSEC']];
  const ins = (ent, g) => parseDXF(dxf([...blk(ent), [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, '0'], [2, 'B'], [10, 0], [20, 0], ...g, [0, 'ENDSEC'], [0, 'EOF']]));
  // a vertical polyline 2 wide in a block stretched 4 x 1: 8 wide across (in x), as a taper is
  const vert = (w0, w1) => [[0, 'LWPOLYLINE'], [8, '0'], [90, 2], [70, 0], [10, 0], [20, 0], [40, w0], [41, w1], [10, 0], [20, 10], [40, w0], [41, w1]];
  const span = (d) => { const o = d.paths.find((p) => p.outline); const xs = [...o.pts].filter((_, k) => k % 2 === 0); return Math.max(...xs) - Math.min(...xs); };
  assert.ok(Math.abs(span(ins(vert(2, 2), [[41, 4]])) - 8) < 1e-9, 'one width');
  assert.ok(Math.abs(span(ins(vert(2, 2.0001), [[41, 4]])) - 8.0004) < 1e-6, 'a taper');
  // a uniform scale keeps one width a stroke, scaled
  const u = ins(vert(2, 2), [[41, 3], [42, 3]]);
  assert.ok(!u.paths.some((p) => p.outline) && Math.abs(u.paths[0].width - 6) < 1e-9);
  // a solid hatch with an island: its loops share one even-odd id; one loop: none
  const H = (loops) => [[0, 'HATCH'], [8, '0'], [2, 'SOLID'], [70, 1], [75, 0], [91, loops.length], ...loops.flatMap((L) => [[92, 2], [72, 0], [73, 1], [93, L.length / 2], ...L.flatMap((v, k) => [[k % 2 ? 20 : 10, v]])])];
  const sq = (a, b) => [a, a, b, a, b, b, a, b];
  const h = parseDXF(ents(H([sq(0, 10), sq(3, 7)])));
  assert.equal(h.paths.length, 2);
  assert.ok(h.paths[0].evenodd && h.paths[0].evenodd === h.paths[1].evenodd);
  assert.ok(!parseDXF(ents(H([sq(0, 10)]))).paths[0].evenodd);
  // an INSERT of a block not in the file is counted, as a table's is
  assert.deepEqual(parseDXF(ents([[0, 'INSERT'], [8, '0'], [2, 'GONE'], [10, 0], [20, 0]])).notDrawn, { INSERT: 1 });
  // a custom kind is counted by its name
  assert.deepEqual(parseDXF(ents([[0, 'AEC_WALL'], [8, '0']])).notDrawn, { AEC_WALL: 1 });
  // the ideographic space is a space; a closing mark stays with the character before it
  assert.deepEqual(wrapLines(['平面図　配置図'], (l) => l.length, 3), ['平面図', '配置図']);
  assert.deepEqual(wrapLines(['あいう。えお'], (l) => l.length, 3), ['あい', 'う。え', 'お']);
  // a non-breaking space does not break
  assert.deepEqual(wrapLines(['Ø 12 x'], (l) => l.length, 4), ['Ø 12', 'x']);
});
test('round 17: a mesh polyline counted; a hatch\'s even-odd id unique across sheets and viewports', () => {
  const pm = parseDXF(ents([[0, 'POLYLINE'], [8, '0'], [66, 1], [70, 64]], [[0, 'VERTEX'], [8, '0'], [10, 0], [20, 0], [70, 192]], [[0, 'SEQEND'], [8, '0']],
    [[0, 'POLYLINE'], [8, '0'], [66, 1], [70, 16]], [[0, 'SEQEND'], [8, '0']]));
  assert.deepEqual(pm.notDrawn, { 'POLYLINE (polyface)': 1, 'POLYLINE (3D mesh)': 1 });
  const sq = (a, b) => [a, a, b, a, b, b, a, b];
  const H = (loops, paper) => [[0, 'HATCH'], [8, '0'], ...(paper ? [[67, 1]] : []), [2, 'SOLID'], [70, 1], [75, 0], [91, loops.length], ...loops.flatMap((L) => [[92, 2], [72, 0], [73, 1], [93, L.length / 2], ...L.flatMap((v, k) => [[k % 2 ? 20 : 10, v]])])];
  const d = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], ...H([sq(0, 10), sq(3, 7)]), ...H([sq(0, 10), sq(3, 7)], true),
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 148], [20, 105], [40, 297], [41, 210], [69, 1], [12, 148], [22, 105], [45, 210],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 5], [20, 5], [40, 10], [41, 10], [69, 2], [12, 5], [22, 5], [45, 10],
    [0, 'ENDSEC'], [0, 'EOF']]));
  const model = new Set(d.paths.map((p) => p.evenodd)), sheet = new Set(d.layouts[0].paths.filter((p) => p.evenodd).map((p) => p.evenodd));
  assert.equal(model.size, 1);
  assert.equal(sheet.size, 2, 'the sheet\'s own hatch and the model\'s seen through the viewport: two ids');
  assert.ok(![...sheet].some((x) => model.has(x)), 'none shared with model space');
  // two SOLIDs wound opposite ways: the clockwise one is added reversed, so their overlap fills
  const so = parseDXF(ents([[0, 'SOLID'], [8, '0'], [10, 0], [20, 0], [11, 4], [21, 0], [12, 0], [22, 4], [13, 4], [23, 4]],
    [[0, 'SOLID'], [8, '0'], [10, 2], [20, 2], [11, 2], [21, 6], [12, 6], [22, 2], [13, 6], [23, 6]])).paths;
  assert.deepEqual(so.map(addedReversed), [false, true]);
  assert.equal(addedReversed({ fill: true, evenodd: 1, pts: so[1].pts }), false, 'a hatch\'s even-odd loops keep their winding');
  // an opening mark goes with the character after it; an ideograph past the BMP breaks, as one
  assert.ok(!wrapLines(['あい「うえ」お'], (l) => [...l].length, 3).some((x) => x.endsWith('「')), 'no line ends in an opening mark');
  assert.deepEqual(wrapLines(['\u{20000}\u{20001}\u{20002}\u{20003}'], (l) => [...l].length, 2), ['\u{20000}\u{20001}', '\u{20002}\u{20003}']);
  // a paper-space POLYLINE whose vertices lack 67 does not take the paper entities after it
  const pp = parseDXF(ents([[0, 'POLYLINE'], [8, '0'], [67, 1], [66, 1], [70, 0]], [[0, 'VERTEX'], [8, '0'], [10, 0], [20, 0]], [[0, 'VERTEX'], [8, '0'], [10, 1], [20, 0]], [[0, 'SEQEND'], [8, '0']],
    [[0, 'LINE'], [8, '0'], [67, 1], [10, 0], [20, 5], [11, 5], [21, 5]], [[0, 'POLYLINE'], [8, '0'], [67, 1], [66, 1], [70, 0]], [[0, 'VERTEX'], [8, '0'], [67, 1], [10, 0], [20, 9]], [[0, 'VERTEX'], [8, '0'], [67, 1], [10, 9], [20, 9]], [[0, 'SEQEND'], [8, '0'], [67, 1]]));
  assert.ok(pp.layouts[0].paths.some((p) => p.pts[1] === 5), 'the LINE after it is drawn');
});
test('round 18: a viewport\'s view target; a non-plan or unknown view counted; each record counted once; viewport text clipped; sheets by tab order and name', () => {
  const vp = (extra) => [[0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 50], [40, 20], [41, 20], [69, 2], [12, 0], [22, 0], [45, 20], ...extra];
  const sheet = (...ents) => [[0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [10, 100], [20, 100], [11, 101], [21, 100],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 148], [20, 105], [40, 297], [41, 210], [69, 1], [12, 148], [22, 105], [45, 210], ...ents.flat(), [0, 'ENDSEC'], [0, 'EOF']];
  // the view centre is relative to the target: centre 0,0 + target 100,100 shows the line at 100,100
  const tg = parseDXF(dxf(sheet(vp([[17, 100], [27, 100]])))).layouts[0];
  assert.ok(tg.paths.some((p) => !p.frame), 'the model line seen through the viewport');
  // an isometric view and one with no view height: the frame alone, counted
  const iso = parseDXF(dxf(sheet(vp([[16, 1], [26, -1], [36, 1]]))));
  assert.deepEqual([iso.layouts[0].paths.filter((p) => !p.frame).length, iso.notDrawn['VIEWPORT (not a plan view)']], [0, 1]);
  const nov = parseDXF(dxf(sheet([[0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 50], [40, 20], [41, 20], [69, 2]])));
  assert.deepEqual([nov.layouts[0].paths.filter((p) => p.frame).length, nov.notDrawn['VIEWPORT (its view not read)']], [1, 1]);
  // a block holding a WIPEOUT, inserted 3 times: one WIPEOUT not drawn, not 3
  const three = parseDXF(dxf([[0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [8, '0'], [2, 'B'], [70, 0], [10, 0], [20, 0], [0, 'WIPEOUT'], [8, '0'], [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], ...[0, 1, 2].flatMap((k) => [[0, 'INSERT'], [8, '0'], [2, 'B'], [10, k], [20, 0]]), [0, 'ENDSEC'], [0, 'EOF']]));
  assert.deepEqual(three.notDrawn, { WIPEOUT: 1 });
  // a text through a viewport is clipped to its frame whatever its estimated box
  const tx = parseDXF(dxf(sheet([[0, 'TEXT'], [8, '0'], [10, 100], [20, 100], [40, 1], [1, 'W']], vp([[17, 100], [27, 100]])))).layouts[0];
  assert.ok(tx.texts.length && tx.texts.every((t) => t.clip), 'clipped');
  // sheets ordered by their LAYOUT's tab order, named by it (via the block record table)
  const lay = parseDXF(dxf([[0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'BLOCK_RECORD'], [0, 'BLOCK_RECORD'], [5, 'A1'], [2, '*Paper_Space'], [0, 'BLOCK_RECORD'], [5, 'A2'], [2, '*Paper_Space0'], [0, 'ENDTAB'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [8, '0'], [2, '*Paper_Space0'], [70, 0], [10, 0], [20, 0], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 1], [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [67, 1], [10, 0], [20, 0], [11, 2], [21, 2], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'OBJECTS'], [0, 'LAYOUT'], [5, 'B1'], [330, 'C0'], [100, 'AcDbPlotSettings'], [1, 'setup'], [100, 'AcDbLayout'], [1, 'Front'], [71, 2], [330, 'A1'],
    [0, 'LAYOUT'], [5, 'B2'], [330, 'C0'], [100, 'AcDbLayout'], [1, 'Cover'], [71, 1], [330, 'A2'], [0, 'ENDSEC'], [0, 'EOF']]));
  assert.deepEqual(lay.layouts.map((l) => l.name), ['Cover', 'Front']);
  // a name written outside the code page (\U+XXXX, before R2007) is read decoded
  const esc = parseDXF(dxf([[0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'BLOCK_RECORD'], [0, 'BLOCK_RECORD'], [5, 'A1'], [2, '*Paper_Space'], [0, 'ENDTAB'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [67, 1], [10, 0], [20, 0], [11, 2], [21, 2], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'OBJECTS'], [0, 'LAYOUT'], [5, 'B1'], [100, 'AcDbLayout'], [1, '\\U+5E03\\U+5C401'], [71, 1], [330, 'A1'], [0, 'ENDSEC'], [0, 'EOF']]));
  assert.deepEqual(esc.layouts.map((l) => l.name), ['布局1']);
});
test('round 19: a sheet of viewport frames alone draws nothing; a Uint8Array or Buffer is read as bytes', () => {
  const frames = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 148], [20, 105], [40, 297], [41, 210], [69, 1], [12, 148], [22, 105], [45, 210],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 50], [40, 20], [41, 20], [69, 2], [0, 'ENDSEC'], [0, 'EOF']]));
  assert.equal(frames.layouts[0].paths.length, 1);
  assert.equal(drawsNothing(frames), true);
  assert.deepEqual(sheetsOf(frames), [], 'no sheet offered (the Sheet menu, the info row and dwg-check agree)');
  const text = dxf([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 1], [0, 'ENDSEC'], [0, 'EOF']]);
  assert.equal(parseDXF(new TextEncoder().encode(text)).paths.length, 1);
  assert.equal(parseDXF(Buffer.from(text)).paths.length, 1);
});
test('the 2D snaps and the hover\'s line: the index finds what a scan of every one finds, at every radius, with a layer hidden', () => {
  let s = 11;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // clustered: most points in a small patch, some on cell-like edges (whole numbers)
  // (as the page builds them: one-point paths, each one end snap, through snapPoints' typed set, r28 Q6)
  const one = [];
  for (let i = 0; i < 20000; i++) {
    const c = i % 4 === 0;
    one.push({ layer: i % 3 === 0 ? 'HID' : 'A', closed: false, pts: Float64Array.of(c ? Math.round(rnd() * 100) : 50 + rnd() * 0.5, c ? Math.round(rnd() * 100) : 50 + rnd() * 0.5) });
  }
  const set = snapPoints(one, [0, 0]);
  const pts = Array.from({ length: set.n }, (_, i) => set.at(i));
  assert.equal(pts.length, 20000);
  const tree = pointTree(set);
  const ok = (p) => p[3] !== 'HID';
  for (let q = 0; q < 300; q++) {
    const x = rnd() * 100, y = rnd() * 100, r = [0.01, 0.3, 3, 40][q % 4];
    let best = null, bd = r * r;
    for (const p of pts) { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd && ok(p)) { bd = d; best = p; } }
    const got = nearestPoint(tree, x, y, r, ok);
    assert.equal(got === null ? null : (got[0] - x) ** 2 + (got[1] - y) ** 2, best === null ? null : bd, `query ${q}`);
  }
  // segments: polylines, one long line across everything, a hidden layer
  const paths = [];
  for (let i = 0; i < 400; i++) { const x = rnd() * 100, y = rnd() * 100; paths.push({ layer: i % 5 ? 'A' : 'HID', closed: i % 7 === 0, pts: Float64Array.of(x, y, x + rnd() * 3, y + rnd() * 3, x + rnd() * 3, y - rnd() * 2) }); }
  paths.push({ layer: 'A', closed: false, pts: Float64Array.of(-500, 37, 600, 38) });
  // 45-degree hatching: short, in the short segments' tree (the long one holds the line across)
  for (let i = 0; i < 40; i++) paths.push({ layer: 'A', closed: false, pts: Float64Array.of(10 + i * 0.7, 60, 10 + i * 0.7 + 2.5, 62.5) });
  const grid = segmentIndex(paths, [0, 0], 100);
  assert.equal(grid.longTree.m, 1, `long: ${grid.longTree.m} (the one line across everything)`);
  // (held in typed arrays: an array per segment and a Map of arrays, 604 MB for 5.2 million)
  assert.ok(grid.segs instanceof Float64Array && grid.tree.order instanceof Uint32Array && grid.tree.box instanceof Float32Array, 'typed arrays');
  const okP = (pi) => paths[pi].layer !== 'HID';
  // (and off the drawing, and a radius wider than the drawing)
  for (let q = 0; q < 400; q++) {
    const off = q >= 300, x = off ? rnd() * 300 - 100 : rnd() * 100, y = off ? rnd() * 300 - 100 : rnd() * 100, r = off ? [2, 30, 90][q % 3] : [0.05, 1, 8][q % 3];
    let best = -1, bd = r * r;
    paths.forEach((p, pi) => {
      const n = p.pts.length / 2;
      for (let i = 0; i < n; i++) {
        const j = i + 1 < n ? i + 1 : p.closed ? 0 : -1;
        const ax = p.pts[2 * i], ay = p.pts[2 * i + 1], bx = j < 0 ? ax : p.pts[2 * j], by = j < 0 ? ay : p.pts[2 * j + 1];
        const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0;
        const d2 = (x - ax - t * vx) ** 2 + (y - ay - t * vy) ** 2;
        if (d2 < bd && okP(pi)) { bd = d2; best = pi; }
      }
    });
    assert.equal(nearestSegment(grid, x, y, r, okP), best, `segment query ${q}`);
  }
});
test('a drawing whose lines cluster in a corner of its extents: the hover stays fast and right', () => {
  // 400,000 short segments in a 10 x 10 patch, a sheet 10,000 across (two far marks): a grid sized
  // from the extents put nearly all in one cell, every query scanning them (a real drawing: 95.6 %
  // of 1.75 million, 30-40 ms a hover)
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pts = new Float64Array(2 * 400001);
  for (let i = 0; i <= 400000; i++) { pts[2 * i] = rnd() * 10; pts[2 * i + 1] = rnd() * 10; }
  const paths = [{ layer: 'A', closed: false, pts }, { layer: 'A', closed: false, pts: Float64Array.of(10000, 10000, 10000.1, 10000) }, { layer: 'A', closed: false, pts: Float64Array.of(-1, -1, -1.1, -1) }];
  // (zig-zag lines across the patch: each segment up to 14 long, so make them short)
  for (let i = 1; i <= 400000; i++) { pts[2 * i] = pts[2 * i - 2] + (rnd() - 0.5) * 0.05; pts[2 * i + 1] = pts[2 * i - 1] + (rnd() - 0.5) * 0.05; }
  // each segment its own path, in a shuffled file order: one polyline in walk order was already in
  // spatial order, and the tree without its Morton sort passed (r25 Q2: 1,643 ms shuffled)
  const ix = Array.from({ length: 400000 }, (_, i) => i);
  for (let i = ix.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ix[i], ix[j]] = [ix[j], ix[i]]; }
  const marks = paths.slice(1);
  paths.length = 0;
  for (const i of ix) paths.push({ layer: 'A', closed: false, pts: Float64Array.of(pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], pts[2 * i + 3]) });
  paths.push(...marks);
  const grid = segmentIndex(paths, [0, 0], 10001);
  const qs = Array.from({ length: 300 }, () => [pts[0] + (rnd() - 0.5) * 0.5, pts[1] + (rnd() - 0.5) * 0.5]);
  const t0 = performance.now();
  for (const [x, y] of qs) nearestSegment(grid, x, y, 0.02);
  const ms = performance.now() - t0;
  assert.ok(ms < 150, `300 hovers: ${ms.toFixed(0)} ms`);
  // and right: against a scan of every segment, for the first 20
  for (const [x, y] of qs.slice(0, 20)) {
    let best = -1, bd = 0.02 * 0.02;
    paths.forEach((p, pi) => { for (let i = 0; i + 1 < p.pts.length / 2; i++) { const ax = p.pts[2 * i], ay = p.pts[2 * i + 1], vx = p.pts[2 * i + 2] - ax, vy = p.pts[2 * i + 3] - ay, l2 = vx * vx + vy * vy; const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0; const d2 = (x - ax - t * vx) ** 2 + (y - ay - t * vy) ** 2; if (d2 < bd || (d2 === bd && best >= 0 && pi > best)) { bd = d2; best = pi; } } });
    // (of two at one distance -- two segments at the vertex they share -- the later, drawn on top:
    // pickAt's rule, r107 A1)
    assert.equal(nearestSegment(grid, x, y, 0.02), best);
  }
});
test('a site plan far from its centre, hovered at a deep zoom: the float32 boxes never shrink past a line (r25 Q2)', () => {
  // 2,000,000 across, the offset at its centre, 0.5-unit lines near a corner, an 8 px hover 0.004
  // units: unpadded float32 boxes missed 158 of 3,000 lines a scan finds
  let s = 5;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const paths = [{ layer: 'A', closed: true, pts: Float64Array.of(0, 0, 2e6, 0, 2e6, 2e6, 0, 2e6) }];
  for (let i = 0; i < 3000; i++) {
    const x = 1.99e6 + rnd() * 5000, y = 1.99e6 + rnd() * 5000, a = rnd() * Math.PI;
    paths.push({ layer: 'A', closed: false, pts: Float64Array.of(x, y, x + 0.5 * Math.cos(a), y + 0.5 * Math.sin(a)) });
  }
  const o = [1e6, 1e6];
  const index = segmentIndex(paths, o, 2e6);
  const r = 0.004, bad = [];
  let found = 0;
  for (let q = 1; q <= 3000; q++) {
    const p = paths[q].pts, f = rnd();
    const x = p[0] - o[0] + (p[2] - p[0]) * f + (rnd() - 0.5) * 0.008, y = p[1] - o[1] + (p[3] - p[1]) * f + (rnd() - 0.5) * 0.008;
    let best = -1, bd = r * r;
    paths.forEach((pp, pi) => {
      const n = pp.pts.length / 2;
      for (let i = 0; i < (pp.closed ? n : n - 1); i++) {
        const j = (i + 1) % n, ax = pp.pts[2 * i] - o[0], ay = pp.pts[2 * i + 1] - o[1], vx = pp.pts[2 * j] - o[0] - ax, vy = pp.pts[2 * j + 1] - o[1] - ay, l2 = vx * vx + vy * vy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0;
        const d2 = (x - ax - t * vx) ** 2 + (y - ay - t * vy) ** 2;
        if (d2 < bd) { bd = d2; best = pi; }
      }
    });
    if (best >= 0) found++;
    if (nearestSegment(index, x, y, r) !== best) bad.push(q);
  }
  assert.ok(found > 2000, `the scan finds a line in ${found}`);
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} of 3000 hovers differ from the scan`);
});
test('a path\'s segments: point to point, back to the first when closed, a one-point path one of no length (r25 Q7)', () => {
  const paths = [{ pts: Float64Array.of(0, 0, 1, 0, 1, 1), closed: false }, { pts: Float64Array.of(5, 5, 6, 5, 6, 6), closed: true }, { pts: Float64Array.of(9, 9), closed: false }, { pts: new Float64Array(0), closed: false }];
  const index = segmentIndex(paths, [0, 0], 10);
  // 2 + 3 + 1 (an open path of m points had m: one more of no length at its last point)
  assert.equal(index.pathOf.length, 6);
  assert.deepEqual([...index.pathOf], [0, 0, 1, 1, 1, 2]);
  assert.equal(nearestSegment(index, 9.1, 9, 0.5), 2, 'the one-point path is found');
  assert.equal(nearestSegment(index, 0.5, 0.6, 0.2), -1, 'an open path is not closed');
  assert.equal(nearestSegment(index, 5.5, 5.6, 0.2), 1, 'a closed one is');
});
test('2D Measure snaps the middle of a closed path\'s closing side, once (r26 Q3)', () => {
  // a 3DFACE-like square that does not repeat its first point, and one that does
  const open = { layer: 'A', closed: true, pts: Float64Array.of(0, 0, 4, 0, 4, 4, 0, 4) };
  const rep = { layer: 'A', closed: true, pts: Float64Array.of(0, 0, 4, 0, 4, 4, 0, 4, 0, 0) };
  const mids = (p) => { const s = snapPoints([p], [0, 0]); return Array.from({ length: s.n }, (_, i) => s.at(i)).filter((x) => x[2] === 'middle').map((x) => `${x[0]},${x[1]}`).sort(); };
  assert.deepEqual(mids(open), ['0,2', '2,0', '2,4', '4,2'], 'its four sides');
  assert.deepEqual(mids(rep), ['0,2', '2,0', '2,4', '4,2'], 'the same four, the repeated point no fifth');
  assert.deepEqual(mids({ ...open, closed: false }), ['2,0', '2,4', '4,2'], 'an open path has no closing side');
  // (held typed, not an array a snap: 808 MB for 9 M snaps; the view builds them when Measure turns on, r27 A5)
  const s = snapPoints([open], [0, 0]);
  assert.ok(s.xy instanceof Float64Array && s.kind instanceof Uint8Array && s.path instanceof Uint32Array, 'typed');
  assert.equal(s.at(3), s.at(3), 'one array for one snap');
});
test('the box tree: a hit at exactly r is within r, and the nearer child is walked first (r26 Q6)', () => {
  // points on a line, 1 apart: from 0.5 off the line at x 3, at r = 0.5 the point (3, 0) is exactly r away
  const pts = Array.from({ length: 200 }, (_, i) => [i, 0]);
  const index = pointTree(snapPoints(pts.map(([x, y]) => ({ layer: 'A', closed: false, pts: Float64Array.of(x, y) })), [0, 0]));
  assert.deepEqual(nearestPoint(index, 3, 0.5, 0.5).slice(0, 2), [3, 0], 'inclusive radius');
  assert.equal(nearestPoint(index, 3, 0.5, 0.4999), null);
  // the walk: a query near one end visits only a few items (the nearer child first prunes the rest)
  const B = new Float64Array(4 * pts.length);
  pts.forEach(([x, y], i) => B.set([x, y, x, y], 4 * i));
  const tree = boxTree(B, Uint32Array.from(pts.keys()));
  let visited = 0;
  const id = nearestItem([tree], [0.2, 0], 50, (i) => { visited++; return (pts[i][0] - 0.2) ** 2; });
  assert.equal(id, 0);
  assert.ok(visited <= 32, `${visited} items tested (the far side first: every leaf within 50)`);
});
test('the hover\'s texts are in the one box tree: the top text whose quad holds the point, as a scan finds it, fast over a million (r25 A5, A7, r107 A6)', () => {
  // (by pickAt's rule, among texts alone: the last in the draw on top -- the first was found, r107 A6)
  const none = segmentIndex([], [0, 0], 1);
  const textAt = (index, x, y, accept = () => true) => { const h = pickAt(none, x, y, 0, { texts: { index, accept } }); return h ? h.text : -1; };
  let s = 3;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // quads (bottom-left, bottom-right, top-left, top-right) of rotated, overlapping texts
  const quad = (t) => {
    const c = Math.cos(t.rot), sn = Math.sin(t.rot);
    return [[0, 0], [t.w, 0], [0, t.h], [t.w, t.h]].map(([u, v]) => [t.x + u * c - v * sn, t.y + u * sn + v * c]);
  };
  // (a third mirrored -- a backward text, its quad wound clockwise: r26 Q5)
  const texts = Array.from({ length: 3000 }, (_, i) => ({ x: rnd() * 100, y: rnd() * 100, w: (i % 3 ? 1 : -1) * (1 + rnd() * 8), h: 0.5 + rnd() * 2, rot: rnd() * 6.3, layer: i % 4 ? 'A' : 'HID' }));
  const o = [3, 4];
  const index = textIndex(texts, quad, o);
  const ok = (i) => texts[i].layer !== 'HID';
  const inside = (q, x, y) => { const p = [q[0], q[1], q[3], q[2]]; let pos = 0, neg = 0; for (let k = 0; k < 4; k++) { const [ax, ay] = p[k], [bx, by] = p[(k + 1) % 4]; const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax); if (cr > 0) pos++; else if (cr < 0) neg++; } return !(pos && neg); };
  let hits = 0;
  for (let q = 0; q < 2000; q++) {
    const x = rnd() * 110 - 5, y = rnd() * 110 - 5;
    const want = texts.findLastIndex((t, i) => ok(i) && inside(quad(t), x + o[0], y + o[1]));
    if (want >= 0) hits++;
    assert.equal(textAt(index, x, y, ok), want, `query ${q}`);
  }
  assert.ok(hits > 500, `${hits} hits`);
  // a million texts 1 high, 5 apart: a hover over empty sheet tested every one, 360 ms
  const many = [];
  for (let i = 0; i < 1e6; i++) many.push({ x: (i % 1000) * 5, y: Math.floor(i / 1000) * 5, w: 3, h: 1, rot: 0 });
  const big = textIndex(many, quad, [0, 0]);
  const t0 = performance.now();
  for (let q = 0; q < 300; q++) textAt(big, 2 + rnd() * 4990, 2.5 + rnd() * 1.5 + 5 * Math.floor(rnd() * 999));
  const ms = performance.now() - t0;
  assert.ok(ms < 150, `300 hovers over empty sheet: ${ms.toFixed(0)} ms`);
});
test('300 wrapped MTEXTs through 300 viewports: each wrapped once', () => {
  const texts = [], vps = [];
  for (let k = 0; k < 300; k++) texts.push([0, 'MTEXT'], [8, '0'], [10, k], [20, 0], [40, 1], [41, 30], [71, 1], [1, `t${k} ${'word '.repeat(400).trim()}`]);
  for (let k = 0; k < 300; k++) vps.push([0, 'VIEWPORT'], [8, '0'], [67, 1], [10, k * 20], [20, 5], [40, 10], [41, 10], [69, k + 2], [12, 150], [22, 0], [45, 400]);
  const G = [[0, 'SECTION'], [2, 'ENTITIES'], ...texts, [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 148], [20, 105], [40, 297], [41, 210], [69, 1], [12, 148], [22, 105], [45, 210], ...vps, [0, 'ENDSEC'], [0, 'EOF']];
  const t0 = Date.now();
  parseDXF(dxf(G));
  assert.ok(Date.now() - t0 < 10000, `${Date.now() - t0} ms`);
});
test('a long MTEXT through 1,000 layout viewports is wrapped once, not once a viewport', () => {
  const vps = [];
  for (let k = 0; k < 1000; k++) vps.push([0, 'VIEWPORT'], [8, '0'], [67, 1], [10, k * 20], [20, 5], [40, 10], [41, 10], [69, k + 2], [12, 0], [22, 0], [45, 10]);
  const G = [[0, 'SECTION'], [2, 'ENTITIES'], [0, 'MTEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [41, 30], [71, 1], [1, 'word '.repeat(40000).trim()],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 148], [20, 105], [40, 297], [41, 210], [69, 1], [12, 148], [22, 105], [45, 210], ...vps, [0, 'ENDSEC'], [0, 'EOF']];
  const t0 = Date.now();
  parseDXF(dxf(G));
  assert.ok(Date.now() - t0 < 8000, `${Date.now() - t0} ms`);
});
test('round 15: an escaped stack, a byte-order mark under a named code page, a linear wrap, an oblique box', () => {
  assert.equal(mtextPlain('5\\S+0.1\\U+00B0^-0.1\\U+00B0;'), '5 +0.1° -0.1°');
  assert.equal(mtextPlain('\\S\\U+00B1 0.1^;'), '± 0.1');
  // a TEXT's leading space is part of it, written as itself or escaped (one was trimmed, one not)
  const lead = (v) => parseDXF(ents([[0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, v]])).texts[0].text;
  assert.equal(lead('　１台'), '　１台');
  assert.equal(lead('\\U+3000１台'), '　１台');
  // a UTF-8 BOM before an R2000 DXF naming ANSI_1252: drawn
  const B = new TextEncoder().encode(`﻿${dxf([[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [9, '$DWGCODEPAGE'], [3, 'ANSI_1252'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 1], [0, 'ENDSEC'], [0, 'EOF']])}`);
  assert.equal(B[0], 0xef);
  assert.equal(parseDXF(B.buffer).paths.length, 1);
  // the wrap measures each word once: 200,000 words, about as many measures (it was one per word
  // of the growing line, quadratic in characters)
  let chars = 0;
  const words = Array(200000).fill('abc').join(' ');
  wrapLines([words], (l) => { chars += l.length; return l.length; }, words.length - 1);
  assert.ok(chars < 4 * words.length, `${chars} characters measured`);
  // an oblique text's box leans with it, the lean scaled by its width factor (as the view slants
  // before it scales)
  const c = textCorners({ x: 0, y: 0, h: 1, rot: 0, text: 'X', align: 'left', valign: 'baseline', oblique: Math.PI / 6 });
  assert.ok(Math.max(...c.map((q) => q[0])) > 0.6 + 0.5, 'the top right corner moved along by tan 30° per unit height');
  const c2 = textCorners({ x: 0, y: 0, h: 1, rot: 0, text: 'X', align: 'left', valign: 'baseline', oblique: Math.PI / 4, widthFactor: 2 });
  assert.ok(Math.abs(Math.max(...c2.map((q) => q[0])) - (1.2 / TEXT_CAP + 2)) < 1e-9, `${JSON.stringify(c2)}`);
  // CJK breaks between characters (it has no spaces); spaces at a break are dropped
  assert.deepEqual(wrapLines(['平面図配置図'], (l) => l.length, 4), ['平面図配', '置図']);
  assert.deepEqual(wrapLines(['ab  cd'], (l) => l.length, 3), ['ab', 'cd']);
  assert.deepEqual(wrapLines(['图 A1 平面'], (l) => l.length, 5), ['图 A1', '平面']);
});
test('looksLikeDxf on blank lines and 999s that never reach SECTION: linear, not exponential (27 s for 127 bytes)', () => {
  const head = `${'999\n\n\n\n'.repeat(400)}solid x\n`;
  const t0 = Date.now();
  assert.equal(sniffFormat(new TextEncoder().encode(head)), null);
  assert.ok(Date.now() - t0 < 200, `${Date.now() - t0} ms`);
});
test('an invisible INSERT of a block that exists draws nothing of the block', () => {
  const s = dxf([[0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [8, '0'], [2, 'B'], [70, 0], [10, 0], [20, 0], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 5], [21, 0], [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, '0'], [60, 1], [2, 'B'], [10, 0], [20, 0], [0, 'INSERT'], [8, '0'], [2, 'B'], [10, 0], [20, 10], [0, 'ENDSEC'], [0, 'EOF']]);
  const d = parseDXF(s);
  assert.equal(d.paths.length, 1, 'the visible insert only');
  assert.deepEqual([...d.paths[0].pts], [0, 10, 5, 10]);
});
test('a coordinate that is not a number leaves that line out, not the drawing\'s extents NaN', () => {
  const d = parseDXF(ents([[0, 'LINE'], [8, '0'], [10, 'abc'], [20, 0], [11, 1], [21, 1]], [[0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 5], [21, 5]]));
  assert.equal(d.paths.length, 1);
  assert.deepEqual(d.extents, { min: [0, 0], max: [5, 5] });
});
test('an ASCII DXF is read in its code page: 1252 before R2007, UTF-8 from it, GBK when it says so', () => {
  const head = (ver, cp) => [[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, ver], ...(cp ? [[9, '$DWGCODEPAGE'], [3, cp]] : []), [0, 'ENDSEC']];
  const body = (t) => [[0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, t], [0, 'ENDSEC'], [0, 'EOF']];
  const bytes = (groups, enc) => enc(dxf(groups));
  const latin = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0))).buffer;
  // "Ø20 ±0.1 90°" in Windows-1252 bytes, an R2000 file
  assert.equal(parseDXF(bytes([...head('AC1015', 'ANSI_1252'), ...body('\xd820 \xb10.1 90\xb0')], latin)).texts[0].text, 'Ø20 ±0.1 90°');
  // the same in UTF-8, an R2007 file
  assert.equal(parseDXF(new TextEncoder().encode(dxf([...head('AC1021'), ...body('Ø20 ±0.1 90°')])).buffer).texts[0].text, 'Ø20 ±0.1 90°');
  // GBK (素土 = CB D8 CD C1), an R2000 file of code page 936
  assert.equal(parseDXF(latin(dxf([...head('AC1015', 'ANSI_936'), ...body('\xcb\xd8\xcd\xc1')]))).texts[0].text, '素土');
});
test('a truncated binary DXF: "ends inside a value", not the engine\'s DataView error', () => {
  const s = 'AutoCAD Binary DXF\r\n\x1a\x00';
  const b = new Uint8Array(s.length + 3);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  b[s.length] = 10; // group 10 (a double): two bytes of code, then only one byte of the 8
  assert.throws(() => parseDXF(b.buffer), /the binary DXF ends inside a value/);
});
test('a rational quadratic spline of a quarter circle lies on the circle (weights, de Boor)', () => {
  const w = Math.SQRT1_2;
  const d = parseDXF(ents([[0, 'SPLINE'], [8, '0'], [70, 4], [71, 2], [72, 6], [73, 3], [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1],
    [10, 1], [20, 0], [41, 1], [10, 1], [20, 1], [41, w], [10, 0], [20, 1], [41, 1]]));
  const p = d.paths[0].pts;
  assert.ok(p.length >= 8);
  for (let k = 0; k < p.length; k += 2) assert.ok(Math.abs(Math.hypot(p[k], p[k + 1]) - 1) < 1e-9, `radius ${Math.hypot(p[k], p[k + 1])}`);
});

// --- hostile drawings (review round 2): each fails fast in words, or draws within a budget ---
const text = (blocks, ents) => ['0', 'SECTION', '2', 'BLOCKS', ...blocks, '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...ents, '0', 'ENDSEC', '0', 'EOF'].join('\n');
const ENGINE = /Cannot read|is not a function|RangeError|Invalid array length|call stack|out of bounds|outside the bounds/;
const fast = (fn, ms) => { const t0 = Date.now(); let err = null; try { fn(); } catch (e) { err = e; } const dt = Date.now() - t0; assert.ok(dt < ms, `${dt} ms`); return err; };
test('blocks of empty blocks inserted many times: refused in words, fast (the walk is budgeted)', () => {
  const blocks = [];
  for (let k = 0; k < 17; k++) {
    blocks.push('0', 'BLOCK', '2', `B${k}`, '10', '0', '20', '0');
    if (k < 16) for (let j = 0; j < 10; j++) blocks.push('0', 'INSERT', '2', `B${k + 1}`, '10', '0', '20', '0');
    blocks.push('0', 'ENDBLK');
  }
  const e = fast(() => parseDXF(text(blocks, ['0', 'INSERT', '2', 'B0', '10', '0', '20', '0'])), 10000);
  assert.ok(e && /too large to draw here/.test(e.message) && !ENGINE.test(e.message), String(e && e.message));
});
test('a HATCH counting more vertices or edges than it holds: refused as damaged, fast', () => {
  for (const g of [['92', '2', '72', '0', '73', '1', '93', '1000000000000'], ['92', '0', '93', '1000000000000']]) {
    const e = fast(() => parseDXF(text([], ['0', 'HATCH', '70', '1', '91', '1', ...g])), 1000);
    assert.ok(e && /damaged HATCH/.test(e.message) && !ENGINE.test(e.message), String(e && e.message));
  }
});
test('a HATCH boundary of 200,000 vertices draws (appended, not spread onto the stack)', () => {
  const g = ['0', 'HATCH', '70', '1', '91', '1', '92', '2', '72', '0', '73', '1', '93', '200000'];
  for (let i = 0; i < 200000; i++) g.push('10', String(i % 1000), '20', String((i / 1000) | 0));
  const d = parseDXF(text([], g));
  assert.equal(d.paths.length, 1);
  assert.equal(d.paths[0].pts.length, 400002, 'every vertex, and the first again to close it');
});
test('a SPLINE of degree -1 or 1.5 draws its control polygon, no engine error', () => {
  for (const deg of [['71', '-1', '40', '0', '40', '1'], ['71', '1.5', '40', '0', '40', '0', '40', '1', '40', '1', '40', '1']]) {
    const d = parseDXF(text([], ['0', 'SPLINE', ...deg, '10', '0', '20', '0', '10', '1', '20', '1']));
    assert.deepEqual([...d.paths[0].pts], [0, 0, 1, 1]);
  }
});
test('3000 viewports onto empty space over 20,000 lines: fast (a viewport passes over what it cannot see)', () => {
  const e = [];
  for (let i = 0; i < 20000; i++) e.push('0', 'LINE', '8', '0', '10', String(i), '20', '0', '11', String(i + 1), '21', '1');
  for (let i = 0; i < 3000; i++) e.push('0', 'VIEWPORT', '67', '1', '69', String(i + 2), '10', '0', '20', '0', '40', '1', '41', '1', '45', '1', '12', '-1e9', '22', '-1e9');
  let d;
  const err = fast(() => { d = parseDXF(['0', 'SECTION', '2', 'ENTITIES', ...e, '0', 'ENDSEC', '0', 'EOF'].join('\n')); }, 3000);
  assert.equal(err, null, String(err && err.message));
  assert.equal(d.paths.length, 20000);
  // only the frames: no model line is in view
  assert.ok(d.layouts[0].paths.every((p) => p.frame));
});
test('a viewport still draws what it does see (the cull keeps a line inside its view)', () => {
  const e = ['0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '1',
    '0', 'VIEWPORT', '67', '1', '69', '2', '10', '0', '20', '0', '40', '4', '41', '4', '45', '4', '12', '0', '22', '0'];
  const d = parseDXF(['0', 'SECTION', '2', 'ENTITIES', ...e, '0', 'ENDSEC', '0', 'EOF'].join('\n'));
  assert.equal(d.layouts[0].paths.filter((p) => !p.frame).length, 1);
});
test('MTEXT stacking on 60,000 separators with no ";" is linear', () => {
  assert.equal(fast(() => mtextPlain('x\\S' + '#'.repeat(60000)), 500), null, 'fast and without an error');
  assert.equal(mtextPlain('\\S1#2;'), '1/2');
  assert.equal(mtextPlain('\\S1/2;'), '1/2');
  // ("^" is a tolerance or a super- / subscript, never a fraction: round 11)
  assert.equal(mtextPlain('\\Sa^b;'), 'a b');
});

// --- review round 3 ---
test('a 300-point SPLINE of degree 299 is drawn as its control polygon, fast', () => {
  const n = 300, deg = n - 1;
  const g = ['0', 'SPLINE', '8', '0', '71', String(deg)];
  for (let k = 0; k < n + deg + 1; k++) g.push('40', String(k < n ? 0 : 1));
  for (let k = 0; k < n; k++) g.push('10', String(k), '20', String(k % 2));
  let d;
  fast(() => { d = parseDXF(text([], g)); }, 1000);
  assert.equal(d.paths[0].pts.length, 2 * n);
});
test('a block\'s SPLINE inserted 2,000 times is evaluated once', () => {
  const sp = ['0', 'SPLINE', '8', '0', '71', '3'];
  const n = 200;
  for (let k = 0; k < n + 4; k++) sp.push('40', String(Math.max(0, Math.min(n - 3, k - 3))));
  for (let k = 0; k < n; k++) sp.push('10', String(k), '20', String(k % 3));
  const ins = [];
  for (let k = 0; k < 2000; k++) ins.push('0', 'INSERT', '2', 'S', '10', String(k), '20', '0');
  let d;
  fast(() => { d = parseDXF(text(['0', 'BLOCK', '2', 'S', '10', '0', '20', '0', ...sp, '0', 'ENDBLK'], ins)); }, 3000);
  assert.equal(d.paths.length, 2000);
});
test('MTEXT codes with no ";" (\\A, \\S) are one pass, and real codes still strip', () => {
  assert.equal(fast(() => mtextPlain('\\A'.repeat(60000)), 500), null, 'fast and without an error');
  assert.equal(fast(() => mtextPlain('\\Sa/'.repeat(60000)), 500), null, 'fast and without an error');
  assert.equal(mtextPlain('\\A1;\\fArial|b1;Bold\\H2.5x;x'), 'Boldx');
  assert.equal(mtextPlain('\\S1#2;'), '1/2');
});
test('20,000 viewports onto 200,000 lines: refused in words within a few seconds', () => {
  const e = [];
  for (let k = 0; k < 200000; k++) e.push('0', 'LINE', '8', '0', '10', String(k % 100), '20', '0', '11', String(k % 100), '21', '1');
  for (let k = 0; k < 20000; k++) e.push('0', 'VIEWPORT', '67', '1', '8', '0', '10', '0', '20', '0', '40', '10', '41', '10', '45', '10', '12', '1e9', '22', '1e9', '69', String(k + 2));
  const err = fast(() => parseDXF(['0', 'SECTION', '2', 'ENTITIES', ...e, '0', 'ENDSEC', '0', 'EOF'].join('\n')), 8000);
  assert.ok(err && /viewports look at the model/.test(err.message), String(err && err.message));
});

// --- review round 5 ---
test('a block LWPOLYLINE that draws nothing (a coordinate not a number), inserted 10,000 times: read once, fast', () => {
  const lw = ['0', 'LWPOLYLINE', '8', '0', '90', '5000', '70', '0'];
  for (let k = 0; k < 5000; k++) lw.push('10', k === 3 ? 'x' : String(k), '20', '0');
  let d;
  const err = fast(() => { d = parseDXF(text(['0', 'BLOCK', '2', 'B', '10', '0', '20', '0', ...lw, '0', 'ENDBLK'], ['0', 'INSERT', '2', 'B', '70', '100', '71', '100', '44', '1', '45', '1'])); }, 3000);
  assert.equal(err, null, String(err && err.message));
  assert.equal(d.paths.length, 0);
});
test('one 100,000-point path clipped in 1,000 viewports: refused in words within a few seconds', () => {
  const e = ['0', 'LWPOLYLINE', '8', '0', '90', '100000', '70', '1'];
  for (let k = 0; k < 100000; k++) e.push('10', String(k % 2 ? 0 : 100), '20', String(k));
  for (let k = 0; k < 1000; k++) e.push('0', 'VIEWPORT', '67', '1', '8', '0', '10', '0', '20', '0', '40', '10', '41', '10', '45', '10', '12', '50', '22', '50000', '69', String(k + 2));
  const err = fast(() => parseDXF(['0', 'SECTION', '2', 'ENTITIES', ...e, '0', 'ENDSEC', '0', 'EOF'].join('\n')), 5000);
  assert.ok(err && /viewports clip over/.test(err.message), String(err && err.message));
});

// --- review round 4 ---
test('a block that inserts itself is refused at once, by name', () => {
  const err = fast(() => parseDXF(text(['0', 'BLOCK', '2', 'A', '10', '0', '20', '0', ...Array(10).fill(['0', 'INSERT', '2', 'A']).flat(), '0', 'ENDBLK'], ['0', 'INSERT', '2', 'A'])), 500);
  assert.ok(err && /block A inserts itself/.test(err.message), String(err && err.message));
});
test('a block entity of 100,000 groups inserted 2,500 times: its groups are read once, fast', () => {
  const fat = ['0', 'FOO'];
  for (let k = 0; k < 100000; k++) fat.push('999', 'x');
  const mt = ['0', 'MTEXT', '10', '0', '20', '0'];
  for (let k = 0; k < 100000; k++) mt.push('3', '{}');
  mt.push('1', 'hi');
  let d;
  const err = fast(() => { d = parseDXF(text(['0', 'BLOCK', '2', 'B', '10', '0', '20', '0', ...fat, ...mt, '0', 'ENDBLK'], ['0', 'INSERT', '2', 'B', '70', '50', '71', '50', '44', '1', '45', '1'])); }, 3000);
  assert.equal(err, null, String(err && err.message));
  assert.equal(d.texts.length, 2500);
});

// (r64 Q1: a block reference on a frozen layer draws none of its block -- its entities on other,
// thawed layers too; one on a layer that is off hides only what takes the insert's layer)
const heldTo = (layerFlags) => parseDXF(dxf([
  [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'],
  [0, 'LAYER'], [2, 'A'], [70, 0], [62, 1],
  [0, 'LAYER'], [2, 'F'], [70, layerFlags], [62, 2],
  [0, 'ENDTAB'], [0, 'ENDSEC'],
  ...blocks([[0, 'BLOCK'], [2, 'B'], [10, 0], [20, 0], [0, 'LINE'], [8, 'A'], [10, 0], [20, 0], [11, 1], [21, 0], [0, 'LINE'], [8, '0'], [10, 0], [20, 5], [11, 1], [21, 5], [0, 'ENDBLK']],
    [[0, 'BLOCK'], [2, 'OUTER'], [10, 0], [20, 0], [0, 'INSERT'], [8, '0'], [2, 'B'], [10, 0], [20, 0], [0, 'ENDBLK']]),
  [0, 'SECTION'], [2, 'ENTITIES'],
  [0, 'INSERT'], [8, 'F'], [2, 'B'], [10, 0], [20, 0],
  // (nested: a reference on F to a block that references B on layer 0, which takes F)
  [0, 'INSERT'], [8, 'F'], [2, 'OUTER'], [10, 10], [20, 0],
  [0, 'LINE'], [8, 'A'], [10, 0], [20, 9], [11, 1], [21, 9],
  [0, 'ENDSEC'], [0, 'EOF']]));
test('a block reference on a frozen layer: every item it draws is held to that layer, nested ones too; one on a layer off is not (r64 Q1)', () => {
  const fz = heldTo(1);
  const F = fz.layers.find((l) => l.name === 'F');
  assert.deepEqual([F.on, F.frozen], [false, true]);
  const paths = fz.paths.map((p) => [p.layer, (p.hold || []).join(','), p.pts[1]]);
  // B's line on A at y 0 and its layer-0 line at y 5 (which takes F), each twice (the nested one at x 10); the free line on A
  // (F once in the nested one's hold, though B there takes F again: r65)
  assert.deepEqual(paths.sort(), [['A', 'F', 0], ['A', 'F', 0], ['A', '', 9], ['F', 'F', 5], ['F', 'F', 5]].sort());
  // must accept: a layer only off holds nothing
  const off = parseDXF(dxf([
    [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'], [0, 'LAYER'], [2, 'F'], [70, 0], [62, -2], [0, 'ENDTAB'], [0, 'ENDSEC'],
    ...blocks([[0, 'BLOCK'], [2, 'B'], [10, 0], [20, 0], [0, 'LINE'], [8, 'A'], [10, 0], [20, 0], [11, 1], [21, 0], [0, 'ENDBLK']]),
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, 'F'], [2, 'B'], [10, 0], [20, 0], [0, 'ENDSEC'], [0, 'EOF']]));
  assert.deepEqual(off.paths.map((p) => [p.layer, p.hold ?? null]), [['A', null]]);
  assert.equal(off.layers.find((l) => l.name === 'F').frozen, false);
});
// (r67, round 28 Q7: the snap tree built in js/snap-worker.js is the page's own tree)
{
  let got = null;
  globalThis.self = { postMessage: (t) => { got = t; } };
  await import('../js/snap-worker.js');
  const paths = [{ pts: Float64Array.of(0, 0, 10, 0, 10, 10) }, { pts: Float64Array.of(5, 5, 7, 9) }, { pts: Float64Array.of(NaN, 1, 2, 3) }];
  const pts = snapPoints(paths, [0, 0]);
  const { finitePointIds } = await import('../js/dxf-view.js');
  globalThis.self.onmessage({ data: { xy: pts.xy, ids: finitePointIds(pts.xy, pts.n) } });
  const page = pointTree(pts).tree;
  test('the snap tree built in the worker is the page\'s own (r67, round 28 Q7)', () => {
    assert.deepEqual([...got.order], [...page.order]);
    assert.deepEqual([...got.box], [...page.box]);
    assert.deepEqual([got.m, got.P, got.D], [page.m, page.P, page.D]);
  });
  const handler = globalThis.self.onmessage;
  delete globalThis.self;
  // (r68 A1, Q4, A5, Q7: the view's worker path, run with a Worker that answers by snap-worker.js's
  // own handler a turn later -- or fails, as onerror -- on a canvas every view shares)
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 0 }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const saved = { window: globalThis.window, Path2D: globalThis.Path2D, ResizeObserver: globalThis.ResizeObserver, Worker: globalThis.Worker };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const made = [];
  let fail = false;
  globalThis.Worker = class {
    constructor(url) { this.url = String(url); this.dead = false; made.push(this); }
    postMessage(d) {
      setTimeout(() => {
        if (this.dead) return;
        if (fail) { this.onerror({}); return; }
        let out = null;
        globalThis.self = { postMessage: (t) => { out = t; } };
        handler({ data: d });
        delete globalThis.self;
        this.onmessage({ data: out });
      }, 5);
    }
    terminate() { this.dead = true; }
  };
  const canvas = { getContext: () => ctx, clientWidth: 800, clientHeight: 600, width: 0, height: 0, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const { createDxfView, SNAP_WORKER_MIN } = await import('../js/dxf-view.js');
  // (a drawing of SNAP_WORKER_MIN snap points and over: each 2-point line gives its 2 ends and its middle)
  const lines = (n) => Array.from({ length: n }, (_, i) => ({ pts: [i, 0, i, 1], layer: '0', colour: { r: 0, g: 0, b: 0, aci: 7 } }));
  const big = lines(Math.ceil(SNAP_WORKER_MIN / 3) + 10);
  const drawingOf = (paths) => ({ layers: [{ name: '0', on: true }], paths, texts: [], extents: { min: [0, 0], max: [paths.length, 1] } });
  const later = () => new Promise((r) => setTimeout(r, 60));
  await test('a large drawing\'s snaps: none while the worker builds, the worker\'s tree once in; a small one at once, no worker (r68 A5, Q7)', async () => {
    made.length = 0;
    const small = createDxfView(canvas, drawingOf(lines(10)), {});
    small.setMeasure(true);
    assert.ok(small.snapAt(400, 300), 'a small drawing snaps at once');
    assert.equal(made.length, 0, 'and makes no worker');
    small.destroy();
    const v = createDxfView(canvas, drawingOf(big), {});
    v.setMeasure(true);
    assert.equal(made.length, 1);
    assert.match(made[0].url, /snap-worker\.js$/);
    assert.equal(v.snapAt(400, 300), null, 'no snap while the tree builds');
    await later();
    assert.ok(v.snapAt(400, 300), 'a snap once the worker\'s tree is in');
    assert.equal(made[0].dead, true, 'the worker ended after its answer');
    v.destroy();
  });
  await test('a view destroyed while its snap tree builds ends its worker and draws nothing after, on the canvas the next view has (r68 A1, Q4)', async () => {
    made.length = 0;
    let after = 0, destroyed = false;
    const a = createDxfView(canvas, drawingOf(big), { onDraw: () => { if (destroyed) after++; } });
    a.setMeasure(true);
    a.destroy(); destroyed = true;
    assert.equal(made[0].dead, true, 'destroy ends the worker');
    const b = createDxfView(canvas, drawingOf(lines(5)), {});
    // (must fire: the answer, had the worker answered anyway, is dropped by the view that is gone)
    made[0].dead = false;
    made[0].postMessage({ xy: new Float64Array(0), ids: new Uint32Array(0) });
    await later();
    assert.equal(after, 0, 'the old view drew after it was destroyed');
    b.destroy();
  });
  await test('a worker that fails: the tree built on the page, the snaps there (r68 A5)', async () => {
    made.length = 0;
    fail = true;
    const v = createDxfView(canvas, drawingOf(big), {});
    v.setMeasure(true);
    await later();
    assert.ok(v.snapAt(400, 300));
    v.destroy();
    fail = false;
  });
  // (r113 M2 dxf-view-R77) the wheel over a 2D drawing zooms it about the cursor and holds the page's
  // scroll: a handler returning first left the view still and the page scrolling under it
  await test('2D wheel: one notch over the drawing holds the page scroll, redraws, and zooms about the cursor by exp(0.15) (r113 M2 dxf-view-R77)', async () => {
    const on = {};
    let draws = 0;
    const cv = { ...canvas, addEventListener(k, f) { on[k] = f; } };
    const v = createDxfView(cv, drawingOf(lines(10)), { onDraw: () => { draws++; } });
    await later();
    const a0 = v.toPx(2, 0.5), c0 = [400, 300];
    const d0 = draws;
    let held = 0;
    on.wheel({ deltaY: -100, deltaMode: 0, clientX: c0[0], clientY: c0[1], preventDefault: () => { held++; } });
    await later();
    assert.equal(held, 1, 'the page scroll held');
    assert.ok(draws > d0, 'redrawn after the wheel');
    const a1 = v.toPx(2, 0.5);
    const k = Math.hypot(a1[0] - c0[0], a1[1] - c0[1]) / Math.hypot(a0[0] - c0[0], a0[1] - c0[1]);
    assert.ok(Math.abs(k - Math.exp(0.15)) < 1e-9, `zoomed by ${k}, want ${Math.exp(0.15)}`);
    v.destroy();
  });
  // (r91 A1: the hover, driven by the view's own pointermove listener -- a deleted formatter threw
  // "fmt is not defined" at every circle's centre and the label kept "end")
  await test('2D Measure\'s hover over a circle\'s centre: its Ø by the readout\'s rule, in mm and in a 0.1 m drawing (r91 A1)', () => {
    const on = {};
    const cv = { ...canvas, addEventListener(k, f) { on[k] = f; } };
    const drawingIn = (ins, k) => parseDXF(dxf([[0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, ins], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 100 * k], [21, 0],
      [0, 'CIRCLE'], [8, '0'], [10, 50 * k], [20, 20 * k], [40, 2 * k], [0, 'ENDSEC'], [0, 'EOF']]));
    for (const [ins, k] of [[4, 1], [6, 0.001]]) {
      const hovers = [];
      const v = createDxfView(cv, drawingIn(ins, k), { onHover: (w) => hovers.push(w) });
      v.setMeasure(true);
      const e0 = v.toPx(0, 0);
      on.pointermove({ pointerId: 1, clientX: e0[0], clientY: e0[1] });
      const c = v.toPx(50 * k, 20 * k);
      on.pointermove({ pointerId: 1, clientX: c[0], clientY: c[1] });
      assert.deepEqual(hovers, ['end', 'centre (Ø 4.00 mm)'], `$INSUNITS ${ins}`);
      v.destroy();
    }
  });
  // (r116, survivors of r115's mutant pass the golden views missed: dxf-view-C131, an ellipse's
  // centre hovered as "centre (Ø 0 …)"; dxf-view-O516, the extreme search skipping point 1)
  await test('an ellipse\'s centre hovers as "centre", no Ø; a closed curve\'s quadrant snaps take point 1 when it is the extreme (r116: r115 dxf-view-C131, O516)', () => {
    const on = {};
    const cv = { ...canvas, addEventListener(k, f) { on[k] = f; } };
    const d = parseDXF(dxf([[0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'], [0, 'ELLIPSE'], [8, '0'], [10, 50], [20, 20], [30, 0], [11, 10], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, 2 * Math.PI], [0, 'ENDSEC'], [0, 'EOF']]));
    const hovers = [];
    const v = createDxfView(cv, d, { onHover: (w) => hovers.push(w) });
    v.setMeasure(true);
    const c = v.toPx(50, 20);
    on.pointermove({ pointerId: 1, clientX: c[0], clientY: c[1] });
    assert.equal(hovers[hovers.length - 1], 'centre');
    v.destroy();
    // a closed outline of no own point whose leftmost point is its second (index 1)
    const sp = snapPoints([{ closed: true, own: [], mids: [], pts: Float64Array.of(0, 0, -5, 1, 0, 5, 5, 1, 0, 0) }], [0, 0]);
    const q = [];
    for (let i = 0; i < sp.n; i++) { const a = sp.at(i); q.push(`${a[2]} ${a[0]} ${a[1]}`); }
    assert.deepEqual(q.sort(), ['quadrant -5 1', 'quadrant 0 0', 'quadrant 0 5', 'quadrant 5 1']);
  });
  // (r102 A1: a text through a clip outline is clipped by the even-odd rule the outline's lines,
  // fills and hover keep -- canvas's nonzero default painted it in a star's middle)
  // (r103: and the paths seen through it -- drawn whole, the canvas clipping them by the outline, as
  // a Path2D of its points, even-odd, each group inside a save and its restore)
  await test('what is seen through a clip outline is clipped by the canvas: its paths and its text, by the outline as a Path2D, even-odd (r102 A1, r103)', async () => {
    const clips = [], strokes = [];
    let saves = 0, restores = 0;
    // (a clip holds until the restore of the save before it: the stack of saves, each marked clipped)
    const stack = [];
    const clipped = () => stack.some(Boolean);
    const rec = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'clip' ? (...a) => { clips.push(a); if (stack.length) stack[stack.length - 1] = true; } : k === 'stroke' ? (p) => strokes.push({ p, clipped: clipped() }) : k === 'save' ? () => { saves++; stack.push(false); } : k === 'restore' ? () => { restores++; stack.pop(); } : k === 'measureText' ? () => ({ width: 0 }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
    const P2 = globalThis.Path2D;
    globalThis.Path2D = class { constructor() { this.pts = []; } moveTo(x, y) { this.pts.push(x, y); } lineTo(x, y) { this.pts.push(x, y); } closePath() {} rect() {} arc() {} };
    const cv = { ...canvas, getContext: () => rec };
    const d = drawingOf(lines(2));
    const outline = Float64Array.of(0, 0, 1, 1, 1, 0, 0, 1);
    // (five groups -- five colours -- and five texts through the one outline: clipped once for the
    // groups and once for the texts a draw, not once each -- r103 Q2)
    for (let c = 0; c < 5; c++) d.paths.push({ pts: Float64Array.of(-1, 0.5, 2, 0.5), layer: '0', colour: { r: c, g: 0, b: 0, aci: 7 }, clipPoly: outline, clip: [0, 0, 1, 1] });
    // (and a line on the outline's edge x = 1: stroked again unclipped -- r103 Q3)
    d.paths.push({ pts: Float64Array.of(1, 0, 1, 1), layer: '0', colour: { r: 9, g: 0, b: 0, aci: 7 }, clipPoly: outline, clip: [0, 0, 1, 1] });
    d.texts = [0, 1, 2, 3, 4].map((i) => ({ text: `STAR${i}`, x: 0.5, y: 0.5, h: 0.2, rot: 0, align: 'left', layer: '0', colour: { r: 0, g: 0, b: 0, aci: 7 }, clipPoly: outline }));
    let drawn = 0;
    const v = createDxfView(cv, d, { onDraw: () => { drawn++; } });
    for (let i = 0; i < 20 && !drawn; i++) await later();
    globalThis.Path2D = P2;
    assert.ok(drawn > 0, 'the view never drew');
    assert.equal(clips.length, 2 * drawn, `clips ${clips.length} in ${drawn} draws: once for the groups, once for the texts`);
    assert.ok(strokes.some(({ p, clipped: c }) => !c && p.pts && p.pts.join(',') === '0,-0.5,0,0.5'), 'the line on the outline\'s edge not stroked again unclipped');
    assert.ok(!strokes.some(({ p, clipped: c }) => !c && p.pts && p.pts.join(',') === '-2,0,1,0'), 'a line through the outline stroked unclipped');
    for (const a of clips) {
      assert.equal(a[1], 'evenodd');
      // (the outline's own points, relative to the drawing's middle o = (1, 0.5))
      assert.deepEqual(a[0].pts, [-1, -0.5, 0, 0.5, 0, -0.5, -1, 0.5]);
    }
    assert.equal(saves, restores, 'a save with no restore');
    v.destroy();
  });
  // (r103 A4: the hover takes a path through an outline only at a point the outline shows -- the
  // point hit, not the cursor: from inside the L's arm, a line 0.3 outside it, clipped away, was found)
  await test('a path seen through a clip outline is hovered only where the outline shows the point hit, not the cursor (r103 A4)', () => {
    const L = [[20, 20], [80, 20], [80, 40], [50, 40], [50, 60], [20, 60]];
    const full = parseDXF(dxf([[0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'], [0, 'LAYER'], [2, 'B'], [70, 0], [62, -7], [0, 'ENDTAB'], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'LINE'], [8, 'NEXTROOM'], [10, 0.3], [20, -5], [11, 0.3], [21, 18],
      [0, 'LINE'], [8, 'WALL'], [10, -25], [20, -15], [11, -25], [21, -5],
      [0, 'LWPOLYLINE'], [5, 'L1'], [8, 'B'], [67, 1], [90, 6], [70, 1], ...L.flatMap(([x, y]) => [[10, x], [20, y]]),
      [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, 65536], [340, 'L1'],
      [0, 'ENDSEC'], [0, 'EOF']]));
    const sh = full.layouts[0];
    // (kept: its foot, paper y 35..40, is in the L's lower bar; the rest runs up the notch beside the arm)
    assert.ok(sh.paths.some((p) => p.layer === 'NEXTROOM'), 'the line the outline shows a foot of dropped');
    const v = createDxfView(canvas, { ...full, paths: sh.paths, texts: sh.texts, extents: sh.extents }, {});
    v.fit();
    // (the cursor 0.5 inside the arm, the line 0.3 outside it -- nearer than HIT_PX at this zoom)
    assert.equal(v.layerAt(...v.toPx(49.8, 47)), null, 'a line the outline hides was hovered');
    // (and one the outline shows is found: WALL, inside the arm)
    assert.equal(v.layerAt(...v.toPx(25.2, 30)), 'WALL');
    v.destroy();
  });
  // (r104: a wide polyline is its band -- kept, stroked and hovered as the band the canvas draws,
  // not as its centreline; and a line along an outline's edge stroked unclipped only where it lies on it)
  const sheetWith = (ents, clipped) => {
    const O = [[0, 0], [34, 0], [34, 10], [40, 10], [40, 0], [60, 0], [60, 40], [0, 40]]; // (a notch in the bottom edge, x 34..40)
    return parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], ...ents,
      ...(clipped ? [[0, 'LWPOLYLINE'], [5, 'L1'], [8, 'B'], [67, 1], [90, O.length], [70, 1], ...O.flatMap(([x, y]) => [[10, x], [20, y]])] : []),
      [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 30], [20, 20], [40, 60], [41, 40], [69, 2], [12, 0], [22, 0], [45, 40], [90, clipped ? 65536 : 0], ...(clipped ? [[340, 'L1']] : []),
      [0, 'ENDSEC'], [0, 'EOF']])).layouts[0];
  };
  // (model = paper here: the viewport's centre 30, 20 shows model 0, 0 at 1:1; paper y = model y + 20)
  const wideAt = (y, w) => [[0, 'LWPOLYLINE'], [8, 'WIDE'], [90, 2], [70, 0], [43, w], [10, -20], [20, y - 20], [10, 20], [20, y - 20]];
  test('a wide polyline whose centreline runs just past a frame or an outline, its band inside, is kept (r104 A1, Q3)', () => {
    for (const clipped of [false, true]) {
      // (width 4 at paper y -1: its band reaches y 1, inside; must-reject: width 1, wholly outside)
      assert.equal(sheetWith(wideAt(-1, 4), clipped).paths.filter((p) => p.layer === 'WIDE').length, 1, clipped ? 'through an outline' : 'through a frame');
      assert.equal(sheetWith(wideAt(-1, 1), clipped).paths.filter((p) => p.layer === 'WIDE').length, 0, `a band wholly outside kept, ${clipped ? 'outline' : 'frame'}`);
    }
  });
  test('the pieces of a line along an outline\'s edges: not across a notch in the edge, not past the edge\'s end (r104 Q1, Q2)', () => {
    const notch = Float64Array.of(0, 0, 34, 0, 34, 10, 40, 10, 40, 0, 60, 0, 60, 40, 0, 40);
    const near = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-12);
    assert.ok(near(edgeOverlaps(notch, 0, 0, 60, 0), [0, 34 / 60, 40 / 60, 1]), String(edgeOverlaps(notch, 0, 0, 60, 0)));
    const box = Float64Array.of(0, 0, 60, 0, 60, 40, 0, 40);
    assert.ok(near(edgeOverlaps(box, -10, 0, 70, 0), [1 / 8, 7 / 8]), String(edgeOverlaps(box, -10, 0, 70, 0)));
    assert.deepEqual(edgeOverlaps(box, 0, 0.5, 60, 0.5), [], 'a line beside the edge is not on it');
  });
  await test('stroked unclipped: a hairline\'s pieces along its outline\'s edge, never a wide polyline (r104 A2, Q1, Q4)', async () => {
    const strokes = [];
    const stack = [];
    const rec = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'clip' ? () => { if (stack.length) stack[stack.length - 1] = true; } : k === 'stroke' ? (p) => strokes.push({ p, clipped: stack.some(Boolean), w: t.lineWidth, cap: t.lineCap }) : k === 'save' ? () => stack.push(false) : k === 'restore' ? () => stack.pop() : k === 'measureText' ? () => ({ width: 0 }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
    const P2 = globalThis.Path2D;
    globalThis.Path2D = class { constructor() { this.pts = []; } moveTo(x, y) { this.pts.push(x, y); } lineTo(x, y) { this.pts.push(x, y); } closePath() {} rect() {} arc() {} };
    const cv = { ...canvas, getContext: () => rec };
    const sh = sheetWith([[0, 'LINE'], [8, 'WALL'], [10, -30], [20, -20], [11, 30], [21, -20], ...wideAt(40, 4)], true);
    const v = createDxfView(cv, { layers: [{ name: '0', on: true }], paths: sh.paths, texts: sh.texts, extents: sh.extents }, {});
    v.fit();
    globalThis.Path2D = P2;
    const o = [(sh.extents.min[0] + sh.extents.max[0]) / 2, (sh.extents.min[1] + sh.extents.max[1]) / 2];
    const free = strokes.filter((s) => !s.clipped);
    // (the wall on paper y 0, x 0..60: its pieces 0..34 and 40..60, not across the notch)
    const wall = free.filter((s) => s.p.pts.length === 8);
    assert.ok(wall.length > 0, 'the wall\'s edge pieces not stroked unclipped');
    assert.deepEqual(wall[0].p.pts.map((x, i) => Math.round((x + o[i % 2]) * 1e9) / 1e9), [0, 0, 34, 0, 40, 0, 60, 0]);
    // (the width-4 polyline along the outline's top edge, y 40, x 10..50: never stroked unclipped)
    assert.ok(!free.some((s) => s.w === 4), 'a wide polyline stroked unclipped');
    assert.ok(strokes.some((s) => s.clipped && s.w === 4 && s.cap === 'butt'), 'the wide polyline not stroked, clipped, flat-ended');
    v.destroy();
  });
  test('the hover finds a wide polyline on its visible band, though its centreline lies outside the outline (r104 A3)', () => {
    // (width 10 at paper y -3: its band reaches y 2, inside; the cursor at y 1.5)
    const sh = sheetWith(wideAt(-3, 10), true);
    assert.equal(sh.paths.filter((p) => p.layer === 'WIDE').length, 1);
    const v = createDxfView(canvas, { layers: [{ name: '0', on: true }, { name: 'WIDE', on: true }], paths: sh.paths, texts: sh.texts, extents: sh.extents }, {});
    v.fit();
    assert.equal(v.layerAt(...v.toPx(10, 1.5)), 'WIDE', 'on the band the outline shows');
    // (must-reject: at y 3.5, 1.5 past the band's edge and farther than HIT_PX at this zoom)
    assert.equal(v.layerAt(...v.toPx(10, 6)), null, 'past the band');
    v.destroy();
  });
  // (r105: a band is what the canvas strokes -- ends flat, joins mitred up to MITER_LIMIT -- for the
  // keep test, the cull, the extents and the hover; a tapering one's centreline and fills one thing)
  // (paper points: model = paper - (30, 20), as wideAt's)
  const lwAt = (layer, pts, w) => [[0, 'LWPOLYLINE'], [8, layer], [90, pts.length], [70, 0], [43, w], ...pts.flatMap(([x, y]) => [[10, x - 30], [20, y - 20]])];
  const kept = (ents, clipped, layer) => sheetWith(ents, clipped).paths.filter((p) => p.layer === layer).length;
  test('a wide polyline kept by its band as drawn: not by a flat end short of the frame, yes by a mitre\'s tip or a band over its corner (r105 A1, A2, Q10)', () => {
    for (const clipped of [false, true]) {
      const w = clipped ? 'outline' : 'frame';
      // (a flat end 1.5 below the bottom edge, width 4: a round end would reach 0.5 inside)
      assert.equal(kept(lwAt('E', [[10, -20], [10, -1.5]], 4), clipped, 'E'), 0, `a flat end short of the ${w} kept`);
      assert.equal(kept(lwAt('E', [[10, -20], [10, 1]], 4), clipped, 'E'), 1, `a band into the ${w} dropped`);
      // (a V, its vertex 2.5 below, width 4: its mitre's tip 2.83 inside; at width 0.5 1.83 below)
      assert.equal(kept(lwAt('V', [[5, -10], [10, -2.5], [15, -10]], 4), clipped, 'V'), 1, `a mitre's tip inside the ${w} dropped`);
      assert.equal(kept(lwAt('V', [[5, -10], [10, -2.5], [15, -10]], 0.5), clipped, 'V'), 0, `a mitre wholly outside the ${w} kept`);
      // (a band across the corner (0, 0), its centreline 2.12 from it, both ends 15 off: width 6 over
      // it, width 4 not)
      assert.equal(kept(lwAt('C', [[-15, 12], [12, -15]], 6), clipped, 'C'), 1, `a band over the ${w}'s corner dropped`);
      assert.equal(kept(lwAt('C', [[-15, 12], [12, -15]], 4), clipped, 'C'), 0, `a band short of the ${w}'s corner kept`);
    }
  });
  test('a tapering polyline\'s centreline is kept with its band, counted and listed, though the centreline lies outside (r105 A3)', () => {
    const taper = [[0, 'LWPOLYLINE'], [8, 'TAPER'], [90, 2], [70, 0], [10, -20], [20, -21], [40, 4], [41, 6], [10, 20], [20, -21]];
    for (const clipped of [false, true]) {
      const sh = sheetWith(taper, clipped);
      const mine = sh.paths.filter((p) => p.layer === 'TAPER');
      assert.ok(mine.some((p) => p.outline) && mine.some((p) => !p.outline), `${clipped ? 'outline' : 'frame'}: ${mine.map((p) => (p.outline ? 'fill' : 'line')).join(' ')}`);
      assert.equal(openCounts({ paths: mine, texts: [] }, [{ name: 'TAPER', on: true }]).shapes, 1);
    }
    // (must-reject: wholly outside, neither)
    const far = [[0, 'LWPOLYLINE'], [8, 'TAPER'], [90, 2], [70, 0], [10, -20], [20, -30], [40, 4], [41, 6], [10, 20], [20, -30]];
    assert.equal(sheetWith(far, false).paths.filter((p) => p.layer === 'TAPER').length, 0);
  });
  test('the extents of a wide polyline: its mitre\'s tip, its flat ends (r105 A5)', () => {
    const d = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'LWPOLYLINE'], [8, '0'], [90, 3], [70, 0], [43, 4], [10, 0], [20, 10], [10, 5], [20, 2], [10, 10], [20, 10], [0, 'ENDSEC'], [0, 'EOF']]));
    // (the tip 2 / cos(half the turn) below the vertex; the ends' corners 2 * 5 / |(5, 8)| above them)
    const c = Math.sqrt((1 + (25 - 64) / 89) / 2);
    assert.ok(Math.abs(d.extents.min[1] - (2 - 2 / c)) < 1e-9, `min y ${d.extents.min[1]}`);
    assert.ok(Math.abs(d.extents.max[1] - (10 + (2 * 5) / Math.hypot(5, 8))) < 1e-9, `max y ${d.extents.max[1]}`);
  });
  test('the hover on bands as drawn: not past a flat end, inside a tapering one, the visible part of a clipped one, the one on top (r105 A4, A6, Q4, Q7, Q8, Q9)', () => {
    const near = (paths, x, y, r, rank) => nearestSegment(segmentIndex(paths, [0, 0], 30), x, y, r, undefined, rank);
    const wide = { layer: 'W', pts: Float64Array.of(0, 0, 20, 0), width: 10, closed: false };
    // (3 past the flat end, a hairline 0.5 away: the hairline; nothing past it within 2)
    assert.equal(near([wide, { layer: 'H', pts: Float64Array.of(23.5, -10, 23.5, 10), closed: false }], 23, 3, 1), 1, 'past a flat end');
    assert.equal(near([wide], 23, 0, 2), -1, 'empty sheet past a flat end hovered');
    assert.equal(near([wide], 19, 4, 0.1), 0, 'inside the band');
    // (a tapering band, its filled outline: 4 off its centreline, inside it, at r 0.5)
    const fill = { layer: 'T', pts: Float64Array.of(0, -5, 20, -6, 20, 6, 0, 5), closed: true, fill: true, outline: true };
    assert.equal(near([{ layer: 'T', pts: Float64Array.of(0, 0, 20, 0), closed: false }, fill], 10, 4, 0.5), 1, 'inside a tapering band');
    // (through a frame [0, 10]^2: a line whose nearest point is hidden, its visible end 0.3 away, and
    // another 1.8 away; a band whose nearest point is hidden, its visible part 0.4 away)
    const clip = Float64Array.of(0, 0, 10, 0, 10, 10, 0, 10);
    assert.equal(near([{ layer: 'A', pts: Float64Array.of(5, -10, 5, 5), clipPoly: clip }, { layer: 'B', pts: Float64Array.of(0, 1.5, 10, 1.5), clipPoly: clip }], 5, -0.3, 2), 0, 'a line hidden at its nearest point, shown 0.3 away');
    const cband = { layer: 'WIDE', pts: Float64Array.of(-5, -3, 15, -3), width: 10, clipPoly: clip };
    assert.equal(near([cband, { layer: 'B', pts: Float64Array.of(0, 3.5, 10, 3.5), clipPoly: clip }], 5, -0.4, 5), 0, 'a band hidden at the cursor, shown 0.4 away');
    // (outside the band, 0.4 past its edge at y 2, which the frame shows; its centreline hidden)
    assert.equal(near([cband], 5, 2.4, 1), 0, 'a band beside its visible edge');
    assert.equal(near([cband], 5, 3.4, 1), -1, 'past it');
    // (two bands under the cursor: the one on top, the later by default, else by rank)
    const a = { layer: 'A', pts: Float64Array.of(0, 0, 20, 0), width: 10 }, b = { layer: 'B', pts: Float64Array.of(0, 2, 20, 2), width: 10 };
    assert.equal(near([a, b], 5, 1, 1), 1, 'the band underneath');
    assert.equal(near([a, b], 5, 1, 1, (i) => -i), 0, 'not by its rank');
    // (a hairline and a band: the nearer, either way)
    const thin = { layer: 'W', pts: Float64Array.of(0, 0, 20, 0), width: 2 }, hair = { layer: 'H', pts: Float64Array.of(0, 1.5, 20, 1.5) };
    assert.equal(near([thin, hair], 5, 1.6, 1), 1, 'the hairline 0.1 away');
    assert.equal(near([thin, hair], 5, 1.1, 1), 0, 'the band 0.1 away');
  });
  test('the bands\' pieces in short and long trees, as the lines (r105 Q6)', () => {
    const paths = [{ layer: 'B', pts: Float64Array.of(-500, 0, 500, 0), width: 2 }];
    for (let i = 0; i < 50; i++) paths.push({ layer: 'S', pts: Float64Array.of(i, 5, i + 0.5, 5), width: 0.2 });
    const ix = segmentIndex(paths, [0, 0], 100);
    assert.equal(ix.wideLongTree.m, 1);
    assert.equal(ix.wideTree.m, 50);
  });
  await test('a dashed line on its outline\'s edge: the edge pass dashes each piece at its place in the pattern, ends flat (r105 Q5, Q12)', async () => {
    const strokes = [];
    let cur = [];
    const rec = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'beginPath' ? () => { cur = []; } : k === 'moveTo' || k === 'lineTo' ? (x, y) => cur.push(x, y) : k === 'stroke' ? (p) => strokes.push({ pts: p ? null : cur, off: t.lineDashOffset || 0, cap: t.lineCap }) : k === 'measureText' ? () => ({ width: 0 }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
    const P2 = globalThis.Path2D;
    globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} };
    const box = Float64Array.of(0, 0, 60, 0, 60, 40, 0, 40);
    const line = { layer: '0', colour: aciColour(7), fill: false, closed: false, dash: [3, 2], pts: Float64Array.of(-11, 0, 70, 0), clipPoly: box, clip: [0, 0, 60, 40] };
    const v = createDxfView({ ...canvas, getContext: () => rec }, { layers: [{ name: '0', on: true }], paths: [line], texts: [], extents: { min: [-11, 0], max: [70, 40] } }, {});
    v.fit();
    globalThis.Path2D = P2;
    const piece = strokes.find((s) => s.pts && s.pts.length === 4);
    assert.ok(piece, 'the edge piece not stroked on its own');
    // (it starts 11 along the line: x 0, relative to the middle o = 29.5)
    assert.equal(piece.off, 11);
    assert.deepEqual(piece.pts.map((x, i) => x + [29.5, 20][i % 2]), [0, 0, 60, 0]);
    assert.equal(piece.cap, 'butt');
    v.destroy();
  });
  // (r106: what reads the band -- the hover with what is drawn over a band, the picture, the budget)
  const quiet = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? (s) => ({ width: 60 * s.length }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const col = { r: 0, g: 0, b: 0, aci: 7 };
  test('under the cursor in a band, a line drawn over it within reach, or a text over it, is what is found (r106 A1)', () => {
    const near = (paths, x, y, r, rank) => nearestSegment(segmentIndex(paths, [0, 0], 30), x, y, r, undefined, rank);
    const wall = { layer: 'WALL', pts: Float64Array.of(0, 0, 20, 0), width: 10 }, dim = { layer: 'DIM', pts: Float64Array.of(0, 1, 20, 1) };
    assert.equal(near([wall, dim], 5, 1.2, 1), 1, 'the line drawn over the band');
    assert.equal(near([dim, wall], 5, 1.2, 1), 1, 'the band drawn over the line');
    assert.equal(near([wall, dim], 5, 3.5, 1), 0, 'the band, the line out of reach');
    // (a text inside a band: the texts are drawn over every path)
    const band = { layer: 'ROAD', pts: Float64Array.of(0, 0, 100, 0), width: 10, closed: false, colour: col };
    const text = { text: 'MAIN ST', x: 40, y: -1.5, h: 3, rot: 0, align: 'left', layer: 'LABELS', colour: col };
    const v = createDxfView({ ...canvas, getContext: () => quiet }, { layers: [{ name: 'ROAD', on: true }, { name: 'LABELS', on: true }], paths: [band], texts: [text], extents: { min: [0, -5], max: [100, 5] } }, {});
    v.fit();
    assert.equal(v.layerAt(...v.toPx(45, 0)), 'LABELS', 'the text inside the band');
    assert.equal(v.layerAt(...v.toPx(80, 0)), 'ROAD', 'the band past the text');
    v.destroy();
  });
  test('the pointer gone from the canvas, the hover goes with it: the picture is drawn without it (r106 A2)', () => {
    const on = {}, widths = [];
    const rec = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'stroke' ? () => widths.push(t.lineWidth) : k === 'measureText' ? () => ({ width: 0 }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
    const A = { layer: 'A', pts: Float64Array.of(0, 0, 100, 0), closed: false, colour: col };
    const v = createDxfView({ ...canvas, getContext: () => rec, addEventListener(k, f) { on[k] = f; } }, { layers: [{ name: 'A', on: true }], paths: [A], texts: [], extents: { min: [0, 0], max: [100, 50] } }, {});
    const [px, py] = v.toPx(50, 0);
    on.pointermove({ pointerId: 1, clientX: px, clientY: py });
    widths.length = 0; v.draw();
    assert.ok(Math.abs(widths[0] * v.scale - 2) < 1e-9, `hovered: ${widths[0] * v.scale} px`);
    assert.ok(on.pointerleave, 'no pointerleave');
    on.pointerleave({ pointerId: 1 });
    widths.length = 0; v.draw();
    assert.ok(Math.abs(widths[0] * v.scale - 1) < 1e-9, `after the pointer left: ${widths[0] * v.scale} px`);
    v.destroy();
  });
  // (a sheet of n clipped viewports, each a ring of m points, over model paths `ents`)
  const clippedSheet = (ents, n, m, at = [0, 0]) => {
    const g = [[0, 'SECTION'], [2, 'ENTITIES'], ...ents];
    for (let v = 0; v < n; v++) {
      const ring = Array.from({ length: m }, (_, i) => [500 + 10 * Math.cos((2 * Math.PI * i) / m), 500 + 10 * Math.sin((2 * Math.PI * i) / m)]);
      g.push([0, 'LWPOLYLINE'], [5, `C${v}`], [8, 'B'], [67, 1], [90, m], [70, 1], ...ring.flatMap(([x, y]) => [[10, x], [20, y]]));
      g.push([0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 500], [20, 500], [40, 20], [41, 20], [69, v + 2], [12, at[0]], [22, at[1]], [45, 20], [90, 65536], [340, `C${v}`]);
    }
    return dxf([...g, [0, 'ENDSEC'], [0, 'EOF']]);
  };
  test('a tapering polyline the viewport\'s cull passes over costs its budget nothing (r106 A3)', () => {
    // (10,000 tapering polylines far outside 10 viewports of 20 points: they open, as at one width)
    const far = [];
    for (let k = 0; k < 10000; k++) far.push([0, 'LWPOLYLINE'], [8, 'T'], [90, 2], [70, 0], [10, 1000 + k], [20, 1000], [40, 2], [41, 0], [10, 1001 + k], [20, 1000]);
    const d = parseDXF(clippedSheet(far, 10, 20));
    assert.equal(d.paths.filter((p) => p.layer === 'T').length, 20000);
    assert.equal(d.layouts[0].paths.filter((p) => p.layer === 'T').length, 0);
  });
  test('a wide polyline tested as its band is charged its band\'s points: refused in time, not run long (r106 A4)', () => {
    // (a zigzag of 20,000 points through a 407-point outline, its centreline wholly outside it: as a
    // line it opens; as a band, tested piece by piece, its pieces are charged, and it is refused)
    // (in the viewport's box, x 8..28 at y 9: 12 or more from the circle's middle, its radius 10)
    const zig = (w) => { const g = [[0, 'LWPOLYLINE'], [8, 'Z'], [90, 20000], [70, 0], [43, w]]; for (let i = 0; i < 20000; i++) g.push([10, 8 + i * 0.001], [20, 9 + (i % 2) * 0.001]); return g; };
    assert.ok(parseDXF(clippedSheet(zig(0), 1, 407)).layouts.length, 'the line refused');
    assert.throws(() => parseDXF(clippedSheet(zig(0.5), 1, 407)), /too large to draw here/);
  });
  test('a wide polyline in the hover\'s index: its segments and half width, not a polygon a piece (r106 A5)', () => {
    const pts = new Float64Array(2002);
    for (let i = 0; i <= 1000; i++) { pts[2 * i] = i; pts[2 * i + 1] = i % 2; }
    const ix = segmentIndex([{ layer: 'W', pts, width: 0.5 }], [0, 0], 1000);
    assert.equal(ix.wsegs.length, 4000);
    assert.equal(ix.bxy.length, 0);
    // (and its joins found when asked: inside the mitre at (1, 1), outside both rectangles)
    const c = Math.sqrt((1 + 0) / 2);
    assert.equal(nearestSegment(ix, 1, 1 + 0.25 / c - 0.01, 0.001), 0, 'the mitre\'s tip');
    assert.equal(nearestSegment(ix, 1, 1 + 0.25 / c + 0.01, 0.001), -1, 'past the mitre\'s tip');
  });
  test('the pieces of a line through an outline\'s vertex: none before it (r106 Q2)', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let bad = 0;
    for (let t = 0; t < 20000; t++) {
      const x0 = rnd() * 10, y0 = rnd() * 10, x1 = x0 + 1 + rnd() * 10, y1 = y0 + 1 + rnd() * 10;
      const f = Float64Array.of(x0, y0, x1, y0, x1, y1, x0, y1);
      const dx = 0.2 + rnd(), dy = 0.2 + rnd();
      const pc = insidePieces(f, x0 - dx * 3, y0 - dy * 3, x0 + dx * 3, y0 + dy * 3);
      if (pc.length && pc[0] < 0.5 - 1e-9) bad++;
    }
    assert.equal(bad, 0, `${bad} of 20000 lines through a frame's corner have a piece before it`);
  });
  test('the hover through an outline: a band\'s visible part 0.4 away beats a line 1.0 away; an exact tie, the one on top (r106 Q7, Q8)', () => {
    const near = (paths, x, y, r, rank) => nearestSegment(segmentIndex(paths, [0, 0], 30), x, y, r, undefined, rank);
    const clip = Float64Array.of(0, 0, 10, 0, 10, 10, 0, 10);
    const cband = { layer: 'WIDE', pts: Float64Array.of(-5, -3, 15, -3), width: 10, clipPoly: clip };
    assert.equal(near([cband, { layer: 'B', pts: Float64Array.of(0, 0.6, 10, 0.6), clipPoly: clip }], 5, -0.4, 5), 0, 'the band hidden at the cursor, shown 0.4 away');
    // (a band's edge at y 1 and a line at y 3, the cursor at y 2: both 1 away)
    const band = { layer: 'W', pts: Float64Array.of(0, 0, 20, 0), width: 2 }, line = { layer: 'H', pts: Float64Array.of(0, 3, 20, 3) };
    assert.equal(near([band, line], 5, 2, 2), 1, 'the later, the line');
    assert.equal(near([band, line], 5, 2, 2, (i) => -i), 0, 'the earlier by rank, the band');
  });
  await test('a dashed line of several segments on its outline\'s edge: each piece at its length along it (r106 Q9)', async () => {
    const strokes = [];
    let cur = [];
    const rec = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'beginPath' ? () => { cur = []; } : k === 'moveTo' || k === 'lineTo' ? (x, y) => cur.push(x, y) : k === 'stroke' ? (p) => strokes.push({ pts: p ? null : cur, off: t.lineDashOffset || 0 }) : k === 'measureText' ? () => ({ width: 0 }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
    const P2 = globalThis.Path2D;
    globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} };
    const box = Float64Array.of(0, 0, 60, 0, 60, 40, 0, 40);
    const line = { layer: '0', colour: col, fill: false, closed: false, dash: [3, 2], pts: Float64Array.of(-11, 0, 20, 0, 70, 0), clipPoly: box, clip: [0, 0, 60, 40] };
    const v = createDxfView({ ...canvas, getContext: () => rec }, { layers: [{ name: '0', on: true }], paths: [line], texts: [], extents: { min: [-11, 0], max: [70, 40] } }, {});
    v.fit();
    globalThis.Path2D = P2;
    const r9 = (x) => Math.round(x * 1e9) / 1e9;
    const pieces = strokes.filter((s) => s.pts && s.pts.length === 4).map((s) => [r9(s.pts[0] + 29.5), r9(s.pts[2] + 29.5), r9(s.off)]);
    // (a draw's two pieces: the view draws as it is made, and again at fit)
    assert.deepEqual(pieces.slice(0, 2), [[0, 20, 11], [20, 60, 31]]);
    v.destroy();
  });
  test('a large outline asked through its grid: the same answers as inOutline and insidePieces, and the hover uses it (r106 Q5)', () => {
    // (a 400-point star with a notch-like inner ring: points inside, outside, on its edges and
    // vertices; segments across it, along its edges and through its vertices)
    const M = 400, f = new Float64Array(2 * M);
    for (let i = 0; i < M; i++) { const a = (2 * Math.PI * i) / M, rr = i % 2 ? 60 : 100; f[2 * i] = rr * Math.cos(a); f[2 * i + 1] = rr * Math.sin(a); }
    const g = outlineIndex(f);
    let seed = 5;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 240 - 120;
    let bad = 0;
    for (let k = 0; k < 3000; k++) {
      const x = rnd(), y = rnd();
      if (g.inside(x, y) !== inOutline(f, x, y)) bad++;
      const v = 2 * (k % M), w = 2 * ((k * 7) % M);
      for (const [px, py] of [[f[v], f[v + 1]], [(f[v] + f[(v + 2) % (2 * M)]) / 2, (f[v + 1] + f[(v + 3) % (2 * M)]) / 2]]) if (g.inside(px, py) !== inOutline(f, px, py)) bad++;
      const segs = [[x, y, rnd(), rnd()], [f[v], f[v + 1], f[w], f[w + 1]], [x, y, f[v], f[v + 1]]];
      for (const [ax, ay, bx, by] of segs) if (JSON.stringify(g.pieces(ax, ay, bx, by)) !== JSON.stringify(insidePieces(f, ax, ay, bx, by))) bad++;
    }
    assert.equal(bad, 0, `${bad} answers differ`);
    // (the hover's index makes it for an outline this large, and finds what the plain test finds)
    const ix = segmentIndex([{ layer: 'L', pts: Float64Array.of(50, -5, 50, 5), clipPoly: f }], [0, 0], 300);
    assert.equal(nearestSegment(ix, 50.5, 0, 1), 0);
    assert.equal(ix.geo.size, 1);
  });
  test('a wide polyline\'s band: a closed one\'s first join, a repeated point skipped (r106 Q10, Q11)', () => {
    const near = (p, x, y) => nearestSegment(segmentIndex([p], [0, 0], 30), x, y, 0.001);
    // (a closed square, width 2: (-0.5, -0.5) lies in the mitre at its first point alone)
    assert.equal(near({ layer: 'S', pts: Float64Array.of(0, 0, 10, 0, 10, 10, 0, 10), width: 2, closed: true }, -0.5, -0.5), 0, 'the first join');
    assert.equal(near({ layer: 'S', pts: Float64Array.of(0, 0, 10, 0, 10, 10, 0, 10), width: 2, closed: false }, -0.5, -0.5), -1, 'an open one has none');
    // (and in bandPolys, which the keep test, the cull and the extents read)
    assert.ok(bandPolys(Float64Array.of(0, 0, 10, 0, 10, 10, 0, 10), true, 1).some((q) => insideFlat(q, -0.5, -0.5)), 'bandPolys: no first join');
    // (a repeated point at the corner (10, 0): its mitre still there)
    const rep = { layer: 'R', pts: Float64Array.of(0, 0, 10, 0, 10, 0, 10, 10), width: 2 };
    assert.equal(near(rep, 10.5, -0.5), 0, 'the mitre at a repeated point');
    assert.ok(bandPolys(rep.pts, false, 1).every((q) => q.every(Number.isFinite)), 'a piece not a number');
  });
  // (r107: the pick order -- js/dxf-view.js pickAt, one rule -- a pair of kinds an arm: what is drawn
  // on top at the cursor, lines counted within reach)
  {
    const clip = Float64Array.of(0, 0, 10, 0, 10, 10, 0, 10);
    // (a drawing of `items`, each [kind, ...]; rank: their order, later on top, texts over every path)
    const pick = (items, x, y, r = 1) => {
      const paths = [], texts = [], name = [];
      for (const it of items) {
        if (it[0] === 'text') { texts.push(it[1]); continue; }
        paths.push(it[1]);
      }
      const ix = segmentIndex(paths, [0, 0], 30);
      const tix = textIndex(texts, (t) => [[t.x0, t.y0], [t.x1, t.y0], [t.x0, t.y1], [t.x1, t.y1]], [0, 0]);
      const h = pickAt(ix, x, y, r, { texts: { index: tix, accept: () => true } });
      return !h ? null : h.text !== undefined ? texts[h.text].layer : paths[h.path].layer;
    };
    const line = (layer, ...pts) => ['line', { layer, pts: Float64Array.of(...pts) }];
    const band = (layer, w, ...pts) => ['band', { layer, width: w, pts: Float64Array.of(...pts) }];
    const fill = (layer, ...pts) => ['fill', { layer, fill: true, closed: true, pts: Float64Array.of(...pts) }];
    const edge = (layer) => ['edge', { layer, pts: Float64Array.of(0, 0, 10, 0), clipPoly: clip }];
    const text = (layer, x0, y0, x1, y1) => ['text', { layer, x0, y0, x1, y1 }];
    const sq = (l, x0, y0, x1, y1) => fill(l, x0, y0, x1, y0, x1, y1, x0, y1);
    test('pick order: a text under the cursor over a line, a band, a fill or an edge piece within reach (r107 A2)', () => {
      assert.equal(pick([line('L', 0, 1, 10, 1), text('T', 2, 1.5, 8, 3)], 5, 2), 'T', 'text/line');
      assert.equal(pick([line('L', 0, 1, 10, 1), text('T', 2, 1.5, 8, 3)], 5, 1.2), 'L', 'the line, the cursor off the text');
      assert.equal(pick([band('B', 4, 0, 0, 10, 0), text('T', 2, -1, 8, 1)], 5, 0), 'T', 'text/band');
      assert.equal(pick([band('B', 2, 0, 0, 10, 0), text('T', 2, 1.6, 8, 3)], 5, 1.5), 'B', 'the band, the cursor off the text');
      assert.equal(pick([sq('F', 0, 0, 10, 10), text('T', 2, 2, 8, 3)], 5, 2.5), 'T', 'text/fill');
      assert.equal(pick([edge('E'), text('T', 2, 0.5, 8, 2)], 5, 1), 'T', 'text/edge');
    });
    test('pick order: lines, bands and fills, the one drawn on top, a line counted within reach (r107 A1, A3, A5)', () => {
      // (line/band: within reach over the band, the line; under it, the band -- and a line under the
      // band nearer than one over it does not hide the one over it, r107 A5)
      assert.equal(pick([band('B', 10, 0, 0, 10, 0), line('L', 0, 1, 10, 1)], 5, 0.5), 'L', 'a line over a band');
      assert.equal(pick([line('L', 0, 1, 10, 1), band('B', 10, 0, 0, 10, 0)], 5, 0.5), 'B', 'a band over a line');
      assert.equal(pick([line('C', 0, 0.3, 10, 0.3), band('B', 10, 0, 0, 10, 0), line('L', 0, 1.2, 10, 1.2)], 5, 0.4), 'L', 'the line over the band, one under it nearer');
      // (line/fill: inside a SOLID, it; a fill over a line, the fill; a line over a fill, the line)
      assert.equal(pick([sq('F', 0, 0, 10, 10)], 5, 5), 'F', 'inside a SOLID');
      assert.equal(pick([line('L', 0, 5, 10, 5), sq('F', 0, 0, 10, 10)], 5, 5.5), 'F', 'a fill over a line');
      assert.equal(pick([sq('F', 0, 0, 10, 10), line('L', 0, 5, 10, 5)], 5, 5.5), 'L', 'a line over a fill');
      // (band/fill, both ways)
      assert.equal(pick([band('B', 4, 0, 5, 10, 5), sq('F', 0, 0, 10, 10)], 5, 5), 'F', 'a fill over a band');
      assert.equal(pick([sq('F', 0, 0, 10, 10), band('B', 4, 0, 5, 10, 5)], 5, 5), 'B', 'a band over a fill');
      // (one kind at one place: the one on top)
      assert.equal(pick([line('A', 0, 0, 10, 0), line('B', 0, 0, 10, 0)], 5, 0.5), 'B', 'coincident lines');
      assert.equal(pick([band('A', 2, 0, 0, 10, 0), band('B', 2, 0, 0, 10, 0)], 5, 1.5), 'B', 'coincident bands, the cursor outside');
      assert.equal(pick([text('A', 0, 0, 4, 2), text('B', 0, 0, 4, 2)], 1, 1), 'B', 'two texts at one place');
      // (an even-odd hatch's loops filled together: its ring, it; its hole, nothing)
      const ring = { layer: 'H', fill: true, closed: true, evenodd: 7, pts: Float64Array.of(0, 0, 10, 0, 10, 10, 0, 10) };
      const hole = { layer: 'H', fill: true, closed: true, evenodd: 7, pts: Float64Array.of(3, 3, 7, 3, 7, 7, 3, 7) };
      assert.equal(pick([['fill', ring], ['fill', hole]], 1.5, 5, 0.5), 'H', 'in the ring');
      assert.equal(pick([['fill', ring], ['fill', hole]], 5, 5, 0.5), null, 'in the hole');
    });
    test('pick order: a line\'s piece along its outline\'s edge is drawn over every group: over a band, a fill or a line (r107 A4)', () => {
      // (the edge piece's path first in the draw, the other later: the edge pass strokes the piece last)
      assert.equal(pick([edge('E'), band('B', 2, 0, 0, 10, 0)], 5, 0.1), 'E', 'band/edge');
      assert.equal(pick([edge('E'), sq('F', 0, -1, 10, 1)], 5, 0.1), 'E', 'fill/edge');
      assert.equal(pick([edge('E'), line('L', 0, 0, 10, 0)], 5, 0.5), 'E', 'line/edge');
      // (and a part of it not on the edge is drawn in its group's place: under the later band)
      const cross = ['line', { layer: 'X', pts: Float64Array.of(5, 0, 5, 10), clipPoly: clip }];
      assert.equal(pick([cross, band('B', 2, 0, 5, 10, 5)], 5.1, 5), 'B', 'off the edge, in its place');
    });
  }
  test('a model text outside a viewport is passed over by its box: 20,000 texts through 100 viewports open fast (r107 Q2)', () => {
    const g = [[0, 'SECTION'], [2, 'ENTITIES']];
    for (let k = 0; k < 20000; k++) g.push([0, 'TEXT'], [8, 'T'], [10, 1000 + k], [20, 1000], [40, 1], [1, 'LABEL']);
    for (let v = 0; v < 100; v++) g.push([0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 50], [40, 20], [41, 20], [69, v + 2], [12, 0], [22, 0], [45, 20]);
    const t0 = performance.now();
    const d = parseDXF(dxf([...g, [0, 'ENDSEC'], [0, 'EOF']]));
    const ms = performance.now() - t0;
    assert.equal(d.layouts[0].texts.length, 0);
    assert.ok(ms < 4000, `${ms.toFixed(0)} ms (12.3 s before)`);
  });
  test('a large outline\'s grid: an edge in the cells it crosses, the hover asking it for the edges near (r107 Q3 to Q6)', () => {
    // (a hub and spokes, 32,000 points: by its box every spoke was in every cell of it)
    const M = 32000, f = new Float64Array(2 * M);
    for (let i = 0; i < M; i++) { const a = (2 * Math.PI * Math.floor(i / 2)) / (M / 2), rr = i % 2 ? 100 : 1; f[2 * i] = rr * Math.cos(a); f[2 * i + 1] = rr * Math.sin(a); }
    const g = outlineIndex(f);
    // (a spoke 100 long crosses some 45 of the grid's 90 columns, a column either side kept: at most
    // 3 x (the grid's side + 2) cells an edge, not its box's side squared)
    const side = Math.sqrt(g.cells);
    assert.ok(g.entries <= 3 * (side + 2) * M, `${g.entries} cell entries for ${M} edges, a ${side}-cell side`);
    assert.ok(g.cells > 1, 'one cell');
    // (points within the edge tolerance of an edge, either side of cell boundaries: the same answer)
    const star = new Float64Array(800);
    for (let i = 0; i < 400; i++) { const a = (2 * Math.PI * i) / 400, rr = i % 2 ? 60 : 100; star[2 * i] = rr * Math.cos(a); star[2 * i + 1] = rr * Math.sin(a); }
    const gs = outlineIndex(star);
    let bad = 0;
    for (let e = 0; e < 400; e++) {
      const j = ((e + 399) % 400) * 2, i = e * 2, dx = star[i] - star[j], dy = star[i + 1] - star[j + 1], L = Math.hypot(dx, dy);
      for (const t of [0.001, 0.25, 0.5, 0.999]) for (const off of [-1e-10, 1e-10, 1e-6]) {
        const px = star[j] + t * dx - (dy / L) * off, py = star[j + 1] + t * dy + (dx / L) * off;
        if (gs.inside(px, py) !== inOutline(star, px, py)) bad++;
      }
    }
    assert.equal(bad, 0, `${bad} near-edge answers differ`);
    // (a notch whose top edge lies on a row's boundary, y 60 of a 5-row grid of rows 20 high, and a
    // point in the notch 1e-10 below it, the row beneath: on the edge, shown -- asked of its own
    // cell, not)
    const nb = [[0, 0], [40, 0], [40, 60], [60, 60], [60, 0], [100, 0]];
    for (let k = 1; k <= 60; k++) nb.push([100, (100 * k) / 60]);
    nb.push([0, 100]);
    const notched = Float64Array.from(nb.flat()), gn = outlineIndex(notched);
    assert.equal(gn.cells, 25);
    assert.equal(inOutline(notched, 50, 60 - 1e-10), true);
    assert.equal(gn.inside(50, 60 - 1e-10), true, 'on the notch\'s edge across a row boundary');
    assert.equal(gn.inside(50, 59), false, 'in the notch');
    // (the hover asks the grid -- inside, pieces, the edges near -- not the plain walks)
    // (a band across the star's tip at (0, 100), the cursor in it beyond the tip: hidden there, its
    // visible part is asked for)
    const ix = segmentIndex([{ layer: 'W', pts: Float64Array.of(0, 90, 0, 110), width: 4, clipPoly: star }], [0, 0], 300);
    nearestSegment(ix, 1.5, 104, 3); // (makes the grid)
    const [gg] = [...ix.geo.values()], asked = { inside: 0, pieces: 0, near: 0 };
    for (const k of Object.keys(asked)) { const fn = gg[k]; gg[k] = (...a) => { asked[k]++; return fn(...a); }; }
    // (its visible part ends at the tip, 4.27 away)
    assert.equal(nearestSegment(ix, 1.5, 104, 5), 0, 'the band\'s visible part within reach');
    assert.equal(nearestSegment(ix, 1.5, 104, 4), -1, 'nothing nearer');
    assert.ok(asked.inside > 0 && asked.near > 0 && asked.pieces > 0, JSON.stringify(asked));
  });
  test('a wide polyline whose centreline the outline shows is kept without its pieces charged (r107 Q7)', () => {
    // (a 20,000-point zigzag inside the 407-point circle: as a line it is charged 8.1 M of 10 M; its
    // pieces charged too, it was refused)
    const g = [[0, 'LWPOLYLINE'], [8, 'Z'], [90, 20000], [70, 0], [43, 0.5]];
    for (let i = 0; i < 20000; i++) g.push([10, -5 + i * 0.0005], [20, (i % 2) * 0.001]);
    const d = parseDXF(clippedSheet(g, 1, 407));
    assert.equal(d.layouts[0].paths.filter((p) => p.layer === 'Z').length, 1);
  });
  test('a wide polyline drawn as a hairline -- thinner than its px, its layer\'s weight -- on its outline\'s edge is stroked again unclipped; one drawn at its width is not (r110 F1)', () => {
    const run = (path) => {
      const strokes = [], stack = [];
      const rec = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'clip' ? () => { if (stack.length) stack[stack.length - 1] = true; } : k === 'stroke' ? (p) => strokes.push({ p, clipped: stack.some(Boolean), w: t.lineWidth }) : k === 'fill' ? (p) => { if (p) fills.push({ clipped: stack.some(Boolean) }); } : k === 'save' ? () => stack.push(false) : k === 'restore' ? () => stack.pop() : k === 'measureText' ? () => ({ width: 0 }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
      const P2 = globalThis.Path2D;
      globalThis.Path2D = class { constructor() { this.pts = []; } moveTo(x, y) { this.pts.push(x, y); } lineTo(x, y) { this.pts.push(x, y); } closePath() {} };
      const box = Float64Array.of(0, 0, 60, 0, 60, 40, 0, 40);
      const p = { layer: 'W', colour: col, fill: false, closed: false, dash: null, clipPoly: box, clip: [0, 0, 60, 40], pts: Float64Array.of(10, 0, 50, 0), ...path };
      const v = createDxfView({ ...canvas, getContext: () => rec }, { layers: [{ name: 'W', on: true }], paths: [p], texts: [], extents: { min: [-5, -5], max: [65, 45] } }, {});
      strokes.length = 0;
      fills.length = 0;
      v.draw();
      globalThis.Path2D = P2;
      v.destroy();
      return strokes.filter((x) => x.p && !x.clipped).length;
    };
    const fills = [];
    assert.equal(run({ width: 0.05, weight: 0.35 }), 1, 'a 0.05 band under a 0.35 mm weight, drawn 1.4 px');
    assert.equal(run({ width: 0.05 }), 1, 'a 0.05 band drawn 1 px');
    assert.equal(run({ width: 4 }), 0, 'a band at its width');
    // (r110 pair 1e: a fill whose border lies on the outline's edge is filled inside the clip, to
    // the edge, and its border is not stroked again onto the sheet -- F3, low, kept)
    assert.equal(run({ fill: true, closed: true, pts: Float64Array.of(10, 0, 50, 0, 50, 20, 10, 20) }), 0, 'a fill\'s border on the edge');
    assert.ok(fills.length >= 1 && fills.every((f) => f.clipped), `the fill drawn, clipped: ${JSON.stringify(fills)}`);
  });
  test('a text is drawn with its capitals its height, and an MTEXT\'s lines 5/3 heights apart times its 44 (r113 R2-F1, F2)', () => {
    const draw = (t) => {
      const scales = [], texts = [];
      const rec = new Proxy({}, { get: (o, k) => (k in o ? o[k] : k === 'scale' ? (a, b) => scales.push([a, b]) : k === 'fillText' ? (s, x, y) => texts.push([s, x, y]) : k === 'measureText' ? () => ({ width: 0 }) : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
      const v = createDxfView({ ...canvas, getContext: () => rec }, { layers: [{ name: 'T', on: true }], paths: [], texts: [{ layer: 'T', colour: col, x: 0, y: 0, rot: 0, align: 'left', valign: 'top', ...t }], extents: { min: [0, -40], max: [60, 20] } }, {});
      scales.length = 0; texts.length = 0;
      v.draw();
      v.destroy();
      return { k: scales.find(([a, b]) => b === -a), texts };
    };
    // (the em set so its capitals, TEXT_CAP of it, are the height: 10 / 0.72; it was the height)
    const one = draw({ text: 'HHH', h: 10 });
    assert.ok(Math.abs(one.k[0] * 100 * TEXT_CAP - 10) < 1e-9, `scale ${one.k}`);
    // (three lines of a 44 of 2: 10 * 5/3 * 2 apart, in drawing units)
    const three = draw({ text: 'A\nB\nC', h: 10, mtext: true, lineSpacing: 2 });
    const dy = (three.texts[1][2] - three.texts[0][2]) * three.k[0];
    assert.ok(Math.abs(dy - 10 * 5 / 3 * 2) < 1e-9, `pitch ${dy}`);
    // and the reader takes 44, clamped to 0.25..4; without it 1
    const mt = (g) => parseDXF(ents([[0, 'MTEXT'], [8, '0'], [10, 0], [20, 0], [40, 10], ...g, [1, 'A\\PB']])).texts[0];
    assert.equal(mt([[44, 2]]).lineSpacing, 2);
    assert.equal(mt([[44, 9]]).lineSpacing, 4);
    assert.equal(mt([]).lineSpacing, undefined);
    assert.equal(pitchOf(mt([[44, 2]])), 10 * 5 / 3 * 2);
    assert.equal(emOf({ h: 7.2 }), 10);
  });
  // (r114 M3 dxf-view-C112) an MTEXT hangs from its point (top), is centred on it (middle), stands on
  // it (bottom): a two-line MTEXT's first row at 0 / -H/2 / -H, H = (rows - 1) pitch + the 100 px font
  test('a two-line MTEXT attached top / middle / bottom has its first row at 0 / -H/2 / -H (r114 M3 dxf-view-C112)', () => {
    const rows = (valign) => {
      const texts = [];
      const rec = new Proxy({}, { get: (o, k) => (k in o ? o[k] : k === 'fillText' ? (s, x, y) => texts.push([s, y]) : k === 'measureText' ? () => ({ width: 0 }) : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
      const v = createDxfView({ ...canvas, getContext: () => rec }, { layers: [{ name: 'T', on: true }], paths: [], texts: [{ layer: 'T', colour: col, x: 0, y: 0, rot: 0, align: 'left', valign, text: 'A\nB', h: 10, mtext: true }], extents: { min: [0, -40], max: [60, 20] } }, {});
      texts.length = 0;
      v.draw();
      v.destroy();
      assert.deepEqual(texts.map((t) => t[0]), ['A', 'B'], valign);
      return texts.map((t) => t[1]);
    };
    const top = rows('top'), middle = rows('middle'), bottom = rows('bottom');
    const lh = top[1] - top[0], H = lh + 100;
    assert.ok(lh > 0, `pitch ${lh}`);
    assert.ok(Math.abs(top[0]) < 1e-9, `top ${top}`);
    assert.ok(Math.abs(middle[0] + H / 2) < 1e-9, `middle ${middle} (H ${H})`);
    assert.ok(Math.abs(bottom[0] + H) < 1e-9, `bottom ${bottom} (H ${H})`);
    for (const r of [middle, bottom]) assert.ok(Math.abs(r[1] - r[0] - lh) < 1e-9, 'one pitch');
  });
  // (r114 M3 dxf-view-B139) one pointer pressed and moved pans the 2D view by the move: pressed at
  // (400, 300) and moved to (500, 350), the drawing's corner moves (100, 50) px on the canvas
  test('a one-pointer drag on the 2D view from (400, 300) to (500, 350) moves toPx(0, 0) by (100, 50) (r114 M3 dxf-view-B139)', () => {
    const on = {};
    const v = createDxfView({ ...canvas, addEventListener: (k, f) => { on[k] = f; }, setPointerCapture() {} }, { layers: [{ name: 'L', on: true }], paths: [{ layer: 'L', colour: col, pts: Float64Array.of(0, 0, 60, 0, 60, 60, 0, 60), closed: true }], texts: [], extents: { min: [0, 0], max: [60, 60] } }, {});
    const before = v.toPx(0, 0);
    const ev = (x, y) => ({ pointerId: 1, clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() {} });
    on.pointerdown(ev(400, 300));
    on.pointermove(ev(450, 325));
    on.pointermove(ev(500, 350));
    on.pointerup(ev(500, 350));
    const after = v.toPx(0, 0);
    v.destroy();
    assert.ok(Math.abs(after[0] - before[0] - 100) < 1e-6 && Math.abs(after[1] - before[1] - 50) < 1e-6, `${before} -> ${after}`);
  });
  Object.assign(globalThis, saved);
  for (const k of Object.keys(saved)) if (saved[k] === undefined) delete globalThis[k];
}
// (r70 Q6: 2D Measure's centre, with its Ø, only for what the reader drew from a circle)
test('2D Measure snaps to a curve\'s own points: an arc\'s ends and its middle on the arc, a bulged polyline\'s vertices, straight middles and arc middle -- never a chord\'s (r113 R2-F3)', () => {
  const snaps = (g) => { const d = parseDXF(ents(g)); const sp = snapPoints(d.paths, [0, 0]); const s = []; for (let i = 0; i < sp.n; i++) if (sp.kind[i] < 2) s.push(`${sp.kind[i] ? 'mid' : 'end'} ${sp.xy[2 * i].toFixed(4)} ${sp.xy[2 * i + 1].toFixed(4)}`); return s.sort(); };
  // (an arc of r 1000, 0 to 85 degrees -- 17 steps of 5 degrees, made 18: three snaps, the middle at
  // 42.5 degrees on the arc)
  const at = (deg) => [1000 * Math.cos((deg * Math.PI) / 180), 1000 * Math.sin((deg * Math.PI) / 180)].map((v) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4)).join(' ');
  assert.deepEqual(snaps([[0, 'ARC'], [8, '0'], [10, 0], [20, 0], [40, 1000], [50, 0], [51, 85]]),
    [`end ${at(0)}`, `end ${at(85)}`, `mid ${at(42.5)}`].sort());
  // (a circle: no end and no middle -- its centre, kind 2, is its snap)
  assert.deepEqual(snaps([[0, 'CIRCLE'], [8, '0'], [10, 0], [20, 0], [40, 5]]), []);
  // (an open polyline (0,0)-(10,0) then a half circle bulge to (10,10): three vertices, the straight
  // segment's middle, the arc's middle at (15, 5) on it)
  assert.deepEqual(snaps([[0, 'LWPOLYLINE'], [8, '0'], [90, 3], [70, 0], [10, 0], [20, 0], [10, 10], [20, 0], [42, 1], [10, 10], [20, 10]]),
    ['end 0.0000 0.0000', 'end 10.0000 0.0000', 'end 10.0000 10.0000', 'mid 15.0000 5.0000', 'mid 5.0000 0.0000']);
  // (r114 R4-M1: a closed curve with no ends -- a whole ellipse, a circle through a stretching
  // insert, a closed spline -- its four extreme points on the curve, and the ellipse's and the
  // stretched circle's centre with no Ø; r113's marks had left them no snap at all)
  const all = (g, extra = []) => { const d = parseDXF(dxf([...extra, [0, 'SECTION'], [2, 'ENTITIES'], ...g, [0, 'ENDSEC'], [0, 'EOF']])); const sp = snapPoints(d.paths, [0, 0]); const s = []; for (let i = 0; i < sp.n; i++) { const a = sp.at(i), f = (v) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3); s.push(`${a[2]} ${f(a[0])} ${f(a[1])}${a[2] === 'centre' ? ` r${a[4]}` : ''}`); } return s.sort(); };
  assert.deepEqual(all([[0, 'ELLIPSE'], [8, '0'], [10, 0], [20, 0], [30, 0], [11, 20], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, 2 * Math.PI]]),
    ['centre 0.000 0.000 r0', 'quadrant -20.000 0.000', 'quadrant 0.000 -10.000', 'quadrant 0.000 10.000', 'quadrant 20.000 0.000']);
  const stretched = all([[0, 'INSERT'], [8, '0'], [2, 'C'], [10, 0], [20, 0], [41, 2], [42, 1]], blocks([[0, 'BLOCK'], [2, 'C'], [10, 0], [20, 0], [0, 'CIRCLE'], [8, '0'], [10, 0], [20, 0], [40, 5], [0, 'ENDBLK']]));
  assert.deepEqual(stretched, ['centre 0.000 0.000 r0', 'quadrant -10.000 0.000', 'quadrant 0.000 -5.000', 'quadrant 0.000 5.000', 'quadrant 10.000 0.000']);
  // (r115 R5-M1: an ellipse's centre seen through a layout viewport is the paper's -- scale 0.5 about
  // model (50, 0) to paper (50, 40): (40, 30) is (45, 55); it stayed (40, 30), where nothing is)
  const vp = parseDXF(dxf([[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'ELLIPSE'], [8, '0'], [10, 40], [20, 30], [30, 0], [11, 10], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, 2 * Math.PI],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 148], [20, 105], [40, 297], [41, 210], [69, 1], [12, 148], [22, 105], [45, 210],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 40], [40, 60], [41, 40], [69, 2], [12, 50], [22, 0], [45, 80], [0, 'ENDSEC'], [0, 'EOF']]));
  const lsp = snapPoints(vp.layouts[0].paths.filter((p) => !p.frame), [0, 0]), lc = [];
  for (let i = 0; i < lsp.n; i++) if (lsp.at(i)[2] === 'centre') lc.push(lsp.at(i).slice(0, 2).map((v) => +v.toFixed(6)));
  assert.deepEqual(lc, [[45, 55]]);
  // (r115 R5-M2: a circle's quadrants are its own, exact -- turned 2.5 degrees by its insert, the
  // nearest 5-degree sample was 4.36 off on a radius of 100)
  const turned = all([[0, 'INSERT'], [8, '0'], [2, 'R'], [10, 0], [20, 0], [50, 2.5]], blocks([[0, 'BLOCK'], [2, 'R'], [10, 0], [20, 0], [0, 'CIRCLE'], [8, '0'], [10, 0], [20, 0], [40, 100], [0, 'ENDBLK']]));
  assert.deepEqual(turned.filter((s) => s.startsWith('quadrant')), ['quadrant -100.000 0.000', 'quadrant 0.000 -100.000', 'quadrant 0.000 100.000', 'quadrant 100.000 0.000']);
  // (r114 R4-M2: a spline-fit 2D POLYLINE, 70 bit 4: its samples are no ends -- its two ends only)
  const fit = all([[0, 'POLYLINE'], [8, '0'], [66, 1], [70, 4], [10, 0], [20, 0], ...[[0, 0], [3, 4], [6, 5], [9, 4], [12, 0]].flatMap(([x, y], k) => [[0, 'VERTEX'], [8, '0'], [10, x], [20, y], [70, k ? 8 : 0]]), [0, 'SEQEND']]);
  assert.deepEqual(fit, ['end 0.000 0.000', 'end 12.000 0.000']);
});
test('a centre snap with its Ø only for a CIRCLE drawn as one: none for a 12-gon, an ellipse, or a circle inserted at 1 x 0.985 (r70 Q6)', () => {
  const lw = (pts) => [[0, 'LWPOLYLINE'], [8, '0'], [90, pts.length], [70, 1], ...pts.flatMap(([x, y]) => [[10, x], [20, y]])];
  const ngon = (n, r) => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]);
  const centres = (ents, blk = []) => {
    const d = parseDXF(dxf([...(blk.length ? blocks(...blk) : []), [0, 'SECTION'], [2, 'ENTITIES'], ...ents, [0, 'ENDSEC'], [0, 'EOF']]));
    const s = snapPoints(d.paths, [0, 0]);
    const c = [];
    // (a centre with a Ø: an ellipse's, or a circle's through a stretch, is a centre with none since
    // r114 R4-M1 -- the snap, not a Ø)
    for (let i = 0; i < s.n; i++) if (s.kind[i] === 2 && s.at(i)[4] > 0) c.push(+(2 * s.at(i)[4]).toFixed(3));
    return c;
  };
  assert.deepEqual(centres(lw(ngon(12, 10))), [], 'a 12-gon (must fire: "centre (Ø 20.000)")');
  assert.deepEqual(centres(lw(ngon(72, 10).map(([x, y]) => [x, 0.985 * y]))), [], 'an ellipse');
  const C = [[0, 'CIRCLE'], [8, '0'], [10, 0], [20, 0], [40, 10]];
  const blk = [[[0, 'BLOCK'], [2, 'C'], [10, 0], [20, 0], ...C, [0, 'ENDBLK']]];
  assert.deepEqual(centres([[0, 'INSERT'], [8, '0'], [2, 'C'], [10, 0], [20, 0], [41, 1], [42, 0.985]], blk), [], 'a circle inserted at 1 x 0.985');
  // must accept: a CIRCLE, alone and in a block turned and scaled evenly; a polyline written as a
  // circle (two vertices, each segment a half circle)
  assert.deepEqual(centres(C), [20]);
  assert.deepEqual(centres([[0, 'LWPOLYLINE'], [8, '0'], [90, 2], [70, 1], [10, -5], [20, 0], [42, 1], [10, 5], [20, 0], [42, 1]]), [10]);
  assert.deepEqual(centres([[0, 'INSERT'], [8, '0'], [2, 'C'], [10, 5], [20, 5], [41, 2], [42, 2], [50, 30]], blk), [40]);
  // (r71 Q2, A7: circles as real drawings write them -- each must fire on r70's marks -- and what
  // stays no circle; one table, so a failure names every row that differs)
  const hatch = (loop) => [[0, 'HATCH'], [8, '0'], [70, 0], [91, 1], ...loop];
  const rows = [
    // an insert scaled by a unit conversion's rounding, 1.8e-9 apart
    ['a noisy insert scale', [[0, 'INSERT'], [8, '0'], [2, 'C'], [10, 0], [20, 0], [41, -0.0010000000002037268], [42, 0.000999999996565748]], blk, [0.02]],
    // a PCB pad: four vertices, each end doubled, bulges 0 1 0 1
    ['a doubled-vertex circle', [[0, 'LWPOLYLINE'], [8, '0'], [90, 4], [70, 1], [10, 0.5207], [20, 0], [10, 0.5207], [20, 0], [42, 1], [10, -0.5207], [20, 0], [10, -0.5207], [20, 0], [42, 1]], [], [1.041]],
    // four quarter turns, as written to eight places; and to six (r72 Q7)
    ['four quarter arcs', [[0, 'LWPOLYLINE'], [8, '0'], [90, 4], [70, 1], ...ngon(4, 5).flatMap(([x, y]) => [[10, x], [20, y], [42, 0.41421356]])], [], [10]],
    ['four quarter arcs, six digits', [[0, 'LWPOLYLINE'], [8, '0'], [90, 4], [70, 1], ...ngon(4, 5).flatMap(([x, y]) => [[10, x], [20, y], [42, 0.414214]])], [], [10]],
    ['a ratio-1 ELLIPSE, a full turn', [[0, 'ELLIPSE'], [8, '0'], [10, 0], [20, 0], [11, 5], [21, 0], [40, 1], [41, 0], [42, 2 * Math.PI]], [], [10]],
    ['a hatch of one full-turn arc edge', hatch([[92, 1], [93, 1], [72, 2], [10, 0], [20, 0], [40, 5], [50, 0], [51, 360], [73, 1]]), [], [10]],
    ['a hatch boundary a bulged circle', hatch([[92, 2], [72, 1], [73, 1], [93, 2], [10, -5], [20, 0], [42, 1], [10, 5], [20, 0], [42, 1]]), [], [10]],
    // (r72 A5: a hatch circle of two halves, and of four quarters, as some exporters write it)
    ['a hatch of two half-circle edges', hatch([[92, 1], [93, 2], ...[[0, 180], [180, 360]].flatMap(([a0, a1]) => [[72, 2], [10, 0], [20, 0], [40, 5], [50, a0], [51, a1], [73, 1]])]), [], [10]],
    ['a hatch of four quarter edges', hatch([[92, 1], [93, 4], ...[[0, 90], [90, 180], [180, 270], [270, 360]].flatMap(([a0, a1]) => [[72, 2], [10, 0], [20, 0], [40, 5], [50, a0], [51, a1], [73, 1]])]), [], [10]],
    // (r72 A3: a circle of a 1° arc and a 359° one, sampled unevenly -- Ø 19.991 by the points' mean)
    ['a circle of 1° + 359° arcs', [[0, 'LWPOLYLINE'], [8, '0'], [90, 2], [70, 1], [10, 10], [20, 0], [42, Math.tan(Math.PI / 720)], [10, 10 * Math.cos(Math.PI / 180)], [20, 10 * Math.sin(Math.PI / 180)], [42, Math.tan((359 * Math.PI) / 720)]], [], [20]],
    // must reject still
    ['a slot', [[0, 'LWPOLYLINE'], [8, '0'], [90, 4], [70, 1], [10, 0], [20, -5], [42, 0], [10, 10], [20, -5], [42, 1], [10, 10], [20, 5], [42, 0], [10, 0], [20, 5], [42, 1]], [], []],
    ['an ELLIPSE of ratio 0.985', [[0, 'ELLIPSE'], [8, '0'], [10, 0], [20, 0], [11, 5], [21, 0], [40, 0.985], [41, 0], [42, 2 * Math.PI]], [], []],
    ['half an ELLIPSE of ratio 1', [[0, 'ELLIPSE'], [8, '0'], [10, 0], [20, 0], [11, 5], [21, 0], [40, 1], [41, 0], [42, Math.PI]], [], []],
    ['a half disc hatch', hatch([[92, 1], [93, 2], [72, 2], [10, 0], [20, 0], [40, 5], [50, 0], [51, 180], [73, 1], [72, 1], [10, -5], [20, 0], [11, 5], [21, 0]]), [], []],
  ];
  assert.deepEqual(rows.map(([name, ents, b]) => [name, centres(ents, b)]), rows.map(([name, , , want]) => [name, want]));
});
// (r70 Q5: an ASCII DXF past the text readers' one limit is refused in their words before it is decoded)
await test('an ASCII DXF past the text limit is refused in the text readers\' words, not the engine\'s (r70 Q5)', async () => {
  const { MAX_TEXT_BYTES, TEXT_LIMIT_WORDS } = await import('../js/formats.js');
  const { dxfText } = await import('../js/dxf.js');
  assert.equal(MAX_TEXT_BYTES, 500 * 2 ** 20);
  const b = new TextEncoder().encode('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n');
  // (the limit's own refusal, at a limit this size: the default is MAX_TEXT_BYTES)
  // (its size past the limit rounded up, to a tenth: never read as within it -- r73 Q4)
  assert.throws(() => dxfText(b, 'big.dxf', 16), (e) => e.message === `big.dxf is 0.1 MB of text, ${TEXT_LIMIT_WORDS}`);
  assert.equal(typeof dxfText(b), 'string', 'under it, decoded');
  assert.match(dxfText.toString(), /max = MAX_TEXT_BYTES/, 'the default is the one limit (must fire: none)');
});
// (r68 Q8: openCounts, the info panel's and dwg-check's "drawn at open", had no test)
test('what a drawing draws as it opens: the lines and texts on layers on; those on a layer off, a frozen one, or under a frozen reference counted apart (r68 Q8)', () => {
  const T = (layer, y) => [[0, 'TEXT'], [8, layer], [10, 0], [20, y], [40, 1], [1, `t${y}`]];
  const L = (layer, y) => [[0, 'LINE'], [8, layer], [10, 0], [20, y], [11, 5], [21, y]];
  const d = parseDXF(dxf([
    [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'],
    [0, 'LAYER'], [2, 'A'], [70, 0], [62, 1], [0, 'LAYER'], [2, 'OFF'], [70, 0], [62, -2], [0, 'LAYER'], [2, 'F'], [70, 1], [62, 3],
    [0, 'ENDTAB'], [0, 'ENDSEC'],
    ...blocks([[0, 'BLOCK'], [2, 'B'], [10, 0], [20, 0], ...L('A', 20), ...T('A', 21), [0, 'ENDBLK']]),
    [0, 'SECTION'], [2, 'ENTITIES'], ...L('A', 0), ...L('OFF', 1), ...L('F', 2), ...T('A', 3), ...T('OFF', 4), ...T('F', 5),
    [0, 'INSERT'], [8, 'F'], [2, 'B'], [10, 0], [20, 0], [0, 'ENDSEC'], [0, 'EOF']]));
  // (each must fire: a text on a layer off counted as drawn; every shape counted as drawn)
  assert.deepEqual(openCounts(d, d.layers), { shapes: 1, texts: 1, hidden: 6 });
  // the same by a Map of the layers, as dwg-check passes them
  assert.deepEqual(openCounts(d, new Map(d.layers.map((l) => [l.name, l]))), { shapes: 1, texts: 1, hidden: 6 });
});
// (r65 A2, A3, A4: an INSERT's ATTRIBs held as its block is; a frozen reference inside another held
// to both; the extents leave out what frozen layers hold, as Zoom Extents does)
test('a frozen reference holds its ATTRIBs and every frozen layer above it; the extents leave out what frozen layers hold (r65 A2-A4)', () => {
  const d2 = parseDXF(dxf([
    [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'],
    [0, 'LAYER'], [2, 'T'], [70, 0], [62, 1], [0, 'LAYER'], [2, 'F1'], [70, 1], [62, 2], [0, 'LAYER'], [2, 'F2'], [70, 1], [62, 3], [0, 'LAYER'], [2, 'OFF'], [70, 0], [62, -4],
    [0, 'ENDTAB'], [0, 'ENDSEC'],
    ...blocks([[0, 'BLOCK'], [2, 'IN'], [10, 0], [20, 0], [0, 'LINE'], [8, 'T'], [10, 0], [20, 0], [11, 1], [21, 0], [0, 'ENDBLK']],
      [[0, 'BLOCK'], [2, 'OUT'], [10, 0], [20, 0], [0, 'INSERT'], [8, 'F2'], [2, 'IN'], [10, 0], [20, 0], [0, 'ENDBLK']]),
    [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LINE'], [8, 'T'], [10, 0], [20, 0], [11, 10], [21, 10],
    // (an off layer's line far off: off still counts in the extents)
    [0, 'LINE'], [8, 'OFF'], [10, -50], [20, 0], [11, -49], [21, 0],
    [0, 'INSERT'], [8, 'F1'], [2, 'OUT'], [10, 1000], [20, 1000],
    [0, 'INSERT'], [8, 'F1'], [2, 'IN'], [10, 500], [20, 500], [66, 1],
    [0, 'ATTRIB'], [8, 'T'], [10, 500], [20, 500], [40, 2], [1, 'SHEET-7'], [2, 'NO'], [70, 0], [0, 'SEQEND'],
    // (a thawed reference after it: its ATTRIB is held by nothing)
    // (at 2, 2: its box, 6.7 wide since its capitals are its height -- r113 -- inside the line's)
    [0, 'INSERT'], [8, 'T'], [2, 'IN'], [10, 2], [20, 2], [66, 1],
    [0, 'ATTRIB'], [8, 'T'], [10, 2], [20, 2], [40, 2], [1, 'FREE'], [2, 'NO'], [70, 0], [0, 'SEQEND'],
    [0, 'ENDSEC'], [0, 'EOF']]));
  const text = (s) => d2.texts.find((t) => t.text === s);
  assert.deepEqual(layersOf(text('SHEET-7')), ['T', 'F1']);
  assert.deepEqual(layersOf(text('FREE')), ['T']);
  // (an INSERT of a block not in the file, on F1: its ATTRIB held all the same -- r66 A7)
  const miss = parseDXF(dxf([
    [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'], [0, 'LAYER'], [2, 'F1'], [70, 1], [62, 2], [0, 'ENDTAB'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'INSERT'], [8, 'F1'], [2, 'XB'], [10, 0], [20, 0], [66, 1],
    [0, 'ATTRIB'], [8, 'T'], [10, 0], [20, 0], [40, 2], [1, 'SHEET-8'], [2, 'NO'], [70, 0], [0, 'SEQEND'],
    [0, 'ENDSEC'], [0, 'EOF']]));
  assert.deepEqual(layersOf(miss.texts.find((t) => t.text === 'SHEET-8')), ['T', 'F1']);
  const nested = d2.paths.find((p) => p.pts[0] === 1000);
  assert.deepEqual(layersOf(nested), ['T', 'F1', 'F2']);
  assert.deepEqual([d2.extents.min, d2.extents.max], [[-50, 0], [10, 10]], 'neither frozen reference, the off line kept');
});
// (r64 Q4: a constant attribute has no ATTRIB on the insert: its value is drawn from its definition)
test('a constant ATTDEF (70 bit 2) is drawn in every insert of its block; a plain one, an invisible constant one, one outside a block are not (r64 Q4)', () => {
  const att = (flags, tag, value) => [[0, 'ATTDEF'], [8, '0'], [100, 'AcDbText'], [10, 1], [20, 1], [40, 2], [1, value], [100, 'AcDbAttributeDefinition'], [3, 'prompt'], [2, tag], [70, flags]];
  const t = parseDXF(dxf([
    ...blocks([[0, 'BLOCK'], [2, 'TAG'], [10, 0], [20, 0], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 0],
      ...att(2, 'C', 'CONST-VALUE'), ...att(0, 'P', 'default'), ...att(3, 'H', 'HIDDEN-CONST'), [0, 'ENDBLK']]),
    [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'INSERT'], [8, '0'], [2, 'TAG'], [10, 0], [20, 0], [66, 1],
    [0, 'ATTRIB'], [8, '0'], [10, 1], [20, 1], [40, 2], [1, 'P-123'], [2, 'P'], [70, 0], [0, 'SEQEND'],
    [0, 'INSERT'], [8, '0'], [2, 'TAG'], [10, 50], [20, 0],
    ...att(2, 'MS', 'MODEL-SPACE-DEF'),
    [0, 'ENDSEC'], [0, 'EOF']]));
  assert.deepEqual(t.texts.map((x) => [x.text, x.x]).sort(), [['CONST-VALUE', 1], ['CONST-VALUE', 51], ['P-123', 1]].sort());
  assert.deepEqual(t.notDrawn || {}, {});
});

test('2D Measure on a hatch slot of two lines and two arcs: the polyline slot\'s snaps -- four corner ends, every side\'s middle, no "quadrant" (r118 M1)', () => {
  const KIND = ['end', 'middle', 'centre', 'quadrant'];
  const snaps = (layer, g) => { const d = parseDXF(ents(g)); const sp = snapPoints(d.paths.filter((p) => p.layer === layer), [0, 0]); const s = []; for (let i = 0; i < sp.n; i++) s.push(`${KIND[sp.kind[i]]} ${sp.xy[2 * i].toFixed(4)} ${sp.xy[2 * i + 1].toFixed(4)}`); return s.sort(); };
  // (a solid-filled slot as exporters write a filled cut-out: an edge boundary, line, arc, line, arc)
  const hatch = [[0, 'HATCH'], [8, 'H'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 4],
    [72, 1], [10, 0], [20, 0], [11, 40], [21, 0],
    [72, 2], [10, 40], [20, 5], [40, 5], [50, 270], [51, 90], [73, 1],
    [72, 1], [10, 40], [20, 10], [11, 0], [21, 10],
    [72, 2], [10, 0], [20, 5], [40, 5], [50, 90], [51, 270], [73, 1],
    [97, 0]];
  const poly = [[0, 'LWPOLYLINE'], [8, 'P'], [90, 4], [70, 1], [10, 0], [20, 0], [10, 40], [20, 0], [42, 1], [10, 40], [20, 10], [10, 0], [20, 10], [42, 1]];
  const want = ['end 0.0000 0.0000', 'end 40.0000 0.0000', 'end 40.0000 10.0000', 'end 0.0000 10.0000', 'middle 20.0000 0.0000', 'middle 20.0000 10.0000', 'middle 45.0000 5.0000', 'middle -5.0000 5.0000'].sort();
  assert.deepEqual(snaps('P', poly), want);
  // (must fire: one arc edge cleared the loop's own points, and its sample extremes were offered as
  // four "quadrant"s, two of them corners, two corners with no snap)
  assert.deepEqual(snaps('H', hatch), want);
});

test('2D Measure on a whole ellipse: its quadrants are its axis ends -- an isometric hole measures its axes, 20 and 11.547 (r118 M2)', () => {
  const quads = (g) => { const d = parseDXF(ents(g)); const sp = snapPoints(d.paths, [0, 0]); const q = []; for (let i = 0; i < sp.n; i++) if (sp.kind[i] === 3) q.push([sp.xy[2 * i], sp.xy[2 * i + 1]]); return q; };
  const span = (q) => { const d = []; for (let i = 0; i < q.length; i++) for (let j = i + 1; j < q.length; j++) d.push(Math.hypot(q[i][0] - q[j][0], q[i][1] - q[j][1])); return d.sort((a, b) => b - a)[0].toFixed(4); };
  // (an isometric hole: major 10 at 30 degrees, ratio 0.57735; must fire: its samples' x and y
  // extremes read 19.2043 and 16.3299)
  const iso = quads([[0, 'ELLIPSE'], [8, '0'], [10, 0], [20, 0], [11, 8.660254], [21, 5], [40, 0.57735], [41, 0], [42, 2 * Math.PI]]);
  assert.equal(iso.length, 4);
  assert.equal(span(iso), '20.0000');
  const across = [Math.hypot(iso[0][0] - iso[2][0], iso[0][1] - iso[2][1]), Math.hypot(iso[1][0] - iso[3][0], iso[1][1] - iso[3][1])].map((v) => v.toFixed(3)).sort();
  assert.deepEqual(across, ['11.547', '20.000']);
  // (a whole one written from parameter 0.1: still its axis ends, not 0.13 off them)
  const off = quads([[0, 'ELLIPSE'], [8, '0'], [10, 0], [20, 0], [11, 10], [21, 0], [40, 0.5], [41, 0.1], [42, 0.1 + 2 * Math.PI]]);
  const f4 = (v) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(4);
  assert.deepEqual(off.map(([x, y]) => `${f4(x)} ${f4(y)}`).sort(), ['-10.0000 0.0000', '0.0000 -5.0000', '0.0000 5.0000', '10.0000 0.0000'].sort());
  // (a circle through a stretching insert -- 2 x 1 -- the same: its quadrants (+-20, 0) and (0, +-10))
  const blk = dxf([[0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [2, 'C'], [10, 0], [20, 0], [0, 'CIRCLE'], [8, '0'], [10, 0], [20, 0], [40, 10], [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, '0'], [2, 'C'], [10, 0], [20, 0], [41, 2], [42, 1], [50, 30], [0, 'ENDSEC'], [0, 'EOF']]);
  const d = parseDXF(blk), sp = snapPoints(d.paths, [0, 0]);
  const q = []; for (let i = 0; i < sp.n; i++) if (sp.kind[i] === 3) q.push([sp.xy[2 * i], sp.xy[2 * i + 1]]);
  assert.equal(q.length, 4);
  assert.equal(span(q), '40.0000');
  const r = q.map(([x, y]) => Math.hypot(x, y).toFixed(4)).sort();
  assert.deepEqual(r, ['10.0000', '10.0000', '20.0000', '20.0000']);
});

test('2D Measure on a hatch that is one whole ellipse, and on a hatch circle through a stretching insert: the ELLIPSE\'s and the CIRCLE\'s snaps (r119 F1, F2)', () => {
  const KIND = ['end', 'middle', 'centre', 'quadrant'];
  const f4 = (v) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(4);
  const snaps = (paths) => { const sp = snapPoints(paths, [0, 0]); const s = []; for (let i = 0; i < sp.n; i++) s.push(`${KIND[sp.kind[i]]} ${f4(sp.xy[2 * i])} ${f4(sp.xy[2 * i + 1])}`); return s.sort(); };
  // (an isometric hole solid-hatched: one elliptic edge, 0 to 360 -- must fire: "end" at one major
  // end, "middle" at the other, no minor ends, no centre)
  const iso = [[0, 'ELLIPSE'], [8, 'E'], [10, 0], [20, 0], [11, 8.660254], [21, 5], [40, 0.57735], [41, 0], [42, 2 * Math.PI]];
  const isoHatch = [[0, 'HATCH'], [8, 'H'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 1],
    [72, 3], [10, 0], [20, 0], [11, 8.660254], [21, 5], [40, 0.57735], [50, 0], [51, 360], [73, 1], [97, 0]];
  const d = parseDXF(ents(iso, isoHatch));
  const e = snaps(d.paths.filter((p) => p.layer === 'E')), h = snaps(d.paths.filter((p) => p.layer === 'H'));
  assert.equal(e.length, 5);
  assert.deepEqual(h, e);
  // (a filled dot in a block -- its HATCH one 360 arc edge beside its CIRCLE -- inserted 2 x 1 at 30:
  // must fire: the hatch had no centre and its sample extremes, 38.98 and 33.23 across, as quadrants)
  const blk = dxf([[0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [2, 'DOT'], [10, 0], [20, 0],
    [0, 'CIRCLE'], [8, 'C'], [10, 0], [20, 0], [40, 10],
    [0, 'HATCH'], [8, 'H'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 1], [72, 2], [10, 0], [20, 0], [40, 10], [50, 0], [51, 360], [73, 1], [97, 0],
    [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, '0'], [2, 'DOT'], [10, 0], [20, 0], [41, 2], [42, 1], [50, 30], [0, 'ENDSEC'], [0, 'EOF']]);
  const b = parseDXF(blk);
  const c = snaps(b.paths.filter((p) => p.layer === 'C')), hh = snaps(b.paths.filter((p) => p.layer === 'H'));
  assert.equal(c.length, 5);
  assert.deepEqual(hh, c);
});

test('a circle drawn as a CIRCLE, a polyline of a 45 and a 315 degree arc, and hatches of both: the same centre and quadrants, in a block at 1 x 1 and stretched 2 x 1 (r120 M1, M2, M3)', () => {
  const f4 = (v) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(4);
  // (a circle's centre and quadrants, kinds 2 and 3, the snaps every way of drawing it must share)
  const marks = (paths) => { const sp = snapPoints(paths, [0, 0]); const s = []; for (let i = 0; i < sp.n; i++) if (sp.kind[i] >= 2) s.push(`${sp.kind[i] === 2 ? 'centre' : 'quadrant'} ${f4(sp.xy[2 * i])} ${f4(sp.xy[2 * i + 1])}`); return s.sort(); };
  // (a polyline circle as exporters write one: two vertices, their bulges tan(45/4) and tan(315/4))
  const b1 = Math.tan((45 * Math.PI) / 180 / 4), b2 = Math.tan((315 * Math.PI) / 180 / 4);
  const v2 = [10 * Math.cos(Math.PI / 4), 10 * Math.sin(Math.PI / 4)];
  const block = [[0, 'CIRCLE'], [8, 'C'], [10, 0], [20, 0], [40, 10],
    [0, 'LWPOLYLINE'], [8, 'L'], [90, 2], [70, 1], [10, 10], [20, 0], [42, b1], [10, v2[0]], [20, v2[1]], [42, b2],
    [0, 'HATCH'], [8, 'HP'], [2, 'SOLID'], [70, 1], [91, 1], [92, 3], [72, 1], [73, 1], [93, 2], [10, 10], [20, 0], [42, b1], [10, v2[0]], [20, v2[1]], [42, b2], [97, 0],
    [0, 'HATCH'], [8, 'HA'], [2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 1], [72, 2], [10, 0], [20, 0], [40, 10], [50, 0], [51, 360], [73, 1], [97, 0]];
  for (const [sx, sy] of [[1, 1], [2, 1]]) {
    const d = parseDXF(dxf([[0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [2, 'P'], [10, 0], [20, 0], ...block, [0, 'ENDBLK'], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [8, '0'], [2, 'P'], [10, 100], [20, 0], [41, sx], [42, sy], [0, 'ENDSEC'], [0, 'EOF']]));
    const of = (layer) => marks(d.paths.filter((p) => p.layer === layer));
    const want = of('C');
    assert.equal(want.length, 5, `${sx} x ${sy}: ${want}`);
    // (must fire: the polyline had no quadrant at 1 x 1 and nothing but its vertices and middles at
    // 2 x 1, and its hatch a centre 0.21 off at 2 x 1, its points' mean)
    for (const layer of ['L', 'HP', 'HA']) assert.deepEqual(of(layer), want, `${layer} at ${sx} x ${sy}`);
  }
});

done();
