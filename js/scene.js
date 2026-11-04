// More than one model in the view (feature review item 18): the models are
// merged into ONE decoded .cadmesh (js/cadmesh.js decodeCadmesh's shape), so
// everything that works on bodies -- picking, the tree, hide and isolate,
// Explode, Measure, the section -- works across them unchanged. Each model
// becomes one top-level node of the tree, named for its file; the second and
// later ones can be moved by an offset in mm (merged again on a move).
//
// Pure ES module, no DOM.

import { bodyAngle, idToBytes } from './cadmesh.js';
import { SILHOUETTE_CAP, factsCurrent, BODY_FACTS } from './edges.js';

const add3 = (a, o) => [a[0] + o[0], a[1] + o[1], a[2] + o[2]];

// models: [{ base: decoded cadmesh, name, offset: [x, y, z] mm }], at least 1.
// Returns a decoded cadmesh of them all. The faces are kept when any model has
// them (a model without: its bodies one face each); the edges, silhouettes and
// body facts by sceneEdgesFacts (below). Each body keeps its
// model's angular deflection (the default where the model records none); the
// scene has none of its own. opts.silhouetteCap: past it the scene's silhouettes are left out and
// counted (js/edges.js SILHOUETTE_CAP; the viewer passes a phone's smaller cap).
export function mergeModels(models, { silhouetteCap = SILHOUETTE_CAP } = {}) {
  if (!models.length) throw new Error('scene: no models');
  let vc = 0, ic = 0, mc = 0, fc = 0;
  for (const { base } of models) {
    vc += base.header.vertexCount;
    ic += base.header.indexCount;
    mc += base.header.meshes.length;
    if (base.faces) fc += base.faces.length;
  }
  // (the faces kept when any model has them -- they cannot be rebuilt, as edges and facts are: a
  // board with faces and a case without lost List holes, Face to face and Paint; a model without
  // has its bodies faceCount 0, one face each, as an old file's)
  const anyFaces = models.some((m) => m.base.faces);
  const out = {
    position: new Float32Array(vc * 3), normal: new Int16Array(vc * 4), color: new Uint8Array(vc * 4),
    id: new Uint8Array(vc * 4), index: new Uint32Array(ic),
    faces: anyFaces ? new Uint32Array(fc) : null,
  };
  const meshes = [];
  const children = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let v0 = 0, i0 = 0, m0 = 0, t0 = 0, f0 = 0;
  const units = new Set();
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
    if (out.faces && base.faces) {
      // (first triangle, count) pairs in global triangle numbers
      for (let i = 0; i < base.faces.length; i += 2) {
        out.faces[f0 + i] = base.faces[i] + t0;
        out.faces[f0 + i + 1] = base.faces[i + 1];
      }
    }
    for (const m of h.meshes) {
      const c = { ...m, vtxStart: m.vtxStart + v0, idxStart: m.idxStart + i0 };
      // (each body keeps its model's angular deflection: the circle test is the model's, and the
      // scene's one -- the smallest -- set every model's. A model that records none, a .cadmesh
      // older than the field, is the converter's default, never the angle of a model beside it.)
      c.angularDeflection = bodyAngle(h, m);
      if (m.bbox) c.bbox = { min: add3(m.bbox.min, offset), max: add3(m.bbox.max, offset) };
      if (base.faces && m.faceStart !== undefined) c.faceStart = m.faceStart + f0 / 2;
      else if (out.faces) { c.faceStart = f0 / 2; c.faceCount = 0; }
      meshes.push(c);
    }
    children.push(shiftNode({ ...h.root, name: name || h.root.name }, m0));
    if (h.bbox) {
      const b = { min: add3(h.bbox.min, offset), max: add3(h.bbox.max, offset) };
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); }
    }
    units.add(h.sourceUnits || 'unknown');
    v0 += n; i0 += base.index.length; m0 += h.meshes.length; t0 += base.index.length / 3;
    if (out.faces && base.faces) f0 += base.faces.length;
  }
  const first = models[0].base.header;
  const header = {
    units: first.units, vertexCount: vc, indexCount: ic, meshes,
    bbox: min[0] === Infinity ? null : { min, max },
    root: { name: 'Scene', meshes: [], children },
    sections: first.sections, // (not read after decoding; kept for the shape)
  };
  if (!units.has('unknown')) header.sourceUnits = units.size === 1 ? [...units][0] : 'mixed';
  out.header = header;
  sceneEdgesFacts(out, models, { silhouetteCap });
  return out;
}

// The scene's edges, silhouettes and per-body facts from its models' own (their vertex numbers
// moved after the models before; nothing built), set on the merged scene `out` -- by mergeModels,
// and again by the viewer once the models that had none of today's have their own built (each on
// its own unmoved arrays: a scene's built on the moved float32 copy and split back gave a model
// moved 100,000 mm a volume 1 % low, kept after it was moved back). The edges and the facts only
// when every model has them, the facts' rule only when every model's is the same one; with the
// edges, the silhouettes any model has (one whose file left them out counts them omitted), left
// out and counted past the cap (two models each under it merged past it: 2,454,650 drawn).
export function sceneEdgesFacts(out, models, { silhouetteCap = SILHOUETTE_CAP } = {}) {
  const header = out.header;
  let ec = 0, sc = 0, omitted = 0;
  for (const { base } of models) {
    if (base.edges) ec += base.edges.length;
    if (base.silhouettes && base.silhouetteNormals) sc += base.silhouettes.length;
    omitted += base.header.silhouettesOmitted || 0;
  }
  out.edges = models.every((m) => m.base.edges) ? new Uint32Array(ec) : null;
  const anySil = out.edges && models.some((m) => m.base.silhouettes && m.base.silhouetteNormals);
  out.silhouettes = anySil ? new Uint32Array(sc) : null;
  out.silhouetteNormals = anySil ? new Int16Array(sc * 4) : null;
  const facts = models.every((m) => m.base.header.facts) ? Object.fromEntries(BODY_FACTS.map((f) => [f.key, []])) : null;
  let v0 = 0, e0 = 0, s0 = 0;
  for (const { base } of models) {
    if (out.edges) { for (let i = 0; i < base.edges.length; i++) out.edges[e0 + i] = base.edges[i] + v0; e0 += base.edges.length; }
    if (out.silhouettes && base.silhouettes && base.silhouetteNormals) {
      for (let i = 0; i < base.silhouettes.length; i++) out.silhouettes[s0 + i] = base.silhouettes[i] + v0;
      out.silhouetteNormals.set(base.silhouetteNormals, s0 * 4);
      s0 += base.silhouettes.length;
    }
    if (facts) {
      // (appended one by one: a spread of a model's 300,000 bodies into push ran out of stack; a
      // fact a model does not write is false for each of its bodies)
      const f = base.header.facts, nb = base.header.meshes.length;
      for (const { key, kind } of BODY_FACTS) {
        const src = f[key], dst = facts[key];
        for (let i = 0; i < nb; i++) dst.push(kind === 'flag' ? !!src?.[i] : src[i]);
      }
    }
    v0 += base.header.vertexCount;
  }
  delete header.facts; delete header.factsRule; delete header.silhouettesOmitted;
  if (facts) {
    header.facts = facts;
    const rules = new Set(models.map((m) => m.base.header.factsRule));
    if (rules.size === 1 && [...rules][0] !== undefined) header.factsRule = [...rules][0];
  }
  if (out.silhouettes && out.silhouettes.length / 2 > silhouetteCap) {
    omitted += out.silhouettes.length / 2;
    out.silhouettes = null; out.silhouetteNormals = null;
  }
  if (omitted) header.silhouettesOmitted = omitted;
  return out;
}

// The models of a scene whose edges and facts are not today's: built each on its own, unmoved
export const staleModels = (models) => models.filter((m) => !(m.base.edges && factsCurrent(m.base.header)));

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

