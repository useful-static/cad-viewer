// The edge list and the body facts, from a decoded model's global arrays, in
// one pass per body. Pure, no DOM: run by the converter (js/cadmesh.js, so a
// new .cadmesh carries them) and by a worker for an older .cadmesh.
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
// the mesh: welded edges, zero-area triangles skipped, open where an edge is
// used once.
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

  // weld: each vertex -> the first vertex of the body with the same bits
  const wsize = pow2(nv * 2);
  const wtab = new Int32Array(wsize).fill(-1);
  const weld = new Uint32Array(nv);
  // -0 and +0 are one position
  const bit = (o) => (bits[o] === 0x80000000 ? 0 : bits[o]);
  for (let v = 0; v < nv; v++) {
    const o = (v0 + v) * 3;
    const x = bit(o), y = bit(o + 1), z = bit(o + 2);
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (wsize - 1);
    for (;;) {
      const w = wtab[h];
      if (w < 0) { wtab[h] = v; weld[v] = v; break; }
      const p = (v0 + w) * 3;
      if (bit(p) === x && bit(p + 1) === y && bit(p + 2) === z) { weld[v] = w; break; }
      h = (h + 1) & (wsize - 1);
    }
  }

  // triangle normals, area, volume (float64, centred on the body)
  const bb = m.bbox;
  const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2, cz = (bb.min[2] + bb.max[2]) / 2;
  const diag2 = (bb.max[0] - bb.min[0]) ** 2 + (bb.max[1] - bb.min[1]) ** 2 + (bb.max[2] - bb.min[2]) ** 2;
  const tn = new Float32Array(nt * 3);
  const degenerate = new Uint8Array(nt);
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
    V += (ax * (by * qz - bz * qy) + ay * (bz * qx - bx * qz) + az * (bx * qy - by * qx)) / 6;
    if (len <= diag2 * 1e-14) { degenerate[t] = 1; continue; }
    tn[t * 3] = nx / len; tn[t * 3 + 1] = ny / len; tn[t * 3 + 2] = nz / len;
  }

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

  return { sil: nsil, closed: m.kind ? null : meshClosed(index, t0, nt, weld, v0, degenerate), area: A, volume: Math.abs(V) };
}

// closed by the mesh alone: every welded edge of the non-degenerate
// triangles used at least twice (more than twice is non-manifold, not open)
function meshClosed(index, t0, nt, weld, v0, degenerate) {
  const size = pow2(nt * 6); // at most half full, as in body()
  const kA = new Int32Array(size).fill(-1);
  const kB = new Int32Array(size);
  const cnt = new Uint8Array(size);
  for (let t = 0; t < nt; t++) {
    if (degenerate[t]) continue;
    const i = (t0 + t) * 3;
    for (let k = 0; k < 3; k++) {
      const a = weld[index[i + k] - v0], b = weld[index[i + (k + 1) % 3] - v0];
      if (a === b) continue;
      const p = Math.min(a, b), q = Math.max(a, b);
      let h = (Math.imul(p, 2654435761) ^ Math.imul(q, 40503)) & (size - 1);
      while (kA[h] >= 0 && !(kA[h] === p && kB[h] === q)) h = (h + 1) & (size - 1);
      kA[h] = p; kB[h] = q;
      if (cnt[h] < 255) cnt[h]++;
    }
  }
  for (let h = 0; h < size; h++) if (kA[h] >= 0 && cnt[h] === 1) return false;
  return true;
}
