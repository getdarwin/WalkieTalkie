const test = require('node:test');
const assert = require('node:assert/strict');
const { buildQuery, signRequest, createClient } = require('../src/services/zadarma');

// Vectores calculados con una implementación independiente (Python: urlencode + md5 + hmac-sha1 hex + base64).
test('buildQuery: ordena por llave y codifica como http_build_query RFC1738', () => {
  assert.equal(buildQuery({ sip_id: '525512345678@darwin-zadarma.sip.twilio.com', number: '525512345678' }),
    'number=525512345678&sip_id=525512345678%40darwin-zadarma.sip.twilio.com');
  assert.equal(buildQuery({ z: '1&2', a: 'b c' }), 'a=b+c&z=1%262');
  assert.equal(buildQuery({}), '');
  assert.equal(buildQuery({ sms: true, off: false }), 'off=0&sms=1');
});

test('signRequest: vector fijo (base64 sobre el HEX del HMAC, como el SDK oficial)', () => {
  assert.equal(
    signRequest('/v1/direct_numbers/set_sip_id/', { sip_id: '525512345678@darwin-zadarma.sip.twilio.com', number: '525512345678' }, 'test_secret'),
    'NGJmZjk0NjNhMTc2MWFmZDYyMWQxMzEyY2ZiM2I2NjlkMTE1NDI1Nw==');
  assert.equal(signRequest('/v1/direct_numbers/', {}, 'test_secret'), 'YjhlODYyYzVhYzhhOThmMzViMDRkODE4MWIwZWRkNTdhNmVkYTY4Mw==');
  assert.equal(signRequest('/v1/x/', { a: 'b c', z: '1&2' }, 'k'), 'OTNhYWQ0YmNiYzllMGU4MjFkZjlkYTJlYmMzODViNjQ4MTFhYmNiNQ==');
});

function fakeClient(responder) {
  const calls = [];
  const client = createClient({
    getCredentials: async () => ({ key: 'KEY', secret: 'test_secret' }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responder(url, init);
    },
  });
  return { client, calls };
}
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', ...body }) });

test('listNumbers: GET firmado con Authorization KEY:SIGN', async () => {
  const { client, calls } = fakeClient(() => ok({ numbers: [{ number: '525512345678' }] }));
  const numbers = await client.listNumbers();
  assert.deepEqual(numbers, [{ number: '525512345678' }]);
  assert.equal(calls[0].url, 'https://api.zadarma.com/v1/direct_numbers/');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'KEY:YjhlODYyYzVhYzhhOThmMzViMDRkODE4MWIwZWRkNTdhNmVkYTY4Mw==');
});

test('setSipUri: PUT con cuerpo form-urlencoded y firma del mismo string', async () => {
  const { client, calls } = fakeClient(() => ok({}));
  await client.setSipUri('+525512345678', '525512345678@darwin-zadarma.sip.twilio.com');
  const c = calls[0];
  assert.equal(c.init.method, 'PUT');
  assert.equal(c.url, 'https://api.zadarma.com/v1/direct_numbers/set_sip_id/');
  assert.equal(c.init.body, 'number=525512345678&sip_id=525512345678%40darwin-zadarma.sip.twilio.com');
  assert.equal(c.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(c.init.headers.Authorization, 'KEY:NGJmZjk0NjNhMTc2MWFmZDYyMWQxMzEyY2ZiM2I2NjlkMTE1NDI1Nw==');
});

test('setReceiveSms: value on|off', async () => {
  const { client, calls } = fakeClient(() => ok({}));
  await client.setReceiveSms('525512345678', true);
  await client.setReceiveSms('525512345678', false);
  assert.equal(calls[0].init.body, 'number=525512345678&value=on');
  assert.equal(calls[1].init.body, 'number=525512345678&value=off');
});

test('setSmsWebhook: registra la URL y luego activa el hook sms', async () => {
  const { client, calls } = fakeClient(() => ok({}));
  await client.setSmsWebhook('https://x.example/zadarma-webhook');
  assert.equal(calls[0].url, 'https://api.zadarma.com/v1/pbx/webhooks/url/');
  assert.equal(calls[0].init.body, 'url=https%3A%2F%2Fx.example%2Fzadarma-webhook');
  assert.equal(calls[1].url, 'https://api.zadarma.com/v1/pbx/webhooks/hooks/');
  assert.equal(calls[1].init.body, 'sms=true');
});

test('setSmsWebhook: solo acepta URLs https', async () => {
  const { client, calls } = fakeClient(() => ok({}));
  await assert.rejects(() => client.setSmsWebhook('http://x.example/zadarma-webhook'), /https/);
  assert.equal(calls.length, 0);
});

test('errores: status:error de Zadarma, HTTP no-2xx y respuesta no JSON; nunca filtran secretos', async () => {
  let r = fakeClient(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'error', message: 'Wrong number' }) }));
  await assert.rejects(() => r.client.listNumbers(), /Wrong number/);

  r = fakeClient(() => ({ ok: false, status: 429, text: async () => 'Too Many Requests' }));
  await assert.rejects(() => r.client.listNumbers(), /429/);

  r = fakeClient(() => ({ ok: true, status: 200, text: async () => '<html>' }));
  await assert.rejects(() => r.client.listNumbers(), /no es JSON/);

  r = fakeClient(() => { throw new Error('socket hang up'); });
  await assert.rejects(() => r.client.listNumbers(), (err) => !/test_secret/.test(err.message) && /socket hang up/.test(err.message));
});

test('sin credenciales: error claro y no hay request', async () => {
  const calls = [];
  const client = createClient({ getCredentials: async () => ({}), fetchImpl: async (...a) => { calls.push(a); } });
  await assert.rejects(() => client.listNumbers(), /credenciales de Zadarma/i);
  assert.equal(calls.length, 0);
});
