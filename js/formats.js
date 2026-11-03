// The files the viewer opens, in one table: each format's extensions, its kind (how it is
// opened), its label, and how its first bytes give it away. Every path that decides by name or
// by bytes reads this: the viewer's loader (js/main.js loadAny, the zip opener, a URL's file
// name, the Open… and Add model… pickers), check.html (js/list-check.js) and the converter CLI
// (stp2mesh.mjs). manifest.webmanifest's file_handlers is checked against it
// (tests/test-formats.mjs). A new format is a row here, its sniff below if it has one, and its
// loader in js/main.js.
//
// Pure ES module, no DOM.

// kind: 'cad' (converted by OpenCascade: cad names its reader), 'cadmesh' (the viewer's own),
// 'mesh' (js/mesh-formats.js), '2d' (js/dxf.js, js/dwg.js), 'zip' (opened for the model in it).
// magic: every file of the format starts with bytes that say it (sniffFormat finds it, and a
// file named so that does not start so is not one). Without it the start only hints (an OBJ may
// open with any statement, a glTF's JSON keys come in any order, a binary STL has no magic): the
// viewer opens such a file by its name, so a start that says nothing is no fault.
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
  { label: 'glTF', ext: ['glb', 'gltf'], kind: 'mesh' },
  { label: 'DXF', ext: ['dxf'], kind: '2d' },
  { label: 'DWG', ext: ['dwg'], kind: '2d', magic: true },
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
// the format an extension is, or null
export const formatOfExt = (ext) => BY_EXT.get(String(ext || '').toLowerCase()) || null;

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

// A DWG by its bytes: "AC10" and two digits (R13 to R2018 are read; an older one reaches the
// reader, which refuses it by name)
export const isDWGBytes = (b) => b.length >= 6 && b[0] === 0x41 && b[1] === 0x43 && b[2] === 0x31 && b[3] === 0x30 && b[4] >= 0x30 && b[4] <= 0x39 && b[5] >= 0x30 && b[5] <= 0x39;

// The format a file's first bytes say (after gunzip), or null. A binary STL has no magic (its
// header is free text): only its name says it. 3MF and a zip of models are both zips: a zip is
// "zip" here, and a 3MF by its name.
export function sniffFormat(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (isDWGBytes(b)) return BY_EXT.get('dwg');
  const text = new TextDecoder('latin1').decode(b.subarray(0, Math.min(400, b.length))).replace(/^ï»¿/, '');
  const f = (e) => BY_EXT.get(e);
  if (text.startsWith('CADM')) return f('cadmesh');
  if (/^\s*ISO-10303-21\s*;/.test(text)) return f('stp');
  if (/^\s*DBRep_DrawableShape/.test(text)) return f('brep');
  if (text.startsWith('glTF')) return f('glb');
  if (text.startsWith('PK\x03\x04')) return f('zip');
  if (/^ply\r?\n/.test(text)) return f('ply');
  if (/^\s*(\d+\s*\r?\n\s*)?0\s*\r?\n\s*SECTION/.test(text) || text.startsWith('AutoCAD Binary DXF')) return f('dxf');
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
  const mesh = of('mesh').map((f) => (f.label === 'glTF' ? 'glTF / GLB' : f.label));
  const twoD = of('2d').map((f) => (f.label === 'DWG' ? 'DWG (R13 to 2018)' : f.label));
  return `open a ${cad.slice(0, -1).join(', ')}, ${cad[cad.length - 1]} or .cadmesh file, a mesh (${mesh.join(', ')}), a 2D ${twoD.join(' or ')}, or a zip of one`;
}

// An <input type=file> accept list: the formats of these kinds, gzipped too, and the companions
export function acceptList(kinds = ['cad', 'cadmesh', 'mesh', '2d', 'zip']) {
  const exts = FORMATS.filter((x) => kinds.includes(x.kind)).flatMap((x) => x.ext);
  return [...exts, 'gz', ...COMPANION_EXT].map((e) => `.${e}`).join(',');
}
