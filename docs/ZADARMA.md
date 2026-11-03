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

## 5. Infraestructura YA configurada (2026-11-03)

### Twilio (cuenta "Darwin AI")
| Recurso | Valor |
|---|---|
| IP Access Control List | `zadarma` (SID `ALdc47c61d5e718840ce9afdeef133546d`), con 12 IPs /32: 185.45.152.216 (sipurifr), 185.45.155.33 (sipuriny), 185.45.152.164, 185.45.152.177, 185.45.152.200, 185.45.155.14, 185.45.155.16, 195.122.19.20, 195.122.19.29, 15.235.128.70, 31.31.222.201, 185.45.154.15 |
| SIP Domain | `darwin-zadarma.sip.twilio.com` (friendly name "Zadarma WalkieTalkie"), región US1 |
| Autenticación del domain | Solo la IP ACL `zadarma`. No hay credential list ni SIP Registration. |
| A call comes in | Webhook `POST https://walkietalkie-kappa.vercel.app/twilio-voice` |
| `WEBHOOK_BASE_URL` en prod | `https://walkietalkie-kappa.vercel.app` |

Según el panel de Zadarma, la señalización SIP del "Servidor externo" sale de **185.45.152.216 y 185.45.155.33**. El RTP (audio) puede venir de las subredes 185.45.152.0/24, 185.45.154.0/24, 185.45.155.0/24, 195.122.19.0/27, 31.31.222.192/27 y 15.235.128.64/28. La IP ACL de Twilio solo filtra la señalización.

### Zadarma
| Número | Configuración |
|---|---|
| `+528718430130` (México, Torreón) | Servidor externo (SIP URI) = `528718430130@darwin-zadarma.sip.twilio.com`. Antes apuntaba al SIP interno `113056`. Es la línea de prueba. |
| `+524426445470` (Querétaro) | **No se tocó.** Apunta a otro SIP URI (`+524426445470@sip…`, posiblemente VAPI). |

Pendiente (lo hacen el código y el script): API key/secret de Zadarma, webhook de SMS y `receive_sms` del número.

---

## 6. Guía de configuración de un número Zadarma (estándar)

**Convención:** SIP URI = `<E164 sin +>@darwin-zadarma.sip.twilio.com`. Un solo SIP Domain sirve para todas las líneas, y la línea se identifica por el *user part*.

1. **Zadarma, voz.** Panel: my.zadarma.com → Settings → Virtual phone numbers → ⚙️ → pestaña **Servidor externo** → ☑ *Servidor externo (SIP URI)* → `<num>@darwin-zadarma.sip.twilio.com` → GUARDAR. O por API: `PUT /v1/direct_numbers/set_sip_id/`.
2. **Zadarma, SMS** (solo si el número lo soporta): `PUT /v1/direct_numbers/receive_sms/` con `value=on`. El webhook es global (una vez): `POST /v1/pbx/webhooks/url/` y luego `POST /v1/pbx/webhooks/hooks/` con `sms=true`.
3. **Twilio:** no se toca nada por número.
4. **WalkieTalkie:** alta en el directorio con `provider: "zadarma"`, `name`, `channel`, `keypressMode: "auto"` (anti-bot de Meta) y `language` si aplica.
5. **Prueba:** llamar → thread en Slack, "🔢 IVR asked for key…", grabación y transcripción; en Twilio → Monitor → Calls debe verse entrando por `darwin-zadarma.sip.twilio.com`. Mandar un SMS → llega al thread del día.

Todo el paso a paso para personas sin acceso al código está en [`ZADARMA_SETUP.md`](./ZADARMA_SETUP.md).

**Troubleshooting:** ver `ZADARMA_SETUP.md` §5. Para revertir: desmarcar "Servidor externo" y volver a elegir el SIP interno en la pestaña Ajustes.

---

## 7. Implementación en el repo (estado actual)

- **Rama base: `feat/vercel-serverless-migration`.** `main` solo tiene docs y config.
- **Directorio:** `provider: "twilio" | "zadarma"` (default `twilio`, no se persiste). Helpers puros en `src/services/provider.js`. Se propaga en `setNumber`, `/numbers.csv` (columna `provider`), import de CSV (modal y `scripts/configure-from-csv.js`) y `POST /lines`.
- **Voz:** `src/routes/voice.js` normaliza `To`/`From` (`resolveCallParties` en `src/services/phone.js`) **antes** de usarlos, guarda `provider: 'zadarma'` en el call thread cuando `To` es SIP del domain `ZADARMA_TWILIO_SIP_DOMAIN`, y loguea el body crudo (`SIP call raw body`) para confirmar el formato real. `/transcription`, `/ended`, `/recording` y `pressKeyOnLiveCall` solo usan `CallSid` y el thread guardado, así que no dependen del formato de `To`. `twilioValidate` no se toca (Twilio firma igual las llamadas SIP; **[confirmar en la 1ª llamada real]**).
- **Capabilities:** `checkAndCacheCapabilities` y `connectNumberToWalkieTalkie` nunca consultan Twilio para líneas Zadarma, y `syncAllCapabilities` las excluye. En la App Home se muestra "Voz vía SIP".
- **SMS:** `src/routes/zadarma.js` (`/zadarma-webhook`, `zd_echo` en GET y POST) + `src/middleware/zadarmaValidate.js` (firma `base64(raw)` o `base64(hex)`, `timingSafeEqual`, `ZADARMA_STRICT_SIGNATURE`) + `src/services/inboundSms.js` (`handleInboundSms`, compartido con `/twilio-webhook`; los logs de Zadarma llevan `provider: 'zadarma'`).
- **Cliente API:** `src/services/zadarma.js` (`fetch` nativo; `listNumbers`, `getNumber`, `setSipUri`, `setReceiveSms`, `setSmsWebhook`). Credenciales: `getSetting('zadarma.apiKey'|'zadarma.apiSecret')` con fallback a `ZADARMA_API_KEY`/`ZADARMA_API_SECRET`.
- **Provisioning:** `src/services/zadarmaLines.js` (`connectZadarmaLine`, idempotente; nunca toca `routing` vapi/talkyto/pipecat) y `src/services/zadarmaProvision.js`, usados por `scripts/configure-zadarma.js` (`--dry-run`, `--import`), la App Home (🔗 Conectar a WalkieTalkie) y `POST /lines`.
- **Lo que sigue sin confirmar [NO CONFIRMADO]:** formato exacto de `To`/`From` SIP, firma del evento `SMS`, valor del campo `sip` que devuelve `GET /v1/direct_numbers/` para un "Servidor externo" (se usa solo para decidir si hace falta reescribirlo; `setSipUri` es idempotente), y el nombre/valor del parámetro de `/v1/pbx/webhooks/hooks/` (`sms=true`).
- `backgroundTask()` mantiene vivo el trabajo en segundo plano en Vercel (`waitUntil`).
