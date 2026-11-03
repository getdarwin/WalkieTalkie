const test = require('node:test');
const assert = require('node:assert/strict');
const { runProvision } = require('../src/services/zadarmaProvision');

const DOMAIN = 'darwin-zadarma.sip.twilio.com';

function setup({ directory, zadarmaNumbers = [], webhookError, failFor = [] } = {}) {
  const dir = structuredClone(directory ?? {
    '+528718430130': { name: 'Zadarma Torreón', provider: 'zadarma', keypressMode: 'auto' },
    '+524426445470': { name: 'VAPI', provider: 'zadarma', routing: 'vapi' },
    '+12025550101': 'Línea Twilio',
  });
  const calls = [];
  const state = { sips: { '528718430130': '113056', ...Object.fromEntries(zadarmaNumbers.map((n) => [String(n.number), n.sip])) } };
  const client = {
    listNumbers: async () => zadarmaNumbers,
    getNumber: async (phone) => {
      const d = phone.replace(/\D/g, '');
      return d in state.sips ? { number: d, sip: state.sips[d] } : { number: d, sip: '' };
    },
    setSipUri: async (phone, uri) => { calls.push(['setSipUri', phone, uri]); if (failFor.includes(phone)) throw new Error('Wrong number'); },
    setReceiveSms: async (phone, on) => { calls.push(['setReceiveSms', phone, on]); },
    setSmsWebhook: async (url) => { calls.push(['setSmsWebhook', url]); if (webhookError) throw new Error(webhookError); },
  };
  const deps = {
    client, domain: DOMAIN, baseUrl: 'https://walkietalkie.test',
    loadConfig: async () => ({ numbers: structuredClone(dir) }),
    setNumber: async (phone, entry) => { calls.push(['setNumber', phone, entry]); dir[phone] = { name: entry.name, provider: entry.provider, keypressMode: entry.keypressMode }; },
  };
  return { deps, calls, dir };
}

test('registra el webhook SMS y conecta las líneas zadarma, sin tocar VAPI ni Twilio', async () => {
  const { deps, calls } = setup();
  const report = await runProvision({}, deps);
  assert.deepEqual(calls[0], ['setSmsWebhook', 'https://walkietalkie.test/zadarma-webhook']);
  assert.ok(calls.some((c) => c[0] === 'setSipUri' && c[1] === '+528718430130' && c[2] === `528718430130@${DOMAIN}`));
  assert.ok(calls.some((c) => c[0] === 'setReceiveSms' && c[1] === '+528718430130'));
  assert.equal(calls.some((c) => c[1] === '+524426445470'), false, 'VAPI intacto');
  assert.equal(calls.some((c) => c[1] === '+12025550101'), false, 'Twilio intacto');
  assert.equal(report.webhook.status, 'registered');
  assert.equal(report.failures, 0);
  assert.deepEqual(report.lines.map((l) => [l.phone, l.status]), [['+528718430130', 'connected'], ['+524426445470', 'skipped']]);
});

test('--dry-run no escribe nada (ni webhook, ni SIP, ni directorio)', async () => {
  const { deps, calls } = setup({ zadarmaNumbers: [{ number: '5215500000000', sip: '113057' }] });
  const report = await runProvision({ dryRun: true, importNumbers: true }, deps);
  assert.deepEqual(calls, []);
  assert.equal(report.dryRun, true);
  assert.equal(report.webhook.status, 'dry-run');
  assert.ok(report.lines.some((l) => l.phone === '+528718430130' && l.status === 'dry-run'));
  assert.ok(report.lines.some((l) => l.phone === '+5215500000000' && l.status === 'dry-run'));
});

test('el fallo de un número no detiene al resto y se resume', async () => {
  const dir = {
    '+528718430130': { name: 'A', provider: 'zadarma' },
    '+5215500000000': { name: 'B', provider: 'zadarma' },
  };
  const { deps, calls } = setup({ directory: dir, failFor: ['+528718430130'], zadarmaNumbers: [{ number: '5215500000000', sip: '113057' }] });
  const report = await runProvision({}, deps);
  assert.equal(report.failures, 1);
  assert.deepEqual(report.lines.map((l) => [l.phone, l.status]), [['+528718430130', 'failed'], ['+5215500000000', 'connected']]);
  assert.match(report.lines[0].detail, /Wrong number/);
  assert.ok(calls.some((c) => c[0] === 'setSipUri' && c[1] === '+5215500000000'));
});

test('si el webhook falla, se reporta pero las líneas se siguen configurando', async () => {
  const { deps, calls } = setup({ webhookError: 'HTTP 500' });
  const report = await runProvision({}, deps);
  assert.equal(report.webhook.status, 'failed');
  assert.match(report.webhook.detail, /HTTP 500/);
  assert.equal(report.failures, 1);
  assert.ok(calls.some((c) => c[0] === 'setSipUri'));
});

test('--import da de alta los números de Zadarma que faltan, pero NO los que apuntan a otro SIP', async () => {
  const { deps, calls, dir } = setup({
    zadarmaNumbers: [
      { number: '5215500000000', sip: '113057' },
      { number: '524426445471', sip: '+524426445471@sip.vapi.ai' },
    ],
  });
  const report = await runProvision({ importNumbers: true }, deps);
  assert.deepEqual(dir['+5215500000000'], { name: '+5215500000000', provider: 'zadarma', keypressMode: 'auto' });
  assert.equal('+524426445471' in dir, false);
  assert.equal(calls.some((c) => c[1] === '+524426445471'), false);
  assert.ok(report.lines.some((l) => l.phone === '+524426445471' && l.status === 'skipped' && /otro SIP/.test(l.detail)));
  assert.ok(report.lines.some((l) => l.phone === '+5215500000000' && l.status === 'connected'));
});

test('idempotente: una línea que ya apunta al SIP URI no se vuelve a escribir', async () => {
  const dir = { '+528718430130': { name: 'A', provider: 'zadarma' } };
  const { deps, calls } = setup({ directory: dir, zadarmaNumbers: [{ number: '528718430130', sip: `528718430130@${DOMAIN}` }] });
  deps.client.getNumber = async () => ({ number: '528718430130', sip: `528718430130@${DOMAIN}` });
  const report = await runProvision({}, deps);
  assert.equal(calls.some((c) => c[0] === 'setSipUri'), false);
  assert.equal(report.lines[0].status, 'connected');
});
