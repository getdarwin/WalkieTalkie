const express = require('express');
const twilioValidate = require('../middleware/twilioValidate');
const { getFriendlyName, getChannel } = require('../services/numbers');
const { checkAndCacheCapabilities } = require('../services/capabilities');
const { saveCallThread, getCallThread } = require('../services/callThreads');
const { logTransaction } = require('../services/logger');
const {
  sendCallStartToSlack,
  postToThread,
  parseOtp,
  buildCallRecordingBlocks,
  buildCallTranscriptBlocks,
} = require('../services/slack');

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function twimlResponse(res, xml = '') {
  res.type('text/xml').send(`<Response>${xml}</Response>`);
}

// ─── POST /twilio-voice ───────────────────────────────────────────────────────

/**
 * Inbound call handler. Called by Twilio when any voice-capable number receives a call.
 * Immediately posts to Slack, then instructs Twilio to record silently.
 *
 * TwiML returned:
 *   <Record> with transcription enabled, no beep, no greeting.
 *   The `action` URL is called when the recording ends.
 *   The `transcribeCallback` URL is called when transcription is ready.
 */
router.post('/', twilioValidate, async (req, res) => {
  const { From, To, CallSid } = req.body;

  if (!From || !To || !CallSid) {
    console.warn('[voice] Malformed payload — missing From/To/CallSid');
    return twimlResponse(res);
  }

  console.log(`[voice] Incoming call  To=${To}  From=${From}  CallSid=${CallSid}`);

  // Fire-and-forget capabilities cache
  checkAndCacheCapabilities(To).catch(() => {});

  const friendlyName = getFriendlyName(To);
  const channel = getChannel(To);

  try {
    const threadTs = await sendCallStartToSlack({ channel, friendlyName, toNumber: To, fromNumber: From });
    saveCallThread(CallSid, { channel, threadTs, toNumber: To, fromNumber: From, friendlyName });
  } catch (err) {
    console.error('[voice] Failed to post call start to Slack:', err.message);
  }

  // Record silently — no greeting, no beep
  // action: called when recording ends (caller hangs up or maxLength reached)
  // transcribeCallback: called when Twilio finishes transcribing
  const baseUrl = process.env.WEBHOOK_BASE_URL;
  twimlResponse(res, `
    <Record
      maxLength="120"
      transcribe="true"
      transcribeCallback="${baseUrl}/twilio-voice/transcription"
      action="${baseUrl}/twilio-voice/recording"
      playBeep="false"
    />
  `);
});

// ─── POST /twilio-voice/recording ─────────────────────────────────────────────

/**
 * Called by Twilio when the recording is ready (caller hung up or maxLength reached).
 * Posts the recording link and duration to the Slack thread.
 */
router.post('/recording', twilioValidate, async (req, res) => {
  const { CallSid, RecordingUrl, RecordingDuration, RecordingStatus } = req.body;

  console.log(`[voice] Recording ready  CallSid=${CallSid}  Duration=${RecordingDuration}s  Status=${RecordingStatus}`);

  const thread = getCallThread(CallSid);
  if (!thread) {
    console.warn(`[voice] No thread found for CallSid=${CallSid}`);
    return twimlResponse(res);
  }

  const duration = parseInt(RecordingDuration) || 0;
  // Twilio recording URLs need .mp3 appended for direct playback
  const audioUrl = RecordingUrl ? `${RecordingUrl}.mp3` : null;

  try {
    if (audioUrl && duration > 0) {
      await postToThread(
        thread.channel,
        thread.threadTs,
        buildCallRecordingBlocks(audioUrl, duration),
        `🎙️ Recording — ${duration}s`
      );
    }

    logTransaction({
      type: 'voice-recording',
      to: thread.toNumber,
      from: thread.fromNumber,
      callSid: CallSid,
      recordingUrl: audioUrl,
      duration,
      friendlyName: thread.friendlyName,
      channel: thread.channel,
      otp: null,
      status: 'success',
    });
  } catch (err) {
    console.error('[voice] Failed to post recording to Slack:', err.message);
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

  twimlResponse(res);
});

// ─── POST /twilio-voice/transcription ─────────────────────────────────────────

/**
 * Called by Twilio when speech transcription is complete.
 * Posts the transcript to Slack, auto-detects and broadcasts OTPs.
 */
router.post('/transcription', twilioValidate, async (req, res) => {
  const { CallSid, TranscriptionText, TranscriptionStatus } = req.body;

  console.log(`[voice] Transcription ready  CallSid=${CallSid}  Status=${TranscriptionStatus}`);

  if (TranscriptionStatus !== 'completed' || !TranscriptionText) {
    console.warn(`[voice] Transcription not completed or empty — skipping  Status=${TranscriptionStatus}`);
    return res.sendStatus(204);
  }

  const thread = getCallThread(CallSid);
  if (!thread) {
    console.warn(`[voice] No thread found for CallSid=${CallSid}`);
    return res.sendStatus(204);
  }

  const otp = parseOtp(TranscriptionText);

  try {
    await postToThread(
      thread.channel,
      thread.threadTs,
      buildCallTranscriptBlocks(TranscriptionText, otp),
      `📝 Transcript: "${TranscriptionText}"`,
      !!otp  // broadcast to channel if OTP detected
    );

    logTransaction({
      type: 'voice-transcription',
      to: thread.toNumber,
      from: thread.fromNumber,
      callSid: CallSid,
      transcript: TranscriptionText,
      friendlyName: thread.friendlyName,
      channel: thread.channel,
      otp,
      status: 'success',
    });
  } catch (err) {
    console.error('[voice] Failed to post transcript to Slack:', err.message);
    logTransaction({
      type: 'voice-transcription',
      to: thread.toNumber,
      from: thread.fromNumber,
      callSid: CallSid,
      transcript: TranscriptionText,
      friendlyName: thread.friendlyName,
      channel: thread.channel,
      otp,
      status: 'error',
      error: err.message,
    });
  }

  res.sendStatus(204);
});

module.exports = router;
