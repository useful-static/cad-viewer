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
//     touch, whether p lies on the surface (within float32's reach of the shell's size and of
//     its distance from the origin: no answer)
//   windingAt(index, p) -> { inside, touch }: whether p is in a solid's material by its winding
//     number (each crossing +1 or -1 by the facing of the triangle crossed, above 0, by the
//     majority of the three rays), the index of every triangle of the solid, wound as its
//     material faces: Clearance's question (js/clearance.js turns the triangles to their normals
//     first). Two overlapping shells hold their overlap, a cavity's inside is outside, a part
//     embedded in another is material, two parts face to face wound opposite ways are each what
//     they are: as the facts' volume and the view's cut fill take them
//   nesting(P, I, shell, ns, open) -> for a body's shells (shell: per triangle, -1 for none; open:
//     per shell, 1 when it is open and may hold nothing -- by one ray an open tray held a cube
//     upright and not upside down), each shell's nearest holder (parent: the smallest shell that
//     WHOLLY holds it -- its box within the other's, and most of up to three points on it, the
//     centroids of its largest triangles, inside it; a point on the other's surface passed over
//     for the next), its outer shell (root), the outer shells of all that hold it (roots),
//     whether an open shell's box holds it (inOpen) and each shell's signed volume (V): the
//     weld's question, js/edges.js shellTurns

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

// The touch tolerance for a point against a surface: float32's reach and a margin, of the larger of
// the surface's size and the coordinates' size (float32's error grows with the distance from the
// origin -- a plate resting on a cube 1,000 mm out read nested in 11 of 200 turns)
const epsFor = (lo, hi, p) => {
  const span = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  let far = 0;
  for (let k = 0; k < 3; k++) far = Math.max(far, Math.abs(lo[k]), Math.abs(hi[k]), Math.abs(p[k]));
  return Math.max(span, far) * TOUCH;
};

// The one walk of the three rays from p against an index (solidIndex): every hit beyond p visited,
// visit(ray, k: the triangle's place in the index's list, facing: +1 where the surface faces along
// the ray -- leaving it, for an outward winding -- or -1); a hit at p itself (within epsOfK(k))
// reported, touchedK(k), the walk going on.
function walkRays(index, p, visit, touchedK, epsOfK) {
  const { P, I, tris } = index;
  for (let r = 0; r < 3; r++) {
    const { d: [dx, dy, dz], U, W } = RAYS[r];
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
      if (Math.abs(tt) <= epsOfK(k)) { touchedK(k); return; }
      // (det = -(the triangle's normal . the ray): negative where the surface faces along it)
      if (tt > 0) visit(r, k, det < 0 ? 1 : -1);
    });
  }
}

export function crossingsAt(index, p) {
  const n = [0, 0, 0], eps = epsFor(index.lo, index.hi, p);
  let touch = false;
  walkRays(index, p, (r) => { n[r]++; }, () => { touch = true; }, () => eps);
  return { inside: !touch && (n[0] % 2) + (n[1] % 2) + (n[2] % 2) >= 2, touch };
}

// Whether p is in a solid's material by its winding number (index: a solidIndex of every triangle
// of the solid, wound as its material faces -- js/clearance.js turns them to their normals): each
// ray's crossings counted +1 where the surface faces along the ray and -1 against, above 0
// inside, by the majority of the three. One count for the whole solid, so it agrees with the view
// wherever the solid is (two parts face to face, wound opposite ways, read as one shell with one
// sign; an overlap of two shells is 2, a cavity 1 - 1). -> { inside, touch } (touch: p on the
// surface, no answer)
export function windingAt(index, p) {
  const w = [0, 0, 0], eps = epsFor(index.lo, index.hi, p);
  let touch = false;
  walkRays(index, p, (r, k, s) => { w[r] += s; }, () => { touch = true; }, () => eps);
  return { inside: !touch && (w[0] > 0) + (w[1] > 0) + (w[2] > 0) >= 2, touch };
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
  { // (the centre the volumes are taken about: any one serves a closed shell; the body's box middle)
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
  // the shells' boxes in the one box tree (3-d): the shells that may hold one, found without a
  // pass over every shell (each against each: 10.7 s for 20,000 cubes; an index on x alone, 7.0 s
  // for 20,000 stacked along y), and the shells a point may be in
  const B = new Float64Array(6 * ns);
  for (let s = 0; s < ns; s++) for (let k = 0; k < 3; k++) { B[6 * s + k] = lo[3 * s + k]; B[6 * s + 3 + k] = hi[3 * s + k]; }
  const tree = boxTree(B, Uint32Array.from({ length: ns }, (_, s) => s), 3);
  const parent = new Int32Array(ns).fill(-1), inOpen = new Uint8Array(ns);
  const others = new Array(ns); // (holders that are no ancestor of the parent: a second outer shell)
  // every candidate's answer for shell s at once: up to three points on s (a point on a
  // candidate's surface passed over for that candidate), each cast once against the whole body,
  // the crossings counted by shell -- a candidate holds s when most of the points asked of it are
  // inside it (odd crossings, by the majority of the three rays)
  let body = null, shellOfK = null;
  const holdersOf = (s, cands) => {
    if (!body) {
      body = solidIndex(P, I, list);
      shellOfK = new Int32Array(list.length);
      for (let o = 0; o < ns; o++) for (let j = start[o]; j < start[o + 1]; j++) shellOfK[j] = o;
    }
    const want = new Set(cands), asked = new Map(), yes = new Map();
    for (let j = 0; j < NB; j++) {
      const t = big[NB * s + j];
      if (t < 0) break;
      const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
      const p = [(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3];
      const n = [new Map(), new Map(), new Map()], touched = new Set();
      // (a touch on one shell is that shell's no answer; the cast goes on for the others)
      const cast = (k) => { const o = shellOfK[k]; if (want.has(o)) touched.add(o); };
      // (each hit's touch measured against its own shell, as crossingsAt measures one)
      const epsOf = new Map();
      const epsOfK = (k) => {
        const o = shellOfK[k];
        let e = epsOf.get(o);
        if (e === undefined) { e = epsFor(lo.subarray(3 * o, 3 * o + 3), hi.subarray(3 * o, 3 * o + 3), p); epsOf.set(o, e); }
        return e;
      };
      walkRays(body, p, (r, k) => { const o = shellOfK[k]; if (want.has(o)) n[r].set(o, (n[r].get(o) || 0) + 1); }, cast, epsOfK);
      let done = true;
      for (const o of cands) {
        if ((asked.get(o) || 0) >= 3) continue;
        if (touched.has(o)) { done = false; continue; }
        asked.set(o, (asked.get(o) || 0) + 1);
        const odd = ((n[0].get(o) || 0) % 2) + ((n[1].get(o) || 0) % 2) + ((n[2].get(o) || 0) % 2);
        if (odd >= 2) yes.set(o, (yes.get(o) || 0) + 1);
        if ((asked.get(o) || 0) < 3) done = false;
      }
      if (done) break;
    }
    return cands.filter((o) => (asked.get(o) || 0) > 0 && (yes.get(o) || 0) * 2 > asked.get(o));
  };
  if (ns > 1) {
    // The shells placed largest box first, so a shell's holders are placed before it and its
    // parent's ancestors known: a holder is skipped only when it is on the parent's chain (by its
    // box holding the parent's, a second outer shell was missed). The smallest candidate asked
    // first (concentric shells: it holds); when it does not, every candidate answered by one cast
    // a point (2,000 concentric rings, none holding another, asked each against each: 30 s; at
    // most 64 asked, a mirrored file of 300 rings left 235 inside out).
    const order = Uint32Array.from({ length: ns }, (_, s) => s).sort((x, y) => boxVol(y) - boxVol(x));
    const stamp = new Int32Array(ns).fill(-1);
    const c = [0, 0, 0];
    let cands = [], cur = -1;
    const take = (o) => {
      if (o === cur || !boxIn(cur, o)) return;
      if (open[o]) inOpen[cur] = 1; else cands.push(o);
    };
    for (const s of order) {
      if (open[s]) continue;
      for (let k = 0; k < 3; k++) c[k] = (lo[3 * s + k] + hi[3 * s + k]) / 2;
      cur = s;
      if (cands.length) cands = [];
      itemsAt(tree, c, take);
      if (!cands.length) continue;
      // the nearest holder first, by its box's volume: the smallest, found by a scan, asked alone
      let m = 0;
      for (let k = 1; k < cands.length; k++) if (boxVol(cands[k]) < boxVol(cands[m])) m = k;
      let rest;
      if (within(s, cands[m])) {
        parent[s] = cands[m];
        rest = cands.filter((_, k) => k !== m);
      } else {
        // (no: every other candidate answered at once, the nearest holder the smallest of them)
        const hs = cands.length > 1 ? holdersOf(s, cands.filter((_, k) => k !== m)) : [];
        if (!hs.length) continue;
        let h = hs[0];
        for (const o of hs) if (boxVol(o) < boxVol(h)) h = o;
        parent[s] = h;
        for (let x = parent[s], g = 0; x >= 0 && g <= ns; x = parent[x], g++) stamp[x] = s;
        for (const o of hs) if (stamp[o] !== s) (others[s] ||= []).push(o);
        continue;
      }
      // (then the others that hold it but are no ancestor of its parent: a second outer shell;
      // more than a few answered at once)
      for (let x = parent[s], g = 0; x >= 0 && g <= ns; x = parent[x], g++) stamp[x] = s;
      rest = rest.filter((o) => stamp[o] !== s);
      const hs = rest.length > 8 ? holdersOf(s, rest) : rest.filter((o) => within(s, o));
      if (hs.length) others[s] = hs;
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
  return { parent, root, roots, inOpen, V };
}
