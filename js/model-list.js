// Model lists: ?list=<url> names a JSON file of the models a site offers, and
// the viewer shows their names in a drop-down that opens the one picked.
// ?list= may be given more than once; the lists are joined in the order the
// URL gives them, and a file named twice keeps its first place and name.
//
// A list file is one JSON object, file -> display name, in the order shown:
//
//   { "boards/main-board.cadmesh.gz": "Main board",
//     "https://example.com/case.stp.gz": "Case" }
//
// A file is a URL, resolved against the list's own URL (so a list names the
// files beside it by their bare names). A name may also be { "name": "…" },
// with an "orient" beside it: which of that file's axes is up and which faces
// the viewer (js/orient.js), so files drawn in different frames open the same
// way round:
//
//   { "board-a.cadmesh.gz": { "name": "Board A", "orient": "up:+z,front:-y" },
//     "board-b.cadmesh.gz": { "name": "Board B", "orient": "up:+z,front:+x" } }
//
// It may also carry step, page, image, author, license, labels, style and notes (extras,
// below); a field it does not know is ignored, a known one that is wrong is
// refused with the reason.
// JavaScript orders an object's integer-like keys ("10", "2") first, by
// number: a list whose files are named so can be an array of pairs instead,
// [["10", "Ten"], ["2", "Two"]], which keeps its order whatever the names.
// Like ?src=, a list on another site must be served with CORS.

import { parseOrient } from './orient.js';

export const MAX_LIST_ENTRIES = 10000;
export const MAX_LIST_BYTES = 4 * 2 ** 20;

// -> [{ url, name, orient? }] in the file's order (orient canonical, "+z-y").
// listUrl: the URL the list came
// from, which relative files resolve against. Throws a plain-words Error.
export function parseModelList(text, listUrl) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON (${e.message})`);
  }
  if (Array.isArray(data)) {
    // the array form: say which entry is wrong, as the object form does
    const bad = data.findIndex((p) => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string');
    if (bad >= 0) throw new Error(`entry ${bad + 1} is not a [file, name] pair`);
  }
  const pairs = Array.isArray(data) ? data
    : data && typeof data === 'object' ? Object.entries(data) : null;
  if (!pairs) throw new Error('not a list: it must be one JSON object, file -> display name (or an array of [file, name] pairs)');
  if (pairs.length > MAX_LIST_ENTRIES) throw new Error(`${pairs.length} files, more than the ${MAX_LIST_ENTRIES} a list may name`);
  return pairs.map(([file, v]) => {
    if (!file.trim()) throw new Error('a file with no name ("")');
    const name = typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.name === 'string' ? v.name : null;
    if (name === null) throw new Error(`"${file}": its name must be a string (or { "name": "…" })`);
    let url;
    try {
      url = new URL(file, listUrl).href;
    } catch {
      throw new Error(`"${file}" is not a URL`);
    }
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error(`"${file}" is not an http(s) URL`);
    const entry = { url, name: name.trim() || file };
    if (v && typeof v === 'object' && v.orient !== undefined) {
      try {
        entry.orient = parseOrient(v.orient);
      } catch (e) {
        throw new Error(`"${file}": its orient: ${e.message}`);
      }
    }
    if (v && typeof v === 'object') Object.assign(entry, extras(file, v, listUrl));
    return entry;
  });
}

// An entry's other fields, all optional, each checked (a wrong one refuses the
// list, naming the file and the field, as orient does):
//   step     the source CAD file the model was converted from: File >
//            Download STEP (a URL, resolved against the list's)
//   page     the model's own page (a product page): the info panel links it
//   image    a picture of it: File > Browse models shows the list by them, and
//            the download's card while it opens (loaded with CORS: the
//            viewer's page is cross-origin isolated)
//   author, license   who made it and on what terms: the info panel says so
//   labels   { "<a part's name>": "<what to call it>" }: names the parts show
//            in the tree, on hover and in the info panel (the file's own name
//            stays in the tooltip)
//   style    the display style it opens in when this browser has no choice of
//            its own (js/styles.js ids)
//   tours    [{ "name": "A tour of the board", "url": "<a .cadtour.json>" }]:
//            File offers each (js/tour.js), resolved against the list's URL
//   notes    [{ "text": "HDMI", "part": "HDMI_1_3" } or { "text": …, "at": [x, y, z] }]:
//            notes pinned on the model (a part's at the top of it), as
//            Measure's Note makes them, unless a view link brings its own
export const STYLE_IDS = ['shaded', 'edges', 'hidden', 'hiddengrey', 'wire', 'xray'];
function extras(file, v, listUrl) {
  const out = {};
  const bad = (field, why) => new Error(`"${file}": its ${field} ${why}`);
  for (const field of ['step', 'page', 'image']) {
    if (v[field] === undefined) continue;
    if (typeof v[field] !== 'string' || !v[field].trim()) throw bad(field, 'must be a URL');
    let u;
    try { u = new URL(v[field], listUrl); } catch { throw bad(field, `"${v[field]}" is not a URL`); }
    if (!/^https?:$/.test(u.protocol)) throw bad(field, `"${v[field]}" is not an http(s) URL`);
    out[field] = u.href;
  }
  for (const field of ['author', 'license']) {
    if (v[field] === undefined) continue;
    if (typeof v[field] !== 'string' || v[field].length > 200) throw bad(field, 'must be text of at most 200 characters');
    if (v[field].trim()) out[field] = v[field].trim();
  }
  if (v.labels !== undefined) {
    const l = v.labels;
    if (!l || typeof l !== 'object' || Array.isArray(l) || Object.values(l).some((s) => typeof s !== 'string')) {
      throw bad('labels', 'must be an object of part name -> label (text)');
    }
    out.labels = Object.fromEntries(Object.entries(l).filter(([, s]) => s.trim()).map(([k, s]) => [k, s.trim()]));
  }
  if (v.style !== undefined) {
    if (!STYLE_IDS.includes(v.style)) throw bad('style', `must be one of ${STYLE_IDS.join(', ')}`);
    out.style = v.style;
  }
  if (v.tours !== undefined) {
    const t = v.tours;
    const ok = (x) => x && typeof x === 'object' && typeof x.url === 'string' && x.url.trim()
      && (x.name === undefined || (typeof x.name === 'string' && x.name.length <= 100));
    if (!Array.isArray(t) || t.length > 20 || !t.every(ok)) throw bad('tours', 'must be a list (at most 20) of { "name": "…", "url": "<a .cadtour.json>" }');
    out.tours = t.map((x) => {
      let u;
      try { u = new URL(x.url, listUrl); } catch { throw bad('tours', `"${x.url}" is not a URL`); }
      if (!/^https?:$/.test(u.protocol)) throw bad('tours', `"${x.url}" is not an http(s) URL`);
      return { name: (x.name || '').trim() || 'Tour', url: u.href };
    });
  }
  if (v.notes !== undefined) {
    const n = v.notes;
    const ok = (x) => x && typeof x === 'object' && typeof x.text === 'string' && x.text.trim() && x.text.length <= 200
      && ((Array.isArray(x.at) && x.at.length === 3 && x.at.every(Number.isFinite)) || (typeof x.part === 'string' && x.part.trim()));
    if (!Array.isArray(n) || n.length > 100 || !n.every(ok)) {
      throw bad('notes', 'must be a list (at most 100) of { "text": "…" (200 characters at most), and "at": [x, y, z] (mm) or "part": "<a part\'s name>" }');
    }
    out.notes = n.map((x) => ({ text: x.text.trim(), ...(Array.isArray(x.at) ? { at: x.at.slice() } : { part: x.part.trim() }) }));
  }
  return out;
}

// Lists joined in order: a file named again later keeps its first entry.
export function joinModelLists(lists) {
  const seen = new Set();
  const out = [];
  for (const l of lists) {
    for (const e of l) {
      if (seen.has(e.url)) continue;
      seen.add(e.url);
      out.push(e);
    }
  }
  return out;
}

// The body as text, refused once it passes max BYTES (counted as they
// arrive, so a list that declares no size is never read whole first)
async function readCapped(res, max) {
  const over = () => new Error(`over ${max / 2 ** 20} MB`);
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (new TextEncoder().encode(text).length > max) throw over();
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > max) { reader.cancel().catch(() => {}); throw over(); }
    chunks.push(value);
  }
  const all = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return new TextDecoder().decode(all);
}

// Fetch and join every list. One that cannot be read costs its own entries,
// never the others: -> { entries, errors: [{ url, message }] }.
export async function fetchModelLists(urls, base, fetchFn = fetch) {
  const got = await Promise.all(urls.map(async (u) => {
    let url;
    try {
      url = new URL(u, base).href;
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`${res.status === 404 ? 'not found' : 'HTTP'} (${res.status})`);
      // the size it declares refused before reading; the text read is
      // checked too (a server need not declare one)
      const declared = Number(res.headers?.get?.('content-length'));
      if (declared > MAX_LIST_BYTES) throw new Error(`over ${MAX_LIST_BYTES / 2 ** 20} MB`);
      const text = await readCapped(res, MAX_LIST_BYTES);
      // relative files resolve against where the list came from: after a
      // redirect, that is the URL that answered, not the one asked
      return { entries: parseModelList(text, res.url || url) };
    } catch (e) {
      // fetch's own TypeError says only "Failed to fetch": no CORS, or no answer
      const message = e instanceof TypeError && !url ? 'not a URL'
        : e instanceof TypeError ? 'could not be fetched (no answer, or the site does not allow it: CORS)'
          : e && e.name === 'TimeoutError' ? 'no answer in time' : e.message;
      return { entries: [], error: { url: url || u, message } };
    }
  }));
  return { entries: joinModelLists(got.map((g) => g.entries)), errors: got.filter((g) => g.error).map((g) => g.error) };
}
