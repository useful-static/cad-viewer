// What a STEP file holds, counted from its text before it is converted, for
// the conversion-time estimate (js/import-progress.js). One pass of regular
// expressions over the file; nothing is parsed into objects.
//
//   bytes      file size
//   entities   "#n=" records
//   faces      ADVANCED_FACE records
//   bounds     FACE_BOUND + FACE_OUTER_BOUND records (one per wire: a face's
//              outline and each of its holes)
//   bounds15   the sum over faces of (bounds per face)^1.5: meshing a face
//              grows about that fast with its holes (measured on generated
//              plates of 500 to 4000 holes)
//   bounds2    the sum over faces of (bounds per face)^2: shape healing does
//              work for each PAIR of a face's wires, so a face with thousands
//              of holes costs far more than its share of the bounds
//   bsplines   B_SPLINE_SURFACE records (curved faces, the costly ones to mesh)
//
// A file that is not ISO-10303-21 text (IGES, BREP) gets bytes only.

export function stepFeatures(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const f = { bytes: u8.byteLength, entities: 0, faces: 0, bounds: 0, bounds15: 0, bounds2: 0, bsplines: 0, step: false };
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 64));
  if (!/ISO-10303-21/.test(head)) return f;
  f.step = true;
  // decoded in slices, so a large file never needs one string of its full size
  // at once; a record split at a slice end is completed by carrying the tail
  const dec = new TextDecoder('latin1');
  const SLICE = 4 << 20;
  let carry = '';
  for (let at = 0; at < u8.byteLength; at += SLICE) {
    const last = at + SLICE >= u8.byteLength;
    let text = carry + dec.decode(u8.subarray(at, Math.min(u8.byteLength, at + SLICE)));
    // keep everything after the last ';' (an unfinished record) for the next slice
    const cut = last ? text.length : text.lastIndexOf(';') + 1;
    carry = text.slice(cut);
    text = text.slice(0, cut);
    count(text, f);
  }
  return f;
}

function count(text, f) {
  f.entities += (text.match(/#\d+\s*=/g) || []).length;
  f.bounds += (text.match(/=\s*FACE_(?:OUTER_)?BOUND\s*\(/g) || []).length;
  f.bsplines += (text.match(/B_SPLINE_SURFACE/g) || []).length;
  // ADVANCED_FACE('name',(#b1,#b2,...),#surface,.T.): the bound list is the
  // first parenthesised list after the name
  const re = /=\s*ADVANCED_FACE\s*\(\s*'(?:[^']|'')*'\s*,\s*\(([^)]*)\)/g;
  for (let m; (m = re.exec(text));) {
    const k = m[1].split(',').length;
    f.faces++;
    f.bounds15 += k * Math.sqrt(k);
    f.bounds2 += k * k;
  }
}
