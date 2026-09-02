const fs = require('fs');
const path = require('path');
const store = require('./store');
const { getSetting } = require('./settings');
const { resolveKeypressMode, isKeypressMode, DEFAULT_KEYPRESS_MODE } = require('./ivrKeypress');

const NUMBERS_KEY = 'numbers';
const SEED_PATH = path.join(__dirname, '../../config/numbers.json');

// ─── Read ──────────────────────────────────────────────────────────────────────

/**
 * Loads the number directory from the store.
 * On first run (empty store), seeds it from config/numbers.json so existing
 * deployments migrate their directory automatically.
 *
 * @returns {Promise<{ numbers: Record<string, string|object> }>}
 */
async function loadConfig() {
  try {
    const numbers = await store.getJSON(NUMBERS_KEY);
    if (numbers) return { numbers };
  } catch (err) {
    console.error('[numbers] Failed to load directory from store:', err.message);
    return { numbers: {} };
  }

  // Seed from the bundled config file (read-only on Vercel is fine — we only read)
  try {
    const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    const numbers = seed.numbers || {};
    if (Object.keys(numbers).length > 0) {
      await store.setJSON(NUMBERS_KEY, numbers);
      console.log(`[numbers] Seeded directory from config/numbers.json (${Object.keys(numbers).length} lines)`);
    }
    return { numbers };
  } catch {
    return { numbers: {} };
  }
}

async function saveNumbers(numbers) {
  await store.setJSON(NUMBERS_KEY, numbers);
}

/**
 * Returns the friendly name for a Twilio "To" number.
 * Falls back to the raw E.164 number if unmapped.
 */
async function getFriendlyName(phoneNumber) {
  const { numbers } = await loadConfig();
  const entry = numbers[phoneNumber];
  if (!entry) return phoneNumber;
  return typeof entry === 'string' ? entry : (entry.name || phoneNumber);
}

/**
 * Returns the Slack channel ID for a Twilio "To" number.
 * Falls back to the configured default channel (store → env var).
 */
async function getChannel(phoneNumber) {
  const { numbers } = await loadConfig();
  const entry = numbers[phoneNumber];
  if (entry && typeof entry === 'object' && entry.channel) {
    return entry.channel;
  }
  return getSetting('slack.defaultChannel');
}

/**
 * Returns the DTMF digits to auto-press when a call arrives on this number.
 * Returns null if not configured.
 *
 * @param {string} phoneNumber  E.164 format
 * @returns {Promise<string|null>}
 */
async function getDtmf(phoneNumber) {
  const { numbers } = await loadConfig();
  const entry = numbers[phoneNumber];
  if (entry && typeof entry === 'object' && entry.dtmf) return entry.dtmf;
  return null;
}

/** Workspace-wide keypress mode ("auto" | "none"); lines may override it. */
async function getGlobalKeypressMode() {
  const value = await getSetting('ivr.keypressMode');
  return isKeypressMode(value) ? value : DEFAULT_KEYPRESS_MODE;
}

/**
 * Effective IVR keypress behaviour for a Twilio "To" number: the line's own
 * `keypressMode` when set, otherwise the workspace default.
 *
 * @param {string} phoneNumber  E.164 format
 * @returns {Promise<{ mode: 'auto'|'fixed'|'none', dtmf: string|null, source: 'line'|'global' }>}
 */
async function getKeypressConfig(phoneNumber) {
  const [{ numbers }, globalMode] = await Promise.all([loadConfig(), getGlobalKeypressMode()]);
  return resolveKeypressMode(numbers[phoneNumber], globalMode);
}

/**
 * Returns the transcription language ISO-639-1 code for a number (e.g. "es", "pt").
 * Returns null if not configured — Whisper will auto-detect.
 *
 * @param {string} phoneNumber  E.164 format
 * @returns {Promise<string|null>}
 */
async function getLanguage(phoneNumber) {
  const { numbers } = await loadConfig();
  const entry = numbers[phoneNumber];
  if (entry && typeof entry === 'object' && entry.language) return entry.language;
  return null;
}

// ─── Write ─────────────────────────────────────────────────────────────────────

/**
 * Upserts a number entry in the directory.
 * If name and channel are both empty, stores a simple string (empty string).
 *
 * @param {string} phoneNumber  E.164 format
 * @param {{ name?: string, channel?: string, dtmf?: string, language?: string, keypressMode?: string, routing?: string }} opts
 *   keypressMode: "auto" | "fixed" | "none"; empty string = inherit the global default
 */
async function setNumber(phoneNumber, { name = '', channel = '', dtmf = '', language = '', keypressMode = '', routing = '' } = {}) {
  const { numbers } = await loadConfig();
  const updated = { ...numbers };

  // Preserve external routing (vapi/talkyto/pipecat) unless explicitly overridden
  const existing = updated[phoneNumber];
  const preservedRouting = routing || ((existing && typeof existing === 'object' && existing.routing) || '');

  delete updated[phoneNumber]; // move to end so .reverse() shows it first in App Home

  const entry = {};
  if (name) entry.name = name;
  if (channel) entry.channel = channel;
  if (dtmf) entry.dtmf = dtmf;
  if (language) entry.language = language;
  if (isKeypressMode(keypressMode)) entry.keypressMode = keypressMode;
  if (preservedRouting) entry.routing = preservedRouting;

  const keys = Object.keys(entry);
  if (keys.length === 0) {
    updated[phoneNumber] = '';
  } else if (keys.length === 1 && entry.name) {
    updated[phoneNumber] = name; // backward compat: plain string when only name
  } else {
    updated[phoneNumber] = entry;
  }
  await saveNumbers(updated);
}

/**
 * Removes a number entry from the directory.
 *
 * @param {string} phoneNumber  E.164 format
 */
async function removeNumber(phoneNumber) {
  const { numbers } = await loadConfig();
  const updated = { ...numbers };
  delete updated[phoneNumber];
  await saveNumbers(updated);
}

/**
 * Replaces the entire number directory with the provided map.
 * Used by the CSV bulk-upload flow.
 *
 * @param {Record<string, string|{name:string,channel:string}>} numbersMap
 */
async function replaceAllNumbers(numbersMap) {
  await saveNumbers(numbersMap);
}

module.exports = {
  loadConfig,
  getFriendlyName,
  getChannel,
  getDtmf,
  getLanguage,
  getGlobalKeypressMode,
  getKeypressConfig,
  setNumber,
  removeNumber,
  replaceAllNumbers,
};
