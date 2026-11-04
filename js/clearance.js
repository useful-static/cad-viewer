// Clearance (feature review item 18): the smallest distance between two sets
// of triangles -- a board and the case around it, two boards -- and the two
// points where it is, exactly on the tessellation. 0 means they touch or
// overlap (a pierced triangle, a shared face), or that a part lies wholly inside
// a closed body of the other set (opts.solidA / solidB: the closed bodies, from
// the facts' closed flags; js/main.js waits for them).
//
// The distance itself is js/tri-distance.js's (a tree per set, walked together
// nearest box pair first); here, whether a part lies inside a solid.
//
// Pure ES module, no DOM.

import { solidIndex, windingAt } from './solid.js';
import { bodyShells } from './edges.js';
import { windsAgainstNormals } from './raycast.js';
import { surfaceDistance } from './tri-distance.js';

// pos: Float32Array xyz, index: Uint32Array triangles; trisA, trisB:
// [[firstTriangle, count], ...]. Returns { distance, pa, pb, triA, triB,
// pairs, inside } (pairs: triangle pairs tested), or null when a set is empty. opts.solidA /
// solidB: the triangle ranges of that set's closed bodies -- then a gap above 0 is tested for a
// part of one set lying wholly in a solid of the other (a pin inside a block read "1 mm from the
// pin to the block"): distance 0, inside: true. opts.normal: the model's vertex normals (snorm16 x4),
// so a solid's material is the one the view shows (below)
export function clearance(pos, index, trisA, trisB, opts = {}) {
  const r = surfaceDistance(pos, index, trisA, trisB);
  if (!r || r.distance === 0) return r;
  // Each solid on its own, by its box first, then the viewer's one test of material
  // (js/solid.js windingAt: the solid's winding number about the point, by three rays, above 0).
  // With opts.normal (the model's snorm16 x4 vertex normals) each triangle is first turned to face
  // as its normals do (js/raycast.js windsAgainstNormals, export's rule too) -- the outside the
  // view shades, cuts and fills by -- so the material is the view's: a cavity, a part embedded in
  // another, an overlap, a body inside out by its winding alone, two parts face to face wound
  // opposite ways (one shell by its shared face: one sign for both, by a count a shell). A solid is
  // closed by its b-rep's word: a crack in a wall misses a ray or two, the majority answers.
  // A part is asked at a point of each of its shells, not one corner: a part of many shells (an
  // STL board is one body) read its pin's answer by the order of its triangles; and a point on
  // the solid's surface is no answer, the shell's next corner asked (a pin in a cavity far from
  // the origin read 0 by a touch on the cavity's wall).
  // Every part against every solid's every triangle froze the page: 2,000 parts in a case, 98 s.
  // The answer names the part and the solid that holds it (the nearest surfaces' pair named two
  // others)
  const N = opts.normal || null;
  // a range of triangles as a body of their own (vertices numbered from 0), turned to its normals
  // (vertices renumbered by typed tables, the range's lowest to highest vertex: a Map of them ran
  // past its 16.7 M-entry limit on a body of 19.2 M vertices, a RangeError after 10.5 s)
  const localOf = ([t0, c], turn) => {
    let v0 = Infinity, v1 = -1;
    for (let k = 0; k < 3 * c; k++) { const v = index[3 * t0 + k]; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const local = new Int32Array(Math.max(0, v1 - v0 + 1)).fill(-1), I = new Uint32Array(3 * c);
    let nl = 0;
    for (let k = 0; k < 3 * c; k++) { const v = index[3 * t0 + k] - v0; if (local[v] < 0) local[v] = nl++; I[k] = local[v]; }
    const Pa = new Float32Array(3 * nl);
    for (let v = 0; v < local.length; v++) if (local[v] >= 0) { const l = 3 * local[v], g = 3 * (v + v0); Pa[l] = pos[g]; Pa[l + 1] = pos[g + 1]; Pa[l + 2] = pos[g + 2]; }
    if (turn && N) {
      for (let t = 0; t < c; t++) {
        if (windsAgainstNormals(pos, N, index[3 * (t0 + t)], index[3 * (t0 + t) + 1], index[3 * (t0 + t) + 2])) { const x = I[3 * t + 1]; I[3 * t + 1] = I[3 * t + 2]; I[3 * t + 2] = x; }
      }
    }
    return { P: Pa, I };
  };
  const within = (parts, solids, aFirst) => {
    if (!solids || !solids.length) return null;
    const idx = solids.map(() => null); // (each solid's index, built when a part's point is in its box)
    const solidOf = (s) => {
      if (idx[s]) return idx[s];
      const { P, I } = localOf(solids[s], true);
      return (idx[s] = solidIndex(P, I, Uint32Array.from({ length: I.length / 3 }, (_, t) => t)));
    };
    const boxes = solids.map(([t0, c]) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let t = t0; t < t0 + c; t++) for (let j = 0; j < 3; j++) { const i = index[t * 3 + j] * 3; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); } }
      return { lo, hi };
    });
    for (const part of parts) {
      if (!(part[1] > 0)) continue;
      // a point of each of the part's shells: the corners of its first triangles, the next asked
      // while one lies on the solid's surface
      const { P, I } = localOf(part, false), b = bodyShells(P, I);
      const ofShell = new Map(); // (shell -> its first few triangles)
      for (let t = 0; t < part[1]; t++) {
        const sh = b.shell[t];
        if (sh < 0) continue;
        const l = ofShell.get(sh) || [];
        if (l.length < 3) { l.push(t); ofShell.set(sh, l); }
      }
      for (const ts of ofShell.values()) {
        for (let s = 0; s < solids.length; s++) {
          const bx = boxes[s];
          for (const t of ts) {
            let answered = false;
            for (let c = 0; c < 3 && !answered; c++) {
              const v = I[3 * t + c], p = [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
              if ([0, 1, 2].some((k) => p[k] < bx.lo[k] || p[k] > bx.hi[k])) { answered = true; break; }
              const w = windingAt(solidOf(s), p);
              if (w.touch) continue;
              answered = true;
              if (w.inside) {
                const named = solids[s][0], mine = part[0] + t; // (a triangle of each: they name the bodies)
                return aFirst ? { triA: mine, triB: named, pa: p, pb: p } : { triA: named, triB: mine, pa: p, pb: p };
              }
            }
            if (answered) break;
          }
        }
      }
    }
    return null;
  };
  const inside = within(trisA, opts.solidB, true) || within(trisB, opts.solidA, false);
  if (inside) return { ...r, ...inside, distance: 0, inside: true };
  return r;
}
