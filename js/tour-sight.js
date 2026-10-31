// Where a tour step's "from": "outside" looks from: the direction from which
// the part is least hidden by the rest of the model. Pure (no DOM), so
// tests/test-tour.mjs checks it in Node.
//
// Candidates: twelve directions round the up axis at rises of ±30°, ±55° and
// ±80° (a negative rise is from underneath: the board turned over, for a
// part on its bottom face). For each, rays leave 27 points spread through
// the part's box toward the eye, and a ray is blocked when it passes through
// another body's box. The candidate with the fewest blocked rays wins, a
// small penalty keeping it near the preferred one (from the side of the
// model the part lies on, 30° up) when several are equally clear.

const RISES = [30, 55, 80, -30, -55, -80].map((d) => (d * Math.PI) / 180);
const TURNS = 12;
const FRACS = [0.15, 0.5, 0.85];
const PREFER_WEIGHT = 0.08;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const n = Math.hypot(...a); return a.map((v) => v / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Whether the ray p + t d (t > eps) passes through box b
export function rayHitsBox(p, d, b, eps = 1e-6) {
  let t0 = eps, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (p[k] < b.min[k] || p[k] > b.max[k]) return false;
      continue;
    }
    let a = (b.min[k] - p[k]) / d[k], c = (b.max[k] - p[k]) / d[k];
    if (a > c) [a, c] = [c, a];
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return false;
  }
  return true;
}

const inside = (p, b) => p.every((v, k) => v >= b.min[k] && v <= b.max[k]);

// The share (0-1) of the part's sample rays toward direction d (toward the
// eye) that another body's box blocks. A box holding the sample point is
// not counted (the part's own surroundings: a board under a socket's pins).
export function blockedShare(box, d, obstacles) {
  let blocked = 0, n = 0;
  for (const fx of FRACS) for (const fy of FRACS) for (const fz of FRACS) {
    const p = [fx, fy, fz].map((f, k) => box.min[k] + f * (box.max[k] - box.min[k]));
    n++;
    for (const o of obstacles) {
      if (!inside(p, o) && rayHitsBox(p, d, o)) { blocked++; break; }
    }
  }
  return blocked / n;
}

// The candidate directions (unit vectors toward the eye) round `up`,
// starting from the ground direction `h0` (any unit vector across up)
export function candidates(up, h0) {
  const side = cross(up, h0);
  const out = [];
  for (const rise of RISES) {
    for (let i = 0; i < TURNS; i++) {
      const a = (2 * Math.PI * i) / TURNS;
      const g = h0.map((v, k) => v * Math.cos(a) + side[k] * Math.sin(a));
      out.push(g.map((v, k) => v * Math.cos(rise) + up[k] * Math.sin(rise)));
    }
  }
  return out;
}

// The clearest direction toward the eye for a part's box: { dir, blocked }.
// up: the model's up; centre: the model's centre; obstacles: the other
// bodies' boxes. The preferred direction is from the model's centre toward
// the part, along the ground, 30° up (or the first ground axis across up when
// the part is at the centre).
export function clearestDirection(box, up, centre, obstacles) {
  const p = [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2);
  let h = p.map((v, k) => v - centre[k]);
  h = h.map((v, k) => v - dot(h, up) * up[k]);
  if (Math.hypot(...h) < 1e-9) {
    // (any axis across up)
    const a = Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    h = a.map((v, k) => v - dot(a, up) * up[k]);
  }
  h = norm(h);
  const prefer = h.map((v, k) => v * Math.cos(RISES[0]) + up[k] * Math.sin(RISES[0]));
  let best = null;
  for (const d of candidates(up, h)) {
    const blocked = blockedShare(box, d, obstacles);
    const off = Math.acos(Math.max(-1, Math.min(1, dot(d, prefer)))) / Math.PI;
    const score = blocked + PREFER_WEIGHT * off;
    if (!best || score < best.score - 1e-12) best = { dir: d, blocked, score };
  }
  return { dir: best.dir, blocked: best.blocked };
}
