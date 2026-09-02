const store = require('./store');

// Call → thread mappings are short-lived: the recording callback arrives
// minutes after the call. 7 days of TTL is generous headroom.
const TTL_SECONDS = 7 * 24 * 60 * 60;

function keyFor(callSid) {
  return `callthread:${callSid}`;
}

/**
 * Persists a Slack thread reference for a Twilio call.
 *
 * @param {string} callSid   Twilio CallSid (e.g. "CA1234...")
 * @param {object} data
 * @param {string} data.channel       Slack channel ID
 * @param {string} data.threadTs      Slack message timestamp (thread_ts)
 * @param {string} data.toNumber      E.164 Twilio "To" number
 * @param {string} data.fromNumber    E.164 caller number
 * @param {string} data.friendlyName  Resolved friendly name
 */
async function saveCallThread(callSid, data) {
  await store.setJSON(keyFor(callSid), { ...data, savedAt: new Date().toISOString() }, TTL_SECONDS);
}

/**
 * Retrieves a stored call thread by CallSid.
 * Returns null if not found.
 *
 * @param {string} callSid
 * @returns {Promise<{ channel, threadTs, toNumber, fromNumber, friendlyName } | null>}
 */
async function getCallThread(callSid) {
  return store.getJSON(keyFor(callSid));
}

/**
 * Merges extra fields into an existing call thread record (e.g. the IVR key
 * that was pressed). No-op if the record does not exist.
 *
 * @param {string} callSid
 * @param {object} patch
 * @returns {Promise<object|null>} the updated record
 */
async function updateCallThread(callSid, patch) {
  const existing = await getCallThread(callSid);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  await store.setJSON(keyFor(callSid), updated, TTL_SECONDS);
  return updated;
}

module.exports = { saveCallThread, getCallThread, updateCallThread };
