// Part metadata from a STEP file (feature review item 24): each PRODUCT's id
// (often the part number), name and description, read from the file's own
// text, so the info panel can show them for a selected part named as the
// product is. The converter keeps only names; this needs no change to it.
// STEP strings escape a quote as '' and may carry \X2\...\X0\ (UTF-16 hex)
// and \X\hh (ISO 8859-1) encodings, decoded here.
//
// Pure ES module, no DOM.

import { forEachStepSlice } from './step-text.js';

// file: the STEP file's bytes (Uint8Array or ArrayBuffer), or its text (latin1 is fine: the
// encodings are ASCII). Bytes are read in slices cut at a record's end, as js/source-units.js
// reads them: a whole file of over ~512 MB as one string is more than a browser makes, and the
// load failed there before the converter saw the file.
// Returns Map(name -> { id, description }) of the products whose id or
// description says more than the name does.
export function stepProducts(file) {
  const out = new Map();
  if (typeof file === 'string') { scan(file, out); return out; }
  // (a string holding ';' may be cut at a slice's end, and a product named so is missed,
  // which costs only its metadata)
  forEachStepSlice(file instanceof Uint8Array ? file : new Uint8Array(file), (text) => scan(text, out));
  return out;
}
function scan(text, out) {
  const re = /\bPRODUCT\s*\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/gi;
  let m;
  while ((m = re.exec(text))) {
    const id = decodeStepString(m[1]).trim(), name = decodeStepString(m[2]).trim(), description = decodeStepString(m[3]).trim();
    if (!name) continue;
    const useful = (s) => s && s !== name && !/^(none|n\/a|unknown|\$)$/i.test(s);
    if (!useful(id) && !useful(description)) continue;
    if (!out.has(name)) out.set(name, { id: useful(id) ? id : '', description: useful(description) ? description : '' });
  }
}

// a STEP string's escapes undone (a \X2\ run built a code unit at a time: spread into one call,
// 300k of them overflowed the stack)
// The scan reads the file as latin1, so a name written as raw UTF-8 bytes is decoded as UTF-8 here
// when it is valid UTF-8; then, in one pass, the escapes ISO 10303-21 gives: \\ (a backslash),
// \S\c (c in the upper half), \X\hh, \X2\ (UTF-16) and \X4\ (code points) runs. (Raw UTF-8, \S\ and \X4\ came out other than the
// converter's names, and the part's number and description silently did not show)
const UTF8 = new TextDecoder('utf-8', { fatal: true });
export function decodeStepString(s) {
  if (/[\x80-\xff]/.test(s) && !/[^\x00-\xff]/.test(s)) {
    try { s = UTF8.decode(Uint8Array.from(s, (c) => c.charCodeAt(0))); } catch { /* not UTF-8: as read */ }
  }
  const run = (width) => (_, h) => {
    let t = '';
    for (let k = 0; k < h.length; k += width) { const cp = parseInt(h.slice(k, k + width), 16); t += cp <= 0x10ffff ? String.fromCodePoint(cp) : '�'; }
    return t;
  };
  // (one pass, left to right, an escaped backslash taken first: undone one kind at a time,
  // 'A\\S\\B' -- "A\S\B" -- read as "A\ÜB")
  // (\PX\ chooses the page \S\ reads in, ISO 8859-1 .. 9 for A .. I, and is no text itself: it
  // stayed in the name, "\PA\Café", where the converter drops it)
  let page = 'A';
  const upper = (c) => {
    const b = c.charCodeAt(0) + 0x80;
    if (page === 'A') return String.fromCharCode(b);
    try { return new TextDecoder(`iso-8859-${page.charCodeAt(0) - 64}`).decode(Uint8Array.of(b)); } catch { return String.fromCharCode(b); }
  };
  const one = (m, x2, x4, x1, s1, pg) => {
    if (m === '\\\\') return '\\';
    if (pg) { page = pg; return ''; }
    return x2 ? run(4)(m, x2) : x4 ? run(8)(m, x4) : x1 ? String.fromCharCode(parseInt(x1, 16)) : upper(s1);
  };
  // (and, as the converter: a \X2\ / \X4\ run not closed by \X0\ read to its end, a bare \X0\ no
  // text -- both stayed in the name, "A\X0\B" for "AB")
  return s.replace(/''/g, "'")
    .replace(/\\\\|\\X2\\((?:[0-9A-Fa-f]{4})+)(?:\\X0\\|$)|\\X4\\((?:[0-9A-Fa-f]{8})+)(?:\\X0\\|$)|\\X\\([0-9A-Fa-f]{2})|\\S\\(.)|\\P([A-I])\\|\\X0\\/g, (m, ...g) => (m === '\\X0\\' ? '' : one(m, ...g)));
}
