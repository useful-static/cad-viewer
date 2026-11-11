#!/usr/bin/env node
// js/early.js, the page's first module: which downloads it starts for which address, before main.js
// runs, and that main.js's fetch of the same URL, and its read of the same lists, take them once
// (js/early-fetch.js). The model is the one main.js opens: js/model-list.js modelUrlFrom.
//   node tests/test-early.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import vm from 'node:vm';
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

// (r112 M early-fetch-B0: a second startEarly of a URL on its way replaced the first, a second download)
await test('startEarly of a URL already on its way starts nothing more: one fetch, taken once (r112 M early-fetch-B0)', async () => {
  const { startEarly } = await import('../js/early-fetch.js');
  const held = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { n: calls }; };
  try {
    const url = 'https://site.example/v/twice.cadmesh';
    startEarly(url);
    startEarly(url);
    assert.equal(calls, 1, 'one fetch for two starts');
    const r = await earlyFetch(url);
    assert.equal(r.n, 1, 'the first download handed on');
    assert.equal(calls, 1, 'and no fetch of its own');
    // (two-sided: another URL is its own download)
    startEarly(`${url}?b`);
    assert.equal(calls, 2);
    await earlyFetch(`${url}?b`);
  } finally { globalThis.fetch = held; }
});

// ---- js/boot-check.js run in a stand-in page (a classic script: vm, its own window and document) ----
// The page records every card boot-check puts up ("card <title> | <text>") and every element it
// removes ("removed <id>"); fire() dispatches a window event to its listeners, tick() runs the
// next timer it set.
const BOOT_SRC = (await import('node:fs')).readFileSync(new URL('../js/boot-check.js', import.meta.url), 'utf8');
function bootPage({ flag = false, bootslow = false, dataset = {} } = {}) {
  const listeners = {}, timers = [], log = [];
  const el = (tag) => ({
    tagName: tag.toUpperCase(), id: '', className: '', children: [], textContent: '', attrs: {}, clicks: [],
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { if (k === 'click') this.clicks.push(f); },
    appendChild(c) { this.children.push(c); }, remove() { log.push(`removed ${this.id || this.tagName}`); },
  });
  const stage = el('div');
  stage.id = 'stage';
  stage.appendChild = (c) => { log.push(`card ${c.children[0].textContent} | ${c.children[1].textContent}`); stage.last = c; };
  const slow = bootslow ? Object.assign(el('div'), { id: 'bootslow' }) : null;
  const doc = { currentScript: { dataset }, getElementById: (id) => (id === 'stage' ? stage : id === 'bootslow' ? slow : null), createElement: el, body: stage };
  const win = { addEventListener: (k, f) => { (listeners[k] ||= []).push(f); } };
  if (flag) win[typeof flag === 'string' ? flag : '__cadvStarted'] = true;
  let reloads = 0;
  vm.runInNewContext(BOOT_SRC, { window: win, document: doc, location: { reload() { reloads++; } }, setTimeout: (f, ms) => timers.push([f, ms]), String });
  return {
    win, log, stage, timers, reloads: () => reloads,
    fire: (k, e) => (listeners[k] || []).forEach((f) => f(e)),
    tick: () => { const t = timers.shift(); assert.ok(t, 'a timer is set'); t[0](); },
  };
}
const NOT_LOADED = (files) => `card cad.place did not start | A part of it could not be loaded${files ? ` (${files})` : ''}: the connection may have changed or dropped while the page loaded. Reloading usually fixes it.`;
const SLOW_CARD = 'card cad.place has not started | A part of it has not arrived after 20 s: the connection may be slow or have stopped. Reload to try again.';
const script = (src) => ({ target: { tagName: 'SCRIPT', src } });

// (r112 M boot-check-B1, -C2, -R3, -R6: the failed file named, the card put up at the load)
await test('boot-check: a script that failed to load names itself on the "did not start" card, put up at the load (r112 M boot-check-B1 C2 R3 R6)', () => {
  const p = bootPage({ bootslow: true });
  p.fire('error', script('http://x/js/main.js'));
  assert.deepEqual(p.log, [], 'nothing said before the load');
  p.fire('load', {});
  assert.deepEqual(p.log, ['removed bootslow', NOT_LOADED('main.js')]);
  const card = p.stage.last;
  assert.equal(card.id, 'bootfail');
  assert.equal(card.attrs.role, 'alert');
  assert.equal(card.children[2].textContent, 'Reload');
  card.children[2].clicks.forEach((f) => f());
  assert.equal(p.reloads(), 1, 'its button reloads');
  // (an icon or the manifest failing is not named: only a script or a module preload)
  const q = bootPage();
  q.fire('error', { target: { tagName: 'LINK', rel: 'icon', href: 'http://x/favicon.svg' } });
  q.fire('error', { target: { tagName: 'IMG', src: 'http://x/a.png' } });
  q.fire('load', {});
  assert.deepEqual(q.log, [NOT_LOADED('')]);
});

// (r112 M boot-check-O4, -B1, -C2: three files named, then "…" for more)
await test('boot-check: four failed files: the first three named, then "…"; three: no "…" (r112 M boot-check-O4)', () => {
  const p = bootPage();
  for (const f of ['a.js', 'b.js', 'c.js', 'd.js']) p.fire('error', script(f));
  p.fire('load', {});
  assert.deepEqual(p.log, [NOT_LOADED('a.js, b.js, c.js, …')]);
  const q = bootPage();
  for (const f of ['a.js', 'b.js', 'c.js']) q.fire('error', script(f));
  q.fire('load', {});
  assert.deepEqual(q.log, [NOT_LOADED('a.js, b.js, c.js')]);
});

// (r112 M boot-check-C4: a module failing as its preload and as its script named twice)
await test('boot-check: a module failing as its modulepreload and as its script is named once (r112 M boot-check-C4)', () => {
  const p = bootPage();
  p.fire('error', { target: { tagName: 'LINK', rel: 'modulepreload', href: 'http://x/js/main.js' } });
  p.fire('error', script('http://x/js/main.js'));
  p.fire('error', script('http://x/js/main.js'));
  p.fire('error', script('http://x/js/b.js'));
  p.fire('load', {});
  assert.deepEqual(p.log, [NOT_LOADED('main.js, b.js')]);
});

// (r112 M boot-check-C0: the thrown error's own words lost)
await test('boot-check: an error the app threw as it ran is said in its own words, the first one (r112 M boot-check-C0)', () => {
  const p = bootPage();
  p.fire('error', { target: p.win, message: 'boom' });
  p.fire('error', { target: p.win, message: 'second' });
  p.fire('load', {});
  assert.deepEqual(p.log, ['card cad.place did not start | It stopped as it started: boom. Reloading may fix it.']);
  // (no target at all: the same; an error with no message: its error's text)
  const q = bootPage();
  q.fire('error', { error: new Error('kaput') });
  q.fire('load', {});
  assert.deepEqual(q.log, ['card cad.place did not start | It stopped as it started: Error: kaput. Reloading may fix it.']);
  // (a file failing beside a throw: the file is said, not the throw)
  const r = bootPage();
  r.fire('error', { target: r.win, message: 'boom' });
  r.fire('error', script('x.js'));
  r.fire('load', {});
  assert.deepEqual(r.log, [NOT_LOADED('x.js')]);
});

// (r112 M boot-check-R1: a started page shown "did not start")
await test('boot-check: a page whose flag is set shows no card at its load; the flag and name are the script tag\'s (r112 M boot-check-R1)', () => {
  const p = bootPage({ flag: true });
  p.fire('error', script('late.js'));
  p.fire('load', {});
  assert.deepEqual(p.log, [], 'started: nothing said');
  // (check.html's own flag and name)
  const q = bootPage({ flag: '__checkStarted', dataset: { name: 'cad.place check', flag: '__checkStarted' } });
  q.fire('load', {});
  assert.deepEqual(q.log, []);
  const r = bootPage({ flag: true, dataset: { name: 'cad.place check', flag: '__checkStarted' } });
  r.fire('load', {});
  assert.deepEqual(r.log, [NOT_LOADED('').replace('card cad.place did', 'card cad.place check did')], 'another page\'s flag is not this one\'s');
});

// (r112 M boot-check-B4, -R1: the 20 s card left over a page that started late)
await test('boot-check: no load by 20 s: "has not started", taken away when the page starts after all (r112 M boot-check-B4 R1)', () => {
  const p = bootPage();
  assert.equal(p.timers[0][1], 20000);
  p.tick();
  assert.deepEqual(p.log, [SLOW_CARD]);
  assert.equal(p.timers[0][1], 2000, 'looked at again in 2 s');
  p.tick();
  assert.deepEqual(p.log, [SLOW_CARD], 'still not started: the card stays, said once');
  p.win.__cadvStarted = true;
  p.tick();
  assert.deepEqual(p.log, [SLOW_CARD, 'removed bootfail']);
  assert.equal(p.timers.length, 0, 'and no more looks');
  // (started, then its load: nothing more)
  p.fire('load', {});
  assert.deepEqual(p.log, [SLOW_CARD, 'removed bootfail']);
  // (the 20 s card, then the load with the page started: taken away at the load)
  const q = bootPage();
  q.tick();
  q.win.__cadvStarted = true;
  q.fire('load', {});
  assert.deepEqual(q.log, [SLOW_CARD, 'removed bootfail']);
  // (the 20 s card, then the load not started: the "did not start" card in its place, not taken away later)
  const r = bootPage();
  r.fire('error', script('m.js'));
  r.tick();
  r.fire('load', {});
  r.win.__cadvStarted = true;
  r.tick();
  assert.deepEqual(r.log, ['card cad.place has not started | A part of it has not arrived after 20 s (m.js failed): the connection may be slow or have stopped. Reload to try again.', 'removed bootfail', NOT_LOADED('m.js')]);
});

done();
