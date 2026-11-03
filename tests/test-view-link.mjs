#!/usr/bin/env node
// The shareable view (js/view-link.js).   node tests/test-view-link.mjs  (exit 0 = all pass)

import assert from 'node:assert/strict';
import { MAX_LINK_IDS, MAX_NAMED, MAX_NOTES, NOTE_TEXT_MAX, bodyKeys, cutText, decodeView, encodeView, modelPrint, parseRuns, resolveBodies, roundCamera, runs } from '../js/view-link.js';

import { test, done } from './harness.mjs';

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
  // the camera rounded one way for a link and a tour: far from the origin, the target to a millionth
  // of the distance (a tour kept 4 decimals), the turn to 6 figures
  const rc = roundCamera({ target: [123456.7891234, 0.00012345678, -5], dist: 0.5, q: [0.123456789, 0, 0, 0.9923] });
  // (a millionth of 0.5 is the 7th decimal)
  assert.deepEqual(rc, { target: [123456.7891234, 0.0001235, -5], dist: 0.5, q: [0.123457, 0, 0, 0.9923] });
  // an empty section value is none (it read 0: the cut at the model's minimum), as e:'s is
  assert.equal(decodeView('c:0,0,0,1,0,0,0,1;x:z,').section, undefined);
  assert.equal(decodeView('c:0,0,0,1,0,0,0,1;x:z, ,f').section, undefined);
  assert.deepEqual(decodeView('c:0,0,0,1,0,0,0,1;x:z,0').section, { axis: 'z', t: 0, flip: false });
  // and an empty explode or camera value (they read 0: an explode at 0, a target at the origin)
  assert.equal(decodeView('c:0,0,0,1,0,0,0,1;e: ,x').explode, undefined);
  assert.deepEqual(decodeView('c:0,0,0,1,0,0,0,1;e:0,x').explode, { t: 0, mode: 'x' });
  assert.equal(decodeView('c:,,,100,0,0,0,1').cam, undefined);
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
  // (to the micrometre, as a tour keeps a note: six significant figures moved one at 123456.789)
  assert.deepEqual(d.notes, [{ p: [80.5, 3.5, 1.2], text: 'Mount, M2.5; ~ok: 板' }, { p: [-0.001, 0, 1234.568], text: 'b' }]);
  assert.deepEqual(decodeView(encodeView({ ...view, notes: [{ p: [123456.789, 4567.891, 1.6], text: 'x' }] })).notes[0].p, [123456.789, 4567.891, 1.6]);
  // a note with an empty coordinate is none
  assert.deepEqual(decodeView('a:,,,QQ').notes || [], []);
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

test('Explode rides in the link: how far and how; off leaves it out; a bad one is dropped', () => {
  const s = encodeView({ ...view, explode: { t: 0.65, mode: 'z' } });
  assert.match(s, /;e:0\.65,z/);
  assert.deepEqual(decodeView(s).explode, { t: 0.65, mode: 'z' });
  assert.deepEqual(decodeView(encodeView({ ...view, explode: { t: 0.4, mode: 'assembly' } })).explode, { t: 0.4, mode: 'assembly' });
  assert.ok(!/(^|;)e:/.test(encodeView({ ...view, explode: null })), 'no e: when Explode is off');
  for (const e of ['1.5,z', '-0.1,z', 'x,z', '0.5,diagonal', '0.5']) assert.equal(decodeView(`c:0,0,0,10,0,0,0,1;e:${e}`).explode, undefined, e);
});
test('a link repeating "h:1-999999" a thousand times: the first h counts, one id budget for h and k, fast', () => {
  const link = Array(1000).fill('h:1-999999').join(';') + ';k:1-999999';
  const t0 = Date.now();
  const v = decodeView(link);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  assert.equal(v.hidden.length, 999999);
  assert.ok(v.hidden.length + v.selected.length <= MAX_LINK_IDS);
});

test('a note cut to its limit never through a surrogate pair (an emoji at the cut is left out whole)', () => {
  const s = `${'a'.repeat(NOTE_TEXT_MAX - 1)}😀`;
  assert.equal(cutText(s, NOTE_TEXT_MAX), 'a'.repeat(NOTE_TEXT_MAX - 1));
  assert.equal(cutText('short', NOTE_TEXT_MAX), 'short');
  assert.equal(cutText(`${'a'.repeat(NOTE_TEXT_MAX - 2)}😀b`, NOTE_TEXT_MAX), `${'a'.repeat(NOTE_TEXT_MAX - 2)}😀`);
});

done();
