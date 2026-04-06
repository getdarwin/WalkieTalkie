const fs = require('fs');
const path = require('path');
const { getSetting } = require('./settings');

const CONFIG_PATH = path.join(__dirname, '../../config/numbers.json');

// ─── Read ──────────────────────────────────────────────────────────────────────

/**
 * Reads config/numbers.json fresh on every call so edits take effect
 * without restarting the server.
 */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('[numbers] Failed to load config/numbers.json:', err.message);
    return { numbers: {} };
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Returns the friendly name for a Twilio "To" number.
 * Falls back to the raw E.164 number if unmapped.
 */
function getFriendlyName(phoneNumber) {
  const { numbers } = loadConfig();
  const entry = numbers[phoneNumber];
  if (!entry) return phoneNumber;
  return typeof entry === 'string' ? entry : (entry.name || phoneNumber);
}

/**
 * Returns the Slack channel ID for a Twilio "To" number.
 * Falls back to the configured default channel (settings.json → env var).
 */
function getChannel(phoneNumber) {
  const { numbers } = loadConfig();
  const entry = numbers[phoneNumber];
  if (entry && typeof entry === 'object' && entry.channel) {
    return entry.channel;
  }
  return getSetting('slack.defaultChannel');
}

// ─── Write ─────────────────────────────────────────────────────────────────────

/**
 * Upserts a number entry in config/numbers.json.
 * If name and channel are both empty, stores a simple string (empty string).
 *
 * @param {string} phoneNumber  E.164 format
 * @param {{ name?: string, channel?: string }} opts
 */
function setNumber(phoneNumber, { name = '', channel = '' } = {}) {
  const config = loadConfig();
  if (name && channel) {
    config.numbers[phoneNumber] = { name, channel };
  } else if (name) {
    config.numbers[phoneNumber] = name;
  } else if (channel) {
    config.numbers[phoneNumber] = { name: '', channel };
  } else {
    config.numbers[phoneNumber] = '';
  }
  saveConfig(config);
}

/**
 * Removes a number entry from config/numbers.json.
 *
 * @param {string} phoneNumber  E.164 format
 */
function removeNumber(phoneNumber) {
  const config = loadConfig();
  delete config.numbers[phoneNumber];
  saveConfig(config);
}

/**
 * Replaces the entire number directory with the provided map.
 * Used by the CSV bulk-upload flow.
 *
 * @param {Record<string, string|{name:string,channel:string}>} numbersMap
 */
function replaceAllNumbers(numbersMap) {
  saveConfig({ numbers: numbersMap });
}

module.exports = { loadConfig, saveConfig, getFriendlyName, getChannel, setNumber, removeNumber, replaceAllNumbers };
