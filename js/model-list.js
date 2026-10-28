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
// room for more fields later; anything else is refused with the reason.
// JavaScript orders an object's integer-like keys ("10", "2") first, by
// number: a list whose files are named so can be an array of pairs instead,
// [["10", "Ten"], ["2", "Two"]], which keeps its order whatever the names.
// Like ?src=, a list on another site must be served with CORS.

export const MAX_LIST_ENTRIES = 10000;
export const MAX_LIST_BYTES = 4 * 2 ** 20;

// -> [{ url, name }] in the file's order. listUrl: the URL the list came
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
    return { url, name: name.trim() || file };
  });
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
