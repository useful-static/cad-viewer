#!/usr/bin/env node
// The mesh file readers (js/mesh-formats.js): a 10 mm cube in each format,
// built here, maps to one body of 12 triangles whose 8 corners are split by
// the 30° crease into 24 vertices, 10 mm on a side, named and coloured as
// the file says; and the model encodes as a .cadmesh.
//   node tests/test-mesh-formats.mjs [name-part]   (exit 0 = all pass; a name-part runs only the arms whose name holds it)

import assert from 'node:assert/strict';
import { meshFormatOf, parseMesh, unzip, weld } from '../js/mesh-formats.js';
import { MM, encodeCadmesh, decodeCadmesh } from '../js/cadmesh.js';

let passed = 0;
let failed = 0;
const ONLY = process.argv[2];
async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  try { await fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

// a hostile file is refused in the reader's own words, quickly: never an engine message
const ENGINE = /Cannot read|is not a function|RangeError|Invalid array length|out of bounds|outside the bounds|is not iterable/;
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
  await refusedFast(() => parseMesh('gltf', gltf({ scenes: [{ nodes: [0] }], nodes: dag }), 'x.gltf'), /x places 2,199,023,255,551 parts once its shared parts are repeated, more than the 2,000,000 this viewer opens/);
  // 30 k triangles under 10 levels of two-way sharing: 30.7 M triangles placed
  const fan = [];
  for (let i = 0; i < 10; i++) fan.push({ children: [i + 1, i + 1] });
  fan.push({ mesh: 0 });
  await refusedFast(() => parseMesh('gltf', gltf({ scenes: [{ nodes: [0] }], nodes: fan, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ componentType: 5126, type: 'VEC3', count: 90000 }] }), 'x.gltf'), /x places 30,720,000 triangles once its shared parts are repeated, more than the 10,000,000 this viewer opens/);
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
  // (one triangle by its indices, so the placed-triangle count passes and the accessor itself is met)
  await refusedFast(() => parseMesh('gltf', gltf({ ...prim, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ componentType: 5126, type: 'VEC3', count: 2 ** 30 }, { componentType: 5125, type: 'SCALAR', count: 3 }] }), 'x.gltf'),
  /x: accessor 0 holds 3,221,225,472 values, more than the 90,000,000 this viewer reads/);
  // (under the cap, a count its buffer view cannot hold is refused before the 400 MB it asks for)
  await refusedFast(() => parseMesh('gltf', gltf({ ...prim, buffers: [{ uri: 'data:application/octet-stream;base64,AAAAAAAAAAAAAAAA', byteLength: 12 }],
    bufferViews: [{ buffer: 0, byteLength: 12 }], accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 2 ** 24 }] }), 'x.gltf'),
  /x is damaged: accessor 0 reads past the end of its buffer/);
});
await test('glTF/GLB shapes refused in words: a 3-byte GLB, a view past its buffer, a primitive with no attributes, scene nodes and extensionsRequired not lists', async () => {
  await refusedFast(() => parseMesh('glb', new ArrayBuffer(3), 'x.glb'), /x\.glb is damaged: 3 bytes, shorter than a GLB header/);
  await refusedFast(() => parseMesh('gltf', gltf({ buffers: [{ uri: 'data:application/octet-stream;base64,AAAA' }], bufferViews: [{ buffer: 0, byteOffset: 100 }],
    accessors: [{ componentType: 5126, type: 'VEC3', count: 0, bufferView: 0 }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] }), 'x.gltf'),
  /x is damaged: buffer view 0 runs past the end of its buffer/);
  await refusedFast(() => parseMesh('gltf', gltf({ nodes: [{ mesh: 0 }], meshes: [{ primitives: [{}] }] }), 'x.gltf'), /x is damaged: mesh 0 primitive 1 has no attributes/);
  await refusedFast(() => parseMesh('gltf', gltf({ scenes: [{ nodes: 5 }], nodes: [] }), 'x.gltf'), /x is damaged: scene 0's "nodes" is not a list/);
  await refusedFast(() => parseMesh('gltf', gltf({ extensionsRequired: 5 }), 'x.gltf'), /x is damaged: "extensionsRequired" is not a list/);
});
await test('STL and PLY in words: "solidx" then endfacet, a 300 k-vertex facet, an unknown PLY type, a negative list count', async () => {
  await refusedFast(() => parseMesh('stl', enc('solidx\nendfacet\n'), 'a.stl'), /a has no triangles to show/);
  await refusedFast(() => parseMesh('stl', enc(`solid a\n${'vertex 1 2 3\n'.repeat(300000)}endfacet\nendsolid\n`), 'a.stl'), /a has no triangles to show \(every triangle has no area\)/, 5000);
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

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
