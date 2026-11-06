// The files the viewer opens, in one table: each format's extensions, its kind (how it is
// opened), its label, and how its first bytes give it away. Every path that decides by name or
// by bytes reads this: the viewer's loader (js/main.js loadAny, the zip opener, a URL's file
// name, the Open… and Add model… pickers), check.html (js/list-check.js) and the converter CLI
// (stp2mesh.mjs). manifest.webmanifest's file_handlers is checked against it
// (tests/test-formats.mjs). A new format is a row here, its sniff below if it has one, and its
// reader by kind: a mesh format a case in js/mesh-formats.js parseMesh, a 2D one in
// js/read-file.js readDrawing, a CAD one OpenCascade's reader named by `cad`.
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
  { label: 'OBJ', ext: ['obj'], kind: 'mesh' },
  { label: 'PLY', ext: ['ply'], kind: 'mesh', magic: true },
  { label: 'OFF', ext: ['off'], kind: 'mesh' },
  { label: '3MF', ext: ['3mf'], kind: 'mesh', magic: true, as: 'zip' },
  { label: 'GLB', ext: ['glb'], kind: 'mesh', magic: true },
  { label: 'glTF', ext: ['gltf'], kind: 'mesh' },
  { label: 'DXF', ext: ['dxf'], kind: '2d' },
  // (range: the releases js/dwg.js reads, said in "opens": DWG_RELEASES' first to last)
  { label: 'DWG', ext: ['dwg'], kind: '2d', magic: true, range: dwgRange() },
  { label: 'zip', ext: ['zip'], kind: 'zip', magic: true },
];
// (as: a 3MF is a zip, and its start says only that)
const BY_EXT = new Map(FORMATS.flatMap((f) => f.ext.map((e) => [e, f])));

// files that come with a model and are not one: an OBJ's .mtl, a .gltf's buffers and pictures
export const COMPANION_EXT = ['mtl', 'bin', 'png', 'jpg', 'jpeg', 'webp', 'ktx2'];
export const isCompanion = (name) => COMPANION_EXT.includes(extOf(name));

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
// a size as the viewer says one: whole MB of 2^20 (the text readers', the mesh readers' and the list
// check's -- four formatters in three units: r72 A8)
export const sizeMb = (n) => `${Math.round(n / 2 ** 20).toLocaleString('en-US')} MB`;
export const TEXT_LIMIT_WORDS = `more than the ${sizeMb(MAX_TEXT_BYTES)} of text this viewer reads`;
export const tooMuchText = (what, bytes) => new Error(`${what} is ${sizeMb(bytes)} of text, ${TEXT_LIMIT_WORDS}`);
// An STL is binary when its size is 84 + 50 n for the n its header counts (bytes 80-83), even if it
// starts "solid", or that plus a surplus under one record (padding, an appended byte or two); else
// it is read as text. The one rule for the reader (js/mesh-formats.js parseSTL) and the list check,
// which kept its own and disagreed both ways (r72 A2)
export const stlIsBinary = (size, n) => size >= 84 && 84 + 50 * n <= size && size - (84 + 50 * n) < 50;
// Whether the viewer reads a file of this format as one string -- held to MAX_TEXT_BYTES -- from its
// first bytes (at least 84) and its size: by the format's own rule beside the table, so a text format
// added is said here once (r72 A2)
export function readsAsText(label, start, size) {
  const head = start ? String.fromCharCode(...start.subarray(0, Math.min(start.length, 512))) : '';
  switch (label) {
    case 'OBJ': case 'OFF': case 'glTF': return true;
    case 'STL': return start && start.length >= 84 ? !stlIsBinary(size, new DataView(start.buffer, start.byteOffset, start.byteLength).getUint32(80, true)) : false;
    case 'PLY': return start ? /format\s+ascii/.test(head) : false;
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
