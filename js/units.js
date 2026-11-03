// Every quantity the viewer shows goes through here. The geometry is in mm
// (OpenCascade converts on import); the DISPLAY unit is one of mm, cm, m, in:
// the user's choice, or Auto, the unit the file declares (header.sourceUnits).
//
// Lengths have fixed decimals per unit, so a readout does not jump in width as
// it changes: for a measurement mm 0.01, cm 0.001, m 0.0001, in 0.001; a size
// or a section position one place fewer. Areas, volumes and masses have four
// significant digits, in a unit that keeps the number readable.

// Every length unit a file may declare, by the one short name the viewer uses
// for it (header.sourceUnits, the info panel), and mm per unit. Each reader
// maps its own format's vocabulary to these names (DXF $INSUNITS codes,
// js/dxf.js; 3MF's "millimeter", js/mesh-formats.js; a STEP or IGES unit,
// js/source-units.js) and takes the factor from here.
export const LENGTH_MM = {
  nm: 1e-6, um: 0.001, mm: 1, cm: 10, dm: 100, m: 1000, dam: 1e4, hm: 1e5, km: 1e6, Gm: 1e12,
  'Å': 1e-7, uin: 25.4e-6, mil: 0.0254, in: 25.4, ft: 304.8, 'US ft': 1200 / 3937 * 1000, yd: 914.4,
  mi: 1609344, AU: 1.495978707e14, ly: 9.4607304725808e18, pc: 3.0856775814913673e19,
};

// A unit as it is written for a reader: the short names above that are not plain letters
// spelled as typeset ("um" -> "µm")
const SPELLED = { um: 'µm', uin: 'µin' };
export const unitWord = (u) => SPELLED[u] || u;

// The units lengths may be shown in, one row each: its decimals for a measurement (a size or
// a section position one fewer), and its system (an area, volume and mass follow it: in², lb).
// main.js builds both unit pickers from this table.
const DISPLAY = [
  { id: 'mm', decimals: 2, system: 'metric' },
  { id: 'cm', decimals: 3, system: 'metric' },
  { id: 'm', decimals: 4, system: 'metric' },
  { id: 'in', decimals: 3, system: 'imperial' },
];
export const DISPLAY_UNITS = DISPLAY.map((d) => d.id);
export const MM_PER = Object.fromEntries(DISPLAY_UNITS.map((u) => [u, LENGTH_MM[u]]));
const DECIMALS = Object.fromEntries(DISPLAY.map((d) => [d.id, d.decimals]));
const imperial = (u) => DISPLAY.find((d) => d.id === u)?.system === 'imperial';

// The display unit Auto gives for a declared unit: itself when it is a display row; the
// nearest display row of the same system otherwise (by the ratio of their sizes, the smaller on
// a tie: dm is cm); mm when the file says nothing (null) or its shapes disagree ('mixed').
// Derived from the two tables, so a new display row (ft) is Auto's answer for its own unit.
const IMPERIAL = new Set(['uin', 'mil', 'in', 'ft', 'US ft', 'yd', 'mi']);
const AUTO = Object.fromEntries(Object.keys(LENGTH_MM).map((u) => {
  if (DISPLAY_UNITS.includes(u)) return [u, u];
  const system = IMPERIAL.has(u) ? 'imperial' : 'metric';
  const far = (d) => Math.abs(Math.log(LENGTH_MM[d.id] / LENGTH_MM[u]));
  const near = DISPLAY.filter((d) => d.system === system).sort((a, b) => far(a) - far(b) || LENGTH_MM[a.id] - LENGTH_MM[b.id])[0];
  return [u, near ? near.id : 'mm'];
}));
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
  if (imperial(unit)) {
    const in2 = mm2 / LENGTH_MM.in ** 2;
    return in2 < 1e4 ? `${sig4(in2)} in²` : `${sig4(in2 / 144)} ft²`;
  }
  if (mm2 < 1e4) return `${sig4(mm2)} mm²`;
  if (mm2 / 100 < 1e4) return `${sig4(mm2 / 100)} cm²`;
  return `${sig4(mm2 / 1e6)} m²`;
}

export function fmtVolume(mm3, unit) {
  if (imperial(unit)) {
    const in3 = mm3 / LENGTH_MM.in ** 3;
    return in3 < 1e5 ? `${sig4(in3)} in³` : `${sig4(in3 / 1728)} ft³`;
  }
  if (mm3 < 1e3) return `${sig4(mm3)} mm³`;
  if (mm3 / 1e3 < 1e6) return `${sig4(mm3 / 1e3)} cm³`;
  return `${sig4(mm3 / 1e9)} m³`;
}

// grams -> g or kg, or lb when the display unit is imperial
export function fmtMass(g, unit) {
  if (imperial(unit)) return `${sig4(g / 453.59237)} lb`;
  return g < 1000 ? `${sig4(g)} g` : `${sig4(g / 1000)} kg`;
}
