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

## Running Locally (for testing and development)

### 1. Install dependencies

```bash
npm install
cp .env.example .env   # fill in all values
```

### 2. Start an ngrok tunnel

```bash
ngrok http 3000
```

Copy the `https://` URL (e.g. `https://abc123.ngrok-free.app`) → set `WEBHOOK_BASE_URL=https://abc123.ngrok-free.app` in `.env`.

> **Nota:** ngrok genera una URL nueva cada vez que se reinicia (en el plan gratuito). Si reinicias ngrok, debes actualizar `WEBHOOK_BASE_URL`, los Request URLs de Slack, y re-correr el script de Twilio.

### 3. Start the server

```bash
npm run dev
```

Verify it's up:
```bash
curl http://localhost:3000/health
# → {"status":"ok","uptime":...}
```

You'll also see in the terminal:
```
[WalkieTalkie] Listening on port 3000
[capabilities] Store is stale or missing — running initial sync
```

### 4. Point Slack at the ngrok URL

In [api.slack.com/apps](https://api.slack.com/apps) → your app:
- **Event Subscriptions** → Request URL: `https://abc123.ngrok-free.app/slack/events` → Save
- **Interactivity & Shortcuts** → Request URL: `https://abc123.ngrok-free.app/slack/events` → Save

Slack verifies the URL immediately — your server must be running when you save.

### 5. (Optional) Point Twilio webhooks manually

For individual numbers you want to test, use the **🔗 Conectar a WalkieTalkie** option in the App Home overflow menu for each line. This is the recommended way.

To configure all numbers at once from the terminal:
```bash
node scripts/configure-twilio.js
```

### 6. Verify everything works

Send an SMS to any configured number. You should see:
1. A `[twilio] Received SMS` line in your terminal
2. A new thread in your Slack default channel

Check logs:
```bash
curl http://localhost:3000/logs | jq '.slice(0,3)'
```

---

## Deploying to a Server (Production)

Any Node.js host works: Railway, Render, Fly.io, a VPS, etc.

**Requirements:**
- Node.js 18+
- Persistent storage for the `data/` directory (threads, logs, capabilities, settings)
- A fixed public HTTPS URL (not a dynamic ngrok URL)

### Example: Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Set all environment variables in the Railway dashboard under **Variables**:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxx
WEBHOOK_BASE_URL=https://your-app.up.railway.app
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_DEFAULT_CHANNEL=CXXXXXXXX
GROQ_API_KEY=...          # optional, for transcription
ADMIN_SECRET=...          # optional, protects /logs and /capabilities
```

**After deploying:**
1. Copy your production URL (e.g. `https://walkietalkie.up.railway.app`)
2. Update both Slack Request URLs to `https://your-domain/slack/events`
3. In the WalkieTalkie App Home in Slack, click **🔄 Sync Twilio Numbers** — this syncs capabilities and auto-imports numbers already connected

### Changing WEBHOOK_BASE_URL (e.g. switching from ngrok to production)

When your public URL changes you must update three things:

1. **Environment variable** — set `WEBHOOK_BASE_URL` to the new URL, restart the server
2. **Slack** — update Event Subscriptions and Interactivity URLs in the Slack App settings
3. **Twilio webhooks** — either use the Connect button per number in App Home, or re-run the script:
   ```bash
   node scripts/configure-twilio.js
   ```

---

## User Guide — Using WalkieTalkie from Slack

> For users who only have access to Slack — no terminal, no code.

### Opening the App Home

1. In Slack, click **Apps** in the left sidebar (or search for `WalkieTalkie`)
2. Click the **Home** tab — this is your control panel

### Receiving SMS and calls

Nothing to configure once the server is running. When someone sends an SMS to a Twilio number:
- A thread appears in the assigned Slack channel (or the default channel)
- OTP codes (4–8 digit numbers) are **broadcast to the channel** so they're visible without clicking the thread
- Voice calls show a 📞 message with the MP3 attached and a transcript below it

### What you see in the number list

Each line in the directory shows:
- **Name** and phone number
- → Channel it posts to
- Capability badges: `SMS`, `VOICE`
- Connection badge: 🟢 webhooks point to this server · 🔴 not connected · no badge = not scanned yet or external routing

The list shows the 10 most recently added lines. Use **⬇️ Download CSV** to see all.

### Managing lines from App Home

**Add a new line:**
1. Click **➕ Add Line**
2. Enter the phone number in any format: `+52 999 489 0783`, `529994890783`, `(1) 800 555 1234`
3. Enter a friendly name (optional but recommended — shown in Slack threads)
4. Select a Slack channel override (optional — leave blank to use the default)
5. Leave **Conectar a WalkieTalkie** checked to immediately point the Twilio webhooks at this server
6. Click **Save** — a banner at the top of App Home confirms the result

**Connect any line (including those not visible in the list):**
- Click **🔗 Connect** in the directory bar
- Enter the phone number in any format
- Click **Conectar** — the Twilio webhooks are updated immediately
- Works for any number in your Twilio account, even if it uses a TwiML App (Talkyto, etc.)

**Connect a visible line:**
- Click the `⋮` overflow menu on any line → **🔗 Conectar a WalkieTalkie**

**Edit or remove a line:**
- Click `⋮` → **✏️ Edit** (or **ℹ️ Info** for externally-routed numbers) or **🗑 Remove**

**Sync with Twilio:**
- Click **🔄 Sync Twilio Numbers** — the button shows "Sincronizando..." while running, then "✅ Sync completo"
- Refreshes SMS/Voice/MMS capabilities and updates the 🟢/🔴 connection badges
- Numbers whose webhooks already point to this server are automatically added to the directory

**View recent activity:**
- Click **📋 Activity Log** to see the last 20 SMS and voice transactions
- Each entry shows: icon, friendly name, phone number, time, OTP (if any), message body or transcript

**Update Twilio credentials:**
- Click **✏️ Edit** next to *Twilio Credentials* → enter Account SID and Auth Token → Save
- No server restart needed — credentials update immediately

**Change the default channel:**
- Click **✏️ Edit** next to *Default Channel* → pick a channel → Save

### Bulk managing lines via CSV

1. Click **⬇️ Download CSV** to get the full directory
2. Open in Excel, Google Sheets, or Numbers
3. Edit `friendly_name`, `channel_id`, `routing` columns
4. Export as CSV
5. Click **⬆️ Upload CSV** → paste the CSV content → click **Apply**
6. A confirmation modal shows a preview of the first 5 rows and warns that the current directory will be replaced — click **Reemplazar directorio** to confirm

> Numbers with `routing=vapi`, `routing=talkyto`, or `routing=pipecat` are saved to the directory but their Twilio webhook URLs are never touched.

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
