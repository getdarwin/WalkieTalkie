# WalkieTalkie

Node.js/Express service that receives SMS messages and voice calls from ~370 Twilio phone lines and forwards them to Slack. Slack is the entire UI — no web front-end. Primary use case is receiving SMS/voice OTP verification codes across many lines simultaneously.

## Stack
- **Runtime**: Node.js 18+
- **Framework**: Express 4 (mounted on Bolt's ExpressReceiver)
- **Twilio SDK**: `twilio` (request validation, TwiML, REST API)
- **Slack SDK**: `@slack/bolt` (App Home, block actions, modals) + `@slack/web-api` (threading)
- **Scheduler**: `node-cron` (periodic capability re-sync)
- **Transcription**: `groq-sdk` with `whisper-large-v3-turbo` (optional, multilingual)

## Project Structure
```
src/
  index.js                      # Entry point, env validation, HTTP routes, CSV export
  routes/
    twilio.js                   # POST /twilio-webhook (SMS handler)
    voice.js                    # POST /twilio-voice (voice, live IVR keypress + recording handler)
  middleware/
    twilioValidate.js           # HMAC-SHA1 Twilio signature check (uses req.originalUrl)
    adminAuth.js                # Optional ADMIN_SECRET check for /logs, /capabilities + /numbers.csv
  bolt/
    app.js                      # Slack Bolt app — App Home, block actions, modals
    views.js                    # Block Kit builders: App Home, all modals
  services/
    numbers.js                  # config/numbers.json CRUD (hot-reload on every request)
    slack.js                    # OTP parsing, Block Kit builder, thread management
    ivrKeypress.js              # Detects "press <key>" (EN/ES/PT) in live IVR transcripts
    logger.js                   # Appends to data/logs.json (last 1000 entries)
    capabilities.js             # Twilio capability sync, cron scheduler, cache
    settings.js                 # data/settings.json with env var fallbacks
    callThreads.js              # data/call-threads.json — maps CallSid → Slack thread
config/
  numbers.json                  # Number directory — edit without restart (hot-reload)
data/                           # Auto-generated, gitignored
  threads.json                  # Persists Slack thread_ts across restarts
  logs.json                     # Transaction log (last 1000 entries)
  capabilities.json             # Per-number Twilio capabilities cache
  settings.json                 # UI-managed settings (Twilio credentials, default channel)
  call-threads.json             # Active call → Slack thread mapping (max 500)
scripts/
  configure-twilio.js           # One-time + re-run: sets webhook URLs on all numbers
  configure-from-csv.js         # Bulk-configure from CSV; handles routing column
```

## Environment Variables (.env)
| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token (used for signature validation + API calls) |
| `WEBHOOK_BASE_URL` | Public URL of this server, no trailing slash (ngrok or production domain) |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret (Basic Information page) |
| `SLACK_DEFAULT_CHANNEL` | Slack channel ID for numbers with no override |
| `GROQ_API_KEY` | Optional — enables Groq Whisper transcription |
| `ADMIN_SECRET` | Optional — protects /logs, /capabilities and /numbers.csv with bearer token auth |
| `PORT` | Server port (default: 3000) |

## HTTP Endpoints
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Uptime check |
| `GET` | `/logs?limit=N&type=sms\|voice-recording` | Optional ADMIN_SECRET | Transaction log |
| `GET` | `/capabilities?type=sms\|voice\|mms\|fax` | Optional ADMIN_SECRET | Twilio capabilities cache |
| `GET` | `/numbers.csv` | Optional ADMIN_SECRET | Full number directory as CSV |
| `POST` | `/twilio-webhook` | Twilio HMAC | Inbound SMS from all Twilio numbers |
| `POST` | `/twilio-voice` | Twilio HMAC | Inbound voice call |
| `POST` | `/twilio-voice/recording` | Twilio HMAC | Recording callback |
| `POST` | `/twilio-voice/ended` | Twilio HMAC | `<Record>` action callback (resolves silent calls) |
| `POST` | `/twilio-voice/transcription` | Twilio HMAC | Real-Time Transcription callback (live IVR keypress) |
| `POST` | `/slack/events` | Slack signing secret | Bolt events + interactions |

## Key Behaviors

### SMS Handling
- All Twilio numbers point to `POST /twilio-webhook`
- Requests without a valid Twilio HMAC-SHA1 signature are rejected with 403
- `config/numbers.json` is read on every request — edits are live with no restart needed
- OTPs (4–8 digit codes) are auto-detected; `reply_broadcast: true` broadcasts them to the channel
- Numbers not in `config/numbers.json` fall back to raw E.164 display and `SLACK_DEFAULT_CHANNEL`

### Voice Handling
- Incoming call → Slack thread notification + silent TwiML `<Record>`
- On recording callback: download MP3 from Twilio (30s timeout), upload to Slack, transcribe via Groq
- Transcription is multilingual (Spanish, Portuguese, English)
- Call threads keyed by `channel:toNumber:YYYY-MM-DD` — one thread per line per day

### Live IVR keypress (Meta WhatsApp verification)
Meta's verification IVR gates the call behind an anti-bot keypress and **the digit changes
on every call** (`0`, `1`, `8`, `9` all seen in production). A fixed per-line DTMF was a
lottery, so calls are now handled like this:

1. `POST /twilio-voice` answers with `<Start><Transcription>` (Deepgram `nova-3`,
   `languageCode="multi"` → auto language detection, inbound track only, partial results)
   followed immediately by `<Record>` — audio is captured from second zero.
2. Twilio streams transcript fragments to `POST /twilio-voice/transcription`.
   `detectKeypress()` (`services/ivrKeypress.js`) looks for an instruction verb followed
   by a key — "press 9", "presione el 0", "aperte a tecla oito", "press pound" — in EN/ES/PT.
   Spoken codes ("your code is 1 6 9 4 2 9") never match because no verb precedes them.
3. On the first match, a one-shot Redis lock (`ivrpress:<CallSid>`, SET NX) guarantees a
   single press, then the live call is redirected via REST (`calls(sid).update({ twiml })`)
   to `<Play digits="w<key>"/>` + a fresh `<Record>`. The thread gets a
   "🔢 IVR asked for key N — pressed automatically" note and a `voice-keypress` log entry.
4. The redirect cuts the first `<Record>` short; its `action` callback is ignored when the
   call record has `keypress` set, so no false "No audio was recorded" notice is posted.
   Both recording segments are uploaded and transcribed as usual.
5. Final live-transcript segments are kept in `ivrlog:<CallSid>` (24h TTL) and attached to
   the `voice-recording` log entry as `liveTranscript` for debugging.

**Keypress modes.** Behaviour is driven by a per-line `keypressMode` with a workspace
default (`ivr.keypressMode` setting, default `auto`), resolved by `resolveKeypressMode()`:
- `auto` (default) — the live-detection flow above.
- `fixed` — legacy behaviour: `<Pause 3s>` + `<Play digits>` of the line's `dtmf` + `<Record>`.
  Only for IVRs with a stable menu. A `fixed` line without valid digits degrades to `none`.
- `none` — just `<Record>`.
Lines with no explicit mode inherit the global default, so legacy entries that still carry a
`dtmf` value run in `auto` unless someone picks `fixed`. In `auto`, when a call ends without
any instruction detected the thread gets "🎧 IVR did not ask for any key. Heard live: …".

App Home: a global "Tecla del IVR" section with ✏️ Edit (auto/none), a "Modo de tecla" select in
the line modal (inherit/auto/fixed/none + digits field, validated), and a per-line badge
(`🎧 Auto` / `🔢 Fijo: ww1` / `🚫 Sin tecla`, with `(default)` when inherited).
Tests: `npm test` (`tests/ivrKeypress.test.js`, `tests/keypressMode.test.js`).

### ⚠️ Still known-broken
**`getLanguage()` forces the wrong language into Whisper.** The IVR's language does not
correlate with the line's country — a US line speaks Spanish, AR lines speak English. A
forced mismatch yields garbage like `"Seu código de verificación es"`. Let Whisper auto-detect.

`parseOtp()` returns the first `\d{4,8}` it finds, which produces false positives
(a Brazilian radio ad yielded `2016`; a scam call impersonating a bank yielded `1520`) and
truncates real codes (`9429` instead of `169429`).

Full evidence, call volumes and the testing plan live in the project memory file
`meta_ivr_keypress.md`.

### Slack Threading
- Threads are keyed by `channel:toNumber:YYYY-MM-DD` — one thread per line per day
- Thread `ts` values are persisted in `data/threads.json` so threads survive server restarts

### Capability Tracking
- Every number's capabilities (`sms`, `voice`, `mms`, `fax`) are fetched from the Twilio API
- On startup: if cache is missing or older than 14 days, a full sync runs in the background
- Cron: re-syncs on 1st and 15th of each month at 3 AM
- On SMS/call for uncached number: capabilities fetched fire-and-forget

### VAPI / Talkyto Protection
- `configure-twilio.js` and `configure-from-csv.js` detect VAPI by checking voiceUrl/smsUrl
- Numbers with `routing: "vapi"` in numbers.json or in CSV are saved to the directory but
  their Twilio webhook URLs are never touched

### Settings Hierarchy
- `data/settings.json` takes precedence over `.env` for: Twilio credentials + default channel
- Allows updating credentials from the Slack App Home without restarting the server
- All credential reads use `getSetting()` — including webhook signature validation (`twilioValidate.js`)
  and recording downloads (`voice.js`) — so Slack App Home changes take effect immediately
- **Railway note**: `data/` is ephemeral on Railway (reset on each deploy). For persistent credential
  updates on Railway, set env vars in the Railway dashboard. A mounted Volume on `/app/data` would
  make Slack App Home updates persist across deploys.

### Number Directory CSV
- `GET /numbers.csv` exports the full directory with columns:
  `phone_number, friendly_name, channel_id, routing, sms, voice, keypress_mode, dtmf, language`
- `keypress_mode`: `auto` | `fixed` | `none`, blank = inherit the global default. `dtmf` and
  `language` round-trip through upload (they used to be dropped on CSV replace).
- `routing` column: `walkietalkie` (webhooks managed by this app) or `vapi` (hands off)
- Upload via Slack App Home → "Upload CSV" modal (paste CSV text)
- Or use `node scripts/configure-from-csv.js numbers.csv` to also update Twilio webhooks

### App Home (Slack)
- Credentials section — edit Twilio SID + Auth Token
- Default channel section
- IVR keypress section — global default mode (auto/none); per-line override in the line modal
- Sync button — triggers immediate capability re-sync; shows last-synced timestamp
- Number directory — shows first 10 lines with capabilities + VAPI badge; Download/Upload CSV buttons

## Number Mapping (`config/numbers.json`)
Three supported formats:
```json
"+12025550101": "Marketing Line 1"
"+12025550103": { "name": "Sales West", "channel": "C0SALES001" }
"+12025550105": { "name": "VAPI Line", "routing": "vapi" }
```

## Scripts
```bash
# Initial setup / re-run to update webhook URLs and reseed capabilities
node scripts/configure-twilio.js

# Bulk-configure from CSV (also updates Twilio webhooks)
node scripts/configure-from-csv.js path/to/numbers.csv
```

## Dev Commands
```bash
npm install
cp .env.example .env   # fill in all values
npm run dev            # nodemon hot-reload
npm start              # production

# Local tunnel (required for Twilio to reach localhost)
ngrok http 3000        # copy HTTPS URL → WEBHOOK_BASE_URL in .env
```

## Testing
```bash
# Check transaction log
curl "http://localhost:3000/logs" | jq
curl "http://localhost:3000/logs?secret=<ADMIN_SECRET>" | jq   # if ADMIN_SECRET set

# Check capability counts
curl "http://localhost:3000/capabilities?type=sms" | jq '.count'

# Download number directory
curl "http://localhost:3000/numbers.csv"
curl "http://localhost:3000/numbers.csv?secret=<ADMIN_SECRET>"  # if ADMIN_SECRET set

# Health check
curl "http://localhost:3000/health"
```

## Slack App Setup
Required settings in api.slack.com/apps:
- **Event Subscriptions** → `{WEBHOOK_BASE_URL}/slack/events`, subscribe to `app_home_opened`
- **Interactivity & Shortcuts** → `{WEBHOOK_BASE_URL}/slack/events`
- **App Home** → Home Tab enabled
- **Scopes**: `chat:write`, `chat:write.public`, `files:write`
