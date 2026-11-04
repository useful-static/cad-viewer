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

// a box: six faces of two triangles
export function box(lo, hi) {
  const c = (x, y, z) => P(x ? hi[0] : lo[0], y ? hi[1] : lo[1], z ? hi[2] : lo[2]);
  const q = (a, b, cc, d) => [[a, b, cc], [a, cc, d]];
  return [q(c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0)), q(c(0, 0, 1), c(0, 1, 1), c(1, 1, 1), c(1, 0, 1)),
    q(c(0, 0, 0), c(0, 0, 1), c(1, 0, 1), c(1, 0, 0)), q(c(0, 1, 0), c(1, 1, 0), c(1, 1, 1), c(0, 1, 1)),
    q(c(0, 0, 0), c(0, 1, 0), c(0, 1, 1), c(0, 0, 1)), q(c(1, 0, 0), c(1, 0, 1), c(1, 1, 1), c(1, 1, 0))];
}
