// The length unit a CAD file DECLARES, read from its text before conversion.
// OpenCascade converts the geometry to mm on import (DEFAULT_TESSELLATION.
// linearUnit); this only records what the file was drawn in, for the display
// unit's Auto choice. The answer is a short name ('mm', 'cm', 'm', 'in', 'ft',
// ...), 'mixed' when the file's shapes disagree, or null for unknown (never mm).
//
// STEP: the unit in force is the one a GLOBAL_UNIT_ASSIGNED_CONTEXT names, and
// only contexts a shape representation uses count. Its length member is either
// an SI_UNIT (prefix + METRE) or a CONVERSION_BASED_UNIT, which is identified
// by the factor of its LENGTH_MEASURE_WITH_UNIT (25.4 mm = in), not by its name
// text: an inch is defined through an SI_UNIT(.MILLI.,.METRE.) base, so
// matching text reads an inch file as mm. Records may span lines and refer
// forward, so the pass collects the unit-related records first and resolves
// after. A ';' inside a string ends a record early here; units never need one.
//
// IGES: the global section's units flag (parameter 14), with the unit name
// (parameter 15) when the flag is 3. BREP stores no unit.

// mm per unit -> name
const BY_FACTOR = [[1, 'mm'], [10, 'cm'], [1000, 'm'], [1e6, 'km'], [1e-3, 'um'],
  [25.4, 'in'], [304.8, 'ft'], [914.4, 'yd'], [0.0254, 'mil'], [2.54e-5, 'uin']];
const SI_PREFIX = { '$': 1, EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2,
  DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12 };

export function unitOfFactor(mm) {
  if (!(mm > 0)) return null;
  for (const [f, name] of BY_FACTOR) if (Math.abs(mm / f - 1) < 1e-6) return name;
  return null;
}

export function sourceUnits(buf, format) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (format === 'step') return stepUnits(u8);
  if (format === 'iges') return igesUnits(u8);
  return null;
}

// a record's text with the line breaks taken out (writers wrap anywhere)
const flat = (s) => s.replace(/[\r\n]/g, '');
// the '#n' references in a piece of record text
const refs = (s) => (s.match(/#\d+/g) || []).map((r) => Number(r.slice(1)));

export function stepUnits(u8) {
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 64));
  if (!/ISO-10303-21/.test(head)) return null;
  const units = new Map(); // id -> record text: units, measures, contexts
  const used = new Set(); // context ids a shape representation names
  // only records naming a unit or a shape representation are kept
  const re = /#(\d+)\s*=\s*([^;]*?(?:UNIT|SHAPE_REPRESENTATION)[^;]*);/g;
  const dec = new TextDecoder('latin1');
  const SLICE = 4 << 20;
  let carry = '';
  for (let at = 0; at < u8.byteLength; at += SLICE) {
    const last = at + SLICE >= u8.byteLength;
    let text = carry + dec.decode(u8.subarray(at, Math.min(u8.byteLength, at + SLICE)));
    const cut = last ? text.length : text.lastIndexOf(';') + 1;
    carry = text.slice(cut);
    text = flat(text.slice(0, cut));
    for (let m; (m = re.exec(text));) {
      const body = m[2];
      // REPRESENTATION(name, items, context): the context is the last argument.
      // CONTEXT_DEPENDENT_SHAPE_REPRESENTATION and the relationships are not
      // representations and name no context.
      const t = /^\s*([A-Z_0-9]+)\s*\(/.exec(body);
      if (t && /(^|_)SHAPE_REPRESENTATION$/.test(t[1]) && !/^CONTEXT_DEPENDENT_/.test(t[1])) {
        const r = /#(\d+)\s*\)\s*$/.exec(body);
        if (r) used.add(Number(r[1]));
      }
      if (/UNIT/.test(body)) units.set(Number(m[1]), body);
    }
  }
  const lengthMm = (id, depth = 0) => {
    const s = units.get(id);
    if (!s || depth > 8 || !/LENGTH_UNIT/.test(s) && depth === 0) return null;
    const si = /SI_UNIT\s*\(\s*(?:\.([A-Z]+)\.|\$)\s*,\s*\.METRE\.\s*\)/.exec(s);
    if (si) {
      const p = si[1] ? SI_PREFIX[si[1]] : 1;
      return p ? p * 1000 : null;
    }
    const cb = /CONVERSION_BASED_UNIT\s*\(\s*'(?:[^']|'')*'\s*,\s*#(\d+)\s*\)/.exec(s);
    if (!cb) return null;
    // the measure: LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#base)
    const ms = units.get(Number(cb[1]));
    const mv = ms && /LENGTH_MEASURE\s*\(\s*([-+0-9.Ee]+)\s*\)\s*,\s*#(\d+)/.exec(ms);
    if (!mv) return null;
    const base = lengthMm(Number(mv[2]), depth + 1);
    return base === null ? null : Number(mv[1]) * base;
  };
  const answers = new Set();
  for (const [id, s] of units) {
    const g = /GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\(([^)]*)\)/.exec(s);
    if (!g || (used.size && !used.has(id))) continue;
    // the context's units name a length, an angle and a solid angle: the
    // length one is the member carrying LENGTH_UNIT
    const len = refs(g[1]).find((r) => /LENGTH_UNIT/.test(units.get(r) || ''));
    if (len === undefined) continue;
    answers.add(unitOfFactor(lengthMm(len)));
  }
  if (answers.size > 1) return 'mixed';
  return answers.size ? [...answers][0] : null;
}

// IGES units flag -> name (flag 3: the name parameter says)
const IGES_FLAG = { 1: 'in', 2: 'mm', 4: 'ft', 6: 'm', 7: 'km', 8: 'mil', 9: 'um', 10: 'cm', 11: 'uin' };
const IGES_NAME = { IN: 'in', INCH: 'in', MM: 'mm', FT: 'ft', M: 'm', KM: 'km', MIL: 'mil', UM: 'um', CM: 'cm', UIN: 'uin' };

export function igesUnits(u8) {
  // fixed 80-column lines; column 73 is the section letter. Only the start
  // of the file is read: S and G come first.
  const text = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(u8.byteLength, 1 << 16)));
  let g = '';
  for (const line of text.split(/\r?\n/)) if (line[72] === 'G') g += line.slice(0, 72);
  if (!g) return null;
  // parameters 1 and 2 may redefine the delimiters, as 1Hx; default , and ;
  let i = 0;
  const delim = [',', ';'];
  for (let k = 0; k < 2; k++) {
    if (g.startsWith('1H', i)) { delim[k] = g[i + 2]; i += 3; }
    if (g[i] === delim[0]) i++;
  }
  // the rest: Hollerith strings (nHtext) may hold the delimiters
  const params = [delim[0], delim[1]];
  while (i < g.length && params.length < 15) {
    let val = '';
    const h = /^\s*(\d+)H/.exec(g.slice(i));
    if (h) {
      const n = Number(h[1]);
      i += h[0].length;
      val = g.slice(i, i + n);
      i += n;
    }
    while (i < g.length && g[i] !== delim[0] && g[i] !== delim[1]) val += g[i++];
    params.push(val.trim());
    if (g[i] === delim[1]) break;
    i++;
  }
  const flag = Number(params[13]);
  if (flag === 3) return IGES_NAME[(params[14] || '').toUpperCase()] || null;
  return IGES_FLAG[flag] || null;
}
