#!/usr/bin/env node
// The mesh file readers (js/mesh-formats.js): a 10 mm cube in each format,
// built here, maps to one body of 12 triangles whose 8 corners are split by
// the 30° crease into 24 vertices, 10 mm on a side, named and coloured as
// the file says; and the model encodes as a .cadmesh.
//   node tests/test-mesh-formats.mjs [name-part]   (exit 0 = all pass; a name-part runs only the arms whose name holds it)

import assert from 'node:assert/strict';
import { meshFormatOf, parseMesh, unzip, weld } from '../js/mesh-formats.js';
import { MM, encodeCadmesh, decodeCadmesh } from '../js/cadmesh.js';

// (the shared harness; its name filter: node tests/test-mesh-formats.mjs <name-part>)
import { test, done } from './harness.mjs';

// a hostile file is refused in the reader's own words, quickly: never an engine message
const ENGINE = /Cannot|is not a function|RangeError|URIError|URI malformed|fetch failed|Invalid array length|out of bounds|outside the bounds|is not iterable|string longer|heap/;
async function refusedFast(fn, re, ms = 2000) {
  const t0 = Date.now();
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  const dt = Date.now() - t0;
  assert.ok(err, `did not throw (${dt} ms)`);
  assert.match(err.message, re);
  assert.doesNotMatch(err.message, ENGINE);
  assert.ok(dt < ms, `${dt} ms`);
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

await test('meshFormatOf: conclusive bytes win over the name (as check.html judges them), else the name', async () => {
  assert.equal(meshFormatOf('part.stl', plyBinary()), 'ply');
  assert.equal(meshFormatOf('part.gltf', enc('glTF\x02\0\0\0')), 'glb');
  assert.equal(meshFormatOf('part.obj', enc('vn 0 0 1\nv 0 0 0\n')), 'obj');
  assert.equal(meshFormatOf('part.OFF', off()), 'off');
  assert.equal(meshFormatOf('readme.txt', enc('hello')), null);
});
await test('every mesh format says its geometry is in mm by the header word the viewer converts from (MM)', async () => {
  const models = [await parseMesh('off', off(), 'cube.off'), await parseMesh('ply', plyBinary(), 'cube.ply')];
  for (const m of models) assert.equal(decodeCadmesh(encodeCadmesh(m)).header.units, MM);
});
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
await test('MTL "Kd 0.8" (one value) is a grey, not red; a Kd over 1 is clamped, not wrapped', async () => {
  const objText = new TextDecoder().decode(obj());
  const grey = await parseMesh('obj', obj(), 'cube.obj', new Map([['cube.mtl', enc(new TextDecoder().decode(mtl()).replace(/Kd .*/, 'Kd 0.8'))]]));
  assert.ok(near(grey.meshes[0].color, [0.8, 0.8, 0.8]), `colour ${grey.meshes[0].color}`);
  // two materials (so per-vertex colours, the byte path): one over 1
  const two = objText.replace(/usemtl .*/, 'usemtl hot');
  const files = new Map([['cube.mtl', enc('newmtl hot\nKd 2 0.5 0\n')]]);
  const m = await parseMesh('obj', enc(two), 'cube.obj', files);
  const raw = decodeCadmesh(encodeCadmesh(m));
  assert.equal(raw.color[0], 255, 'clamped to 255, not wrapped');
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

// --- damaged files: refused in plain words, quickly, never a hang or an engine error ---
await test('a coloured ASCII PLY of 200 k vertices opens (its colour scale overflowed the stack)', async () => {
  const n = 200000;
  const verts = [];
  for (let i = 0; i < n; i++) verts.push(`${i % 1000} ${Math.floor(i / 1000)} 0 200 100 50`);
  const faces = [];
  for (let i = 0; i + 1001 < n; i += 997) faces.push(`3 ${i} ${i + 1} ${i + 1000}`);
  const ply = enc(`ply\nformat ascii 1.0\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${faces.length}\nproperty list uchar int vertex_indices\nend_header\n${verts.join('\n')}\n${faces.join('\n')}\n`);
  const model = await parseMesh('ply', ply, 'big.ply');
  assert.ok(model.meshes[0].indices.length > 0);
});
await test('counts larger than the file: refused at once (OFF, ASCII PLY, binary PLY)', async () => {
  const t0 = Date.now();
  await assert.rejects(parseMesh('off', enc('OFF\n1e999 0 0\n'), 'x.off'), /not an OFF file|damaged/);
  await assert.rejects(parseMesh('off', enc('OFF\n30000000 1 0\n0 0 0\n'), 'x.off'), /damaged/);
  await assert.rejects(parseMesh('ply', enc('ply\nformat ascii 1.0\nelement vertex 1e999\nproperty float x\nend_header\n1\n'), 'x.ply'), /damaged/);
  await assert.rejects(parseMesh('ply', enc('ply\nformat binary_little_endian 1.0\nelement vertex 1000\nproperty float x\nend_header\n\0\0\0\0'), 'x.ply'), /damaged/);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});
await test('a face naming a vertex the file does not have: refused, naming it', async () => {
  await assert.rejects(parseMesh('obj', enc('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n'), 'x.obj'), /x\.obj is damaged: "f 1 2 9" refers to vertex 9 of 3/);
  await assert.rejects(parseMesh('off', enc('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 7\n'), 'x.off'), /refers to vertex 8 of 3/);
});
await test('a broken zip: "damaged", not the engine\'s DataView error; an entry over the limit refused', async () => {
  const z = new Uint8Array(zipStored([['a.txt', new TextEncoder().encode('hello')]]));
  // the central directory entry's local-header offset (+42) pointed past the end
  const cd = z.length - 22 - (46 + 5);
  const bad = z.slice();
  new DataView(bad.buffer).setUint32(cd + 42, 0x7fffffff, true);
  await assert.rejects((async () => { const u = await unzip(bad.buffer); await u.get('a.txt'); })(), /damaged zip/);
  // a deflated entry claiming 3 GB unpacked is refused before inflating
  const big = z.slice();
  const dvb = new DataView(big.buffer);
  dvb.setUint16(cd + 10, 8, true);
  dvb.setUint32(cd + 24, 3 * 2 ** 30, true);
  const u = await unzip(big.buffer);
  await assert.rejects(u.get('a.txt'), /unpacks to over 2 GB/);
});
await test('a .gltf whose buffer is a base64 data: URI opens (the URI\'s text was read as the buffer)', async () => {
  const f = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const b64 = Buffer.from(f.buffer).toString('base64');
  const j = enc(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: `data:application/octet-stream;base64,${b64}`, byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }] }));
  const model = await parseMesh('gltf', j, 'tri.gltf');
  const p = model.meshes[0].positions;
  // metres to mm: the second corner at x = 1000
  assert.ok([...p].some((x, i) => i % 3 === 0 && Math.abs(x - 1000) < 1e-3), `positions ${[...p]}`);
});
await test('a damaged glTF: a cycle, a missing scene or node, a short buffer, bad JSON, a long chunk', async () => {
  const g = (o) => enc(JSON.stringify({ asset: { version: '2.0' }, ...o }));
  await assert.rejects(parseMesh('gltf', g({ scenes: [{ nodes: [0] }], nodes: [{ children: [0] }] }), 'x.gltf'), /node 0 is its own ancestor/);
  await assert.rejects(parseMesh('gltf', g({ scene: 3, scenes: [{ nodes: [] }], nodes: [] }), 'x.gltf'), /scene 3 is not there/);
  await assert.rejects(parseMesh('gltf', g({ scenes: [{ nodes: [5] }], nodes: [] }), 'x.gltf'), /node 5 is not there/);
  const shortBuf = g({ buffers: [{ uri: 'data:application/octet-stream;base64,AAAA', byteLength: 3 }], bufferViews: [{ buffer: 0, byteLength: 3 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }] });
  await assert.rejects(parseMesh('gltf', shortBuf, 'x.gltf'), /accessor 0 reads past the end of its buffer/);
  await assert.rejects(parseMesh('gltf', enc('{ not json'), 'x.gltf'), /x\.gltf is damaged: its JSON does not parse/);
  const glb = new ArrayBuffer(20);
  const dv = new DataView(glb);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(12, 1000, true); dv.setUint32(16, 0x4e4f534a, true);
  await assert.rejects(parseMesh('glb', glb, 'x.glb'), /x\.glb is damaged: a chunk runs past the end/);
});
// --- review round 2: shapes the round-1 limits did not cover ---
const gltf = (o) => enc(JSON.stringify({ asset: { version: '2.0' }, ...o }));
await test('shared glTF nodes: a node shared down 40 levels (2^40 paths) and a mesh placed 1024 times refused at once by count; two placements of one cube still open', async () => {
  const dag = [];
  for (let i = 0; i < 40; i++) dag.push({ children: [i + 1, i + 1] });
  dag.push({});
  await refusedFast(() => parseMesh('gltf', gltf({ scenes: [{ nodes: [0] }], nodes: dag }), 'x.gltf'), /x\.gltf places 2,199,023,255,551 parts once its shared parts are repeated, more than the 2,000,000 this viewer opens/);
  // 30 k triangles under 10 levels of two-way sharing: 30.7 M triangles placed
  const fan = [];
  for (let i = 0; i < 10; i++) fan.push({ children: [i + 1, i + 1] });
  fan.push({ mesh: 0 });
  await refusedFast(() => parseMesh('gltf', gltf({ scenes: [{ nodes: [0] }], nodes: fan, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ componentType: 5126, type: 'VEC3', count: 90000 }] }), 'x.gltf'), /x\.gltf places 30,720,000 triangles once its shared parts are repeated, more than the 10,000,000 this viewer opens/);
  // (a real shared part: one cube placed twice is two bodies)
  const f = new Float32Array(C.flat().map((x) => x / 1000));
  const idx = new Uint16Array(TRIS.flat());
  const bin = new Uint8Array(f.byteLength + idx.byteLength);
  bin.set(new Uint8Array(f.buffer)); bin.set(new Uint8Array(idx.buffer), f.byteLength);
  const model = await parseMesh('gltf', gltf({ scenes: [{ nodes: [0] }], nodes: [{ children: [1, 2] }, { mesh: 0 }, { mesh: 0, translation: [1, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`, byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteLength: f.byteLength }, { buffer: 0, byteOffset: f.byteLength, byteLength: idx.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' }] }), 'two.gltf');
  assert.equal(model.meshes.length, 2);
  assert.equal(model.root.children[0].children.length, 2);
});
await test('3MF components: shared 30 deep refused at once by count; a chain over 32 deep and a missing object refused in words, not dropped', async () => {
  const m3 = (x) => zipStored([['3D/3dmodel.model', enc(`<model unit="millimeter"><resources>${x}</build></model>`)]]);
  const tri = '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>';
  let x = '';
  for (let k = 0; k < 30; k++) x += `<object id="${k}"><components><component objectid="${k + 1}"/><component objectid="${k + 1}"/></components></object>`;
  x += `<object id="30">${tri}</object></resources><build><item objectid="0"/>`;
  await refusedFast(() => parseMesh('3mf', m3(x), 'a.3mf'), /a\.3mf places 2,147,483,647 parts once its shared parts are repeated, more than the 2,000,000 this viewer opens/);
  let chain = '';
  for (let k = 0; k < 40; k++) chain += `<object id="${k}"><components><component objectid="${k + 1}"/></components></object>`;
  chain += `<object id="40">${tri}</object></resources><build><item objectid="0"/>`;
  await refusedFast(() => parseMesh('3mf', m3(chain), 'a.3mf'), /a\.3mf is damaged: its component tree is more than 32 deep/);
  await refusedFast(() => parseMesh('3mf', m3(`<object id="1"><components><component objectid="99"/></components></object><object id="2">${tri}</object></resources><build><item objectid="1"/><item objectid="2"/>`), 'a.3mf'),
    /a\.3mf is damaged: object 1 names object 99, which is not there/);
  await refusedFast(() => parseMesh('3mf', m3(`<object id="2">${tri}</object></resources><build><item objectid="7"/><item objectid="2"/>`), 'a.3mf'),
    /a\.3mf is damaged: its build names object 7, which is not there/);
});
await test('a glTF accessor counting 2^30 elements: refused before it is allocated, with and without a buffer view', async () => {
  const prim = { scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] };
  // (one triangle by its indices: the placed-triangle count passes, and since round 3 the
  // placed-vertex count refuses it before the accessor is met)
  await refusedFast(() => parseMesh('gltf', gltf({ ...prim, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ componentType: 5126, type: 'VEC3', count: 2 ** 30 }, { componentType: 5125, type: 'SCALAR', count: 3 }] }), 'x.gltf'),
  /x\.gltf places 1,073,741,824 vertices once its shared parts are repeated, more than the 30,000,000 this viewer opens/);
  // (the accessor's own cap, on values: a POSITION of 16 values per element under the vertex cap)
  await refusedFast(() => parseMesh('gltf', gltf({ ...prim, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ componentType: 5126, type: 'MAT4', count: 2 ** 23 }, { componentType: 5125, type: 'SCALAR', count: 3 }] }), 'x.gltf'),
  /x\.gltf: accessor 0 holds 134,217,728 values, more than the 90,000,000 this viewer reads/);
  // (under the cap, a count its buffer view cannot hold is refused before the 400 MB it asks for)
  await refusedFast(() => parseMesh('gltf', gltf({ ...prim, buffers: [{ uri: 'data:application/octet-stream;base64,AAAAAAAAAAAAAAAA', byteLength: 12 }],
    bufferViews: [{ buffer: 0, byteLength: 12 }], accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 2 ** 24 }] }), 'x.gltf'),
  /x\.gltf is damaged: accessor 0 reads past the end of its buffer/);
});
await test('glTF/GLB shapes refused in words: a 3-byte GLB, a view past its buffer, a primitive with no attributes, scene nodes and extensionsRequired not lists', async () => {
  await refusedFast(() => parseMesh('glb', new ArrayBuffer(3), 'x.glb'), /x\.glb is damaged: 3 bytes, shorter than a GLB header/);
  await refusedFast(() => parseMesh('gltf', gltf({ buffers: [{ uri: 'data:application/octet-stream;base64,AAAA' }], bufferViews: [{ buffer: 0, byteOffset: 100 }],
    accessors: [{ componentType: 5126, type: 'VEC3', count: 0, bufferView: 0 }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] }), 'x.gltf'),
  /x\.gltf is damaged: buffer view 0 runs past the end of its buffer/);
  await refusedFast(() => parseMesh('gltf', gltf({ nodes: [{ mesh: 0 }], meshes: [{ primitives: [{}] }] }), 'x.gltf'), /x\.gltf is damaged: mesh 0 primitive 1 has no attributes/);
  await refusedFast(() => parseMesh('gltf', gltf({ scenes: [{ nodes: 5 }], nodes: [] }), 'x.gltf'), /x\.gltf is damaged: scene 0's "nodes" is not a list/);
  await refusedFast(() => parseMesh('gltf', gltf({ extensionsRequired: 5 }), 'x.gltf'), /x\.gltf is damaged: "extensionsRequired" is not a list/);
});
await test('STL and PLY in words: "solidx" then endfacet, a 300 k-vertex facet, an unknown PLY type, a negative list count', async () => {
  await refusedFast(() => parseMesh('stl', enc('solidx\nendfacet\n'), 'a.stl'), /a\.stl has no triangles to show/);
  await refusedFast(() => parseMesh('stl', enc(`solid a\n${'vertex 1 2 3\n'.repeat(300000)}endfacet\nendsolid\n`), 'a.stl'), /a\.stl has no triangles to show \(every triangle has no area\)/, 5000);
  await refusedFast(() => parseMesh('ply', enc('ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty foo x\nend_header\n\0\0\0\0\0\0\0\0\0\0\0\0'), 'a.ply'),
    /a\.ply is damaged: property x has type foo, which is not a PLY type/);
  const hdr = 'ply\nformat binary_little_endian 1.0\nelement face 1\nproperty list int int vertex_indices\nend_header\n';
  const b = new Uint8Array(hdr.length + 8);
  b.set(new TextEncoder().encode(hdr));
  new DataView(b.buffer).setInt32(hdr.length, -1, true);
  await refusedFast(() => parseMesh('ply', b.buffer, 'a.ply'), /a\.ply is damaged: a vertex_indices list in element face counts -1 items/);
});
await test('PLY: 2000 empty elements each counting the file\'s bytes refused at once (counts summed, not checked one by one)', async () => {
  let hdr = 'ply\nformat binary_little_endian 1.0\n';
  for (let i = 0; i < 2000; i++) hdr += `element e${i} 1000000\n`;
  hdr += 'end_header\n';
  const b = new Uint8Array(hdr.length + 1000000);
  b.set(new TextEncoder().encode(hdr));
  await refusedFast(() => parseMesh('ply', b.buffer, 'a.ply'), /a\.ply is damaged: element e1 counts 1000000, more than the file holds/);
});
await test('weld: a 60 k-triangle fan, every triangle its own colour, welds in under 2 s to 3N vertices', async () => {
  // centre 0 and ring 1..N+1; triangle j = (0, j, j+1) in colour j. The centre splits into
  // N vertices (one per colour), the ring ends keep 1, the N-1 inner ring vertices split in 2
  const N = 60000;
  const pos = [0, 0, 0];
  for (let i = 0; i <= N; i++) { const a = (2 * Math.PI * i) / (N + 1); pos.push(Math.cos(a), Math.sin(a), 0); }
  const tri = [], col = [];
  for (let j = 1; j <= N; j++) { tri.push(0, j, j + 1); col.push([j / N, 0, 0]); }
  const t0 = Date.now();
  const m = weld({ name: 'fan', pos, tri, col });
  const dt = Date.now() - t0;
  assert.equal(m.positions.length / 3, 3 * N);
  assert.equal(m.indices.length, 3 * N);
  assert.ok(dt < 2000, `${dt} ms`);
});

await test('triangles with no area: said so, not "holds no faces"', async () => {
  await assert.rejects(parseMesh('stl', enc('solid z\n facet normal 0 0 0\n  outer loop\n   vertex 0 0 0\n   vertex 0 0 0\n   vertex 0 0 0\n  endloop\n endfacet\nendsolid z\n'), 'z.stl'), /every triangle has no area/);
});

// --- review round 3 ---
const b64uri = (u8) => `data:application/octet-stream;base64,${Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64')}`;
await test('r3-2 placed vertices: a 451-byte glTF placing a 30 M-vertex POSITION (1 triangle by its indices) twice, and a 3MF object of 50 k vertices shared 1024 times, refused at once by count', async () => {
  const idx = new Uint32Array([0, 1, 2]);
  await refusedFast(() => parseMesh('gltf', gltf({ buffers: [{ byteLength: 12, uri: b64uri(idx) }], bufferViews: [{ buffer: 0, byteLength: 12 }],
    accessors: [{ componentType: 5126, type: 'VEC3', count: 30_000_000 }, { bufferView: 0, componentType: 5125, type: 'SCALAR', count: 3 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], nodes: [{ mesh: 0 }, { mesh: 0 }], scenes: [{ nodes: [0, 1] }] }), 'x.gltf'),
  /x\.gltf places 60,000,000 vertices once its shared parts are repeated, more than the 30,000,000 this viewer opens/, 1000);
  const m3 = (x) => zipStored([['3D/3dmodel.model', enc(`<model unit="millimeter"><resources>${x}</build></model>`)]]);
  let v = '';
  for (let i = 0; i < 50000; i++) v += `<vertex x="${i}" y="0" z="0"/>`;
  let x = '';
  for (let k = 0; k < 10; k++) x += `<object id="${k}"><components><component objectid="${k + 1}"/><component objectid="${k + 1}"/></components></object>`;
  x += `<object id="10"><mesh><vertices>${v}</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="0"/>`;
  await refusedFast(() => parseMesh('3mf', m3(x), 'a.3mf'), /a\.3mf places 51,200,000 vertices once its shared parts are repeated, more than the 30,000,000 this viewer opens/, 1000);
});
await test('r3-7 text past the engine\'s string limit: a 3MF model part inflating to 600 MB and a 600 MB OBJ refused in words before decoding', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const raw = Buffer.alloc(600 * 2 ** 20, 0x20);
  Buffer.from('<?xml version="1.0"?><model unit="millimeter">').copy(raw, 0);
  const z = new Uint8Array(zipStored([['3D/3dmodel.model', deflateRawSync(raw, { level: 9 })]]));
  // (zipStored writes method 0 with csize = usize: the entry made deflated, unpacking to 600 MB)
  const cd = z.length - 22 - (46 + '3D/3dmodel.model'.length);
  const dv = new DataView(z.buffer);
  dv.setUint16(cd + 10, 8, true);
  dv.setUint32(cd + 24, raw.length, true);
  await refusedFast(() => parseMesh('3mf', z.buffer, 'a.3mf'), /a\.3mf: its model part 3D\/3dmodel\.model unpacks to 600 MB, more than the 500 MB of text this viewer reads/, 1000);
  // (the same entry claiming 1 MB unpacked: the inflate stops at the text limit)
  dv.setUint32(cd + 24, 2 ** 20, true);
  await refusedFast(() => parseMesh('3mf', z.buffer, 'a.3mf'), /a\.3mf: its model part 3D\/3dmodel\.model unpacks to over 500 MB, more than the 500 MB of text this viewer reads/, 10000);
  await refusedFast(() => parseMesh('obj', new ArrayBuffer(600 * 2 ** 20), 'big.obj'), /big\.obj is 600 MB of text, more than the 500 MB of text this viewer reads/, 1000);
});
await test('r3-11 glTF sparse accessors: a sparse POSITION with no buffer view, and one over a base view, give the substituted triangle; a sparse index past the count refused', async () => {
  const sidx = new Uint16Array([0, 1, 2, 0]), sval = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = new Uint8Array(44);
  bin.set(new Uint8Array(sidx.buffer), 0); bin.set(new Uint8Array(sval.buffer), 8);
  const sparseTri = (acc0, extraViews = [], extraBin = new Uint8Array(0)) => {
    const all = new Uint8Array(bin.length + extraBin.length);
    all.set(bin); all.set(extraBin, bin.length);
    return gltf({ buffers: [{ byteLength: all.length, uri: b64uri(all) }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 6 }, { buffer: 0, byteOffset: 8, byteLength: 36 }, ...extraViews],
      accessors: [acc0], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] });
  };
  const m = await parseMesh('gltf', sparseTri({ componentType: 5126, type: 'VEC3', count: 3, sparse: { count: 3, indices: { bufferView: 0, componentType: 5123 }, values: { bufferView: 1 } } }), 'a.gltf');
  assert.equal(m.meshes.length, 1);
  assert.equal(m.meshes[0].positions.length / 3, 3, 'vertices');
  assert.equal(m.meshes[0].indices.length, 3, 'triangle corners');
  assert.deepEqual([...m.meshes[0].positions], [0, 0, 0, 1000, 0, 0, 0, 1000, 0]);
  // a base view (a triangle) with only its third vertex substituted, to (0, 2, 0)
  const base = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), one = new Uint8Array(new Float32Array([0, 2, 0]).buffer);
  const extra = new Uint8Array(36 + 4 + 12);
  extra.set(new Uint8Array(base.buffer), 0); extra[36] = 2; extra.set(one, 40);
  const m2 = await parseMesh('gltf', sparseTri({ bufferView: 2, componentType: 5126, type: 'VEC3', count: 3, sparse: { count: 1, indices: { bufferView: 3, componentType: 5121 }, values: { bufferView: 4 } } },
    [{ buffer: 0, byteOffset: 44, byteLength: 36 }, { buffer: 0, byteOffset: 80, byteLength: 1 }, { buffer: 0, byteOffset: 84, byteLength: 12 }], extra), 'b.gltf');
  assert.equal(m2.meshes[0].positions.length / 3, 3, 'vertices');
  assert.equal(m2.meshes[0].indices.length, 3, 'triangle corners');
  assert.deepEqual([...m2.meshes[0].positions], [0, 0, 0, 1000, 0, 0, 0, 2000, 0]);
  // an index past the accessor's count, and a sparse count past it
  const bad = new Uint16Array([0, 1, 7, 0]);
  const binBad = bin.slice(); binBad.set(new Uint8Array(bad.buffer), 0);
  await refusedFast(() => parseMesh('gltf', gltf({ buffers: [{ byteLength: 44, uri: b64uri(binBad) }], bufferViews: [{ buffer: 0, byteLength: 6 }, { buffer: 0, byteOffset: 8, byteLength: 36 }],
    accessors: [{ componentType: 5126, type: 'VEC3', count: 3, sparse: { count: 3, indices: { bufferView: 0, componentType: 5123 }, values: { bufferView: 1 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }] }), 'x.gltf'), /x\.gltf is damaged: accessor 0's sparse index 7 is past its 3 elements/);
  await refusedFast(() => parseMesh('gltf', sparseTri({ componentType: 5126, type: 'VEC3', count: 3, sparse: { count: 4, indices: { bufferView: 0, componentType: 5123 }, values: { bufferView: 1 } } }), 'x.gltf'),
    /x\.gltf is damaged: accessor 0's sparse count 4 is not 1 to its 3 elements/);
});
await test('r3-12 a glTF with no "scenes": the roots are the nodes no node names as a child (a child is placed once, under its parent)', async () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const model = await parseMesh('gltf', gltf({ buffers: [{ byteLength: 36, uri: b64uri(new Uint8Array(pos.buffer)) }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ name: 'parent', children: [1], translation: [1, 0, 0] }, { name: 'child', mesh: 0 }] }), 'a.gltf');
  assert.equal(model.meshes.length, 1, 'bodies');
  assert.equal(model.meshes[0].positions.length / 3, 3, 'vertices');
  assert.equal(model.meshes[0].indices.length, 3, 'triangle corners');
  assert.equal(model.root.children.length, 1, 'roots');
  assert.equal(model.root.children[0].name, 'parent');
  assert.equal(model.root.children[0].children[0].name, 'child');
  assert.deepEqual([...model.meshes[0].positions], [1000, 0, 0, 2000, 0, 0, 1000, 1000, 0]);
});
await test('r3-13 3MF and glTF whose every triangle collapses: "has no triangles to show", as the other readers say', async () => {
  await refusedFast(() => parseMesh('gltf', gltf({ accessors: [{ componentType: 5126, type: 'VEC3', count: 3 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] }), 'z.gltf'), /z\.gltf has no triangles to show \(every triangle has no area\)/);
  const z = zipStored([['3D/3dmodel.model', enc('<model unit="millimeter"><resources><object id="1"><mesh><vertices><vertex x="1" y="1" z="1"/><vertex x="1" y="1" z="1"/><vertex x="1" y="1" z="1"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>')]]);
  await refusedFast(() => parseMesh('3mf', z, 'z.3mf'), /z\.3mf has no triangles to show \(every triangle has no area\)/);
});
await test('r3-14 an ASCII STL vertex line of fewer than 3 numbers: refused as damaged, not every later coordinate shifted', async () => {
  await refusedFast(() => parseMesh('stl', enc('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n'), 'a.stl'),
    /a\.stl is damaged: "vertex 1 0" is not three numbers/);
});

// --- review round 4 ---
// a zip of one deflated entry (zipStored's entry made method 8, its unpacked size given)
async function zipDeflated(name, raw) {
  const { deflateRawSync } = await import('node:zlib');
  const z = new Uint8Array(zipStored([[name, deflateRawSync(raw, { level: 9 })]]));
  const cd = z.length - 22 - (46 + name.length);
  const dv = new DataView(z.buffer);
  dv.setUint16(cd + 10, 8, true);
  dv.setUint32(cd + 24, raw.length, true);
  return z.buffer;
}
await test('r4-3 an ASCII STL holding 64 KB of blank lines: refused at once (the record regex\'s \\s* crossed newlines from every line start)', async () => {
  await refusedFast(() => parseMesh('stl', enc(`solid a\n${'\n'.repeat(64 * 1024)}${' \t\r\n'.repeat(16 * 1024)}x\n`), 'a.stl'), /a\.stl has no triangles to show/, 1000);
});
await test('r4-4 a 3MF model part of 200 MB of "<a/>" tags, and one of 10 M + 1 triangles: refused in words, not the heap run out by one object per tag', async () => {
  const flood = await zipDeflated('3D/3dmodel.model', Buffer.alloc(200 * 2 ** 20, '<a/>'));
  // (most of the bound is inflating and decoding the 200 MB part: 0.56 s measured)
  await refusedFast(() => parseMesh('3mf', flood, 'a.3mf'), /a\.3mf has no triangles to show/, 2500);
  const head = '<model unit="millimeter"><resources><object id="1"><mesh><triangles>';
  const n = 10_000_001, t = '<triangle/>';
  const tris = await zipDeflated('3D/3dmodel.model', Buffer.concat([Buffer.from(head), Buffer.alloc(n * t.length, t)]));
  await refusedFast(() => parseMesh('3mf', tris, 'b.3mf'), /b\.3mf holds more than the 10,000,000 triangles this viewer opens/, 5000);
});
await test('r4-5 an OBJ of 4 MB of "g" lines and an STL of 32 MB of "solid" lines: no body per empty group, refused at once', async () => {
  await refusedFast(() => parseMesh('obj', Buffer.alloc(4 * 2 ** 20, 'g\n').buffer, 'x.obj'), /x\.obj has no triangles to show/, 1500);
  await refusedFast(() => parseMesh('stl', Buffer.alloc(32 * 2 ** 20, 'solid\n').buffer, 'x.stl'), /x\.stl has no triangles to show/, 1500);
  // (a group named before its faces still names the body; an empty group between two is dropped)
  const m = await parseMesh('obj', enc('v 0 0 0\nv 1 0 0\nv 0 1 0\ng empty\ng tri\nf 1 2 3\ng after\n'), 'n.obj');
  assert.equal(m.meshes.length, 1);
  assert.equal(m.meshes[0].name, 'tri');
  const s = await parseMesh('stl', enc('solid none\nendsolid none\nsolid one\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid one\n'), 's.stl');
  assert.equal(s.meshes.length, 1);
  assert.equal(s.meshes[0].name, 'one');
});
await test('r4-11 a 199-byte glTF whose POSITION counts 30 M with no buffer view: no geometry, said so at once (it was allocated and walked as zeros)', async () => {
  await refusedFast(() => parseMesh('gltf', gltf({ accessors: [{ componentType: 5126, type: 'VEC3', count: 30_000_000 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] }), 'x.gltf'), /x\.gltf has no triangles to show \(every triangle has no area\)/, 1000);
  // (indices with no buffer view are all vertex 0: no triangle either)
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  await refusedFast(() => parseMesh('gltf', gltf({ buffers: [{ byteLength: 36, uri: b64uri(new Uint8Array(pos.buffer)) }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 }, { componentType: 5125, type: 'SCALAR', count: 9_000_000 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], nodes: [{ mesh: 0 }] }), 'y.gltf'), /y\.gltf has no triangles to show \(every triangle has no area\)/, 1000);
});
await test('r4-12 a glTF buffer uri with a bad % escape, and a data: uri that does not decode: "damaged", not URIError or "fetch failed"', async () => {
  await refusedFast(() => parseMesh('gltf', gltf({ buffers: [{ uri: 'a%zz.bin', byteLength: 4 }] }), 'x.gltf'), /x\.gltf is damaged: buffer 0's uri "a%zz\.bin" cannot be read/);
  await refusedFast(() => parseMesh('gltf', gltf({ buffers: [{ uri: 'data:application/octet-stream;base64,%%%', byteLength: 4 }] }), 'x.gltf'),
    /x\.gltf is damaged: buffer 0's uri "data:application\/octet-stream;base64,%%%" cannot be read/);
});
await test('r4-14 PLY and glTF refusals name the file with its extension, in the "is damaged" form', async () => {
  await refusedFast(() => parseMesh('ply', enc('ply\nformat ascii 1.0\n'), 'x.ply'), /x\.ply is damaged: it has no end_header line/);
  await refusedFast(() => parseMesh('gltf', enc('null'), 'x.gltf'), /x\.gltf is damaged: it holds no glTF JSON/);
  const glbNoJson = new ArrayBuffer(12);
  new DataView(glbNoJson).setUint32(0, 0x46546c67, true);
  await refusedFast(() => parseMesh('glb', glbNoJson, 'x.glb'), /x\.glb is damaged: it holds no glTF JSON/);
  await refusedFast(() => parseMesh('gltf', gltf({ buffers: [{ byteLength: 4 }] }), 'x.gltf'), /x\.gltf is damaged: buffer 0 has no data/);
  await refusedFast(() => parseMesh('gltf', gltf({ scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ componentType: 5126, type: 'MAT4', count: 2 ** 23 }, { componentType: 5125, type: 'SCALAR', count: 3 }] }), 'x.gltf'),
  /x\.gltf: accessor 0 holds 134,217,728 values, more than the 90,000,000 this viewer reads/);
});

// --- review round 5 ---
await test('r5-4 weld: a fan of 30 k distinct but collinear (zero-area) triangles about one vertex welds in linear time, one shared group per vertex', async () => {
  // vertices k,0,0 for k = 0..N+1 and Q = (0,1,0); triangles (0, j, j+1), j = 1..N, have no area
  // but distinct corners; one real triangle (0, 1, Q). Each zero-area triangle joins its corner's
  // one no-normal group: vertices 0 and 1 hold that group and the real one, 2..N+1 the one, Q the
  // real one -- N + 5 (each such triangle opened a group per corner, every one searched: quadratic)
  const N = 30000;
  const pos = [];
  for (let k = 0; k <= N + 1; k++) pos.push(k, 0, 0);
  pos.push(0, 1, 0);
  const tri = [];
  for (let j = 1; j <= N; j++) tri.push(0, j, j + 1);
  tri.push(0, 1, N + 2);
  const t0 = Date.now();
  const m = weld({ name: 'fan', pos, tri });
  const dt = Date.now() - t0;
  assert.equal(m.indices.length, 3 * (N + 1), 'triangle corners');
  assert.equal(m.positions.length / 3, N + 5, 'vertices');
  // the real triangle's corners keep its own normal, +-z
  const last = 3 * N;
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(Math.abs(m.normals[m.indices[last + c] * 3 + 2]) - 1) < 1e-6, `corner ${c} normal`);
  assert.ok(dt < 1000, `${dt} ms`);
});
await test('r5-5 OBJ: 3000 "mtllib" lines naming one 2000-material MTL read it once, and its colour still applies', async () => {
  const m = [];
  for (let k = 0; k < 2000; k++) m.push(`newmtl m${k}`, k === 1999 ? 'Kd 0.5 0.25 1' : 'Kd 0.1 0.2 0.3');
  const files = new Map([['a.mtl', enc(m.join('\n'))]]);
  const L = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0'];
  for (let k = 0; k < 3000; k++) L.push('mtllib a.mtl');
  L.push('usemtl m1999', 'f 1 2 3');
  const t0 = Date.now();
  const model = await parseMesh('obj', enc(L.join('\n')), 'm.obj', files);
  const dt = Date.now() - t0;
  assert.ok(near(model.meshes[0].color, [0.5, 0.25, 1]), `colour ${model.meshes[0].color}`);
  assert.ok(dt < 1000, `${dt} ms`);
});
await test('r5-9 OBJ, OFF and PLY past the triangle / vertex caps (as 3MF and glTF): refused in words before the memory is spent', async () => {
  // OBJ: one face of 10,000,003 corners alternating two vertices: 10,000,001 triangles in 20 MB
  const objFace = Buffer.concat([Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1'), Buffer.alloc(4 * 5_000_001, ' 2 3'), Buffer.from('\n')]);
  await refusedFast(() => parseMesh('obj', objFace.buffer.slice(objFace.byteOffset, objFace.byteOffset + objFace.length), 'x.obj'),
    /x\.obj holds more than the 10,000,000 triangles this viewer opens/, 1000);
  // OBJ: 30,000,001 "v" lines
  await refusedFast(() => parseMesh('obj', Buffer.alloc(2 * 30_000_001, 'v\n').buffer, 'x.obj'), /x\.obj holds more than the 30,000,000 vertices this viewer opens/, 1500);
  // OFF: one face of 10,000,003 corners
  const offFace = Buffer.concat([Buffer.from('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n10000003'), Buffer.alloc(2 * 10_000_003, ' 1'), Buffer.from('\n')]);
  await refusedFast(() => parseMesh('off', offFace.buffer.slice(offFace.byteOffset, offFace.byteOffset + offFace.length), 'x.off'),
    /x\.off holds more than the 10,000,000 triangles this viewer opens/, 2000);
  // PLY: 40 M vertex records with no properties (charged a byte each, none read): no x, y, z
  const hdr = enc('ply\nformat binary_little_endian 1.0\nelement vertex 40000000\nend_header\n');
  const e = new Uint8Array(hdr.byteLength + 40_000_000);
  e.set(new Uint8Array(hdr));
  await refusedFast(() => parseMesh('ply', e.buffer, 'e.ply'), /e\.ply is damaged: its vertex element has no x, y, z properties/, 1000);
  // PLY: three vertices and one face listing 10,000,003 corners: refused at the list's count
  const fh = enc('ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list int int vertex_indices\nend_header\n');
  const nc = 10_000_003;
  const f = new Uint8Array(fh.byteLength + 36 + 4 + 4 * nc);
  f.set(new Uint8Array(fh));
  const dv = new DataView(f.buffer);
  dv.setFloat32(fh.byteLength + 12, 1, true); dv.setFloat32(fh.byteLength + 28, 1, true);
  dv.setInt32(fh.byteLength + 36, nc, true);
  for (let i = 0; i < nc; i++) dv.setInt32(fh.byteLength + 40 + 4 * i, 1 + (i % 2), true);
  await refusedFast(() => parseMesh('ply', f.buffer, 'f.ply'), /f\.ply holds more than the 10,000,000 triangles this viewer opens/, 1000);
});
await test('r5-10 a glTF node or mesh name that is not text: the default name is taken, and the model encodes and decodes', async () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const model = await parseMesh('gltf', gltf({ buffers: [{ byteLength: 36, uri: b64uri(new Uint8Array(pos.buffer)) }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 }], meshes: [{ name: { x: 1 }, primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0, name: 42 }], scenes: [{ nodes: [0] }] }), 'n.gltf');
  assert.equal(model.root.children[0].name, 'node 0');
  assert.equal(model.meshes[0].name, 'node 0');
  const back = decodeCadmesh(encodeCadmesh(model));
  assert.equal(back.header.meshes.length, 1);
});
await test('r5-11 every refusal names the file with its extension: STL, OBJ, glTF placements / coordinates / no triangles, 3MF zip; the tree root keeps the bare name', async () => {
  await refusedFast(() => parseMesh('stl', enc('solidx\nendfacet\n'), 'a.stl'), /^a\.stl has no triangles to show/);
  await refusedFast(() => parseMesh('obj', enc('g\n'), 'x.obj'), /^x\.obj has no triangles to show/);
  const dag = [];
  for (let i = 0; i < 40; i++) dag.push({ children: [i + 1, i + 1] });
  dag.push({});
  await refusedFast(() => parseMesh('gltf', gltf({ scenes: [{ nodes: [0] }], nodes: dag }), 'x.gltf'), /^x\.gltf places 2,199,023,255,551 parts/);
  const nan = new Uint8Array(36).fill(0xff);
  await refusedFast(() => parseMesh('gltf', gltf({ buffers: [{ byteLength: 36, uri: b64uri(nan) }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] }), 'e.gltf'), /^e\.gltf is damaged: a vertex coordinate is not a number/);
  await refusedFast(() => parseMesh('gltf', gltf({ accessors: [{ componentType: 5126, type: 'VEC3', count: 3 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] }), 'z.gltf'), /^z\.gltf has no triangles to show/);
  await refusedFast(() => parseMesh('3mf', enc('not a zip at all, just some text'), 'a.3mf'), /^a\.3mf: not a zip file/);
  const m = await parseMesh('obj', enc('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), 'n.obj');
  assert.equal(m.root.name, 'n');
});

// --- review round 6: valid files read wrongly ---
// the distinct colours (bytes) of a welded body's vertices, sorted
const colourSet = (m) => {
  assert.ok(m.colors, 'per-vertex colours');
  const s = new Set();
  for (let i = 0; i < m.colors.length; i += 4) s.add(`${m.colors[i]},${m.colors[i + 1]},${m.colors[i + 2]}`);
  return [...s].sort();
};
const offText = (head, vtx, face) => enc(`${head}\n8 12 0\n${C.map((p, i) => `${p.join(' ')}${vtx(i)}`).join('\n')}\n${TRIS.map((t, i) => `3 ${t.join(' ')}${face(i)}`).join('\n')}\n`);
await test('r6-1 OFF faces carrying a colour after their indices: all 12 triangles, the colour used (0-255 integers and 0..1 floats)', async () => {
  // (the colour was read as the next face's count: 4 of 12 triangles, or refused as damaged)
  const red = cube(await parseMesh('off', offText('OFF', () => '', () => ' 255 0 0 255'), 'c.off'));
  assert.ok(near(red.color, [1, 0, 0]), `colour ${red.color}`);
  const blue = cube(await parseMesh('off', offText('OFF', () => '', () => ' 0.0 0.0 1.0'), 'c.off'));
  assert.ok(near(blue.color, [0, 0, 1]), `colour ${blue.color}`);
  // two colours: the first 6 triangles red, the rest green, kept apart per vertex
  const two = cube(await parseMesh('off', offText('OFF', () => '', (i) => (i < 6 ? ' 255 0 0' : ' 0 255 0')), 'c.off'));
  assert.deepEqual(colourSet(two), ['0,255,0', '255,0,0']);
  // (a face with a colour on some faces only: the others the default grey)
  const some = cube(await parseMesh('off', offText('OFF', () => '', (i) => (i < 6 ? ' 255 0 0' : '')), 'c.off'));
  assert.deepEqual(colourSet(some), ['184,189,199', '255,0,0']);
});
await test('r6-2 COFF / NOFF / CNOFF / STCNOFF: the per-vertex normal, colour and texture values skipped, the vertex colours used', async () => {
  // (every such file was refused: the extras were read as the next vertex and the faces)
  const coff = cube(await parseMesh('off', offText('COFF', () => ' 0 255 0 255', () => ''), 'c.off'));
  assert.ok(near(coff.color, [0, 1, 0]), `COFF colour ${coff.color}`);
  const coff3 = cube(await parseMesh('off', offText('COFF', () => ' 0.0 0.0 1.0', () => ''), 'c.off'));
  assert.ok(near(coff3.color, [0, 0, 1]), `COFF float colour ${coff3.color}`);
  const noff = cube(await parseMesh('off', offText('NOFF', () => ' 0 0 1', () => ''), 'c.off'));
  assert.equal(noff.color, null);
  // normal (3) before colour (4); then texture (2)
  const cnoff = cube(await parseMesh('off', offText('CNOFF', () => ' 0 0 1 255 0 0 255', () => ''), 'c.off'));
  assert.ok(near(cnoff.color, [1, 0, 0]), `CNOFF colour ${cnoff.color}`);
  const st = cube(await parseMesh('off', offText('STCNOFF', () => ' 0 0 1 255 255 0 255 0.5 0.5', () => ''), 'c.off'));
  assert.ok(near(st.color, [1, 1, 0]), `STCNOFF colour ${st.color}`);
  // a face colour wins over the vertex colours
  const both = cube(await parseMesh('off', offText('COFF', () => ' 0 255 0 255', () => ' 0 0 255'), 'c.off'));
  assert.ok(near(both.color, [0, 0, 1]), `face over vertex ${both.color}`);
});
await test('r6-3 3MF production extension (Bambu / Orca): a component naming its object in another model part by p:path is read from that part', async () => {
  const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';
  const main = enc(`<?xml version="1.0"?><model unit="millimeter" ${NS}><resources><object id="2" name="plate part" type="model"><components>`
    + '<component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object></resources>'
    + '<build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build></model>');
  // (the part has its own ids: an object 2 there is not the main part's object 2)
  const part = enc(`<?xml version="1.0"?><model unit="millimeter" ${NS}><resources><basematerials id="5"><base name="green" displaycolor="#00FF00"/></basematerials>`
    + `<object id="2" name="decoy"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`
    + `<object id="1" name="cube" type="model" pid="5" pindex="0"><mesh><vertices>${C.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices>`
    + `<triangles>${TRIS.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('')}</triangles></mesh></object></resources><build/></model>`);
  const model = await parseMesh('3mf', zipStored([['_rels/.rels', rels()], ['3D/3dmodel.model', main], ['3D/Objects/object_1.model', part]]), 'bambu.3mf');
  const m = cube(model, [100, 100, 0]);
  assert.ok(near(m.color, [0, 1, 0]), `colour ${m.color}`);
  assert.equal(model.root.children[0].name, 'plate part');
  assert.equal(model.root.children[0].children[0].name, 'cube');
  // a part that is not in the zip: refused in words naming it
  await refusedFast(() => parseMesh('3mf', zipStored([['3D/3dmodel.model', main]]), 'b.3mf'), /b\.3mf is damaged: object 2 names object 1 in \/3D\/Objects\/object_1\.model, which is not there/);
});
await test('r6-4 3MF mirrored placements (negative determinant): the winding flipped, so every normal points out; two mirrors cancel', async () => {
  const m3 = (comp, item) => zipStored([['3D/3dmodel.model', enc(`<model unit="millimeter"><resources>
<object id="1" name="cube"><mesh><vertices>${C.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices>
<triangles>${TRIS.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('')}</triangles></mesh></object>
<object id="2"><components><component objectid="1" transform="${comp}"/></components></object></resources>
<build><item objectid="2" transform="${item}"/></build></model>`)]]);
  const I = '1 0 0 0 1 0 0 0 1 0 0 0', MX = '-1 0 0 0 1 0 0 0 1 0 0 0', MZ = '1 0 0 0 1 0 0 0 -1 0 0 0';
  cube(await parseMesh('3mf', m3(I, MX), 'a.3mf'), [-10, 0, 0]); // the item mirrored
  cube(await parseMesh('3mf', m3(MZ, I), 'a.3mf'), [0, 0, -10]); // the component mirrored
  cube(await parseMesh('3mf', m3(MZ, MX), 'a.3mf'), [-10, 0, -10]); // both: no flip
  // the mirrored part's triangle 0 is wound reversed from the file's (0 2 3 -> 0 3 2), by its geometric normal
  const m = (await parseMesh('3mf', m3(I, MX), 'a.3mf')).meshes[0];
  const P = (i) => [0, 1, 2].map((k) => m.positions[m.indices[i] * 3 + k]);
  const [a, b, c] = [P(0), P(1), P(2)];
  const u = [0, 1, 2].map((k) => b[k] - a[k]), v = [0, 1, 2].map((k) => c[k] - a[k]);
  assert.ok(u[0] * v[1] - u[1] * v[0] < 0, 'the bottom face (z = 0) faces -z');
});
await test('r6-5 glTF triangle strips (mode 5) and fans (mode 6): expanded to triangles facing the way the file winds them, beside a list in one mesh', async () => {
  // a unit square in z = 0 facing +z: strip order 0 (0,0) 1 (1,0) 2 (0,1) 3 (1,1); fan order around (0,0)
  const strip = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), fan = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const sidx = new Uint16Array([0, 1, 2, 3]);
  const tri = new Float32Array([5, 0, 0, 6, 0, 0, 5, 1, 0]);
  const bin = new Uint8Array(48 + 48 + 8 + 36);
  bin.set(new Uint8Array(strip.buffer), 0); bin.set(new Uint8Array(fan.buffer), 48); bin.set(new Uint8Array(sidx.buffer), 96); bin.set(new Uint8Array(tri.buffer), 104);
  const base = { buffers: [{ byteLength: bin.length, uri: b64uri(bin) }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 0, byteOffset: 96, byteLength: 8 }, { buffer: 0, byteOffset: 104, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 4 }, { bufferView: 1, componentType: 5126, type: 'VEC3', count: 4 },
      { bufferView: 2, componentType: 5123, type: 'SCALAR', count: 4 }, { bufferView: 3, componentType: 5126, type: 'VEC3', count: 3 }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] };
  const upward = (m, n) => {
    assert.equal(m.indices.length, 3 * n, 'triangle corners');
    for (let v = 0; v < m.normals.length; v += 3) assert.ok(Math.abs(m.normals[v + 2] - 1) < 1e-6, `normal ${[...m.normals.slice(v, v + 3)]}`);
  };
  // the indexed strip, and the unindexed fan
  const s = await parseMesh('gltf', gltf({ ...base, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 2, mode: 5 }] }] }), 's.gltf');
  upward(s.meshes[0], 2);
  assert.equal(s.meshes[0].positions.length / 3, 4, 'vertices');
  const f = await parseMesh('gltf', gltf({ ...base, meshes: [{ primitives: [{ attributes: { POSITION: 1 }, mode: 6 }] }] }), 'f.gltf');
  upward(f.meshes[0], 2);
  // one mesh of a list, a strip and a fan: three bodies, none dropped
  const mix = await parseMesh('gltf', gltf({ ...base, meshes: [{ primitives: [{ attributes: { POSITION: 3 } }, { attributes: { POSITION: 0 }, indices: 2, mode: 5 }, { attributes: { POSITION: 1 }, mode: 6 }] }] }), 'm.gltf');
  assert.equal(mix.meshes.length, 3, 'bodies');
  upward(mix.meshes[0], 1); upward(mix.meshes[1], 2); upward(mix.meshes[2], 2);
  // (points and lines are still not drawn)
  await refusedFast(() => parseMesh('gltf', gltf({ ...base, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 2, mode: 1 }] }] }), 'l.gltf'), /l\.gltf has no triangles to show/);
});
await test('r6-6 PLY colour scale by the property type: uchar 0/1 values are bytes (near black), float 1 is full, ushort is out of 65535', async () => {
  const ply = (ty, vals) => enc(`ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\nproperty ${ty} red\nproperty ${ty} green\nproperty ${ty} blue\nelement face 12\nproperty list uchar int vertex_indices\nend_header\n${C.map((p) => `${p.join(' ')} ${vals}`).join('\n')}\n${TRIS.map((t) => `3 ${t.join(' ')}`).join('\n')}\n`);
  assert.deepEqual(colourSet(cube(await parseMesh('ply', ply('uchar', '1 1 0'), 'd.ply'))), ['1,1,0']);
  assert.deepEqual(colourSet(cube(await parseMesh('ply', ply('float', '1 1 0'), 'd.ply'))), ['255,255,0']);
  assert.deepEqual(colourSet(cube(await parseMesh('ply', ply('ushort', '65535 0 32896'), 'd.ply'))), ['255,0,128']);
});

done();
