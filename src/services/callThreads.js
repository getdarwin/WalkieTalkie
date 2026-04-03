const fs = require('fs');
const path = require('path');

const CALL_THREADS_PATH = path.join(__dirname, '../../data/call-threads.json');
const MAX_ENTRIES = 500;

// ─── File I/O ─────────────────────────────────────────────────────────────────

function loadCallThreads() {
  try {
    if (!fs.existsSync(CALL_THREADS_PATH)) return {};
    return JSON.parse(fs.readFileSync(CALL_THREADS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function pruneAndSave(store) {
  const keys = Object.keys(store);
  if (keys.length > MAX_ENTRIES) {
    // Remove oldest entries (keys are insertion-ordered in V8)
    const excess = keys.slice(0, keys.length - MAX_ENTRIES);
    for (const key of excess) delete store[key];
  }
  const dir = path.dirname(CALL_THREADS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CALL_THREADS_PATH, JSON.stringify(store, null, 2));
}

// ─── Public API ───────────────────────────────────────────────────────────────

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
function saveCallThread(callSid, data) {
  const store = loadCallThreads();
  store[callSid] = { ...data, savedAt: new Date().toISOString() };
  pruneAndSave(store);
}

/**
 * Retrieves a stored call thread by CallSid.
 * Returns null if not found.
 *
 * @param {string} callSid
 * @returns {{ channel, threadTs, toNumber, fromNumber, friendlyName } | null}
 */
function getCallThread(callSid) {
  const store = loadCallThreads();
  return store[callSid] || null;
}

module.exports = { saveCallThread, getCallThread };
