#!/usr/bin/env node
// split-board.mjs on a synthetic fused board: a 20 x 10 x 1.5 mm slab whose
// top face carries two blocks (fused: the blocks' side faces meet the top
// face's vertices), a sliver pad loose on one block, and a sliver under the
// board below that block. Expects the board and two parts, the pad merged
// into its block, the sliver under the board left to the board (never
// through it to a part on the other face), a valid cadmesh, and every
// triangle kept. No GPU, no network:  node tests/test-split-board.mjs

import assert from 'node:assert/strict';
import { decodeCadmesh, encodeCadmesh } from '../js/cadmesh.js';
import { splitBoard } from '../split-board.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

// a body built face by face: each face its own vertices (as OpenCascade meshes)
function builder() {
  const pos = [], idx = [], faces = [];
  const face = (pts) => { // pts: a convex polygon, fanned
    const v0 = pos.length / 3, t0 = idx.length / 3;
    for (const p of pts) pos.push(...p);
    for (let i = 1; i + 1 < pts.length; i++) idx.push(v0, v0 + i, v0 + i + 1);
    faces.push(t0, pts.length - 2);
  };
  // an axis-aligned box's six faces, the bottom one optional
  const box = (x0, y0, z0, x1, y1, z1, { bottom = true } = {}) => {
    face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
    if (bottom) face([[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]]);
    face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
    face([[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]);
    face([[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]);
    face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
  };
  return { pos, idx, faces, face, box };
}

function fusedBoard() {
  const b = builder();
  // the board: top and bottom (the largest faces), and its four sides
  b.box(0, 0, 0, 20, 10, 1.5);
  // block A (2..6 x 2..6, 3 mm tall) and block B (12..18 x 3..8, 5 mm),
  // standing on the top face with no bottom of their own: fused. Their
  // feet are joined to the board by a ring face lying in the top plane.
  b.box(2, 2, 1.5, 6, 6, 4.5, { bottom: false });
  b.face([[2, 2, 1.5], [6, 2, 1.5], [6, 6, 1.5], [2, 6, 1.5]]); // in-slab: board
  b.box(12, 3, 1.5, 18, 8, 6.5, { bottom: false });
  // a 0.6 mm sliver under the board, below block A (a capacitor under a chip)
  b.box(3.7, 3.7, -0.6, 4.3, 4.3, 0, {});
  // a 0.6 mm pad loose on top of block A, sharing none of its vertices
  b.box(2.2, 2.2, 4.6, 2.8, 2.8, 4.9, {});
  const nTri = b.idx.length / 3;
  const model = {
    units: 'millimeter',
    meshes: [{ name: 'fused', color: [0.5, 0.5, 0.5], positions: Float32Array.from(b.pos), normals: null, colors: null,
      indices: Uint32Array.from(b.idx), faces: Uint32Array.from(b.faces) }],
  };
  const buf = encodeCadmesh(model, { edges: false });
  return { d: decodeCadmesh(buf), nTri };
}

test('cuts the board from its parts; a sliver joins a part on its own face only', () => {
  const { d, nTri } = fusedBoard();
  const s = splitBoard(d, { sliver: 1.2 });
  assert.deepEqual(s.slab, [0, 1.5]);
  assert.equal(s.parts, 2);
  assert.deepEqual(s.meshes.map((m) => m.name), ['fused', 'part 1', 'part 2', 'small parts, -z face']);
  const tris = s.meshes.map((m) => m.indices.length / 3);
  assert.equal(tris.reduce((a, b) => a + b, 0), nTri, 'every triangle kept, once');
  // block A: its 5 faces + the pad's 6 = 11; B: 5; the board: its 6, the
  // ring and the under-board sliver's top (at z 0, in the slab) = 8; the
  // sliver's other 5, with no part on its face of the board: that face's
  // small parts. The board's box stays the board's thickness.
  assert.equal(s.meshes[1].faces.length / 2, 11);
  assert.equal(s.meshes[2].faces.length / 2, 5);
  assert.equal(s.meshes[0].faces.length / 2, 8);
  assert.equal(s.meshes[3].faces.length / 2, 5);
  let zlo = Infinity, zhi = -Infinity;
  for (let i = 2; i < s.meshes[0].positions.length; i += 3) { zlo = Math.min(zlo, s.meshes[0].positions[i]); zhi = Math.max(zhi, s.meshes[0].positions[i]); }
  assert.deepEqual([zlo, zhi], [0, 1.5]);
  // part 1 is the left block (named by position)
  const xs = (m) => { let lo = Infinity; for (let i = 0; i < m.positions.length; i += 3) lo = Math.min(lo, m.positions[i]); return lo; };
  assert.ok(xs(s.meshes[1]) < xs(s.meshes[2]));
});

test('the output encodes and decodes as a valid cadmesh', () => {
  const { d } = fusedBoard();
  const s = splitBoard(d);
  const out = decodeCadmesh(encodeCadmesh({ units: 'millimeter', meshes: s.meshes }, { edges: false }));
  assert.equal(out.header.meshes.length, 4);
  assert.ok(out.faces, 'faces section kept');
});

// A part flush with the board's edge, whose front face the export merged
// with the board's edge face into one face running the edge's whole length
// (a card slot flush with the edge): that face is the board's, the part its own.
test('a part flush with the board edge does not take the edge with it', () => {
  const b = builder();
  b.box(0, 0, 0, 20, 10, 1.5);
  // the slot under the board at the x = 0 edge: 3 x 2 x 1 mm, no front face
  // of its own and no top (fused to the board's underside)
  const [x1, y0, y1, z0] = [3, 4, 6, -1];
  b.face([[0, y0, z0], [x1, y0, z0], [x1, y1, z0], [0, y1, z0]]);
  b.face([[0, y0, z0], [0, y0, 0], [x1, y0, 0], [x1, y0, z0]]);
  b.face([[0, y1, 0], [0, y1, z0], [x1, y1, z0], [x1, y1, 0]]);
  b.face([[x1, y0, z0], [x1, y0, 0], [x1, y1, 0], [x1, y1, z0]]);
  // the merged face: the board's edge at x = 0 (y 0..10) and the slot's front
  b.face([[0, 0, 0], [0, 0, 1.5], [0, 10, 1.5], [0, 10, 0], [0, y1, 0], [0, y1, z0], [0, y0, z0], [0, y0, 0]]);
  const model = { units: 'millimeter', meshes: [{ name: 'fused', color: null, positions: Float32Array.from(b.pos), normals: null, colors: null,
    indices: Uint32Array.from(b.idx), faces: Uint32Array.from(b.faces) }] };
  const s = splitBoard(decodeCadmesh(encodeCadmesh(model, { edges: false })));
  assert.equal(s.parts, 1);
  const p = s.meshes[1].positions;
  let ylo = Infinity, yhi = -Infinity;
  for (let i = 1; i < p.length; i += 3) { ylo = Math.min(ylo, p[i]); yhi = Math.max(yhi, p[i]); }
  assert.deepEqual([ylo, yhi], [y0, y1], 'the part is the slot alone, not the edge');
  assert.equal(s.meshes[0].faces.length / 2, 6, 'the board keeps its six faces');
  assert.equal(s.meshes.at(-1).name, 'board edge');
  assert.equal(s.meshes.at(-1).faces.length / 2, 1, 'the merged edge face: a body of its own, outside the board\'s box');
});

test('refuses a file without b-rep faces', () => {
  const { d } = fusedBoard();
  assert.throws(() => splitBoard({ ...d, faces: null }), /no faces section/);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
