// Every quantity the viewer shows goes through here. The geometry is in its
// header's units: mm for every reader of ours (OpenCascade converts on import);
// a .cadmesh from another writer in another unit is shown in that unit "(not
// converted)" -- its lengths, volume and area (fmtUnconverted) -- and refused by
// the exports, Save drawing and the mass (js/cadmesh.js geomIsMm). The DISPLAY unit is one of mm, cm, m, in:
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
  // (the US survey inch, yard and mile, $INSUNITS 22-24: the table stopped at 21 -- r88 Q3)
  'US in': 1000 / 39.37, 'US yd': 3600 / 3937 * 1000, 'US mi': 6336 / 3937 * 1e6,
};

// A geometry unit as a header may name it -- a short name above, OpenCascade's word ("inch",
// "millimeter"), in any case -- as its LENGTH_MM name, or null for one with no length known here.
// One name per unit for a scene's comparison and its offsets (r86 A5, A8: "in" and "inch" were two
// units, and a scene's mm offsets went into inch positions as inches).
const LONG_NAMES = {
  nanometer: 'nm', nanometre: 'nm', micrometer: 'um', micrometre: 'um', micron: 'um', millimeter: 'mm', millimetre: 'mm',
  centimeter: 'cm', centimetre: 'cm', decimeter: 'dm', decimetre: 'dm', meter: 'm', metre: 'm', kilometer: 'km', kilometre: 'km',
  inch: 'in', foot: 'ft', feet: 'ft', yard: 'yd', mile: 'mi',
  'µm': 'um', 'μm': 'um', 'µin': 'uin', 'μin': 'uin', // (the micro sign and the Greek mu, as unitWord writes them: r88 A7)
};
// (each name's plural too: "inches" was one and "millimeters" not -- r87 A1)
for (const [n, k] of Object.entries({ ...LONG_NAMES })) if (n !== 'feet' && n !== 'foot') LONG_NAMES[n.endsWith('ch') ? `${n}es` : `${n}s`] = k;
// The words for a unit in a sentence ("millimetres", "inches"), its short name past these: the one
// table the scene's refusal and the re-read's words read (r87 A5: three tables disagreed)
const SAID = { mm: 'millimetres', cm: 'centimetres', m: 'metres', um: 'micrometres', in: 'inches', ft: 'feet', yd: 'yards' };
export const unitSaid = (k) => SAID[k] || (Object.hasOwn(LENGTH_MM, k) ? unitWord(k) : String(k));
export function lengthUnitOf(word) {
  if (typeof word !== 'string') return null;
  const w = word.trim();
  if (Object.hasOwn(LENGTH_MM, w)) return w;
  const l = w.toLowerCase();
  if (Object.hasOwn(LONG_NAMES, l)) return LONG_NAMES[l];
  // (a short name folds case only written in one case, "MM" or "IN": "Mm", a megametre, was taken as
  // millimetres and shown and exported so -- r88 A7)
  if (w !== w.toUpperCase() && w !== l) return null;
  return Object.keys(LENGTH_MM).find((k) => k.toLowerCase() === l) || null;
}

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
const IMPERIAL = new Set(['uin', 'mil', 'in', 'ft', 'US ft', 'yd', 'mi', 'US in', 'US yd', 'US mi']);
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

// (the unit as written, unitWord: "µm", never the id "um")
export const fmtLength = (mm, kind, unit) => `${fmtNum(mm, kind, unit)} ${unitWord(unit)}`;

export function fmtArea(mm2, unit) {
  if (imperial(unit)) {
    const in2 = mm2 / LENGTH_MM.in ** 2;
    return in2 < 1e4 ? `${sig4(in2)} in²` : `${sig4(in2 / 144)} ft²`;
  }
  if (mm2 < 1e4) return `${sig4(mm2)} mm²`;
  if (mm2 / 100 < 1e4) return `${sig4(mm2 / 100)} cm²`;
  return `${sig4(mm2 / 1e6)} m²`;
}

// A volume (power 3) or an area (power 2) of a model whose geometry is in a unit the viewer does not
// convert (js/cadmesh.js geomIsMm false): in that unit, as its lengths are shown -- fmtVolume and
// fmtArea read their number as mm³ / mm², and an inch cube read "≈ 1 mm³" (r86 A4)
// A length of geometry in a unit not converted (word: the header's), as a plain number that may be
// typed back: by that unit's own decimals where it is a display unit -- one length, one precision,
// converted or not; at 4 significant digits 120.375 in read "120.4" and Enter moved the cut (r87 Q3,
// r88 A3) -- else to 6 significant digits, at least as many as a display unit's.
// size: the model's largest extent, in its own units, for Auto's choice (unconvertedUnit); Infinity
// keeps the unit (a drawing's, whose label names it). noise: below it, 0 (a 2D circle's centre
// averaged from its points). The one rule for a length in a unit not converted -- the 3D panel's,
// the 2D info's and 2D Measure's: three copies, 2D Measure's "123457 mm" where 3D said "123456.79",
// and a noise floor in one alone (r89 A5, Q3)
export function unconvertedNum(x, kind = 'measure', word = null, size = Infinity, noise = 0) {
  if (!Number.isFinite(x)) return String(x);
  if (Math.abs(x) < noise) x = 0;
  const d = unconvertedUnit(word, size);
  if (d) return fmtNum(x * LENGTH_MM[lengthUnitOf(word)], kind, d);
  return String(Number(x.toPrecision(6)));
}
// The display unit such a length is shown in, where the header's unit is a display row: Auto's
// choice for that unit, as the converted path makes it -- a model in metres under a metre across in
// mm; in m, a 0.4 mm part read "0.000" and a part 0.4 mm above its board "none above" (r89 Q1).
// null where the header's unit is no display row (its lengths in that unit, unconvertedNum's 6 digits)
export function unconvertedUnit(word, size = Infinity) {
  const u = lengthUnitOf(word);
  return u && Object.hasOwn(MM_PER, u) ? autoUnit(u, size * MM_PER[u]) : null;
}
// A length typed in the unit unconvertedUnit shows, back in the model's own units
export function unconvertedBack(v, word, size = Infinity) {
  const d = unconvertedUnit(word, size);
  return d ? (v * MM_PER[d]) / LENGTH_MM[lengthUnitOf(word)] : v;
}
// A header's unit as written for a reader: its one name's spelling where it has one ("in" for
// "INCH"), else as the header gives it -- printed as written, "12 INCH³" (r88 A8)
export const headerUnitWord = (word) => { const u = lengthUnitOf(word); return u ? unitWord(u) : String(word); };
export function fmtUnconverted(x, unit, power) {
  return `${sig4(x)} ${unit}${power === 3 ? '³' : '²'} (not converted)`;
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
