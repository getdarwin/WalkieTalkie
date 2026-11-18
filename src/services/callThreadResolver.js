/**
 * Finds — or rebuilds — the Slack thread for a call, so a recording is never
 * dropped just because the thread mapping is missing.
 *
 * The answer webhook saves the call record first and posts to Slack second,
 * so a callback can arrive while the Slack post is still in flight (record
 * without threadTs) or after the post failed. Before, both cases silently
 * discarded the recording and left "Recording in progress..." forever.
 *
 * Resolution order:
 *   1. record with threadTs → done
 *   2. record without threadTs → wait briefly for the in-flight post
 *   3. still nothing → create the thread now (from the record, or from the
 *      call's To/From fetched from Twilio when there is no record at all)
 */

const DEFAULT_WAIT_MS = 6_000;
const POLL_MS = 1_000;

/**
 * @param {string} callSid
 * @param {object} deps
 * @param {(sid: string) => Promise<object|null>} deps.getCallThread
 * @param {(sid: string, data: object) => Promise<void>} deps.saveCallThread
 * @param {(sid: string) => Promise<{ to: string, from: string, provider?: string }|null>} deps.fetchCallParties
 * @param {(to: string) => Promise<{ friendlyName: string, channel: string, keypressMode: string }>} deps.lookupLine
 * @param {(call: object) => Promise<string>} deps.createThread  posts the call start, returns thread_ts
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {number} [deps.waitMs]
 * @returns {Promise<{ thread: object|null, recovered: boolean, error?: string }>}
 */
async function resolveCallThread(callSid, deps) {
  const waitMs = deps.waitMs ?? DEFAULT_WAIT_MS;

  let record = await deps.getCallThread(callSid);
  if (record?.threadTs) return { thread: record, recovered: false };

  // The answer webhook may still be posting to Slack: give it a moment.
  if (record) {
    for (let waited = 0; waited < waitMs; waited += POLL_MS) {
      await deps.sleep(POLL_MS);
      record = await deps.getCallThread(callSid);
      if (record?.threadTs) return { thread: record, recovered: false };
    }
  }

  try {
    let base = record;
    if (!base) {
      const parties = await deps.fetchCallParties(callSid);
      if (!parties?.to) return { thread: null, recovered: false, error: 'call not found in Twilio' };
      const line = await deps.lookupLine(parties.to);
      base = {
        channel: line.channel,
        toNumber: parties.to,
        fromNumber: parties.from,
        friendlyName: line.friendlyName,
        keypressMode: line.keypressMode,
        ...(parties.provider === 'zadarma' ? { provider: 'zadarma' } : {}),
      };
    }

    const threadTs = await deps.createThread(base);
    const thread = { ...base, threadTs };
    await deps.saveCallThread(callSid, thread);
    return { thread, recovered: true };
  } catch (err) {
    return { thread: null, recovered: false, error: err?.message || String(err) };
  }
}

module.exports = { resolveCallThread, DEFAULT_WAIT_MS };
