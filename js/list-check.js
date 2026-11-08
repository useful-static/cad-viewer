// A model list's health, for its owner (check.html): each entry fetched the
// way cad.place fetches it, from this page, so a refusal here is the one a
// visitor meets. Per entry: the model (answered? CORS? found? its size, and
// whether its first bytes are the format its name says; the readers' size
// and text rules by the reader the page meets; a gzip by what it unpacks to;
// a zip or 3MF by its directory, the entry it opens, its companions, each
// entry held to its size and CRC-32; a glTF or GLB by its whole JSON -- its
// extensions, its buffers -- and its chunks; a .cadmesh by its header), its
// picture, its STEP, its tours (read and checked as cad.place reads them);
// and the list itself (read, entries, names given twice). Every check says
// the URL it tried. Pure apart from fetch, which the caller passes (tests
// pass a fake): tests/test-list-check.mjs.

import { READ_TIMEOUT_MS, answeredFrom, fetchModelLists, isTimeout, readCapped, timedFetch } from './model-list.js';
import { MAX_TOUR_BYTES, parseTour } from './tour.js';
import { FORMATS, MAX_TEXT_BYTES, SNIFF_BYTES, TEXT_LIMIT_WORDS, dwgRefusal, fileNameOfUrl, formatOfName, mbTenth, opensAsZip, readsAsText, sizeMb, sizeOver, sniffFormat as sniffBytes, GLB_JSON, companionOf, extOf, glbChunks, gltfNeeds, gltfRefusal, meshReaderOf, readerOf, stlIsBinary, textBytes, textOverWords, zipCompanions, zipModel } from './formats.js';
import { threeMfRoot } from './xml-walk.js';
import { MAX_FILE_BYTES, OVERSIZE_WORDS, cadmeshCut, gunzip, inflate, inflateCount, inflateHead, isGzip } from './cadmesh.js';
import { ZIP_TAIL, crcRefusal, entryDataAt, methodRefusal, sizeRefusal, within, zipDirectory, zipKey } from './zip-dir.js';
import { crc32 } from './crc32.js';
// (the most of a gzipped zip kept unpacked, to read its directory)
const ZIP_KEPT = 64 * 2 ** 20;
import { fileUrl } from './open-url.js';

// The format a file's name says ("board.cadmesh.gz" -> "cadmesh"; "/get?file=a.stl" -> "STL"),
// by the viewer's own reading of a URL and its one table (js/formats.js)
export function namedFormat(url) {
  const f = formatOfName(fileNameOfUrl(new URL(url).href));
  return f ? f.label : null;
}

// The format a file's first bytes say (after gunzip), or null: the viewer's own sniff
export function sniffFormat(bytes) {
  const f = sniffBytes(bytes);
  return f ? f.label : null;
}
const BY_LABEL = new Map(FORMATS.map((f) => [f.label, f]));
// A start that disagrees with the name is a fault only where one of the two formats always
// says itself in its first bytes (FORMATS magic); otherwise the viewer opens it by its name
const sure = (label) => !!BY_LABEL.get(label)?.magic;

// Read up to n bytes of a response's body, then stop (a server that ignores
// Range sends it all; the rest is never downloaded)
async function head(res, n) {
  if (!res.body || !res.body.getReader) return new Uint8Array(await res.arrayBuffer()).subarray(0, n);
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  try {
    while (got < n) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(got, n));
  let o = 0;
  for (const p of parts) {
    const take = Math.min(p.length, out.length - o);
    out.set(p.subarray(0, take), o);
    o += take;
    if (o >= out.length) break;
  }
  return out;
}

// gunzip the start of a gzip stream (a partial stream decodes what it has), by the page's own reading
// (js/cadmesh.js inflateHead: every member) and as far as the rules read it -- the PLY header's 64
// KB, past the sniff's SNIFF_BYTES (r74 A1, A3: 4 KB of the first member alone, a 540 MB ASCII PLY
// with a long header said "ok", and a gzip with a short first member "could not be read here")
// (512 bytes called a gzipped DXF behind a 1000-byte comment "format unknown" where the page opens it)
const gunzipStart = (bytes, n = 65536) => inflateHead(bytes, n);

// (MB of 2^20 bytes, as the page's own limits and words count them: in millions, a file at the
// 2 GiB limit read 2147.5 MB here and 2,048 MB on the page -- r71 A11)
// (a tenth from 1 MB, the page's own figure: js/formats.js mbTenth -- r73 Q4; a hundredth under it)
const mb = (n) => (n < 2 ** 20 ? (n / 2 ** 20).toFixed(2) : mbTenth(n));

// What a failed fetch means, as cad.place would meet it
function refused(e) {
  // (given up after cad.place's own time: said as it says it -- r54 A2)
  if (isTimeout(e)) return `no answer in time (${READ_TIMEOUT_MS / 1000} s, as cad.place waits)`;
  return `not fetched: the site sent no CORS header for it, or did not answer (${e && e.message ? e.message : e})`;
}

// A file's format against its name, from its unpacked start: { level, words } -- the one reading, a
// file's and a zip entry's (an entry had fewer rules, and a zipped R12 DWG or a GLB that was an HTML
// page read "ok": r76 Q3). want: the format its name says; got: the one its start says; size: the
// file's, when known.
function formatVerdict(want, got, inner, size = null) {
  // a DWG of a release the reader does not read, whatever its name, is refused by the page:
  // "ok · DWG" said an R12 drawing would open (r64 A2)
  const unread = got === 'DWG' ? dwgRefusal(String.fromCharCode(...inner.subarray(0, 6))) : null;
  if (unread) return { level: 'bad', words: want && want !== got ? `${unread} (named ${want})` : unread };
  // (a binary STL by its size opens as one whatever its free-text header starts with, unless that
  // start is a mesh format's magic, which the reader takes first: js/mesh-formats.js meshFormatOf --
  // one whose header began "PK\x03\x04" was "named STL, but it starts as zip": r77 A1)
  if (want === 'STL' && got && BY_LABEL.get(got)?.kind !== 'mesh' && size && inner.length >= 84
    && stlIsBinary(size, new DataView(inner.buffer, inner.byteOffset, inner.byteLength).getUint32(80, true))) return { level: 'ok', words: 'STL' };
  // (a 3MF is a zip by its start: said by its name -- "· zip" of a .3mf: r77 A10)
  if (got && want && BY_LABEL.get(want)?.as === got.toLowerCase()) return { level: 'ok', words: want };
  if (got && want && got !== want) {
    // the viewer opens a mesh or a 2D drawing by its bytes where they are conclusive
    // (js/mesh-formats.js meshFormatOf; a DWG by its tag, js/formats.js DWG_TAG, whatever its name), so a .stl
    // holding a PLY opens as a PLY, a .dxf holding a DWG as a DWG
    const kind = (label) => BY_LABEL.get(label)?.kind;
    const opens = sure(got) && kind(got) === kind(want) && ['mesh', '2d'].includes(kind(got));
    return { level: opens ? 'warn' : sure(want) || sure(got) ? 'bad' : 'warn', words: opens ? `named ${want}, but it is a ${got} (opens as one)` : `named ${want}, but it starts as ${got}` };
  }
  if (!got && want && sure(want)) return { level: 'bad', words: `named ${want}, but its start is no ${want} file` };
  return { level: !got && !want ? 'warn' : 'ok', words: got || want || 'format unknown' };
}

// A binary STL (a NUL in its start: no ASCII one has one) whose size is not the one its header counts:
// the reader's damaged words (js/mesh-formats.js parseSTL), else null
// ... and one that is neither binary by its size nor starts "solid" (a few bytes, no header): the
// reader's other refusal -- a 3-byte STL was "ok" (r77 A4)
function stlCut(label, start, size) {
  if (label !== 'STL' || !start || !size) return null;
  const n = start.length >= 84 ? new DataView(start.buffer, start.byteOffset, start.byteLength).getUint32(80, true) : 0;
  if (stlIsBinary(size, n)) return null;
  if (start.length < 84 || start.indexOf(0) < 0) {
    return /^\s*solid/.test(new TextDecoder('latin1').decode(start.subarray(0, 512))) ? null : 'neither a binary STL (its size does not match its triangle count) nor an ASCII one';
  }
  const want = 84 + 50 * n, big = (v) => v.toLocaleString('en-US');
  return `damaged: its header counts ${big(n)} triangle${n === 1 ? '' : 's'}, so it should be ${big(want)} bytes, but it is ${big(size)} bytes`;
}
// A glTF or GLB judged as its reader reads it, from src ({ len, read(at, n) }: the file by range, or
// its bytes in hand) -> { level, words } or null. A GLB's chunks walked (js/formats.js glbChunks: one
// cut short, the page's refusal; its JSON wherever it is, by its own length, the file's size apart --
// a 70 MB GLB, a BIN chunk first, were "ok": r82 A2-A4); a .gltf's JSON read whole up to ZIP_KEPT,
// past it said not checked (r82 A2). found(ref): whether a buffer is beside it.
async function gltfJudge(label, src, file, found = () => false) {
  if (label !== 'GLB' && label !== 'glTF') return null;
  // (the JSON held whole and not JSON: the reader's refusal in its words -- "ok" of a .gltf cut 9 bytes
  // short: r82 Q4)
  const parsed = async (bytes) => {
    const s = new TextDecoder().decode(await bytes);
    try { return JSON.parse(s); } catch (e) { return { bad: { level: 'bad', words: `${file} is damaged: its JSON does not parse (${e.message})` } }; }
  };
  let json;
  if (label === 'GLB') {
    const g = await glbChunks(src.read, src.len, file, 64);
    if (g.damaged) return { level: 'bad', words: g.damaged };
    const j = g.chunks.filter((c) => c.type === GLB_JSON).pop();
    if (!j) return g.more ? null : { level: 'bad', words: `${file} is damaged: it holds no glTF JSON` };
    if (j.len > MAX_TEXT_BYTES) return null; // (the reader's text limit, said by the size rules)
    json = await parsed(src.read(j.at, j.len));
  } else {
    if (src.len > ZIP_KEPT) return { level: 'warn', words: `${file}'s JSON is more than ${sizeMb(ZIP_KEPT)}: its extensions and buffers were not checked here` };
    json = await parsed(src.read(0, src.len));
  }
  if (json && json.bad) return json.bad;
  const said = gltfVerdict(json, file, found);
  return said ? { level: 'bad', words: said } : null;
}
// What the reader says of a glTF's JSON (file: its name), as the page reads it (js/mesh-formats.js
// parseGLTF): an extension it does not read (js/formats.js gltfRefusal -- a Draco GLB was "ok": r81
// A5), else a buffer it cannot find (gltfNeeds; found(ref) says whether one is beside it) -- or null
function gltfVerdict(json, file, found = () => false) {
  if (!json || typeof json !== 'object' || json.more) return null;
  const refused = gltfRefusal(json, file);
  if (refused) return refused;
  for (const uri of gltfNeeds(json)) {
    let ref = uri;
    try { ref = decodeURIComponent(uri); } catch { /* the reader refuses it as damaged */ }
    if (!found(ref)) return `${file} needs ${uri}: drop it together with the .${extOf(file)}`;
  }
  return null;
}
// (an empty file: no reader opens one -- "ok" of a 0-byte STL, an empty OBJ and a zip of one: r77 A4)
const EMPTY_WORDS = 'it is empty (0 bytes), which no reader of the viewer opens';

// What the page does with a zip or a 3MF, from its directory and the parts it reads -- by the page's
// own rules: js/zip-dir.js zipDirectory (and its zip64 refusal), js/formats.js zipModel (the entry
// loadZip opens) and threeMfRoot (the root model part, from _rels/.rels). src: { len, read(at, n) }
// -> its bytes (a ranged fetch, or bytes in hand: a gzipped one unpacked). -> { level, words } of a
// fault, or null. (The check's own reader said "ok" of a zip64 3MF, of a 3MF rooted elsewhere than
// 3D/3dmodel.model, of a zip of a 520 MB OBJ, and of a gzipped 3MF -- r75 A1-A4)
async function zipVerdict(src, label) {
  try { return await zipVerdictOf(src, label); } catch (e) {
    // (the check's own limit -- no range from the server -- a warning, not the page's refusal)
    if (e instanceof NoRange) return { level: 'warn', words: `its entries could not be read here (${e.message})` };
    throw e;
  }
}
class NoRange extends Error {}
// (a damaged zip met past its directory -- an entry's data outside the file -- is the page's refusal
// too, said as one: it threw through the check, "could not be checked" -- r77 Q2)
async function zipVerdictOf(src, label, depth = 0) {
  try { return await zipEntriesVerdict(src, label, depth); } catch (e) {
    if (e instanceof NoRange || !/^a damaged zip/.test(e.message || '')) throw e;
    return { level: 'bad', words: `the viewer cannot open it: ${e.message}` };
  }
}
async function zipEntriesVerdict(src, label, depth) {
  const tailAt = Math.max(0, src.len - ZIP_TAIL);
  let entries;
  try {
    entries = await zipDirectory(await src.read(tailAt, src.len - tailAt), tailAt, src.len, src.read);
  } catch (e) {
    if (e instanceof NoRange) throw e;
    return { level: 'bad', words: `the viewer cannot open it: ${e.message || e}` };
  }
  // an entry's first bytes, unpacked (64 KB: as much as the rules read)
  const startOf = async (x) => {
    const head = await src.read(x.lho, 30);
    const raw = await src.read(entryDataAt(x.lho, head), Math.min(x.csize, x.method === 0 ? 65536 : 1 << 20));
    return x.method === 0 ? raw : inflateHead(raw, 65536, 'deflate-raw');
  };
  const byName = (p) => entries.find((x) => x.key === zipKey(p));
  // (an entry's method the page reads: js/zip-dir.js methodRefusal -- a bzip2 entry "ok": r76 A3)
  const unread = (x) => { const m = methodRefusal(x.name, x.method, x.flags); return m ? { level: 'bad', words: m } : null; };
  // an entry whole, unpacked, up to max bytes (else a RangeError-born "too big" Error)
  // (held to its directory's size and CRC-32, as the page's unzip holds what it hands on: a 3MF's
  // rels with a wrong CRC was "ok" -- r81 A1; a refusal thrown as the page's damaged zip)
  const whole = async (x, max) => {
    const head = await src.read(x.lho, 30);
    const raw = await src.read(entryDataAt(x.lho, head), x.csize);
    const bytes = x.method === 0 ? raw : new Uint8Array(await inflate(raw, 'deflate-raw', max));
    const wrong = (x.method === 0 ? null : sizeRefusal(x.name, bytes.length, x.usize)) || crcRefusal(x.name, crc32(bytes), x.crc);
    if (wrong) throw new Error(wrong);
    return bytes;
  };
  // (an entry's deflate data as the page inflates it -- whole, its refusal in its words -- counted, not
  // kept, where the data is at most 1 MB; past that, data that inflates to nothing at its start. A
  // corrupt entry was "ok · zip", a corrupt 3MF root "ok · 3MF": r78 A4)
  // (-> { bad } the page's refusal, or { size } what it unpacks to: counted where the data is at most
  // 1 MB, as the page has it whatever the directory claims -- r78 Q2 -- else the directory's)
  // (max: the most it may unpack to -- a companion's, what the ones before it leave -- past which the
  // count stops: -> { over }. Its start read here when none is given: a 2 MB corrupt .mtl was "ok",
  // and twelve 1 GB companions were all counted for a refusal due after the third -- r79 A3, A6)
  const inflated = async (x, start = null, max = MAX_FILE_BYTES) => {
    const said = (e) => ({ bad: { level: 'bad', words: `its ${x.name}: ${e.message || e}` } });
    const damaged = (words) => ({ bad: { level: 'bad', words: `the viewer cannot open it: ${words}` } });
    // (a stored one's CRC-32 too, as the page holds it, up to ZIP_KEPT: js/zip-dir.js crcRefusal -- r80 Q4)
    if (x.method !== 8) {
      if (x.method !== 0 || x.csize > ZIP_KEPT) return { size: x.usize, unchecked: x.method === 0 };
      const head = await src.read(x.lho, 30);
      const wrongCrc = crcRefusal(x.name, crc32(await src.read(entryDataAt(x.lho, head), x.csize)), x.crc);
      return wrongCrc ? damaged(wrongCrc) : { size: x.usize };
    }
    // (counted, as the page inflates it, up to ZIP_KEPT of data: past 1 MB the directory's size was
    // taken, and a 1.5 MB-data STL 100 bytes past it was "ok" where the page says "a damaged zip" --
    // r80 Q1; past ZIP_KEPT, its start read and the rest said not checked)
    if (x.csize > ZIP_KEPT) {
      const s = start || await startOf(x);
      return x.usize && s && !s.length ? said('the deflated data is corrupt or truncated (it inflates to nothing)') : { size: x.usize, unchecked: true };
    }
    const head = await src.read(x.lho, 30);
    const raw = await src.read(entryDataAt(x.lho, head), x.csize);
    let size, c = 0;
    try { size = await inflateCount(raw, 'deflate-raw', max, (v) => { c = crc32(v, 0, v.length, c); }); } catch (e) { return /too big/.test(e.message) ? { over: true, bad: max >= MAX_FILE_BYTES ? said(e).bad : null } : said(e); }
    // (held to its directory's size and CRC-32, as the page holds it: js/zip-dir.js sizeRefusal,
    // crcRefusal -- r79 Q2, r80 Q4)
    const wrong = sizeRefusal(x.name, size, x.usize) || crcRefusal(x.name, c, x.crc);
    return wrong ? damaged(wrong) : { size };
  };
  const zm = zipModel(entries.map((x) => x.name));
  if (label === '3MF' || zm.threeMf) {
    // (its relationships part as the reader reads it -- its method, then whole up to the text limit:
    // read to 64 KB here, a root named past it was "no model part", and a bzip2 one fell back to the
    // usual root, "ok", where the page refused it -- r77 A2)
    const rels = byName('_rels/.rels');
    let relsText = '';
    if (rels) {
      if (unread(rels)) return unread(rels);
      if (rels.usize > MAX_TEXT_BYTES) return { level: 'bad', words: `its relationships part _rels/.rels unpacks to ${sizeOver(rels.usize)}, ${TEXT_LIMIT_WORDS}` };
      try { relsText = new TextDecoder().decode(await whole(rels, MAX_TEXT_BYTES)); } catch (e) {
        if (/^a damaged zip/.test(e.message || '')) throw e;
        return { level: 'bad', words: `its _rels/.rels: ${e.message || e}` };
      }
    }
    const path = threeMfRoot(relsText);
    const root = byName(path);
    // (its root part missing: refused by the reader in these words -- "ok" here: r76 A5)
    if (!root) return { level: 'bad', words: `it has no model part (${path})` };
    if (unread(root)) return unread(root);
    // (in the reader's words, its path as the rels name it: "of text" twice and "3D/" for "/3D/" here -- r76 Q5)
    if (root.usize > MAX_TEXT_BYTES) return { level: 'bad', words: `its model part ${path} unpacks to ${sizeOver(root.usize)}, ${TEXT_LIMIT_WORDS}` };
    const ri = await inflated(root, root.csize > 1 << 20 ? await startOf(root) : null);
    if (ri.bad) return ri.bad;
    const parts = entries.filter((x) => /\.model$/i.test(x.name));
    // (another model part the page cannot read: refused if the root names it, which is not read here)
    const other = parts.find((x) => x !== root && unread(x));
    if (other) return { level: 'warn', words: `${unread(other).words}: the viewer refuses the model if it uses that part` };
    // (and one whose data is damaged -- its size, its CRC-32, its deflate: a Bambu-style 3MF whose
    // object part was so was "ok", the page refusing it -- r81 A2; which parts the root names is not
    // read here, so a warning)
    // (a part too large to count here said, the root's and the others' in one wording: in the Bambu
    // layout the object part holds the geometry, 70 MB stored with a wrong CRC and "ok" -- r81 Q3, r82 A5)
    const notChecked = (name) => ({ level: 'warn', words: `its model part ${name} holds more than ${sizeMb(ZIP_KEPT)} of data: its data and size were not checked here` });
    let unchecked = ri.unchecked ? path : null;
    for (const x of parts) {
      if (x === root) continue;
      const xi2 = await inflated(x);
      if (xi2.bad) return { level: 'warn', words: `${xi2.bad.words}: the viewer refuses the model if it uses ${x.name}` };
      if (xi2.unchecked && !unchecked) unchecked = x.name;
    }
    const all = parts.reduce((s, x) => s + x.usize, 0);
    if (parts.length > 1 && all > MAX_TEXT_BYTES) return { level: 'warn', words: `its model parts come to ${textOverWords(all)}, if every one is read` };
    return unchecked ? notChecked(unchecked) : null;
  }
  const model = zm.model;
  if (!model) return { level: 'bad', words: 'it holds no model this viewer opens' };
  const x = byName(model);
  if (unread(x)) return unread(x);
  if (x.usize > MAX_FILE_BYTES) return { level: 'bad', words: `its ${model} unpacks to ${OVERSIZE_WORDS}` };
  // (its companions, which the page reads before the model, each by the reader's rule and together
  // under the file limit: one it cannot read refuses the model -- "ok" of a zip whose .png was bzip2:
  // r77 A3; the choice and the words the page's, js/formats.js zipCompanions, main.js loadMeshFile)
  const start = await startOf(x);
  const xi = await inflated(x, start);
  if (xi.bad) return xi.bad;
  // (only for a model whose reader reads them, as the page reads it -- a mesh by a mesh format's magic,
  // else its name: js/formats.js takesCompanions; a STEP's or a DXF's were judged, which the page
  // never reads -- r78 A1)
  // (the reader by js/formats.js meshReaderOf, the page's one rule: r79 A8)
  const companions = meshReaderOf(model, start)?.companions ? zipCompanions(zm.files, model, zm.opens).map((c) => byName(c.path)).filter(Boolean) : [];
  // (each as the page reads it, main.js loadZip's arrayBuffer(max): its method, its claim against the
  // budget the ones before leave -- a .mtl claiming 3 GB was "ok", the page refusing it, r79 A2 --
  // then counted to that budget)
  const overAll = { level: 'bad', words: `${model.split('/').pop().replace(/\.gz$/i, '')}: its companion files come to ${OVERSIZE_WORDS}` };
  let held = 0, anyUnchecked = false;
  for (const c of companions) {
    if (unread(c)) return unread(c);
    if (c.usize > MAX_FILE_BYTES - held) return overAll;
    const ci = await inflated(c, null, MAX_FILE_BYTES - held);
    if (ci.over) return overAll;
    if (ci.bad) return ci.bad;
    if (ci.unchecked) anyUnchecked = true;
    held += ci.size; // (its claim, which it is held to: past the budget, refused above)
  }
  // (a glTF's or GLB's buffers found among them as its reader finds them, js/formats.js companionOf:
  // a zipped .gltf without its .bin was "ok", the page refusing it -- r80 Q3)
  // (its whole JSON where the start does not hold it, and a gzipped one unpacked -- past 64 KB, or as
  // chair.gltf.gz, it was "ok": r81 A6, A7; its extensions first, as the reader reads them: r81 A5)
  // (by gltfJudge, one judgement for every place a glTF is: a stored one read by range within the zip,
  // whatever its size; another whole up to ZIP_KEPT, a gzipped one unpacked; past that, said not
  // checked -- r82 A2)
  const gl = meshReaderOf(model, start)?.label;
  let glWarn = null;
  if (gl === 'glTF' || gl === 'GLB') {
    const named = new Map(zipCompanions(zm.files, model, zm.opens).map((c) => [c.name, true]));
    const file = model.split('/').pop().replace(/\.gz$/i, '');
    let gsrc = null;
    if (x.method === 0 && start && !isGzip(start)) {
      const at = entryDataAt(x.lho, await src.read(x.lho, 30));
      gsrc = { len: x.csize, read: (o, n) => src.read(at + o, n) };
    } else if (x.usize <= ZIP_KEPT) {
      let bytes = null;
      try { bytes = await whole(x, ZIP_KEPT); if (isGzip(bytes)) bytes = new Uint8Array(await gunzip(bytes, ZIP_KEPT)); } catch { /* said below, by the entry's own reading */ }
      if (bytes) gsrc = bytesSource(bytes);
    }
    const v = gsrc ? await gltfJudge(gl, gsrc, file, (ref) => !!companionOf(named, ref))
      : { level: 'warn', words: `its ${model} holds more than ${sizeMb(ZIP_KEPT)}: its glTF JSON was not checked here` };
    if (v && v.level === 'bad') return v;
    glWarn = v;
  }
  // (the entry as the page opens it -- loadAny, by its own name: a gzip unpacked, a zip or a 3MF read
  // as one. The check ran its own short list on it, and called a zipped part.stl.gz damaged and a
  // zipped 3MF of a 600 MB part "ok": r76 A2; a zip by the page's rule, js/formats.js opensAsZip, not
  // any "PK" start: r77 A1)
  if (start && (isGzip(start) || opensAsZip(model, start)) && depth < 2) {
    if (x.usize > ZIP_KEPT) return { level: 'warn', words: `its ${model} was not read here (it unpacks to more than ${sizeMb(ZIP_KEPT)})` };
    let bytes;
    // (a directory that understates the size: inflated to the check's own limit, then said -- it threw,
    // "could not be checked: … over 0 GB": r77 A9)
    try { bytes = await whole(x, ZIP_KEPT); } catch (e) {
      if (/too big/.test(e.message)) return { level: 'warn', words: `its ${model} was not read here (it unpacks to more than ${sizeMb(ZIP_KEPT)})` };
      return { level: 'bad', words: `its ${model}: the viewer cannot unpack it: ${e.message || e}` };
    }
    const v = await bytesVerdict(bytes, model.split('/').pop(), depth + 1);
    return v && { level: v.level, words: `its ${model}: ${v.words}` };
  }
  // (its size as the page has it: r78 Q2; one too large to count here said, not "ok": r80 Q1)
  const sv = startVerdict(model, start, xi.size);
  if (sv) return sv;
  if (glWarn) return glWarn;
  if (!(xi.unchecked || anyUnchecked)) return null;
  return { level: 'warn', words: `${xi.unchecked ? `its ${model}` : `a companion of ${model}`} holds more than ${sizeMb(ZIP_KEPT)} of data: its data and size were not checked here` };
}
// What the page does with a file of these bytes and this name -- a gzip unpacked, a zip or a 3MF by
// its directory, else the size and text rules -- as a fault { level, words }, or null
async function bytesVerdict(bytes, name, depth) {
  if (isGzip(bytes)) {
    let inner;
    try { inner = new Uint8Array(await gunzip(bytes, ZIP_KEPT)); } catch (e) {
      if (/too big/.test(e.message)) return { level: 'warn', words: `it was not read here (it unpacks to more than ${sizeMb(ZIP_KEPT)})` };
      return { level: 'bad', words: `the viewer cannot unpack it: ${e.message || e}` };
    }
    return bytesVerdict(inner, name.replace(/\.gz$/i, ''), depth);
  }
  if (opensAsZip(name, bytes)) return zipVerdictOf(bytesSource(bytes), formatOfName(name)?.label === '3MF' ? '3MF' : 'zip', depth);
  // (a .cadmesh by its own header, the whole in hand: r82 A3)
  const label = readerOf(name, bytes)?.label;
  const cut = label === 'cadmesh' ? cadmeshCut(bytes, bytes.length) : null;
  if (typeof cut === 'string') return { level: 'bad', words: `its ${name}: ${cut}` };
  return startVerdict(name, bytes.subarray(0, 65536), bytes.length);
}
// A file of this name, start and size by the size and text rules: past the file limit, empty, a text
// format past the text limit, a binary STL cut short
function startVerdict(name, start, size) {
  if (size > MAX_FILE_BYTES) return { level: 'bad', words: `its ${name} unpacks to ${OVERSIZE_WORDS}` };
  if (size === 0) return { level: 'bad', words: `its ${name}: ${EMPTY_WORDS}` };
  const got = start ? sniffFormat(start.subarray(0, SNIFF_BYTES)) : null;
  const want = formatOfName(name)?.label || null;
  // (its format against its name, by the file's own rules: formatVerdict -- r76 Q3)
  const fv = start ? formatVerdict(want, got, start, size) : null;
  if (fv && fv.level === 'bad') return { level: 'bad', words: `its ${name}: ${fv.words}` };
  // (the size and text rules by the reader the page meets, js/formats.js readerOf, and its refusal
  // before a warning: they ran by the bytes' format, and a DXF named part.stl, which the page reads
  // as an STL and refuses, was a warning -- r80 A6)
  const r = sizeRule(readerOf(name, start)?.label || got || want, start, size);
  if (r) return { level: 'bad', words: r.over ? `its ${name} unpacks to ${r.over}` : `its ${name} is ${r.cut}` };
  // (a .cadmesh cut short, where its start holds its header: r82 A3)
  const cut = start && readerOf(name, start)?.label === 'cadmesh' ? cadmeshCut(start, size) : null;
  if (typeof cut === 'string') return { level: 'bad', words: `its ${name}: ${cut}` };
  if (fv && fv.level !== 'ok') return { level: fv.level, words: `its ${name}: ${fv.words}` };
  return null;
}
// The rules a file of this format, start and size meets once its size is known: past the text limit
// as one string ({ over }: the readers' words), or an STL the reader refuses ({ cut }) -- the one
// reading, a listed file's (checkFile) and a zip entry's (startVerdict), each of which kept its own
// (r77 A6)
function sizeRule(label, start, size) {
  if (start && size && textBytes(label, start, size) > MAX_TEXT_BYTES && readsAsText(label, start, size)) return { over: textOverWords(textBytes(label, start, size)) };
  const cut = stlCut(label, start, size);
  return cut ? { cut } : null;
}
// (a read past the archive's end: the zip is damaged, in the page's words -- js/zip-dir.js within --
// not the server's short answer, and not the short bytes in hand read as if whole: r77 Q2)
const pastEnd = (len, at, n) => { if (at + n > len) within(len)(at, n, 'an entry\'s data'); };
// a source of a file's bytes by range requests (206 and every byte asked, else an error)
const rangedSource = (fetchFn, url, len) => ({
  len,
  async read(at, n) {
    if (n <= 0) return new Uint8Array(0);
    pastEnd(len, at, n);
    const r = await fetchFn(url, { headers: { Range: `bytes=${at}-${at + n - 1}` }, cache: 'no-store' });
    if (r.status !== 206) { try { await r.body?.cancel(); } catch { /* gone */ } throw new NoRange('the server sent no range'); }
    const b = new Uint8Array(await r.arrayBuffer());
    if (b.length < n) throw new NoRange('the server sent less than it was asked');
    return b.subarray(0, n);
  },
});
const bytesSource = (u8) => ({ len: u8.length, read: async (at, n) => { pastEnd(u8.length, at, n); return u8.subarray(at, at + n); } });

// One file: answered, CORS, found, size; with sniff, its format too.
// -> { ok, level: 'ok' | 'warn' | 'bad', detail, url }
// download: the viewer only links to the file (Download STEP), never fetches it
export async function checkFile(url, { fetchFn = fetch, sniff = false, method = 'GET', download = false } = {}) {
  // a host's share page (a GitHub blob, a Dropbox dl=0 link) is fetched as the file it shares,
  // as the viewer fetches it (js/open-url.js)
  const fetchUrl = fileUrl(url);
  let res;
  try {
    try {
      res = await fetchFn(fetchUrl, sniff ? { headers: { Range: 'bytes=0-65535' }, cache: 'no-store' } : { method, cache: 'no-store' });
    } catch (e) {
      // (a ranged read fails where a plain one does not: a host sending its stored Content-Encoding
      // to the identity a ranged request asks -- net::ERR_CONTENT_DECODING_FAILED, said here as a
      // CORS failure while the page, a plain GET, opened the file: r73 Q2. Asked again plainly, the
      // start read and the rest let go)
      if (!sniff) throw e;
      res = await fetchFn(fetchUrl, { cache: 'no-store' });
    }
  } catch (e) {
    // a file the viewer only links to (Download STEP: a plain download, which needs no CORS)
    // is not at fault for refusing this page; that it is there cannot be read from here
    if (download) return { level: 'warn', detail: `not readable from this page (its site sends no CORS, which a download link does not need), so not checked: ${e && e.message ? e.message : e}`, url };
    return { level: 'bad', detail: refused(e), url };
  }
  if (!res.ok) {
    return { level: 'bad', detail: `${res.status === 404 ? 'not found' : 'refused'} (${res.status})`, url };
  }
  // the size: a part (206) says the whole in Content-Range, which a browser
  // hides from another site's page unless the server exposes it; its
  // Content-Length is only the part, so the size is then asked with HEAD
  // (Content-Length is always readable)
  const range = res.headers.get('content-range');
  // (a length of 0 is a size: read as "not given" -- `Number('0') || null` -- an empty STL was "ok": r77 A4)
  const lengthOf = (r) => { const v = r.headers.get('content-length'); return v !== null && /^\s*\d+\s*$/.test(v) ? Number(v) : null; };
  let total = range && /\/(\d+)$/.test(range) ? Number(range.match(/\/(\d+)$/)[1]) : null;
  if (total === null && res.status !== 206) total = lengthOf(res);
  if (total === null && res.status === 206) {
    try {
      const h = await fetchFn(fetchUrl, { method: 'HEAD', cache: 'no-store' });
      if (h.ok) total = lengthOf(h);
    } catch { /* the size stays unknown */ }
  }
  const bits = [total !== null ? `${mb(total)} MB` : 'size not given'];
  let level = 'ok';
  let sizeFormat = namedFormat(url), sizeStart = null, sizeGz = fileNameOfUrl(url).toLowerCase().endsWith('.gz'), unpacked = null, counted = false, unpackError = null;
  let zipBytes = null, zipNotRead = false, wholeStart = null, gzKept = null;
  if (sniff) {
    // (a body that fails after its headers -- a dropped connection -- is this file's fault: it
    // threw through the whole list check, which stopped with no verdict)
    let start;
    try { start = await head(res, 65536); } catch (e) { return { level: 'bad', detail: `its start could not be read: ${e && e.message ? e.message : e}`, url }; }
    if (!start.length) return { level: 'bad', detail: [...bits, EMPTY_WORDS].join(' · '), url };
    // (an answer that ended inside the bytes read -- a whole one, or a part shorter than the range asked
    // -- is the file itself, in hand, and its size: with none given, a cut STL and a 3-byte one read
    // "ok · size not given" -- r79 A4)
    // (and only when no larger total was named: a host capping its parts at 32 KB, its Content-Range
    // naming the file's 200 KB, had its first part read as the whole zip -- r82 Q3)
    if ((res.status === 200 || res.status === 206) && start.length < 65536 && (total === null || total === start.length)) {
      wholeStart = start;
      if (total === null) { total = start.length; bits[0] = `${mb(total)} MB`; }
    }
    const gz = isGzip(start);
    const inner = gz ? await gunzipStart(start) : start;
    const got = inner ? sniffFormat(inner) : null;
    const want = namedFormat(url);
    if (gz) bits.push('gzip');
    // (a gzip whose start gave nothing: unread, or empty -- told once it is counted, below)
    const nothing = !inner || (gz && !inner.length);
    if (!nothing) {
      const fv = formatVerdict(want, got, inner, gz ? null : total);
      bits.push(fv.words);
      level = fv.level;
    }
    sizeFormat = (inner && readerOf(fileNameOfUrl(url).replace(/\.gz$/i, ''), inner)?.label) || got || want; // (the page's reader: r80 A6)
    sizeStart = nothing ? null : inner; // (a start that gave nothing says nothing to the size rules)
    sizeGz = gz;
    // (a gzip's unpacked size, its last four bytes (ISIZE, mod 4 GiB), asked with a range: the page
    // holds what it unpacks to the same limits, and "ok · gzip · STL" said a 1.8 MB file unpacking to
    // 546 MB of ASCII STL would open -- r72 Q1)
    // (a small one -- under 4 GiB at deflate's largest ratio -- fetched whole and unpacked as the page
    // unpacks it, counted and let go: its trailer is the LAST member's size, and a gzip of several
    // members said "ok" by it while the page refused it -- r73 Q1)
    if (gz && total && total * 1032 < 2 ** 32) { // (its start unread too: the page's refusal is then what it says)
      try {
        const w = await fetchFn(fetchUrl, { cache: 'no-store' });
        if (w.ok) {
          const all = new Uint8Array(await w.arrayBuffer());
          // (a zip or a 3MF inside: its bytes kept, up to 64 MB, for its directory -- a gzipped 3MF
          // of a 520 MB part said "ok · gzip · zip": r75 A3; else counted and let go)
          const isZip = inner && opensAsZip(fileNameOfUrl(url), inner); // (the page's rule: r77 A1)
          try {
            // (a glTF's, a GLB's or a .cadmesh's kept too, up to 64 MB, for its JSON or its header --
            // a .gltf.gz past 64 KB of JSON was judged on its start alone: r82 A1)
            const keep = isZip || ['glTF', 'GLB', 'cadmesh'].includes(sizeFormat);
            if (keep) {
              try { const b = new Uint8Array(await gunzip(all, ZIP_KEPT)); unpacked = b.length; if (isZip) zipBytes = b; else gzKept = b; } catch (e) {
                if (!/too big/.test(e.message)) throw e;
                unpacked = await inflateCount(all);
                zipNotRead = true;
              }
            } else unpacked = await inflateCount(all);
            counted = true;
          } catch (e) { unpackError = e.message || String(e); }
        }
      } catch { /* not fetched whole: its size stays unknown */ }
    } else if (gz && inner && total > 4) {
      try {
        const t = await fetchFn(fetchUrl, { headers: { Range: `bytes=${total - 4}-${total - 1}` }, cache: 'no-store' });
        // (a server that ignores the range sends the whole file: its body let go, not read -- r73 A1)
        if (t.status !== 206) { try { await t.body?.cancel(); } catch { /* gone already */ } }
        const b = t.status === 206 ? new Uint8Array(await t.arrayBuffer()) : null;
        if (b && b.length === 4) unpacked = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
      } catch { /* not asked: the unpacked size stays unknown */ }
    }
    // (counted whole and nothing inside: empty, as a plain or zipped one is said -- an empty a.stl.gz
    // was "its gzip could not be read here": r78 A5; else its start unread, as before)
    if (nothing && counted && unpacked === 0) return { level: 'bad', detail: [...bits, EMPTY_WORDS].join(' · '), url };
    if (nothing) { bits.push('its gzip could not be read here'); level = 'warn'; }
    // named .gz but not gzip: a server that sends it with Content-Encoding: gzip has the browser
    // unpack it on the way, and the viewer opens what arrives (main.js loadAny) -- so it is a
    // fault only when what arrived is not the file its name says
    if (fileNameOfUrl(url).toLowerCase().endsWith('.gz') && !gz) {
      if (got && got === want) bits.push('arrives unpacked (sent with Content-Encoding: gzip), which the viewer opens');
      else if (!got && want && !sure(want)) {
        bits.push('not gzip as it arrives: sent unpacked (Content-Encoding), or not compressed at all; its start does not say which');
        if (level === 'ok') level = 'warn';
      } else {
        bits.push('named .gz but not gzip');
        level = 'bad';
      }
    }
  }
  // (and the page's own size limits, by the same numbers: "ok" said a 3 GB STL and a 700 MB ASCII
  // DXF would open, which the page refuses -- r71 A3)
  // (in the page's own words, one string each: js/cadmesh.js OVERSIZE_WORDS, js/formats.js
  // tooMuchText's -- "2048.0 MB" here beside "over 2 GB" there: r72 A8; and by the readers' own rule
  // for what is text, js/formats.js readsAsText -- this check's own disagreed both ways: r72 A2)
  // (a gzip by what it unpacks to: counted whole when small; else by its trailer, the last member's
  // size mod 4 GiB (ISIZE), which settles only a size over the limits; unread, nothing is known.
  // Read as exact, a 4.6 GB STL in 400 MB of gzip said "ok · 381.5 MB" -- r73 A1)
  const gzLeast = total ? total - 18 - 5 * Math.ceil(total / 65535) : 0; // (stored blocks: the least a gzip unpacks to)
  // (a binary STL inside settles it: its header's count gives its size, 84 + 50 n, when that agrees
  // with the trailer mod 4 GiB -- a 5 GB one read "672 MB of text" by the residue)
  let stlSize = null;
  if (sizeGz && unpacked !== null && sizeFormat === 'STL' && sizeStart && sizeStart.length >= 84) {
    const s = 84 + 50 * new DataView(sizeStart.buffer, sizeStart.byteOffset, sizeStart.byteLength).getUint32(80, true);
    const over = (((unpacked - s) % 2 ** 32) + 2 ** 32) % 2 ** 32;
    if (over < 50) stlSize = s + over;
  }
  // (counted whole, the size is the page's own; from the trailer alone it is the last member's, mod
  // 4 GiB: still the least it unpacks to below 4 GiB, so past a limit by it is past it, but below
  // what the gzip itself takes it says nothing -- past 4 GiB, or a gzip of several members: r73 Q1)
  const unsettled = sizeGz && !counted && unpacked !== null && stlSize === null && unpacked < gzLeast;
  const exact = sizeGz && (counted || stlSize !== null);
  if (stlSize !== null) unpacked = stlSize;
  const size = sizeGz ? (unsettled ? null : unpacked) : total;
  // (a zip or a 3MF: what the page does with it, by its own rules -- from the server by ranges, or a
  // gzipped one from its bytes unpacked; one too large to keep unpacked, said, not "ok")
  let zipSaid = null;
  // (a zip or a 3MF as the page takes one: by its name, else its bytes -- js/formats.js opensAsZip, r77 A1)
  const pk = sizeStart && opensAsZip(fileNameOfUrl(url), sizeStart);
  const zipLabel = sizeFormat === '3MF' || namedFormat(url) === '3MF' ? '3MF' : 'zip';
  if (sniff && pk && zipBytes) zipSaid = await zipVerdict(bytesSource(zipBytes), zipLabel);
  else if (sniff && pk && sizeGz) zipSaid = { level: 'warn', words: zipNotRead ? `its entries were not read here (it unpacks to more than ${sizeMb(ZIP_KEPT)})` : 'its entries were not read here' };
  // (the whole file in hand: read from it, no range asked -- r78 A3, r79 A4)
  else if (sniff && pk && wholeStart && !sizeGz) zipSaid = await zipVerdict(bytesSource(wholeStart), zipLabel);
  else if (sniff && pk && total && total <= MAX_FILE_BYTES) zipSaid = await zipVerdict(rangedSource(fetchFn, fetchUrl, total), zipLabel);
  // (its size not given -- Content-Range hidden, HEAD refused -- and more than is in hand: said, not
  // "ok · size not given · zip" with no entry read -- r78 A3)
  else if (sniff && pk && total === null) zipSaid = { level: 'warn', words: 'its entries were not read here (its size was not given)' };
  const rule = sizeRule(sizeFormat, sizeStart, size); // (the size rules: one reading -- r77 A6)
  // (a glTF's or GLB's JSON as the reader reads it: its extensions, then its buffers, none of which
  // can be beside it from a URL -- r80 Q3, r81 A5; fetched whole, up to 64 MB, where the start does
  // not hold it -- a .gltf of more than 64 KB of JSON was "ok": r81 A6)
  // (by gltfJudge, as in a zip: from the bytes in hand -- the whole answer, a small gzip unpacked --
  // else by range, a GLB's JSON by its own length whatever the file's size; a server sending no range
  // fetched whole up to ZIP_KEPT; a gzip too large to unpack here said not checked -- r82 A1, A2)
  let urlSaid = null;
  if (sniff && sizeStart && (sizeFormat === 'glTF' || sizeFormat === 'GLB')) {
    const file = fileNameOfUrl(url).replace(/\.gz$/i, '');
    let gsrc = null;
    if (sizeGz) gsrc = gzKept ? bytesSource(gzKept) : null;
    else if (wholeStart) gsrc = bytesSource(wholeStart);
    else if (total) gsrc = rangedSource(fetchFn, fetchUrl, total);
    try {
      urlSaid = gsrc ? await gltfJudge(sizeFormat, gsrc, file) : sizeGz && total ? { level: 'warn', words: `${file}'s JSON was not read here (its gzip was not unpacked here)` } : null;
    } catch (e) {
      if (!(e instanceof NoRange)) throw e;
      if (total <= ZIP_KEPT) {
        try { const w = await fetchFn(fetchUrl, { cache: 'no-store' }); if (w.ok) urlSaid = await gltfJudge(sizeFormat, bytesSource(new Uint8Array(await w.arrayBuffer())), file); } catch { /* not fetched: nothing said */ }
      } else urlSaid = { level: 'warn', words: `${file}'s JSON was not read here (the server sent no range)` };
    }
  }
  // (a .cadmesh cut short, by its own header: js/cadmesh.js cadmeshCut, the decoder's rule -- one half
  // downloaded was "ok": r82 A3; its header read by range where the start does not hold it)
  let cutSaid = null;
  if (sniff && sizeFormat === 'cadmesh' && size && sizeStart) {
    let head = sizeGz ? gzKept : sizeStart;
    let c = head ? cadmeshCut(head, size) : null;
    if (c && c.need && !sizeGz && c.need <= ZIP_KEPT) {
      try { head = await rangedSource(fetchFn, fetchUrl, total).read(0, c.need); c = cadmeshCut(head, size); } catch (e) { if (!(e instanceof NoRange)) throw e; c = null; }
    }
    cutSaid = typeof c === 'string' ? c : null;
  }
  if (total && total > MAX_FILE_BYTES) {
    bits.push(OVERSIZE_WORDS);
    level = 'bad';
  } else if (unpackError) {
    // (the page's own refusal of what it unpacks)
    bits.push(`the viewer cannot unpack it: ${unpackError}`);
    level = 'bad';
  } else if (sizeGz && unpacked > MAX_FILE_BYTES) {
    bits.push(`unpacks to ${OVERSIZE_WORDS}`);
    level = 'bad';
  } else if (rule?.over) {
    // (a residue is the least it unpacks to, so a text format past the limit by it is past it; an STL
    // whose header did not settle its size is no binary one at any multiple, so text, as the reader
    // takes it)
    // (what the reader holds to the limit: a PLY's body, its header apart -- r74 Q1)
    bits.push(`${sizeGz ? 'unpacks to ' : ''}${rule.over}`); // (the readers' words: r73 Q4)
    level = 'bad';
  } else if (zipSaid) {
    // (inside a zip or a 3MF, by its directory: the 3MF's root model part past the text the reader
    // reads, refused by the page -- "ok · zip" here said a 1.3 MB 3MF of a 520 MB part would open:
    // r74 A5)
    bits.push(zipSaid.words);
    level = zipSaid.level === 'bad' || level === 'bad' ? 'bad' : 'warn';
  } else if (rule?.cut) {
    // (a binary STL cut short or padded past one record: the page refuses it as damaged, its words
    // the reader's -- "ok · STL" here: r73 A4)
    bits.push(rule.cut);
    level = 'bad';
  } else if (urlSaid) {
    // (a glTF or GLB whose buffers are files of their own: opened from a URL the page has none of
    // them, and refuses it in the reader's words -- "ok" here: r80 Q3; or one needing an extension
    // the reader does not read: r81 A5; or, too large to read here, said: r82 A2)
    bits.push(urlSaid.words);
    level = urlSaid.level === 'bad' || level === 'bad' ? 'bad' : 'warn';
  } else if (cutSaid) {
    // (a .cadmesh cut short: the decoder's refusal -- r82 A3)
    bits.push(cutSaid);
    level = 'bad';
  } else if (sniff && total === null) {
    // (no size given and more than is in hand: the size limits not told, said, not "ok · size not
    // given" -- a gzip of 501 MB of text, a cut STL and a corrupt gzip were: r80 Q2)
    bits.push('its size was not given and it is longer than is read here, so the size limits could not be checked');
    if (level === 'ok') level = 'warn';
  } else if (sizeGz && sniff && sizeStart && !exact
    // (and only where the limits can be met: at the deflate's largest ratio its size could pass one)
    && total * 1032 > (readsAsText(sizeFormat, sizeStart, Infinity) ? MAX_TEXT_BYTES : MAX_FILE_BYTES)) {
    // (what it unpacks to not settled: said, not "ok")
    bits.push(unpacked === null ? 'its unpacked size could not be asked (the server sent no range)'
      : unsettled ? 'its unpacked size cannot be told from its last four bytes (past 4 GB, or a gzip of several members)'
        : `unpacks to ${sizeMb(unpacked)}, or that and a multiple of 4 GB (a gzip keeps the size mod 4 GB)`);
    if (level === 'ok') level = 'warn';
  }
  return { level, detail: bits.join(' · '), url };
}

// One tour: read, parsed as cad.place parses it
// (read with cad.place's own timeout, as cad.place reads a tour: timedFetch)
export async function checkTour(url, fetchFn = timedFetch) {
  let res;
  try {
    res = await fetchFn(url, { cache: 'no-store' });
  } catch (e) {
    return { level: 'bad', detail: refused(e), url };
  }
  if (!res.ok) return { level: 'bad', detail: `${res.status === 404 ? 'not found' : 'refused'} (${res.status})`, url };
  try {
    const t = parseTour(await readCapped(res, MAX_TOUR_BYTES), answeredFrom(res, url));
    // (and the model it opens, as the page resolves it -- against the URL that answered: r57 Q8, the
    // base otherwise unseen)
    return { level: 'ok', detail: `${t.steps.length} steps${t.title ? `, "${t.title}"` : ''}${t.model ? `; its model ${t.model}` : ''}`, url };
  } catch (e) {
    // (the time given up while the body still came: a timeout, not a fault of the tour -- it read
    // "not a tour cad.place reads: The operation was aborted due to timeout": r55 A5, Q7)
    if (isTimeout(e)) return { level: 'bad', detail: refused(e), url };
    return { level: 'bad', detail: `not a tour cad.place reads: ${e.message}`, url };
  }
}

// Run fns with at most n at a time
async function pool(fns, n) {
  const out = new Array(fns.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, fns.length) }, async () => {
    while (i < fns.length) {
      const k = i++;
      out[k] = await fns[k]();
    }
  }));
  return out;
}

// The whole list (or lists, joined as cad.place joins them).
// -> { lists: [{ url, error }], entries: [{ name, url, id, checks: [{ what, level, detail, url }] }] }
// onEntry(entry, i, n), when given, hears each entry as it is checked.
export async function checkLists(urls, base, { fetchFn = fetch, onEntry = null, parallel = 4 } = {}) {
  // (the lists and their tours read as cad.place reads them, given up after its time: timedFetch;
  // a model file's check is not, as cad.place's own download of it is not)
  const readFn = fetchFn === fetch ? timedFetch : fetchFn;
  const r = await fetchModelLists(urls, base, readFn);
  const lists = urls.map((u) => {
    let abs = u;
    try { abs = new URL(u, base).href; } catch { /* as given */ }
    // (a list named by a share page is read -- and its error filed -- under the file's own
    // address, js/open-url.js fileUrl: matched under it too)
    const err = r.errors.find((e) => e.url === abs || e.url === u || e.url === fileUrl(abs));
    return { url: abs, error: err ? err.message || String(err.error || err) : null };
  });
  const n = r.entries.length;
  const entries = await pool(r.entries.map((e, i) => async () => {
    const checks = [];
    // (each check's own failure is that check's bad row, never the whole list's)
    const add = async (what, url, run) => {
      let r;
      try { r = await run(); } catch (err) { r = { level: 'bad', detail: `could not be checked: ${err && err.message ? err.message : err}`, url }; }
      checks.push({ what, ...r });
    };
    await add('model', e.url, () => checkFile(e.url, { fetchFn, sniff: true }));
    if (e.image) await add('picture', e.image, () => checkFile(e.image, { fetchFn, method: 'HEAD' }));
    if (e.step) await add('STEP', e.step, () => checkFile(e.step, { fetchFn, method: 'HEAD', download: true }));
    for (const t of e.tours || []) await add(`tour "${t.name}"`, t.url, () => checkTour(t.url, readFn));
    const out = { name: e.name, url: e.url, id: e.id || null, checks };
    if (onEntry) onEntry(out, i, n);
    return out;
  }), parallel);
  return { lists, entries };
}

// An entry's rows put in the table in the list's order, wherever its check finished (they were in
// finishing order): each row marked with the entry's place i, put before the first row of a later
// place. body: a tbody (rows, insertBefore); rows: a fragment of the entry's rows (children)
export function insertInOrder(body, rows, i) {
  for (const tr of rows.children) tr.dataset.i = String(i);
  const after = [...body.rows].find((x) => Number(x.dataset.i) > i);
  body.insertBefore(rows, after || null);
}

// A one-line verdict for a result
export function summary(result) {
  const all = result.entries.flatMap((e) => e.checks);
  const bad = all.filter((c) => c.level === 'bad').length;
  const warn = all.filter((c) => c.level === 'warn').length;
  const badLists = result.lists.filter((l) => l.error).length;
  const n = result.entries.length;
  return `${n} model${n === 1 ? '' : 's'}, ${all.length} check${all.length === 1 ? '' : 's'}: ${bad} failed, ${warn} to look at`
    + `${badLists ? `; ${badLists} list${badLists > 1 ? 's' : ''} not read` : ''}`;
}
