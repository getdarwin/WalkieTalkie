const store = require('./store');

const LOGS_KEY = 'logs';
const MAX_ENTRIES = 1000;

/**
 * Returns transaction log entries, newest first.
 *
 * @returns {Promise<object[]>}
 */
async function loadLogs() {
  try {
    return await store.listRange(LOGS_KEY);
  } catch (err) {
    console.error('[logger] Failed to load logs:', err.message);
    return [];
  }
}

/**
 * Appends a transaction record to the log (capped at 1000 entries).
 *
 * @param {object} entry
 * @param {'sms'|'voice-recording'|'voice-transcription'} [entry.type='sms']
 * @param {string} entry.to           Twilio "To" number
 * @param {string} entry.from         Caller/sender number
 * @param {string} [entry.body]       SMS body (sms type)
 * @param {string} [entry.callSid]    Twilio CallSid (voice types)
 * @param {string} [entry.recordingUrl]  Recording URL (voice-recording type)
 * @param {number} [entry.duration]   Call duration in seconds (voice-recording type)
 * @param {string} [entry.transcript] Transcription text (voice-transcription type)
 * @param {string} entry.friendlyName Resolved friendly name
 * @param {string} entry.channel      Slack channel ID routed to
 * @param {string|null} entry.otp     Parsed OTP if detected
 * @param {'success'|'error'} entry.status
 * @param {string} [entry.error]      Error message if status is 'error'
 */
async function logTransaction(entry) {
  try {
    await store.listPush(
      LOGS_KEY,
      { id: Date.now(), timestamp: new Date().toISOString(), type: 'sms', ...entry },
      MAX_ENTRIES
    );
  } catch (err) {
    console.error('[logger] Failed to write log entry:', err.message);
  }
}

module.exports = { logTransaction, loadLogs };
