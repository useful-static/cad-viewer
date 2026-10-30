// Offline install (feature review item 24): the viewer's own files -- the
// page, its scripts, the converter -- kept so it opens with no network, and
// installs as an app (manifest.webmanifest). NETWORK FIRST: online, every
// file comes fresh from the server (a cached copy never stands in for a
// newer one); the cache answers only when the network does not. Models and
// model lists are never cached here (a visitor's files are theirs, and a
// site's lists change): only the app.

const CACHE = 'cadv-app-v1';
const SHELL = ['./', 'index.html', 'favicon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// the app's own files, by path under this directory
const scope = new URL('./', self.location.href).pathname;
function isApp(url) {
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scope)) return false;
  const p = url.pathname.slice(scope.length);
  return p === '' || p === 'index.html' || p === 'favicon.svg' || p === 'manifest.webmanifest'
    || /^js\/[\w.-]+\.js$/.test(p) || /^vendor\//.test(p);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isApp(url)) return; // models, lists, everything else: the network alone
  e.respondWith((async () => {
    // (the page itself under any query: ?src=, ?list= are read by the page)
    const key = url.pathname.slice(scope.length) === '' || url.pathname.endsWith('/index.html') ? new Request(new URL('index.html', self.location.href)) : req;
    try {
      const res = await fetch(req);
      if (res.ok) {
        const c = await caches.open(CACHE);
        c.put(key, res.clone());
      }
      return res;
    } catch (err) {
      const hit = await caches.match(key);
      if (hit) return hit;
      throw err;
    }
  })());
});
