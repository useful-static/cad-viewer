// Mesh files opened as models (plan feature 14; feature review item 23):
// STL (binary or ASCII; VisCAM / Magics facet colours), OBJ (with its MTL;
// vertex colours), PLY (ASCII or binary, vertex and face colours), OFF, 3MF
// (a zip: its model XML, units, components, base materials and colour groups)
// and glTF / GLB (core, KHR_mesh_quantization and EXT_mesh_gpu_instancing:
// node transforms baked in, baseColorFactor x texture x COLOR_0, metres to
// mm). Each parser returns the model js/cadmesh.js encodeCadmesh
// takes, so the tree, colours, cache, Save .cadmesh, the facts, edges and
// Measure all work as for a converted STEP file.
//
// Every body is welded (equal positions become one vertex) and given normals
// smoothed only across edges under CREASE_DEG, so a cube keeps its sharp
// edges and a cylinder its round side.
//
// Pure ES module, no DOM (a worker may run it); 3MF needs
// DecompressionStream for its deflated entries.

import { DEFAULT_GREY, MAX_COORD, MAX_COORD_WORDS, MAX_FILE_BYTES, MM, inflate, toByte } from './cadmesh.js';
import { FORMATS, SNIFF_BYTES, extOf, sniffFormat } from './formats.js';
import { LENGTH_MM } from './units.js';

// the mesh extensions, from the viewer's one format table (js/formats.js)
export const MESH_EXTS = FORMATS.filter((f) => f.kind === 'mesh').flatMap((f) => f.ext);
const CREASE_DEG = 30;
// A 3MF or glTF names a part once and places it many times; the placements are counted
// before any is built (a part shared two ways down 40 levels is 2^40 placements from a few
// hundred bytes). Real assemblies of several million placed triangles stay under these.
// (own(id) may give .parts: the parts a node adds beyond itself, a glTF node's instances)
// Vertices are counted as well as triangles: each placement copies its part's vertices, so one
// triangle indexing a 30 M-vertex list, placed 4 times, was 29.6 s and 2.9 GB from 451 bytes
// (the vertex cap is an unindexed mesh at the triangle cap: 3 corners each).
const MAX_PLACED_TRIANGLES = 10_000_000;
const MAX_PLACED_VERTICES = 3 * MAX_PLACED_TRIANGLES;
const MAX_PLACED_PARTS = 2_000_000;
// a glTF accessor's values, refused past this before it is allocated (3 coordinates of
// 3 corners of the triangle cap; a 200-byte file asked for 2^30 vertices)
const MAX_ACCESSOR_VALUES = 9 * MAX_PLACED_TRIANGLES;
// a glTF's materials: each one a drawn primitive uses may name a texture whose image is decoded
// (one at a time, each image once), so the list bounds the decodes (100,000 materials naming one
// image were 100,000 decodes in flight at once)
const MAX_MATERIALS = 65_536;
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
    const r = { parts: 1 + (o.parts || 0), tris: o.tris, verts: o.verts, height: 0 };
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
  const u8 = new Uint8Array(buf, 0, Math.min(buf.byteLength, SNIFF_BYTES));
  const s = sniffFormat(u8);
  if (s && s.magic && s.kind === 'mesh') return s.ext[0];
  const ext = extOf(name);
  return MESH_EXTS.includes(ext) ? ext : null;
}

// A companion file's key: its name without a directory (cut at / or \) and without case. Every
// reference a mesh file makes to another (an OBJ's mtllib, a glTF's buffers and images) is looked
// up by this one rule, and the map's own keys are read by it too, so a map keyed by bare name (a
// drop: js/main.js keys by File.name) and one keyed by path both match.
export const companionKey = (ref) => String(ref).split(/[/\\]/).pop().toLowerCase();
function companion(files, ref) {
  const k = companionKey(ref);
  if (files.has(k)) return files.get(k);
  for (const [n, f] of files) if (companionKey(n) === k) return f;
  return null;
}

// A model from a mesh file. files: other dropped files by name (an OBJ's .mtl, a .gltf's .bin),
// matched by companionKey. Throws in plain words on what it refuses.
// Every refusal names the file one way: its name and the format's extension ("a.stl"); the
// tree's root keeps the bare name.
export async function parseMesh(format, buf, name, files = new Map()) {
  const base = (name || 'model').replace(/\.[^.]+$/, '');
  const file = `${base}.${format}`;
  switch (format) {
    case 'stl': return finish(file, base, parseSTL(buf, base));
    case 'obj': return finish(file, base, parseOBJ(text(buf, file), files, base));
    case 'ply': return finish(file, base, parsePLY(buf, base));
    case 'off': return finish(file, base, parseOFF(text(buf, file), base));
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
// (buf: an ArrayBuffer or a byte view; encoding: an ASCII PLY body is latin1)
const text = (buf, what = 'the file', encoding = 'utf-8') => {
  if (buf.byteLength > MAX_TEXT_BYTES) throw new Error(`${what} is ${mb(buf.byteLength)} of text, ${TEXT_LIMIT_WORDS}`);
  return new TextDecoder(encoding).decode(buf);
};

// raw bodies [{ name, pos: number[], tri: number[], col?: [r,g,b] per
// triangle or null, color }] -> the encodeCadmesh model, one tree node
// a face pointing past the vertices, or a coordinate that is not a number, is a damaged file:
// said so here, not met later as NaN geometry ("facts are not one closed / area / volume")
// (MAX_COORD: js/cadmesh.js, the one bound)
function checkBodies(rootName, bodies) {
  for (const b of bodies) {
    const n = b.pos.length / 3;
    for (const x of b.pos) if (!Number.isFinite(x)) throw new Error(`${rootName} is damaged: a vertex coordinate is not a number`);
    for (const x of b.pos) if (Math.abs(x) > MAX_COORD) throw new Error(`${rootName} is too large to show (a coordinate past ${MAX_COORD_WORDS})`);
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

// (file: the name refusals use, "a.stl"; rootName: the tree root's, "a")
function finish(file, rootName, bodies) {
  checkBodies(file, bodies);
  const welded = bodies.filter((b) => b.tri.length).map(weld);
  needTriangles(file, welded);
  const meshes = welded.filter((m) => m.indices.length);
  return { units: MM, meshes, root: { name: rootName, meshes: meshes.map((_, i) => i), children: [] } };
}

// The readers that build as they read (STL, OBJ, PLY, OFF) are held to the caps the 3MF and
// glTF readers use, in the same words; counted before what they count is built.
// OBJ, OFF and PLY had none: one OBJ face of alternating corners is a triangle per 2 bytes, so
// 20 MB made 10 M triangles (4.2 s, 1.6 GB) and 40 MB ran a tab out of memory.
const tooMany = (who, what, cap) => new Error(`${who} holds more than the ${big(cap)} ${what} this viewer opens`);
function counter(who) {
  const n = { triangles: 0, vertices: 0 };
  const caps = { triangles: MAX_PLACED_TRIANGLES, vertices: MAX_PLACED_VERTICES };
  return (what, k = 1) => { if ((n[what] += k) > caps[what]) throw tooMany(who, what, caps[what]); };
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
  // per welded vertex: its groups [{ n: unit seed, out }] (and .noNormal, its no-normal group), with colours kept apart by a Map
  // colour -> groups (a linear search over every colour at a vertex was quadratic: a fan of
  // 60 k triangles, each its own colour, about one centre took 13.5 s)
  const groups = new Array(wp.length / 3);
  const corner = new Uint32Array(kept * 3); // the group (output vertex) each corner uses
  const outPos = [], outNrmSum = [], outCol = [];
  const cols = b.col ? colKept : null;
  // A triangle with no normal (distinct corners on one line: zero area, or one not finite) matches
  // no group, so it opened a new one at each corner, each searched by every later triangle there:
  // a fan of N such triangles about one vertex was quadratic (60 k: 11.2 s). Those triangles share
  // one no-normal group per vertex (and colour) instead, kept out of the crease search.
  for (let t = 0; t < kept; t++) {
    const fx = fn[t * 3], fy = fn[t * 3 + 1], fz = fn[t * 3 + 2];
    const fl = Math.hypot(fx, fy, fz);
    const flat = !(fl > 0 && Number.isFinite(fl));
    const n = flat ? null : [fx / fl, fy / fl, fz / fl];
    const ck = cols ? cols[t].join(',') : '';
    for (let c = 0; c < 3; c++) {
      const w = tri[t * 3 + c];
      let gs;
      if (cols) {
        const byCol = groups[w] || (groups[w] = new Map());
        gs = byCol.get(ck);
        if (!gs) { gs = []; byCol.set(ck, gs); }
      } else gs = groups[w] || (groups[w] = []);
      // (a property of the array, not "flat": that is Array.prototype.flat, a function)
      let g = flat ? gs.noNormal : gs.find((x) => x.n[0] * n[0] + x.n[1] * n[1] + x.n[2] * n[2] >= cosC);
      if (!g) {
        g = { n, out: outPos.length / 3 };
        if (flat) gs.noNormal = g; else gs.push(g);
        outPos.push(wp[w * 3], wp[w * 3 + 1], wp[w * 3 + 2]);
        outNrmSum.push(0, 0, 0);
        if (cols) outCol.push(toByte(cols[t][0]), toByte(cols[t][1]), toByte(cols[t][2]), 255);
      }
      if (!flat) { outNrmSum[g.out * 3] += fx; outNrmSum[g.out * 3 + 1] += fy; outNrmSum[g.out * 3 + 2] += fz; }
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
  const hold = counter(`${base}.stl`);
  // binary when the size is 84 + 50 n, even if it starts "solid", or that plus a surplus under one
  // record (padding, an appended byte or two). Text cannot pass for it: header bytes 80-83 of text
  // count at least 0x09090909 triangles, far past the size.
  const n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  const want = 84 + 50 * n;
  if (buf.byteLength >= 84 && want <= buf.byteLength && buf.byteLength - want < 50) {
    hold('triangles', n); hold('vertices', 3 * n);
    const pos = new Array(n * 9), tri = new Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + k * 4, true);
      tri[i * 3] = i * 3; tri[i * 3 + 1] = i * 3 + 1; tri[i * 3 + 2] = i * 3 + 2;
    }
    return [{ name: base, pos, tri, ...stlColours(dv, n) }];
  }
  // neither: a file holding a NUL byte is binary (no ASCII STL has one), so its size is what is wrong
  const sizeWrong = () => new Error(`${base}.stl is damaged: its header counts ${big(n)} triangle${n === 1 ? '' : 's'}, so it should be ${big(want)} bytes, but it is ${big(buf.byteLength)} bytes`);
  const binary = () => buf.byteLength >= 84 && new Uint8Array(buf).indexOf(0) >= 0;
  const s = text(buf, `${base}.stl`);
  if (!/^\s*solid/.test(s)) {
    if (binary()) throw sizeWrong();
    throw new Error(`${base}.stl is neither a binary STL (its size does not match its triangle count) nor an ASCII one`);
  }
  if (!/\bvertex\b/.test(s) && binary()) throw sizeWrong();
  const bodies = [];
  let cur = null;
  // (the indent is [ \t]*, not \s*: \s crossed newlines from every line start, so 256 KB of
  // blank lines was quadratic, 91 s)
  const re = /^[ \t]*(solid|endsolid|vertex|endfacet)\b(.*)$/gm;
  let m;
  let fv = [];
  // a body is made at its first record (a "solid" only names the next one: 40 MB of "solid"
  // lines made a body each, 1.1 GB): "solidx" passes the ASCII test but is not a solid record,
  // and an endfacet with no body met null
  let name = base;
  const body = () => { if (!cur) { cur = { name, pos: [], tri: [] }; bodies.push(cur); } return cur; };
  while ((m = re.exec(s))) {
    if (m[1] === 'solid') {
      name = m[2].trim() || base;
      if (cur && !cur.pos.length) cur.name = name; else cur = null;
    }
    else if (m[1] === 'vertex') {
      // three numbers, or the file is damaged (a short line shifted every later coordinate)
      body();
      const xyz = m[2].trim().split(/\s+/).slice(0, 3).map(Number);
      if (xyz.length < 3 || !xyz.every(Number.isFinite)) throw new Error(`${base}.stl is damaged: "${m[0].trim().slice(0, 80)}" is not three numbers`);
      hold('vertices');
      fv.push(xyz[0], xyz[1], xyz[2]);
    }
    else if (m[1] === 'endfacet') {
      // a facet of more than 3 vertices: a fan (appended by a loop: spread into push, a
      // 300 k-vertex facet overflowed the stack)
      body();
      if (fv.length > 6) hold('triangles', fv.length / 3 - 2);
      const k0 = cur.pos.length / 3;
      for (const x of fv) cur.pos.push(x);
      for (let i = 1; i + 1 < fv.length / 3; i++) cur.tri.push(k0, k0 + i, k0 + i + 1);
      fv = [];
    }
  }
  return bodies;
}

// A binary STL's per-facet colours, from each record's 16-bit attribute word, by the two
// conventions writers use (both 5 bits a channel, 0-31):
// - Materialise Magics, when the header holds "COLOR=": the 4 bytes after it are the part's RGBA,
//   and the first 4 after ",MATERIAL=" (its diffuse colour) are preferred over them. A facet with
//   bit 15 CLEAR has its own colour, red in bits 0-4, green 5-9, blue 10-14; bit 15 set takes the
//   part's colour.
// - VisCAM / SolidView, any other header: bit 15 SET marks the facet's colour valid, blue in bits
//   0-4, green 5-9, red 10-14; clear is no colour (the default grey).
// -> {} (no colour), { color } (one for every facet) or { col } (per facet, grey where none)
function stlColours(dv, n) {
  const hdr = new Uint8Array(dv.buffer, 0, 80);
  const words = String.fromCharCode(...hdr);
  const ci = words.indexOf('COLOR='), mi = words.indexOf('MATERIAL=');
  const rgba = (at) => (at + 4 <= 80 ? [hdr[at] / 255, hdr[at + 1] / 255, hdr[at + 2] / 255] : null);
  const magics = ci >= 0;
  const part = (mi >= 0 && rgba(mi + 9)) || (magics && rgba(ci + 6)) || null;
  // one colour array per distinct word, shared by its facets (10 M facets, at most 65,536 arrays)
  const byWord = new Map();
  const col = new Array(n);
  let any = false, same = true;
  for (let i = 0; i < n; i++) {
    const w = dv.getUint16(84 + i * 50 + 48, true);
    let c = byWord.get(w);
    if (c === undefined) {
      const ch = (sh) => ((w >> sh) & 31) / 31;
      c = magics ? (w & 0x8000 ? part : [ch(0), ch(5), ch(10)]) : (w & 0x8000 ? [ch(10), ch(5), ch(0)] : null);
      byWord.set(w, c);
    }
    if (c) any = true;
    if (i && c !== col[0]) same = false;
    col[i] = c;
  }
  if (!any) return {};
  if (same) return { color: col[0] };
  for (let i = 0; i < n; i++) if (!col[i]) col[i] = DEFAULT_GREY;
  return { col };
}

// ---------- OBJ ----------
// (a vertex may carry a colour, "v x y z r g b" in 0..1, as MeshLab writes it: each triangle
// takes its corners' mean, and that wins over its usemtl's Kd. A line whose last non-space
// character is "\" continues on the next, in both passes below.)
function parseOBJ(s, files, base) {
  if (/\\[ \t\r]*\n/.test(s)) s = s.replace(/\\[ \t\r]*\n/g, ' ');
  const v = [];
  let vc = null; // the vertex colours, 3 per vertex (NaN: none), once one vertex has one
  const bodies = [];
  let cur = null;
  let mat = null;
  const mtl = new Map(); // name -> [r, g, b]
  // an "o"/"g" line names the next body; the body is made at its first face, so an empty group
  // costs nothing (10 MB of "g" lines made a body, a Map and three arrays each: 11 s, 3.8 GB)
  // (the pending name is kept as its span of s, read only when its body is made: a file of
  // empty groups makes no strings; nameAt -1 = the name in nameStr)
  let nameAt = -1, nameEnd = 0, nameStr = base;
  const nameOf = () => (nameAt < 0 ? nameStr : s.slice(nameAt, nameEnd).trim().split(/\s+/).join(' ') || base);
  // (an empty current body, made by a face of no vertices, is dropped for the next)
  const start = (from, to, str) => { if (cur && !cur.pos.length) bodies.pop(); cur = null; nameAt = from; nameEnd = to; nameStr = str; };
  const body = () => { if (!cur) { cur = { name: nameOf(), pos: [], tri: [], col: [], map: new Map() }; bodies.push(cur); } return cur; };
  // one pass over the lines (splitting 40 MB of "g" lines into 20 M strings first was 1.6 s)
  // (the whitespace of the line split's \s, less the newline: a no-break space after "f" or "g"
  // passed the line split but not this test, so its face escaped the count pass and its group
  // reached a second, different "o"/"g" branch)
  const ws = (c) => (c <= 32 ? c === 32 || c === 9 || c === 13 || c === 11 || c === 12 : c >= 160 && /\s/.test(String.fromCharCode(c)));
  const n = s.length;
  // the "v" lines and the faces' triangles counted against the caps first, by a pass that makes
  // no strings (a 20 MB face of alternating corners was 10 M triangles built, 4.2 s and 1.6 GB);
  // the vertices the bodies copy are held as they are made
  const who = `${base}.obj`;
  const hold = counter(who);
  {
    let nv = 0, nt = 0;
    for (let i = 0; i < n;) {
      let e = s.indexOf('\n', i);
      if (e < 0) e = n;
      let a = i;
      i = e + 1;
      while (a < e && ws(s.charCodeAt(a))) a++;
      const c0 = s.charCodeAt(a);
      if (a === e || (a + 1 < e && !ws(s.charCodeAt(a + 1)))) continue;
      if (c0 === 118) nv++; // "v"
      else if (c0 === 102) { // "f": its corners, less 2
        let k = 0, inTok = false;
        for (let j = a + 1; j < e; j++) { const w = ws(s.charCodeAt(j)); if (!w && !inTok) k++; inTok = !w; }
        if (k > 2) nt += k - 2;
      }
    }
    if (nv > MAX_PLACED_VERTICES) throw tooMany(who, 'vertices', MAX_PLACED_VERTICES);
    if (nt > MAX_PLACED_TRIANGLES) throw tooMany(who, 'triangles', MAX_PLACED_TRIANGLES);
  }
  // each MTL is read once (each "mtllib" line naming it re-read it: 20 k lines, 32.8 s)
  const mtlRead = new Set();
  for (let i = 0; i < n;) {
    let e = s.indexOf('\n', i);
    if (e < 0) e = n;
    let a = i;
    i = e + 1;
    while (a < e && ws(s.charCodeAt(a))) a++;
    if (a === e) continue;
    const c0 = s.charCodeAt(a);
    if (c0 === 35) continue; // '#'
    if ((c0 === 103 || c0 === 111) && (a + 1 === e || ws(s.charCodeAt(a + 1)))) { start(a + 1, e, base); continue; } // "g", "o"
    const line = s.slice(a, e).trim();
    if (!line || line[0] === '#') continue;
    const sp = line.split(/\s+/);
    const k = sp[0];
    if (k === 'v') {
      v.push(+sp[1], +sp[2], +sp[3]);
      if (sp.length >= 7) {
        if (!vc) vc = new Array(v.length - 3).fill(NaN);
        vc.push(+sp[4], +sp[5], +sp[6]);
      } else if (vc) vc.push(NaN, NaN, NaN);
    }
    else if (k === 'mtllib') {
      // the rest of the line as one name first (Blender writes "mtllib my model.mtl" unquoted),
      // else each word a name (the form "mtllib a.mtl b.mtl")
      const whole = line.slice(6).trim();
      const names = sp.length > 2 && companion(files, whole) ? [whole] : sp.slice(1);
      for (const f of names) {
        const key = companionKey(f);
        if (mtlRead.has(key)) continue;
        mtlRead.add(key);
        const t = companion(files, f);
        if (t) readMTL(text(t, f), mtl);
      }
    } else if (k === 'usemtl') mat = sp.slice(1).join(' ');
    else if (k === 'f') {
      body();
      const ids = sp.slice(1).map((x) => {
        const i = parseInt(x, 10);
        const k = i < 0 ? v.length / 3 + i : i - 1;
        // (1-based, negative from the end: 0 or one past the vertices is a damaged file)
        if (!Number.isInteger(k) || k < 0 || k >= v.length / 3) throw new Error(`${base}.obj is damaged: "${line}" refers to vertex ${x} of ${v.length / 3}`);
        return k;
      });
      const loc = ids.map((i) => {
        let j = cur.map.get(i);
        if (j === undefined) { hold('vertices'); j = cur.pos.length / 3; cur.map.set(i, j); cur.pos.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]); }
        return j;
      });
      const c = (mat && mtl.get(mat)) || null;
      const vcol = (i) => (Number.isFinite(vc[i * 3]) ? vc.slice(i * 3, i * 3 + 3) : null);
      for (let i = 1; i + 1 < loc.length; i++) {
        cur.tri.push(loc[0], loc[i], loc[i + 1]);
        let tc = c;
        if (vc) {
          const cs = [ids[0], ids[i], ids[i + 1]].map(vcol);
          if (cs.some(Boolean)) tc = [0, 1, 2].map((q) => ((cs[0] || DEFAULT_GREY)[q] + (cs[1] || DEFAULT_GREY)[q] + (cs[2] || DEFAULT_GREY)[q]) / 3);
        }
        cur.col.push(tc);
      }
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
    else if (sp[0] === 'Kd' && cur) {
      // "Kd r [g b]": one value is a grey (the MTL form); a colour that is not numbers is not one
      const r = +sp[1], g = sp[2] === undefined ? r : +sp[2], b = sp[3] === undefined ? r : +sp[3];
      if ([r, g, b].every(Number.isFinite)) out.set(cur, [r, g, b]);
    }
  }
}

// ---------- PLY ----------
const PLY_T = { char: 'Int8', int8: 'Int8', uchar: 'Uint8', uint8: 'Uint8', short: 'Int16', int16: 'Int16', ushort: 'Uint16', uint16: 'Uint16',
  int: 'Int32', int32: 'Int32', uint: 'Uint32', uint32: 'Uint32', float: 'Float32', float32: 'Float32', double: 'Float64', float64: 'Float64' };
const PLY_SIZE = { Int8: 1, Uint8: 1, Int16: 2, Uint16: 2, Int32: 4, Uint32: 4, Float32: 4, Float64: 8 };
function parsePLY(buf, base) {
  const u8 = new Uint8Array(buf);
  const hdrEnd = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(u8.length, 65536))).indexOf('end_header');
  if (hdrEnd < 0) throw new Error(`${base}.ply is damaged: it has no end_header line`);
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
  // a vertex element must give x, y, z, and is held to the vertex cap before it is looped (40 M
  // property-less records, charged a byte each and none read, built 3 GB of empty positions);
  // the faces' triangles are held at each list's count, before its items are read
  const who = `${base}.ply`;
  const hold = counter(who);
  for (const e of els) {
    // (the face list take() reads)
    e.tlist = e.props.some((pr) => pr.name === 'vertex_indices') ? 'vertex_indices' : 'vertex_index';
    if (e.name !== 'vertex') continue;
    if (!['x', 'y', 'z'].every((c) => e.props.some((pr) => pr.name === c && !pr.list))) throw new Error(`${who} is damaged: its vertex element has no x, y, z properties`);
    if (e.n > MAX_PLACED_VERTICES) throw tooMany(who, 'vertices', MAX_PLACED_VERTICES);
  }
  const corners = (e, pr, c) => { if (e.name === 'face' && pr.name === e.tlist && c > 2) hold('triangles', c - 2); return c; };
  // a colour's scale is its red property's TYPE: a float is 0..1, an integer its type's top
  // (uchar 255, ushort 65535; a 32-bit integer is taken as bytes). Judged by the values, a uchar
  // model whose channels were all 0 or 1 (a near-black part) opened as 0..1 fractions.
  const scaleOf = (name) => {
    const el = els.find((e) => e.name === name);
    const rt = el && el.props.find((pr) => pr.name === 'red' && !pr.list);
    return !rt || /^Float/.test(rt.t) ? 1 : /16$/.test(rt.t) ? 65535 : 255;
  };
  const vScale = scaleOf('vertex'), fScale = scaleOf('face');
  // face colours (MeshLab writes red green blue [alpha] on the face element), one per triangle
  const pos = [], tri = [], vcol = [], fcol = [];
  let hasCol = false, hasFaceCol = false;
  const take = (e, rec) => {
    if (e.name === 'vertex') {
      pos.push(rec.x, rec.y, rec.z);
      if (rec.red !== undefined) { hasCol = true; vcol.push([rec.red, rec.green, rec.blue]); } else vcol.push(null);
    } else if (e.name === 'face') {
      const ids = rec.vertex_indices || rec.vertex_index || [];
      const fc = rec.red !== undefined ? [rec.red / fScale, (rec.green ?? 0) / fScale, (rec.blue ?? 0) / fScale] : null;
      if (fc) hasFaceCol = true;
      for (let i = 1; i + 1 < ids.length; i++) { tri.push(ids[0], ids[i], ids[i + 1]); fcol.push(fc); }
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
    // (through text(): its limit and words, as every other text reader; a 540 MB body met the
    // engine's "Cannot create a string longer than 0x1fffffe8 characters")
    const toks = text(u8.subarray(bodyStart), who, 'latin1').trim().split(/\s+/);
    checkCounts(toks.length, (e) => e.props.length);
    let p = 0;
    for (const e of els) {
      if (!e.props.length) continue; // (its records hold nothing to read)
      for (let i = 0; i < e.n; i++) {
        const rec = {};
        for (const pr of e.props) {
          if (pr.list) { const c = corners(e, pr, listCount(+toks[p++], pr, e, toks.length - p)); rec[pr.name] = toks.slice(p, p + c).map(Number); p += c; } else rec[pr.name] = +toks[p++];
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
      if (!e.props.length) continue; // (its records hold nothing to read)
      for (let i = 0; i < e.n; i++) {
        const rec = {};
        for (const pr of e.props) {
          if (pr.list) { const c = corners(e, pr, listCount(rd(pr.ct), pr, e, (buf.byteLength - o) / PLY_SIZE[pr.t])); const a = new Array(c); for (let j = 0; j < c; j++) a[j] = rd(pr.t); rec[pr.name] = a; } else rec[pr.name] = rd(pr.t);
        }
        take(e, rec);
      }
    }
  }
  const body = { name: base, pos, tri };
  if (hasCol || hasFaceCol) {
    // a face's colour, else its vertex colours' mean (so the weld keeps them), else grey
    const scale = vScale;
    body.col = [];
    for (let t = 0; t < tri.length / 3; t++) {
      if (fcol[t]) { body.col.push(fcol[t]); continue; }
      if (!hasCol) { body.col.push(DEFAULT_GREY); continue; }
      const cs = [0, 1, 2].map((c) => vcol[tri[t * 3 + c]] || DEFAULT_GREY.map((x) => x * scale));
      body.col.push([0, 1, 2].map((k) => (cs[0][k] + cs[1][k] + cs[2][k]) / 3 / scale));
    }
  }
  return [body];
}

// ---------- OFF ----------
// Geomview OFF: the header [ST][C][N]OFF, then per vertex "x y z [nx ny nz] [r g b [a]] [s t]"
// and per face "n i1 .. in [colour]", a colour running to the end of its line. A colour of
// integers is 0-255, of decimals 0..1 (Geomview); one value (a colormap index) is not read.
// The normals are not kept (the weld makes its own from the winding). 4OFF / nOFF (4-D and
// n-D vertices) are not read.
function parseOFF(s, base) {
  // the tokens, and where each non-empty line's tokens start (a colour is the rest of a line)
  const toks = [], lineAt = [];
  for (const raw of s.split('\n')) {
    const h = raw.indexOf('#');
    const l = (h < 0 ? raw : raw.slice(0, h)).trim();
    if (!l) continue;
    lineAt.push(toks.length);
    for (const t of l.split(/\s+/)) toks.push(t);
  }
  lineAt.push(toks.length);
  // the end of the line holding token q (li only moves forward: the reads are in order)
  let li = 0;
  const lineEnd = (q) => { while (lineAt[li + 1] <= q) li++; return lineAt[li + 1]; };
  let p = 0;
  const hm = /^(ST)?(C)?(N)?OFF$/.exec(toks[0] || '');
  if (hm) p++;
  const hasST = !!(hm && hm[1]), hasC = !!(hm && hm[2]), hasN = !!(hm && hm[3]);
  const nv = +toks[p++], nf = +toks[p++];
  p++; // edges
  // the values each vertex holds before a colour (all of them without one)
  const fixed = 3 + (hasN ? 3 : 0) + (hasC ? 0 : hasST ? 2 : 0);
  const least = fixed + (hasC ? 3 + (hasST ? 2 : 0) : 0);
  // counts checked before they are looped on: 1e999 vertices looped until the tab ran out of
  // memory; each vertex takes its tokens and each face at least 4
  if (!Number.isInteger(nv) || !Number.isInteger(nf) || nv < 0 || nf < 0) throw new Error(`${base}.off: not an OFF file (no vertex and face counts)`);
  if (nv * least + nf * 4 > toks.length - p) throw new Error(`${base}.off is damaged: it counts ${nv} vertices and ${nf} faces, more than the file holds`);
  // held to the caps the 3MF and glTF readers use: the vertices by their count, the faces'
  // triangles as each face's count is read, before its triangles are built
  const who = `${base}.off`;
  if (nv > MAX_PLACED_VERTICES) throw tooMany(who, 'vertices', MAX_PLACED_VERTICES);
  const hold = counter(who);
  // a colour from its tokens: 3 or 4 values, integers 0-255 or decimals 0..1; else null
  const colour = (ts) => {
    if (ts.length < 3 || ts.length > 4) return null;
    const v = ts.slice(0, 3).map(Number);
    if (!v.every(Number.isFinite)) return null;
    const ints = ts.slice(0, 3).every((t) => /^[+-]?\d+$/.test(t));
    return v.map((x) => Math.min(1, Math.max(0, ints ? x / 255 : x)));
  };
  const pos = [], vcol = hasC ? [] : null;
  for (let i = 0; i < nv; i++) {
    pos.push(+toks[p], +toks[p + 1], +toks[p + 2]);
    p += fixed;
    if (hasC) {
      // the colour: the rest of the vertex's line, less its texture pair
      const e = Math.max(p, lineEnd(p - 1));
      vcol.push(colour(toks.slice(p, hasST ? Math.max(p, e - 2) : e)));
      p = e;
    }
  }
  const tri = [], tcol = [];
  let anyCol = false;
  for (let i = 0; i < nf; i++) {
    const c = +toks[p++];
    if (!Number.isInteger(c) || c < 0 || c > toks.length - p) throw new Error(`${base}.off is damaged: face ${i + 1} counts ${toks[p - 1]} vertices`);
    if (c > 2) hold('triangles', c - 2);
    const ids = toks.slice(p, p + c).map(Number);
    p += c;
    // the rest of the face's line is its colour (a face with none: the next face starts there)
    const e = Math.max(p, lineEnd(p - 1));
    const fc = colour(toks.slice(p, e));
    p = e;
    for (let k = 1; k + 1 < ids.length; k++) {
      tri.push(ids[0], ids[k], ids[k + 1]);
      // the face's colour, else its corners' mean (COFF), else none
      let tc = fc;
      if (!tc && vcol) {
        const cs = [ids[0], ids[k], ids[k + 1]].map((v) => vcol[v] || DEFAULT_GREY);
        if ([ids[0], ids[k], ids[k + 1]].some((v) => vcol[v])) tc = [0, 1, 2].map((j) => (cs[0][j] + cs[1][j] + cs[2][j]) / 3);
      }
      if (tc) anyCol = true;
      tcol.push(tc);
    }
  }
  const body = { name: base, pos, tri, col: null };
  if (anyCol) {
    // one colour for the body when its triangles agree, else per triangle (uncoloured ones grey)
    const cs = new Set(tcol.map((c) => (c ? c.join(',') : '')));
    if (cs.size === 1) body.color = tcol[0];
    else body.col = tcol.map((c) => c || DEFAULT_GREY);
  }
  return [body];
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

// A small XML tag walker (a worker has no DOMParser): onTag({ tag, attrs, close, self }) for each
// tag whose local name (its prefix dropped) is in `want`, in document order; every other tag is
// passed over without being parsed or kept. onTag returning true stops the walk. (A list of
// every tag, built before anything was counted, ran out of heap on a 204 KB 3MF holding 200 MB
// of "<a/>".)
const TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
function xmlWalk(s, want, onTag) {
  // the wanted tags' starts found by one regex (the engine passes over every other tag
  // natively: 200 MB of "<a/>" in 0.5 s, against 1.2 s for a loop over each '<'), then each read
  // whole by TAG_RE where it starts. A name is matched to its end, one prefix run at most per '<'.
  const find = new RegExp(`<\\/?(?:[A-Za-z_][\\w:.-]*:)?(?:${want.join('|')})(?![\\w:.-])`, 'g');
  // a comment, CDATA section or processing instruction holds no tags: a match inside one is
  // passed over to its end (a commented-out build item was read, and refused as missing). Each
  // span is found once, ahead of the walk, so the walk stays linear; one never closed runs to the
  // end of the text.
  const SPECIAL = /<!--|<!\[CDATA\[|<\?/g;
  const CLOSE = { '<!--': '-->', '<![CDATA[': ']]>', '<?': '?>' };
  const spanFrom = (from) => {
    SPECIAL.lastIndex = from;
    const m = SPECIAL.exec(s);
    if (!m) return { start: Infinity, end: Infinity };
    const e = s.indexOf(CLOSE[m[0]], m.index + m[0].length);
    return { start: m.index, end: e < 0 ? Infinity : e + CLOSE[m[0]].length };
  };
  let span = spanFrom(0);
  let f;
  while ((f = find.exec(s))) {
    while (span.end <= f.index) span = spanFrom(span.end);
    if (span.start < f.index) {
      if (span.end === Infinity) return;
      find.lastIndex = span.end;
      continue;
    }
    TAG_RE.lastIndex = f.index;
    const m = TAG_RE.exec(s);
    if (!m) continue;
    const attrs = {};
    const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = ar.exec(m[3]))) attrs[a[1].replace(/^.*:/, '')] = xmlText(a[2] ?? a[3]);
    if (onTag({ tag: m[2].replace(/^.*:/, ''), attrs, close: !!m[1], self: !!m[4] })) return;
    find.lastIndex = TAG_RE.lastIndex;
  }
}

// An attribute value as text: XML's five named entities and its character references (&#N;,
// &#xH;) decoded ("Bolt &amp; nut" is the name "Bolt & nut"). A reference to no character is
// left as written. (Only a value holding "&" is scanned: a model's millions of coordinates are not.)
const XML_NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(v) {
  if (v.indexOf('&') < 0) return v;
  return v.replace(/&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g, (all, hex, dec, nm) => {
    if (nm) return XML_NAMED[nm];
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : all;
  });
}

// 3MF's unit attribute -> the viewer's unit name (js/units.js holds mm per unit)
const UNIT_NAME = { micron: 'um', millimeter: 'mm', centimeter: 'cm', inch: 'in', foot: 'ft', meter: 'm' };

async function parse3MF(buf, base) {
  const who = `${base}.3mf`;
  // the zip's own refusals ("not a zip file", "a damaged zip ...") name the file as the rest do
  const named = (e) => (e instanceof Error && !e.message.startsWith(who) ? new Error(`${who}: ${e.message}`) : e);
  let zip;
  try { zip = await unzip(buf); } catch (e) { throw named(e); }
  // an XML part is read as one string: refused past the text limit before it is inflated
  // (max: the text left once the model parts before it are counted)
  const xmlPart = async (p, what, max = MAX_TEXT_BYTES) => {
    const also = max < MAX_TEXT_BYTES ? ' with the model parts before it' : '';
    try { return await zip.get(p, max, (size) => new Error(`${who}: its ${what} ${p} unpacks to ${size}${also}, ${TEXT_LIMIT_WORDS}`)); } catch (e) { throw named(e); }
  };
  let path = '3D/3dmodel.model';
  const rels = await xmlPart('_rels/.rels', 'relationships part');
  if (rels) {
    xmlWalk(text(rels, `${base}.3mf's relationships part`), ['Relationship'], (t) => {
      if (!/3dmodel$/.test(t.attrs.Type || '')) return false;
      if (t.attrs.Target) path = t.attrs.Target;
      return true;
    });
  }
  // a part's key: its path without case or a leading / (as the zip matches it)
  const partKey = (p) => p.replace(/^\//, '').toLowerCase();
  const rootKey = partKey(path);
  // what the model parts hold is counted as it is read, and refused past the viewer's caps
  // before it is kept (each vertex, triangle, placement, material and object costs memory)
  const caps = { vertices: MAX_PLACED_VERTICES, triangles: MAX_PLACED_TRIANGLES, 'parts and placements': MAX_PLACED_PARTS,
    'base materials': MAX_PLACED_PARTS, 'material groups': MAX_PLACED_PARTS, objects: MAX_PLACED_PARTS };
  const held = Object.fromEntries(Object.keys(caps).map((c) => [c, 0]));
  const hold = (what) => { if (++held[what] > caps[what]) throw tooMany(who, what, caps[what]); };
  let unit = null;
  // objects and materials keyed by part and id ("<part>#<id>"): with the production extension
  // (Bambu Studio, OrcaSlicer) a component names its object in another model part by p:path,
  // and each part numbers its own objects
  const objects = new Map(); // key -> { name, verts, tris, tcol, comps }
  const mats = new Map();    // key -> [[r,g,b], ...]
  const build = [];
  const partsRead = new Set(), wantedKeys = new Set(), partsWanted = [], partsMissing = new Map(); // key -> path as named
  let textLeft = MAX_TEXT_BYTES;
  // one model part read: the root (its build, the unit) or one a p:path names, each once; the
  // text of all of them held to the one text limit
  const readPart = async (p, isRoot) => {
    const pk = partKey(p);
    partsRead.add(pk);
    const xml = await xmlPart(p, 'model part', textLeft);
    if (!xml) {
      if (isRoot) throw new Error(`${who} has no model part (${p})`);
      partsMissing.set(pk, p);
      return;
    }
    textLeft -= xml.byteLength;
    let k = 1, seenModel = false;
    const key = (id, at = null) => `${at === null ? pk : partKey(at)}#${id}`;
    const want = (at) => { if (at && !partsRead.has(partKey(at)) && !wantedKeys.has(partKey(at))) { wantedKeys.add(partKey(at)); partsWanted.push(at); } };
    let obj = null, matGroup = null;
    // (a property group is core basematerials of <base displaycolor>, or the materials
    // extension's m:colorgroup of <m:color color>; a pid names either, p1 (or the object's
    // pindex) the entry. A colour group gives each corner its own, p1 p2 p3: the triangle takes
    // their mean, as PLY vertex colours are taken)
    xmlWalk(text(xml, `${base}.3mf's model part`), ['model', 'basematerials', 'base', 'colorgroup', 'color', 'object', 'vertex', 'triangle', 'component', 'item'], (t) => {
      if (t.close) { if (t.tag === 'object') obj = null; if (t.tag === 'basematerials' || t.tag === 'colorgroup') matGroup = null; return false; }
      switch (t.tag) {
        // (each part's first model tag gives its unit; the root's is the model's)
        case 'model': if (!seenModel) {
          seenModel = true;
          const u = t.attrs.unit || 'millimeter';
          k = LENGTH_MM[UNIT_NAME[u]] ?? 1;
          if (isRoot) unit = u;
        } break;
        case 'basematerials': hold('material groups'); matGroup = []; mats.set(key(t.attrs.id), matGroup); break;
        case 'base': if (matGroup && !matGroup.perCorner) { hold('base materials'); matGroup.push(hexColour(t.attrs.displaycolor)); } break;
        case 'colorgroup': hold('material groups'); matGroup = []; matGroup.perCorner = true; mats.set(key(t.attrs.id), matGroup); break;
        case 'color': if (matGroup && matGroup.perCorner) { hold('base materials'); matGroup.push(hexColour(t.attrs.color)); } break;
        case 'object': hold('objects'); obj = { name: t.attrs.name || `object ${t.attrs.id}`, verts: [], tris: [], tcol: [], comps: [], pid: t.attrs.pid, pindex: +(t.attrs.pindex || 0) }; objects.set(key(t.attrs.id), obj); break;
        case 'vertex': if (obj) { hold('vertices'); obj.verts.push(+t.attrs.x * k, +t.attrs.y * k, +t.attrs.z * k); } break;
        case 'triangle': if (obj) {
          hold('triangles');
          obj.tris.push(+t.attrs.v1, +t.attrs.v2, +t.attrs.v3);
          const pid = t.attrs.pid ?? obj.pid, pi = t.attrs.p1 !== undefined ? +t.attrs.p1 : obj.pindex;
          const g = pid !== undefined ? mats.get(key(pid)) : undefined;
          let c = g ? g[pi] || null : null;
          // (a corner with no p2 / p3 takes p1, as the core spec says)
          if (c && g.perCorner && (t.attrs.p2 !== undefined || t.attrs.p3 !== undefined)) {
            const corner = (p) => (p === undefined ? c : g[+p] || c);
            const c2 = corner(t.attrs.p2), c3 = corner(t.attrs.p3);
            c = [0, 1, 2].map((q) => (c[q] + c2[q] + c3[q]) / 3);
          }
          obj.tcol.push(c);
        } break;
        // (path: the production extension's p:path, the prefix dropped by the walker)
        case 'component': if (obj) { hold('parts and placements'); want(t.attrs.path); obj.comps.push({ id: key(t.attrs.objectid, t.attrs.path ?? null), m: mat3mf(t.attrs.transform, k) }); } break;
        case 'item': if (isRoot) { hold('parts and placements'); want(t.attrs.path); build.push({ id: key(t.attrs.objectid, t.attrs.path ?? null), m: mat3mf(t.attrs.transform, k) }); } break;
        default:
      }
      return false;
    });
  };
  await readPart(path, true);
  while (partsWanted.length) { const p = partsWanted.shift(); if (!partsRead.has(partKey(p))) await readPart(p, false); }
  if (unit === null) unit = 'millimeter';
  // an object's key in words: its id, and its part when that is not the root
  const said = (key) => {
    const at = key.lastIndexOf('#');
    const pk = key.slice(0, at), id = key.slice(at + 1);
    return pk === rootKey ? id : `${id} in ${partsMissing.get(pk) ?? `/${pk}`}`;
  };
  // the component tree counted before it is built: a missing object, a cycle or a tree over 32
  // deep is a damaged file (they were dropped without a word), and a shared object placed past
  // the caps is refused (each object holding two of the next, 30 deep, ran the tab out of memory)
  placements(build.map((it) => it.id), (id, from) => {
    const o = objects.get(id);
    if (!o) throw new Error(`${who} is damaged: ${from === null ? 'its build' : `object ${said(from)}`} names object ${said(id)}, which is not there`);
    return o.comps.map((c) => c.id);
  }, (id) => { const o = objects.get(id); return { tris: o.tris.length / 3, verts: o.tris.length ? o.verts.length / 3 : 0 }; }, 32,
  (why, id) => new Error(why === 'cycle' ? `${who} is damaged: object ${said(id)} is its own ancestor` : `${who} is damaged: its component tree is more than 32 deep`), who);
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
      // a mirroring placement (the 3x3's determinant negative) flips the winding back, as the
      // glTF reader does: kept, every normal of a mirrored part pointed inward
      let tri = o.tris;
      if (det3x3(m) < 0) {
        tri = o.tris.slice();
        for (let t = 0; t < tri.length; t += 3) [tri[t + 1], tri[t + 2]] = [tri[t + 2], tri[t + 1]];
      }
      const cs = new Set(o.tcol.map((c) => (c ? c.join(',') : '')));
      const one = cs.size === 1;
      n.meshes.push(bodies.length);
      bodies.push({ name: o.name, pos, tri, color: one ? o.tcol[0] : null, col: one ? null : o.tcol.map((c) => c || DEFAULT_GREY) });
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
// the determinant of a row-vector 3x4's 3x3 (negative: the placement mirrors)
const det3x3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
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
const COMP_NAME = { 5120: 'byte', 5121: 'unsigned byte', 5122: 'short', 5123: 'unsigned short', 5125: 'unsigned int', 5126: 'float' };
// The one home of the accessor-type rule: the accessor types and [component type, normalized]
// pairs each use may have, exactly as the tables list them -- glTF 2.0 3.7.2.1 (POSITION, NORMAL
// float32; COLOR_n VEC3/VEC4 float32, unorm8, unorm16; indices uint8, uint16, uint32), with the
// extra types of KHR_mesh_quantization's "Extending Mesh Attributes" table (POSITION every
// (u)byte/(u)short, normalized or not; NORMAL byte or short normalized) and the
// EXT_mesh_gpu_instancing attribute table (TRANSLATION and SCALE float only; ROTATION float, byte
// normalized, short normalized). Normalized: true (must be), false (must not be: a float, glTF
// 2.0 3.6.2.1, or an integer the table lists plain), null (either). (A byte ROTATION without
// "normalized" was read as a raw quaternion: a part 16,200 times its size, sheared.)
// The caps count an accessor's elements as what its use builds (a vertex, an index, an
// instance), so a use given another type built count x components: a MAT4 index accessor counted
// 1.9 M triangles and built 16 times that (825 bytes placed 3 times: 11.1 s and 3.68 GB).
const FLOAT = [5126, false];
const ACC_USE = {
  POSITION: [['VEC3'], [FLOAT, [5120, null], [5121, null], [5122, null], [5123, null]]],
  NORMAL: [['VEC3'], [FLOAT, [5120, true], [5122, true]]],
  COLOR_0: [['VEC3', 'VEC4'], [FLOAT, [5121, true], [5123, true]]],
  indices: [['SCALAR'], [[5121, false], [5123, false], [5125, false]]],
  TRANSLATION: [['VEC3'], [FLOAT]],
  ROTATION: [['VEC4'], [FLOAT, [5120, true], [5122, true]]],
  SCALE: [['VEC3'], [FLOAT]],
};
// an accessor's "normalized", one reading for the type check and the read alike
const isNorm = (a) => a.normalized === true;
const orList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}` : xs[0]);
// the primitive modes drawn: TRIANGLES, TRIANGLE_STRIP, TRIANGLE_FAN (points and lines are not)
const TRI_MODES = [4, 5, 6];
// the extensions a file may require: KHR_mesh_quantization (integer and normalized attributes
// are read, and its dequantization is the node transform, baked in) and EXT_mesh_gpu_instancing
// (each instance placed); every other is refused by name, compression in its own words
const GLTF_EXTENSIONS_READ = ['KHR_mesh_quantization', 'EXT_mesh_gpu_instancing'];
const GLTF_COMPRESSION = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'];
const INSTANCING = 'EXT_mesh_gpu_instancing';
const INSTANCE_USES = ['TRANSLATION', 'ROTATION', 'SCALE'];

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
  // its refusals name the file as the other readers do: name and extension
  const file = `${base}.${format}`;
  const damaged = (what) => new Error(`${file} is damaged: ${what}`);
  if (!json) throw damaged('it holds no glTF JSON');
  // the JSON's shapes are checked where they are used: a list that is not one, or an index to
  // an entry that is not an object, is a damaged file, not the engine's "is not a function"
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(json)) throw damaged('its JSON is not an object');
  const list = (x, what) => { if (x === undefined) return []; if (!Array.isArray(x)) throw damaged(`${what} is not a list`); return x; };
  const at = (arr, i) => (Number.isInteger(i) && i >= 0 && i < arr.length && isObj(arr[i]) ? arr[i] : null);
  const nat = (x) => Number.isInteger(x) && x >= 0;
  // accessor ai as use (an ACC_USE key) at where ("mesh 0 primitive 1"): refused in words when it
  // is not there, or its type, component type or normalized is not one that use may have
  const shown = (x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x)).slice(0, 40);
  const useType = (where, use, ai) => {
    const a = at(accessors, ai);
    if (!a) throw damaged(`${where}'s ${use} accessor ${shown(ai)} is not there`);
    const [types, comps] = ACC_USE[use];
    const nz = isNorm(a);
    if (types.includes(a.type) && comps.some(([c, n]) => c === a.componentType && (n === null || n === nz))) return a;
    const ct = Object.hasOwn(COMP_NAME, a.componentType) ? COMP_NAME[a.componentType] : `component type ${shown(a.componentType)}`;
    const may = comps.map(([c, n]) => `${n ? 'normalized ' : ''}${COMP_NAME[c]}`);
    throw damaged(`${where}'s ${use} accessor ${ai} is ${shown(a.type)} of ${nz ? 'normalized ' : ''}${ct}; ${use} must be ${orList(types)} of ${orList(may)}`);
  };
  // a required extension the reader does not read is refused by name (glTF 2.0 3.12: a loader
  // must not load such an asset; ignored, an instanced part opened as one copy without a word).
  // Compression keeps its own words, since the fix is the same for each.
  const required = list(json.extensionsRequired, '"extensionsRequired"');
  const packed = required.filter((x) => GLTF_COMPRESSION.includes(x));
  if (packed.length) throw new Error(`${file} needs ${packed.join(', ')}, which this viewer does not decode: export it without compression`);
  const unread = required.filter((x) => !GLTF_EXTENSIONS_READ.includes(x)).map((x) => String(x).slice(0, 80));
  if (unread.length) throw new Error(`${file} needs the glTF extension${unread.length > 1 ? 's' : ''} ${unread.join(', ')}, which this viewer does not read`);
  const accessors = list(json.accessors, '"accessors"'), views = list(json.bufferViews, '"bufferViews"');
  const nodes = list(json.nodes, '"nodes"'), meshDefs = list(json.meshes, '"meshes"');
  const buffers = await Promise.all(list(json.buffers, '"buffers"').map(async (b, i) => {
    if (!isObj(b)) throw damaged(`buffer ${i} is not an object`);
    if (b.uri === undefined) { if (i === 0 && bin) return bin; throw damaged(`buffer ${i} has no data`); }
    if (typeof b.uri !== 'string') throw damaged(`buffer ${i}'s uri is not text`);
    // a uri that does not decode (a bad % escape, a data: URI fetch refuses) is a damaged file,
    // not the engine's "URIError: URI malformed" / "TypeError: fetch failed"
    const unread = () => damaged(`buffer ${i}'s uri "${b.uri.length > 80 ? `${b.uri.slice(0, 80)}...` : b.uri}" cannot be read`);
    // (a data: URI decoded by fetch: new Response(uri) gave the URI's own text as the buffer)
    if (b.uri.startsWith('data:')) {
      try { return await (await fetch(b.uri)).arrayBuffer(); } catch { throw unread(); }
    }
    let nm;
    try { nm = decodeURIComponent(b.uri); } catch { throw unread(); }
    const f = companion(files, nm);
    if (!f) throw new Error(`${file} needs ${b.uri}: drop it together with the .${format}`);
    return f;
  }));
  // each accessor read once, however many placements (instances, nodes) use it: a mesh placed
  // 40 times walked its 22 M-colour COLOR_0 40 times. (Its values are not written by a reader.)
  const accRead = new Map();
  const acc = (i) => {
    if (!accRead.has(i)) accRead.set(i, accOnce(i));
    return accRead.get(i);
  };
  const accOnce = (i) => {
    const a = at(accessors, i);
    if (!a || !Object.hasOwn(COMP, a.componentType) || !Object.hasOwn(NCOMP, a.type) || !nat(a.count)) throw damaged(`accessor ${i} is missing or malformed`);
    const [Ctor, max] = COMP[a.componentType];
    const nc = NCOMP[a.type];
    // the count is bounded before anything is allocated: by a cap, then by its buffer view
    // (2^30 vertices with no buffer view ran the tab out of memory from a 200-byte file)
    if (a.count * nc > MAX_ACCESSOR_VALUES) throw new Error(`${file}: accessor ${i} holds ${big(a.count * nc)} values, more than the ${big(MAX_ACCESSOR_VALUES)} this viewer reads`);
    // with neither a buffer view nor sparse values every element is zero (glTF 2.0 3.6.2.1): it
    // holds no geometry, so null is returned in place of the zeros (a 199-byte file of 30 M zero
    // vertices was allocated and walked, 9.3 s and 1 GB, to reach "has no triangles")
    if (a.bufferView === undefined && a.sparse === undefined) return null;
    const out = a.bufferView === undefined ? new Float64Array(a.count * nc)
      : readView(a.bufferView, a.byteOffset, Ctor, nc, a.count, true, `accessor ${i}`, isNorm(a) && max);
    // a sparse accessor: its listed elements replaced by its values, over the view or zeros
    // (glTF 2.0 3.6.2.3; ignored, a valid sparse triangle opened as nothing without a word)
    if (a.sparse !== undefined) {
      const sp = a.sparse;
      if (!isObj(sp) || !isObj(sp.indices) || !isObj(sp.values)) throw damaged(`accessor ${i}'s "sparse" is malformed`);
      if (!Number.isInteger(sp.count) || sp.count < 1 || sp.count > a.count) throw damaged(`accessor ${i}'s sparse count ${sp.count} is not 1 to its ${a.count} elements`);
      const IDX = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array }[sp.indices.componentType];
      if (!IDX) throw damaged(`accessor ${i}'s sparse indices have component type ${sp.indices.componentType}, which is not an unsigned integer type`);
      const ix = readView(sp.indices.bufferView, sp.indices.byteOffset, IDX, 1, sp.count, false, `accessor ${i}'s sparse indices`, 0);
      const vals = readView(sp.values.bufferView, sp.values.byteOffset, Ctor, nc, sp.count, false, `accessor ${i}'s sparse values`, isNorm(a) && max);
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
    // (glTF 2.0 3.6.2.4: a byteStride is 4 to 252 and a multiple of 4; a stride of 1 let a
    // 21 MB file hold a 22 M-element colour list)
    const st = bv.byteStride;
    if (st !== undefined && !(Number.isInteger(st) && st >= 4 && st <= 252 && st % 4 === 0)) {
      throw damaged(`buffer view ${vi} has a byteStride of ${typeof st === 'number' ? st : JSON.stringify(st)?.slice(0, 40)}, not a multiple of 4 from 4 to 252`);
    }
    const stride = (strided && st) || size * nc;
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
  // each material's LINEAR colour: baseColorFactor (linear), times its base texture's linear
  // average when it has one and the image can be decoded here. Products are taken in linear
  // space and made sRGB (the viewer's colours) last: srgb(factor x texture x COLOR_0).
  // Worked out (below, once the node tree is counted) only for the materials a drawn primitive
  // names, one after another, each image decoded once however many materials name it.
  const materials = list(json.materials, '"materials"');
  if (materials.length > MAX_MATERIALS) throw tooMany(file, 'materials', MAX_MATERIALS);
  const matsUsed = new Set(); // material indices a drawn primitive names
  const matLinear = new Map(); // material index -> linear colour, or null
  const imageAvg = new Map(); // image index -> linear average, or null
  const linearOf = async (mi) => {
    const mat = materials[mi];
    const pbr = (isObj(mat) && isObj(mat.pbrMetallicRoughness) && mat.pbrMetallicRoughness) || {};
    // (glTF 2.0: 4 numbers. Any array was sliced to 3 and written to the .cadmesh, whose decode
    // refused it in its own words, or opened [null, 0, 0, 1] black)
    const bf = pbr.baseColorFactor;
    if (bf !== undefined && !(Array.isArray(bf) && bf.length === 4 && bf.every((x) => typeof x === 'number' && Number.isFinite(x)))) {
      throw damaged(`material ${mi}'s baseColorFactor is not 4 numbers`);
    }
    const f = bf === undefined ? null : bf.slice(0, 3);
    const tx = isObj(pbr.baseColorTexture) && Array.isArray(json.textures) ? json.textures[pbr.baseColorTexture.index] : undefined;
    const si = isObj(tx) && Number.isInteger(tx.source) ? tx.source : null;
    if (si === null) return f;
    if (!imageAvg.has(si)) imageAvg.set(si, await imageAverage(json, buffers, si, files));
    const tex = imageAvg.get(si);
    if (!tex) return f;
    return (f || [1, 1, 1]).map((c, k) => c * tex[k]);
  };
  // a node's EXT_mesh_gpu_instancing: null (none, or no mesh to place), else { count, attrs }
  const instancing = (ni) => {
    const nd = nodes[ni];
    const ex = isObj(nd.extensions) ? nd.extensions[INSTANCING] : undefined;
    if (ex === undefined || nd.mesh === undefined) return null;
    if (!isObj(ex) || !isObj(ex.attributes)) throw damaged(`node ${ni}'s ${INSTANCING} has no attributes`);
    let count = null;
    for (const k of INSTANCE_USES) {
      if (ex.attributes[k] === undefined) continue;
      const a = useType(`node ${ni}'s ${INSTANCING}`, k, ex.attributes[k]);
      if (!nat(a.count)) throw damaged(`node ${ni}'s ${INSTANCING} ${k} accessor ${ex.attributes[k]} has no count`);
      if (count !== null && a.count !== count) throw damaged(`node ${ni}'s ${INSTANCING} attributes count ${count} and ${a.count} instances`);
      count = a.count;
    }
    if (count === null) throw damaged(`node ${ni}'s ${INSTANCING} has no attributes`);
    return { count, attrs: ex.attributes };
  };
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
  // (each accessor a primitive uses is held to its use's types here, before anything is read or
  // counted: see ACC_USE)
  const meshCounts = (mi) => {
    const me = at(meshDefs, mi);
    let tris = 0, verts = 0;
    (me && Array.isArray(me.primitives) ? me.primitives : []).forEach((pr, k) => {
      if (!isObj(pr) || !TRI_MODES.includes(pr.mode ?? 4)) return;
      if (Number.isInteger(pr.material) && pr.material >= 0 && pr.material < materials.length) matsUsed.add(pr.material);
      const where = `mesh ${mi} primitive ${k + 1}`;
      const attrs = isObj(pr.attributes) ? pr.attributes : {};
      const p = attrs.POSITION !== undefined ? useType(where, 'POSITION', attrs.POSITION) : null;
      for (const u of ['NORMAL', 'COLOR_0']) if (attrs[u] !== undefined) useType(where, u, attrs[u]);
      const a = pr.indices !== undefined ? useType(where, 'indices', pr.indices) : p;
      // counted as built: every value the accessor holds (count x components), a vertex per 3
      // POSITION values and a corner per index value
      const corners = !a || !nat(a.count) ? 0 : a === p ? a.count * NCOMP[a.type] / 3 : a.count * NCOMP[a.type];
      // a list: a triangle per 3 corners; a strip or fan: one per corner past the second
      tris += (pr.mode ?? 4) === 4 ? Math.floor(corners / 3) : Math.max(0, corners - 2);
      if (p && nat(p.count)) verts += p.count * NCOMP[p.type] / 3;
    });
    return { tris, verts };
  };
  placements(roots, (ni) => {
    const nd = at(nodes, ni);
    if (!nd) throw damaged(`node ${ni} is not there`);
    return list(nd.children, `node ${ni}'s "children"`);
  }, (ni) => {
    if (nodes[ni].mesh === undefined) return { tris: 0, verts: 0 };
    const c = meshCounts(nodes[ni].mesh), ins = instancing(ni);
    // (each instance is a part of its own and a copy of the mesh)
    return ins ? { tris: c.tris * ins.count, verts: c.verts * ins.count, parts: ins.count } : c;
  }, 64,
  (why, ni) => damaged(why === 'cycle' ? `node ${ni} is its own ancestor` : 'its node tree is more than 64 deep'), file);
  // (in sequence: one image decoded at a time, not every material's at once)
  for (const mi of matsUsed) matLinear.set(mi, await linearOf(mi));
  const bodies = [];
  // a name is taken only when it is text, else the default (glTF 2.0 makes "name" a string; one
  // of 42 was written into the .cadmesh and refused there as "cadmesh: mesh 0 name is not text")
  const textName = (x) => (typeof x === 'string' && x ? x : null);
  const nodeOf = (ni, parent) => {
    const nd = nodes[ni];
    const m = mul4(parent, localMatrix(nd, (k, n) => damaged(`node ${ni}'s "${k}" is not a list of ${n} numbers`)));
    const n = { name: textName(nd.name) || `node ${ni}`, meshes: [], children: [] };
    // the node's mesh placed by m into target's meshes (once, or once per instance)
    const emit = (target, m) => {
      const me = at(meshDefs, nd.mesh);
      if (!me) throw damaged(`node ${ni} names mesh ${nd.mesh}, which is not there`);
      list(me.primitives, `mesh ${nd.mesh}'s "primitives"`).forEach((pr, k) => {
        if (!isObj(pr)) throw damaged(`mesh ${nd.mesh} primitive ${k + 1} is not an object`);
        const mode = pr.mode ?? 4;
        if (!TRI_MODES.includes(mode)) return; // points and lines: not drawn
        if (pr.extensions && (pr.extensions.KHR_draco_mesh_compression)) throw new Error(`${file} uses Draco compression, which this viewer does not decode`);
        if (!isObj(pr.attributes)) throw damaged(`mesh ${nd.mesh} primitive ${k + 1} has no attributes`);
        const P = acc(pr.attributes.POSITION);
        const I = pr.indices !== undefined ? acc(pr.indices) : undefined;
        const meName = textName(me.name) || n.name;
        const name = me.primitives.length > 1 ? `${meName} ${k + 1}` : meName;
        // all-zero positions (every vertex at one point) or all-zero indices (every corner vertex
        // 0): each triangle has no area, so the primitive is an empty body, as one whose every
        // triangle the weld collapses
        if (P === null || I === null) {
          target.meshes.push(bodies.length);
          bodies.push({ name, pos: [], tri: [], color: null });
          return;
        }
        const nv = P.length / 3;
        const pos = new Array(nv * 3);
        for (let v = 0; v < nv; v++) {
          const [x, y, z] = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
          // metres to mm
          pos[v * 3] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * 1000;
          pos[v * 3 + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * 1000;
          pos[v * 3 + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * 1000;
        }
        let idx = I !== undefined ? Array.from(I) : Array.from({ length: nv }, (_, i) => i);
        // a strip or fan expanded to a list (glTF 2.0 3.7.2.1): strip triangle i is
        // {p_i, p_i+(1+i%2), p_i+(2-i%2)} (every other one turned, so all wind alike), fan
        // triangle i {p_i+1, p_i+2, p_0}; counted against the caps above as count - 2
        if (mode !== 4) {
          const list = new Array(Math.max(0, idx.length - 2) * 3);
          for (let i = 0; i + 2 < idx.length; i++) {
            if (mode === 5) { list[i * 3] = idx[i]; list[i * 3 + 1] = idx[i + 1 + (i % 2)]; list[i * 3 + 2] = idx[i + 2 - (i % 2)]; }
            else { list[i * 3] = idx[i + 1]; list[i * 3 + 1] = idx[i + 2]; list[i * 3 + 2] = idx[0]; }
          }
          idx = list;
        }
        // a mirroring transform flips the winding back
        if (det3(m) < 0) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
        const lin = matLinear.get(pr.material) || null;
        const body = { name, pos, tri: idx, color: lin ? linearToSrgb(lin) : null };
        // COLOR_0 (linear; VEC3 or VEC4, float or normalized ubyte / ushort): each triangle the
        // mean of its corners, times the material's colour, made sRGB
        if (pr.attributes.COLOR_0 !== undefined) {
          // (its type held to ACC_USE.COLOR_0 by meshCounts, which every drawn primitive passed)
          const ca = accessors[pr.attributes.COLOR_0];
          const cn = NCOMP[ca.type];
          // (one per vertex, as glTF 2.0 3.7.2.1 requires of every attribute: a longer list was
          // accepted, and its surplus walked for every placement)
          if (ca.count !== nv) throw damaged(`mesh ${nd.mesh} primitive ${k + 1}'s COLOR_0 holds ${ca.count} colours for its ${nv} vertices (it should hold one per vertex)`);
          const CV = acc(pr.attributes.COLOR_0); // (null: no buffer view, every colour 0)
          // (an integer colour is normalized, ACC_USE.COLOR_0: read as a fraction by acc)
          const f = lin || [1, 1, 1];
          const ch = (v, q) => (CV ? CV[v * cn + q] : 0);
          const col = new Array(idx.length / 3);
          let same = true;
          for (let t = 0; t < col.length; t++) {
            const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
            col[t] = linearToSrgb([0, 1, 2].map((q) => ((ch(a, q) + ch(b, q) + ch(c, q)) / 3) * f[q]));
            if (t && same && (col[t][0] !== col[0][0] || col[t][1] !== col[0][1] || col[t][2] !== col[0][2])) same = false;
          }
          if (col.length && same) body.color = col[0];
          else if (col.length) { body.color = null; body.col = col; }
        }
        target.meshes.push(bodies.length);
        bodies.push(body);
      });
    };
    if (nd.mesh !== undefined) {
      const ins = instancing(ni);
      if (!ins) emit(n, m);
      else {
        // EXT_mesh_gpu_instancing: instance j is placed by its own TRS, then by the node's
        // transform (world = node x instance); each instance a part of its own under the node.
        // (An attribute with no buffer view is all zeros (glTF 2.0 3.6.2.1): a translation or
        // scale of zeros is kept, a rotation of zeros is no quaternion and is taken as none)
        const val = (k) => (ins.attrs[k] !== undefined ? acc(ins.attrs[k]) : null);
        const T = val('TRANSLATION'), R = val('ROTATION'), S = val('SCALE');
        const noS = ins.attrs.SCALE === undefined;
        const bad = (k, c) => damaged(`node ${ni}'s ${INSTANCING} ${k} is not a list of ${c} numbers`);
        for (let j = 0; j < ins.count; j++) {
          const trs = {
            translation: T ? [T[j * 3], T[j * 3 + 1], T[j * 3 + 2]] : [0, 0, 0],
            rotation: R ? [R[j * 4], R[j * 4 + 1], R[j * 4 + 2], R[j * 4 + 3]] : [0, 0, 0, 1],
            scale: S ? [S[j * 3], S[j * 3 + 1], S[j * 3 + 2]] : noS ? [1, 1, 1] : [0, 0, 0],
          };
          const ch = { name: `${n.name} instance ${j + 1}`, meshes: [], children: [] };
          emit(ch, mul4(m, localMatrix(trs, bad)));
          n.children.push(ch);
        }
      }
    }
    for (const c of nd.children || []) n.children.push(nodeOf(c, m));
    return n;
  };
  const root = { name: base, meshes: [], children: roots.map((ni) => nodeOf(ni, IDENT)) };
  checkBodies(file, bodies);
  const meshes = bodies.map(weld);
  needTriangles(file, meshes);
  return { units: MM, meshes, root, sourceUnits: 'm' };
}
// An image's average colour (LINEAR, 0..1), or null where the image cannot be
// decoded here (no createImageBitmap / OffscreenCanvas: Node, an old browser)
// or is not found. The image is drawn at 32 x 32 and its pixels (sRGB, as glTF
// base colour textures are) averaged in linear light, weighted by alpha.
const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
async function imageAverage(json, buffers, si, files) {
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
    const img = Array.isArray(json.images) ? json.images[si] : null;
    if (!img) return null;
    let blob;
    if (img.bufferView !== undefined) {
      const bv = json.bufferViews[img.bufferView];
      blob = new Blob([new Uint8Array(buffers[bv.buffer], bv.byteOffset || 0, bv.byteLength)], { type: img.mimeType || 'image/png' });
    } else if (img.uri && img.uri.startsWith('data:')) blob = await (await fetch(img.uri)).blob();
    else if (img.uri) {
      const f = companion(files, decodeURIComponent(img.uri));
      if (!f) return null;
      blob = new Blob([f]);
    } else return null;
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(32, 32);
    const cx = cv.getContext('2d');
    cx.drawImage(bmp, 0, 0, 32, 32);
    const px = cx.getImageData(0, 0, 32, 32).data;
    let r = 0, g = 0, b = 0, w = 0;
    const L = SRGB_TO_LINEAR;
    for (let i = 0; i < px.length; i += 4) { const a = px[i + 3] / 255; r += L[px[i]] * a; g += L[px[i + 1]] * a; b += L[px[i + 2]] * a; w += a; }
    return w ? [r / w, g / w, b / w] : null;
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
  // the quaternion made unit length before use: a quantized one (normalized bytes [0, 0, 90, 90]
  // are 1.0022 long) scaled the part by its squared length, 1000 mm to 1004 mm. (Zero length,
  // or not numbers: left as it is.)
  const q = v('rotation', 4, [0, 0, 0, 1]);
  const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const [qx, qy, qz, qw] = q.map((x) => x / ql);
  const [sx, sy, sz] = v('scale', 3, [1, 1, 1]);
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, tx, ty, tz, 1];
}
const det3 = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
// glTF colours are linear; the viewer's are sRGB
const linearToSrgb = (f) => f.slice(0, 3).map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
