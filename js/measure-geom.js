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
//     do and an octagon could pass.
//
// Coordinates are the model's (mm).

const EPS_PLANAR = 1e-3; // of the radius: a rim's points off its plane
const RADIUS_TOL = 0.01;

export const circleMinPoints = (a) => (a > 0 && a < (2 * Math.PI) / 9 ? Math.ceil((2 * Math.PI) / a) - 1 : Infinity);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

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
  for (const [x, y, z] of xy) {
    if (Math.abs(z) > EPS_PLANAR * r) return null;
    if (Math.abs(Math.hypot(x - cx, y - cy) - r) > RADIUS_TOL * r) return null;
  }
  const centre = [0, 1, 2].map((k) => c[k] + ux[k] * cx + uy[k] * cy);
  return { centre, normal: nz, radius: r };
}

// A face's plane, or null when its triangles do not all lie in one:
// { normal, d } with normal · p = d
function planeOf(P, I, t0, nt) {
  let n = null;
  let p0 = null;
  let area = 0;
  for (let t = t0; t < t0 + nt; t++) {
    const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
    const pa = [P[a], P[a + 1], P[a + 2]], pb = [P[b], P[b + 1], P[b + 2]], pc = [P[c], P[c + 1], P[c + 2]];
    const cr = cross(sub(pb, pa), sub(pc, pa));
    const l = len(cr);
    if (l === 0) continue;
    if (!n || l > area) { n = cr.map((v) => v / l); p0 = pa; area = l; }
  }
  if (!n) return null;
  // every vertex on that plane, to a millionth of the face's size
  let lo = Infinity, hi = -Infinity, ext = 0;
  for (let t = t0; t < t0 + nt; t++) {
    for (let j = 0; j < 3; j++) {
      const v = I[3 * t + j] * 3;
      const p = [P[v], P[v + 1], P[v + 2]];
      const h = dot(sub(p, p0), n);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
      ext = Math.max(ext, len(sub(p, p0)));
    }
  }
  if (hi - lo > Math.max(1e-6 * ext, 1e-9)) return null;
  return { normal: n, d: dot(n, p0) };
}

// The loops of one face: its edges used by one of its triangles, chained by
// vertex index. -> [[vertex index, ...], ...]
function faceLoops(I, t0, nt) {
  const use = new Map();
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
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

const bitsKey = (P, v) => {
  const x = P[v * 3] || 0, y = P[v * 3 + 1] || 0, z = P[v * 3 + 2] || 0; // -0 made +0
  return `${x},${y},${z}`;
};

// One body's measurable geometry:
// { faces: [{ tri0, ntri, plane|null, circles: [{centre, normal, radius}] }],
//   corners: [[x,y,z]], edges: [[[x,y,z], ...]] (b-rep edges as polylines),
//   circles: all the faces' circles }
// model: { position, index, faces (Uint32Array pairs | null), header }.
// Without a faces section a body is one face with no circles.
export function bodyGeometry(model, meshIndex) {
  const P = model.position, I = model.index, h = model.header;
  const m = h.meshes[meshIndex];
  const a = h.angularDeflection ?? 0.5;
  const faces = [];
  const tri0 = m.idxStart / 3, ntri = m.idxCount / 3;
  if (model.faces && m.faceCount) {
    for (let f = m.faceStart; f < m.faceStart + m.faceCount; f++) {
      faces.push({ tri0: model.faces[2 * f], ntri: model.faces[2 * f + 1] });
    }
  } else faces.push({ tri0, ntri, whole: true });
  // welded boundary graph across the body's faces
  const node = new Map(); // bits -> { p, nb: Set }
  const segs = new Set();
  const circles = [];
  for (const f of faces) {
    f.plane = f.whole ? null : planeOf(P, I, f.tri0, f.ntri);
    f.circles = [];
    if (!f.ntri) continue;
    const loops = faceLoops(I, f.tri0, f.ntri);
    // the outer loop: the one with the largest extent (a face's holes lie
    // inside it); the others are inner, a hole's or a boss's foot
    const ext = loops.map((loop) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const v of loop) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[3 * v + k]); hi[k] = Math.max(hi[k], P[3 * v + k]); }
      return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    });
    const outer = ext.indexOf(Math.max(...ext));
    loops.forEach((loop, li) => {
      const pts = loop.map((v) => [P[3 * v], P[3 * v + 1], P[3 * v + 2]]);
      if (!f.whole) {
        const c = circleOf(pts, a);
        if (c) { c.face = faces.indexOf(f); c.inner = li !== outer; f.circles.push(c); circles.push(c); }
      }
      for (let i = 0; i < loop.length; i++) {
        const ka = bitsKey(P, loop[i]), kb = bitsKey(P, loop[(i + 1) % loop.length]);
        if (ka === kb) continue;
        for (const [k, v] of [[ka, loop[i]], [kb, loop[(i + 1) % loop.length]]]) {
          if (!node.has(k)) node.set(k, { p: [P[3 * v], P[3 * v + 1], P[3 * v + 2]], nb: new Set() });
        }
        node.get(ka).nb.add(kb);
        node.get(kb).nb.add(ka);
        segs.add(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
      }
    });
  }
  // corners: welded points where other than two boundary segments meet
  const corners = [];
  const isCorner = (k) => node.get(k).nb.size !== 2;
  for (const [k, v] of node) if (isCorner(k)) corners.push(v.p);
  // b-rep edges: walk from each corner along unvisited segments to the next
  // corner; what is left over are closed edges (a full circle's rim)
  const seen = new Set();
  const sk = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const edges = [];
  const walk = (start, first) => {
    const line = [node.get(start).p];
    let prev = start, cur = first;
    for (;;) {
      seen.add(sk(prev, cur));
      line.push(node.get(cur).p);
      if (isCorner(cur) || cur === start) break;
      const nx = [...node.get(cur).nb].find((n) => n !== prev && !seen.has(sk(cur, n)));
      if (nx === undefined) break;
      prev = cur;
      cur = nx;
    }
    edges.push(line);
  };
  for (const [k, v] of node) {
    if (!isCorner(k)) continue;
    for (const n of v.nb) if (!seen.has(sk(k, n))) walk(k, n);
  }
  for (const [k, v] of node) {
    for (const n of v.nb) if (!seen.has(sk(k, n))) walk(k, n);
  }
  return { faces, corners, edges, circles, segments: segs.size };
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

// The holes of a body: circles on its planar faces that bound an inner loop
// (a face's loops other than its outer one), merged where the two rims of one
// through-hole meet the top and bottom faces (same axis, same radius).
// -> [{ centre, normal, diameter, depth, rims }] sorted by diameter, then position
export function holesOf(geom) {
  // a planar face's circle is a hole rim when it is not the face's outer
  // loop: the face lies outside it. A boss's top (a disc, the circle its
  // outer loop) and a washer's rim are not holes.
  const rims = [];
  for (const f of geom.faces) {
    if (!f.plane) continue;
    for (const c of f.circles) if (c.inner) rims.push(c);
  }
  const out = [];
  const used = new Set();
  for (let i = 0; i < rims.length; i++) {
    if (used.has(i)) continue;
    const r = rims[i];
    let depth = 0;
    let rimCount = 1;
    for (let j = i + 1; j < rims.length; j++) {
      if (used.has(j)) continue;
      const s = rims[j];
      if (Math.abs(s.radius - r.radius) > RADIUS_TOL * r.radius) continue;
      if (Math.abs(Math.abs(dot(s.normal, r.normal)) - 1) > 1e-3) continue;
      const d = sub(s.centre, r.centre);
      const along = dot(d, r.normal);
      const off = len(sub(d, r.normal.map((v) => v * along)));
      if (off > 0.01 * r.radius + 1e-6) continue;
      used.add(j);
      rimCount++;
      depth = Math.max(depth, Math.abs(along));
    }
    used.add(i);
    out.push({ centre: r.centre, normal: r.normal, diameter: 2 * r.radius, depth, rims: rimCount });
  }
  return out.sort((a, b) => a.diameter - b.diameter || a.centre[0] - b.centre[0] || a.centre[1] - b.centre[1]);
}
