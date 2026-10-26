// How long a STEP / IGES / BREP conversion will take, and how far it is.
//
// Before it starts: a FORECAST of each step's time from what the file holds
// (js/step-features.js), with coefficients fitted to measured conversions
// (tests/estimate-calibrate.mjs; Node on a desktop CPU, 2026-10-25):
//
//   reading            0.192 s per MB           (16 files over 0.5 s: within
//                                               0.93-1.13 of the measured time)
//   building the parts 0.0238 s per 1000 records + 0.0053 s per 1000 of
//                      sum(wires per face ^ 1.5)
//   meshing            0.0241 s per 1000 records
//   writing the result 0.0057 s per 1000 records
//
// (meshing and writing fitted by absolute time, so the large assembly weighs
// in; refitted with the build that meshes all of that assembly's faces). The
// sum came within 0.69-1.70 of the measured time on the real files over
// 0.5 s, 0.92 on a 25.7 MB assembly. Meshing is the part the file's text
// cannot predict: a face with thousands of holes can mesh several times
// slower than the forecast (2.5 s against 0.9 s at 4000 holes). So while it runs:
//   - the device's speed is read off the first step (reading the file, which
//     tracks the file size closely) and scales the rest of the forecast;
//   - within a step, the time left leans from the forecast toward the step's
//     own pace as the step's fraction grows;
//   - once a step has run well past its forecast with no pace to go on, there
//     is no honest number, and timeLeft says so ({ over: true }).
// Steps (as the converter reports them): 1 reading, 2 building the parts,
// 3 meshing; after meshing reports 100% the result is still being written.

export const COEF = {
  read: 0.192, // s per MB
  transfer: [0.0238, 0.0053], // s per 1000 records, per 1000 of sum(wires^1.5)
  mesh: 0.0241, // s per 1000 records
  write: 0.0057, // s per 1000 records
};
const STEPS = ['read', 'transfer', 'mesh', 'write'];
// The multi-core converter (occt-progress/build.sh --threads) meshes faces on
// up to 4 threads: 7.41 s against 14.31 s on the 25.7 MB assembly. Its other
// steps run on one thread, as fast as the single-threaded build's.
export const THREADED_MESH = 0.52;

// Seconds per step on the reference machine. A file that is not STEP text
// (IGES, BREP) has only its size: the whole forecast is scaled from it.
// threaded: the conversion runs on the multi-core converter.
export function forecast(f, threaded = false) {
  const mb = f.bytes / 1e6;
  const meshScale = threaded ? THREADED_MESH : 1;
  if (!f.step) {
    // the real STEP files measured took 0.6-0.8 s per MB in all (1.5 for the
    // 25.7 MB assembly), split about 27 / 54 / 16 / 3%
    const total = 0.7 * mb;
    return { read: 0.27 * total, transfer: 0.54 * total, mesh: 0.16 * total * meshScale, write: 0.03 * total };
  }
  const k = f.entities / 1e3;
  return {
    read: COEF.read * mb,
    transfer: COEF.transfer[0] * k + COEF.transfer[1] * (f.bounds15 / 1e3),
    mesh: COEF.mesh * k * meshScale,
    write: COEF.write * k,
  };
}

export const forecastTotal = (fc) => STEPS.reduce((s, k) => s + fc[k], 0);

// Seconds of the (device-scaled) forecast already done: the steps before this
// one, and this one's share -- its fraction where it reports one, else the
// time spent in it, up to its forecast. For the bar.
export function forecastDone(fc, factor, step, fraction, inStep) {
  let done = 0;
  for (let i = 0; i < step; i++) done += fc[STEPS[i]] * factor;
  const expected = fc[STEPS[step]] * factor;
  const paced = step === 1 || step === 2;
  return done + (paced ? Math.min(1, Math.max(0, fraction || 0)) * expected : Math.min(inStep, expected));
}

// The device's speed against the reference machine, from the reading step:
// > 1 is slower. A read under half a second says too little, so it stays 1.
export function deviceFactor(fc, readSecs) {
  if (!(readSecs > 0.5) || !(fc.read > 0.05)) return 1;
  return Math.min(10, Math.max(0.25, readSecs / fc.read));
}

// The step index (0 read, 1 transfer, 2 mesh, 3 write) for a reported phase
// and fraction: meshing at 100% is writing the result.
export const stepOf = (phase, fraction) => (phase >= 3 && fraction >= 1 ? 3 : Math.min(3, Math.max(1, phase | 0)) - 1);

// Time left in seconds, or { over: true } when the current step has overrun
// its forecast and its own fraction gives nothing to go on.
//   fc       forecast(features)
//   factor   deviceFactor(...) (1 until the read step has finished)
//   step     stepOf(...)
//   fraction the step's reported fraction (0 for reading and writing)
//   inStep   seconds since the step started
//   quiet    seconds since the fraction last moved
// "Over" when the step has run past its forecast with no pace to go on, or
// when its fraction has not moved for 10 s: one large face can hold a step
// still for a minute after its small faces went by fast, so a pace taken
// from them would count down to zero while the work goes on.
export const QUIET_S = 10;
export function timeLeft(fc, factor, step, fraction, inStep, quiet = 0) {
  const name = STEPS[step];
  const expected = fc[name] * factor;
  let later = 0;
  for (let i = step + 1; i < STEPS.length; i++) later += fc[STEPS[i]] * factor;
  const paced = step === 1 || step === 2;
  const f = paced ? Math.min(1, Math.max(0, fraction || 0)) : 0;
  if (paced && quiet > QUIET_S) return { over: true };
  if (paced && f > 0.05 && f < 1) {
    // the pace when the fraction last moved said how long the rest would
    // take; standing still well past that, the pace no longer means anything
    const atMove = (inStep - quiet) * (1 - f) / f;
    if (quiet > Math.max(3, 1.5 * atMove)) return { over: true };
  }
  const byForecast = Math.max(0, expected - inStep);
  const byPace = f > 0.05 && f < 1 ? inStep * (1 - f) / f : null;
  if (byPace === null && inStep > expected) return { over: true };
  const here = byPace === null ? byForecast : (1 - f) * byForecast + f * byPace;
  return here + later;
}
