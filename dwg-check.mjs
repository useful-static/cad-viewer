#!/usr/bin/env node
// Read DWG files with js/dwg.js and report what the reader found: the version,
// every format check the file carries (passed / failed), the object types, and
// how many objects of the drawn types decoded. --dxf FILE writes the drawing as
// DXF (one file only); --json prints the report as JSON.
import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readDWG, dwgToPairs, pairsToDXF, drawDWG } from './js/dwg.js';
import { drawsNothing, isShape, sheetsOf } from './js/dxf.js';
import { CliError, checkOutput, parseCli, readInput, runCli } from './js/cli-args.js';

const USAGE = 'usage: dwg-check.mjs FILE.dwg [FILE.dwg ...] [--dxf OUT.dxf] [--json]';
// (the tools' one argument rule, js/cli-args.js: an unknown option -- --jsn was taken for a file
// name -- a --dxf with no value, or given twice, is a usage error, on stderr as the others')
const usageError = (msg) => { console.error(`dwg-check: ${msg}\n${USAGE}`); process.exit(2); };
let parsed;
try { parsed = parseCli(process.argv.slice(2), { values: ['--dxf'], flags: ['--json'] }); } catch (e) { if (e instanceof CliError) usageError(e.message); throw e; }
if (parsed.help) { console.log(USAGE); process.exit(0); }
const json = !!parsed.opts['--json'];
const dxfOut = parsed.opts['--dxf'] || null;
const files = parsed.pos;
// (no drawing given, and --dxf with more than one -- each overwrote the one file -- are usage errors)
if (!files.length) usageError('no DWG file given');
if (dxfOut && files.length > 1) usageError('--dxf writes one file: give one DWG');

// One drawing's report, its pairs (for --dxf; null when it could not be read) and, when it could
// not, the reader's message (the row's words, not "Error: ...")
async function check(f) {
  const rep = { file: f };
  try {
    const t0 = Date.now();
    // (a .dwg.gz, as the page opens one; read in the five tools' one wording)
    let buf = await readInput(f);
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
    // and drawn as the page draws it (drawDWG over these pairs, as js/read-file.js readDrawing
    // does over the same reader's), refused by the page's own rule (drawsNothing): a DWG the page
    // refuses, or that draws nothing, is not "all checks pass"
    try {
      const dr = drawDWG(d, P);
      // (and what it holds that is not drawn, by kind, as the page's info panel says it)
      rep.drawn = { paths: dr.paths.filter(isShape).length, texts: dr.texts.length, layouts: sheetsOf(dr).length, notDrawn: dr.notDrawn };
      if (drawsNothing(dr)) rep.drawError = 'has nothing to draw';
    } catch (e) { rep.drawError = e.message; }
    return { rep, P, bad: !!(d.failures.length || rep.drawError), why: '' };
  } catch (err) {
    rep.error = String(err.stack || err);
    // (the row names the file: readInput's words without the path)
    return { rep, P: null, bad: true, why: err?.reason || (err && err.message ? err.message : String(err)) };
  }
}

// One row per drawing, its own verdict (a drawing it cannot read is that row's ERROR, exit 1 at
// the end); a failure of the tool itself -- the --dxf it cannot write -- is said by runCli in the
// five tools' one shape, "dwg-check: ...", one line, exit 1.
async function main() {
  if (dxfOut) await checkOutput(dxfOut);
  let bad = 0;
  const reports = [];
  for (const f of files) {
    const { rep, P, bad: failed, why } = await check(f);
    if (failed) bad++;
    reports.push(rep);
    if (dxfOut && P) {
      try { writeFileSync(dxfOut, pairsToDXF(P)); } catch (e) { throw new Error(`could not write ${dxfOut}: ${e.message}`); }
    }
    if (!json) {
      console.log(`${f}: ${rep.release || '?'} ${rep.error ? `ERROR ${why}` : `${rep.objects} objects, ${rep.ms} ms, ${rep.failures.length ? 'FAILED ' + rep.failures.join('; ') : rep.drawError ? `NOT DRAWN: ${rep.drawError}` : `all checks pass, drawn: ${rep.drawn.paths} paths, ${rep.drawn.texts} texts${Object.keys(rep.drawn.notDrawn || {}).length ? `; not drawn: ${Object.entries(rep.drawn.notDrawn).map(([k, n]) => `${n} ${k}`).join(', ')}` : ''}`}`}`);
    }
  }
  if (json) console.log(JSON.stringify(reports, null, 1));
  process.exit(bad ? 1 : 0);
}
await runCli('dwg-check', main);
