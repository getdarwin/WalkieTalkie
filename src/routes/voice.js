const express = require('express');
const { WebClient } = require('@slack/web-api');
const Groq = require('groq-sdk');
const twilio = require('twilio');
const twilioValidate = require('../middleware/twilioValidate');
const { getSetting } = require('../services/settings');
const { getFriendlyName, getChannel, getLanguage, getKeypressConfig } = require('../services/numbers');
const { checkAndCacheCapabilities } = require('../services/capabilities');
const { resolveCallParties } = require('../services/phone');

const DEFAULT_ZADARMA_SIP_DOMAIN = 'darwin-zadarma.sip.twilio.com';
const { saveCallThread, getCallThread, updateCallThread } = require('../services/callThreads');
const { logTransaction } = require('../services/logger');
const { sendCallStartToSlack, postToThread, parseOtp, buildCallTranscriptBlocks } = require('../services/slack');
const { backgroundTask } = require('../services/background');
const { uploadFileToThread, uploadFailureNotice } = require('../services/slackUpload');
const { resolveCallThread } = require('../services/callThreadResolver');
const { detectKeypress, detectKeypressSmart } = require('../services/ivrKeypress');
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

// Twilio drops the call if the answer webhook takes ~15s. Posting to Slack is
// never allowed to hold the TwiML longer than this; the post finishes in the
// background and callbacks wait for / rebuild the thread (resolveCallThread).
const CALL_START_MAX_WAIT_MS = 5_000;

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
async function twilioClient() {
  const [accountSid, authToken] = await Promise.all([
    getSetting('twilio.accountSid'),
    getSetting('twilio.authToken'),
  ]);
  return twilio(accountSid, authToken);
}

async function pressKeyOnLiveCall(callSid, digit, baseUrl) {
  const client = await twilioClient();
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
  const { CallSid } = req.body;
  // Calls from Zadarma arrive over SIP (To = "sip:<DID>@<domain>.sip.twilio.com").
  // Normalize to E.164 up front so the directory, Slack and call threads see the same key.
  const { to: To, from: From, sip, provider } = resolveCallParties(req.body, {
    zadarmaDomain: process.env.ZADARMA_TWILIO_SIP_DOMAIN || DEFAULT_ZADARMA_SIP_DOMAIN,
  });

  if (!From || !To || !CallSid) {
    console.warn('[voice] Malformed payload — missing From/To/CallSid');
    return twimlResponse(res);
  }

  // The exact SIP format is unconfirmed: log the raw body once per call to verify it.
  if (sip) {
    console.log(`[voice] SIP call raw body: ${JSON.stringify(req.body).slice(0, 2000)}`);
  }
  console.log(`[voice] Incoming call  To=${To}  From=${From}  CallSid=${CallSid}${sip ? '  (via SIP)' : ''}`);

  // checkAndCacheCapabilities itself skips Zadarma lines (they are not in the Twilio account)
  backgroundTask(checkAndCacheCapabilities(To));

  const [friendlyName, channel, keypress] = await Promise.all([
    getFriendlyName(To),
    getChannel(To),
    getKeypressConfig(To),
  ]);

  // Save the call first: if the Slack post is slow or fails, the recording
  // callback still knows the line and can rebuild the thread.
  try {
    await saveCallThread(CallSid, {
      channel, toNumber: To, fromNumber: From, friendlyName,
      keypressMode: keypress.mode,
      ...(provider === 'zadarma' ? { provider } : {}),
    });
  } catch (err) {
    console.error(`[voice] Failed to save call record  CallSid=${CallSid}:`, err.message);
  }

  const slackPost = (async () => {
    const threadTs = await sendCallStartToSlack({ channel, friendlyName, toNumber: To, fromNumber: From });
    await updateCallThread(CallSid, { threadTs });
  })().catch((err) => {
    console.error(`[voice] Failed to post call start to Slack  CallSid=${CallSid}:`, err.message);
    return logTransaction({
      type: 'voice-call-start', to: To, from: From, callSid: CallSid, friendlyName, channel,
      otp: null, status: 'error', error: err.message,
    });
  });
  backgroundTask(slackPost);
  await Promise.race([slackPost, sleep(CALL_START_MAX_WAIT_MS)]);

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

// How many trailing final segments are joined before detection, so a prompt
// split across segments ("aprieta la línea," / "la tecla ocho") still matches.
const IVR_CONTEXT_SEGMENTS = 3;

async function handleLiveTranscript(callSid, transcript, isFinal) {
  // Partial results are noisy and repeat: regex only, on the fragment itself.
  // Final results: store, then run the two-layer detector (regex → LLM) over
  // the last few segments joined together.
  let keypress = detectKeypress(transcript);
  if (isFinal) {
    let context = transcript;
    try {
      await store.listPush(ivrLogKey(callSid), transcript, IVR_LOG_MAX_SEGMENTS, IVR_LOG_TTL_SECONDS);
      if (!keypress) {
        const recent = await store.listRange(ivrLogKey(callSid), 0, IVR_CONTEXT_SEGMENTS - 1);
        if (recent.length > 1) context = recent.reverse().join(' ');
      }
    } catch (err) {
      console.error('[voice] Failed to store live transcript:', err.message);
    }
    if (!keypress) keypress = await detectKeypressSmart(context);
  }
  if (!keypress) return;
  const source = keypress.source || 'regex';

  // One-shot lock: partial + final results repeat the same phrase, and several
  // callback invocations may run concurrently on Vercel.
  const acquired = await store.setJSONIfAbsent(
    keypressLockKey(callSid),
    { digit: keypress.digit, matched: keypress.matched, at: new Date().toISOString() },
    KEYPRESS_LOCK_TTL_SECONDS
  );
  if (!acquired) return;

  console.log(`[voice] IVR asks for key "${keypress.digit}"  CallSid=${callSid}  via=${source}  ("${keypress.matched}")`);

  // Press first (the IVR is waiting), then look up the thread for the note.
  const threadPromise = threadForCallback(callSid, 'keypress');
  let pressError = null;
  try {
    await pressKeyOnLiveCall(callSid, keypress.digit, process.env.WEBHOOK_BASE_URL);
  } catch (err) {
    pressError = err;
  }
  const thread = await threadPromise;
  if (pressError) {
    const err = pressError;
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

  await updateCallThread(callSid, { keypress: keypress.digit, keypressMatched: keypress.matched, keypressSource: source });

  if (thread) {
    const via = source === 'llm' ? ' _(entendido por IA)_' : '';
    await postToThread(
      thread.channel,
      thread.threadTs,
      [{ type: 'context', elements: [{ type: 'mrkdwn', text: `_🔢 IVR asked for key *${keypress.digit}* ("${keypress.matched}") — pressed automatically.${via}_` }] }],
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
      source,
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

/**
 * The call's Slack thread, waiting for an in-flight post or rebuilding it when
 * missing. Logs a persistent error instead of silently dropping the callback.
 */
async function threadForCallback(callSid, context) {
  const { thread, recovered, error } = await resolveCallThread(callSid, {
    getCallThread,
    saveCallThread,
    fetchCallParties: async (sid) => {
      const call = await (await twilioClient()).calls(sid).fetch();
      return resolveCallParties({ To: call.to, From: call.from }, {
        zadarmaDomain: process.env.ZADARMA_TWILIO_SIP_DOMAIN || DEFAULT_ZADARMA_SIP_DOMAIN,
      });
    },
    lookupLine: async (to) => {
      const [friendlyName, channel, keypress] = await Promise.all([
        getFriendlyName(to), getChannel(to), getKeypressConfig(to),
      ]);
      return { friendlyName, channel, keypressMode: keypress.mode };
    },
    createThread: (c) => sendCallStartToSlack({
      channel: c.channel, friendlyName: c.friendlyName, toNumber: c.toNumber, fromNumber: c.fromNumber,
    }),
    sleep,
  });

  if (recovered) console.warn(`[voice] Rebuilt missing Slack thread  CallSid=${callSid}  (${context})`);
  if (!thread) {
    console.error(`[voice] No thread for CallSid=${callSid} (${context}): ${error}`);
    await logTransaction({
      type: 'voice-recording', callSid, otp: null, status: 'error',
      error: `thread not found (${context}): ${error}`,
    });
  }
  return thread;
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
  const thread = await threadForCallback(CallSid, `ended:${status}`);
  if (!thread) return;

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
  const thread = await threadForCallback(CallSid, 'recording');
  if (!thread) return;

  const duration = parseInt(RecordingDuration) || 0;

  try {
    const [language, liveTranscript] = await Promise.all([
      getLanguage(thread.toNumber).catch(() => null),
      loadLiveTranscript(CallSid),
    ]);
    const { buffer } = await downloadRecording(RecordingUrl);
    const filename = `call-${CallSid}-${Date.now()}.mp3`;

    // Upload and transcription are independent: a failed upload (e.g. the bot
    // is not in a #client-* channel) must never swallow the transcript + OTP.
    const [upload, transcription] = await Promise.all([
      uploadFileToThread(slack, {
        channel: thread.channel,
        threadTs: thread.threadTs,
        buffer,
        filename,
        title: `📞 Recording — ${duration}s`,
      }),
      transcribeWithGroq(buffer, filename, language).then(
        (text) => ({ text }),
        (err) => ({ text: null, error: err.message })
      ),
    ]);
    const transcript = transcription.text;

    if (upload.ok) {
      console.log(`[voice] Audio uploaded to Slack  CallSid=${CallSid}${upload.joined ? '  (joined channel first)' : ''}`);
    } else {
      console.error(`[voice] Audio upload failed  CallSid=${CallSid}  channel=${thread.channel}  error=${upload.error}${upload.joinError ? `  joinError=${upload.joinError}` : ''}`);
      const notice = uploadFailureNotice(upload);
      await postToThread(
        thread.channel,
        thread.threadTs,
        [{ type: 'context', elements: [{ type: 'mrkdwn', text: `_${notice}_` }] }],
        notice
      );
    }
    if (transcription.error) {
      console.error(`[voice] Transcription failed  CallSid=${CallSid}: ${transcription.error}`);
    }

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

    // Whisper failed but the live transcript caught the call: use it so the
    // code still reaches the thread.
    const text = transcript || (transcription.error ? liveTranscript : null);
    if (text) {
      const otp = parseOtp(text);
      await postToThread(
        thread.channel,
        thread.threadTs,
        buildCallTranscriptBlocks(text, otp),
        `📝 "${text}"`,
        !!otp
      );
      console.log(`[voice] Transcript posted  otp=${otp || 'none'}`);
    }

    const errors = [
      !upload.ok && `upload: ${upload.error}${upload.joinError ? ` (join: ${upload.joinError})` : ''}`,
      transcription.error && `transcription: ${transcription.error}`,
    ].filter(Boolean);

    await logTransaction({
      type: 'voice-recording',
      to: thread.toNumber,
      from: thread.fromNumber,
      callSid: CallSid,
      recordingUrl: `${RecordingUrl}.mp3`,
      duration,
      transcript: text || null,
      liveTranscript,
      keypress: thread.keypress || null,
      otp: text ? parseOtp(text) : null,
      friendlyName: thread.friendlyName,
      channel: thread.channel,
      status: errors.length ? 'partial' : 'success',
      ...(errors.length ? { error: errors.join('; ') } : {}),
    });
  } catch (err) {
    console.error('[voice] Failed to process recording:', err.message);
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
