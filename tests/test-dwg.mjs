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
import { readDWG, dwgToPairs, pairsToDXF, decompress18, _internal, crc16, crc32 } from '../js/dwg.js';
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
      assert.throws(() => readDWG(b.slice(0, Math.floor(b.length / 3))), /^Error: a damaged or truncated DWG/);
    });
  }
}
t('not a DWG, and a pre-R13 DWG, are refused by name', () => {
  assert.throws(() => readDWG(new TextEncoder().encode('hello world')), /not a DWG file/);
  assert.throws(() => readDWG(new TextEncoder().encode('AC1009 an R12 drawing')), /AC1009 DWG \(older than R13\) is not read/);
});
done();
