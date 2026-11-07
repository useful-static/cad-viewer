// A small XML tag walker, for the 3MF reader (js/mesh-formats.js) and the list check (js/list-check.js):
// one reading of a 3MF's parts, so the check's root model part is the reader's (a regex of its own saw
// a Relationship inside a comment, and did not decode entities: r75 Q3).

// A small XML tag walker (a worker has no DOMParser): onTag({ tag, attrs, close, self }) for each
// tag whose local name (its prefix dropped) is in `want`, in document order; every other tag is
// passed over without being parsed or kept. onTag returning true stops the walk. (A list of
// every tag, built before anything was counted, ran out of heap on a 204 KB 3MF holding 200 MB
// of "<a/>".)
const TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
export function xmlWalk(s, want, onTag) {
  // the wanted tags' starts found by one regex (the engine passes over every other tag
  // natively: 200 MB of "<a/>" in 0.5 s, against 1.2 s for a loop over each '<'), then each read
  // whole by TAG_RE where it starts. A name is matched to its end, one prefix run at most per '<'.
  const find = new RegExp(`<\\/?(?:[A-Za-z_][\\w:.-]*:)?(?:${want.join('|')})(?![\\w:.-])`, 'g');
  // a comment, CDATA section or processing instruction holds no tags: a match inside one is
  // passed over to its end (a commented-out build item was read, and refused as missing). Each
  // span is found once, ahead of the walk, so the walk stays linear; one never closed runs to the
  // end of the text.
  const SPECIAL = /<!--|<!\[CDATA\[|<\?/g;
  const CLOSE = { '<!--': '-->', '<![CDATA[': ']]>', '<?': '?>' };
  const spanFrom = (from) => {
    SPECIAL.lastIndex = from;
    const m = SPECIAL.exec(s);
    if (!m) return { start: Infinity, end: Infinity };
    const e = s.indexOf(CLOSE[m[0]], m.index + m[0].length);
    return { start: m.index, end: e < 0 ? Infinity : e + CLOSE[m[0]].length };
  };
  let span = spanFrom(0);
  let f;
  while ((f = find.exec(s))) {
    while (span.end <= f.index) span = spanFrom(span.end);
    if (span.start < f.index) {
      if (span.end === Infinity) return;
      find.lastIndex = span.end;
      continue;
    }
    TAG_RE.lastIndex = f.index;
    const m = TAG_RE.exec(s);
    if (!m) continue;
    const attrs = {};
    const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = ar.exec(m[3]))) attrs[a[1].replace(/^.*:/, '')] = xmlText(a[2] ?? a[3]);
    if (onTag({ tag: m[2].replace(/^.*:/, ''), attrs, close: !!m[1], self: !!m[4] })) return;
    find.lastIndex = TAG_RE.lastIndex;
  }
}

// An attribute value as text: XML's five named entities and its character references (&#N;,
// &#xH;) decoded ("Bolt &amp; nut" is the name "Bolt & nut"). A reference to no character is
// left as written. (Only a value holding "&" is scanned: a model's millions of coordinates are not.)
const XML_NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function xmlText(v) {
  if (v.indexOf('&') < 0) return v;
  return v.replace(/&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g, (all, hex, dec, nm) => {
    if (nm) return XML_NAMED[nm];
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : all;
  });
}

// A 3MF's root model part, from its _rels/.rels text: the first relationship whose Type is the 3D
// model's, its Target; else the usual 3D/3dmodel.model. The one rule, the 3MF reader's and the list
// check's (which took the usual name, and said "ok" of a 3MF rooted at /3D/plate.model the page
// refused: r75 A1), by the one walker
export function threeMfRoot(relsText) {
  let path = '3D/3dmodel.model';
  if (relsText) {
    xmlWalk(relsText, ['Relationship'], (t) => {
      if (!/3dmodel$/.test(t.attrs.Type || '')) return false;
      if (t.attrs.Target) path = t.attrs.Target;
      return true;
    });
  }
  return path;
}
