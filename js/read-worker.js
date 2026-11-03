// The mesh and 2D readers, off the page's thread: a file the viewer opens without converting
// (STL, OBJ, PLY, OFF, 3MF, glTF / GLB; DXF, DWG) is read here, so a slow or hostile file never
// freezes the tab. The page (main.js readInWorker) gives each read a time limit and terminates
// this worker past it, or on Cancel; a worker that runs out of memory dies alone, and the page
// says so. A module worker: the readers are the page's own modules.
//
//   { kind: 'mesh', buf, format, name, extras, unit } -> { ok, raw (a .cadmesh), unitless }
//   { kind: '2d', buf, dwg }                           -> { ok, drawing }
//   a refusal                                          -> { ok: false, message }

onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.kind === 'mesh') {
      const { parseMesh } = await import('./mesh-formats.js');
      const { encodeCadmesh } = await import('./cadmesh.js');
      const { MM_PER } = await import('./units.js');
      const model = await parseMesh(m.format, m.buf, m.name, m.extras);
      // a file that stores no unit (STL, OBJ, PLY, OFF) is read in the unit the page names
      const unitless = !model.sourceUnits;
      if (unitless && m.unit !== 'mm') {
        const k = MM_PER[m.unit];
        for (const b of model.meshes) for (let i = 0; i < b.positions.length; i++) b.positions[i] *= k;
      }
      if (unitless) model.sourceUnits = m.unit;
      const raw = encodeCadmesh(model);
      postMessage({ ok: true, raw, unitless }, [raw]);
    } else {
      const { parseDXF } = await import('./dxf.js');
      const { readDWG, dwgToPairs } = await import('./dwg.js');
      // a DWG (js/dwg.js) is read into the group-code pairs a DXF holds; a DXF is passed as its
      // bytes: parseDXF reads a binary one from them, an ASCII one in the drawing's code page
      const drawing = parseDXF(m.dwg ? dwgToPairs(readDWG(m.buf)) : m.buf);
      postMessage({ ok: true, drawing });
    }
  } catch (e) {
    postMessage({ ok: false, message: String((e && e.message) || e) });
  }
};
