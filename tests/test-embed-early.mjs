#!/usr/bin/env node
// index.html's one inline script -- the embed's first paint (html.embed,
// html.light from ?embed=1&theme=light) -- against the page's
// Content-Security-Policy, which allows it by its hash alone, and against
// main.js's own reading of the same parameters:
//   node tests/test-embed-early.mjs   (exit 0 = all pass)
//
// Must-fire arm: a changed script with the old hash is reported, so a pass
// is the hash matching, not the check being blind.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, done } from './harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const inlineScripts = (h) => [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const cspHashes = (h) => {
  const csp = h.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1] || '';
  const src = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src ')) || '';
  return [...src.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]);
};
const hashOf = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
const unallowed = (h) => inlineScripts(h).filter((s) => !cspHashes(h).includes(hashOf(s)));

test('the page has exactly one inline script, and the CSP allows it by its hash', () => {
  assert.equal(inlineScripts(html).length, 1);
  assert.deepEqual(unallowed(html), []);
  // and no blanket allowance beside it
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(html));
});

test('must fire: an edited script with the old hash is refused', () => {
  const edited = html.replace(/<script>try\{/, '<script>try{void 0;');
  assert.equal(unallowed(edited).length, 1);
});

// the script, run against a stand-in document per address
function classesFor(search) {
  const list = new Set();
  const document = { documentElement: { classList: { add: (c) => list.add(c) } } };
  const location = { search };
  new Function('document', 'location', 'URLSearchParams', inlineScripts(html)[0])(document, location, URLSearchParams);
  return [...list].sort();
}

test('embed and theme: the classes the first paint gets', () => {
  assert.deepEqual(classesFor(''), []);
  assert.deepEqual(classesFor('?src=x.cadmesh.gz'), []);
  assert.deepEqual(classesFor('?theme=light'), []); // a theme is the frame's only
  assert.deepEqual(classesFor('?embed=1'), ['embed']);
  assert.deepEqual(classesFor('?embed=1&theme=dark'), ['embed']);
  assert.deepEqual(classesFor('?embed=1&theme=light'), ['embed', 'light']);
  assert.deepEqual(classesFor('?embed=1&theme=LIGHT'), ['embed']);
});

test('main.js reads ?theme= the same way (embed only, light or dark)', () => {
  const main = readFileSync(join(root, 'js', 'main.js'), 'utf8');
  assert.match(main, /const theme = app\.embed \? embedParams\.get\('theme'\) : null;/);
  assert.match(main, /if \(theme === 'light' \|\| theme === 'dark'\) app\.lightBg = theme === 'light';/);
});

done();
