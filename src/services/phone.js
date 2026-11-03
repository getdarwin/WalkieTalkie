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

module.exports = { normalizeE164, isSipUri };
