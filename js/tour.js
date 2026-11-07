// Tours: a .cadtour.json read and checked, and its part names
// matched to a model's bodies. Pure (no DOM), so tests/test-tour.mjs checks it
// in Node.
//
// A tour is { cadtour: 1|2, title?, model?, orient?, unit?, mode?, loop?, defaults?, steps: [...] }
// (unit: the unit its sizes were written in for a model with no unit of its own; tourAt below).
// Version 2 is version 1 plus an optional step "id": a fixed name a page
// can ask for one step by (?step=<id>), where a title is for people and
// gets renamed. A v1 file with an "id" is refused, as any unknown field is.
// Every value is checked and a wrong one refuses the whole file, naming the
// step and the field: a typo in a field name is refused too, since a tour that
// silently ignored "colour" spelled "color" would play wrong without a word.
// "orient" is the model's orientation while the tour plays ("+z-y": +z up,
// -y toward the viewer; js/orient.js), so its presets and "outside" mean the
// same on every page that opens it.

import { VIEW_PRESETS, parseOrient } from './orient.js';
import { samePlace } from './same-place.js';
import { STYLE_IDS } from './styles.js';
import { DISPLAY_UNITS, MM_PER } from './units.js';
import { EXPLODE_MODES, NOTES_MAX, NOTE_TEXT_MAX, notePlace } from './view-link.js';

export const PRESETS = Object.keys(VIEW_PRESETS);
// A tour's file name from its title: lower case, a run of anything else one hyphen, "tour" when
// nothing is left -- the one rule, the saved tour's (js/tour-recorder.js) and its pictures' zip and
// video's (main.js), written twice: r76 A8
export const tourSlug = (s) => (s || 'tour').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tour';
export const EASES = ['linear', 'inOut'];
export const DIMS = ['none', 'ghost', 'grey', 'hide'];
// how a tour plays: a step at a time, or by itself (the first is the default)
export const MODES = ['static', 'animated'];
export const MAX_STEPS = 200;
export const DEFAULTS = { transition: 1.2, hold: 4, ease: 'inOut', dim: 'none' };

// the format version a tour is written in (js/tour-recorder.js), and every
// field a step may hold (version 2 adds "id")
export const TOUR_VERSION = 2;
export const STEP_FIELDS = ['title', 'text', 'view', 'frame', 'from', 'margin', 'colour', 'dim', 'show', 'hide', 'isolate',
  'explode', 'explodeAlong', 'section', 'style', 'callouts', 'transition', 'ease', 'hold', 'orbit', 'ortho'];
export const STEP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOP_FIELDS =['cadtour', 'title', 'model', 'orient', 'unit', 'mode', 'loop', 'defaults', 'steps'];

const isText = (v, max) => typeof v === 'string' && v.length <= max;
const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const isColour = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
// the longest part name a tour or a model list may give (a node, a body, a path of them)
export const PART_NAME_MAX = 300;
// the most part names one list of them may hold, in a tour (a step's hide, colour, …) or a model
// list (hide; labels): one limit, so the tour maker, which writes a list's names into a step,
// never writes a step the parser refuses (a list hid 1000, a tour took 500)
export const PART_NAMES_MAX = 1000;
// the longest title (a tour's, a step's) and step text; the tour maker's inputs take these
export const TITLE_MAX = 200;
export const TEXT_MAX = 2000;
export const isPartName = (s) => typeof s === 'string' && !!s.trim() && s.length <= PART_NAME_MAX;
const isNames = (v) => Array.isArray(v) && v.length <= PART_NAMES_MAX && v.every(isPartName);
const NAMES_RULE = `at most ${PART_NAMES_MAX} part names of at most ${PART_NAME_MAX} characters`;

// text -> the tour, every default filled in; throws an Error naming what is wrong.
// base: the URL the tour was read from (its model URL is resolved against it).
// the largest tour read (200 steps of the longest texts and views fit many times over); it is
// read on the page's own thread, so the bound is the page's
export const MAX_TOUR_BYTES = 4 * 2 ** 20;
// a string's length in UTF-8 bytes, without encoding it (stops counting past the tour limit)
function utf8Length(s) {
  if (s.length > MAX_TOUR_BYTES) return s.length; // (every character is at least a byte)
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; } // a surrogate pair (a lone high surrogate is 3, and the next character its own)
    else n += 3;
  }
  return n;
}

// The factor from sizes written for one reading of a unit-less mesh to another: the inch
// reading's coordinates are the mm reading's x 25.4. The one rule for a tour (tourAt) and a model
// list's note points (written for the mm reading: main.js applyListEntry). 1 with no reading
export function readingScale(unit, from = 'mm') {
  return unit && unit !== from && MM_PER[unit] && MM_PER[from] ? MM_PER[unit] / MM_PER[from] : 1;
}

// A tour (as parseTour gives it) at the size a mesh is read in now: a tour made with the file read
// in inches holds cameras, frame boxes and callout points 25.4 times those of the mm reading, so
// its sizes are scaled by the ratio of the two units (fractions -- a section's t, explode, margin --
// are not sizes). `unit` null: the model has no reading to choose (a STEP, a .cadmesh): as made.
// One rule for the player (main.js startTourIn) and the tour maker (a tour read back)
export function tourAt(tour, unit) {
  const from = tour.unit || 'mm';
  const k = readingScale(unit, from);
  if (k === 1) return tour;
  const v3 = (p) => p.map((x) => x * k);
  const steps = tour.steps.map((s) => {
    const o = { ...s };
    if (s.view && typeof s.view === 'object') o.view = { ...s.view, cam: { ...s.view.cam, target: v3(s.view.cam.target), dist: s.view.cam.dist * k } };
    if (s.frame && typeof s.frame === 'object' && !Array.isArray(s.frame)) o.frame = { min: v3(s.frame.min), max: v3(s.frame.max) };
    if (s.callouts) o.callouts = s.callouts.map((c) => (c.at ? { ...c, at: v3(c.at) } : c));
    return o;
  });
  return { ...tour, unit, steps };
}

export function parseTour(text, base = undefined) {
  // (counted in BYTES, as the page's read counts them (readCapped): a CJK tour of 1.8 M characters
  // is 5 MB, which the maker saved and check-tour passed, and the page refused)
  if (typeof text === 'string' && utf8Length(text) > MAX_TOUR_BYTES) throw new Error(`over ${MAX_TOUR_BYTES / 2 ** 20} MB: not a tour this viewer reads`);
  let t;
  try { t = JSON.parse(text); } catch (e) { throw new Error(`not JSON: ${e.message}`); }
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('a tour is a JSON object');
  const bad = (where, why) => new Error(`${where}: ${why}`);
  for (const k of Object.keys(t)) if (!TOP_FIELDS.includes(k)) throw bad(`"${k}"`, `not a tour field (${TOP_FIELDS.join(', ')})`);
  if (t.cadtour !== 1 && t.cadtour !== 2) throw bad('"cadtour"', 'must be 1 or 2 (the format version)');
  if (t.title !== undefined && !isText(t.title, TITLE_MAX)) throw bad('"title"', `must be text of at most ${TITLE_MAX} characters`);
  let model;
  if (t.model !== undefined) {
    if (typeof t.model !== 'string' || !t.model.trim()) throw bad('"model"', 'must be a URL');
    try { model = new URL(t.model, base).href; } catch { throw bad('"model"', `"${t.model}" is not a URL`); }
    if (!samePlace(model, base)) throw bad('"model"', 'must be an http(s) URL, or on the tour\'s own scheme and host');
  }
  let orient = null;
  if (t.orient !== undefined) {
    try { orient = parseOrient(t.orient); } catch (e) { throw bad('"orient"', e.message); }
  }
  // the unit a unit-less mesh (STL, OBJ, PLY, OFF) was read in when the tour was made ("this file
  // is in"): its cameras are at that size. Left out: as the file reads, mm
  if (t.unit !== undefined && !DISPLAY_UNITS.includes(t.unit)) throw bad('"unit"', `must be one of ${DISPLAY_UNITS.join(', ')}`);
  const unit = t.unit || 'mm';
  const mode = t.mode === undefined ? MODES[0] : t.mode;
  if (!MODES.includes(mode)) throw bad('"mode"', `must be ${MODES.map((m) => `"${m}"`).join(' or ')}`);
  if (t.loop !== undefined && typeof t.loop !== 'boolean') throw bad('"loop"', 'must be true or false');
  const defaults = { ...DEFAULTS };
  if (t.defaults !== undefined) {
    if (!t.defaults || typeof t.defaults !== 'object' || Array.isArray(t.defaults)) throw bad('"defaults"', 'must be an object');
    for (const [k, v] of Object.entries(t.defaults)) {
      if (!Object.hasOwn(DEFAULTS, k)) throw bad(`"defaults.${k}"`, `not a default (${Object.keys(DEFAULTS).join(', ')})`);
      checkTiming(`"defaults.${k}"`, k, v, bad);
      defaults[k] = v;
    }
  }
  if (!Array.isArray(t.steps) || !t.steps.length) throw bad('"steps"', 'must be a list of at least one step');
  if (t.steps.length > MAX_STEPS) throw bad('"steps"', `at most ${MAX_STEPS} steps`);
  const steps = t.steps.map((s, i) => parseStep(s, `step ${i + 1}`, defaults, bad, t.cadtour));
  const ids = new Set();
  steps.forEach((s, i) => {
    if (!s.id) return;
    if (ids.has(s.id)) throw bad(`step ${i + 1} "id"`, `"${s.id}" is used by an earlier step`);
    ids.add(s.id);
  });
  return { version: t.cadtour, title: t.title || '', model: model || null, orient, unit, mode, loop: !!t.loop, defaults, steps };
}

// the numeric step fields' ranges: the parser's, the tour maker's and its inputs' min / max (one table)
export const RANGES = { transition: [0, 30], hold: [0, 600], orbit: [-3600, 3600] };
function checkTiming(where, k, v, bad) {
  if (k === 'transition' && !isNum(v, ...RANGES.transition)) throw bad(where, `must be seconds, ${RANGES.transition.join(' to ')}`);
  if (k === 'hold' && !isNum(v, ...RANGES.hold)) throw bad(where, `must be seconds, ${RANGES.hold.join(' to ')}`);
  if (k === 'ease' && !EASES.includes(v)) throw bad(where, `must be one of ${EASES.join(', ')}`);
  if (k === 'dim' && !DIMS.includes(v)) throw bad(where, `must be one of ${DIMS.join(', ')}`);
}

function parseStep(s, where, defaults, bad, version) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad(where, 'must be an object');
  const fields = version >= 2 ? ['id', ...STEP_FIELDS] : STEP_FIELDS;
  for (const k of Object.keys(s)) if (!fields.includes(k)) throw bad(`${where} "${k}"`, `not a step field (${fields.join(', ')})`);
  const at = (k) => `${where} "${k}"`;
  const out = { title: '', text: '' };
  if (s.id !== undefined) {
    if (typeof s.id !== 'string' || !STEP_ID.test(s.id)) throw bad(at('id'), 'must be a-z, 0-9 and "-", starting with a letter or digit, at most 64');
    out.id = s.id;
  }
  if (s.title !== undefined) { if (!isText(s.title, TITLE_MAX)) throw bad(at('title'), `must be text of at most ${TITLE_MAX} characters`); out.title = s.title; }
  if (s.text !== undefined) { if (!isText(s.text, TEXT_MAX)) throw bad(at('text'), `must be text of at most ${TEXT_MAX} characters`); out.text = s.text; }
  if (s.view !== undefined) {
    if (typeof s.view === 'string') {
      if (!PRESETS.includes(s.view)) throw bad(at('view'), `must be one of ${PRESETS.join(', ')}, or a view object`);
      out.view = s.view;
    } else {
      const c = s.view && s.view.cam;
      if (!c || !isVec(c.target, 3) || !isNum(c.dist, 1e-9, 1e12) || !isVec(c.q, 4) || Math.hypot(...c.q) < 1e-6
        || (c.ortho !== undefined && typeof c.ortho !== 'boolean')) {
        throw bad(at('view'), 'a view object needs cam: { target: [x, y, z], dist: > 0, q: [x, y, z, w], ortho?: true|false }');
      }
      const n = Math.hypot(...c.q);
      out.view = { cam: { target: c.target.slice(), dist: c.dist, q: c.q.map((v) => v / n), ...(c.ortho !== undefined ? { ortho: c.ortho } : {}) } };
    }
  }
  if (s.frame !== undefined) {
    // "all", part names, or a box in the model's millimetres (a part the
    // file gives no name of its own: a chip under a heatsink)
    const f = s.frame;
    if (f && typeof f === 'object' && !Array.isArray(f)) {
      if (!isVec(f.min, 3) || !isVec(f.max, 3) || f.min.some((v, k) => v > f.max[k])) throw bad(at('frame'), 'a box needs "min": [x, y, z] and "max": [x, y, z], min ≤ max');
      out.frame = { min: f.min.slice(), max: f.max.slice() };
    } else if (f !== 'all' && !isNames(f)) throw bad(at('frame'), `"all", a list of part names (${NAMES_RULE}), or { "min": [x, y, z], "max": [x, y, z] }`);
    else out.frame = f === 'all' ? 'all' : f.map((x) => x.trim());
  }
  if (s.from !== undefined) {
    // a preset, or the camera's orientation itself (a quaternion: the
    // recorder's "frame the selection from here")
    // "outside": from the side of the model the framed parts lie on (a port
    // seen from the board edge it faces), raised 30° above the horizon
    if (isVec(s.from, 4) && Math.hypot(...s.from) > 1e-6) { const n = Math.hypot(...s.from); out.from = s.from.map((v) => v / n); }
    else if (PRESETS.includes(s.from) || s.from === 'outside') out.from = s.from;
    else throw bad(at('from'), `must be one of ${PRESETS.join(', ')}, "outside", or a camera orientation [x, y, z, w]`);
  }
  if (s.margin !== undefined) { if (!isNum(s.margin, 1, 10)) throw bad(at('margin'), 'must be 1 to 10 (1: the parts fill the view)'); out.margin = s.margin; }
  // the projection (a framed step's: a view object's camera says its own); left out, the
  // visitor's as the tour began
  if (s.ortho !== undefined) { if (typeof s.ortho !== 'boolean') throw bad(at('ortho'), 'must be true or false'); out.ortho = s.ortho; }
  if (s.colour !== undefined) {
    const c = s.colour;
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length > PART_NAMES_MAX
      || !Object.entries(c).every(([k, v]) => isPartName(k) && isColour(v))) {
      throw bad(at('colour'), `must be { "<part name>": "#rrggbb", … } (${NAMES_RULE})`);
    }
    out.colour = Object.fromEntries(Object.entries(c).map(([k, v]) => [k.trim(), v.toLowerCase()]));
  }
  // ("show": "all" -- every part shown, whatever the page had hidden: what the tour maker writes
  // for a step taken with nothing hidden; a missing field keeps the page's)
  for (const k of ['show', 'hide', 'isolate']) {
    if (s[k] === undefined) continue;
    if (k === 'show' && s[k] === 'all') { out.show = 'all'; continue; }
    if (!isNames(s[k])) throw bad(at(k), k === 'show' ? `"all", or a list of part names (${NAMES_RULE})` : `must be a list of ${NAMES_RULE}`);
    out[k] = s[k].map((x) => x.trim());
  }
  if (s.explode !== undefined) { if (!isNum(s.explode, 0, 1)) throw bad(at('explode'), 'must be 0 to 1'); out.explode = s.explode; }
  // which way it explodes (a view link keeps it too); without it, the way the viewer is set
  if (s.explodeAlong !== undefined) {
    if (!EXPLODE_MODES.includes(s.explodeAlong)) throw bad(at('explodeAlong'), `must be one of ${EXPLODE_MODES.join(', ')}`);
    out.explodeAlong = s.explodeAlong;
  }
  if (s.section !== undefined) {
    const x = s.section;
    if (x === 'off') out.section = { axis: 'off' };
    else if (!x || typeof x !== 'object' || !['x', 'y', 'z'].includes(x.axis) || !isNum(x.t ?? 0.5, 0, 1) || (x.flip !== undefined && typeof x.flip !== 'boolean')) {
      throw bad(at('section'), '"off" or { axis: "x"|"y"|"z", t?: 0 to 1, flip?: true|false }');
    } else out.section = { axis: x.axis, t: x.t ?? 0.5, flip: !!x.flip };
  }
  if (s.style !== undefined) { if (!STYLE_IDS.includes(s.style)) throw bad(at('style'), `must be one of ${STYLE_IDS.join(', ')}`); out.style = s.style; }
  if (s.callouts !== undefined) {
    // (placed by the notes' one rule, js/view-link.js notePlace: its part when it names one,
    // else its point -- as a model list's notes are)
    const ok = (c) => c && typeof c === 'object' && isText(c.text, NOTE_TEXT_MAX) && c.text.trim() && notePlace(c);
    if (!Array.isArray(s.callouts) || s.callouts.length > NOTES_MAX || !s.callouts.every(ok)) {
      throw bad(at('callouts'), `must be a list (at most ${NOTES_MAX}) of { "text": "…" (${NOTE_TEXT_MAX} characters at most), and "part": "<name>" or "at": [x, y, z] }`);
    }
    out.callouts = s.callouts.map((c) => ({ text: c.text.trim(), ...notePlace(c) }));
  }
  for (const k of ['transition', 'hold', 'ease', 'dim']) {
    if (s[k] === undefined) { out[k] = defaults[k]; continue; }
    checkTiming(at(k), k, s[k], bad);
    out[k] = s[k];
  }
  if (s.orbit !== undefined) { if (!isNum(s.orbit, ...RANGES.orbit)) throw bad(at('orbit'), `must be degrees, ${RANGES.orbit.join(' to ')}`); out.orbit = s.orbit; }
  // a step with no camera of its own frames the whole model from where the
  // camera is (a caption-only step)
  return out;
}

// The names a tour may use for a model's parts, each to the body ids
// (1-based) it covers: every tree node's name (its bodies), every body's
// name, and every label a model list gives one of those names ("HDMI" for
// "HDMI_1_3"). header: the model's .cadmesh header; labels: { name: label }.
// -> { get(name) -> Set of ids | undefined, bodies }: a name keeps the tree nodes and bodies it
// names, and its ids are gathered when it is first asked for (and kept). Gathering every name's
// ids up front cost depth x bodies -- a 256-deep tree of many bodies, 10 s and 3 GB as a tour
// opened -- where a tour asks for a handful.
// labelled: the bodies (1..labelled) a model list's labels describe -- in a scene, the first model's;
// an added model's part of the same name is not labelled (the tree's rule: main.js ofFirstModel)
export function partIndex(header, labels = null, labelled = Infinity) {
  const refs = new Map(); // key -> [a tree node, or { id }]
  const put = (name, ref) => {
    if (typeof name !== 'string') return;
    const k = name.trim().toLowerCase();
    if (!k) return;
    if (!refs.has(k)) refs.set(k, []);
    refs.get(k).push(ref);
  };
  const stack = [header.root];
  while (stack.length) {
    const n = stack.pop();
    put(n.name, n);
    for (const c of n.children || []) stack.push(c);
  }
  header.meshes.forEach((m, i) => put(m.name, { id: i + 1 }));
  const gathered = new Map();
  const gather = (n, out) => {
    const st = [n];
    while (st.length) {
      const x = st.pop();
      for (const i of x.meshes || []) out.add(i + 1);
      for (const c of x.children || []) st.push(c);
    }
  };
  if (labels) {
    // (whether a node's bodies all lie in the labelled ones, worked out once per node: a list's
    // labels differing only in case each walked the same assembly again -- 1000 over 100,000
    // bodies, 8.4 s on the page's thread)
    const nodeCovered = new Map();
    const covered = (r) => {
      if (r.id) return r.id <= labelled;
      if (labelled === Infinity) return true;
      if (!nodeCovered.has(r)) {
        const ids = new Set();
        gather(r, ids);
        let ok = true;
        for (const id of ids) if (id > labelled) { ok = false; break; }
        nodeCovered.set(r, ok);
      }
      return nodeCovered.get(r);
    };
    for (const [name, label] of Object.entries(labels)) {
      for (const r of refs.get(name.trim().toLowerCase()) || []) if (covered(r)) put(label, r);
    }
  }
  return {
    bodies: header.meshes.length,
    get(k) {
      if (!refs.has(k)) return undefined;
      if (!gathered.has(k)) {
        const ids = new Set();
        for (const r of refs.get(k)) if (r.id) ids.add(r.id); else gather(r, ids);
        gathered.set(k, ids);
      }
      return gathered.get(k);
    },
  };
}

// Per body (1-based ids, index id-1), the names it is known by, outermost
// first: each named tree node above it, then its own name
export function nameChains(header) {
  const out = header.meshes.map(() => []);
  const walk = (n, owners) => {
    const own = n.name ? [...owners, n.name] : owners;
    for (const i of n.meshes || []) out[i] = [...own, header.meshes[i].name || ''].filter(Boolean);
    for (const c of n.children || []) walk(c, own);
  };
  walk(header.root, []);
  header.meshes.forEach((m, i) => { if (!out[i].length && m.name) out[i] = [m.name]; });
  return out;
}

// The fewest names that cover exactly these bodies (the recorder writing a
// step's colours, hidden or framed parts): for each body still uncovered, the
// outermost of its names whose parts all lie in the set (an assembly's name
// rather than its bodies'), else a name of its own that is its alone, else
// "#<id>". A label a model list gives a chosen name is used in its place
// ("HDMI" for "HDMI_1_3"), so a tour reads as the site names the parts.
export function namesFor(ids, header, idx, labels = null) {
  const want = new Set(ids);
  const chains = nameChains(header);
  const covered = new Set();
  const names = [];
  const byLabel = labels ? Object.fromEntries(Object.entries(labels).map(([k, v]) => [k.trim().toLowerCase(), v])) : {};
  // whether a name's bodies all lie in the wanted set, worked out once per name (asked per body,
  // a name over half a flat assembly was walked again for every wanted body: 40k bodies, 4.9 s)
  const within = new Map();
  const allWanted = (key) => {
    if (!within.has(key)) {
      const hit = idx.get(key);
      let ok = !!hit && hit.size <= want.size;
      if (ok) for (const x of hit) if (!want.has(x)) { ok = false; break; }
      within.set(key, ok);
    }
    return within.get(key);
  };
  for (const id of [...want].sort((a, b) => a - b)) {
    if (covered.has(id)) continue;
    // a name of this body's (its node, its own, an assembly's), by its label when the label names
    // only wanted bodies and this one (a label covers the first model's bodies only: in a scene the
    // label of a name shared with an added model is the narrower name, and the body was "#1"),
    // else by the name itself when it names only wanted bodies
    let pick = null;
    for (const name of chains[id - 1] || []) {
      const key = name.trim().toLowerCase();
      const lab = Object.hasOwn(byLabel, key) && byLabel[key];
      const lk = lab && lab.trim().toLowerCase();
      if (lk && allWanted(lk) && idx.get(lk).has(id)) { pick = lab; break; }
      if (allWanted(key)) { pick = name; break; }
    }
    if (pick) {
      for (const x of idx.get(pick.trim().toLowerCase())) covered.add(x);
      names.push(pick);
    } else {
      covered.add(id);
      names.push(`#${id}`);
    }
  }
  return names;
}

// Part names -> { ids: [body ids], missing: [names that matched nothing] }.
// A name matches a label, a node or a body name, case-insensitively; a tree
// path ("A › B") matches its last piece; "#12" is body 12 itself (what the
// recorder writes for a body whose name is shared: exact for this file, but
// not across a re-export).
export function resolveParts(names, idx) {
  const ids = new Set();
  const missing = [];
  for (const raw of names) {
    const num = /^#(\d+)$/.exec(raw.trim());
    if (num) {
      const id = Number(num[1]);
      if (id >= 1 && (!idx.bodies || id <= idx.bodies)) ids.add(id); else missing.push(raw);
      continue;
    }
    const name = raw.split('›').pop().trim().toLowerCase();
    const hit = idx.get(name);
    if (!hit) { missing.push(raw); continue; }
    for (const id of hit) ids.add(id);
  }
  return { ids: [...ids].sort((a, b) => a - b), missing };
}

// Every part name a tour uses, for the validator and the player's report
export function tourNames(tour) {
  const names = new Set();
  for (const s of tour.steps) {
    if (Array.isArray(s.frame)) s.frame.forEach((n) => names.add(n));
    for (const k of ['show', 'hide', 'isolate']) if (Array.isArray(s[k])) s[k].forEach((n) => names.add(n));
    Object.keys(s.colour || {}).forEach((n) => names.add(n));
    (s.callouts || []).forEach((c) => c.part && names.add(c.part));
  }
  return [...names];
}
