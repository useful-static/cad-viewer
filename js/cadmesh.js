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
//     meshes:[{ name, color, vtxStart, vtxCount, idxStart, idxCount, bbox, kind?,
//               faceStart?, faceCount? }],
//     root:{ name, meshes:[i...], children:[...] },
//     sourceUnits?, angularDeflection?, recolour?,
//     facts?, factsRule?, silhouettesOmitted?, edgesFailed?:{ error, factsRule? } }
// edgesFailed (never beside facts): the edges' and facts' build failed when the
// viewer read the file (KEEP_WITHOUT_EDGES); the viewer builds them again unless
// it was a size limit under today's rule (writtenSizeLimit). Save .cadmesh drops it.
// kind (optional; absent from files converted before it existed) is the
// body's status taken from the b-rep by the converter, not from the mesh:
// "closed", "capped" (closed by planar faces the converter added where the
// file left a hole), "sheet" (flat, zero thickness: a pad, a label) or "open".
// recolour: present when the per-vertex colours are no longer the
// converter's -- set-colours.mjs wrote others -- naming what wrote them, so a
// tool that derives colours from the converter's knows not to run on its
// own output. Tools that rewrite a file (split-board.mjs) keep it.
// sourceUnits: the length unit the source file DECLARES (js/source-units.js:
// 'mm', 'in', ...; 'mixed' when its shapes disagree); absent = unknown, never
// mm. The geometry itself is always in `units` (mm: OpenCascade converts).
// angularDeflection: the tessellation's angle in radians.
//
// Per-vertex sections (vertexCount entries):
//   position float32x3 · normal snorm16x4 (w=0) · color unorm8x4 · id unorm8x4
// id is (mesh index + 1) as little-endian RGBA bytes, so a pick pass writes it
// straight to an RGBA8 target and the read-back bytes ARE the id (0 = nothing).
// index: uint32 triangle list, absolute vertex indices.
//
// Optional sections (absent from older files, which older viewers ignore):
//   faces  uint32 pairs (first triangle, triangle count), one per b-rep face,
//          in GLOBAL triangle numbers; count 0 for a face that was not meshed.
//          A mesh's faces are faceStart .. faceStart + faceCount - 1.
//   edges  uint32 vertex pairs: the unique b-rep face boundaries (js/edges.js)
//   silhouettes, silhouetteNormals
//          uint32 vertex pairs, and per pair the normals of its two
//          triangles as snorm16x4 x 2 (w = 0): the edges inside curved faces,
//          drawn where they are on the outline. Absent when there were more
//          than SILHOUETTE_CAP (the header's silhouettesOmitted says how many).
// Header facts (with edges): one array a fact, one entry per mesh, the facts and their kinds those
// of js/edges.js BODY_FACTS and KINDS (the one list: closed, area, volume, and flags written only
// when one body has them); volume is the material's (js/edges.js materialVolume), meaningful for
// closed bodies. factsRule:
// the number of the rule the facts were built by (js/edges.js FACTS_RULE); facts of another rule,
// or none, are rebuilt by the viewer.
//
// Pure ES module, no DOM: imported by the browser viewer, the STEP worker and
// the Node converter.

import { buildEdges, FACTS_RULE, factsRuleHolds, BODY_FACTS, KINDS, momentaryFailure } from './edges.js';

export const MAGIC = 0x4d444143; // 'CADM' little-endian
export const VERSION = 1;
// header.units when the geometry is in millimetres: what every reader writes
// (OpenCascade's linearUnit word), and what the viewer's unit display needs
// to convert lengths (main.js geomMm)
export const MM = 'millimeter';
// a body's colour when nothing gives it one (the readers, the One colour scheme)
export const DEFAULT_GREY = [0.72, 0.74, 0.78];
// 0..1 -> a byte, rounded (every writer of colour bytes: the grey's 0.74 * 255 = 188.7 is 189,
// where a truncating Uint8Array store made it 188)
export const toByte = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255);

const SECTIONS = ['position', 'normal', 'color', 'id', 'index'];
// name -> element type; written only when the model carries them
const OPTIONAL = { faces: Uint32Array, edges: Uint32Array, silhouettes: Uint32Array, silhouetteNormals: Int16Array };
// the b-rep statuses the converter reports: BodyKind in
// occt-progress/progress.patch is the source; this list follows it
export const BODY_KINDS = ['closed', 'capped', 'sheet', 'open'];

const align8 = (n) => (n + 7) & ~7;

export function idToBytes(id) {
  return [id & 255, (id >>> 8) & 255, (id >>> 16) & 255, (id >>> 24) & 255];
}

export function bytesToId(b0, b1, b2, b3) {
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

// model: { units, meshes:[{name, color:[r,g,b]|null, positions:Float32Array,
//          normals:Float32Array|null, colors:Uint8Array(rgba per vertex)|null,
//          indices:Uint32Array (local to the mesh),
//          faces?:Uint32Array (first, count) pairs in the mesh's own triangle
//          numbers}], root, sourceUnits?, angularDeflection?, recolour? }
// The faces section is written only when every mesh carries faces. The edge
// list and the body facts are built here (opts.edges = false leaves them out).
// (opts.overlapBudget: passed to the facts' overlap test, js/edges.js buildEdges)
// What encodeCadmesh does when the edges' and facts' build throws (its onEdgesError): refuse, or
// keep the file without them, the failure written in its header (`edgesFailed`: the error and the
// facts' rule it was met under, so the viewer does not build them again to fail the same way, at
// each open of a kept conversion too: r43 A3). Whether it is a size limit is asked of it when read,
// by today's js/edges.js momentaryFailure, and only under today's rule -- a yes/no written with it
// was a second copy of that rule, obeyed for good (r44 A1, Q2); Save .cadmesh writes a file without it
export const REFUSE_WITHOUT_EDGES = (e) => { throw e; };
// a CLI's refusal, in one wording: the input named (stp2mesh.mjs, split-board.mjs -- r43 A9)
export const refuseWithoutEdges = (input) => (e) => { throw new Error(`${input}: the edges and body facts: ${e?.message || e}`); };
export const KEEP_WITHOUT_EDGES = (e) => ({ error: String(e?.message || e), factsRule: FACTS_RULE });
// a written failure the viewer may take as the model's own, not built again: a size limit by today's
// rule, met under today's facts rule (main.js edgesOf)
// (a rule's that still holds: no facts, so no flagged body -- r68's rule 5 left 4's size limits as they were)
export const writtenSizeLimit = (h) => !!h?.edgesFailed && factsRuleHolds(h.edgesFailed.factsRule, null) && !momentaryFailure(h.edgesFailed.error);

// (edgeOptions: passed to js/edges.js buildEdges as they are -- its list maker, for a test)
export function encodeCadmesh(model, { edges: withEdges = true, overlapBudget, onEdgesError = REFUSE_WITHOUT_EDGES, edgeOptions = {} } = {}) {
  let vertexCount = 0;
  let indexCount = 0;
  let faceCount = 0;
  const withFaces = model.meshes.length > 0 && model.meshes.every((m) => m.faces instanceof Uint32Array);
  for (const m of model.meshes) {
    vertexCount += m.positions.length / 3;
    indexCount += m.indices.length;
    if (withFaces) faceCount += m.faces.length / 2;
  }
  const faces = withFaces ? new Uint32Array(faceCount * 2) : null;
  let f0 = 0;
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
    const base = m.color || DEFAULT_GREY;
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
        color[o] = toByte(base[0]);
        color[o + 1] = toByte(base[1]);
        color[o + 2] = toByte(base[2]);
        color[o + 3] = 255;
      }
      id[o] = idb[0]; id[o + 1] = idb[1]; id[o + 2] = idb[2]; id[o + 3] = idb[3];
    }
    for (let i = 0; i < ni; i++) index[i0 + i] = m.indices[i] + v0;
    const nf = withFaces ? m.faces.length / 2 : 0;
    for (let f = 0; f < nf; f++) {
      faces[(f0 + f) * 2] = m.faces[f * 2] + i0 / 3;
      faces[(f0 + f) * 2 + 1] = m.faces[f * 2 + 1];
    }
    for (let k = 0; k < 3; k++) {
      if (nv && mMin[k] < bbMin[k]) bbMin[k] = mMin[k];
      if (nv && mMax[k] > bbMax[k]) bbMax[k] = mMax[k];
    }
    metas.push({
      name: m.name || `mesh ${mi + 1}`,
      color: m.color || null,
      vtxStart: v0, vtxCount: nv, idxStart: i0, idxCount: ni,
      bbox: nv ? { min: mMin, max: mMax } : null,
      ...(m.kind ? { kind: m.kind } : {}),
      ...(withFaces ? { faceStart: f0, faceCount: nf } : {}),
    });
    v0 += nv;
    i0 += ni;
    f0 += nf;
  });

  const arrays = { position, normal, color, id, index, ...(faces ? { faces } : {}) };
  let edgeInfo = null, edgesFailed = null;
  if (withEdges && vertexCount) {
    // (a build that throws: onEdgesError says what follows -- by default the encoding refused, as
    // a CLI's or a generator's output promises its facts (a default that kept the file wrote one
    // without facts under an "OK" line: r42 A7); the viewer's readers pass KEEP_WITHOUT_EDGES, the
    // file then shown and its edges worker building them and saying why there are none -- a valid
    // file the readers took was refused whole, "Invalid array length": r41 A3)
    try {
      edgeInfo = buildEdges({ position, index, meshes: metas }, { ...(overlapBudget !== undefined ? { overlapBudget } : {}), ...edgeOptions });
    } catch (e) {
      edgesFailed = onEdgesError(e) || null;
    }
  }
  if (edgeInfo) {
    arrays.edges = edgeInfo.edges;
    if (edgeInfo.silhouettes) {
      arrays.silhouettes = edgeInfo.silhouettes;
      arrays.silhouetteNormals = edgeInfo.silhouetteNormals;
    }
  }
  const names = [...SECTIONS, ...Object.keys(OPTIONAL).filter((s) => arrays[s])];
  const sections = {};
  let off = 0;
  for (const s of names) {
    sections[s] = { offset: off, byteLength: arrays[s].byteLength };
    off = align8(off + arrays[s].byteLength);
  }
  const header = {
    units: model.units || MM,
    bbox: vertexCount ? { min: bbMin, max: bbMax } : null,
    vertexCount, indexCount, sections, meshes: metas,
    root: model.root || { name: 'model', meshes: metas.map((_, i) => i), children: [] },
    ...(typeof model.sourceUnits === 'string' ? { sourceUnits: model.sourceUnits } : {}),
    ...(typeof model.recolour === 'string' && model.recolour ? { recolour: model.recolour } : {}),
    ...(model.angularDeflection > 0 ? { angularDeflection: model.angularDeflection } : {}),
    ...(edgeInfo ? { facts: roundFacts(edgeInfo.facts), factsRule: FACTS_RULE } : {}),
    ...(edgeInfo?.silhouettesOmitted ? { silhouettesOmitted: edgeInfo.silhouettesOmitted } : {}),
    ...(edgesFailed ? { edgesFailed } : {}),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const dataStart = align8(12 + json.byteLength);
  const out = new ArrayBuffer(dataStart + off);
  const dv = new DataView(out);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, json.byteLength, true);
  new Uint8Array(out, 12, json.byteLength).set(json);
  for (const s of names) {
    new Uint8Array(out, dataStart + sections[s].offset, sections[s].byteLength)
      .set(new Uint8Array(arrays[s].buffer, arrays[s].byteOffset, arrays[s].byteLength));
  }
  return out;
}

// A raw .cadmesh (ArrayBuffer) -> { header, data }: the parsed header and a
// copy of the data region every section offset is counted from. With
// withHeader() it is how a tool edits a file in place (set-colours.mjs: new
// colour bytes, a "recolour" key) without a second writer of the layout.
export function splitCadmesh(buf) {
  const { header } = decodeCadmesh(buf); // (validates the whole file first)
  const jlen = new DataView(buf).getUint32(8, true);
  return { header, data: new Uint8Array(buf.slice(align8(12 + jlen))) };
}

// A .cadmesh (raw or gzipped) without its written edges failure, for a file that leaves this
// browser (main.js Save .cadmesh): the failure is this browser's reading, and another may build
// them (r44 Q2). The same buffer back when it carries none -- a raw one asked of its header alone,
// not decoded whole (a Save inflated and checked the whole file to find nothing: r45 Q7).
export async function withoutEdgesFailed(buf) {
  const raw = isGzip(buf) ? await inflateCadmesh(buf) : buf;
  // (the header asked alone only when it reads as one; anything else falls to splitCadmesh, which
  // refuses it in the decoder's words -- an engine's RangeError or TypeError was thrown: r46 Q8)
  const head = () => {
    if (raw.byteLength < 12) return null;
    // (a .cadmesh's own: not one gave two answers -- accepted without a record, refused with one: r47 A8)
    const dv = new DataView(raw);
    if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== VERSION) return null;
    const jlen = dv.getUint32(8, true);
    // (a length past the file throws in the view's making: caught)
    // (one with a mesh list and its sections, as the decoder asks of every header: `{}` or `[]` was
    // taken as one -- r48 A6 -- and the mesh list alone was a second test of what a header is -- r49 A7)
    try {
      const h = JSON.parse(new TextDecoder().decode(new Uint8Array(raw, 12, jlen)));
      return h && typeof h === 'object' && Array.isArray(h.meshes) && h.sections && typeof h.sections === 'object' ? h : null;
    } catch { return null; }
  };
  const h = head();
  if (h && !('edgesFailed' in h)) return buf;
  const { header, data } = splitCadmesh(raw);
  if (header.edgesFailed === undefined) return buf;
  const { edgesFailed, ...rest } = header;
  return withHeader(rest, data);
}

// The bytes Save .cadmesh writes: without a written edges failure, gzipped where the browser can
// (about a sixth of the raw size; one opened from the browser's kept conversions is gzipped
// already)
export async function cadmeshToSave(buf) {
  const b = await withoutEdgesFailed(buf);
  return isGzip(b) || typeof CompressionStream !== 'function' ? b : deflateCadmesh(b);
}

// header + data region -> a raw .cadmesh (ArrayBuffer), checked to read back.
// Section offsets are from the data's start, so a longer header moves nothing
// they name.
export function withHeader(header, data) {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const dataStart = align8(12 + json.byteLength);
  const out = new ArrayBuffer(dataStart + data.byteLength);
  const dv = new DataView(out);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, json.byteLength, true);
  new Uint8Array(out, 12, json.byteLength).set(json);
  new Uint8Array(out, dataStart).set(data);
  decodeCadmesh(out);
  return out;
}

// A .cadmesh file may be stored gzip-compressed (RFC 1952): the sections are
// mostly redundant bytes (a 650k-triangle assembly gzips to a sixth), and a
// static host serves application/octet-stream uncompressed. The gzip magic
// tells the two apart, so raw files keep loading. Both directions use the
// platform's Compression Streams (browsers, Node 18+): no bundled inflater.
// (an ArrayBuffer or a byte view: given a Uint8Array, new Uint8Array(it, 0, 2) copied it whole, and a
// longer one was never a gzip -- the one test, the list check's and the CLIs' too: r76 A9)
export function isGzip(buf) {
  const b = ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

const pipeBytes = (buf, stream) => new Response(new Blob([buf]).stream().pipeThrough(stream)).arrayBuffer();

// The most a file may be, downloaded or unpacked: about the largest buffer a
// browser hands out. A few MB of gzip can inflate to many GB; past this it
// stops and says why, instead of the tab being killed with no message.
export const MAX_FILE_BYTES = 2 * 2 ** 30;
// (said one way, by the page refusing a file and by the list check calling it bad -- "2048.0 MB" there
// beside "over 2 GB" here: r72 A8)
export const OVERSIZE_WORDS = `over ${(MAX_FILE_BYTES / 2 ** 30).toFixed(0)} GB, more than this viewer opens`;
// The largest coordinate a model may hold, in mm (the mesh readers check it in the file's numbers
// and in mm after a unit's scale; decodeCadmesh checks it as stored): the view squares distances in
// float32 (its matrices, the depth range), so float32's range is not the bound -- a model at 1e38
// loaded and showed blank, every vertex NaN. 1e15 squared stays well inside it
export const MAX_COORD = 1e15;
export const MAX_COORD_WORDS = '10^15 mm';

// A conversion that shows nothing, in words, or null: no triangle at all -- faces the converter
// could not mesh (unmeshed: their count), else no faces (curves or points only). The one refusal
// for the page and stp2mesh.mjs (each had its own, drifted)
export function noSurfaces(triangles, name, unmeshed = 0) {
  if (triangles > 0) return null;
  return unmeshed
    ? `none of the ${unmeshed} faces of ${name} could be meshed: the converter failed on them, or ran out of memory`
    : `${name} has no surfaces to show: it holds no faces (only curves or points, or nothing). Export the solids or surfaces from the CAD program`;
}

// Each body's label as the page shows it: "owner › body", its nearest named tree node and its own
// name (CAD exporters name bodies generically -- COMPONENT1..n -- while the tree carries the part's
// name), or its name alone. The one rule for the page and cadmesh-export.mjs (the CLI named
// a node COMPONENT1 where the page said BOARD › COMPONENT1)
export function bodyLabels(header) {
  const labels = header.meshes.map((m) => m.name);
  const walk = (n, owner) => {
    const nm = n.name || owner;
    for (const i of n.meshes) {
      const mn = header.meshes[i].name;
      labels[i] = nm && nm !== mn ? `${nm} › ${mn}` : mn;
    }
    for (const c of n.children) walk(c, nm);
  };
  if (header.root) walk(header.root, '');
  return labels;
}

// gzip bytes -> the bytes inside (any file: a .cadmesh, a part.stp.gz),
// counted as they come, at most `max`
// (stop: read at each turn of the thread -- a load superseded or cancelled -- true ends it in a StopRead)
export function gunzip(buf, max = MAX_FILE_BYTES, stop = null) {
  return inflate(buf, 'gzip', max, stop);
}

// compressed bytes ('gzip', or a zip entry's 'deflate-raw') -> the bytes inside, counted as they
// come and refused past `max` (a zip bomb stops there, not when the tab runs out of memory)
export async function inflate(buf, format, max = MAX_FILE_BYTES, stop = null) {
  const what = format === 'gzip' ? 'gzip' : 'deflated';
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(`this file is ${what}-compressed, and this browser cannot decompress (no DecompressionStream)`);
  }
  // ONE output buffer, filled as the chunks arrive: holding the chunks and then copying them into
  // their total kept two copies of the whole file at the peak (a 1.9 GB model needed 3.8 GB). Its
  // first size is the gzip trailer's (ISIZE: the length mod 4 GB -- right for any file this opens,
  // and only a hint: a lie costs a regrow, never a wrong answer), grown x2 when the data runs past.
  let out = new Uint8Array(firstSize(buf, format, max));
  const n = await readMembers(buf, format, max, (value, at) => {
    if (at + value.byteLength > out.length) {
      const grown = new Uint8Array(Math.min(max, Math.max(2 * out.length, at + value.byteLength)));
      grown.set(out.subarray(0, at));
      out = grown;
    }
    out.set(value, at);
  }, 0, stop);
  if (n === out.length) return out.buffer;
  // (a buffer too long for its data: transfer() shrinks it without a second copy where it can)
  return typeof out.buffer.transfer === 'function' ? out.buffer.transfer(n) : out.buffer.slice(0, n);
}

// How many bytes a gzip (or deflate-raw) unpacks to, read as the page reads it -- every member, the
// same limit and refusals -- none of them kept: the list check's measure of a gzip it can fetch
// whole (its trailer is the LAST member's size, mod 4 GiB: r73 Q1)
// (onChunk: each chunk as it comes, none kept -- the list check's CRC of a zip entry: r80 Q4)
export async function inflateCount(buf, format = 'gzip', max = MAX_FILE_BYTES, onChunk = null) {
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot decompress (no DecompressionStream)');
  // (each byte once, in order: a gzip member read again in Chromium hands the same output over from its
  // start -- passed on only past what was handed already, so a CRC over it is the file's: r81 A11)
  let next = 0;
  return readMembers(buf, format, max, onChunk ? (v, at) => {
    if (at + v.length <= next) return;
    onChunk(at >= next ? v : v.subarray(next - at));
    next = at + v.length;
  } : () => {});
}

// (a stream's input, written FEED bytes at a time; the most of a member's output a stopped stream
// drops, one piece's at deflate's largest ratio and a margin; the output inflated again in looking
// for members' ends, past twice what the members before gave and four times what this one's first
// stream did)
const FEED = 65536;
const DROPPED_MOST = FEED * 1032 + 2 ** 20;
const REREAD_MOST = 64 * 2 ** 20;
// (a turn of the thread, every TURN_BYTES of output: a task of its own, so a paint, a timer and a
// click run -- a MessageChannel's, as setTimeout's is held to 1 s in a hidden tab)
const TURN_BYTES = 32 * 2 ** 20;
// (and at a member's start once TURN_MS have passed, whatever came out: a gzip of 64-byte members
// gives little output for much work, and 65,539 of them held the page 87 s with no turn and stop()
// never asked -- r78 Q1 -- and before each try at a member's end, r79 Q1. Within one stream the turn
// is by output alone, TURN_BYTES: empty stored blocks give none, and 200 MB of them read in 0.3 s
// (r79 Q4, measured))
const TURN_MS = 50;
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const turn = () => new Promise((res) => {
  if (typeof MessageChannel === 'undefined') { setTimeout(res, 0); return; }
  const c = new MessageChannel();
  c.port1.onmessage = () => { c.port1.close(); res(); };
  c.port2.postMessage(0);
});
// A read stopped by its caller's stop() (a load superseded or cancelled): not a fault of the file
export class StopRead extends Error { constructor() { super('the read was stopped'); this.stopped = true; } }
// The one reading of compressed bytes, for inflate, inflateCount and inflateHead: each chunk handed to
// take(value, at) as it comes, refused past `max`; the count returned.
// (a gzip of several members -- cat a.gz b.gz, bgzip -- is one file's bytes in turn, RFC 1952. This
// browser's DecompressionStream stops after the first: "Junk found after end of compressed data",
// a valid file called damaged, where node's reads every member -- so the tests passed on what the
// page refused: r73 Q1, Q3. Read whole, as one stream, first: a file of one member is read once.
// When a stream stops early, the member ends at a later gzip header (1f 8b 08): the first one whose
// bytes before it read as a whole gzip, CRC and all, is it, read again on its own, and the next
// member starts there. Its CRC is the stream's to check: found by a trailer search over what the
// stopped stream had given, the member's own output was short where Chromium drops what it had
// queued, and the CRC over a cut-short file's whole output held the page 4 s -- r74 Q3, Q4)
// (head: stop once that many bytes are out, and a stream cut short -- a file's first 64 KB -- is what
// it gave, not an error: inflateHead)
// (stop: a function, read at each turn of the thread; true stops the read with a StopRead)
async function readMembers(buf, format, max, take, head = 0, stop = null) {
  const what = format === 'gzip' ? 'gzip' : 'deflated';
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let n = 0, off = 0, reread = 0, seen = 0, turned = 0, turnedAt = clock(), fed = 0, allFed = false;
  // (a turn of the thread, then the caller's stop asked: true when the read is to stop)
  const turnNow = async () => {
    turned = seen; await turn(); turnedAt = clock();
    return !!(stop && stop());
  };
  // (one stream over bytes, its output handed on from `n`: written straight in -- read through a Blob
  // stream of its own each, a bgzip of 250 members was refused, "network error": r74 A6)
  // (in pieces of FEED bytes: a stream processes each as its output is read, so when it stops, what
  // it drops is one piece's output at most -- written whole, Chromium handed on 131,072 bytes of a
  // member of any size, and a member's end could not be told from a chance header: r76 A7)
  const stream = async (bytes) => {
    const ds = new DecompressionStream(format);
    const w = ds.writable.getWriter();
    // (each piece written once the stream has taken the one before, and none once it has stopped:
    // queued all at once, Chromium -- which stops after every member -- was handed the whole rest of
    // the file for each one, and a bgzip of 12,852 members held the page 126 s: r77 Q1)
    let over = false;
    // (what it took before it stopped: fed, and whether that was all -- where a member's end can be,
    // stream() returning: r80 Q5)
    fed = 0; allFed = false;
    (async () => {
      try {
        for (let i = 0; i < bytes.length && !over; i += FEED) {
          await w.ready;
          if (over) break;
          await w.write(bytes.subarray(i, Math.min(bytes.length, i + FEED)));
          fed = Math.min(bytes.length, i + FEED);
        }
        if (!over) { allFed = true; await w.close(); }
      } catch { /* the stream stopped: the rest is not written */ }
    })();
    const rd = ds.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await rd.read();
        if (done) return null;
        // (the page's thread given a turn every TURN_BYTES out: a paint, a timer, Cancel's click --
        // an 800 MB gzip held it 3.9 s with none, r77 Q3; and a load stopped meanwhile stops here)
        seen += value.byteLength; // (all output, a member read again too)
        if (seen - turned >= TURN_BYTES) {
          if (await turnNow()) { await rd.cancel().catch(() => {}); throw new StopRead(); }
        }
        if (n + value.byteLength > max) {
          await rd.cancel();
          // (in the limit's own size, and "opens" only of the file limit: under it, the list check's
          // 64 MB read "over 0 GB, more than this viewer opens" -- r77 A9)
          const size = max >= 2 ** 30 ? `${(max / 2 ** 30).toFixed(0)} GB` : `${Math.round(max / 2 ** 20)} MB`;
          throw new RangeError(`it unpacks to over ${size}, ${max >= MAX_FILE_BYTES ? 'more than this viewer opens' : 'more than is read here'}`);
        }
        take(value, n);
        n += value.byteLength;
        if (head && n >= head) { await rd.cancel().catch(() => {}); return 'head'; }
      }
    } catch (e) {
      if (e instanceof StopRead) throw e;
      if (e instanceof RangeError) throw new Error(`the ${format === 'gzip' ? 'gzip file' : 'zip entry'} is too big: ${e.message}`);
      return e;
    } finally {
      over = true;
    }
  };
  for (;;) {
    const from = n;
    // (each member's start, by the time: many small members give too little output to turn by it)
    if (off && clock() - turnedAt >= TURN_MS && await turnNow()) throw new StopRead();
    const stopped = await stream(off ? u8.subarray(off) : u8);
    if (!stopped || stopped === 'head') return n;
    // (a stream that stopped before taking all its input stopped at the member's end: in the piece it
    // was given last, or the one before -- so the search starts there, and a valid member holding 300
    // header-like runs before its end was refused in Chromium, each tried: r80 Q5. One that took it
    // all, the whole member searched)
    const searchFrom = allFed ? off + 12 : Math.max(off + 12, off + fed - FEED);
    let next = -1;
    if (format === 'gzip') {
      // (only a header whose member's trailer, just before it, could be this member's is read to: a
      // false 1f 8b 08 in a cut-short file's data, each read again from the member's start, made the
      // refusal quadratic)
      const made = n - from;
      // (and the bytes read again bounded, not the headers tried: each try reads the member again
      // from its start -- a crafted file of 4,001 fake headers inflated 4 GB to be refused (r75 A5),
      // and a count of 16 refused a valid file whose large first member held 17 by chance (r76 A7))
      // (from 12 bytes in: a header is 10, the shortest deflate 2 -- from 18, an empty member's end
      // was passed over: r74 A2, Q5)
      for (let p = u8.indexOf(0x1f, searchFrom); p >= 0 && p + 3 <= u8.length; p = u8.indexOf(0x1f, p + 1)) {
        if (u8[p + 1] !== 0x8b || u8[p + 2] !== 8) continue;
        const isize = (u8[p - 4] | (u8[p - 3] << 8) | (u8[p - 2] << 16) | (u8[p - 1] << 24)) >>> 0;
        // (at least what came, and no more than one piece's output past it: what a stopped stream
        // drops -- r75 Q1, r76 A7. The upper bound only spares tries, which the budget bounds anyway:
        // a cost no arm can tell -- r80 Q7)
        if (isize < made || isize - made > DROPPED_MOST) continue;
        // (the budget from what this member's first stream gave too: from what came before alone, a
        // 100 MB first member with one chance header before its end was refused -- r76 Q1)
        if (reread > REREAD_MOST + 2 * from + 4 * made) break;
        // (a turn and the caller's stop here too, by the time: a member corrupt at its first byte and
        // copies of a header after it held Chromium 250 s, never asked -- r79 Q1)
        if (clock() - turnedAt >= TURN_MS && await turnNow()) throw new StopRead();
        n = from;
        const r = await stream(u8.subarray(off, p));
        // (a try that fails charged at least a piece: one that inflated nothing cost nothing, and the
        // tries were never bounded -- r79 Q1; one that finds the end, what it read, as before: charged
        // a piece each, a valid gzip of 16,387 small members ran out of budget)
        reread += r ? Math.max(n - from, FEED) : n - from;
        if (r === 'head') return n;
        if (!r) { next = p; break; }
      }
    }
    if (next < 0) {
      if (head) return n;
      throw new Error(`the ${what} data is corrupt or truncated (${stopped.message || stopped})`);
    }
    off = next;
  }
}

// The first n bytes a gzip unpacks to, read as the page reads it -- every member -- from as much of
// it as is at hand (a file's start: a stream cut short gives what it has); null when it cannot be
// read (no DecompressionStream, past the limit), an empty view when it unpacks to nothing.
// The list check's sniff: its own single-member reader of 4 KB disagreed with the page twice, a gzip
// whose first member is short, and a PLY header past 4 KB (r74 A1, A3)
export async function inflateHead(buf, n, format = 'gzip') {
  if (typeof DecompressionStream === 'undefined') return null;
  const out = new Uint8Array(n);
  let got = 0;
  try {
    got = await readMembers(buf, format, Infinity, (value, at) => {
      if (at < n) out.set(value.subarray(0, n - at), at);
    }, n);
  } catch { return null; }
  // (nothing out is an empty view, not null: null said both "will not inflate" and "inflates to
  // nothing", and an empty a.stl.gz was "its gzip could not be read here" -- r78 A5)
  return out.subarray(0, Math.min(got, n));
}

// The output buffer's first size: the gzip trailer's length, else 4x the input -- never past what
// deflate can produce from this input (1032:1), so a 20-byte file claiming 2 GB allocates 20 KB
export function firstSize(buf, format, max) {
  const len = buf.byteLength;
  const most = Math.min(max, 1032 * len + 1024);
  if (format === 'gzip' && len >= 18) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const isize = (b[len - 4] | (b[len - 3] << 8) | (b[len - 2] << 16) | (b[len - 1] << 24)) >>> 0;
    return Math.min(most, isize);
  }
  return Math.min(most, 4 * len);
}

// buf -> the raw .cadmesh bytes (buf itself when it is not gzipped)
// (stop: as gunzip's -- a StopRead passed on as it is, not a "cadmesh:" fault)
export async function inflateCadmesh(buf, stop = null) {
  if (!isGzip(buf)) return buf;
  try {
    return await gunzip(buf, MAX_FILE_BYTES, stop);
  } catch (e) {
    if (e instanceof StopRead) throw e;
    throw new Error(`cadmesh: ${e.message}`);
  }
}

// raw .cadmesh bytes -> gzip, for writing a file
export function deflateCadmesh(buf) {
  return pipeBytes(buf, new CompressionStream('gzip'));
}

// A .cadmesh cut short, by its own header: head (its first bytes) and its size -> the decoder's
// refusal in its words, { need: n } when the header runs past head (read n bytes and ask again), or
// null. decodeCadmesh's rule, the list check's too: a download stopped halfway was "ok", the page
// refusing it -- section normal out of range (r82 A3)
export function cadmeshCut(head, size) {
  if (size < 12 || head.length < 12) return size < 12 ? 'cadmesh: file too short' : { need: 12 };
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== VERSION) return null; // (the decoder says those)
  const jlen = dv.getUint32(8, true);
  if (12 + jlen > size) return 'cadmesh: truncated header';
  if (12 + jlen > head.length) return { need: 12 + jlen };
  let header;
  try { header = JSON.parse(new TextDecoder().decode(head.subarray(12, 12 + jlen))); } catch { return null; }
  if (!header || typeof header.sections !== 'object' || !header.sections) return null;
  const dataStart = align8(12 + jlen);
  // (in the decoder's order: the sections it views first)
  const names = ['position', 'normal', 'color', 'id', 'index', ...Object.keys(header.sections).filter((n) => !['position', 'normal', 'color', 'id', 'index'].includes(n))];
  for (const name of names) {
    const s = header.sections[name];
    if (s && dataStart + s.offset + s.byteLength > size) return `cadmesh: section ${name} out of range (truncated file?)`;
  }
  return null;
}

// Returns { header, position:Float32Array, normal:Int16Array, color:Uint8Array,
//           id:Uint8Array, index:Uint32Array, faces:Uint32Array|null } as views
// into buf (no copies). An optional section the file lacks is null.
export function decodeCadmesh(buf) {
  if (buf.byteLength < 12) throw new Error('cadmesh: file too short');
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('cadmesh: bad magic (not a .cadmesh file)');
  const ver = dv.getUint32(4, true);
  if (ver !== VERSION) throw new Error(`cadmesh: unsupported version ${ver}`);
  const jlen = dv.getUint32(8, true);
  if (12 + jlen > buf.byteLength) throw new Error('cadmesh: truncated header');
  // a header that is not JSON, or JSON that is not an object, said as such,
  // not as the engine's own words ("Cannot read properties of null")
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, jlen)));
  } catch (e) {
    throw new Error(`cadmesh: the header is not JSON (${e.message})`);
  }
  if (!header || typeof header !== 'object' || Array.isArray(header) || !header.sections || typeof header.sections !== 'object') {
    throw new Error('cadmesh: the header is not a cadmesh header (no sections)');
  }
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
  for (const [s, Ctor] of Object.entries(OPTIONAL)) out[s] = header.sections[s] ? view(s, Ctor) : null;
  // An index past the vertex data draws nothing on WebGL2 (INVALID_OPERATION,
  // no error shown) and garbage on WebGPU: refuse it here, loudly.
  const vc = header.vertexCount;
  const idx = out.index;
  for (let i = 0; i < idx.length; i++) {
    if (idx[i] >= vc) throw new Error(`cadmesh: index ${i} names vertex ${idx[i]} of ${vc}`);
  }
  // and a body's triangles name only its own vertices (the encoder writes no
  // other kind): the edge list welds and tests closure per body, and one
  // reaching into another body's vertices came out "closed" (cut-filled)
  for (const [mi, m] of header.meshes.entries()) {
    const lo = m.vtxStart, hi = m.vtxStart + m.vtxCount;
    for (let i = m.idxStart; i < m.idxStart + m.idxCount; i++) {
      if (idx[i] < lo || idx[i] >= hi) throw new Error(`cadmesh: mesh ${mi} index ${i} names vertex ${idx[i]}, outside its own ${lo}..${hi - 1}`);
    }
  }
  // the coordinates the view can hold (MAX_COORD, the mesh readers' bound): every model reaches the
  // view through here -- a .cadmesh opened, a STEP file's conversion -- and one at 1e20 decoded
  // while the same triangle as an STL was refused
  const pos = out.position;
  for (let i = 0; i < pos.length; i++) {
    if (!(Math.abs(pos[i]) <= MAX_COORD)) throw new Error(`cadmesh: too large to show (a coordinate past ${MAX_COORD_WORDS})`);
  }
  for (const s of ['edges', 'silhouettes']) {
    const e = out[s];
    if (!e) continue;
    for (let i = 0; i < e.length; i++) {
      if (e[i] >= vc) throw new Error(`cadmesh: ${s} entry ${i} names vertex ${e[i]} of ${vc}`);
    }
  }
  // each face's triangles lie inside its own mesh
  if (out.faces) {
    const fc = out.faces;
    for (const [mi, m] of header.meshes.entries()) {
      const t0 = m.idxStart / 3;
      const t1 = (m.idxStart + m.idxCount) / 3;
      for (let f = m.faceStart; f < m.faceStart + m.faceCount; f++) {
        if (fc[f * 2 + 1] && (fc[f * 2] < t0 || fc[f * 2] + fc[f * 2 + 1] > t1)) {
          throw new Error(`cadmesh: face ${f} (triangles ${fc[f * 2]} + ${fc[f * 2 + 1]}) is outside mesh ${mi}`);
        }
      }
    }
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
  // (a box's corners held to the coordinates' bound too, in the same words: the view frames by the
  // stored boxes, and one of +-1e38 over in-range positions decoded)
  const box = (b) => {
    if (!(b && vec3(b.min) && vec3(b.max))) return false;
    if ([...b.min, ...b.max].some((x) => Math.abs(x) > MAX_COORD)) bad(`too large to show (a coordinate past ${MAX_COORD_WORDS})`);
    return true;
  };
  if (!ok(h.vertexCount) || !ok(h.indexCount)) bad('header vertex/index counts missing or invalid');
  if (h.indexCount % 3) bad('index count is not a whole number of triangles');
  if (h.vertexCount ? !box(h.bbox) : h.bbox !== null) bad('header bounding box malformed');
  // each section must be exactly the size its count implies
  const want = { position: 12 * h.vertexCount, normal: 8 * h.vertexCount, color: 4 * h.vertexCount, id: 4 * h.vertexCount, index: 4 * h.indexCount };
  for (const [s, len] of Object.entries(want)) {
    const sec = h.sections && h.sections[s];
    if (!sec || !ok(sec.offset) || sec.byteLength !== len || sec.offset % 8) bad(`section ${s} does not match the header counts`);
  }
  const fsec = h.sections.faces;
  if (fsec !== undefined && (!fsec || !ok(fsec.offset) || fsec.offset % 8 || !ok(fsec.byteLength) || fsec.byteLength % 8)) {
    bad('section faces is not whole (first, count) pairs');
  }
  const faceTotal = fsec ? fsec.byteLength / 8 : 0;
  // the edge sections: whole vertex pairs, and two normals per silhouette pair
  for (const s of ['edges', 'silhouettes', 'silhouetteNormals']) {
    const sec = h.sections[s];
    if (sec !== undefined && (!sec || !ok(sec.offset) || sec.offset % 8 || !ok(sec.byteLength) || sec.byteLength % 8)) {
      bad(`section ${s} is not whole pairs`);
    }
  }
  const sil = h.sections.silhouettes;
  const siln = h.sections.silhouetteNormals;
  if (!!sil !== !!siln || (sil && siln.byteLength !== sil.byteLength * 2)) bad('silhouette normals do not match the silhouette edges');
  if (h.facts !== undefined) {
    const f = h.facts;
    const list = (a, test) => Array.isArray(a) && a.length === (h.meshes || []).length && a.every(test);
    if (!f || typeof f !== 'object') bad('facts are not an object');
    // (each per-body fact by its kind, js/edges.js BODY_FACTS and KINDS: the ones always written
    // required; the refusal names the fact and its kind)
    for (const { key, kind, always } of BODY_FACTS) {
      if (f[key] === undefined && !always) continue;
      if (!list(f[key], KINDS[kind].test)) bad(`facts' ${key} is not one ${KINDS[kind].named} per mesh`);
    }
    if (h.factsRule !== undefined && !Number.isInteger(h.factsRule)) bad('factsRule is not a whole number');
  }
  // (its factsRule may be missing: round 43 wrote { error, sizeLimit }, read now as a record of no
  // rule -- built again, not refused whole: r45 Q6)
  if (h.edgesFailed !== undefined && !(h.edgesFailed && typeof h.edgesFailed.error === 'string'
    && (h.edgesFailed.factsRule === undefined || Number.isInteger(h.edgesFailed.factsRule)))) {
    bad('edgesFailed is not { error, factsRule? }');
  }
  // (a failed build and facts both: no writer makes one, and which to believe is no question -- r44 A1)
  if (h.edgesFailed !== undefined && h.facts !== undefined) bad('edgesFailed beside facts');
  if (h.sourceUnits !== undefined && typeof h.sourceUnits !== 'string') bad('sourceUnits is not a string');
  if (h.recolour !== undefined && typeof h.recolour !== 'string') bad('recolour is not a string');
  if (h.angularDeflection !== undefined && !(Number.isFinite(h.angularDeflection) && h.angularDeflection > 0)) {
    bad('angularDeflection is not a positive number');
  }
  if (!Array.isArray(h.meshes)) bad('header has no mesh list');
  const n = h.meshes.length;
  // the meshes' ranges follow one another, as encodeCadmesh writes them: overlapping ranges made
  // the per-mesh index check cost meshes x indices (3000 meshes on the same 3M indices: 20 s)
  let idxEnd = 0, vtxEnd = 0, faceEnd = 0;
  for (const [i, m] of h.meshes.entries()) {
    if (!m || !ok(m.vtxStart) || !ok(m.vtxCount) || !ok(m.idxStart) || !ok(m.idxCount)
      || m.vtxStart + m.vtxCount > h.vertexCount || m.idxStart + m.idxCount > h.indexCount) {
      bad(`mesh ${i} range is outside the vertex/index data`);
    }
    if (m.idxStart < idxEnd || m.vtxStart < vtxEnd) bad(`mesh ${i} range overlaps the mesh before it`);
    idxEnd = m.idxStart + m.idxCount;
    vtxEnd = m.vtxStart + m.vtxCount;
    if (m.vtxCount ? !box(m.bbox) : !(m.bbox === null || box(m.bbox))) bad(`mesh ${i} bounding box malformed`);
    if (m.name !== undefined && m.name !== null && typeof m.name !== 'string') bad(`mesh ${i} name is not text`);
    // (one angle a file, the header's: a mesh's own, which no writer emits, went unchecked into the
    // circle test -- "x", -1, 1e-6 on a mesh row each dropped a washer's circles to 0)
    if (m.angularDeflection !== undefined) bad(`mesh ${i} has an angularDeflection of its own: a file has one, in its header`);
    if (m.kind !== undefined && m.kind !== null && !BODY_KINDS.includes(m.kind)) bad(`mesh ${i} kind "${m.kind}" is not one of ${BODY_KINDS.join(', ')}`);
    // the UI maps a body's colour to #rrggbb: anything else threw there
    if (m.color !== undefined && m.color !== null
      && !(Array.isArray(m.color) && (m.color.length === 3 || m.color.length === 4) && m.color.every(Number.isFinite))) {
      bad(`mesh ${i} colour is not 3 or 4 numbers`);
    }
    if (fsec && (!ok(m.faceStart) || !ok(m.faceCount) || m.faceStart + m.faceCount > faceTotal)) {
      bad(`mesh ${i} face range is outside the faces section`);
    }
    if (fsec) {
      if (m.faceStart < faceEnd) bad(`mesh ${i} face range overlaps the mesh before it`);
      faceEnd = m.faceStart + m.faceCount;
    }
  }
  // each body is named by at most one tree node, once (the encoder writes each once): a tree
  // naming one body a million times is 3 KB gzipped and built a million rows on the page's thread
  const named = new Uint8Array(n);
  const walk = (node, depth) => {
    if (depth > 256) bad('assembly tree deeper than 256 levels (cycle?)');
    if (!node || !Array.isArray(node.meshes) || !Array.isArray(node.children)) bad('malformed assembly tree node');
    // (names are text, or absent: a name of 5 passed here and failed later in the tour and
    // colour code's own engine words)
    if (node.name !== undefined && node.name !== null && typeof node.name !== 'string') bad('an assembly tree node name is not text');
    for (const i of node.meshes) {
      if (!Number.isInteger(i) || i < 0 || i >= n) bad(`assembly tree names mesh ${i} of ${n}`);
      if (named[i]) bad(`assembly tree names mesh ${i} more than once`);
      named[i] = 1;
    }
    for (const c of node.children) walk(c, depth + 1); // (a header from JSON.parse shares no node)
  };
  walk(h.root, 0);
}

// seven significant digits: a float32's worth, in a short JSON number
const sig7 = (x) => Number(x.toPrecision(7));
// (numbers to 7 significant figures; a fact not always written only when one body has it)
const roundFacts = (f) => Object.fromEntries(BODY_FACTS.filter(({ key, always }) => always || (f[key] && f[key].some(Boolean)))
  .map(({ key, kind }) => [key, KINDS[kind].rounded ? f[key].map(sig7) : f[key]]));

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

// A conversion's result as the model both converters encode (the page's js/step-worker.js and
// stp2mesh.mjs): the meshes, the unit the file declared, the angular deflection it was meshed at
export function conversionModel(result, { sourceUnits = null, angularDeflection } = {}) {
  const model = occtResultToModel(result);
  model.sourceUnits = sourceUnits;
  model.angularDeflection = angularDeflection;
  return model;
}

// The header facts about the whole model that a tool rebuilding a .cadmesh from a decoded one
// carries over (split-board.mjs), as encodeCadmesh's model keys: one list, so a new fact is
// carried by every such tool
export const MODEL_FACTS = ['units', 'sourceUnits', 'angularDeflection', 'recolour'];
export const modelFactsOf = (header) => Object.fromEntries(MODEL_FACTS.filter((k) => header[k] !== undefined && header[k] !== null).map((k) => [k, header[k]]));

// occt-import-js ReadStepFile/ReadFile result -> model for encodeCadmesh.
// Per-face b-rep colours become per-vertex colours (OCCT meshes each face
// with its own vertices, so a face's triangles own their vertex range).
export function occtResultToModel(result, units = MM) {
  // (said for IGES and BREP too, naming no library, with what to try: r21)
  if (!result || !result.success) {
    // (OpenCascade reports running out of memory while reading the same way,
    // so that is named too: a re-export alone would fail again, r23)
    throw new Error('import failed: the converter could not read this file. It may be damaged or cut short, '
      + 'not the format its name says, or too big for this device\'s memory; re-export it from the CAD program, '
      + 'try another of its formats, or open it on a computer with more memory');
  }
  const meshes = result.meshes.map((m) => {
    const positions = Float32Array.from(m.attributes.position.array);
    const normals = m.attributes.normal ? Float32Array.from(m.attributes.normal.array) : null;
    const indices = Uint32Array.from(m.index.array);
    let colors = null;
    const faces = m.brep_faces || [];
    if (faces.some((f) => f.color)) {
      const base = m.color || DEFAULT_GREY;
      colors = new Uint8Array((positions.length / 3) * 4);
      for (let v = 0; v < positions.length / 3; v++) {
        colors[v * 4] = toByte(base[0]); colors[v * 4 + 1] = toByte(base[1]); colors[v * 4 + 2] = toByte(base[2]);
      }
      for (const f of faces) {
        if (!f.color) continue;
        for (let t = f.first; t <= f.last; t++) {
          for (let k = 0; k < 3; k++) {
            const v = indices[t * 3 + k];
            colors[v * 4] = toByte(f.color[0]); colors[v * 4 + 1] = toByte(f.color[1]); colors[v * 4 + 2] = toByte(f.color[2]);
          }
        }
      }
    }
    // a status this code does not know is dropped, so an advisory field never
    // fails a conversion (the strings come from BodyKind in progress.patch)
    const kind = BODY_KINDS.includes(m.brep_kind) ? m.brep_kind : null;
    // the b-rep faces, kept: brep_faces' first/last are inclusive triangle
    // numbers in this mesh (last < first: the face was not meshed)
    const fpairs = new Uint32Array(faces.length * 2);
    faces.forEach((f, i) => {
      fpairs[i * 2] = f.last < f.first ? 0 : f.first;
      fpairs[i * 2 + 1] = f.last < f.first ? 0 : f.last - f.first + 1;
    });
    return { name: m.name, color: m.color || null, positions, normals, colors, indices, kind, faces: m.brep_faces ? fpairs : null };
  });
  const conv = (n) => ({ name: n.name || '', meshes: n.meshes || [], children: (n.children || []).map(conv) });
  const root = conv(result.root);
  if (!meshes.some((m) => m.color || m.colors)) paletteByPart(meshes, root);
  // b-rep faces that came back with no triangles: OpenCascade drops a face it
  // could not mesh (out of memory, a meshing failure) without an error, and
  // nothing else says so. None on occt-import-js's test files, our models and
  // the rack with the current converter; 2 on the rack when it ran out of
  // memory (2026-10-25 audits).
  const unmeshedFaces = result.meshes.reduce((n, m) => n + (m.brep_faces || []).filter((f) => f.last < f.first).length, 0);
  // faces the converter added to close planar holes (null from a build
  // without CapPlanarHoles)
  const brepCaps = Number.isInteger(result.brep_caps) ? result.brep_caps : null;
  return { units, meshes, root, unmeshedFaces, brepCaps };
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

// One colour per part: the nearest named node above each body names its part, and the part's
// name picks its palette colour. The converter colours a colourless file so, and the "By part
// name" scheme (js/palettes.js) is the same rule, so the two always agree.
export function partColours(meshes, root) {
  const owner = new Array(meshes.length).fill('');
  const walk = (n, name) => {
    const nm = n.name || name;
    for (const i of n.meshes) owner[i] = nm;
    for (const c of n.children) walk(c, nm);
  };
  walk(root, '');
  return meshes.map((m, i) => PALETTE[hashName(owner[i] || m.name || String(i)) % PALETTE.length]);
}
function paletteByPart(meshes, root) {
  partColours(meshes, root).forEach((c, i) => { meshes[i].color = c; });
}

export const DEFAULT_TESSELLATION = Object.freeze({
  linearUnit: MM,
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
});

// The one rule for a body's angular deflection (its circle test, js/measure-geom.js): the one a
// merged scene gave the body (js/scene.js: its own model's), else its file's header's, else the
// converter's default (a file older than the field)
export const bodyAngle = (header, mesh) => mesh.angularDeflection ?? header.angularDeflection ?? DEFAULT_TESSELLATION.angularDeflection;
