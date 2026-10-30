#!/usr/bin/env node
// A software WebGPU adapter is recognised (js/renderer-webgpu.js
// isSoftwareAdapter), so the viewer tries WebGL first on it.
//   node tests/test-backend-choice.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { isSoftwareAdapter } from '../js/renderer-webgpu.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

test('software adapters: by the fallback flag, or by name', () => {
  assert.equal(isSoftwareAdapter({ info: { vendor: 'google', architecture: 'swiftshader' } }), true);
  assert.equal(isSoftwareAdapter({ info: { vendor: 'mesa', description: 'llvmpipe (LLVM 17.0.6, 256 bits)' } }), true);
  assert.equal(isSoftwareAdapter({ info: { vendor: 'mesa', device: 'lavapipe' } }), true);
  assert.equal(isSoftwareAdapter({ info: { vendor: 'microsoft', description: 'Microsoft Basic Render Driver' } }), true);
  assert.equal(isSoftwareAdapter({ info: { isFallbackAdapter: true } }), true);
  assert.equal(isSoftwareAdapter({ isFallbackAdapter: true, info: {} }), true);
});
test('hardware adapters are not', () => {
  assert.equal(isSoftwareAdapter({ info: { vendor: 'amd', architecture: 'rdna-3', description: 'AMD Radeon 780M' } }), false);
  assert.equal(isSoftwareAdapter({ info: { vendor: 'intel', architecture: 'xe-lpg' } }), false);
  assert.equal(isSoftwareAdapter({ info: { vendor: 'apple', architecture: 'metal-3' } }), false);
  assert.equal(isSoftwareAdapter({}), false);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
