const test = require('node:test');
const assert = require('node:assert');
const { normalizeE164, parseE164, isSipAddress, isSipOfDomain } = require('../src/services/phone');

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

test('normalizeE164: si no puede extraer dígitos devuelve el valor original', () => {
  assert.strictEqual(normalizeE164('anonymous'), 'anonymous');
  assert.strictEqual(normalizeE164('sip:anonymous@anonymous.invalid'), 'sip:anonymous@anonymous.invalid');
  assert.strictEqual(normalizeE164('FACEBOOK'), 'FACEBOOK');
  assert.strictEqual(normalizeE164('INFO2FA'), 'INFO2FA'); // alfanumérico: no se mutila a "+2"
  assert.strictEqual(normalizeE164(''), '');
  assert.strictEqual(normalizeE164(null), '');
  assert.strictEqual(normalizeE164(undefined), '');
});

test('parseE164: estricto, vacío si no es un número válido', () => {
  for (const bad of ['', null, undefined, 'abc', '+123', 'sip:anonymous@anonymous.invalid', 'sip:@x.com', '+1234567890123456']) {
    assert.strictEqual(parseE164(bad), '', `debería rechazar ${bad}`);
  }
  assert.strictEqual(parseE164('sip:528718430130@darwin-zadarma.sip.twilio.com'), '+528718430130');
  assert.strictEqual(parseE164('+54 11 4899-9365'), '+541148999365');
});

test('isSipAddress', () => {
  assert.strictEqual(isSipAddress('sip:5255@x.com'), true);
  assert.strictEqual(isSipAddress('SIPS:5255@x.com'), true);
  assert.strictEqual(isSipAddress('+5255'), false);
  assert.strictEqual(isSipAddress(undefined), false);
});

test('isSipOfDomain: host exacto o subdominio, sin distinguir mayúsculas', () => {
  const d = 'darwin-zadarma.sip.twilio.com';
  assert.strictEqual(isSipOfDomain('sip:528718430130@darwin-zadarma.sip.twilio.com', d), true);
  assert.strictEqual(isSipOfDomain('sip:528718430130@DARWIN-ZADARMA.sip.twilio.com;transport=udp', d), true);
  assert.strictEqual(isSipOfDomain('sip:528718430130@x.darwin-zadarma.sip.twilio.com', d), true);
  assert.strictEqual(isSipOfDomain('sip:528718430130@evil-darwin-zadarma.sip.twilio.com', d), false);
  assert.strictEqual(isSipOfDomain('sip:+15551234567@sip.zadarma.com', d), false);
  assert.strictEqual(isSipOfDomain('+528718430130', d), false);
  assert.strictEqual(isSipOfDomain('sip:528718430130@darwin-zadarma.sip.twilio.com', ''), false);
});

const { resolveCallParties } = require('../src/services/phone');

test('resolveCallParties: llamada SIP normaliza To y From y avisa que es SIP', () => {
  const r = resolveCallParties({
    To: 'sip:525512345678@darwin-zadarma.sip.twilio.com',
    From: 'sip:+15551234567@sip.zadarma.com',
  });
  assert.deepStrictEqual(r, { to: '+525512345678', from: '+15551234567', sip: true, provider: 'twilio' });
});

test('resolveCallParties: llamada PSTN de Twilio queda igual', () => {
  const r = resolveCallParties({ To: '+12025550101', From: '+15551234567' });
  assert.deepStrictEqual(r, { to: '+12025550101', from: '+15551234567', sip: false, provider: 'twilio' });
});

test('resolveCallParties: From anónimo/no numérico se conserva tal cual (no se pierde info)', () => {
  const r = resolveCallParties({ To: '+12025550101', From: 'anonymous' });
  assert.strictEqual(r.from, 'anonymous');
  const s = resolveCallParties({ To: 'sip:525512345678@x.sip.twilio.com', From: 'sip:anonymous@anonymous.invalid' });
  assert.strictEqual(s.from, 'sip:anonymous@anonymous.invalid');
});

test('resolveCallParties: To no numérico se conserva (el handler responde con TwiML vacío)', () => {
  assert.strictEqual(resolveCallParties({ To: 'weird', From: '+1555123456' }).to, 'weird');
  assert.strictEqual(resolveCallParties({}).to, '');
});

test('resolveCallParties: provider zadarma solo si To es SIP del domain configurado', () => {
  const opts = { zadarmaDomain: 'darwin-zadarma.sip.twilio.com' };
  const r = resolveCallParties({ To: 'sip:528718430130@darwin-zadarma.sip.twilio.com', From: 'sip:+5215512345678@sip.zadarma.com;transport=udp' }, opts);
  assert.deepStrictEqual(r, { to: '+528718430130', from: '+5215512345678', sip: true, provider: 'zadarma' });
  assert.strictEqual(resolveCallParties({ To: '+12025550101', From: '+1555' }, opts).provider, 'twilio');
  assert.strictEqual(resolveCallParties({ To: 'sip:5255@otro.sip.twilio.com', From: '+1555' }, opts).provider, 'twilio');
});
