// The shown model as a mesh file, for a printer, a slicer or another 3D tool
// (feature review 2026-10-29, item 9): STL (binary, no colour), 3MF (a zip,
// one object per body, per-triangle colours) and GLB (binary glTF, one node
// per body, per-vertex colours). Pure: no DOM; the zip uses CompressionStream.
//
// model: a decoded model's global arrays (js/cadmesh.js): position (mm),
// normal (snorm16 x4), color (unorm8 x4, the drawn colours), index (absolute
// vertex numbers), header.meshes (vtxStart, vtxCount, idxStart, idxCount, name).
// ids: the bodies (mesh index + 1) to write, in order.
// basis: three model-frame unit vectors [x, y, z] the output's axes are taken
// along (main.js gives the orientation's: Z up for STL and 3MF, the printing
// convention; Y up for glTF, its own). Coordinates stay in mm except GLB's,
// which glTF fixes in metres.

import { crc32 } from './crc32.js';
import { orientBasis } from './orient.js';
import { windsAgainstNormals } from './raycast.js';

const dot3 = (P, i, b) => P[i] * b[0] + P[i + 1] * b[1] + P[i + 2] * b[2];

// one body's vertices (in the basis, scaled) and triangles (local numbers). A triangle whose
// winding disagrees with its vertex normals (their sum) is written turned round: the normals are
// the body's outside to the view and to Measure (js/measure-geom.js facingNormals), and STL and
// 3MF carry the winding alone, so a mirrored placement -- wound inward, normals out -- went to a
// slicer inside out while the view showed it right.
function bodyOf(model, id, basis, scale) {
  const m = model.header.meshes[id - 1];
  const P = model.position, N = model.normal;
  const pos = new Float32Array(m.vtxCount * 3);
  for (let v = 0; v < m.vtxCount; v++) {
    const i = (m.vtxStart + v) * 3;
    for (let k = 0; k < 3; k++) pos[v * 3 + k] = dot3(P, i, basis[k]) * scale;
  }
  const idx = new Uint32Array(m.idxCount);
  for (let t = 0; t < m.idxCount; t += 3) {
    const a = model.index[m.idxStart + t], b = model.index[m.idxStart + t + 1], c = model.index[m.idxStart + t + 2];
    const turn = windsAgainstNormals(P, N, a, b, c);
    idx[t] = a - m.vtxStart;
    idx[t + 1] = (turn ? c : b) - m.vtxStart;
    idx[t + 2] = (turn ? b : c) - m.vtxStart;
  }
  return { m, pos, idx };
}

// ---- STL ----
// s as UTF-8 in at most n bytes, cut before a character that would not fit whole
export function utf8Within(s, n) {
  const b = new TextEncoder().encode(s);
  if (b.length <= n) return b;
  let e = n;
  while (e > 0 && (b[e] & 0xc0) === 0x80) e--;
  return b.subarray(0, e);
}
export function toSTL(model, ids0, basis, name = 'model') {
  const [ids] = withTriangles(model, ids0, []);
  let n = 0;
  for (const id of ids) n += model.header.meshes[id - 1].idxCount / 3;
  const buf = new ArrayBuffer(84 + 50 * n);
  const dv = new DataView(buf);
  // the header must not start with "solid" (an ASCII STL's first word)
  // (80 BYTES, cut at a whole character: cut at 80 characters, a name of 21 CJK characters was
  // more than 80 bytes of UTF-8 and the export threw "offset is out of bounds" -- r64 A1)
  new Uint8Array(buf, 0, 80).set(utf8Within(`cad.place export: ${name}`, 80));
  dv.setUint32(80, n, true);
  let o = 84;
  for (const id of ids) {
    const { pos, idx } = bodyOf(model, id, basis, 1);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (const f of [nx, ny, nz]) { dv.setFloat32(o, f, true); o += 4; }
      for (const q of [a, b, c]) for (let k = 0; k < 3; k++) { dv.setFloat32(o, pos[q + k], true); o += 4; }
      dv.setUint16(o, 0, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

// ---- a zip (3MF's container): deflated entries, CRC-32 ----
export { crc32 };
async function deflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
// files: [[name, Uint8Array]] -> the zip's bytes
export async function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nm = enc.encode(name);
    const crc = crc32(data);
    const comp = await deflateRaw(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 8, true); // deflate
    local.setUint32(14, crc, true);
    local.setUint32(18, comp.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(local.buffer), nm, comp);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(10, 8, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, comp.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nm.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nm);
    offset += 30 + nm.length + comp.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

// ---- 3MF ----
// (a character XML 1.0 does not allow -- a control character, a lone surrogate, U+FFFE/FFFF --
// becomes U+FFFD: written as it was, a body name with one made a 3MF no strict XML parser reads -- r64 A3)
export const xmlEsc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')
  .replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();
const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(5).replace(/0+$/, '').replace(/\.$/, ''));

// The bodies an export writes: those with a triangle (an empty one became a glTF accessor of count
// 0 with min / max [null, null, null], invalid glTF 2.0, and a 3MF object with an empty mesh),
// each with its name
// (the one rule for the page's export, its "saved: N bodies" note and cadmesh-export.mjs: each
// counts and refuses by it -- counted before the writers dropped the empty ones, a GLB of 1 node
// said 2 bodies, and one of none was written: invalid glTF, a 3MF without a material)
export const exportable = (model, ids) => ids.filter((id) => model.header.meshes[id - 1].idxCount > 0);
// (the one refusal, said one way, by every writer -- STL's too, which wrote an 84-byte file)
export const NOTHING_TO_EXPORT = 'nothing to export (no body left to write has a triangle)';
function withTriangles(model, ids, names) {
  const keep = ids.map((id, j) => [id, names[j]]);
  const ok = new Set(exportable(model, ids));
  const kept = keep.filter(([id]) => ok.has(id));
  if (!kept.length) throw new Error(NOTHING_TO_EXPORT);
  return [kept.map((x) => x[0]), kept.map((x) => x[1])];
}

export async function to3MF(model, ids0, basis, names0 = []) {
  const [ids, names] = withTriangles(model, ids0, names0);
  // one base material per distinct colour (each triangle takes its first
  // vertex's), so a body's per-face colours survive
  const colours = new Map();
  const C = model.color;
  const colourOf = (v) => { const k = `#${hex2(C[4 * v])}${hex2(C[4 * v + 1])}${hex2(C[4 * v + 2])}`; if (!colours.has(k)) colours.set(k, colours.size); return colours.get(k); };
  const objects = [];
  ids.forEach((id, j) => {
    const { m, pos, idx } = bodyOf(model, id, basis, 1);
    const verts = [];
    for (let v = 0; v < m.vtxCount; v++) verts.push(`<vertex x="${num(pos[3 * v])}" y="${num(pos[3 * v + 1])}" z="${num(pos[3 * v + 2])}"/>`);
    const tris = [];
    for (let t = 0; t < idx.length; t += 3) tris.push(`<triangle v1="${idx[t]}" v2="${idx[t + 1]}" v3="${idx[t + 2]}" pid="1" p1="${colourOf(m.vtxStart + idx[t])}"/>`);
    objects.push(`<object id="${j + 2}" type="model" name="${xmlEsc(names[j] || m.name || `body ${id}`)}"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`);
  });
  const mats = [...colours.keys()].map((c, i) => `<base name="colour ${i + 1}" displaycolor="${c}"/>`).join('');
  const modelXml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
    + `<resources><basematerials id="1">${mats}</basematerials>${objects.join('')}</resources>`
    + `<build>${ids.map((_, j) => `<item objectid="${j + 2}"/>`).join('')}</build></model>`;
  const enc = new TextEncoder();
  return zip([
    ['[Content_Types].xml', enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')],
    ['_rels/.rels', enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')],
    ['3D/3dmodel.model', enc.encode(modelXml)],
  ]);
}

// ---- GLB ----
export function toGLB(model, ids0, basis, names0 = []) {
  const [ids, names] = withTriangles(model, ids0, names0);
  const chunks = [];
  let binLen = 0;
  const views = [], accessors = [], meshes = [], nodes = [];
  const add = (arr, target) => {
    const pad = (4 - (binLen % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); binLen += pad; }
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    views.push({ buffer: 0, byteOffset: binLen, byteLength: bytes.length, ...(target ? { target } : {}) });
    chunks.push(bytes);
    binLen += bytes.length;
    return views.length - 1;
  };
  ids.forEach((id, j) => {
    const { m, pos, idx } = bodyOf(model, id, basis, 0.001);
    const nrm = new Float32Array(m.vtxCount * 3);
    const col = new Uint8Array(m.vtxCount * 4);
    const N = model.normal, C = model.color;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < m.vtxCount; v++) {
      const g = m.vtxStart + v;
      const n0 = [N[4 * g] / 32767, N[4 * g + 1] / 32767, N[4 * g + 2] / 32767];
      const r = basis.map((b) => n0[0] * b[0] + n0[1] * b[1] + n0[2] * b[2]);
      const l = Math.hypot(...r) || 1;
      for (let k = 0; k < 3; k++) {
        nrm[3 * v + k] = r[k] / l;
        lo[k] = Math.min(lo[k], pos[3 * v + k]);
        hi[k] = Math.max(hi[k], pos[3 * v + k]);
      }
      col.set([C[4 * g], C[4 * g + 1], C[4 * g + 2], 255], 4 * v);
    }
    const a0 = accessors.length;
    accessors.push({ bufferView: add(pos, 34962), componentType: 5126, count: m.vtxCount, type: 'VEC3', min: lo, max: hi });
    accessors.push({ bufferView: add(nrm, 34962), componentType: 5126, count: m.vtxCount, type: 'VEC3' });
    accessors.push({ bufferView: add(col, 34962), componentType: 5121, normalized: true, count: m.vtxCount, type: 'VEC4' });
    accessors.push({ bufferView: add(idx, 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
    const name = names[j] || m.name || `body ${id}`;
    meshes.push({ name, primitives: [{ attributes: { POSITION: a0, NORMAL: a0 + 1, COLOR_0: a0 + 2 }, indices: a0 + 3, material: 0 }] });
    nodes.push({ name, mesh: j });
  });
  const json = {
    asset: { version: '2.0', generator: 'cad.place' },
    scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes,
    // white, so the vertex colours show as they are
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true }],
    accessors, bufferViews: views, buffers: [{ byteLength: binLen }],
  };
  let js = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (js.length % 4)) % 4;
  if (jpad) { const t = new Uint8Array(js.length + jpad).fill(0x20); t.set(js); js = t; }
  const bpad = (4 - (binLen % 4)) % 4;
  const total = 12 + 8 + js.length + 8 + binLen + bpad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, js.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(js, 20);
  let o = 20 + js.length;
  dv.setUint32(o, binLen + bpad, true);
  dv.setUint32(o + 4, 0x004e4942, true); // "BIN\0"
  o += 8;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// The axes an export takes, as model-frame unit vectors [x, y, z], for the model's orientation
// (js/orient.js, "+z-y") and the file's up ('z': the printing convention, STL and 3MF; 'y':
// glTF's): the page's File > Export and cadmesh-export.mjs alike
export function exportBasis(orient, up) {
  const b = orientBasis(orient);
  return up === 'z' ? [b.right, b.front.map((v) => -v), b.up] : [b.right, b.up, b.front];
}

// The export formats, one row each: the file's MIME type, which way is up in it ('z' the
// printing convention, 'y' glTF's own), and its writer, all called alike:
// write(model, ids, basis, { names, base }) -> bytes (or a promise of them). main.js File >
// Export builds its buttons from these rows: a new format is a row here.
// (about: what the file holds, for its button's title)
export const EXPORTS = {
  stl: { label: 'STL', about: 'triangles, no colour', type: 'model/stl', up: 'z', write: (m, ids, b, { base }) => toSTL(m, ids, b, base) },
  '3mf': { label: '3MF', about: 'colours, in mm', type: 'model/3mf', up: 'z', write: (m, ids, b, { names }) => to3MF(m, ids, b, names) },
  glb: { label: 'GLB', about: 'colours, in metres', type: 'model/gltf-binary', up: 'y', write: (m, ids, b, { names }) => toGLB(m, ids, b, names) },
};
