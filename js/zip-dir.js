// A zip's central directory: the one reading of it, for the page's unzip (js/mesh-formats.js) and
// the list check (js/list-check.js), which kept a reader of its own and was silent on a zip64
// archive the page refuses (r75 A4).
//
// zipDirectory(tail, tailAt, len, readAt?) -> [{ name, key, method, flags, csize, usize, lho }]
//   tail: bytes ending at the archive's end (the whole file, or its last 64 KB and more), from
//   offset tailAt of an archive of len bytes; the directory read from it, or -- when it starts
//   before the tail -- from readAt(offset, n) (async, the list check's range request). Every
//   offset is checked against the archive's size: a broken zip is refused as "damaged". Refusals
//   are the page's own words. A name given twice, or in two cases, is one entry: the last one, in
//   the first one's place (key: zipKey of its name).

export const ZIP_TAIL = 65557; // (the end record and its longest comment)

// An entry's key: its path without a leading / or case -- how the page's unzip, its 3MF reader and
// the list check match a path to an entry (the rule was written six times: r77 A5)
export const zipKey = (p) => String(p).replace(/^\//, '').toLowerCase();

// (every offset an archive of len bytes gives, checked against its size: a broken zip refused as
// "damaged", not met as the engine's "Offset is outside the bounds of the DataView")
export const within = (len) => (at, n, what) => { if (!(at >= 0 && at + n <= len)) throw new Error(`a damaged zip (${what} lies outside the file)`); };

export async function zipDirectory(tail, tailAt, len, readAt = null) {
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const need = within(len);
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
  const out = [], at = new Map(); // (key -> its place in out: a findIndex each entry was 2e9 compares on 65,535)
  let o = 0;
  for (let i = 0; i < n; i++) {
    if (!(o + 46 <= cd.length)) throw new Error('a damaged zip (a directory entry lies outside the file)');
    if (c.getUint32(o, true) !== 0x02014b50) throw new Error('a damaged zip central directory');
    const method = c.getUint16(o + 10, true), flags = c.getUint16(o + 8, true);
    // (a stored entry's size is the bytes it holds -- what the page's unzip hands on -- whatever the
    // directory claims: the list check took the claim, and called a cut STL "ok" and a whole one
    // "damaged" -- r78 Q2)
    const csize = c.getUint32(o + 20, true), usize = method === 0 ? csize : c.getUint32(o + 24, true);
    const nlen = c.getUint16(o + 28, true), xlen = c.getUint16(o + 30, true), clen = c.getUint16(o + 32, true);
    const lho = c.getUint32(o + 42, true);
    if (!(o + 46 + nlen <= cd.length)) throw new Error('a damaged zip (an entry name lies outside the file)');
    const name = new TextDecoder().decode(cd.subarray(o + 46, o + 46 + nlen));
    need(lho, 30, `${name}'s header`);
    // (and its data, at least as far as the directory can tell -- it starts past the 30-byte header --
    // here, for every reader: the page's unzip alone held it to the file, and the list check said "ok"
    // of a 200-byte zip whose entry claimed 10 MB, r77 Q2. Where exactly it starts is the local
    // header's: unzip and the check's sources hold that to the file too)
    need(lho + 30, csize, `${name}'s data`);
    // (a name twice, or in two cases: the last one kept, in the first one's place, as one name -- the
    // page's map of them; the list check read the first, a small A.stl over the 3 GB a.stl the page
    // refused: r76 A4)
    const key = zipKey(name);
    const e = { name, key, method, flags, csize, usize, lho };
    if (at.has(key)) out[at.get(key)] = e; else { at.set(key, out.length); out.push(e); }
    o += 46 + nlen + xlen + clen;
  }
  return out;
}

// What the page reads of an entry: stored or deflated, and not encrypted; else refused in these words
// -- the one rule, the page's unzip and the list check's (which said "ok" of a bzip2 entry, r76 A3,
// and of a password-protected one the page called "corrupt or truncated", r76 Q2)
export const methodRefusal = (name, method, flags = 0) => (flags & 1 ? `zip entry ${name} is encrypted (a password-protected zip), which this viewer does not read`
  : method === 0 || method === 8 ? null : `zip entry ${name} uses compression method ${method}`);

// An entry that inflates to other than the size its directory gives is damaged, in these words, or null
// -- the one rule for the page's unzip and the list check: the check sized an entry past 1 MB of data
// by its claim and the page by what it inflated to, and they disagreed both ways (r79 Q2)
export const sizeRefusal = (name, got, said) => (got === said ? null : `a damaged zip (${name} unpacks to ${got.toLocaleString('en-US')} bytes, where its directory says ${said.toLocaleString('en-US')})`);

// An entry's data: where it starts, from its local header's 30 bytes (head) -- its name and extra
// lengths there, which may differ from the directory's
export const entryDataAt = (lho, head) => {
  const d = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return lho + 30 + d.getUint16(26, true) + d.getUint16(28, true);
};
