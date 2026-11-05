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
import { deflateRawSync, gunzipSync, gzipSync } from 'node:zlib';
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
  assert.deepEqual([writtenSizeLimit({ edgesFailed: { error: 'Out of memory', factsRule: FACTS_RULE } }), writtenSizeLimit({ edgesFailed: { error: 'Invalid array length', factsRule: FACTS_RULE - 1 } }), writtenSizeLimit({})],
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

done();
