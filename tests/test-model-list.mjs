#!/usr/bin/env node
// Model lists (?list=, js/model-list.js): parse, resolve, join in URL order:
//   node tests/test-model-list.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { fetchModelLists, joinModelLists, parseModelList } from '../js/model-list.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

const L = 'https://site.example/api/models.json';

await test('files resolve against the list, in the file\'s order', () => {
  const e = parseModelList('{"b.cadmesh.gz": "B board", "/p/a.stp.gz": "A board", "https://x.example/c.cadmesh": "C"}', L);
  assert.deepEqual(e, [
    { url: 'https://site.example/api/b.cadmesh.gz', name: 'B board' },
    { url: 'https://site.example/p/a.stp.gz', name: 'A board' },
    { url: 'https://x.example/c.cadmesh', name: 'C' },
  ]);
});
await test('a name may be an object with a name; an empty name shows the file', () => {
  const e = parseModelList('{"a.cadmesh": {"name": "A"}, "b.cadmesh": "  "}', L);
  assert.deepEqual(e.map((x) => x.name), ['A', 'b.cadmesh']);
});
await test('anything else is refused, saying why', () => {
  assert.throws(() => parseModelList('"a list"', L), /one JSON object/);
  assert.throws(() => parseModelList('[["a.cadmesh", "A"], ["b.cadmesh"]]', L), /entry 2 is not a \[file, name\] pair/);
  assert.throws(() => parseModelList('{"a": 3}', L), /"a": its name must be a string/);
  assert.throws(() => parseModelList('{"a": ', L), /not JSON/);
  assert.throws(() => parseModelList('{"javascript:alert(1)": "x"}', L), /not an http\(s\) URL/);
});
await test('an array of pairs keeps its order where integer-like keys would not; "" is refused', () => {
  const o = parseModelList('{"z.cadmesh": "Z", "10": "Ten", "2": "Two"}', L).map((x) => x.name);
  assert.deepEqual(o, ['Two', 'Ten', 'Z']); // the object form: JavaScript's key order
  const a = parseModelList('[["z.cadmesh", "Z"], ["10", "Ten"], ["2", "Two"]]', L).map((x) => x.name);
  assert.deepEqual(a, ['Z', 'Ten', 'Two']);
  assert.throws(() => parseModelList('{"": "the list itself"}', L), /no name/);
});
await test('fetch: a declared size over the cap is refused before the body is read', async () => {
  let read = false;
  const r = await fetchModelLists(['l.json'], L, async () => ({ ok: true, status: 200, headers: { get: () => String(5 * 2 ** 20) },
    text: async () => { read = true; return '{}'; } }));
  assert.match(r.errors[0].message, /over 4 MB/);
  assert.equal(read, false);
});
await test('fetch: the cap counts bytes as they arrive, not characters after reading (review r17)', async () => {
  // 3 bytes per character in UTF-8: 1.5 M characters are 4.5 MB
  const body = `{"a.cadmesh": "${'€'.repeat(1.5e6)}"}`;
  const res = new Response(body); // no content-length
  const r = await fetchModelLists(['l.json'], L, async () => res);
  assert.match(r.errors[0]?.message || 'accepted', /over 4 MB/);
});
await test('fetch: after a redirect, files resolve against the URL that answered (review r17)', async () => {
  const res = new Response('{"x.cadmesh": "X"}');
  Object.defineProperty(res, 'url', { value: 'https://cdn.example/lists/real.json' });
  const r = await fetchModelLists(['https://site.example/l.json'], L, async () => res);
  assert.equal(r.entries[0].url, 'https://cdn.example/lists/x.cadmesh');
});
await test('fetch: a timeout is said in plain words (review r17)', async () => {
  const r = await fetchModelLists(['l.json'], L, async () => { throw new DOMException('signal timed out', 'TimeoutError'); });
  assert.equal(r.errors[0].message, 'no answer in time');
});
await test('lists join in order; a file named again keeps its first place and name', () => {
  const a = [{ url: 'u1', name: 'one' }, { url: 'u2', name: 'two' }];
  const b = [{ url: 'u3', name: 'three' }, { url: 'u1', name: 'one again' }];
  assert.deepEqual(joinModelLists([a, b]).map((x) => x.name), ['one', 'two', 'three']);
  assert.deepEqual(joinModelLists([b, a]).map((x) => x.name), ['three', 'one again', 'two']);
});
await test('fetch: the URL order wins over the order answers arrive; a bad list costs only itself', async () => {
  const files = {
    'https://site.example/a.json': ['{"x.cadmesh": "X"}', 30],
    'https://site.example/b.json': ['{"y.cadmesh": "Y"}', 0],
    'https://site.example/bad.json': ['nope', 0],
  };
  const fake = (u) => new Promise((resolve) => {
    const f = files[u];
    setTimeout(() => resolve(f ? { ok: true, status: 200, text: async () => f[0] } : { ok: false, status: 404 }), f ? f[1] : 0);
  });
  const r = await fetchModelLists(['a.json', 'missing.json', 'b.json', 'bad.json'], 'https://site.example/index.html', fake);
  assert.deepEqual(r.entries.map((e) => e.name), ['X', 'Y']);
  assert.deepEqual(r.errors.map((e) => [e.url.split('/').pop(), e.message.split(' ')[0]]), [['missing.json', 'not'], ['bad.json', 'not']]);
});
await test('fetch: a list nobody answers (or CORS refuses) says so', async () => {
  const r = await fetchModelLists(['https://other.example/l.json'], L, async () => { throw new TypeError('Failed to fetch'); });
  assert.match(r.errors[0].message, /CORS/);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
