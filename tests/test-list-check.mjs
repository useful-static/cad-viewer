#!/usr/bin/env node
// The list check (js/list-check.js):  node tests/test-list-check.mjs  (exit 0 = all pass)
// A fake fetch serves a small list: a good model, a missing one, one the site
// will not share (no CORS: the fetch throws), one named .cadmesh.gz that is a
// STEP inside, a picture, a STEP link and a tour, good and broken. Each check
// must read as cad.place would meet it, and name the URL it tried.

import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { checkFile, checkLists, insertInOrder, namedFormat, sniffFormat, summary } from '../js/list-check.js';
import { fileNameOfUrl } from '../js/formats.js';

import { test, done } from './harness.mjs';

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
  // 2 MB of noise after the magic: gzip cannot shrink it, so the file is far
  // bigger than the 64 KB part the check reads
  [`${B}big.cadmesh.gz`]: gzipSync(Buffer.concat([Buffer.from('CADM'), randomBytes(2_000_000)])),
  [`${B}good.webp`]: Buffer.from('RIFF....WEBP'),
  [`${B}good.stp.gz`]: gzipSync(Buffer.from('ISO-10303-21;')),
  [`${B}good.cadtour.json`]: tour,
  [`${B}liar.cadmesh.gz`]: stepInside,
  [`${B}bad.cadtour.json`]: '{ "cadtour": 1, "steps": [] }',
  // formats whose start only hints: the viewer opens these by name
  [`${B}normals-first.obj`]: '# exported\n\nvn 0 0 1\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1//1 2//1 3//1\n',
  [`${B}sorted.gltf`]: '{"accessors":[],"asset":{"version":"2.0"}}',
  [`${B}get?file=board.stl`]: 'solid b\n facet normal 0 0 1\n',
  [`${B}ply-named-obj.obj`]: 'ply\nformat ascii 1.0\n',
  [`${B}case.3mf`]: Buffer.from('PK\x03\x04rest'),
  [`${B}ply-named-stl.stl`]: 'ply\nformat ascii 1.0\n',
  [`${B}dwg-named-dxf.dxf`]: Buffer.from('AC1015\0\0\0\0'),
  // sent with Content-Encoding: gzip: the browser has unpacked it by the time it is read
  [`${B}unpacked.stp.gz`]: 'ISO-10303-21;\nHEADER;\n',
  [`${B}text.stp.gz`]: 'hello',
};
async function fakeFetch(url, opts = {}) {
  const u = String(url);
  if (u.startsWith('https://other.example/')) throw new TypeError('Failed to fetch');
  if (!(u in FILES)) return new Response('not here', { status: 404 });
  const body = FILES[u];
  const len = Buffer.byteLength(body);
  const ranged = opts.headers && opts.headers.Range;
  // a part is a 206 whose Content-Length is the part's; with hideRange the
  // Content-Range is hidden, as a browser hides it from another site's page
  // when the server does not expose it (libre.computer, 2026-10-31)
  const partLen = Math.min(len, 65536);
  const headers = { 'content-length': String(ranged ? partLen : len) };
  if (ranged && !fakeFetch.hideRange) headers['content-range'] = `bytes 0-${partLen - 1}/${len}`;
  return new Response(opts.method === 'HEAD' ? null : Buffer.from(body).subarray(0, ranged ? partLen : len), { status: ranged ? 206 : 200, headers });
}

await test('formats', () => {
  assert.equal(namedFormat(`${B}a.cadmesh.gz`), 'cadmesh');
  assert.equal(namedFormat(`${B}a.STEP`), 'STEP');
  assert.equal(namedFormat(`${B}a.bin`), null);
  assert.equal(sniffFormat(Buffer.from('CADM\0\0')), 'cadmesh');
  assert.equal(sniffFormat(Buffer.from('ISO-10303-21;')), 'STEP');
  assert.equal(sniffFormat(Buffer.from('glTF\x02\0\0\0')), 'GLB');
  assert.equal(sniffFormat(Buffer.from('solid x\n facet normal 0 0 1')), 'STL');
  assert.equal(sniffFormat(Buffer.from('\x00\x01\x02')), null);
  assert.equal(sniffFormat(Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00\x00\x00SECTION\x00')), 'DXF');
});

await test('file-good', async () => {
  const r = await checkFile(`${B}good.cadmesh.gz`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(r.level, 'ok', r.detail);
  assert.match(r.detail, /MB · gzip · cadmesh/);
  assert.equal(r.url, `${B}good.cadmesh.gz`);
});

// the size of a model bigger than the 64 KB part read: from Content-Range,
// or, when the browser hides that header, from a HEAD's Content-Length --
// never the part's own Content-Length (live bug: every board read 0.07 MB)
await test('file-size-beyond-the-part', async () => {
  const total = Buffer.byteLength(FILES[`${B}big.cadmesh.gz`]);
  const want = `${(total / 1e6).toFixed(1)} MB`;
  for (const hide of [false, true]) {
    fakeFetch.hideRange = hide;
    const r = await checkFile(`${B}big.cadmesh.gz`, { fetchFn: fakeFetch, sniff: true });
    assert.equal(r.level, 'ok', r.detail);
    assert.ok(r.detail.startsWith(`${want} · gzip · cadmesh`), `hideRange=${hide}: ${r.detail}, want ${want}`);
  }
  fakeFetch.hideRange = false;
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

await test('name-only formats: a start that only hints is no fault; a mesh holding another mesh warns; a magic mismatch is bad', async () => {
  for (const f of ['normals-first.obj', 'sorted.gltf', 'case.3mf']) {
    const r = await checkFile(`${B}${f}`, { fetchFn: fakeFetch, sniff: true });
    assert.equal(r.level, 'ok', `${f}: ${r.detail}`);
  }
  const ply = await checkFile(`${B}ply-named-obj.obj`, { fetchFn: fakeFetch, sniff: true });
  assert.match(ply.detail, /named OBJ, but it is a PLY \(opens as one\)/);
  assert.equal(ply.level, 'warn', 'a mesh holding another mesh opens: a warning, not bad');
  const stl = await checkFile(`${B}ply-named-stl.stl`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(stl.level, 'warn', stl.detail);
  // must fire: a model named one thing that is not a mesh the viewer can open is bad
  const liar = await checkFile(`${B}liar.cadmesh.gz`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(liar.level, 'bad');
});
await test('a .dxf holding a DWG opens (a warning); a .gz that arrives unpacked opens; one that is something else is bad', async () => {
  const dwg = await checkFile(`${B}dwg-named-dxf.dxf`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(dwg.level, 'warn', dwg.detail);
  assert.match(dwg.detail, /named DXF, but it is a DWG \(opens as one\)/);
  const up = await checkFile(`${B}unpacked.stp.gz`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(up.level, 'ok', up.detail);
  assert.match(up.detail, /arrives unpacked/);
  const junk = await checkFile(`${B}text.stp.gz`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(junk.level, 'bad', junk.detail);
});
await test('a STEP the site sends without CORS is a warning (a download link needs none); a model so is bad', async () => {
  const step = await checkFile('https://other.example/x.stp', { fetchFn: fakeFetch, method: 'HEAD', download: true });
  assert.equal(step.level, 'warn', step.detail);
  assert.match(step.detail, /a download link does not need/);
  const model = await checkFile('https://other.example/x.cadmesh.gz', { fetchFn: fakeFetch, sniff: true });
  assert.equal(model.level, 'bad');
});
await test('a broken list named by a GitHub page is reported broken, not "read, 0 failed"', async () => {
  const r = await checkLists(['https://github.com/o/r/blob/main/missing.json'], 'https://cad.place/', { fetchFn: fakeFetch });
  assert.equal(r.lists.length, 1);
  assert.ok(r.lists[0].error, JSON.stringify(r.lists));
});
await test('a model named in the query: named as the viewer names it', async () => {
  assert.equal(namedFormat(`${B}get?file=board.stl`), 'STL');
  assert.equal(namedFormat(`${B}get.php?file=board.stl`), 'STL');
  const r = await checkFile(`${B}get?file=board.stl`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(r.level, 'ok', r.detail);
  assert.match(r.detail, /STL/);
});
await test('fileNameOfUrl: the path\'s model name, else a query value naming one, else the path\'s', () => {
  assert.equal(fileNameOfUrl('https://x/rack.cadmesh?v=2'), 'rack.cadmesh');
  assert.equal(fileNameOfUrl('https://x/api/download?file=part.step&token=abc'), 'part.step');
  assert.equal(fileNameOfUrl('https://x/get.php?file=board.stl'), 'board.stl');
  assert.equal(fileNameOfUrl('https://x/api/download?id=7'), 'download');
  assert.equal(fileNameOfUrl('https://x/my%20part.stp'), 'my part.stp');
  assert.equal(fileNameOfUrl('https://x/README.md'), 'README.md');
});

await test('the check page puts each entry\'s rows in the list\'s order, whatever order the checks finish in', () => {
  // a stub tbody: rows in order, insertBefore(fragment, row | null)
  const body = { rows: [], insertBefore(frag, before) { const k = before ? this.rows.indexOf(before) : this.rows.length; this.rows.splice(k, 0, ...frag.children); } };
  const frag = (name, n) => ({ children: Array.from({ length: n }, (_, j) => ({ name: `${name}${j}`, dataset: {} })) });
  // entries 0..4, finished 3, 0, 4, 2, 1; each 1-3 rows (an entry's checks)
  for (const i of [3, 0, 4, 2, 1]) insertInOrder(body, frag(`e${i}.`, 1 + (i % 3)), i);
  assert.deepEqual(body.rows.map((r) => r.name), ['e0.0', 'e1.0', 'e1.1', 'e2.0', 'e2.1', 'e2.2', 'e3.0', 'e4.0', 'e4.1']);
});

await test('a model whose body drops after its headers is that model\'s red row, not the whole check stopped', async () => {
  const list = JSON.stringify({ 'a.stl': 'good', 'b.stl': 'dropped', 'c.stl': 'also good' });
  const stl = new TextEncoder().encode('solid x\nfacet normal 0 0 1\n');
  const bodyOf = (fail) => { let bytes = stl; return { getReader: () => ({ read: async () => { if (fail) throw new TypeError('network error'); const v = bytes; bytes = null; return v ? { done: false, value: v } : { done: true }; }, cancel: async () => {} }) }; };
  const fetchFn = async (url) => {
    if (String(url).endsWith('list.json')) return new Response(list, { status: 200, headers: { 'content-type': 'application/json' } });
    return { ok: true, status: 200, headers: new Headers({ 'content-length': '100' }), body: bodyOf(String(url).endsWith('b.stl')), arrayBuffer: async () => stl.buffer };
  };
  const r = await checkLists(['https://x.test/list.json'], 'https://x.test/', { fetchFn, parallel: 1 });
  assert.deepEqual(r.entries.map((e) => [e.name, e.checks[0].level]), [['good', 'ok'], ['dropped', 'bad'], ['also good', 'ok']]);
  assert.match(r.entries[1].checks[0].detail, /could not be read: network error/);
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

await test('the list and its tours are read as cad.place reads them: given up after its 20 s, said as it says it (r54 A2)', async () => {
  const { checkTour } = await import('../js/list-check.js');
  const real = globalThis.fetch;
  const inits = [];
  globalThis.fetch = async (u, init = {}) => {
    inits.push([String(u), !!init.signal]);
    if (String(u).endsWith('slow.cadtour.json')) { const e = new Error('signal timed out'); e.name = 'TimeoutError'; throw e; }
    return new Response(String(u).endsWith('.json') ? JSON.stringify({ 'a.cadmesh': 'A' }) : 'x', { status: 200 });
  };
  try {
    // (checkLists with no fetch of its own given: the page's)
    await checkLists(['https://example.com/l.json'], 'https://example.com/');
    assert.deepEqual(inits.filter(([u]) => u.endsWith('l.json')), [['https://example.com/l.json', true]], 'the list read with a time limit');
    const t = await checkTour('https://example.com/slow.cadtour.json');
    assert.equal(t.level, 'bad');
    assert.match(t.detail, /^no answer in time \(20 s, as cad\.place waits\)/);
  } finally { globalThis.fetch = real; }
});

done();
