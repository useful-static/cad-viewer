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

// a decoder for a label (a TextDecoder, or the 850 table), or null when there is none
const made = {};
export function decoderFor(label) {
  if (!label) return null;
  if (label === 'ibm850') return ibm850;
  if (!(label in made)) { try { made[label] = new TextDecoder(label); } catch { made[label] = null; } }
  return made[label];
}
