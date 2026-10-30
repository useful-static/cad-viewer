// Tours: a .cadtour.json read and checked, and its part names
// matched to a model's bodies. Pure (no DOM), so tests/test-tour.mjs checks it
// in Node.
//
// A tour is { cadtour: 1, title?, model?, mode?, loop?, defaults?, steps: [...] }.
// Every value is checked and a wrong one refuses the whole file, naming the
// step and the field: a typo in a field name is refused too, since a tour that
// silently ignored "colour" spelled "color" would play wrong without a word.

export const PRESETS = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'];
export const EASES = ['linear', 'inOut'];
export const DIMS = ['none', 'ghost', 'grey', 'hide'];
export const STYLE_IDS = ['shaded', 'edges', 'hidden', 'hiddengrey', 'wire', 'xray'];
export const MAX_STEPS = 200;
export const DEFAULTS = { transition: 1.2, hold: 4, ease: 'inOut', dim: 'none' };

const STEP_FIELDS = ['title', 'text', 'view', 'frame', 'from', 'margin', 'colour', 'dim', 'show', 'hide', 'isolate',
  'explode', 'section', 'style', 'callouts', 'transition', 'ease', 'hold', 'orbit'];
const TOP_FIELDS = ['cadtour', 'title', 'model', 'mode', 'loop', 'defaults', 'steps'];

const isText = (v, max) => typeof v === 'string' && v.length <= max;
const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const isColour = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const isNames = (v) => Array.isArray(v) && v.length <= 500 && v.every((s) => typeof s === 'string' && s.trim() && s.length <= 300);

// text -> the tour, every default filled in; throws an Error naming what is wrong.
// base: the URL the tour was read from (its model URL is resolved against it).
export function parseTour(text, base = undefined) {
  let t;
  try { t = JSON.parse(text); } catch (e) { throw new Error(`not JSON: ${e.message}`); }
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('a tour is a JSON object');
  const bad = (where, why) => new Error(`${where}: ${why}`);
  for (const k of Object.keys(t)) if (!TOP_FIELDS.includes(k)) throw bad(`"${k}"`, `not a tour field (${TOP_FIELDS.join(', ')})`);
  if (t.cadtour !== 1) throw bad('"cadtour"', 'must be 1 (the format version)');
  if (t.title !== undefined && !isText(t.title, 200)) throw bad('"title"', 'must be text of at most 200 characters');
  let model;
  if (t.model !== undefined) {
    if (typeof t.model !== 'string' || !t.model.trim()) throw bad('"model"', 'must be a URL');
    try { model = new URL(t.model, base).href; } catch { throw bad('"model"', `"${t.model}" is not a URL`); }
    if (!/^https?:/.test(model)) throw bad('"model"', 'must be an http(s) URL');
  }
  const mode = t.mode === undefined ? 'static' : t.mode;
  if (!['static', 'animated'].includes(mode)) throw bad('"mode"', 'must be "static" or "animated"');
  if (t.loop !== undefined && typeof t.loop !== 'boolean') throw bad('"loop"', 'must be true or false');
  const defaults = { ...DEFAULTS };
  if (t.defaults !== undefined) {
    if (!t.defaults || typeof t.defaults !== 'object' || Array.isArray(t.defaults)) throw bad('"defaults"', 'must be an object');
    for (const [k, v] of Object.entries(t.defaults)) {
      if (!(k in DEFAULTS)) throw bad(`"defaults.${k}"`, `not a default (${Object.keys(DEFAULTS).join(', ')})`);
      checkTiming(`"defaults.${k}"`, k, v, bad);
      defaults[k] = v;
    }
  }
  if (!Array.isArray(t.steps) || !t.steps.length) throw bad('"steps"', 'must be a list of at least one step');
  if (t.steps.length > MAX_STEPS) throw bad('"steps"', `at most ${MAX_STEPS} steps`);
  const steps = t.steps.map((s, i) => parseStep(s, `step ${i + 1}`, defaults, bad));
  return { title: t.title || '', model: model || null, mode, loop: !!t.loop, defaults, steps };
}

function checkTiming(where, k, v, bad) {
  if (k === 'transition' && !isNum(v, 0, 30)) throw bad(where, 'must be seconds, 0 to 30');
  if (k === 'hold' && !isNum(v, 0, 600)) throw bad(where, 'must be seconds, 0 to 600');
  if (k === 'ease' && !EASES.includes(v)) throw bad(where, `must be one of ${EASES.join(', ')}`);
  if (k === 'dim' && !DIMS.includes(v)) throw bad(where, `must be one of ${DIMS.join(', ')}`);
}

function parseStep(s, where, defaults, bad) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad(where, 'must be an object');
  for (const k of Object.keys(s)) if (!STEP_FIELDS.includes(k)) throw bad(`${where} "${k}"`, `not a step field (${STEP_FIELDS.join(', ')})`);
  const at = (k) => `${where} "${k}"`;
  const out = { title: '', text: '' };
  if (s.title !== undefined) { if (!isText(s.title, 200)) throw bad(at('title'), 'must be text of at most 200 characters'); out.title = s.title; }
  if (s.text !== undefined) { if (!isText(s.text, 2000)) throw bad(at('text'), 'must be text of at most 2000 characters'); out.text = s.text; }
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
    } else if (f !== 'all' && !isNames(f)) throw bad(at('frame'), '"all", a list of part names, or { "min": [x, y, z], "max": [x, y, z] }');
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
  if (s.colour !== undefined) {
    const c = s.colour;
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length > 500
      || !Object.entries(c).every(([k, v]) => k.trim() && isColour(v))) {
      throw bad(at('colour'), 'must be { "<part name>": "#rrggbb", … }');
    }
    out.colour = Object.fromEntries(Object.entries(c).map(([k, v]) => [k.trim(), v.toLowerCase()]));
  }
  for (const k of ['show', 'hide', 'isolate']) {
    if (s[k] === undefined) continue;
    if (!isNames(s[k])) throw bad(at(k), 'must be a list of part names');
    out[k] = s[k].map((x) => x.trim());
  }
  if (s.explode !== undefined) { if (!isNum(s.explode, 0, 1)) throw bad(at('explode'), 'must be 0 to 1'); out.explode = s.explode; }
  if (s.section !== undefined) {
    const x = s.section;
    if (x === 'off') out.section = { axis: 'off' };
    else if (!x || typeof x !== 'object' || !['x', 'y', 'z'].includes(x.axis) || !isNum(x.t ?? 0.5, 0, 1) || (x.flip !== undefined && typeof x.flip !== 'boolean')) {
      throw bad(at('section'), '"off" or { axis: "x"|"y"|"z", t?: 0 to 1, flip?: true|false }');
    } else out.section = { axis: x.axis, t: x.t ?? 0.5, flip: !!x.flip };
  }
  if (s.style !== undefined) { if (!STYLE_IDS.includes(s.style)) throw bad(at('style'), `must be one of ${STYLE_IDS.join(', ')}`); out.style = s.style; }
  if (s.callouts !== undefined) {
    const ok = (c) => c && typeof c === 'object' && isText(c.text, 200) && c.text.trim()
      && ((typeof c.part === 'string' && c.part.trim()) || isVec(c.at, 3));
    if (!Array.isArray(s.callouts) || s.callouts.length > 50 || !s.callouts.every(ok)) {
      throw bad(at('callouts'), 'must be a list (at most 50) of { "text": "…", and "part": "<name>" or "at": [x, y, z] }');
    }
    out.callouts = s.callouts.map((c) => ({ text: c.text.trim(), ...(c.part ? { part: c.part.trim() } : { at: c.at.slice() }) }));
  }
  for (const k of ['transition', 'hold', 'ease', 'dim']) {
    if (s[k] === undefined) { out[k] = defaults[k]; continue; }
    checkTiming(at(k), k, s[k], bad);
    out[k] = s[k];
  }
  if (s.orbit !== undefined) { if (!isNum(s.orbit, -3600, 3600)) throw bad(at('orbit'), 'must be degrees, -3600 to 3600'); out.orbit = s.orbit; }
  // a step with no camera of its own frames the whole model from where the
  // camera is (a caption-only step)
  return out;
}

// The names a tour may use for a model's parts, each to the body ids
// (1-based) it covers: every tree node's name (its bodies), every body's
// name, and every label a model list gives one of those names ("HDMI" for
// "HDMI_1_3"). header: the model's .cadmesh header; labels: { name: label }.
export function partIndex(header, labels = null) {
  const idx = new Map();
  const add = (name, ids) => {
    if (!name) return;
    const k = name.trim().toLowerCase();
    if (!k) return;
    if (!idx.has(k)) idx.set(k, new Set());
    for (const id of ids) idx.get(k).add(id);
  };
  const walk = (n) => {
    const ids = [];
    for (const i of n.meshes || []) ids.push(i + 1);
    for (const c of n.children || []) ids.push(...walk(c));
    add(n.name, ids);
    return ids;
  };
  walk(header.root);
  header.meshes.forEach((m, i) => add(m.name, [i + 1]));
  if (labels) {
    for (const [name, label] of Object.entries(labels)) {
      const ids = idx.get(name.trim().toLowerCase());
      if (ids) add(label, ids);
    }
  }
  idx.bodies = header.meshes.length;
  return idx;
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
  for (const id of [...want].sort((a, b) => a - b)) {
    if (covered.has(id)) continue;
    let pick = null;
    for (const name of chains[id - 1] || []) {
      const hit = idx.get(name.trim().toLowerCase());
      if (hit && [...hit].every((x) => want.has(x))) { pick = name; break; }
    }
    if (pick) {
      for (const x of idx.get(pick.trim().toLowerCase())) covered.add(x);
      names.push(byLabel[pick.trim().toLowerCase()] || pick);
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
    for (const k of ['show', 'hide', 'isolate']) (s[k] || []).forEach((n) => names.add(n));
    Object.keys(s.colour || {}).forEach((n) => names.add(n));
    (s.callouts || []).forEach((c) => c.part && names.add(c.part));
  }
  return [...names];
}
