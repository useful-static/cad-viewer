// The edge list and body facts (js/edges.js) for a .cadmesh that does not
// carry them (one converted before they existed), off the main thread. The
// page sends COPIES of the model's position and index arrays, never the
// buffers it draws from, and gets the result back transferred.

import { buildEdges } from './edges.js';

onmessage = (ev) => {
  const { position, index, meshes, silhouetteCap } = ev.data;
  try {
    const t0 = performance.now();
    const r = buildEdges({ position, index, meshes }, silhouetteCap ? { silhouetteCap } : {});
    const ms = performance.now() - t0;
    const transfer = [r.edges.buffer, r.silhouettes?.buffer, r.silhouetteNormals?.buffer].filter(Boolean);
    postMessage({ ok: true, result: r, ms }, transfer);
  } catch (e) {
    postMessage({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};
