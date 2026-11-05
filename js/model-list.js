// Model lists: ?list=<url> names a JSON file of the models a site offers, and
// the viewer shows their names in a drop-down that opens the one picked. Also
// the address's rules the page (main.js) and its early fetch (js/early.js)
// share: the model it names (modelUrlFrom, modelNameFrom), whether a poster
// holds it back (posterAsked), and a list's or tour's read (timedFetch).
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
// It may also carry step, page, links, image, author, license, labels, style and notes (extras,
// below); a field it does not know is ignored, a known one that is wrong is
// refused with the reason.
// JavaScript orders an object's integer-like keys ("10", "2") first, by
// number: a list whose files are named so can be an array of pairs instead,
// [["10", "Ten"], ["2", "Two"]], which keeps its order whatever the names.
// Like ?src=, a list on another site must be served with CORS.
// A file must be http(s), or on the list's own scheme and host (an app that
// serves the viewer and its files from its own scheme, js/same-place.js).

import { parseOrient } from './orient.js';
import { samePlace } from './same-place.js';
import { STYLE_IDS } from './styles.js';
import { PART_NAME_MAX, PART_NAMES_MAX, STEP_ID, isPartName } from './tour.js';
import { NOTES_MAX, NOTE_TEXT_MAX, notePlace } from './view-link.js';
import { fileUrl } from './open-url.js';

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
  const entries = pairs.map(([file, v]) => {
    if (!file.trim()) throw new Error('a file with no name ("")');
    const name = typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.name === 'string' ? v.name : null;
    if (name === null) throw new Error(`"${file}": its name must be a string (or { "name": "…" })`);
    let url;
    try {
      url = new URL(file, listUrl).href;
    } catch {
      throw new Error(`"${file}" is not a URL`);
    }
    if (!samePlace(url, listUrl)) throw new Error(`"${file}" is not an http(s) URL, nor on the list's own scheme and host`);
    const entry = { url, name: name.trim() || file };
    if (v && typeof v === 'object' && v.orient !== undefined) {
      try {
        entry.orient = parseOrient(v.orient);
      } catch (e) {
        throw new Error(`"${file}": its orient: ${e.message}`);
      }
    }
    if (v && typeof v === 'object') Object.assign(entry, extras(file, v, listUrl));
    if (v && typeof v === 'object') Object.assign(entry, names(file, v));
    return entry;
  });
  // (an id or an alias names one model of the list: a second is refused)
  const taken = new Map();
  for (const e of entries) {
    for (const n of [e.id, ...(e.aliases || [])].filter(Boolean)) {
      if (taken.has(n)) throw new Error(`"${n}" names two models (${taken.get(n)} and ${e.name})`);
      taken.set(n, e.name);
    }
  }
  return entries;
}

// A model's fixed names: "id", the one a link names it by (?model=<id>),
// and "aliases", ids it was known by before, which links made then still
// use. The same form as a tour step's id, and the same pattern (js/tour.js
// STEP_ID): a-z, 0-9 and "-", starting with a letter or digit, at most 64.
export const MODEL_ID = STEP_ID;
function names(file, v) {
  const out = {};
  if (v.id !== undefined) {
    if (typeof v.id !== 'string' || !MODEL_ID.test(v.id)) throw new Error(`"${file}": its id must be a-z, 0-9 and "-", starting with a letter or digit, at most 64`);
    out.id = v.id;
  }
  if (v.aliases !== undefined) {
    if (!Array.isArray(v.aliases) || v.aliases.length > 20 || !v.aliases.every((a) => typeof a === 'string' && MODEL_ID.test(a))) {
      throw new Error(`"${file}": its aliases must be a list (at most 20) of ids (a-z, 0-9 and "-")`);
    }
    out.aliases = v.aliases.filter((a) => a !== v.id);
  }
  return out;
}

// The entry a link's ?model= names: by its id, else by one of its aliases
export function entryByName(entries, name) {
  if (!name) return null;
  return (entries || []).find((e) => e.id === name) || (entries || []).find((e) => (e.aliases || []).includes(name)) || null;
}

// An address's query back to the URL of the model it names, given the page's lists (`lists`, the
// ?list= values) and their entries once read: null for none, or for a ?model= / ?index= the lists
// do not have, or not yet read. ?model= matches an entry's id, else an alias. A numeric ?src= beside
// a list is read as ?index= (links made before it). A relative ?src= beside a list is the entry it
// names, read against the list's own URL as the list's files are ("boards/x.cadmesh" in a list at
// example.com/models.json), else against the page. The one rule for the page (main.js modelUrlIn)
// and for its early fetch (js/early.js), which starts the model's download before main.js runs.
const isPlace = (raw) => /^\d+$/.test(raw || '');
// The place in the list an address names: ?index=, else a numeric ?src= (links made before ?index=);
// one test for the model's URL and for its name (they tested it apart, and ?index=x&src=2 named
// "2" while the URL was the raw string "2", a 404: r56 A5)
const placeIn = (search) => [search.get('index'), search.get('src')].find(isPlace) || null;
// (relative to the page or to a list: not a scheme's URL, not a //host one)
export const isRelative = (s) => !!s && !/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith('//');
// Whether the address asks for an embed's poster (?embed=1&poster=<image>): its picture, and the
// model only with View in 3D -- for the page and its early fetch alike (they decided it apart, and
// a ?list= embed with a poster downloaded its first model at once: r53 Q2, A2)
export const posterAsked = (search) => search.get('embed') === '1' && !!search.get('poster');
// A model list's or a tour's read: given up after 20 s, as the page and its early fetch both ask
// (r53 A4: written out three times)
export const READ_TIMEOUT_MS = 20000;
// Whether a read failed by that time running out -- at the headers or while the body still came (the
// signal covers both): one test for the page's list and tour reads and check.html's (r55 A5, Q7)
export const isTimeout = (e) => !!e && e.name === 'TimeoutError';
// The URL a fetched file was read from, which what it names resolves against: the one that answered
// (a redirect's target), else the one asked. The one rule for a list's files and a tour's model, on
// the page and in check.html (a tour resolved against the URL asked, a list against the one that
// answered: r56 A1)
export const answeredFrom = (res, asked) => (res && res.url) || asked;
// (check.html's list check reads lists and tours by it too: without it, a list that answers in 21 s
// read 🟢 there and "no answer in time" on cad.place -- r54 A2)
export const timedFetch = (u, init = {}) => fetch(u, typeof AbortSignal.timeout === 'function' ? { ...init, signal: AbortSignal.timeout(READ_TIMEOUT_MS) } : init);
export function modelUrlFrom(search, lists, entries, base) {
  const listed = lists.length > 0;
  if (listed && search.get('model')) return entryByName(entries, search.get('model'))?.url || null;
  const place = placeIn(search);
  if (listed && place) return entries?.[Number(place) - 1]?.url || null;
  const src = search.get('src');
  return (listed && listedUrlFrom(src, lists, entries, base)) || src || null;
}
// The entry a relative address names, read against each list's own URL as the list's files are; null
// for none. For ?src= (above) and for each ?add= (js/main.js openStart: a relative ?add= the list
// names was read from the page's address, and 404'd, the hint saying the list did not name it: r54 A6)
// Against the URL each entry's list was read from first (a GitHub blob page's raw file, a Dropbox link's,
// a redirect's target: the ?list= as written named none of them, and a relative ?src= the list named
// was read from the page and 404'd -- r55 A2); against the ?list= values as written where an entry
// carries none (one made by hand).
export function listedUrlFrom(ref, lists, entries, base) {
  if (!isRelative(ref)) return null;
  for (const e of entries || []) {
    for (const from of e.listUrls || []) {
      try { if (new URL(ref, from).href === e.url) return e.url; } catch { /* not a URL */ }
    }
  }
  for (const l of lists) {
    let url = null;
    try { url = new URL(ref, new URL(l, base)).href; } catch { /* not a URL */ }
    const e = url && (entries || []).find((x) => x.url === url);
    if (e) return e.url;
  }
  return null;
}
// What an address names by its list, which must be read before it opens: "model le-potato",
// "index 3", a relative src the list may name; null when it names an absolute URL or nothing
export function modelNameFrom(search, lists) {
  if (!lists.length) return null;
  if (search.get('model')) return `"${search.get('model')}"`;
  const place = placeIn(search);
  if (place) return place;
  return isRelative(search.get('src')) ? `"${search.get('src')}"` : null;
}

// An entry's other fields, all optional, each checked (a wrong one refuses the
// list, naming the file and the field, as orient does):
//   step     the source CAD file the model was converted from: File >
//            Download STEP (a URL, resolved against the list's)
//   page     the model's own page (a product page): the info panel links it
//   links    [{ "name": "Board layout", "url": "<an http(s) page>" }] (at most
//            10): more pages about it, which the info panel lists after the
//            page, each by its name and its site's host (a list on any site
//            can name any page, so the host is never left out)
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
//   id       a fixed name, which a link names the model by: ?model=<id>
//            (a-z, 0-9, "-"; one model's in the joined lists, MODEL_ID)
//   aliases  [ "<an id it had before>", … ]: links made then still open it
//   hide     [ "<a part's name>", … ]: parts hidden when it opens (a heatsink
//            over the chips), unless a view link brings its own view; Show all
//            brings them back. Names as a tour names parts (js/tour.js
//            resolveParts: a label, a node, a body, a path, or "#<id>")
function extras(file, v, listUrl) {
  const out = {};
  const bad = (field, why) => new Error(`"${file}": its ${field} ${why}`);
  // Two kinds of URL: a FILE the viewer fetches (its step, image, tours) is allowed as the
  // model file is -- http(s), or the list's own scheme and host (js/same-place.js samePlace);
  // a PAGE a visitor opens in a tab (page, links) must be http(s)
  const fetched = (u, field, raw) => { if (!samePlace(u.href, listUrl)) throw bad(field, `"${raw}" is not an http(s) URL, nor on the list's own scheme and host`); };
  const page = (u, field, raw) => { if (!/^https?:$/.test(u.protocol)) throw bad(field, `"${raw}" is not an http(s) URL`); };
  // a fetched file named by a share page (a GitHub blob, a Dropbox link) is read from the file
  // itself, as the model file is (js/open-url.js): what check.html checks is what is loaded
  const direct = fileUrl;
  for (const field of ['step', 'page', 'image']) {
    if (v[field] === undefined) continue;
    if (typeof v[field] !== 'string' || !v[field].trim()) throw bad(field, 'must be a URL');
    let u;
    try { u = new URL(v[field], listUrl); } catch { throw bad(field, `"${v[field]}" is not a URL`); }
    (field === 'page' ? page : fetched)(u, field, v[field]);
    out[field] = field === 'page' ? u.href : direct(u.href);
  }
  for (const field of ['author', 'license']) {
    if (v[field] === undefined) continue;
    if (typeof v[field] !== 'string' || v[field].length > 200) throw bad(field, 'must be text of at most 200 characters');
    if (v[field].trim()) out[field] = v[field].trim();
  }
  if (v.labels !== undefined) {
    const l = v.labels;
    // (a label is what a tour then names the part by: the tour's limits, js/tour.js)
    if (!l || typeof l !== 'object' || Array.isArray(l) || Object.keys(l).length > PART_NAMES_MAX
      || !Object.entries(l).every(([k, s]) => isPartName(k) && typeof s === 'string' && s.length <= PART_NAME_MAX)) {
      throw bad('labels', `must be an object of part name -> label (text): at most ${PART_NAMES_MAX}, each name and label at most ${PART_NAME_MAX} characters, as in a tour`);
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
      fetched(u, 'tours', x.url);
      return { name: (x.name || '').trim() || 'Tour', url: direct(u.href) };
    });
  }
  if (v.links !== undefined) {
    const k = v.links;
    const ok = (x) => x && typeof x === 'object' && typeof x.url === 'string' && x.url.trim()
      && typeof x.name === 'string' && x.name.trim() && x.name.trim().length <= 100;
    if (!Array.isArray(k) || k.length > 10 || !k.every(ok)) throw bad('links', 'must be a list (at most 10) of { "name": "…" (100 characters at most), "url": "<an http(s) page>" }');
    out.links = k.map((x) => {
      let u;
      try { u = new URL(x.url, listUrl); } catch { throw bad('links', `"${x.url}" is not a URL`); }
      page(u, 'links', x.url);
      return { name: x.name.trim(), url: u.href };
    });
  }
  if (v.notes !== undefined) {
    const n = v.notes;
    // (placed by the notes' one rule, js/view-link.js notePlace: its part when it names one,
    // else its point -- as a tour's callouts are)
    const ok = (x) => x && typeof x === 'object' && typeof x.text === 'string' && x.text.trim() && x.text.length <= NOTE_TEXT_MAX && notePlace(x);
    if (!Array.isArray(n) || n.length > NOTES_MAX || !n.every(ok)) {
      throw bad('notes', `must be a list (at most ${NOTES_MAX}) of { "text": "…" (${NOTE_TEXT_MAX} characters at most), and "part": "<a part's name>" or "at": [x, y, z] (mm) }`);
    }
    out.notes = n.map((x) => ({ text: x.text.trim(), ...notePlace(x) }));
  }
  if (v.hide !== undefined) {
    const h = v.hide;
    if (!Array.isArray(h) || h.length > PART_NAMES_MAX || !h.every(isPartName)) {
      throw bad('hide', `must be a list (at most ${PART_NAMES_MAX}) of part names (${PART_NAME_MAX} characters at most, as in a tour)`);
    }
    out.hide = h.map((x) => x.trim());
  }
  return out;
}

// Lists joined in order: a file named again later keeps its first entry,
// and an id or alias an earlier list already gave keeps its first model
// (the later entry stays, without that name).
export function joinModelLists(lists) {
  const seen = new Set();
  const named = new Set();
  const out = [];
  for (const l of lists) {
    for (const e of l) {
      // (a file two lists name keeps its first place -- and the URL the second was read from too, so
      // a relative address from either list finds it: it was the first list's alone, r56 Q4)
      if (seen.has(e.url)) {
        const kept = out.find((x) => x.url === e.url);
        if (kept?.listUrls && e.listUrls) kept.listUrls.push(...e.listUrls.filter((u) => !kept.listUrls.includes(u)));
        continue;
      }
      seen.add(e.url);
      let x = e;
      if ((e.id && named.has(e.id)) || (e.aliases || []).some((a) => named.has(a))) {
        x = { ...e, aliases: (e.aliases || []).filter((a) => !named.has(a)) };
        if (named.has(e.id)) delete x.id;
        if (e.listUrls) Object.defineProperty(x, 'listUrls', { value: e.listUrls, enumerable: false }); // (not spread)
      }
      for (const n of [x.id, ...(x.aliases || [])].filter(Boolean)) named.add(n);
      out.push(x);
    }
  }
  return out;
}

// The body as text, refused once it passes max BYTES (counted as they
// arrive, so a list -- or a tour -- that declares no size is never read whole first; a 171 KB
// gzipped tour unpacked to 172 MB on the page's thread)
export async function readCapped(res, max) {
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
      // (a list shared as a GitHub page or a Dropbox link is read from the file: js/open-url.js)
      url = fileUrl(new URL(u, base).href);
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`${res.status === 404 ? 'not found' : 'HTTP'} (${res.status})`);
      // the size it declares refused before reading; the text read is
      // checked too (a server need not declare one)
      const declared = Number(res.headers?.get?.('content-length'));
      if (declared > MAX_LIST_BYTES) throw new Error(`over ${MAX_LIST_BYTES / 2 ** 20} MB`);
      const text = await readCapped(res, MAX_LIST_BYTES);
      // relative files resolve against where the list came from: after a
      // redirect, that is the URL that answered, not the one asked
      // (each entry keeps the URL its list was read from -- a share page's file, a redirect's target --
      // which a relative ?src= / ?add= naming it resolves against: listedUrlFrom. Not enumerable: the
      // entry's own fields stay what the list says)
      const from = answeredFrom(res, url);
      return { entries: parseModelList(text, from).map((e) => Object.defineProperty(e, 'listUrls', { value: [from], enumerable: false })) };
    } catch (e) {
      // fetch's own TypeError says only "Failed to fetch": no CORS, or no answer
      const message = e instanceof TypeError && !url ? 'not a URL'
        : e instanceof TypeError ? 'could not be fetched (no answer, or the site does not allow it: CORS)'
          : isTimeout(e) ? 'no answer in time' : e.message;
      return { entries: [], error: { url: url || u, message } };
    }
  }));
  return { entries: joinModelLists(got.map((g) => g.entries)), errors: got.filter((g) => g.error).map((g) => g.error) };
}
