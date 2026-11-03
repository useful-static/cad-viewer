#!/usr/bin/env node
// Part metadata read from a STEP file's PRODUCT entities (js/step-meta.js).
//   node tests/test-step-meta.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { stepProducts, decodeStepString } from '../js/step-meta.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

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

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
