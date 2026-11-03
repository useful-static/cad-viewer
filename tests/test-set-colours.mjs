#!/usr/bin/env node
// set-colours.mjs on a small two-body .cadmesh: the colour section takes the
// given colours (RGBA or RGB, alpha written 255), the header gains
// "recolour" and keeps everything else, every other section is the same
// bytes, and a file already recoloured, or colours of the wrong length, or
// no --by, are refused. Also: split-board.mjs's encoder path keeps
// "recolour". No GPU, no network:  node tests/test-set-colours.mjs

import assert from 'node:assert/strict';
import { decodeCadmesh, encodeCadmesh } from '../js/cadmesh.js';
import { setColours } from '../set-colours.mjs';

import { test, done } from './harness.mjs';

const quad = (name, dx) => ({
  name, color: [0.5, 0.5, 0.5], normals: null, colors: null,
  positions: Float32Array.from([dx, 0, 0, dx + 1, 0, 0, dx + 1, 1, 0, dx, 1, 0]),
  indices: Uint32Array.from([0, 1, 2, 0, 2, 3]), faces: Uint32Array.from([0, 2]),
});
const file = () => new Uint8Array(encodeCadmesh({ units: 'millimeter', sourceUnits: 'mm', meshes: [quad('a', 0), quad('b', 2)] }, { edges: true }));
const bytes = (d, s) => new Uint8Array(d[s].buffer, d[s].byteOffset, d[s].byteLength);

test('replaces the colours, keeps every other byte', () => {
  const raw = file();
  const before = decodeCadmesh(raw.slice().buffer);
  const n = before.header.vertexCount;
  const rgba = new Uint8Array(n * 4).map((_, i) => (i * 7) % 256);
  const after = decodeCadmesh(setColours(raw, rgba, 'the test palette').buffer);
  for (let v = 0; v < n; v++) {
    assert.deepEqual([...after.color.subarray(v * 4, v * 4 + 4)], [rgba[v * 4], rgba[v * 4 + 1], rgba[v * 4 + 2], 255]);
  }
  for (const s of ['position', 'normal', 'id', 'index', 'faces', 'edges']) assert.deepEqual(bytes(after, s), bytes(before, s), s);
  const { recolour, meshes, ...rest } = after.header;
  assert.equal(recolour, 'the test palette');
  const { meshes: meshesBefore, ...restBefore } = before.header;
  assert.deepEqual(rest, restBefore);
  // each body's header colour follows its vertices: these vary within a body, so none (it was
  // [0.5, 0.5, 0.5], which the colour picker then showed for a part drawn in other colours)
  assert.deepEqual(meshes.map((m) => m.color), [null, null]);
  assert.deepEqual(meshes.map(({ color, ...m }) => m), meshesBefore.map(({ color, ...m }) => m));
});

test('a body recoloured in one colour has that colour in the header', () => {
  const raw = file();
  const n = decodeCadmesh(raw.slice().buffer).header.vertexCount;
  const rgb = new Uint8Array(n * 3);
  for (let v = 0; v < n; v++) rgb.set(v < n / 2 ? [255, 0, 0] : [0, 0, 255], v * 3);
  const after = decodeCadmesh(setColours(raw, rgb, 'two bodies').buffer);
  assert.deepEqual(after.header.meshes.map((m) => m.color), [[1, 0, 0], [0, 0, 1]]);
});

test('takes RGB too', () => {
  const raw = file();
  const n = decodeCadmesh(raw.slice().buffer).header.vertexCount;
  const after = decodeCadmesh(setColours(raw, new Uint8Array(n * 3).fill(9), 'rgb').buffer);
  assert.deepEqual([...after.color.subarray(0, 4)], [9, 9, 9, 255]);
});

test('refuses a recoloured file, a wrong length, no --by', () => {
  const raw = file();
  const n = decodeCadmesh(raw.slice().buffer).header.vertexCount;
  const once = setColours(raw, new Uint8Array(n * 4), 'first');
  assert.throws(() => setColours(once, new Uint8Array(n * 4), 'second'), /already recoloured \(first\)/);
  assert.equal(decodeCadmesh(setColours(once, new Uint8Array(n * 4), 'second', { again: true }).buffer).header.recolour, 'second');
  assert.throws(() => setColours(raw, new Uint8Array(n * 4 - 1), 'x'), /colour bytes for/);
  assert.throws(() => setColours(raw, new Uint8Array(n * 4), ' '), /--by/);
});

test('the encoder keeps "recolour" (what split-board.mjs writes through)', () => {
  const buf = encodeCadmesh({ units: 'millimeter', recolour: 'a palette', meshes: [quad('a', 0)] }, { edges: false });
  assert.equal(decodeCadmesh(buf).header.recolour, 'a palette');
  const none = encodeCadmesh({ units: 'millimeter', meshes: [quad('a', 0)] }, { edges: false });
  assert.equal(decodeCadmesh(none).header.recolour, undefined);
});

done();
