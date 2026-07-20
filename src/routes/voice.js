const express = require('express');
const { WebClient } = require('@slack/web-api');
const Groq = require('groq-sdk');
const twilioValidate = require('../middleware/twilioValidate');
const { getSetting } = require('../services/settings');
const { getFriendlyName, getChannel, getDtmf, getLanguage } = require('../services/numbers');
const { checkAndCacheCapabilities } = require('../services/capabilities');
const { saveCallThread, getCallThread } = require('../services/callThreads');
const { logTransaction } = require('../services/logger');
const { sendCallStartToSlack, postToThread, parseOtp, buildCallTranscriptBlocks } = require('../services/slack');
const { backgroundTask } = require('../services/background');

const router = express.Router();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function twimlResponse(res, xml = '') {
  res.type('text/xml').send(`<Response>${xml}</Response>`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Downloads the Twilio recording as an MP3 buffer.
 * Twilio requires Basic Auth (Account SID + Auth Token).
 */
async function downloadRecording(recordingUrl) {
  const url = `${recordingUrl}.mp3`;
  const [accountSid, authToken] = await Promise.all([
    getSetting('twilio.accountSid'),
    getSetting('twilio.authToken'),
  ]);
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  // Even after recordingStatusCallback fires, the MP3 can briefly lag behind in
  // Twilio's storage — retry on "not yet available" responses (404/403) with a
  // short backoff so a transient gap never leaves the thread stuck.
  const MAX_ATTEMPTS = 4;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        return { buffer: Buffer.from(arrayBuffer), url };
      }

      lastError = new Error(`Failed to download recording: ${response.status} ${response.statusText}`);
      // Only 404/403 are worth retrying (file not propagated yet); fail fast otherwise.
      if (response.status !== 404 && response.status !== 403) break;
    } catch (err) {
      lastError = err;
    }

    if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1000);
  }

  throw lastError;
}

/**
 * Uploads the MP3 buffer to a Slack thread as a file.
 */
async function uploadAudioToSlack({ channel, threadTs, buffer, filename, duration }) {
  await slack.files.uploadV2({
    channel_id: channel,
    thread_ts: threadTs,
    file: buffer,
    filename,
    title: `📞 Recording — ${duration}s`,
  });
}

/**
 * Transcribes an MP3 buffer using Groq Whisper.
 * Returns null if GROQ_API_KEY is not set or transcription fails.
 *
 * @param {Buffer} buffer  MP3 audio buffer
 * @param {string} filename
 * @returns {Promise<string|null>}
 */
async function transcribeWithGroq(buffer, filename, language = null) {
  if (!process.env.GROQ_API_KEY) return null;

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  // Groq expects a File-like object — wrap the buffer
  const file = new File([buffer], filename, { type: 'audio/mpeg' });

  const result = await groq.audio.transcriptions.create({
    file,
    model: 'whisper-large-v3-turbo',
    response_format: 'text',
    ...(language ? { language } : {}),
  });

  return typeof result === 'string' ? result.trim() : null;
}

// ─── POST /twilio-voice ───────────────────────────────────────────────────────

router.post('/', twilioValidate, async (req, res) => {
  const { From, To, CallSid } = req.body;

  if (!From || !To || !CallSid) {
    console.warn('[voice] Malformed payload — missing From/To/CallSid');
    return twimlResponse(res);
  }

  console.log(`[voice] Incoming call  To=${To}  From=${From}  CallSid=${CallSid}`);

  backgroundTask(checkAndCacheCapabilities(To));

  const friendlyName = await getFriendlyName(To);
  const channel = await getChannel(To);

  try {
    const threadTs = await sendCallStartToSlack({ channel, friendlyName, toNumber: To, fromNumber: From });
    await saveCallThread(CallSid, { channel, threadTs, toNumber: To, fromNumber: From, friendlyName });
  } catch (err) {
    console.error('[voice] Failed to post call start to Slack:', err.message);
  }

  // Auto-press DTMF if configured for this number (e.g. "1" for WhatsApp verification codes).
  // Only digits/w/#/* are allowed — anything else would be TwiML injection, since
  // this value is user-configurable via the App Home / CSV upload.
  const dtmf = await getDtmf(To);
  const safeDtmf = dtmf && /^[0-9w#*]+$/i.test(dtmf) ? dtmf : null;
  if (dtmf && !safeDtmf) {
    console.warn(`[voice] Ignoring invalid dtmf value for ${To}`);
  }
  const dtmfTwiml = safeDtmf
    ? `<Pause length="3"/><Play digits="${safeDtmf}"/><Pause length="1"/>`
    : '';

  const baseUrl = process.env.WEBHOOK_BASE_URL;
  // Two attributes keep the OTP audio intact (Meta reads codes with tiny pauses
  // between digits, and the recording kept losing the last/first digit):
  //   • trim="do-not-trim"  → Twilio's default (trim-silence) strips leading &
  //     trailing silence, which can clip a digit sitting next to a pause. Off.
  //   • finishOnKey=""      → default is 1234567890*# — ANY DTMF tone during the
  //     recording ends it. Empty means no tone can cut the code short. Safe with
  //     the auto-press below because <Play digits> runs BEFORE <Record>, not during.
  // The dtmf auto-press (wait time via "w" = 0.5s each, plus the key) stays fully
  // configurable per line in case Meta reintroduces the human-verification button.
  //
  // Two callbacks, two jobs:
  //   • recordingStatusCallback → the real work (download/upload/transcribe).
  //     Only fires once a recording actually exists AND its MP3 is downloadable,
  //     which is why we don't download from `action` (that 404s — the file
  //     isn't ready yet — and leaves the thread stuck on "Recording in progress").
  //   • action → fires whenever <Record> ends, INCLUDING an immediate hangup
  //     that produced no recording (so recordingStatusCallback never fires).
  //     We use it only to resolve the thread when there's no audio.
  twimlResponse(res, `
    ${dtmfTwiml}
    <Record
      maxLength="300"
      timeout="10"
      trim="do-not-trim"
      finishOnKey=""
      action="${baseUrl}/twilio-voice/ended"
      recordingStatusCallback="${baseUrl}/twilio-voice/recording"
      recordingStatusCallbackEvent="completed"
      playBeep="false"
    />
  `);
});

// ─── POST /twilio-voice/ended ─────────────────────────────────────────────────
// `action` callback: fires when <Record> ends by any means (hangup, silence
// timeout, maxLength). If audio was captured, recordingStatusCallback owns the
// processing and we do nothing here. If there's no recording (caller hung up
// with no audio), we resolve the thread so it never stays "Recording in progress".

router.post('/ended', twilioValidate, async (req, res) => {
  const { CallSid, RecordingUrl, RecordingDuration, Digits } = req.body;
  const duration = parseInt(RecordingDuration) || 0;

  console.log(`[voice] Record ended  CallSid=${CallSid}  Digits=${Digits || 'n/a'}  Duration=${duration}s  hasRecording=${!!RecordingUrl}`);

  // Empty TwiML ends the call (if the caller is still on the line).
  twimlResponse(res);

  if (!RecordingUrl || duration === 0) {
    backgroundTask(handleNoRecording(CallSid, 'no-audio'));
  }
});

// ─── POST /twilio-voice/recording ─────────────────────────────────────────────

router.post('/recording', twilioValidate, async (req, res) => {
  const { CallSid, RecordingUrl, RecordingDuration, RecordingStatus } = req.body;

  console.log(`[voice] Recording callback  CallSid=${CallSid}  Status=${RecordingStatus || 'n/a'}  Duration=${RecordingDuration}s`);

  // Respond to Twilio immediately — download + upload continues in the
  // background (kept alive on Vercel via waitUntil).
  twimlResponse(res);

  // No RecordingUrl → nothing to process. The `action`/ended callback owns the
  // "no audio" notice, so just skip here to avoid a duplicate thread message.
  if (!RecordingUrl) {
    console.warn(`[voice] Recording callback with no RecordingUrl  CallSid=${CallSid}`);
    return;
  }

  backgroundTask(processRecording(CallSid, RecordingUrl, RecordingDuration));
});

/**
 * Posts a short notice to the call thread when Twilio reports no recording
 * (e.g. the caller hung up before any audio was captured).
 */
async function handleNoRecording(CallSid, status) {
  const thread = await getCallThread(CallSid);
  if (!thread) {
    console.warn(`[voice] No thread found for CallSid=${CallSid} (status=${status})`);
    return;
  }

  await postToThread(
    thread.channel,
    thread.threadTs,
    [{ type: 'context', elements: [{ type: 'mrkdwn', text: '_⚠️ No audio was recorded for this call._' }] }],
    '⚠️ No audio was recorded for this call.'
  );

  await logTransaction({
    type: 'voice-recording',
    to: thread.toNumber,
    from: thread.fromNumber,
    callSid: CallSid,
    friendlyName: thread.friendlyName,
    channel: thread.channel,
    otp: null,
    status: 'no-recording',
    error: `RecordingStatus=${status}`,
  });
}

async function processRecording(CallSid, RecordingUrl, RecordingDuration) {
  const thread = await getCallThread(CallSid);
  if (!thread) {
    console.warn(`[voice] No thread found for CallSid=${CallSid}`);
    return;
  }

  const duration = parseInt(RecordingDuration) || 0;
  const language = await getLanguage(thread.toNumber);

  try {
    const { buffer } = await downloadRecording(RecordingUrl);
    const filename = `call-${CallSid}-${Date.now()}.mp3`;

    // Upload audio + transcribe in parallel
    const [, transcript] = await Promise.all([
      uploadAudioToSlack({ channel: thread.channel, threadTs: thread.threadTs, buffer, filename, duration }),
      transcribeWithGroq(buffer, filename, language),
    ]);

    console.log(`[voice] Audio uploaded to Slack  CallSid=${CallSid}`);

    // Post transcript if we got one
    if (transcript) {
      const otp = parseOtp(transcript);
      await postToThread(
        thread.channel,
        thread.threadTs,
        buildCallTranscriptBlocks(transcript, otp),
        `📝 "${transcript}"`,
        !!otp
      );
      console.log(`[voice] Transcript posted  otp=${otp || 'none'}`);
    }

    await logTransaction({
      type: 'voice-recording',
      to: thread.toNumber,
      from: thread.fromNumber,
      callSid: CallSid,
      recordingUrl: `${RecordingUrl}.mp3`,
      duration,
      transcript: transcript || null,
      otp: transcript ? parseOtp(transcript) : null,
      friendlyName: thread.friendlyName,
      channel: thread.channel,
      status: 'success',
    });
  } catch (err) {
    console.error('[voice] Failed to upload recording to Slack:', err.message);
    await logTransaction({
      type: 'voice-recording',
      to: thread.toNumber,
      from: thread.fromNumber,
      callSid: CallSid,
      friendlyName: thread.friendlyName,
      channel: thread.channel,
      otp: null,
      status: 'error',
      error: err.message,
    });
  }
}

module.exports = router;
