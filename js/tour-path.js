// A tour's camera flight from one view to the next (js/tour.js), pure so
// tests/test-tour.mjs checks it in Node. A pose is { target: [x, y, z],
// dist, q: [x, y, z, w] } as js/camera.js keeps it.
//
// The target moves in a straight line, the orientation turns along the
// shortest arc (slerp), and the distance changes by its logarithm, so a zoom
// from far out onto a small part reads as steady instead of rushing at the
// end. Each is eased by the same curve.

export const EASE = {
  linear: (t) => t,
  // slow in, slow out (a cubic): the camera starts and settles gently
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
};

// Spherical interpolation of unit quaternions, along the shorter arc
export function slerp(a, b, t) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (dot < 0) { dot = -dot; bb = b.map((v) => -v); } // q and -q are the same turn: take the near one
  if (dot > 0.9995) {
    const r = a.map((v, k) => v + (bb[k] - v) * t);
    const n = Math.hypot(...r) || 1;
    return r.map((v) => v / n);
  }
  const th = Math.acos(Math.min(1, dot));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((v, k) => v * wa + bb[k] * wb);
}

// The pose at fraction t (0..1, already eased) of the way from a to b
export function poseAt(a, b, t) {
  return {
    target: a.target.map((v, k) => v + (b.target[k] - v) * t),
    dist: Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * t),
    q: slerp(a.q, b.q, t),
  };
}

// The angle (radians) between two orientations: how far a flight turns
export function turnAngle(a, b) {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot));
}
