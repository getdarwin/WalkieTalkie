const express = require('express');
const twilioValidate = require('../middleware/twilioValidate');
const { handleInboundSms } = require('../services/inboundSms');

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

  // Always 200 with empty TwiML (no auto-reply). An error is ours, not Twilio's,
  // so it must not retry — handleInboundSms already logged it.
  await handleInboundSms({ to: To, from: From, body: Body, provider: 'twilio' });
  res.type('text/xml').send('<Response></Response>');
});

module.exports = router;
