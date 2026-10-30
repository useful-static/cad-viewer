// A 2D DXF drawing (js/dxf.js parseDXF) on its own canvas over the stage
// (plan feature 23): the paper background of the 3D line styles, every line
// 1 px at any zoom, native text; wheel zooms toward the pointer, a drag pans,
// two fingers pinch, a double click fits. A click selects the LAYER of the
// nearest line (the selected layer in the 3D paper selection colour and 1 px
// wider, the others faded); hovering shows a layer un-faded and wider.
//
// One Path2D per (layer, colour, fill), built relative to the drawing's
// extents centre (Canvas paths are float32: a drawing at 10^6 units would
// jitter when zoomed in), stroked under the view transform with lineWidth =
// 1 / scale. Uses the DOM (a canvas); no 3D renderer.

import { onPaper } from './dxf.js';

const PAPER = '#f4f4f2';
const SELECTED = '#085a72';
const FADED = '#a8a8a4';
const HIT_PX = 8;

export function createDxfView(canvas, drawing, cb = {}) {
  const ctx = canvas.getContext('2d');
  const ext = drawing.extents || { min: [0, 0], max: [1, 1] };
  const o = [(ext.min[0] + ext.max[0]) / 2, (ext.min[1] + ext.max[1]) / 2];
  const st = { s: 1, c: [0, 0], selected: null, hover: null, off: new Set(drawing.layers.filter((l) => !l.on).map((l) => l.name)) };
  // the paths, grouped, relative to o
  const groups = new Map();
  for (const p of drawing.paths) {
    const key = `${p.layer}\u0000${p.colour.r},${p.colour.g},${p.colour.b},${p.colour.aci}\u0000${p.fill ? 1 : 0}`;
    let g = groups.get(key);
    if (!g) { g = { layer: p.layer, colour: onPaper(p.colour), fill: p.fill, path: new Path2D(), points: [] }; groups.set(key, g); }
    if (p.point) { g.points.push(p.pts[0] - o[0], p.pts[1] - o[1]); continue; }
    g.path.moveTo(p.pts[0] - o[0], p.pts[1] - o[1]);
    for (let k = 2; k < p.pts.length; k += 2) g.path.lineTo(p.pts[k] - o[0], p.pts[k + 1] - o[1]);
    if (p.closed) g.path.closePath();
  }
  const css = () => [canvas.clientWidth || 1, canvas.clientHeight || 1];

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
      if (g.fill) { ctx.fillStyle = col; ctx.globalAlpha = sel && !hot ? 0.35 : 0.85; ctx.fill(g.path); ctx.globalAlpha = 1; }
      ctx.strokeStyle = col;
      ctx.lineWidth = (hot ? 2 : 1) / st.s;
      ctx.stroke(g.path);
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
      if (px < 3) continue; // too small to read: left out
      ctx.save();
      ctx.translate(t.x - o[0], t.y - o[1]);
      ctx.rotate(t.rot);
      ctx.scale(1, -1);
      ctx.fillStyle = t.layer === sel ? SELECTED : sel && t.layer !== st.hover ? FADED : onPaper(t.colour);
      ctx.font = `${t.h}px sans-serif`;
      ctx.textAlign = t.align;
      ctx.textBaseline = t.mtext ? 'top' : 'alphabetic';
      const lines = t.text.split('\n');
      lines.forEach((l, i) => ctx.fillText(l, 0, (t.mtext ? i : i - (lines.length - 1)) * t.h * 1.4));
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (cb.onDraw) cb.onDraw();
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
    return best;
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
    if (drag && !moved && pts.size === 0) select(layerAt(...p));
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
