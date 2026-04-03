const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const twilio = require('twilio');

const CAPABILITIES_PATH = path.join(__dirname, '../../data/capabilities.json');
const SYNC_INTERVAL_DAYS = 14;

// ─── File I/O ─────────────────────────────────────────────────────────────────

function loadCapabilities() {
  try {
    if (!fs.existsSync(CAPABILITIES_PATH)) return { lastSyncedAt: null, numbers: {} };
    return JSON.parse(fs.readFileSync(CAPABILITIES_PATH, 'utf8'));
  } catch {
    return { lastSyncedAt: null, numbers: {} };
  }
}

function saveCapabilities(data) {
  const dir = path.dirname(CAPABILITIES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CAPABILITIES_PATH, JSON.stringify(data, null, 2));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isStale(lastSyncedAt) {
  if (!lastSyncedAt) return true;
  const ageMs = Date.now() - new Date(lastSyncedAt).getTime();
  return ageMs > SYNC_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
}

function buildRecord(num) {
  return {
    sid: num.sid,
    friendlyName: num.friendlyName,
    phoneNumber: num.phoneNumber,
    capabilities: {
      sms: !!(num.capabilities && num.capabilities.sms),
      voice: !!(num.capabilities && num.capabilities.voice),
      mms: !!(num.capabilities && num.capabilities.mms),
      fax: !!(num.capabilities && num.capabilities.fax),
    },
    fetchedAt: new Date().toISOString(),
  };
}

function makeClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// ─── Sync functions ───────────────────────────────────────────────────────────

/**
 * Fetches all numbers from Twilio and rebuilds the full capabilities store.
 * Sets lastSyncedAt on completion.
 */
async function syncAllCapabilities() {
  console.log('[capabilities] Starting full sync...');
  try {
    const client = makeClient();
    const numbers = await client.incomingPhoneNumbers.list();
    const data = loadCapabilities();

    for (const num of numbers) {
      data.numbers[num.phoneNumber] = buildRecord(num);
    }

    data.lastSyncedAt = new Date().toISOString();
    saveCapabilities(data);
    console.log(`[capabilities] Full sync complete — ${numbers.length} numbers`);
  } catch (err) {
    console.error('[capabilities] Full sync failed:', err.message);
  }
}

/**
 * Fetches capabilities for a single E.164 number from Twilio.
 * Updates data/capabilities.json with the result.
 *
 * @param {string} e164
 * @returns {object|null}
 */
async function fetchSingleCapability(e164) {
  try {
    const client = makeClient();
    const results = await client.incomingPhoneNumbers.list({ phoneNumber: e164 });

    if (!results.length) {
      console.warn(`[capabilities] Number not found in Twilio account: ${e164}`);
      return null;
    }

    const record = buildRecord(results[0]);
    const data = loadCapabilities();
    data.numbers[e164] = record;
    saveCapabilities(data);

    console.log(`[capabilities] Cached ${e164} — sms:${record.capabilities.sms} voice:${record.capabilities.voice}`);
    return record;
  } catch (err) {
    console.error(`[capabilities] Failed to fetch ${e164}:`, err.message);
    return null;
  }
}

/**
 * No-op if the number is already cached. Otherwise fetches from Twilio.
 * Designed to be called fire-and-forget from webhook handlers.
 *
 * @param {string} e164
 */
async function checkAndCacheCapabilities(e164) {
  const { numbers } = loadCapabilities();
  if (numbers[e164]) return;
  await fetchSingleCapability(e164);
}

/**
 * Returns the full capabilities store.
 * Used by the GET /capabilities route.
 */
function getCapabilities() {
  return loadCapabilities();
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Called once at server startup.
 * - Registers a cron job to re-sync every ~14 days (3 AM on day 1 and 15 of each month)
 * - If the store is stale or missing, fires a full sync immediately (non-blocking)
 */
function initCapabilitiesSync() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.warn('[capabilities] Missing Twilio credentials — capability sync disabled');
    return;
  }

  // Run at 3 AM on the 1st and 15th of every month (~every 14 days)
  cron.schedule('0 3 1,15 * *', () => {
    console.log('[capabilities] Scheduled sync triggered');
    syncAllCapabilities().catch((err) =>
      console.error('[capabilities] Scheduled sync error:', err.message)
    );
  });

  const { lastSyncedAt } = loadCapabilities();
  if (isStale(lastSyncedAt)) {
    console.log('[capabilities] Store is stale or missing — running initial sync');
    syncAllCapabilities().catch((err) =>
      console.error('[capabilities] Initial sync error:', err.message)
    );
  } else {
    console.log(`[capabilities] Store is fresh (last synced: ${lastSyncedAt})`);
  }
}

module.exports = {
  initCapabilitiesSync,
  syncAllCapabilities,
  checkAndCacheCapabilities,
  getCapabilities,
  loadCapabilities,
  saveCapabilities,
};
