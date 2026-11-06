// The test bodies built the way OpenCascade meshes them, shared by tests/test-measure.mjs,
// test-drawing.mjs and test-scene.mjs: every b-rep face its own vertices, shared boundary points
// with identical floats, a faces section, and the vertex normals a decoded file always carries
// (made from the winding), so every arm runs the page's rule for a face's outside (the normals),
// not a winding-only path the page never takes. Not a test file (run-all runs tests/test-*.mjs).

// a decoded model of bodies of faces, each face a list of triangles given as point triples;
// points deduplicated within a face only
export function model(bodies, angularDeflection = 0.5) {
  const pos = [], idx = [], faces = [], meshes = [];
  for (const b of bodies) {
    const m = { name: b.name, vtxStart: pos.length / 3, idxStart: idx.length, faceStart: faces.length / 2, faceCount: b.faces.length };
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const f of b.faces) {
      const map = new Map();
      faces.push(idx.length / 3, f.length);
      for (const tri of f) {
        for (const p of tri) {
          const k = p.join(',');
          if (!map.has(k)) { map.set(k, pos.length / 3); pos.push(...p); for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], p[j]); hi[j] = Math.max(hi[j], p[j]); } }
          idx.push(map.get(k));
        }
      }
    }
    m.idxCount = idx.length - m.idxStart;
    m.vtxCount = pos.length / 3 - m.vtxStart;
    m.bbox = { min: lo, max: hi };
    meshes.push(m);
  }
  return withNormals({
    position: new Float32Array(pos), index: new Uint32Array(idx), faces: new Uint32Array(faces),
    header: { meshes, angularDeflection },
  });
}

// the vertex normals of a model, as the file stores them (snorm16 x4), from its winding; flip:
// its triangles then wound the other way, the normals kept (a mirrored placement's shape)
export function withNormals(m, flip = false) {
  const P = m.position, I = m.index, N = new Float64Array(P.length);
  for (let t = 0; t < I.length / 3; t++) {
    const [a, b, c] = [I[3 * t], I[3 * t + 1], I[3 * t + 2]].map((v) => [P[3 * v], P[3 * v + 1], P[3 * v + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) N[3 * I[3 * t + j] + k] += n[k];
  }
  m.normal = new Int16Array(P.length / 3 * 4);
  for (let v = 0; v < P.length / 3; v++) {
    const l = Math.hypot(N[3 * v], N[3 * v + 1], N[3 * v + 2]) || 1;
    for (let k = 0; k < 3; k++) m.normal[4 * v + k] = Math.round((N[3 * v + k] / l) * 32767);
  }
  if (flip) for (let t = 0; t < I.length / 3; t++) { const x = I[3 * t + 1]; I[3 * t + 1] = I[3 * t + 2]; I[3 * t + 2] = x; }
  return m;
}

export const P = (x, y, z) => [Math.fround(x), Math.fround(y), Math.fround(z)];

// a washer: inner radius ri, outer ro, z from z0 to z0 + h, n segments, about (cx, cy); four faces
export function washer(ri, ro, h, n, cx = 0, cy = 0, z0 = 0) {
  const ring = (r, z) => Array.from({ length: n }, (_, i) => P(cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n), z));
  const it = ring(ri, z0 + h), ot = ring(ro, z0 + h), ib = ring(ri, z0), ob = ring(ro, z0);
  const band = (a, b) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); } return t; };
  return [band(it, ot), band(ob, ib), band(ib, it), band(ot, ob)];
}

// The hole shapes the hole table is held to, each a plate 4 thick about (cx, cy) with one hole
// through or into it, a bore of Ø3, and the row it reads as: [Ø, rims, depth, the wider rim's Ø or 0]
// (test-measure's arms read them at the origin and 20 m out; test-hole-position moves them all as
// one model -- r68 Q10, r69 Q5: no board holds a countersunk row, and the position test's
// countersink check could not fire)
export function holeShapes(cx = 0, cy = 0) {
  const n = 48, ro = 8, H = 4, r = 1.5;
  const ring = (rr, z) => Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; return P(cx + rr * Math.cos(t), cy + rr * Math.sin(t), z); });
  const band = (a, b) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); } return t; };
  const disc = (rr, z, up) => { const c = P(cx, cy, z), e = ring(rr, z), t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push(up ? [c, e[i], e[j]] : [c, e[j], e[i]]); } return t; };
  // (its top's rim tr, its bottom's br, and the wall between, faces bottom to top)
  const plate = (tr, br, wall) => [band(ring(tr, H), ring(ro, H)), band(ring(ro, 0), ring(br, 0)), ...wall, band(ring(ro, H), ring(ro, 0))];
  // a quarter-round fillet R0.5 from the rim at z (radius r + 0.5) into the bore, one face of 6
  // bands; s: +1 up from the bottom rim, -1 down from the top one
  const fillet = (z, s) => {
    const k = 6, pts = Array.from({ length: k + 1 }, (_, i) => { const t = (Math.PI / 2) * (i / k); return [r + 0.5 - 0.5 * Math.sin(t), z + s * 0.5 * (1 - Math.cos(t))]; });
    const rings = (s > 0 ? pts : pts.reverse()).map(([rr, zz]) => ring(rr, zz));
    return rings.slice(1).flatMap((b2, i) => band(rings[i], b2));
  };
  // a drill point: the bore's bottom ring at z narrowing to its tip h below, one face
  const tip = (rr, z, h) => { const c = P(cx, cy, z - h), e = ring(rr, z), t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([c, e[j], e[i]]); } return t; };
  const chamfered = (c1, c2) => plate(r + c1, r + c2, [band(ring(r + c2, 0), ring(r, c2)), band(ring(r, c2), ring(r, H - c1)), band(ring(r, H - c1), ring(r + c1, H))]);
  return [
    ['a plain through-hole', plate(r, r, [band(ring(r, 0), ring(r, H))]), [[3, 2, 4, 0]]],
    ['countersunk', plate(3, r, [band(ring(r, 0), ring(r, H - 1.5)), band(ring(r, H - 1.5), ring(3, H))]), [[3, 2, 4, 6]]],
    ['chamfered 1 top, 0.5 bottom', chamfered(1, 0.5), [[3, 2, 4, 5]]],
    ['chamfered 0.5 both ends', chamfered(0.5, 0.5), [[3, 2, 4, 4]]],
    ['countersunk, deburred 0.3 at the bottom', plate(3, r + 0.3, [band(ring(r + 0.3, 0), ring(r, 0.3)), band(ring(r, 0.3), ring(r, H - 1.5)), band(ring(r, H - 1.5), ring(3, H))]), [[3, 2, 4, 6]]],
    ['countersunk from both sides, heads Ø6 and Ø5', plate(3, 2.5, [band(ring(2.5, 0), ring(r, 1)), band(ring(r, 1), ring(r, H - 1.5)), band(ring(r, H - 1.5), ring(3, H))]), [[3, 2, 4, 6]]],
    ['a countersink over a blind bore', [band(ring(3, H), ring(ro, H)), band(ring(r, 1), ring(r, H - 1.5)), band(ring(r, H - 1.5), ring(3, H)), disc(r, 1, true), disc(ro, 0, false), band(ring(ro, H), ring(ro, 0))], [[3, 1, 0, 6]]],
    // (r69 Q2: a rim filleted R0.5 into its bore, at both ends -- the fillet's radius no straight line)
    ['filleted R0.5 at both ends', plate(r + 0.5, r + 0.5, [fillet(0, 1), band(ring(r, 0.5), ring(r, H - 0.5)), fillet(H, -1)]), [[3, 2, 4, 4]]],
    // (r69 Q3: countersunk, a blind bore, and a drill point at its bottom)
    // (a 118-degree point, 0.9 deep: a point 0.13 deep read as flat far out, below what float32 can tell)
    ['countersunk, a blind bore with a drill point', [band(ring(3, H), ring(ro, H)), band(ring(r, 1), ring(r, H - 1.5)), band(ring(r, H - 1.5), ring(3, H)), tip(r, 1, 0.9), disc(ro, 0, false), band(ring(ro, H), ring(ro, 0))], [[3, 1, 0, 6]]],
    // (r69 Q2: out on a face split in two across the hole, each half holding half its rim -- no circle there)
    ['through to a face split across it', (() => {
      const all = band(ring(ro, 0), ring(r, 0)), half = all.length / 2;
      return [band(ring(r, H), ring(ro, H)), all.slice(0, half), all.slice(half), band(ring(r, 0), ring(r, H)), band(ring(ro, H), ring(ro, 0))];
    })(), [[3, 2, 4, 0]]],
    // must accept: a counterbore and a stepped hole -- their step a face of their own -- are two rows
    ['a counterbore', plate(3, r, [band(ring(r, 0), ring(r, 2)), band(ring(r, 2), ring(3, 2)), band(ring(3, 2), ring(3, H))]), [[3, 2, 2, 0], [6, 1, 0, 0]]],
    ['a stepped hole, a drill-point step', plate(3, r, [band(ring(r, 0), ring(r, 1.5)), band(ring(r, 1.5), ring(3, 2)), band(ring(3, 2), ring(3, H))]), [[3, 1, 0, 0], [6, 1, 0, 0]]],
    // must accept: a body inside out -- its faces looking into its thickness -- holds no hole of theirs
    ['a chamfered hole in a body wound inside out', chamfered(1, 0.5).map((f) => f.map(([a, b, c]) => [a, c, b])), [[4, 1, 0, 0], [5, 1, 0, 0]]],
  ];
}

// a box: six faces of two triangles
export function box(lo, hi) {
  const c = (x, y, z) => P(x ? hi[0] : lo[0], y ? hi[1] : lo[1], z ? hi[2] : lo[2]);
  const q = (a, b, cc, d) => [[a, b, cc], [a, cc, d]];
  return [q(c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0)), q(c(0, 0, 1), c(0, 1, 1), c(1, 1, 1), c(1, 0, 1)),
    q(c(0, 0, 0), c(0, 0, 1), c(1, 0, 1), c(1, 0, 0)), q(c(0, 1, 0), c(1, 1, 0), c(1, 1, 1), c(0, 1, 1)),
    q(c(0, 0, 0), c(0, 1, 0), c(0, 1, 1), c(0, 0, 1)), q(c(1, 0, 0), c(1, 0, 1), c(1, 1, 1), c(1, 1, 0))];
}
