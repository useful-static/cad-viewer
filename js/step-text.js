// A STEP file's text in slices, each ending at a record's end (";"), so a scan never holds the
// whole file as one string: past ~512 MB a browser cannot make that string, and the load failed
// before the converter saw the file. The STEP scanners all read through this: the part metadata
// (js/step-meta.js), the declared unit (js/source-units.js) and the conversion forecast
// (js/step-features.js).
//
// Pure ES module, no DOM.

export const STEP_SLICE = 4 << 20;

// The bytes OpenCascade is given: a UTF-8 byte-order mark first is dropped (it refuses one,
// "unexpected QUID, expecting STEP"). The page (main.js) and stp2mesh.mjs both convert through it.
export const withoutBom = (u8) => (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf ? u8.subarray(3) : u8);

// u8 (Uint8Array) -> fn(text) once per slice, line breaks kept. The text after a slice's last
// ";" (a record cut by the slice) is carried into the next. A carry longer than a slice holds
// no ";" at all, so it is not records: it is dropped, not carried on (carried, a 600 MB file
// with no ";" re-copied an ever-longer string and failed with the engine's "Invalid string
// length"). A record cut that way costs only what the scan would have read from it.
export function forEachStepSlice(u8, fn) {
  const dec = new TextDecoder('latin1');
  let carry = '';
  for (let at = 0; at < u8.byteLength; at += STEP_SLICE) {
    const last = at + STEP_SLICE >= u8.byteLength;
    const text = carry + dec.decode(u8.subarray(at, Math.min(u8.byteLength, at + STEP_SLICE)));
    const cut = last ? text.length : text.lastIndexOf(';') + 1;
    fn(text.slice(0, cut));
    carry = text.slice(cut);
    if (carry.length > STEP_SLICE) carry = '';
  }
}
