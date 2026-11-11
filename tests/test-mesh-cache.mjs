#!/usr/bin/env node
// The browser's saved conversions (js/mesh-cache.js), the parts Node can run:
// the key and the eviction order.   node tests/test-mesh-cache.mjs  (exit 0 = all pass)
// The IndexedDB side runs in a browser: tests/mesh-cache.py.

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { CACHE_CAP_BYTES, CACHE_VERSION, cacheKey, evictionPlan, staleKeys } from '../js/mesh-cache.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto; // Node 18 has no global crypto

import { test, done } from './harness.mjs';
const bytes = (s) => new TextEncoder().encode(s).buffer;
const P = { linearUnit: 'millimeter', linearDeflection: 0.001, angularDeflection: 0.5 };

await test('same bytes, format and parameters: same key', async () => {
  assert.equal(await cacheKey(bytes('ISO-10303-21;'), 'step', P), await cacheKey(bytes('ISO-10303-21;'), 'step', P));
});
await test('parameter order does not matter', async () => {
  const q = { angularDeflection: 0.5, linearDeflection: 0.001, linearUnit: 'millimeter' };
  assert.equal(await cacheKey(bytes('x'), 'step', P), await cacheKey(bytes('x'), 'step', q));
});
await test('a different byte, format or parameter: a different key', async () => {
  const k = await cacheKey(bytes('x'), 'step', P);
  assert.notEqual(k, await cacheKey(bytes('y'), 'step', P));
  assert.notEqual(k, await cacheKey(bytes('x'), 'iges', P));
  assert.notEqual(k, await cacheKey(bytes('x'), 'step', { ...P, angularDeflection: 0.35 }));
});
await test('the key carries the cache version and a full SHA-256', async () => {
  const k = await cacheKey(bytes(''), 'step', P);
  assert.ok(k.startsWith(`v${CACHE_VERSION}|`), k);
  assert.ok(k.endsWith('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'), k); // sha256('')
});
await test('nothing dropped while it fits', () => {
  assert.deepEqual(evictionPlan([{ key: 'a', size: 10, used: 1 }], 10, 100), []);
});
await test('least recently used dropped first, only as many as needed', () => {
  const e = [{ key: 'new', size: 40, used: 30 }, { key: 'old', size: 40, used: 10 }, { key: 'mid', size: 40, used: 20 }];
  assert.deepEqual(evictionPlan(e, 30, 100), ['old', 'mid']);
  assert.deepEqual(evictionPlan(e, 10, 100), ['old']);
});
await test('entries of an older CACHE_VERSION are stale, this one\'s are not', () => {
  const cur = `v${CACHE_VERSION}|step|a=1|abc`;
  const old = `v${CACHE_VERSION - 1}|step|a=1|abc`;
  const longer = `v${CACHE_VERSION}0|step|a=1|abc`; // v30 is not v3
  assert.deepEqual(staleKeys([{ key: cur }, { key: old }, { key: longer }]), [old, longer]);
});
await test('the cap is generous for a large assembly (the rack is 3.2 MB gzipped)', () => {
  assert.ok(CACHE_CAP_BYTES >= 100e6);
});
// (r112 M mesh-cache-C1, mesh-cache-O4) a total of exactly the cap fits; one byte over drops the oldest
await test('a total exactly at the cap keeps everything, one byte over drops the oldest (r112 M mesh-cache-C1, mesh-cache-O4)', () => {
  const e = [{ key: 'a', size: 40, used: 1 }, { key: 'b', size: 50, used: 2 }];
  assert.deepEqual(evictionPlan(e, 10, 100), []);
  assert.deepEqual(evictionPlan(e, 11, 100), ['a']);
});

// The IndexedDB side over a small in-memory stand-in (the browser run is tests/mesh-cache.py): enough
// of IDBFactory / transaction / object store / request for mesh-cache.js's calls. A request's
// result is set at once; onsuccess and the transaction's oncomplete fire on a later task.
class FakeRequest { constructor(result) { this.result = result; } }
function fakeIndexedDB() {
  const stores = { meta: new Map(), data: new Map() };
  const later = (f) => setTimeout(f, 0);
  const store = (m) => ({
    get: (k) => { const r = new FakeRequest(m.get(k)); later(() => r.onsuccess && r.onsuccess()); return r; },
    put: (v) => { m.set(v.key, v); return new FakeRequest(v.key); },
    delete: (k) => { m.delete(k); return new FakeRequest(undefined); },
    getAll: () => new FakeRequest([...m.values()]),
    clear: () => { m.clear(); return new FakeRequest(undefined); },
  });
  const d = { createObjectStore() {}, transaction: () => { const t = { objectStore: (n) => store(stores[n]) }; later(() => t.oncomplete && t.oncomplete()); return t; } };
  return { open: () => { const r = { result: d }; later(() => { if (r.onupgradeneeded) r.onupgradeneeded(); if (r.onsuccess) r.onsuccess(); }); return r; } };
}
const mc = await import('../js/mesh-cache.js');
// (r112 M mesh-cache-C0) no IndexedDB (Node, an old browser): the cache is off; with one, on
await test('the cache is off without IndexedDB and on with it (r112 M mesh-cache-C0)', () => {
  assert.equal(typeof globalThis.indexedDB, 'undefined');
  assert.equal(mc.cacheAvailable(), false);
  globalThis.IDBRequest = FakeRequest;
  globalThis.indexedDB = fakeIndexedDB();
  assert.equal(mc.cacheAvailable(), true);
});
// (r112 M mesh-cache-B1, mesh-cache-R2, mesh-cache-C2, mesh-cache-R13, mesh-cache-R8) a small mesh
// put is stored, listed and read back
await test('a small mesh put is stored, listed and read back (r112 M mesh-cache-B1, mesh-cache-R2, mesh-cache-C2, mesh-cache-R13, mesh-cache-R8)', async () => {
  assert.equal(mc.cacheAvailable(), true, 'the stand-in is in');
  const key = `v${CACHE_VERSION}|abc`;
  assert.equal(await mc.cachePut(key, new Uint8Array([1, 2, 3]).buffer, 'part.step'), true);
  assert.deepEqual((await mc.cacheList()).map((e) => `${e.key} ${e.name} ${e.size}`), [`${key} part.step 3`]);
  const got = await mc.cacheGet(key);
  assert.ok(got, 'read back');
  assert.deepEqual([...new Uint8Array(got)], [1, 2, 3]);
  assert.equal(await mc.cacheGet(`v${CACHE_VERSION}|none`), null, 'a miss is null');
});
// (r112 M mesh-cache-B4, untriaged in M's report) a hit marks the entry used now: the LRU order
// follows reads, not only writes
await test('a hit marks its entry used now, so eviction follows reads (r112 M mesh-cache-B4)', async () => {
  assert.equal(mc.cacheAvailable(), true, 'the stand-in is in');
  const now = Date.now;
  try {
    const key = `v${CACHE_VERSION}|lru`;
    Date.now = () => 1000;
    await mc.cachePut(key, new Uint8Array([7]).buffer, 'lru.step');
    Date.now = () => 5000;
    assert.ok(await mc.cacheGet(key));
    await new Promise((r) => setTimeout(r, 20)); // the refresh is not awaited by cacheGet
    const e = (await mc.cacheList()).find((x) => x.key === key);
    assert.equal(e.used, 5000);
  } finally {
    Date.now = now;
  }
});

done();
