#!/usr/bin/env node
// The one point-in-solid test (js/solid.js) and the box tree it stands on (js/box-tree.js):
// crossings along the three rays (through an edge, through a corner, on the surface), which shells
// wholly hold which (by the weld's turning, js/edges.js shellTurns), a solid's material (windingAt,
// Clearance's question) and a body's volume by the same rule (js/edges.js buildEdges), and the
// cost.   node tests/test-solid.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { crossingsAt, solidIndex, windingAt } from '../js/solid.js';
import { buildEdges, shellTurns, FACTS_RULE, factsCurrent } from '../js/edges.js';
import { encodeCadmesh, decodeCadmesh } from '../js/cadmesh.js';
import { mergeModels } from '../js/scene.js';
import { box } from './brep-model.mjs';

import { test, done } from './harness.mjs';

// triangles as point triples -> { P, I } (own corners: the weld joins them); signed volume; outward
const meshOf = (T) => { const pos = [], idx = []; for (const t of T) for (const p of t) { idx.push(pos.length / 3); pos.push(...p); } return { P: Float32Array.from(pos), I: Uint32Array.from(idx) }; };
const vol = (T) => T.reduce((s, [a, b, c]) => s + (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6, 0);
const rev = (T) => T.map(([a, b, c]) => [a, c, b]);
const cubeT = (lo, hi, inward = false) => { const T = box(lo, hi).flat(); const o = vol(T) < 0 ? rev(T) : T; return inward ? rev(o) : o; };
// the signed volume of the triangles t0..t1 of a body after shellTurns
const turnedVol = (T, t0, t1) => {
  const { P, I } = meshOf(T), { flip } = shellTurns(P, I);
  return vol(T.slice(t0, t1).map((t, k) => (flip && flip[t0 + k] ? [t[0], t[2], t[1]] : t)));
};

test('a point inside a cube is inside by its crossings, along a face\'s diagonal and through a corner too (r28 Q3: 266 of 981 read outside)', () => {
  const { P, I } = meshOf(cubeT([0, 0, 0], [10, 10, 10]));
  const idx = solidIndex(P, I, Array.from({ length: I.length / 3 }, (_, t) => t));
  const d = [0.3141592, 0.5772156, 0.7536422], l = Math.hypot(...d), R = d.map((x) => x / l); // (the first ray)
  let wrong = 0, n = 0;
  for (let i = 1; i < 1000; i++) {
    const s = i / 100, p = [s, s, 10].map((x, k) => x - (1e-3 + (i % 7) * 0.1) * R[k]);
    if (p.some((x) => x <= 0 || x >= 10)) continue;
    n++;
    if (!crossingsAt(idx, p).inside) wrong++;
  }
  assert.ok(n > 900);
  assert.equal(wrong, 0, `${wrong} of ${n} points back along the ray from the top face's diagonal read outside`);
  assert.equal(crossingsAt(idx, [10, 10, 10].map((x, k) => x - 2 * R[k])).inside, true, 'through the corner');
  assert.equal(crossingsAt(idx, [12, 5, 5]).inside, false);
  assert.equal(crossingsAt(idx, [5, 5, 10]).touch, true, 'on the surface: no answer');
});
test('a plate resting on a cube, the pair turned off the axes, is no part of the cube: wound inside out, it is turned (r28 A2: 29 of 200 nested)', () => {
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const cube = cubeT([-5, -5, -5], [5, 5, 5]), plate = cubeT([-2, -2, 5], [2, 2, 5.5]);
  // (and the pair 1,000 mm out: float32's error grows with the distance from the origin, and a
  // tolerance by the shell's size alone left the plate inside out in 11 of 200, r29 Q1)
  for (const D of [0, 1000]) {
    let bad = 0;
    for (let r = 0; r < 60; r++) {
      let q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]; const l = Math.hypot(...q); q = q.map((x) => x / l);
      const [w, x, y, z] = q;
      const M = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
      const rot = (p) => M.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + D);
      const T = [...cube, ...rev(plate)].map((t) => t.map(rot));
      if (!(turnedVol(T, 12, 24) > 0)) bad++;
    }
    assert.equal(bad, 0, `${D} mm out: ${bad} of 60 rotations left the plate inside out`);
  }
});
test('a second outer shell whose box holds the parent\'s but which does not hold it is still found: the outer shells disagree, the part kept (r29 Q4)', () => {
  // A a cube wound in; B a tetrahedron wound out, its base just under z 8.8 over A and one base
  // corner far off and low, so its box holds A's though it holds only A's top; C a slab wound out
  // in both (z 9..9.8)
  const A = cubeT([0, 0, 0], [10, 10, 10], true);
  const q0 = [-50, -50, 8.8], q1 = [60, -50, 8.8], q2 = [5, 3000, -5], ap = [5, 5, 100];
  let B = [[q0, q2, q1], [q0, q1, ap], [q1, q2, ap], [q2, q0, ap]];
  if (vol(B) < 0) B = rev(B);
  const C = cubeT([6, 6, 9], [9, 9, 9.8]), cv = vol(C);
  assert.equal(turnedVol([...A, ...B, ...C], 16, 28).toFixed(2), cv.toFixed(2), 'C kept as written (by the box test alone, turned with A)');
  assert.equal(turnedVol([...B, ...A, ...C], 16, 28).toFixed(2), cv.toFixed(2));
});
test('4,000 concentric rings, none holding another: under 5 s (r29 Q5: 2,000 of them 29.9 s, every candidate rescanned a pick)', () => {
  // square annular prisms (one closed shell each) of half-width R, wall 0.5, 1 high: every ring's
  // box holds the smaller rings', and none holds another (each smaller one lies in its hole)
  const ring = (R, w, h) => {
    const r = R - w, T = [];
    const o = [[-R, -R], [R, -R], [R, R], [-R, R]], i = [[-r, -r], [r, -r], [r, r], [-r, r]];
    const q = (a, b, c, d) => { T.push([a, b, c], [a, c, d]); };
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      const O0 = [...o[k], 0], O1 = [...o[k2], 0], I0 = [...i[k], 0], I1 = [...i[k2], 0];
      const O0t = [...o[k], h], O1t = [...o[k2], h], I0t = [...i[k], h], I1t = [...i[k2], h];
      q(O0, O1, O1t, O0t); q(I1, I0, I0t, I1t); q(O0t, O1t, I1t, I0t); q(O1, O0, I0, I1);
    }
    return T;
  };
  // (and 100 of them written mirrored, all wound inward: every one an outer shell, every one turned
  // -- at most 64 holders asked a shell, the rest unknown and kept, 35 of 100 stayed inside out, r30 Q2)
  const M = [];
  for (let k = 0; k < 100; k++) M.push(...rev(ring(10 + k, 0.5, 1)));
  {
    const { P, I } = meshOf(M), { flip } = shellTurns(P, I);
    assert.ok(flip && flip.every((x) => x === 1), `turned: ${flip ? flip.reduce((a, x) => a + x, 0) : 0} of ${M.length} triangles`);
  }
  // (and the one holder last of 301 candidates: 300 rings wound out round a box wound in, in the
  // box a cube wound out in the hole of a small ring -- the ring the cube's smallest candidate, no
  // holder, so every other one asked; the box, written last, the 301st: at most 64 asked, the cube
  // was left as written. The box turned with the ring and the cube in it, the 300 rings not)
  {
    const H = [];
    for (let k = 0; k < 300; k++) H.push(...ring(100 + k, 0.5, 1));
    const n0 = H.length;
    H.push(...cubeT([-50, -50, -5], [50, 50, 6], true), ...cubeT([-1, -1, 0.2], [1, 1, 0.8]), ...ring(5, 0.5, 1));
    const { P, I } = meshOf(H), { flip } = shellTurns(P, I);
    const turned = (a, b) => (flip ? flip.subarray(a, b).reduce((s, x) => s + x, 0) : 0);
    assert.deepEqual([turned(0, n0), turned(n0, n0 + 12), turned(n0 + 12, n0 + 24), turned(n0 + 24, H.length)], [0, 12, 12, 32], 'rings, box, cube, small ring');
  }
  // (4,000 of them under 5 s: the counts by shell in Maps and Sets, 9.3 s, r31 Q4)
  const T = [];
  for (let k = 0; k < 4000; k++) T.push(...ring(10 + k, 0.5, 1));
  assert.ok(vol(ring(10, 0.5, 1)) > 0, 'wound out');
  const { P, I } = meshOf(T);
  const t0 = performance.now();
  shellTurns(P, I);
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `${ms.toFixed(0)} ms`);
});
test('a solid\'s material by its winding number: a cavity (wound in) outside, a part embedded (wound out) inside, an overlap inside, parts face to face each by its own facing, a body inside out none (r28 A1, r30 A1)', () => {
  const insideOf = (T, p) => {
    const { P, I } = meshOf(T);
    return windingAt(solidIndex(P, I, Array.from({ length: I.length / 3 }, (_, t) => t)), p).inside;
  };
  // two boxes face to face (each with its own copy of the shared face, the copies coincident: the
  // weld makes them one branched shell), the one wound out and the other in: each region what its
  // own facing says (one sign for the merged shell read both alike)
  const pair = [...cubeT([0, 0, 0], [10, 10, 10]), ...cubeT([10, 0, 0], [15, 10, 10], true)];
  assert.equal(insideOf(pair, [5, 5, 5]), true, 'the outward box');
  assert.equal(insideOf(pair, [12, 5, 5]), false, 'the inward box');
  const outer = cubeT([0, 0, 0], [10, 10, 10]);
  assert.equal(insideOf([...outer, ...cubeT([3, 3, 3], [7, 7, 7], true)], [5, 5, 5]), false, 'in a cavity');
  assert.equal(insideOf([...outer, ...cubeT([3, 3, 3], [7, 7, 7], true)], [1, 1, 1]), true, 'in the material round it');
  assert.equal(insideOf([...outer, ...cubeT([3, 3, 3], [7, 7, 7])], [5, 5, 5]), true, 'in an embedded part');
  assert.equal(insideOf([...outer, ...cubeT([5, 5, 5], [15, 15, 15])], [7, 7, 7]), true, 'in the overlap');
  assert.equal(insideOf(rev(outer), [5, 5, 5]), false, 'a body wound inside out: none, by its winding (Clearance turns it to its normals first)');
});
test('a pin in the overlap of a branched shell (two or three boxes sharing a face) turns with it, never by its own sign: mirrored, nothing turned (r31 A2: the parity of 2 read outside, the pin turned)', () => {
  for (const N of [2, 3]) {
    let T = [];
    for (let i = 0; i < N; i++) T.push(...cubeT([0, 0, 0], [10 + 5 * i, 10, 10])); // (the x = 0 face the same in each)
    const nB = T.length;
    T.push(...cubeT([2, 4, 4], [4, 6, 6]));
    T = rev(T);
    const { P, I } = meshOf(T), { flip } = shellTurns(P, I);
    const turned = (a, b) => (flip ? flip.subarray(a, b).reduce((s, x) => s + x, 0) : 0);
    assert.deepEqual([turned(0, nB), turned(nB, T.length)], [0, 0], `N=${N}: the boxes, the pin`);
  }
});
test('a part held by its nearest holder (wound in) and by 9 or 20 others (wound out, no ancestors of it): its outer shells disagree, kept as written (r31 A4: the many-holders path had no arm)', () => {
  for (const N of [9, 20]) {
    const A = cubeT([0, 0, 0], [10, 10, 10], true), Bs = [];
    for (let i = 1; i <= N; i++) { const e = 0.01 * i; Bs.push(...cubeT([5 - e, 5 - e, 5 - e], [15 + i, 15 + e, 15 + e])); }
    const C = cubeT([6, 6, 6], [9, 9, 9]), n0 = A.length + Bs.length;
    assert.equal(Math.round(turnedVol([...A, ...Bs, ...C], n0, n0 + 12)), 27, `N=${N}`);
  }
});
test('a body\'s volume is its material\'s, as Clearance takes it: a cavity out once, an embedded part counted once; overlapping shells and two parts face to face said to be net (r31 A1: 1064 for 1000, 2000 for 1500 unsaid)', () => {
  const facts = (T) => {
    const { P, I } = meshOf(T);
    const min = [0, 1, 2].map((k) => Math.min(...T.flat().map((p) => p[k]))), max = [0, 1, 2].map((k) => Math.max(...T.flat().map((p) => p[k])));
    const { facts: f } = buildEdges({ position: P, index: I, meshes: [{ idxStart: 0, idxCount: I.length, vtxStart: 0, vtxCount: P.length / 3, bbox: { min, max } }] });
    return [Math.round(f.volume[0] * 1000) / 1000, f.net[0]];
  };
  const outer = cubeT([0, 0, 0], [10, 10, 10]);
  assert.deepEqual(facts(outer), [1000, false], 'one cube');
  assert.deepEqual(facts(rev(outer)), [1000, false], 'one cube wound inside out (its outer shell decides its facing)');
  assert.deepEqual(facts([...outer, ...cubeT([3, 3, 3], [7, 7, 7], true)]), [936, false], 'a cavity');
  assert.deepEqual(facts([...outer, ...cubeT([3, 3, 3], [7, 7, 7])]), [1000, false], 'an embedded part: counted once');
  assert.deepEqual(facts([...outer, ...cubeT([3, 3, 3], [7, 7, 7]), ...cubeT([4, 4, 4], [6, 6, 6], true)]), [1000, false], 'a cavity in an embedded part: winding 2 - 1, still material, as windingAt reads it');
  assert.deepEqual(facts([...outer, ...cubeT([5, 0, 0], [15, 10, 10])])[1], true, 'two overlapping cubes: said');
  assert.deepEqual(facts([...outer, ...cubeT([10, 0, 0], [15, 10, 10], true)])[1], true, 'face to face, one wound in: said');
});
test('the volume\'s overlap test is the shells\' surfaces, not their boxes; one closed rule with the facts\' flag; the facts\' rule and net carried through a file and a merge (r32 A1, A2, A8, Q2, Q3)', () => {
  // a polygon (counter-clockwise in x, y; its caps fanned from corner fan) extruded z0..z1, as triangles
  const prism = (poly, z0, z1, fan, inward) => {
    const n = poly.length, at = (k, z) => [poly[k][0], poly[k][1], z], T = [];
    for (let k = 0; k < n; k++) { const a = (fan + k + 1) % n, b = (fan + k + 2) % n; if (b === fan) break; T.push([at(fan, z1), at(a, z1), at(b, z1)], [at(fan, z0), at(b, z0), at(a, z0)]); }
    for (let k = 0; k < n; k++) { const k2 = (k + 1) % n; T.push([at(k, z0), at(k2, z0), at(k2, z1)], [at(k, z0), at(k2, z1), at(k, z1)]); }
    return inward ? rev(T) : T;
  };
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const factsOf = (T, kind) => {
    const { P, I } = meshOf(T);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i++) { const k = i % 3; if (P[i] < min[k]) min[k] = P[i]; if (P[i] > max[k]) max[k] = P[i]; }
    const { facts: f } = buildEdges({ position: P, index: I, meshes: [{ idxStart: 0, idxCount: I.length, vtxStart: 0, vtxCount: P.length / 3, bbox: { min, max }, ...(kind ? { kind } : {}) }] });
    return [Math.round(f.volume[0] * 1000) / 1000, f.net[0], f.closed[0]];
  };
  const block = prism(sq(0, 0, 10, 10), 0, 10, 0), L = prism([[1, 1], [9, 1], [9, 9], [7, 9], [7, 3], [1, 3]], 1, 9, 4, true);
  // (a pin in the notch of an L-shaped cavity: in the cavity's box, 2 mm from it -- the boxes
  // crossing read it as an overlap, net and the signed sum 800)
  assert.deepEqual(factsOf([...block, ...L, ...prism(sq(3, 5, 5, 7), 2, 8, 0)]), [776, false, true], 'a pin in an L cavity\'s notch');
  // (an L-shaped part with a cube across its inner corner, the two crossing: said -- the sampled
  // nesting read it as held, 3000 for 3008, unsaid)
  const Lpart = prism([[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]], 0, 10, 0);
  assert.equal(factsOf([...Lpart, ...cubeT([3, 3, 1], [11, 11, 9])])[1], true, 'a cube across an L\'s corner');
  // (a b-rep body closed by its kind, a part embedded in it and one corner off by one ulp: by the
  // b-rep's word, every shell may hold -- 1008 for 1000)
  const cube = cubeT([0, 0, 0], [10, 10, 10]);
  let moved = 0;
  const crack = cube.map((t) => t.map((p) => (!moved && p[0] === 10 && p[1] === 10 && p[2] === 10 ? (moved++, [Math.fround(10 + 1e-6), 10, 10]) : p)));
  const cracked = [...crack, ...cubeT([4, 4, 4], [6, 6, 6])];
  assert.deepEqual(factsOf(cracked)[2], false, 'the crack is one: the mesh test calls it open');
  assert.deepEqual(factsOf(cracked, 'closed').slice(0, 2), [1000, false], 'a cracked b-rep cube, a part in it');
  // (4,096 blocks in a row, each with a part embedded: none overlapping -- a sweep along x alone
  // gave up past a million pairs, 4608 and net)
  const many = [];
  for (let k = 0; k < 4096; k++) many.push(...cubeT([0, 2 * k, 0], [1, 2 * k + 1, 1]), ...cubeT([0.25, 2 * k + 0.25, 0.25], [0.75, 2 * k + 0.75, 0.75]));
  assert.deepEqual(factsOf(many).slice(0, 2), [4096, false], '4,096 blocks with parts');
  // the rule's number and net through a file and a merge of two
  const one = (T) => {
    const { P, I } = meshOf(T);
    const raw = encodeCadmesh({ units: 'mm', meshes: [{ name: 'b', color: [0.5, 0.5, 0.5], positions: P, normals: null, colors: null, indices: I }], root: { name: 'm', meshes: [0], children: [] } });
    return decodeCadmesh(raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  };
  const a = one([...cube, ...cubeT([5, 0, 0], [15, 10, 10])]), b = one(cube);
  assert.deepEqual([a.header.factsRule, a.header.facts.net, b.header.factsRule, b.header.facts.net], [FACTS_RULE, [true], FACTS_RULE, undefined]);
  const s = mergeModels([{ base: a, name: 'a' }, { base: b, name: 'b' }]);
  assert.deepEqual([s.header.factsRule, s.header.facts.net], [FACTS_RULE, [true, false]]);
  // (and merged with a model of no rule, or an older one: no rule, so rebuilt -- the first model's
  // rule taken would show the other's old signed sum as today's, r33 Q4)
  for (const old of [undefined, FACTS_RULE - 1]) {
    const c = one(cube);
    c.header = { ...c.header, factsRule: old };
    const m = mergeModels([{ base: a, name: 'a' }, { base: c, name: 'c' }]);
    assert.deepEqual([m.header.factsRule, factsCurrent(m.header)], [undefined, false], `merged with a model of rule ${old}`);
    assert.equal(factsCurrent(c.header), false);
  }
  assert.equal(factsCurrent(a.header), true);
  assert.equal(factsCurrent({ ...a.header, facts: undefined }), false, 'no facts');
});
test('the facts\' overlap test asks each shell its parent, not every holder, each shell\'s tree built once: a fine housing with 120 parts and 8,000 concentric shells are exact and quick, not net; past the budget, unchecked -- not said to meet (r33 Q1, A1, A2)', () => {
  // a box of side 200 meshed fine (k x k quads a face: 6 * 2 * k^2 triangles), wound out
  const fineBox = (lo, hi, k) => {
    const T = [];
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3, c = (a + 2) % 3;
      for (const side of [0, 1]) {
        const at = (u, v) => { const p = [0, 0, 0]; p[a] = side ? hi[a] : lo[a]; p[b] = lo[b] + (hi[b] - lo[b]) * u / k; p[c] = lo[c] + (hi[c] - lo[c]) * v / k; return p; };
        for (let u = 0; u < k; u++) for (let v = 0; v < k; v++) {
          const q = [at(u, v), at(u + 1, v), at(u + 1, v + 1), at(u, v + 1)];
          const t = [[q[0], q[1], q[2]], [q[0], q[2], q[3]]];
          T.push(...(side ? t : rev(t)));
        }
      }
    }
    return T;
  };
  const factsOf = (T, opts) => {
    const { P, I } = meshOf(T);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i++) { const k = i % 3; if (P[i] < min[k]) min[k] = P[i]; if (P[i] > max[k]) max[k] = P[i]; }
    const t0 = performance.now();
    const { facts: f } = buildEdges({ position: P, index: I, meshes: [{ idxStart: 0, idxCount: I.length, vtxStart: 0, vtxCount: P.length / 3, bbox: { min, max } }] }, opts);
    return { v: Math.round(f.volume[0] * 1000) / 1000, net: f.net[0], unchecked: f.unchecked[0], ms: performance.now() - t0 };
  };
  const housing = fineBox([0, 0, 0], [200, 200, 200], 100), parts = [];
  assert.ok(vol(housing) > 0);
  for (let i = 0; i < 120; i++) { const x = 10 + (i % 10) * 18, y = 10 + Math.floor(i / 10) * 15; parts.push(...cubeT([x, y, 50], [x + 1, y + 1, 51])); }
  const h = factsOf([...housing, ...parts]);
  assert.deepEqual([h.v, h.net, h.unchecked], [8000000, false, false], 'a fine housing with 120 parts');
  assert.ok(h.ms < 4000, `${h.ms.toFixed(0)} ms (asked against every holder, each pair's trees built again: 10.8 s, then net)`);
  // (the budget: past it, unchecked, and not net)
  const small = factsOf([...housing, ...parts], { overlapBudget: 50 });
  assert.deepEqual([small.net, small.unchecked], [false, true], 'past the budget');
  // 8,000 concentric shells, wound alternately: the cavities and the parts in them, each a region
  const T = [];
  for (let i = 0; i < 8000; i++) { const d = i * 0.01; T.push(...cubeT([d, d, d], [200 - d, 200 - d, 200 - d], i % 2 === 1)); }
  const c = factsOf(T);
  assert.deepEqual([c.net, c.unchecked], [false, false], 'concentric shells');
  assert.ok(c.ms < 8000, `${c.ms.toFixed(0)} ms (15.1 s, then net)`);
});
test('an open shell holds nothing, and a part under one keeps its winding, the same upright and upside down (r28 Q1)', () => {
  // a tray (a box without its lid), and an inward cube in it
  const tray = box([0, 0, 0], [10, 10, 5]).filter((_, f) => f !== 1).flat(); // (face 1: the top)
  const trayOut = vol(cubeT([0, 0, 0], [10, 10, 5])) > 0 ? tray : rev(tray);
  const T = [...trayOut, ...cubeT([3, 3, 1], [5, 5, 3], true)];
  const flipX = (t) => t.map(([x, y, z]) => [x, -y, -z]); // (180 degrees about x: a rotation)
  const a = turnedVol(T, trayOut.length, T.length), b = turnedVol(T.map(flipX), trayOut.length, T.length);
  assert.equal(Math.round(a), Math.round(b), `upright ${a}, upside down ${b}`);
  assert.equal(Math.round(a), -8, 'kept as written: no answer under an open shell');
});
test('a part whose outer shells disagree (in the overlap of one wound in and one wound out) keeps its winding, in either file order (r28 Q2)', () => {
  const A = cubeT([0, 0, 0], [10, 10, 10], true), B = cubeT([5, 5, 5], [15, 15, 15]), C = cubeT([6, 6, 6], [9, 9, 9]);
  assert.equal(Math.round(turnedVol([...A, ...B, ...C], 24, 36)), 27);
  assert.equal(Math.round(turnedVol([...B, ...A, ...C], 24, 36)), 27);
});
test('8,000 shells each inside the one before (concentric): the nearest holder only, under 6 s (r28 Q4: 147 s)', () => {
  const T = [];
  for (let i = 0; i < 8000; i++) { const d = i * 0.01; T.push(...cubeT([d, d, d], [200 - d, 200 - d, 200 - d], i % 2 === 1)); }
  const { P, I } = meshOf(T);
  const t0 = performance.now();
  const { flip } = shellTurns(P, I);
  const ms = performance.now() - t0;
  assert.equal(flip, null, 'wound as they lie (each inner one against the one round it): none turned');
  assert.ok(ms < 6000, `${ms.toFixed(0)} ms`);
});

done();
