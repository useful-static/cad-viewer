#!/usr/bin/env node
// What the page loads before its first card: main.js's static import graph. The format readers
// (DWG, DXF, the mesh formats, read-file.js) and the 2D view load when a file needs them
// (main.js meshReaders / fileReaders / twoD), not before: an embed showing a .cadmesh.gz loaded
// them all first -- 1.16 MB in 46 modules, "Loading the 3D viewer…" for 33.9 s on a throttled 3G
// link from a server that does not compress (r51).
//   node tests/test-first-phase.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, done } from './harness.mjs';

const js = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
const src = (f) => readFileSync(join(js, f), 'utf8');
// a module's static imports (import … from './x.js'), not its import() calls
const staticImports = (f) => [...src(f).matchAll(/^import [^;]*? from '\.\/([a-z0-9-]+\.js)'/gm)].map((m) => m[1]);
function closure(entry) {
  const seen = new Set();
  const walk = (f) => { if (seen.has(f)) return; seen.add(f); staticImports(f).forEach(walk); };
  walk(entry);
  return seen;
}
const LATER = ['dwg.js', 'dxf.js', 'dxf-view.js', 'mesh-formats.js', 'read-file.js', 'codepages.js'];

test('the first phase: none of the format readers or the 2D view is in main.js\'s static graph', () => {
  const first = closure('main.js');
  assert.deepEqual(LATER.filter((f) => first.has(f)), []);
  const bytes = [...first].reduce((n, f) => n + statSync(join(js, f)).size, 0);
  // (a ceiling, so a new static import of a large module is seen: 806 KB in 39 modules at r51)
  assert.ok(bytes < 850e3, `first phase ${bytes} bytes in ${first.size} modules`);
});

test('each one held back is loaded by main.js when a file needs it', () => {
  const m = src('main.js');
  for (const f of ['mesh-formats.js', 'read-file.js', 'dxf.js', 'dxf-view.js']) assert.ok(m.includes(`import('./${f}')`), f);
  // (the readers' own graph is still whole: the worker and a page with no worker load it)
  for (const f of ['dwg.js', 'dxf.js', 'mesh-formats.js']) assert.ok(closure('read-file.js').has(f), f);
});

done();
