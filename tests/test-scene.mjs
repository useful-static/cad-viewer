#!/usr/bin/env node
// Two models in one view (js/scene.js mergeModels) and the clearance between
// them (js/clearance.js).
//   node tests/test-scene.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { encodeCadmesh, decodeCadmesh, bytesToId } from '../js/cadmesh.js';
import { mergeModels, modelRanges } from '../js/scene.js';
import { clearance, triangleDistance } from '../js/clearance.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

// a box body as encodeCadmesh takes it: 8 corners, 12 triangles, 6 faces
function boxMesh(name, lo, hi) {
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[i * 3] = i & 1 ? hi[0] : lo[0];
    positions[i * 3 + 1] = i & 2 ? hi[1] : lo[1];
    positions[i * 3 + 2] = i & 4 ? hi[2] : lo[2];
  }
  const q = (a, b, c, d) => [a, b, c, a, c, d];
  const indices = new Uint32Array([...q(0, 2, 3, 1), ...q(4, 5, 7, 6), ...q(0, 1, 5, 4), ...q(2, 6, 7, 3), ...q(0, 4, 6, 2), ...q(1, 3, 7, 5)]);
  const faces = new Uint32Array([0, 2, 2, 2, 4, 2, 6, 2, 8, 2, 10, 2]);
  return { name, color: [0.5, 0.5, 0.5], positions, normals: null, colors: null, indices, faces };
}
function file(name, boxes) {
  const meshes = boxes.map(([n, lo, hi]) => boxMesh(n, lo, hi));
  const raw = encodeCadmesh({ units: 'mm', meshes, root: { name, meshes: meshes.map((_, i) => i), children: [] }, sourceUnits: 'mm' });
  return decodeCadmesh(raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

const board = file('board', [['pcb', [0, 0, 0], [10, 10, 1]], ['chip', [2, 2, 1], [4, 4, 2]]]);
const lid = file('case', [['lid', [0, 0, 5], [10, 10, 6]]]);

test('merge: counts, ids, tree, moved bodies', () => {
  const s = mergeModels([{ base: board, name: 'board.stp' }, { base: lid, name: 'case.stp', offset: [0, 0, 1] }]);
  const h = s.header;
  assert.equal(h.meshes.length, 3);
  assert.equal(h.vertexCount, board.header.vertexCount + lid.header.vertexCount);
  assert.equal(h.indexCount, board.header.indexCount + lid.header.indexCount);
  assert.deepEqual(h.root.children.map((c) => [c.name, c.meshes]), [['board.stp', [0, 1]], ['case.stp', [2]]]);
  // the lid's vertices carry id 3 and are moved up 1 mm
  const m = h.meshes[2];
  const v = m.vtxStart;
  assert.equal(bytesToId(...s.id.slice(v * 4, v * 4 + 4)), 3);
  assert.equal(m.bbox.min[2], 6);
  assert.equal(h.bbox.max[2], 7);
  // its triangles name its own vertices, and its faces its own triangles
  for (let i = m.idxStart; i < m.idxStart + m.idxCount; i++) assert.ok(s.index[i] >= m.vtxStart && s.index[i] < m.vtxStart + m.vtxCount);
  const f = s.faces[m.faceStart * 2];
  assert.equal(f, m.idxStart / 3);
  // the edges and facts of both are kept
  assert.equal(s.edges.length, board.edges.length + lid.edges.length);
  assert.equal(h.facts.volume.length, 3);
  assert.equal(h.sourceUnits, 'mm');
  assert.deepEqual(modelRanges([{ base: board }, { base: lid }]), [{ first: 1, count: 2 }, { first: 3, count: 1 }]);
});

const trisOf = (s, ids) => ids.map((id) => { const m = s.header.meshes[id - 1]; return [m.idxStart / 3, m.idxCount / 3]; });

test('clearance: the chip top to the lid underside', () => {
  const s = mergeModels([{ base: board, name: 'board' }, { base: lid, name: 'case' }]);
  const r = clearance(s.position, s.index, trisOf(s, [1, 2]), trisOf(s, [3]));
  assert.ok(Math.abs(r.distance - 3) < 1e-6, `distance ${r.distance}`);
  assert.ok(Math.abs(r.pa[2] - 2) < 1e-6 && Math.abs(r.pb[2] - 5) < 1e-6, `points ${r.pa} ${r.pb}`);
  assert.equal(s.index[r.triA * 3] >= s.header.meshes[1].vtxStart, true); // on the chip, not the board
});

test('clearance: moved down onto the chip, 0 (touching)', () => {
  const s = mergeModels([{ base: board, name: 'board' }, { base: lid, name: 'case', offset: [0, 0, -3] }]);
  const r = clearance(s.position, s.index, trisOf(s, [1, 2]), trisOf(s, [3]));
  assert.ok(r.distance < 1e-6, `distance ${r.distance}`);
});

test('clearance: overlapping (the lid sunk into the board), 0', () => {
  const s = mergeModels([{ base: board, name: 'board' }, { base: lid, name: 'case', offset: [3, 3, -5.5] }]);
  const r = clearance(s.position, s.index, trisOf(s, [1]), trisOf(s, [3]));
  assert.equal(r.distance, 0);
});

test('triangles: edge to edge (crossed, 2 apart), not vertex to face', () => {
  const A = [[-1, 0, 0], [1, 0, 0], [0, -5, 0]];
  const B = [[0, -1, 2], [0, 1, 2], [0, 0, 7]];
  const r = triangleDistance(A, B);
  assert.ok(Math.abs(Math.sqrt(r.d2) - 2) < 1e-9, `d ${Math.sqrt(r.d2)}`);
  // (a run of points is equally near: any of them, on x = 0, z 0 and 2)
  assert.ok(Math.abs(r.pa[0]) < 1e-9 && Math.abs(r.pa[2]) < 1e-9 && Math.abs(r.pb[2] - 2) < 1e-9, `${r.pa} ${r.pb}`);
});

test('clearance: many triangles, the tree agrees with every pair', () => {
  // two grids of small boxes, the second shifted: the brute force over every
  // triangle pair is the reference
  const a = [], b = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    a.push([`a${i}${j}`, [i * 3, j * 3, 0], [i * 3 + 1, j * 3 + 1.5, 1 + ((i * j) % 3) * 0.3]]);
    b.push([`b${i}${j}`, [i * 3 + 1.3, j * 3 + 0.2, 1.2 + ((i + j) % 4) * 0.25], [i * 3 + 2.2, j * 3 + 1, 3]]);
  }
  const s = mergeModels([{ base: file('a', a), name: 'a' }, { base: file('b', b), name: 'b' }]);
  const ta = trisOf(s, a.map((_, i) => i + 1)), tb = trisOf(s, b.map((_, i) => a.length + i + 1));
  const r = clearance(s.position, s.index, ta, tb);
  const tri = (t) => [0, 1, 2].map((c) => { const v = s.index[t * 3 + c] * 3; return [s.position[v], s.position[v + 1], s.position[v + 2]]; });
  let ref = Infinity;
  for (const [sa, ca] of ta) for (let x = sa; x < sa + ca; x++) for (const [sb, cb] of tb) for (let y = sb; y < sb + cb; y++) ref = Math.min(ref, triangleDistance(tri(x), tri(y)).d2);
  assert.ok(Math.abs(r.distance - Math.sqrt(ref)) < 1e-9, `tree ${r.distance} vs brute ${Math.sqrt(ref)}`);
  assert.ok(r.pairs < 36 * 12 * 36 * 12 / 10, `${r.pairs} pairs tested (the tree should skip most)`);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
