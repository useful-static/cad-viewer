#!/usr/bin/env node
// Geometry kernels with no test file of their own: which side of a triangle a ray sees
// (js/raycast.js seesInside), triangle and surface distances (js/tri-distance.js) and the 2D
// nearest-item search (js/box-tree.js). Arms written for round 112's mutation survivors.
//   node tests/test-geom.mjs   -> "RESULT: N passed, 0 failed"

import assert from 'node:assert/strict';
import { seesInside } from '../js/raycast.js';
import { closestOnTriangle, closestSegments, surfaceDistance, triangleDistance } from '../js/tri-distance.js';
import { boxTree, nearestItem } from '../js/box-tree.js';
import { test, done } from './harness.mjs';

// (r112 M raycast-O68) seesInside interpolates the vertex normals at the hit's barycentric
// coordinates: checked against a reference that finds the hit by the plane and the areas
test('seesInside reads the normals at the true hit point of a tilted triangle (r112 M raycast-O68)', () => {
  const P = new Float32Array([0, 0, 0, 1, 0, 1, 0, 1, 0.5]), I = new Uint32Array([0, 1, 2]);
  const N = new Int16Array([30000, 0, 9000, 0, -20000, 20000, 9000, 0, 9000, -25000, 15000, 0]);
  const V = [0, 1, 2].map((i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
  const sub = (a, b) => a.map((x, k) => x - b[k]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const n = cross(sub(V[1], V[0]), sub(V[2], V[0])), area = dot(n, n);
  const reference = (o, d) => {
    const t = dot(n, sub(V[0], o)) / dot(n, d), h = o.map((x, k) => x + t * d[k]);
    // barycentric weights by the sub-triangles' signed areas
    const w = [dot(n, cross(sub(V[1], h), sub(V[2], h))) / area, dot(n, cross(sub(V[2], h), sub(V[0], h))) / area, dot(n, cross(sub(V[0], h), sub(V[1], h))) / area];
    let s = 0;
    for (let k = 0; k < 3; k++) s += (w[0] * N[k] + w[1] * N[4 + k] + w[2] * N[8 + k]) * d[k];
    return s > 0;
  };
  let x = 112;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 - 0.5; };
  let got = '', ones = 0;
  for (let i = 0; i < 60; i++) {
    const t = [0.3 + rnd() * 0.5, 0.3 + rnd() * 0.5], o = [t[0] + rnd() * 6, t[1] + rnd() * 6, 4 + rnd() * 6];
    const d = [t[0], t[1], 0.5 * t[0] + 0.25 * t[1]].map((v, k) => v - o[k]);
    const r = seesInside(P, N, I, 0, o, d);
    assert.equal(r, reference(o, d), `ray ${i}`);
    got += r ? '1' : '0';
    if (r) ones++;
  }
  assert.ok(ones > 5 && ones < 55, 'the rays see both sides');
  assert.equal(got, '010010001010000000000001100001111001010000000011000010001010');
});

// (r112 M tri-distance-O85) a point over a triangle's inside comes down onto the face, not an edge
test('the nearest point of a triangle to a point over its inside is the foot on the face (r112 M tri-distance-O85)', () => {
  assert.deepEqual(closestOnTriangle([0.3, 0.3, 1], [0, 0, 0], [1, 0, 0], [0, 1, 0]), [0.3, 0.3, 0]);
  assert.deepEqual(closestOnTriangle([3, 3, 5], [0, 0, 0], [10, 0, 0], [0, 10, 0]), [3, 3, 0]);
  assert.deepEqual(closestOnTriangle([2, 2, 1], [0, 0, 0], [1, 0, 0], [0, 1, 0]), [0.5, 0.5, 0], 'past BC: the edge');
});
// (r112 M tri-distance-R6) two triangles that pierce each other are 0 apart
test('two triangles piercing each other are 0 apart, at the crossing (r112 M tri-distance-R6)', () => {
  const r = triangleDistance([[0, 0, 0], [4, 0, 0], [0, 4, 0]], [[1, 1, -1], [1, 1, 1], [3, -2, 0.5]]);
  assert.equal(r.d2, 0);
  assert.equal(r.pa[2], 0, 'the crossing lies in the flat triangle\'s plane');
  // and two that do not touch: their true gap
  const s = triangleDistance([[0, 0, 0], [4, 0, 0], [0, 4, 0]], [[1, 1, 1], [2, 1, 1], [1, 2, 1]]);
  assert.ok(Math.abs(s.d2 - 1) < 1e-12);
});
// (r112 M tri-distance-O9) the smallest sets, one triangle each, build their trees and measure
test('surfaceDistance of one triangle against one triangle (r112 M tri-distance-O9)', () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 3, 1, 0, 3, 0, 1, 3]);
  const r = surfaceDistance(pos, new Uint32Array([0, 1, 2, 3, 4, 5]), [[0, 1]], [[1, 1]]);
  assert.equal(r.distance, 3);
  assert.equal(r.triA, 0);
  assert.equal(r.triB, 1);
});

// (r114 M3 tri-distance-C41) two edges crossing 2 mm apart (one along x at z = 0, one along y at z = 2,
// over (5, 5)): their nearest points are the crossing's, and two fins carrying them are 2 apart -- the
// degenerate branch (a second segment of no length) is for a point only, which it still handles
test('closestSegments of edges crossing 2 mm apart, and two fins carrying them 2 apart (r114 M3 tri-distance-C41)', () => {
  const near = (u, v) => u.every((x, i) => Math.abs(x - v[i]) < 1e-9);
  const [p, q] = closestSegments([0, 5, 0], [10, 5, 0], [5, 0, 2], [5, 10, 2]);
  assert.ok(near(p, [5, 5, 0]) && near(q, [5, 5, 2]), JSON.stringify([p, q]));
  const t = triangleDistance([[0, 5, 0], [10, 5, 0], [5, 5, -6]], [[5, 0, 2], [5, 10, 2], [5, 5, 8]]);
  assert.ok(Math.abs(Math.sqrt(t.d2) - 2) < 1e-9, String(Math.sqrt(t.d2)));
  // (must-accept arm of the degenerate branch: a segment against a point)
  const [a, b] = closestSegments([0, 0, 0], [10, 0, 0], [3, 4, 0], [3, 4, 0]);
  assert.ok(near(a, [3, 0, 0]) && near(b, [3, 4, 0]), JSON.stringify([a, b]));
});
// (r112 M box-tree-O86) of two items equally near, nearestItem gives the lower id (its tie rule)
test('nearestItem breaks a distance tie by the lower id (r112 M box-tree-O86)', () => {
  const pts = new Float64Array([-1, 0, 1, 0]);
  const dist = (t) => Math.hypot(pts[2 * t], pts[2 * t + 1]);
  const tree = boxTree(pts, Uint32Array.from([0, 1]), 2, true);
  assert.equal(nearestItem([tree], [0, 0], 5, dist), 0);
  // the same two items listed the other way round: still the lower id
  const tree2 = boxTree(pts, Uint32Array.from([1, 0]), 2, true);
  assert.equal(nearestItem([tree2], [0, 0], 5, dist), 0);
  assert.equal(nearestItem([tree], [0.5, 0], 5, (t) => Math.hypot(pts[2 * t] - 0.5, pts[2 * t + 1])), 1, 'the nearer when not tied');
});

done();
