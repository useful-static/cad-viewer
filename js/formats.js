// The files the viewer opens, in one table: each format's extensions, its kind (how it is
// opened), its label, and how its first bytes give it away. Every path that decides by name or
// by bytes reads this: the viewer's loader (js/main.js loadAny, the zip opener, a URL's file
// name, the Open… and Add model… pickers), check.html (js/list-check.js) and the converter CLI
// (stp2mesh.mjs). manifest.webmanifest's file_handlers is checked against it
// (tests/test-formats.mjs). A new format is a row here, its sniff below if it has one, and its
// reader by kind: a mesh format a case in js/mesh-formats.js parseMesh, a 2D one in
// js/read-file.js readDrawing, a CAD one OpenCascade's reader named by `cad` -- and the list check
// runs the mesh and 2D readers by these rows too (js/list-check.js readsHere), so the new reader is
// held there with nothing more. A text format is
// also a case in readsAsText (and textBytes, if its reader holds less than the whole to the text
// limit), so the page's limit and the list check hold it; one whose reader reads the files beside
// it is `companions: true` (r78 A9).
//
// Pure ES module, no DOM.

// kind: 'cad' (converted by OpenCascade: cad names its reader), 'cadmesh' (the viewer's own),
// 'mesh' (js/mesh-formats.js), '2d' (js/dxf.js, js/dwg.js), 'zip' (opened for the model in it).
// magic: every file of the format starts with bytes that say it (sniffFormat finds it, and a
// file named so that does not start so is not one). Without it the start only hints (an OBJ may
// open with any statement, a glTF's JSON keys come in any order, a binary STL has no magic): the
// viewer opens such a file by its name, so a start that says nothing is no fault.
// The DWG releases js/dwg.js reads, by the version tag a file starts with: [the release's name,
// the reader's version number]. The one table for the reader (which refuses any other tag), the
// DWG row's range below, and check.html (js/list-check.js), which called an R12 drawing "ok · DWG"
// that the page refuses (r64 A2). Kept here so this module does not load the DWG reader.
// AC1013: the R14 pre-release stamp, in which AutoCAD R14 shipped most of its own sample drawings.
export const DWG_RELEASES = {
  AC1012: ['R13', 13], AC1013: ['R14 (AC1013)', 14], AC1014: ['R14', 14], AC1015: ['R2000', 15], AC1018: ['R2004', 18],
  AC1021: ['R2007', 21], AC1024: ['R2010', 24], AC1027: ['R2013', 27], AC1032: ['R2018', 32],
};
const DWG_TAGS = Object.keys(DWG_RELEASES);
// a version tag's refusal, or null for one the reader reads: an older tag is said as older, a later
// one as later (every unread tag was "older than R13", a 2024 drawing too -- r64 A8)
// What a DWG's first six bytes are: "AC10" and two digits (R2.5 on), or a release before R10's tag
// with a point (AC1.50, AC2.10). The one rule for the sniff (isDWGBytes) and the refusal's words --
// round 65 widened the words alone, and check.html called a .dxf holding an AC2.10 DWG "ok · DXF",
// which the page refused as no DXF (r66 A3)
export const DWG_TAG = /^AC(10\d\d|\d\.\d\d)$/;
export function dwgRefusal(tag) {
  if (DWG_RELEASES[tag]) return null;
  // (a release before R10 writes its tag with a point -- AC1.50, AC2.10 --: a DWG, older; it was
  // "not a DWG file" -- r65 Q8)
  if (!DWG_TAG.test(tag)) return 'not a DWG file';
  const first = DWG_TAGS[0], last = DWG_TAGS[DWG_TAGS.length - 1];
  const where = tag.includes('.') || tag < first ? `older than ${DWG_RELEASES[first][0]}` : tag > last ? `later than ${DWG_RELEASES[last][0]}` : `no release of ${dwgRange()}`;
  return `an ${tag} DWG (${where}) is not read`; // ("an AC1009", as it is said: r65 A8)
}
const dwgRange = () => `${DWG_RELEASES[DWG_TAGS[0]][0]} to ${DWG_RELEASES[DWG_TAGS[DWG_TAGS.length - 1]][0].replace(/^R(?=\d{4})/, '')}`;

export const FORMATS = [
  { label: 'STEP', ext: ['stp', 'step'], kind: 'cad', cad: 'step', magic: true },
  { label: 'IGES', ext: ['igs', 'iges'], kind: 'cad', cad: 'iges' },
  { label: 'BREP', ext: ['brep', 'brp'], kind: 'cad', cad: 'brep', magic: true },
  { label: 'cadmesh', ext: ['cadmesh'], kind: 'cadmesh', magic: true },
  { label: 'STL', ext: ['stl'], kind: 'mesh' },
  // (companions: its reader reads the files that come with it -- an OBJ's .mtl, a .gltf's buffers and
  // pictures; no other reader looks at one)
  { label: 'OBJ', ext: ['obj'], kind: 'mesh', companions: true },
  { label: 'PLY', ext: ['ply'], kind: 'mesh', magic: true },
  { label: 'OFF', ext: ['off'], kind: 'mesh' },
  { label: '3MF', ext: ['3mf'], kind: 'mesh', magic: true, as: 'zip' },
  // (a GLB reads a buffer or picture its JSON names by uri, beside it: r79 A1)
  { label: 'GLB', ext: ['glb'], kind: 'mesh', magic: true, companions: true },
  { label: 'glTF', ext: ['gltf'], kind: 'mesh', companions: true },
  { label: 'DXF', ext: ['dxf'], kind: '2d' },
  // (range: the releases js/dwg.js reads, said in "opens": DWG_RELEASES' first to last)
  { label: 'DWG', ext: ['dwg'], kind: '2d', magic: true, range: dwgRange() },
  { label: 'zip', ext: ['zip'], kind: 'zip', magic: true },
];
// (as: a 3MF is a zip, and its start says only that)
const BY_EXT = new Map(FORMATS.flatMap((f) => f.ext.map((e) => [e, f])));

// files that come with a model and are not one: an OBJ's .mtl, a .gltf's buffers and pictures
export const COMPANION_EXT = ['mtl', 'bin', 'png', 'jpg', 'jpeg', 'webp', 'ktx2'];
// (by its own last extension: no reader unpacks a companion, so photo.png.gz is no picture -- by
// extOf, which reads past a .gz, it was taken, and a bzip2 one refused the zip: r80 A2)
export const isCompanion = (name) => { const m = /\.([a-z0-9]+)$/i.exec(String(name || '').split(/[?#]/)[0]); return !!m && COMPANION_EXT.includes(m[1].toLowerCase()); };
// A companion file's key: its name without a directory (cut at / or \) and without case. A map's
// own keys are read by it too, so a map keyed by bare name (a drop: main.js keys by File.name) and
// one keyed by path both match.
export const companionKey = (ref) => String(ref).split(/[/\\]/).pop().toLowerCase();
// The file a reference names among a model's companions (a Map of name -> file), or null: by its path
// first, where the map has paths (a zip's, named by their path from the model's folder: zipCompanions)
// -- a glTF's "textures/wood.png" is that file, not a wood.png beside the model (by name alone,
// another folder's took its place: r54 A3, Q1); \ read as /, a leading ./ dropped -- then by name.
// The one lookup for the mesh readers and the list check (r80 Q3)
const pathKey = (ref) => String(ref).replace(/\\/g, '/').replace(/^(\.\/)+/, '').toLowerCase();
export function companionOf(files, ref) {
  const p = pathKey(ref);
  for (const [n, f] of files) if (pathKey(n) === p) return f;
  const k = companionKey(ref);
  if (files.has(k)) return files.get(k);
  for (const [n, f] of files) if (companionKey(n) === k) return f;
  return null;
}
// The extensions a glTF may require: KHR_mesh_quantization (integer and normalized attributes are
// read, its dequantization the node transform, baked in) and EXT_mesh_gpu_instancing (each instance
// placed); every other is refused by name, compression in its own words. -> the reader's refusal of
// a JSON's extensionsRequired, or null: js/mesh-formats.js parseGLTF's and the list check's (a Draco
// GLB was "ok" there, the page refusing it: r81 A5)
const GLTF_EXTENSIONS_READ = ['KHR_mesh_quantization', 'EXT_mesh_gpu_instancing'];
const GLTF_COMPRESSION = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'];
export function gltfRefusal(json, file) {
  const required = json && Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  const packed = required.filter((x) => GLTF_COMPRESSION.includes(x));
  if (packed.length) return `${file} needs ${packed.join(', ')}, which this viewer does not decode: export it without compression`;
  const unread = required.filter((x) => !GLTF_EXTENSIONS_READ.includes(x)).map((x) => String(x).slice(0, 80));
  return unread.length ? `${file} needs the glTF extension${unread.length > 1 ? 's' : ''} ${unread.join(', ')}, which this viewer does not read` : null;
}
// The glTF reader's refusals in their one wording, js/mesh-formats.js parseGLTF's and the list check's,
// which wrote each out again (r83 A6): its JSON that does not parse, no JSON, a buffer not beside it
export const GLTF_WORDS = {
  unparsed: (what, e) => `${what} is damaged: its JSON does not parse (${e && e.message ? e.message : e})`,
  noJson: (file) => `${file} is damaged: it holds no glTF JSON`,
  needs: (file, uri) => `${file} needs ${uri}: drop it together with the .${extOf(file)}`,
};
// The reader's refusal of a glTF JSON's shape before its buffers are read, in its order -- no JSON,
// one not an object, a list that is not one, an extension it does not read -- or null; and of one
// buffer (hasBin: a GLB with its BIN chunk; found(name): a companion beside it). The one set of rules
// for js/mesh-formats.js parseGLTF and the list check, which skipped each and said "ok" of seven
// files the page refuses (r84 A3)
const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export function gltfShapeRefusal(json, file) {
  const damaged = (w) => `${file} is damaged: ${w}`;
  if (!json) return GLTF_WORDS.noJson(file);
  if (!isPlain(json)) return damaged('its JSON is not an object');
  const notList = (x) => x !== undefined && !Array.isArray(x);
  if (notList(json.extensionsRequired)) return damaged('"extensionsRequired" is not a list');
  const ext = gltfRefusal(json, file);
  if (ext) return ext;
  for (const k of ['accessors', 'bufferViews', 'nodes', 'meshes', 'buffers']) if (notList(json[k])) return damaged(`"${k}" is not a list`);
  return null;
}
export function gltfBufferRefusal(b, i, file, hasBin, found) {
  const damaged = (w) => `${file} is damaged: ${w}`;
  if (!isPlain(b)) return damaged(`buffer ${i} is not an object`);
  if (b.uri === undefined) return i === 0 && hasBin ? null : damaged(`buffer ${i} has no data`);
  if (typeof b.uri !== 'string') return damaged(`buffer ${i}'s uri is not text`);
  if (b.uri.startsWith('data:')) return null;
  let nm;
  try { nm = decodeURIComponent(b.uri); } catch { return damaged(`buffer ${i}'s uri "${b.uri.length > 80 ? `${b.uri.slice(0, 80)}...` : b.uri}" cannot be read`); }
  return found(nm) ? null : GLTF_WORDS.needs(file, b.uri);
}
// A GLB's chunks as its reader walks them, from read(at, n) (async: bytes of a file of `size`): its
// header, then each chunk's length and type -> { chunks: [{ type, at, len }] } or { damaged } in the
// reader's words; most: the chunks walked at most (the list check's, by range), past it { more }.
// The one walk for js/mesh-formats.js parseGLTF and the list check, which read the JSON at byte 20
// whatever the first chunk was, and never saw one cut short (r82 A3, A4)
export const GLB_JSON = 0x4e4f534a, GLB_BIN = 0x004e4942;
export async function glbChunks(read, size, file, most = Infinity) {
  if (size < 12) return { damaged: `${file} is damaged: ${size} bytes, shorter than a GLB header` };
  const h = await read(0, 12);
  if (new DataView(h.buffer, h.byteOffset, 12).getUint32(0, true) !== 0x46546c67) return { damaged: `${file}: not a GLB file` };
  const chunks = [];
  for (let o = 12; o + 8 <= size;) {
    if (chunks.length >= most) return { chunks, more: true };
    const c = await read(o, 8), dv = new DataView(c.buffer, c.byteOffset, 8);
    const len = dv.getUint32(0, true), type = dv.getUint32(4, true);
    if (o + 8 + len > size) return { chunks, damaged: `${file} is damaged: a chunk runs past the end of the file` };
    chunks.push({ type, at: o + 8, len });
    o += 8 + len;
  }
  return { chunks };
}
// Whether a model of this format (its label) is read with its companions: the one rule for the page
// (main.js loadMeshFile reads them only then) and the list check (which judges them only then) -- the
// page read every mesh's, and refused a zipped STL for a bzip2 picture beside it; the check judged a
// STEP's and a DXF's, which the page never reads (r78 A1, A2)
export const takesCompanions = (label) => !!FORMATS.find((f) => f.label === label)?.companions;
// The mesh format the page reads a mesh-named file as, from its name and first bytes: a mesh format's
// magic in its start wins over the name (a PLY header, a GLB's "glTF"), else the name's; null when the
// name is no mesh's. The one rule for the page's reader (js/mesh-formats.js meshFormatOf), the
// companions it reads (main.js loadMeshFile) and the list check, which worked it out in three places
// (r79 A8). A FORMATS row.
export function meshReaderOf(name, start) {
  const f = formatOfName(name);
  if (!f || f.kind !== 'mesh') return null;
  const s = start && start.length ? sniffFormat(start.subarray(0, SNIFF_BYTES)) : null;
  return s && s.magic && s.kind === 'mesh' ? s : f;
}
// The same for a 2D-named file: a DWG by its tag whatever its name (DWG_TAG), else the name's; null
// when the name is no drawing's. main.js loadDxf's reader and js/read-file.js readDrawing's case, and
// the list check's (a boolean "DWG or not" read any other 2D format as a DXF: r80 A4)
export function drawingReaderOf(name, start) {
  const f = formatOfName(name);
  if (!f || f.kind !== '2d') return null;
  return start && isDWGBytes(start) ? BY_EXT.get('dwg') : f;
}
// The reader the page meets for a file of this name and (unpacked) start: a mesh's or a drawing's by
// the rules above, else the format its name says, else -- a name that says none -- its bytes'
// (openedName). The list check's size and text rules run by it (they ran by the bytes' format, and a
// DXF named part.stl, which the page reads as an STL and refuses, was a warning: r80 A6)
export function readerOf(name, start) {
  return meshReaderOf(name, start) || drawingReaderOf(name, start) || formatOfName(name)
    || (start && start.length ? sniffFormat(start.subarray(0, SNIFF_BYTES)) : null);
}

// a name's extension, lower case, after any query and a .gz ("part.STP.gz?v=2" -> "stp")
export function extOf(name) {
  const base = String(name || '').split(/[?#]/)[0].replace(/\.gz$/i, '');
  const m = /\.([a-z0-9]+)$/i.exec(base);
  return m ? m[1].toLowerCase() : '';
}

// the format a name says, or null
export const formatOfName = (name) => BY_EXT.get(extOf(name)) || null;

// a name that is a model file of any kind ("part.step", "board.stl.gz"): a query value naming one
// is the file a download URL serves
export const MODEL_NAME = new RegExp(`\\.(?:${[...BY_EXT.keys()].join('|')})(?:\\.gz)?$`, 'i');

// The file name a URL names -- what the viewer shows, announces, offers to Save and opens by:
//   rack.cadmesh?v=2                        -> rack.cadmesh   (the path's, query dropped)
//   /api/download?file=part.step&token=abc  -> part.step      (a query value naming a model file)
//   /get.php?file=board.stl                 -> board.stl      (the path's name is no model file)
//   /api/download?id=7                      -> download       (no model name anywhere)
// Decoded, so "my%20part.stp" is "my part.stp".
export function fileNameOfUrl(url) {
  const [path, query = ''] = String(url).split('#')[0].split('?');
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const tail = dec(path.split('/').pop());
  if (MODEL_NAME.test(tail)) return tail;
  for (const kv of query.split('&')) {
    const v = dec(kv.slice(kv.indexOf('=') + 1)).split('/').pop();
    if (MODEL_NAME.test(v)) return v;
  }
  return tail;
}

// A DWG by its bytes: its tag (DWG_TAG; the releases in DWG_RELEASES are read, any other reaches
// the reader, which refuses it in dwgRefusal's words)
export const isDWGBytes = (b) => b.length >= 6 && DWG_TAG.test(String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]));

// The format a file's first bytes say (after gunzip), or null. A binary STL has no magic (its
// header is free text): only its name says it. 3MF and a zip of models are both zips: a zip is
// "zip" here, and a 3MF by its name.
// An ASCII DXF's start: its first SECTION, after any 999 comments (LibreDWG writes one first; 174
// of 1178 DXFs at hand) -- one rule for the sniff here and the reader (js/dxf.js parseDXF)
// (a plain walk over the lines: a regex with a repeated comment group split blank lines many
// ways, and a 127-byte "999" + newlines file took 27 s to fail -- exponential backtracking)
function dxfHead(text) {
  const lines = text.split(/\r?\n/, 4096);
  let i = 0;
  const blank = () => { while (i < lines.length && !lines[i].trim()) i++; };
  blank();
  while (i + 1 < lines.length && lines[i].trim() === '999') { i += 2; blank(); }
  // (a stray number line before the first pair, as before)
  if (/^\d+$/.test((lines[i] || '').trim()) && (lines[i] || '').trim() !== '0' && (lines[i + 1] || '').trim() === '0') i++;
  return (lines[i] || '').trim() === '0' && (lines[i + 1] || '').trim() === 'SECTION';
}
// how much of a file's start the sniff reads (every caller passes this much): room for a DXF's
// 999 comments or an OBJ's comment header, which ran past 400 bytes and left a valid file unnamed
export const SNIFF_BYTES = 4096;
// A text file or zip part becomes one string, and an engine string holds at most ~512 M
// characters: a larger one is refused in words before it is decoded (a 3MF part inflating to
// 600 MB met the engine's "Cannot create a string longer than 0x1fffffe8 characters"). One limit for
// every text reader -- the mesh formats' and the ASCII DXF's, which had none: r70 Q5
export const MAX_TEXT_BYTES = 500 * 2 ** 20;
// The most triangles the mesh readers place (js/mesh-formats.js): a few hundred bytes can ask for
// billions. Here, beside the text limit, as the exports keep to it too: a file the viewer wrote it
// then refused to open (r72 A6)
export const MAX_PLACED_TRIANGLES = 10_000_000;
// and the most parts and placements -- a 3MF's base materials counted by it too
export const MAX_PLACED_PARTS = 2_000_000;
// and a glTF accessor's values, refused past this before it is allocated (3 coordinates of 3 corners
// of the triangle cap; a 200-byte file asked for 2^30 vertices) -- the GLB writer kept to the
// triangles alone, and a body of 7.6 M triangles' colours, 4 a vertex, were refused on reading (r73 A3)
export const MAX_ACCESSOR_VALUES = 9 * MAX_PLACED_TRIANGLES;
// a size as the viewer says one: whole MB of 2^20 (the text readers', the mesh readers' and the list
// check's -- four formatters in three units: r72 A8)
export const sizeMb = (n) => `${Math.round(n / 2 ** 20).toLocaleString('en-US')} MB`;
export const TEXT_LIMIT_WORDS = `more than the ${sizeMb(MAX_TEXT_BYTES)} of text this viewer reads`;
// (a size past a limit rounded up, to a tenth: rounded to whole MB, 500 MB and a byte was "500 MB of
// text, more than the 500 MB" -- r73 Q4; mbTenth the page's and the check's one-decimal figure)
export const mbTenth = (n) => (Math.ceil((n / 2 ** 20) * 10) / 10).toFixed(1);
// (in the limits' words: whole when it is, else up to a tenth -- "600 MB", "500.1 MB")
const overMb = (n) => { const t = Math.ceil((n / 2 ** 20) * 10) / 10; return Number.isInteger(t) ? t.toLocaleString('en-US') : t.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); };
export const sizeOver = (bytes) => `${overMb(bytes)} MB`; // (a size past a limit, as said: a zip entry's too -- r74 A8, Q8)
export const textOverWords = (bytes) => `${sizeOver(bytes)} of text, ${TEXT_LIMIT_WORDS}`;
export const tooMuchText = (what, bytes) => new Error(`${what} is ${textOverWords(bytes)}`);
// An STL is binary when its size is 84 + 50 n for the n its header counts (bytes 80-83), even if it
// starts "solid", or that plus a surplus under one record (padding, an appended byte or two); else
// it is read as text. The one rule for the reader (js/mesh-formats.js parseSTL) and the list check,
// which kept its own and disagreed both ways (r72 A2)
export const stlIsBinary = (size, n) => size >= 84 && 84 + 50 * n <= size && size - (84 + 50 * n) < 50;
// The entry of a zip the page opens: the first, in the zip's order, whose name is a format the viewer
// opens (not another zip), folders and __MACOSX passed over; { files, model, others } (model null
// when none). The one choice, main.js loadZip's and the list check's (which looked only at a 3MF's
// model parts, and said "ok" of a zip of a 520 MB OBJ the page refused: r75 A2)
export function zipModel(names) {
  const files = names.filter((n) => !n.endsWith('/') && !/(^|\/)__MACOSX\//i.test(n));
  const opens = (n) => { const f = formatOfName(n); return !!f && f.kind !== 'zip'; };
  const model = files.find(opens) || null;
  // (and a 3MF by its directory -- a model part under 3D/ and its relationships -- whatever its own
  // name: one fetched as /api/download?id=7 was "a zip that holds no model": r76 A6)
  const threeMf = !model && files.some((n) => /^\/?3d\/[^/]+\.model$/i.test(n)) && files.some((n) => /^\/?_rels\/\.rels$/i.test(n));
  return { files, opens, model, threeMf, others: model ? files.filter((n) => n !== model && opens(n)).length : 0 };
}
// A zip's companions for its model, each named by its path from the model's folder ("chair.mtl",
// "buffers/chair.bin", "../textures/wood.png"), which the reader resolves a reference by first
// (js/mesh-formats.js companion): a same-named file in another folder never takes the model's place
// -- by bare name, the red chair opened blue (r53 Q1), and its buffer under red/buffers/ was blue's
// (r54 Q1). A folder holding another model is that model's: its files are not this one's, and are
// not unpacked for it (a 523 KB zip unpacked 537 MB of another model's textures: r54 Q8). A shared
// folder -- textures/ beside the model's -- still serves. \ in a zip's names is read as / (r54 A3).
// -> [{ path (as stored), name }]. The one choice, main.js loadZip's (which reads every one before
// the model) and the list check's (which looked at the model alone and said "ok" of a zip whose
// bzip2 .png the page refused -- r77 A3)
export function zipCompanions(files, model, opens) {
  const norm = (n) => n.replace(/\\/g, '/');
  // (folders compared without case, as the zip's reader and the companion lookup compare names:
  // Red/chair.obj beside red/chair.mtl opened blue -- r55 Q4)
  const dir = (n) => { const s = norm(n).toLowerCase(); return s.slice(0, s.lastIndexOf('/') + 1); };
  const own = dir(model);
  // another model's folder: its folder just below where its path and this model's part -- for
  // red/source/chair.obj beside blue/source/x.obj that is blue/, so blue/textures/ is not this one's
  // (it was taken: 600 MB of another model's textures, r55 Q6); for a/x.obj beside a/b/y.obj, a/b/
  const others = files.filter((f) => f !== model && opens(f)).map(dir);
  const theirs = [];
  for (const d of others) {
    const a = own.split('/'), b = d.split('/');
    let i = 0;
    while (i < a.length - 1 && i < b.length - 1 && a[i] === b[i]) i++;
    if (i < b.length - 1) theirs.push(`${b.slice(0, i + 1).join('/')}/`);
  }
  const out = [];
  for (const n of files) {
    if (n === model || !isCompanion(n)) continue;
    const d = dir(n);
    // (under another model's folder; or in a folder above this one that holds another model, whose
    // own files those are)
    if (theirs.some((t) => d.startsWith(t)) || (d !== own && others.includes(d))) continue;
    if (d.startsWith(own)) { out.push({ path: n, name: norm(n).slice(own.length) }); continue; }
    // a folder beside the model's: named by the way up to their common folder
    const up = own.slice(0, own.length - 1).split('/');
    const there = norm(n).split('/');
    let i = 0;
    while (i < up.length && i < there.length - 1 && up[i] === there[i].toLowerCase()) i++;
    out.push({ path: n, name: `${'../'.repeat(up.length - i)}${there.slice(i).join('/')}` });
  }
  return out;
}
// The name the page opens a file under, from its name and its (unpacked) first bytes: its own where
// it says a format, else one its bytes say (".stl" for an ASCII STL at /download?id=7), else its own.
// The one rule for main.js loadAny and tests/check-tour.mjs, which kept a copy that had drifted (r79 A5)
export function openedName(name, bytes) {
  if (formatOfName(name)) return name;
  const said = bytes && bytes.length ? sniffFormat(bytes.subarray(0, SNIFF_BYTES)) : null;
  return said ? `${name.replace(/\.gz$/i, '')}.${said.ext[0]}` : name;
}
// Whether the page opens a file of this name and these first bytes (unpacked) as a zip or a 3MF: by
// its name where the name says a format (main.js loadAny; a mesh by a mesh format's magic, which a
// zip's is not: js/mesh-formats.js meshFormatOf), else by its bytes (sniffFormat). The one rule for
// the page and the list check, which took any "PK" start for a zip: a valid binary STL whose header
// starts "PK" was "not a zip file" there, and a zip's part.stl holding a zip "ok" (r77 A1)
export function opensAsZip(name, bytes) {
  const f = formatOfName(name) || (bytes ? sniffFormat(bytes.subarray(0, SNIFF_BYTES)) : null);
  return !!f && (f.kind === 'zip' || f.label === '3MF');
}
// A PLY's header, as its reader takes it: the text to end_header in its first 64 KB, its lines, and
// its format -- ascii unless a format line says otherwise. null with no end_header (damaged). The
// one rule for the reader (js/mesh-formats.js parsePLY) and the list check, which looked for "format
// ascii" in 512 bytes and called two 700 MB ASCII PLYs "ok" (a late format line, and none: r73 A2)
export function plyHeader(u8) {
  const head = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(u8.length, 65536)));
  const hdrEnd = head.indexOf('end_header');
  if (hdrEnd < 0) return null;
  const lines = head.slice(0, hdrEnd).split(/\r?\n/);
  let format = 'ascii';
  for (const l of lines) { const sp = l.trim().split(/\s+/); if (sp[0] === 'format') format = sp[1]; }
  // (where its body starts: past end_header and its line's end)
  let bodyStart = hdrEnd + 'end_header'.length;
  while (u8[bodyStart] === 13) bodyStart++;
  if (u8[bodyStart] === 10) bodyStart++;
  return { hdrEnd, lines, format, bodyStart };
}
// How much of a file its reader holds to the text limit: a PLY's body alone, its header read apart
// (the list check held the whole file, and called a 500 MB ASCII PLY bad that the page opened: r74
// Q1); every other text format, the whole
export function textBytes(label, start, size) {
  if (label === 'PLY' && start) { const ph = plyHeader(start); if (ph) return size - ph.bodyStart; }
  return size;
}
// Whether the viewer reads a file of this format as one string -- held to MAX_TEXT_BYTES -- from its
// first bytes (at least 84) and its size: by the format's own rule beside the table, so a text format
// added is said here once (r72 A2)
export function readsAsText(label, start, size) {
  const head = start ? String.fromCharCode(...start.subarray(0, Math.min(start.length, 512))) : '';
  switch (label) {
    case 'OBJ': case 'OFF': case 'glTF': return true;
    case 'STL': return start && start.length >= 84 ? !stlIsBinary(size, new DataView(start.buffer, start.byteOffset, start.byteLength).getUint32(80, true)) : false;
    case 'PLY': return start ? plyHeader(start)?.format === 'ascii' : false;
    case 'DXF': return start ? !head.startsWith(BINARY_DXF_SENTINEL) : true;
    default: return false;
  }
}
export const looksLikeDxf = (text) => dxfHead(text);
// a binary DXF's first 22 bytes: the one sentinel for the sniff here and the reader (js/dxf.js)
export const BINARY_DXF_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\x00';
export function sniffFormat(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (isDWGBytes(b)) return BY_EXT.get('dwg');
  const text = new TextDecoder('latin1').decode(b.subarray(0, Math.min(SNIFF_BYTES, b.length))).replace(/^ï»¿/, '');
  const f = (e) => BY_EXT.get(e);
  if (text.startsWith('CADM')) return f('cadmesh');
  if (/^\s*ISO-10303-21\s*;/.test(text)) return f('stp');
  if (/^\s*DBRep_DrawableShape/.test(text)) return f('brep');
  if (text.startsWith('glTF')) return f('glb');
  if (text.startsWith('PK\x03\x04')) return f('zip');
  if (/^ply\r?\n/.test(text)) return f('ply');
  if (looksLikeDxf(text) || text.startsWith(BINARY_DXF_SENTINEL)) return f('dxf');
  if (/^\s*solid[\s\S]*facet/.test(text)) return f('stl');
  if (/^\s*\{\s*"(asset|scenes|nodes|meshes)"/.test(text)) return f('gltf');
  if (/^\s*[CN]?OFF\s/.test(text)) return f('off');
  if (/^(\s*(#.*)?\r?\n)*\s*(v|o|g|mtllib)\s/.test(text)) return f('obj');
  const line = text.split(/\r?\n/)[0];
  if (line.length >= 73 && line[72] === 'S') return f('igs');
  return null;
}

// What the viewer opens, in words, from the table ("open a STEP (.stp, .step), IGES (.igs,
// .iges), BREP (.brep, .brp) or .cadmesh file, a mesh (STL, OBJ, ...), a 2D DXF or DWG, or a
// zip of one"): the end of every "not a file this viewer opens" message
export function opensText() {
  const of = (kind) => FORMATS.filter((f) => f.kind === kind);
  const cad = of('cad').map((f) => `${f.label} (${f.ext.map((e) => `.${e}`).join(', ')})`);
  const mesh = of('mesh').map((f) => f.label);
  const twoD = of('2d').map((f) => (f.range ? `${f.label} (${f.range})` : f.label));
  return `open a ${cad.slice(0, -1).join(', ')}, ${cad[cad.length - 1]} or .cadmesh file, a mesh (${mesh.join(', ')}), a 2D ${twoD.join(' or ')}, or a zip of one`;
}

// The same in short, by kind, for a hint ("a CAD file (STEP, IGES, BREP), a mesh (STL, OBJ,
// ...), a 2D DXF or DWG, or a zip of one"): the idle line, the drop card, the empty-drop note
export function opensShort() {
  const of = (kind) => FORMATS.filter((f) => f.kind === kind).map((f) => f.label);
  return `a CAD file (${of('cad').join(', ')}), a mesh (${of('mesh').join(', ')}), a 2D ${of('2d').join(' or ')}, or a zip of one`;
}

// An <input type=file> accept list: the formats of these kinds, gzipped too, and the companions
export function acceptList(kinds = ['cad', 'cadmesh', 'mesh', '2d', 'zip']) {
  const exts = FORMATS.filter((x) => kinds.includes(x.kind)).flatMap((x) => x.ext);
  return [...exts, 'gz', ...COMPANION_EXT].map((e) => `.${e}`).join(',');
}
