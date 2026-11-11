// The tests' shared harness: test(name, fn) (fn may be async), skip(name, why), and done(), which
// prints the summary every test ends with -- "RESULT: <p> passed, <f> failed, <s> skipped" --
// and exits 1 on a failure. tests/run-all.mjs reads that line.
//
//   import { test, skip, done } from './harness.mjs';
//   await test('a cube', () => { ... });
//   done();
//
//   node tests/test-x.mjs [name-part]   runs only the arms whose name holds name-part (an arm
//   that ends the process, a heap OOM say, is then run alone)

let passed = 0;
let failed = 0;
let skipped = 0;
// async arms started and not yet settled: done() with one still open fails the file -- an arm
// written `test(..., async ...)` without `await` never ran before done() exited, and the file read
// as passed (r112's trap; r113 b)
const pending = new Set();
const ONLY = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : '';

// a synchronous arm is counted at once; an async one when it settles (await it before done())
export function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return undefined;
  const pass = () => { passed++; console.log(`PASS ${name}`); };
  const fail = (e) => { failed++; console.log(`FAIL ${name}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); };
  let r;
  try { r = fn(); } catch (e) { fail(e); return undefined; }
  if (r && typeof r.then === 'function') {
    pending.add(name);
    return r.then(pass, fail).finally(() => pending.delete(name));
  }
  pass();
  return undefined;
}

export function skip(name, why) {
  skipped++;
  console.log(`SKIP ${name}: ${why}`);
}

export function done() {
  for (const name of pending) { failed++; console.log(`FAIL ${name}: an async arm still running at done() -- write it \`await test(...)\`, or it never runs`); }
  console.log(`RESULT: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(failed ? 1 : 0);
}
