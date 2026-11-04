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
import { EXPORTS, NOTHING_TO_EXPORT, exportBasis, exportable } from './js/export-mesh.js';
import { DEFAULT_ORIENT, Z_UP_ORIENT, parseOrient } from './js/orient.js';
import { CliError, parseCli, runCli } from './js/cli-args.js';

// --model-up's two names for orientations
const MODEL_UP = { z: Z_UP_ORIENT, y: DEFAULT_ORIENT };

// the formats, from the writers' own table (js/export-mesh.js EXPORTS: written out four times here)
const KINDS = Object.keys(EXPORTS);
const KIND_WORDS = `(${KINDS.join(', ')})`;

// (help on stdout, exit 0, as the other tools; a usage error on stderr, exit 2)
function usage(msg, code = 2) {
  if (msg) console.error(`cadmesh-export: ${msg}`);
  (code ? console.error : console.log)(`usage: node cadmesh-export.mjs <in.cadmesh[.gz]> [--to ${KINDS.join(',')}] [--out <base>] [--orient <up,front> | --model-up y|z] [--skip <regex>]`);
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
  if (!ids.length) throw new Error(NOTHING_TO_EXPORT);
  const names = ids.map((id) => labels[id - 1]);
  const out = [];
  for (const kind of to) {
    const ex = EXPORTS[kind];
    if (!ex) throw new Error(`unknown format "${kind}" ${KIND_WORDS}`);
    const data = await ex.write(model, ids, exportBasis(orient, ex.up), { base, names });
    const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    out.push({ kind, bytes: buf, bodies: ids.length, of: model.header.meshes.length });
  }
  return out;
}

async function main() {
  // (the tools' one argument rule, js/cli-args.js: an unknown or repeated option, a value that is
  // an option, a second input -- each a usage error)
  let r;
  try { r = parseCli(process.argv.slice(2), { values: ['--to', '--out', '--orient', '--model-up', '--skip'], max: 1 }); } catch (e) { if (e instanceof CliError) usage(e.message); throw e; }
  if (r.help) usage(null, 0); // (help is not an error, as the other CLIs)
  const opt = (k) => r.opts[k];
  const inp = r.pos[0];
  if (!inp) usage('no input file');
  const to = (opt('--to') || KINDS.join(',')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!to.length) usage('--to names no format');
  for (const k of to) if (!EXPORTS[k]) usage(`--to: unknown format "${k}" ${KIND_WORDS}`);
  // (a format named twice wrote and printed the one file twice)
  if (new Set(to).size < to.length) usage('--to names a format twice');
  // (--orient and --model-up are alternatives: the one silently overrode the other)
  if (opt('--orient') && opt('--model-up')) usage('give one of --orient / --model-up');
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
    // the options -- said by runCli in the five tools' one shape, "cadmesh-export: ...")
    throw new Error(`${inp}: ${e.message}`);
  }
  for (const f of files) {
    const path = `${base}.${f.kind}`;
    // (a write that fails is said in one line, exit 1: node's stack trace was all it printed)
    try { writeFileSync(path, f.bytes); } catch (e) { throw new Error(`could not write ${path}: ${e.message}`); }
    console.log(`${path}: ${f.bodies} of ${f.of} bodies, ${f.bytes.length} bytes`);
  }
}

// run as a command (a path with a space, or through a symlink, included: the plain
// "file://" + argv[1] test was false there, and the tool exited 0 writing nothing)
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await runCli('cadmesh-export', main);
