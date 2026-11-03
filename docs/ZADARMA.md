# Zadarma en WalkieTalkie: contexto técnico

> Este archivo es contexto para Claude Code. Se guarda en el repo como `docs/ZADARMA.md`.
> Lo investigado proviene de la doc oficial de Zadarma, su guía de Twilio y sus SDKs oficiales
> (`zadarma/user-api-v1` en PHP y `zadarma/user-api-typescript`), consultados el 2026-11-03.
> Lo marcado **[NO CONFIRMADO]** hay que comprobarlo con una llamada o un SMS reales.

---

## 1. Conclusión: un modelo híbrido

| Canal | Ruta recomendada | Por qué |
|---|---|---|
| **Voz** | Número Zadarma → **External Server (SIP URI)** → **Twilio SIP Domain** → `/twilio-voice` (el flujo que ya existe) | La API de Zadarma **no permite** transcribir en vivo, presionar DTMF a mitad de una llamada (`calls.update`), ni grabar sin que alguien conteste. El modo `auto` de keypress, necesario para el anti-bot de Meta ("presione el 9"), solo funciona con TwiML. Si se mete la llamada en Twilio por SIP, se reutiliza todo el pipeline de voz. |
| **SMS** | Webhook nativo de Zadarma (evento `SMS`) → nueva ruta `/zadarma-webhook` | Los SMS no viajan por SIP. Zadarma los entrega con un webhook HTTP propio. |

También existe una alternativa 100 % Zadarma para voz: PBX, extensión con grabación en la nube y luego `NOTIFY_RECORD` + `/v1/pbx/record/request/`. Sirve solo para buzón o grabación simple. **No supera el IVR anti-bot de Meta**, así que no se recomienda para los OTP de voz.

---

## 2. API REST de Zadarma

- Base: `https://api.zadarma.com/v1/<method>/`
- Las llaves se generan en my.zadarma.com → **Settings → Integrations and API → API keys** (`/api/`)
- Header de autenticación: `Authorization: <USER_KEY>:<SIGNATURE>`
- Cálculo de la firma:
  1. Ordenar los params alfabéticamente por llave (`ksort`)
  2. `paramsStr = http_build_query(params)` (RFC1738, los espacios se codifican como `+`)
  3. `data = methodPath + paramsStr + md5(paramsStr)`, donde `methodPath` es por ejemplo `/v1/direct_numbers/`
  4. `signature = base64( hmac_sha1_HEX(data, SECRET) )`. El SDK oficial de PHP usa `hash_hmac('sha1', …)`, que devuelve **hex**, y después hace base64 sobre ese string hex.
- El cuerpo de POST y PUT va como `application/x-www-form-urlencoded`. Las respuestas son JSON con `status: success|error`.
- Rate limit: 100 req/min (3 req/min en estadísticas). Pasar el límite devuelve HTTP 429.

### Endpoints útiles

| Método | Uso |
|---|---|
| `GET /v1/direct_numbers/` | Lista los números: `number, status, country, sip, ...` |
| `PUT /v1/direct_numbers/set_sip_id/` | `number`, `sip_id` (acepta un SIP URI): apunta un número a un SIP URI **por API** |
| `PUT /v1/direct_numbers/receive_sms/` | `number`, `value=on\|off`: activa la recepción de SMS (solo si el número la soporta) |
| `GET /v1/direct_numbers/country/` | Indica `receive_sms: true/false` por destino |
| `GET/POST /v1/pbx/webhooks/` · `/url/` · `/hooks/` | URL y toggles de los webhooks `sms`, `number_lookup`, `call_tracking`, `speech_recognition` |
| `GET/POST /v1/pbx/callinfo/` · `/url/` · `/notifications/` | URL y toggles de `notify_start/end/answer/internal/out_*` (eventos de llamadas PBX) |
| `GET /v1/pbx/record/request/?call_id=…\|pbx_call_id=…&lifetime=…` | Link MP3 de la grabación (solo para la ruta PBX) |
| `POST /v1/sms/send/` | Enviar SMS (no se usa aquí) |

---

## 3. Webhooks de Zadarma

### Verificación de la URL (`zd_echo`)
Cuando la URL se guarda en el panel, Zadarma hace un request con `?zd_echo=<valor>`. El servidor debe responder **200 con el valor en texto plano**. Hay que soportarlo en GET (y también en POST por si acaso).

### Formato
`POST application/x-www-form-urlencoded`, con el campo `event`. La firma llega en el header **`Signature`**.

### Firma por evento (`base64(HMAC-SHA1(string, SECRET))`)
| Evento | String a firmar |
|---|---|
| `NOTIFY_START` / `NOTIFY_END` / `NOTIFY_INTERNAL` / `NOTIFY_IVR` | `caller_id + called_did + call_start` |
| `NOTIFY_ANSWER` | `caller_id + destination + call_start` |
| `NOTIFY_OUT_START` / `NOTIFY_OUT_END` | `internal + destination + call_start` |
| `NOTIFY_RECORD` | `pbx_call_id + call_id_with_rec` |
| `SMS` **[NO CONFIRMADO]** | el string crudo del campo `result` |

⚠️ **Los dos SDKs oficiales no coinciden** en el encoding. PHP hace base64 sobre el **hex** del HMAC; TypeScript hace base64 sobre los **bytes crudos**. La validación debe aceptar cualquiera de los dos y comparar en tiempo constante. Como defensa adicional opcional, se puede revisar que la IP de origen sea de Zadarma.

### SMS entrante **[NO CONFIRMADO: validar con un SMS real]**
```
event=SMS
result={"caller_id":"+15551234567","caller_did":"+525512345678","text":"Tu código es 123456"}
```
`result` es un **string JSON**. `caller_did` es el número Zadarma que recibió el SMS (equivale al `To` de Twilio). `caller_id` es el remitente (equivale a `From`). Pueden llegar sin `+`, así que hay que normalizar a E.164.

---

## 4. Voz por SIP: Zadarma → Twilio

### Twilio
1. Console → **Voice → Manage → SIP Domains → +**, por ejemplo `darwin-zadarma.sip.twilio.com`
2. **IP Access Control List**: agregar las IPs de Zadarma (/32). Según la guía oficial: 185.45.152.216, 185.45.155.33, 185.45.152.164, 185.45.152.177, 185.45.152.200, 185.45.155.14, 185.45.155.16, 195.122.19.20, 195.122.19.29, 15.235.128.70, 31.31.222.201, 185.45.154.15
3. **A call comes in** → Webhook `POST {WEBHOOK_BASE_URL}/twilio-voice`
4. SIP Registration: no hace falta

### Zadarma (por número)
- Sin PBX: **Settings → Virtual phone numbers** (`/dirnum/active/`) → ⚙️ → pestaña **External Server** → activar **External Server (SIP URI)** → `<DID_E164_SIN_+>@darwin-zadarma.sip.twilio.com`
- Por API: `PUT /v1/direct_numbers/set_sip_id/`, con `number=<DID>` y `sip_id=<DID>@darwin-zadarma.sip.twilio.com`
- Poner el DID en el *user part* del URI permite que un solo SIP Domain sirva todos los números y que el código sepa qué línea sonó.

### Lo que recibe `/twilio-voice` en este caso **[NO CONFIRMADO en el formato exacto: loguear el body de la 1ª llamada]**
- `To` = `sip:525512345678@darwin-zadarma.sip.twilio.com` (no viene en E.164)
- `From` = `sip:+15551234567@sip.zadarma.com` o `@pbx.zadarma.com`
- `CallSid` es normal. `<Record>`, `<Start><Transcription>` y `calls(sid).update({twiml})` funcionan igual que en una llamada PSTN.
- La firma `X-Twilio-Signature` también llega, así que `twilioValidate` se sigue usando.
- Costo en Twilio: minuto SIP entrante más grabación y transcripción. Zadarma cobra el minuto de su número.

---

## 5. Estado actual del repo (lo relevante)

- **Rama base: `feat/vercel-serverless-migration`.** `main` solo tiene docs y config. El código (`src/`, `api/`, `tests/`) vive en esa rama.
- Deploy en Vercel (`api/index.js` y `vercel.json`, con rewrite `/(.*)` → `/api`). La persistencia va en Upstash Redis mediante `src/services/store.js`.
- `src/app.js` monta las rutas: `/twilio-webhook` (SMS), `/twilio-voice` (voz), `/lines` (API para n8n).
- `src/routes/voice.js`: `POST /` responde TwiML según `keypressMode` (`auto|fixed|none`); además están `/transcription`, `/ended` y `/recording`.
- `src/routes/twilio.js`: el SMS pasa por `sendToSlack({channel, friendlyName, toNumber, fromNumber, body})` y luego por `logTransaction`.
- `src/services/numbers.js`: directorio en `config/numbers.json` con `name, channel, routing, dtmf, language, keypressMode`. `routing` ya admite `vapi`.
- `src/services/capabilities.js`: sincroniza con la API de Twilio, y **fallaría o marcaría mal** los números Zadarma. Hay que excluirlos.
- `backgroundTask()` mantiene vivo el trabajo en segundo plano en Vercel (`waitUntil`).
