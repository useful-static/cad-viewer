// A browser's MediaRecorder writes a WebM with no Duration (the length is not known while it
// records), so a player shows no length and cannot scrub (R156-5). This writes the measured
// length into the Segment's Info, in its own TimecodeScale's units. Pure: bytes in, bytes out.

const ID = { EBML: 0x1a45dfa3, SEGMENT: 0x18538067, INFO: 0x1549a966, CLUSTER: 0x1f43b675, SCALE: 0x2ad7b1, DURATION: 0x4489 };

// an EBML variable-length number at p -> { len, value, unknown }; id: the marker bit kept
function vint(u8, p, id = false) {
  const b = u8[p];
  let len = 1;
  while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
  if (len > 8 || p + len > u8.length) return null;
  let value = id ? b : b & (0xff >> len);
  let ones = (b & (0xff >> len)) === 0xff >> len;
  for (let i = 1; i < len; i++) { value = value * 256 + u8[p + i]; if (u8[p + i] !== 0xff) ones = false; }
  return { len, value, unknown: !id && ones };
}
// a size written back in `len` bytes (its width kept, so nothing after it moves)
function putSize(u8, p, len, value) {
  for (let i = len - 1; i >= 0; i--) { u8[p + i] = value % 256; value = Math.floor(value / 256); }
  u8[p] |= 0x80 >> (len - 1);
}

// webm: a Uint8Array (the file's start is enough if it holds the Info); ms: the length
// -> a new Uint8Array with the Duration set, or the input unchanged when no Info is found
export function withDuration(webm, ms) {
  const u8 = webm;
  let p = 0;
  const head = vint(u8, p, true);
  if (!head || head.value !== ID.EBML) return webm;
  const hs = vint(u8, p + head.len);
  p += head.len + hs.len + hs.value;
  const seg = vint(u8, p, true);
  if (!seg || seg.value !== ID.SEGMENT) return webm;
  const segSize = vint(u8, p + seg.len);
  const segSizeAt = p + seg.len;
  p = segSizeAt + segSize.len;
  while (p < u8.length) {
    const id = vint(u8, p, true);
    if (!id || id.value === ID.CLUSTER) return webm;
    const size = vint(u8, p + id.len);
    if (!size) return webm;
    const body = p + id.len + size.len, end = body + size.value;
    if (id.value !== ID.INFO) { p = end; continue; }
    if (end > u8.length) return webm;
    let scale = 1e6, q = body;
    while (q < end) {
      const cid = vint(u8, q, true), cs = vint(u8, q + cid.len), cb = q + cid.len + cs.len;
      if (cid.value === ID.SCALE) { scale = 0; for (let i = 0; i < cs.value; i++) scale = scale * 256 + u8[cb + i]; }
      if (cid.value === ID.DURATION && (cs.value === 8 || cs.value === 4)) {
        // (one written already: set it)
        const out = u8.slice(), dv = new DataView(out.buffer, out.byteOffset);
        if (cs.value === 8) dv.setFloat64(cb, ms * 1e6 / (scale || 1e6)); else dv.setFloat32(cb, ms * 1e6 / (scale || 1e6));
        return out;
      }
      q = cb + cs.value;
    }
    // none: an 8-byte float Duration put at the Info's end, its size and the Segment's grown by it
    const add = new Uint8Array(11);
    add.set([0x44, 0x89, 0x88]);
    new DataView(add.buffer).setFloat64(3, ms * 1e6 / (scale || 1e6));
    if (size.value + 11 >= 2 ** (7 * size.len) - 1) return webm;
    const out = new Uint8Array(u8.length + 11);
    out.set(u8.subarray(0, end));
    out.set(add, end);
    out.set(u8.subarray(end), end + 11);
    putSize(out, p + id.len, size.len, size.value + 11);
    if (!segSize.unknown) putSize(out, segSizeAt, segSize.len, segSize.value + 11);
    return out;
  }
  return webm;
}
