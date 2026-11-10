#!/usr/bin/env node
// Cut a board model whose parts were fused into the board (one body: the
// STEP's export merged every part into the PCB) back into its parts.
//
// The body is cut along the board: every b-rep face lying within the board's
// slab (its top and bottom planes, its outline, the walls of its holes) is the
// board; the faces left fall into separate pieces where the board held them
// together, and each piece is a part. A sliver (a pad, a lead's tip) is
// given to the part on the same face whose footprint holds it, else to that
// face's "small parts" body (the board's body stays the board alone). A face running through the board's thickness and on past the rest
// of its piece is the board's edge, which the export merged with a part
// flush with it. Parts that touch each other (a stacked connector, a
// heatsink on its chip) stay one piece.
//
// Each output body is named "part N" (N by position, left to right, then
// front to back, so the names stay put when the file is cut again); bodies
// that were already separate in the input are kept as they were.
//
// Works on .cadmesh files with the faces section (stp2mesh.mjs writes it):
// a vertex belongs to exactly one b-rep face, so the cut never splits one.

import { gzipSync, constants as zc } from 'node:zlib';
import { decodeCadmesh, encodeCadmesh, gunzip, isGzip, modelFactsOf, notMmWords, refuseWithoutEdges } from './js/cadmesh.js';
import { CliError, CliHelp, checkOutput, parseCli, gzipsOutput, positive, readInput, runCliIfMain, writeOutput } from './js/cli-args.js';

const USAGE = `usage: split-board.mjs <in.cadmesh[.gz]> -o <out.cadmesh.gz> [--edges] [--report] [--sliver MM]

  Cuts the body holding the board (the one with the largest flat face) into
  the board and its parts; other bodies pass through unchanged.
  --edges    write the edge sections too (default: none, as the site's files)
  --report   print each output body's name, triangle count and box
  --sliver MM  a piece no larger than this in any direction joins the part on
             its face of the board that it lies within, else that face's
             "small parts" body (default 1.2)
`;

// (the tools' one argument rule, js/cli-args.js; and --sliver a positive number: "abc" was NaN,
// every piece then larger than it, and the board cut into 0 parts, exit 0)
function args(argv) {
  const r = parseCli(argv, { values: ['-o', '--sliver'], flags: ['--edges', '--report'], max: 1 });
  if (r.help) return { help: true };
  return { in: r.pos[0], out: r.opts['-o'], edges: !!r.opts['--edges'], report: !!r.opts['--report'], sliver: positive(r.opts, '--sliver', 1.2) };
}

const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

export function splitBoard(d, { sliver = 1.2 } = {}) {
  // (its reaches and rows are millimetres: a model in another unit refused, as the exports refuse
  // one -- an inch board was cut into 0 parts, exit 0: r85 A3)
  const notMm = notMmWords(d.header, 'a board split is');
  if (notMm) throw new Error(notMm);
  const P = d.position, I = d.index, F = d.faces, N = d.normal, C = d.color;
  if (!F) throw new Error('the file has no faces section: convert it again with stp2mesh.mjs');
  const meshes = d.header.meshes;
  const nf = F.length / 2;
  // per face: area, area-weighted z normal, z range, xy box, owning mesh
  const fa = new Float64Array(nf), fnz = new Float64Array(nf);
  const lo = new Float64Array(nf * 3).fill(Infinity), hi = new Float64Array(nf * 3).fill(-Infinity);
  const fm = new Int32Array(nf);
  meshes.forEach((m, mi) => { for (let f = m.faceStart; f < m.faceStart + m.faceCount; f++) fm[f] = mi; });
  for (let f = 0; f < nf; f++) {
    for (let t = F[2 * f]; t < F[2 * f] + F[2 * f + 1]; t++) {
      const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      fa[f] += Math.hypot(cx, cy, cz) / 2;
      fnz[f] += cz / 2;
      for (const v of [a, b, c]) {
        for (let k = 0; k < 3; k++) {
          if (P[v + k] < lo[3 * f + k]) lo[3 * f + k] = P[v + k];
          if (P[v + k] > hi[3 * f + k]) hi[3 * f + k] = P[v + k];
        }
      }
    }
  }
  // the board: the largest face facing up and the largest facing down, in one mesh
  let up = -1, dn = -1;
  for (let f = 0; f < nf; f++) {
    if (fnz[f] > 0.99 * fa[f] && (up < 0 || fa[f] > fa[up])) up = f;
    if (fnz[f] < -0.99 * fa[f] && (dn < 0 || fa[f] > fa[dn])) dn = f;
  }
  if (up < 0 || dn < 0 || fm[up] !== fm[dn]) throw new Error('no board found (its top and bottom faces are not in one body)');
  const bm = fm[up];
  const zt = lo[3 * up + 2], zb = lo[3 * dn + 2];
  if (!(zt > zb)) throw new Error(`the board's top (${zt}) is not above its bottom (${zb})`);
  const eps = 1e-3 * Math.max(1, zt - zb);
  const M = meshes[bm];
  const fs = [];
  for (let f = M.faceStart; f < M.faceStart + M.faceCount; f++) fs.push(f);
  const slab = new Set(fs.filter((f) => lo[3 * f + 2] >= zb - eps && hi[3 * f + 2] <= zt + eps));
  const inBoard = (f) => slab.has(f);
  const box = (list) => {
    const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const f of list) for (let k = 0; k < 3; k++) {
      b.min[k] = Math.min(b.min[k], lo[3 * f + k]);
      b.max[k] = Math.max(b.max[k], hi[3 * f + k]);
    }
    return b;
  };
  // the faces left, in pieces: faces sharing a vertex (welded by position,
  // 1 µm) are one piece
  const group = () => {
    const rest = fs.filter((f) => !inBoard(f) && F[2 * f + 1] > 0);
    const par = new Map(rest.map((f) => [f, f]));
    const find = (x) => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
    const owner = new Map();
    for (const f of rest) {
      for (let t = F[2 * f]; t < F[2 * f] + F[2 * f + 1]; t++) {
        for (let k = 0; k < 3; k++) {
          const v = I[3 * t + k] * 3;
          const key = `${Math.round(P[v] * 1e3)},${Math.round(P[v + 1] * 1e3)},${Math.round(P[v + 2] * 1e3)}`;
          const o = owner.get(key);
          if (o === undefined) owner.set(key, f);
          else { const a = find(o), b = find(f); if (a !== b) par.set(a, b); }
        }
      }
    }
    const groups = new Map();
    for (const f of rest) {
      const r = find(f);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(f);
    }
    return [...groups.values()].map((list) => ({ list, box: box(list) }));
  };
  let pieces = group();
  // A face that runs through the board's thickness and on far past the rest
  // of its piece is the board's edge, fused with a part flush with that edge
  // (a microSD slot's front, merged with 50 mm of the board's outline): the
  // board's. Then the pieces again, without it.
  const REACH = 3; // mm past the rest of the piece
  let moved = 0;
  const edge = new Set();
  for (const p of pieces) {
    if (p.list.length < 2) continue;
    const through = p.list.filter((f) => lo[3 * f + 2] < zt - eps && hi[3 * f + 2] > zb + eps);
    if (!through.length || through.length === p.list.length) continue;
    const core = box(p.list.filter((f) => !through.includes(f)));
    for (const f of through) {
      const out = [0, 1].some((k) => core.min[k] - lo[3 * f + k] > REACH || hi[3 * f + k] - core.max[k] > REACH);
      if (out) { slab.add(f); edge.add(f); moved++; }
    }
  }
  if (moved) pieces = group();
  const size = (p) => Math.max(...[0, 1, 2].map((k) => p.box.max[k] - p.box.min[k]));
  const big = pieces.filter((p) => size(p) > sliver);
  // (the edge faces taken back are a body of their own: they reach past the
  // board's thickness, and the board's body stays the board's box)
  const board = fs.filter((f) => (inBoard(f) && !edge.has(f)) || F[2 * f + 1] === 0);
  // a sliver goes to the smallest part whose footprint holds its centre on
  // the same side of the board, else to a body of its face's small parts.
  // (Never through the board to a part on the other face: what lies under
  // a chip's footprint there is its decoupling capacitors, not its leads,
  // and a part spanning both faces cannot be shown from either. Nor into
  // the board: a board body as thick as the parts on
  // both its faces holds them in its box, and a viewer that judges what
  // hides a part by boxes no longer sees the board in the way.)
  const upper = (b) => (b.min[2] + b.max[2]) / 2 > (zb + zt) / 2;
  const small = { true: [], false: [] };
  for (const p of pieces) {
    if (size(p) > sliver) continue;
    const cx = (p.box.min[0] + p.box.max[0]) / 2, cy = (p.box.min[1] + p.box.max[1]) / 2;
    let best = null;
    for (const q of big) {
      if (upper(q.box) !== upper(p.box)) continue;
      if (cx < q.box.min[0] || cx > q.box.max[0] || cy < q.box.min[1] || cy > q.box.max[1]) continue;
      const area = (q.box.max[0] - q.box.min[0]) * (q.box.max[1] - q.box.min[1]);
      if (!best || area < best.area) best = { q, area };
    }
    if (best) best.q.list.push(...p.list); else small[upper(p.box)].push(...p.list);
  }
  for (const q of big) q.box = box(q.list);
  // stable names: by the part's centre, rows of 1 mm in y, then x
  big.sort((p, q) => {
    const py = Math.round((p.box.min[1] + p.box.max[1]) / 2), qy = Math.round((q.box.min[1] + q.box.max[1]) / 2);
    if (py !== qy) return py - qy;
    return (p.box.min[0] + p.box.max[0]) - (q.box.min[0] + q.box.max[0]);
  });
  pieces = big;

  // one output body from a list of faces of mesh mi
  const body = (name, list, mi) => {
    list.sort((a, b) => a - b);
    const vmap = new Map();
    const pos = [], nrm = [], col = [], idx = [], faces = [];
    let ntri = 0;
    for (const f of list) {
      const t0 = F[2 * f], n = F[2 * f + 1];
      faces.push(n ? ntri : 0, n);
      for (let t = t0; t < t0 + n; t++) {
        for (let k = 0; k < 3; k++) {
          const v = I[3 * t + k];
          let w = vmap.get(v);
          if (w === undefined) {
            w = vmap.size;
            vmap.set(v, w);
            pos.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
            nrm.push(N[4 * v] / 32767, N[4 * v + 1] / 32767, N[4 * v + 2] / 32767);
            col.push(C[4 * v], C[4 * v + 1], C[4 * v + 2], 255);
          }
          idx.push(w);
        }
        ntri++;
      }
    }
    return {
      name, color: meshes[mi].color || null,
      positions: Float32Array.from(pos), normals: Float32Array.from(nrm), colors: Uint8Array.from(col),
      indices: Uint32Array.from(idx), faces: Uint32Array.from(faces), kind: null,
    };
  };
  const out = [];
  meshes.forEach((m, mi) => {
    if (mi !== bm) {
      const list = [];
      for (let f = m.faceStart; f < m.faceStart + m.faceCount; f++) list.push(f);
      out.push(body(m.name, list, mi));
      out.at(-1).kind = m.kind || null;
      return;
    }
    out.push(body(m.name, board, mi));
    pieces.forEach((p, i) => out.push(body(`part ${i + 1}`, p.list, mi)));
  });
  // last, so the parts keep their places in the body list
  if (edge.size) out.push(body('board edge', [...edge], bm));
  if (small.true.length) out.push(body('small parts, +z face', small.true, bm));
  if (small.false.length) out.push(body('small parts, -z face', small.false, bm));
  return { meshes: out, slab: [zb, zt], board: bm, parts: pieces.length };
}

async function main() {
  let a;
  // (a usage error and help thrown, said by runCli as in every tool)
  a = args(process.argv.slice(2));
  if (a.help) throw new CliHelp();
  if (!a.in || !a.out) throw new CliError(a.in ? 'no -o output' : 'no input file');
  // (the input read and the output checked in the five tools' one wording, before the split)
  let raw = await readInput(a.in);
  await checkOutput(a.out, []); // (a .cadmesh from a .cadmesh: in place is allowed)
  // (unpacked as the page unpacks it: its limit and words, every member -- r75 A6)
  const inGz = isGzip(raw); // (written back as it came: gzipsOutput)
  if (inGz) raw = Buffer.from(await gunzip(raw));
  // (a bad input said with its name, as the other tools say it -- r108 L3)
  let d;
  try { d = decodeCadmesh(toAB(raw)); } catch (e) { throw new Error(`${a.in}: ${e.message}`); }
  const s = splitBoard(d, { sliver: a.sliver });
  const h = d.header;
  // the header's facts about the whole model carried over (js/cadmesh.js MODEL_FACTS: the
  // colours are carried vertex by vertex, so a "recolour" is still whoever's they were)
  const model = {
    ...modelFactsOf(h), meshes: s.meshes,
    root: { name: h.root?.children?.[0]?.name || h.root?.name || 'model', meshes: s.meshes.map((_, i) => i), children: [] },
  };
  const enc = new Uint8Array(encodeCadmesh(model, { edges: !!a.edges, onEdgesError: refuseWithoutEdges(a.in) })); // (asked for and their build failing: refused)
  await writeOutput(a.out, gzipsOutput(a.out, inGz) ? gzipSync(enc, { level: zc.Z_BEST_COMPRESSION }) : enc);
  console.log(`${a.in}: board slab z ${s.slab[0].toFixed(2)}..${s.slab[1].toFixed(2)} mm, body ${s.board + 1} cut into the board and ${s.parts} parts; ${s.meshes.length} bodies -> ${a.out}`);
  if (a.report) {
    for (const m of s.meshes) {
      const p = m.positions;
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[i + k]); mx[k] = Math.max(mx[k], p[i + k]); }
      console.log(`  ${m.name.padEnd(24)} ${String(m.indices.length / 3).padStart(7)} tris  x ${mn[0].toFixed(1)}..${mx[0].toFixed(1)}  y ${mn[1].toFixed(1)}..${mx[1].toFixed(1)}  z ${mn[2].toFixed(1)}..${mx[2].toFixed(1)}`);
    }
  }
}

// run as a command (a path with a space or through a symlink included)
await runCliIfMain(import.meta.url, 'split-board', main, USAGE);
