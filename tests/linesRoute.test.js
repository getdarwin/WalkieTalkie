// Exercises POST/DELETE /lines end to end over HTTP with an in-memory store
// and a stubbed Twilio connection, so it never touches Redis or Twilio.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SECRET = 'test-secret';
const memory = new Map();
const connectCalls = [];
let connectError = null;

function stubModule(relPath, exports) {
  const file = require.resolve(path.join(__dirname, '..', relPath));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

stubModule('src/services/store.js', {
  getJSON: async (key) => (memory.has(key) ? structuredClone(memory.get(key)) : null),
  setJSON: async (key, value) => { memory.set(key, structuredClone(value)); },
  setJSONIfAbsent: async () => true,
  del: async (key) => { memory.delete(key); },
  listPush: async (key, value) => { memory.set(key, [value, ...(memory.get(key) || [])]); },
  listRange: async (key) => memory.get(key) || [],
  usingRedis: false,
});

stubModule('src/services/capabilities.js', {
  connectNumberToWalkieTalkie: async (phone) => {
    connectCalls.push(phone);
    if (connectError) throw new Error(connectError);
    return { sms: true, voice: true };
  },
});

const express = require('express');
const linesRouter = require('../src/routes/lines');

let server;
let baseUrl;

before(async () => {
  process.env.LINES_API_SECRET = SECRET;
  const app = express();
  app.use('/lines', linesRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  memory.clear();
  memory.set('numbers', { '+5215500000001': 'NP Digital' });
  connectCalls.length = 0;
  connectError = null;
  process.env.LINES_API_SECRET = SECRET;
});

async function call(method, urlPath, body, token = SECRET) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('rejects requests without the secret', async () => {
  const res = await call('POST', '/lines', { phone: '+541148999365', client: 'Acme' }, null);
  assert.equal(res.status, 401);
  assert.equal(connectCalls.length, 0);
});

test('fails closed when LINES_API_SECRET is not configured', async () => {
  delete process.env.LINES_API_SECRET;
  const res = await call('POST', '/lines', { phone: '+541148999365', client: 'Acme' }, '');
  assert.equal(res.status, 503);
});

test('saves a new line with client + owner and connects it', async () => {
  const res = await call('POST', '/lines', { phone: '+54 11 4899-9365', client: 'Chirey Coacalco', owner: 'Andrea' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, phone: '+541148999365', name: 'Chirey Coacalco - Andrea', sms: true, voice: true, created: true });
  assert.equal(memory.get('numbers')['+541148999365'], 'Chirey Coacalco - Andrea');
  assert.deepEqual(connectCalls, ['+541148999365']);
});

test('second line of the same client gets the next number', async () => {
  await call('POST', '/lines', { phone: '+541148999365', client: 'Chirey', owner: 'Andrea' });
  const res = await call('POST', '/lines', { phone: '+541148999366', client: 'Chirey', owner: 'Santi' });
  assert.equal(res.body.name, 'Chirey 2 - Santi');
});

test('a retry for the same number keeps its name (no "Chirey 2")', async () => {
  await call('POST', '/lines', { phone: '+541148999365', client: 'Chirey', owner: 'Andrea' });
  const res = await call('POST', '/lines', { phone: '+541148999365', client: 'Chirey', owner: 'Andrea' });
  assert.equal(res.body.name, 'Chirey - Andrea');
  assert.equal(res.body.created, false);
  assert.equal(connectCalls.length, 2);
});

test('stores the Slack channel when provided', async () => {
  const res = await call('POST', '/lines', { phone: '+541148999365', client: 'Acme', channel: 'C0SALES001' });
  assert.equal(res.status, 200);
  assert.deepEqual(memory.get('numbers')['+541148999365'], { name: 'Acme', channel: 'C0SALES001' });
});

test('validates phone and channel', async () => {
  assert.equal((await call('POST', '/lines', { phone: '12', client: 'Acme' })).status, 400);
  assert.equal((await call('POST', '/lines', { phone: '+541148999365', channel: '#general' })).status, 400);
  assert.equal(connectCalls.length, 0);
});

test('invalid JSON returns 400', async () => {
  const res = await fetch(`${baseUrl}/lines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: '{bad',
  });
  assert.equal(res.status, 400);
});

test('external-routing lines are saved but their webhooks are not touched', async () => {
  memory.set('numbers', { '+541148999365': { name: 'VAPI Line', routing: 'vapi' } });
  const res = await call('POST', '/lines', { phone: '+541148999365', client: 'Acme' });
  assert.equal(res.body.external, 'vapi');
  assert.equal(connectCalls.length, 0);
});

test('Twilio failure returns 502 but keeps the directory entry for a retry', async () => {
  connectError = 'Number +541148999365 not found in Twilio account';
  const res = await call('POST', '/lines', { phone: '+541148999365', client: 'Acme', owner: 'Andrea' });
  assert.equal(res.status, 502);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /not found/);
  assert.equal(memory.get('numbers')['+541148999365'], 'Acme - Andrea');
});

test('DELETE removes the line and is idempotent', async () => {
  await call('POST', '/lines', { phone: '+541148999365', client: 'Acme' });
  const first = await call('DELETE', '/lines/+541148999365');
  assert.deepEqual(first.body, { ok: true, phone: '+541148999365', name: 'Acme', removed: true });
  assert.equal(memory.get('numbers')['+541148999365'], undefined);

  const second = await call('DELETE', '/lines/541148999365');
  assert.deepEqual(second.body, { ok: true, phone: '+541148999365', removed: false });
});

test('provider zadarma: guarda la línea y NUNCA llama a Twilio', async () => {
  const res = await call('POST', '/lines', { phone: '+525512345678', client: 'Acme', owner: 'Ana', provider: 'zadarma' });
  assert.equal(res.status, 200);
  assert.equal(res.body.provider, 'zadarma');
  assert.equal(res.body.sms, false);
  assert.deepEqual(connectCalls, []);
  assert.equal(memory.get('numbers')['+525512345678'].provider, 'zadarma');
});

test('provider zadarma se conserva en un reintento sin provider', async () => {
  memory.set('numbers', { '+525512345678': { name: 'Acme - Ana', provider: 'zadarma' } });
  const res = await call('POST', '/lines', { phone: '+525512345678', client: 'Acme', owner: 'Ana' });
  assert.equal(res.status, 200);
  assert.deepEqual(connectCalls, []);
  assert.equal(memory.get('numbers')['+525512345678'].provider, 'zadarma');
});

test('provider inválido responde 400 y no guarda nada', async () => {
  const res = await call('POST', '/lines', { phone: '+525512345678', client: 'Acme', provider: 'vonage' });
  assert.equal(res.status, 400);
  assert.equal(memory.get('numbers')['+525512345678'], undefined);
});

test('sin provider el flujo Twilio sigue igual', async () => {
  const res = await call('POST', '/lines', { phone: '+541148999365', client: 'Acme', owner: 'Ana' });
  assert.equal(res.status, 200);
  assert.deepEqual(connectCalls, ['+541148999365']);
  assert.equal(memory.get('numbers')['+541148999365'].provider, undefined);
});
