// More than one model in the view (feature review item 18): the models are
// merged into ONE decoded .cadmesh (js/cadmesh.js decodeCadmesh's shape), so
// everything that works on bodies -- picking, the tree, hide and isolate,
// Explode, Measure, the section -- works across them unchanged. Each model
// becomes one top-level node of the tree, named for its file; the second and
// later ones can be moved by an offset in mm (merged again on a move).
//
// Pure ES module, no DOM.

import { bodyAngle, geomIsMm, idToBytes } from './cadmesh.js';
import { LENGTH_MM, headerUnitWord, lengthUnitOf, unitSaid } from './units.js';
import { SILHOUETTE_CAP, FACTS_RULE, factsCurrent, BODY_FACTS, factValue, overSilhouetteCap } from './edges.js';

const add3 = (a, o) => [a[0] + o[0], a[1] + o[1], a[2] + o[2]];

// models: [{ base: decoded cadmesh, name, offset: [x, y, z] mm }], at least 1.
// Returns a decoded cadmesh of them all. The faces are kept when any model has
// them (a model without: its bodies one face each); the edges, silhouettes and
// body facts by sceneEdgesFacts (below). Each body keeps its
// model's angular deflection (the default where the model records none); the
// scene has none of its own. opts.silhouetteCap: past it the scene's silhouettes are left out and
// counted (js/edges.js SILHOUETTE_CAP; the viewer passes a phone's smaller cap).
// Why these models cannot share one scene, or null: their geometry in different units. A scene has one
// header and one unit (js/cadmesh.js geomIsMm, the display's, the exports' and the mass's rule), and
// an inch model added to a mm one was shown, measured and exported as mm (r85 A1). The words name
// the first model in another unit than the first's. (A unit by its one name, js/units.js
// lengthUnitOf: "in" and "inch" were refused as two units -- r86 A8.)
const unitKey = (h) => (geomIsMm(h) ? 'mm' : lengthUnitOf(h.units) || String(h.units));
export function sceneUnitsRefusal(models) {
  const first = unitKey(models[0].base.header);
  const other = models.find((m) => unitKey(m.base.header) !== first);
  return other ? `${other.name || 'this model'} is in ${unitSaid(unitKey(other.base.header))} and the view's model in ${unitSaid(first)}: models in different units are not shown together (open it on its own with Open…)` : null;
}
// A model's offset, given in mm (the move fields, ?addat), in its geometry's unit -- added to its
// positions as they are: two inch models, the second "moved by X 25.4 mm", put it 25.4 inches over
// (r86 A5). A unit with no length known here and an offset: refused in words.
function offsetInUnit(h, offset, name) {
  if (geomIsMm(h) || offset.every((o) => o === 0)) return offset;
  const k = lengthUnitOf(h.units);
  if (!k) throw new Error(`${name || 'this model'} cannot be moved: its lengths are in ${headerUnitWord(h.units)}, which this viewer does not convert from mm`);
  return offset.map((o) => o / LENGTH_MM[k]);
}

export function mergeModels(models, { silhouetteCap = SILHOUETTE_CAP } = {}) {
  if (!models.length) throw new Error('scene: no models');
  const unitsClash = sceneUnitsRefusal(models);
  if (unitsClash) throw new Error(unitsClash);
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
  for (const { base, name, offset: mmOffset = [0, 0, 0] } of models) {
    const h = base.header;
    const offset = offsetInUnit(h, mmOffset, name);
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
    // (the first model's spelling: every reader of it, js/cadmesh.js geomIsMm, takes a unit by its one
    // name, so [millimetre, millimeter] is mm in either order -- r87 A1)
    units: first.units, vertexCount: vc, indexCount: ic, meshes,
    bbox: min[0] === Infinity ? null : { min, max },
    root: { name: 'Scene', meshes: [], children },
    sections: first.sections, // (not read after decoding; kept for the shape)
  };
  if (!units.has('unknown')) header.sourceUnits = units.size === 1 ? [...units][0] : 'mixed';
  out.header = header;
  // (the edges and facts' merge failing -- an allocation refused -- leaves the scene shown without
  // them, its error kept for the viewer to say, as the same failure after the builds is: it refused
  // the whole Add model or move -- r42 A3)
  try {
    sceneEdgesFacts(out, models, { silhouetteCap });
  } catch (e) {
    out.edges = null; out.silhouettes = null; out.silhouetteNormals = null;
    out.mergeError = e;
  }
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
// (Built into its own arrays and set on `out` only at the end: one that failed part way -- an
// allocation refused -- left the shown scene's edges zero-filled, and drawn: r42 A2, Q1. The cap
// asked of the count before the silhouettes are allocated: 10 models' were copied, ~456 MB a move,
// then dropped: r42 A4.)
export function sceneEdgesFacts(out, models, { silhouetteCap = SILHOUETTE_CAP } = {}) {
  const header = out.header;
  let ec = 0, sc = 0, omitted = 0;
  for (const { base } of models) {
    if (base.edges) ec += base.edges.length;
    if (base.silhouettes && base.silhouetteNormals) sc += base.silhouettes.length;
    omitted += base.header.silhouettesOmitted || 0;
  }
  const edges = models.every((m) => m.base.edges) ? new Uint32Array(ec) : null;
  const anySil = !!edges && models.some((m) => m.base.silhouettes && m.base.silhouetteNormals);
  const silOver = anySil && overSilhouetteCap(sc / 2, silhouetteCap);
  if (silOver) omitted += sc / 2;
  const silhouettes = anySil && !silOver ? new Uint32Array(sc) : null;
  const silhouetteNormals = silhouettes ? new Int16Array(sc * 4) : null;
  const facts = models.every((m) => m.base.header.facts) ? Object.fromEntries(BODY_FACTS.map((f) => [f.key, []])) : null;
  let v0 = 0, e0 = 0, s0 = 0;
  for (const { base } of models) {
    if (edges) { for (let i = 0; i < base.edges.length; i++) edges[e0 + i] = base.edges[i] + v0; e0 += base.edges.length; }
    if (silhouettes && base.silhouettes && base.silhouetteNormals) {
      for (let i = 0; i < base.silhouettes.length; i++) silhouettes[s0 + i] = base.silhouettes[i] + v0;
      silhouetteNormals.set(base.silhouetteNormals, s0 * 4);
      s0 += base.silhouettes.length;
    }
    if (facts) {
      // (appended one by one: a spread of a model's 300,000 bodies into push ran out of stack; a
      // fact a model does not write is false, or 0, for each of its bodies: js/edges.js factValue)
      const f = base.header.facts, nb = base.header.meshes.length;
      for (const fact of BODY_FACTS) {
        const src = f[fact.key], dst = facts[fact.key];
        for (let i = 0; i < nb; i++) dst.push(factValue(fact, src?.[i]));
      }
    }
    v0 += base.header.vertexCount;
  }
  out.edges = edges; out.silhouettes = silhouettes; out.silhouetteNormals = silhouetteNormals;
  delete header.facts; delete header.factsRule; delete header.silhouettesOmitted;
  if (facts) {
    header.facts = facts;
    // (every model's facts current, whatever rule each was written under, the scene's are: one of
    // rule 4 beside one of 5 read as stale, and the scene's facts were built again -- r68)
    const rules = new Set(models.map((m) => m.base.header.factsRule));
    if (models.every((m) => factsCurrent(m.base.header))) header.factsRule = FACTS_RULE;
    else if (rules.size === 1 && [...rules][0] !== undefined) header.factsRule = [...rules][0];
  }
  if (omitted) header.silhouettesOmitted = omitted;
  return out;
}

// Whether a model's edges and facts can be used as they are (its file's, or kept from a build):
// the one test, main.js edgesOf's and the scene's
export const edgesUsable = (base) => !!base.edges && factsCurrent(base.header);

// The models of a scene whose edges and facts are not today's: built each on its own, unmoved
export const staleModels = (models) => models.filter((m) => !edgesUsable(m.base));

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
// The index of the model a body id (1-based) is in, by modelRanges' ranges, or -1 (one rule: the
// clearance run and its line each had a copy -- r94 A5)
export const modelOfBody = (ranges, id) => ranges.findIndex((r) => id >= r.first && id < r.first + r.count);

// The copies of body `id` among meshes (1-based ids, itself included): the same name, the same
// triangle count and the same size, the sizes compared sorted (a copy turned is still the same size
// on some axis order). Same within 1e-3 of a unit (1 µm: the readers write mm), or 2e-6 of the
// model's extent or the bodies' farthest coordinate where that is more, the float32 positions'
// rounding there. (Rounded to 1e-3 and keyed, two copies either side of a rounding step split --
// r122 L4, r123 L4)
export function copiesOf(meshes, id, bbox = null) {
  const ext = bbox ? Math.max(...[0, 1, 2].map((k) => bbox.max[k] - bbox.min[k])) : 0;
  const size = (m) => (m.bbox ? [0, 1, 2].map((k) => m.bbox.max[k] - m.bbox.min[k]).sort((a, b) => a - b) : null);
  const far = (m) => (m.bbox ? Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(m.bbox.min[k]), Math.abs(m.bbox.max[k])])) : 0);
  const me = meshes[id - 1], s = size(me), f = far(me);
  const out = [];
  meshes.forEach((m, i) => {
    if (m.name !== me.name || m.idxCount !== me.idxCount) return;
    const t = size(m);
    if (!s || !t) { if (!s && !t) out.push(i + 1); return; }
    const tol = Math.max(1e-3, 2e-6 * Math.max(ext, f, far(m)));
    if (s.every((v, k) => Math.abs(v - t[k]) <= tol)) out.push(i + 1);
  });
  return out;
}

