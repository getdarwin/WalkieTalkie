const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '../../data/logs.json');

function loadLogs() {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveLogs(logs) {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(logs, null, 2));
}

/**
 * Appends a transaction record to data/logs.json.
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
function logTransaction(entry) {
  const logs = loadLogs();
  logs.unshift({
    id: Date.now(),
    timestamp: new Date().toISOString(),
    type: 'sms',
    ...entry,
  });
  // Keep last 1000 entries
  saveLogs(logs.slice(0, 1000));
}

module.exports = { logTransaction, loadLogs };
