// What the page fetches before main.js runs (js/early.js), handed on to main.js: the ?list= read,
// and the download of the model the address names. Each is taken once -- by the first fetch of the
// same URL (loadUrl), or by the read of the same lists (readLists) -- and a load that never comes for
// it leaves it alone. On a slow link the model's download started only after every module had
// arrived and the GPU had started (a 1.9 MB model at 20 s of a 3G page): started here, it runs
// alongside them.
// No imports: this module is in the small graph js/early.js runs from, and in main.js's.

const early = new Map(); // url -> Promise<Response>
let lists = null; // { key, result: Promise<{ entries, errors }> }

// Start fetching url now (no-op when it is already on its way)
export function startEarly(url) {
  if (early.has(url)) return;
  const p = fetch(url);
  p.catch(() => { /* its taker reports a failure; one never taken is no one's */ });
  early.set(url, p);
}

// A fetch of url: the one started early, once, else a fetch now. (The early one has no signal of the
// caller's: a Cancel or a newer load ends it by cancelling its body's reader, as the caller's own
// read loop does when its load is stale.)
export function earlyFetch(url, init) {
  const p = early.get(url);
  if (!p) return fetch(url, init);
  early.delete(url);
  return p;
}

// The lists read early, kept for the read of the same lists (in order)
export function setEarlyLists(urls, result) { lists = { key: urls.join('\n'), result }; }
export function earlyLists(urls) {
  if (!lists || lists.key !== urls.join('\n')) return null;
  const { result } = lists;
  lists = null;
  return result;
}
