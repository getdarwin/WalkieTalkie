# WalkieTalkie

Receive SMS messages and voice calls from your Twilio phone lines directly in Slack — with threading, OTP detection, voice recordings, and transcription. Manage hundreds of lines from a Slack App Home tab.

```
Twilio SMS/Call → WalkieTalkie → Slack thread
```

---

## What It Does

- **SMS relay** — every inbound SMS posts to a Slack thread, one thread per line per day
- **OTP detection** — 4–8 digit codes are highlighted and broadcast to the channel so they're visible without opening the thread
- **Voice calls** — records the call silently, uploads the MP3 to Slack, and transcribes it with Groq Whisper (Spanish, Portuguese, English)
- **Capability scanning** — checks each number's SMS/Voice/MMS/Fax capabilities directly from the Twilio API, no assumptions by country
- **Admin UI** — configure everything from Slack's App Home tab: credentials, channels, number directory
- **CSV bulk management** — download the full number list as CSV, edit in any spreadsheet, upload back

---

## Architecture

```
                  ┌─────────────────────────────┐
                  │         Twilio               │
                  │  370 phone numbers           │
                  └────────┬────────────────────-┘
                           │ HTTPS webhook (POST)
                           ▼
              ┌────────────────────────┐
              │      WalkieTalkie      │  Node.js + Express + Bolt
              │                        │
              │  /twilio-webhook  SMS  │
              │  /twilio-voice  Calls  │
              │  /slack/events  Slack  │
              └────────┬───────────────┘
                       │ Slack Web API
                       ▼
              ┌────────────────────────┐
              │         Slack          │
              │  Threads per line/day  │
              │  App Home admin UI     │
              └────────────────────────┘
```

---

## Prerequisites

- **Node.js 18+**
- **A Twilio account** with phone numbers ([twilio.com](https://twilio.com))
- **A Slack workspace** where you can create an app
- **ngrok** (for local development) or a server with a public URL (for production)
- Optional: **Groq API key** for voice transcription ([console.groq.com](https://console.groq.com))

---

## Installation

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd WalkieTalkie
npm install
```

### 2. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it `WalkieTalkie` and pick your workspace

**OAuth & Permissions** → add these Bot Token Scopes:
| Scope | Purpose |
|---|---|
| `chat:write` | Post messages and threads |
| `chat:write.public` | Post to channels the bot hasn't joined |
| `files:write` | Upload voice recording MP3s |

**Event Subscriptions** → Enable Events, then set **Request URL** to:
```
https://<your-domain>/slack/events
```
Subscribe to bot event: `app_home_opened`

**Interactivity & Shortcuts** → Enable, set **Request URL** to:
```
https://<your-domain>/slack/events
```

**App Home** → enable the **Home Tab**

**Install App** → Install to workspace → copy the **Bot User OAuth Token** (`xoxb-...`)

Back on **Basic Information** → copy the **Signing Secret**

### 3. Set up your environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Where to find it |
|---|---|
| `TWILIO_ACCOUNT_SID` | [console.twilio.com](https://console.twilio.com) → Account Info |
| `TWILIO_AUTH_TOKEN` | Same page |
| `WEBHOOK_BASE_URL` | Your public URL, no trailing slash |
| `SLACK_BOT_TOKEN` | Slack App → OAuth & Permissions |
| `SLACK_SIGNING_SECRET` | Slack App → Basic Information |
| `SLACK_DEFAULT_CHANNEL` | Right-click a Slack channel → Copy Channel ID (starts with `C`) |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) — optional, enables transcription |
| `ADMIN_SECRET` | Any secret string — protects `/logs` and `/capabilities` endpoints (optional) |
| `PORT` | Default: `3000` |

---

## Running Locally (with ngrok)

### 1. Start ngrok

```bash
ngrok http 3000
```

Copy the `https://` URL (e.g. `https://abc123.ngrok-free.app`) → set it as `WEBHOOK_BASE_URL` in `.env`

### 2. Start the server

```bash
npm run dev
```

You'll see:
```
[WalkieTalkie] Listening on port 3000
[WalkieTalkie] Webhook URL: https://abc123.ngrok-free.app/twilio-webhook
[WalkieTalkie] Slack Events: https://abc123.ngrok-free.app/slack/events
```

### 3. Update Slack app URLs

In your Slack App settings, update both:
- Event Subscriptions Request URL → `https://abc123.ngrok-free.app/slack/events`
- Interactivity Request URL → `https://abc123.ngrok-free.app/slack/events`

Slack will verify the URL immediately — the server must be running.

### 4. Configure Twilio webhooks

```bash
node scripts/configure-twilio.js
```

This sets `smsUrl` and `voiceUrl` on every number in your account, skipping any that use VAPI/Talkyto.

---

## Deploying to Production

Any Node.js host works: Railway, Render, Fly.io, a VPS, etc.

**Key requirements:**
- Node.js 18+
- Persistent storage for the `data/` directory (threads, logs, capabilities, settings)
- A fixed public HTTPS URL

### Example: Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

railway login
railway init
railway up
```

Set all environment variables in the Railway dashboard under **Variables**.

**After deploying:**
1. Copy your production URL (e.g. `https://walkietalkie.up.railway.app`)
2. Set `WEBHOOK_BASE_URL` to that URL in Railway variables
3. Update both Slack Request URLs to `https://your-domain/slack/events`
4. Re-run `node scripts/configure-twilio.js` with the production URL to update Twilio webhooks

### Changing WEBHOOK_BASE_URL (e.g. switching from ngrok to production)

When your public URL changes you must update two things:

1. **`.env`** — set `WEBHOOK_BASE_URL` to the new URL, restart the server
2. **Twilio webhooks** — re-run the configure script:
   ```bash
   node scripts/configure-twilio.js
   ```
   This updates `smsUrl` and `voiceUrl` on all numbers to point to the new domain.
3. **Slack** — update Event Subscriptions and Interactivity URLs in the Slack App settings.

---

## Configuring Number Lines

### Option A: Slack App Home (recommended)

Open the WalkieTalkie app in Slack → **Home** tab.

- **Download CSV** — get the full directory as a spreadsheet
- Edit names, channels, and routing in any spreadsheet app
- **Upload CSV** — paste the CSV contents back to apply changes

CSV columns:
| Column | Description |
|---|---|
| `phone_number` | E.164 format, e.g. `+15103137237` |
| `friendly_name` | Label shown in Slack thread headers |
| `channel_id` | Slack channel ID for this line (leave blank for default) |
| `routing` | `walkietalkie` or `vapi` — controls whether Twilio webhooks are configured |
| `sms` | `yes`/`no` — informational, from capability scan |
| `voice` | `yes`/`no` — informational, from capability scan |

Setting `routing=vapi` for a line saves it to the directory but leaves its Twilio webhook URLs untouched.

### Option B: CSV bulk script

```bash
# Download current directory, edit, re-apply:
curl http://localhost:3000/numbers.csv -o numbers.csv
# ... edit in spreadsheet ...
node scripts/configure-from-csv.js numbers.csv
```

This also updates Twilio webhook URLs per number.

### Option C: Edit `config/numbers.json` directly

Changes take effect immediately — no restart needed.

```json
{
  "numbers": {
    "+15103137237": "Marketing Line 1",
    "+15103137238": { "name": "Sales West", "channel": "C0SALES001" },
    "+15103137239": { "name": "VAPI Line", "routing": "vapi" }
  }
}
```

---

## Slack App Permissions Summary

| Permission | Required for |
|---|---|
| `chat:write` | Posting messages to channels |
| `chat:write.public` | Posting to channels without joining them |
| `files:write` | Uploading voice recording MP3s |

Events: `app_home_opened`

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Uptime check |
| `GET` | `/logs` | Optional `ADMIN_SECRET` | Transaction log |
| `GET` | `/capabilities` | Optional `ADMIN_SECRET` | Twilio capability cache |
| `GET` | `/numbers.csv` | None | Number directory as CSV |
| `POST` | `/twilio-webhook` | Twilio HMAC | Inbound SMS |
| `POST` | `/twilio-voice` | Twilio HMAC | Inbound voice call |
| `POST` | `/slack/events` | Slack signing secret | Slack events + interactions |

For protected endpoints, pass the secret as:
- Query param: `?secret=<ADMIN_SECRET>`
- Header: `Authorization: Bearer <ADMIN_SECRET>`

---

## Limitations

- **Single-process only** — JSON file writes are not safe across multiple server instances. Run one instance.
- **No web UI** — Slack is the only interface by design.
- **Recording retention** — Twilio deletes recordings after 30 days by default. The MP3 is uploaded to Slack immediately after the call, so Slack becomes the archive.

---

## License

MIT
