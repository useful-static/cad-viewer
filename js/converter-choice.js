// Which converter build a STEP / IGES / BREP import runs on: the multi-core one
// (vendor/occt-import-js/mt/, occt-progress/build.sh --threads) or the
// single-threaded one (vendor/occt-import-js/).
//
// The multi-core build meshes faces on up to 4 threads, with the same result:
// on a 25.7 MB assembly the conversion took 38.4 s against 44.6 s. Its cost is
// memory -- 1.6 GB of WASM at its peak against 0.7 GB, from the thread-friendly
// allocator it needs -- so it runs only where that is safe:
//   - the page is cross-origin isolated (threads need SharedArrayBuffer, which
//     browsers give only to a page served with COOP + COEP headers);
//   - the device has at least 4 cores (fewer gain nothing);
//   - it is not a phone or tablet: there a tab out of memory can be closed by
//     the system, with no error for the page to retry from;
//   - it has 8 GB of memory or more, where the browser says (Chromium's
//     navigator.deviceMemory, capped at 8; Firefox and Safari do not say).
// When the multi-core conversion fails or leaves faces unmeshed, the page
// converts again on the single-threaded build.

export const THREADED_MIN_CORES = 4;
export const THREADED_MIN_MEMORY_GB = 8;
const HANDHELD = /Mobi|Android|iPhone|iPad|iPod/i;

// env: { isolated, cores, memoryGB (undefined when the browser does not say),
//        ua, mobile, touchPoints }
export function useThreads(env) {
  if (!env.isolated || !(env.cores >= THREADED_MIN_CORES)) return false;
  if (env.mobile || HANDHELD.test(env.ua || '')) return false;
  // an iPad's Safari says "Macintosh"; a Mac has no touch screen
  if (/Macintosh/.test(env.ua || '') && env.touchPoints > 1) return false;
  return typeof env.memoryGB !== 'number' || env.memoryGB >= THREADED_MIN_MEMORY_GB;
}

// The environment of this page or worker.
export const browserEnv = (g = globalThis) => ({
  isolated: !!g.crossOriginIsolated,
  cores: g.navigator?.hardwareConcurrency,
  memoryGB: g.navigator?.deviceMemory,
  ua: g.navigator?.userAgent,
  mobile: g.navigator?.userAgentData?.mobile,
  touchPoints: g.navigator?.maxTouchPoints,
});
