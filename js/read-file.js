// The one read of a mesh or 2D file, for js/read-worker.js (off the page's thread) and for the
// page itself where no worker can be made (main.js readInWorker's fallback): the same steps, in
// one place.
//
// Pure ES module, no DOM.

import { parseMesh } from './mesh-formats.js';
import { encodeCadmesh } from './cadmesh.js';
import { MM_PER } from './units.js';
import { parseDXF } from './dxf.js';
import { readDWG, dwgToPairs } from './dwg.js';

// A mesh file's bytes as a .cadmesh, in `unit` where the file stores none (STL, OBJ, PLY, OFF are
// read as mm until the units row's "this file is in" says otherwise) -> { raw, unitless }
export async function readMeshFile({ buf, format, name, extras, unit = 'mm' }) {
  const model = await parseMesh(format, buf, name, extras);
  const unitless = !model.sourceUnits;
  if (unitless && unit !== 'mm') {
    const k = MM_PER[unit];
    for (const b of model.meshes) for (let i = 0; i < b.positions.length; i++) b.positions[i] *= k;
  }
  if (unitless) model.sourceUnits = unit;
  return { raw: encodeCadmesh(model), unitless };
}

// A DXF's or DWG's bytes as a drawing: a DWG (js/dwg.js) is read into the group-code pairs a DXF
// holds; a DXF is passed as its bytes (parseDXF reads a binary one from them, an ASCII one in the
// drawing's own code page)
export function readDrawing({ buf, dwg }) {
  return parseDXF(dwg ? dwgToPairs(readDWG(buf)) : buf);
}
