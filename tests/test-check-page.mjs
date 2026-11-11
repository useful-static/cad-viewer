#!/usr/bin/env node
// js/check-page.js, check.html's module, run in a stand-in page: the table it fills from a model
// list's checks (a row per check, the model's name and id on its first row, each cell's class), the
// list notes and the summary line, and the form (a box of spaces asks for the URL; a URL runs the
// check and is put in the address). The page's module text is run as shipped, its one import --
// js/list-check.js's checkLists, insertInOrder, summary -- stood in by a recording list check, so
// what is asserted is check-page.js's own work (list-check.js has its own tests: test-list-check.mjs).
//   node tests/test-check-page.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, done } from './harness.mjs';

const SRC = readFileSync(new URL('../js/check-page.js', import.meta.url), 'utf8');
const IMPORT = "import { checkLists, insertInOrder, summary } from './list-check.js';";

// A stand-in element: textContent, className, hidden, disabled, its children (append)
function el(tag) {
  return {
    tag, kids: [], className: '', hidden: false, disabled: false, value: '', _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.kids = []; },
    append(...c) { this.kids.push(...c); },
    remove() { this.removed = true; },
  };
}
// a cell as "text[small text].class"
const cellText = (td) => td.textContent + (td.kids.length ? `[${td.kids.map((k) => k.textContent).join()}]` : '') + (td.className ? `.${td.className}` : '');

let n = 0;
// Runs check-page.js on check.html?<query>; `entries` are what the stood-in checkLists reports,
// one onEntry each, and `lists` its result's lists.
async function page(query, { entries = [], lists = [], throws = null } = {}) {
  assert.ok(SRC.includes(IMPORT), 'check-page.js imports list-check.js as this test stands it in');
  const calls = [], inserted = [];
  const els = {};
  for (const id of ['results', 'listnotes', 'go', 'summary', 'lists', 'form', 'bootslow']) els[id] = el(id);
  const body = el('tbody');
  body.rows = [];
  Object.defineProperty(body, 'textContent', { set() { this.rows = []; }, get() { return ''; } });
  // ("td.model:not(:empty)": a model cell with a name or an id in it)
  body.querySelectorAll = (sel) => {
    assert.equal(sel, 'td.model:not(:empty)');
    return body.rows.flatMap((tr) => tr.kids.filter((td) => td.className === 'model' && (td.textContent || td.kids.length)));
  };
  els.results.tBodies = [body];
  const seen = { summaries: [] };
  const sum = els.summary;
  Object.defineProperty(sum, 'textContent', { get() { return this._text; }, set(v) { this._text = String(v); seen.summaries.push(this._text); } });
  const lc = {
    async checkLists(urls, href, { onEntry }) {
      calls.push({ urls, href, goDisabled: els.go.disabled, hidden: els.results.hidden });
      if (throws) throw new Error(throws);
      entries.forEach((e, i) => onEntry(e, i, entries.length));
      return { lists: lists.map((l) => ({ ...l })) };
    },
    insertInOrder(tbody, frag, i) { assert.equal(tbody, body); assert.equal(frag.tag, 'frag', 'a fragment of rows'); inserted.push(i); tbody.rows.push(...frag.kids); }, // (entries reported in order here)
    summary(result) { return `SUMMARY of ${result.lists.length}`; },
  };
  const replaced = [];
  globalThis.document = { getElementById: (id) => els[id] || null, createElement: el, createDocumentFragment: () => el('frag') };
  globalThis.location = { href: `http://x/check.html${query ? `?${query}` : ''}`, search: query ? `?${query}` : '' };
  globalThis.history = { replaceState: (s, t, u) => replaced.push(String(u)) };
  globalThis.window = {};
  globalThis.__lc = lc;
  const code = SRC.replace(IMPORT, 'const { checkLists, insertInOrder, summary } = globalThis.__lc;') + `\n// case ${++n}\n`;
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 1)); };
  await settle();
  return {
    els, body, calls, inserted, replaced, seen, settle, started: globalThis.window.__checkStarted,
    cells: () => body.rows.map((tr) => `${tr.className}: ${tr.kids.map(cellText).join(' / ')}`),
    notes: () => els.listnotes.kids.map((p) => p.textContent),
  };
}

const BOLT = { name: 'Bolt', id: 'b1', checks: [{ level: 'ok', what: 'read', detail: 'fine', url: 'u1' }, { level: 'warn', what: 'size', detail: 'big', url: 'u2' }] };
const NUT = { name: 'Nut', checks: [{ level: 'bad', what: 'fetch', detail: 'HTTP 404', url: 'u3' }] };

// (r112 M check-page-B0 B2 C0 C2 C4 O0 O2 O4 R0 R2 R4: no arm ran check-page.js)
await test('a model\'s checks fill a row each: its name and id on the first row only, the cells classed model / res / url (r112 M check-page-B0 B2 C0 C2 C4 O0 O2 O4 R0 R2 R4)', async () => {
  const p = await page('list=L1&list=L2', { entries: [BOLT, NUT], lists: [{ url: 'L1' }, { url: 'L2', error: 'HTTP 404' }] });
  assert.equal(p.calls.length, 1, 'the address\'s lists checked at once');
  assert.deepEqual(p.calls[0].urls, ['L1', 'L2']);
  assert.equal(p.calls[0].href, 'http://x/check.html?list=L1&list=L2');
  assert.equal(p.els.lists.value, 'L1\nL2', 'the box holds the address\'s lists');
  assert.deepEqual(p.cells(), [
    'ok: 🟢 / Bolt[id b1].model / read / fine.res / u1.url',
    'warn: 🟡 / .model / size / big.res / u2.url',
    'bad: 🔴 / Nut.model / fetch / HTTP 404.res / u3.url',
  ], `the rows: ${JSON.stringify(p.cells())}`);
  assert.deepEqual(p.inserted, [0, 1], 'each model\'s rows put at its place in the list');
  assert.equal(p.els.results.hidden, false, 'the table shown once a model is in it');
  assert.deepEqual(p.notes(), ['🟢 the list L1 was read', '🔴 the list L2 was not read: HTTP 404']);
  assert.equal(p.els.summary.textContent, 'SUMMARY of 2', 'the verdict: list-check.js summary');
  assert.deepEqual(p.seen.summaries, ['reading the list…', 'checked 1 of 2 models…', 'checked 2 of 2 models…', 'SUMMARY of 2']);
  assert.equal(p.calls[0].goDisabled, true, 'the button off while it runs');
  assert.equal(p.els.go.disabled, false, 'and on again after');
  assert.equal(p.started, true, 'boot-check.js\'s sign: __checkStarted');
  assert.equal(p.els.bootslow.removed, true, 'and the no-script card taken away');
});

// (r112 M check-page-B4: the form sent with spaces ran a check of no lists)
await test('the form sent with only spaces asks for the URL and checks nothing; with a URL it checks it and puts it in the address (r112 M check-page-B4)', async () => {
  const p = await page('', { entries: [BOLT], lists: [{ url: 'L1' }] });
  assert.equal(p.calls.length, 0, 'no ?list=: nothing checked');
  p.els.lists.value = '  \n ';
  let prevented = 0;
  p.els.form.onsubmit({ preventDefault() { prevented++; } });
  await p.settle();
  assert.equal(prevented, 1);
  assert.equal(p.els.summary.textContent, 'give the list\'s URL');
  assert.equal(p.calls.length, 0, 'and checks nothing');
  assert.deepEqual(p.replaced, [], 'nor changes the address');
  // (two-sided: a URL among the spaces is checked)
  p.els.lists.value = '  L9 \n L8 ';
  p.els.form.onsubmit({ preventDefault() { prevented++; } });
  await p.settle();
  assert.equal(p.calls.length, 1);
  assert.deepEqual(p.calls[0].urls, ['L9', 'L8']);
  assert.deepEqual(p.replaced, ['http://x/check.html?list=L9&list=L8']);
  assert.equal(p.els.summary.textContent, 'SUMMARY of 1');
});

// (a list check that throws: said on the summary line, the button on again)
await test('a check that throws is said on the summary line, and the button is on again', async () => {
  const p = await page('', { throws: 'the list is not JSON' });
  p.els.lists.value = 'L1';
  p.els.form.onsubmit({ preventDefault() {} });
  await p.settle();
  assert.equal(p.els.summary.textContent, 'the check stopped: the list is not JSON');
  assert.equal(p.els.go.disabled, false);
});

done();
