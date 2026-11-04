// The viewer's one answer to "where is this point, against these closed surfaces": which shells of
// a body lie in which (the mesh weld's turning of a shell, js/edges.js shellTurns) and whether a
// point is inside a solid (Clearance's part wholly inside one, js/clearance.js). (Each had its
// own: a linear ray cast in edges.js, 149.6 s for a 2.02 M-triangle enclosure holding 2,000 parts,
// and a parity over the whole body in clearance.js that read a point in the overlap of two shells
// as outside.) Pure, no DOM.
//
//   solidIndex(P, I, tris) -> one shell's triangles (ids into I, three corners each into P, float
//     xyz) indexed along three fixed ray directions: each triangle's box across each ray in the
//     one box tree (js/box-tree.js), so a ray meets only the triangles over its foot
//   crossingsAt(index, p) -> { inside, touch }: whether p is inside that shell, by the parity of
//     each ray's crossings and the majority of the three (one ray through an edge or a corner of
//     the surface counts it twice: 266 of 981 points read outside along a face's diagonal), and
//     touch, whether p lies on the surface (within float32's reach of the shell's size: no answer)
//   nesting(P, I, shell, ns, open) -> for a body's shells (shell: per triangle, -1 for none; open:
//     per shell, 1 when it is open), each closed shell's nearest holder (parent: the smallest
//     closed shell that WHOLLY holds it -- its box within the other's, and most of up to three
//     points on it, the centroids of its largest triangles, inside it; a point on the other's
//     surface passed over for the next), its outer shell (root), whether shells it lies in have
//     more than one outer shell (roots), whether an open shell's box holds it (inOpen), each
//     shell's signed volume (V), and inside(p): whether p is in the body's material -- the shells
//     holding p, each +1 when it is wound as its outer shell is and -1 when against it (a cavity),
//     summed, above 0. (An open shell never holds a part: by one ray it held a cube upright and
//     not upside down.) Two overlapping shells hold their overlap; a cavity's inside is outside; a
//     part embedded in another, wound as it is, is material, as the facts' volume and the view's
//     cut fill take it.

import { boxTree, itemsAt } from './box-tree.js';

// three fixed directions no CAD axis or face lies along, and for each two unit vectors across it
const RAYS = [[0.3141592, 0.5772156, 0.7536422], [-0.6180339, 0.2718281, 0.4142135], [0.1732050, -0.7071067, 0.3010299]].map((d) => {
  const l = Math.hypot(...d), r = d.map((x) => x / l);
  const a = Math.abs(r[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const u0 = cr(r, a), lu = Math.hypot(...u0), U = u0.map((x) => x / lu);
  return { d: r, U, W: cr(r, U) };
});
// a point this close to a surface, against the shell's size, is on it: float32's reach and a margin
// (1e-9 was finer than the positions themselves: a plate resting on a cube, turned off the axes,
// read as crossing it in 29 of 200)
const TOUCH = 1e-6;

export function solidIndex(P, I, tris) {
  const n = tris.length;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) {
    const v = 3 * I[3 * tris[k] + c];
    for (let a = 0; a < 3; a++) { if (P[v + a] < lo[a]) lo[a] = P[v + a]; if (P[v + a] > hi[a]) hi[a] = P[v + a]; }
  }
  const trees = RAYS.map(({ U, W }) => {
    const B = new Float64Array(4 * n), ids = [];
    for (let k = 0; k < n; k++) {
      const t = tris[k];
      let u0 = Infinity, w0 = Infinity, u1 = -Infinity, w1 = -Infinity;
      for (let c = 0; c < 3; c++) {
        const v = 3 * I[3 * t + c], x = P[v], y = P[v + 1], z = P[v + 2];
        const u = x * U[0] + y * U[1] + z * U[2], w = x * W[0] + y * W[1] + z * W[2];
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (w < w0) w0 = w; if (w > w1) w1 = w;
      }
      B[4 * k] = u0; B[4 * k + 1] = w0; B[4 * k + 2] = u1; B[4 * k + 3] = w1;
      if (Number.isFinite(u0 + w0 + u1 + w1)) ids.push(k);
    }
    return boxTree(B, Uint32Array.from(ids), 2);
  });
  return { P, I, tris, lo, hi, trees };
}

export function crossingsAt(index, p) {
  const { P, I, tris } = index;
  const span = Math.hypot(index.hi[0] - index.lo[0], index.hi[1] - index.lo[1], index.hi[2] - index.lo[2]) || 1;
  const eps = span * TOUCH;
  let odd = 0, touch = false;
  for (let r = 0; r < 3; r++) {
    // (two rays that agree are the majority: the third not cast)
    if (r === 2 && (odd === 0 || odd === 2)) break;
    const { d: [dx, dy, dz], U, W } = RAYS[r];
    let n = 0;
    const pu = p[0] * U[0] + p[1] * U[1] + p[2] * U[2], pw = p[0] * W[0] + p[1] * W[1] + p[2] * W[2];
    itemsAt(index.trees[r], [pu, pw], (k) => {
      const t = tris[k], a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
      const det = e1x * hx + e1y * hy + e1z * hz;
      if (det === 0) return;
      const sx = p[0] - P[a], sy = p[1] - P[a + 1], sz = p[2] - P[a + 2];
      const u = (sx * hx + sy * hy + sz * hz) / det;
      if (u < 0 || u > 1) return;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) / det;
      if (v < 0 || u + v > 1) return;
      const tt = (e2x * qx + e2y * qy + e2z * qz) / det;
      if (Math.abs(tt) <= eps) { touch = true; return; }
      if (tt > 0) n++;
    });
    if (touch) return { inside: false, touch };
    if (n % 2 === 1) odd++;
  }
  return { inside: odd >= 2, touch };
}

export function nesting(P, I, shell, ns, open = new Uint8Array(ns)) {
  const nt = shell.length;
  // per shell: its box, its triangles (a typed list, grouped by shell), its 8 largest triangles,
  // its signed volume (centred on the body's box)
  const lo = new Float64Array(3 * ns).fill(Infinity), hi = new Float64Array(3 * ns).fill(-Infinity);
  const start = new Uint32Array(ns + 1);
  for (let t = 0; t < nt; t++) if (shell[t] >= 0) start[shell[t] + 1]++;
  for (let s = 0; s < ns; s++) start[s + 1] += start[s];
  const at = start.slice(0, ns), list = new Uint32Array(start[ns]);
  const NB = 8, big = new Int32Array(NB * ns).fill(-1), bigA = new Float64Array(NB * ns);
  const V = new Float64Array(ns);
  let cx = 0, cy = 0, cz = 0;
  { // (the centre the volumes are taken about: any one; the body's first corner's box middle)
    const bl = [Infinity, Infinity, Infinity], bh = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < I.length; i++) for (let k = 0; k < 3; k++) { const x = P[3 * I[i] + k]; if (x < bl[k]) bl[k] = x; if (x > bh[k]) bh[k] = x; }
    cx = (bl[0] + bh[0]) / 2; cy = (bl[1] + bh[1]) / 2; cz = (bl[2] + bh[2]) / 2;
  }
  for (let t = 0; t < nt; t++) {
    const s = shell[t];
    if (s < 0) continue;
    list[at[s]++] = t;
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    for (let k = 0; k < 3; k++) {
      const x = P[a + k], y = P[b + k], z = P[c + k];
      const mn = x < y ? (x < z ? x : z) : (y < z ? y : z), mx = x > y ? (x > z ? x : z) : (y > z ? y : z);
      if (mn < lo[3 * s + k]) lo[3 * s + k] = mn;
      if (mx > hi[3 * s + k]) hi[3 * s + k] = mx;
    }
    const ax = P[a] - cx, ay = P[a + 1] - cy, az = P[a + 2] - cz, bx = P[b] - cx, by = P[b + 1] - cy, bz = P[b + 2] - cz, qx = P[c] - cx, qy = P[c + 1] - cy, qz = P[c + 2] - cz;
    V[s] += (ax * (by * qz - bz * qy) + ay * (bz * qx - bx * qz) + az * (bx * qy - by * qx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az, wx = qx - ax, wy = qy - ay, wz = qz - az;
    const area = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    // (kept in order, largest first)
    for (let j = 0; j < NB; j++) {
      if (big[NB * s + j] < 0 || area > bigA[NB * s + j]) {
        for (let m = NB - 1; m > j; m--) { big[NB * s + m] = big[NB * s + m - 1]; bigA[NB * s + m] = bigA[NB * s + m - 1]; }
        big[NB * s + j] = t; bigA[NB * s + j] = area;
        break;
      }
    }
  }
  const solids = new Map(); // (a shell's crossing index, built when first asked)
  const solidOf = (o) => { let x = solids.get(o); if (!x) { x = solidIndex(P, I, list.subarray(start[o], start[o + 1])); solids.set(o, x); } return x; };
  const boxIn = (s, o) => { for (let k = 0; k < 3; k++) if (lo[3 * s + k] < lo[3 * o + k] || hi[3 * s + k] > hi[3 * o + k]) return false; return true; };
  const boxVol = (o) => (hi[3 * o] - lo[3 * o]) * (hi[3 * o + 1] - lo[3 * o + 1]) * (hi[3 * o + 2] - lo[3 * o + 2]);
  const within = (s, o) => {
    let yes = 0, asked = 0;
    for (let j = 0; j < NB && asked < 3; j++) {
      const t = big[NB * s + j];
      if (t < 0) break;
      const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
      const p = [(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3];
      const { inside, touch } = crossingsAt(solidOf(o), p);
      if (touch) continue; // (on the other's surface: no answer, the next point asked)
      asked++;
      if (inside) yes++;
      if (asked - yes >= 2) return false; // (the majority of three already against)
      if (yes >= 2) return true;
    }
    return asked > 0 && yes * 2 > asked;
  };
  const parent = new Int32Array(ns).fill(-1), inOpen = new Uint8Array(ns);
  const others = new Array(ns); // (holders that are no ancestor of the parent: a second outer shell)
  const closed = [];
  for (let s = 0; s < ns; s++) if (!open[s]) closed.push(s);
  if (ns > 1) {
    // the shells' boxes in the one box tree (3-d): the shells that may hold one, found without a
    // pass over every shell (each against each: 10.7 s for 20,000 cubes; an index on x alone,
    // 7.0 s for 20,000 stacked along y)
    const B = new Float64Array(6 * ns);
    for (let s = 0; s < ns; s++) for (let k = 0; k < 3; k++) { B[6 * s + k] = lo[3 * s + k]; B[6 * s + 3 + k] = hi[3 * s + k]; }
    const tree = boxTree(B, Uint32Array.from({ length: ns }, (_, s) => s), 3);
    const c = [0, 0, 0];
    let cands = [], cur = -1;
    const take = (o) => {
      if (o === cur || !boxIn(cur, o)) return;
      if (open[o]) inOpen[cur] = 1; else cands.push(o);
    };
    for (const s of closed) {
      for (let k = 0; k < 3; k++) c[k] = (lo[3 * s + k] + hi[3 * s + k]) / 2;
      cur = s;
      if (cands.length) cands = [];
      itemsAt(tree, c, take);
      if (!cands.length) continue;
      // the nearest holder first, by its box's volume, and none asked that holds the holder's box
      // (an ancestor: concentric shells asked each against each were 147 s for 8,000)
      const tried = new Uint8Array(cands.length);
      while (parent[s] < 0) {
        let m = -1;
        for (let j = 0; j < cands.length; j++) if (!tried[j] && (m < 0 || boxVol(cands[j]) < boxVol(cands[m]))) m = j;
        if (m < 0) break;
        tried[m] = 1;
        if (within(s, cands[m])) parent[s] = cands[m];
      }
      if (parent[s] < 0) continue;
      // (then the others that hold it but are no ancestor of its parent: a second outer shell)
      for (let j = 0; j < cands.length; j++) {
        const o = cands[j];
        if (tried[j] || boxIn(parent[s], o)) continue;
        if (within(s, o)) (others[s] ||= []).push(o);
      }
    }
  }
  // each shell's outer shell (root) by its parents, and every outer shell of the shells it lies in
  const root = new Int32Array(ns).fill(-2);
  const rootOf = (s) => {
    const path = [];
    let x = s;
    while (root[x] === -2 && parent[x] >= 0 && path.length <= ns) { path.push(x); x = parent[x]; }
    const r = root[x] !== -2 ? root[x] : x;
    if (root[x] === -2) root[x] = r;
    for (const y of path) root[y] = r;
    return r;
  };
  for (let s = 0; s < ns; s++) rootOf(s);
  const roots = (s) => [...new Set([root[s], ...(others[s] || []).map((o) => root[o])])];
  // inside(p): the shells holding p, each by its winding against its outer shell's
  const sign = (s) => Math.sign(V[s]) * (Math.sign(V[root[s]]) || 1);
  let allTree = null;
  const inside = (p) => {
    if (!allTree) {
      const B = new Float64Array(6 * ns);
      for (let s = 0; s < ns; s++) for (let k = 0; k < 3; k++) { B[6 * s + k] = lo[3 * s + k]; B[6 * s + 3 + k] = hi[3 * s + k]; }
      allTree = boxTree(B, Uint32Array.from({ length: ns }, (_, s) => s), 3);
    }
    let sum = 0;
    itemsAt(allTree, p, (o) => {
      if (p[0] < lo[3 * o] || p[0] > hi[3 * o] || p[1] < lo[3 * o + 1] || p[1] > hi[3 * o + 1] || p[2] < lo[3 * o + 2] || p[2] > hi[3 * o + 2]) return;
      if (crossingsAt(solidOf(o), p).inside) sum += sign(o) || 1;
    });
    return sum > 0;
  };
  return { parent, root, roots, inOpen, V, inside };
}
