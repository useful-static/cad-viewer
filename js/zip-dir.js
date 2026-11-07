// A zip's central directory: the one reading of it, for the page's unzip (js/mesh-formats.js) and
// the list check (js/list-check.js), which kept a reader of its own and was silent on a zip64
// archive the page refuses (r75 A4).
//
// zipDirectory(tail, tailAt, len, readAt?) -> [{ name, method, csize, usize, lho }]
//   tail: bytes ending at the archive's end (the whole file, or its last 64 KB and more), from
//   offset tailAt of an archive of len bytes; the directory read from it, or -- when it starts
//   before the tail -- from readAt(offset, n) (async, the list check's range request). Every
//   offset is checked against the archive's size: a broken zip is refused as "damaged". Refusals
//   are the page's own words.

export const ZIP_TAIL = 65557; // (the end record and its longest comment)

export async function zipDirectory(tail, tailAt, len, readAt = null) {
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const need = (at, n, what) => { if (!(at >= 0 && at + n <= len)) throw new Error(`a damaged zip (${what} lies outside the file)`); };
  // the end of central directory record, searched back from the end
  let e = -1;
  for (let i = tail.length - 22; i >= Math.max(0, tail.length - ZIP_TAIL); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('not a zip file (no central directory)');
  const n = dv.getUint16(e + 10, true);
  const size = dv.getUint32(e + 12, true);
  const o0 = dv.getUint32(e + 16, true);
  if (o0 === 0xffffffff || n === 0xffff) throw new Error('a zip64 archive, which this viewer does not read');
  need(o0, size, 'its central directory');
  let cd;
  if (o0 >= tailAt) cd = tail.subarray(o0 - tailAt);
  else if (readAt) cd = await readAt(o0, size);
  else throw new Error('a damaged zip (its central directory lies outside the file)');
  const c = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out = [];
  let o = 0;
  for (let i = 0; i < n; i++) {
    if (!(o + 46 <= cd.length)) throw new Error('a damaged zip (a directory entry lies outside the file)');
    if (c.getUint32(o, true) !== 0x02014b50) throw new Error('a damaged zip central directory');
    const method = c.getUint16(o + 10, true);
    const csize = c.getUint32(o + 20, true), usize = c.getUint32(o + 24, true);
    const nlen = c.getUint16(o + 28, true), xlen = c.getUint16(o + 30, true), clen = c.getUint16(o + 32, true);
    const lho = c.getUint32(o + 42, true);
    if (!(o + 46 + nlen <= cd.length)) throw new Error('a damaged zip (an entry name lies outside the file)');
    const name = new TextDecoder().decode(cd.subarray(o + 46, o + 46 + nlen));
    need(lho, 30, `${name}'s header`);
    out.push({ name, method, csize, usize, lho });
    o += 46 + nlen + xlen + clen;
  }
  return out;
}

// An entry's data: where it starts, from its local header's 30 bytes (head) -- its name and extra
// lengths there, which may differ from the directory's
export const entryDataAt = (lho, head) => {
  const d = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return lho + 30 + d.getUint16(26, true) + d.getUint16(28, true);
};
