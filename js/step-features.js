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
// Not counted: the parts. Counting placed parts (the assembly tree expanded)
// came within 70 vs 75 of the converter's bodies, but did not improve the
// forecast of any step: the time is in the geometry, not the number of parts.
//
// A file that is not ISO-10303-21 text (IGES, BREP) gets bytes only.

import { forEachStepSlice } from './step-text.js';

export function stepFeatures(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const f = { bytes: u8.byteLength, entities: 0, faces: 0, bounds: 0, bounds15: 0, bounds2: 0, bsplines: 0, step: false };
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 64));
  if (!/ISO-10303-21/.test(head)) return f;
  f.step = true;
  // decoded in slices cut at a record's end (js/step-text.js)
  forEachStepSlice(u8, (text) => count(text, f));
  return f;
}

function count(text, f) {
  f.entities += (text.match(/#\d+\s*=/g) || []).length;
  f.bounds += (text.match(/=\s*FACE_(?:OUTER_)?BOUND\s*\(/g) || []).length;
  f.bsplines += (text.match(/B_SPLINE_SURFACE/g) || []).length;
  // ADVANCED_FACE('name',(#b1,#b2,...),#surface,.T.): the bound list is the
  // first parenthesised list after the name. Read once per record, anchored at its start (a
  // regex over the whole slice ran to the next ')' from every match start: a 1 MB file, 56 s)
  const re = /^\s*#\d+\s*=\s*ADVANCED_FACE\s*\(\s*'(?:[^']|'')*'\s*,\s*\(([^)]*)\)/;
  for (const rec of text.split(';')) {
    if (!rec.includes('ADVANCED_FACE')) continue;
    const m = re.exec(rec);
    if (!m) continue;
    const k = m[1].split(',').length;
    f.faces++;
    f.bounds15 += k * Math.sqrt(k);
    f.bounds2 += k * k;
  }
}
