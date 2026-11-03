#!/usr/bin/env node
// The format table (js/formats.js), which the loader, check.html and stp2mesh all read:
//   node tests/test-formats.mjs   (exit 0 = all pass)
// Each format told by its name (gzipped, with a query) and by its first bytes; a binary STL and
// a 3MF by name only (no magic of their own); manifest.webmanifest's file handlers offer every
// format the viewer opens, and nothing else; the pickers' accept lists come from the same table.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMATS, formatOfName, sniffFormat, acceptList, isCompanion, MODEL_NAME, isDWGBytes, opensShort, opensText } from '../js/formats.js';
import { test, done } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bytes = (s) => new TextEncoder().encode(s);

await test('the "what opens" words name every format and every CAD extension in the table', () => {
  const t = opensText();
  for (const f of FORMATS) assert.ok(t.includes(f.label === 'cadmesh' ? '.cadmesh' : f.label), `${f.label} in "${t}"`);
  for (const f of FORMATS.filter((x) => x.kind === 'cad')) for (const e of f.ext) assert.ok(t.includes(`.${e}`), `.${e}`);
});
await test('the short "what opens" names every format but the cadmesh, by kind', () => {
  const t = opensShort();
  for (const f of FORMATS.filter((x) => x.kind !== 'cadmesh')) assert.ok(t.includes(f.label), `${f.label} in "${t}"`);
});
await test('index.html carries no accept list of its own (main.js sets them from the table)', () => {
  const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
  for (const id of ['open', 'addmodel']) {
    const tag = new RegExp(`<input id="${id}"[^>]*>`).exec(html)[0];
    assert.ok(!/accept=/.test(tag), tag);
  }
});
await test('a name says its format, through .gz and a query', () => {
  assert.equal(formatOfName('part.STP').label, 'STEP');
  assert.equal(formatOfName('board.cadmesh.gz').label, 'cadmesh');
  assert.equal(formatOfName('x.step?v=2').label, 'STEP');
  assert.equal(formatOfName('plan.dwg#view').label, 'DWG');
  assert.equal(formatOfName('box.brp').cad, 'brep');
  assert.equal(formatOfName('a.gltf').label, 'glTF');
  // must fire: an unknown or missing extension is no format
  assert.equal(formatOfName('readme.txt'), null);
  assert.equal(formatOfName('download'), null);
  assert.equal(formatOfName('x.gz'), null);
});

await test('first bytes say the format, for each that has a signature', () => {
  const cases = [
    ['ISO-10303-21;\nHEADER;', 'STEP'], ['﻿ISO-10303-21;', 'STEP'], ['DBRep_DrawableShape\n', 'BREP'],
    ['CADM\x01\x00', 'cadmesh'], ['glTF\x02\x00\x00\x00', 'glTF'], ['{ "asset": { "version": "2.0" } }', 'glTF'],
    ['PK\x03\x04', 'zip'], ['ply\nformat ascii 1.0\n', 'PLY'], ['solid cube\n facet normal 0 0 1\n', 'STL'],
    ['OFF\n8 6 0\n', 'OFF'], ['# made by hand\nv 0 0 0\n', 'OBJ'], ['  0\nSECTION\n  2\nHEADER\n', 'DXF'],
    ['AutoCAD Binary DXF\r\n\x1a\x00', 'DXF'], ['AC1032\x00\x00', 'DWG'], ['AC1009', 'DWG'],
    [`${' '.repeat(72)}S      1\n`, 'IGES'],
  ];
  for (const [head, label] of cases) assert.equal(sniffFormat(bytes(head))?.label, label, JSON.stringify(head));
  // must fire: plain text and a binary STL header are no format by their bytes
  assert.equal(sniffFormat(bytes('hello world')), null);
  assert.equal(sniffFormat(new Uint8Array(84)), null);
  assert.equal(isDWGBytes(bytes('AC10')), false);
});

await test('a download URL names its model in the query', () => {
  for (const n of ['part.step', 'board.stl.gz', 'plan.dwg', 'a.zip', 'x.3mf']) assert.ok(MODEL_NAME.test(n), n);
  assert.ok(!MODEL_NAME.test('photo.png'));
});

await test('companions are not models', () => {
  for (const n of ['cube.mtl', 'scene.bin', 'tex.JPG']) assert.ok(isCompanion(n), n);
  assert.ok(!isCompanion('cube.obj'));
});

await test('manifest file handlers offer exactly the formats the viewer opens', () => {
  const man = JSON.parse(readFileSync(join(here, '..', 'manifest.webmanifest'), 'utf8'));
  const offered = new Set(man.file_handlers.flatMap((h) => Object.values(h.accept).flat()).map((e) => e.replace(/^\./, '')));
  const opened = new Set(FORMATS.flatMap((f) => f.ext));
  assert.deepEqual([...offered].sort(), [...opened].sort());
});

await test('the pickers accept every format, gzipped, and the companions', () => {
  const all = acceptList().split(',');
  for (const f of FORMATS) for (const e of f.ext) assert.ok(all.includes(`.${e}`), e);
  assert.ok(all.includes('.gz') && all.includes('.mtl'));
  const add = acceptList(['cad', 'cadmesh', 'mesh', 'zip']).split(',');
  assert.ok(!add.includes('.dxf') && !add.includes('.dwg'), 'Add model… offers no drawing');
});

done();
