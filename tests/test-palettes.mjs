#!/usr/bin/env node
// The one-click colour schemes (js/palettes.js):
//   node tests/test-palettes.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { PALETTE } from '../js/cadmesh.js';
import { MONO, PALETTES, bodyColours, distinct, hexToRgb, rgbToHex, schemeColours } from '../js/palettes.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
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

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
