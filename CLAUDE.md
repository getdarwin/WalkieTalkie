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
    voice.js                    # POST /twilio-voice (voice + recording handler)
  middleware/
    twilioValidate.js           # HMAC-SHA1 Twilio signature check (uses req.originalUrl)
    adminAuth.js                # Optional ADMIN_SECRET check for /logs + /capabilities
  bolt/
    app.js                      # Slack Bolt app — App Home, block actions, modals
    views.js                    # Block Kit builders: App Home, all modals
  services/
    numbers.js                  # config/numbers.json CRUD (hot-reload on every request)
    slack.js                    # OTP parsing, Block Kit builder, thread management
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
| `ADMIN_SECRET` | Optional — protects /logs and /capabilities with bearer token auth |
| `PORT` | Server port (default: 3000) |

## HTTP Endpoints
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Uptime check |
| `GET` | `/logs?limit=N&type=sms\|voice-recording` | Optional ADMIN_SECRET | Transaction log |
| `GET` | `/capabilities?type=sms\|voice\|mms\|fax` | Optional ADMIN_SECRET | Twilio capabilities cache |
| `GET` | `/numbers.csv` | None | Full number directory as CSV |
| `POST` | `/twilio-webhook` | Twilio HMAC | Inbound SMS from all Twilio numbers |
| `POST` | `/twilio-voice` | Twilio HMAC | Inbound voice call |
| `POST` | `/twilio-voice/recording` | Twilio HMAC | Recording callback |
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

### Number Directory CSV
- `GET /numbers.csv` exports the full directory with columns:
  `phone_number, friendly_name, channel_id, routing, sms, voice`
- `routing` column: `walkietalkie` (webhooks managed by this app) or `vapi` (hands off)
- Upload via Slack App Home → "Upload CSV" modal (paste CSV text)
- Or use `node scripts/configure-from-csv.js numbers.csv` to also update Twilio webhooks

### App Home (Slack)
- Credentials section — edit Twilio SID + Auth Token
- Default channel section
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

# Health check
curl "http://localhost:3000/health"
```

## Slack App Setup
Required settings in api.slack.com/apps:
- **Event Subscriptions** → `{WEBHOOK_BASE_URL}/slack/events`, subscribe to `app_home_opened`
- **Interactivity & Shortcuts** → `{WEBHOOK_BASE_URL}/slack/events`
- **App Home** → Home Tab enabled
- **Scopes**: `chat:write`, `chat:write.public`, `files:write`
