#!/usr/bin/env node
// Mesh export (js/export-mesh.js): STL, 3MF and GLB of a small model, each
// read back independently (node:zlib for the zip, the glTF chunk layout by
// hand).   node tests/test-export.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { crc32, to3MF, toGLB, toSTL } from '../js/export-mesh.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

// two bodies: a red triangle pair (a 10 x 20 quad at z 0) and a blue triangle
// at z 5; the second body's indices are absolute, as in a .cadmesh
const position = new Float32Array([0, 0, 0, 10, 0, 0, 10, 20, 0, 0, 20, 0, 0, 0, 5, 4, 0, 5, 0, 4, 5]);
const normal = new Int16Array(7 * 4);
for (let v = 0; v < 7; v++) normal[4 * v + 2] = 32767;
const color = new Uint8Array(7 * 4);
for (let v = 0; v < 7; v++) color.set(v < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255], 4 * v);
const index = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6]);
const model = {
  position, normal, color, index,
  header: { meshes: [{ name: 'plate', vtxStart: 0, vtxCount: 4, idxStart: 0, idxCount: 6 }, { name: 'tri', vtxStart: 4, vtxCount: 3, idxStart: 6, idxCount: 3 }] },
};
const IDENT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// Z up as Y up (the glTF convention): x stays, y = model z, z = -model y
const YUP = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];

await test('STL: 84 + 50 n bytes, a header that is not "solid", the triangles in the basis', () => {
  const b = toSTL(model, [1, 2], YUP, 'plate');
  assert.equal(b.length, 84 + 50 * 3);
  assert.ok(!new TextDecoder().decode(b.slice(0, 5)).startsWith('solid'));
  const dv = new DataView(b.buffer);
  assert.equal(dv.getUint32(80, true), 3);
  // the third triangle (the blue one): its second vertex (4, 0, 5) -> (4, 5, -0)
  const o = 84 + 2 * 50 + 12 + 12;
  assert.deepEqual([dv.getFloat32(o, true), dv.getFloat32(o + 4, true), Math.abs(dv.getFloat32(o + 8, true))], [4, 5, 0]);
  // only the bodies asked for
  assert.equal(toSTL(model, [2], IDENT).length, 84 + 50);
});

// a zip's entries, read from its central directory
function unzip(z) {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let e = z.length - 22;
  while (dv.getUint32(e, true) !== 0x06054b50) e--;
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const out = {};
  for (let i = 0; i < n; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(z.slice(p + 46, p + 46 + nl));
    const lnl = dv.getUint16(off + 26, true), lxl = dv.getUint16(off + 28, true);
    const data = inflateRawSync(z.slice(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize));
    assert.equal(data.length, usize, `${name}: size`);
    assert.equal(crc32(data), crc, `${name}: CRC`);
    out[name] = new TextDecoder().decode(data);
    p += 46 + nl + xl + cl;
  }
  return out;
}
await test('3MF: a zip with the three parts; mm; one object per body; a colour per triangle', async () => {
  const files = unzip(await to3MF(model, [1, 2], IDENT, ['Plate', 'Tri & <co>']));
  assert.deepEqual(Object.keys(files).sort(), ['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
  const x = files['3D/3dmodel.model'];
  assert.match(x, /unit="millimeter"/);
  assert.equal((x.match(/<object /g) || []).length, 2);
  assert.equal((x.match(/<vertex /g) || []).length, 7);
  assert.equal((x.match(/<triangle /g) || []).length, 3);
  assert.match(x, /displaycolor="#FF0000"/);
  assert.match(x, /displaycolor="#0000FF"/);
  assert.match(x, /name="Tri &amp; &lt;co&gt;"/);
  assert.match(x, /<vertex x="10" y="20" z="0"\/>/);
});
await test('GLB: the header and chunks; per body a node, positions in metres with bounds, normals, colours, indices', () => {
  const g = toGLB(model, [1, 2], YUP);
  const dv = new DataView(g.buffer);
  assert.equal(dv.getUint32(0, true), 0x46546c67);
  assert.equal(dv.getUint32(8, true), g.length);
  const jl = dv.getUint32(12, true);
  assert.equal(jl % 4, 0);
  const j = JSON.parse(new TextDecoder().decode(g.slice(20, 20 + jl)));
  const binOff = 20 + jl + 8;
  assert.equal(dv.getUint32(20 + jl + 4, true), 0x004e4942);
  assert.equal(j.nodes.length, 2);
  const pa = j.accessors[j.meshes[0].primitives[0].attributes.POSITION];
  assert.deepEqual(pa.max.map((v) => +v.toFixed(6)), [0.01, 0, 0]);
  assert.deepEqual(pa.min.map((v) => +v.toFixed(6)), [0, 0, -0.02]);
  const ia = j.accessors[j.meshes[1].primitives[0].indices];
  assert.equal(ia.count, 3);
  const iv = j.bufferViews[ia.bufferView];
  assert.deepEqual([...new Uint32Array(g.buffer.slice(binOff + iv.byteOffset, binOff + iv.byteOffset + iv.byteLength))], [0, 1, 2], 'local indices');
  const ca = j.accessors[j.meshes[1].primitives[0].attributes.COLOR_0];
  const cv = j.bufferViews[ca.bufferView];
  assert.deepEqual([...g.slice(binOff + cv.byteOffset, binOff + cv.byteOffset + 4)], [0, 0, 255, 255]);
  for (const v of j.bufferViews) assert.equal(v.byteOffset % 4, 0);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
