const { getSetting } = require('../services/settings');
const { loadConfig } = require('../services/numbers');
const { getCapabilities } = require('../services/capabilities');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(isoString) {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

/**
 * Builds the full App Home Block Kit view.
 * Called on every home_opened event and after any config change.
 */
function buildAppHomeView({ statusText = null } = {}) {
  const accountSid = getSetting('twilio.accountSid') || '';
  const authToken = getSetting('twilio.authToken') || '';
  const defaultChannel = getSetting('slack.defaultChannel') || '';
  const { numbers } = loadConfig();
  const caps = getCapabilities();
  const numberCount = Object.keys(numbers).length;

  const maskedToken = authToken ? '••••••••' + authToken.slice(-4) : '(not set)';
  const maskedSid = accountSid ? accountSid.slice(0, 8) + '••••••••' : '(not set)';

  const lastSynced = caps.lastSyncedAt
    ? `Last synced: ${new Date(caps.lastSyncedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'Never synced — click to scan your lines';

  const baseUrl = process.env.WEBHOOK_BASE_URL || '';
  const isConfigured = !!accountSid && !!authToken && !!defaultChannel;

  const blocks = [
    // ─── Header ───────────────────────────────────────────────────────────────
    {
      type: 'header',
      text: { type: 'plain_text', text: '📱 WalkieTalkie', emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'SMS & voice relay for your Twilio lines' }],
    },
    { type: 'divider' },

    // ─── Status banner (transient — only shown after actions) ─────────────────
    ...(statusText ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: statusText }] }] : []),

    // ─── Getting Started (hidden once credentials + channel are configured) ───
    ...(!isConfigured ? [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*📖  Getting Started*\n1. Set your Twilio credentials (Account SID + Auth Token)\n2. Set the default Slack channel for unmapped numbers\n3. Click *Sync Twilio Numbers* to scan your lines\n4. Download the number directory CSV, fill in friendly names + channels, and upload it back\n5. Text or call any configured number — messages appear in Slack\n\n💡  SMS messages are grouped by phone number per day. Voice calls post a recording and transcript to the same thread. Numbers with VAPI/Talkyto configured are skipped automatically.',
        },
      },
      { type: 'divider' },
    ] : []),

    // ─── Twilio Credentials ───────────────────────────────────────────────────
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Twilio Credentials*\nAccount SID: \`${maskedSid}\`\nAuth Token: \`${maskedToken}\``,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '✏️ Edit', emoji: true },
        action_id: 'action_edit_credentials',
      },
    },
    { type: 'divider' },

    // ─── Default Channel ──────────────────────────────────────────────────────
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Default Channel*\n${defaultChannel ? `<#${defaultChannel}>` : '_(not set)_'}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '✏️ Edit', emoji: true },
        action_id: 'action_edit_default_channel',
      },
    },
    { type: 'divider' },

    // ─── Sync + Logs Buttons ──────────────────────────────────────────────────
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔄 Sync Twilio Numbers', emoji: true },
          action_id: 'action_sync_twilio',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📋 Activity Log', emoji: true },
          action_id: 'action_view_logs',
        },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: lastSynced }],
    },
    { type: 'divider' },

    // ─── Number Directory ─────────────────────────────────────────────────────
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Number Directory* — ${numberCount} line${numberCount !== 1 ? 's' : ''} configured`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Download the CSV, edit names and channels in any spreadsheet app, then paste the contents back using *Upload CSV*.\n\nCSV columns: \`phone_number\`, \`friendly_name\`, \`channel_id\`, \`routing\` (\`walkietalkie\` or \`vapi\`), \`sms\`, \`voice\``,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '➕ Add Line', emoji: true },
          action_id: 'action_add_number',
          style: 'primary',
        },
        ...(baseUrl ? [{
          type: 'button',
          text: { type: 'plain_text', text: '⬇️ Download CSV', emoji: true },
          url: `${baseUrl}/numbers.csv`,
          action_id: 'action_download_csv',
        }] : []),
        {
          type: 'button',
          text: { type: 'plain_text', text: '⬆️ Upload CSV', emoji: true },
          action_id: 'action_upload_csv',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔗 Connect', emoji: true },
          action_id: 'action_connect_line',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✏️ Edit', emoji: true },
          action_id: 'action_find_edit_line',
        },
      ],
    },
  ];

  // ─── Number preview (first 10) ───────────────────────────────────────────────
  const entries = Object.entries(numbers).reverse();
  if (entries.length > 0) {
    blocks.push({ type: 'divider' });
    const preview = entries.slice(0, 10);
    for (const [phone, entry] of preview) {
      const name = typeof entry === 'string' ? entry : (entry.name || '');
      const channel = typeof entry === 'object' ? entry.channel : null;
      const routing = (entry && typeof entry === 'object' && entry.routing) || 'walkietalkie';
      const isExternal = ['vapi', 'talkyto', 'pipecat'].includes(routing.toLowerCase());
      const channelDisplay = channel ? `<#${channel}>` : (defaultChannel ? `<#${defaultChannel}> _(default)_` : '_no channel_');
      const cap = caps.numbers[phone];
      const capBadges = cap
        ? [cap.capabilities.sms ? 'SMS' : null, cap.capabilities.voice ? 'VOICE' : null].filter(Boolean).join(' · ') || 'no caps'
        : '_not scanned_';
      const routingBadge = isExternal ? `  \`${routing.toUpperCase()}\`` : '';
      const smsConn = cap?.smsUrl && baseUrl && cap.smsUrl.startsWith(baseUrl);
      const voiceConn = cap?.voiceUrl && baseUrl && cap.voiceUrl.startsWith(baseUrl);
      const connBadge = !cap || !baseUrl || isExternal
        ? ''
        : (smsConn || voiceConn) ? '  🟢' : '  🔴';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${name || '_(no name)_'}*  \`${phone}\`${routingBadge}\n→ ${channelDisplay}  |  ${capBadges}${connBadge}`,
        },
        accessory: {
          type: 'overflow',
          action_id: `action_number_menu__${phone}`,
          options: [
            { text: { type: 'plain_text', text: isExternal ? 'ℹ️ Info' : '✏️ Edit', emoji: true }, value: `edit__${phone}` },
            ...(!isExternal ? [{ text: { type: 'plain_text', text: '🔗 Conectar a WalkieTalkie', emoji: true }, value: `connect__${phone}` }] : []),
            { text: { type: 'plain_text', text: '🗑 Remove', emoji: true }, value: `remove__${phone}` },
          ],
        },
      });
    }
    if (entries.length > 10) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_… and ${entries.length - 10} more. Download the CSV to see and edit all lines._` }],
      });
    }
  }

  return { type: 'home', blocks };
}

// ─── Modal builders ───────────────────────────────────────────────────────────

function buildCredentialsModal() {
  const accountSid = getSetting('twilio.accountSid') || '';
  const authToken = getSetting('twilio.authToken') || '';

  return {
    type: 'modal',
    callback_id: 'modal_credentials',
    title: { type: 'plain_text', text: 'Twilio Credentials' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Find these at *console.twilio.com → Account Info*.' },
      },
      {
        type: 'input',
        block_id: 'block_account_sid',
        label: { type: 'plain_text', text: 'Account SID' },
        element: {
          type: 'plain_text_input',
          action_id: 'input_account_sid',
          initial_value: accountSid,
          placeholder: { type: 'plain_text', text: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
        },
      },
      {
        type: 'input',
        block_id: 'block_auth_token',
        label: { type: 'plain_text', text: 'Auth Token' },
        hint: { type: 'plain_text', text: 'Stored locally on the server, never sent to Slack.' },
        element: {
          type: 'plain_text_input',
          action_id: 'input_auth_token',
          initial_value: authToken,
          placeholder: { type: 'plain_text', text: 'Your Twilio Auth Token' },
        },
      },
    ],
  };
}

function buildDefaultChannelModal() {
  const defaultChannel = getSetting('slack.defaultChannel') || '';

  return {
    type: 'modal',
    callback_id: 'modal_default_channel',
    title: { type: 'plain_text', text: 'Default Channel' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'block_default_channel',
        label: { type: 'plain_text', text: 'Default Slack Channel' },
        hint: { type: 'plain_text', text: 'Messages from numbers with no channel override go here.' },
        element: {
          type: 'channels_select',
          action_id: 'input_default_channel',
          ...(defaultChannel ? { initial_channel: defaultChannel } : {}),
          placeholder: { type: 'plain_text', text: 'Select a channel' },
        },
      },
    ],
  };
}

const LANGUAGE_OPTIONS = [
  { text: { type: 'plain_text', text: '🌐 Auto-detect' }, value: '' },
  { text: { type: 'plain_text', text: '🇲🇽 Spanish (es)' }, value: 'es' },
  { text: { type: 'plain_text', text: '🇺🇸 English (en)' }, value: 'en' },
  { text: { type: 'plain_text', text: '🇧🇷 Portuguese (pt)' }, value: 'pt' },
  { text: { type: 'plain_text', text: '🇰🇷 Korean (ko)' }, value: 'ko' },
  { text: { type: 'plain_text', text: '🇨🇳 Chinese (zh)' }, value: 'zh' },
  { text: { type: 'plain_text', text: '🇫🇷 French (fr)' }, value: 'fr' },
  { text: { type: 'plain_text', text: '🇩🇪 German (de)' }, value: 'de' },
  { text: { type: 'plain_text', text: '🇮🇹 Italian (it)' }, value: 'it' },
  { text: { type: 'plain_text', text: '🇯🇵 Japanese (ja)' }, value: 'ja' },
  { text: { type: 'plain_text', text: '🇸🇦 Arabic (ar)' }, value: 'ar' },
];

function buildNumberModal(phone = '', entry = null) {
  const isEdit = !!phone;
  const name = entry ? (typeof entry === 'string' ? entry : entry.name || '') : '';
  const channel = entry && typeof entry === 'object' ? entry.channel || '' : '';
  const dtmf = entry && typeof entry === 'object' ? entry.dtmf || '' : '';
  const language = entry && typeof entry === 'object' ? entry.language || '' : '';

  return {
    type: 'modal',
    callback_id: 'modal_number',
    private_metadata: phone,
    title: { type: 'plain_text', text: isEdit ? 'Edit Line' : 'Add Line' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'block_phone',
        label: { type: 'plain_text', text: 'Phone Number' },
        hint: { type: 'plain_text', text: 'Include country code. Any format works — e.g. +52 999 489 0783 or 529994890783.' },
        element: {
          type: 'plain_text_input',
          action_id: 'input_phone',
          initial_value: phone,
          placeholder: { type: 'plain_text', text: '+1...' },
        },
      },
      {
        type: 'input',
        block_id: 'block_name',
        label: { type: 'plain_text', text: 'Friendly Name' },
        optional: true,
        hint: { type: 'plain_text', text: 'Shown in Slack thread headers. E.g. "Darwin OPS" or "Brazil Line 1".' },
        element: {
          type: 'plain_text_input',
          action_id: 'input_name',
          initial_value: name,
          placeholder: { type: 'plain_text', text: 'e.g. Marketing Line 1' },
        },
      },
      {
        type: 'input',
        block_id: 'block_channel',
        label: { type: 'plain_text', text: 'Slack Channel Override' },
        optional: true,
        hint: { type: 'plain_text', text: 'Leave blank to use the default channel.' },
        element: {
          type: 'channels_select',
          action_id: 'input_channel',
          ...(channel ? { initial_channel: channel } : {}),
          placeholder: { type: 'plain_text', text: 'Select a channel (optional)' },
        },
      },
      {
        type: 'input',
        block_id: 'block_dtmf',
        label: { type: 'plain_text', text: 'Auto-press DTMF (optional)' },
        optional: true,
        hint: { type: 'plain_text', text: 'Digits pressed automatically when a call arrives. Use "1" for WhatsApp (press 1 to receive code). "w" = 0.5s pause — e.g. "ww1" waits 1s extra before pressing. Meta verification needs no DTMF — it reads the code aloud and transcription handles it.' },
        element: {
          type: 'plain_text_input',
          action_id: 'input_dtmf',
          ...(dtmf ? { initial_value: dtmf } : {}),
          placeholder: { type: 'plain_text', text: 'e.g. 1' },
          max_length: 20,
        },
      },
      {
        type: 'input',
        block_id: 'block_language',
        label: { type: 'plain_text', text: 'Idioma de transcripción' },
        optional: true,
        hint: { type: 'plain_text', text: 'Mejora la precisión del Whisper. Deja en blanco para auto-detectar.' },
        element: {
          type: 'static_select',
          action_id: 'input_language',
          placeholder: { type: 'plain_text', text: '🌐 Auto-detect' },
          options: LANGUAGE_OPTIONS.filter((o) => o.value !== ''),
          ...(language ? { initial_option: LANGUAGE_OPTIONS.find((o) => o.value === language) } : {}),
        },
      },
      // Only show "Connect" checkbox when adding a new line (not editing)
      ...(!isEdit ? [{
        type: 'input',
        block_id: 'block_connect',
        optional: true,
        label: { type: 'plain_text', text: 'WalkieTalkie' },
        hint: { type: 'plain_text', text: 'Marca para apuntar los webhooks de Twilio a este servidor ahora.' },
        element: {
          type: 'checkboxes',
          action_id: 'input_connect',
          options: [
            {
              text: { type: 'mrkdwn', text: '*Conectar a WalkieTalkie*' },
              description: { type: 'plain_text', text: 'Apunta los webhooks de Twilio a este servidor' },
              value: 'connect',
            },
          ],
        },
      }] : []),
    ],
  };
}

function buildCsvUploadModal() {
  return {
    type: 'modal',
    callback_id: 'modal_csv_upload',
    title: { type: 'plain_text', text: 'Upload Number Directory' },
    submit: { type: 'plain_text', text: 'Apply' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '1. Download the current CSV using the ⬇️ button in the home tab.\n2. Edit it in any spreadsheet app (Excel, Google Sheets, Numbers).\n3. Export/save as CSV, then paste the full contents below.',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Column reference*\n• `phone_number` — E.164 format, e.g. `+15103137237` *(required)*\n• `friendly_name` — label in Slack threads\n• `channel_id` — Slack channel ID override (leave blank for default)\n• `routing` — `walkietalkie`, `vapi`, `talkyto`, or `pipecat` (external routing lines are saved but webhooks are left alone)\n• `sms`, `voice` — informational, not modified by upload',
        },
      },
      {
        type: 'input',
        block_id: 'block_csv',
        label: { type: 'plain_text', text: 'CSV Contents' },
        hint: { type: 'plain_text', text: 'Paste the full CSV here, including the header row.' },
        element: {
          type: 'plain_text_input',
          action_id: 'input_csv',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'phone_number,friendly_name,channel_id,routing,sms,voice\n+15103137237,Darwin OPS,C0AQN4ELYTF,walkietalkie,yes,yes' },
        },
      },
    ],
  };
}

function buildConfirmRemoveModal(phone, name) {
  return {
    type: 'modal',
    callback_id: 'modal_confirm_remove',
    private_metadata: phone,
    title: { type: 'plain_text', text: 'Remove Line?' },
    submit: { type: 'plain_text', text: 'Remove', emoji: true },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Remove *${name || phone}* (\`${phone}\`) from the number directory?\n\nThis only removes it from WalkieTalkie's mapping — the Twilio number itself is not affected.`,
        },
      },
    ],
  };
}

// ─── External Routing Warning Modal ──────────────────────────────────────────

/**
 * Shown instead of the edit modal when a number uses an external routing
 * provider (VAPI, Talkyto, Pipecat). Editing is blocked to prevent
 * accidentally overwriting webhook URLs managed by those platforms.
 *
 * @param {string} phone     E.164 number
 * @param {string} name      Friendly name
 * @param {string} routing   e.g. "vapi", "talkyto", "pipecat"
 */
function buildExternalRoutingModal(phone, name, routing) {
  const label = routing.charAt(0).toUpperCase() + routing.slice(1);

  return {
    type: 'modal',
    callback_id: 'modal_external_routing_info',
    title: { type: 'plain_text', text: 'External Routing' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *This number is managed by ${label}*`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${name || phone}*  \`${phone}\`\n\nThis line uses *${label}* for voice/SMS routing. WalkieTalkie will not modify its Twilio webhook URLs to avoid breaking the existing configuration.\n\nIf you need to change the friendly name or Slack channel for this number, update it directly in \`config/numbers.json\` or via a CSV upload.`,
        },
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `To reassign this number to WalkieTalkie, change \`routing\` to \`walkietalkie\` in the CSV upload, then run \`node scripts/configure-twilio.js\`.`,
        }],
      },
    ],
  };
}

// ─── Logs Modal ───────────────────────────────────────────────────────────────

function buildLogsModal(logs = []) {
  const blocks = [];

  if (logs.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No hay transacciones registradas aún._' },
    });
    return {
      type: 'modal',
      callback_id: 'modal_logs',
      title: { type: 'plain_text', text: 'Activity Log' },
      close: { type: 'plain_text', text: 'Close' },
      blocks,
    };
  }

  for (const entry of logs.slice(0, 20)) {
    const isSms = entry.type === 'sms';
    const isVoice = entry.type === 'voice-recording';
    const icon = isSms ? '💬' : '📞';
    const typeLabel = isSms ? 'SMS' : 'Voice';
    const when = relativeTime(entry.timestamp);
    const name = entry.friendlyName || entry.to || '';
    const statusIcon = entry.status === 'error' ? '❌' : '';

    let detail = `From: \`${entry.from || '?'}\``;
    if (entry.otp) detail += `  ·  OTP: \`${entry.otp}\``;
    if (isVoice && entry.duration) detail += `  ·  ${entry.duration}s`;
    if (isSms && entry.body) {
      const snippet = entry.body.length > 200 ? entry.body.slice(0, 200) + '…' : entry.body;
      detail += `\n_"${snippet}"_`;
    }
    if (isVoice && entry.transcript) {
      const snippet = entry.transcript.length > 200 ? entry.transcript.slice(0, 200) + '…' : entry.transcript;
      detail += `\n_"${snippet}"_`;
    } else if (isVoice && entry.status === 'success' && !entry.transcript) {
      detail += `\n_sin transcripción_`;
    }
    if (entry.status === 'error') detail += `\n⚠️ ${entry.error || 'error'}`;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} ${statusIcon}*${typeLabel}* · *${name}*  \`${entry.to}\`  ·  _${when}_\n${detail}`,
      },
    });
    blocks.push({ type: 'divider' });
  }

  // Remove trailing divider
  if (blocks[blocks.length - 1]?.type === 'divider') blocks.pop();

  if (logs.length > 20) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Showing 20 of ${logs.length} entries. Use \`GET /logs\` for the full log._` }],
    });
  }

  return {
    type: 'modal',
    callback_id: 'modal_logs',
    title: { type: 'plain_text', text: 'Activity Log' },
    close: { type: 'plain_text', text: 'Close' },
    blocks,
  };
}

// ─── Connect Line Modal ───────────────────────────────────────────────────────

function buildConnectModal() {
  return {
    type: 'modal',
    callback_id: 'modal_connect_line',
    title: { type: 'plain_text', text: 'Conectar a WalkieTalkie' },
    submit: { type: 'plain_text', text: 'Conectar' },
    close: { type: 'plain_text', text: 'Cancelar' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Apunta los webhooks de Twilio de este número a WalkieTalkie.\nFunciona aunque el número no esté visible en la lista.',
        },
      },
      {
        type: 'input',
        block_id: 'block_phone',
        label: { type: 'plain_text', text: 'Número de teléfono' },
        hint: { type: 'plain_text', text: 'Cualquier formato — e.g. +52 999 489 0783 o 529994890783.' },
        element: {
          type: 'plain_text_input',
          action_id: 'input_phone',
          placeholder: { type: 'plain_text', text: '+52...' },
        },
      },
    ],
  };
}

// ─── CSV Confirm Modal ────────────────────────────────────────────────────────

function buildCsvConfirmModal(rowCount, sampleRows = []) {
  const preview = sampleRows.slice(0, 5)
    .map((r) => `• \`${r.phone_number}\`  ${r.friendly_name || '_(sin nombre)_'}`)
    .join('\n');

  return {
    type: 'modal',
    callback_id: 'modal_csv_confirm',
    title: { type: 'plain_text', text: 'Confirmar carga' },
    submit: { type: 'plain_text', text: 'Reemplazar directorio' },
    close: { type: 'plain_text', text: 'Cancelar' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *Esto reemplazará el directorio completo con ${rowCount} línea${rowCount !== 1 ? 's' : ''}.*\n\nEl directorio actual se sobreescribe permanentemente. No hay deshacer.`,
        },
      },
      ...(preview ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Primeras ${Math.min(5, rowCount)} filas:*\n${preview}` },
      }] : []),
    ],
  };
}

// ─── Find & Edit Modal ────────────────────────────────────────────────────────

function buildFindLineModal() {
  return {
    type: 'modal',
    callback_id: 'modal_find_line',
    title: { type: 'plain_text', text: 'Editar línea' },
    submit: { type: 'plain_text', text: 'Buscar' },
    close: { type: 'plain_text', text: 'Cancelar' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Busca cualquier número en el directorio para editarlo, aunque no esté visible en la lista.',
        },
      },
      {
        type: 'input',
        block_id: 'block_phone',
        label: { type: 'plain_text', text: 'Número de teléfono' },
        hint: { type: 'plain_text', text: 'Cualquier formato — e.g. +52 999 489 0783 o 529994890783.' },
        element: {
          type: 'plain_text_input',
          action_id: 'input_phone',
          placeholder: { type: 'plain_text', text: '+52...' },
        },
      },
    ],
  };
}

module.exports = {
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
};
