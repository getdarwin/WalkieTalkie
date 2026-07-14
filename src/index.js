require('dotenv').config();

// ─── Startup validation ───────────────────────────────────────────────────────

const REQUIRED_ENV = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'WEBHOOK_BASE_URL',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_DEFAULT_CHANNEL',
];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error('[startup] Missing required environment variables:', missing.join(', '));
  console.error('[startup] Copy .env.example to .env and fill in all values.');
  process.exit(1);
}

// ─── Start (local / long-lived server mode) ───────────────────────────────────
// On Vercel this file is not used — api/index.js exports the app instead.

const { boltApp } = require('./app');
const { syncIfStale } = require('./services/capabilities');

const PORT = process.env.PORT || 3000;
boltApp.start(PORT).then(() => {
  console.log(`[WalkieTalkie] Listening on port ${PORT}`);
  console.log(`[WalkieTalkie] Webhook URL: ${process.env.WEBHOOK_BASE_URL}/twilio-webhook`);
  console.log(`[WalkieTalkie] Slack Events: ${process.env.WEBHOOK_BASE_URL}/slack/events`);
  syncIfStale().catch((err) => console.error('[capabilities] Initial sync error:', err.message));
});
