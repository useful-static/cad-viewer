#!/usr/bin/env node
// js/early.js, the page's first module: which downloads it starts for which address, before main.js
// runs, and that main.js's fetch of the same URL, and its read of the same lists, take them once
// (js/early-fetch.js). The model is the one main.js opens: js/model-list.js modelUrlFrom.
//   node tests/test-early.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { test, done } from './harness.mjs';
import { earlyFetch, earlyLists } from '../js/early-fetch.js';

const SITE = 'https://site.example/v/';
const LIST = JSON.stringify({ 'a.stl': 'A', 'b.stl': { name: 'B', id: 'bee' } });
let asked = [];
globalThis.fetch = async (u) => {
  asked.push(String(u));
  return String(u).endsWith('l.json') ? new Response(LIST, { status: 200 }) : new Response('x', { status: 200 });
};
let n = 0;
// early.js run on an address: the URLs it asked for once its list (if any) is read
async function run(q) {
  asked = [];
  globalThis.location = { href: `${SITE}?${q}`, search: `?${q}` };
  await import(`../js/early.js?case=${++n}`);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 1));
  return asked.filter((u) => !u.endsWith('l.json'));
}
// (each case's early downloads taken after it, as main.js would: the one js/early-fetch.js is shared
// by every case, and a URL already on its way is not started again)
async function runAndTake(q) {
  const got = await run(q);
  for (const u of got) await earlyFetch(u);
  earlyLists(new URLSearchParams(q).getAll('list'));
  return got;
}

await test('the model the address opens is fetched at once: ?src=, a list\'s ?model= or ?index=, the list\'s first', async () => {
  assert.deepEqual(await runAndTake('src=a.stl'), ['a.stl']);
  assert.deepEqual(await runAndTake('list=l.json&model=bee'), [`${SITE}b.stl`]);
  assert.deepEqual(await runAndTake('list=l.json&index=2'), [`${SITE}b.stl`]);
  assert.deepEqual(await runAndTake('list=l.json'), [`${SITE}a.stl`]);
  // (a name the list lacks: its first, as main.js opens)
  assert.deepEqual(await runAndTake('list=l.json&model=nope'), [`${SITE}a.stl`]);
  // (an embed with no poster loads at once)
  assert.deepEqual(await runAndTake('embed=1&src=a.stl'), ['a.stl']);
});

await test('nothing is fetched behind an embed\'s poster, nor a list\'s first beside a ?tour= (its own model opens)', async () => {
  assert.deepEqual(await runAndTake('embed=1&src=a.stl&poster=p.png'), []);
  assert.deepEqual(await runAndTake('embed=1&list=l.json&model=bee&poster=p.png'), []);
  assert.deepEqual(await runAndTake('list=l.json&tour=t.json'), []);
  assert.deepEqual(await runAndTake(''), []);
});

await test('main.js takes each early one once: the model\'s download, the lists\' read', async () => {
  await run('list=l.json&model=bee');
  const lists = earlyLists(['l.json']);
  assert.ok(lists, 'the read handed on');
  assert.deepEqual((await lists).entries.map((e) => e.name), ['A', 'B']);
  assert.equal(earlyLists(['l.json']), null, 'taken once');
  asked = [];
  const r = await earlyFetch(`${SITE}b.stl`);
  assert.equal(await r.text(), 'x');
  assert.deepEqual(asked, [], 'the early download, not a second fetch');
  await earlyFetch(`${SITE}b.stl`);
  assert.deepEqual(asked, [`${SITE}b.stl`], 'taken once: the next fetch is its own');
  // (other lists than the early read's: not handed on)
  await run('list=l.json');
  assert.equal(earlyLists(['other.json']), null);
});

done();
