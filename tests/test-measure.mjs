#!/usr/bin/env node
// Measure's geometry (js/measure-geom.js) and ray caster (js/raycast.js) on
// bodies built here the way OpenCascade meshes them: every b-rep face its own
// vertices, shared boundary points with identical floats, a faces section.
//   node tests/test-measure.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { angleAt, bodyGeometry, circleMinPoints, circleOf, distance, faceGap, holesOf, polyMid, untoldAt } from '../js/measure-geom.js';
import { BVH_MIN, faceOfTri, makeCaster, seesInside } from '../js/raycast.js';
import { KIND_NAME, MARK, SNAP_KINDS, holeDia, nearestOnRay, untoldText } from '../js/measure-ui.js';
import { readFileSync } from 'node:fs';

import { test, done } from './harness.mjs';

// (the shared builder: bodies of faces as OpenCascade meshes them, with the vertex normals a
// decoded file carries, so every arm runs the page's rule for a face's outside -- r25 A6: 14 of
// the 16 holesOf arms ran a winding-only path the page never takes)
import { P, box, holeShapes, model, washer, withNormals } from './brep-model.mjs';
const f32 = (v) => Math.fround(v);

test('a circle needs ceil(2π/a) - 1 points: 12 at 0.5 rad; off at 2π/9 and coarser', () => {
  assert.equal(circleMinPoints(0.5), 12);
  assert.equal(circleMinPoints((2 * Math.PI) / 9), Infinity);
  const pts = (n, r = 3) => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n) + 10, r * Math.sin((2 * Math.PI * i) / n) - 4, 2]);
  const c = circleOf(pts(24), 0.5);
  assert.ok(c && Math.abs(c.radius - 3) < 1e-9 && Math.hypot(c.centre[0] - 10, c.centre[1] + 4, c.centre[2] - 2) < 1e-9, JSON.stringify(c));
  assert.equal(circleOf(pts(4), 0.5), null, 'a square is not a circle');
  assert.equal(circleOf(pts(6), 0.5), null, 'nor a hexagon');
});
test('a D -- a circle cut by a flat, its points all on the circle -- is no circle; the coarsest circle taken still is (r108 M2)', () => {
  // (arc points every 0.45 rad and one chord across a flat 15 % of the radius deep)
  const r = 2.5, half = Math.acos(0.85), arc = [];
  for (let t = half; t <= 2 * Math.PI - half + 1e-12; t += (2 * Math.PI - 2 * half) / Math.ceil((2 * Math.PI - 2 * half) / 0.45)) arc.push([r * Math.cos(t), r * Math.sin(t), 0]);
  assert.ok(arc.length >= circleMinPoints(0.5), `${arc.length} points`);
  assert.equal(circleOf(arc, 0.5), null, 'a D taken for a circle');
  const n = circleMinPoints(0.5), ring = Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), 0]);
  assert.ok(circleOf(ring, 0.5), 'the coarsest circle refused');
});
test('a face of 140,000 loops: its outer loop found by a walk, not one argument a loop (r108 M4)', () => {
  const tris = [];
  for (let i = 0; i < 140000; i++) { const x = (i % 1000) * 2, y = Math.floor(i / 1000) * 2; tris.push([[x, y, 0], [x + 1, y, 0], [x, y + 1, 0]]); }
  const g = bodyGeometry(model([{ name: 'sheet', faces: [tris] }]), 0);
  assert.equal(g.edges.length, 140000);
});
test('3D Measure\'s edge snap: the edge\'s point nearest the pointer\'s ray, in perspective (r108 M1)', () => {
  // (an eye at the origin; an edge from (5, 5, -40) to (5, 5, -400); the ray through (5, 5, -120)
  // meets it there -- the screen parameter, linear, put it 3.6 to 7.1 mm off on a 100 mm edge)
  const a = [5, 5, -40], b = [5, 5, -400], d = [5 / 120, 5 / 120, -1];
  const p = nearestOnRay(a, b, { o: [0, 0, 0], d }, 0.5);
  assert.ok(Math.hypot(p[0] - 5, p[1] - 5, p[2] + 120) < 1e-9, JSON.stringify(p));
  // (an edge seen end on, along the ray: the screen parameter's point)
  const q = nearestOnRay([0, 0, -10], [0, 0, -20], { o: [0, 0, 0], d: [0, 0, -1] }, 0.25);
  assert.ok(Math.abs(q[2] + 12.5) < 1e-9, JSON.stringify(q));
  // (a ray past either end -- the pointer within the snap radius of an end, beyond it: that end,
  // not a point on the edge's extension, outside the part: r111 H1-M3)
  const pb = nearestOnRay(a, b, { o: [0, 0, 0], d: [5.3 / 450, 5 / 450, -1] }, 1);
  assert.ok(Math.hypot(pb[0] - 5, pb[1] - 5, pb[2] + 400) < 1e-9, `past the far end: ${JSON.stringify(pb)}`);
  const pa = nearestOnRay(a, b, { o: [0, 0, 0], d: [5.3 / 30, 5 / 30, -1] }, 0);
  assert.ok(Math.hypot(pa[0] - 5, pa[1] - 5, pa[2] + 40) < 1e-9, `past the near end: ${JSON.stringify(pa)}`);
});
await test('3D Measure\'s snapAt on a board\'s long edge, at the viewer\'s own camera in perspective: the point under the cursor (r108 M1)', async () => {
  const { createMeasure } = await import('../js/measure-ui.js');
  const { perspective, lookAt, multiply } = await import('../js/mat4.js');
  const stub = () => new Proxy(function () {}, {
    get(t, k) { if (k in t) return t[k]; if (k === 'querySelectorAll') return () => []; if (k === 'querySelector') return () => stub(); if (k === 'children') return []; if (k === Symbol.iterator) return undefined; return stub(); },
    set(t, k, v) { t[k] = v; return true; }, apply() { return stub(); },
  });
  const els = new Map(), $ = (id) => { if (!els.has(id)) els.set(id, stub()); return els.get(id); };
  const m = model([{ name: 'board', faces: box([0, 0, 0], [100, 70, 1.6]) }]);
  // (the viewer's opening camera: yaw 0.7, pitch 0.45, fov 45 degrees, framed at 160)
  const W = 1280, H = 800, fov = Math.PI / 4, centre = [50, 35, 0.8], dist = 160, yaw = 0.7, pitch = 0.45;
  const eye = [centre[0] + dist * Math.cos(pitch) * Math.sin(yaw), centre[1] - dist * Math.cos(pitch) * Math.cos(yaw), centre[2] + dist * Math.sin(pitch)];
  const view = lookAt(eye, centre, [0, 0, 1]), vp = multiply(perspective(fov, W / H, 1, 5000, false), view);
  const dv = eye.map((x, k) => x - centre[k]), L = Math.hypot(...dv);
  const v = { vp, eye, dir: dv.map((x) => x / L), right: [view[0], view[4], view[8]], up: [view[1], view[5], view[9]], ortho: false, tanV: Math.tan(fov / 2), w: W, h: H, target: centre, dist: L };
  const meas = createMeasure({ $, view: () => ({ ...v }), sectionPlane: () => null, closed: () => true,
    scene: { mesh: m, header: m.header, hidden: new Set(), sphere: { center: centre, radius: 61 } },
    lenText: (x) => `${x.toFixed(2)} mm`, num: (x) => x.toFixed(2), unit: () => 'mm', announce() {}, tell() {}, queueFrame() {}, syncOptbar() {}, coarse: () => false, showsHidden: () => false });
  const toScreen = (p) => {
    const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12], y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13], w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    return [((x / w + 1) * W) / 2, ((1 - y / w) * H) / 2];
  };
  for (const xq of [15, 25, 70]) {
    const q = [xq, 70, 1.6], s = meas.snapAt(...toScreen(q));
    // (to the float32 view matrices' rounding: it was 3.6 to 7.1 mm off)
    const off = s && s.p ? Math.hypot(...s.p.map((x, k) => x - q[k])) : Infinity;
    assert.ok(s && s.kind === 'edge' && off < 1e-3, `x ${xq}: ${s && s.kind}, ${off} mm off`);
  }
});
test('uneven spacing does not pull the centre (a least-squares fit, not the mean)', () => {
  // (the coarse part's sides 0.47 rad, under a = 0.5: what a mesh at that deflection can have --
  // at 8 sides, 0.59 rad each, it is no mesh's, and r108 M2 refuses a side past it)
  const angles = [...Array.from({ length: 20 }, (_, i) => (i * Math.PI) / 40), ...Array.from({ length: 10 }, (_, i) => Math.PI / 2 + (i * 1.5 * Math.PI) / 10)];
  const c = circleOf(angles.map((t) => [5 * Math.cos(t), 5 * Math.sin(t), 0]), 0.5);
  assert.ok(c && Math.hypot(...c.centre) < 1e-9 && Math.abs(c.radius - 5) < 1e-9, JSON.stringify(c));
});
test('a box: 8 corners, 12 straight edges, midpoints at the edge centres, six planar faces', () => {
  const m = model([{ name: 'box', faces: box([0, 0, 0], [10, 20, 4]) }]);
  const g = bodyGeometry(m, 0);
  assert.equal(g.corners.length, 8);
  assert.equal(g.edges.length, 12);
  assert.ok(g.edges.some((e) => { const p = polyMid(e); return Math.hypot(p[0] - 5, p[1], p[2]) < 1e-6; }), 'the midpoint of the x edge at y 0, z 0');
  assert.ok(g.faces.every((f) => f.plane));
  assert.equal(g.circles.length, 0);
});
test('a washer: the bore is a hole (both rims, its depth), the outer rim is not', () => {
  const m = model([{ name: 'washer', faces: washer(1.6, 4, 1.6, 48, 20, 30) }]);
  const g = bodyGeometry(m, 0);
  assert.equal(g.corners.length, 0, 'circles only: no corners');
  assert.equal(g.edges.length, 4, 'four closed rims');
  const holes = holesOf(g);
  assert.equal(holes.length, 1, JSON.stringify(holes));
  assert.ok(Math.abs(holes[0].diameter - 3.2) < 1e-4 && Math.abs(holes[0].depth - 1.6) < 1e-6 && holes[0].rims === 2, JSON.stringify(holes[0]));
  assert.ok(Math.hypot(holes[0].centre[0] - 20, holes[0].centre[1] - 30) < 1e-4);
});
test('a board with four mounting holes: four holes, their spacing', () => {
  // a plate whose top and bottom faces are annuli around each hole: built as
  // four washers fused by one body (the faces' loops are what count)
  const faces = [];
  for (const [x, y] of [[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]]) faces.push(...washer(1.375, 3, 1.6, 40, x, y));
  const g = bodyGeometry(model([{ name: 'pcb', faces }]), 0);
  const holes = holesOf(g);
  assert.equal(holes.length, 4);
  assert.ok(holes.every((h) => Math.abs(h.diameter - 2.75) < 1e-4));
  // (their centres exactly: the old check compared two holes that always shared an x)
  const at = holes.map((h) => [Math.round(h.centre[0] * 1e4) / 1e4, Math.round(h.centre[1] * 1e4) / 1e4]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(at, [[3.5, 3.5], [3.5, 52.5], [61.5, 3.5], [61.5, 52.5]]);
  assert.ok(holes.every((h) => Math.abs(h.depth - 1.6) < 1e-6 && h.rims === 2));
});
test('every kind of point Measure snaps to has its mark and its name (a cut-face point read "undefined undefined")', () => {
  for (const k of SNAP_KINDS) assert.ok(MARK[k] && KIND_NAME[k], k);
  // and every kind the snapping code gives is one of them (read from its source)
  const src = readFileSync(new URL('../js/measure-ui.js', import.meta.url), 'utf8');
  // (every `kind: 'x'` anywhere, however it is given -- the edge kind is pushed, which a `return {`
  // pattern missed -- but Face to face's picked face, which is no snap)
  const given = new Set([...src.matchAll(/consider\([^)]*?'([a-z]+)'/g), ...src.matchAll(/kind: '([a-z]+)'/g)].map((m) => m[1]));
  given.delete('face');
  for (const k of given) assert.ok(SNAP_KINDS.includes(k), `${k} has no mark`);
  assert.ok(given.has('cut') && given.has('surface'), [...given].join(','));
});
test('the hole table of 8,000 rims pairs them by their axis lines, fast (every rim against every other froze the page)', () => {
  // 4,000 washers in a grid, each a through-hole of its own (walls and all: a dead index pairs none)
  const faces = [];
  for (let i = 0; i < 4000; i++) faces.push(...washer(1, 2, 1.6, 16, (i % 80) * 5, Math.floor(i / 80) * 5));
  const g = bodyGeometry(model([{ name: 'grid', faces }]), 0);
  const t0 = Date.now();
  const h = holesOf(g);
  const ms = Date.now() - t0;
  assert.equal(h.filter((x) => x.rims === 2 && Math.abs(x.depth - 1.6) < 1e-4).length, 4000, JSON.stringify(h.slice(0, 3)));
  assert.ok(ms < 1500, `${ms} ms`);
});
test('a tilted bore, 600 long at 30 degrees, is one through-hole (its rims fell in different cells)', () => {
  const n = 40, ri = 2, ro = 6, L = 600, a = Math.PI / 6;
  const ax = [Math.sin(a), 0, Math.cos(a)], u = [Math.cos(a), 0, -Math.sin(a)], v = [0, 1, 0];
  const at = (r, z, i) => { const t = (2 * Math.PI * i) / n; return P(...[0, 1, 2].map((k) => r * Math.cos(t) * u[k] + r * Math.sin(t) * v[k] + z * ax[k] + 100)); };
  const ring = (r, z) => Array.from({ length: n }, (_, i) => at(r, z, i));
  const band = (p, q) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([p[i], q[i], q[j]], [p[i], q[j], p[j]]); } return t; };
  const faces = [band(ring(ri, L), ring(ro, L)), band(ring(ro, 0), ring(ri, 0)), band(ring(ri, 0), ring(ri, L)), band(ring(ro, L), ring(ro, 0))];
  const h = holesOf(bodyGeometry(model([{ name: 'bore', faces }]), 0));
  assert.deepEqual(h.map((x) => [x.rims, Math.round(x.depth)]), [[2, 600]], JSON.stringify(h.map((x) => [x.rims, x.depth])));
});
test('4,000 rims on one axis (fins on a shaft): paired in order along it, fast', () => {
  // fins 0.5 thick, 0.5 apart, on one axis, each its own wall: 2,000 through-holes 0.5 deep
  const faces = [];
  for (let i = 0; i < 2000; i++) faces.push(...washer(2, 6, 0.5, 16, 0, 0, i));
  const g = bodyGeometry(model([{ name: 'shaft', faces }]), 0);
  const t0 = Date.now();
  const h = holesOf(g);
  const ms = Date.now() - t0;
  assert.equal(h.filter((x) => x.rims === 2 && Math.abs(x.depth - 0.5) < 1e-4).length, 2000, JSON.stringify(h.slice(0, 3)));
  assert.ok(ms < 1000, `shared axis ${ms} ms`);
  // 16,000 rims on one axis all looking one way (none can pair): each walked all the rest, 1.8 s
  const one = [];
  for (let i = 0; i < 16000; i++) one.push({ plane: { normal: [0, 0, 1], d: i }, ntri: 0, circles: [{ centre: [0, 0, i], normal: [0, 0, 1], radius: 1, inner: true, face: one.length }] });
  const t1 = Date.now();
  assert.equal(holesOf({ faces: one, P: new Float32Array(0), I: new Uint32Array(0) }).length, 16000);
  assert.ok(Date.now() - t1 < 600, `one way ${Date.now() - t1} ms`);
});
test('far out, a loop 2.8% off a circle is not one, a true rim still is (as float32) (r65 Q3)', () => {
  const f = (v) => Math.fround(v);
  // n points round (cx, cy, cz) of radius r, one axis stretched by e (an ellipse e off a circle)
  const loop = (r, e, o, n = 24) => Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; return [f(o + r * (1 + e) * Math.cos(t)), f(o + r * Math.sin(t)), f(o)]; });
  // (not a hole: no circle, or one the stored positions cannot tell -- 20 m out a Ø0.302's step is
  // past the circle test's line, untold whatever its shape: r69 Q1)
  const notHole = (c) => c === null || c.untold === true;
  for (const o of [5000, 20000]) {
    assert.ok(notHole(circleOf(loop(0.151, 0.028, o), 0.5)), `a 2.8% loop of Ø0.302 ${o} mm out`);
    assert.ok(notHole(circleOf(loop(0.0865, 0.118, o), 0.5)), `an 11.8% loop of Ø0.173 ${o} mm out`);
  }
  assert.equal(circleOf(loop(0.151, 0.028, 5000), 0.5), null, 'and 5 m out, its step within the test, no circle at all');
  // must accept: a true Ø0.2 rim 5 m out, and a Ø3 one 20 m out
  assert.ok(circleOf(loop(0.1, 0, 5000), 0.5), 'Ø0.2 at 5 m');
  assert.ok(circleOf(loop(1.5, 0, 20000), 0.5), 'Ø3 at 20 m');
});
test('the stored step is float32\'s own: a Ø0.4 rim 32 m out is told as 20 m out, a Ø0.2 one untold at both; a plate 15 um off flat over 800 mm is flat at the origin as 20 m out (r67 Q1, Q2, r69 Q1)', () => {
  const f = (v) => Math.fround(v);
  const loop = (r, o, n = 24) => Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; return [f(o + r * Math.cos(t)), f(o + r * Math.sin(t)), f(o)]; });
  for (const o of [20000, 32000]) {
    const c = circleOf(loop(0.2, o), 0.5);
    assert.ok(c && !c.untold, `Ø0.4 at ${o} told (2^-23 x far called it untold at 32 m)`);
    // (the step 2^-9 mm there, past 1% of a 0.1 mm radius: untold, inside one power alike -- r69 Q1)
    const s = circleOf(loop(0.1, o), 0.5);
    assert.ok(s && s.untold, `Ø0.2 at ${o} untold`);
  }
  // a 2.5 mm plate 800 mm across, a Ø4 hole through it, its back face's outer edge 15 um up
  const n = 48;
  const ring = (r, z, o) => Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; return P(o + r * Math.cos(t), o + r * Math.sin(t), z); });
  const band = (a, b) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); } return t; };
  const plate = (o) => [band(ring(2, 2.5, o), ring(400, 2.5, o)), band(ring(400, 0.015, o), ring(2, 0, o)), band(ring(2, 0, o), ring(2, 2.5, o)), band(ring(400, 2.5, o), ring(400, 0.015, o))];
  for (const o of [0, 20000]) {
    const h = holesOf(bodyGeometry(model([{ name: 'plate', faces: plate(o) }]), 0));
    assert.deepEqual(h.map((x) => [Math.round(x.diameter * 100) / 100, x.rims]), [[4, 2]], `at ${o}: ${JSON.stringify(h.map((x) => [x.diameter, x.rims]))}`);
  }
});
test('a countersunk through-hole is one row (the bore\'s Ø, through, head the countersink\'s); two coaxial blind holes from either side stay two (r67, round 23 Q5)', () => {
  const n = 48;
  const ring = (r, z) => Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; return P(r * Math.cos(t), r * Math.sin(t), z); });
  const band = (a, b) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); } return t; };
  const disc = (r, z, up) => { const c = P(0, 0, z), e = ring(r, z), t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push(up ? [c, e[i], e[j]] : [c, e[j], e[i]]); } return t; };
  const R = 3, r = 1.5, ro = 8, H = 4, hc = 1.5;
  // a plate H thick, the countersink R wide at the top narrowing to the bore r at H - hc
  const sunk = [band(ring(R, H), ring(ro, H)), band(ring(ro, 0), ring(r, 0)), band(ring(r, 0), ring(r, H - hc)), band(ring(r, H - hc), ring(R, H)), band(ring(ro, H), ring(ro, 0))];
  const h = holesOf(bodyGeometry(model([{ name: 'plate', faces: sunk }]), 0));
  assert.deepEqual(h.map((x) => [Math.round(x.diameter * 100) / 100, x.rims, Math.round(x.depth * 100) / 100, x.head && Math.round(x.head * 100) / 100]), [[3, 2, 4, 6]], JSON.stringify(h));
  // must accept: an R-wide hole 1 deep from the top, an r-wide one 1 deep from the bottom, material between
  const blind = [band(ring(R, H), ring(ro, H)), band(ring(ro, 0), ring(r, 0)), band(ring(R, H - 1), ring(R, H)), disc(R, H - 1, true), band(ring(r, 0), ring(r, 1)), disc(r, 1, false), band(ring(ro, H), ring(ro, 0))];
  const b = holesOf(bodyGeometry(model([{ name: 'plate', faces: blind }]), 0));
  assert.deepEqual(b.map((x) => [Math.round(x.diameter * 100) / 100, x.rims]).sort(), [[3, 1], [6, 1]], JSON.stringify(b));
});
test('a hole read by its wall as the faces join it: chamfered at either end or both, countersunk from both sides, over a blind bore -- one row, the bore\'s Ø; a counterbore, a stepped hole, an inside-out body not merged; the same 20 m out (r68 Q1, Q2, A3, Q10)', () => {
  // (the shapes, tests/brep-model.mjs holeShapes, the position test's too)
  const show = (h) => h.map((x) => [Math.round(x.diameter * 100) / 100, x.rims, Math.round(x.depth * 100) / 100, x.head ? Math.round(x.head * 100) / 100 : 0]);
  for (const o of [0, 20000]) {
    for (const [name, faces, want] of holeShapes(o, o)) {
      const h = holesOf(bodyGeometry(model([{ name: 'p', faces }]), 0));
      assert.deepEqual(show(h), want, `${name} at ${o}: ${JSON.stringify(show(h))}`);
    }
  }
});
test('a shallow drill point 2^17 mm out is not a flat face: the plane floor is the rounding\'s, four steps (r69: at sixteen a point 0.13 deep read flat, the blind hole through)', () => {
  const n = 48, ro = 8, H = 4, r = 1.5, Z = 2 ** 17 + 20;
  const ring = (rr, z) => Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; return P(rr * Math.cos(t), rr * Math.sin(t), Z + z); });
  const band = (a, b) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); } return t; };
  const fan = (rr, z, tz, up) => { const c = P(0, 0, Z + tz), e = ring(rr, z), t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push(up ? [c, e[i], e[j]] : [c, e[j], e[i]]); } return t; };
  const faces = [band(ring(3, H), ring(ro, H)), band(ring(r, 1), ring(r, H - 1.5)), band(ring(r, H - 1.5), ring(3, H)), fan(r, 1, 0.87, false), fan(ro, 0, 0, false), band(ring(ro, H), ring(ro, 0))];
  const h = holesOf(bodyGeometry(model([{ name: 'p', faces }]), 0));
  assert.deepEqual(h.map((x) => [Math.round(x.diameter * 100) / 100, x.rims, x.head ? Math.round(x.head * 100) / 100 : 0]), [[3, 1, 6]], JSON.stringify(h.map((x) => [x.diameter, x.rims, x.depth])));
});
test('a rim filleted R2 into a Ø3 bore 131 m out, the fillet nearly along the face at its rim: read through, as at the origin (r69: its vertices nearly level, their places rounded, read as widening)', () => {
  const n = 48, ro = 8, H = 6, r = 1.5, R = 2;
  const rows = (Y) => {
    // the hole along x, the plate from x 0 to H, moved Y along y
    const ring = (rr, x) => Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; return P(x, Y + rr * Math.cos(t), rr * Math.sin(t)); });
    const band = (a, b) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); } return t; };
    const fillet = (x, s) => {
      const k = 8, pts = Array.from({ length: k + 1 }, (_, i) => { const a = (Math.PI / 2) * (i / k); return [r + R - R * Math.sin(a), x + s * R * (1 - Math.cos(a))]; });
      const rings = (s > 0 ? pts : pts.reverse()).map(([rr, xx]) => ring(rr, xx));
      return rings.slice(1).flatMap((b2, i) => band(rings[i], b2));
    };
    const faces = [band(ring(r + R, H), ring(ro, H)), band(ring(ro, 0), ring(r + R, 0)), fillet(0, 1), band(ring(r, R), ring(r, H - R)), fillet(H, -1), band(ring(ro, H), ring(ro, 0))];
    const h = holesOf(bodyGeometry(model([{ name: 'p', faces }]), 0));
    return h.map((x) => [Math.round(x.diameter * 10) / 10, x.rims, Math.round(x.depth * 10) / 10, x.head ? Math.round(x.head * 10) / 10 : 0]);
  };
  assert.deepEqual(rows(0), [[3, 2, 6, 7]]);
  // (three of the 62 of 360 placements, 2^15 to 2^17 mm out, the old one-way test split it into two
  // blind Ø7 rows; this one none)
  for (const Y of [131086.07, 131127.17, 131154.57]) assert.deepEqual(rows(Y), [[3, 2, 6, 7]], `y+${Y} (must fire: two blind Ø7 rows)`);
});
test('a hole chamfered alike at both ends is named at one rim wherever the model sits (r69 A2: float32 noise chose the end, x+7 and y+100 the bottom)', () => {
  const n = 48, ro = 8, H = 4, r = 1.5;
  const zs = new Set();
  for (const [ax, o] of [[0, 0], [0, 7], [1, 100], [0, 1000], [2, 13]]) {
    const at = (x, y, z) => P(x + (ax === 0 ? o : 0), y + (ax === 1 ? o : 0), z + (ax === 2 ? o : 0));
    const ring = (rr, z) => Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; return at(rr * Math.cos(t), rr * Math.sin(t), z); });
    const band = (a, b) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); } return t; };
    const c = r + 0.5;
    const faces = [band(ring(c, H), ring(ro, H)), band(ring(ro, 0), ring(c, 0)), band(ring(c, 0), ring(r, 0.5)), band(ring(r, 0.5), ring(r, H - 0.5)), band(ring(r, H - 0.5), ring(c, H)), band(ring(ro, H), ring(ro, 0))];
    const h = holesOf(bodyGeometry(model([{ name: 'p', faces }]), 0));
    assert.equal(h.length, 1);
    zs.add(Math.round((h[0].centre[2] - (ax === 2 ? o : 0)) * 1000) / 1000);
  }
  assert.deepEqual([...zs], [4], `named at z ${[...zs].join(', ')} (must fire: the bottom at x+7)`);
});
test('a through-hole whose other rim cannot be told is untold, both rims counted -- not a blind hole of the rim that can (r68: 1 km out, a hole\'s head read as a blind Ø10.8)', () => {
  // a Ø3 bore countersunk to Ø6 at the top; 2^17 mm out the Ø3 bottom rim's rounding passes the line, the Ø6 top's not
  const n = 48, ro = 8, H = 4, r = 1.5, O = 2 ** 17 + 30;
  const ring = (rr, z) => Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; return P(O + rr * Math.cos(t), rr * Math.sin(t), z); });
  const band = (a, b) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); } return t; };
  const faces = [band(ring(3, H), ring(ro, H)), band(ring(ro, 0), ring(r, 0)), band(ring(r, 0), ring(r, H - 1.5)), band(ring(r, H - 1.5), ring(3, H)), band(ring(ro, H), ring(ro, 0))];
  assert.ok(untoldAt(O, r) && !untoldAt(O, 3), 'the case: the bore\'s rim untold there, the head\'s told');
  const h = holesOf(bodyGeometry(model([{ name: 'p', faces }]), 0));
  // (the bore's rim untold, the head's told: one rim untold, one through-hole left out for it -- r69 Q7)
  assert.deepEqual([h.length, h.untold, h.unpaired], [0, 1, 1], `${JSON.stringify(h.map((x) => [x.diameter, x.rims]))}, untold ${h.untold}, unpaired ${h.unpaired} (must fire: the head a blind row)`);
  assert.equal(untoldText(h.untold, h.unpaired), '1 rim this far from the origin that the file\'s rounded positions cannot tell from a shape that is not a circle (rounded coarser than 0.5% of its radius, or within that rounding of the circle test), and 1 through-hole whose other rim is that one: not listed');
});
test('a rim the stored positions cannot tell is no row but counted (untold), and the same rim at the origin is a hole (r66)', () => {
  // a Ø0.08 through-hole (rounding at 20 m: 2.43% of its radius, as the boards' vias), and a Ø3 one
  const at = (x) => holesOf(bodyGeometry(model([{ name: 'w', faces: [...washer(0.04, 0.3, 0.1, 48, x, x, 0), ...washer(1.5, 3, 0.1, 48, x + 10, x, 0)] }]), 0));
  const h0 = at(0), h20 = at(20000);
  assert.deepEqual(h0.map((h) => [Math.round(h.diameter * 100) / 100, h.rims]), [[0.08, 2], [3, 2]]);
  assert.equal(h0.untold, 0);
  assert.deepEqual(h20.map((h) => [Math.round(h.diameter * 100) / 100, h.rims]), [[3, 2]], 'the Ø3 hole still told 20 m out');
  assert.equal(h20.untold, 2, 'the Ø0.08 hole\'s two rims said untold, not left out without a word');
  // (the one sentence for the summary, the CSV and the announcement, its share the rule's own: r67 A3, A8)
  assert.equal(untoldText(2), '2 rims this far from the origin that the file\'s rounded positions cannot tell from a shape that is not a circle (rounded coarser than 0.5% of their radius, or within that rounding of the circle test): not listed');
  // (r70 A4: round 69's band -- a loop past the 1% test by less than a step, 2^17 mm out, its step
  // within the test, is untold, not "no circle"; at the origin the same loop is none)
  const f2 = (v) => Math.fround(v);
  const ellipse = (rr, e, o, k = 48) => Array.from({ length: k }, (_, i) => { const t = (2 * Math.PI * i) / k; return [f2(o + rr * (1 + e) * Math.cos(t)), f2(rr * Math.sin(t)), f2(0)]; });
  const near = circleOf(ellipse(3, 0.021, 2 ** 17 + 20), 0.5);
  assert.ok(near && near.untold === true, `a loop 1.05% off a circle 2^17 mm out: ${JSON.stringify(near && { dev: near.dev / 3, untold: near.untold })} (must fire: no circle)`);
  assert.equal(circleOf(ellipse(3, 0.021, 0), 0.5), null, 'and at the origin, no circle');
  assert.equal(untoldText(0), '');
  // (a row's diameter in one text, with its countersink, for the cell, the summary and the words: r68 A8, Q11)
  const mm = (v) => `${v.toFixed(2)} mm`;
  assert.equal(holeDia({ d: 3, head: 6 }, mm), '3.00 mm (6.00 mm at its rim)');
  assert.equal(holeDia({ d: 3, head: 0 }, mm), '3.00 mm');
});
test('a bore anywhere pairs: tilted in one plane (a component 0 by design) off the origin, and small 5 m out', () => {
  // a washer about any axis d at o, as float32
  const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const bore = (ri, ro, h, n, d, o, ph) => {
    d = unit(d);
    const u = unit(Math.abs(d[0]) < 0.9 ? cr(d, [1, 0, 0]) : cr(d, [0, 1, 0])), v = cr(d, u);
    const ring = (r, z) => Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n + ph; return P(...[0, 1, 2].map((k) => o[k] + r * Math.cos(t) * u[k] + r * Math.sin(t) * v[k] + z * d[k])); });
    const band = (a, b) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); } return t; };
    return [band(ring(ri, h), ring(ro, h)), band(ring(ro, 0), ring(ri, 0)), band(ring(ri, 0), ring(ri, h)), band(ring(ro, h), ring(ro, 0))];
  };
  const bad = [];
  // the canon sign of a component float32 noise gives either sign: 5 of 60 lost
  // (and by its largest, an axis with two equal components of opposite sign: 20-28 of 60 lost)
  for (const d of [[0, 0.5, Math.sqrt(0.75)], [0, 1, -1], [1, -1, 0], [1, 0, -1], [1, -1, 1]]) {
    for (const o of [[0, 0, 0], [37.3, 12.1, 5.5], [250, -130, 40], [1200, 800, -300]]) for (const n of [24, 32, 40, 48, 64]) for (const ph of [0, 0.1, 0.37]) {
      const h = holesOf(bodyGeometry(model([{ name: 'tilted', faces: bore(2, 5, 6, n, d, o, ph) }]), 0));
      if (!(h.length === 1 && h[0].rims === 2 && Math.abs(h[0].depth - 6) < 1e-3)) bad.push(`${d} ${o} ${n} ${ph}`);
    }
  }
  // the axis line's point from the world origin, moved by the normals' noise past the cells searched
  for (const d of [[0.5, 0.3, Math.sqrt(0.66)], [0.3, 0.4, Math.sqrt(0.75)]]) for (const [ri, h] of [[0.3, 0.8], [0.5, 1.6], [0.5, 0.8]]) for (const n of [24, 32, 48]) for (const ph of [0, 0.2]) {
    const hs = holesOf(bodyGeometry(model([{ name: 'far', faces: bore(ri, ri + 2, h, n, d, [3000, 3200, 2400], ph) }]), 0));
    if (!(hs.length === 1 && hs[0].rims === 2 && Math.abs(hs[0].depth - h) < 1e-2)) bad.push(`far ${d} ${ri} ${n} ${ph}`);
  }
  assert.deepEqual(bad, []);
});
test('each b-rep edge says whether it closes (the walk back at its start), the one test Measure and the drawing read (r26 A5)', () => {
  const w = bodyGeometry(model([{ name: 'w', faces: washer(1.6, 4, 2, 24) }]), 0);
  assert.equal(w.edges.length, w.edgeClosed.length);
  assert.deepEqual(w.edgeClosed, w.edges.map(() => true), 'a washer\'s four rims each close');
  const b = bodyGeometry(model([{ name: 'b', faces: box([0, 0, 0], [1, 2, 3]) }]), 0);
  assert.equal(b.edges.length, 12);
  assert.ok(b.edgeClosed.every((c) => c === false), 'a box\'s twelve edges run corner to corner');
});
test('a model without vertex normals is a caller\'s error, said so (no winding-only second rule; r26 Q8)', () => {
  const m = model([{ name: 'box', faces: box([0, 0, 0], [1, 1, 1]) }]);
  delete m.normal;
  assert.throws(() => bodyGeometry(m, 0), /no vertex normals/);
});
test('the cut test is the view\'s: the vertex normals interpolated at the hit, not their sum (r25 Q6)', () => {
  // one triangle of a smooth 12-segment cylinder (r 10, normals radial at 0 and 30 degrees), hit
  // near its 30-degree corner, barycentric (0.05, 0.05, 0.9), by rays grazing it at 5..25 degrees
  const deg = Math.PI / 180;
  const P = Float32Array.of(10, 0, 0, 10, 0, 10, 10 * Math.cos(30 * deg), 10 * Math.sin(30 * deg), 5);
  const sn = (a) => [Math.round(Math.cos(a) * 32767), Math.round(Math.sin(a) * 32767), 0, 0];
  const N = Int16Array.from([...sn(0), ...sn(0), ...sn(30 * deg)]);
  const I = Uint32Array.of(0, 1, 2);
  const w = [0.05, 0.05, 0.9];
  const hit = [0, 1, 2].map((k) => w[0] * P[k] + w[1] * P[3 + k] + w[2] * P[6 + k]);
  let disagree = 0;
  for (let k = 0; k <= 40; k++) {
    const phi = (5 + k * 0.5) * deg, d = [Math.sin(phi), -Math.cos(phi), 0];
    const o = hit.map((x, j) => x - 50 * d[j]);
    // the renderers' rule, by hand: the normal at the fragment, dot(n, toward the eye) < 0 is the cut face
    const n = [0, 1, 2].map((j) => w[0] * N[j] + w[1] * N[4 + j] + w[2] * N[8 + j]);
    const view = n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0;
    if (seesInside(P, N, I, 0, o, d) !== view) disagree++;
  }
  assert.equal(disagree, 0, `${disagree} of 41 grazing views disagree with the view (the sum's rule: 31)`);
});
test('a washer whose triangles wind inward but whose normals look out (a mirrored placement) is one through-hole', () => {
  const g = bodyGeometry(withNormals(model([{ name: 'mirrored', faces: washer(2, 6, 1.6, 40, 0, 0) }]), true), 0);
  assert.deepEqual(holesOf(g).map((x) => [x.rims, Math.round(x.depth * 1e4) / 1e4]), [[2, 1.6]]);
});
test('an open washer (no outer wall) wound outward is one through-hole (its signed volume is no answer)', () => {
  // R 5, r 4, 1 thick: its signed volume about the first vertex is negative (-24)
  const [top, bottom, bore] = washer(4, 5, 1, 40, 0, 0);
  const g = bodyGeometry(withNormals(model([{ name: 'open', faces: [top, bottom, bore] }])), 0);
  assert.deepEqual(holesOf(g).map((x) => [x.rims, Math.round(x.depth * 1e4) / 1e4]), [[2, 1]]);
});
test('two blind holes drilled from either side, material between, are two holes, not one through-hole', () => {
  // a round block 0..10 high, radius 6; a hole of radius 2 from the top 3 deep and one from the
  // bottom 3 deep (their walls: z 7..10 and 0..3; 4 of material between)
  const n = 40, ri = 2, ro = 6;
  const ring = (r, z) => Array.from({ length: n }, (_, i) => P(r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), z));
  const band = (a, b) => { const t = []; for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); } return t; };
  const faces = [band(ring(ri, 10), ring(ro, 10)), band(ring(ro, 0), ring(ri, 0)), band(ring(ri, 7), ring(ri, 10)), band(ring(ri, 0), ring(ri, 3)), band(ring(ro, 10), ring(ro, 0))];
  const h = holesOf(bodyGeometry(model([{ name: 'block', faces }]), 0));
  assert.deepEqual(h.map((x) => x.rims), [1, 1], JSON.stringify(h));
  // with a wall the whole way through: one hole 10 deep
  const through = [faces[0], faces[1], band(ring(ri, 0), ring(ri, 10)), faces[4]];
  const t = holesOf(bodyGeometry(model([{ name: 'block', faces: through }]), 0));
  assert.deepEqual(t.map((x) => [x.rims, Math.round(x.depth * 1e4) / 1e4]), [[2, 10]], JSON.stringify(t));
});
test('under a section the cast skips by the hit point, as the view cuts: not by the triangle', () => {
  // a box 0..10, its top two triangles; the cut at x = 6 keeps x < 6
  const m = model([{ name: 'box', faces: box([0, 0, 0], [10, 10, 2]) }]);
  const caster = makeCaster(m);
  const cut = (q) => q[0] > 6; // (the cut-away side)
  // a ray down at (5, 1): on the drawn top (whatever its triangle's centroid says)
  const kept = caster.cast([0], [5, 1, 10], [0, 0, -1], Infinity, cut);
  assert.ok(kept && Math.abs(kept.t - 8) < 1e-6, JSON.stringify(kept));
  // a ray down at (6.5, 8): cut away -- it goes on through to nothing of the top
  const gone = caster.cast([0], [6.5, 8, 10], [0, 0, -1], Infinity, cut);
  assert.ok(!gone || gone.t > 8 + 1e-6, JSON.stringify(gone));
});
test('a clevis: two flanges on one axis are two holes of their own depth, not one through the gap', () => {
  const faces = [...washer(2, 6, 1.6, 40, 0, 0), ...washer(2, 6, 1.6, 40, 0, 0, 11.6)];
  const holes = holesOf(bodyGeometry(model([{ name: 'clevis', faces }]), 0));
  assert.equal(holes.length, 2, JSON.stringify(holes));
  assert.ok(holes.every((h) => Math.abs(h.depth - 1.6) < 1e-6 && h.rims === 2), JSON.stringify(holes));
  // a fork: arms 10 thick and 1 apart (the gap thinner than an arm): two holes 10 deep, either
  // face order (the nearest rim either way paired across the gap: 1 and 21 deep)
  for (const order of [0, 1]) {
    const arms = [washer(2, 6, 10, 40, 0, 0), washer(2, 6, 10, 40, 0, 0, 11)];
    const fh = holesOf(bodyGeometry(model([{ name: 'fork', faces: (order ? arms.reverse() : arms).flat() }]), 0));
    assert.deepEqual(fh.map((h) => [Math.round(h.depth * 1e4) / 1e4, h.rims]), [[10, 2], [10, 2]], JSON.stringify(fh));
  }
});
test('a board face 57 mm across with a vertex 0.3 um off is flat (to a micrometre): its holes keep both rims', () => {
  const faces = washer(1.375, 28.5, 1.6, 40, 0, 0);
  const m = model([{ name: 'board', faces }]);
  // one bottom vertex (z 0) moved 0.3 um, as a board at hand stores 4 of 1,873
  const P = m.position;
  for (let i = 0; i < P.length; i += 3) if (P[i + 2] === 0 && Math.hypot(P[i], P[i + 1]) > 20) { P[i + 2] = 3e-4; break; }
  const h = holesOf(bodyGeometry(m, 0));
  assert.deepEqual(h.map((x) => x.rims), [2], JSON.stringify(h));
});
test('a flat tilted face 1-1.4 m from the origin is flat (no finer than float32 stores it): one hole, both rims', () => {
  // stored as float32 as a .cadmesh is: turned 30° about x and moved 1 m; and a washer 5 across,
  // 64 sides, turned 45° about y and moved 1.4 m out (flat about the face's summed normal, not
  // about one float32 triangle's)
  for (const [deg, axis, w, off] of [[30, 'x', [1.375, 3, 1.6, 40], [1000, 1000, 1000]], [45, 'y', [2, 5, 6, 64], [1200, 800, -300]]]) {
    const m = model([{ name: 'far', faces: washer(...w, 0, 0) }]);
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), P = m.position;
    for (let i = 0; i < P.length; i += 3) {
      const [x, y, z] = [P[i], P[i + 1], P[i + 2]];
      const q = axis === 'x' ? [x, y * c - z * s, y * s + z * c] : [x * c + z * s, y, -x * s + z * c];
      for (let k = 0; k < 3; k++) P[i + k] = q[k] + off[k];
    }
    m.position = Float32Array.from(P);
    const h = holesOf(bodyGeometry(m, 0));
    assert.deepEqual(h.map((x) => x.rims), [2], `${deg}° ${off}: ${JSON.stringify(h)}`);
  }
});
test('results: distance and deltas, the angle at a corner, face to face', () => {
  const d = distance([0, 0, 0], [3, 4, 12]);
  assert.equal(d.length, 13);
  assert.deepEqual(d.delta, [3, 4, 12]);
  assert.ok(Math.abs(angleAt([1, 0, 0], [0, 0, 0], [0, 5, 0]) - 90) < 1e-9);
  const top = { plane: { normal: [0, 0, 1], d: 1.6 }, points: [[0, 0, 1.6]] };
  const bottom = { plane: { normal: [0, 0, -1], d: 0 }, points: [[0, 0, 0], [5, 5, 0]] };
  assert.ok(Math.abs(faceGap(top, bottom).gap - 1.6) < 1e-9);
  const tilted = { plane: { normal: [Math.sin(0.06), 0, Math.cos(0.06)], d: 0 }, points: [[0, 0, 0]] };
  assert.ok(faceGap(top, tilted).notParallel > 3);
  assert.ok(faceGap({ plane: null, points: [] }, top).notPlanar);
});
test('ray cast: the washer top is hit, its hole is not; the face found by triangle', () => {
  const m = model([{ name: 'washer', faces: washer(1.6, 4, 1.6, 48) }]);
  const c = makeCaster(m);
  const h = c.cast([0], [3, 0, 10], [0, 0, -1]);
  assert.ok(h && Math.abs(h.t - 8.4) < 1e-5, JSON.stringify(h));
  assert.equal(faceOfTri(m.faces, m.header.meshes[0], h.tri), 0, 'the top face');
  assert.equal(c.cast([0], [0, 0, 10], [0, 0, -1]), null, 'down the bore');
  assert.equal(c.cast([0], [3, 0, 10], [0, 0, -1], 5), null, 'stops at tmax');
  // (every triangle against the faces section: a face's first and last triangle too, where an
  // off-by-one in the search's bound names the neighbouring face -- r111 H1-M4)
  const mh = m.header.meshes[0];
  let wrong = 0, tris = 0;
  for (let fi = mh.faceStart; fi < mh.faceStart + mh.faceCount; fi++) {
    for (let t = m.faces[2 * fi]; t < m.faces[2 * fi] + m.faces[2 * fi + 1]; t++) { tris++; if (faceOfTri(m.faces, mh, t) !== fi) wrong++; }
  }
  assert.ok(mh.faceCount >= 4 && tris > 100, `${mh.faceCount} faces, ${tris} triangles`);
  assert.equal(wrong, 0, `${wrong} of ${tris} triangles named the wrong face`);
});
test(`the BVH (bodies over ${BVH_MIN} triangles) answers as the scan does`, () => {
  const n = 3000; // 4 faces x 2n triangles = 24,000
  const m = model([{ name: 'big', faces: washer(1.6, 4, 1.6, n) }]);
  const big = makeCaster(m);
  let agree = 0, hits = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 300; i++) {
    const o = [rnd() * 12 - 6, rnd() * 12 - 6, 10];
    const d = [rnd() * 0.4 - 0.2, rnd() * 0.4 - 0.2, -1];
    const a = big.cast([0], o, d);
    // an independent scan of every triangle (its own Möller-Trumbore)
    const I = m.index, Q = m.position;
    let best = Infinity;
    for (let t = 0; t < I.length / 3; t++) {
      const v = [0, 1, 2].map((j) => [Q[I[3 * t + j] * 3], Q[I[3 * t + j] * 3 + 1], Q[I[3 * t + j] * 3 + 2]]);
      const e1 = v[1].map((x, k) => x - v[0][k]), e2 = v[2].map((x, k) => x - v[0][k]);
      const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
      if (Math.abs(det) < 1e-20) continue;
      const s = o.map((x, k) => x - v[0][k]);
      const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const w = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
      if (w < 0 || u + w > 1) continue;
      const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (tt > 0 && tt < best) best = tt;
    }
    if (best < Infinity) hits++;
    if (Math.abs((a ? a.t : Infinity) - best) < 1e-9 || (!a && best === Infinity)) agree++;
  }
  assert.equal(big.built(), 1, 'the BVH was built');
  assert.ok(hits > 50, `only ${hits} rays hit: the arm would not test much`);
  assert.equal(agree, 300, `${agree}/300 agree (${hits} hit)`);
});

// createMeasure at the viewer's opening camera (the r108 M1 arm's): bodies, the hidden set; the page's
// elements stubs, made elements recorded, what is told recorded. -> { meas, $, toScreen, made, told }
const measureAt = async (bodies, hidden = new Set(), extra = {}) => {
  const { createMeasure } = await import('../js/measure-ui.js');
  const { perspective, lookAt, multiply } = await import('../js/mat4.js');
  const stub = () => new Proxy(function () {}, {
    get(t, k) { if (k in t) return t[k]; if (k === 'querySelectorAll') return () => []; if (k === 'querySelector') return () => stub(); if (k === 'children') return []; if (k === Symbol.iterator) return undefined; return stub(); },
    set(t, k, v) { t[k] = v; return true; }, apply() { return stub(); },
  });
  const els = new Map(), $ = (id) => { if (!els.has(id)) els.set(id, stub()); return els.get(id); };
  const m = model(bodies);
  const W = 1280, H = 800, fov = Math.PI / 4, centre = [50, 35, 0.8], dist = 160, yaw = 0.7, pitch = 0.45;
  const eye = [centre[0] + dist * Math.cos(pitch) * Math.sin(yaw), centre[1] - dist * Math.cos(pitch) * Math.cos(yaw), centre[2] + dist * Math.sin(pitch)];
  const view = lookAt(eye, centre, [0, 0, 1]), vp = multiply(perspective(fov, W / H, 1, 5000, false), view);
  const dv = eye.map((x, k) => x - centre[k]), L = Math.hypot(...dv);
  const v = { vp, eye, dir: dv.map((x) => x / L), right: [view[0], view[4], view[8]], up: [view[1], view[5], view[9]], ortho: false, tanV: Math.tan(fov / 2), w: W, h: H, target: centre, dist: L };
  const told = [];
  const meas = createMeasure({ $, view: () => ({ ...v }), sectionPlane: () => null, closed: () => true,
    scene: { mesh: m, header: m.header, hidden, sphere: { center: centre, radius: 61 } },
    lenText: (x) => `${x.toFixed(2)} mm`, num: (x) => x.toFixed(2), unit: () => 'mm', announce() {}, tell: (s) => told.push(s), queueFrame() {}, syncOptbar() {}, coarse: () => false, showsHidden: () => false, ...extra });
  const toScreen = (p) => {
    const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12], y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13], w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    return [((x / w + 1) * W) / 2, ((1 - y / w) * H) / 2];
  };
  return { meas, $, els, toScreen, told };
};
// a canvas context that records what is drawn: texts (fillText) and arcs' start/end angles
const recordingCtx = () => {
  const texts = [], arcs = [];
  const ctx = new Proxy({}, { get: (t, k) => (k === 'fillText' ? (s) => texts.push(s) : k === 'arc' ? (...a) => arcs.push(`${Math.round(a[3] * 100) / 100},${Math.round(a[4] * 100) / 100}`) : k === 'measureText' ? (s) => ({ width: String(s).length * 7 }) : k in t ? t[k] : () => {}), set: (t, k, x) => { t[k] = x; return true; } });
  return { ctx, texts, arcs };
};
const BOARD = () => ({ name: 'board', faces: box([0, 0, 0], [100, 70, 1.6]) });

// (r112 M measure-ui-B6) a hidden body is not snapped to: the edge of the board under a hidden cover
await test('snapAt passes over a hidden body: the board\'s edge under a hidden cover (r112 M measure-ui-B6)', async () => {
  const { meas, toScreen } = await measureAt([{ name: 'cover', faces: box([0, 0, 10], [100, 70, 12]) }, BOARD()], new Set([1]));
  const s = meas.snapAt(...toScreen([25, 70, 1.6]));
  assert.ok(s && s.kind === 'edge' && s.mesh === 1, `${s && s.kind} of ${s && s.mesh}`);
  assert.ok(Math.hypot(...s.p.map((x, k) => x - [25, 70, 1.6][k])) < 1e-3);
});
// (r112 M measure-ui-C64, measure-ui-B75, measure-ui-O237) the chip counts results in the singular
// and the plural; a saved picture's labels carry their second line; its end dots are whole circles
await test('the results chip says "1 result", "2 results"; the picture has each label\'s two lines and whole dots (r112 M measure-ui-C64, measure-ui-B75, measure-ui-O237)', async () => {
  const { meas, $ } = await measureAt([BOARD()]);
  const chip = [];
  meas.addDistance([0, 0, 0], [10, 0, 0], 'gap A'); chip.push($('measchip').textContent);
  meas.addDistance([0, 0, 0], [0, 20, 0], 'gap B'); chip.push($('measchip').textContent);
  assert.deepEqual(chip, ['1 result', '2 results']);
  const { ctx, texts, arcs } = recordingCtx();
  meas.paint(ctx, 1);
  assert.deepEqual(texts, ['10.00 mm', 'gap A', '20.00 mm', 'gap B']);
  assert.ok(arcs.length >= 4, `${arcs.length} dots`);
  assert.deepEqual([...new Set(arcs)], ['0,6.28']);
});
// (r112 M measure-ui-C35) a note of the user's own is theirs, a note the page gave is given
await test('setNotes: a note marked own is the user\'s, any other the page\'s (given) (r112 M measure-ui-C35)', async () => {
  const { meas } = await measureAt([BOARD()]);
  meas.setNotes([{ p: [1, 2, 3], text: 'mine', own: true }, { p: [4, 5, 6], text: 'given' }]);
  assert.deepEqual(meas.results.filter((r) => r.mode === 'note').map((r) => `${r.main}:${r.given}`), ['mine:false', 'given:true']);
  assert.deepEqual(meas.notes(), [{ p: [1, 2, 3], text: 'mine', own: true }, { p: [4, 5, 6], text: 'given' }]);
});
// (r112 M measure-ui-R26) loupe(x, y) shows the loupe, loupe(null) hides it
await test('loupe(x, y) shows the loupe, loupe(null) takes it away (r112 M measure-ui-R26)', async () => {
  const { meas } = await measureAt([BOARD()]);
  meas.loupe(640, 400);
  assert.equal(meas.loupeShown, true);
  meas.loupe(null);
  assert.equal(meas.loupeShown, false);
});
// (r112 M measure-ui-O129) an Angle placed on three corners of the board reads to two decimals
await test('an Angle placed on three of the board\'s corners reads "90.00°" (r112 M measure-ui-O129)', async () => {
  const { meas, toScreen } = await measureAt([BOARD()]);
  meas.setOn(true);
  meas.setMode('angle');
  for (const p of [[100, 70, 1.6], [0, 70, 1.6], [0, 0, 1.6]]) meas.place(...toScreen(p));
  const a = meas.results.filter((r) => r.mode === 'angle');
  assert.equal(a.length, 1, JSON.stringify(meas.results.map((r) => r.mode)));
  assert.equal(a[0].main, '90.00°');
});
// (r112 M measure-ui-R49) a hole table's row is picked by Enter or Space, as by a click; another key does nothing
await test('a hole table row is picked from the keyboard by Enter and Space, not by another key (r112 M measure-ui-R49)', async () => {
  const had = globalThis.document;
  const made = [];
  globalThis.document = { createElement: (tag) => { const e = { tag, kids: [], textContent: '', classList: { toggle() {} }, append(...c) { this.kids.push(...c); } }; made.push(e); return e; } };
  try {
    const { meas, told } = await measureAt([BOARD(), { name: 'washer', faces: washer(1.6, 4, 1.6, 48, 20, 30) }]);
    meas.showHoles([2], { min: [0, 0, 0], name: 'board' }, 'washer');
    const tr = made.find((e) => e.tag === 'tr');
    assert.ok(tr && tr.onkeydown, 'a row with a key handler');
    const n0 = told.length;
    for (const key of ['Enter', ' ', 'a']) tr.onkeydown({ key, preventDefault() {} });
    assert.equal(told.length - n0, 2);
    assert.match(told[told.length - 1], /^hole 1: Ø /);
  } finally {
    if (had === undefined) delete globalThis.document; else globalThis.document = had;
  }
});
// (r112 M measure-ui-B41, untriaged in M's report) while a note's text is being typed, a click
// places nothing more
await test('while a note\'s text is typed, a click on the model places nothing more (r112 M measure-ui-B41)', async () => {
  const { meas, toScreen } = await measureAt([BOARD()]);
  meas.setOn(true);
  meas.setMode('note');
  assert.ok(meas.place(...toScreen([50, 35, 1.6])));
  const before = JSON.stringify([meas.pending.length, meas.results.length]);
  assert.equal(meas.place(...toScreen([20, 20, 1.6])), true);
  assert.equal(JSON.stringify([meas.pending.length, meas.results.length]), before);
  assert.equal(meas.pending.length, 1, 'the note\'s point kept, waiting for its text');
});

// a stand-in document for the hole table's rows, put back after f
const withDocument = async (f) => {
  const had = globalThis.document;
  globalThis.document = { createElement: (tag) => ({ tag, kids: [], textContent: '', classList: { toggle() {} }, append(...c) { this.kids.push(...c); } }), createElementNS: () => ({ setAttribute() {}, append() {} }) };
  try { return await f(); } finally { if (had === undefined) delete globalThis.document; else globalThis.document = had; }
};
const WASHER_BOARD = (th = 1.6) => [{ name: 'board', faces: box([0, 0, 0], [100, 70, th]) }, { name: 'washer', faces: washer(1.6, 4, th, 48, 20, 30) }];
// (r113 M2 measure-ui-B76) a hole table shown: the picture numbers each hole as its row
await test('the hole table\'s holes are numbered on a painted picture, "1" for the washer\'s one hole; none without a table (r113 M2 measure-ui-B76)', async () => {
  await withDocument(async () => {
    const { meas } = await measureAt(WASHER_BOARD());
    const before = recordingCtx();
    meas.paint(before.ctx, 1);
    assert.deepEqual(before.texts, [], 'no table, no numbers');
    meas.showHoles([2], { min: [0, 0, 0], name: 'board' }, 'washer');
    const { ctx, texts } = recordingCtx();
    meas.paint(ctx, 1);
    assert.deepEqual(texts, ['1']);
  });
});
// (r113 M2 measure-ui-C65) each mode's instruction under Measure
await test('Measure\'s instruction for each mode: "point 1 of 2", "point 1 of 3", "pick a flat face", "click where the note goes" (r113 M2 measure-ui-C65)', async () => {
  const { meas, $ } = await measureAt([BOARD()]);
  meas.setOn(true);
  const hints = {};
  for (const mode of ['distance', 'angle', 'face', 'note']) { meas.setMode(mode); hints[mode] = $('measnote').textContent; }
  assert.deepEqual(hints, { distance: 'point 1 of 2', angle: 'point 1 of 3', face: 'pick a flat face', note: 'click where the note goes' });
});
// (r113 M2 measure-ui-O131) Face to face of the board's top (z 1.6) and a washer's top (z 5)
await test('Face to face: the board\'s top then a 5 mm washer\'s top read "3.40 mm" (r113 M2 measure-ui-O131)', async () => {
  await withDocument(async () => {
    const { meas, toScreen } = await measureAt([{ name: 'board', faces: box([0, 0, 0], [100, 70, 1.6]) }, { name: 'washer', faces: washer(1.6, 4, 5, 48, 20, 30) }]);
    meas.setOn(true);
    meas.setMode('face');
    meas.place(...toScreen([60, 40, 1.6]));
    assert.equal(meas.results.length, 0, 'one face picked, no result yet');
    meas.place(...toScreen([23, 30, 5]));
    assert.deepEqual(meas.results.map((r) => `${r.main} (${r.sub})`), ['3.40 mm (face to face)']);
  });
});
// (r113 M2 measure-ui-R27) a finger held on the view: the magnifier is shown and drawn into
await test('loupe(x, y) then draw(): the magnifier #measloupe is shown, filled and the view copied into it (r113 M2 measure-ui-R27)', async () => {
  const hadWin = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    await withDocument(async () => {
      const { meas, els } = await measureAt(WASHER_BOARD(), new Set(), { coarse: () => true });
      const calls = [];
      const rec = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => calls.push(String(k))), set: (t, k, x) => { t[k] = x; return true; } });
      const box = { hidden: true, width: 0, height: 0, style: {}, getContext: () => rec };
      els.set('measloupe', box);
      els.set('view', { width: 1280, height: 800 });
      els.set('stage', { dataset: { bg: 'dark' } });
      meas.setOn(true);
      meas.draw();
      assert.equal(box.hidden, true, 'no finger, no magnifier');
      assert.deepEqual(calls, []);
      meas.loupe(640, 400);
      meas.draw();
      assert.equal(box.hidden, false, 'the magnifier is shown');
      assert.ok(calls.includes('fillRect') && calls.includes('drawImage') && calls.includes('stroke'), calls.join(' '));
    });
  } finally {
    if (hadWin === undefined) delete globalThis.window; else globalThis.window = hadWin;
  }
});
// (r113 M2 measure-ui-R50) the hole table's Copy as CSV
await test('the hole table\'s "Copy as CSV" puts the header and the hole\'s row on the clipboard and tells "hole table copied" (r113 M2 measure-ui-R50)', async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const clip = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (s) => { clip.push(s); } } }, configurable: true, writable: true });
  try {
    await withDocument(async () => {
      const { meas, $, told } = await measureAt(WASHER_BOARD());
      meas.showHoles([2], { min: [0, 0, 0], name: 'board' }, 'washer');
      const n0 = told.length;
      $('holescsv').onclick();
      await new Promise((r) => setTimeout(r, 5));
      assert.deepEqual(clip, ['n,diameter (mm),"X, Y (mm)",depth (mm),rim diameter (mm)\n1,3.20,"20.00, 30.00",1.60,']);
      assert.deepEqual(told.slice(n0), ['hole table copied']);
    });
  } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator;
  }
});

// (r112 M measure-geom-C50) a box wound inward with its normals out (a mirrored placement): every
// face's plane turned to its normals, the last face too
test('a mirrored box\'s face planes all face out by the normals, the last face too (r112 M measure-geom-C50)', () => {
  const m = model([{ name: 'b', faces: box([0, 0, 0], [10, 20, 4]) }]);
  const I = m.index;
  for (let t = 0; t < I.length / 3; t++) { const x = I[3 * t + 1]; I[3 * t + 1] = I[3 * t + 2]; I[3 * t + 2] = x; }
  const g = bodyGeometry(m, 0);
  assert.deepEqual(g.faces.map((f) => f.plane.normal.map((x) => Math.round(x) + 0).join(',')), ['0,0,1', '0,0,-1', '0,1,0', '0,-1,0', '1,0,0', '-1,0,0']);
});
// (r112 M measure-geom-B36, untriaged in M's report) an open b-rep edge with points along it -- a
// D-shaped plate's half-circle rims -- is one edge corner to corner, even where a point along it is
// numbered before its corners (the curved side's triangles listed from the middle of the arc)
test('a D-shaped plate\'s half-circle rims are one edge each, corner to corner (r112 M measure-geom-B36)', () => {
  const n = 12, r = 10, h = 2;
  const arc = (z) => Array.from({ length: n + 1 }, (_, i) => P(r * Math.cos((Math.PI * i) / n), r * Math.sin((Math.PI * i) / n), z));
  const top = arc(h), bot = arc(0), c0 = P(0, 0, 0), ch = P(0, 0, h);
  const fan = (ring, c, up) => ring.slice(0, -1).map((p, i) => (up ? [c, p, ring[i + 1]] : [c, ring[i + 1], p]));
  const side = [];
  for (let j = 0; j < n; j++) { const i = (j + n / 2) % n; side.push([bot[i], bot[i + 1], top[i + 1]], [bot[i], top[i + 1], top[i]]); }
  const flat = [[bot[0], top[n], bot[n]], [bot[0], top[0], top[n]]];
  const g = bodyGeometry(model([{ name: 'd', faces: [side, fan(top, ch, true), fan(bot, c0, false), flat] }]), 0);
  assert.equal(g.corners.length, 4);
  // two rims of 13 points, two straight edges through the centre (3), four ends of 2 -- 8 edges
  assert.deepEqual(g.edges.map((e) => e.length).sort((a, b) => a - b), [2, 2, 2, 2, 3, 3, 13, 13]);
});

// r114: M3's U-medium survivors in measure-geom and measure-ui, each on its probe's input
// (r114 M3 measure-geom-O222) the midpoint snap of a curved edge whose segments are under 1 unit:
// an M3 hole's half rim, radius 1.6 in 24 segments of 0.21 mm
test('polyMid of a half rim of radius 1.6 in 24 segments is [0, 1.6, 0], of a 10 mm edge in two pieces [5, 0, 0] (r114 M3 measure-geom-O222)', () => {
  const arc = Array.from({ length: 25 }, (_, i) => [1.6 * Math.cos((Math.PI * i) / 24), 1.6 * Math.sin((Math.PI * i) / 24), 0]);
  const r3 = (p) => p.map((x) => Math.round(x * 1000) / 1000 + 0);
  assert.deepEqual(r3(polyMid(arc)), [0, 1.6, 0]);
  assert.deepEqual(r3(polyMid([[0, 0, 0], [4, 0, 0], [10, 0, 0]])), [5, 0, 0]);
});
// a stand-in document that records what draw() makes: the overlay's SVG elements (tag, attributes)
// and its labels (divs), put back after f({ svg, html })
const withRecordingDocument = async (f) => {
  const had = globalThis.document;
  const svg = [], html = [];
  globalThis.document = {
    createElement: (tag) => { const e = { tag, kids: [], style: {}, textContent: '', className: '', classList: { toggle() {}, add() {} }, append(...c) { this.kids.push(...c); }, setAttribute() {} }; html.push(e); return e; },
    createElementNS: (ns, tag) => { const e = { tag, a: {}, setAttribute(k, v) { this.a[k] = v; }, append() {} }; svg.push(e); return e; },
  };
  try { return await f({ svg, html }); } finally { if (had === undefined) delete globalThis.document; else globalThis.document = had; }
};
const drawn = (svg) => svg.map((e) => `${e.tag}.${e.a.class}`).join(' ');
// (r114 M3 measure-ui-C58) a measured distance is drawn as its line and two dots
await test('after a Distance between two corners, draw() puts one line.mline and two circle.mdot on the overlay (r114 M3 measure-ui-C58)', async () => {
  await withRecordingDocument(async ({ svg }) => {
    const { meas, toScreen } = await measureAt([BOARD()]);
    meas.setOn(true);
    meas.setMode('distance');
    for (const p of [[0, 0, 1.6], [100, 70, 1.6]]) meas.place(...toScreen(p));
    assert.equal(meas.results.length, 1);
    svg.length = 0;
    meas.draw();
    assert.equal(drawn(svg.filter((e) => /^m(line|dot)$/.test(e.a.class))), 'line.mline circle.mdot circle.mdot');
    const [a, b] = [[0, 0, 1.6], [100, 70, 1.6]].map(toScreen), l = svg.find((e) => e.a.class === 'mline');
    assert.ok(Math.hypot(l.a.x1 - a[0], l.a.y1 - a[1], l.a.x2 - b[0], l.a.y2 - b[1]) < 1e-6, JSON.stringify(l.a));
  });
});
// (r114 M3 measure-ui-O217) an Angle's label sits on its vertex, a Distance's half way along it
await test('an Angle placed on three of the board\'s corners has its label at the vertex\'s screen point, not the third corner\'s (r114 M3 measure-ui-O217)', async () => {
  await withRecordingDocument(async ({ html }) => {
    const { meas, toScreen } = await measureAt([BOARD()]);
    meas.setOn(true);
    meas.setMode('angle');
    const corners = [[100, 70, 1.6], [0, 70, 1.6], [0, 0, 1.6]];
    for (const p of corners) meas.place(...toScreen(p));
    assert.equal(meas.results.length, 1);
    html.length = 0;
    meas.draw();
    const lab = html.find((e) => e.tag === 'div' && /mlabel/.test(e.className));
    assert.ok(lab, 'a label');
    const at = [parseFloat(lab.style.left), parseFloat(lab.style.top)], vx = toScreen(corners[1]), third = toScreen(corners[2]);
    assert.ok(Math.hypot(at[0] - vx[0], at[1] - vx[1]) < 0.01, `label at ${at}, vertex at ${vx}`);
    assert.ok(Math.hypot(at[0] - third[0], at[1] - third[1]) > 50, 'not on the third corner');
  });
});
// (r114 M3 measure-ui-R22) a placed end dot is found to drag, and the drag re-reads the distance
await test('dotAt on a placed end dot returns { i: 1 }, and moveDot / endDot onto (100, 0, 1.6) re-read the distance as 100.00 mm (r114 M3 measure-ui-R22)', async () => {
  await withRecordingDocument(async () => {
    const { meas, toScreen } = await measureAt([BOARD()]);
    meas.setOn(true);
    meas.setMode('distance');
    for (const p of [[0, 0, 1.6], [100, 70, 1.6]]) meas.place(...toScreen(p));
    assert.equal(meas.results[0].main, '122.07 mm');
    const at = meas.dotAt(...toScreen([100, 70, 1.6]));
    assert.ok(at && at.i === 1 && at.r === meas.results[0], `dotAt -> ${JSON.stringify(at && at.i)}`);
    assert.equal(meas.dotAt(...toScreen([50, 35, 1.6])), null, 'no dot in the middle of the board');
    meas.moveDot(at, ...toScreen([100, 0, 1.6]));
    meas.endDot(at);
    assert.equal(meas.results[0].main, '100.00 mm');
  });
});
// (r114 M3 measure-ui-O109) face 0 of a model -- the board's bottom, seen from below -- is pickable
await test('faceAt on the board\'s bottom seen from below returns face 0; on its top from above face 1 (r114 M3 measure-ui-O109)', async () => {
  const { perspective, lookAt, multiply } = await import('../js/mat4.js');
  const W = 1280, H = 800, fov = Math.PI / 4, centre = [50, 35, 0.8];
  const mk = (eye, up) => {
    const view = lookAt(eye, centre, up), vp = multiply(perspective(fov, W / H, 1, 5000, false), view);
    const dv = eye.map((x, k) => x - centre[k]), L = Math.hypot(...dv);
    return { vp, eye, dir: dv.map((x) => x / L), right: [view[0], view[4], view[8]], up: [view[1], view[5], view[9]], ortho: false, tanV: Math.tan(fov / 2), w: W, h: H, target: centre, dist: L };
  };
  const sc = (vp, p) => { const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12], y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13], w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15]; return [((x / w + 1) * W) / 2, ((1 - y / w) * H) / 2]; };
  await withRecordingDocument(async () => {
    let v = mk([50, 35, -160], [0, 1, 0]);
    const { meas } = await measureAt([BOARD()], new Set(), { view: () => ({ ...v }) });
    meas.setOn(true);
    meas.setMode('face');
    const below = meas.faceAt(...sc(v.vp, [50, 35, 0]));
    assert.ok(below, 'the bottom face picked');
    assert.equal(below.face, 0);
    v = mk([50, 35, 160], [0, 1, 0]);
    const above = meas.faceAt(...sc(v.vp, [50, 35, 1.6]));
    assert.ok(above && above.face === 1, `top: ${above && above.face}`);
  });
});
// (r114 M3 measure-ui-B68) the hole table shown and the eye zoomed in past a hole: the hole behind
// the eye is not drawn, and draw() does not throw
await test('with the hole table shown and the eye past the washer\'s hole, draw() does not throw and draws no hole; from the opening view it draws the hole (r114 M3 measure-ui-B68)', async () => {
  const { perspective, lookAt, multiply } = await import('../js/mat4.js');
  const W = 1280, H = 800, fov = Math.PI / 4;
  const mk = (eye, centre) => {
    const view = lookAt(eye, centre, [0, 0, 1]), vp = multiply(perspective(fov, W / H, 1, 5000, false), view);
    const dv = eye.map((x, k) => x - centre[k]), L = Math.hypot(...dv);
    return { vp, eye, dir: dv.map((x) => x / L), right: [view[0], view[4], view[8]], up: [view[1], view[5], view[9]], ortho: false, tanV: Math.tan(fov / 2), w: W, h: H, target: centre, dist: L };
  };
  await withRecordingDocument(async ({ svg }) => {
    let v = mk([50 + 160 * Math.cos(0.45) * Math.sin(0.7), 35 - 160 * Math.cos(0.45) * Math.cos(0.7), 0.8 + 160 * Math.sin(0.45)], [50, 35, 0.8]);
    const { meas } = await measureAt(WASHER_BOARD(), new Set(), { view: () => ({ ...v }) });
    meas.setOn(true);
    meas.showHoles([2], { min: [0, 0, 0], name: 'board' }, 'washer');
    svg.length = 0;
    meas.draw();
    assert.equal(drawn(svg), 'circle.mhole text.mholetext');
    v = mk([80, 35, 12], [100, 35, 0]);
    svg.length = 0;
    assert.doesNotThrow(() => meas.draw());
    assert.equal(drawn(svg), '');
  });
});

done();
