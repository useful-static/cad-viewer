#!/usr/bin/env node
// The service worker (sw.js) keeps, at install, the page and every module it can load: its APP_JS
// list against the files in js/ (a module missing from it is a dead page offline; a name not in
// js/ fails the install), and every module main.js imports reached from it.
//   node tests/test-sw.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, done } from './harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const m = /const APP_JS = \[([^\]]*)\]/.exec(sw);

test('APP_JS names exactly the files in js/', () => {
  assert.ok(m, 'APP_JS found in sw.js');
  const listed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  const files = readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(listed, files);
});

test('every module reached from index.html by import is kept', () => {
  const listed = new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = readFileSync(join(root, 'js', f), 'utf8');
    for (const x of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]\.\/([\w.-]+\.js)['"]|new (?:Worker|URL)\(\s*['"]\.\/([\w.-]+\.js)['"]/g)) visit(x[1] || x[2]);
  };
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  for (const x of html.matchAll(/src="js\/([\w.-]+\.js)"/g)) visit(x[1]);
  assert.ok(seen.has('main.js') && seen.size > 10, `reached ${seen.size}`);
  for (const f of seen) assert.ok(listed.has(f), `${f} is imported but not kept`);
});

test('the cache name moved with the list (a client keeps the old cache until the name changes)', () => {
  assert.match(sw, /const CACHE = 'cadv-app-v2'/);
});

done();
