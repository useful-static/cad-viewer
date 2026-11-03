#!/usr/bin/env node
// A .cadmesh (or .cadmesh.gz) to the standard mesh formats, offline: the same writers as the
// viewer's File > Export (js/export-mesh.js) -- STL (binary, mm, no colour), 3MF (mm, one object
// per body, colours) and GLB (metres, one node per body, colours) -- each turned as the viewer
// turns it: Z up for STL and 3MF, Y up for GLB.
//
//   node cadmesh-export.mjs <in.cadmesh[.gz]> [--to stl,3mf,glb] [--out <base>]
//                           [--orient <up,front> | --model-up y|z] [--skip <regex>]
//
//   --to        formats to write (default: all three)
//   --out       output path without extension (default: the input's, less .cadmesh[.gz])
//   --orient    the model's orientation as the viewer takes it (js/orient.js: "+z-y",
//               "up:+z,front:-y"), the axes then derived as File > Export derives them
//   --model-up  shorthand: z (+z-y: up +z, front -y, STEP's usual; the default) or y (+y+z: up +y,
//               front +z, glTF's convention, e.g. models a script wrote in it)
//   --skip      leave out the bodies whose label ("owner › body", as the page shows it) or name
//               matches (e.g. annotation geometry such as airflow arrows)
//
// Prints one line per file written: name, bodies, bytes. Exit 0 = all written (or -h); 1 = the
// input refused (damaged, or nothing to export); 2 = usage.
// Test: tests/test-cadmesh-export.mjs.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bodyLabels, decodeCadmesh, inflateCadmesh } from './js/cadmesh.js';
import { EXPORTS, exportBasis, exportable } from './js/export-mesh.js';
import { DEFAULT_ORIENT, Z_UP_ORIENT, parseOrient } from './js/orient.js';

// --model-up's two names for orientations
const MODEL_UP = { z: Z_UP_ORIENT, y: DEFAULT_ORIENT };

function usage(msg, code = 2) {
  if (msg) console.error(`cadmesh-export: ${msg}`);
  console.error('usage: node cadmesh-export.mjs <in.cadmesh[.gz]> [--to stl,3mf,glb] [--out <base>] [--orient <up,front> | --model-up y|z] [--skip <regex>]');
  process.exit(code);
}

// orient: the model's orientation ("+z-y"); modelUp ('z' | 'y') names one, for callers before orient
export async function exportCadmesh(bytes, { to = Object.keys(EXPORTS), modelUp = 'z', orient = MODEL_UP[modelUp], skip = null, base = 'model' } = {}) {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const model = decodeCadmesh(await inflateCadmesh(ab));
  // (bodies labelled as the page labels them, "owner › body"; --skip matches the label or the name;
  // the bodies with a triangle, as the page exports, counted as written)
  const labels = bodyLabels(model.header);
  const named = model.header.meshes.map((m, i) => i + 1).filter((id) => !(skip && (skip.test(labels[id - 1] || '') || skip.test(model.header.meshes[id - 1].name || ''))));
  const ids = exportable(model, named);
  if (!ids.length) throw new Error('nothing to export (no body left has a triangle)');
  const names = ids.map((id) => labels[id - 1]);
  const out = [];
  for (const kind of to) {
    const ex = EXPORTS[kind];
    if (!ex) throw new Error(`unknown format "${kind}" (stl, 3mf, glb)`);
    const data = await ex.write(model, ids, exportBasis(orient, ex.up), { base, names });
    const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    out.push({ kind, bytes: buf, bodies: ids.length, of: model.header.meshes.length });
  }
  return out;
}

async function main() {
  const a = process.argv.slice(2);
  if (!a.length) usage();
  if (a.includes('-h') || a.includes('--help')) usage(null, 0); // (help is not an error, as the other CLIs)
  // (an option given with no value is a usage error: --to or --out alone fell back to the default)
  const opt = (k) => { const i = a.indexOf(k); if (i < 0) return undefined; const v = a[i + 1]; if (v === undefined || v.startsWith('--')) usage(`${k} needs a value`); return v; };
  const inp = a.find((x, i) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
  if (!inp) usage('no input file');
  const to = (opt('--to') || 'stl,3mf,glb').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const k of to) if (!EXPORTS[k]) usage(`--to: unknown format "${k}" (stl, 3mf, glb)`);
  const modelUp = opt('--model-up') || 'z';
  if (!MODEL_UP[modelUp]) usage(`--model-up must be y or z, not "${modelUp}"`);
  let orient = MODEL_UP[modelUp];
  if (opt('--orient')) { try { orient = parseOrient(opt('--orient')); } catch (e) { usage(`--orient: ${e.message}`); } }
  const skipSrc = opt('--skip');
  let skip = null;
  if (skipSrc) { try { skip = new RegExp(skipSrc); } catch (e) { usage(`--skip: ${e.message}`); } } // (an option's error, not the input's)
  const base = opt('--out') || inp.replace(/\.cadmesh(\.gz)?$/i, '');
  let files;
  try {
    files = await exportCadmesh(readFileSync(inp), { to, orient, skip, base: base.split('/').pop() });
  } catch (e) {
    // (a damaged or unreadable input is a refusal, exit 1 -- not a usage error, exit 2, which is for
    // the options)
    console.error(`${inp}: ${e.message}`);
    process.exit(1);
  }
  for (const f of files) {
    const path = `${base}.${f.kind}`;
    // (a write that fails is said in one line, exit 1: node's stack trace was all it printed)
    try { writeFileSync(path, f.bytes); } catch (e) { console.error(`cadmesh-export: could not write ${path}: ${e.message}`); process.exit(1); }
    console.log(`${path}: ${f.bodies} of ${f.of} bodies, ${f.bytes.length} bytes`);
  }
}

// run as a command (a path with a space, or through a symlink, included: the plain
// "file://" + argv[1] test was false there, and the tool exited 0 writing nothing)
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
