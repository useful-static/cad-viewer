#!/usr/bin/env node
// The hole table (js/measure-geom.js holesOf) with position as a property. Each board is moved
// along each axis, both ways, and its positions stored as a file at that place stores them
// (float32). The offsets are a spread of distances (1 to 32 m), plus the board placed just under,
// across and just over each power-of-two boundary of the coordinates, from 2^10 mm out to one
// power past the first at which float32 cannot hold the board's largest rim (its smallest: the
// RK3399's false holes 300 m out lay past it -- r69 Q4). With the boards, always, a plate of every
// hole shape the table is held to (tests/brep-model.mjs holeShapes: no board holds a countersunk
// row -- r69 Q5).
//
// The rule, for every run, against the board's table at the origin:
//   - no row the origin lacks;
//   - no row changed beyond what the stored positions can move it by (centre, diameter, depth,
//     rims, countersink);
//   - every row lost has a rim the table counts untold at its place, or is a through-hole the
//     table left out for its other rim (by place, not by a total: a loop untold that was never a
//     rim could hide a rim dropped without a word -- r69 Q6).
// Rounds 65, 66 and 67 each found a fault at one offset (5 m, 20 m, 32 m); this test is the
// property those spot offsets were samples of (r68). And a second rule, per axis, by the power of
// two a row's rims sit in -- inside one power a float32 coordinate has one step: every placement
// inside one tells the row alike, and a row told at a farther power is told at every nearer one
// (r69: the first rule cannot see a rim counted untold that could have been told).
//
//   node tests/test-hole-position.mjs              every board under ../models (lc-*.cadmesh.gz), and the shapes
//   node tests/test-hole-position.mjs --report     also print each run's counts
//   HOLE_POSITION_MODELS=<a.cadmesh.gz:b...>       other models instead (read, never copied)
//   HOLE_POSITION_GEOM=<path/to/measure-geom.js>   another copy of the rules (a must-fire run)
// A board absent (the public tree carries none) is skipped, by name. One worker per model.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { decodeCadmesh } from '../js/cadmesh.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const GEOM = process.env.HOLE_POSITION_GEOM ? pathToFileURL(process.env.HOLE_POSITION_GEOM).href : new URL('../js/measure-geom.js', import.meta.url).href;
const { bodyGeometry, holesOf } = await import(GEOM);
const RADIUS_TOL = 0.01; // (js/measure-geom.js's; older copies of the rules do not export it)
// (the spread's reach by this tree's line, whichever copy of the rules is under test)
const { untoldAt } = await import('../js/measure-geom.js');

// the step a float32 of size `far` moves by
export const ulpAt = (far) => (far > 0 ? 2 ** (Math.floor(Math.log2(far)) - 23) : 0);

export function readModel(path) {
  let buf = readFileSync(path);
  if (buf[0] === 0x1f) buf = gunzipSync(buf);
  return decodeCadmesh(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

// the model's table: every body's rows, with its body; the untold rims summed, and where they and
// the through-holes left out for them are (an older copy of the rules gives no places: [])
// (each row's margin: how far its rims' loops lie inside the circle test, the least of them -- a
// loop within the rounding of that line is told at one placement and not at another inside one
// power of two, its points rounded differently; the second rule leaves such a row out -- r69)
export function tableOf(m, position = m.position, margins = false) {
  const rows = [], untoldAt = [], unpairedAt = [];
  let untold = 0;
  for (let b = 0; b < m.header.meshes.length; b++) {
    const g = bodyGeometry({ ...m, position }, b);
    const h = holesOf(g);
    // (the margins at the origin only, the circles found by a grid of their centres: every row against
    // every circle at every placement was 72 M pairs a placement of a 6,202-row model)
    let grid = null;
    const cell = 2;
    if (margins) {
      grid = new Map();
      for (const c of g.circles) { if (c.dev === undefined) continue; const k = c.centre.map((v) => Math.floor(v / cell)).join(); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(c); }
    }
    for (const r of h) {
      let margin = Infinity;
      if (grid) {
        const ends = r.rims > 1 ? [-1, 0, 1].map((s) => r.centre.map((v, k) => v + s * r.normal[k] * r.depth)) : [r.centre];
        const reach = 0.02 * r.diameter + 1e-3;
        for (const e of ends) {
          const q = e.map((v) => Math.floor(v / cell));
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            for (const c of grid.get(`${q[0] + dx},${q[1] + dy},${q[2] + dz}`) || []) {
              if (Math.hypot(...e.map((v, k) => v - c.centre[k])) <= reach) margin = Math.min(margin, Math.abs(RADIUS_TOL * c.radius - c.dev));
            }
          }
        }
      }
      rows.push({ ...r, body: b, margin });
    }
    untold += h.untold || 0;
    for (const c of h.untoldAt || []) untoldAt.push({ body: b, c });
    for (const c of h.unpairedAt || []) unpairedAt.push({ body: b, c });
  }
  return { rows, untold, untoldAt, unpairedAt };
}

// the plate of hole shapes, each at its own place, as one model of a body each
export async function shapesModel() {
  const { holeShapes, model } = await import('./brep-model.mjs');
  const n = holeShapes().length;
  return model(Array.from({ length: n }, (_, k) => { const [name, faces] = holeShapes(20 * k, 0)[k]; return { name, faces }; }));
}

export function boxOf(P) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]); }
  return { lo, hi };
}

// The offsets, per axis and sign: [{ axis, D, why }]. Distances 1 m to 32 m (the rounds' spot
// offsets among them), and for each power of two 2^p from 2^10 mm to pTop: the board's far side
// just under 2^p, the boundary across its middle, its near side just over 2^p. pTop: one past the
// first power where the board's largest rim is untold (the rule's own line, so the spread reaches
// past it whatever the line is; by its smallest, rims still told were never placed farther out --
// r69 Q4), at most 2^30.
export function offsetsFor(box, rMax) {
  let pTop = 10;
  while (!untoldAt(2 ** pTop, rMax) && pTop < 30) pTop++;
  pTop++;
  const out = [];
  for (let axis = 0; axis < 3; axis++) for (const sign of [1, -1]) {
    // (moved the negative way, the far side is the low one)
    const near = sign > 0 ? box.lo[axis] : -box.hi[axis], far = sign > 0 ? box.hi[axis] : -box.lo[axis];
    const mid = (near + far) / 2;
    for (const d of [1000, 5000, 10000, 20000, 32000]) out.push({ axis, D: sign * d, why: `${d / 1000} m` });
    for (let p = 10; p <= pTop; p++) {
      const b = 2 ** p;
      out.push({ axis, D: sign * (b - far - 0.5), why: `under 2^${p}` });
      out.push({ axis, D: sign * (b - mid), why: `across 2^${p}` });
      out.push({ axis, D: sign * (b - near + 0.5), why: `over 2^${p}` });
    }
  }
  return out;
}

// One run: the model moved D along `axis` (float32, as a file there stores it), its table against
// the origin's. -> { rows, gained, changed, lost, lostRims, untoldGrew, faults: [text] }
export function positionRun(m, base, axis, D) {
  const P = new Float32Array(m.position.length);
  for (let i = 0; i < P.length; i++) P[i] = m.position[i] + (i % 3 === axis ? D : 0);
  const moved = tableOf(m, P);
  const { hi, lo } = boxOf(P);
  const far = Math.max(...hi.map(Math.abs), ...lo.map(Math.abs));
  // what the stored positions can move a measure by: a few steps at that size, and 0.01 mm
  const slack = Math.max(0.01, 4 * ulpAt(far));
  const back = moved.rows.map((r) => ({ ...r, centre: r.centre.map((v, k) => (k === axis ? v - D : v)) }));
  const usedB = new Set();
  const faults = [];
  let changed = 0, lost = 0, lostRims = 0;
  const gap = (a, b) => Math.hypot(...a.centre.map((v, k) => v - b.centre[k]));
  const near = (a, b) => a.body === b.body && gap(a, b) <= slack && Math.abs(a.diameter - b.diameter) <= Math.max(0.005 * a.diameter, slack);
  const where = (r) => `body ${r.body} Ø${r.diameter.toFixed(3)} at ${r.centre.map((v) => v.toFixed(2)).join(',')}`;
  const lostIdx = new Set();
  // (the moved rows by body: every origin row against every moved one was 38 M pairs a placement of a
  // 6,202-row model)
  const byBody = new Map();
  back.forEach((b, q) => { let l = byBody.get(b.body); if (!l) byBody.set(b.body, (l = [])); l.push(q); });
  for (const [ai, a] of base.rows.entries()) {
    let j = -1, best = Infinity;
    for (const q of byBody.get(a.body) || []) { const b = back[q]; if (!usedB.has(q) && near(a, b) && gap(a, b) < best) { best = gap(a, b); j = q; } }
    if (j < 0) { lost++; lostRims += a.rims; lostIdx.add(ai); continue; }
    usedB.add(j);
    const b = back[j], why = [];
    if (a.rims !== b.rims) why.push(`rims ${a.rims} -> ${b.rims}`);
    if (Math.abs(a.depth - b.depth) > slack) why.push(`depth ${a.depth.toFixed(4)} -> ${b.depth.toFixed(4)}`);
    if (!!a.head !== !!b.head || (a.head && Math.abs(a.head - b.head) > Math.max(0.005 * a.head, slack))) why.push(`countersink ${a.head || '-'} -> ${b.head || '-'}`);
    if (why.length) { changed++; faults.push(`changed: ${where(a)}: ${why.join(', ')}`); }
  }
  const gained = back.filter((_, q) => !usedB.has(q));
  for (const b of gained) faults.push(`gained: ${where(b)} rims ${b.rims}`);
  const untoldGrew = moved.untold - base.untold;
  // each row lost: a rim counted untold at one of its ends, or the row left out for its other rim
  // (its ends: its centre, a through-hole's other at its depth either way; to the slack and 2% of
  // its Ø, the fit of a loop so rounded)
  const backAt = (x) => x.c.map((v, k) => (k === axis ? v - D : v));
  const group = (list) => { const g = new Map(); for (const x of list) { let l = g.get(x.body); if (!l) g.set(x.body, (l = [])); l.push({ body: x.body, c: backAt(x) }); } return g; };
  const untB = group(moved.untoldAt), unpB = group(moved.unpairedAt);
  let merged = 0;
  for (const ai of lostIdx) {
    const a = base.rows[ai];
    const ends = a.rims > 1 ? [-1, 0, 1].map((s) => a.centre.map((v, k) => v + s * a.normal[k] * a.depth)) : [a.centre];
    const reach = Math.max(slack, 0.02 * a.diameter);
    const at = (g) => (g.get(a.body) || []).some((x) => ends.some((e) => Math.hypot(...e.map((v, k) => v - x.c[k])) <= reach));
    // (a rim narrower than the step there has no loop as stored -- its points merge into a few --
    // and no reader of the file can count it: the rule holds while the step is within the radius.
    // The RK3399's Ø0.08 vias 2^20 mm out, a step of 0.125 mm -- r69)
    const ownFar = Math.max(...a.centre.map((v, k) => Math.abs(v + (k === axis ? D : 0)))) + a.diameter / 2;
    if (a.diameter / 2 < ulpAt(ownFar)) { merged++; continue; }
    if (!at(untB) && !at(unpB)) faults.push(`lost without a word: ${where(a)} rims ${a.rims}`);
  }
  return { rows: moved.rows.length, gained: gained.length, changed, lost, lostRims, untoldGrew, merged, faults, lostIdx };
}

// The power of two a row's rims sit in, moved D along `axis`: floor(log2) of the largest coordinate
// of their points (each rim's centre, a through-hole's other end at its depth either way, its radius
// round), or null when its points span two powers. Between two powers a float32 coordinate moves by
// one step, so whether a rim can be told is the same anywhere inside one (r69).
export function binadeOf(row, axis, D) {
  const r = row.diameter / 2;
  const ends = row.rims > 1 ? [-1, 0, 1].map((s) => row.centre.map((v, k) => v + s * row.normal[k] * row.depth)) : [row.centre];
  let lo = Infinity, hi = 0;
  for (const c of ends) {
    const big = Math.max(...c.map((v, k) => Math.abs(v + (k === axis ? D : 0))));
    lo = Math.min(lo, big - r); hi = Math.max(hi, big + r);
  }
  const a = Math.floor(Math.log2(Math.max(lo, 1e-9))), b = Math.floor(Math.log2(hi));
  return a === b ? a : null;
}

// The second rule, along one axis, both ways: every placement of a row's rims inside one power of
// two tells it alike, and a row told at a farther power is told at every nearer one. A row lost is
// one whose rims were untold (the first rule: every lost rim counted). -> [fault text]
// (the first rule cannot see a rim counted untold that could have been told: round 67 Q1, where
// 2^-23 x far called rims 32 m out untold that 20 m out, in the same power, were told -- r69)
export function binadeFaults(seen) {
  // seen: [{ row, b, lost, at }] for one axis
  const by = new Map();
  for (const s of seen) { let a = by.get(s.row); if (!a) by.set(s.row, (a = [])); a.push(s); }
  const out = [];
  for (const [row, list] of by) {
    const told = list.filter((s) => !s.lost), untold = list.filter((s) => s.lost);
    for (const u of untold) {
      const t = told.find((x) => x.b >= u.b);
      if (t) out.push(`row ${row}: untold at ${u.at} (2^${u.b}), told at ${t.at} (2^${t.b}${t.b === u.b ? ', the same power' : ', farther'})`);
    }
  }
  return out;
}

const AXIS = 'xyz';
// one model's every placement -> { name, n, rMax, lines, bad } (or { skip }); SHAPES: the plate of
// hole shapes
const SHAPES = '@hole-shapes';
async function runModel(path) {
  const name = path === SHAPES ? 'the hole shapes (tests/brep-model.mjs)' : path.split('/').pop();
  if (path !== SHAPES && !existsSync(path)) return { name, skip: 'absent' };
  const m = path === SHAPES ? await shapesModel() : readModel(path);
  const base = tableOf(m, m.position, true);
  if (!base.rows.length) return { name, skip: 'no holes at the origin' };
  const rMax = Math.max(...base.rows.map((r) => (r.head || r.diameter) / 2));
  const offs = offsetsFor(boxOf(m.position), rMax);
  const lines = [], bad = [], badB = [];
  const seen = [[], [], []];
  let placed = 0, nearLine = 0;
  for (const { axis, D, why } of offs) {
    const r = positionRun(m, base, axis, D);
    const at = `${AXIS[axis]} ${D >= 0 ? '+' : ''}${D.toFixed(1)} (${why})`;
    lines.push(`  ${name} ${at}: rows ${r.rows} of ${base.rows.length}, lost ${r.lost} (${r.lostRims} rims; ${r.merged} narrower than the step), untold +${r.untoldGrew}, gained ${r.gained}, changed ${r.changed}`);
    for (const f of r.faults) bad.push(`${at}: ${f}`);
    // (a row whose rims lie within two steps of that power of the circle test's line left out of
    // the second rule: its loop's rounding, not the power, decides it)
    // (only where the rim can be told by the line at all: the step within the test)
    base.rows.forEach((row, i) => {
      const b = binadeOf(row, axis, D);
      if (b === null) return;
      const step = 2 ** (b - 23), tellable = step <= RADIUS_TOL * row.diameter / 2;
      if (tellable && row.margin <= 2 * step) { nearLine++; return; }
      seen[axis].push({ row: i, b, lost: r.lostIdx.has(i), at }); placed++;
    });
  }
  for (let axis = 0; axis < 3; axis++) badB.push(...binadeFaults(seen[axis]).map((f) => `${AXIS[axis]}: ${f}`));
  return { name, n: offs.length, rows: base.rows.length, rMax, lines, bad, badB, placed, nearLine };
}

if (!isMainThread) {
  parentPort.postMessage(await runModel(workerData));
} else {
  const { test, skip, done } = await import('./harness.mjs');
  const REPORT = process.argv.includes('--report');
  const modelsDir = `${here}../models/`;
  const boards = process.env.HOLE_POSITION_MODELS
    ? process.env.HOLE_POSITION_MODELS.split(':')
    : (existsSync(modelsDir) ? readdirSync(modelsDir).filter((f) => /^lc-.*\.cadmesh\.gz$/.test(f)).sort().map((f) => modelsDir + f) : []);
  if (!boards.length) skip('the hole table holds wherever the board sits', `no board under ${modelsDir} (the public tree carries none)`);
  const paths = [SHAPES, ...boards];
  const results = await Promise.all(paths.map((p) => new Promise((ok, no) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: p, env: process.env });
    w.once('message', ok);
    w.once('error', no);
  }).catch((e) => ({ name: p.split('/').pop(), error: e }))));
  for (const r of results) {
    if (r.skip) { skip(`${r.name}: the hole table holds wherever it sits`, r.skip); continue; }
    if (REPORT && r.lines) for (const l of r.lines) console.log(l);
    test(`${r.name}: ${r.n ?? '?'} placements of its ${r.rows ?? '?'} rows, each axis both ways, out past where its largest rim${r.rMax ? ` (Ø${(2 * r.rMax).toFixed(3)})` : ''} is untold: none gained, none changed, every one lost counted untold at its place`, () => {
      if (r.error) throw r.error;
      if (r.bad.length) throw new Error(`${r.bad.length} faults: ${r.bad.slice(0, 12).join(' | ')}`);
    });
    if (r.error) continue;
    test(`${r.name}: by power of two, along each axis (${r.placed} row placements inside one, ${r.nearLine} left out within the rounding of the circle test): told alike inside one power, and told at every nearer power than one it is told at (r69)`, () => {
      if (r.badB.length) throw new Error(`${r.badB.length} faults: ${r.badB.slice(0, 12).join(' | ')}`);
    });
  }
  done();
}
