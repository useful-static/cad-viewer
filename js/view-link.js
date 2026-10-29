// A view as a URL hash, so a link opens the same model at the same view:
//
//   #view=c:tx,ty,tz,dist,qx,qy,qz,qw;p:o;u:z;s:hiddengrey;x:z,0.5,f;h:1-3,7;k:5
//
//   c  camera: target (to a millionth of the distance), distance and
//      orientation quaternion (6 significant digits)
//   p  projection: o ortho (absent: perspective)
//   u  orientation (js/orient.js), canonical up then front: +z+x; z is
//      +z-y (Z up, the older links' only value); absent: the file's own +y+z
//   s  display style id (js/styles.js; absent: the viewer's own default)
//   x  section: axis, position 0..1, f when flipped (absent: off)
//   h  hidden bodies, k selected bodies: ids as runs ("1-3,7")
//
// Pure, no DOM. Unknown or malformed fields are dropped, never thrown: a link
// edited by hand still opens the model.

import { DEFAULT_ORIENT, Z_UP_ORIENT, orientOrNull } from './orient.js';

const num = (v) => Number(v.toPrecision(6));
// The target to a step a millionth of the distance: its error must be small
// beside what the view spans, not beside its own size (6 significant digits
// of 100000 mm is 1 mm, 5% of a 20 mm wide view there)
const near = (v, dist) => {
  if (!(dist > 0) || !Number.isFinite(v)) return num(v);
  const d = Math.min(12, Math.max(0, -Math.floor(Math.log10(dist * 1e-6))));
  return Number(v.toFixed(d));
};

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

// "1-3,7" -> [1, 2, 3, 7]; at most `max` ids (a hand-edited 1-1e9 cannot hang the page)
export function parseRuns(s, max = 1e6) {
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

export function encodeView(v) {
  const f = [];
  const c = v.cam;
  f.push(`c:${[...c.target.map((t) => near(t, c.dist)), num(c.dist), ...c.q.map(num)].join(',')}`);
  if (c.ortho) f.push('p:o');
  const o = c.orient || DEFAULT_ORIENT;
  if (o !== DEFAULT_ORIENT) f.push(`u:${o === Z_UP_ORIENT ? 'z' : o}`);
  if (v.style) f.push(`s:${v.style}`);
  if (v.section && v.section.axis !== 'off') f.push(`x:${v.section.axis},${num(v.section.t)}${v.section.flip ? ',f' : ''}`);
  if (v.hidden && v.hidden.length) f.push(`h:${runs(v.hidden)}`);
  if (v.selected && v.selected.length) f.push(`k:${runs(v.selected)}`);
  return f.join(';');
}

// -> { cam?: { target, dist, q, ortho, orient }, style?, section?, hidden?, selected? }
export function decodeView(s) {
  const out = {};
  for (const field of String(s || '').split(';')) {
    const i = field.indexOf(':');
    if (i < 1) continue;
    const k = field.slice(0, i);
    const val = field.slice(i + 1);
    if (k === 'c') {
      const n = val.split(',').map(Number);
      const qlen = Math.hypot(n[4], n[5], n[6], n[7]);
      if (n.length === 8 && n.every(Number.isFinite) && n[3] > 0 && qlen > 0) {
        out.cam = { target: n.slice(0, 3), dist: n[3], q: n.slice(4).map((x) => x / qlen) };
      }
    } else if (k === 'p') out.ortho = val === 'o';
    else if (k === 'u') out.orient = val === 'z' ? Z_UP_ORIENT : val === 'y' ? DEFAULT_ORIENT : orientOrNull(val);
    else if (k === 's' && /^[a-z]+$/.test(val)) out.style = val;
    else if (k === 'x') {
      const [axis, t, f] = val.split(',');
      const tn = Number(t);
      if (['x', 'y', 'z'].includes(axis) && tn >= 0 && tn <= 1) out.section = { axis, t: tn, flip: f === 'f' };
    } else if (k === 'h') out.hidden = parseRuns(val);
    else if (k === 'k') out.selected = parseRuns(val);
  }
  if (out.cam) {
    out.cam.ortho = !!out.ortho;
    out.cam.orient = out.orient || DEFAULT_ORIENT;
  }
  delete out.ortho;
  delete out.orient;
  return out;
}
