// May a URL named in a file (a tour's model, a model list's entry) be opened?
// An http(s) URL always may. Any other URL only when it has the same scheme,
// host and port as the file it was read from: an app that serves the viewer
// from its own scheme (lc://app/) names its own files that way. Not by
// URL.origin, which is "null" for every non-http scheme, so it would let
// foo://evil/x pass against lc://app/; and a base with no host (file:) never
// vouches for anything. Pure, so tests/test-tour.mjs and
// tests/test-model-list.mjs check it in Node.

export function samePlace(url, base) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'http:' || u.protocol === 'https:') return true;
  let b;
  try { b = new URL(base); } catch { return false; }
  return !!b.host && u.protocol === b.protocol && u.host === b.host;
}
