#!/usr/bin/env node
// The shareable view (js/view-link.js).   node tests/test-view-link.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { MAX_NAMED, MAX_NOTES, bodyKeys, decodeView, encodeView, modelPrint, parseRuns, resolveBodies, runs } from '../js/view-link.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

const view = {
  cam: { target: [12.3456789, -4, 1e-7], dist: 1234.56789, q: [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)], ortho: true, orient: '+z-y' },
  style: 'hiddengrey', section: { axis: 'z', t: 0.4321, flip: true }, hidden: [7, 1, 2, 3, 3], selected: [5],
};

test('runs and back', () => {
  assert.equal(runs([7, 1, 2, 3, 3, 10, 9]), '1-3,7,9-10');
  assert.deepEqual(parseRuns('1-3,7,9-10'), [1, 2, 3, 7, 9, 10]);
  assert.equal(runs([]), '');
});
test('a view round-trips: the target to a millionth of the distance, the rest to 6 significant digits', () => {
  const s = encodeView(view);
  // dist 1234.57: the target to 0.001
  assert.ok(s.startsWith('c:12.346,-4,0,1234.57,'), s);
  const d = decodeView(s);
  assert.deepEqual(d.cam.target, [12.346, -4, 0]);
  assert.equal(d.cam.dist, 1234.57);
  assert.ok(d.cam.q.every((x, i) => Math.abs(x - view.cam.q[i]) < 1e-5));
  assert.equal(d.cam.ortho, true);
  assert.equal(d.cam.orient, '+z-y');
  assert.ok(s.includes(';u:z;'), s); // Z up as the older links wrote it
  assert.equal(d.style, 'hiddengrey');
  assert.deepEqual(d.section, { axis: 'z', t: 0.4321, flip: true });
  assert.deepEqual(d.hidden, [1, 2, 3, 7]);
  assert.deepEqual(d.selected, [5]);
});
test('far from the origin, the target keeps the precision the view needs (review r14)', () => {
  // 100 m out, looked at from 10 mm: 6 significant digits would be 1 mm off
  const far = { cam: { target: [100000.1234567, -250000.7654321, 3.3333333], dist: 10, q: [0, 0, 0, 1], ortho: false } };
  const d = decodeView(encodeView(far));
  far.cam.target.forEach((t, i) => assert.ok(Math.abs(d.cam.target[i] - t) <= 10 * 1e-6, `${d.cam.target[i]} vs ${t}`));
  // and a huge view keeps whole numbers, never more digits than it needs
  const huge = decodeView(encodeView({ cam: { target: [1.5, 2.25, 3], dist: 1e9, q: [0, 0, 0, 1] } }));
  assert.deepEqual(huge.cam.target, [2, 2, 3]);
});

test('defaults stay out of the link', () => {
  const s = encodeView({ cam: { target: [0, 0, 0], dist: 1, q: [0, 0, 0, 1], ortho: false, orient: '+y+z' }, section: { axis: 'off' } });
  assert.equal(s, 'c:0,0,0,1,0,0,0,1');
  const d = decodeView(s);
  assert.equal(d.cam.ortho, false);
  assert.equal(d.cam.orient, '+y+z');
  assert.equal(d.section, undefined);
});
test('any orientation round-trips; old u:z / u:y links still read; a bad one is the default', () => {
  const cam = { target: [0, 0, 0], dist: 1, q: [0, 0, 0, 1] };
  const s = encodeView({ cam: { ...cam, orient: '+z+x' } });
  assert.ok(s.endsWith(';u:+z+x'), s);
  assert.equal(decodeView(s).cam.orient, '+z+x');
  assert.equal(decodeView('c:0,0,0,1,0,0,0,1;u:z').cam.orient, '+z-y');
  assert.equal(decodeView('c:0,0,0,1,0,0,0,1;u:y').cam.orient, '+y+z');
  assert.equal(decodeView('c:0,0,0,1,0,0,0,1;u:+z+z').cam.orient, '+y+z');
  // a link written by the page goes through URL.hash, which keeps "+"
  const u = new URL('https://cad.place/');
  u.hash = `view=${s}`;
  assert.equal(decodeView(decodeURIComponent(u.hash.slice(6))).cam.orient, '+z+x');
});
test('a hand-edited or broken link drops what it cannot read, never throws', () => {
  assert.deepEqual(decodeView('c:1,2,3;s:Bad Style;x:w,2;zz:1;h:a-b,4'), { hidden: [4] });
  assert.deepEqual(decodeView(''), {});
  assert.deepEqual(decodeView('c:0,0,0,-5,0,0,0,1'), {}, 'a negative distance');
  assert.equal(parseRuns('1-1000000000', 10).length, 10, 'a huge run is capped');
});
test('a quaternion is renormalised', () => {
  const d = decodeView('c:0,0,0,10,0,0,0,2');
  assert.deepEqual(d.cam.q, [0, 0, 0, 1]);
});

// ---- bodies by name (feature review 2026-10-29): a link outlives a regenerated or revised model ----
const labels = ['PCB', 'HDMI › SOLID', 'USB, A; "x": 1 › SOLID', 'HDMI › SOLID', 'Ä 板'];
test('every body gets its own key, repeats numbered', () => {
  assert.deepEqual(bodyKeys(labels), ['PCB', 'HDMI › SOLID', 'USB, A; "x": 1 › SOLID', 'HDMI › SOLID #2', 'Ä 板']);
});
test('names survive the hash, including , ; : and non-ASCII, and a decode of the whole hash', () => {
  const keys = bodyKeys(labels);
  const s = encodeView({ ...view, selected: [3, 4, 5], keys });
  // the page decodes the whole hash once (main.js viewHash)
  const d = decodeView(decodeURIComponent(s));
  assert.equal(d.model, modelPrint(keys));
  assert.deepEqual(d.selNames, [keys[2], keys[3], keys[4]]);
  assert.deepEqual(d.selected, [3, 4, 5]);
});
test('same model: the ids are used (hidden too)', () => {
  const keys = bodyKeys(labels);
  const d = decodeView(encodeView({ ...view, hidden: [1], selected: [4], keys }));
  assert.deepEqual(resolveBodies(d, keys), { hidden: [1], selected: [4], changed: false });
});
test('a changed model: the selection by name, the hidden ids dropped (ids alone would pick the wrong part)', () => {
  const before = bodyKeys(labels);
  const d = decodeView(encodeView({ ...view, hidden: [1], selected: [4], keys: before }));
  // the regenerated file put a body in front: id 4 is now the other HDMI body
  const after = bodyKeys(['Board outline', ...labels]);
  assert.equal(after[3], 'USB, A; "x": 1 › SOLID', 'the arm: id 4 names another body now');
  // (the second HDMI body keeps its key, and is found at its new id)
  assert.deepEqual(resolveBodies(d, after), { hidden: [], selected: [5], changed: true });
});
test('notes round-trip through the hash, text with , ; ~ : and non-ASCII; at most MAX_NOTES', () => {
  const notes = [{ p: [80.5, 3.5, 1.2], text: 'Mount, M2.5; ~ok: 板' }, { p: [-1e-3, 0, 1234.5678], text: 'b' }];
  const d = decodeView(decodeURIComponent(encodeView({ ...view, notes })));
  assert.deepEqual(d.notes, [{ p: [80.5, 3.5, 1.2], text: 'Mount, M2.5; ~ok: 板' }, { p: [-0.001, 0, 1234.57], text: 'b' }]);
  const many = Array.from({ length: MAX_NOTES + 5 }, (_, i) => ({ p: [i, 0, 0], text: `n${i}` }));
  assert.equal(decodeView(encodeView({ ...view, notes: many })).notes.length, MAX_NOTES);
  assert.deepEqual(decodeView('a:1,2,x,QQ~1,2,3,@@~1,2,3,QQ').notes, [{ p: [1, 2, 3], text: 'A' }]);
});
test('an older link (no fingerprint) keeps its ids; too many selected leaves the names out', () => {
  const keys = bodyKeys(labels);
  assert.deepEqual(resolveBodies(decodeView('k:2;h:1'), keys), { hidden: [1], selected: [2], changed: false });
  const many = Array.from({ length: MAX_NAMED + 1 }, (_, i) => `p${i}`);
  const s = encodeView({ ...view, selected: many.map((_, i) => i + 1), keys: many });
  assert.ok(s.includes(';m:') && !s.includes(';n:'), s);
  assert.deepEqual(decodeView('n:@@,!!').selNames, []);
});

test('the view shape round-trips (a desktop link reframed on a phone); a wild one is dropped', () => {
  const v = { cam: { target: [0, 0, 0], dist: 10, q: [0, 0, 0, 1] }, aspect: 1.6012 };
  assert.equal(decodeView(encodeView(v)).aspect, 1.601);
  assert.equal(decodeView(encodeView({ cam: v.cam })).aspect, undefined); // an older link: none
  for (const w of ['0', '-1', '99', 'x']) assert.equal(decodeView(`c:0,0,0,10,0,0,0,1;w:${w}`).aspect, undefined);
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
