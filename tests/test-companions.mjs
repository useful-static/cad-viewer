#!/usr/bin/env node
// A model's companion files read to the file limit (js/companions.js readCompanions): the limit
// itself is allowed, a read gone stale gives null. Arms written for round 112's mutation survivors.
//   node tests/test-companions.mjs   -> "RESULT: N passed, 0 failed"

import assert from 'node:assert/strict';
import { companionsOverText, readCompanions } from '../js/companions.js';
import { test, done } from './harness.mjs';

const file = (name, n, onRead = () => {}) => ({ name, size: n, arrayBuffer: async () => { onRead(); return new ArrayBuffer(n); } });

// (r112 M companions-C1) companions of exactly the limit are read; one byte past is refused
await test('companions of exactly the limit are read, one byte over is refused (r112 M companions-C1)', async () => {
  const m = await readCompanions([file('a.mtl', 10)], 'm.obj', () => false, 10);
  assert.deepEqual([...m.keys()], ['a.mtl']);
  assert.equal(m.get('a.mtl').byteLength, 10);
  await assert.rejects(readCompanions([file('a.mtl', 11)], 'm.obj', () => false, 10), { message: companionsOverText('m.obj') });
});
// (r112 M companions-B1) a load that went stale while a companion was read gives null, not the map
await test('a read that goes stale gives null; one that does not gives the map (r112 M companions-B1)', async () => {
  let reads = 0;
  const f = () => file('a.mtl', 4, () => { reads++; });
  assert.equal(await readCompanions([f()], 'm.obj', () => reads > 0, 100), null);
  reads = 0;
  const m = await readCompanions([f()], 'm.obj', () => false, 100);
  assert.deepEqual([...m.keys()], ['a.mtl']);
});

done();
