// Measure: Distance (two points: length
// and ΔX ΔY ΔZ), Angle (three points, at the middle one) and Face to face
// (two b-rep faces, the first planar: the gap along its normal). Points snap,
// within 12 CSS px of the pointer (24 on a coarse pointer), to a b-rep corner
// (◆), an edge's midpoint (▲), a circle's centre (⊙, with its Ø) or the
// nearest point on an edge (―), from js/measure-geom.js; else the surface
// under the pointer -- under a section, where a closed body's cut face is drawn,
// the point on the cut (▪; Face to face and Paint take no face there). Only VISIBLE candidates are offered: nothing may cut the
// segment from the eye to the point (js/raycast.js), except where the style
// draws hidden edges (Wire, X-ray, Hidden grey). Points are kept in model
// coordinates; results are drawn on an SVG layer over the view, projected
// each frame, so every backend shows them the same.
//
// main.js owns the input; it calls hover / place, loupe (a finger aiming),
// dotAt / moveDot / endDot (dragging a placed end dot) and draw, and asks
// escape() first.

import { UNTOLD_SHARE, angleAt, arcOf, bodyGeometry, distance, faceGap, holesOf, orderHoles, polyLength, polyMid } from './measure-geom.js';
// A hole row's diameter as the table, its summary and the picked row's words write it -- with its
// countersink, one text (the summary grouped a countersunk Ø3 with plain ones, and the announcement
// left the countersink out: r68 A8, Q11). r: { d, head } (or a group's); fmt: the number's writer.
// (what is measured: the wider rim's Ø, a countersink's or a chamfer's alike -- "countersunk" named
// a 0.3 deburr one: r69 A4)
export const holeDia = (r, fmt) => `${fmt(r.d)}${r.head ? ` (${fmt(r.head)} at its rim)` : ''}`;
// The rims a hole table leaves out, said: one sentence for the summary, the CSV and the announcement
// (the summary alone said it, the copy and the announcement "41 holes" did not -- r67 A3, Q5), and
// the through-holes left out as their other rim is one of them, their own rim told (counted among
// the rims, it was one too small to tell that was not: r69 Q7)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
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

// deps: { $, scene: { mesh, header, hidden, sphere } (the model as converted,
//   its header, the hidden body ids, its bounding sphere: read when used),
//   view() -> { vp, eye, dir, right, up, ortho, tanV, w, h, target, dist },
//   sectionPlane(), lenText(mm) "4.00 mm", num(mm) "4.00", unit() "mm", announce(text),
//   tell(text, ms, said) (shown where the view's notes go and read out -- `said` if it differs;
//   main.js's one rule, not a second kept here: r46 A3), queueFrame(), syncOptbar(),
//   coarse(), showsHidden(), closed(mi) (the body is closed: closedOf), beforeOn() (run as
//   Measure turns on) }
// The point of segment a-b nearest the ray { o, d }: the edge point under the pointer, in perspective
// as in ortho. Parallel to the ray (an edge seen end on), t: the screen parameter's point.
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
    listOpen: false, holes: null,
  };
  const layer = $('measvg');
  const labels = $('measlabels');
  $('measnotetext').maxLength = NOTE_TEXT_MAX; // (a note's one limit, js/view-link.js)

  // ---- the model's caches ----
  function model() {
    const m = scene.mesh;
    if (m !== st.model) { st.model = m; st.geom = new Map(); st.caster = m ? makeCaster(m) : null; }
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
      if (behind || (x >= x0 - r && x <= x1 + r && y >= y0 - r && y <= y1 + r)) out.push(i);
    }
    return out;
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
  // a point inside a closed body among these, by the parity of the walls a ray from it crosses, into
  // the section's kept side (its normal reversed) -- each body walked on its own: walked together, a
  // part's bottom in the plane of the board's top was stepped past uncounted, the part read as solid
  // there and its visible edges as hidden (r127 H1)
  // A walk whose ray meets a triangle on its border (an edge, a corner) cannot tell a crossing from
  // a graze -- a ridge touched from outside counted once, the point read as inside -- so the body is
  // walked again along two rays tilted by about 1/100 rad, the first walk without a border hit
  // deciding, else the three by majority (r127 L1, r128 L3)
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
    for (const mi of near) {
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
          // the point of the edge nearest the pointer's ray: the screen parameter is no measure
          // along it in perspective, and a straight b-rep edge is one segment however long -- a
          // 100 mm board edge snapped 3.6 to 7.1 mm from the point under the cursor (r108 M1)
          const p = nearestOnRay(line[i - 1], line[i], pray, t);
          if (skip && skip(p)) continue; // (an edge the section cut away, as consider's: r126 M1)
          edgePts.push({ p, kind: 'edge', mesh: mi, info: { length: g.mids[e].len, diameter: null }, dd });
        }
      }
    }
    // nearest on screen; within a pixel, the one nearer the eye: a
    // through-hole's two rims share a centre on screen, and the front one wins
    // (the back one is seen through the hole, so the visibility test passes it)
    // (by runs: sorted by distance, each run the points within a pixel of its first, a run's points
    // nearest the eye first -- one comparator "within a pixel, else nearer" was not transitive, so
    // the order could depend on the input's -- r122 L2)
    // a corner, midpoint or centre before a point on an edge; the nearest
    // visible one of each: the 24 nearest on screen tried, and past them more while the snap's 40 ms
    // last. (On V2C, a part's hidden pins under the board, nearer on screen, were 24 and more, and a
    // corner the view draws 3.4 px away read "surface": the order of the 24 alone had found it, by an
    // unstable sort's luck; 96 was not enough either, ten hidden pins giving 200 -- r134 M3.)
    // snapOrder orders each run of them.
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
    // (its outside: a surface, not the cut -- by the vertex normals interpolated at the hit, the
    // view's own per-fragment test (js/raycast.js seesInside); the winding, turned by the body's
    // signed volume, was a second rule, and the centroid's normal a third near an outline)
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
  // The end dot within 11 CSS px (a 22 px target) of (x, y), nearest first:
  // { r, i } (result, point index) | null. A Face to face result's ends are
  // picks of faces, and a distance found elsewhere (the clearance check) is
  // that check's; neither is dragged.
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
    if (!scene.header || (!st.results.length && !st.holes)) return;
    const v = projector();
    const P = (p) => { const q = v.toScreen(p); return q && [q[0] * s, q[1] * s]; };
    const ink = light ? INK.light : INK.dark;
    ctx.save();
    ctx.lineCap = 'round';
    for (const r of st.results) {
      const q = r.pts.map(P);
      if (q.some((x) => !x)) continue;
      ctx.strokeStyle = ink.line;
      ctx.lineWidth = 2.5 * s;
      ctx.beginPath();
      q.forEach((x, i) => (i ? ctx.lineTo(...x) : ctx.moveTo(...x)));
      ctx.stroke();
      ctx.fillStyle = ink.line;
      for (const x of q) { ctx.beginPath(); ctx.arc(x[0], x[1], 4 * s, 0, 2 * Math.PI); ctx.fill(); }
      const at = r.mode === 'angle' ? q[1] : [(q[0][0] + q[q.length - 1][0]) / 2, (q[0][1] + q[q.length - 1][1]) / 2];
      ctx.font = `${12 * s}px system-ui, sans-serif`;
      const w = Math.max(ctx.measureText(r.main).width, r.sub ? ctx.measureText(r.sub).width * 0.85 : 0) + 12 * s;
      const h = (r.sub ? 32 : 18) * s;
      const x0 = at[0] - w / 2, y0 = at[1] - h - 8 * s;
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
      st.holes.list.forEach((h, i) => {
        const q = P(h.centre);
        if (!q) return;
        ctx.strokeStyle = i === st.holes.pick ? INK.dark.line : HOLE;
        ctx.lineWidth = 2 * s;
        ctx.beginPath(); ctx.arc(q[0], q[1], 6 * s, 0, 2 * Math.PI); ctx.stroke();
        ctx.fillStyle = ink.text;
        ctx.fillText(String(i + 1), q[0] + 8 * s, q[1] - 18 * s);
      });
    }
    ctx.restore();
  }

  // ---- the options bar row ----
  function syncRow() {
    // the bar shows while measuring, and while results stay drawn with
    // Measure off -- then only what removes them (the list, Clear all): the
    // results on screen are always removable from the screen
    // (results the user made; a tour's callouts and the notes a list or a
    // view link pins are the page's, and never pop the bar up on their own)
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
      // (a copy that fails, or no clipboard: said -- it was said nowhere: r46 Q6)
      copy.onclick = () => copyText(t.textContent, 'copied');
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
    // (a mesh with no b-rep faces -- an STL, an OBJ, a .cadmesh written without them -- has no
    // corners, edges or circles to snap to, which nothing said: r121 L2)
    const plain = on && scene.mesh && !scene.mesh.faces;
    deps.tell(on ? `Measure: click points on the model (Esc to stop)${plain ? '. This file has triangles only, no CAD faces: points snap to the surface, not to corners, edges or centres' : ''}` : '', plain ? 6000 : 3000, on ? 'measure on' : 'measure off');
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
  // The holes of the parts in ids (a board: its mounting holes), from the
  // reference box's min corner (js/datum.js's corner), in the two file axes
  // across the hole's axis when that is a file axis (a board's X and Y), all
  // three otherwise. ids null closes it.
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
    const shared = list.every((h) => axesOf(h).join() === first);
    const rows = list.map((h, i) => {
      const at = axesOf(h).map((j) => `${shared ? '' : `${'XYZ'[j]} `}${deps.num(h.centre[j] - ref.min[j])}`).join(shared ? ', ' : ' · ');
      // (head: a countersunk hole's countersink diameter -- js/measure-geom.js holesOf, r67)
      return { n: i + 1, d: h.diameter, at, through: h.rims > 1, depth: h.depth, head: h.head || 0 };
    });
    const posHead = list.length && shared ? `${first.split(',').map((j) => 'XYZ'[j]).join(', ')} (${deps.unit()})` : `position (${deps.unit()})`;
    // per diameter as shown: how many, and how far apart their centres spread
    // (keyed on the printed value: 0.508 and 0.511 mm read as two "0.51" lines)
    // (and its countersink: a countersunk Ø3 and a plain one read "Ø 3.00 mm × 2" -- r68 A8, Q11)
    // (one size one line whatever it prints as: a Ø on a rounding half-step, 0.0215 in, read
    // "0.021 in × 2" + "0.022 in × 3" -- r123 M2. A size: a Ø within 1e-4 of the one before it, as
    // the list is ordered)
    const groups = new Map(), sizeOf = new Map();
    let sid = -1, prev = -Infinity;
    for (const h of list) {
      if (!(Math.abs(h.diameter - prev) <= 1e-4 * h.diameter)) sid++;
      prev = h.diameter;
      const p = deps.num(h.diameter);
      if (!sizeOf.has(p)) sizeOf.set(p, sid);
      const key = `${sizeOf.get(p)}|${h.head ? deps.num(h.head) : ''}`;
      if (!groups.has(key)) groups.set(key, { d: h.diameter, head: h.head || 0, n: 0, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], normal: h.normal });
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
    if (!ids || !ids.length) { st.holes = null; box.hidden = true; deps.queueFrame(); return null; }
    const t = holeRows(ids, ref);
    st.holes = { list: t.list, pick: -1 };
    $('holestitle').textContent = `Holes of ${name} (${t.list.length})`;
    const sum = $('holessum');
    sum.replaceChildren();
    for (const g of t.groups) {
      const ax = g.normal.map(Math.abs);
      const k = ax.indexOf(Math.max(...ax));
      // (holes along different axes -- a top face's and a side wall's -- spread in all three: the
      // first hole's two cross axes left the third out, r124 L4)
      const mixed = g.axes && g.axes.size > 1;
      const spread = [0, 1, 2].filter((j) => mixed || j !== k).map((j) => deps.lenText(g.hi[j] - g.lo[j])).join(' × ');
      const li = document.createElement('li');
      li.textContent = `Ø ${holeDia(g, deps.lenText)} × ${g.n}${g.n > 1 ? ` · centres span ${spread}` : ''}`;
      sum.append(li);
    }
    $('holesdia').textContent = `Ø (${deps.unit()})`;
    $('holespos').textContent = t.posHead;
    $('holesdepth').textContent = `depth (${deps.unit()})`; // (its numbers had no unit: r124 L1)
    const from = document.createElement('li');
    from.textContent = `positions from the corner of ${ref.name || 'the whole model'}`;
    sum.prepend(from);
    if (t.untold || t.unpaired) {
      const un = document.createElement('li');
      un.textContent = untoldText(t.untold, t.unpaired);
      sum.append(un);
    }
    const tb = $('holesrows');
    tb.replaceChildren();
    for (const r of t.rows) {
      const tr = document.createElement('tr');
      tr.tabIndex = 0;
      // depth: through holes' (rim to rim); "–" for one rim (blind, or a
      // sheet's hole)
      // (a countersunk or chamfered one: its wider rim's diameter after the bore's)
      for (const c of [String(r.n), holeDia(r, deps.num), r.at, r.through ? deps.num(r.depth) : '–']) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      const pick = () => {
        st.holes.pick = r.n - 1;
        for (const x of tb.children) x.classList.toggle('pick', x === tr);
        const said = `hole ${r.n}: Ø ${holeDia(r, deps.lenText)} at ${t.posHead} ${r.at}`;
        deps.tell(said, 3000);
        deps.queueFrame();
      };
      tr.onclick = pick;
      tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
      tb.append(tr);
    }
    $('holescsv').onclick = () => {
      const u = deps.unit();
      const csv = [`n,diameter (${u}),"${t.posHead}",depth (${u}),rim diameter (${u})`,
        ...t.rows.map((r) => `${r.n},${deps.num(r.d)},"${r.at}",${r.through ? deps.num(r.depth) : ''},${r.head ? deps.num(r.head) : ''}`),
        ...(t.untold || t.unpaired ? [`# ${untoldText(t.untold, t.unpaired)}`] : [])].join('\n');
      copyText(csv, 'hole table copied');
    };
    box.hidden = false;
    deps.queueFrame();
    deps.announce(`${t.list.length} holes${t.untold || t.unpaired ? `; ${untoldText(t.untold, t.unpaired)}` : ''}`);
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
  $('measclear').onclick = () => {
    const n = st.results.length;
    st.pending = []; st.results = []; setList(false); syncRow(); deps.queueFrame();
    if (n) deps.announce(`${n} result${n === 1 ? '' : 's'} cleared`);
  };
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
    setOn, hover, place, draw, paint, escape, reset, undo, snapAt, faceAt, dotAt, moveDot, endDot, loupe, showHoles, notes, setNotes, addNote, setMode: (m) => { st.mode = m; st.pending = []; syncRow(); },
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
