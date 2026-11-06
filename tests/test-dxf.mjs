#!/usr/bin/env node
// The DXF reader (js/dxf.js) on a drawing built here, whose answers are
// known: units, layer colours, a bulge, an OCS-mirrored circle, a scaled and
// rotated insert, a MINSERT array, BYBLOCK, a solid hatch, an ellipse, a
// spline, TEXT and MTEXT, and the paper colours.
//   node tests/test-dxf.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { parseDXF, layersOf, drawsNothing, sheetsOf, bulgePts, mtextPlain, textCodes, textCorners, unescapeDxf, wrapLines, valueKind, aciColour, onPaper, caret, uncaret } from '../js/dxf.js';
import { unescapeDxf as dwgCompareUnescape } from './dwg-compare.mjs';
import { sniffFormat } from '../js/formats.js';
import { addedReversed, nearestPoint, nearestSegment, pointTree, segmentIndex, snapPoints, textAt, textIndex } from '../js/dxf-view.js';
import { boxTree, nearestItem } from '../js/box-tree.js';
import { DWG_CODEPAGES, codePageLabel, decoderFor } from '../js/codepages.js';

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
test('texts: %%c, MTEXT formatting stripped; extents', () => {
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
  const xs = [line.pts[0], line.pts[2]].sort((a, b) => a - b);
  // scale 1 about (0, 0) -> paper x -150..250, clipped to the frame's 20..80
  assert.ok(Math.abs(xs[0] - 20) < 1e-9 && Math.abs(xs[1] - 80) < 1e-9, `x ${xs}`);
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
  assert.equal(codePageLabel('ANSI_1251'), 'windows-1251');
  // %%192 in a 1251 drawing is "А" (Cyrillic), in a 1252 one "À"
  const ru = parseDXF(dxf([[0, 'SECTION'], [2, 'HEADER'], [9, '$DWGCODEPAGE'], [3, 'ANSI_1251'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, '%%192'], [0, 'ENDSEC'], [0, 'EOF']]));
  assert.equal(ru.texts[0].text, 'А');
  assert.equal(textCodes('%%192'), 'À');
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
    paths.forEach((p, pi) => { for (let i = 0; i + 1 < p.pts.length / 2; i++) { const ax = p.pts[2 * i], ay = p.pts[2 * i + 1], vx = p.pts[2 * i + 2] - ax, vy = p.pts[2 * i + 3] - ay, l2 = vx * vx + vy * vy; const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0; const d2 = (x - ax - t * vx) ** 2 + (y - ay - t * vy) ** 2; if (d2 < bd) { bd = d2; best = pi; } } });
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
test('the hover\'s texts are in the one box tree: the first text whose quad holds the point, as a scan finds it, fast over a million (r25 A5, A7)', () => {
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
    const want = texts.findIndex((t, i) => ok(i) && inside(quad(t), x + o[0], y + o[1]));
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
  assert.ok(Math.abs(Math.max(...c2.map((q) => q[0])) - (1.2 + 2)) < 1e-9, `${JSON.stringify(c2)}`);
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
    [0, 'INSERT'], [8, 'T'], [2, 'IN'], [10, 5], [20, 5], [66, 1],
    [0, 'ATTRIB'], [8, 'T'], [10, 5], [20, 5], [40, 2], [1, 'FREE'], [2, 'NO'], [70, 0], [0, 'SEQEND'],
    [0, 'ENDSEC'], [0, 'EOF']]));
  const text = (s) => d2.texts.find((t) => t.text === s);
  assert.deepEqual(layersOf(text('SHEET-7')), ['T', 'F1']);
  assert.deepEqual(layersOf(text('FREE')), ['T']);
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

done();
