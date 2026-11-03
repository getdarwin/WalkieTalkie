const express = require('express');
const { createZadarmaValidate } = require('../middleware/zadarmaValidate');
const { normalizeE164 } = require('../services/phone');

// POST|GET /zadarma-webhook — webhooks nativos de Zadarma. Hoy solo se procesa `SMS`.
// Ver docs/ZADARMA.md §3. Responde siempre 200 rápido: el trabajo va en background.

// El valor de zd_echo se refleja tal cual: se limita a un alfabeto seguro (token
// alfanumérico) y a un largo acotado, además de servirse como text/plain + nosniff.
const ZD_ECHO = /^[A-Za-z0-9_.~+=\/-]{1,256}$/;

function parseSms(result) {
  let data;
  try {
    data = JSON.parse(result);
  } catch {
    return { error: 'result no es JSON' };
  }
  if (!data || typeof data !== 'object') return { error: 'result no es un objeto' };

  const to = normalizeE164(data.caller_did);
  if (!to) return { error: 'caller_did inválido' };
  const rawFrom = String(data.caller_id ?? '');
  return {
    sms: {
      to,
      // Los remitentes alfanuméricos ("FACEBOOK") no son números: se conservan tal cual.
      from: normalizeE164(rawFrom) || rawFrom,
      body: typeof data.text === 'string' ? data.text : '',
      provider: 'zadarma',
    },
  };
}

function createZadarmaRouter({
  getSecret,
  isStrict,
  handleSms = (sms) => require('../services/inboundSms').handleInboundSms(sms),
  background = (p) => require('../services/background').backgroundTask(p),
} = {}) {
  const router = express.Router();
  const validate = createZadarmaValidate({ getSecret, isStrict });

  // Verificación de la URL al guardarla en el panel de Zadarma (GET y, por si acaso, POST).
  router.all('/', (req, res, next) => {
    const echo = req.query.zd_echo ?? (req.body && req.body.zd_echo);
    if (echo === undefined) return next();
    if (typeof echo !== 'string' || !ZD_ECHO.test(echo)) {
      return res.status(400).type('text').send('Bad Request');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).type('text/plain').send(echo);
  });

  router.get('/', (_req, res) => res.status(200).type('text').send('OK'));

  router.post('/', validate, (req, res) => {
    const { event, result } = req.body || {};

    if (event !== 'SMS') {
      console.log(`[zadarma] Evento ${event || '(sin event)'} ignorado`);
      return res.status(200).type('text').send('OK');
    }

    const parsed = parseSms(result);
    if (parsed.error) {
      console.warn(`[zadarma] SMS descartado: ${parsed.error}`);
      return res.status(200).type('text').send('OK');
    }

    background(
      Promise.resolve(handleSms(parsed.sms)).then((r) => {
        if (r && r.ok === false) console.error(`[zadarma] SMS no entregado a Slack: ${r.error}`);
      })
    );
    return res.status(200).type('text').send('OK');
  });

  return router;
}

module.exports = createZadarmaRouter();
module.exports.createZadarmaRouter = createZadarmaRouter;
