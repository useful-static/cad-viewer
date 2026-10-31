#!/usr/bin/env node
// The list check (js/list-check.js):  node tests/test-list-check.mjs  (exit 0 = all pass)
// A fake fetch serves a small list: a good model, a missing one, one the site
// will not share (no CORS: the fetch throws), one named .cadmesh.gz that is a
// STEP inside, a picture, a STEP link and a tour, good and broken. Each check
// must read as cad.place would meet it, and name the URL it tried.

import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { checkFile, checkLists, namedFormat, sniffFormat, summary } from '../js/list-check.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

const B = 'https://example.com/boards/';
const cadmesh = gzipSync(Buffer.concat([Buffer.from('CADM'), Buffer.alloc(200)]));
const stepInside = gzipSync(Buffer.from('ISO-10303-21;\nHEADER;\n'));
const tour = JSON.stringify({ cadtour: 1, title: 'A tour', steps: [{ title: 'one' }, { title: 'two' }] });
const FILES = {
  [`${B}models.json`]: JSON.stringify({
    'good.cadmesh.gz': { name: 'Good', id: 'good', image: 'good.webp', step: 'good.stp.gz', tours: [{ name: 'Good tour', url: 'good.cadtour.json' }] },
    'gone.cadmesh.gz': { name: 'Gone' },
    'https://other.example/x.cadmesh.gz': { name: 'Not shared' },
    'liar.cadmesh.gz': { name: 'Liar', tours: [{ name: 'Bad tour', url: 'bad.cadtour.json' }] },
  }),
  [`${B}good.cadmesh.gz`]: cadmesh,
  [`${B}good.webp`]: Buffer.from('RIFF....WEBP'),
  [`${B}good.stp.gz`]: gzipSync(Buffer.from('ISO-10303-21;')),
  [`${B}good.cadtour.json`]: tour,
  [`${B}liar.cadmesh.gz`]: stepInside,
  [`${B}bad.cadtour.json`]: '{ "cadtour": 1, "steps": [] }',
};
async function fakeFetch(url, opts = {}) {
  const u = String(url);
  if (u.startsWith('https://other.example/')) throw new TypeError('Failed to fetch');
  if (!(u in FILES)) return new Response('not here', { status: 404 });
  const body = FILES[u];
  const len = Buffer.byteLength(body);
  const ranged = opts.headers && opts.headers.Range;
  return new Response(opts.method === 'HEAD' ? null : body, {
    status: ranged ? 206 : 200,
    headers: ranged ? { 'content-range': `bytes 0-${len - 1}/${len}`, 'content-length': String(len) } : { 'content-length': String(len) },
  });
}

await test('formats', () => {
  assert.equal(namedFormat(`${B}a.cadmesh.gz`), 'cadmesh');
  assert.equal(namedFormat(`${B}a.STEP`), 'STEP');
  assert.equal(namedFormat(`${B}a.bin`), null);
  assert.equal(sniffFormat(Buffer.from('CADM\0\0')), 'cadmesh');
  assert.equal(sniffFormat(Buffer.from('ISO-10303-21;')), 'STEP');
  assert.equal(sniffFormat(Buffer.from('glTF\x02\0\0\0')), 'glTF');
  assert.equal(sniffFormat(Buffer.from('solid x\n facet normal 0 0 1')), 'STL');
  assert.equal(sniffFormat(Buffer.from('\x00\x01\x02')), null);
});

await test('file-good', async () => {
  const r = await checkFile(`${B}good.cadmesh.gz`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(r.level, 'ok', r.detail);
  assert.match(r.detail, /MB · gzip · cadmesh/);
  assert.equal(r.url, `${B}good.cadmesh.gz`);
});

await test('file-missing-refused-mislabelled', async () => {
  const gone = await checkFile(`${B}gone.cadmesh.gz`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(gone.level, 'bad');
  assert.match(gone.detail, /not found \(404\)/);
  const cors = await checkFile('https://other.example/x.cadmesh.gz', { fetchFn: fakeFetch, sniff: true });
  assert.equal(cors.level, 'bad');
  assert.match(cors.detail, /no CORS header/);
  const liar = await checkFile(`${B}liar.cadmesh.gz`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(liar.level, 'bad');
  assert.match(liar.detail, /named cadmesh, but it starts as STEP/);
});

await test('whole-list', async () => {
  const seen = [];
  const r = await checkLists([`${B}models.json`], 'https://cad.place/', { fetchFn: fakeFetch, onEntry: (e) => seen.push(e.name) });
  assert.deepEqual(r.lists, [{ url: `${B}models.json`, error: null }]);
  assert.equal(r.entries.length, 4);
  assert.equal(seen.length, 4);
  const good = r.entries.find((e) => e.name === 'Good');
  assert.equal(good.id, 'good');
  assert.deepEqual(good.checks.map((c) => [c.what, c.level]),
    [['model', 'ok'], ['picture', 'ok'], ['STEP', 'ok'], ['tour "Good tour"', 'ok']]);
  assert.match(good.checks[3].detail, /2 steps, "A tour"/);
  const liar = r.entries.find((e) => e.name === 'Liar');
  assert.equal(liar.checks[1].level, 'bad');
  assert.match(liar.checks[1].detail, /not a tour cad.place reads/);
  // every check names the URL it tried
  assert.ok(r.entries.every((e) => e.checks.every((c) => /^https:\/\//.test(c.url))));
  // (Good 4, Gone 1, Not shared 1, Liar 2; failed: Gone, Not shared, Liar's model and tour)
  assert.equal(summary(r), '4 models, 8 checks: 4 failed, 0 to look at');
});

await test('list-not-read', async () => {
  const r = await checkLists([`${B}missing.json`], 'https://cad.place/', { fetchFn: fakeFetch });
  assert.equal(r.entries.length, 0);
  assert.ok(r.lists[0].error, 'the list says why it was not read');
  assert.match(summary(r), /1 list not read/);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
