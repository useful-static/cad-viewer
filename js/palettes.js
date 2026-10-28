// One-click colour schemes for a loaded model. Each gives every body one
// colour (the file's own colours keep their per-face detail), written into a
// per-vertex colour array the renderers upload as they do the model's own.
// The model's converted colours are never changed: Save .cadmesh and the
// saved conversions keep the file's colours whatever is shown.
//
//   file      the colours as converted: the file's own, or for a file with
//             none one muted colour per part name
//   part      one muted colour per part NAME: every instance of a part matches
//   assembly  one colour per top-level assembly: parts of a subassembly match
//   body      a different colour for every body
//   mono      one neutral colour for everything (shape reads by shading alone)

import { PALETTE, hashName } from './cadmesh.js';

export const PALETTES = [
  { id: 'file', label: 'File colours' },
  { id: 'part', label: 'By part name' },
  { id: 'assembly', label: 'By assembly' },
  { id: 'body', label: 'By body' },
  { id: 'mono', label: 'One colour' },
];
export const MONO = [0.72, 0.74, 0.78];

// The n-th of a run of distinct muted colours: hues a golden angle apart, so
// neighbours in the run differ and a long run never repeats.
export function distinct(n) {
  const h = ((n * 137.508) % 360) / 360, s = 0.38, l = 0.6;
  const f = (k) => {
    const t = (k + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(t - 3, 9 - t, 1));
  };
  return [f(0), f(8), f(4)];
}

// The colour of each body (an [r, g, b] in 0..1) for scheme id, or null for
// 'file' (the model's colours as they are). Pure: header is a .cadmesh header,
// { meshes: [{ name }], root: { name, meshes, children } }.
export function bodyColours(header, id) {
  const n = header.meshes.length;
  if (id === 'file') return null;
  if (id === 'mono') return Array.from({ length: n }, () => MONO);
  if (id === 'body') return Array.from({ length: n }, (_, i) => distinct(i));
  if (id === 'part') {
    // the nearest named node above each body names its part
    const owner = new Array(n).fill('');
    const walk = (node, name) => {
      const nm = node.name || name;
      for (const i of node.meshes) owner[i] = nm;
      for (const c of node.children) walk(c, nm);
    };
    walk(header.root, '');
    return header.meshes.map((m, i) => PALETTE[hashName(owner[i] || m.name || String(i)) % PALETTE.length]);
  }
  if (id === 'assembly') {
    // below any chain of single-child wrappers, each child of the first node
    // that branches is one assembly; bodies directly on that node get one
    // group each
    let top = header.root;
    while (top.children.length === 1 && top.meshes.length === 0) top = top.children[0];
    const group = new Array(n).fill(0);
    let g = 0;
    for (const i of top.meshes) group[i] = g++;
    for (const c of top.children) {
      const walk = (node) => { for (const i of node.meshes) group[i] = g; node.children.forEach(walk); };
      walk(c);
      g++;
    }
    return group.map((k) => (k < PALETTE.length ? PALETTE[k] : distinct(k)));
  }
  throw new Error(`unknown colour scheme ${id}`);
}

// The per-vertex colour array (RGBA8) for scheme id, or the model's own when
// id is 'file' and nothing is overridden. mesh: a decoded .cadmesh
// ({ header, color }). overrides: body index -> [r, g, b], colours the user
// picked for single parts, which win over the scheme.
export function schemeColours(mesh, id, overrides = new Map()) {
  const per = bodyColours(mesh.header, id);
  if (!per && overrides.size === 0) return mesh.color;
  const out = per ? new Uint8Array(mesh.color.length) : mesh.color.slice();
  const fill = (m, [r, g, b]) => {
    const R = Math.round(r * 255), G = Math.round(g * 255), B = Math.round(b * 255);
    for (let v = m.vtxStart, end = m.vtxStart + m.vtxCount; v < end; v++) {
      out[4 * v] = R; out[4 * v + 1] = G; out[4 * v + 2] = B; out[4 * v + 3] = 255;
    }
  };
  mesh.header.meshes.forEach((m, i) => {
    if (overrides.has(i)) fill(m, overrides.get(i));
    else if (per) fill(m, per[i]);
  });
  return out;
}

// '#rrggbb' <-> [r, g, b] in 0..1, for the colour picker
export const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
// red, green and blue only (an alpha would make the #value invalid), each
// clamped to 0..1, so the colour picker never falls back to black
export const rgbToHex = (c) => '#' + c.slice(0, 3)
  .map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');
