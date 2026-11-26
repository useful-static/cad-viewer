// A tour carried in a link: ?tour=z:<base64url of the deflated text>, for a visitor with no site to
// put the file on (R163-5). Loaded when a link carries one or Copy link is pressed, so it is not in
// the first phase. A link stays under MAX_TOUR_LINK characters, which a server and a chat take.
import { MAX_TOUR_BYTES } from './tour.js';

export const TOUR_IN_LINK = 'z:';
export const MAX_TOUR_LINK = 8000;
const b64url = (b) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
// (read as it inflates, stopped past `cap` bytes: a crafted link is no bomb)
async function pipeBytes(bytes, stream, cap = Infinity) {
  const r = new Blob([bytes]).stream().pipeThrough(stream).getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    if ((n += value.length) > cap) { r.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export async function packTour(text) {
  return TOUR_IN_LINK + b64url(await pipeBytes(new TextEncoder().encode(text), new CompressionStream('deflate-raw')));
}
// z:… -> the tour's text; throws when it is not one (cut short in copying, or edited)
export async function unpackTour(s) {
  const cut = () => new Error('it was cut short or changed: copy the link again');
  let bin;
  try { bin = atob(s.slice(TOUR_IN_LINK.length).replace(/-/g, '+').replace(/_/g, '/')); } catch { throw cut(); }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  let out;
  try { out = await pipeBytes(bytes, new DecompressionStream('deflate-raw'), MAX_TOUR_BYTES); } catch { throw cut(); }
  if (!out) throw new Error('it is too large');
  return new TextDecoder().decode(out);
}
