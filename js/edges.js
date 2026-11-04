// The edge list and the body facts, from a decoded model's global arrays, in
// one pass per body. Pure, no DOM: run by the converter (js/cadmesh.js, so a
// new .cadmesh carries them) and by a worker for an older .cadmesh. Its closed
// test (shellsOf) is also the mesh readers': js/mesh-formats.js weld calls
// shellTurns, here, to turn a shell wound the wrong way, and Clearance asks
// bodyShells for a solid's shells (js/clearance.js).
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
// the mesh: welded edges, a triangle whose welded corners collapse skipped (one
// of three distinct corners on a line counts: it closes a T-junction), open
// where an edge is used once (shellsOf).
//
// Returns { edges: Uint32Array (a, b) pairs, silhouettes: Uint32Array pairs |
// null, silhouetteNormals: Int16Array (nx ny nz 0) x 2 per candidate | null,
// silhouettesOmitted: count left out over the cap (0), facts: { closed,
// area, volume } arrays per body }.

import { nesting } from './solid.js';

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

  return { sil: nsil, closed: m.kind ? null : shellsOf(index, t0, nt, weld, v0, nv).closed, area: A, volume: Math.abs(V) };
}

// a 32-bit finishing mix (MurmurHash3's)
const mix32 = (v) => { v ^= v >>> 16; v = Math.imul(v, 0x85ebca6b); v ^= v >>> 13; v = Math.imul(v, 0xc2b2ae35); return v ^ (v >>> 16); };

// weld: each vertex of a body (v0, nv; bits: the positions' float32 bits) -> the first vertex of
// the body with the same bits (-0 and +0 are one position)
export function weldBits(bits, v0, nv) {
  const wsize = pow2(nv * 2);
  const wtab = new Int32Array(wsize).fill(-1);
  const weld = new Uint32Array(nv);
  const bit = (o) => (bits[o] === 0x80000000 ? 0 : bits[o]);
  for (let v = 0; v < nv; v++) {
    const o = (v0 + v) * 3;
    const x = bit(o), y = bit(o + 1), z = bit(o + 2);
    // (each coordinate mixed into the low bits in turn: a float on a whole number has its low
    // mantissa bits all 0, and products of the three clustered a grid of such points into long
    // probe runs -- 20,000 unit cubes on whole-number corners took 7.5 s to weld; one mix of the
    // products, 31.8 M extra probes for a million grid points against 0.46 M)
    let h = mix32(x);
    h = mix32(h ^ Math.imul(y, 0x9e3779b1));
    h = mix32(h ^ Math.imul(z, 0x7feb352d)) & (wsize - 1);
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
// diagonal: such a triangle has no normal and no silhouette; the closed test counts it unless its
// corners collapse, shellsOf), its signed-volume term (vol); and the body's area and signed
// volume (float64, centred on the body's box bb)
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
// wound the wrong way): on the welded vertices, every edge used at least twice (more than twice
// is non-manifold, not open). A triangle whose welded corners are not three is no part of it; one
// of three distinct corners on a line is (a polygon fan-triangulated through a collinear corner
// closes a T-junction with one: skipped, a closed cube read open). Per shell too: the shells are
// the triangles joined across shared edges -- not across a shared vertex, which made two parts
// touching at a corner one shell, turned by their summed volume. A shell with an edge used more
// than twice (two parts face to face) is branched: its outside is no one answer. Returns {
// closed, shell: Int32Array, a triangle's shell (-1: its corners collapsed), shellOpen and
// shellBranched: Uint8Array per shell }. Typed tables throughout: a Map of edges at the 10 M-
// triangle cap was 8.7 s and 683 MB.
function shellsOf(index, t0, nt, weld, v0, nv) {
  const parent = new Int32Array(nt);
  for (let t = 0; t < nt; t++) parent[t] = t;
  const find = (t) => { while (parent[t] !== t) { parent[t] = parent[parent[t]]; t = parent[t]; } return t; };
  const collapsed = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    const i = (t0 + t) * 3, a = weld[index[i] - v0], b = weld[index[i + 1] - v0], c = weld[index[i + 2] - v0];
    if (a === b || b === c || a === c) collapsed[t] = 1;
  }
  // the edges as lists per lower welded vertex (counted, then filled): each entry the other end
  // and the triangle, one number (other * nt + triangle: under 2^53 at every cap), each list
  // sorted in place and read by runs -- a run one long is an edge used once (open), two or more
  // the edge joining its triangles' shells
  const off = new Uint32Array(nv + 1);
  const each = (fn) => {
    for (let t = 0; t < nt; t++) {
      if (collapsed[t]) continue;
      const i = (t0 + t) * 3;
      for (let k = 0; k < 3; k++) {
        const a = weld[index[i + k] - v0], b = weld[index[i + (k + 1) % 3] - v0];
        fn(a < b ? a : b, a < b ? b : a, t);
      }
    }
  };
  each((p) => { off[p + 1]++; });
  for (let v = 0; v < nv; v++) off[v + 1] += off[v];
  const fill = off.slice(0, nv);
  const nb = new Float64Array(off[nv]);
  each((p, q, t) => { nb[fill[p]++] = q * nt + t; });
  const openTri = new Uint8Array(nt), branchTri = new Uint8Array(nt);
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
      else {
        const first = nb[j] - q * nt;
        for (let z = j + 1; z < e; z++) { const a = find(first), b = find(nb[z] - q * nt); if (a !== b) parent[b] = a; }
        if (e - j > 2) branchTri[first] = 1;
      }
      j = e;
    }
  }
  const sid = new Int32Array(nt).fill(-1), shell = new Int32Array(nt).fill(-1);
  let ns = 0;
  for (let t = 0; t < nt; t++) {
    if (collapsed[t]) continue;
    const r = find(t);
    if (sid[r] < 0) sid[r] = ns++;
    shell[t] = sid[r];
  }
  const shellOpen = new Uint8Array(ns), shellBranched = new Uint8Array(ns);
  for (let t = 0; t < nt; t++) {
    if (openTri[t]) shellOpen[shell[t]] = 1;
    if (branchTri[t]) shellBranched[shell[t]] = 1;
  }
  return { closed, shell, shellOpen, shellBranched };
}

// One body's shells (position: float32 xyz; index: corner ids into it, its own), welded on the
// position bits as the facts are: shellsOf's { closed, shell, shellOpen, shellBranched }.
// Clearance asks it of a solid and of a part (js/clearance.js).
export function bodyShells(position, index) {
  const nt = index.length / 3, nv = position.length / 3;
  const bits = new Uint32Array(position.buffer, position.byteOffset, position.length);
  return shellsOf(index, 0, nt, weldBits(bits, 0, nv), 0, nv);
}

// The shells of one body (position: float32 xyz; index: corner ids into it, its own), by the
// facts' own test (shellsOf) on the float32 positions the body is stored with, and the triangles
// of each closed, unbranched shell wound the wrong way: an outer shell (WHOLLY inside none of the
// body's other closed shells) whose signed volume is negative, and every shell wholly inside it
// with it (below). Wholly inside, by js/solid.js nesting (its box within the other's, and most
// of three points on it inside the other). (A shell counted as nested whenever a ray from it
// crossed another an odd number of times turned one of two cubes passing through each other, and
// a box resting on a plate.) Returns { shell, flip: a Uint8Array per triangle, or null when none
// is turned }.
export function shellTurns(position, index) {
  const nt = index.length / 3;
  if (!nt) return { shell: new Int32Array(0), flip: null };
  const { shell, shellOpen, shellBranched } = bodyShells(position, index);
  const ns = shellOpen.length;
  const closedShells = [];
  for (let s = 0; s < ns; s++) if (!shellOpen[s]) closedShells.push(s);
  const flipShell = new Uint8Array(ns);
  let any = false;
  // (each closed shell's outer shell, by its nearest holder, js/solid.js nesting; nothing to ask
  // when the body is one shell)
  const nest = closedShells.length ? nesting(position, index, shell, ns, shellOpen) : null;
  const V = nest ? nest.V : null; // (each shell's signed volume: nesting's, the one count)
  // An outer shell (in no other) wound inward is turned (a mirrored placement, a writer that winds
  // the other way). A shell inside another is turned with its outer shell, never by its own sign:
  // a cavity is wound inward and a part embedded in another (a pin in a connector's body) outward,
  // and once in one body the two cannot be told apart -- by its own sign and its depth, a board's
  // STL read back turned five of its parts inside out. Kept as written: a branched outer shell
  // (two parts face to face: no one outside), one an open shell's box holds (no answer: a part's
  // cavity under an outer surface with a gap, and a cube in a lidless tray was turned upright and
  // not upside down), and a shell whose outer shells do not agree (a part in the overlap of one
  // wound in and one wound out: its answer turned on the order of the file), and one whose place
  // was not found (more candidate holders than nesting asks).
  const outerTurn = (r) => !shellOpen[r] && !shellBranched[r] && V[r] < 0 && !nest.inOpen[r];
  for (const s of closedShells) {
    if (nest.unsure(s)) continue;
    const rs = nest.roots(s), turn = outerTurn(rs[0]);
    if (rs.some((r) => outerTurn(r) !== turn)) continue;
    if (turn) { flipShell[s] = 1; any = true; }
  }
  if (!any) return { shell, flip: null };
  const flip = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) if (shell[t] >= 0 && flipShell[shell[t]]) flip[t] = 1;
  return { shell, flip };
}
