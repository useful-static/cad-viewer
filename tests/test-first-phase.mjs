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
// a module's static edges, every form: import … from, export … from, a bare import './x.js', either
// quote -- not its import() calls (the first form alone missed palettes.js's `export … from
// './styles.js'`, and a re-export of a reader would have passed: r52 A4, Q5)
const STATIC = /^\s*(?:import|export)\b(?:[^;'"()]*?\bfrom\s*)?\s*(['"])\.\/([\w.-]+\.js)\1/gm;
const edgesIn = (text) => [...text.matchAll(STATIC)].map((m) => m[2]);
const staticImports = (f) => edgesIn(src(f));
function closure(entry) {
  const seen = new Set();
  const walk = (f) => { if (seen.has(f)) return; seen.add(f); staticImports(f).forEach(walk); };
  walk(entry);
  return seen;
}

test('the reader of static edges sees every form, and not an import() or a comment (must-fire)', () => {
  const text = [
    "import { a } from './a.js';", "export { b } from './b.js';", "import './c.js';", 'import { d } from "./d.js";',
    "export * from './e.js';", "import {\n  f,\n  g,\n} from './f.js';", "const m = await import('./not-static.js');",
    "// import { x } from './comment.js'", "  const s = \"import './in-a-string.js'\";",
  ].join('\n');
  assert.deepEqual(edgesIn(text), ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js']);
  assert.ok(staticImports('palettes.js').includes('styles.js'), 'palettes.js re-exports from styles.js');
});
const LATER = ['dwg.js', 'dxf.js', 'dxf-view.js', 'mesh-formats.js', 'read-file.js', 'codepages.js'];

test('the first phase: none of the format readers or the 2D view is in main.js\'s static graph', () => {
  const first = closure('main.js');
  assert.deepEqual(LATER.filter((f) => first.has(f)), []);
  const bytes = [...first].reduce((n, f) => n + statSync(join(js, f)).size, 0);
  // (a ceiling, so a new static import of a large module is seen: 806 KB in 39 modules at r51)
  assert.ok(bytes < 850e3, `first phase ${bytes} bytes in ${first.size} modules`);
});

test('each one held back is loaded by main.js when a file needs it', () => {
  // (in code, not a comment: the string anywhere passed -- r52 Q5)
  const code = src('main.js').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const f of ['mesh-formats.js', 'read-file.js', 'dxf.js', 'dxf-view.js']) assert.ok(code.includes(`import('./${f}')`), f);
  // (the readers' own graph is still whole: the worker and a page with no worker load it)
  for (const f of ['dwg.js', 'dxf.js', 'mesh-formats.js']) assert.ok(closure('read-file.js').has(f), f);
});

test('index.html asks for every first-phase module at once: its modulepreload list is the import graph of early.js and main.js, early.js\'s first', () => {
  const html = readFileSync(join(js, '..', 'index.html'), 'utf8');
  const pre = [...html.matchAll(/<link rel="modulepreload" href="js\/([\w.-]+\.js)">/g)].map((m) => m[1]);
  const early = closure('early.js'), all = new Set([...early, ...closure('main.js')]);
  assert.deepEqual([...pre].sort(), [...all].sort(), 'the list and the graph');
  assert.equal(new Set(pre).size, pre.length, 'each once');
  // (the early graph before anything else: the address's downloads wait on it alone)
  assert.deepEqual(pre.slice(0, early.size).sort(), [...early].sort(), 'early.js\'s graph first');
  assert.ok(!pre.some((f) => LATER.includes(f)), 'nothing held back');
});

await test('a reader that could not be downloaded is said in plain words, and tried again by the next file (r52 A8, Q8)', async () => {
  const m = src('main.js');
  const at = m.indexOf('const once = (load, what) => {');
  const once = new Function(`${m.slice(at, m.indexOf('\n};\n', at) + 4)}; return once;`)();
  let tries = 0;
  const reader = once(async () => { tries++; if (tries === 1) throw new TypeError('Failed to fetch dynamically imported module: https://x.test/js/mesh-formats.js'); return { ok: 1 }; }, 'meshes and zips');
  await assert.rejects(reader(), { message: 'the viewer\'s reader for meshes and zips could not be downloaded: check the connection, then open the file again' });
  assert.deepEqual(await reader(), { ok: 1 }, 'the next file tries again');
  assert.equal(await reader(), await reader(), 'fetched once after that');
  assert.equal(tries, 2);
});

done();
