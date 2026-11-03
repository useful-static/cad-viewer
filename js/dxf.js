// 2D DXF drawings (plan feature 23; feature review item 23): a group-code
// parser, ASCII or binary: model space, and each layout (paper space: its own
// entities and model space through its viewports), flattened to what a 2D
// canvas strokes:
//   { units, insunits, layers: [{ name, colour, on }], extents, paperSpace,
//     paths: [{ layer, colour, pts: Float64Array xy..., closed, fill, dash, weight, ltype, width?,
//               point?, outline?, evenodd?, frame? }],
//     texts: [{ layer, colour, x, y, h, rot, text, align, valign, mtext, fit?, fitMode?, mirrorX?, mirrorY?,
//               widthFactor?, oblique?, wrap?, clip? }],
//     layouts: [{ name, paths, texts, extents }], notDrawn: { KIND: count } }
//   (a path's dash: its line type's pattern in drawing units, or null; weight: its line weight in
//   mm, or null; ltype: the line type's name; width: a polyline's, in drawing units -- a tapering
//   one, or one through a stretch, is its line plus filled outlines (outline: true, not a shape of
//   its own); point: a POINT; evenodd: one hatch's loops, filled together even-odd; frame: a layout
//   viewport's frame. mirrorX / mirrorY: drawn mirrored about the point -- a backward / upside-down text,
//   or one in a mirroring block; widthFactor: its width x that, its 41 and its block's stretch
//   along it; oblique: its slant in radians; wrap: an MTEXT's reference width; clip: a layout
//   viewport's frame [x0, y0, x1, y1] it is cut to. h, fit and wrap are lengths: TEXT_LENGTHS)
//   (align left / center / right; valign baseline / bottom / middle / top for a TEXT, top / middle /
//   bottom for an MTEXT, which hangs its lines from the point; fit: an aligned / fit text's
//   baseline length, fitMode 'aligned' (both ways) or 'fit' (width): js/dxf-view.js draws them so,
//   and textCorners boxes them so for the extents)
// LINE, LWPOLYLINE (bulges), POLYLINE / VERTEX, CIRCLE, ARC, ELLIPSE, SPLINE
// (evaluated: weights, fit points as the polyline when no control points),
// POINT, TEXT, MTEXT (formatting stripped), INSERT and MINSERT (nested,
// scaled, rotated, arrayed), DIMENSION, ARC_DIMENSION, LARGE_RADIAL_DIMENSION
// and ACAD_TABLE (their blocks), LEADER (its vertices), HATCH (solid fill, else
// its outline), SOLID / TRACE, 3DFACE (its visible edges), ATTRIB (an insert's attribute values,
// as TEXT; invisible ones left out). Every other kind but structure (STRUCTURE) is counted in
// notDrawn by name. The object coordinate system (210/220/230,
// the arbitrary-axis rule) is applied; BYLAYER and BYBLOCK resolve through
// nested inserts; ACI and true colour (420). $INSUNITS gives the unit
// (0: not stored). A DWG arrives here as group-code pairs from js/dwg.js:
// parseDXF takes the text or the pairs.
//
// Pure ES module, no DOM.

import { BINARY_DXF_SENTINEL, looksLikeDxf } from './formats.js';
import { MBCS, codePageLabel, decoderFor, dxfDecoder, isDoubleByte } from './codepages.js';
import { LENGTH_MM } from './units.js';
import { PAPER, contrast } from './styles.js';

const SEG_RAD = Math.PI / 36; // arcs flattened at 5° a segment, at least 8 to an arc (arcPts)

// A text DXF writes a control character in a string as a caret and the character 64 on ("^C" is
// U+0003, "^J" a line feed), and a caret itself as "^ " (DXF reference, "Group Codes in Numerical
// Order": control characters). Binary DXF holds the bytes as they are.
export function uncaret(s) {
  return s.indexOf('^') < 0 ? s : s.replace(/\^([@-_ ])/g, (m, ch) => (ch === ' ' ? '^' : String.fromCharCode(ch.charCodeAt(0) - 64)));
}
export function caret(s) {
  return /[\x00-\x1f^]/.test(s) ? s.replace(/[\x00-\x1f^]/g, (ch) => (ch === '^' ? '^ ' : '^' + String.fromCharCode(ch.charCodeAt(0) + 64))) : s;
}

// group-code pairs from the text
function pairs(s) {
  const lines = s.split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i], 10);
    out.push([c, valueKind(c) === 's' ? uncaret(lines[i + 1]) : lines[i + 1]]);
  }
  return out;
}

// A binary DXF: "AutoCAD Binary DXF\r\n\x1a\0", then group codes -- two
// bytes from R13, one in R12 (255 escaping a two-byte code) -- each value
// typed by its code. -> the same [code, string] pairs the text gives
export function isBinaryDXF(buf) {
  const b = new Uint8Array(buf, 0, Math.min(22, buf.byteLength));
  return b.length === 22 && String.fromCharCode(...b) === BINARY_DXF_SENTINEL;
}
export function valueKind(c) {
  if (c <= 9 || (c >= 100 && c <= 109) || (c >= 300 && c <= 309) || (c >= 320 && c <= 369) || (c >= 390 && c <= 399)
    || (c >= 410 && c <= 419) || (c >= 430 && c <= 439) || (c >= 470 && c <= 481) || c === 999 || (c >= 1000 && c <= 1003)
    || (c >= 1005 && c <= 1009)) return 's';
  if ((c >= 310 && c <= 319) || c === 1004) return 'bin';
  if ((c >= 10 && c <= 59) || (c >= 110 && c <= 149) || (c >= 210 && c <= 239) || (c >= 460 && c <= 469) || (c >= 1010 && c <= 1059)) return 'd';
  if ((c >= 90 && c <= 99) || (c >= 420 && c <= 429) || (c >= 440 && c <= 459) || c === 1071) return 'i32';
  if (c >= 160 && c <= 169) return 'i64';
  if (c >= 290 && c <= 299) return 'b';
  return 'i16';
}
function binaryPairs(buf) {
  const dv = new DataView(buf);
  const b = new Uint8Array(buf);
  // R12 writes the first code (0) as one byte, then "SECTION"; R13+ as two
  const oneByte = b[22] === 0 && b[23] !== 0;
  // Strings in the drawing's encoding: UTF-8 from R2007, its $DWGCODEPAGE before (always UTF-8, an
  // R2000 1252 drawing's "Ø20 ±0.1 90°" read "�20 �0.1 90�"). Each string's bytes are kept and
  // decoded once the header has said which; names the header itself uses ($ACADVER's value, the
  // page's name) are ASCII, read as Latin-1 meanwhile
  const ascii = new TextDecoder('latin1');
  const strs = []; // [index in out, start, end]
  const out = [];
  let o = 22;
  // every read checked first: a truncated file is "ends inside a value", not the engine's
  // "Offset is outside the bounds of the DataView"
  const need = (n) => { if (o + n > b.length) throw new Error('the binary DXF ends inside a value'); };
  while (o < b.length) {
    let c;
    if (oneByte) {
      c = b[o++];
      if (c === 255) { need(2); c = dv.getUint16(o, true); o += 2; }
    } else { need(2); c = dv.getUint16(o, true); o += 2; }
    const k = valueKind(c);
    let v;
    if (k === 's') {
      let e = o;
      while (e < b.length && b[e] !== 0) e++;
      need(e - o + 1);
      v = ascii.decode(b.subarray(o, e));
      strs.push([out.length, o, e]);
      o = e + 1;
    } else if (k === 'bin') { need(1); const n = b[o]; need(1 + n); v = ''; o += 1 + n; }
    else if (k === 'd') { need(8); v = String(dv.getFloat64(o, true)); o += 8; }
    else if (k === 'i32') { need(4); v = String(dv.getInt32(o, true)); o += 4; }
    else if (k === 'i64') { need(8); v = String(dv.getBigInt64(o, true)); o += 8; }
    else if (k === 'b') { need(1); v = String(b[o]); o += 1; }
    else { need(2); v = String(dv.getInt16(o, true)); o += 2; }
    out.push([c, v]);
    if (c === 0 && v === 'EOF') break;
  }
  // the header's version and code page (the first $ACADVER / $DWGCODEPAGE pairs), then the strings
  let ver = 0, page = null;
  for (let i = 0; i + 1 < out.length; i++) {
    if (out[i][0] === 0 && out[i][1] === 'ENDSEC') break; // (the header is the first section)
    if (out[i][0] !== 9) continue;
    if (out[i][1] === '$ACADVER') ver = Number((/AC(\d{4})/.exec(out[i + 1][1]) || [])[1]) || 0;
    if (out[i][1] === '$DWGCODEPAGE') page = out[i + 1][1];
  }
  // (js/codepages.js dxfDecoder: the choice the ASCII form makes too, its UTF-8 test over the strings)
  const fatal = new TextDecoder('utf-8', { fatal: true });
  const dec = dxfDecoder(ver, page, () => strs.every(([, s, e]) => { try { fatal.decode(b.subarray(s, e)); return true; } catch { return false; } }));
  for (const [i, s, e] of strs) out[i][1] = dec.decode(b.subarray(s, e));
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
// A record's first value of each code, indexed once (on first use, the record being complete):
// a block's entity is visited once per insert, and a scan of its groups for each of the dozen
// codes read per visit cost groups x inserts (one 100k-group entity in a 20 x 20 MINSERT: 9.5 s)
const firstOf = (r) => {
  if (!r.first) {
    const m = new Map();
    for (const [c, v] of r.g) if (!m.has(c)) m.set(c, v);
    r.first = m;
  }
  return r.first;
};
const get = (r, c, d) => { const v = firstOf(r).get(c); return v === undefined ? d : v.trim(); };
const num = (r, c, d = 0) => { const v = get(r, c, null); return v === null ? d : Number(v); };
const all = (r, c) => r.g.filter((x) => x[0] === c).map((x) => Number(x[1]));

// $INSUNITS: every unit the DXF reference lists (0 is "not stored") -> [name, mm per unit]
const INSUNITS = ['', 'in', 'ft', 'mi', 'mm', 'cm', 'm', 'km', 'uin', 'mil', 'yd', 'Å', 'nm', 'um', 'dm', 'dam', 'hm',
  'Gm', 'AU', 'ly', 'pc', 'US ft'];
export const UNITS = Object.fromEntries(INSUNITS.flatMap((n, code) => (n ? [[code, [n, LENGTH_MM[n]]]] : [])));

// The text of an ASCII DXF from its bytes: from R2007 (AC1021) UTF-8; before, the drawing's code
// page ($DWGCODEPAGE: ANSI_1252 for most, GBK for a Chinese drawing); with neither stated, UTF-8
// when the bytes are valid UTF-8, else Windows-1252. (Read as UTF-8, a pre-2007 file's ° ± Ø
// became U+FFFD; read as Latin-1, a UTF-8 one's accents were mangled.)
// the first place an ASCII name occurs in bytes from `from` on, or -1
function indexOfBytes(u8, name, from = 0) {
  const n = name.length, first = name.charCodeAt(0);
  for (let i = u8.indexOf(first, from); i >= 0 && i + n <= u8.length; i = u8.indexOf(first, i + 1)) {
    let k = 1;
    while (k < n && u8[i + k] === name.charCodeAt(k)) k++;
    if (k === n) return i;
  }
  return -1;
}
export function dxfText(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // the header variables, wherever the header is: the name as a group-9 value (the line before it
  // "9"), so a comment naming it is passed over -- the first occurrence, a comment's, missed the
  // header; then the decoder js/codepages.js chooses for both DXF forms
  const ver = headerValue(u8, '$ACADVER', /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*AC(\d{4})/);
  const cp = headerValue(u8, '$DWGCODEPAGE', /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/);
  const dec = dxfDecoder(ver, cp, () => { try { new TextDecoder('utf-8', { fatal: true }).decode(u8); return true; } catch { return false; } });
  // (a UTF-8 byte-order mark is not text in any code page, as the sniff in js/formats.js passes it
  // over: decoded as 1252 it read "ï»¿0", and a file the sniff took for a DXF was refused)
  const bom = u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf;
  return dec.decode(bom ? u8.subarray(3) : u8);
}

// A header variable's value in an ASCII DXF's bytes: each place its name stands as a group-9 value
// (the line before it is "9"), the value read by re from there; null if none
function headerValue(u8, name, re) {
  for (let i = indexOfBytes(u8, name, 0); i >= 0; i = indexOfBytes(u8, name, i + 1)) {
    const before = new TextDecoder('latin1').decode(u8.subarray(Math.max(0, i - 16), i));
    if (!/(^|\n)[ \t]*9[ \t]*\r?\n$/.test(before)) continue;
    const m = re.exec(new TextDecoder('latin1').decode(u8.subarray(i, i + 200)));
    if (m) return m[1];
  }
  return null;
}

// s: the file's text (ASCII DXF), or its bytes (an ArrayBuffer: binary DXF,
// or ASCII read from the bytes)
// (or the group-code pairs themselves, [[code, 'value'], ...]: js/dwg.js dwgToPairs)
export function parseDXF(s) {
  let ps;
  if (Array.isArray(s)) ps = s;
  else if (s instanceof ArrayBuffer) {
    if (isBinaryDXF(s)) ps = binaryPairs(s);
    else s = dxfText(s);
  }
  if (!ps) {
    if (!looksLikeDxf(s)) throw new Error('not a DXF file (no SECTION where it should start)');
    ps = pairs(s);
  }
  // names (a block's, a layer's, a line type's, a style's: 2, 6, 7, 8) with their \U+ / \M+
  // characters decoded, as a pre-R2007 DXF writes them outside its code page (texts decode their
  // own: textCodes, mtextPlain). The caller's pairs are left as they are
  let copied = false;
  for (let i = 0; i < ps.length; i++) {
    const [c, v] = ps[i];
    if ((c === 2 || c === 6 || c === 7 || c === 8) && typeof v === 'string' && v.indexOf('\\') >= 0) {
      const u = unescapeDxf(v);
      if (u !== v) { if (!copied) { ps = ps.slice(); copied = true; } ps[i] = [c, u]; }
    }
  }
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
  // ($DWGCODEPAGE too: a %%nnn above 127 is a character of the drawing's code page)
  let insunits = 0, ltscale = 1, codepage = 'windows-1252';
  if (sec.HEADER) {
    for (let i = sec.HEADER[0]; i < sec.HEADER[1]; i++) {
      if (ps[i][0] !== 9 || !ps[i + 1]) continue;
      if (ps[i][1].trim() === '$INSUNITS') insunits = Number(ps[i + 1][1]);
      if (ps[i][1].trim() === '$LTSCALE') ltscale = Number(ps[i + 1][1]) || 1;
      if (ps[i][1].trim() === '$DWGCODEPAGE') {
        const c = String(ps[i + 1][1]).trim().toUpperCase();
        codepage = codePageLabel(c) || codepage;
      }
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
  // model space only: an entity in paper space (67 = 1: a layout's title
  // block, its viewports' frames) is left out and counted, not drawn over
  // the model at the layout's sheet coordinates
  const every = sec.ENTITIES ? records(ps, ...sec.ENTITIES) : [];
  const inPaper = (r) => get(r, 67, '0') === '1';
  const ents = every.filter((r) => !inPaper(r));
  const paperSpace = every.filter((r) => inPaper(r) && !['VERTEX', 'SEQEND', 'ATTRIB'].includes(r.type)).length;
  // one budget for the whole drawing (model space and every layout): an untrusted file's MINSERT
  // array, a huge arc or blocks nested to fan out stop at it, not when the tab runs out of memory
  const budget = { items: 0, pts: 0 };
  // (a path or text with a coordinate that is not a number is left out: one LINE with "10 abc"
  // made the whole drawing's extents NaN and Fit useless)
  const notDrawn = {}; // kind -> how many met while drawing (model space and the layouts)
  const ctxOf = (o) => ({ layers, blocks, out: o, ltypes, ltscale, codepage, budget, notDrawn,
    add: (p) => { if (p.pts.every(Number.isFinite)) addItem(budget, o.paths, p, p.pts.length); },
    addText: (t) => { if (Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.h)) addItem(budget, o.texts, t, 2); } });
  emit(ents, IDENT, null, 0, ctxOf(out));
  // Layouts (paper space): the active one is the entities flagged 67 = 1,
  // others are the *Paper_Space<n> blocks. Each draws its own entities and,
  // through each VIEWPORT (but the sheet's own, id 1), model space: a model
  // point m lands at C + R(twist) (h / viewHeight) (m - viewCentre),
  // clipped to the viewport's frame, which is drawn too (frame: true)
  const sets = [];
  const active = every.filter(inPaper);
  if (active.length) sets.push(active);
  for (const [name, b] of blocks) if (/^\*Paper_Space\d+$/i.test(name) && b.recs.length) sets.push(b.recs);
  // each model path's box [x0, y0, x1, y1], once, for the viewports' cull
  const pathBoxes = sets.length ? out.paths.map(boxOf) : [];
  const layouts = sets.map((recs, li) => {
    const lo = { paths: [], texts: [] };
    emit(recs.filter((r) => r.type !== 'VIEWPORT'), IDENT, null, 0, ctxOf(lo));
    // a viewport's frame, on its layer
    const frame = (v, rect) => {
      const layer = get(v, 8, '0');
      lo.paths.push({ layer, colour: (layers.get(layer) || {}).colour || aciColour(7), dash: null, weight: null, ltype: 'CONTINUOUS',
        pts: Float64Array.of(rect[0], rect[1], rect[2], rect[1], rect[2], rect[3], rect[0], rect[3]), closed: true, fill: false, frame: true });
    };
    for (const v of recs) {
      if (v.type !== 'VIEWPORT' || num(v, 69, 0) === 1) continue;
      const cx = num(v, 10), cy = num(v, 20), w = num(v, 40), h = num(v, 41), vh = num(v, 45);
      if (!(w > 0 && h > 0)) continue;
      const rect = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
      // (one whose view is not known -- an R13-R14 DWG's, kept in a table not read -- is its frame)
      if (!(vh > 0)) { frame(v, rect); continue; }
      const s = h / vh, tw = (num(v, 51) * Math.PI) / 180;
      const c = Math.cos(tw) * s, si = Math.sin(tw) * s, mx = num(v, 12), my = num(v, 22);
      const M = [c, si, -si, c, cx - (c * mx - si * my), cy - (si * mx + c * my)];
      // (what a viewport draws of model space counts against the drawing's budget too: many
      // viewports multiply it)
      const p0 = lo.paths.length;
      // a path whose box lies outside what the viewport shows of model space is passed over
      // with one box test; each one clipped is walked (many viewports onto a big model
      // multiply it)
      const seen = viewInModel(M, rect);
      cull(budget, out.paths.length + out.texts.length);
      for (let k = 0; k < out.paths.length; k++) {
        const bb = pathBoxes[k];
        if (bb[2] < seen[0] || bb[0] > seen[2] || bb[3] < seen[1] || bb[1] > seen[3]) continue;
        // (a clip costs the path's points, drawn or not: charged by them, so viewports x points
        // is bounded -- a path whose box overlaps the view while every segment misses the frame
        // drew nothing and cost its points per viewport)
        clipped(budget, out.paths[k].pts.length / 2);
        clipPath(out.paths[k], M, s, rect, lo.paths);
      }
      // (a hatch seen through this viewport is a hatch of its own: a fresh even-odd id, so it does
      // not cancel with the sheet's hatches or another viewport's view of it)
      const ids = new Map();
      for (let k = p0; k < lo.paths.length; k++) {
        const e = lo.paths[k].evenodd;
        if (!e) continue;
        if (!ids.has(e)) ids.set(e, (budget.hatches = (budget.hatches || 0) + 1));
        lo.paths[k].evenodd = ids.get(e);
      }
      let coords = 0;
      for (let k = p0; k < lo.paths.length; k++) coords += lo.paths[k].pts.length;
      charge(budget, lo.paths.length - p0, coords);
      for (const t of out.texts) {
        const [x, y] = ap(M, t.x, t.y);
        // (every length of it scaled by the viewport, TEXT_LENGTHS: a fit width unscaled drew it 10
        // times too long through a 0.1 viewport, and a wrap width unscaled ran it on in one line)
        const seen = sameLines(t, { ...t, x, y, rot: t.rot + tw });
        for (const k of TEXT_LENGTHS) if (t[k]) seen[k] = t[k] * s;
        // kept when its box meets the viewport's frame, and clipped to it as the paths are (kept or
        // dropped whole by its point, a text ran past the frame, or vanished though half inside)
        const c = textCorners(seen);
        const bx = [Math.min(...c.map((q) => q[0])), Math.max(...c.map((q) => q[0]))], by = [Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[1]))];
        if (bx[1] < rect[0] || bx[0] > rect[2] || by[1] < rect[1] || by[0] > rect[3]) continue;
        const inside = bx[0] >= rect[0] && bx[1] <= rect[2] && by[0] >= rect[1] && by[1] <= rect[3];
        addItem(budget, lo.texts, inside ? seen : sameLines(t, { ...seen, clip: rect.slice() }), 2);
      }
      frame(v, rect);
    }
    return { name: li === 0 && active.length ? 'Layout' : `Layout ${li + 1}`, paths: lo.paths, texts: lo.texts, extents: extentsOf(lo) };
  });
  // (a layer no table names, in model space or a layout, is a layer too -- one only texts use as
  // well: its texts could not be hidden, and the layer count was short)
  const untabled = (items) => { for (const p of items) if (!layers.has(p.layer)) layers.set(p.layer, { name: p.layer, colour: aciColour(7), on: true }); };
  untabled(out.paths);
  untabled(out.texts);
  for (const l of layouts) { untabled(l.paths); untabled(l.texts); }
  const u = UNITS[insunits];
  return { units: u ? u[0] : null, insunits,
    layers: [...layers.values()], paths: out.paths, texts: out.texts, extents: extentsOf(out), paperSpace, layouts, notDrawn };
}

// A drawing text's fields that are lengths in drawing units (the text contract): what a
// change of scale -- a layout viewport -- multiplies
const TEXT_LENGTHS = ['h', 'fit', 'wrap'];

// One model path seen through a viewport (transform M, scale s) onto paper,
// clipped to rect [x0, y0, x1, y1]: a filled one by Sutherland-Hodgman, a
// line by Liang-Barsky segment by segment, its kept runs as open paths
function clipPath(p, M, s, rect, out) {
  const n = p.pts.length / 2;
  const P = [];
  for (let i = 0; i < n; i++) P.push(ap(M, p.pts[2 * i], p.pts[2 * i + 1]));
  // (its lengths scaled as the drawing is: the dash pattern and a polyline's width)
  const base = { ...p, dash: p.dash ? p.dash.map((x) => x * s) : null, ...(p.width ? { width: p.width * s } : {}) };
  if (p.fill) {
    let poly = P;
    const edges = [[0, rect[0], 1], [0, rect[2], -1], [1, rect[1], 1], [1, rect[3], -1]];
    for (const [k, lim, sg] of edges) {
      const inside = (q) => sg * (q[k] - lim) >= 0;
      const next = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if (inside(a)) next.push(a);
        if (inside(a) !== inside(b)) {
          const t = (lim - a[k]) / (b[k] - a[k]);
          next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
      }
      poly = next;
      if (!poly.length) return;
    }
    out.push({ ...base, pts: Float64Array.from(poly.flat()), closed: true });
    return;
  }
  if (n === 1 || p.point) {
    const [x, y] = P[0];
    if (x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]) out.push({ ...base, pts: Float64Array.of(x, y, x, y) });
    return;
  }
  const segs = p.closed ? n : n - 1;
  let run = null;
  const flush = () => { if (run && run.length >= 4) out.push({ ...base, pts: Float64Array.from(run), closed: false }); run = null; };
  for (let i = 0; i < segs; i++) {
    const a = P[i], b = P[(i + 1) % n];
    // Liang-Barsky
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    let keep = true;
    for (const [pp, q] of [[-dx, a[0] - rect[0]], [dx, rect[2] - a[0]], [-dy, a[1] - rect[1]], [dy, rect[3] - a[1]]]) {
      if (pp === 0) { if (q < 0) { keep = false; break; } continue; }
      const r = q / pp;
      if (pp < 0) { if (r > t1) { keep = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { keep = false; break; } if (r < t1) t1 = r; }
    }
    if (!keep) { flush(); continue; }
    const s0 = [a[0] + dx * t0, a[1] + dy * t0], s1 = [a[0] + dx * t1, a[1] + dy * t1];
    if (!run || t0 > 0) { flush(); run = [s0[0], s0[1]]; }
    run.push(s1[0], s1[1]);
    if (t1 < 1) flush();
  }
  flush();
}

// a path's box [x0, y0, x1, y1]
function boxOf(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const q = p.pts;
  for (let k = 0; k < q.length; k += 2) {
    if (q[k] < x0) x0 = q[k]; if (q[k] > x1) x1 = q[k];
    if (q[k + 1] < y0) y0 = q[k + 1]; if (q[k + 1] > y1) y1 = q[k + 1];
  }
  return [x0, y0, x1, y1];
}
// The box, in model space, of what a viewport (model -> paper transform M) shows of rect on
// paper: the rect's corners taken back through M (a similarity, so its inverse is exact)
function viewInModel(M, rect) {
  const det = M[0] * M[3] - M[1] * M[2];
  if (!det) return [-Infinity, -Infinity, Infinity, Infinity];
  const inv = (x, y) => {
    const u = x - M[4], v = y - M[5];
    return [(M[3] * u - M[2] * v) / det, (-M[1] * u + M[0] * v) / det];
  };
  const c = [inv(rect[0], rect[1]), inv(rect[2], rect[1]), inv(rect[2], rect[3]), inv(rect[0], rect[3])];
  return [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))];
}

// 2D affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
const IDENT = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
// the angle of a direction (dx, dy) through a transform's linear part
const dirThrough = (m, dx, dy) => Math.atan2(m[1] * dx + m[3] * dy, m[0] * dx + m[2] * dy);

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

// The most a drawing draws: paths and texts, and the coordinates in them (a 2D view of more is
// not usable either; the largest real drawing here, 861 k entities, draws under both)
export const MAX_DRAWN_ITEMS = 4e6;
export const MAX_DRAWN_COORDS = 1.2e8;
function charge(budget, items, coords) {
  budget.items += items;
  budget.pts += coords;
  if (budget.items > MAX_DRAWN_ITEMS || budget.pts > MAX_DRAWN_COORDS) {
    throw new Error(`the drawing is too large to draw here (over ${MAX_DRAWN_ITEMS / 1e6} million items or ${MAX_DRAWN_COORDS / 2e6} million points: an array or nested blocks multiply it)`);
  }
}
function addItem(budget, list, item, coords) {
  charge(budget, 1, coords);
  list.push(item);
}
// Entities walked, drawn or not: blocks of empty blocks, each inserted many times, multiply the
// walk without drawing anything for the drawn budget to count (17 levels of 10 inserts is 1e16
// visits from a file of a few KB). A real drawing walks each entity a few times at most.
export const MAX_WALKED = 5e7;
function walk(budget, n) {
  budget.walked = (budget.walked || 0) + n;
  if (budget.walked > MAX_WALKED) {
    throw new Error(`the drawing is too large to draw here (over ${MAX_WALKED / 1e6} million entities walked: nested blocks or viewports multiply it)`);
  }
}

// How many entities walking a block walks, its inserts expanded (to the same 16 levels emit
// goes), once per block name: an INSERT whose walk would pass the budget is refused before it
// starts, not after minutes of walking empty blocks. A block inside its own insert chain counts
// what one pass of it holds (emit's depth limit ends the real walk).
// An entity that draws a block, as the record that names it (its group 2) and places it -- an
// INSERT, a dimension of any kind, a table (its block-reference groups only: its AcDbTable part
// writes 70 / 71 / 41 again with other meanings) -- or null. The one rule for emit and walkSize
const DIM_KINDS = new Set(['DIMENSION', 'ARC_DIMENSION', 'LARGE_RADIAL_DIMENSION']);
function blockRef(r) {
  if (r.type === 'INSERT' || DIM_KINDS.has(r.type)) return r;
  if (r.type !== 'ACAD_TABLE') return null;
  if (r.ins === undefined) {
    const k = r.g.findIndex((x) => x[0] === 100 && x[1] === 'AcDbTable');
    r.ins = { type: 'INSERT', g: (k < 0 ? r.g : r.g.slice(0, k)).filter((x) => !(x[0] >= 41 && x[0] <= 45) && x[0] !== 70 && x[0] !== 71) };
  }
  return r.ins;
}
function walkSize(ctx, name, depth = 0, open = new Set()) {
  const memo = ctx.walkSizes || (ctx.walkSizes = new Map());
  if (memo.has(name)) return memo.get(name);
  const b = ctx.blocks.get(name);
  // a block on its own insert chain: AutoCAD writes none, and counted as one pass it hid a
  // fan-out of K^16 (a 147-byte block inserting itself 3 times walked for 21 s)
  if (b && open.has(name)) throw new Error(`a damaged drawing: block ${name} inserts itself`);
  if (!b || depth > 16) return b ? b.recs.length : 0;
  open.add(name);
  let n = b.recs.length;
  for (const r0 of b.recs) {
    const r = blockRef(r0);
    if (!r) continue;
    const cells = r.type === 'INSERT' ? Math.max(1, num(r, 70, 1)) * Math.max(1, num(r, 71, 1)) : 1;
    n += cells * walkSize(ctx, get(r, 2, ''), depth + 1, open);
    if (!(n <= MAX_WALKED)) { n = Infinity; break; }
  }
  open.delete(name);
  memo.set(name, n);
  return n;
}

// The viewports' box tests: each viewport tests every model path and text once. A real
// drawing has a few viewports; 20,000 onto 400,000 lines was 8e9 tests (38 s, nothing drawn).
export const MAX_CULLED = 2e8;
function cull(budget, n) {
  budget.culled = (budget.culled || 0) + n;
  if (budget.culled > MAX_CULLED) {
    throw new Error(`the drawing is too large to draw here (its viewports look at the model over ${MAX_CULLED / 1e6} million times)`);
  }
}

// The points the viewports clip, drawn or not: a clip costs far more than a box test, so its
// own budget (a real model of a million points in a handful of viewports is a few million;
// one 100,000-point path in 1,000 viewports was 1e8, 17.6 s, nothing drawn)
export const MAX_CLIPPED = 1e7;
function clipped(budget, n) {
  budget.clipped = (budget.clipped || 0) + n;
  if (budget.clipped > MAX_CLIPPED) {
    throw new Error(`the drawing is too large to draw here (its viewports clip over ${MAX_CLIPPED / 1e6} million points)`);
  }
}

function emit(recs, M, byBlock, depth, ctx) {
  if (depth > 16) return;
  walk(ctx.budget, recs.length);
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    // an entity marked invisible (60 = 1; a DWG's "invisibility") is not drawn: AutoCAD's dynamic
    // blocks mark every visibility state but the shown one so, and all of them were drawn on top
    // of each other (the records that belong to it -- a POLYLINE's VERTEXes, an INSERT's
    // ATTRIBs, to their SEQEND -- go with it)
    if (num(r, 60, 0) === 1) {
      // (only an owner takes its records with it: an invisible ATTRIB is itself one of an
      // INSERT's, and skipping on from it dropped the visible ones after it -- dynamic blocks)
      if (r.type === 'POLYLINE' || r.type === 'INSERT') {
        while (i + 1 < recs.length && ['VERTEX', 'ATTRIB', 'SEQEND'].includes(recs[i + 1].type)) if (recs[++i].type === 'SEQEND') break;
      }
      continue;
    }
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
    // (width: a polyline's width in its own units, scaled by the transform into drawing units)
    // (extra: outline -- a wide polyline's filled outline, not a shape of its own: not counted as
    // one, not snapped to; evenodd -- one hatch's loops, filled together even-odd)
    const path = (pts, closed = false, fill = false, width = 0, extra = null) => {
      const f = new Float64Array(pts.length);
      for (let k = 0; k < pts.length; k += 2) { const [x, y] = ap(O, pts[k], pts[k + 1]); f[k] = x; f[k + 1] = y; }
      const w = width > 0 ? width * Math.sqrt(Math.abs(O[0] * O[3] - O[1] * O[2])) : 0;
      ctx.add({ layer, colour, ...sty, pts: f, closed, fill, ...(w > 0 ? { width: w } : {}), ...extra });
    };
    // a polyline with its widths (widthsOf): one width, stroked at it; else its line (1 px: what a
    // click and a snap find) and each wide segment's outline, filled
    // (one width through a transform that is not a turn and a uniform scale -- a block stretched
    // 4 x 1 -- is no longer one width: drawn as its outlines, through the transform exactly, as a
    // tapering one is; stroked at sqrt|det| it was 4 wide where it is 8)
    // (its axes the same length and square to each other)
    const ax2 = O[0] * O[0] + O[1] * O[1], ay2 = O[2] * O[2] + O[3] * O[3];
    const conformal = Math.abs(ax2 - ay2) <= 1e-9 * (ax2 + ay2) && Math.abs(O[0] * O[2] + O[1] * O[3]) <= 1e-9 * (ax2 + ay2);
    const drawWide = (sh) => {
      let outlines = sh.outlines, width = sh.width || 0;
      if (width && !conformal && sh.src) {
        const { xs, ys, bul, closed } = sh.src, w = new Array(xs.length).fill(width);
        outlines = taperOutlines(xs, ys, bul, w, w, closed);
        width = 0;
      }
      path(sh.pts, sh.closed, false, width);
      if (outlines) for (const o of outlines) if (o.every(Number.isFinite)) path(o, true, true, 0, { outline: true });
    };
    switch (r.type) {
      case 'LINE': {
        // LINE's points are in world coordinates, not its OCS
        const a = ap(M, num(r, 10), num(r, 20)), b = ap(M, num(r, 11), num(r, 21));
        ctx.add({ layer, colour, ...sty,pts: Float64Array.of(a[0], a[1], b[0], b[1]), closed: false, fill: false });
        break;
      }
      case 'POINT': {
        const [x, y] = ap(M, num(r, 10), num(r, 20));
        ctx.add({ layer, colour, ...sty,pts: Float64Array.of(x, y, x, y), closed: false, fill: false, point: true });
        break;
      }
      case 'CIRCLE': path(arcPts(num(r, 10), num(r, 20), num(r, 40), 0, 2 * Math.PI), true); break;
      case 'ARC': {
        // (angles taken within one turn: 370° is 10°; an arc runs counter-clockwise from a0)
        const turn = (deg) => (((deg % 360) + 360) % 360) * Math.PI / 180;
        const a0 = turn(num(r, 50));
        let a1 = turn(num(r, 51));
        if (a1 <= a0) a1 += 2 * Math.PI;
        path(arcPts(num(r, 10), num(r, 20), num(r, 40), a0, a1));
        break;
      }
      case 'ELLIPSE': {
        // world coordinates: centre, the major axis end, the minor ratio
        const cx = num(r, 10), cy = num(r, 20), mx = num(r, 11), my = num(r, 21), ratio = num(r, 40, 1);
        let t0 = num(r, 41, 0), t1 = num(r, 42, 2 * Math.PI);
        if (!Number.isFinite(t0) || !Number.isFinite(t1)) break;
        if (t1 <= t0) t1 += 2 * Math.PI;
        if (t1 - t0 > 2 * Math.PI) t1 = t0 + 2 * Math.PI; // (at most one turn)
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
        ctx.add({ layer, colour, ...sty,pts: Float64Array.from(pts), closed: Math.abs(t1 - t0 - 2 * Math.PI) < 1e-9, fill: false });
        break;
      }
      case 'LWPOLYLINE': {
        // its points made once per entity (a block's polyline inserted many times is the same
        // shape, moved; re-read per insert, one that draws nothing cost its groups each time)
        if (!r.shape) {
          const xs = all(r, 10), ys = all(r, 20);
          // bulges, in order, belong to the vertex before them
          const bul = new Array(xs.length).fill(0);
          // each vertex's start / end width (40 / 41), else the constant width (43)
          const cw = num(r, 43, 0) > 0 ? num(r, 43, 0) : 0;
          const w0 = new Array(xs.length).fill(cw), w1 = new Array(xs.length).fill(cw);
          let vi = -1;
          for (const [c, v] of r.g) {
            if (c === 10) vi++;
            else if (vi >= 0 && c === 42) bul[vi] = Number(v);
            else if (vi >= 0 && c === 40) w0[vi] = Number(v) || 0;
            else if (vi >= 0 && c === 41) w1[vi] = Number(v) || 0;
          }
          const closed = (num(r, 70) & 1) === 1;
          const pts = bulgePts(xs, ys, bul, closed);
          r.shape = { pts: pts.every(Number.isFinite) ? pts : null, closed, ...widthsOf(xs, ys, bul, w0, w1, closed) };
        }
        if (r.shape.pts) drawWide(r.shape);
        break;
      }
      case 'POLYLINE': {
        // its VERTEX records follow it to SEQEND
        // (a 2D polyline's widths: each vertex's start / end (40 / 41), else the polyline's)
        const xs = [], ys = [], bul = [], w0 = [], w1 = [];
        const d0 = num(r, 40, 0) || 0, d1 = num(r, 41, 0) || 0;
        let j = i + 1;
        // (its vertices are the VERTEX records right after it, to its SEQEND -- walked to the next
        // SEQEND whatever came between, a polyline missing its vertices took every entity up to a
        // later one's SEQEND with it, undrawn and uncounted)
        for (; j < recs.length && recs[j].type === 'VERTEX'; j++) {
          if (num(recs[j], 70) & 16) continue; // a spline frame control point
          xs.push(num(recs[j], 10)); ys.push(num(recs[j], 20)); bul.push(num(recs[j], 42));
          w0.push(num(recs[j], 40, d0) || 0); w1.push(num(recs[j], 41, d1) || 0);
        }
        i = j < recs.length && recs[j].type === 'SEQEND' ? j : j - 1;
        const flags = num(r, 70);
        // a 3D mesh or a polyface: not drawn in 2D, and counted so (467 at hand were left out without
        // a word, while a 3D solid was counted)
        if (flags & (16 | 64)) { const k = flags & 64 ? 'POLYLINE (polyface)' : 'POLYLINE (3D mesh)'; ctx.notDrawn[k] = (ctx.notDrawn[k] || 0) + 1; break; }
        const closed = (flags & 1) === 1;
        if (flags & 8) { const W = mul(M, IDENT); ctx.add({ layer, colour, ...sty,pts: Float64Array.from(xs.flatMap((x, k) => ap(W, x, ys[k]))), closed, fill: false }); }
        else drawWide({ pts: bulgePts(xs, ys, bul, closed), closed, ...widthsOf(xs, ys, bul, w0, w1, closed) });
        break;
      }
      case 'SPLINE': {
        const pts = splinePts(r);
        if (pts.length >= 4) {
          const W = M; // splines are in world coordinates
          const f = new Float64Array(pts.length);
          for (let k = 0; k < pts.length; k += 2) { const [x, y] = ap(W, pts[k], pts[k + 1]); f[k] = x; f[k + 1] = y; }
          ctx.add({ layer, colour, ...sty,pts: f, closed: (num(r, 70) & 1) === 1, fill: false });
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
        // (its loops made once per entity, as a polyline's points are)
        if (!r.loops) r.loops = hatchLoops(r);
        // A solid fill of several loops is filled as one, even-odd: its islands left empty (filled
        // with the drawing's other fills, non-zero, an island wound as its outer loop was filled --
        // 82 of 901 at hand). Style "ignore islands" (75 = 2) fills every loop, with the others
        if (solid && r.loops.length > 1 && num(r, 75, 0) !== 2) {
          // (one counter for the drawing -- model space and every layout: counted per sheet, a model
          // hatch seen through a viewport and the sheet's own shared an id, and cancelled)
          const id = (ctx.budget.hatches = (ctx.budget.hatches || 0) + 1);
          for (const loop of r.loops) path(loop, true, true, 0, { evenodd: id });
        } else for (const loop of r.loops) path(loop, true, solid);
        break;
      }
      case '3DFACE': {
        // world corners (the fourth repeats the third for a triangle); 70's bits 1, 2, 4, 8 hide
        // the first .. fourth edge
        const c = [[num(r, 10), num(r, 20)], [num(r, 11), num(r, 21)], [num(r, 12), num(r, 22)], [num(r, 13, num(r, 12)), num(r, 23, num(r, 22))]].map(([x, y]) => ap(M, x, y));
        const hide = num(r, 70);
        if (!(hide & 15)) {
          ctx.add({ layer, colour, ...sty, pts: Float64Array.from(c.flat()), closed: true, fill: false });
          break;
        }
        for (let e = 0; e < 4; e++) {
          if (hide & (1 << e)) continue;
          const a = c[e], b = c[(e + 1) % 4];
          ctx.add({ layer, colour, ...sty, pts: Float64Array.of(a[0], a[1], b[0], b[1]), closed: false, fill: false });
        }
        break;
      }
      case 'TEXT': case 'MTEXT': case 'ATTRIB': {
        // (an ATTRIB is a TEXT that follows its INSERT -- a title block's values -- and one
        // flagged invisible (70 bit 1) is not drawn; its vertical alignment is 74, not 73)
        if (r.type === 'ATTRIB' && (num(r, 70) & 1)) break;
        // An R2018 multi-line ATTRIB holds its value as an embedded MTEXT after "101 Embedded
        // Object": that MTEXT is what is drawn -- its text, point, height and attachment (its own
        // group 1 is the first line only; drawn as a TEXT it stood 3.8 heights too high), the
        // ATTRIB's own groups read only before the 101. (Made once per entity, as the text is.)
        // (and an R2018 MTEXT's own groups end at its "101 Embedded Object": what follows -- a
        // point in its 11 -- was read as its direction, and 334 MTEXTs at hand drew turned 73.83°)
        if (r.src === undefined) {
          const emb = r.type === 'ATTRIB' || r.type === 'MTEXT' ? r.g.findIndex((x) => x[0] === 101) : -1;
          r.src = emb < 0 ? (r.type === 'ATTRIB' ? { type: 'ATTRIB', g: attribTextGroups(r.g) } : r)
            : r.type === 'ATTRIB' ? { type: 'MTEXT', g: r.g.slice(emb + 1) } : { type: 'MTEXT', g: r.g.slice(0, emb) };
        }
        const e = r.src;
        const mt = e.type === 'MTEXT';
        // (the plain text, made once per entity: a block's text inserted many times is the same)
        if (r.plain === undefined) {
          // (as written, as an MTEXT's is: a TEXT's leading spaces are part of it -- trimmed, a
          // DWG's text lost its leading U+3000 while the same text escaped as \U+3000 kept it)
          const raw = mt ? e.g.filter((x) => x[0] === 3 || x[0] === 1).map((x) => x[1]).join('') : firstOf(e).get(1) ?? '';
          r.plain = mt ? mtextPlain(raw, ctx.codepage) : textCodes(raw, ctx.codepage);
        }
        const t = r.plain;
        if (!t.trim()) break;
        // MTEXT's point (10) and direction (11) are in WORLD coordinates, TEXT's in its own (the
        // OCS): an MTEXT at world (50, 0) with extrusion 0,0,-1 was drawn at (-50, 0)
        const P = mt ? M : O;
        const item = { layer, colour, h: num(e, 40, 1), text: t, mtext: mt };
        // the text's own direction (dv) in the frame it is given in (F): its sizes are taken
        // along it, after the branches below
        let F = O, dv;
        let rw = 0;
        if (mt) {
          // attachment 1..9: top / middle / bottom rows of left / centre / right
          const a = Math.min(9, Math.max(1, num(e, 71, 1) | 0));
          [item.x, item.y] = ap(P, num(e, 10), num(e, 20));
          item.align = mtextAlign(a);
          item.valign = ['top', 'middle', 'bottom'][Math.floor((a - 1) / 3)];
          // 41, its reference width: its lines wrap at it (they ran on in one line)
          rw = num(e, 41, 0);
          if (get(e, 11, null) !== null) { F = M; dv = [num(e, 11), num(e, 21)]; } else { const a = (num(e, 50) * Math.PI) / 180; dv = [Math.cos(a), Math.sin(a)]; }
          item.dir = dirThrough(F, dv[0], dv[1]);
        } else {
          // TEXT / ATTRIB: 72 the horizontal alignment (0 left, 1 centre, 2 right, 3 aligned, 4
          // middle, 5 fit), 73 (an ATTRIB's 74) the vertical (0 baseline, 1 bottom, 2 middle,
          // 3 top); any but left on the baseline is placed by the second point
          const al = num(e, 72, 0) | 0;
          const va = num(e, e.type === 'ATTRIB' ? 74 : 73, 0) | 0;
          const p10 = ap(O, num(e, 10), num(e, 20)), p11 = ap(O, num(e, 11), num(e, 21));
          { const a = (num(e, 50) * Math.PI) / 180; dv = [Math.cos(a), Math.sin(a)]; item.dir = dirThrough(O, dv[0], dv[1]); }
          if (al === 3 || al === 5) {
            // aligned / fit: drawn from the first point along the baseline to the second, its width
            // fitted to it (aligned keeps its proportions, fit its height) -- it was drawn from the
            // second point, one text width past where it belongs
            [item.x, item.y] = p10;
            item.align = 'left';
            item.valign = 'baseline';
            const d = Math.hypot(p11[0] - p10[0], p11[1] - p10[1]);
            if (d > 0) { item.dir = Math.atan2(p11[1] - p10[1], p11[0] - p10[0]); item.fit = d; item.fitMode = al === 3 ? 'aligned' : 'fit'; }
          } else {
            [item.x, item.y] = al || va ? p11 : p10;
            item.align = ['left', 'center', 'right', 'left', 'center', 'left'][al] || 'left';
            item.valign = al === 4 ? 'middle' : ['baseline', 'bottom', 'middle', 'top'][va] || 'baseline';
          }
          // 71, its generation: 2 backward (mirrored in x), 4 upside down (in y) -- drawn normally,
          // they stood on the wrong side of their point (277 at hand); 41, its width factor (an
          // aligned / fit text's width is its fit already)
          const gen = num(e, 71, 0) | 0;
          if (gen & 2) item.mirrorX = true;
          if (gen & 4) item.mirrorY = true;
          const wf = num(e, 41, 1);
          if (!item.fit && Number.isFinite(wf) && wf > 0 && wf !== 1) item.widthFactor = wf;
          // 51, its oblique angle: the glyphs slanted by it (279 at hand were drawn upright)
          const ob = num(e, 51, 0);
          if (Number.isFinite(ob) && ob % 360 !== 0 && Math.abs(Math.cos((ob * Math.PI) / 180)) > 1e-3) item.oblique = (ob * Math.PI) / 180;
        }
        // Through the transform it is drawn by (its block's, its OCS): its direction is the
        // transformed one; a mirroring transform (det < 0) mirrors it -- drawn backward, along the
        // transformed direction -- and a stretch widens it. Only the insert's rotation and y scale
        // were taken: a block mirrored in x drew its text upside down, one mirrored in y upright,
        // one stretched in x at its own width. The stretch is taken ALONG THE TEXT (sx) and across
        // it (sy, the area scale over sx): taken along the block's axes, a text turned 90° in a
        // block stretched in x was widened instead of made taller
        {
          // (mirrored by its extrusion too: an MTEXT's points are in world coordinates, but it lies
          // in its OCS plane -- one seen from -Z, as MIRROR with MIRRTEXT writes it, drew unmirrored)
          const det = O[0] * O[3] - O[1] * O[2];
          const dl = Math.hypot(dv[0], dv[1]) || 1;
          const sx = Math.hypot(F[0] * dv[0] + F[2] * dv[1], F[1] * dv[0] + F[3] * dv[1]) / dl;
          const sy = sx > 0 ? Math.abs(F[0] * F[3] - F[1] * F[2]) / sx : Math.hypot(F[2], F[3]);
          item.h *= sy;
          if (Number.isFinite(rw) && rw > 0) item.wrap = rw * sx;
          if (det < 0) { item.rot = item.dir - Math.PI; item.mirrorX = !item.mirrorX; } else item.rot = item.dir;
          if (!item.mirrorX) delete item.mirrorX;
          delete item.dir;
          if (!item.fit && sy > 0 && Math.abs(sx / sy - 1) > 1e-9) item.widthFactor = (item.widthFactor || 1) * (sx / sy);
        }
        ctx.addText(item);
        break;
      }
      case 'INSERT': case 'DIMENSION': case 'ARC_DIMENSION': case 'LARGE_RADIAL_DIMENSION': case 'ACAD_TABLE': {
        // A table is drawn as its block (*T…) inserted at its point, as the DWG adapter writes it;
        // a dimension of any kind draws its block (blockRef). (A DXF's tables and arc dimensions
        // were counted "not drawn", while the same drawing's DWG drew them)
        const q = blockRef(r);
        const b = ctx.blocks.get(get(q, 2, ''));
        // (a reference to a block not in the file draws nothing: counted, as a table's was alone)
        if (!b) { ctx.notDrawn[r.type] = (ctx.notDrawn[r.type] || 0) + 1; break; }
        const isDim = q.type !== 'INSERT';
        const sx = isDim ? 1 : num(q, 41, 1), sy = isDim ? 1 : num(q, 42, 1);
        const rot = isDim ? 0 : (num(q, 50) * Math.PI) / 180;
        const cols = isDim ? 1 : Math.max(1, num(q, 70, 1)), rows = isDim ? 1 : Math.max(1, num(q, 71, 1));
        // an array of more cells than a drawing can draw is refused before it is walked (an
        // empty block's cells would otherwise loop without drawing anything to count)
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols * rows > MAX_DRAWN_ITEMS) {
          throw new Error(`the drawing is too large to draw here (an array of ${cols} × ${rows} inserts)`);
        }
        if ((ctx.budget.walked || 0) + cols * rows * walkSize(ctx, get(q, 2, '')) > MAX_WALKED) {
          throw new Error(`the drawing is too large to draw here (block ${get(q, 2, '')}, inserted ${cols * rows} times, walks over ${MAX_WALKED / 1e6} million entities: nested blocks multiply it)`);
        }
        const dc = num(q, 44), dr = num(q, 45);
        const ix = isDim ? 0 : num(q, 10), iy = isDim ? 0 : num(q, 20);
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
      case 'LEADER': {
        // its vertices (10 / 20, world coordinates), as a polyline (the arrowhead is not drawn)
        const xs = all(r, 10), ys = all(r, 20);
        if (xs.length >= 2) {
          const pts = [];
          for (let k = 0; k < xs.length; k++) pts.push(...ap(M, xs[k], ys[k] ?? 0));
          if (pts.every(Number.isFinite)) ctx.add({ layer, colour, ...sty, pts: Float64Array.from(pts), closed: false, fill: false });
        } else ctx.notDrawn.LEADER = (ctx.notDrawn.LEADER || 0) + 1; // (one without its vertices: a DWG's, whose are not decoded)
        break;
      }
      default:
        // any other kind is one the drawing does not draw, counted by name so the page can say so
        // (a closed list of names missed custom kinds: AutoCAD Mechanical's, an AEC wall)
        if (!STRUCTURE.has(r.type)) ctx.notDrawn[r.type] = (ctx.notDrawn[r.type] || 0) + 1;
    }
  }
}
// entity records that are structure, not something drawn (never counted as "not drawn"). The one
// list: js/dwg.js passes on every other entity kind it does not decode, by name
export const STRUCTURE = new Set(['VERTEX', 'SEQEND', 'ATTDEF', 'VIEWPORT', 'BLOCK', 'ENDBLK']);

// an arc as points: radius r about (cx, cy) from a0 to a1 (radians, CCW)
function arcPts(cx, cy, r, a0, a1) {
  // a sweep is at most one turn (an angle of 1e12 asked for 2e11 points), and a non-number is none
  if (!Number.isFinite(a0) || !Number.isFinite(a1) || !Number.isFinite(r)) return [];
  if (a1 - a0 > 2 * Math.PI) a1 = a0 + 2 * Math.PI;
  const n = Math.max(8, Math.ceil((a1 - a0) / SEG_RAD));
  const out = [];
  for (let k = 0; k <= n; k++) { const t = a0 + ((a1 - a0) * k) / n; out.push(cx + r * Math.cos(t), cy + r * Math.sin(t)); }
  return out;
}

// A polyline's widths, per segment start (w0) and end (w1): { width } when every segment has the
// one width (0: none), else { outlines } (taperOutlines)
function widthsOf(xs, ys, bul, w0, w1, closed) {
  const segs = closed ? xs.length : xs.length - 1;
  let one = segs > 0 ? w0[0] : 0, same = true;
  for (let i = 0; i < segs && same; i++) same = w0[i] === one && w1[i] === one;
  if (same) return Number.isFinite(one) && one > 0 ? { width: one, src: { xs, ys, bul, closed } } : {};
  return { outlines: taperOutlines(xs, ys, bul, w0, w1, closed) };
}

// A polyline whose width changes (an arrowhead 0 to 5, a segment wider than the next): each segment
// as a filled outline from its start width to its end width, straight or along its bulge, butt
// ended (drawn as one stroke at its widest, an arrowhead was a bar). -> [pts, ...] closed outlines
export function taperOutlines(xs, ys, bul, w0, w1, closed) {
  const n = xs.length, segs = closed ? n : n - 1, out = [];
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const a = w0[i] || 0, b = w1[i] || 0;
    if (!(a > 0 || b > 0)) continue; // (a segment of no width: in the outline path, drawn 1 px)
    const p = bulgePts([xs[i], xs[j]], [ys[i], ys[j]], [bul[i] || 0], false);
    const m = p.length / 2;
    const cum = [0];
    for (let k = 1; k < m; k++) cum.push(cum[k - 1] + Math.hypot(p[2 * k] - p[2 * k - 2], p[2 * k + 1] - p[2 * k - 1]));
    const L = cum[m - 1];
    if (!(L > 0)) continue;
    const left = [], right = [];
    for (let k = 0; k < m; k++) {
      const k0 = Math.max(0, k - 1), k1 = Math.min(m - 1, k + 1);
      const dx = p[2 * k1] - p[2 * k0], dy = p[2 * k1 + 1] - p[2 * k0 + 1], d = Math.hypot(dx, dy) || 1;
      const hw = (a + ((b - a) * cum[k]) / L) / 2;
      left.push(p[2 * k] - (dy / d) * hw, p[2 * k + 1] + (dx / d) * hw);
      right.push(p[2 * k] + (dy / d) * hw, p[2 * k + 1] - (dx / d) * hw);
    }
    const poly = left;
    for (let k = m - 1; k >= 0; k--) poly.push(right[2 * k], right[2 * k + 1]);
    out.push(poly);
  }
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
// AutoCAD writes splines of degree 1 to 11; past this a spline is drawn as its control polygon
export const MAX_SPLINE_DEGREE = 25;
function splinePts(r) {
  // evaluated once per entity: a block's spline inserted many times is the same curve, moved
  if (!r.splinePts) r.splinePts = evalSpline(r);
  return r.splinePts;
}
function evalSpline(r) {
  const deg = num(r, 71, 3);
  const knots = all(r, 40);
  const cx = all(r, 10), cy = all(r, 20);
  const w = all(r, 41);
  if (cx.length < 2) {
    const fx = all(r, 11), fy = all(r, 21);
    return fx.flatMap((x, k) => [x, fy[k]]);
  }
  const n = cx.length;
  // a degree that is not a whole number from 1 to n - 1 (de Boor would read slots that do not
  // exist), or over MAX_SPLINE_DEGREE (evaluation costs points x degree^2: a 300-point spline of
  // degree 299 took 12 s), or knots that do not fit it: the control polygon
  if (!Number.isInteger(deg) || deg < 1 || deg >= n || deg > MAX_SPLINE_DEGREE || knots.length !== n + deg + 1) return cx.flatMap((x, k) => [x, cy[k]]);
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
  // a count is of items the entity holds, each at least one group: one larger than the groups
  // left is a damaged file (looping on it read zeros past the end, up to 1e12 times)
  const count = (n) => {
    if (!Number.isInteger(n) || n < 0 || n > g.length - i) throw new Error(`a damaged HATCH: its boundary counts ${n} items, more than the entity holds`);
    return n;
  };
  const append = (to, from) => { for (let k = 0; k < from.length; k++) to.push(from[k]); };
  for (let L = 0; L < nLoops && i < g.length; L++) {
    const type = at(92);
    const pts = [];
    if (type & 2) {
      const hasB = at(72);
      at(73); // "closed": a boundary is closed either way
      const nv = count(at(93));
      const xs = [], ys = [], bs = [];
      for (let v = 0; v < nv; v++) { xs.push(at(10)); ys.push(at(20)); bs.push(hasB ? at(42) : 0); }
      // (a hatch boundary is closed whatever its 73 says; appended, not spread: a 200k-vertex
      // boundary spread into call arguments overflowed the stack)
      append(pts, bulgePts(xs, ys, bs, true));
    } else {
      const ne = count(at(93));
      for (let e = 0; e < ne; e++) {
        const et = at(72);
        if (et === 1) { pts.push(at(10), at(20), at(11), at(21)); } else if (et === 2) {
          const cx = at(10), cy = at(20), rr = at(40), a0 = (at(50) * Math.PI) / 180, a1 = (at(51) * Math.PI) / 180;
          if (at(73)) {
            // counter-clockwise from a0 to a1
            append(pts, arcPts(cx, cy, rr, a0, a1 <= a0 ? a1 + 2 * Math.PI : a1));
          } else {
            // clockwise: the angles are stored mirrored, so the edge runs from -a0 clockwise to
            // -a1 (0° to 90° stored is the quarter from 360° down to 270°): the same arc taken
            // counter-clockwise from -a1 to -a0, its points reversed so the loop keeps its order
            const s = -a1, e = -a0;
            const ccwPts = arcPts(cx, cy, rr, s, e <= s ? e + 2 * Math.PI : e);
            for (let k = ccwPts.length - 2; k >= 0; k -= 2) pts.push(ccwPts[k], ccwPts[k + 1]);
          }
        } else if (et === 3) {
          const cx = at(10), cy = at(20), mx = at(11), my = at(21), ratio = at(40);
          const a0 = (at(50) * Math.PI) / 180, a1 = (at(51) * Math.PI) / 180;
          // counter-clockwise from a0 to a1; clockwise stores its parameters mirrored, as the
          // circular arc above does: the edge runs -a0 down to -a1, so it is the counter-clockwise
          // run -a1 .. -a0 with its points reversed (drawn as stored, it came out mirrored about
          // the major axis)
          const ccw = at(73);
          const t0 = ccw ? a0 : -a1;
          let t1 = ccw ? a1 : -a0;
          if (t1 <= t0) t1 += 2 * Math.PI;
          const run = [];
          for (let k = 0; k <= 32; k++) { const t = t0 + ((t1 - t0) * k) / 32; run.push(cx + mx * Math.cos(t) - my * ratio * Math.sin(t), cy + my * Math.cos(t) + mx * ratio * Math.sin(t)); }
          if (ccw) append(pts, run);
          else for (let k = run.length - 2; k >= 0; k -= 2) pts.push(run[k], run[k + 1]);
        } else if (et === 4) {
          // a spline edge: its control points
          at(94); const nk = count(at(95)), nc = count(at(96));
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
// (a code's value ends at its ";" and holds no backslash, so a run of codes with no ";" fails
// each match at the next backslash: one pass, not a rescan to the end from every code; a stack
// \S splits at its first separator, which its first part may not hold)
// One pass, left to right, so an escape is read before what it escapes: \\ a backslash, \{ \} a
// brace (bare braces group and are dropped), \P a new line, \~ a space, \L \O \K and their ends
// dropped, a code up to its ";" dropped, \Sa^b; a/b, \U+nnnn its character; a code with no ";"
// before the next backslash stays as written. (Run as replaces one after another, a typed path
// "C:\Projects" lost its "P" to a new line, "\\" then "{3}" read wrong, and a typed "\\U+00B0"
// turned into a degree sign.) Then the % codes.
export function mtextPlain(s, codepage = 'windows-1252') {
  let out = '';
  const n = s.length;
  // the ";" ending a code from j on, or -1 when a backslash (or the end) comes first -- a character
  // escape (\U+XXXX, \M+NXXXX) is part of the code (a font name written outside the code page: the
  // code did not end, and showed as text)
  // (the one step for both scans below: from j to the first of `stops` or a backslash that is not
  // a character escape, stepping over escapes -- the stack's first part stopped at the escape, and
  // "5\S+0.1\U+00B0^-0.1\U+00B0;" stayed as written)
  const scan = (j, stops) => {
    while (j < n && !stops.includes(s[j])) {
      if (s[j] !== '\\') { j++; continue; }
      const esc = escapeAt(s, j);
      if (!esc) break;
      j += esc[1];
    }
    return j;
  };
  const endOf = (j) => { j = scan(j, ';'); return j < n && s[j] === ';' ? j : -1; };
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (c === '{' || c === '}') continue;
    if (c !== '\\' || i + 1 >= n) { out += c; continue; }
    const k = s[i + 1];
    if (k === '\\' || k === '{' || k === '}') { out += k; i++; continue; }
    if (k === 'P') { out += '\n'; i++; continue; }
    if (k === '~') { out += ' '; i++; continue; } // (non-breaking: the wrap does not break there)
    if ('LlOoKk'.includes(k)) { i++; continue; }
    if ('ACcFfHhQTWp'.includes(k)) {
      const e = endOf(i + 2);
      if (e >= 0) { i = e; continue; }
      out += c;
      continue;
    }
    if (k === 'S') {
      const j = scan(i + 2, '^#/;');
      const e = j < n && '^#/'.includes(s[j]) ? endOf(j + 1) : -1;
      if (e >= 0) {
        // "/" and "#" stack a fraction (a/b); "^" a tolerance or, one side empty, a super- or
        // subscript: its non-empty parts, a space apart ("m\S2^;" is m2, "+0.1^-0" is +0.1 -0;
        // as a/b they read "m2/" and "+0.1/-0")
        const a = unescapeDxf(s.slice(i + 2, j)), b = unescapeDxf(s.slice(j + 1, e));
        // (a two-part tolerance set off from the value before it: "0,2 +0.1 -0", not "0,2+0.1 -0")
        const both = a.trim() && b.trim();
        out += s[j] === '^' ? `${both && out && !/\s$/.test(out) ? ' ' : ''}${[a, b].filter((x) => x.trim()).join(' ')}` : `${a}/${b}`;
        i = e;
        continue;
      }
      out += c;
      continue;
    }
    const esc = escapeAt(s, i);
    if (esc) { out += esc[0]; i += esc[1] - 1; continue; }
    out += c;
  }
  return percentCodes(out, codepage);
}

// The % codes a TEXT, ATTRIB or MTEXT value holds, in one pass: %%c Ø, %%d °, %%p ±, %%u / %%o /
// %%k (underline, overline, strike: toggles, dropped), %%% a "%", %%nnn the character of that code
const PCT = { c: 'Ø', d: '°', p: '±', u: '', o: '', k: '', '%': '%' };
// (%%nnn above 127 is a byte of the drawing's single-byte code page -- %%128 in a 1252 drawing is
// "€", not U+0080 -- and from 256 a character code)
function pageChar(n, codepage) {
  if (n < 128 || n > 255) return String.fromCharCode(n);
  // (a double-byte page has no character for one byte: 1252 then)
  const single = codepage && !isDoubleByte(codepage);
  return (decoderFor(single ? codepage : 'windows-1252') || decoderFor('windows-1252')).decode(Uint8Array.of(n));
}
const percentCodes = (s, codepage = 'windows-1252') => s.replace(/%%(\d{3})|%%([cdpuok%])/gi, (m, n, k) => (n ? pageChar(Number(n), codepage) : PCT[k.toLowerCase()]));
// \M+NXXXX: a double-byte character of code page N (js/codepages.js MBCS), as an R14 drawing's DXF
// writes them
function mbcsChar(nxxxx) {
  const dec = decoderFor(MBCS[nxxxx[0]]);
  return dec ? dec.decode(Uint8Array.of(parseInt(nxxxx.slice(1, 3), 16), parseInt(nxxxx.slice(3, 5), 16))) : null;
}
// A character escape at s[i] (a backslash): \U+XXXX or \M+NXXXX -> [the character, its length],
// else null. The one decoder: mtextPlain's scanner and unescapeDxf both call it (they held a copy
// of the patterns each)
function escapeAt(s, i) {
  if (s[i] !== '\\' || s[i + 2] !== '+') return null;
  if (s[i + 1] === 'U' && /^[0-9A-Fa-f]{4}$/.test(s.slice(i + 3, i + 7))) return [String.fromCharCode(parseInt(s.slice(i + 3, i + 7), 16)), 7];
  if (s[i + 1] === 'M' && /^[1-5][0-9A-Fa-f]{4}$/.test(s.slice(i + 3, i + 8))) { const ch = mbcsChar(s.slice(i + 3, i + 8)); if (ch !== null) return [ch, 8]; }
  return null;
}
// The character escapes a DXF string holds, \U+XXXX and \M+NXXXX: the one rule for the drawing
// (textCodes, mtextPlain's scanner) and the DWG validation's comparator (tests/dwg-compare.mjs)
export function unescapeDxf(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const esc = s[i] === '\\' ? escapeAt(s, i) : null;
    if (esc) { out += esc[0]; i += esc[1] - 1; } else out += s[i];
  }
  return out;
}
// ...and a single-line TEXT's or ATTRIB's: those and the % codes (a raw "%%u", "45\U+00B0" and
// "\M+18277" were drawn as written)
export function textCodes(s, codepage = 'windows-1252') {
  return percentCodes(unescapeDxf(s), codepage);
}
const mtextAlign = (a) => ['left', 'center', 'right'][(a - 1) % 3] || 'left';

function extentsOf(out) {
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  for (const p of out.paths) {
    // (a wide polyline reaches half its width past its points: Fit cut it at the edge)
    const r = p.width > 0 ? p.width / 2 : 0;
    for (let k = 0; k < p.pts.length; k += 2) {
      if (!Number.isFinite(p.pts[k]) || !Number.isFinite(p.pts[k + 1])) continue;
      min[0] = Math.min(min[0], p.pts[k] - r); max[0] = Math.max(max[0], p.pts[k] + r);
      min[1] = Math.min(min[1], p.pts[k + 1] - r); max[1] = Math.max(max[1], p.pts[k + 1] + r);
    }
  }
  for (const t of out.texts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of textCorners(t)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    // (a text clipped to a viewport's frame counts only what is drawn of it: its whole box made a
    // sheet's extents 6.5 times what it shows)
    if (t.clip) { x0 = Math.max(x0, t.clip[0]); y0 = Math.max(y0, t.clip[1]); x1 = Math.min(x1, t.clip[2]); y1 = Math.min(y1, t.clip[3]); }
    if (!(x0 <= x1 && y0 <= y1)) continue;
    min[0] = Math.min(min[0], x0); max[0] = Math.max(max[0], x1);
    min[1] = Math.min(min[1], y0); max[1] = Math.max(max[1], y1);
  }
  return min[0] === Infinity ? null : { min, max };
}

// An ATTRIB's groups with its text placement (11 / 21, 41, 71, 72) from its AcDbText part only:
// an R2018 ATTRIB's AcDbAttribute part writes these codes again with other meanings (71 its
// attribute type, 1 in 2,082 of 7,083 at hand). The one rule for the reader and the DWG
// validation's comparator
const ATTRIB_TEXT_CODES = new Set([11, 21, 41, 71, 72]);
export function attribTextGroups(g) {
  const k = g.findIndex((x) => x[0] === 100 && x[1] === 'AcDbAttribute');
  return k < 0 ? g : g.filter((x, i) => i < k || !ATTRIB_TEXT_CODES.has(x[0]));
}

// A drawing with nothing to show: no path or text in model space or any layout. The one rule for
// the page (it refuses the file) and dwg-check.mjs (it reports it)
export const sheetDraws = (s) => s.paths.length > 0 || s.texts.length > 0; // (model space, or a layout)
export const drawsNothing = (d) => !sheetDraws(d) && !d.layouts.some(sheetDraws);

// Lines wrapped at a width, at spaces (a word longer than the width stands alone): width(line)
// measures a line -- the view by the font, the extents by an estimate. The one wrap for both
// Each word is measured once and a line's width is the sum of its words and spaces: measuring the
// growing line at every word was quadratic, and one 600 kB paragraph froze the page for minutes
// A line breaks at a space, or between two CJK characters (written without spaces: a Chinese or
// Japanese paragraph never wrapped); the spaces at a break are dropped
// (the ideographic space U+3000 is a space; a closing mark -- 、。，」） and the like -- never starts a
// line: it stays with the character before it)
// (and an opening mark -- 「（ and the like -- never ends one: it goes with the character after it;
// ideographs past the BMP, CJK extensions B on, break as the others do)
const WRAP_TOKEN = /[⺀-⿿、-鿿가-힯豈-﫿＀-￯\u{20000}-\u{3134f}]|[^ 　⺀-⿿、-鿿가-힯豈-﫿＀-￯\u{20000}-\u{3134f}]+|[ 　]+/gu;
const NO_LINE_START = /^[、。，．：；？！）」』】〕〉》ー々ゝゞ・…‥〜％］｝]$/u;
const NO_LINE_END = /[「『【〔〈《（［｛]$/u;
const wrapTokens = (line) => {
  const out = [];
  let glue = false; // the token before ends in an opening mark: this one joins it
  for (const tok of line.match(WRAP_TOKEN) || []) {
    const prev = out.length ? out[out.length - 1] : null;
    const space = /^[ 　]/.test(tok);
    if (prev !== null && !space && (glue || (NO_LINE_START.test(tok) && !/^[ 　]/.test(prev)))) out[out.length - 1] = prev + tok; else out.push(tok);
    glue = !space && NO_LINE_END.test(tok);
  }
  return out;
};
export function wrapLines(lines, width, max) {
  const out = [];
  const seen = new Map();
  const w = (s) => { let v = seen.get(s); if (v === undefined) { v = width(s); if (seen.size < 4096) seen.set(s, v); } return v; };
  for (const line of lines) {
    if (width(line) <= max) { out.push(line); continue; }
    let cur = '', cw = 0, pend = '', pw = 0; // pend: spaces after cur, kept only if a token follows
    for (const tok of wrapTokens(line)) {
      if (tok[0] === ' ' || tok[0] === '　') { if (cur) { pend += tok; pw += w(tok); } continue; }
      const tw = w(tok);
      if (cur && cw + pw + tw > max) { out.push(cur); cur = tok; cw = tw; } else { cur += pend + tok; cw += pw + tw; }
      pend = ''; pw = 0;
    }
    out.push(cur);
  }
  return out;
}

// A text's corners as js/dxf-view.js places it: its lines (1.4 heights apart), its width (its
// fit, else 0.6 of a height per character of the longest line), shifted by its alignment and
// vertical alignment, turned by its rotation. The extents took every text as left-aligned on its
// baseline, one line high: a 20-line MTEXT drawn below its point was cut off by Fit
// An MTEXT's lines wrapped by the estimate (a character -- a code point -- 0.6 of a height). The
// ratio is the same at any scale, so a text seen through many viewports is wrapped once (each
// wrapped it again: 1,400 viewports of one long MTEXT reached the worker's 60 s): the lines are kept
// with the text and given to each viewport's copy of it (a cache of 256 texts missed on every
// viewport for a drawing of 300)
const WRAPPED = new WeakMap();
function estimatedLines(t) {
  if (!(t.mtext && t.wrap > 0)) return null;
  let w = WRAPPED.get(t);
  if (!w) { w = wrapLines(t.text.split('\n'), (l) => [...l].length, t.wrap / (t.h * 0.6 * (t.widthFactor || 1))); WRAPPED.set(t, w); }
  return w;
}
const sameLines = (from, to) => { const w = estimatedLines(from); if (w) WRAPPED.set(to, w); return to; };

// (drawn: its lines as the view drew them, when it has; else estimated)
// (width: the drawn width of its widest line, when the caller measured it -- the view, by its font)
export function textCorners(t, drawn = null, width = null) {
  const per = t.h * 0.6 * (t.widthFactor || 1); // (a character's width, estimated)
  // an MTEXT with a reference width wraps at it (as the view does, by measure): its lines estimated
  const lines = drawn || estimatedLines(t) || t.text.split('\n');
  const lh = t.h * 1.4;
  // (the longest line by a loop: spread into Math.max, 300k lines overflowed the stack)
  let longest = 0;
  for (const l of lines) { const n = l.length > longest ? [...l].length : 0; if (n > longest) longest = n; } // (code points: an astral character is one)
  const w = t.fit > 0 ? t.fit : width !== null ? width : per * longest;
  const hBlock = (lines.length - 1) * lh + t.h;
  const x0 = t.fit > 0 ? 0 : t.align === 'center' ? -w / 2 : t.align === 'right' ? -w : 0;
  // (y up: the top of the block and its bottom, from the point)
  let top, bottom;
  if (t.mtext) {
    const y0 = t.valign === 'middle' ? hBlock / 2 : t.valign === 'bottom' ? hBlock : 0;
    top = y0; bottom = y0 - hBlock;
  } else {
    // the last line's baseline (or its bottom / middle / top) on the point, the lines above it
    const base = t.valign === 'top' ? -t.h : t.valign === 'middle' ? -t.h / 2 : 0;
    bottom = base - (t.valign === 'bottom' ? 0 : t.h * 0.25);
    top = base + t.h + (lines.length - 1) * lh;
  }
  const c = Math.cos(t.rot || 0), s = Math.sin(t.rot || 0);
  // (a backward / upside-down text is mirrored about its point, as the view draws it)
  const mx = t.mirrorX ? -1 : 1, my = t.mirrorY ? -1 : 1;
  // (an oblique text slanted as the view slants it, before the mirror: its tops moved along the
  // baseline -- its box left the slant 0.58 heights outside at 30°)
  // (slanted before its width is scaled, as the view does: the slant widens with the width factor,
  // or with a fit text's stretch)
  const sxs = t.fit > 0 ? (longest > 0 ? t.fit / (t.h * 0.6 * longest) : 1) : t.widthFactor || 1;
  const k = t.oblique ? Math.tan(t.oblique) * sxs : 0;
  return [[x0, bottom], [x0 + w, bottom], [x0, top], [x0 + w, top]].map(([u0, v0]) => { const u = (u0 + v0 * k) * mx, v = v0 * my; return [t.x + u * c - v * s, t.y + u * s + v * c]; });
}

// ---------- colours ----------
const ACI_BASE = { 1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192] };
// ACI 10-249: 24 hues 15° apart, each at brightness 255, 204, 153, 127, 76 and
// full or half saturation, levels truncated (11 #FF7F7F, 12 #CC0000, 16 #7F0000,
// 17 #7F3F3F, 20 #FF3F00); 250-255 greys 51, 91, 132, 173, 214, 255. The index a
// DWG true colour shows as is the nearest of these (js/dwg.js), as ODA's DXF of
// AutoCAD-saved drawings gives it (grey 166 is 253; (125,33,79) is 247)
export function aciColour(i) {
  let c;
  if (ACI_BASE[i]) c = ACI_BASE[i];
  else if (i >= 10 && i <= 249) {
    const h = Math.floor((i - 10) / 10) * 15, v = (i - 10) % 10;
    const bright = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3][v];
    const sat = v % 2 ? 0.5 : 1;
    c = hsv(h, sat, bright);
  } else if (i >= 250 && i <= 255) c = [51, 91, 132, 173, 214, 255].map((g) => [g, g, g])[i - 250];
  else c = [255, 255, 255];
  return { r: c[0], g: c[1], b: c[2], aci: i };
}
const trueColour = (n) => ({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, aci: null });
function hsv(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return Math.floor(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))) + 1e-9); };
  return [f(5), f(3), f(1)];
}

// The colour to draw on paper (#f4f4f2): ACI 7 black; anything under 3:1
// against the paper darkened until it reaches 3:1
export function onPaper(c) {
  if (c.aci === 7) return '#000000';
  let [r, g, b] = [c.r, c.g, c.b];
  const hex = () => `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
  // (the paper and the contrast formula are the display styles': js/styles.js)
  for (let k = 0; k < 40 && contrast(hex(), PAPER) < 3; k++) { r *= 0.9; g *= 0.9; b *= 0.9; }
  return hex();
}
