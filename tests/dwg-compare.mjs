// Compare two drawings given as DXF group-code pairs, object by object by handle (group 5):
// the answer key (AutoCAD's own DXF of the same drawing, or the same drawing read from another
// DWG version) against the reader's js/dwg.js dwgToPairs output. Used by validate-dwg.mjs and
// validate-dwg-versions.mjs, so both judge by the same rules.
import { readFileSync } from 'node:fs';

// the groups compared per DXF type (a group absent from the key is not compared)
export const GROUPS = {
  LINE: [10, 20, 30, 11, 21, 31], CIRCLE: [10, 20, 30, 40], ARC: [10, 20, 30, 40, 50, 51], POINT: [10, 20, 30],
  ELLIPSE: [10, 20, 30, 11, 21, 31, 40, 41, 42], TEXT: [10, 20, 40, 50, 1], MTEXT: [10, 20, 40, 71],
  INSERT: [2, 10, 20, 30, 41, 42, 50], LWPOLYLINE: [90, 10, 20, 42], SPLINE: [71, 72, 73, 74, 40, 10, 20],
  SOLID: [10, 20, 11, 21, 12, 22, 13, 23], TRACE: [10, 20, 11, 21, 12, 22, 13, 23], HATCH: [2, 70, 91],
  DIMENSION: [2, 10, 20], POLYLINE: [70], VERTEX: [10, 20, 30, 42], LAYER: [2, 62, 6],
};

export function dxfPairs(path) {
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

// records keyed by handle from TABLES (LAYER), BLOCKS and ENTITIES; .blocks: block name -> record handle
export function byHandle(P) {
  const m = new Map();
  const blocks = new Map();
  let sec = null, cur = null, poly = null;
  for (let i = 0; i < P.length; i++) {
    const [c, v] = P[i];
    if (c === 0 && String(v).trim() === 'SECTION') { sec = String((P[i + 1] || [])[1] || '').trim(); cur = null; continue; }
    if (c === 0) {
      cur = { type: String(v).trim(), g: [] };
      // a POLYLINE's VERTEX records follow it to SEQEND: kept on it as its points (pts)
      if (cur.type === 'POLYLINE') { poly = cur; cur.pts = []; } else if (cur.type === 'VERTEX' && poly) cur.of = poly; else if (cur.type === 'SEQEND') poly = null;
      if (sec === 'ENTITIES' || sec === 'BLOCKS' || (sec === 'TABLES' && cur.type === 'LAYER')) cur.keep = true;
      if (sec === 'TABLES' && cur.type === 'BLOCK_RECORD') cur.rec = true;
      continue;
    }
    if (!cur) continue;
    const s = String(v).trim();
    if (c === 5 && cur.h === undefined) { cur.h = parseInt(s, 16); if (cur.keep) m.set(cur.h, cur); }
    if (c === 2 && cur.rec && cur.h !== undefined) blocks.set(s.toUpperCase(), cur.h);
    if (cur.of && c === 10) cur.of.pts.push([s]);
    if (cur.of && c === 20) cur.of.pts[cur.of.pts.length - 1].push(s);
    cur.g.push([c, s]);
  }
  m.blocks = blocks;
  return m;
}
export const vals = (r, c) => r.g.filter((x) => x[0] === c).map((x) => x[1]);
export function same(a, b, c) {
  if (c === 1 || c === 2 || c === 6) return a === b || a.toUpperCase() === b.toUpperCase();
  const x = Number(a), y = Number(b);
  if (c === 62) return Math.abs(x) === Math.abs(y) && Math.sign(x || 1) === Math.sign(y || 1);
  if ((c === 50 || c === 51) && Number.isFinite(x) && Number.isFinite(y)) { const d = Math.abs(((x - y) % 360 + 540) % 360 - 180); return d < 1e-6; }
  return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
}

// compare key A against ours B; inFile(h): the DWG's own object map has handle h; dwgV: the DWG's
// version number; src(h): the DWG object of handle h
// opts.oldNames: one side was saved as R13/R14, which has no extended names: AutoCAD upper-cases
// them and turns what R14 does not allow into "_" ("Layer 1" is "LAYER_1"): names compare so.
// opts.lwpoly: one side is R13, which has no LWPOLYLINE: a 2D polyline is a POLYLINE with VERTEX
// records there, an LWPOLYLINE from R14 on: compared by their points.
const oldName = (s) => s.toUpperCase().replace(/[^A-Z0-9_$-]/g, '_');
export function compare(A, B, inFile, dwgV, src, opts = {}) {
  const cmp = { matched: 0, missing: 0, notInFile: 0, represented: 0, typeDiff: 0, layerDiff: 0, valueDiff: 0, fieldsCompared: 0, examples: [] };
  const ex = (s) => { if (cmp.examples.length < 8) cmp.examples.push(s); };
  const keyRecs = new Set(A.blocks.values());
  const blockOf = (r, M) => M.blocks.get(String(vals(r, 2)[0] || '').toUpperCase());
  for (const [h, a] of A) {
    let groups = GROUPS[a.type];
    if (!groups) continue;
    const b = B.get(h);
    // a handle the DWG's object map does not have: the key was written from another save
    // (drift); counted apart, not a reader failure
    if (!b && !inFile(h)) { cmp.notInFile++; continue; }
    // opts.handlesReused (two saves of one drawing): a handle the other save gave to an object of
    // another kind (a freed VERTEX handle reused for an XRECORD, a STYLE) is counted apart
    const other = src(h);
    if (!b && opts.handlesReused && other && !other.e) { cmp.reused = (cmp.reused || 0) + 1; continue; }
    if (!b) { cmp.missing++; ex(`missing ${a.type} ${h.toString(16)}`); continue; }
    // a fit-point spline: the DWG holds its fit points; AutoCAD's DXF adds control points it
    // computes, which the file does not hold: compare the fit points
    if (a.type === 'SPLINE' && Number(vals(b, 73)[0] || 0) === 0) groups = [71, 74, 11, 21];
    cmp.matched++;
    // R13-R14 DXF has no ARC_DIMENSION / LARGE_RADIAL_DIMENSION: AutoCAD writes one as an INSERT
    // of a proxy block it makes for the DXF; the DWG holds the dimension and its own *D block
    const o = src(h);
    if (a.type === 'INSERT' && b.type === 'DIMENSION' && dwgV <= 14 && o && /^(ARC|LARGE_RADIAL)_DIMENSION$/.test(o.name)) { cmp.represented++; continue; }
    if (opts.lwpoly && a.type === 'POLYLINE' && b.type === 'LWPOLYLINE') {
      const xs = vals(b, 10), ys = vals(b, 20);
      cmp.fieldsCompared += 2 * a.pts.length;
      const ok = a.pts.length === xs.length && a.pts.every((p, k) => same(p[0], xs[k], 10) && same(p[1], ys[k], 20));
      if (!ok) { cmp.valueDiff++; ex(`POLYLINE/LWPOLYLINE ${h.toString(16)} points: ${a.pts.length} vs ${xs.length}`); }
      continue;
    }
    if (b.type !== a.type && opts.handlesReused) { cmp.reused = (cmp.reused || 0) + 1; continue; }
    if (b.type !== a.type) { cmp.typeDiff++; ex(`type ${h.toString(16)}: ${a.type} vs ${b.type}`); continue; }
    if (a.type === 'INSERT' || a.type === 'DIMENSION') {
      // the block by its record's handle (anonymous names are numbered by each writer); a
      // record one side does not have is drift (another save; AutoCAD regenerating a dynamic
      // block's *U representations on DXF output)
      groups = groups.filter((c) => c !== 2);
      const ka = blockOf(a, A), kb = blockOf(b, B);
      if ((ka !== undefined && !inFile(ka)) || (kb !== undefined && !keyRecs.has(kb))) cmp.notInFile++;
      else { cmp.fieldsCompared++; if (ka !== kb) { cmp.valueDiff++; ex(`${a.type} ${h.toString(16)} block: ${vals(a, 2)[0]} vs ${vals(b, 2)[0]}`); } }
    }
    const nm = (s) => (opts.oldNames ? oldName(s) : s.toUpperCase());
    const la = vals(a, 8)[0], lb = vals(b, 8)[0];
    if (a.type !== 'LAYER' && la !== undefined && lb !== undefined && nm(la) !== nm(lb)) { cmp.layerDiff++; ex(`layer ${a.type} ${h.toString(16)}: ${la} vs ${lb}`); }
    for (const c of groups) {
      const xa = vals(a, c), xb = vals(b, c);
      if (!xa.length) continue;
      cmp.fieldsCompared += xa.length;
      let bad = xa.length !== xb.length;
      for (let k = 0; k < Math.min(xa.length, xb.length) && !bad; k++) {
        const ok = opts.oldNames && (c === 2 || c === 6) ? oldName(xa[k]) === oldName(xb[k]) : same(xa[k], xb[k], c);
        if (!ok) bad = true;
      }
      if (bad) { cmp.valueDiff++; ex(`${a.type} ${h.toString(16)} group ${c}: ${xa.slice(0, 3).join(',')} vs ${xb.slice(0, 3).join(',')}`); }
    }
  }
  cmp.differences = cmp.missing + cmp.typeDiff + cmp.layerDiff + cmp.valueDiff;
  return cmp;
}
