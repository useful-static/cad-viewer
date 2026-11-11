#!/usr/bin/env node
// The mesh file readers (js/mesh-formats.js): a 10 mm cube in each format,
// built here, maps to one body of 12 triangles whose 8 corners are split by
// the 30° crease into 24 vertices, 10 mm on a side, named and coloured as
// the file says; and the model encodes as a .cadmesh.
//   node tests/test-mesh-formats.mjs [name-part]   (exit 0 = all pass; a name-part runs only the arms whose name holds it)

import assert from 'node:assert/strict';
import { meshFormatOf, parseMesh, unzip, weld } from '../js/mesh-formats.js';
import { MM, encodeCadmesh, decodeCadmesh } from '../js/cadmesh.js';
import { crc32 } from '../js/crc32.js';
import { shellTurns } from '../js/edges.js';

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
function plyBinary(headText = 'ply\nformat binary_little_endian 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\nelement face 12\nproperty list uchar uint vertex_indices\nend_header\n') {
  const head = enc(headText);
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
    // (its true CRC-32, held since r80 Q4)
    ch.setUint32(0, 0x02014b50, true); ch.setUint32(16, crc32(d), true); ch.setUint32(20, d.length, true); ch.setUint32(24, d.length, true); ch.setUint16(28, n.length, true); ch.setUint32(42, off0, true);
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
await test('every mesh format (STL, OBJ, PLY, OFF, 3MF, GLB) says its geometry is in mm by the header word the viewer converts from (MM)', async () => {
  // (r7-11: this arm checked OFF and PLY only)
  const models = [await parseMesh('stl', stlBinary(), 'cube.stl'), await parseMesh('stl', stlAscii(), 'cube.stl'),
    await parseMesh('obj', obj(), 'cube.obj', new Map([['cube.mtl', mtl()]])), await parseMesh('ply', plyBinary(), 'cube.ply'),
    await parseMesh('off', off(), 'cube.off'), await parseMesh('3mf', zipStored([['_rels/.rels', rels()], ['3D/3dmodel.model', model3mf()]]), 'cube.3mf'),
    await parseMesh('glb', glb(), 'cube.glb')];
  assert.equal(models.length, 7);
  for (const m of models) assert.equal(decodeCadmesh(encodeCadmesh(m)).header.units, MM);
});
await test('an OBJ comment after a statement of numbers ends its line; a name keeps its "#", as its .mtl reads it (r87 Q5, r88 A2)', async () => {
  const t = 'v 0 0 0 # a corner\nv 1 0 0\nv 0 1 0\nf 1 2 3 # face\n';
  // (must fire: "\"f 1 2 3 # face\" refers to vertex # of 3")
  const m = await parseMesh('obj', new TextEncoder().encode(t).buffer, 'a.obj');
  assert.deepEqual([m.meshes.length, m.meshes[0].indices.length], [1, 3]);
  // (must accept: 3ds Max's "Material #25" and a file "part#2.mtl" -- cut at "#", each opened grey)
  const enc = (x) => new TextEncoder().encode(x).buffer;
  const mtl = (name) => enc(`newmtl ${name}\nKd 1 0 0\n`);
  for (const [lib, mat] of [['a.mtl', 'Material #25'], ['a.mtl', 'red#1'], ['part#2.mtl', 'red']]) {
    const obj = `mtllib ${lib}\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl ${mat}\nf 1 2 3\n`;
    const r = await parseMesh('obj', enc(obj), 'a.obj', new Map([[lib.toLowerCase(), mtl(mat)]]));
    assert.deepEqual(r.meshes[0].color.map((c) => Math.round(c * 100) / 100), [1, 0, 0], `${lib} / ${mat}`);
  }
  // (and the .mtl's own statement of numbers ended by its comment, its name kept whole -- must fire:
  // "Kd 0.25 # a grey" and "Kd 1 0 0#red" read no colour, r89 A3)
  for (const [kd, want] of [['Kd 0.25 # a grey', [0.25, 0.25, 0.25]], ['Kd 1 0 0#red', [1, 0, 0]], ['Kd 0 1 0', [0, 1, 0]]]) {
    const obj = 'mtllib a.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl c #1\nf 1 2 3 # a face\n';
    const r = await parseMesh('obj', enc(obj), 'a.obj', new Map([['a.mtl', enc(`newmtl c #1\n${kd}\n`)]]));
    assert.deepEqual(r.meshes[0].color && r.meshes[0].color.map((c) => Math.round(c * 100) / 100), want, kd);
  }
});
await test('STL binary, header starting "solid"', async () => {
  const b = stlBinary();
  assert.equal(meshFormatOf('cube.stl', b), 'stl');
  cube(await parseMesh('stl', b, 'cube.stl'));
});
await test('a closed STL wound inside out is turned round: outward winding and normals (the view drew it all cut face); an open one is kept', async () => {
  const stlOf = (tris) => enc(`solid c\n${tris.map((t) => ` facet normal 0 0 0\n  outer loop\n${t.map((v) => `   vertex ${C[v].join(' ')}`).join('\n')}\n  endloop\n endfacet`).join('\n')}\nendsolid c\n`);
  const vol = (m) => { const P = m.positions, I = m.indices; let V = 0; for (let t = 0; t < I.length; t += 3) { const [a, b, c] = [I[t], I[t + 1], I[t + 2]].map((v) => [P[3 * v], P[3 * v + 1], P[3 * v + 2]]); V += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]); } return V / 6; };
  const inside = (await parseMesh('stl', stlOf(TRIS.map(([a, b, c]) => [a, c, b])), 'c.stl')).meshes[0];
  assert.equal(Math.round(vol(inside)), 1000);
  // every normal looks out: away from the cube's centre
  const P = inside.positions, N = inside.normals;
  for (let v = 0; v < P.length / 3; v++) assert.ok((P[3 * v] - 5) * N[3 * v] + (P[3 * v + 1] - 5) * N[3 * v + 1] + (P[3 * v + 2] - 5) * N[3 * v + 2] > 0, `vertex ${v}`);
  // a cube missing its top, wound inward: open, so its winding is the file's
  const open = (await parseMesh('stl', stlOf(TRIS.filter((_, i) => i !== 2 && i !== 3).map(([a, b, c]) => [a, c, b])), 'c.stl')).meshes[0];
  assert.ok(vol(open) < 0, `open: ${vol(open)}`);
});
await test('the weld turns a shell by the facts\' own closed test, each shell by its own volume (r25 A1, Q4)', async () => {
  // corners facing out: the share of a part's output corners whose normal looks away from its centre
  const facing = (m, c, t0, t1) => {
    let out = 0;
    for (let t = t0; t < t1; t++) for (let k = 0; k < 3; k++) {
      const v = m.indices[t * 3 + k];
      out += [0, 1, 2].reduce((s, j) => s + (m.positions[v * 3 + j] - c[j]) * m.normals[v * 3 + j], 0) > 0 ? 1 : 0;
    }
    return out;
  };
  // a cube (side s at x0) of 12 triangles, own corners, wound out or in
  const cubeAt = (x0, s, inward) => {
    const pos = [], tri = [];
    for (const t of TRIS) for (const v of inward ? [t[0], t[2], t[1]] : t) { tri.push(pos.length / 3); pos.push(x0 + C[v][0] * s / S, C[v][1] * s / S, C[v][2] * s / S); }
    return { pos, tri };
  };
  const join = (...bs) => {
    const pos = [], tri = [];
    for (const b of bs) { const o = pos.length / 3; pos.push(...b.pos); tri.push(...b.tri.map((i) => i + o)); }
    return { name: 'p', pos, tri };
  };
  const factsClosed = (m) => decodeCadmesh(encodeCadmesh({ units: MM, meshes: [m], root: { name: 'p', meshes: [0], children: [] } })).header.facts.closed[0];
  // (a) an inward cube whose top is split at a corner on its front edge (5, 0, 10), the front side
  // not: a T-junction, closed by a triangle of no area along that edge (a polygon fan-triangulated
  // through a collinear corner). The facts count it (closed), so the weld turns the cube; skipped,
  // the cube read open and stayed inward (r27 Q5)
  const A = [0, 0, 10], Bc = [10, 0, 10], Cc = [10, 10, 10], Dc = [0, 10, 10], M = [5, 0, 10];
  const tj = cubeAt(0, 10, false);
  tj.tri.splice(6, 6); // (the top's two triangles, TRIS 2 and 3: their corners left unused)
  for (const t of [[A, M, Dc], [M, Bc, Cc], [M, Cc, Dc], [A, Bc, M]]) for (const p of t) { tj.tri.push(tj.pos.length / 3); tj.pos.push(...p); }
  for (let t = 0; t < tj.tri.length; t += 3) { const x = tj.tri[t + 1]; tj.tri[t + 1] = tj.tri[t + 2]; tj.tri[t + 2] = x; } // (wound inward)
  let m = weld({ name: 'p', ...tj });
  assert.equal(factsClosed(m), true);
  assert.equal(facing(m, [5, 5, 5], 0, 12), 36, 'the T-junction cube: every corner faces out');
  // and with a triangle of no area hanging off an edge (closing nothing): open, by the facts and the weld alike
  m = weld(join(cubeAt(0, 10, true), { pos: [0, 0, 0, 5, 1e-13, 0, 10, 0, 0], tri: [0, 1, 2] }));
  assert.equal(factsClosed(m), false);
  assert.equal(facing(m, [5, 5, 5], 0, 12), 0, 'open: kept as wound');
  // (b) an inward cube with one corner written twice, apart in float64 by 1e-12, one in float32
  const split = cubeAt(0, 10, true);
  const v = split.tri.find((i) => split.pos[i * 3 + 2] === 10);
  split.pos[v * 3 + 2] += 1e-12;
  assert.notEqual(split.pos[v * 3 + 2], 10);
  assert.equal(Math.fround(split.pos[v * 3 + 2]), 10);
  m = weld(split);
  assert.equal(factsClosed(m), true);
  assert.equal(facing(m, [5, 5, 5], 0, 12), 36, 'the cube with a float64-split corner: every corner faces out');
  // (c) two closed parts in one body, one wound out and one in, both ways round in size: each is
  // turned by its own volume (the old rule turned both by the larger's, or neither)
  for (const [sOut, sIn] of [[20, 10], [10, 20]]) {
    m = weld(join(cubeAt(0, sOut, false), cubeAt(100, sIn, true)));
    assert.equal(facing(m, [sOut / 2, sOut / 2, sOut / 2], 0, 12), 36, `outward part ${sOut} beside inward ${sIn}: kept`);
    assert.equal(facing(m, [100 + sIn / 2, sIn / 2, sIn / 2], 12, 24), 36, `inward part ${sIn} beside outward ${sOut}: turned`);
  }
  // (d) an open part beside a closed inward one: the closed one is turned, the open one kept as wound
  const openIn = cubeAt(0, 10, true);
  openIn.tri.splice(6, 6); // its top's two triangles gone
  m = weld(join(cubeAt(100, 10, true), openIn));
  assert.equal(facing(m, [105, 5, 5], 0, 12), 36, 'the closed inward part: turned');
  assert.equal(facing(m, [5, 5, 5], 12, 22), 0, 'the open inward part: kept');
});
await test('the closed test counts edges in typed tables: a closed torus of 2 M triangles in under 1.5 s (r25 Q5)', async () => {
  const N = 1000;
  const pos = new Float32Array(N * N * 3);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const u = (2 * Math.PI * i) / N, w = (2 * Math.PI * j) / N, k = (i * N + j) * 3;
    pos[k] = (10 + 3 * Math.cos(w)) * Math.cos(u); pos[k + 1] = (10 + 3 * Math.cos(w)) * Math.sin(u); pos[k + 2] = 3 * Math.sin(w);
  }
  const tri = new Uint32Array(N * N * 6);
  let p = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const a = i * N + j, b = ((i + 1) % N) * N + j, c = ((i + 1) % N) * N + ((j + 1) % N), d = i * N + ((j + 1) % N);
    tri[p++] = a; tri[p++] = c; tri[p++] = b; tri[p++] = a; tri[p++] = d; tri[p++] = c; // wound in
  }
  const t0 = performance.now();
  const { flip } = shellTurns(pos, tri);
  const ms = performance.now() - t0;
  assert.ok(flip && flip.every((x) => x === 1), 'the inward torus is turned');
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
});
await test('a cavity faces into itself, a part in a cavity out, and parts touching at a corner are shells of their own (r26 A1, A2)', async () => {
  const facing = (m, c, t0, t1) => {
    let out = 0;
    for (let t = t0; t < t1; t++) for (let k = 0; k < 3; k++) {
      const v = m.indices[t * 3 + k];
      out += [0, 1, 2].reduce((s, j) => s + (m.positions[v * 3 + j] - c[j]) * m.normals[v * 3 + j], 0) > 0 ? 1 : 0;
    }
    return out;
  };
  // a cube (side s from corner o) of 12 triangles, own corners, wound out or in
  const cubeAt = (o, s, inward) => {
    const pos = [], tri = [];
    for (const t of TRIS) for (const v of inward ? [t[0], t[2], t[1]] : t) { tri.push(pos.length / 3); pos.push(o[0] + C[v][0] * s / S, o[1] + C[v][1] * s / S, o[2] + C[v][2] * s / S); }
    return { pos, tri };
  };
  const join = (...bs) => {
    const pos = [], tri = [];
    for (const b of bs) { const o = pos.length / 3; pos.push(...b.pos); tri.push(...b.tri.map((i) => i + o)); }
    return { name: 'p', pos, tri };
  };
  const facts = (m) => decodeCadmesh(encodeCadmesh({ units: MM, meshes: [m], root: { name: 'p', meshes: [0], children: [] } })).header.facts;
  // a 10 mm cube with a 4 mm cavity, both wound correctly (the cavity inward): kept as it is
  let m = weld(join(cubeAt([0, 0, 0], 10, false), cubeAt([3, 3, 3], 4, true)));
  assert.equal(facing(m, [5, 5, 5], 0, 12), 36, 'the outer surface faces out');
  assert.equal(facing(m, [5, 5, 5], 12, 24), 0, 'the cavity faces into itself (toward its centre), not into the material');
  assert.equal(Math.round(facts(m).volume[0]), 936, 'volume: 1000 - 64 (round 25 turned the cavity: 1064)');
  // the same body written the other way round throughout (a mirrored placement): both turned
  m = weld(join(cubeAt([0, 0, 0], 10, true), cubeAt([3, 3, 3], 4, false)));
  assert.equal(facing(m, [5, 5, 5], 0, 12), 36);
  assert.equal(facing(m, [5, 5, 5], 12, 24), 0);
  // a part inside the cavity (a die in a box), wound out: kept; and the whole nest written the
  // other way round: all three turned with their outer shell
  m = weld(join(cubeAt([0, 0, 0], 10, false), cubeAt([2, 2, 2], 6, true), cubeAt([4, 4, 4], 2, false)));
  assert.equal(facing(m, [5, 5, 5], 24, 36), 36, 'the part in the cavity faces out');
  assert.equal(facing(m, [5, 5, 5], 12, 24), 0, 'the cavity kept');
  m = weld(join(cubeAt([0, 0, 0], 10, true), cubeAt([2, 2, 2], 6, false), cubeAt([4, 4, 4], 2, true)));
  assert.deepEqual([facing(m, [5, 5, 5], 0, 12), facing(m, [5, 5, 5], 12, 24), facing(m, [5, 5, 5], 24, 36)], [36, 0, 36], 'the mirrored nest: all turned');
  // a part embedded in another (a pin wholly inside a connector's body), both wound out: kept --
  // by its own sign and its depth it read as a cavity, and a board's STL read back turned its pins
  m = weld(join(cubeAt([0, 0, 0], 10, false), cubeAt([4, 4, 4], 2, false)));
  assert.equal(facing(m, [5, 5, 5], 12, 24), 36, 'the embedded part kept');
  // two cubes passing through each other (an STL never booleaned), both wound out: neither turned (r27 A1)
  m = weld(join(cubeAt([0, 0, 0], 10, false), cubeAt([2, 2, 2], 10, false)));
  assert.equal(facing(m, [5, 5, 5], 0, 12) + facing(m, [7, 7, 7], 12, 24), 72, 'neither turned');
  // a box resting on a plate, in either order (r27 Q1)
  for (const parts of [[cubeAt([0, 0, 0], 10, false), cubeAt([2, 2, 10], 3, false)], [cubeAt([2, 2, 10], 3, false), cubeAt([0, 0, 0], 10, false)]]) {
    m = weld(join(...parts));
    assert.equal(m.indices.length / 3, 24);
    const f = decodeCadmesh(encodeCadmesh({ units: MM, meshes: [m], root: { name: 'p', meshes: [0], children: [] } })).header.facts;
    assert.equal(Math.round(f.volume[0]), 1027, 'the plate and the box, neither turned: 1000 + 27');
  }
  // two cubes touching at a corner (1, 1, 1), the one wound out and the other in, both sizes round:
  // each its own shell (joined at a vertex, one was turned by their summed volume)
  for (const [sa, sb] of [[1, 2], [2, 1]]) {
    m = weld(join(cubeAt([1 - sa, 1 - sa, 1 - sa], sa, false), cubeAt([1, 1, 1], sb, true)));
    assert.equal(facing(m, [1 - sa / 2, 1 - sa / 2, 1 - sa / 2], 0, 12), 36, `outward ${sa} touching inward ${sb}: kept`);
    assert.equal(facing(m, [1 + sb / 2, 1 + sb / 2, 1 + sb / 2], 12, 24), 36, `inward ${sb} touching outward ${sa}: turned`);
  }
});
await test('20,000 separate cubes on whole-number corners in one body: shells and their nesting in under 1.5 s (r26)', async () => {
  // (the weld's hash left whole-number floats' zero low bits unmixed: 7.5 s; each shell tested
  // against every other for nesting: 10.7 s)
  const n = 20000, pos = new Float32Array(n * 24), idx = new Uint32Array(n * 36);
  const q4 = (a, b, c, d) => [a, b, c, a, c, d];
  const T = [...q4(0, 2, 3, 1), ...q4(4, 5, 7, 6), ...q4(0, 1, 5, 4), ...q4(2, 6, 7, 3), ...q4(0, 4, 6, 2), ...q4(1, 3, 7, 5)];
  for (let c = 0; c < n; c++) {
    const ox = (c % 100) * 3, oy = Math.floor(c / 100) * 3;
    for (let i = 0; i < 8; i++) { pos[c * 24 + i * 3] = ox + (i & 1); pos[c * 24 + i * 3 + 1] = oy + ((i & 2) >> 1); pos[c * 24 + i * 3 + 2] = (i & 4) >> 2; }
    for (let k = 0; k < 36; k++) idx[c * 36 + k] = c * 8 + T[k];
  }
  const t0 = performance.now();
  const { shell, flip } = shellTurns(pos, idx);
  const ms = performance.now() - t0;
  assert.equal(new Set(shell).size, n);
  assert.equal(flip, null, 'every cube wound out: none turned');
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
});
await test('nesting stays fast: 20,000 cubes stacked along y with one wide slab under them, and 2,000 parts in a 200 k-triangle hollow enclosure (r27 A4, Q2, Q3)', async () => {
  const q4 = (a, b, c, d) => [a, b, c, a, c, d];
  const T = [...q4(0, 2, 3, 1), ...q4(4, 5, 7, 6), ...q4(0, 1, 5, 4), ...q4(2, 6, 7, 3), ...q4(0, 4, 6, 2), ...q4(1, 3, 7, 5)];
  const boxes = (list) => {
    const pos = new Float32Array(list.length * 24), idx = new Uint32Array(list.length * 36);
    list.forEach(([o, s], c) => {
      for (let i = 0; i < 8; i++) for (let k = 0; k < 3; k++) pos[c * 24 + i * 3 + k] = o[k] + ((i >> k) & 1) * s[k];
      for (let k = 0; k < 36; k++) idx[c * 36 + k] = c * 8 + T[k];
    });
    return { pos, idx };
  };
  // (an index on x alone: 7.0 s for the column, and a wide slab under a grid of parts each against each again)
  const col = Array.from({ length: 20000 }, (_, i) => [[0, 3 * i, 0], [1, 1, 1]]);
  col.push([[-5, -5, -3], [10, 60010, 1]]);
  let b = boxes(col);
  let t0 = performance.now();
  let r = shellTurns(b.pos, b.idx);
  assert.equal(r.flip, null);
  assert.ok(performance.now() - t0 < 1500, `the column: ${(performance.now() - t0).toFixed(0)} ms`);
  // a hollow sphere of two UV spheres, 100 k triangles each, around 2,000 cubes: every part's points
  // against every triangle of the enclosure was 149.6 s for 2.02 M triangles
  const sphere = (r0, inward) => {
    const U = 250, V = 200, pos = [], idx = [];
    for (let i = 0; i <= V; i++) for (let j = 0; j < U; j++) { const th = (Math.PI * i) / V, ph = (2 * Math.PI * j) / U; pos.push(r0 * Math.sin(th) * Math.cos(ph), r0 * Math.sin(th) * Math.sin(ph), r0 * Math.cos(th)); }
    const at = (i, j) => i * U + (j % U);
    for (let i = 0; i < V; i++) for (let j = 0; j < U; j++) {
      const a = at(i, j), bb = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      const tri = [[a, bb, c], [a, c, d]];
      for (const t of tri) idx.push(...(inward ? [t[0], t[2], t[1]] : t));
    }
    return { pos, idx };
  };
  const inner = boxes(Array.from({ length: 2000 }, (_, i) => [[(i % 20) * 2 - 20, Math.floor(i / 20) % 10 * 2 - 10, Math.floor(i / 200) * 2 - 10], [1, 1, 1]]));
  const parts = [sphere(60, false), sphere(58, true), { pos: Array.from(inner.pos), idx: Array.from(inner.idx) }];
  const pos = [], idx = [];
  for (const p of parts) { const o = pos.length / 3; for (const x of p.pos) pos.push(x); for (const v of p.idx) idx.push(v + o); }
  t0 = performance.now();
  r = shellTurns(Float32Array.from(pos), Uint32Array.from(idx));
  const ms = performance.now() - t0;
  assert.equal(r.flip, null, 'all wound as they lie: none turned');
  assert.ok(ms < 5000, `the enclosure: ${ms.toFixed(0)} ms`);
});
await test('parts face to face (edges used four times) are one branched shell, never turned (r27 Q4)', async () => {
  // three cubes in a row sharing whole faces, each wound out: a branched shell kept as written
  const pos = [], tri = [];
  for (let k = 0; k < 3; k++) for (const t of TRIS) for (const v of t) { tri.push(pos.length / 3); pos.push(C[v][0] + 10 * k, C[v][1], C[v][2]); }
  const m = weld({ name: 'row', pos, tri });
  const rev = (a) => { const out = a.slice(); for (let t = 0; t < out.length; t += 3) { const x = out[t + 1]; out[t + 1] = out[t + 2]; out[t + 2] = x; } return out; };
  const P32 = Float32Array.from(pos);
  assert.equal(shellTurns(P32, Uint32Array.from(tri)).flip, null, 'wound out: kept');
  assert.equal(shellTurns(P32, Uint32Array.from(rev(tri))).flip, null, 'wound in: kept too (its 36 triangles split into closed pieces, 4 of them turned)');
  assert.equal(m.indices.length / 3, 36);
});
await test('a closed cylinder with fan caps (a hub vertex of 64 edges, past the short-list sort) is closed (r26 Q2)', async () => {
  // 64 segments; each cap a fan about its centre: the centre's edge list is 128 long
  const n = 64, pos = [0, 0, 0, 0, 0, 5], tri = [];
  for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; pos.push(3 * Math.cos(a), 3 * Math.sin(a), 0, 3 * Math.cos(a), 3 * Math.sin(a), 5); }
  const b = (i) => 2 + 2 * (i % n), t = (i) => 3 + 2 * (i % n);
  for (let i = 0; i < n; i++) tri.push(0, b(i + 1), b(i), 1, t(i), t(i + 1), b(i), b(i + 1), t(i + 1), b(i), t(i + 1), t(i));
  // with the fan centres the same vertex for every triangle of a cap (one weld id)
  const m = weld({ name: 'cyl', pos, tri });
  const f = decodeCadmesh(encodeCadmesh({ units: MM, meshes: [m], root: { name: 'c', meshes: [0], children: [] } })).header.facts;
  assert.equal(f.closed[0], true);
  assert.ok(Math.abs(f.volume[0] - Math.PI * 9 * 5) / (Math.PI * 45) < 0.01, `volume ${f.volume[0]}`);
});

await test('the weld joins positions equal in float32, as the facts do: a corner written twice 1e-12 apart is one corner (r28 A4)', async () => {
  // a cube of own corners (8 corners, 24 after the crease), one corner written a hair off on one face
  const pos = [], tri = [];
  TRIS.forEach((t, i) => { for (const v of t) { tri.push(pos.length / 3); const p = [...C[v]]; if (i === 2 && v === 7) p[2] += 1e-12; pos.push(...p); } });
  assert.notEqual(pos[3 * tri[6 + TRIS[2].indexOf(7)] + 2], 10, 'apart in float64');
  const m = weld({ name: 'c', pos, tri });
  assert.equal(m.positions.length / 3, 24, 'the crease\'s 24 corners: none split by the hair (the float64 text keys made 25)');
});
await test('two parts touching at one corner keep their own normals there: the corner groups split by shell (r30 Q4)', async () => {
  // the cube [0,10]^3 and a tetrahedron hanging below the plane z = 10 from the cube's corner
  // (10, 10, 10), no edge shared: its top face and the cube's both face +z at that corner, so one
  // crease group would join them without the shell in its key
  const pos = [], tri = [];
  for (const t of TRIS) for (const v of t) { tri.push(pos.length / 3); pos.push(...C[v]); }
  const q = [[10, 10, 10], [20, 10, 10], [10, 20, 10], [14, 14, 5]];
  for (const t of [[0, 1, 2], [0, 3, 1], [1, 3, 2], [2, 3, 0]]) for (const v of t) { tri.push(pos.length / 3); pos.push(...q[v]); }
  const m = weld({ name: 'two', pos, tri });
  assert.equal(m.positions.length / 3, 36, 'the cube\'s 24 corners and the tetrahedron\'s 12 (one group across the two made 35)');
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
await test('PLY: its header ends at the line that is end_header -- a space after it, a comment naming it (r109 C1)', async () => {
  const h = (comment, end) => `ply\nformat binary_little_endian 1.0\n${comment}element vertex 8\nproperty float x\nproperty float y\nproperty float z\nelement face 12\nproperty list uchar uint vertex_indices\n${end}\n`;
  cube(await parseMesh('ply', plyBinary(h('', 'end_header ')), 'cube.ply'));
  // (a comment line ending in the word: by the word anywhere, the header ended in it)
  cube(await parseMesh('ply', plyBinary(h('comment the line after these is end_header\n', 'end_header')), 'cube.ply'));
});
await test('OFF', async () => { cube(await parseMesh('off', off(), 'cube.off')); });
await test('OFF: the header run into the vertex count ("OFF8 12 0", as ModelNet writes it) opens; a count after a word does not (r113 R1-M1)', async () => {
  cube(await parseMesh('off', enc(new TextDecoder().decode(off()).replace('OFF\n8', 'OFF8')), 'cube.off'));
  cube(await parseMesh('off', enc(new TextDecoder().decode(off()).replace('OFF\n8', 'COFF8').replace(/^(-?[\d.]+ -?[\d.]+ -?[\d.]+)$/gm, '$1 255 0 0')), 'cube.off'));
  await assert.rejects(parseMesh('off', enc('OFFX8 12 0\n'), 'x.off'), /not an OFF file/);
});
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
await test('3MF: a component turned and moved, inside an item moved -- the component\'s transform first, then the item\'s (r111 H1-M2)', async () => {
  // (the vertex (1, 0, 0) turned 90 degrees about z, + 5 along x, then + 10: (15, 1, 0). The other
  // order gives (5, 11, 0); translations alone, as the arm above, commute and read alike)
  const doc = '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>'
    + '<object id="1" type="model"><mesh><vertices><vertex x="1" y="0" z="0"/><vertex x="2" y="0" z="0"/><vertex x="1" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>'
    + '<object id="2" type="model"><components><component objectid="1" transform="0 1 0 -1 0 0 0 0 1 5 0 0"/></components></object>'
    + '</resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></build></model>';
  const m = await parseMesh('3mf', zipStored([['_rels/.rels', rels()], ['3D/3dmodel.model', enc(doc)]]), 'order.3mf');
  const P = m.meshes[0].positions, pts = [];
  for (let i = 0; i < P.length; i += 3) pts.push([P[i], P[i + 1], P[i + 2]].map((x) => +x.toFixed(3)).join(','));
  assert.deepEqual([...new Set(pts)].sort(), ['14,1,0', '15,1,0', '15,2,0']);
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
  // (its data past the end by the local header's own extra length, which the directory cannot see:
  // the damaged zip in words -- r80 Q6; must fire, "RangeError: Invalid typed array length")
  const far = z.slice();
  new DataView(far.buffer).setUint16(28, 60000, true);
  await assert.rejects(unzip(far.buffer), /^Error: a damaged zip \(a\.txt's data lies outside the file\)$/);
  // (a changed byte in a stored entry: refused by its CRC-32, as a .gz is -- r80 Q4; must fire,
  // "hellp" handed on)
  const flipped = z.slice();
  flipped[30 + 5 + 4] ^= 1;
  const uf = await unzip(flipped.buffer);
  await assert.rejects(uf.get('a.txt'), /^Error: a damaged zip \(a\.txt's data does not match its checksum\)$/);
  assert.equal(new TextDecoder().decode(await (await unzip(z.buffer)).get('a.txt')), 'hello', 'must accept: the whole one');
  // (a deflated entry inflating cleanly to bytes its CRC-32 is not: refused as well -- r81 Q6; must
  // fire, "hellp" handed on)
  const dz = new Uint8Array(await zipDeflated('a.txt', Buffer.from('hellp')));
  new DataView(dz.buffer).setUint32(dz.length - 22 - (46 + 5) + 16, crc32(Buffer.from('hello')), true);
  await assert.rejects((await unzip(dz.buffer)).get('a.txt'), /^Error: a damaged zip \(a\.txt's data does not match its checksum\)$/);
  // (a Cancel during a large entry's checksum ends it: crc32Turning's stop -- r81 Q7; must fire, the
  // sum run to the end)
  const { StopRead } = await import('../js/cadmesh.js');
  const large = new Uint8Array(zipStored([['big.stl', new Uint8Array(40 * 2 ** 20)]]));
  await assert.rejects((await unzip(large.buffer, () => true)).get('big.stl'), (e) => e instanceof StopRead);
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
await test('a 3MF unit the format does not define is refused in words, by its own keys; the six it does are read (r93 A6)', async () => {
  const tri = '<object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
  const m3 = (u) => zipStored([['3D/3dmodel.model', enc(`<model unit="${u}"><resources>${tri}`)]]);
  // (must fire: "constructor" a function for the declared unit, "furlong" read as mm without a word)
  for (const u of ['constructor', 'furlong', 'Millimeter']) {
    await assert.rejects(() => parseMesh('3mf', m3(u), 'a.3mf'), new RegExp(`a\\.3mf's unit "${u}" is none the 3MF format defines`), u);
  }
  const got = [];
  for (const u of ['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter']) got.push((await parseMesh('3mf', m3(u), 'a.3mf')).sourceUnits);
  assert.deepEqual(got, ['um', 'mm', 'cm', 'in', 'ft', 'm']);
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
  // (a POSITION of 16 values per element under the vertex cap: since round 9 refused by its type,
  // before its 134,217,728 values meet the accessor's own cap)
  await refusedFast(() => parseMesh('gltf', gltf({ ...prim, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ componentType: 5126, type: 'MAT4', count: 2 ** 23 }, { componentType: 5125, type: 'SCALAR', count: 3 }] }), 'x.gltf'),
  /x\.gltf is damaged: mesh 0 primitive 1's POSITION accessor 0 is MAT4 of float; POSITION must be VEC3/);
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
  // (claiming 300 KB past the limit: said past it, rounded up -- "500 MB, more than the 500 MB" by
  // whole MB: r74 A8, Q8)
  dv.setUint32(cd + 24, 500 * 2 ** 20 + 307200, true);
  await refusedFast(() => parseMesh('3mf', z.buffer, 'a.3mf'), /a\.3mf: its model part 3D\/3dmodel\.model unpacks to 500\.3 MB, more than the 500 MB of text this viewer reads/, 1000);
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
  dv.setUint32(cd + 16, crc32(raw), true); // (the CRC of what it unpacks to, held since r80 Q4)
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
  // (the refusal comes at the 10,000,001st triangle, so the whole 110 MB part is scanned first: 4431 ms
  // alone and 5057 ms after this file's other arms, measured r53 -- its 5000 ms bound failed 3 runs in
  // 3 on a busy host, the code unchanged. The bound of the part that unpacks past 500 MB, above.)
  await refusedFast(() => parseMesh('3mf', tris, 'b.3mf'), /b\.3mf holds more than the 10,000,000 triangles this viewer opens/, 10000);
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
  /x\.gltf is damaged: mesh 0 primitive 1's POSITION accessor 0 is MAT4 of float/);
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
  // a coordinate past what the view can hold (1e39 past float32; 1e38 inside it, but the view's
  // matrices overflowed and it showed blank): refused, in words
  await refusedFast(() => parseMesh('obj', enc('v 1e39 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\n'), 'big.obj'), /^big\.obj is too large to show/);
  await refusedFast(() => parseMesh('obj', enc('v 1e38 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\n'), 'big.obj'), /^big\.obj is too large to show/);
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
await test('an OPEN body mirrored by a 3MF item or a glTF node: its normals still point out (r109 C3)', async () => {
  // (a lidless tray, wound outward: no weld turns an open shell, so the mirror's winding flip alone
  // keeps it right -- the closed cube of r6-4 passed with the flip taken out)
  const V = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const T = [[0, 2, 1], [0, 3, 2], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const bottomNz = (m) => {
    const b = m.meshes[0];
    let nz = 0;
    for (let t = 0; t < b.indices.length; t += 3) {
      const ids = [b.indices[t], b.indices[t + 1], b.indices[t + 2]];
      if (ids.every((i) => Math.abs(b.positions[3 * i + 2]) < 1e-6)) for (const i of ids) nz += b.normals[3 * i + 2];
    }
    return nz;
  };
  const tray = (tf) => enc(`<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="tray"><mesh><vertices>${V.map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('')}</vertices><triangles>${T.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1" transform="${tf}"/></build></model>`);
  for (const tf of ['1 0 0 0 1 0 0 0 1 0 0 0', '-1 0 0 0 1 0 0 0 1 0 0 0']) {
    const nz = bottomNz(await parseMesh('3mf', zipStored([['_rels/.rels', rels()], ['3D/3dmodel.model', tray(tf)]]), 'tray.3mf'));
    assert.ok(nz < 0, `3MF ${tf}: the bottom's normals z ${nz} (inward)`);
  }
  const pos = new Float32Array(V.flat().map((x) => x / 1000)), idx = new Uint16Array(T.flat());
  const bin = new Uint8Array(pos.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer)); bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  for (const node of [{ mesh: 0 }, { mesh: 0, scale: [-1, 1, 1] }]) {
    const j = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [node], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [0.01, 0.01, 0.01] }, { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength }],
      buffers: [{ byteLength: bin.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}` }] };
    const nz = bottomNz(await parseMesh('gltf', enc(JSON.stringify(j)), 'tray.gltf'));
    assert.ok(nz < 0, `glTF ${JSON.stringify(node)}: the bottom's normals z ${nz} (inward)`);
  }
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

// --- review round 7: variants real exporters write ---
// the bounding box of every body, rounded: [lox, loy, loz, hix, hiy, hiz]
const boxOf = (model) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const me of model.meshes) for (let i = 0; i < me.positions.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], me.positions[i + k]); hi[k] = Math.max(hi[k], me.positions[i + k]); }
  return [...lo, ...hi].map((x) => Math.round(x * 1000) / 1000 + 0);
};
const triCount = (model) => model.meshes.reduce((s, me) => s + me.indices.length / 3, 0);
const TRI1 = [0, 0, 0, 1, 0, 0, 0, 1, 0];
// A one-node, one-mesh glTF JSON. Accessor 0 is POSITION (values in componentType comp, packed
// at stride); then COLOR_0 when colour = { values, comp, nc, normalized } is given; then each of
// extra [{ values, comp, nc, normalized }] in order (instancing attributes, say). node and more are
// spread into the node and the top level.
function gltfOf({ positions, comp = 5126, normalized, stride, colour, extra = [], node = {}, more = {} }) {
  const W = { 5126: ['Float32', 4], 5122: ['Int16', 2], 5120: ['Int8', 1], 5123: ['Uint16', 2], 5121: ['Uint8', 1] };
  const chunks = [], bufferViews = [], accessors = [];
  let off0 = 0;
  const add = ({ values, comp: ct, nc, normalized: nz, stride: st }) => {
    const [t, es] = W[ct];
    const n = values.length / nc, s = st || nc * es;
    const len = (n - 1) * s + nc * es;
    const dv = new DataView(new ArrayBuffer(Math.ceil(len / 4) * 4));
    for (let e = 0; e < n; e++) for (let c = 0; c < nc; c++) dv[`set${t}`](e * s + c * es, values[e * nc + c], true);
    chunks.push(new Uint8Array(dv.buffer));
    bufferViews.push({ buffer: 0, byteOffset: off0, byteLength: len, ...(st ? { byteStride: st } : {}) });
    off0 += dv.byteLength;
    accessors.push({ bufferView: bufferViews.length - 1, componentType: ct, count: n, type: ['', 'SCALAR', 'VEC2', 'VEC3', 'VEC4'][nc], ...(nz ? { normalized: true } : {}) });
    return accessors.length - 1;
  };
  const attributes = { POSITION: add({ values: positions, comp, nc: 3, normalized, stride }) };
  if (colour) attributes.COLOR_0 = add(colour);
  for (const x of extra) add(x);
  const all = new Uint8Array(off0);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return { asset: { version: '2.0' }, buffers: [{ uri: b64uri(all), byteLength: all.length }], bufferViews, accessors,
    meshes: [{ primitives: [{ attributes }] }], nodes: [{ mesh: 0, ...node }], scenes: [{ nodes: [0] }], ...more };
}
const openJ = (j, name = 'g.gltf') => parseMesh('gltf', enc(JSON.stringify(j)), name);
// a binary STL of triangles [[9 coordinates], attribute word] under an 80-byte header, plus surplus bytes
function stlOf(tris, header = '', surplus = 0) {
  const b = new ArrayBuffer(84 + 50 * tris.length + surplus);
  const u = new Uint8Array(b), dv = new DataView(b);
  if (typeof header === 'string') u.set(new TextEncoder().encode(header)); else u.set(header);
  dv.setUint32(80, tris.length, true);
  tris.forEach(([p, attr], i) => { p.forEach((x, k) => dv.setFloat32(84 + i * 50 + 12 + k * 4, x, true)); dv.setUint16(84 + i * 50 + 48, attr, true); });
  return b;
}
const m3of = (inner) => zipStored([['3D/3dmodel.model', enc(`<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">${inner}</model>`)]]);
const TRI3MF = '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>';

await test('r7-1 companion files by one rule: a name with a space, a directory (/ or \\), any case; OBJ mtllib and glTF buffers alike', async () => {
  const red = enc('newmtl red\nKd 1 0 0\n');
  const objq = (line) => enc(`${line}\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl red\nf 1 2 3\n`);
  const col = async (line, key) => (await parseMesh('obj', objq(line), 'a.obj', new Map([[key, red]]))).meshes[0].color;
  assert.ok(near(await col('mtllib my model.mtl', 'my model.mtl'), [1, 0, 0]), 'a name with a space (Blender writes it unquoted)');
  assert.ok(near(await col('mtllib mat/a.mtl', 'a.mtl'), [1, 0, 0]), 'a directory with /');
  assert.ok(near(await col('mtllib ..\\Mat\\A.MTL', 'a.mtl'), [1, 0, 0]), 'a directory with \\, upper case');
  assert.ok(near(await col('mtllib a.mtl', 'textures/a.mtl'), [1, 0, 0]), 'the map keyed by a path');
  // two names on one line are each still read
  const two = await parseMesh('obj', enc('mtllib a.mtl b.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl blue\nf 1 2 3\n'), 'a.obj', new Map([['a.mtl', red], ['b.mtl', enc('newmtl blue\nKd 0 0 1\n')]]));
  assert.ok(near(two.meshes[0].color, [0, 0, 1]), `two names: ${two.meshes[0].color}`);
  // a glTF's buffer by the same rule
  const pos = new Float32Array(TRI1).buffer;
  const j = (uri) => gltf({ buffers: [{ uri, byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] });
  for (const [uri, key] of [['bin/Tri.BIN', 'tri.bin'], ['bin%5Ctri.bin', 'tri.bin'], ['my%20tri.bin', 'my tri.bin'], ['tri.bin', 'sub/tri.bin']]) {
    const model = await parseMesh('gltf', j(uri), 'a.gltf', new Map([[key, pos]]));
    assert.equal(triCount(model), 1, uri);
  }
  // (by its path first, where the map has paths -- a zip's, named from the model's folder: the
  // reference's own file, not a same-named one beside the model -- r54 A3, Q1)
  const blue = enc('newmtl red\nKd 0 0 1\n');
  assert.ok(near(await (async () => (await parseMesh('obj', objq('mtllib mtl/a.mtl'), 'a.obj', new Map([['a.mtl', blue], ['mtl/a.mtl', red]]))).meshes[0].color)(), [1, 0, 0]),
    'mtllib mtl/a.mtl: mtl/a.mtl, not a.mtl');
  assert.ok(near(await (async () => (await parseMesh('obj', objq('mtllib .\\Mtl\\A.mtl'), 'a.obj', new Map([['a.mtl', blue], ['mtl/a.mtl', red]]))).meshes[0].color)(), [1, 0, 0]),
    'the same with \\, ./ and upper case');
});
await test('r7-2 glTF extensionsRequired: one the reader does not read is refused by name; EXT_mesh_gpu_instancing places every instance; Draco keeps its words', async () => {
  await refusedFast(() => openJ({ ...gltfOf({ positions: TRI1 }), extensionsRequired: ['KHR_future_thing'] }, 'f.gltf'),
    /^f\.gltf needs the glTF extension KHR_future_thing, which this viewer does not read/);
  await refusedFast(() => openJ({ ...gltfOf({ positions: TRI1 }), extensionsRequired: ['KHR_draco_mesh_compression', 'KHR_future_thing'] }, 'd.gltf'),
    /^d\.gltf needs KHR_draco_mesh_compression, which this viewer does not decode: export it without compression/);
  // three instances: at the origin, 5 m along x, and 10 m along x turned 90 degrees about z; the
  // node moves them all 2 m along y (the node's transform applies after the instance's)
  const inst = gltfOf({ positions: TRI1, node: { translation: [0, 2, 0], extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1, ROTATION: 2 } } } },
    extra: [{ values: [0, 0, 0, 5, 0, 0, 10, 0, 0], comp: 5126, nc: 3 }, { values: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2], comp: 5126, nc: 4 }],
    more: { extensionsUsed: ['EXT_mesh_gpu_instancing'], extensionsRequired: ['EXT_mesh_gpu_instancing'] } });
  const model = await openJ(inst, 'i.gltf');
  assert.equal(model.meshes.length, 3, 'bodies');
  assert.deepEqual(boxOf({ meshes: [model.meshes[0]] }), [0, 2000, 0, 1000, 3000, 0]);
  assert.deepEqual(boxOf({ meshes: [model.meshes[1]] }), [5000, 2000, 0, 6000, 3000, 0]);
  assert.deepEqual(boxOf({ meshes: [model.meshes[2]] }), [9000, 2000, 0, 10000, 3000, 0]);
  // instances are counted against the caps before any is built
  await refusedFast(() => openJ({ ...gltfOf({ positions: TRI1, node: { extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } } } }),
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { componentType: 5126, count: 4_000_000, type: 'VEC3' }] }, 'x.gltf'),
  /^x\.gltf places 4,000,001 parts once its shared parts are repeated, more than the 2,000,000 this viewer opens/);
});
await test('r7-4 3MF names with XML character references: &amp; &lt; &gt; &quot; &apos; &#N; &#xH; decoded', async () => {
  const model = await parseMesh('3mf', m3of(`<resources><object id="1" name="Bolt &amp; nut">${TRI3MF}</object><object id="2" name="&#x41;&#66;&lt;&gt;&quot;&apos;&#x1F600;">${TRI3MF}</object></resources>`
    + '<build><item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></build>'), 'n.3mf');
  assert.equal(model.root.children[0].name, 'Bolt & nut');
  assert.equal(model.root.children[1].name, 'AB<>"\'\u{1F600}');
});
await test('r7-5 glTF requiring KHR_mesh_quantization (normalized int16 positions) opens', async () => {
  const model = await openJ(gltfOf({ positions: [0, 0, 0, 32767, 0, 0, 0, 32767, 0], comp: 5122, normalized: true,
    more: { extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'] } }));
  assert.deepEqual(boxOf(model), [0, 0, 0, 1000, 1000, 0]);
});
await test('r7-6a STL per-facet colour: VisCAM / SolidView (bit 15 = valid, red high) and Materialise Magics (COLOR= / MATERIAL= header, bit 15 = use the part colour, red low)', async () => {
  const A = [0, 0, 0, 1, 0, 0, 0, 1, 0], B = [5, 0, 0, 6, 0, 0, 5, 1, 0];
  const one = await parseMesh('stl', stlOf([[A, 0x8000 | (31 << 10)]]), 'v.stl');
  assert.ok(near(one.meshes[0].color, [1, 0, 0]), `VisCAM red: ${one.meshes[0].color}`);
  // a facet without the valid bit stays grey beside a coloured one
  const mixed = await parseMesh('stl', stlOf([[A, 0x8000 | 31], [B, 0]]), 'v.stl');
  assert.deepEqual(colourSet(mixed.meshes[0]), ['0,0,255', '184,189,199']);
  // Magics: the part colour (blue) for a facet with bit 15 set, its own (red, in bits 0-4) without
  const hdr = new Uint8Array(80);
  hdr.set(new TextEncoder().encode('Magics COLOR='), 0); hdr.set([0, 0, 255, 255], 13);
  const magics = await parseMesh('stl', stlOf([[A, 0x8000], [B, 31]], hdr), 'm.stl');
  assert.deepEqual(colourSet(magics.meshes[0]), ['0,0,255', '255,0,0']);
  // MATERIAL= (its diffuse colour, green) is preferred over COLOR=
  const mat = new Uint8Array(80);
  mat.set(new TextEncoder().encode('COLOR='), 0); mat.set([0, 0, 255, 255], 6);
  mat.set(new TextEncoder().encode(',MATERIAL='), 10); mat.set([0, 255, 0, 255, 9, 9, 9, 255, 9, 9, 9, 255], 20);
  const m2 = await parseMesh('stl', stlOf([[A, 0x8000]], mat), 'm.stl');
  assert.ok(near(m2.meshes[0].color, [0, 1, 0]), `MATERIAL= diffuse: ${m2.meshes[0].color}`);
});
await test('r7-6b OBJ vertex colours (v x y z r g b): each triangle the mean of its corners; over a usemtl', async () => {
  const red = await parseMesh('obj', enc('v 0 0 0 1 0 0\nv 1 0 0 1 0 0\nv 0 1 0 1 0 0\nf 1 2 3\n'), 'vc.obj');
  assert.ok(near(red.meshes[0].color, [1, 0, 0]), `colour ${red.meshes[0].color}`);
  const mean = await parseMesh('obj', enc('mtllib a.mtl\nusemtl g\nv 0 0 0 1 0 0\nv 1 0 0 0 0 1\nv 0 1 0 0 0 1\nf 1 2 3\n'), 'vc.obj', new Map([['a.mtl', enc('newmtl g\nKd 0 1 0\n')]]));
  assert.ok(near(mean.meshes[0].color, [1 / 3, 0, 2 / 3]), `colour ${mean.meshes[0].color}`);
});
await test('r7-6c PLY face colours (MeshLab: red green blue on the face element), over vertex colours', async () => {
  const head = (vprops) => `ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n${vprops}element face 1\nproperty list uchar int vertex_indices\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nend_header\n`;
  const fc = await parseMesh('ply', enc(`${head('')}0 0 0\n1 0 0\n1 1 0\n3 0 1 2 255 0 0 255\n`), 'fc.ply');
  assert.deepEqual(colourSet(fc.meshes[0]), ['255,0,0']);
  // (a mid tone, the vertices colourless: scaled by the face element's own type -- by the vertex
  // element's, a float's 1, it read 255,255,255, and 255 0 0 above reads alike either way: r111 H1-M1)
  const mid = await parseMesh('ply', enc(`${head('')}0 0 0\n1 0 0\n1 1 0\n3 0 1 2 128 64 32 255\n`), 'fc.ply');
  assert.deepEqual(colourSet(mid.meshes[0]), ['128,64,32']);
  const both = await parseMesh('ply', enc(`${head('property uchar red\nproperty uchar green\nproperty uchar blue\n')}0 0 0 0 255 0\n1 0 0 0 255 0\n1 1 0 0 255 0\n3 0 1 2 0 0 255 255\n`), 'fc.ply');
  assert.deepEqual(colourSet(both.meshes[0]), ['0,0,255']);
});
await test('r7-6d glTF COLOR_0: float VEC4, normalized ubyte VEC3 and ushort VEC4, times the material\'s baseColorFactor, in linear space', async () => {
  const red4 = [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1];
  const f = await openJ(gltfOf({ positions: TRI1, colour: { values: red4, comp: 5126, nc: 4 } }));
  assert.ok(near(f.meshes[0].color, [1, 0, 0]), `float: ${f.meshes[0].color}`);
  const u8 = await openJ(gltfOf({ positions: TRI1, colour: { values: [255, 0, 0, 255, 0, 0, 255, 0, 0], comp: 5121, nc: 3, normalized: true } }));
  assert.ok(near(u8.meshes[0].color, [1, 0, 0]), `ubyte: ${u8.meshes[0].color}`);
  const u16 = await openJ(gltfOf({ positions: TRI1, colour: { values: [0, 65535, 0, 65535, 0, 65535, 0, 65535, 0, 65535, 0, 65535], comp: 5123, nc: 4, normalized: true } }));
  assert.ok(near(u16.meshes[0].color, [0, 1, 0]), `ushort: ${u16.meshes[0].color}`);
  // linear 0.2 x factor 0.5 = linear 0.1 -> sRGB 0.349
  const jm = gltfOf({ positions: TRI1, colour: { values: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2], comp: 5126, nc: 3 },
    more: { materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }] } });
  jm.meshes[0].primitives[0].material = 0;
  const mul = await openJ(jm);
  assert.ok(near(mul.meshes[0].color, [0.349, 0.349, 0.349]), `times the factor: ${mul.meshes[0].color}`);
  // a colour per corner: each triangle their mean (red, red, blue -> 2/3 red, 1/3 blue, in linear)
  const per = await openJ(gltfOf({ positions: TRI1, colour: { values: [1, 0, 0, 1, 0, 0, 0, 0, 1], comp: 5126, nc: 3 } }));
  const s = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  assert.ok(near(per.meshes[0].color, [s(2 / 3), 0, s(1 / 3)]), `mean: ${per.meshes[0].color}`);
});
await test('r7-6e 3MF materials extension: m:colorgroup by the object\'s pid / pindex, and a triangle\'s p1 p2 p3 averaged', async () => {
  const cg = '<m:colorgroup id="5"><m:color color="#FF0000"/><m:color color="#0000FFFF"/></m:colorgroup>';
  const obj1 = await parseMesh('3mf', m3of(`<resources>${cg}<object id="1" pid="5" pindex="0">${TRI3MF}</object></resources><build><item objectid="1"/></build>`), 'c.3mf');
  assert.ok(near(obj1.meshes[0].color, [1, 0, 0]), `object colour: ${obj1.meshes[0].color}`);
  const corners = TRI3MF.replace('<triangle v1="0" v2="1" v3="2"/>', '<triangle v1="0" v2="1" v3="2" pid="5" p1="0" p2="1" p3="1"/>');
  const tri = await parseMesh('3mf', m3of(`<resources>${cg}<object id="1">${corners}</object></resources><build><item objectid="1"/></build>`), 'c.3mf');
  assert.ok(near(tri.meshes[0].color, [1 / 3, 0, 2 / 3]), `corner mean: ${tri.meshes[0].color}`);
});
await test('r7-7 OBJ line continuation: a trailing backslash joins the next line (faces, vertices) in both passes', async () => {
  const m = await parseMesh('obj', enc('v 0 0 0\nv 1 0 \\\n 0\nv 1 1 0\nv 0 1 0\nf 1 2 \\\r\n 3 4\n'), 'c.obj');
  assert.equal(triCount(m), 2);
  assert.deepEqual(boxOf(m), [0, 0, 0, 1, 1, 0]);
});
await test('r7-8 binary STL: a surplus under 50 bytes after 84 + 50 n is read as binary; a larger mismatch is refused naming the sizes', async () => {
  const A = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  assert.equal(triCount(await parseMesh('stl', stlOf([[A, 0]], 'solid part', 2), 'tr.stl')), 1);
  assert.equal(triCount(await parseMesh('stl', stlOf([[A, 0]], 'exported', 49), 'tr.stl')), 1);
  await refusedFast(() => parseMesh('stl', stlOf([[A, 0]], 'solid part', 60), 'tr.stl'),
    /^tr\.stl is damaged: its header counts 1 triangle, so it should be 134 bytes, but it is 194 bytes/);
  await refusedFast(() => parseMesh('stl', stlOf([[A, 0]], 'exported', 60), 'tr.stl'),
    /^tr\.stl is damaged: its header counts 1 triangle, so it should be 134 bytes, but it is 194 bytes/);
});
await test('r7-10a PLY binary big-endian', async () => {
  const hdr = new TextEncoder().encode('ply\nformat binary_big_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n');
  const b = new ArrayBuffer(hdr.length + 36 + 13);
  new Uint8Array(b).set(hdr);
  const dv = new DataView(b);
  let o = hdr.length;
  for (const v of [0, 0, 0, 2, 0, 0, 0, 3, 0]) { dv.setFloat32(o, v, false); o += 4; }
  dv.setUint8(o, 3); o++;
  for (const v of [0, 1, 2]) { dv.setInt32(o, v, false); o += 4; }
  const m = await parseMesh('ply', b, 'be.ply');
  assert.equal(triCount(m), 1);
  assert.deepEqual(boxOf(m), [0, 0, 0, 2, 3, 0]);
});
await test('r7-10b glTF bufferView byteStride (interleaved POSITION, 16-byte stride)', async () => {
  assert.deepEqual(boxOf(await openJ(gltfOf({ positions: TRI1, stride: 16 }))), [0, 0, 0, 1000, 1000, 0]);
  // (a stride ignored reads the second vertex from bytes 12..23: (0, 1, 0), not (1, 0, 0))
  assert.deepEqual(boxOf(await openJ(gltfOf({ positions: [0, 0, 0, 2, 0, 0, 0, 3, 0], stride: 20 }))), [0, 0, 0, 2000, 3000, 0]);
});
await test('r7-10c glTF normalized int8 and int16 POSITION', async () => {
  assert.deepEqual(boxOf(await openJ(gltfOf({ positions: [0, 0, 0, 127, 0, 0, 0, -128, 0], comp: 5120, normalized: true }))), [0, -1000, 0, 1000, 0, 0]);
  assert.deepEqual(boxOf(await openJ(gltfOf({ positions: [0, 0, 0, 32767, 0, 0, 0, -32768, 0], comp: 5122, normalized: true }))), [0, -1000, 0, 1000, 0, 0]);
});
await test('r7-10d glTF node matrix (column-major, translate x + 2 m)', async () => {
  assert.deepEqual(boxOf(await openJ(gltfOf({ positions: TRI1, node: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1] } }))), [2000, 0, 0, 3000, 1000, 0]);
});
await test('r7-10e glTF node rotation (90 degrees about z) and scale', async () => {
  assert.deepEqual(boxOf(await openJ(gltfOf({ positions: TRI1, node: { rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } }))), [-1000, 0, 0, 0, 1000, 0]);
  assert.deepEqual(boxOf(await openJ(gltfOf({ positions: TRI1, node: { rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 1, 1] } }))), [-1000, 0, 0, 0, 2000, 0]);
});
await test('r7-10f glTF "scene" chooses among several scenes', async () => {
  const j = gltfOf({ positions: TRI1, more: { scene: 1, scenes: [{ nodes: [0] }, { nodes: [1] }] } });
  j.nodes.push({ mesh: 0, translation: [10, 0, 0] });
  assert.deepEqual(boxOf(await openJ(j)), [10000, 0, 0, 11000, 1000, 0]);
  j.scene = 0;
  assert.deepEqual(boxOf(await openJ(j)), [0, 0, 0, 1000, 1000, 0]);
});
await test('r7-10g OBJ negative (relative) indices', async () => {
  const m = await parseMesh('obj', enc('v 0 0 0\nv 1 0 0\nv 1 1 0\nf -3 -2 -1\nv 5 5 5\nv 6 5 5\nv 6 6 5\nf -3/-1 -2/-1 -1/-1\n'), 'n.obj');
  assert.equal(triCount(m), 2);
  assert.deepEqual(boxOf(m), [0, 0, 0, 6, 6, 5]);
});
await test('r7-12 a textured glTF material: factor x texture average multiplied in linear space, then made sRGB', async () => {
  // (Node has no image decoder: one standing in for it draws every pixel sRGB 64)
  const saved = [globalThis.createImageBitmap, globalThis.OffscreenCanvas];
  globalThis.createImageBitmap = async () => ({});
  globalThis.OffscreenCanvas = class { getContext() { return { drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : 64)) }) }; } };
  try {
    const j = gltfOf({ positions: TRI1, more: { materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.2, 0.2, 1], baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }], images: [{ uri: 'data:image/png;base64,AAAA' }] } });
    j.meshes[0].primitives[0].material = 0;
    const c = (await openJ(j)).meshes[0].color;
    // sRGB 64/255 is linear 0.05127; x 0.2 = 0.010254, sRGB 0.1015 (the sRGB product was 0.4845 x 0.251 = 0.1216)
    assert.ok(c && c.every((x) => Math.abs(x - 0.1015) < 0.002), `colour ${c}`);
  } finally {
    [globalThis.createImageBitmap, globalThis.OffscreenCanvas] = saved;
  }
});
const col8 = (n) => ({ values: Array.from({ length: n * 4 }, () => 200), comp: 5121, nc: 4, normalized: true });
await test('r8-2a glTF COLOR_0 counting other than POSITION refused (more and fewer)', async () => {
  // (glTF 2.0 3.7.2.1: every attribute of a primitive has the same count; 22 M colours on one
  // triangle were walked whole for every placement)
  await refusedFast(() => openJ(gltfOf({ positions: TRI1, colour: col8(4) }), 'c.gltf'),
    /^c\.gltf is damaged: mesh 0 primitive 1's COLOR_0 holds 4 colours for its 3 vertices/);
  await refusedFast(() => openJ(gltfOf({ positions: TRI1, colour: col8(2) }), 'c.gltf'),
    /^c\.gltf is damaged: mesh 0 primitive 1's COLOR_0 holds 2 colours for its 3 vertices/);
});
await test('r8-2b glTF byteStride outside 4..252 or not a multiple of 4 refused', async () => {
  // (glTF 2.0 3.6.2.4: byteStride 4..252, a multiple of 4)
  for (const st of [1, 2, 6, 256]) {
    await refusedFast(() => openJ(gltfOf({ positions: TRI1, colour: { ...col8(3), stride: st } }), 's.gltf'),
      new RegExp(`^s\\.gltf is damaged: buffer view 1 has a byteStride of ${st}`));
  }
});
await test('r8-2c glTF: each accessor read once however often its mesh is placed (instances, nodes)', async () => {
  const col = col8;
  // the colours (normalized ubyte: the only byte reads) read once for 1 placement, 10 instances,
  // and 2 nodes naming the mesh
  const orig = DataView.prototype.getUint8;
  let reads = 0;
  DataView.prototype.getUint8 = function getUint8(o) { reads++; return orig.call(this, o); };
  try {
    const instanced = (k) => gltfOf({ positions: TRI1, colour: col(3),
      node: { extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2 } } } },
      extra: [{ values: Array.from({ length: k * 3 }, (_, i) => (i % 3 ? 0 : i * 2)), comp: 5126, nc: 3 }],
      more: { extensionsUsed: ['EXT_mesh_gpu_instancing'] } });
    const readsFor = async (j, bodies) => { reads = 0; assert.equal((await openJ(j)).meshes.length, bodies); return reads; };
    const one = await readsFor(instanced(1), 1);
    assert.equal(one, 12, 'one placement reads its 3 x 4 colour bytes');
    assert.equal(await readsFor(instanced(10), 10), one, 'ten instances');
    const twoNodes = gltfOf({ positions: TRI1, colour: col(3), more: { scenes: [{ nodes: [0, 1] }] } });
    twoNodes.nodes.push({ mesh: 0, translation: [5, 0, 0] });
    assert.equal(await readsFor(twoNodes, 2), one, 'two nodes');
  } finally {
    DataView.prototype.getUint8 = orig;
  }
});
await test('r8-3 glTF textures: each image decoded once, only for materials a drawn primitive uses, one at a time; a materials list past the cap refused', async () => {
  const saved = [globalThis.createImageBitmap, globalThis.OffscreenCanvas];
  let calls = 0, inFlight = 0, peak = 0;
  globalThis.createImageBitmap = async () => { calls++; inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 1)); inFlight--; return {}; };
  globalThis.OffscreenCanvas = class { getContext() { return { drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : 64)) }) }; } };
  const decodes = async (j) => { calls = 0; peak = 0; await openJ(j); return { calls, peak }; };
  const mat = (t) => ({ pbrMetallicRoughness: { baseColorTexture: { index: t } } });
  try {
    // 1000 materials naming one image, one primitive using material 0
    const j = gltfOf({ positions: TRI1, more: { materials: Array.from({ length: 1000 }, () => mat(0)), textures: [{ source: 0 }], images: [{ uri: 'data:image/png;base64,AAAA' }] } });
    j.meshes[0].primitives[0].material = 0;
    assert.deepEqual(await decodes(j), { calls: 1, peak: 1 }, 'one image');
    // three images; texture 3 names image 0 again; primitives use materials 0, 2 and 3 (material
    // 1, image 1, is drawn by none): images 0 and 2 decoded, one after the other
    const k = gltfOf({ positions: TRI1, more: { materials: [mat(0), mat(1), mat(2), mat(3)], textures: [{ source: 0 }, { source: 1 }, { source: 2 }, { source: 0 }],
      images: ['AAAA', 'BBBB', 'CCCC'].map((b) => ({ uri: `data:image/png;base64,${b}` })) } });
    const a = k.meshes[0].primitives[0].attributes;
    k.meshes[0].primitives = [0, 2, 3].map((material) => ({ attributes: a, material }));
    assert.deepEqual(await decodes(k), { calls: 2, peak: 1 }, 'images used');
  } finally {
    [globalThis.createImageBitmap, globalThis.OffscreenCanvas] = saved;
  }
  await refusedFast(() => openJ({ ...gltfOf({ positions: TRI1 }), materials: Array.from({ length: 65_537 }, () => ({})) }, 'm.gltf'),
    /^m\.gltf holds more than the 65,536 materials this viewer opens/);
});
await test('r8-5 3MF tags inside comments, CDATA sections and processing instructions are not read', async () => {
  const res = `<resources><object id="1" name="part">${TRI3MF}</object></resources>`;
  for (const hide of ['<!-- <item objectid="9"/> -->', '<![CDATA[ <item objectid="9"/> ]]>', '<?note <item objectid="9"/> ?>', '<!-- a -- b > <item objectid="9"/> -->']) {
    const m = await parseMesh('3mf', m3of(`${res}<build>${hide}<item objectid="1"/></build>`), 'p.3mf');
    assert.equal(m.meshes.length, 1, hide);
  }
  // a commented-out object after the real one, with its id
  const old = await parseMesh('3mf', m3of(`<resources><object id="1" name="part">${TRI3MF}</object><!-- <object id="1" name="old"></object> --></resources><build><item objectid="1"/></build>`), 'p.3mf');
  assert.equal(old.root.children[0].name, 'part');
  // a comment never closed: the rest of the part is inside it
  const open = await parseMesh('3mf', m3of(`${res}<build><item objectid="1"/></build><!-- <item objectid="9"/>`), 'p.3mf');
  assert.equal(open.meshes.length, 1);
  // a million comments are passed over in linear time
  const many = m3of(`${'<!-- x -->'.repeat(1_000_000)}${res}<build><item objectid="1"/></build>`);
  const t0 = Date.now();
  assert.equal((await parseMesh('3mf', many, 'p.3mf')).meshes.length, 1);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
});
await test('r8-6 3MF material groups (basematerials, colorgroup) have a cap of their own, named in the refusal (not "objects")', async () => {
  const head = '<model unit="millimeter"><resources>', t = '<basematerials/>';
  const z = await zipDeflated('3D/3dmodel.model', Buffer.concat([Buffer.from(head), Buffer.alloc(2_000_001 * t.length, t)]));
  await refusedFast(() => parseMesh('3mf', z, 'g.3mf'), /^g\.3mf holds more than the 2,000,000 material groups this viewer opens/, 5000);
});
await test('r9-4 glTF accessor types: a MAT4 index accessor (825 bytes, 5.6 M elements, placed 3 times) refused at once; VEC4 POSITION, VEC2 NORMAL, float indices refused naming the accessor and type', async () => {
  // the reviewer's probe: a sparse MAT4 index accessor with no buffer view, 16 values an element
  const pos = new Float32Array(TRI1), bin = new Uint8Array(36 + 4 + 64);
  bin.set(new Uint8Array(pos.buffer), 0);
  const placed = 3;
  const probe = { buffers: [{ uri: b64uri(bin), byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 4 }, { buffer: 0, byteOffset: 40, byteLength: 64 }],
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 },
      { componentType: 5125, type: 'MAT4', count: 5_600_000, sparse: { count: 1, indices: { bufferView: 1, componentType: 5125 }, values: { bufferView: 2 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: Array.from({ length: placed }, (_, i) => ({ mesh: 0, translation: [i, 0, 0] })), scenes: [{ nodes: Array.from({ length: placed }, (_, i) => i) }] };
  assert.ok(gltf(probe).byteLength < 1000, `${gltf(probe).byteLength} bytes`);
  await refusedFast(() => parseMesh('gltf', gltf(probe), 'p.gltf'),
    /^p\.gltf is damaged: mesh 0 primitive 1's indices accessor 1 is MAT4 of unsigned int; indices must be SCALAR of unsigned byte, unsigned short or unsigned int/, 1000);
  // POSITION VEC4 (was the engine's "Invalid array length" or a shifted mesh)
  const p4 = gltfOf({ positions: TRI1, extra: [{ values: [0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1], comp: 5126, nc: 4 }] });
  p4.meshes[0].primitives[0].attributes.POSITION = 1;
  await refusedFast(() => openJ(p4, 'v.gltf'), /^v\.gltf is damaged: mesh 0 primitive 1's POSITION accessor 1 is VEC4 of float; POSITION must be VEC3 of/);
  // NORMAL VEC2
  const n2 = gltfOf({ positions: TRI1, extra: [{ values: [0, 0, 0, 0, 0, 0], comp: 5126, nc: 2 }] });
  n2.meshes[0].primitives[0].attributes.NORMAL = 1;
  await refusedFast(() => openJ(n2, 'n.gltf'), /^n\.gltf is damaged: mesh 0 primitive 1's NORMAL accessor 1 is VEC2 of float; NORMAL must be VEC3 of/);
  // float indices (SCALAR, but not an unsigned integer type)
  const fi = gltfOf({ positions: TRI1, extra: [{ values: [0, 1, 2], comp: 5126, nc: 1 }] });
  fi.meshes[0].primitives[0].indices = 1;
  await refusedFast(() => openJ(fi, 'i.gltf'), /^i\.gltf is damaged: mesh 0 primitive 1's indices accessor 1 is SCALAR of float; indices must be SCALAR of unsigned byte/);
  // the same with ushort indices, and a VEC3 NORMAL, still open
  const ok = gltfOf({ positions: TRI1, extra: [{ values: [0, 1, 2], comp: 5123, nc: 1 }, { values: [0, 0, 1, 0, 0, 1, 0, 0, 1], comp: 5126, nc: 3 }] });
  ok.meshes[0].primitives[0].indices = 1;
  ok.meshes[0].primitives[0].attributes.NORMAL = 2;
  assert.equal(triCount(await openJ(ok)), 1);
});
await test('r9-6 an ASCII PLY body past the text limit: refused in the words the other text readers use, before it is decoded', async () => {
  const hdr = Buffer.from('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n');
  const b = Buffer.alloc(hdr.length + 540 * 2 ** 20, 0x20);
  hdr.copy(b, 0);
  await refusedFast(() => parseMesh('ply', b.buffer.slice(b.byteOffset, b.byteOffset + b.length), 'p.ply'),
    /^p\.ply is 540 MB of text, more than the 500 MB of text this viewer reads/, 1000);
});
await test('r9-7 a glTF baseColorFactor that is not 4 finite numbers: refused in the glTF\'s words (not the .cadmesh\'s, not opened black)', async () => {
  for (const f of [[0.5], ['red', 0, 0, 1], [null, 0, 0, 1], 'grey', [0.5, 0.5, 0.5, 1, 1]]) {
    const j = { ...gltfOf({ positions: TRI1 }), materials: [{ pbrMetallicRoughness: { baseColorFactor: f } }] };
    j.meshes[0].primitives[0].material = 0;
    await refusedFast(() => openJ(j, 'c.gltf'), /^c\.gltf is damaged: material 0's baseColorFactor is not 4 numbers/);
  }
  const j = { ...gltfOf({ positions: TRI1 }), materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }] };
  j.meshes[0].primitives[0].material = 0;
  const m = await openJ(j);
  assert.ok(near(m.meshes[0].color, [0.735, 0.735, 0.735]), String(m.meshes[0].color));
  assert.equal(decodeCadmesh(encodeCadmesh(m)).header.meshes.length, 1);
});
await test('r9-8 OBJ whitespace: the o/g test and the line split agree (a no-break space), so a face after "f\\u00a0" is held to the triangle cap and "g\\u00a0name" names its body', async () => {
  // "f" then a no-break space: one face of 10,000,003 corners alternating two vertices
  const objFace = Buffer.concat([Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1'), Buffer.alloc(4 * 5_000_001, ' 2 3'), Buffer.from('\n')]);
  await refusedFast(() => parseMesh('obj', objFace.buffer.slice(objFace.byteOffset, objFace.byteOffset + objFace.length), 'x.obj'),
    /x\.obj holds more than the 10,000,000 triangles this viewer opens/, 1000);
  const m = await parseMesh('obj', enc('v 0 0 0\nv 1 0 0\nv 0 1 0\ng Part A\nf 1 2 3\no　Other\nf 1 3 2\n g\tLast\nf 1 2 3\n'), 'n.obj');
  assert.deepEqual(m.meshes.map((b) => b.name), ['Part A', 'Other', 'Last']);
  // ASCII spacing, bare "g", and an "o" naming a body, as before
  const a = await parseMesh('obj', enc('v 0 0 0\nv 1 0 0\nv 0 1 0\no  one \nf 1 2 3\ng\nf 1 3 2\n'), 'a.obj');
  assert.deepEqual(a.meshes.map((b) => b.name), ['one', 'a']);
});

// --- review round 10: accessor types as the specs list them ---
// one instanced triangle: the extra accessors (1, 2, ...) are the node's instancing attributes attrs
const instJ = (attrs, extra) => gltfOf({ positions: TRI1, node: { extensions: { EXT_mesh_gpu_instancing: { attributes: attrs } } }, extra,
  more: { extensionsUsed: ['EXT_mesh_gpu_instancing'], extensionsRequired: ['EXT_mesh_gpu_instancing'] } });
await test('r10-4 glTF accessor types by the spec tables (EXT_mesh_gpu_instancing, KHR_mesh_quantization, core): normalized checked where the table ties it, others refused naming the accessor', async () => {
  const W = "node 0's EXT_mesh_gpu_instancing's";
  // EXT_mesh_gpu_instancing: ROTATION float, normalized byte, normalized short
  const R90 = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  await refusedFast(() => openJ(instJ({ ROTATION: 1 }, [{ values: [0, 0, 90, 90], comp: 5120, nc: 4 }]), 'r.gltf'),
    new RegExp(`^r\\.gltf is damaged: ${W} ROTATION accessor 1 is VEC4 of byte; ROTATION must be VEC4 of float, normalized byte or normalized short$`));
  await refusedFast(() => openJ(instJ({ ROTATION: 1 }, [{ values: [0, 0, 23170, 23170], comp: 5122, nc: 4 }]), 'r.gltf'),
    new RegExp(`^r\\.gltf is damaged: ${W} ROTATION accessor 1 is VEC4 of short;`));
  await refusedFast(() => openJ(instJ({ ROTATION: 1 }, [{ values: [0, 0, 1], comp: 5126, nc: 3 }]), 'r.gltf'),
    new RegExp(`^r\\.gltf is damaged: ${W} ROTATION accessor 1 is VEC3 of float;`));
  for (const [comp, v] of [[5126, R90], [5122, [0, 0, 23170, 23170]], [5120, [0, 0, 90, 90]]]) {
    assert.deepEqual(boxOf(await openJ(instJ({ ROTATION: 1 }, [{ values: v, comp, nc: 4, normalized: comp !== 5126 }]))), [-1000, 0, 0, 0, 1000, 0], `ROTATION ${comp}`);
  }
  // TRANSLATION and SCALE: float only (a short TRANSLATION of 5 opened 5 m away)
  for (const k of ['TRANSLATION', 'SCALE']) {
    for (const [comp, nz, shown] of [[5122, false, 'short'], [5120, true, 'normalized byte'], [5123, false, 'unsigned short']]) {
      await refusedFast(() => openJ(instJ({ [k]: 1 }, [{ values: [1, 1, 1], comp, nc: 3, normalized: nz }]), 't.gltf'),
        new RegExp(`^t\\.gltf is damaged: ${W} ${k} accessor 1 is VEC3 of ${shown}; ${k} must be VEC3 of float$`));
    }
  }
  const ts = await openJ(instJ({ TRANSLATION: 1, SCALE: 2 }, [{ values: [5, 0, 0], comp: 5126, nc: 3 }, { values: [2, 1, 1], comp: 5126, nc: 3 }]));
  assert.deepEqual(boxOf(ts), [5000, 0, 0, 7000, 1000, 0]);
  // KHR_mesh_quantization NORMAL: float, normalized byte, normalized short
  const withNormal = (x) => { const j = gltfOf({ positions: TRI1, extra: [x] }); j.meshes[0].primitives[0].attributes.NORMAL = 1; return j; };
  await refusedFast(() => openJ(withNormal({ values: [0, 0, 1, 0, 0, 1, 0, 0, 1], comp: 5120, nc: 3 }), 'n.gltf'),
    /^n\.gltf is damaged: mesh 0 primitive 1's NORMAL accessor 1 is VEC3 of byte; NORMAL must be VEC3 of float, normalized byte or normalized short$/);
  for (const comp of [5120, 5122]) assert.equal(triCount(await openJ(withNormal({ values: [0, 0, 1, 0, 0, 1, 0, 0, 1], comp, nc: 3, normalized: true }))), 1, `NORMAL ${comp}`);
  // core COLOR_0: an integer colour must be normalized; float must not be
  await refusedFast(() => openJ(gltfOf({ positions: TRI1, colour: { values: [255, 0, 0, 255, 0, 0, 255, 0, 0], comp: 5121, nc: 3 } }), 'c.gltf'),
    /^c\.gltf is damaged: mesh 0 primitive 1's COLOR_0 accessor 1 is VEC3 of unsigned byte; COLOR_0 must be VEC3 or VEC4 of float, normalized unsigned byte or normalized unsigned short$/);
  // core: normalized MUST NOT be true for float (3.6.2.1); indices are uint8 / uint16 / uint32 (not unorm)
  await refusedFast(() => openJ(gltfOf({ positions: TRI1, normalized: true }), 'p.gltf'),
    /^p\.gltf is damaged: mesh 0 primitive 1's POSITION accessor 0 is VEC3 of normalized float; POSITION must be VEC3 of float, byte, unsigned byte, short or unsigned short$/);
  const ni = gltfOf({ positions: TRI1, extra: [{ values: [0, 1, 2], comp: 5121, nc: 1, normalized: true }] });
  ni.meshes[0].primitives[0].indices = 1;
  await refusedFast(() => openJ(ni, 'i.gltf'), /^i\.gltf is damaged: mesh 0 primitive 1's indices accessor 1 is SCALAR of normalized unsigned byte; indices must be SCALAR of unsigned byte, unsigned short or unsigned int$/);
  // KHR_mesh_quantization POSITION: every integer type, normalized or not
  for (const comp of [5120, 5121, 5122, 5123]) for (const nz of [false, true]) {
    assert.equal(triCount(await openJ(gltfOf({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], comp, normalized: nz }))), 1, `POSITION ${comp} ${nz}`);
  }
});
await test('r10-5 glTF accessor type rule in one place: a missing instancing or COLOR_0 accessor is reported as not there, not as the wrong type', async () => {
  await refusedFast(() => openJ(instJ({ TRANSLATION: 7 }, []), 'm.gltf'),
    /^m\.gltf is damaged: node 0's EXT_mesh_gpu_instancing's TRANSLATION accessor 7 is not there$/);
  const j = gltfOf({ positions: TRI1 });
  j.meshes[0].primitives[0].attributes.COLOR_0 = 9;
  await refusedFast(() => openJ(j, 'c.gltf'), /^c\.gltf is damaged: mesh 0 primitive 1's COLOR_0 accessor 9 is not there$/);
});
await test('r10-9 a quantized instance ROTATION is renormalised: normalized bytes [0, 0, 90, 90] (length 1.0022) keep a 1000 mm part 1000 mm', async () => {
  const m = await openJ(instJ({ ROTATION: 1 }, [{ values: [0, 0, 90, 90], comp: 5120, nc: 4, normalized: true }]));
  const [lx, ly, , hx, hy] = m.meshes[0].positions.length ? boxOf(m) : [];
  assert.ok(Math.abs(hy - ly - 1000) < 1e-6 && Math.abs(hx - lx - 1000) < 1e-6, `box ${JSON.stringify(boxOf(m))}`);
  // the edge from (0,0,0) to (1 m, 0, 0) is 1000 mm long after the turn
  const p = m.meshes[0].positions;
  const len = (a, b) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
  for (let a = 0; a < p.length / 3; a++) for (let b = a + 1; b < p.length / 3; b++) {
    const d = len(a, b);
    assert.ok(Math.abs(d - 1000) < 1e-6 || Math.abs(d - 1000 * Math.SQRT2) < 1e-6, `edge ${a}-${b}: ${d} mm`);
  }
});
await test('a binary STL cut short past the text limit is damaged, not "N MB of text" (r72 Q6)', async () => {
  // (12 M triangles counted, 600 MB of them there: 84 + 50 n is 600,000,084 bytes)
  const n = 12e6, size = 572 * 2 ** 20;
  const buf = new ArrayBuffer(size);
  new DataView(buf).setUint32(80, n, true);
  await assert.rejects(parseMesh('stl', buf, 'cut.stl'), /^Error: cut\.stl is damaged: its header counts 12,000,000 triangles, so it should be 600,000,084 bytes, but it is 599,785,472 bytes$/, 'must fire: "572 MB of text"');
});

// a .gltf of one mesh "bracket" of np one-triangle primitives (its buffer a data: URI), or of the
// primitives given
const bracketGltf = (np, prims = null) => {
  const bin = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  return new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ name: 'bracket', primitives: prims || Array.from({ length: np }, () => ({ attributes: { POSITION: 0 } })) }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${bin.toString('base64')}` }],
  })).buffer;
};
// (r112 M mesh-formats-O784) a mesh of two primitives gives two bodies numbered by it, one keeps its name
await test('a glTF mesh of two primitives is two bodies "bracket 1", "bracket 2"; of one, "bracket" (r112 M mesh-formats-O784)', async () => {
  const names = async (np) => (await parseMesh('gltf', bracketGltf(np), 'b.gltf')).meshes.map((x) => x.name);
  assert.deepEqual(await names(2), ['bracket 1', 'bracket 2']);
  assert.deepEqual(await names(1), ['bracket']);
});
// (r112 M mesh-formats-B203) a primitive that is not an object is refused in the damaged words
await test('a glTF primitive that is not an object is refused as damaged, in its own words (r112 M mesh-formats-B203)', async () => {
  for (const p of [5, null, 'x']) {
    await assert.rejects(parseMesh('gltf', bracketGltf(0, [p]), 'a.gltf'), { message: 'a.gltf is damaged: mesh 0 primitive 1 is not an object' }, JSON.stringify(p));
  }
});

done();
