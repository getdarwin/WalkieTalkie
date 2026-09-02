const twilio = require('twilio');
const store = require('./store');
const { getSetting } = require('./settings');
const { loadConfig, setNumber } = require('./numbers');

const CAPABILITIES_KEY = 'capabilities';
const SYNC_INTERVAL_DAYS = 14;

// ─── Store I/O ────────────────────────────────────────────────────────────────

async function loadCapabilities() {
  try {
    return (await store.getJSON(CAPABILITIES_KEY)) || { lastSyncedAt: null, numbers: {} };
  } catch (err) {
    console.error('[capabilities] Failed to load capabilities:', err.message);
    return { lastSyncedAt: null, numbers: {} };
  }
}

async function saveCapabilities(data) {
  await store.setJSON(CAPABILITIES_KEY, data);
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
    smsUrl: num.smsUrl || null,
    voiceUrl: num.voiceUrl || null,
    fetchedAt: new Date().toISOString(),
  };
}

async function makeClient() {
  const [accountSid, authToken] = await Promise.all([
    getSetting('twilio.accountSid'),
    getSetting('twilio.authToken'),
  ]);
  return twilio(accountSid, authToken);
}

// ─── Sync functions ───────────────────────────────────────────────────────────

/**
 * Fetches all numbers from Twilio and rebuilds the full capabilities store.
 * Sets lastSyncedAt on completion.
 * Auto-imports any numbers whose Twilio webhooks already point to this
 * WalkieTalkie instance (WEBHOOK_BASE_URL) if they are not yet in the directory.
 *
 * Scheduling: locally this can be called ad-hoc; on Vercel the
 * /cron/sync-capabilities endpoint (vercel.json crons) triggers it.
 */
async function syncAllCapabilities() {
  console.log('[capabilities] Starting full sync...');
  const client = await makeClient();
  const numbers = await client.incomingPhoneNumbers.list();
  const data = await loadCapabilities();
  const baseUrl = process.env.WEBHOOK_BASE_URL;

  // Load current directory once before iterating
  const { numbers: configNumbers } = await loadConfig();
  let autoImported = 0;

  for (const num of numbers) {
    data.numbers[num.phoneNumber] = buildRecord(num);

    // Auto-import numbers already connected to this WalkieTalkie instance
    if (baseUrl && !(num.phoneNumber in configNumbers)) {
      const smsConnected = num.smsUrl && num.smsUrl.startsWith(baseUrl);
      const voiceConnected = num.voiceUrl && num.voiceUrl.startsWith(baseUrl);
      if (smsConnected || voiceConnected) {
        await setNumber(num.phoneNumber, { name: num.friendlyName || '' });
        autoImported++;
        console.log(`[capabilities] Auto-imported ${num.phoneNumber} (already connected to WalkieTalkie)`);
      }
    }
  }

  data.lastSyncedAt = new Date().toISOString();
  await saveCapabilities(data);
  console.log(`[capabilities] Full sync complete — ${numbers.length} numbers${autoImported ? `, ${autoImported} auto-imported` : ''}`);
  return { count: numbers.length, autoImported };
}

/**
 * Runs a full sync only when the store is stale (>14 days) or empty.
 * Used by the cron endpoint and local startup.
 */
async function syncIfStale() {
  const { lastSyncedAt } = await loadCapabilities();
  if (!isStale(lastSyncedAt)) {
    console.log(`[capabilities] Store is fresh (last synced: ${lastSyncedAt})`);
    return { skipped: true, lastSyncedAt };
  }
  return syncAllCapabilities();
}

/**
 * Fetches capabilities for a single E.164 number from Twilio.
 * Updates the capabilities store with the result.
 *
 * @param {string} e164
 * @returns {Promise<object|null>}
 */
async function fetchSingleCapability(e164) {
  try {
    const client = await makeClient();
    const results = await client.incomingPhoneNumbers.list({ phoneNumber: e164 });

    if (!results.length) {
      console.warn(`[capabilities] Number not found in Twilio account: ${e164}`);
      return null;
    }

    const record = buildRecord(results[0]);
    const data = await loadCapabilities();
    data.numbers[e164] = record;
    await saveCapabilities(data);

    console.log(`[capabilities] Cached ${e164} — sms:${record.capabilities.sms} voice:${record.capabilities.voice}`);
    return record;
  } catch (err) {
    console.error(`[capabilities] Failed to fetch ${e164}:`, err.message);
    return null;
  }
}

/**
 * No-op if the number is already cached. Otherwise fetches from Twilio.
 * Designed to be called fire-and-forget (via backgroundTask) from webhook handlers.
 *
 * @param {string} e164
 */
async function checkAndCacheCapabilities(e164) {
  const { numbers } = await loadCapabilities();
  if (numbers[e164]) return;
  await fetchSingleCapability(e164);
}

/**
 * Returns the full capabilities store.
 * Used by the GET /capabilities route and the App Home view.
 */
async function getCapabilities() {
  return loadCapabilities();
}

/**
 * Points a single number's Twilio webhooks at this WalkieTalkie instance.
 * Uses the cached SID if available, otherwise fetches from Twilio first.
 *
 * @param {string} phone  E.164 number
 * @returns {Promise<{ sms: boolean, voice: boolean }>} capabilities that were connected
 */
async function connectNumberToWalkieTalkie(phone) {
  const baseUrl = process.env.WEBHOOK_BASE_URL;
  if (!baseUrl) throw new Error('WEBHOOK_BASE_URL is not configured');

  let record = (await loadCapabilities()).numbers[phone];
  if (!record) {
    record = await fetchSingleCapability(phone);
  }
  if (!record) throw new Error(`Number ${phone} not found in Twilio account`);

  const { sid, capabilities } = record;
  const update = {};
  if (capabilities.sms) {
    update.smsUrl = `${baseUrl}/twilio-webhook`;
    update.smsMethod = 'POST';
    update.smsApplicationSid = '';  // clear any TwiML App that may override the URL
  }
  if (capabilities.voice) {
    update.voiceUrl = `${baseUrl}/twilio-voice`;
    update.voiceMethod = 'POST';
    update.voiceApplicationSid = '';  // clear any TwiML App that may override the URL
  }

  if (Object.keys(update).length === 0) {
    throw new Error(`Number ${phone} has no SMS or voice capabilities to connect`);
  }

  const client = await makeClient();
  await client.incomingPhoneNumbers(sid).update(update);

  console.log(`[capabilities] Connected ${phone} → WalkieTalkie (sms:${!!capabilities.sms} voice:${!!capabilities.voice})`);
  return { sms: !!capabilities.sms, voice: !!capabilities.voice };
}

module.exports = {
  syncAllCapabilities,
  syncIfStale,
  checkAndCacheCapabilities,
  getCapabilities,
  loadCapabilities,
  saveCapabilities,
  connectNumberToWalkieTalkie,
};
