#!/usr/bin/env node
// Tessellate a STEP / IGES / BREP file into a .cadmesh the viewer loads
// instantly. Same OpenCascade build (occt-import-js) and the same packing code
// (js/cadmesh.js) as the in-browser import, so the two paths cannot disagree.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { encodeCadmesh, occtResultToModel, DEFAULT_TESSELLATION } from './js/cadmesh.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `usage: stp2mesh.mjs <in.stp|.step|.igs|.iges|.brep> [-o out.cadmesh]
                    [--deflection R] [--absolute MM] [--angular RAD] [--occt DIR]

  -o FILE          output (default: input with .cadmesh)
  --deflection R   linear deflection as a ratio of the bounding box (default ${DEFAULT_TESSELLATION.linearDeflection})
  --absolute MM    linear deflection as an absolute chord error in mm (instead of --deflection)
  --angular RAD    angular deflection (default ${DEFAULT_TESSELLATION.angularDeflection})
  --occt DIR       occt-import-js dist dir (default: vendor/occt-import-js, staged by fetch-deps.sh)
  --raw            write the uncompressed layout (default: gzipped, which the viewer inflates)
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
  const occtDir = resolve(args.occt || join(HERE, 'vendor', 'occt-import-js'));
  const occtJs = join(occtDir, 'occt-import-js.js');
  if (!existsSync(occtJs)) {
    process.stderr.write(`occt-import-js not found at ${occtJs}: run ${join(HERE, 'fetch-deps.sh')}\n`);
    return 3;
  }
  const out = args.out || args.input.replace(/\.[^.]+$/, '') + '.cadmesh';
  const occt = await createRequire(import.meta.url)(occtJs)({ locateFile: (p) => join(occtDir, p) });
  const t0 = Date.now();
  const result = occt.ReadFile(format, readFileSync(args.input), args.params);
  const t1 = Date.now();
  if (!result || !result.success) {
    process.stderr.write(`FAIL: OpenCascade could not import ${args.input}\n`);
    return 1;
  }
  const buf = encodeCadmesh(occtResultToModel(result));
  const file = args.raw ? Buffer.from(buf) : gzipSync(Buffer.from(buf), { level: 6 });
  writeFileSync(out, file);
  const meshes = result.meshes.length;
  const tris = result.meshes.reduce((s, m) => s + m.index.array.length / 3, 0);
  const mb = (n) => (n / 1e6).toFixed(1);
  process.stdout.write(`OK ${out}: ${meshes} bodies, ${tris} triangles, ${mb(file.length)} MB`
    + `${args.raw ? '' : ` gzipped (${mb(buf.byteLength)} MB raw)`}, tessellation ${((t1 - t0) / 1000).toFixed(1)} s\n`);
  return 0;
}

main().then((rc) => process.exit(rc), (e) => { process.stderr.write(`FAIL: ${e.stack || e}\n`); process.exit(1); });
