// CPU ray casting against a decoded model's bodies, in model coordinates, for Measure (the surface
// under the cursor, a snap's visibility) and windsAgainstNormals (export, Clearance). A body over
// BVH_MIN triangles through a median-split tree (8 a leaf) built on its first query. Pure, no DOM.

export const BVH_MIN = 10_000;
const LEAF = 8;

// Möller-Trumbore, both faces: t along o + t d of triangle t, or Infinity
function hitTri(P, I, t, o, d) {
  const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
  const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-20) return Infinity;
  const inv = 1 / det;
  const sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return tt > 0 ? tt : Infinity;
}

// How near the ray o + t d meets triangle t to the triangle's border: the least of its three
// barycentric weights at the hit (0 on an edge or a corner), or -1 when it misses. A parity walk
// whose ray meets a triangle there cannot tell a crossing from a graze (js/measure-ui.js)
export function edgeNearness(P, I, t, o, d) {
  const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
  const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
  const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-20) return -1;
  const s = [o[0] - P[a], o[1] - P[a + 1], o[2] - P[a + 2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
  return Math.min(u, v, 1 - u - v);
}

// Whether the ray o + t d meets triangle t on its inside, the view's own cut test (the vertex normals
// interpolated at the hit, as FS_SHADE's); null when it misses the triangle's plane.
export function seesInside(P, N, I, t, o, d) {
  const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
  const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-20) return null;
  const inv = 1 / det;
  const sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  const w = 1 - u - v, na = I[3 * t] * 4, nb = I[3 * t + 1] * 4, nc = I[3 * t + 2] * 4;
  let s = 0;
  for (let k = 0; k < 3; k++) s += (w * N[na + k] + u * N[nb + k] + v * N[nc + k]) * d[k];
  return s > 0;
}

// Whether triangle a, b, c is wound against its vertex normals' sum (export-mesh.js bodyOf, clearance.js)
export function windsAgainstNormals(P, N, a, b, c) {
  const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
  const sx = N[4 * a] + N[4 * b] + N[4 * c], sy = N[4 * a + 1] + N[4 * b + 1] + N[4 * c + 1], sz = N[4 * a + 2] + N[4 * b + 2] + N[4 * c + 2];
  return (uy * vz - uz * vy) * sx + (uz * vx - ux * vz) * sy + (ux * vy - uy * vx) * sz < 0;
}

// slab test: the entry t of a box, or Infinity
function hitBox(lo, hi, o, inv, tmax) {
  let t0 = 0, t1 = tmax;
  for (let k = 0; k < 3; k++) {
    let a = (lo[k] - o[k]) * inv[k], b = (hi[k] - o[k]) * inv[k];
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

function buildBvh(P, I, t0, nt) {
  const tris = new Uint32Array(nt);
  const cen = new Float32Array(nt * 3);
  for (let i = 0; i < nt; i++) {
    const t = t0 + i;
    tris[i] = t;
    for (let k = 0; k < 3; k++) cen[3 * i + k] = (P[I[3 * t] * 3 + k] + P[I[3 * t + 1] * 3 + k] + P[I[3 * t + 2] * 3 + k]) / 3;
  }
  const order = new Uint32Array(nt);
  for (let i = 0; i < nt; i++) order[i] = i;
  // order[s..e) partitioned in place about its k-th centroid on axis ax (quickselect): the median
  // split a sort found, in linear time -- the sort at every node built the rack's 846k-triangle frame
  // in 2.3 s on the page's thread (R151-1)
  const select = (s, e, k, ax) => {
    let lo = s, hi = e - 1;
    while (hi > lo) {
      const pv = cen[3 * order[(lo + hi) >> 1] + ax];
      let i = lo, j = hi;
      while (i <= j) {
        while (cen[3 * order[i] + ax] < pv) i++;
        while (cen[3 * order[j] + ax] > pv) j--;
        if (i <= j) { const t = order[i]; order[i] = order[j]; order[j] = t; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else break;
    }
  };
  const nodes = [];
  const box = (s, e) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = s; i < e; i++) {
      const t = tris[order[i]];
      for (let j = 0; j < 3; j++) {
        const v = I[3 * t + j] * 3;
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[v + k]); hi[k] = Math.max(hi[k], P[v + k]); }
      }
    }
    return [lo, hi];
  };
  // (a leaf's box from its triangles, a parent's the union of its children's, the split axis the
  // centroids' widest: every node's box read every triangle under it -- R151-1)
  const build = (s, e) => {
    const n = { lo: null, hi: null, s, e, l: -1, r: -1 };
    const idx = nodes.length;
    nodes.push(n);
    if (e - s <= LEAF) { [n.lo, n.hi] = box(s, e); return idx; }
    const cl = [Infinity, Infinity, Infinity], ch = [-Infinity, -Infinity, -Infinity];
    for (let i = s; i < e; i++) for (let k = 0; k < 3; k++) { const v = cen[3 * order[i] + k]; if (v < cl[k]) cl[k] = v; if (v > ch[k]) ch[k] = v; }
    const ax = ch[1] - cl[1] > ch[0] - cl[0] ? (ch[2] - cl[2] > ch[1] - cl[1] ? 2 : 1) : (ch[2] - cl[2] > ch[0] - cl[0] ? 2 : 0);
    const mid = (s + e) >> 1;
    select(s, e, mid, ax);
    n.l = build(s, mid);
    n.r = build(mid, e);
    const a = nodes[n.l], b = nodes[n.r];
    n.lo = [0, 1, 2].map((k) => Math.min(a.lo[k], b.lo[k]));
    n.hi = [0, 1, 2].map((k) => Math.max(a.hi[k], b.hi[k]));
    return idx;
  };
  build(0, nt);
  return { nodes, tris: Uint32Array.from(order, (i) => tris[i]) };
}

// One caster per model: caches each big body's BVH.
// model: { position, index, header: { meshes } }
export function makeCaster(model) {
  const P = model.position, I = model.index, meshes = model.header.meshes;
  const bvh = new Map();
  // nearest hit on body mi (mesh index) along o + t d, t in (0, tmax): { t, tri } | null
  function body(mi, o, d, tmax = Infinity, skip = null) {
    const m = meshes[mi];
    const t0 = m.idxStart / 3, nt = m.idxCount / 3;
    let best = tmax, bt = -1;
    // (skip(point) says whether a hit there is not there to hit -- the cut side of a section: judged
    // at the hit, as the view cuts each pixel, not by the triangle)
    const test = (t) => {
      const h = hitTri(P, I, t, o, d);
      if (!(h < best)) return;
      if (skip && skip([o[0] + h * d[0], o[1] + h * d[1], o[2] + h * d[2]])) return;
      best = h; bt = t;
    };
    if (nt < BVH_MIN) {
      for (let t = t0; t < t0 + nt; t++) test(t);
    } else {
      if (!bvh.has(mi)) bvh.set(mi, buildBvh(P, I, t0, nt));
      const { nodes, tris } = bvh.get(mi);
      const inv = d.map((v) => (v !== 0 ? 1 / v : 1e30));
      const stack = [0];
      while (stack.length) {
        const n = nodes[stack.pop()];
        if (hitBox(n.lo, n.hi, o, inv, best) === Infinity) continue;
        if (n.l < 0) for (let i = n.s; i < n.e; i++) test(tris[i]);
        else stack.push(n.l, n.r);
      }
    }
    return bt >= 0 ? { t: best, tri: bt } : null;
  }
  // nearest hit among bodies (mesh indices) -> { t, tri, mesh } | null
  function cast(bodies, o, d, tmax = Infinity, skip = null) {
    let best = null;
    for (const mi of bodies) {
      const h = body(mi, o, d, best ? best.t : tmax, skip);
      if (h) best = { ...h, mesh: mi };
    }
    return best;
  }
  // warm(mi): body mi's tree built ahead of its first ray (Measure's idle slices: R150-4)
  const warm = (mi) => { const m = meshes[mi]; if (m.idxCount / 3 >= BVH_MIN && !bvh.has(mi)) bvh.set(mi, buildBvh(P, I, m.idxStart / 3, m.idxCount / 3)); };
  return { cast, body, warm, built: () => bvh.size };
}

// The b-rep face a triangle belongs to (a global face number), by binary
// search of the faces section's (first, count) pairs within the body's range
export function faceOfTri(faces, m, tri) {
  if (!faces || !m.faceCount) return -1;
  let lo = m.faceStart, hi = m.faceStart + m.faceCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f0 = faces[2 * mid], n = faces[2 * mid + 1];
    if (tri < f0) hi = mid - 1;
    else if (tri >= f0 + n) lo = mid + 1;
    else return mid;
  }
  return -1;
}
