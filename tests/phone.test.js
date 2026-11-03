const test = require('node:test');
const assert = require('node:assert');
const { normalizeE164, isSipUri } = require('../src/services/phone');

test('normalizeE164: SIP URI de Twilio sin + (DID en el user part)', () => {
  assert.strictEqual(normalizeE164('sip:525512345678@darwin-zadarma.sip.twilio.com'), '+525512345678');
});

test('normalizeE164: SIP URI de Zadarma con +', () => {
  assert.strictEqual(normalizeE164('sip:+15551234567@sip.zadarma.com'), '+15551234567');
  assert.strictEqual(normalizeE164('sip:+15551234567@pbx.zadarma.com'), '+15551234567');
});

test('normalizeE164: SIP URI con parámetros y esquema sips/tel', () => {
  assert.strictEqual(normalizeE164('sip:525512345678@x.sip.twilio.com;transport=tls'), '+525512345678');
  assert.strictEqual(normalizeE164('sips:+525512345678@x.com'), '+525512345678');
  assert.strictEqual(normalizeE164('tel:+525512345678'), '+525512345678');
});

test('normalizeE164: dígitos sueltos y E.164 con formato', () => {
  assert.strictEqual(normalizeE164('525512345678'), '+525512345678');
  assert.strictEqual(normalizeE164('+525512345678'), '+525512345678');
  assert.strictEqual(normalizeE164('+54 11 4899-9365'), '+541148999365');
});

test('normalizeE164: entradas inválidas devuelven vacío', () => {
  for (const bad of ['', null, undefined, 'abc', '+123', 'sip:anonymous@anonymous.invalid', 'sip:@x.com', '+1234567890123456']) {
    assert.strictEqual(normalizeE164(bad), '', `debería rechazar ${bad}`);
  }
});

test('isSipUri', () => {
  assert.strictEqual(isSipUri('sip:5255@x.com'), true);
  assert.strictEqual(isSipUri('SIPS:5255@x.com'), true);
  assert.strictEqual(isSipUri('+5255'), false);
  assert.strictEqual(isSipUri(undefined), false);
});
