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
import { decodeCadmesh, gunzip, isGzip } from '../js/cadmesh.js';
import { parseTour, partIndex, resolveParts, tourNames } from '../js/tour.js';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('usage: node tests/check-tour.mjs TOUR.cadtour.json [MODEL.cadmesh(.gz)] [--labels LIST.json]');
  process.exit(args.length ? 0 : 2);
}
const li = args.indexOf('--labels');
const labelsFile = li >= 0 ? args.splice(li, 2)[1] : null;
const [tourPath, modelArg] = args;

const read = async (p) => (/^https?:/.test(p) ? new Uint8Array(await (await fetch(p)).arrayBuffer()) : new Uint8Array(await readFile(p)));

let tour;
try {
  // (a local file is read as if served: its model URL resolves against a
  // stand-in https address, and the model itself is given on the command line)
  tour = parseTour(new TextDecoder().decode(await read(tourPath)), /^https?:/.test(tourPath) ? tourPath : 'https://local.invalid/');
} catch (e) {
  console.log(`FAIL ${tourPath}: ${e.message}`);
  process.exit(1);
}
const model = modelArg || (tour.model && !tour.model.startsWith('https://local.invalid/') ? tour.model : null);
if (!model) { console.log(`FAIL ${tourPath}: give the model file it plays over`); process.exit(1); }
let buf = await read(model);
if (isGzip(buf.buffer)) buf = new Uint8Array(await gunzip(buf.buffer));
const { header } = decodeCadmesh(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
let labels = null;
if (labelsFile) {
  const list = JSON.parse(new TextDecoder().decode(await read(labelsFile)));
  const entry = Object.entries(list).find(([k]) => model.endsWith(k.replace(/^\//, '')));
  labels = entry && entry[1].labels;
}
const idx = partIndex(header, labels);
const names = tourNames(tour);
const { missing } = resolveParts(names, idx);
console.log(`${missing.length ? 'FAIL' : 'OK  '} ${tourPath}: ${tour.steps.length} steps, ${names.length} part names, ${missing.length} not in the model${missing.length ? `: ${missing.join(', ')}` : ''}`);
process.exit(missing.length ? 1 : 0);
