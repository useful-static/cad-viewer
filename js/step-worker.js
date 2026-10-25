// In-browser STEP / IGES / BREP import: OpenCascade (occt-import-js, WASM)
// tessellates the file off the main thread and posts back a .cadmesh buffer.
// A classic worker, because occt-import-js is an emscripten script that
// expects importScripts(); the format code is pulled in with dynamic import().
//
// The WASM is not in git (binary): fetch-deps.sh stages it
// into ../vendor/occt-import-js/.

const VENDOR = new URL('../vendor/occt-import-js/', self.location.href).href;

onmessage = async (ev) => {
  const { buffer, format, params } = ev.data;
  try {
    const post = (stage) => postMessage({ type: 'progress', stage });
    post('loading OpenCascade (WASM)');
    try {
      importScripts(`${VENDOR}occt-import-js.js`);
    } catch (e) {
      throw new Error('occt-import-js is not staged: run fetch-deps.sh');
    }
    const fmt = await import('./cadmesh.js');
    // Our build of occt-import-js (occt-progress/) calls onProgress(phase,
    // fraction) from inside the import: 1 = reading the file (start / end
    // only), 2 = transferring into OpenCascade, 3 = meshing. The stock npm
    // build never calls it, and the page then falls back to an estimate.
    const occt = await self.occtimportjs({
      locateFile: (p) => VENDOR + p,
      onProgress: (phase, fraction) => postMessage({ type: 'occt', phase, fraction }),
    });
    post(`tessellating ${format.toUpperCase()} (${(buffer.byteLength / 1e6).toFixed(1)} MB)`);
    const t0 = performance.now();
    const result = occt.ReadFile(format, new Uint8Array(buffer), params || fmt.DEFAULT_TESSELLATION);
    const t1 = performance.now();
    post('packing mesh');
    const out = fmt.encodeCadmesh(fmt.occtResultToModel(result));
    postMessage({ type: 'done', buffer: out, ms: Math.round(t1 - t0) }, [out]);
  } catch (e) {
    postMessage({ type: 'error', message: String(e && e.message ? e.message : e) });
  }
};
