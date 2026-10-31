// A model list's health, for its owner (check.html): each entry fetched the
// way cad.place fetches it, from this page, so a refusal here is the one a
// visitor meets. Per entry: the model (answered? CORS? found? its size, and
// whether its first bytes are the format its name says), its picture, its
// STEP, its tours (read and checked as cad.place reads them); and the list
// itself (read, entries, names given twice). Every check says the URL it
// tried. Pure apart from fetch, which the caller passes (tests pass a fake):
// tests/test-list-check.mjs.

import { fetchModelLists } from './model-list.js';
import { parseTour } from './tour.js';

// The format a file's name says ("board.cadmesh.gz" -> "cadmesh")
const EXT = {
  cadmesh: 'cadmesh', stp: 'STEP', step: 'STEP', igs: 'IGES', iges: 'IGES', brep: 'BREP', brp: 'BREP',
  stl: 'STL', obj: 'OBJ', ply: 'PLY', off: 'OFF', '3mf': '3MF', glb: 'glTF', gltf: 'glTF', dxf: 'DXF', zip: 'zip',
};
export function namedFormat(url) {
  const path = new URL(url).pathname.toLowerCase().replace(/\.gz$/, '');
  return EXT[path.split('.').pop()] || null;
}

// The format a file's first bytes say (after gunzip), or null
export function sniffFormat(bytes) {
  const b = bytes;
  const text = new TextDecoder('latin1').decode(b.subarray(0, Math.min(400, b.length))).replace(/^ï»¿/, '');
  if (text.startsWith('CADM')) return 'cadmesh';
  if (/^\s*ISO-10303-21\s*;/.test(text)) return 'STEP';
  if (/^\s*DBRep_DrawableShape/.test(text)) return 'BREP';
  if (text.startsWith('glTF')) return 'glTF';
  if (text.startsWith('PK\x03\x04')) return 'zip';
  if (/^ply\s/.test(text)) return 'PLY';
  if (/^\s*(\d+\s*\n\s*)?0\s*\n\s*SECTION/.test(text)) return 'DXF';
  if (/^\s*solid[\s\S]*facet/.test(text)) return 'STL';
  if (/^\s*\{\s*"(asset|scenes|nodes|meshes)"/.test(text)) return 'glTF';
  if (/^(\s*(#.*)?\n)*\s*(v|o|g|mtllib)\s/.test(text)) return 'OBJ';
  if (/^\s*OFF\s/.test(text)) return 'OFF';
  const line = text.split(/\r?\n/)[0];
  if (line.length >= 73 && line[72] === 'S') return 'IGES';
  return null;
}
// (3MF and a zip of models are both zips; a binary STL has no magic: its
// header is free text, so it is judged by its name)
const SAME = { '3MF': 'zip', STL: null };

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
async function gunzipStart(bytes, n = 512) {
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
export async function checkFile(url, { fetchFn = fetch, sniff = false, method = 'GET' } = {}) {
  let res;
  try {
    res = await fetchFn(url, sniff ? { headers: { Range: 'bytes=0-65535' }, cache: 'no-store' } : { method, cache: 'no-store' });
  } catch (e) {
    return { level: 'bad', detail: refused(e), url };
  }
  if (!res.ok) {
    return { level: 'bad', detail: `${res.status === 404 ? 'not found' : 'refused'} (${res.status})`, url };
  }
  const range = res.headers.get('content-range');
  const total = range && /\/(\d+)$/.test(range) ? Number(range.match(/\/(\d+)$/)[1]) : Number(res.headers.get('content-length')) || null;
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
    } else if (got && want && got !== want && SAME[want] !== got) {
      bits.push(`named ${want}, but it starts as ${got}`);
      level = 'bad';
    } else if (!got && want && SAME[want] !== null) {
      bits.push(`named ${want}, but its start is no ${want} file`);
      level = 'bad';
    } else {
      bits.push(got || want || 'format unknown');
      if (!got && !want) level = 'warn';
    }
    if (url.toLowerCase().endsWith('.gz') && !gz) {
      bits.push('named .gz but not gzip');
      level = 'bad';
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
    const t = parseTour(await res.text(), url);
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
    const err = r.errors.find((e) => e.url === abs || e.url === u);
    return { url: abs, error: err ? err.message || String(err.error || err) : null };
  });
  const n = r.entries.length;
  const entries = await pool(r.entries.map((e, i) => async () => {
    const checks = [];
    checks.push({ what: 'model', ...(await checkFile(e.url, { fetchFn, sniff: true })) });
    if (e.image) checks.push({ what: 'picture', ...(await checkFile(e.image, { fetchFn, method: 'HEAD' })) });
    if (e.step) checks.push({ what: 'STEP', ...(await checkFile(e.step, { fetchFn, method: 'HEAD' })) });
    for (const t of e.tours || []) checks.push({ what: `tour "${t.name}"`, ...(await checkTour(t.url, fetchFn)) });
    const out = { name: e.name, url: e.url, id: e.id || null, checks };
    if (onEntry) onEntry(out, i, n);
    return out;
  }), parallel);
  return { lists, entries };
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
