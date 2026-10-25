#!/usr/bin/env node
// Data for the conversion-time estimate (js/import-progress.js): for each
// STEP file, its features (js/step-features.js) and how long the conversion
// took, with each step's time. One converter instance is loaded once, so its
// start-up is not in the times.
//
//   node tests/estimate-calibrate.mjs [--occt DIR] [--repeat N] FILE... > data.jsonl
//
// One JSON line per file: { file, ...features, secs, read, transfer, mesh, write }.
// Times are the median of --repeat runs (default 1). Run on an idle machine.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TESSELLATION } from '../js/cadmesh.js';
import { stepFeatures } from '../js/step-features.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let occtDir = join(HERE, '..', 'vendor', 'occt-import-js');
let repeat = 1;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--occt') occtDir = args[++i];
  else if (args[i] === '--repeat') repeat = Number(args[++i]);
  else if (args[i] === '-h' || args[i] === '--help') {
    process.stdout.write('usage: estimate-calibrate.mjs [--occt DIR] [--repeat N] FILE...\n');
    process.exit(0);
  } else files.push(args[i]);
}

let marks = [];
const occt = await createRequire(import.meta.url)(join(occtDir, 'occt-import-js.js'))({
  locateFile: (p) => join(occtDir, p),
  onProgress: (phase, fraction) => marks.push([phase, fraction, performance.now()]),
});
const fmt = { stp: 'step', step: 'step', igs: 'iges', iges: 'iges', brep: 'brep' };
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

for (const file of files) {
  const bytes = readFileSync(file);
  const features = stepFeatures(bytes);
  const runs = [];
  for (let r = 0; r < repeat; r++) {
    marks = [];
    const t0 = performance.now();
    const res = occt.ReadFile(fmt[file.split('.').pop().toLowerCase()] || 'step', new Uint8Array(bytes), DEFAULT_TESSELLATION);
    const t1 = performance.now();
    if (!res || !res.success) { runs.push(null); continue; }
    // step boundaries: the first report of each phase, and meshing's end
    const first = (p) => (marks.find((m) => m[0] === p) || [])[2];
    const meshEnd = (marks.filter((m) => m[0] === 3 && m[1] >= 1)[0] || [])[2] ?? t1;
    const tr = first(2) ?? t0, ms = first(3) ?? tr;
    runs.push({ secs: (t1 - t0) / 1000, read: (tr - t0) / 1000, transfer: (ms - tr) / 1000,
      mesh: (meshEnd - ms) / 1000, write: (t1 - meshEnd) / 1000 });
  }
  const ok = runs.filter(Boolean);
  const row = { file: basename(file), ...features, ok: ok.length === runs.length };
  if (ok.length) for (const k of ['secs', 'read', 'transfer', 'mesh', 'write']) row[k] = +median(ok.map((x) => x[k])).toFixed(3);
  process.stdout.write(JSON.stringify(row) + '\n');
}
