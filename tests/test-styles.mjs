#!/usr/bin/env node
// The display styles (js/styles.js): defaults, E, and the paper colours'
// contrast as the plan states it.   node tests/test-styles.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { CUT_FILL, PAPER, PAPER_EDGES, STYLES, contrast, defaultStyle, styleFor, toggleEdges } from '../js/styles.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

test('six styles; the paper ones are Hidden line, Hidden grey and Wire; outlines in those and X-ray', () => {
  assert.equal(STYLES.length, 6);
  assert.deepEqual(STYLES.filter((s) => s.paper).map((s) => s.id), ['hidden', 'hiddengrey', 'wire']);
  assert.deepEqual(STYLES.filter((s) => s.outline).map((s) => s.id), ['hidden', 'hiddengrey', 'wire', 'xray']);
});
test('default: Shaded + edges for a b-rep file, Shaded for a mesh file; a known choice wins', () => {
  assert.equal(defaultStyle(false), 'edges');
  assert.equal(defaultStyle(true), 'shaded');
  assert.equal(styleFor('wire', false), 'wire');
  assert.equal(styleFor('nonsense', true), 'shaded');
  assert.equal(styleFor(null, false), 'edges');
});
test('E switches Shaded and Shaded + edges only', () => {
  assert.equal(toggleEdges('shaded'), 'edges');
  assert.equal(toggleEdges('edges'), 'shaded');
  assert.equal(toggleEdges('wire'), null);
});
test('the paper colours meet the plan\'s contrast figures', () => {
  const r = (a, b) => Math.round(contrast(a, b) * 100) / 100;
  assert.ok(Math.abs(r(PAPER_EDGES.plain[0], PAPER) - 15.8) < 0.1, `plain visible ${r(PAPER_EDGES.plain[0], PAPER)}`);
  assert.ok(Math.abs(r(PAPER_EDGES.plain[0], CUT_FILL) - 8.7) < 0.1, `on the fill ${r(PAPER_EDGES.plain[0], CUT_FILL)}`);
  assert.ok(Math.abs(r(PAPER_EDGES.plain[1], PAPER) - 3.15) < 0.05);
  assert.ok(Math.abs(r(PAPER_EDGES.selected[0], PAPER) - 7.0) < 0.1);
  assert.ok(contrast(PAPER_EDGES.selected[0], CUT_FILL) >= 3, 'selected visible ≥ 3:1 on the fill');
  assert.ok(Math.abs(r(PAPER_EDGES.faded[0], PAPER) - 2.17) < 0.05);
  assert.ok(Math.abs(r(CUT_FILL, PAPER) - 1.81) < 0.05);
  // hidden lighter than visible in every state
  for (const [v, h] of Object.values(PAPER_EDGES)) assert.ok(contrast(h, PAPER) < contrast(v, PAPER));
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
