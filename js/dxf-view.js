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

import { MITER_LIMIT, TEXT_CAP, distinctPts, edgeOverlaps, inOutline, insideFlat, insidePieces, isBand, isWide, itemsBox, joinWedge, layersOf, onPaper, outlineIndex, pitchOf, ptSegDist2, textCorners, wrapLines } from './dxf.js';
import { PAPER, PAPER_EDGES } from './styles.js';
import { unconvertedNum, unconvertedWord } from './units.js';
import { boxTree, itemsAt, itemsIn, nearestItem } from './box-tree.js';

// a selected or faded layer's lines: the 3D paper styles' visible-edge colours
const SELECTED = PAPER_EDGES.selected[0];
const FADED = PAPER_EDGES.faded[0];
const HIT_PX = 8;
const MIN_TEXT_PX = 3; // a text under this height on screen is not drawn (and not clicked)
// the size every text is set in, then scaled to its height (r64 Q2)
const FONT_PX = 100, FONT = `${FONT_PX}px sans-serif`;

// The 2D view's one question, "the nearest item to (x, y) within r that accept() takes", by the
// viewer's one box tree (js/box-tree.js, two-dimensional here): the snaps are points (boxes of no
// size), the hover's lines segments, its texts their drawn quads. (The snaps had a 2-d tree of
// their own beside the lines' box tree; the texts had none: every one tested on a hover over
// empty sheet, 360 ms a move on a million.)

// 2D Measure's readout of a distance d (and its dx, dy) in a drawing of this unit (its id, or null)
// and size (span, drawing units): by js/units.js unconvertedNum, as the 3D panel's lengths -- in
// Auto's unit for the drawing's, by its size (a drawing in metres 0.1 m across read a 0.04 mm gap
// "0.0000 m": r90 A2), that unit's decimals where it is a display unit, else 6 significant figures
// (r89 A5, Q3); a value a billionth of the drawing's size is float noise (a circle centre averaged
// from its points), shown as 0 -- one number, written once (r92 A5)
const NOISE_2D = 1e-9;
const measureNum = (v, unit, span) => unconvertedNum(v, 'measure', unit, span, span * NOISE_2D);
export function measureText(d, dx, dy, unit, span) {
  const fmt = (v) => measureNum(v, unit, span);
  return `${lengthText(d, unit, span)} · ΔX ${fmt(Math.abs(dx))} · ΔY ${fmt(Math.abs(dy))}`;
}
// One length of 2D Measure with its unit's word, by measureText's rule: the readout and the hover's
// Ø (the hover kept a deleted formatter and threw at every circle's centre -- r91 A1)
export function lengthText(v, unit, span) {
  return `${measureNum(v, unit, span)} ${unconvertedWord(unit, span)}`;
}
// A drawing's size in its own units, from its extents: the one span 2D Measure and the 2D info read
export const drawingSpan = (ext) => (ext ? Math.max(ext.max[0] - ext.min[0], ext.max[1] - ext.min[1]) : 0) || 1;
// The 2D info panel's size row of a drawing of these extents and unit: [its label, its value], by
// 2D Measure's unit and span (pure, so a test reaches it: taking the span out passed every test --
// r91 Q3)
export function sizeRow(ext, unit) {
  const span = drawingSpan(ext);
  const n = (v) => unconvertedNum(v, 'size', unit, span);
  return [`size (${unconvertedWord(unit, span)})`, `${n(ext.max[0] - ext.min[0])} × ${n(ext.max[1] - ext.min[1])}`];
}

// The snaps: the nearest point within r that accept(point) takes. pts: snapPoints' typed set
// ({ n, xy, at(i) -> the point as an array }), the points held by the tree as they are
// (a grid sized from the extents held 397,389 points in one cell of a clustered drawing, 46 ms a move)
// (the points a tree holds: the finite ones -- one rule for the page's build and the worker's)
export function finitePointIds(xy, n) {
  const ids = new Uint32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(xy[2 * i] + xy[2 * i + 1])) ids[m++] = i;
  return ids.slice(0, m);
}
export function pointTree(pts) {
  const { n, xy, at } = pts;
  return { xy, at, tree: boxTree(xy, finitePointIds(xy, n), 2, true) };
}
// (a drawing of this many points or more has its tree built in js/snap-worker.js: r67)
export const SNAP_WORKER_MIN = 200000;
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
// whether text i's drawn quad holds (x, y): on one side of each of its edges, taken in order
export function inQuad(index, i, x, y) {
  const { Q } = index;
  let pos = 0, neg = 0;
  for (let k = 0; k < 4; k++) {
    const ax = Q[8 * i + 2 * k], ay = Q[8 * i + 2 * k + 1], bx = Q[8 * i + 2 * ((k + 1) % 4)], by = Q[8 * i + 2 * ((k + 1) % 4) + 1];
    const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cr > 0) pos++; else if (cr < 0) neg++;
  }
  return !(pos && neg);
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
  // (a band -- js/dxf.js isBand: a wide polyline, a wide polyline's filled outline -- is indexed
  // apart, below)
  // (and a fill -- a SOLID, a hatch -- is an area, hovered inside it: indexed as its edges, the
  // inside of a SOLID found nothing, and what it covered won -- r107 A3)
  const segsOf = (p) => { if (isBand(p) || p.fill) return 0; const m = p.pts.length / 2; return m === 1 || p.closed ? m : Math.max(0, m - 1); };
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
  // The bands, relative to o, in trees of their own, short and long as the lines' (one tree of them
  // all was 27 ms a hover over a million short pieces and 20,000 long: r105 Q6). A band is hovered
  // anywhere inside it: what is drawn is the band, not its centreline (r104 A3; a tapering one's
  // only near its edges, r105 A6).
  // A wide polyline as its segments (js/dxf.js distinctPts: what the canvas joins) and their half
  // width, each the rectangle the canvas strokes with flat ends and the wedge of the join at its end
  // (js/dxf.js joinWedge), made when asked: as polygons held, 243 bytes a segment and 4.5 times the
  // time of the same segments as lines -- r106 A5. Its box holds the wedge's tip.
  let nw = 0;
  for (const p of paths) if (isWide(p)) { const m = distinctPts(p.pts, p.closed).length / 2; if (m >= 2) nw += p.closed ? m : m - 1; }
  const wsegs = new Float64Array(4 * nw), wpath = new Uint32Array(nw), wnext = new Int32Array(nw), wbox = new Float64Array(4 * nw);
  const wShort = [], wLong = [];
  let w = 0;
  paths.forEach((p, pi) => {
    if (!isWide(p)) return;
    const q = distinctPts(p.pts, p.closed), m = q.length / 2, h = p.width / 2;
    if (m < 2) return;
    const k = p.closed ? m : m - 1, w0 = w;
    for (let i = 0; i < k; i++, w++) {
      const j = (i + 1) % m;
      wsegs[4 * w] = q[2 * i] - o[0]; wsegs[4 * w + 1] = q[2 * i + 1] - o[1]; wsegs[4 * w + 2] = q[2 * j] - o[0]; wsegs[4 * w + 3] = q[2 * j + 1] - o[1];
      wpath[w] = pi;
      wnext[w] = i + 1 < k ? w + 1 : p.closed ? w0 : -1;
    }
    for (let t = w0; t < w; t++) {
      let x0 = Math.min(wsegs[4 * t], wsegs[4 * t + 2]) - h, y0 = Math.min(wsegs[4 * t + 1], wsegs[4 * t + 3]) - h;
      let x1 = Math.max(wsegs[4 * t], wsegs[4 * t + 2]) + h, y1 = Math.max(wsegs[4 * t + 1], wsegs[4 * t + 3]) + h;
      const wj = wedgeAt(wsegs, wnext, t, h);
      if (wj) for (let c = 0; c < wj.length; c += 2) { x0 = Math.min(x0, wj[c]); y0 = Math.min(y0, wj[c + 1]); x1 = Math.max(x1, wj[c]); y1 = Math.max(y1, wj[c + 1]); }
      wbox[4 * t] = x0; wbox[4 * t + 1] = y0; wbox[4 * t + 2] = x1; wbox[4 * t + 3] = y1;
      if (Number.isFinite(x0 + y0 + x1 + y1)) (Math.max(x1 - x0, y1 - y0) > longest ? wLong : wShort).push(t);
    }
  });
  // An area -- every fill: a wide polyline's filled outline (a tapering one's: `outline`), a SOLID,
  // a hatch -- as itself; a hatch's loops of one even-odd id (bodd) filled together, as the canvas
  // fills them: a point in its hole is in none
  let np = 0, nc = 0;
  for (const p of paths) if (p.fill) { np++; nc += p.pts.length; }
  const bxy = new Float64Array(nc), bstart = new Uint32Array(np + 1), bpath = new Uint32Array(np), bbox = new Float64Array(4 * np);
  const bodd = new Uint32Array(np), bgroups = new Map();
  const bShort = [], bLong = [];
  let c = 0, i = 0;
  paths.forEach((p, pi) => {
    if (!p.fill) return;
    if (p.evenodd) { bodd[i] = p.evenodd; let g = bgroups.get(p.evenodd); if (!g) bgroups.set(p.evenodd, (g = [])); g.push(i); }
    const q = p.pts;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    bstart[i] = c;
    for (let k = 0; k < q.length; k += 2) {
      const qx = q[k] - o[0], qy = q[k + 1] - o[1];
      bxy[c++] = qx; bxy[c++] = qy;
      x0 = Math.min(x0, qx); y0 = Math.min(y0, qy); x1 = Math.max(x1, qx); y1 = Math.max(y1, qy);
    }
    bpath[i] = pi;
    bbox[4 * i] = x0; bbox[4 * i + 1] = y0; bbox[4 * i + 2] = x1; bbox[4 * i + 3] = y1;
    if (Number.isFinite(x0 + y0 + x1 + y1)) (Math.max(x1 - x0, y1 - y0) > longest ? bLong : bShort).push(i);
    i++;
  });
  bstart[np] = c;
  return { tree: boxTree(segs, Uint32Array.from(short)), longTree: boxTree(segs, Uint32Array.from(long)),
    wideTree: boxTree(wbox, Uint32Array.from(wShort)), wideLongTree: boxTree(wbox, Uint32Array.from(wLong)), wsegs, wpath, wnext,
    bandTree: boxTree(bbox, Uint32Array.from(bShort)), bandLongTree: boxTree(bbox, Uint32Array.from(bLong)), bxy, bstart, bpath, bbox, bodd, bgroups,
    segs, pathOf, paths, o, span, outlines: new Map(), geo: new Map() };
}
// an outline of this many points or more is asked through its grid (js/dxf.js outlineIndex)
export const OUTLINE_INDEX_MIN = 64;
// the wedge of the join at the end of wide segment t (half h: its path's), or null
function wedgeAt(wsegs, wnext, t, h) {
  const n = wnext[t];
  if (n < 0) return null;
  const ux = wsegs[4 * t + 2] - wsegs[4 * t], uy = wsegs[4 * t + 3] - wsegs[4 * t + 1], ul = Math.hypot(ux, uy);
  const vx = wsegs[4 * n + 2] - wsegs[4 * n], vy = wsegs[4 * n + 3] - wsegs[4 * n + 1], vl = Math.hypot(vx, vy);
  return joinWedge(wsegs[4 * t + 2], wsegs[4 * t + 3], ux / ul, uy / ul, vx / vl, vy / vl, h);
}
// wide segment t's rectangle as the canvas strokes it (flat ends), flat xy...
function rectAt(wsegs, t, h) {
  const ax = wsegs[4 * t], ay = wsegs[4 * t + 1], bx = wsegs[4 * t + 2], by = wsegs[4 * t + 3], L = Math.hypot(bx - ax, by - ay);
  const nx = (-(by - ay) / L) * h, ny = ((bx - ax) / L) * h;
  return Float64Array.of(ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny);
}
// The hover's PICK ORDER, the one rule for what is under the cursor (r107: decided in six places,
// it found the line drawn underneath of two at one place, a line within reach over a text drawn on
// it, nothing inside a SOLID -- A1 to A6):
//   1. The kinds: a LINE (a path neither wide nor filled: its distance to what its clip outline
//      shows of it), a BAND (a wide polyline: js/dxf.js isWide), an AREA (any fill: a SOLID, a
//      hatch -- its loops of one even-odd id together -- a tapering polyline's outline) and a TEXT
//      (its drawn quad). A band or an area is at 0 anywhere inside what its outline shows of it, a
//      text only inside its quad.
//   2. The DRAWN ORDER, higher on top: rank(pathIndex) -- the view's, its group's place in the last
//      draw then its own; by default the path's index -- lifted by EDGE_RANK for a line hit on a
//      piece along its outline's edge (the edge pass strokes those after every group), and every
//      text above every path, TEXT_RANK + textRank(i), the later in the draw on top.
//   3. U: of the bands, areas and texts under the cursor, the one on top.
//   4. With U: the nearest line within reach drawn over U, else U.
//   5. Without U: the nearest line, band or area within reach.
//   6. Of two at one distance, the one on top.
// -> { path } or { text } (the indexes), or null. index: segmentIndex's; accept(pathIndex); texts,
// when given: { index: textIndex's, accept(i), rank(i) } (rank: its place in the draw).
export const EDGE_RANK = 2 ** 50, TEXT_RANK = 2 ** 51;
export function pickAt(index, x, y, r, { accept = () => true, rank = (pi) => pi, texts = null } = {}) {
  const { segs, pathOf, paths, bxy, bstart, bpath, bbox, bodd, bgroups, o, wsegs, wpath } = index;
  const q = [x, y];
  // (a path's outline relative to o, made once)
  const clipOf = (p) => {
    if (!p.clipPoly) return null;
    let f = index.outlines.get(p.clipPoly);
    if (!f) {
      f = p.clipPoly.map((v, k) => v - o[k % 2]);
      // (a large one with its edges in a grid, js/dxf.js outlineIndex: the same answers)
      if (f.length > 2 * OUTLINE_INDEX_MIN) index.geo.set(f, outlineIndex(f));
      index.outlines.set(p.clipPoly, f);
    }
    return f;
  };
  const ins = (f, px, py) => { const g = index.geo.get(f); return g ? g.inside(px, py) : inOutline(f, px, py); };
  const pcs = (f, ax, ay, bx, by) => { const g = index.geo.get(f); return g ? g.pieces(ax, ay, bx, by) : insidePieces(f, ax, ay, bx, by); };
  // the squared distance from (x, y) to segment a-b, or to its pieces t0..t1 (insidePieces) when given
  const segD2 = (ax, ay, bx, by, pieces = null) => {
    if (!pieces) return ptSegDist2(x, y, ax, ay, bx, by);
    let d = Infinity;
    for (let k = 0; k < pieces.length; k += 2) {
      const vx = bx - ax, vy = by - ay;
      d = Math.min(d, ptSegDist2(x, y, ax + vx * pieces[k], ay + vy * pieces[k], ax + vx * pieces[k + 1], ay + vy * pieces[k + 1]));
    }
    return d;
  };
  // (each distance once a query: the ties and the areas under the cursor ask again)
  // (its map made when first asked: most hovers ask none of them)
  const once = (fn) => { let seen = null; return (i) => { if (!seen) seen = new Map(); let d = seen.get(i); if (d === undefined) { d = fn(i); seen.set(i, d); } return d; }; };
  // a line segment's nearest point the outline shows: [t along it, its squared distance] (worked
  // out again when asked again, a few at most: kept, a map entry for every segment the search
  // measured was 42 % of a hover's time -- r108)
  const lineHit = (s) => {
    const ax = segs[4 * s], ay = segs[4 * s + 1], bx = segs[4 * s + 2], by = segs[4 * s + 3];
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0;
    const d = (x - ax - t * vx) ** 2 + (y - ay - t * vy) ** 2, f = clipOf(paths[pathOf[s]]);
    // (its nearest point, if the outline shows it; else the nearest the outline shows)
    if (!f || ins(f, ax + t * vx, ay + t * vy)) return [t, d];
    const pc = pcs(f, ax, ay, bx, by);
    let bt = 0, bd = Infinity;
    for (let k = 0; k < pc.length; k += 2) {
      const u = l2 ? Math.max(pc[k], Math.min(pc[k + 1], ((x - ax) * vx + (y - ay) * vy) / l2)) : pc[k];
      const e = (x - ax - u * vx) ** 2 + (y - ay - u * vy) ** 2;
      if (e < bd) { bd = e; bt = u; }
    }
    return [bt, bd];
  };
  // (its distance alone, with no array made for a line no outline clips)
  const lineD2 = (s) => {
    const p = paths[pathOf[s]];
    if (p.clipPoly) return lineHit(s)[1];
    return ptSegDist2(x, y, segs[4 * s], segs[4 * s + 1], segs[4 * s + 2], segs[4 * s + 3]);
  };
  // a line's place in the draw at its hit: on a piece along its outline's edge, the edge pass's
  // (kept for a clipped line alone, whose edge test walks its outline; another's is its path's)
  const clippedRank = once((s) => {
    const base = rank(pathOf[s]), f = clipOf(paths[pathOf[s]]);
    const t = lineHit(s)[0], e = edgeOverlaps(f, segs[4 * s], segs[4 * s + 1], segs[4 * s + 2], segs[4 * s + 3]);
    for (let k = 0; k < e.length; k += 2) if (t >= e[k] && t <= e[k + 1]) return EDGE_RANK + base;
    return base;
  });
  const lineRank = (s) => (paths[pathOf[s]].clipPoly ? clippedRank(s) : rank(pathOf[s]));
  // a polygon's nearest point to (x, y) and its squared distance: the cursor inside it, else on its edge
  const polyNear = (q) => {
    if (insideFlat(q, x, y)) return [0, x, y];
    let d = Infinity, hx = x, hy = y;
    for (let k = 0, j = q.length - 2; k < q.length; j = k, k += 2) {
      const vx = q[k] - q[j], vy = q[k + 1] - q[j + 1], l2 = vx * vx + vy * vy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - q[j]) * vx + (y - q[j + 1]) * vy) / l2)) : 0;
      const px = q[j] + t * vx, py = q[j + 1] + t * vy, e = (x - px) ** 2 + (y - py) ** 2;
      if (e < d) { d = e; hx = px; hy = py; }
    }
    return [d, hx, hy];
  };
  // the squared distance to what outline f shows of polygons qs, hidden at their nearest point: on
  // their edges the outline shows, or on the outline's edges inside them -- the edges no nearer than
  // the best so far passed over (each edge of a 16,000-point outline, for every piece near, took a
  // hover 268 ms: r106 Q5)
  // (the outline's edges within r of the cursor, found once a query an outline: nothing farther is
  // within r)
  const nearEdges = new Map();
  const edgesNear = (f) => {
    let e = nearEdges.get(f);
    if (!e) {
      // (a large outline's by its grid: walking every edge, the hover grew as the outline -- r107 Q3)
      const g = index.geo.get(f);
      if (g) e = g.near(x, y, r);
      else { e = []; for (let k = 0, j = f.length - 2; k < f.length; j = k, k += 2) if (ptSegDist2(x, y, f[j], f[j + 1], f[k], f[k + 1]) <= r * r) e.push(j, k); }
      nearEdges.set(f, e);
    }
    return e;
  };
  const shownD2 = (qs, f) => {
    let d = Infinity;
    const fe = edgesNear(f);
    for (const q of qs) {
      for (let k = 0, j = q.length - 2; k < q.length; j = k, k += 2) {
        if (ptSegDist2(x, y, q[j], q[j + 1], q[k], q[k + 1]) >= Math.min(d, r * r)) continue;
        d = Math.min(d, segD2(q[j], q[j + 1], q[k], q[k + 1], pcs(f,q[j], q[j + 1], q[k], q[k + 1])));
      }
      for (let m = 0; m < fe.length; m += 2) {
        const j = fe[m], k = fe[m + 1];
        if (ptSegDist2(x, y, f[j], f[j + 1], f[k], f[k + 1]) >= d) continue;
        d = Math.min(d, segD2(f[j], f[j + 1], f[k], f[k + 1], insidePieces(q, f[j], f[j + 1], f[k], f[k + 1])));
      }
    }
    return d;
  };
  // a wide segment: its rectangle (flat ends: the distance across and along it) and its end's wedge
  const wideD2 = once((t) => {
    const p = paths[wpath[t]], h = p.width / 2, f = clipOf(p);
    const ax = wsegs[4 * t], ay = wsegs[4 * t + 1], L = Math.hypot(wsegs[4 * t + 2] - ax, wsegs[4 * t + 3] - ay);
    const ux = (wsegs[4 * t + 2] - ax) / L, uy = (wsegs[4 * t + 3] - ay) / L;
    const pu = (x - ax) * ux + (y - ay) * uy, pv = -(x - ax) * uy + (y - ay) * ux;
    const cu = Math.max(0, Math.min(L, pu)), cv = Math.max(-h, Math.min(h, pv));
    let d = (pu - cu) ** 2 + (pv - cv) ** 2, hx = ax + cu * ux - cv * uy, hy = ay + cu * uy + cv * ux;
    const wj = wedgeAt(wsegs, index.wnext, t, h);
    if (wj && d > 0) { const [e, ex, ey] = polyNear(wj); if (e < d) { d = e; hx = ex; hy = ey; } }
    if (!f || ins(f,hx, hy)) return d;
    return shownD2(wj ? [rectAt(wsegs, t, h), wj] : [rectAt(wsegs, t, h)], f);
  });
  // an area's loop: its distance -- 0 inside what it fills (a hatch's loops of one id even-odd
  // together: in its hole, the distance to its edges) -- to what the outline shows of it
  const loop = (i) => bxy.subarray(bstart[i], bstart[i + 1]);
  const filledAt = (i) => {
    if (!bodd[i]) return insideFlat(loop(i), x, y);
    if (!insideFlat(loop(i), x, y)) return false;
    let n = 0;
    for (const j of bgroups.get(bodd[i])) {
      if (x < bbox[4 * j] || x > bbox[4 * j + 2] || y < bbox[4 * j + 1] || y > bbox[4 * j + 3]) continue;
      if (insideFlat(loop(j), x, y)) n++;
    }
    return n % 2 === 1;
  };
  const fillD2 = once((i) => {
    const lp = loop(i), f = clipOf(paths[bpath[i]]);
    let d = 0, hx = x, hy = y;
    if (!filledAt(i)) {
      d = Infinity;
      for (let k = 0, j = lp.length - 2; k < lp.length; j = k, k += 2) {
        const vx = lp[k] - lp[j], vy = lp[k + 1] - lp[j + 1], l2 = vx * vx + vy * vy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - lp[j]) * vx + (y - lp[j + 1]) * vy) / l2)) : 0;
        const px = lp[j] + t * vx, py = lp[j + 1] + t * vy, e = (x - px) ** 2 + (y - py) ** 2;
        if (e < d) { d = e; hx = px; hy = py; }
      }
    }
    if (!f || ins(f, hx, hy)) return d;
    return shownD2([lp], f);
  });
  const lineTrees = [index.longTree, index.tree], wideTrees = [index.wideLongTree, index.wideTree], areaTrees = [index.bandLongTree, index.bandTree];
  // 3. U: the band, area or text under the cursor on top
  let U = null, uRank = -Infinity;
  const under = (rk, hit) => { if (rk > uRank) { uRank = rk; U = hit; } };
  for (const t of wideTrees) if (t.m) itemsAt(t, q, (i) => { if (wideD2(i) === 0 && accept(wpath[i])) under(rank(wpath[i]), { path: wpath[i] }); });
  for (const t of areaTrees) if (t.m) itemsAt(t, q, (i) => { if (fillD2(i) === 0 && accept(bpath[i])) under(rank(bpath[i]), { path: bpath[i] }); });
  if (texts && texts.index.tree.m) itemsAt(texts.index.tree, q, (i) => { if (inQuad(texts.index, i, x, y) && texts.accept(i)) under(TEXT_RANK + (texts.rank ? texts.rank(i) : i), { text: i }); });
  // 4, 5: the nearest line within reach -- drawn over U, when there is one -- and without U the
  // nearest band and area too
  // (with nothing under the cursor every line is over it: no rank asked)
  const lineOK = U === null ? (k) => accept(pathOf[k]) : (k) => accept(pathOf[k]) && lineRank(k) > uRank;
  // (the least distance the searches met and how many paths met it: a nearest search visits every
  // item at its best distance, so with one path there no tie can change the answer, and step 6's
  // walk is passed over. Counted by items, two segments of one path at the vertex they share -- a
  // polyline's nearest point, often -- walked it on 8,676 of 20,000 hovers, 46 % of their time: r108)
  let least = Infinity, times = 0, leastPath = -1;
  const met = (d, pi) => { if (d < least) { least = d; times = 1; leastPath = pi; } else if (d === least && pi !== leastPath) times++; };
  // (one plain function a kind, not one made by a wrapper: the engine inlines these)
  const lineCounted = (k) => { const d = lineD2(k); if (d <= least) met(d, pathOf[k]); return d; };
  const s = nearestItem(lineTrees, q, r, lineCounted, lineOK);
  // 6. of everything at distance d (lines alone, over U), the one on top
  const topAt = (d, linesOnly) => {
    const e = Math.sqrt(d) * (1 + 1e-9) + 1e-12, lo = [x - e, y - e], hi = [x + e, y + e];
    let best = null, br = -Infinity;
    const take = (rk, hit) => { if (rk > br) { br = rk; best = hit; } };
    for (const t of lineTrees) if (t.m) itemsIn(t, lo, hi, (k) => { if (lineD2(k) === d && lineOK(k)) take(lineRank(k), { path: pathOf[k] }); });
    if (!linesOnly) {
      for (const t of wideTrees) if (t.m) itemsIn(t, lo, hi, (i) => { if (wideD2(i) === d && accept(wpath[i])) take(rank(wpath[i]), { path: wpath[i] }); });
      for (const t of areaTrees) if (t.m) itemsIn(t, lo, hi, (i) => { if (fillD2(i) === d && accept(bpath[i])) take(rank(bpath[i]), { path: bpath[i] }); });
    }
    return best;
  };
  const alone = (d) => least === d && times === 1;
  if (U) return s < 0 ? U : alone(lineD2(s)) ? { path: pathOf[s] } : topAt(lineD2(s), true);
  const w1 = nearestItem(wideTrees, q, r, (t) => { const e = wideD2(t); if (e <= least) met(e, wpath[t]); return e; }, (t) => accept(wpath[t]));
  const w2 = nearestItem(areaTrees, q, r, (i) => { const e = fillD2(i); if (e <= least) met(e, bpath[i]); return e; }, (i) => accept(bpath[i]));
  const ds = s < 0 ? Infinity : lineD2(s), d1 = w1 < 0 ? Infinity : wideD2(w1), d2 = w2 < 0 ? Infinity : fillD2(w2);
  const d = Math.min(ds, d1, d2);
  if (d === Infinity) return null;
  if (alone(d)) return { path: d === ds ? pathOf[s] : d === d1 ? wpath[w1] : bpath[w2] };
  return topAt(d, false);
}
// -> the path index pickAt finds (its rule) among the paths alone, or -1
export function nearestSegment(index, x, y, r, accept = () => true, rank = (pi) => pi) {
  const p = pickAt(index, x, y, r, { accept, rank });
  return p && p.path !== undefined ? p.path : -1;
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
// the centre of each path the reader drew from a circle (its `circle` mark: js/dxf.js, a CIRCLE, a
// polyline or hatch boundary of arcs about one centre, a ratio-1 ELLIPSE). -> a typed set { n, xy, kind, path, r, at(i) -> [x, y, kind, layer, radius?] }
// (a JS array a snap held 808 MB for 9 M of them, built at every open: the view builds the set
// when Measure is first turned on)
const SNAP_KINDS = ['end', 'middle', 'centre', 'quadrant'];
// The circle through m points of q (x, y pairs), least squares (Kåsa), taken about their mean; null
// when they lie on a line. Exact for points on a circle, however unevenly they are spaced.
export function circleThrough(q, m) {
  let mx = 0, my = 0;
  for (let i = 0; i < m; i++) { mx += q[i * 2]; my += q[i * 2 + 1]; }
  mx /= m; my /= m;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < m; i++) {
    const u = q[i * 2] - mx, v = q[i * 2 + 1] - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (!(Math.abs(det) > 1e-18 * (suu + svv) ** 2)) return null;
  const a = (suuu + suvv) / 2, b = (svvv + svuu) / 2;
  const uc = (a * svv - b * suv) / det, vc = (b * suu - a * suv) / det;
  let r = 0;
  for (let i = 0; i < m; i++) r += Math.hypot(q[i * 2] - mx - uc, q[i * 2 + 1] - my - vc);
  return { x: mx + uc, y: my + vc, r: r / m };
}
export function snapPoints(paths, o) {
  let cap = 0;
  for (const p of paths) if (!p.outline) cap += p.pts.length + 6; // (at most 2 a point, a centre and four quadrants)
  // (a radius only for a centre, a few of them: kept aside, not a number a snap)
  const xy = new Float64Array(2 * cap), kind = new Uint8Array(cap), path = new Uint32Array(cap), rad = new Map();
  let n = 0;
  const put = (x, y, k, pi, r = 0) => { xy[2 * n] = x - o[0]; xy[2 * n + 1] = y - o[1]; kind[n] = k; path[n] = pi; if (k === 2) rad.set(n, r); n++; };
  // (a closed path's last point often repeats its first: counted once)
  const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  paths.forEach((p, pi) => {
    if (p.outline) return; // (a wide polyline's outline: its corners are not its ends)
    const n2 = p.pts.length / 2, q = p.pts;
    // (seen through a clip outline, whole: its points the outline shows, no other -- js/dxf.js
    // inOutline, the one question the page asks of an outline; the canvas clips what is drawn: r103)
    const shown = p.clipPoly ? (x, y) => inOutline(p.clipPoly, x, y) : () => true;
    const at = (x, y, k) => { if (shown(x, y)) put(x, y, k, pi); };
    const mid = (i, j) => at((q[i * 2] + q[j * 2]) / 2, (q[i * 2 + 1] + q[j * 2 + 1]) / 2, 1);
    const m = n2 > 1 && same(q[0], q[(n2 - 1) * 2]) && same(q[1], q[(n2 - 1) * 2 + 1]) ? n2 - 1 : n2;
    if (p.own) {
      // a curve's maker marked its own points (js/dxf.js arcPts, bulgePts): its ends and vertices,
      // a straight span's middle, an arc's middle on the arc -- every chord's end and middle of its
      // drawing were offered, inside the curve, "middle" 0.95 off a radius-1000 arc (r113 R2-F3)
      const own = p.own;
      for (let k = 0; k < own.length; k++) {
        if (k > 0 && own[k] === own[k - 1] + 1) mid(own[k - 1], own[k]);
        if (own[k] < m || !p.closed) at(q[own[k] * 2], q[own[k] * 2 + 1], 0); // (a closed one's repeated first point once)
      }
      for (const i of p.mids) at(q[i * 2], q[i * 2 + 1], 1);
      // a closed curve of no own point (a whole ellipse, a closed spline, a circle, a hatch loop of
      // arcs): its four extreme points, on the curve -- r113's marks left it no snap at all, 690 of
      // one drawing's closed paths (r114 R4-M1)
      // (a circle's exact: its fitted centre plus and minus its radius -- the nearest 5° sample was
      // up to 4.4 % of the radius off on a circle an insert turned: r115 R5-M2)
      const round = p.closed && !own.length && p.circle && m >= 3 ? circleThrough(q, m) : null;
      if (round && round.r > 0) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) at(round.x + dx * round.r, round.y + dy * round.r, 3);
      } else if (p.closed && !own.length && m >= 4) {
        let a = 0, b = 0, c = 0, d = 0;
        for (let i = 1; i < m; i++) {
          if (q[i * 2] < q[a * 2]) a = i;
          if (q[i * 2] > q[b * 2]) b = i;
          if (q[i * 2 + 1] < q[c * 2 + 1]) c = i;
          if (q[i * 2 + 1] > q[d * 2 + 1]) d = i;
        }
        for (const i of new Set([a, b, c, d])) at(q[i * 2], q[i * 2 + 1], 3);
      }
    } else {
      for (let i = 0; i < n2; i++) {
        at(q[i * 2], q[i * 2 + 1], 0);
        if (i + 1 < n2) mid(i, i + 1);
      }
      if (p.closed && m === n2 && n2 > 2) mid(n2 - 1, 0);
    }
    // (a centre with its Ø only for what the reader drew from a circle: a 12-gon or a 16-gon hovered
    // as "centre (Ø 20.000)", an ellipse 10 x 9.85 as Ø 19.850 -- r70 Q6)
    // (the mark alone decides: the old 1 % roundness test and its 12 points stayed after r70 Q6 made
    // the mark the rule, a fourth 0.01 beside RADIUS_TOL -- r71 A8)
    // (its centre the circle through its points, not their mean: drawn as arcs of different sweeps,
    // a 1° + 359° circle was sampled unevenly and its mean put the centre 0.24 off, Ø 19.991 for 20 --
    // r72 A3. A least-squares fit, about their mean for the numbers' sake, is the circle itself)
    // (through a clip outline, only a circle it shows every point of, and its centre: one it cuts is
    // no whole circle, as one a frame cuts is not -- r98 Q4)
    let whole = !p.clipPoly;
    if (!whole) { whole = true; for (let i = 0; i < n2 && whole; i++) whole = shown(q[i * 2], q[i * 2 + 1]); }
    if (p.closed && p.circle && m >= 3 && whole) {
      const c = circleThrough(q, m);
      if (c && c.r > 0 && shown(c.x, c.y)) put(c.x, c.y, 2, pi, c.r);
    } else if (p.centre && whole && shown(p.centre[0], p.centre[1])) put(p.centre[0], p.centre[1], 2, pi, 0); // (an ellipse's: no Ø -- r114 R4-M1)
  });
  // (the same array for the same snap, so a hover that stays on it is no change: those made kept,
  // a few thousand at most)
  const made = new Map();
  const at = (i) => {
    let s = made.get(i);
    if (!s) {
      if (made.size > 4096) made.clear();
      s = [xy[2 * i], xy[2 * i + 1], SNAP_KINDS[kind[i]], paths[path[i]].layer, ...(kind[i] === 2 ? [rad.get(i)] : [])];
      if (paths[path[i]].hold) s.hold = paths[path[i]].hold; // (and the frozen layers it is held to: r64 Q1)
      made.set(i, s);
    }
    return s;
  };
  return { n, xy: xy.subarray(0, 2 * n), kind: kind.subarray(0, n), path: path.subarray(0, n), r: rad, at };
}

export function createDxfView(canvas, drawing, cb = {}) {
  const ctx = canvas.getContext('2d');
  const ext = drawing.extents || { min: [0, 0], max: [1, 1] };
  const o = [(ext.min[0] + ext.max[0]) / 2, (ext.min[1] + ext.max[1]) / 2];
  const st = { s: 1, c: [0, 0], selected: null, hover: null, off: new Set(drawing.layers.filter((l) => !l.on).map((l) => l.name)),
    measure: false, pending: null, results: [], snap: null };
  // an item not shown: its layer off, or a frozen layer of a block reference it is drawn under
  // (js/dxf.js layersOf / hold: a reference on a frozen layer draws none of its block -- r64 Q1)
  const hid = (it) => layersOf(it).some((n) => st.off.has(n));
  // a clip outline (flat, xy...) as a closed Path2D relative to o, and a number to group by: once each
  const outlines = new Map();
  const outlineOf = (f) => {
    let r = outlines.get(f);
    if (!r) {
      const path = new Path2D();
      for (let k = 0; k < f.length; k += 2) (k ? path.lineTo : path.moveTo).call(path, f[k] - o[0], f[k + 1] - o[1]);
      path.closePath();
      r = { id: outlines.size + 1, path };
      outlines.set(f, r);
    }
    return r;
  };
  const outlineId = (f) => outlineOf(f).id;
  // the paths, grouped, relative to o
  const groups = new Map();
  // (each path's group, and each group's place in the last draw: which of two is on top)
  const groupOfPath = new Array(drawing.paths.length), drawnAt = new Map();
  for (let pi = 0; pi < drawing.paths.length; pi++) {
    const p = drawing.paths[pi];
    // (and by the clip outline it is seen through, if any: the group is drawn clipped to it, r103)
    const key = `${p.layer}\u0000${p.hold ? p.hold.join('\u0001') : ''}\u0000${p.colour.r},${p.colour.g},${p.colour.b},${p.colour.aci}\u0000${p.fill ? 1 : 0}\u0000${p.dash ? p.dash.join(',') : ''}\u0000${p.weight ?? ''}\u0000${p.width || ''}\u0000${p.evenodd || ''}\u0000${p.clipPoly ? outlineId(p.clipPoly) : ''}`;
    let g = groups.get(key);
    // a line weight in mm shows as 4 px a mm on screen, at least 1 px; a polyline's width is in
    // drawing units (it scales with the zoom, as on paper)
    if (!g) { g = { layer: p.layer, hold: p.hold, colour: onPaper(p.colour), fill: p.fill, dash: p.dash || null, px: p.weight ? Math.max(1, p.weight * 4) : 1, width: p.width || 0, evenodd: !!p.evenodd, clipPoly: p.clipPoly || null, clipId: p.clipPoly ? outlineId(p.clipPoly) : 0, path: new Path2D(), points: [] }; groups.set(key, g); }
    groupOfPath[pi] = g;
    if (p.point) { g.points.push(p.pts[0] - o[0], p.pts[1] - o[1]); continue; }
    // (a fill not a hatch's even-odd loops is added counter-clockwise: the group's fills are one
    // non-zero path, and two overlapping SOLIDs wound opposite ways left their overlap empty)
    const n = p.pts.length / 2;
    const rev = addedReversed(p);
    const at = (i) => (rev ? n - 1 - i : i);
    g.path.moveTo(p.pts[2 * at(0)] - o[0], p.pts[2 * at(0) + 1] - o[1]);
    for (let i = 1; i < n; i++) g.path.lineTo(p.pts[2 * at(i)] - o[0], p.pts[2 * at(i) + 1] - o[1]);
    if (p.closed) g.path.closePath();
    // (its segments lying along its outline's edges -- both ends and three points between on one --
    // stroked again unclipped, the clip having cut their outer half: r103 Q3. A hairline's alone: a
    // wide polyline's band is on paper and clipped there, and stroked again it spilled half its width
    // onto the sheet -- r104 A2)
    // (a wide polyline's too: drawn thinner than its px -- zoomed out, or under a layer's weight --
    // it is a hairline the clip halves, and the edge pass takes it then: r110 F1)
    if (p.clipPoly && !p.fill) {
      const segs = p.closed ? n : n - 1;
      let along = 0; // (the length along the path to segment i's start: where its dashes stand)
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n, ax = p.pts[2 * i], ay = p.pts[2 * i + 1], bx = p.pts[2 * j], by = p.pts[2 * j + 1];
        const L = Math.hypot(bx - ax, by - ay);
        // (only the pieces along an edge: js/dxf.js edgeOverlaps, r104 Q1, Q2)
        const t = edgeOverlaps(p.clipPoly, ax, ay, bx, by);
        for (let k = 0; k < t.length; k += 2) {
          if (!g.edge) { g.edge = new Path2D(); g.edgePieces = []; }
          const x0 = ax + (bx - ax) * t[k] - o[0], y0 = ay + (by - ay) * t[k] - o[1], x1 = ax + (bx - ax) * t[k + 1] - o[0], y1 = ay + (by - ay) * t[k + 1] - o[1];
          g.edge.moveTo(x0, y0);
          g.edge.lineTo(x1, y1);
          // (and where along the path it starts: a dashed one's pieces are dashed in its phase, each
          // a subpath of its own restarting the pattern -- r105 Q5)
          g.edgePieces.push(x0, y0, x1, y1, along + L * t[k]);
        }
        along += L;
      }
    }
  }
  // the texts, those seen through one outline together (stable: in the drawing's order otherwise)
  const textOrder = drawing.texts.map((t, i) => [t.clipPoly ? outlineId(t.clipPoly) : 0, i, t]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  // (each text's place in that draw: the later on top, which the hover reads -- r107 A6)
  const textAtDraw = new Map(textOrder.map((t, k) => [t, k]));
  const css = () => [canvas.clientWidth || 1, canvas.clientHeight || 1];

  // a text's lines as drawn: an MTEXT with a reference width wrapped at it by the font's measure
  // (js/dxf.js wrapLines), once per text -- what is drawn and what a click finds
  // (every text is set in FONT_PX and scaled to its height: set in drawing units, a 0.0025-unit
  // text -- 2.5 mm in a metre drawing -- had no ink at any zoom, the canvas keeping no font that
  // small, a 0.1-unit one measured 6% narrow, and fonts stop at 10,000 px: r64 Q2)
  const wrapped = new WeakMap();
  // a text's em in drawing units, so the font's own capitals are its height: their share of the em
  // measured once in this canvas's font (sans-serif differs by platform: 0.69 to 0.73), js/dxf.js's
  // TEXT_CAP where the canvas cannot say (r113 R2-F1)
  let capShare = 0;
  const emView = (t) => {
    if (!capShare) {
      ctx.save(); ctx.font = FONT;
      const m = ctx.measureText('H');
      ctx.restore();
      capShare = m && m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent / FONT_PX : TEXT_CAP;
    }
    return t.h / capShare;
  };
  const linesOf = (t) => {
    if (!(t.mtext && t.wrap > 0)) return t.text.split('\n');
    let w = wrapped.get(t);
    if (!w) {
      ctx.save(); ctx.font = FONT;
      w = wrapLines(t.text.split('\n'), (l) => ctx.measureText(l).width * (emView(t) / FONT_PX) * (t.widthFactor || 1), t.wrap);
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
      ctx.save(); ctx.font = FONT;
      w = 0;
      for (const l of linesOf(t)) w = Math.max(w, ctx.measureText(l).width * (emView(t) / FONT_PX) * (t.widthFactor || 1));
      ctx.restore();
      widths.set(t, w);
    }
    return w;
  };

  // What Fit frames: the drawing's extents (frozen layers left out, as Zoom Extents leaves them) while
  // every frozen layer is still off; with one the visitor turned on, what its layers then show too --
  // Fit framed the opening extents always, and 158 of 022-FORKLIFT's 159 ASHADE items fell outside
  // its frame once that layer was on (r66 Q3)
  const frozen = drawing.layers.filter((l) => l.frozen).map((l) => l.name), frozenSet = new Set(frozen);
  const framed = new Map(); // (by the frozen layers on: one box each)
  const frame = () => {
    const on = frozen.filter((n) => !st.off.has(n));
    if (!on.length) return ext;
    const key = on.join('\u0000');
    if (!framed.has(key)) {
      // (by a Set: the array searched per item took 6.7 s on 1 M paths of 5,000 frozen layers -- r67 A4)
      const keep = (it) => layersOf(it).every((n) => !frozenSet.has(n) || !st.off.has(n));
      framed.set(key, itemsBox({ paths: drawing.paths.filter(keep), texts: drawing.texts.filter(keep) }) || ext);
    }
    return framed.get(key);
  };
  function fit() {
    const [w, h] = css();
    const e = frame();
    const dx = e.max[0] - e.min[0] || 1, dy = e.max[1] - e.min[1] || 1;
    st.s = Math.min(w / dx, h / dy) * 0.92;
    st.c = [(e.min[0] + e.max[0]) / 2 - o[0], (e.min[1] + e.max[1]) / 2 - o[1]];
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
    const sel = st.selected;
    // (an item is a layer's when it answers to it: its own, or a frozen reference's it is drawn under
    // -- the layer list's rule, js/dxf.js layersOf; the selection lit only an item's own, and a frozen
    // layer's 461 items were drawn faded when it was selected: r66 A1, Q2)
    const isOf = (it, n) => n != null && layersOf(it).includes(n);
    // (the selected layer last, on top; and those seen through one outline together)
    const order = [...groups.values()].sort((a, b) => isOf(a, sel) - isOf(b, sel) || a.clipId - b.clipId);
    order.forEach((g, i) => drawnAt.set(g, i));
    // (seen through a viewport's clip outline: the canvas clips it there, even-odd -- the rule
    // inOutline keeps for the snaps and the hover; cut here by hand, rounds 99 to 102 each found an
    // outline the cut got wrong: r103. Clipped once for all its groups and texts in a draw: once
    // each, 280 groups through a 16,000-point outline took 9.2 s a draw -- r103 Q2)
    // a group's stroke: its colour, width, ends, joins and dashes -- one setting for the clipped pass
    // and the edge pass (the edge pass set no ends or joins, and took the last group's: r104 A2)
    const strokeOf = (g) => {
      const hot = isOf(g, sel) || isOf(g, st.hover);
      const col = isOf(g, sel) ? SELECTED : sel && !isOf(g, st.hover) ? FADED : g.colour;
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max((g.px + (hot ? 1 : 0)) / st.s, g.width);
      // a wide polyline ends flat and meets mitred, as on paper (rounded, it reached half its width
      // past each end); a hairline stays round
      const wide = g.width > (g.px + (hot ? 1 : 0)) / st.s;
      ctx.lineCap = wide ? 'butt' : 'round';
      ctx.lineJoin = wide ? 'miter' : 'round';
      // (the mitre's limit js/dxf.js bandPolys shapes a band by: the keep test, the extents and the
      // hover read the corner drawn -- r105 A2)
      ctx.miterLimit = MITER_LIMIT;
      // a line type's dashes are drawing units (under the transform): they
      // scale with the zoom, as on paper; too fine to see, drawn solid
      const dashed = !!g.dash && g.dash.reduce((a, x) => a + x, 0) * st.s > 3;
      ctx.setLineDash(dashed ? g.dash : []);
      return { hot, col, dashed, wide };
    };
    let cur = null;
    const clipTo = (f) => {
      if (f === cur) return;
      if (cur) ctx.restore();
      cur = f;
      if (f) { ctx.save(); ctx.clip(outlineOf(f).path, 'evenodd'); }
    };
    for (const g of order) {
      if (hid(g)) continue;
      clipTo(g.clipPoly);
      const { hot, col } = strokeOf(g);
      if (g.fill) { ctx.fillStyle = col; ctx.globalAlpha = sel && !hot ? 0.35 : 0.85; ctx.fill(g.path, g.evenodd ? 'evenodd' : 'nonzero'); ctx.globalAlpha = 1; }
      ctx.stroke(g.path);
      ctx.setLineDash([]);
      if (g.points.length) {
        ctx.fillStyle = col;
        const r = 1.5 / st.s;
        for (let i = 0; i < g.points.length; i += 2) ctx.fillRect(g.points[i] - r, g.points[i + 1] - r, 2 * r, 2 * r);
      }
    }
    // (a line lying on its outline's edge, stroked again unclipped: the clip cut the outer half of
    // its stroke, and a wall on a frame drew 640 px of its 1,288 -- r103 Q3)
    clipTo(null);
    for (const g of order) {
      if (!g.edge || hid(g)) continue;
      const { dashed, wide } = strokeOf(g);
      // (a band drawn at its width is on paper and clipped there: stroked again unclipped, half its
      // width spilled onto the sheet -- r104 A2; drawn as a hairline, it is one -- r110 F1)
      if (wide) { ctx.setLineDash([]); continue; }
      // (ends flat: a piece ends where its edge does, at a corner or a notch, and a round end drew
      // half a line past it, outside the outline -- r105 Q12)
      ctx.lineCap = 'butt';
      if (!dashed) ctx.stroke(g.edge);
      else {
        // (dashed: each piece at its place in the pattern, as the clipped pass dashes its other half)
        const e = g.edgePieces;
        for (let k = 0; k < e.length; k += 5) {
          ctx.lineDashOffset = e[k + 4];
          ctx.beginPath(); ctx.moveTo(e[k], e[k + 1]); ctx.lineTo(e[k + 2], e[k + 3]); ctx.stroke();
        }
        ctx.lineDashOffset = 0;
      }
      ctx.setLineDash([]);
    }
    // text: native, upright in its own frame
    for (const t of textOrder) {
      if (hid(t)) continue;
      const px = t.h * st.s;
      if (px < MIN_TEXT_PX) continue; // too small to read: left out
      // (a text seen through a layout viewport, clipped to its outline -- a frame's four points, or
      // the outline of a viewport clipped to one: by its box alone, a text in an L's notch was drawn,
      // r99 Q2 -- even-odd, by the one Path2D its paths are clipped by: by canvas's nonzero default,
      // a text was painted in a star's middle, where they had none, r102 A1; once for all its texts)
      clipTo(t.clipPoly || null);
      ctx.save();
      ctx.translate(t.x - o[0], t.y - o[1]);
      ctx.rotate(t.rot);
      // (in the font's own px from here, scaled so its capitals are the text's height: emView --
      // the em set to the height drew every text 31 % small, r113 R2-F1)
      const k0 = emView(t) / FONT_PX;
      ctx.scale(k0, -k0);
      ctx.fillStyle = isOf(t, sel) ? SELECTED : sel && !isOf(t, st.hover) ? FADED : onPaper(t.colour);
      ctx.font = FONT;
      ctx.textAlign = t.align;
      // (an MTEXT with a reference width wraps at it, measured in the font -- js/dxf.js wrapLines;
      // made once per text, as the font's width does not change with the zoom; kept here, not in
      // the drawing)
      const lines = linesOf(t);
      const lh = pitchOf(t) / k0; // (5/3 of its height, times its 44: js/dxf.js pitchOf -- r113 R2-F2)
      // aligned / fit (js/dxf.js): the text fitted to its baseline's length -- aligned in both
      // directions, fit in width only
      if (t.fit > 0) {
        let w = 0;
        for (const l of lines) w = Math.max(w, ctx.measureText(l).width); // (a loop: not a spread of every line)
        if (w > 0) { const k = t.fit / k0 / w; ctx.scale(k, t.fitMode === 'aligned' ? k : 1); }
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
        const H = (lines.length - 1) * lh + FONT_PX;
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
    clipTo(null);
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
  // (a large drawing's tree built in a worker -- js/snap-worker.js --, the page answering meanwhile and
  // snapping nothing until it is in; built here, the 1.5 million paths of 091-FEDERAL_POLY_ILARO held
  // the page 1.6 s as Measure turned on: round 28 Q7, carried open, r67. A small one, or no worker:
  // here, at once.)
  // (gone: destroyed. Every 2D view draws on the one #view2d canvas, so a view replaced while its
  // tree was built -- the Sheet changed, another drawing opened -- painted its drawing over the
  // next view's when the tree came: destroy ends the worker, and an answer after is dropped: r68)
  let building = false, gone = false, worker = null;
  const buildSnaps = () => {
    if (tree || building || gone) return;
    const pts = snapPoints(drawing.paths, o);
    if (pts.n < SNAP_WORKER_MIN || typeof Worker === 'undefined') { tree = pointTree(pts); return; }
    let w;
    try { w = new Worker(new URL('./snap-worker.js', import.meta.url), { type: 'module' }); } catch { tree = pointTree(pts); return; }
    building = true;
    worker = w;
    const done = (t) => { if (gone) return; building = false; worker = null; tree = t; w.terminate(); if (st.measure) draw(); };
    w.onmessage = (e) => done({ xy: pts.xy, at: pts.at, tree: e.data });
    w.onerror = () => done(pointTree(pts));
    const ids = finitePointIds(pts.xy, pts.n);
    w.postMessage({ xy: pts.xy, ids }, [ids.buffer]);
  };
  const snapTree = () => { if (!tree) buildSnaps(); return tree; };
  function snapAt(px, py) {
    const [ux, uy] = toUnits(px, py);
    const t = snapTree();
    if (!t) return null; // (its tree still being built: no snap yet, the click measuring where it is)
    return nearestPoint(t, ux, uy, SNAP_PX / st.s, (s) => !hid({ layer: s[3], hold: s.hold }));
  }
  // the lines, indexed once for the hover and a click's layer: built just after the drawing is
  // first shown (on the first hover, 1.4 s of a 5.2-million-segment drawing came with it)
  let segIndex = null;
  // (the drawing's one span, drawingSpan: 2D Measure's and the hover's -- r92 A5)
  const span = drawingSpan(ext);
  const segments = () => segIndex || (segIndex = segmentIndex(drawing.paths, o, span));
  // (cancelled by destroy: a drawing replaced at once built its index for a view that was gone)
  const segTimer = setTimeout(() => { if (!segIndex) segments(); }, 0);
  // the texts, indexed by their drawn quads (the measured lines, once a text) on the first hover
  // that finds no line
  let txtIndex = null;
  const textsIndexed = () => txtIndex || (txtIndex = textIndex(drawing.texts, (t) => textCorners(t, linesOf(t), widthOf(t)), o));
  function measureClick(px, py) {
    const s = snapAt(px, py);
    const p = s ? [s[0], s[1]] : toUnits(px, py);
    if (!st.pending) { st.pending = p; draw(); return null; }
    const a = st.pending, dx = p[0] - a[0], dy = p[1] - a[1];
    const d = Math.hypot(dx, dy);
    const r = { a, b: p, d, dx, dy, text: measureText(d, dx, dy, drawing.units, span) };
    st.results.push(r);
    st.pending = null;
    draw();
    if (cb.onMeasure) cb.onMeasure(r);
    return r;
  }

  // the layer of the line nearest css px (x, y), within HIT_PX
  function layerAt(px, py) {
    const [ux, uy] = toUnits(px, py);
    // (what is drawn on top there, by pickAt's one rule: the draw's order -- a path's group's place in
    // the last draw then its own, a text's place in textOrder -- and what is drawn of each: a path
    // through a clip outline hit only where the outline shows it, r103 A4)
    const n = drawing.paths.length;
    const rank = (i) => (drawnAt.get(groupOfPath[i]) ?? 0) * n + i;
    const texts = { index: textsIndexed(), rank: (i) => textAtDraw.get(drawing.texts[i]),
      // (a text drawn: big enough, inside its viewport's frame and outline -- js/dxf.js's one test:
      // r100 A5, r103)
      accept: (i) => {
        const t = drawing.texts[i];
        if (hid(t) || t.h * st.s < MIN_TEXT_PX) return false;
        if (t.clip && !(ux + o[0] >= t.clip[0] && ux + o[0] <= t.clip[2] && uy + o[1] >= t.clip[1] && uy + o[1] <= t.clip[3])) return false;
        return !t.clipPoly || inOutline(t.clipPoly, ux + o[0], uy + o[1]);
      } };
    const hit = pickAt(segments(), ux, uy, HIT_PX / st.s, { accept: (i) => !hid(drawing.paths[i]), rank, texts });
    return !hit ? null : hit.text !== undefined ? drawing.texts[hit.text].layer : drawing.paths[hit.path].layer;
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
        if (s !== st.snap) { st.snap = s; draw(); if (cb.onHover) cb.onHover(s ? `${s[2]}${s[2] === 'centre' && s[4] > 0 ? ` (Ø ${lengthText(2 * s[4], drawing.units, span)})` : ''}` : null, true); }
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
  // (the pointer gone, the hover and the snap go: the picture and the print are the canvas as last
  // drawn, and the last layer hovered stayed 1 px wider and un-faded in them -- r106 A2)
  const onLeave = () => {
    if (pts.size || (!st.snap && st.hover === null)) return;
    const snap = !!st.snap, hover = st.hover !== null;
    st.snap = null; st.hover = null;
    draw(); // (once for both: r107 Q10)
    if (cb.onHover) { if (snap) cb.onHover(null, true); if (hover) cb.onHover(null); }
  };
  const onDbl = () => fit();
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('dblclick', onDbl);
  canvas.addEventListener('pointerleave', onLeave);
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
    // (and the layer last hovered let go: it stayed lit while Measure was on -- r107 A9)
    setMeasure(on) { if (on) snapTree(); st.measure = on; st.pending = null; st.snap = null; if (st.hover !== null) { st.hover = null; if (cb.onHover) cb.onHover(null); } draw(); }, // (the snaps indexed as Measure turns on, not on its first move)
    get measuring() { return st.measure; },
    get results() { return st.results; },
    clearMeasure() { st.results = []; st.pending = null; draw(); },
    escapeMeasure() { if (st.pending) { st.pending = null; draw(); return true; } return false; },
    measureClick, snapAt,
    layerOn: (name) => !st.off.has(name),
    destroy() {
      gone = true;
      if (worker) { worker.terminate(); worker = null; }
      clearTimeout(segTimer);
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('pointerleave', onLeave);
    },
  };
}
