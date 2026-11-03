const crypto = require('crypto');
const { getSetting } = require('../services/settings');

// Validación del header `Signature` de los webhooks de Zadarma (docs/ZADARMA.md §3).
// Firma = base64(HMAC-SHA1(string, API_SECRET)). Los SDKs oficiales no coinciden en el
// encoding (PHP: base64 del HEX; TypeScript: base64 de los bytes), así que se aceptan ambos.

const str = (v) => (v === undefined || v === null ? '' : String(v));

/**
 * String a firmar según el evento. Devuelve null si el evento no se conoce
 * (o falta lo mínimo para firmarlo).
 *
 * @param {string} event
 * @param {Record<string, string>} body
 * @returns {string|null}
 */
function computeSignString(event, body = {}) {
  switch (event) {
    case 'NOTIFY_START':
    case 'NOTIFY_END':
    case 'NOTIFY_INTERNAL':
    case 'NOTIFY_IVR':
      return str(body.caller_id) + str(body.called_did) + str(body.call_start);
    case 'NOTIFY_ANSWER':
      return str(body.caller_id) + str(body.destination) + str(body.call_start);
    case 'NOTIFY_OUT_START':
    case 'NOTIFY_OUT_END':
      return str(body.internal) + str(body.destination) + str(body.call_start);
    case 'NOTIFY_RECORD':
      return str(body.pbx_call_id) + str(body.call_id_with_rec);
    case 'SMS': // [NO CONFIRMADO] el string crudo del campo `result`
      return typeof body.result === 'string' ? body.result : null;
    default:
      return null;
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** ¿`signature` coincide con alguna de las dos variantes de encoding? (comparación en tiempo constante) */
function verifySignature(signature, signString, secret) {
  if (!signature || !secret || typeof signString !== 'string') return false;
  const raw = crypto.createHmac('sha1', secret).update(signString).digest().toString('base64');
  const hex = Buffer.from(crypto.createHmac('sha1', secret).update(signString).digest('hex')).toString('base64');
  const given = String(signature).trim();
  // Se evalúan ambas siempre, sin cortocircuito.
  const okRaw = safeEqual(given, raw);
  const okHex = safeEqual(given, hex);
  return okRaw || okHex;
}

/** Estricto salvo que ZADARMA_STRICT_SIGNATURE sea exactamente "false". */
const defaultIsStrict = () => String(process.env.ZADARMA_STRICT_SIGNATURE ?? 'true').trim().toLowerCase() !== 'false';

function createZadarmaValidate({
  getSecret = () => getSetting('zadarma.apiSecret'),
  isStrict = defaultIsStrict,
  warn = (msg) => console.warn(msg),
} = {}) {
  return async function zadarmaValidate(req, res, next) {
    try {
      await validateRequest(req, res, next);
    } catch (err) {
      // Express 4 no captura rechazos async: sin esto la petición quedaría colgada.
      warn(`[zadarmaValidate] Error inesperado: ${err.message}`);
      if (!res.headersSent) res.status(500).type('text').send('Internal Server Error');
    }
  };

  async function validateRequest(req, res, next) {
    const body = req.body || {};
    const signString = computeSignString(body.event, body);

    // Evento desconocido: no hay nada que firmar ni que procesar (el handler solo lo loguea).
    if (signString === null) return next();

    const strict = isStrict();
    let secret;
    try {
      secret = await getSecret();
    } catch (err) {
      warn(`[zadarmaValidate] No se pudo leer el secret: ${err.message}`);
    }

    if (!secret && strict) {
      warn('[zadarmaValidate] ZADARMA_API_SECRET no configurado — rechazado');
      return res.status(503).type('text').send('Service Unavailable');
    }

    if (verifySignature(req.headers.signature, signString, secret)) return next();

    const reason = req.headers.signature ? 'firma inválida' : 'falta el header Signature';
    if (!strict) {
      warn(`[zadarmaValidate] ${reason} (event=${body.event}) — ZADARMA_STRICT_SIGNATURE=false, se deja pasar`);
      return next();
    }
    warn(`[zadarmaValidate] ${reason} (event=${body.event}) — rechazado desde ${req.ip}`);
    return res.status(403).type('text').send('Forbidden');
  }
}

module.exports = { computeSignString, verifySignature, createZadarmaValidate, zadarmaValidate: createZadarmaValidate() };
