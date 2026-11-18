const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCallThread } = require('../src/services/callThreadResolver');

function deps(overrides = {}) {
  const saved = {};
  const calls = { created: 0, fetched: 0 };
  return {
    saved,
    calls,
    getCallThread: async () => null,
    saveCallThread: async (sid, data) => { saved[sid] = data; },
    fetchCallParties: async () => { calls.fetched++; return { to: '+525500000000', from: '+525541696423' }; },
    lookupLine: async () => ({ friendlyName: 'Linea MX', channel: 'C0AQN4ELYTF', keypressMode: 'auto' }),
    createThread: async () => { calls.created++; return '111.222'; },
    sleep: async () => {},
    waitMs: 3000,
    ...overrides,
  };
}

test('record with threadTs is returned as-is', async () => {
  const record = { channel: 'C1', threadTs: '1.1', toNumber: '+1' };
  const d = deps({ getCallThread: async () => record });
  assert.deepEqual(await resolveCallThread('CA1', d), { thread: record, recovered: false });
  assert.equal(d.calls.created, 0);
});

test('record without threadTs → waits for the in-flight Slack post', async () => {
  let reads = 0;
  const d = deps({
    getCallThread: async () => (++reads >= 3 ? { channel: 'C1', threadTs: '9.9' } : { channel: 'C1' }),
  });
  const result = await resolveCallThread('CA1', d);
  assert.equal(result.thread.threadTs, '9.9');
  assert.equal(result.recovered, false);
  assert.equal(d.calls.created, 0);
});

test('record whose Slack post never landed → creates the thread from the record', async () => {
  const record = { channel: 'C1', toNumber: '+1', fromNumber: '+2', friendlyName: 'L', keypressMode: 'auto', keypress: '7' };
  const d = deps({ getCallThread: async () => record });
  const result = await resolveCallThread('CA1', d);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.thread, { ...record, threadTs: '111.222' });
  assert.equal(d.calls.fetched, 0);
  assert.deepEqual(d.saved.CA1, result.thread);
});

test('no record at all → rebuilds from the Twilio call', async () => {
  const d = deps();
  const result = await resolveCallThread('CA1', d);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.thread, {
    channel: 'C0AQN4ELYTF',
    toNumber: '+525500000000',
    fromNumber: '+525541696423',
    friendlyName: 'Linea MX',
    keypressMode: 'auto',
    threadTs: '111.222',
  });
});

test('call unknown to Twilio → null with a reason, no throw', async () => {
  const d = deps({ fetchCallParties: async () => null });
  const result = await resolveCallThread('CA1', d);
  assert.equal(result.thread, null);
  assert.match(result.error, /not found/);
});

test('Slack failure while rebuilding → null with the error, no throw', async () => {
  const d = deps({ createThread: async () => { throw new Error('channel_not_found'); } });
  const result = await resolveCallThread('CA1', d);
  assert.equal(result.thread, null);
  assert.equal(result.error, 'channel_not_found');
});
