// The edge list and the body facts, from a decoded model's global arrays, in
// one pass per body. Pure, no DOM: run by the converter (js/cadmesh.js, so a
// new .cadmesh carries them) and by a worker for an older .cadmesh; its closed
// test (shellsOf) also by the mesh readers' weld, to turn a shell wound the
// wrong way (shellTurns, js/mesh-formats.js).
//
// OpenCascade meshes every b-rep face with its own vertices and never splits
// a face at its seam, so within a body:
//   - an edge (by vertex INDEX) used by one triangle is a face boundary. Each
//     boundary between two faces appears twice, once per face, with
//     different indices; the copies are joined by welding the positions on
//     their exact bits (-0 made +0) and the one of the lower-numbered
//     triangle is kept, i.e. of the lower-numbered face, so the edge takes
//     that face's vertex colour whatever the weld does.
//   - an edge used by two triangles is inside a face. It is a silhouette
//     candidate when its two triangles' normals differ (by more than 1e-4 in
//     any component): inside a flat face, or between two coplanar triangles
//     of a curved one, the normals are equal and the edge can never be on an
//     outline. The second normal is flipped when both triangles traverse the
//     edge the same way, so an inconsistently wound mesh is not all outline.
//
// Body facts: area, and |signed volume| (float64, centred on the body, abs so
// a mirrored instance is positive). Closed comes from the header's kind (the
// converter takes it from the b-rep); only a body without kind falls back to
// the mesh: welded edges, degenerate triangles skipped (no area against the
// body's size: |cross| <= 1e-14 of its diagonal squared), open where an edge
// is used once.
//
// Returns { edges: Uint32Array (a, b) pairs, silhouettes: Uint32Array pairs |
// null, silhouetteNormals: Int16Array (nx ny nz 0) x 2 per candidate | null,
// silhouettesOmitted: count left out over the cap (0), facts: { closed,
// area, volume } arrays per body }.

export const SILHOUETTE_CAP = 2_000_000;

// The body table the renderers read in the vertex shader, indexed by body id
// (mesh index + 1; slot 0 unused): two vec4 per body, the explode direction
// (xyz, 0 until Explode exists) and the centre plus radius (half the bbox
// diagonal). A body without vertices gets radius 0.
export function bodyTable(header) {
  const n = header.meshes.length;
  const t = new Float32Array((n + 1) * 8);
  header.meshes.forEach((m, i) => {
    const b = m.bbox;
    if (!b) return;
    const o = (i + 1) * 8 + 4;
    for (let k = 0; k < 3; k++) t[o + k] = (b.min[k] + b.max[k]) / 2;
    t[o + 3] = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
  });
  return t;
}

// The renderers' edge instances: per edge p0, p1 (float32x3), the body id
// and a colour (unorm8x4), 32 bytes. The colour is the drawn colour of the
// edge's first vertex: the kept copy's, i.e. the lower-numbered face's, so a
// colour scheme or a picked part colour carries over.
export const EDGE_STRIDE = 32;
export function edgeInstances({ position, color, id }, edges) {
  const n = edges.length / 2;
  const out = new ArrayBuffer(n * EDGE_STRIDE);
  const f = new Float32Array(out);
  const b = new Uint8Array(out);
  for (let e = 0; e < n; e++) {
    const a = edges[e * 2], c = edges[e * 2 + 1];
    const o = e * 8;
    f[o] = position[a * 3]; f[o + 1] = position[a * 3 + 1]; f[o + 2] = position[a * 3 + 2];
    f[o + 3] = position[c * 3]; f[o + 4] = position[c * 3 + 1]; f[o + 5] = position[c * 3 + 2];
    const ob = e * EDGE_STRIDE;
    for (let k = 0; k < 4; k++) {
      b[ob + 24 + k] = id[a * 4 + k];
      b[ob + 28 + k] = color[a * 4 + k];
    }
  }
  return out;
}

// The silhouette candidates' instances: an edge instance (as above) and the
// normals of its two triangles (snorm16x4 each, w = 0), 48 bytes. The
// vertex shader keeps one only where the normals face opposite ways from the
// eye: then the edge is on the outline.
export const SIL_STRIDE = 48;
export function silhouetteInstances(mesh, sil, silN) {
  const n = sil.length / 2;
  const out = new ArrayBuffer(n * SIL_STRIDE);
  const head = new Uint8Array(edgeInstances(mesh, sil));
  const b = new Uint8Array(out);
  const s = new Int16Array(out);
  for (let e = 0; e < n; e++) {
    b.set(head.subarray(e * EDGE_STRIDE, (e + 1) * EDGE_STRIDE), e * SIL_STRIDE);
    s.set(silN.subarray(e * 8, e * 8 + 8), (e * SIL_STRIDE + EDGE_STRIDE) / 2);
  }
  return out;
}

const NORMAL_EPS = 1e-4;

const pow2 = (n) => { let s = 16; while (s < n) s *= 2; return s; };

export function buildEdges({ position, index, meshes }, { silhouetteCap = SILHOUETTE_CAP } = {}) {
  const bits = new Uint32Array(position.buffer, position.byteOffset, position.length);
  const edges = [];
  let sil = [];
  let silN = [];
  let silCount = 0;
  const closed = [];
  const area = [];
  const volume = [];
  for (const m of meshes) {
    const r = body(position, bits, index, m, edges, sil, silN);
    silCount += r.sil;
    closed.push(m.kind ? (m.kind === 'closed' || m.kind === 'capped') : r.closed);
    area.push(r.area);
    volume.push(r.volume);
  }
  const omitted = silCount > silhouetteCap ? silCount : 0;
  if (omitted) { sil = null; silN = null; }
  return {
    edges: Uint32Array.from(edges),
    silhouettes: sil ? Uint32Array.from(sil) : null,
    silhouetteNormals: silN ? Int16Array.from(silN) : null,
    silhouettesOmitted: omitted,
    facts: { closed, area, volume },
  };
}

function body(pos, bits, index, m, edges, sil, silN) {
  const nt = m.idxCount / 3;
  const t0 = m.idxStart / 3;
  const v0 = m.vtxStart;
  const nv = m.vtxCount;
  if (!nt || !nv) return { sil: 0, closed: false, area: 0, volume: 0 };

  const weld = weldBits(bits, v0, nv);
  const { tn, degenerate, A, V } = triangleFacts(pos, index, t0, nt, m.bbox);

  // edges by vertex index: count, first and second triangle, direction.
  // Every open-addressed table here holds at most 3 entries per triangle
  // (no triangle shares an edge), so it gets 6 slots per triangle: never more
  // than half full. A full table never ends its probe loop (a 512-triangle
  // ribbon of one-triangle faces hung the boundary table at 2 per triangle).
  const esize = pow2(nt * 6);
  const eA = new Int32Array(esize).fill(-1);
  const eB = new Int32Array(esize);
  const eCount = new Uint8Array(esize);
  const eT1 = new Int32Array(esize);
  const eT2 = new Int32Array(esize);
  const eFwd1 = new Uint8Array(esize);
  const eFwd2 = new Uint8Array(esize);
  const slot = (p, q) => {
    let h = (Math.imul(p, 2654435761) ^ Math.imul(q, 40503)) & (esize - 1);
    while (eA[h] >= 0 && !(eA[h] === p && eB[h] === q)) h = (h + 1) & (esize - 1);
    return h;
  };
  for (let t = 0; t < nt; t++) {
    const i = (t0 + t) * 3;
    for (let k = 0; k < 3; k++) {
      const a = index[i + k], b = index[i + (k + 1) % 3];
      const p = Math.min(a, b), q = Math.max(a, b);
      const h = slot(p, q);
      if (eA[h] < 0) { eA[h] = p; eB[h] = q; }
      const n = eCount[h];
      if (n === 0) { eT1[h] = t; eFwd1[h] = a < b ? 1 : 0; }
      else if (n === 1) { eT2[h] = t; eFwd2[h] = a < b ? 1 : 0; }
      if (n < 255) eCount[h] = n + 1;
    }
  }

  // boundary copies joined by the weld, kept from the lowest triangle (the
  // triangles are visited in order, so the first copy seen is kept)
  const bsize = pow2(nt * 6);
  const bA = new Int32Array(bsize).fill(-1);
  const bB = new Int32Array(bsize);
  let nsil = 0;
  for (let t = 0; t < nt; t++) {
    const i = (t0 + t) * 3;
    for (let k = 0; k < 3; k++) {
      const a = index[i + k], b = index[i + (k + 1) % 3];
      const h = slot(Math.min(a, b), Math.max(a, b));
      const n = eCount[h];
      if (n === 2) {
        // inside a face: once, from its first triangle
        if (eT1[h] !== t) continue;
        const t1 = eT1[h], t2 = eT2[h];
        if (degenerate[t1] || degenerate[t2]) continue;
        let n2x = tn[t2 * 3], n2y = tn[t2 * 3 + 1], n2z = tn[t2 * 3 + 2];
        // the same direction twice: inconsistent winding, so flip the second
        if (eFwd1[h] === eFwd2[h]) { n2x = -n2x; n2y = -n2y; n2z = -n2z; }
        const n1x = tn[t1 * 3], n1y = tn[t1 * 3 + 1], n1z = tn[t1 * 3 + 2];
        if (Math.abs(n1x - n2x) <= NORMAL_EPS && Math.abs(n1y - n2y) <= NORMAL_EPS && Math.abs(n1z - n2z) <= NORMAL_EPS) continue;
        nsil++;
        if (sil) {
          sil.push(a, b);
          silN.push(Math.round(n1x * 32767), Math.round(n1y * 32767), Math.round(n1z * 32767), 0,
            Math.round(n2x * 32767), Math.round(n2y * 32767), Math.round(n2z * 32767), 0);
        }
        continue;
      }
      // a face boundary (or, past two uses, a non-manifold index edge)
      if (n > 2 && eT1[h] !== t) continue;
      const wa = weld[a - v0] + v0, wb = weld[b - v0] + v0;
      const p = Math.min(wa, wb), q = Math.max(wa, wb);
      let g = (Math.imul(p, 2654435761) ^ Math.imul(q, 40503)) & (bsize - 1);
      while (bA[g] >= 0 && !(bA[g] === p && bB[g] === q)) g = (g + 1) & (bsize - 1);
      if (bA[g] >= 0) continue; // the other face's copy: already kept
      bA[g] = p; bB[g] = q;
      edges.push(a, b);
    }
  }

  return { sil: nsil, closed: m.kind ? null : shellsOf(index, t0, nt, weld, v0, nv, degenerate).closed, area: A, volume: Math.abs(V) };
}

// weld: each vertex of a body (v0, nv; bits: the positions' float32 bits) -> the first vertex of
// the body with the same bits (-0 and +0 are one position)
function weldBits(bits, v0, nv) {
  const wsize = pow2(nv * 2);
  const wtab = new Int32Array(wsize).fill(-1);
  const weld = new Uint32Array(nv);
  const bit = (o) => (bits[o] === 0x80000000 ? 0 : bits[o]);
  for (let v = 0; v < nv; v++) {
    const o = (v0 + v) * 3;
    const x = bit(o), y = bit(o + 1), z = bit(o + 2);
    // (mixed to the low bits: a float on a whole number has its low mantissa bits all 0, and the
    // products alone clustered a grid of such points into long probe runs -- 20,000 unit cubes on
    // whole-number corners took 7.5 s to weld)
    let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    h &= wsize - 1;
    for (;;) {
      const w = wtab[h];
      if (w < 0) { wtab[h] = v; weld[v] = v; break; }
      const p = (v0 + w) * 3;
      if (bit(p) === x && bit(p + 1) === y && bit(p + 2) === z) { weld[v] = w; break; }
      h = (h + 1) & (wsize - 1);
    }
  }
  return weld;
}

// per triangle: its unit normal (tn), whether it is degenerate (no area against the body's
// diagonal: such a triangle has no normal, no silhouette and no say in closed), its signed-volume
// term (vol); and the body's area and signed volume (float64, centred on the body's box bb)
function triangleFacts(pos, index, t0, nt, bb) {
  const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2, cz = (bb.min[2] + bb.max[2]) / 2;
  const diag2 = (bb.max[0] - bb.min[0]) ** 2 + (bb.max[1] - bb.min[1]) ** 2 + (bb.max[2] - bb.min[2]) ** 2;
  const tn = new Float32Array(nt * 3);
  const degenerate = new Uint8Array(nt);
  const vol = new Float64Array(nt);
  let A = 0;
  let V = 0;
  for (let t = 0; t < nt; t++) {
    const i = (t0 + t) * 3;
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    const ax = pos[a] - cx, ay = pos[a + 1] - cy, az = pos[a + 2] - cz;
    const bx = pos[b] - cx, by = pos[b + 1] - cy, bz = pos[b + 2] - cz;
    const qx = pos[c] - cx, qy = pos[c + 1] - cy, qz = pos[c + 2] - cz;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = qx - ax, wy = qy - ay, wz = qz - az;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    A += len / 2;
    vol[t] = (ax * (by * qz - bz * qy) + ay * (bz * qx - bx * qz) + az * (bx * qy - by * qx)) / 6;
    V += vol[t];
    if (len <= diag2 * 1e-14) { degenerate[t] = 1; continue; }
    tn[t * 3] = nx / len; tn[t * 3 + 1] = ny / len; tn[t * 3 + 2] = nz / len;
  }
  return { tn, degenerate, vol, A, V };
}

// The one test of "is this mesh closed" (the facts' closed, and the weld's turning of a shell
// wound inward): over the non-degenerate triangles, on the welded vertices, every edge used at
// least twice (more than twice is non-manifold, not open). Per shell too: the shells are those
// triangles joined across an edge used by exactly two of them -- not across a shared vertex, which
// made two parts touching at a corner one shell, turned by their summed volume. Returns { closed,
// shell: Int32Array, a triangle's shell (-1: degenerate), shellOpen: Uint8Array per shell }.
// Typed tables throughout: a Map of edges at the 10 M-triangle cap was 8.7 s and 683 MB.
function shellsOf(index, t0, nt, weld, v0, nv, degenerate) {
  const parent = new Int32Array(nt);
  for (let t = 0; t < nt; t++) parent[t] = t;
  const find = (t) => { while (parent[t] !== t) { parent[t] = parent[parent[t]]; t = parent[t]; } return t; };
  // the edges as lists per lower welded vertex (counted, then filled): each entry the other end
  // and the triangle, one number (other * nt + triangle: under 2^53 at every cap), each list
  // sorted in place and read by runs -- a run one long is an edge used once (open), two long the
  // edge joining its two triangles' shells
  const off = new Uint32Array(nv + 1);
  const each = (fn) => {
    for (let t = 0; t < nt; t++) {
      if (degenerate[t]) continue;
      const i = (t0 + t) * 3;
      for (let k = 0; k < 3; k++) {
        const a = weld[index[i + k] - v0], b = weld[index[i + (k + 1) % 3] - v0];
        if (a !== b) fn(a < b ? a : b, a < b ? b : a, t);
      }
    }
  };
  each((p) => { off[p + 1]++; });
  for (let v = 0; v < nv; v++) off[v + 1] += off[v];
  const fill = off.slice(0, nv);
  const nb = new Float64Array(off[nv]);
  each((p, q, t) => { nb[fill[p]++] = q * nt + t; });
  const openTri = new Uint8Array(nt);
  let closed = true;
  for (let p = 0; p < nv; p++) {
    const lo = off[p], hi = off[p + 1];
    // insertion sort for the usual short list; a hub's (a fan's centre) by the typed sort, not quadratic
    if (hi - lo > 32) nb.subarray(lo, hi).sort();
    else {
      for (let j = lo + 1; j < hi; j++) {
        const x = nb[j];
        let k = j - 1;
        while (k >= lo && nb[k] > x) { nb[k + 1] = nb[k]; k--; }
        nb[k + 1] = x;
      }
    }
    for (let j = lo; j < hi;) {
      const q = Math.floor(nb[j] / nt);
      let e = j + 1;
      while (e < hi && Math.floor(nb[e] / nt) === q) e++;
      if (e - j === 1) { closed = false; openTri[nb[j] - q * nt] = 1; }
      else if (e - j === 2) { const a = find(nb[j] - q * nt), b = find(nb[j + 1] - q * nt); if (a !== b) parent[b] = a; }
      j = e;
    }
  }
  const sid = new Int32Array(nt).fill(-1), shell = new Int32Array(nt).fill(-1);
  let ns = 0;
  for (let t = 0; t < nt; t++) {
    if (degenerate[t]) continue;
    const r = find(t);
    if (sid[r] < 0) sid[r] = ns++;
    shell[t] = sid[r];
  }
  const shellOpen = new Uint8Array(ns);
  for (let t = 0; t < nt; t++) if (openTri[t]) shellOpen[shell[t]] = 1;
  return { closed, shell, shellOpen };
}

// A fixed direction no CAD axis or face lies along, for the nesting rays
const RAY = (() => { const d = [0.3141592, 0.5772156, 0.7536422], l = Math.hypot(...d); return d.map((x) => x / l); })();

// The shells of one body (position: float32 xyz; index: corner ids into it, its own), by the
// facts' own test (shellsOf) on the float32 positions the body is stored with, and the triangles
// of each CLOSED shell wound the wrong way for where it lies: a shell inside an even number of
// the body's other closed shells (none: an outer surface) faces out, its signed volume positive;
// inside an odd number (a cavity, wound inward on purpose) its volume is negative. Nesting is
// counted by a ray's crossings of each other closed shell from three points on the shell (a
// majority: a point on a touching part's face is no answer). One body may hold a part wound out
// beside one wound in, a solid with a cavity, a part in a cavity. Returns { shell, flip: a
// Uint8Array per triangle, or null when none is turned }.
export function shellTurns(position, index) {
  const nt = index.length / 3;
  if (!nt) return { shell: new Int32Array(0), flip: null };
  const nv = position.length / 3;
  // (the box of the vertices the triangles use, as the stored body's)
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < index.length; i++) {
    const v = index[i] * 3;
    for (let k = 0; k < 3; k++) { const p = position[v + k]; if (p < min[k]) min[k] = p; if (p > max[k]) max[k] = p; }
  }
  const bits = new Uint32Array(position.buffer, position.byteOffset, position.length);
  const weld = weldBits(bits, 0, nv);
  const { degenerate, vol } = triangleFacts(position, index, 0, nt, { min, max });
  const { shell, shellOpen } = shellsOf(index, 0, nt, weld, 0, nv, degenerate);
  const ns = shellOpen.length;
  const V = new Float64Array(ns);
  for (let t = 0; t < nt; t++) if (shell[t] >= 0) V[shell[t]] += vol[t];
  const closedShells = [];
  for (let s = 0; s < ns; s++) if (!shellOpen[s]) closedShells.push(s);
  const flipShell = new Uint8Array(ns);
  let any = false;
  if (closedShells.length === 1) {
    // (one closed shell: nested in nothing, an outer surface)
    const s = closedShells[0];
    if (V[s] < 0) { flipShell[s] = 1; any = true; }
  } else if (closedShells.length > 1) {
    const P = position;
    // per shell: its box, its triangles (a typed list, grouped by shell), its three largest triangles
    const lo = new Float64Array(3 * ns).fill(Infinity), hi = new Float64Array(3 * ns).fill(-Infinity);
    const start = new Uint32Array(ns + 1);
    for (let t = 0; t < nt; t++) if (shell[t] >= 0) start[shell[t] + 1]++;
    for (let s = 0; s < ns; s++) start[s + 1] += start[s];
    const at = start.slice(0, ns), list = new Uint32Array(start[ns]);
    const big = new Int32Array(3 * ns).fill(-1), bigA = new Float64Array(3 * ns);
    for (let t = 0; t < nt; t++) {
      const s = shell[t];
      if (s < 0) continue;
      list[at[s]++] = t;
      const a = 3 * index[3 * t], b = 3 * index[3 * t + 1], c = 3 * index[3 * t + 2];
      for (const v of [a, b, c]) for (let k = 0; k < 3; k++) { const x = P[v + k]; if (x < lo[3 * s + k]) lo[3 * s + k] = x; if (x > hi[3 * s + k]) hi[3 * s + k] = x; }
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
      const area = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
      // (kept in order, largest first)
      for (let j = 0; j < 3; j++) {
        if (big[3 * s + j] < 0 || area > bigA[3 * s + j]) {
          for (let m = 2; m > j; m--) { big[3 * s + m] = big[3 * s + m - 1]; bigA[3 * s + m] = bigA[3 * s + m - 1]; }
          big[3 * s + j] = t; bigA[3 * s + j] = area;
          break;
        }
      }
    }
    // the crossings of the ray from (px, py, pz) along RAY with shell o's triangles (Moeller-Trumbore)
    const [dx, dy, dz] = RAY;
    const crossings = (px, py, pz, o) => {
      let n = 0;
      for (let j = start[o]; j < start[o + 1]; j++) {
        const t = list[j], a = 3 * index[3 * t], b = 3 * index[3 * t + 1], c = 3 * index[3 * t + 2];
        const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
        const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
        const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (det === 0) continue;
        const sx = px - P[a], sy = py - P[a + 1], sz = pz - P[a + 2];
        const u = (sx * hx + sy * hy + sz * hz) / det;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const w = (dx * qx + dy * qy + dz * qz) / det;
        if (w < 0 || u + w > 1) continue;
        if ((e2x * qx + e2y * qy + e2z * qz) / det > 0) n++;
      }
      return n;
    };
    // the shells whose box holds a point, without a pass over every shell (each against each was
    // 10.7 s for 20,000 cubes): the closed shells by their box's low x, with the highest high x so
    // far, walked back from the last that starts at or before the point while one can reach it
    const byLo = closedShells.slice().sort((a, b) => lo[3 * a] - lo[3 * b]);
    const reach = new Float64Array(byLo.length);
    byLo.forEach((o, k) => { reach[k] = Math.max(k ? reach[k - 1] : -Infinity, hi[3 * o]); });
    const holding = (px, py, pz, fn) => {
      let a = 0, b = byLo.length;
      while (a < b) { const m = (a + b) >> 1; if (lo[3 * byLo[m]] <= px) a = m + 1; else b = m; }
      for (let k = a - 1; k >= 0 && reach[k] >= px; k--) {
        const o = byLo[k];
        if (px <= hi[3 * o] && py >= lo[3 * o + 1] && py <= hi[3 * o + 1] && pz >= lo[3 * o + 2] && pz <= hi[3 * o + 2]) fn(o);
      }
    };
    for (const s of closedShells) {
      // three points on the shell, the centroids of its largest triangles; a point nested an odd
      // number of times lies in a cavity, by the majority of the three
      let odd = 0, pts = 0;
      for (let j = 0; j < 3; j++) {
        const t = big[3 * s + j];
        if (t < 0) continue;
        pts++;
        const a = 3 * index[3 * t], b = 3 * index[3 * t + 1], c = 3 * index[3 * t + 2];
        const px = (P[a] + P[b] + P[c]) / 3, py = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, pz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
        let depth = 0;
        holding(px, py, pz, (o) => { if (o !== s && crossings(px, py, pz, o) % 2 === 1) depth++; });
        if (depth % 2 === 1) odd++;
      }
      const cavity = odd * 2 > pts;
      if (cavity ? V[s] > 0 : V[s] < 0) { flipShell[s] = 1; any = true; }
    }
  }
  if (!any) return { shell, flip: null };
  const flip = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) if (shell[t] >= 0 && flipShell[shell[t]]) flip[t] = 1;
  return { shell, flip };
}
