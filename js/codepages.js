// A drawing's code page, the one table: the number a DWG's header holds (bytes 0x13-0x14), the
// name a DXF's $DWGCODEPAGE gives, and the decoder for its bytes. Used by js/dwg.js (a DWG's
// strings to R2004, and the $DWGCODEPAGE it writes into its pairs), js/dxf.js (an ASCII DXF's
// text, and %%nnn in a TEXT). Three copies of this rule disagreed (a DWG's page 29 read as Thai).
//
// The DWG numbers were read off the drawings at hand, each against the $DWGCODEPAGE its answer key
// states (ODA's, LibreDWG's or AutoCAD's own DXF beside it): 12 dos850, 28 ANSI_1250, 29 ANSI_1251,
// 30 ANSI_1252, 39 ANSI_936. 32-37 continue the ANSI run (33's and 34's R2007 files hold Turkish
// and Hebrew text); 31 is not known here and is read as Latin-1.
//
// Pure ES module, no DOM.

export const DWG_CODEPAGES = {
  12: 'DOS850', 28: 'ANSI_1250', 29: 'ANSI_1251', 30: 'ANSI_1252', 32: 'ANSI_1253', 33: 'ANSI_1254',
  34: 'ANSI_1255', 35: 'ANSI_1256', 36: 'ANSI_1257', 37: 'ANSI_874', 38: 'ANSI_932', 39: 'ANSI_936',
  40: 'ANSI_949', 41: 'ANSI_950',
};

const NAMED = { ANSI_874: 'windows-874', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5', DOS850: 'ibm850', CP850: 'ibm850' };
// a $DWGCODEPAGE name (any case) -> a decoder label, or null for one this does not know
export function codePageLabel(name) {
  const c = String(name || '').trim().toUpperCase();
  if (NAMED[c]) return NAMED[c];
  return /^ANSI_(125\d)$/.test(c) ? `windows-${c.slice(5)}` : null;
}

// code page 850's upper half (TextDecoder has no 850: Python's cp850 codec, 0x80..0xFF)
const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';
const ibm850 = {
  encoding: 'ibm850',
  decode(u8) {
    const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8 || []);
    let s = '';
    for (let i = 0; i < b.length; i++) s += b[i] < 0x80 ? String.fromCharCode(b[i]) : CP850[b[i] - 0x80];
    return s;
  },
};

// \M+NXXXX: a double-byte character of code page N (DXF reference: 1 Japanese, 2 Traditional
// Chinese, 3 Korean, 5 Simplified Chinese)
export const MBCS = { 1: 'shift_jis', 2: 'big5', 3: 'euc-kr', 5: 'gbk' };
// the double-byte pages: no character for one byte (a %%nnn in such a drawing reads as 1252)
export const isDoubleByte = (label) => Object.values(MBCS).includes(label);

// A DXF's text decoder, the one choice for its ASCII and its binary form: UTF-8 from R2007 (AC1021);
// before, the code page its header names; with none named, UTF-8 when every string is valid UTF-8,
// else 1252 (isUtf8: does the text decode as UTF-8 -- the two readers fell back to different
// pages, and one drawing read "Ø20 ±0.1" as ASCII, "Ã˜20 Â±0.1" as binary)
export function dxfDecoder(acadver, pageName, isUtf8) {
  if (Number(acadver) >= 1021) return decoderFor('utf-8');
  const named = decoderFor(codePageLabel(pageName));
  if (named) return named;
  return isUtf8() ? decoderFor('utf-8') : decoderFor('windows-1252');
}

// windows-1252's 0x80..0x9F, by the Encoding standard's index (0x81, 0x8D, 0x8F, 0x90 and 0x9D are
// themselves). A runtime whose TextDecoder reads them as Latin-1 (Node 20: 0x80 "\u0080", where
// browsers and Node 22 read "€") gets them from here, so a drawing's text is the same everywhere
// (r112 b)
const W1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
export const cp1252Over = (dec) => ({
  encoding: 'windows-1252',
  decode: (u8, o) => dec.decode(u8, o).replace(/[\x80-\x9f]/g, (c) => W1252_HIGH[c.charCodeAt(0) - 0x80]),
});

// a decoder for a label (a TextDecoder, or the 850 table), or null when there is none
const made = {};
export function decoderFor(label) {
  if (!label) return null;
  if (label === 'ibm850') return ibm850;
  if (!(label in made)) { try { made[label] = new TextDecoder(label); } catch { made[label] = null; } }
  if (label === 'windows-1252' && made[label] && made[label].decode(Uint8Array.of(0x80)) !== '€') made[label] = cp1252Over(made[label]);
  return made[label];
}
