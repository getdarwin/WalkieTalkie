const { isZadarmaEntry } = require('./provider');
const { connectZadarmaLine, planImport, sipDomain } = require('./zadarmaLines');

// Orquesta scripts/configure-zadarma.js: webhook SMS + conexión de cada línea Zadarma.
// Idempotente. El fallo de una línea no detiene el resto. Con dryRun no escribe nada.

function defaultDeps() {
  const numbers = require('./numbers');
  return {
    client: require('./zadarma'),
    domain: sipDomain(),
    baseUrl: process.env.WEBHOOK_BASE_URL,
    loadConfig: numbers.loadConfig,
    setNumber: numbers.setNumber,
  };
}

/**
 * @param {{ dryRun?: boolean, importNumbers?: boolean }} opts
 * @returns {Promise<{ dryRun: boolean, webhook: {url: string, status: string, detail?: string}, lines: Array<{phone: string, status: 'connected'|'dry-run'|'skipped'|'failed', detail: string}>, failures: number }>}
 */
async function runProvision({ dryRun = false, importNumbers = false } = {}, deps = defaultDeps()) {
  if (!deps.baseUrl) throw new Error('Falta WEBHOOK_BASE_URL');
  const report = { dryRun, webhook: null, lines: [], failures: 0 };
  const fail = () => { report.failures += 1; };

  // 1. Webhook de SMS (global de la cuenta)
  const url = `${deps.baseUrl.replace(/\/$/, '')}/zadarma-webhook`;
  try {
    if (!dryRun) await deps.client.setSmsWebhook(url);
    report.webhook = { url, status: dryRun ? 'dry-run' : 'registered' };
  } catch (err) {
    report.webhook = { url, status: 'failed', detail: err.message };
    fail();
  }

  // 2. Importar números de Zadarma que falten (nunca los que apuntan a otro SIP)
  let { numbers } = await deps.loadConfig();
  const wouldImport = [];
  if (importNumbers) {
    try {
      const plan = planImport(await deps.client.listNumbers(), numbers, deps.domain);
      for (const p of plan) {
        if (p.action === 'import') {
          if (dryRun) {
            wouldImport.push(p.phone);
          } else {
            await deps.setNumber(p.phone, { name: p.phone, provider: 'zadarma', keypressMode: 'auto' });
          }
        } else if (p.action === 'skip-foreign-sip') {
          report.lines.push({ phone: p.phone, status: 'skipped', detail: `apunta a otro SIP (${p.sip}) — no se toca` });
        } else if (p.action === 'skip-other-provider') {
          report.lines.push({ phone: p.phone, status: 'skipped', detail: 'ya está en el directorio con otro proveedor' });
        }
      }
      if (!dryRun) ({ numbers } = await deps.loadConfig());
    } catch (err) {
      report.lines.push({ phone: '(import)', status: 'failed', detail: err.message });
      fail();
    }
  }

  // 3. Conectar cada línea Zadarma del directorio
  for (const phone of Object.keys(numbers)) {
    if (!isZadarmaEntry(numbers[phone])) continue;
    try {
      const r = await connectZadarmaLine(phone, deps, { dryRun });
      if (r.skipped) {
        report.lines.push({ phone, status: 'skipped', detail: r.skipped });
        continue;
      }
      const smsNote = r.sms.ok ? 'SMS activo' : `SMS no disponible (${r.sms.error})`;
      const sipNote = r.sipChanged ? `SIP → ${r.sipUri}` : 'SIP ya correcto';
      report.lines.push({ phone, status: dryRun ? 'dry-run' : 'connected', detail: `${sipNote} · ${smsNote}` });
    } catch (err) {
      report.lines.push({ phone, status: 'failed', detail: err.message });
      fail();
    }
  }
  for (const phone of wouldImport) {
    report.lines.push({ phone, status: 'dry-run', detail: 'se importaría al directorio y se conectaría' });
  }

  return report;
}

module.exports = { runProvision };
