// The .cadmesh container: one tessellated CAD assembly, laid out so every
// attribute section uploads to the GPU as-is (WebGPU, WebGL2 and WebGL1 alike).
// A file on disk or the wire may be the gzip of this layout (inflateCadmesh).
//
//   0   'CADM'                 magic
//   4   u32 version (1)
//   8   u32 json byte length J
//   12  J bytes UTF-8 JSON     header (below)
//   ..  zero pad to 8
//   ..  sections, each 8-aligned, offsets relative to the first section
//
// Header JSON:
//   { units, bbox:{min,max}, vertexCount, indexCount,
//     sections:{ position, normal, color, id, index : {offset, byteLength} },
//     meshes:[{ name, color, vtxStart, vtxCount, idxStart, idxCount, bbox }],
//     root:{ name, meshes:[i...], children:[...] } }
//
// Per-vertex sections (vertexCount entries):
//   position float32x3 · normal snorm16x4 (w=0) · color unorm8x4 · id unorm8x4
// id is (mesh index + 1) as little-endian RGBA bytes, so a pick pass writes it
// straight to an RGBA8 target and the read-back bytes ARE the id (0 = nothing).
// index: uint32 triangle list, absolute vertex indices.
//
// Pure ES module, no DOM: imported by the browser viewer, the STEP worker and
// the Node converter.

export const MAGIC = 0x4d444143; // 'CADM' little-endian
export const VERSION = 1;

const SECTIONS = ['position', 'normal', 'color', 'id', 'index'];

const align8 = (n) => (n + 7) & ~7;

export function idToBytes(id) {
  return [id & 255, (id >>> 8) & 255, (id >>> 16) & 255, (id >>> 24) & 255];
}

export function bytesToId(b0, b1, b2, b3) {
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

// model: { units, meshes:[{name, color:[r,g,b]|null, positions:Float32Array,
//          normals:Float32Array|null, colors:Uint8Array(rgba per vertex)|null,
//          indices:Uint32Array (local to the mesh)}], root }
export function encodeCadmesh(model) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const m of model.meshes) {
    vertexCount += m.positions.length / 3;
    indexCount += m.indices.length;
  }
  const position = new Float32Array(vertexCount * 3);
  const normal = new Int16Array(vertexCount * 4);
  const color = new Uint8Array(vertexCount * 4);
  const id = new Uint8Array(vertexCount * 4);
  const index = new Uint32Array(indexCount);

  const bbMin = [Infinity, Infinity, Infinity];
  const bbMax = [-Infinity, -Infinity, -Infinity];
  const metas = [];
  let v0 = 0;
  let i0 = 0;
  model.meshes.forEach((m, mi) => {
    const nv = m.positions.length / 3;
    const ni = m.indices.length;
    position.set(m.positions, v0 * 3);
    const nrm = m.normals && m.normals.length === m.positions.length
      ? m.normals : computeNormals(m.positions, m.indices);
    const mMin = [Infinity, Infinity, Infinity];
    const mMax = [-Infinity, -Infinity, -Infinity];
    const base = m.color || [0.72, 0.74, 0.78];
    const idb = idToBytes(mi + 1);
    for (let v = 0; v < nv; v++) {
      for (let k = 0; k < 3; k++) {
        const p = m.positions[v * 3 + k];
        if (p < mMin[k]) mMin[k] = p;
        if (p > mMax[k]) mMax[k] = p;
        normal[(v0 + v) * 4 + k] = Math.max(-32767, Math.min(32767, Math.round(nrm[v * 3 + k] * 32767)));
      }
      const o = (v0 + v) * 4;
      if (m.colors) {
        color[o] = m.colors[v * 4];
        color[o + 1] = m.colors[v * 4 + 1];
        color[o + 2] = m.colors[v * 4 + 2];
        color[o + 3] = 255;
      } else {
        color[o] = Math.round(base[0] * 255);
        color[o + 1] = Math.round(base[1] * 255);
        color[o + 2] = Math.round(base[2] * 255);
        color[o + 3] = 255;
      }
      id[o] = idb[0]; id[o + 1] = idb[1]; id[o + 2] = idb[2]; id[o + 3] = idb[3];
    }
    for (let i = 0; i < ni; i++) index[i0 + i] = m.indices[i] + v0;
    for (let k = 0; k < 3; k++) {
      if (nv && mMin[k] < bbMin[k]) bbMin[k] = mMin[k];
      if (nv && mMax[k] > bbMax[k]) bbMax[k] = mMax[k];
    }
    metas.push({
      name: m.name || `mesh ${mi + 1}`,
      color: m.color || null,
      vtxStart: v0, vtxCount: nv, idxStart: i0, idxCount: ni,
      bbox: nv ? { min: mMin, max: mMax } : null,
    });
    v0 += nv;
    i0 += ni;
  });

  const arrays = { position, normal, color, id, index };
  const sections = {};
  let off = 0;
  for (const s of SECTIONS) {
    sections[s] = { offset: off, byteLength: arrays[s].byteLength };
    off = align8(off + arrays[s].byteLength);
  }
  const header = {
    units: model.units || 'millimeter',
    bbox: vertexCount ? { min: bbMin, max: bbMax } : null,
    vertexCount, indexCount, sections, meshes: metas,
    root: model.root || { name: 'model', meshes: metas.map((_, i) => i), children: [] },
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const dataStart = align8(12 + json.byteLength);
  const out = new ArrayBuffer(dataStart + off);
  const dv = new DataView(out);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, json.byteLength, true);
  new Uint8Array(out, 12, json.byteLength).set(json);
  for (const s of SECTIONS) {
    new Uint8Array(out, dataStart + sections[s].offset, sections[s].byteLength)
      .set(new Uint8Array(arrays[s].buffer, arrays[s].byteOffset, arrays[s].byteLength));
  }
  return out;
}

// A .cadmesh file may be stored gzip-compressed (RFC 1952): the sections are
// mostly redundant bytes (a 650k-triangle assembly gzips to a sixth), and a
// static host serves application/octet-stream uncompressed. The gzip magic
// tells the two apart, so raw files keep loading. Both directions use the
// platform's Compression Streams (browsers, Node 18+): no bundled inflater.
export function isGzip(buf) {
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  return b.length === 2 && b[0] === 0x1f && b[1] === 0x8b;
}

const pipeBytes = (buf, stream) => new Response(new Blob([buf]).stream().pipeThrough(stream)).arrayBuffer();

// buf -> the raw .cadmesh bytes (buf itself when it is not gzipped)
export async function inflateCadmesh(buf) {
  if (!isGzip(buf)) return buf;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('cadmesh: this file is gzip-compressed, and this browser cannot decompress (no DecompressionStream)');
  }
  try {
    return await pipeBytes(buf, new DecompressionStream('gzip'));
  } catch (e) {
    throw new Error(`cadmesh: the gzip data is corrupt or truncated (${e.message || e})`);
  }
}

// raw .cadmesh bytes -> gzip, for writing a file
export function deflateCadmesh(buf) {
  return pipeBytes(buf, new CompressionStream('gzip'));
}

// Returns { header, position:Float32Array, normal:Int16Array, color:Uint8Array,
//           id:Uint8Array, index:Uint32Array } as views into buf (no copies).
export function decodeCadmesh(buf) {
  if (buf.byteLength < 12) throw new Error('cadmesh: file too short');
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('cadmesh: bad magic (not a .cadmesh file)');
  const ver = dv.getUint32(4, true);
  if (ver !== VERSION) throw new Error(`cadmesh: unsupported version ${ver}`);
  const jlen = dv.getUint32(8, true);
  if (12 + jlen > buf.byteLength) throw new Error('cadmesh: truncated header');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, jlen)));
  const dataStart = align8(12 + jlen);
  const view = (name, Ctor) => {
    const s = header.sections[name];
    if (!s || dataStart + s.offset + s.byteLength > buf.byteLength) {
      throw new Error(`cadmesh: section ${name} out of range (truncated file?)`);
    }
    return new Ctor(buf, dataStart + s.offset, s.byteLength / Ctor.BYTES_PER_ELEMENT);
  };
  validateHeader(header);
  const out = {
    header,
    position: view('position', Float32Array),
    normal: view('normal', Int16Array),
    color: view('color', Uint8Array),
    id: view('id', Uint8Array),
    index: view('index', Uint32Array),
  };
  // An index past the vertex data draws nothing on WebGL2 (INVALID_OPERATION,
  // no error shown) and garbage on WebGPU: refuse it here, loudly.
  const vc = header.vertexCount;
  const idx = out.index;
  for (let i = 0; i < idx.length; i++) {
    if (idx[i] >= vc) throw new Error(`cadmesh: index ${i} names vertex ${idx[i]} of ${vc}`);
  }
  return out;
}

// Reject a header whose tree or mesh ranges do not fit its own counts, BEFORE
// anything uses it: a bad tree used to throw half-way through switching the UI
// to the new model.
function validateHeader(h) {
  const bad = (msg) => { throw new Error(`cadmesh: ${msg}`); };
  const ok = (v) => Number.isInteger(v) && v >= 0;
  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const box = (b) => b && vec3(b.min) && vec3(b.max);
  if (!ok(h.vertexCount) || !ok(h.indexCount)) bad('header vertex/index counts missing or invalid');
  if (h.indexCount % 3) bad('index count is not a whole number of triangles');
  if (h.vertexCount ? !box(h.bbox) : h.bbox !== null) bad('header bounding box malformed');
  // each section must be exactly the size its count implies
  const want = { position: 12 * h.vertexCount, normal: 8 * h.vertexCount, color: 4 * h.vertexCount, id: 4 * h.vertexCount, index: 4 * h.indexCount };
  for (const [s, len] of Object.entries(want)) {
    const sec = h.sections && h.sections[s];
    if (!sec || !ok(sec.offset) || sec.byteLength !== len || sec.offset % 8) bad(`section ${s} does not match the header counts`);
  }
  if (!Array.isArray(h.meshes)) bad('header has no mesh list');
  const n = h.meshes.length;
  for (const [i, m] of h.meshes.entries()) {
    if (!m || !ok(m.vtxStart) || !ok(m.vtxCount) || !ok(m.idxStart) || !ok(m.idxCount)
      || m.vtxStart + m.vtxCount > h.vertexCount || m.idxStart + m.idxCount > h.indexCount) {
      bad(`mesh ${i} range is outside the vertex/index data`);
    }
    if (m.vtxCount ? !box(m.bbox) : !(m.bbox === null || box(m.bbox))) bad(`mesh ${i} bounding box malformed`);
  }
  const seen = new Set();
  const walk = (node, depth) => {
    if (depth > 256) bad('assembly tree deeper than 256 levels (cycle?)');
    if (!node || !Array.isArray(node.meshes) || !Array.isArray(node.children)) bad('malformed assembly tree node');
    for (const i of node.meshes) {
      if (!Number.isInteger(i) || i < 0 || i >= n) bad(`assembly tree names mesh ${i} of ${n}`);
    }
    if (seen.has(node)) bad('assembly tree node repeated');
    seen.add(node);
    for (const c of node.children) walk(c, depth + 1);
  };
  walk(h.root, 0);
}

export function computeNormals(positions, indices) {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { n[i] += nx; n[i + 1] += ny; n[i + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

// occt-import-js ReadStepFile/ReadFile result -> model for encodeCadmesh.
// Per-face b-rep colours become per-vertex colours (OCCT meshes each face
// with its own vertices, so a face's triangles own their vertex range).
export function occtResultToModel(result, units = 'millimeter') {
  if (!result || !result.success) throw new Error('STEP import failed (occt-import-js returned success=false)');
  const meshes = result.meshes.map((m) => {
    const positions = Float32Array.from(m.attributes.position.array);
    const normals = m.attributes.normal ? Float32Array.from(m.attributes.normal.array) : null;
    const indices = Uint32Array.from(m.index.array);
    let colors = null;
    const faces = m.brep_faces || [];
    if (faces.some((f) => f.color)) {
      const base = m.color || [0.72, 0.74, 0.78];
      colors = new Uint8Array((positions.length / 3) * 4);
      for (let v = 0; v < positions.length / 3; v++) {
        colors[v * 4] = base[0] * 255; colors[v * 4 + 1] = base[1] * 255; colors[v * 4 + 2] = base[2] * 255;
      }
      for (const f of faces) {
        if (!f.color) continue;
        for (let t = f.first; t <= f.last; t++) {
          for (let k = 0; k < 3; k++) {
            const v = indices[t * 3 + k];
            colors[v * 4] = f.color[0] * 255; colors[v * 4 + 1] = f.color[1] * 255; colors[v * 4 + 2] = f.color[2] * 255;
          }
        }
      }
    }
    return { name: m.name, color: m.color || null, positions, normals, colors, indices };
  });
  const conv = (n) => ({ name: n.name || '', meshes: n.meshes || [], children: (n.children || []).map(conv) });
  const root = conv(result.root);
  if (!meshes.some((m) => m.color || m.colors)) paletteByPart(meshes, root);
  return { units, meshes, root };
}

// A file exported with no colours (common from some CAD packages) renders as one grey
// block. Give each distinct part NAME its own muted colour instead, so every
// instance of a part matches and neighbouring parts differ.
export const PALETTE = [
  [0.62, 0.66, 0.72], [0.80, 0.55, 0.30], [0.36, 0.56, 0.74], [0.55, 0.70, 0.45],
  [0.74, 0.70, 0.48], [0.62, 0.48, 0.70], [0.42, 0.66, 0.66], [0.76, 0.50, 0.52],
  [0.50, 0.52, 0.58], [0.70, 0.62, 0.56],
];

export function hashName(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function paletteByPart(meshes, root) {
  const owner = new Array(meshes.length).fill('');
  const walk = (n, name) => {
    const nm = n.name || name;
    for (const i of n.meshes) owner[i] = nm;
    for (const c of n.children) walk(c, nm);
  };
  walk(root, '');
  meshes.forEach((m, i) => {
    m.color = PALETTE[hashName(owner[i] || m.name || String(i)) % PALETTE.length];
  });
}

export const DEFAULT_TESSELLATION = Object.freeze({
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
});
