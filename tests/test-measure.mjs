#!/usr/bin/env node
// Measure's geometry (js/measure-geom.js) and ray caster (js/raycast.js) on
// bodies built here the way OpenCascade meshes them: every b-rep face its own
// vertices, shared boundary points with identical floats, a faces section.
//   node tests/test-measure.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { angleAt, bodyGeometry, circleMinPoints, circleOf, distance, faceGap, holesOf, polyMid } from '../js/measure-geom.js';
import { BVH_MIN, faceOfTri, makeCaster } from '../js/raycast.js';

import { test, done } from './harness.mjs';

// A model builder: bodies of faces, each face a list of triangles given as
// point triples; points are deduplicated within a face only (OpenCascade's way)
function model(bodies, angularDeflection = 0.5) {
  const pos = [], idx = [], faces = [], meshes = [];
  for (const b of bodies) {
    const m = { name: b.name, idxStart: idx.length, faceStart: faces.length / 2, faceCount: b.faces.length };
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const f of b.faces) {
      const map = new Map();
      faces.push(idx.length / 3, f.length);
      for (const tri of f) {
        for (const p of tri) {
          const k = p.join(',');
          if (!map.has(k)) { map.set(k, pos.length / 3); pos.push(...p); for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], p[j]); hi[j] = Math.max(hi[j], p[j]); } }
          idx.push(map.get(k));
        }
      }
    }
    m.idxCount = idx.length - m.idxStart;
    m.bbox = { min: lo, max: hi };
    meshes.push(m);
  }
  return {
    position: new Float32Array(pos), index: new Uint32Array(idx), faces: new Uint32Array(faces),
    header: { meshes, angularDeflection },
  };
}
const f32 = (v) => Math.fround(v);
const P = (x, y, z) => [f32(x), f32(y), f32(z)];

// a washer: inner radius ri, outer ro, z from 0 to h, n segments; four faces
function washer(ri, ro, h, n, cx = 0, cy = 0, z0 = 0) {
  const ring = (r, z) => Array.from({ length: n }, (_, i) => P(cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n), z));
  const it = ring(ri, z0 + h), ot = ring(ro, z0 + h), ib = ring(ri, z0), ob = ring(ro, z0);
  const band = (a, b) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); } return t; };
  return [band(it, ot), band(ob, ib), band(ib, it), band(ot, ob)];
}
// a box: six faces of two triangles
function box(lo, hi) {
  const c = (x, y, z) => P(x ? hi[0] : lo[0], y ? hi[1] : lo[1], z ? hi[2] : lo[2]);
  const q = (a, b, cc, d) => [[a, b, cc], [a, cc, d]];
  return [q(c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0)), q(c(0, 0, 1), c(0, 1, 1), c(1, 1, 1), c(1, 0, 1)),
    q(c(0, 0, 0), c(0, 0, 1), c(1, 0, 1), c(1, 0, 0)), q(c(0, 1, 0), c(1, 1, 0), c(1, 1, 1), c(0, 1, 1)),
    q(c(0, 0, 0), c(0, 1, 0), c(0, 1, 1), c(0, 0, 1)), q(c(1, 0, 0), c(1, 0, 1), c(1, 1, 1), c(1, 1, 0))];
}

test('a circle needs ceil(2π/a) - 1 points: 12 at 0.5 rad; off at 2π/9 and coarser', () => {
  assert.equal(circleMinPoints(0.5), 12);
  assert.equal(circleMinPoints((2 * Math.PI) / 9), Infinity);
  const pts = (n, r = 3) => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n) + 10, r * Math.sin((2 * Math.PI * i) / n) - 4, 2]);
  const c = circleOf(pts(24), 0.5);
  assert.ok(c && Math.abs(c.radius - 3) < 1e-9 && Math.hypot(c.centre[0] - 10, c.centre[1] + 4, c.centre[2] - 2) < 1e-9, JSON.stringify(c));
  assert.equal(circleOf(pts(4), 0.5), null, 'a square is not a circle');
  assert.equal(circleOf(pts(6), 0.5), null, 'nor a hexagon');
});
test('uneven spacing does not pull the centre (a least-squares fit, not the mean)', () => {
  const angles = [...Array.from({ length: 20 }, (_, i) => (i * Math.PI) / 40), ...Array.from({ length: 8 }, (_, i) => Math.PI / 2 + (i * 1.5 * Math.PI) / 8)];
  const c = circleOf(angles.map((t) => [5 * Math.cos(t), 5 * Math.sin(t), 0]), 0.5);
  assert.ok(c && Math.hypot(...c.centre) < 1e-9 && Math.abs(c.radius - 5) < 1e-9, JSON.stringify(c));
});
test('a box: 8 corners, 12 straight edges, midpoints at the edge centres, six planar faces', () => {
  const m = model([{ name: 'box', faces: box([0, 0, 0], [10, 20, 4]) }]);
  const g = bodyGeometry(m, 0);
  assert.equal(g.corners.length, 8);
  assert.equal(g.edges.length, 12);
  assert.ok(g.edges.some((e) => { const p = polyMid(e); return Math.hypot(p[0] - 5, p[1], p[2]) < 1e-6; }), 'the midpoint of the x edge at y 0, z 0');
  assert.ok(g.faces.every((f) => f.plane));
  assert.equal(g.circles.length, 0);
});
test('a washer: the bore is a hole (both rims, its depth), the outer rim is not', () => {
  const m = model([{ name: 'washer', faces: washer(1.6, 4, 1.6, 48, 20, 30) }]);
  const g = bodyGeometry(m, 0);
  assert.equal(g.corners.length, 0, 'circles only: no corners');
  assert.equal(g.edges.length, 4, 'four closed rims');
  const holes = holesOf(g);
  assert.equal(holes.length, 1, JSON.stringify(holes));
  assert.ok(Math.abs(holes[0].diameter - 3.2) < 1e-4 && Math.abs(holes[0].depth - 1.6) < 1e-6 && holes[0].rims === 2, JSON.stringify(holes[0]));
  assert.ok(Math.hypot(holes[0].centre[0] - 20, holes[0].centre[1] - 30) < 1e-4);
});
test('a board with four mounting holes: four holes, their spacing', () => {
  // a plate whose top and bottom faces are annuli around each hole: built as
  // four washers fused by one body (the faces' loops are what count)
  const faces = [];
  for (const [x, y] of [[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]]) faces.push(...washer(1.375, 3, 1.6, 40, x, y));
  const g = bodyGeometry(model([{ name: 'pcb', faces }]), 0);
  const holes = holesOf(g);
  assert.equal(holes.length, 4);
  assert.ok(holes.every((h) => Math.abs(h.diameter - 2.75) < 1e-4));
  // (their centres exactly: the old check compared two holes that always shared an x)
  const at = holes.map((h) => [Math.round(h.centre[0] * 1e4) / 1e4, Math.round(h.centre[1] * 1e4) / 1e4]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(at, [[3.5, 3.5], [3.5, 52.5], [61.5, 3.5], [61.5, 52.5]]);
  assert.ok(holes.every((h) => Math.abs(h.depth - 1.6) < 1e-6 && h.rims === 2));
});
test('a clevis: two flanges on one axis are two holes of their own depth, not one through the gap', () => {
  const faces = [...washer(2, 6, 1.6, 40, 0, 0), ...washer(2, 6, 1.6, 40, 0, 0, 11.6)];
  const holes = holesOf(bodyGeometry(model([{ name: 'clevis', faces }]), 0));
  assert.equal(holes.length, 2, JSON.stringify(holes));
  assert.ok(holes.every((h) => Math.abs(h.depth - 1.6) < 1e-6 && h.rims === 2), JSON.stringify(holes));
  // a fork: arms 10 thick and 1 apart (the gap thinner than an arm): two holes 10 deep, either
  // face order (the nearest rim either way paired across the gap: 1 and 21 deep)
  for (const order of [0, 1]) {
    const arms = [washer(2, 6, 10, 40, 0, 0), washer(2, 6, 10, 40, 0, 0, 11)];
    const fh = holesOf(bodyGeometry(model([{ name: 'fork', faces: (order ? arms.reverse() : arms).flat() }]), 0));
    assert.deepEqual(fh.map((h) => [Math.round(h.depth * 1e4) / 1e4, h.rims]), [[10, 2], [10, 2]], JSON.stringify(fh));
  }
});
test('a board face 57 mm across with a vertex 0.3 um off is flat (to a micrometre): its holes keep both rims', () => {
  const faces = washer(1.375, 28.5, 1.6, 40, 0, 0);
  const m = model([{ name: 'board', faces }]);
  // one bottom vertex (z 0) moved 0.3 um, as a board at hand stores 4 of 1,873
  const P = m.position;
  for (let i = 0; i < P.length; i += 3) if (P[i + 2] === 0 && Math.hypot(P[i], P[i + 1]) > 20) { P[i + 2] = 3e-4; break; }
  const h = holesOf(bodyGeometry(m, 0));
  assert.deepEqual(h.map((x) => x.rims), [2], JSON.stringify(h));
});
test('a flat tilted face 1 m from the origin is flat (no finer than float32 stores it)', () => {
  const faces = washer(1.375, 3, 1.6, 40, 0, 0);
  const m = model([{ name: 'far', faces }]);
  // turned 30° about x and moved 1000 mm, stored as float32 as a .cadmesh is
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6), P = m.position;
  for (let i = 0; i < P.length; i += 3) { const y = P[i + 1], z = P[i + 2]; P[i] += 1000; P[i + 1] = y * c - z * s + 1000; P[i + 2] = y * s + z * c + 1000; }
  m.position = Float32Array.from(P);
  assert.equal(holesOf(bodyGeometry(m, 0)).length, 1);
});
test('results: distance and deltas, the angle at a corner, face to face', () => {
  const d = distance([0, 0, 0], [3, 4, 12]);
  assert.equal(d.length, 13);
  assert.deepEqual(d.delta, [3, 4, 12]);
  assert.ok(Math.abs(angleAt([1, 0, 0], [0, 0, 0], [0, 5, 0]) - 90) < 1e-9);
  const top = { plane: { normal: [0, 0, 1], d: 1.6 }, points: [[0, 0, 1.6]] };
  const bottom = { plane: { normal: [0, 0, -1], d: 0 }, points: [[0, 0, 0], [5, 5, 0]] };
  assert.ok(Math.abs(faceGap(top, bottom).gap - 1.6) < 1e-9);
  const tilted = { plane: { normal: [Math.sin(0.06), 0, Math.cos(0.06)], d: 0 }, points: [[0, 0, 0]] };
  assert.ok(faceGap(top, tilted).notParallel > 3);
  assert.ok(faceGap({ plane: null, points: [] }, top).notPlanar);
});
test('ray cast: the washer top is hit, its hole is not; the face found by triangle', () => {
  const m = model([{ name: 'washer', faces: washer(1.6, 4, 1.6, 48) }]);
  const c = makeCaster(m);
  const h = c.cast([0], [3, 0, 10], [0, 0, -1]);
  assert.ok(h && Math.abs(h.t - 8.4) < 1e-5, JSON.stringify(h));
  assert.equal(faceOfTri(m.faces, m.header.meshes[0], h.tri), 0, 'the top face');
  assert.equal(c.cast([0], [0, 0, 10], [0, 0, -1]), null, 'down the bore');
  assert.equal(c.cast([0], [3, 0, 10], [0, 0, -1], 5), null, 'stops at tmax');
});
test(`the BVH (bodies over ${BVH_MIN} triangles) answers as the scan does`, () => {
  const n = 3000; // 4 faces x 2n triangles = 24,000
  const m = model([{ name: 'big', faces: washer(1.6, 4, 1.6, n) }]);
  const big = makeCaster(m);
  let agree = 0, hits = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 300; i++) {
    const o = [rnd() * 12 - 6, rnd() * 12 - 6, 10];
    const d = [rnd() * 0.4 - 0.2, rnd() * 0.4 - 0.2, -1];
    const a = big.cast([0], o, d);
    // an independent scan of every triangle (its own Möller-Trumbore)
    const I = m.index, Q = m.position;
    let best = Infinity;
    for (let t = 0; t < I.length / 3; t++) {
      const v = [0, 1, 2].map((j) => [Q[I[3 * t + j] * 3], Q[I[3 * t + j] * 3 + 1], Q[I[3 * t + j] * 3 + 2]]);
      const e1 = v[1].map((x, k) => x - v[0][k]), e2 = v[2].map((x, k) => x - v[0][k]);
      const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
      if (Math.abs(det) < 1e-20) continue;
      const s = o.map((x, k) => x - v[0][k]);
      const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const w = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
      if (w < 0 || u + w > 1) continue;
      const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (tt > 0 && tt < best) best = tt;
    }
    if (best < Infinity) hits++;
    if (Math.abs((a ? a.t : Infinity) - best) < 1e-9 || (!a && best === Infinity)) agree++;
  }
  assert.equal(big.built(), 1, 'the BVH was built');
  assert.ok(hits > 50, `only ${hits} rays hit: the arm would not test much`);
  assert.equal(agree, 300, `${agree}/300 agree (${hits} hit)`);
});

done();
