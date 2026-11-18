const test = require('node:test');
const assert = require('node:assert/strict');
const { uploadFileToThread, uploadFailureNotice } = require('../src/services/slackUpload');

const params = { channel: 'C1', threadTs: '1.2', buffer: Buffer.from('x'), filename: 'a.mp3', title: 't' };

function slackError(code) {
  const err = new Error(`An API error occurred: ${code}`);
  err.data = { ok: false, error: code };
  return err;
}

/** Fake client: `uploads` is the sequence of outcomes (null = ok, string = error code). */
function fakeClient({ uploads, joinError = null }) {
  const calls = { upload: 0, join: 0 };
  return {
    calls,
    files: {
      uploadV2: async () => {
        const outcome = uploads[calls.upload++];
        if (outcome) throw slackError(outcome);
      },
    },
    conversations: {
      join: async () => {
        calls.join++;
        if (joinError) throw slackError(joinError);
      },
    },
  };
}

test('uploads directly when the bot is in the channel', async () => {
  const client = fakeClient({ uploads: [null] });
  assert.deepEqual(await uploadFileToThread(client, params), { ok: true });
  assert.equal(client.calls.join, 0);
});

test('not_in_channel → joins the channel and retries once', async () => {
  const client = fakeClient({ uploads: ['not_in_channel', null] });
  assert.deepEqual(await uploadFileToThread(client, params), { ok: true, joined: true });
  assert.equal(client.calls.join, 1);
  assert.equal(client.calls.upload, 2);
});

test('join fails (missing scope) → returns not_in_channel without throwing', async () => {
  const client = fakeClient({ uploads: ['not_in_channel'], joinError: 'missing_scope' });
  const result = await uploadFileToThread(client, params);
  assert.deepEqual(result, { ok: false, error: 'not_in_channel', joinError: 'missing_scope' });
  assert.match(uploadFailureNotice(result), /\/invite @Walkie Talkie/);
});

test('other upload errors are returned, not retried', async () => {
  const client = fakeClient({ uploads: ['ratelimited'] });
  const result = await uploadFileToThread(client, params);
  assert.deepEqual(result, { ok: false, error: 'ratelimited' });
  assert.equal(client.calls.join, 0);
  assert.match(uploadFailureNotice(result), /ratelimited/);
});
