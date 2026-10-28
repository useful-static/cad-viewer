// In-browser STEP / IGES / BREP import: OpenCascade (occt-import-js, WASM)
// tessellates the file off the main thread and posts back a .cadmesh buffer.
// A classic worker, because occt-import-js is an emscripten script that
// expects importScripts(); the format code is pulled in with dynamic import().
// Messages to the page say "the converter", never the library's name.
//
// The WASM is not in git (binary): fetch-deps.sh stages it
// into ../vendor/occt-import-js/.

// threads: the multi-core build (js/converter-choice.js), in mt/ beside the
// single-threaded one
const vendorDir = (threads) => new URL(`../vendor/occt-import-js/${threads ? 'mt/' : ''}`, self.location.href).href;

onmessage = async (ev) => {
  const { buffer, format, params, threads } = ev.data;
  const VENDOR = vendorDir(threads);
  try {
    const post = (stage, converting = false) => postMessage({ type: 'progress', stage, converting });
    post('loading the converter');
    // what the file holds, for the page's time forecast (js/import-progress.js)
    const { stepFeatures } = await import('./step-features.js');
    postMessage({ type: 'features', features: stepFeatures(buffer) });
    // A converter that cannot be loaded (offline, a dropped connection, or not
    // on this site) is said as such, never as a crash, an out-of-memory or
    // a "run fetch-deps.sh" to a visitor (review r23)
    const unavailable = () => new Error('converter unavailable: it could not be downloaded (offline, or the connection dropped). '
      + 'Reconnect and open the file again');
    try {
      importScripts(`${VENDOR}occt-import-js.js`);
    } catch (e) {
      throw unavailable();
    }
    const fmt = await import('./cadmesh.js');
    // the unit the file declares, read before the converter sees the bytes
    const { sourceUnits } = await import('./source-units.js');
    const declared = sourceUnits(buffer, format);
    // Our build of occt-import-js (occt-progress/) calls onProgress(phase,
    // fraction) from inside the import: 1 = reading the file (start / end
    // only), 2 = building the parts, 3 = meshing. The stock npm build never
    // calls it, and the page then goes by its forecast alone.
    // (its 12 MB WebAssembly is fetched here: a failed fetch is the same case)
    const occt = await self.occtimportjs({
      locateFile: (p) => VENDOR + p,
      // the multi-core build starts its threads from this script; left to
      // itself it would take this worker's own URL
      mainScriptUrlOrBlob: `${VENDOR}occt-import-js.js`,
      onProgress: (phase, fraction) => postMessage({ type: 'occt', phase, fraction }),
    }).catch((e) => { throw /fetch|network|load|404/i.test(String(e && e.message ? e.message : e)) ? unavailable() : e; });
    post(`converting ${format.toUpperCase()} (${(buffer.byteLength / 1e6).toFixed(1)} MB)`, true);
    const t0 = performance.now();
    const tess = params || fmt.DEFAULT_TESSELLATION;
    const result = occt.ReadFile(format, new Uint8Array(buffer), tess);
    const t1 = performance.now();
    post('packing mesh');
    const model = fmt.occtResultToModel(result);
    model.sourceUnits = declared;
    model.angularDeflection = tess.angularDeflection;
    const out = fmt.encodeCadmesh(model);
    postMessage({ type: 'done', buffer: out, ms: Math.round(t1 - t0), unmeshedFaces: model.unmeshedFaces }, [out]);
  } catch (e) {
    postMessage({ type: 'error', message: String(e && e.message ? e.message : e) });
  }
};
