const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const { createZadarmaRouter } = require('../src/routes/zadarma');

const SECRET = 'zadarma_test_secret';
const sig = (s) => crypto.createHmac('sha1', SECRET).update(s).digest().toString('base64');

const received = [];
let handlerResult = { ok: true };
let server;
let baseUrl;

test.before(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/zadarma-webhook', createZadarmaRouter({
    getSecret: async () => SECRET,
    isStrict: () => true,
    handleSms: async (sms) => { received.push(sms); return handlerResult; },
    background: (p) => p,
  }));
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}/zadarma-webhook`;
});
test.after(() => server.close());
test.beforeEach(() => { received.length = 0; handlerResult = { ok: true }; });

function postSms(resultObj, { signed = true, raw } = {}) {
  const result = raw ?? JSON.stringify(resultObj);
  return fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(signed ? { Signature: sig(result) } : {}) },
    body: new URLSearchParams({ event: 'SMS', result }).toString(),
  });
}

test('GET zd_echo → 200 text/plain con el valor', async () => {
  const res = await fetch(`${baseUrl}?zd_echo=abc123`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.equal(await res.text(), 'abc123');
});

test('POST zd_echo → 200 text/plain con el valor (sin firma)', async () => {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'zd_echo=xyz-789',
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'xyz-789');
});

test('zd_echo con caracteres peligrosos o demasiado largo → 400', async () => {
  assert.equal((await fetch(`${baseUrl}?zd_echo=${encodeURIComponent('<script>alert(1)</script>')}`)).status, 400);
  assert.equal((await fetch(`${baseUrl}?zd_echo=${'a'.repeat(300)}`)).status, 400);
});

test('GET sin zd_echo → 200 simple', async () => {
  assert.equal((await fetch(baseUrl)).status, 200);
});

test('SMS firmado: normaliza a E.164, extrae to/from/text y responde 200', async () => {
  const res = await postSms({ caller_id: '15551234567', caller_did: '525512345678', text: 'Tu código es 123456' });
  assert.equal(res.status, 200);
  assert.deepEqual(received, [{ to: '+525512345678', from: '+15551234567', body: 'Tu código es 123456', provider: 'zadarma' }]);
});

test('SMS: remitente alfanumérico se conserva tal cual', async () => {
  await postSms({ caller_id: 'FACEBOOK', caller_did: '+525512345678', text: 'FB-12345' });
  assert.equal(received[0].from, 'FACEBOOK');
});

test('SMS sin firma → 403 y NO se procesa', async () => {
  const res = await postSms({ caller_id: '1', caller_did: '525512345678', text: 'x' }, { signed: false });
  assert.equal(res.status, 403);
  assert.equal(received.length, 0);
});

test('SMS con result que no es JSON (firmado) → 200 y no se procesa', async () => {
  const res = await postSms(null, { raw: 'esto no es json' });
  assert.equal(res.status, 200);
  assert.equal(received.length, 0);
});

test('SMS con DID inválido → 200 y no se procesa', async () => {
  const res = await postSms({ caller_id: '1555', caller_did: 'basura', text: 'x' });
  assert.equal(res.status, 200);
  assert.equal(received.length, 0);
});

test('SMS cuyo handler falla igual responde 200', async () => {
  handlerResult = { ok: false, error: 'slack caído' };
  const res = await postSms({ caller_id: '15551234567', caller_did: '525512345678', text: 'x' });
  assert.equal(res.status, 200);
});

test('otro evento firmado → 200 y no se procesa como SMS', async () => {
  const body = new URLSearchParams({ event: 'NOTIFY_START', caller_id: 'a', called_did: 'b', call_start: 'c' }).toString();
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Signature: sig('abc') },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal(received.length, 0);
});
