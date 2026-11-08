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

// bytes -> CRC-32, the thread given a turn every 16 MB (a task: a paint, a click), and stop() asked
// there -- true ends it with null: a zip entry's check on the page (js/mesh-formats.js unzip, r80 Q4)
export async function crc32Turning(bytes, stop = null) {
  const STEP = 16 * 2 ** 20;
  let c = 0;
  for (let at = 0; at < bytes.length; at += STEP) {
    c = crc32(bytes, at, Math.min(bytes.length, at + STEP), c);
    if (at + STEP < bytes.length) {
      // (a MessageChannel's task, as js/cadmesh.js turns: setTimeout's is held to 1 s in a hidden tab)
      await new Promise((res) => {
        if (typeof MessageChannel === 'undefined') { setTimeout(res, 0); return; }
        const ch = new MessageChannel();
        ch.port1.onmessage = () => { ch.port1.close(); res(); };
        ch.port2.postMessage(0);
      });
      if (stop && stop()) return null;
    }
  }
  return c;
}
// bytes[from, to) -> CRC-32; `seed` continues an earlier CRC (0 starts one)
export function crc32(bytes, from = 0, to = bytes.length, seed = 0) {
  let c = ~seed >>> 0;
  for (let i = from; i < to; i++) c = T[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
