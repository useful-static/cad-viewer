#!/usr/bin/env node
// Two models in one view (js/scene.js mergeModels) and the clearance between
// them (js/clearance.js); the scene's edges and facts; and the page's two
// contracts, each cell or case run on main.js's own code: what the page says
// (NOTE_STATES x NOTE_CONTRACT, with its sequence arms) and how it starts from
// its address (START_CASES).
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
import { answeredFrom, entryByName, fetchModelLists, isRelative, isTimeout, listedUrlFrom, modelNameFrom, modelUrlFrom, posterAsked, readCapped } from '../js/model-list.js';
import { fileUrl } from '../js/open-url.js';
import { MAX_TOUR_BYTES, parseTour } from '../js/tour.js';
import { orientOrNull } from '../js/orient.js';
import { formatOfName, isCompanion } from '../js/formats.js';

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
    + cut('function sayNoFacts(text) {') + cut('function rewriteReady(change) {') + line('const MOMENT_TRIES = ') + cut('function readyText() {');
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
    // (told at once all the same: r46 A1)
    assert.deepEqual([t.said, t.told, t.app.noFacts], [[], ['no edges for this model: Map maximum size exceeded'], 'no edges for this model: Map maximum size exceeded']);
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
    + cut('function sayNoFacts(text) {') + cut('function rewriteReady(change) {') + cut('function sceneFailed(merged, failed, cap) {') + cut('function readyText() {');
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
  assert.deepEqual([again.panel, again.said, again.told], ['not computed: s0: Map maximum size exceeded', [], []], 'the same word: not told again');
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
  // (told at once: it waited for the export's end, whose ready-to-ready line no one hears -- r46 A1)
  assert.deepEqual([exporting.said, exporting.app.noFacts, exporting.told], [[], 'no edges for this scene: s0: the worker failed: out of memory', ['no edges for this scene: s0: the worker failed: out of memory']]);
  // (the word written in place, a tour's note after it kept: r43 A2)
  const noted = await run('failed', { shown: 'ready · the tour names parts this model lacks: J5' });
  assert.deepEqual(noted.said, ['ready · no edges for this scene: s0: the worker failed: out of memory · the tour names parts this model lacks: J5']);
  // (a move with a failure said before: the word kept, and the bare ready line given it -- it read
  // "ready"; one met while a load is under way: the word kept for the line to come -- r42 Q3)
  const moved = await run('remembered', { shown: 'ready' });
  assert.deepEqual([moved.said, moved.app.noFacts], [['ready · no edges for this scene: s0: Map maximum size exceeded'], 'no edges for this scene: s0: Map maximum size exceeded']);
  const busy = await run('failed', { status: 'loading' });
  assert.deepEqual([busy.said, busy.app.noFacts, busy.told], [[], 'no edges for this scene: s0: the worker failed: out of memory', ['no edges for this scene: s0: the worker failed: out of memory']]);
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
  // (each line that writes a ready status carries the ready text: read line by line, every such
  // writer -- the regex saw 7 of 11, and its exemption for the export's progress hid one: r47 Q6)
  // (code lines only; rewriteReady's `line` is readyText() + the tail, built the line above it -- the
  // one rewrite in place, r51 A8)
  const writers = src.split('\n').filter((l) => !/^\s*\/\//.test(l) && /setStatus\((?:'ready'|[^,]*\? 'ready')/.test(l));
  const bare = writers.filter((l) => !/readyText\(\)/.test(l) && !/^ {2}if \(line !== msg\) setStatus\('ready', line\);$/.test(l));
  assert.match(src, /const line = readyText\(\) \+ msg\.slice\(before\.length\);\n {2}if \(line !== msg\) setStatus\('ready', line\);/);
  assert.equal([...src.matchAll(/msg\.startsWith\(/g)].length, 1, 'one rewrite of a ready line in place');
  // (7 since r51 A8: three rewrites in place became rewriteReady's one)
  assert.ok(writers.length >= 7, `ready writers found: ${writers.length}`);
  // (a tour's step tells its missing parts but right after the start, which told them all: keyed on
  // that, not on the step's index -- r46 A4, r47 A7)
  // (the tour's start marks its moment, then shows step 1: r49 A3 -- the behaviour in its own arm below)
  assert.match(src, /markStarted\(app\.tour, missing\.length > 0\);\n {2}showTourStep\(0\);/);
  assert.match(src, /\n {2}tellStepMissing\(t\);\n/);
  // (a GPU error and a tour unread go through failApart, the one rule for a failure apart from the load -- r48 A1, Q1, Q2)
  assert.match(src, /r\.onerror = \(msg\) => \{ if \(app\.renderer === r\) \{ app\.error = msg; failApart\(`GPU error: \$\{msg\}`\); \} \};/);
  assert.equal([...src.matchAll(/failApart\(`the tour \$\{r\.error\}`\)/g)].length, 2, 'both tour reads');
  assert.match(src, /\n {6}recovered\(\);\n/, 'the recovery\'s end through recovered()');
  // (the touch hint recorded in one place only, after it held -- r48 Q3)
  const th = src.slice(src.indexOf('function touchHintOnce() {'), src.indexOf('\n}\n', src.indexOf('function touchHintOnce() {')));
  assert.equal([...th.matchAll(/setPref\(/g)].length, 1);
  // (Explode over Measure: its reason told -- shown and heard, not kept on the ready line -- r47 A6, r48 Q8)
  assert.match(src, /tell\('Measure is off while exploded: [^']*', 6000\);/);
  // (the view link "copied" only when the clipboard took it -- r47 A5: shareView's own run, below, r51)
  assert.doesNotMatch(src, /View link in the box to copy/);
  // (the touch hint counted as seen only if it held its time -- r47 Q7)
  assert.match(src, /setTimeout\(\(\) => \{ if \(\$\('hover'\)\.textContent === TOUCH_HINT\) setPref\('cadv\.touchHint', '1'\); \}, 5000\);/);
  // (round 50's start-up wiring -- Add model…'s size refusal, the early picker, the list read's card
  // and line, the poster's tour, the tour-ready note, the list's missing-model note -- is the start-up
  // table's below, run on main.js's own code: r51. A step's missing parts told after they are found,
  // in showTourStep, whose run needs the renderer: r50 Q6 f)
  const sts = src.slice(src.indexOf('function showTourStep(i) {'), src.indexOf('\n}\n', src.indexOf('function showTourStep(i) {')));
  // (stepPose finds them, after showTourStep empties the list)
  assert.ok(sts.indexOf('app.tourMissing = [];') >= 0 && sts.indexOf('const to = stepPose(s);') > sts.indexOf('app.tourMissing = [];')
    && sts.indexOf('tellStepMissing(t);') > sts.indexOf('const to = stepPose(s);'), 'a step\'s missing parts told after they are found');
  // (Measure is given the one rule, tell, not a show-only flash to pair by hand: r46 A3, Q3 J)
  assert.match(src, /announce, tell, queueFrame, syncOptbar,/);
  assert.doesNotMatch(readFileSync(new URL('../js/measure-ui.js', import.meta.url), 'utf8'), /deps\.flash/);
  // (each failure added to the ready line told, by name: an export's failed was shown 1.5 s and never heard -- r45 Q1)
  for (const words of ['export failed: ', 'could not save ', 'could not move ', 'could not recolour: ', 'the tour has no step', 'the tour names parts this model lacks: ']) {
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
  assert.match(src, /await \(await fileReaders\(\)\)\.readMeshFile\(\{ \.\.\.src, unit, edges: false \}\)/);
});
await test('a note is told -- shown where the view\'s notes go and read out -- the words a writer adds to the ready line alone; a change of state read out; what is said at once said together (r44 Q1, r45 A1, A2, Q1, Q2, Q4)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const cut = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const line = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n', at) + 1); };
  const body = line('let saySeq = 0') + cut('function announce(text) {') + cut('function sayNow(text) {') + cut('function tell(text, ms = 1500, said = text) {')
    + cut('function tellReady(words, ms = 6000) {') + cut('function setStatus(s, msg) {') + line('function somethingShown() {');
  const el = () => ({ textContent: '', title: '', dataset: {}, hidden: false });
  const dom = { status: el(), progress: el(), announce: el() };
  const app = { status: 'idle', statusMsg: 'idle' }, heard = [], shown = [];
  const live = { set textContent(t) { heard.push(t); this.t = t; }, get textContent() { return this.t || ''; } };
  dom.announce = live;
  // (frames queued, run when the test says: a frame that ran at once hid the repeat path and its stale guard -- r46 Q3)
  const frames = [];
  const [setStatus, tell, tellReady, announce] = new Function('app', '$', 'flashHover', 'showEmpty', 'PROGRESS_STATES', 'readyText', 'requestAnimationFrame', `${body}; return [setStatus, tell, tellReady, announce];`)(
    app, (id) => dom[id], (t) => shown.push(t), () => {}, new Set(['loading', 'tessellating']), () => 'ready · 3 faces could not be meshed and are missing', (f) => frames.push(f));
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const runFrames = () => { for (const f of frames.splice(0)) f(); };
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
  // (said after an await in the same task: still together -- r46 Q2)
  announce('ready · a.stl'); await Promise.resolve(); await Promise.resolve(); announce('a.stl read in inch'); await settle();
  assert.equal(heard[heard.length - 1], 'ready · a.stl · a.stl read in inch');
  // (the same text twice in one moment: once -- r46 Q3 D)
  announce('copied'); announce('copied'); await settle();
  assert.equal(heard[heard.length - 1], 'copied');
  // (the same text again, later: the region emptied, then written in the next frame, so it is heard
  // again; a newer one said before that frame wins -- r46 Q3 A, B)
  const n = heard.length;
  announce('copied'); await settle();
  assert.deepEqual(heard.slice(n), [''], 'emptied first');
  runFrames();
  assert.deepEqual(heard.slice(n), ['', 'copied'], 'then said again');
  announce('copied'); await settle(); announce('picture copied'); await settle(); runFrames();
  assert.equal(heard[heard.length - 1], 'picture copied', 'a stale repeat never lands last');
  // (a new error after an error read out; the same not -- r46 Q3 K)
  setStatus('error', 'not loaded: a'); await settle();
  setStatus('error', 'not loaded: b'); await settle();
  setStatus('error', 'not loaded: b'); await settle(); runFrames();
  assert.deepEqual(heard.slice(-2), ['not loaded: a', 'not loaded: b']);
  // (a note added while a load runs, or in an error: told, the state and its line kept -- r46 A2, Q1)
  setStatus('loading', 'reading b.step 40 %'); await settle();
  tellReady('could not move B: x'); await settle();
  assert.deepEqual([app.status, app.statusMsg, heard[heard.length - 1], shown[shown.length - 1]], ['loading', 'reading b.step 40 %', 'could not move B: x', 'could not move B: x']);
  setStatus('error', 'not loaded: c'); await settle();
  tellReady('the tour not found (404): t.json'); await settle();
  assert.deepEqual([app.status, app.statusMsg, heard[heard.length - 1]], ['error', 'not loaded: c', 'the tour not found (404): t.json']);
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

test('the hover line: a note of 4 s or more holds it against labels, its end puts back the last label any view gave (a 2D layer too), a tap shows through it, a model left lets it go (r46 Q5, r47 A3, A4, Q4, Q5)', () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const cut = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const line = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n', at) + 1); };
  const body = line('let viewNameTimer = ') + line('let noteHeldUntil = 0') + cut('function flashHover(text, ms = 1500) {') + cut('function hoverLabel(text, asked = false) {') + cut('function clearHover() {');
  let now = 0;
  const timers = [];
  const hov = { textContent: '' };
  const prefs = {};
  const [flashHover, hoverLabel, clearHover] = new Function('$', 'performance', 'setTimeout', 'clearTimeout', 'app', 'TOUCH_HINT', 'setPref', `${body}; return [flashHover, hoverLabel, clearHover];`)(
    () => hov, { now: () => now }, (f, ms) => { timers.push({ f, at: now + ms }); return timers.length; }, () => {}, {}, 'one finger turns · …', (k, v) => { prefs[k] = v; });
  const advance = (ms) => { now += ms; for (const t of timers.splice(0)) { if (t.at <= now) t.f(); else timers.push(t); } };
  hoverLabel('layer DIM');
  flashHover('12.70 mm · ΔX 12.70 ΔY 0.00', 4000);
  hoverLabel('layer DIM'); // (the 2D view sends it once: during the hold)
  assert.equal(hov.textContent, '12.70 mm · ΔX 12.70 ΔY 0.00', 'held');
  advance(3000);
  hoverLabel('layer DIM');
  assert.equal(hov.textContent, '12.70 mm · ΔX 12.70 ΔY 0.00', 'still held 3 s in: the hold is the note\'s own time (r48 Q3)');
  advance(1000);
  assert.equal(hov.textContent, 'layer DIM', 'the last label back at its end');
  flashHover('one finger turns · …', 6000);
  hoverLabel('', true);
  assert.equal(hov.textContent, 'one finger turns · …', 'a tap on the background asks for nothing: the note held (r48 A8)');
  hoverLabel('pcb', true);
  assert.deepEqual([hov.textContent, prefs['cadv.touchHint']], ['pcb', '1'], 'a tap shows through the hold, and the hint it followed counts as seen (r48 Q9)');
  flashHover('could not save m.step: x', 6000);
  clearHover();
  hoverLabel('lid');
  assert.equal(hov.textContent, 'lid', 'a model left: the hold let go');
  flashHover('front', 1500);
  hoverLabel('lid');
  assert.equal(hov.textContent, 'lid', 'a short note holds nothing');
});
await test('the read worker: a copy that cannot be posted rejects in words, the worker ended, its timer and the load\'s cancel let go (r48 A4)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const at = src.indexOf('function readInWorker(msg, name) {'), body = src.slice(at, src.indexOf('\n}\n', at) + 2).replaceAll('import.meta.url', "'file:///x/js/main.js'");
  const app = {}, made = [], cleared = [];
  class Worker { constructor() { made.push(this); } postMessage() { throw new RangeError('Array buffer allocation failed'); } terminate() { this.ended = true; } }
  const readInWorker = new Function('app', 'Worker', 'READ_LIMIT_S', 'setTimeout', 'clearTimeout', `${body}; return readInWorker;`)(
    app, Worker, 60, () => 7, (t) => cleared.push(t));
  const r = await readInWorker({ buf: new ArrayBuffer(8) }, 'big.stl').then(() => 'resolved', (e) => e.message);
  assert.deepEqual([r, made[0].ended, cleared, app.cancelTess], ['big.stl could not be read: no room for its copy (Array buffer allocation failed)', true, [7], null]);
});
test('Copy view link tells what it did and what the link does not carry, its clauses joined (r49 A6, Q6; r50 Q6 e; r51 A6)', () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const at = src.indexOf('function linkToldText(copied, hasUrl, nNotes'), body = src.slice(at, src.indexOf('\n}\n', at) + 2);
  const linkToldText = new Function('MAX_NOTES', `${body}; return linkToldText;`)(20);
  assert.deepEqual([linkToldText(true, true, 3), linkToldText(true, false, 25), linkToldText(false, true, 3), linkToldText(false, false, 0),
    linkToldText(true, true, 0, 1), linkToldText(false, true, 0, 2)], [
    'View link copied',
    'View link copied: it holds the view, not the file (opened from this device); it carries the first 20 of its 25 notes (a link is short)',
    '',
    'The view link: it holds the view, not the file (opened from this device)',
    // (the added models opened from this device, which the link leaves out: r51 A6)
    'View link copied: it leaves out the added model opened from this device',
    'The view link: it leaves out the 2 added models opened from this device']);
});
await test('Copy view link over a scene with a model added from this device says the link leaves it out (r51 A6)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const cut = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const share = async (writeText) => {
    const told = [];
    const app = { header: {}, dxf: null, sourceUrl: 'https://x.example/case.stl', measure: null,
      scene: [{ url: 'https://x.example/case.stl' }, { url: null }, { url: 'https://x.example/b.stl' }] };
    const shareView = new Function('app', 'viewLink', 'navigator', 'window', 'tell', 'MAX_NOTES',
      `${cut('async function shareView() {')}${cut('function linkToldText(copied, hasUrl, nNotes')}${cut('function linkAdds() {')}; return shareView;`)(
      app, () => 'https://cad.place/?src=x', { clipboard: { writeText } }, { prompt() {} }, (t) => told.push(t), 20);
    await shareView();
    return told;
  };
  assert.deepEqual(await share(async () => {}), ['View link copied: it leaves out the added model opened from this device']);
  // ("copied" only when the clipboard took it: r47 A5)
  assert.deepEqual(await share(async () => { throw new Error('refused'); }), ['The view link: it leaves out the added model opened from this device']);
});
await test('a tour step\'s missing parts: not told in the moment of the start, whatever step is shown then; told after it (r48 Q7, r49 A3, Q2)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const cut = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const told = [];
  const app = { tourMissing: ['J5'] };
  const [tellStepMissing, markStarted] = new Function('app', 'tell', 'setTimeout', `${cut('function tellStepMissing(t) {')}${cut('function markStarted(t, told) {')}; return [tellStepMissing, markStarted];`)(
    app, (t) => told.push(t), setTimeout);
  const t = {};
  markStarted(t, true);
  tellStepMissing(t); // (the start's own step 1)
  tellStepMissing(t); // (the step a picture, a video or the maker shows next, in the same moment)
  assert.deepEqual(told, [], 'the start told them');
  await new Promise((r) => setTimeout(r, 5));
  tellStepMissing(t); // (step 1 shown again, by ◀, a loop or a replay)
  assert.deepEqual(told, ['not in this model: J5'], 'told after the moment');
  const u = {};
  markStarted(u, false); // (a start that told nothing)
  tellStepMissing(u);
  assert.equal(told.length, 2);
});
await test('the converter: a copy that cannot be posted rejects in words, the worker and its progress timer ended (r49 A1)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const at = src.indexOf('function tessellate(buf, format, seq, name, threads) {'), body = src.slice(at, src.indexOf('\n}\n', at) + 2).replaceAll('import.meta.url', "'file:///x/js/main.js'");
  const app = {}, made = [], cleared = [];
  class Worker { constructor() { made.push(this); } postMessage() { throw new RangeError('Array buffer allocation failed'); } terminate() { this.ended = true; } }
  const tessellate = new Function('app', 'Worker', 'stale', 'announce', 'forecast', 'forecastTotal', 'mb', 'setStatus', 'showProgress', 'TESS_HINT', 'setInterval', 'clearInterval', 'crashText',
    `${body}; return tessellate;`)(app, Worker, () => false, () => {}, () => ({}), () => 0, (n) => String(n), () => {}, () => {}, '', () => 9, (t) => cleared.push(t), (m) => m);
  const r = await tessellate(new ArrayBuffer(8), 'step', 1, 'big.step', true).then(() => 'resolved', (e) => e.message);
  assert.deepEqual([r, made[0].ended, cleared, app.cancelTess], ['no room for the file\'s copy: Array buffer allocation failed', true, [9], null]);
});
await test('Measure\'s copy: said when copied, and when the clipboard refuses or is not there (r46 Q6, r47 A4, Q4)', async () => {
  const src = readFileSync(new URL('../js/measure-ui.js', import.meta.url), 'utf8');
  const at = src.indexOf('const copyText = (text, done) => {'), code = src.slice(at, src.indexOf('\n  };', at) + 5);
  const told = [];
  const make = (nav) => new Function('deps', 'navigator', `${code}; return copyText;`)({ tell: (t) => told.push(t) }, nav);
  make({ clipboard: { writeText: async () => {} } })('12.7 mm', 'copied');
  make({})('12.7 mm', 'copied');
  make({ clipboard: { writeText: async () => { throw new Error('denied'); } } })('12.7 mm', 'copied');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(told.sort(), ['copied', 'could not copy: denied', 'could not copy: no clipboard here']);
});

// ---------- The note contract (r47: rounds 43-46 each found a high in this path, fixed case by
// case; this table states it once, and every cell runs main.js's own code) ----------
//
// Rows: the page's states, with what is on screen. Columns: the writers of a note or of the line.
// A cell: the status after, the line after (#status, not drawn: what a later ready line builds
// on), what is shown in the view's note line, and what is read out. 'same' keeps the row's own.
// The line is drawn nowhere, so what the visitor learns is only what is shown and what is heard:
// a cell whose shown and heard are empty while it says something is the fault this table guards.
const W = 'could not move B: x', N = 'no volume for this model: v', E = 'not loaded: z.step: no surfaces';
const O = 'big.stl is over 2 GB, more than this viewer opens', G = 'GPU error: device lost', REC = 'recovered on webgl2';
const GOING = 'exporting 1 body as STL…', SAVED = 'saved m.stl: 1 body, 0.0 MB';
const CH = 'recovered on webgl2, but it cannot hold this model: too big', LACK = 'recovered on webgl2, but it cannot hold this model: earlier';
// (r48: three rows with nothing shown -- a first load, its failure, a recovery -- ran no cell of
// Cancel's idle branch or the error card: r48 A3)
const NOTE_STATES = {
  'no model': { status: 'idle', msg: 'open or drop a file', shows: null, ready: null },
  'loading, nothing shown': { status: 'loading', msg: 'reading b.step 40 %', shows: null, ready: null },
  'error, nothing shown': { status: 'error', msg: 'not loaded: y.step', shows: null, ready: null },
  'recovering, nothing shown': { status: 'recovering', msg: 'recovering the GPU…', shows: null, ready: null },
  // (r50: a ?list= read before its named model -- the card hidden for the read: Q1; an embed's
  // poster up -- a failure was heard only, the card behind the poster: Q5; a load whose shown model
  // the recovered renderer could not hold -- Cancel wrote "ready" over an empty view: Q2)
  'idle, reading the model list': { status: 'idle', msg: 'reading the model list…', shows: null, ready: null, readingList: true },
  'an embed\'s poster up': { status: 'idle', msg: 'View in 3D loads the model', shows: null, ready: null, poster: true },
  'loading, the shown model off the GPU': { status: 'loading', msg: 'reading b.step 40 %', shows: 'model', ready: 'ready', gpuLacks: LACK },
  // (r51: the recovery's own "cannot hold" error, which a recovery that holds the model ends -- the
  // page stayed 'error' over a drawn model: A2, Q3 b; an embed with nothing shown, and its poster,
  // their own idle words -- the open-a-file words were read out there: Q5)
  'error, the shown model off the GPU': { status: 'error', msg: CH, shows: 'model', ready: 'ready', gpuLacks: CH },
  'loading, nothing shown, an embed': { status: 'loading', msg: 'reading b.step 40 %', shows: null, ready: null, embed: true },
  'recovering, nothing shown, an embed': { status: 'recovering', msg: 'recovering the GPU…', shows: null, ready: null, embed: true },
  'recovering behind an embed\'s poster': { status: 'recovering', msg: 'recovering the GPU…', shows: null, ready: null, poster: true },
  'idle ready': { status: 'ready', msg: 'ready', shows: 'model', ready: 'ready' },
  'ready, a drawing': { status: 'ready', msg: 'ready · 2D drawing', shows: 'drawing', ready: 'ready · 2D drawing' },
  'loading': { status: 'loading', msg: 'reading b.step 40 %', shows: 'model', ready: 'ready' },
  // (r49: a load waiting on its question -- a GPU loss under it hid the question, and the load hung)
  'asking to convert': { status: 'loading', msg: 'big.step is 300 MB: convert it?', shows: 'model', ready: 'ready' },
  'loading over a drawing': { status: 'loading', msg: 'reading b.step 40 %', shows: 'drawing', ready: 'ready · 2D drawing' },
  'tessellating': { status: 'tessellating', msg: 'tessellating 3 of 9', shows: 'model', ready: 'ready' },
  'exporting': { status: 'ready', msg: `ready · ${GOING}`, shows: 'model', ready: 'ready' },
  'error': { status: 'error', msg: 'not loaded: y.step', shows: 'model', ready: 'ready' },
  'recovering': { status: 'recovering', msg: 'recovering the GPU…', shows: 'model', ready: 'ready' },
};
// each cell: [status, line, shown[[text, ms]], heard (the joined read-outs, in order)] -- or null:
// not reachable (Cancel is on the loading card only; Export needs a 3D model, and is not run within
// itself). Every cell also checks the empty card: shown only with nothing shown and no load or
// recovery running, carrying the error when there is one (showEmpty's own code, r48 A3).
// (The note's time is the contract's too: a hold shortened or dropped passed every test -- r48 Q3)
const same = 'same';
const busyRun = (s) => s.status === 'loading' || s.status === 'tessellating';
// a failure apart from the load (failApart): the page's error only when nothing is shown and nothing
// runs (idle, no model); else told, the state kept -- a load's own error on the card kept, and a
// recovery left to end (r49 Q3, Q4: the card lost why the model failed; a recovery ended on an error)
// (a list read for its named model hides the card: told then too -- the cell said error, shown
// nowhere: r52 Q3)
const apart = (s, words) => (s.shows || s.poster || s.readingList || s.status !== 'idle')
  ? [same, s.status === 'ready' ? `${s.ready} · ${words}` : same, [[words, 6000]], [words]] : ['error', words, [], [words]];
const LOST = 'GPU context lost (device lost); recovering', LIST = 'model list l.json: HTTP 404';
// (a row's idle words: an embed's poster its own, an embed none of the open-a-file words -- r51 Q5)
const idleOf = (s) => (s.poster ? 'View in 3D loads the model' : s.embed ? 'no model to show' : 'IDLE');
const NOTE_CONTRACT = {
  // tell(words): shown and read out; state and line kept, in every state
  tell: (r) => [same, same, [['copied', 3000]], ['copied']],
  // tellReady(words): told in every state; the line gains the words only while ready, after the
  // ready text (an export's progress replaced)
  tellReady: (r, s) => [same, s.status === 'ready' ? `${s.ready} · ${W}` : same, [[W, 6000]], [W]],
  // sayNoFacts(word): told when new, in every state; written into a ready line in place
  sayNoFacts: (r, s) => [same, s.status === 'ready' ? (r === 'exporting' ? `ready · ${N} · ${GOING}` : `${s.ready} · ${N}`) : same, [[N, 6000]], [N]],
  // a load's own failure, setStatus('error', …): the page's error; shown in the view when a model or
  // a drawing stays (the error card shows it only when nothing does); read out
  loadFails: (r, s) => ['error', E, s.shows ? [[E, 6000]] : [], [E]],
  // Cancel on the loading card: back to what is shown -- a drawing is shown too
  cancel: (r, s) => !busyRun(s) ? null
    // (the shown model off the GPU: said as not drawn, not "ready" over an empty view -- r50 Q2)
    : s.gpuLacks ? ['error', LACK, [[LACK, 6000]], [`loading cancelled · ${LACK}`]]
    : (s.shows ? ['ready', s.ready, [], [`loading cancelled · ${s.ready}`]] : ['idle', idleOf(s), [], [`loading cancelled · ${idleOf(s)}`]]),
  // the recovery's end on a renderer that cannot hold the shown model: the page's error (shown in
  // the view with a model kept); under a load, told and noted for Cancel (r50 A4, Q2); the same
  // error again is not news (shown, not read out again)
  cannotHold: (r, s) => busyRun(s) ? [same, same, [[CH, 6000]], [CH]] : ['error', CH, s.shows ? [[CH, 6000]] : [], s.msg === CH ? [] : [CH]],
  // a model list that failed beside lists that answered: told; written into a ready line in place
  // (r50 A6: the line was rewritten whole)
  listPartial: (r, s) => [same, s.status === 'ready' ? (r === 'exporting' ? `ready · ${LIST} · ${GOING}` : `${s.ready} · ${LIST}`) : same, [[LIST, 6000]], [LIST]],
  // a file over the size refused, and any failure apart from the load (a GPU error, a tour that
  // could not be read): one rule (r48 A1, Q1, Q2)
  oversize: (r, s) => apart(s, O),
  failApart: (r, s) => apart(s, G),
  // the GPU recovery's end: back to what is shown (idle with nothing), "recovered on …" told; a
  // load begun meanwhile owns the state, and is told too (r48 A7, r49 Q1)
  // (and the page's error that an earlier recovery's "cannot hold" made: ended, the model held now --
  // r51 A2, Q3 b)
  recovered: (r, s) => (s.status !== 'recovering' && !(s.status === 'error' && s.gpuLacks === s.msg)) ? [same, same, [[REC, 4000]], [REC]]
    : (s.shows ? ['ready', s.ready, [[REC, 4000]], [`ready · ${REC}`]] : ['idle', idleOf(s), [[REC, 4000]], [`${idleOf(s)} · ${REC}`]]),
  // the GPU recovery's start: 'recovering' -- but under a load, which keeps its state, its card and
  // its question, told (r49 Q1: a loss under "convert it?" hid the question and the load hung)
  // (not within a recovery: recoverRenderer keeps a second loss for after the first)
  // (an error up kept too: the card lost a failed ?src's 404 through recovering, then idle -- r50 A3, Q4)
  recoveryStarts: (r, s) => s.status === 'recovering' ? null : (busyRun(s) || s.status === 'error') ? [same, same, [[LOST, 6000]], [LOST]]
    : ['recovering', LOST, [], [LOST]],
  // a model list that could not be read, with nothing in it to open: a failure apart from the load,
  // by failApart's one rule (r49 A2: its own rule put it on the card and in the note at once, and
  // kept a failed load's error where a tour's replaced it)
  // (its own answer ends a read for a named model: the page's error then, not told -- r52)
  listFails: (r, s) => apart({ ...s, readingList: false }, LIST),
  // Export: its progress and its end told; the line written only while ready; the state kept
  exportMesh: (r, s) => (s.shows !== 'model' || r === 'exporting') ? null
    : [same, s.status === 'ready' ? `ready · ${SAVED}` : same, [[GOING, 4000], [SAVED, 3000]], [GOING, SAVED]],
};
await test('the note contract: each page state against each writer of a note or the line, every cell main.js\'s own code (r47)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const cutIf = (head) => { const at = src.indexOf(head); return at < 0 ? '' : src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const line = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n', at) + 1); };
  const pc = src.indexOf("$('pcancel').onclick = () => {"), pcBody = src.slice(src.indexOf('{', pc) + 1, src.indexOf('\n  };', pc));
  const body = line('let saySeq = 0') + ['function announce(text) {', 'function sayNow(text) {', 'function tell(text, ms = 1500, said = text) {',
    'function tellReady(words, ms = 6000) {', 'function setStatus(s, msg) {', 'function readyText() {', 'function sayNoFacts(text) {',
    'function openFile(f', 'async function exportMesh(fmt) {', 'function failApart(msg) {', 'function recovered() {', 'function showEmpty() {',
    'function recoveryStarts(why) {', 'function listsRead(r, openFirst) {', 'function cannotHold() {', 'function refusedForSize(f) {',
    'function rewriteReady(change) {'].map(cutIf).join('')
    + line('const listNote = ') + line('const posterUp = ')
    + ['const shownLacksGpu = ', 'const POSTER_MSG = ', 'const idleText = ', 'const oversizeText = '].map((h) => (src.includes(h) ? line(h) : '')).join('')
    + (src.includes('function somethingShown() {') ? line('function somethingShown() {') : '') + `function cancelLoad() {${pcBody}\n}\n`;
  const failed = [];
  for (const [row, s] of Object.entries(NOTE_STATES)) {
    for (const [col, want] of Object.entries(NOTE_CONTRACT)) {
      const cell = want(row, s);
      if (!cell) continue;
      const app = { status: s.status, statusMsg: s.msg, mesh: s.shows === 'model' ? {} : null, dxf: s.shows === 'drawing' ? { drawing: { units: 'mm' } } : null,
        header: s.shows === 'model' ? { meshes: [{}] } : null, baseMesh: {}, hidden: new Set(), cam: { orient: 'z' }, sourceName: 'm.stl',
        unmeshedFaces: 0, listNote: '', noFacts: null, backend: 'webgl2', embed: !!(s.poster || s.embed), readingList: !!s.readingList, error: 'too big' };
      if (s.gpuLacks) app.gpuLacks = { mesh: app.mesh, msg: s.gpuLacks };
      const shown = [], heard = [], frames = [];
      const live = { set textContent(t) { if (t) heard.push(t); this.t = t; }, get textContent() { return this.t || ''; } };
      const el = () => ({ textContent: '', title: '', dataset: {}, hidden: false, before() {} });
      const dom = { status: el(), progress: el(), announce: live, empty: el(), emptyerr: el(), poster: { hidden: !s.poster } };
      // (an embed's card asks the document for its parts: the poster row is an embed)
      const doc = { querySelector: () => el(), createElement: () => el(), documentElement: { classList: { add() {} } } };
      const run = new Function('app', '$', 'flashHover', 'PROGRESS_STATES', 'requestAnimationFrame', 'fmtInt', 'IDLE_MSG', 'MAX_FILE_BYTES',
        'startLoad', 'beginLoad', 'EXPORTS', 'exportable', 'meshLabel', 'saveBase', 'exportBasis', 'downloadBlob', 'document', 'location',
        `${body}; return { tell, tellReady, sayNoFacts, setStatus, openFile, exportMesh, cancelLoad, failApart, recovered, recoveryStarts, listsRead, cannotHold };`)(
        app, (id) => dom[id], (t, ms) => shown.push([t, ms]), new Set(['loading', 'tessellating']), (f) => frames.push(f), (n) => String(n), 'IDLE', 2 * 2 ** 30,
        () => {}, () => {}, { stl: { write: async () => new Uint8Array(4), type: 'model/stl', up: 'z' } }, (m, ids) => ids, () => 'B', () => 'm', () => [1, 0, 0, 0, 1, 0, 0, 0, 1], () => {},
        doc, { href: 'https://example.test/?embed=1' });
      const act = { tell: () => run.tell('copied', 3000), tellReady: () => run.tellReady(W), sayNoFacts: () => run.sayNoFacts(N), loadFails: () => run.setStatus('error', E),
        cancel: () => run.cancelLoad(), oversize: () => run.openFile({ name: 'big.stl', size: 3e9 }), failApart: () => run.failApart(G), recovered: () => run.recovered(),
        recoveryStarts: () => run.recoveryStarts('device lost'), listFails: () => run.listsRead({ errors: [{ url: 'l.json', message: 'HTTP 404' }], entries: [] }, false),
        cannotHold: () => run.cannotHold(), listPartial: () => run.listsRead({ errors: [{ url: 'l.json', message: 'HTTP 404' }], entries: [{ url: 'a.stl' }] }, false),
        exportMesh: () => run.exportMesh('stl') }[col];
      // (each read-out flushed apart, as a page's later tasks are; the card as the last setStatus left it)
      await act(); await new Promise((res) => setTimeout(res, 5));
      const [st, msg, sh, hd] = cell;
      const stAfter = st === same ? s.status : st, msgAfter = msg === same ? s.msg : msg;
      const wroteStatus = app.status !== s.status || app.statusMsg !== s.msg;
      // (hidden too while a list is read for a model it names, and behind an embed's poster)
      // (a list's own answer ends the read: listsRead)
      const reading = s.readingList && !['listFails', 'listPartial'].includes(col);
      const cardWant = !s.shows && !reading && !s.poster && !['loading', 'tessellating', 'recovering', 'init'].includes(stAfter);
      const card = wroteStatus ? [!dom.empty.hidden, dom.emptyerr.hidden ? '' : dom.emptyerr.textContent] : [cardWant, stAfter === 'error' ? msgAfter : ''];
      const got = [app.status, app.statusMsg, shown, heard, card];
      const exp = [stAfter, msgAfter, sh, hd, [cardWant, stAfter === 'error' ? msgAfter : '']];
      try { assert.deepEqual(got, exp); } catch { failed.push(`${row} × ${col}: got ${JSON.stringify(got)}, want ${JSON.stringify(exp)}`); }
    }
  }
  assert.deepEqual(failed, [], `cells failing: ${failed.length}\n${failed.join('\n')}`);
  // (the same failure apart from the load twice, nothing shown: heard both times -- the second
  // refusal of a file dropped again was neither shown nor heard: r48 Q10)
  {
    const app = { status: 'idle', statusMsg: 'IDLE', mesh: null, dxf: null, embed: false };
    const heard = [];
    const live = { set textContent(t) { if (t) heard.push(t); this.t = t; }, get textContent() { return this.t || ''; } };
    const el = () => ({ textContent: '', title: '', dataset: {}, hidden: false });
    const dom = { status: el(), progress: el(), announce: live, empty: el(), emptyerr: el(), poster: { hidden: true } };
    const frames = [];
    const { failApart } = new Function('app', '$', 'flashHover', 'PROGRESS_STATES', 'requestAnimationFrame', 'fmtInt', 'IDLE_MSG',
      `${body}; return { failApart };`)(app, (id) => dom[id], () => {}, new Set(['loading', 'tessellating']), (f) => frames.push(f), (n) => String(n), 'IDLE');
    failApart(O); await new Promise((res) => setTimeout(res, 5));
    failApart(O); await new Promise((res) => setTimeout(res, 5)); for (const f of frames.splice(0)) f();
    assert.deepEqual(heard, [O, O], 'the second refusal heard too');
  }
  // (in sequence: the recovery's "cannot hold" end under a load, then Cancel -- the old model shown
  // and not drawn, said as such, not "ready" over an empty view: r50 Q2)
  {
    const app = { status: 'loading', statusMsg: 'big.step is 300 MB: convert it?', mesh: {}, dxf: null, embed: false, backend: 'webgl2', error: 'too big', unmeshedFaces: 0, listNote: '', noFacts: null };
    const heard = [];
    const live = { set textContent(t) { if (t) heard.push(t); this.t = t; }, get textContent() { return this.t || ''; } };
    const el = () => ({ textContent: '', title: '', dataset: {}, hidden: false, before() {} });
    const dom = { status: el(), progress: el(), announce: live, empty: el(), emptyerr: el(), poster: { hidden: true } };
    const { cannotHold, cancelLoad } = new Function('app', '$', 'flashHover', 'PROGRESS_STATES', 'requestAnimationFrame', 'fmtInt', 'IDLE_MSG', 'beginLoad',
      `${body}; return { cannotHold, cancelLoad };`)(app, (id) => dom[id], () => {}, new Set(['loading', 'tessellating']), () => {}, (n) => String(n), 'IDLE', () => {});
    cannotHold();
    assert.equal(app.status, 'loading', 'the question kept');
    cancelLoad(); await new Promise((res) => setTimeout(res, 5));
    assert.deepEqual([app.status, app.statusMsg], ['error', CH]);
  }
  // (the "cannot hold" note over its life, in sequence through main.js's own code: r51 A1, A2, Q3, Q6 --
  // each cell above starts from a note the row seeds, so a note never set, never ended, or matched to
  // a drawing passed every test)
  const seq = (start) => {
    const app = { dxf: null, embed: false, backend: 'webgl2', error: 'too big', unmeshedFaces: 0, listNote: '', noFacts: null, hidden: new Set(), cam: { orient: 'z' }, ...start };
    const el = () => ({ textContent: '', title: '', dataset: {}, hidden: false, before() {} });
    const dom = { status: el(), progress: el(), announce: el(), empty: el(), emptyerr: el(), poster: { hidden: true } };
    return [app, new Function('app', '$', 'flashHover', 'PROGRESS_STATES', 'requestAnimationFrame', 'fmtInt', 'IDLE_MSG', 'beginLoad',
      `${body}; return { cannotHold, cancelLoad, recovered, recoveryStarts, setStatus, readyText };`)(app, (id) => dom[id], () => {}, new Set(['loading', 'tessellating']), () => {}, (n) => String(n), 'IDLE', () => {})];
  };
  {
    // (A1: "cannot hold" with no load running, then a load, then Cancel: "ready" over a model not drawn)
    const [app, f] = seq({ status: 'ready', statusMsg: 'ready', mesh: {} });
    f.cannotHold(); f.setStatus('loading', 'reading b.step'); f.cancelLoad();
    assert.deepEqual([app.status, app.statusMsg], ['error', CH], 'cannot hold, a load, Cancel');
  }
  {
    // (A2, Q3 a: under a load, "cannot hold", then a recovery that holds the model, then Cancel: the error over a drawn model)
    const [app, f] = seq({ status: 'loading', statusMsg: 'reading b.step', mesh: {} });
    f.cannotHold(); f.recoveryStarts('again'); f.recovered(); f.cancelLoad();
    assert.deepEqual([app.status, app.statusMsg], ['ready', 'ready'], 'cannot hold under a load, a good recovery, Cancel');
  }
  {
    // (A2, Q3 b: no load, "cannot hold", a second loss, a recovery that holds it: the page stayed 'error')
    const [app, f] = seq({ status: 'ready', statusMsg: 'ready', mesh: {} });
    f.cannotHold(); f.recoveryStarts('again'); f.recovered();
    assert.deepEqual([app.status, app.statusMsg], ['ready', 'ready'], 'cannot hold, a good recovery');
  }
  {
    // (Q3 c: the note of no model, a drawing shown after, Cancel over it: "cannot hold this model" over a drawing)
    const [app, f] = seq({ status: 'loading', statusMsg: 'reading b.step', mesh: null });
    f.cannotHold(); app.dxf = { drawing: { units: 'mm' } }; f.cancelLoad();
    assert.deepEqual([app.status, app.statusMsg], ['ready', f.readyText()], 'cannot hold of no model, a drawing, Cancel');
  }
  {
    // (the note of the model before, another model shown since, Cancel of the next load: ready -- the
    // note is the model's, not the page's)
    const [app, f] = seq({ status: 'loading', statusMsg: 'reading b.step', mesh: {} });
    f.cannotHold(); app.mesh = {}; f.setStatus('ready', 'ready'); f.setStatus('loading', 'reading c.step'); f.cancelLoad();
    assert.deepEqual([app.status, app.statusMsg], ['ready', 'ready'], 'cannot hold of another model, Cancel');
  }
});

await test('a file\'s companions reach its reader whatever is picked, refused or unzipped meanwhile (r52 A1, Q2)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const cut = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const line = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n', at) + 1); };
  const tick = () => new Promise((res) => setTimeout(res, 1));
  const run = (unzipWait) => {
    const app = { loadSeq: 0, status: 'ready', mesh: {}, dxf: null, embed: false };
    const read = [];
    let release = null;
    const held = new Promise((res) => { release = res; });
    const f = new Function('app', 'MAX_FILE_BYTES', 'isCompanion', 'announce', 'failApart', 'posterUp', 'startLoad', 'setStatus', 'showProgress', 'mb',
      'stale', 'loadAny', 'meshReaders', 'nextPaint', 'formatOfName', 'OPENS',
      `${line('const companionsOf = ')}${cut('function pickModelFile(files) {')}${cut('function refusedForSize(f) {')}${line('const oversizeText = ')}`
      + `${cut('function openFile(f) {')}${cut('async function loadFile(file, extras')}${cut('function beginLoad() {')}${cut('async function loadZip(buf, name, seq) {')}`
      + '; return { pickModelFile, openFile, loadZip, beginLoad };')(
      app, 2 * 2 ** 30, isCompanion, () => {}, () => {}, () => false, (fn) => fn(), () => {}, () => {}, () => '0',
      (seq) => seq !== app.loadSeq,
      // (the reader: what it is handed, after the awaits a real one makes)
      async (buf, name, seq, extras = []) => { await tick(); read.push([name, extras.map((x) => x.name)]); },
      async () => { if (unzipWait) await held; return { unzip: async () => ({ names: ['m.stl', 'other.mtl'], get: async () => new ArrayBuffer(4) }) }; },
      async () => {}, formatOfName, 'OPENS');
    return { f, read, release, app };
  };
  const file = (name, size = 10) => ({ name, size, arrayBuffer: async () => { await tick(); return new ArrayBuffer(4); } });
  const $ = () => ({ hidden: false });
  globalThis.$ = $;
  // (a) an .obj with its .mtl, then a drop of a file over the size, refused, while the .obj reads
  {
    const { f, read } = run(false);
    f.openFile(f.pickModelFile([file('x.obj'), file('x.mtl')]));
    f.openFile(f.pickModelFile([file('huge.stl', 3e9)]));
    for (let i = 0; i < 10; i++) await tick();
    assert.deepEqual(read, [['x.obj', ['x.mtl']]], 'a refused pick meanwhile');
  }
  // (c) a zip superseded while its reader is fetched, then an .obj with its .mtl
  {
    const { f, read, release, app } = run(true);
    const zipSeq = f.beginLoad();
    const z = f.loadZip(new ArrayBuffer(4), 'a.zip', zipSeq);
    f.openFile(f.pickModelFile([file('x.obj'), file('x.mtl')]));
    await tick(); release(); await z;
    for (let i = 0; i < 10; i++) await tick();
    assert.deepEqual(read, [['x.obj', ['x.mtl']]], 'a superseded zip meanwhile');
    assert.ok(app.loadSeq >= 2);
  }
  delete globalThis.$;
});

// The start-up contract (r51): main()'s start-up from the address -- ?src=, ?list= with ?model= /
// ?index=, ?tour=, ?add=, an embed and its poster -- with a file picked or dropped while the GPU
// starts, and Add model…, each run on main.js's own code (startFromUrl, viewIn3D, earlyPick,
// addPicked and every function they reach), the network and the load itself the only stand-ins.
// Round 50's highs were here, held by source arms, and its first fix stopped the page at
// "starting GPU" where no node test ran (r50 Q1).
//
// A case: the address, what the server answers (a path -> a body; else 404), the loads that fail, a
// file picked while the GPU starts (early), one the visitor opens while the start-up reads or loads
// something (during), one added after (add), and View in 3D pressed (click). Wanted: the final status
// and line, the card [shown, its error], what is told (shown in the view's note line and read out),
// the models opened in order (with the companions a file's load took), and whether the tour plays.
const SITE = 'https://site.example/v/';
const LISTED = JSON.stringify({ 'a.stl': 'A', 'b.stl': 'B' });
const TOUR = (model) => JSON.stringify({ cadtour: 1, ...(model ? { model } : {}), steps: [{ title: 'one' }] });
const A404 = 'could not download a.stl: not found (404)';
const L404 = `model list ${SITE}l.json: not found (404)`, LNONE = 'the model list names no models';
const T404 = `the tour not found (404): ${SITE}t.json`;
const READY_T = 'the tour is ready: open its 3D model';
const BIG = { name: 'big.stl', size: 3e9 }, BIGO = 'big.stl is over 2 GB, more than this viewer opens';
const POSTER = 'View in 3D loads the model';
const START_CASES = {
  'nothing asked': { q: '', want: ['idle', 'IDLE', [true, ''], [], [], false] },
  '?src=': { q: 'src=a.stl', want: ['ready', 'ready', [false, ''], [], ['a.stl'], false] },
  '?src= that fails': { q: 'src=a.stl', fails: ['a.stl'], want: ['error', A404, [true, A404], [], ['a.stl'], false] },
  '?list=': { q: 'list=l.json', serve: { 'l.json': LISTED }, want: ['ready', 'ready', [false, ''], [], ['a.stl'], false] },
  '?list= unread': { q: 'list=l.json', want: ['error', L404, [true, L404], [], [], false] },
  '?list= empty': { q: 'list=l.json', serve: { 'l.json': '{}' }, want: ['error', LNONE, [true, LNONE], [], [], false] },
  '?list= + ?index=': { q: 'list=l.json&index=2', serve: { 'l.json': LISTED }, want: ['ready', 'ready', [false, ''], [], ['b.stl'], false] },
  // (r50 Q1: "reading the model list…" for good, the card empty)
  '?list= unread + ?index=': { q: 'list=l.json&index=2', want: ['error', L404, [true, L404], [], [], false] },
  '?list= + ?index= it lacks': { q: 'list=l.json&index=9', serve: { 'l.json': LISTED },
    want: ['ready', 'ready', [false, ''], ['the model list has no model 9: its first opens'], ['a.stl'], false] },
  '?list= + an absolute ?src=': { q: `list=l.json&src=${encodeURIComponent('https://x.example/c.stl')}`, serve: { 'l.json': LISTED },
    want: ['ready', 'ready', [false, ''], [], ['c.stl'], false] },
  '?tour= with its model': { q: 'tour=t.json', serve: { 't.json': TOUR('a.stl') }, want: ['ready', 'ready', [false, ''], [], ['a.stl'], true] },
  '?tour= unread': { q: 'tour=t.json', want: ['error', T404, [true, T404], [], [], false] },
  // (the line left at "reading the tour…" once it was read: r51)
  '?tour= with no model': { q: 'tour=t.json', serve: { 't.json': TOUR() }, want: ['idle', 'IDLE', [true, ''], [`${READY_T} (IDLE)`], [], false] },
  // (r49 Q5: its own model's error stands, the tour not told over it)
  '?tour= whose model fails': { q: 'tour=t.json', serve: { 't.json': TOUR('a.stl') }, fails: ['a.stl'], want: ['error', A404, [true, A404], [], ['a.stl'], false] },
  '?tour= with no model + ?list=': { q: 'list=l.json&tour=t.json', serve: { 'l.json': LISTED, 't.json': TOUR() },
    want: ['ready', 'ready', [false, ''], [], ['a.stl'], true] },
  // (r50 A5: told over a list's failure)
  '?tour= with no model + ?list= unread': { q: 'list=l.json&tour=t.json', serve: { 't.json': TOUR() },
    want: ['error', L404, [true, L404], [`${READY_T} (IDLE)`], [], false] },
  // (r51 Q4: held back after any error while the tour names a model -- here a ?src='s, the tour's own
  // model never opened -- the tour never told)
  '?src= that fails + ?tour= with its model': { q: 'src=a.stl&tour=t.json', serve: { 't.json': TOUR('a.stl') }, fails: ['a.stl'],
    want: ['error', A404, [true, A404], [`${READY_T} (IDLE)`], ['a.stl'], false] },
  '?src= + ?tour= with no model': { q: 'src=a.stl&tour=t.json', serve: { 't.json': TOUR() }, want: ['ready', 'ready', [false, ''], [], ['a.stl'], true] },
  '?src= + ?tour= unread': { q: 'src=a.stl&tour=t.json', want: ['ready', `ready · ${T404}`, [false, ''], [T404], ['a.stl'], false] },
  '?src= + ?add=': { q: 'src=a.stl&add=b.stl', want: ['ready', 'ready', [false, ''], [], ['a.stl', 'b.stl'], false] },
  'an embed\'s ?src=': { q: 'embed=1&src=a.stl', want: ['ready', 'ready', [false, ''], [], ['a.stl'], false] },
  'an embed\'s ?src= that fails': { q: 'embed=1&src=a.stl', fails: ['a.stl'], want: ['error', A404, [true, A404], [], ['a.stl'], false] },
  'an embed\'s ?tour= with no model': { q: 'embed=1&tour=t.json', serve: { 't.json': TOUR() },
    want: ['idle', 'no model to show', [true, ''], [READY_T], [], false] },
  'an embed\'s poster': { q: 'embed=1&src=a.stl&poster=p.png', want: ['idle', POSTER, [false, ''], [], [], false] },
  'an embed\'s poster, View in 3D': { q: 'embed=1&src=a.stl&poster=p.png', click: true, want: ['ready', 'ready', [false, ''], [], ['a.stl'], false] },
  'an embed\'s poster, View in 3D, the model fails': { q: 'embed=1&src=a.stl&poster=p.png', click: true, fails: ['a.stl'],
    want: ['error', A404, [true, A404], [], ['a.stl'], false] },
  // (r51 A5: every ?add= dropped behind the poster)
  'an embed\'s poster + ?add=, View in 3D': { q: 'embed=1&src=a.stl&poster=p.png&add=b.stl', click: true,
    want: ['ready', 'ready', [false, ''], [], ['a.stl', 'b.stl'], false] },
  // (r50 Q3: told "open its 3D model" in an embed, and never played)
  'an embed\'s poster + ?tour=': { q: 'embed=1&src=a.stl&poster=p.png&tour=t.json', serve: { 't.json': TOUR() }, want: ['idle', POSTER, [false, ''], [], [], false] },
  'an embed\'s poster + ?tour=, View in 3D': { q: 'embed=1&src=a.stl&poster=p.png&tour=t.json', serve: { 't.json': TOUR() }, click: true,
    want: ['ready', 'ready', [false, ''], [], ['a.stl'], true] },
  // (r50 Q5: failApart behind the poster, the card hidden by it)
  'an embed\'s poster + ?tour= unread': { q: 'embed=1&src=a.stl&poster=p.png&tour=t.json', want: ['idle', POSTER, [false, ''], [T404], [], false] },
  // (r51 Q7: "its first opens" said behind the poster, where nothing opens until View in 3D)
  'an embed\'s poster + ?list= + a ?model= it lacks': { q: 'embed=1&list=l.json&model=nope&poster=p.png', serve: { 'l.json': LISTED },
    want: ['idle', POSTER, [false, ''], ['the model list has no model "nope": View in 3D opens its first'], [], false] },
  'a file picked while the GPU starts': { q: '', early: [{ name: 'e.stl', size: 10 }], want: ['ready', 'ready', [false, ''], [], ['e.stl'], false] },
  // (r50 A2: the first file taken, the .mtl opened)
  'an .obj and its .mtl picked while the GPU starts': { q: '', early: [{ name: 'x.mtl', size: 10 }, { name: 'x.obj', size: 10 }],
    want: ['ready', 'ready', [false, ''], [], ['x.obj+x.mtl'], false] },
  'a file over the size picked while the GPU starts': { q: '', early: [BIG], want: ['error', BIGO, [true, BIGO], [], [], false] },
  // (r51 A11: the visitor's file, the newest ask, opened first -- ?src= opened, then the file over it)
  'a file picked while the GPU starts + ?src=': { q: 'src=a.stl', early: [{ name: 'e.stl', size: 10 }], want: ['ready', 'ready', [false, ''], [], ['e.stl'], false] },
  'a file picked while the GPU starts + ?list=': { q: 'list=l.json', serve: { 'l.json': LISTED }, early: [{ name: 'e.stl', size: 10 }],
    want: ['ready', 'ready', [false, ''], [], ['e.stl'], false] },
  // (r51 A3, Q2: the .mtl lost -- ?src's load emptied the companions the early pick left in a global)
  'an .obj and its .mtl picked while the GPU starts + ?src=': { q: 'src=a.stl', early: [{ name: 'x.mtl', size: 10 }, { name: 'x.obj', size: 10 }],
    want: ['ready', 'ready', [false, ''], [], ['x.obj+x.mtl'], false] },
  // (r51 A11: the early file's line replaced, it waited behind the list read, and the list's model
  // started and was cancelled)
  'a file picked while the GPU starts + ?list= + ?index=': { q: 'list=l.json&index=2', serve: { 'l.json': LISTED }, early: [{ name: 'e.stl', size: 10 }],
    want: ['ready', 'ready', [false, ''], [], ['e.stl'], false] },
  // (r51 A4, Q1: a start-up load over a file the visitor opened meanwhile -- the list's named model,
  // the next ?add=)
  'a file opened while the list is read, + ?index=': { q: 'list=l.json&index=2', serve: { 'l.json': LISTED }, during: { at: 'l.json', file: 'v.stl' },
    want: ['ready', 'ready', [false, ''], [], ['v.stl'], false] },
  'a file opened while the list is read': { q: 'list=l.json', serve: { 'l.json': LISTED }, during: { at: 'l.json', file: 'v.stl' },
    want: ['ready', 'ready', [false, ''], [], ['v.stl'], false] },
  'a file opened while an ?add= loads': { q: 'src=a.stl&add=b.stl&add=c.stl', during: { at: 'b.stl', file: 'v.stl' },
    want: ['ready', 'ready', [false, ''], [], ['a.stl', 'b.stl', 'v.stl'], false] },
  // (r52 A3, Q3: a file over the size picked while the GPU starts is the visitor's ask too -- the
  // address's model opened over the refusal, which was painted nowhere)
  'a file over the size picked while the GPU starts + ?src=': { q: 'src=a.stl', early: [BIG], want: ['error', BIGO, [true, BIGO], [], [], false] },
  'a file over the size picked while the GPU starts + ?list=': { q: 'list=l.json', serve: { 'l.json': LISTED }, early: [BIG],
    want: ['error', BIGO, [true, BIGO], [], [], false] },
  'a file over the size picked while the GPU starts + ?list= + ?index=': { q: 'list=l.json&index=2', serve: { 'l.json': LISTED }, early: [BIG],
    want: ['error', BIGO, [true, BIGO], [], [], false] },
  // (r52 A2, Q1: a tour made for its own model played over the visitor's file, or told "open its 3D
  // model" over the file they were opening)
  'a file picked while the GPU starts + ?tour= with its model': { q: 'tour=t.json', serve: { 't.json': TOUR('a.stl') }, early: [{ name: 'e.stl', size: 10 }],
    want: ['ready', 'ready', [false, ''], [], ['e.stl'], false] },
  'a file opened while the tour (its own model) is read': { q: 'tour=t.json', serve: { 't.json': TOUR('a.stl') }, during: { at: 't.json', file: 'v.stl' },
    want: ['ready', 'ready', [false, ''], [], ['v.stl'], false] },
  'a file opened while the tour\'s own model loads': { q: 'tour=t.json', serve: { 't.json': TOUR('a.stl') }, during: { at: 'a.stl', file: 'v.stl' },
    want: ['ready', 'ready', [false, ''], [], ['a.stl', 'v.stl'], false] },
  // (r52 Q4: a tour with no model plays over the visitor's file, the list's first not opened over it)
  'a file opened while ?list= + ?tour= with no model are read': { q: 'list=l.json&tour=t.json', serve: { 'l.json': LISTED, 't.json': TOUR() },
    during: { at: 'l.json', file: 'v.stl' }, want: ['ready', 'ready', [false, ''], [], ['v.stl'], true] },
  // (the same with the visitor's file still loading when the tour has been read: the list's first not
  // opened over it, which cancelled it; the tour, told ready, has no model to play over yet)
  'a slow file opened while ?list= + ?tour= with no model are read': { q: 'list=l.json&tour=t.json', serve: { 'l.json': LISTED, 't.json': TOUR() },
    during: { at: 'l.json', file: 'v.stl' }, slow: ['v.stl'], want: ['ready', 'ready', [false, ''], [`${READY_T} (IDLE)`], ['v.stl'], false] },
  // (r52 Q4: every ?add= after the first, and a #view= that waits for them, applied once, the wait ended)
  '?src= + two ?add=s + #view=': { q: 'src=a.stl&add=b.stl&add=c.stl', hash: '#view=v', views: 1,
    want: ['ready', 'ready', [false, ''], [], ['a.stl', 'b.stl', 'c.stl'], false] },
  'an embed\'s poster + two ?add=s + #view=, View in 3D': { q: 'embed=1&src=a.stl&poster=p.png&add=b.stl&add=c.stl', hash: '#view=v', views: 1, click: true,
    want: ['ready', 'ready', [false, ''], [], ['a.stl', 'b.stl', 'c.stl'], false] },
  // (r52 Q6: a file dropped on an embed's poster opened under it, the poster left up)
  'a file dropped on an embed\'s poster': { q: 'embed=1&src=a.stl&poster=p.png', drop: 'd.stl', posterGone: true,
    want: ['ready', 'ready', [false, ''], [], ['d.stl'], false] },
  // (r53 Q2: a ?list= embed with a poster opened its first model at once, poster or not)
  'an embed\'s poster + ?list=': { q: 'embed=1&list=l.json&poster=p.png', serve: { 'l.json': LISTED }, want: ['idle', POSTER, [false, ''], [], [], false] },
  'an embed\'s poster + ?list=, View in 3D': { q: 'embed=1&list=l.json&poster=p.png', serve: { 'l.json': LISTED }, click: true,
    want: ['ready', 'ready', [false, ''], [], ['a.stl'], false] },
  // (r54 A1, Q3: View in 3D pressed while the list is read, then a file opened: the visitor's, the
  // list's first not opened over it)
  'View in 3D pressed while an embed\'s ?list= is read, then a file opened': { q: 'embed=1&list=l.json&poster=p.png', serve: { 'l.json': LISTED },
    during: [{ at: 'l.json', click: true }, { at: 'l.json', file: 'v.stl' }], want: ['ready', 'ready', [false, ''], [], ['v.stl'], false] },
  // (r54 A4: an empty ?model= names nothing -- early.js read it as named and fetched the list's first,
  // which nothing opened: the tour's own model is the first)
  '?list= + an empty ?model= + ?tour= with its model': { q: 'list=l.json&model=&tour=t.json', serve: { 'l.json': LISTED, 't.json': TOUR('c.stl') },
    want: ['ready', 'ready', [false, ''], [], ['c.stl'], true] },
  // (r56 A1: a tour that answered from elsewhere names its model from there, as a list does)
  '?tour= that redirects, with its model': { q: 'tour=latest/t.json', serve: { 'latest/t.json': TOUR('m.stl') }, redirect: { 'latest/t.json': 'v2/t.json' },
    urls: [`${SITE}v2/m.stl`], want: ['ready', 'ready', [false, ''], [], ['m.stl'], true] },
  // (r56 A2: the model the page first showed from its address, which Back means: the tour's own, not the list's first)
  '?list= + ?tour= with its model: the address\'s model': { q: 'list=l.json&tour=t.json', serve: { 'l.json': LISTED, 't.json': TOUR('c.stl') }, address: 'c.stl',
    want: ['ready', 'ready', [false, ''], [], ['c.stl'], true] },
  // (r56 Q1: a tour that failed did not stop the list's first opening)
  '?list= + ?tour= unread': { q: 'list=l.json&tour=t.json', serve: { 'l.json': LISTED }, address: 'a.stl',
    want: ['ready', `ready · ${T404}`, [false, ''], [T404], ['a.stl'], false] },
  // (r56 A6, Q9: a name the list lacks beside a tour with no model: "its first opens", said as it does)
  '?list= + a ?model= it lacks + ?tour= with no model': { q: 'list=l.json&model=nope&tour=t.json', serve: { 'l.json': LISTED, 't.json': TOUR() },
    want: ['ready', 'ready', [false, ''], ['the model list has no model "nope": its first opens'], ['a.stl'], true] },
  // (r56 A3, Q2: pressed while a tour alone with no model is read: the page as without a poster, as when read before)
  'View in 3D pressed while an embed\'s ?tour= with no model is read': { q: 'embed=1&tour=t.json&poster=p.png', serve: { 't.json': TOUR() },
    during: [{ at: 't.json', click: true }], want: ['idle', 'no model to show', [true, ''], [READY_T], [], false] },
  // (r56 Q5: a refusal during the tour's read behind the poster is told, and the tour's model opens)
  'View in 3D pressed while an embed\'s ?tour= with its model is read, then a file over the size refused': { q: 'embed=1&tour=t.json&poster=p.png', serve: { 't.json': TOUR('a.stl') },
    during: [{ at: 't.json', click: true }, { at: 't.json', file: 'big.stl', size: 3e9 }], want: ['ready', 'ready', [false, ''], [BIGO], ['a.stl'], true] },
  // (r56 Q6: View in 3D with a tour and no model to play over -- the ?src= failed -- says the tour is ready)
  'an embed\'s poster + a ?src= that fails + ?tour= with no model, View in 3D': { q: 'embed=1&src=a.stl&poster=p.png&tour=t.json', serve: { 't.json': TOUR() },
    fails: ['a.stl'], click: true, want: ['error', A404, [true, A404], [READY_T], ['a.stl'], false] },
  // (r56 Q7: Add model… during the tour's read adds to the address's model, which the tour then plays over)
  'Add model… while the tour is read, beside ?src=': { q: 'src=a.stl&tour=t.json', serve: { 't.json': TOUR('a.stl') }, slow: ['t.json'],
    during: [{ at: 'loaded a.stl', add: 'e.stl' }], want: ['ready', 'ready', [false, ''], [], ['a.stl', 'e.stl'], true] },
  // (r54 A7, Q5: pressed while the list is read, the card says it is read, then the list's first opens)
  'View in 3D pressed while an embed\'s ?list= is read': { q: 'embed=1&list=l.json&poster=p.png', serve: { 'l.json': LISTED },
    during: [{ at: 'l.json', click: true }], progress: 'reading the model list, no Cancel', want: ['ready', 'ready', [false, ''], [], ['a.stl'], false] },
  // (r55 Q8 M1: a file refused during that wait is told -- the card is the read's -- and is no load)
  'View in 3D pressed while an embed\'s ?list= is read, then a file over the size refused': { q: 'embed=1&list=l.json&poster=p.png', serve: { 'l.json': LISTED },
    during: [{ at: 'l.json', click: true }, { at: 'l.json', file: 'big.stl', size: 3e9 }], want: ['ready', 'ready', [false, ''], [BIGO], ['a.stl'], false] },
  // (r55 A1, Q1, Q5: with a ?src= the model opens at the press, beside the tour's read -- it waited for
  // the tour, then opened over the visitor's file; a tour with no model plays over the visitor's file,
  // as at start-up: one rule, r55 Q3)
  'View in 3D pressed while an embed\'s ?tour= is read (with ?src=), then a file opened': { q: 'embed=1&src=a.stl&poster=p.png&tour=t.json', serve: { 't.json': TOUR() },
    during: [{ at: 't.json', click: true }, { at: 't.json', file: 'v.stl' }], want: ['ready', 'ready', [false, ''], [], ['a.stl', 'v.stl'], true] },
  'View in 3D pressed while an embed\'s ?tour= with its model is read (with ?src=), then a file opened': { q: 'embed=1&src=a.stl&poster=p.png&tour=t.json', serve: { 't.json': TOUR('c.stl') },
    during: [{ at: 't.json', click: true }, { at: 't.json', file: 'v.stl' }], want: ['ready', 'ready', [false, ''], [], ['a.stl', 'v.stl'], false] },
  // (r55 A3, Q2: the two poster paths the tour does not play on end it, so a list model's own tour plays)
  'a file dropped on a ?list= + ?tour= embed\'s poster': { q: 'embed=1&list=l.json&tour=t.json&poster=p.png', serve: { 'l.json': LISTED, 't.json': TOUR() },
    drop: 'd.stl', posterGone: true, want: ['ready', 'ready', [false, ''], [], ['d.stl'], false] },
  'View in 3D pressed while ?list= + ?tour= are read, then a file opened': { q: 'embed=1&list=l.json&tour=t.json&poster=p.png', serve: { 'l.json': LISTED, 't.json': TOUR() },
    during: [{ at: 'l.json', click: true }, { at: 'l.json', file: 'v.stl' }], want: ['ready', 'ready', [false, ''], [], ['v.stl'], false] },
  // (r55 Q11: a poster with nothing behind it -- a tour alone, naming no model -- comes down as the
  // tour is read, the page as without one)
  'an embed\'s poster + ?tour= with no model': { q: 'embed=1&tour=t.json&poster=p.png', serve: { 't.json': TOUR() },
    want: ['idle', 'no model to show', [true, ''], [READY_T], [], false] },
  // (r55 Q8 M18: a tour that failed behind the poster, nothing else named: its words on the card after View in 3D)
  'an embed\'s poster + ?tour= unread, View in 3D': { q: 'embed=1&tour=t.json&poster=p.png', click: true,
    want: ['error', T404, [true, T404], [T404], [], false] },
  // (r55 A4: a name the list lacks, beside a tour with its own model: the tour's model, not the list's first)
  '?list= + a ?model= it lacks + ?tour= with its model': { q: 'list=l.json&model=nope&tour=t.json', serve: { 'l.json': LISTED, 't.json': TOUR('c.stl') },
    want: ['ready', 'ready', [false, ''], ['the model list has no model "nope"'], ['c.stl'], true] },
  // (r54 Q2: one order behind the poster as without it: ?src=, the tour's own model, the list's first)
  'an embed\'s poster + ?list= + ?tour= with its model, View in 3D': { q: 'embed=1&list=l.json&tour=t.json&poster=p.png', serve: { 'l.json': LISTED, 't.json': TOUR('c.stl') },
    click: true, want: ['ready', 'ready', [false, ''], [], ['c.stl'], true] },
  'an embed\'s poster + ?tour= with its model': { q: 'embed=1&tour=t.json&poster=p.png', serve: { 't.json': TOUR('a.stl') }, want: ['idle', POSTER, [false, ''], [], [], false] },
  'an embed\'s poster + ?tour= with its model, View in 3D': { q: 'embed=1&tour=t.json&poster=p.png', serve: { 't.json': TOUR('a.stl') }, click: true,
    want: ['ready', 'ready', [false, ''], [], ['a.stl'], true] },
  // (r54 Q4: a list that failed behind the poster: its words on the card after View in 3D, not "no model to show")
  'an embed\'s poster + ?list= unread, View in 3D': { q: 'embed=1&list=l.json&poster=p.png', click: true,
    want: ['error', L404, [true, L404], [L404], [], false] },
  // (r54 Q6: the wired button opens the list's named model behind the poster)
  'an embed\'s poster + ?list= + ?index=, View in 3D': { q: 'embed=1&list=l.json&index=2&poster=p.png', serve: { 'l.json': LISTED }, click: true,
    want: ['ready', 'ready', [false, ''], [], ['b.stl'], false] },
  // (r54 A5: a tour read given up after its time, said so -- it read "not there, or no CORS")
  '?tour= that gives no answer in time': { q: 'tour=t.json', serve: { 't.json': 'TIMEOUT' },
    want: ['error', `the tour gave no answer in time: ${SITE}t.json`, [true, `the tour gave no answer in time: ${SITE}t.json`], [], [], false] },
  '?tour= whose body gives no answer in time': { q: 'tour=t.json', serve: { 't.json': 'BODY-TIMEOUT' },
    want: ['error', `the tour gave no answer in time: ${SITE}t.json`, [true, `the tour gave no answer in time: ${SITE}t.json`], [], [], false] },
  // (r54 A6: a relative ?add= the list names is its entry, read against the list's URL -- it was read
  // against the page's, and 404'd)
  '?src= + a relative ?add= the list names': { q: `list=lists/l.json&src=${encodeURIComponent('https://x.example/c.stl')}&add=b.stl`, serve: { 'lists/l.json': LISTED },
    urls: ['https://x.example/c.stl', `${SITE}lists/b.stl`], want: ['ready', 'ready', [false, ''], [], ['c.stl', 'b.stl'], false] },
  // (r53 Q4: a file refused while the list is read for its model is told -- the card is hidden for
  // the read -- and is no load, so the list's model opens)
  'a file over the size refused while the list is read, + ?index=': { q: 'list=l.json&index=2', serve: { 'l.json': LISTED },
    during: { at: 'l.json', file: 'big.stl', size: 3e9 }, want: ['ready', 'ready', [false, ''], [BIGO], ['b.stl'], false] },
  // (r50 A1: an over-size file added cancelled the running load)
  'Add model… a file over the size': { q: 'src=a.stl', add: [BIG], want: ['ready', `ready · ${BIGO}`, [false, ''], [BIGO], ['a.stl'], false] },
  'Add model… a file': { q: 'src=a.stl', add: [{ name: 'e.stl', size: 10 }], want: ['ready', 'ready', [false, ''], [], ['a.stl', 'e.stl'], false] },
};
await test('the start-up contract: each address, embed, poster and early pick, main.js\'s own start-up code (r51)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const cutIf = (head) => { const at = src.indexOf(head); return at < 0 ? '' : src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const line = (head) => { const at = src.indexOf(head); return at < 0 ? '' : src.slice(at, src.indexOf('\n', at) + 1); };
  const arrow = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n};\n', at) + 4); };
  // (viewIn3D async since r53: cut with its keyword, else as it was)
  const body = line('let saySeq = 0') + [src.includes('async function viewIn3D(src) {') ? 'async function viewIn3D(src) {' : 'function viewIn3D(src) {',
    'async function startFromUrl(early) {', 'function addPicked(files) {',
    'async function readLists(lists, openFirst) {', 'function listsRead(r, openFirst) {', 'function loadListed(url) {', 'function startLoad(fn) {',
    'function guard(p, seq = null) {', 'function beginLoad() {', 'function stale(seq) {', 'function announce(text) {', 'function sayNow(text) {',
    'function tell(text, ms = 1500, said = text) {', 'function tellReady(words, ms = 6000) {', 'function setStatus(s, msg) {', 'function readyText() {',
    'function failApart(msg) {', 'function showEmpty() {', 'function openFile(f', 'function refusedForSize(f) {', 'function modelUrlIn(search) {',
    'async function readTour(url) {', 'function listEntry(src) {', 'function startAdd(fn) {', 'function pickModelFile(files) {',
    'function startUpLoad(url) {', 'function openStart(src) {', 'function rewriteReady(change) {', 'function tourOver() {', 'function tourReadyNote() {'].map(cutIf).join('')
    + line('const tourPlaysHere = ') + line('const addressModel = ')
    + line('const listNote = ') + line('const posterUp = ') + line('function somethingShown() {') + line('const isPlace = ') + line('const isRelative = ')
    + line('const autoTourKey = ') + line('const earlyPick = ') + line('const untouched = ') + line('const idleText = ')
    + line('const POSTER_MSG = ') + line('const oversizeText = ') + line('const companionsOf = ')
    // (one line since the rule went to js/model-list.js, r52; before it, the arrow function's lines)
    + (src.includes('modelNameFrom(search') ? line('const modelNameIn = ') : arrow('const modelNameIn = '))
    // (as the real ones: a URL brings no companions; a file takes those its pick kept for it, as
    // loadFile's own default does -- r52 A1, Q2: the stand-in took them from its argument, and a
    // global overwritten under the real load passed every case)
    + 'async function loadUrl(url) { return fakeLoad(url, { beginLoad, stale, setStatus, readyText }, [], false); }\n'
    + 'async function loadFile(f, extras = companionsOf.get(f) || []) { return fakeLoad(f.name, { beginLoad, stale, setStatus, readyText }, extras, true); }\n';
  const failed = [];
  for (const [name, c] of Object.entries(START_CASES)) {
    const params = new URLSearchParams(c.q);
    const app = { status: 'init', statusMsg: 'starting GPU', mesh: null, dxf: null, header: null, embed: params.get('embed') === '1', loadSeq: 0,
      listEntries: null, listNote: '', unmeshedFaces: 0, noFacts: null, hidden: new Set(), backend: 'webgl2', scene: null, cam: { orient: 'z' } };
    const shown = [], opened = [], frames = [];
    let tour = false, views = 0, released = 0, embedActive = false;
    const loadedUrls = [], progress = [];
    const el = () => ({ textContent: '', title: '', dataset: {}, hidden: false, before() {}, classList: { add() {}, remove() {} } });
    const dom = new Proxy({ poster: { hidden: true } }, { get: (o, k) => (k in o ? o[k] : (o[k] = el())) });
    const doc = { querySelector: () => el(), createElement: () => el(), documentElement: { classList: { add() {} } } };
    const serve = c.serve || {};
    const tick = () => new Promise((res) => setTimeout(res, 1));
    let run = null;
    // (the visitor opens a file of their own while the start-up reads or loads `at`: Open…, as wired)
    // (or presses View in 3D then, through the page's own wired button: r54 Q6, A1)
    const visit = (at) => {
      for (const d of [].concat(c.during || [])) {
        if (d.at === at) {
          setTimeout(() => (d.click ? dom.posterload.onclick() : d.add ? run.addPicked([{ name: d.add, size: 10 }]) : run.openFile({ name: d.file, size: d.size || 10 })), 0);
        }
      }
    };
    const fetchFake = async (u) => {
      const path = String(u).startsWith(SITE) ? String(u).slice(SITE.length) : String(u);
      visit(path);
      for (let i = 0; i < ((c.slow || []).includes(path) ? 30 : 3); i++) await tick();
      // (an answer that never comes in time: the fetch's own timeout)
      if (serve[path] === 'TIMEOUT') { const e = new Error('signal timed out'); e.name = 'TimeoutError'; throw e; }
      // (or the headers in time, the body not: the signal covers both -- r55 A5, Q7)
      if (serve[path] === 'BODY-TIMEOUT') {
        return new Response(new ReadableStream({ start(ctl) { ctl.error(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })); } }), { status: 200 });
      }
      if (!(path in serve)) return new Response('', { status: 404 });
      const res = new Response(serve[path], { status: 200 });
      // (an answer from elsewhere: a redirect's target, the URL that answered)
      if (c.redirect && c.redirect[path]) Object.defineProperty(res, 'url', { value: SITE + c.redirect[path] });
      return res;
    };
    // (the load itself: numbered, "loading", then the model shown -- or, added (startAdd), joined to
    // the scene, the first model's URL kept -- or its failure thrown for guard)
    const fakeLoad = async (url, k, extras, fromFile) => {
      const adding = !!app.startingAdd;
      loadedUrls.push(String(url));
      const seq = k.beginLoad();
      // (every load's card offers Cancel: r52 Q7)
      if (dom.pcancel.hidden) failed.push(`${name}: ${url} loaded with Cancel hidden`);
      const file = String(url).split('/').pop();
      opened.push(fromFile && extras.length ? [file, ...extras.map((x) => x.name)].join('+') : file);
      k.setStatus('loading', `downloading ${file}`);
      visit(file);
      for (let i = 0; i < ((c.slow || []).includes(file) ? 30 : 2); i++) await tick();
      if (k.stale(seq)) return;
      if ((c.fails || []).includes(file)) throw new Error(`could not download ${file}: not found (404)`);
      if (adding) app.scene.push({ url });
      else Object.assign(app, { header: { meshes: [{}] }, mesh: {}, scene: [{ url }], sourceUrl: url });
      k.setStatus('ready', k.readyText());
      visit(`loaded ${file}`); // (a visitor's act once the model is shown)
    };
    run = new Function('app', '$', 'flashHover', 'PROGRESS_STATES', 'requestAnimationFrame', 'fmtInt', 'IDLE_MSG', 'MAX_FILE_BYTES', 'params',
      'location', 'document', 'window', 'fetch', 'fetchModelLists', 'fillModelList', 'entryByName', 'fileUrl', 'readCapped', 'parseTour', 'MAX_TOUR_BYTES',
      'fetchFailedText', 'fakeLoad', 'startTourIn', 'syncModelList', 'showProgress', 'syncMenuButtons', 'setEmbedActive', 'applyView', 'decodeView',
      'orientOrNull', 'isCompanion', 'gaveUp', 'console', 'modelUrlFrom', 'modelNameFrom', 'earlyLists', 'posterAsked', 'timedFetch', 'releaseEarly',
      'isRelative', 'listedUrlFrom', 'isTimeout', 'answeredFrom',
      `${body}; return { startFromUrl, viewIn3D, addPicked, earlyPick, openFile };`)(
      app, (id) => dom[id], (t) => shown.push(t), new Set(['loading', 'tessellating']), (f) => frames.push(f), (n) => String(n), 'IDLE', 2 * 2 ** 30, params,
      { href: `${SITE}?${c.q}${c.hash || ''}`, hash: c.hash || '' }, doc, { addEventListener() {} }, fetchFake, fetchModelLists, (e) => { app.listEntries = e; }, entryByName, fileUrl,
      readCapped, parseTour, MAX_TOUR_BYTES, async () => 'could not be read', fakeLoad, () => { tour = true; }, () => {}, (t, f, d) => progress.push(`${d}${dom.pcancel.hidden ? ', no Cancel' : ''}`), () => {},
      (on) => { embedActive = on; },
      () => { views++; }, () => ({ view: 1 }), orientOrNull, isCompanion, null, { error() {} }, modelUrlFrom, modelNameFrom, () => null,
      posterAsked, fetchFake, () => { released++; return 0; }, isRelative, listedUrlFrom, isTimeout, answeredFrom);
    try {
      const early = c.early ? run.earlyPick(c.early) : null;
      await run.startFromUrl(early);
      for (let i = 0; i < 40; i++) await tick();
      // (the button as the page wired it: a wrong onclick passed while the table called viewIn3D itself -- r54 Q6)
      if (c.click) { await dom.posterload.onclick(); for (let i = 0; i < 40; i++) await tick(); }
      if (c.add) { run.addPicked(c.add); for (let i = 0; i < 10; i++) await tick(); }
      // (a file dropped on the page after the start: the wired drop's openFile)
      if (c.drop) { run.openFile({ name: c.drop, size: 10 }); for (let i = 0; i < 10; i++) await tick(); }
      for (const f of frames.splice(0)) f();
    } catch (e) { failed.push(`${name}: threw ${e.message}`); continue; }
    const got = [app.status, app.statusMsg, [!dom.empty.hidden, dom.emptyerr.hidden ? '' : dom.emptyerr.textContent], shown, opened, tour];
    try { assert.deepEqual(got, c.want); } catch { failed.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.want)}`); }
    // (a #view= applied once, after the adds it waits for, and the wait ended: r52 Q4)
    if (c.views !== undefined && (views !== c.views || app.addsPending)) failed.push(`${name}: views applied ${views}, addsPending ${app.addsPending}; want ${c.views}, false`);
    if (c.posterGone && !dom.poster.hidden) failed.push(`${name}: the poster still up over the model`);
    // (the poster taken down for a file is the embed made active, as View in 3D makes it: r55 Q8 M19;
    // and View in 3D's own press -- checked only for drops: r56 A4)
    if ((c.posterGone || c.click) && !embedActive) failed.push(`${name}: the embed not made active with the poster down`);
    // (the model the page as first opened shows, which Back to it and a #view= on it mean: r56 A2)
    if (c.address !== undefined && String(app.addressUrl || '').split('/').pop() !== c.address) failed.push(`${name}: the address's model ${app.addressUrl}, want ${c.address}`);
    // (the address's tour over by the end, played or not: a list model's own tour then plays -- r55 A3, Q2)
    // (a poster still up keeps it, for View in 3D)
    if (app.urlTourPending && dom.poster.hidden) failed.push(`${name}: the address's tour still pending at the end`);
    // (a card the case wants shown on the way: the read View in 3D waits for -- r54 A7, Q5)
    if (c.progress && !progress.includes(c.progress)) failed.push(`${name}: never showed "${c.progress}" (showed ${JSON.stringify(progress)})`);
    // (the URLs loaded, where a case names them: which file a relative address is)
    if (c.urls && JSON.stringify(loadedUrls) !== JSON.stringify(c.urls)) failed.push(`${name}: loaded ${JSON.stringify(loadedUrls)}, want ${JSON.stringify(c.urls)}`);
    // (every start lets its left-over early downloads go, once: r53 Q3, untested -- r54 Q7)
    if (released !== 1) failed.push(`${name}: early downloads released ${released} times, want once`);
  }
  if (failed.length) console.log(`start-up cases failing: ${failed.length}\n${failed.join('\n')}`);
  assert.deepEqual(failed, [], `start-up cases failing: ${failed.length}`);
});

test('a zip\'s companions for its model: its own folder\'s first, a same-named file elsewhere never in their place (r53 Q1)', () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const at = src.indexOf('function zipCompanions(files, model');
  const zip = new Function('isCompanion', `${src.slice(at, src.indexOf('\n}\n', at) + 2)}; return zipCompanions;`)(isCompanion);
  const opens = (n) => /\.(obj|gltf|stl)$/i.test(n);
  const zipCompanions = (files, model) => zip(files, model, opens).map((c) => `${c.path} as ${c.name}`);
  // (the red chair: red's .mtl, whichever order the zip lists them; blue's not unpacked for it)
  const red = ['blue/chair.obj', 'blue/chair.mtl', 'red/chair.obj', 'red/chair.mtl'];
  assert.deepEqual(zipCompanions(red, 'red/chair.obj'), ['red/chair.mtl as chair.mtl']);
  assert.deepEqual(zipCompanions([...red].reverse(), 'red/chair.obj'), ['red/chair.mtl as chair.mtl']);
  assert.deepEqual(zipCompanions(red, 'blue/chair.obj'), ['blue/chair.mtl as chair.mtl']);
  // (a buffer in a folder under the model's: named by its path there, another model's not taken --
  // the red glTF read blue's buffer: r54 Q1)
  const gl = ['red/chair.gltf', 'red/buffers/chair.bin', 'blue/chair.gltf', 'blue/buffers/chair.bin'];
  assert.deepEqual(zipCompanions(gl, 'red/chair.gltf'), ['red/buffers/chair.bin as buffers/chair.bin']);
  // (\ in a zip's names read as /: r54 A3)
  assert.deepEqual(zipCompanions(['red\\chair.obj', 'red\\chair.mtl', 'blue\\chair.obj', 'blue\\chair.mtl'], 'red\\chair.obj'), ['red\\chair.mtl as chair.mtl']);
  // (a shared folder beside the model's still serves, named by the way up to it)
  assert.deepEqual(zipCompanions(['m/a.obj', 'm/a.mtl', 'tex/wood.png', 'm/wood.png'], 'm/a.obj'), ['m/a.mtl as a.mtl', 'tex/wood.png as ../tex/wood.png', 'm/wood.png as wood.png']);
  assert.deepEqual(zipCompanions(['a.gltf', 'bin/a.bin'], 'a.gltf'), ['bin/a.bin as bin/a.bin']);
  // (folders without case: r55 Q4)
  assert.deepEqual(zipCompanions(['Red/chair.obj', 'red/chair.mtl', 'blue/chair.obj', 'blue/chair.mtl'], 'Red/chair.obj'), ['red/chair.mtl as chair.mtl']);
  // (<name>/source/ beside <name>/textures/: the other model's textures/ not this one's -- r55 Q6)
  assert.deepEqual(zipCompanions(['red/source/c.obj', 'red/source/c.mtl', 'red/textures/w.png', 'blue/source/c.obj', 'blue/textures/w.png'], 'red/source/c.obj'),
    ['red/source/c.mtl as c.mtl', 'red/textures/w.png as ../textures/w.png']);
  // (the companion's own folder named in another case than the model's: the way up compared without
  // case -- its path was lower-case already, and the arm could not fail: r56 Q8)
  assert.deepEqual(zipCompanions(['Red/Source/c.obj', 'RED/Textures/W.png'], 'Red/Source/c.obj'), ['RED/Textures/W.png as ../Textures/W.png'], 'the way up without case');
  // (a model under the first's folder: its folder is its own, and the first's files are not its)
  assert.deepEqual(zipCompanions(['a/x.obj', 'a/x.mtl', 'a/b/y.obj', 'a/b/y.mtl'], 'a/x.obj'), ['a/x.mtl as x.mtl']);
  assert.deepEqual(zipCompanions(['a/x.obj', 'a/x.mtl', 'a/b/y.obj', 'a/b/y.mtl'], 'a/b/y.obj'), ['a/b/y.mtl as y.mtl']);
});

await test('a mesh\'s companion files together are capped at the size a file may be, refused in words before the read (r54 Q8)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const at = src.indexOf('async function loadMeshFile(buf, name, seq');
  const read = [];
  const loadMeshFile = new Function('isGzip', 'unpackGz', 'meshReaders', 'stale', 'OPENS', 'setStatus', 'showProgress', 'mb', 'nextPaint', 'MAX_FILE_BYTES',
    'app', 'readUnit', 'addressUnit', 'meshFromSource', `${src.slice(at, src.indexOf('\n}\n', at) + 2)}; return loadMeshFile;`)(
    () => false, null, async () => ({ meshFormatOf: () => 'obj' }), () => false, '', () => {}, () => {}, () => '0', async () => {}, 100,
    {}, () => 'mm', () => 'mm', async (s) => { read.push([...s.extras.keys()]); });
  const extra = (name, n) => ({ name, arrayBuffer: async () => new ArrayBuffer(n) });
  // (under the cap: read, each by its name)
  await loadMeshFile(new ArrayBuffer(4), 'a.obj', 1, [extra('a.mtl', 40), extra('t.png', 40)]);
  assert.deepEqual(read, [['a.mtl', 't.png']]);
  // (over it together, though each is under: refused, the mesh never read)
  await assert.rejects(loadMeshFile(new ArrayBuffer(4), 'b.obj', 1, [extra('b.mtl', 60), extra('t.png', 60)]), /^Error: b\.obj: its companion files come to over 0 GB, more than this viewer opens$/);
  assert.equal(read.length, 1);
});

await test('a list pick ends the address\'s tour, and Back to the first entry opens the model the address opened (r56 Q3, A2)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const cut = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const line = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n', at) + 1); };
  const app = { urlTourPending: true, header: {}, sourceUrl: 'https://s.example/c.stl', listEntries: [{ url: 'https://s.example/a.stl' }, { url: 'https://s.example/b.stl' }] };
  const loaded = [];
  let pop = null;
  const loc = { href: 'https://s.example/?list=l.json', search: '?list=l.json', hash: '' };
  const f = new Function('app', 'setModelParam', 'history', 'closeMenus', 'loadListed', 'syncModelList', 'location', 'window', 'modelUrlIn', 'decodeView', 'autoTourKey',
    `let listPick = 0;\n${cut('function openListed(url, refocus = false, keepMenu = false) {')}${cut('function wireHistory() {')}${cut('function tourOver() {')}${line('const addressModel = ')}; return { openListed, wireHistory };`)(
    app, () => {}, { pushState() {}, replaceState() {}, back() {}, state: null }, () => {}, (u) => { loaded.push(u); return Promise.resolve(); }, () => {}, loc,
    { addEventListener: (ev, fn) => { if (ev === 'popstate') pop = fn; } }, () => null, () => null, () => app.sourceUrl);
  // (a pick while the address's tour is read: the tour over, the pick's own then plays -- neither did)
  f.openListed('https://s.example/b.stl');
  assert.deepEqual([app.urlTourPending, app.autoTourFor], [false, 'https://s.example/c.stl'], 'the address\'s tour over at the pick');
  // (Back to the first entry, which opened the tour's model c.stl: c.stl, not the list's first)
  app.addressUrl = 'https://s.example/c.stl';
  app.sourceUrl = 'https://s.example/b.stl';
  f.wireHistory();
  pop();
  assert.deepEqual(loaded, ['https://s.example/b.stl', 'https://s.example/c.stl']);
});

// main.js's own loadUrl and readLists take the early downloads, once: a ?src= page downloaded its
// model twice under a mutant no test saw (r53 Q3)
await test('loadUrl takes the model\'s early download and readLists the early read, once each (r53 Q3)', async () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const cut = (head) => { const at = src.indexOf(head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const ef = await import('../js/early-fetch.js');
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (u) => { asked.push(String(u)); return String(u).endsWith('.json') ? new Response(JSON.stringify({ 'a.stl': 'A' })) : new Response('abc'); };
  const app = { loadSeq: 0 }, got = [], loc = { href: 'https://s.example/', search: '' };
  const el = () => ({ hidden: false, textContent: '' });
  const f = new Function('app', '$', 'setStatus', 'announce', 'fileName', 'showProgress', 'directFor', 'earlyFetch', 'fetchFailedText', 'isRelative',
    'MAX_FILE_BYTES', 'oversizeText', 'rateText', 'mb', 'loadAny', 'location', 'earlyLists', 'fetchModelLists', 'timedFetch', 'fillModelList', 'listsRead', 'startUpLoad',
    `${cut('function beginLoad() {')}${cut('function stale(seq) {')}${cut('async function loadUrl(url) {')}${cut('async function readLists(lists, openFirst) {')}; return { loadUrl, readLists };`)(
    app, () => el(), () => {}, () => {}, (u) => u.split('/').pop(), () => {}, (u) => ({ url: u }), ef.earlyFetch, async () => 'x', isRelative,
    2 ** 31, (n) => n, () => '', () => '0', async (buf, name) => { got.push([name, buf.byteLength]); }, loc,
    ef.earlyLists, fetchModelLists, (u) => fetch(u), (e) => { app.listEntries = e; }, () => false, async () => {});
  // (the early ones, as js/early.js starts them)
  ef.startEarly('https://s.example/a.stl');
  ef.setEarlyLists(['l.json'], fetchModelLists(['l.json'], 'https://s.example/', (u) => fetch(u)));
  asked.length = 0;
  await f.loadUrl('https://s.example/a.stl');
  await f.readLists(['l.json'], () => false);
  assert.deepEqual([asked, got, app.listEntries.map((e) => e.name)], [[], [['a.stl', 3]], ['A']], 'no second fetch of either');
  await f.loadUrl('https://s.example/a.stl');
  assert.deepEqual(asked, ['https://s.example/a.stl'], 'taken once: the next load fetches its own');
  // (a relative address that 404s beside a list that could not be read: the hint says the list was
  // not read, not that it does not name it -- r54 Q10)
  globalThis.fetch = async () => new Response('', { status: 404 });
  loc.search = '?list=l.json';
  Object.assign(app, { listEntries: [], listNote: 'model list https://s.example/l.json: not found (404)' });
  await assert.rejects(f.loadUrl('b.stl'), /\(the model list gave no models -- model list https:\/\/s\.example\/l\.json: not found \(404\) -- so a relative address is read from this page's address/);
  // (a list read and empty: said as such, not "could not be read" -- r55 Q10)
  Object.assign(app, { listNote: 'the model list names no models' });
  await assert.rejects(f.loadUrl('b.stl'), /\(the model list gave no models -- the model list names no models -- so/);
  Object.assign(app, { listEntries: [{ url: 'https://s.example/a.stl' }], listNote: '' });
  await assert.rejects(f.loadUrl('b.stl'), /\(a relative address the model list does not name is read from this page's address/);
  // (one list of two read, the other failed: the failed one may be the one naming it -- r56 A7, Q10)
  Object.assign(app, { listNote: 'model list https://s.example/two.json: not found (404)' });
  await assert.rejects(f.loadUrl('b.stl'), /\(no model list that was read names it, so it is read from this page's address -- model list https:\/\/s\.example\/two\.json: not found \(404\): give the full URL\)/);
  globalThis.fetch = realFetch;
});

// js/early.js against the start-up table: its own run on each case's address (the page's first
// module, before main.js), the model it fetches early is the one the start-up opens first -- never
// another -- and every model the address opens is fetched early but a tour's own (the tour is read
// first) and one behind a poster (View in 3D). The two read the address by one set of rules
// (js/model-list.js), and decided the poster apart: r53 A2, Q2.
await test('js/early.js fetches early the model the start-up opens first, and no other (r53 A2, Q2, Q3)', async () => {
  const { releaseEarly, earlyLists } = await import('../js/early-fetch.js');
  const realFetch = globalThis.fetch;
  const failed = [];
  let n = 0;
  for (const [name, c] of Object.entries(START_CASES)) {
    if (c.early || c.during || c.drop || c.add) continue; // (the visitor's own files: not the address's)
    const params = new URLSearchParams(c.q), serve = c.serve || {}, asked = [];
    globalThis.location = { href: `${SITE}?${c.q}`, search: `?${c.q}` };
    globalThis.fetch = async (u) => {
      const p = String(u).startsWith(SITE) ? String(u).slice(SITE.length) : String(u);
      asked.push(p);
      return p in serve ? new Response(serve[p], { status: 200 }) : new Response('', { status: 404 });
    };
    await import(`../js/early.js?start=${++n}`);
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1));
    releaseEarly();
    earlyLists(params.getAll('list'));
    const models = asked.filter((p) => !p.endsWith('.json')).map((p) => p.split('/').pop());
    // (what the start-up opens first from the address: nothing behind a poster until View in 3D)
    const first = posterAsked(params) ? null : c.want[4][0] || null;
    if (models.length > 1) failed.push(`${name}: fetched early ${JSON.stringify(models)}`);
    else if (models[0] && models[0] !== first) failed.push(`${name}: fetched early ${models[0]}, the start-up opens ${first}`);
    else if (first && !models[0] && !params.has('tour')) failed.push(`${name}: ${first} not fetched early`);
  }
  globalThis.fetch = realFetch;
  delete globalThis.location;
  assert.deepEqual(failed, [], `cases: ${failed.length}\n${failed.join('\n')}`);
});

done();
