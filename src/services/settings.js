const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '../../data/settings.json');

// ─── File I/O ─────────────────────────────────────────────────────────────────

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(data) {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2));
  try { fs.chmodSync(SETTINGS_PATH, 0o600); } catch {} // restrict to owner only
}

// ─── Dot-path helpers ─────────────────────────────────────────────────────────

function getNestedValue(obj, dotPath) {
  return dotPath.split('.').reduce((cur, key) => (cur && cur[key] !== undefined ? cur[key] : undefined), obj);
}

function setNestedValue(obj, dotPath, value) {
  const keys = dotPath.split('.');
  const last = keys.pop();
  const target = keys.reduce((cur, key) => {
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
    return cur[key];
  }, obj);
  target[last] = value;
}

// ─── ENV fallbacks ────────────────────────────────────────────────────────────

const ENV_FALLBACKS = {
  'twilio.accountSid': 'TWILIO_ACCOUNT_SID',
  'twilio.authToken': 'TWILIO_AUTH_TOKEN',
  'slack.defaultChannel': 'SLACK_DEFAULT_CHANNEL',
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Gets a setting by dot-path. Falls back to the corresponding env var if not
 * set in data/settings.json.
 *
 * @param {string} dotPath  e.g. 'twilio.accountSid'
 * @returns {string|undefined}
 */
function getSetting(dotPath) {
  const settings = loadSettings();
  const value = getNestedValue(settings, dotPath);
  if (value !== undefined && value !== '') return value;
  const envKey = ENV_FALLBACKS[dotPath];
  return envKey ? process.env[envKey] : undefined;
}

/**
 * Sets a setting by dot-path and saves to data/settings.json.
 *
 * @param {string} dotPath  e.g. 'twilio.authToken'
 * @param {string} value
 */
function setSetting(dotPath, value) {
  const settings = loadSettings();
  setNestedValue(settings, dotPath, value);
  saveSettings(settings);
}

module.exports = { getSetting, setSetting, loadSettings };
