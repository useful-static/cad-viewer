// The nearest distance between two sets of triangles, exactly on the tessellation: Clearance's
// kernel (js/clearance.js) and the facts' test of whether two shells' surfaces meet (js/edges.js
// materialVolume). Its own module so the facts and Clearance both stand on it without importing
// each other (edges.js and clearance.js imported each other: safe only while neither used the
// other at load).
//
//   surfaceTree(pos, index, tris) -> a set's tree: a bounding-volume tree over its triangles
//     (tris: [[first, count], ...] ranges or a Uint32Array of triangle ids), boxes split at the
//     median of their longest axis, 2 to 4 triangles a leaf; built once, asked many times
//   treeDistance(pos, index, TA, TB, maxWork) -> { distance, pa, pb, triA, triB, pairs, work,
//     stopped } or null
//     when a set is empty: the two trees walked together, nearest box pair first, a pair skipped
//     when the boxes -- or the triangles' own boxes, or one triangle lying wholly beyond the
//     other's plane -- are already farther than the best; between two triangles 0 if an edge of
//     one pierces the other, else the least of the 6 vertex-to-triangle and 9 edge-to-edge
//     distances (Ericson, Real-Time Collision Detection, 5.1.5 and 5.1.9)
//   surfaceDistance(pos, index, trisA, trisB): both trees built, then treeDistance
//   triangleDistance(A, B), closestOnTriangle, closestSegments: the pieces
//
// Pure ES module, no DOM.

import { cross, dot, sub } from './vec3.js';

const LEAF = 4;

// Hoare-style select: order[lo..hi] partitioned so order[k] has the k-th centre on axis a
function nth(order, cen, a, lo, hi, k) {
  while (hi > lo) {
    const pv = cen[order[(lo + hi) >> 1] * 3 + a];
    let i = lo, j = hi;
    while (i <= j) {
      while (cen[order[i] * 3 + a] < pv) i++;
      while (cen[order[j] * 3 + a] > pv) j--;
      if (i <= j) { const t = order[i]; order[i] = order[j]; order[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return;
  }
}

// (typed throughout: the tree of 9.6 M triangles in JS arrays held 873 MB of script heap; boxes in
// the positions' own precision. A leaf holds 2 to 4 triangles -- a split of 5 or more leaves 2 at
// least each side -- so there are at most n nodes)
function buildIter(n, ids, box, cen, order) {
  const cap = Math.max(1, n);
  const F = box.constructor, nb = new F(6 * cap), first = new Uint32Array(cap), count = new Uint32Array(cap);
  const left = new Int32Array(cap).fill(-1), right = new Int32Array(cap).fill(-1);
  let nn = 0;
  const node = (lo, hi) => {
    const id = nn++, o6 = 6 * id;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const o = order[i] * 6;
      if (box[o] < x0) x0 = box[o]; if (box[o + 1] < y0) y0 = box[o + 1]; if (box[o + 2] < z0) z0 = box[o + 2];
      if (box[o + 3] > x1) x1 = box[o + 3]; if (box[o + 4] > y1) y1 = box[o + 4]; if (box[o + 5] > z1) z1 = box[o + 5];
    }
    nb[o6] = x0; nb[o6 + 1] = y0; nb[o6 + 2] = z0; nb[o6 + 3] = x1; nb[o6 + 4] = y1; nb[o6 + 5] = z1;
    first[id] = lo; count[id] = hi - lo;
    return id;
  };
  const root = n ? node(0, n) : -1;
  const stack = root < 0 ? [] : [root];
  while (stack.length) {
    const id = stack.pop();
    const lo = first[id], hi = lo + count[id];
    if (hi - lo <= LEAF) continue;
    const o6 = 6 * id, ex = nb[o6 + 3] - nb[o6], ey = nb[o6 + 4] - nb[o6 + 1], ez = nb[o6 + 5] - nb[o6 + 2];
    const a = ex >= ey ? (ex >= ez ? 0 : 2) : (ey >= ez ? 1 : 2);
    const mid = (lo + hi) >> 1;
    nth(order, cen, a, lo, hi - 1, mid);
    left[id] = node(lo, mid);
    right[id] = node(mid, hi);
    stack.push(left[id], right[id]);
  }
  // (each triangle's own box, in the tree's order: a pair pruned by them before it is measured -- a
  // leaf's box can be far looser than its triangles', a case's floor and wall together spanning the
  // cavity, and unpruned it was paired with every triangle of a board inside, 7.1 M pairs and 9.4 s)
  const tbox = new F(6 * n), tri = new Uint32Array(n);
  for (let i = 0; i < n; i++) { tbox.set(box.subarray(order[i] * 6, order[i] * 6 + 6), 6 * i); tri[i] = ids[order[i]]; }
  return { box: nb.subarray(0, 6 * nn), first, count, left, right, tri, tbox, root };
}

// squared distance between two boxes (0 when they overlap)
function boxDist2(A, i, B, j) {
  let d = 0;
  for (let a = 0; a < 3; a++) {
    const g = Math.max(A[i * 6 + a] - B[j * 6 + 3 + a], B[j * 6 + a] - A[i * 6 + 3 + a], 0);
    d += g * g;
  }
  return d;
}

const madd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// the point of triangle abc nearest p (Ericson 5.1.5)
export function closestOnTriangle(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return madd(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return madd(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return madd(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
  const den = 1 / (va + vb + vc);
  return madd(madd(a, ab, vb * den), ac, vc * den);
}

// the nearest points of segments p1q1 and p2q2 (Ericson 5.1.9)
export function closestSegments(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a <= 1e-30 && e <= 1e-30) return [p1, p2];
  if (a <= 1e-30) { s = 0; t = clamp01(f / e); } else {
    const c = dot(d1, r);
    if (e <= 1e-30) { t = 0; s = clamp01(-c / a); } else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den !== 0 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  return [madd(p1, d1, s), madd(p2, d2, t)];
}

// where segment pq crosses triangle abc, or null (Möller-Trumbore, both sides)
function segmentHits(p, q, a, b, c) {
  const d = sub(q, p), e1 = sub(b, a), e2 = sub(c, a);
  const h = cross(d, e2), det = dot(e1, h);
  // (parallel by the edges' own size, not an absolute 1e-18: two coplanar faces turned off the
  // axes leave float noise of 4e-16 there, and u, v, t of the noise read a crossing -- a pin 0.1 mm
  // in its bore read 0, the two triangles named 2.4 mm apart; a parallel edge goes to the distances)
  if (!(Math.abs(det) > 1e-9 * Math.sqrt(dot(d, d) * dot(e1, e1) * dot(e2, e2)))) return null;
  const inv = 1 / det, s = sub(p, a), u = dot(s, h) * inv;
  if (u < 0 || u > 1) return null;
  const qv = cross(s, e1), v = dot(d, qv) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = dot(e2, qv) * inv;
  return t >= 0 && t <= 1 ? madd(p, d, t) : null;
}

// a triangle's unit normal, or null when it has no area
function unitNormal(T) {
  const n = cross(sub(T[1], T[0]), sub(T[2], T[0])), l = Math.hypot(n[0], n[1], n[2]);
  return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : null;
}
// whether every corner of Y lies on one side of X's plane (unit normal n) at d or farther: then no
// point of Y is nearer X than d
function beyond(n, X, Y, d) {
  if (!n) return false;
  let mn = Infinity, mx = -Infinity;
  for (const p of Y) {
    const s = (p[0] - X[0][0]) * n[0] + (p[1] - X[0][1]) * n[1] + (p[2] - X[0][2]) * n[2];
    if (s < mn) mn = s;
    if (s > mx) mx = s;
  }
  return mn >= d || mx <= -d;
}

// distance² and the nearest points of two triangles
export function triangleDistance(A, B) {
  for (let i = 0; i < 3; i++) {
    const h = segmentHits(A[i], A[(i + 1) % 3], B[0], B[1], B[2]);
    if (h) return { d2: 0, pa: h, pb: h };
    const g = segmentHits(B[i], B[(i + 1) % 3], A[0], A[1], A[2]);
    if (g) return { d2: 0, pa: g, pb: g };
  }
  let best = { d2: Infinity, pa: null, pb: null };
  const take = (pa, pb) => { const v = sub(pa, pb), d2 = dot(v, v); if (d2 < best.d2) best = { d2, pa, pb }; };
  for (let i = 0; i < 3; i++) {
    take(A[i], closestOnTriangle(A[i], B[0], B[1], B[2]));
    take(closestOnTriangle(B[i], A[0], A[1], A[2]), B[i]);
    for (let j = 0; j < 3; j++) {
      const [x, y] = closestSegments(A[i], A[(i + 1) % 3], B[j], B[(j + 1) % 3]);
      take(x, y);
    }
  }
  return best;
}

// a set's tree (tris: [[first, count], ...] or a Uint32Array of triangle ids)
export function surfaceTree(pos, index, tris) {
  return buildIter(...prep(pos, index, tris));
}

export function surfaceDistance(pos, index, trisA, trisB) {
  return treeDistance(pos, index, surfaceTree(pos, index, trisA), surfaceTree(pos, index, trisB));
}

// (maxWork: the steps it may take -- each node pair taken from the heap and each triangle pair
// looked at, pruned or measured -- then it stops, stopped: true, its distance an upper bound;
// counting only the pairs measured let a turned wall and liner of 3.84 M triangles run 32.9 s on
// 2,163 of them. work: the steps taken)
export function treeDistance(pos, index, TA, TB, maxWork = Infinity) {
  if (TA.root < 0 || TB.root < 0) return null;
  const tri = (t) => [0, 1, 2].map((c) => { const v = index[t * 3 + c] * 3; return [pos[v], pos[v + 1], pos[v + 2]]; });
  let best = { d2: Infinity, pa: null, pb: null, triA: -1, triB: -1 };
  let pairs = 0, work = 0;
  const done = (b, stopped = false) => ({ distance: Math.sqrt(b.d2), pa: b.pa, pb: b.pb, triA: b.triA, triB: b.triB, pairs, work, stopped });
  // nearest pair first: a small binary heap on box distance
  const heap = [[boxDist2(TA.box, TA.root, TB.box, TB.root), TA.root, TB.root]];
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    if (++work > maxWork) return done(best, true);
    const [d2, a, b] = pop();
    if (d2 >= best.d2) break; // every pair left is at least as far
    const la = TA.left[a] < 0, lb = TB.left[b] < 0;
    if (la && lb) {
      for (let i = TA.first[a]; i < TA.first[a] + TA.count[a]; i++) {
        if (boxDist2(TA.tbox, i, TB.box, b) >= best.d2) continue;
        const ta = TA.tri[i], A = tri(ta), nA = unitNormal(A);
        for (let j = TB.first[b]; j < TB.first[b] + TB.count[b]; j++) {
          work++;
          if (boxDist2(TA.tbox, i, TB.tbox, j) >= best.d2) continue;
          const tb = TB.tri[j], Bt = tri(tb);
          // (and a pair one of whose triangles lies wholly beyond the other's plane by the best
          // distance or more: the boxes of a case's wall and a cylinder's slivers turned off the
          // axes span the cavity again -- a board in its case turned 30 and 20 degrees was 3.7 M
          // pairs, 6.6 s)
          if (best.d2 < Infinity) {
            const bd = Math.sqrt(best.d2);
            if (beyond(nA, A, Bt, bd) || beyond(unitNormal(Bt), Bt, A, bd)) continue;
          }
          pairs++;
          const r = triangleDistance(A, Bt);
          if (r.d2 < best.d2) best = { ...r, triA: ta, triB: tb };
          if (best.d2 === 0) return done(best);
        }
      }
      continue;
    }
    // split the bigger box (or the one that is not a leaf)
    const sizeA = la ? -1 : boxSize(TA.box, a), sizeB = lb ? -1 : boxSize(TB.box, b);
    if (sizeA >= sizeB) {
      for (const c of [TA.left[a], TA.right[a]]) { const d = boxDist2(TA.box, c, TB.box, b); if (d < best.d2) push([d, c, b]); }
    } else {
      for (const c of [TB.left[b], TB.right[b]]) { const d = boxDist2(TA.box, a, TB.box, c); if (d < best.d2) push([d, a, c]); }
    }
  }
  return done(best);
}

const boxSize = (B, i) => (B[i * 6 + 3] - B[i * 6]) + (B[i * 6 + 4] - B[i * 6 + 1]) + (B[i * 6 + 5] - B[i * 6 + 2]);

// buildIter's inputs for a set of triangle ranges ([[first, count], ...]) or a list of triangle ids
// (a Uint32Array)
function prep(pos, index, tris) {
  let ids = tris;
  if (!(tris instanceof Uint32Array)) {
    let n0 = 0;
    for (const [, c] of tris) n0 += c;
    ids = new Uint32Array(n0);
    let k = 0;
    for (const [s, c] of tris) for (let t = s; t < s + c; t++) ids[k++] = t;
  }
  const n = ids.length;
  // (float32 boxes are exact for float32 positions; any other array kept in float64)
  const F = pos instanceof Float32Array ? Float32Array : Float64Array;
  const box = new F(n * 6), cen = new F(n * 3);
  for (let i = 0; i < n; i++) {
    const t = ids[i];
    for (let a = 0; a < 3; a++) {
      let lo = Infinity, hi = -Infinity;
      for (let c = 0; c < 3; c++) { const v = pos[index[t * 3 + c] * 3 + a]; if (v < lo) lo = v; if (v > hi) hi = v; }
      box[i * 6 + a] = lo; box[i * 6 + 3 + a] = hi; cen[i * 3 + a] = (lo + hi) / 2;
    }
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  return [n, ids, box, cen, order];
}
