// Converted models kept in this browser (IndexedDB), so opening the same STEP /
// IGES / BREP file again skips OpenCascade. Everything stays on this device:
// the key is computed here (SHA-256 of the file's bytes, crypto.subtle), the
// mesh is stored here, and nothing is sent anywhere. The key also covers the
// format, the tessellation parameters and CACHE_VERSION, so a different
// setting or an incompatible converter never reuses an old mesh.
//
// Two object stores under one key: `meta` ({ name, size, used }), small, read
// to list and evict; `data` (the .cadmesh bytes, gzipped where the browser
// can), read only on a hit. Past CACHE_CAP_BYTES the least recently used
// entries are dropped. Without IndexedDB or crypto.subtle (plain http is not a
// secure context) every call is a no-op and the viewer converts as before.

// Bump when a converter change alters the meshes. 2: file colours read as
// sRGB (they were darkened), and faces that ran out of memory now mesh.
export const CACHE_VERSION = 2;
export const CACHE_CAP_BYTES = 200e6;
const DB = 'cad-viewer-meshes';

export const cacheAvailable = () =>
  typeof indexedDB !== 'undefined' && !!(globalThis.crypto && crypto.subtle);

// The key: what the mesh depends on.
export async function cacheKey(bytes, format, params) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const p = Object.keys(params || {}).sort().map((k) => `${k}=${params[k]}`).join('&');
  return `v${CACHE_VERSION}|${format}|${p}|${hex}`;
}

// Which keys to drop so the total fits under cap after adding `incoming`
// bytes: least recently used first. Pure.
export function evictionPlan(entries, incoming, cap = CACHE_CAP_BYTES) {
  let total = entries.reduce((s, e) => s + e.size, 0) + incoming;
  const drop = [];
  for (const e of [...entries].sort((a, b) => a.used - b.used)) {
    if (total <= cap) break;
    drop.push(e.key);
    total -= e.size;
  }
  return drop;
}

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('meta', { keyPath: 'key' });
        r.result.createObjectStore('data', { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

// One transaction over both stores; resolves with fn's return value (an
// IDBRequest's result is read once the transaction completes).
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(['meta', 'data'], mode);
    const out = fn(t.objectStore('meta'), t.objectStore('data'));
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

// The cached mesh (an ArrayBuffer) for key, or null; marks it used.
export async function cacheGet(key) {
  if (!cacheAvailable()) return null;
  try {
    const e = await tx('readonly', (_, data) => data.get(key));
    if (!e) return null;
    tx('readwrite', (meta) => {
      const r = meta.get(key);
      r.onsuccess = () => { if (r.result) meta.put({ ...r.result, used: Date.now() }); };
    }).catch(() => {});
    return e.data;
  } catch {
    return null; // a cache that cannot be read is a miss, never an error
  }
}

// Stores data under key, dropping least recently used entries to stay under
// the cap. A mesh larger than the cap is not stored. Failures (a full disk, a
// private window) are ignored: the cache is an optimisation.
export async function cachePut(key, data, name) {
  if (!cacheAvailable() || data.byteLength > CACHE_CAP_BYTES) return false;
  try {
    const entries = await cacheList();
    const drop = evictionPlan(entries.filter((e) => e.key !== key), data.byteLength);
    await tx('readwrite', (meta, store) => {
      for (const k of drop) { meta.delete(k); store.delete(k); }
      meta.put({ key, name, size: data.byteLength, used: Date.now() });
      store.put({ key, data });
    });
    return true;
  } catch {
    return false;
  }
}

// [{ key, name, size, used }]: the metadata only, never the mesh bytes.
export async function cacheList() {
  if (!cacheAvailable()) return [];
  try {
    return (await tx('readonly', (meta) => meta.getAll())) || [];
  } catch {
    return [];
  }
}

export async function cacheClear() {
  if (!cacheAvailable()) return;
  await tx('readwrite', (meta, data) => { meta.clear(); data.clear(); });
}
