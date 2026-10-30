// More than one model in the view (feature review item 18): the models are
// merged into ONE decoded .cadmesh (js/cadmesh.js decodeCadmesh's shape), so
// everything that works on bodies -- picking, the tree, hide and isolate,
// Explode, Measure, the section -- works across them unchanged. Each model
// becomes one top-level node of the tree, named for its file; the second and
// later ones can be moved by an offset in mm (merged again on a move).
//
// Pure ES module, no DOM.

import { idToBytes } from './cadmesh.js';

const add3 = (a, o) => [a[0] + o[0], a[1] + o[1], a[2] + o[2]];

// models: [{ base: decoded cadmesh, name, offset: [x, y, z] mm }], at least 1.
// Returns a decoded cadmesh of them all. Optional sections (faces, edges,
// silhouettes) and the body facts are kept only when every model has them
// (the viewer then builds the edges and facts itself, as for an old file).
export function mergeModels(models) {
  if (!models.length) throw new Error('scene: no models');
  let vc = 0, ic = 0, mc = 0, fc = 0, ec = 0, sc = 0;
  for (const { base } of models) {
    vc += base.header.vertexCount;
    ic += base.header.indexCount;
    mc += base.header.meshes.length;
    if (base.faces) fc += base.faces.length;
    if (base.edges) ec += base.edges.length;
    if (base.silhouettes) sc += base.silhouettes.length;
  }
  const all = (k) => models.every((m) => m.base[k]);
  const out = {
    position: new Float32Array(vc * 3), normal: new Int16Array(vc * 4), color: new Uint8Array(vc * 4),
    id: new Uint8Array(vc * 4), index: new Uint32Array(ic),
    faces: all('faces') ? new Uint32Array(fc) : null,
    edges: all('edges') ? new Uint32Array(ec) : null,
    silhouettes: all('silhouettes') && all('silhouetteNormals') ? new Uint32Array(sc) : null,
    silhouetteNormals: all('silhouettes') && all('silhouetteNormals') ? new Int16Array(sc * 4) : null,
  };
  const meshes = [];
  const children = [];
  const facts = models.every((m) => m.base.header.facts) ? { closed: [], area: [], volume: [] } : null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let v0 = 0, i0 = 0, m0 = 0, t0 = 0, f0 = 0, e0 = 0, s0 = 0, omitted = 0;
  const units = new Set();
  let angular = Infinity;
  for (const { base, name, offset = [0, 0, 0] } of models) {
    const h = base.header;
    const n = h.vertexCount;
    // vertices: moved by the offset; ids renumbered after the models before
    const p = base.position;
    for (let v = 0; v < n; v++) {
      out.position[(v0 + v) * 3] = p[v * 3] + offset[0];
      out.position[(v0 + v) * 3 + 1] = p[v * 3 + 1] + offset[1];
      out.position[(v0 + v) * 3 + 2] = p[v * 3 + 2] + offset[2];
    }
    out.normal.set(base.normal, v0 * 4);
    out.color.set(base.color, v0 * 4);
    for (const [mi, m] of h.meshes.entries()) {
      const b = idToBytes(m0 + mi + 1);
      for (let v = m.vtxStart; v < m.vtxStart + m.vtxCount; v++) out.id.set(b, (v0 + v) * 4);
    }
    for (let i = 0; i < base.index.length; i++) out.index[i0 + i] = base.index[i] + v0;
    if (out.faces) {
      // (first triangle, count) pairs in global triangle numbers
      for (let i = 0; i < base.faces.length; i += 2) {
        out.faces[f0 + i] = base.faces[i] + t0;
        out.faces[f0 + i + 1] = base.faces[i + 1];
      }
    }
    if (out.edges) for (let i = 0; i < base.edges.length; i++) out.edges[e0 + i] = base.edges[i] + v0;
    if (out.silhouettes) {
      for (let i = 0; i < base.silhouettes.length; i++) out.silhouettes[s0 + i] = base.silhouettes[i] + v0;
      out.silhouetteNormals.set(base.silhouetteNormals, s0 * 4);
    }
    for (const m of h.meshes) {
      const c = { ...m, vtxStart: m.vtxStart + v0, idxStart: m.idxStart + i0 };
      if (m.bbox) c.bbox = { min: add3(m.bbox.min, offset), max: add3(m.bbox.max, offset) };
      if (m.faceStart !== undefined) c.faceStart = m.faceStart + f0 / 2;
      meshes.push(c);
    }
    if (facts) for (const k of ['closed', 'area', 'volume']) facts[k].push(...h.facts[k]);
    children.push(shiftNode({ ...h.root, name: name || h.root.name }, m0));
    if (h.bbox) {
      const b = { min: add3(h.bbox.min, offset), max: add3(h.bbox.max, offset) };
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); }
    }
    units.add(h.sourceUnits || 'unknown');
    if (h.angularDeflection) angular = Math.min(angular, h.angularDeflection);
    omitted += h.silhouettesOmitted || 0;
    v0 += n; i0 += base.index.length; m0 += h.meshes.length; t0 += base.index.length / 3;
    if (out.faces) f0 += base.faces.length;
    if (out.edges) e0 += base.edges.length;
    if (out.silhouettes) s0 += base.silhouettes.length;
  }
  const first = models[0].base.header;
  const header = {
    units: first.units, vertexCount: vc, indexCount: ic, meshes,
    bbox: min[0] === Infinity ? null : { min, max },
    root: { name: 'Scene', meshes: [], children },
    sections: first.sections, // (not read after decoding; kept for the shape)
  };
  if (facts) header.facts = facts;
  if (omitted) header.silhouettesOmitted = omitted;
  if (angular !== Infinity) header.angularDeflection = angular;
  if (!units.has('unknown')) header.sourceUnits = units.size === 1 ? [...units][0] : 'mixed';
  out.header = header;
  return out;
}

// a tree node with every mesh index moved by k
function shiftNode(node, k) {
  return { ...node, meshes: node.meshes.map((i) => i + k), children: node.children.map((c) => shiftNode(c, k)) };
}

// The body ids (1-based) of each model in a merged scene, in order
export function modelRanges(models) {
  const out = [];
  let k = 0;
  for (const { base } of models) {
    const n = base.header.meshes.length;
    out.push({ first: k + 1, count: n });
    k += n;
  }
  return out;
}
