const express = require('express');
const { WebClient } = require('@slack/web-api');
const Groq = require('groq-sdk');
const twilio = require('twilio');
const twilioValidate = require('../middleware/twilioValidate');
const { getSetting } = require('../services/settings');
const { getFriendlyName, getChannel, getLanguage, getKeypressConfig } = require('../services/numbers');
const { checkAndCacheCapabilities } = require('../services/capabilities');
const { saveCallThread, getCallThread, updateCallThread } = require('../services/callThreads');
const { logTransaction } = require('../services/logger');
const { sendCallStartToSlack, postToThread, parseOtp, buildCallTranscriptBlocks } = require('../services/slack');
const { backgroundTask } = require('../services/background');
const { detectKeypress } = require('../services/ivrKeypress');
const store = require('../services/store');

const router = express.Router();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function twimlResponse(res, xml = '') {
  res.type('text/xml').send(`<Response>${xml}</Response>`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Live IVR transcript segments are kept per call for evidence (surfaced in the
// transaction log) and the keypress lock guarantees exactly one <Play digits>.
const IVR_LOG_MAX_SEGMENTS = 100;
const IVR_LOG_TTL_SECONDS = 24 * 60 * 60;
const KEYPRESS_LOCK_TTL_SECONDS = 60 * 60;

const ivrLogKey = (callSid) => `ivrlog:${callSid}`;
const keypressLockKey = (callSid) => `ivrpress:${callSid}`;

/**
 * <Record> TwiML shared by the initial answer and the post-keypress redirect.
 *
 * Two attributes keep the OTP audio intact (Meta reads codes with tiny pauses
 * between digits, and the recording kept losing the last/first digit):
 *   • trim="do-not-trim"  → Twilio's default (trim-silence) strips leading &
 *     trailing silence, which can clip a digit sitting next to a pause. Off.
 *   • finishOnKey=""      → default is 1234567890*# — ANY DTMF tone during the
 *     recording ends it. Empty means no tone can cut the code short.
 *
 * Two callbacks, two jobs:
 *   • recordingStatusCallback → the real work (download/upload/transcribe).
 *     Only fires once a recording actually exists AND its MP3 is downloadable,
 *     which is why we don't download from `action` (that 404s — the file
 *     isn't ready yet — and leaves the thread stuck on "Recording in progress").
 *   • action → fires whenever <Record> ends, INCLUDING an immediate hangup
 *     that produced no recording (so recordingStatusCallback never fires).
 *     We use it only to resolve the thread when there's no audio.
 */
function recordTwiml(baseUrl) {
  return `<Record
      maxLength="300"
      timeout="10"
      trim="do-not-trim"
      finishOnKey=""
      action="${baseUrl}/twilio-voice/ended"
      recordingStatusCallback="${baseUrl}/twilio-voice/recording"
      recordingStatusCallbackEvent="completed"
      playBeep="false"
    />`;
}

/**
 * <Start><Transcription> TwiML — Twilio Real-Time Transcription of the caller
 * (inbound) track, streamed to /twilio-voice/transcription while <Record> runs.
 *
 * Deepgram nova-3 with languageCode="multi" auto-detects the spoken language,
 * which matters because Meta's IVR language does not correlate with the line's
 * country (US lines speak Spanish, AR lines speak English…).
 */
function liveTranscriptionTwiml(baseUrl, callSid) {
  return `<Start>
      <Transcription
        name="ivr-${callSid}"
        statusCallbackUrl="${baseUrl}/twilio-voice/transcription"
        transcriptionEngine="deepgram"
        speechModel="nova-3"
        languageCode="multi"
        track="inbound_track"
        partialResults="true"
      />
    </Start>`;
}

/**
 * Redirects the live call to new TwiML: press the requested key, then keep
 * recording so the verification code that follows is captured.
 */
async function pressKeyOnLiveCall(callSid, digit, baseUrl) {
  const [accountSid, authToken] = await Promise.all([
    getSetting('twilio.accountSid'),
    getSetting('twilio.authToken'),
  ]);
  const client = twilio(accountSid, authToken);
  // "w" = 0.5s pause so the tone lands after the IVR finishes speaking.
  const twiml = `<Response><Play digits="w${digit}"/>${recordTwiml(baseUrl)}</Response>`;
  await client.calls(callSid).update({ twiml });
}

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

  const [friendlyName, channel, keypress] = await Promise.all([
    getFriendlyName(To),
    getChannel(To),
    getKeypressConfig(To),
  ]);

  try {
    const threadTs = await sendCallStartToSlack({ channel, friendlyName, toNumber: To, fromNumber: From });
    await saveCallThread(CallSid, {
      channel, threadTs, toNumber: To, fromNumber: From, friendlyName,
      keypressMode: keypress.mode,
    });
  } catch (err) {
    console.error('[voice] Failed to post call start to Slack:', err.message);
  }

  console.log(`[voice] Keypress mode=${keypress.mode} (${keypress.source})  To=${To}`);
  twimlResponse(res, buildAnswerTwiml(CallSid, keypress));
});

/**
 * TwiML for answering a call, according to the line's keypress mode:
 *
 *   auto  → <Start><Transcription> + <Record> from second zero. Meta's
 *           verification IVR gates the call behind an anti-bot keypress whose
 *           digit changes between calls ("press 9", "presione el 0", "aperte 8"),
 *           so /transcription reads the instruction live and presses the key.
 *   fixed → legacy behaviour: wait, <Play digits> the configured tones, record.
 *   none  → just record.
 */
function buildAnswerTwiml(callSid, keypress) {
  const baseUrl = process.env.WEBHOOK_BASE_URL;
  switch (keypress.mode) {
    case 'auto':
      return `${liveTranscriptionTwiml(baseUrl, callSid)}${recordTwiml(baseUrl)}`;
    case 'fixed':
      return `<Pause length="3"/><Play digits="${keypress.dtmf}"/><Pause length="1"/>${recordTwiml(baseUrl)}`;
    default:
      return recordTwiml(baseUrl);
  }
}

// ─── POST /twilio-voice/transcription ─────────────────────────────────────────
// Real-Time Transcription statusCallback. Fires many times per call:
// transcription-started, N × transcription-content, transcription-stopped.
// Each content event carries a transcript fragment; when one contains a
// "press <key>" instruction we redirect the call to <Play digits> exactly once.

router.post('/transcription', twilioValidate, async (req, res) => {
  const { CallSid, TranscriptionEvent, TranscriptionData, Final, TranscriptionError } = req.body;

  // Twilio ignores the body; acknowledge fast and do the work in the background.
  res.status(200).end();

  if (TranscriptionEvent === 'transcription-error') {
    console.error(`[voice] Live transcription error  CallSid=${CallSid}  ${TranscriptionError || ''}`);
    return;
  }
  if (TranscriptionEvent !== 'transcription-content' || !TranscriptionData) return;

  let transcript = '';
  try {
    transcript = (JSON.parse(TranscriptionData).transcript || '').trim();
  } catch {
    console.warn(`[voice] Unparseable TranscriptionData  CallSid=${CallSid}`);
    return;
  }
  if (!transcript) return;

  const isFinal = String(Final) === 'true';
  console.log(`[voice] Live transcript  CallSid=${CallSid}  final=${isFinal}  "${transcript}"`);

  backgroundTask(handleLiveTranscript(CallSid, transcript, isFinal));
});

async function handleLiveTranscript(callSid, transcript, isFinal) {
  if (isFinal) {
    await store
      .listPush(ivrLogKey(callSid), transcript, IVR_LOG_MAX_SEGMENTS, IVR_LOG_TTL_SECONDS)
      .catch((err) => console.error('[voice] Failed to store live transcript:', err.message));
  }

  const keypress = detectKeypress(transcript);
  if (!keypress) return;

  // One-shot lock: partial + final results repeat the same phrase, and several
  // callback invocations may run concurrently on Vercel.
  const acquired = await store.setJSONIfAbsent(
    keypressLockKey(callSid),
    { digit: keypress.digit, matched: keypress.matched, at: new Date().toISOString() },
    KEYPRESS_LOCK_TTL_SECONDS
  );
  if (!acquired) return;

  console.log(`[voice] IVR asks for key "${keypress.digit}"  CallSid=${callSid}  ("${keypress.matched}")`);

  const thread = await getCallThread(callSid);
  try {
    await pressKeyOnLiveCall(callSid, keypress.digit, process.env.WEBHOOK_BASE_URL);
  } catch (err) {
    console.error(`[voice] Failed to press key on live call  CallSid=${callSid}:`, err.message);
    if (thread) {
      await postToThread(
        thread.channel,
        thread.threadTs,
        [{ type: 'context', elements: [{ type: 'mrkdwn', text: `_⚠️ IVR asked for key *${keypress.digit}* ("${keypress.matched}") but pressing it failed: ${err.message}_` }] }],
        `⚠️ IVR asked for key ${keypress.digit} but pressing it failed`
      );
    }
    return;
  }

  await updateCallThread(callSid, { keypress: keypress.digit, keypressMatched: keypress.matched });

  if (thread) {
    await postToThread(
      thread.channel,
      thread.threadTs,
      [{ type: 'context', elements: [{ type: 'mrkdwn', text: `_🔢 IVR asked for key *${keypress.digit}* ("${keypress.matched}") — pressed automatically._` }] }],
      `🔢 Pressed key ${keypress.digit} as requested by the IVR`
    );
    await logTransaction({
      type: 'voice-keypress',
      to: thread.toNumber,
      from: thread.fromNumber,
      callSid,
      friendlyName: thread.friendlyName,
      channel: thread.channel,
      otp: null,
      keypress: keypress.digit,
      matched: keypress.matched,
      status: 'success',
    });
  }
}

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

/** Live IVR transcript segments for a call, oldest first. */
async function loadLiveTranscript(callSid) {
  try {
    const segments = await store.listRange(ivrLogKey(callSid));
    return segments.length ? segments.reverse().join(' ') : null;
  } catch (err) {
    console.error('[voice] Failed to load live transcript:', err.message);
    return null;
  }
}

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

  // Pressing the IVR key redirects the call and cuts the first <Record> short;
  // the second <Record> is still running, so this is not a silent call.
  if (thread.keypress) {
    console.log(`[voice] Ignoring empty first segment after keypress  CallSid=${CallSid}`);
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
  const liveTranscript = await loadLiveTranscript(CallSid);

  try {
    const { buffer } = await downloadRecording(RecordingUrl);
    const filename = `call-${CallSid}-${Date.now()}.mp3`;

    // Upload audio + transcribe in parallel
    const [, transcript] = await Promise.all([
      uploadAudioToSlack({ channel: thread.channel, threadTs: thread.threadTs, buffer, filename, duration }),
      transcribeWithGroq(buffer, filename, language),
    ]);

    console.log(`[voice] Audio uploaded to Slack  CallSid=${CallSid}`);

    // Auto mode but the IVR never asked for a key: say so, with what was heard,
    // so Ops can tell "no gate this time" from "detector missed the phrase".
    if (thread.keypressMode === 'auto' && !thread.keypress) {
      const heard = liveTranscript ? `"${liveTranscript.slice(0, 300)}${liveTranscript.length > 300 ? '…' : ''}"` : '_(no speech detected live)_';
      await postToThread(
        thread.channel,
        thread.threadTs,
        [{ type: 'context', elements: [{ type: 'mrkdwn', text: `_🎧 IVR did not ask for any key. Heard live: ${heard}_` }] }],
        '🎧 IVR did not ask for any key'
      );
    }

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
      liveTranscript,
      keypress: thread.keypress || null,
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
