/**
 * Bulk-configure Twilio numbers from a CSV file.
 *
 * Usage:
 *   node scripts/configure-from-csv.js path/to/numbers.csv
 *
 * CSV format (header row required):
 *   phone_number,friendly_name,channel_id,routing,sms,voice
 *
 *   phone_number  — E.164 format, required
 *   friendly_name — label shown in Slack threads (optional)
 *   channel_id    — Slack channel ID override (optional)
 *   routing       — "walkietalkie" (default) or "vapi"/"talkyto" — controls whether
 *                   Twilio webhook URLs are configured for this number.
 *                   Numbers with routing=vapi/talkyto are saved to numbers.json but
 *                   their Twilio webhooks are left untouched.
 *   sms, voice    — informational only (yes/no), not used by this script
 *
 * Download the current directory as a starting point:
 *   curl http://localhost:3000/numbers.csv -o numbers.csv
 *
 * What this script does per row:
 *   1. Updates config/numbers.json with name + channel + routing (if provided)
 *   2. Fetches the number's SID from Twilio (skipped for vapi/talkyto rows)
 *   3. Sets smsUrl and/or voiceUrl based on capabilities (skipped for vapi/talkyto rows)
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/configure-from-csv.js path/to/numbers.csv');
  process.exit(1);
}

if (!fs.existsSync(csvPath)) {
  console.error(`File not found: ${csvPath}`);
  process.exit(1);
}

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WEBHOOK_BASE_URL } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !WEBHOOK_BASE_URL) {
  console.error('Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or WEBHOOK_BASE_URL in .env');
  process.exit(1);
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const smsWebhookUrl = `${WEBHOOK_BASE_URL}/twilio-webhook`;
const voiceWebhookUrl = `${WEBHOOK_BASE_URL}/twilio-voice`;
const NUMBERS_CONFIG_PATH = path.join(__dirname, '../config/numbers.json');

function loadNumbersConfig() {
  try {
    return JSON.parse(fs.readFileSync(NUMBERS_CONFIG_PATH, 'utf8'));
  } catch {
    return { numbers: {} };
  }
}

function saveNumbersConfig(config) {
  fs.writeFileSync(NUMBERS_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function parseCSV(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const [header, ...rows] = lines;
  const headers = header.split(',').map((h) => h.trim().toLowerCase());

  return rows.map((row) => {
    // Handle quoted fields (e.g. "Name, With Comma")
    const values = [];
    let current = '';
    let inQuotes = false;
    for (const char of row) {
      if (char === '"') { inQuotes = !inQuotes; }
      else if (char === ',' && !inQuotes) { values.push(current.trim()); current = ''; }
      else { current += char; }
    }
    values.push(current.trim());

    return Object.fromEntries(headers.map((h, i) => [h, values[i] || '']));
  }).filter((r) => r.phone_number);
}

function isVapi(routing) {
  return routing && ['vapi', 'talkyto'].includes(routing.toLowerCase().trim());
}

async function run() {
  const rows = parseCSV(csvPath);
  console.log(`\nProcessing ${rows.length} numbers from ${csvPath}\n`);

  const config = loadNumbersConfig();

  for (const row of rows) {
    const phone = row.phone_number;
    const name = row.friendly_name || '';
    const channel = row.channel_id || '';
    const routing = row.routing || 'walkietalkie';
    const vapiLine = isVapi(routing);

    process.stdout.write(`  ${phone}`);

    // 1. Update numbers.json
    const entry = {};
    if (name) entry.name = name;
    if (channel) entry.channel = channel;
    if (vapiLine) entry.routing = 'vapi';

    if (Object.keys(entry).length === 1 && entry.name) {
      config.numbers[phone] = name; // simple string form
    } else if (Object.keys(entry).length > 0) {
      config.numbers[phone] = entry;
    }
    // If all blank, still register the number with empty entry
    if (!config.numbers[phone]) config.numbers[phone] = '';

    // 2. Skip Twilio webhook config for VAPI/Talkyto lines
    if (vapiLine) {
      console.log(`  ⊘  ${phone}${name ? `  "${name}"` : ''}  [VAPI/Talkyto — skipped]`);
      continue;
    }

    // 3. Fetch from Twilio and set webhooks
    try {
      const results = await client.incomingPhoneNumbers.list({ phoneNumber: phone });

      if (!results.length) {
        console.log(`  ⚠️  Not found in Twilio account — skipped`);
        continue;
      }

      const num = results[0];
      const hasSms = !!(num.capabilities && num.capabilities.sms);
      const hasVoice = !!(num.capabilities && num.capabilities.voice);
      const isVapiVoice = (num.voiceUrl || '').toLowerCase().includes('vapi');
      const isVapiSms = (num.smsUrl || '').toLowerCase().includes('vapi');

      if (isVapiVoice || isVapiSms) {
        console.log(`  ⊘  ${phone}  [VAPI detected in Twilio config — skipped]`);
        continue;
      }

      const update = {};
      if (hasSms) { update.smsUrl = smsWebhookUrl; update.smsMethod = 'POST'; }
      if (hasVoice) { update.voiceUrl = voiceWebhookUrl; update.voiceMethod = 'POST'; }

      if (Object.keys(update).length > 0) {
        await client.incomingPhoneNumbers(num.sid).update(update);
      }

      const caps = [
        hasSms ? 'SMS' : null,
        hasVoice ? 'VOICE' : null,
      ].filter(Boolean).join('+') || 'NONE';

      const label = name ? `  "${name}"` : '';
      console.log(`  ✓  ${phone}${label}  [${caps}]`);
    } catch (err) {
      console.log(`  ✗  ${phone}  Error: ${err.message}`);
    }
  }

  saveNumbersConfig(config);
  console.log(`\nDone. config/numbers.json updated.\n`);
}

run().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
