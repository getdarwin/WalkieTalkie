const crypto = require('crypto');
const { getSetting } = require('./settings');

// Cliente mínimo de la API REST de Zadarma (https://api.zadarma.com/v1/<method>/).
// Solo `fetch` nativo y `crypto`. Ver docs/ZADARMA.md §2 para el esquema de firma.

const API_ORIGIN = 'https://api.zadarma.com';
const REQUEST_TIMEOUT_MS = 10_000;

// PHP urlencode(): codifica todo salvo A-Za-z0-9 - _ . y los espacios van como "+".
function phpUrlencode(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/** http_build_query RFC1738 con las llaves ordenadas (ksort). Booleanos → 1/0 como en PHP. */
function buildQuery(params = {}) {
  return Object.keys(params)
    .sort()
    .map((key) => {
      const raw = params[key];
      const value = typeof raw === 'boolean' ? (raw ? '1' : '0') : String(raw);
      return `${phpUrlencode(key)}=${phpUrlencode(value)}`;
    })
    .join('&');
}

/**
 * Firma: base64( hmac_sha1_HEX( path + query + md5(query), secret ) ).
 * Igual que el SDK oficial de PHP: base64 sobre el string HEX, no sobre los bytes.
 */
function signRequest(methodPath, params, secret) {
  const query = buildQuery(params);
  const data = methodPath + query + crypto.createHash('md5').update(query).digest('hex');
  const hex = crypto.createHmac('sha1', secret).update(data).digest('hex');
  return Buffer.from(hex).toString('base64');
}

async function defaultCredentials() {
  const [key, secret] = await Promise.all([getSetting('zadarma.apiKey'), getSetting('zadarma.apiSecret')]);
  return { key, secret };
}

// Zadarma lista los DIDs sin "+" (p. ej. "525512345678").
const toDid = (number) => String(number ?? '').replace(/\D/g, '');

function createClient({ getCredentials = defaultCredentials, fetchImpl = fetch } = {}) {
  async function request(method, methodPath, params = {}) {
    const { key, secret } = await getCredentials();
    if (!key || !secret) {
      throw new Error('Faltan las credenciales de Zadarma (ZADARMA_API_KEY / ZADARMA_API_SECRET o la App Home)');
    }

    const query = buildQuery(params);
    const headers = { Authorization: `${key}:${signRequest(methodPath, params, secret)}` };
    let url = `${API_ORIGIN}${methodPath}`;
    const init = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };

    if (method === 'GET') {
      if (query) url += `?${query}`;
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = query;
    }

    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      throw new Error(`Zadarma ${method} ${methodPath}: ${err.message}`);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Zadarma ${method} ${methodPath}: HTTP ${res.status} ${text.slice(0, 200)}`.trim());
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Zadarma ${method} ${methodPath}: la respuesta no es JSON`);
    }
    if (json.status !== 'success') {
      throw new Error(`Zadarma ${method} ${methodPath}: ${json.message || 'error desconocido'}`);
    }
    return json;
  }

  return {
    /** @returns {Promise<Array<object>>} números directos de la cuenta */
    async listNumbers() {
      return (await request('GET', '/v1/direct_numbers/')).numbers || [];
    },
    /** @returns {Promise<object|null>} el número (comparando solo dígitos) o null si no está en la cuenta */
    async getNumber(number) {
      const digits = toDid(number);
      const all = (await request('GET', '/v1/direct_numbers/')).numbers || [];
      return all.find((n) => toDid(n.number) === digits) || null;
    },
    /** Apunta el número a un SIP URI (External Server). */
    async setSipUri(number, sipUri) {
      return request('PUT', '/v1/direct_numbers/set_sip_id/', { number: toDid(number), sip_id: sipUri });
    },
    /** Activa/desactiva la recepción de SMS del número. */
    async setReceiveSms(number, on) {
      return request('PUT', '/v1/direct_numbers/receive_sms/', { number: toDid(number), value: on ? 'on' : 'off' });
    },
    /** Registra la URL del webhook y activa el hook `sms`. */
    async setSmsWebhook(url) {
      if (!/^https:\/\//i.test(String(url))) throw new Error('La URL del webhook de Zadarma debe ser https');
      await request('POST', '/v1/pbx/webhooks/url/', { url });
      return request('POST', '/v1/pbx/webhooks/hooks/', { sms: 'true' });
    },
  };
}

module.exports = { buildQuery, signRequest, createClient, ...createClient() };
