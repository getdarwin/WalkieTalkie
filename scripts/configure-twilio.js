/**
 * Setup script to:
 *  1. Point all Twilio numbers at the SMS webhook (voice-capable numbers also get voiceUrl)
 *  2. Seed data/capabilities.json with each number's actual capabilities from Twilio
 *
 * Usage:
 *   node scripts/configure-twilio.js
 *
 * Reads TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and WEBHOOK_BASE_URL from .env
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WEBHOOK_BASE_URL } = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !WEBHOOK_BASE_URL) {
  console.error('Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or WEBHOOK_BASE_URL in .env');
  process.exit(1);
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const smsWebhookUrl = `${WEBHOOK_BASE_URL}/twilio-webhook`;
const voiceWebhookUrl = `${WEBHOOK_BASE_URL}/twilio-voice`;
const CAPABILITIES_PATH = path.join(__dirname, '../data/capabilities.json');

async function run() {
  const numbers = await client.incomingPhoneNumbers.list();
  console.log(`Found ${numbers.length} numbers.\n`);

  const capabilityStore = { lastSyncedAt: new Date().toISOString(), numbers: {} };

  for (const num of numbers) {
    const hasSms = !!(num.capabilities && num.capabilities.sms);
    const hasVoice = !!(num.capabilities && num.capabilities.voice);

    const isVapiVoice = (num.voiceUrl || '').toLowerCase().includes('vapi');
    const isVapiSms = (num.smsUrl || '').toLowerCase().includes('vapi');

    const update = {};
    if (hasSms && !isVapiSms) {
      update.smsUrl = smsWebhookUrl;
      update.smsMethod = 'POST';
    }
    if (hasVoice && !isVapiVoice) {
      update.voiceUrl = voiceWebhookUrl;
      update.voiceMethod = 'POST';
    }

    if (Object.keys(update).length > 0) {
      await client.incomingPhoneNumbers(num.sid).update(update);
    }

    const tags = [
      hasSms ? (isVapiSms ? 'SMS(vapi-skip)' : 'SMS') : null,
      hasVoice ? (isVapiVoice ? 'VOICE(vapi-skip)' : 'VOICE') : null,
    ].filter(Boolean).join('+') || 'NONE';
    console.log(`✓  ${num.phoneNumber}  (${num.friendlyName})  [${tags}]`);

    // Build capabilities record for this number
    capabilityStore.numbers[num.phoneNumber] = {
      sid: num.sid,
      friendlyName: num.friendlyName,
      phoneNumber: num.phoneNumber,
      capabilities: {
        sms: hasSms,
        voice: hasVoice,
        mms: !!(num.capabilities && num.capabilities.mms),
        fax: !!(num.capabilities && num.capabilities.fax),
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  // Seed data/capabilities.json
  const dir = path.dirname(CAPABILITIES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CAPABILITIES_PATH, JSON.stringify(capabilityStore, null, 2));

  const smsCount = Object.values(capabilityStore.numbers).filter((n) => n.capabilities.sms).length;
  const voiceCount = Object.values(capabilityStore.numbers).filter((n) => n.capabilities.voice).length;

  console.log(`\nAll numbers updated.`);
  console.log(`  SMS-capable:   ${smsCount}`);
  console.log(`  Voice-capable: ${voiceCount}`);
  console.log(`  Capabilities saved to data/capabilities.json`);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
