#!/usr/bin/env node
// The one-click colour schemes (js/palettes.js):
//   node tests/test-palettes.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { DEFAULT_GREY, PALETTE, occtResultToModel } from '../js/cadmesh.js';
import { MONO, PALETTES, bodyColours, distinct, hexToRgb, rgbToHex, schemeColours } from '../js/palettes.js';

import { test, done } from './harness.mjs';
const key = (c) => c.map((x) => x.toFixed(4)).join(',');

// an assembly: a wrapper, then two subassemblies (A with a screw used twice
// and a plate; B with a fan) and one body directly on the branching node
const header = {
  meshes: [
    { name: 'screw', vtxStart: 0, vtxCount: 2 }, { name: 'screw', vtxStart: 2, vtxCount: 2 },
    { name: 'plate', vtxStart: 4, vtxCount: 3 }, { name: 'fan', vtxStart: 7, vtxCount: 1 },
    { name: 'base', vtxStart: 8, vtxCount: 2 },
  ],
  root: { name: '', meshes: [], children: [
    { name: 'rack', meshes: [4], children: [
      { name: 'A', meshes: [], children: [
        { name: 'screw', meshes: [0], children: [] }, { name: 'screw', meshes: [1], children: [] },
        { name: 'plate', meshes: [2], children: [] }] },
      { name: 'B', meshes: [], children: [{ name: 'fan', meshes: [3], children: [] }] },
    ] },
  ] },
};
const color = new Uint8Array(10 * 4).map((_, i) => (i % 4 === 3 ? 255 : 17 + i));
const mesh = { header, color };

test('"By part name" is the converter\'s own rule for a colourless file (one function)', () => {
  const model = occtResultToModel({ success: true, meshes: header.meshes.map((m) => ({ name: m.name, attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, index: { array: [0, 1, 2] } })),
    root: header.root });
  assert.deepEqual(model.meshes.map((m) => key(m.color)), bodyColours(header, 'part').map(key));
  assert.equal(MONO, DEFAULT_GREY);
});
test('every scheme has an id and a label, file first', () => {
  assert.equal(PALETTES[0].id, 'file');
  assert.ok(PALETTES.every((p) => p.id && p.label));
});
test('file colours: the model is shown as it is', () => {
  assert.equal(bodyColours(header, 'file'), null);
  assert.equal(schemeColours(mesh, 'file'), color);
});
test('by part name: instances of a part match, other parts differ', () => {
  const c = bodyColours(header, 'part');
  assert.equal(key(c[0]), key(c[1]));
  assert.ok(c.every((x) => PALETTE.some((p) => key(p) === key(x))));
});
test('by assembly: a subassembly is one colour, the next another, a loose body its own', () => {
  const c = bodyColours(header, 'assembly');
  assert.equal(key(c[0]), key(c[2])); // A: screws and plate
  assert.notEqual(key(c[0]), key(c[3])); // B
  assert.notEqual(key(c[4]), key(c[0])); // the base, on the branching node
  assert.notEqual(key(c[4]), key(c[3]));
});
// (r113 M2 palettes-C7) more assemblies than PALETTE has colours (the rack, the A311D board): the
// group numbered PALETTE.length takes distinct(), every body gets an [r, g, b], and the page's
// schemeColours does not throw
test('by assembly with PALETTE.length + 2 assemblies: every body coloured, the first past the palette by distinct() (r113 M2 palettes-C7)', () => {
  const n = PALETTE.length + 2;
  const meshes = Array.from({ length: n }, (_, i) => ({ name: `a${i}`, vtxStart: i, vtxCount: 1 }));
  const big = { meshes, root: { name: '', meshes: [], children: meshes.map((m, i) => ({ name: m.name, meshes: [i], children: [] })) } };
  const c = bodyColours(big, 'assembly');
  assert.equal(c.length, n);
  c.forEach((x, i) => assert.ok(Array.isArray(x) && x.length === 3 && x.every((v) => Number.isFinite(v)), `body ${i}: ${x}`));
  for (let k = 0; k < PALETTE.length; k++) assert.equal(key(c[k]), key(PALETTE[k]));
  assert.equal(key(c[PALETTE.length]), key(distinct(PALETTE.length)));
  assert.equal(key(c[PALETTE.length + 1]), key(distinct(PALETTE.length + 1)));
  const out = schemeColours({ header: big, color: new Uint8Array(n * 4) }, 'assembly');
  assert.equal(out.length, n * 4);
  assert.ok([...out].every((v, i) => i % 4 !== 3 || v === 255), 'every vertex opaque');
});
test('by body: every body differs', () => {
  const c = bodyColours(header, 'body').map(key);
  assert.equal(new Set(c).size, c.length);
});
test('one colour: every body the same neutral', () => {
  assert.ok(bodyColours(header, 'mono').every((x) => key(x) === key(MONO)));
});
test('distinct colours stay in range and do not repeat over 500', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = distinct(i);
    assert.ok(c.every((x) => x >= 0 && x <= 1), `${i}: ${c}`);
    seen.add(key(c));
  }
  assert.equal(seen.size, 500);
});
test('scheme colours fill each body\'s vertex range, opaque, and leave the model\'s array alone', () => {
  const before = color.slice();
  const out = schemeColours(mesh, 'body');
  assert.notEqual(out, color);
  assert.deepEqual(color, before);
  const per = bodyColours(header, 'body');
  header.meshes.forEach((m, i) => {
    for (let v = m.vtxStart; v < m.vtxStart + m.vtxCount; v++) {
      assert.deepEqual([...out.subarray(4 * v, 4 * v + 4)], [...per[i].map((x) => Math.round(x * 255)), 255]);
    }
  });
});
test('a part colour wins over the scheme, and over the file colours', () => {
  const o = new Map([[3, [1, 0, 0]]]);
  for (const id of ['body', 'file']) {
    const out = schemeColours(mesh, id, o);
    assert.deepEqual([...out.subarray(4 * 7, 4 * 8)], [255, 0, 0, 255], id);
    // the other bodies keep the scheme's (or the file's) colours
    const plain = schemeColours(mesh, id);
    assert.deepEqual([...out.subarray(0, 4 * 7)], [...plain.subarray(0, 4 * 7)], id);
  }
});
test('file colours with a part colour copy the model, never write into it', () => {
  const before = color.slice();
  const out = schemeColours(mesh, 'file', new Map([[0, [0, 1, 0]]]));
  assert.notEqual(out, color);
  assert.deepEqual(color, before);
});
test('hex and rgb convert both ways', () => {
  assert.deepEqual(hexToRgb('#ff8000').map((x) => Math.round(x * 255)), [255, 128, 0]);
  assert.equal(rgbToHex([1, 0.5, 0]), '#ff8000');
  // an alpha is dropped and out-of-range values clamp: always a valid #rrggbb (review r15)
  assert.equal(rgbToHex([0.2, 0.4, 0.6, 1]), '#336699');
  assert.equal(rgbToHex([200, -1, 0.5]), '#ff0080');
});
test('an unknown scheme is refused', () => {
  assert.throws(() => bodyColours(header, 'nope'), /unknown colour scheme/);
});

test('a painted face colours its triangles\' vertices, over the scheme', () => {
  // one body of two faces: triangles 0 (verts 0,1,2) and 1 (verts 3,4,5)
  const mesh = { header: { meshes: [{ name: 'a', vtxStart: 0, vtxCount: 6 }] },
    color: new Uint8Array(24).fill(100), faces: new Uint32Array([0, 1, 1, 1]), index: new Uint32Array([0, 1, 2, 3, 4, 5]) };
  const out = schemeColours(mesh, 'file', new Map(), new Map([[1, [1, 0, 0]]]));
  assert.deepEqual([...out.slice(0, 4)], [100, 100, 100, 100], 'face 0 kept');
  for (const v of [3, 4, 5]) assert.deepEqual([...out.slice(v * 4, v * 4 + 4)], [255, 0, 0, 255], `vertex ${v}`);
  // no paint, no scheme: the file's own array, not a copy
  assert.equal(schemeColours(mesh, 'file', new Map(), new Map()), mesh.color);
});

done();
