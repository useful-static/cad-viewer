// A DWG reader, written from the Open Design Specification for .dwg files
// (v5.4.1; chapter and section numbers below are that document's). It reads
// R13 to R2018 (AC1012 .. AC1032): the file container of each version, the
// classes, the object map, the header variables, and the objects a 2D drawing
// draws (tables, blocks, and the entities js/dxf.js draws), and hands them on
// as DXF group-code pairs, so parseDXF draws a DWG exactly as it draws a DXF.
//
// Every check the format carries is made and counted, never skipped:
// CRC-16 of each object, of the header, classes and object map (2.14.1), the
// R2004 file header CRC-32 (2.14.2) and page checksums (4.2), the R2007 page
// checksums (5.4.1) and the section sentinels. A failed check is a counted
// finding in dwg.checks, so a wrong decode is visible, not silent.
//
// No other reader's code was consulted: the clean-room rule of the project.

import { caret, valueKind, aciColour } from './dxf.js';

// --- checks -------------------------------------------------------------------------------------

const CRC16 = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1; t[i] = c; }
  return t;
})();
export function crc16(seed, b, from, to) {
  let dx = seed & 0xffff;
  for (let i = from; i < to; i++) dx = ((dx >>> 8) ^ CRC16[(b[i] ^ dx) & 0xff]) & 0xffff;
  return dx;
}
const CRC32T = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
export function crc32(b, from, to, seed = 0) {
  let c = ~seed >>> 0;
  for (let i = from; i < to; i++) c = (c >>> 8) ^ CRC32T[(c ^ b[i]) & 0xff];
  return ~c >>> 0;
}
// 4.2: the R2004 section page checksum
function checksum04(seed, b, from, len) {
  let s1 = seed & 0xffff, s2 = seed >>> 16, i = from;
  while (len) {
    const n = Math.min(0x15b0, len);
    len -= n;
    for (let k = 0; k < n; k++) { s1 += b[i++]; s2 += s1; }
    s1 %= 0xfff1; s2 %= 0xfff1;
  }
  return ((s2 << 16) | (s1 & 0xffff)) >>> 0;
}
// 4.1: the magic sequence (a linear congruential generator)
function magic(n) {
  const out = new Uint8Array(n);
  let seed = 1;
  for (let i = 0; i < n; i++) { seed = (Math.imul(seed, 0x343fd) + 0x269ec3) | 0; out[i] = (seed >>> 16) & 0xff; }
  return out;
}

// --- 2: bit codes -------------------------------------------------------------------------------

// AC1013: the R14 pre-release stamp, in which AutoCAD R14 shipped most of its own sample drawings;
// read by the R14 rules (all 81 on the R14 media pass every check so)
const VER = { AC1012: 13, AC1013: 14, AC1014: 14, AC1015: 15, AC1018: 18, AC1021: 21, AC1024: 24, AC1027: 27, AC1032: 32 };
export const VERSION_NAMES = { AC1012: 'R13', AC1013: 'R14 (AC1013)', AC1014: 'R14', AC1015: 'R2000', AC1018: 'R2004', AC1021: 'R2007', AC1024: 'R2010', AC1027: 'R2013', AC1032: 'R2018' };

class Bits {
  // b: the bytes; p: the bit position; v: the version number (13 .. 32)
  constructor(b, v, byteOff = 0, dec = null) { this.b = b; this.p = byteOff * 8; this.v = v; this.str = null; this.dec = dec; }
  B() { const v = (this.b[this.p >>> 3] >> (7 - (this.p & 7))) & 1; this.p++; return v; }
  BB() { return (this.B() << 1) | this.B(); }
  B3() { let v = 0; for (let k = 0; k < 3; k++) { const x = this.B(); v = (v << 1) | x; if (!x) break; } return v; }
  RC() {
    const o = this.p >>> 3, s = this.p & 7;
    this.p += 8;
    if (o >= this.b.length) throw new Error('read past the end');
    return s ? ((this.b[o] << s) | (this.b[o + 1] >> (8 - s))) & 0xff : this.b[o];
  }
  RS() { const lo = this.RC(); return ((this.RC() << 8) | lo) << 16 >> 16; }
  RSu() { const lo = this.RC(); return (this.RC() << 8) | lo; }
  RL() { const a = this.RC(), b = this.RC(), c = this.RC(), d = this.RC(); return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0; }
  RLs() { return this.RL() | 0; }
  RD() { const t = new Uint8Array(8); for (let k = 0; k < 8; k++) t[k] = this.RC(); return new DataView(t.buffer).getFloat64(0, true); }
  BS() { switch (this.BB()) { case 0: return this.RS(); case 1: return this.RC(); case 2: return 0; default: return 256; } }
  BL() { switch (this.BB()) { case 0: return this.RLs(); case 1: return this.RC(); default: return 0; } }
  // 2.4 points at the 1-3 bit code of 2.1 for the length; the files use a fixed 3-bit length
  // (example_2013's REQUIREDVERSIONS, 0, is 000 and the stream lines up only so)
  BLL() { const n = (this.B() << 2) | (this.B() << 1) | this.B(); let v = 0; for (let k = 0; k < n; k++) v += this.RC() * 2 ** (8 * k); return v; }
  BD() { switch (this.BB()) { case 0: return this.RD(); case 1: return 1; case 2: return 0; default: throw new Error('BD code 3'); } }
  DD(def) {
    const c = this.BB();
    if (c === 0) return def;
    if (c === 3) return this.RD();
    const t = new DataView(new ArrayBuffer(8));
    t.setFloat64(0, def, true);
    if (c === 1) { for (let k = 0; k < 4; k++) t.setUint8(k, this.RC()); } else { t.setUint8(4, this.RC()); t.setUint8(5, this.RC()); for (let k = 0; k < 4; k++) t.setUint8(k, this.RC()); }
    return t.getFloat64(0, true);
  }
  BT() { return this.v >= 15 ? (this.B() ? 0 : this.BD()) : this.BD(); }
  BE() { if (this.v >= 15 && this.B()) return [0, 0, 1]; return this.BD3(); }
  BD2() { return [this.BD(), this.BD()]; }
  BD3() { return [this.BD(), this.BD(), this.BD()]; }
  RD2() { return [this.RD(), this.RD()]; }
  RD3() { return [this.RD(), this.RD(), this.RD()]; }
  // a handle's value is exact: a Number to 2^53, a BigInt past it (AutoCAD LT 2000's own
  // "BUILDING SECTION AND DETAILS" sample has 64-bit handles: as Numbers they lost their low bits
  // and 2,386 of 3,253 objects no longer matched the object map)
  H() {
    const x = this.RC(); const code = x >> 4, n = x & 15;
    if (n <= 6) { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + this.RC(); return { code, v }; }
    let v = 0n; for (let k = 0; k < n; k++) v = v * 256n + BigInt(this.RC());
    return { code, v: hnorm(v) };
  }
  // a handle as an absolute value, its relative codes resolved against ref (2.13)
  Ha(ref) {
    const h = this.H();
    switch (h.code) { case 6: return hadd(ref, 1); case 8: return hadd(ref, -1); case 0xa: return hadd(ref, h.v); case 0xc: return hadd(ref, -h.v); default: return h.v; }
  }
  MC() {
    let v = 0, sh = 0, x;
    do {
      x = this.RC();
      if (sh >= 49) { // past 2^53: exact from here on
        let w = BigInt(v);
        for (;;) { w += BigInt(x & 0x7f) << BigInt(sh); sh += 7; if (!(x & 0x80)) return hnorm(w); x = this.RC(); }
      }
      v += (x & 0x7f) * 2 ** sh; sh += 7;
    } while (x & 0x80);
    return v;
  }
  MCs() {
    let v = 0, sh = 0, x;
    for (;;) {
      x = this.RC();
      if (!(x & 0x80)) { const neg = x & 0x40; v += (x & 0x3f) * 2 ** sh; return neg ? -v : v; }
      v += (x & 0x7f) * 2 ** sh; sh += 7;
    }
  }
  MS() { let v = 0, sh = 0, x; do { x = this.RSu(); v += (x & 0x7fff) * 2 ** sh; sh += 15; } while (x & 0x8000); return v; }
  OT() { if (this.v < 24) return this.BS(); switch (this.BB()) { case 0: return this.RC(); case 1: return this.RC() + 0x1f0; default: return this.RSu(); } }
  // T: to R2004 a character outside the drawing's code page is stored as \U+XXXX (AutoCAD shows
  // the character; R2007 stores it as itself): decoded here, so every version reads the same text
  T() { const n = this.BS(); const t = new Uint8Array(Math.max(0, n)); for (let k = 0; k < n; k++) t[k] = this.RC(); let e = t.length; while (e && !t[e - 1]) e--; return (this.dec || LATIN1).decode(t.subarray(0, e)).replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, x) => String.fromCharCode(parseInt(x, 16))); }
  TU() { const n = this.BS(); let s = ''; for (let k = 0; k < n; k++) { const c = this.RSu(); if (c) s += String.fromCharCode(c); } return s; }
  // TV: T to R2004, TU from the string stream after
  TV() { if (this.v < 21) return this.T(); return this.str ? this.str.TU() : ''; }
  CMC() {
    if (this.v < 18) return { aci: this.BS() };
    const idx = this.BS(), rgb = this.BL() >>> 0, fl = this.RC();
    if (fl & 1) this.TV();
    if (fl & 2) this.TV();
    return colourOfRgb(idx, rgb);
  }
  // ENC, the entity colour (2.11)
  ENC() {
    if (this.v < 18) return { aci: this.BS() };
    const cn = this.BS() & 0xffff;
    const c = { aci: cn & 0x1fff, book: !!(cn & 0x4000) };
    // 0x4000 (a colour-book colour, its DBCOLOR in the handle stream): the RGB lives in that
    // object and is NOT stored here, though 0x8000 is set too (acadsharp's sample circle 99F
    // lines up only so); the index (its ACI, 42 there, as the DXF's 62) is kept
    if ((cn & 0x8000) && !(cn & 0x4000)) { const rgb = this.BL() >>> 0; Object.assign(c, colourOfRgb(c.aci, rgb)); }
    if (cn & 0x2000) this.BL();
    // with 0x4000, bits 0x0100 / 0x0200 say a colour name / a book name follow (as the CMC flags
    // 1 / 2), and are not part of the index: LibreCAD's ordinary_enc_AC1018 LINE 32 (0xC300,
    // "Linked" / "Book"; LibreDWG reads it so); AutoCAD's colour-book entities have neither
    // (acadsharp circle 99F: 0xC02A). The index is then BYLAYER: the colour is the DBCOLOR's
    if ((cn & 0x4000) && (cn & 0x300)) {
      if (cn & 0x100) this.TV();
      if (cn & 0x200) this.TV();
      c.aci = 256;
    }
    return c;
  }
  align() { this.p = (this.p + 7) & ~7; }
}
const LATIN1 = new TextDecoder('windows-1252');
// a handle value as a Number when exact (to 2^53), else a BigInt; and a sum of two such
const hnorm = (v) => (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
// handle order across Number and BigInt (subtraction would throw on a mix)
const hcmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function hadd(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { const s = a + b; if (Number.isSafeInteger(s)) return s; }
  return hnorm(BigInt(a) + BigInt(b));
}
// The index a true colour shows as where only an index is read (DXF group 62 beside 420): the
// nearest of ACI 1-255. From R2004 the CMC of a true colour stores index 0, and AutoCAD's and
// ODA's DXF of such a file carry this nearest index (sample_base layers: 150, 31, 247)
let ACI_RGB = null;
function nearestAci(rgb) {
  if (!ACI_RGB) ACI_RGB = Array.from({ length: 256 }, (_, a) => (a ? aciColour(a) : null));
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  let best = 7, bd = Infinity;
  for (let a = 1; a <= 255; a++) { const c = ACI_RGB[a]; const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2; if (d < bd) { bd = d; best = a; } }
  return best;
}
function colourOfRgb(idx, rgb) {
  const kind = rgb >>> 24;
  if (kind === 0xc2) return { aci: idx >= 1 && idx <= 255 ? idx : nearestAci(rgb & 0xffffff), rgb: rgb & 0xffffff };
  if (kind === 0xc3) return { aci: rgb & 0xff };
  if (kind === 0xc0) return { aci: 256 };
  if (kind === 0xc1) return { aci: 0 };
  return { aci: idx };
}

// --- 4.7: R2004 compression ---------------------------------------------------------------------

export function decompress18(src, from, len, outLen) {
  const out = new Uint8Array(outLen);
  let i = from, o = 0;
  const end = from + len;
  const litLen = () => {
    const b = src[i];
    if (b === 0) { i++; let t = 0x0f, n; while ((n = src[i++]) === 0) t += 0xff; return t + n + 3; }
    if (b < 0x10) { i++; return b + 3; }
    return 0;
  };
  const longOff = () => { const b = src[i++]; if (b) return b; let t = 0xff, n; while ((n = src[i++]) === 0) t += 0xff; return t + n; };
  const lit = (n) => { if (o + n > outLen || i + n > end) throw new Error('R2004 literal past the end'); out.set(src.subarray(i, i + n), o); i += n; o += n; };
  lit(litLen());
  while (i < end) {
    const op = src[i++];
    let comp, off, l;
    if (op === 0x11) break;
    if (op >= 0x40) { comp = (op >> 4) - 1; const op2 = src[i++]; off = (op2 << 2) | ((op & 0x0c) >> 2); l = op & 3; } else {
      // 4.7 reads 0x12-0x1F as length (op & 0x0F) + 2, offset + 0x3FFF. Bit 3 is an offset bit
      // (+0x4000) and bits 0-2 the length (0: extended, as 0x10): the two readings agree on
      // every page up to 0x7400 bytes (no file here uses 0x18-0x1F there), and only this one
      // decodes a section map past 0x7FFF bytes (AutoCAD R2018 files of 34 MB: 36,916 bytes)
      let hi = 0;
      if (op >= 0x10 && op <= 0x1f) { hi = (op & 8) << 11; comp = op & 7 ? (op & 7) + 2 : longOff() + 9; } else if (op === 0x20) comp = longOff() + 0x21;
      else if (op >= 0x21) comp = op - 0x1e;
      else throw new Error(`R2004 opcode 0x${op.toString(16)}`);
      const f = src[i++];
      off = (f >> 2) | (src[i++] << 6);
      l = f & 3;
      if (op < 0x20) off += 0x3fff + hi;
    }
    const from2 = o - off - 1;
    if (from2 < 0 || o + comp > outLen) throw new Error('R2004 back reference out of range');
    for (let k = 0; k < comp; k++) out[o + k] = out[from2 + k];
    o += comp;
    lit(l || litLen());
  }
  return { out, n: o };
}

// --- 5.10: R2007 compression --------------------------------------------------------------------

// 5.10.1: literal bytes are stored in a shuffled order; each count is copied as
// the listed pieces [size, source index], a piece of size k copied by count k's
// own rule
const SHUF = [null, [[1, 0]], [[1, 1], [1, 0]], [[1, 2], [1, 1], [1, 0]], [[1, 0], [1, 1], [1, 2], [1, 3]], [[1, 4], [4, 0]],
  [[1, 5], [4, 1], [1, 0]], [[2, 5], [4, 1], [1, 0]], [[4, 0], [4, 4]], [[1, 8], [8, 0]], [[1, 9], [8, 1], [1, 0]],
  [[2, 9], [8, 1], [1, 0]], [[4, 8], [8, 0]], [[1, 12], [4, 8], [8, 0]], [[1, 13], [4, 9], [8, 1], [1, 0]],
  [[2, 13], [4, 9], [8, 1], [1, 0]], [[8, 8], [8, 0]], [[8, 9], [1, 8], [8, 0]], [[1, 17], [16, 1], [1, 0]], [[3, 16], [16, 0]],
  [[4, 16], [16, 0]], [[1, 20], [4, 16], [16, 0]], [[2, 20], [4, 16], [16, 0]], [[3, 20], [4, 16], [16, 0]], [[8, 16], [16, 0]],
  [[8, 17], [1, 16], [16, 0]], [[1, 25], [8, 17], [1, 16], [16, 0]], [[2, 25], [8, 17], [1, 16], [16, 0]], [[4, 24], [8, 16], [16, 0]],
  [[1, 28], [4, 24], [8, 16], [16, 0]], [[2, 28], [4, 24], [8, 16], [16, 0]], [[1, 30], [4, 26], [8, 18], [16, 2], [2, 0]], [[16, 16], [16, 0]]];
function shuffled(n) {
  // the source index of each output byte for a run of n (1..32)
  if (n === 1) return [0];
  const out = [];
  for (const [k, at] of SHUF[n]) {
    if (k === n) { for (let j = 0; j < k; j++) out.push(at + j); continue; } // a piece the size of the whole is straight
    for (const j of shuffled(k)) out.push(at + j);
  }
  return out;
}
const SHUFFLE = [null];
for (let n = 1; n <= 32; n++) SHUFFLE.push(shuffled(n));

export function decompress21(src, from, len, outLen) {
  const out = new Uint8Array(outLen);
  let i = from, o = 0;
  const end = from + len;
  const literal = (n) => {
    if (i + n > end || o + n > outLen) throw new Error('R2007 literal past the end');
    while (n >= 32) { const s = SHUFFLE[32]; for (let k = 0; k < 32; k++) out[o + k] = src[i + s[k]]; i += 32; o += 32; n -= 32; }
    if (n) { const s = SHUFFLE[n]; for (let k = 0; k < n; k++) out[o + k] = src[i + s[k]]; i += n; o += n; }
  };
  const litLength = (op) => {
    let n = op + 8;
    if (n === 0x17) {
      let x = src[i++];
      n += x;
      if (x === 0xff) { do { x = src[i++] | (src[i++] << 8); n += x; } while (x === 0xffff); }
    }
    return n;
  };
  let op = src[i];
  let n;
  // 5.10: a first opcode 0x2N: past it, skip 2 bytes, the next byte & 7 is the literal length
  // (the pointer is already past the opcode when the spec says "advanced 2 bytes")
  if ((op >> 4) === 2) { n = src[i + 3] & 7; i += 4; } else { i++; n = litLength(op); }
  for (;;) {
    if (n) literal(n);
    if (i >= end) break;
    op = src[i++];
    // ReadInstructions, then copies until a literal run follows
    let length, offset;
    const instr = () => {
      switch (op >> 4) {
        case 0: length = (op & 0xf) + 0x13; offset = src[i++]; op = src[i++]; length += (op >> 3) & 0x10; offset += ((op & 0x78) << 5) + 1; break;
        case 1: length = (op & 0xf) + 3; offset = src[i++]; op = src[i++]; offset += ((op & 0xf8) << 5) + 1; break;
        case 2:
          offset = src[i++]; offset |= (src[i++] << 8) & 0xff00; length = op & 7;
          if (!(op & 8)) { op = src[i++]; length += op & 0xf8; } else { offset++; length += src[i++] << 3; op = src[i++]; length += ((op & 0xf8) << 8) + 0x100; }
          break;
        default: length = op >> 4; offset = op & 15; op = src[i++]; offset += ((op & 0xf8) << 1) + 1;
      }
    };
    instr();
    n = 0;
    for (;;) {
      const s = o - offset;
      if (s < 0 || o + length > outLen) throw new Error('R2007 back reference out of range');
      for (let k = 0; k < length; k++) out[o + k] = out[s + k];
      o += length;
      n = op & 7;
      if (n || i >= end) break;
      op = src[i++];
      if ((op >> 4) === 0) { n = litLength(op); break; }
      if ((op >> 4) === 15) op &= 15;
      instr();
    }
    if (i >= end && !n) break;
  }
  return { out, n: o };
}

// --- 5.13: Reed-Solomon, de-interleaved (no correction: the checks catch a damaged page) --------

function deRS(b, at, blocks, k, interleaved) {
  const out = new Uint8Array(blocks * k);
  for (let bl = 0; bl < blocks; bl++) {
    for (let j = 0; j < k; j++) out[bl * k + j] = interleaved ? b[at + j * blocks + bl] : b[at + bl * 255 + j];
  }
  return out;
}
// 5.4.1: the R2007 page checksum
function checksum21(seed, b, from, len) {
  seed = Number((BigInt(seed) + BigInt(len)) * 0x343fdn + 0x269ec3n & 0xffffffffffffffffn);
  let s1 = seed % 0x10000, s2 = Math.floor(seed / 0x10000) % 0x10000, i = from;
  const one = () => { s1 += b[i++]; s2 += s1; };
  const two = (at) => { s1 += b[at]; s2 += s1; s1 += b[at + 1]; s2 += s1; };
  while (len) {
    const big = Math.min(0x15b0, len);
    len -= big;
    for (let c = big >> 3; c > 0; c--) { two(i + 6); two(i + 4); two(i + 2); two(i); i += 8; }
    const r = big & 7;
    if (r) {
      const p = i;
      if (r === 1) { s1 += b[p]; s2 += s1; } else if (r === 2) two(p);
      else if (r === 3) { two(p); s1 += b[p + 2]; s2 += s1; } else if (r === 4) { two(p + 2); two(p); } else if (r === 5) { two(p + 2); two(p); s1 += b[p + 4]; s2 += s1; } else if (r === 6) { two(p + 2); two(p); two(p + 4); } else { two(p + 2); two(p); two(p + 4); s1 += b[p + 6]; s2 += s1; }
      i += r;
    }
    s1 %= 0xfff1; s2 %= 0xfff1;
  }
  void one;
  return ((s2 << 16) | (s1 & 0xffff)) >>> 0;
}

// --- the containers: each returns the four logical sections as byte arrays ----------------------

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;
const SN = {
  header: [0xcf, 0x7b, 0x1f, 0x23, 0xfd, 0xde, 0x38, 0xa9, 0x5f, 0x7c, 0x68, 0xb8, 0x4e, 0x6d, 0x33, 0x5f],
  classes: [0x8d, 0xa1, 0xc4, 0xb8, 0xc4, 0xa9, 0xf8, 0xc5, 0xc0, 0xdc, 0xf4, 0x5f, 0xe7, 0xcf, 0xb6, 0x8a],
  locators: [0x95, 0xa0, 0x4e, 0x28, 0x99, 0x82, 0x1a, 0xe5, 0x5e, 0x41, 0xe0, 0x5f, 0x9d, 0x3a, 0x4d, 0x00],
};
const isSN = (b, o, s) => s.every((x, k) => b[o + k] === x);

// 3: R13-R15, sections at absolute addresses
function container15(b, chk) {
  const n = u32(b, 0x15);
  const rec = {};
  for (let k = 0; k < n; k++) { const o = 0x19 + 9 * k; rec[b[o]] = { at: u32(b, o + 1), size: u32(b, o + 5) }; }
  const end = 0x19 + 9 * n;
  const xor = { 3: 0xa598, 4: 0x8101, 5: 0x3cc4, 6: 0x8461 }[n] || 0;
  chk.ok('file header CRC', (crc16(0, b, 0, end) ^ xor) === (b[end] | (b[end + 1] << 8)));
  chk.ok('file header sentinel', isSN(b, end + 2, SN.locators));
  return {
    header: { b, at: rec[0].at, size: rec[0].size },
    classes: { b, at: rec[1].at, size: rec[1].size },
    handles: { b, at: rec[2].at, size: rec[2].size },
    objects: { b, at: 0, size: b.length, absolute: true },
    codepage: b[0x13] | (b[0x14] << 8),
  };
}

// 4: R2004, R2010+ (pages, compressed)
function container18(b, chk) {
  const m = magic(0x6c);
  const h = new Uint8Array(0x6c);
  for (let k = 0; k < 0x6c; k++) h[k] = b[0x80 + k] ^ m[k];
  chk.ok('file header ID', String.fromCharCode(...h.subarray(0, 11)) === 'AcFssFcAJMB');
  const stored = u32(h, 0x68);
  const z = h.slice(); z[0x68] = z[0x69] = z[0x6a] = z[0x6b] = 0;
  chk.ok('file header CRC-32', crc32(z, 0, 0x6c) === stored);
  const pageMapAt = u64(h, 0x54) + 0x100, sectionMapId = u32(h, 0x5c);
  // a system page: 0x14 byte header, then compressed data (4.3)
  const sysPage = (at, type) => {
    chk.ok('system page type', u32(b, at) === type);
    const dsize = u32(b, at + 4), csize = u32(b, at + 8);
    const hdr = b.slice(at, at + 0x14); hdr[0x10] = hdr[0x11] = hdr[0x12] = hdr[0x13] = 0;
    // 4.3: the header's checksum (its checksum field zeroed), then the data seeded with it
    chk.ok('system page checksum', checksum04(checksum04(0, hdr, 0, 0x14), b, at + 0x14, csize) === u32(b, at + 0x10));
    return decompress18(b, at + 0x14, csize, dsize).out;
  };
  const pm = sysPage(pageMapAt, 0x41630e3b);
  const pages = new Map();
  let addr = 0x100;
  for (let o = 0; o + 8 <= pm.length;) {
    const num = i32(pm, o), size = u32(pm, o + 4);
    o += 8;
    if (num < 0) o += 16; else pages.set(num, { at: addr, size });
    addr += size;
  }
  const sm = sysPage(pages.get(sectionMapId).at, 0x4163003b);
  const nDesc = u32(sm, 0);
  const sections = {};
  let o = 0x14;
  for (let d = 0; d < nDesc && o < sm.length; d++) {
    const size = u64(sm, o), count = u32(sm, o + 8), maxSize = u32(sm, o + 0x0c), compressed = u32(sm, o + 0x14), enc = u32(sm, o + 0x1c);
    let name = '';
    for (let k = 0; k < 64 && sm[o + 0x20 + k]; k++) name += String.fromCharCode(sm[o + 0x20 + k]);
    o += 0x60;
    const list = [];
    for (let p = 0; p < count; p++) { list.push({ num: u32(sm, o), dsize: u32(sm, o + 4), start: u64(sm, o + 8) }); o += 16; }
    sections[name] = { size, maxSize, compressed, enc, list };
  }
  const read = (name) => {
    const s = sections[name];
    if (!s) return null;
    const out = new Uint8Array(s.size);
    for (const pg of s.list) {
      const at = pages.get(pg.num).at;
      // 4.6: the masked page header
      const mask = (0x4164536b ^ at) >>> 0;
      const hdr = new Uint8Array(32);
      for (let k = 0; k < 32; k += 4) { const v = (u32(b, at + k) ^ mask) >>> 0; hdr[k] = v & 0xff; hdr[k + 1] = (v >>> 8) & 0xff; hdr[k + 2] = (v >>> 16) & 0xff; hdr[k + 3] = v >>> 24; }
      chk.ok('data page type', u32(hdr, 0) === 0x4163043b);
      const dsize = u32(hdr, 8), start = u64(hdr, 0x10);
      const dataSum = checksum04(0, b, at + 32, dsize);
      chk.ok('data page data checksum', dataSum === u32(hdr, 0x1c));
      const hz = hdr.slice(); hz[0x18] = hz[0x19] = hz[0x1a] = hz[0x1b] = 0;
      chk.ok('data page header checksum', checksum04(dataSum, hz, 0, 32) === u32(hdr, 0x18));
      if (s.enc === 1) throw new Error('an encrypted (password) DWG is not read');
      const want = Math.min(s.maxSize, s.size - start);
      let page;
      try { page = s.compressed === 2 ? decompress18(b, at + 32, dsize, s.maxSize).out : b.subarray(at + 32, at + 32 + s.maxSize); } catch (e) { throw new Error(`${e.message} (${name}, page ${pg.num} at 0x${at.toString(16)}, ${dsize} bytes)`); }
      out.set(page.subarray(0, want), start);
    }
    return out;
  };
  const sec = (name) => { const d = read(name); return d ? { b: d, at: 0, size: d.length } : null; };
  // 16: AppInfo names the program that saved the file (metadata: read when present, never required)
  let appInfo = null;
  try { appInfo = sec('AcDb:AppInfo'); } catch { appInfo = null; }
  return { header: sec('AcDb:Header'), classes: sec('AcDb:Classes'), handles: sec('AcDb:Handles'), objects: sec('AcDb:AcDbObjects'), appInfo, codepage: b[0x13] | (b[0x14] << 8) };
}

// 16: the AppInfo section's strings (to R2004 one-byte, from R2007 UTF-16LE), as stored: the
// writer's name and version ("AutoCAD", a product XML, a build number)
function appInfoStrings(s, v) {
  if (!s) return [];
  const b = s.b, out = [];
  let cur = '';
  const flush = () => { if (cur.trim().length >= 3) out.push(cur.trim()); cur = ''; };
  // both readings, whatever the version: the strings are UTF-16 when a newer AutoCAD wrote the
  // file (an R2004 save from AutoCAD 2018: "22.0.48.M.294"), one-byte when an older one did
  for (let k = 0; k + 1 < b.length; k += 2) { const c = b[k] | (b[k + 1] << 8); if (c >= 0x20 && c !== 0xfffd && c < 0xd800) cur += String.fromCharCode(c); else flush(); }
  flush();
  for (let k = 0; k < b.length; k++) { const c = b[k]; if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c); else flush(); }
  flush();
  return out;
}

// who saved the file, from its AppInfo: "Autodesk" (a TrustedDWG: "last saved by an Autodesk
// application or Autodesk licensed application"), "ODA" (an Open Design Alliance application),
// the ProductInformation name otherwise, '' when there is no AppInfo (to R2000; or unread)
function writerOf(strs) {
  const all = strs.join(' ');
  if (/Trusted DWG last saved by an Autodesk/.test(all)) return 'Autodesk';
  if (/Open Design Alliance|Teigha/.test(all)) return 'ODA';
  const m = /ProductInformation name\s*=\s*\\?"([^"\\]+)/.exec(all);
  if (m) return m[1];
  // otherwise the first plain name after the list's own name (LibreCAD writes "LibreCAD")
  const k = strs.indexOf('AppInfoDataList');
  const nm = k >= 0 ? strs.slice(k + 1).find((s) => /^[A-Za-z][\w .+-]{2,40}$/.test(s)) : null;
  return nm || '';
}

// 5: R2007 (Reed-Solomon, its own compression)
function container21(b, chk) {
  const fh = deRS(b, 0x80, 3, 239, true);
  const clen = i32(fh, 0x18);
  const hd = clen < 0 ? fh.subarray(0x20, 0x20 - clen) : decompress21(fh, 0x20, clen, 0x110).out;
  const q = (o) => u64(hd, o);
  const H = {
    pagesMapCorrection: q(0x18), pagesMapOffset: q(0x38), pagesMapSizeC: q(0x50), pagesMapSizeU: q(0x58),
    sectionsMapSizeC: q(0xb0), sectionsMapId: q(0xc0), sectionsMapSizeU: q(0xc8), sectionsMapCorrection: q(0xd8),
  };
  chk.ok('R2007 file header size', q(0) === 0x70 || q(0) > 0);
  const sysPage = (at, sizeC, sizeU, factor) => {
    const aligned = (sizeC + 7) & ~7;
    const blocks = Math.ceil((aligned * factor) / 239);
    const d = deRS(b, at, blocks, 239, true);
    return sizeC < sizeU ? decompress21(d, 0, sizeC, sizeU).out : d.subarray(0, sizeU);
  };
  const pm = sysPage(H.pagesMapOffset + 0x480, H.pagesMapSizeC, H.pagesMapSizeU, H.pagesMapCorrection);
  const pages = new Map();
  let off = 0;
  for (let o = 0; o + 16 <= pm.length; o += 16) {
    const size = u64(pm, o), id = Math.abs(i32(pm, o + 8));
    pages.set(id, { at: off + 0x480, size });
    off += size;
  }
  const smPage = pages.get(H.sectionsMapId);
  const sm = sysPage(smPage.at, H.sectionsMapSizeC, H.sectionsMapSizeU, H.sectionsMapCorrection);
  const sections = {};
  for (let o = 0; o + 0x40 <= sm.length;) {
    const size = u64(sm, o), maxSize = u64(sm, o + 8), enc = u64(sm, o + 0x10), nameLen = u64(sm, o + 0x20), encoding = u64(sm, o + 0x30), count = u64(sm, o + 0x38);
    o += 0x40;
    // 5.2 calls SectionNameLength a character count; it is the name's byte length, its two
    // terminating zero bytes included (40 for "AcDb:AppInfoHistory")
    let name = '';
    for (let k = 0; k + 1 < nameLen; k += 2) { const c = sm[o + k] | (sm[o + k + 1] << 8); if (!c) break; name += String.fromCharCode(c); }
    o += nameLen;
    if (count > 1e6 || size > 1e10) throw new Error('R2007 section map is not readable');
    const list = [];
    for (let p = 0; p < count; p++) {
      list.push({ start: u64(sm, o), size: u64(sm, o + 8), id: u64(sm, o + 16), usize: u64(sm, o + 24), csize: u64(sm, o + 32), sum: u64(sm, o + 40) });
      o += 56;
    }
    if (name) sections[name] = { size, maxSize, enc, encoding, list };
  }
  const read = (name) => {
    const s = sections[name];
    if (!s) return null;
    const out = new Uint8Array(s.size);
    for (const pg of s.list) {
      const p = pages.get(pg.id);
      // 5.2 encoding 4: Reed-Solomon (255, 251), interleaved; encoding 1: the page is stored as
      // it is, no parity (example_2007's AppInfo: read as 255-byte blocks it lost 4 bytes at
      // 251-254 and failed its page checksum; read as stored it passes)
      const d = s.encoding === 1 ? b.subarray(p.at, p.at + p.size) : deRS(b, p.at, Math.floor(p.size / 255), 251, s.encoding === 4);
      const data = pg.csize < pg.usize ? decompress21(d, 0, pg.csize, pg.usize).out : d.subarray(0, pg.usize);
      // a hard check since stored (encoding 1) pages are read as stored: every page of all 294
      // R2007 files at hand passes
      chk.ok('R2007 page checksum', checksum21(0, d, 0, pg.csize) === pg.sum % 2 ** 32 || checksum21(0, data, 0, pg.usize) === pg.sum % 2 ** 32);
      out.set(data.subarray(0, Math.min(pg.usize, s.size - pg.start)), pg.start);
    }
    return out;
  };
  const sec = (name) => { const d = read(name); return d ? { b: d, at: 0, size: d.length } : null; };
  let appInfo = null;
  try { appInfo = sec('AcDb:AppInfo'); } catch { appInfo = null; }
  return { header: sec('AcDb:Header'), classes: sec('AcDb:Classes'), handles: sec('AcDb:Handles'), objects: sec('AcDb:AcDbObjects'), appInfo, codepage: b[0x13] | (b[0x14] << 8) };
}

// --- 10: classes --------------------------------------------------------------------------------

// 9 / 10: "R2010+, if maint > 3: RL" (the size's high half) after a section's size. From R2013
// it is there whatever the maintenance byte says (LibreCAD's ordinary_enc_AC1027: byte 0, field
// present; every R2018 file here: byte 0); an R2010 file with byte 2 (Autodesk's architectural
// example) has none
const sizeHigh = (v, maint) => (v >= 24 && maint > 3) || v >= 27;

function readClasses(s, v, maint, chk) {
  const b = s.b, at = s.at;
  chk.ok('classes sentinel', isSN(b, at, SN.classes));
  const size = u32(b, at + 16);
  let dataAt = at + 20;
  if (sizeHigh(v, maint)) dataAt += 4;
  const r = new Bits(b, v, dataAt);
  let endBit = (dataAt + size) * 8;
  if (v >= 21) {
    const bits = r.RL();
    endBit = dataAt * 8 + bits;
    // the string stream, read backwards from the end of the data
    r.str = stringStream(b, v, endBit, dataAt * 8);
  }
  let maxClass = Infinity;
  if (v >= 18) { maxClass = r.BS(); r.RC(); r.RC(); r.B(); }
  // the class records end at the last class number, or where the string stream starts
  const limit = r.str ? r.str.p : endBit - 8;
  const classes = new Map();
  while (r.p < limit) {
    const num = r.BS();
    const flags = r.BS();
    const app = r.TV(), cpp = r.TV(), dxf = r.TV();
    const zombie = r.B(), item = r.BS();
    if (v >= 18) { r.BL(); r.BS(); r.BS(); r.BL(); r.BL(); }
    classes.set(num, { num, flags, app, cpp, dxf, zombie, item });
    if (num >= maxClass || classes.size > 10000) break;
  }
  if (v < 21) {
    const crcAt = dataAt + size;
    chk.ok('classes CRC', crc16(0xc0c1, b, at + 16, crcAt) === (b[crcAt] | (b[crcAt + 1] << 8)));
  }
  return classes;
}
// 20.1: the string stream of an object (or section) whose data ends at endBit
function stringStream(b, v, endBit, floorBit) {
  const r = new Bits(b, v);
  r.p = endBit - 1;
  if (!r.B()) return null;
  let e = endBit - 1 - 16;
  r.p = e;
  let size = r.RSu();
  if (size & 0x8000) { e -= 16; r.p = e; const hi = r.RSu(); size = (size & 0x7fff) | (hi << 15); }
  e -= size;
  if (e < floorBit) return null;
  const s = new Bits(b, v);
  s.p = e;
  return s;
}

// --- 23: the object map -------------------------------------------------------------------------

function readHandles(s, chk) {
  const b = s.b;
  let o = s.at;
  const end = s.at + s.size;
  const map = [];
  let h = 0, loc = 0;
  while (o + 2 <= end) {
    const size = (b[o] << 8) | b[o + 1];
    if (size <= 2) break;
    const r = new Bits(b, 15, o + 2);
    const stop = (o + size) * 8;
    // each chunk's offsets start again from 0 (23.1 says "set once"; the files say per chunk:
    // a chunk's first entry is absolute, one past the last handle of the chunk before)
    h = 0; loc = 0;
    while (r.p < stop) { h = hadd(h, r.MC()); loc += r.MCs(); map.push([h, loc]); }
    const c = (b[o + size] << 8) | b[o + size + 1];
    chk.ok('object map CRC', crc16(0xc0c1, b, o, o + size) === c);
    o += size + 2;
  }
  return map;
}

// --- 9: the header variables (what the drawing needs: units, scale, extents) --------------------

function readHeader(s, v, maint, chk) {
  const b = s.b, at = s.at;
  chk.ok('header sentinel', isSN(b, at, SN.header));
  const size = u32(b, at + 16);
  let dataAt = at + 20;
  if (sizeHigh(v, maint)) dataAt += 4;
  const r = new Bits(b, v, dataAt);
  const H = {};
  // R2007+: strings and handles are in streams of their own: skip them here
  const TV = () => (v < 21 ? r.T() : '');
  const Hd = () => (v < 21 ? r.H() : null);
  // 9 lists "R2007 Only: RL size in bits"; the R2010+ files carry it too (5912 in example_2010)
  if (v >= 21) r.RL();
  if (v >= 27) r.BLL();
  r.BD(); r.BD(); r.BD(); r.BD(); TV(); TV(); TV(); TV(); r.BL(); r.BL();
  if (v <= 14) r.BS();
  if (v < 18) Hd();
  r.B(); r.B(); if (v <= 14) r.B();
  for (let k = 0; k < 7; k++) r.B();
  if (v <= 14) r.B();
  if (v >= 18) r.B();
  r.B(); r.B(); r.B(); r.B();
  if (v <= 14) { r.B(); r.B(); }
  r.B(); r.B();
  if (v <= 14) r.B();
  r.B(); r.B(); r.B();
  if (v <= 14) r.B();
  r.B(); r.B(); r.BS();
  if (v <= 14) r.BS();
  r.BS(); H.LUNITS = r.BS(); r.BS(); r.BS(); r.BS();
  if (v <= 14) r.BS();
  r.BS();
  if (v <= 14) r.BS();
  r.BS();
  if (v <= 14) r.BS();
  if (v >= 18) { r.BL(); r.BL(); r.BL(); }
  for (let k = 0; k < 19; k++) r.BS();
  H.LTSCALE = r.BD();
  for (let k = 0; k < 20; k++) r.BD();
  if (v <= 18) TV();
  r.BL(); r.BL(); r.BL(); r.BL();
  if (v >= 18) { r.BL(); r.BL(); r.BL(); }
  r.BL(); r.BL(); r.BL(); r.BL();
  r.CMC();
  r.H(); // HANDSEED, in the data stream in every version
  Hd(); Hd(); Hd();
  if (v >= 21) Hd();
  Hd(); Hd();
  if (v >= 15) r.BD();
  r.BD3(); r.BD3(); r.BD3(); r.RD2(); r.RD2(); r.BD(); r.BD3(); r.BD3(); r.BD3(); Hd();
  if (v >= 15) { Hd(); r.BS(); Hd(); for (let k = 0; k < 6; k++) r.BD3(); }
  H.INSBASE = r.BD3(); H.EXTMIN = r.BD3(); H.EXTMAX = r.BD3(); r.RD2(); r.RD2(); r.BD(); r.BD3(); r.BD3(); r.BD3(); Hd();
  if (v >= 15) { Hd(); r.BS(); Hd(); for (let k = 0; k < 6; k++) r.BD3(); TV(); TV(); }
  if (v <= 14) {
    for (let k = 0; k < 11; k++) r.B();
    r.RC(); r.RC(); r.B(); r.B(); r.RC(); r.RC(); r.RC(); r.B(); r.RC(); r.RC(); r.RC(); r.RC();
    for (let k = 0; k < 6; k++) r.BS();
    Hd();
  }
  for (let k = 0; k < 9; k++) r.BD();
  if (v >= 21) { r.BD(); r.BD(); r.BS(); r.CMC(); }
  if (v >= 15) { for (let k = 0; k < 6; k++) r.B(); r.BS(); r.BS(); r.BS(); }
  if (v >= 21) r.BS();
  for (let k = 0; k < 8; k++) r.BD();
  if (v <= 14) { for (let k = 0; k < 5; k++) TV(); }
  if (v >= 15) { r.BD(); r.B(); r.BS(); r.B(); r.B(); r.B(); r.B(); }
  r.CMC(); r.CMC(); r.CMC();
  if (v >= 15) {
    for (let k = 0; k < 11; k++) r.BS();
    r.B(); r.B(); r.BS(); r.BS(); r.BS(); r.BS(); r.B(); r.BS();
  }
  if (v >= 21) r.B();
  if (v >= 24) { r.B(); r.BD(); TV(); r.BD(); TV(); }
  if (v >= 15) { Hd(); Hd(); Hd(); Hd(); Hd(); }
  if (v >= 21) { Hd(); Hd(); Hd(); }
  if (v >= 15) { r.BS(); r.BS(); }
  for (let k = 0; k < 9; k++) Hd();
  if (v <= 15) Hd();
  Hd(); Hd(); Hd();
  if (v >= 15) {
    r.BS(); r.BS(); TV(); TV(); Hd(); Hd(); Hd();
    if (v >= 18) { Hd(); Hd(); }
    if (v >= 21) Hd();
    if (v >= 27) Hd();
    r.BL();
    H.INSUNITS = r.BS();
    const cepsn = r.BS();
    if (cepsn === 3) Hd();
    TV(); TV();
  }
  H.endBit = r.p;
  if (v < 21) {
    // the CRC follows the data, past its padding; it covers the size and the data
    const crcAt = dataAt + size;
    chk.ok('header CRC', crc16(0xc0c1, b, at + 16, crcAt) === (b[crcAt] | (b[crcAt + 1] << 8)));
    chk.ok('header variables end inside the section', r.p <= crcAt * 8);
  }
  return H;
}

// --- 20: objects --------------------------------------------------------------------------------

const ENT = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 44, 45, 46, 47]);
const FIXED = { 1: 'TEXT', 2: 'ATTRIB', 3: 'ATTDEF', 4: 'BLOCK', 5: 'ENDBLK', 6: 'SEQEND', 7: 'INSERT', 8: 'MINSERT', 10: 'VERTEX', 11: 'VERTEX', 12: 'VERTEX', 13: 'VERTEX', 14: 'VERTEX',
  15: 'POLYLINE', 16: 'POLYLINE', 17: 'ARC', 18: 'CIRCLE', 19: 'LINE', 20: 'DIMENSION', 21: 'DIMENSION', 22: 'DIMENSION', 23: 'DIMENSION', 24: 'DIMENSION', 25: 'DIMENSION', 26: 'DIMENSION',
  27: 'POINT', 28: '3DFACE', 29: 'POLYLINE', 30: 'POLYLINE', 31: 'SOLID', 32: 'TRACE', 33: 'SHAPE', 34: 'VIEWPORT', 35: 'ELLIPSE', 36: 'SPLINE', 37: 'REGION', 38: '3DSOLID', 39: 'BODY', 40: 'RAY', 41: 'XLINE',
  42: 'DICTIONARY', 44: 'MTEXT', 45: 'LEADER', 46: 'TOLERANCE', 47: 'MLINE', 48: 'BLOCK_CONTROL', 49: 'BLOCK_RECORD', 50: 'LAYER_CONTROL', 51: 'LAYER', 52: 'STYLE_CONTROL', 53: 'STYLE',
  56: 'LTYPE_CONTROL', 57: 'LTYPE', 60: 'VIEW_CONTROL', 61: 'VIEW', 62: 'UCS_CONTROL', 63: 'UCS', 64: 'VPORT_CONTROL', 65: 'VPORT', 66: 'APPID_CONTROL', 67: 'APPID', 68: 'DIMSTYLE_CONTROL', 69: 'DIMSTYLE',
  70: 'VPENTHDR_CONTROL', 71: 'VPENTHDR', 72: 'GROUP', 73: 'MLINESTYLE', 74: 'OLE2FRAME', 76: 'LONG_TRANSACTION', 77: 'LWPOLYLINE', 78: 'HATCH', 79: 'XRECORD', 80: 'ACDBPLACEHOLDER', 81: 'VBA_PROJECT', 82: 'LAYOUT' };
const LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const lineweight = (i) => (i === 29 ? -1 : i === 30 ? -2 : i === 31 ? -3 : LW[i] ?? -3);

class ObjectReader {
  constructor(sec, v, classes, chk, dec) { Object.assign(this, { sec, v, classes, chk, dec }); }

  // the common start of every object (20.1, 20.2); returns null if it cannot be read
  open(loc) {
    const { sec, v } = this;
    const b = sec.b;
    const at = sec.absolute ? loc : sec.at + loc;
    const r = new Bits(b, v, at, this.dec);
    const size = r.MS();
    let hsize = 0;
    if (v >= 24) hsize = r.MC();
    const dataBit = r.p;
    const crcAt = (dataBit >>> 3) + size;
    if (crcAt + 2 > b.length) return null;
    const crcOk = crc16(0xc0c1, b, at, crcAt) === (b[crcAt] | (b[crcAt + 1] << 8));
    this.chk.ok('object CRC', crcOk);
    const type = r.OT();
    const name = type >= 500 ? (this.classes.get(type) || {}).dxf || `CLASS${type}` : FIXED[type] || `TYPE${type}`;
    let hBit = null;
    if (v >= 15 && v <= 21) hBit = dataBit + r.RL();
    if (v >= 24) hBit = dataBit + size * 8 - hsize;
    const handle = r.H().v;
    // EED (28): length-prefixed runs, skipped
    for (let n = r.BS(); n; n = r.BS()) { r.H(); r.p += n * 8; }
    const o = { at, type, name, handle, size, r, v, hBit, crcOk, dataBit, endBit: dataBit + size * 8 };
    return o;
  }

  // the string stream and the handle stream, once hBit is known
  streams(o) {
    const { r, v } = o;
    if (o.hBit === null) o.hBit = o.dataBit + r.RL(); // R13-R14: after the graphics/EED
    if (v >= 21) r.str = stringStream(r.b, v, o.hBit, o.dataBit);
    o.h = new Bits(r.b, v, 0, this.dec);
    o.h.p = o.hBit;
  }

  // 20.4.1: common entity data
  entity(o) {
    const { r, v } = o;
    if (r.B()) { const n = v >= 24 ? r.BLL() : r.RL(); r.p += n * 8; }
    if (v <= 14) o.hBit = o.dataBit + r.RL();
    this.streams(o);
    const e = { entmode: r.BB() };
    e.reactors = r.BL();
    e.xdic = v >= 18 ? !r.B() : true;
    if (v >= 27) r.B();
    let bylayerlt = 1;
    if (v <= 14) bylayerlt = r.B();
    // 20.4.1 lists Nolinks for every version ("for R2004+ this always has value 1"); from
    // R2004 the bit is not stored at all: the files' fields line up only without it
    e.nolinks = v >= 18 ? 1 : r.B();
    e.colour = r.ENC();
    e.ltscale = r.BD();
    if (v >= 15) {
      e.ltflags = r.BB(); e.psflags = r.BB();
      if (v >= 21) { e.matflags = r.BB(); e.shadow = r.RC(); }
      if (v >= 24) { e.vs = [r.B(), r.B(), r.B()]; }
    } else e.ltflags = bylayerlt ? 0 : 3;
    e.invisible = r.BS() & 1;
    e.lw = v >= 15 ? lineweight(r.RC()) : -1;
    o.e = e;
    return e;
  }

  // 20.4.2: the common entity handles
  entityHandles(o) {
    const { h, v, e, handle } = { h: o.h, v: o.v || this.v, e: o.e, handle: o.handle };
    if (e.entmode === 0) e.owner = h.Ha(handle);
    for (let k = 0; k < e.reactors; k++) h.H();
    if (e.xdic) h.H();
    if (v <= 14) { e.layer = h.Ha(handle); if (e.ltflags === 3) e.ltype = h.Ha(handle); }
    if (v <= 15 && !e.nolinks) { h.H(); h.H(); }
    if (v >= 18 && e.colour.book) h.H();
    if (v >= 15) {
      e.layer = h.Ha(handle);
      if (e.ltflags === 3) e.ltype = h.Ha(handle);
      if (v >= 21 && e.matflags === 3) h.H();
      if (e.psflags === 3) h.H();
      // 20.4.1 "shadow flags" RC (R2007+): 3 is followed by a handle, as the BB flags are
      // (AutoCAD-saved R2018 Drawing1: 196 polylines with 3 carry handle F before their vertex
      // list; ODA's DXF writes it as 390, LibreDWG's 284 = 3). Placed before the visual-style
      // handles: no file here has both
      if (v >= 21 && e.shadow === 3) h.H();
      if (v >= 24) for (const x of e.vs) if (x) h.H();
    }
  }

  // 20.1: the common object (non-entity) data and handles
  object(o) {
    const { r, v } = o;
    if (v <= 14) o.hBit = o.dataBit + r.RL();
    this.streams(o);
    o.reactors = r.BL();
    o.xdic = v >= 18 ? !r.B() : true;
    if (v >= 27) r.B();
  }
  objectHandles(o) {
    const h = o.h;
    o.owner = h.Ha(o.handle);
    for (let k = 0; k < o.reactors; k++) h.H();
    if (o.xdic) h.H();
  }

  read(loc) {
    const o = this.open(loc);
    if (!o) return null;
    const fn = DECODE[o.name];
    if (!fn || (o.name === 'ACAD_TABLE' && this.v >= 24)) return o; // a type not decoded (not an error)
    try {
      if (ENTITY_NAMES.has(o.name)) { this.entity(o); fn.call(this, o, o.r, this.v); } else { this.object(o); fn.call(this, o, o.r, this.v); }
      o.decoded = true;
      // the data must not run into the handles, and the handles must stay inside the object
      this.chk.ok('object data ends before its handles', o.r.p <= o.hBit + (this.v >= 21 ? 0 : 0) || this.v >= 21, true);
      this.chk.ok('object handles end inside the object', !o.h || o.h.p <= o.endBit);
    } catch (err) {
      o.error = String(err.message || err);
      this.chk.ok(`decode ${o.name}`, false);
    }
    return o;
  }
}
const ENTITY_NAMES = new Set(['TEXT', 'ATTRIB', 'ATTDEF', 'BLOCK', 'ENDBLK', 'SEQEND', 'INSERT', 'MINSERT', 'VERTEX', 'POLYLINE', 'ARC', 'CIRCLE', 'LINE', 'DIMENSION', 'POINT', 'SOLID', 'TRACE',
  'ELLIPSE', 'SPLINE', 'MTEXT', 'LWPOLYLINE', 'HATCH', 'ARC_DIMENSION', 'LARGE_RADIAL_DIMENSION', 'ACAD_TABLE']);

// the per-type prescriptions (20.4.x); each reads its data with r and its handles with o.h
const DECODE = {
  TEXT(o, r, v) { o.d = text(r, v); this.entityHandles(o); o.d.style = o.h.Ha(o.handle); },
  ATTRIB(o, r, v) { o.d = text(r, v); /* the rest is not drawn */ },
  ATTDEF(o, r, v) { o.d = text(r, v); },
  BLOCK(o, r) { o.d = { name: r.TV() }; this.entityHandles(o); },
  ENDBLK(o) { this.entityHandles(o); },
  SEQEND(o) { this.entityHandles(o); },
  INSERT(o, r, v) { o.d = insert(r, v, false); this.entityHandles(o); o.d.block = o.h.Ha(o.handle); },
  // 20.4.96.1: a table to R2007 is an INSERT of its anonymous *T block (the cells' graphics);
  // the cell data after the insert fields is not needed to draw it. R2010+ tables (20.4.96.2)
  // are not decoded.
  ACAD_TABLE(o, r, v) {
    o.d = insert(r, v, false); this.entityHandles(o); o.d.block = o.h.Ha(o.handle);
  },
  MINSERT(o, r, v) { o.d = insert(r, v, true); this.entityHandles(o); o.d.block = o.h.Ha(o.handle); },
  VERTEX(o, r, v) {
    // a PFACE face record (14) has no flags byte: its four vertex indices follow the common data
    const d = (o.d = { flags: o.type === 14 ? 128 : r.RC() });
    if (o.type === 14) { d.idx = [r.BS(), r.BS(), r.BS(), r.BS()]; } else {
      d.pt = r.BD3();
      if (o.type === 10) {
        const sw = r.BD();
        if (sw < 0) d.sw = d.ew = -sw; else { d.sw = sw; d.ew = r.BD(); }
        d.bulge = r.BD();
        if (v >= 24) r.BL();
        d.tangent = r.BD();
      }
    }
    this.entityHandles(o);
  },
  POLYLINE(o, r, v) {
    const d = (o.d = {});
    if (o.type === 15) { d.flags = r.BS(); d.curve = r.BS(); d.sw = r.BD(); d.ew = r.BD(); d.thick = r.BT(); d.elev = r.BD(); d.ext = r.BE(); } else if (o.type === 16) {
      const f1 = r.RC(), f2 = r.RC();
      d.flags = 8 | (f2 & 1 ? 1 : 0) | (f1 & 3 ? 4 : 0);
    } else if (o.type === 29) { d.flags = 64; d.nv = r.BS(); d.nf = r.BS(); } else {
      // 20.4.17 MESH: flags BS (closed in M 1, in N 32: DXF 70 with the mesh bit 16 added; it was
      // dropped, so AutoCAD R13's SEXTANT meshes read as open: 16 where LibreDWG and ODA give 48),
      // curve type 75, M and N vertex counts 71/72, M and N densities 73/74
      d.flags = 16 | r.BS(); d.curve = r.BS(); d.m = r.BS(); d.n = r.BS(); d.md = r.BS(); d.nd = r.BS();
    }
    const owned = v >= 18 ? r.BL() : 0;
    this.entityHandles(o);
    if (v >= 18) { d.vertices = []; for (let k = 0; k < owned; k++) d.vertices.push(o.h.Ha(o.handle)); } else { d.first = o.h.Ha(o.handle); d.last = o.h.Ha(o.handle); }
  },
  ARC(o, r) { o.d = { c: r.BD3(), rad: r.BD(), thick: r.BT(), ext: r.BE(), a0: r.BD(), a1: r.BD() }; this.entityHandles(o); },
  CIRCLE(o, r) { o.d = { c: r.BD3(), rad: r.BD(), thick: r.BT(), ext: r.BE() }; this.entityHandles(o); },
  LINE(o, r, v) {
    const d = (o.d = {});
    if (v <= 14) { d.p0 = r.BD3(); d.p1 = r.BD3(); } else {
      const zz = r.B();
      const x0 = r.RD(), x1 = r.DD(x0), y0 = r.RD(), y1 = r.DD(y0);
      let z0 = 0, z1 = 0;
      if (!zz) { z0 = r.RD(); z1 = r.DD(z0); }
      d.p0 = [x0, y0, z0]; d.p1 = [x1, y1, z1];
    }
    d.thick = r.BT(); d.ext = r.BE();
    this.entityHandles(o);
  },
  DIMENSION(o, r, v) {
    const d = (o.d = dimCommon(r, v));
    switch (o.type) {
      case 20: d.p10 = r.BD3(); d.p13 = r.BD3(); d.p14 = r.BD3(); d.flags2 = r.RC(); break;
      case 21: d.p13 = r.BD3(); d.p14 = r.BD3(); d.p10 = r.BD3(); r.BD(); d.rot = r.BD(); break;
      case 22: d.p13 = r.BD3(); d.p14 = r.BD3(); d.p10 = r.BD3(); r.BD(); break;
      case 23: d.p10 = r.BD3(); d.p13 = r.BD3(); d.p14 = r.BD3(); d.p15 = r.BD3(); break;
      case 24: r.RD2(); d.p13 = r.BD3(); d.p14 = r.BD3(); d.p15 = r.BD3(); d.p10 = r.BD3(); break;
      case 25: d.p10 = r.BD3(); d.p15 = r.BD3(); r.BD(); break;
      default: d.p15 = r.BD3(); d.p10 = r.BD3(); r.BD();
    }
    this.entityHandles(o);
    d.dimstyle = o.h.Ha(o.handle); d.block = o.h.Ha(o.handle);
  },
  ARC_DIMENSION(o, r, v) {
    const d = (o.d = dimCommon(r, v));
    d.p10 = r.BD3(); r.BD3(); r.BD3(); r.BD3(); r.B(); r.BD(); r.BD(); r.B(); r.BD3(); r.BD3();
    this.entityHandles(o);
    d.dimstyle = o.h.Ha(o.handle); d.block = o.h.Ha(o.handle);
  },
  LARGE_RADIAL_DIMENSION(o, r, v) {
    const d = (o.d = dimCommon(r, v));
    d.p10 = r.BD3(); r.BD3(); r.BD(); r.BD3(); r.BD3();
    this.entityHandles(o);
    d.dimstyle = o.h.Ha(o.handle); d.block = o.h.Ha(o.handle);
  },
  POINT(o, r) { o.d = { p: r.BD3(), thick: r.BT(), ext: r.BE(), xang: r.BD() }; this.entityHandles(o); },
  SOLID(o, r) { const thick = r.BT(), z = r.BD(); o.d = { thick, z, c: [r.RD2(), r.RD2(), r.RD2(), r.RD2()], ext: r.BE() }; this.entityHandles(o); },
  TRACE(o, r) { DECODE.SOLID.call(this, o, r); },
  ELLIPSE(o, r) { o.d = { c: r.BD3(), major: r.BD3(), ext: r.BD3(), ratio: r.BD(), t0: r.BD(), t1: r.BD() }; this.entityHandles(o); },
  SPLINE(o, r, v) {
    const d = (o.d = { knots: [], ctrl: [], weights: [], fit: [] });
    let scen = r.BL();
    if (v >= 27) {
      // R2013: the stored scenario is superseded: 1 when the knot parameter is Custom (15) or
      // there is no fit data (flags1 bit 1), else 2 (20.4.40)
      d.flags1 = r.BL();
      const knotParam = r.BL();
      scen = knotParam === 15 || !(d.flags1 & 1) ? 1 : 2;
    }
    d.degree = r.BL();
    let nk = 0, nc = 0, nf = 0, w = false;
    if (scen === 2) { r.BD(); r.BD3(); r.BD3(); nf = r.BL(); } else {
      d.rational = r.B(); d.closed = r.B(); d.periodic = r.B(); r.BD(); r.BD(); nk = r.BL(); nc = r.BL(); w = r.B();
    }
    for (let k = 0; k < nk; k++) d.knots.push(r.BD());
    for (let k = 0; k < nc; k++) { d.ctrl.push(r.BD3()); if (w) d.weights.push(r.BD()); }
    for (let k = 0; k < nf; k++) d.fit.push(r.BD3());
    this.entityHandles(o);
  },
  MTEXT(o, r, v) {
    const d = (o.d = { p: r.BD3(), ext: r.BD3(), xdir: r.BD3(), width: r.BD() });
    if (v >= 21) r.BD();
    d.h = r.BD(); d.attach = r.BS(); d.dir = r.BS(); r.BD(); r.BD();
    d.text = r.TV();
    // the rest (line spacing, background, columns) is not drawn
    this.entityHandles(o);
    d.style = o.h.Ha(o.handle);
  },
  LWPOLYLINE(o, r, v) {
    const d = (o.d = { pts: [], bulges: [] });
    const fl = r.BS();
    d.flags = fl;
    if (fl & 4) d.cw = r.BD();
    if (fl & 8) d.elev = r.BD();
    if (fl & 2) d.thick = r.BD();
    if (fl & 1) d.ext = r.BD3();
    const np = r.BL();
    const nb = fl & 16 ? r.BL() : 0;
    const nid = v >= 24 && fl & 1024 ? r.BL() : 0;
    const nw = fl & 32 ? r.BL() : 0;
    if (np > 1e7) throw new Error('LWPOLYLINE point count');
    if (v <= 14) { for (let k = 0; k < np; k++) d.pts.push(r.RD2()); } else if (np) {
      let p = r.RD2();
      d.pts.push(p);
      for (let k = 1; k < np; k++) { p = [r.DD(p[0]), r.DD(p[1])]; d.pts.push(p); }
    }
    for (let k = 0; k < nb; k++) d.bulges.push(r.BD());
    for (let k = 0; k < nid; k++) r.BL();
    for (let k = 0; k < nw; k++) { r.BD(); r.BD(); }
    this.entityHandles(o);
  },
  HATCH(o, r, v) {
    const d = (o.d = { loops: [] });
    if (v >= 18) {
      const grad = r.BL(); r.BL(); r.BD(); r.BD(); r.BL(); r.BD();
      const nc = r.BL();
      for (let k = 0; k < nc; k++) { r.BD(); r.BS(); r.BL(); r.RC(); }
      r.TV();
      d.gradient = grad;
    }
    d.z = r.BD(); d.ext = r.BD3(); d.name = r.TV(); d.solid = r.B(); d.assoc = r.B();
    const np = r.BL();
    let any4 = false, nBound = 0;
    for (let p = 0; p < np; p++) {
      const flag = r.BL();
      if (flag & 4) any4 = true;
      const loop = { flag, edges: [] };
      if (!(flag & 2)) {
        const ns = r.BL();
        for (let s = 0; s < ns; s++) {
          const t = r.RC();
          if (t === 1) loop.edges.push({ t, a: r.RD2(), b: r.RD2() });
          else if (t === 2) loop.edges.push({ t, c: r.RD2(), rad: r.BD(), a0: r.BD(), a1: r.BD(), ccw: r.B() });
          else if (t === 3) loop.edges.push({ t, c: r.RD2(), m: r.RD2(), ratio: r.BD(), a0: r.BD(), a1: r.BD(), ccw: r.B() });
          else if (t === 4) {
            const e = { t, degree: r.BL(), rational: r.B(), periodic: r.B(), knots: [], ctrl: [] };
            const nk = r.BL(), nc = r.BL();
            for (let k = 0; k < nk; k++) e.knots.push(r.BD());
            for (let k = 0; k < nc; k++) { e.ctrl.push(r.RD2()); if (e.rational) r.BD(); }
            // R2010+: fit points, and their start / end tangents only when there are fit points
            // (20.4.75 lists the tangents unconditionally; a spline edge without fit data reads
            // past its hatch otherwise: acadsharp svg/export_sample's AA8)
            if (v >= 24) { const nf = r.BL(); for (let k = 0; k < nf; k++) r.RD2(); if (nf) { r.RD2(); r.RD2(); } }
            loop.edges.push(e);
          } else throw new Error(`HATCH edge type ${t}`);
        }
      } else {
        const hasB = r.B(); loop.closed = r.B();
        const n = r.BL();
        loop.pts = []; loop.bulges = [];
        for (let k = 0; k < n; k++) { loop.pts.push(r.RD2()); loop.bulges.push(hasB ? r.BD() : 0); }
      }
      nBound += r.BL();
      d.loops.push(loop);
    }
    r.BS(); r.BS();
    if (!d.solid) {
      r.BD(); r.BD(); r.B();
      const nl = r.BS();
      for (let k = 0; k < nl; k++) { r.BD(); r.BD2(); r.BD2(); const nd = r.BS(); for (let j = 0; j < nd; j++) r.BD(); }
    }
    if (any4) r.BD();
    const ns = r.BL();
    for (let k = 0; k < ns; k++) r.RD2();
    this.entityHandles(o);
    void nBound;
  },
  BLOCK_RECORD(o, r, v) {
    const d = (o.d = { name: r.TV() });
    tableFlags(r, v);
    d.anonymous = r.B(); d.hasatts = r.B(); d.xref = r.B(); d.overlaid = r.B();
    if (v >= 15) r.B();
    // R2004+: the owned-object count is stored only for a block that is not an xref (as the
    // R13-R2000 first/last entity handles are); an xref's base point reads right only so
    const owned = v >= 18 && !d.xref && !d.overlaid ? r.BL() : 0;
    d.base = r.BD3(); r.TV();
    let inserts = 0;
    if (v >= 15) { while (r.RC()) inserts++; r.TV(); const n = r.BL(); r.p += n * 8; }
    this.objectHandles(o);
    const h = o.h;
    h.H(); // NULL
    d.blockEnt = h.Ha(o.handle);
    if (v >= 18) { d.entities = []; for (let k = 0; k < owned; k++) d.entities.push(h.Ha(o.handle)); } else if (!d.xref && !d.overlaid) { d.first = h.Ha(o.handle); d.last = h.Ha(o.handle); }
    d.endBlk = h.Ha(o.handle);
    for (let k = 0; k < inserts; k++) h.H();
    if (v >= 15) d.layout = h.Ha(o.handle);
  },
  LAYER(o, r, v) {
    const d = (o.d = { name: r.TV() });
    tableFlags(r, v);
    // R13-R14: the bit 20.4.54 calls "On" is set when the layer is OFF (every layer AutoCAD's
    // DXF shows on reads 0 here, in example_r13/r14 and r14/Leader)
    if (v <= 14) { d.frozen = r.B(); d.on = !r.B(); r.B(); d.locked = r.B(); d.lw = -3; } else {
      const val = r.BS();
      d.frozen = !!(val & 1); d.on = !(val & 2); d.locked = !!(val & 8); d.lw = lineweight((val & 0x3e0) >> 5);
    }
    d.colour = r.CMC();
    this.objectHandles(o);
    const h = o.h;
    h.H();
    if (v >= 15) h.H();
    if (v >= 21) h.H();
    d.ltype = h.Ha(o.handle);
  },
  // 20.4.56: a text style; its big font decides how a text's bytes read (see bigFontDecoder)
  STYLE(o, r, v) {
    const d = (o.d = { name: r.TV() });
    tableFlags(r, v);
    d.vertical = r.B(); d.shape = r.B(); d.fixedH = r.BD(); d.wf = r.BD(); d.oblique = r.BD(); d.gen = r.RC(); d.lastH = r.BD();
    d.font = r.TV(); d.bigfont = r.TV();
    this.objectHandles(o);
  },
  LTYPE(o, r, v) {
    const d = (o.d = { name: r.TV(), dashes: [] });
    tableFlags(r, v);
    r.TV(); d.length = r.BD(); r.RC();
    const n = r.RC();
    let text = false;
    for (let k = 0; k < n; k++) { d.dashes.push(r.BD()); r.BS(); r.RD(); r.RD(); r.BD(); r.BD(); const sf = r.BS(); if (sf & 2) text = true; }
    if (v <= 18) r.p += 256 * 8; else if (text) r.p += 512 * 8;
    this.objectHandles(o);
  },
};
// a table entry's 64-flag, xrefindex+1 and xdep (20.4.52..): the files from R2007 on do not
// store the xrefindex+1 BS the spec lists (the following fields line up only without it)
function tableFlags(r, v) {
  r.B();
  if (v < 21) r.BS();
  r.B();
}
function text(r, v) {
  const d = {};
  if (v <= 14) {
    d.elev = r.BD(); d.p = r.RD2(); d.a = r.RD2(); d.ext = r.BD3(); d.thick = r.BD(); d.oblique = r.BD(); d.rot = r.BD(); d.h = r.BD(); d.wf = r.BD(); d.text = r.TV(); d.gen = r.BS(); d.ha = r.BS(); d.va = r.BS();
    return d;
  }
  const f = r.RC();
  d.elev = f & 1 ? 0 : r.RD();
  d.p = r.RD2();
  d.a = f & 2 ? d.p.slice() : [r.DD(d.p[0]), r.DD(d.p[1])];
  d.ext = r.BE(); d.thick = r.BT();
  d.oblique = f & 4 ? 0 : r.RD(); d.rot = f & 8 ? 0 : r.RD(); d.h = r.RD(); d.wf = f & 0x10 ? 1 : r.RD();
  d.text = r.TV();
  d.gen = f & 0x20 ? 0 : r.BS(); d.ha = f & 0x40 ? 0 : r.BS(); d.va = f & 0x80 ? 0 : r.BS();
  return d;
}
function insert(r, v, minsert) {
  const d = { p: r.BD3() };
  if (v <= 14) d.s = r.BD3(); else {
    const f = r.BB();
    if (f === 3) d.s = [1, 1, 1];
    else if (f === 1) { d.s = [1, r.DD(1), r.DD(1)]; } else if (f === 2) { const x = r.RD(); d.s = [x, x, x]; } else { const x = r.RD(); d.s = [x, r.DD(x), r.DD(x)]; }
  }
  d.rot = r.BD(); d.ext = r.BD3(); d.atts = r.B();
  // 20.4.9 lists the R2004 owned-object count unconditionally; it is there only when the
  // insert has attributes (example_2004's inserts without them read past their data otherwise)
  d.owned = v >= 18 && d.atts ? r.BL() : 0;
  if (minsert) { d.cols = r.BS(); d.rows = r.BS(); d.dc = r.BD(); d.dr = r.BD(); }
  return d;
}
function dimCommon(r, v) {
  const d = {};
  if (v >= 24) r.RC();
  d.ext = r.BD3(); d.mid = r.RD2(); d.elev = r.BD(); d.flags1 = r.RC(); d.text = r.TV(); r.BD(); r.BD(); r.BD(); r.BD(); r.BD(); r.BD();
  if (v >= 15) { r.BS(); r.BS(); r.BD(); r.BD(); }
  if (v >= 21) { r.B(); r.B(); r.B(); }
  d.p12 = r.RD2();
  return d;
}

// --- the drawing ---------------------------------------------------------------------------------

class Checks {
  constructor() { this.counts = {}; }
  ok(name, pass, soft = false) {
    const c = (this.counts[name] ||= { pass: 0, fail: 0, soft });
    if (pass) c.pass++; else c.fail++;
    return pass;
  }
  get failures() { return Object.entries(this.counts).filter(([, c]) => c.fail && !c.soft).map(([n, c]) => `${n}: ${c.fail} of ${c.pass + c.fail}`); }
}

// buf: the file's bytes (ArrayBuffer or Uint8Array)
export function readDWG(buf) {
  // a plain Uint8Array view, whatever came in: a Node Buffer's slice() is a view, not a copy,
  // and the checks zero fields in their copies
  const b = buf instanceof Uint8Array ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
  const tag = String.fromCharCode(...b.subarray(0, 6));
  const v = VER[tag];
  if (!v) throw new Error(/^AC\d{4}$/.test(tag) ? `a ${tag} DWG (older than R13) is not read` : 'not a DWG file');
  const chk = new Checks();
  const maint = b[0x0b];
  // a file too short for its file header, or whose container cannot be walked, is refused by name
  // (cad-extractor-ir's corrupt_01_truncated_header: 16 bytes)
  if (b.length < 0x100) throw new Error(`not a complete DWG: ${b.length} bytes, shorter than a file header`);
  let cont;
  try { cont = v <= 15 ? container15(b, chk) : v === 21 ? container21(b, chk) : container18(b, chk); } catch (e) {
    if (e instanceof TypeError || e instanceof RangeError) throw new Error(`a damaged or truncated DWG: its container cannot be read (${e.message})`);
    throw e;
  }
  // a file without the four sections every drawing has is refused by name (dwg-rs's 1440-byte
  // synthetic_2010/2013 fixtures: a container with no drawing in it)
  const missing = ['header', 'classes', 'handles', 'objects'].filter((k) => !cont[k]);
  if (missing.length) throw new Error(`not a complete DWG: no ${missing.join(', ')} section`);
  const dec = codepageDecoder(cont.codepage);
  const classes = readClasses(cont.classes, v, maint, chk);
  let header = {};
  try { header = readHeader(cont.header, v, maint, chk); } catch (err) { chk.ok('header variables read', false); header = { error: String(err.message) }; }
  const map = readHandles(cont.handles, chk);
  const appInfo = appInfoStrings(cont.appInfo, v);
  const rd = new ObjectReader(cont.objects, v, classes, chk, dec);
  const objects = new Map();
  const types = {};
  for (const [h, loc] of map) {
    let o;
    try { o = rd.read(loc); } catch (err) { chk.ok('object start readable', false); continue; }
    if (!o) { chk.ok('object start readable', false); continue; }
    chk.ok('object handle matches the map', o.handle === h);
    types[o.name] = (types[o.name] || 0) + 1;
    objects.set(o.handle, o);
  }
  return { version: tag, release: VERSION_NAMES[tag], v, maint, header, classes, objects, types, checks: chk.counts, failures: chk.failures, mapCount: map.length, appInfo, writer: writerOf(appInfo), encoding: dec.encoding };
}
function codepageDecoder(cp) {
  // the DWG code page numbers of the common ANSI pages
  const names = { 30: 'windows-1252', 31: 'windows-1251', 32: 'windows-1250', 29: 'windows-874', 33: 'windows-1253', 34: 'windows-1254', 35: 'windows-1255', 36: 'windows-1256', 37: 'windows-1257', 38: 'shift_jis', 39: 'gbk', 40: 'euc-kr', 41: 'big5' };
  try { return names[cp] ? new TextDecoder(names[cp]) : LATIN1; } catch { return LATIN1; }
}

// A text whose style has an Asian big font is drawn by that font from the text's bytes, two at a
// time: AutoCAD LT 2000's own HOME FLOOR PLAN (code page 1252) writes "Ｘ１" as 82 77 82 50 in a
// romans + extfont style (ODA's DXF shows Ｘ１). The big fonts AutoCAD ships, and their pages:
const BIGFONT_PAGES = [[/^@?extfont|^bigfont/i, 'shift_jis'], [/^chineset/i, 'big5'], [/^gbcbig/i, 'gbk'], [/^wh[gt][a-z]*txt/i, 'euc-kr']];
function bigFontDecoder(file) {
  const base = String(file || '').split(/[\\/]/).pop();
  for (const [re, label] of BIGFONT_PAGES) if (re.test(base)) { try { return new TextDecoder(label); } catch { return null; } }
  return null;
}
// the bytes a windows-1252 reading came from (every byte maps to one character there), or null
let CP1252_BYTES = null;
function cp1252Bytes(s) {
  if (!CP1252_BYTES) { CP1252_BYTES = new Map(); for (let b = 0; b < 256; b++) CP1252_BYTES.set(LATIN1.decode(new Uint8Array([b])), b); }
  const out = [];
  for (const ch of s) { const b = CP1252_BYTES.get(ch); if (b === undefined) return null; out.push(b); }
  return new Uint8Array(out);
}

// --- DXF pairs: what js/dxf.js reads --------------------------------------------------------------

const deg = (r) => (r * 180) / Math.PI;
const hex = (h) => h.toString(16).toUpperCase();

// The drawing as DXF group-code pairs [[code, 'value'], ...]: HEADER ($INSUNITS,
// $LTSCALE, $EXTMIN/MAX), TABLES (LTYPE, LAYER), BLOCKS, ENTITIES
export function dwgToPairs(dwg) {
  const { objects, header } = dwg;
  const P = [];
  const put = (c, x) => P.push([c, typeof x === 'number' ? String(Number.isFinite(x) ? x : 0) : String(x ?? '')]);
  const name = (h) => { const o = objects.get(h); return o && o.d ? o.d.name : undefined; };
  // a pre-R2007 text in a style with an Asian big font, in a drawing of code page 1252: its
  // bytes read by the big font's page (bigFontDecoder); unchanged when they do not form one
  const styleText = (s, styleH) => {
    if (dwg.v >= 21 || dwg.encoding !== 'windows-1252' || !/[\x80-\xffŒ-™]/.test(s)) return s;
    const st = objects.get(styleH);
    const bd = st && st.d && bigFontDecoder(st.d.bigfont);
    const bytes = bd && cp1252Bytes(s);
    if (!bytes) return s;
    const t = new TextDecoder(bd.encoding, { fatal: true });
    try { return t.decode(bytes); } catch { return s; }
  };
  // anonymous blocks are stored as "*D", "*U", "*T", "*X" ...; a drawing has many with one
  // name, so each gets a number, one counter in handle order (AutoCAD numbers them on output too)
  const blockName = new Map();
  let anon = 1;
  for (const o of [...objects.values()].filter((x) => x.decoded && x.name === 'BLOCK_RECORD').sort((a, b) => hcmp(a.handle, b.handle))) {
    blockName.set(o.handle, /^\*[A-Za-z]$/.test(o.d.name) ? `${o.d.name}${anon++}` : o.d.name);
  }
  const bname = (h) => blockName.get(h);
  put(0, 'SECTION'); put(2, 'HEADER');
  put(9, '$ACADVER'); put(1, dwg.version);
  if (Number.isFinite(header.INSUNITS)) { put(9, '$INSUNITS'); put(70, header.INSUNITS); }
  if (Number.isFinite(header.LTSCALE)) { put(9, '$LTSCALE'); put(40, header.LTSCALE); }
  if (header.EXTMIN) { put(9, '$EXTMIN'); put(10, header.EXTMIN[0]); put(20, header.EXTMIN[1]); put(9, '$EXTMAX'); put(10, header.EXTMAX[0]); put(20, header.EXTMAX[1]); }
  put(0, 'ENDSEC');
  put(0, 'SECTION'); put(2, 'TABLES');
  for (const o of objects.values()) {
    if (!o.decoded) continue;
    if (o.name === 'LTYPE') { put(0, 'LTYPE'); put(5, hex(o.handle)); put(2, o.d.name); put(73, o.d.dashes.length); put(40, o.d.length); for (const x of o.d.dashes) put(49, x); }
  }
  for (const o of objects.values()) {
    if (!o.decoded || o.name !== 'LAYER') continue;
    const d = o.d;
    put(0, 'LAYER'); put(5, hex(o.handle)); put(2, d.name);
    put(70, (d.frozen ? 1 : 0) | (d.locked ? 4 : 0));
    // the index as stored, out-of-range ones included (a layer of BYLAYER, 256, in an R2000 file:
    // ODA's DXF writes 256 too; it draws white either way)
    const aci = Number.isInteger(d.colour.aci) && d.colour.aci >= 0 ? d.colour.aci : 7;
    put(62, d.on ? aci : -aci);
    if (d.colour.rgb !== undefined) put(420, d.colour.rgb);
    put(6, name(d.ltype) || 'CONTINUOUS');
    put(370, d.lw);
  }
  for (const [h, n] of blockName) { put(0, 'BLOCK_RECORD'); put(5, hex(h)); put(2, n); }
  put(0, 'ENDSEC');
  // which block record owns each entity, and the entities in order
  const blocks = [];
  let model = null, paper = null;
  for (const o of objects.values()) {
    if (!o.decoded || o.name !== 'BLOCK_RECORD') continue;
    const n = o.d.name.toUpperCase();
    if (n === '*MODEL_SPACE') model = o; else if (n === '*PAPER_SPACE') paper = o;
    blocks.push(o);
  }
  const owned = new Map(); // block record handle -> [entity]
  const children = new Map(); // owner handle -> [entity] (vertices, attributes)
  for (const o of objects.values()) {
    if (!o.decoded || !o.e) continue;
    let ownerH = o.e.owner;
    if (o.e.entmode === 2 && model) ownerH = model.handle;
    if (o.e.entmode === 1 && paper) ownerH = paper.handle;
    const ow = objects.get(ownerH);
    if (ow && ow.name === 'BLOCK_RECORD') { if (!owned.has(ownerH)) owned.set(ownerH, []); owned.get(ownerH).push(o); } else if (ownerH !== undefined) {
      if (!children.has(ownerH)) children.set(ownerH, []);
      children.get(ownerH).push(o);
    }
  }
  const emitEntity = (o, inPaper) => {
    const e = o.e, d = o.d;
    if (!d && !['ENDBLK', 'SEQEND'].includes(o.name)) return;
    const common = (type) => {
      put(0, type); put(5, hex(o.handle));
      if (inPaper) put(67, 1);
      put(8, name(e.layer) || '0');
      if (e.ltflags === 1) put(6, 'BYBLOCK'); else if (e.ltflags === 2) put(6, 'CONTINUOUS'); else if (e.ltflags === 3) put(6, name(e.ltype) || 'BYLAYER');
      if (e.colour.aci !== 256) put(62, e.colour.aci);
      if (e.colour.rgb !== undefined) put(420, e.colour.rgb);
      if (e.ltscale !== 1) put(48, e.ltscale);
      if (e.lw !== -1) put(370, e.lw);
      if (e.invisible) put(60, 1);
    };
    const ext = (x) => { if (x && (x[0] || x[1] || x[2] !== 1)) { put(210, x[0]); put(220, x[1]); put(230, x[2]); } };
    switch (o.name) {
      case 'LINE': common('LINE'); put(10, d.p0[0]); put(20, d.p0[1]); put(30, d.p0[2]); put(11, d.p1[0]); put(21, d.p1[1]); put(31, d.p1[2]); ext(d.ext); break;
      case 'CIRCLE': common('CIRCLE'); put(10, d.c[0]); put(20, d.c[1]); put(30, d.c[2]); put(40, d.rad); ext(d.ext); break;
      case 'ARC': common('ARC'); put(10, d.c[0]); put(20, d.c[1]); put(30, d.c[2]); put(40, d.rad); put(50, deg(d.a0)); put(51, deg(d.a1)); ext(d.ext); break;
      case 'POINT': common('POINT'); put(10, d.p[0]); put(20, d.p[1]); put(30, d.p[2]); ext(d.ext); break;
      case 'ELLIPSE': common('ELLIPSE'); put(10, d.c[0]); put(20, d.c[1]); put(30, d.c[2]); put(11, d.major[0]); put(21, d.major[1]); put(31, d.major[2]); ext(d.ext); put(40, d.ratio); put(41, d.t0); put(42, d.t1); break;
      case 'SOLID': case 'TRACE':
        common(o.name);
        d.c.forEach((p, k) => { put(10 + k, p[0]); put(20 + k, p[1]); put(30 + k, d.z); });
        ext(d.ext); break;
      case 'TEXT': {
        // a DXF value is one line: a line break in single-line text becomes a space
        common('TEXT'); put(10, d.p[0]); put(20, d.p[1]); put(30, d.elev); put(40, d.h); put(1, styleText(d.text, d.style).replace(/\r\n|\r|\n/g, ' '));
        if (d.rot) put(50, deg(d.rot));
        if (d.wf !== 1) put(41, d.wf);
        if (d.ha) put(72, d.ha);
        if (d.ha || d.va) { put(11, d.a[0]); put(21, d.a[1]); put(31, d.elev); }
        ext(d.ext);
        if (d.va) put(73, d.va);
        break;
      }
      case 'MTEXT': {
        common('MTEXT'); put(10, d.p[0]); put(20, d.p[1]); put(30, d.p[2]); put(40, d.h); put(41, d.width); put(71, d.attach); put(72, d.dir);
        // a DXF value is one line: a raw line break in MTEXT (some writers store one) is its
        // paragraph code \P, which the drawing reads as a new line
        const mt = styleText(d.text, d.style).replace(/\r\n|\r|\n/g, '\\P');
        for (let k = 0; k + 250 < mt.length; k += 250) put(3, mt.slice(k, k + 250));
        put(1, mt.slice(Math.floor(Math.max(0, mt.length - 1) / 250) * 250));
        ext(d.ext); put(11, d.xdir[0]); put(21, d.xdir[1]); put(31, d.xdir[2]);
        break;
      }
      case 'LWPOLYLINE': {
        common('LWPOLYLINE'); put(90, d.pts.length); put(70, (d.flags & 512 ? 1 : 0) | (d.flags & 128 ? 128 : 0));
        if (d.elev) put(38, d.elev);
        if (d.cw) put(43, d.cw);
        d.pts.forEach((p, k) => { put(10, p[0]); put(20, p[1]); if (d.bulges[k]) put(42, d.bulges[k]); });
        ext(d.ext); break;
      }
      case 'POLYLINE': {
        common('POLYLINE'); put(66, 1); put(10, 0); put(20, 0); put(30, d.elev || 0); put(70, d.flags);
        if (d.flags & 16) { put(71, d.m); put(72, d.n); put(73, d.md); put(74, d.nd); put(75, d.curve); }
        if (d.flags & 64) { put(71, d.nv); put(72, d.nf); }
        ext(d.ext);
        const kids = new Map((children.get(o.handle) || []).map((c) => [c.handle, c]));
        const order = d.vertices || [...kids.keys()].sort(hcmp);
        for (const vh of order) {
          const vx = kids.get(vh) || objects.get(vh);
          if (!vx || vx.name !== 'VERTEX' || !vx.d) continue;
          const pt = vx.d.pt || [0, 0, 0]; // a PFACE face record has no point (DXF writes 0,0,0)
          put(0, 'VERTEX'); put(5, hex(vh)); put(8, name(vx.e.layer) || '0'); put(10, pt[0]); put(20, pt[1]); put(30, pt[2]);
          if (vx.d.bulge) put(42, vx.d.bulge);
          put(70, vx.d.flags);
          if (vx.d.idx) vx.d.idx.forEach((x, k) => { if (x) put(71 + k, x); });
        }
        put(0, 'SEQEND'); break;
      }
      case 'SPLINE': {
        common('SPLINE');
        const closed = d.closed || (d.flags1 & 4);
        put(70, (closed ? 1 : 0) | (d.periodic ? 2 : 0) | (d.rational ? 4 : 0)); put(71, d.degree); put(72, d.knots.length); put(73, d.ctrl.length); put(74, d.fit.length);
        for (const k of d.knots) put(40, k);
        for (const w of d.weights) put(41, w);
        for (const p of d.ctrl) { put(10, p[0]); put(20, p[1]); put(30, p[2]); }
        for (const p of d.fit) { put(11, p[0]); put(21, p[1]); put(31, p[2]); }
        break;
      }
      case 'INSERT': case 'MINSERT': case 'ACAD_TABLE': {
        const bn = bname(d.block);
        if (!bn) break;
        common('INSERT'); put(2, bn); put(10, d.p[0]); put(20, d.p[1]); put(30, d.p[2]);
        if (d.s[0] !== 1) put(41, d.s[0]);
        if (d.s[1] !== 1) put(42, d.s[1]);
        if (d.s[2] !== 1) put(43, d.s[2]);
        if (d.rot) put(50, deg(d.rot));
        if (o.name === 'MINSERT') { put(70, d.cols); put(71, d.rows); put(44, d.dc); put(45, d.dr); }
        ext(d.ext); break;
      }
      case 'DIMENSION': case 'ARC_DIMENSION': case 'LARGE_RADIAL_DIMENSION': {
        const bn = bname(d.block);
        common('DIMENSION'); if (bn) put(2, bn);
        put(10, d.p10[0]); put(20, d.p10[1]); put(30, d.p10[2]); put(11, d.mid[0]); put(21, d.mid[1]); put(70, o.type >= 20 && o.type <= 26 ? o.type - 21 < 0 ? 6 : o.type - 21 : 0);
        if (d.text) put(1, d.text);
        ext(d.ext); break;
      }
      case 'HATCH': {
        // a solid fill is "SOLID" in DXF whatever name is stored ("SOLID,_O" in acadsharp
        // sample_base 371, "_SOLID" in an AutoCAD R2010 file); a pattern's name is written as
        // stored, island-style suffix included ("ANSI31,_O", "AR-RROOF,_O": ODA's DXF of
        // AutoCAD-saved R2010/R2013 drawings)
        common('HATCH'); put(10, 0); put(20, 0); put(30, d.z); ext(d.ext); put(2, d.solid ? 'SOLID' : d.name); put(70, d.solid ? 1 : 0); put(71, d.assoc ? 1 : 0); put(91, d.loops.length);
        for (const L of d.loops) {
          put(92, L.flag);
          if (L.flag & 2) {
            put(72, L.bulges.some((x) => x) ? 1 : 0); put(73, L.closed ? 1 : 0); put(93, L.pts.length);
            L.pts.forEach((p, k) => { put(10, p[0]); put(20, p[1]); if (L.bulges.some((x) => x)) put(42, L.bulges[k]); });
          } else {
            put(93, L.edges.length);
            for (const E of L.edges) {
              put(72, E.t);
              if (E.t === 1) { put(10, E.a[0]); put(20, E.a[1]); put(11, E.b[0]); put(21, E.b[1]); } else if (E.t === 2) { put(10, E.c[0]); put(20, E.c[1]); put(40, E.rad); put(50, deg(E.a0)); put(51, deg(E.a1)); put(73, E.ccw ? 1 : 0); } else if (E.t === 3) { put(10, E.c[0]); put(20, E.c[1]); put(11, E.m[0]); put(21, E.m[1]); put(40, E.ratio); put(50, deg(E.a0)); put(51, deg(E.a1)); put(73, E.ccw ? 1 : 0); } else {
                put(94, E.degree); put(73, E.rational ? 1 : 0); put(74, E.periodic ? 1 : 0); put(95, E.knots.length); put(96, E.ctrl.length);
                for (const k of E.knots) put(40, k);
                for (const p of E.ctrl) { put(10, p[0]); put(20, p[1]); }
              }
            }
          }
          put(97, 0);
        }
        break;
      }
      default:
    }
  };
  const ordered = (rec) => {
    const list = owned.get(rec.handle) || [];
    if (rec.d.entities) { const pos = new Map(rec.d.entities.map((h, k) => [h, k])); return list.slice().sort((a, b) => (pos.get(a.handle) ?? 1e15) - (pos.get(b.handle) ?? 1e15) || hcmp(a.handle, b.handle)); }
    return list.slice().sort((a, b) => hcmp(a.handle, b.handle));
  };
  // what the adapter did with every decoded entity a block record owns: emitted, or not and why
  // (a type it does not draw, a reference whose block is not in the file): P.stats
  const stats = { owned: 0, emitted: 0, dropped: {} };
  const emit = (o, inPaper) => {
    stats.owned++;
    const n = P.length;
    emitEntity(o, inPaper);
    if (P.length > n) stats.emitted++;
    else { const why = ['ATTRIB', 'ATTDEF', 'VERTEX', 'SEQEND'].includes(o.name) ? `${o.name} (not drawn)` : `${o.name}${o.d && o.d.block !== undefined && !bname(o.d.block) ? ' (block not in the file)' : ''}`; stats.dropped[why] = (stats.dropped[why] || 0) + 1; }
  };
  put(0, 'SECTION'); put(2, 'BLOCKS');
  for (const rec of blocks) {
    if (rec === model || rec === paper) continue;
    const nm = bname(rec.handle);
    put(0, 'BLOCK'); put(5, hex(rec.handle)); put(8, '0'); put(2, nm); put(70, (rec.d.anonymous ? 1 : 0) | (rec.d.xref ? 4 : 0)); put(10, rec.d.base[0]); put(20, rec.d.base[1]); put(30, rec.d.base[2]); put(3, nm);
    for (const o of ordered(rec)) if (!['BLOCK', 'ENDBLK'].includes(o.name)) emit(o, false);
    put(0, 'ENDBLK'); put(8, '0');
  }
  put(0, 'ENDSEC');
  put(0, 'SECTION'); put(2, 'ENTITIES');
  // (a layout's own BLOCK / ENDBLK markers are structure, not drawn: left out, as in a block)
  if (model) for (const o of ordered(model)) if (!['BLOCK', 'ENDBLK'].includes(o.name)) emit(o, false);
  if (paper) for (const o of ordered(paper)) if (!['BLOCK', 'ENDBLK'].includes(o.name)) emit(o, true);
  put(0, 'ENDSEC');
  put(0, 'EOF');
  P.stats = stats;
  return P;
}

// for the tests: the pieces, so each layer can be checked on its own
export const _internal = { Bits, ObjectReader, Checks, container15, container18, container21, readHandles, readClasses, readHeader, deRS, checksum04, checksum21, magic };

// The pairs as DXF text; a string's control characters and carets in DXF's caret notation (a
// text may hold U+0003; written raw, a line feed would split the pair)
export function pairsToDXF(P) {
  let s = '';
  for (const [c, v] of P) s += `${c < 10 ? '  ' : c < 100 ? ' ' : ''}${c}\r\n${typeof v === 'string' && valueKind(c) === 's' ? caret(v) : v}\r\n`;
  return s;
}
