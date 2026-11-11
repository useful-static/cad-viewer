// 2D DXF drawings (plan feature 23; feature review item 23): a group-code
// parser, ASCII or binary: model space, and each layout (paper space: its own
// entities and model space through its viewports), flattened to what a 2D
// canvas strokes:
//   { units, insunits, layers: [{ name, colour, on }], extents, paperSpace,
//     paths: [{ layer, colour, pts: Float64Array xy..., closed, fill, dash, weight, ltype, width?,
//               point?, outline?, evenodd?, frame?, circle?, hold?, via?, clip?, clipPoly? }],
//     texts: [{ layer, colour, x, y, h, rot, text, align, valign, mtext, fit?, fitMode?, mirrorX?, mirrorY?,
//               widthFactor?, oblique?, wrap?, clip?, clipPoly?, hold?, via? }],
//   (circle: drawn as a whole circle, for 2D Measure's centre and Ø; hold: the frozen layers of the
//   references it is drawn under, which hide it; via: the layers of every reference it is drawn
//   under, which a viewport freezing one of them hides it by -- r99 A5)
//     layouts: [{ name, paths, texts, extents }], notDrawn: { KIND: count } }
//   (a DWG's, through js/dwg.js drawDWG, adds checkFailures: the format checks it failed)
//   (a path's dash: its line type's pattern in drawing units, or null; weight: its line weight in
//   mm, or null; ltype: the line type's name; width: a polyline's, in drawing units -- a tapering
//   one, or one through a stretch, is its line plus filled outlines (outline: true, not a shape of
//   its own); point: a POINT; evenodd: one hatch's loops, filled together even-odd; frame: a layout
//   viewport's frame. mirrorX / mirrorY: drawn mirrored about the point -- a backward / upside-down text,
//   or one in a mirroring block; widthFactor: its width x that, its 41 and its block's stretch
//   along it; oblique: its slant in radians; wrap: an MTEXT's reference width; clip: a layout
//   viewport's frame [x0, y0, x1, y1] a text is clipped to, or the box of the clip outline a text or
//   path is seen through, the outline itself in clipPoly (xy, flat): the view clips them to it,
//   even-odd, and 2D Measure and the hover take a point of them only where inOutline says the
//   outline shows it. A path or text seen through a viewport is whole, kept where the outline shows
//   some of it; a frame is an outline of four points. h, fit and wrap are lengths: TEXT_LENGTHS)
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

import { BINARY_DXF_SENTINEL, MAX_TEXT_BYTES, looksLikeDxf, tooMuchText } from './formats.js';
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
  'Gm', 'AU', 'ly', 'pc', 'US ft', 'US in', 'US yd', 'US mi']; // (22-24 too: the table stopped at 21, r88 Q3)
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
export function dxfText(buf, what = 'the drawing', max = MAX_TEXT_BYTES) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // (one string: past the text readers' one limit, refused in their words -- a 600 MB DXF met the
  // engine's "Cannot create a string longer than 0x1fffffe8 characters": r70 Q5)
  if (u8.length > max) throw tooMuchText(what, u8.length);
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
// (opts.walked: a Set given the blockKey of each block the drawing walks -- inserted where it is
// drawn: what drawDWG counts its own drops against, one reach for both)
// A block's key, as parseDXF holds its name (\U+ / \M+ decoded): by upper case, the one rule for the
// blocks, the insert chain, the layouts and the `walked` set its readers keep -- three spellings of
// one name went into and out of that set, and a layout's drops went uncounted (r88 A1, A6). Trimmed,
// as parseDXF's `get` reads every value: drawDWG's adapter keeps "Door " whole, and a drop in that
// block went uncounted (r89 A2)
// The fold, one character to one: a character whose upper case is two keeps its own ("ß", "ﬁ"),
// so "Straße" and "STRASSE", two blocks, are two keys -- by String's full mapping one, every insert
// of the first drew the second (r89 Q2). The one key for every symbol-table name: blocks, layers,
// line types
export const nameKey = (name) => { let o = ''; for (const c of String(name).trim()) { const u = c.toUpperCase(); o += u.length === c.length ? u : c; } return o; };
export const blockKey = nameKey;
export function parseDXF(s, opts = {}) {
  const walked = opts.walked || null;
  // (a Uint8Array or a Node Buffer read as its bytes: it failed with the engine's "text.split is not
  // a function")
  if (s instanceof Uint8Array) s = s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength);
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
  // (a LAYER's handle -> its name: a viewport names the layers frozen in it by handle, 341)
  const layerByHandle = new Map();
  const ltypes = new Map(); // upper-case name -> [dash, gap, ...] in drawing units, or null (continuous)
  if (sec.TABLES) {
    for (const r of records(ps, ...sec.TABLES)) {
      if (r.type === 'LTYPE') {
        // 49: each element's length (+ dash, - gap, 0 dot); shapes and text in a
        // pattern are not drawn (their space is kept)
        const els = all(r, 49);
        ltypes.set(nameKey(get(r, 2, '')),els.length ? els.map((x) => (x === 0 ? 0.0001 : Math.abs(x))) : null);
        continue;
      }
      if (r.type !== 'LAYER') continue;
      const aci = num(r, 62, 7);
      const tc = get(r, 420, null);
      // (frozen, kept apart from off: a block reference on a frozen layer draws none of its block,
      // its entities on other layers too, where one on a layer that is off hides only what takes
      // the insert's layer -- r64 Q1)
      layers.set(get(r, 2, '0'), { name: get(r, 2, '0'), colour: tc !== null ? trueColour(Number(tc)) : aciColour(Math.abs(aci)), on: aci >= 0 && !(num(r, 70) & 1),
        frozen: !!(num(r, 70) & 1), ltype: nameKey(get(r, 6, 'CONTINUOUS')),weight: num(r, 370, -3) });
      const hd = get(r, 5, null);
      if (hd !== null) layerByHandle.set(String(hd).trim().toUpperCase(), get(r, 2, '0'));
    }
  }
  if (!layers.has('0')) layers.set('0', { name: '0', colour: aciColour(7), on: true });
  // (a layer named by any case is one layer, its table's spelling, as AutoCAD and the line types
  // here take it: a LINE on "walls" with "WALLS" frozen was drawn, and listed as a second layer --
  // r87 Q4. One no table names takes the first spelling met.)
  const layerByUpper = new Map([...layers.keys()].map((n) => [nameKey(n), n]));
  const layerName = (n) => {
    const u = nameKey(n);
    if (!layerByUpper.has(u)) layerByUpper.set(u, n);
    return layerByUpper.get(u);
  };
  // blocks: name -> { base, recs }
  const blocks = new Map();
  if (sec.BLOCKS) {
    let cur = null;
    for (const r of records(ps, ...sec.BLOCKS)) {
      // (by upper-case name, as an INSERT finds it: one naming "door" for BLOCK "DOOR" drew nothing
      // and said nothing -- r87 Q4)
      if (r.type === 'BLOCK') { cur = { base: [num(r, 10), num(r, 20), num(r, 30, 0) || 0], recs: [] }; blocks.set(blockKey(get(r, 2, '')), cur); } else if (r.type === 'ENDBLK') cur = null;
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
  // kind -> how many entities of it the drawing reaches and does not draw (model space and the
  // layouts): each entity once, however many times its block is inserted -- the rule drawDWG's
  // counts (js/dwg.js) follow too (counted per insert here and per object there, one table mixed
  // the two)
  const notDrawn = {};
  const counted = new WeakSet();
  const countOnce = (r, k) => { if (counted.has(r)) return; counted.add(r); notDrawn[k] = (notDrawn[k] || 0) + 1; };
  // (hold: the frozen layers of the block references being walked, outermost first, if any are --
  // each item drawn under them carries them, and is shown only while every one is: r64 Q1; the
  // outermost alone let a frozen reference inside another show, its outer layer turned on: r65 A3)
  // (via: the layers of every reference being walked, outermost first, which a viewport freezing
  // one of them hides the item by; hold is its frozen ones, derived from it, one rule -- the two
  // were kept side by side at four places, and their disagreeing was round 99's A1: r100 A4. Cached
  // per chain, so the items under one reference share one array, as the view's groups key them)
  const holdCache = new WeakMap();
  const holdOf = (via) => {
    if (!via) return null;
    if (!holdCache.has(via)) {
      const h = via.filter((l) => (layers.get(l) || {}).frozen);
      holdCache.set(via, h.length ? h : null);
    }
    return holdCache.get(via);
  };
  const ctxOf = (o) => {
    const c = { layers, layerName, blocks, out: o, ltypes, ltscale, codepage, budget, notDrawn, count: countOnce, walked, via: null };
    const mark = (it) => {
      if (it.via === undefined && c.via !== null) it.via = c.via;
      const h = holdOf(it.via);
      if (h) it.hold = h;
    };
    c.add = (p) => { if (p.pts.every(Number.isFinite)) { mark(p); addItem(budget, o.paths, p, p.pts.length); } };
    // (an INSERT's ATTRIB comes with its insert's layers already: r65 A2, r99 A1)
    c.addText = (t) => { if (Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.h)) { mark(t); addItem(budget, o.texts, t, 2); } };
    return c;
  };
  emit(ents, IDENT, null, 0, ctxOf(out));
  // Layouts (paper space): the active one is the entities flagged 67 = 1,
  // others are the *Paper_Space<n> blocks. Each draws its own entities and,
  // through each VIEWPORT (but the sheet's own, id 1), model space: a model
  // point m lands at C + R(twist) (h / viewHeight) (m - viewCentre),
  // clipped to the viewport's frame, which is drawn too (frame: true), leaving out the layers frozen
  // in that viewport (341) and what references on them draw; one whose clip boundary is no rectangle
  // (90 bit 0x10000, its entity 340) shows what it holds whole, the view clipping it to that outline
// (seenThrough), its frame not drawn; one turned
  // off (90 bit 0x20000) draws its frame alone. A DWG's, from R2000, as a DXF's (js/dwg.js VIEWPORT
  // writes its 90, 340 and 341 -- r99 Q1)
  // Each sheet's name and place among the tabs, from its LAYOUT (OBJECTS), whose block-record
  // handle (the 330 of its AcDbLayout part; the first 330 is its owner) names the paper space block
  // through the BLOCK_RECORD table. A drawing without them keeps the file's order, "Layout N"
  const recName = new Map();
  if (sec.TABLES) for (const r of records(ps, ...sec.TABLES)) if (r.type === 'BLOCK_RECORD') recName.set(get(r, 5, '').toUpperCase(), blockKey(get(r, 2, '')));
  // (keyed by blockKey, as `blocks` is: each kept its own upper case, one rule in two places -- r89 A4)
  const sheetOf = new Map(); // paper space block's key (blockKey) -> { name, tab }
  if (sec.OBJECTS) {
    for (const r of records(ps, ...sec.OBJECTS)) {
      if (r.type !== 'LAYOUT') continue;
      const k = r.g.findIndex((x) => x[0] === 100 && String(x[1]).trim() === 'AcDbLayout');
      const g = k < 0 ? r.g : r.g.slice(k);
      const val = (c) => { const x = g.find((y) => y[0] === c); return x ? String(x[1]).trim() : undefined; };
      const bn = recName.get((val(330) || '').toUpperCase());
      // (its name with its \U+ / \M+ characters decoded, as a block's or a layer's are: a pre-R2007
      // file's "布局1" read "\U+5E03\U+5C401")
      if (bn && val(1) !== undefined) sheetOf.set(bn, { name: unescapeDxf(val(1)), tab: Number(val(71)) });
    }
  }
  const sets = [];
  const active = every.filter(inPaper);
  if (active.length) sets.push({ recs: active, sheet: sheetOf.get(blockKey('*Paper_Space')) });
  // (a layout's block is walked as its sheet: opts.walked holds it, so drawDWG need not know the
  // layouts' naming)
  for (const [name, b] of blocks) {
    if (!/^\*Paper_Space\d+$/i.test(name)) continue;
    if (walked) walked.add(name); // (the blocks' key: blockKey)
    if (b.recs.length) sets.push({ recs: b.recs, sheet: sheetOf.get(name) });
  }
  // (in tab order where the drawing gives one: 13 sheets came in an order of their own)
  const tabOf = (s) => (s.sheet && Number.isFinite(s.sheet.tab) ? s.sheet.tab : Infinity);
  sets.sort((a, b) => tabOf(a) - tabOf(b));
  // each model path's box [x0, y0, x1, y1], once, for the viewports' cull
  const pathBoxes = sets.length ? out.paths.map(boxOf) : [];
  // and each model text's box, its corners' (textCorners): a viewport is a turn and a scale, so a
  // text whose box lies outside what it shows of the model is outside it
  const textBoxes = sets.length ? out.texts.map((t) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of textCorners(t)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  }) : [];
  // and where each band group (one `band` id: a tapering polyline's paths) that starts at k ends,
  // past its last path; 0 for a path of none -- once, not a property read a path a viewport
  const bandEnd = new Uint32Array(sets.length ? out.paths.length : 0);
  for (let k = 0; k < bandEnd.length; k++) {
    const b = out.paths[k].band;
    if (!b) continue;
    let e = k + 1;
    while (e < out.paths.length && out.paths[e].band === b) e++;
    bandEnd[k] = e;
    k = e - 1;
  }
  const layouts = sets.map(({ recs, sheet }, li) => {
    const lo = { paths: [], texts: [] };
    emit(recs.filter((r) => r.type !== 'VIEWPORT'), IDENT, null, 0, ctxOf(lo));
    // a viewport's frame, on its layer
    const frame = (v, rect) => {
      const layer = layerName(get(v, 8, '0'));
      lo.paths.push({ layer, colour: (layers.get(layer) || {}).colour || aciColour(7), dash: null, weight: null, ltype: 'CONTINUOUS',
        pts: Float64Array.of(rect[0], rect[1], rect[2], rect[1], rect[2], rect[3], rect[0], rect[3]), closed: true, fill: false, frame: true });
    };
    let byHandle = null;
    for (const v of recs) {
      if (v.type !== 'VIEWPORT' || num(v, 69, 0) === 1) continue;
      const cx = num(v, 10), cy = num(v, 20), w = num(v, 40), h = num(v, 41), vh = num(v, 45);
      if (!(w > 0 && h > 0)) continue;
      const rect = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
      // (one whose view is not known -- an R13-R14 DWG's, kept in a table not read -- is its frame)
      // and one looking other than straight down (a view direction not along z: an isometric) is not
      // drawn as a plan view of model space: its frame alone, counted
      const vd = [num(v, 16, 0), num(v, 26, 0), num(v, 36, 1)];
      const plan = Math.hypot(vd[0], vd[1]) <= 1e-9 * Math.abs(vd[2]) && vd[2] > 0;
      if (!(vh > 0) || !plan) { frame(v, rect); countOnce(v, !(vh > 0) ? 'VIEWPORT (its view not read)' : 'VIEWPORT (not a plan view)'); continue; }
      // (one turned off -- 90 bit 0x20000 -- shows nothing through it, its frame alone, as AutoCAD
      // draws it: it drew model space -- r99 Q3)
      if (num(v, 90, 0) & 0x20000) { frame(v, rect); continue; }
      const s = h / vh, tw = (num(v, 51) * Math.PI) / 180;
      // (its view centre, 12 / 22, is relative to its view target, 17 / 27: taken as a model point,
      // 12 viewports of the dozens showed empty or the wrong part of the model)
      const c = Math.cos(tw) * s, si = Math.sin(tw) * s, mx = num(v, 12) + num(v, 17, 0), my = num(v, 22) + num(v, 27, 0);
      const M = [c, si, -si, c, cx - (c * mx - si * my), cy - (si * mx + c * my)];
      // (what a viewport draws of model space counts against the drawing's budget too: many
      // viewports multiply it)
      const p0 = lo.paths.length;
      // (a clip boundary that is no rectangle -- 90 bit 0x10000, its entity named by 340 on this
      // sheet: what it shows is cut to that outline, and no rectangle is drawn, the outline being an
      // entity of the sheet's own. Clipped to its rectangle, three of a house plan's viewports drew
      // frames AutoCAD does not, and their lines past the boundary -- r98 Q3)
      let poly = null;
      const clipH = num(v, 90, 0) & 0x10000 ? get(v, 340, null) : null;
      if (clipH !== null) {
        const key = String(clipH).trim().toUpperCase();
        // (by the sheet's handles, indexed once: each viewport scanned every record, and 16,000 of
        // them took 18 s, four times as long each time their number doubled -- r99 A3)
        if (!byHandle) { byHandle = new Map(); recs.forEach((r, i) => { const h = get(r, 5, null); if (h !== null) byHandle.set(String(h).trim().toUpperCase(), i); }); }
        const at = byHandle.has(key) ? byHandle.get(key) : -1;
        if (at >= 0) {
          let end = at + 1;
          if (recs[at].type === 'POLYLINE') {
            while (end < recs.length && recs[end].type === 'VERTEX') end++;
            if (end < recs.length && recs[end].type === 'SEQEND') end++;
          }
          const tmp = { paths: [], texts: [] };
          emit(recs.slice(at, end), IDENT, null, 0, ctxOf(tmp));
          const outline = tmp.paths.find((p) => p.closed && !p.outline && p.pts.length >= 6);
          if (outline) {
            poly = [];
            for (let k = 0; k < outline.pts.length; k += 2) poly.push([outline.pts[k], outline.pts[k + 1]]);
          }
        }
        // (a boundary that gives no outline here -- a REGION, which VPCLIP takes, or a handle that
        // names nothing: drawn nothing through, counted, as AutoCAD would draw only what it clips;
        // read as no boundary, it drew the whole rectangle and a frame AutoCAD does not -- r103 Q4)
        if (!poly) { countOnce(v, 'VIEWPORT (its clip boundary not read)'); continue; }
      }
      // (the layers frozen in this viewport alone, 341 by handle: drawn through it, a kitchen's
      // equipment tags its author froze on the electrical sheet showed there, 123 paths -- r98 Q2. A
      // path held under a layer -- inside a reference on it -- goes with it. A DWG's are read by
      // js/dwg.js and written here as 341)
      // (by 341 or 331: ODA and LibreDWG write a drawing's as 331, a soft pointer, from R2004 on, and
      // those were drawn -- 060's "SECTIONS AND DETAILS" differed from its own DWG on 8 layers: r100 Q2)
      const vpFrozen = new Set(v.g.filter(([c]) => c === 341 || c === 331).map(([, h]) => layerByHandle.get(String(h).trim().toUpperCase())).filter((n) => n !== undefined).map((n) => nameKey(layerName(n))));
      const frozenHere = (it) => vpFrozen.size > 0 && (vpFrozen.has(nameKey(it.layer)) || (it.via || []).some((l) => vpFrozen.has(nameKey(l))));
      // (what clips it: its outline, or its frame as one of four points -- one mechanism, the view
      // clipping, and one snap rule, for both: a frame's lines were cut here and an outline's not,
      // and a wall's snaps differed by which clipped it, r103 A1. Its points, one array every item
      // seen through it shares, and its box)
      const ring = poly || [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]];
      const clip = { poly: Float64Array.from(ring.flat()), box: [Math.min(...ring.map((q) => q[0])), Math.min(...ring.map((q) => q[1])), Math.max(...ring.map((q) => q[0])), Math.max(...ring.map((q) => q[1]))] };
      // a path whose box lies outside what the viewport shows of model space is passed over with one
      // box test -- the box the texts are culled by too, the outline's (the frame's, culling paths
      // alone, dropped a line its text beside it kept: r103 A2)
      const seen = viewInModel(M, clip.box);
      cull(budget, out.paths.length + out.texts.length);
      // (one polyline drawn as several paths -- a tapering one's centreline and its filled outlines,
      // one `band` id, added together -- is kept or dropped whole: kept by its fill alone, it was
      // drawn but not counted, and its layer not listed -- r105 A3)
      // (a path costs its points times the outline's, drawn or not: what the keep test and the view's
      // inside test cost -- by the points alone, 8,000 x 8,000 took 3.3 s, four times as long per
      // doubling: r99 A4. A frame's four points charged as one, as before r103: charged as four, two
      // drawings of the corpus, fish_processing_plant and 051-drawing, were refused)
      const per = poly ? ring.length : 1;
      const charge1 = (p) => clipped(budget, (p.pts.length / 2) * per);
      // (and a band tested as its pieces, theirs: a wide polyline's are some 8 points a segment, and
      // charged its points alone, 24,000 of them through a 407-point outline took 5.2 s within the
      // budget sized for 0.5 -- r106 A4)
      const chargeMore = (n) => clipped(budget, n * per);
      const outside = (bb) => bb[2] < seen[0] || bb[0] > seen[2] || bb[3] < seen[1] || bb[1] > seen[3];
      for (let k = 0; k < out.paths.length; k++) {
        // (kept only where the outline shows some of it, as drawn: kept whole whatever it showed, a
        // line in an L's notch counted as drawn and listed its layer, which the sheet draws nothing
        // of -- r103 A3. A path of no band group by one box test, as before r105: a group made and a
        // property read for every path in every viewport took 20,000 viewports 1.7 times as long --
        // r106)
        const e = bandEnd[k];
        if (!e) {
          if (outside(pathBoxes[k])) continue;
          const p = out.paths[k];
          if (frozenHere(p)) continue;
          charge1(p);
          const pts = seenPts(p, M);
          if (meetsAsDrawn(p, pts, s, clip.poly, chargeMore)) lo.paths.push(seenThrough(p, pts, s, clip));
          continue;
        }
        // (a group: its parts the cull passes, tested and charged; a part it passes over costs
        // nothing, and is carried, seen through, only when another part shows -- charged and seen
        // through always, tapering polylines outside a sheet's viewports refused a drawing that opened
        // with them at one width: r106 A3)
        const group = [];
        let shown = false;
        for (let j = k; j < e; j++) {
          const q = out.paths[j];
          if (frozenHere(q)) continue;
          if (outside(pathBoxes[j])) { group.push([q, null]); continue; }
          charge1(q);
          const pts = seenPts(q, M);
          group.push([q, pts]);
          if (!shown) shown = meetsAsDrawn(q, pts, s, clip.poly, chargeMore);
        }
        if (shown) for (const [q, pts] of group) lo.paths.push(seenThrough(q, pts || seenPts(q, M), s, clip));
        k = e - 1;
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
      for (let ti = 0; ti < out.texts.length; ti++) {
        const t = out.texts[ti];
        // (passed over by its model box, as a path is: every text was moved, measured and boxed in
        // every viewport, and charged as one box test -- 20,000 texts through 100 viewports took
        // 12.3 s within 1 % of the budget: r107 Q2)
        if (outside(textBoxes[ti])) continue;
        if (frozenHere(t)) continue;
        const [x, y] = ap(M, t.x, t.y);
        // (every length of it scaled by the viewport, TEXT_LENGTHS: a fit width unscaled drew it 10
        // times too long through a 0.1 viewport, and a wrap width unscaled ran it on in one line)
        const seen = sameLines(t, { ...t, x, y, rot: t.rot + tw });
        for (const k of TEXT_LENGTHS) if (t[k]) seen[k] = t[k] * s;
        // kept when its box meets the viewport's frame, and clipped to it as the paths are (kept or
        // dropped whole by its point, a text ran past the frame, or vanished though half inside)
        const c = textCorners(seen);
        const bx = [Math.min(...c.map((q) => q[0])), Math.max(...c.map((q) => q[0]))], by = [Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[1]))];
        // (kept when the outline shows some of its box -- a corner of it inside, an edge of the
        // outline across it, or the outline inside it, the r100 A2 rule -- and clipped to the outline
        // by the view, always: whether it crosses is the font's to say, not the estimate's --
        // "WWWWWWWW" boxed inside by 0.6 a character ran 30 units past the frame in the font)
        const box = [bx[0], by[0], bx[1], by[1]];
        // (charged the outline's points: the keep test, and the view's clip, cost them -- r103 Q2)
        if (poly) clipped(budget, ring.length);
        if (!boxMeetsOutline(box, c, clip.poly)) continue;
        // (its outline's box, for the extents and the hover's first test, and the outline itself)
        seen.clip = clip.box.slice();
        seen.clipPoly = clip.poly;
        addItem(budget, lo.texts, seen, 2);
      }
      if (!poly) frame(v, rect);
    }
    return { name: sheet && sheet.name ? sheet.name : recs === active ? 'Layout' : `Layout ${li + 1}`, paths: lo.paths, texts: lo.texts, extents: extentsOf(lo, layers) };
  });
  // (a layer no table names, in model space or a layout, is a layer too -- one only texts use as
  // well: its texts could not be hidden, and the layer count was short)
  const untabled = (items) => { for (const p of items) if (!layers.has(p.layer)) layers.set(p.layer, { name: p.layer, colour: aciColour(7), on: true }); };
  untabled(out.paths);
  untabled(out.texts);
  for (const l of layouts) { untabled(l.paths); untabled(l.texts); }
  const u = UNITS[insunits];
  return { units: u ? u[0] : null, insunits,
    layers: [...layers.values()], paths: out.paths, texts: out.texts, extents: extentsOf(out, layers), paperSpace, layouts, notDrawn };
}

// A drawing text's fields that are lengths in drawing units (the text contract): what a
// change of scale -- a layout viewport -- multiplies
const TEXT_LENGTHS = ['h', 'fit', 'wrap'];


// A point inside a polygon given flat, xy... (even-odd) -- written in two places once: r100 A5
export function insideFlat(p, x, y) {
  let ins = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
// Whether a viewport's clip outline (flat, xy...) shows a point: the one geometric question the
// page asks of it -- 2D Measure's snaps and the hover. Inside it by the even-odd rule the view
// clips by (ctx.clip(outline, 'evenodd')), or on one of its edges, as a frame shows the lines on it
// (r102 Q1). What is drawn the canvas clips; nothing here cuts geometry (r103, the parent's
// direction: rounds 99 to 102 each found a case the hand-written cut got wrong)
export function inOutline(p, x, y) {
  return insideFlat(p, x, y) || onOutlineEdge(p, x, y);
}
// whether a point lies on one of an outline's edges
export function onOutlineEdge(p, x, y) {
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const cx = p[j], cy = p[j + 1], dx = p[i] - cx, dy = p[i + 1] - cy, L2 = dx * dx + dy * dy;
    if (!L2) continue;
    const w = (x - cx) * dx + (y - cy) * dy;
    if (w < 0 || w > L2) continue;
    const tol = 1e-9 * Math.max(1, Math.abs(x), Math.abs(y), Math.sqrt(L2));
    if (Math.abs(dx * (y - cy) - dy * (x - cx)) <= tol * Math.sqrt(L2)) return true;
  }
  return false;
}
// The pieces of segment a-b that lie along an outline's edges: [t0, t1, ...] along it (0 at a, 1 at
// b), one pair an edge it overlaps. What the view strokes again unclipped, the clip having cut a
// line's outer half there. (Decided for the whole segment by five points on some edge, a wall across
// a notch in its edge was drawn over the notch, and one running past its edge's end not at all --
// r104 Q1, Q2)
export function edgeOverlaps(p, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy, out = [];
  if (!L2) return out;
  const L = Math.sqrt(L2);
  const off = (x, y) => Math.abs(vx * (y - ay) - vy * (x - ax)) / L; // (from the line through a, b)
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const cx = p[j], cy = p[j + 1], dx = p[i], dy = p[i + 1];
    const tol = 1e-9 * Math.max(1, Math.abs(cx), Math.abs(cy), Math.abs(dx), Math.abs(dy), L);
    if (off(cx, cy) > tol || off(dx, dy) > tol) continue;
    const tc = ((cx - ax) * vx + (cy - ay) * vy) / L2, td = ((dx - ax) * vx + (dy - ay) * vy) / L2;
    const t0 = Math.max(0, Math.min(tc, td)), t1 = Math.min(1, Math.max(tc, td));
    if (t1 > t0) out.push(t0, t1);
  }
  return out;
}
// Whether segments a-b and c-d meet (touching counts)
function segsMeet(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const d1 = o(cx, cy, dx, dy, ax, ay), d2 = o(cx, cy, dx, dy, bx, by), d3 = o(ax, ay, bx, by, cx, cy), d4 = o(ax, ay, bx, by, dx, dy);
  if (d1 !== d2 && d3 !== d4) return true;
  const on = (px, py, qx, qy, rx, ry) => Math.min(px, qx) <= rx && rx <= Math.max(px, qx) && Math.min(py, qy) <= ry && ry <= Math.max(py, qy);
  return (d1 === 0 && on(cx, cy, dx, dy, ax, ay)) || (d2 === 0 && on(cx, cy, dx, dy, bx, by)) || (d3 === 0 && on(ax, ay, bx, by, cx, cy)) || (d4 === 0 && on(ax, ay, bx, by, dx, dy));
}
// The pieces of segment a-b that an outline (flat) shows, inOutline's rule: [t0, t1, ...] along it
// (0 at a, 1 at b). The hover's nearest point of a line the outline hides some of (r105 Q4)
export function insidePieces(p, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy, ts = [0, 1], out = [];
  if (!L2) return inOutline(p, ax, ay) ? [0, 1] : out;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const cx = p[j], cy = p[j + 1], ex = p[i] - cx, ey = p[i + 1] - cy, den = vx * ey - vy * ex;
    if (den) {
      const t = ((cx - ax) * ey - (cy - ay) * ex) / den, u = ((cx - ax) * vy - (cy - ay) * vx) / den;
      // (u within a hair of the edge's ends: a crossing at an outline's vertex can round just past
      // both edges' ends, and a hidden piece counted shown -- r106 Q2)
      if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
    } else {
      // (parallel: an edge along it starts and ends a piece)
      for (const [x, y] of [[cx, cy], [p[i], p[i + 1]]]) { const t = ((x - ax) * vx + (y - ay) * vy) / L2; if (t > 0 && t < 1) ts.push(t); }
    }
  }
  ts.sort((a, b) => a - b);
  for (let k = 0; k + 1 < ts.length; k++) {
    const t0 = ts[k], t1 = ts[k + 1];
    if (!(t1 > t0)) continue;
    const tm = (t0 + t1) / 2;
    if (!inOutline(p, ax + tm * vx, ay + tm * vy)) continue;
    if (out.length && out[out.length - 1] === t0) out[out.length - 1] = t1; else out.push(t0, t1);
  }
  return out;
}
// An outline (flat) with its edges in a grid: inOutline and insidePieces for it, the same answers, by
// the edges near the question alone -- the hover asks them of every line and band near the cursor,
// and through a 16,000-point outline each walked every edge: 268 ms a hover (r106 Q5)
export function outlineIndex(p) {
  const m = p.length / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
  const G = Math.max(1, Math.ceil(Math.sqrt(m / 4))), cw = (x1 - x0) / G || 1, ch = (y1 - y0) / G || 1;
  const col = (x) => Math.max(0, Math.min(G - 1, Math.floor((x - x0) / cw))), row = (y) => Math.max(0, Math.min(G - 1, Math.floor((y - y0) / ch)));
  const cells = Array.from({ length: G * G }, () => []);
  // the cells segment a-b crosses, row by row: in each row, the columns of its part in that row's
  // band of y (by its box, a long edge was in every cell of its box -- a hub and spokes of 32,000
  // points built in 726 ms and 474 MB: r107 Q4)
  const cellsOf = (ax, ay, bx, by, f) => {
    const r0 = row(Math.min(ay, by)), r1 = row(Math.max(ay, by));
    for (let r = r0; r <= r1; r++) {
      let lo = Math.min(ax, bx), hi = Math.max(ax, bx);
      if (ay !== by && r0 !== r1) {
        // (x where it crosses the row's lower and upper y, clamped to the segment)
        const ya = y0 + r * ch, yb = ya + ch, xAt = (yy) => ax + ((bx - ax) * (yy - ay)) / (by - ay);
        const ta = Math.max(Math.min(ay, by), ya), tb = Math.min(Math.max(ay, by), yb);
        const xa = xAt(ta), xb = xAt(tb);
        lo = Math.min(xa, xb); hi = Math.max(xa, xb);
      }
      for (let c = Math.max(0, col(lo) - 1); c <= Math.min(G - 1, col(hi) + 1); c++) f(r * G + c);
    }
  };
  // (edge e runs from point e - 1 to point e, as insideFlat walks them)
  for (let e = 0; e < m; e++) {
    const j = ((e + m - 1) % m) * 2, i = e * 2;
    cellsOf(p[j], p[j + 1], p[i], p[i + 1], (cell) => cells[cell].push(e));
  }
  const stamp = new Uint32Array(m);
  let tick = 0;
  const fresh = () => { if (++tick === 0xffffffff) { stamp.fill(0); tick = 1; } };
  const each = (cell, f) => { for (const e of cells[cell]) if (stamp[e] !== tick) { stamp[e] = tick; f(e); } };
  // every edge of the cells of rows r0..r1 and columns c0..c1, once
  const visit = (r0, r1, c0, c1, f) => {
    fresh();
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) each(r * G + c, f);
  };
  const onEdge = (x, y, e) => {
    const j = ((e + m - 1) % m) * 2, i = e * 2;
    const cx = p[j], cy = p[j + 1], dx = p[i] - cx, dy = p[i + 1] - cy, L2 = dx * dx + dy * dy;
    if (!L2) return false;
    const w = (x - cx) * dx + (y - cy) * dy;
    if (w < 0 || w > L2) return false;
    const tol = 1e-9 * Math.max(1, Math.abs(x), Math.abs(y), Math.sqrt(L2));
    return Math.abs(dx * (y - cy) - dy * (x - cx)) <= tol * Math.sqrt(L2);
  };
  const inside = (x, y) => {
    // (past the outline's box by more than onEdge's tolerance at most: outside)
    const tol = 1e-9 * Math.max(1, Math.abs(x), Math.abs(y), x1 - x0 + (y1 - y0));
    if (x < x0 - tol || x > x1 + tol || y < y0 - tol || y > y1 + tol) return false;
    // even-odd by the edges a ray to the right crosses (insideFlat's rule), and on an edge near it
    let ins = false, on = false;
    const r = row(y), c = col(x);
    visit(r, r, c, G - 1, (e) => {
      const j = ((e + m - 1) % m) * 2, i = e * 2;
      const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
    });
    if (ins) return true;
    visit(Math.max(0, r - 1), Math.min(G - 1, r + 1), Math.max(0, c - 1), Math.min(G - 1, c + 1), (e) => { if (!on) on = onEdge(x, y, e); });
    return on;
  };
  const pieces = (ax, ay, bx, by) => {
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy, ts = [0, 1], out = [];
    if (!L2) return inside(ax, ay) ? [0, 1] : out;
    fresh();
    cellsOf(ax, ay, bx, by, (cell) => each(cell, (e) => {
      const j = ((e + m - 1) % m) * 2, i = e * 2;
      const cx = p[j], cy = p[j + 1], ex = p[i] - cx, ey = p[i + 1] - cy, den = vx * ey - vy * ex;
      if (den) {
        const t = ((cx - ax) * ey - (cy - ay) * ex) / den, u = ((cx - ax) * vy - (cy - ay) * vx) / den;
        if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
      } else {
        for (const [x, y] of [[cx, cy], [p[i], p[i + 1]]]) { const t = ((x - ax) * vx + (y - ay) * vy) / L2; if (t > 0 && t < 1) ts.push(t); }
      }
    }));
    ts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      if (!(t1 > t0)) continue;
      const tm = (t0 + t1) / 2;
      if (!inside(ax + tm * vx, ay + tm * vy)) continue;
      if (out.length && out[out.length - 1] === t0) out[out.length - 1] = t1; else out.push(t0, t1);
    }
    return out;
  };
  // the edges within r of (x, y): their points' offsets, [from, to, ...] (the hover's shownD2)
  const near = (x, y, r) => {
    const out = [];
    visit(row(y - r), row(y + r), col(x - r), col(x + r), (e) => {
      const j = ((e + m - 1) % m) * 2, i = e * 2;
      if (ptSegDist2(x, y, p[j], p[j + 1], p[i], p[i + 1]) <= r * r) out.push(j, i);
    });
    return out;
  };
  let entries = 0;
  for (const c of cells) entries += c.length;
  return { inside, pieces, near, cells: G * G, entries };
}
// Whether an outline (flat) shows some of a path (flat points, closed or not; a fill's inside too):
// a point of it the outline shows, an edge of the outline across it, or -- a fill -- the outline
// inside it. A test, not a cut: what is drawn of it the view's clip decides
function meetsOutline(pts, closed, fill, poly) {
  const n = pts.length / 2, m = poly.length / 2;
  for (let i = 0; i < n; i++) if (inOutline(poly, pts[2 * i], pts[2 * i + 1])) return true;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    for (let e = 0; e < m; e++) {
      const f = (e + 1) % m;
      if (segsMeet(pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1], poly[2 * e], poly[2 * e + 1], poly[2 * f], poly[2 * f + 1])) return true;
    }
  }
  return !!fill && n >= 3 && insideFlat(pts, poly[0], poly[1]);
}
// Whether an outline shows some of a path as drawn: a wide polyline's band (pathBands), any piece
// of it, as a fill; else the path itself
// (p's points pts, its width scaled by s: a path seen through a viewport, tested before it is copied)
// (charge(n): what testing n points more costs -- a band's pieces past its own points)
function meetsAsDrawn(p, pts, s, poly, charge = () => {}) {
  if (!isBand(p)) return meetsOutline(pts, p.closed || p.fill, p.fill, poly);
  const bands = pathBands(p, pts, s);
  if (!bands.length) return false; // (nothing drawn: one repeated point, ends flat)
  // (a point of its centreline the outline shows is a point of its band it shows: no pieces needed)
  for (let i = 0; i < pts.length; i += 2) if (inOutline(poly, pts[i], pts[i + 1])) return true;
  // (a wide polyline's pieces; a filled outline is its own points, charged already: r107 A8)
  if (isWide(p)) { let n = 0; for (const b of bands) n += b.length / 2; charge(n); }
  return bands.some((b) => meetsOutline(b, true, true, poly));
}
// the squared distance from point (x, y) to segment a-b
export function ptSegDist2(x, y, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0;
  return (x - ax - t * vx) ** 2 + (y - ay - t * vy) ** 2;
}

// A wide polyline as the canvas strokes it (js/dxf-view.js: ends flat, joins mitred up to
// MITER_LIMIT, else bevelled): its pieces, each a convex polygon (flat, xy...) -- a rectangle a
// segment, a wedge a join. The one shape the keep test, the cull, the extents and the hover read
// (r104 read it as round-ended and round-jointed: a band whose flat end stopped short of a frame
// was kept with nothing drawn, and a mitre's tip inside one was dropped -- r105 A1, A2, A4, A5)
export const MITER_LIMIT = 10;
export function bandPolys(pts, closed, half) {
  // (a repeated point makes no segment and no join, as the canvas takes it)
  const q = distinctPts(pts, closed);
  const n = q.length / 2, out = [];
  if (n < 2 || !(half > 0)) return out;
  const segs = closed ? n : n - 1, dir = new Float64Array(2 * segs);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n, dx = q[2 * j] - q[2 * i], dy = q[2 * j + 1] - q[2 * i + 1], L = Math.hypot(dx, dy);
    dir[2 * i] = dx / L; dir[2 * i + 1] = dy / L;
    const nx = (-dy / L) * half, ny = (dx / L) * half;
    out.push(Float64Array.of(q[2 * i] + nx, q[2 * i + 1] + ny, q[2 * j] + nx, q[2 * j + 1] + ny, q[2 * j] - nx, q[2 * j + 1] - ny, q[2 * i] - nx, q[2 * i + 1] - ny));
  }
  // the joins: at vertex v, from segment v - 1 to segment v (every vertex of a closed one)
  for (let v = closed ? 0 : 1; v <= (closed ? n - 1 : n - 2); v++) {
    const a = (v - 1 + segs) % segs;
    const w = joinWedge(q[2 * v], q[2 * v + 1], dir[2 * a], dir[2 * a + 1], dir[2 * v], dir[2 * v + 1], half);
    if (w) out.push(w);
  }
  return out;
}
// A band's join at vertex (vx, vy) from the unit direction u to the unit direction w, half wide: the
// wedge (flat, xy...) on its outer side, mitred up to MITER_LIMIT, else bevelled; null going straight
// on or back on itself. bandPolys's, and the hover's, which makes it when asked (r106 A5)
export function joinWedge(vx, vy, ux, uy, wx, wy, half) {
  const cr = ux * wy - uy * wx, dot = ux * wx + uy * wy;
  if (!(Math.abs(cr) >= 1e-12)) return null;
  const s = cr > 0 ? -1 : 1; // (the outer side: the right of a left turn)
  const ax = vx - s * uy * half, ay = vy + s * ux * half, bx = vx - s * wy * half, by = vy + s * wx * half;
  const c = Math.sqrt((1 + dot) / 2); // (the cosine of half the turn: the mitre is 1 / c widths long)
  if (c > 0 && 1 / c <= MITER_LIMIT) {
    const mx = -(uy + wy), my = ux + wx, ml = Math.hypot(mx, my), k = (s * half) / (c * ml);
    return Float64Array.of(vx, vy, ax, ay, vx + mx * k, vy + my * k, bx, by);
  }
  return Float64Array.of(vx, vy, ax, ay, bx, by);
}
// A polyline's points with each repeat of the point before dropped (and a closed one's last, its
// first again): what the canvas joins, bandPolys's points and the hover's
export function distinctPts(pts, closed) {
  const q = [];
  for (let k = 0; k < pts.length; k += 2) {
    const x = pts[k], y = pts[k + 1];
    if (q.length && q[q.length - 2] === x && q[q.length - 1] === y) continue;
    q.push(x, y);
  }
  if (closed && q.length > 4 && q[0] === q[q.length - 2] && q[1] === q[q.length - 1]) q.length -= 2;
  return q;
}
// A path's band as drawn, or null when it is a line: a wide polyline's pieces (bandPolys), a wide
// polyline's filled outline (a tapering one's, or one through a stretch: `outline`) itself
// (pts, s: its points and the scale of a view of it -- a viewport's -- else its own)
export function pathBands(p, pts = p.pts, s = 1) {
  if (isWide(p)) return bandPolys(pts, p.closed, (p.width * s) / 2);
  if (p.outline && p.fill) return [pts];
  return null;
}
// whether a path is drawn as a band: a wide polyline stroked at its width (isWide), or a wide
// polyline's filled outline -- the one spelling (r106 L5)
export const isWide = (p) => p.width > 0 && !p.fill;
export const isBand = (p) => isWide(p) || (!!p.outline && !!p.fill);
// Whether an outline shows some of a text's box (box [x0, y0, x1, y1], its corners c): a corner
// inside, an edge of the outline across it (r100 A2), or the outline inside it
function boxMeetsOutline(box, c, poly) {
  if (c.some(([x, y]) => inOutline(poly, x, y))) return true;
  const ring = Float64Array.from(c.flat());
  return meetsOutline(ring, true, true, poly) || (poly[0] >= box[0] && poly[0] <= box[2] && poly[1] >= box[1] && poly[1] <= box[3]);
}
// One model path seen through a viewport clipped to an outline (paper coordinates): whole, as it
// is, with the outline it is seen through (clipPoly, and its box, clip) -- the view clips it there
// (js/dxf-view.js: ctx.clip(outline, 'evenodd')), and 2D Measure and the hover ask inOutline of a
// point. Cut here by hand, rounds 99 to 102 each found an outline the cut got wrong (r103)
// (pts: its points through the viewport, seenPts; s, the viewport's scale)
function seenThrough(p, pts, s, clip) {
  return { ...p, dash: p.dash ? p.dash.map((x) => x * s) : null, ...(p.width ? { width: p.width * s } : {}), pts, clipPoly: clip.poly, clip: clip.box };
}
// a model path's points through a viewport (M, model to paper)
function seenPts(p, M) {
  const n = p.pts.length / 2;
  const pts = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) { const [x, y] = ap(M, p.pts[2 * i], p.pts[2 * i + 1]); pts[2 * i] = x; pts[2 * i + 1] = y; }
  return pts;
}

// a path's box [x0, y0, x1, y1] as drawn: a wide polyline's its band's (pathBands: r104 A1, r105 A2)
// -- the viewports' cull and the extents (itemsBox) by one rule; its points not a number left out
export function boxOf(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (q) => {
    for (let k = 0; k < q.length; k += 2) {
      if (!Number.isFinite(q[k]) || !Number.isFinite(q[k + 1])) continue;
      if (q[k] < x0) x0 = q[k]; if (q[k] > x1) x1 = q[k];
      if (q[k + 1] < y0) y0 = q[k + 1]; if (q[k + 1] > y1) y1 = q[k + 1];
    }
  };
  const bands = isWide(p) ? pathBands(p) : null;
  if (bands && bands.length) bands.forEach(add); else add(p.pts);
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

// The view's transform, a projection of a 3D point onto the sheet [a, b, c, d, e, f, g, h]:
// x' = a x + c y + g z + e, y' = b x + d y + h z + f. Its first six are the 2D affine every 2D
// reading takes (the axes, the widths, the angles); g, h carry z, which a 2D affine dropped: inside a
// block inserted with a tilted extrusion, every z of its contents was lost -- a CIRCLE at elevation 5
// in one along +X drawn at x 0 (r96 A1). At the top level, seen from +Z, g = h = 0.
const IDENT = [1, 0, 0, 1, 0, 0, 0, 0];
const ap = (m, x, y, z = 0) => [m[0] * x + m[2] * y + (m[6] || 0) * z + m[4], m[1] * x + m[3] * y + (m[7] || 0) * z + m[5]];
// a direction (3D) through the projection's linear part
const lin = (m, v) => [m[0] * v[0] + m[2] * v[1] + (m[6] || 0) * v[2], m[1] * v[0] + m[3] * v[1] + (m[7] || 0) * v[2]];
// A projection m after a 3D affine A -- its axes' images X, Y, Z (3D) and its origin's T: m∘A
const compose = (m, { X, Y, Z, T }) => {
  const [ax, ay] = lin(m, X), [bx, by] = lin(m, Y), [cx, cy] = lin(m, Z), [tx, ty] = ap(m, T[0], T[1], T[2]);
  return [ax, ay, bx, by, tx, ty, cx, cy];
};
// the angle of a direction (dx, dy) through a transform's linear part
const dirThrough = (m, dx, dy) => Math.atan2(m[1] * dx + m[3] * dy, m[0] * dx + m[2] * dy);

// An entity's extrusion N, of unit length
// (one of no length, or not a number -- a damaged file's --, is +Z: it collapsed every point to
// (0, 0) without a word, a circle so drawn read Ø 0 -- r96 Q4)
function extrusionOf(r) {
  const nx = num(r, 210, 0), ny = num(r, 220, 0), nz = num(r, 230, 1);
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 1e-12) || !Number.isFinite(l)) return [0, 0, 1];
  return [nx / l, ny / l, nz / l];
}
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// An entity's elevation: its OCS z, which lies along N -- a LWPOLYLINE's 38, the others' point's 30.
// It is read only through ocs(), which only entities drawn in their OCS use (O); those in world
// coordinates (LINE, POINT, ELLIPSE, SPLINE, LEADER, 3DFACE, MTEXT, a 3D POLYLINE) take their own z
// through M and never read it. The table and the dimensions draw their block, whose point 30 is no
// elevation: none (the list named nine kinds it changed nothing for -- r96 A3)
const NO_ELEVATION = new Set(['DIMENSION', 'ARC_DIMENSION', 'LARGE_RADIAL_DIMENSION', 'ACAD_TABLE']);
const elevationOf = (r) => (NO_ELEVATION.has(r.type) ? 0 : num(r, r.type === 'LWPOLYLINE' ? 38 : 30, 0) || 0);
// The arbitrary-axis rule: an entity's OCS as a 3D affine -- its x and y axes from its extrusion N,
// N its z, and its origin at its elevation along N (dropped, a circle extruded along +X at elevation
// 5 was drawn at x 0, not x 5 -- r95 Q1). Its 2D points are at OCS z 0 (the elevation is in T); a
// block it inserts takes its z through Z.
function ocs(r) {
  const N = extrusionOf(r);
  const z = elevationOf(r);
  if (N[0] === 0 && N[1] === 0 && N[2] === 1) return { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1], T: [0, 0, z] };
  const W = Math.abs(N[0]) < 1 / 64 && Math.abs(N[1]) < 1 / 64 ? [0, 1, 0] : [0, 0, 1];
  const nrm = (v) => { const k = Math.hypot(...v) || 1; return v.map((x) => x / k); };
  const Ax = nrm(cross3(W, N));
  const Ay = nrm(cross3(N, Ax));
  return { X: Ax, Y: Ay, Z: N, T: [N[0] * z, N[1] * z, N[2] * z] };
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
  name = blockKey(name); // (a block by any case is one block, its chain too: r87 Q4)
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

// the hold under a reference on frozen layer `layer`, from the hold it is walked under: that layer
// added once (the one rule for a reference and its ATTRIBs, a missing block's too: r67 A6)
const holdUnder = (held, layer) => (held && held.includes(layer) ? held : [...(held || []), layer]);
function emit(recs, M, byBlock, depth, ctx) {
  if (depth > 16) return;
  walk(ctx.budget, recs.length);
  // (the layers of the INSERT just walked, for the ATTRIBs after it: its frozen ones hold them --
  // r65 A2 -- and a viewport freezing one hides them, as it hides the block -- r99 A1)
  let attVia = null;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.type !== 'ATTRIB' && r.type !== 'SEQEND') attVia = null;
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
    let layer = ctx.layerName(get(r, 8, '0')); // (by its table's spelling: r87 Q4)
    // an entity on layer 0 inside a block takes the insert's layer
    if (layer === '0' && byBlock && byBlock.layer) layer = byBlock.layer;
    const colour = colourOf(r, ctx, byBlock && byBlock.colour, layer);
    // the line type (BYLAYER / BYBLOCK resolved) as a dash pattern in the entity's own units
    // ($LTSCALE x its 48), made each shape's in drawing units by dashFor below, and the line
    // weight in mm (370: 1/100 mm; -1 BYLAYER, -2 BYBLOCK, -3 the default) -- the comment named the
    // insert's scale, the rule before r97 A2 (r98 A4)
    const L = ctx.layers.get(layer) || {};
    let lt = nameKey(get(r, 6, 'BYLAYER'));
    if (lt === 'BYLAYER') lt = L.ltype || 'CONTINUOUS';
    else if (lt === 'BYBLOCK') lt = (byBlock && byBlock.ltype) || 'CONTINUOUS';
    const pat = ctx.ltypes.get(lt);
    // (the pattern in the entity's own units; each shape's in drawing units by how much it is
    // stretched as drawn -- its drawn length over its own: by the transform's x axis alone, a dashed
    // line along y in a 1 x 4 insert was drawn 40 long with 1-unit dashes, and in a tilted one
    // shortened but its dashes full -- r97 A2. Exact for a line, the mean along a curve)
    const own = pat ? pat.map((x) => x * ctx.ltscale * num(r, 48, 1)) : null;
    // (whether a shape's own points, x y z in threes, are one z: flat in the view's plane)
    const flatOf = (p3) => { for (let i = 5; i < p3.length; i += 3) if (p3[i] !== p3[2]) return false; return true; };
    const lenOf = (pts, dim, closed) => {
      let s = 0;
      const n = pts.length / dim;
      for (let i = 1; i < n + (closed ? 1 : 0); i++) {
        const a = (i - 1) * dim, b = (i % n) * dim;
        s += Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1], dim === 3 ? pts[b + 2] - pts[a + 2] : 0);
      }
      return s;
    };
    // (under a turn and a uniform scale -- with no z column -- the transform's own scale, one number
    // for every path: measured per path, rounding split shapes that shared one stroke into many,
    // 278 strokes a frame to 6,115 -- r97 Q2; a stretched or tilted one by the ratio, to 9 digits)
    // (and only for a shape flat in T's own plane -- its points one z: a tilted ELLIPSE took the
    // shortcut and dashed 1 where the CIRCLE drawn the same dashed 0.8125, and a 3D LINE dashed 1.0 in
    // a 1 x 1 insert and 0.6 in a 1 x 1.1 one -- r98 A3)
    const dashFor = (ownLen, drawn, closed, T = M, flat = true) => {
      if (!own) return null;
      let k;
      if (flat && conformalOf(T) && !T[6] && !T[7]) k = Math.hypot(T[0], T[1]);
      else {
        const d = lenOf(drawn, 2, closed);
        k = ownLen > 0 ? Number((d / ownLen).toPrecision(9)) : Math.hypot(T[0], T[1]);
      }
      return own.map((x) => x * k);
    };
    let lw = num(r, 370, -1);
    if (lw === -1) lw = L.weight ?? -3;
    else if (lw === -2) lw = byBlock && byBlock.weight !== undefined ? byBlock.weight : -3;
    // (no dash of its own: every shape's is dashFor's, and a point draws none -- the old rule's here
    // was read by nothing but a POINT: r98 A4)
    const sty = { dash: null, weight: lw >= 0 ? lw / 100 : null, ltype: lt };
    const O = compose(M, ocs(r));
    // (width: a polyline's width in its own units, scaled by the transform into drawing units)
    // (extra: outline -- a wide polyline's filled outline, not a shape of its own: not counted as
    // one, not snapped to; evenodd -- one hatch's loops, filled together even-odd)
    const path = (pts, closed = false, fill = false, width = 0, extra = null) => {
      const f = new Float64Array(pts.length);
      for (let k = 0; k < pts.length; k += 2) { const [x, y] = ap(O, pts[k], pts[k + 1]); f[k] = x; f[k + 1] = y; }
      const w = width > 0 ? width * Math.sqrt(Math.abs(O[0] * O[3] - O[1] * O[2])) : 0;
      // (a curve's own points, when its maker marked them: arcPts, bulgePts -- 2D Measure snaps to those)
      const own = pts.own ? { own: Uint32Array.from(pts.own), mids: Uint32Array.from(pts.mids || []) } : null;
      ctx.add({ layer, colour, ...sty, dash: dashFor(lenOf(pts, 2, closed), f, closed, O), pts: f, closed, fill, ...(w > 0 ? { width: w } : {}), ...own, ...extra });
    };
    // a polyline with its widths (widthsOf): one width, stroked at it; else its line (1 px: what a
    // click and a snap find) and each wide segment's outline, filled
    // (one width through a transform that is not a turn and a uniform scale -- a block stretched
    // 4 x 1 -- is no longer one width: drawn as its outlines, through the transform exactly, as a
    // tapering one is; stroked at sqrt|det| it was 4 wide where it is 8)
    // (its axes the same length and square to each other)
    const conformal = conformalOf(O);
    const drawWide = (sh) => {
      let outlines = sh.outlines, width = sh.width || 0;
      if (width && !conformal && sh.src) {
        const { xs, ys, bul, closed } = sh.src, w = new Array(xs.length).fill(width);
        outlines = taperOutlines(xs, ys, bul, w, w, closed);
        width = 0;
      }
      // (its centreline and its outlines one `band`: a viewport keeps or drops them together, r105 A3)
      const band = outlines && outlines.length ? { band: (ctx.budget.bands = (ctx.budget.bands || 0) + 1) } : null;
      path(sh.pts, sh.closed, false, width, sh.circle && conformal ? { circle: true, ...band } : band);
      if (outlines) for (const o of outlines) if (o.every(Number.isFinite)) path(o, true, true, 0, { outline: true, ...band });
    };
    switch (r.type) {
      case 'LINE': {
        // LINE's points are in world coordinates, not its OCS
        // (with their z: inside a tilted insert it reaches the view -- r96 A1)
        const p3 = [num(r, 10), num(r, 20), num(r, 30, 0) || 0, num(r, 11), num(r, 21), num(r, 31, 0) || 0];
        const a = ap(M, p3[0], p3[1], p3[2]), b = ap(M, p3[3], p3[4], p3[5]);
        const f = Float64Array.of(a[0], a[1], b[0], b[1]);
        ctx.add({ layer, colour, ...sty, dash: dashFor(lenOf(p3, 3, false), f, false, M, flatOf(p3)), pts: f, closed: false, fill: false });
        break;
      }
      case 'POINT': {
        const [x, y] = ap(M, num(r, 10), num(r, 20), num(r, 30, 0) || 0);
        ctx.add({ layer, colour, ...sty,pts: Float64Array.of(x, y, x, y), closed: false, fill: false, point: true });
        break;
      }
      // (marked a circle where it is drawn as one -- a turn and a uniform scale -- for 2D Measure's
      // centre and its Ø, which a 12-gon or a circle inserted at 1 x 0.985 read as: r70 Q6)
      case 'CIRCLE': {
        const c = arcPts(num(r, 10), num(r, 20), num(r, 40), 0, 2 * Math.PI);
        c.own = []; c.mids = []; // (no ends, no middle: its centre is its snap)
        path(c, true, false, 0, conformal ? { circle: true } : null);
        break;
      }
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
        // world coordinates: centre, the major axis end (3D), the minor ratio; the minor axis is
        // ratio * (N x major), projected onto XY with the major -- an ellipse seen from -Z runs the
        // other way by it, and one tilted is drawn as it is seen (its minor taken in XY as the
        // major's perpendicular, an ellipse seen edge-on was drawn whole -- r95 Q1)
        const cx = num(r, 10), cy = num(r, 20), cz = num(r, 30, 0) || 0, mx = num(r, 11), my = num(r, 21), mz = num(r, 31, 0) || 0, ratio = num(r, 40, 1);
        let t0 = num(r, 41, 0), t1 = num(r, 42, 2 * Math.PI);
        if (!Number.isFinite(t0) || !Number.isFinite(t1)) break;
        if (t1 <= t0) t1 += 2 * Math.PI;
        if (t1 - t0 > 2 * Math.PI) t1 = t0 + 2 * Math.PI; // (at most one turn)
        const minor = cross3(extrusionOf(r), [mx, my, mz]).map((v) => v * ratio);
        let n = Math.max(8, Math.ceil((t1 - t0) / SEG_RAD));
        n += n & 1; // (even: its mid-parameter point one of its points, a snap -- r113 R2-F3)
        const pts = [], own3 = [];
        for (let k = 0; k <= n; k++) {
          const t = t0 + ((t1 - t0) * k) / n;
          const c = Math.cos(t), s = Math.sin(t);
          const q = [cx + mx * c + minor[0] * s, cy + my * c + minor[1] * s, cz + mz * c + minor[2] * s];
          const [x, y] = ap(M, q[0], q[1], q[2]);
          pts.push(x, y);
          own3.push(...q);
        }
        const whole = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-9;
        // (one of ratio 1, a full turn, is a circle, some exporters' way to write one: marked as a
        // CIRCLE is -- 677 at hand had no centre since r70 -- r71 A7, Q2)
        // (by the one rule a CIRCLE is marked by, conformalOf, on its own plane as the view projects
        // it -- its major and minor axes' images: an exact |N.z| test beside it lost a circle's centre
        // tilted 1e-4 rad that a CIRCLE kept -- r96 A2; one seen tilted is not round in the view)
        const [ux, uy] = lin(M, [mx, my, mz]), [vx, vy] = lin(M, minor);
        const round = whole && Math.abs(Math.abs(ratio) - 1) <= CIRCLE_ROUNDING && (ux || uy) && conformalOf([ux, uy, vx, vy, 0, 0]);
        ctx.add({ layer, colour, ...sty, dash: dashFor(lenOf(own3, 3, false), pts, false, M, flatOf(own3)), pts: Float64Array.from(pts), closed: whole, fill: false, ...(round ? { circle: true } : {}),
          own: Uint32Array.from(whole ? [] : [0, n]), mids: Uint32Array.from(whole ? [] : [n / 2]) });
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
          r.shape = { pts: pts.every(Number.isFinite) ? pts : null, closed, circle: bulgeCircle(xs, ys, bul, closed), ...widthsOf(xs, ys, bul, w0, w1, closed) };
        }
        if (r.shape.pts) drawWide(r.shape);
        break;
      }
      case 'POLYLINE': {
        // its VERTEX records follow it to SEQEND
        // (a 2D polyline's widths: each vertex's start / end (40 / 41), else the polyline's)
        const xs = [], ys = [], zs = [], bul = [], w0 = [], w1 = [];
        const d0 = num(r, 40, 0) || 0, d1 = num(r, 41, 0) || 0;
        let j = i + 1;
        // (its vertices are the VERTEX records right after it, to its SEQEND -- walked to the next
        // SEQEND whatever came between, a polyline missing its vertices took every entity up to a
        // later one's SEQEND with it, undrawn and uncounted)
        for (; j < recs.length && recs[j].type === 'VERTEX'; j++) {
          if (num(recs[j], 70) & 16) continue; // a spline frame control point
          xs.push(num(recs[j], 10)); ys.push(num(recs[j], 20)); zs.push(num(recs[j], 30, 0) || 0); bul.push(num(recs[j], 42));
          w0.push(num(recs[j], 40, d0) || 0); w1.push(num(recs[j], 41, d1) || 0);
        }
        i = j < recs.length && recs[j].type === 'SEQEND' ? j : j - 1;
        const flags = num(r, 70);
        // a 3D mesh or a polyface: not drawn in 2D, and counted so (467 at hand were left out without
        // a word, while a 3D solid was counted)
        if (flags & (16 | 64)) { const k = flags & 64 ? 'POLYLINE (polyface)' : 'POLYLINE (3D mesh)'; ctx.count(r, k); break; }
        const closed = (flags & 1) === 1;
        // (a 3D polyline's vertices are world coordinates, their z with them: r96 A1)
        if (flags & 8) {
          const f = Float64Array.from(xs.flatMap((x, k) => ap(M, x, ys[k], zs[k])));
          const own3 = xs.flatMap((x, k) => [x, ys[k], zs[k]]);
          ctx.add({ layer, colour, ...sty, dash: dashFor(lenOf(own3, 3, closed), f, closed, M, flatOf(own3)), pts: f, closed, fill: false });
        }
        else drawWide({ pts: bulgePts(xs, ys, bul, closed), closed, circle: bulgeCircle(xs, ys, bul, closed), ...widthsOf(xs, ys, bul, w0, w1, closed) });
        break;
      }
      case 'SPLINE': {
        const pts = splinePts(r); // (x, y, z in threes, world coordinates)
        if (pts.length >= 6) {
          const f = new Float64Array((pts.length / 3) * 2);
          for (let k = 0, o = 0; k < pts.length; k += 3, o += 2) { const [x, y] = ap(M, pts[k], pts[k + 1], pts[k + 2]); f[o] = x; f[o + 1] = y; }
          const closed = (num(r, 70) & 1) === 1;
          // (its snaps its two ends: its points are its curve's samples, not its own -- r113 R2-F3)
          ctx.add({ layer, colour, ...sty, dash: dashFor(lenOf(pts, 3, closed), f, closed, M, flatOf(pts)), pts: f, closed, fill: false,
            own: Uint32Array.from(closed ? [] : [0, f.length / 2 - 1]), mids: new Uint32Array(0) });
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
          for (const loop of r.loops) path(loop, true, true, 0, { evenodd: id, ...(loop.circle && conformal ? { circle: true } : {}) });
        } else for (const loop of r.loops) path(loop, true, solid, 0, loop.circle && conformal ? { circle: true } : null);
        break;
      }
      case '3DFACE': {
        // world corners (the fourth repeats the third for a triangle); 70's bits 1, 2, 4, 8 hide
        // the first .. fourth edge
        const z = (c, d) => num(r, c, d === undefined ? 0 : num(r, d, 0)) || 0;
        const own4 = [[num(r, 10), num(r, 20), z(30)], [num(r, 11), num(r, 21), z(31)], [num(r, 12), num(r, 22), z(32)], [num(r, 13, num(r, 12)), num(r, 23, num(r, 22)), z(33, 32)]];
        const c = own4.map(([x, y, zz]) => ap(M, x, y, zz));
        const hide = num(r, 70);
        if (!(hide & 15)) {
          const f = Float64Array.from(c.flat());
          ctx.add({ layer, colour, ...sty, dash: dashFor(lenOf(own4.flat(), 3, true), f, true, M, flatOf(own4.flat())), pts: f, closed: true, fill: false });
          break;
        }
        for (let e = 0; e < 4; e++) {
          if (hide & (1 << e)) continue;
          const a = c[e], b = c[(e + 1) % 4], f = Float64Array.of(a[0], a[1], b[0], b[1]);
          ctx.add({ layer, colour, ...sty, dash: dashFor(lenOf([...own4[e], ...own4[(e + 1) % 4]], 3, false), f, false, M, own4[e][2] === own4[(e + 1) % 4][2]), pts: f, closed: false, fill: false });
        }
        break;
      }
      case 'TEXT': case 'MTEXT': case 'ATTRIB': case 'ATTDEF': {
        // (an ATTRIB is a TEXT that follows its INSERT -- a title block's values -- and one
        // flagged invisible (70 bit 1) is not drawn; its vertical alignment is 74, not 73)
        if (r.type === 'ATTRIB' && (num(r, 70) & 1)) break;
        // (an ATTDEF is its block's definition of one, not drawn -- STRUCTURE --, but a constant
        // one (70 bit 2, not invisible) has no ATTRIB: its value is drawn from it, in every insert
        // of its block, as an ATTRIB is -- r64 Q4)
        if (r.type === 'ATTDEF' && (depth === 0 || (num(r, 70) & 3) !== 2)) break;
        // An R2018 multi-line ATTRIB holds its value as an embedded MTEXT after "101 Embedded
        // Object": that MTEXT is what is drawn -- its text, point, height and attachment (its own
        // group 1 is the first line only; drawn as a TEXT it stood 3.8 heights too high), the
        // ATTRIB's own groups read only before the 101. (Made once per entity, as the text is.)
        // (and an R2018 MTEXT's own groups end at its "101 Embedded Object": what follows -- a
        // point in its 11 -- was read as its direction, and 334 MTEXTs at hand drew turned 73.83°)
        if (r.src === undefined) {
          // (an ATTDEF drawn is read as an ATTRIB is)
          const att = r.type === 'ATTRIB' || r.type === 'ATTDEF';
          const emb = att || r.type === 'MTEXT' ? r.g.findIndex((x) => x[0] === 101) : -1;
          r.src = emb < 0 ? (att ? { type: 'ATTRIB', g: attribTextGroups(r.g) } : r)
            : att ? { type: 'MTEXT', g: r.g.slice(emb + 1) } : { type: 'MTEXT', g: r.g.slice(0, emb) };
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
          [item.x, item.y] = ap(P, num(e, 10), num(e, 20), num(e, 30, 0) || 0); // (its z: r96 A1)
          item.align = mtextAlign(a);
          item.valign = ['top', 'middle', 'bottom'][Math.floor((a - 1) / 3)];
          // 41, its reference width: its lines wrap at it (they ran on in one line)
          rw = num(e, 41, 0);
          // 44, its line spacing factor (0.25 to 4; 1 when absent): its lines pitchOf apart
          { const ls = num(e, 44, 1); if (Number.isFinite(ls) && ls !== 1) item.lineSpacing = Math.min(4, Math.max(0.25, ls)); }
          // (its direction 11/21/31 a world vector: its sizes taken in its own plane -- x along it, y
          // N x it -- as the view projects that plane, as a TEXT's are in its OCS: taken in world XY,
          // an MTEXT tilted 45° kept its full height where the TEXT beside it read 7.071 -- r97 A3)
          if (get(e, 11, null) !== null) {
            const N = extrusionOf(e), d3 = [num(e, 11), num(e, 21), num(e, 31, 0) || 0];
            const l = Math.hypot(...d3);
            const X = l > 0 ? d3.map((v) => v / l) : [1, 0, 0];
            const y = cross3(N, X), ly = Math.hypot(...y);
            F = ly > 1e-12 ? compose(M, { X, Y: y.map((v) => v / ly), Z: N, T: [0, 0, 0] }) : M;
            dv = ly > 1e-12 ? [1, 0] : [num(e, 11), num(e, 21)];
          } else { const a = (num(e, 50) * Math.PI) / 180; dv = [Math.cos(a), Math.sin(a)]; }
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
          // (its baseline seen end-on: its height along its own up, the baseline turned 90° -- the
          // frame's y axis gave 50=90 and 11=(0,0,1) of one text heights 0 and 2: r97 Q5)
          // (end-on to a rounding of the frame's own size: a baseline along world z left 6e-17 of sx)
          const endOn = sx <= 1e-12 * (Math.hypot(F[0], F[1], F[2], F[3]) || 1);
          const sy = !endOn ? Math.abs(F[0] * F[3] - F[1] * F[2]) / sx : Math.hypot(-F[0] * dv[1] + F[2] * dv[0], -F[1] * dv[1] + F[3] * dv[0]) / dl;
          // (seen end-on -- its baseline, or its height, to a rounding of the frame's size -- it is a
          // line of no width in the view: not drawn. As width 0 the view drew it whole, a 0 width
          // factor read as none, its box and wrap too; at 89.9° it was not drawn and at 90° drawn
          // whole -- r98 Q1)
          if (endOn || !(sy > 1e-12 * (Math.hypot(F[0], F[1], F[2], F[3]) || 1))) break;
          item.h *= sy;
          const sw = sx;
          if (Number.isFinite(rw) && rw > 0) item.wrap = rw * sw;
          if (det < 0) { item.rot = item.dir - Math.PI; item.mirrorX = !item.mirrorX; } else item.rot = item.dir;
          if (!item.mirrorX) delete item.mirrorX;
          delete item.dir;
          if (!item.fit && sy > 0 && Math.abs(sw / sy - 1) > 1e-9) item.widthFactor = (item.widthFactor || 1) * (sw / sy);
        }
        if (r.type === 'ATTRIB' && attVia) item.via = attVia;
        ctx.addText(item);
        break;
      }
      case 'INSERT': case 'DIMENSION': case 'ARC_DIMENSION': case 'LARGE_RADIAL_DIMENSION': case 'ACAD_TABLE': {
        // A table is drawn as its block (*T…) inserted at its point, as the DWG adapter writes it;
        // a dimension of any kind draws its block (blockRef). (A DXF's tables and arc dimensions
        // were counted "not drawn", while the same drawing's DWG drew them)
        const q = blockRef(r);
        const b = ctx.blocks.get(blockKey(get(q, 2, '')));
        // (a reference to a block not in the file draws nothing: counted, as a table's was alone --
        // and its ATTRIBs, which do draw, held to its frozen layer still: the hold was set after this,
        // and they drew at open -- r66 A7)
        if (!b) { attVia = holdUnder(ctx.via, layer); ctx.count(r, r.type); break; }
        const isDim = q.type !== 'INSERT';
        const sx = isDim ? 1 : num(q, 41, 1), sy = isDim ? 1 : num(q, 42, 1), sz = isDim ? 1 : num(q, 43, 1);
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
        if (ctx.walked) ctx.walked.add(blockKey(get(q, 2, '')));
        // (the layers of every reference it is drawn under, outermost first: a frozen one holds all it
        // draws -- r64 Q1, as hold, derived -- and a viewport freezing one hides all it draws there --
        // r98 Q2)
        const via = ctx.via;
        ctx.via = holdUnder(via, layer);
        // (and the ATTRIBs that follow it, to its SEQEND: they are the reference's -- r65 A2)
        attVia = ctx.via;
        try {
          for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
            const c = Math.cos(rot), s = Math.sin(rot);
            // insertion point (its z in the OCS's T), then rotation and scale -- z by 43 --, the array
            // cell, the block base (its z too): one 3D affine, so the contents' z reaches the view
            // through a tilted insert (r96 A1)
            const X = [c * sx, s * sx, 0], Y = [-s * sy, c * sy, 0], Z = [0, 0, sz];
            const bx = b.base[0], by = b.base[1], bz = b.base[2] || 0;
            const T = [ix + c * ci * dc - s * ri * dr - (X[0] * bx + Y[0] * by), iy + s * ci * dc + c * ri * dr - (X[1] * bx + Y[1] * by), -sz * bz];
            emit(b.recs, compose(isDim ? M : O, { X, Y, Z, T }), inner, depth + 1, ctx);
          }
        } finally { ctx.via = via; }
        break;
      }
      case 'LEADER': {
        // its vertices (10 / 20, world coordinates), as a polyline (the arrowhead is not drawn)
        const xs = all(r, 10), ys = all(r, 20), zs = all(r, 30);
        if (xs.length >= 2) {
          const pts = [];
          for (let k = 0; k < xs.length; k++) pts.push(...ap(M, xs[k], ys[k] ?? 0, zs[k] || 0));
          const own3 = xs.flatMap((x, k) => [x, ys[k] ?? 0, zs[k] || 0]);
          if (pts.every(Number.isFinite)) ctx.add({ layer, colour, ...sty, dash: dashFor(lenOf(own3, 3, false), pts, false, M, flatOf(own3)), pts: Float64Array.from(pts), closed: false, fill: false });
        } else ctx.count(r, 'LEADER'); // (one without its vertices: a DWG's, whose are not decoded)
        break;
      }
      default:
        // any other kind is one the drawing does not draw, counted by name so the page can say so
        // (a closed list of names missed custom kinds: AutoCAD Mechanical's, an AEC wall)
        if (!STRUCTURE.has(r.type)) ctx.count(r, r.type);
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
  // (an even count, so its mid-angle point is one of its points)
  let n = Math.max(8, Math.ceil((a1 - a0) / SEG_RAD));
  n += n & 1;
  const out = [];
  for (let k = 0; k <= n; k++) { const t = a0 + ((a1 - a0) * k) / n; out.push(cx + r * Math.cos(t), cy + r * Math.sin(t)); }
  // its own points, for 2D Measure's snaps: its two ends, and its middle on the arc -- not every
  // chord's end and middle, which lie inside the curve (r113 R2-F3); a circle's call clears them
  out.own = [0, n];
  out.mids = [n / 2];
  return out;
}

// A polyline's widths, per segment start (w0) and end (w1): { width } when every segment has the
// one width (0: none), else { outlines } (taperOutlines)
// A polyline that is a full circle: closed, and every segment an arc the same way about one centre at
// one radius, a full turn in all -- how a CAD program writes a circle as a polyline (r70 Q6). Its
// segments of no length are passed over (a PCB export writes a pad's circle as four vertices, each
// end doubled, bulges 0 1 0 1: two vertices only, 87 such a drawing had no centre -- r71 Q2)
// (what a written number's rounding may leave of a circle's sameness, as a share: an INSERT scaled
// 41=-0.0010000000002037268 42=0.000999999996565748, a unit conversion's, is 1.8e-9 apart, and its
// 240 circles lost their centre under 1e-9 -- r71 Q2. A 1 x 0.985 insert stays an ellipse)
const CIRCLE_ROUNDING = 1e-6;
// (and a polyline's bulges, written to as few as five digits: its arcs one circle to this share)
const BULGE_ROUNDING = 1e-4;
// a transform that draws a circle as a circle: its axes the same length and square to each other
function conformalOf(O) {
  const ax2 = O[0] * O[0] + O[1] * O[1], ay2 = O[2] * O[2] + O[3] * O[3];
  return Math.abs(ax2 - ay2) <= CIRCLE_ROUNDING * (ax2 + ay2) && Math.abs(O[0] * O[2] + O[1] * O[3]) <= CIRCLE_ROUNDING * (ax2 + ay2);
}
function bulgeCircle(xs, ys, bul, closed) {
  if (!closed || xs.length < 2) return false;
  let cx0 = NaN, cy0 = NaN, r0 = NaN, sweep = 0;
  for (let k = 0; k < xs.length; k++) {
    const x0 = xs[k], y0 = ys[k], x1 = xs[(k + 1) % xs.length], y1 = ys[(k + 1) % xs.length];
    const dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy);
    if (d === 0) continue;
    const b = bul[k] || 0;
    if (b === 0 || !Number.isFinite(b) || !Number.isFinite(d)) return false;
    const th = 4 * Math.atan(b); // its included angle, signed
    const r = d / (2 * Math.sin(Math.abs(th) / 2));
    // its centre: off the chord's middle, toward the side it turns to
    const h = (d / 2) / Math.tan(th / 2);
    const cx = (x0 + x1) / 2 - (dy / d) * h, cy = (y0 + y1) / 2 + (dx / d) * h;
    // (to the rounding a file's written bulges keep: 0.414214, six digits, moves each arc's radius by
    // 2e-6 of it, past CIRCLE_ROUNDING -- r72 Q7. Every segment an arc already, so no polygon passes)
    if (Number.isNaN(r0)) { cx0 = cx; cy0 = cy; r0 = r; } else if (Math.hypot(cx - cx0, cy - cy0) > BULGE_ROUNDING * r0 || Math.abs(r - r0) > BULGE_ROUNDING * r0 || Math.sign(th) !== Math.sign(sweep)) return false;
    sweep += th;
  }
  return Number.isFinite(r0) && r0 > 0 && Math.abs(Math.abs(sweep) - 2 * Math.PI) < BULGE_ROUNDING * 2 * Math.PI;
}
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
  // (its own vertices' indices, and each arc's middle point's: 2D Measure's snaps -- r113 R2-F3)
  const own = [], mids = [];
  const n = xs.length;
  for (let k = 0; k < n; k++) {
    own.push(out.length / 2);
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
    let steps = Math.max(2, Math.ceil(Math.abs(th) / SEG_RAD));
    steps += steps & 1; // (even: the arc's middle one of its points)
    mids.push(out.length / 2 - 1 + steps / 2);
    for (let s = 1; s < steps; s++) { const a = a0 + (th * s) / steps; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
  }
  if (closed && n) { own.push(out.length / 2); out.push(xs[0], ys[0]); }
  out.own = own;
  out.mids = mids;
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
// (its points x, y, z, in threes: a spline is in world coordinates, and inside a tilted insert its z
// reaches the view -- r96 A1)
function evalSpline(r) {
  const deg = num(r, 71, 3);
  const knots = all(r, 40);
  const cx = all(r, 10), cy = all(r, 20), czr = all(r, 30);
  const cz = cx.map((_, k) => czr[k] || 0);
  const w = all(r, 41);
  if (cx.length < 2) {
    const fx = all(r, 11), fy = all(r, 21), fz = all(r, 31);
    return fx.flatMap((x, k) => [x, fy[k], fz[k] || 0]);
  }
  const n = cx.length;
  // a degree that is not a whole number from 1 to n - 1 (de Boor would read slots that do not
  // exist), or over MAX_SPLINE_DEGREE (evaluation costs points x degree^2: a 300-point spline of
  // degree 299 took 12 s), or knots that do not fit it: the control polygon
  if (!Number.isInteger(deg) || deg < 1 || deg >= n || deg > MAX_SPLINE_DEGREE || knots.length !== n + deg + 1) return cx.flatMap((x, k) => [x, cy[k], cz[k]]);
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
    for (let j = 0; j <= deg; j++) { const i = k - deg + j; d.push([cx[i] * W[i], cy[i] * W[i], cz[i] * W[i], W[i]]); }
    for (let rr = 1; rr <= deg; rr++) {
      for (let j = deg; j >= rr; j--) {
        const i = k - deg + j;
        const den = knots[i + deg - rr + 1] - knots[i];
        const a = den ? (t - knots[i]) / den : 0;
        d[j] = [0, 1, 2, 3].map((c) => (1 - a) * d[j - 1][c] + a * d[j][c]);
      }
    }
    const p = d[deg];
    out.push(p[0] / p[3], p[1] / p[3], p[2] / p[3]);
  }
  return out;
}

// arcs: [cx, cy, r, sweep, ccw] of a hatch boundary's edges -> whether they are one circle
function hatchCircle(arcs) {
  if (!arcs.length) return false;
  const [cx, cy, r, , ccw] = arcs[0];
  if (!(r > 0)) return false;
  let sweep = 0;
  for (const [x, y, rr, s, w] of arcs) {
    if (Math.hypot(x - cx, y - cy) > CIRCLE_ROUNDING * r || Math.abs(rr - r) > CIRCLE_ROUNDING * r || w !== ccw) return false;
    sweep += s;
  }
  return Math.abs(sweep - 2 * Math.PI) < CIRCLE_ROUNDING * 2 * Math.PI;
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
      const bp = bulgePts(xs, ys, bs, true);
      append(pts, bp);
      pts.own = bp.own; pts.mids = bp.mids; // (its points from 0: the same indices)
      // (a boundary that is a circle marked one, as a polyline's is: 590 hatch circles at hand had
      // no centre since r70 -- r71 Q2)
      if (hasB && bulgeCircle(xs, ys, bs, true)) pts.circle = true;
    } else {
      const ne = count(at(93));
      const arcs = [];
      let others = 0, curved = false;
      for (let e = 0; e < ne; e++) {
        const et = at(72);
        if (et !== 2) others++;
        if (et !== 1) curved = true;
        if (et === 1) { pts.push(at(10), at(20), at(11), at(21)); } else if (et === 2) {
          const cx = at(10), cy = at(20), rr = at(40), a0 = (at(50) * Math.PI) / 180, a1 = (at(51) * Math.PI) / 180;
          const ccwArc = at(73);
          // (each arc kept, its sweep within one turn, to mark the boundary a circle: hatchCircle)
          arcs.push([cx, cy, rr, ((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI, !!ccwArc]);
          if (ccwArc) {
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
      // (a boundary of arc edges alone, one centre, one radius, one way round, a full turn in all: a
      // circle, marked as a polyline's is -- one edge of a full turn, or two halves or four quarters,
      // which some exporters write: r71 Q2, r72 A5)
      if (!others && hatchCircle(arcs)) pts.circle = true;
      // (a boundary with curved edges: its points are their samples, none a snap -- r113 R2-F3)
      if (curved) { pts.own = []; pts.mids = []; }
    }
    if (pts.length >= 6) loops.push(pts);
  }
  return loops;
}

// MTEXT without its formatting codes; \P (a paragraph) and \N (a column break) are each a new line
// (a code's value ends at its ";" and holds no backslash, so a run of codes with no ";" fails
// each match at the next backslash: one pass, not a rescan to the end from every code; a stack
// \S splits at its first separator, which its first part may not hold)
// One pass, left to right, so an escape is read before what it escapes: \\ a backslash, \{ \} a
// brace (bare braces group and are dropped), \P and \N a new line, \~ a space, \L \O \K and their ends
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
    // (\P a paragraph, \N a column break: each a new line here -- \N was drawn as the two
    // characters: r85 Q5)
    if (k === 'P' || k === 'N') { out += '\n'; i++; continue; }
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

// The layers an item answers to: its own and every frozen one it is drawn under (its hold). The one
// rule for the 2D view, the layer list and the info panel (js/main.js) and the extents (r65 A3)
export const layersOf = (it) => (it.hold ? [it.layer, ...it.hold] : [it.layer]);
// whether an item is drawn as the drawing opens: every layer it answers to on (not off, not frozen)
const layerIn = (layers, n) => (layers.get ? layers.get(n) : layers.find((x) => x.name === n));
export const drawnAtOpen = (it, layers) => layersOf(it).every((n) => { const l = layerIn(layers, n); return !l || l.on; });
// What a sheet draws as the drawing opens -- its lines and shapes, its texts -- and how many more its
// layers off or frozen hold: the one count for the info panel and dwg-check (two copies: r67 A5).
// layers: the drawing's (an array or a Map by name).
export function openCounts(sheet, layers) {
  const byName = layers instanceof Map ? layers : new Map(layers.map((x) => [x.name, x]));
  const shapes = sheet.paths.filter(isShape);
  const ns = shapes.filter((p) => drawnAtOpen(p, byName)).length, nt = sheet.texts.filter((t) => drawnAtOpen(t, byName)).length;
  return { shapes: ns, texts: nt, hidden: shapes.length - ns + sheet.texts.length - nt };
}
// (the extents leave out what a frozen layer holds, as AutoCAD's Zoom Extents does -- a frozen
// layer's reference far off made the drawing open at 1% of the view: r65 A4 --; a layer only off
// still counts, as there; all of it when that leaves nothing)
const thawed = (it, layers) => layersOf(it).every((n) => { const l = layerIn(layers, n); return !l || !l.frozen; });
function extentsOf(out, layers) {
  const kept = layers ? { paths: out.paths.filter((p) => thawed(p, layers)), texts: out.texts.filter((t) => thawed(t, layers)) } : out;
  return (layers && itemsBox(kept)) || itemsBox(out);
}
// (exported for the view's Fit, which frames the frozen layers the visitor turned on: r66 Q3)
export function itemsBox(out) {
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  for (const p of out.paths) {
    // (a wide polyline as drawn, its band: boxOf, the cull's box -- grown by half its width all round,
    // Fit cut a mitre's tip and framed empty sheet past a flat end: r105 A5)
    let [x0, y0, x1, y1] = boxOf(p);
    // (one seen through a clip outline, whole: what the outline's box shows of it, as a text's)
    if (p.clip) { x0 = Math.max(x0, p.clip[0]); y0 = Math.max(y0, p.clip[1]); x1 = Math.min(x1, p.clip[2]); y1 = Math.min(y1, p.clip[3]); }
    if (!(x0 <= x1 && y0 <= y1)) continue;
    min[0] = Math.min(min[0], x0); max[0] = Math.max(max[0], x1);
    min[1] = Math.min(min[1], y0); max[1] = Math.max(max[1], y1);
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
  // (an ATTDEF's part is AcDbAttributeDefinition: r64 Q4)
  const k = g.findIndex((x) => x[0] === 100 && (x[1] === 'AcDbAttribute' || x[1] === 'AcDbAttributeDefinition'));
  return k < 0 ? g : g.filter((x, i) => i < k || !ATTRIB_TEXT_CODES.has(x[0]));
}

// a drawing path that is one of its lines and shapes: not a wide polyline's outline (its
// polyline's), not a viewport's frame. The one rule for the info panel and dwg-check
export const isShape = (p) => !p.outline && !p.frame;
// whether a sheet (model space, or a layout) draws anything (a viewport's frame alone is not a
// drawing: a sheet of frames passed as one)
export const sheetDraws = (s) => s.paths.some(isShape) || s.texts.length > 0;
// The layouts a drawing offers -- those that draw something -- with their index: the one rule for
// the Sheet menu, the info panel's paper-space row and dwg-check (the row pointed at a menu the
// page hid, and the CLI counted every layout)
export const sheetsOf = (d) => d.layouts.map((l, i) => ({ l, i })).filter(({ l }) => sheetDraws(l));
// A drawing with nothing to show: no path or text in model space or any layout. The one rule for
// the page (it refuses the file) and dwg-check.mjs (it reports it)
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

// A text's height (40) is its capitals' height (the DXF reference; AutoCAD's SHX and TrueType
// styles alike): its font's em is that over TEXT_CAP, a sans-serif's capitals' share of the em (the
// em set to the height drew every text 31 % small: r113 R2-F1). An MTEXT's lines are 5/3 of its
// height apart (the reference's "3-on-5"), times its own factor, 44 (r113 R2-F2). The view and
// the boxes below take both from here.
export const TEXT_CAP = 0.72;
export const emOf = (t) => t.h / TEXT_CAP;
export const pitchOf = (t) => (t.h * 5 / 3) * (t.lineSpacing || 1);

// A text's corners as js/dxf-view.js places it: its lines (pitchOf apart), its width (its fit,
// else 0.6 of an em per character of the longest line), shifted by its alignment and
// vertical alignment, turned by its rotation. The extents took every text as left-aligned on its
// baseline, one line high: a 20-line MTEXT drawn below its point was cut off by Fit
// An MTEXT's lines wrapped by the estimate (a character -- a code point -- 0.6 of an em). The
// ratio is the same at any scale, so a text seen through many viewports is wrapped once (each
// wrapped it again: 1,400 viewports of one long MTEXT reached the worker's 60 s): the lines are kept
// with the text and given to each viewport's copy of it (a cache of 256 texts missed on every
// viewport for a drawing of 300)
const WRAPPED = new WeakMap();
function estimatedLines(t) {
  if (!(t.mtext && t.wrap > 0)) return null;
  let w = WRAPPED.get(t);
  if (!w) { w = wrapLines(t.text.split('\n'), (l) => [...l].length, t.wrap / (emOf(t) * 0.6 * (t.widthFactor || 1))); WRAPPED.set(t, w); }
  return w;
}
const sameLines = (from, to) => { const w = estimatedLines(from); if (w) WRAPPED.set(to, w); return to; };

// (drawn: its lines as the view drew them, when it has; else estimated)
// (width: the drawn width of its widest line, when the caller measured it -- the view, by its font)
export function textCorners(t, drawn = null, width = null) {
  const em = emOf(t);
  const per = em * 0.6 * (t.widthFactor || 1); // (a character's width, estimated)
  // an MTEXT with a reference width wraps at it (as the view does, by measure): its lines estimated
  const lines = drawn || estimatedLines(t) || t.text.split('\n');
  const lh = pitchOf(t);
  // (the longest line by a loop: spread into Math.max, 300k lines overflowed the stack)
  let longest = 0;
  for (const l of lines) { const n = l.length > longest ? [...l].length : 0; if (n > longest) longest = n; } // (code points: an astral character is one)
  const w = t.fit > 0 ? t.fit : width !== null ? width : per * longest;
  // (an MTEXT's block: its lines' pitch, and the last line's em -- the view hangs each em-box)
  const hBlock = (lines.length - 1) * lh + (t.mtext ? em : t.h);
  const x0 = t.fit > 0 ? 0 : t.align === 'center' ? -w / 2 : t.align === 'right' ? -w : 0;
  // (y up: the top of the block and its bottom, from the point)
  let top, bottom;
  if (t.mtext) {
    const y0 = t.valign === 'middle' ? hBlock / 2 : t.valign === 'bottom' ? hBlock : 0;
    top = y0; bottom = y0 - hBlock;
  } else {
    // the last line's baseline (or its bottom / middle / top) on the point, the lines above it
    const base = t.valign === 'top' ? -t.h : t.valign === 'middle' ? -t.h / 2 : 0;
    bottom = base - (t.valign === 'bottom' ? 0 : em * 0.25);
    top = base + t.h + (lines.length - 1) * lh;
  }
  const c = Math.cos(t.rot || 0), s = Math.sin(t.rot || 0);
  // (a backward / upside-down text is mirrored about its point, as the view draws it)
  const mx = t.mirrorX ? -1 : 1, my = t.mirrorY ? -1 : 1;
  // (an oblique text slanted as the view slants it, before the mirror: its tops moved along the
  // baseline -- its box left the slant 0.58 heights outside at 30°)
  // (slanted before its width is scaled, as the view does: the slant widens with the width factor,
  // or with a fit text's stretch)
  const sxs = t.fit > 0 ? (longest > 0 ? t.fit / (em * 0.6 * longest) : 1) : t.widthFactor || 1;
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
