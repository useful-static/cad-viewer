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

// a selected or faded layer's lines: the 3D paper styles' visible-edge colours
const SELECTED = PAPER_EDGES.selected[0];
const FADED = PAPER_EDGES.faded[0];
const HIT_PX = 8;
const MIN_TEXT_PX = 3; // a text under this height on screen is not drawn (and not clicked)

// whether a path is added to its group reversed: a fill (not a hatch's even-odd loops) wound
// clockwise, so every such fill runs counter-clockwise and a group's non-zero fill is their union
export function addedReversed(p) {
  if (!p.fill || p.evenodd) return false;
  const n = p.pts.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += p.pts[2 * i] * p.pts[2 * j + 1] - p.pts[2 * j] * p.pts[2 * i + 1]; }
  return a < 0;
}

export function createDxfView(canvas, drawing, cb = {}) {
  const ctx = canvas.getContext('2d');
  const ext = drawing.extents || { min: [0, 0], max: [1, 1] };
  const o = [(ext.min[0] + ext.max[0]) / 2, (ext.min[1] + ext.max[1]) / 2];
  const st = { s: 1, c: [0, 0], selected: null, hover: null, off: new Set(drawing.layers.filter((l) => !l.on).map((l) => l.name)),
    measure: false, pending: null, results: [], snap: null };
  // 2D Measure's snap points (drawing units, relative to o): every line end,
  // every segment's middle, and the centre of each closed path that is a
  // circle (its points all within 1 % of one distance from their mean)
  const snaps = [];
  for (const p of drawing.paths) {
    if (p.outline) continue; // (a wide polyline's outline: its corners are not its ends)
    const n = p.pts.length / 2;
    for (let i = 0; i < n; i++) {
      snaps.push([p.pts[i * 2] - o[0], p.pts[i * 2 + 1] - o[1], 'end', p.layer]);
      if (i + 1 < n) snaps.push([(p.pts[i * 2] + p.pts[i * 2 + 2]) / 2 - o[0], (p.pts[i * 2 + 1] + p.pts[i * 2 + 3]) / 2 - o[1], 'middle', p.layer]);
    }
    // (a closed path's last point often repeats its first: counted once)
    const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
    const m = n > 1 && same(p.pts[0], p.pts[(n - 1) * 2]) && same(p.pts[1], p.pts[(n - 1) * 2 + 1]) ? n - 1 : n;
    if (p.closed && m >= 12) {
      let cx = 0, cy = 0;
      for (let i = 0; i < m; i++) { cx += p.pts[i * 2]; cy += p.pts[i * 2 + 1]; }
      cx /= m; cy /= m;
      const ds = [];
      for (let i = 0; i < m; i++) ds.push(Math.hypot(p.pts[i * 2] - cx, p.pts[i * 2 + 1] - cy));
      const r = ds.reduce((a, x) => a + x, 0) / m;
      if (r > 0 && ds.every((x) => Math.abs(x - r) < 0.01 * r)) snaps.push([cx - o[0], cy - o[1], 'centre', p.layer, r]);
    }
  }
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

  // the snap point nearest css px (x, y) within 10 px, else none
  // The snap points within 10 px, by a grid over them (drawing units, built on the first snap):
  // every point scanned on every pointer move, with two layout reads each, was 0.6 s a move on a
  // drawing of 5.2 million points
  let grid = null;
  const SNAP_PX = 10;
  function snapGrid() {
    const span0 = Math.max(ext.max[0] - ext.min[0], ext.max[1] - ext.min[1]) || 1;
    const g = { cell: span0 / 1024, cells: new Map() };
    for (const s of snaps) {
      const k = `${Math.floor(s[0] / g.cell)},${Math.floor(s[1] / g.cell)}`;
      let c = g.cells.get(k);
      if (!c) g.cells.set(k, (c = []));
      c.push(s);
    }
    return g;
  }
  function snapAt(px, py) {
    if (!grid) grid = snapGrid();
    const [ux, uy] = toUnits(px, py);
    const r = SNAP_PX / st.s;
    let best = null, bd = r * r;
    const look = (s) => {
      if (st.off.has(s[3])) return;
      const d = (s[0] - ux) ** 2 + (s[1] - uy) ** 2;
      if (d < bd) { bd = d; best = s; }
    };
    const x0 = Math.floor((ux - r) / grid.cell), x1 = Math.floor((ux + r) / grid.cell);
    const y0 = Math.floor((uy - r) / grid.cell), y1 = Math.floor((uy + r) / grid.cell);
    // (zoomed far out, more cells than points: every point once instead)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > grid.cells.size) { for (const s of snaps) look(s); return best; }
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) { const c = grid.cells.get(`${i},${j}`); if (c) for (const s of c) look(s); }
    return best;
  }
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
    const lim = HIT_PX / st.s;
    let best = null, bd = lim * lim;
    for (const p of drawing.paths) {
      if (st.off.has(p.layer)) continue;
      const n = p.pts.length / 2;
      for (let i = 0; i < n; i++) {
        const j = i + 1 < n ? i + 1 : p.closed ? 0 : -1;
        const ax = p.pts[i * 2] - o[0], ay = p.pts[i * 2 + 1] - o[1];
        let d2;
        if (j < 0) d2 = (ux - ax) ** 2 + (uy - ay) ** 2;
        else {
          const bx = p.pts[j * 2] - o[0], by = p.pts[j * 2 + 1] - o[1];
          const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
          const t = l2 ? Math.max(0, Math.min(1, ((ux - ax) * vx + (uy - ay) * vy) / l2)) : 0;
          d2 = (ux - ax - t * vx) ** 2 + (uy - ay - t * vy) ** 2;
        }
        if (d2 < bd) { bd = d2; best = p.layer; }
      }
    }
    if (best !== null) return best;
    // else a text under the point (inside its box, as the extents take it): a layer only texts
    // use could not be picked
    // (the box drawn: the text's measured lines, cut to its viewport's frame, and only when it is
    // drawn at all -- the estimate's box, uncut, picked a layer from empty sheet past a frame)
    for (const t of drawing.texts) {
      if (st.off.has(t.layer) || t.h * st.s < MIN_TEXT_PX) continue;
      if (t.clip && !(ux + o[0] >= t.clip[0] && ux + o[0] <= t.clip[2] && uy + o[1] >= t.clip[1] && uy + o[1] <= t.clip[3])) continue;
      const c = textCorners(t, linesOf(t), widthOf(t)).map(([x, y]) => [x - o[0], y - o[1]]);
      // the corners are bottom-left, bottom-right, top-left, top-right: inside when on one side of
      // each edge of the quad taken in order
      const q = [c[0], c[1], c[3], c[2]];
      let pos = 0, neg = 0;
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4];
        const cr = (bx - ax) * (uy - ay) - (by - ay) * (ux - ax);
        if (cr > 0) pos++; else if (cr < 0) neg++;
      }
      if (!(pos && neg)) return t.layer;
    }
    return null;
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
    setMeasure(on) { st.measure = on; st.pending = null; st.snap = null; draw(); },
    get measuring() { return st.measure; },
    get results() { return st.results; },
    clearMeasure() { st.results = []; st.pending = null; draw(); },
    escapeMeasure() { if (st.pending) { st.pending = null; draw(); return true; } return false; },
    measureClick, snapAt,
    layerOn: (name) => !st.off.has(name),
    destroy() {
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
