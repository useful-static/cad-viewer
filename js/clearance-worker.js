// Clearance (js/clearance.js) off the page thread: two triangle trees over a model of millions of
// triangles took the tab for seconds (9.6 M triangles, 10.8 s). The page sends COPIES of the
// model's position, index and normal arrays, never the buffers it draws from, and the two sets;
// the result comes back as clearance() returns it.

import { clearance } from './clearance.js';

onmessage = (ev) => {
  const { position, index, normal, trisA, trisB, solidA, solidB } = ev.data;
  try {
    const t0 = performance.now();
    const r = clearance(position, index, trisA, trisB, { solidA, solidB, normal });
    postMessage({ ok: true, result: r, ms: performance.now() - t0 });
  } catch (e) {
    postMessage({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};
