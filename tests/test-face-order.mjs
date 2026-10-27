#!/usr/bin/env node
// The faces' draw order (js/face-order.js): solids first, sheets last.
//   node tests/test-face-order.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { BIAS_SHEET, BIAS_SOLID, sheetsLast } from '../js/face-order.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

const index = Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const body = (idxStart, idxCount, kind) => ({ idxStart, idxCount, kind });

test('sheets move after the solids, each body kept whole and in order', () => {
  const r = sheetsLast(index, [body(0, 3, 'closed'), body(3, 3, 'sheet'), body(6, 3, 'open'), body(9, 3, 'sheet')]);
  assert.deepEqual([...r.index], [0, 1, 2, 6, 7, 8, 3, 4, 5, 9, 10, 11]);
  assert.equal(r.split, 6);
  assert.ok(r.index instanceof Uint32Array);
  assert.deepEqual([...index], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'the model\'s own index is untouched');
});
test('no sheets, or no kinds: the same index, one group', () => {
  for (const meshes of [[body(0, 6, 'closed'), body(6, 6, 'open')], [body(0, 6), body(6, 6)], [], null]) {
    const r = sheetsLast(index, meshes);
    assert.equal(r.index, index);
    assert.equal(r.split, 12);
  }
});
test('ranges that do not cover the index: left as it is', () => {
  for (const meshes of [[body(0, 3, 'sheet'), body(3, 3, 'closed')], [body(0, 6, 'sheet'), body(6, 9, 'closed')],
    [body(0, 6, 'sheet'), body(6, 3, 'closed'), body(6, 3, 'closed')], [body(-3, 15, 'sheet')]]) {
    const r = sheetsLast(index, meshes);
    assert.equal(r.index, index);
    assert.equal(r.split, 12);
  }
});
test('all sheets: split at 0', () => {
  const r = sheetsLast(index, [body(0, 12, 'sheet')]);
  assert.equal(r.split, 0);
  assert.deepEqual([...r.index], [...index]);
});
test('solids sit further back than sheets', () => {
  assert.ok(BIAS_SOLID[0] > BIAS_SHEET[0] && BIAS_SOLID[1] >= BIAS_SHEET[1], 'the gap is in the slope factor');
  assert.ok(BIAS_SHEET[0] > 0 && BIAS_SHEET[1] > 0, 'sheets stay behind their own edges');
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
