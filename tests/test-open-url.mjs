#!/usr/bin/env node
// Share links turned into the files they share (js/open-url.js).
//   node tests/test-open-url.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { directUrl } from '../js/open-url.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

const cases = [
  ['GitHub blob', 'https://github.com/acme/board/blob/main/cad/board.step', 'https://raw.githubusercontent.com/acme/board/main/cad/board.step', 'GitHub'],
  ['GitHub raw page', 'https://github.com/acme/board/raw/v1.2/board.stp', 'https://raw.githubusercontent.com/acme/board/v1.2/board.stp', 'GitHub'],
  ['GitLab blob', 'https://gitlab.com/acme/board/-/blob/main/board.step', 'https://gitlab.com/acme/board/-/raw/main/board.step', 'GitLab'],
  ['Dropbox dl=0', 'https://www.dropbox.com/s/abc123/board.step?dl=0', 'https://www.dropbox.com/s/abc123/board.step?dl=1', 'Dropbox'],
  ['Dropbox scl with rlkey', 'https://www.dropbox.com/scl/fi/xyz/board.step?rlkey=k&dl=0', 'https://www.dropbox.com/scl/fi/xyz/board.step?rlkey=k&dl=1', 'Dropbox'],
  ['Google Drive file page', 'https://drive.google.com/file/d/1AbC_d-E/view?usp=sharing', 'https://drive.google.com/uc?export=download&id=1AbC_d-E', 'Google Drive'],
  ['Google Drive open?id=', 'https://drive.google.com/open?id=1AbC', 'https://drive.google.com/uc?export=download&id=1AbC', 'Google Drive'],
];
for (const [name, from, want, host] of cases) {
  test(name, () => { const r = directUrl(from); assert.equal(r.url, want); assert.equal(r.from, host); });
}
test('left as they are: a raw URL, a GitHub repo page, Dropbox dl=1, not a URL', () => {
  for (const u of ['https://raw.githubusercontent.com/a/b/main/x.stp', 'https://github.com/acme/board', 'https://www.dropbox.com/s/abc/x.stp?dl=1', 'models/x.cadmesh']) {
    const r = directUrl(u);
    assert.equal(r.url, u);
    assert.equal(r.from, null);
  }
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
