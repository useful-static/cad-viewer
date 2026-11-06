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
import { FORMATS, MAX_TEXT_BYTES, SNIFF_BYTES, TEXT_LIMIT_WORDS, BINARY_DXF_SENTINEL, dwgRefusal, fileNameOfUrl, formatOfName, sniffFormat as sniffBytes } from './formats.js';
import { MAX_FILE_BYTES } from './cadmesh.js';
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

// gunzip the start of a gzip stream (a partial stream decodes what it has)
// (as much as the page's sniff reads: SNIFF_BYTES -- 512 called a gzipped DXF behind a 1000-byte
// comment "format unknown" where the page opens it)
async function gunzipStart(bytes, n = SNIFF_BYTES) {
  if (typeof DecompressionStream !== 'function') return null;
  try {
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await head(new Response(s), n);
  } catch {
    return null;
  }
}

const isGzip = (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
// (MB of 2^20 bytes, as the page's own limits and words count them: in millions, a file at the
// 2 GiB limit read 2147.5 MB here and 2,048 MB on the page -- r71 A11)
const mb = (n) => (n / 2 ** 20).toFixed(n < 2 ** 20 ? 2 : 1);

// What a failed fetch means, as cad.place would meet it
function refused(e) {
  // (given up after cad.place's own time: said as it says it -- r54 A2)
  if (isTimeout(e)) return `no answer in time (${READ_TIMEOUT_MS / 1000} s, as cad.place waits)`;
  return `not fetched: the site sent no CORS header for it, or did not answer (${e && e.message ? e.message : e})`;
}

// One file: answered, CORS, found, size; with sniff, its format too.
// -> { ok, level: 'ok' | 'warn' | 'bad', detail, url }
// download: the viewer only links to the file (Download STEP), never fetches it
export async function checkFile(url, { fetchFn = fetch, sniff = false, method = 'GET', download = false } = {}) {
  // a host's share page (a GitHub blob, a Dropbox dl=0 link) is fetched as the file it shares,
  // as the viewer fetches it (js/open-url.js)
  const fetchUrl = fileUrl(url);
  let res;
  try {
    res = await fetchFn(fetchUrl, sniff ? { headers: { Range: 'bytes=0-65535' }, cache: 'no-store' } : { method, cache: 'no-store' });
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
  let sizeFormat = namedFormat(url), sizeStart = null, sizeGz = fileNameOfUrl(url).toLowerCase().endsWith('.gz');
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
    sizeStart = gz ? null : inner;
    sizeGz = gz;
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
  if (total && total > MAX_FILE_BYTES) {
    bits.push(`more than the ${mb(MAX_FILE_BYTES)} MB of file this viewer opens`);
    level = 'bad';
  } else if (total && total > MAX_TEXT_BYTES && !sizeGz && readAsText(sizeFormat, sizeStart, total)) {
    bits.push(`${mb(total)} MB of text, ${TEXT_LIMIT_WORDS}`);
    level = 'bad';
  }
  return { level, detail: bits.join(' · '), url };
}
// Whether the page reads a file of this format as one text (js/mesh-formats.js text, js/dxf.js
// dxfText): OBJ, OFF and glTF always; an STL that starts "solid" and is not 84 + 50 n bytes; a PLY
// whose header says ascii; a DXF that is not binary. start: its first bytes, when read (else by name)
export function readAsText(label, start, size) {
  const head = start ? String.fromCharCode(...start.subarray(0, Math.min(start.length, 512))) : '';
  switch (label) {
    case 'OBJ': case 'OFF': case 'glTF': return true;
    case 'STL': return start ? /^\s*solid/.test(head) && (size - 84) % 50 !== 0 : false;
    case 'PLY': return start ? /format\s+ascii/.test(head) : false;
    case 'DXF': return start ? !head.startsWith(BINARY_DXF_SENTINEL) : true;
    default: return false;
  }
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
