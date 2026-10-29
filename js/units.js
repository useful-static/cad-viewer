// Every quantity the viewer shows goes through here. The geometry is in mm
// (OpenCascade converts on import); the DISPLAY unit is one of mm, cm, m, in:
// the user's choice, or Auto, the unit the file declares (header.sourceUnits).
//
// Lengths have fixed decimals per unit, so a readout does not jump in width as
// it changes: for a measurement mm 0.01, cm 0.001, m 0.0001, in 0.001; a size
// or a section position one place fewer. Areas, volumes and masses have four
// significant digits, in a unit that keeps the number readable.

export const DISPLAY_UNITS = ['mm', 'cm', 'm', 'in'];
const MM_PER = { mm: 1, cm: 10, m: 1000, in: 25.4 };
const DECIMALS = { mm: 2, cm: 3, m: 4, in: 3 };

// The display unit Auto gives for a declared unit: itself when it is one of
// the four; the nearest of them in the same system otherwise; mm when the
// file says nothing (null) or its shapes disagree ('mixed').
const AUTO = { mm: 'mm', cm: 'cm', m: 'm', in: 'in', ft: 'in', yd: 'in', mil: 'in', uin: 'in', um: 'mm', km: 'm' };
// sizeMm: the model's largest extent. A model declared in metres but under a
// metre across is shown in mm: a 123 mm board in m read "0.123 × 0.072 ×
// 0.012 m" and its small parts "0.000 m" (a board's STEP declares metres:
// the live end-to-end review). Its declared unit is still named in the info.
export const autoUnit = (declared, sizeMm = Infinity) => {
  const u = AUTO[declared] || 'mm';
  return u === 'm' && sizeMm < 1000 ? 'mm' : u;
};

// the unit in force: an explicit choice wins over Auto
export const displayUnit = (choice, declared, sizeMm) => (DISPLAY_UNITS.includes(choice) ? choice : autoUnit(declared, sizeMm));

const sig4 = (x) => x.toLocaleString('en-US', { maximumSignificantDigits: 4 });

// mm -> the number alone ('5080.0'), for a row whose label carries the unit.
// kind: 'measure', or 'size' / 'section' (one decimal fewer)
export function fmtNum(mm, kind, unit) {
  const d = DECIMALS[unit] - (kind === 'measure' ? 0 : 1);
  return (mm / MM_PER[unit]).toFixed(d);
}

export const fmtLength = (mm, kind, unit) => `${fmtNum(mm, kind, unit)} ${unit}`;

export function fmtArea(mm2, unit) {
  if (unit === 'in') {
    const in2 = mm2 / 25.4 ** 2;
    return in2 < 1e4 ? `${sig4(in2)} in²` : `${sig4(in2 / 144)} ft²`;
  }
  if (mm2 < 1e4) return `${sig4(mm2)} mm²`;
  if (mm2 / 100 < 1e4) return `${sig4(mm2 / 100)} cm²`;
  return `${sig4(mm2 / 1e6)} m²`;
}

export function fmtVolume(mm3, unit) {
  if (unit === 'in') {
    const in3 = mm3 / 25.4 ** 3;
    return in3 < 1e5 ? `${sig4(in3)} in³` : `${sig4(in3 / 1728)} ft³`;
  }
  if (mm3 < 1e3) return `${sig4(mm3)} mm³`;
  if (mm3 / 1e3 < 1e6) return `${sig4(mm3 / 1e3)} cm³`;
  return `${sig4(mm3 / 1e9)} m³`;
}

// grams -> g or kg, or lb when the display unit is in
export function fmtMass(g, unit) {
  if (unit === 'in') return `${sig4(g / 453.59237)} lb`;
  return g < 1000 ? `${sig4(g)} g` : `${sig4(g / 1000)} kg`;
}
