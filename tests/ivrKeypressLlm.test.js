const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLlmKeypress, detectKeypressWithLlm, detectKeypressSmart } = require('../src/services/ivrKeypress');

const fakeClient = (content, { fail = false } = {}) => {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (args) => {
          calls.push(args);
          if (fail) throw new Error('boom');
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
};

test('parseLlmKeypress accepts a confident digit', () => {
  assert.deepEqual(parseLlmKeypress('{"key":"8","confidence":0.95}'), { digit: '8', confidence: 0.95 });
});

test('parseLlmKeypress accepts numeric and word keys', () => {
  assert.equal(parseLlmKeypress('{"key":8,"confidence":0.9}').digit, '8');
  assert.equal(parseLlmKeypress('{"key":"ocho","confidence":0.9}').digit, '8');
  assert.equal(parseLlmKeypress('{"key":"#","confidence":0.9}').digit, '#');
});

test('parseLlmKeypress rejects null key, low confidence, garbage', () => {
  assert.equal(parseLlmKeypress('{"key":null,"confidence":0.99}'), null);
  assert.equal(parseLlmKeypress('{"key":"8","confidence":0.4}'), null);
  assert.equal(parseLlmKeypress('{"key":"12","confidence":0.9}'), null);
  assert.equal(parseLlmKeypress('{"key":"<Say>hi</Say>","confidence":0.9}'), null);
  assert.equal(parseLlmKeypress('not json'), null);
  assert.equal(parseLlmKeypress(''), null);
});

test('detectKeypressWithLlm returns digit + matched text', async () => {
  const client = fakeClient('{"key":"8","confidence":0.92}');
  const r = await detectKeypressWithLlm('para seguir apretá el numerito ocho', { client });
  assert.equal(r.digit, '8');
  assert.match(r.matched, /numerito ocho/);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].response_format.type, 'json_object');
});

test('detectKeypressWithLlm skips very short fragments without calling the model', async () => {
  const client = fakeClient('{"key":"8","confidence":0.99}');
  assert.equal(await detectKeypressWithLlm('ocho', { client }), null);
  assert.equal(client.calls.length, 0);
});

test('detectKeypressWithLlm never throws when the model fails', async () => {
  const client = fakeClient('', { fail: true });
  assert.equal(await detectKeypressWithLlm('para continuar aprieta la tecla ocho', { client }), null);
});

test('detectKeypressSmart prefers the regex and does not call the model', async () => {
  const client = fakeClient('{"key":"1","confidence":0.99}');
  const r = await detectKeypressSmart('Para continuar, aprieta la tecla ocho', { client });
  assert.equal(r.digit, '8');
  assert.equal(r.source, 'regex');
  assert.equal(client.calls.length, 0);
});

test('detectKeypressSmart falls back to the model when the regex misses', async () => {
  const client = fakeClient('{"key":"8","confidence":0.9}');
  const r = await detectKeypressSmart('Si querés seguir, dale al numerito ocho', { client });
  assert.equal(r.digit, '8');
  assert.equal(r.source, 'llm');
});

test('detectKeypressSmart with useLlm=false stays regex-only', async () => {
  const client = fakeClient('{"key":"8","confidence":0.9}');
  assert.equal(await detectKeypressSmart('dale al numerito ocho', { useLlm: false, client }), null);
});
