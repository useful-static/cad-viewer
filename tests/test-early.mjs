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

await test('a full-URL ?src= beside a ?list= is fetched at once, not after the list answers (r53 A1)', async () => {
  // (the list held: its answer never comes in this arm)
  const held = globalThis.fetch;
  asked = [];
  globalThis.fetch = async (u) => { asked.push(String(u)); return String(u).endsWith('l.json') ? new Promise(() => {}) : new Response('x'); };
  globalThis.location = { href: `${SITE}?list=l.json&src=https%3A%2F%2Fx.example%2Fc.stl`, search: '?list=l.json&src=https%3A%2F%2Fx.example%2Fc.stl' };
  await import(`../js/early.js?case=${++n}`);
  await new Promise((r) => setTimeout(r, 5));
  globalThis.fetch = held;
  assert.deepEqual(asked.filter((u) => !u.endsWith('l.json')), ['https://x.example/c.stl']);
  await earlyFetch('https://x.example/c.stl');
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

// (the 20 s card in three places -- boot-check.js's timer and words, index.html's and check.html's
// no-script #bootslow -- with nothing tying them: r77 A7)
await test('the no-script #bootslow card shows when boot-check.js would, titled as it titles its own', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const boot = read('js/boot-check.js');
  const slow = Number(/var SLOW_S = (\d+);/.exec(boot)?.[1]);
  assert.ok(slow > 0, 'boot-check.js names its wait');
  assert.match(boot, /setTimeout\(function tick\(\)[\s\S]*?\}, SLOW_S \* 1000\);/, 'and waits it');
  for (const page of ['index.html', 'check.html']) {
    const html = read(page);
    const tag = /<script src="js\/boot-check\.js"([^>]*)><\/script>/.exec(html);
    assert.ok(tag, `${page} loads boot-check.js`);
    const name = /data-name="([^"]*)"/.exec(tag[1])?.[1] || 'cad.place';
    const card = /<div id="bootslow"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    assert.ok(card, `${page} has #bootslow`);
    // (its delay: in its own style, or in the page's #bootslow rule)
    const delay = /animation:\s*bootslow\s+0s\s+linear\s+(\d+)s\s+forwards/.exec(card[0]) || /#bootslow\s*\{[^}]*animation:\s*bootslow\s+0s\s+linear\s+(\d+)s\s+forwards/.exec(html);
    assert.equal(Number(delay?.[1]), slow, `${page}: #bootslow's delay`);
    assert.match(card[1], new RegExp(`<h2>${name} has not started</h2>`), `${page}: #bootslow's title`);
    assert.ok(card[1].includes(`has not arrived after ${slow} s`), `${page}: #bootslow's words`);
  }
  // (and taken away by the app once it started, its last statements -- out, every working page showed
  // "has not started" over the model at 20 s, every test passing: r77 Q4; ui-checks boot-fail reads it live)
  for (const [mod, flag] of [['js/main.js', '__cadvStarted'], ['js/check-page.js', '__checkStarted']]) {
    const lines = read(mod).trimEnd().split('\n').filter((l) => !/^\s*\/\//.test(l));
    assert.deepEqual(lines.slice(-2).map((l) => l.replace(/\s*\/\/.*$/, '')), [`window.${flag} = true;`, "document.getElementById('bootslow')?.remove();"], `${mod} ends by setting ${flag} and removing #bootslow`);
  }
});

done();
