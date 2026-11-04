// The edge list and the body facts, from a decoded model's global arrays, in
// one pass per body. Pure, no DOM: run by the converter (js/cadmesh.js, so a
// new .cadmesh carries them) and by a worker for a .cadmesh without today's
// (an older one, or one whose build failed when it was written). Its closed
// test (shellsOf) is also the mesh readers': js/mesh-formats.js weld calls
// shellTurns, here, to turn a shell wound the wrong way, and Clearance asks
// bodyShells for a part's shells (js/clearance.js).
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
// Body facts: area, and the material's volume (materialVolume: by the nesting of
// the body's shells, float64), with net and unchecked where it may be off. Closed
// comes from the header's kind (the converter takes it from the b-rep); only a
// body without kind falls back to the mesh: welded edges, a triangle whose
// welded corners collapse skipped (one of three distinct corners on a line
// counts: it closes a T-junction), open where an edge is used once (shellsOf).
//
// Returns { edges: Uint32Array (a, b) pairs, silhouettes: Uint32Array pairs |
// null, silhouetteNormals: Int16Array (nx ny nz 0) x 2 per candidate | null,
// silhouettesOmitted: count left out over the cap (0), facts: an array per
// body of each fact of BODY_FACTS (below) }.

import { nesting } from './solid.js';
import { itemsIn } from './box-tree.js';
import { surfaceTree, treeDistance } from './tri-distance.js';

export const SILHOUETTE_CAP = 2_000_000;
// The rule the body facts are built by, written beside them (js/cadmesh.js factsRule): bumped when
// a fact changes meaning, so the viewer rebuilds the facts of a file or kept conversion made by
// an older one (2: the volume by the material's rule, and `net`; before it, the signed sum. 3:
// `unchecked` beside `net`, which no longer covers an overlap test past its budget. 4: no
// region's share of the volume below 0 -- a body read 771.75 under 3 that today reads 1000). The
// facts are versioned by this alone: a change of it needs no CACHE_VERSION bump (js/mesh-cache.js)
export const FACTS_RULE = 4;
// whether a header's facts can be shown as they are: present, and built by today's rule (main.js
// rebuilds them otherwise: an older file's volume was the signed sum, unflagged)
export const factsCurrent = (header) => !!header?.facts && header.factsRule === FACTS_RULE;

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

// A typed list that grows by doubling: the edges and silhouettes collect here, not in a plain array,
// which V8 cannot grow past about 112.8 M entries (a 9.9 M-triangle PLY's 14 M silhouette
// candidates, all to be left out by the cap, threw "Invalid array length" and the file was refused)
export function typedList(T, size = 1024) {
  const list = { a: new T(size), n: 0,
    room(k) { if (list.n + k > list.a.length) { const b = new T(Math.max(list.a.length * 2, list.n + k)); b.set(list.a.subarray(0, list.n)); list.a = b; } },
    done: () => list.a.slice(0, list.n) };
  return list;
}

// (list: the lists' maker -- typedList; a test passes one that records how far each grows)
export function buildEdges({ position, index, meshes }, { silhouetteCap = SILHOUETTE_CAP, overlapBudget = OVERLAP_BUDGET, list = typedList } = {}) {
  const bits = new Uint32Array(position.buffer, position.byteOffset, position.length);
  const edges = list(Uint32Array);
  // (the candidates collected only up to the cap -- past it they are all left out, so only counted)
  const sil = { pairs: list(Uint32Array), normals: list(Int16Array), cap: silhouetteCap };
  let silCount = 0;
  const facts = Object.fromEntries(BODY_FACTS.map((f) => [f.key, []]));
  for (const m of meshes) {
    const r = body(position, bits, index, m, edges, sil, overlapBudget);
    silCount += r.sil;
    for (const f of BODY_FACTS) facts[f.key].push(factValue(f, r[f.key]));
  }
  const omitted = overSilhouetteCap(silCount, silhouetteCap) ? silCount : 0;
  return {
    edges: edges.done(),
    silhouettes: omitted ? null : sil.pairs.done(),
    silhouetteNormals: omitted ? null : sil.normals.done(),
    silhouettesOmitted: omitted,
    facts,
  };
}

// The one rule for a build's failure that depends on the moment, tried again (js/edges-worker.js
// says it `transient`; main.js remembers a model's after MOMENT_TRIES): every failure but a
// size limit the model meets at every try -- a Map past its size, an array or string past its
// length, a recursion too deep -- named here in the words each engine was seen to use. (Naming the moment's instead
// -- V8's "allocation failed" -- left Safari's "Out of memory" the model's own, never tried again.)
// (V8, SpiderMonkey and JavaScriptCore words, as each was seen: "Invalid array buffer length" and
// Firefox's "allocation size overflow" too -- r42 A8, Q8)
const SIZE_LIMIT = /maximum (call stack )?size exceeded|invalid (typed )?array( buffer)? length|invalid string length|too much recursion|allocation size overflow/i;
export const momentaryFailure = (e) => !SIZE_LIMIT.test(String(e?.message ?? e));

// The silhouette cap's one rule: past it a model's (or a scene's) silhouettes are all left out and
// counted (buildEdges -- which collects them only up to it --, js/scene.js sceneEdgesFacts, main.js
// fileEdgesValue for a file's)
export const overSilhouetteCap = (count, cap) => count > cap;

// a per-body fact's value as written: a flag true or false, a number (0 where a body has none)
export const factValue = (f, v) => KINDS[f.kind].value(v);

// A fact's kind, the one table every reader and writer asks (buildEdges and the merge: value;
// js/cadmesh.js's decoder: test and named; its writer: rounded): a third kind is added here
export const KINDS = {
  flag: { test: (x) => typeof x === 'boolean', value: (v) => !!v, named: 'flag', rounded: false },
  number: { test: (x) => Number.isFinite(x) && x >= 0, value: (v) => (Number.isFinite(v) ? v : 0), named: 'number at least 0', rounded: true },
};

// The flags said beside a volume, each "n words" joined by sep: the info panel's (' · ') and
// stp2mesh's (', '), one text
export const flagsSaid = (facts, bodies, sep) => flagCounts(facts, bodies).map(({ fact, n }) => `${sep}${n.toLocaleString('en-US')} ${fact.said}`).join('');

// Each flag fact that has its words (`said`) counted over the given bodies that are closed -- the
// one count the info panel and stp2mesh say: [{ fact, n }] for the flags set on any of them
export function flagCounts(facts, bodies) {
  const out = [];
  for (const f of BODY_FACTS) {
    if (f.kind !== 'flag' || !f.said || !facts[f.key]) continue;
    let n = 0;
    for (const i of bodies) if (facts.closed[i] && facts[f.key][i]) n++;
    if (n) out.push({ fact: f, n });
  }
  return out;
}

// The per-body facts, one list for every place that builds, writes, reads, checks or merges them
// (js/cadmesh.js roundFacts and the decoder's checks, js/scene.js sceneEdgesFacts): a fact added here
// is carried by all (one named in seven places was dropped by a merge that then called the
// scene's facts current). always: written for every model; else written only when one body has it.
// net: the body's shells touch or cross -- or one is branched, or a part lies in two outer shells
// -- so its volume may not be its material's; unchecked: its overlaps not checked, past the budget
// (materialVolume).
export const BODY_FACTS = [
  { key: 'closed', kind: 'flag', always: true },
  { key: 'area', kind: 'number', always: true },
  { key: 'volume', kind: 'number', always: true },
  // (said: what the info panel and stp2mesh say of a body with the flag, the one wording)
  { key: 'net', kind: 'flag', said: 'with shells that touch or cross: the volume may be off there' },
  { key: 'unchecked', kind: 'flag', said: 'too large to check for overlapping shells' },
];

function body(pos, bits, index, m, edges, sil, budget) {
  const nt = m.idxCount / 3;
  const t0 = m.idxStart / 3;
  const v0 = m.vtxStart;
  const nv = m.vtxCount;
  if (!nt || !nv) return { sil: 0, closed: m.kind ? kindClosed(m.kind) : false, area: 0, volume: 0 };

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
        const P = sil.pairs;
        if (!overSilhouetteCap(P.n / 2 + 1, sil.cap)) {
          P.room(2); P.a[P.n++] = a; P.a[P.n++] = b;
          const N = sil.normals;
          N.room(8);
          N.a[N.n++] = Math.round(n1x * 32767); N.a[N.n++] = Math.round(n1y * 32767); N.a[N.n++] = Math.round(n1z * 32767); N.a[N.n++] = 0;
          N.a[N.n++] = Math.round(n2x * 32767); N.a[N.n++] = Math.round(n2y * 32767); N.a[N.n++] = Math.round(n2z * 32767); N.a[N.n++] = 0;
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
      edges.room(2); edges.a[edges.n++] = a; edges.a[edges.n++] = b;
    }
  }

  // (every body, a b-rep's too: one written as two overlapping solids in one body read its signed
  // sum; closed by the one rule the facts' closed flag takes -- the b-rep's word where it gives a
  // kind, the mesh's own test where not -- and a solid closed by its b-rep's word lets every shell
  // hold, as Clearance does: a b-rep cube with a one-ulp crack read 1008 for 1000)
  const sh = shellsOf(index, t0, nt, weld, v0, nv);
  const closed = m.kind ? kindClosed(m.kind) : sh.closed;
  const open = m.kind && closed ? new Uint8Array(sh.shellOpen.length) : sh.shellOpen;
  return { sil: nsil, closed, area: A, ...materialVolume(pos, index, t0, nt, sh.shell, open, sh.shellBranched, closed, V, budget) };
}

// a body closed by its b-rep's word (js/cadmesh.js BODY_KINDS): the one place the kind decides it
const kindClosed = (kind) => kind === 'closed' || kind === 'capped';

// The work the overlap test may do on one body (js/tri-distance.js treeDistance's steps: node
// pairs taken and triangle pairs looked at): past it the body's overlaps are not checked, and its
// facts say so (`unchecked`), not that its shells meet. (About 2 s of steps: 20 M ran 11 s on two
// cones of 4,000 slivers apex to apex; every bundled and private model takes under 1 % of it.)
export const OVERLAP_BUDGET = 4_000_000;

// A closed body's volume as its material is taken -- each region inside a shell and outside the
// shells it holds (never below 0) counted when its winding is above 0, the winding of the region round it plus
// the shell's sign, each shell's sign taken against its outer shell's (the weld's rule: an outer
// shell wound in is turned; a body wound inside out has its volume) -- from the nesting of its
// shells. So a cavity is taken out once and a part embedded in another counted once (the signed
// sum counted an embedded part twice). The nesting is exact where no two shells' surfaces meet
// (each then lies wholly inside or wholly outside the other); where two shells' surfaces touch or
// cross (their nearest distance 0, js/tri-distance.js -- not their boxes alone: a pin in the notch
// of an L-shaped cavity read as overlapping), a shell is branched (two parts face to face), or a
// part lies in two outer shells, the volume is the same count and `net` says it may not be the
// material's; past OVERLAP_BUDGET `unchecked` says the test was not finished.
// -> { volume, net, unchecked }
function materialVolume(pos, index, t0, nt, shell, shellOpen, shellBranched, closed, V, budget = OVERLAP_BUDGET) {
  const ns = shellOpen.length;
  const anyBranched = shellBranched.some((x) => x === 1);
  if (!closed || ns <= 1) return { volume: Math.abs(V), net: closed && anyBranched };
  const local = index.subarray(3 * t0, 3 * (t0 + nt));
  const nest = nesting(pos, local, shell, ns, shellOpen, shellBranched);
  const { parent, root, V: Vs, lo, hi } = nest;
  const { start, list, tree } = nest;
  let net = anyBranched, unchecked = false;
  // (a part in two outer shells)
  for (let s = 0; s < ns && !net; s++) if (nest.roots(s).length > 1) net = true;
  // Which shells' surfaces meet. Asked of each shell and its parent, and of two shells whose boxes
  // cross with neither in the other's line of holders: a shell that meets not its parent, inside
  // a parent that meets not its own, lies wholly inside that one too, so no other holder need be
  // asked (every holder asked against every shell it holds, each pair's trees built again, was
  // 10.8 s for a 200,000-triangle housing of 120 parts, then net by the budget). Each shell's
  // triangle tree built once; the budget counts the distance search's steps, and past it the
  // body is `unchecked`, not said to meet.
  if (!net) {
    // (the holders' lines by an Euler tour of the parents: one test whether a holds b)
    const kids = new Int32Array(ns).fill(-1), sib = new Int32Array(ns).fill(-1);
    for (let s = ns - 1; s >= 0; s--) if (parent[s] >= 0) { sib[s] = kids[parent[s]]; kids[parent[s]] = s; }
    const tin = new Int32Array(ns), tout = new Int32Array(ns);
    let clock = 0;
    for (let r = 0; r < ns; r++) {
      if (parent[r] >= 0) continue;
      const stack = [r];
      while (stack.length) {
        const x = stack[stack.length - 1];
        if (x >= 0) { tin[x] = clock++; stack[stack.length - 1] = ~x; for (let c = kids[x]; c >= 0; c = sib[c]) stack.push(c); } else { tout[~x] = clock++; stack.pop(); }
      }
    }
    const inLine = (a, b) => (tin[a] <= tin[b] && tout[b] <= tout[a]) || (tin[b] <= tin[a] && tout[a] <= tout[b]);
    const trees = new Map();
    const treeOf = (s) => { let t = trees.get(s); if (!t) { t = surfaceTree(pos, local, list.subarray(start[s], start[s + 1])); trees.set(s, t); } return t; };
    let work = 0;
    // (each call given what the body has left of the budget: one pair of two cones' slivers apex to
    // apex ran 22 s whatever the budget, checked only after the pair)
    const meet = (a, b) => {
      const r = treeDistance(pos, local, treeOf(a), treeOf(b), Math.max(0, budget - work));
      work += r ? r.work : 0;
      // (by the call's own word: one that found the shells meet within its steps is a meeting,
      // whatever the total; `work > budget` called such a body unchecked)
      if (r?.stopped) { unchecked = true; return false; }
      return !!r && r.distance === 0;
    };
    for (let s = 0; s < ns && !net && !unchecked; s++) if (parent[s] >= 0 && meet(s, parent[s])) net = true;
    for (let s = 0; s < ns && !net && !unchecked; s++) {
      itemsIn(tree, lo.subarray(3 * s, 3 * s + 3), hi.subarray(3 * s, 3 * s + 3), (o) => {
        if (net || unchecked || o <= s || inLine(s, o)) return;
        for (let k = 0; k < 3; k++) if (lo[3 * o + k] > hi[3 * s + k] || lo[3 * s + k] > hi[3 * o + k]) return;
        if (meet(s, o)) net = true;
      });
    }
  }
  // the winding inside each shell, parents first (placed by depth), facing taken as its outer shell's
  const w = new Int32Array(ns), done = new Uint8Array(ns), inner = new Float64Array(ns);
  const sign = (s) => (Vs[s] < 0 ? -1 : 1) * (Vs[root[s]] < 0 ? -1 : 1);
  const wOf = (s) => {
    const path = [];
    let x = s;
    while (x >= 0 && !done[x] && path.length <= ns) { path.push(x); x = parent[x]; }
    let base = x >= 0 ? w[x] : 0;
    for (let k = path.length - 1; k >= 0; k--) { const y = path[k]; base += sign(y); w[y] = base; done[y] = 1; }
    return w[s];
  };
  for (let s = 0; s < ns; s++) { wOf(s); if (parent[s] >= 0) inner[parent[s]] += Math.abs(Vs[s]); }
  let vol = 0;
  // (a region's share never below 0: two cavities crossing each other are both taken from their
  // holder, and the body read -228 mm3 -- a file its own decoder refused; such a body is net, or
  // unchecked past the budget)
  for (let s = 0; s < ns; s++) if (w[s] > 0) vol += Math.max(0, Math.abs(Vs[s]) - inner[s]);
  return { volume: vol, net, unchecked: !net && unchecked };
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
// Clearance asks it of a part, to ask a point of each of its shells (js/clearance.js).
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
  const nest = closedShells.length ? nesting(position, index, shell, ns, shellOpen, shellBranched) : null;
  const V = nest ? nest.V : null; // (each shell's signed volume: nesting's, the one count)
  // An outer shell (in no other) wound inward is turned (a mirrored placement, a writer that winds
  // the other way). A shell inside another is turned with its outer shell, never by its own sign:
  // a cavity is wound inward and a part embedded in another (a pin in a connector's body) outward,
  // and once in one body the two cannot be told apart -- by its own sign and its depth, a board's
  // STL read back turned five of its parts inside out. Kept as written: a branched outer shell
  // (two parts face to face: no one outside), one an open shell's box holds (no answer: a part's
  // cavity under an outer surface with a gap, and a cube in a lidless tray was turned upright and
  // not upside down), and a shell whose outer shells do not agree (a part in the overlap of one
  // wound in and one wound out: its answer turned on the order of the file).
  const outerTurn = (r) => !shellOpen[r] && !shellBranched[r] && V[r] < 0 && !nest.inOpen[r];
  for (const s of closedShells) {
    const rs = nest.roots(s), turn = outerTurn(rs[0]);
    if (rs.some((r) => outerTurn(r) !== turn)) continue;
    if (turn) { flipShell[s] = 1; any = true; }
  }
  if (!any) return { shell, flip: null };
  const flip = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) if (shell[t] >= 0 && flipShell[shell[t]]) flip[t] = 1;
  return { shell, flip };
}
