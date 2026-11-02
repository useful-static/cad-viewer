// Compare two drawings given as DXF group-code pairs, object by object by handle (group 5):
// the answer key (AutoCAD's own DXF of the same drawing, or the same drawing read from another
// DWG version) against the reader's js/dwg.js dwgToPairs output. Used by validate-dwg.mjs and
// validate-dwg-versions.mjs, so both judge by the same rules.
import { readFileSync } from 'node:fs';
import { uncaret, valueKind } from '../js/dxf.js';

// the groups compared per DXF type (a group absent from the key is not compared)
export const GROUPS = {
  LINE: [10, 20, 30, 11, 21, 31], CIRCLE: [10, 20, 30, 40], ARC: [10, 20, 30, 40, 50, 51], POINT: [10, 20, 30],
  ELLIPSE: [10, 20, 30, 11, 21, 31, 40, 41, 42], TEXT: [10, 20, 40, 50, 1], MTEXT: [10, 20, 40, 71],
  INSERT: [2, 10, 20, 30, 41, 42, 50], LWPOLYLINE: [90, 10, 20, 42], SPLINE: [71, 72, 73, 74, 40, 10, 20],
  SOLID: [10, 20, 11, 21, 12, 22, 13, 23], TRACE: [10, 20, 11, 21, 12, 22, 13, 23], HATCH: [2, 70, 91],
  DIMENSION: [2, 10, 20], POLYLINE: [70], VERTEX: [10, 20, 30, 42], LAYER: [2, 62, 6],
};

// DXF defaults of compared groups a writer may leave out
const DEFAULTS = { INSERT: { 41: '1', 42: '1', 43: '1', 50: '0' } };

// a DXF $DWGCODEPAGE (ANSI_936...) as a TextDecoder label
const CP = { ANSI_874: 'windows-874', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5' };
const cpLabel = (cp) => CP[cp] || (/^ANSI_(125\d)$/.test(cp) ? `windows-${cp.slice(5)}` : 'windows-1252');

// \M+N: 1 Japanese, 2 Traditional Chinese, 3 Korean, 5 Simplified Chinese (DXF reference)
const MBCS = { 1: 'shift_jis', 2: 'big5', 3: 'euc-kr', 5: 'gbk' };
export function unescapeDxf(s) {
  if (s.indexOf('\\') < 0) return s;
  return s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, x) => String.fromCharCode(parseInt(x, 16)))
    .replace(/\\M\+([1-5])([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})/g, (m, n, a, b) => (MBCS[n] ? new TextDecoder(MBCS[n]).decode(new Uint8Array([parseInt(a, 16), parseInt(b, 16)])) : m));
}

export function dxfPairs(path) {
  // DXF from AutoCAD 2007 (AC1021) on is UTF-8; before, the drawing's ANSI code page
  // ($DWGCODEPAGE: a Chinese drawing's DXF is GBK, ANSI_936)
  const buf = readFileSync(path);
  const head = buf.subarray(0, 4000).toString('latin1');
  const m = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*AC(\d{4})/.exec(head);
  const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/.exec(head);
  const old = !(m && Number(m[1]) >= 1021);
  const t = new TextDecoder(old ? cpLabel(cp ? cp[1].toUpperCase() : '') : 'utf-8').decode(buf).split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 1 < t.length; i += 2) {
    const c = Number(t[i].trim());
    if (!Number.isInteger(c)) return null; // binary or malformed: no answer key
    // DXF escapes a character as \U+XXXX (outside the code page; the DWG stores it so to R2004,
    // and LibreDWG writes it in UTF-8 DXF too) or \M+NXXXX (a double-byte character of code
    // page N: ODA's R14 DXF of a Chinese drawing): the reader shows the characters
    const s = valueKind(c) === 's' ? uncaret(t[i + 1]) : t[i + 1];
    out.push([c, valueKind(c) === 's' ? unescapeDxf(s) : s]);
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
    // R2018 DXF: an MTEXT's embedded object (101 "Embedded Object") repeats 10/20/40/71 with
    // other meanings: the record ends there
    if (c === 101) { cur.embedded = true; continue; }
    if (cur.embedded) continue;
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

// a SPLINE record's curve (71 degree, 40 knots, 10/20 control points; weights ignored: only a
// non-rational spline is evaluated) at each distinct knot of its domain, by de Boor; null if
// rational or malformed
export function splineAtKnots(r) {
  const p = Number(vals(r, 71)[0]), U = vals(r, 40).map(Number);
  const P = vals(r, 10).map((x, k) => [Number(x), Number(vals(r, 20)[k])]);
  if (vals(r, 41).length || !(p >= 1) || U.length !== P.length + p + 1) return null;
  const lo = U[p], hi = U[U.length - p - 1];
  const at = (t) => {
    let k = p;
    while (k < U.length - p - 2 && t >= U[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) d.push([...P[j + k - p]]);
    for (let s = 1; s <= p; s++) for (let j = p; j >= s; j--) {
      const i = j + k - p, den = U[i + p + 1 - s] - U[i], al = den ? (t - U[i]) / den : 0;
      d[j] = [(1 - al) * d[j - 1][0] + al * d[j][0], (1 - al) * d[j - 1][1] + al * d[j][1]];
    }
    return d[p];
  };
  const ts = [...new Set(U.slice(p, U.length - p))].filter((t) => t >= lo && t <= hi);
  return ts.map((t) => at(t === hi ? hi - 1e-12 * Math.max(1, Math.abs(hi)) : t));
}
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
  // every difference is tallied by "TYPE group" (cmp.byField) as well as up to 8 examples
  cmp.byField = {};
  // every difference's identity, "handle|field", so two keys' differences can be matched
  cmp.diffIds = [];
  cmp.keyHas = new Set(A.keys());
  const ex = (s) => {
    if (cmp.examples.length < 8) cmp.examples.push(s);
    const id = /^\S+ ([0-9a-f]+) group (\d+)/.exec(s) || /^(?:missing|layer) \S+ ([0-9a-f]+)/.exec(s) || /^type ([0-9a-f]+)/.exec(s) || /^\S+ ([0-9a-f]+)/.exec(s);
    cmp.diffIds.push(id ? `${id[1]}|${id[2] || s.split(' ')[0]}` : s);
    const m = /^(\S+) [0-9a-f]+ group (\d+)/.exec(s) || /^(missing|type|layer) (\S+)/.exec(s) || [null, s.split(' ')[0], ''];
    const k = `${m[1]} ${m[2]}`.trim();
    cmp.byField[k] = (cmp.byField[k] || 0) + 1;
  };
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
    // a key that lists fit points (74/11/21) beside control points for a spline whose DWG holds
    // none (an R2010 file stores one or the other): the key's writer derived them, as the curve
    // at each distinct knot (ODA's DXF of AutoCAD-saved KoiPond: 19 points, within 1e-12). They
    // are checked so -- our control points and knots evaluated there -- and counted apart
    if (a.type === 'SPLINE' && Number(vals(a, 74)[0] || 0) > 0 && Number(vals(a, 73)[0] || 0) > 0
      && vals(a, 11).length === Number(vals(a, 74)[0]) && Number(vals(b, 74)[0] || 0) === 0 && Number(vals(b, 73)[0] || 0) > 0) {
      const fx = vals(a, 11).map(Number), fy = vals(a, 21).map(Number);
      const at = splineAtKnots(b);
      cmp.fieldsCompared += 2 * fx.length;
      const tol = (x) => 1e-9 * Math.max(1, Math.abs(x));
      const ok = at && at.length === fx.length && at.every((q, k) => Math.abs(q[0] - fx[k]) <= tol(fx[k]) && Math.abs(q[1] - fy[k]) <= tol(fy[k]));
      if (ok) { cmp.keyDerived = (cmp.keyDerived || 0) + 1; groups = groups.filter((c) => c !== 74); } else {
        cmp.valueDiff++; ex(`SPLINE ${h.toString(16)} key fit points ${fx.length} are not our curve at its knots (${at ? at.length : 'none'})`);
        groups = groups.filter((c) => c !== 74);
      }
    }
    // a key whose fit-point count (74) disagrees with the fit points it lists (11): the key
    // contradicts itself (ODA's R2010 DXF of acadsharp sample_base 434: 74 = 2, no 11), so its
    // count is not an answer; counted apart, the points still compared
    if (a.type === 'SPLINE' && vals(a, 74).length && Number(vals(a, 74)[0]) !== vals(a, 11).length) {
      groups = groups.filter((c) => c !== 74);
      cmp.keyInconsistent = (cmp.keyInconsistent || 0) + 1;
    }
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
      // an LWPOLYLINE's bulge (42) belongs to the vertex before it and may be left out when 0
      // (ours and ODA's leave zeros out, LibreDWG's writes every one): compared per vertex
      const perVertex = (r) => { const out = []; for (const [cc, vv] of r.g) { if (cc === 10) out.push('0'); else if (cc === 42 && out.length) out[out.length - 1] = vv; } return out; };
      let xa = a.type === 'LWPOLYLINE' && c === 42 ? perVertex(a) : vals(a, c), xb = a.type === 'LWPOLYLINE' && c === 42 ? perVertex(b) : vals(b, c);
      // a group DXF may leave out at its default (an INSERT's scale 41/42 at 1, rotation 50 at
      // 0: AutoCAD's and ODA's DXF leave them out, LibreDWG's writes them): absent = default
      const dflt = DEFAULTS[a.type] && DEFAULTS[a.type][c];
      if (dflt !== undefined) { if (!xa.length && xb.length === 1) xa = [dflt]; if (!xb.length && xa.length === 1) xb = [dflt]; }
      if (!xa.length) continue;
      cmp.fieldsCompared += xa.length;
      let bad = xa.length !== xb.length;
      for (let k = 0; k < Math.min(xa.length, xb.length) && !bad; k++) {
        const ok = opts.oldNames && (c === 2 || c === 6) ? oldName(xa[k]) === oldName(xb[k]) : same(xa[k], xb[k], c);
        if (!ok) bad = true;
      }
      // opts.knotTol (a save made by another writer): a knot vector of the same length whose knots
      // all moved by at most knotTol is that writer's change (the ODA writer parts repeated knots
      // by 1e-9; its own DXF of the file holds the moved values), counted apart
      if (bad && opts.knotTol && a.type === 'SPLINE' && c === 40 && xa.length === xb.length
        && xa.every((x, k) => Math.abs(Number(x) - Number(xb[k])) <= opts.knotTol)) { cmp.knotMoved = (cmp.knotMoved || 0) + 1; continue; }
      if (bad) { cmp.valueDiff++; ex(`${a.type} ${h.toString(16)} group ${c}: ${xa.slice(0, 3).join(',')} vs ${xb.slice(0, 3).join(',')}`); }
    }
  }
  cmp.differences = cmp.missing + cmp.typeDiff + cmp.layerDiff + cmp.valueDiff;
  return cmp;
}
