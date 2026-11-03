// POST /twilio-voice con una llamada que entra por SIP (Zadarma → Twilio SIP Domain):
// debe comportarse exactamente como una línea Twilio. Store en memoria y Slack stubbeado.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const memory = new Map();
const slackCalls = [];

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
// Twilio firma las llamadas SIP igual que las PSTN: el middleware real no se toca, aquí solo se salta.
stubModule('src/middleware/twilioValidate.js', (_req, _res, next) => next());
stubModule('src/services/slack.js', {
  sendCallStartToSlack: async (args) => { slackCalls.push(args); return '1700000000.000100'; },
  postToThread: async () => {},
  parseOtp: () => null,
  buildCallTranscriptBlocks: () => [],
});

const express = require('express');
const voiceRouter = require('../src/routes/voice');

let server;
let baseUrl;
const logs = [];
const origLog = console.log;

before(async () => {
  process.env.WEBHOOK_BASE_URL = 'https://walkietalkie.test';
  process.env.ZADARMA_TWILIO_SIP_DOMAIN = 'darwin-zadarma.sip.twilio.com';
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/twilio-voice', voiceRouter);
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => { console.log = origLog; server.close(); });

beforeEach(() => {
  memory.clear();
  slackCalls.length = 0;
  logs.length = 0;
  console.log = (...a) => { logs.push(a.join(' ')); };
  memory.set('numbers', {
    '+528718430130': { name: 'Zadarma Torreón', channel: 'C0ZADARMA1', provider: 'zadarma', keypressMode: 'auto' },
    '+12025550101': { name: 'Línea Twilio', channel: 'C0TWILIO01', keypressMode: 'auto' },
  });
});

async function postVoice(form) {
  const res = await fetch(`${baseUrl}/twilio-voice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, text: await res.text() };
}

const threads = () => [...memory.entries()].filter(([k]) => k !== 'numbers').map(([, v]) => v).filter((v) => v && v.toNumber);

test('llamada SIP: resuelve nombre y canal del directorio con To normalizado', async () => {
  const res = await postVoice({
    CallSid: 'CA_SIP_1',
    To: 'sip:528718430130@darwin-zadarma.sip.twilio.com',
    From: 'sip:+5215512345678@sip.zadarma.com;transport=udp',
  });
  assert.equal(res.status, 200);
  assert.equal(slackCalls.length, 1);
  assert.equal(slackCalls[0].channel, 'C0ZADARMA1');
  assert.equal(slackCalls[0].friendlyName, 'Zadarma Torreón');
  assert.equal(slackCalls[0].toNumber, '+528718430130');
  assert.equal(slackCalls[0].fromNumber, '+5215512345678');
});

test('llamada SIP en modo auto: el TwiML incluye live transcription y Record', async () => {
  const res = await postVoice({ CallSid: 'CA_SIP_2', To: 'sip:528718430130@darwin-zadarma.sip.twilio.com', From: 'sip:+5215512345678@sip.zadarma.com' });
  assert.match(res.text, /<Start>\s*<Transcription/);
  assert.match(res.text, /transcription/i);
  assert.match(res.text, /<Record/);
  assert.match(res.text, /walkietalkie\.test\/twilio-voice\/transcription/);
});

test('llamada SIP: el call thread guarda toNumber E.164 y provider zadarma', async () => {
  await postVoice({ CallSid: 'CA_SIP_3', To: 'sip:528718430130@darwin-zadarma.sip.twilio.com', From: 'sip:+5215512345678@sip.zadarma.com' });
  const [thread] = threads();
  assert.equal(thread.toNumber, '+528718430130');
  assert.equal(thread.fromNumber, '+5215512345678');
  assert.equal(thread.friendlyName, 'Zadarma Torreón');
  assert.equal(thread.provider, 'zadarma');
  assert.equal(thread.keypressMode, 'auto');
});

test('llamada SIP: no consulta Twilio (no se escribe el cache de capabilities)', async () => {
  await postVoice({ CallSid: 'CA_SIP_4', To: 'sip:528718430130@darwin-zadarma.sip.twilio.com', From: 'sip:+5215512345678@sip.zadarma.com' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(memory.has('capabilities'), false);
});

test('llamada SIP: loguea el body crudo para confirmar el formato real', async () => {
  await postVoice({ CallSid: 'CA_SIP_5', To: 'sip:528718430130@darwin-zadarma.sip.twilio.com', From: 'sip:+5215512345678@sip.zadarma.com' });
  const raw = logs.find((l) => l.includes('SIP call raw body'));
  assert.ok(raw, 'debe loguear el body SIP crudo');
  assert.match(raw, /sip:528718430130@darwin-zadarma\.sip\.twilio\.com/);
});

test('llamada PSTN de Twilio: igual que siempre, sin log SIP ni provider', async () => {
  const res = await postVoice({ CallSid: 'CA_TW_1', To: '+12025550101', From: '+15551234567' });
  assert.equal(res.status, 200);
  assert.match(res.text, /<Start>\s*<Transcription/);
  assert.equal(slackCalls[0].friendlyName, 'Línea Twilio');
  assert.equal(slackCalls[0].channel, 'C0TWILIO01');
  assert.equal(threads()[0].provider, undefined);
  assert.equal(logs.some((l) => l.includes('SIP call raw body')), false);
});

test('payload sin CallSid: TwiML vacío y nada en Slack', async () => {
  const res = await postVoice({ To: 'sip:528718430130@darwin-zadarma.sip.twilio.com', From: '+1555' });
  assert.equal(res.status, 200);
  assert.equal(slackCalls.length, 0);
});
