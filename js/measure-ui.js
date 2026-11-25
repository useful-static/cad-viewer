// Measure: Distance, Angle (at the middle of three points) and Face to face (the gap along the
// first, planar face's normal). Points snap within 12 CSS px (24 coarse) to a VISIBLE corner ◆,
// midpoint ▲, centre ⊙ or edge point ―, else the surface or a section's cut ▪; kept in model
// coordinates and drawn on an SVG layer projected each frame.
//
// main.js owns the input; it calls hover / place, loupe (a finger aiming),
// dotAt / moveDot / endDot (dragging a placed end dot) and draw, and asks
// escape() first.

import { UNTOLD_SHARE, angleAt, arcOf, bodyGeometry, distance, faceGap, holesOf, orderHoles, polyLength, polyMid } from './measure-geom.js';
// A hole row's Ø with its wider rim's, one text for the table, summary and words (r68 A8, r69 A4).
// r: { d, head }; fmt: the number's writer.
export const holeDia = (r, fmt) => `${fmt(r.d)}${r.head ? ` (${fmt(r.head)} at its rim)` : ''}`;
// The rims a hole table leaves out, one sentence for the summary, the CSV and the announcement, the
// through-holes' own rims told (r67 A3, Q5, r69 Q7)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// A label's box ({ left, right, top, bottom }) brought inside the bounds b ({ left, right, top,
// bottom }), then moved clear of those placed before it, up first, down where up leaves them ->
// { dx, dy }: the screen's, a picture's and a drawing's labels (UI design rounds 20-22)
export function clearOf(r, placed, b) {
  const into = (lo, hi, a, z) => (z - a > hi - lo ? lo - a : a < lo ? lo - a : z > hi ? hi - z : 0);
  const dx = into(b.left, b.right, r.left, r.right), y0 = into(b.top, b.bottom, r.top, r.bottom);
  const hit = (y) => placed.find((p) => r.left + dx < p.right && r.right + dx > p.left && r.top + y < p.bottom && r.bottom + y > p.top);
  for (const dir of [-1, 1]) {
    let y = y0;
    for (let k = 0; k < 16; k++) { const h = hit(y); if (!h) break; y = dir < 0 ? h.top - r.bottom - 2 : h.bottom - r.top + 2; }
    if (!hit(y) && r.top + y >= b.top && r.bottom + y <= b.bottom) return { dx, dy: y };
  }
  return { dx, dy: y0 };
}
// The hole numbers to draw, [index, screen point]: the picked hole's first, then each that clears
// those kept (s: px per CSS px); the table lists every one (R24-2, R25-1, R25-2)
export function holeNumbers(at, pick, s) {
  const order = at.map((p, i) => i).filter((i) => at[i]);
  if (pick >= 0 && at[pick]) order.splice(order.indexOf(pick), 1), order.unshift(pick);
  const kept = [], out = [];
  for (const i of order) {
    const p = at[i], b = { left: p[0] + 7 * s, right: p[0] + (9 + 7 * String(i + 1).length) * s, top: p[1] - 18 * s, bottom: p[1] - 4 * s };
    if (kept.some((q) => b.left < q.right && b.right > q.left && b.top < q.bottom && b.bottom > q.top)) continue;
    kept.push(b); out.push([i, p]);
  }
  return out;
}
// a touch-only device taps (and has no Esc): the words say so (UI design rounds 5-6)
// (the stylesheet's own test: "no fine pointer" alone also matches a browser that reports no pointer)
export const TOUCH_ONLY = '(any-pointer: coarse) and (not (any-pointer: fine))';
const touchOnly = () => typeof matchMedia === 'function' && matchMedia(TOUCH_ONLY).matches;
export const untoldText = (n, holes = 0) => {
  // (both kinds: the rounding coarser than the share, or the loop within that rounding of the circle
  // test -- it said "too small" of a Ø7.28 rim 131 m out whose rounding was 0.215% of its radius: r70 A3)
  const rims = n ? `${plural(n, 'rim', 'rims')} this far from the origin that the file's rounded positions cannot tell from a shape that is not a circle (rounded coarser than ${+(100 * UNTOLD_SHARE).toFixed(2)}% of ${n === 1 ? 'its' : 'their'} radius, or within that rounding of the circle test)` : '';
  const more = holes ? `${plural(holes, 'through-hole', 'through-holes')} whose other rim is ${n === 1 ? 'that one' : 'one of them'}` : '';
  return rims || more ? `${[rims, more].filter(Boolean).join(', and ')}: not listed` : '';
};
// Snap candidates [{ p, dd }] in place in the order snapAt takes them: by screen distance dd, in
// runs of points within a pixel of the run's first, a run's nearest the eye (along dir) first
export function snapOrder(list, dir) {
  list.sort((a, b) => a.dd - b.dd);
  let r = 0;
  for (let i = 0; i < list.length; i++) { if (list[i].dd - list[r].dd > 1) r = i; list[i].run = r; }
  const near = (q) => q.p[0] * dir[0] + q.p[1] * dir[1] + q.p[2] * dir[2];
  return list.sort((a, b) => a.run - b.run || near(b) - near(a) || a.dd - b.dd);
}
import { edgeNearness, faceOfTri, makeCaster, seesInside } from './raycast.js';
import { add, cross, dot, len, mul, sub } from './vec3.js';
import { PAPER, VIEW_BG } from './styles.js';
import { NOTES_MAX, NOTE_TEXT_MAX, cutText } from './view-link.js'; // (a note's one limit and its one cut)

const SVG = 'http://www.w3.org/2000/svg';
const HUGE_BODY = 200000; // triangles: a body this big readied for snapping only after it is said (R151-1)
// every kind of point Measure snaps to, its mark and its name (a 'cut' point -- on a section's cut
// face -- had neither: its label read "undefined undefined")
export const SNAP_KINDS = ['vertex', 'mid', 'centre', 'edge', 'surface', 'cut'];
export const MARK = { vertex: '◆', mid: '▲', centre: '⊙', edge: '―', surface: '•', cut: '▪' };
export const KIND_NAME = { vertex: 'corner', mid: 'midpoint', centre: 'centre', edge: 'edge', surface: 'surface', cut: 'cut face' };


// The colours Measure draws in, on the dark view and on paper (a light ground)
const INK = {
  dark: { line: '#ffd23f', label: 'rgba(20,24,30,0.92)', text: '#fff', sub: '#c9d1db', loupe: VIEW_BG },
  light: { line: '#9a6b00', label: 'rgba(255,255,255,0.95)', text: '#111', sub: '#444', loupe: PAPER },
};
const HOLE = '#5fd3ff';

// deps: { $, scene, view(), sectionPlane(), lenText, num, unit, announce, tell, queueFrame,
//   syncOptbar, coarse, showsHidden, closed, beforeOn } (main.js wires them)
// The point of segment a-b nearest the ray { o, d } (parallel to it: the screen parameter's point)
export function nearestOnRay(a, b, ray, t) {
  const u = sub(b, a), w = sub(a, ray.o);
  const A = dot(u, u), B = dot(u, ray.d), C = dot(ray.d, ray.d), D = dot(u, w), E = dot(ray.d, w);
  const den = A * C - B * B;
  const s = den > 1e-12 * A * C ? Math.max(0, Math.min(1, (B * E - C * D) / den)) : t;
  return add(a, mul(u, s));
}

export function createMeasure(deps) {
  const { $, scene } = deps;
  // text to the clipboard, said when copied and when not (a failure, or no clipboard: said
  // nowhere before -- r46 Q6)
  const copyText = (text, done) => {
    const fail = (e) => deps.tell(`could not copy: ${e?.message || e || 'no clipboard here'}`, 4000);
    if (!navigator.clipboard?.writeText) { fail(); return; }
    navigator.clipboard.writeText(text).then(() => deps.tell(done), fail);
  };
  const st = {
    on: false, mode: 'distance', pending: [], results: [], snap: null, geom: new Map(), caster: null, model: null,
    listOpen: false, holes: null, prepared: new Set(), preparing: new Set(),
  };
  const layer = $('measvg');
  const labels = $('measlabels');
  $('measnotetext').maxLength = NOTE_TEXT_MAX; // (a note's one limit, js/view-link.js)

  // ---- the model's caches ----
  function model() {
    const m = scene.mesh;
    if (m !== st.model) { st.model = m; st.geom = new Map(); st.caster = m ? makeCaster(m) : null; st.prepared = new Set(); }
    return m;
  }
  // a body's geometry, built at most `budget` ms per call across bodies
  function geomOf(mi, deadline) {
    if (st.geom.has(mi)) return st.geom.get(mi);
    if (performance.now() > deadline) return null;
    const g = bodyGeometry(st.model, mi);
    // the b-rep edges' lengths and midpoints, once
    // (each body's own angle, g.a: a scene of added models has no one header value -- r126 L1)
    g.mids = g.edges.map((e, i) => { const a = arcOf(e, g.a > 0 ? g.a : 0.5); return { p: a ? a.mid : polyMid(e), len: a ? a.length : polyLength(e), closed: g.edgeClosed[i] }; });
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
    // whether a sphere (centre c, radius rad) can reach within r CSS px of (x, y): its centre's
    // screen point, and its radius in px at its nearest depth -- true when that cannot be told (it
    // reaches the eye's plane)
    v.sphereNear = (c, rad, x, y, r) => {
      const s = v.toScreen(c);
      if (!s) return true;
      const depth = v.ortho ? v.dist : (c[0] - v.eye[0]) * -v.dir[0] + (c[1] - v.eye[1]) * -v.dir[1] + (c[2] - v.eye[2]) * -v.dir[2];
      const near = v.ortho ? depth : depth - rad;
      if (!(near > 1e-9)) return true;
      // (grown by the view's widest slope: off its axis a sphere's image is stretched past its
      // centre's scale)
      const px = ((rad * v.h) / (2 * v.tanV * near)) * (1 + v.tanV * Math.max(1, v.w / v.h));
      return Math.hypot(s[0] - x, s[1] - y) <= r + px + 1;
    };
    // the ray under a CSS point: { o, d } with |d| arbitrary
    v.rayAt = (sx, sy) => {
      const nx = (sx / v.w) * 2 - 1, ny = 1 - (sy / v.h) * 2;
      const hv = v.tanV, hh = v.tanV * (v.w / v.h);
      if (v.ortho) {
        const o0 = add(add(v.target, mul(v.right, nx * hh * v.dist)), mul(v.up, ny * hv * v.dist));
        const back = (scene.sphere.radius + len(sub(v.target, scene.sphere.center))) * 4 + v.dist;
        return { o: add(o0, mul(v.dir, back)), d: mul(v.dir, -1) };
      }
      return { o: v.eye, d: add(add(mul(v.dir, -1), mul(v.right, nx * hh)), mul(v.up, ny * hv)) };
    };
    return v;
  }

  // A body's edges' bounding spheres ({ c, r }: their boxes' centres and half-diagonals), built once
  const edgeSphereOf = new WeakMap();
  function edgeSpheres(g) {
    let s = edgeSphereOf.get(g);
    if (s) return s;
    s = g.edges.map((line) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const p of line) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
      return { c: [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2), r: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 };
    });
    edgeSphereOf.set(g, s);
    return s;
  }

  // the bodies whose projected box covers (x, y) +- r, not hidden
  function bodiesNear(v, x, y, r) {
    const out = [];
    const ms = scene.header.meshes;
    for (let i = 0; i < ms.length; i++) {
      if (scene.hidden.has(i + 1)) continue;
      const b = ms[i].bbox;
      if (!b) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
      for (let c = 0; c < 8; c++) {
        const s = v.toScreen([c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]]);
        if (!s) { behind = true; break; }
        x0 = Math.min(x0, s[0]); y0 = Math.min(y0, s[1]); x1 = Math.max(x1, s[0]); y1 = Math.max(y1, s[1]);
      }
      if (!(behind || (x >= x0 - r && x <= x1 + r && y >= y0 - r && y <= y1 + r))) continue;
      if (ms[i].idxCount / 3 > HUGE_BODY && !st.prepared.has(i)) { prepare(i); continue; }
      out.push(i);
    }
    return out;
  }
  // A huge body (the rack's frame, 846k triangles) readied for snapping only after that is said: it
  // froze the page 2.3 s on the first aim, unsaid (R151-1)
  function prepare(i) {
    if (st.preparing.has(i)) return;
    st.preparing.add(i);
    deps.tell('preparing snapping on this part…', 8000, 'preparing snapping');
    setTimeout(() => {
      if (st.model === scene.mesh) { st.caster?.warm?.(i); if (scene.mesh.faces) geomOf(i, Infinity); st.prepared.add(i); }      st.preparing.delete(i);
      deps.tell('snapping ready', 1500, '');
      deps.queueFrame();
    }, 80);
  }

  // the cut side of a section is not there to hit: a hit point past the plane, as the view cuts
  // each pixel (by a triangle's centroid, a click on the drawn top near the cut found nothing, one
  // on the cut-away side snapped)
  function skipCut() {
    const p = deps.sectionPlane();
    if (!p) return null;
    return (q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2] > p[3];
  }

  // nothing in front of p on the segment from the eye (ortho: from far back
  // along the view direction) -- among the bodies over p's screen point
  function visible(v, p, bodies, skip) {
    if (deps.showsHidden()) return true;
    const o = v.ortho ? add(p, mul(v.dir, (scene.sphere.radius + len(sub(p, scene.sphere.center))) * 4 + v.dist)) : v.eye;
    const d = sub(p, o);
    const L = len(d);
    if (!L) return true;
    const eps = Math.max(1e-5, (scene.sphere.radius * 2e-4) / L);
    if (st.caster.cast(bodies, o, d, 1 - eps, skip)) return false;
    // (nor a cut face in front of it: where the ray crosses the section's plane before p, inside a
    // closed body, the view draws the cut -- corners and edges behind an RJ45's cut face beat the cut
    // point under the pointer: r126 M2)
    const pl = skip && deps.sectionPlane();
    if (!pl) return true;
    const den = dot(pl, d);
    const tp = den ? (pl[3] - dot(pl, o)) / den : -1;
    return !(tp > 0 && tp < 1 - eps && insideClosed(add(o, mul(d, tp)), bodies, pl, skip));
  }
  // a point inside a closed body, by the parity of the walls a ray into the section's kept side
  // crosses, each body on its own (r127 H1); a border hit walked again on two tilted rays, by
  // majority (r127 L1, r128 L3)
  function insideClosed(q, bodies, pl, skip) {
    const dir = [-pl[0], -pl[1], -pl[2]], step = Math.max(1e-6, scene.sphere.radius * 1e-7);
    const P = st.model.position, I = st.model.index;
    const walk = (m, d) => {
      let o = q, c = 0, graze = false;
      for (let k = 0; k < 256; k++) {
        const h = st.caster.cast([m], o, d, Infinity, skip);
        if (!h) break;
        if (edgeNearness(P, I, h.tri, o, d) < 1e-6) graze = true;
        c++;
        o = add(o, mul(d, h.t + step));
      }
      return { odd: (c & 1) === 1, graze };
    };
    let tilts = null;
    const tilted = () => {
      if (tilts) return tilts;
      const a0 = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const a = cross(dir, a0), al = len(a), b = cross(dir, a);
      const ua = mul(a, 1 / al), ub = mul(b, 1 / len(b));
      tilts = [add(dir, add(mul(ua, 0.0123), mul(ub, 0.0071))), add(dir, add(mul(ua, -0.0089), mul(ub, 0.0117)))];
      return tilts;
    };
    for (const m of bodies) {
      if (deps.closed && !deps.closed(m)) continue;
      const w0 = walk(m, dir);
      let odd = w0.odd;
      if (w0.graze) {
        const ws = [w0, ...tilted().map((d) => walk(m, d))];
        const clear = ws.find((w) => !w.graze);
        odd = clear ? clear.odd : ws.filter((w) => w.odd).length >= 2;
      }
      if (odd) return true;
    }
    return false;
  }

  // The snap under CSS point (x, y): { p, kind, mesh, info, face? } | null
  function snapAt(x, y) {
    if (!model() || !scene.header) return null;
    const v = projector();
    const r = deps.coarse() ? 24 : 12;
    const near = bodiesNear(v, x, y, r);
    const skip = skipCut();
    const deadline = performance.now() + 40;
    const pts = [];
    const edgePts = [];
    const pray = v.rayAt(x, y); // (the pointer's ray: an edge's point under it)
    let pending = false;
    // (a file of triangles only, no CAD faces: the surface alone, as its note says -- corners and edges
    // of its tessellation were offered, and building them froze the rack 2.6 s: R152-1, R152-2)
    for (const mi of st.model.faces ? near : []) {
      const g = geomOf(mi, deadline);
      if (!g) { pending = true; continue; }
      const consider = (p, kind, info) => {
        if (skip && skip(p)) return; // (skipCut's test, the one the caster uses)
        const s = v.toScreen(p);
        if (!s) return;
        const dd = Math.hypot(s[0] - x, s[1] - y);
        if (dd <= r) pts.push({ p, kind, mesh: mi, info, dd });
      };
      for (const c of g.corners) consider(c, 'vertex');
      for (const m of g.mids) if (!m.closed) consider(m.p, 'mid', { length: m.len });
      for (const c of g.circles) consider(c.centre, 'centre', { diameter: 2 * c.radius });
      // the nearest point of each edge in screen space, lifted back to 3D; an edge whose bounding sphere
      // cannot reach the pointer passed over whole (r135 L2)
      const sph = edgeSpheres(g);
      for (let e = 0; e < g.edges.length; e++) {
        const line = g.edges[e];
        if (!v.sphereNear(sph[e].c, sph[e].r, x, y, r)) continue;
        for (let i = 1; i < line.length; i++) {
          const a = v.toScreen(line[i - 1]), b = v.toScreen(line[i]);
          if (!a || !b) continue;
          const ab = [b[0] - a[0], b[1] - a[1]];
          const l2 = ab[0] * ab[0] + ab[1] * ab[1];
          const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * ab[0] + (y - a[1]) * ab[1]) / l2)) : 0;
          const sx = a[0] + ab[0] * t, sy = a[1] + ab[1] * t;
          const dd = Math.hypot(sx - x, sy - y);
          if (dd > r) continue;
          // the edge's point nearest the pointer's ray, not by the screen parameter (r108 M1)
          const p = nearestOnRay(line[i - 1], line[i], pray, t);
          if (skip && skip(p)) continue; // (an edge the section cut away, as consider's: r126 M1)
          edgePts.push({ p, kind: 'edge', mesh: mi, info: { length: g.mids[e].len, diameter: null }, dd });
        }
      }
    }
    // nearest on screen (within a pixel, nearer the eye), a point before an edge, the 24 nearest
    // tried then more within 40 ms (r122 L2, r134 M3)
    const nearest = (list) => snapOrder(list, v.dir);
    const vis = (c) => visible(v, c.p, bodiesNear(v, ...v.toScreen(c.p), 0), skip);
    for (const list of [nearest(pts), nearest(edgePts)]) {
      for (let i = 0; i < list.length; i++) {
        if (i >= 24 && performance.now() > deadline) break;
        if (vis(list[i])) return { ...list[i], pending };
      }
    }
    // the surface under the pointer
    const ray = v.rayAt(x, y);
    const hit = st.caster.cast(bodiesNear(v, x, y, 0), ray.o, ray.d, Infinity, skip);
    if (!hit) return pending ? { pending: true } : null;
    const c = cutAt(hit, ray);
    if (c) return { p: c, kind: 'cut', mesh: hit.mesh, pending };
    const p = add(ray.o, mul(ray.d, hit.t));
    return { p, kind: 'surface', mesh: hit.mesh, tri: hit.tri, pending };
  }

  // Where a hit is a closed body's inside seen through the section's cut -- what the view draws as
  // the cut face -- the point on the plane, else null. (The far inside wall was taken: two clicks on
  // a cube's cut face measured 9.615 for 7.211)
  function cutAt(hit, ray) {
    const pl = deps.sectionPlane();
    if (!pl) return null;
    if (deps.closed && !deps.closed(hit.mesh)) return null; // (an open sheet: no cut face drawn)
    // (its outside a surface, not the cut, by the view's own test, raycast.js seesInside)
    const den = dot(pl, ray.d);
    if (Math.abs(den) < 1e-12) return null;
    const tp = (pl[3] - dot(pl, ray.o)) / den;
    if (!(tp > 0 && tp <= hit.t)) return null;
    const q = add(ray.o, mul(ray.d, tp));
    // (or, where the hit is on a seam the normals cannot say, its plane point inside the body by
    // parity -- the hit on a box's far bottom edge read "surface" under its cut face: r126 M2)
    return seesInside(st.model.position, st.model.normal, st.model.index, hit.tri, ray.o, ray.d) || insideClosed(q, [hit.mesh], pl, skipCut()) ? q : null;
  }

  // the b-rep face under (x, y): { plane, points, mesh, face, p } | null
  function faceAt(x, y) {
    if (!model() || !st.model.faces) return null;
    const v = projector();
    const ray = v.rayAt(x, y);
    const skip = skipCut();
    const hit = st.caster.cast(bodiesNear(v, x, y, 0), ray.o, ray.d, Infinity, skip);
    if (!hit || cutAt(hit, ray)) return null; // (a cut face is no b-rep face: Face to face and Paint took the far wall)
    const m = scene.header.meshes[hit.mesh];
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
      // (a first face that is not flat is no result: said, not listed -- it counted in the results
      // chip and got a Copy button: r124 L2)
      if (g.notPlanar) {
        st.pending = [];
        deps.tell('the first face is not flat: pick a flat face first', 4000);
        syncRow();
        deps.queueFrame();
        return;
      }
      const main = g.notParallel !== undefined ? `not parallel (${g.notParallel.toFixed(1)}°)` : deps.lenText(g.gap);
      r = { mode: 'face', pts: pts.map((q) => q.p), main, sub: 'face to face', value: g.gap ?? null };
    }
    st.results.push(r);
    st.pending = [];
    deps.tell(r.main, 4000, `${r.main}${r.sub ? `, ${r.sub}` : ''}`);
    syncRow();
  }

  // A note's text given (Enter in the field): pinned at its point
  function addNote(text) {
    const p = st.pending[0];
    $('measnotetext').hidden = true;
    st.pending = [];
    const count = st.results.filter((r) => r.mode === 'note').length;
    if (p && text.trim() && count >= NOTES_MAX) {
      // (as many as a model list or a tour step holds: js/view-link.js NOTES_MAX)
      deps.tell(`${NOTES_MAX} notes is the most a view holds`, 4000);
    } else if (p && text.trim()) {
      st.results.push({ mode: 'note', pts: [p.p], main: cutText(text.trim(), NOTE_TEXT_MAX), sub: '', value: null });
      deps.announce(`note: ${text.trim()}`);
    }
    syncRow();
    deps.queueFrame();
  }

  // Notes as a view link or a model list gives them: [{ p: [x, y, z], text }],
  // in place of the notes there are (other results stay)
  function setNotes(list) {
    st.results = st.results.filter((r) => r.mode !== 'note');
    for (const n of (list || []).slice(0, NOTES_MAX)) {
      if (n && Array.isArray(n.p) && n.p.length === 3 && n.p.every(Number.isFinite) && n.text) {
        // (given: the page's, not the user's -- it does not open the bar; a
        // note of the user's own, put back as a tour ends, stays theirs)
        st.results.push({ mode: 'note', pts: [n.p.slice()], main: cutText(String(n.text), NOTE_TEXT_MAX), sub: '', value: null, given: n.own !== true });
      }
    }
    syncRow();
    deps.queueFrame();
  }
  const notes = () => st.results.filter((r) => r.mode === 'note').map((r) => ({ p: r.pts[0], text: r.main, ...(r.given ? {} : { own: true }) }));

  function place(x, y) {
    if (!st.on) return false;
    if (st.listOpen) setList(false);
    if (st.mode === 'note' && st.pending.length) return true; // its text is being typed
    if (st.mode === 'face') {
      const f = faceAt(x, y);
      if (!f) { deps.tell('no face here'); return true; }
      st.pending.push({ p: f.p, kind: 'face', face: f });
    } else {
      const s = snapAt(x, y);
      if (!s || !s.p) {
        const why = s && s.pending ? 'still reading the parts here: try again' : 'no surface here';
        deps.tell(why);
        return true;
      }
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
  // The end dot within 11 CSS px of (x, y): { r, i } | null (not a Face to face's nor a clearance's)
  function dotAt(x, y) {
    if (!st.on || !scene.header) return null;
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
      deps.tell(h.r.main, 4000, `${h.r.main}${h.r.sub ? `, ${h.r.sub}` : ''}`);
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
    const ink = $('stage').dataset.bg === 'paper' ? INK.light : INK.dark;
    ctx.fillStyle = ink.loupe;
    ctx.fillRect(0, 0, px, px);
    try {
      ctx.drawImage(src, (cx - half) * k, (cy - half) * k, 2 * half * k, 2 * half * k, 0, 0, px, px);
    } catch { /* a canvas that cannot be read leaves the plain backing */ }
    // the centre: a crosshair, and the snap ring when there is a snap
    const c = px / 2;
    ctx.strokeStyle = ink.line;
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
    // (the hole table's markers too: opened from Holes with Measure off, the live view showed none
    // where the saved picture drew them -- r115 M4 measure-ui-B63)
    if (!st.on && !st.results.length && !st.holes) { drawLoupe({}); return; }
    if (!scene.header) return;
    const v = projector();
    drawLoupe(v);
    placed.length = 0;
    // (the axis triad is a box the labels keep off: R23-9)
    const tri = $('triad');
    if (tri && !tri.hidden && tri.getBoundingClientRect) { const t = tri.getBoundingClientRect(); placed.push({ left: t.left, right: t.right, top: t.top, bottom: t.bottom }); }
    for (const r of st.results) drawResult(v, r);
    const pend = st.pending.map((q) => v.toScreen(q.p));
    for (let i = 1; i < pend.length; i++) {
      if (pend[i - 1] && pend[i]) el('line', { x1: pend[i - 1][0], y1: pend[i - 1][1], x2: pend[i][0], y2: pend[i][1], class: 'mline pend' }, layer);
    }
    for (const s of pend) if (s) el('circle', { cx: s[0], cy: s[1], r: 4, class: 'mdot' }, layer);
    // the hole table's holes, numbered as its rows
    if (st.holes) {
      // (rings first, then the numbers where they clear those before, the picked one first -- R24-2, R25-1)
      const at = st.holes.list.map((h) => v.toScreen(h.centre));
      at.forEach((s, i) => { if (s) el('circle', { cx: s[0], cy: s[1], r: i === st.holes.pick ? 9 : 6, class: i === st.holes.pick ? 'mhole pick' : 'mhole' }, layer); });
      for (const [i, s] of holeNumbers(at, st.holes.pick, 1)) {
        el('text', { x: s[0] + 8, y: s[1] - 6, class: 'mholetext' }, layer).textContent = String(i + 1);
      }
    }
    const sn = st.snap;
    if (st.on && sn && sn.p) {
      const s = v.toScreen(sn.p);
      if (s) {
        el('circle', { cx: s[0], cy: s[1], r: 7, class: 'msnap' }, layer);
        const t = el('text', { x: s[0] + 10, y: s[1] - 10, class: 'msnaptext' }, layer);
        const info = sn.kind === 'centre' ? ` Ø ${deps.lenText(sn.info.diameter)}`
          : sn.kind === 'edge' && sn.info ? ` ${deps.lenText(sn.info.length)}` // ("edge edge 40.00 mm": R21-7)
            : sn.kind === 'mid' && sn.info ? ` edge ${deps.lenText(sn.info.length)}` : '';
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
    // (a label over one placed before it moves clear of it, inside the view, with a leader back to
    // its line: R20-4, R21-3, R21-4)
    if (!lab.getBoundingClientRect) return; // (a test's stand-in element)
    // (inside the view, above the options bar: labels went under the header, the bar and the sides, R22)
    const b = lab.getBoundingClientRect(), box = labels.getBoundingClientRect(), bar = $('optbar');
    const foot = bar && !bar.hidden ? Math.min(box.bottom, bar.getBoundingClientRect().top) : box.bottom;
    const { dx, dy: y } = clearOf(b, placed, { left: box.left + 2, right: box.right - 2, top: box.top + 2, bottom: foot - 2 });
    if (dx || y) {
      lab.style.left = `${at[0] + dx}px`;
      lab.style.top = `${at[1] + y}px`;
      const lx = at[0] + dx, ly = (y < 0 ? b.bottom : b.top) + y - box.top;
      if (Math.abs(ly - at[1]) > 4) el('line', { x1: at[0], y1: at[1], x2: lx, y2: ly, class: 'mlead' }, layer);
    }
    placed.push({ left: b.left + dx, right: b.right + dx, top: b.top + y, bottom: b.bottom + y });
  }
  const placed = [];

  // The results and the hole table's markers onto a 2D canvas, for a saved
  // picture (main.js savePicture): as draw() places them, at s device px per
  // CSS px; light chips on a light background (paper or white)
  function paint(ctx, s, light = false) {
    if (!scene.header || (!st.results.length && !st.holes)) return;
    const v = projector();
    const P = (p) => { const q = v.toScreen(p); return q && [q[0] * s, q[1] * s]; };
    const ink = light ? INK.light : INK.dark;
    ctx.save();
    ctx.lineCap = 'round';
    // (the screen's placement: crossing results drew one readable label, R21-5; every line first,
    // then the labels over them, so no later line crosses an earlier label, R22-3)
    const done = [], W = ctx.canvas.width, H = ctx.canvas.height;
    const shown = st.results.map((r) => [r, r.pts.map(P)]).filter(([, q]) => !q.some((x) => !x));
    for (const [, q] of shown) {
      ctx.strokeStyle = ink.line;
      ctx.lineWidth = 2.5 * s;
      ctx.beginPath();
      q.forEach((x, i) => (i ? ctx.lineTo(...x) : ctx.moveTo(...x)));
      ctx.stroke();
      ctx.fillStyle = ink.line;
      for (const x of q) { ctx.beginPath(); ctx.arc(x[0], x[1], 4 * s, 0, 2 * Math.PI); ctx.fill(); }
    }
    // (every label placed and its leader drawn, then every label: a leader crossed the labels drawn
    // before it, R23-1; a sideways move gets its leader too, R23-8)
    const boxes = shown.map(([r, q]) => {
      const at = r.mode === 'angle' ? q[1] : [(q[0][0] + q[q.length - 1][0]) / 2, (q[0][1] + q[q.length - 1][1]) / 2];
      ctx.font = `${12 * s}px system-ui, sans-serif`;
      const w = Math.max(ctx.measureText(r.main).width, r.sub ? ctx.measureText(r.sub).width * 0.85 : 0) + 12 * s;
      const h = (r.sub ? 32 : 18) * s;
      const x = at[0] - w / 2, yy = at[1] - h - 8 * s;
      const { dx, dy } = clearOf({ left: x, right: x + w, top: yy, bottom: yy + h }, done, { left: 2 * s, right: W - 2 * s, top: 2 * s, bottom: H - 2 * s });
      const x0 = x + dx, y0 = yy + dy;
      done.push({ left: x0, right: x0 + w, top: y0, bottom: y0 + h });
      if (Math.abs(dy) > 4 * s || Math.abs(dx) > 4 * s) {
        ctx.strokeStyle = ink.line; ctx.lineWidth = 1 * s; ctx.setLineDash?.([3 * s, 3 * s]);
        ctx.beginPath(); ctx.moveTo(at[0], at[1]); ctx.lineTo(x0 + w / 2, dy < 0 ? y0 + h : y0); ctx.stroke();
        ctx.setLineDash?.([]);
      }
      return { r, x0, y0, w, h };
    });
    for (const { r, x0, y0, w, h } of boxes) {
      ctx.font = `${12 * s}px system-ui, sans-serif`;
      ctx.fillStyle = ink.label;
      ctx.strokeStyle = ink.line;
      ctx.lineWidth = 1 * s;
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeRect(x0, y0, w, h);
      ctx.fillStyle = ink.text;
      ctx.textBaseline = 'top';
      ctx.fillText(r.main, x0 + 6 * s, y0 + 3 * s);
      if (r.sub) {
        ctx.font = `${10 * s}px system-ui, sans-serif`;
        ctx.fillStyle = ink.sub;
        ctx.fillText(r.sub, x0 + 6 * s, y0 + 18 * s);
      }
    }
    if (st.holes) {
      ctx.font = `${12 * s}px system-ui, sans-serif`;
      // (its own baseline: set only in the results' loop, a picture without results drew the
      // numbers 12 px higher)
      ctx.textBaseline = 'top';
      // (the screen's rule: every ring, then the numbers that clear each other, each on a halo -- R25-2)
      const at = st.holes.list.map((h) => P(h.centre));
      // (the picked ring last and as on screen, 9 px with a 3 px line: R26-5)
      const ring = (q, picked) => {
        ctx.strokeStyle = picked ? INK.dark.line : HOLE;
        ctx.lineWidth = (picked ? 3 : 2) * s;
        ctx.beginPath(); ctx.arc(q[0], q[1], (picked ? 9 : 6) * s, 0, 2 * Math.PI); ctx.stroke();
      };
      at.forEach((q, i) => { if (q && i !== st.holes.pick) ring(q, false); });
      if (at[st.holes.pick]) ring(at[st.holes.pick], true);
      for (const [i, q] of holeNumbers(at, st.holes.pick, s)) {
        ctx.strokeStyle = light ? '#fff' : '#000'; ctx.lineWidth = 3 * s; ctx.lineJoin = 'round';
        ctx.strokeText(String(i + 1), q[0] + 8 * s, q[1] - 18 * s);
        ctx.fillStyle = ink.text;
        ctx.fillText(String(i + 1), q[0] + 8 * s, q[1] - 18 * s);
      }
    }
    ctx.restore();
  }

  // ---- the options bar row ----
  function syncRow() {
    // the bar shows while measuring, and while the user's results stay drawn with Measure off (then
    // only the list and Clear all); a tour's or a link's notes never pop it up
    if (deps.view2d?.()) { sync2D(deps.view2d()); return; } // (a drawing's bar is its own)
    const kept = !st.on && st.results.some((r) => !r.given);
    $('measopt').hidden = !st.on && !kept;
    for (const id of ['measoff', 'measmode', 'measundo']) $(id).hidden = kept;
    $('measure').setAttribute('aria-pressed', String(st.on));
    for (const b of $('measmode').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === st.mode));
    // Face needs the b-rep faces (a .cadmesh written before they were kept has none)
    const faceBtn = $('measmode').querySelector('[data-mode="face"]');
    faceBtn.hidden = !(scene.mesh && scene.mesh.faces);
    $('measundo').disabled = !st.pending.length && !st.results.length;
    $('measclear').disabled = !st.pending.length && !st.results.length;
    const n = st.results.length;
    $('measchip').hidden = !n;
    $('measchip').textContent = `${n} result${n === 1 ? '' : 's'}`;
    $('measchip').setAttribute('aria-expanded', String(st.listOpen));
    $('measnote').textContent = kept ? 'Measure is off; its results stay until cleared'
      : st.mode === 'face' ? (st.pending.length ? 'pick the second face' : 'pick a flat face')
      // (typing: the field's placeholder says it once -- UI design round 7 R7-3)
      : st.mode === 'note' ? (st.pending.length ? '' :`${touchOnly() ? 'tap' : 'click'} where the note goes`)
        : st.pending.length ? `point ${st.pending.length + 1} of ${need()}` : `point 1 of ${need()}`;
    if (!(st.mode === 'note' && st.pending.length)) $('measnotetext').hidden = true;
    if (st.listOpen) fillList();
    deps.syncOptbar();
  }
  // a drawing's Measure: the bar with its ×, Undo and Clear all (R44-4)
  function sync2D(v) {
    const on = !!v?.measuring;
    $('measopt').hidden = !on;
    if (on) {
      for (const id of ['measmode', 'measchip', 'measlist', 'measnotetext']) $(id).hidden = true;
      for (const id of ['measoff', 'measundo', 'measclear']) $(id).hidden = false;
      const n = v.results.length;
      $('measundo').disabled = !n && !v.pending;
      $('measclear').disabled = !n && !v.pending;
      // (one width: R45-3)
      $('measnote').textContent = v.pending ? 'point 2 of 2' : 'point 1 of 2';
    }
    deps.syncOptbar();
  }
  function fillList() {
    const ul = $('measlist'), top = ul.scrollTop; // (kept: a removal jumped the list to its top, R25-7)
    ul.replaceChildren();
    st.results.forEach((r, i) => {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.textContent = `${r.main}${r.sub ? ` (${r.sub})` : ''}`;
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.title = 'Copy this result';
      // (a copy that fails, or no clipboard: said -- it was said nowhere: r46 Q6)
      copy.onclick = () => copyText(t.textContent, 'copied');
      const x = document.createElement('button');
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${r.main}`);
      x.onclick = () => {
        const kb = document.activeElement === x; // (the focus to the next row's ×, or the chip: it fell to the page, R25-8)
        st.results.splice(i, 1);
        if (!st.results.length) setList(false);
        syncRow(); deps.queueFrame();
        deps.tell(`removed: ${r.main}`, 2000); // (said, as Undo and Clear all are: R138-8)
        // (by the count left, not the list -- a closed list is not refilled, and its removed row's
        // hidden x took the focus nowhere: the last one gone, Measure's toggle shown, R26-2, R27-1)
        if (kb) {
          const xs = st.results.length ? [...ul.querySelectorAll('li button:last-child')] : [];
          // (Measure's button, or View's when it is folded into View's closed panel: at 390 it fell
          // to File -- R28-2)
          (xs[Math.min(i, xs.length - 1)] || (st.on ? $('measoff') : offFocus())).focus?.();
        }
      };
      li.append(t, copy, x);
      ul.append(li);
    });
    ul.scrollTop = top;
  }
  function setList(open) {
    st.listOpen = open && st.results.length > 0;
    $('measlist').hidden = !st.listOpen;
    syncRow();
  }

  const offFocus = () => (deps.toolFocus ? deps.toolFocus('measure') : $('measure'));
  function setOn(on, focus = false) {
    // (the viewer turns off what cannot run beside Measure: Explode)
    if (on && !st.on && deps.beforeOn) deps.beforeOn();
    st.on = on;
    if (!on) { st.pending = []; st.snap = null; st.loupe = null; setList(false); }
    syncRow();
    deps.queueFrame();
    // (a mesh with no b-rep faces -- an STL, an OBJ, a .cadmesh written without them -- has no
    // corners, edges or circles to snap to, which nothing said: r121 L2)
    if (on) onNote(true); else deps.tell('measure off', 3000, 'measure off');
    if (focus) (on ? $('measoff') : offFocus()).focus();
    if (on) warmUp();
  }
  // the bodies' trees and geometry built in 8 ms slices while Measure is on, so a dense model's first
  // aim does not build them all at once (1.5 s frozen on a 1,790-body scene: R150-4)
  function warmUp() {
    const m = model();
    if (!m || !st.caster?.warm) return;
    let mi = 0;
    const slice = () => {
      if (!st.on || st.model !== m) return;
      const end = performance.now() + 8;
      // (a huge body left to prepare(), said first: R151-1; those under it warmed too, the first aim
      // otherwise building them, 0.9 s on the board -- R152-7)
      while (mi < m.header.meshes.length && performance.now() < end) {
        if (m.header.meshes[mi].idxCount / 3 > HUGE_BODY) { mi++; continue; }
        st.caster.warm(mi);
        if (m.faces && !geomOf(mi, end)) break;
        mi++;
      }
      if (mi < m.header.meshes.length) setTimeout(slice, 0);
    };
    setTimeout(slice, 0);
  }
  // Measure's note; again, unsaid, as the hole table opens or closes (its "or Enter on a hole row"
  // kept to the table, and said with "measure on": R128-4)
  function onNote(say = false) {
    if (!st.on) return;
    const plain = scene.mesh && !scene.mesh.faces, row = !touchOnly() && !$('holes').hidden;
    deps.tell(`Measure: ${touchOnly() ? 'tap points on the model' : `click points on the model${row ? ', or Enter on a hole row' : ''} (Esc to stop)`}${plain ? '. This file has triangles only, no CAD faces: points snap to the surface, not to corners, edges or centres' : ''}`,
      plain ? 6000 : 3000, say ? `measure on${row ? ', or Enter on a hole row for a point' : ''}` : ''); // (R65-1)
  }

  // (said, and the gone result's note ended with it: silent, it read "24.37 mm" for 4 s -- R135-7)
  function undo() {
    if (st.pending.length) { st.pending.pop(); deps.tell('point dropped', 2000); } else {
      const r = st.results.pop();
      if (r) deps.tell(`removed: ${r.main}`, 2000);
    }
    syncRow();
    deps.queueFrame();
    return true;
  }

  // Esc: the results list, a half-made measurement, then Measure itself
  function escape() {
    if (st.listOpen) { setList(false); return true; }
    if (st.pending.length) { st.pending = []; syncRow(); deps.tell('point dropped', 2000); deps.queueFrame(); return true; } // (said: R128-5)
    if (st.on) { setOn(false, true); return true; }
    return false;
  }

  // a new model: its results are of the old one. off: Measure itself goes
  // too, quietly (the 3D model gone: a drawing has its own Measure, and the
  // 3D one left on behind it came back on with its button reading off)
  function reset(off = false) {
    if (off) st.on = false;
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
  // The holes of the parts in ids from the reference's min corner, in the two axes across them (all
  // three otherwise); ids null closes it
  function holeRows(ids, ref) {
    model();
    const list = [];
    // (each body's holes once, kept with its geometry: the info panel rebuilt an open table on every
    // selection, visibility or unit change, and a 11,438-rim panel froze the page each time)
    const holesFor = (g) => g.holes || (g.holes = holesOf(g));
    // (and the rims the stored positions cannot tell, this far from the origin: said, not left out
    // without a word -- js/measure-geom.js untold, r66)
    // (and the through-holes left out as their other rim is one of those: r69 Q7)
    let untold = 0, unpaired = 0;
    for (const id of ids) { const hs = holesFor(geomOf(id - 1, Infinity)); untold += hs.untold || 0; unpaired += hs.unpaired || 0; for (const h of hs) list.push({ ...h, mesh: id - 1 }); }
    orderHoles(list); // (js/measure-geom.js)
    // the axes across each hole: the same for all (a board's X, Y) puts them
    // in the column's head, numbers only in the cells (the 300 px panel
    // wrapped "Ø 4.00 mm" and "X 5.00 mm · Y 5.00 mm")
    const axesOf = (h) => {
      const ax = h.normal.map(Math.abs);
      const k = ax.indexOf(Math.max(...ax));
      return ax[k] > 0.999 ? [0, 1, 2].filter((j) => j !== k) : [0, 1, 2];
    };
    const first = list.length ? axesOf(list[0]).join() : '';
    const vals = (h, axes) => axes.map((j) => deps.num(h.centre[j] - ref.min[j]));
    // all three where two would not tell the rows apart; the axes in the head, numbers in the cells
    // (R28-1, R29-1, R29-2)
    const across = list.map((h) => vals(h, axesOf(h)).join(', '));
    const all3 = !list.every((h) => axesOf(h).join() === first) || new Set(across).size < across.length;
    const axes = all3 ? [0, 1, 2] : first.split(',').map(Number);
    const rows = list.map((h, i) => {
      const v = all3 ? vals(h, axes) : vals(h, axesOf(h));
      // (head: a countersunk hole's countersink diameter -- js/measure-geom.js holesOf, r67)
      return { n: i + 1, d: h.diameter, at: v.join(', '), said: v.map((x, q) => `${'XYZ'[axes[q]]} ${x}`).join(', '), through: h.rims > 1, depth: h.depth, head: h.head || 0 };
    });
    const posHead = list.length ? `${axes.map((j) => 'XYZ'[j]).join(', ')} (${deps.unit()})` : `position (${deps.unit()})`;
    // per size (a Ø within 1e-4, or fit noise far out, of the one before it; a countersink apart),
    // one line under its mean Ø as printed: how many, and their centres' spread
    // (r68 A8, r123 M2, r124 L3 L5, r138 M1)
    const groups = new Map(), sums = [], counts = [];
    const sized = [];
    let sid = -1, prev = -Infinity;
    for (const h of list) {
      const far = Math.max(...h.centre.map(Math.abs));
      const noise = far > 0 ? 2 * 2 ** (Math.floor(Math.log2(far)) - 23) : 0; // (two float32 steps there)
      if (!(Math.abs(h.diameter - prev) <= Math.max(1e-4 * h.diameter, noise))) { sid++; sums[sid] = 0; counts[sid] = 0; }
      prev = h.diameter;
      sums[sid] += h.diameter; counts[sid]++;
      sized.push([h, sid]);
    }
    const meanOf = (s) => sums[s] / counts[s];
    // (a size's printed Ø: what most of its holes print; on a tie the value no smaller size took,
    // else its mean's -- r139 L3, r140 L1)
    const votes = [];
    for (const [h, s] of sized) { const p = deps.num(h.diameter); (votes[s] ||= new Map()).set(p, (votes[s].get(p) || 0) + 1); }
    const label = [], taken = new Set();
    for (let s = 0; s <= sid; s++) {
      const top = Math.max(...votes[s].values());
      const tied = [...votes[s]].filter(([, c]) => c === top).map(([p]) => p);
      const m = deps.num(meanOf(s));
      label[s] = tied.length === 1 ? tied[0] : tied.includes(m) && !taken.has(m) ? m : tied.find((p) => !taken.has(p)) ?? (tied.includes(m) ? m : tied[0]);
      taken.add(label[s]);
    }
    const printed = (s) => label[s];
    // (the line's Ø shown: the mean where it prints the line's value, else a hole that does)
    const shownOf = (s) => {
      const p = printed(s);
      if (deps.num(meanOf(s)) === p) return meanOf(s);
      const h = sized.find(([x, t]) => t === s && deps.num(x.diameter) === p);
      return h ? h[0].diameter : meanOf(s);
    };
    for (const [h, s] of sized) {
      const key = `${printed(s)}|${h.head ? deps.num(h.head) : ''}`;
      if (!groups.has(key)) groups.set(key, { d: shownOf(s), head: h.head || 0, n: 0, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], normal: h.normal });
      const g = groups.get(key);
      g.n++;
      // (the axis each hole runs along: one size in a top face and a side wall spans all three)
      const na = h.normal.map(Math.abs);
      (g.axes ||= new Set()).add(na.indexOf(Math.max(na[0], na[1], na[2])));
      for (let j = 0; j < 3; j++) { g.lo[j] = Math.min(g.lo[j], h.centre[j]); g.hi[j] = Math.max(g.hi[j], h.centre[j]); }
    }
    return { list, rows, groups: [...groups.values()], posHead, untold, unpaired };
  }
  function showHoles(ids, ref = null, name = '') {
    const box = $('holes');
    if (!ids || !ids.length) { const was = !box.hidden; st.holes = null; box.hidden = true; if (was) onNote(); deps.queueFrame(); return null; }
    const t = holeRows(ids, ref);
    // (the same holes shown again keep their pick: a picture's redraw un-picked it, R26-1)
    const key = ids.join(','), keep = st.holes && st.holes.key === key && st.holes.pick < t.list.length ? st.holes.pick : -1;
    st.holes = { list: t.list, pick: keep, key };
    $('holestitle').textContent = t.list.length ? `Holes of ${name} (${t.list.length})` : `Holes of ${name}`;
    const sum = $('holessum');
    sum.replaceChildren();
    for (const g of t.groups) {
      const ax = g.normal.map(Math.abs);
      const k = ax.indexOf(Math.max(...ax));
      // (holes along different axes -- a top face's and a side wall's -- spread in all three: the
      // first hole's two cross axes left the third out, r124 L4)
      const mixed = g.axes && g.axes.size > 1;
      // (along their axis too where they lie apart on it, each axis named, the unit once, an axis
      // with no spread left out: R29-2, R30-1)
      const spread = [0, 1, 2].filter((j) => (mixed || j !== k || deps.num(g.hi[j] - g.lo[j]) !== deps.num(0)) && deps.num(g.hi[j] - g.lo[j]) !== deps.num(0))
        .map((j) => `${'XYZ'[j]} ${deps.num(g.hi[j] - g.lo[j])}`).join(', ');
      const li = document.createElement('li');
      li.textContent = `Ø ${holeDia(g, deps.lenText)} × ${g.n}${g.n > 1 ? (spread ? ` · centres span ${spread} ${deps.unit()}` : ' · one centre') : ''}`;
      sum.append(li);
    }
    $('holesdia').textContent = `Ø (${deps.unit()})`;
    $('holespos').textContent = t.posHead;
    $('holesdepth').textContent = `depth (${deps.unit()})`; // (its numbers had no unit: r124 L1)
    // (a caption, not a size among the sizes; the sizes fold past 6, so a board's 21 left the table
    // out of sight as it opened: UI design round 3 F-08, F-14)
    // (the table's own part: "its corner", its long name not a third time -- R40-5)
    $('holesfrom').textContent = `Positions from ${ref.name && ref.name === name ? 'its corner' : `the corner of ${ref.name || 'the whole model'}`}`;
    $('holessumhead').textContent = `${t.groups.length} ${t.groups.length === 1 ? 'size' : 'sizes'}`;
    // (6 sizes or fewer: a plain list, no "N sizes" heading over it)
    const flat = t.groups.length <= 6;
    $('holessumbox').open = flat;
    $('holessumbox').classList.toggle('flat', flat);
    // the holes left out, said outside the fold, so a closed one never hides it (round 4 F-6)
    const note = $('holesnote');
    note.hidden = !(t.untold || t.unpaired);
    note.textContent = note.hidden ? '' : untoldText(t.untold, t.unpaired);
    const tb = $('holesrows');
    tb.replaceChildren();
    // (one Tab stop, ↑ ↓ Home End between rows, each named and the picked one current, as the parts
    // list: 46 unnamed "row" stops -- R127-2)
    const stop = st.holes.pick >= 0 && st.holes.pick < t.rows.length ? st.holes.pick : 0;
    for (const r of t.rows) {
      const tr = document.createElement('tr');
      tr.tabIndex = r.n - 1 === stop ? 0 : -1;
      const said = `hole ${r.n}: Ø ${holeDia(r, deps.lenText)} at ${r.said} ${deps.unit()}`;
      tr.setAttribute?.('aria-label', said);
      // depth: through holes' (rim to rim); "–" for one rim (blind, or a
      // sheet's hole)
      // (a countersunk or chamfered one: its wider rim's diameter after the bore's)
      for (const c of [String(r.n), holeDia(r, deps.num), r.at, r.through ? deps.num(r.depth) : '–']) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      const pick = (key) => {
        st.holes.pick = r.n - 1;
        for (const x of tb.children) {
          x.classList.toggle('pick', x === tr);
          x.tabIndex = x === tr ? 0 : -1; // (Tab back in lands on the pick: R128-3)
          if (x === tr) x.setAttribute?.('aria-current', 'true'); else x.removeAttribute?.('aria-current');
        }
        // (the coordinates named, not the column's head pasted in: R29-3)
        // (Enter while measuring a distance or an angle: the hole's centre is a point, the keyboard's
        // one way to place one -- R127-1)
        const h = st.holes.list[r.n - 1];
        if (key && st.on && (st.mode === 'distance' || st.mode === 'angle') && h) {
          st.pending.push({ p: h.centre.slice(), kind: 'centre' });
          deps.tell(`${said}: point ${st.pending.length} of ${need()}`, 3000);
          if (st.pending.length >= need()) finish(); else syncRow();
        } else deps.tell(said, 3000);
        deps.queueFrame();
      };
      tr.onclick = () => pick(false);
      tr.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(true); return; }
        const rows = [...tb.children], i = rows.indexOf(tr);
        const j = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: rows.length - 1 }[e.key];
        if (j === undefined || !rows[j]) return;
        e.preventDefault();
        for (const x of rows) x.tabIndex = x === rows[j] ? 0 : -1;
        rows[j].focus();
      };
      if (st.holes.pick === r.n - 1) { tr.classList.add('pick'); tr.setAttribute?.('aria-current', 'true'); } // (a kept pick: R26-1)
      tb.append(tr);
    }
    $('holescsv').onclick = () => {
      const u = deps.unit();
      const csv = [`n,diameter (${u}),"${t.posHead}",depth (${u}),rim diameter (${u})`,
        ...t.rows.map((r) => `${r.n},${deps.num(r.d)},"${r.at}",${r.through ? deps.num(r.depth) : ''},${r.head ? deps.num(r.head) : ''}`),
        ...(t.untold || t.unpaired ? [`# ${untoldText(t.untold, t.unpaired)}`] : [])].join('\n');
      copyText(csv, 'hole table copied');
    };
    // no hole at all: one line saying so, not an empty table under a caption (UI design round 5 V-2)
    const none = !t.list.length;
    box.querySelector('table').hidden = none;
    $('holesfrom').hidden = $('holessumbox').hidden = none;
    $('holescsv').hidden = none;
    if (none && note.hidden) { note.hidden = false; note.textContent = 'No round holes found'; }
    // (said as the table opens or its count changes, not again on every rebuild: R127-5)
    const fresh = box.hidden || st.holesSaid !== t.list.length, opened = box.hidden;
    st.holesSaid = t.list.length;
    box.hidden = false;
    if (opened) onNote();
    deps.queueFrame();
    if (fresh) deps.announce(`${t.list.length} holes${t.untold || t.unpaired ? `; ${untoldText(t.untold, t.unpaired)}` : ''}`);
    return t;
  }

  $('measure').onclick = () => setOn(!st.on, true);
  $('measoff').onclick = () => (deps.view2d?.() ? deps.toggle2D() : setOn(false, true));
  for (const b of $('measmode').querySelectorAll('button')) {
    b.onclick = () => { st.mode = b.dataset.mode; st.pending = []; st.snap = null; syncRow(); deps.queueFrame(); };
  }
  // (a button its press hides or greys: the focus to Measure's × or button, R43-2)
  const handOn = (b, f) => () => {
    const kb = !!b.matches?.(':focus-visible'); // (a key's press, not a mouse's or a finger's: R44-6)
    f();
    if (kb && (b.disabled || b.hidden || !b.getClientRects().length)) (st.on || deps.view2d?.()?.measuring ? $('measoff') : offFocus()).focus(); // (a drawing's too: R45-4)
  };
  // (in a drawing, its results: R44-4)
  $('measundo').onclick = handOn($('measundo'), () => { const v = deps.view2d?.(); if (v) { const w = v.undoMeasure(); sync2D(v); if (w) deps.tell(w, 2000); } else undo(); });
  // the note's text: Enter pins it, Esc drops the note (and stays in Measure)
  // (the field gone, the focus to the Note mode's button, not the header's first control: R120-3)
  const noteBack = () => { if ($('measnotetext').hidden) $('measmode')?.querySelector?.('[data-mode="note"]')?.focus?.(); };
  $('measnotetext').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addNote($('measnotetext').value); noteBack(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); st.pending = []; syncRow(); deps.queueFrame(); noteBack(); }
  });
  $('measclear').onclick = handOn($('measclear'), () => {
    const v = deps.view2d?.();
    if (v) { const k = v.results.length; v.clearMeasure(); sync2D(v); if (k) deps.announce(`${k} result${k === 1 ? '' : 's'} cleared`); return; }
    const n = st.results.length;
    st.pending = []; st.results = []; setList(false); syncRow(); deps.queueFrame();
    if (n) deps.announce(`${n} result${n === 1 ? '' : 's'} cleared`);
  });
  $('measchip').onclick = () => setList(!st.listOpen);

  // every length result written again in the unit now shown (the unit picker changed, or results
  // given back after a tour): a result kept the unit it was taken in, "25.40 mm" beside "size (in)
  // 3.94" (r91 Q1, r92 A1)
  function relabel() {
    for (const r of st.results) {
      if (r.mode === 'distance') {
        const n = pointResult('distance', r.pts);
        r.main = n.main;
        if (!r.fixed) r.sub = n.sub; // (a clearance's sub is its name)
      } else if (r.mode === 'face' && typeof r.value === 'number') r.main = deps.lenText(r.value);
    }
    syncRow();
    deps.queueFrame();
  }

  return {
    get on() { return st.on; }, get mode() { return st.mode; }, get results() { return st.results; }, get pending() { return st.pending; },
    get snap() { return st.snap; },
    get holes() { return st.holes; },
    // a body's measured geometry (mesh index), built once (js/drawing-svg.js)
    geometry: (mi) => { model(); return geomOf(mi, Infinity); },
    // (for tests: whether q is inside a closed body, walked into the plane pl's kept side)
    insideAt: (q, pl) => { model(); return insideClosed(q, scene.header.meshes.map((_, i) => i), pl, null); },
    get loupeShown() { return !!st.loupe; },
    setOn, hover, place, draw, paint, escape, reset, undo, sync2D, snapAt, faceAt, dotAt, moveDot, endDot, loupe, showHoles, notes, setNotes, addNote, setMode: (m) => { st.mode = m; st.pending = []; syncRow(); },
    // the results that are not notes (distances, angles...), taken off the view and given back:
    // a tour step holds notes only, so while one plays they are set aside (main.js startTour)
    setAside() {
      const kept = st.results.filter((r) => r.mode !== 'note');
      st.results = st.results.filter((r) => r.mode === 'note');
      st.pending = [];
      syncRow();
      deps.queueFrame();
      return kept;
    },
    // (in the unit shown now: the unit picked during a tour gave them back "25.40 mm" -- r92 A1)
    putBack(kept) {
      if (!kept || !kept.length) return;
      st.results.push(...kept);
      relabel();
    },
    relabel,
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
