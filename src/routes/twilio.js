const express = require('express');
const twilioValidate = require('../middleware/twilioValidate');
const { getFriendlyName, getChannel } = require('../services/numbers');
const { sendToSlack } = require('../services/slack');
const { logTransaction } = require('../services/logger');
const { parseOtp } = require('../services/slack');
const { checkAndCacheCapabilities } = require('../services/capabilities');

const router = express.Router();

/**
 * POST /twilio-webhook
 *
 * Single endpoint for all 100+ Twilio numbers. Configure every number in the
 * Twilio console to POST to: <WEBHOOK_BASE_URL>/twilio-webhook
 *
 * Twilio sends application/x-www-form-urlencoded with (at minimum):
 *   From  — sender's E.164 number
 *   To    — your Twilio number that received the SMS
 *   Body  — the SMS text
 */
router.post('/', twilioValidate, async (req, res) => {
  const { From, To, Body } = req.body;

  if (!From || !To || Body === undefined) {
    console.warn('[twilio] Malformed payload — missing From/To/Body');
    return res.status(400).type('text').send('Bad Request');
  }

  console.log(`[twilio] SMS received  To=${To}  From=${From}  Body="${Body}"`);

  // Fire-and-forget: cache capabilities for any number not yet in the store
  checkAndCacheCapabilities(To).catch(() => {});

  const friendlyName = getFriendlyName(To);
  const channel = getChannel(To);
  const otp = parseOtp(Body);

  try {
    await sendToSlack({ channel, friendlyName, toNumber: To, fromNumber: From, body: Body });

    logTransaction({ to: To, from: From, body: Body, friendlyName, channel, otp, status: 'success' });

    // Respond with empty TwiML — no auto-reply to sender
    res.type('text/xml').send('<Response></Response>');
  } catch (err) {
    console.error('[twilio] Error processing webhook:', err);
    logTransaction({ to: To, from: From, body: Body, friendlyName, channel, otp, status: 'error', error: err.message });
    // Still return 200 so Twilio does not retry — the error is ours, not Twilio's
    res.type('text/xml').send('<Response></Response>');
  }
});

module.exports = router;
