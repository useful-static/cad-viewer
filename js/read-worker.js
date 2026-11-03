// The mesh and 2D readers, off the page's thread: a file the viewer opens without converting
// (STL, OBJ, PLY, OFF, 3MF, glTF / GLB; DXF, DWG) is read here, so a slow or hostile file never
// freezes the tab. The page (main.js readInWorker) gives each read a time limit and terminates
// this worker past it, or on Cancel; a worker that runs out of memory dies alone, and the page
// says so. A module worker: the read is the page's own (js/read-file.js).
//
//   (on start)                                         -> { ready: true }
//   { kind: 'mesh', buf, format, name, extras, unit }  -> { ok, raw (a .cadmesh), unitless }
//   { kind: '2d', buf, dwg }                           -> { ok, drawing }
//   a refusal                                          -> { ok: false, message }

import { readDrawing, readMeshFile } from './read-file.js';

onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.kind === 'mesh') {
      const { raw, unitless } = await readMeshFile(m);
      postMessage({ ok: true, raw, unitless }, [raw]);
    } else {
      postMessage({ ok: true, drawing: readDrawing(m) });
    }
  } catch (e) {
    postMessage({ ok: false, message: String((e && e.message) || e) });
  }
};
// (its modules loaded: from here an error is the read's, not a worker that could not start)
postMessage({ ready: true });
