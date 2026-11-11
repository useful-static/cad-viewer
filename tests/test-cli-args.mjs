#!/usr/bin/env node
// The command-line tools' one argument rule (js/cli-args.js parseCli), and each tool held to it:
// an unknown or repeated option, a value option whose value is an option, a value that is no
// number where one is wanted, a second input -- each a usage error, exit 2, on stderr; an input
// that is not what the tool reads, exit 1. No GPU, no network, no OpenCascade (every case is
// refused before a file is converted):  node tests/test-cli-args.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, parseCli, positive, writeOutput } from '../js/cli-args.js';
import { encodeCadmesh } from '../js/cadmesh.js';

import { test, skip, done } from './harness.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'cv-cli-'));
const notCad = join(dir, 'notcad.txt');
writeFileSync(notCad, 'not a CAD file\n');
// (an output path naming no file to write, in the system's own words: the path is opened as given
// since r101, so a directory's name, a file used as a directory, and a directory not there are each
// the system's error)
const NOT_DIR = /(a name in it is not a directory|it is a directory|no such directory)/;
const run = (tool, args) => {
  const r = spawnSync(process.execPath, [join(HERE, tool), ...args], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  return { rc: r.status, out: r.stdout, err: r.stderr };
};

test('parseCli: values, flags, --k=v, each once, a value never an option, help only as an option', () => {
  const spec = { values: ['-o', '--to'], flags: ['--raw'], max: 1 };
  assert.deepEqual(parseCli(['a', '-o', 'b', '--raw', '--to=stl'], spec), { opts: { '-o': 'b', '--raw': true, '--to': 'stl' }, pos: ['a'] });
  assert.deepEqual(parseCli(['a', '-h'], spec), { help: true });
  // ("--" ends the options: a file named "-old.dwg" -- must fire: "unknown option --", r90 Q4)
  assert.deepEqual(parseCli(['--raw', '--', '-old.dwg', '--to=x'], { ...spec, max: 2 }), { opts: { '--raw': true }, pos: ['-old.dwg', '--to=x'] });
  for (const [argv, msg] of [[['a', '-o', '--raw'], /-o needs a value/], [['a', '-o', 'x', '-o', 'y'], /-o given twice/], [['a', '--bogus'], /unknown option --bogus/],
    [['a', 'b'], /one input file, not 2/], [['a', '--to', '-h'], /--to needs a value/], [['a', '--raw=1'], /takes no value/], [['a', '--to='], /--to needs a value/]]) {
    assert.throws(() => parseCli(argv, spec), (e) => e instanceof CliError && msg.test(e.message), argv.join(' '));
  }
  // (a word starting with "-" that is no option of the tool's is a value: a negative number, an
  // orientation, a pattern)
  assert.deepEqual(parseCli(['-o', '-5'], { values: ['-o'] }).opts, { '-o': '-5' });
  assert.deepEqual(parseCli(['a', '--orient', '-z+y', '--skip', '-old'], { values: ['--orient', '--skip'] }).opts, { '--orient': '-z+y', '--skip': '-old' });
  assert.equal(positive({ '--s': '2.5' }, '--s'), 2.5);
  assert.equal(positive({}, '--s', 1.2), 1.2);
  for (const v of ['abc', '0', '-1', 'Infinity']) assert.throws(() => positive({ '--s': v }, '--s'), CliError, v);
});

test('every tool refuses a bad command line with a usage error (exit 2, on stderr); a non-CAD input is exit 1', () => {
  writeFileSync(join(dir, 'x.constructor'), 'not a CAD file\n');
  writeFileSync(join(dir, 'x3.stp'), 'ISO-10303-21;\n');
  writeFileSync(join(dir, 'huge.cadmesh'), '');
  truncateSync(join(dir, 'huge.cadmesh'), 2 * 2 ** 30 + 1);
  const cases = [
    ['stp2mesh.mjs', ['x.stp', '-o', '--raw'], 2, /-o needs a value/],
    ['stp2mesh.mjs', ['x.stp', '-o', 'a.cadmesh', '-o', 'b.cadmesh'], 2, /given twice/],
    ['stp2mesh.mjs', ['x.stp', '--angular', '0.5', '--angular', '0.2'], 2, /given twice/],
    ['stp2mesh.mjs', [notCad], 1, /unsupported extension \.txt/],
    // (an extension that is a name every object has: read as a format, the sniff skipped, "Cannot
    // pass non-string to std::string" -- r93 A3)
    ['stp2mesh.mjs', [join(dir, 'x.constructor')], 1, /unsupported extension \.constructor/],
    ['cadmesh-export.mjs', ['b.cadmesh', '--skip', '-h'], 2, /--skip needs a value/],
    ['cadmesh-export.mjs', ['b.cadmesh', '--to', 'stl,stl'], 2, /a format twice/],
    ['cadmesh-export.mjs', ['b.cadmesh', '--orient', '+z-y', '--model-up', 'y'], 2, /one of --orient/],
    // (an orientation starting with "-" is a value: refused for its input, not its options)
    ['cadmesh-export.mjs', ['missing.cadmesh', '--orient', '-z+y'], 1, /no such file/],
    ['dwg-check.mjs', [], 2, /no DWG file given/],
    ['dwg-check.mjs', ['--dxf', 'x1.dxf', '--dxf', 'x2.dxf', 'a.dwg'], 2, /given twice/],
    ['split-board.mjs', ['b.cadmesh', '-o', 'o.cadmesh', '--edgs'], 2, /unknown option --edgs/],
    ['split-board.mjs', ['b.cadmesh', '-o', 'o.cadmesh', '--sliver', 'abc'], 2, /--sliver needs a positive number/],
    ['set-colours.mjs', ['b.cadmesh', 'c.rgb', '--agian', '-o', 'o.cadmesh', '--by', 'me'], 2, /unknown option --agian/],
    ['set-colours.mjs', ['b.cadmesh', 'c.rgb', '-o', 'o.cadmesh'], 2, /--by/],
    ['set-colours.mjs', ['b.cadmesh', 'c.rgb', '-o', 'o.cadmesh', '--by', 'me', '--show'], 2, /--show reads the input alone/],
    // an input it cannot read: one line, exit 1, in every tool
    ['split-board.mjs', ['missing.cadmesh', '-o', 'o.cadmesh'], 1, /no such file/],
    ['split-board.mjs', [notCad, '-o', 'o.cadmesh'], 1, /^split-board: /],
    ['set-colours.mjs', ['missing.cadmesh', 'c.rgb', '-o', 'o.cadmesh', '--by', 'me'], 1, /no such file/],
    ['cadmesh-export.mjs', ['missing.cadmesh'], 1, /no such file/],
    ['dwg-check.mjs', ['missing.dwg'], 1, /no such file/],
    ['stp2mesh.mjs', ['missing.stp'], 1, /no such file/],
    // (--raw to a name ending .gz: refused -- it wrote uncompressed bytes gunzip refused: r95 A4)
    ['stp2mesh.mjs', ['x3.stp', '--raw', '-o', 'x3.cadmesh.GZ'], 2, /--raw writes the uncompressed layout: not to a name ending \.gz/],
    // (an input past the viewer's 2 GB, in the page's words, naming the file: node's own message
    // named none -- r95 A3; a sparse file, no disk)
    ['cadmesh-export.mjs', ['huge.cadmesh'], 1, /huge\.cadmesh: over 2 GB, more than this viewer opens/],
    // (the converter not installed: exit 3, as its usage says -- no arm held it: r94 Q1)
    ['stp2mesh.mjs', ['x3.stp', '-o', 'x3.cadmesh', '--occt', join(dir, 'no-occt')], 3, /^stp2mesh: occt-import-js not found at .*no-occt/],
  ];
  const bad = [];
  for (const [tool, args, rc, msg] of cases) {
    const r = run(tool, args);
    // (said on stderr, no stack trace, nothing on stdout -- but dwg-check's report line, which
    // names a file it could not read on stdout)
    const said = tool === 'dwg-check.mjs' && rc === 1 ? r.out + r.err : r.err;
    if (r.rc !== rc || !msg.test(said) || /\n\s+at /.test(r.err) || (r.out && said === r.err)) bad.push(`${tool} ${args.join(' ')}: rc ${r.rc}, stderr ${JSON.stringify(r.err.slice(0, 160))}, stdout ${JSON.stringify(r.out.slice(0, 80))}`);
  }
  assert.deepEqual(bad, []);
  assert.ok(!existsSync(join(dir, 'x3.cadmesh')), 'stp2mesh with no converter wrote an output');
  rmSync(join(dir, 'huge.cadmesh')); // (the sparse 2 GB file gone at once: a copy of the dir would fill a disk)
  // an input refused is said in the one shape the tools share, "<tool>: ..." (they said it four ways)
  for (const [tool, args] of [['stp2mesh.mjs', [notCad]], ['stp2mesh.mjs', ['missing.stp']], ['cadmesh-export.mjs', ['missing.cadmesh']]]) {
    const r = run(tool, args);
    assert.match(r.err, new RegExp(`^${tool.replace('.mjs', '')}: `), `${tool} ${args.join(' ')}: ${JSON.stringify(r.err)}`);
  }
  // and -h is help: exit 0, the usage on stdout
  for (const tool of ['stp2mesh.mjs', 'cadmesh-export.mjs', 'dwg-check.mjs', 'split-board.mjs', 'set-colours.mjs']) {
    const r = run(tool, ['-h']);
    assert.ok(r.rc === 0 && /usage/.test(r.out) && !r.err, `${tool} -h: rc ${r.rc}, stdout ${JSON.stringify(r.out.slice(0, 60))}, stderr ${JSON.stringify(r.err.slice(0, 60))}`);
  }
});

test('a write that fails, in every tool that writes: one line "<tool>: ...", exit 1, no stack trace (r25 A4)', () => {
  // a box .cadmesh and its colours, written here (the tools read real files)
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) { positions[i * 3] = i & 1 ? 10 : 0; positions[i * 3 + 1] = i & 2 ? 10 : 0; positions[i * 3 + 2] = i & 4 ? 1 : 0; }
  const q = (a, b, c, d) => [a, b, c, a, c, d];
  const indices = new Uint32Array([...q(0, 2, 3, 1), ...q(4, 5, 7, 6), ...q(0, 1, 5, 4), ...q(2, 6, 7, 3), ...q(0, 4, 6, 2), ...q(1, 3, 7, 5)]);
  const raw = encodeCadmesh({ units: 'mm', meshes: [{ name: 'box', color: [0.5, 0.5, 0.5], positions, normals: null, colors: null, indices }], root: { name: 'b', meshes: [0], children: [] } });
  writeFileSync(join(dir, 'box.cadmesh'), new Uint8Array(raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)));
  writeFileSync(join(dir, 'box.rgb'), new Uint8Array(8 * 3).fill(128));
  writeFileSync(join(dir, 'x.stp'), 'ISO-10303-21;\n');
  symlinkSync('nodir/t.cadmesh', join(dir, 'tonodir.cadmesh'));
  // (a chain of two links, the last into a directory not there -- r102 Q4)
  mkdirSync(join(dir, 'hop'));
  symlinkSync(join('..', 'nodir2', 'x.cadmesh'), join(dir, 'hop', 'l2.cadmesh'));
  symlinkSync(join('hop', 'l2.cadmesh'), join(dir, 'l1.cadmesh'));
  // (a .cadmesh by another name: exported to its own name -- r93 A1)
  writeFileSync(join(dir, 'm.stl'), readFileSync(join(dir, 'box.cadmesh')));
  const gone = join(dir, 'no-such-dir');
  const bad = [];
  // (each refused before its work: stp2mesh before it converts, split-board before it splits;
  // an existing directory as the output too, r26 A4)
  for (const [tool, args, want] of [
    ['stp2mesh.mjs', ['x.stp', '-o', join(gone, 'x.cadmesh')], /no such directory/],
    ['stp2mesh.mjs', ['x.stp', '-o', dir], /it is a directory/],
    ['cadmesh-export.mjs', ['box.cadmesh', '--to', 'stl', '--out', join(gone, 'x')], /no such directory/],
    ['set-colours.mjs', ['box.cadmesh', 'box.rgb', '-o', join(gone, 'x.cadmesh'), '--by', 'test'], /no such directory/],
    ['split-board.mjs', ['box.cadmesh', '-o', join(gone, 'x.cadmesh')], /no such directory/],
    ['split-board.mjs', ['box.cadmesh', '-o', dir], /it is a directory/],
    ['dwg-check.mjs', [notCad, '--dxf', join(gone, 'x.dxf')], /no such directory/],
    // (a name ending in "/": a directory's, refused -- the slash dropped, -o f.stp/ overwrote f.stp: r99 Q5)
    // (refused in the system's own words since r101, the path opened as given: no code of its own)
    ['stp2mesh.mjs', ['x.stp', '-o', 'm.stl/'], NOT_DIR],
    // (and "." or ".." last: a directory's -- "m.stl/." overwrote m.stl, "nothere/." made a file: r100 Q3)
    ['stp2mesh.mjs', ['x.stp', '-o', 'm.stl/.'], NOT_DIR],
    ['stp2mesh.mjs', ['x.stp', '-o', 'nothere/.'], NOT_DIR],
    // (a link into a directory not there: that directory named, not the link's own -- r95 Q6)
    ['stp2mesh.mjs', ['x.stp', '-o', 'tonodir.cadmesh'], /no such directory .*\/nodir$/],
    // (through a chain of links, the last one's: the first's named hop/, which is there -- r102 Q4)
    ['stp2mesh.mjs', ['x.stp', '-o', 'l1.cadmesh'], /no such directory .*\/nodir2$/],
    // (an output that is the input, by another spelling too: the STEP replaced by a mesh, "OK" -- r92 Q3)
    ['stp2mesh.mjs', ['x.stp', '-o', join(dir, '.', 'x.stp')], /it is the input x\.stp$/],
    ['dwg-check.mjs', [notCad, '--dxf', notCad], /it is the input /],
    // (and the two tools that passed no inputs: a .cadmesh replaced by a glTF, a colours file by a
    // .cadmesh -- r93 A1)
    ['cadmesh-export.mjs', ['m.stl', '--to', 'stl', '--out', 'm'], /it is the input m\.stl$/],
    ['set-colours.mjs', ['box.cadmesh', 'box.rgb', '-o', 'box.rgb', '--by', 'test'], /it is the input box\.rgb$/],
  ]) {
    const r = run(tool, args);
    const lines = r.err.trim().split('\n');
    if (r.rc !== 1 || lines.length !== 1 || !lines[0].startsWith(`${tool.replace('.mjs', '')}: could not write `) || !want.test(lines[0]) || /\n\s+at /.test(r.err)) {
      bad.push(`${tool} ${args.join(' ')}: rc ${r.rc}, stderr ${JSON.stringify(r.err.slice(0, 300))}`);
    }
  }
  if (readFileSync(join(dir, 'x.stp'), 'utf8') !== 'ISO-10303-21;\n') bad.push('stp2mesh: x.stp overwritten');
  if (existsSync(join(dir, 'nothere'))) bad.push('stp2mesh: nothere/. made a file nothere');
  if (!readFileSync(join(dir, 'm.stl')).equals(readFileSync(join(dir, 'box.cadmesh')))) bad.push('cadmesh-export: m.stl overwritten');
  if (readFileSync(join(dir, 'box.rgb')).length !== 24) bad.push('set-colours: box.rgb overwritten');
  // a directory it may not write: refused before the work, in the same words (r27 Q6: two tools
  // split and coloured, then printed node's "EACCES"); not as root, which may write anywhere
  // (as root counted as skipped, not passed with no assertion: r95 Q7)
  if (process.getuid?.() === 0) skip('a directory it may not write, refused before the work', 'root may write anywhere');
  else {
    const ro = join(dir, 'ro');
    mkdirSync(ro, { mode: 0o555 });
    for (const [tool, args] of [['split-board.mjs', ['box.cadmesh', '-o', join(ro, 'x.cadmesh')]], ['set-colours.mjs', ['box.cadmesh', 'box.rgb', '-o', join(ro, 'x.cadmesh'), '--by', 't']],
      ['cadmesh-export.mjs', ['box.cadmesh', '--to', 'stl', '--out', join(ro, 'x')]], ['stp2mesh.mjs', ['x.stp', '-o', join(ro, 'x.cadmesh')]], ['dwg-check.mjs', [notCad, '--dxf', join(ro, 'x.dxf')]]]) {
      const r = run(tool, args);
      if (r.rc !== 1 || r.err !== `${tool.replace('.mjs', '')}: could not write ${args[args.indexOf(args.find((a) => a.startsWith(ro)))]}${tool === 'cadmesh-export.mjs' ? '.stl' : ''}: permission denied\n`) bad.push(`${tool} read-only: rc ${r.rc}, ${JSON.stringify(r.err)}`);
    }
  }
  // an input that is not there: one wording in all five ("ENOENT: ..." in two, both in a third)
  for (const [tool, args] of [
    ['stp2mesh.mjs', ['missing.stp']], ['cadmesh-export.mjs', ['missing.cadmesh']],
    ['split-board.mjs', ['missing.cadmesh', '-o', 'o.cadmesh']], ['set-colours.mjs', ['missing.cadmesh', 'box.rgb', '-o', 'o.cadmesh', '--by', 'me']],
  ]) {
    const r = run(tool, args);
    if (r.rc !== 1 || r.err !== `${tool.replace('.mjs', '')}: ${args[0]}: no such file\n`) bad.push(`${tool} ${args[0]}: rc ${r.rc}, stderr ${JSON.stringify(r.err)}`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
  // dwg-check: a drawing it cannot read is its row, in the reader's words, not "Error: ..."
  const r = run('dwg-check.mjs', [notCad]);
  assert.equal(r.rc, 1);
  assert.match(r.out, /: \? ERROR (?!Error)/);
  assert.equal(run('dwg-check.mjs', ['missing.dwg']).out, 'missing.dwg: ? ERROR no such file\n');
  // a usage error named for the tool, in each (stp2mesh said "unknown option --bogus" alone)
  for (const tool of ['stp2mesh.mjs', 'cadmesh-export.mjs', 'dwg-check.mjs', 'split-board.mjs', 'set-colours.mjs']) {
    const u = run(tool, ['--bogus']);
    assert.ok(u.rc === 2 && u.err.startsWith(`${tool.replace('.mjs', '')}: `), `${tool}: rc ${u.rc}, ${JSON.stringify(u.err.slice(0, 80))}`);
  }
});

test('a write in place that fails leaves the input as it was, said in the one wording (r93 Q1)', () => {
  // (must fire: under a file-size limit set-colours left its .cadmesh cut to 102,400 bytes, unreadable,
  // and printed node's "EFBIG: ...")
  const n = 20000;
  const positions = new Float32Array(n * 3).map((_, i) => (i * 7919) % 1000);
  const indices = new Uint32Array(Array.from({ length: n - 2 }, (_, i) => [i, i + 1, i + 2]).flat());
  const raw = encodeCadmesh({ units: 'mm', meshes: [{ name: 'big', color: [0.5, 0.5, 0.5], positions, normals: null, colors: null, indices }], root: { name: 'b', meshes: [0], children: [] } });
  const bytes = new Uint8Array(raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  assert.ok(bytes.length > 200 * 1024, `${bytes.length} bytes`);
  writeFileSync(join(dir, 'big.cadmesh'), bytes);
  writeFileSync(join(dir, 'big.rgba'), new Uint8Array(n * 4));
  const r = spawnSync('bash', ['-c', `ulimit -f 100; exec "${process.execPath}" "${join(HERE, 'set-colours.mjs')}" big.cadmesh big.rgba -o big.cadmesh --by test`], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^set-colours: could not write big\.cadmesh: /);
  assert.ok(Buffer.from(readFileSync(join(dir, 'big.cadmesh'))).equals(Buffer.from(bytes)), 'the input changed');
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'a temporary file left');
});

await test('a write in place as one was: through a link, the mode kept, gzipped as it came; a read-only directory refused before the work (r94 A1-A3)', async () => {
  const sub = join(dir, 'inplace');
  mkdirSync(sub);
  const box = readFileSync(join(dir, 'box.cadmesh'));
  const rgb = readFileSync(join(dir, 'box.rgb'));
  // (a link: the file it names is written, the link stays a link -- the rename made it a file of its
  // own and left the real one unchanged, exit 0)
  writeFileSync(join(sub, 'real.cadmesh'), box);
  writeFileSync(join(sub, 'c.rgb'), rgb);
  symlinkSync('real.cadmesh', join(sub, 'link.cadmesh'));
  // (0604: no umask makes it, so a new file's mode cannot pass for it -- 0640 did under umask 027: r94 Q2)
  chmodSync(join(sub, 'real.cadmesh'), 0o604);
  const r = spawnSync(process.execPath, [join(HERE, 'set-colours.mjs'), 'link.cadmesh', 'c.rgb', '-o', 'link.cadmesh', '--by', 't'], { cwd: sub, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(lstatSync(join(sub, 'link.cadmesh')).isSymbolicLink(), 'the link replaced by a file');
  assert.ok(!readFileSync(join(sub, 'real.cadmesh')).equals(box), 'the file the link names unchanged');
  assert.equal(statSync(join(sub, 'real.cadmesh')).mode & 0o777, 0o604, 'its mode not kept');
  // (a file with another name: both names see the new bytes -- the rename left the other the old: r94 Q3)
  writeFileSync(join(sub, 'h1.cadmesh'), box);
  linkSync(join(sub, 'h1.cadmesh'), join(sub, 'h2.cadmesh'));
  const h = spawnSync(process.execPath, [join(HERE, 'set-colours.mjs'), 'h1.cadmesh', 'c.rgb', '-o', 'h1.cadmesh', '--by', 't'], { cwd: sub, encoding: 'utf8', timeout: 60000 });
  assert.equal(h.status, 0, h.stderr);
  assert.ok(!readFileSync(join(sub, 'h1.cadmesh')).equals(box), 'h1 unchanged');
  assert.ok(readFileSync(join(sub, 'h2.cadmesh')).equals(readFileSync(join(sub, 'h1.cadmesh'))), 'the other name kept the old bytes');
  assert.deepEqual(readdirSync(sub).filter((f) => f.endsWith('.tmp')), [], 'a temporary file left');
  // (a link to a file not there yet: that file made, the link kept -- the rename replaced the link
  // and never made its file, exit 0: r95 A1)
  symlinkSync('made.cadmesh', join(sub, 'dangling.cadmesh'));
  const dl = spawnSync(process.execPath, [join(HERE, 'set-colours.mjs'), 'real.cadmesh', 'c.rgb', '-o', 'dangling.cadmesh', '--by', 't', '--again'], { cwd: sub, encoding: 'utf8', timeout: 60000 });
  assert.equal(dl.status, 0, dl.stderr);
  assert.ok(lstatSync(join(sub, 'dangling.cadmesh')).isSymbolicLink(), 'the dangling link replaced by a file');
  assert.ok(existsSync(join(sub, 'made.cadmesh')), 'the file the link names not made');
  // (a link in a linked directory: its target read from the link's real directory -- read from the
  // path as written, "x -> ../target.cadmesh" replaced a decoy beside the linked directory and left
  // the real target unchanged, exit 0: r96 Q2)
  mkdirSync(join(sub, 'real', 'inner'), { recursive: true });
  writeFileSync(join(sub, 'real', 'target.cadmesh'), box);
  writeFileSync(join(sub, 'target.cadmesh'), 'decoy');
  symlinkSync('../target.cadmesh', join(sub, 'real', 'inner', 'x.cadmesh'));
  symlinkSync(join('real', 'inner'), join(sub, 'outdir'));
  const ld = spawnSync(process.execPath, [join(HERE, 'set-colours.mjs'), 'real.cadmesh', 'c.rgb', '-o', join('outdir', 'x.cadmesh'), '--by', 't', '--again'], { cwd: sub, encoding: 'utf8', timeout: 60000 });
  assert.equal(ld.status, 0, ld.stderr);
  assert.equal(readFileSync(join(sub, 'target.cadmesh'), 'utf8'), 'decoy', 'the decoy beside the linked directory written');
  assert.ok(!readFileSync(join(sub, 'real', 'target.cadmesh')).equals(box), 'the link\'s real target unchanged');
  assert.ok(lstatSync(join(sub, 'real', 'inner', 'x.cadmesh')).isSymbolicLink(), 'the link replaced');
  // (".." after the linked directory, as the shell reads it: outdir/../c.rgb is real/c.rgb -- taken
  // from the path as written, it overwrote the colours input ./c.rgb, exit 0: r97 A1)
  const rgbBefore = readFileSync(join(sub, 'c.rgb'));
  const dd = spawnSync(process.execPath, [join(HERE, 'set-colours.mjs'), 'real.cadmesh', 'c.rgb', '-o', 'outdir/../c.rgb', '--by', 't', '--again'] /* (a string: path.join collapses the ..) */, { cwd: sub, encoding: 'utf8', timeout: 60000 });
  assert.equal(dd.status, 0, dd.stderr);
  assert.ok(readFileSync(join(sub, 'c.rgb')).equals(rgbBefore), 'the colours input overwritten');
  assert.ok(existsSync(join(sub, 'real', 'c.rgb')), 'real/c.rgb not written');
  // (a directory the system cannot read after "outdir/..": refused, "no such directory" -- read by
  // string as a fallback, "outdir/../zz/in.cadmesh" was the input ./zz/in.cadmesh, replaced, exit 0:
  // r98 A1)
  mkdirSync(join(sub, 'zz'));
  writeFileSync(join(sub, 'zz', 'in.cadmesh'), box);
  const nz = spawnSync(process.execPath, [join(HERE, 'set-colours.mjs'), 'zz/in.cadmesh', 'c.rgb', '-o', 'outdir/../zz/in.cadmesh', '--by', 't'], { cwd: sub, encoding: 'utf8', timeout: 60000 });
  assert.equal(nz.status, 1, nz.stderr);
  assert.match(nz.stderr, NOT_DIR);
  assert.ok(readFileSync(join(sub, 'zz', 'in.cadmesh')).equals(box), 'the input replaced');
  // (and ".." after a first name not there: no path, as the system says -- by string, it was
  // ./zz/in.cadmesh, overwritten, exit 0: r99 A2)
  const nm = spawnSync(process.execPath, [join(HERE, 'set-colours.mjs'), 'zz/in.cadmesh', 'c.rgb', '-o', 'nothere/../zz/in.cadmesh', '--by', 't'], { cwd: sub, encoding: 'utf8', timeout: 60000 });
  assert.equal(nm.status, 1, nm.stderr);
  assert.match(nm.stderr, NOT_DIR);
  assert.ok(readFileSync(join(sub, 'zz', 'in.cadmesh')).equals(box), 'the input replaced through a missing name');
  // (nor ".." after a name that is a file -- ENOTDIR: "c.rgb/../zz/in.cadmesh" was ./zz/in.cadmesh,
  // overwritten, exit 0: r100 A3)
  const nf = spawnSync(process.execPath, [join(HERE, 'set-colours.mjs'), 'zz/in.cadmesh', 'c.rgb', '-o', 'c.rgb/../zz/in.cadmesh', '--by', 't'], { cwd: sub, encoding: 'utf8', timeout: 60000 });
  assert.equal(nf.status, 1, nf.stderr);
  assert.match(nf.stderr, NOT_DIR);
  assert.ok(readFileSync(join(sub, 'zz', 'in.cadmesh')).equals(box), 'the input replaced through a file');
  // (a pipe after "outdir/..": the pipe the system names written, not the regular file ./pp.cadmesh
  // beside the link -- r98 A2)
  writeFileSync(join(sub, 'pp.cadmesh'), box);
  if (spawnSync('mkfifo', [join(sub, 'real', 'pp.cadmesh')]).status === 0) {
    const pr = spawnSync('bash', ['-c', `cat real/pp.cadmesh > real/pp.out & "${process.execPath}" "${join(HERE, 'set-colours.mjs')}" real.cadmesh c.rgb -o outdir/../pp.cadmesh --by t --again; rc=$?; wait; exit $rc`], { cwd: sub, encoding: 'utf8', timeout: 60000 });
    assert.equal(pr.status, 0, pr.stderr);
    assert.ok(readFileSync(join(sub, 'pp.cadmesh')).equals(box), 'the regular file beside the link replaced');
    assert.ok(readFileSync(join(sub, 'real', 'pp.out')).length > 0, 'nothing through the pipe');
  } else skip('a pipe after "outdir/.." written through', 'mkfifo failed here'); // (counted, not a silent pass: r102 Q5)
  // (a pipe written as it is, not replaced by a file; /dev/null written, not "permission denied":
  // r95 A2)
  if (spawnSync('mkfifo', [join(sub, 'pipe.cadmesh')]).status === 0) {
    const reader = spawnSync('bash', ['-c', `cat pipe.cadmesh > /dev/null & "${process.execPath}" "${join(HERE, 'set-colours.mjs')}" real.cadmesh c.rgb -o pipe.cadmesh --by t --again; rc=$?; wait; exit $rc`], { cwd: sub, encoding: 'utf8', timeout: 60000 });
    assert.equal(reader.status, 0, reader.stderr);
    assert.ok(lstatSync(join(sub, 'pipe.cadmesh')).isFIFO(), 'the pipe replaced by a file');
  } else skip('a pipe written as it is', 'mkfifo failed here');
  const nul = spawnSync(process.execPath, [join(HERE, 'set-colours.mjs'), 'real.cadmesh', 'c.rgb', '-o', '/dev/null', '--by', 't', '--again'], { cwd: sub, encoding: 'utf8', timeout: 60000 });
  assert.equal(nul.status, 0, nul.stderr);
  // (and a pipe reached by a link to "pipe:[…]": /dev/stdout written, not "permission denied" -- r95 Q3)
  // (through a shell's pipe, a FIFO, as a visitor's `| gzip` is: node's own child stdout is a socket)
  const so = spawnSync('bash', ['-c', `set -o pipefail; "${process.execPath}" "${join(HERE, 'set-colours.mjs')}" real.cadmesh c.rgb -o /dev/stdout --by t --again | wc -c`], { cwd: sub, encoding: 'utf8', timeout: 60000 });
  assert.equal(so.status, 0, so.stderr);
  assert.ok(Number(so.stdout.trim()) > box.length, `${so.stdout.trim()} bytes through the pipe`);
  // (a read-only file with other names: refused before anything is written, as the system opens it,
  // the file and its other name as they were and nothing left beside them -- r95 Q8's copy in place
  // failed here, said where the whole output was; since r101 the open refuses it first); not as root,
  // which may write a read-only file
  if (process.getuid?.() === 0) skip('a read-only file with other names refused before the write', 'root may write anywhere');
  else {
    writeFileSync(join(sub, 'ro1.cadmesh'), box);
    linkSync(join(sub, 'ro1.cadmesh'), join(sub, 'ro2.cadmesh'));
    chmodSync(join(sub, 'ro1.cadmesh'), 0o444);
    let said = '';
    try { await writeOutput(join(sub, 'ro1.cadmesh'), Buffer.from('new bytes')); } catch (e) { said = e.message; }
    assert.match(said, /^could not write .*ro1\.cadmesh: permission denied$/);
    assert.ok(readFileSync(join(sub, 'ro1.cadmesh')).equals(box) && readFileSync(join(sub, 'ro2.cadmesh')).equals(box), 'the file changed');
    assert.deepEqual(readdirSync(sub).filter((f) => f.endsWith('.tmp')), [], 'a temporary file left');
  }
  // (gzipped as it came, whatever the name: stp2mesh's own .cadmesh, recoloured in place, came back
  // 526% of its size)
  writeFileSync(join(sub, 'gz.cadmesh'), gzipSync(box));
  const g = spawnSync(process.execPath, [join(HERE, 'set-colours.mjs'), 'gz.cadmesh', 'c.rgb', '-o', 'gz.cadmesh', '--by', 't'], { cwd: sub, encoding: 'utf8', timeout: 60000 });
  assert.equal(g.status, 0, g.stderr);
  const out = readFileSync(join(sub, 'gz.cadmesh'));
  assert.ok(out[0] === 0x1f && out[1] === 0x8b, 'written uncompressed');
  // (a writable file in a directory it may not write: refused before the work, in the one wording --
  // stp2mesh converted it all, then failed on a ".tmp" never named); not as root
  if (process.getuid?.() === 0) skip('a writable file in a read-only directory, refused before the work', 'root may write anywhere');
  else {
    const ro = join(dir, 'ro-dir');
    mkdirSync(ro);
    writeFileSync(join(ro, 'x.cadmesh'), box);
    chmodSync(ro, 0o555);
    const s = run('stp2mesh.mjs', ['x.stp', '-o', join(ro, 'x.cadmesh')]);
    chmodSync(ro, 0o755);
    assert.equal(s.rc, 1, s.err);
    assert.equal(s.err, `stp2mesh: could not write ${join(ro, 'x.cadmesh')}: permission denied\n`);
    // (a link in that read-only directory to a file in one it may write: written, the file beside its
    // real path made there -- beside the path as written, it could not be: r101)
    const rw = join(dir, 'rw-dir');
    mkdirSync(rw);
    writeFileSync(join(rw, 'y.cadmesh'), box);
    symlinkSync(join(rw, 'y.cadmesh'), join(ro, 'y.cadmesh'));
    chmodSync(ro, 0o555);
    let said = '';
    try { await writeOutput(join(ro, 'y.cadmesh'), Buffer.from('new bytes')); } catch (e) { said = e.message; }
    chmodSync(ro, 0o755);
    assert.equal(said, '', said);
    assert.equal(readFileSync(join(rw, 'y.cadmesh'), 'utf8'), 'new bytes');
    assert.ok(lstatSync(join(ro, 'y.cadmesh')).isSymbolicLink(), 'the link replaced');
  }
});

// (r112 M cli-args-C0) a lone "-" (stdin by convention) is a positional word, not an option;
// "-x" is an option
test('a lone "-" is a positional word, "-x" an unknown option (r112 M cli-args-C0)', () => {
  assert.deepEqual(parseCli(['-'], { max: 1 }), { opts: {}, pos: ['-'] });
  assert.throws(() => parseCli(['-x'], { max: 1 }), (e) => e instanceof CliError && /unknown option -x/.test(e.message));
});

done();
