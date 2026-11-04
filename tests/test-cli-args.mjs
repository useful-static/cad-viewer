#!/usr/bin/env node
// The command-line tools' one argument rule (js/cli-args.js parseCli), and each tool held to it:
// an unknown or repeated option, a value option whose value is an option, a value that is no
// number where one is wanted, a second input -- each a usage error, exit 2, on stderr; an input
// that is not what the tool reads, exit 1. No GPU, no network, no OpenCascade (every case is
// refused before a file is converted):  node tests/test-cli-args.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, parseCli, positive } from '../js/cli-args.js';

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
  for (const [argv, msg] of [[['a', '-o', '--raw'], /-o needs a value/], [['a', '-o', 'x', '-o', 'y'], /-o given twice/], [['a', '--bogus'], /unknown option --bogus/],
    [['a', 'b'], /one input file, not 2/], [['a', '--to', '-h'], /--to needs a value/], [['a', '--raw=1'], /takes no value/], [['a', '--to='], /--to needs a value/]]) {
    assert.throws(() => parseCli(argv, spec), (e) => e instanceof CliError && msg.test(e.message), argv.join(' '));
  }
  // (a negative number is a value, not an option)
  assert.deepEqual(parseCli(['-o', '-5'], { values: ['-o'] }).opts, { '-o': '-5' });
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
    ['dwg-check.mjs', [], 2, /no DWG file given/],
    ['dwg-check.mjs', ['--dxf', 'x1.dxf', '--dxf', 'x2.dxf', 'a.dwg'], 2, /given twice/],
    ['split-board.mjs', ['b.cadmesh', '-o', 'o.cadmesh', '--edgs'], 2, /unknown option --edgs/],
    ['split-board.mjs', ['b.cadmesh', '-o', 'o.cadmesh', '--sliver', 'abc'], 2, /--sliver needs a positive number/],
    ['set-colours.mjs', ['b.cadmesh', 'c.rgb', '--agian', '-o', 'o.cadmesh', '--by', 'me'], 2, /unknown option --agian/],
    ['set-colours.mjs', ['b.cadmesh', 'c.rgb', '-o', 'o.cadmesh'], 2, /--by/],
  ];
  const bad = [];
  for (const [tool, args, rc, msg] of cases) {
    const r = run(tool, args);
    // (said on stderr, no stack trace, nothing on stdout)
    if (r.rc !== rc || !msg.test(r.err) || /\n\s+at /.test(r.err) || r.out) bad.push(`${tool} ${args.join(' ')}: rc ${r.rc}, stderr ${JSON.stringify(r.err.slice(0, 160))}, stdout ${JSON.stringify(r.out.slice(0, 80))}`);
  }
  assert.deepEqual(bad, []);
  // and -h is help: exit 0, the usage on stdout
  for (const tool of ['stp2mesh.mjs', 'cadmesh-export.mjs', 'dwg-check.mjs', 'split-board.mjs', 'set-colours.mjs']) {
    const r = run(tool, ['-h']);
    assert.ok(r.rc === 0 && /usage/.test(r.out + r.err), `${tool} -h: rc ${r.rc}`);
  }
});

done();
