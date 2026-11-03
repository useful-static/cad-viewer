#!/usr/bin/env node
// cadmesh-export.mjs: a small gzipped .cadmesh (two named bodies) exported to STL, 3MF and GLB
// through the CLI, each read back: the STL's size and triangle count, its Z-up turn of a Y-up
// model, the 3MF a zip, the GLB's magic and node names, --skip leaving a body out, and a bad
// option refused with exit 2.   node tests/test-cadmesh-export.mjs   (exit 0 = all pass)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeCadmesh } from '../js/cadmesh.js';
import { test, done } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'cadmesh-export.mjs');
const dir = mkdtempSync(join(tmpdir(), 'cadmesh-export-'));

// a Y-up model: a 10 x 10 floor quad at y 0 ("floor") and one triangle up at y 5 ("arrow 1")
const quad = { name: 'floor', color: [1, 0, 0], positions: Float32Array.from([0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10]), normals: null, colors: null, indices: Uint32Array.from([0, 2, 1, 0, 3, 2]) };
const tri = { name: 'arrow 1', color: [0, 0, 1], positions: Float32Array.from([0, 5, 0, 4, 5, 0, 0, 5, 4]), normals: null, colors: null, indices: Uint32Array.from([0, 2, 1]) };
const enc = encodeCadmesh({ units: 'millimeter', sourceUnits: 'mm', meshes: [quad, tri], root: { name: '', meshes: [], children: [{ name: 't', meshes: [0, 1], children: [] }] } });
const raw = enc instanceof ArrayBuffer ? Buffer.from(enc) : Buffer.from(enc.buffer, enc.byteOffset, enc.byteLength);
const inp = join(dir, 'two.cadmesh.gz');
writeFileSync(inp, gzipSync(raw));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

await test('all three formats written from a .cadmesh.gz', () => {
  const r = run(inp, '--model-up', 'y');
  assert.equal(r.status, 0, r.stderr);
  for (const ext of ['stl', '3mf', 'glb']) assert.ok(existsSync(join(dir, `two.${ext}`)), ext);
  assert.match(r.stdout, /two\.stl: 2 of 2 bodies/);
});

await test('STL: 84 + 50 n bytes, 3 triangles, the Y-up model turned Z up', () => {
  const b = readFileSync(join(dir, 'two.stl'));
  const n = b.readUInt32LE(80);
  assert.equal(n, 3);
  assert.equal(b.length, 84 + 50 * n);
  // the third triangle (the arrow at model y 5) lies at output z 5
  const t = 84 + 50 * 2 + 12;
  for (let v = 0; v < 3; v++) assert.equal(b.readFloatLE(t + v * 12 + 8), 5);
});

await test('3MF is a zip; GLB has the glTF magic and the bodies as named nodes', () => {
  assert.equal(readFileSync(join(dir, 'two.3mf')).subarray(0, 2).toString(), 'PK');
  const g = readFileSync(join(dir, 'two.glb'));
  assert.equal(g.subarray(0, 4).toString(), 'glTF');
  const json = JSON.parse(g.subarray(20, 20 + g.readUInt32LE(12)).toString());
  // (labelled as the page labels them: the part's tree node, then the body)
  assert.deepEqual(json.nodes.map((n) => n.name), ['t › floor', 't › arrow 1']);
});

await test('--skip leaves out the bodies it matches; --out names the files', () => {
  const r = run(inp, '--to', 'glb', '--skip', '^arrow', '--out', join(dir, 'only'), '--model-up', 'y');
  assert.equal(r.status, 0, r.stderr);
  const g = readFileSync(join(dir, 'only.glb'));
  const json = JSON.parse(g.subarray(20, 20 + g.readUInt32LE(12)).toString());
  assert.deepEqual(json.nodes.map((n) => n.name), ['t › floor']);
  assert.match(r.stdout, /1 of 2 bodies/);
  // a pattern copied from the page's label matches too
  const r2 = run(inp, '--to', 'glb', '--skip', '^t › arrow', '--out', join(dir, 'only2'), '--model-up', 'y');
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /1 of 2 bodies/);
  // every body skipped: refused, nothing written (an empty GLB is invalid glTF)
  const r3 = run(inp, '--to', 'glb', '--skip', '.', '--out', join(dir, 'none'), '--model-up', 'y');
  assert.equal(r3.status, 1, r3.stderr);
  assert.ok(!existsSync(join(dir, 'none.glb')));
  // help is not an error; a bad --skip is an option's error
  assert.equal(run('-h').status, 0);
  assert.equal(run(inp, '--skip', '(').status, 2);
  // an option with no value is a usage error; a write that fails is one line, exit 1
  assert.equal(run(inp, '--to').status, 2);
  const w = run(inp, '--to', 'stl', '--out', join(dir, 'no-such-dir', 'x'));
  assert.equal(w.status, 1);
  assert.match(w.stderr, /^cadmesh-export: could not write .*x\.stl: /);
});

await test('a bad option is refused with exit 2', () => {
  assert.equal(run(inp, '--model-up', 'x').status, 2);
  assert.equal(run(inp, '--to', 'obj').status, 2);
  assert.equal(run().status, 2);
  // a damaged input is a refusal: exit 1, its error said, not the usage
  const bad = join(dir, 'bad.cadmesh');
  writeFileSync(bad, Buffer.from('not a cadmesh at all'));
  const rb = run(bad);
  assert.equal(rb.status, 1, rb.stderr);
  assert.match(rb.stderr, /bad\.cadmesh: cadmesh:/);
});

done();
