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
  [`${B}r12.dwg`]: Buffer.from('AC1009\0\0\0\0'),
  [`${B}r12-named-dxf.dxf`]: Buffer.from('AC1009\0\0\0\0'),
  [`${B}r2000.dwg`]: Buffer.from('AC1015\0\0\0\0'),
  [`${B}r2-named-dxf.dxf`]: Buffer.from('AC2.10\0\0\0\0'),
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
  const want = `${(Math.ceil((total / 2 ** 20) * 10) / 10).toFixed(1)} MB`; // (MB of 2^20, as the page counts: r71 A11; up to a tenth: r73 Q4)
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
await test('a DWG of a release the page does not read is bad, in the reader\'s words, whatever its name (r64 A2)', async () => {
  const { readDWG } = await import('../js/dwg.js');
  let said = null;
  try { readDWG(FILES[`${B}r12.dwg`]); } catch (e) { said = e.message; }
  const r12 = await checkFile(`${B}r12.dwg`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(r12.level, 'bad', r12.detail);
  assert.ok(r12.detail.includes(said), `${r12.detail} | ${said}`);
  const named = await checkFile(`${B}r12-named-dxf.dxf`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(named.level, 'bad', named.detail);
  assert.match(named.detail, /AC1009 DWG \(older than R13\) is not read \(named DXF\)/);
  // (and a release before R10, its tag with a point, is a DWG to the sniff as to the words: called
  // "ok · DXF" by its name, which the page refused as no DXF -- r66 A3)
  const r2 = await checkFile(`${B}r2-named-dxf.dxf`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(r2.level, 'bad', r2.detail);
  assert.match(r2.detail, /an AC2\.10 DWG \(older than R13\) is not read \(named DXF\)/);
  // must accept: a release it reads stays ok
  const r2000 = await checkFile(`${B}r2000.dwg`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(r2000.level, 'ok', r2000.detail);
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

await test('a file the page refuses for its size is said so: past the file limit, and a text format past the text limit (r71 A3)', async () => {
  // (a fetch that says a size it does not send: the start of the file, its total in Content-Range)
  const sized = (start, total) => async () => new Response(Buffer.from(start), { status: 206, headers: { 'content-length': String(start.length), 'content-range': `bytes 0-${start.length - 1}/${total}` } });
  // (an STL's first 84 bytes: its 80-byte header, then the triangle count bytes 80-83 say)
  const stlStart = (head, n) => { const b = Buffer.alloc(84); b.write(head, 'latin1'); b.writeUInt32LE(n, 80); return b; };
  const asciiStart = 'solid x\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n';
  const big = await checkFile(`${B}huge.stl`, { fetchFn: sized(stlStart('', 60e6), 3e9), sniff: true });
  assert.equal(big.level, 'bad', `a 3 GB STL: ${big.detail} (must fire: ok)`);
  // (in the page's words: js/cadmesh.js OVERSIZE_WORDS -- r72 A8)
  assert.match(big.detail, /over 2 GB, more than this viewer opens/);
  const text = await checkFile(`${B}ascii.stl`, { fetchFn: sized(asciiStart, 700 * 2 ** 20 + 1), sniff: true });
  assert.equal(text.level, 'bad', `a 700 MB ASCII STL: ${text.detail}`);
  // (700 MB and a byte: said past 700, as the size bit says it -- r73 Q4)
  assert.match(text.detail, /700\.1 MB · STL · 700\.1 MB of text, more than the 500 MB of text this viewer reads/);
  const dxf = await checkFile(`${B}plan.dxf`, { fetchFn: sized('  0\nSECTION\n  2\nHEADER\n', 700 * 2 ** 20), sniff: true });
  assert.equal(dxf.level, 'bad', `a 700 MB ASCII DXF: ${dxf.detail}`);
  // must accept: a binary STL of that size (84 + 50 n bytes, n in its header), read as bytes, not text
  const bin = await checkFile(`${B}binary.stl`, { fetchFn: sized(stlStart('', 14680064), 84 + 50 * 14680064), sniff: true });
  assert.notEqual(bin.level, 'bad', `a 700 MB binary STL: ${bin.detail}`);
  // (by the reader's own rule, js/formats.js stlIsBinary -- r72 A2): an ASCII STL whose size happens
  // to be 84 + 50 k is text to the page, refused (must fire: "ok"); a binary one whose header starts
  // "solid", 2 bytes over, opens (must fire: bad)
  const k = 12e6;
  // (r73 A4) a binary STL cut short: the page refuses it as damaged (must fire: "ok · STL")
  const cut = await checkFile(`${B}cut.stl`, { fetchFn: sized(stlStart('', 1000), 84 + 50 * 999), sniff: true });
  assert.equal(cut.level, 'bad', cut.detail);
  assert.match(cut.detail, /damaged: its header counts 1,000 triangles, so it should be 50,084 bytes, but it is 50,034 bytes/);
  const ascii50 = await checkFile(`${B}ascii50.stl`, { fetchFn: sized(asciiStart, 84 + 50 * k), sniff: true });
  assert.equal(ascii50.level, 'bad', `a ${84 + 50 * k}-byte ASCII STL: ${ascii50.detail}`);
  const solidBin = await checkFile(`${B}solid-bin.stl`, { fetchFn: sized(stlStart('solid exported by a CAD program', k), 84 + 50 * k + 2), sniff: true });
  assert.notEqual(solidBin.level, 'bad', `a binary STL whose header says "solid", 2 bytes over: ${solidBin.detail}`);
});
await test('a PLY is text by its reader\'s own header rule: a late format line, or none, is ascii (r73 A2: two 700 MB ASCII PLYs said "ok")', async () => {
  const sized = (start, total) => async () => new Response(Buffer.from(start), { status: 206, headers: { 'content-length': String(start.length), 'content-range': `bytes 0-${start.length - 1}/${total}` } });
  const late = `ply\n${'comment a long header\n'.repeat(40)}format ascii 1.0\nelement vertex 3\nproperty float x\nend_header\n`;
  const none = 'ply\nelement vertex 3\nproperty float x\nend_header\n';
  for (const [what, start] of [['a late format line', late], ['no format line', none]]) {
    const r = await checkFile(`${B}scan.ply`, { fetchFn: sized(start, 700 * 2 ** 20), sniff: true });
    assert.equal(r.level, 'bad', `${what}: ${r.detail} (must fire: ok)`);
  }
  // must accept: a binary one that size
  const bin = await checkFile(`${B}scan.ply`, { fetchFn: sized('ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nend_header\n', 700 * 2 ** 20), sniff: true });
  assert.notEqual(bin.level, 'bad', bin.detail);
});
await test('a gzip is held to the limits by what it unpacks to, its trailer read with a range (r72 Q1: a 1.8 MB .stl.gz of 546 MB ASCII STL said "ok")', async () => {
  const { gzipSync } = await import('node:zlib');
  // (a server answering each range: the file's start, a real gzip, and its last 4 bytes, ISIZE)
  const served = (start, total, isize) => async (u, o = {}) => {
    const r = (o.headers && o.headers.Range) || '';
    const tail = Buffer.alloc(4);
    tail.writeUInt32LE(isize >>> 0, 0);
    const body = r.startsWith(`bytes=${total - 4}-`) ? tail : start;
    const from = body === tail ? total - 4 : 0;
    return new Response(body, { status: 206, headers: { 'content-length': String(body.length), 'content-range': `bytes ${from}-${from + body.length - 1}/${total}` } });
  };
  const ascii = gzipSync(Buffer.from('solid x\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\n'));
  // (gzips of 5 MB and more: by their trailer -- the small ones are counted whole, below)
  const big = await checkFile(`${B}part.stl.gz`, { fetchFn: served(ascii, 5e6, 546 * 2 ** 20), sniff: true });
  assert.equal(big.level, 'bad', `546 MB of ASCII STL in 5 MB of gzip: ${big.detail} (must fire: ok)`);
  assert.match(big.detail, /unpacks to 546 MB of text, more than the 500 MB of text this viewer reads/);
  const huge = await checkFile(`${B}part.stl.gz`, { fetchFn: served(ascii, 5e6, 3 * 2 ** 30), sniff: true });
  assert.match(huge.detail, /unpacks to over 2 GB, more than this viewer opens/);
  // must accept: under the limit; and a binary STL unpacking past the text limit (read as bytes)
  const small = await checkFile(`${B}part.stl.gz`, { fetchFn: served(ascii, 5e6, 40 * 2 ** 20), sniff: true });
  assert.notEqual(small.level, 'bad', small.detail);
  const n = 14680064, hd = Buffer.alloc(84);
  hd.writeUInt32LE(n, 80);
  const bin = await checkFile(`${B}part.stl.gz`, { fetchFn: served(gzipSync(hd), 5e6, 84 + 50 * n), sniff: true });
  assert.notEqual(bin.level, 'bad', `a 700 MB binary STL in gzip: ${bin.detail}`);
  // (r73 A1, Q1: the trailer is the LAST member's size, mod 4 GiB) below what the gzip itself takes:
  // a 4.6 GB ASCII STL in 400 MB of gzip, or a gzip of several members -- not told apart, so said,
  // a warning (must fire: "ok · 381.5 MB")
  const wrapped = await checkFile(`${B}part.stl.gz`, { fetchFn: served(ascii, 400e6, 4.6e9 % 2 ** 32), sniff: true });
  assert.equal(wrapped.level, 'warn', wrapped.detail);
  assert.match(wrapped.detail, /cannot be told from its last four bytes \(past 4 GB, or a gzip of several members\)/);
  // a small gzip, counted whole as the page unpacks it: every member (must fire: its trailer's, the
  // last member's), and one the page cannot unpack, refused in its words (must fire: "ok")
  const members = Buffer.concat([gzipSync(Buffer.from('solid x\n'.repeat(400))), gzipSync(Buffer.from('endsolid x\n'))]);
  const whole2 = async () => new Response(members, { status: 200, headers: { 'content-length': String(members.length) } });
  const two = await checkFile(`${B}two.stl.gz`, { fetchFn: whole2, sniff: true });
  assert.notEqual(two.level, 'bad', two.detail);
  const sized2 = (bytes) => async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  const counted = await checkFile(`${B}big.stl.gz`, { fetchFn: sized2(Buffer.concat([gzipSync(Buffer.alloc(600 * 2 ** 20, 0x20).fill('solid x\n', 0, 8)), gzipSync(Buffer.from('endsolid x\n'))])), sniff: true });
  assert.equal(counted.level, 'bad', counted.detail);
  assert.match(counted.detail, /unpacks to 600\.1 MB of text/); // (600 MB and the second member's 11 bytes)
  const junk = Buffer.concat([gzipSync(Buffer.from('solid x\n'.repeat(400))), Buffer.from('trailing junk, no member')]);
  const broken = await checkFile(`${B}junk.stl.gz`, { fetchFn: sized2(junk), sniff: true });
  assert.equal(broken.level, 'bad', broken.detail);
  assert.match(broken.detail, /the viewer cannot unpack it: /);
  // a 5 GB binary STL: its header's count settles the size (must fire: "672 MB of text")
  const hd5 = Buffer.alloc(84);
  hd5.writeUInt32LE(1e8, 80);
  const bin5 = await checkFile(`${B}part.stl.gz`, { fetchFn: served(gzipSync(hd5), 400e6, (84 + 50 * 1e8) % 2 ** 32), sniff: true });
  assert.match(bin5.detail, /unpacks to over 2 GB/);
  assert.doesNotMatch(bin5.detail, /of text/);
  // not settled: 100 MB of gzip saying 300 MB could be 4.3 GB -- said, a warning, not "ok"
  const unsure = await checkFile(`${B}part.stl.gz`, { fetchFn: served(ascii, 100e6, 300 * 2 ** 20), sniff: true });
  assert.equal(unsure.level, 'warn', unsure.detail);
  assert.match(unsure.detail, /unpacks to 300 MB, or that and a multiple of 4 GB/);
  // a server that ignores the range (a 200 for the trailer): not asked, a warning (must fire: "ok")
  const whole = async (u, o = {}) => ((o.headers && o.headers.Range || '').startsWith('bytes=0-')
    ? new Response(ascii, { status: 206, headers: { 'content-length': String(ascii.length), 'content-range': `bytes 0-${ascii.length - 1}/${100e6}` } })
    : new Response(ascii, { status: 200, headers: { 'content-length': String(100e6) } }));
  const noRange = await checkFile(`${B}part.stl.gz`, { fetchFn: whole, sniff: true });
  assert.equal(noRange.level, 'warn', noRange.detail);
  assert.match(noRange.detail, /its unpacked size could not be asked/);
});
await test('a ranged read that fails where a plain one opens the file is asked again plainly, not called a CORS failure (r73 Q2: a host sending its stored Content-Encoding)', async () => {
  // (the browser's ranged request asks for identity; such a host sends gzip anyway, and the fetch
  // fails, net::ERR_CONTENT_DECODING_FAILED -- the plain GET the page makes arrives unpacked)
  const obj = Buffer.from('o cube\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  const host = async (u, o = {}) => {
    if (o.headers && o.headers.Range) throw new TypeError('Failed to fetch');
    return new Response(obj, { status: 200, headers: { 'content-length': String(obj.length) } });
  };
  const r = await checkFile(`${B}cube.obj`, { fetchFn: host, sniff: true });
  assert.notEqual(r.level, 'bad', `${r.detail} (must fire: "not fetched: the site sent no CORS header")`);
  assert.match(r.detail, /OBJ/);
  // must reject still: one that fails both ways
  const gone = await checkFile(`${B}cube.obj`, { fetchFn: async () => { throw new TypeError('Failed to fetch'); }, sniff: true });
  assert.match(gone.detail, /not fetched: the site sent no CORS header/);
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
    // (the headers in time, the body not: a timeout too, not "not a tour cad.place reads" -- r55 A5, Q7)
    globalThis.fetch = async () => new Response(new ReadableStream({ start(ctl) { ctl.error(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })); } }), { status: 200 });
    const b = await checkTour('https://example.com/slow-body.cadtour.json');
    assert.match(b.detail, /^no answer in time \(20 s, as cad\.place waits\)/);
  } finally { globalThis.fetch = real; }
});

// (the tour's model said where the page opens it: resolved against the URL that answered, a redirect's
// target -- answeredFrom's use here was unobservable, r57 Q8)
await test('a tour\'s own model is reported as the page opens it, from the URL that answered (r57 Q8)', async () => {
  const { checkTour } = await import('../js/list-check.js');
  const fetchFn = async () => {
    const res = new Response(JSON.stringify({ cadtour: 1, model: 'c.stl', steps: [{ title: 'one' }] }), { status: 200 });
    Object.defineProperty(res, 'url', { value: 'https://example.com/moved/t.cadtour.json' });
    return res;
  };
  const t = await checkTour('https://example.com/t.cadtour.json', fetchFn);
  assert.equal(t.level, 'ok');
  assert.match(t.detail, /; its model https:\/\/example\.com\/moved\/c\.stl$/);
});

done();
