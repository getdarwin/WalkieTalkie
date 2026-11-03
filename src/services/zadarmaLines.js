const { entryProvider } = require('./provider');
const { parseE164 } = require('./phone');

// Conectar líneas Zadarma a WalkieTalkie: apuntar el número al SIP Domain de Twilio
// (voz) y activar la recepción de SMS. Lo comparten POST /lines, la App Home y
// scripts/configure-zadarma.js. Las dependencias se inyectan para poder probarlo.

const DEFAULT_SIP_DOMAIN = 'darwin-zadarma.sip.twilio.com';
const EXTERNAL_ROUTING = new Set(['vapi', 'talkyto', 'pipecat']);

const sipDomain = () => process.env.ZADARMA_TWILIO_SIP_DOMAIN || DEFAULT_SIP_DOMAIN;
const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

/** `<E164 sin +>@<domain>`: el DID va en el user part para que un solo domain sirva a todas las líneas. */
function buildSipUri(phone, domain = sipDomain()) {
  const digits = digitsOf(phone);
  if (!digits) throw new Error(`"${phone}" no es un número válido`);
  if (!domain) throw new Error('Falta el SIP Domain de Twilio (ZADARMA_TWILIO_SIP_DOMAIN)');
  return `${digits}@${domain}`;
}

/** ¿El valor `sip` de un número apunta a un SIP URI de OTRO host (p. ej. VAPI)? Vacío o interno (solo dígitos) no. */
function isForeignSip(current, domain = sipDomain()) {
  const value = String(current ?? '').trim().replace(/^sips?:/i, '').toLowerCase();
  if (!value.includes('@')) return false;
  const host = value.split('@')[1].split(';')[0].split(':')[0];
  const d = String(domain).toLowerCase();
  return host !== d && !host.endsWith(`.${d}`);
}

const pointsAtUs = (current, sipUri) =>
  String(current ?? '').trim().replace(/^sips?:/i, '').toLowerCase() === sipUri.toLowerCase();

function defaultDeps() {
  return { client: require('./zadarma'), loadConfig: require('./numbers').loadConfig, domain: sipDomain() };
}

/**
 * Conecta una línea Zadarma: SIP URI + receive_sms. Idempotente.
 * Nunca toca líneas con routing externo (VAPI/Talkyto/Pipecat). Un número sin
 * soporte de SMS no es un error: la voz queda conectada y el SMS se reporta.
 *
 * @param {string} phone  E.164
 * @param {object} [deps]
 * @param {{ dryRun?: boolean }} [opts]  dryRun: solo lecturas, no escribe nada
 * @returns {Promise<{ phone: string, sipUri?: string, voice: boolean, sipChanged?: boolean, sms?: {ok: boolean, error?: string}, skipped?: string }>}
 */
async function connectZadarmaLine(phone, deps = defaultDeps(), { dryRun = false } = {}) {
  const { client, loadConfig, domain = sipDomain() } = deps;
  const { numbers } = await loadConfig();
  const entry = numbers[phone];

  if (entryProvider(entry) !== 'zadarma') {
    throw new Error(`${phone} no es una línea Zadarma (provider=zadarma en el directorio)`);
  }
  const routing = (entry && typeof entry === 'object' && entry.routing) || '';
  if (EXTERNAL_ROUTING.has(routing.toLowerCase())) {
    return { phone, voice: false, skipped: `routing externo (${routing})` };
  }

  const current = await client.getNumber(phone);
  if (!current) throw new Error(`${phone} no existe en Zadarma (revisa que sea un número de la cuenta)`);

  const sipUri = buildSipUri(phone, domain);
  const sipChanged = !pointsAtUs(current.sip, sipUri);
  if (dryRun) return { phone, sipUri, voice: true, sipChanged, sms: { ok: true }, dryRun: true };
  if (sipChanged) await client.setSipUri(phone, sipUri);

  let sms;
  try {
    await client.setReceiveSms(phone, true);
    sms = { ok: true };
  } catch (err) {
    sms = { ok: false, error: err.message };
  }
  return { phone, sipUri, voice: true, sipChanged, sms };
}

/**
 * Decide qué hacer con cada número de `listNumbers()` al importar (--import).
 * Nunca pisa un número que apunta a otro SIP URI ni uno ya dado de alta con otro provider.
 *
 * @param {Array<{ number: string, sip?: string }>} zadarmaNumbers
 * @param {Record<string, any>} directory
 * @returns {Array<{ phone: string, action: 'import'|'already'|'skip-foreign-sip'|'skip-other-provider', sip?: string }>}
 */
function planImport(zadarmaNumbers, directory, domain = sipDomain()) {
  return zadarmaNumbers
    .map((n) => ({ phone: parseE164(`+${digitsOf(n.number)}`), sip: n.sip }))
    .filter((n) => n.phone)
    .map(({ phone, sip }) => {
      const existing = directory[phone];
      if (existing !== undefined) {
        return { phone, sip, action: entryProvider(existing) === 'zadarma' ? 'already' : 'skip-other-provider' };
      }
      return { phone, sip, action: isForeignSip(sip, domain) ? 'skip-foreign-sip' : 'import' };
    });
}

/** Resumen en español de `connectZadarmaLine` para Slack. */
function describeConnectResult(r) {
  if (r.skipped) return `${r.phone} no se tocó (${r.skipped}).`;
  const voice = r.sipChanged
    ? `Voz vía SIP → ${r.sipUri}`
    : `Voz vía SIP (ya apuntaba a ${r.sipUri})`;
  const sms = r.sms && r.sms.ok ? 'SMS activo' : `SMS no disponible: ${(r.sms && r.sms.error) || 'desconocido'}`;
  return `${voice} · ${sms}`;
}

module.exports = { DEFAULT_SIP_DOMAIN, describeConnectResult, sipDomain, buildSipUri, isForeignSip, connectZadarmaLine, planImport };
