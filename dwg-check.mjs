#!/usr/bin/env node
// Read DWG files with js/dwg.js and report what the reader found: the version,
// every format check the file carries (passed / failed), the object types, and
// how many objects of the drawn types decoded. --dxf FILE writes the drawing as
// DXF (one file only); --json prints the report as JSON.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readDWG, dwgToPairs, pairsToDXF } from './js/dwg.js';
import { parseDXF } from './js/dxf.js';

const USAGE = 'usage: dwg-check.mjs FILE.dwg [FILE.dwg ...] [--dxf OUT.dxf] [--json]';
const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) { console.log(USAGE); process.exit(args.length ? 0 : 2); }
const json = args.includes('--json');
const di = args.indexOf('--dxf');
const dxfOut = di >= 0 ? args[di + 1] : null;
const files = args.filter((a, k) => !a.startsWith('--') && !(di >= 0 && k === di + 1));
let bad = 0;
const reports = [];
for (const f of files) {
  const rep = { file: f };
  try {
    const t0 = Date.now();
    // (a .dwg.gz, as the page opens one)
    let buf = readFileSync(f);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
    const d = readDWG(buf);
    rep.ms = Date.now() - t0;
    // savedBy: the AppInfo writer (Autodesk, ODA, another product's name; '' when not stated)
    Object.assign(rep, { version: d.version, release: d.release, savedBy: d.writer, objects: d.objects.size, mapped: d.mapCount, failures: d.failures,
      checks: Object.fromEntries(Object.entries(d.checks).map(([k, c]) => [k, `${c.pass}/${c.pass + c.fail}`])),
      header: { INSUNITS: d.header.INSUNITS, LTSCALE: d.header.LTSCALE, EXTMIN: d.header.EXTMIN, EXTMAX: d.header.EXTMAX, error: d.header.error } });
    const types = {};
    for (const o of d.objects.values()) {
      const t = (types[o.name] ||= { n: 0, decoded: 0, errors: 0 });
      t.n++; if (o.decoded) t.decoded++; if (o.error) { t.errors++; t.lastError = o.error; }
    }
    rep.types = types;
    // what a drawing holds, by name: its layers and its named (not anonymous) blocks
    rep.layers = [...d.objects.values()].filter((o) => o.name === 'LAYER' && o.d).map((o) => o.d.name);
    rep.blocks = [...d.objects.values()].filter((o) => o.name === 'BLOCK_RECORD' && o.d && !o.d.name.startsWith('*')).map((o) => o.d.name);
    const P = dwgToPairs(d);
    rep.pairs = P.length;
    if (dxfOut) writeFileSync(dxfOut, pairsToDXF(P));
    // and drawn as the page draws it (parseDXF over the pairs, js/read-file.js readDrawing): a DWG
    // the page refuses, or that draws nothing, is not "all checks pass"
    try {
      const dr = parseDXF(P);
      rep.drawn = { paths: dr.paths.length, texts: dr.texts.length, layouts: dr.layouts.length };
      if (!dr.paths.length && !dr.texts.length && !dr.layouts.some((l) => l.paths.length || l.texts.length)) rep.drawError = 'has nothing to draw';
    } catch (e) { rep.drawError = e.message; }
    if (d.failures.length || rep.drawError) bad++;
  } catch (err) {
    rep.error = String(err.stack || err);
    bad++;
  }
  reports.push(rep);
  if (!json) {
    console.log(`${f}: ${rep.release || '?'} ${rep.error ? 'ERROR ' + rep.error.split('\n')[0] : `${rep.objects} objects, ${rep.ms} ms, ${rep.failures.length ? 'FAILED ' + rep.failures.join('; ') : rep.drawError ? `NOT DRAWN: ${rep.drawError}` : `all checks pass, drawn: ${rep.drawn.paths} paths, ${rep.drawn.texts} texts`}`}`);
  }
}
if (json) console.log(JSON.stringify(reports, null, 1));
process.exit(bad ? 1 : 0);
