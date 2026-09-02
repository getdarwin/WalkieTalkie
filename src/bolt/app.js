const { App, ExpressReceiver } = require('@slack/bolt');
const store = require('../services/store');
const { backgroundTask } = require('../services/background');
const { setSetting, getSetting } = require('../services/settings');
const { setNumber, removeNumber, loadConfig, replaceAllNumbers, getGlobalKeypressMode } = require('../services/numbers');
const { isKeypressMode, sanitizeDtmf } = require('../services/ivrKeypress');
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
  buildCsvConfirmModal,
  buildConnectModal,
  buildFindLineModal,
  buildKeypressModeModal,
} = require('./views');
const { loadLogs } = require('../services/logger');

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
  // Serverless (Vercel): run listeners before sending the HTTP response,
  // otherwise the function freezes as soon as ack() responds.
  processBeforeResponse: true,
});

const boltApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function publishAppHome(client, userId, options = {}) {
  try {
    await client.views.publish({
      user_id: userId,
      view: await buildAppHomeView(options),
    });
  } catch (err) {
    console.error('[bolt] Failed to publish App Home:', err.message);
  }
}

// ─── Admin allowlist ──────────────────────────────────────────────────────────
// SLACK_ADMIN_USER_IDS: comma-separated Slack user IDs allowed to make changes
// (credentials, default channel, numbers, CSV upload, sync). If unset, every
// workspace member can make changes (previous behavior).
const ADMIN_USER_IDS = (process.env.SLACK_ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAdminUser(userId) {
  return ADMIN_USER_IDS.length === 0 || ADMIN_USER_IDS.includes(userId);
}

/**
 * Guard for mutating handlers. When the user is not an allowed admin, refreshes
 * their App Home with a notice and returns true (caller should return early).
 */
async function denyIfNotAdmin(client, body) {
  const userId = body?.user?.id;
  if (isAdminUser(userId)) return false;
  await publishAppHome(client, userId, {
    statusText: ':lock: Solo los administradores configurados pueden hacer cambios. Pide acceso al equipo de Ops.',
  });
  return true;
}

// Parsed CSV data between the upload modal and the confirm modal.
// Stored externally (Redis) because serverless instances share no memory.
const CSV_PENDING_TTL_SECONDS = 15 * 60;
function csvPendingKey(userId) {
  return `csvpending:${userId}`;
}

/** Post an ephemeral confirmation message to the user in the default channel. */
async function notify(client, userId, text) {
  const channel = await getSetting('slack.defaultChannel');
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
  const digits = trimmed.replace(/\D/g, '');
  return `+${digits}`;
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
  if (await denyIfNotAdmin(client, body)) return;
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: await buildCredentialsModal() });
  } catch (err) {
    console.error('[bolt] Failed to open credentials modal:', err.message);
  }
});

boltApp.action('action_edit_default_channel', async ({ ack, client, body }) => {
  await ack();
  if (await denyIfNotAdmin(client, body)) return;
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: await buildDefaultChannelModal() });
  } catch (err) {
    console.error('[bolt] Failed to open default channel modal:', err.message);
  }
});

boltApp.action('action_edit_keypress_mode', async ({ ack, client, body }) => {
  await ack();
  if (await denyIfNotAdmin(client, body)) return;
  try {
    const current = await getGlobalKeypressMode();
    await client.views.open({ trigger_id: body.trigger_id, view: buildKeypressModeModal(current) });
  } catch (err) {
    console.error('[bolt] Failed to open keypress mode modal:', err.message);
  }
});

boltApp.view('modal_keypress_mode', async ({ ack, view, client, body }) => {
  await ack();
  if (await denyIfNotAdmin(client, body)) return;
  const mode = view.state.values.block_keypress_mode?.input_keypress_mode?.selected_option?.value;
  if (isKeypressMode(mode)) await setSetting('ivr.keypressMode', mode);
  await publishAppHome(client, body.user.id, {
    statusText: `:white_check_mark: Tecla del IVR por default: *${mode === 'auto' ? 'Automático' : 'Ninguno'}*.`,
  });
});

boltApp.action('action_sync_twilio', async ({ ack, client, body }) => {
  await ack();
  if (await denyIfNotAdmin(client, body)) return;
  await publishAppHome(client, body.user.id, {
    statusText: ':arrows_counterclockwise: Sincronizando números de Twilio...',
  });
  // Long-running: continue after the response (kept alive via waitUntil on Vercel)
  backgroundTask(
    syncAllCapabilities()
      .then(() => publishAppHome(client, body.user.id, { statusText: ':white_check_mark: Sync completo.' }))
      .catch((err) => {
        console.error('[bolt] Sync failed:', err.message);
        return publishAppHome(client, body.user.id, { statusText: `:x: Sync falló: ${err.message}` });
      })
  );
});

boltApp.action('action_add_number', async ({ ack, client, body }) => {
  await ack();
  if (await denyIfNotAdmin(client, body)) return;
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildNumberModal('', null, await getGlobalKeypressMode()) });
  } catch (err) {
    console.error('[bolt] Failed to open add number modal:', err.message);
  }
});

boltApp.action('action_upload_csv', async ({ ack, client, body }) => {
  await ack();
  if (await denyIfNotAdmin(client, body)) return;
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildCsvUploadModal() });
  } catch (err) {
    console.error('[bolt] Failed to open CSV upload modal:', err.message);
  }
});

// No-op ack for the download button (it's a URL link — Slack still sends an action)
boltApp.action('action_download_csv', async ({ ack }) => { await ack(); });

boltApp.action('action_connect_line', async ({ ack, client, body }) => {
  await ack();
  if (await denyIfNotAdmin(client, body)) return;
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildConnectModal() });
  } catch (err) {
    console.error('[bolt] Failed to open connect modal:', err.message);
  }
});

boltApp.action('action_find_edit_line', async ({ ack, client, body }) => {
  await ack();
  if (await denyIfNotAdmin(client, body)) return;
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildFindLineModal() });
  } catch (err) {
    console.error('[bolt] Failed to open find-edit modal:', err.message);
  }
});

boltApp.action('action_view_logs', async ({ ack, client, body }) => {
  await ack();
  try {
    const logs = await loadLogs();
    await client.views.open({ trigger_id: body.trigger_id, view: buildLogsModal(logs) });
  } catch (err) {
    console.error('[bolt] Failed to open logs modal:', err.message);
  }
});

const EXTERNAL_ROUTING_PROVIDERS = new Set(['vapi', 'talkyto', 'pipecat']);

// Overflow menu for edit/remove on each number row
boltApp.action(/^action_number_menu__/, async ({ ack, client, body, action }) => {
  await ack();
  if (await denyIfNotAdmin(client, body)) return;
  const selected = action.selected_option.value;
  const [op, phone] = selected.split(/__(.+)/);

  try {
    const { numbers } = await loadConfig();
    const entry = numbers[phone] || null;
    const name = entry ? (typeof entry === 'string' ? entry : (entry.name || '')) : '';
    const routing = (entry && typeof entry === 'object' && entry.routing) || 'walkietalkie';
    const isExternal = EXTERNAL_ROUTING_PROVIDERS.has(routing.toLowerCase());

    if (op === 'connect') {
      try {
        const caps = await connectNumberToWalkieTalkie(phone);
        const connected = [caps.sms ? 'SMS' : null, caps.voice ? 'Voice' : null].filter(Boolean).join(' + ');
        await publishAppHome(client, body.user.id, {
          statusText: `:white_check_mark: *${name || phone}* conectado a WalkieTalkie — ${connected} activo`,
        });
      } catch (err) {
        console.error(`[bolt] Failed to connect ${phone}:`, err.message);
        await publishAppHome(client, body.user.id, {
          statusText: `:x: No se pudo conectar *${name || phone}*: ${err.message}`,
        });
        // Post a rich ephemeral with a re-sync button so the user can recover
        const channel = await getSetting('slack.defaultChannel');
        if (channel) {
          try {
            await client.chat.postEphemeral({
              channel,
              user: body.user.id,
              text: `❌ No se pudo conectar ${name || phone}: ${err.message}`,
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `❌ *${name || phone}* (\`${phone}\`) no se encontró en la cuenta de Twilio.\n\nSincroniza primero para refrescar la lista de números y luego vuelve a intentarlo.`,
                  },
                },
                {
                  type: 'actions',
                  elements: [
                    {
                      type: 'button',
                      text: { type: 'plain_text', text: '🔄 Sync Twilio Numbers', emoji: true },
                      action_id: 'action_sync_twilio',
                      style: 'primary',
                    },
                  ],
                },
              ],
            });
          } catch {
            // Best-effort
          }
        }
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
        view: buildNumberModal(phone, entry, await getGlobalKeypressMode()),
      });
    }
  } catch (err) {
    console.error('[bolt] Failed to open number menu modal:', err.message);
  }
});

// ─── Modal Submissions ────────────────────────────────────────────────────────

boltApp.view('modal_credentials', async ({ ack, view, client, body }) => {
  await ack();
  if (await denyIfNotAdmin(client, body)) return;
  const values = view.state.values;
  const accountSid = values.block_account_sid.input_account_sid.value?.trim();
  const authToken = values.block_auth_token.input_auth_token.value?.trim();

  if (accountSid) await setSetting('twilio.accountSid', accountSid);
  if (authToken) await setSetting('twilio.authToken', authToken);

  await publishAppHome(client, body.user.id, { statusText: ':white_check_mark: Credenciales de Twilio actualizadas.' });
});

boltApp.view('modal_default_channel', async ({ ack, view, client, body }) => {
  await ack();
  if (await denyIfNotAdmin(client, body)) return;
  const channel = view.state.values.block_default_channel.input_default_channel.selected_channel;
  if (channel) await setSetting('slack.defaultChannel', channel);
  await publishAppHome(client, body.user.id, { statusText: ':white_check_mark: Canal default actualizado.' });
});

boltApp.view('modal_number', async ({ ack, view, client, body }) => {
  const values = view.state.values;
  const phone = normalizePhone(values.block_phone.input_phone.value || '');
  const name = values.block_name.input_name.value?.trim() || '';
  const channel = values.block_channel.input_channel?.selected_channel || '';
  const dtmf = values.block_dtmf?.input_dtmf?.value?.trim() || '';
  const language = values.block_language?.input_language?.selected_option?.value || '';
  const selectedMode = values.block_keypress_mode?.input_keypress_mode?.selected_option?.value || 'inherit';
  const keypressMode = isKeypressMode(selectedMode) ? selectedMode : '';

  const errors = {};
  if (!E164_RE.test(phone)) {
    errors.block_phone = 'Could not parse this as a valid phone number. Include the country code, e.g. +52 999 489 0783 or 52 999 489 0783.';
  }
  if (dtmf && !sanitizeDtmf(dtmf)) {
    errors.block_dtmf = 'Solo dígitos 0-9, "w", "#" y "*" — p. ej. "ww1".';
  }
  if (keypressMode === 'fixed' && !sanitizeDtmf(dtmf)) {
    errors.block_dtmf = 'El modo Fijo necesita los dígitos a pulsar — p. ej. "ww1".';
  }
  if (Object.keys(errors).length > 0) {
    await ack({ response_action: 'errors', errors });
    return;
  }

  await ack();

  // External-routing lines (VAPI/Talkyto/Pipecat) keep their webhooks untouched
  const { numbers: existingNumbers } = await loadConfig();
  const existingEntry = existingNumbers[phone];
  const existingRouting = (existingEntry && typeof existingEntry === 'object' && existingEntry.routing) || '';
  const isExternal = EXTERNAL_ROUTING_PROVIDERS.has(existingRouting.toLowerCase());

  await setNumber(phone, { name, channel, dtmf, language, keypressMode });

  let notifText = `✓ ${phone}${name ? ` (${name})` : ''} guardado.`;

  // Auto-connect on every save so no line is ever left pointing at a dead webhook
  if (!isExternal) {
    try {
      const caps = await connectNumberToWalkieTalkie(phone);
      const connected = [caps.sms ? 'SMS' : null, caps.voice ? 'Voice' : null].filter(Boolean).join(' + ');
      notifText += ` Conectado a WalkieTalkie — ${connected} activo.`;
    } catch (err) {
      console.error(`[bolt] Failed to connect ${phone} after save:`, err.message);
      notifText += ` ⚠️ No se pudo conectar a WalkieTalkie: ${err.message}`;
    }
  } else {
    notifText += ` Routing externo (${existingRouting}) — webhooks no modificados.`;
  }

  await publishAppHome(client, body.user.id, { statusText: `:white_check_mark: ${notifText}` });
});

boltApp.view('modal_confirm_remove', async ({ ack, view, client, body }) => {
  await ack();
  const phone = view.private_metadata;
  if (phone) await removeNumber(phone);
  await publishAppHome(client, body.user.id, { statusText: `:white_check_mark: ${phone} eliminado del directorio.` });
});

boltApp.view('modal_connect_line', async ({ ack, view, client, body }) => {
  const raw = view.state.values.block_phone.input_phone.value || '';
  const phone = normalizePhone(raw);

  if (!E164_RE.test(phone)) {
    await ack({
      response_action: 'errors',
      errors: { block_phone: 'No se pudo parsear como número válido. Incluye el código de país, e.g. +52 999 489 0783.' },
    });
    return;
  }

  await ack();

  try {
    const caps = await connectNumberToWalkieTalkie(phone);
    const connected = [caps.sms ? 'SMS' : null, caps.voice ? 'Voice' : null].filter(Boolean).join(' + ');
    // Ensure number exists in directory so DTMF, name, and channel can be configured
    const { numbers } = await loadConfig();
    if (!(phone in numbers)) {
      await setNumber(phone, {});
    }
    await publishAppHome(client, body.user.id, {
      statusText: `:white_check_mark: *${phone}* conectado a WalkieTalkie — ${connected} activo. Usa ✏️ Edit para agregar nombre, canal o DTMF.`,
    });
  } catch (err) {
    console.error(`[bolt] Failed to connect ${phone} via connect modal:`, err.message);
    await publishAppHome(client, body.user.id, {
      statusText: `:x: No se pudo conectar *${phone}*: ${err.message}`,
    });
  }
});

boltApp.view('modal_find_line', async ({ ack, view }) => {
  const raw = view.state.values.block_phone.input_phone.value || '';
  const phone = normalizePhone(raw);

  if (!E164_RE.test(phone)) {
    await ack({
      response_action: 'errors',
      errors: { block_phone: 'Formato de número inválido. Incluye el código de país, e.g. +52 999 489 0783.' },
    });
    return;
  }

  const { numbers } = await loadConfig();
  const entry = numbers[phone] ?? null;

  await ack({
    response_action: 'push',
    view: buildNumberModal(phone, entry, await getGlobalKeypressMode()),
  });
});

/** Converts a validated array of CSV row objects into the numbers.json map format. */
function buildNumbersMapFromRows(rows) {
  const numbersMap = {};
  for (const row of rows) {
    const phone = row.phone_number;
    const name = row.friendly_name || '';
    const channel = row.channel_id || '';
    const routing = (row.routing || '').toLowerCase().trim();
    const isVapi = routing === 'vapi' || routing === 'talkyto';

    const keypressMode = (row.keypress_mode || '').toLowerCase().trim();
    const dtmf = sanitizeDtmf(row.dtmf) || '';
    const language = (row.language || '').toLowerCase().trim();

    const entry = {};
    if (name) entry.name = name;
    if (channel) entry.channel = channel;
    if (isVapi) entry.routing = 'vapi';
    if (isKeypressMode(keypressMode)) entry.keypressMode = keypressMode;
    if (dtmf) entry.dtmf = dtmf;
    if (/^[a-z]{2}$/.test(language)) entry.language = language;

    if (Object.keys(entry).length === 0) numbersMap[phone] = '';
    else if (Object.keys(entry).length === 1 && entry.name) numbersMap[phone] = name;
    else numbersMap[phone] = entry;
  }
  return numbersMap;
}

boltApp.view('modal_csv_upload', async ({ ack, view, body }) => {
  const csvText = view.state.values.block_csv.input_csv.value || '';
  const rows = parseCSVString(csvText);

  if (rows.length === 0) {
    await ack({
      response_action: 'errors',
      errors: { block_csv: 'No valid rows found. Make sure you included the header row and at least one data row.' },
    });
    return;
  }

  // Normalize phone numbers before validating
  for (const row of rows) {
    row.phone_number = normalizePhone(row.phone_number);
  }

  // Validate all phone numbers before applying
  const badRows = rows.filter((r) => !E164_RE.test(r.phone_number));
  if (badRows.length > 0) {
    await ack({
      response_action: 'errors',
      errors: {
        block_csv: `Could not parse these phone numbers: ${badRows.map((r) => r.phone_number).join(', ')}. Make sure each number includes a country code.`,
      },
    });
    return;
  }

  // Store parsed data and push a confirmation modal — don't apply yet
  const numbersMap = buildNumbersMapFromRows(rows);
  await store.setJSON(
    csvPendingKey(body.user.id),
    { numbersMap, rowCount: rows.length, rows },
    CSV_PENDING_TTL_SECONDS
  );

  await ack({
    response_action: 'push',
    view: buildCsvConfirmModal(rows.length, rows),
  });
});

boltApp.view('modal_csv_confirm', async ({ ack, client, body }) => {
  await ack();
  const pending = await store.getJSON(csvPendingKey(body.user.id));
  if (!pending) {
    await publishAppHome(client, body.user.id, {
      statusText: ':warning: Sesión de carga expiró — intenta de nuevo.',
    });
    return;
  }
  await store.del(csvPendingKey(body.user.id));
  await replaceAllNumbers(pending.numbersMap);
  await publishAppHome(client, body.user.id, {
    statusText: `:white_check_mark: Directorio actualizado — ${pending.rowCount} línea${pending.rowCount !== 1 ? 's' : ''} cargadas.`,
  });
});

module.exports = { boltApp, receiver };
