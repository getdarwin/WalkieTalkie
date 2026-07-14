const { WebClient } = require('@slack/web-api');
const store = require('./store');

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// Persists thread timestamps so threads survive across serverless invocations
// and restarts. Key format: "thread:<channelId>:<toNumber>:<YYYY-MM-DD>"
// A new top-level thread is created each day per line; entries expire after
// 2 days since they're only relevant for the current day.
const THREAD_TTL_SECONDS = 2 * 24 * 60 * 60;

// ─── Thread store ─────────────────────────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function threadKey(channel, toNumber) {
  return `thread:${channel}:${toNumber}:${todayKey()}`;
}

async function getThreadTs(key) {
  try {
    return await store.getJSON(key);
  } catch (err) {
    console.error('[slack] Failed to read thread store:', err.message);
    return null;
  }
}

async function saveThreadTs(key, ts) {
  try {
    await store.setJSON(key, ts, THREAD_TTL_SECONDS);
  } catch (err) {
    console.error('[slack] Failed to persist thread ts:', err.message);
  }
}

// ─── OTP detection ────────────────────────────────────────────────────────────

/**
 * Attempts to extract a verification code from a message body.
 *
 * Handles two transcription styles:
 *   - Compact:  "Your code is 123456"        → matches \b\d{4,8}\b
 *   - Spoken:   "1, 2, 3, 4, 5, 6" or        → digits separated by comma/space/dot
 *               "one two three four five six"  → written-out English digit words
 *
 * Returns the code as a plain digit string, or null if none found.
 *
 * @param {string} body
 * @returns {string|null}
 */
function parseOtp(body) {
  if (!body) return null;

  // 1. Standard consecutive digits (4–8)
  const compact = body.match(/\b(\d{4,8})\b/);
  if (compact) return compact[1];

  // 2. Spoken digits separated by commas, spaces, or dots: "5, 4, 3, 2, 1" or "1 2 3 4 5 6"
  const spokenDigits = body.match(/\b\d[\s,.\-]*(?:\d[\s,.\-]*){3,7}\b/);
  if (spokenDigits) {
    const digits = spokenDigits[0].replace(/[\s,.\-]/g, '');
    if (digits.length >= 4 && digits.length <= 8) return digits;
  }

  // 3. Written-out English digit words: "one two three four five six"
  const wordMap = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9 };
  const wordPattern = new RegExp(
    `\\b((?:${Object.keys(wordMap).join('|')})(?:[\\s,]+(?:${Object.keys(wordMap).join('|')})){3,7})\\b`,
    'i'
  );
  const wordMatch = body.match(wordPattern);
  if (wordMatch) {
    const digits = wordMatch[1]
      .toLowerCase()
      .split(/[\s,]+/)
      .map((w) => wordMap[w])
      .filter((d) => d !== undefined)
      .join('');
    if (digits.length >= 4 && digits.length <= 8) return digits;
  }

  return null;
}

// ─── Block Kit builders ───────────────────────────────────────────────────────

/**
 * Builds the Block Kit payload for the parent (thread-opener) message.
 * Shown once per day per line — acts as a header for the thread.
 */
function buildThreadHeaderBlocks(friendlyName, toNumber) {
  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📱 ${friendlyName}`,
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${toNumber}  •  ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
        },
      ],
    },
    { type: 'divider' },
  ];
}

/**
 * Builds the Block Kit payload for an individual SMS reply inside the thread.
 */
function buildMessageBlocks(fromNumber, body, otp) {
  const bodyDisplay = otp
    ? `*Verification Code:*\n\`\`\`${otp}\`\`\``
    : `*Message:*\n${body}`;

  return [
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*From:*\n${fromNumber}` },
        { type: 'mrkdwn', text: `*Time:*\n${new Date().toLocaleTimeString()}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: bodyDisplay },
    },
    // Show full body below the OTP if it contains additional context
    ...(otp && body.trim() !== otp
      ? [
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: body }],
          },
        ]
      : []),
  ];
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Posts an SMS to Slack, threading by (channel + toNumber + date).
 * Creates a new thread header when none exists for today, then replies
 * inside the thread for all subsequent messages.
 *
 * @param {object} opts
 * @param {string} opts.channel       Slack channel ID
 * @param {string} opts.friendlyName  Human-readable line name
 * @param {string} opts.toNumber      Raw E.164 Twilio "To" number
 * @param {string} opts.fromNumber    Raw E.164 sender number
 * @param {string} opts.body          SMS body text
 */
async function sendToSlack({ channel, friendlyName, toNumber, fromNumber, body }) {
  const key = threadKey(channel, toNumber);
  const otp = parseOtp(body);
  const messageBlocks = buildMessageBlocks(fromNumber, body, otp);
  const fallbackText = `SMS to ${friendlyName} from ${fromNumber}: ${body}`;

  let threadTs = await getThreadTs(key);

  if (!threadTs) {
    // Open a new day-thread with a header message
    const headerResult = await client.chat.postMessage({
      channel,
      blocks: buildThreadHeaderBlocks(friendlyName, toNumber),
      text: `SMS thread for ${friendlyName} — ${todayKey()}`,
    });

    threadTs = headerResult.ts;
    await saveThreadTs(key, threadTs);
  }

  // Post the SMS as a reply in the thread
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    blocks: messageBlocks,
    text: fallbackText,
    // Broadcast OTPs to the channel so they're visible without opening thread
    ...(otp ? { reply_broadcast: true } : {}),
  });
}

// ─── Voice Block Kit builders ─────────────────────────────────────────────────

/**
 * Block Kit for the initial "call is ringing" message posted to the shared thread.
 */
function buildCallStartBlocks(fromNumber) {
  return [
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*📞 Incoming call*\n${fromNumber}` },
        { type: 'mrkdwn', text: `*Time:*\n${new Date().toLocaleTimeString()}` },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Recording in progress..._' }],
    },
  ];
}

/**
 * Block Kit for when the recording is ready.
 */
function buildCallRecordingBlocks(recordingUrl, durationSeconds) {
  const duration = durationSeconds ? `${durationSeconds}s` : 'unknown duration';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🎙️ *Recording* — ${duration}\n<${recordingUrl}|Listen ↗>`,
      },
    },
  ];
}

/**
 * Block Kit for a completed transcription, with optional OTP highlighting.
 */
function buildCallTranscriptBlocks(transcriptText, otp) {
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `📝 _"${transcriptText}"_` },
    },
  ];

  if (otp) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Verification Code:*\n\`\`\`${otp}\`\`\`` },
    });
  }

  return blocks;
}

// ─── Voice posting helpers ────────────────────────────────────────────────────

/**
 * Posts a reply to an existing Slack thread by ts.
 * Used by voice recording + transcription callbacks which already know threadTs.
 *
 * @param {string}   channel    Slack channel ID
 * @param {string}   threadTs   Parent message timestamp
 * @param {object[]} blocks     Block Kit blocks
 * @param {string}   text       Fallback text
 * @param {boolean}  broadcast  Whether to also show in channel (reply_broadcast)
 */
async function postToThread(channel, threadTs, blocks, text, broadcast = false) {
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    blocks,
    text,
    ...(broadcast ? { reply_broadcast: true } : {}),
  });
}

/**
 * Posts an incoming call notification to the shared daily thread for that line.
 * Returns the threadTs so it can be stored against the CallSid.
 *
 * @param {object} opts
 * @param {string} opts.channel       Slack channel ID
 * @param {string} opts.friendlyName  Human-readable line name
 * @param {string} opts.toNumber      Raw E.164 Twilio "To" number
 * @param {string} opts.fromNumber    Raw E.164 caller number
 * @returns {Promise<string>} threadTs of the shared thread
 */
async function sendCallStartToSlack({ channel, friendlyName, toNumber, fromNumber }) {
  const key = threadKey(channel, toNumber);
  const blocks = buildCallStartBlocks(fromNumber);
  const fallbackText = `📞 Incoming call to ${friendlyName} from ${fromNumber}`;

  let threadTs = await getThreadTs(key);

  if (!threadTs) {
    const headerResult = await client.chat.postMessage({
      channel,
      blocks: buildThreadHeaderBlocks(friendlyName, toNumber),
      text: `Thread for ${friendlyName} — ${todayKey()}`,
    });
    threadTs = headerResult.ts;
    await saveThreadTs(key, threadTs);
  }

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    blocks,
    text: fallbackText,
  });

  return threadTs;
}

module.exports = {
  sendToSlack,
  sendCallStartToSlack,
  postToThread,
  parseOtp,
  buildCallRecordingBlocks,
  buildCallTranscriptBlocks,
};
