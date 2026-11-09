#!/usr/bin/env node
// Give a .cadmesh new per-vertex colours: the colour section is replaced and
// the header says who wrote them ("recolour", js/cadmesh.js); every other
// byte of the file -- geometry, normals, ids, part names, b-rep faces, edges
// -- is copied as it was. For a site that colours its models its own way
// (its renders' palette, say): it works out one colour per vertex, in the
// file's vertex order, and this tool writes them, so the file format has one
// writer, js/cadmesh.js (splitCadmesh + withHeader).
//
//   set-colours.mjs <in.cadmesh[.gz]> <colours> -o <out.cadmesh[.gz]> --by "<who>"
//
// <colours>: raw bytes, 4 per vertex (R, G, B, A; A is written as 255) or 3
// per vertex (R, G, B), in vertex order. A file the header already marks
// recoloured is refused (its colours are no longer the converter's), unless
// --again.

import { gzipSync, constants as zc } from 'node:zlib';
import { decodeCadmesh, gunzip, isGzip, splitCadmesh, withHeader } from './js/cadmesh.js';
import { CliError, CliHelp, checkOutput, parseCli, readInput, runCliIfMain, writeOutput } from './js/cli-args.js';

const USAGE = `usage: set-colours.mjs <in.cadmesh[.gz]> <colours> -o <out.cadmesh[.gz]> --by "<who>" [--again]

  <colours>  raw RGBA (4 bytes) or RGB (3 bytes) per vertex, in the file's vertex order
  --by TEXT  what wrote the colours: the header's "recolour"
  --again    recolour a file already marked recoloured
  --show     print the input's vertex count and "recolour", and write nothing
`;

// raw .cadmesh bytes (Uint8Array) + colours -> the new file's bytes
export function setColours(raw, colours, by, { again = false } = {}) {
  if (typeof by !== 'string' || !by.trim()) throw new Error('say what wrote the colours (--by)');
  const { header: h, data } = splitCadmesh(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  if (h.recolour && !again) throw new Error(`already recoloured (${h.recolour}); --again to recolour it anyway`);
  const n = h.vertexCount;
  const per = colours.length === n * 4 ? 4 : colours.length === n * 3 ? 3 : 0;
  if (!per) throw new Error(`${colours.length} colour bytes for ${n} vertices: want ${n * 4} (RGBA) or ${n * 3} (RGB)`);
  const sec = h.sections.color;
  for (let v = 0; v < n; v++) {
    const o = sec.offset + v * 4;
    data[o] = colours[v * per];
    data[o + 1] = colours[v * per + 1];
    data[o + 2] = colours[v * per + 2];
    data[o + 3] = 255;
  }
  // each body's header colour follows its new vertex colours (the colour picker reads it first,
  // and opened at the old colour): theirs when all alike, else none (the vertices say)
  const meshes = h.meshes.map((m) => {
    if (!m.vtxCount) return m;
    const at = (v) => sec.offset + v * 4;
    const f = at(m.vtxStart);
    let same = true;
    for (let v = m.vtxStart + 1; v < m.vtxStart + m.vtxCount && same; v++) {
      const o = at(v);
      same = data[o] === data[f] && data[o + 1] === data[f + 1] && data[o + 2] === data[f + 2];
    }
    return { ...m, color: same ? [data[f] / 255, data[f + 1] / 255, data[f + 2] / 255] : null };
  });
  // the header as it was, plus who wrote the colours
  return new Uint8Array(withHeader({ ...h, meshes, recolour: by.trim() }, data));
}

async function main() {
  // (the tools' one argument rule, js/cli-args.js: --agian was taken as a third file and ignored,
  // the file written without --again; and a missing --by is a usage error, as a missing -o is)
  // (a usage error and help thrown, said by runCli as in every tool)
  const usage = (msg) => { throw new CliError(msg); };
  const r = parseCli(process.argv.slice(2), { values: ['-o', '--by'], flags: ['--again', '--show'], max: 2 });
  if (r.help) throw new CliHelp();
  const a = { in: r.pos[0], colours: r.pos[1], out: r.opts['-o'], by: r.opts['--by'], again: !!r.opts['--again'], show: !!r.opts['--show'] };
  if (!a.in) usage('no input file');
  // (--show writes nothing: with what a write needs it silently did not write, exit 0)
  if (a.show && (a.colours || a.out || a.by || a.again)) usage('--show reads the input alone: no colours file, -o, --by or --again with it');
  if (!a.show && !a.colours) usage('no colours file');
  if (!a.show && !a.out) usage('no -o output');
  if (!a.show && !(a.by && a.by.trim())) usage('say what wrote the colours (--by)');
  // (the inputs read and the output checked in the five tools' one wording)
  let raw = await readInput(a.in);
  // (never the colours file, another format: a .cadmesh replaced it -- r93 A1; the .cadmesh itself
  // may be written in place)
  if (!a.show) await checkOutput(a.out, [a.colours]);
  // (unpacked as the page unpacks it: its limit and words, every member -- r75 A6)
  if (isGzip(raw)) raw = Buffer.from(await gunzip(raw));
  if (a.show) {
    const h = decodeCadmesh(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)).header;
    console.log(JSON.stringify({ vertexCount: h.vertexCount, recolour: h.recolour || null }));
    return;
  }
  const out = setColours(new Uint8Array(raw), new Uint8Array(await readInput(a.colours)), a.by, { again: a.again });
  await writeOutput(a.out, a.out.endsWith('.gz') ? gzipSync(out, { level: zc.Z_BEST_COMPRESSION }) : out);
  console.log(`${a.in}: colours of ${decodeCadmesh(out.buffer).header.vertexCount} vertices set (recolour: ${a.by.trim()}) -> ${a.out}`);
}

// run as a command (a path with a space or through a symlink included: the plain "file://"
// + argv[1] test was false there, and the tool exited 0 doing nothing)
await runCliIfMain(import.meta.url, 'set-colours', main, USAGE);
