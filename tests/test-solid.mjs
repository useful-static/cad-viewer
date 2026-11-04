#!/usr/bin/env node
// The one point-in-solid test (js/solid.js) and the box tree it stands on (js/box-tree.js):
// crossings along the three rays (through an edge, through a corner, on the surface), which shells
// wholly hold which (nesting), a body's material (inside), the weld's turning by it
// (js/edges.js shellTurns), and its cost.   node tests/test-solid.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { crossingsAt, nesting, solidIndex } from '../js/solid.js';
import { bodyShells, shellTurns } from '../js/edges.js';
import { box } from './brep-model.mjs';

import { test, done } from './harness.mjs';

// triangles as point triples -> { P, I } (own corners: the weld joins them); signed volume; outward
const meshOf = (T) => { const pos = [], idx = []; for (const t of T) for (const p of t) { idx.push(pos.length / 3); pos.push(...p); } return { P: Float32Array.from(pos), I: Uint32Array.from(idx) }; };
const vol = (T) => T.reduce((s, [a, b, c]) => s + (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6, 0);
const rev = (T) => T.map(([a, b, c]) => [a, c, b]);
const cubeT = (lo, hi, inward = false) => { const T = box(lo, hi).flat(); const o = vol(T) < 0 ? rev(T) : T; return inward ? rev(o) : o; };
// the signed volume of the triangles t0..t1 of a body after shellTurns
const turnedVol = (T, t0, t1) => {
  const { P, I } = meshOf(T), { flip } = shellTurns(P, I);
  return vol(T.slice(t0, t1).map((t, k) => (flip && flip[t0 + k] ? [t[0], t[2], t[1]] : t)));
};

test('a point inside a cube is inside by its crossings, along a face\'s diagonal and through a corner too (r28 Q3: 266 of 981 read outside)', () => {
  const { P, I } = meshOf(cubeT([0, 0, 0], [10, 10, 10]));
  const idx = solidIndex(P, I, Array.from({ length: I.length / 3 }, (_, t) => t));
  const d = [0.3141592, 0.5772156, 0.7536422], l = Math.hypot(...d), R = d.map((x) => x / l); // (the first ray)
  let wrong = 0, n = 0;
  for (let i = 1; i < 1000; i++) {
    const s = i / 100, p = [s, s, 10].map((x, k) => x - (1e-3 + (i % 7) * 0.1) * R[k]);
    if (p.some((x) => x <= 0 || x >= 10)) continue;
    n++;
    if (!crossingsAt(idx, p).inside) wrong++;
  }
  assert.ok(n > 900);
  assert.equal(wrong, 0, `${wrong} of ${n} points back along the ray from the top face's diagonal read outside`);
  assert.equal(crossingsAt(idx, [10, 10, 10].map((x, k) => x - 2 * R[k])).inside, true, 'through the corner');
  assert.equal(crossingsAt(idx, [12, 5, 5]).inside, false);
  assert.equal(crossingsAt(idx, [5, 5, 10]).touch, true, 'on the surface: no answer');
});
test('a plate resting on a cube, the pair turned off the axes, is no part of the cube: wound inside out, it is turned (r28 A2: 29 of 200 nested)', () => {
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const cube = cubeT([-5, -5, -5], [5, 5, 5]), plate = cubeT([-2, -2, 5], [2, 2, 5.5]);
  let bad = 0;
  for (let r = 0; r < 60; r++) {
    let q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]; const l = Math.hypot(...q); q = q.map((x) => x / l);
    const [w, x, y, z] = q;
    const M = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
    const rot = (p) => M.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2]);
    const T = [...cube, ...rev(plate)].map((t) => t.map(rot));
    if (!(turnedVol(T, 12, 24) > 0)) bad++;
  }
  assert.equal(bad, 0, `${bad} of 60 rotations left the plate inside out`);
});
test('a part in a body: a cavity (wound in) is outside the material, a part embedded (wound out) inside, an overlap of two shells inside, a body inside out still holds (r28 A1)', () => {
  const insideOf = (T, p) => {
    const { P, I } = meshOf(T), b = bodyShells(P, I);
    return nesting(P, I, b.shell, b.shellOpen.length, b.shellOpen).inside(p);
  };
  const outer = cubeT([0, 0, 0], [10, 10, 10]);
  assert.equal(insideOf([...outer, ...cubeT([3, 3, 3], [7, 7, 7], true)], [5, 5, 5]), false, 'in a cavity');
  assert.equal(insideOf([...outer, ...cubeT([3, 3, 3], [7, 7, 7], true)], [1, 1, 1]), true, 'in the material round it');
  assert.equal(insideOf([...outer, ...cubeT([3, 3, 3], [7, 7, 7])], [5, 5, 5]), true, 'in an embedded part');
  assert.equal(insideOf([...outer, ...cubeT([5, 5, 5], [15, 15, 15])], [7, 7, 7]), true, 'in the overlap');
  assert.equal(insideOf(rev(outer), [5, 5, 5]), true, 'a body wound inside out');
});
test('an open shell holds nothing, and a part under one keeps its winding, the same upright and upside down (r28 Q1)', () => {
  // a tray (a box without its lid), and an inward cube in it
  const tray = box([0, 0, 0], [10, 10, 5]).filter((_, f) => f !== 1).flat(); // (face 1: the top)
  const trayOut = vol(cubeT([0, 0, 0], [10, 10, 5])) > 0 ? tray : rev(tray);
  const T = [...trayOut, ...cubeT([3, 3, 1], [5, 5, 3], true)];
  const flipX = (t) => t.map(([x, y, z]) => [x, -y, -z]); // (180 degrees about x: a rotation)
  const a = turnedVol(T, trayOut.length, T.length), b = turnedVol(T.map(flipX), trayOut.length, T.length);
  assert.equal(Math.round(a), Math.round(b), `upright ${a}, upside down ${b}`);
  assert.equal(Math.round(a), -8, 'kept as written: no answer under an open shell');
});
test('a part whose outer shells disagree (in the overlap of one wound in and one wound out) keeps its winding, in either file order (r28 Q2)', () => {
  const A = cubeT([0, 0, 0], [10, 10, 10], true), B = cubeT([5, 5, 5], [15, 15, 15]), C = cubeT([6, 6, 6], [9, 9, 9]);
  assert.equal(Math.round(turnedVol([...A, ...B, ...C], 24, 36)), 27);
  assert.equal(Math.round(turnedVol([...B, ...A, ...C], 24, 36)), 27);
});
test('8,000 shells each inside the one before (concentric): the nearest holder only, under 6 s (r28 Q4: 147 s)', () => {
  const T = [];
  for (let i = 0; i < 8000; i++) { const d = i * 0.01; T.push(...cubeT([d, d, d], [200 - d, 200 - d, 200 - d], i % 2 === 1)); }
  const { P, I } = meshOf(T);
  const t0 = performance.now();
  const { flip } = shellTurns(P, I);
  const ms = performance.now() - t0;
  assert.equal(flip, null, 'wound as they lie (each inner one against the one round it): none turned');
  assert.ok(ms < 6000, `${ms.toFixed(0)} ms`);
});

done();
