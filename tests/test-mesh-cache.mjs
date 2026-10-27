#!/usr/bin/env node
// The browser's saved conversions (js/mesh-cache.js), the parts Node can run:
// the key and the eviction order.   node tests/test-mesh-cache.mjs  (exit 0 = all pass)
// The IndexedDB side runs in a browser: tests/mesh-cache.py.

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { CACHE_CAP_BYTES, CACHE_VERSION, cacheKey, evictionPlan, staleKeys } from '../js/mesh-cache.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto; // Node 18 has no global crypto

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
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

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
