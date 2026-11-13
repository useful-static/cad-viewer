#!/usr/bin/env node
// Mesh export (js/export-mesh.js): STL, 3MF and GLB of a small model, each
// read back independently (node:zlib for the zip, the glTF chunk layout by
// hand).   node tests/test-export.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { EXPORTS, crc32, exportBasis, exportable, to3MF, toGLB, toSTL } from '../js/export-mesh.js';
import { parseMesh } from '../js/mesh-formats.js';

import { test, done } from './harness.mjs';

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

await test('STL: 84 + 50 n bytes, a header that is not "solid", the triangles in the basis', async () => {
  const b = await toSTL(model, [1, 2], YUP, 'plate');
  assert.equal(b.length, 84 + 50 * 3);
  assert.ok(!new TextDecoder().decode(b.slice(0, 5)).startsWith('solid'));
  const dv = new DataView(b.buffer);
  assert.equal(dv.getUint32(80, true), 3);
  // the third triangle (the blue one): its second vertex (4, 0, 5) -> (4, 5, -0)
  const o = 84 + 2 * 50 + 12 + 12;
  assert.deepEqual([dv.getFloat32(o, true), dv.getFloat32(o + 4, true), Math.abs(dv.getFloat32(o + 8, true))], [4, 5, 0]);
  // only the bodies asked for
  assert.equal((await toSTL(model, [2], IDENT)).length, 84 + 50);
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
  // each object names its default property, its first triangle's colour: "If this object contains
  // any triangles with assigned properties, the object MUST specify pid and pindex" (3MF core
  // spec ch. 4; the objects carried none -- r129)
  const objs = [...x.matchAll(/<object [^>]*>.*?<\/object>/g)].map((m) => m[0]);
  assert.equal(objs.length, 2);
  for (const o of objs) {
    const head = o.match(/^<object [^>]*>/)[0];
    assert.match(head, / pid="1" pindex="\d+"/, head);
    const first = o.match(/<triangle [^>]* p1="(\d+)"/)[1];
    assert.equal(head.match(/pindex="(\d+)"/)[1], first, 'the object default is its first triangle\'s colour');
  }
});
await test('a long non-ASCII name: the STL header is at most 80 bytes, cut at a whole character (r64 A1)', async () => {
  for (const name of ['板'.repeat(21), 'é'.repeat(70), '😀'.repeat(30), 'a'.repeat(200)]) {
    const b = await toSTL(model, [1, 2], IDENT, name);
    assert.equal(b.length, 84 + 50 * 3, name);
    const head = b.slice(0, 80);
    const end = head.indexOf(0) < 0 ? 80 : head.indexOf(0);
    // decoded strictly: a split character throws
    const text = new TextDecoder('utf-8', { fatal: true }).decode(head.slice(0, end));
    assert.ok(`cad.place export: ${name}`.startsWith(text) && text.length > 20, text);
  }
});
await test('3MF: a character XML does not allow in a body name is written as U+FFFD, so the file is well-formed (r64 A3)', async () => {
  const files = unzip(await to3MF(model, [1, 2], IDENT, ['Pl\u0001ate\u001f', 'lone \ud800 x￿']));
  const x = files['3D/3dmodel.model'];
  assert.doesNotMatch(x, /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/);
  assert.doesNotMatch(x, /[\ud800-\udfff]/);
  assert.match(x, /name="Pl�ate�"/);
  assert.match(x, /name="lone � x�"/);
  // must accept: a pair (an emoji) is one character, kept
  const ok = unzip(await to3MF(model, [1, 2], IDENT, ['😀', 'tab\tok']))['3D/3dmodel.model'];
  assert.match(ok, /name="😀"/);
  assert.match(ok, /name="tab\tok"/);
});
await test('GLB: the header and chunks; per body a node, positions in metres with bounds, normals, colours, indices', async () => {
  const g = await toGLB(model, [1, 2], YUP);
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
  // (linear, normalized 16 bits: r70 Q1)
  assert.deepEqual([ca.componentType, ca.normalized], [5123, true]);
  assert.deepEqual([...new Uint16Array(g.buffer.slice(binOff + cv.byteOffset, binOff + cv.byteOffset + 8))], [0, 0, 65535, 65535]);
  // (the normals in the file's axes, as the positions are: the model's +z is the file's +y. Left in
  // the model's axes, every tool that shades by NORMAL lit it wrong: r111 H1-M6)
  for (const mi of [0, 1]) {
    const na = j.accessors[j.meshes[mi].primitives[0].attributes.NORMAL], nv = j.bufferViews[na.bufferView];
    const N = new Float32Array(g.buffer.slice(binOff + nv.byteOffset, binOff + nv.byteOffset + nv.byteLength));
    for (let v = 0; v < na.count; v++) assert.deepEqual([N[3 * v], N[3 * v + 1], N[3 * v + 2]].map((x) => +x.toFixed(4) + 0), [0, 1, 0], `body ${mi} vertex ${v}`);
  }
  for (const v of j.bufferViews) assert.equal(v.byteOffset % 4, 0);
});
await test('3MF of a large body: written in batches, the page given turns between them -- no hold of the thread past a fraction of a second (r70 Q4: 5 M triangles held it 16.8 s, 9 M ran past the string limit)', async () => {
  const W = 500, rows = 501, V = W * rows;
  const P2 = new Float32Array(3 * V), N2 = new Int16Array(4 * V), C2 = new Uint8Array(4 * V).fill(200);
  for (let r = 0; r < rows; r++) for (let c = 0; c < W; c++) { const v = r * W + c; P2[3 * v] = c * 0.1; P2[3 * v + 1] = r * 0.1; N2[4 * v + 2] = 32767; }
  const I2 = [];
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < W; c++) { const v = r * W + c; I2.push(v, v + 1, v + W, v + 1, v + W + 1, v + W); }
  const big = { position: P2, normal: N2, color: C2, index: Uint32Array.from(I2), header: { meshes: [{ name: 'grid', vtxStart: 0, vtxCount: V, idxStart: 0, idxCount: I2.length }] } };
  let last = performance.now(), gap = 0;
  const tick = setInterval(() => { const t = performance.now(); gap = Math.max(gap, t - last); last = t; }, 5);
  const t0 = performance.now();
  const z = await to3MF(big, [1], IDENT);
  const ms = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 20)); // (a tick after it: the last hold seen too -- r72)
  clearInterval(tick);
  const x = unzip(z)['3D/3dmodel.model'];
  assert.equal((x.match(/<triangle /g) || []).length, I2.length / 3, 'every triangle written');
  assert.match(x, /<\/triangles><\/mesh><\/object><\/resources><build><item objectid="2"\/><\/build><\/model>$/);
  assert.ok(gap < 400, `the longest hold ${gap.toFixed(0)} ms of ${ms.toFixed(0)} ms (must fire: the whole part built in one)`);
});
// a W x rows grid of one body, its triangles 2 (W - 1)(rows - 1); colours: per vertex
const grid = (W, rows, colour = () => [200, 200, 200]) => {
  const V = W * rows;
  const P2 = new Float32Array(3 * V), N2 = new Int16Array(4 * V), C2 = new Uint8Array(4 * V);
  for (let r = 0; r < rows; r++) for (let c = 0; c < W; c++) { const v = r * W + c; P2[3 * v] = c * 0.1; P2[3 * v + 1] = r * 0.1; N2[4 * v + 2] = 32767; C2.set([...colour(v), 255], 4 * v); }
  const I2 = new Uint32Array(6 * (W - 1) * (rows - 1));
  let k = 0;
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < W; c++) { const v = r * W + c; I2.set([v, v + 1, v + W, v + 1, v + W + 1, v + W], k); k += 6; }
  return { position: P2, normal: N2, color: C2, index: I2, header: { meshes: [{ name: 'grid', vtxStart: 0, vtxCount: V, idxStart: 0, idxCount: I2.length }] } };
};
await test('STL and GLB of a large body give the page turns, as 3MF does (r72 A7: 2 M triangles held it 422 ms in STL, 1,179 ms in GLB)', async () => {
  const big = grid(2001, 501); // (2,000,000 triangles: at 1 M one task's hold here was 164 ms, under the bound)
  for (const fmt of ['stl', 'glb']) {
    let last = performance.now(), gap = 0;
    const tick = setInterval(() => { const t = performance.now(); gap = Math.max(gap, t - last); last = t; }, 5);
    const t0 = performance.now();
    const b = await EXPORTS[fmt].write(big, [1], IDENT, { names: ['grid'], base: 'grid' });
    const ms = performance.now() - t0;
    // (a tick after it, to see the last hold: a write in one task leaves none between, and read 0 ms)
    await new Promise((r) => setTimeout(r, 20));
    clearInterval(tick);
    if (fmt === 'stl') assert.equal(b.length, 84 + 50 * 2e6);
    assert.ok(gap < 150, `${fmt}: the longest hold ${gap.toFixed(0)} ms of ${ms.toFixed(0)} ms (must fire: one task)`);
  }
});
await test('no export writes what the viewer\'s readers refuse: more triangles than they place, a 3MF of more colours than its base materials take (r72 A6, Q5)', async () => {
  const { tooManyToExport } = await import('../js/export-mesh.js');
  const { MAX_PLACED_TRIANGLES, MAX_PLACED_PARTS } = await import('../js/formats.js');
  // (a header claiming one more triangle than the cap: refused before anything is built)
  const over = { ...model, header: { meshes: [{ name: 'huge', vtxStart: 0, vtxCount: 4, idxStart: 0, idxCount: 3 * (MAX_PLACED_TRIANGLES + 1) }] } };
  for (const fmt of Object.keys(EXPORTS)) {
    await assert.rejects(EXPORTS[fmt].write(over, [1], IDENT, { names: ['huge'], base: 'huge' }), (e) => e.message === tooManyToExport(MAX_PLACED_TRIANGLES + 1), `${fmt} (must fire: written)`);
  }
  // GLB's accessors: no more values than the reader takes (r73 A3) -- a body claiming 22,500,001
  // vertices, its colours 4 a vertex (must fire: built and written)
  const wide = { ...model, header: { meshes: [{ name: 'scan', vtxStart: 0, vtxCount: 22_500_001, idxStart: 0, idxCount: 3 }] } };
  await assert.rejects(toGLB(wide, [1], IDENT), /^Error: not written as GLB: scan would need an accessor of 90,000,004 values, more than the 90,000,000 this viewer reads \(STL or 3MF writes it\)$/);
  // 3MF's colours: by the reader's cap, here a smaller one
  const many = grid(40, 40, (v) => [v & 255, (v >> 8) & 255, 7]); // (1,600 colours)
  await assert.rejects(to3MF(many, [1], IDENT, [], undefined, 1000), /^Error: not written as 3MF: its 1,\d{3} colours are more than the 1,000 this viewer reads \(GLB writes them\)$/);
  assert.ok(unzip(await to3MF(many, [1], IDENT, [], undefined, 2000))['3D/3dmodel.model'].includes('<base '), 'under it, written');
  assert.match(to3MF.toString(), /maxColours = MAX_PLACED_PARTS\)/, 'the default is the reader\'s cap (must fire: none)');
  assert.equal(MAX_PLACED_PARTS, 2_000_000);
});
await test('the zip takes a part\'s CRC with turns between, not in one task (r71 A6, Q3: 436 MB of 3MF text held the page 1.4 s in its CRC alone)', async () => {
  const { zip } = await import('../js/export-mesh.js');
  // 160 MB in 2 MB chunks, about half a second of CRC in one task
  const chunk = new Uint8Array(2 * 2 ** 20);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31) & 0xff;
  const chunks = Array.from({ length: 80 }, () => chunk);
  let last = performance.now(), gap = 0;
  const tick = setInterval(() => { const t = performance.now(); gap = Math.max(gap, t - last); last = t; }, 5);
  const t0 = performance.now();
  const z = await zip([['a.bin', chunks]]);
  const ms = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 20)); // (a tick after it: the last hold seen too -- r72)
  clearInterval(tick);
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let want = 0;
  for (const c of chunks) want = crc32(c, 0, c.length, want);
  assert.deepEqual([dv.getUint32(14, true), dv.getUint32(22, true)], [want, 80 * chunk.length], 'the CRC and size of the whole');
  assert.ok(gap < 250, `the longest hold ${gap.toFixed(0)} ms of ${ms.toFixed(0)} ms (must fire: the CRC in one task)`);
});
await test('3MF: a model part past the text the viewer reads is refused, naming the formats that write it; under it written (r71 A5: a 7.6 M-triangle plate wrote a 3MF the viewer refused)', async () => {
  const ok = await to3MF(model, [1, 2], IDENT, [], 4000);
  assert.ok(unzip(ok)['3D/3dmodel.model'].length < 4000);
  await assert.rejects(to3MF(model, [1, 2], IDENT, [], 600), /^Error: not written as 3MF: its model part would be more than the 500 MB of text this viewer reads \(STL or GLB writes it\)$/, 'must fire: written past it');
  // (by the reader's own limit, by default: the reader's 3MF counts its model parts against it)
  assert.match(to3MF.toString(), /maxText = MAX_TEXT_BYTES[,)]/, 'the default is the reader\'s limit (must fire: none)');
});
await test('GLB: a mid-tone body exported and read back by the viewer\'s own glTF reader is the colour it was drawn, as 3MF\'s (r70 Q1: rgb(128,64,200) came back rgb(188,137,229))', async () => {
  const c2 = new Uint8Array(7 * 4);
  for (let v = 0; v < 7; v++) c2.set(v < 4 ? [128, 64, 200, 255] : [20, 200, 90, 255], 4 * v);
  const g = await toGLB({ ...model, color: c2 }, [1, 2], YUP);
  const r = await parseMesh('glb', g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength), 'a.glb');
  const cols = r.meshes.map((m) => m.color.map((c) => Math.round(c * 255)).join(','));
  assert.deepEqual(cols, ['128,64,200', '20,200,90'], `read back: ${cols.join(' | ')}`);
});

await test('a body wound inward with its normals out (a mirrored placement) is written with its outside out: STL, 3MF and GLB as the view shows it (r25 A3)', async () => {
  // a cube of 12 triangles, own corners: wound inward, the stored normals outward (its centre 5, 5, 5)
  const S = 10, C = [];
  for (let i = 0; i < 8; i++) C.push([i & 1 ? S : 0, i & 2 ? S : 0, i & 4 ? S : 0]);
  const q = (a, b, c, d) => [[a, b, c], [a, c, d]];
  const TRIS = [...q(0, 2, 3, 1), ...q(4, 5, 7, 6), ...q(0, 1, 5, 4), ...q(2, 6, 7, 3), ...q(0, 4, 6, 2), ...q(1, 3, 7, 5)];
  const pos = [], nrm = [], idx = [];
  for (const [a, b, c] of TRIS) {
    const n = (() => { const u = C[b].map((x, k) => x - C[a][k]), w = C[c].map((x, k) => x - C[a][k]); const v = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; const l = Math.hypot(...v); return v.map((x) => Math.round((x / l) * 32767)); })();
    for (const v of [a, c, b]) { idx.push(pos.length / 3); pos.push(...C[v]); nrm.push(...n, 0); }
  }
  const nv = pos.length / 3;
  const mirrored = {
    position: new Float32Array(pos), normal: Int16Array.from(nrm), color: new Uint8Array(nv * 4).fill(200), index: Uint32Array.from(idx),
    header: { meshes: [{ name: 'cube', vtxStart: 0, vtxCount: nv, idxStart: 0, idxCount: idx.length }] },
  };
  const out = (p, n) => (p[0] - 5) * n[0] + (p[1] - 5) * n[1] + (p[2] - 5) * n[2] > 0;
  const windOut = (P, I) => {
    let k = 0;
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t], I[t + 1], I[t + 2]].map((v) => [P[3 * v], P[3 * v + 1], P[3 * v + 2]]);
      const u = b.map((x, j) => x - a[j]), w = c.map((x, j) => x - a[j]);
      if (out(a.map((x, j) => (x + b[j] + c[j]) / 3), [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]])) k++;
    }
    return k;
  };
  // STL: the facet normals and the corner order
  const s = await toSTL(mirrored, [1], IDENT, 'cube');
  const dv = new DataView(s.buffer);
  const sp = [], si = [];
  let facets = 0;
  for (let t = 0; t < 12; t++) {
    const o = 84 + t * 50;
    const n = [0, 1, 2].map((k) => dv.getFloat32(o + 4 * k, true));
    const corners = [0, 1, 2].map((v) => [0, 1, 2].map((k) => dv.getFloat32(o + 12 + 12 * v + 4 * k, true)));
    if (out(corners.map((p) => p).reduce((m, p) => m.map((x, j) => x + p[j] / 3), [0, 0, 0]), n)) facets++;
    for (const p of corners) { si.push(sp.length / 3); sp.push(...p); }
  }
  assert.equal(facets, 12, 'STL facet normals out');
  assert.equal(windOut(sp, si), 12, 'STL winding out');
  // 3MF: the triangles' corner order
  const z = unzip(await to3MF(mirrored, [1], IDENT, ['cube']));
  const xml = z['3D/3dmodel.model'];
  const vx = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].flatMap((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  const tx = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].flatMap((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  assert.equal(windOut(vx, tx), 12, '3MF winding out');
  // GLB: its indices' winding (glTF's front face)
  const g = await toGLB(mirrored, [1], IDENT);
  const jl = new DataView(g.buffer).getUint32(12, true);
  const j = JSON.parse(new TextDecoder().decode(g.slice(20, 20 + jl)));
  const bin = g.slice(20 + jl + 8);
  const acc = (i) => { const a = j.accessors[i], v = j.bufferViews[a.bufferView], o = (v.byteOffset || 0) + (a.byteOffset || 0); return bin.slice(o, o + v.byteLength); };
  const prim = j.meshes[0].primitives[0];
  const gp = new Float32Array(acc(prim.attributes.POSITION).buffer.slice(0)), ib = acc(prim.indices);
  const gi = j.accessors[prim.indices].componentType === 5125 ? new Uint32Array(ib.buffer.slice(0)) : new Uint16Array(ib.buffer.slice(0));
  assert.equal(windOut(gp.map((x) => x * 1000), gi), 12, 'GLB winding out');
});
await test('EXPORTS: each row writes its own format through the one call shape', async () => {
  const magic = { stl: (b) => b.length === 84 + 50 * 3, '3mf': (b) => b[0] === 0x50 && b[1] === 0x4b, glb: (b) => new TextDecoder().decode(b.slice(0, 4)) === 'glTF' };
  for (const [fmt, row] of Object.entries(EXPORTS)) {
    const b = await row.write(model, [1, 2], IDENT, { names: ['plate', 'tri'], base: 'plate' });
    assert.ok(magic[fmt](b), fmt);
    assert.match(row.type, /^model\//);
    assert.ok(row.up === 'z' || row.up === 'y');
  }
  assert.deepEqual(Object.keys(EXPORTS).sort(), Object.keys(magic).sort());
});

await test('an empty body is left out of the GLB and the 3MF (it made a count-0 accessor with null bounds)', async () => {
  const m3 = { ...model, header: { meshes: [...model.header.meshes, { name: 'empty', vtxStart: 7, vtxCount: 0, idxStart: 9, idxCount: 0 }] } };
  const g = await toGLB(m3, [1, 2, 3], YUP, ['plate', 'tri', 'empty']);
  const jl = new DataView(g.buffer).getUint32(12, true);
  const j = JSON.parse(new TextDecoder().decode(g.slice(20, 20 + jl)));
  assert.equal(j.nodes.length, 2);
  assert.ok(j.accessors.every((a) => a.count > 0 && (!a.min || a.min.every((x) => x !== null))));
  // the 3MF read back by our own reader: its two bodies, by name (the empty one left out)
  const z = await to3MF(m3, [1, 2, 3], IDENT, ['plate', 'tri', 'empty']);
  const back = await parseMesh('3mf', z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength), 'two.3mf');
  assert.deepEqual(back.meshes.map((x) => x.name), ['plate', 'tri']);
  // the one count the page and the CLI say and refuse by; none left: refused, not an empty file
  assert.deepEqual(exportable(m3, [1, 2, 3]), [1, 2]);
  await assert.rejects(toGLB(m3, [3], YUP, ['empty']), /nothing to export/);
  await assert.rejects(toSTL(m3, [3], IDENT, 'empty'), /nothing to export/); // (it wrote an 84-byte STL)
  await assert.rejects(to3MF(m3, [3], IDENT, ['empty']), /nothing to export/);
});
test('the export axes are right-handed for every orientation, Z up and Y up: no export mirrored (r109 C4)', () => {
  const det = ([a, b, c]) => a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  let n = 0;
  for (const u of ['+x', '-x', '+y', '-y', '+z', '-z']) for (const f of ['+x', '-x', '+y', '-y', '+z', '-z']) {
    if (u[1] === f[1]) continue;
    for (const up of ['z', 'y']) { n++; assert.ok(Math.abs(det(exportBasis(u + f, up)) - 1) < 1e-12, `${u}${f} ${up} up: det ${det(exportBasis(u + f, up))}`); }
  }
  assert.equal(n, 48);
});

// (r112 M export-mesh-O170) every GLB accessor's buffer view is exactly its count x element size,
// COLOR_0 four normalized uint16 a vertex (no padding element)
await test('GLB: each buffer view is exactly its accessor\'s count x element size, COLOR_0 4 x uint16 a vertex (r112 M export-mesh-O170)', async () => {
  const g = await toGLB(model, [1, 2], IDENT);
  const jl = new DataView(g.buffer, g.byteOffset).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(g.subarray(20, 20 + jl)));
  const comp = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }, width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  let colours = 0;
  for (const mesh of json.meshes) for (const pr of mesh.primitives) {
    const c = json.accessors[pr.attributes.COLOR_0];
    assert.deepEqual([c.type, c.componentType, c.normalized], ['VEC4', 5123, true]);
    colours += c.count;
  }
  assert.equal(colours, 7);
  for (const a of json.accessors) {
    const v = json.bufferViews[a.bufferView];
    assert.equal(v.byteLength, a.count * comp[a.componentType] * width[a.type], `accessor ${JSON.stringify(a)}`);
  }
  assert.equal(g.length, 2048);
});
// (r112 M export-mesh-O89) each 3MF entry's local header says the version its central directory
// entry says: 2.0 (deflate)
await test('3MF: every local header needs version 2.0, as its central directory entry says (r112 M export-mesh-O89)', async () => {
  const z = await to3MF(model, [1, 2], IDENT);
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let e = z.length - 22;
  while (dv.getUint32(e, true) !== 0x06054b50) e--;
  let p = dv.getUint32(e + 16, true);
  const n = dv.getUint16(e + 10, true);
  assert.equal(n, 3);
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(p + 42, true);
    assert.equal(dv.getUint32(off, true), 0x04034b50);
    assert.equal(dv.getUint16(off + 4, true), 20, `entry ${i}: local version needed`);
    assert.equal(dv.getUint16(p + 6, true), 20, `entry ${i}: central version needed`);
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
});

done();
