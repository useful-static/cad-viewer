// Part metadata from a STEP file (feature review item 24): each PRODUCT's id
// (often the part number), name and description, read from the file's own
// text, so the info panel can show them for a selected part named as the
// product is. The converter keeps only names; this needs no change to it.
// STEP strings escape a quote as '' and may carry \X2\...\X0\ (UTF-16 hex)
// and \X\hh (ISO 8859-1) encodings, decoded here.
//
// Pure ES module, no DOM.

// text: the STEP file as text (latin1 is fine: the encodings are ASCII).
// Returns Map(name -> { id, description }) of the products whose id or
// description says more than the name does.
export function stepProducts(text) {
  const out = new Map();
  const re = /\bPRODUCT\s*\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/gi;
  let m;
  while ((m = re.exec(text))) {
    const id = decodeStepString(m[1]).trim(), name = decodeStepString(m[2]).trim(), description = decodeStepString(m[3]).trim();
    if (!name) continue;
    const useful = (s) => s && s !== name && !/^(none|n\/a|unknown|\$)$/i.test(s);
    if (!useful(id) && !useful(description)) continue;
    if (!out.has(name)) out.set(name, { id: useful(id) ? id : '', description: useful(description) ? description : '' });
  }
  return out;
}

// a STEP string's escapes undone
export function decodeStepString(s) {
  return s.replace(/''/g, "'")
    .replace(/\\X2\\((?:[0-9A-F]{4})+)\\X0\\/gi, (_, h) => String.fromCharCode(...h.match(/.{4}/g).map((x) => parseInt(x, 16))))
    .replace(/\\X\\([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
