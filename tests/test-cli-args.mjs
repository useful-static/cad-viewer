#!/usr/bin/env node
// The command-line tools' one argument rule (js/cli-args.js parseCli), and each tool held to it:
// an unknown or repeated option, a value option whose value is an option, a value that is no
// number where one is wanted, a second input -- each a usage error, exit 2, on stderr; an input
// that is not what the tool reads, exit 1. No GPU, no network, no OpenCascade (every case is
// refused before a file is converted):  node tests/test-cli-args.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, parseCli, positive } from '../js/cli-args.js';
import { encodeCadmesh } from '../js/cadmesh.js';

import { test, done } from './harness.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'cv-cli-'));
const notCad = join(dir, 'notcad.txt');
writeFileSync(notCad, 'not a CAD file\n');
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
  const cases = [
    ['stp2mesh.mjs', ['x.stp', '-o', '--raw'], 2, /-o needs a value/],
    ['stp2mesh.mjs', ['x.stp', '-o', 'a.cadmesh', '-o', 'b.cadmesh'], 2, /given twice/],
    ['stp2mesh.mjs', ['x.stp', '--angular', '0.5', '--angular', '0.2'], 2, /given twice/],
    ['stp2mesh.mjs', [notCad], 1, /unsupported extension \.txt/],
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
    // (an output that is the input, by another spelling too: the STEP replaced by a mesh, "OK" -- r92 Q3)
    ['stp2mesh.mjs', ['x.stp', '-o', join(dir, '.', 'x.stp')], /it is the input x\.stp$/],
    ['dwg-check.mjs', [notCad, '--dxf', notCad], /it is the input /],
  ]) {
    const r = run(tool, args);
    const lines = r.err.trim().split('\n');
    if (r.rc !== 1 || lines.length !== 1 || !lines[0].startsWith(`${tool.replace('.mjs', '')}: could not write `) || !want.test(lines[0]) || /\n\s+at /.test(r.err)) {
      bad.push(`${tool} ${args.join(' ')}: rc ${r.rc}, stderr ${JSON.stringify(r.err.slice(0, 300))}`);
    }
  }
  if (readFileSync(join(dir, 'x.stp'), 'utf8') !== 'ISO-10303-21;\n') bad.push('stp2mesh: x.stp overwritten');
  // a directory it may not write: refused before the work, in the same words (r27 Q6: two tools
  // split and coloured, then printed node's "EACCES"); not as root, which may write anywhere
  if (process.getuid?.() !== 0) {
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
  assert.deepEqual(bad, []);
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

done();
