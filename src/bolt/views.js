const { getSetting } = require('../services/settings');
const { loadConfig } = require('../services/numbers');
const { getCapabilities } = require('../services/capabilities');

/**
 * Builds the full App Home Block Kit view.
 * Called on every home_opened event and after any config change.
 */
function buildAppHomeView() {
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

    // ─── Getting Started ──────────────────────────────────────────────────────
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*📖  Getting Started*\n1. Set your Twilio credentials (Account SID + Auth Token)\n2. Set the default Slack channel for unmapped numbers\n3. Click *Sync Twilio Numbers* to scan your lines\n4. Download the number directory CSV, fill in friendly names + channels, and upload it back\n5. Text or call any configured number — messages appear in Slack\n\n💡  SMS messages are grouped by phone number per day. Voice calls post a recording and transcript to the same thread. Numbers with VAPI/Talkyto configured are skipped automatically.',
      },
    },
    { type: 'divider' },

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

    // ─── Sync Button ──────────────────────────────────────────────────────────
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
          style: 'primary',
        },
      ],
    },
  ];

  // ─── Number preview (first 10) ───────────────────────────────────────────────
  const entries = Object.entries(numbers);
  if (entries.length > 0) {
    blocks.push({ type: 'divider' });
    const preview = entries.slice(0, 10);
    for (const [phone, entry] of preview) {
      const name = typeof entry === 'string' ? entry : (entry.name || '');
      const channel = typeof entry === 'object' ? entry.channel : null;
      const routing = (entry && typeof entry === 'object' && entry.routing) || 'walkietalkie';
      const channelDisplay = channel ? `<#${channel}>` : (defaultChannel ? `<#${defaultChannel}> _(default)_` : '_no channel_');
      const cap = caps.numbers[phone];
      const capBadges = cap
        ? [cap.capabilities.sms ? 'SMS' : null, cap.capabilities.voice ? 'VOICE' : null].filter(Boolean).join(' · ') || 'no caps'
        : '_not scanned_';
      const routingBadge = routing === 'vapi' ? '  `VAPI`' : '';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${name || '_(no name)_'}*  \`${phone}\`${routingBadge}\n→ ${channelDisplay}  |  ${capBadges}`,
        },
        accessory: {
          type: 'overflow',
          action_id: `action_number_menu__${phone}`,
          options: [
            { text: { type: 'plain_text', text: '✏️ Edit', emoji: true }, value: `edit__${phone}` },
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

function buildNumberModal(phone = '', entry = null) {
  const isEdit = !!phone;
  const name = entry ? (typeof entry === 'string' ? entry : entry.name || '') : '';
  const channel = entry && typeof entry === 'object' ? entry.channel || '' : '';

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
        hint: { type: 'plain_text', text: 'E.164 format — e.g. +15103137237. Must start with + and country code.' },
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
          text: '*Column reference*\n• `phone_number` — E.164 format, e.g. `+15103137237` *(required)*\n• `friendly_name` — label in Slack threads\n• `channel_id` — Slack channel ID override (leave blank for default)\n• `routing` — `walkietalkie` or `vapi` (VAPI/Talkyto lines are saved but webhooks are left alone)\n• `sms`, `voice` — informational, not modified by upload',
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

module.exports = {
  buildAppHomeView,
  buildCredentialsModal,
  buildDefaultChannelModal,
  buildNumberModal,
  buildCsvUploadModal,
  buildConfirmRemoveModal,
};
