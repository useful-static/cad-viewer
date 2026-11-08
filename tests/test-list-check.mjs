#!/usr/bin/env node
// The list check (js/list-check.js):  node tests/test-list-check.mjs  (exit 0 = all pass)
// A fake fetch serves a small list: a good model, a missing one, one the site
// will not share (no CORS: the fetch throws), one named .cadmesh.gz that is a
// STEP inside, a picture, a STEP link and a tour, good and broken. Each check
// must read as cad.place would meet it, and name the URL it tried.

import assert from 'node:assert/strict';
import { gzipSync, inflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { crc32 } from '../js/crc32.js';
import { checkFile, checkLists, insertInOrder, namedFormat, sniffFormat, summary } from '../js/list-check.js';
import { fileNameOfUrl } from '../js/formats.js';

import { test, done } from './harness.mjs';

const B = 'https://example.com/boards/';
// (real .cadmesh files: since r84 A2 the check reads a header as the decoder does, and "CADM" and
// zeros is no model the page opens -- "unsupported version 0")
const { encodeCadmesh: encodeCm } = await import('../js/cadmesh.js');
const cmOf = (n, rnd = false) => {
  const pos = new Float32Array(9 * n); for (let i = 0; i < pos.length; i++) pos[i] = rnd ? Math.random() : i % 7;
  return Buffer.from(encodeCm({ meshes: [{ name: 'plate', color: null, positions: pos, normals: null, colors: null, indices: Uint32Array.from({ length: 3 * n }, (_, i) => i) }], root: { name: 'asm', meshes: [0], children: [] } }));
};
const cadmesh = gzipSync(cmOf(1));
const stepInside = gzipSync(Buffer.from('ISO-10303-21;\nHEADER;\n'));
const tour = JSON.stringify({ cadtour: 1, title: 'A tour', steps: [{ title: 'one' }, { title: 'two' }] });
// (meshes the page opens: since r85 Q3 the check runs the page's own reader on a file it holds whole,
// and a stub -- a PLY with no end_header, an STL with no triangle -- is a file the page refuses)
const PLY_TRI = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n';
const OBJ_TRI = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
// (since r86 A1 every mesh and 2D reader is run on a file the check holds: a glTF with a triangle,
// its accessors first -- a start that only hints -- its buffer a data: URI, or a file named by uri)
const TRI_BIN = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
const gltfTri = (uri = `data:application/octet-stream;base64,${TRI_BIN.toString('base64')}`, extra = {}) => JSON.stringify({
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }], asset: { version: '2.0' },
  buffers: [{ uri, byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], ...extra,
});
// a 3MF model part with one triangle (pad: a comment of that many bytes, for a part past a size)
const model3mf = (pad = 0) => `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><!--${' '.repeat(pad)}--><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
// a DWG past what the check reads whole (16 MB): judged by its start alone, as the arms ask, no
// real DWG being in the public tree
const bigDwg = (version) => Buffer.concat([Buffer.from(`${version}\0\0\0\0`), Buffer.alloc(17 * 2 ** 20)]);
const STL_TRI = (name) => `solid ${name}\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\nendsolid ${name}\n`;
// a binary STL of n triangles that each have an area
const stlOf = (n) => { const b = Buffer.alloc(84 + 50 * n); b.writeUInt32LE(n, 80); for (let t = 0; t < n; t++) { const o = 84 + 50 * t + 12; b.writeFloatLE(t, o); b.writeFloatLE(t + 1, o + 12); b.writeFloatLE(t, o + 24); b.writeFloatLE(1, o + 28); } return b; };
// a zip of stored entries [name, bytes], its directory saying usize where given (a size claimed); each
// entry's CRC-32 the true one of what it unpacks to (a deflated one's, where it inflates), as the page
// holds it since r80 Q4
const crcOf = (d, method) => { if (method === 0) return crc32(d); try { return crc32(inflateRawSync(d)); } catch { return 0; } };
const miniZip = (entries) => {
  const parts = [], cds = [];
  let off = 0;
  for (const [name, data, claimed, method = 0, flags = 0, crc] of entries) {
    const nm = Buffer.from(name), d = Buffer.from(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(nm.length, 26);
    // (crc: one given in place of the true one -- a deflated entry that inflates cleanly to the wrong bytes)
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc ?? crcOf(d, method), 16); cd.writeUInt32LE(d.length, 20); cd.writeUInt32LE(claimed ?? d.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(off, 42);
    parts.push(local, nm, d); cds.push(cd, nm);
    off += 30 + nm.length + d.length;
  }
  const cdb = Buffer.concat(cds);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdb, end]);
};
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
  [`${B}big.cadmesh.gz`]: gzipSync(cmOf(30000, true)), // (random coordinates: its gzip past the 64 KB part)
  [`${B}good.webp`]: Buffer.from('RIFF....WEBP'),
  [`${B}good.stp.gz`]: gzipSync(Buffer.from('ISO-10303-21;')),
  [`${B}good.cadtour.json`]: tour,
  [`${B}liar.cadmesh.gz`]: stepInside,
  [`${B}bad.cadtour.json`]: '{ "cadtour": 1, "steps": [] }',
  // formats whose start only hints: the viewer opens these by name
  [`${B}normals-first.obj`]: '# exported\n\nvn 0 0 1\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1//1 2//1 3//1\n',
  [`${B}sorted.gltf`]: gltfTri(),
  [`${B}get?file=board.stl`]: STL_TRI('b'),
  [`${B}ply-named-obj.obj`]: PLY_TRI,
  [`${B}case.3mf`]: miniZip([['3D/3dmodel.model', model3mf()]]),
  [`${B}ply-named-stl.stl`]: PLY_TRI,
  [`${B}dwg-named-dxf.dxf`]: bigDwg('AC1015'),
  [`${B}r12.dwg`]: bigDwg('AC1009'),
  [`${B}r12-named-dxf.dxf`]: bigDwg('AC1009'),
  [`${B}r2000.dwg`]: bigDwg('AC1015'),
  [`${B}r2-named-dxf.dxf`]: bigDwg('AC2.10'),
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
  // (the range asked, from where it starts: a zip's directory is read from its end -- r75)
  const m = ranged ? /bytes=(\d+)-(\d*)/.exec(ranged) : null;
  // (a range starting past the end: 416, as a server answers it -- the check confirms a size so: r86 Q1)
  if (m && +m[1] >= len) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${len}` } });
  const from = m ? Math.min(+m[1], len) : 0;
  const to = m ? Math.min(m[2] === '' ? len - 1 : +m[2], len - 1, from + 65535) : len - 1;
  const partLen = Math.max(0, to - from + 1);
  const headers = { 'content-length': String(ranged ? partLen : len) };
  if (ranged && !fakeFetch.hideRange) headers['content-range'] = `bytes ${from}-${to}/${len}`;
  return new Response(opts.method === 'HEAD' ? null : Buffer.from(body).subarray(ranged ? from : 0, ranged ? to + 1 : len), { status: ranged ? 206 : 200, headers });
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
  // must accept: a release it reads is not refused by its release (its reader, past the 16 MB read
  // here, said not run: r87 A4)
  const r2000 = await checkFile(`${B}r2000.dwg`, { fetchFn: fakeFetch, sniff: true });
  assert.equal(r2000.level, 'warn', r2000.detail);
  assert.match(r2000.detail, /^[^·]+· DWG · its reader was not run here/);
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
  const stl = new TextEncoder().encode(STL_TRI('x'));
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
  const late = `ply\n${'comment a long header\n'.repeat(40)}format ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n`;
  const none = 'ply\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n';
  for (const [what, start] of [['a late format line', late], ['no format line', none]]) {
    const r = await checkFile(`${B}scan.ply`, { fetchFn: sized(start, 700 * 2 ** 20), sniff: true });
    assert.equal(r.level, 'bad', `${what}: ${r.detail} (must fire: ok)`);
  }
  // (r74 Q1) its body alone is held to the limit: 500 MB of body under a 2 KB header opens (must fire:
  // bad, "500.1 MB of text"); a body past it is bad
  const head = `ply\nformat ascii 1.0\n${'comment scanner header\n'.repeat(90)}element vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n`;
  const atLimit = await checkFile(`${B}scan.ply`, { fetchFn: sized(head, head.length + 500 * 2 ** 20), sniff: true });
  assert.notEqual(atLimit.level, 'bad', atLimit.detail);
  const past = await checkFile(`${B}scan.ply`, { fetchFn: sized(head, head.length + 500 * 2 ** 20 + 1), sniff: true });
  assert.equal(past.level, 'bad', past.detail);
  // must accept: a binary one that size
  const bin = await checkFile(`${B}scan.ply`, { fetchFn: sized('ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n', 700 * 2 ** 20), sniff: true });
  assert.notEqual(bin.level, 'bad', bin.detail);
});
await test('a gzip is held to the limits by what it unpacks to, its trailer read with a range (r72 Q1: a 1.8 MB .stl.gz of 546 MB ASCII STL said "ok")', async () => {
  const { gzipSync } = await import('node:zlib');
  // (a server answering each range: the file's start, a real gzip, and its last 4 bytes, ISIZE)
  // (a stand-in for a gzip of megabytes: asked for it whole -- the reader's read since r86 A3 -- it
  // has no such bytes to send, so it refuses, and the check judges by the start and the trailer)
  const served = (start, total, isize) => async (u, o = {}) => {
    const r = (o.headers && o.headers.Range) || '';
    if (!r) throw new TypeError('the stand-in holds no whole file');
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
  const members = Buffer.concat([gzipSync(Buffer.from(STL_TRI('x').replace('endsolid x\n', ''))), gzipSync(Buffer.from('endsolid x\n'))]);
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
await test('a gzip\'s start is read as the page reads it: a short first member, and a PLY header past 4 KB (r74 A1, A3)', async () => {
  const { gzipSync } = await import('node:zlib');
  const sized = (start, total) => async () => new Response(Buffer.from(start), { status: 206, headers: { 'content-length': String(start.length), 'content-range': `bytes 0-${start.length - 1}/${total}` } });
  // a PLY whose header is over 4 KB, its format line late, in 5 MB of gzip saying 540 MB (must fire: "ok")
  const hdr = `ply\n${'comment a long header line of the kind scanners write\n'.repeat(90)}format ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n`;
  const ply = gzipSync(Buffer.from(hdr));
  // (a stand-in: no whole file to send, as above)
  const served = (start, total, isize) => async (u, o = {}) => {
    const r = (o.headers && o.headers.Range) || '';
    if (!r) throw new TypeError('the stand-in holds no whole file');
    const tail = Buffer.alloc(4);
    tail.writeUInt32LE(isize >>> 0, 0);
    const body = r.startsWith(`bytes=${total - 4}-`) ? tail : start;
    const from = body === tail ? total - 4 : 0;
    return new Response(body, { status: 206, headers: { 'content-length': String(body.length), 'content-range': `bytes ${from}-${from + body.length - 1}/${total}` } });
  };
  const r = await checkFile(`${B}scan.ply.gz`, { fetchFn: served(ply, 5e6, 540 * 2 ** 20), sniff: true });
  assert.equal(r.level, 'bad', `${hdr.length}-byte header: ${r.detail} (must fire: ok)`);
  // a gzip whose first member is short: read through to the next (must accept here: node's stream
  // reads every member, so the arm that fires is Chromium's, ui-checks.py gzip-members)
  const two = Buffer.concat([gzipSync(Buffer.from('solid x\n')), gzipSync(Buffer.from(' facet normal 0 0 1\n'.repeat(50)))]);
  const s = await checkFile(`${B}two.stl.gz`, { fetchFn: sized(two, two.length), sniff: true });
  assert.doesNotMatch(s.detail, /could not be read here/);
  assert.match(s.detail, /STL/);
});
await test('a 3MF is held to the text limit by its model part, read from its directory with a range (r74 A5: a 1.3 MB 3MF of a 520 MB part said "ok · zip")', async () => {
  // (a zip of one stored-size entry, its central directory saying what it unpacks to)
  const zipOf = (name, usize) => {
    const nm = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(usize, 22); local.writeUInt16LE(nm.length, 26);
    const data = Buffer.from([3, 0]);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(2, 20); cd.writeUInt32LE(usize, 24); cd.writeUInt16LE(nm.length, 28);
    const body = Buffer.concat([local, nm, data]);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + nm.length, 12); end.writeUInt32LE(body.length, 16);
    return Buffer.concat([body, cd, nm, end]);
  };
  const ranged = (z) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || 'bytes=0-65535');
    const a = +m[1], b = Math.min(+m[2], z.length - 1);
    return new Response(z.subarray(a, b + 1), { status: 206, headers: { 'content-length': String(b - a + 1), 'content-range': `bytes ${a}-${b}/${z.length}` } });
  };
  const big = await checkFile(`${B}plate.3mf`, { fetchFn: ranged(zipOf('3D/3dmodel.model', 520 * 2 ** 20)), sniff: true });
  assert.equal(big.level, 'bad', `${big.detail} (must fire: ok · zip)`);
  assert.match(big.detail, /its model part 3D\/3dmodel\.model unpacks to 520 MB, more than the 500 MB of text this viewer reads/); // (the reader's words: r76 Q5)
  // must accept: under it (its directory true to its data, which is empty: one claiming 40 MB of an
  // empty stream is a damaged zip to the page since r79 Q2)
  // (a part with a triangle: an empty one the page refuses, "has no triangles to show" -- r86 A1)
  const ok = await checkFile(`${B}plate.3mf`, { fetchFn: ranged(miniZip([['3D/3dmodel.model', model3mf()]])), sniff: true });
  assert.notEqual(ok.level, 'bad', ok.detail);
});
await test('a zip or 3MF is checked by the page\'s own rules: the 3MF\'s root from its rels, the zip\'s entry loadZip opens, a gzipped one, a zip64 one (r75 A1-A4)', async () => {
  const { gzipSync } = await import('node:zlib');
  const host = (bytes) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    const a = +m[1], b = Math.min(+m[2], bytes.length - 1);
    return new Response(bytes.subarray(a, b + 1), { status: 206, headers: { 'content-length': String(b - a + 1), 'content-range': `bytes ${a}-${b}/${bytes.length}` } });
  };
  const big = 520 * 2 ** 20;
  const rels = '<?xml version="1.0"?><Relationships><Relationship Target="/3D/plate.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  // (each large entry deflated, its size the directory's: a stored entry is the bytes it holds -- r78 Q2)
  // A1: rooted at /3D/plate.model by its rels (must fire: "ok · zip", by 3D/3dmodel.model)
  const rooted = miniZip([['_rels/.rels', rels], ['3D/plate.model', model3mf(), big, 8]]);
  const a1 = await checkFile(`${B}plate.3mf`, { fetchFn: host(rooted), sniff: true });
  assert.equal(a1.level, 'bad', a1.detail);
  assert.match(a1.detail, /its model part \/3D\/plate\.model unpacks to 520 MB, more than the 500 MB of text this viewer reads/);
  // (r75 Q3: its rels read by the reader's own walker -- a Relationship inside a comment passed over,
  // an entity in its Target decoded; a regex of the check's own took the commented-out one)
  const rels2 = '<?xml version="1.0"?><Relationships><!-- <Relationship Target="/3D/decoy.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/> --><Relationship Target="/3D/pl&#97;te.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  const q3 = await checkFile(`${B}plate.3mf`, { fetchFn: host(miniZip([['_rels/.rels', rels2], ['3D/plate.model', model3mf(), big, 8]])), sniff: true });
  assert.equal(q3.level, 'bad', `${q3.detail} (must fire: ok, by the decoy)`);
  // A2: a zip whose entry loadZip opens is a 520 MB OBJ (must fire: "ok")
  // (deflated and true to its directory: 520 MB of text in under 1 MB of data -- a claim of 520 MB
  // over 1.2 MB of data is a damaged zip since r79 Q2, read so here since r80 Q1)
  const { deflateRawSync } = await import('node:zlib');
  const objText = Buffer.alloc(big, 0x20); objText.write('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  const obj = miniZip([['readme.txt', 'hello'], ['part.obj', deflateRawSync(objText), big, 8]]);
  const a2 = await checkFile(`${B}part.zip`, { fetchFn: host(obj), sniff: true });
  assert.equal(a2.level, 'bad', a2.detail);
  assert.match(a2.detail, /its part\.obj unpacks to 520 MB of text/);
  // A3: the same 3MF gzipped (must fire: "ok · gzip · zip")
  const a3 = await checkFile(`${B}plate.3mf.gz`, { fetchFn: host(gzipSync(rooted)), sniff: true });
  assert.equal(a3.level, 'bad', a3.detail);
  assert.match(a3.detail, /its model part \/3D\/plate\.model unpacks to 520 MB, more than the 500 MB of text this viewer reads/);
  // A4: a zip64 archive, refused by the page in its words (must fire: "ok")
  const z64 = Buffer.from(miniZip([['3D/3dmodel.model', model3mf()]]));
  z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
  const a4 = await checkFile(`${B}z64.3mf`, { fetchFn: host(z64), sniff: true });
  assert.equal(a4.level, 'bad', a4.detail);
  assert.match(a4.detail, /the viewer cannot open it: a zip64 archive, which this viewer does not read/);
  // must accept: a small 3MF and zip
  const okZip = await checkFile(`${B}part.zip`, { fetchFn: host(miniZip([['part.obj', OBJ_TRI]])), sniff: true });
  assert.notEqual(okZip.level, 'bad', okZip.detail);
});
await test('a zip\'s entry is judged as the page opens it: a gzip in it, a 3MF in it, its method and encryption, a name twice, a missing root, a 3MF named otherwise, a format against its name (r76 A2-A6, Q2, Q3)', async () => {
  const { gzipSync } = await import('node:zlib');
  const host = (bytes) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    const a = +m[1], b = Math.min(+m[2], bytes.length - 1);
    return new Response(bytes.subarray(a, b + 1), { status: 206, headers: { 'content-length': String(b - a + 1), 'content-range': `bytes ${a}-${b}/${bytes.length}` } });
  };
  const check = async (name, zip) => checkFile(`${B}${name}`, { fetchFn: host(zip), sniff: true });
  const stl = stlOf(1);
  const rels = '<?xml version="1.0"?><Relationships><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  const big3mf = miniZip([['_rels/.rels', rels], ['3D/3dmodel.model', model3mf(), 600 * 2 ** 20, 8]]); // (deflated: its size the directory's -- r78 Q2)
  const rows = [
    // A2: a valid zipped part.stl.gz opens (must fire: "damaged"); a zipped 3MF of a 600 MB part is refused (must fire: "ok")
    ['A2 gz entry', 'part.zip', miniZip([['part.stl.gz', gzipSync(stl)]]), 'ok'],
    ['A2 3MF entry', 'part.zip', miniZip([['x.3mf', big3mf]]), 'bad'],
    // A3: a bzip2 entry (method 12) is refused (must fire: "ok")
    ['A3 method 12', 'part.zip', miniZip([['part.obj', OBJ_TRI, undefined, 12]]), 'bad'],
    // A4: a name twice in two cases: the last one, 3 GB, is what the page opens (must fire: "ok" by the first)
    ['A4 a name twice', 'part.zip', miniZip([['A.stl', stl], ['a.stl', stl, 3 * 2 ** 30, 8]]), 'bad'],
    // A5: a 3MF whose root part is missing (must fire: "ok")
    ['A5 no root', 'd.3mf', miniZip([['_rels/.rels', rels.replace('3dmodel.model', 'plate.model')], ['3D/3dmodel.model', model3mf()]]), 'bad'],
    // A6: a 3MF named download.zip, judged as one: its 600 MB part (must fire: "holds no model")
    ['A6 3MF by its directory', 'download.zip', big3mf, 'bad:model part'],
    // Q2: an encrypted entry (flag bit 0) is refused (must fire: "ok")
    ['Q2 encrypted', 'part.zip', miniZip([['part.obj', OBJ_TRI, undefined, 0, 1]]), 'bad:encrypted'],
    // Q3: a zipped R12 DWG, and a zipped GLB that is an HTML page, as alone (must fire: "ok")
    ['Q3 R12 DWG', 'plan.zip', miniZip([['plan.dwg', Buffer.from('AC1009\0\0\0\0')]]), 'bad'],
    ['Q3 GLB not one', 'part.zip', miniZip([['part.glb', '<!doctype html><title>404</title>']]), 'bad'],
  ];
  const got = [];
  for (const [what, name, zip, want] of rows) {
    const r = await check(name, zip);
    const [lv, word] = want.split(':');
    got.push([what, r.level === lv && (!word || r.detail.includes(word)) ? want : `${r.level}: ${r.detail}`]);
  }
  assert.deepEqual(got, rows.map(([what, , , want]) => [what, want]));
});
await test('a zip by the page\'s rule, a 3MF\'s rels read whole, a zip\'s companions, an empty file, an entry whose size is understated (r77 A1-A4, A9, A10)', async () => {
  const { gzipSync, deflateRawSync } = await import('node:zlib');
  const host = (bytes) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    const a = +m[1], b = Math.min(+m[2], bytes.length - 1);
    return new Response(bytes.subarray(a, b + 1), { status: 206, headers: { 'content-length': String(Math.max(0, b - a + 1)), 'content-range': `bytes ${a}-${b}/${bytes.length}` } });
  };
  const check = async (name, bytes, plain) => checkFile(`${B}${name}`, { fetchFn: plain ? async () => new Response(Buffer.from(bytes), { status: 200, headers: { 'content-length': String(bytes.length) } }) : host(Buffer.from(bytes)), sniff: true });
  const stl = (head = '') => { const b = stlOf(1); b.write(head, 0, 'latin1'); return b; };
  const relsTo = (target, pad = 0) => `<?xml version="1.0"?><Relationships><!--${' '.repeat(pad)}--><Relationship Target="${target}" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  // (an entry that starts as a gzip and inflates past the check's 64 MB, its directory claiming 1 KB)
  const under = Buffer.concat([gzipSync(stl()), Buffer.alloc(70 * 2 ** 20)]);
  const bigPk = stl('PK'); bigPk.writeUInt32LE(2_000_000, 80); // (its first record only: the directory gives its size)
  // (deflate data past 1 MB that never inflates: 0xff starts a block of the reserved type -- random bytes
  // were a valid stream about one run in 200, and the arm failed: r83 Q4)
  const bigDeflate = Buffer.alloc(1.1 * 2 ** 20, 0xff);
  const realSrc = randomBytes(1.1 * 2 ** 20), realDeflate = deflateRawSync(realSrc), realDeflateSize = realSrc.length; // (valid, past 1 MB)
  const stl2 = stlOf(2);
  const pastEnd = miniZip([['part.obj', OBJ_TRI]]); pastEnd.writeUInt32LE(10 * 2 ** 20, pastEnd.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 20); // (its csize: 10 MB)
  const localPast = miniZip([['part.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n']]); localPast.writeUInt16LE(60000, 28); // (its local extra length)
  const rows = [
    // A1: a binary STL whose free-text header starts "PK", or "PK\x03\x04" (must fire: "not a zip file", "starts as zip")
    ['A1 "PK" header', 'pk.stl', stl('PK'), 'ok'],
    ['A1 "PK\\3\\4" header', 'pk.stl', stl('PK\x03\x04'), 'ok'],
    ['A1 gzipped', 'pk.stl.gz', gzipSync(stl('PK')), 'ok'],
    // ... and a zip's part.stl holding a zip: the page reads it as an STL, damaged (must fire: "ok")
    // ... in a zip, a 95 MB one, judged by its size, not read whole as a zip (must fire: "not read here")
    ['A1 "PK" entry', 'part.zip', miniZip([['pk.stl', deflateRawSync(Buffer.concat([bigPk.subarray(0, 84), Buffer.alloc(50 * 2_000_000)])), 84 + 50 * 2_000_000, 8]]), 'warn:its reader was not run here'], // (true to its data: r79 Q2; 100 MB, past what is read here: r87 A4)
    ['A1 a zip as part.stl', 'outer.zip', miniZip([['part.stl', miniZip([['in.stl', stl()]])]]), 'bad'],
    // A2: the rels part past 64 KB naming the root (must fire: "no model part"); a bzip2 rels (must fire: "ok")
    ['A2 rels past 64 KB', 'x.3mf', miniZip([['_rels/.rels', relsTo('/3D/plate.model', 70000)], ['3D/plate.model', model3mf()]]), 'ok'],
    ['A2 rels bzip2', 'x.3mf', miniZip([['_rels/.rels', relsTo('/3D/3dmodel.model'), undefined, 12], ['3D/3dmodel.model', model3mf()]]), 'bad:_rels/.rels uses compression method 12'],
    // A3: a companion the page reads before the model and cannot (must fire: "ok"); companions over 2 GB
    ['A3 companion bzip2', 'part.zip', miniZip([['part.obj', OBJ_TRI], ['part.png', 'x', undefined, 12]]), 'bad:part.png uses compression method 12'],
    // (r78 A1: only for a reader that reads them -- an STL's, a STEP's, a DXF's are never read; must
    // fire: "bad", "companion files")
    // (r79 A8: by the reader the page meets -- a .obj that is a PLY by its magic reads none; must fire,
    // "bad · … method 12")
    ['r79 A8 a PLY named .obj', 'part.zip', miniZip([['part.obj', 'ply\nformat ascii 1.0\nelement vertex 0\nend_header\n'], ['part.png', 'x', undefined, 12]]), 'warn:opens as one'],
    ['r78 A1 an STL\'s', 'part.zip', miniZip([['part.stl', stl()], ['part.png', 'x', undefined, 12]]), 'ok'],
    ['r78 A1 a STEP\'s', 'part.zip', miniZip([['part.step', 'ISO-10303-21;\nHEADER;\n'], ['preview.png', 'x', undefined, 12]]), 'ok'],
    ['r78 A1 a DXF\'s', 'plan.zip', miniZip([['plan.dxf', '0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n'], ['a.png', bigDeflate, 1.5 * 2 ** 30, 8], ['b.png', bigDeflate, 1.5 * 2 ** 30, 8]]), 'ok'],
    // (deflated, past 1 MB each: sized by the directory, as the page holds a deflated entry -- stored ones
    // claiming 1.5 GB were 1 byte each to the page, which opened the OBJ: r78 Q2)
    // (r79 A2: each held to what the ones before leave, as the page reads it -- a.png's 1.1 MB, then
    // b.png's claim past the rest: must fire, "ok")
    ['A3 companions over 2 GB', 'part.zip', miniZip([['part.obj', OBJ_TRI], ['a.png', realDeflate, realDeflateSize, 8], ['b.png', deflateRawSync(Buffer.from('x')), 2 ** 31 - 2 ** 20, 8]]), 'bad:companion files'],
    // (r79 A3: a companion past 1 MB whose data is corrupt, read at its start -- must fire, "ok")
    ['r79 A3 a corrupt 2 MB .mtl', 'part.zip', miniZip([['part.obj', OBJ_TRI], ['part.mtl', bigDeflate, 4 * 2 ** 20, 8]]), 'bad:corrupt or truncated'],
    // (r79 A2: a small companion's claim past the file limit, as the page refuses it -- must fire, "ok")
    ['r79 A2 a .mtl claiming 3 GB', 'part.zip', miniZip([['part.obj', OBJ_TRI], ['part.mtl', deflateRawSync(Buffer.from('newmtl a\n')), 3 * 2 ** 30, 8]]), 'bad:companion files'],
    // r78 Q2: a stored entry by the bytes it holds, whatever the directory claims (must fire: "ok" of
    // the cut one, "damaged" of the whole one)
    ['r78 Q2 stored, cut', 'part.zip', miniZip([['part.stl', stl2.subarray(0, 134), 184]]), 'bad:damaged'],
    ['r78 Q2 stored, whole, claimed short', 'part.zip', miniZip([['part.stl', stl2, 134]]), 'ok'],
    // (and a small deflated one by what it inflates to, as the page has it: must fire, "companion files")
    // (its claim not what it inflates to: a damaged zip to the page since r79 Q2, and here)
    ['r78 Q2 deflated companions, claimed 1.5 GB', 'part.zip', miniZip([['part.obj', OBJ_TRI], ['a.png', deflateRawSync(Buffer.from('x')), 1.5 * 2 ** 30, 8], ['b.png', deflateRawSync(Buffer.from('x')), 1.5 * 2 ** 30, 8]]), 'bad:a damaged zip (a.png unpacks to 1 bytes'],
    ['r78 Q2 stored companions, claimed 1.5 GB', 'part.zip', miniZip([['part.obj', OBJ_TRI], ['a.png', 'x', 1.5 * 2 ** 30], ['b.png', 'x', 1.5 * 2 ** 30]]), 'ok'],
    // A4: an empty file, a 3-byte STL, a zip of an empty part (must fire: "ok")
    // (its size said: 0 is one, not "size not given")
    ['A4 empty', 'a.stl', Buffer.alloc(0), 'bad:0.00 MB · it is empty'],
    ['A4 empty, no range', 'a.stl', Buffer.alloc(0), 'bad:0.00 MB · it is empty', 'plain'],
    ['A4 empty OBJ', 'c.obj', Buffer.alloc(0), 'bad:empty'],
    ['A4 3 bytes', 'b.stl', Buffer.from('abc'), 'bad:neither a binary STL'],
    ['A4 zipped empty', 'part.zip', miniZip([['part.stl', '']]), 'bad:empty'],
    // A9: an entry inflating past the check's limit, its size understated (must fire: a throw, "over 0 GB")
    // (since r79 Q2 its understated size is itself the page's refusal, a damaged zip)
    ['A9 understated', 'part.zip', miniZip([['part.stl.gz', deflateRawSync(under), 1024, 8]]), 'bad:where its directory says 1,024'],
    // A10: a 3MF said as one (must fire: "· zip")
    // Q2: an entry whose data the directory puts past the file's end, plain and gzipped (must fire: a
    // warning blaming the server, and "ok")
    ['Q2 data past the end', 'part.zip', pastEnd, 'bad:a damaged zip (part.obj\'s data lies outside the file)'],
    ['Q2 gzipped', 'part.zip.gz', gzipSync(pastEnd), 'bad:a damaged zip (part.obj\'s data lies outside the file)'],
    // ... past it by the local header's own lengths, which the directory cannot see (must fire: the
    // short bytes in hand read as the entry, "ok")
    ['Q2 by the local header', 'part.zip.gz', gzipSync(localPast), 'bad:a damaged zip'],
    ['A10 named 3MF', 'x.3mf', miniZip([['_rels/.rels', relsTo('/3D/3dmodel.model')], ['3D/3dmodel.model', model3mf()]]), 'ok:· 3MF'],
  ];
  const got = [];
  for (const [what, name, bytes, want, plain] of rows) {
    let r;
    try { r = await check(name, bytes, plain); } catch (e) { r = { level: 'threw', detail: e.message }; }
    const [lv, word] = want.split(/:(.*)/);
    got.push([what, r.level === lv && (!word || r.detail.includes(word)) ? want : `${r.level}: ${r.detail}`]);
  }
  const wanted = rows.map(([what, , , want]) => [what, want]);
  assert.deepEqual(got, wanted, JSON.stringify(got.filter((g, i) => g[1] !== wanted[i][1]))); // (the rows that differ, in the one line the harness prints)
});
await test('a zip whose size is hidden, a corrupt entry or 3MF root, an empty gzip: as the page meets each (r78 A3-A5)', async () => {
  const { gzipSync } = await import('node:zlib');
  // (hidden: a part with no Content-Range, HEAD refused; whole: a plain answer with no length)
  const hidden = (b) => async (u, o = {}) => (o.method === 'HEAD' ? new Response(null, { status: 405 })
    : o.headers && o.headers.Range ? new Response(b.subarray(0, 65536), { status: 206 }) : new Response(b, { status: 200 }));
  const whole = (b) => async () => new Response(b, { status: 200 });
  const ranged = (b) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
    const a = +m[1], e = Math.min(+m[2], b.length - 1);
    return new Response(b.subarray(a, e + 1), { status: 206, headers: { 'content-length': String(Math.max(0, e - a + 1)), 'content-range': `bytes ${a}-${e}/${b.length}` } });
  };
  const bz = miniZip([['part.stl', 'solid x\n', undefined, 12]]);
  // (more than one answer's 64 KB, so not in hand whole: r79 A4 takes a short one as the file)
  const bzBig = miniZip([['pad.txt', Buffer.alloc(70000, 0x20)], ['part.stl', 'solid x\n', undefined, 12]]);
  const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const rels = '<?xml version="1.0"?><Relationships><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  const rows = [
    // A3: its size hidden -- said, or judged from the whole body in hand (must fire: "ok · size not given · zip")
    ['A3 size hidden', 'part.zip', bzBig, hidden, 'warn:its size was not given'],
    // (r79 A4: a short part, the whole file, gives its size and is judged: must fire, "size not given")
    ['r79 A4 a short part, size hidden', 'part.zip', bz, hidden, 'bad:0.00 MB · zip · zip entry part.stl uses compression method 12'],
    ['r79 A4 a 3-byte STL, size hidden', 'b.stl', Buffer.from('abc'), hidden, 'bad:neither a binary STL'],
    ['r79 A4 a cut STL, no length', 'c.stl', (() => { const b = Buffer.alloc(134); b.writeUInt32LE(2, 80); return b; })(), whole, 'bad:damaged'],
    ['A3 size hidden, whole in hand', 'part.zip', bz, whole, 'bad:compression method 12'],
    // A4: a corrupt deflate entry, a corrupt 3MF root (must fire: "ok · zip", "ok · 3MF")
    ['A4 corrupt entry', 'part.zip', miniZip([['part.stl', garbage, 4000, 8]]), ranged, 'bad:the deflated data is corrupt or truncated'],
    ['A4 corrupt 3MF root', 'x.3mf', miniZip([['_rels/.rels', rels], ['3D/3dmodel.model', garbage, 4000, 8]]), ranged, 'bad:the deflated data is corrupt or truncated'],
    // A5: an empty gzip, as a plain or zipped empty file is said (must fire: "its gzip could not be read here")
    ['A5 empty gzip', 'a.stl.gz', gzipSync(Buffer.alloc(0)), ranged, 'bad:it is empty'],
  ];
  const got = [];
  for (const [what, name, bytes, host, want] of rows) {
    let r;
    try { r = await checkFile(`${B}${name}`, { fetchFn: host(Buffer.from(bytes)), sniff: true }); } catch (e) { r = { level: 'threw', detail: e.message }; }
    const [lv, word] = want.split(/:(.*)/);
    got.push([what, r.level === lv && (!word || r.detail.includes(word)) ? want : `${r.level}: ${r.detail}`]);
  }
  const wanted = rows.map(([what, , , , want]) => [what, want]);
  assert.deepEqual(got, wanted, JSON.stringify(got.filter((g, i) => g[1] !== wanted[i][1]))); // (the rows that differ, in the one line the harness prints)
});
await test('the reader the page meets, an entry\'s data counted and its checksum held, a size not given, a glTF\'s buffers (r80 A2, A6, Q1-Q4)', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const ranged = (b) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
    const a = +m[1], e = Math.min(+m[2], b.length - 1);
    return new Response(b.subarray(a, e + 1), { status: 206, headers: { 'content-length': String(Math.max(0, e - a + 1)), 'content-range': `bytes ${a}-${e}/${b.length}` } });
  };
  const chunked = (b) => async () => new Response(b, { status: 200 }); // (no length, no range)
  const dxf = '0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n';
  const rnd = randomBytes(1.5 * 2 ** 20), rndData = deflateRawSync(rnd);
  const stl = Buffer.alloc(134); stl.writeUInt32LE(1, 80);
  const flipped = miniZip([['part.stl', stl]]); flipped[30 + 'part.stl'.length + 90] ^= 1;
  const gltf = (uri) => gltfTri(uri); // (a triangle: one with none the page refuses -- r86 A1)
  const rows = [
    // A6: a DXF named part.stl, read by the page as an STL and refused (must fire: a warning)
    ['A6 a DXF named .stl', 'part.stl', Buffer.from(dxf), ranged, 'bad:neither a binary STL'],
    ['A6 a zipped one', 'part.zip', miniZip([['part.stl', dxf]]), ranged, 'bad:neither a binary STL'],
    // A2: photo.png.gz is no companion -- no reader unpacks one (must fire: "bad · … method 12")
    ['A2 a .png.gz beside an OBJ', 'part.zip', miniZip([['part.obj', OBJ_TRI], ['photo.png.gz', 'x', undefined, 12]]), ranged, 'ok'],
    // Q1: 1.5 MB of data, 100 bytes past its directory's size, counted as the page inflates it (must fire: "ok")
    ['Q1 past 1 MB, size wrong', 'part.zip', miniZip([['part.stl', rndData, rnd.length - 100, 8]]), ranged, 'bad:a damaged zip'],
    // Q2: no size given, more than one read's 64 KB (must fire: "ok · size not given")
    // (the body arriving whole, counted as the page receives it: its size known, and the page's own
    // refusal of a binary STL padded past its count -- r85 Q1)
    ['Q2 no size, long', 'big.stl', Buffer.concat([stl, Buffer.alloc(100000)]), chunked, 'bad:so it should be 134 bytes, but it is 100,134 bytes'],
    // Q3: a .gltf by URL whose buffer is a file of its own; zipped without it; zipped with it (must fire: "ok", "ok")
    ['Q3 a .gltf by URL', 'tri.gltf', Buffer.from(gltf('tri.bin')), ranged, 'bad:tri.gltf needs tri.bin'],
    ['Q3 zipped without its .bin', 'g.zip', miniZip([['tri.gltf', gltf('tri.bin')]]), ranged, 'bad:tri.gltf needs tri.bin'],
    ['Q3 zipped with it', 'g.zip', miniZip([['tri.gltf', gltf('tri.bin')], ['tri.bin', TRI_BIN]]), ranged, 'ok'],
    ['Q3 a data: URI', 'tri.gltf', Buffer.from(gltf(`data:application/octet-stream;base64,${TRI_BIN.toString('base64')}`)), ranged, 'ok'],
    // Q4: a changed byte in a stored entry, refused by its CRC-32 (must fire: "ok")
    ['Q4 a changed byte', 'part.zip', flipped, ranged, 'bad:does not match its checksum'],
  ];
  const got = [];
  for (const [what, name, bytes, host, want] of rows) {
    let r;
    try { r = await checkFile(`${B}${name}`, { fetchFn: host(Buffer.from(bytes)), sniff: true }); } catch (e) { r = { level: 'threw', detail: e.message }; }
    const [lv, word] = want.split(/:(.*)/);
    got.push([what, r.level === lv && (!word || r.detail.includes(word)) ? want : `${r.level}: ${r.detail}`]);
  }
  const wanted = rows.map(([what, , , , want]) => [what, want]);
  assert.deepEqual(got, wanted, JSON.stringify(got.filter((g, i) => g[1] !== wanted[i][1])));
});
await test('a 3MF\'s parts and a glTF\'s JSON read as the page reads them (r81 A1, A2, A5-A7)', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const ranged = (b) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
    const a = +m[1], e = Math.min(+m[2], b.length - 1);
    return new Response(b.subarray(a, e + 1), { status: 206, headers: { 'content-length': String(Math.max(0, e - a + 1)), 'content-range': `bytes ${a}-${e}/${b.length}` } });
  };
  const rels = (target) => `<?xml version="1.0"?><Relationships><Relationship Target="${target}" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  // (a byte changed in an entry's stored data, its CRC-32 left as it was)
  const flip = (z, name, at = 0) => { const b = Buffer.from(z); b[b.indexOf(Buffer.from(name)) + name.length + at] ^= 1; return b; };
  const relsBad = flip(miniZip([['_rels/.rels', rels('/3D/3dmodel.model')], ['3D/3dmodel.model', model3mf()]]), '_rels/.rels', 40);
  const partBad = flip(miniZip([['_rels/.rels', rels('/3D/3dmodel.model')], ['3D/3dmodel.model', model3mf()], ['3D/Objects/o1.model', '<model><resources/></model>']]), '3D/Objects/o1.model', 3);
  const gltf = (o) => JSON.stringify({ ...JSON.parse(gltfTri()), ...o }); // (a triangle, as the page opens: r86 A1)
  const glb = (json) => { const j = Buffer.from(json); const pad = (4 - (j.length % 4)) % 4; const jj = Buffer.concat([j, Buffer.alloc(pad, 0x20)]); const h = Buffer.alloc(20); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(20 + jj.length, 8); h.writeUInt32LE(jj.length, 12); h.write('JSON', 16); return Buffer.concat([h, jj]); };
  const draco = { extensionsRequired: ['KHR_draco_mesh_compression'], extensionsUsed: ['KHR_draco_mesh_compression'] };
  const longJson = gltf({ buffers: [{ uri: 'tri.bin', byteLength: 36 }], extras: { pad: 'x'.repeat(100000) } });
  const rows = [
    // A1: a rels part whose data is not its CRC-32 (must fire: "ok · 3MF")
    ['A1 rels, CRC wrong', 'x.3mf', relsBad, 'bad:a damaged zip (_rels/.rels\'s data does not match its checksum)'],
    // A2: another model part damaged -- refused if the root uses it (must fire: "ok · 3MF")
    ['A2 another part damaged', 'x.3mf', partBad, 'warn:the viewer refuses the model if it uses 3D/Objects/o1.model'],
    // A5: a Draco GLB and glTF, by URL and zipped (must fire: "ok")
    ['A5 a Draco GLB', 'd.glb', glb(gltf(draco)), 'bad:which this viewer does not decode'],
    ['A5 a zipped Draco glTF', 'd.zip', miniZip([['d.gltf', gltf(draco)]]), 'bad:which this viewer does not decode'],
    // A6: a .gltf of more than 64 KB of JSON with an external buffer (must fire: "ok")
    ['A6 long JSON by URL', 'tri.gltf', Buffer.from(longJson), 'bad:tri.gltf needs tri.bin'],
    ['A6 long JSON zipped', 'g.zip', miniZip([['tri.gltf', deflateRawSync(Buffer.from(longJson)), longJson.length, 8]]), 'bad:tri.gltf needs tri.bin'],
    // A7: a zipped chair.gltf.gz without its chair.bin (must fire: "ok")
    ['A7 a gzipped glTF in a zip', 'g.zip', miniZip([['chair.gltf.gz', gzipSync(gltf({ buffers: [{ uri: 'chair.bin', byteLength: 36 }] }))]]), 'bad:chair.gltf needs chair.bin'],
    // Q3: a 3MF whose root holds more data than is counted here, said (must fire: "ok")
    ['Q3 a 70 MB stored root', 'x.3mf', miniZip([['_rels/.rels', rels('/3D/3dmodel.model')], ['3D/3dmodel.model', Buffer.alloc(70 * 2 ** 20, 0x20)]]), 'warn:were not checked here'],
    // Q6: a deflated entry that inflates cleanly to bytes its CRC-32 is not (must fire: "ok")
    ['Q6 deflated, CRC wrong', 'p.zip', miniZip([['part.obj', deflateRawSync(Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')), 32, 8, 0, 12345]]), 'bad:does not match its checksum'],
    // Q8: a GLB with an external buffer by URL; a %-escaped uri beside its file; a companion in another case
    // (must fire: "ok"; "needs my%20part.bin"; "needs tri.bin")
    ['Q8 a GLB by URL', 'tri.glb', glb(gltf({ buffers: [{ uri: 'tri.bin', byteLength: 36 }] })), 'bad:tri.glb needs tri.bin'],
    ['Q8 a %-escaped uri', 'g.zip', miniZip([['tri.gltf', gltf({ buffers: [{ uri: 'my%20part.bin', byteLength: 36 }] })], ['my part.bin', TRI_BIN]]), 'ok'],
    ['Q8 a companion in another case', 'g.zip', miniZip([['tri.gltf', gltf({ buffers: [{ uri: 'tri.bin', byteLength: 36 }] })], ['Tri.BIN', TRI_BIN]]), 'ok'],
  ];
  const got = [];
  for (const [what, name, bytes, want] of rows) {
    let r;
    try { r = await checkFile(`${B}${name}`, { fetchFn: ranged(Buffer.from(bytes)), sniff: true }); } catch (e) { r = { level: 'threw', detail: e.message }; }
    const [lv, word] = want.split(/:(.*)/);
    got.push([what, r.level === lv && (!word || r.detail.includes(word)) ? want : `${r.level}: ${r.detail}`]);
  }
  const wanted = rows.map(([what, , , want]) => [what, want]);
  assert.deepEqual(got, wanted, JSON.stringify(got.filter((g, i) => g[1] !== wanted[i][1])));
});
await test('a glTF and GLB by their whole JSON and chunks wherever they are, a .cadmesh by its header, a part answer not the file (r82 A1-A5, Q3, Q4)', async () => {
  const { encodeCadmesh } = await import('../js/cadmesh.js');
  // (capped: a host whose parts are at most `cap` bytes, its Content-Range naming the whole)
  const ranged = (b, cap = Infinity) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
    const a = +m[1], e = Math.min(+m[2], b.length - 1, a + cap - 1);
    return new Response(b.subarray(a, e + 1), { status: 206, headers: { 'content-length': String(Math.max(0, e - a + 1)), 'content-range': `bytes ${a}-${e}/${b.length}` } });
  };
  const gltf = (o) => JSON.stringify({ ...JSON.parse(gltfTri()), ...o }); // (a triangle, as the page opens: r86 A1)
  const chunk = (type, data) => { const d = Buffer.from(data); const pad = (4 - (d.length % 4)) % 4; const h = Buffer.alloc(8); h.writeUInt32LE(d.length + pad, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, d, Buffer.alloc(pad, type === 'JSON' ? 0x20 : 0)]); };
  const glbOf = (...chunks) => { const body = Buffer.concat(chunks); const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + body.length, 8); return Buffer.concat([h, body]); };
  const long = { extras: { pad: 'x'.repeat(100000) } };
  const needsBin = gltf({ buffers: [{ uri: 'tri.bin', byteLength: 36 }], ...long });
  const draco = gltf({ extensionsRequired: ['KHR_draco_mesh_compression'], ...long });
  const quad = { name: 'plate', color: null, positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0), normals: null, colors: null, indices: Uint32Array.of(0, 1, 2) };
  const cm = Buffer.from(encodeCadmesh({ meshes: [quad], root: { name: 'asm', meshes: [0], children: [] } }));
  const rels = `<?xml version="1.0"?><Relationships><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const bigPart = Buffer.alloc(70 * 2 ** 20, 0x20);
  const rows = [
    // A1: a .gltf.gz and a .glb.gz past 64 KB of JSON by URL (must fire: "ok")
    ['A1 a long .gltf.gz', 'tri.gltf.gz', gzipSync(needsBin), 'bad:tri.gltf needs tri.bin'],
    ['A1 a long Draco .glb.gz', 'd.glb.gz', gzipSync(glbOf(chunk('JSON', draco))), 'bad:which this viewer does not decode'],
    // A2: a 70 MB GLB, its JSON read by its own length; a 70 MB .gltf said not checked (must fire: "ok")
    ['A2 a 70 MB GLB', 'big.glb', glbOf(chunk('JSON', draco), chunk('BIN\0', Buffer.alloc(70 * 2 ** 20))), 'bad:which this viewer does not decode'],
    ['A2 a 70 MB .gltf', 'big.gltf', Buffer.from(gltf({ extras: { pad: 'x'.repeat(70 * 2 ** 20) } })), 'warn:its extensions and buffers were not checked here'],
    // A3: a GLB and a .cadmesh cut short (must fire: "ok")
    ['A3 a cut GLB', 'cut.glb', glbOf(chunk('JSON', gltf({})), chunk('BIN\0', Buffer.alloc(1000))).subarray(0, 600), 'bad:a chunk runs past the end of the file'],
    ['A3 a cut .cadmesh', 'cut.cadmesh', cm.subarray(0, cm.length - 8), 'bad:out of range (truncated file?)'],
    ['A3 a whole .cadmesh (control)', 'whole.cadmesh', cm, 'ok'],
    // A4: a GLB whose BIN chunk comes first (must fire: "ok")
    ['A4 BIN first', 'd.glb', glbOf(chunk('BIN\0', Buffer.alloc(16)), chunk('JSON', draco)), 'bad:which this viewer does not decode'],
    // A5: a 3MF whose other part holds more than 64 MB of data, said (must fire: "ok")
    ['A5 a 70 MB object part', 'x.3mf', miniZip([['_rels/.rels', rels], ['3D/3dmodel.model', model3mf()], ['3D/Objects/object_1.model', bigPart]]), 'warn:its model part 3D/Objects/object_1.model holds more than'],
    // Q4: a .gltf whose JSON does not parse (must fire: "ok")
    ['Q4 a cut .gltf', 'cut.gltf', Buffer.from(gltf({}).slice(0, -2)), 'bad:is damaged: its JSON does not parse'],
  ];
  const got = [];
  for (const [what, name, bytes, want] of rows) {
    let r;
    try { r = await checkFile(`${B}${name}`, { fetchFn: ranged(Buffer.from(bytes)), sniff: true }); } catch (e) { r = { level: 'threw', detail: e.message }; }
    const [lv, word] = want.split(/:(.*)/);
    got.push([what, r.level === lv && (!word || r.detail.includes(word)) ? want : `${r.level}: ${r.detail}`]);
  }
  // Q3: a host capping its parts at 32 KB, its Content-Range naming the 200 KB zip: its first part is
  // no whole file (must fire: "bad · not a zip file")
  const z = miniZip(Array.from({ length: 2000 }, (_, i) => [`p${i}.stl`, 'x'.repeat(40)]));
  const capped = await checkFile(`${B}many.zip`, { fetchFn: ranged(z, 32768), sniff: true });
  got.push(['Q3 parts capped at 32 KB', capped.level === 'warn' && /sent less than it was asked/.test(capped.detail) ? 'ok' : `${capped.level}: ${capped.detail}`]);
  const wanted = [...rows.map(([what, , , want]) => [what, want]), ['Q3 parts capped at 32 KB', 'ok']];
  assert.deepEqual(got, wanted, JSON.stringify(got.filter((g, i) => g[1] !== wanted[i][1])));
});
await test('a long .cadmesh header read from every host, a size sent encoded, a GLB\'s chunks all and its buffer 0, a JSON past the text limit (r83 A1-A5, Q1, Q3)', async () => {
  // hosts: ranges honoured; capped at 32 KB a part; ignored (the whole every time); one sending a file
  // stored gzipped, Content-Encoding: gzip, its length the gzip's, the browser handing on the file
  const ranged = (b, cap = Infinity) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
    const a = +m[1], e = Math.min(+m[2], b.length - 1, a + cap - 1);
    return new Response(b.subarray(a, e + 1), { status: 206, headers: { 'content-length': String(Math.max(0, e - a + 1)), 'content-range': `bytes ${a}-${e}/${b.length}` } });
  };
  const ignoring = (b) => async () => new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
  const encoded = (b) => async () => new Response(b, { status: 200, headers: { 'content-length': String(gzipSync(b).length), 'content-encoding': 'gzip' } });
  // (a model of 3,000 named bodies: its header past 64 KB, as every model at hand has -- the shipped
  // all-h3-cc.cadmesh's is 358 KB -- built here, as the public tree has no models/)
  const { encodeCadmesh } = await import('../js/cadmesh.js');
  const quad = { name: 'plate', color: null, positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0), normals: null, colors: null, indices: Uint32Array.of(0, 1, 2) };
  const bodies = Array.from({ length: 3000 }, (_, i) => ({ ...quad, name: `body_${i}_${'x'.repeat(40)}` }));
  const model = Buffer.from(encodeCadmesh({ meshes: bodies, root: { name: 'asm', meshes: bodies.map((_, i) => i), children: [] } }));
  assert.ok(model.readUInt32LE(8) > 65536, 'a header past 64 KB');
  const cut = model.subarray(0, model.length - 8); // (past its header, a section cut: read only with the whole header)
  const rack = model; // (a valid model, sent encoded below)
  // (a .cadmesh's header rewritten: its sections as given, its data kept)
  const cm = Buffer.from(encodeCadmesh({ meshes: [quad], root: { name: 'asm', meshes: [0], children: [] } }));
  const withSections = (edit) => {
    const jlen = cm.readUInt32LE(8), header = JSON.parse(cm.subarray(12, 12 + jlen).toString());
    const data = cm.subarray((12 + jlen + 7) & ~7);
    edit(header.sections);
    let j = Buffer.from(JSON.stringify(header)); const pad = ((12 + j.length + 7) & ~7) - 12 - j.length; j = Buffer.concat([j, Buffer.alloc(pad, 0x20)]);
    const h = Buffer.alloc(12); cm.copy(h, 0, 0, 8); h.writeUInt32LE(j.length, 8);
    return Buffer.concat([h, j, data]);
  };
  const gltf = (o) => JSON.stringify({ ...JSON.parse(gltfTri()), ...o }); // (a triangle, as the page opens: r86 A1)
  const chunk = (type, data) => { const d = Buffer.from(data); const p = (4 - (d.length % 4)) % 4; const h = Buffer.alloc(8); h.writeUInt32LE(d.length + p, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, d, Buffer.alloc(p, type === 'JSON' ? 0x20 : 0)]); };
  const glbOf = (...cs) => { const body = Buffer.concat(cs); const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + body.length, 8); return Buffer.concat([h, body]); };
  const draco = gltf({ extensionsRequired: ['KHR_draco_mesh_compression'] });
  // (a GLB whose JSON chunk claims 501 MB, served by range from what it says: only its header is read)
  const huge = 501 * 2 ** 20, hugeLen = 20 + huge;
  const hugeHead = Buffer.alloc(20); hugeHead.write('glTF', 0); hugeHead.writeUInt32LE(2, 4); hugeHead.writeUInt32LE(hugeLen, 8); hugeHead.writeUInt32LE(huge, 12); hugeHead.write('JSON', 16, 'latin1');
  const virtual = async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(null, { status: 416 });
    const a = +m[1], e = Math.min(+m[2], hugeLen - 1), out = Buffer.alloc(e - a + 1, 0x20);
    hugeHead.subarray(a, Math.min(20, e + 1)).copy(out, 0);
    return new Response(out, { status: 206, headers: { 'content-length': String(out.length), 'content-range': `bytes ${a}-${e}/${hugeLen}` } });
  };
  const rows = [
    // A2, Q3: the shipped all-h3-cc.cadmesh cut in half, from each host and zipped (must fire: "ok")
    ['A2 cut, ranges honoured', 'cut.cadmesh', ranged(cut), 'bad:out of range (truncated file?)'],
    ['A2 cut, parts capped at 32 KB', 'cut.cadmesh', ranged(cut, 32768), 'bad:out of range (truncated file?)'],
    ['A2 cut, ranges ignored', 'cut.cadmesh', ignoring(cut), 'bad:out of range (truncated file?)'],
    ['A2 cut, zipped', 'cut.zip', ranged(miniZip([['cut.cadmesh', cut]])), 'bad:out of range (truncated file?)'],
    ['A2 whole (control)', 'all.cadmesh', ranged(model), 'ok'],
    // A1: a valid model sent encoded, its length the gzip's (must fire: "section position out of range")
    // (never "bad" of a file the page opens: its body counted as it arrives -- r85 Q1)
    ['A1 a valid model sent encoded', 'rack.cadmesh', encoded(rack), 'ok'],
    // A3: a GLB's JSON past the text limit, refused in the reader's words (must fire: "ok")
    ['A3 a 501 MB JSON chunk', 'huge.glb', virtual, 'bad:of text, more than the 500 MB of text this viewer reads'],
    // A4: the decoder's own section walk -- a section it never reads past the end opens; no index is refused
    ['A4 an unread section past the end', 'x.cadmesh', ranged(withSections((s) => { s.unread = { offset: 1e6, byteLength: 8 }; })), 'ok'],
    ['A4 no index section', 'x.cadmesh', ranged(withSections((s) => { delete s.index; })), 'bad:cadmesh: section index'], // (validateHeader's words first, as the decoder meets it: r84 A2)
    // A5: a Draco JSON as the 65th chunk, the file in hand (must fire: "ok")
    ['A5 the 65th chunk', 'many.glb', ranged(glbOf(...Array.from({ length: 64 }, () => chunk('BIN\0', Buffer.alloc(4))), chunk('JSON', draco))), 'bad:which this viewer does not decode'],
    // Q1: a GLB cut after its JSON chunk, buffer 0 with no uri and no BIN chunk (must fire: "ok")
    ['Q1 cut after the JSON', 'b.glb', ranged(glbOf(chunk('JSON', gltf({ buffers: [{ byteLength: 36 }] })))), 'bad:buffer 0 has no data'],
  ];
  const got = [];
  for (const [what, name, host, want] of rows) {
    let r;
    try { r = await checkFile(`${B}${name}`, { fetchFn: host, sniff: true }); } catch (e) { r = { level: 'threw', detail: e.message }; }
    const [lv, word] = want.split(/:(.*)/);
    got.push([what, r.level === lv && (!word || r.detail.includes(word)) ? want : `${r.level}: ${r.detail}`]);
  }
  const wanted = rows.map(([what, , , want]) => [what, want]);
  assert.deepEqual(got, wanted, JSON.stringify(got.filter((g, i) => g[1] !== wanted[i][1])));
});
await test('a size another site hides the encoding of, a .cadmesh header the decoder refuses, a glTF\'s shape and every JSON chunk, a header in the start in hand, a cut gzip\'s trailer (r84 A1-A4, A8, Q2-Q4, Q6, Q7)', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const { encodeCadmesh } = await import('../js/cadmesh.js');
  let served = 0;
  const ranged = (b, cap = Infinity) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) { served += b.length; return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } }); }
    const a = +m[1], e = Math.min(+m[2], b.length - 1, a + cap - 1);
    served += Math.max(0, e - a + 1);
    return new Response(b.subarray(a, e + 1), { status: 206, headers: { 'content-length': String(Math.max(0, e - a + 1)), 'content-range': `bytes ${a}-${e}/${b.length}` } });
  };
  // A1, Q3: another site's file stored gzipped, as a browser hands it to a page on another origin --
  // Content-Encoding unreadable, the length the gzip's, the body the file; a ranged read fails there
  // (Chromium: the plain retry is the path taken) or answers whole
  const hidden = (b, rangeFails = false) => async (u, o = {}) => {
    if (rangeFails && o.headers && o.headers.Range) throw new TypeError('Failed to fetch');
    return new Response(b, { status: 200, headers: { 'content-length': String(gzipSync(b).length) } });
  };
  const tri = { name: 'plate', color: null, positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0), normals: null, colors: null, indices: Uint32Array.of(0, 1, 2) };
  const bodies = Array.from({ length: 3000 }, (_, i) => ({ ...tri, name: `body_${i}_${'x'.repeat(40)}` }));
  const rack = Buffer.from(encodeCadmesh({ meshes: bodies, root: { name: 'asm', meshes: bodies.map((_, i) => i), children: [] } }));
  const rackCut = rack.subarray(0, rack.length - 8);
  // A2, Q1: whole files whose header the decoder refuses (rewritten at its own length: the data stays)
  const good = Buffer.from(encodeCadmesh({ meshes: [tri], root: { name: 'a', meshes: [0], children: [] } }));
  const jlen = good.readUInt32LE(8), hdr = JSON.parse(good.subarray(12, 12 + jlen).toString());
  const withHdr = (edit) => { const h = structuredClone(hdr); edit(h); const out = Buffer.from(good); out.write(JSON.stringify(h).padEnd(jlen, ' '), 12); return out; };
  const ver2 = Buffer.from(good); ver2.writeUInt32LE(2, 4);
  // A3, A4, Q2: glTF shapes the reader refuses before its buffers; a Draco GLB with the file's own
  // keys "more" and "bad"; two JSON chunks, the first broken
  const gltf = (o) => JSON.stringify({ ...JSON.parse(gltfTri()), ...o }); // (a triangle, as the page opens: r86 A1)
  const chunk = (type, data) => { const d = Buffer.from(data); const p = (4 - (d.length % 4)) % 4; const h = Buffer.alloc(8); h.writeUInt32LE(d.length + p, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, d, Buffer.alloc(p, type === 'JSON' ? 0x20 : 0)]); };
  const glbOf = (...cs) => { const body = Buffer.concat(cs); const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + body.length, 8); return Buffer.concat([h, body]); };
  // Q4: a large gzip -- past the size fetched whole -- of a model whose header is past 64 KB, cut short
  // inside: its header read from its first 4 MB unpacked
  const noise = new Float32Array(9 * 160000); for (let i = 0; i < noise.length; i++) noise[i] = Math.random();
  const bigBody = { ...tri, name: 'noise', positions: noise, indices: Uint32Array.from({ length: 3 * 160000 }, (_, i) => i) };
  const bigModel = Buffer.from(encodeCadmesh({ meshes: [...bodies, bigBody], root: { name: 'asm', meshes: [...bodies.keys(), 3000], children: [] } }));
  const bigGz = gzipSync(bigModel.subarray(0, bigModel.length - 8));
  assert.ok(bigGz.length * 1032 >= 2 ** 32 && bigModel.readUInt32LE(8) > 65536, 'past the whole fetch, a header past 64 KB');
  // Q6: a header in the first 32 KB of a model of megabytes, from a host capping each part at 32 KB
  const roomy = cmOf(60000);
  // Q7: a gzip of megabytes cut short, its last four bytes deflate data read as a size past the limit
  const gzNoise = gzipSync(randomBytes(5 * 2 ** 20));
  let end = gzNoise.length - 4096;
  while (gzNoise.readUInt32LE(end - 4) <= 2 ** 31) end--;
  const gzCut = gzNoise.subarray(0, end);
  // A8: a zipped .cadmesh deflated and saying it unpacks past 64 MB: judged by the start in hand
  const ver2big = Buffer.concat([ver2, Buffer.alloc(65 * 2 ** 20)]);
  const ver2zip = miniZip([['x.cadmesh', deflateRawSync(ver2big), ver2big.length, 8]]);
  const rows = [
    ['A1 a valid model, encoding hidden', 'rack.cadmesh', hidden(rack), 'ok'],
    // (the plain retry's body counted as it arrives: "ok", where r84 said "size not given" -- r85 Q1)
    ['Q3 a valid model, encoding hidden, a range fails', 'rack.cadmesh', hidden(rack, true), 'ok'],
    ['A1 a cut model, encoding hidden (control)', 'cut.cadmesh', hidden(rackCut), 'bad:out of range'],
    ['A2 version 2', 'x.cadmesh', ranged(ver2), 'bad:unsupported version 2'],
    ['A2 a mesh range past the vertex data', 'x.cadmesh', ranged(withHdr((h) => { h.meshes[0].vtxCount = 9; })), 'bad:range is outside'],
    ['A2 a tree naming mesh 5', 'x.cadmesh', ranged(withHdr((h) => { h.root = { name: 'a', meshes: [5], children: [] }; })), 'bad:names mesh 5 of 1'],
    ['A2 whole (control)', 'x.cadmesh', ranged(good), 'ok'],
    ['A3 the JSON null', 'm.gltf', ranged(Buffer.from('null')), 'bad:holds no glTF JSON'],
    ['A3 the JSON a list', 'm.gltf', ranged(Buffer.from('[]')), 'bad:its JSON is not an object'],
    ['A3 buffers not a list', 'm.gltf', ranged(Buffer.from(gltf({ buffers: 5 }))), 'bad:"buffers" is not a list'],
    ['A3 buffer 0 not an object', 'm.gltf', ranged(Buffer.from(gltf({ buffers: [5] }))), 'bad:buffer 0 is not an object'],
    ['A3 buffer 0 uri not text', 'm.gltf', ranged(Buffer.from(gltf({ buffers: [{ uri: 7, byteLength: 4 }] }))), 'bad:uri is not text'],
    ['A3 extensionsRequired not a list', 'm.gltf', ranged(Buffer.from(gltf({ extensionsRequired: 'x' }))), 'bad:"extensionsRequired" is not a list'],
    ['A4 Draco, and a key "more"', 'm.gltf', ranged(Buffer.from(gltf({ more: true, extensionsRequired: ['KHR_draco_mesh_compression'] }))), 'bad:which this viewer does not decode'],
    ['A4 Draco, and a key "bad"', 'm.gltf', ranged(Buffer.from(gltf({ bad: 1, extensionsRequired: ['KHR_draco_mesh_compression'] }))), 'bad:which this viewer does not decode'],
    ['Q2 two JSON chunks, the first broken', 'x.glb', ranged(glbOf(chunk('JSON', '{,'), chunk('JSON', gltf({})))), 'bad:does not parse'],
    ['Q2 two JSON chunks, both whole (control)', 'x.glb', ranged(glbOf(chunk('JSON', gltf({})), chunk('JSON', gltf({})))), 'ok'],
    ['Q4 a zipped model deflated, cut', 'cut.zip', ranged(miniZip([['cut.cadmesh', deflateRawSync(rackCut), rackCut.length, 8]])), 'bad:out of range'],
    ['Q4 a zipped model deflated, whole (control)', 'all.zip', ranged(miniZip([['all.cadmesh', deflateRawSync(rack), rack.length, 8]])), 'ok'],
    ['Q4 a large gzip, its header past 64 KB, cut', 'big.cadmesh.gz', ranged(bigGz), 'bad:out of range'],
    ['A8 a zipped model past 64 MB, its start refused', 'v.zip', ranged(ver2zip), 'bad:unsupported version 2'],
    ['Q7 a gzip cut short', 'x.stl.gz', ranged(gzCut), 'bad:or it is cut short'],
  ];
  const got = [];
  for (const [what, name, host, want] of rows) {
    let r;
    try { r = await checkFile(`${B}${name}`, { fetchFn: host, sniff: true }); } catch (e) { r = { level: 'threw', detail: e.message }; }
    const [lv, word] = want.split(/:(.*)/);
    got.push([what, r.level === lv && (!word || r.detail.includes(word)) ? want : `${r.level}: ${r.detail}`]);
  }
  // Q6: what a header in the start in hand costs, from a host capping each part at 32 KB (must fire:
  // the whole file fetched)
  served = 0;
  const q6 = await checkFile(`${B}roomy.cadmesh`, { fetchFn: ranged(roomy, 32768), sniff: true });
  got.push(['Q6 a header in the start, parts capped', q6.level === 'ok' && served < 4 * 65536 ? 'ok, a few parts' : `${q6.level}: ${q6.detail} (${served} bytes for ${roomy.length})`]);
  const wanted = [...rows.map(([what, , , want]) => [what, want]), ['Q6 a header in the start, parts capped', 'ok, a few parts']];
  assert.deepEqual(got, wanted, JSON.stringify(got.filter((g, i) => g[1] !== wanted[i][1])));
});
await test('a length another site\'s page cannot tell from an encoding\'s: the body counted as it arrives, either way, to 16 MB and said past it (r85 Q1, Q2, r86 Q2)', async () => {
  // (a host sending a file stored gzipped as another site's page meets it: the length the gzip's,
  // Content-Encoding unread, the range ignored, the body the file -- streamed, a part at a time,
  // as no test may hold 545 MB; sent: the bytes it handed over)
  let sent = 0;
  const streamed = (headBytes, partBytes, parts, length) => async () => {
    let i = -1;
    const body = new ReadableStream({ pull(c) { i += 1; if (i === 0) { sent += headBytes.length; c.enqueue(headBytes); } else if (i <= parts) { sent += partBytes.length; c.enqueue(partBytes); } else c.close(); } });
    return new Response(body, { status: 200, headers: { 'content-length': String(length) } });
  };
  const PAST = 'warn:its length may be a stored encoding\'s'; // (past what is counted: a warning, never "ok" or "bad")
  const stlHead = (n) => { const h = Buffer.alloc(84); h.writeUInt32LE(n, 80); return h; };
  const MB = 2 ** 20;
  const rec = stlOf(20000).subarray(84); // (20,000 records a part, 1,000,000 B, each a triangle with an area)
  const facet = Buffer.from(' facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\n'.repeat(Math.ceil(MB / 100)));
  const rows = [
    // Q1 (a): 80,000,084 B of binary STL, its gzip given as 66 MB -- past r84's 64 MB re-check (must fire: "bad · damaged")
    ['Q1 a valid STL, its gzip past 64 MB', 'a.stl', streamed(stlHead(1600000), rec, 80, 66 * MB), PAST],
    // Q1 (b): an STL that does not compress, its gzip longer than the file (must fire: "bad · damaged")
    ['Q1 a valid STL, its gzip longer than it', 'b.stl', streamed(stlHead(200000), rec, 10, 10003120), 'ok'],
    // Q2: 545 MB of ASCII STL, its gzip given as 1.8 MB (must fire: "ok · 1.8 MB")
    ['Q2 a text STL past 500 MB, its gzip 1.8 MB', 'c.stl', streamed(Buffer.from('solid c\n'), facet, 545, 1851095), PAST],
    // r86 Q2: a valid 50 MB STL, its length its own (must fire below: 50 MB moved to say "ok")
    ['r86 Q2 a 50 MB STL, its length true', 'd.stl', streamed(stlHead(1000000), rec, 50, 50000084), PAST],
  ];
  const got = [];
  for (const [what, name, host, want] of rows) {
    let r;
    sent = 0;
    try { r = await checkFile(`${B}${name}`, { fetchFn: host, sniff: true }); } catch (e) { r = { level: 'threw', detail: e.message }; }
    const [lv, word] = want.split(/:(.*)/);
    // (and what it cost: the count let go past 16 MB, a part of 1 MB over at most -- r86 Q2)
    got.push([what, r.level === lv && (!word || r.detail.includes(word)) ? (sent <= 18 * MB ? want : `${want}, but ${sent} bytes read`) : `${r.level}: ${r.detail}`]);
  }
  assert.deepEqual(got, rows.map(([what, , , want]) => [what, want]), JSON.stringify(got));
});
await test('an STL, OBJ, PLY or OFF the page\'s reader refuses is refused by the check in its words: whole, gzipped, zipped, and a large PLY by its header (r85 Q3)', async () => {
  const { parseMesh } = await import('../js/mesh-formats.js');
  const { deflateRawSync } = await import('node:zlib');
  const ranged = (b) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
    const a = +m[1], e = Math.min(+m[2], b.length - 1);
    return new Response(b.subarray(a, e + 1), { status: 206, headers: { 'content-length': String(e - a + 1), 'content-range': `bytes ${a}-${e}/${b.length}` } });
  };
  const ply = (fmt, props, body) => `ply\nformat ${fmt} 1.0\nelement vertex 3\n${props}element face 1\nproperty list uchar int vertex_indices\nend_header\n${body}`;
  const xyz = 'property float x\nproperty float y\nproperty float z\n', tri = '0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n';
  const facet = (v) => `solid a\nfacet normal 0 0 1\nouter loop\n${v}endloop\nendfacet\nendsolid a\n`;
  const cases = [
    ['PLY', 'a.ply', ply('ascii', xyz, tri), true],
    ['PLY binary_middle_endian', 'a.ply', ply('binary_middle_endian', xyz, '')],
    ['PLY a float128', 'a.ply', ply('ascii', 'property float128 x\nproperty float y\nproperty float z\n', tri)],
    ['PLY no x', 'a.ply', ply('ascii', 'property float u\nproperty float y\nproperty float z\n', tri)],
    ['PLY a face past its vertices', 'a.ply', ply('ascii', xyz, '0 0 0\n1 0 0\n0 1 0\n3 0 1 7\n')],
    ['PLY a body short', 'a.ply', ply('ascii', xyz, '0 0 0\n1 0 0\n')],
    ['OFF', 'a.off', 'OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n', true],
    ['OFF a face past its vertices', 'a.off', 'OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 9\n'],
    ['OFF counts not numbers', 'a.off', 'OFF\nx y z\n'],
    ['OBJ', 'a.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', true],
    ['OBJ a face past its vertices', 'a.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n'],
    ['OBJ no faces', 'a.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\n'],
    ['OBJ a coordinate not a number', 'a.obj', 'v 0 0 x\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'],
    ['STL', 'a.stl', facet('vertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\n'), true],
    ['STL a vertex not three numbers', 'a.stl', facet('vertex 0 0 x\nvertex 1 0 0\nvertex 0 1 0\n')],
    ['STL every triangle degenerate', 'a.stl', facet('vertex 0 0 0\nvertex 0 0 0\nvertex 0 0 0\n')],
  ];
  const got = [], wanted = [];
  for (const [what, name, text, opens] of cases) {
    const b = Buffer.from(text);
    let page = null;
    try { await parseMesh(name.split('.').pop(), b.buffer.slice(b.byteOffset, b.byteOffset + b.length), name); } catch (e) { page = e.message; }
    assert.equal(page === null, !!opens, `${what}: the page ${page === null ? 'opens it' : `refuses it: ${page}`}`);
    // (as served, gzipped, and zipped deflated: each as the page meets it)
    for (const [how, url, bytes] of [['', name, b], [' gzipped', `${name}.gz`, gzipSync(b)], [' zipped', 'm.zip', miniZip([[name, deflateRawSync(b), b.length, 8]])]]) {
      const r = await checkFile(`${B}${url}`, { fetchFn: ranged(bytes), sniff: true });
      wanted.push([what + how, opens ? 'ok' : 'bad in its words']);
      got.push([what + how, opens ? (r.level === 'ok' ? 'ok' : `${r.level}: ${r.detail}`) : r.level === 'bad' && r.detail.includes(page) ? 'bad in its words' : `${r.level}: ${r.detail} (page: ${page})`]);
    }
  }
  // a PLY past what the check reads whole (18 MB, over its 16 MB), held to its header's rules from its
  // start: a format it does not read (must fire: "ok"), and counts past what the file holds -- 2,000,000
  // vertices of 12 bytes in 18 MB (r86 A2, must fire: "ok") -- and its control, 1,500,000 that fit
  // (r86 Q5: at 12 MB it was read whole, and this path had no arm)
  const bigPly = (fmt, n) => Buffer.concat([Buffer.from(`ply\nformat ${fmt} 1.0\nelement vertex ${n}\n${xyz}end_header\n`), Buffer.alloc(18e6)]);
  for (const [what, fmt, n, want] of [
    ['an 18 MB PLY, binary_middle_endian', 'binary_middle_endian', 1500000, 'bad:format binary_middle_endian is not ascii or binary'],
    ['an 18 MB PLY counting 24 MB of vertices', 'binary_little_endian', 2000000, 'bad:element vertex counts 2000000, more than the file holds'],
    ['an 18 MB PLY (control): its header held, its reader said not run', 'binary_little_endian', 1500000, 'warn:its reader was not run here']]) {
    const r = await checkFile(`${B}big.ply`, { fetchFn: ranged(bigPly(fmt, n)), sniff: true });
    const [lv, word] = want.split(/:(.*)/);
    wanted.push([what, want]);
    got.push([what, r.level === lv && (!word || r.detail.includes(word)) ? want : `${r.level}: ${r.detail}`]);
  }
  assert.deepEqual(got, wanted, JSON.stringify(got.filter((g, i) => g[1] !== wanted[i][1])));
});
await test('every mesh and 2D format by the page\'s own reader, one verdict whatever the host\'s ranges; a HEAD\'s gzip length not taken for the file\'s (r86 A1, A3, Q1)', async () => {
  const { parseMesh } = await import('../js/mesh-formats.js');
  const { readDrawing } = await import('../js/read-file.js');
  const { deflateRawSync } = await import('node:zlib');
  // (two hosts: one honouring ranges, one sending the whole -- r86 A3: one OBJ "ok" from the first,
  // "bad" from the second)
  const ranged = (b) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
    if (+m[1] >= b.length) return new Response(null, { status: 416 });
    const a = +m[1], e = Math.min(+m[2], b.length - 1);
    return new Response(b.subarray(a, e + 1), { status: 206, headers: { 'content-length': String(e - a + 1), 'content-range': `bytes ${a}-${e}/${b.length}` } });
  };
  const whole = (b) => async () => new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
  const tri = JSON.parse(gltfTri());
  const idx = `data:application/octet-stream;base64,${Buffer.from(new Uint32Array([0, 1, 9]).buffer).toString('base64')}`;
  const g = (edit) => Buffer.from(JSON.stringify({ ...tri, ...edit }));
  const rels = '<?xml version="1.0"?><Relationships><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  const m3 = (part) => miniZip([['_rels/.rels', rels], ['3D/3dmodel.model', deflateRawSync(Buffer.from(part)), Buffer.byteLength(part), 8]]);
  const pairs = (...p) => Buffer.from(p.join('\n') + '\n');
  const line = ['0', 'LINE', '10', '0', '20', '0', '11', '1', '21', '1'];
  // a 200 KB OBJ, past the 64 KB start, its face past its vertices (r86 A3)
  const longObj = Buffer.from(`${'# a comment line of the kind exporters write\n'.repeat(4500)}${OBJ_TRI.replace('f 1 2 3', 'f 1 2 9')}`);
  const cases = [
    ['glTF', 'm.gltf', g({}), true],
    ['glTF an accessor past its view', 'm.gltf', g({ accessors: [{ bufferView: 0, componentType: 5126, count: 30, type: 'VEC3' }] })],
    ['glTF a view past its buffer', 'm.gltf', g({ bufferViews: [{ buffer: 0, byteLength: 3600 }] })],
    ['glTF an index past its vertices', 'm.gltf', g({ accessors: [tri.accessors[0], { bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR' }],
      bufferViews: [tri.bufferViews[0], { buffer: 1, byteLength: 12 }], buffers: [tri.buffers[0], { uri: idx, byteLength: 12 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }] })],
    ['3MF', 'x.3mf', m3(model3mf()), true],
    ['3MF a triangle past its vertices', 'x.3mf', m3(model3mf().replace('v3="2"', 'v3="9"'))],
    ['3MF its build naming object 7', 'x.3mf', m3(model3mf().replace('objectid="1"', 'objectid="7"'))],
    ['DXF', 'a.dxf', pairs('0', 'SECTION', '2', 'ENTITIES', ...line, '0', 'ENDSEC', '0', 'EOF'), true],
    ['DXF a block inserting itself', 'a.dxf', pairs('0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'LOOP', '10', '0', '20', '0', '0', 'INSERT', '2', 'LOOP', '10', '0', '20', '0', '0', 'ENDBLK', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '2', 'LOOP', '10', '0', '20', '0', ...line, '0', 'ENDSEC', '0', 'EOF')],
    ['DXF a HATCH counting 999999', 'a.dxf', pairs('0', 'SECTION', '2', 'ENTITIES', '0', 'HATCH', '8', '0', '70', '1', '91', '1', '92', '1', '93', '999999', ...line, '0', 'ENDSEC', '0', 'EOF')],
    ['an OBJ of 200 KB, a face past its vertices', 'long.obj', longObj],
  ];
  const got = [], wanted = [];
  for (const [what, name, b, opens] of cases) {
    const ext = name.split('.').pop();
    let page = null;
    try {
      const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
      if (ext === 'dxf') readDrawing({ buf, format: 'DXF' }); else await parseMesh(ext, buf, name);
    } catch (e) { page = e.message; }
    assert.equal(page === null, !!opens, `${what}: the page ${page === null ? 'opens it' : `refuses it: ${page}`}`);
    for (const [how, host] of [['ranged', ranged], ['whole', whole]]) {
      const r = await checkFile(`${B}${name}`, { fetchFn: host(b), sniff: true });
      wanted.push([`${what}, ${how}`, opens ? 'ok' : 'bad in its words']);
      got.push([`${what}, ${how}`, opens ? (r.level === 'ok' ? 'ok' : `${r.level}: ${r.detail}`) : r.level === 'bad' && r.detail.includes(page) ? 'bad in its words' : `${r.level}: ${r.detail} (page: ${page})`]);
    }
  }
  // Q1: a valid 2 MB STL on a host keeping its .gz beside it (gzip_static): the ranged GET a 206 whose
  // Content-Range another site cannot read, the HEAD the gzip's length (must fire: "bad · damaged … it
  // is 206,356 bytes"), a byte past that length there
  const stl = stlOf(40000), stlGzLen = gzipSync(stl).length;
  const gzStatic = async (u, o = {}) => {
    if (o.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(stlGzLen) } });
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(stl, { status: 200, headers: { 'content-length': String(stlGzLen) } });
    if (+m[1] >= stl.length) return new Response(null, { status: 416 });
    const a = +m[1], e = Math.min(+m[2], stl.length - 1);
    return new Response(stl.subarray(a, e + 1), { status: 206, headers: { 'content-length': String(e - a + 1) } });
  };
  const q1 = await checkFile(`${B}big.stl`, { fetchFn: gzStatic, sniff: true });
  wanted.push(['Q1 a HEAD naming the gzip\'s length', 'not bad']);
  got.push(['Q1 a HEAD naming the gzip\'s length', q1.level !== 'bad' ? 'not bad' : `${q1.level}: ${q1.detail}`]);
  assert.deepEqual(got, wanted, JSON.stringify(got.filter((x, i) => x[1] !== wanted[i][1])));
});
await test('a drawing that draws nothing, the companions a reader is handed, a reader not run said (r87 A2-A4)', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const ranged = (b) => async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
    if (+m[1] >= b.length) return new Response(null, { status: 416 });
    const a = +m[1], e = Math.min(+m[2], b.length - 1);
    return new Response(b.subarray(a, e + 1), { status: 206, headers: { 'content-length': String(e - a + 1), 'content-range': `bytes ${a}-${e}/${b.length}` } });
  };
  const empty = Buffer.from('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n');
  const oneLine = Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n');
  const badObj = Buffer.from(OBJ_TRI.replace('f 1 2 3', 'f 1 2 9'));
  const noTri = Buffer.from('solid x\nendsolid x\n');
  const bigPng = Buffer.alloc(17 * 2 ** 20, 7);
  const z = (entries) => miniZip(entries.map(([n, b]) => [n, deflateRawSync(b), b.length, 8]));
  // a 17 MB OBJ whose last line names a vertex past its three (r87 A4)
  const bigObj = Buffer.concat([Buffer.from(`${OBJ_TRI.slice(0, OBJ_TRI.indexOf('f '))}${'# '.padEnd(99, 'x')}\n`.repeat(1)), Buffer.alloc(17 * 2 ** 20, 0x23).fill('\n', 0, 1), Buffer.from('\nf 1 2 9\n')]);
  const rows = [
    // A2: the page refuses a drawing that draws nothing (must fire: "ok"); served, gzipped, zipped
    ['A2 an empty DXF', 'plan.dxf', empty, 'bad:plan.dxf has nothing to draw'],
    ['A2 an empty DXF, gzipped', 'plan.dxf.gz', gzipSync(empty), 'bad:plan.dxf has nothing to draw'],
    ['A2 an empty DXF, zipped', 'plan.zip', z([['plan.dxf', empty]]), 'bad:plan.dxf has nothing to draw'],
    ['A2 one LINE (control)', 'plan.dxf', oneLine, 'ok'],
    // A3: a damaged model beside a 17 MB picture -- read, the picture too large to hand here: not "ok"
    // (must fire: "ok · zip"); an STL is handed none, so read whatever is beside it (must fire: "ok")
    ['A3 an OBJ beside a 1 KB picture', 'c.zip', z([['chair.obj', badObj], ['texture.png', Buffer.alloc(1024, 7)]]), 'bad:refers to vertex 9 of 3'],
    ['A3 an OBJ beside a 17 MB picture', 'c.zip', z([['chair.obj', badObj], ['texture.png', bigPng]]), 'warn:its companion files come to more than'],
    ['A3 an STL beside a 17 MB picture', 'p.zip', z([['part.stl', noTri], ['texture.png', bigPng]]), 'bad:part.stl has no triangles to show'],
    // A4: past the 16 MB read here, its reader said not run (must fire: "ok · 17.1 MB · OBJ")
    ['A4 a 17 MB OBJ', 'big.obj', bigObj, 'warn:its reader was not run here'],
    // (and one held whole past it: a small gzip of it, kept unpacked -- must fire: "ok")
    ['A4 a 17 MB OBJ in a small gzip', 'big.obj.gz', gzipSync(bigObj), 'warn:its reader was not run here'],
  ];
  // Q2: nginx's add_header without "always": its 416 carries no CORS, so the one byte past the HEAD's
  // length is a rejected fetch to another site's page -- the size unconfirmed, the file still read for
  // its reader (must fire: "warn · size not given", the reader never run)
  const noCors416 = (b) => async (u, o = {}) => {
    if (o.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(b.length) } });
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
    if (+m[1] >= b.length) throw new TypeError('Failed to fetch');
    const a = +m[1], e = Math.min(+m[2], b.length - 1);
    return new Response(b.subarray(a, e + 1), { status: 206, headers: { 'content-length': String(e - a + 1) } });
  };
  const longBad = Buffer.from(`${'# a comment line of the kind exporters write\n'.repeat(4500)}${badObj}`);
  const longGood = Buffer.from(`${'# a comment line of the kind exporters write\n'.repeat(4500)}${OBJ_TRI}`);
  rows.push(['Q2 a 200 KB OBJ the page refuses, a 416 with no CORS', 'q.obj', longBad, 'bad:refers to vertex 9 of 3', noCors416]);
  rows.push(['Q2 a 200 KB OBJ it opens, a 416 with no CORS (control)', 'q.obj', longGood, 'warn:size not given', noCors416]);
  const got = [];
  for (const [what, name, b, want, host = ranged] of rows) {
    let r;
    try { r = await checkFile(`${B}${name}`, { fetchFn: host(b), sniff: true }); } catch (e) { r = { level: 'threw', detail: e.message }; }
    const [lv, word] = want.split(/:(.*)/);
    got.push([what, r.level === lv && (!word || r.detail.includes(word)) ? want : `${r.level}: ${r.detail}`]);
  }
  const wanted = rows.map(([what, , , want]) => [what, want]);
  assert.deepEqual(got, wanted, JSON.stringify(got.filter((g, i) => g[1] !== wanted[i][1])));
});
await test('a glTF the page refuses from its JSON alone is refused by the check in the page\'s own words (r85 A2)', async () => {
  const { parseMesh } = await import('../js/mesh-formats.js');
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uri = `data:application/octet-stream;base64,${Buffer.from(pos.buffer).toString('base64')}`;
  const base = () => ({
    asset: { version: '2.0' }, buffers: [{ uri, byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }],
  });
  const prim = (p) => ({ meshes: [{ primitives: [p] }] });
  const cases = [
    ['materials not a list', { materials: 5 }],
    ['scenes not a list', { scenes: 5 }],
    ['scene 3 not there', { scene: 3 }],
    ['node 0 its own child', { nodes: [{ mesh: 0, children: [0] }] }],
    ['scene names node 9', { scenes: [{ nodes: [9] }] }],
    ['a node names mesh 5', { nodes: [{ mesh: 5 }] }],
    ['primitives not a list', { meshes: [{ primitives: 5 }] }],
    ['a primitive not an object', prim(5)],
    ['a primitive with no attributes', prim({})],
    ['Draco on a primitive, not required', prim({ attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: {} } })],
    ['POSITION accessor 7 not there', prim({ attributes: { POSITION: 7 } })],
    ['POSITION a SCALAR', { accessors: [{ bufferView: 0, componentType: 5126, count: 9, type: 'SCALAR' }] }],
  ];
  const host = (b) => async () => new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
  const got = [], wanted = [];
  for (const [what, edit] of [['control', {}], ...cases]) {
    const b = Buffer.from(JSON.stringify({ ...base(), ...edit }));
    let page = 'opens';
    try { await parseMesh('gltf', new Uint8Array(b).buffer, 'm.gltf'); } catch (e) { page = e.message; }
    const r = await checkFile(`${B}m.gltf`, { fetchFn: host(b), sniff: true });
    // (the page refuses each but the control, and the check says the same words as bad)
    wanted.push([what, what === 'control' ? 'page opens, check ok' : 'page refuses, check bad in its words']);
    got.push([what, page === 'opens' ? (r.level === 'ok' ? 'page opens, check ok' : `page opens, check ${r.level}: ${r.detail}`)
      : r.level === 'bad' && r.detail.includes(page) ? 'page refuses, check bad in its words' : `page "${page}", check ${r.level}: ${r.detail}`]);
  }
  assert.deepEqual(got, wanted, JSON.stringify(got.filter((g, i) => g[1] !== wanted[i][1])));
});
await test('a host that caps a ranged answer: the short bytes said, never read as the directory (r80 Q6)', async () => {
  const z = miniZip(Array.from({ length: 3000 }, (_, i) => [`p${i}.stl`, 'x']));
  assert.ok(z.length > 65557, 'its directory past one capped answer');
  const capped = async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(z, { status: 200, headers: { 'content-length': String(z.length) } });
    const a = +m[1], b = Math.min(+m[2], z.length - 1, a + 65535);
    return new Response(z.subarray(a, b + 1), { status: 206, headers: { 'content-length': String(b - a + 1), 'content-range': `bytes ${a}-${b}/${z.length}` } });
  };
  const r = await checkFile(`${B}many.zip`, { fetchFn: capped, sniff: true });
  assert.equal(r.level, 'warn', r.detail);
  assert.match(r.detail, /the server sent less than it was asked/, 'must fire: the short bytes parsed as its directory');
});
await test('an encrypted 3MF root over the text limit: the page and the check refuse it in one order, by one name (r77 Q5)', async () => {
  const { parseMesh } = await import('../js/mesh-formats.js');
  const rels = '<?xml version="1.0"?><Relationships><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  const z = miniZip([['_rels/.rels', rels], ['3D/3dmodel.model', model3mf(), 600 * 2 ** 20, 8, 1]]);
  let page = '';
  try { await parseMesh('3mf', new Uint8Array(z).buffer, 'x'); } catch (e) { page = e.message; }
  const r = await checkFile(`${B}x.3mf`, { fetchFn: async (u, o = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((o.headers && o.headers.Range) || '');
    if (!m) return new Response(z, { status: 200, headers: { 'content-length': String(z.length) } });
    const a = +m[1], b = Math.min(+m[2], z.length - 1);
    return new Response(z.subarray(a, b + 1), { status: 206, headers: { 'content-length': String(b - a + 1), 'content-range': `bytes ${a}-${b}/${z.length}` } });
  }, sniff: true });
  const words = 'zip entry 3D/3dmodel.model is encrypted';
  assert.ok(page.includes(words), `page: ${page} (must fire: its size first, "/3D/3dmodel.model unpacks to 600 MB")`);
  assert.ok(r.level === 'bad' && r.detail.includes(words), `check: ${r.detail}`);
});
await test('zipDirectory: a name twice is one entry, the last, in the first one\'s place; 20,000 entries read in under 2 s (r76 A4)', async () => {
  const { zipDirectory } = await import('../js/zip-dir.js');
  const z = new Uint8Array(miniZip([['A.stl', 'a'], ['b.obj', 'b'], ['/a.stl', 'cc']]));
  const got = (await zipDirectory(z, 0, z.length)).map((e) => [e.name, e.csize]);
  assert.deepEqual(got, [['/a.stl', 2], ['b.obj', 1]]);
  const many = new Uint8Array(miniZip(Array.from({ length: 20000 }, (_, i) => [`p${i}.stl`, 'x'])));
  const t0 = Date.now();
  assert.equal((await zipDirectory(many, 0, many.length)).length, 20000);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});
await test('tourSlug: one rule for the recorder and the page\'s downloads (r76 A8)', async () => {
  const { tourSlug } = await import('../js/tour.js');
  assert.deepEqual(['My Tour: Part 2!', '', '---', 'ÉTÉ'].map(tourSlug), ['my-tour-part-2', 'tour', 'tour', 't']);
  const fs = await import('node:fs');
  const main = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /const slugOf = tourSlug;/);
  assert.match(fs.readFileSync(new URL('../js/tour-recorder.js', import.meta.url), 'utf8'), /tourSlug\(draft\.title\)/);
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
