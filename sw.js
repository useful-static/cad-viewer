// Offline install (feature review item 24): the viewer's own files -- the
// page, its scripts, the converter -- kept so it opens with no network, and
// installs as an app (manifest.webmanifest). NETWORK FIRST: online, every
// file comes fresh from the server (a cached copy never stands in for a
// newer one); the cache answers only when the network does not. Models and
// model lists are never cached here (a visitor's files are theirs, and a
// site's lists change): only the app.

// The page and every module it can load, kept at install: with the shell alone, a visitor offline
// after one visit got the page and not js/main.js -- a dead page. (The converter, vendor/, is kept
// once fetched: a STEP file opens offline after one has been converted online.) APP_JS is every
// file in js/ (tests/test-sw.mjs holds the two to each other)
const APP_JS = ['box-tree.js', 'cadmesh.js', 'camera.js', 'check-page.js', 'clearance.js', 'cli-args.js', 'codepages.js', 'converter-choice.js', 'crc32.js', 'datum.js',
  'drawing-svg.js', 'dwg.js', 'dxf-view.js', 'dxf.js', 'edges-worker.js', 'edges.js', 'export-mesh.js', 'face-order.js', 'formats.js',
  'import-progress.js', 'list-check.js', 'main.js', 'mat4.js', 'measure-geom.js', 'measure-ui.js', 'mesh-cache.js', 'mesh-formats.js',
  'model-list.js', 'open-url.js', 'orient.js', 'palettes.js', 'prefs.js', 'raycast.js', 'read-file.js', 'read-worker.js', 'renderer-webgl.js',
  'renderer-webgpu.js', 'same-place.js', 'scene.js', 'solid.js', 'source-units.js', 'step-features.js', 'step-meta.js', 'step-text.js', 'step-worker.js',
  'styles.js', 'tour-path.js', 'tour-recorder.js', 'tour-sight.js', 'tour.js', 'units.js', 'vec3.js', 'view-link.js'];
const SHELL = ['./', 'index.html', 'check.html', 'favicon.svg', 'manifest.webmanifest', ...APP_JS.map((f) => `js/${f}`)];
// the cache's name follows the list (a client keeps an old cache until the name changes: written by
// hand, a new list under the old name left the new files out)
const CACHE = `cadv-app-${[...SHELL.join('\n')].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7).toString(36)}`;

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
  // (the shell's own names: SHELL, the one list -- './' is the empty path here)
  return SHELL.includes(p || './') || /^js\/[\w.-]+\.js$/.test(p) || /^vendor\//.test(p);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isApp(url)) return; // models, lists, everything else: the network alone
  e.respondWith((async () => {
    // (a page under any query -- ?src=, ?list= are read by the page -- kept under its bare path:
    // check.html?list= missed its kept copy; the scope's own path is index.html)
    const p = url.pathname.slice(scope.length);
    const key = p === '' ? new Request(new URL('index.html', self.location.href)) : p.endsWith('.html') ? new Request(new URL(p, self.location.href)) : req;
    try {
      const res = await fetch(req);
      // (the copy kept before the worker may stop: put, unawaited, could be lost -- the 12 MB
      // converter then not there offline after one conversion online)
      if (res.ok) { const copy = res.clone(); e.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy))); }
      return res;
    } catch (err) {
      const hit = await caches.match(key);
      if (hit) return hit;
      throw err;
    }
  })());
});
