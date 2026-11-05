#!/usr/bin/env node
// Model lists (?list=, js/model-list.js): parse, resolve, join in URL order:
//   node tests/test-model-list.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { entryByName, fetchModelLists, joinModelLists, parseModelList } from '../js/model-list.js';
import { PART_NAME_MAX, parseTour } from '../js/tour.js';

import { test, done } from './harness.mjs';

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
await test('an entry may carry an orient, kept canonical; a bad one refuses the list naming the file', () => {
  const e = parseModelList('{"a.cadmesh": {"name": "A", "orient": "up:+z,front:-y"}, "b.cadmesh": {"name": "B", "orient": "right:+y,up:z"}, "c.cadmesh": "C"}', L);
  assert.deepEqual(e.map((x) => x.orient), ['+z-y', '+z+x', undefined]);
  assert.throws(() => parseModelList('{"a.cadmesh": {"name": "A", "orient": "up:+z,front:+z"}}', L), /"a.cadmesh": its orient: up and front must be different axes/);
  assert.throws(() => parseModelList('[["a.cadmesh", {"name": "A", "orient": 5}]]', L), /"a.cadmesh": its orient/);
  // a file named twice keeps its first entry, orient included
  const j = joinModelLists([parseModelList('{"a.cadmesh": {"name": "A", "orient": "+z-y"}}', L), parseModelList('{"a.cadmesh": {"name": "A2", "orient": "+z+x"}}', L)]);
  assert.deepEqual(j, [{ url: 'https://site.example/api/a.cadmesh', name: 'A', orient: '+z-y' }]);
});
await test('anything else is refused, saying why', () => {
  assert.throws(() => parseModelList('"a list"', L), /one JSON object/);
  assert.throws(() => parseModelList('[["a.cadmesh", "A"], ["b.cadmesh"]]', L), /entry 2 is not a \[file, name\] pair/);
  assert.throws(() => parseModelList('{"a": 3}', L), /"a": its name must be a string/);
  assert.throws(() => parseModelList('{"a": ', L), /not JSON/);
  assert.throws(() => parseModelList('{"javascript:alert(1)": "x"}', L), /not an http\(s\) URL/);
});
await test('an entry\'s picture, STEP and tours named by a share page are read from the file, as check.html checks them', () => {
  const e = parseModelList(JSON.stringify({ 'b.cadmesh': { name: 'B', image: 'https://github.com/o/r/blob/main/b.webp', step: 'https://github.com/o/r/blob/main/b.stp', tours: [{ url: 'https://github.com/o/r/blob/main/t.cadtour.json' }], page: 'https://github.com/o/r/blob/main/README.md' } }), 'https://a.example/l.json');
  assert.equal(e[0].image, 'https://raw.githubusercontent.com/o/r/main/b.webp');
  assert.equal(e[0].step, 'https://raw.githubusercontent.com/o/r/main/b.stp');
  assert.equal(e[0].tours[0].url, 'https://raw.githubusercontent.com/o/r/main/t.cadtour.json');
  assert.equal(e[0].page, 'https://github.com/o/r/blob/main/README.md', 'a page stays the page');
});
await test('a note with both "part" and "at" is placed as a tour\'s callout is: by its part', () => {
  const e = parseModelList(JSON.stringify({ 'b.cadmesh': { name: 'B', notes: [{ text: 'x', part: 'Fan', at: [1, 2, 3] }, { text: 'y', part: '  ', at: [4, 5, 6] }] } }), 'https://a.example/l.json');
  assert.deepEqual(e[0].notes, [{ text: 'x', part: 'Fan' }, { text: 'y', at: [4, 5, 6] }]);
  const t = parseTour(JSON.stringify({ cadtour: 2, steps: [{ callouts: [{ text: 'x', part: 'Fan', at: [1, 2, 3] }] }] }));
  assert.deepEqual(t.steps[0].callouts, [{ text: 'x', part: 'Fan' }]);
});
await test('on an app\'s own scheme an entry\'s picture, STEP and tours are its own files too; a page must be http(s)', () => {
  const A = 'lc://app/data/cad/list.json';
  const e = parseModelList(JSON.stringify({ 'b/model.cadmesh.gz': { name: 'B', image: 'b/pic.webp', step: 'b/b.stp.gz', tours: [{ name: 'T', url: 'b/t.cadtour.json' }] } }), A);
  assert.equal(e[0].image, 'lc://app/data/cad/b/pic.webp');
  assert.equal(e[0].tours[0].url, 'lc://app/data/cad/b/t.cadtour.json');
  assert.throws(() => parseModelList(JSON.stringify({ 'b.cadmesh': { name: 'B', image: 'lc://other/p.webp' } }), A), /nor on the list's own scheme and host/);
  assert.throws(() => parseModelList(JSON.stringify({ 'b.cadmesh': { name: 'B', page: 'b/page.html' } }), A), /is not an http\(s\) URL/);
});
await test('a list on an app\'s own scheme names its own files; any other non-http place is refused', () => {
  const A = 'lc://app/data/cad/list.json';
  const e = parseModelList('{"/data/cad/le-potato/model.cadmesh.gz": {"name": "Le Potato", "labels": {"X_1": "microSD card slot"}}}', A);
  assert.equal(e[0].url, 'lc://app/data/cad/le-potato/model.cadmesh.gz');
  assert.deepEqual(e[0].labels, { X_1: 'microSD card slot' });
  // must reject: another host on the same scheme, another scheme, and file: against file:
  // (URL.origin is "null" for all of these, which is why it is not the test)
  assert.throws(() => parseModelList('{"lc://other/x.cadmesh": "X"}', A), /not an http\(s\) URL, nor on the list's own scheme and host/);
  assert.throws(() => parseModelList('{"foo://app/x.cadmesh": "X"}', A), /not an http\(s\) URL/);
  assert.throws(() => parseModelList('{"x.cadmesh": "X"}', 'file:///srv/list.json'), /not an http\(s\) URL/);
  assert.throws(() => parseModelList('{"file:///etc/passwd": "X"}', 'file:///srv/list.json'), /not an http\(s\) URL/);
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
await test('an entry may carry step, page, author, license, labels and style; URLs resolve against the list', () => {
  const [e] = parseModelList(JSON.stringify({ 'a.cadmesh.gz': {
    name: 'A', step: 'a.stp.gz', page: '/products/a/', image: 'pics/a.webp', author: ' Maker ', license: 'CC-BY-4.0',
    labels: { 'HDMI_1_3': 'HDMI', 'J1': ' ' }, style: 'edges', other: 'ignored' } }), L);
  assert.deepEqual(e, { url: 'https://site.example/api/a.cadmesh.gz', name: 'A', step: 'https://site.example/api/a.stp.gz',
    page: 'https://site.example/products/a/', image: 'https://site.example/api/pics/a.webp', author: 'Maker', license: 'CC-BY-4.0',
    labels: { HDMI_1_3: 'HDMI' }, style: 'edges' });
});
await test('notes: by a point or a part, trimmed; a wrong one refuses the list', () => {
  const [e] = parseModelList(JSON.stringify({ a: { name: 'A', notes: [{ text: ' HDMI ', part: 'HDMI_1_3' }, { text: 'Hole', at: [1, 2, 3] }] } }), L);
  assert.deepEqual(e.notes, [{ text: 'HDMI', part: 'HDMI_1_3' }, { text: 'Hole', at: [1, 2, 3] }]);
  for (const n of [[{ text: 'x' }], [{ text: '', part: 'p' }], [{ text: 'x', at: [1, 2] }], { text: 'x', part: 'p' }, [{ text: 'x'.repeat(201), part: 'p' }]]) {
    assert.throws(() => parseModelList(JSON.stringify({ a: { name: 'A', notes: n } }), L), /its notes must be/);
  }
});
await test('id and aliases: a model found by either; a bad or doubled one refuses the list', () => {
  const es = parseModelList(JSON.stringify({ a: { name: 'A', id: 'le-potato', aliases: ['aml-s905x-cc', 'le-potato'] }, b: { name: 'B', id: 'tritium' } }), L);
  assert.equal(es[0].id, 'le-potato');
  assert.deepEqual(es[0].aliases, ['aml-s905x-cc']); // (its own id is not an alias)
  assert.equal(entryByName(es, 'le-potato'), es[0]);
  assert.equal(entryByName(es, 'aml-s905x-cc'), es[0]);
  assert.equal(entryByName(es, 'tritium'), es[1]);
  assert.equal(entryByName(es, 'nope'), null);
  for (const v of [{ id: 'Le Potato' }, { id: '-x' }, { id: 3 }, { aliases: 'x' }, { aliases: ['A'] }]) {
    assert.throws(() => parseModelList(JSON.stringify({ a: { name: 'A', ...v } }), L), /its (id|aliases) must be/);
  }
  assert.throws(() => parseModelList(JSON.stringify({ a: { name: 'A', id: 'x' }, b: { name: 'B', aliases: ['x'] } }), L), /"x" names two models/);
  // joined: an earlier list's name keeps its model, the later entry stays without it
  const [l1, l2] = [parseModelList(JSON.stringify({ a: { name: 'A', id: 'x' } }), L),
    parseModelList(JSON.stringify({ b: { name: 'B', id: 'x', aliases: ['y'] } }), L)];
  const j = joinModelLists([l1, l2]);
  assert.equal(j.length, 2);
  assert.equal(entryByName(j, 'x').name, 'A');
  assert.equal(j[1].id, undefined);
  assert.equal(entryByName(j, 'y').name, 'B');
});
await test('hide: part names, trimmed; a wrong one refuses the list', () => {
  const [e] = parseModelList(JSON.stringify({ a: { name: 'A', hide: [' #2831 ', 'PRT0001'] } }), L);
  assert.deepEqual(e.hide, ['#2831', 'PRT0001']);
  for (const h of ['#1', [''], [3], ['x'.repeat(PART_NAME_MAX + 1)]]) {
    assert.throws(() => parseModelList(JSON.stringify({ a: { name: 'A', hide: h } }), L), /its hide must be/);
  }
  // a name a tour may give, the list may hide (one limit, js/tour.js PART_NAME_MAX)
  assert.equal(parseModelList(JSON.stringify({ a: { name: 'A', hide: ['x'.repeat(PART_NAME_MAX)] } }), L)[0].hide[0].length, PART_NAME_MAX);
});
await test('tours: named, resolved against the list; a wrong one refuses the list', () => {
  const [e] = parseModelList(JSON.stringify({ a: { name: 'A', tours: [{ name: ' The board ', url: 'tours/a.cadtour.json' }, { url: 'https://x.example/b.json' }] } }), L);
  assert.deepEqual(e.tours, [{ name: 'The board', url: 'https://site.example/api/tours/a.cadtour.json' }, { name: 'Tour', url: 'https://x.example/b.json' }]);
  for (const t of [[{ name: 'x' }], [{ url: '' }], { url: 'a.json' }, [{ url: 'ftp://x/a.json' }], [{ url: 'a.json', name: 'x'.repeat(101) }]]) {
    assert.throws(() => parseModelList(JSON.stringify({ a: { name: 'A', tours: t } }), L), /its tours/);
  }
});
await test('links: named, resolved against the list; a wrong one (or a script URL) refuses the list', () => {
  const [e] = parseModelList(JSON.stringify({ a: { name: 'A', links: [{ name: ' Layout ', url: 'https://layout.example/?board=a' }, { name: 'Page', url: '/p/' }] } }), L);
  assert.deepEqual(e.links, [{ name: 'Layout', url: 'https://layout.example/?board=a' }, { name: 'Page', url: 'https://site.example/p/' }]);
  // (the limit is on the name as shown, after trimming)
  const [p] = parseModelList(JSON.stringify({ a: { name: 'A', links: [{ name: ` ${'x'.repeat(100)} `, url: 'a' }] } }), L);
  assert.equal(p.links[0].name.length, 100);
  for (const k of [[{ name: 'x' }], [{ url: 'a' }], [{ name: ' ', url: 'a' }], { name: 'x', url: 'a' },
    [{ name: 'x', url: 'javascript:alert(1)' }], [{ name: 'x', url: 'data:text/html,<b>' }], [{ name: 'x'.repeat(101), url: 'a' }],
    Array.from({ length: 11 }, () => ({ name: 'x', url: 'a' }))]) {
    assert.throws(() => parseModelList(JSON.stringify({ a: { name: 'A', links: k } }), L), /its links/);
  }
});
await test('a wrong extra field refuses the list, naming the file and the field', () => {
  for (const [v, re] of [[{ step: 'javascript:alert(1)' }, /"a": its step .* not an http/], [{ page: 3 }, /its page must be a URL/],
    [{ labels: ['x'] }, /its labels must be/], [{ labels: { a: 1 } }, /its labels must be/], [{ style: 'fancy' }, /its style must be one of/],
    [{ author: 'x'.repeat(201) }, /its author must be text/]]) {
    assert.throws(() => parseModelList(JSON.stringify({ a: { name: 'A', ...v } }), L), re);
  }
});

await test('a relative ?src= / ?add= the list names is found by the URL the list was read from: a share page\'s file, a redirect\'s target (r55 A2)', async () => {
  const { listedUrlFrom, modelUrlFrom } = await import('../js/model-list.js');
  const body = JSON.stringify({ 'a.stl': 'A' });
  const serve = (redirect) => async (u) => {
    const r = new Response(body, { status: 200 });
    if (redirect) Object.defineProperty(r, 'url', { value: redirect });
    return r;
  };
  const base = 'https://page.example/viewer/';
  // (a GitHub blob page: read as its raw file)
  const blob = 'https://github.com/o/r/blob/main/lists/l.json';
  const g = await fetchModelLists([blob], base, serve(null));
  assert.deepEqual(g.entries.map((e) => e.url), ['https://raw.githubusercontent.com/o/r/main/lists/a.stl']);
  assert.equal(listedUrlFrom('a.stl', [blob], g.entries, base), 'https://raw.githubusercontent.com/o/r/main/lists/a.stl');
  assert.equal(modelUrlFrom(new URLSearchParams('src=a.stl'), [blob], g.entries, base), 'https://raw.githubusercontent.com/o/r/main/lists/a.stl');
  // (a list that answered from elsewhere)
  const moved = await fetchModelLists(['https://ex.example/l.json'], base, serve('https://ex.example/v2/l.json'));
  assert.equal(listedUrlFrom('a.stl', ['https://ex.example/l.json'], moved.entries, base), 'https://ex.example/v2/a.stl');
  // (a plain list, the control; and a name the list does not have)
  const plain = await fetchModelLists(['https://ex.example/lists/l.json'], base, serve(null));
  assert.equal(listedUrlFrom('a.stl', ['https://ex.example/lists/l.json'], plain.entries, base), 'https://ex.example/lists/a.stl');
  assert.equal(listedUrlFrom('b.stl', ['https://ex.example/lists/l.json'], plain.entries, base), null);
  // (the entry's own fields unchanged: the URL it was read from is not one of them)
  assert.deepEqual(Object.keys(plain.entries[0]).sort(), ['name', 'url']);
});

done();
