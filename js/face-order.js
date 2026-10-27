// The order the GPU draws the faces in: solids first, then sheet bodies.
// A sheet often lies exactly on a solid's face (the pads and silkscreen
// sheets on a board's top face), so the two depth-fight and the sheet shows
// as speckle, or not at all, while its edges still draw. The renderers draw
// the two groups with different depth biases, the solids pushed back a
// little further, so a sheet on a solid's face shows. Only the GPU's index
// buffer is reordered: the model's own arrays keep the file's order.

// index: the model's triangle indices; meshes: header.meshes (idxStart,
// idxCount, kind). Returns { index, split }: index[0, split) is the solids'
// (and open shells') triangles, index[split, end) the sheets'. A model with
// no sheets, no kinds, or ranges that do not cover the index exactly is left
// as it is (split = its length: one group).
export function sheetsLast(index, meshes) {
  const n = index.length;
  const same = { index, split: n };
  if (!meshes || !meshes.length || !meshes.some((m) => m.kind === 'sheet')) return same;
  // the ranges must tile [0, n): sorted by start, each begins where the last ended
  let end = 0;
  for (const m of [...meshes].sort((a, b) => a.idxStart - b.idxStart)) {
    if (!(m.idxCount >= 0) || m.idxStart !== end) return same;
    end += m.idxCount;
  }
  if (end !== n) return same;
  const out = new index.constructor(n);
  let k = 0;
  for (const m of meshes) {
    if (m.kind === 'sheet') continue;
    out.set(index.subarray(m.idxStart, m.idxStart + m.idxCount), k);
    k += m.idxCount;
  }
  const split = k;
  for (const m of meshes) {
    if (m.kind !== 'sheet') continue;
    out.set(index.subarray(m.idxStart, m.idxStart + m.idxCount), k);
    k += m.idxCount;
  }
  return { index: out, split };
}

// The depth biases, as [slope factor, constant units]. WebGL's
// polygonOffset; WebGPU's (reverse-Z) are the same values negated, the units
// doubled (its float depth unit is finer). Both stay behind their own edges.
// The gap must be in the SLOPE factor: a board's top face is long sliver
// triangles (20 mm by 0.1 mm), whose depth is interpolated with an error
// that grows with the face's tilt. On the ALL-H3-CC board, at a 36 mm view,
// solids at 1 slope + 16 units still covered a pad that lies exactly on the
// board; 2 slope did not. More costs something: a solid pushed back further
// lets edges just behind its face show through it (with the sheets hidden,
// slope 4 changed 1.9% of that view, 2 changed 1.2%, the units barely
// mattered; ui-checks.py sheet-bleed holds the line).
export const BIAS_SOLID = [2, 1];
export const BIAS_SHEET = [1, 1];
