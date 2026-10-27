#!/usr/bin/env node
// Tessellate a STEP / IGES / BREP file into a .cadmesh the viewer loads
// instantly. Same OpenCascade build (occt-import-js) and the same packing code
// (js/cadmesh.js) as the in-browser import, so the two paths cannot disagree.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { BODY_KINDS, encodeCadmesh, hashName, occtResultToModel, DEFAULT_TESSELLATION } from './js/cadmesh.js';
import { sourceUnits } from './js/source-units.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `usage: stp2mesh.mjs <in.stp|.step|.igs|.iges|.brep> [-o out.cadmesh]
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
`;

function parseArgs(argv) {
  const a = { params: { ...DEFAULT_TESSELLATION } };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === '-h' || k === '--help') { a.help = true; }
    else if (k === '-o') a.out = val();
    else if (k === '--deflection' || k === '--absolute') {
      // one linear-deflection mode per run: given both, the later one used to
      // overwrite the value while the mode stayed absolute
      if (a.linearSet) throw new Error('give only one of --deflection / --absolute');
      a.linearSet = true;
      const v = Number(val());
      if (!(v > 0)) throw new Error(`${k} needs a positive number`);
      if (k === '--absolute') a.params.linearDeflectionType = 'absolute_value';
      a.params.linearDeflection = v;
    }
    else if (k === '--angular') {
      const v = Number(val());
      if (!(v > 0)) throw new Error('--angular needs a positive number');
      a.params.angularDeflection = v;
    }
    else if (k === '--occt') a.occt = val();
    else if (k === '--raw') a.raw = true;
    else if (k === '--threads') a.threads = true;
    else if (k === '--progress') a.progress = true;
    else if (k === '--no-kind') a.noKind = true;
    else if (k.startsWith('-')) throw new Error(`unknown option ${k}`);
    else if (!a.input) a.input = k;
    else throw new Error(`unexpected argument ${k}`);
  }
  return a;
}

const FORMATS = { stp: 'step', step: 'step', igs: 'iges', iges: 'iges', brep: 'brep' };

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.help || !args.input) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }
  const ext = (args.input.split('.').pop() || '').toLowerCase();
  const format = FORMATS[ext];
  if (!format) {
    process.stderr.write(`unsupported extension .${ext} (want ${Object.keys(FORMATS).join(', ')})\n`);
    return 2;
  }
  if (args.occt && args.threads) {
    process.stderr.write(`give only one of --occt / --threads\n${USAGE}`);
    return 2;
  }
  const occtDir = resolve(args.occt || join(HERE, 'vendor', 'occt-import-js', ...(args.threads ? ['mt'] : [])));
  const occtJs = join(occtDir, 'occt-import-js.js');
  if (!existsSync(occtJs)) {
    process.stderr.write(`occt-import-js not found at ${occtJs}: run ${join(HERE, 'fetch-deps.sh')}\n`);
    return 3;
  }
  const out = args.out || args.input.replace(/\.[^.]+$/, '') + '.cadmesh';
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
  const occt = await createRequire(import.meta.url)(occtJs)({ locateFile: (p) => join(occtDir, p), onProgress });
  const t0 = Date.now();
  const bytes = readFileSync(args.input);
  // the unit the file declares, read before the converter sees the bytes
  const declared = sourceUnits(bytes, format);
  const result = occt.ReadFile(format, bytes, args.params);
  const t1 = Date.now();
  if (!result || !result.success) {
    process.stderr.write(`FAIL: OpenCascade could not import ${args.input}\n`);
    return 1;
  }
  const model = occtResultToModel(result);
  model.sourceUnits = declared;
  model.angularDeflection = args.params.angularDeflection;
  // the statuses are reported (and digested for compare.sh) even when
  // --no-kind leaves them out of the header
  // the converter's own strings, not the filtered kind, so a status the JS
  // list does not know still shows (and still changes the digest)
  const statuses = result.meshes.map((m) => (typeof m.brep_kind === 'string' && m.brep_kind) || null);
  const unknown = [...new Set(statuses.filter((k) => k && !BODY_KINDS.includes(k)))];
  if (unknown.length) {
    process.stderr.write(`WARNING: b-rep status(es) not in BODY_KINDS, left out of the header: ${unknown.join(', ')}\n`);
  }
  if (args.noKind) for (const m of model.meshes) m.kind = null;
  const buf = encodeCadmesh(model);
  if (model.unmeshedFaces) {
    process.stderr.write(`WARNING: ${model.unmeshedFaces} face(s) could not be meshed and are missing from ${out}\n`);
  }
  const file = args.raw ? Buffer.from(buf) : gzipSync(Buffer.from(buf), { level: 6 });
  writeFileSync(out, file);
  const meshes = result.meshes.length;
  const tris = result.meshes.reduce((s, m) => s + m.index.array.length / 3, 0);
  const mb = (n) => (n / 1e6).toFixed(1);
  process.stdout.write(`OK ${out}: ${meshes} bodies, ${tris} triangles, ${mb(file.length)} MB`
    + `${args.raw ? '' : ` gzipped (${mb(buf.byteLength)} MB raw)`}, tessellation ${((t1 - t0) / 1000).toFixed(1)} s`
    + `, declared unit ${declared || 'not recorded'}\n`);
  // the edge list and body facts encodeCadmesh built
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, new DataView(buf).getUint32(8, true))));
  const sec = (s) => (h.sections[s] ? h.sections[s].byteLength / 8 : 0);
  if (h.facts) {
    process.stdout.write(`edges: ${sec('edges')} boundary, ${h.silhouettesOmitted ? `${h.silhouettesOmitted} silhouette candidates left out (over the cap)` : `${sec('silhouettes')} silhouette candidates`}`
      + `; ${h.facts.closed.filter(Boolean).length} of ${h.facts.closed.length} bodies closed\n`);
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

main().then((rc) => process.exit(rc), (e) => { process.stderr.write(`FAIL: ${e.stack || e}\n`); process.exit(1); });
