// CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) -- the zip/3MF
// entry checksum (export-mesh.js) and the R2004+ DWG file header checksum
// (dwg.js), one table for both.

const T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// bytes[from, to) -> CRC-32; `seed` continues an earlier CRC (0 starts one)
export function crc32(bytes, from = 0, to = bytes.length, seed = 0) {
  let c = ~seed >>> 0;
  for (let i = from; i < to; i++) c = T[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
