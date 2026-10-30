// 2D DXF drawings (plan feature 23; feature review item 23): a group-code
// parser, model space only, flattened to what a 2D canvas strokes:
//   { units, sourceUnits, layers: [{ name, colour, on }], extents,
//     paths: [{ layer, colour, pts: Float64Array xy..., closed, fill }],
//     texts: [{ layer, colour, x, y, h, rot, text, align }] }
// LINE, LWPOLYLINE (bulges), POLYLINE / VERTEX, CIRCLE, ARC, ELLIPSE, SPLINE
// (evaluated: weights, fit points as the polyline when no control points),
// POINT, TEXT, MTEXT (formatting stripped), INSERT and MINSERT (nested,
// scaled, rotated, arrayed), DIMENSION (its block), HATCH (solid fill, else
// its outline), SOLID / TRACE. The object coordinate system (210/220/230,
// the arbitrary-axis rule) is applied; BYLAYER and BYBLOCK resolve through
// nested inserts; ACI and true colour (420). $INSUNITS gives the unit
// (0: not stored). DWG is not read (a licence decision: plan feature 23).
//
// Pure ES module, no DOM.

const SEG_RAD = Math.PI / 36; // arcs flattened at 5° a segment (finer when big: see arcPts)

// group-code pairs from the text
function pairs(s) {
  const lines = s.split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([parseInt(lines[i], 10), lines[i + 1]]);
  return out;
}

// The entity records of a section, each { type, g: [[code, value], ...] }
function records(ps, from, to) {
  const out = [];
  let cur = null;
  for (let i = from; i < to; i++) {
    const [c, v] = ps[i];
    if (c === 0) { cur = { type: v.trim(), g: [] }; out.push(cur); } else if (cur) cur.g.push([c, v]);
  }
  return out;
}
const get = (r, c, d) => { const p = r.g.find((x) => x[0] === c); return p ? p[1].trim() : d; };
const num = (r, c, d = 0) => { const v = get(r, c, null); return v === null ? d : Number(v); };
const all = (r, c) => r.g.filter((x) => x[0] === c).map((x) => Number(x[1]));

export const UNITS = { 1: ['in', 25.4], 2: ['ft', 304.8], 4: ['mm', 1], 5: ['cm', 10], 6: ['m', 1000], 8: ['uin', 25.4e-6], 9: ['mil', 0.0254], 10: ['yd', 914.4], 13: ['um', 0.001], 14: ['dm', 100] };

export function parseDXF(s) {
  if (!/^\s*0\s*\r?\n\s*SECTION/.test(s)) throw new Error('not an ASCII DXF file (a binary DXF or a DWG is not read)');
  const ps = pairs(s);
  // the sections by name
  const sec = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i][0] === 0 && ps[i][1].trim() === 'SECTION' && ps[i + 1] && ps[i + 1][0] === 2) {
      const name = ps[i + 1][1].trim();
      let j = i + 2;
      while (j < ps.length && !(ps[j][0] === 0 && ps[j][1].trim() === 'ENDSEC')) j++;
      sec[name] = [i + 2, j];
      i = j;
    }
  }
  // header: $INSUNITS, $LTSCALE
  let insunits = 0, ltscale = 1;
  if (sec.HEADER) {
    for (let i = sec.HEADER[0]; i < sec.HEADER[1]; i++) {
      if (ps[i][0] !== 9 || !ps[i + 1]) continue;
      if (ps[i][1].trim() === '$INSUNITS') insunits = Number(ps[i + 1][1]);
      if (ps[i][1].trim() === '$LTSCALE') ltscale = Number(ps[i + 1][1]) || 1;
    }
  }
  // layers (colour, line type, line weight) and line types (dash patterns)
  const layers = new Map();
  const ltypes = new Map(); // upper-case name -> [dash, gap, ...] in drawing units, or null (continuous)
  if (sec.TABLES) {
    for (const r of records(ps, ...sec.TABLES)) {
      if (r.type === 'LTYPE') {
        // 49: each element's length (+ dash, - gap, 0 dot); shapes and text in a
        // pattern are not drawn (their space is kept)
        const els = all(r, 49);
        ltypes.set(get(r, 2, '').toUpperCase(), els.length ? els.map((x) => (x === 0 ? 0.0001 : Math.abs(x))) : null);
        continue;
      }
      if (r.type !== 'LAYER') continue;
      const aci = num(r, 62, 7);
      const tc = get(r, 420, null);
      layers.set(get(r, 2, '0'), { name: get(r, 2, '0'), colour: tc !== null ? trueColour(Number(tc)) : aciColour(Math.abs(aci)), on: aci >= 0 && !(num(r, 70) & 1),
        ltype: get(r, 6, 'CONTINUOUS').toUpperCase(), weight: num(r, 370, -3) });
    }
  }
  if (!layers.has('0')) layers.set('0', { name: '0', colour: aciColour(7), on: true });
  // blocks: name -> { base, recs }
  const blocks = new Map();
  if (sec.BLOCKS) {
    let cur = null;
    for (const r of records(ps, ...sec.BLOCKS)) {
      if (r.type === 'BLOCK') { cur = { base: [num(r, 10), num(r, 20)], recs: [] }; blocks.set(get(r, 2, ''), cur); } else if (r.type === 'ENDBLK') cur = null;
      else if (cur) cur.recs.push(r);
    }
  }
  const out = { paths: [], texts: [] };
  const ents = sec.ENTITIES ? records(ps, ...sec.ENTITIES) : [];
  emit(ents, IDENT, null, 0, { layers, blocks, out, ltypes, ltscale });
  for (const p of out.paths) if (!layers.has(p.layer)) layers.set(p.layer, { name: p.layer, colour: aciColour(7), on: true });
  const u = UNITS[insunits];
  return { units: u ? u[0] : null, mmPerUnit: u ? u[1] : null, insunits,
    layers: [...layers.values()], paths: out.paths, texts: out.texts, extents: extentsOf(out) };
}

// 2D affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
const IDENT = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// The arbitrary-axis rule: an entity's OCS x and y axes from its extrusion
// N, projected onto the world XY plane (a 2D view from +Z)
function ocs(r) {
  const nx = num(r, 210, 0), ny = num(r, 220, 0), nz = num(r, 230, 1);
  if (nx === 0 && ny === 0 && nz === 1) return IDENT;
  const l = Math.hypot(nx, ny, nz) || 1;
  const N = [nx / l, ny / l, nz / l];
  const W = Math.abs(N[0]) < 1 / 64 && Math.abs(N[1]) < 1 / 64 ? [0, 1, 0] : [0, 0, 1];
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nrm = (v) => { const k = Math.hypot(...v) || 1; return v.map((x) => x / k); };
  const Ax = nrm(cr(W, N));
  const Ay = nrm(cr(N, Ax));
  return [Ax[0], Ax[1], Ay[0], Ay[1], 0, 0];
}

// the colour of a record: its own (420 true, 62 ACI), BYBLOCK (0) the
// insert's, BYLAYER (256, or none) its layer's
function colourOf(r, ctx, byBlock, layer) {
  const tc = get(r, 420, null);
  if (tc !== null) return trueColour(Number(tc));
  const aci = num(r, 62, 256);
  if (aci === 0) return byBlock || aciColour(7);
  if (aci === 256) return (ctx.layers.get(layer) || {}).colour || aciColour(7);
  return aciColour(Math.abs(aci));
}

function emit(recs, M, byBlock, depth, ctx) {
  if (depth > 16) return;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    let layer = get(r, 8, '0');
    // an entity on layer 0 inside a block takes the insert's layer
    if (layer === '0' && byBlock && byBlock.layer) layer = byBlock.layer;
    const colour = colourOf(r, ctx, byBlock && byBlock.colour, layer);
    // the line type (BYLAYER / BYBLOCK resolved) as a dash pattern in drawing
    // units ($LTSCALE x the entity's 48 x the insert's scale), and the line
    // weight in mm (370: 1/100 mm; -1 BYLAYER, -2 BYBLOCK, -3 the default)
    const L = ctx.layers.get(layer) || {};
    let lt = get(r, 6, 'BYLAYER').toUpperCase();
    if (lt === 'BYLAYER') lt = L.ltype || 'CONTINUOUS';
    else if (lt === 'BYBLOCK') lt = (byBlock && byBlock.ltype) || 'CONTINUOUS';
    const pat = ctx.ltypes.get(lt);
    const k = ctx.ltscale * num(r, 48, 1) * Math.hypot(M[0], M[1]);
    let lw = num(r, 370, -1);
    if (lw === -1) lw = L.weight ?? -3;
    else if (lw === -2) lw = byBlock && byBlock.weight !== undefined ? byBlock.weight : -3;
    const sty = { dash: pat ? pat.map((x) => x * k) : null, weight: lw >= 0 ? lw / 100 : null, ltype: lt };
    const O = mul(M, ocs(r));
    const path = (pts, closed = false, fill = false) => {
      const f = new Float64Array(pts.length);
      for (let k = 0; k < pts.length; k += 2) { const [x, y] = ap(O, pts[k], pts[k + 1]); f[k] = x; f[k + 1] = y; }
      ctx.out.paths.push({ layer, colour, ...sty,pts: f, closed, fill });
    };
    switch (r.type) {
      case 'LINE': {
        // LINE's points are in world coordinates, not its OCS
        const a = ap(M, num(r, 10), num(r, 20)), b = ap(M, num(r, 11), num(r, 21));
        ctx.out.paths.push({ layer, colour, ...sty,pts: Float64Array.of(a[0], a[1], b[0], b[1]), closed: false, fill: false });
        break;
      }
      case 'POINT': {
        const [x, y] = ap(M, num(r, 10), num(r, 20));
        ctx.out.paths.push({ layer, colour, ...sty,pts: Float64Array.of(x, y, x, y), closed: false, fill: false, point: true });
        break;
      }
      case 'CIRCLE': path(arcPts(num(r, 10), num(r, 20), num(r, 40), 0, 2 * Math.PI), true); break;
      case 'ARC': {
        const a0 = (num(r, 50) * Math.PI) / 180;
        let a1 = (num(r, 51) * Math.PI) / 180;
        if (a1 <= a0) a1 += 2 * Math.PI;
        path(arcPts(num(r, 10), num(r, 20), num(r, 40), a0, a1));
        break;
      }
      case 'ELLIPSE': {
        // world coordinates: centre, the major axis end, the minor ratio
        const cx = num(r, 10), cy = num(r, 20), mx = num(r, 11), my = num(r, 21), ratio = num(r, 40, 1);
        let t0 = num(r, 41, 0), t1 = num(r, 42, 2 * Math.PI);
        if (t1 <= t0) t1 += 2 * Math.PI;
        // an ellipse seen from -Z runs the other way
        const flip = num(r, 230, 1) < 0 ? -1 : 1;
        const n = Math.max(8, Math.ceil((t1 - t0) / SEG_RAD));
        const pts = [];
        for (let k = 0; k <= n; k++) {
          const t = t0 + ((t1 - t0) * k) / n;
          const c = Math.cos(t), s = Math.sin(t) * flip;
          const [x, y] = ap(M, cx + mx * c - my * ratio * s, cy + my * c + mx * ratio * s);
          pts.push(x, y);
        }
        ctx.out.paths.push({ layer, colour, ...sty,pts: Float64Array.from(pts), closed: Math.abs(t1 - t0 - 2 * Math.PI) < 1e-9, fill: false });
        break;
      }
      case 'LWPOLYLINE': {
        const xs = all(r, 10), ys = all(r, 20);
        // bulges, in order, belong to the vertex before them
        const bul = new Array(xs.length).fill(0);
        let vi = -1;
        for (const [c, v] of r.g) { if (c === 10) vi++; else if (c === 42 && vi >= 0) bul[vi] = Number(v); }
        const closed = (num(r, 70) & 1) === 1;
        path(bulgePts(xs, ys, bul, closed), closed);
        break;
      }
      case 'POLYLINE': {
        // its VERTEX records follow it to SEQEND
        const xs = [], ys = [], bul = [];
        let j = i + 1;
        for (; j < recs.length && recs[j].type !== 'SEQEND'; j++) {
          if (recs[j].type !== 'VERTEX') continue;
          if (num(recs[j], 70) & 16) continue; // a spline frame control point
          xs.push(num(recs[j], 10)); ys.push(num(recs[j], 20)); bul.push(num(recs[j], 42));
        }
        i = j;
        const flags = num(r, 70);
        if (flags & (16 | 64)) break; // a 3D mesh or a polyface: not drawn in 2D
        const closed = (flags & 1) === 1;
        if (flags & 8) { const W = mul(M, IDENT); ctx.out.paths.push({ layer, colour, ...sty,pts: Float64Array.from(xs.flatMap((x, k) => ap(W, x, ys[k]))), closed, fill: false }); }
        else path(bulgePts(xs, ys, bul, closed), closed);
        break;
      }
      case 'SPLINE': {
        const pts = splinePts(r);
        if (pts.length >= 4) {
          const W = M; // splines are in world coordinates
          const f = new Float64Array(pts.length);
          for (let k = 0; k < pts.length; k += 2) { const [x, y] = ap(W, pts[k], pts[k + 1]); f[k] = x; f[k + 1] = y; }
          ctx.out.paths.push({ layer, colour, ...sty,pts: f, closed: (num(r, 70) & 1) === 1, fill: false });
        }
        break;
      }
      case 'SOLID': case 'TRACE': {
        const p = [num(r, 10), num(r, 20), num(r, 11), num(r, 21), num(r, 13, num(r, 12)), num(r, 23, num(r, 22)), num(r, 12), num(r, 22)];
        path(p, true, true);
        break;
      }
      case 'HATCH': {
        const solid = num(r, 70) === 1;
        for (const loop of hatchLoops(r)) path(loop, true, solid);
        break;
      }
      case 'TEXT': case 'MTEXT': {
        const raw = r.type === 'MTEXT' ? r.g.filter((x) => x[0] === 3 || x[0] === 1).map((x) => x[1]).join('') : get(r, 1, '');
        const t = r.type === 'MTEXT' ? mtextPlain(raw) : raw.replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±');
        if (!t.trim()) break;
        // TEXT with an alignment uses its second point
        const al = r.type === 'TEXT' ? num(r, 72, 0) : 0;
        const useB = r.type === 'TEXT' && (al || num(r, 73, 0));
        const [x, y] = ap(O, useB ? num(r, 11) : num(r, 10), useB ? num(r, 21) : num(r, 20));
        let rot = r.type === 'MTEXT' && get(r, 11, null) !== null ? Math.atan2(num(r, 21), num(r, 11)) : (num(r, 50) * Math.PI) / 180;
        // the transform's rotation and scale carried over
        rot += Math.atan2(O[1], O[0]);
        const h = num(r, 40, 1) * Math.hypot(O[2], O[3]);
        ctx.out.texts.push({ layer, colour, x, y, h, rot, text: t, align: r.type === 'MTEXT' ? mtextAlign(num(r, 71, 1)) : ['left', 'center', 'right', 'left', 'center', 'left'][al] || 'left', mtext: r.type === 'MTEXT' });
        break;
      }
      case 'INSERT': case 'DIMENSION': {
        const b = ctx.blocks.get(get(r, 2, ''));
        if (!b) break;
        const isDim = r.type === 'DIMENSION';
        const sx = isDim ? 1 : num(r, 41, 1), sy = isDim ? 1 : num(r, 42, 1);
        const rot = isDim ? 0 : (num(r, 50) * Math.PI) / 180;
        const cols = isDim ? 1 : Math.max(1, num(r, 70, 1)), rows = isDim ? 1 : Math.max(1, num(r, 71, 1));
        const dc = num(r, 44), dr = num(r, 45);
        const ix = isDim ? 0 : num(r, 10), iy = isDim ? 0 : num(r, 20);
        const inner = { colour, layer, ltype: lt, weight: lw };
        for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
          const c = Math.cos(rot), s = Math.sin(rot);
          // insertion point, then rotation and scale, the array cell, the block base
          const T = [c * sx, s * sx, -s * sy, c * sy, ix + c * ci * dc - s * ri * dr, iy + s * ci * dc + c * ri * dr];
          const B = [1, 0, 0, 1, -b.base[0], -b.base[1]];
          emit(b.recs, mul(isDim ? M : O, mul(T, B)), inner, depth + 1, ctx);
        }
        break;
      }
      default:
    }
  }
}

// an arc as points: radius r about (cx, cy) from a0 to a1 (radians, CCW)
function arcPts(cx, cy, r, a0, a1) {
  const n = Math.max(8, Math.ceil((a1 - a0) / SEG_RAD));
  const out = [];
  for (let k = 0; k <= n; k++) { const t = a0 + ((a1 - a0) * k) / n; out.push(cx + r * Math.cos(t), cy + r * Math.sin(t)); }
  return out;
}

// a polyline with bulges (tan of a quarter of each segment's arc angle)
export function bulgePts(xs, ys, bul, closed) {
  const out = [];
  const n = xs.length;
  for (let k = 0; k < n; k++) {
    out.push(xs[k], ys[k]);
    const j = k + 1 < n ? k + 1 : closed ? 0 : -1;
    if (j < 0 || !bul[k]) continue;
    const [x0, y0, x1, y1] = [xs[k], ys[k], xs[j], ys[j]];
    const th = 4 * Math.atan(bul[k]); // the arc's angle, signed (positive: CCW)
    const ch = Math.hypot(x1 - x0, y1 - y0);
    if (!ch) continue;
    const r = ch / (2 * Math.sin(Math.abs(th) / 2));
    // centre: (chord / 2) / tan(θ / 2) from the chord's midpoint along its
    // left normal (signed: past 180° it lies to the right)
    const h = ch / 2 / Math.tan(th / 2);
    const cx = (x0 + x1) / 2 - ((y1 - y0) / ch) * h, cy = (y0 + y1) / 2 + ((x1 - x0) / ch) * h;
    const a0 = Math.atan2(y0 - cy, x0 - cx);
    const steps = Math.max(2, Math.ceil(Math.abs(th) / SEG_RAD));
    for (let s = 1; s < steps; s++) { const a = a0 + (th * s) / steps; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
  }
  if (closed && n) out.push(xs[0], ys[0]);
  return out;
}

// a SPLINE as points: its control points through de Boor (weights as given),
// or its fit points when it has no control points
function splinePts(r) {
  const deg = num(r, 71, 3);
  const knots = all(r, 40);
  const cx = all(r, 10), cy = all(r, 20);
  const w = all(r, 41);
  if (cx.length < 2) {
    const fx = all(r, 11), fy = all(r, 21);
    return fx.flatMap((x, k) => [x, fy[k]]);
  }
  const n = cx.length;
  if (knots.length !== n + deg + 1) return cx.flatMap((x, k) => [x, cy[k]]);
  const W = w.length === n ? w : new Array(n).fill(1);
  const t0 = knots[deg], t1 = knots[n];
  const steps = Math.max(16, n * 8);
  const out = [];
  for (let s = 0; s <= steps; s++) {
    const t = Math.min(t1 - 1e-12 * Math.abs(t1 || 1), t0 + ((t1 - t0) * s) / steps);
    let k = deg;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    // homogeneous de Boor
    const d = [];
    for (let j = 0; j <= deg; j++) { const i = k - deg + j; d.push([cx[i] * W[i], cy[i] * W[i], W[i]]); }
    for (let rr = 1; rr <= deg; rr++) {
      for (let j = deg; j >= rr; j--) {
        const i = k - deg + j;
        const den = knots[i + deg - rr + 1] - knots[i];
        const a = den ? (t - knots[i]) / den : 0;
        d[j] = [0, 1, 2].map((c) => (1 - a) * d[j - 1][c] + a * d[j][c]);
      }
    }
    const p = d[deg];
    out.push(p[0] / p[2], p[1] / p[2]);
  }
  return out;
}

// HATCH boundary loops as point lists (polyline loops, and line / arc /
// ellipse edges); its pattern lines are not drawn
function hatchLoops(r) {
  const g = r.g;
  const loops = [];
  let i = g.findIndex((x) => x[0] === 91);
  if (i < 0) return loops;
  const nLoops = Number(g[i][1]);
  i++;
  const at = (c) => { while (i < g.length && g[i][0] !== c) i++; return i < g.length ? Number(g[i++][1]) : 0; };
  for (let L = 0; L < nLoops && i < g.length; L++) {
    const type = at(92);
    const pts = [];
    if (type & 2) {
      const hasB = at(72), closed = at(73), nv = at(93);
      const xs = [], ys = [], bs = [];
      for (let v = 0; v < nv; v++) { xs.push(at(10)); ys.push(at(20)); bs.push(hasB ? at(42) : 0); }
      pts.push(...bulgePts(xs, ys, bs, !!closed || true));
    } else {
      const ne = at(93);
      for (let e = 0; e < ne; e++) {
        const et = at(72);
        if (et === 1) { pts.push(at(10), at(20), at(11), at(21)); } else if (et === 2) {
          const cx = at(10), cy = at(20), rr = at(40); let a0 = (at(50) * Math.PI) / 180, a1 = (at(51) * Math.PI) / 180;
          const ccw = at(73);
          if (!ccw) [a0, a1] = [-a0, -a1];
          if (a1 <= a0) a1 += 2 * Math.PI;
          pts.push(...arcPts(cx, cy, rr, a0, a1));
        } else if (et === 3) {
          const cx = at(10), cy = at(20), mx = at(11), my = at(21), ratio = at(40); let t0 = (at(50) * Math.PI) / 180, t1 = (at(51) * Math.PI) / 180;
          at(73);
          if (t1 <= t0) t1 += 2 * Math.PI;
          for (let k = 0; k <= 32; k++) { const t = t0 + ((t1 - t0) * k) / 32; pts.push(cx + mx * Math.cos(t) - my * ratio * Math.sin(t), cy + my * Math.cos(t) + mx * ratio * Math.sin(t)); }
        } else if (et === 4) {
          // a spline edge: its control points
          at(94); const nk = at(95), nc = at(96);
          for (let k = 0; k < nk; k++) at(40);
          for (let k = 0; k < nc; k++) pts.push(at(10), at(20));
        }
      }
    }
    if (pts.length >= 6) loops.push(pts);
  }
  return loops;
}

// MTEXT without its formatting codes; \P is a new line
export function mtextPlain(s) {
  return s.replace(/\\P/g, '\n').replace(/\\[ACcFfHhQTWp][^;]*;/g, '').replace(/\\[LlOoKk]/g, '')
    .replace(/\\S([^;^]*)[\^#/]([^;]*);/g, '$1/$2').replace(/\\~/g, ' ').replace(/\\\\/g, '\\').replace(/[{}]/g, '')
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±');
}
const mtextAlign = (a) => ['left', 'center', 'right'][(a - 1) % 3] || 'left';

function extentsOf(out) {
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  for (const p of out.paths) for (let k = 0; k < p.pts.length; k += 2) {
    min[0] = Math.min(min[0], p.pts[k]); max[0] = Math.max(max[0], p.pts[k]);
    min[1] = Math.min(min[1], p.pts[k + 1]); max[1] = Math.max(max[1], p.pts[k + 1]);
  }
  for (const t of out.texts) {
    min[0] = Math.min(min[0], t.x); max[0] = Math.max(max[0], t.x + t.h * t.text.length * 0.6);
    min[1] = Math.min(min[1], t.y); max[1] = Math.max(max[1], t.y + t.h);
  }
  return min[0] === Infinity ? null : { min, max };
}

// ---------- colours ----------
const ACI_BASE = { 1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192] };
// ACI 10-249: 24 hues 15° apart, each in 5 brightnesses at full and half
// saturation (the standard table, to within a few levels); 250-255 greys
export function aciColour(i) {
  let c;
  if (ACI_BASE[i]) c = ACI_BASE[i];
  else if (i >= 10 && i <= 249) {
    const h = Math.floor((i - 10) / 10) * 15, v = (i - 10) % 10;
    const bright = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3][v];
    const sat = v % 2 ? 0.5 : 1;
    c = hsv(h, sat, bright);
  } else if (i >= 250 && i <= 255) c = [51, 80, 105, 130, 190, 255].map((g) => [g, g, g])[i - 250];
  else c = [255, 255, 255];
  return { r: c[0], g: c[1], b: c[2], aci: i };
}
const trueColour = (n) => ({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, aci: null });
function hsv(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
}

// The colour to draw on paper (#f4f4f2): ACI 7 black; anything under 3:1
// against the paper darkened until it reaches 3:1
export function onPaper(c) {
  if (c.aci === 7) return '#000000';
  let [r, g, b] = [c.r, c.g, c.b];
  for (let k = 0; k < 40 && contrastOnPaper(r, g, b) < 3; k++) { r *= 0.9; g *= 0.9; b *= 0.9; }
  return `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
}
function contrastOnPaper(r, g, b) {
  const lum = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
  const P = 0.2126 * lum(244) + 0.7152 * lum(244) + 0.0722 * lum(242);
  return (Math.max(L, P) + 0.05) / (Math.min(L, P) + 0.05);
}
