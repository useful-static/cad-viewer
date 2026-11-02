#!/usr/bin/env node
// Validate js/dwg.js on a corpus of DWG files, by the file's own checks and against an
// independent answer key.
//
//   node tests/validate-dwg.mjs LIST.txt [--json OUT.json] [--md OUT.md]
//
// LIST.txt: one "<standard> <path.dwg>" per line (a standard is the spec chapter's file
// format: R13-R15, R2004, R2007, R2010, R2013, R2018). For each file:
//
//   1. the format checks the file carries (dwg.checks: CRCs, checksums, sentinels, the object
//      map's handles): every one must pass;
//   2. every object of a type the reader decodes must decode (no exception, data and handles
//      inside the object);
//   3. where AutoCAD's own DXF of the same drawing sits beside it (same name, .dxf), every
//      entity, block entity and layer is matched by handle (DXF group 5) and compared:
//      type, layer, and the geometry groups below, to a relative 1e-9 (or 1e-9 absolute).
//
// Exit status 0 only when every file passes all three.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { readDWG, dwgToPairs } from '../js/dwg.js';

// the groups compared per DXF type (a group absent from the answer key is not compared)
const GROUPS = {
  LINE: [10, 20, 30, 11, 21, 31], CIRCLE: [10, 20, 30, 40], ARC: [10, 20, 30, 40, 50, 51], POINT: [10, 20, 30],
  ELLIPSE: [10, 20, 30, 11, 21, 31, 40, 41, 42], TEXT: [10, 20, 40, 50, 1], MTEXT: [10, 20, 40, 71],
  INSERT: [2, 10, 20, 30, 41, 42, 50], LWPOLYLINE: [90, 10, 20, 42], SPLINE: [71, 72, 73, 74, 40, 10, 20],
  SOLID: [10, 20, 11, 21, 12, 22, 13, 23], TRACE: [10, 20, 11, 21, 12, 22, 13, 23], HATCH: [2, 70, 91],
  DIMENSION: [2, 10, 20], POLYLINE: [70], VERTEX: [10, 20, 30, 42], LAYER: [2, 62, 6],
};

function dxfPairs(path) {
  // DXF from AutoCAD 2007 (AC1021) on is UTF-8; before, the drawing's ANSI code page
  const head = readFileSync(path, 'latin1').slice(0, 400);
  const m = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*AC(\d{4})/.exec(head);
  const t = readFileSync(path, m && Number(m[1]) >= 1021 ? 'utf8' : 'latin1').split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 1 < t.length; i += 2) {
    const c = Number(t[i].trim());
    if (!Number.isInteger(c)) return null; // binary or malformed: no answer key
    out.push([c, t[i + 1]]);
  }
  return out;
}
// records keyed by handle (group 5) from the TABLES (LAYER), BLOCKS and ENTITIES sections
function byHandle(P) {
  const m = new Map();
  const blocks = new Map(); // upper-case block name -> its BLOCK_RECORD handle
  let sec = null, cur = null;
  for (let i = 0; i < P.length; i++) {
    const [c, v] = P[i];
    if (c === 0 && v.trim() === 'SECTION') { sec = (P[i + 1] || [])[1]?.trim(); cur = null; continue; }
    if (c === 0) {
      cur = { type: v.trim(), g: [] };
      if (sec === 'ENTITIES' || sec === 'BLOCKS' || (sec === 'TABLES' && cur.type === 'LAYER')) cur.keep = true;
      if (sec === 'TABLES' && cur.type === 'BLOCK_RECORD') cur.rec = true;
      continue;
    }
    if (!cur) continue;
    if (c === 5 && cur.h === undefined) { cur.h = parseInt(v.trim(), 16); if (cur.keep) m.set(cur.h, cur); }
    if (c === 2 && cur.rec && cur.h !== undefined) blocks.set(v.trim().toUpperCase(), cur.h);
    cur.g.push([c, v.trim()]);
  }
  m.blocks = blocks;
  return m;
}
const vals = (r, c) => r.g.filter((x) => x[0] === c).map((x) => x[1]);
function same(a, b, c) {
  if (c === 1 || c === 2 || c === 6) return a === b || a.toUpperCase() === b.toUpperCase();
  const x = Number(a), y = Number(b);
  if (c === 62) return Math.abs(x) === Math.abs(y) && Math.sign(x || 1) === Math.sign(y || 1);
  if ((c === 50 || c === 51) && Number.isFinite(x) && Number.isFinite(y)) { const d = Math.abs(((x - y) % 360 + 540) % 360 - 180); return d < 1e-6; }
  return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
}

function validate(std, path) {
  const res = { std, path, ok: true, notes: [] };
  let d;
  try { d = readDWG(readFileSync(path)); } catch (err) { res.ok = false; res.error = String(err.message || err); return res; }
  res.version = d.version; res.objects = d.objects.size; res.mapped = d.mapCount;
  res.checks = Object.fromEntries(Object.entries(d.checks).map(([k, c]) => [k, [c.pass, c.pass + c.fail]]));
  res.checkFailures = d.failures;
  let decoded = 0, decodable = 0;
  const errs = {};
  for (const o of d.objects.values()) {
    if (o.decoded || o.error) decodable++;
    if (o.decoded) decoded++;
    if (o.error) errs[o.name] = (errs[o.name] || 0) + 1;
  }
  res.decoded = [decoded, decodable];
  res.decodeErrors = errs;
  if (d.failures.length || decoded !== decodable) res.ok = false;
  const twin = path.replace(/\.dwg$/i, '.dxf');
  if (existsSync(twin)) {
    const key = dxfPairs(twin);
    if (key) {
      const A = byHandle(key), B = byHandle(dwgToPairs(d));
      const cmp = { matched: 0, missing: 0, notInFile: 0, typeDiff: 0, layerDiff: 0, valueDiff: 0, fieldsCompared: 0, examples: [] };
      for (const [h, a] of A) {
        let groups = GROUPS[a.type];
        if (!groups) continue;
        const b = B.get(h);
        // a handle the DWG's own object map does not have: the twin was written from another
        // save of the drawing (it happens: example_r13's DXF has 5055 handles above the DWG's
        // last); counted, not a reader failure
        if (!b && !d.objects.has(h)) { cmp.notInFile++; continue; }
        if (!b) { cmp.missing++; if (cmp.examples.length < 8) cmp.examples.push(`missing ${a.type} ${h.toString(16)}`); continue; }
        // a fit-point spline: the DWG stores its fit points; AutoCAD's DXF adds control points
        // it computes, which the file does not hold: compare the fit points
        if (a.type === 'SPLINE' && Number(vals(b, 73)[0] || 0) === 0) groups = [71, 74, 11, 21];
        cmp.matched++;
        // R13-R14 DXF has no ARC_DIMENSION / LARGE_RADIAL_DIMENSION: AutoCAD writes one as an
        // INSERT of a proxy-graphics block it makes for the DXF; the DWG holds the dimension
        // and its own *D block, which is what the reader returns. Counted on its own line.
        const src = d.objects.get(h);
        if (a.type === 'INSERT' && b.type === 'DIMENSION' && d.v <= 14 && src && /^(ARC|LARGE_RADIAL)_DIMENSION$/.test(src.name)) {
          cmp.represented = (cmp.represented || 0) + 1;
          continue;
        }
        // a block reference: the block, by its record's handle (anonymous names are numbered
        // on output, by a counter of the writer's own). A record the DWG does not have is the
        // other save's (drift), not a difference.
        const blockOf = (r, M) => M.blocks.get(String(vals(r, 2)[0] || '').toUpperCase());
        if (a.type === 'INSERT' || a.type === 'DIMENSION') {
          groups = groups.filter((c) => c !== 2);
          const ka = blockOf(a, A), kb = blockOf(b, B);
          // drift both ways: the key's record is not in the DWG, or the DWG's record is not in
          // the key (AutoCAD regenerates a dynamic block's anonymous *U representations when it
          // writes DXF and re-points the references: acadsharp BLOCKPOLARPARAMETER's 40C)
          const keyRecs = new Set(A.blocks.values());
          if ((ka !== undefined && !d.objects.has(ka)) || (kb !== undefined && !keyRecs.has(kb))) cmp.notInFile++;
          else {
            cmp.fieldsCompared++;
            if (ka !== blockOf(b, B)) { cmp.valueDiff++; if (cmp.examples.length < 8) cmp.examples.push(`${a.type} ${h.toString(16)} block: ${vals(a, 2)[0]} vs ${vals(b, 2)[0]}`); }
          }
        }
        if (b.type !== a.type) { cmp.typeDiff++; if (cmp.examples.length < 8) cmp.examples.push(`type ${h.toString(16)}: ${a.type} vs ${b.type}`); continue; }
        const la = vals(a, 8)[0], lb = vals(b, 8)[0];
        if (a.type !== 'LAYER' && la !== undefined && lb !== undefined && la.toUpperCase() !== lb.toUpperCase()) { cmp.layerDiff++; if (cmp.examples.length < 8) cmp.examples.push(`layer ${a.type} ${h.toString(16)}: ${la} vs ${lb}`); }
        for (const c of groups) {
          const xa = vals(a, c), xb = vals(b, c);
          if (!xa.length) continue;
          const n = Math.min(xa.length, xb.length);
          cmp.fieldsCompared += xa.length;
          let bad = xa.length !== xb.length;
          for (let k = 0; k < n && !bad; k++) if (!same(xa[k], xb[k], c)) bad = true;
          if (bad) { cmp.valueDiff++; if (cmp.examples.length < 8) cmp.examples.push(`${a.type} ${h.toString(16)} group ${c}: ${xa.slice(0, 3).join(',')} vs ${xb.slice(0, 3).join(',')}`); }
        }
      }
      res.twin = cmp;
      if (cmp.missing || cmp.typeDiff || cmp.layerDiff || cmp.valueDiff) res.ok = false;
    } else res.notes.push('twin DXF is binary: not compared');
  }
  return res;
}

const args = process.argv.slice(2);
if (!args.length || args[0] === '-h' || args[0] === '--help') { console.log('usage: validate-dwg.mjs LIST.txt [--json OUT.json] [--md OUT.md]'); process.exit(args.length ? 0 : 2); }
const list = readFileSync(args[0], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => { const s = l.indexOf(' '); return [l.slice(0, s), l.slice(s + 1)]; });
const results = list.map(([std, p]) => validate(std, p));
const ji = args.indexOf('--json');
if (ji >= 0) writeFileSync(args[ji + 1], JSON.stringify(results, null, 1));
// per standard: files, files passing, objects, decoded, checks, twin comparisons
const by = {};
for (const r of results) {
  const s = (by[r.std] ||= { files: 0, pass: 0, objects: 0, decoded: 0, decodable: 0, checks: 0, checkFail: 0, twins: 0, matched: 0, fields: 0, diffs: 0 });
  s.files++; if (r.ok) s.pass++;
  s.objects += r.objects || 0;
  if (r.decoded) { s.decoded += r.decoded[0]; s.decodable += r.decoded[1]; }
  for (const [, [p, t]] of Object.entries(r.checks || {})) { s.checks += t; s.checkFail += t - p; }
  if (r.twin) { s.twins++; s.matched += r.twin.matched; s.fields += r.twin.fieldsCompared; s.diffs += r.twin.missing + r.twin.typeDiff + r.twin.layerDiff + r.twin.valueDiff; s.drift = (s.drift || 0) + r.twin.notInFile; }
}
const lines = ['| | Standard | Files passing | Objects | Decoded (of decodable) | Format checks failed (of run) | Files with a DXF twin | Twin objects matched | Twin fields compared | Twin differences | Twin handles not in the DWG |', '|---|---|---|---|---|---|---|---|---|---|---|'];
for (const [std, s] of Object.entries(by)) lines.push(`| ${s.pass === s.files ? '🟢' : '🔴'} | ${std} | ${s.pass} of ${s.files} | ${s.objects} | ${s.decoded} of ${s.decodable} | ${s.checkFail} of ${s.checks} | ${s.twins} | ${s.matched} | ${s.fields} | ${s.diffs} | ${s.drift || 0} |`);
console.log(lines.join('\n'));
for (const r of results) if (!r.ok) console.log(`FAIL ${r.std} ${r.path}: ${r.error || [...(r.checkFailures || []), ...Object.entries(r.decodeErrors || {}).map(([k, n]) => `decode ${k} x${n}`), ...((r.twin && r.twin.examples) || [])].join('; ')}`);
const mi = args.indexOf('--md');
if (mi >= 0) writeFileSync(args[mi + 1], lines.join('\n') + '\n');
process.exit(results.every((r) => r.ok) ? 0 : 1);
