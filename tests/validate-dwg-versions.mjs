#!/usr/bin/env node
// One drawing saved in several DWG versions must read the same in each. Given a directory with
// one sub-directory per version holding the same file names (the LibreDWG Test Suite 0.1 layout:
// R13/ R14/ 2000/ 2004/ 2007/, each NNN.dwg, made in AutoCAD; AutoCAD keeps the handles across a
// save-as), read every save and compare it, object by object by handle, with the first version's
// (tests/dwg-compare.mjs rules): each container and encoding is checked against the others.
//
//   node tests/validate-dwg-versions.mjs DIR [--json OUT.json]
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { readDWG, dwgToPairs } from '../js/dwg.js';
import { byHandle, compare, GROUPS, vals } from './dwg-compare.mjs';

// the drawing's content regardless of handles: each object's type and compared fields, as a
// sorted list (names upper-cased, R13/R14 style). A save that renumbered its handles has the
// same content under other handles; one that differs, does not.
const content = (M) => [...M.values()].filter((r) => GROUPS[r.type] && r.type !== 'VERTEX' && r.type !== 'POLYLINE' && r.type !== 'LWPOLYLINE')
  .map((r) => `${r.type}|${GROUPS[r.type].filter((c) => c !== 2 && c !== 6).map((c) => vals(r, c).map((x) => (Number.isFinite(Number(x)) ? Number(x).toFixed(6) : x.toUpperCase().replace(/[^A-Z0-9_$-]/g, '_'))).join(',')).join('|')}`).sort();

const args = process.argv.slice(2);
if (!args.length || args[0] === '-h' || args[0] === '--help') { console.log('usage: validate-dwg-versions.mjs DIR [--json OUT.json] [--other-writer V,V]'); process.exit(args.length ? 0 : 2); }
const dir = args[0];
// --other-writer 2010,2013: those version directories were saved by another writer than the
// reference's (the ODA File Converter, from AutoCAD's saves): knot vectors it moved by at most
// 1e-8 are counted apart (dwg-compare.mjs opts.knotTol), never silently passed
const ow = args.indexOf('--other-writer');
const otherWriter = new Set(ow >= 0 ? args[ow + 1].split(',') : []);
const vers = ['R13', 'R14', '2000', '2004', '2007', '2010', '2013', '2018'].filter((v) => existsSync(`${dir}/${v}`));
const [ref, ...others] = vers;
const names = readdirSync(`${dir}/${ref}`).filter((n) => /\.dwg$/i.test(n)).sort();
const tot = Object.fromEntries(others.map((v) => [v, { drawings: 0, matched: 0, fields: 0, differences: 0, onlyOneSide: 0, failed: [] }]));
const rows = [];
for (const n of names) {
  let A, refV;
  try { const d = readDWG(readFileSync(`${dir}/${ref}/${n}`)); A = byHandle(dwgToPairs(d)); refV = d.v; } catch (err) { rows.push({ n, error: `${ref}: ${err.message}` }); continue; }
  for (const v of others) {
    const p = `${dir}/${v}/${n}`;
    if (!existsSync(p)) continue;
    const t = tot[v];
    t.drawings++;
    try {
      const d = readDWG(readFileSync(p));
      // R13 / R14 saves: no extended names; R13: no LWPOLYLINE (dwg-compare.mjs opts)
      const opts = { oldNames: refV <= 14 || d.v <= 14, lwpoly: refV <= 13 || d.v <= 13, handlesReused: true, knotTol: otherWriter.has(v) ? 1e-8 : 0 };
      const B = byHandle(dwgToPairs(d));
      const cmp = compare(A, B, (h) => d.objects.has(h), d.v, (h) => d.objects.get(h), opts);
      if (cmp.differences && JSON.stringify(content(A)) === JSON.stringify(content(B))) {
        // the same content under other handles: a save that renumbered (counted apart)
        t.renumbered = (t.renumbered || []).concat(n);
        cmp.differences = 0;
      }
      t.matched += cmp.matched; t.fields += cmp.fieldsCompared; t.differences += cmp.differences; t.onlyOneSide += cmp.notInFile; t.reused = (t.reused || 0) + (cmp.reused || 0); t.knotMoved = (t.knotMoved || 0) + (cmp.knotMoved || 0);
      if (cmp.differences) t.failed.push(`${n}: ${cmp.examples.slice(0, 3).join('; ')}`);
    } catch (err) { t.differences++; t.failed.push(`${n}: ${err.message}`); }
  }
}
const rn = (t) => { const r = t.renumbered || []; return r.length ? `${r.length} (${r.slice(0, 3).join(', ')}${r.length > 3 ? ', ...' : ''})` : '0'; };
const lines = [`| | ${ref} against | Drawings | Objects matched by handle | Fields compared | Differences | Objects in one save only | Handles the save gave another object | Saves that renumbered (same content) | Knot vectors the writer moved (≤ 1e-8) |`, '|---|---|---|---|---|---|---|---|---|---|'];
for (const [v, t] of Object.entries(tot)) lines.push(`| ${t.differences ? '🔴' : '🟢'} | ${v}${otherWriter.has(v) ? ' (other writer)' : ''} | ${t.drawings} | ${t.matched} | ${t.fields} | ${t.differences} | ${t.onlyOneSide} | ${t.reused || 0} | ${rn(t)} | ${t.knotMoved || 0} |`);
console.log(lines.join('\n'));
for (const [v, t] of Object.entries(tot)) for (const f of t.failed.slice(0, 10)) console.log(`DIFF ${v} ${f}`);
for (const r of rows) console.log(`ERROR ${r.n} ${r.error}`);
const ji = args.indexOf('--json');
if (ji >= 0) writeFileSync(args[ji + 1], JSON.stringify({ tot, rows }, null, 1));
process.exit(Object.values(tot).every((t) => !t.differences) && !rows.length ? 0 : 1);
