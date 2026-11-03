#!/usr/bin/env node
// The display styles (js/styles.js): defaults, E, and the paper colours'
// contrast as the plan states it.   node tests/test-styles.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { CUT_FILL, DEFAULT_STYLE, PAPER, PAPER_EDGES, STYLES, contrast, edgePasses, styleFor, toggleEdges } from '../js/styles.js';

import { test, done } from './harness.mjs';

test('six styles; the paper ones are Hidden line, Hidden grey and Wire; outlines in those and X-ray', () => {
  assert.equal(STYLES.length, 6);
  assert.deepEqual(STYLES.filter((s) => s.paper).map((s) => s.id), ['hidden', 'hiddengrey', 'wire']);
  assert.deepEqual(STYLES.filter((s) => s.outline).map((s) => s.id), ['hidden', 'hiddengrey', 'wire', 'xray']);
});
test('default: Shaded for every file, b-rep or mesh; a known choice wins', () => {
  assert.equal(DEFAULT_STYLE, 'shaded');
  assert.equal(styleFor('wire'), 'wire');
  assert.equal(styleFor('edges'), 'edges');
  assert.equal(styleFor('nonsense'), 'shaded');
  assert.equal(styleFor(null), 'shaded');
});
test('E switches Shaded and Shaded + edges only', () => {
  assert.equal(toggleEdges('shaded'), 'edges');
  assert.equal(toggleEdges('edges'), 'shaded');
  assert.equal(toggleEdges('wire'), null);
});
test('edge passes: none for Shaded, one or two per edge style, hidden first in Hidden grey', () => {
  assert.equal(edgePasses('shaded'), null);
  for (const s of STYLES) assert.equal(!!edgePasses(s.id), s.edges, `${s.id}: edges flag and passes agree`);
  const hg = edgePasses('hiddengrey', { scale: 2 });
  assert.deepEqual(hg.map((p) => p.depth), ['greater', 'lequal']);
  assert.equal(hg[0].dash, 12);
  assert.equal(hg[0].selectedOnly, true);
  assert.equal(edgePasses('xray')[0].mode, 2);
  assert.equal(edgePasses('xray', { onLight: true })[0].mode, 1, 'X-ray on a light ground takes the paper colours');
});
test('seesHidden exactly where a pass draws behind faces', () => {
  for (const s of STYLES) {
    const behind = (edgePasses(s.id) || []).some((p) => p.depth !== 'lequal');
    assert.equal(s.seesHidden, behind, s.id);
  }
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

done();
