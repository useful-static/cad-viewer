// A model list's health, for its owner (check.html): each entry fetched the
// way cad.place fetches it, from this page, so a refusal here is the one a
// visitor meets. Per entry: the model (answered? CORS? found? its size, and
// whether its first bytes are the format its name says), its picture, its
// STEP, its tours (read and checked as cad.place reads them); and the list
// itself (read, entries, names given twice). Every check says the URL it
// tried. Pure apart from fetch, which the caller passes (tests pass a fake):
// tests/test-list-check.mjs.

import { fetchModelLists, readCapped } from './model-list.js';
import { MAX_TOUR_BYTES, parseTour } from './tour.js';
import { FORMATS, SNIFF_BYTES, fileNameOfUrl, formatOfName, sniffFormat as sniffBytes } from './formats.js';
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
const mb = (n) => (n / 1e6).toFixed(n < 1e6 ? 2 : 1);

// What a failed fetch means, as cad.place would meet it
function refused(e) {
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
  if (sniff) {
    const start = await head(res, 65536);
    const gz = isGzip(start);
    const inner = gz ? await gunzipStart(start) : start;
    const got = inner ? sniffFormat(inner) : null;
    const want = namedFormat(url);
    if (gz) bits.push('gzip');
    if (!inner) {
      bits.push('its gzip could not be read here');
      level = 'warn';
    } else if (got && want && got !== want && BY_LABEL.get(want)?.as !== got.toLowerCase()) {
      // the viewer opens a mesh or a 2D drawing by its bytes where they are conclusive
      // (js/mesh-formats.js meshFormatOf; a DWG by its "AC10" whatever its name), so a .stl
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
  return { level, detail: bits.join(' · '), url };
}

// One tour: read, parsed as cad.place parses it
export async function checkTour(url, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(url, { cache: 'no-store' });
  } catch (e) {
    return { level: 'bad', detail: refused(e), url };
  }
  if (!res.ok) return { level: 'bad', detail: `${res.status === 404 ? 'not found' : 'refused'} (${res.status})`, url };
  try {
    const t = parseTour(await readCapped(res, MAX_TOUR_BYTES), url);
    return { level: 'ok', detail: `${t.steps.length} steps${t.title ? `, "${t.title}"` : ''}`, url };
  } catch (e) {
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
  const r = await fetchModelLists(urls, base, fetchFn);
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
    checks.push({ what: 'model', ...(await checkFile(e.url, { fetchFn, sniff: true })) });
    if (e.image) checks.push({ what: 'picture', ...(await checkFile(e.image, { fetchFn, method: 'HEAD' })) });
    if (e.step) checks.push({ what: 'STEP', ...(await checkFile(e.step, { fetchFn, method: 'HEAD', download: true })) });
    for (const t of e.tours || []) checks.push({ what: `tour "${t.name}"`, ...(await checkTour(t.url, fetchFn)) });
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
