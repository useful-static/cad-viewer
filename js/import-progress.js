// How far a STEP / IGES conversion is, as one fraction of the whole, from the
// step OpenCascade reports (our occt-import-js build, occt-progress/):
// 1 = reading the file (start and end only), 2 = building the parts,
// 3 = meshing. After meshing reports 100%, the result is still being written
// out of the WASM, so a conversion is never 1 before it returns.

// Each step's share of a conversion, measured on a 25.7 MB assembly with our
// build (two runs, 41-43 s): reading 14-18%, building the parts 49-51%,
// meshing 25-27%; the rest, 7-8%, is writing the result. Another model can
// split differently, so the time left the card derives from this is labelled
// as an estimate.
export const STEP_SHARE = [0.16, 0.50, 0.26];

export function importFraction(phase, fraction) {
  const p = Math.min(3, Math.max(1, phase | 0));
  const f = p === 1 ? 0 : Math.min(1, Math.max(0, +fraction || 0)); // reading has no fraction
  let before = 0;
  for (let i = 0; i < p - 1; i++) before += STEP_SHARE[i];
  return before + STEP_SHARE[p - 1] * f;
}
