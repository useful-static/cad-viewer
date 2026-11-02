#!/usr/bin/env node
// Give a .cadmesh new per-vertex colours: the colour section is replaced and
// the header says who wrote them ("recolour", js/cadmesh.js); every other
// byte of the file -- geometry, normals, ids, part names, b-rep faces, edges
// -- is copied as it was. For a site that colours its models its own way
// (its renders' palette, say): it works out one colour per vertex, in the
// file's vertex order, and this tool writes them, so the file format has one
// writer, here.
//
//   set-colours.mjs <in.cadmesh[.gz]> <colours> -o <out.cadmesh[.gz]> --by "<who>"
//
// <colours>: raw bytes, 4 per vertex (R, G, B, A; A is written as 255) or 3
// per vertex (R, G, B), in vertex order. A file the header already marks
// recoloured is refused (its colours are no longer the converter's), unless
// --again.

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync, constants as zc } from 'node:zlib';
import { decodeCadmesh } from './js/cadmesh.js';

const USAGE = `usage: set-colours.mjs <in.cadmesh[.gz]> <colours> -o <out.cadmesh[.gz]> --by "<who>" [--again]

  <colours>  raw RGBA (4 bytes) or RGB (3 bytes) per vertex, in the file's vertex order
  --by TEXT  what wrote the colours: the header's "recolour"
  --again    recolour a file already marked recoloured
  --show     print the input's vertex count and "recolour", and write nothing
`;

const align8 = (n) => (n + 7) & ~7;

// raw .cadmesh bytes (Uint8Array) + colours -> the new file's bytes
export function setColours(raw, colours, by, { again = false } = {}) {
  if (typeof by !== 'string' || !by.trim()) throw new Error('say what wrote the colours (--by)');
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const d = decodeCadmesh(ab); // (validates the whole file first)
  const h = d.header;
  if (h.recolour && !again) throw new Error(`already recoloured (${h.recolour}); --again to recolour it anyway`);
  const n = h.vertexCount;
  const per = colours.length === n * 4 ? 4 : colours.length === n * 3 ? 3 : 0;
  if (!per) throw new Error(`${colours.length} colour bytes for ${n} vertices: want ${n * 4} (RGBA) or ${n * 3} (RGB)`);
  const jlen = new DataView(ab).getUint32(8, true);
  const dataStart = align8(12 + jlen);
  const data = raw.slice(dataStart);
  const sec = h.sections.color;
  for (let v = 0; v < n; v++) {
    const o = sec.offset + v * 4;
    data[o] = colours[v * per];
    data[o + 1] = colours[v * per + 1];
    data[o + 2] = colours[v * per + 2];
    data[o + 3] = 255;
  }
  // the header as it was, plus who wrote the colours (section offsets are
  // from the data's start, so a longer header moves nothing they name)
  const json = new TextEncoder().encode(JSON.stringify({ ...h, recolour: by.trim() }));
  const start = align8(12 + json.length);
  const out = new Uint8Array(start + data.length);
  out.set(raw.subarray(0, 8));
  new DataView(out.buffer).setUint32(8, json.length, true);
  out.set(json, 12);
  out.set(data, start);
  decodeCadmesh(out.buffer); // (and the result reads back)
  return out;
}

function main() {
  const a = { again: false };
  const argv = process.argv.slice(2);
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '-h' || k === '--help') a.help = true;
    else if (k === '-o') a.out = argv[++i];
    else if (k === '--by') a.by = argv[++i];
    else if (k === '--again') a.again = true;
    else if (k === '--show') a.show = true;
    else pos.push(k);
  }
  [a.in, a.colours] = pos;
  if (a.help || !a.in || (!a.show && (!a.colours || !a.out))) { process.stdout.write(USAGE); process.exit(a.help ? 0 : 2); }
  let raw = readFileSync(a.in);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);
  if (a.show) {
    const h = decodeCadmesh(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)).header;
    console.log(JSON.stringify({ vertexCount: h.vertexCount, recolour: h.recolour || null }));
    return;
  }
  const out = setColours(new Uint8Array(raw), new Uint8Array(readFileSync(a.colours)), a.by, { again: a.again });
  writeFileSync(a.out, a.out.endsWith('.gz') ? gzipSync(out, { level: zc.Z_BEST_COMPRESSION }) : out);
  console.log(`${a.in}: colours of ${decodeCadmesh(out.buffer).header.vertexCount} vertices set (recolour: ${a.by.trim()}) -> ${a.out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(`set-colours: ${e.message}`); process.exit(1); }
}
