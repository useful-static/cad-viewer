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
  bytesToId, computeNormals, decodeCadmesh, deflateCadmesh, encodeCadmesh, gunzip, idToBytes, inflateCadmesh,
  isGzip, occtResultToModel,
} from '../js/cadmesh.js';
import { gunzipSync, gzipSync } from 'node:zlib';

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

test('decode rejects a tree that names a mesh out of range (review r5)', () => {
  const root = { name: 'asm', meshes: [], children: [{ name: 'x', meshes: [5], children: [] }] };
  const buf = encodeCadmesh({ meshes: [quad('a', 0), quad('b', 2), quad('c', 4)], root });
  assert.throws(() => decodeCadmesh(buf), /names mesh 5 of 3/);
});

test('decode rejects a mesh range outside the vertex data (review r5)', () => {
  const buf = encodeCadmesh({ meshes: [quad('a', 0)] });
  // rewrite the JSON header in place with a widened vtxCount
  const dv = new DataView(buf);
  const jlen = dv.getUint32(8, true);
  const text = new TextDecoder().decode(new Uint8Array(buf, 12, jlen));
  const evil = text.replace('"vtxCount":4', '"vtxCount":9');
  assert.equal(evil.length, text.length);
  new Uint8Array(buf, 12, jlen).set(new TextEncoder().encode(evil));
  assert.throws(() => decodeCadmesh(buf), /mesh 0 range/);
});

// rewrite one JSON header field in place (same length) and return the buffer
function patchHeader(buf, from, to) {
  const dv = new DataView(buf);
  const jlen = dv.getUint32(8, true);
  const text = new TextDecoder().decode(new Uint8Array(buf, 12, jlen));
  const evil = text.replace(from, to);
  assert.notEqual(evil, text, `pattern ${from} not found`);
  assert.equal(evil.length, text.length);
  new Uint8Array(buf, 12, jlen).set(new TextEncoder().encode(evil));
  return buf;
}

test('decode rejects a malformed bounding box (review r6)', () => {
  const buf = encodeCadmesh({ meshes: [quad('a', 0)] });
  // "max" -> "mox": the header bbox loses its max corner
  assert.throws(() => decodeCadmesh(patchHeader(buf, '"max"', '"mox"')), /bounding box malformed/);
});

test('decode rejects counts that disagree with the sections (review r6)', () => {
  const buf = encodeCadmesh({ meshes: [quad('a', 0)] });
  assert.throws(() => decodeCadmesh(patchHeader(buf, '"vertexCount":4', '"vertexCount":5')), /does not match the header counts/);
});

test('decode rejects an index past the vertex data (review r6)', () => {
  const buf = encodeCadmesh({ meshes: [quad('a', 0)] });
  const m = decodeCadmesh(buf);
  m.index[2] = 99; // views alias the buffer
  assert.throws(() => decodeCadmesh(buf), /index 2 names vertex 99 of 4/);
});

test('an empty model still decodes (no vertices, null bbox)', () => {
  const m = decodeCadmesh(encodeCadmesh({ meshes: [] }));
  assert.equal(m.header.vertexCount, 0);
  assert.equal(m.header.bbox, null);
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

test('occt mapping: counts the faces the converter returned without triangles', () => {
  const root = { name: 'r', meshes: [0, 1], children: [] };
  const ok = occtResultToModel(occt([om('a', null, [{ first: 0, last: 1 }])], { name: 'r', meshes: [0], children: [] }));
  assert.equal(ok.unmeshedFaces, 0);
  // an empty face: its range ends before it starts (last = first - 1)
  const bad = occtResultToModel(occt([om('a', null, [{ first: 0, last: 1 }, { first: 2, last: 1 }]), om('b', null, [{ first: 0, last: -1 }])], root));
  assert.equal(bad.unmeshedFaces, 2);
});

test('occt mapping: the converter\'s b-rep status reaches the header as kind, with the caps count', () => {
  const root = { name: 'r', meshes: [0, 1, 2], children: [] };
  const res = occt([{ ...om('a', null, []), brep_kind: 'capped' }, { ...om('b', null, []), brep_kind: 'sheet' }, om('c', null, [])], root);
  res.brep_caps = 2;
  const model = occtResultToModel(res);
  assert.equal(model.brepCaps, 2);
  const h = decodeCadmesh(encodeCadmesh(model)).header;
  assert.equal(h.meshes[0].kind, 'capped');
  assert.equal(h.meshes[1].kind, 'sheet');
  assert.equal(h.meshes[2].kind, undefined, 'a converter without b-rep status writes no kind');
  assert.equal(occtResultToModel(occt([om('a', null, [])], { name: 'r', meshes: [0], children: [] })).brepCaps, null,
    'a build without CapPlanarHoles reports no caps count, not zero');
});

test('occt mapping drops a body status it does not know', () => {
  const model = occtResultToModel(occt([{ ...om('a', null, []), brep_kind: 'watertight' }], { name: 'r', meshes: [0], children: [] }));
  assert.equal(model.meshes[0].kind, null);
  assert.equal(decodeCadmesh(encodeCadmesh(model)).header.meshes[0].kind, undefined);
});

test('decode rejects an unknown body kind', () => {
  const model = { units: 'millimeter', meshes: [{ ...quad('a', 0), kind: 'closed' }], root: { name: 'r', meshes: [0], children: [] } };
  const buf = encodeCadmesh(model);
  assert.equal(decodeCadmesh(buf).header.meshes[0].kind, 'closed');
  model.meshes[0].kind = 'watertight';
  assert.throws(() => decodeCadmesh(encodeCadmesh(model)), /kind "watertight"/);
});

test('occt mapping: refuses a failed import', () => {
  assert.throws(() => occtResultToModel({ success: false }), /import failed/);
});

test('stp2mesh refuses --absolute together with --deflection (review r1)', () => {
  let rc = 0;
  let err = '';
  try {
    execFileSync('node', [join(HERE, '..', 'stp2mesh.mjs'), 'x.stp', '--absolute', '0.1', '--deflection', '0.001'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    rc = e.status;
    err = String(e.stderr);
  }
  assert.equal(rc, 2);
  assert.match(err, /only one of --deflection \/ --absolute/);
});

test('stp2mesh refuses a non-positive or non-numeric --angular (review r2)', () => {
  for (const bad of ['abc', '-1', '0']) {
    let rc = 0;
    try {
      execFileSync('node', [join(HERE, '..', 'stp2mesh.mjs'), 'x.stp', '--angular', bad], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      rc = e.status;
    }
    assert.equal(rc, 2, `--angular ${bad}`);
  }
});

async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

const sample = () => encodeCadmesh({
  units: 'mm', meshes: [quad('a', 0, [1, 0, 0]), quad('b', 2)], root: { name: 'r', meshes: [0, 1], children: [] },
});

await atest('a gzipped file inflates to the same bytes; a raw one passes through untouched', async () => {
  const raw = sample();
  assert.equal(isGzip(raw), false);
  assert.equal(await inflateCadmesh(raw), raw, 'raw input is returned as-is (no copy)');
  // both writers: the browser's CompressionStream and Node's zlib (stp2mesh)
  for (const gz of [await deflateCadmesh(raw), new Uint8Array(gzipSync(Buffer.from(raw))).buffer]) {
    assert.equal(isGzip(gz), true);
    assert.ok(gz.byteLength < raw.byteLength, 'smaller');
    assert.deepEqual(new Uint8Array(await inflateCadmesh(gz)), new Uint8Array(raw));
  }
  assert.equal(decodeCadmesh(await inflateCadmesh(await deflateCadmesh(raw))).header.meshes.length, 2);
});

await atest('a truncated gzip file is refused with a cadmesh error, not decoded', async () => {
  const gz = await deflateCadmesh(sample());
  await assert.rejects(inflateCadmesh(gz.slice(0, gz.byteLength >> 1)), /cadmesh: the gzip data is corrupt or truncated/);
  assert.equal(isGzip(new ArrayBuffer(1)), false, 'a 1-byte buffer is not gzip');
});

await atest('gunzip unpacks any gzip file (a part.stp.gz) to the bytes inside', async () => {
  const step = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\n').buffer;
  const gz = new Uint8Array(gzipSync(Buffer.from(step))).buffer;
  assert.deepEqual(new Uint8Array(await gunzip(gz)), new Uint8Array(step));
  await assert.rejects(gunzip(gz.slice(0, gz.byteLength >> 1)), /^Error: the gzip data is corrupt or truncated/);
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
      const file = readFileSync(out);
      assert.equal(file[0], 0x1f, 'stp2mesh writes gzip by default');
      const m = decodeCadmesh(gunzipSync(file).buffer);
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
