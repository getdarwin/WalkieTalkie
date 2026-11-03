const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const { computeSignString, verifySignature, createZadarmaValidate } = require('../src/middleware/zadarmaValidate');

const SECRET = 'zadarma_test_secret';
const hmac = (s) => crypto.createHmac('sha1', SECRET).update(s);
const sigRaw = (s) => hmac(s).digest().toString('base64');          // variante SDK TypeScript
const sigHex = (s) => Buffer.from(hmac(s).digest('hex')).toString('base64'); // variante SDK PHP

test('computeSignString: tabla de eventos de docs/ZADARMA.md', () => {
  assert.equal(computeSignString('NOTIFY_START', { caller_id: 'A', called_did: 'B', call_start: 'C' }), 'ABC');
  for (const e of ['NOTIFY_END', 'NOTIFY_INTERNAL', 'NOTIFY_IVR']) {
    assert.equal(computeSignString(e, { caller_id: '1', called_did: '2', call_start: '3' }), '123');
  }
  assert.equal(computeSignString('NOTIFY_ANSWER', { caller_id: 'A', destination: 'D', call_start: 'C' }), 'ADC');
  assert.equal(computeSignString('NOTIFY_OUT_START', { internal: 'I', destination: 'D', call_start: 'C' }), 'IDC');
  assert.equal(computeSignString('NOTIFY_OUT_END', { internal: 'I', destination: 'D', call_start: 'C' }), 'IDC');
  assert.equal(computeSignString('NOTIFY_RECORD', { pbx_call_id: 'P', call_id_with_rec: 'R' }), 'PR');
  assert.equal(computeSignString('SMS', { result: '{"text":"hola"}' }), '{"text":"hola"}');
  assert.equal(computeSignString('NOPE', {}), null);
  assert.equal(computeSignString('SMS', {}), null); // sin result no hay nada que firmar
});

test('verifySignature: acepta base64(raw) y base64(hex)', () => {
  const s = '{"caller_id":"+1555","text":"hola"}';
  assert.equal(verifySignature(sigRaw(s), s, SECRET), true);
  assert.equal(verifySignature(sigHex(s), s, SECRET), true);
});

test('verifySignature: rechaza firma incorrecta, vacía, de otro string o de largo distinto', () => {
  const s = 'abc';
  assert.equal(verifySignature(sigRaw('abd'), s, SECRET), false);
  assert.equal(verifySignature('', s, SECRET), false);
  assert.equal(verifySignature(undefined, s, SECRET), false);
  assert.equal(verifySignature('corta', s, SECRET), false);
  assert.equal(verifySignature(sigRaw(s), s, 'otro_secret'), false);
  assert.equal(verifySignature(sigRaw(s), s, ''), false);
});

let server;
let baseUrl;
let strict = true;
let secret = SECRET;
const warnings = [];

test.before(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const validate = createZadarmaValidate({
    getSecret: async () => secret,
    isStrict: () => strict,
    warn: (msg) => warnings.push(msg),
  });
  app.post('/hook', validate, (_req, res) => res.status(200).send('PASSED'));
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => { strict = true; secret = SECRET; warnings.length = 0; });

async function post(form, signature) {
  const res = await fetch(`${baseUrl}/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(signature ? { Signature: signature } : {}) },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, text: await res.text() };
}

const smsForm = () => ({ event: 'SMS', result: JSON.stringify({ caller_id: '+15551234567', caller_did: '+525512345678', text: 'Tu código es 123456' }) });

test('middleware estricto: SMS con firma raw → pasa', async () => {
  const f = smsForm();
  assert.deepEqual(await post(f, sigRaw(f.result)), { status: 200, text: 'PASSED' });
});

test('middleware estricto: SMS con firma hex → pasa', async () => {
  const f = smsForm();
  assert.deepEqual(await post(f, sigHex(f.result)), { status: 200, text: 'PASSED' });
});

test('middleware estricto: llamada NOTIFY_START firmada → pasa', async () => {
  const f = { event: 'NOTIFY_START', caller_id: '1555', called_did: '5255', call_start: '2026-11-03 10:00:00' };
  assert.equal((await post(f, sigRaw('15555255' + '2026-11-03 10:00:00'))).status, 200);
});

test('middleware estricto: sin firma o firma inválida → 403 y no llega al handler', async () => {
  const f = smsForm();
  assert.equal((await post(f)).status, 403);
  assert.equal((await post(f, sigRaw('otra cosa'))).status, 403);
});

test('middleware estricto: sin secret configurado → falla cerrado (503)', async () => {
  secret = undefined;
  const f = smsForm();
  assert.equal((await post(f, sigRaw(f.result))).status, 503);
});

test('middleware no estricto: loguea el fallo y deja pasar', async () => {
  strict = false;
  const f = smsForm();
  assert.equal((await post(f, sigRaw('mal'))).status, 200);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /firma/i);
  assert.equal(warnings[0].includes(SECRET), false);
});

test('middleware: evento desconocido pasa (el handler solo lo loguea)', async () => {
  assert.equal((await post({ event: 'ALGO_NUEVO' })).status, 200);
});
