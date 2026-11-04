#!/usr/bin/env node
// Tessellate a STEP / IGES / BREP file into a .cadmesh the viewer loads
// instantly. Same OpenCascade build (occt-import-js) and the same packing code
// (js/cadmesh.js) as the in-browser import, so the two paths cannot disagree.

import { closeSync, existsSync, openSync, readSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants as zlibConstants, gunzipSync, gzipSync } from 'node:zlib';
import { BODY_KINDS, conversionModel, decodeCadmesh, encodeCadmesh, hashName, noSurfaces, DEFAULT_TESSELLATION } from './js/cadmesh.js';
import { sourceUnits } from './js/source-units.js';
import { withoutBom } from './js/step-text.js';
import { FORMATS as CAD_FORMATS, SNIFF_BYTES, sniffFormat } from './js/formats.js';
import { CliError, CliHelp, checkOutput, parseCli, positive, readInput, runCli } from './js/cli-args.js';
import { circleMinPoints } from './js/measure-geom.js';
import { BODY_FACTS } from './js/edges.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// (the extensions from the viewer's format table, js/formats.js: written out here, .brp was missing)
const CAD_EXTS = CAD_FORMATS.filter((f) => f.kind === 'cad').flatMap((f) => f.ext);
const USAGE = `usage: stp2mesh.mjs <in${CAD_EXTS.map((e) => `.${e}`).join('|')}>[.gz] [-o out.cadmesh]
                    [--deflection R] [--absolute MM] [--angular RAD] [--occt DIR | --threads]

  -o FILE          output (default: input with .cadmesh)
  --deflection R   linear deflection as a ratio of the bounding box (default ${DEFAULT_TESSELLATION.linearDeflection})
  --absolute MM    linear deflection as an absolute chord error in mm (instead of --deflection)
  --angular RAD    angular deflection (default ${DEFAULT_TESSELLATION.angularDeflection})
  --occt DIR       occt-import-js dist dir (default: vendor/occt-import-js, staged by fetch-deps.sh)
  --threads        the multi-core build (vendor/occt-import-js/mt): faces meshed on up to 4
                   threads, the same triangles, more memory
  --raw            write the uncompressed layout (default: gzipped, which the viewer inflates)
  --progress       print OpenCascade's progress to stderr (needs the occt-progress build)
  --no-kind        leave each body's b-rep status out of the header, so builds with and without
                   it can be compared byte for byte (occt-progress/compare.sh)
  --no-edges       leave the edge sections out: the viewer then finds the edges in a worker
                   after the model is shown (a 6.2 MB board file is 3.3 MB without them, and
                   ready at the same moment: the edges came 0.18-0.20 s later, off the main
                   thread, on a 1280 px WebGL2 run)

  exit 0: written (or -h); 1: the input refused (missing, not CAD, not converted); 2: usage;
  3: the converter is not installed (fetch-deps.sh)
`;

// (the tools' one argument rule, js/cli-args.js: a value never an option, each option once)
function parseArgs(argv) {
  const r = parseCli(argv, { values: ['-o', '--deflection', '--absolute', '--angular', '--occt'], flags: ['--raw', '--threads', '--progress', '--no-kind', '--no-edges'], max: 1 });
  if (r.help) return { help: true };
  const o = r.opts;
  const a = { params: { ...DEFAULT_TESSELLATION }, input: r.pos[0], out: o['-o'], occt: o['--occt'], raw: !!o['--raw'], threads: !!o['--threads'], progress: !!o['--progress'], noKind: !!o['--no-kind'], noEdges: !!o['--no-edges'] };
  // one linear-deflection mode per run: given both, the later one used to overwrite the value
  // while the mode stayed absolute
  if ('--deflection' in o && '--absolute' in o) throw new CliError('give only one of --deflection / --absolute');
  if (a.occt && a.threads) throw new CliError('give only one of --occt / --threads');
  if ('--absolute' in o) { a.params.linearDeflectionType = 'absolute_value'; a.params.linearDeflection = positive(o, '--absolute'); }
  if ('--deflection' in o) a.params.linearDeflection = positive(o, '--deflection');
  a.params.angularDeflection = positive(o, '--angular', a.params.angularDeflection);
  return a;
}

// the CAD formats (the converter's, in the viewer's own table: js/formats.js), extension -> reader
const FORMATS = Object.fromEntries(CAD_FORMATS.filter((f) => f.kind === 'cad').flatMap((f) => f.ext.map((e) => [e, f.cad])));

// The CAD format a file's first bytes say (gzipped or not), or undefined: the viewer's own
// sniff (js/formats.js sniffFormat)
function sniffFile(path) {
  // the first 64 KiB only (a gzip's head unpacks from them): the whole file
  // was read and unpacked to look at 200 bytes (review r23)
  let b;
  try {
    const fd = openSync(path, 'r');
    try {
      b = Buffer.alloc(65536);
      b = b.subarray(0, readSync(fd, b, 0, b.length, 0));
    } finally { closeSync(fd); }
  } catch { return undefined; }
  if (b[0] === 0x1f && b[1] === 0x8b) {
    try { b = gunzipSync(b, { finishFlush: zlibConstants.Z_SYNC_FLUSH }); } catch { return undefined; }
  }
  const f = sniffFormat(new Uint8Array(b.buffer, b.byteOffset, Math.min(b.length, SNIFF_BYTES)));
  return f && f.kind === 'cad' ? f.cad : undefined;
}

async function main() {
  // (a usage error, help and a refusal each thrown, said by runCli)
  const args = parseArgs(process.argv.slice(2));
  if (args.help) throw new CliHelp();
  if (!args.input) throw new CliError('no input file');
  // a gzipped file (part.stp.gz) is opened as the one inside it, as the
  // viewer does (review r18)
  const gz = /\.gz$/i.test(args.input);
  const inner = gz ? args.input.replace(/\.gz$/i, '') : args.input;
  // (the extension of the file NAME: a dotted directory is not one, r23)
  const base = inner.split('/').pop();
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  // a missing file or a directory said as such, not as an extension (r23)
  // (an input that cannot be read is refused, exit 1, in the five tools' one wording (readInput),
  // said by runCli: "stp2mesh: ..."; 2 is for the options)
  const read = await readInput(args.input);
  // a name that says nothing: told by the bytes, as the viewer does (r22)
  const format = FORMATS[ext] || sniffFile(args.input);
  if (!format) {
    // (the input refused, as a missing one is: 2 is for the options)
    throw new Error(`${args.input}: ${ext ? `unsupported extension .${ext}` : 'no CAD extension, and its first bytes are not STEP, IGES or BREP'}`
      + ` (want ${Object.keys(FORMATS).join(', ')})`);
  }
  // (the extension dropped only when the name had a CAD one: a bare name in
  // a dotted directory kept its directory)
  const out = args.out || (FORMATS[ext] ? inner.replace(/\.[^./]+$/, '') : inner) + '.cadmesh';
  // an output it cannot write (no such directory, or a directory) refused before the conversion
  await checkOutput(out);
  // (an angle no circle test passes: said once the input and output are known good, before the
  // conversion, which it does not depend on -- a run then refused printed it too)
  if (circleMinPoints(args.params.angularDeflection) === Infinity) {
    process.stderr.write(`stp2mesh: WARNING: --angular ${args.params.angularDeflection} is 2π/9 (0.698) or more: no circle can be found in the result (List holes, a drawing's circles)\n`);
  }
  const occtDir = resolve(args.occt || join(HERE, 'vendor', 'occt-import-js', ...(args.threads ? ['mt'] : [])));
  const occtJs = join(occtDir, 'occt-import-js.js');
  if (!existsSync(occtJs)) {
    process.stderr.write(`stp2mesh: occt-import-js not found at ${occtJs}: run ${join(HERE, 'fetch-deps.sh')}\n`);
    return 3;
  }
  // --progress: print OpenCascade's progress (our occt-progress build only;
  // the stock npm build never calls onProgress): each phase's start and end,
  // and every 10% of it, with the time since the import began
  const tp = Date.now();
  let lastKey = '';
  const steps = Number(process.env.CADV_PROGRESS_STEPS) || 10; // prints per phase (1000 = every 0.1%)
  const onProgress = !args.progress ? undefined : (phase, fraction) => {
    const key = `${phase}:${Math.floor(fraction * steps)}`;
    if (key === lastKey && fraction < 1) return;
    lastKey = key;
    const name = { 1: 'read', 2: 'transfer', 3: 'mesh' }[phase] || phase;
    process.stderr.write(`progress ${name} ${(fraction * 100).toFixed(1)}% at ${((Date.now() - tp) / 1000).toFixed(1)} s\n`);
  };
  // The multi-core build sizes its thread pool from navigator.hardwareConcurrency,
  // which Node has only from 21 (Node 20 threw "navigator is not defined")
  if (args.threads && typeof globalThis.navigator === 'undefined') {
    globalThis.navigator = { hardwareConcurrency: availableParallelism() };
  }
  const occt = await createRequire(import.meta.url)(occtJs)({ locateFile: (p) => join(occtDir, p), onProgress });
  const t0 = Date.now();
  const unpacked = read[0] === 0x1f && read[1] === 0x8b ? gunzipSync(read) : read;
  // a UTF-8 byte-order mark first (some exporters write one): OpenCascade
  // refuses it ("unexpected QUID, expecting STEP"), so it is dropped (r21)
  const bytes = withoutBom(unpacked);
  // the unit the file declares, read before the converter sees the bytes
  const declared = sourceUnits(bytes, format);
  const result = occt.ReadFile(format, bytes, args.params);
  const t1 = Date.now();
  // (a failed import said in the page's own words: js/cadmesh.js occtResultToModel)
  let model;
  try {
    model = conversionModel(result, { sourceUnits: declared, angularDeflection: args.params.angularDeflection });
  } catch (e) {
    throw new Error(`${args.input}: ${e.message}`);
  }
  // no faces (curves or points only): nothing to show, as the viewer refuses
  // it, not an empty .cadmesh written as OK (review r22)
  // (faces the converter could not mesh are not "no faces": r23; the page's words, noSurfaces)
  const none = noSurfaces(model.meshes.reduce((s, m) => s + m.indices.length, 0), args.input, model.unmeshedFaces);
  if (none) throw new Error(none);
  // the statuses are reported (and digested for compare.sh) even when
  // --no-kind leaves them out of the header
  // the converter's own strings, not the filtered kind, so a status the JS
  // list does not know still shows (and still changes the digest)
  const statuses = result.meshes.map((m) => (typeof m.brep_kind === 'string' && m.brep_kind) || null);
  const unknown = [...new Set(statuses.filter((k) => k && !BODY_KINDS.includes(k)))];
  if (unknown.length) {
    process.stderr.write(`stp2mesh: WARNING: b-rep status(es) not in BODY_KINDS, left out of the header: ${unknown.join(', ')}\n`);
  }
  if (args.noKind) for (const m of model.meshes) m.kind = null;
  const buf = encodeCadmesh(model, { edges: !args.noEdges });
  // (the page saves a conversion only once it loads; decoded here first too -- written and printed
  // OK before, a model past the viewer's bound left its file behind with an OK line, then FAIL)
  let h;
  try { h = decodeCadmesh(buf).header; } catch (e) { throw new Error(`${args.input}: ${e.message}`); } // (one line, not node's stack)
  if (model.unmeshedFaces) {
    process.stderr.write(`stp2mesh: WARNING: ${model.unmeshedFaces} face(s) could not be meshed and are missing from ${out}\n`);
  }
  const file = args.raw ? Buffer.from(buf) : gzipSync(Buffer.from(buf), { level: 6 });
  try { writeFileSync(out, file); } catch (e) { throw new Error(`could not write ${out}: ${e.message}`); }
  const meshes = result.meshes.length;
  const tris = result.meshes.reduce((s, m) => s + m.index.array.length / 3, 0);
  const mb = (n) => (n / 1e6).toFixed(1);
  process.stdout.write(`OK ${out}: ${meshes} bodies, ${tris} triangles, ${mb(file.length)} MB`
    + `${args.raw ? '' : ` gzipped (${mb(buf.byteLength)} MB raw)`}, tessellation ${((t1 - t0) / 1000).toFixed(1)} s`
    + `, declared unit ${declared || 'not recorded'}\n`);
  // the edge list and body facts encodeCadmesh built
  const sec = (s) => (h.sections[s] ? h.sections[s].byteLength / 8 : 0);
  if (h.facts) {
    process.stdout.write(`edges: ${sec('edges')} boundary, ${h.silhouettesOmitted ? `${h.silhouettesOmitted} silhouette candidates left out (over the cap)` : `${sec('silhouettes')} silhouette candidates`}`
      + `; ${h.facts.closed.filter(Boolean).length} of ${h.facts.closed.length} bodies closed`
      // (each flag fact a body may have, in the one wording: js/edges.js BODY_FACTS)
      + BODY_FACTS.filter((f) => f.said && h.facts[f.key]).map((f) => `, ${h.facts[f.key].filter(Boolean).length} ${f.said}`).join('')
      + '\n');
  }
  // the b-rep status of each body, as the converter found it
  const kinds = {};
  for (const k of statuses) if (k) kinds[k] = (kinds[k] || 0) + 1;
  if (Object.keys(kinds).length) {
    // the digest is of every body's status in order, so compare.sh can tell
    // two builds that classify differently even when the totals agree;
    // brep_caps counts distinct cap faces (a part's instances share them)
    const digest = hashName(statuses.map((k) => k || '-').join(',')).toString(16).padStart(8, '0');
    process.stdout.write(`bodies by b-rep status: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')}`
      + `${model.brepCaps !== null ? `; ${model.brepCaps} distinct planar cap face(s) added` : ''}; statuses ${digest}\n`);
  }
  return 0;
}

// (a refused input or a failed write: one line, exit 1, by runCli as the other tools -- the stack
// trace was printed whole)
await runCli('stp2mesh', async () => process.exit(await main()), USAGE);
