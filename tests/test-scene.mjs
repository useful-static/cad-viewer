#!/usr/bin/env node
// Two models in one view (js/scene.js mergeModels) and the clearance between
// them (js/clearance.js).
//   node tests/test-scene.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeCadmesh, decodeCadmesh, bytesToId, writtenSizeLimit } from '../js/cadmesh.js';
import { mergeModels, modelRanges, staleModels, sceneEdgesFacts } from '../js/scene.js';
import { buildEdges, FACTS_RULE, factsCurrent, momentaryFailure, overSilhouetteCap } from '../js/edges.js';
import { clearance } from '../js/clearance.js';
import { triangleDistance } from '../js/tri-distance.js';
import { bodyGeometry } from '../js/measure-geom.js';
import { box, washer } from './brep-model.mjs';

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

test('the edges and facts\' merge that fails part way leaves the scene as it was, not zero-filled; mergeModels keeps its error and the scene (r42 A2, A3, Q1)', () => {
  const s = mergeModels([{ base: board, name: 'board' }, { base: lid, name: 'case' }]);
  const edges = s.edges, sil = s.silhouettes, before = [...s.edges];
  // (the second model's first fact throws when read inside the fill: after both models' edges are
  // written -- a throw at the facts' test came before the fill and could not see it: r43 Q7)
  const closed = new Proxy([...lid.header.facts.closed], { get(t, k) { if (k === '0') throw new RangeError('Array buffer allocation failed'); return Reflect.get(t, k); } });
  const bad = { ...lid, header: { ...lid.header, facts: { ...lid.header.facts, closed } } };
  const facts = s.header.facts;
  assert.throws(() => sceneEdgesFacts(s, [{ base: board, name: 'board' }, { base: bad, name: 'case' }]), /allocation failed/);
  assert.deepEqual([s.edges === edges, s.silhouettes === sil, [...s.edges], s.header.facts === facts], [true, true, before, true], 'the scene\'s own, untouched');
  const t = mergeModels([{ base: board, name: 'board' }, { base: bad, name: 'case' }]);
  assert.deepEqual([t.header.meshes.length, t.edges, /allocation failed/.test(t.mergeError?.message)], [3, null, true], 'shown without them, the error kept');
  // (silhouettes past the cap left out by their count, never allocated: 3e9 entries merge -- r42 A4, r43 Q6)
  // (a length past any typed array's: allocated first, it throws -- 3e9 was allocated lazily, unseen)
  const huge = { ...lid, silhouettes: { length: 9e15 }, silhouetteNormals: { length: 3.6e16 } };
  const u = mergeModels([{ base: board, name: 'board' }, { base: huge, name: 'case' }]);
  assert.deepEqual([u.mergeError?.message ?? null, u.silhouettes, u.header.silhouettesOmitted >= 4.5e15], [null, null, true]);
});
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
  // a cube wound out face to face with a box wound in (one shell by their shared face): a pin in the
  // inward box is no material, as the view leaves it unfilled (r30 A1: one sign for the merged shell)
  got = ask(file('pair', [[['a', [-10, 0, 0], [0, 10, 10]], ['b', [0, 0, 0], [10, 10, 10], 'in']]]));
  assert.deepEqual(got, [4, false], `face to face, the pin's box wound in: ${got}`);
  // a pin in a cavity far from the origin (100,000 mm), 0.05 mm from its walls: its gap, not 0 by a
  // touch on the cavity's wall (r30 Q3)
  const D = 1e5, far = file('far', [[['outer', [D, D, D], [D + 10, D + 10, D + 10]], ['cavity', [D + 3.95, D + 3.95, D + 3.95], [D + 6.05, D + 6.05, D + 6.05], 'in']]]);
  got = ask(far, file('pin', [['pin', [D + 4, D + 4, D + 4], [D + 6, D + 6, D + 6]]]));
  assert.ok(got[0] > 0.04 && got[0] < 0.06 && !got[1], `far from the origin: ${got}`);
  // the pin as the second shell of a part whose first is a cube outside the block: still inside
  const block = file('block', [['block', [0, 0, 0], [10, 10, 10]]]);
  const two = file('two', [[['far', [30, 0, 0], [31, 1, 1]], ['pin', [4, 4, 4], [6, 6, 6]]]]);
  assert.deepEqual(ask(block, two), [0, true], 'the pin asked as its own shell (one corner of the part read 4 mm)');
  // a pin 0.000005 mm in from the block's face (under the touch tolerance, yet a gap above 0, so
  // asked), its other end deep inside: a corner on the face is no answer, the next corner asked
  // (a touch read as outside left it outside the block)
  const e = 5e-6;
  for (const [lo, hi] of [[[e, 4, 4], [2, 6, 6]], [[8, 4, 4], [10 - e, 6, 6]], [[4, 4, e], [6, 6, 2]], [[4, 4, 8], [6, 6, 10 - e]]]) {
    const g = ask(block, file('flush', [['pin', lo, hi]]));
    assert.deepEqual(g, [0, true], `flush at ${lo}: ${g}`);
  }
});
test('a board inside a plain hollow case: the nearest pairs only, not every board triangle against the case\'s loose leaves (r30 Q1: 7.1 M pairs, 9.4 s)', () => {
  // a case of 24 triangles (a box with a cavity) around a grid of 2,500 small boxes 3 mm off its floor
  const kase = file('case', [[['outer', [-10, -10, -10], [110, 110, 40]], ['cavity', [-5, -5, -5], [105, 105, 35], 'in']]]);
  const parts = [];
  for (let i = 0; i < 50; i++) for (let j = 0; j < 50; j++) parts.push([`p${i}-${j}`, [i * 2, j * 2, -2], [i * 2 + 1, j * 2 + 1, 0]]);
  const board = file('board', [parts]);
  const s = mergeModels([{ base: kase, name: 'case.stp' }, { base: board, name: 'board.stp' }]);
  const t0 = performance.now();
  const r = clearance(s.position, s.index, trisOf(s, [2]), trisOf(s, [1]), { solidA: trisOf(s, [2]), solidB: trisOf(s, [1]), normal: s.normal });
  const ms = performance.now() - t0;
  assert.equal(Math.round(r.distance * 1e3) / 1e3, 3);
  assert.ok(r.pairs < 2000, `${r.pairs} triangle pairs`);
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});
// a pin (r 5) in a bore (a tube, inner r 5.1), both 100 long and tessellated as CAD does (side
// slivers, fan caps), their end faces coplanar; turned: the axis along (1,1,1)
function pinInBore(n, turned) {
  const L = 100, P = [], I = [];
  const b0 = P.length / 3;
  for (let k = 0; k < n; k++) { const a = 2 * Math.PI * k / n; P.push(5 * Math.cos(a), 5 * Math.sin(a), 0, 5 * Math.cos(a), 5 * Math.sin(a), L); }
  const c0 = P.length / 3; P.push(0, 0, 0, 0, 0, L);
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n, a0 = b0 + 2 * k, a1 = a0 + 1, q0 = b0 + 2 * k2, q1 = q0 + 1;
    I.push(a0, q0, q1, a0, q1, a1, c0, q0, a0, c0 + 1, a1, q1);
  }
  const nA = I.length / 3, b = P.length / 3;
  for (let k = 0; k < n; k++) { const a = 2 * Math.PI * k / n, c = Math.cos(a), s = Math.sin(a); P.push(10 * c, 10 * s, 0, 10 * c, 10 * s, L, 5.1 * c, 5.1 * s, 0, 5.1 * c, 5.1 * s, L); }
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n, o0 = b + 4 * k, o1 = o0 + 1, i0 = o0 + 2, i1 = o0 + 3, p0 = b + 4 * k2, p1 = p0 + 1, j0 = p0 + 2, j1 = p0 + 3;
    I.push(o0, p0, p1, o0, p1, o1, i0, j1, j0, i0, i1, j1, o0, j0, p0, o0, i0, j0, o1, p1, j1, o1, j1, i1);
  }
  let pos = Float32Array.from(P);
  if (turned) {
    const z = [1, 1, 1].map((x) => x / Math.sqrt(3)), x = [1, -1, 0].map((v) => v / Math.SQRT2), y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const Q = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) Q[i + k] = P[i] * x[k] + P[i + 1] * y[k] + P[i + 2] * z[k];
    pos = Q;
  }
  return { pos, idx: Uint32Array.from(I), nA, nB: I.length / 3 - nA };
}
test('a pin in its bore, the two turned off the axes: 0.1 mm, not 0 by float noise in the parallel test, and the slivers pruned by their planes (r31 Q1: 0.0000 after 1 pair; Q2: 904,553 pairs)', () => {
  for (const [n, cap] of [[64, 4000], [256, 20000]]) {
    for (const turned of [false, true]) {
      const { pos, idx, nA, nB } = pinInBore(n, turned);
      const r = clearance(pos, idx, [[0, nA]], [[nA, nB]], { solidA: [[0, nA]], solidB: [[nA, nB]] });
      const d = Math.round(r.distance * 1000) / 1000;
      assert.ok(Math.abs(d - 0.1) <= 0.001 && !r.inside, `${n} segments, ${turned ? 'turned' : 'along z'}: ${r.distance}`);
      assert.ok(r.pairs < cap, `${n} segments, ${turned ? 'turned' : 'along z'}: ${r.pairs} pairs`);
    }
  }
});
test('a board inside its case, the two turned 30 degrees about z and 20 about x: the nearest pairs still, by the triangles\' planes (r31 Q2: 3.7 M pairs, 6.6 s on a real board)', () => {
  const kase = file('case', [[['outer', [-10, -10, -10], [110, 110, 40]], ['cavity', [-5, -5, -5], [105, 105, 35], 'in']]]);
  const parts = [];
  for (let i = 0; i < 50; i++) for (let j = 0; j < 50; j++) parts.push([`p${i}-${j}`, [i * 2, j * 2, -2], [i * 2 + 1, j * 2 + 1, 0]]);
  const s = mergeModels([{ base: kase, name: 'case.stp' }, { base: file('board', [parts]), name: 'board.stp' }]);
  const cz = Math.cos(Math.PI / 6), sz = Math.sin(Math.PI / 6), cx = Math.cos(Math.PI / 9), sx = Math.sin(Math.PI / 9);
  const pos = new Float32Array(s.position.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = s.position[i], y = s.position[i + 1], z = s.position[i + 2];
    const x1 = x * cz - y * sz, y1 = x * sz + y * cz;
    pos[i] = x1; pos[i + 1] = y1 * cx - z * sx; pos[i + 2] = y1 * sx + z * cx;
  }
  const t0 = performance.now();
  const r = clearance(pos, s.index, trisOf(s, [2]), trisOf(s, [1]), { solidA: trisOf(s, [2]), solidB: trisOf(s, [1]) });
  const ms = performance.now() - t0;
  assert.equal(Math.round(r.distance * 1e3) / 1e3, 3);
  assert.ok(r.pairs < 5000, `${r.pairs} triangle pairs`);
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});
await test('Clearance off the page (main.js clearanceOffPage, with a stand-in worker): a failed run says its error and is not run again on the page; only a worker that cannot start hands it over; the promise always settles (r32 Q1, A6)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('const STOPPED = Symbol'), src.indexOf('async function runClearance')).replaceAll('import.meta.url', "'file:///x/js/main.js'");
  const run = async (script, pageThrows) => {
    let pageRuns = 0;
    const app = {};
    const page = () => { pageRuns++; if (pageThrows) throw new RangeError('Map maximum size exceeded'); return { distance: 1 }; };
    class Worker {
      constructor() { setTimeout(() => script(this), 1); }
      postMessage() {}
      terminate() {}
    }
    const off = new Function('app', 'clearance', 'Worker', 'momentaryFailure', `${body}; return clearanceOffPage;`)(app, page, Worker, momentaryFailure);
    const r = await Promise.race([off({ position: new Float32Array(9), index: new Uint32Array(3), normal: null }, [[0, 1]], [[0, 1]], [], []), new Promise((res) => setTimeout(() => res('pending'), 1000))]);
    return [r, pageRuns, app.lastClearanceVia];
  };
  const failed = await run((w) => { w.onmessage({ data: { started: true } }); w.onmessage({ data: { ok: false, error: 'Map maximum size exceeded' } }); }, true);
  assert.deepEqual(failed, [{ error: 'Map maximum size exceeded' }, 0, 'worker'], 'a run that failed in the worker');
  const crashed = await run((w) => { w.onmessage({ data: { started: true } }); w.onerror({ message: 'out of memory' }); }, true);
  assert.deepEqual([crashed[1], typeof crashed[0].error], [0, 'string'], 'a worker that died mid-run');
  const noStart = await run((w) => { w.onerror({ message: 'module not found' }); }, true);
  assert.deepEqual(noStart, [{ error: 'Map maximum size exceeded' }, 1, 'page'], 'a worker that cannot start: the page, its throw said');
  const ok = await run((w) => { w.onmessage({ data: { started: true } }); w.onmessage({ data: { ok: true, result: { distance: 2 } } }); }, false);
  assert.deepEqual(ok, [{ distance: 2 }, 0, 'worker']);
  // a second run stops the first: the first settles STOPPED and its worker is ended (r33 Q5)
  {
    const app = {}, ended = [];
    class Worker {
      constructor() { this.n = ended.length; ended.push(false); }
      postMessage() {}
      terminate() { ended[this.n] = true; }
    }
    const off = new Function('app', 'clearance', 'Worker', 'momentaryFailure', `${body}; return [clearanceOffPage, STOPPED];`)(app, () => ({}), Worker, momentaryFailure);
    const base = { position: new Float32Array(9), index: new Uint32Array(3), normal: null };
    const first = off[0](base, [[0, 1]], [[0, 1]], [], []);
    off[0](base, [[0, 1]], [[0, 1]], [], []);
    const r = await Promise.race([first, new Promise((res) => setTimeout(() => res('pending'), 1000))]);
    assert.deepEqual([r === off[1], ended[0], ended[1]], [true, true, false], 'the first stopped, its worker ended, the second running');
  }
  // the model's copies that do not fit: said, not a rejected promise (r33 Q2)
  {
    const app = {}, made = [];
    class Worker { constructor() { made.push(this); } postMessage() {} terminate() { this.ended = true; } }
    const off = new Function('app', 'clearance', 'Worker', 'momentaryFailure', `${body}; return clearanceOffPage;`)(app, () => ({}), Worker, momentaryFailure);
    const big = { slice() { throw new RangeError('Array buffer allocation failed'); } };
    const r = await Promise.race([off({ position: big, index: new Uint32Array(3), normal: null }, [[0, 1]], [[0, 1]], [], []).catch((e) => `rejected ${e.message}`), new Promise((res) => setTimeout(() => res('pending'), 1000))]);
    assert.match(String(r?.error), /no room/, JSON.stringify(r));
    assert.deepEqual([app.clearanceRun, made.length, made[0]?.ended], [null, 1, true], 'the run cleared, its worker ended');
  }
});
test('a scene\'s silhouettes past the cap are left out and counted, as one model\'s are; under it, each model\'s silhouettes and their normals carried at their stride (r34 Q1, r35 A6)', () => {
  const a = file('a', [['a', [0, 0, 0], [1, 1, 1]]]), b = file('b', [['b', [5, 0, 0], [6, 1, 1]]]);
  for (const m of [a, b]) { m.silhouettes = Uint32Array.from([0, 1, 1, 2, 2, 3]); m.silhouetteNormals = new Int16Array(3 * 8); }
  const under = mergeModels([{ base: a, name: 'a' }, { base: b, name: 'b' }], { silhouetteCap: 6 });
  assert.equal(under.silhouettes.length / 2, 6, 'under the cap: kept');
  const over = mergeModels([{ base: a, name: 'a' }, { base: b, name: 'b' }], { silhouetteCap: 4 });
  assert.deepEqual([over.silhouettes, over.header.silhouettesOmitted], [null, 6], 'past it: left out, counted');
  // the silhouettes' normals carried at their stride: 8 a candidate, each model's after the one before
  for (const [k, m] of [a, b].entries()) m.silhouetteNormals = Int16Array.from({ length: 24 }, (_, i) => 100 * (k + 1) + i);
  const kept = mergeModels([{ base: a, name: 'a' }, { base: b, name: 'b' }], { silhouetteCap: 6 });
  assert.deepEqual([Array.from(kept.silhouettes), Array.from(kept.silhouetteNormals)],
    [[0, 1, 1, 2, 2, 3, 8, 9, 9, 10, 10, 11], [...a.silhouetteNormals, ...b.silhouetteNormals]], 'silhouettes and their normals');
});
test('a scene\'s edges and facts are its models\' own, each built unmoved: a model far out keeps its exact volume; only the models without today\'s are built (r35 A2, Q5, Q6)', () => {
  // boxes of their own corners (the shared-corner boxes above carry no edges)
  const own3 = (lo, hi) => {
    const T = box(lo, hi).flat(), P = [], I = [];
    for (const t of T) for (const p of t) { I.push(P.length / 3); P.push(...p); }
    const raw = encodeCadmesh({ units: 'mm', meshes: [{ name: 'b', color: [0.5, 0.5, 0.5], positions: Float32Array.from(P), normals: null, colors: null, indices: Uint32Array.from(I) }], root: { name: 'm', meshes: [0], children: [] } });
    return decodeCadmesh(raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  };
  const c = own3([0, 0, 0], [1, 1, 1]), d = own3([0, 0, 0], [0.3, 0.3, 0.3]);
  const be = (m) => buildEdges({ position: m.position, index: m.index, meshes: m.header.meshes });
  // (kept as the viewer keeps a model's built ones: js/main.js's own keepEdges, cut out)
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const kat = src.indexOf('function keepEdges(base, v) {');
  const keepEdges = new Function('FACTS_RULE', `${src.slice(kat, src.indexOf('\n}\n', kat) + 2)}; return keepEdges;`)(FACTS_RULE);
  const keep = (m) => { const v = be(m); keepEdges(m, v); return v; };
  const models = [{ base: c, name: 'c' }, { base: d, name: 'd', offset: [1e5, 1e5, 1e5] }];
  // a file's facts current, then one of an older rule: only that one is stale
  assert.deepEqual(staleModels(models).length, 0, 'both carry today\'s facts from their files');
  d.header = { ...d.header, factsRule: FACTS_RULE - 1 };
  assert.deepEqual(staleModels(models).map((m) => m.name), ['d']);
  const ownD = keep(d);
  assert.deepEqual(staleModels(models).length, 0);
  const s = mergeModels(models);
  assert.equal(factsCurrent(s.header), true, 'the merge carries today\'s');
  // the scene's edges are each model's, its vertex numbers moved after the ones before
  assert.deepEqual(Array.from(s.edges), [...Array.from(c.edges), ...Array.from(d.edges, (v) => v + c.header.vertexCount)]);
  // and d's volume is the one built where it lies in its own file, not on the copy 100,000 mm out
  // (that copy's float32 gave 1 % low, kept after a move back)
  assert.equal(s.header.facts.volume[1], ownD.facts.volume[0]);
  const far = be(s);
  assert.notEqual(far.facts.volume[1], ownD.facts.volume[0], 'the far copy\'s own build differs (what the merge avoids)');
});
await test('the edges worker\'s copies that do not fit: said, the worker ended, the facts not left "computing…" (r34 A2)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const cut = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n}\n', at) + 2).replaceAll('import.meta.url', "'file:///x/js/main.js'"); };
  const line = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n', at) + 1); };
  const body = cut('function workerJob(file, make) {') + cut('function edgesOf(base) {') + cut('function stopEdgeJobs(keep, why) {')
    + line('const GONE = Symbol(') + cut('function showBase(next, keep, why) {') + cut('function fileEdgesValue(base, cap) {')
    + cut('function sayNoFacts(text) {') + line('const MOMENT_TRIES = ') + cut('function readyText() {');
  const make = (usable = false, cap = 2e6, current = false, noWorker = false) => {
    const app = { status: 'ready', statusMsg: 'ready', edgeJobs: new Map() }, made = [], said = [], kept = [], drawn = [], told = [];
    class Worker { constructor() { if (noWorker) throw new Error('module workers are not supported'); made.push(this); } postMessage() {} terminate() { this.ended = true; } }
    const setStatus = (s, t) => { said.push(t); app.status = s; app.statusMsg = t; };
    const [edgesOf, stopEdgeJobs, showBase] = new Function('app', 'silhouetteCapHere', 'edgesUsable', 'overSilhouetteCap', 'factsCurrent', 'keepEdges', 'Worker', 'setStatus', 'refreshEdges', 'fmtInt', 'momentaryFailure', 'writtenSizeLimit', 'tell', `${body}; return [edgesOf, stopEdgeJobs, showBase];`)(
      app, () => cap, () => usable, overSilhouetteCap, () => current, (b, v) => kept.push([b, v]), Worker, setStatus, () => drawn.push(true), (n) => String(n), momentaryFailure, writtenSizeLimit, (t) => told.push(t));
    return { app, made, said, kept, drawn, told, edgesOf, stopEdgeJobs, showBase };
  };
  const { app, made, said, edgesOf } = make();
  const base = { edgeInfo: { value: null }, position: { slice() { throw new RangeError('Array buffer allocation failed'); } }, index: new Uint32Array(3), header: { meshes: [] } };
  app.baseMesh = base;
  const r = await Promise.race([edgesOf(base).catch((e) => `rejected ${e.message}`), new Promise((res) => setTimeout(() => res('pending'), 1000))]);
  assert.deepEqual([r, made[0]?.ended, app.edgeJobs.size, /no room/.test(base.edgeInfo.error), said.length], [null, true, 0, true, 1]);
  // one build a model: asked again while it runs, the same build (one worker); a scene keeping the
  // model leaves it running; a stop takes it out at once, so the next ask starts its own and a
  // stopped one never clears it (r36 A2, Q1)
  {
    const t = make(), b = { edgeInfo: { value: null }, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [] } };
    const p1 = t.edgesOf(b), p2 = t.edgesOf(b);
    assert.deepEqual([p1 === p2, t.made.length], [true, 1], 'asked twice: one build');
    t.stopEdgeJobs(new Set([b]), 'stopped: the scene changed');
    assert.deepEqual([t.made[0].ended, t.app.edgeJobs.size], [undefined, 1], 'a scene that keeps it: still running');
    t.stopEdgeJobs(new Set(), 'stopped: another model was opened');
    const p3 = t.edgesOf(b);
    assert.deepEqual([t.made[0].ended, t.made.length, p3 !== p1], [true, 2, true], 'stopped, then asked again: a build of its own');
    assert.equal(await p1, null);
    assert.deepEqual([t.app.edgeJobs.size, t.app.edgeJobs.get(b)?.promise === p3], [1, true], 'the stopped one settled and left the newer one in place');
    // (and wrote nothing over the newer one's state: not "not computed: stopped…" while it runs)
    assert.deepEqual([b.edgeInfo.error, b.edgeInfo.stopped], [null, false], 'the running build\'s state its own (r37 Q2)');
    // a stop of a model shown alone is not said on the status line (r37 Q6)
    t.app.baseMesh = b;
    t.stopEdgeJobs(new Set(), 'the scene changed');
    assert.equal(await p3, null);
    assert.deepEqual([t.said, b.edgeInfo.stopped, b.edgeInfo.failed], [[], true, undefined], 'a stop: said nowhere, no failure kept, whatever its wording');
  }
  // a build that fails for the model is remembered: not tried again, nor said again (r37 A3, Q3);
  // one that fails for the moment (a worker that died) is tried again (r38 A6)
  {
    const t = make(), b = { edgeInfo: { value: null }, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [] } };
    t.app.baseMesh = b;
    const p = t.edgesOf(b);
    t.made[0].onmessage({ data: { started: true } });
    t.made[0].onmessage({ data: { ok: false, error: 'Map maximum size exceeded' } });
    assert.equal(await p, null);
    assert.deepEqual([b.edgeInfo.failed, t.said.length, t.told], [true, 1, ['no edges for this model: Map maximum size exceeded']]);
    assert.deepEqual([await t.edgesOf(b), t.made.length], [null, 1], 'asked again: no second worker');
    const t2 = make(), b2 = { edgeInfo: { value: null }, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [] } };
    const p2 = t2.edgesOf(b2);
    t2.made[0].onmessage({ data: { started: true } });
    t2.made[0].onerror({ message: 'out of memory' });
    assert.equal(await p2, null);
    assert.equal(b2.edgeInfo.failed, undefined, 'the moment\'s failure not kept');
    t2.edgesOf(b2);
    assert.equal(t2.made.length, 2, 'asked again: tried again');
  }
  // a build keeps its own on the model (r38 Q3); a file whose edges are in hand but whose facts are
  // of an older rule shows its edges at once and keeps them when the facts' build fails (r38 A1)
  {
    const t = make(), b = { edgeInfo: { value: null }, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [] } };
    const p = t.edgesOf(b);
    t.made[0].onmessage({ data: { started: true } });
    t.made[0].onmessage({ data: { ok: true, result: { edges: new Uint32Array(0), facts: { closed: [] } }, ms: 1 } });
    const v = await p;
    assert.deepEqual([v.source, t.kept.length, t.kept[0][0] === b], ['worker', 1, true]);
    const s = make(), f = { edgeInfo: { value: null }, edges: new Uint32Array(4), silhouettes: null, silhouetteNormals: null, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [], facts: { closed: [] }, factsRule: 3 } };
    const pf = s.edgesOf(f);
    assert.deepEqual([f.edgeInfo.value?.edges?.length, f.edgeInfo.value?.facts], [4, null], 'the file\'s edges at once, its facts to come');
    s.made[0].onmessage({ data: { started: true } });
    s.made[0].onmessage({ data: { ok: false, error: 'Map maximum size exceeded' } });
    const vf = await pf;
    assert.deepEqual([vf?.edges?.length, vf?.facts], [4, null], 'the facts\' build failed: the file\'s edges kept');
  }
  // the failures of the moment, tried again (r39 Q2, Q5): no room for the page's copy, and an
  // allocation the worker could not make (it says `transient`)
  {
    const t = make(), b = { edgeInfo: { value: null }, position: { slice() { throw new RangeError('Array buffer allocation failed'); } }, index: new Uint32Array(3), header: { meshes: [] } };
    await t.edgesOf(b);
    assert.deepEqual([b.edgeInfo.failed, /no room/.test(b.edgeInfo.error)], [undefined, true], 'no room: not kept');
    b.position = new Float32Array(9);
    t.edgesOf(b);
    assert.equal(t.made.length, 2, 'asked again: a build');
    const u = make(), c = { edgeInfo: { value: null }, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [] } };
    const p = u.edgesOf(c);
    u.made[0].onmessage({ data: { started: true } });
    u.made[0].onmessage({ data: { ok: false, error: 'Array buffer allocation failed', transient: true } });
    await p;
    assert.equal(c.edgeInfo.failed, undefined, 'the worker\'s allocation: not kept');
  }
  // a try that failed for the moment, said after the ready text (r40 Q8), then one that succeeds;
  // two that fail for the moment: said, the same words not again, then remembered -- no third
  // worker (r40 A3, Q2). (No take-back here: the word is showBase's to take back, r44 A5, Q4.)
  {
    const t = make(), b = { edgeInfo: { value: null }, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [] } };
    t.app.baseMesh = b;
    const p1 = t.edgesOf(b);
    t.made[0].onmessage({ data: { started: true } }); t.made[0].onerror({ message: 'out of memory' });
    await p1;
    assert.deepEqual([b.edgeInfo.failed, t.said[t.said.length - 1]], [undefined, 'ready · no edges for this model: the worker failed: out of memory']);
    const p2 = t.edgesOf(b);
    t.made[1].onmessage({ data: { started: true } });
    t.made[1].onmessage({ data: { ok: true, result: { edges: new Uint32Array(0), facts: { closed: [] } }, ms: 1 } });
    await p2;
    assert.equal(b.edgeInfo.value?.source, 'worker', 'the build that succeeded kept');
    const u = make(), c = { edgeInfo: { value: null }, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [] } };
    u.app.baseMesh = c;
    for (let k = 0; k < 2; k++) {
      const p = u.edgesOf(c);
      u.made[k].onmessage({ data: { started: true } }); u.made[k].onerror({ message: 'out of memory' });
      await p;
    }
    assert.equal(u.said.filter((s) => /^ready · no edges for this model/.test(s)).length, 1, 'said, the same words not again');
    await u.edgesOf(c);
    assert.deepEqual([c.edgeInfo.failed, u.made.length], [true, 2], 'the moment\'s failure twice: remembered, no third worker');
  }
  // a model's build that succeeds while a scene is shown leaves the scene's line to the scene (any
  // success took back any "no edges …" line: r40 A2, Q4)
  {
    const t = make(), b = { edgeInfo: { value: null }, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [] } };
    t.app.baseMesh = { edgeInfo: {} };
    t.app.noFacts = 'no edges for this scene: a: Map maximum size exceeded';
    t.app.statusMsg = 'ready · no edges for this scene: a: Map maximum size exceeded';
    const p = t.edgesOf(b);
    t.made[0].onmessage({ data: { started: true } });
    t.made[0].onmessage({ data: { ok: true, result: { edges: new Uint32Array(0), facts: { closed: [] } }, ms: 1 } });
    await p;
    assert.deepEqual([t.said, t.app.noFacts], [[], 'no edges for this scene: a: Map maximum size exceeded'], 'the scene\'s line kept');
  }
  // a model alone whose build fails while another load is under way: not said, but the word kept, so
  // the ready line the cancelled load writes carries it (it read "ready": r42 Q3)
  {
    const t = make(), b = { edgeInfo: { value: null }, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [] } };
    t.app.baseMesh = b; t.app.status = 'loading';
    const p = t.edgesOf(b);
    t.made[0].onmessage({ data: { started: true } });
    t.made[0].onmessage({ data: { ok: false, error: 'Map maximum size exceeded' } });
    await p;
    assert.deepEqual([t.said, t.told, t.app.noFacts], [[], [], 'no edges for this model: Map maximum size exceeded']);
  }
  // the moment's rule: a RangeError of a size limit is the model's own, remembered; the page's copy
  // with no room is the moment's (r40 A3, Q2)
  {
    const t = make(), b = { edgeInfo: { value: null }, position: { slice() { throw new RangeError('Invalid array length'); } }, index: new Uint32Array(3), header: { meshes: [] } };
    await t.edgesOf(b);
    assert.equal(b.edgeInfo.failed, true, 'a copy past a size limit: not of the moment');
  }
  // a file whose facts are stale: its edges drawn at once, before the build settles; its facts'
  // failure worded as no volume, the edges being there (r39 Q4, A3)
  {
    const t = make(), f = { edgeInfo: { value: null }, edges: new Uint32Array(4), silhouettes: null, silhouetteNormals: null, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [], facts: { closed: [] }, factsRule: 3 } };
    t.app.baseMesh = f;
    const p = t.edgesOf(f);
    assert.equal(t.drawn.length, 1, 'drawn before the build settles');
    t.made[0].onmessage({ data: { started: true } });
    t.made[0].onmessage({ data: { ok: false, error: 'Map maximum size exceeded' } });
    await p;
    assert.equal(t.said[t.said.length - 1], 'ready · no volume for this model: Map maximum size exceeded');
  }
  // the one change of the shown model (showBase): the builds of models not kept stopped, the
  // scene before ended (its gone settles), the next shown (r38 Q1, Q2, A4)
  {
    const t = make(), a = { edgeInfo: { value: null }, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [] } };
    let ended = false;
    const scene = { edgeInfo: { leave: () => { ended = true; } } };
    t.app.baseMesh = scene;
    t.edgesOf(a);
    t.showBase('next scene', [a], 'stopped: the scene changed');
    assert.deepEqual([ended, t.made[0].ended, t.app.baseMesh], [true, undefined, 'next scene'], 'a scene keeping the model: its build runs on, the scene before ended');
    t.showBase('another model', ['another model'], 'stopped: another model was opened');
    assert.deepEqual([t.made[0].ended, t.app.edgeJobs.size, t.app.baseMesh], [true, 0, 'another model'], 'another model: its build stopped');
    t.showBase(null, [], 'stopped: another model was opened');
    assert.equal(t.app.baseMesh, null);
    // (the word of the one left taken back and let go: a move that gave the scene its facts kept
    // "no edges for this scene" -- r43 A1)
    const u = make(), s1 = { edgeInfo: {} };
    u.app.baseMesh = s1;
    u.app.noFacts = 'no edges for this scene: s1: x';
    u.app.statusMsg = 'ready · no edges for this scene: s1: x';
    u.showBase('the moved scene', [], 'stopped: the scene changed');
    assert.deepEqual([u.said, u.app.noFacts], [['ready'], null]);
    // (what the line says after the word kept: a tour's note, "Measure is off" -- r42 Q4)
    u.app.noFacts = 'no edges for this scene: s1: x';
    u.app.statusMsg = 'ready · no edges for this scene: s1: x · Measure is off';
    u.showBase('another', [], 'stopped: the scene changed');
    assert.deepEqual([u.said[u.said.length - 1], u.app.noFacts], ['ready · Measure is off', null]);
  }
  // no module worker: said as why there are neither edges nor volume, remembered (r44 Q3)
  {
    const t = make(false, 2e6, false, true), b = { edgeInfo: { value: null }, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [] } };
    t.app.baseMesh = b;
    await t.edgesOf(b);
    assert.deepEqual([b.edgeInfo.failed, t.said], [true, ['ready · no edges for this model: no module worker could start here, and the page builds no edges or volume itself (module workers are not supported)']]);
  }
  // a size limit met when the file was read, written in it under today's rule: remembered at once,
  // no worker (r43 A3); one of the moment, or one written under another rule, built (r44 A1, Q2)
  {
    const failed = (error, factsRule = FACTS_RULE) => ({ edgeInfo: { value: null }, position: new Float32Array(9), index: new Uint32Array(3), header: { meshes: [], edgesFailed: { error, factsRule } } });
    const t = make(), b = failed('Invalid array length');
    t.app.baseMesh = b;
    assert.equal(await t.edgesOf(b), null);
    assert.deepEqual([t.made.length, b.edgeInfo.failed, t.said], [0, true, ['ready · no edges for this model: Invalid array length (when it was read)']]);
    for (const [c, why] of [[failed('Array buffer allocation failed'), 'one of the moment'], [failed('Out of memory'), 'Safari\'s words: the moment\'s by today\'s rule'], [failed('Invalid array length', FACTS_RULE - 1), 'another rule\'s']]) {
      const u = make();
      u.edgesOf(c);
      assert.equal(u.made.length, 1, `${why}: built`);
    }
  }
  // a file's silhouettes past the device's cap: left out and counted, as a build's are (r37 Q5)
  {
    const t = make(true, 2), b = { edgeInfo: { value: null }, edges: new Uint32Array(2), silhouettes: Uint32Array.of(0, 1, 1, 2, 2, 3), silhouetteNormals: new Int16Array(24), header: { meshes: [], facts: {} } };
    const v = await t.edgesOf(b);
    assert.deepEqual([v.source, v.silhouettes, v.silhouettesOmitted, t.made.length], ['file', null, 3, 0]);
  }
});
await test('a scene\'s edges: only its stale models built, each kept, then the scene merged from them; a failed build stops it and is said, the panel saying why there is no volume (r35 Q1, A3)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const cut = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const line = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n', at) + 1); };
  const pv = src.indexOf('const pendingVolume = '), pvEnd = src.indexOf("'computing…');", pv) + "'computing…');".length;
  const body = cut('async function sceneEdges(merged, models) {') + src.slice(pv, pvEnd) + '\n' + cut('function fileEdgesValue(base, cap) {')
    + cut('function sayNoFacts(text) {') + cut('function sceneFailed(merged, failed, cap) {') + cut('function readyText() {');
  const GONE = Symbol('gone');
  // fail: 'failed' (for the moment) | 'stopped' | 'remembered' (failed and said before) | 'unsaid'
  // (failed while the status was not ready: said by nobody yet) | 'never' (a build that never ends;
  // the scene replaced) | 'allfail' (every stale model's fails)
  // edged: every model carries its own edges (the scene's then drawn though a model's facts fail);
  // edgesFirst: the scene's merge has them before any build; line: a "no …" word said before (shown:
  // the status line then shown, by default the ready line carrying it); mergeThrows: the merge's error
  // (mixed: s0 fails for the moment, s1 for itself; laterunsaid: s0's failure said before, s1's new)
  // (mergedError: mergeModels' own merge failed, kept on the scene; status: the status when it ends)
  // (more: models beside the stale ones, current)
  const run = async (fail, { stale: nStale = 1, edged = false, edgesFirst = false, line = null, shown = null, mergeThrows = null, mergedError = null, status = 'ready', more = 0 } = {}) => {
    const built = [], said = [], caps = [], drawn = [];
    const before = { remembered: { failed: true, said: true, error: 'Map maximum size exceeded' }, unsaid: { failed: true, said: false, error: 'Map maximum size exceeded' }, firstfails: { failed: true, said: true, error: 'Map maximum size exceeded' }, laterunsaid: { failed: true, said: true, error: 'Map maximum size exceeded' } }[fail];
    // (firstfails: the first stale model's failure remembered, the second would build)
    const stale = Array.from({ length: nStale }, (_, i) => ({ name: `s${i}`, base: { header: {}, edgeInfo: before && ((fail !== 'firstfails' && fail !== 'laterunsaid') || i === 0) ? { ...before } : undefined } }));
    const models = [{ name: 'a', base: { header: {} } }, ...Array.from({ length: more }, (_, i) => ({ name: `c${i}`, base: { header: {} } })), ...stale];
    let leave;
    const merged = { edgeInfo: { value: null, gone: new Promise((r) => { leave = () => r(GONE); }) }, header: {}, edges: edgesFirst ? new Uint32Array(2) : undefined, mergeError: mergedError };
    const app = { baseMesh: merged, status, scene: models, noFacts: line, statusMsg: shown ?? (line ? `ready · ${line}` : 'ready') };
    const edgesOf = (base) => {
      built.push(base === merged ? 'scene' : 'model');
      if (base === merged) return Promise.resolve({ source: 'file', facts: {} });
      if (fail === 'never') return new Promise(() => {});
      if (fail === 'failed' || (fail === 'mixed' && base === stale[0].base)) { base.edgeInfo.error = 'the worker failed: out of memory'; base.edgeInfo.stopped = false; return Promise.resolve(null); }
      if (fail === 'allfail' || fail === 'mixed' || (fail === 'laterunsaid' && base !== stale[0].base)) { Object.assign(base.edgeInfo, { error: 'Map maximum size exceeded', failed: true }); return Promise.resolve(null); }
      if (fail === 'stopped') { base.edgeInfo.error = 'the scene changed'; base.edgeInfo.stopped = true; return Promise.resolve(null); }
      if (base.edgeInfo?.failed) return Promise.resolve(null);
      return Promise.resolve({ source: 'worker', facts: {} });
    };
    const merge = (m, ms, opts) => {
      built.push('merged'); caps.push(opts?.silhouetteCap);
      if (mergeThrows) throw new RangeError(mergeThrows);
      if (edged) m.edges = new Uint32Array(2);
    };
    const setStatus = (s, t) => { said.push(t); app.status = s; app.statusMsg = t; };
    const told = [];
    const [sceneEdges, pendingVolume] = new Function('app', 'edgesOf', 'staleModels', 'sceneEdgesFacts', 'silhouetteCapHere', 'setStatus', 'GONE', 'refreshEdges', 'fmtInt', 'overSilhouetteCap', 'factsCurrent', 'momentaryFailure', 'tell', `${body}; return [sceneEdges, pendingVolume];`)(
      app, edgesOf, () => stale, merge, () => 5e5, setStatus, GONE, () => drawn.push(merged.edgeInfo.value), (n) => String(n), overSilhouetteCap, () => false, momentaryFailure, (t) => told.push(t));
    const pending = sceneEdges(merged, models).catch((e) => `rejected ${e.message}`);
    if (fail === 'never') leave(); // (another scene shown while this one waits)
    const v = await Promise.race([pending, new Promise((r) => setTimeout(() => r('still waiting'), 500))]);
    return { v, built, panel: pendingVolume(merged.edgeInfo, app.scene.length > 1), said, told, caps, drawn, app, merged, info: stale[0]?.base.edgeInfo };
  };
  const ok = await run(false);
  assert.deepEqual([ok.built, ok.v?.source, ok.caps], [['model', 'merged', 'scene'], 'file', [5e5]], 'the stale model built, the scene merged under the device\'s cap, then its own from the merge');
  const none = await run(false, { stale: 0 });
  assert.deepEqual(none.built, ['scene'], 'nothing built: not merged again (mergeModels merged it, r37 Q5)');
  // (a failure of the moment: the model named, the advice a move -- "add the model again" left the
  // failed one in the scene: r40 A4, Q5, Q7)
  const bad = await run('failed');
  assert.deepEqual([bad.v, bad.panel, bad.said], [null, 'not computed: s0: the worker failed: out of memory (move a model to try again)', ['ready · no edges for this scene: s0: the worker failed: out of memory']]);
  // (a model's facts failing leaves the scene's edges drawn when every model carries its own: r38 A1)
  const edged = await run('failed', { edged: true });
  assert.deepEqual([edged.v?.edges?.length, edged.v?.facts], [2, null], 'the edges kept, the facts missing');
  // (a stop, whatever its wording, is not said on the status line, which the next scene owns: r37 A2)
  const stopped = await run('stopped');
  assert.deepEqual([stopped.panel, stopped.said], ['not computed: s0: the scene changed', []]);
  // (a failure said before: the panel says it, the status line not again -- and no advice, the
  // model's own failing the same way at every try: r40 Q5; one never said -- met while the status
  // was not ready -- said now, once: r37 A3, r38 A2)
  const again = await run('remembered', { line: 'no edges for this scene: s0: Map maximum size exceeded' });
  assert.deepEqual([again.panel, again.said], ['not computed: s0: Map maximum size exceeded', []]);
  const unsaid = await run('unsaid');
  // (told: only the word, not what the ready line always carries -- r45 A2, Q4)
  assert.deepEqual([unsaid.said, unsaid.told], [['ready · no edges for this scene: s0: Map maximum size exceeded'], ['no edges for this scene: s0: Map maximum size exceeded']]);
  // (several failing: the first named, the others counted: r40 Q7)
  const all = await run('allfail', { stale: 3 });
  assert.deepEqual(all.said, ['ready · no edges for this scene: s0: Map maximum size exceeded (and 2 more models)']);
  // (the scene's edges in hand drawn before its builds settle, facts to come: r40 Q3)
  const early = await run('never', { edgesFirst: true });
  assert.deepEqual([early.drawn.length, early.drawn[0]?.edges?.length, early.drawn[0]?.facts], [1, 2, null], 'drawn at once');
  // (a scene whose facts arrive says nothing: the word, if any, was taken back by showBase -- r44 A5)
  const none2 = await run(false, { line: null });
  assert.deepEqual([none2.said, none2.app.noFacts], [[], null], 'nothing said');
  // (a scene's state from every failed model: one remembered, so no advice; a later model's first
  // failure said though the first's was said before: r41 A2, Q1)
  const mixed = await run('mixed', { stale: 2 });
  assert.deepEqual([mixed.panel, mixed.merged.edgeInfo.failed], ['not computed: s0: the worker failed: out of memory (and 1 more model)', true]);
  const later2 = await run('laterunsaid', { stale: 2 });
  assert.deepEqual(later2.said, ['ready · no edges for this scene: s0: Map maximum size exceeded (and 1 more model)']);
  // (the scene's merge failing: the scene's failure, said, the moment's by the rule -- not a
  // rejection that left "computing…": r41 Q3)
  const mergeFails = await run(false, { mergeThrows: 'Array buffer allocation failed' });
  assert.deepEqual([mergeFails.v, mergeFails.panel, mergeFails.said], [null, 'not computed: the scene\'s merge: Array buffer allocation failed (move a model to try again)', ['ready · no edges for this scene: the scene\'s merge: Array buffer allocation failed']]);
  // (one the same at every try: no advice -- r42 Q7)
  const mergeLimit = await run(false, { mergeThrows: 'Invalid array length' });
  assert.equal(mergeLimit.panel, 'not computed: the scene\'s merge: Invalid array length');
  // (with a model's failure remembered: both, the scene remembered, no advice -- r42 A1, Q2)
  // (the merge named as itself, not counted as a model: r43 A6)
  const both = await run('remembered', { mergeThrows: 'Array buffer allocation failed' });
  assert.deepEqual([both.panel, both.merged.edgeInfo.failed, both.said], ['not computed: s0: Map maximum size exceeded (and the scene\'s merge)', true, ['ready · no edges for this scene: s0: Map maximum size exceeded (and the scene\'s merge)']]);
  // (mergeModels' own merge failed and no model is stale: the scene's failure, not a build of the
  // whole scene -- r42 A3; a scene of two, its advice a scene's -- r43 A7)
  const firstMerge = await run(false, { stale: 0, more: 1, mergedError: new RangeError('Array buffer allocation failed') });
  assert.deepEqual([firstMerge.built, firstMerge.panel], [[], 'not computed: the scene\'s merge: Array buffer allocation failed (move a model to try again)']);
  // (mergeModels' merge failed, a stale model built, the merge again whole: the scene's own facts,
  // no word, one merge -- r43 Q5)
  const remerged = await run(false, { mergedError: new RangeError('Array buffer allocation failed') });
  assert.deepEqual([remerged.built, remerged.v?.source, remerged.said, remerged.app.noFacts ?? null], [['model', 'merged', 'scene'], 'file', [], null]);
  // (an export's progress, said while ready, left alone: the word waits for the next ready line -- r43 Q3)
  const exporting = await run('failed', { shown: 'exporting 12 bodies as STL…' });
  assert.deepEqual([exporting.said, exporting.app.noFacts], [[], 'no edges for this scene: s0: the worker failed: out of memory']);
  // (the word written in place, a tour's note after it kept: r43 A2)
  const noted = await run('failed', { shown: 'ready · the tour names parts this model lacks: J5' });
  assert.deepEqual(noted.said, ['ready · no edges for this scene: s0: the worker failed: out of memory · the tour names parts this model lacks: J5']);
  // (a move with a failure said before: the word kept, and the bare ready line given it -- it read
  // "ready"; one met while a load is under way: the word kept for the line to come -- r42 Q3)
  const moved = await run('remembered', { shown: 'ready' });
  assert.deepEqual([moved.said, moved.app.noFacts], [['ready · no edges for this scene: s0: Map maximum size exceeded'], 'no edges for this scene: s0: Map maximum size exceeded']);
  const busy = await run('failed', { status: 'loading' });
  assert.deepEqual([busy.said, busy.app.noFacts, busy.told], [[], 'no edges for this scene: s0: the worker failed: out of memory', []]);
  // (every failure a stop: no word, the next scene owns it -- r42 Q7)
  assert.equal(stopped.app.noFacts ?? null, null);
  // (a model's failure does not stop the others: the next stale model is built, the scene merged
  // once -- stopping at the first left a later model without its edges: r39 Q1)
  const later = await run('firstfails', { stale: 2 });
  assert.deepEqual([later.built, later.v], [['model', 'model', 'merged'], null], 'both built, one merge');
  // (a scene replaced while its build runs ends at once, merging nothing: r37 A1)
  const gone = await run('never');
  assert.deepEqual([gone.v, gone.built], [null, ['model']], 'ended, not still waiting, no merge');
  // (a model alone: opened again for a failure of the moment, nothing for one remembered: r40 Q5)
  const pvAlone = new Function('app', `${src.slice(pv, pvEnd)}; return pendingVolume;`)({});
  assert.deepEqual([pvAlone({ error: 'the worker failed: x' }, false), pvAlone({ error: 'Map maximum size exceeded', failed: true }, false), pvAlone(null, false)],
    ['not computed: the worker failed: x (open the file again to try again)', 'not computed: Map maximum size exceeded', 'computing…']);
});
test('the ready line: the missing faces, the list\'s note, a 2D drawing\'s word, and the shown model\'s missing facts -- every writer of a ready line through readyText (r41 A4, r42 A5, A6, Q5)', () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const at = src.indexOf('function readyText() {'), body = src.slice(at, src.indexOf('\n}\n', at) + 2);
  const app = { baseMesh: 'm', unmeshedFaces: 0, listNote: '', dxf: null, noFacts: null };
  const readyText = new Function('app', 'fmtInt', `${body}; return readyText;`)(app, (n) => String(n));
  assert.equal(readyText(), 'ready');
  Object.assign(app, { unmeshedFaces: 3, listNote: 'model list x: HTTP 404', noFacts: 'no volume for this model: y' });
  assert.equal(readyText(), 'ready · 3 faces could not be meshed and are missing · model list x: HTTP 404 · no volume for this model: y');
  Object.assign(app, { dxf: { drawing: { units: null } }, noFacts: null });
  assert.equal(readyText(), 'ready · 2D drawing (its unit is not stored) · model list x: HTTP 404', 'a drawing\'s word with the list\'s note');
  // (each status line said while ready starts with the ready text, but the export's progress -- its
  // end writes the ready text back)
  const writers = [...src.matchAll(/setStatus\(([^,]*'ready'[^,]*), (`[^`]*`|'[^']*'|[^)]*\))\)/g)].map((m) => m[2]);
  const bare = writers.filter((w) => !/readyText\(\)/.test(w) && !/^`exporting /.test(w));
  assert.ok(writers.length >= 8, `ready writers found: ${writers.length}`);
  // (each failure added to the ready line told, by name: an export's failed was shown 1.5 s and never heard -- r45 Q1)
  for (const words of ['export failed: ', 'could not save ', 'could not move ', 'could not recolour: ', 'the tour has no step', 'the tour names parts this model lacks: ', 'the tour ${r.error}']) {
    assert.ok(src.includes(`tellReady(\`${words}`), `told: ${words}`);
  }
  assert.deepEqual(bare, [], 'a ready line without the ready text');
  // (no writer keeps the status it finds and adds words to it unseen: r43 Q4, r45 A1)
  assert.deepEqual(src.split('\n').filter((l) => /setStatus\(app\.status, /.test(l)), []);
  // (one owner of a note: flashHover called only from tell -- its definition and that call -- r45 A1)
  assert.equal([...src.matchAll(/flashHover\(/g)].length, 2);
  // (Save .cadmesh writes js/cadmesh.js cadmeshToSave's bytes, without a written edges failure -- r44 Q2, r45 Q9)
  assert.match(src, /bytes = await cadmeshToSave\(app\.lastStepBuffer\);/);
  // (the page's read where no worker could be made builds no edges or facts: never on the page -- r43 A4)
  assert.match(src, /await readMeshFile\(\{ \.\.\.src, unit, edges: false \}\)/);
});
await test('a note is told -- shown where the view\'s notes go and read out -- the words a writer adds to the ready line alone; a change of state read out; what is said at once said together (r44 Q1, r45 A1, A2, Q1, Q2, Q4)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const cut = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const line = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n', at) + 1); };
  const body = line('let saySeq = 0') + cut('function announce(text) {') + cut('function sayNow(text) {') + cut('function tell(text, ms = 1500, said = text) {')
    + cut('function tellReady(words, ms = 6000) {') + cut('function setStatus(s, msg) {');
  const el = () => ({ textContent: '', title: '', dataset: {}, hidden: false });
  const dom = { status: el(), progress: el(), announce: el() };
  const app = { status: 'idle', statusMsg: 'idle' }, heard = [], shown = [];
  const live = { set textContent(t) { heard.push(t); this.t = t; }, get textContent() { return this.t || ''; } };
  dom.announce = live;
  const [setStatus, tell, tellReady, announce] = new Function('app', '$', 'flashHover', 'showEmpty', 'PROGRESS_STATES', 'readyText', 'requestAnimationFrame', `${body}; return [setStatus, tell, tellReady, announce];`)(
    app, (id) => dom[id], (t) => shown.push(t), () => {}, new Set(['loading', 'tessellating']), () => 'ready · 3 faces could not be meshed and are missing', (f) => f());
  const settle = () => new Promise((r) => setTimeout(r, 0));
  setStatus('ready', 'ready'); await settle();
  setStatus('ready', 'ready · 3 faces could not be meshed and are missing'); await settle(); // (a rewrite in the same state: silent)
  tellReady('export failed: x'); await settle();
  assert.deepEqual([app.statusMsg, shown, heard], ['ready · 3 faces could not be meshed and are missing · export failed: x', ['export failed: x'], ['ready', 'export failed: x']]);
  // (two in one moment: said together, in order -- the later replaced the earlier unheard)
  tell('the tour names parts this model lacks: J5'); announce('Step 1 of 3'); await settle();
  assert.equal(heard[heard.length - 1], 'the tour names parts this model lacks: J5 · Step 1 of 3');
  // (said null: shown only, its caller reads out its own words)
  tell('hole 1: Ø 3.2 mm', 3000, null); await settle();
  assert.deepEqual([shown[shown.length - 1], heard.length], ['hole 1: Ø 3.2 mm', 3]);
});
await test('the edges drawn are the value\'s: a file\'s drawn while its facts build, then the build\'s uploaded in their place; the same arrays not uploaded again (r40 A1, Q9)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const at = src.indexOf('async function syncEdges(r, mesh) {'), body = src.slice(at, src.indexOf('\n}\n', at) + 2);
  const uploads = [];
  const r = { canDrawEdges: true, edgesFor: null, bodiesFor: null, setBodies() {}, async uploadEdges(m, e) { uploads.push(e.n); this.edgesFor = m; } };
  const syncEdges = new Function('app', 'edgeData', 'edgeInstances', 'silhouetteInstances', 'bodiesWithExplode', `${body}; return syncEdges;`)(
    {}, new WeakMap(), (m, e) => ({ n: e.length }), () => null, () => null);
  const mesh = { edgeInfo: { value: { edges: new Uint32Array(4), silhouettes: null } } };
  await syncEdges(r, mesh);
  await syncEdges(r, mesh);
  assert.deepEqual(uploads, [4], 'the file\'s, once');
  mesh.edgeInfo.value = { edges: new Uint32Array(6), silhouettes: null };
  await syncEdges(r, mesh);
  assert.deepEqual(uploads, [4, 6], 'the build\'s in their place');
  // (new silhouettes with the same edges: uploaded too -- the key's other half, r41 Q7)
  mesh.edgeInfo.value = { edges: mesh.edgeInfo.value.edges, silhouettes: new Uint32Array(2), silhouetteNormals: new Int16Array(8) };
  await syncEdges(r, mesh);
  assert.deepEqual(uploads, [4, 6, 6], 'the silhouettes\' change uploaded');
  // (a fresh renderer -- a lost context made a new one -- gets the same value uploaded, from the
  // instances kept: r41 Q4)
  const r2 = { ...r, edgesFor: null, uploadEdges: r.uploadEdges };
  await syncEdges(r2, mesh);
  assert.deepEqual([uploads, r2.edgesFor === mesh], [[4, 6, 6, 6], true], 'a new renderer: uploaded again');
});
test('keepEdges keeps a build on its model as a file\'s would be: edges, silhouettes, their count left out, the facts and today\'s rule (r36 A5)', () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const at = src.indexOf('function keepEdges(base, v) {'), body = src.slice(at, src.indexOf('\n}\n', at) + 2);
  const keepEdges = new Function('FACTS_RULE', `${body}; return keepEdges;`)(FACTS_RULE);
  // (a written failure of the moment, then built: gone with the facts -- never beside them, r45 A9)
  const base = { header: { edgesFailed: { error: 'Array buffer allocation failed', factsRule: FACTS_RULE } } }, v = { edges: new Uint32Array(2), silhouettes: null, silhouetteNormals: null, silhouettesOmitted: 7, facts: { closed: [true] } };
  keepEdges(base, v);
  assert.deepEqual([base.edges, base.silhouettes, base.silhouetteNormals, base.header.silhouettesOmitted, base.header.facts, base.header.factsRule, 'edgesFailed' in base.header],
    [v.edges, null, null, 7, v.facts, FACTS_RULE, false]);
});
test('the selftest\'s edges report: a file\'s edges kept while its facts failed read as edges, the facts\' error beside, not a TypeError (r39 A2, Q3)', () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const at = src.indexOf('out.edges = e ?'), expr = src.slice(at, src.indexOf(";\n", at) + 1);
  const report = new Function('e', 'app', `const out = {}; ${expr} return out.edges;`);
  const app = { baseMesh: { edgeInfo: { error: 'Map maximum size exceeded' } } };
  assert.deepEqual(report({ source: 'file', ms: 0, edges: new Uint32Array(4), silhouettes: null, silhouettesOmitted: 0, facts: null }, app),
    { source: 'file', ms: 0, boundary: 2, silhouettes: 0, omitted: 0, closed: null, factsError: 'Map maximum size exceeded' });
  assert.equal(report({ source: 'worker', ms: 1, edges: new Uint32Array(2), silhouettes: null, silhouettesOmitted: 0, facts: { closed: [true, false] } }, app).closed, 1);
});
await test('the edges worker itself says it has started, then a failed build as { ok: false, error } (r36 Q3)', async () => {
  const posted = [];
  const saved = { postMessage: globalThis.postMessage, onmessage: globalThis.onmessage };
  globalThis.postMessage = (m) => { posted.push(m); };
  globalThis.onmessage = null;
  try {
    await import(`../js/edges-worker.js?t=${Date.now()}`);
    assert.deepEqual(posted[0], { started: true });
    globalThis.onmessage({ data: { position: null, index: null, meshes: null } });
    // (a malformed message: a TypeError, no size limit -- tried again, at most MOMENT_TRIES times)
    assert.deepEqual([posted[1].ok, typeof posted[1].error, posted[1].transient], [false, 'string', true]);
    // (a body of 2^53 vertices, past any typed array's length: a RangeError the same at every try,
    // the model's own -- not of the moment: r40 A3, Q2; one of 2^40, an allocation refused, is said
    // the moment's, and edgesOf remembers it after MOMENT_TRIES)
    const body = (n) => ({ data: { position: new Float32Array(9), index: new Uint32Array(3), meshes: [{ vtxStart: 0, vtxCount: n, idxStart: 0, idxCount: 3, bbox: { min: [0, 0, 0], max: [1, 1, 1] } }] } });
    globalThis.onmessage(body(2 ** 53));
    assert.deepEqual([posted[2].ok, posted[2].transient], [false, undefined], posted[2].error);
    globalThis.onmessage(body(2 ** 40));
    assert.deepEqual([posted[3].ok, posted[3].transient, posted[3].error], [false, true, 'Array buffer allocation failed']);
    // (the rule it says by: every failure but a size limit met at every try, in each engine's words
    // -- Safari's "Out of memory" the moment's, not the model's: r41 A1)
    assert.deepEqual([new RangeError('Array buffer allocation failed'), new RangeError('Out of memory'), new Error('out of memory'),
      new RangeError('Map maximum size exceeded'), new RangeError('Invalid array length'), new RangeError('Invalid typed array length: 9007199254740992'),
      new RangeError('Maximum call stack size exceeded'), new Error('too much recursion'), new RangeError('Invalid string length'),
      new RangeError('Invalid array buffer length'), new Error('allocation size overflow')].map(momentaryFailure),
    [true, true, true, false, false, false, false, false, false, false, false]);
  } finally {
    globalThis.postMessage = saved.postMessage;
    globalThis.onmessage = saved.onmessage;
  }
});
await test('the Clearance worker itself says it has started, then a failed run as { ok: false, error } (r33 A6: only the page\'s half was tested)', async () => {
  const posted = [];
  const saved = { postMessage: globalThis.postMessage, onmessage: globalThis.onmessage };
  globalThis.postMessage = (m) => { posted.push(m); };
  globalThis.onmessage = null; // (a worker's global has it; the module assigns it)
  try {
    await import(`../js/clearance-worker.js?t=${Date.now()}`);
    assert.deepEqual(posted[0], { started: true });
    globalThis.onmessage({ data: { position: null, index: null, normal: null, trisA: [[0, 1]], trisB: [[0, 1]] } });
    assert.equal(posted[1].ok, false);
    assert.equal(typeof posted[1].error, 'string');
  } finally {
    globalThis.postMessage = saved.postMessage;
    globalThis.onmessage = saved.onmessage;
  }
});
test('containment does not trust the winding but the normals: a block wound inside out, or with one side reversed, its normals out, still holds the pin; with no normals its winding is its facing (r30 A2: one rule)', () => {
  const block = file('block', [['block', [0, 0, 0], [10, 10, 10]]]);
  const pin = file('pin', [['pin', [4, 4, 4], [6, 6, 6]]]);
  const ask = (flip, withNormals) => {
    const s = mergeModels([{ base: block, name: 'block.stp' }, { base: pin, name: 'pin.stp' }]);
    const [[t0, c]] = trisOf(s, [1]);
    for (let t = t0; t < t0 + (flip === 'all' ? c : 2); t++) { const x = s.index[3 * t + 1]; s.index[3 * t + 1] = s.index[3 * t + 2]; s.index[3 * t + 2] = x; }
    const r = clearance(s.position, s.index, trisOf(s, [2]), trisOf(s, [1]), { solidA: trisOf(s, [2]), solidB: trisOf(s, [1]), ...(withNormals ? { normal: s.normal } : {}) });
    return [r.distance, !!r.inside];
  };
  for (const flip of ['all', 'one side']) assert.deepEqual(ask(flip, true), [0, true], `${flip}, normals out`);
  assert.deepEqual(ask('all', false), [4, false], 'wound inside out, no normals: no material');
});

done();
