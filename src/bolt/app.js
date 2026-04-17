const { App, ExpressReceiver } = require('@slack/bolt');
const { setSetting, getSetting } = require('../services/settings');
const { setNumber, removeNumber, loadConfig, replaceAllNumbers } = require('../services/numbers');
const { syncAllCapabilities, connectNumberToWalkieTalkie } = require('../services/capabilities');
const {
  buildAppHomeView,
  buildCredentialsModal,
  buildDefaultChannelModal,
  buildNumberModal,
  buildCsvUploadModal,
  buildConfirmRemoveModal,
  buildLogsModal,
  buildExternalRoutingModal,
} = require('./views');
const { loadLogs } = require('../services/logger');

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

const boltApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function publishAppHome(client, userId) {
  try {
    await client.views.publish({
      user_id: userId,
      view: buildAppHomeView(),
    });
  } catch (err) {
    console.error('[bolt] Failed to publish App Home:', err.message);
  }
}

/** Post an ephemeral confirmation message to the user in the default channel. */
async function notify(client, userId, text) {
  const channel = getSetting('slack.defaultChannel');
  if (!channel) return;
  try {
    await client.chat.postEphemeral({ channel, user: userId, text });
  } catch {
    // Best-effort; don't let notification failure break the flow
  }
}

const E164_RE = /^\+[1-9]\d{7,14}$/;

/**
 * Normalizes a phone number string to E.164 format.
 * Strips spaces, dashes, dots, parentheses, then prepends + if missing.
 *
 * Examples:
 *   "+52 999 489 0783"  → "+529994890783"
 *   "+52-999-489-0783"  → "+529994890783"
 *   "52 999 489 0783"   → "+529994890783"
 *   "(1) 800.555.1234"  → "+18005551234"
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizePhone(raw) {
  if (!raw) return '';
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : `+${digits}`;
}

/**
 * Parse a CSV string (with header row) into an array of row objects.
 * Handles quoted fields.
 */
function parseCSVString(csvText) {
  const lines = csvText.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());

  return lines.slice(1).map((line) => {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') { inQuotes = !inQuotes; }
      else if (char === ',' && !inQuotes) { values.push(current.trim()); current = ''; }
      else { current += char; }
    }
    values.push(current.trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i] || '']));
  }).filter((r) => r.phone_number);
}

// ─── App Home ─────────────────────────────────────────────────────────────────

boltApp.event('app_home_opened', async ({ event, client }) => {
  await publishAppHome(client, event.user);
});

// ─── Block Actions ────────────────────────────────────────────────────────────

boltApp.action('action_edit_credentials', async ({ ack, client, body }) => {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildCredentialsModal() });
  } catch (err) {
    console.error('[bolt] Failed to open credentials modal:', err.message);
  }
});

boltApp.action('action_edit_default_channel', async ({ ack, client, body }) => {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildDefaultChannelModal() });
  } catch (err) {
    console.error('[bolt] Failed to open default channel modal:', err.message);
  }
});

boltApp.action('action_sync_twilio', async ({ ack, client, body }) => {
  await ack();
  syncAllCapabilities()
    .then(() => publishAppHome(client, body.user.id))
    .catch((err) => console.error('[bolt] Sync failed:', err.message));
  await publishAppHome(client, body.user.id);
});

boltApp.action('action_add_number', async ({ ack, client, body }) => {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildNumberModal() });
  } catch (err) {
    console.error('[bolt] Failed to open add number modal:', err.message);
  }
});

boltApp.action('action_add_number', async ({ ack, client, body }) => {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildNumberModal() });
  } catch (err) {
    console.error('[bolt] Failed to open add number modal:', err.message);
  }
});

boltApp.action('action_upload_csv', async ({ ack, client, body }) => {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildCsvUploadModal() });
  } catch (err) {
    console.error('[bolt] Failed to open CSV upload modal:', err.message);
  }
});

// No-op ack for the download button (it's a URL link — Slack still sends an action)
boltApp.action('action_download_csv', async ({ ack }) => { await ack(); });

boltApp.action('action_view_logs', async ({ ack, client, body }) => {
  await ack();
  try {
    const logs = loadLogs();
    await client.views.open({ trigger_id: body.trigger_id, view: buildLogsModal(logs) });
  } catch (err) {
    console.error('[bolt] Failed to open logs modal:', err.message);
  }
});

const EXTERNAL_ROUTING_PROVIDERS = new Set(['vapi', 'talkyto', 'pipecat']);

// Overflow menu for edit/remove on each number row
boltApp.action(/^action_number_menu__/, async ({ ack, client, body, action }) => {
  await ack();
  const selected = action.selected_option.value;
  const [op, phone] = selected.split(/__(.+)/);

  try {
    const { numbers } = loadConfig();
    const entry = numbers[phone] || null;
    const name = entry ? (typeof entry === 'string' ? entry : (entry.name || '')) : '';
    const routing = (entry && typeof entry === 'object' && entry.routing) || 'walkietalkie';
    const isExternal = EXTERNAL_ROUTING_PROVIDERS.has(routing.toLowerCase());

    if (op === 'connect') {
      try {
        const caps = await connectNumberToWalkieTalkie(phone);
        const connected = [caps.sms ? 'SMS' : null, caps.voice ? 'Voice' : null].filter(Boolean).join(' + ');
        await notify(client, body.user.id, `✓ *${name || phone}* conectado a WalkieTalkie — ${connected} activo`);
      } catch (err) {
        console.error(`[bolt] Failed to connect ${phone}:`, err.message);
        await notify(client, body.user.id, `❌ No se pudo conectar *${name || phone}*: ${err.message}`);
      }
    } else if (op === 'edit' && isExternal) {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildExternalRoutingModal(phone, name, routing),
      });
    } else if (op === 'remove') {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildConfirmRemoveModal(phone, name),
      });
    } else if (op === 'edit') {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildNumberModal(phone, entry),
      });
    }
  } catch (err) {
    console.error('[bolt] Failed to open number menu modal:', err.message);
  }
});

// ─── Modal Submissions ────────────────────────────────────────────────────────

boltApp.view('modal_credentials', async ({ ack, view, client, body }) => {
  await ack();
  const values = view.state.values;
  const accountSid = values.block_account_sid.input_account_sid.value?.trim();
  const authToken = values.block_auth_token.input_auth_token.value?.trim();

  if (accountSid) setSetting('twilio.accountSid', accountSid);
  if (authToken) setSetting('twilio.authToken', authToken);

  await publishAppHome(client, body.user.id);
  await notify(client, body.user.id, '✓ Twilio credentials updated.');
});

boltApp.view('modal_default_channel', async ({ ack, view, client, body }) => {
  await ack();
  const channel = view.state.values.block_default_channel.input_default_channel.selected_channel;
  if (channel) setSetting('slack.defaultChannel', channel);
  await publishAppHome(client, body.user.id);
  await notify(client, body.user.id, '✓ Default channel updated.');
});

boltApp.view('modal_number', async ({ ack, view, client, body }) => {
  const values = view.state.values;
  const phone = values.block_phone.input_phone.value?.trim() || '';
  const name = values.block_name.input_name.value?.trim() || '';
  const channel = values.block_channel.input_channel?.selected_channel || '';

  // E.164 validation
  if (!E164_RE.test(phone)) {
    await ack({
      response_action: 'errors',
      errors: {
        block_phone: 'Enter a valid E.164 phone number starting with + and country code (e.g. +15103137237).',
      },
    });
    return;
  }

  await ack();
  setNumber(phone, { name, channel });
  await publishAppHome(client, body.user.id);
  await notify(client, body.user.id, `✓ Number ${phone}${name ? ` (${name})` : ''} saved.`);
});

boltApp.view('modal_confirm_remove', async ({ ack, view, client, body }) => {
  await ack();
  const phone = view.private_metadata;
  if (phone) removeNumber(phone);
  await publishAppHome(client, body.user.id);
  await notify(client, body.user.id, `✓ ${phone} removed from the directory.`);
});

boltApp.view('modal_csv_upload', async ({ ack, view, client, body }) => {
  const csvText = view.state.values.block_csv.input_csv.value || '';
  const rows = parseCSVString(csvText);

  if (rows.length === 0) {
    await ack({
      response_action: 'errors',
      errors: { block_csv: 'No valid rows found. Make sure you included the header row and at least one data row.' },
    });
    return;
  }

  // Validate all phone numbers before applying
  const badRows = rows.filter((r) => !E164_RE.test(r.phone_number));
  if (badRows.length > 0) {
    await ack({
      response_action: 'errors',
      errors: {
        block_csv: `Invalid phone numbers: ${badRows.map((r) => r.phone_number).join(', ')}. All numbers must be in E.164 format (e.g. +15103137237).`,
      },
    });
    return;
  }

  await ack();

  // Build the numbers map from CSV rows
  const numbersMap = {};
  for (const row of rows) {
    const phone = row.phone_number;
    const name = row.friendly_name || '';
    const channel = row.channel_id || '';
    const routing = (row.routing || '').toLowerCase().trim();
    const isVapi = routing === 'vapi' || routing === 'talkyto';

    const entry = {};
    if (name) entry.name = name;
    if (channel) entry.channel = channel;
    if (isVapi) entry.routing = 'vapi';

    if (Object.keys(entry).length === 0) numbersMap[phone] = '';
    else if (Object.keys(entry).length === 1 && entry.name) numbersMap[phone] = name;
    else numbersMap[phone] = entry;
  }

  replaceAllNumbers(numbersMap);
  await publishAppHome(client, body.user.id);
  await notify(client, body.user.id, `✓ Number directory updated — ${rows.length} line${rows.length !== 1 ? 's' : ''} loaded from CSV.`);
});

module.exports = { boltApp, receiver };
