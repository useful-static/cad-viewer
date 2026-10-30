#!/usr/bin/env node
// The 1:1 SVG drawing (js/drawing-svg.js) of bodies built the way OpenCascade
// meshes them (as tests/test-measure.mjs builds them).
//   node tests/test-drawing.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { drawingSVG } from '../js/drawing-svg.js';
import { bodyGeometry } from '../js/measure-geom.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

function model(bodies, angularDeflection = 0.5) {
  const pos = [], idx = [], faces = [], meshes = [];
  for (const b of bodies) {
    const m = { name: b.name, idxStart: idx.length, faceStart: faces.length / 2, faceCount: b.faces.length };
    for (const f of b.faces) {
      const map = new Map();
      faces.push(idx.length / 3, f.length);
      for (const tri of f) for (const p of tri) {
        const k = p.join(',');
        if (!map.has(k)) { map.set(k, pos.length / 3); pos.push(...p); }
        idx.push(map.get(k));
      }
    }
    m.idxCount = idx.length - m.idxStart;
    meshes.push(m);
  }
  return { position: new Float32Array(pos), index: new Uint32Array(idx), faces: new Uint32Array(faces), header: { meshes, angularDeflection } };
}
const P = (x, y, z) => [Math.fround(x), Math.fround(y), Math.fround(z)];
function box(lo, hi) {
  const c = (x, y, z) => P(x ? hi[0] : lo[0], y ? hi[1] : lo[1], z ? hi[2] : lo[2]);
  const q = (a, b, cc, d) => [[a, b, cc], [a, cc, d]];
  return [q(c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0)), q(c(0, 0, 1), c(0, 1, 1), c(1, 1, 1), c(1, 0, 1)),
    q(c(0, 0, 0), c(0, 0, 1), c(1, 0, 1), c(1, 0, 0)), q(c(0, 1, 0), c(1, 1, 0), c(1, 1, 1), c(0, 1, 1)),
    q(c(0, 0, 0), c(0, 1, 0), c(0, 1, 1), c(0, 0, 1)), q(c(1, 0, 0), c(1, 0, 1), c(1, 1, 1), c(1, 1, 0))];
}
function washer(ri, ro, h, n) {
  const ring = (r, z) => Array.from({ length: n }, (_, i) => P(r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), z));
  const it = ring(ri, h), ot = ring(ro, h), ib = ring(ri, 0), ob = ring(ro, 0);
  const band = (a, b) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); } return t; };
  return [band(it, ot), band(ob, ib), band(ib, it), band(ot, ob)];
}
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
test('the caption and names are escaped', () => {
  const g = bodyGeometry(model([{ name: 'b', faces: box([0, 0, 0], [1, 1, 1]) }]), 0);
  const d = drawingSVG([{ name: 'A & <B>', geom: g }], ...TOP, { title: 'x < y' });
  assert.match(d.svg, /<title>A &amp; &lt;B&gt;<\/title>/);
  assert.match(d.svg, />x &lt; y<\/text>/);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
