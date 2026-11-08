#!/usr/bin/env node
// Check a tour against the model it plays over (js/tour.js): the file is
// read as the viewer reads it, and every part name it uses must name parts
// of the model.
//
//   node tests/check-tour.mjs TOUR.cadtour.json [MODEL.cadmesh(.gz)] [--labels LIST.json]
//
// MODEL defaults to the tour's own "model" when that is a local path or an
// http(s) URL (fetched). --labels: a model list whose entry for the model
// gives part labels (as cad.place would have them). Exit 0: every name
// resolves; 1: a name matches nothing (each listed), or the file is refused.

import { readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { MAX_FILE_BYTES, decodeCadmesh, gunzip, isGzip } from '../js/cadmesh.js';
import { fileNameOfUrl, formatOfName, isCompanion, meshReaderOf, openedName, opensAsZip, sniffFormat, zipCompanions, zipModel } from '../js/formats.js';
import { meshFormatOf, unzip } from '../js/mesh-formats.js';
import { companionsOverText, readCompanions } from '../js/companions.js';
import { CliError, parseCli, readInput } from '../js/cli-args.js';
import { readMeshFile } from '../js/read-file.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseModelList, readCapped } from '../js/model-list.js';
import { fileUrl } from '../js/open-url.js';
import { MAX_TOUR_BYTES, parseTour, partIndex, resolveParts, tourNames } from '../js/tour.js';

const USAGE = 'usage: node tests/check-tour.mjs TOUR.cadtour.json [MODEL.cadmesh(.gz)] [--labels LIST.json]';
// (the tools' one argument rule, js/cli-args.js parseCli: --labels=list.json read, a misspelt option a
// usage error -- its own parser ignored both, and a label-named tour FAILed: r80 A5)
let parsed;
try { parsed = parseCli(process.argv.slice(2), { values: ['--labels'], max: 2 }); } catch (e) {
  if (!(e instanceof CliError)) throw e;
  // (a usage error on stderr, as the other tools say it -- js/cli-args.js runCli: r82 Q5)
  console.error(`check-tour: ${e.message}\n${USAGE}`);
  process.exit(2);
}
if (parsed.help) { console.log(USAGE); process.exit(0); }
if (!parsed.pos.length) { console.error(USAGE); process.exit(2); }
const labelsFile = parsed.opts['--labels'] || null;
const [tourPath, modelArg] = parsed.pos;

// a URL as the page fetches it (a GitHub blob, a Dropbox ?dl=0: js/open-url.js fileUrl)
const fetchOk = async (p) => {
  const res = await fetch(fileUrl(p));
  if (!res.ok) throw new Error(`${res.status === 404 ? 'not found' : 'refused'} (${res.status}): ${p}`);
  return res;
};
// (a local file by the tools' one reading, js/cli-args.js readInput: "<path>: no such file", not node's
// "ENOENT: …" -- r83 A7)
const read = async (p) => (/^https?:/.test(p) ? new Uint8Array(await (await fetchOk(p)).arrayBuffer()) : new Uint8Array(await readInput(p)));
// A local path stands in as https://local.invalid/<its absolute path> (as for --labels below; the
// tour's rule takes a model on its own scheme and host, which file: has none of), so a tour's
// relative "model" resolves beside the tour file, and back to a path -- the path escaped and
// unescaped by node's own file-URL mapping: as a string, a folder "a #1" was cut at its "#" and
// "b%41" read as "bA", each tour checked against another file (r88 Q1)
const LOCAL = 'https://local.invalid';
const asUrl = (p) => (/^https?:/.test(p) ? new URL(p).href : new URL(`${LOCAL}${pathToFileURL(resolve(p)).pathname}`).href);
const asPath = (u) => (u.startsWith(`${LOCAL}/`) ? fileURLToPath(`file://${new URL(u).pathname}`) : u);

let tour;
try {
  // (read up to the page's limit, as the page reads one: js/tour.js MAX_TOUR_BYTES)
  const text = /^https?:/.test(tourPath) ? await readCapped(await fetchOk(tourPath), MAX_TOUR_BYTES) : new TextDecoder().decode(await read(tourPath));
  tour = parseTour(text, asUrl(tourPath));
} catch (e) {
  console.log(`FAIL ${tourPath}: ${e.message}`);
  process.exit(1);
}
const model = modelArg || (tour.model ? asPath(tour.model) : null);
if (!model) { console.log(`FAIL ${tourPath}: give the model file it plays over`); process.exit(1); }
// the model as the page reads it: a .cadmesh, or a mesh (STL, OBJ, PLY, OFF, 3MF, glTF / GLB) read
// into one by the page's own reader, in the unit the tour was made in; a STEP / IGES / BREP needs
// the converter (stp2mesh.mjs), refused in a FAIL line, as is a file this cannot read
let header;
try {
  let buf = await read(model);
  if (buf.byteLength > MAX_FILE_BYTES) throw new Error(`over ${MAX_FILE_BYTES / 2 ** 30} GB`);
  if (isGzip(buf.buffer)) buf = new Uint8Array(await gunzip(buf.buffer));
  let raw = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  // (its name as the page names a URL's file -- a query value naming a model, the query dropped:
  // js/formats.js fileNameOfUrl; by its last segment, "download?file=part.stl&token=abc" was "bad magic"
  // -- r78 A7)
  // (and, a name that says no format, the one its bytes say: js/formats.js openedName, main.js
  // loadAny's rule -- an ASCII STL at an unnamed URL was "cadmesh: bad magic", r79 A5)
  let name = openedName(fileNameOfUrl(model.replace(/\\/g, '/')).replace(/\.gz$/i, ''), new Uint8Array(raw));
  // (a zip opened as the page opens one: the entry js/formats.js zipModel chooses, a 3MF by its
  // directory -- r78 A7; and its companions handed to the reader that reads them, main.js loadZip and
  // loadMeshFile -- a zipped glTF "needs chair.bin": r79 A5)
  let extras = new Map();
  if (opensAsZip(name, new Uint8Array(raw)) && formatOfName(name)?.label !== '3MF') {
    const z = await unzip(raw);
    const zm = zipModel(z.names);
    if (zm.threeMf) name = `${name.replace(/\.[^./]*$/, '')}.3mf`;
    else if (!zm.model) throw new Error(`${name} holds no model this viewer opens`);
    else {
      const inner = await z.get(zm.model);
      raw = isGzip(inner) ? await gunzip(inner) : inner;
      name = zm.model.split('/').pop().replace(/\.gz$/i, '');
      // (read as the page reads them, each to what the ones before leave: js/companions.js -- with no
      // limit here, a 10 MB zip of 2.36 GB of pictures passed: r80 A1)
      if (meshReaderOf(name, new Uint8Array(raw))?.companions) {
        const over = () => new Error(companionsOverText(name));
        extras = await readCompanions(zipCompanions(zm.files, zm.model, zm.opens).map((c) => ({ name: c.name, arrayBuffer: (max) => z.get(c.path, max, over) })), name);
      }
    }
  } else if (!/^https?:/.test(model) && meshReaderOf(name, new Uint8Array(raw))?.companions) {
    // (a local model with the files beside it in its folder, as a drop carries them to the page
    // (main.js pickModelFile, companionsOf): a .gltf beside its .bin FAILed, "needs tri.bin" -- r82 A6.
    // From a URL the page has none, so none here)
    const dir = dirname(resolve(model));
    const near = readdirSync(dir).filter((f) => isCompanion(f) && statSync(join(dir, f)).isFile());
    extras = await readCompanions(near.map((f) => ({ name: f, size: statSync(join(dir, f)).size, arrayBuffer: async () => { const b = await readFile(join(dir, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } })), name);
  }
  const mesh = meshFormatOf(name, raw);
  // (no edges or facts: the tour's check reads the bodies only -- r42 Q10)
  if (mesh) raw = (await readMeshFile({ buf: raw, format: mesh, name, extras, unit: tour.unit || 'mm', edges: false })).raw;
  else if (sniffFormat(raw)?.kind === 'cad' || formatOfName(name)?.kind === 'cad') throw new Error('a STEP / IGES / BREP: convert it first (stp2mesh.mjs) and check against the .cadmesh');
  ({ header } = decodeCadmesh(raw));
} catch (e) {
  console.log(`FAIL ${model}: ${e.message}`);
  process.exit(1);
}
let labels = null;
if (labelsFile) {
  // read as the viewer reads a list (js/model-list.js parseModelList: every form, the files
  // resolved against the list), and the model's entry found by its resolved URL. A local path
  // stands in as https://local.invalid/<its absolute path> (asUrl), the list's and the model's alike.
  // (a list it cannot read or parse: a FAIL line, not node's stack trace -- r80 A5)
  let entries;
  try { entries = parseModelList(new TextDecoder().decode(await read(labelsFile)), asUrl(labelsFile)); } catch (e) { console.log(`FAIL ${labelsFile}: ${e.message}`); process.exit(1); }
  const entry = entries.find((e) => e.url === asUrl(model));
  if (!entry) { console.log(`FAIL ${labelsFile}: names no entry for ${model}`); process.exit(1); }
  labels = entry.labels || null;
}
const idx = partIndex(header, labels);
const names = tourNames(tour);
const { missing } = resolveParts(names, idx);
console.log(`${missing.length ? 'FAIL' : 'OK  '} ${tourPath}: ${tour.steps.length} steps, ${names.length} part names, ${missing.length} not in the model${missing.length ? `: ${missing.join(', ')}` : ''}`);
process.exit(missing.length ? 1 : 0);
