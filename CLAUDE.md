# WalkieTalkie

Node.js/Express service that receives SMS messages and voice calls from 370 Twilio phone lines and forwards them to Slack. Slack is the entire UI — no web front-end. Primary use case is receiving SMS/voice OTP verification codes across many lines simultaneously.

## Stack
- **Runtime**: Node.js 18+
- **Framework**: Express 4
- **Twilio SDK**: `twilio` (request validation, TwiML, REST API)
- **Slack SDK**: `@slack/web-api` (Web API, not Incoming Webhooks — required for threading)
- **Scheduler**: `node-cron` (periodic capability re-sync)

## Project Structure
```
src/
  index.js                      # Entry point, env validation, all HTTP routes
  routes/twilio.js              # POST /twilio-webhook (SMS handler)
  middleware/twilioValidate.js  # HMAC-SHA1 Twilio signature check
  services/
    numbers.js                  # config/numbers.json lookup (friendly name + channel)
    slack.js                    # OTP parsing, Block Kit builder, thread management
    logger.js                   # Appends to data/logs.json
    capabilities.js             # Twilio capability sync, cron scheduler, cache
config/
  numbers.json                  # Number directory — edit without restart (hot-reload)
data/                           # Auto-generated, gitignored
  threads.json                  # Persists Slack thread_ts across restarts
  logs.json                     # Transaction log (last 1000 entries)
  capabilities.json             # Per-number Twilio capabilities cache
scripts/
  configure-twilio.js           # One-time + re-run: sets webhook URLs on all numbers,
                                # seeds data/capabilities.json
```

## Environment Variables (.env)
| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token (used for signature validation + API calls) |
| `WEBHOOK_BASE_URL` | Public URL of this server, no trailing slash (ngrok or production domain) |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_DEFAULT_CHANNEL` | Slack channel ID for numbers with no override |
| `PORT` | Server port (default: 3000) |

## HTTP Endpoints
| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Uptime check |
| `GET` | `/logs?limit=N` | Transaction log (default 50, max 1000) |
| `GET` | `/capabilities?type=sms\|voice\|mms\|fax` | Twilio capabilities cache |
| `POST` | `/twilio-webhook` | Inbound SMS from all Twilio numbers |

## Key Behaviors

### SMS Handling
- All 370 Twilio numbers point to `POST /twilio-webhook`
- Requests without a valid Twilio HMAC-SHA1 signature are rejected with 403
- `config/numbers.json` is read on every request — edits are live with no restart needed
- OTPs (4–8 digit codes) are auto-detected; `reply_broadcast: true` broadcasts them to the channel so codes are visible without opening the thread
- Numbers not in `config/numbers.json` fall back to raw E.164 display and `SLACK_DEFAULT_CHANNEL`

### Slack Threading
- Threads are keyed by `channel:toNumber:YYYY-MM-DD` — one thread per line per day
- Thread `ts` values are persisted in `data/threads.json` so threads survive server restarts

### Capability Tracking
- Every number's capabilities (`sms`, `voice`, `mms`, `fax`) are fetched directly from the Twilio API — no assumptions based on country code
- `data/capabilities.json` is the local cache; seeded by `scripts/configure-twilio.js`
- On server startup, if the cache is missing or older than 14 days, a full re-sync runs automatically in the background
- A cron job (`node-cron`) re-syncs on the 1st and 15th of each month at 3 AM
- When an SMS arrives for a number not yet in the cache, its capabilities are fetched and cached automatically (fire-and-forget, no impact on response time)

### Number Mapping (`config/numbers.json`)
Two supported formats:
```json
"+12025550101": "Marketing Line 1"
"+12025550103": { "name": "Sales West", "channel": "C0SALES001" }
```

## Scripts
```bash
# Initial setup / re-run to update webhook URLs and reseed capabilities
node scripts/configure-twilio.js
```
Sets `smsUrl` on SMS-capable numbers and `voiceUrl` on voice-capable numbers, then writes `data/capabilities.json`.

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
curl http://localhost:3000/logs | jq

# Check capability counts
curl http://localhost:3000/capabilities?type=sms | jq '.count'
curl http://localhost:3000/capabilities?type=voice | jq '.count'
```
