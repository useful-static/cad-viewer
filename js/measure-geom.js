// The geometry Measure snaps to and the hole table lists, built per body on
// first use from a decoded model's global arrays (position, index, faces,
// header). Pure, no DOM.
//
// OpenCascade meshes every b-rep face with its own vertices, and shared
// boundary points come out with identical float bits (measured on real board
// files). So:
//   - a face's boundary is its edges used by one of ITS triangles, chained
//     into loops by vertex index;
//   - across faces, welding the boundary points on their exact bits joins the
//     faces' copies of each edge: a welded point where other than two boundary
//     segments meet is a b-rep vertex (a corner), and the runs between corners
//     are the b-rep edges (their midpoints);
//   - a face loop is a circle (a hole's rim, a boss) when it has at least
//     ceil(2π / a) - 1 points, a being the angular deflection the file was
//     meshed at (squares and hexes have 4 and 6), is planar, and its points
//     lie within 1 % of one radius. Off for a >= 2π/9, where 8 points would
//     do and an octagon could pass. Far from the origin a loop the stored
//     positions cannot tell -- their step past the test, or the loop within a
//     step of it -- is "untold": no circle, and counted (circleOf, untoldAt).
//
// Coordinates are the model's (mm).

const EPS_PLANAR = 1e-3; // of the radius: a rim's points off its plane
// (a loop's points within this share of its radius from one circle: a circle -- circleOf's `dev`)
export const RADIUS_TOL = 0.01;
const PLANE_FLOOR_MM = 1e-3; // a face is flat to a micrometre at least (planeOf)
const FLAT_SHARE = 3e-5; // and to this share of its size (planeOf: measured, r67)
// what float32 positions can tell apart near a coordinate of size `far`: its step, four times over
// -- planeOf's floor, a plane's thickness from many points, each rounded at most half a step in
// each coordinate (1.7 steps across). (By storedUlp, the one step -- r68 A9. It was 16 steps, 8 x
// 2^-23 x far before: 131 m out a drill point 0.13 mm deep read as a flat face, the bottom of a
// countersunk blind hole as its exit -- r69, the position test's shapes)
const storedFloor = (far) => 4 * storedUlp(far);
// a point's distance from a centre, as stored: one unit in the last place (2^-23 of `far`) -- the
// floor of circleOf and wallJoins. Eight let a loop 2.8% off a circle pass as a hole a few metres
// out (the RK3399 board 5 m out gained two; six of eight boards more at 20 m: r65 Q3)
// (the real step, the power of two a float32 of that size moves by: 2^-23 x far overstated it up to
// twice, and 32 m out the RK3399 lost 14 rims as untold that are stored as finely as at 20 m: r67 Q1)
const storedUlp = (far) => (far > 0 ? 2 ** (Math.floor(Math.log2(far)) - 23) : 0);
// A loop the stored positions cannot tell: a stored coordinate's rounding, half a unit in its last
// place, more than this many times the radius test. Such a loop is "untold": no circle, and
// counted, so the hole table says what it cannot tell. The line is where the circle test's own
// floor begins: past it a loop is tested to the stored step, not to 1% of its radius, and a loop
// up to that step off a circle passes -- so a rim is told only while the step is within the test.
// (It was 1.5, measured on the eight boards 20 m out, every rim that read there reading right; 300
// m to 1 km out the RK3399 then gained loops 1.69% and 2.10% off a circle as holes, Ø3.69 to Ø6.21:
// r69 Q1. The price, measured in r66: 20 m out 38 of the RK3328's 49 rows untold, and said.) A
// per-loop line, by how far each loop is off, is no fix: the rounding of one placement decides it,
// and inside one power of two the table differs (the position test's second rule).
const TELL_SHARE = 0.5;
export const untoldAt = (far, r) => storedUlp(far) / 2 > TELL_SHARE * RADIUS_TOL * r;
// (the rounding past which a rim is untold, as a share of its radius: the hole table's words say
// this, not a number of their own -- r67 A8, Q6)
export const UNTOLD_SHARE = TELL_SHARE * RADIUS_TOL;

export const circleMinPoints = (a) => (a > 0 && a < (2 * Math.PI) / 9 ? Math.ceil((2 * Math.PI) / a) - 1 : Infinity);
// how far a segment's middle may sag inside a circle circleOf takes under deflection a, as a share
// of its radius: the coarsest loop it takes, circleMinPoints(a) sides (r71 A4: Save drawing tested
// each middle without it, and drew a rim of 13 segments at a = 0.5, 2.9 % of r sagging, as its
// circle and as its polygon)
export const circleSagShare = (a) => { const n = circleMinPoints(a); return Number.isFinite(n) ? 1 - Math.cos(Math.PI / n) : 0; };

import { cross, dot, len, sub, unit } from './vec3.js';
import { bodyAngle } from './cadmesh.js';
import { weldBits } from './edges.js';

// Newell's normal and the centroid of a closed polygon
function newell(pts) {
  const n = [0, 0, 0];
  const c = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    n[0] += (p[1] - q[1]) * (p[2] + q[2]);
    n[1] += (p[2] - q[2]) * (p[0] + q[0]);
    n[2] += (p[0] - q[0]) * (p[1] + q[1]);
    for (let k = 0; k < 3; k++) c[k] += p[k] / pts.length;
  }
  return { n, c };
}

// A loop's circle, or null: { centre, normal, radius }. The centre is a
// least-squares (Kåsa) fit in the loop's plane, so unevenly spaced points
// (OpenCascade spaces them by deflection, not angle) do not pull it.
export function circleOf(pts, angularDeflection) {
  if (pts.length < circleMinPoints(angularDeflection)) return null;
  const { n, c } = newell(pts);
  if (len(n) === 0) return null;
  const nz = unit(n);
  const ux = unit(Math.abs(nz[0]) < 0.9 ? cross(nz, [1, 0, 0]) : cross(nz, [0, 1, 0]));
  const uy = cross(nz, ux);
  // 2D points in the plane; fit x² + y² + D x + E y + F = 0
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sz = 0, szx = 0, szy = 0;
  const m = pts.length;
  const xy = pts.map((p) => { const d = sub(p, c); return [dot(d, ux), dot(d, uy), dot(d, nz)]; });
  for (const [x, y] of xy) {
    const z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sz += z; szx += z * x; szy += z * y;
  }
  // normal equations, 3x3: [sxx sxy sx; sxy syy sy; sx sy m] [D E F] = -[szx szy sz]
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, m]];
  const bv = [-szx, -szy, -sz];
  const det3 = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
    + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const d0 = det3(A);
  if (Math.abs(d0) < 1e-30) return null;
  const solve = (k) => det3(A.map((row, i) => row.map((v, j) => (j === k ? bv[i] : v)))) / d0;
  const D = solve(0), E = solve(1), F = solve(2);
  const cx = -D / 2, cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  // (each no finer than the positions are stored, as planeOf's: a rim of radius 0.2 mm 5 m out was
  // "not a circle")
  let far = 0;
  for (const p of pts) far = Math.max(far, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const stored = storedUlp(far);
  let dev = 0;
  for (const [x, y, z] of xy) {
    if (Math.abs(z) > Math.max(EPS_PLANAR * r, stored)) return null;
    dev = Math.max(dev, Math.abs(Math.hypot(x - cx, y - cy) - r));
  }
  // (past the test by more than its rounding can move it -- a step: the RK3399's Ø7.283 loops,
  // 0.946% off a circle, read 0.897% to 1.015% 131 m out, under a fifth of a step either way -- no
  // circle; past it by less, it may be one as stored: untold. Their rows went without a word: r69,
  // the position test)
  if (dev > Math.max(RADIUS_TOL * r, stored) + stored) return null;
  // (and no side sweeping more of it than the coarsest loop taken does, 2 pi / circleMinPoints(a):
  // a D -- arc points and one chord across the flat, every point on the circle -- was a whole
  // circle, a hole table's "Ø5 through" and Save drawing's full circle across the flat: r108 M2)
  // (not asked of a loop the stored positions cannot tell: rounded, its points move along it, and it
  // is counted untold below, not lost)
  const most = ((2 * Math.PI) / circleMinPoints(angularDeflection)) * 1.01;
  for (let i = 0; i < m && !untoldAt(far, r); i++) {
    const [x0, y0] = xy[i], [x1, y1] = xy[(i + 1) % m];
    const ax = x0 - cx, ay = y0 - cy, bx = x1 - cx, by = y1 - cy;
    if (Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) > most) return null;
  }
  const centre = [0, 1, 2].map((k) => c[k] + ux[k] * cx + uy[k] * cy);
  // (inside the test, but as stored it cannot be told from a shape that is not a circle: untold)
  return untoldAt(far, r) || dev > RADIUS_TOL * r ? { centre, normal: nz, radius: r, dev, untold: true } : { centre, normal: nz, radius: r, dev };
}

// A face's plane, or null when its triangles do not all lie in one:
// { normal, d } with normal · p = d
function planeOf(P, I, t0, nt) {
  // (the normal summed over the face's triangles, by area: one triangle's, tilted by float32
  // rounding, spread a flat 45-degree face 1.4 m out 1.38 um about it -- past the tolerance -- for
  // 0.094 um about the sum)
  const sum = [0, 0, 0];
  let p0 = null;
  for (let t = t0; t < t0 + nt; t++) {
    const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
    const pa = [P[a], P[a + 1], P[a + 2]], pb = [P[b], P[b + 1], P[b + 2]], pc = [P[c], P[c + 1], P[c + 2]];
    const cr = cross(sub(pb, pa), sub(pc, pa));
    if (len(cr) === 0) continue;
    for (let k = 0; k < 3; k++) sum[k] += cr[k];
    if (!p0) p0 = pa;
  }
  const sl = len(sum);
  if (!p0 || !(sl > 0)) return null;
  const n = sum.map((v) => v / sl);
  // every vertex on that plane, to FLAT_SHARE of the face's size (at least a micrometre, and no
  // finer than the positions are stored)
  let lo = Infinity, hi = -Infinity, ext = 0, far = 0;
  for (let t = t0; t < t0 + nt; t++) {
    for (let j = 0; j < 3; j++) {
      const v = I[3 * t + j] * 3;
      const p = [P[v], P[v + 1], P[v + 2]];
      const h = dot(sub(p, p0), n);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
      ext = Math.max(ext, len(sub(p, p0)));
      far = Math.max(far, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
    }
  }
  // (a tolerance the files meet: FLAT_SHARE of the face's size, at least a micrometre, and no finer
  // than the positions are stored -- float32 rounds a coordinate to its step, storedUlp. At 1e-6 a flat
  // tilted face 1 m out read "not flat", and a board's bottom whose 4 vertices of 1,873 sit 0.3 um
  // off lost its 38 holes' depths)
  // (3e-5, measured: the faces holding a circle that read not flat, over the eight boards and the
  // three largest private models, are either off by 1-2e-5 of their size -- an 802 mm plate face 8.87
  // um, whose 18 through-holes read as one-rim at the origin and as through 20 m out, the floor
  // there looser -- or curved, 5e-5 and up; none between. At 1e-5 that plate's placement decided:
  // r67 Q2)
  if (hi - lo > Math.max(FLAT_SHARE * ext, PLANE_FLOOR_MM, storedFloor(far))) return null;
  return { normal: n, d: dot(n, p0) };
}

// The loops of one face: its edges used by one of its triangles, chained by
// vertex index. -> [[vertex index, ...], ...]
// (an edge's key a number, a * span + b: a string a triangle edge was 0.75 s of a 6,400-hole plate)
function faceLoops(I, t0, nt, span = 2 ** 26) {
  const use = new Map();
  const key = (a, b) => (a < b ? a * span + b : b * span + a);
  for (let t = t0; t < t0 + nt; t++) {
    for (let j = 0; j < 3; j++) {
      const a = I[3 * t + j], b = I[3 * t + (j + 1) % 3];
      const k = key(a, b);
      const u = use.get(k);
      if (u) u.n++; else use.set(k, { a, b, n: 1 });
    }
  }
  const next = new Map();
  for (const e of use.values()) {
    if (e.n !== 1) continue;
    if (!next.has(e.a)) next.set(e.a, []);
    if (!next.has(e.b)) next.set(e.b, []);
    next.get(e.a).push(e.b);
    next.get(e.b).push(e.a);
  }
  const loops = [];
  const done = new Set();
  for (const s of next.keys()) {
    if (done.has(s)) continue;
    const loop = [s];
    done.add(s);
    let prev = -1, cur = s;
    for (;;) {
      const nb = next.get(cur).find((v) => v !== prev && !done.has(v));
      if (nb === undefined) break;
      loop.push(nb);
      done.add(nb);
      prev = cur;
      cur = nb;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// One body's measurable geometry:
// { faces: [{ tri0, ntri, plane|null, circles: [{centre, normal, radius, face, inner, nodes}],
//             untold?: the inner loops it cannot tell, bnodes: its boundary's welded nodes }],
//   corners: [[x,y,z]], edges: [[[x,y,z], ...]] (b-rep edges as polylines),
//   edgeClosed: [bool] (an edge back at its start: its last point is its first),
//   circles: all the faces' circles }
// model: { position, index, faces (Uint32Array pairs | null), header }.
// Without a faces section a body is one face with no circles.
export function bodyGeometry(model, meshIndex) {
  const P = model.position, I = model.index, h = model.header;
  const m = h.meshes[meshIndex];
  // a face's outside is its vertex normals' (facingNormals), the one rule: a decoded model always
  // has them (its normal section is required), so a model without is a caller's error, said so
  if (!model.normal) throw new Error('bodyGeometry: the model has no vertex normals');
  // (the body's own model's angular deflection, where a scene merged models meshed differently:
  // the scene's smallest set every model's circle test, and a board beside a model meshed at 0.1
  // listed 0 of its 125 holes): the one rule, js/cadmesh.js bodyAngle
  const a = bodyAngle(h, m);
  const faces = [];
  const tri0 = m.idxStart / 3, ntri = m.idxCount / 3;
  if (model.faces && m.faceCount) {
    for (let f = m.faceStart; f < m.faceStart + m.faceCount; f++) {
      faces.push({ tri0: model.faces[2 * f], ntri: model.faces[2 * f + 1] });
    }
  } else faces.push({ tri0, ntri, whole: true });
  // welded boundary graph across the body's faces: a node per position (its bits, by the facts' own
  // weld, js/edges.js weldBits -- a second key, a string a corner, was kept here), numbered, with
  // its neighbours' numbers; a segment a number too. (Keyed by the positions' strings, every
  // segment built and compared strings: 1.2 s of a 6,400-hole plate's 3.9 s)
  const nodeP = [], nodeNb = [];
  // (a vertex's node, by the first vertex of the body with its bits: -1 until met)
  const v0 = m.vtxStart;
  const weld = weldBits(new Uint32Array(P.buffer, P.byteOffset, P.length), v0, m.vtxCount);
  const idOfRep = new Int32Array(Math.max(1, m.vtxCount)).fill(-1);
  const idOf = (v) => {
    const r = weld[v - v0];
    let id = idOfRep[r];
    if (id < 0) { id = idOfRep[r] = nodeP.length; nodeP.push([P[3 * v], P[3 * v + 1], P[3 * v + 2]]); nodeNb.push(new Set()); }
    return id;
  };
  const SEG = 2 ** 26;
  const sk = (x, y) => (x < y ? x * SEG + y : y * SEG + x);
  const circles = [];
  const span = P.length / 3 + 1;
  for (const [fi, f] of faces.entries()) {
    f.plane = f.whole ? null : planeOf(P, I, f.tri0, f.ntri);
    if (f.plane) facingNormals(f.plane, model.normal, I, f.tri0, f.ntri);
    f.circles = [];
    if (!f.ntri) continue;
    const loops = faceLoops(I, f.tri0, f.ntri, span);
    // the outer loop: the one with the largest extent (a face's holes lie
    // inside it); the others are inner, a hole's or a boss's foot
    const ext = loops.map((loop) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const v of loop) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[3 * v + k]); hi[k] = Math.max(hi[k], P[3 * v + k]); }
      return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    });
    // (by a loop: spread, one argument a loop, a face of 140,000 holes threw -- r108 M4)
    let outer = 0;
    for (let i = 1; i < ext.length; i++) if (ext[i] > ext[outer]) outer = i;
    // (the face's boundary nodes: which faces adjoin which, for a hole's wall -- holeWall)
    f.bnodes = [];
    loops.forEach((loop, li) => {
      const ids = loop.map(idOf);
      for (const k of ids) f.bnodes.push(k);
      const pts = loop.map((v) => [P[3 * v], P[3 * v + 1], P[3 * v + 2]]);
      if (!f.whole) {
        const c = circleOf(pts, a);
        // (its face by index: faces.indexOf for each circle was 1.3 s of 11,444 faces)
        // (an untold one is no circle, and its face's count of what cannot be told: r66)
        // (and where: a lost rim found among them by place, not by a total -- r69 Q6)
        if (c && c.untold) { if (li !== outer) { f.untold = (f.untold || 0) + 1; (f.untoldAt ||= []).push(c.centre); } } else if (c) { c.face = fi; c.inner = li !== outer; c.nodes = ids; f.circles.push(c); circles.push(c); }
      }
      for (let i = 0; i < ids.length; i++) {
        const ka = ids[i], kb = ids[(i + 1) % ids.length];
        if (ka === kb) continue;
        nodeNb[ka].add(kb);
        nodeNb[kb].add(ka);
      }
    });
  }
  // corners: welded points where other than two boundary segments meet
  const corners = [];
  const isCorner = (k) => nodeNb[k].size !== 2;
  for (let k = 0; k < nodeP.length; k++) if (isCorner(k)) corners.push(nodeP[k]);
  // b-rep edges: walk from each corner along unvisited segments to the next
  // corner; what is left over are closed edges (a full circle's rim)
  const seen = new Set();
  const edges = [], edgeClosed = [];
  const walk = (start, first) => {
    const line = [nodeP[start]];
    let prev = start, cur = first;
    for (;;) {
      seen.add(sk(prev, cur));
      line.push(nodeP[cur]);
      if (isCorner(cur) || cur === start) break;
      let nx;
      for (const n of nodeNb[cur]) if (n !== prev && !seen.has(sk(cur, n))) { nx = n; break; }
      if (nx === undefined) break;
      prev = cur;
      cur = nx;
    }
    edges.push(line);
    // (the walk knows when an edge closes: back at its start. Measure and the drawing each tested
    // the ends' coordinates, by rules that differed for a 3-point loop)
    edgeClosed.push(cur === start);
  };
  for (let k = 0; k < nodeP.length; k++) {
    if (!isCorner(k)) continue;
    for (const n of nodeNb[k]) if (!seen.has(sk(k, n))) walk(k, n);
  }
  for (let k = 0; k < nodeP.length; k++) {
    for (const n of nodeNb[k]) if (!seen.has(sk(k, n))) walk(k, n);
  }
  // (P / I: what holesOf reads a hole's wall from -- the curved faces' vertices; a: the angular
  // deflection its circles were tested at, for the drawing's; edgeClosed: per edge, whether it
  // closes on itself)
  return { faces, corners, edges, edgeClosed, circles, P, I, a };
}

// A face's plane turned to look the way its vertex normals do: the normals are what the view
// shades and cuts by (js/renderer-webgl.js), so Measure's outside is the view's. A mirrored
// placement winds its triangles inward and keeps its normals out; the winding's sign, turned by
// the body's signed volume, was a second rule (an open body's sign is about its first vertex, and
// a washer with no outer wall read as two blind holes). N: the decoded snorm16 x4 normals
function facingNormals(plane, N, I, t0, nt) {
  let s = 0;
  for (let t = t0; t < t0 + nt; t++) for (let j = 0; j < 3; j++) {
    const v = I[3 * t + j] * 4;
    s += plane.normal[0] * N[v] + plane.normal[1] * N[v + 1] + plane.normal[2] * N[v + 2];
  }
  if (s < 0) { plane.normal = plane.normal.map((x) => -x); plane.d = -plane.d; }
}

// The midpoint of a polyline, by length
export function polyMid(line) {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += len(sub(line[i], line[i - 1]));
  let half = total / 2;
  for (let i = 1; i < line.length; i++) {
    const l = len(sub(line[i], line[i - 1]));
    if (half <= l && l > 0) {
      const t = half / l;
      return [0, 1, 2].map((k) => line[i - 1][k] + (line[i][k] - line[i - 1][k]) * t);
    }
    half -= l;
  }
  return line[0];
}

export const polyLength = (line) => {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += len(sub(line[i], line[i - 1]));
  return total;
};

// ---- results ----

export function distance(p, q) {
  const d = sub(q, p);
  return { length: len(d), delta: d };
}

// the angle at b, degrees
export function angleAt(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const lu = len(u), lv = len(v);
  if (!lu || !lv) return null;
  return (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (lu * lv)))) * 180) / Math.PI;
}

// Face to face: the first face planar; the gap along its normal to the second
// when that is a parallel plane (within 1°), else how far it is from parallel;
// a curved second face: the nearest of its points along the normal.
// a, b: { plane|null, points: [[x,y,z], ...] } -> { gap } | { notParallel: deg } | { notPlanar: true }
export function faceGap(a, b) {
  if (!a.plane) return { notPlanar: true };
  const n = a.plane.normal;
  if (b.plane) {
    const c = Math.abs(dot(n, b.plane.normal));
    const deg = (Math.acos(Math.min(1, c)) * 180) / Math.PI;
    if (deg > 1) return { notParallel: deg };
    // b's distance from a's plane, at b's points' mean (exact for parallel)
    const m = [0, 1, 2].map((k) => b.points.reduce((s, p) => s + p[k], 0) / b.points.length);
    return { gap: Math.abs(dot(n, m) - a.plane.d) };
  }
  let g = Infinity;
  for (const p of b.points) g = Math.min(g, Math.abs(dot(n, p) - a.plane.d));
  return { gap: g };
}

// ---- holes (the hole table) ----

// Whether the body's curved faces lying on rim a's cylinder (its axis, its radius) cover the axis
// from a to rim b: the hole's wall (bodyGeometry gives geom.P / geom.I)
// (the curved faces' boxes made once per body, and a face whose box misses the hole's -- rim to
// rim, its radius round -- passed over: each pair scanned every curved face's vertices)
function curvedBoxes(geom) {
  if (geom.curvedBoxes) return geom.curvedBoxes;
  const { P, I } = geom;
  geom.curvedBoxes = geom.faces.map((f, fi) => {
    if (f.plane || !f.ntri) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let t = f.tri0; t < f.tri0 + f.ntri; t++) for (let j = 0; j < 3; j++) {
      const v = I[3 * t + j] * 3;
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[v + k]); hi[k] = Math.max(hi[k], P[v + k]); }
    }
    return { lo, hi, fi };
  }).filter(Boolean);
  // Sorted by their low x, with the widest's width: a hole's x range finds its faces by search. A
  // face far wider than most (a panel-long fillet) is kept apart and always looked at: its width
  // set the search's reach, and every rim scanned from the first box (6,400 holes: 290 -> 1,256 ms)
  const all = geom.curvedBoxes;
  const widths = all.map((x) => x.hi[0] - x.lo[0]).sort((p, q) => p - q);
  const cap = Math.max(16 * (widths[Math.floor(widths.length * 0.9)] || 0), 1e-9);
  geom.curvedBoxes = all.filter((x) => x.hi[0] - x.lo[0] <= cap).sort((p, q) => p.lo[0] - q.lo[0]);
  geom.curvedBoxes.long = all.filter((x) => x.hi[0] - x.lo[0] > cap);
  geom.curvedBoxes.wide = geom.curvedBoxes.reduce((w, x) => Math.max(w, x.hi[0] - x.lo[0]), 0);
  return geom.curvedBoxes;
}
// the curved faces (their indices) whose boxes meet [lo, hi]
function curvedNear(geom, lo, hi) {
  const bs = curvedBoxes(geom);
  let a = 0, b = bs.length;
  const from = lo[0] - bs.wide;
  while (a < b) { const mid = (a + b) >> 1; if (bs[mid].lo[0] < from) a = mid + 1; else b = mid; }
  const out = [];
  const meets = (x) => [0, 1, 2].every((k) => x.hi[k] >= lo[k] && x.lo[k] <= hi[k]);
  for (let i = a; i < bs.length && bs[i].lo[0] <= hi[0]; i++) if (meets(bs[i])) out.push(bs[i].fi);
  for (const x of bs.long) if (meets(x)) out.push(x.fi);
  return out;
}
function wallJoins(geom, a, b) {
  const { P, I } = geom;
  const n = a.normal, c = a.centre;
  const end = dot(sub(b.centre, c), n);
  const lo = Math.min(0, end), hi = Math.max(0, end);
  const spans = [];
  const m = a.radius * (1 + 2 * RADIUS_TOL) + PLANE_FLOOR_MM;
  const hlo = [0, 1, 2].map((k) => Math.min(a.centre[k], b.centre[k]) - m), hhi = [0, 1, 2].map((k) => Math.max(a.centre[k], b.centre[k]) + m);
  for (const fi of curvedNear(geom, hlo, hhi)) {
    const f = geom.faces[fi];
    let t0 = Infinity, t1 = -Infinity, on = true;
    for (let t = f.tri0; t < f.tri0 + f.ntri && on; t++) {
      for (let j = 0; j < 3; j++) {
        const v = I[3 * t + j] * 3;
        const d = [P[v] - c[0], P[v + 1] - c[1], P[v + 2] - c[2]];
        const along = dot(d, n);
        const off = len(sub(d, n.map((x) => x * along)));
        const tol = Math.max(RADIUS_TOL * a.radius, storedUlp(Math.max(Math.abs(P[v]), Math.abs(P[v + 1]), Math.abs(P[v + 2]))));
        if (Math.abs(off - a.radius) > tol) { on = false; break; }
        t0 = Math.min(t0, along); t1 = Math.max(t1, along);
      }
    }
    if (on && t1 > lo && t0 < hi) spans.push([t0, t1]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const eps = 1e-3 * (hi - lo) + PLANE_FLOOR_MM;
  let at = lo;
  for (const [s0, s1] of spans) { if (s0 > at + eps) break; at = Math.max(at, s1); }
  return at >= hi - eps;
}

// The faces about each boundary node of a body, made once: [face index, ...] per node
function nodeFaces(geom) {
  if (geom.nodeFaces) return geom.nodeFaces;
  const m = new Map();
  geom.faces.forEach((f, fi) => {
    for (const k of f.bnodes || []) { let a = m.get(k); if (!a) m.set(k, (a = [])); if (!a.includes(fi)) a.push(fi); }
  });
  geom.nodeFaces = m;
  return m;
}

// A curved face as a surface of revolution about the axis (c, n) whose radius runs one way along
// it: a cylinder, a cone, a fillet, a drill point -- each vertex's distance from the axis, taken by
// its place along it, never back past the farthest yet the other way, to the radius test (and no
// finer than the positions are stored); none wider than rMax. (A cone's straight line only: a rim
// filleted into its bore stopped the walk, and both rims read as blind holes at the fillet's Ø,
// 24 rows of a private model: r69 Q2.) -> { t0, r0, t1, r1, cyl } (its two ends along n, their
// radii, and whether every vertex is at r0: a cylinder) | null
function revolution(geom, f, c, n, rMax) {
  const { P, I } = geom;
  const at = [];
  for (let t = f.tri0; t < f.tri0 + f.ntri; t++) {
    for (let j = 0; j < 3; j++) {
      const v = I[3 * t + j] * 3;
      const d = [P[v] - c[0], P[v + 1] - c[1], P[v + 2] - c[2]];
      const along = dot(d, n), off = len(sub(d, n.map((x) => x * along)));
      const ulp = storedUlp(Math.max(Math.abs(P[v]), Math.abs(P[v + 1]), Math.abs(P[v + 2])));
      const tol = Math.max(RADIUS_TOL * off, ulp);
      if (off > rMax + tol) return null;
      at.push([along, off, tol, ulp]);
    }
  }
  if (!at.length) return null;
  at.sort((p, q) => p[0] - q[0]);
  const p0 = at[0], p1 = at[at.length - 1];
  const tolEnds = Math.max(p0[2], p1[2]);
  const cyl = at.every(([, o, tol]) => Math.abs(o - p0[1]) <= Math.max(tol, p0[2]));
  if (!cyl) {
    // (one way along it: a wider end first, every vertex no wider than the narrowest of those past
    // the test behind it -- behind by more than the stored step: near its rim a fillet runs almost
    // along the face, and 131 m out vertices nearly level, their places rounded, sorted the wrong way
    // round and read as widening -- r69, the position test -- or the other way round)
    const narrows = p1[1] < p0[1] - tolEnds, widens = p1[1] > p0[1] + tolEnds;
    if (!narrows && !widens) return null;
    let ext = null, j = 0;
    for (const [t, o, tol, ulp] of at) {
      while (at[j][0] < t - 2 * ulp) { ext = ext === null ? at[j][1] : narrows ? Math.min(ext, at[j][1]) : Math.max(ext, at[j][1]); j++; }
      if (ext !== null && (narrows ? o > ext + tol : o < ext - tol)) return null;
    }
  }
  return { t0: p0[0], r0: p0[1], t1: p1[0], r1: p1[1], cyl };
}

// A hole's wall from rim a, as the body's faces join it: the curved faces that adjoin the rim, and
// those that adjoin them, until the planar faces it ends on. Each a cylinder, a cone or a fillet
// about a's axis, within four times a's radius; the cylinders one radius, the bore; the cones narrowing from a
// rim to it, or past it, a drill point. -> null when it is no such wall (a counterbore's step, a
// stepped or undercut hole, a face that is not of revolution, a wall that runs on past
// WALL_FACES), else { bore, end } with
// end: { face } of the planar face it comes out on, facing the other way (a through-hole's), or
// null where it stops inside (a blind hole's bottom, or a drill point) (round 23 Q5, carried open;
// r67; r68: two separate coaxial faces were taken as a wall, merging across a web, and a hole
// chamfered at both ends listed its bore nowhere)
const WALL_FACES = 64;
function holeWall(geom, a, faceN) {
  const nf = nodeFaces(geom);
  const out = faceN(a);
  // (into the material: against the rim's face's outside)
  const n = out.map((v) => -v), c = a.centre;
  const seen = new Set([a.face]), queue = [];
  const visit = (k) => { for (const fi of nf.get(k) || []) if (!seen.has(fi)) { seen.add(fi); queue.push(fi); } };
  for (const k of a.nodes) visit(k);
  const walls = [], ends = [], nodes = [];
  while (queue.length) {
    const fi = queue.pop(), f = geom.faces[fi];
    if (f.plane) { ends.push(fi); continue; }
    if (walls.length >= WALL_FACES) return null;
    // (no wider than four times the rim: walked from a hole's narrow end, its other end's chamfer is
    // wider than this rim -- capped at the rim, the walk was refused, which showed where the wide rim
    // was untold and only the narrow one walked: 262 m out, a hole split into a blind row -- r69.
    // A wall wider between is refused by the cones' and the bore's tests below)
    const rv = revolution(geom, f, c, n, 4 * a.radius);
    if (!rv) return null;
    walls.push(rv);
    for (const k of f.bnodes) { nodes.push(k); visit(k); }
  }
  // (behind the rim's face, as a through-hole's two rims are paired: a wall on the side its face
  // looks to is no hole of this face's -- the RK3399's layer whose normals look into its 0.27 mm,
  // read through by this walk and not by the pairing: r68)
  if (walls.some((w) => w.t0 < -PLANE_FLOOR_MM)) return null;
  const cyl = walls.filter((w) => w.cyl);
  // (its end: the planar faces it comes out on, one plane -- a face split across the hole is two, and
  // the walk refused it, the hole's rims left as blind rows at a fillet's Ø: r69 Q2)
  const e0 = ends.length ? geom.faces[ends[0]].plane : null;
  const onePlane = ends.every((fi) => { const p = geom.faces[fi].plane; return dot(p.normal, e0.normal) > 0.999 && Math.abs(p.d - e0.d) <= PLANE_FLOOR_MM + storedFloor(Math.max(...a.centre.map(Math.abs)) + a.radius); });
  if (!cyl.length || !onePlane) return null;
  // (the bore: the cylinders' one radius -- two of different radii meet only across a step, a face
  // that ends the walk, or a cone, which the test below refuses between them)
  const bore = Math.min(...cyl.map((w) => (w.r0 + w.r1) / 2));
  // the cones (and fillets): each between a rim and the bore -- narrowing toward the bore's part of
  // the axis; past the bore, one narrowing on below it is its bottom, a drill point (a countersunk
  // blind hole with one lost its bore: r69 Q3)
  const lo = Math.min(...cyl.map((w) => w.t0)), hi = Math.max(...cyl.map((w) => w.t1));
  let point = false;
  for (const w of walls) {
    if (w.cyl) continue;
    // (each place along the axis a shared vertex's, the same bits on both faces: compared as found)
    const before = w.t1 <= lo + PLANE_FLOOR_MM, after = w.t0 >= hi - PLANE_FLOOR_MM;
    if (after && w.r1 < bore * (1 - 2 * RADIUS_TOL) && w.r0 >= w.r1) { point = true; continue; }
    if (before ? !(w.r0 >= w.r1) : after ? !(w.r1 >= w.r0) : true) return null;
    if (Math.min(w.r0, w.r1) < bore * (1 - 2 * RADIUS_TOL)) return null;
  }
  if (point) return ends.length ? null : { bore, end: null, nodes };
  if (!ends.length) return { bore, end: null, nodes };
  const d = dot(e0.normal, out);
  // (through: out on a face looking the other way -- its depth that plane's distance, a rim there
  // or none told)
  if (d < -0.999) return { bore, end: { faces: ends, depth: Math.abs(dot(e0.normal, a.centre) - e0.d) }, nodes };
  // (facing the way a's does: a blind hole's bottom -- a disc -- or a step, holding the next bore)
  if (d > 0.999 && ends.every((fi) => !geom.faces[fi].untold && !geom.faces[fi].circles.some((x) => x.inner))) return { bore, end: null, nodes };
  return null;
}

// The holes of a body: circles on its planar faces that bound an inner loop
// (a face's loops other than its outer one), merged where the two rims of one
// through-hole meet the top and bottom faces (same axis, same radius), and those of other radii where
// the wall between joins them (holeWall: countersunk, chamfered, filleted).
// -> [{ centre, normal, diameter, depth, rims, head? }] sorted by diameter, then position, with
// .untold / .untoldAt: how many rims it cannot tell and their centres, .unpaired / .unpairedAt the
// through-holes left out as their other rim is one of them (head: a countersunk or chamfered hole's
// wider rim's Ø).
// A row's centre and normal are a rim's: the wider one's, past the radius test, else the one met
// first in the body's face order
// The hole table's order: by Ø, then by position. Ø to 6 significant digits, past which a fit's noise
// lies: four Ø 4 holes fitted 1e-7 apart were numbered by that noise, so the same plate in mm and in
// inches numbered its holes differently, and by no position (r121 M2). Its position too, on a grid of
// 1e-4 of its Ø: two holes in one column fitted 127.0000001 and 126.9999999 were ordered by x
const holeKey = (h) => { const g = (h.diameter || 1) * 1e-4; return [Number(h.diameter.toPrecision(6)), Math.round(h.centre[0] / g), Math.round(h.centre[1] / g)]; };
export const holeOrder = (a, b) => { const p = holeKey(a), q = holeKey(b); return p[0] - q[0] || p[1] - q[1] || p[2] - q[2]; };
export function holesOf(geom) {
  // a planar face's circle is a hole rim when it is not the face's outer
  // loop: the face lies outside it. A boss's top (a disc, the circle its
  // outer loop) and a washer's rim are not holes.
  const rims = [];
  for (const f of geom.faces) {
    if (!f.plane) continue;
    for (const c of f.circles) if (c.inner) rims.push(c);
  }
  // A through-hole's two rims: the nearest rim on its axis, of its radius, behind its face, whose
  // face looks the other way (its top's and its bottom's). Every such rim along the axis was merged: a clevis's
  // two flanges, 1.6 thick and 10 apart, read as one hole 10 deep
  // (a rim's face's outward normal: its plane's, which looks as its vertex normals do)
  const faceN = (c) => (geom.faces[c.face] && geom.faces[c.face].plane ? geom.faces[c.face].plane.normal : c.normal);
  // The candidates, by key: the radius, in steps of the radius test (and the steps either side),
  // and the axis line's point nearest the origin, in cells (and the cells round it) -- the same for
  // every rim on one line wherever along it, whatever its direction. (Every rim against every other
  // was 8.8 s of a 6,400-hole plate's 14.4 s; keyed on a rounded direction, a 30-degree bore 600
  // long drifted past the cells searched.) Each key's rims are sorted along their axis, and a rim
  // walks behind its face from where it stands, nearest first, stopping at the first that pairs:
  // 4,000 rims on one shared axis were each tried against all
  // (measured from the rims' own centre, the cell sized to how far they reach from it: from the
  // world origin, 5 m out a small bore's two rims fell 2 cells apart by their normals' noise)
  const rStep = Math.log(1 + RADIUS_TOL);
  const o = [0, 1, 2].map((k) => (rims.length ? rims.reduce((s2, c) => s2 + c.centre[k], 0) / rims.length : 0));
  const reach = rims.reduce((m2, c) => Math.max(m2, len(sub(c.centre, o))), 0);
  const CELL = Math.max(0.5, reach * 2e-4);
  // (the axis signed by a fixed direction no CAD axis lies across: by its first component not tiny,
  // one that should be 0 took either sign from float32 noise; by its largest, an axis with two
  // equal of opposite sign -- (0, 1, -1) -- took either; each time a bore's two rims sorted apart)
  const G = [0.5257311121, 0.6180339887, 0.5847102846];
  const canon = (n) => (dot(n, G) < 0 ? n.map((v) => -v) : n);
  // (and which way its face looks along the axis: a rim pairs only with one looking the other way,
  // so the two are kept apart -- 16,000 rims all looking one way each walked all the rest)
  const keyOf = (c) => {
    const n = c.normal, rc = sub(c.centre, o), al = dot(rc, n);
    const q = rc.map((x, k) => x - n[k] * al);
    return { r: Math.round(Math.log(c.radius) / rStep), q: q.map((x) => Math.floor(x / CELL)), t: dot(rc, canon(n)), f: dot(faceN(c), canon(n)) > 0 ? 1 : -1 };
  };
  const index = new Map();
  const keys = rims.map(keyOf);
  keys.forEach((k, i) => { const s = `${k.f}|${k.r}|${k.q.join(',')}`; let a = index.get(s); if (!a) index.set(s, (a = [])); a.push(i); });
  // each key's rims sorted along the axis, with links past the used ones either way (a used rim
  // walked over each time: 16,000 rims on one axis, 1.8 s)
  const place = new Map(); // rim -> [its key's array, its place]
  const skips = new Map(); // array -> { up: Int32Array, down: Int32Array }
  for (const a of index.values()) {
    a.sort((x, y) => keys[x].t - keys[y].t);
    a.forEach((j, p) => place.set(j, [a, p]));
    const up = new Int32Array(a.length + 1), down = new Int32Array(a.length + 1);
    for (let p = 0; p <= a.length; p++) { up[p] = p; down[p] = p; }
    skips.set(a, { up, down });
  }
  // the first unused place at or after p (up), at or before p (down; -1 for none), compressing
  const find = (arr, p) => { let r2 = p; while (arr[r2] !== r2) r2 = arr[r2]; while (arr[p] !== r2) { const nx = arr[p]; arr[p] = r2; p = nx; } return r2; };
  const nextUp = (a, p) => find(skips.get(a).up, p);
  const nextDown = (a, p) => (p < 0 ? -1 : find(skips.get(a).down, p + 1) - 1);
  const used = new Set();
  const markUsed = (j) => {
    used.add(j);
    const [a, p] = place.get(j), sk2 = skips.get(a);
    sk2.up[p] = p + 1; sk2.down[p + 1] = p;
  };
  const out = [], single = []; // (single: [rim, its row] of those no rim paired with)
  // whether rim j can be rim r's other end: its radius, its axis, facing the other way, on the
  // line, behind r's face (into the material: the nearest either way crossed an air gap thinner than
  // an arm -- a fork's arms 10 thick and 1 apart read as holes 1 and 21 deep) -> its distance, or -1
  const pairs = (r, s) => {
    if (Math.abs(s.radius - r.radius) > RADIUS_TOL * r.radius) return -1;
    if (Math.abs(Math.abs(dot(s.normal, r.normal)) - 1) > 1e-3) return -1;
    if (dot(faceN(s), faceN(r)) > -0.999) return -1;
    const d = sub(s.centre, r.centre);
    const along = dot(d, r.normal);
    if (len(sub(d, r.normal.map((v) => v * along))) > RADIUS_TOL * r.radius + 1e-6) return -1;
    if (dot(d, faceN(r)) >= 0) return -1;
    return Math.abs(along);
  };
  for (let i = 0; i < rims.length; i++) {
    if (used.has(i)) continue;
    const r = rims[i], k = keys[i];
    // (behind r's face, along its own sorted axis: the direction t grows or falls; among the rims
    // looking the other way)
    const s = k.f > 0 ? -1 : 1;
    let best = -1, bestAlong = Infinity;
    for (let dr = -1; dr <= 1; dr++) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const a = index.get(`${-k.f}|${k.r + dr}|${k.q[0] + dx},${k.q[1] + dy},${k.q[2] + dz}`);
      if (!a) continue;
      let lo = 0, hi = a.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (keys[a[mid]].t < k.t) lo = mid + 1; else hi = mid; }
      // walk from there, behind (the equal t either side looked at too), over the unused only
      let p = s > 0 ? lo : lo - 1;
      while (p > 0 && s > 0 && keys[a[p - 1]].t >= k.t - 1e-9) p--;
      while (p + 1 < a.length && s < 0 && keys[a[p + 1]].t <= k.t + 1e-9) p++;
      for (p = s > 0 ? nextUp(a, Math.max(0, p)) : nextDown(a, Math.min(a.length - 1, p)); p >= 0 && p < a.length; p = s > 0 ? nextUp(a, p + 1) : nextDown(a, p - 1)) {
        const j = a[p];
        if ((keys[j].t - k.t) * s > bestAlong + 1e-6) break;
        if (j === i) continue;
        const al = pairs(r, rims[j]);
        if (al >= 0) { if (al < bestAlong) { bestAlong = al; best = j; } break; }
      }
    }
    // (and a wall joins them: a curved face on the hole's cylinder spanning rim to rim -- two blind
    // holes drilled from either side, material between, read as one through-hole)
    if (best >= 0 && !wallJoins(geom, r, rims[best])) best = -1;
    markUsed(i);
    if (best >= 0) markUsed(best);
    out.push({ centre: r.centre, normal: r.normal, diameter: 2 * r.radius, depth: best >= 0 ? bestAlong : 0, rims: best >= 0 ? 2 : 1 });
    if (best < 0) single.push([i, out.length - 1]);
  }
  // The rims left single, each read by its wall as the body's faces join it (holeWall):
  //   - a wall out to a rim on a face looking the other way: a through-hole whose rims differ --
  //     countersunk, chamfered at either end or both -- one row: the bore's diameter, through, its
  //     depth, and the wider rim's diameter as `head` when wider than the bore (it was two one-rim
  //     rows: round 23 Q5, carried open; r67);
  //   - a wall out to such a face with no rim on it told, the face holding rims it cannot tell: a
  //     through-hole whose other rim cannot be told so far out -- untold too, not a blind hole
  //     (1 km out, a countersunk hole's narrow rim untold left its head a "blind" row: r68);
  //   - a wall that stops inside, from a rim wider than its bore: a countersunk blind hole, its
  //     bore's diameter (its bore was in no row: r68).
  // Each is the rim's own few faces, so a body of many is a walk per rim, not a search among all
  // that share its axis (r68 Q3: 16,000 such rims, 20 s).
  const singleOf = new Map(single.map(([i, row]) => [i, row]));
  const rimAt = new Map(); // a single rim's every node -> the rim
  for (const [i] of single) for (const k of rims[i].nodes || []) rimAt.set(k, i);
  const drop = new Set();
  const unpaired = []; // (the told rims of through-holes whose other end cannot be told)
  for (const [i, row] of single) {
    if (drop.has(row)) continue;
    const a = rims[i];
    const w = a.nodes && holeWall(geom, a, faceN);
    if (!w) continue;
    const wider = (r) => r > w.bore * (1 + 2 * RADIUS_TOL);
    if (!w.end) {
      if (wider(a.radius)) out[row] = { ...out[row], diameter: 2 * w.bore, head: 2 * a.radius };
      continue;
    }
    // (off the axis by the stored step of either rim, the farther: a plate across 2^18 mm, its top
    // stored twice as coarsely as its bottom, split its chamfered holes in two -- r69, the position test)
    const slack = (c) => RADIUS_TOL * c.radius + 2 * storedUlp(Math.max(...c.centre.map(Math.abs), ...a.centre.map(Math.abs))) + 1e-6;
    let best = -1, bestAlong = Infinity;
    // (the rims the wall's own nodes reach, on its end face)
    const near = new Set();
    for (const k of w.nodes) { const j = rimAt.get(k); if (j !== undefined) near.add(j); }
    for (const j of near) {
      const c = rims[j];
      if (j === i || !w.end.faces.includes(c.face) || !singleOf.has(j) || drop.has(singleOf.get(j))) continue;
      const d = sub(c.centre, a.centre), along = dot(d, a.normal);
      if (len(sub(d, a.normal.map((v) => v * along))) > slack(c) || c.radius < w.bore * (1 - 2 * RADIUS_TOL)) continue;
      if (Math.abs(along) < bestAlong) { bestAlong = Math.abs(along); best = j; }
    }
    if (best < 0) {
      if (w.end.faces.some((fi) => geom.faces[fi].untold)) { drop.add(row); unpaired.push(a.centre); continue; }
      // (no rim there that is a circle -- the face split across it, each half a half-circle: through
      // all the same, to that plane, its head this rim's when wider -- r69 Q2)
      out[row] = { centre: a.centre, normal: a.normal, diameter: 2 * w.bore, depth: w.end.depth, rims: 2, ...(wider(a.radius) ? { head: 2 * a.radius } : {}) };
      continue;
    }
    // (the row named at its wider rim, when wider past the radius test; else at the rim met first, as
    // the pairing names a through-hole: two rims alike, chamfered the same at both ends, were told
    // apart by float32 noise, and the row's end moved with where the model sat -- r69 A2)
    const b = rims[best], top = b.radius > a.radius * (1 + 2 * RADIUS_TOL) ? b : a;
    drop.add(singleOf.get(best));
    out[row] = { centre: top.centre, normal: top.normal, diameter: 2 * w.bore, depth: bestAlong, rims: 2, ...(wider(top.radius) ? { head: 2 * top.radius } : {}) };
  }
  if (drop.size) { const kept = out.filter((_, q) => !drop.has(q)); out.length = 0; out.push(...kept); }
  out.sort(holeOrder);
  // (and how many rims of flat faces the stored positions cannot tell, so far from the origin, and
  // where: the table says so -- r66 --; apart from them the holes left out as their other end is one,
  // whose own rim is told -- counted among the untold, it was a rim too small to tell that was not:
  // r69 Q7)
  out.untoldAt = geom.faces.flatMap((f) => (f.plane && f.untoldAt ? f.untoldAt : []));
  out.untold = out.untoldAt.length;
  out.unpairedAt = unpaired;
  out.unpaired = unpaired.length;
  return out;
}
