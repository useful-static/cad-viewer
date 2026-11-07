// A model list's health, for its owner (check.html): each entry fetched the
// way cad.place fetches it, from this page, so a refusal here is the one a
// visitor meets. Per entry: the model (answered? CORS? found? its size, and
// whether its first bytes are the format its name says), its picture, its
// STEP, its tours (read and checked as cad.place reads them); and the list
// itself (read, entries, names given twice). Every check says the URL it
// tried. Pure apart from fetch, which the caller passes (tests pass a fake):
// tests/test-list-check.mjs.

import { READ_TIMEOUT_MS, answeredFrom, fetchModelLists, isTimeout, readCapped, timedFetch } from './model-list.js';
import { MAX_TOUR_BYTES, parseTour } from './tour.js';
import { FORMATS, MAX_TEXT_BYTES, SNIFF_BYTES, dwgRefusal, fileNameOfUrl, formatOfName, mbTenth, readsAsText, sizeMb, sniffFormat as sniffBytes, stlIsBinary, textBytes, textOverWords, zipModel } from './formats.js';
import { threeMfRoot } from './xml-walk.js';
import { MAX_FILE_BYTES, OVERSIZE_WORDS, gunzip, inflateCount, inflateHead } from './cadmesh.js';
import { ZIP_TAIL, entryDataAt, zipDirectory } from './zip-dir.js';
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

const isGzip = (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
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

// A binary STL (a NUL in its start: no ASCII one has one) whose size is not the one its header counts:
// the reader's damaged words (js/mesh-formats.js parseSTL), else null
function stlCut(label, start, size) {
  if (label !== 'STL' || !start || start.length < 84 || !size || start.indexOf(0) < 0) return null;
  const n = new DataView(start.buffer, start.byteOffset, start.byteLength).getUint32(80, true);
  if (stlIsBinary(size, n)) return null;
  const want = 84 + 50 * n, big = (v) => v.toLocaleString('en-US');
  return `damaged: its header counts ${big(n)} triangle${n === 1 ? '' : 's'}, so it should be ${big(want)} bytes, but it is ${big(size)} bytes`;
}

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
async function zipVerdictOf(src, label) {
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
  const byName = (p) => entries.find((x) => x.name.replace(/^\//, '').toLowerCase() === p.replace(/^\//, '').toLowerCase());
  if (label === '3MF') {
    const rels = byName('_rels/.rels');
    const relsText = rels && rels.usize < 1 << 20 ? new TextDecoder().decode((await startOf(rels)) || new Uint8Array(0)) : '';
    const path = threeMfRoot(relsText);
    const root = byName(path);
    if (root && root.usize > MAX_TEXT_BYTES) return { level: 'bad', words: `its model part ${root.name} unpacks to ${textOverWords(root.usize)}` };
    const parts = entries.filter((x) => /\.model$/i.test(x.name));
    const all = parts.reduce((s, x) => s + x.usize, 0);
    if (parts.length > 1 && all > MAX_TEXT_BYTES) return { level: 'warn', words: `its model parts come to ${textOverWords(all)}, if every one is read` };
    return null;
  }
  const { model } = zipModel(entries.map((x) => x.name));
  if (!model) return { level: 'bad', words: 'it holds no model this viewer opens' };
  const x = byName(model), f = formatOfName(model);
  if (x.usize > MAX_FILE_BYTES) return { level: 'bad', words: `its ${model} unpacks to ${OVERSIZE_WORDS}` };
  const start = await startOf(x);
  const got = start ? sniffFormat(start.subarray(0, SNIFF_BYTES)) : null;
  const fl = got || f?.label;
  if (start && textBytes(fl, start, x.usize) > MAX_TEXT_BYTES && readsAsText(fl, start, x.usize)) return { level: 'bad', words: `its ${model} unpacks to ${textOverWords(textBytes(fl, start, x.usize))}` };
  const cut = stlCut(fl, start, x.usize);
  if (cut) return { level: 'bad', words: `its ${model} is ${cut}` };
  return null;
}
// a source of a file's bytes by range requests (206 and every byte asked, else an error)
const rangedSource = (fetchFn, url, len) => ({
  len,
  async read(at, n) {
    if (n <= 0) return new Uint8Array(0);
    const r = await fetchFn(url, { headers: { Range: `bytes=${at}-${at + n - 1}` }, cache: 'no-store' });
    if (r.status !== 206) { try { await r.body?.cancel(); } catch { /* gone */ } throw new NoRange('the server sent no range'); }
    const b = new Uint8Array(await r.arrayBuffer());
    if (b.length < n) throw new NoRange('the server sent less than it was asked');
    return b.subarray(0, n);
  },
});
const bytesSource = (u8) => ({ len: u8.length, read: async (at, n) => u8.subarray(at, at + n) });

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
  let total = range && /\/(\d+)$/.test(range) ? Number(range.match(/\/(\d+)$/)[1]) : null;
  if (!total && res.status !== 206) total = Number(res.headers.get('content-length')) || null;
  if (!total && res.status === 206) {
    try {
      const h = await fetchFn(fetchUrl, { method: 'HEAD', cache: 'no-store' });
      if (h.ok) total = Number(h.headers.get('content-length')) || null;
    } catch { /* the size stays unknown */ }
  }
  const bits = [total ? `${mb(total)} MB` : 'size not given'];
  let level = 'ok';
  let sizeFormat = namedFormat(url), sizeStart = null, sizeGz = fileNameOfUrl(url).toLowerCase().endsWith('.gz'), unpacked = null, counted = false, unpackError = null;
  let zipBytes = null, zipNotRead = false;
  if (sniff) {
    // (a body that fails after its headers -- a dropped connection -- is this file's fault: it
    // threw through the whole list check, which stopped with no verdict)
    let start;
    try { start = await head(res, 65536); } catch (e) { return { level: 'bad', detail: `its start could not be read: ${e && e.message ? e.message : e}`, url }; }
    const gz = isGzip(start);
    const inner = gz ? await gunzipStart(start) : start;
    const got = inner ? sniffFormat(inner) : null;
    const want = namedFormat(url);
    if (gz) bits.push('gzip');
    // a DWG of a release the reader does not read, whatever its name, is refused by the page:
    // "ok · DWG" said an R12 drawing would open (r64 A2)
    const unread = got === 'DWG' ? dwgRefusal(String.fromCharCode(...inner.subarray(0, 6))) : null;
    if (!inner) {
      bits.push('its gzip could not be read here');
      level = 'warn';
    } else if (unread) {
      bits.push(want && want !== got ? `${unread} (named ${want})` : unread);
      level = 'bad';
    } else if (got && want && got !== want && BY_LABEL.get(want)?.as !== got.toLowerCase()) {
      // the viewer opens a mesh or a 2D drawing by its bytes where they are conclusive
      // (js/mesh-formats.js meshFormatOf; a DWG by its tag, js/formats.js DWG_TAG, whatever its name), so a .stl
      // holding a PLY opens as a PLY, a .dxf holding a DWG as a DWG
      const kind = (label) => BY_LABEL.get(label)?.kind;
      const opens = sure(got) && kind(got) === kind(want) && ['mesh', '2d'].includes(kind(got));
      bits.push(opens ? `named ${want}, but it is a ${got} (opens as one)` : `named ${want}, but it starts as ${got}`);
      level = opens ? 'warn' : sure(want) || sure(got) ? 'bad' : 'warn';
    } else if (!got && want && sure(want)) {
      bits.push(`named ${want}, but its start is no ${want} file`);
      level = 'bad';
    } else {
      bits.push(got || want || 'format unknown');
      if (!got && !want) level = 'warn';
    }
    sizeFormat = got || want;
    sizeStart = inner;
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
          const isZip = inner && inner[0] === 0x50 && inner[1] === 0x4b;
          try {
            if (isZip) {
              try { zipBytes = new Uint8Array(await gunzip(all, ZIP_KEPT)); unpacked = zipBytes.length; } catch (e) {
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
  const pk = sizeStart && sizeStart[0] === 0x50 && sizeStart[1] === 0x4b;
  const zipLabel = sizeFormat === '3MF' || namedFormat(url) === '3MF' ? '3MF' : 'zip';
  if (sniff && pk && zipBytes) zipSaid = await zipVerdict(bytesSource(zipBytes), zipLabel);
  else if (sniff && pk && sizeGz) zipSaid = { level: 'warn', words: zipNotRead ? `its entries were not read here (it unpacks to more than ${sizeMb(ZIP_KEPT)})` : 'its entries were not read here' };
  else if (sniff && pk && total && total <= MAX_FILE_BYTES) zipSaid = await zipVerdict(rangedSource(fetchFn, fetchUrl, total), zipLabel);
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
  } else if (size && textBytes(sizeFormat, sizeStart, size) > MAX_TEXT_BYTES && readsAsText(sizeFormat, sizeStart, size)) {
    // (a residue is the least it unpacks to, so a text format past the limit by it is past it; an STL
    // whose header did not settle its size is no binary one at any multiple, so text, as the reader
    // takes it)
    // (what the reader holds to the limit: a PLY's body, its header apart -- r74 Q1)
    bits.push(`${sizeGz ? 'unpacks to ' : ''}${textOverWords(textBytes(sizeFormat, sizeStart, size))}`); // (the readers' words: r73 Q4)
    level = 'bad';
  } else if (zipSaid) {
    // (inside a zip or a 3MF, by its directory: the 3MF's root model part past the text the reader
    // reads, refused by the page -- "ok · zip" here said a 1.3 MB 3MF of a 520 MB part would open:
    // r74 A5)
    bits.push(zipSaid.words);
    level = zipSaid.level === 'bad' || level === 'bad' ? 'bad' : 'warn';
  } else if (stlCut(sizeFormat, sizeStart, size)) {
    // (a binary STL cut short or padded past one record: the page refuses it as damaged, its words
    // the reader's -- "ok · STL" here: r73 A4)
    bits.push(stlCut(sizeFormat, sizeStart, size));
    level = 'bad';
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
