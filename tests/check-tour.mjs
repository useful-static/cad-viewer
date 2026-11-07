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
import { MAX_FILE_BYTES, decodeCadmesh, gunzip, isGzip } from '../js/cadmesh.js';
import { fileNameOfUrl, formatOfName, meshReaderOf, openedName, opensAsZip, sniffFormat, zipCompanions, zipModel } from '../js/formats.js';
import { meshFormatOf, unzip } from '../js/mesh-formats.js';
import { readMeshFile } from '../js/read-file.js';
import { resolve } from 'node:path';
import { parseModelList, readCapped } from '../js/model-list.js';
import { fileUrl } from '../js/open-url.js';
import { MAX_TOUR_BYTES, parseTour, partIndex, resolveParts, tourNames } from '../js/tour.js';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('usage: node tests/check-tour.mjs TOUR.cadtour.json [MODEL.cadmesh(.gz)] [--labels LIST.json]');
  process.exit(args.length ? 0 : 2);
}
const li = args.indexOf('--labels');
const labelsFile = li >= 0 ? args.splice(li, 2)[1] : null;
// (--labels with no file after it was dropped, and the check passed without the labels asked for)
if (li >= 0 && (!labelsFile || labelsFile.startsWith('--'))) { console.log('usage: --labels needs a model list file'); process.exit(2); }
const [tourPath, modelArg] = args;

// a URL as the page fetches it (a GitHub blob, a Dropbox ?dl=0: js/open-url.js fileUrl)
const fetchOk = async (p) => {
  const res = await fetch(fileUrl(p));
  if (!res.ok) throw new Error(`${res.status === 404 ? 'not found' : 'refused'} (${res.status}): ${p}`);
  return res;
};
const read = async (p) => (/^https?:/.test(p) ? new Uint8Array(await (await fetchOk(p)).arrayBuffer()) : new Uint8Array(await readFile(p)));
// A local path stands in as https://local.invalid/<its absolute path> (as for --labels below), so
// a tour's relative "model" resolves beside the tour file, and back to a path
const LOCAL = 'https://local.invalid';
const asUrl = (p) => (/^https?:/.test(p) ? new URL(p).href : new URL(`${LOCAL}${resolve(p)}`).href);
const asPath = (u) => (u.startsWith(`${LOCAL}/`) ? decodeURIComponent(new URL(u).pathname) : u);

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
  const extras = new Map();
  if (opensAsZip(name, new Uint8Array(raw)) && formatOfName(name)?.label !== '3MF') {
    const z = await unzip(raw);
    const zm = zipModel(z.names);
    if (zm.threeMf) name = `${name.replace(/\.[^./]*$/, '')}.3mf`;
    else if (!zm.model) throw new Error(`${name} holds no model this viewer opens`);
    else {
      const inner = await z.get(zm.model);
      raw = isGzip(inner) ? await gunzip(inner) : inner;
      name = zm.model.split('/').pop().replace(/\.gz$/i, '');
      if (meshReaderOf(name, new Uint8Array(raw))?.companions) for (const c of zipCompanions(zm.files, zm.model, zm.opens)) extras.set(c.name.toLowerCase(), await z.get(c.path));
    }
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
  // stands in as https://local.invalid/<its absolute path>, the list's and the model's alike.
  const entries = parseModelList(new TextDecoder().decode(await read(labelsFile)), asUrl(labelsFile));
  const entry = entries.find((e) => e.url === asUrl(model));
  if (!entry) { console.log(`FAIL ${labelsFile}: names no entry for ${model}`); process.exit(1); }
  labels = entry.labels || null;
}
const idx = partIndex(header, labels);
const names = tourNames(tour);
const { missing } = resolveParts(names, idx);
console.log(`${missing.length ? 'FAIL' : 'OK  '} ${tourPath}: ${tour.steps.length} steps, ${names.length} part names, ${missing.length} not in the model${missing.length ? `: ${missing.join(', ')}` : ''}`);
process.exit(missing.length ? 1 : 0);
