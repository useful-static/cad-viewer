#!/usr/bin/env node
// Part metadata read from a STEP file's PRODUCT entities (js/step-meta.js).
//   node tests/test-step-meta.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { stepProducts, decodeStepString } from '../js/step-meta.js';

import { test, done } from './harness.mjs';

const STEP = `ISO-10303-21;
DATA;
#10=PRODUCT('RC0402FR-0710KL','R1','Resistor 10k 1% 0402',(#2));
#11=PRODUCT('HDMI','HDMI','',(#2));
#12 = PRODUCT ( 'J1' , 'USB_A' , 'USB-A receptacle, it''s stacked' , ( #2 ) ) ;
#13=PRODUCT('PN-\\X2\\00B5\\X0\\5','Shim','\\X\\B0 washer',(#2));
#14=PRODUCT('R1','R1','',(#2));
ENDSEC;`;

test('id and description by product name; the name alone is not kept', () => {
  const p = stepProducts(STEP);
  assert.deepEqual(p.get('R1'), { id: 'RC0402FR-0710KL', description: 'Resistor 10k 1% 0402' });
  assert.equal(p.has('HDMI'), false, 'its id is its name and it has no description');
  assert.deepEqual(p.get('USB_A'), { id: 'J1', description: "USB-A receptacle, it's stacked" });
});
test('the first product of a name wins; escapes decoded', () => {
  const p = stepProducts(STEP);
  assert.equal(p.get('R1').id, 'RC0402FR-0710KL');
  assert.deepEqual(p.get('Shim'), { id: 'PN-µ5', description: '° washer' });
  assert.equal(decodeStepString("a''b"), "a'b");
});

test('bytes read in slices give what the text gives, a record across a slice edge included', () => {
  const pad = '#1=CARTESIAN_POINT(\'\',(0.,0.,0.));\n'.repeat(Math.ceil((4 << 20) / 36));
  const big = new TextEncoder().encode(pad + STEP + pad + STEP);
  const fromBytes = stepProducts(big), fromText = stepProducts(STEP);
  assert.deepEqual([...fromBytes], [...fromText]);
  assert.deepEqual([...stepProducts(new TextEncoder().encode(STEP).buffer)], [...fromText]);
});
test('a \\X2\\ run of 300,000 code units decodes (no spread onto the stack)', () => {
  const s = decodeStepString(`\\X2\\${'0041'.repeat(300000)}\\X0\\`);
  assert.equal(s.length, 300000);
  assert.equal(s[0], 'A');
});
test('a STEP name written as raw UTF-8, \\S\\ or \\X4\\ decodes as the converter names it', () => {
  // the scan reads latin1: "Müller" as UTF-8 bytes arrives as "MÃ¼ller"
  const raw = String.fromCharCode(...new TextEncoder().encode('Müller ø'));
  assert.equal(decodeStepString(raw), 'Müller ø');
  assert.equal(decodeStepString('M\\S\\|ller'), 'Müller'); // ü is 0xFC = '|' + 0x80
  assert.equal(decodeStepString('\\X4\\0001F600\\X0\\ ok'), '\u{1F600} ok');
  assert.equal(decodeStepString('caf\\X\\E9'), 'café');
  assert.equal(decodeStepString('\\X2\\00E900E8\\X0\\'), 'éè');
  // bytes that are not UTF-8 stay as read
  assert.equal(decodeStepString('na\xefve'), 'na\xefve');
});

done();
