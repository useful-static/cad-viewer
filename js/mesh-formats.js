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

export const MESH_EXTS = ['stl', 'obj', 'ply', 'off', '3mf', 'glb', 'gltf'];
const CREASE_DEG = 30;

// The mesh format a file is, by its name and first bytes, or null
export function meshFormatOf(name, buf) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1]?.toLowerCase();
  const u8 = new Uint8Array(buf, 0, Math.min(buf.byteLength, 64));
  const head = new TextDecoder('latin1').decode(u8);
  if (head.startsWith('glTF')) return 'glb';
  if (head.startsWith('PK\x03\x04') && ext === '3mf') return '3mf';
  if (/^ply\r?\n/.test(head)) return 'ply';
  if (/^\s*[CN]?OFF\b/.test(head) && ext === 'off') return 'off';
  if (ext === 'stl') return 'stl';
  if (ext && MESH_EXTS.includes(ext)) return ext;
  return null;
}

// A model from a mesh file. files: other dropped files by lower-case name
// (an OBJ's .mtl, a .gltf's .bin). Throws in plain words on what it refuses.
export async function parseMesh(format, buf, name, files = new Map()) {
  const base = (name || 'model').replace(/\.[^.]+$/, '');
  switch (format) {
    case 'stl': return finish(base, parseSTL(buf, base), null);
    case 'obj': return finish(base, parseOBJ(text(buf), files, base), null);
    case 'ply': return finish(base, parsePLY(buf, base), null);
    case 'off': return finish(base, parseOFF(text(buf), base), null);
    case '3mf': return parse3MF(buf, base);
    case 'glb': case 'gltf': return parseGLTF(buf, format, base, files);
    default: throw new Error(`${name}: not a mesh format this viewer reads`);
  }
}

const text = (buf) => new TextDecoder().decode(buf);

// raw bodies [{ name, pos: number[], tri: number[], col?: [r,g,b] per
// triangle or null, color }] -> the encodeCadmesh model, one tree node
function finish(rootName, bodies, sourceUnits, root = null) {
  const meshes = bodies.filter((b) => b.tri.length).map(weld);
  if (!meshes.length) throw new Error(`${rootName} has no triangles to show`);
  const model = { units: 'mm', meshes, root: root || { name: rootName, meshes: meshes.map((_, i) => i), children: [] } };
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
  // per welded vertex: its groups [{ n: unit seed, s: [sum], col, out }]
  const groups = new Array(wp.length / 3);
  const corner = new Uint32Array(kept * 3); // the group (output vertex) each corner uses
  const outPos = [], outNrmSum = [], outCol = [];
  const cols = b.col ? colKept : null;
  for (let t = 0; t < kept; t++) {
    const n = unit(fn[t * 3], fn[t * 3 + 1], fn[t * 3 + 2]);
    const ck = cols ? cols[t].join(',') : '';
    for (let c = 0; c < 3; c++) {
      const w = tri[t * 3 + c];
      const gs = groups[w] || (groups[w] = []);
      let g = gs.find((x) => x.ck === ck && x.n[0] * n[0] + x.n[1] * n[1] + x.n[2] * n[2] >= cosC);
      if (!g) {
        g = { n, ck, out: outPos.length / 3 };
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
  const s = text(buf);
  if (!/^\s*solid/.test(s)) throw new Error(`${base}.stl is neither a binary STL (its size does not match its triangle count) nor an ASCII one`);
  const bodies = [];
  let cur = null;
  const re = /^\s*(solid|endsolid|vertex|endfacet)\b(.*)$/gm;
  let m;
  let fv = [];
  while ((m = re.exec(s))) {
    if (m[1] === 'solid') { cur = { name: m[2].trim() || base, pos: [], tri: [] }; bodies.push(cur); }
    else if (m[1] === 'vertex') { if (!cur) { cur = { name: base, pos: [], tri: [] }; bodies.push(cur); } fv.push(...m[2].trim().split(/\s+/).slice(0, 3).map(Number)); }
    else if (m[1] === 'endfacet') {
      // a facet of more than 3 vertices: a fan
      const k0 = cur.pos.length / 3;
      cur.pos.push(...fv);
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
        if (t) readMTL(text(t), mtl);
      }
    } else if (k === 'usemtl') mat = sp.slice(1).join(' ');
    else if (k === 'f') {
      if (!cur) start(base);
      const ids = sp.slice(1).map((x) => { const i = parseInt(x, 10); return i < 0 ? v.length / 3 + i : i - 1; });
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
    else b.col = b.col.map((c) => c || [0.72, 0.74, 0.78]);
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
      if (sp[1] === 'list') e.props.push({ list: true, ct: PLY_T[sp[2]], t: PLY_T[sp[3]], name: sp[4] });
      else e.props.push({ t: PLY_T[sp[1]], name: sp[2] });
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
  if (fmt === 'ascii') {
    const toks = new TextDecoder('latin1').decode(u8.subarray(bodyStart)).trim().split(/\s+/);
    let p = 0;
    for (const e of els) {
      for (let i = 0; i < e.n; i++) {
        const rec = {};
        for (const pr of e.props) {
          if (pr.list) { const c = +toks[p++]; rec[pr.name] = toks.slice(p, p + c).map(Number); p += c; } else rec[pr.name] = +toks[p++];
        }
        take(e, rec);
      }
    }
  } else {
    const le = fmt === 'binary_little_endian';
    if (!le && fmt !== 'binary_big_endian') throw new Error(`${base}.ply: format ${fmt} is not ascii or binary`);
    const dv = new DataView(buf);
    let o = bodyStart;
    const rd = (t) => { const v = dv[`get${t}`](o, le); o += PLY_SIZE[t]; return v; };
    for (const e of els) {
      for (let i = 0; i < e.n; i++) {
        const rec = {};
        for (const pr of e.props) {
          if (pr.list) { const c = rd(pr.ct); const a = new Array(c); for (let j = 0; j < c; j++) a[j] = rd(pr.t); rec[pr.name] = a; } else rec[pr.name] = rd(pr.t);
        }
        take(e, rec);
      }
    }
  }
  const body = { name: base, pos, tri };
  if (hasCol) {
    // vertex colours (0-255) become each triangle's mean, so the weld keeps them
    const scale = Math.max(...vcol.filter(Boolean).flat()) > 1 ? 255 : 1;
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
  const pos = [];
  for (let i = 0; i < nv; i++) { pos.push(+toks[p], +toks[p + 1], +toks[p + 2]); p += 3; }
  const tri = [], col = [];
  let anyCol = false;
  for (let i = 0; i < nf; i++) {
    const c = +toks[p++];
    const ids = toks.slice(p, p + c).map(Number);
    p += c;
    // an optional colour to the end of the line is not separable from the next
    // face once split on whitespace: OFF colours are left out
    for (let k = 1; k + 1 < ids.length; k++) { tri.push(ids[0], ids[k], ids[k + 1]); col.push(null); }
  }
  if (!Number.isFinite(nv) || !Number.isFinite(nf)) throw new Error(`${base}.off: not an OFF file (no vertex and face counts)`);
  return [{ name: base, pos, tri, col: anyCol ? col : null }];
}

// ---------- 3MF ----------
// A zip's entries: { names (as stored), has(path), get(path) -> ArrayBuffer }
// (stored or deflated; paths matched without case or a leading /)
export async function unzip(buf) {
  const dv = new DataView(buf);
  // the end of central directory record, searched back from the end
  let e = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('not a zip file (no central directory)');
  const n = dv.getUint16(e + 10, true);
  let o = dv.getUint32(e + 16, true);
  if (o === 0xffffffff || n === 0xffff) throw new Error('a zip64 archive, which this viewer does not read');
  const out = new Map();
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(o, true) !== 0x02014b50) throw new Error('a damaged zip central directory');
    const method = dv.getUint16(o + 10, true);
    const csize = dv.getUint32(o + 20, true);
    const nlen = dv.getUint16(o + 28, true), xlen = dv.getUint16(o + 30, true), clen = dv.getUint16(o + 32, true);
    const lho = dv.getUint32(o + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, o + 46, nlen));
    o += 46 + nlen + xlen + clen;
    const lnl = dv.getUint16(lho + 26, true), lxl = dv.getUint16(lho + 28, true);
    const data = new Uint8Array(buf, lho + 30 + lnl + lxl, csize);
    out.set(name.replace(/^\//, '').toLowerCase(), { method, data, name });
  }
  return {
    names: [...out.values()].map((f) => f.name),
    has: (p) => out.has(p.replace(/^\//, '').toLowerCase()),
    async get(p) {
      const f = out.get(p.replace(/^\//, '').toLowerCase());
      if (!f) return null;
      if (f.method === 0) return f.data.slice().buffer;
      if (f.method !== 8) throw new Error(`zip entry ${p} uses compression method ${f.method}`);
      if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot unpack a deflated zip entry');
      const s = new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(s).arrayBuffer();
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

const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const UNIT_NAME = { micron: 'um', millimeter: 'mm', centimeter: 'cm', inch: 'in', foot: 'ft', meter: 'm' };

async function parse3MF(buf, base) {
  const zip = await unzip(buf);
  let path = '3D/3dmodel.model';
  const rels = await zip.get('_rels/.rels');
  if (rels) {
    const t = xmlTags(text(rels)).find((x) => x.tag === 'Relationship' && /3dmodel$/.test(x.attrs.Type || ''));
    if (t && t.attrs.Target) path = t.attrs.Target;
  }
  const xml = await zip.get(path);
  if (!xml) throw new Error(`${base}.3mf has no model part (${path})`);
  const tags = xmlTags(text(xml));
  const modelTag = tags.find((x) => x.tag === 'model');
  const unit = (modelTag && modelTag.attrs.unit) || 'millimeter';
  const k = UNIT_MM[unit] ?? 1;
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
  const bodies = [];
  const node = (id, m, depth) => {
    const o = objects.get(id);
    if (!o || depth > 32) return null;
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
      bodies.push({ name: o.name, pos, tri: o.tris, color: one ? o.tcol[0] : null, col: one ? null : o.tcol.map((c) => c || [0.72, 0.74, 0.78]) });
    }
    for (const c of o.comps) { const ch = node(c.id, mulAffine(c.m, m), depth + 1); if (ch) n.children.push(ch); }
    return n;
  };
  const root = { name: base, meshes: [], children: [] };
  for (const it of build) { const n = node(it.id, it.m, 0); if (n) root.children.push(n); }
  // (bodies are welded in order, so node mesh indices stay right)
  const meshes = bodies.map(weld);
  if (!meshes.length) throw new Error(`${base}.3mf has no triangles to show`);
  return { units: 'mm', meshes, root, sourceUnits: UNIT_NAME[unit] || undefined };
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

async function parseGLTF(buf, format, base, files) {
  let json, bin = null;
  if (format === 'glb') {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error(`${base}.glb: not a GLB file`);
    let o = 12;
    while (o + 8 <= buf.byteLength) {
      const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, o + 8, len)));
      else if (type === 0x004e4942) bin = buf.slice(o + 8, o + 8 + len);
      o += 8 + len;
    }
  } else json = JSON.parse(text(buf));
  if (!json) throw new Error(`${base}: no glTF JSON`);
  const refused = [...(json.extensionsRequired || [])].filter((x) => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_mesh_quantization'].includes(x));
  if (refused.length) throw new Error(`${base} needs ${refused.join(', ')}, which this viewer does not decode: export it without compression`);
  const buffers = await Promise.all((json.buffers || []).map(async (b, i) => {
    if (b.uri === undefined) { if (i === 0 && bin) return bin; throw new Error(`${base}: buffer ${i} has no data`); }
    if (b.uri.startsWith('data:')) return new Response(b.uri).arrayBuffer();
    const f = files.get(decodeURIComponent(b.uri).split('/').pop().toLowerCase());
    if (!f) throw new Error(`${base}.gltf needs ${b.uri}: drop it together with the .gltf`);
    return f;
  }));
  const acc = (i) => {
    const a = json.accessors[i];
    const [Ctor, max] = COMP[a.componentType];
    const nc = NCOMP[a.type];
    const out = new Float64Array(a.count * nc);
    if (a.bufferView === undefined) return out;
    const bv = json.bufferViews[a.bufferView];
    const bytes = new DataView(buffers[bv.buffer], (bv.byteOffset || 0) + (a.byteOffset || 0));
    const size = Ctor.BYTES_PER_ELEMENT;
    const stride = bv.byteStride || size * nc;
    const get = { 1: (o) => (Ctor === Int8Array ? bytes.getInt8(o) : bytes.getUint8(o)), 2: (o) => (Ctor === Int16Array ? bytes.getInt16(o, true) : bytes.getUint16(o, true)),
      4: (o) => (Ctor === Float32Array ? bytes.getFloat32(o, true) : bytes.getUint32(o, true)) }[size];
    for (let e = 0; e < a.count; e++) {
      for (let c = 0; c < nc; c++) {
        let v = get(e * stride + c * size);
        if (a.normalized && max) v = Math.max(v / max, -1);
        out[e * nc + c] = v;
      }
    }
    return out;
  };
  // each material's colour: baseColorFactor, times its base texture's average
  // colour when it has one and the image can be decoded here
  const matColour = await Promise.all((json.materials || []).map(async (mat) => {
    const pbr = mat.pbrMetallicRoughness || {};
    const f = pbr.baseColorFactor ? linearToSrgb(pbr.baseColorFactor) : null;
    const tex = pbr.baseColorTexture ? await textureAverage(json, buffers, pbr.baseColorTexture.index, files) : null;
    if (!tex) return f;
    return (f || [1, 1, 1]).map((c, k) => c * tex[k]);
  }));
  const bodies = [];
  const nodeOf = (ni, parent, depth) => {
    const nd = json.nodes[ni];
    const m = mul4(parent, localMatrix(nd));
    const n = { name: nd.name || `node ${ni}`, meshes: [], children: [] };
    if (nd.mesh !== undefined && depth < 64) {
      const me = json.meshes[nd.mesh];
      (me.primitives || []).forEach((pr, k) => {
        if ((pr.mode ?? 4) !== 4) return; // points, lines, strips: not drawn
        if (pr.extensions && (pr.extensions.KHR_draco_mesh_compression)) throw new Error(`${base} uses Draco compression, which this viewer does not decode`);
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
          color: pr.material !== undefined ? matColour[pr.material] || null : null });
      });
    }
    for (const c of nd.children || []) n.children.push(nodeOf(c, m, depth + 1));
    return n;
  };
  const scene = json.scenes ? json.scenes[json.scene || 0] : { nodes: (json.nodes || []).map((_, i) => i) };
  const root = { name: base, meshes: [], children: (scene.nodes || []).map((ni) => nodeOf(ni, IDENT, 0)) };
  const meshes = bodies.map(weld);
  if (!meshes.length) throw new Error(`${base} has no triangles to show`);
  return { units: 'mm', meshes, root, sourceUnits: 'm' };
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
function localMatrix(nd) {
  if (nd.matrix) return nd.matrix;
  const [tx, ty, tz] = nd.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = nd.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = nd.scale || [1, 1, 1];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, tx, ty, tz, 1];
}
const det3 = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
// glTF colours are linear; the viewer's are sRGB
const linearToSrgb = (f) => f.slice(0, 3).map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
