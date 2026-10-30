// Clearance (feature review item 18): the smallest distance between two sets
// of triangles -- a board and the case around it, two boards -- and the two
// points where it is, exactly on the tessellation. 0 means they touch or
// overlap (a pierced triangle, a shared face).
//
// Each set gets a bounding-volume tree over its triangles (boxes split at the
// median of their longest axis, 4 triangles a leaf); the two trees are walked
// together, nearest box pair first, and a pair whose boxes are already
// farther apart than the best distance found is skipped. Between two
// triangles: 0 if an edge of one pierces the other, else the least of the 6
// vertex-to-triangle and 9 edge-to-edge distances (Ericson, Real-Time
// Collision Detection, 5.1.5 and 5.1.9).
//
// Pure ES module, no DOM.

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

function buildIter(n, ids, box, cen, order) {
  const nb = [], first = [], count = [], left = [], right = [];
  const node = (lo, hi) => {
    const id = first.length;
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      const o = order[i] * 6;
      for (let a = 0; a < 3; a++) { if (box[o + a] < b[a]) b[a] = box[o + a]; if (box[o + 3 + a] > b[3 + a]) b[3 + a] = box[o + 3 + a]; }
    }
    nb.push(...b); first.push(lo); count.push(hi - lo); left.push(-1); right.push(-1);
    return id;
  };
  const root = n ? node(0, n) : -1;
  const stack = root < 0 ? [] : [root];
  while (stack.length) {
    const id = stack.pop();
    const lo = first[id], hi = lo + count[id];
    if (hi - lo <= LEAF) continue;
    const b = nb.slice(id * 6, id * 6 + 6);
    const a = [0, 1, 2].reduce((m, x) => (b[3 + x] - b[x] > b[3 + m] - b[m] ? x : m), 0);
    const mid = (lo + hi) >> 1;
    nth(order, cen, a, lo, hi - 1, mid);
    left[id] = node(lo, mid);
    right[id] = node(mid, hi);
    stack.push(left[id], right[id]);
  }
  return { box: Float64Array.from(nb), first, count, left, right, tri: Uint32Array.from(order, (i) => ids[i]), root };
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

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
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
  if (Math.abs(det) < 1e-18) return null;
  const inv = 1 / det, s = sub(p, a), u = dot(s, h) * inv;
  if (u < 0 || u > 1) return null;
  const qv = cross(s, e1), v = dot(d, qv) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = dot(e2, qv) * inv;
  return t >= 0 && t <= 1 ? madd(p, d, t) : null;
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

// pos: Float32Array xyz, index: Uint32Array triangles; trisA, trisB:
// [[firstTriangle, count], ...]. Returns { distance, pa, pb, triA, triB,
// pairs } (pairs: triangle pairs tested), or null when a set is empty.
export function clearance(pos, index, trisA, trisB) {
  const TA = buildIter(...prep(pos, index, trisA));
  const TB = buildIter(...prep(pos, index, trisB));
  if (TA.root < 0 || TB.root < 0) return null;
  const tri = (t) => [0, 1, 2].map((c) => { const v = index[t * 3 + c] * 3; return [pos[v], pos[v + 1], pos[v + 2]]; });
  let best = { d2: Infinity, pa: null, pb: null, triA: -1, triB: -1 };
  let pairs = 0;
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
    const [d2, a, b] = pop();
    if (d2 >= best.d2) break; // every pair left is at least as far
    const la = TA.left[a] < 0, lb = TB.left[b] < 0;
    if (la && lb) {
      for (let i = TA.first[a]; i < TA.first[a] + TA.count[a]; i++) {
        const ta = TA.tri[i], A = tri(ta);
        for (let j = TB.first[b]; j < TB.first[b] + TB.count[b]; j++) {
          const tb = TB.tri[j];
          pairs++;
          const r = triangleDistance(A, tri(tb));
          if (r.d2 < best.d2) best = { ...r, triA: ta, triB: tb };
          if (best.d2 === 0) return done(best, pairs);
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
  return done(best, pairs);
}

const done = (b, pairs) => ({ distance: Math.sqrt(b.d2), pa: b.pa, pb: b.pb, triA: b.triA, triB: b.triB, pairs });
const boxSize = (B, i) => (B[i * 6 + 3] - B[i * 6]) + (B[i * 6 + 4] - B[i * 6 + 1]) + (B[i * 6 + 5] - B[i * 6 + 2]);

// buildIter's inputs for a set of triangle ranges
function prep(pos, index, tris) {
  let n = 0;
  for (const [, c] of tris) n += c;
  const ids = new Uint32Array(n);
  let k = 0;
  for (const [s, c] of tris) for (let t = s; t < s + c; t++) ids[k++] = t;
  const box = new Float64Array(n * 6), cen = new Float64Array(n * 3);
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
