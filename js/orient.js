// Which of the FILE's axes points where on screen, whatever frame the file was
// drawn in: "up:+z,front:-y" says the model's +z is up and its -y faces the
// viewer in the Front view (so its +x is to the right). Any two of up, front
// and right name it (the third follows); each is one of +x -x +y -y +z -z, and
// the two must be perpendicular. The view presets (Front, Top, Iso, ...) are
// then taken in that frame, and a load fits the model to the view, so the
// same orientation shows two files the same way wherever their origins are.
//
// Written canonically as up and front: "+z-y". The default, "+y+z", is the
// file's own frame (y up, +z toward the viewer); "+z-y" is the Z up toggle.
// Pure, for tests/test-orient.mjs.

import { qFromBasis } from './camera.js';

export const DEFAULT_ORIENT = '+y+z';
export const Z_UP_ORIENT = '+z-y';

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const ROLES = ['up', 'front', 'right'];
const AXIS_RE = /^([+-])([xyz])$/;

const vec = (a) => {
  const m = AXIS_RE.exec(a);
  return AXES[m[2]].map((v) => (m[1] === '-' ? -v : v));
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const name = (v) => {
  const k = v.findIndex((c) => c !== 0);
  return (v[k] < 0 ? '-' : '+') + 'xyz'[k];
};

// "up:+z,front:-y" (any two roles, any order, "right" allowed; spaces and
// ";" tolerated) -> the canonical "+z-y". Throws a plain-words error.
export function parseOrient(s) {
  if (typeof s !== 'string' || !s.trim()) throw new Error('an orientation names two of up, front and right, e.g. "up:+z,front:-y"');
  const t = s.trim();
  // already canonical ("+z-y"): up then front
  const canon = /^([+-][xyz])([+-][xyz])$/.exec(t);
  const got = {};
  if (canon) { got.up = canon[1]; got.front = canon[2]; }
  else {
    for (const part of t.split(/[,;]/).map((p) => p.trim()).filter(Boolean)) {
      const m = /^(up|front|right)\s*[:=]\s*([+-]?)\s*([xyz])$/i.exec(part);
      if (!m) throw new Error(`"${part}" is not role:axis (up, front or right, then +x -x +y -y +z or -z)`);
      const role = m[1].toLowerCase();
      if (got[role]) throw new Error(`${role} is named twice`);
      got[role] = (m[2] || '+') + m[3].toLowerCase();
    }
  }
  const named = ROLES.filter((r) => got[r]);
  if (named.length !== 2) throw new Error(`name exactly two of up, front and right (got ${named.length ? named.join(', ') : 'none'})`);
  const [a, b] = named.map((r) => vec(got[r]));
  if (a.some((v, k) => v !== 0 && b[k] !== 0)) throw new Error(`${named[0]} and ${named[1]} must be different axes`);
  // right = up x front, up = front x right, front = right x up
  let up = got.up && vec(got.up), front = got.front && vec(got.front);
  if (!up) up = cross(front, vec(got.right));
  if (!front) front = cross(vec(got.right), up);
  return name(up) + name(front);
}

// Like parseOrient, null for a missing or bad one (a URL's or a list's value
// is never an error that stops a model opening)
export function orientOrNull(s) {
  try { return s == null ? null : parseOrient(s); } catch { return null; }
}

// canonical -> { up, front, right } as axis names, for display
export function orientRoles(o) {
  const up = vec(o.slice(0, 2)), front = vec(o.slice(2));
  return { up: name(up), front: name(front), right: name(cross(up, front)) };
}

// The Iso preset, in the viewer's frame: [yaw, pitch]. On a tall view (a
// portrait phone, aspect under PORTRAIT) a model whose footprint is clearly
// longer one way (by LONG) is looked at along that length, from its left end
// (or its front, when it runs front to back), 57° down, so its long side runs
// up the screen: a board then covers 0.59 of a 390 x 700 view, against 0.285
// in the usual iso, which a phone fits by its width (measured with
// js/camera.js fitBox). Every model long the same way turns the same way, so
// a list's boards still open alike.
export const ISO = [0.7, 0.45];
export const PORTRAIT = 0.8;
export const LONG = 1.2;
export function isoView(o, bbox, aspect) {
  if (!bbox || !(aspect < PORTRAIT)) return ISO;
  const { right, front } = orientRoles(o);
  const ext = (n) => { const k = 'xyz'.indexOf(n[1]); return bbox.max[k] - bbox.min[k]; };
  const r = ext(right), f = ext(front);
  if (r > LONG * f) return [-Math.PI / 2, 1.0];
  if (f > LONG * r) return [0, 1.0];
  return ISO;
}

// The model-frame vector the orientation puts up on screen (the lighting's sky)
export const orientUp = (o) => vec(o.slice(0, 2));

// The rotation from the viewer's own frame (right +x, up +y, toward the
// viewer +z: the presets' frame) to the file's: its columns are the file's
// right, up and front. A preset's camera quaternion is orientQuat(o) times
// the preset's quaternion in the viewer's frame.
export function orientQuat(o) {
  const up = vec(o.slice(0, 2)), front = vec(o.slice(2));
  return qFromBasis(cross(up, front), up, front);
}
