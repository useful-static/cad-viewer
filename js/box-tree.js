// One spatial index design for the viewer's "which items are near or around this point"
// questions, in 2 or 3 dimensions: the 2D view's snaps, lines and texts (js/dxf-view.js), the
// shells a shell may lie in and a solid's triangles along a ray (js/solid.js, js/edges.js). Pure,
// no DOM. (The 2D view had a 2-d tree beside a box tree; the shells an index on x alone, which a
// stack along y, or one wide board under its parts, made quadratic again: 7.0 s for 20,000 cubes.)
//
// boxTree(B, ids, D = 2): B, a Float64Array of two opposite corners per item (D numbers, then D
// more, in either order: a segment's two ends are its box's); ids, the items to hold (finite
// ones). The items sorted along a Morton curve of their boxes' centres, LEAF a leaf, the leaves
// the bottom row of a complete binary tree (node i's children 2i + 1, 2i + 2), each node's box
// (float32, widened a little so rounding never shrinks it) holding its children's. The curve
// follows the items' density: a uniform grid sized from the extents put 95.6 % of a real
// drawing's 1.75 million segments in one cell, 30-40 ms a hover.

export const LEAF = 16;

// (a coordinate's bits spread for the Morton code: 16 bits two ways, 10 bits three ways)
const spread2 = (v) => { v = (v | (v << 8)) & 0x00ff00ff; v = (v | (v << 4)) & 0x0f0f0f0f; v = (v | (v << 2)) & 0x33333333; return (v | (v << 1)) & 0x55555555; };
const spread3 = (v) => { v &= 0x3ff; v = (v | (v << 16)) & 0x030000ff; v = (v | (v << 8)) & 0x0300f00f; v = (v | (v << 4)) & 0x030c30c3; return (v | (v << 2)) & 0x09249249; };

export function boxTree(B, ids, D = 2) {
  const m = ids.length, S = 2 * D;
  const lo = new Array(D).fill(Infinity), hi = new Array(D).fill(-Infinity);
  for (let k = 0; k < m; k++) {
    const t = ids[k];
    for (let a = 0; a < D; a++) { const c = (B[S * t + a] + B[S * t + D + a]) / 2; if (c < lo[a]) lo[a] = c; if (c > hi[a]) hi[a] = c; }
  }
  const top = D === 2 ? 65535 : 1023;
  const sc = lo.map((l, a) => (hi[a] > l ? top / (hi[a] - l) : 0));
  const code = new Uint32Array(m);
  for (let k = 0; k < m; k++) {
    const t = ids[k];
    let c = 0;
    for (let a = 0; a < D; a++) {
      const q = Math.floor(((B[S * t + a] + B[S * t + D + a]) / 2 - lo[a]) * sc[a]);
      c |= (D === 2 ? spread2(q) : spread3(q)) << a;
    }
    code[k] = c >>> 0;
  }
  // (a radix sort by the code, 8 bits a pass, stable)
  let order = ids.slice(), keys = code, o2 = new Uint32Array(m), k2 = new Uint32Array(m);
  const count = new Uint32Array(257);
  for (let shift = 0; shift < 32; shift += 8) {
    count.fill(0);
    for (let k = 0; k < m; k++) count[((keys[k] >>> shift) & 255) + 1]++;
    for (let b = 0; b < 256; b++) count[b + 1] += count[b];
    for (let k = 0; k < m; k++) { const p = count[(keys[k] >>> shift) & 255]++; o2[p] = order[k]; k2[p] = keys[k]; }
    [order, o2] = [o2, order]; [keys, k2] = [k2, keys];
  }
  const leaves = Math.max(1, Math.ceil(m / LEAF));
  let P = 1;
  while (P < leaves) P *= 2;
  const box = new Float32Array(S * (2 * P - 1)).fill(NaN);
  // (float32, widened by a few of its own steps: never smaller than the float64 box)
  const pad = (v) => Math.abs(v) * 4e-7 + 1e-30;
  const l = new Float64Array(D), h = new Float64Array(D);
  for (let j = 0; j < leaves; j++) {
    l.fill(Infinity); h.fill(-Infinity);
    for (let k = j * LEAF; k < Math.min(m, (j + 1) * LEAF); k++) {
      const t = order[k];
      for (let a = 0; a < D; a++) {
        const u = B[S * t + a], w = B[S * t + D + a];
        if (u < l[a]) l[a] = u; if (w < l[a]) l[a] = w; if (u > h[a]) h[a] = u; if (w > h[a]) h[a] = w;
      }
    }
    if (!(l[0] <= h[0])) continue;
    const i = P - 1 + j;
    for (let a = 0; a < D; a++) { box[S * i + a] = l[a] - pad(l[a]); box[S * i + D + a] = h[a] + pad(h[a]); }
  }
  const has = (c) => box[S * c] === box[S * c]; // (not NaN: a box)
  for (let i = P - 2; i >= 0; i--) {
    const a = 2 * i + 1, b = 2 * i + 2, ha = has(a), hb = has(b);
    if (!ha && !hb) continue;
    for (let k = 0; k < D; k++) {
      box[S * i + k] = ha && hb ? Math.min(box[S * a + k], box[S * b + k]) : box[S * (ha ? a : b) + k];
      box[S * i + D + k] = ha && hb ? Math.max(box[S * a + D + k], box[S * b + D + k]) : box[S * (ha ? a : b) + D + k];
    }
  }
  return { order, m, P, box, D };
}

// The item of the trees nearest q ([x, y] or [x, y, z]) by dist(id) (a squared distance;
// Infinity: not a hit), at most r away, that accept(id) takes, or -1; of equal distances the
// lowest id (as a scan in order finds it). Each tree walked nearest box first, past every box
// farther than the best. (An accept that always says no visits every item whose leaf is within
// r: itemsAt.)
export function nearestItem(trees, q, r, dist, accept = () => true) {
  let best = -1, bd = r * r;
  const stack = new Int32Array(128); // (a complete tree's depth is under 32: a node pushes 2 at most)
  for (const { order, m, P, box, D } of trees) {
    if (!m) continue;
    const S = 2 * D;
    const away = (i) => {
      if (box[S * i] !== box[S * i]) return Infinity; // (an empty leaf)
      let s = 0;
      for (let a = 0; a < D; a++) { const d = Math.max(box[S * i + a] - q[a], 0, q[a] - box[S * i + D + a]); s += d * d; }
      return s;
    };
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const i = stack[--sp];
      if (away(i) > bd) continue;
      if (i >= P - 1) {
        const j = i - (P - 1);
        for (let k = j * LEAF; k < Math.min(m, (j + 1) * LEAF); k++) {
          const t = order[k], d = dist(t);
          if ((d < bd || (d === bd && (best < 0 || t < best))) && accept(t)) { bd = d; best = t; }
        }
        continue;
      }
      const a = 2 * i + 1, b = 2 * i + 2, da = away(a), db = away(b);
      // (the nearer pushed last: walked first)
      if (da <= db) { if (db <= bd) stack[sp++] = b; if (da <= bd) stack[sp++] = a; } else { if (da <= bd) stack[sp++] = a; if (db <= bd) stack[sp++] = b; }
    }
  }
  return best;
}

// Every item of the tree whose leaf's box holds q, visited (visit(id)); the caller tests the item
// itself
export function itemsAt(tree, q, visit) {
  nearestItem([tree], q, 0, () => 0, (t) => { visit(t); return false; });
}
