// A view as a URL hash, so a link opens the same model at the same view:
//
//   #view=c:tx,ty,tz,dist,qx,qy,qz,qw;p:o;u:z;s:hiddengrey;x:z,0.5,f;h:1-3,7;k:5
//
//   c  camera: target (to a millionth of the distance), distance and
//      orientation quaternion (6 significant digits)
//   p  projection: o ortho (absent: perspective)
//   w  the view's shape (width / height) when the link was made: opened on
//      another shape, the view is reframed
//   u  orientation (js/orient.js), canonical up then front: +z+x; z is
//      +z-y (Z up, the older links' only value); absent: the file's own +y+z
//   s  display style id (js/styles.js; absent: the viewer's own default)
//   x  section: axis, position 0..1, f when flipped (absent: off)
//   e  Explode: how far 0..1, and how (assembly | x | y | z) (absent: off)
//   h  hidden bodies, k selected bodies: ids as runs ("1-3,7")
//   m  the model's body names, fingerprinted (8 hex): ids mean the bodies
//      they meant only while it matches
//   a  notes pinned to points (at most MAX_NOTES): x,y,z (to the micrometre,
//      roundNotePoint), text as base64url, "~" between them
//   n  the selected bodies by name (at most MAX_NAMED), each its key
//      (bodyKeys) as base64url: a link made before the model's file was
//      regenerated or revised, whose ids now name other bodies, still selects
//      the part it pointed at (feature review 2026-10-29)
//
// Every number is read by linkNumber: an empty value is none, never 0.
//
// Pure, no DOM. Unknown or malformed fields are dropped, never thrown: a link
// edited by hand still opens the model.

import { DEFAULT_ORIENT, Z_UP_ORIENT, orientOrNull } from './orient.js';
import { STYLE_IDS } from './styles.js';

const num = (v) => Number(v.toPrecision(6));
// A section's position and an explode's amount (0..1) as a link or a tour keeps them: 6 significant
// figures (a tour kept 4 and 3 decimals: a cut typed at 584.441 mm came back 0.033 mm off)
export const roundFraction = num;
// A note's point as a link or a tour keeps it: to the micrometre (mm, 3 decimals), whatever its
// size -- six significant figures moved a note at 123456.789 by 0.2 mm, while the tour kept it
// exact. The one rule for both (js/main.js tour steps)
export const roundNotePoint = (p) => p.map((v) => Math.round(v * 1000) / 1000);
// A number in a link: an empty or blank value is none (Number('') is 0: a target, a section, an
// explode or a note at 0)
const linkNumber = (s) => (s === undefined || s.trim() === '' ? NaN : Number(s));
// The target to a step a millionth of the distance: its error must be small
// beside what the view spans, not beside its own size (6 significant digits
// of 100000 mm is 1 mm, 5% of a 20 mm wide view there)
const near = (v, dist) => {
  if (!(dist > 0) || !Number.isFinite(v)) return num(v);
  const d = Math.min(12, Math.max(0, -Math.floor(Math.log10(dist * 1e-6))));
  return Number(v.toFixed(d));
};
// A camera as a link or a tour keeps it: the target to a millionth of the distance, the distance
// and the turn to 6 significant figures (a tour kept 4 decimals of the target and 6 of the turn:
// a view far from the origin came back moved). The one rule for both (js/main.js tour steps)
export const roundCamera = (c) => ({ target: c.target.map((t) => near(t, c.dist)), dist: num(c.dist), q: c.q.map(num) });

export function runs(ids) {
  const s = [...new Set(ids)].filter((i) => Number.isInteger(i) && i > 0).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j + 1;
  }
  return out.join(',');
}

// the most body ids a view link's hidden and selected parts name between them
export const MAX_LINK_IDS = 1e6;
// "1-3,7" -> [1, 2, 3, 7]; at most `max` ids (a hand-edited 1-1e9 cannot hang the page)
export function parseRuns(s, max = MAX_LINK_IDS) {
  const out = [];
  for (const part of String(s).split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = a; i <= b && out.length < max; i++) if (i > 0) out.push(i);
  }
  return out;
}

export const MAX_NAMED = 32;
// A note's text, at most this long, wherever it is written (a model list's notes, a tour's
// callouts, a view link, Measure > Note)
export const NOTE_TEXT_MAX = 200;
// a text cut to at most max UTF-16 units, never through a surrogate pair (a 200-unit note ending in
// an emoji kept half of it, which the next share wrote as U+FFFD)
export function cutText(s, max) {
  if (s.length <= max) return s;
  const k = (s.charCodeAt(max - 1) & 0xfc00) === 0xd800 ? max - 1 : max;
  return s.slice(0, k);
}
// A note's place, one rule for lists and tours: its part when it names one (text with more than
// spaces), else its point [x, y, z]; null for neither
export function notePlace(x) {
  if (typeof x.part === 'string' && x.part.trim()) return { part: x.part.trim() };
  if (Array.isArray(x.at) && x.at.length === 3 && x.at.every(Number.isFinite)) return { at: x.at.slice() };
  return null;
}

// how Explode pulls the parts apart: by assembly, or along one model axis (a view link's
// "e:" and a tour step's "explodeAlong" name one of these)
export const EXPLODE_MODES = ['assembly', 'x', 'y', 'z'];
export const MAX_NOTES = 20;
// the most notes a model list, a tour step or Measure holds (a view link carries the first
// MAX_NOTES of them: a URL is short)
export const NOTES_MAX = 100;

// A body's key: its label, numbered from its second repeat ("A › SOLID #2"),
// so every body of a model has its own
export function bodyKeys(labels) {
  const seen = new Map();
  return labels.map((l) => {
    const k = (seen.get(l) || 0) + 1;
    seen.set(l, k);
    return k === 1 ? l : `${l} #${k}`;
  });
}

// FNV-1a over the keys in body order, 8 hex digits
export function modelPrint(keys) {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(keys.join('\n'));
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// base64url of UTF-8: no ',' ';' ':' '%', so it survives the page decoding
// the whole hash once
const b64u = (s) => {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

// The bodies a decoded view names, for this model: its ids while the model's
// fingerprint matches the link's (or the link has none: an older link), else
// the selection found by name, and no hidden bodies (they cannot be told
// apart by id any more). -> { hidden, selected, changed }
export function resolveBodies(v, keys) {
  const n = keys.length;
  const ok = (a) => (a || []).filter((i) => i >= 1 && i <= n);
  if (!v.model || v.model === modelPrint(keys)) return { hidden: ok(v.hidden), selected: ok(v.selected), changed: false };
  const at = new Map(keys.map((k, i) => [k, i + 1]));
  const selected = (v.selNames || []).map((k) => at.get(k)).filter(Boolean);
  return { hidden: [], selected, changed: true };
}

export function encodeView(v) {
  const f = [];
  const c = v.cam;
  const rc = roundCamera(c);
  f.push(`c:${[...rc.target, rc.dist, ...rc.q].join(',')}`);
  if (c.ortho) f.push('p:o');
  // the view's shape (width / height) when the link was made: opened on
  // another shape (a desktop link on a phone), the view is reframed
  if (v.aspect > 0) f.push(`w:${+v.aspect.toFixed(3)}`);
  const o = c.orient || DEFAULT_ORIENT;
  if (o !== DEFAULT_ORIENT) f.push(`u:${o === Z_UP_ORIENT ? 'z' : o}`);
  if (v.style) f.push(`s:${v.style}`);
  if (v.section && v.section.axis !== 'off') f.push(`x:${v.section.axis},${num(v.section.t)}${v.section.flip ? ',f' : ''}`);
  if (v.explode && EXPLODE_MODES.includes(v.explode.mode)) f.push(`e:${num(v.explode.t)},${v.explode.mode}`);
  if (v.hidden && v.hidden.length) f.push(`h:${runs(v.hidden)}`);
  if (v.selected && v.selected.length) f.push(`k:${runs(v.selected)}`);
  // notes pinned to points (Measure's Note): x,y,z,text(base64url), "~" between
  if (v.notes && v.notes.length) {
    f.push(`a:${v.notes.slice(0, MAX_NOTES).map((n) => [...roundNotePoint(n.p), b64u(n.text)].join(',')).join('~')}`);
  }
  // v.keys: the model's body keys (bodyKeys), when the caller has them
  if (v.keys && v.keys.length) {
    f.push(`m:${modelPrint(v.keys)}`);
    const sel = [...new Set(v.selected || [])].filter((i) => i >= 1 && i <= v.keys.length).sort((a, b) => a - b);
    if (sel.length && sel.length <= MAX_NAMED) f.push(`n:${sel.map((i) => b64u(v.keys[i - 1])).join(',')}`);
  }
  return f.join(';');
}

// -> { cam?: { target, dist, q, ortho, orient }, style?, section?, hidden?, selected?, model?, selNames? }
export function decodeView(s) {
  const out = {};
  let ids = MAX_LINK_IDS;
  for (const field of String(s || '').split(';')) {
    const i = field.indexOf(':');
    if (i < 1) continue;
    const k = field.slice(0, i);
    const val = field.slice(i + 1);
    if (k === 'c') {
      const n = val.split(',').map(linkNumber);
      const qlen = Math.hypot(n[4], n[5], n[6], n[7]);
      if (n.length === 8 && n.every(Number.isFinite) && n[3] > 0 && qlen > 0) {
        out.cam = { target: n.slice(0, 3), dist: n[3], q: n.slice(4).map((x) => x / qlen) };
      }
    } else if (k === 'p') out.ortho = val === 'o';
    else if (k === 'w') { const a = linkNumber(val); if (a > 0.05 && a < 20) out.aspect = a; }
    else if (k === 'u') out.orient = val === 'z' ? Z_UP_ORIENT : val === 'y' ? DEFAULT_ORIENT : orientOrNull(val);
    else if (k === 's' && STYLE_IDS.includes(val)) out.style = val;
    else if (k === 'x') {
      const [axis, t, f] = val.split(',');
      const tn = linkNumber(t);
      if (['x', 'y', 'z'].includes(axis) && tn >= 0 && tn <= 1) out.section = { axis, t: tn, flip: f === 'f' };
    } else if (k === 'e') {
      const [t, mode] = val.split(',');
      const tn = linkNumber(t);
      if (tn >= 0 && tn <= 1 && EXPLODE_MODES.includes(mode)) out.explode = { t: tn, mode };
    // (the first "h:" and "k:" only, and one id budget for both: a link repeating "h:1-999999"
    // was a million ids a field -- 11 KB of link, 14 s)
    } else if (k === 'h' && !out.hidden) { out.hidden = parseRuns(val, ids); ids -= out.hidden.length; }
    else if (k === 'k' && !out.selected) { out.selected = parseRuns(val, ids); ids -= out.selected.length; }
    else if (k === 'm' && /^[0-9a-f]{8}$/.test(val)) out.model = val;
    else if (k === 'a') {
      out.notes = val.split('~').slice(0, MAX_NOTES).flatMap((s) => {
        const q = s.split(',');
        const p = q.slice(0, 3).map(linkNumber);
        if (q.length !== 4 || !p.every(Number.isFinite) || !/^[A-Za-z0-9_-]+$/.test(q[3])) return [];
        try { return [{ p, text: cutText(unb64u(q[3]), NOTE_TEXT_MAX) }]; } catch { return []; }
      });
    }
    else if (k === 'n') {
      out.selNames = val.split(',').slice(0, MAX_NAMED).flatMap((s) => {
        try { return /^[A-Za-z0-9_-]+$/.test(s) ? [unb64u(s)] : []; } catch { return []; }
      });
    }
  }
  if (out.cam) {
    out.cam.ortho = !!out.ortho;
    out.cam.orient = out.orient || DEFAULT_ORIENT;
  }
  delete out.ortho;
  delete out.orient;
  return out;
}
