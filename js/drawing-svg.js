// A 1:1 drawing of parts as SVG (feature review 2026-10-29, item 19): their
// b-rep edges (js/measure-geom.js) projected straight along a view axis, in
// mm, so the file prints, cuts or imports at true size (width and height in
// mm, viewBox in mm). A circular edge seen face on (a hole, a boss) is written
// as a true <circle>, not its tessellation's polygon. One <g> per part, named
// for it. Hidden edges are not removed: every edge of the parts given is drawn
// (choose the parts: a board alone gives its outline and its holes). Pure, no
// DOM.

import { circleOf } from './measure-geom.js';
import { cross, dot } from './vec3.js';

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const n3 = (v) => (Math.abs(v) < 5e-4 ? '0' : v.toFixed(3).replace(/\.?0+$/, ''));

// parts: [{ name, geom }] (geom: bodyGeometry's { edges, circles, a }: a, the
// body's own angular deflection, sets its circle test); right, up: the
// drawing's x and y axes as model-frame unit vectors (toward = right x up is
// the viewer); title: a caption. -> { svg, width, height } (mm)
export function drawingSVG(parts, right, up, { title = '', margin = 5 } = {}) {
  const toward = cross(right, up);
  const P = (p) => [dot(p, right), -dot(p, up)];
  const groups = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  let lines = 0, circles = 0;
  for (const part of parts) {
    const els = [];
    // the part's circles seen face on (its faces' circular loops: a rim is
    // often split into two edges at a seam, so no one edge is the circle),
    // each drawn once as a true circle
    const round = [];
    for (const c of part.geom.circles || []) {
      if (Math.abs(Math.abs(dot(c.normal, toward)) - 1) > 1e-3) continue;
      const [cx, cy] = P(c.centre);
      if (round.some((r) => Math.hypot(r.x - cx, r.y - cy) < 1e-3 && Math.abs(r.r - c.radius) < 1e-3)) continue;
      round.push({ x: cx, y: cy, r: c.radius });
      grow(cx - c.radius, cy - c.radius);
      grow(cx + c.radius, cy + c.radius);
      els.push(`<circle cx="${n3(cx)}" cy="${n3(cy)}" r="${n3(c.radius)}"/>`);
      circles++;
    }
    const onCircle = (pts) => round.some((r) => pts.every(([x, y]) => Math.abs(Math.hypot(x - r.x, y - r.y) - r.r) <= 0.01 * r.r + 1e-4));
    for (const [ei, e] of part.geom.edges.entries()) {
      if (part.geom.edgeClosed[ei] && !round.length) {
        // a closed edge that is a circle seen face on (geometry without its
        // faces' circles): a true circle
        const c = circleOf(e.slice(0, -1), part.geom.a); // (the part's own: a scene's models differ)
        if (c && Math.abs(Math.abs(dot(c.normal, toward)) - 1) < 1e-3) {
          const [cx, cy] = P(c.centre);
          grow(cx - c.radius, cy - c.radius);
          grow(cx + c.radius, cy + c.radius);
          els.push(`<circle cx="${n3(cx)}" cy="${n3(cy)}" r="${n3(c.radius)}"/>`);
          circles++;
          continue;
        }
      }
      const pts = e.map((p) => P(p));
      // an edge on a circle already drawn (a half rim) is that circle
      if (round.length && onCircle(pts)) continue;
      // an edge seen end on (along the view) is a point: nothing to draw
      if (pts.every((q) => Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]) < 1e-4)) continue;
      for (const [x, y] of pts) grow(x, y);
      els.push(`<polyline points="${pts.map(([x, y]) => `${n3(x)},${n3(y)}`).join(' ')}"/>`);
      lines++;
    }
    if (els.length) groups.push(`<g id="${esc(part.id || part.name)}"><title>${esc(part.name)}</title>${els.join('')}</g>`);
  }
  if (x0 === Infinity) { x0 = y0 = 0; x1 = y1 = 1; }
  const bx = x0 - margin, by = y0 - margin;
  const w = x1 - x0 + 2 * margin, h = y1 - y0 + 2 * margin + (title ? 6 : 0);
  const cap = title ? `<text x="${n3(bx + margin)}" y="${n3(by + h - 2)}" font-family="sans-serif" font-size="3" fill="#000" stroke="none">${esc(title)}</text>` : '';
  const svg = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${n3(w)}mm" height="${n3(h)}mm" viewBox="${n3(bx)} ${n3(by)} ${n3(w)} ${n3(h)}">\n`
    + `<g fill="none" stroke="#000" stroke-width="0.1" stroke-linecap="round" stroke-linejoin="round">${groups.join('\n')}</g>\n${cap}\n</svg>\n`;
  return { svg, width: w, height: h, lines, circles };
}
