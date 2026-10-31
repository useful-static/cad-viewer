// Measure: Distance (two points: length
// and ΔX ΔY ΔZ), Angle (three points, at the middle one) and Face to face
// (two b-rep faces, the first planar: the gap along its normal). Points snap,
// within 12 CSS px of the pointer (24 on a coarse pointer), to a b-rep corner
// (◆), an edge's midpoint (▲), a circle's centre (⊙, with its Ø) or the
// nearest point on an edge (―), from js/measure-geom.js; else the surface
// under the pointer. Only VISIBLE candidates are offered: nothing may cut the
// segment from the eye to the point (js/raycast.js), except where the style
// draws hidden edges (Wire, X-ray, Hidden grey). Points are kept in model
// coordinates; results are drawn on an SVG layer over the view, projected
// each frame, so every backend shows them the same.
//
// main.js owns the input; it calls hover / place, loupe (a finger aiming),
// dotAt / moveDot / endDot (dragging a placed end dot) and draw, and asks
// escape() first.

import { angleAt, bodyGeometry, distance, faceGap, holesOf, polyLength, polyMid } from './measure-geom.js';
import { faceOfTri, makeCaster } from './raycast.js';

const SVG = 'http://www.w3.org/2000/svg';
const MARK = { vertex: '◆', mid: '▲', centre: '⊙', edge: '―', surface: '•' };
const KIND_NAME = { vertex: 'corner', mid: 'midpoint', centre: 'centre', edge: 'edge', surface: 'surface' };

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

// deps: { $, app, view() -> { vp, eye, dir, right, up, ortho, tanV, w, h, target, dist },
//   sectionPlane(), lenText(mm) "4.00 mm", num(mm) "4.00", unit() "mm", announce(text),
//   flash(text, ms), queueFrame(), syncOptbar(),
//   coarse(), showsHidden() }
export function createMeasure(deps) {
  const { $, app } = deps;
  const st = {
    on: false, mode: 'distance', pending: [], results: [], snap: null, geom: new Map(), caster: null, model: null,
    listOpen: false, holes: null,
  };
  const layer = $('measvg');
  const labels = $('measlabels');

  // ---- the model's caches ----
  function model() {
    const m = app.baseMesh;
    if (m !== st.model) { st.model = m; st.geom = new Map(); st.caster = m ? makeCaster(m) : null; }
    return m;
  }
  // a body's geometry, built at most `budget` ms per call across bodies
  function geomOf(mi, deadline) {
    if (st.geom.has(mi)) return st.geom.get(mi);
    if (performance.now() > deadline) return null;
    const g = bodyGeometry(st.model, mi);
    // the b-rep edges' lengths and midpoints, once
    g.mids = g.edges.map((e) => ({ p: polyMid(e), len: polyLength(e), closed: e.length > 2 && len(sub(e[0], e[e.length - 1])) === 0 }));
    st.geom.set(mi, g);
    return g;
  }

  // ---- projection ----
  function projector() {
    const v = deps.view();
    const m = v.vp;
    v.toScreen = (p) => {
      const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
      const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
      const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      if (w <= 1e-9) return null;
      return [(x / w + 1) * v.w / 2, (1 - y / w) * v.h / 2];
    };
    // the ray under a CSS point: { o, d } with |d| arbitrary
    v.rayAt = (sx, sy) => {
      const nx = (sx / v.w) * 2 - 1, ny = 1 - (sy / v.h) * 2;
      const hv = v.tanV, hh = v.tanV * (v.w / v.h);
      if (v.ortho) {
        const o0 = add(add(v.target, mul(v.right, nx * hh * v.dist)), mul(v.up, ny * hv * v.dist));
        const back = (app.sphere.radius + len(sub(v.target, app.sphere.center))) * 4 + v.dist;
        return { o: add(o0, mul(v.dir, back)), d: mul(v.dir, -1) };
      }
      return { o: v.eye, d: add(add(mul(v.dir, -1), mul(v.right, nx * hh)), mul(v.up, ny * hv)) };
    };
    return v;
  }

  // the bodies whose projected box covers (x, y) +- r, not hidden
  function bodiesNear(v, x, y, r) {
    const out = [];
    const ms = app.header.meshes;
    for (let i = 0; i < ms.length; i++) {
      if (app.hidden.has(i + 1)) continue;
      const b = ms[i].bbox;
      if (!b) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
      for (let c = 0; c < 8; c++) {
        const s = v.toScreen([c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]]);
        if (!s) { behind = true; break; }
        x0 = Math.min(x0, s[0]); y0 = Math.min(y0, s[1]); x1 = Math.max(x1, s[0]); y1 = Math.max(y1, s[1]);
      }
      if (behind || (x >= x0 - r && x <= x1 + r && y >= y0 - r && y <= y1 + r)) out.push(i);
    }
    return out;
  }

  // the cut side of a section is not there to hit
  function skipCut() {
    const p = deps.sectionPlane();
    if (!p) return null;
    const P = st.model.position, I = st.model.index;
    return (t) => {
      let s = 0;
      for (let j = 0; j < 3; j++) {
        const v = I[3 * t + j] * 3;
        s += p[0] * P[v] + p[1] * P[v + 1] + p[2] * P[v + 2];
      }
      return s / 3 > p[3];
    };
  }

  // nothing in front of p on the segment from the eye (ortho: from far back
  // along the view direction) -- among the bodies over p's screen point
  function visible(v, p, bodies, skip) {
    if (deps.showsHidden()) return true;
    const o = v.ortho ? add(p, mul(v.dir, (app.sphere.radius + len(sub(p, app.sphere.center))) * 4 + v.dist)) : v.eye;
    const d = sub(p, o);
    const L = len(d);
    if (!L) return true;
    const eps = Math.max(1e-5, (app.sphere.radius * 2e-4) / L);
    const h = st.caster.cast(bodies, o, d, 1 - eps, skip);
    return !h;
  }

  // The snap under CSS point (x, y): { p, kind, mesh, info, face? } | null
  function snapAt(x, y) {
    if (!model() || !app.header) return null;
    const v = projector();
    const r = deps.coarse() ? 24 : 12;
    const near = bodiesNear(v, x, y, r);
    const skip = skipCut();
    const deadline = performance.now() + 40;
    const pts = [];
    const edgePts = [];
    let pending = false;
    for (const mi of near) {
      const g = geomOf(mi, deadline);
      if (!g) { pending = true; continue; }
      const consider = (p, kind, info) => {
        if (skip && dot(p, deps.sectionPlane()) > deps.sectionPlane()[3] + 1e-9) return;
        const s = v.toScreen(p);
        if (!s) return;
        const dd = Math.hypot(s[0] - x, s[1] - y);
        if (dd <= r) pts.push({ p, kind, mesh: mi, info, dd });
      };
      for (const c of g.corners) consider(c, 'vertex');
      for (const m of g.mids) if (!m.closed) consider(m.p, 'mid', { length: m.len });
      for (const c of g.circles) consider(c.centre, 'centre', { diameter: 2 * c.radius });
      // the nearest point of each edge, in screen space, lifted back to 3D
      for (let e = 0; e < g.edges.length; e++) {
        const line = g.edges[e];
        for (let i = 1; i < line.length; i++) {
          const a = v.toScreen(line[i - 1]), b = v.toScreen(line[i]);
          if (!a || !b) continue;
          const ab = [b[0] - a[0], b[1] - a[1]];
          const l2 = ab[0] * ab[0] + ab[1] * ab[1];
          const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * ab[0] + (y - a[1]) * ab[1]) / l2)) : 0;
          const sx = a[0] + ab[0] * t, sy = a[1] + ab[1] * t;
          const dd = Math.hypot(sx - x, sy - y);
          if (dd > r) continue;
          // the screen parameter maps to 3D linearly in ortho; in perspective
          // closely enough over one tessellation segment
          const p = add(line[i - 1], mul(sub(line[i], line[i - 1]), t));
          edgePts.push({ p, kind: 'edge', mesh: mi, info: { length: g.mids[e].len, diameter: null }, dd });
        }
      }
    }
    // nearest on screen; within a pixel, the one nearer the eye: a
    // through-hole's two rims share a centre on screen, and the front one wins
    // (the back one is seen through the hole, so the visibility test passes it)
    const order = (a, b) => (Math.abs(a.dd - b.dd) > 1 ? a.dd - b.dd : dot(b.p, v.dir) - dot(a.p, v.dir));
    pts.sort(order);
    edgePts.sort(order);
    // a corner, midpoint or centre before a point on an edge; the nearest
    // visible one of each
    const vis = (c) => visible(v, c.p, bodiesNear(v, ...v.toScreen(c.p), 0), skip);
    for (const list of [pts, edgePts]) {
      for (const c of list.slice(0, 24)) if (vis(c)) return { ...c, pending };
    }
    // the surface under the pointer
    const ray = v.rayAt(x, y);
    const hit = st.caster.cast(bodiesNear(v, x, y, 0), ray.o, ray.d, Infinity, skip);
    if (!hit) return pending ? { pending: true } : null;
    const p = add(ray.o, mul(ray.d, hit.t));
    return { p, kind: 'surface', mesh: hit.mesh, tri: hit.tri, pending };
  }

  // the b-rep face under (x, y): { plane, points, mesh, face, p } | null
  function faceAt(x, y) {
    if (!model() || !st.model.faces) return null;
    const v = projector();
    const ray = v.rayAt(x, y);
    const skip = skipCut();
    const hit = st.caster.cast(bodiesNear(v, x, y, 0), ray.o, ray.d, Infinity, skip);
    if (!hit) return null;
    const m = app.header.meshes[hit.mesh];
    const f = faceOfTri(st.model.faces, m, hit.tri);
    if (f < 0) return null;
    const g = geomOf(hit.mesh, Infinity);
    const fi = f - m.faceStart;
    const face = g.faces[fi];
    const P = st.model.position, I = st.model.index;
    const points = [];
    for (let t = face.tri0; t < face.tri0 + face.ntri; t++) {
      for (let j = 0; j < 3; j++) { const q = I[3 * t + j] * 3; points.push([P[q], P[q + 1], P[q + 2]]); }
    }
    return { plane: face.plane, points, mesh: hit.mesh, face: f, p: add(ray.o, mul(ray.d, hit.t)) };
  }

  // ---- results ----
  const need = () => ({ distance: 2, angle: 3, face: 2, note: 1 })[st.mode];
  // a Distance or Angle result from its points (placing them, or dragging one)
  function pointResult(mode, pts) {
    if (mode === 'distance') {
      const d = distance(pts[0], pts[1]);
      return { mode, pts, main: deps.lenText(d.length),
        sub: `ΔX ${deps.lenText(Math.abs(d.delta[0]))} · ΔY ${deps.lenText(Math.abs(d.delta[1]))} · ΔZ ${deps.lenText(Math.abs(d.delta[2]))}`, value: d.length };
    }
    const a = angleAt(pts[0], pts[1], pts[2]);
    return { mode, pts, main: a === null ? 'no angle (two points coincide)' : `${a.toFixed(2)}°`, sub: '', value: a };
  }
  function finish() {
    const pts = st.pending;
    let r;
    // Note: its point placed, the text is asked for in the options bar
    if (st.mode === 'note') {
      $('measnotetext').hidden = false;
      $('measnotetext').value = '';
      $('measnotetext').focus();
      syncRow();
      return;
    }
    if (st.mode === 'distance' || st.mode === 'angle') {
      r = pointResult(st.mode, pts.map((q) => q.p));
    } else {
      const g = faceGap(pts[0].face, pts[1].face);
      const main = g.notPlanar ? 'the first face is not flat: pick a flat face first'
        : g.notParallel !== undefined ? `not parallel (${g.notParallel.toFixed(1)}°)` : deps.lenText(g.gap);
      r = { mode: 'face', pts: pts.map((q) => q.p), main, sub: 'face to face', value: g.gap ?? null };
    }
    st.results.push(r);
    st.pending = [];
    deps.announce(`${r.main}${r.sub ? `, ${r.sub}` : ''}`);
    deps.flash(r.main, 4000);
    syncRow();
  }

  // A note's text given (Enter in the field): pinned at its point
  function addNote(text) {
    const p = st.pending[0];
    $('measnotetext').hidden = true;
    st.pending = [];
    if (p && text.trim()) {
      st.results.push({ mode: 'note', pts: [p.p], main: text.trim().slice(0, 200), sub: '', value: null });
      deps.announce(`note: ${text.trim()}`);
    }
    syncRow();
    deps.queueFrame();
  }

  // Notes as a view link or a model list gives them: [{ p: [x, y, z], text }],
  // in place of the notes there are (other results stay)
  function setNotes(list) {
    st.results = st.results.filter((r) => r.mode !== 'note');
    for (const n of list || []) {
      if (n && Array.isArray(n.p) && n.p.length === 3 && n.p.every(Number.isFinite) && n.text) {
        st.results.push({ mode: 'note', pts: [n.p.slice()], main: String(n.text).slice(0, 200), sub: '', value: null });
      }
    }
    syncRow();
    deps.queueFrame();
  }
  const notes = () => st.results.filter((r) => r.mode === 'note').map((r) => ({ p: r.pts[0], text: r.main }));

  function place(x, y) {
    if (!st.on) return false;
    if (st.listOpen) setList(false);
    if (st.mode === 'note' && st.pending.length) return true; // its text is being typed
    if (st.mode === 'face') {
      const f = faceAt(x, y);
      if (!f) { deps.flash('no face here'); return true; }
      st.pending.push({ p: f.p, kind: 'face', face: f });
    } else {
      const s = snapAt(x, y);
      if (!s || !s.p) { deps.flash(s && s.pending ? 'still reading the parts here: try again' : 'no surface here'); return true; }
      st.pending.push(s);
    }
    if (st.pending.length >= need()) finish();
    else syncRow();
    deps.queueFrame();
    return true;
  }

  function hover(x, y) {
    if (!st.on || st.mode === 'face') { if (st.snap) { st.snap = null; deps.queueFrame(); } return; }
    st.snap = x === null ? null : snapAt(x, y);
    deps.queueFrame();
  }

  // ---- dragging a placed end dot ----
  // The end dot within 11 CSS px (a 22 px target) of (x, y), nearest first:
  // { r, i } (result, point index) | null. A Face to face result's ends are
  // picks of faces, and a distance found elsewhere (the clearance check) is
  // that check's; neither is dragged.
  function dotAt(x, y) {
    if (!st.on || !app.header) return null;
    const v = projector();
    let best = null;
    for (const r of st.results) {
      if (r.mode === 'face' || r.fixed) continue;
      r.pts.forEach((p, i) => {
        const s = v.toScreen(p);
        if (!s) return;
        const d = Math.hypot(s[0] - x, s[1] - y);
        if (d <= 11 && (!best || d < best.d)) best = { r, i, d, at: s };
      });
    }
    return best && { r: best.r, i: best.i, at: best.at };
  }
  // the dragged dot to the snap under (x, y); its result follows
  function moveDot(h, x, y) {
    const s = snapAt(x, y);
    st.snap = s && s.p ? s : null;
    if (st.snap) {
      const pts = h.r.pts.slice();
      pts[h.i] = s.p;
      if (h.r.mode === 'note') h.r.pts = pts;
      else Object.assign(h.r, pointResult(h.r.mode, pts));
    }
    deps.queueFrame();
  }
  // the drag ended: the result as it now reads
  function endDot(h) {
    st.snap = null;
    st.loupe = null;
    if (h.r.mode !== 'note') {
      deps.announce(`${h.r.main}${h.r.sub ? `, ${h.r.sub}` : ''}`);
      deps.flash(h.r.main, 4000);
    }
    if (st.listOpen) fillList();
    deps.queueFrame();
  }

  // The loupe: while a finger aims (or drags a dot), the view around the
  // snap point at 2x in a round inset beside the finger at (fx, fy); null
  // hides it
  // (ax, ay: the point aimed at, shown when nothing snaps)
  function loupe(fx, fy, ax = fx, ay = fy) {
    st.loupe = fx === null || fx === undefined ? null : { x: fx, y: fy, ax, ay };
    deps.queueFrame();
  }
  const LOUPE = 120; // CSS px across
  const ZOOM = 2;
  // Copied from the 3D canvas right after it is drawn (draw() runs in the
  // same frame), so the copy is the frame's pixels on every backend
  function drawLoupe(v) {
    const box = $('measloupe');
    const L = st.loupe;
    if (!L || !st.on) { if (!box.hidden) box.hidden = true; return; }
    const src = $('view');
    const k = src.width / Math.max(1, v.w); // device px per CSS px of the canvas
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(LOUPE * dpr);
    if (box.width !== px) { box.width = px; box.height = px; }
    const sp = st.snap && st.snap.p ? v.toScreen(st.snap.p) : null;
    const [cx, cy] = sp || [L.ax, L.ay];
    // above the finger, or below it where the top of the view leaves no room
    const gap = 72;
    const top = L.y - gap - LOUPE < 4 ? L.y + gap : L.y - gap - LOUPE;
    const left = Math.max(4, Math.min(v.w - LOUPE - 4, L.x - LOUPE / 2));
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    const ctx = box.getContext('2d');
    const half = LOUPE / ZOOM / 2; // CSS px of the view either side of the centre
    ctx.fillStyle = document.getElementById('stage').dataset.bg === 'paper' ? '#f4f4f2' : '#1d2127';
    ctx.fillRect(0, 0, px, px);
    try {
      ctx.drawImage(src, (cx - half) * k, (cy - half) * k, 2 * half * k, 2 * half * k, 0, 0, px, px);
    } catch { /* a canvas that cannot be read leaves the plain backing */ }
    // the centre: a crosshair, and the snap ring when there is a snap
    const paper = document.getElementById('stage').dataset.bg === 'paper';
    const c = px / 2;
    ctx.strokeStyle = paper ? '#9a6b00' : '#ffd23f';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(c - 10 * dpr, c); ctx.lineTo(c - 3 * dpr, c);
    ctx.moveTo(c + 3 * dpr, c); ctx.lineTo(c + 10 * dpr, c);
    ctx.moveTo(c, c - 10 * dpr); ctx.lineTo(c, c - 3 * dpr);
    ctx.moveTo(c, c + 3 * dpr); ctx.lineTo(c, c + 10 * dpr);
    ctx.stroke();
    if (sp) {
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.arc(c, c, 7 * ZOOM * dpr / 2, 0, 2 * Math.PI); ctx.stroke();
    }
    box.hidden = false;
  }

  // ---- drawing ----
  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    parent.append(e);
    return e;
  }
  function draw() {
    layer.replaceChildren();
    labels.replaceChildren();
    if (!st.on && !st.results.length) { drawLoupe({}); return; }
    if (!app.header) return;
    const v = projector();
    drawLoupe(v);
    for (const r of st.results) drawResult(v, r);
    const pend = st.pending.map((q) => v.toScreen(q.p));
    for (let i = 1; i < pend.length; i++) {
      if (pend[i - 1] && pend[i]) el('line', { x1: pend[i - 1][0], y1: pend[i - 1][1], x2: pend[i][0], y2: pend[i][1], class: 'mline pend' }, layer);
    }
    for (const s of pend) if (s) el('circle', { cx: s[0], cy: s[1], r: 4, class: 'mdot' }, layer);
    // the hole table's holes, numbered as its rows
    if (st.holes) {
      st.holes.list.forEach((h, i) => {
        const s = v.toScreen(h.centre);
        if (!s) return;
        el('circle', { cx: s[0], cy: s[1], r: i === st.holes.pick ? 9 : 6, class: i === st.holes.pick ? 'mhole pick' : 'mhole' }, layer);
        el('text', { x: s[0] + 8, y: s[1] - 6, class: 'mholetext' }, layer).textContent = String(i + 1);
      });
    }
    const sn = st.snap;
    if (st.on && sn && sn.p) {
      const s = v.toScreen(sn.p);
      if (s) {
        el('circle', { cx: s[0], cy: s[1], r: 7, class: 'msnap' }, layer);
        const t = el('text', { x: s[0] + 10, y: s[1] - 10, class: 'msnaptext' }, layer);
        const info = sn.kind === 'centre' ? ` Ø ${deps.lenText(sn.info.diameter)}`
          : (sn.kind === 'edge' || sn.kind === 'mid') && sn.info ? ` edge ${deps.lenText(sn.info.length)}` : '';
        t.textContent = `${MARK[sn.kind]} ${KIND_NAME[sn.kind]}${info}`;
      }
    }
  }
  function drawResult(v, r) {
    const s = r.pts.map((p) => v.toScreen(p));
    if (s.some((q) => !q)) return;
    for (let i = 1; i < s.length; i++) el('line', { x1: s[i - 1][0], y1: s[i - 1][1], x2: s[i][0], y2: s[i][1], class: 'mline' }, layer);
    for (const q of s) el('circle', { cx: q[0], cy: q[1], r: 4, class: 'mdot' }, layer);
    const at = r.mode === 'angle' ? s[1] : [(s[0][0] + s[s.length - 1][0]) / 2, (s[0][1] + s[s.length - 1][1]) / 2];
    const lab = document.createElement('div');
    lab.className = r.mode === 'note' ? 'mlabel note' : 'mlabel';
    lab.style.left = `${at[0]}px`;
    lab.style.top = `${at[1]}px`;
    lab.textContent = r.main;
    if (r.sub) { const d = document.createElement('small'); d.textContent = r.sub; lab.append(d); }
    labels.append(lab);
  }

  // The results and the hole table's markers onto a 2D canvas, for a saved
  // picture (main.js savePicture): as draw() places them, at s device px per
  // CSS px; light chips on a light background (paper or white)
  function paint(ctx, s, light = false) {
    if (!app.header || (!st.results.length && !st.holes)) return;
    const v = projector();
    const P = (p) => { const q = v.toScreen(p); return q && [q[0] * s, q[1] * s]; };
    ctx.save();
    ctx.lineCap = 'round';
    for (const r of st.results) {
      const q = r.pts.map(P);
      if (q.some((x) => !x)) continue;
      ctx.strokeStyle = light ? '#9a6b00' : '#ffd23f';
      ctx.lineWidth = 2.5 * s;
      ctx.beginPath();
      q.forEach((x, i) => (i ? ctx.lineTo(...x) : ctx.moveTo(...x)));
      ctx.stroke();
      ctx.fillStyle = light ? '#9a6b00' : '#ffd23f';
      for (const x of q) { ctx.beginPath(); ctx.arc(x[0], x[1], 4 * s, 0, 2 * Math.PI); ctx.fill(); }
      const at = r.mode === 'angle' ? q[1] : [(q[0][0] + q[q.length - 1][0]) / 2, (q[0][1] + q[q.length - 1][1]) / 2];
      ctx.font = `${12 * s}px system-ui, sans-serif`;
      const w = Math.max(ctx.measureText(r.main).width, r.sub ? ctx.measureText(r.sub).width * 0.85 : 0) + 12 * s;
      const h = (r.sub ? 32 : 18) * s;
      const x0 = at[0] - w / 2, y0 = at[1] - h - 8 * s;
      ctx.fillStyle = light ? 'rgba(255,255,255,0.95)' : 'rgba(20,24,30,0.92)';
      ctx.strokeStyle = light ? '#9a6b00' : '#ffd23f';
      ctx.lineWidth = 1 * s;
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeRect(x0, y0, w, h);
      ctx.fillStyle = light ? '#111' : '#fff';
      ctx.textBaseline = 'top';
      ctx.fillText(r.main, x0 + 6 * s, y0 + 3 * s);
      if (r.sub) {
        ctx.font = `${10 * s}px system-ui, sans-serif`;
        ctx.fillStyle = light ? '#444' : '#c9d1db';
        ctx.fillText(r.sub, x0 + 6 * s, y0 + 18 * s);
      }
    }
    if (st.holes) {
      ctx.font = `${12 * s}px system-ui, sans-serif`;
      st.holes.list.forEach((h, i) => {
        const q = P(h.centre);
        if (!q) return;
        ctx.strokeStyle = i === st.holes.pick ? '#ffd23f' : '#5fd3ff';
        ctx.lineWidth = 2 * s;
        ctx.beginPath(); ctx.arc(q[0], q[1], 6 * s, 0, 2 * Math.PI); ctx.stroke();
        ctx.fillStyle = light ? '#111' : '#fff';
        ctx.fillText(String(i + 1), q[0] + 8 * s, q[1] - 18 * s);
      });
    }
    ctx.restore();
  }

  // ---- the options bar row ----
  function syncRow() {
    $('measopt').hidden = !st.on;
    $('measure').setAttribute('aria-pressed', String(st.on));
    for (const b of $('measmode').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === st.mode));
    // Face needs the b-rep faces (a .cadmesh written before they were kept has none)
    const faceBtn = $('measmode').querySelector('[data-mode="face"]');
    faceBtn.hidden = !(app.baseMesh && app.baseMesh.faces);
    $('measundo').disabled = !st.pending.length && !st.results.length;
    $('measclear').disabled = !st.pending.length && !st.results.length;
    const n = st.results.length;
    $('measchip').hidden = !n;
    $('measchip').textContent = `${n} result${n === 1 ? '' : 's'}`;
    $('measchip').setAttribute('aria-expanded', String(st.listOpen));
    $('measnote').textContent = st.mode === 'face' ? (st.pending.length ? 'pick the second face' : 'pick a flat face')
      : st.mode === 'note' ? (st.pending.length ? 'type the note, Enter pins it' : 'click where the note goes')
        : st.pending.length ? `point ${st.pending.length + 1} of ${need()}` : `point 1 of ${need()}`;
    if (!(st.mode === 'note' && st.pending.length)) $('measnotetext').hidden = true;
    if (st.listOpen) fillList();
    deps.syncOptbar();
  }
  function fillList() {
    const ul = $('measlist');
    ul.replaceChildren();
    st.results.forEach((r, i) => {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.textContent = `${r.main}${r.sub ? ` (${r.sub})` : ''}`;
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.title = 'Copy this result';
      copy.onclick = () => navigator.clipboard?.writeText(t.textContent).then(() => deps.flash('copied'), () => {});
      const x = document.createElement('button');
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${r.main}`);
      x.onclick = () => { st.results.splice(i, 1); if (!st.results.length) setList(false); syncRow(); deps.queueFrame(); };
      li.append(t, copy, x);
      ul.append(li);
    });
  }
  function setList(open) {
    st.listOpen = open && st.results.length > 0;
    $('measlist').hidden = !st.listOpen;
    syncRow();
  }

  function setOn(on, focus = false) {
    // (the viewer turns off what cannot run beside Measure: Explode)
    if (on && !st.on && deps.beforeOn) deps.beforeOn();
    st.on = on;
    if (!on) { st.pending = []; st.snap = null; st.loupe = null; setList(false); }
    syncRow();
    deps.queueFrame();
    if (on) deps.flash('Measure: click points on the model (Esc to stop)', 3000);
    deps.announce(on ? 'measure on' : 'measure off');
    if (focus) (on ? $('measoff') : $('measure')).focus();
  }

  function undo() {
    if (st.pending.length) st.pending.pop();
    else st.results.pop();
    syncRow();
    deps.queueFrame();
  }

  // Esc: the results list, a half-made measurement, then Measure itself
  function escape() {
    if (st.listOpen) { setList(false); return true; }
    if (st.pending.length) { st.pending = []; syncRow(); deps.queueFrame(); return true; }
    if (st.on) { setOn(false, true); return true; }
    return false;
  }

  // a new model: its results are of the old one
  function reset() {
    st.pending = [];
    st.results = [];
    st.snap = null;
    st.loupe = null;
    st.model = null;
    st.geom = new Map();
    setList(false);
    showHoles(null);
    syncRow();
  }

  // ---- the hole table ----
  // The holes of the parts in ids (a board: its mounting holes), from the
  // reference box's min corner (js/datum.js's corner), in the two file axes
  // across the hole's axis when that is a file axis (a board's X and Y), all
  // three otherwise. ids null closes it.
  function holeRows(ids, ref) {
    model();
    const list = [];
    for (const id of ids) for (const h of holesOf(geomOf(id - 1, Infinity))) list.push({ ...h, mesh: id - 1 });
    list.sort((a, b) => a.diameter - b.diameter || a.centre[0] - b.centre[0] || a.centre[1] - b.centre[1]);
    // the axes across each hole: the same for all (a board's X, Y) puts them
    // in the column's head, numbers only in the cells (the 300 px panel
    // wrapped "Ø 4.00 mm" and "X 5.00 mm · Y 5.00 mm")
    const axesOf = (h) => {
      const ax = h.normal.map(Math.abs);
      const k = ax.indexOf(Math.max(...ax));
      return ax[k] > 0.999 ? [0, 1, 2].filter((j) => j !== k) : [0, 1, 2];
    };
    const first = list.length ? axesOf(list[0]).join() : '';
    const shared = list.every((h) => axesOf(h).join() === first);
    const rows = list.map((h, i) => {
      const at = axesOf(h).map((j) => `${shared ? '' : `${'XYZ'[j]} `}${deps.num(h.centre[j] - ref.min[j])}`).join(shared ? ', ' : ' · ');
      return { n: i + 1, d: h.diameter, at, through: h.rims > 1, depth: h.depth };
    });
    const posHead = list.length && shared ? `${first.split(',').map((j) => 'XYZ'[j]).join(', ')} (${deps.unit()})` : `position (${deps.unit()})`;
    // per diameter as shown: how many, and how far apart their centres spread
    // (keyed on the printed value: 0.508 and 0.511 mm read as two "0.51" lines)
    const groups = new Map();
    for (const h of list) {
      const key = deps.num(h.diameter);
      if (!groups.has(key)) groups.set(key, { d: h.diameter, n: 0, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], normal: h.normal });
      const g = groups.get(key);
      g.n++;
      for (let j = 0; j < 3; j++) { g.lo[j] = Math.min(g.lo[j], h.centre[j]); g.hi[j] = Math.max(g.hi[j], h.centre[j]); }
    }
    return { list, rows, groups: [...groups.values()], posHead };
  }
  function showHoles(ids, ref = null, name = '') {
    const box = $('holes');
    if (!ids || !ids.length) { st.holes = null; box.hidden = true; deps.queueFrame(); return null; }
    const t = holeRows(ids, ref);
    st.holes = { list: t.list, pick: -1 };
    $('holestitle').textContent = `Holes of ${name} (${t.list.length})`;
    const sum = $('holessum');
    sum.replaceChildren();
    for (const g of t.groups) {
      const ax = g.normal.map(Math.abs);
      const k = ax.indexOf(Math.max(...ax));
      const spread = [0, 1, 2].filter((j) => j !== k).map((j) => deps.lenText(g.hi[j] - g.lo[j])).join(' × ');
      const li = document.createElement('li');
      li.textContent = `Ø ${deps.lenText(g.d)} × ${g.n}${g.n > 1 ? ` · centres span ${spread}` : ''}`;
      sum.append(li);
    }
    $('holesdia').textContent = `Ø (${deps.unit()})`;
    $('holespos').textContent = t.posHead;
    const from = document.createElement('li');
    from.textContent = `positions from the corner of ${ref.name || 'the whole model'}`;
    sum.prepend(from);
    const tb = $('holesrows');
    tb.replaceChildren();
    for (const r of t.rows) {
      const tr = document.createElement('tr');
      tr.tabIndex = 0;
      // depth: through holes' (rim to rim); "–" for one rim (blind, or a
      // sheet's hole)
      for (const c of [String(r.n), deps.num(r.d), r.at, r.through ? deps.num(r.depth) : '–']) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      const pick = () => { st.holes.pick = r.n - 1; for (const x of tb.children) x.classList.toggle('pick', x === tr); deps.flash(`hole ${r.n}: Ø ${deps.lenText(r.d)} at ${t.posHead} ${r.at}`, 3000); deps.queueFrame(); };
      tr.onclick = pick;
      tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
      tb.append(tr);
    }
    $('holescsv').onclick = () => {
      const u = deps.unit();
      const csv = [`n,diameter (${u}),"${t.posHead}",depth (${u})`,
        ...t.rows.map((r) => `${r.n},${deps.num(r.d)},"${r.at}",${r.through ? deps.num(r.depth) : ''}`)].join('\n');
      navigator.clipboard?.writeText(csv).then(() => deps.flash('hole table copied'), () => {});
    };
    box.hidden = false;
    deps.queueFrame();
    deps.announce(`${t.list.length} holes`);
    return t;
  }

  $('measure').onclick = () => setOn(!st.on, true);
  $('measoff').onclick = () => setOn(false, true);
  for (const b of $('measmode').querySelectorAll('button')) {
    b.onclick = () => { st.mode = b.dataset.mode; st.pending = []; st.snap = null; syncRow(); deps.queueFrame(); };
  }
  $('measundo').onclick = undo;
  // the note's text: Enter pins it, Esc drops the note (and stays in Measure)
  $('measnotetext').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addNote($('measnotetext').value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); st.pending = []; syncRow(); deps.queueFrame(); }
  });
  $('measclear').onclick = () => { st.pending = []; st.results = []; setList(false); syncRow(); deps.queueFrame(); };
  $('measchip').onclick = () => setList(!st.listOpen);

  return {
    get on() { return st.on; }, get results() { return st.results; }, get pending() { return st.pending; },
    get snap() { return st.snap; },
    get holes() { return st.holes; },
    // a body's measured geometry (mesh index), built once (js/drawing-svg.js)
    geometry: (mi) => { model(); return geomOf(mi, Infinity); },
    get loupeShown() { return !!st.loupe; },
    setOn, hover, place, draw, paint, escape, reset, undo, snapAt, faceAt, dotAt, moveDot, endDot, loupe, showHoles, notes, setNotes, addNote, setMode: (m) => { st.mode = m; st.pending = []; syncRow(); },
    // a distance found elsewhere (the clearance check): drawn and listed as
    // Measure's own, replacing an earlier one of the same `sub`
    addDistance(pa, pb, sub) {
      st.results = st.results.filter((r) => r.sub !== sub);
      const d = distance(pa, pb);
      st.results.push({ mode: 'distance', pts: [pa.slice(), pb.slice()], main: deps.lenText(d.length), sub, value: d.length, fixed: true });
      syncRow();
      deps.queueFrame();
    },
  };
}
