#!/usr/bin/env node
// The sRGB transfer (js/srgb.js): a linear colour to sRGB takes the three colour channels, never
// the alpha. Arms written for round 112's mutation survivors.
//   node tests/test-srgb.mjs   -> "RESULT: N passed, 0 failed"

import assert from 'node:assert/strict';
import { SRGB_TO_LINEAR, linearToSrgb } from '../js/srgb.js';
import { test, done } from './harness.mjs';

// (r112 M srgb-O3) an RGBA factor (a glTF baseColorFactor) gives three sRGB channels: the alpha is
// not a colour and is not converted
test('linearToSrgb of an RGBA colour is its three colour channels only (r112 M srgb-O3)', () => {
  const s = linearToSrgb([0.5, 0.25, 1, 0.5]);
  assert.equal(s.length, 3);
  const want = [0.7354, 0.5371, 1];
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(s[k] - want[k]) < 1e-4, `${k}: ${s[k]}`);
  assert.equal(linearToSrgb([0.5, 0.25, 1]).length, 3);
  // and it inverts the byte table: each byte's linear value goes back to that byte
  for (const b of [0, 5, 10, 11, 128, 255]) assert.ok(Math.abs(linearToSrgb([SRGB_TO_LINEAR[b], 0, 0])[0] * 255 - b) < 1e-6, `byte ${b}`);
});

done();
