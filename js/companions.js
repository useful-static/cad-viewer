// A model's companions read for its reader (an OBJ's .mtl, a glTF's or a GLB's buffers and
// pictures): each read to what the ones before it leave of the file limit, the total refused past it
// in the one wording. The one reading, main.js loadMeshFile's and tests/check-tour.mjs's -- check-tour
// read a zip's with no limit, and passed a 10 MB zip whose pictures unpack to 2.36 GB, which the page
// refuses (r80 A1). Pure apart from what the files' arrayBuffer() does.
//
// readCompanions(files, name, stale?, max?) -> Map(lower-case name -> ArrayBuffer), or null when
// stale() turns true between reads
//   files: [{ name, arrayBuffer(max) }] -- a File ignores max; a zip's entry (main.js loadZip) is read
//   to it and refused past it in these words; name: the model's, for the words; max: the limit (the
//   file limit; a test passes a small one).

import { MAX_FILE_BYTES, OVERSIZE_WORDS } from './cadmesh.js';

export const companionsOverText = (name) => `${name}: its companion files come to ${OVERSIZE_WORDS}`; // (the one wording: r73 A6)

export async function readCompanions(files, name, stale = () => false, max = MAX_FILE_BYTES) {
  const extras = new Map();
  let total = 0;
  for (const f of files) {
    // (a File says its size: refused by it before it is read, as the model is -- each was read whole
    // first, 64 MB of a companion against a 1 MB limit: r81 A8)
    if (typeof f.size === 'number' && total + f.size > max) throw new Error(companionsOverText(name));
    const b = await f.arrayBuffer(max - total);
    if (stale()) return null;
    total += b.byteLength;
    if (total > max) throw new Error(companionsOverText(name));
    extras.set(f.name.toLowerCase(), b);
  }
  return extras;
}
