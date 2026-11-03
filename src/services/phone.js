// Normalización de números de teléfono. Sin I/O: se prueba con node:test.

const E164 = /^\+\d{8,15}$/;
const URI_SCHEME = /^(sips?|tel):/i;
const SIP_SCHEME = /^sips?:/i;
// Lo que puede aparecer en un número con formato: dígitos, +, espacios, guiones, puntos, paréntesis.
const PHONE_CHARS = /^\+?[\d\s().-]+$/;

/** ¿Es una dirección SIP (`sip:...` / `sips:...`)? */
function isSipAddress(value) {
  return SIP_SCHEME.test(String(value ?? '').trim());
}

/** Parte "usuario" de un SIP/tel URI (`sip:525512@host;p=1` → `525512`); el resto queda igual. */
function userPart(value) {
  const v = String(value ?? '').trim();
  return URI_SCHEME.test(v) ? v.replace(URI_SCHEME, '').split('@')[0].split(';')[0] : v;
}

/**
 * Convierte a E.164 (`+525512345678`) lo que llegue: E.164 con formato, dígitos
 * sueltos o un SIP/tel URI (`sip:+1555...@sip.zadarma.com;transport=udp`).
 * Si no se pueden extraer dígitos (p. ej. `anonymous`), devuelve el valor original.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeE164(raw) {
  const original = String(raw ?? '');
  const user = userPart(original);
  if (!PHONE_CHARS.test(user)) return original;
  const digits = user.replace(/\D/g, '');
  return digits ? `+${digits}` : original;
}

/**
 * Versión estricta: E.164 válido (8–15 dígitos) o '' si el valor no es un número.
 * Para validar entradas (API /lines, caller_did de Zadarma).
 *
 * @param {unknown} raw
 * @returns {string}
 */
function parseE164(raw) {
  const normalized = normalizeE164(raw);
  return E164.test(normalized) ? normalized : '';
}

/** ¿`value` es un SIP URI cuyo host es `domain` (o un subdominio)? Sin distinguir mayúsculas. */
function isSipOfDomain(value, domain) {
  const v = String(value ?? '').trim();
  const d = String(domain ?? '').trim().toLowerCase();
  if (!d || !isSipAddress(v)) return false;
  const host = (v.replace(SIP_SCHEME, '').split('@')[1] || '').split(';')[0].split(':')[0].toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

/**
 * To/From de un webhook de voz de Twilio, normalizados a E.164. Las llamadas que
 * entran por SIP (Zadarma → Twilio SIP Domain) traen `sip:...@host`.
 * `provider` es 'zadarma' cuando `To` es un SIP del domain de Zadarma.
 *
 * @param {{ To?: string, From?: string }} body
 * @param {{ zadarmaDomain?: string }} [opts]
 * @returns {{ to: string, from: string, sip: boolean, provider: 'twilio'|'zadarma' }}
 */
function resolveCallParties(body = {}, { zadarmaDomain } = {}) {
  const rawTo = String(body.To ?? '');
  const rawFrom = String(body.From ?? '');
  return {
    to: normalizeE164(rawTo),
    from: normalizeE164(rawFrom),
    sip: isSipAddress(rawTo) || isSipAddress(rawFrom),
    provider: isSipOfDomain(rawTo, zadarmaDomain) ? 'zadarma' : 'twilio',
  };
}

module.exports = { normalizeE164, parseE164, isSipAddress, isSipOfDomain, resolveCallParties };
