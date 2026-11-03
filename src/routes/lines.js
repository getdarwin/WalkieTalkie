const express = require('express');
const requireSecret = require('../middleware/requireSecret');
const { loadConfig, setNumber, removeNumber } = require('../services/numbers');
const { connectNumberToWalkieTalkie } = require('../services/capabilities');
const { logTransaction } = require('../services/logger');
const { cleanText, normalizeE164, buildLineName, directoryNames } = require('../services/lineNaming');
const { normalizeProvider, entryProvider } = require('../services/provider');
const { connectZadarmaLine } = require('../services/zadarmaLines');

// Provisioning API for the n8n line-purchase flow (#solicitud-compra-lineaswhatsapp).
//   POST   /lines         { phone, client, owner?, channel?, provider?: "twilio"|"zadarma" } → save + connect webhooks
//   DELETE /lines/:phone  → drop the line from the directory after it is released

const router = express.Router();
router.use(express.json({ limit: '10kb' }));
router.use(requireSecret);

const EXTERNAL_ROUTING = new Set(['vapi', 'talkyto', 'pipecat']);
const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;

// Express 4 does not catch rejected promises — forward them to the error handler.
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

function entryName(entry) {
  return typeof entry === 'string' ? entry : (entry && entry.name) || '';
}

function entryRouting(entry) {
  return (entry && typeof entry === 'object' && entry.routing) || '';
}

router.post('/', wrap(async (req, res) => {
  const body = req.body || {};
  const phone = normalizeE164(body.phone);
  const channel = cleanText(body.channel);
  if (body.provider !== undefined && !['twilio', 'zadarma'].includes(String(body.provider).trim().toLowerCase())) {
    return res.status(400).json({ ok: false, error: 'provider must be "twilio" or "zadarma"' });
  }

  if (!phone) {
    return res.status(400).json({ ok: false, error: 'phone must be a valid E.164 number, e.g. +541148999365' });
  }
  if (channel && !SLACK_CHANNEL_ID.test(channel)) {
    return res.status(400).json({ ok: false, error: 'channel must be a Slack channel ID (e.g. C0123ABCD) or empty' });
  }

  const { numbers } = await loadConfig();
  const existing = numbers[phone];

  // Retries must not rename the line ("Acme" → "Acme 2"): keep the saved name.
  const alreadySaved = existing !== undefined && entryName(existing);
  const name = alreadySaved
    ? entryName(existing)
    : buildLineName({ client: body.client, owner: body.owner }, directoryNames(numbers));

  const keepChannel = existing && typeof existing === 'object' ? existing.channel || '' : '';
  await setNumber(phone, { ...(typeof existing === 'object' && existing ? existing : {}), name, channel: channel || keepChannel,
    ...(body.provider !== undefined ? { provider: normalizeProvider(body.provider) } : {}) });

  // Zadarma lines are connected through the Zadarma API (SIP URI + receive_sms), never Twilio.
  if (entryProvider({ provider: body.provider !== undefined ? body.provider : (existing && existing.provider) }) === 'zadarma') {
    try {
      const r = await connectZadarmaLine(phone);
      if (r.skipped) {
        return res.json({ ok: true, phone, name, sms: false, voice: false, provider: 'zadarma', external: r.skipped, created: !alreadySaved });
      }
      await logTransaction({ type: 'line-provisioned', to: phone, friendlyName: name, channel, provider: 'zadarma', status: 'success' });
      return res.json({ ok: true, phone, name, sms: r.sms.ok, voice: r.voice, provider: 'zadarma', ...(r.sms.ok ? {} : { smsError: r.sms.error }), created: !alreadySaved });
    } catch (err) {
      console.error(`[lines] Failed to connect Zadarma line ${phone}:`, err.message);
      await logTransaction({ type: 'line-provisioned', to: phone, friendlyName: name, channel, provider: 'zadarma', status: 'error', error: err.message });
      // The directory entry stays saved so a retry (or the App Home) can finish the connection.
      return res.status(502).json({ ok: false, phone, name, provider: 'zadarma', error: err.message });
    }
  }

  const routing = entryRouting(existing);
  if (EXTERNAL_ROUTING.has(routing.toLowerCase())) {
    return res.json({ ok: true, phone, name, sms: false, voice: false, external: routing, created: !alreadySaved });
  }

  try {
    const caps = await connectNumberToWalkieTalkie(phone);
    await logTransaction({ type: 'line-provisioned', to: phone, friendlyName: name, channel, status: 'success' });
    res.json({ ok: true, phone, name, sms: caps.sms, voice: caps.voice, created: !alreadySaved });
  } catch (err) {
    console.error(`[lines] Failed to connect ${phone}:`, err.message);
    await logTransaction({ type: 'line-provisioned', to: phone, friendlyName: name, channel, status: 'error', error: err.message });
    // The directory entry stays saved so a retry (or the App Home) can finish the connection.
    res.status(502).json({ ok: false, phone, name, error: err.message });
  }
}));

router.delete('/:phone', wrap(async (req, res) => {
  const phone = normalizeE164(req.params.phone);
  if (!phone) {
    return res.status(400).json({ ok: false, error: 'phone must be a valid E.164 number' });
  }

  const { numbers } = await loadConfig();
  const existing = numbers[phone];
  if (existing === undefined) {
    return res.json({ ok: true, phone, removed: false });
  }

  await removeNumber(phone);
  await logTransaction({ type: 'line-removed', to: phone, friendlyName: entryName(existing), status: 'success' });
  res.json({ ok: true, phone, name: entryName(existing), removed: true });
}));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Body must be valid JSON' });
  }
  console.error('[lines] Unexpected error:', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

module.exports = router;
