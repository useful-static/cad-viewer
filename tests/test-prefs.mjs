#!/usr/bin/env node
// The remembered choices (js/prefs.js): with storage, without it, and with
// storage that throws on every access (a blocked site).
//   node tests/test-prefs.mjs   -> "RESULT: N passed, 0 failed"

import assert from 'node:assert/strict';
import { getPref, getPrefJSON, setPref, setPrefJSON } from '../js/prefs.js';
import { test, done } from './harness.mjs';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
const withStorage = (s, fn) => {
  const d = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => (s === 'throws' ? (() => { throw new Error('SecurityError'); })() : s) });
  try { fn(); } finally { if (d) Object.defineProperty(globalThis, 'localStorage', d); else delete globalThis.localStorage; }
};

test('a string and a JSON value round-trip; null removes', () => withStorage(memory(), () => {
  setPref('cadv.style', 'wire');
  assert.equal(getPref('cadv.style'), 'wire');
  setPrefJSON('cadv.pic', { w: 2 });
  assert.deepEqual(getPrefJSON('cadv.pic'), { w: 2 });
  setPref('cadv.style', null);
  assert.equal(getPref('cadv.style'), null);
}));
test('a stored value that is not JSON reads as the fallback', () => withStorage(memory(), () => {
  setPref('cadv.pic', '{oops');
  assert.deepEqual(getPrefJSON('cadv.pic', { d: 1 }), { d: 1 });
}));
test('storage that throws on access: reads are null, writes do nothing, nothing throws', () => withStorage('throws', () => {
  assert.equal(getPref('cadv.style'), null);
  assert.equal(getPrefJSON('cadv.pic', 7), 7);
  setPref('cadv.style', 'wire');
  setPrefJSON('cadv.pic', { a: 1 });
}));
test('storage whose methods throw (full, or blocked per call): the same', () => withStorage({ getItem() { throw new Error('x'); }, setItem() { throw new Error('QuotaExceeded'); }, removeItem() { throw new Error('x'); } }, () => {
  assert.equal(getPref('k'), null);
  setPref('k', 'v');
  setPref('k', null);
}));
test('no storage at all (Node): null', () => withStorage(undefined, () => {
  assert.equal(getPref('k'), null);
  setPref('k', 'v');
}));

done();
