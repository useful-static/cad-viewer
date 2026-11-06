#!/usr/bin/env node
// The hole table (js/measure-geom.js holesOf) with position as a property. Each board is moved
// along each axis, both ways, and its positions stored as a file at that place stores them
// (float32). The offsets are a spread of distances (1 to 32 m), plus the board placed just under,
// across and just over each power-of-two boundary of the coordinates, from 2^10 mm out to one
// power past the first at which float32 cannot hold the board's smallest rim.
//
// The rule, for every run, against the board's table at the origin:
//   - no row the origin lacks;
//   - no row changed beyond what the stored positions can move it by (centre, diameter, depth,
//     rims, countersink);
//   - every rim of a row lost counted as untold (out.untold grows by at least that many).
// Rounds 65, 66 and 67 each found a fault at one offset (5 m, 20 m, 32 m); this test is the
// property those spot offsets were samples of (r68).
//
//   node tests/test-hole-position.mjs              every board under ../models (lc-*.cadmesh.gz)
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
// (the spread's reach by this tree's line, whichever copy of the rules is under test)
const { untoldAt } = await import('../js/measure-geom.js');

// the step a float32 of size `far` moves by
export const ulpAt = (far) => (far > 0 ? 2 ** (Math.floor(Math.log2(far)) - 23) : 0);

export function readModel(path) {
  let buf = readFileSync(path);
  if (buf[0] === 0x1f) buf = gunzipSync(buf);
  return decodeCadmesh(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

// the model's table: every body's rows, with its body, and the untold rims summed
export function tableOf(m, position = m.position) {
  const rows = [];
  let untold = 0;
  for (let b = 0; b < m.header.meshes.length; b++) {
    const h = holesOf(bodyGeometry({ ...m, position }, b));
    for (const r of h) rows.push({ ...r, body: b });
    untold += h.untold || 0;
  }
  return { rows, untold };
}

export function boxOf(P) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]); }
  return { lo, hi };
}

// The offsets, per axis and sign: [{ axis, D, why }]. Distances 1 m to 32 m (the rounds' spot
// offsets among them), and for each power of two 2^p from 2^10 mm to pTop: the board's far side
// just under 2^p, the boundary across its middle, its near side just over 2^p. pTop: one past the
// first power where the board's smallest rim is untold (the rule's own line, so the spread reaches
// past it whatever the line is).
export function offsetsFor(box, rMin) {
  let pTop = 10;
  while (!untoldAt(2 ** pTop, rMin) && pTop < 30) pTop++;
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
  for (const a of base.rows) {
    let j = -1, best = Infinity;
    back.forEach((b, q) => { if (!usedB.has(q) && near(a, b) && gap(a, b) < best) { best = gap(a, b); j = q; } });
    if (j < 0) { lost++; lostRims += a.rims; continue; }
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
  if (lostRims > untoldGrew) faults.push(`lost ${lost} rows (${lostRims} rims), the untold count grew ${untoldGrew}`);
  return { rows: moved.rows.length, gained: gained.length, changed, lost, lostRims, untoldGrew, faults };
}

const AXIS = 'xyz';
// one model's every placement -> { name, n, rMin, lines, bad } (or { skip })
function runModel(path) {
  const name = path.split('/').pop();
  if (!existsSync(path)) return { name, skip: 'absent' };
  const m = readModel(path);
  const base = tableOf(m);
  if (!base.rows.length) return { name, skip: 'no holes at the origin' };
  const rMin = Math.min(...base.rows.map((r) => r.diameter / 2));
  const offs = offsetsFor(boxOf(m.position), rMin);
  const lines = [], bad = [];
  for (const { axis, D, why } of offs) {
    const r = positionRun(m, base, axis, D);
    const at = `${AXIS[axis]} ${D >= 0 ? '+' : ''}${D.toFixed(1)} (${why})`;
    lines.push(`  ${name} ${at}: rows ${r.rows} of ${base.rows.length}, lost ${r.lost} (${r.lostRims} rims), untold +${r.untoldGrew}, gained ${r.gained}, changed ${r.changed}`);
    for (const f of r.faults) bad.push(`${at}: ${f}`);
  }
  return { name, n: offs.length, rows: base.rows.length, rMin, lines, bad };
}

if (!isMainThread) {
  parentPort.postMessage(runModel(workerData));
} else {
  const { test, skip, done } = await import('./harness.mjs');
  const REPORT = process.argv.includes('--report');
  const modelsDir = `${here}../models/`;
  const paths = process.env.HOLE_POSITION_MODELS
    ? process.env.HOLE_POSITION_MODELS.split(':')
    : (existsSync(modelsDir) ? readdirSync(modelsDir).filter((f) => /^lc-.*\.cadmesh\.gz$/.test(f)).sort().map((f) => modelsDir + f) : []);
  if (!paths.length) skip('the hole table holds wherever the board sits', `no board under ${modelsDir} (the public tree carries none)`);
  const results = await Promise.all(paths.map((p) => new Promise((ok, no) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: p, env: process.env });
    w.once('message', ok);
    w.once('error', no);
  }).catch((e) => ({ name: p.split('/').pop(), error: e }))));
  for (const r of results) {
    if (r.skip) { skip(`${r.name}: the hole table holds wherever it sits`, r.skip); continue; }
    if (REPORT && r.lines) for (const l of r.lines) console.log(l);
    test(`${r.name}: ${r.n ?? '?'} placements of its ${r.rows ?? '?'} rows, each axis both ways, out past where its smallest rim${r.rMin ? ` (Ø${(2 * r.rMin).toFixed(3)})` : ''} is untold: none gained, none changed, every one lost counted untold`, () => {
      if (r.error) throw r.error;
      if (r.bad.length) throw new Error(`${r.bad.length} faults: ${r.bad.slice(0, 12).join(' | ')}`);
    });
  }
  done();
}
