// The mesh and 2D readers, off the page's thread: a file the viewer opens without converting
// (STL, OBJ, PLY, OFF, 3MF, glTF / GLB; DXF, DWG) is read here, so a slow or hostile file never
// freezes the tab. The page (main.js readInWorker) gives each read a time limit and terminates
// this worker past it, or on Cancel; a worker that runs out of memory dies alone, and the page
// says so. A module worker: the read is the page's own (js/read-file.js).
//
//   (on start)                                         -> { ready: true }
//   { kind: 'mesh', buf, format, name, extras, unit }  -> { ok, raw (a .cadmesh), unitless }
//   { kind: '2d', buf, format, name }                  -> { ok, drawing }  (format: 'DXF' | 'DWG', js/formats.js drawingReaderOf)
//   { kind: 'check', mesh, format, buf, name, files }  -> { ok }  (the list check's read: js/list-check.js readOffThread)
//   { kind: 'save', key, raw, name }                   -> { ok }  (a conversion gzipped and kept: main.js saveConversion)
//   a refusal                                          -> { ok: false, message }

import { readDrawing, readMeshFile } from './read-file.js';
import { parseMesh } from './mesh-formats.js';

onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.kind === 'save') {
      // (gzipped here: on the page's thread a converted rack's gzip froze it 2 s, 12 s on a slow
      // phone, with its first frame not yet drawn -- R175-2)
      const { deflateCadmesh } = await import('./cadmesh.js');
      const { cachePut } = await import('./mesh-cache.js');
      const data = typeof CompressionStream === 'function' ? await deflateCadmesh(m.raw) : m.raw;
      await cachePut(m.key, data, m.name);
      postMessage({ ok: true });
    } else if (m.kind === 'mesh') {
      const { raw, unitless } = await readMeshFile(m);
      postMessage({ ok: true, raw, unitless }, [raw]);
    } else if (m.kind === 'check') {
      // (the list check's read: the reader alone, its refusal or nothing -- off the check page's
      // thread, under its limit, as the page reads: r87 Q1)
      if (m.mesh) await parseMesh(m.format, m.buf, m.name, m.files);
      else readDrawing(m);
      postMessage({ ok: true });
    } else {
      postMessage({ ok: true, drawing: readDrawing(m) });
    }
  } catch (e) {
    postMessage({ ok: false, message: String((e && e.message) || e) });
  }
};
// (its modules loaded: from here an error is the read's, not a worker that could not start)
postMessage({ ready: true });
