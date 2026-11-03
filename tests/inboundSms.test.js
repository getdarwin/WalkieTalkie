const test = require('node:test');
const assert = require('node:assert/strict');
const { handleInboundSms } = require('../src/services/inboundSms');

function makeDeps(overrides = {}) {
  const calls = { slack: [], logs: [], caps: [] };
  const deps = {
    getFriendlyName: async (to) => `Nombre ${to}`,
    getChannel: async () => 'C0TEST123',
    parseOtp: (body) => (/(\d{6})/.exec(body) || [])[1] || null,
    sendToSlack: async (args) => { calls.slack.push(args); },
    logTransaction: async (entry) => { calls.logs.push(entry); },
    checkAndCacheCapabilities: async (to) => { calls.caps.push(to); },
    background: (p) => p,
    ...overrides,
  };
  return { deps, calls };
}

test('Twilio: manda a Slack, loguea sin campo provider y cachea capabilities', async () => {
  const { deps, calls } = makeDeps();
  const res = await handleInboundSms({ to: '+12025550101', from: '+15551234567', body: 'Tu código es 123456', provider: 'twilio' }, deps);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls.slack, [{ channel: 'C0TEST123', friendlyName: 'Nombre +12025550101', toNumber: '+12025550101', fromNumber: '+15551234567', body: 'Tu código es 123456' }]);
  assert.equal(calls.logs.length, 1);
  assert.equal(calls.logs[0].status, 'success');
  assert.equal(calls.logs[0].otp, '123456');
  assert.equal('provider' in calls.logs[0], false);
  assert.deepEqual(calls.caps, ['+12025550101']);
});

test('Zadarma: mismo flujo, log con provider:zadarma y SIN consultar Twilio', async () => {
  const { deps, calls } = makeDeps();
  const res = await handleInboundSms({ to: '+525512345678', from: '+15551234567', body: 'Code 654321', provider: 'zadarma' }, deps);
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.slack.length, 1);
  assert.equal(calls.logs[0].provider, 'zadarma');
  assert.equal(calls.logs[0].otp, '654321');
  assert.deepEqual(calls.caps, []);
});

test('error de Slack: loguea status error con el mensaje y devuelve ok:false (no lanza)', async () => {
  const { deps, calls } = makeDeps({ sendToSlack: async () => { throw new Error('slack caído'); } });
  const res = await handleInboundSms({ to: '+525512345678', from: '+1555', body: 'hola', provider: 'zadarma' }, deps);
  assert.deepEqual(res, { ok: false, error: 'slack caído' });
  assert.equal(calls.logs[0].status, 'error');
  assert.equal(calls.logs[0].error, 'slack caído');
  assert.equal(calls.logs[0].provider, 'zadarma');
});

test('body vacío es válido (string vacío)', async () => {
  const { deps, calls } = makeDeps();
  const res = await handleInboundSms({ to: '+525512345678', from: '+1555', body: '', provider: 'zadarma' }, deps);
  assert.equal(res.ok, true);
  assert.equal(calls.slack[0].body, '');
});
