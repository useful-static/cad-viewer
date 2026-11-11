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
  bytesToId, computeNormals, decodeCadmesh, deflateCadmesh, encodeCadmesh, firstSize, gunzip, idToBytes, inflate, inflateCadmesh,
  isGzip, occtResultToModel, MM, MODEL_FACTS, modelFactsOf, splitCadmesh, withHeader, noSurfaces, bodyLabels, KEEP_WITHOUT_EDGES, refuseWithoutEdges,
  writtenSizeLimit, withoutEdgesFailed, cadmeshToSave,
} from '../js/cadmesh.js';
import { FACTS_RULE } from '../js/edges.js';
import { readMeshFile } from '../js/read-file.js';
import { constants as zlibConstants, deflateRawSync, gunzipSync, gzipSync } from 'node:zlib';
import { test, skip, done } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const align8 = (n) => (n + 7) & ~7;

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

test('MODEL_FACTS is every header key that comes from the model, and modelFactsOf carries them through a rebuild', () => {
  const facts = { units: MM, sourceUnits: 'in', angularDeflection: 0.3, recolour: 'a site' };
  const h = decodeCadmesh(encodeCadmesh({ ...facts, meshes: [quad('a', 0)] })).header;
  // the header's other keys are the geometry's own, computed by encodeCadmesh
  const derived = ['bbox', 'vertexCount', 'indexCount', 'sections', 'meshes', 'root', 'facts', 'factsRule', 'silhouettesOmitted'];
  const fromModel = Object.keys(h).filter((k) => !derived.includes(k)).sort();
  assert.deepEqual(fromModel, [...MODEL_FACTS].sort(), 'a header key that is neither derived nor carried: add it to MODEL_FACTS');
  assert.deepEqual(modelFactsOf(h), facts);
  const again = decodeCadmesh(encodeCadmesh({ ...modelFactsOf(h), meshes: [quad('b', 0)] })).header;
  assert.deepEqual(modelFactsOf(again), facts);
});
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

await test('an edge build that throws: refused by default (a CLI\'s, a generator\'s); kept without edges and facts by the viewer\'s readers, which show the file (r41 A3, r42 A7)', async () => {
  const list = () => { throw new RangeError('Invalid array length'); };
  assert.throws(() => encodeCadmesh({ meshes: [quad('a', 0)] }, { edgeOptions: { list } }), /Invalid array length/, 'the default refuses');
  const m = decodeCadmesh(encodeCadmesh({ meshes: [quad('a', 0)] }, { edgeOptions: { list }, onEdgesError: KEEP_WITHOUT_EDGES }));
  assert.deepEqual([m.header.meshes.length, m.edges ?? null, m.header.facts ?? null], [1, null, null], 'written, the viewer to build them');
  // (the failure written in the header -- a size limit not built again by the viewer: r43 A3)
  // (the error and the facts' rule it was met under; a size limit asked of it when read, by today's
  // rule -- r44 A1, Q2)
  assert.deepEqual(m.header.edgesFailed, { error: 'Invalid array length', factsRule: FACTS_RULE });
  assert.equal(writtenSizeLimit(m.header), true);
  const moment = () => { throw new RangeError('Array buffer allocation failed'); };
  const mh = decodeCadmesh(encodeCadmesh({ meshes: [quad('a', 0)] }, { edgeOptions: { list: moment }, onEdgesError: KEEP_WITHOUT_EDGES })).header;
  assert.deepEqual([mh.edgesFailed.error, writtenSizeLimit(mh)], ['Array buffer allocation failed', false], 'one of the moment: the viewer tries');
  assert.deepEqual([writtenSizeLimit({ edgesFailed: { error: 'Out of memory', factsRule: FACTS_RULE } }), writtenSizeLimit({ edgesFailed: { error: 'Invalid array length', factsRule: 3 } }), writtenSizeLimit({})],
    [false, false, false], 'Safari\'s words, another rule, none');
  const raw = encodeCadmesh({ meshes: [quad('a', 0)] }, { edgeOptions: { list }, onEdgesError: KEEP_WITHOUT_EDGES });
  // (its error not a string: refused by name)
  assert.throws(() => decodeCadmesh(patchHeader(raw.slice(0), '"error":"Invalid array length"', `"error":${'1'.repeat(22)}`)), /edgesFailed is not \{ error, factsRule\? \}/);
  // (never beside facts: no writer makes one -- r44 A1)
  const withFacts = splitCadmesh(encodeCadmesh({ meshes: [quad('a', 0)] }));
  assert.throws(() => withHeader({ ...withFacts.header, edgesFailed: { error: 'x', factsRule: FACTS_RULE } }, withFacts.data), /edgesFailed beside facts/);
  // (Save .cadmesh writes it without the failure, raw or gzipped -- this browser's reading: r44 Q2)
  const saved = splitCadmesh(await withoutEdgesFailed(raw)).header;
  const gz = gzipSync(new Uint8Array(raw)), gzBuf = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
  const savedGz = splitCadmesh(await inflateCadmesh(await withoutEdgesFailed(gzBuf))).header;
  assert.deepEqual([saved.edgesFailed, savedGz.edgesFailed, saved.meshes.length], [undefined, undefined, 1]);
  const plain = encodeCadmesh({ meshes: [quad('a', 0)] });
  assert.equal(await withoutEdgesFailed(plain), plain, 'none: the same buffer');
  // (asked of its header alone: a file whose data is cut short is not decoded to learn it has no
  // record -- r46 Q9; one whose header is not one refused in the decoder's words, not an engine's -- Q8)
  const cutShort = plain.slice(0, plain.byteLength - 8);
  assert.equal(await withoutEdgesFailed(cutShort), cutShort, 'the header alone read');
  const badLen = plain.slice(0); new DataView(badLen).setUint32(8, 0xfffffff0, true);
  await assert.rejects(withoutEdgesFailed(badLen), /^Error: cadmesh/);
  // (a file too short for a header, and one not a .cadmesh: the decoder's refusal, one answer whether
  // its JSON names a record or not -- r47 A8, Q8)
  await assert.rejects(withoutEdgesFailed(plain.slice(0, 8)), /^Error: cadmesh/);
  for (const json of ['{"units":"mm"}', '{"units":"mm","edgesFailed":{"error":"x","factsRule":4}}']) {
    const j = new TextEncoder().encode(json), notOurs = new ArrayBuffer(12 + j.length), dv = new DataView(notOurs);
    dv.setUint32(0, 0x46445025, true); dv.setUint32(4, 99, true); dv.setUint32(8, j.length, true); new Uint8Array(notOurs, 12).set(j);
    await assert.rejects(withoutEdgesFailed(notOurs), /^Error: cadmesh/, json);
  }
  // (the magic ours and the version not, alone -- the arm above changed both, so the version half
  // could not fail: r48 Q6; and a header with no mesh list -- {} or [] -- not taken as one: r48 A6)
  const ver = plain.slice(0); new DataView(ver).setUint32(4, 99, true);
  await assert.rejects(withoutEdgesFailed(ver), /^Error: cadmesh/, 'another version');
  for (const json of ['{}', '[]', '{"sections":{}}', '{"meshes":[]}']) { // (the last: a mesh list without its sections -- r49 A7)
    const j = new TextEncoder().encode(json), b = new ArrayBuffer(12 + j.length), dv = new DataView(b);
    dv.setUint32(0, 0x4d444143, true); dv.setUint32(4, 1, true); dv.setUint32(8, j.length, true); new Uint8Array(b, 12).set(j);
    await assert.rejects(withoutEdgesFailed(b), /^Error: cadmesh/, json);
  }
  // (the bytes Save writes: decoded, without the record, gzipped where it can -- r45 Q9)
  const toSave = await cadmeshToSave(raw);
  assert.deepEqual([isGzip(toSave), decodeCadmesh(await inflateCadmesh(toSave)).header.edgesFailed], [true, undefined]);
  // (round 43's record, { error, sizeLimit }: read, as one of no rule -- built again, not refused: r45 Q6)
  const r43 = withHeader({ ...splitCadmesh(raw).header, edgesFailed: { error: 'Invalid array length', sizeLimit: true } }, splitCadmesh(raw).data);
  assert.equal(writtenSizeLimit(decodeCadmesh(r43).header), false);
  // (the CLIs' refusal: one wording, the input named; both CLIs refuse through it -- r43 A5, A9)
  assert.throws(() => refuseWithoutEdges('board.cadmesh')(new RangeError('Invalid array length')), /^Error: board\.cadmesh: the edges and body facts: Invalid array length$/);
  for (const cli of ['stp2mesh.mjs', 'split-board.mjs']) assert.match(readFileSync(join(HERE, '..', cli), 'utf8'), /encodeCadmesh\(model, \{ edges: [^}]*onEdgesError: refuseWithoutEdges\(/, cli);
  let told = null;
  encodeCadmesh({ meshes: [quad('a', 0)] }, { edgeOptions: { list }, onEdgesError: (e) => { told = e.message; } });
  assert.equal(told, 'Invalid array length');
  // (the read worker's path: a valid STL shown, not refused)
  const stl = new TextEncoder().encode('solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n').buffer;
  const r = await readMeshFile({ buf: stl, format: 'stl', name: 't.stl', extras: null, edgeOptions: { list } });
  assert.equal(decodeCadmesh(r.raw).header.facts ?? null, null, 'read: kept without its facts');
  // (and the STEP worker's: it asks to keep them too)
  assert.match(readFileSync(join(HERE, '..', 'js', 'step-worker.js'), 'utf8'), /encodeCadmesh\(model, \{ onEdgesError: fmt\.KEEP_WITHOUT_EDGES \}\)/);
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

test('decode says a header that is not JSON, or not an object, in its own words (review r16 L10)', () => {
  const withHeader = (text) => {
    const buf = encodeCadmesh({ meshes: [quad('a', 0)] });
    const dv = new DataView(buf);
    const jlen = dv.getUint32(8, true);
    const b = new Uint8Array(buf, 12, jlen);
    b.fill(0x20); // spaces, so the JSON's length is unchanged
    b.set(new TextEncoder().encode(text));
    return buf;
  };
  assert.throws(() => decodeCadmesh(withHeader('null')), /cadmesh: the header is not a cadmesh header/);
  assert.throws(() => decodeCadmesh(withHeader('{"vertexCount": ')), /cadmesh: the header is not JSON/);
});

test('decode rejects a tree that names a mesh out of range (review r5)', () => {
  const root = { name: 'asm', meshes: [], children: [{ name: 'x', meshes: [5], children: [] }] };
  const buf = encodeCadmesh({ meshes: [quad('a', 0), quad('b', 2), quad('c', 4)], root });
  assert.throws(() => decodeCadmesh(buf), /names mesh 5 of 3/);
});

test('decode rejects a tree that names one body twice, in one node or across two (a 3 KB file built a million tree rows)', () => {
  for (const root of [
    { name: 'asm', meshes: [0, 0], children: [] },
    { name: 'asm', meshes: [0], children: [{ name: 'x', meshes: [1, 0], children: [] }] },
  ]) {
    const { header, data } = splitCadmesh(encodeCadmesh({ meshes: [quad('a', 0), quad('b', 2)] }));
    header.root = root;
    assert.throws(() => withHeader(header, data), /names mesh 0 more than once/);
  }
  // a tree naming each body once still decodes
  const { header, data } = splitCadmesh(encodeCadmesh({ meshes: [quad('a', 0), quad('b', 2)] }));
  header.root = { name: 'asm', meshes: [1], children: [{ name: 'x', meshes: [0], children: [] }] };
  assert.equal(decodeCadmesh(withHeader(header, data)).header.root.children[0].meshes[0], 0);
});

test('decode rejects mesh ranges that overlap (3000 meshes on one range cost meshes x indices), fast', () => {
  const { header, data } = splitCadmesh(encodeCadmesh({ meshes: [quad('a', 0), quad('b', 2)] }));
  const m1 = header.meshes[1];
  header.meshes = Array.from({ length: 3000 }, (_, i) => ({ ...(i ? m1 : header.meshes[0]), idxStart: 0, vtxStart: 0, idxCount: 6, vtxCount: 4 }));
  header.root = { name: 'm', meshes: [], children: [] };
  delete header.facts; // (per-mesh facts would not match 3000 meshes)
  const t0 = Date.now();
  assert.throws(() => withHeader(header, data), /mesh 1 range overlaps the mesh before it/);
  assert.ok(Date.now() - t0 < 500);
});
test('decode rejects a mesh or tree node name that is not text, in its own words', () => {
  for (const bad of [5, {}, ['x']]) {
    const { header, data } = splitCadmesh(encodeCadmesh({ meshes: [quad('a', 0)] }));
    header.meshes[0].name = bad;
    assert.throws(() => withHeader(header, data), /mesh 0 name is not text/);
    const h2 = splitCadmesh(encodeCadmesh({ meshes: [quad('a', 0)] }));
    h2.header.root.name = bad;
    assert.throws(() => withHeader(h2.header, h2.data), /assembly tree node name is not text/);
  }
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

test('decode rejects a mesh row with an angularDeflection of its own: a file has one, in its header (r26 A3, Q9)', () => {
  // (a name of 25 letters made room for the field, in place: the same length)
  const buf = encodeCadmesh({ meshes: [quad('x'.repeat(25), 0)] });
  assert.throws(() => decodeCadmesh(patchHeader(buf, `"name":"${'x'.repeat(25)}"`, '"angularDeflection":0.1,"name":"x"')), /mesh 0 has an angularDeflection of its own/);
});
test('decode rejects a body colour that is not 3 or 4 numbers (review r14)', () => {
  const buf = encodeCadmesh({ meshes: [quad('a', 0)] });
  // null -> "rd": the UI mapped it to #rrggbb and threw once the body was selected
  assert.throws(() => decodeCadmesh(patchHeader(buf, '"color":null', '"color":"rd"')), /colour is not 3 or 4 numbers/);
  const ok = encodeCadmesh({ meshes: [{ ...quad('a', 0), color: [1, 0.5, 0] }] });
  assert.deepEqual(decodeCadmesh(ok).header.meshes[0].color, [1, 0.5, 0]);
});

test('decode rejects a body whose triangle names another body\'s vertex (review r15)', () => {
  const buf = encodeCadmesh({ meshes: [quad('a', 0), quad('b', 2)] });
  // body b's first index (absolute 4) pointed at body a's vertex 0
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, new DataView(buf).getUint32(8, true))));
  const dataStart = align8(12 + new DataView(buf).getUint32(8, true));
  new Uint32Array(buf, dataStart + h.sections.index.offset, h.indexCount)[h.meshes[1].idxStart] = 0;
  assert.throws(() => decodeCadmesh(buf), /mesh 1 index 6 names vertex 0, outside its own 4\.\.7/);
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

// (r114 M3 cadmesh-O55) every channel of a per-vertex colour survives encodeCadmesh: a face colour
// with a green (0.2, 0.8, 0.4) over a yellow base (1, 1, 0) decodes as written, its G read from the
// vertex's own G slot (not the vertex before's alpha)
test('occt mapping: a face colour with a green through encodeCadmesh -> decodeCadmesh comes back per channel (r114 M3 cadmesh-O55)', () => {
  const model = occtResultToModel(occt([om('m', [1, 1, 0], [{ first: 1, last: 1, color: [0.2, 0.8, 0.4] }])], { name: 'r', meshes: [0], children: [] }));
  const d = decodeCadmesh(encodeCadmesh(model, { edges: false }));
  const rgba = (v) => [...d.color.slice(4 * v, 4 * v + 4)];
  // triangle 1 is (0, 2, 3): the face's vertices; vertex 1 only in triangle 0, the base
  for (const v of [0, 2, 3]) assert.deepEqual(rgba(v), [51, 204, 102, 255], `vertex ${v}`);
  assert.deepEqual(rgba(1), [255, 255, 0, 255], 'vertex 1');
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

test('occt mapping keeps the b-rep faces; the faces section is in global triangle numbers', () => {
  const root = { name: 'r', meshes: [0, 1], children: [] };
  // mesh b: an unmeshed face (last < first) between two real ones
  const model = occtResultToModel(occt([om('a', null, [{ first: 0, last: 1 }]),
    om('b', null, [{ first: 0, last: 0 }, { first: 1, last: 0 }, { first: 1, last: 1 }])], root));
  const m = decodeCadmesh(encodeCadmesh(model));
  assert.ok(m.faces, 'faces section present');
  assert.deepEqual([...m.faces], [0, 2, 2, 1, 2, 0, 3, 1], 'b starts at triangle 2; the unmeshed face has count 0');
  assert.deepEqual(m.header.meshes.map((x) => [x.faceStart, x.faceCount]), [[0, 1], [1, 3]]);
  assert.equal(m.header.sections.faces.offset % 8, 0);
});

test('a model without faces writes no faces section, and decodes it as null', () => {
  const m = decodeCadmesh(encodeCadmesh({ meshes: [quad('a', 0)] }));
  assert.equal(m.faces, null);
  assert.equal(m.header.sections.faces, undefined);
  assert.equal(m.header.meshes[0].faceStart, undefined);
});

test('decode rejects a face outside its mesh, and a face range outside the section', () => {
  const two = () => ({ meshes: [{ ...quad('a', 0), faces: new Uint32Array([0, 2]) }, { ...quad('b', 2), faces: new Uint32Array([0, 1]) }] });
  assert.doesNotThrow(() => decodeCadmesh(encodeCadmesh(two())));
  const over = two();
  over.meshes[0].faces = new Uint32Array([1, 2]); // triangles 1-2: the second is mesh b's
  assert.throws(() => decodeCadmesh(encodeCadmesh(over)), /face 0 .* outside mesh 0/);
  assert.throws(() => decodeCadmesh(patchHeader(encodeCadmesh(two()), '"faceStart":1,"faceCount":1', '"faceStart":1,"faceCount":2')), /face range is outside/);
});

test('the declared unit and the angular deflection reach the header; absent stays absent', () => {
  const h = decodeCadmesh(encodeCadmesh({ meshes: [quad('a', 0)], sourceUnits: 'in', angularDeflection: 0.5 })).header;
  assert.equal(h.sourceUnits, 'in');
  assert.equal(h.angularDeflection, 0.5);
  assert.equal(h.units, 'millimeter', 'the geometry stays in mm');
  const none = decodeCadmesh(encodeCadmesh({ meshes: [quad('a', 0)], sourceUnits: null })).header;
  assert.equal('sourceUnits' in none, false, 'unknown is absent, never mm');
  assert.throws(() => decodeCadmesh(patchHeader(encodeCadmesh({ meshes: [quad('a', 0)], angularDeflection: 0.5 }),
    '"angularDeflection":0.5', '"angularDeflection":0e0')), /angularDeflection/);
  // (by its one name, as units: another writer's "inch" gave no Auto unit and a scene of "in" and
  // "inch" was "mixed"; a blank one is none, it printed an empty units row -- r93 Q2, Q3)
  const said = (w) => decodeCadmesh(encodeCadmesh({ meshes: [quad('a', 0)], sourceUnits: w })).header.sourceUnits;
  assert.deepEqual(['inch', 'INCH', 'inches', 'foot', 'meter', 'MM', ' in ', 'mixed', 'Mixed', 'MIXED', 'furlong', '  ', ''].map(said),
    ['in', 'in', 'in', 'ft', 'm', 'mm', 'in', 'mixed', 'mixed', 'mixed', 'furlong', undefined, undefined]);
  // (units a string or nothing: a number, a boolean, an object, an array refused -- r94 Q5)
  // (each the length of "mm" with its quotes: patchHeader keeps the header's length)
  const withUnits = (v) => patchHeader(encodeCadmesh({ meshes: [quad('a', 0)], units: 'mm' }), '"units":"mm"', `"units":${v}`);
  for (const v of ['25.4', 'true', '{}  ', '[1] ']) assert.throws(() => decodeCadmesh(withUnits(v)), /units is not a string/, v);
  assert.equal(decodeCadmesh(withUnits('"in"')).header.units, 'in');
});

test('encode builds the edge sections and facts; decode validates them', () => {
  const m = decodeCadmesh(encodeCadmesh({ meshes: [quad('a', 0)] }));
  assert.equal(m.edges.length / 2, 4, 'a quad: four boundary edges');
  assert.equal(m.silhouettes.length, 0);
  assert.equal(m.silhouetteNormals.length, 0);
  assert.deepEqual(m.header.facts.closed, [false]);
  assert.equal(m.header.facts.area[0], 1);
  const none = decodeCadmesh(encodeCadmesh({ meshes: [quad('a', 0)] }, { edges: false }));
  assert.equal(none.edges, null);
  assert.equal(none.header.facts, undefined);
  // an edge past the vertex data, and facts that do not cover every mesh
  const buf = encodeCadmesh({ meshes: [quad('a', 0)] });
  const h = decodeCadmesh(buf).header;
  new Uint32Array(buf, align8(12 + new DataView(buf).getUint32(8, true)) + h.sections.edges.offset, 1)[0] = 99;
  assert.throws(() => decodeCadmesh(buf), /edges entry 0 names vertex 99 of 4/);
  assert.throws(() => decodeCadmesh(patchHeader(encodeCadmesh({ meshes: [quad('a', 0)] }), '"closed":[false]', '"closed":[0]    ')),
    /facts' closed is not one flag per mesh/);
  // (each refusal by the fact's kind: a negative volume -- round 36's -228 -- a flag that is no
  // flag, a rule that is no whole number: r38 Q4)
  // (a file whose header is changed as given, written as the encoder lays it out, not checked)
  const rewrite = (change) => {
    const b = encodeCadmesh({ meshes: [quad('a', 0)] }), dv = new DataView(b), jlen = dv.getUint32(8, true);
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(b, 12, jlen))), data = new Uint8Array(b.slice((12 + jlen + 7) & ~7));
    change(h);
    const json = new TextEncoder().encode(JSON.stringify(h)), start = (12 + json.byteLength + 7) & ~7, out = new ArrayBuffer(start + data.byteLength), ov = new DataView(out);
    ov.setUint32(0, dv.getUint32(0, true), true); ov.setUint32(4, dv.getUint32(4, true), true); ov.setUint32(8, json.byteLength, true);
    new Uint8Array(out, 12, json.byteLength).set(json); new Uint8Array(out, start).set(data);
    return out;
  };
  assert.doesNotThrow(() => decodeCadmesh(rewrite(() => {})), 'the rewrite alone reads back');
  assert.throws(() => decodeCadmesh(rewrite((h) => { h.facts.volume = [-1]; })), /facts' volume is not one number at least 0 per mesh/);
  assert.throws(() => decodeCadmesh(rewrite((h) => { h.facts.net = [1]; })), /facts' net is not one flag per mesh/);
  assert.throws(() => decodeCadmesh(rewrite((h) => { h.factsRule = 4.5; })), /factsRule is not a whole number/);
  // (a fact always written, missing: refused -- skipped, the panel threw on it: r39 Q6)
  assert.throws(() => decodeCadmesh(rewrite((h) => { delete h.facts.area; })), /facts' area is not one number at least 0 per mesh/);
});

test('occt mapping: refuses a failed import', () => {
  assert.throws(() => occtResultToModel({ success: false }), /import failed/);
});

test('stp2mesh unpacks a .stp.gz as the page does: its limit and words, every member (r74 A7: node\'s gunzipSync, no limit -- 2.3 GB in 10 MB took 4.76 GB)', () => {
  const src = readFileSync(join(HERE, '..', 'stp2mesh.mjs'), 'utf8');
  assert.doesNotMatch(src, /gunzipSync\(read\)/, 'must fire: the unlimited unpack');
  assert.match(src, /await gunzip\(read\)/);
  assert.match(src, /import \{[^}]*\bgunzip\b[^}]*\} from '\.\/js\/cadmesh\.js'/);
  // (and every CLI that reads a gzip, its sniff too: none with node's own -- r75 A6)
  for (const cli of ['stp2mesh.mjs', 'dwg-check.mjs', 'set-colours.mjs', 'split-board.mjs']) {
    assert.doesNotMatch(readFileSync(join(HERE, '..', cli), 'utf8'), /gunzipSync\(/, `${cli} (must fire: node's gunzipSync, no limit)`);
  }
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

const sample = () => encodeCadmesh({
  units: 'mm', meshes: [quad('a', 0, [1, 0, 0]), quad('b', 2)], root: { name: 'r', meshes: [0, 1], children: [] },
});

await test('a gzipped file inflates to the same bytes; a raw one passes through untouched', async () => {
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

await test('a gzip that unpacks past the limit stops and says why (review r14)', async () => {
  // 1 MB of zeros gzips to about 1 kB: a cap of 1000 bytes refuses it, the default does not
  const gz = new Uint8Array(gzipSync(Buffer.alloc(1 << 20))).buffer;
  await assert.rejects(gunzip(gz, 1000), /the gzip file is too big: it unpacks to over/);
  assert.equal((await gunzip(gz)).byteLength, 1 << 20);
});

await test('gunzip sizes ONE buffer from the gzip trailer (no chunk list + copy); a lying trailer is refused as corrupt, never wrong bytes (the regrow itself: the arm after)', async () => {
  const data = Buffer.alloc(3 << 20, 7);
  const gz = new Uint8Array(gzipSync(data));
  assert.equal(firstSize(gz.buffer, 'gzip', 2 ** 31), 3 << 20, 'an honest trailer sizes the output exactly');
  assert.equal(firstSize(gz.subarray(0), 'gzip', 2 ** 31), 3 << 20, 'a Uint8Array view reads the same trailer');
  for (const lie of [1, 100, 0xffffffff]) {
    const g = gz.slice();
    new DataView(g.buffer).setUint32(g.length - 4, lie, true);
    // (the decompressor checks ISIZE at the end: Node's refuses every lie as corrupt -- where a
    // browser's did not, the true bytes would come back; never a wrong answer)
    await assert.rejects(gunzip(g.buffer), /corrupt or truncated/, `trailer ${lie}`);
  }
  // a 20-byte file claiming 4 GB allocates what deflate could make of 20 bytes, not 2 GB
  const tiny = new Uint8Array(20); tiny.set([0x1f, 0x8b]); new DataView(tiny.buffer).setUint32(16, 0xffffffff, true);
  assert.ok(firstSize(tiny.buffer, 'gzip', 2 ** 31) < 64 * 1024);
});

await test('inflate regrows its one buffer when the data runs past its first size, and returns the bytes', async () => {
  // a zip entry's deflate-raw data carries no size: the buffer starts at 4x the input, and
  // 3 MB of a repeating pattern deflates to a few KB, so it doubles many times on the way
  const data = Buffer.alloc(3 << 20);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 12)) & 0xff;
  const raw = new Uint8Array(deflateRawSync(data));
  assert.ok(4 * raw.length < data.length, 'the first size is too small: a regrow is forced');
  const out = Buffer.from(await inflate(raw.buffer, 'deflate-raw'));
  assert.ok(out.equals(data), 'the bytes after the regrows');
});

await test('a truncated gzip file is refused with a cadmesh error, not decoded', async () => {
  const gz = await deflateCadmesh(sample());
  await assert.rejects(inflateCadmesh(gz.slice(0, gz.byteLength >> 1)), /cadmesh: the gzip data is corrupt or truncated/);
  assert.equal(isGzip(new ArrayBuffer(1)), false, 'a 1-byte buffer is not gzip');
});

await test('gunzip unpacks any gzip file (a part.stp.gz) to the bytes inside', async () => {
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
      assert.ok(m.faces && m.edges && m.edges.length > 0, 'faces and edges sections');
      assert.equal(m.header.facts.closed.length, m.header.meshes.length, 'one fact per body');
      assert.match(log, /\nedges: \d+ boundary/);
      writeFileSync(join(dir, 'ok'), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
} else {
  skip('stp2mesh conversion', 'needs fetch-deps.sh + CADV_STEP_FIXTURE=<file.stp>');
}

await test('noSurfaces: the one refusal for the page and stp2mesh; bodyLabels: owner › body', () => {
  assert.equal(noSurfaces(3, 'a.stp'), null);
  assert.match(noSurfaces(0, 'a.stp'), /^a\.stp has no surfaces to show: it holds no faces/);
  assert.match(noSurfaces(0, 'a.stp', 7), /^none of the 7 faces of a\.stp could be meshed/);
  const h = { meshes: [{ name: 'COMPONENT1' }, { name: 'BOARD' }, { name: 'loose' }], root: { name: '', meshes: [2], children: [{ name: 'BOARD', meshes: [0, 1], children: [] }] } };
  assert.deepEqual(bodyLabels(h), ['BOARD › COMPONENT1', 'BOARD', 'loose']);
});
await test('dwg-check refuses an option it does not know, and --dxf with no file (exit 2)', () => {
  const cli = join(HERE, '..', 'dwg-check.mjs');
  // (and no DWG at all, and --dxf with two: each overwrote the one file)
  for (const args of [['x.dwg', '--jsn'], ['x.dwg', '--dxf'], ['--json'], ['a.dwg', 'b.dwg', '--dxf', 'o.dxf']]) {
    let status = 0;
    try { execFileSync(process.execPath, [cli, ...args], { stdio: 'pipe' }); } catch (e) { status = e.status; }
    assert.equal(status, 2, args.join(' '));
  }
});
await test('a .cadmesh with a coordinate past 10^15 is refused as the mesh readers refuse it (it decoded at 1e20)', () => {
  const q = quad('far', 0);
  q.positions[0] = 1e20;
  assert.throws(() => decodeCadmesh(encodeCadmesh({ units: 'millimeter', meshes: [q] })), /too large to show \(a coordinate past 10\^15 mm\)/);
  assert.ok(decodeCadmesh(encodeCadmesh({ units: 'millimeter', meshes: [quad('near', 1e6)] })));
  // a stored box past the bound over in-range positions (the view frames by it): refused alike
  const { header, data } = splitCadmesh(encodeCadmesh({ units: 'millimeter', meshes: [quad('box', 0)] }));
  assert.throws(() => withHeader({ ...header, bbox: { min: [-1e38, 0, 0], max: [1e38, 1, 0] } }, data), /too large to show \(a coordinate past 10\^15 mm\)/);
});
await test('a gzip of several members is read whole, member after member, where the browser\'s stream stops after the first (r73 Q1, Q3)', async () => {
  // (Chromium's DecompressionStream('gzip') refuses what follows the first member, "Junk found after
  // end of compressed data"; node's reads every member. A stand-in that stops as Chromium does: its
  // first member's bytes, then that error)
  const real = globalThis.DecompressionStream;
  class FirstMemberOnly {
    constructor(format) {
      if (format !== 'gzip') return new real(format);
      let all = Buffer.alloc(0);
      const t = new TransformStream({
        transform(c) { all = Buffer.concat([all, Buffer.from(c)]); },
        flush(ctl) {
          for (let L = 18; L <= all.length; L++) {
            let out;
            try { out = gunzipSync(all.subarray(0, L)); } catch { continue; }
            // (the first prefix that unpacks is the first member: node reads one member there. With
            // junk after it, Chromium drops output it had queued: 131,072 of a 200,000-byte member
            // came -- given here as half -- r74 Q3)
            if (L < all.length) { ctl.enqueue(new Uint8Array(out.subarray(0, out.length >> 1))); throw new TypeError('Junk found after end of compressed data.'); }
            ctl.enqueue(new Uint8Array(out));
            return;
          }
          throw new TypeError('incorrect header check');
        },
      });
      this.readable = t.readable; this.writable = t.writable;
    }
  }
  globalThis.DecompressionStream = FirstMemberOnly;
  try {
    const a = Buffer.from('solid x\n'.repeat(50)), b = Buffer.from('facet normal 0 0 1\n'.repeat(80)), c = Buffer.from('endsolid x\n');
    const members = Buffer.concat([gzipSync(a), gzipSync(b), gzipSync(c)]);
    const got = Buffer.from(await gunzip(members));
    assert.ok(got.equals(Buffer.concat([a, b, c])), `${got.length} bytes of ${a.length + b.length + c.length} (must fire: "corrupt or truncated (Junk found…)")`);
    // (inflateCount's chunks each byte once, a member read again handing its start over twice: r81 A11
    // -- must fire, a's first half twice)
    const { inflateCount } = await import('../js/cadmesh.js');
    const seen = [];
    await inflateCount(members, 'gzip', undefined, (v) => seen.push(Buffer.from(v)));
    assert.ok(Buffer.concat(seen).equals(Buffer.concat([a, b, c])), `${Buffer.concat(seen).length} bytes handed on`);
    // (r74 A2: an empty member, and a one-byte one, in the middle -- their trailers 12 and 13 bytes in;
    // looked for from 18, passed over, the file refused)
    for (const mid of [Buffer.alloc(0), Buffer.from('x')]) {
      const m3 = Buffer.concat([gzipSync(a), gzipSync(mid), gzipSync(c)]);
      const g3 = Buffer.from(await gunzip(m3));
      assert.ok(g3.equals(Buffer.concat([a, mid, c])), `a ${mid.length}-byte member between (must fire: "corrupt or truncated")`);
    }
    // (r75 A5: fake gzip headers after a member, each with a trailer of its size: refused after a few
    // tries, not one re-read of the member each -- here counted by the streams opened)
    {
      // (a 1 MB member, as the review's: each try inflates it again -- bounded by the output inflated
      // again, 64 MB and twice what came before: r76 A7)
      const m = gzipSync(Buffer.alloc(1 << 20, 0x41));
      const fake = Buffer.alloc(12); fake.writeUInt32LE(1 << 20, 0); fake.set([0x1f, 0x8b, 8], 4);
      const crafted = Buffer.concat([m, ...Array.from({ length: 400 }, () => fake)]);
      let opened = 0;
      const Counted = class { constructor(f) { opened++; return new FirstMemberOnly(f); } };
      globalThis.DecompressionStream = Counted;
      await assert.rejects(gunzip(crafted), /corrupt or truncated/);
      globalThis.DecompressionStream = FirstMemberOnly;
      assert.ok(opened <= 200, `${opened} streams opened (must fire: 401; the output read again is bounded, 64 MB here)`);
    }
    // (r75 Q1, Q5: Chromium hands on 131,072 bytes of a member before "Junk found", whatever its size
    // -- the stand-in above kept half, which hid it. A stand-in that knows the members' ends: a 6 MB
    // first member, 131,072 of it given when junk follows (must fire: refused, the 4 MB bound))
    {
      const big = Buffer.alloc(6 * 2 ** 20, 0x41), tail = Buffer.from('endsolid x\n');
      const m1 = gzipSync(big), m2 = gzipSync(tail);
      let all = Buffer.concat([m1, m2]), ends = [m1.length, all.length];
      class Chromium {
        constructor(format) {
          if (format !== 'gzip') return new real(format);
          let got = Buffer.alloc(0);
          const t = new TransformStream({
            transform(c) { got = Buffer.concat([got, Buffer.from(c)]); },
            flush(ctl) {
              // (where its bytes start in the file: a member read again on its own is no suffix)
              const off = all.indexOf(got), end = ends.find((e) => e > off);
              if (off < 0 || end === undefined) throw new TypeError('incorrect header check');
              const out = gunzipSync(all.subarray(off, end));
              if (got.length > end - off) { ctl.enqueue(new Uint8Array(out.subarray(0, 131072))); throw new TypeError('Junk found after end of compressed data.'); }
              if (got.length < end - off) throw new TypeError('unexpected end of file');
              ctl.enqueue(new Uint8Array(out));
            },
          });
          this.readable = t.readable; this.writable = t.writable;
        }
      }
      globalThis.DecompressionStream = Chromium;
      const g = Buffer.from(await gunzip(all));
      globalThis.DecompressionStream = FirstMemberOnly;
      assert.equal(g.length, big.length + tail.length, 'a 6 MB first member');
      // (r76 A7: a valid first member holding 20 runs that look like a trailer of about its size and a
      // gzip header -- stored, level 0, so they are in the compressed bytes. Refused by a count of 16
      // tries (must fire); opened by the bytes read again bounded)
      const run = Buffer.alloc(7); run.writeUInt32LE(200000, 0); run.set([0x1f, 0x8b, 8], 4);
      const body = Buffer.concat(Array.from({ length: 20 }, () => Buffer.concat([Buffer.alloc(10000, 0x42), run])));
      const s1 = gzipSync(body, { level: 0 });
      all = Buffer.concat([s1, m2]); ends = [s1.length, all.length];
      globalThis.DecompressionStream = Chromium;
      const g2 = Buffer.from(await gunzip(all));
      globalThis.DecompressionStream = FirstMemberOnly;
      assert.equal(g2.length, body.length + tail.length, 'a member holding 20 chance headers');
    }
    // (r76 Q1: a 100 MB first member with one chance header 90 MB in, its trailer-shaped bytes near the
    // member's size. Its try reads 90 MB again and fails; the real end comes after. A budget from what
    // came before the member alone, 64 MB, stopped there and refused the file (must fire). The
    // stand-in is fed in pieces, as the page writes: when junk follows, it drops one piece's output
    // at most, as Chromium does)
    {
      const MB = 2 ** 20, body = Buffer.alloc(100 * MB, 0x37), tail = Buffer.from('endsolid x\n');
      const run = Buffer.alloc(7); run.writeUInt32LE(100 * MB - 1000, 0); run.set([0x1f, 0x8b, 8], 4);
      run.copy(body, 90 * MB + 123);
      const s1 = gzipSync(body, { level: 0 }), s2 = gzipSync(tail);
      const all = Buffer.concat([s1, s2]), ends = [s1.length, all.length];
      assert.ok(s1.indexOf(run) > 0, 'the planted header is in the compressed bytes');
      class Fed {
        constructor(format) {
          if (format !== 'gzip') return new real(format);
          const parts = [];
          const t = new TransformStream({
            transform(c) { parts.push(Buffer.from(c)); },
            flush(ctl) {
              const got = Buffer.concat(parts);
              const off = [0, ...ends].find((o) => o < all.length && all.subarray(o, o + 64).equals(got.subarray(0, 64)));
              const end = off === undefined ? undefined : ends.find((e) => e > off);
              if (end === undefined) throw new TypeError('incorrect header check');
              // (cut short: what it inflated handed on, then the error -- as Chromium does, and what makes a
              // wrong try cost the bytes read again)
              if (got.length < end - off) { ctl.enqueue(new Uint8Array(gunzipSync(got, { finishFlush: zlibConstants.Z_SYNC_FLUSH }))); throw new TypeError('unexpected end of file'); }
              const out = gunzipSync(all.subarray(off, end));
              if (got.length > end - off) { ctl.enqueue(new Uint8Array(out.subarray(0, Math.max(0, out.length - 65536)))); throw new TypeError('Junk found after end of compressed data.'); }
              ctl.enqueue(new Uint8Array(out));
            },
          });
          this.readable = t.readable; this.writable = t.writable;
        }
      }
      globalThis.DecompressionStream = Fed;
      let g3;
      try { g3 = await gunzip(all); } finally { globalThis.DecompressionStream = FirstMemberOnly; }
      assert.equal(g3.byteLength, body.length + tail.length, 'a 100 MB member with a chance header 90 MB in (must fire: "corrupt or truncated")');
    }
    // (r77 Q1: Chromium stops after every member, and each stream was handed the whole rest of the file
    // at once -- a bgzip's cost the square of its members, 12,852 of them 126 s on the page thread. A
    // stand-in that stops as soon as a piece runs past its member's end, counting the writes it is handed:
    // a piece is written once the one before is taken, and none after the stream stopped)
    {
      const ms = Array.from({ length: 120 }, (_, i) => gzipSync(Buffer.alloc(70000, i), { level: 0 }));
      const all = Buffer.concat(ms), starts = [], ends = [];
      for (let o = 0, i = 0; i < ms.length; o += ms[i].length, i++) { starts.push(o); ends.push(o + ms[i].length); }
      let writes = 0;
      class Stops {
        constructor(format) {
          if (format !== 'gzip') return new real(format);
          let got = Buffer.alloc(0), k = -1;
          const t = new TransformStream({
            transform(c, ctl) {
              got = Buffer.concat([got, Buffer.from(c)]);
              if (k < 0) k = starts.findIndex((o) => all.subarray(o, o + 64).equals(got.subarray(0, 64)));
              if (k < 0) throw new TypeError('incorrect header check');
              if (got.length > ends[k] - starts[k]) { ctl.enqueue(new Uint8Array(gunzipSync(ms[k]))); throw new TypeError('Junk found after end of compressed data.'); }
            },
            flush(ctl) {
              if (got.length !== ends[k] - starts[k]) throw new TypeError('unexpected end of file');
              ctl.enqueue(new Uint8Array(gunzipSync(ms[k])));
            },
          });
          this.readable = t.readable;
          this.writable = { getWriter: () => { const w = t.writable.getWriter(); return { write: (c) => { writes++; return w.write(c); }, close: () => w.close(), get ready() { return w.ready; } }; } };
        }
      }
      globalThis.DecompressionStream = Stops;
      let g;
      try { g = await gunzip(all); } finally { globalThis.DecompressionStream = FirstMemberOnly; }
      assert.equal(g.byteLength, 120 * 70000, 'every member');
      assert.ok(writes <= 4 * ms.length, `${writes} pieces written for ${ms.length} members (must fire: about 7,700, the rest of the file each)`);
    }
    // (r78 Q1: many tiny members -- much work, little output -- turn the thread by the time too, and ask
    // the caller's stop there: 65,539 of 64 bytes held the page 87 s, stop() never asked. A stand-in
    // that stops at each member's end, as Chromium does; must fire: asked 0 times, read to the end)
    {
      const { StopRead } = await import('../js/cadmesh.js');
      const ms = Array.from({ length: 10000 }, (_, i) => { const b = Buffer.alloc(40, 0x20); b.writeUInt32LE(i, 0); return gzipSync(b, { level: 0 }); });
      const all = Buffer.concat(ms), at = new Map();
      for (let o = 0, i = 0; i < ms.length; o += ms[i].length, i++) at.set(all.subarray(o, o + 24).toString('hex'), i);
      // (each stream costing a tenth of a millisecond, as one does in Chromium, so the read takes time
      // enough for the turns to be told apart from one turn: r79 Q3)
      const spin = (ms) => { const t = performance.now(); while (performance.now() - t < ms); };
      class Tiny {
        constructor(format) {
          if (format !== 'gzip') return new real(format);
          spin(0.1);
          let got = Buffer.alloc(0), k;
          const t = new TransformStream({
            transform(c, ctl) {
              got = Buffer.concat([got, Buffer.from(c)]);
              if (k === undefined) k = at.get(got.subarray(0, 24).toString('hex'));
              if (k === undefined) throw new TypeError('incorrect header check');
              if (got.length > ms[k].length) { ctl.enqueue(new Uint8Array(gunzipSync(ms[k]))); throw new TypeError('Junk found after end of compressed data.'); }
            },
            flush(ctl) { if (got.length !== ms[k].length) throw new TypeError('unexpected end of file'); ctl.enqueue(new Uint8Array(gunzipSync(ms[k]))); },
          });
          this.readable = t.readable; this.writable = t.writable;
        }
      }
      globalThis.DecompressionStream = Tiny;
      let asked = 0, g;
      // (and asked all along, not once: the longest stretch with no ask under 500 ms -- r79 Q3, a turn
      // once and never again passed "at least once")
      const times = [Date.now()];
      try {
        g = await gunzip(all, undefined, () => { asked++; times.push(Date.now()); return false; });
        times.push(Date.now());
        assert.equal(g.byteLength, 10000 * 40, 'every member');
        assert.ok(asked >= 1, `stop asked ${asked} times over 10,000 tiny members`);
        const gap = Math.max(...times.slice(1).map((t, i) => t - times[i]));
        assert.ok(gap < 500, `${gap} ms with no ask, of ${times[times.length - 1] - times[0]} ms`);
        await assert.rejects(gunzip(all, undefined, () => true), (e) => e instanceof StopRead);
      } finally { globalThis.DecompressionStream = FirstMemberOnly; }
    }
    // (r80 Q5: a valid member holding 300 header-like runs, each a trailer of about its size and a
    // header, then a second member. A stand-in that stops at the member's end as the pieces cross it,
    // as Chromium does, and hands on what it inflated when cut short: every run tried, from the
    // member's start, ran out the budget and refused the file (must fire); searched from the piece it
    // stopped in, it opens)
    {
      const M = 2 * 2 ** 20, body = Buffer.alloc(M, 0x20);
      for (let i = 0; i < 300; i++) { const at = 4096 + i * Math.floor((M - 8192) / 300); body.writeUInt32LE(M + 1000, at); body[at + 4] = 0x1f; body[at + 5] = 0x8b; body[at + 6] = 8; }
      const m1 = gzipSync(body, { level: 0 }), m2 = gzipSync(Buffer.from('tail\n')), all = Buffer.concat([m1, m2]);
      class Crossing {
        constructor(format) {
          if (format !== 'gzip') return new real(format);
          let got = Buffer.alloc(0), first = null;
          const t = new TransformStream({
            transform(c, ctl) {
              got = Buffer.concat([got, Buffer.from(c)]);
              if (first === null) first = got.subarray(0, 16).equals(m2.subarray(0, 16)) ? m2 : m1;
              if (got.length > first.length) { ctl.enqueue(new Uint8Array(gunzipSync(first))); throw new TypeError('Junk found after end of compressed data.'); }
            },
            flush(ctl) {
              if (got.length < first.length) { ctl.enqueue(new Uint8Array(gunzipSync(got, { finishFlush: zlibConstants.Z_SYNC_FLUSH }))); throw new TypeError('unexpected end of file'); }
              ctl.enqueue(new Uint8Array(gunzipSync(first)));
            },
          });
          this.readable = t.readable; this.writable = t.writable;
        }
      }
      globalThis.DecompressionStream = Crossing;
      let g;
      try { g = await gunzip(all); } finally { globalThis.DecompressionStream = FirstMemberOnly; }
      assert.equal(g.byteLength, M + 5, 'a member holding 300 header-like runs, and the next (must fire: "corrupt or truncated")');
    }
    // (r79 Q1: a member corrupt at its first byte, then copies of a header with a trailer of size 0
    // before each: every one a try at the member's end, each inflating nothing and charged nothing --
    // 700 KB held Chromium 250 s. A try that fails is charged a piece: must fire, 20,000 streams)
    {
      const head = [0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff, 0x07, 0x00], rec = [0, 0, 0, 0, 0x1f, 0x8b, 0x08];
      const crafted = new Uint8Array(head.length + 20000 * rec.length);
      crafted.set(head, 0);
      for (let i = 0; i < 20000; i++) crafted.set(rec, head.length + i * rec.length);
      let opened = 0;
      const spin = (ms) => { const t = performance.now(); while (performance.now() - t < ms); };
      class Broken {
        constructor(format) {
          if (format !== 'gzip') return new real(format);
          opened++;
          spin(1); // (a stream's cost, as in Chromium: the tries take time enough to need turns)
          const t = new TransformStream({ transform() { throw new TypeError('invalid block type'); } });
          this.readable = t.readable; this.writable = t.writable;
        }
      }
      globalThis.DecompressionStream = Broken;
      // (and the thread turned, the stop asked, among the tries: under 500 ms with no ask -- must fire,
      // no turn in the try loop, Cancel waiting)
      const times = [Date.now()];
      try { await assert.rejects(gunzip(crafted, undefined, () => { times.push(Date.now()); return false; }), /corrupt or truncated/); } finally { globalThis.DecompressionStream = FirstMemberOnly; }
      times.push(Date.now());
      assert.ok(opened <= 1100, `${opened} streams opened (the budget, 64 MB, at a piece a failed try)`);
      const gap = Math.max(...times.slice(1).map((t, i) => t - times[i]));
      assert.ok(gap < 500, `${gap} ms with no ask among the tries, of ${times[times.length - 1] - times[0]} ms`);
    }
    // must reject still: junk that is no member after the first
    await assert.rejects(gunzip(Buffer.concat([gzipSync(a), Buffer.from('not a gzip member at all')])), /the gzip data is corrupt or truncated \(Junk found after end of compressed data\.\)/);
  } finally {
    globalThis.DecompressionStream = real;
  }
});

await test('an unpack gives the thread a turn every 32 MB out, and its caller\'s stop ends it there (r77 Q3: an 800 MB gzip held the page 3.9 s, Cancel waiting)', async () => {
  const { StopRead } = await import('../js/cadmesh.js');
  const gz = gzipSync(Buffer.alloc(100 * 2 ** 20));
  let asked = 0;
  const out = await gunzip(gz, undefined, () => { asked++; return false; });
  assert.equal(out.byteLength, 100 * 2 ** 20);
  // (at least one a 32 MB; the turns by the time, r78 Q1, may add more)
  assert.ok(asked >= 3, `asked ${asked} times in 100 MB (must fire: 0, no turn)`);
  await assert.rejects(gunzip(gz, undefined, () => true), (e) => e instanceof StopRead);
  // (r78 A6: and the page's other unpacks, a .cadmesh.gz's and a zip entry's, take the same stop --
  // must fire: each read whole, Cancel waiting)
  await assert.rejects(inflateCadmesh(gz, () => true), (e) => e instanceof StopRead);
  const { unzip } = await import('../js/mesh-formats.js');
  const d = deflateRawSync(Buffer.alloc(100 * 2 ** 20)), nm = Buffer.from('m.stl');
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(100 * 2 ** 20, 22); lh.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(d.length, 20); cd.writeUInt32LE(100 * 2 ** 20, 24); cd.writeUInt16LE(nm.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + nm.length, 12); end.writeUInt32LE(30 + nm.length + d.length, 16);
  const zip = Buffer.concat([lh, nm, d, cd, nm, end]);
  const z = await unzip(new Uint8Array(zip).buffer, () => true);
  await assert.rejects(z.get('m.stl'), (e) => e instanceof StopRead);
  // (and with a limit of its own, a 3MF part's read)
  await assert.rejects(z.get('m.stl', 200 * 2 ** 20, (s) => new Error(s)), (e) => e instanceof StopRead);
  // (r79 A7: a read to a budget -- main.js loadZip's companions, each to what the ones before leave --
  // refused in the caller's words past it, before inflating where the directory says so, else as it
  // inflates: must fire, the 100 MB inflated whole)
  const z2 = await unzip(new Uint8Array(zip).buffer);
  await assert.rejects(z2.get('m.stl', 50 * 2 ** 20, () => new Error('companions over')), /^Error: companions over$/);
  cd.writeUInt32LE(1024, 24); // (its claim understated: met as it inflates)
  const z3 = await unzip(new Uint8Array(Buffer.concat([lh, nm, d, cd, nm, end])).buffer);
  await assert.rejects(z3.get('m.stl', 50 * 2 ** 20, () => new Error('companions over')), /^Error: companions over$/);
  // (r79 Q2: an entry that inflates to other than its directory's size is a damaged zip, the list
  // check's words too -- must fire, the 100 MB handed on as if 1 KB)
  await assert.rejects(z3.get('m.stl'), /^Error: a damaged zip \(m\.stl unpacks to 104,857,600 bytes, where its directory says 1,024\)$/);
});

await test('inflateHead: nothing out is an empty view, a read it cannot make null (r78 A5)', async () => {
  const { inflateHead } = await import('../js/cadmesh.js');
  const empty = await inflateHead(gzipSync(Buffer.alloc(0)), 64);
  assert.ok(empty instanceof Uint8Array && empty.length === 0, `${empty} (must fire: null, "could not be read")`);
  assert.deepEqual([...(await inflateHead(gzipSync(Buffer.from('abc')), 64))], [97, 98, 99]);
});

// (r112 M cadmesh-B36) in a corrupt member, a header-like run is tried as the member's end only
// when the isize before it fits what came: one of isize 0 is tried (the read gets its 1,004 bytes
// before it), one of isize ffffffff is not
await test('inflateHead tries a false gzip header as a member end only when its isize fits (r112 M cadmesh-B36)', async () => {
  const { inflateHead } = await import('../js/cadmesh.js');
  const corrupt = (isize) => {
    const data = Buffer.concat([Buffer.alloc(1000, 0x41), Buffer.from([...isize, 0x1f, 0x8b, 0x08]), Buffer.alloc(5000, 0x42)]);
    const z = new Uint8Array(gzipSync(data, { level: 0 }));
    z[z.length - 8] ^= 0xff; // (its CRC wrong: the stream stops at the member's end)
    return z;
  };
  const fits = await inflateHead(corrupt([0, 0, 0, 0]), 1e6), past = await inflateHead(corrupt([0xff, 0xff, 0xff, 0xff]), 1e6);
  assert.deepEqual([fits && fits.length, past && past.length], [1004, 0]);
});
// (r112 M cadmesh-O225) each b-rep face's triangles must lie inside its own mesh: a face past
// its mesh's last triangle is refused, by the face's count as well as its start
test('decodeCadmesh refuses a b-rep face that runs past its mesh\'s triangles (r112 M cadmesh-O225)', () => {
  const mk = () => occtResultToModel(occt([om('a', null, [{ first: 0, last: 1 }]), om('b', null, [{ first: 0, last: 0 }, { first: 1, last: 0 }, { first: 1, last: 1 }])], { name: 'r', meshes: [0, 1], children: [] }));
  assert.deepEqual([...decodeCadmesh(encodeCadmesh(mk())).faces], [0, 2, 2, 1, 2, 0, 3, 1]);
  const bad = mk();
  bad.meshes[1].faces = Uint32Array.from([0, 1, 1, 0, 5, 1]);
  assert.throws(() => decodeCadmesh(encodeCadmesh(bad)), { message: 'cadmesh: face 3 (triangles 7 + 1) is outside mesh 1' });
});

// a unitless STL of one triangle, as text
const stlOf = (a, b, c) => new TextEncoder().encode(`solid t\nfacet normal 0 0 1\nouter loop\nvertex ${a}\nvertex ${b}\nvertex ${c}\nendloop\nendfacet\nendsolid t\n`).buffer;
// (r112 M read-file-B0, read-file-C0, read-file-O0, read-file-B2) a unitless file read in inches is
// scaled to mm, every coordinate, and says it was read in inches; read in mm it is as it came
await test('a unitless STL read in inches is scaled to mm, every coordinate, and says "in" (r112 M read-file-B0, read-file-C0, read-file-O0, read-file-B2)', async () => {
  const read = async (unit) => {
    const r = await readMeshFile({ buf: stlOf('1 2 3', '4 5 6', '7 8 10'), format: 'stl', name: 't.stl', unit, edges: false });
    const d = decodeCadmesh(r.raw);
    return { unitless: r.unitless, position: Array.from(d.position).map((x) => Math.round(x * 1000) / 1000), units: d.header.sourceUnits ?? null };
  };
  assert.deepEqual(await read('in'), { unitless: true, position: [25.4, 50.8, 76.2, 101.6, 127, 152.4, 177.8, 203.2, 254], units: 'in' });
  assert.deepEqual(await read('mm'), { unitless: true, position: [1, 2, 3, 4, 5, 6, 7, 8, 10], units: 'mm' });
});
// (r112 M read-file-B1, read-file-C2) a coordinate scaled past the limit is refused in the reader's
// words; an ordinary one is not
await test('a unitless STL scaled past the coordinate limit is refused, an ordinary one read (r112 M read-file-B1, read-file-C2)', async () => {
  await assert.rejects(readMeshFile({ buf: stlOf('0 0 0', '1e14 0 0', '0 1 0'), format: 'stl', name: 'big.stl', unit: 'in', edges: false }),
    { message: 'big.stl is too large to show in in (a coordinate past 10^15 mm)' });
  const r = await readMeshFile({ buf: stlOf('0 0 0', '1 0 0', '0 1 0'), format: 'stl', name: 't.stl', unit: 'in', edges: false });
  assert.ok(r.raw.byteLength > 0);
});

// (r112 M xml-walk-B3) a tag whose attributes the walker cannot read is passed over, the next read
await test('xmlWalk passes over a tag it cannot read and reads the next (r112 M xml-walk-B3)', async () => {
  const { xmlWalk } = await import('../js/xml-walk.js');
  const seen = [];
  xmlWalk('<build><item objectid=1 /><item objectid="2"/></build>', ['item'], (t) => { seen.push(`${t.tag}:${t.attrs.objectid}`); });
  assert.deepEqual(seen, ['item:2']);
});
// (r112 M zip-dir-C2, zip-dir-C7) an empty zip -- its end record alone, at offset 0, its central
// directory at 0 -- is a zip of no entries
await test('an empty zip (only its 22-byte end record) is a zip of no entries (r112 M zip-dir-C2, zip-dir-C7)', async () => {
  const { zipDirectory } = await import('../js/zip-dir.js');
  const { unzip } = await import('../js/mesh-formats.js');
  const empty = new Uint8Array(22);
  new DataView(empty.buffer).setUint32(0, 0x06054b50, true);
  assert.equal((await zipDirectory(empty, 0, 22)).length, 0);
  assert.deepEqual((await unzip(empty.buffer)).names, []);
  await assert.rejects(zipDirectory(new Uint8Array(22), 0, 22), /not a zip file/);
});

done();
