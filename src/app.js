const { receiver, boltApp } = require('./bolt/app');
const twilioRouter = require('./routes/twilio');
const voiceRouter = require('./routes/voice');
const { loadLogs } = require('./services/logger');
const { getCapabilities, syncIfStale, syncAllCapabilities } = require('./services/capabilities');
const { loadConfig } = require('./services/numbers');
const adminAuth = require('./middleware/adminAuth');

// ─── Mount routes on Bolt's Express receiver ──────────────────────────────────
// This module builds the Express app without starting a listener, so it works
// both locally (src/index.js calls boltApp.start) and on Vercel (api/index.js
// exports the app as a serverless handler).

const app = receiver.app;

// Twilio sends webhooks as application/x-www-form-urlencoded
app.use(require('express').urlencoded({ extended: false }));

// Health check (no auth required)
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Transaction log viewer (optional auth)
// ?limit=N   — max entries to return (default 50, max 1000)
// ?type=sms|voice-recording|voice-transcription
app.get('/logs', adminAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 1000);
  const { type } = req.query;
  const validTypes = ['sms', 'voice-recording', 'voice-transcription'];

  let logs = await loadLogs();
  if (type && validTypes.includes(type)) {
    logs = logs.filter((entry) => entry.type === type);
  }
  logs = logs.slice(0, limit);
  res.json({ count: logs.length, logs });
});

// Capabilities viewer (optional auth)
// ?type=sms|voice|mms|fax
app.get('/capabilities', adminAuth, async (req, res) => {
  const store = await getCapabilities();
  const { type } = req.query;
  const validTypes = ['sms', 'voice', 'mms', 'fax'];

  if (type && validTypes.includes(type)) {
    const filtered = Object.fromEntries(
      Object.entries(store.numbers).filter(([, v]) => v.capabilities[type] === true)
    );
    return res.json({ lastSyncedAt: store.lastSyncedAt, count: Object.keys(filtered).length, numbers: filtered });
  }

  res.json({ lastSyncedAt: store.lastSyncedAt, count: Object.keys(store.numbers).length, numbers: store.numbers });
});

// Number directory CSV export — used by the "Download CSV" button in Slack App Home
// Columns: phone_number, friendly_name, channel_id, routing, sms, voice
//   routing: "walkietalkie" or "vapi" (detected from Twilio voiceUrl/smsUrl in capabilities cache)
//   sms/voice: yes/no from capabilities cache (blank if not yet scanned)
app.get('/numbers.csv', adminAuth, async (req, res) => {
  const { numbers } = await loadConfig();
  const caps = (await getCapabilities()).numbers;
  const rows = ['phone_number,friendly_name,channel_id,routing,sms,voice'];

  for (const [phone, entry] of Object.entries(numbers)) {
    const name = typeof entry === 'string' ? entry : (entry.name || '');
    const channel = typeof entry === 'object' ? (entry.channel || '') : '';
    const cap = caps[phone];
    const sms = cap ? (cap.capabilities.sms ? 'yes' : 'no') : '';
    const voice = cap ? (cap.capabilities.voice ? 'yes' : 'no') : '';

    // Routing comes from the directory entry when the user sets it; otherwise
    // derive from capability-cache presence (VAPI numbers are skipped by sync).
    const routing = (entry && typeof entry === 'object' && entry.routing)
      ? entry.routing
      : (cap ? 'walkietalkie' : 'unknown');

    const safeName = name.includes(',') ? `"${name}"` : name;
    rows.push(`${phone},${safeName},${channel},${routing},${sms},${voice}`);
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="walkie-talkie-numbers.csv"');
  res.send(rows.join('\n'));
});

// Capability re-sync — triggered by Vercel Cron (vercel.json → crons).
// Vercel sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set.
app.get('/cron/sync-capabilities', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (header !== cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const result = req.query.force === '1' ? await syncAllCapabilities() : await syncIfStale();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron] Capability sync failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Twilio webhooks
app.use('/twilio-webhook', twilioRouter);
app.use('/twilio-voice', voiceRouter);

module.exports = { app, boltApp };
