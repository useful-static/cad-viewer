// A 2D DXF drawing (js/dxf.js parseDXF) on its own canvas over the stage
// (plan feature 23): the paper background of the 3D line styles, lines 1 px
// at any zoom (a wide polyline at its width in drawing units, ends flat),
// native text; wheel zooms toward the pointer, a drag pans, two fingers pinch,
// a double click fits. A click selects the LAYER of the nearest line, else of
// the text under it (the selected layer in the 3D paper selection colour and
// 1 px wider, the others faded); hovering shows a layer un-faded and wider.
//
// One Path2D per (layer, colour, fill, dash, weight, width, even-odd hatch),
// built relative to the drawing's extents centre (Canvas paths are float32: a
// drawing at 10^6 units would jitter when zoomed in), stroked under the view
// transform with lineWidth = 1 / scale. Uses the DOM (a canvas); no 3D renderer.

import { onPaper, textCorners, wrapLines } from './dxf.js';
import { PAPER, PAPER_EDGES } from './styles.js';
import { unitWord } from './units.js';
import { boxTree, nearestItem } from './box-tree.js';

// a selected or faded layer's lines: the 3D paper styles' visible-edge colours
const SELECTED = PAPER_EDGES.selected[0];
const FADED = PAPER_EDGES.faded[0];
const HIT_PX = 8;
const MIN_TEXT_PX = 3; // a text under this height on screen is not drawn (and not clicked)

// The 2D view's one question, "the nearest item to (x, y) within r that accept() takes", by the
// viewer's one box tree (js/box-tree.js, two-dimensional here): the snaps are points (boxes of no
// size), the hover's lines segments, its texts their drawn quads. (The snaps had a 2-d tree of
// their own beside the lines' box tree; the texts had none: every one tested on a hover over
// empty sheet, 360 ms a move on a million.)

// The snaps: the nearest point within r that accept(point) takes. pts: [[x, y, ...], ...], or
// snapPoints' typed set ({ n, xy, at(i) -> the point as an array })
// (a grid sized from the extents held 397,389 points in one cell of a clustered drawing, 46 ms a move)
export function pointTree(pts) {
  const n = Array.isArray(pts) ? pts.length : pts.n;
  const xy = Array.isArray(pts) ? Float64Array.from(pts.flatMap((p) => [p[0], p[1]])) : pts.xy;
  const at = Array.isArray(pts) ? (i) => pts[i] : pts.at;
  const B = new Float64Array(4 * n), ids = [];
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i], y = xy[2 * i + 1];
    B[4 * i] = B[4 * i + 2] = x; B[4 * i + 1] = B[4 * i + 3] = y;
    if (Number.isFinite(x + y)) ids.push(i);
  }
  return { xy, at, tree: boxTree(B, Uint32Array.from(ids)) };
}
export function nearestPoint(index, x, y, r, accept = () => true) {
  const { xy, at } = index;
  const i = nearestItem([index.tree], [x, y], r, (k) => (xy[2 * k] - x) ** 2 + (xy[2 * k + 1] - y) ** 2, (k) => accept(at(k)));
  return i < 0 ? null : at(i);
}

// The hover's texts: the first text (in the drawing's order) whose drawn quad holds (x, y) and
// that accept(textIndex) takes, or -1. cornersOf(t): its four corners as drawn (bottom-left,
// bottom-right, top-left, top-right; js/dxf.js textCorners with the view's measured lines), o: the
// offset. Built once; the corners measured then, once a text.
export function textIndex(texts, cornersOf, o) {
  const n = texts.length, B = new Float64Array(4 * n), Q = new Float64Array(8 * n), ids = [];
  texts.forEach((t, i) => {
    const c = cornersOf(t);
    // (in the quad's order round it: bottom-left, bottom-right, top-right, top-left)
    const q = [c[0], c[1], c[3], c[2]];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    q.forEach(([x, y], k) => {
      const ux = x - o[0], uy = y - o[1];
      Q[8 * i + 2 * k] = ux; Q[8 * i + 2 * k + 1] = uy;
      x0 = Math.min(x0, ux); y0 = Math.min(y0, uy); x1 = Math.max(x1, ux); y1 = Math.max(y1, uy);
    });
    B[4 * i] = x0; B[4 * i + 1] = y0; B[4 * i + 2] = x1; B[4 * i + 3] = y1;
    if (Number.isFinite(x0 + y0 + x1 + y1)) ids.push(i);
  });
  return { Q, tree: boxTree(B, Uint32Array.from(ids)) };
}
export function textAt(index, x, y, accept = () => true) {
  const { Q } = index;
  // inside when on one side of each edge of the quad taken in order (a hit at distance 0)
  const inside = (i) => {
    let pos = 0, neg = 0;
    for (let k = 0; k < 4; k++) {
      const ax = Q[8 * i + 2 * k], ay = Q[8 * i + 2 * k + 1], bx = Q[8 * i + 2 * ((k + 1) % 4)], by = Q[8 * i + 2 * ((k + 1) % 4) + 1];
      const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (cr > 0) pos++; else if (cr < 0) neg++;
    }
    return !(pos && neg) ? 0 : Infinity;
  };
  return nearestItem([index.tree], [x, y], 0, inside, accept);
}

// A drawing's line segments indexed for the nearest line within r (the hover, a click's layer):
// every segment was tested on every pointer move, 200 ms a move on 5.2 million. paths: the
// drawing's; o: the offset; span: its size. Two box trees, the short segments' and the long ones'.
//
// All typed arrays: segs (ax ay bx by a segment), pathOf, each tree's order and boxes. (A JS array
// per segment and a string-keyed Map of arrays held 604 MB of heap for 5.2 million segments.)
// A path's segments run point to point (and back to its first, closed); a path of one point is one
// segment of no length. (Every open path had one more, of no length at its last point, already
// the end of its last segment: 15.1 % of the dozens drawings' segments.)
export function segmentIndex(paths, o, span) {
  const segsOf = (p) => { const m = p.pts.length / 2; return m === 1 || p.closed ? m : Math.max(0, m - 1); };
  let n = 0;
  for (const p of paths) n += segsOf(p);
  const segs = new Float64Array(4 * n), pathOf = new Uint32Array(n);
  let s = 0;
  let lx = Infinity, ly = Infinity, hx = -Infinity, hy = -Infinity;
  paths.forEach((p, pi) => {
    const m = p.pts.length / 2, k = segsOf(p);
    for (let i = 0; i < k; i++, s++) {
      const j = m === 1 ? 0 : (i + 1) % m;
      const ax = p.pts[i * 2] - o[0], ay = p.pts[i * 2 + 1] - o[1];
      const bx = p.pts[j * 2] - o[0], by = p.pts[j * 2 + 1] - o[1];
      segs[4 * s] = ax; segs[4 * s + 1] = ay; segs[4 * s + 2] = bx; segs[4 * s + 3] = by;
      pathOf[s] = pi;
      if (Number.isFinite(ax + ay + bx + by)) { lx = Math.min(lx, ax, bx); ly = Math.min(ly, ay, by); hx = Math.max(hx, ax, bx); hy = Math.max(hy, ay, by); }
    }
  });
  // the segments far longer than most (a border, a line across the sheet) in a tree of their own:
  // one in a leaf of short ones made every box above it as wide
  const longest = (span || Math.max(hx - lx, hy - ly) || 1) / 8;
  const short = [], long = [];
  for (let t = 0; t < n; t++) {
    const w = Math.max(Math.abs(segs[4 * t + 2] - segs[4 * t]), Math.abs(segs[4 * t + 3] - segs[4 * t + 1]));
    if (!Number.isFinite(w)) continue; // (a point not a number is never near)
    (w > longest ? long : short).push(t);
  }
  return { tree: boxTree(segs, Uint32Array.from(short)), longTree: boxTree(segs, Uint32Array.from(long)), segs, pathOf, paths, o, span };
}
// -> the path index of the nearest segment within r that accept(pathIndex) takes, or -1
export function nearestSegment(index, x, y, r, accept = () => true) {
  const { segs, pathOf } = index;
  const dist = (s) => {
    const ax = segs[4 * s], ay = segs[4 * s + 1], vx = segs[4 * s + 2] - ax, vy = segs[4 * s + 3] - ay, l2 = vx * vx + vy * vy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0;
    return (x - ax - t * vx) ** 2 + (y - ay - t * vy) ** 2;
  };
  const s = nearestItem([index.longTree, index.tree], [x, y], r, dist, (k) => accept(pathOf[k]));
  return s < 0 ? -1 : pathOf[s];
}

// whether a path is added to its group reversed: a fill (not a hatch's even-odd loops) wound
// clockwise, so every such fill runs counter-clockwise and a group's non-zero fill is their union
export function addedReversed(p) {
  if (!p.fill || p.evenodd) return false;
  const n = p.pts.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += p.pts[2 * i] * p.pts[2 * j + 1] - p.pts[2 * j] * p.pts[2 * i + 1]; }
  return a < 0;
}

// 2D Measure's snap points (drawing units, relative to o): every line end, every segment's middle
// -- a closed path's closing side too, the side segmentIndex draws and hovers back to its first
// point (a 3DFACE, a closed 3D polyline: 58,632 such paths in the dozens had none there) -- and
// the centre of each closed path that is a circle (its points all within 1 % of one distance from
// their mean). -> a typed set { n, xy, kind, path, r, at(i) -> [x, y, kind, layer, radius?] }
// (a JS array a snap held 808 MB for 9 M of them, built at every open: the view builds the set
// when Measure is first turned on)
const SNAP_KINDS = ['end', 'middle', 'centre'];
export function snapPoints(paths, o) {
  let cap = 0;
  for (const p of paths) if (!p.outline) cap += p.pts.length + 1; // (at most 2 a point and a centre)
  const xy = new Float64Array(2 * cap), kind = new Uint8Array(cap), path = new Uint32Array(cap), rad = new Float64Array(cap);
  let n = 0;
  const put = (x, y, k, pi, r = 0) => { xy[2 * n] = x - o[0]; xy[2 * n + 1] = y - o[1]; kind[n] = k; path[n] = pi; rad[n] = r; n++; };
  // (a closed path's last point often repeats its first: counted once)
  const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  paths.forEach((p, pi) => {
    if (p.outline) return; // (a wide polyline's outline: its corners are not its ends)
    const n2 = p.pts.length / 2, q = p.pts;
    const mid = (i, j) => put((q[i * 2] + q[j * 2]) / 2, (q[i * 2 + 1] + q[j * 2 + 1]) / 2, 1, pi);
    for (let i = 0; i < n2; i++) {
      put(q[i * 2], q[i * 2 + 1], 0, pi);
      if (i + 1 < n2) mid(i, i + 1);
    }
    const m = n2 > 1 && same(q[0], q[(n2 - 1) * 2]) && same(q[1], q[(n2 - 1) * 2 + 1]) ? n2 - 1 : n2;
    if (p.closed && m === n2 && n2 > 2) mid(n2 - 1, 0);
    if (p.closed && m >= 12) {
      let cx = 0, cy = 0;
      for (let i = 0; i < m; i++) { cx += q[i * 2]; cy += q[i * 2 + 1]; }
      cx /= m; cy /= m;
      let r = 0;
      for (let i = 0; i < m; i++) r += Math.hypot(q[i * 2] - cx, q[i * 2 + 1] - cy);
      r /= m;
      let round = r > 0;
      for (let i = 0; round && i < m; i++) if (!(Math.abs(Math.hypot(q[i * 2] - cx, q[i * 2 + 1] - cy) - r) < 0.01 * r)) round = false;
      if (round) put(cx, cy, 2, pi, r);
    }
  });
  // (the same array for the same snap, so a hover that stays on it is no change: those made kept,
  // a few thousand at most)
  const made = new Map();
  const at = (i) => {
    let s = made.get(i);
    if (!s) {
      if (made.size > 4096) made.clear();
      s = [xy[2 * i], xy[2 * i + 1], SNAP_KINDS[kind[i]], paths[path[i]].layer, ...(kind[i] === 2 ? [rad[i]] : [])];
      made.set(i, s);
    }
    return s;
  };
  return { n, xy: xy.subarray(0, 2 * n), kind: kind.subarray(0, n), path: path.subarray(0, n), r: rad.subarray(0, n), at };
}

export function createDxfView(canvas, drawing, cb = {}) {
  const ctx = canvas.getContext('2d');
  const ext = drawing.extents || { min: [0, 0], max: [1, 1] };
  const o = [(ext.min[0] + ext.max[0]) / 2, (ext.min[1] + ext.max[1]) / 2];
  const st = { s: 1, c: [0, 0], selected: null, hover: null, off: new Set(drawing.layers.filter((l) => !l.on).map((l) => l.name)),
    measure: false, pending: null, results: [], snap: null };
  // the drawing's unit as written for a reader ("µm"), as the info panel writes it
  const units = drawing.units ? unitWord(drawing.units) : '';
  // the paths, grouped, relative to o
  const groups = new Map();
  for (const p of drawing.paths) {
    const key = `${p.layer}\u0000${p.colour.r},${p.colour.g},${p.colour.b},${p.colour.aci}\u0000${p.fill ? 1 : 0}\u0000${p.dash ? p.dash.join(',') : ''}\u0000${p.weight ?? ''}\u0000${p.width || ''}\u0000${p.evenodd || ''}`;
    let g = groups.get(key);
    // a line weight in mm shows as 4 px a mm on screen, at least 1 px; a polyline's width is in
    // drawing units (it scales with the zoom, as on paper)
    if (!g) { g = { layer: p.layer, colour: onPaper(p.colour), fill: p.fill, dash: p.dash || null, px: p.weight ? Math.max(1, p.weight * 4) : 1, width: p.width || 0, evenodd: !!p.evenodd, path: new Path2D(), points: [] }; groups.set(key, g); }
    if (p.point) { g.points.push(p.pts[0] - o[0], p.pts[1] - o[1]); continue; }
    // (a fill not a hatch's even-odd loops is added counter-clockwise: the group's fills are one
    // non-zero path, and two overlapping SOLIDs wound opposite ways left their overlap empty)
    const n = p.pts.length / 2;
    const rev = addedReversed(p);
    const at = (i) => (rev ? n - 1 - i : i);
    g.path.moveTo(p.pts[2 * at(0)] - o[0], p.pts[2 * at(0) + 1] - o[1]);
    for (let i = 1; i < n; i++) g.path.lineTo(p.pts[2 * at(i)] - o[0], p.pts[2 * at(i) + 1] - o[1]);
    if (p.closed) g.path.closePath();
  }
  const css = () => [canvas.clientWidth || 1, canvas.clientHeight || 1];

  // a text's lines as drawn: an MTEXT with a reference width wrapped at it by the font's measure
  // (js/dxf.js wrapLines), once per text -- what is drawn and what a click finds
  const wrapped = new WeakMap();
  const linesOf = (t) => {
    if (!(t.mtext && t.wrap > 0)) return t.text.split('\n');
    let w = wrapped.get(t);
    if (!w) {
      ctx.save(); ctx.font = `${t.h}px sans-serif`;
      w = wrapLines(t.text.split('\n'), (l) => ctx.measureText(l).width * (t.widthFactor || 1), t.wrap);
      ctx.restore();
      wrapped.set(t, w);
    }
    return w;
  };
  // the width of its widest line as drawn (the font's measure, times its width factor), once per text
  const widths = new WeakMap();
  const widthOf = (t) => {
    let w = widths.get(t);
    if (w === undefined) {
      ctx.save(); ctx.font = `${t.h}px sans-serif`;
      w = 0;
      for (const l of linesOf(t)) w = Math.max(w, ctx.measureText(l).width * (t.widthFactor || 1));
      ctx.restore();
      widths.set(t, w);
    }
    return w;
  };

  function fit() {
    const [w, h] = css();
    const dx = ext.max[0] - ext.min[0] || 1, dy = ext.max[1] - ext.min[1] || 1;
    st.s = Math.min(w / dx, h / dy) * 0.92;
    st.c = [0, 0];
    draw();
  }

  // model units (relative to o) -> css px, and back
  const toPx = (x, y) => { const [w, h] = css(); return [w / 2 + (x - st.c[0]) * st.s, h / 2 - (y - st.c[1]) * st.s]; };
  const toUnits = (px, py) => { const [w, h] = css(); return [(px - w / 2) / st.s + st.c[0], -(py - h / 2) / st.s + st.c[1]]; };

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const [w, h] = css();
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // y up: x' = s (x - cx) + w/2, y' = -s (y - cy) + h/2, in device px
    const k = st.s * dpr;
    ctx.setTransform(k, 0, 0, -k, (w / 2 - st.c[0] * st.s) * dpr, (h / 2 + st.c[1] * st.s) * dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const sel = st.selected;
    const order = [...groups.values()].sort((a, b) => (a.layer === sel) - (b.layer === sel)); // the selected layer last, on top
    for (const g of order) {
      if (st.off.has(g.layer)) continue;
      const hot = g.layer === sel || g.layer === st.hover;
      const col = g.layer === sel ? SELECTED : sel && g.layer !== st.hover ? FADED : g.colour;
      if (g.fill) { ctx.fillStyle = col; ctx.globalAlpha = sel && !hot ? 0.35 : 0.85; ctx.fill(g.path, g.evenodd ? 'evenodd' : 'nonzero'); ctx.globalAlpha = 1; }
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max((g.px + (hot ? 1 : 0)) / st.s, g.width);
      // a wide polyline ends flat and meets mitred, as on paper (rounded, it reached half its width
      // past each end); a hairline stays round
      const wide = g.width > (g.px + (hot ? 1 : 0)) / st.s;
      ctx.lineCap = wide ? 'butt' : 'round';
      ctx.lineJoin = wide ? 'miter' : 'round';
      // a line type's dashes are drawing units (under the transform): they
      // scale with the zoom, as on paper; too fine to see, drawn solid
      ctx.setLineDash(g.dash && g.dash.reduce((a, x) => a + x, 0) * st.s > 3 ? g.dash : []);
      ctx.stroke(g.path);
      ctx.setLineDash([]);
      if (g.points.length) {
        ctx.fillStyle = col;
        const r = 1.5 / st.s;
        for (let i = 0; i < g.points.length; i += 2) ctx.fillRect(g.points[i] - r, g.points[i + 1] - r, 2 * r, 2 * r);
      }
    }
    // text: native, upright in its own frame
    for (const t of drawing.texts) {
      if (st.off.has(t.layer)) continue;
      const px = t.h * st.s;
      if (px < MIN_TEXT_PX) continue; // too small to read: left out
      ctx.save();
      // (a text seen through a layout viewport, clipped to its frame: js/dxf.js)
      if (t.clip) { ctx.beginPath(); ctx.rect(t.clip[0] - o[0], t.clip[1] - o[1], t.clip[2] - t.clip[0], t.clip[3] - t.clip[1]); ctx.clip(); }
      ctx.translate(t.x - o[0], t.y - o[1]);
      ctx.rotate(t.rot);
      ctx.scale(1, -1);
      ctx.fillStyle = t.layer === sel ? SELECTED : sel && t.layer !== st.hover ? FADED : onPaper(t.colour);
      ctx.font = `${t.h}px sans-serif`;
      ctx.textAlign = t.align;
      // (an MTEXT with a reference width wraps at it, measured in the font -- js/dxf.js wrapLines;
      // made once per text, as the font's width does not change with the zoom; kept here, not in
      // the drawing)
      const lines = linesOf(t);
      const lh = t.h * 1.4;
      // aligned / fit (js/dxf.js): the text fitted to its baseline's length -- aligned in both
      // directions, fit in width only
      if (t.fit > 0) {
        let w = 0;
        for (const l of lines) w = Math.max(w, ctx.measureText(l).width); // (a loop: not a spread of every line)
        if (w > 0) { const k = t.fit / w; ctx.scale(k, t.fitMode === 'aligned' ? k : 1); }
      } else if (t.widthFactor) ctx.scale(t.widthFactor, 1); // (its width factor, 41)
      // backward / upside down (a TEXT's 71): mirrored about its point
      if (t.mirrorX || t.mirrorY) ctx.scale(t.mirrorX ? -1 : 1, t.mirrorY ? -1 : 1);
      // oblique (51): slanted -- the glyphs' tops moved along the baseline by tan(angle) per unit of
      // height (y runs down here, so up is -y)
      if (t.oblique) ctx.transform(1, 0, -Math.tan(t.oblique), 1, 0, 0);
      if (t.mtext) {
        // an MTEXT block hangs from its point (top), or is centred on it (middle), or stands on it
        // (bottom): the attachment's row -- every row was drawn hanging, a dimension's value
        // (middle) half a block low, across the line it labels
        const H = (lines.length - 1) * lh + t.h;
        const y0 = t.valign === 'middle' ? -H / 2 : t.valign === 'bottom' ? -H : 0;
        ctx.textBaseline = 'top';
        lines.forEach((l, i) => ctx.fillText(l, 0, y0 + i * lh));
      } else {
        // a TEXT's vertical alignment: its baseline, bottom, middle or top on the point
        ctx.textBaseline = { bottom: 'bottom', middle: 'middle', top: 'top' }[t.valign] || 'alphabetic';
        lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1)) * lh));
      }
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawMeasure(dpr);
    if (cb.onDraw) cb.onDraw();
  }

  // 2D Measure's results, the pending point and the snap, in screen px
  function drawMeasure(dpr) {
    if (!st.measure && !st.results.length) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#9a6b00';
    ctx.fillStyle = '#9a6b00';
    ctx.font = '12px sans-serif';
    const dot = (p) => { ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, 2 * Math.PI); ctx.fill(); };
    for (const r of st.results) {
      const a = toPx(...r.a), b = toPx(...r.b);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      dot(a); dot(b);
      const t = r.text;
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const w = ctx.measureText(t).width + 8;
      ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.fillRect(m[0] - w / 2, m[1] - 18, w, 16);
      ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.fillText(t, m[0], m[1] - 6);
      ctx.fillStyle = '#9a6b00';
    }
    if (st.pending) dot(toPx(...st.pending));
    if (st.measure && st.snap) {
      const p = toPx(st.snap[0], st.snap[1]);
      ctx.beginPath(); ctx.rect(p[0] - 5, p[1] - 5, 10, 10); ctx.stroke();
    }
    ctx.restore();
  }

  // the snap point nearest css px (x, y) within 10 px, else none: by the one box tree over the
  // points (pointTree), the points and the tree built when Measure is turned on, not on its first
  // move and not at every open
  let tree = null;
  const SNAP_PX = 10;
  const snapTree = () => tree || (tree = pointTree(snapPoints(drawing.paths, o)));
  function snapAt(px, py) {
    const [ux, uy] = toUnits(px, py);
    return nearestPoint(snapTree(), ux, uy, SNAP_PX / st.s, (s) => !st.off.has(s[3]));
  }
  // the lines, indexed once for the hover and a click's layer: built just after the drawing is
  // first shown (on the first hover, 1.4 s of a 5.2-million-segment drawing came with it)
  let segIndex = null;
  const segments = () => segIndex || (segIndex = segmentIndex(drawing.paths, o, Math.max(ext.max[0] - ext.min[0], ext.max[1] - ext.min[1])));
  // (cancelled by destroy: a drawing replaced at once built its index for a view that was gone)
  const segTimer = setTimeout(() => { if (!segIndex) segments(); }, 0);
  // the texts, indexed by their drawn quads (the measured lines, once a text) on the first hover
  // that finds no line
  let txtIndex = null;
  const textsIndexed = () => txtIndex || (txtIndex = textIndex(drawing.texts, (t) => textCorners(t, linesOf(t), widthOf(t)), o));
  // 6 significant figures; a value a billionth of the drawing's size is float
  // noise (a circle centre averaged from its points), shown as 0
  const span = Math.max(ext.max[0] - ext.min[0], ext.max[1] - ext.min[1]) || 1;
  const fmt = (v) => (Math.abs(v) < span * 1e-9 ? '0' : String(Number(v.toPrecision(6))));
  function measureClick(px, py) {
    const s = snapAt(px, py);
    const p = s ? [s[0], s[1]] : toUnits(px, py);
    if (!st.pending) { st.pending = p; draw(); return null; }
    const a = st.pending, dx = p[0] - a[0], dy = p[1] - a[1];
    const d = Math.hypot(dx, dy);
    const u = units ? ` ${units}` : '';
    const r = { a, b: p, d, dx, dy, text: `${fmt(d)}${u} · ΔX ${fmt(Math.abs(dx))} · ΔY ${fmt(Math.abs(dy))}` };
    st.results.push(r);
    st.pending = null;
    draw();
    if (cb.onMeasure) cb.onMeasure(r);
    return r;
  }

  // the layer of the line nearest css px (x, y), within HIT_PX
  function layerAt(px, py) {
    const [ux, uy] = toUnits(px, py);
    const pi = nearestSegment(segments(), ux, uy, HIT_PX / st.s, (i) => !st.off.has(drawing.paths[i].layer));
    if (pi >= 0) return drawing.paths[pi].layer;
    // else a text under the point (inside its box, as the extents take it): a layer only texts
    // use could not be picked
    // (the box drawn: the text's measured lines, cut to its viewport's frame, and only when it is
    // drawn at all -- the estimate's box, uncut, picked a layer from empty sheet past a frame)
    const ti = textAt(textsIndexed(), ux, uy, (i) => {
      const t = drawing.texts[i];
      if (st.off.has(t.layer) || t.h * st.s < MIN_TEXT_PX) return false;
      return !t.clip || (ux + o[0] >= t.clip[0] && ux + o[0] <= t.clip[2] && uy + o[1] >= t.clip[1] && uy + o[1] <= t.clip[3]);
    });
    return ti >= 0 ? drawing.texts[ti].layer : null;
  }

  // ---- input ----
  const pts = new Map();
  let drag = null, pinch = null, moved = false;
  const xy = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function zoomAt(f, px, py) {
    const before = toUnits(px, py);
    st.s = Math.min(1e7, Math.max(1e-7, st.s * f));
    const after = toUnits(px, py);
    st.c = [st.c[0] + before[0] - after[0], st.c[1] + before[1] - after[1]];
    draw();
  }
  const onWheel = (e) => { e.preventDefault(); const [x, y] = xy(e); zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)), x, y); };
  const onDown = (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, xy(e));
    moved = false;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; drag = null; } else drag = xy(e);
  };
  const onMove = (e) => {
    const p = xy(e);
    if (!pts.has(e.pointerId)) {
      if (st.measure) {
        const s = snapAt(...p);
        if (s !== st.snap) { st.snap = s; draw(); if (cb.onHover) cb.onHover(s ? `${s[2]}${s[2] === 'centre' ? ` (Ø ${fmt(2 * s[4])}${units ? ` ${units}` : ''})` : ''}` : null, true); }
        return;
      }
      // hover: the layer under the pointer, un-faded
      const l = layerAt(...p);
      if (l !== st.hover) { st.hover = l; draw(); if (cb.onHover) cb.onHover(l); }
      return;
    }
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, p);
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch.d > 0) zoomAt(d / pinch.d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      pinch.d = d;
      moved = true;
      return;
    }
    if (drag) {
      const dx = p[0] - prev[0], dy = p[1] - prev[1];
      if (Math.abs(p[0] - drag[0]) + Math.abs(p[1] - drag[1]) > 3) moved = true;
      st.c = [st.c[0] - dx / st.s, st.c[1] + dy / st.s];
      draw();
    }
  };
  const onUp = (e) => {
    const p = xy(e);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (drag && !moved && pts.size === 0) { if (st.measure) measureClick(...p); else select(layerAt(...p)); }
    if (pts.size === 0) drag = null;
  };
  const onDbl = () => fit();
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('dblclick', onDbl);
  const ro = new ResizeObserver(() => draw());
  ro.observe(canvas);

  function select(layer) {
    st.selected = layer;
    draw();
    if (cb.onSelect) cb.onSelect(layer);
  }
  fit();
  return {
    fit, draw, select, layerAt, toPx: (x, y) => toPx(x - o[0], y - o[1]), zoomAt,
    get selected() { return st.selected; }, get scale() { return st.s; },
    setLayerOn(name, on) { if (on) st.off.delete(name); else st.off.add(name); draw(); },
    // 2D Measure: on / off; Esc drops a pending point first (true when it did)
    setMeasure(on) { if (on) snapTree(); st.measure = on; st.pending = null; st.snap = null; draw(); }, // (the snaps indexed as Measure turns on, not on its first move)
    get measuring() { return st.measure; },
    get results() { return st.results; },
    clearMeasure() { st.results = []; st.pending = null; draw(); },
    escapeMeasure() { if (st.pending) { st.pending = null; draw(); return true; } return false; },
    measureClick, snapAt,
    layerOn: (name) => !st.off.has(name),
    destroy() {
      clearTimeout(segTimer);
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('dblclick', onDbl);
    },
  };
}
