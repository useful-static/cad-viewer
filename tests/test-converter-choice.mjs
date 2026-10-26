#!/usr/bin/env node
// Which converter build an import runs on (js/converter-choice.js), and the
// multi-core build's meshing forecast (js/import-progress.js):
//   node tests/test-converter-choice.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { browserEnv, useThreads } from '../js/converter-choice.js';
import { THREADED_MESH, forecast } from '../js/import-progress.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const desk = { isolated: true, cores: 16, memoryGB: 8, ua: DESKTOP_UA, mobile: false };

test('a cross-origin-isolated desktop with 8 GB and 16 cores gets the multi-core build', () => {
  assert.equal(useThreads(desk), true);
});

test('never without cross-origin isolation (no SharedArrayBuffer)', () => {
  assert.equal(useThreads({ ...desk, isolated: false }), false);
});

test('never on fewer than 4 cores, or when the core count is unknown', () => {
  assert.equal(useThreads({ ...desk, cores: 2 }), false);
  assert.equal(useThreads({ ...desk, cores: undefined }), false);
  assert.equal(useThreads({ ...desk, cores: 4 }), true);
});

test('a browser that says under 8 GB keeps one thread, even on a desktop', () => {
  assert.equal(useThreads({ ...desk, memoryGB: 4 }), false);
});

test('never on a phone or tablet, even one that says 8 GB', () => {
  assert.equal(useThreads({ ...desk, ua: PHONE_UA, mobile: true }), false);
  assert.equal(useThreads({ ...desk, ua: IPAD_UA }), false);
  assert.equal(useThreads({ ...desk, mobile: true }), false, 'userAgentData.mobile alone');
});

test('an iPad whose Safari says "Macintosh" is told apart from a Mac by its touch points', () => {
  const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const safari = { ...desk, ua: MAC_UA, memoryGB: undefined, mobile: undefined };
  assert.equal(useThreads({ ...safari, touchPoints: 5 }), false, 'iPad');
  assert.equal(useThreads({ ...safari, touchPoints: 0 }), true, 'Mac');
});

test('a desktop browser that does not say its memory (Firefox, Safari) gets it', () => {
  assert.equal(useThreads({ ...desk, memoryGB: undefined }), true);
});

test('browserEnv reads a page or worker global', () => {
  const g = { crossOriginIsolated: true,
    navigator: { hardwareConcurrency: 8, deviceMemory: 4, userAgent: 'x', userAgentData: { mobile: false }, maxTouchPoints: 0 } };
  assert.deepEqual(browserEnv(g), { isolated: true, cores: 8, memoryGB: 4, ua: 'x', mobile: false, touchPoints: 0 });
  assert.deepEqual(browserEnv({}),
    { isolated: false, cores: undefined, memoryGB: undefined, ua: undefined, mobile: undefined, touchPoints: undefined });
});

test('the multi-core forecast shortens meshing only', () => {
  const f = { bytes: 25.7e6, step: true, entities: 556028, bounds15: 300000 };
  const one = forecast(f), mt = forecast(f, true);
  assert.equal(mt.read, one.read);
  assert.equal(mt.transfer, one.transfer);
  assert.equal(mt.write, one.write);
  assert.ok(Math.abs(mt.mesh - one.mesh * THREADED_MESH) < 1e-9);
  const g = { bytes: 5e6, step: false };
  assert.ok(Math.abs(forecast(g, true).mesh - forecast(g).mesh * THREADED_MESH) < 1e-9, 'and for a file with only its size');
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
