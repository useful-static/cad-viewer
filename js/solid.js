// The viewer's one answer to "where is this point, against these closed surfaces": which shells of
// a body lie in which (the mesh weld's turning of a shell, js/edges.js shellTurns) and whether a
// point is inside a solid (Clearance's part wholly inside one, js/clearance.js). (Each had its
// own: a linear ray cast in edges.js, 149.6 s for a 2.02 M-triangle enclosure holding 2,000 parts,
// and a parity over the whole body in clearance.js that read a point in the overlap of two shells
// as outside.) Pure, no DOM. Nothing here trusts a winding: a shell's inside is by the parity of a
// ray's crossings, and a shell's part in the whole by how deep it lies in the others.
//
//   solidIndex(P, I, tris) -> one shell's triangles (ids into I, three corners each into P, float
//     xyz) indexed along one fixed ray direction: each triangle's box across the ray in the one
//     box tree (js/box-tree.js), so a ray meets only the triangles over its foot
//   crossingsAt(index, p) -> { n, touch }: how many times the ray from p crosses the surface, and
//     whether it meets it at p itself (p on the surface: no answer). Odd n: inside that shell.
//   nesting(P, I, shell, ns) -> for a body's shells (shell: per triangle, -1 for none), how deep
//     each lies: the shells that WHOLLY hold it (its box within theirs, and most of up to three
//     points on it -- the centroids of its largest triangles, a point on the other's surface
//     passed over for the next -- inside), and inside(p): whether p is in the body's material
//     (the shells holding p, each +1 at an even depth and -1 at an odd one -- a cavity -- summed:
//     above 0). Two overlapping shells hold their overlap; a cavity's inside is outside.

import { boxTree, itemsAt } from './box-tree.js';

// A fixed direction no CAD axis or face lies along
export const RAY = (() => { const d = [0.3141592, 0.5772156, 0.7536422], l = Math.hypot(...d); return d.map((x) => x / l); })();
// two unit vectors across it, the plane the triangles are boxed in
const U = (() => { const [x, y] = RAY; const u = [y, -x, 0], l = Math.hypot(...u); return u.map((v) => v / l); })();
const W = [RAY[1] * U[2] - RAY[2] * U[1], RAY[2] * U[0] - RAY[0] * U[2], RAY[0] * U[1] - RAY[1] * U[0]];

export function solidIndex(P, I, tris) {
  const n = tris.length, B = new Float64Array(4 * n);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    const t = tris[k];
    let u0 = Infinity, w0 = Infinity, u1 = -Infinity, w1 = -Infinity;
    for (let c = 0; c < 3; c++) {
      const v = 3 * I[3 * t + c], x = P[v], y = P[v + 1], z = P[v + 2];
      const u = x * U[0] + y * U[1] + z * U[2], w = x * W[0] + y * W[1] + z * W[2];
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (w < w0) w0 = w; if (w > w1) w1 = w;
      if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x; if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y; if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
    }
    B[4 * k] = u0; B[4 * k + 1] = w0; B[4 * k + 2] = u1; B[4 * k + 3] = w1;
  }
  const ids = [];
  for (let k = 0; k < n; k++) if (Number.isFinite(B[4 * k] + B[4 * k + 1] + B[4 * k + 2] + B[4 * k + 3])) ids.push(k);
  return { P, I, tris, lo, hi, tree: boxTree(B, Uint32Array.from(ids), 2) };
}

export function crossingsAt(index, p) {
  const { P, I, tris } = index;
  const [dx, dy, dz] = RAY;
  const span = Math.hypot(index.hi[0] - index.lo[0], index.hi[1] - index.lo[1], index.hi[2] - index.lo[2]) || 1;
  const eps = span * 1e-9;
  let n = 0, touch = false;
  const pu = p[0] * U[0] + p[1] * U[1] + p[2] * U[2], pw = p[0] * W[0] + p[1] * W[1] + p[2] * W[2];
  itemsAt(index.tree, [pu, pw], (k) => {
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
  return { n, touch };
}

export function nesting(P, I, shell, ns) {
  const nt = shell.length;
  // per shell: its box, its triangles (a typed list, grouped by shell), its 8 largest triangles
  const lo = new Float64Array(3 * ns).fill(Infinity), hi = new Float64Array(3 * ns).fill(-Infinity);
  const start = new Uint32Array(ns + 1);
  for (let t = 0; t < nt; t++) if (shell[t] >= 0) start[shell[t] + 1]++;
  for (let s = 0; s < ns; s++) start[s + 1] += start[s];
  const at = start.slice(0, ns), list = new Uint32Array(start[ns]);
  const NB = 8, big = new Int32Array(NB * ns).fill(-1), bigA = new Float64Array(NB * ns);
  for (let t = 0; t < nt; t++) {
    const s = shell[t];
    if (s < 0) continue;
    list[at[s]++] = t;
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) { const x = P[v + k]; if (x < lo[3 * s + k]) lo[3 * s + k] = x; if (x > hi[3 * s + k]) hi[3 * s + k] = x; }
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
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
  // the shells' boxes in the one box tree (3-d): the shells that may hold a point, found without a
  // pass over every shell (each against each: 10.7 s for 20,000 cubes; an index on x alone, 7.0 s
  // for 20,000 stacked along y)
  const B = new Float64Array(6 * ns);
  for (let s = 0; s < ns; s++) for (let k = 0; k < 3; k++) { B[6 * s + k] = lo[3 * s + k]; B[6 * s + 3 + k] = hi[3 * s + k]; }
  const shellTree = boxTree(B, Uint32Array.from({ length: ns }, (_, s) => s), 3);
  const solids = new Map(); // (a shell's crossing index, built when first asked)
  const solidOf = (o) => { let x = solids.get(o); if (!x) { x = solidIndex(P, I, list.subarray(start[o], start[o + 1])); solids.set(o, x); } return x; };
  const inBox = (p, o) => p[0] >= lo[3 * o] && p[0] <= hi[3 * o] && p[1] >= lo[3 * o + 1] && p[1] <= hi[3 * o + 1] && p[2] >= lo[3 * o + 2] && p[2] <= hi[3 * o + 2];
  const within = (s, o) => {
    for (let k = 0; k < 3; k++) if (lo[3 * s + k] < lo[3 * o + k] || hi[3 * s + k] > hi[3 * o + k]) return false;
    let yes = 0, asked = 0;
    for (let j = 0; j < NB && asked < 3; j++) {
      const t = big[NB * s + j];
      if (t < 0) break;
      const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
      const p = [(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3];
      const { n, touch } = crossingsAt(solidOf(o), p);
      if (touch) continue; // (on the other's surface: no answer, the next point asked)
      asked++;
      if (n % 2 === 1) yes++;
    }
    return asked > 0 && yes * 2 > asked;
  };
  const depth = new Uint32Array(ns), holders = new Array(ns);
  if (ns > 1) {
    for (let s = 0; s < ns; s++) {
      const c = [0, 1, 2].map((k) => (lo[3 * s + k] + hi[3 * s + k]) / 2);
      itemsAt(shellTree, c, (o) => { if (o !== s && within(s, o)) { depth[s]++; (holders[s] ||= []).push(o); } });
    }
  }
  const inside = (p) => {
    let sum = 0;
    itemsAt(shellTree, p, (o) => { if (inBox(p, o) && crossingsAt(solidOf(o), p).n % 2 === 1) sum += depth[o] % 2 ? -1 : 1; });
    return sum > 0;
  };
  return { depth, holders, inside };
}
