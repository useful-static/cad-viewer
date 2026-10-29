// CPU ray casting against a decoded model's bodies, for Measure: the surface
// point under the cursor, and whether a snap candidate is visible (nothing in
// front of it on the segment from the eye). Bodies carry no transform, so
// rays are cast in model coordinates. A body over BVH_MIN triangles is
// queried through a bounding-volume hierarchy built on its first query
// (median split, 8 triangles a leaf); smaller ones are scanned.
// Moved from tests/webgpu-offscreen.html's Möller-Trumbore scan. Pure, no DOM.

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
  const order = Array.from({ length: nt }, (_, i) => i);
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
  const build = (s, e) => {
    const [lo, hi] = box(s, e);
    const n = { lo, hi, s, e, l: -1, r: -1 };
    const idx = nodes.length;
    nodes.push(n);
    if (e - s > LEAF) {
      const ax = [0, 1, 2].reduce((m, k) => (hi[k] - lo[k] > hi[m] - lo[m] ? k : m), 0);
      const part = order.slice(s, e).sort((x, y) => cen[3 * x + ax] - cen[3 * y + ax]);
      for (let i = s; i < e; i++) order[i] = part[i - s];
      const mid = (s + e) >> 1;
      n.l = build(s, mid);
      n.r = build(mid, e);
    }
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
    const test = (t) => {
      if (skip && skip(t)) return;
      const h = hitTri(P, I, t, o, d);
      if (h < best) { best = h; bt = t; }
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
  return { cast, body, built: () => bvh.size };
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
