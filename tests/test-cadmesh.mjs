#!/usr/bin/env node
// Unit tests for the .cadmesh container and the OpenCascade result mapping.
// No GPU, no network:  node tests/test-cadmesh.mjs   (exit 0 = all pass)
// If vendor/occt-import-js is staged (fetch-deps.sh), it also round-trips a
// real STEP file through stp2mesh.mjs.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bytesToId, computeNormals, decodeCadmesh, encodeCadmesh, idToBytes, occtResultToModel,
} from '../js/cadmesh.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
const skipped = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

// a unit quad (2 triangles) offset by `dx`
function quad(name, dx, color = null) {
  return {
    name,
    color,
    positions: new Float32Array([dx, 0, 0, dx + 1, 0, 0, dx + 1, 1, 0, dx, 1, 0]),
    normals: null,
    colors: null,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

test('id <-> RGBA bytes round-trips, 0 is reserved for background', () => {
  for (const id of [1, 255, 256, 65535, 65536, 16777215]) {
    assert.equal(bytesToId(...idToBytes(id)), id);
  }
  assert.deepEqual(idToBytes(0), [0, 0, 0, 0]);
});

test('encode/decode preserves counts, offsets and the tree', () => {
  const root = { name: 'asm', meshes: [], children: [{ name: 'a', meshes: [0], children: [] }, { name: 'b', meshes: [1], children: [] }] };
  const buf = encodeCadmesh({ units: 'millimeter', meshes: [quad('a', 0, [1, 0, 0]), quad('b', 5)], root });
  const m = decodeCadmesh(buf);
  assert.equal(m.header.vertexCount, 8);
  assert.equal(m.header.indexCount, 12);
  assert.equal(m.position.length, 24);
  assert.equal(m.normal.length, 32);
  assert.deepEqual([...m.index.slice(6)], [4, 5, 6, 4, 6, 7], 'second mesh indices are rebased onto the shared vertex array');
  assert.deepEqual(m.header.meshes.map((x) => [x.vtxStart, x.vtxCount, x.idxStart, x.idxCount]), [[0, 4, 0, 6], [4, 4, 6, 6]]);
  assert.deepEqual(m.header.bbox, { min: [0, 0, 0], max: [6, 1, 0] });
  assert.equal(m.header.root.children[1].name, 'b');
});

test('per-vertex id bytes carry mesh index + 1', () => {
  const m = decodeCadmesh(encodeCadmesh({ meshes: [quad('a', 0), quad('b', 2), quad('c', 4)] }));
  for (let v = 0; v < 12; v++) {
    const want = Math.floor(v / 4) + 1;
    assert.equal(bytesToId(m.id[v * 4], m.id[v * 4 + 1], m.id[v * 4 + 2], m.id[v * 4 + 3]), want);
  }
});

test('mesh colour fills the colour section; missing normals are computed', () => {
  const m = decodeCadmesh(encodeCadmesh({ meshes: [quad('a', 0, [1, 0.5, 0])] }));
  assert.deepEqual([...m.color.slice(0, 4)], [255, 128, 0, 255]);
  // quad in the XY plane, CCW: normal +Z, snorm16
  assert.deepEqual([...m.normal.slice(0, 4)], [0, 0, 32767, 0]);
});

test('every section is 8-byte aligned (direct GPU upload)', () => {
  const m = decodeCadmesh(encodeCadmesh({ meshes: [quad('a', 0)] }));
  for (const k of ['position', 'normal', 'color', 'id', 'index']) assert.equal(m[k].byteOffset % 8, 0, k);
});

test('decode rejects a wrong magic and a truncated file', () => {
  const buf = encodeCadmesh({ meshes: [quad('a', 0)] });
  const bad = buf.slice(0);
  new Uint8Array(bad)[0] = 0;
  assert.throws(() => decodeCadmesh(bad), /bad magic/);
  assert.throws(() => decodeCadmesh(buf.slice(0, buf.byteLength - 8)), /out of range|truncated/);
  assert.throws(() => decodeCadmesh(new ArrayBuffer(4)), /too short/);
});

test('computeNormals points a CCW triangle along +Z', () => {
  const n = computeNormals(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Uint32Array([0, 1, 2]));
  assert.deepEqual([...n.slice(0, 3)], [0, 0, 1]);
});

const occt = (meshes, root) => ({ success: true, meshes, root });
const om = (name, color, faces) => ({
  name, color,
  attributes: { position: { array: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0] } },
  index: { array: [0, 1, 2, 0, 2, 3] },
  brep_faces: faces,
});

test('occt mapping: b-rep face colours become per-vertex colours', () => {
  const model = occtResultToModel(occt([om('m', [0, 0, 1], [{ first: 1, last: 1, color: [1, 0, 0] }])], { name: 'r', meshes: [0], children: [] }));
  const c = model.meshes[0].colors;
  assert.deepEqual([...c.slice(0, 3)], [255, 0, 0], 'vertex 0 belongs to face 1 (triangle 1)');
  assert.deepEqual([...c.slice(4, 7)], [0, 0, 255], 'vertex 1 is only in triangle 0: base colour');
});

test('occt mapping: a colourless file gets one colour per part NAME', () => {
  const root = { name: 'asm', meshes: [], children: [
    { name: 'WIDGET', meshes: [0], children: [] }, { name: 'WIDGET', meshes: [1], children: [] }, { name: 'BRACKET', meshes: [2], children: [] }] };
  const model = occtResultToModel(occt([om('C1', null, []), om('C2', null, []), om('C3', null, [])], root));
  assert.deepEqual(model.meshes[0].color, model.meshes[1].color, 'two instances of one part match');
  assert.ok(model.meshes.every((m) => Array.isArray(m.color)), 'every body has a colour');
});

test('occt mapping: refuses a failed import', () => {
  assert.throws(() => occtResultToModel({ success: false }), /import failed/);
});

const occtJs = join(HERE, '..', 'vendor', 'occt-import-js', 'occt-import-js.js');
const stepFixture = process.env.CADV_STEP_FIXTURE;
if (existsSync(occtJs) && stepFixture && existsSync(stepFixture)) {
  test(`stp2mesh converts ${stepFixture}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadv-test-'));
    try {
      const out = join(dir, 'x.cadmesh');
      const log = execFileSync('node', [join(HERE, '..', 'stp2mesh.mjs'), stepFixture, '-o', out], { encoding: 'utf8' });
      assert.match(log, /^OK /);
      const m = decodeCadmesh(new Uint8Array(readFileSync(out)).buffer);
      assert.ok(m.header.meshes.length > 0 && m.header.indexCount > 0, 'non-empty mesh');
      writeFileSync(join(dir, 'ok'), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
} else {
  skipped.push('stp2mesh conversion (needs fetch-deps.sh + CADV_STEP_FIXTURE=<file.stp>)');
}

for (const s of skipped) console.log(`SKIP ${s}`);
console.log(`RESULT: ${passed} passed, ${failed} failed, ${skipped.length} skipped`);
process.exit(failed ? 1 : 0);
