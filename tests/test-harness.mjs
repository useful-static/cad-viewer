#!/usr/bin/env node
// The harness itself (tests/harness.mjs): an async arm left without `await` fails its file at
// done() -- before r113 it never ran, and the file read as passed (r112's trap; r113 b) -- and one
// awaited passes. Each case is a small test file run as its own process, as run-all runs them.
//   node tests/test-harness.mjs   -> "RESULT: N passed, 0 failed"

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, done } from './harness.mjs';

const harness = pathToFileURL(join(import.meta.dirname, 'harness.mjs')).href;
const run = (body) => {
  const dir = mkdtempSync(join(tmpdir(), 'cv-harness-'));
  try {
    const f = join(dir, 'test-case.mjs');
    writeFileSync(f, `import { test, done } from ${JSON.stringify(harness)};\n${body}\ndone();\n`);
    const r = spawnSync(process.execPath, [f], { encoding: 'utf8', timeout: 30000 });
    return { status: r.status, out: r.stdout };
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('an async arm without await fails its file at done(), named (must fire: it never ran, and the file passed)', () => {
  const r = run("test('later', async () => { await new Promise((s) => setTimeout(s, 50)); throw new Error('never seen'); });");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL later: an async arm still running at done\(\)/);
  assert.match(r.out, /RESULT: 0 passed, 1 failed/);
});
test('the same arm awaited runs, and its own failure is the one reported', () => {
  const r = run("await test('later', async () => { await new Promise((s) => setTimeout(s, 50)); throw new Error('seen'); });");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL later: Error: seen/);
  const ok = run("await test('fine', async () => { await new Promise((s) => setTimeout(s, 10)); });\ntest('sync', () => {});");
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /RESULT: 2 passed, 0 failed/);
});

done();
