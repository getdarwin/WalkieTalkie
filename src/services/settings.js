const fs = require('fs');
const path = require('path');
const store = require('./store');

const SETTINGS_KEY = 'settings';
const LEGACY_PATH = path.join(__dirname, '../../data/settings.json');

/**
 * Loads settings from the store; on first run seeds from the legacy
 * data/settings.json file (pre-Redis format) if present.
 */
async function loadSettingsWithSeed() {
  const settings = await store.getJSON(SETTINGS_KEY);
  if (settings) return settings;

  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'));
    if (legacy && Object.keys(legacy).length > 0) {
      await store.setJSON(SETTINGS_KEY, legacy);
      console.log('[settings] Seeded settings from legacy data/settings.json');
      return legacy;
    }
  } catch {
    // No legacy file — start empty
  }
  return {};
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
 * set in the store.
 *
 * @param {string} dotPath  e.g. 'twilio.accountSid'
 * @returns {Promise<string|undefined>}
 */
async function getSetting(dotPath) {
  let settings = null;
  try {
    settings = await loadSettingsWithSeed();
  } catch (err) {
    console.error('[settings] Failed to read settings from store:', err.message);
  }
  const value = settings ? getNestedValue(settings, dotPath) : undefined;
  if (value !== undefined && value !== '') return value;
  const envKey = ENV_FALLBACKS[dotPath];
  return envKey ? process.env[envKey] : undefined;
}

/**
 * Sets a setting by dot-path and persists it.
 *
 * @param {string} dotPath  e.g. 'twilio.authToken'
 * @param {string} value
 */
async function setSetting(dotPath, value) {
  const settings = await loadSettingsWithSeed();
  setNestedValue(settings, dotPath, value);
  await store.setJSON(SETTINGS_KEY, settings);
}

module.exports = { getSetting, setSetting };
