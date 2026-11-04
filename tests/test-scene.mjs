#!/usr/bin/env node
// Two models in one view (js/scene.js mergeModels) and the clearance between
// them (js/clearance.js).
//   node tests/test-scene.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { encodeCadmesh, decodeCadmesh, bytesToId } from '../js/cadmesh.js';
import { mergeModels, modelRanges } from '../js/scene.js';
import { clearance, triangleDistance } from '../js/clearance.js';
import { bodyGeometry } from '../js/measure-geom.js';
import { washer } from './brep-model.mjs';

import { test, done } from './harness.mjs';

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
// (a box given 'in' fourth is wound inward: a cavity, as OpenCascade writes one; 'crack' fifth
// leaves its last triangle out: a tessellation with a gap; [[n, lo, hi, in], ...] as a box: one
// body of those boxes)
function oneBox([n, lo, hi, inward, crack]) {
  const m = boxMesh(n, lo, hi);
  if (inward === 'in') for (let t = 0; t < m.indices.length; t += 3) { const x = m.indices[t + 1]; m.indices[t + 1] = m.indices[t + 2]; m.indices[t + 2] = x; }
  if (crack === 'crack') { m.indices = m.indices.slice(0, -3); m.faces = Uint32Array.of(0, 2, 2, 2, 4, 2, 6, 2, 8, 2, 10, 1); }
  return m;
}
function file(name, boxes) {
  const meshes = boxes.map((b) => {
    if (!Array.isArray(b[0])) return oneBox(b);
    const parts = b.map(oneBox), positions = [], indices = [];
    for (const p of parts) { const o = positions.length / 3; positions.push(...p.positions); indices.push(...Array.from(p.indices, (v) => v + o)); }
    return { name: parts[0].name, color: [0.5, 0.5, 0.5], positions: Float32Array.from(positions), normals: null, colors: null, indices: Uint32Array.from(indices) };
  });
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

test('a model with faces and one without (an STL): the faces kept, the other\'s bodies one face each', () => {
  const stl = { ...lid, faces: null, header: { ...lid.header, meshes: lid.header.meshes.map(({ faceStart, faceCount, ...m }) => m) } };
  for (const order of [[board, stl], [stl, board]]) {
    const s = mergeModels(order.map((base, i) => ({ base, name: `m${i}` })));
    assert.ok(s.faces, 'faces kept');
    const ms = s.header.meshes;
    const boardMeshes = order[0] === board ? ms.slice(0, 2) : ms.slice(1);
    const stlMesh = order[0] === board ? ms[2] : ms[0];
    assert.equal(stlMesh.faceCount, 0);
    assert.equal(s.faces.length, board.faces.length);
    for (const m of boardMeshes) {
      assert.equal(m.faceCount, 6);
      assert.equal(s.faces[m.faceStart * 2], m.idxStart / 3, 'a board face names its own first triangle');
    }
  }
});
test('a model that records no angle keeps its circles beside a model meshed at 0.1, and each body\'s circle test is its own model\'s (r25 A2, Q1, Q3)', () => {
  // a washer of 16 segments a rim: circles at 0.5 (12 points needed), not at 0.1 (62)
  const washerFile = (angularDeflection) => {
    const positions = [], indices = [], faces = [];
    for (const f of washer(1.6, 4, 2, 16)) {
      const map = new Map();
      faces.push(indices.length / 3, f.length);
      for (const tri of f) for (const p of tri) {
        const k = p.join(',');
        if (!map.has(k)) { map.set(k, positions.length / 3); positions.push(...p); }
        indices.push(map.get(k));
      }
    }
    const mesh = { name: 'washer', color: [0.5, 0.5, 0.5], positions: new Float32Array(positions), normals: null, colors: null, indices: new Uint32Array(indices), faces: new Uint32Array(faces) };
    const raw = encodeCadmesh({ units: 'mm', meshes: [mesh], root: { name: 'w', meshes: [0], children: [] }, sourceUnits: 'mm', angularDeflection });
    return decodeCadmesh(raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  };
  const old = washerFile(undefined); // a .cadmesh older than the field
  assert.equal(old.header.angularDeflection, undefined);
  const circles = (m, i) => bodyGeometry(m, i).circles.length;
  assert.equal(circles(old, 0), 8, 'alone: the default angle, its rims (two on each of its four faces)');
  const fine = { ...lid, header: { ...lid.header, angularDeflection: 0.1 } };
  for (const order of [[old, fine], [fine, old]]) {
    const s = mergeModels(order.map((base, i) => ({ base, name: `m${i}`, offset: [i * 100, 0, 0] })));
    assert.equal(s.header.angularDeflection, undefined, 'the scene has no angle of its own');
    assert.ok(s.header.meshes.every((m) => m.angularDeflection > 0), 'every body carries its own');
    const w = order[0] === old ? 0 : 1, l = 1 - w;
    assert.equal(bodyGeometry(s, w).a, 0.5, 'the angle-less model\'s body: the default');
    assert.equal(bodyGeometry(s, l).a, 0.1, 'the fine model\'s body: its own');
    assert.equal(circles(s, w), 8, 'its circles kept beside the 0.1 model');
  }
  // a model meshed at 0.1 alone: its own (none of the washer's 16-point rims a circle at 0.1)
  assert.equal(circles(washerFile(0.1), 0), 0);
});
test('each body keeps its model\'s angular deflection, and one model\'s silhouettes are kept beside a model without', () => {
  const coarse = { ...board, header: { ...board.header, angularDeflection: 0.5 } };
  const fine = { ...lid, header: { ...lid.header, angularDeflection: 0.1 } };
  const s = mergeModels([{ base: coarse, name: 'a' }, { base: fine, name: 'b' }]);
  assert.deepEqual(s.header.meshes.map((m) => m.angularDeflection), [0.5, 0.5, 0.1]);
  // silhouettes: the board with its own, the lid's left out over the cap (its count omitted)
  const sil = { ...board, silhouettes: Uint32Array.of(0, 1, 1, 2), silhouetteNormals: new Int16Array(16) };
  const none = { ...lid, silhouettes: null, silhouetteNormals: null, header: { ...lid.header, silhouettesOmitted: 7 } };
  const t = mergeModels([{ base: sil, name: 'a' }, { base: none, name: 'b' }]);
  assert.deepEqual([...t.silhouettes], [0, 1, 1, 2]);
  assert.equal(t.silhouetteNormals.length, 16);
  assert.equal(t.header.silhouettesOmitted, 7);
  const t2 = mergeModels([{ base: none, name: 'b' }, { base: sil, name: 'a' }]);
  const v0 = lid.header.vertexCount;
  assert.deepEqual([...t2.silhouettes], [v0, v0 + 1, v0 + 1, v0 + 2], 'renumbered after the model before');
});
test('a pin wholly inside a solid block overlaps it: 0, not the gap between their surfaces', () => {
  const block = file('block', [['block', [0, 0, 0], [10, 10, 10]]]);
  const pin = file('pin', [['pin', [4, 4, 4], [6, 6, 6]]]);
  const s = mergeModels([{ base: block, name: 'block.stp' }, { base: pin, name: 'pin.stp' }]);
  const plain = clearance(s.position, s.index, trisOf(s, [2]), trisOf(s, [1]));
  assert.ok(Math.abs(plain.distance - 4) < 1e-9, 'the surfaces are 4 apart');
  const r = clearance(s.position, s.index, trisOf(s, [2]), trisOf(s, [1]), { solidA: trisOf(s, [2]), solidB: trisOf(s, [1]) });
  assert.deepEqual([r.distance, r.inside], [0, true]);
  // a pin beside the block, not in it: its gap
  const beside = file('pin', [['pin', [12, 4, 4], [14, 6, 6]]]);
  const s2 = mergeModels([{ base: block, name: 'block.stp' }, { base: beside, name: 'pin.stp' }]);
  const r2 = clearance(s2.position, s2.index, trisOf(s2, [2]), trisOf(s2, [1]), { solidA: trisOf(s2, [2]), solidB: trisOf(s2, [1]) });
  assert.ok(Math.abs(r2.distance - 2) < 1e-9 && !r2.inside, JSON.stringify(r2));
});
test('containment names the part and the solid that holds it; a part in two overlapping solids is inside', () => {
  // the pin in block 1; part 2 half a mm from block 2 (the nearest surfaces' pair, which was named)
  const blocks = file('blocks', [['block1', [0, 0, 0], [10, 10, 10]], ['block2', [20, 0, 0], [30, 10, 10]]]);
  const parts = file('parts', [['pin', [4, 4, 4], [6, 6, 6]], ['part2', [30.5, 4, 4], [32, 6, 6]]]);
  const s = mergeModels([{ base: parts, name: 'parts.stp' }, { base: blocks, name: 'blocks.stp' }]);
  const triOf = (id) => s.header.meshes[id - 1].idxStart / 3;
  const r = clearance(s.position, s.index, trisOf(s, [1, 2]), trisOf(s, [3, 4]), { solidA: trisOf(s, [1, 2]), solidB: trisOf(s, [3, 4]) });
  assert.equal(r.distance, 0);
  assert.equal(r.triA, triOf(1), 'the pin');
  const inBlock1 = r.triB >= triOf(3) && r.triB < triOf(4);
  assert.ok(inBlock1, `named in block1 (tri ${r.triB})`);
  // two overlapping solids, the pin in their overlap
  const two = file('two', [['a', [0, 0, 0], [10, 10, 10]], ['b', [3, 0, 0], [13, 10, 10]]]);
  const s2 = mergeModels([{ base: file('pin', [['pin', [4, 4, 4], [6, 6, 6]]]), name: 'pin.stp' }, { base: two, name: 'two.stp' }]);
  const r2 = clearance(s2.position, s2.index, trisOf(s2, [1]), trisOf(s2, [2, 3]), { solidA: trisOf(s2, [1]), solidB: trisOf(s2, [2, 3]) });
  assert.deepEqual([r2.distance, r2.inside], [0, true]);
});
test('a pin in a hollow block\'s cavity is not inside it: its gap to the cavity wall (the crossings counted, not just met)', () => {
  // one solid: a block 0..10 with a cavity 2..8 wound inward (its outer and inner walls one triangle range)
  const hollow = file('hollow', [['outer', [0, 0, 0], [10, 10, 10]], ['cavity', [2, 2, 2], [8, 8, 8], 'in']]);
  const pin = file('pin', [['pin', [4, 4, 4], [6, 6, 6]]]);
  const s = mergeModels([{ base: hollow, name: 'hollow.stp' }, { base: pin, name: 'pin.stp' }]);
  const [[t0, c1], [, c2]] = trisOf(s, [1, 2]);
  const r = clearance(s.position, s.index, trisOf(s, [3]), trisOf(s, [1, 2]), { solidA: trisOf(s, [3]), solidB: [[t0, c1 + c2]] });
  assert.deepEqual([Math.round(r.distance * 1e6) / 1e6, !!r.inside], [2, false], JSON.stringify(r));
  // the inner box wound OUT is a part embedded in the block, material as the facts' volume and the
  // view's cut fill take it: the pin in it is inside (r28 A1: Clearance read it 0.9 mm away)
  const solid = file('solid', [['outer', [0, 0, 0], [10, 10, 10]], ['embedded', [2, 2, 2], [8, 8, 8]]]);
  const s2 = mergeModels([{ base: solid, name: 'solid.stp' }, { base: pin, name: 'pin.stp' }]);
  const [[u0, d1], [, d2]] = trisOf(s2, [1, 2]);
  const r2 = clearance(s2.position, s2.index, trisOf(s2, [3]), trisOf(s2, [1, 2]), { solidA: trisOf(s2, [3]), solidB: [[u0, d1 + d2]] });
  assert.deepEqual([r2.distance, !!r2.inside], [0, true], JSON.stringify(r2));
});
test('one solid of two overlapping shells (an STL never booleaned) holds a pin in their overlap, and in either alone (r27 A2)', () => {
  const two = file('two', [['a', [0, 0, 0], [10, 10, 10]], ['b', [5, 5, 5], [15, 15, 15]]]);
  for (const [lo, hi] of [[[6, 6, 6], [7, 7, 7]], [[2, 2, 2], [3, 3, 3]], [[12, 12, 12], [13, 13, 13]]]) {
    const pin = file('pin', [['pin', lo, hi]]);
    const s = mergeModels([{ base: two, name: 'two.stp' }, { base: pin, name: 'pin.stp' }]);
    const [[t0, c1], [, c2]] = trisOf(s, [1, 2]);
    const r = clearance(s.position, s.index, trisOf(s, [3]), trisOf(s, [1, 2]), { solidA: trisOf(s, [3]), solidB: [[t0, c1 + c2]] });
    assert.deepEqual([r.distance, !!r.inside], [0, true], `pin at ${lo}: ${JSON.stringify(r)}`);
  }
});
test('Clearance\'s solid as the view shows it: a crack in a cavity or the outer wall is no material, parts wound inward are none, a part of many shells is asked at each (r29 A1, A2, A3, Q3)', () => {
  const pin = file('pin', [['pin', [4, 4, 4], [6, 6, 6]]]);
  const ask = (solid, part = pin) => {
    const s = mergeModels([{ base: solid, name: 's.stp' }, { base: part, name: 'p.stp' }]);
    const n = solid.header.meshes.length, own = Array.from({ length: n }, (_, i) => i + 1), its = Array.from({ length: part.header.meshes.length }, (_, i) => n + i + 1);
    const r = clearance(s.position, s.index, trisOf(s, its), trisOf(s, own), { solidA: trisOf(s, its), solidB: trisOf(s, own), normal: s.normal });
    return [Math.round(r.distance * 1e3) / 1e3, !!r.inside];
  };
  // a block with a cavity (one body), the pin in the cavity: 1.5 mm from its wall whether a wall has a gap or not
  for (const [what, outerCrack, cavityCrack] of [['closed', '', ''], ['a cracked cavity', '', 'crack'], ['a cracked outer wall', 'crack', '']]) {
    const hollow = file('hollow', [[['outer', [0, 0, 0], [10, 10, 10], '', outerCrack], ['cavity', [2.5, 2.5, 2.5], [7.5, 7.5, 7.5], 'in', cavityCrack]]]);
    const got = ask(hollow);
    assert.deepEqual(got, [1.5, false], `${what}: ${got}`);
  }
  // two cubes face to face, both wound inward (normals inward too): the view leaves them unfilled,
  // and the pin in one is no part of their material; wound out, it is
  let got = ask(file('voxels', [[['a', [0, 0, 0], [10, 10, 10], 'in'], ['b', [10, 0, 0], [20, 10, 10], 'in']]]));
  assert.deepEqual(got, [4, false], `inward: ${got}`);
  got = ask(file('voxels', [[['a', [0, 0, 0], [10, 10, 10]], ['b', [10, 0, 0], [20, 10, 10]]]]));
  assert.deepEqual(got, [0, true], `outward: ${got}`);
  // the pin as the second shell of a part whose first is a cube outside the block: still inside
  const block = file('block', [['block', [0, 0, 0], [10, 10, 10]]]);
  const two = file('two', [[['far', [30, 0, 0], [31, 1, 1]], ['pin', [4, 4, 4], [6, 6, 6]]]]);
  assert.deepEqual(ask(block, two), [0, true], 'the pin asked as its own shell (one corner of the part read 4 mm)');
});
test('containment does not trust the winding: a block wound inside out, or with one side reversed, still holds the pin (its normals out, as the view shows it; and with no normals given)', () => {
  const block = file('block', [['block', [0, 0, 0], [10, 10, 10]]]);
  const pin = file('pin', [['pin', [4, 4, 4], [6, 6, 6]]]);
  for (const flip of ['all', 'one side']) for (const withNormals of [true, false]) {
    const s = mergeModels([{ base: block, name: 'block.stp' }, { base: pin, name: 'pin.stp' }]);
    const [[t0, c]] = trisOf(s, [1]);
    for (let t = t0; t < t0 + (flip === 'all' ? c : 2); t++) { const x = s.index[3 * t + 1]; s.index[3 * t + 1] = s.index[3 * t + 2]; s.index[3 * t + 2] = x; }
    const r = clearance(s.position, s.index, trisOf(s, [2]), trisOf(s, [1]), { solidA: trisOf(s, [2]), solidB: trisOf(s, [1]), ...(withNormals ? { normal: s.normal } : {}) });
    assert.deepEqual([r.distance, r.inside], [0, true], `${flip}${withNormals ? ', normals given' : ''}`);
  }
});

done();
