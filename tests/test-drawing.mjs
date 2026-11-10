#!/usr/bin/env node
// The 1:1 SVG drawing (js/drawing-svg.js) of bodies built the way OpenCascade
// meshes them (tests/brep-model.mjs, as tests/test-measure.mjs builds them).
//   node tests/test-drawing.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { drawingSVG } from '../js/drawing-svg.js';
import { bodyGeometry, circleMinPoints } from '../js/measure-geom.js';

import { test, done } from './harness.mjs';

// (the shared builder, tests/brep-model.mjs, as test-measure's)
import { box, model, washer } from './brep-model.mjs';
const TOP = [[1, 0, 0], [0, 1, 0]];   // right x, up y: seen from +z
const FRONT = [[1, 0, 0], [0, 0, 1]]; // right x, up z: seen from -y

test('a box from the top: its outline at 1:1 (the edges seen end on left out), the page the box plus the margins', () => {
  const g = bodyGeometry(model([{ name: 'box', faces: box([0, 0, 0], [10, 20, 4]) }]), 0);
  const d = drawingSVG([{ name: 'box', geom: g }], ...TOP, { margin: 5 });
  assert.equal(d.lines, 8, '4 top + 4 bottom edges; the 4 vertical ones are points');
  assert.equal(d.circles, 0);
  assert.ok(Math.abs(d.width - 20) < 1e-9 && Math.abs(d.height - 30) < 1e-9, `${d.width} x ${d.height}`);
  assert.match(d.svg, /width="20mm" height="30mm" viewBox="-5 -25 20 30"/);
  assert.match(d.svg, /<title>box<\/title>/);
});
test('a washer from the top: its circles size the page, Ø8 and the margins (r108 M3)', () => {
  // (its outline is circles alone: taken out of the page's box, it was cropped to 11 x 11)
  const g = bodyGeometry(model([{ name: 'w', faces: washer(1.6, 4, 2, 48) }]), 0);
  const d = drawingSVG([{ name: 'w', geom: g }], ...TOP, { margin: 5 });
  assert.ok(Math.abs(d.width - 18) < 1e-6 && Math.abs(d.height - 18) < 1e-6, `${d.width} x ${d.height}`);
  assert.match(d.svg, /viewBox="-9 -9 18 18"/);
});
test('a washer from the top: its rims as true circles; from the front, none', () => {
  const g = bodyGeometry(model([{ name: 'w', faces: washer(1.6, 4, 2, 48) }]), 0);
  const top = drawingSVG([{ name: 'w', geom: g }], ...TOP);
  assert.equal(top.circles, 2, 'inner and outer, each once (the top and bottom rims project onto one another)');
  assert.equal(top.lines, 0);
  assert.match(top.svg, /<circle cx="0" cy="0" r="1\.6"\/>/);
  assert.match(top.svg, /<circle cx="0" cy="0" r="4"\/>/);
  const front = drawingSVG([{ name: 'w', geom: g }], ...FRONT);
  assert.equal(front.circles, 0, 'a rim seen edge on is a line, not a circle');
  assert.equal(front.lines, 4);
});
test('without faces\' circles, a closed edge is a circle by its own body\'s angle: 16 points at 0.5, none at 0.1 (r25 Q3, Q8)', () => {
  // an annulus of 16 segments, the file without its faces section: its two rims closed edges
  const at = (a) => {
    const m = model([{ name: 'ring', faces: [washer(1.6, 4, 2, 16)[0]] }], a);
    m.faces = null;
    const g = bodyGeometry(m, 0);
    assert.equal(g.a, a);
    return drawingSVG([{ name: 'ring', geom: g }], ...TOP).circles;
  };
  assert.equal(at(0.5), 2);
  assert.equal(at(0.1), 0, 'a 0.1 file needs 62 points for a circle');
});
test('a rim the stored positions cannot tell is drawn as its edge, not a true circle: a Ø0.08 hole in a Ø0.6 ring, at the origin two circles, 20 m out the outer alone and the hole as lines (r67 A7)', () => {
  const at = (o) => {
    const m = model([{ name: 'via', faces: [washer(0.04, 0.3, 0.1, 48, o, o, 0)[0]] }], 0.5);
    m.faces = null;
    const d = drawingSVG([{ name: 'via', geom: bodyGeometry(m, 0) }], ...TOP);
    return [d.circles, d.lines > 0];
  };
  assert.deepEqual(at(0), [2, false]);
  assert.deepEqual(at(20000), [1, true], 'the Ø0.08 untold: drawn as the edge it is (must fire)');
});
test('an edge whose ends touch a circle drawn is drawn too: a chord, an inscribed hexagon\'s sides; the circle\'s own edge is not (r70 Q3)', () => {
  const R = 10;
  const hex = Array.from({ length: 6 }, (_, i) => [R * Math.cos((Math.PI / 3) * i), R * Math.sin((Math.PI / 3) * i), 0]);
  const edges = [], edgeClosed = [];
  for (let i = 0; i < 6; i++) { edges.push([hex[i], hex[(i + 1) % 6]]); edgeClosed.push(false); }
  // (must accept: the circle's own edge, its 48 points on it, left to the circle)
  edges.push(Array.from({ length: 49 }, (_, i) => [R * Math.cos((2 * Math.PI * i) / 48), R * Math.sin((2 * Math.PI * i) / 48), 0])); edgeClosed.push(true);
  const geom = { circles: [{ centre: [0, 0, 0], normal: [0, 0, 1], radius: R }], edges, edgeClosed, a: 0.5 };
  const d = drawingSVG([{ name: 'part', geom }], ...TOP);
  assert.deepEqual([d.lines, d.circles], [6, 1], 'the six sides and the circle (must fire: the sides dropped)');
});
test('a rim as coarse as the part\'s deflection lets circleOf take is left to its circle, its segments\' middles sagging as far as that allows (r71 A4: at a = 0.5, a 13-segment rim drawn twice)', () => {
  const R = 10;
  for (const n of [circleMinPoints(0.5), 13, 16, 24]) {
    // (two half rims, a seam splitting it, as a face's loop is often cut)
    const half = (k0) => Array.from({ length: n / 2 + 1 }, (_, i) => [R * Math.cos((2 * Math.PI * (k0 + i)) / n), R * Math.sin((2 * Math.PI * (k0 + i)) / n), 0]);
    const edges = n % 2 ? [Array.from({ length: n + 1 }, (_, i) => [R * Math.cos((2 * Math.PI * i) / n), R * Math.sin((2 * Math.PI * i) / n), 0])] : [half(0), half(n / 2)];
    const geom = { circles: [{ centre: [0, 0, 0], normal: [0, 0, 1], radius: R }], edges, edgeClosed: edges.map(() => n % 2 === 1), a: 0.5 };
    const d = drawingSVG([{ name: 'part', geom }], ...TOP);
    assert.deepEqual([d.lines, d.circles], [0, 1], `${n} segments (must fire at 13, 16: the rim drawn as its polygon too)`);
  }
  // must reject still: an inscribed hexagon's sides under the same deflection (above), and a 12-gon
  // where the deflection is finer, 0.1
  const hex12 = [Array.from({ length: 13 }, (_, i) => [R * Math.cos((2 * Math.PI * i) / 12), R * Math.sin((2 * Math.PI * i) / 12), 0])];
  const fine = drawingSVG([{ name: 'part', geom: { circles: [{ centre: [0, 0, 0], normal: [0, 0, 1], radius: R }], edges: hex12, edgeClosed: [false], a: 0.1 } }], ...TOP);
  assert.deepEqual([fine.lines, fine.circles], [1, 1]);
});
test('an edge of one straight segment is a rim piece only within the part\'s deflection: a 30° chord at a = 0.5 drawn, a 7° piece of a 52-gon left to the circle (r72 Q2)', () => {
  const R = 5;
  const at = (deg) => [R * Math.cos((deg * Math.PI) / 180), R * Math.sin((deg * Math.PI) / 180), 0];
  const draw = (edge) => drawingSVG([{ name: 'part', geom: { circles: [{ centre: [0, 0, 0], normal: [0, 0, 1], radius: R }], edges: [edge], edgeClosed: [false], a: 0.5 } }], ...TOP);
  const flat = draw([at(-15), at(15)]);
  assert.deepEqual([flat.lines, flat.circles], [1, 1], 'a D-flat of 30° (must fire: left out)');
  const piece = draw([at(0), at(360 / 52)]);
  assert.deepEqual([piece.lines, piece.circles], [0, 1], 'one segment of a 52-gon rim');
});
test('the caption and names are escaped', () => {
  const g = bodyGeometry(model([{ name: 'b', faces: box([0, 0, 0], [1, 1, 1]) }]), 0);
  const d = drawingSVG([{ name: 'A & <B>', geom: g }], ...TOP, { title: 'x < y' });
  assert.match(d.svg, /<title>A &amp; &lt;B&gt;<\/title>/);
  assert.match(d.svg, />x &lt; y<\/text>/);
  // (a character XML does not allow -- a control character -- as U+FFFD, as the 3MF writes it: r65 A1)
  const c = drawingSVG([{ name: 'Pl\u0001ate', geom: g }], ...TOP, { title: 'cap\u001f' });
  assert.doesNotMatch(c.svg, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  assert.match(c.svg, /<title>Pl�ate<\/title>/);
});

done();
