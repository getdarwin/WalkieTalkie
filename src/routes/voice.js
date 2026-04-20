const express = require('express');
const { WebClient } = require('@slack/web-api');
const Groq = require('groq-sdk');
const twilioValidate = require('../middleware/twilioValidate');
const { getFriendlyName, getChannel, getDtmf, getLanguage } = require('../services/numbers');
const { checkAndCacheCapabilities } = require('../services/capabilities');
const { saveCallThread, getCallThread } = require('../services/callThreads');
const { logTransaction } = require('../services/logger');
const { sendCallStartToSlack, postToThread, parseOtp, buildCallTranscriptBlocks } = require('../services/slack');

const router = express.Router();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function twimlResponse(res, xml = '') {
  res.type('text/xml').send(`<Response>${xml}</Response>`);
}

/**
 * Downloads the Twilio recording as an MP3 buffer.
 * Twilio requires Basic Auth (Account SID + Auth Token).
 */
async function downloadRecording(recordingUrl) {
  const url = `${recordingUrl}.mp3`;
  const auth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to download recording: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), url };
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

  checkAndCacheCapabilities(To).catch(() => {});

  const friendlyName = getFriendlyName(To);
  const channel = getChannel(To);

  try {
    const threadTs = await sendCallStartToSlack({ channel, friendlyName, toNumber: To, fromNumber: From });
    saveCallThread(CallSid, { channel, threadTs, toNumber: To, fromNumber: From, friendlyName });
  } catch (err) {
    console.error('[voice] Failed to post call start to Slack:', err.message);
  }

  // Auto-press DTMF if configured for this number (e.g. "1" for WhatsApp verification codes)
  const dtmf = getDtmf(To);
  const dtmfTwiml = dtmf
    ? `<Pause length="3"/><Play digits="${dtmf}"/><Pause length="1"/>`
    : '';

  const baseUrl = process.env.WEBHOOK_BASE_URL;
  twimlResponse(res, `
    ${dtmfTwiml}
    <Record
      maxLength="300"
      timeout="10"
      action="${baseUrl}/twilio-voice/recording"
      playBeep="false"
    />
  `);
});

// ─── POST /twilio-voice/recording ─────────────────────────────────────────────

router.post('/recording', twilioValidate, async (req, res) => {
  const { CallSid, RecordingUrl, RecordingDuration } = req.body;

  console.log(`[voice] Recording ready  CallSid=${CallSid}  Duration=${RecordingDuration}s`);

  // Respond to Twilio immediately — download + upload happens after
  twimlResponse(res);

  const thread = getCallThread(CallSid);
  if (!thread) {
    console.warn(`[voice] No thread found for CallSid=${CallSid}`);
    return;
  }

  const duration = parseInt(RecordingDuration) || 0;
  const language = getLanguage(thread.toNumber);

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

    logTransaction({
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
    logTransaction({
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
});

module.exports = router;
