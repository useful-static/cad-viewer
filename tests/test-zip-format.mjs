#!/usr/bin/env node
// The zip FORMAT, byte by byte, both ways, against an independent reader (node:zlib and a field walk
// written here, not the viewer's own zip-dir.js):
//  - what js/export-mesh.js zip() writes (the 3MF container): every local header's method is
//    deflate (8) at byte 8, its CRC at byte 14 is that of the data it holds, its sizes are the
//    data's; the end record's central directory size and offset are the directory's own. unzip and
//    Python refuse a file where any of these is off (round 115's mutants export-mesh-O90, O91, O92,
//    O111, survivors of every other test: the viewer's reader takes the central directory only);
//  - what js/zip-dir.js zipDirectory reads: a central directory whose entries carry an extra field
//    and an entry comment, as Info-ZIP's zip writes (extended timestamp) and `zip -c` adds -- both
//    entries named, in order (round 115's zip-dir-O22, O23: a length read one byte late refused
//    every such zip as damaged).
//
//   node tests/test-zip-format.mjs
import assert from 'node:assert/strict';
import { inflateRawSync, crc32 as zcrc } from 'node:zlib';
import { zip } from '../js/export-mesh.js';
import { zipDirectory } from '../js/zip-dir.js';
import { test, done } from './harness.mjs';

// a standard CRC-32, if this Node's zlib has none (crc32 is new in Node 22)
const crcOf = zcrc || ((u8) => {
  let c = ~0;
  for (const b of u8) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
});

await test('export-mesh zip(): each local header deflate at byte 8 with its data\'s CRC and sizes; the end record sizes the central directory (r116: r115 export-mesh-O90, O91, O92, O111)', async () => {
  const enc = new TextEncoder();
  const files = [['3D/3dmodel.model', enc.encode('<model>'.repeat(200))], ['[Content_Types].xml', [enc.encode('<Types>'), enc.encode('</Types>')]]];
  const z = await zip(files);
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let o = 0;
  for (const [name, entry] of files) {
    const raw = Array.isArray(entry) ? Buffer.concat(entry) : Buffer.from(entry);
    assert.equal(dv.getUint32(o, true), 0x04034b50, `${name}: a local header`);
    assert.equal(dv.getUint16(o + 8, true), 8, `${name}: method deflate at byte 8`);
    const crc = dv.getUint32(o + 14, true), csize = dv.getUint32(o + 18, true), usize = dv.getUint32(o + 22, true);
    const nlen = dv.getUint16(o + 26, true), xlen = dv.getUint16(o + 28, true);
    assert.equal(new TextDecoder().decode(z.subarray(o + 30, o + 30 + nlen)), name);
    const data = z.subarray(o + 30 + nlen + xlen, o + 30 + nlen + xlen + csize);
    const out = inflateRawSync(data);
    assert.equal(out.length, usize, `${name}: its size`);
    assert.ok(out.equals(raw), `${name}: its data`);
    assert.equal(crc, crcOf(out), `${name}: its CRC at byte 14`);
    o += 30 + nlen + xlen + csize;
  }
  let e = -1;
  for (let i = z.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  assert.ok(e > 0, 'an end record');
  const cdSize = dv.getUint32(e + 12, true), cdAt = dv.getUint32(e + 16, true);
  assert.equal(cdAt, o, 'the central directory starts after the last entry');
  assert.equal(cdAt + cdSize, e, 'its size reaches the end record exactly');
  assert.equal(dv.getUint16(e + 10, true), files.length);
});

await test('zip-dir zipDirectory: entries carrying an extra field and an entry comment are both read, in order (r116: r115 zip-dir-O22, O23)', async () => {
  const enc = new TextEncoder();
  const names = ['a.stl', 'b/c.stl'];
  const extra = Uint8Array.of(0x55, 0x54, 5, 0, 3, 1, 2, 3, 4); // UT: an extended timestamp, as Info-ZIP writes
  const comment = enc.encode('entry comment');
  const body = enc.encode('solid x\nendsolid x\n');
  const parts = [], central = [];
  let off = 0;
  for (const nm of names) {
    const n8 = enc.encode(nm);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 10, true); lh.setUint32(14, crcOf(body), true);
    lh.setUint32(18, body.length, true); lh.setUint32(22, body.length, true); lh.setUint16(26, n8.length, true); lh.setUint16(28, extra.length, true);
    parts.push(new Uint8Array(lh.buffer), n8, extra, body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 0x031e, true); cd.setUint16(6, 10, true); cd.setUint32(16, crcOf(body), true);
    cd.setUint32(20, body.length, true); cd.setUint32(24, body.length, true); cd.setUint16(28, n8.length, true);
    cd.setUint16(30, extra.length, true); cd.setUint16(32, comment.length, true); cd.setUint32(42, off, true);
    central.push(new Uint8Array(cd.buffer), n8, extra, comment);
    off += 30 + n8.length + extra.length + body.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, names.length, true); end.setUint16(10, names.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const z = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { z.set(p, o); o += p.length; }
  const got = await zipDirectory(z, 0, z.length);
  assert.deepEqual(got.map((x) => x.name), names);
  assert.deepEqual(got.map((x) => x.lho), [0, 30 + 5 + extra.length + body.length]);
});

done();
