#!/usr/bin/env node
// Measure's geometry (js/measure-geom.js) and ray caster (js/raycast.js) on
// bodies built here the way OpenCascade meshes them: every b-rep face its own
// vertices, shared boundary points with identical floats, a faces section.
//   node tests/test-measure.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { angleAt, bodyGeometry, circleMinPoints, circleOf, distance, faceGap, holesOf, polyMid } from '../js/measure-geom.js';
import { BVH_MIN, faceOfTri, makeCaster } from '../js/raycast.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

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
function washer(ri, ro, h, n, cx = 0, cy = 0) {
  const ring = (r, z) => Array.from({ length: n }, (_, i) => P(cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n), z));
  const it = ring(ri, h), ot = ring(ro, h), ib = ring(ri, 0), ob = ring(ro, 0);
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
  assert.ok(Math.abs(holes[1].centre[0] - holes[0].centre[0] - 0) < 1e-4 || Math.abs(Math.abs(holes[1].centre[0] - holes[0].centre[0]) - 58) < 1e-4);
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

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
