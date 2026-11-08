// Where the selection is, measured from a reference: the whole model, or a
// part the user chose (a board's PCB), so a buyer reads "the HDMI connector
// runs from X 3.2 to 18.2 mm of the board's corner" and "parts stand 17 mm
// above the board, 2 mm below it" (feature review 2026-10-29). Boxes are
// axis-aligned in the file's own axes, as the size row is; "above" is along
// the view's up axis (js/orient.js orientUp: a unit file axis, + or -).

// -> [[lo, hi], [lo, hi], [lo, hi]]: the box's extent per file axis, from the
// reference box's min corner
export function rangesFrom(box, ref) {
  return [0, 1, 2].map((k) => [box.min[k] - ref.min[k], box.max[k] - ref.min[k]]);
}

// -> { above, below }: how far the box reaches past the reference's top and
// bottom along up (negative: it stops short of that face)
export function aboveBelow(box, ref, up) {
  const k = up.findIndex((v) => v !== 0);
  const s = Math.sign(up[k]);
  const top = (b) => (s > 0 ? b.max[k] : -b.min[k]);
  const bottom = (b) => (s > 0 ? b.min[k] : -b.max[k]);
  return { above: top(box) - top(ref), below: bottom(ref) - bottom(box) };
}
// The words for how far it stands past one face: its distance as shown (num: the panel's own
// formatter, in the unit shown), "none" where that reads zero or less -- the cut-off was 0.005 in
// the model's units, millimetres in mind, and a part 4 mm above its board in a file in metres read
// "none above" (r88 A4)
export function pastWords(v, side, num) {
  const shown = num(v);
  return v > 0 && Number(String(shown).replace(/,/g, '')) > 0 ? `${shown} ${side}` : `none ${side}`;
}
