#!/usr/bin/env node
// Run every tests/test-*.mjs (Node, no browser), one line each, and the sums. A test ends with
// its summary line, "RESULT: <p> passed, <f> failed[, <s> skipped]" (tests/harness.mjs prints
// it); a file passes when it exits 0 AND prints that line with no failure. Skipped arms (a
// corpus or fixture the host lacks: DWG_CORPUS, CADV_STEP_FIXTURE) are counted and named;
// --strict fails on any.
//
//   node tests/run-all.mjs [--strict] [PATTERN]   (or: npm test)
//   PATTERN: run only the tests whose file name contains it
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) { console.log('usage: run-all.mjs [--strict] [PATTERN]'); process.exit(0); }
const strict = args.includes('--strict');
const only = args.find((a) => !a.startsWith('--')) || '';
const tests = readdirSync(here).filter((f) => /^test-.*\.mjs$/.test(f) && f.includes(only)).sort();
if (!tests.length) { console.log(`no tests match "${only}"`); process.exit(2); }
const SUMMARY = /^RESULT: (\d+) passed, (\d+) failed(?:, (\d+) skipped)?$/;
const sum = { passed: 0, failed: 0, skipped: 0 };
const bad = [];
const skippedIn = [];
for (const t of tests) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(here, t)], { encoding: 'utf8', timeout: 600000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  const m = out.map((l) => SUMMARY.exec(l.trim())).filter(Boolean).pop();
  const [p, f, s] = m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : [0, 0, 0];
  sum.passed += p; sum.failed += f; sum.skipped += s;
  const ok = r.status === 0 && m && f === 0;
  if (!ok) bad.push(t);
  if (s) skippedIn.push(`${t} (${s})`);
  const why = !m ? 'no RESULT line' : r.status !== 0 ? `exit ${r.status}` : '';
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${t.padEnd(30)} ${String(Date.now() - t0).padStart(6)} ms  ${m ? m[0] : out[out.length - 1].slice(0, 80)}${why && ok === false ? `  (${why})` : ''}`);
  if (!ok) console.log(out.filter((l) => /^(FAIL|Error|    at |AssertionError)/.test(l)).slice(0, 12).map((l) => `     | ${l}`).join('\n'));
}
if (skippedIn.length) console.log(`skipped arms in: ${skippedIn.join(', ')}`);
console.log(`RESULT: ${sum.passed} passed, ${sum.failed} failed, ${sum.skipped} skipped (files: ${tests.length - bad.length} of ${tests.length})`);
process.exit(bad.length || (strict && sum.skipped) ? 1 : 0);
