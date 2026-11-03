#!/usr/bin/env node
// The DXF reader (js/dxf.js) on a drawing built here, whose answers are
// known: units, layer colours, a bulge, an OCS-mirrored circle, a scaled and
// rotated insert, a MINSERT array, BYBLOCK, a solid hatch, an ellipse, a
// spline, TEXT and MTEXT, and the paper colours.
//   node tests/test-dxf.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { parseDXF, bulgePts, mtextPlain, textCodes, unescapeDxf, valueKind, aciColour, onPaper, caret, uncaret } from '../js/dxf.js';
import { unescapeDxf as dwgCompareUnescape } from './dwg-compare.mjs';
import { sniffFormat } from '../js/formats.js';
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
  // (with no 11, its 50 is an angle in the OCS, as ezdxf maps it: OCS x runs along world -x here)
  assert.ok(Math.abs(Math.abs(mt.rot) - Math.PI) < 1e-9, `rot ${mt.rot}`);
  const md = parseDXF(ents([[0, 'MTEXT'], [8, '0'], [10, 50], [20, 0], [11, 0], [21, 1], [40, 2], [210, 0], [220, 0], [230, -1], [1, 'B']])).texts[0];
  assert.ok(Math.abs(md.rot - Math.PI / 2) < 1e-9, `direction rot ${md.rot}`);
  // a TEXT with the same extrusion: its point is in the OCS, whose x runs along world -x
  const tx = parseDXF(ents([[0, 'TEXT'], [8, '0'], [10, 50], [20, 0], [40, 2], [210, 0], [220, 0], [230, -1], [1, 'C']])).texts[0];
  assert.deepEqual([tx.x, tx.y], [-50, 0]);
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

done();
