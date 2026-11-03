// Flujo común de un SMS entrante (Twilio y Zadarma): nombre y canal desde el
// directorio → Slack → log de transacciones. Las dependencias se pueden inyectar
// para probarlo sin Redis ni Slack.

function defaultDeps() {
  const { getFriendlyName, getChannel } = require('./numbers');
  const { sendToSlack, parseOtp } = require('./slack');
  const { logTransaction } = require('./logger');
  const { checkAndCacheCapabilities } = require('./capabilities');
  const { backgroundTask } = require('./background');
  return { getFriendlyName, getChannel, parseOtp, sendToSlack, logTransaction, checkAndCacheCapabilities, background: backgroundTask };
}

/**
 * @param {{ to: string, from: string, body: string, provider?: 'twilio'|'zadarma' }} sms  números en E.164
 * @param {object} [deps]
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}  nunca lanza: el caller siempre responde 200
 */
async function handleInboundSms({ to, from, body, provider = 'twilio' }, deps = defaultDeps()) {
  const bodyPreview = body.length > 0 ? `<${body.length} chars>` : '(empty)';
  console.log(`[${provider}] SMS received  To=${to}  From=${from}  Body=${bodyPreview}`);

  // Fire-and-forget: cache capabilities for any Twilio number not yet in the store.
  // Zadarma lines do not exist in the Twilio account.
  if (provider === 'twilio') deps.background(deps.checkAndCacheCapabilities(to));

  const friendlyName = await deps.getFriendlyName(to);
  const channel = await deps.getChannel(to);
  const otp = deps.parseOtp(body);
  // Twilio log entries keep their historical shape; only other providers are tagged.
  const providerField = provider === 'twilio' ? {} : { provider };

  try {
    await deps.sendToSlack({ channel, friendlyName, toNumber: to, fromNumber: from, body });
    await deps.logTransaction({ to, from, body, friendlyName, channel, otp, status: 'success', ...providerField });
    return { ok: true };
  } catch (err) {
    console.error(`[${provider}] Error processing SMS:`, err);
    await deps.logTransaction({ to, from, body, friendlyName, channel, otp, status: 'error', error: err.message, ...providerField });
    return { ok: false, error: err.message };
  }
}

module.exports = { handleInboundSms };
