const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSipUri, isForeignSip, connectZadarmaLine, planImport } = require('../src/services/zadarmaLines');

const DOMAIN = 'darwin-zadarma.sip.twilio.com';

test('buildSipUri: DID sin + en el user part', () => {
  assert.equal(buildSipUri('+528718430130', DOMAIN), '528718430130@darwin-zadarma.sip.twilio.com');
  assert.equal(buildSipUri('528718430130', DOMAIN), '528718430130@darwin-zadarma.sip.twilio.com');
  assert.throws(() => buildSipUri('abc', DOMAIN), /número/i);
  assert.throws(() => buildSipUri('+528718430130', ''), /SIP/i);
});

test('isForeignSip: SIP URI de otro host es ajeno; vacío, interno (dígitos) o el nuestro no', () => {
  assert.equal(isForeignSip('+524426445470@sip.vapi.ai', DOMAIN), true);
  assert.equal(isForeignSip('sip:x@otro.com', DOMAIN), true);
  assert.equal(isForeignSip('528718430130@darwin-zadarma.sip.twilio.com', DOMAIN), false);
  assert.equal(isForeignSip('sip:528718430130@DARWIN-ZADARMA.sip.twilio.com', DOMAIN), false);
  assert.equal(isForeignSip('113056', DOMAIN), false);
  assert.equal(isForeignSip('', DOMAIN), false);
  assert.equal(isForeignSip(undefined, DOMAIN), false);
});

function fakeDeps({ entry, zadarmaNumber, smsError } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      domain: DOMAIN,
      loadConfig: async () => ({ numbers: { '+528718430130': entry ?? { name: 'Zadarma Torreón', provider: 'zadarma' } } }),
      client: {
        getNumber: async () => zadarmaNumber === null ? null : (zadarmaNumber ?? { number: '528718430130', sip: '113056' }),
        setSipUri: async (n, u) => { calls.push(['setSipUri', n, u]); },
        setReceiveSms: async (n, on) => { calls.push(['setReceiveSms', n, on]); if (smsError) throw new Error(smsError); },
      },
    },
  };
}

test('connectZadarmaLine: apunta el SIP URI y activa SMS', async () => {
  const { calls, deps } = fakeDeps();
  const r = await connectZadarmaLine('+528718430130', deps);
  assert.deepEqual(calls, [
    ['setSipUri', '+528718430130', '528718430130@darwin-zadarma.sip.twilio.com'],
    ['setReceiveSms', '+528718430130', true],
  ]);
  assert.equal(r.voice, true);
  assert.equal(r.sipChanged, true);
  assert.deepEqual(r.sms, { ok: true });
});

test('connectZadarmaLine: idempotente — si ya apunta a nuestro URI no vuelve a escribirlo', async () => {
  const { calls, deps } = fakeDeps({ zadarmaNumber: { number: '528718430130', sip: '528718430130@darwin-zadarma.sip.twilio.com' } });
  const r = await connectZadarmaLine('+528718430130', deps);
  assert.equal(r.sipChanged, false);
  assert.deepEqual(calls.map((c) => c[0]), ['setReceiveSms']);
});

test('connectZadarmaLine: número sin soporte de SMS → voz conectada y SMS reportado, sin lanzar', async () => {
  const { deps } = fakeDeps({ smsError: 'SMS not supported' });
  const r = await connectZadarmaLine('+528718430130', deps);
  assert.equal(r.voice, true);
  assert.deepEqual(r.sms, { ok: false, error: 'SMS not supported' });
});

test('connectZadarmaLine: routing externo (vapi) NO se toca', async () => {
  const { calls, deps } = fakeDeps({ entry: { name: 'VAPI', provider: 'zadarma', routing: 'vapi' } });
  const r = await connectZadarmaLine('+528718430130', deps);
  assert.equal(r.skipped, 'routing externo (vapi)');
  assert.deepEqual(calls, []);
});

test('connectZadarmaLine: línea que no es provider zadarma → error, sin llamadas', async () => {
  const { calls, deps } = fakeDeps({ entry: { name: 'Twilio' } });
  await assert.rejects(() => connectZadarmaLine('+528718430130', deps), /no es una línea Zadarma/);
  assert.deepEqual(calls, []);
});

test('connectZadarmaLine: el número no existe en la cuenta de Zadarma → error', async () => {
  const { calls, deps } = fakeDeps({ zadarmaNumber: null });
  await assert.rejects(() => connectZadarmaLine('+528718430130', deps), /no existe en Zadarma/);
  assert.deepEqual(calls, []);
});

test('planImport: clasifica los números de Zadarma sin pisar los que apuntan a otro SIP', () => {
  const plan = planImport([
    { number: '528718430130', sip: '113056' },
    { number: '524426445470', sip: '+524426445470@sip.vapi.ai' },
    { number: '5215500000000', sip: '5215500000000@darwin-zadarma.sip.twilio.com' },
    { number: '5215500000001' },
  ], { '+5215500000001': { name: 'ya está', provider: 'zadarma' } }, DOMAIN);
  assert.deepEqual(plan.map((p) => [p.phone, p.action]), [
    ['+528718430130', 'import'],
    ['+524426445470', 'skip-foreign-sip'],
    ['+5215500000000', 'import'],
    ['+5215500000001', 'already'],
  ]);
});

test('planImport: un número del directorio con otro provider no se pisa', () => {
  const plan = planImport([{ number: '528718430130', sip: '113056' }], { '+528718430130': 'Línea Twilio' }, DOMAIN);
  assert.equal(plan[0].action, 'skip-other-provider');
});

const { describeConnectResult } = require('../src/services/zadarmaLines');

test('describeConnectResult: texto para Slack sin exponer credenciales', () => {
  assert.match(describeConnectResult({ phone: '+528718430130', voice: true, sipChanged: true, sipUri: '528718430130@darwin-zadarma.sip.twilio.com', sms: { ok: true } }),
    /Voz vía SIP.*528718430130@darwin-zadarma\.sip\.twilio\.com.*SMS activo/s);
  assert.match(describeConnectResult({ phone: '+1', voice: true, sipChanged: false, sipUri: 'x@y', sms: { ok: false, error: 'SMS not supported' } }),
    /ya apuntaba.*SMS no disponible: SMS not supported/s);
  assert.match(describeConnectResult({ phone: '+1', voice: false, skipped: 'routing externo (vapi)' }), /no se tocó.*routing externo \(vapi\)/s);
});
