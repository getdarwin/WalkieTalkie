// Normalización de números de teléfono. Sin I/O: se prueba con node:test.

const E164 = /^\+\d{8,15}$/;
const URI_SCHEME = /^(sips?|tel):/i;
const SIP_SCHEME = /^sips?:/i;

/** ¿Es un SIP URI (`sip:...` / `sips:...`)? */
function isSipUri(value) {
  return SIP_SCHEME.test(String(value ?? '').trim());
}

/**
 * Convierte a E.164 (`+525512345678`) lo que llegue: E.164 con formato,
 * dígitos sueltos o un SIP/tel URI (`sip:525512345678@x.sip.twilio.com;p=1`).
 * Devuelve '' si no es un número válido (p. ej. `sip:anonymous@anonymous.invalid`).
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeE164(raw) {
  let value = String(raw ?? '').trim();
  if (URI_SCHEME.test(value)) {
    value = value.replace(URI_SCHEME, '').split('@')[0].split(';')[0];
  }
  const digits = value.replace(/\D/g, '');
  const phone = `+${digits}`;
  return E164.test(phone) ? phone : '';
}

/**
 * To/From de un webhook de voz de Twilio, normalizados a E.164. Las llamadas que
 * entran por SIP (Zadarma → Twilio SIP Domain) traen `sip:...@host`. Si el valor
 * no se puede normalizar (p. ej. un From anónimo) se conserva tal cual.
 *
 * @param {{ To?: string, From?: string }} body
 * @returns {{ to: string, from: string, sip: boolean }}
 */
function resolveCallParties(body = {}) {
  const rawTo = String(body.To ?? '');
  const rawFrom = String(body.From ?? '');
  return {
    to: normalizeE164(rawTo) || rawTo,
    from: normalizeE164(rawFrom) || rawFrom,
    sip: isSipUri(rawTo) || isSipUri(rawFrom),
  };
}

module.exports = { normalizeE164, isSipUri, resolveCallParties };
