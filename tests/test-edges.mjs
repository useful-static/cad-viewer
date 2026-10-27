#!/usr/bin/env node
// The edge list and body facts (js/edges.js) on bodies built the way
// OpenCascade meshes them: every face with its own vertices.
//   node tests/test-edges.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { EDGE_STRIDE, SIL_STRIDE, bodyTable, buildEdges, edgeInstances, silhouetteInstances } from '../js/edges.js';
import { decodeCadmesh, encodeCadmesh } from '../js/cadmesh.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

// one body from faces, each a list of quads [p0, p1, p2, p3] (CCW seen from
// outside) sharing vertices within the face only
function body(faces, kind = null) {
  const positions = [];
  const indices = [];
  for (const quads of faces) {
    const base = positions.length / 3;
    const ids = new Map();
    const vid = (p) => {
      const k = p.join(',');
      if (!ids.has(k)) { ids.set(k, base + ids.size); positions.push(...p); }
      return ids.get(k);
    };
    for (const [a, b, c, d] of quads) {
      const [ia, ib, ic, id] = [a, b, c, d].map(vid);
      indices.push(ia, ib, ic, ia, ic, id);
    }
  }
  return { name: 'b', positions: Float32Array.from(positions), indices: Uint32Array.from(indices), kind };
}

// the six faces of an axis box, outward CCW
function boxFaces(x0, y0, z0, x1, y1, z1, skip = []) {
  const f = {
    bottom: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
    top: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    front: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    back: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    left: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    right: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
  };
  return Object.entries(f).filter(([k]) => !skip.includes(k)).map(([, q]) => [q]);
}

// a decoded model from bodies
const model = (bodies) => {
  const m = decodeCadmesh(encodeCadmesh({ meshes: bodies }, { edges: false }));
  return { position: m.position, index: m.index, meshes: m.header.meshes };
};

test('a box has 12 unique edges, no silhouette candidates, and is closed by the mesh', () => {
  const r = buildEdges(model([body(boxFaces(0, 0, 0, 2, 3, 4))]));
  assert.equal(r.edges.length / 2, 12);
  assert.equal(r.silhouettes.length, 0);
  assert.deepEqual(r.facts.closed, [true]);
  assert.ok(Math.abs(r.facts.area[0] - 2 * (6 + 8 + 12)) < 1e-9, `area ${r.facts.area[0]}`);
  assert.ok(Math.abs(r.facts.volume[0] - 24) < 1e-9, `volume ${r.facts.volume[0]}`);
});
test('the kept copy of an edge is the lower-numbered face\'s', () => {
  const m = model([body(boxFaces(0, 0, 0, 1, 1, 1))]);
  const r = buildEdges(m);
  // the bottom face is first (vertices 0-3): its 4 edges all come from it
  const fromBottom = [];
  for (let e = 0; e < r.edges.length; e += 2) if (r.edges[e] < 4 && r.edges[e + 1] < 4) fromBottom.push(e / 2);
  assert.equal(fromBottom.length, 4);
});
test('a box missing its top is open; still 12 edges (the rim once)', () => {
  const r = buildEdges(model([body(boxFaces(0, 0, 0, 1, 1, 1, ['top']))]));
  assert.equal(r.edges.length / 2, 12);
  assert.deepEqual(r.facts.closed, [false]);
});
test('the converter\'s kind decides closed, not the mesh', () => {
  const r = buildEdges(model([body(boxFaces(0, 0, 0, 1, 1, 1, ['top']), 'capped'), body(boxFaces(2, 0, 0, 3, 1, 1), 'open')]));
  assert.deepEqual(r.facts.closed, [true, false]);
});
test('a mirrored body has a positive volume', () => {
  const b = body(boxFaces(0, 0, 0, 2, 2, 2));
  for (let i = 0; i < b.positions.length; i += 3) b.positions[i] = -b.positions[i];
  const r = buildEdges(model([b]));
  assert.ok(Math.abs(r.facts.volume[0] - 8) < 1e-9, `volume ${r.facts.volume[0]}`);
});
test('-0 and +0 weld: a face meeting another at x = -0 still joins it', () => {
  const b = body(boxFaces(0, 0, 0, 1, 1, 1));
  // the left face (x0 = 0) written with -0
  const faces = boxFaces(0, 0, 0, 1, 1, 1);
  const left = body([faces[4]]);
  for (let i = 0; i < left.positions.length; i += 3) left.positions[i] = -0;
  const merged = body([...faces.slice(0, 4), faces[5]]);
  const off = merged.positions.length / 3;
  merged.positions = Float32Array.from([...merged.positions, ...left.positions]);
  merged.indices = Uint32Array.from([...merged.indices, ...[...left.indices].map((i) => i + off)]);
  assert.equal(buildEdges(model([merged])).edges.length / 2, 12);
  assert.equal(buildEdges(model([b])).edges.length / 2, 12);
});
test('two bodies sharing a face position do not weld across bodies', () => {
  const r = buildEdges(model([body(boxFaces(0, 0, 0, 1, 1, 1)), body(boxFaces(1, 0, 0, 2, 1, 1))]));
  assert.equal(r.edges.length / 2, 24);
});

// a curved face: a half-tube of n flat strips, one face (shared vertices)
function tube(n, flipOne = false) {
  const quads = [];
  for (let i = 0; i < n; i++) {
    const a0 = (Math.PI * i) / n, a1 = (Math.PI * (i + 1)) / n;
    quads.push([[Math.cos(a0), Math.sin(a0), 0], [Math.cos(a0), Math.sin(a0), 1], [Math.cos(a1), Math.sin(a1), 1], [Math.cos(a1), Math.sin(a1), 0]]);
  }
  const b = body([quads]);
  if (flipOne) { const t = 3; [b.indices[t * 3 + 1], b.indices[t * 3 + 2]] = [b.indices[t * 3 + 2], b.indices[t * 3 + 1]]; }
  return b;
}
test('a curved face: its rib edges are candidates, the coplanar diagonals are not', () => {
  const r = buildEdges(model([tube(8)]));
  // 8 strips: 7 ribs between strips; each strip's diagonal joins coplanar triangles
  assert.equal(r.silhouettes.length / 2, 7);
  assert.equal(r.edges.length / 2, 2 * 8 + 2, 'two arcs of 8 segments and the two straight ends');
});
test('a flipped triangle does not make its edges outline candidates', () => {
  const r = buildEdges(model([tube(8, true)]));
  assert.equal(r.silhouettes.length / 2, 7);
  // each candidate's normals: unit, and within the strip angle of each other
  const n = r.silhouetteNormals;
  for (let i = 0; i < n.length; i += 8) {
    const dot = (n[i] * n[i + 4] + n[i + 1] * n[i + 5] + n[i + 2] * n[i + 6]) / 32767 ** 2;
    assert.ok(dot > Math.cos(Math.PI / 4), `candidate ${i / 8} normals dot ${dot}`);
  }
});
test('past the cap the candidates are left out and counted', () => {
  const r = buildEdges(model([tube(8)]), { silhouetteCap: 6 });
  assert.equal(r.silhouettes, null);
  assert.equal(r.silhouettesOmitted, 7);
  assert.equal(r.edges.length / 2, 18, 'boundary edges are kept');
});

test('edge instances: both ends, the body id and the kept face\'s colour, 32 bytes each', () => {
  const faces = boxFaces(0, 0, 0, 1, 1, 1);
  const m = decodeCadmesh(encodeCadmesh({ meshes: [body(faces.slice(0, 1)), body(faces)] }, { edges: false }));
  // colour the second body's first face (vertices 4-7) red, the rest stays grey
  for (let v = 4; v < 8; v++) m.color.set([255, 0, 0, 255], v * 4);
  const r = buildEdges({ position: m.position, index: m.index, meshes: m.header.meshes });
  const buf = edgeInstances(m, r.edges);
  assert.equal(buf.byteLength, (r.edges.length / 2) * EDGE_STRIDE);
  const f = new Float32Array(buf);
  const b = new Uint8Array(buf);
  const n = r.edges.length / 2;
  for (let e = 0; e < n; e++) {
    const a = r.edges[e * 2], c = r.edges[e * 2 + 1];
    assert.deepEqual([...f.slice(e * 8, e * 8 + 6)], [...m.position.slice(a * 3, a * 3 + 3), ...m.position.slice(c * 3, c * 3 + 3)]);
    assert.deepEqual([...b.slice(e * 32 + 24, e * 32 + 28)], [...m.id.slice(a * 4, a * 4 + 4)]);
  }
  // the second body's bottom face is its lowest: its 4 edges come out red
  const red = [];
  for (let e = 0; e < n; e++) if (b[e * 32 + 28] === 255 && b[e * 32 + 29] === 0) red.push(e);
  assert.equal(red.length, 4);
});

test('silhouette instances: the edge instance, then both normals, 48 bytes each', () => {
  const m = decodeCadmesh(encodeCadmesh({ meshes: [tube(8)] }, { edges: false }));
  const r = buildEdges({ position: m.position, index: m.index, meshes: m.header.meshes });
  const buf = silhouetteInstances(m, r.silhouettes, r.silhouetteNormals);
  const n = r.silhouettes.length / 2;
  assert.equal(buf.byteLength, n * SIL_STRIDE);
  const plain = new Uint8Array(edgeInstances(m, r.silhouettes));
  const b = new Uint8Array(buf);
  const s = new Int16Array(buf);
  for (let e = 0; e < n; e++) {
    assert.deepEqual([...b.slice(e * 48, e * 48 + 32)], [...plain.slice(e * 32, e * 32 + 32)]);
    assert.deepEqual([...s.slice(e * 24 + 16, e * 24 + 24)], [...r.silhouetteNormals.slice(e * 8, e * 8 + 8)]);
  }
});

test('the body table: slot 0 empty, then each body\'s centre and half-diagonal', () => {
  const h = { meshes: [{ bbox: { min: [0, 0, 0], max: [2, 2, 1] } }, { bbox: null }, { bbox: { min: [-1, -1, -1], max: [1, 1, 1] } }] };
  const t = bodyTable(h);
  assert.equal(t.length, 4 * 8);
  assert.deepEqual([...t.slice(0, 8)], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...t.slice(12, 16)], [1, 1, 0.5, 1.5]);
  assert.deepEqual([...t.slice(20, 24)], [0, 0, 0, 0], 'no vertices: radius 0');
  assert.ok(Math.abs(t[31] - Math.sqrt(3)) < 1e-6);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
