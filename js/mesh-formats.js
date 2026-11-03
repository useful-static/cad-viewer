// Mesh files opened as models (plan feature 14; feature review item 23):
// STL (binary or ASCII), OBJ (with its MTL), PLY (ASCII or binary, vertex
// colours), OFF, 3MF (a zip: its model XML, units, components and base
// materials) and glTF / GLB (core: node transforms baked in, baseColorFactor,
// metres to mm). Each parser returns the model js/cadmesh.js encodeCadmesh
// takes, so the tree, colours, cache, Save .cadmesh, the facts, edges and
// Measure all work as for a converted STEP file.
//
// Every body is welded (equal positions become one vertex) and given normals
// smoothed only across edges under CREASE_DEG, so a cube keeps its sharp
// edges and a cylinder its round side.
//
// Pure ES module, no DOM (a worker may run it); 3MF needs
// DecompressionStream for its deflated entries.

import { DEFAULT_GREY, MAX_FILE_BYTES, MM, inflate } from './cadmesh.js';
import { FORMATS, extOf, sniffFormat } from './formats.js';
import { LENGTH_MM } from './units.js';

// the mesh extensions, from the viewer's one format table (js/formats.js)
export const MESH_EXTS = FORMATS.filter((f) => f.kind === 'mesh').flatMap((f) => f.ext);
const CREASE_DEG = 30;
// A 3MF or glTF names a part once and places it many times; the placements are counted
// before any is built (a part shared two ways down 40 levels is 2^40 placements from a few
// hundred bytes). Real assemblies of several million placed triangles stay under these.
// Vertices are counted as well as triangles: each placement copies its part's vertices, so one
// triangle indexing a 30 M-vertex list, placed 4 times, was 29.6 s and 2.9 GB from 451 bytes
// (the vertex cap is an unindexed mesh at the triangle cap: 3 corners each).
const MAX_PLACED_TRIANGLES = 10_000_000;
const MAX_PLACED_VERTICES = 3 * MAX_PLACED_TRIANGLES;
const MAX_PLACED_PARTS = 2_000_000;
// a glTF accessor's values, refused past this before it is allocated (3 coordinates of
// 3 corners of the triangle cap; a 200-byte file asked for 2^30 vertices)
const MAX_ACCESSOR_VALUES = 9 * MAX_PLACED_TRIANGLES;
const big = (n) => n.toLocaleString('en-US');
// the placement counts of a part tree, from its counts per part (memoised: a shared part is
// walked once). kids(id) -> child ids, own(id) -> { tris, verts } of its own, refuse(why) ->
// an Error; a cycle, a missing part or a tree deeper than maxDepth is refused in words.
function placements(roots, kids, own, maxDepth, refuse, who) {
  const memo = new Map(); // id -> { parts, tris, verts, height }
  const onPath = new Set();
  const count = (id, depth, from) => {
    const seen = memo.get(id);
    if (seen) { if (depth + seen.height > maxDepth) throw refuse('deep'); return seen; }
    if (onPath.has(id)) throw refuse('cycle', id);
    if (depth > maxDepth) throw refuse('deep');
    const ks = kids(id, from);
    onPath.add(id);
    const o = own(id);
    const r = { parts: 1, tris: o.tris, verts: o.verts, height: 0 };
    for (const k of ks) {
      const c = count(k, depth + 1, id);
      r.parts += c.parts; r.tris += c.tris; r.verts += c.verts; r.height = Math.max(r.height, c.height + 1);
    }
    onPath.delete(id);
    memo.set(id, r);
    return r;
  };
  let parts = 0, tris = 0, verts = 0;
  for (const id of roots) { const c = count(id, 0, null); parts += c.parts; tris += c.tris; verts += c.verts; }
  const over = (n, what, cap) => new Error(`${who} places ${big(n)} ${what} once its shared parts are repeated, more than the ${big(cap)} this viewer opens`);
  if (parts > MAX_PLACED_PARTS) throw over(parts, 'parts', MAX_PLACED_PARTS);
  if (tris > MAX_PLACED_TRIANGLES) throw over(tris, 'triangles', MAX_PLACED_TRIANGLES);
  if (verts > MAX_PLACED_VERTICES) throw over(verts, 'vertices', MAX_PLACED_VERTICES);
}

// The mesh format a file is (the reader parseMesh runs), or null: by js/formats.js's sniff
// where the first bytes are conclusive (a PLY header, a GLB's "glTF": these win over the name,
// as check.html judges them), else by the name
export function meshFormatOf(name, buf) {
  const u8 = new Uint8Array(buf, 0, Math.min(buf.byteLength, 400));
  if (u8.length >= 4 && u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46) return 'glb';
  const s = sniffFormat(u8);
  if (s && s.magic && s.kind === 'mesh') return s.ext[0];
  const ext = extOf(name);
  return MESH_EXTS.includes(ext) ? ext : null;
}

// A model from a mesh file. files: other dropped files by lower-case name
// (an OBJ's .mtl, a .gltf's .bin). Throws in plain words on what it refuses.
export async function parseMesh(format, buf, name, files = new Map()) {
  const base = (name || 'model').replace(/\.[^.]+$/, '');
  switch (format) {
    case 'stl': return finish(base, parseSTL(buf, base), null);
    case 'obj': return finish(base, parseOBJ(text(buf, name), files, base), null);
    case 'ply': return finish(base, parsePLY(buf, base), null);
    case 'off': return finish(base, parseOFF(text(buf, name), base), null);
    case '3mf': return parse3MF(buf, base);
    case 'glb': case 'gltf': return parseGLTF(buf, format, base, files);
    default: throw new Error(`${name}: not a mesh format this viewer reads`);
  }
}

// A text file or zip part becomes one string, and an engine string holds at most ~512 M
// characters: a larger one is refused in words before it is decoded (a 3MF part inflating to
// 600 MB met the engine's "Cannot create a string longer than 0x1fffffe8 characters")
const MAX_TEXT_BYTES = 500 * 2 ** 20;
const mb = (n) => `${big(Math.round(n / 2 ** 20))} MB`;
const TEXT_LIMIT_WORDS = `more than the ${mb(MAX_TEXT_BYTES)} of text this viewer reads`;
const text = (buf, what = 'the file') => {
  if (buf.byteLength > MAX_TEXT_BYTES) throw new Error(`${what} is ${mb(buf.byteLength)} of text, ${TEXT_LIMIT_WORDS}`);
  return new TextDecoder().decode(buf);
};

// raw bodies [{ name, pos: number[], tri: number[], col?: [r,g,b] per
// triangle or null, color }] -> the encodeCadmesh model, one tree node
// a face pointing past the vertices, or a coordinate that is not a number, is a damaged file:
// said so here, not met later as NaN geometry ("facts are not one closed / area / volume")
function checkBodies(rootName, bodies) {
  for (const b of bodies) {
    const n = b.pos.length / 3;
    for (const x of b.pos) if (!Number.isFinite(x)) throw new Error(`${rootName} is damaged: a vertex coordinate is not a number`);
    for (const t of b.tri) if (!Number.isInteger(t) || t < 0 || t >= n) throw new Error(`${rootName} is damaged: a face refers to vertex ${t + 1} of ${n}`);
  }
}

// welded bodies with no triangle left (none, or every one collapsed by the weld): refused in
// the same words by every reader (3MF and glTF opened a model of empty meshes)
function needTriangles(rootName, welded) {
  if (!welded.some((m) => m.indices.length)) {
    throw new Error(`${rootName} has no triangles to show${welded.length ? ' (every triangle has no area)' : ''}`);
  }
}

function finish(rootName, bodies, sourceUnits, root = null) {
  checkBodies(rootName, bodies);
  const welded = bodies.filter((b) => b.tri.length).map(weld);
  needTriangles(rootName, welded);
  // (a tree given by the file names its meshes by number: they are kept as they are)
  const meshes = root ? welded : welded.filter((m) => m.indices.length);
  const model = { units: MM, meshes, root: root || { name: rootName, meshes: meshes.map((_, i) => i), children: [] } };
  if (sourceUnits) model.sourceUnits = sourceUnits;
  return model;
}

// Weld equal positions, then split each welded vertex by crease (and by
// triangle colour), normals area-weighted within each group
export function weld(b) {
  const P = b.pos, T = b.tri;
  const map = new Map();
  const wid = new Uint32Array(P.length / 3);
  const wp = [];
  for (let v = 0; v < P.length / 3; v++) {
    const k = `${P[v * 3]},${P[v * 3 + 1]},${P[v * 3 + 2]}`;
    let w = map.get(k);
    if (w === undefined) { w = wp.length / 3; map.set(k, w); wp.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
    wid[v] = w;
  }
  const nt = T.length / 3;
  const fn = new Float64Array(nt * 3); // area-weighted (unnormalised) face normals
  const tri = new Uint32Array(T.length);
  const colKept = []; // the kept triangles' colours (b.col: one per triangle)
  let kept = 0;
  for (let t = 0; t < nt; t++) {
    const a = wid[T[t * 3]], b2 = wid[T[t * 3 + 1]], c = wid[T[t * 3 + 2]];
    if (a === b2 || b2 === c || a === c) continue; // collapsed by the weld
    const ux = wp[b2 * 3] - wp[a * 3], uy = wp[b2 * 3 + 1] - wp[a * 3 + 1], uz = wp[b2 * 3 + 2] - wp[a * 3 + 2];
    const vx = wp[c * 3] - wp[a * 3], vy = wp[c * 3 + 1] - wp[a * 3 + 1], vz = wp[c * 3 + 2] - wp[a * 3 + 2];
    fn[kept * 3] = uy * vz - uz * vy; fn[kept * 3 + 1] = uz * vx - ux * vz; fn[kept * 3 + 2] = ux * vy - uy * vx;
    tri[kept * 3] = a; tri[kept * 3 + 1] = b2; tri[kept * 3 + 2] = c;
    if (b.col) colKept.push(b.col[t]);
    kept++;
  }
  const cosC = Math.cos((CREASE_DEG * Math.PI) / 180);
  const unit = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
  // per welded vertex: its groups [{ n: unit seed, out }], with colours kept apart by a Map
  // colour -> groups (a linear search over every colour at a vertex was quadratic: a fan of
  // 60 k triangles, each its own colour, about one centre took 13.5 s)
  const groups = new Array(wp.length / 3);
  const corner = new Uint32Array(kept * 3); // the group (output vertex) each corner uses
  const outPos = [], outNrmSum = [], outCol = [];
  const cols = b.col ? colKept : null;
  for (let t = 0; t < kept; t++) {
    const n = unit(fn[t * 3], fn[t * 3 + 1], fn[t * 3 + 2]);
    const ck = cols ? cols[t].join(',') : '';
    for (let c = 0; c < 3; c++) {
      const w = tri[t * 3 + c];
      let gs;
      if (cols) {
        const byCol = groups[w] || (groups[w] = new Map());
        gs = byCol.get(ck);
        if (!gs) { gs = []; byCol.set(ck, gs); }
      } else gs = groups[w] || (groups[w] = []);
      let g = gs.find((x) => x.n[0] * n[0] + x.n[1] * n[1] + x.n[2] * n[2] >= cosC);
      if (!g) {
        g = { n, out: outPos.length / 3 };
        gs.push(g);
        outPos.push(wp[w * 3], wp[w * 3 + 1], wp[w * 3 + 2]);
        outNrmSum.push(0, 0, 0);
        if (cols) outCol.push(Math.round(cols[t][0] * 255), Math.round(cols[t][1] * 255), Math.round(cols[t][2] * 255), 255);
      }
      outNrmSum[g.out * 3] += fn[t * 3]; outNrmSum[g.out * 3 + 1] += fn[t * 3 + 1]; outNrmSum[g.out * 3 + 2] += fn[t * 3 + 2];
      corner[t * 3 + c] = g.out;
    }
  }
  const nv = outPos.length / 3;
  const normals = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const [x, y, z] = unit(outNrmSum[v * 3], outNrmSum[v * 3 + 1], outNrmSum[v * 3 + 2]);
    normals[v * 3] = x; normals[v * 3 + 1] = y; normals[v * 3 + 2] = z;
  }
  return { name: b.name, color: b.color || null, positions: new Float32Array(outPos), normals,
    colors: cols ? new Uint8Array(outCol) : null, indices: corner };
}

// ---------- STL ----------
function parseSTL(buf, base) {
  const dv = new DataView(buf);
  // binary when the size is exactly 84 + 50 n, even if it starts "solid"
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + 50 * n === buf.byteLength) {
      const pos = new Array(n * 9), tri = new Array(n * 3);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + k * 4, true);
        tri[i * 3] = i * 3; tri[i * 3 + 1] = i * 3 + 1; tri[i * 3 + 2] = i * 3 + 2;
      }
      return [{ name: base, pos, tri }];
    }
  }
  const s = text(buf, `${base}.stl`);
  if (!/^\s*solid/.test(s)) throw new Error(`${base}.stl is neither a binary STL (its size does not match its triangle count) nor an ASCII one`);
  const bodies = [];
  let cur = null;
  const re = /^\s*(solid|endsolid|vertex|endfacet)\b(.*)$/gm;
  let m;
  let fv = [];
  // (a body is started by whichever record comes first: "solidx" passes the ASCII test but is
  // not a solid record, and an endfacet with no body met null)
  const body = () => { if (!cur) { cur = { name: base, pos: [], tri: [] }; bodies.push(cur); } return cur; };
  while ((m = re.exec(s))) {
    if (m[1] === 'solid') { cur = { name: m[2].trim() || base, pos: [], tri: [] }; bodies.push(cur); }
    else if (m[1] === 'vertex') {
      // three numbers, or the file is damaged (a short line shifted every later coordinate)
      body();
      const xyz = m[2].trim().split(/\s+/).slice(0, 3).map(Number);
      if (xyz.length < 3 || !xyz.every(Number.isFinite)) throw new Error(`${base}.stl is damaged: "${m[0].trim().slice(0, 80)}" is not three numbers`);
      fv.push(xyz[0], xyz[1], xyz[2]);
    }
    else if (m[1] === 'endfacet') {
      // a facet of more than 3 vertices: a fan (appended by a loop: spread into push, a
      // 300 k-vertex facet overflowed the stack)
      body();
      const k0 = cur.pos.length / 3;
      for (const x of fv) cur.pos.push(x);
      for (let i = 1; i + 1 < fv.length / 3; i++) cur.tri.push(k0, k0 + i, k0 + i + 1);
      fv = [];
    }
  }
  return bodies;
}

// ---------- OBJ ----------
function parseOBJ(s, files, base) {
  const v = [];
  const bodies = [];
  let cur = null;
  let mat = null;
  const mtl = new Map(); // name -> [r, g, b]
  const start = (nm) => { cur = { name: nm, pos: [], tri: [], col: [], map: new Map() }; bodies.push(cur); };
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.split(/\s+/);
    const k = sp[0];
    if (k === 'v') v.push(+sp[1], +sp[2], +sp[3]);
    else if (k === 'o' || k === 'g') start(sp.slice(1).join(' ') || base);
    else if (k === 'mtllib') {
      for (const f of sp.slice(1)) {
        const t = files.get(f.toLowerCase());
        if (t) readMTL(text(t, f), mtl);
      }
    } else if (k === 'usemtl') mat = sp.slice(1).join(' ');
    else if (k === 'f') {
      if (!cur) start(base);
      const ids = sp.slice(1).map((x) => {
        const i = parseInt(x, 10);
        const k = i < 0 ? v.length / 3 + i : i - 1;
        // (1-based, negative from the end: 0 or one past the vertices is a damaged file)
        if (!Number.isInteger(k) || k < 0 || k >= v.length / 3) throw new Error(`${base}.obj is damaged: "${line}" refers to vertex ${x} of ${v.length / 3}`);
        return k;
      });
      const loc = ids.map((i) => {
        let j = cur.map.get(i);
        if (j === undefined) { j = cur.pos.length / 3; cur.map.set(i, j); cur.pos.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]); }
        return j;
      });
      const c = (mat && mtl.get(mat)) || null;
      for (let i = 1; i + 1 < loc.length; i++) { cur.tri.push(loc[0], loc[i], loc[i + 1]); cur.col.push(c); }
    }
  }
  for (const b of bodies) {
    // one colour for the body when its faces agree, else per triangle
    const cs = new Set(b.col.map((c) => (c ? c.join(',') : '')));
    if (cs.size === 1) { b.color = b.col[0]; b.col = null; }
    else b.col = b.col.map((c) => c || DEFAULT_GREY);
    delete b.map;
  }
  return bodies;
}
function readMTL(s, out) {
  let cur = null;
  for (const raw of s.split(/\r?\n/)) {
    const sp = raw.trim().split(/\s+/);
    if (sp[0] === 'newmtl') cur = sp.slice(1).join(' ');
    else if (sp[0] === 'Kd' && cur) out.set(cur, [+sp[1], +sp[2], +sp[3]]);
  }
}

// ---------- PLY ----------
const PLY_T = { char: 'Int8', int8: 'Int8', uchar: 'Uint8', uint8: 'Uint8', short: 'Int16', int16: 'Int16', ushort: 'Uint16', uint16: 'Uint16',
  int: 'Int32', int32: 'Int32', uint: 'Uint32', uint32: 'Uint32', float: 'Float32', float32: 'Float32', double: 'Float64', float64: 'Float64' };
const PLY_SIZE = { Int8: 1, Uint8: 1, Int16: 2, Uint16: 2, Int32: 4, Uint32: 4, Float32: 4, Float64: 8 };
function parsePLY(buf, base) {
  const u8 = new Uint8Array(buf);
  const hdrEnd = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(u8.length, 65536))).indexOf('end_header');
  if (hdrEnd < 0) throw new Error(`${base}.ply: no end_header`);
  let bodyStart = hdrEnd + 'end_header'.length;
  while (u8[bodyStart] === 13) bodyStart++;
  if (u8[bodyStart] === 10) bodyStart++;
  const hdr = new TextDecoder('latin1').decode(u8.subarray(0, hdrEnd)).split(/\r?\n/);
  let fmt = 'ascii';
  const els = [];
  for (const l of hdr) {
    const sp = l.trim().split(/\s+/);
    if (sp[0] === 'format') fmt = sp[1];
    else if (sp[0] === 'element') els.push({ name: sp[1], n: +sp[2], props: [] });
    else if (sp[0] === 'property' && els.length) {
      const e = els[els.length - 1];
      // a type PLY does not have is refused here, not met as the engine's "dv[t] is not a function"
      const ty = (t, nm) => {
        if (!Object.hasOwn(PLY_T, t)) throw new Error(`${base}.ply is damaged: property ${nm} has type ${t}, which is not a PLY type`);
        return PLY_T[t];
      };
      if (sp[1] === 'list') e.props.push({ list: true, ct: ty(sp[2], sp[4]), t: ty(sp[3], sp[4]), name: sp[4] });
      else e.props.push({ t: ty(sp[1], sp[2]), name: sp[2] });
    }
  }
  const pos = [], tri = [], vcol = [];
  let hasCol = false;
  const take = (e, rec) => {
    if (e.name === 'vertex') {
      pos.push(rec.x, rec.y, rec.z);
      if (rec.red !== undefined) { hasCol = true; vcol.push([rec.red, rec.green, rec.blue]); } else vcol.push(null);
    } else if (e.name === 'face') {
      const ids = rec.vertex_indices || rec.vertex_index || [];
      for (let i = 1; i + 1 < ids.length; i++) tri.push(ids[0], ids[i], ids[i + 1]);
    }
  };
  // the counts the data cannot hold are a damaged header, refused before looping on them (1e999
  // vertices looped until the tab ran out of memory). Summed over the elements, each record
  // charged its least size and at least 1: checked one by one, 2000 empty elements each
  // counting the file's size looped 11.8 s.
  const checkCounts = (room, least) => {
    let sum = 0;
    for (const e of els) {
      sum += Number.isInteger(e.n) && e.n >= 0 ? e.n * Math.max(1, least(e)) : Infinity;
      if (sum > room) throw new Error(`${base}.ply is damaged: element ${e.name} counts ${e.n}, more than the file holds`);
    }
  };
  // a list's count: a whole number the rest of the data can hold
  const listCount = (c, pr, e, room) => {
    if (!Number.isInteger(c) || c < 0 || c > room) throw new Error(`${base}.ply is damaged: a ${pr.name} list in element ${e.name} counts ${c} items${c > room ? ', more than the file holds' : ''}`);
    return c;
  };
  if (fmt === 'ascii') {
    const toks = new TextDecoder('latin1').decode(u8.subarray(bodyStart)).trim().split(/\s+/);
    checkCounts(toks.length, (e) => e.props.length);
    let p = 0;
    for (const e of els) {
      for (let i = 0; i < e.n; i++) {
        const rec = {};
        for (const pr of e.props) {
          if (pr.list) { const c = listCount(+toks[p++], pr, e, toks.length - p); rec[pr.name] = toks.slice(p, p + c).map(Number); p += c; } else rec[pr.name] = +toks[p++];
        }
        take(e, rec);
      }
    }
  } else {
    const le = fmt === 'binary_little_endian';
    if (!le && fmt !== 'binary_big_endian') throw new Error(`${base}.ply: format ${fmt} is not ascii or binary`);
    const dv = new DataView(buf);
    let o = bodyStart;
    checkCounts(buf.byteLength - bodyStart, (e) => e.props.reduce((s, pr) => s + PLY_SIZE[pr.list ? pr.ct : pr.t], 0));
    const rd = (t) => {
      if (o + PLY_SIZE[t] > buf.byteLength) throw new Error(`${base}.ply is damaged: its data ends early`);
      const v = dv[`get${t}`](o, le); o += PLY_SIZE[t]; return v;
    };
    for (const e of els) {
      for (let i = 0; i < e.n; i++) {
        const rec = {};
        for (const pr of e.props) {
          if (pr.list) { const c = listCount(rd(pr.ct), pr, e, (buf.byteLength - o) / PLY_SIZE[pr.t]); const a = new Array(c); for (let j = 0; j < c; j++) a[j] = rd(pr.t); rec[pr.name] = a; } else rec[pr.name] = rd(pr.t);
        }
        take(e, rec);
      }
    }
  }
  const body = { name: base, pos, tri };
  if (hasCol) {
    // vertex colours (0-255) become each triangle's mean, so the weld keeps them
    // (the largest by a loop: spread into Math.max, a 200 k-vertex file overflowed the stack)
    let top = 0;
    for (const c of vcol) if (c) for (const x of c) if (x > top) top = x;
    const scale = top > 1 ? 255 : 1;
    body.col = [];
    for (let t = 0; t < tri.length / 3; t++) {
      const cs = [0, 1, 2].map((c) => vcol[tri[t * 3 + c]] || [scale * 0.72, scale * 0.74, scale * 0.78]);
      body.col.push([0, 1, 2].map((k) => (cs[0][k] + cs[1][k] + cs[2][k]) / 3 / scale));
    }
  }
  return [body];
}

// ---------- OFF ----------
function parseOFF(s, base) {
  const toks = s.replace(/#[^\n]*/g, '').trim().split(/\s+/);
  let p = 0;
  if (/^[CN]?OFF$/.test(toks[0])) p++;
  const nv = +toks[p++], nf = +toks[p++];
  p++; // edges
  // counts checked before they are looped on: 1e999 vertices looped until the tab ran out of
  // memory; each vertex takes 3 tokens and each face at least 4
  if (!Number.isInteger(nv) || !Number.isInteger(nf) || nv < 0 || nf < 0) throw new Error(`${base}.off: not an OFF file (no vertex and face counts)`);
  if (nv * 3 + nf * 4 > toks.length - p) throw new Error(`${base}.off is damaged: it counts ${nv} vertices and ${nf} faces, more than the file holds`);
  const pos = [];
  for (let i = 0; i < nv; i++) { pos.push(+toks[p], +toks[p + 1], +toks[p + 2]); p += 3; }
  const tri = [];
  for (let i = 0; i < nf; i++) {
    const c = +toks[p++];
    if (!Number.isInteger(c) || c < 0 || c > toks.length - p) throw new Error(`${base}.off is damaged: face ${i + 1} counts ${toks[p - 1]} vertices`);
    const ids = toks.slice(p, p + c).map(Number);
    p += c;
    // an optional colour to the end of the line is not separable from the next
    // face once split on whitespace: OFF colours are left out
    for (let k = 1; k + 1 < ids.length; k++) tri.push(ids[0], ids[k], ids[k + 1]);
  }
  return [{ name: base, pos, tri, col: null }];
}

// ---------- 3MF ----------
// A zip's entries: { names (as stored), has(path), get(path) -> ArrayBuffer }
// (stored or deflated; paths matched without case or a leading /)
export async function unzip(buf) {
  const dv = new DataView(buf);
  const len = buf.byteLength;
  // every offset the archive gives is checked against its size: a broken zip is refused as
  // "damaged", not met as the engine's "Offset is outside the bounds of the DataView"
  const need = (at, n, what) => { if (!(at >= 0 && at + n <= len)) throw new Error(`a damaged zip (${what} lies outside the file)`); };
  // the end of central directory record, searched back from the end
  let e = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('not a zip file (no central directory)');
  const n = dv.getUint16(e + 10, true);
  let o = dv.getUint32(e + 16, true);
  if (o === 0xffffffff || n === 0xffff) throw new Error('a zip64 archive, which this viewer does not read');
  const out = new Map();
  for (let i = 0; i < n; i++) {
    need(o, 46, 'a directory entry');
    if (dv.getUint32(o, true) !== 0x02014b50) throw new Error('a damaged zip central directory');
    const method = dv.getUint16(o + 10, true);
    const csize = dv.getUint32(o + 20, true), usize = dv.getUint32(o + 24, true);
    const nlen = dv.getUint16(o + 28, true), xlen = dv.getUint16(o + 30, true), clen = dv.getUint16(o + 32, true);
    const lho = dv.getUint32(o + 42, true);
    need(o + 46, nlen, 'an entry name');
    const name = new TextDecoder().decode(new Uint8Array(buf, o + 46, nlen));
    o += 46 + nlen + xlen + clen;
    need(lho, 30, `${name}'s header`);
    const lnl = dv.getUint16(lho + 26, true), lxl = dv.getUint16(lho + 28, true);
    need(lho + 30 + lnl + lxl, csize, `${name}'s data`);
    const data = new Uint8Array(buf, lho + 30 + lnl + lxl, csize);
    out.set(name.replace(/^\//, '').toLowerCase(), { method, data, name, usize });
  }
  return {
    names: [...out.values()].map((f) => f.name),
    has: (p) => out.has(p.replace(/^\//, '').toLowerCase()),
    // (max, too: a smaller limit for this entry, and too(size words) -> the Error past it, met
    // before inflating when the directory says so, else when the inflate passes it)
    async get(p, max = MAX_FILE_BYTES, too = null) {
      const f = out.get(p.replace(/^\//, '').toLowerCase());
      if (!f) return null;
      if (too && f.usize > max) throw too(mb(f.usize));
      if (f.method === 0) {
        if (too && f.data.length > max) throw too(mb(f.data.length));
        return f.data.slice().buffer;
      }
      if (f.method !== 8) throw new Error(`zip entry ${p} uses compression method ${f.method}`);
      // inflated with a count, refused past the viewer's file limit (a zip bomb stops there)
      if (f.usize > MAX_FILE_BYTES) throw new Error(`zip entry ${p} unpacks to over ${(MAX_FILE_BYTES / 2 ** 30).toFixed(0)} GB, more than this viewer opens`);
      if (!too) return inflate(f.data, 'deflate-raw', MAX_FILE_BYTES);
      try { return await inflate(f.data, 'deflate-raw', max); } catch (e) {
        if (/too big/.test(e.message)) throw too(`over ${mb(max)}`);
        throw e;
      }
    },
  };
}

// a small XML tokenizer: [{ tag, attrs, close, self }] (a worker has no DOMParser)
function xmlTags(s) {
  const out = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    const attrs = {};
    const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = ar.exec(m[3]))) attrs[a[1].replace(/^.*:/, '')] = a[2] ?? a[3];
    out.push({ tag: m[2].replace(/^.*:/, ''), attrs, close: !!m[1], self: !!m[4] });
  }
  return out;
}

// 3MF's unit attribute -> the viewer's unit name (js/units.js holds mm per unit)
const UNIT_NAME = { micron: 'um', millimeter: 'mm', centimeter: 'cm', inch: 'in', foot: 'ft', meter: 'm' };

async function parse3MF(buf, base) {
  const zip = await unzip(buf);
  // an XML part is read as one string: refused past the text limit before it is inflated
  const xmlPart = (p, what) => zip.get(p, MAX_TEXT_BYTES, (size) => new Error(`${base}.3mf: its ${what} ${p} unpacks to ${size}, ${TEXT_LIMIT_WORDS}`));
  let path = '3D/3dmodel.model';
  const rels = await xmlPart('_rels/.rels', 'relationships part');
  if (rels) {
    const t = xmlTags(text(rels, `${base}.3mf's relationships part`)).find((x) => x.tag === 'Relationship' && /3dmodel$/.test(x.attrs.Type || ''));
    if (t && t.attrs.Target) path = t.attrs.Target;
  }
  const xml = await xmlPart(path, 'model part');
  if (!xml) throw new Error(`${base}.3mf has no model part (${path})`);
  const tags = xmlTags(text(xml, `${base}.3mf's model part`));
  const modelTag = tags.find((x) => x.tag === 'model');
  const unit = (modelTag && modelTag.attrs.unit) || 'millimeter';
  const k = LENGTH_MM[UNIT_NAME[unit]] ?? 1;
  const objects = new Map(); // id -> { name, verts, tris, pids, comps }
  const mats = new Map();    // basematerials id -> [[r,g,b], ...]
  const build = [];
  let obj = null, matGroup = null;
  for (const t of tags) {
    if (t.close) { if (t.tag === 'object') obj = null; if (t.tag === 'basematerials') matGroup = null; continue; }
    switch (t.tag) {
      case 'basematerials': matGroup = []; mats.set(t.attrs.id, matGroup); break;
      case 'base': if (matGroup) matGroup.push(hexColour(t.attrs.displaycolor)); break;
      case 'object': obj = { name: t.attrs.name || `object ${t.attrs.id}`, verts: [], tris: [], tcol: [], comps: [], pid: t.attrs.pid, pindex: +(t.attrs.pindex || 0) }; objects.set(t.attrs.id, obj); break;
      case 'vertex': if (obj) obj.verts.push(+t.attrs.x * k, +t.attrs.y * k, +t.attrs.z * k); break;
      case 'triangle': if (obj) {
        obj.tris.push(+t.attrs.v1, +t.attrs.v2, +t.attrs.v3);
        const pid = t.attrs.pid ?? obj.pid, pi = t.attrs.p1 !== undefined ? +t.attrs.p1 : obj.pindex;
        obj.tcol.push(pid !== undefined && mats.get(pid) ? mats.get(pid)[pi] || null : null);
      } break;
      case 'component': if (obj) obj.comps.push({ id: t.attrs.objectid, m: mat3mf(t.attrs.transform, k) }); break;
      case 'item': build.push({ id: t.attrs.objectid, m: mat3mf(t.attrs.transform, k) }); break;
      default:
    }
  }
  // the component tree counted before it is built: a missing object, a cycle or a tree over 32
  // deep is a damaged file (they were dropped without a word), and a shared object placed past
  // the caps is refused (each object holding two of the next, 30 deep, ran the tab out of memory)
  const who = `${base}.3mf`;
  placements(build.map((it) => it.id), (id, from) => {
    const o = objects.get(id);
    if (!o) throw new Error(`${who} is damaged: ${from === null ? 'its build' : `object ${from}`} names object ${id}, which is not there`);
    return o.comps.map((c) => c.id);
  }, (id) => { const o = objects.get(id); return { tris: o.tris.length / 3, verts: o.tris.length ? o.verts.length / 3 : 0 }; }, 32,
  (why, id) => new Error(why === 'cycle' ? `${who} is damaged: object ${id} is its own ancestor` : `${who} is damaged: its component tree is more than 32 deep`), who);
  const bodies = [];
  const node = (id, m, depth) => {
    const o = objects.get(id);
    if (!o) return null; // (not met: the count above refused it)
    const n = { name: o.name, meshes: [], children: [] };
    if (o.tris.length) {
      const pos = new Array(o.verts.length);
      for (let i = 0; i < o.verts.length; i += 3) {
        const [x, y, z] = [o.verts[i], o.verts[i + 1], o.verts[i + 2]];
        pos[i] = x * m[0] + y * m[3] + z * m[6] + m[9];
        pos[i + 1] = x * m[1] + y * m[4] + z * m[7] + m[10];
        pos[i + 2] = x * m[2] + y * m[5] + z * m[8] + m[11];
      }
      const cs = new Set(o.tcol.map((c) => (c ? c.join(',') : '')));
      const one = cs.size === 1;
      n.meshes.push(bodies.length);
      bodies.push({ name: o.name, pos, tri: o.tris, color: one ? o.tcol[0] : null, col: one ? null : o.tcol.map((c) => c || DEFAULT_GREY) });
    }
    for (const c of o.comps) { const ch = node(c.id, mulAffine(c.m, m), depth + 1); if (ch) n.children.push(ch); }
    return n;
  };
  const root = { name: base, meshes: [], children: [] };
  for (const it of build) { const n = node(it.id, it.m, 0); if (n) root.children.push(n); }
  // (bodies are welded in order, so node mesh indices stay right)
  checkBodies(`${base}.3mf`, bodies);
  const meshes = bodies.map(weld);
  needTriangles(`${base}.3mf`, meshes);
  return { units: MM, meshes, root, sourceUnits: UNIT_NAME[unit] || undefined };
}
function hexColour(h) {
  const m = /^#?([0-9a-f]{6})/i.exec(h || '');
  if (!m) return null;
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
}
// a 3MF transform (12 numbers, row vectors: p' = p M) with its translation in mm
function mat3mf(s, k) {
  const v = (s || '1 0 0 0 1 0 0 0 1 0 0 0').trim().split(/\s+/).map(Number);
  return [v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9] * k, v[10] * k, v[11] * k];
}
// p (a M) then b: the affine a followed by b, both row-vector 3x4
function mulAffine(a, b) {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  for (let j = 0; j < 3; j++) r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  return r;
}

// ---------- glTF / GLB ----------
const COMP = { 5120: [Int8Array, 127], 5121: [Uint8Array, 255], 5122: [Int16Array, 32767], 5123: [Uint16Array, 65535], 5125: [Uint32Array, 0], 5126: [Float32Array, 0] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// a glTF's JSON, or a plain "damaged" in place of the engine's parse error
function parseJSON(s, what) {
  try { return JSON.parse(s); } catch (e) { throw new Error(`${what} is damaged: its JSON does not parse (${e.message})`); }
}

async function parseGLTF(buf, format, base, files) {
  let json, bin = null;
  if (format === 'glb') {
    // (a file shorter than the header met the engine's "Offset is outside the bounds of the DataView")
    if (buf.byteLength < 12) throw new Error(`${base}.glb is damaged: ${buf.byteLength} bytes, shorter than a GLB header`);
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error(`${base}.glb: not a GLB file`);
    let o = 12;
    while (o + 8 <= buf.byteLength) {
      const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
      if (o + 8 + len > buf.byteLength) throw new Error(`${base}.glb is damaged: a chunk runs past the end of the file`);
      if (type === 0x4e4f534a) json = parseJSON(text(new Uint8Array(buf, o + 8, len), `${base}.glb's JSON`), `${base}.glb`);
      else if (type === 0x004e4942) bin = buf.slice(o + 8, o + 8 + len);
      o += 8 + len;
    }
  } else json = parseJSON(text(buf, `${base}.gltf`), `${base}.gltf`);
  if (!json) throw new Error(`${base}: no glTF JSON`);
  const damaged = (what) => new Error(`${base} is damaged: ${what}`);
  // the JSON's shapes are checked where they are used: a list that is not one, or an index to
  // an entry that is not an object, is a damaged file, not the engine's "is not a function"
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(json)) throw damaged('its JSON is not an object');
  const list = (x, what) => { if (x === undefined) return []; if (!Array.isArray(x)) throw damaged(`${what} is not a list`); return x; };
  const at = (arr, i) => (Number.isInteger(i) && i >= 0 && i < arr.length && isObj(arr[i]) ? arr[i] : null);
  const nat = (x) => Number.isInteger(x) && x >= 0;
  const refused = list(json.extensionsRequired, '"extensionsRequired"').filter((x) => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_mesh_quantization'].includes(x));
  if (refused.length) throw new Error(`${base} needs ${refused.join(', ')}, which this viewer does not decode: export it without compression`);
  const accessors = list(json.accessors, '"accessors"'), views = list(json.bufferViews, '"bufferViews"');
  const nodes = list(json.nodes, '"nodes"'), meshDefs = list(json.meshes, '"meshes"');
  const buffers = await Promise.all(list(json.buffers, '"buffers"').map(async (b, i) => {
    if (!isObj(b)) throw damaged(`buffer ${i} is not an object`);
    if (b.uri === undefined) { if (i === 0 && bin) return bin; throw new Error(`${base}: buffer ${i} has no data`); }
    if (typeof b.uri !== 'string') throw damaged(`buffer ${i}'s uri is not text`);
    // (a data: URI decoded by fetch: new Response(uri) gave the URI's own text as the buffer)
    if (b.uri.startsWith('data:')) return (await fetch(b.uri)).arrayBuffer();
    const f = files.get(decodeURIComponent(b.uri).split('/').pop().toLowerCase());
    if (!f) throw new Error(`${base}.gltf needs ${b.uri}: drop it together with the .gltf`);
    return f;
  }));
  const acc = (i) => {
    const a = at(accessors, i);
    if (!a || !Object.hasOwn(COMP, a.componentType) || !Object.hasOwn(NCOMP, a.type) || !nat(a.count)) throw damaged(`accessor ${i} is missing or malformed`);
    const [Ctor, max] = COMP[a.componentType];
    const nc = NCOMP[a.type];
    // the count is bounded before anything is allocated: by a cap, then by its buffer view
    // (2^30 vertices with no buffer view ran the tab out of memory from a 200-byte file)
    if (a.count * nc > MAX_ACCESSOR_VALUES) throw new Error(`${base}: accessor ${i} holds ${big(a.count * nc)} values, more than the ${big(MAX_ACCESSOR_VALUES)} this viewer reads`);
    const out = a.bufferView === undefined ? new Float64Array(a.count * nc)
      : readView(a.bufferView, a.byteOffset, Ctor, nc, a.count, true, `accessor ${i}`, a.normalized && max);
    // a sparse accessor: its listed elements replaced by its values, over the view or zeros
    // (glTF 2.0 3.6.2.3; ignored, a valid sparse triangle opened as nothing without a word)
    if (a.sparse !== undefined) {
      const sp = a.sparse;
      if (!isObj(sp) || !isObj(sp.indices) || !isObj(sp.values)) throw damaged(`accessor ${i}'s "sparse" is malformed`);
      if (!Number.isInteger(sp.count) || sp.count < 1 || sp.count > a.count) throw damaged(`accessor ${i}'s sparse count ${sp.count} is not 1 to its ${a.count} elements`);
      const IDX = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array }[sp.indices.componentType];
      if (!IDX) throw damaged(`accessor ${i}'s sparse indices have component type ${sp.indices.componentType}, which is not an unsigned integer type`);
      const ix = readView(sp.indices.bufferView, sp.indices.byteOffset, IDX, 1, sp.count, false, `accessor ${i}'s sparse indices`, 0);
      const vals = readView(sp.values.bufferView, sp.values.byteOffset, Ctor, nc, sp.count, false, `accessor ${i}'s sparse values`, a.normalized && max);
      for (let s = 0; s < sp.count; s++) {
        const e = ix[s];
        if (e >= a.count) throw damaged(`accessor ${i}'s sparse index ${e} is past its ${a.count} elements`);
        for (let c = 0; c < nc; c++) out[e * nc + c] = vals[s * nc + c];
      }
    }
    return out;
  };
  // count elements of nc components of Ctor from buffer view vi at byte offset off (strided only
  // where the view may be: a sparse view is packed), normalised by max when it is not 0; every
  // read is checked inside the view once, not met as a DataView RangeError
  const readView = (vi, offset, Ctor, nc, count, strided, what, max) => {
    const bv = at(views, vi);
    const data = bv && Number.isInteger(bv.buffer) ? buffers[bv.buffer] : undefined;
    if (!(data instanceof ArrayBuffer)) throw damaged(`${what} names a buffer view that is not there`);
    const bvOff = bv.byteOffset ?? 0, aOff = offset ?? 0;
    const bvLen = bv.byteLength ?? data.byteLength - bvOff;
    if (!nat(bvOff) || !nat(bvLen) || bvOff + bvLen > data.byteLength) throw damaged(`buffer view ${vi} runs past the end of its buffer`);
    const size = Ctor.BYTES_PER_ELEMENT;
    const stride = (strided && bv.byteStride) || size * nc;
    if (!Number.isInteger(stride) || stride < 1) throw damaged(`buffer view ${vi} has a byteStride of ${bv.byteStride}`);
    if (!nat(aOff) || aOff + (count ? (count - 1) * stride + nc * size : 0) > bvLen) throw damaged(`${what} reads past the end of its buffer`);
    const out = new Float64Array(count * nc);
    const bytes = new DataView(data, bvOff + aOff);
    const get = { 1: (o) => (Ctor === Int8Array ? bytes.getInt8(o) : bytes.getUint8(o)), 2: (o) => (Ctor === Int16Array ? bytes.getInt16(o, true) : bytes.getUint16(o, true)),
      4: (o) => (Ctor === Float32Array ? bytes.getFloat32(o, true) : bytes.getUint32(o, true)) }[size];
    for (let e = 0; e < count; e++) {
      for (let c = 0; c < nc; c++) {
        let v = get(e * stride + c * size);
        if (max) v = Math.max(v / max, -1);
        out[e * nc + c] = v;
      }
    }
    return out;
  };
  // each material's colour: baseColorFactor, times its base texture's average
  // colour when it has one and the image can be decoded here
  const matColour = await Promise.all(list(json.materials, '"materials"').map(async (mat) => {
    const pbr = (isObj(mat) && isObj(mat.pbrMetallicRoughness) && mat.pbrMetallicRoughness) || {};
    const f = Array.isArray(pbr.baseColorFactor) ? linearToSrgb(pbr.baseColorFactor) : null;
    const tex = isObj(pbr.baseColorTexture) ? await textureAverage(json, buffers, pbr.baseColorTexture.index, files) : null;
    if (!tex) return f;
    return (f || [1, 1, 1]).map((c, k) => c * tex[k]);
  }));
  const si = json.scene ?? 0;
  // with no scenes the roots are the nodes no node names as a child (every node as a root drew
  // each child twice: under its parent and again at the origin)
  const named = new Set();
  if (json.scenes === undefined) for (const nd of nodes) if (isObj(nd) && Array.isArray(nd.children)) for (const c of nd.children) named.add(c);
  const scene = json.scenes !== undefined ? at(list(json.scenes, '"scenes"'), si) : { nodes: nodes.map((_, i) => i).filter((i) => !named.has(i)) };
  if (!scene) throw damaged(`its scene ${si} is not there`);
  const roots = list(scene.nodes, `scene ${si}'s "nodes"`);
  // the node tree counted before it is built: a node among its own ancestors (a cycle), a
  // missing node, or a tree deeper than 64 is a damaged file (a self-child overflowed the
  // stack), and a node shared past the caps is refused (each node holding the next twice,
  // 40 deep, was 2^40 visits)
  // a mesh's triangles (by its indices, else its positions) and the vertices each placement of
  // it copies (its POSITION count)
  const meshCounts = (mi) => {
    const me = at(meshDefs, mi);
    let tris = 0, verts = 0;
    for (const pr of (me && Array.isArray(me.primitives) ? me.primitives : [])) {
      if (!isObj(pr) || (pr.mode ?? 4) !== 4) continue;
      const p = isObj(pr.attributes) ? at(accessors, pr.attributes.POSITION) : null;
      const a = pr.indices !== undefined ? at(accessors, pr.indices) : p;
      if (a && nat(a.count)) tris += Math.floor(a.count / 3);
      if (p && nat(p.count)) verts += p.count;
    }
    return { tris, verts };
  };
  placements(roots, (ni) => {
    const nd = at(nodes, ni);
    if (!nd) throw damaged(`node ${ni} is not there`);
    return list(nd.children, `node ${ni}'s "children"`);
  }, (ni) => (nodes[ni].mesh !== undefined ? meshCounts(nodes[ni].mesh) : { tris: 0, verts: 0 }), 64,
  (why, ni) => damaged(why === 'cycle' ? `node ${ni} is its own ancestor` : 'its node tree is more than 64 deep'), base);
  const bodies = [];
  const nodeOf = (ni, parent) => {
    const nd = nodes[ni];
    const m = mul4(parent, localMatrix(nd, (k, n) => damaged(`node ${ni}'s "${k}" is not a list of ${n} numbers`)));
    const n = { name: nd.name || `node ${ni}`, meshes: [], children: [] };
    if (nd.mesh !== undefined) {
      const me = at(meshDefs, nd.mesh);
      if (!me) throw damaged(`node ${ni} names mesh ${nd.mesh}, which is not there`);
      list(me.primitives, `mesh ${nd.mesh}'s "primitives"`).forEach((pr, k) => {
        if (!isObj(pr)) throw damaged(`mesh ${nd.mesh} primitive ${k + 1} is not an object`);
        if ((pr.mode ?? 4) !== 4) return; // points, lines, strips: not drawn
        if (pr.extensions && (pr.extensions.KHR_draco_mesh_compression)) throw new Error(`${base} uses Draco compression, which this viewer does not decode`);
        if (!isObj(pr.attributes)) throw damaged(`mesh ${nd.mesh} primitive ${k + 1} has no attributes`);
        const P = acc(pr.attributes.POSITION);
        const nv = P.length / 3;
        const pos = new Array(nv * 3);
        for (let v = 0; v < nv; v++) {
          const [x, y, z] = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
          // metres to mm
          pos[v * 3] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * 1000;
          pos[v * 3 + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * 1000;
          pos[v * 3 + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * 1000;
        }
        const idx = pr.indices !== undefined ? Array.from(acc(pr.indices)) : Array.from({ length: nv }, (_, i) => i);
        // a mirroring transform flips the winding back
        if (det3(m) < 0) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
        n.meshes.push(bodies.length);
        bodies.push({ name: me.primitives.length > 1 ? `${me.name || n.name} ${k + 1}` : (me.name || n.name), pos, tri: idx,
          color: Number.isInteger(pr.material) ? matColour[pr.material] || null : null });
      });
    }
    for (const c of nd.children || []) n.children.push(nodeOf(c, m));
    return n;
  };
  const root = { name: base, meshes: [], children: roots.map((ni) => nodeOf(ni, IDENT)) };
  checkBodies(base, bodies);
  const meshes = bodies.map(weld);
  needTriangles(base, meshes);
  return { units: MM, meshes, root, sourceUnits: 'm' };
}
// A texture's average colour (sRGB, 0..1), or null where the image cannot be
// decoded here (no createImageBitmap / OffscreenCanvas: Node, an old browser)
// or is not found. The image is drawn at 32 x 32 and its pixels averaged,
// weighted by alpha.
async function textureAverage(json, buffers, ti, files) {
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
    const img = json.images && json.textures && json.textures[ti] && json.images[json.textures[ti].source];
    if (!img) return null;
    let blob;
    if (img.bufferView !== undefined) {
      const bv = json.bufferViews[img.bufferView];
      blob = new Blob([new Uint8Array(buffers[bv.buffer], bv.byteOffset || 0, bv.byteLength)], { type: img.mimeType || 'image/png' });
    } else if (img.uri && img.uri.startsWith('data:')) blob = await (await fetch(img.uri)).blob();
    else if (img.uri) {
      const f = files.get(decodeURIComponent(img.uri).split('/').pop().toLowerCase());
      if (!f) return null;
      blob = new Blob([f]);
    } else return null;
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(32, 32);
    const cx = cv.getContext('2d');
    cx.drawImage(bmp, 0, 0, 32, 32);
    const px = cx.getImageData(0, 0, 32, 32).data;
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < px.length; i += 4) { const a = px[i + 3] / 255; r += px[i] * a; g += px[i + 1] * a; b += px[i + 2] * a; w += a; }
    return w ? [r / w / 255, g / w / 255, b / w / 255] : null;
  } catch { return null; }
}

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// column-major 4x4, as glTF stores matrices
function mul4(a, b) {
  const r = new Array(16);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) r[c * 4 + rr] = a[rr] * b[c * 4] + a[4 + rr] * b[c * 4 + 1] + a[8 + rr] * b[c * 4 + 2] + a[12 + rr] * b[c * 4 + 3];
  return r;
}
// (bad(key, n) -> the Error for a key that is not a list of n numbers)
function localMatrix(nd, bad) {
  const v = (k, n, d) => {
    const x = nd[k];
    if (x === undefined) return d;
    if (!Array.isArray(x) || x.length !== n) throw bad(k, n);
    return x;
  };
  if (nd.matrix !== undefined) return v('matrix', 16);
  const [tx, ty, tz] = v('translation', 3, [0, 0, 0]);
  const [qx, qy, qz, qw] = v('rotation', 4, [0, 0, 0, 1]);
  const [sx, sy, sz] = v('scale', 3, [1, 1, 1]);
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, tx, ty, tz, 1];
}
const det3 = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
// glTF colours are linear; the viewer's are sRGB
const linearToSrgb = (f) => f.slice(0, 3).map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
