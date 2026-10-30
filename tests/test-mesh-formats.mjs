#!/usr/bin/env node
// The mesh file readers (js/mesh-formats.js): a 10 mm cube in each format,
// built here, maps to one body of 12 triangles whose 8 corners are split by
// the 30° crease into 24 vertices, 10 mm on a side, named and coloured as
// the file says; and the model encodes as a .cadmesh.
//   node tests/test-mesh-formats.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { meshFormatOf, parseMesh } from '../js/mesh-formats.js';
import { encodeCadmesh, decodeCadmesh } from '../js/cadmesh.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

// the cube: 8 corners, 12 outward triangles
const S = 10;
const C = [];
for (let i = 0; i < 8; i++) C.push([i & 1 ? S : 0, i & 2 ? S : 0, i & 4 ? S : 0]);
const q = (a, b, c, d) => [[a, b, c], [a, c, d]];
const TRIS = [...q(0, 2, 3, 1), ...q(4, 5, 7, 6), ...q(0, 1, 5, 4), ...q(2, 6, 7, 3), ...q(0, 4, 6, 2), ...q(1, 3, 7, 5)];
const enc = (s) => new TextEncoder().encode(s).buffer;

function stlBinary() {
  const b = new ArrayBuffer(84 + 50 * 12);
  const u = new Uint8Array(b);
  u.set(new TextEncoder().encode('solid cube (a binary STL whose header starts "solid")'));
  const dv = new DataView(b);
  dv.setUint32(80, 12, true);
  TRIS.forEach((t, i) => t.forEach((v, k) => C[v].forEach((x, a) => dv.setFloat32(84 + i * 50 + 12 + k * 12 + a * 4, x, true))));
  return b;
}
const stlAscii = () => enc(`solid cube\n${TRIS.map((t) => ` facet normal 0 0 0\n  outer loop\n${t.map((v) => `   vertex ${C[v].join(' ')}`).join('\n')}\n  endloop\n endfacet`).join('\n')}\nendsolid cube\n`);
const obj = () => enc(`mtllib cube.mtl\no cube\n${C.map((p) => `v ${p.join(' ')}`).join('\n')}\nusemtl red\n${TRIS.map((t) => `f ${t.map((v) => v + 1).join(' ')}`).join('\n')}\n`);
const mtl = () => enc('newmtl red\nKd 1 0 0\n');
const plyAscii = () => enc(`ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 12\nproperty list uchar int vertex_indices\nend_header\n${C.map((p) => `${p.join(' ')} 0 255 0`).join('\n')}\n${TRIS.map((t) => `3 ${t.join(' ')}`).join('\n')}\n`);
function plyBinary() {
  const head = enc('ply\nformat binary_little_endian 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\nelement face 12\nproperty list uchar uint vertex_indices\nend_header\n');
  const b = new ArrayBuffer(head.byteLength + 8 * 12 + 12 * 13);
  new Uint8Array(b).set(new Uint8Array(head));
  const dv = new DataView(b);
  let o = head.byteLength;
  for (const p of C) for (const x of p) { dv.setFloat32(o, x, true); o += 4; }
  for (const t of TRIS) { dv.setUint8(o, 3); o += 1; for (const v of t) { dv.setUint32(o, v, true); o += 4; } }
  return b;
}
const off = () => enc(`OFF\n8 12 0\n${C.map((p) => p.join(' ')).join('\n')}\n${TRIS.map((t) => `3 ${t.join(' ')}`).join('\n')}\n`);

// a zip of stored entries (the reader takes method 0; it does not check CRCs)
function zipStored(entries) {
  const parts = [], central = [];
  let off0 = 0;
  for (const [name, data] of entries) {
    const n = new TextEncoder().encode(name), d = new Uint8Array(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint32(18, d.length, true); lh.setUint32(22, d.length, true); lh.setUint16(26, n.length, true);
    parts.push(new Uint8Array(lh.buffer), n, d);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint32(20, d.length, true); ch.setUint32(24, d.length, true); ch.setUint16(28, n.length, true); ch.setUint32(42, off0, true);
    central.push(new Uint8Array(ch.buffer), n);
    off0 += 30 + n.length + d.length;
  }
  const cd = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cd, true); end.setUint32(16, off0, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out.buffer;
}
// in cm, as a component of a build item moved 5 cm along x: 10 mm after the unit
const model3mf = () => enc(`<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources><basematerials id="1"><base name="blue" displaycolor="#0000FF"/></basematerials>
<object id="2" name="cube" type="model" pid="1" pindex="0"><mesh><vertices>${C.map((p) => `<vertex x="${p[0] / 10}" y="${p[1] / 10}" z="${p[2] / 10}"/>`).join('')}</vertices>
<triangles>${TRIS.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('')}</triangles></mesh></object>
<object id="3" name="assembly" type="model"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components></object></resources>
<build><item objectid="3"/></build></model>`);
const rels = () => enc('<?xml version="1.0"?><Relationships><Relationship Target="/3D/3dmodel.model" Id="r0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');

// a GLB of the cube in metres under a node moved 1 m along x, a grey-green material
function glb() {
  const pos = new Float32Array(C.flat().map((x) => x / 1000));
  const idx = new Uint16Array(TRIS.flat());
  const bin = new Uint8Array(pos.byteLength + idx.byteLength + 2);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'cube node', mesh: 0, translation: [1, 0, 0] }],
    meshes: [{ name: 'cube', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [0.01, 0.01, 0.01] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' }] };
  let js = new TextEncoder().encode(JSON.stringify(json));
  const pad = (n) => (4 - (n % 4)) % 4;
  js = Uint8Array.from([...js, ...new Array(pad(js.length)).fill(0x20)]);
  const binp = Uint8Array.from([...bin, ...new Array(pad(bin.length)).fill(0)]);
  const total = 12 + 8 + js.length + 8 + binp.length;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, js.length, true); dv.setUint32(16, 0x4e4f534a, true); new Uint8Array(out, 20, js.length).set(js);
  dv.setUint32(20 + js.length, binp.length, true); dv.setUint32(24 + js.length, 0x004e4942, true); new Uint8Array(out, 28 + js.length).set(binp);
  return out;
}

// one body: 12 triangles, 24 vertices, a 10 mm box at `at`; its colour
function cube(model, at = [0, 0, 0]) {
  assert.equal(model.meshes.length, 1, `${model.meshes.length} bodies`);
  const m = model.meshes[0];
  assert.equal(m.indices.length, 36, 'triangles');
  assert.equal(m.positions.length / 3, 24, 'vertices after the weld and crease');
  for (let k = 0; k < 3; k++) {
    let lo = Infinity, hi = -Infinity;
    for (let v = k; v < m.positions.length; v += 3) { lo = Math.min(lo, m.positions[v]); hi = Math.max(hi, m.positions[v]); }
    assert.ok(Math.abs(lo - at[k]) < 1e-4 && Math.abs(hi - lo - 10) < 1e-4, `axis ${k}: ${lo}..${hi}`);
  }
  // the normals of a flat face agree, and point out of the cube
  for (let t = 0; t < 12; t++) {
    const [a, b, c] = [0, 1, 2].map((i) => m.indices[t * 3 + i]);
    const cen = [0, 1, 2].map((k) => (m.positions[a * 3 + k] + m.positions[b * 3 + k] + m.positions[c * 3 + k]) / 3 - at[k] - 5);
    const n = [0, 1, 2].map((k) => m.normals[a * 3 + k]);
    assert.ok(n[0] * cen[0] + n[1] * cen[1] + n[2] * cen[2] > 0, `triangle ${t} normal points in`);
  }
  // and it encodes
  const back = decodeCadmesh(encodeCadmesh(model));
  assert.equal(back.header.meshes.length, 1);
  return m;
}
const near = (c, want) => c && want.every((x, i) => Math.abs(c[i] - x) < 0.01);

await test('STL binary, header starting "solid"', async () => {
  const b = stlBinary();
  assert.equal(meshFormatOf('cube.stl', b), 'stl');
  cube(await parseMesh('stl', b, 'cube.stl'));
});
await test('STL ASCII: the solid name', async () => {
  const m = cube(await parseMesh('stl', stlAscii(), 'cube.stl'));
  assert.equal(m.name, 'cube');
});
await test('OBJ with its MTL: o names the body, Kd colours it', async () => {
  const files = new Map([['cube.mtl', mtl()]]);
  const m = cube(await parseMesh('obj', obj(), 'cube.obj', files));
  assert.equal(m.name, 'cube');
  assert.ok(near(m.color, [1, 0, 0]), `colour ${m.color}`);
});
await test('PLY ASCII with vertex colours', async () => {
  const b = plyAscii();
  assert.equal(meshFormatOf('x.ply', b), 'ply');
  const m = cube(await parseMesh('ply', b, 'cube.ply'));
  assert.ok(m.colors && m.colors[1] === 255 && m.colors[0] === 0, `colours ${m.colors && m.colors.slice(0, 4)}`);
});
await test('PLY binary little-endian', async () => { cube(await parseMesh('ply', plyBinary(), 'cube.ply')); });
await test('OFF', async () => { cube(await parseMesh('off', off(), 'cube.off')); });
await test('3MF: unit cm, a component moved, a base material colour, the tree', async () => {
  const z = zipStored([['_rels/.rels', rels()], ['3D/3dmodel.model', model3mf()]]);
  assert.equal(meshFormatOf('cube.3mf', z), '3mf');
  const model = await parseMesh('3mf', z, 'cube.3mf');
  const m = cube(model, [50, 0, 0]);
  assert.ok(near(m.color, [0, 0, 1]), `colour ${m.color}`);
  assert.equal(model.sourceUnits, 'cm');
  assert.equal(model.root.children[0].name, 'assembly');
  assert.equal(model.root.children[0].children[0].name, 'cube');
});
await test('GLB: metres to mm, the node moved, the linear colour as sRGB', async () => {
  const b = glb();
  assert.equal(meshFormatOf('cube.glb', b), 'glb');
  const model = await parseMesh('glb', b, 'cube.glb');
  const m = cube(model, [1000, 0, 0]);
  assert.ok(near(m.color, [0.735, 0.735, 0.735]), `colour ${m.color}`);
  assert.equal(model.sourceUnits, 'm');
});
await test('glTF needing Draco: refused by name', async () => {
  const j = enc(JSON.stringify({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] }));
  await assert.rejects(parseMesh('gltf', j, 'x.gltf'), /KHR_draco_mesh_compression/);
});
await test('a .gltf without its .bin: says which file to drop with it', async () => {
  const j = enc(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'cube.bin', byteLength: 4 }], meshes: [], nodes: [] }));
  await assert.rejects(parseMesh('gltf', j, 'x.gltf'), /cube\.bin/);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
