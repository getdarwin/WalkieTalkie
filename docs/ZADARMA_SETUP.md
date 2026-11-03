# Zadarma + WalkieTalkie: runbook de configuración

> Para personas **sin acceso al código**. Se puede seguir paso a paso.
> La referencia técnica (API, firmas, formatos) está en [`ZADARMA.md`](./ZADARMA.md).
> Lo marcado **[NO CONFIRMADO]** hay que comprobarlo con una llamada o un SMS reales.

---

## 1. Cómo funciona (arquitectura)

```
VOZ  (llamadas y OTP por voz)

  Llamada ──► Número Zadarma ──► "Servidor externo (SIP URI)"
                                        │  <num sin +>@darwin-zadarma.sip.twilio.com
                                        ▼
                           Twilio SIP Domain (darwin-zadarma.sip.twilio.com)
                           protegido por la IP ACL "zadarma"
                                        │  webhook "A call comes in"
                                        ▼
                           WalkieTalkie  POST /twilio-voice
                           (escucha el IVR en vivo, presiona la tecla,
                            graba y transcribe)
                                        │
                                        ▼
                                      Slack (un thread por línea y día)


SMS  (OTP por SMS)

  SMS ──► Número Zadarma ──► Webhook de Zadarma (evento SMS)
                                        │  firmado con el API secret
                                        ▼
                           WalkieTalkie  POST /zadarma-webhook
                                        │
                                        ▼
                                      Slack (mismo thread del día)
```

**Por qué la voz pasa por Twilio:** la API de Zadarma no permite transcribir en vivo, presionar una tecla a mitad de llamada ni grabar desde el segundo cero. El IVR anti-bot de Meta ("presione el 9") necesita esas tres cosas, así que la llamada se mete en Twilio por SIP y se reutiliza todo el flujo de voz que ya existe.

**Por qué los SMS no:** los SMS no viajan por SIP. Zadarma los entrega con su propio webhook HTTP.

---

## 2. Infraestructura única de la cuenta (YA HECHA)

Esto se hizo una sola vez (2026-11-03). **No hay que repetirlo por cada número.** Solo se consulta si algo falla.

### 2.1 Twilio (cuenta "Darwin AI")

| Recurso | Valor |
|---|---|
| IP Access Control List | `zadarma` (SID `ALdc47c61d5e718840ce9afdeef133546d`), 12 IPs /32 |
| SIP Domain | `darwin-zadarma.sip.twilio.com` (nombre "Zadarma WalkieTalkie"), región US1 |
| Autenticación del domain | Solo la IP ACL `zadarma` (sin credential list ni SIP Registration) |
| "A call comes in" | Webhook `POST https://walkietalkie-kappa.vercel.app/twilio-voice` |

**Las 12 IPs de la ACL `zadarma`:**

```
185.45.152.216   (sipurifr)      185.45.155.14
185.45.155.33    (sipuriny)      185.45.155.16
185.45.152.164                   195.122.19.20
185.45.152.177                   195.122.19.29
185.45.152.200                   15.235.128.70
31.31.222.201                    185.45.154.15
```

Según el panel de Zadarma, la señalización SIP del "Servidor externo" sale de **185.45.152.216 y 185.45.155.33**. El audio (RTP) puede venir de otras subredes de Zadarma; la ACL de Twilio solo filtra la señalización.

### 2.2 Cómo verificar que existen

1. **IP ACL:** Twilio Console → *Voice → Manage → IP Access Control Lists* → debe existir `zadarma` con las 12 IPs.
2. **SIP Domain:** Twilio Console → *Voice → Manage → SIP Domains* → `darwin-zadarma.sip.twilio.com`:
   - *Voice Authentication → IP Access Control Lists*: la ACL `zadarma` debe estar **asociada**.
   - *Call Control Configuration → A call comes in*: `Webhook`, `HTTP POST`, URL `https://walkietalkie-kappa.vercel.app/twilio-voice`.
3. **Servidor de WalkieTalkie vivo:** abrir `https://walkietalkie-kappa.vercel.app/health`. Debe responder `{"status":"ok"}`.

### 2.3 Cómo recrearlos si se pierden

1. **ACL:** Twilio Console → *Voice → Manage → IP Access Control Lists → +* → nombre `zadarma` → agregar las 12 IPs de arriba, cada una como /32.
2. **SIP Domain:** *Voice → Manage → SIP Domains → +* → SIP URI `darwin-zadarma` (queda `darwin-zadarma.sip.twilio.com`) → *Voice Authentication → IP Access Control Lists* → asociar `zadarma`.
3. **Webhook de voz:** en el mismo domain → *A call comes in* → Webhook, POST, `https://walkietalkie-kappa.vercel.app/twilio-voice`.
4. **No** configurar SIP Registration ni credential list.

> Si cambia el nombre del domain, hay que cambiar también la variable `ZADARMA_TWILIO_SIP_DOMAIN` en Vercel y volver a apuntar cada número (sección 3).

### 2.4 Webhook de SMS de Zadarma (una sola vez, es global de la cuenta)

Lo hace el script y también se puede hacer a mano.

- **Con el script** (necesita `ZADARMA_API_KEY` y `ZADARMA_API_SECRET`, ver sección 3.4):
  ```
  node scripts/configure-zadarma.js
  ```
  Registra `https://walkietalkie-kappa.vercel.app/zadarma-webhook` y activa el hook `sms`.
- **A mano:** my.zadarma.com → *Settings → Integrations and API* → Webhooks → URL `https://walkietalkie-kappa.vercel.app/zadarma-webhook` → activar **SMS**.
- Al guardar la URL, Zadarma hace una petición con `?zd_echo=...`. WalkieTalkie la contesta solo. Si el panel dice que la URL no se pudo verificar, revisar que `/health` responda.

### 2.5 Variables de entorno (en Vercel)

| Variable | Qué es |
|---|---|
| `ZADARMA_API_KEY`, `ZADARMA_API_SECRET` | Credenciales de la API (my.zadarma.com → *Settings → Integrations and API → API keys*). También se pueden cargar desde la App Home de Slack. |
| `ZADARMA_TWILIO_SIP_DOMAIN` | `darwin-zadarma.sip.twilio.com` |
| `ZADARMA_STRICT_SIGNATURE` | `true` (default). Rechaza webhooks con firma inválida. Ver sección 4. |

El API secret firma los webhooks: **no lo compartas ni lo pegues en chats o tickets.**

---

## 3. Checklist por número nuevo

**Convención:** SIP URI = `<número E.164 sin +>@darwin-zadarma.sip.twilio.com`
Ejemplo: `+528718430130` → `528718430130@darwin-zadarma.sip.twilio.com`

Sin `+`, sin espacios, sin guiones. Un solo SIP Domain atiende todas las líneas; la línea se identifica por la parte antes del `@`.

> ⚠️ **No tocar** números que apuntan a otro servicio (por ejemplo VAPI). Ejemplo: `+524426445470` apunta a otro SIP URI. Si un número ya tiene un "Servidor externo" que no es el nuestro, **pregunta antes de cambiarlo**.

### 3.1 Voz en Zadarma (panel)

1. Entrar a **my.zadarma.com**.
2. Menú **Settings → Virtual phone numbers** (en la barra: `/dirnum/active/`).
3. En la fila del número, clic en el engranaje ⚙️.
4. Pestaña **Servidor externo** (*External Server*).
5. Marcar la casilla **Servidor externo (SIP URI)**.
6. En *Dirección del servidor* escribir `<num sin +>@darwin-zadarma.sip.twilio.com`.
7. **GUARDAR**.

*Alternativa por API/script:* ver 3.4.

### 3.2 SMS en Zadarma

Solo si el número soporta SMS.

1. Activar la recepción de SMS del número: se hace con el script (3.4) o con la API `receive_sms`.
2. El webhook ya es global (sección 2.4); no hay que hacer nada por número.
3. Si el número **no** soporta SMS, Zadarma devuelve un error. Es normal: la voz sigue funcionando.

### 3.3 Alta en WalkieTalkie (directorio)

Elegir **una** de las dos formas:

**A) App Home de Slack**
1. Abrir la app WalkieTalkie en Slack → pestaña *Home*.
2. Agregar la línea (número, nombre, canal).
3. Poner **Proveedor = Zadarma** y **Modo de tecla = auto** (necesario para el anti-bot de Meta).
4. Guardar. Se verá la etiqueta **Zadarma** y "Voz vía SIP".
5. Clic en **🔗 Conectar a WalkieTalkie** para que se configure el SIP URI y los SMS automáticamente.

**B) CSV** (Upload CSV en la App Home)
```
phone_number,friendly_name,channel_id,routing,sms,voice,keypress_mode,dtmf,language,provider
+528718430130,Zadarma Torreón,C0XXXXXXX,walkietalkie,,,auto,,,zadarma
```
El nombre sigue la convención `<Cliente>[ N] - <Dueño>`.

### 3.4 Alternativa: todo con el script

Para quien tenga el repositorio:

```
node scripts/configure-zadarma.js --dry-run     # muestra qué haría, sin cambiar nada
node scripts/configure-zadarma.js               # aplica
node scripts/configure-zadarma.js --import      # además, da de alta los números de Zadarma que falten
```

El script es idempotente (se puede repetir). Por cada línea `provider: zadarma` del directorio apunta el SIP URI y activa SMS, e imprime un resumen al final. **No toca** líneas con `routing: vapi` ni números que ya apuntan a otro SIP URI.

---

## 4. Prueba de punta a punta

### 4.1 Llamada

1. Llamar al número Zadarma (o disparar el flujo de verificación por voz de Meta hacia ese número).
2. **En Slack** (canal de la línea) debe aparecer:
   - un thread nuevo con el **nombre correcto** de la línea (no el número crudo),
   - "🔢 IVR asked for key N — pressed automatically" cuando el IVR pide una tecla,
   - al terminar, la **grabación** y la **transcripción**.
3. **En Twilio** → *Monitor → Logs → Calls*: la llamada debe figurar como entrante por `darwin-zadarma.sip.twilio.com`.
4. **Confirmar el formato real de `To`/`From`** (**[NO CONFIRMADO]**): en los logs de Vercel buscar `SIP call raw body`. Debe verse algo como `To=sip:528718430130@darwin-zadarma.sip.twilio.com` y `From=sip:+52...@sip.zadarma.com`. Guardar ese log: sirve para ajustar el código si el formato difiere.

### 4.2 SMS

1. Mandar un SMS al número (por ejemplo desde un celular).
2. **En Slack**: debe llegar al thread del día de esa línea. Si es un código de 4–8 dígitos, se destaca como OTP.
3. **Firma del webhook (**[NO CONFIRMADO]** para SMS):**
   - Con `ZADARMA_STRICT_SIGNATURE=true`, si Zadarma firma el SMS de una forma distinta a la esperada, el SMS se **rechaza** (403) y no llega a Slack. En los logs de Vercel aparece `[zadarmaValidate] firma inválida`.
   - Para la **primera prueba en vivo**, poner `ZADARMA_STRICT_SIGNATURE=false` (solo se registra el aviso y el SMS pasa), enviar el SMS y revisar el log. Si **no** hay aviso de firma, la firma es válida y se puede volver a `true`.
   - Si hay aviso con el SMS real, avisar al equipo técnico con el log (sin pegar el secret).
4. **Siempre volver a `ZADARMA_STRICT_SIGNATURE=true`** después de la prueba. Con `false`, cualquiera que conozca la URL podría inyectar SMS falsos en Slack.

---

## 5. Troubleshooting

| Síntoma | Qué revisar |
|---|---|
| La llamada no llega a Twilio | La IP de origen debe estar en la ACL `zadarma`. El URI **no** debe tener `+` ni espacios. |
| Twilio responde 403 / SIP 403 | La ACL `zadarma` no está asociada al SIP Domain (sección 2.2). |
| La llamada llega pero cae en el canal por defecto o con el número crudo | El número no está en el directorio, o no coincide. Revisar que esté dado de alta en E.164 (`+52...`). |
| Hay thread pero no se presiona la tecla | Revisar que **Modo de tecla = auto** (o el default global). Mirar el log `Live transcript`. |
| No hay grabación | Mirar en Twilio → Monitor → Calls si la llamada se contestó. |
| El SMS no llega a Slack | Mirar logs de Vercel: `firma inválida` (ver 4.2), `SMS descartado` (JSON o número inválido) o nada (Zadarma no está entregando: revisar que el hook `sms` esté activo y que el número tenga `receive_sms` en `on`). |
| Zadarma no acepta la URL del webhook | Revisar que `https://walkietalkie-kappa.vercel.app/health` responda; el `zd_echo` lo contesta WalkieTalkie. |
| Error "es una línea Zadarma" al conectar | Las líneas Zadarma no se conectan por Twilio: usar el botón 🔗 o el script. |

### Cómo revertir un número a su SIP interno

1. my.zadarma.com → *Settings → Virtual phone numbers* → ⚙️ del número.
2. Pestaña **Servidor externo**: **desmarcar** *Servidor externo (SIP URI)*.
3. Pestaña **Ajustes**: volver a elegir el SIP interno anterior y guardar.
4. En WalkieTalkie (App Home): eliminar la línea del directorio o cambiar su proveedor.

---

## 6. Costos

Una llamada a un número Zadarma genera cuatro costos:

1. **Zadarma:** el minuto entrante de su número (según el plan y el país del número) más la renta mensual del número.
2. **Twilio, SIP entrante:** el minuto de *SIP Domain* entrante.
3. **Twilio, grabación:** por minuto grabado, más el almacenamiento mientras la grabación exista.
4. **Transcripción:** la transcripción en vivo de Twilio (Deepgram, por minuto) y la transcripción final con Groq/Whisper.

Los SMS entrantes los cobra únicamente Zadarma (no pasan por Twilio). Las tarifas cambian: consultar las páginas de precios de Zadarma y de Twilio (*Programmable Voice → SIP Interface* y *Real-Time Transcriptions*) antes de proyectar volumen.
