#!/usr/bin/env node
// js/dwg.js: the bit codes against the worked examples the spec gives (chapter 2), and the
// reader's checks two-sided on real files: a sound file passes every check, and the same file
// with one byte changed inside an object, or in the R2004 file header, fails the check that
// covers it. The drawings are not in this repository (third-party files): set DWG_CORPUS to a
// directory holding example_r14.dwg .. example_2018.dwg (LibreDWG's test/test-data). Without
// it the file arms are skipped, and the run says so.
//
//   DWG_CORPUS=DIR node tests/test-dwg.mjs   -> "RESULT: N passed, 0 failed[, M skipped]"
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { readDWG, dwgToPairs, drawDWG, pairsToDXF, decompress18, decompress21, _internal, crc16, crc32 } from '../js/dwg.js';
import { parseDXF } from '../js/dxf.js';
import { test as t, skip, done } from './harness.mjs';

const { Bits } = _internal;
const bits = (s) => { const t = s.replace(/[^01]/g, ''); const b = new Uint8Array(Math.ceil(t.length / 8)); for (let i = 0; i < t.length; i++) if (t[i] === '1') b[i >> 3] |= 0x80 >> (i & 7); return b; };

// --- 2: the bit codes, by the spec's own examples ---
t('2.2 BITSHORT: 257, 0, 256, 15, 0', () => {
  const r = new Bits(bits('0000000001000000011011010000111110'), 15);
  assert.deepEqual([r.BS(), r.BS(), r.BS(), r.BS(), r.BS()], [257, 0, 256, 15, 0]);
});
t('2.3 BITLONG: 257, 0, 15, 0', () => {
  const r = new Bits(bits('000000000100000001000000000000000010010000111110'), 15);
  assert.deepEqual([r.BL(), r.BL(), r.BL(), r.BL()], [257, 0, 15, 0]);
});
t('2.6 MODULAR CHAR: 4610, 112823273, -1413', () => {
  assert.equal(new Bits(Uint8Array.of(0b10000010, 0b00100100), 15).MC(), 4610);
  assert.equal(new Bits(Uint8Array.of(0b11101001, 0b10010111, 0b11100110, 0b00110101), 15).MC(), 112823273);
  assert.equal(new Bits(Uint8Array.of(0b10000101, 0b01001011), 15).MCs(), -1413);
});
t('2.7 MODULAR SHORT: 4650033', () => {
  assert.equal(new Bits(Uint8Array.of(0b00110001, 0b11110100, 0b10001101, 0b00000000), 15).MS(), 4650033);
});
t('2.13 handle 5.2.05E7', () => {
  const h = new Bits(Uint8Array.of(0b01010010, 0b00000101, 0b11100111), 15).H();
  assert.deepEqual([h.code, h.v], [5, 0x5e7]);
});
t('2.14.1 CRC-16: the table rows the spec prints', () => {
  // crc16(0, [i]) is the table entry for i; the spec's rows start 0x0000,0xC0C1,0xC181,0x0140
  assert.deepEqual([0, 1, 2, 3].map((i) => crc16(0, Uint8Array.of(i), 0, 1)), [0x0000, 0xc0c1, 0xc181, 0x0140]);
});
t('4.1 the magic sequence starts 29 23 BE 84 E1 6C D6 AE', () => {
  assert.deepEqual([..._internal.magic(8)], [0x29, 0x23, 0xbe, 0x84, 0xe1, 0x6c, 0xd6, 0xae]);
});
t('a DWG drawing reaches parseDXF as pairs', () => {
  const P = [[0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [10, '0'], [20, '0'], [11, '3'], [21, '4'], [0, 'ENDSEC'], [0, 'EOF']];
  const d = parseDXF(P);
  assert.equal(d.paths.length, 1);
  assert.deepEqual([...d.paths[0].pts], [0, 0, 3, 4]);
});

// --- no corpus needed: the checksums, the decompressor and the DXF writer, each two-sided ---
t('CRC-32: the standard check value, and one changed byte changes it', () => {
  const b = new TextEncoder().encode('123456789');
  assert.equal(crc32(b, 0, b.length), 0xcbf43926);
  assert.equal(crc32(b), 0xcbf43926, 'the range defaults to the whole buffer');
  b[4] ^= 1;
  assert.notEqual(crc32(b), 0xcbf43926);
});
t('4.7 R2004 decompression: a literal run, then a back reference', () => {
  // 0x01: 4 literal bytes; 0x5C 0x00: copy 4 from 4 back (comp (0x5 - 1), offset 3 + 1), then
  // no literal (the next byte is the 0x11 end, so its run length is 0)
  const src = Uint8Array.of(0x01, 0x61, 0x62, 0x63, 0x64, 0x5c, 0x00, 0x11);
  const { out, n } = decompress18(src, 0, src.length, 8);
  assert.equal(new TextDecoder().decode(out.subarray(0, n)), 'abcdabcd');
});
t('4.7 R2004 decompression refuses a back reference before the start', () => {
  const src = Uint8Array.of(0x01, 0x61, 0x62, 0x63, 0x64, 0x5c, 0xff, 0x11);
  assert.throws(() => decompress18(src, 0, src.length, 8), /back reference out of range/);
});
t('5.10 R2007 decompression: a straight literal, a back reference, a shuffled literal (no corpus needed)', () => {
  // 0x00: a literal of 0 + 8 bytes (a run of 8 is stored in order); 0x47 0x03: copy 4 from 7 + 1
  // back (offset 7, + ((0x03 & 0xf8) << 1) + 1), then 0x03 & 7 = 3 literal bytes, which a run of 3
  // stores reversed ("ZYX" is "XYZ")
  const src = Uint8Array.of(0x00, ...new TextEncoder().encode('ABCDEFGH'), 0x47, 0x03, ...new TextEncoder().encode('ZYX'));
  const { out, n } = decompress21(src, 0, src.length, 15);
  assert.equal(new TextDecoder().decode(out.subarray(0, n)), 'ABCDEFGHABCDXYZ');
  // a stream starting inside a larger buffer reads the same
  const pad = Uint8Array.of(9, 9, ...src);
  assert.equal(new TextDecoder().decode(decompress21(pad, 2, src.length, 15).out), 'ABCDEFGHABCDXYZ');
});
t('5.10 R2007 decompression refuses a back reference before the start and a literal past the end', () => {
  const lit = new TextEncoder().encode('ABCDEFGH');
  // offset 9 + 1 = 10 back from byte 8
  assert.throws(() => decompress21(Uint8Array.of(0x00, ...lit, 0x49, 0x00), 0, 11, 16), /back reference out of range/);
  // the last literal claims 3 bytes and the stream ends after 1
  assert.throws(() => decompress21(Uint8Array.of(0x00, ...lit, 0x47, 0x03, 0x5a), 0, 12, 15), /literal past the end/);
  // and an output shorter than the stream says
  assert.throws(() => decompress21(Uint8Array.of(0x00, ...lit), 0, 9, 4), /literal past the end/);
});
// a bit string for an object's data, as the spec writes it: RD as its 8 little-endian bytes,
// RC and a BS's payload MSB first
const b8 = (n) => n.toString(2).padStart(8, '0');
const rd = (x) => { const v = new Uint8Array(new Float64Array([x]).buffer); return [...v].map(b8).join(''); };
const tv = (s) => `01${b8(s.length)}${[...s].map((c) => b8(c.charCodeAt(0))).join('')}`; // T to R2004: BS (8-bit form) + bytes
// a per-type decoder (20.4.x) run on bits alone: the handle stream stubbed (owner, style)
const decodeData = (type, v, s) => {
  const o = { h: { Ha: () => 0 } };
  _internal.DECODE[type].call({ entityHandles() {} }, o, new Bits(bits(s), v), v);
  return o.d;
};
t('T (to R2004): \\U+XXXX decoded, but not after an escaped backslash (a typed "\\\\U+00B0" stays text, as its DXF keeps it)', () => {
  assert.equal(new Bits(bits(tv('45\\U+00B0')), 15).T(), '45°');
  assert.equal(new Bits(bits(tv('C:\\\\U+00B0')), 15).T(), 'C:\\\\U+00B0');
});
t('20.4.32 3DFACE, R14: four 3BD corners and the invisible-edge flags', () => {
  // corners (0,0,0) (1,0,0) (1,1,0) (0,1,0) as BD codes (10 = 0.0, 01 = 1.0); flags BS 01 + 5
  const d = decodeData('3DFACE', 14, '101010 011010 010110 100110 01' + b8(5));
  assert.deepEqual(d, { c: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], flags: 5 });
});
t('20.4.32 3DFACE, R2000+: the first corner raw, each next as DDs on the one before', () => {
  // no flags, z zero; (2.5, -1); then x 11+RD(4), y 00, z 00; x 00, y 11+RD(3), z 00; x 11+RD(2.5), y 00, z 00
  const s = `1 1 ${rd(2.5)} ${rd(-1)} 11${rd(4)} 00 00  00 11${rd(3)} 00  11${rd(2.5)} 00 00`;
  assert.deepEqual(decodeData('3DFACE', 15, s), { c: [[2.5, -1, 0], [4, -1, 0], [4, 3, 0], [2.5, 3, 0]], flags: 0 });
});
t('20.4.3 TEXT, R2000+: with no alignment point stored (DataFlags 0x02), it is 0,0 -- as the keys write it, not the insertion point', () => {
  // DataFlags FF: every optional field absent, the alignment point (0x02) among them
  const d = decodeData('TEXT', 15, `11111111 ${rd(5)} ${rd(6)} 1 1 ${rd(2.5)} ${tv('T')}`);
  assert.deepEqual([d.p, d.a], [[5, 6], [0, 0]]);
});
t('20.4.4 ATTRIB, R2000: the text data, then its tag and flags (1: invisible)', () => {
  // DataFlags FF (no elevation, alignment, oblique, rotation, width, generation, alignments);
  // insertion (5, 6); extrusion default (B 1); thickness 0 (B 1); height 2.5; text; tag; BS 0; RC 1
  const d = decodeData('ATTRIB', 15, `11111111 ${rd(5)} ${rd(6)} 1 1 ${rd(2.5)} ${tv('PN1')} ${tv('TAG')} 10 ${b8(1)}`);
  assert.deepEqual([d.p, d.h, d.text, d.tag, d.flags], [[5, 6], 2.5, 'PN1', 'TAG', 1]);
});
t('pairsToDXF before R2007: non-ASCII as \\U+XXXX, so the file read back as BYTES in its named code page gives the text again', () => {
  const P = [[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [9, '$DWGCODEPAGE'], [3, 'ANSI_1252'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'], [0, 'LAYER'], [2, 'Möbel'], [70, '0'], [62, '7'], [6, 'CONTINUOUS'], [0, 'ENDTAB'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, 'Möbel'], [10, '0'], [20, '0'], [40, '1'], [1, '135.00°'], [0, 'ENDSEC'], [0, 'EOF']];
  const s = pairsToDXF(P);
  assert.ok(/135\.00\\U\+00B0/.test(s), 'escaped');
  const u8 = new TextEncoder().encode(s);
  const d = parseDXF(u8.buffer);
  assert.equal(d.texts[0].text, '135.00°');
  assert.equal(d.texts[0].layer, 'Möbel');
  assert.ok(d.layers.some((l) => l.name === 'Möbel'));
  // from R2007 the file is UTF-8: written as itself
  assert.ok(pairsToDXF(P.map(([c, v]) => (v === 'AC1015' ? [c, 'AC1021'] : [c, v]))).includes('135.00°'));
});
t('an MTEXT font code naming a non-ASCII font survives the \\U+XXXX escape: the code is still stripped, not drawn', () => {
  const P = [[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1014'], [9, '$DWGCODEPAGE'], [3, 'ANSI_936'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'MTEXT'], [8, '0'], [10, '0'], [20, '0'], [40, '1'], [1, '{\\f宋体|b0|i0|c134|p49;平面}'], [0, 'ENDSEC'], [0, 'EOF']];
  const s = pairsToDXF(P);
  assert.ok(/\\U\+5B8B/.test(s), 'the font name was escaped');
  const d = parseDXF(new TextEncoder().encode(s).buffer);
  assert.deepEqual(d.texts.map((x) => x.text), parseDXF(P).texts.map((x) => x.text));
  assert.equal(d.texts[0].text, '平面');
});
t('pairsToDXF writes control characters and carets in caret notation, and parseDXF reads them back', () => {
  const P = [[0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, '0'], [10, '0'], [20, '0'], [40, '1'], [1, 'a\x03b^c'], [0, 'ENDSEC'], [0, 'EOF']];
  const s = pairsToDXF(P);
  assert.ok(s.includes('a^Cb^ c'), 'caret notation');
  assert.equal(parseDXF(s).texts[0].text, parseDXF(P).texts[0].text);
});

t('an R2000 file header listing 0xffffffff sections is refused at once, in words', () => {
  const b = new Uint8Array(0x400);
  b.set(new TextEncoder().encode('AC1015'));
  new DataView(b.buffer).setUint32(0x15, 0xffffffff, true);
  const t0 = Date.now();
  assert.throws(() => readDWG(b), /a damaged DWG: its file header lists 4294967295 sections/);
  assert.ok(Date.now() - t0 < 1000);
});

// A crafted R2000 file (review round 3): an object map listing E entries at one POINT whose reactor
// count is 0x7fffffff, then P zero bytes. Its reads used to stop only at the file's end, once per
// map entry: 20,000 entries over 1 MB took 107 s.
function crafted(E, P) {
  class BW { constructor() { this.bits = []; } put(v, n) { for (let k = n - 1; k >= 0; k--) this.bits.push((v >> k) & 1); } rc(x) { this.put(x & 255, 8); }
    rl(x) { for (let k = 0; k < 4; k++) this.rc((x >>> (8 * k)) & 255); }
    bytes() { const out = new Uint8Array(Math.ceil(this.bits.length / 8)); this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); }); return out; } }
  const mcs = (v) => { const out = []; while (v >= 0x40) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } out.push(v & 0x3f); return out; };
  const handlesAt = 0x300;
  const chunks = [];
  for (let left = E; left > 0; left -= 2000) chunks.push(Math.min(2000, left));
  const objAt = handlesAt + chunks.reduce((s, n) => s + 2 + 2 * n + 8 + 2, 0) + 4 + 64;
  const handleBytes = [];
  for (const n of chunks) {
    const body = [0x01, ...mcs(objAt)];
    for (let k = 1; k < n; k++) body.push(0x01, 0x00);
    const size = body.length + 2;
    handleBytes.push((size >> 8) & 255, size & 255, ...body, 0, 0);
  }
  handleBytes.push(0, 2);
  const w = new BW();
  w.put(0b01, 2); w.rc(27); w.rl(256); w.rc(0x01); w.rc(0x10); w.put(0b10, 2); w.put(0, 1); w.put(0b00, 2);
  w.put(0b00, 2); w.rl(0x7fffffff); // reactors
  w.put(1, 1); w.put(0b10, 2); w.put(0b01, 2); w.put(0, 2); w.put(0, 2); w.put(0b10, 2); w.rc(0);
  w.put(0b10, 2); w.put(0b10, 2); w.put(0b10, 2); w.put(1, 1); w.put(1, 1); w.put(0b10, 2);
  const b = new Uint8Array(objAt + 2 + 64 + 2 + P);
  b.set(new TextEncoder().encode('AC1015'), 0);
  b[0x13] = 30;
  const dv = new DataView(b.buffer);
  dv.setUint32(0x15, 3, true);
  const rec = (k, num, at, size) => { b[0x19 + 9 * k] = num; dv.setUint32(0x19 + 9 * k + 1, at, true); dv.setUint32(0x19 + 9 * k + 5, size, true); };
  rec(0, 0, 0x100, 0x40); rec(1, 1, 0x200, 0x40); rec(2, 2, handlesAt, handleBytes.length);
  b.set(handleBytes, handlesAt);
  dv.setUint16(objAt, 64, true);
  b.set(w.bytes(), objAt + 2);
  return b;
}
t('R2004: a page map claiming 0x7fffffff bytes is refused before it is checksummed', () => {
  const b = new Uint8Array(0x400);
  b.set(new TextEncoder().encode('AC1018'), 0);
  const h = new Uint8Array(0x6c);
  h.set(new TextEncoder().encode('AcFssFcAJMB'), 0);
  new DataView(h.buffer).setUint32(0x54, 0x100, true);
  let seed = 1;
  for (let i = 0; i < 0x6c; i++) { seed = (Math.imul(seed, 0x343fd) + 0x269ec3) | 0; b[0x80 + i] = h[i] ^ ((seed >>> 16) & 0xff); }
  const dv = new DataView(b.buffer);
  dv.setUint32(0x200, 0x41630e3b, true); dv.setUint32(0x204, 16, true); dv.setUint32(0x208, 0x7fffffff, true);
  const t0 = Date.now();
  assert.throws(() => readDWG(b), /a damaged DWG: a system page of 2147483647 bytes runs past the end of the file/);
  assert.ok(Date.now() - t0 < 500);
});
t('R2007: a page map of 1e9 bytes is refused before its blocks are allocated', () => {
  const b = new Uint8Array(0x1000);
  b.set(new TextEncoder().encode('AC1021'), 0);
  const fh = new Uint8Array(3 * 239);
  const fdv = new DataView(fh.buffer);
  fdv.setInt32(0x18, -0x110, true);
  const set64 = (o, v) => { fdv.setUint32(0x20 + o, v % 2 ** 32, true); fdv.setUint32(0x20 + o + 4, Math.floor(v / 2 ** 32), true); };
  set64(0, 0x70); set64(0x18, 1); set64(0x38, 0); set64(0x50, 1e9); set64(0x58, 16);
  for (let bl = 0; bl < 3; bl++) for (let j = 0; j < 239; j++) b[0x80 + j * 3 + bl] = fh[bl * 239 + j];
  const t0 = Date.now();
  assert.throws(() => readDWG(b), /a damaged DWG: \d+ Reed-Solomon blocks at 0x480 run past the end of the file/);
  assert.ok(Date.now() - t0 < 500);
});
t('an object map pointing 32,000 times into one long run of 0xff: each size is two words at most, fast', () => {
  // an R2000 file whose map's 32,000 entries land 2 bytes apart in a 64 KB run of 0xff: each
  // size read ran the run to its end, and its CRC over the rest (128 KB: 22.6 s)
  const N = 32000, L = 2 * N + 16, R = 0x200;
  const mcs = (v) => { const out = []; while (v >= 0x40) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } out.push(v & 0x3f); return out; };
  const mcsU = (v) => { const out = []; while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } out.push(v); return out; };
  const hs = [];
  let left = N, loc0 = R, handle = 1;
  while (left > 0) {
    const n = Math.min(left, 30000); left -= n;
    const body = [...mcsU(handle), ...mcs(loc0)];
    for (let k = 1; k < n; k++) body.push(0x01, 0x02);
    handle += n; loc0 += 2 * n;
    const size = body.length + 2;
    hs.push((size >> 8) & 255, size & 255, ...body, 0, 0);
  }
  hs.push(0, 2, 0, 0);
  const M = R + L + 64;
  const b = new Uint8Array(M + hs.length + 64);
  b.set(new TextEncoder().encode('AC1015'), 0);
  b[0x15] = 3;
  const dv = new DataView(b.buffer);
  const loc = (k, at, size) => { const o = 0x19 + 9 * k; b[o] = k; dv.setUint32(o + 1, at, true); dv.setUint32(o + 5, size, true); };
  loc(0, 0x140, 0x40); loc(1, 0x100, 0x20); loc(2, M, hs.length);
  b.fill(0xff, R, R + L);
  b.set(hs, M);
  const t0 = Date.now();
  const d = readDWG(b);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.equal(d.objects.size, 0);
});
// A crafted R2004 file (review round 5): a section map listing one data page COUNT times, each
// listing checksumming the whole page again (2,000 x 1 MB: 38 s)
function r2004Repeat(COUNT, P1) {
  const lit = (d) => {
    const L = d.length, head = [];
    if (L >= 3 && L <= 0x12) head.push(L - 3);
    else { let r = L - 3 - 0x0f; head.push(0); while (r > 255) { head.push(0); r -= 255; } head.push(r); }
    const out = new Uint8Array(head.length + L + 1);
    out.set(head, 0); out.set(d, head.length); out[out.length - 1] = 0x11;
    return out;
  };
  const u64 = (dv, o, v) => { dv.setUint32(o, v % 2 ** 32, true); dv.setUint32(o + 4, Math.floor(v / 2 ** 32), true); };
  const smd = new Uint8Array(0x14 + 0x60 + 16 * COUNT);
  const sdv = new DataView(smd.buffer);
  sdv.setUint32(0, 1, true);
  let o = 0x14;
  u64(sdv, o, P1 - 32); sdv.setUint32(o + 8, COUNT, true); sdv.setUint32(o + 0x0c, P1 - 32, true); sdv.setUint32(o + 0x14, 1, true);
  smd.set(new TextEncoder().encode('AcDb:AcDbObjects'), o + 0x20);
  o += 0x60;
  for (let p = 0; p < COUNT; p++) { sdv.setUint32(o, 1, true); sdv.setUint32(o + 4, P1 - 32, true); o += 16; }
  const smc = lit(smd);
  const S2 = 0x14 + smc.length;
  const pmd = new Uint8Array(24);
  const pdv = new DataView(pmd.buffer);
  pdv.setInt32(0, 1, true); pdv.setUint32(4, P1, true); pdv.setInt32(8, 2, true); pdv.setUint32(12, S2, true); pdv.setInt32(16, 3, true); pdv.setUint32(20, 0x100, true);
  const pmc = lit(pmd);
  const b = new Uint8Array(0x100 + P1 + S2 + 0x14 + pmc.length + 64);
  const dv = new DataView(b.buffer);
  b.set(new TextEncoder().encode('AC1018'), 0);
  const h = new Uint8Array(0x6c);
  const hdv = new DataView(h.buffer);
  h.set(new TextEncoder().encode('AcFssFcAJMB'), 0);
  u64(hdv, 0x54, P1 + S2);
  hdv.setUint32(0x5c, 2, true);
  let seed = 1;
  for (let i = 0; i < 0x6c; i++) { seed = (Math.imul(seed, 0x343fd) + 0x269ec3) | 0; b[0x80 + i] = h[i] ^ ((seed >>> 16) & 0xff); }
  const mask = (0x4164536b ^ 0x100) >>> 0;
  const ph = new Uint8Array(32); const phv = new DataView(ph.buffer);
  phv.setUint32(0, 0x4163043b, true); phv.setUint32(8, P1 - 32, true);
  for (let k = 0; k < 32; k += 4) dv.setUint32(0x100 + k, (phv.getUint32(k, true) ^ mask) >>> 0, true);
  const at2 = 0x100 + P1;
  dv.setUint32(at2, 0x4163003b, true); dv.setUint32(at2 + 4, smd.length, true); dv.setUint32(at2 + 8, smc.length, true);
  b.set(smc, at2 + 0x14);
  const at3 = at2 + S2;
  dv.setUint32(at3, 0x41630e3b, true); dv.setUint32(at3 + 4, pmd.length, true); dv.setUint32(at3 + 8, pmc.length, true);
  b.set(pmc, at3 + 0x14);
  return b;
}
t('R2004: a section listing one page 2,000 times is refused at once, by name', () => {
  const t0 = Date.now();
  assert.throws(() => readDWG(r2004Repeat(2000, 1 << 20)), /a damaged DWG: section AcDb:AcDbObjects lists page 1 twice/);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});
t('an R2000 classes section running past the end of the file: a damaged DWG, said as one', () => {
  const b = new Uint8Array(0x400);
  b.set(new TextEncoder().encode('AC1015'), 0);
  b[0x13] = 30;
  const dv = new DataView(b.buffer);
  dv.setUint32(0x15, 3, true);
  const rec = (k, num, at, size) => { b[0x19 + 9 * k] = num; dv.setUint32(0x19 + 9 * k + 1, at, true); dv.setUint32(0x19 + 9 * k + 5, size, true); };
  rec(0, 0, 0x100, 0x40); rec(1, 1, 0x3e0, 0x40); rec(2, 2, 0x300, 0x10);
  dv.setUint32(0x3f0, 0x100, true);
  b[0x300] = 0; b[0x301] = 2;
  assert.throws(() => readDWG(b), /^Error: a damaged DWG: its classes cannot be read/);
});
t('an object\'s count past its own end stops at the object, and a map naming it 20,000 times reads it once', () => {
  const t0 = Date.now();
  const d = readDWG(crafted(20000, 1000000));
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  const o = [...d.objects.values()][0];
  assert.match(o.error || '', /past the end of the object/);
  assert.ok(d.failures.some((x) => x.startsWith('object handle matches the map')), JSON.stringify(d.failures));
});

t('a class list numbered with a gap (a record misread) is a failed check, not a silent pass', () => {
  // an R2004 classes section: maxClass, then records num / flags / app / cpp / dxf / zombie / item
  // and the R2004 tail (BL BS BS BL BL)
  const bs16 = (n) => `00${b8(n & 255)}${b8(n >> 8)}`;
  const rec = (num, name) => `${bs16(num)} 10 ${tv('A')} ${tv('B')} ${tv(name)} 0 ${bs16(0x1f2)} 10 10 10 10 10`;
  const section = (max, recs) => {
    const data = bits(`${bs16(max)} ${b8(0)} ${b8(0)} 0 ${recs.join(' ')}`);
    const b = new Uint8Array(20 + data.length + 2);
    new DataView(b.buffer).setUint32(16, data.length, true);
    b.set(data, 20);
    return b;
  };
  const run = (max, recs) => { const chk = new _internal.Checks(); const cl = _internal.readClasses({ b: section(max, recs), at: 0 }, 18, 0, chk); return { cl, f: chk.failures }; };
  const good = run(501, [rec(500, 'X'), rec(501, 'Y')]);
  assert.deepEqual([...good.cl.keys()], [500, 501]);
  assert.ok(!good.f.some((x) => x.startsWith('classes numbered') || x.startsWith('classes reach')), good.f.join('; '));
  const gap = run(502, [rec(500, 'X'), rec(502, 'Y')]);
  assert.ok(gap.f.some((x) => x.startsWith('classes numbered 500 on without a gap')), gap.f.join('; '));
  const short = run(503, [rec(500, 'X'), rec(501, 'Y')]);
  assert.ok(short.f.some((x) => x.startsWith('classes reach the stated last class number')), short.f.join('; '));
});

t('a class record\'s R2004+ tail is five BLs: a version over 255 does not throw the next record off', () => {
  // BL 0 (10), then a 32-bit BL (00 + 4 bytes) of 0x1234 as the version, BL 0 x 3, then the marker 1
  const bl32 = (n) => `00${[0, 1, 2, 3].map((k) => b8((n >>> (8 * k)) & 255)).join('')}`;
  for (const v of [18, 21, 24, 32]) {
    const r = new _internal.Bits(bits(`10 ${bl32(0x1234)} 10 10 10 1`), v, 0);
    _internal.classTail(r, v);
    assert.equal(r.B(), 1, `R${v}: the bit after the tail`);
  }
});
t('an entity kind not decoded passes through the adapter by name and layer, and is counted as not drawn', () => {
  // the objects readDWG gives: model space, a layer, and one head-only entity of a custom class
  const objects = new Map([
    [1, { handle: 1, name: 'BLOCK_RECORD', decoded: true, d: { name: '*Model_Space', base: [0, 0, 0], entities: [3] } }],
    [2, { handle: 2, name: 'LAYER', decoded: true, d: { name: 'WALLS', colour: { aci: 7 }, flags: 0 } }],
    [3, { handle: 3, name: 'AEC_WALL', headOnly: true, e: { entmode: 2, owner: 1, layer: 2, colour: { aci: 256 }, ltscale: 1, ltflags: 0, lw: -1, invisible: 0 } }],
  ]);
  const P = dwgToPairs({ objects, header: {}, v: 15, version: 'AC1015', encoding: 'windows-1252', codepage: 30 });
  const k = P.findIndex(([c, v]) => c === 0 && v === 'AEC_WALL');
  assert.ok(k >= 0, 'named');
  assert.deepEqual(parseDXF(P).notDrawn, { AEC_WALL: 1 });
});

t('the head-only decision: a custom entity class and an R2010+ table are read to their common part; an object class is not; a failure is counted', () => {
  const read = (name, type, v, entity = () => {}) => {
    const chk = new _internal.Checks();
    const self = { v, chk, classes: new Map([[500, { item: 0x1f2, dxf: 'AEC_WALL' }], [501, { item: 0x1f3, dxf: 'AEC_STYLE' }], [502, { item: 0x1f2, dxf: 'ACAD_TABLE' }]]),
      open: () => ({ name, type, r: {}, h: {} }), entity: (o) => { entity(o); o.e = { owner: 1 }; }, entityHandles: () => {} };
    self.isEntityType = _internal.ObjectReader.prototype.isEntityType;
    const o = _internal.ObjectReader.prototype.read.call(self, 0);
    return { o, f: chk.failures };
  };
  assert.equal(read('AEC_WALL', 500, 32).o.headOnly, true, 'a custom entity class');
  assert.equal(read('AEC_STYLE', 501, 32).o.headOnly, undefined, 'an object class');
  assert.equal(read('ACAD_TABLE', 502, 24).o.headOnly, true, 'an R2010+ table');
  assert.equal(read('LEADER', 45, 15).o.headOnly, true, 'a fixed entity type not decoded');
  const bad = read('AEC_WALL', 500, 32, () => { throw new Error('read past the end'); });
  assert.ok(bad.o.error && !bad.o.headOnly && bad.f.some((x) => x.startsWith('decode AEC_WALL')), JSON.stringify(bad));
});
t('round 17: a missing block, a multi-line ATTRIB, a viewport and the active layout reach the page', () => {
  const E = (owner, extra = {}) => ({ entmode: 0, owner, layer: 2, colour: { aci: 256 }, ltscale: 1, ltflags: 0, lw: -1, invisible: 0, ...extra });
  const objects = new Map([
    [1, { handle: 1, name: 'BLOCK_RECORD', decoded: true, d: { name: '*Model_Space', base: [0, 0, 0], entities: [10, 11, 12] } }],
    [2, { handle: 2, name: 'LAYER', decoded: true, d: { name: '0', colour: { aci: 7 }, flags: 0 } }],
    [3, { handle: 3, name: 'BLOCK_RECORD', decoded: true, d: { name: 'B', base: [0, 0, 0], entities: [13] } }],
    // two records named *Paper_Space: the block table says 5 is the active one
    [4, { handle: 4, name: 'BLOCK_RECORD', decoded: true, d: { name: '*Paper_Space', base: [0, 0, 0], entities: [20, 21] } }],
    [5, { handle: 5, name: 'BLOCK_RECORD', decoded: true, d: { name: '*Paper_Space', base: [0, 0, 0], entities: [22, 23] } }],
    [6, { handle: 6, name: 'BLOCK_CONTROL', decoded: true, d: { n: 1, model: 1, paper: 5 } }],
    [10, { handle: 10, name: 'INSERT', decoded: true, e: E(1), d: { block: 99, p: [0, 0, 0], s: [1, 1, 1], rot: 0 } }],
    [11, { handle: 11, name: 'INSERT', decoded: true, e: E(1), d: { block: 3, p: [0, 0, 0], s: [1, 1, 1], rot: 0, atts: true } }],
    [12, { handle: 12, name: 'ATTRIB', decoded: true, e: E(11), d: { multi: true } }],
    [13, { handle: 13, name: 'LINE', decoded: true, e: E(3), d: { p0: [0, 0, 0], p1: [10, 0, 0] } }],
    // each layout: its paper view (first), then a viewport onto model (0..10) at 1:1
    ...[[4, 20, 21], [5, 22, 23]].flatMap(([own, a, b]) => [
      [a, { handle: a, name: 'VIEWPORT', decoded: true, e: E(own), d: { c: [148, 105, 0], w: 297, h: 210, vh: 210, vc: [148, 105], target: [0, 0, 0], twist: 0 } }],
      [b, { handle: b, name: 'VIEWPORT', decoded: true, e: E(own), d: { c: [50, 50, 0], w: 20, h: 20, vh: 20, vc: [5, 0], target: [0, 0, 0], twist: 0 } }]]),
  ]);
  const dwg = { objects, header: {}, v: 15, version: 'AC1015', encoding: 'windows-1252', codepage: 30 };
  const dr = drawDWG(dwg);
  assert.deepEqual(dr.notDrawn, { INSERT: 1, 'ATTRIB (multi-line)': 1 });
  assert.equal(dr.layouts.length, 2, 'the active layout and *Paper_Space0');
  for (const l of dr.layouts) {
    assert.equal(l.paths.filter((p) => p.frame).length, 1, 'one viewport frame (the paper view is not one)');
    assert.ok(l.paths.some((p) => !p.frame && p.pts[0] >= 40 && p.pts[0] <= 60), 'model space seen through it');
  }
});

// --- an entity kind not decoded reaches the page as "not drawn", by its common part (DWG_LEADER_FILE:
// an R14 / R2000 drawing holding leaders; their count and the page's "not drawn" must agree) ---
{
  const p = process.env.DWG_LEADER_FILE || '';
  if (!p || !existsSync(p)) skip('a DWG\'s leaders counted as not drawn', 'DWG_LEADER_FILE unset or absent');
  else t('a DWG\'s leaders, not decoded, are counted as not drawn (they vanished without a word)', () => {
    const d = readDWG(new Uint8Array(readFileSync(p)));
    const n = [...d.objects.values()].filter((o) => o.name === 'LEADER').length;
    assert.ok(n > 0, 'the file holds leaders');
    assert.equal(parseDXF(dwgToPairs(d)).notDrawn.LEADER, n);
  });
}

// --- the checks, two-sided, on real files ---
const root = process.env.DWG_CORPUS || '';
const files = { R14: 'example_r14.dwg', R2000: 'example_2000.dwg', R2004: 'example_2004.dwg', R2007: 'example_2007.dwg', R2010: 'example_2010.dwg', R2013: 'example_2013.dwg', R2018: 'example_2018.dwg' };
for (const [rel, f] of Object.entries(files)) {
  const p = `${root}/${f}`;
  if (!existsSync(p)) { skip(`${rel}: the file arms`, `${f} absent (set DWG_CORPUS)`); continue; }
  const b = new Uint8Array(readFileSync(p));
  t(`${rel}: every check passes and the drawing reaches parseDXF`, () => {
    const d = readDWG(b);
    assert.deepEqual(d.failures, [], d.failures.join('; '));
    assert.equal(d.version, { R14: 'AC1014', R2000: 'AC1015', R2004: 'AC1018', R2007: 'AC1021', R2010: 'AC1024', R2013: 'AC1027', R2018: 'AC1032' }[rel]);
    const dr = parseDXF(dwgToPairs(d));
    assert.ok(dr.paths.length > 50, `${dr.paths.length} paths`);
    // these examples are in millimetres; R13-R14 headers do not store $INSUNITS (from R2000)
    assert.equal(dr.insunits, rel === 'R14' ? 0 : 4);
  });
  if (rel === 'R14' || rel === 'R2000') {
    t(`${rel}: a byte changed inside an object fails that object's CRC (must fire)`, () => {
      const d = readDWG(b);
      const line = [...d.objects.values()].find((o) => o.name === 'LINE');
      const bad = b.slice();
      bad[line.at + 6] ^= 0x10; // inside its data, past the size
      const d2 = readDWG(bad);
      assert.ok(d2.checks['object CRC'].fail >= 1, 'no CRC failure');
      assert.ok(d2.failures.some((x) => x.startsWith('object CRC')));
    });
  }
  if (rel === 'R2004') {
    t('R2004: a byte changed in the encrypted file header fails its CRC-32 (must fire)', () => {
      const bad = b.slice();
      bad[0x80 + 0x30] ^= 0x01;
      // the file still opens (one byte of the header's padding) and the CRC-32 says it changed;
      // any throw, an engine message included, fails this arm
      const d2 = readDWG(bad);
      assert.ok(d2.failures.some((x) => x.startsWith('file header CRC-32')), JSON.stringify(d2.failures));
    });
  }
  if (rel === 'R2007') {
    t('R2007: a truncated file is refused, not drawn from garbage (must fire)', () => {
      assert.throws(() => readDWG(b.slice(0, Math.floor(b.length / 3))), /^Error: a damaged (or truncated )?DWG/);
    });
  }
}
t('not a DWG, and a pre-R13 DWG, are refused by name', () => {
  assert.throws(() => readDWG(new TextEncoder().encode('hello world')), /not a DWG file/);
  assert.throws(() => readDWG(new TextEncoder().encode('AC1009 an R12 drawing')), /AC1009 DWG \(older than R13\) is not read/);
});
done();
