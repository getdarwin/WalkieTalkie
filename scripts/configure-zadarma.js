/**
 * Provisioning de líneas Zadarma (idempotente — se puede repetir):
 *   1. Registra el webhook de SMS de Zadarma: {WEBHOOK_BASE_URL}/zadarma-webhook (hook `sms` activo).
 *   2. Para cada línea `provider: zadarma` del directorio:
 *        - apunta el número al SIP Domain de Twilio:  <num sin +>@<ZADARMA_TWILIO_SIP_DOMAIN>
 *        - activa la recepción de SMS (si el número no la soporta se reporta, no es un error).
 *   3. Imprime un resumen. El fallo de una línea no detiene al resto.
 *
 * Nunca toca líneas con routing externo (vapi/talkyto/pipecat) ni, con --import, números de
 * Zadarma que ya apuntan a otro SIP URI.
 *
 * Uso:
 *   node scripts/configure-zadarma.js [--dry-run] [--import]
 *
 *   --dry-run   no cambia nada: muestra qué haría (solo lecturas a la API de Zadarma)
 *   --import    además da de alta en el directorio los números de Zadarma que falten
 *
 * Variables (.env o App Home): ZADARMA_API_KEY, ZADARMA_API_SECRET, WEBHOOK_BASE_URL,
 * ZADARMA_TWILIO_SIP_DOMAIN (default darwin-zadarma.sip.twilio.com).
 * Sale con código 1 si algo falló.
 */
require('dotenv').config();

const { runProvision } = require('../src/services/zadarmaProvision');

const ICONS = { connected: '✅', 'dry-run': '🔎', skipped: '⊘ ', failed: '❌', registered: '✅' };

async function main() {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((a) => !['--dry-run', '--import'].includes(a));
  if (unknown.length) {
    console.error(`Opción desconocida: ${unknown.join(' ')}\nUso: node scripts/configure-zadarma.js [--dry-run] [--import]`);
    process.exit(2);
  }

  const dryRun = args.has('--dry-run');
  console.log(`\nConfigurando Zadarma${dryRun ? ' (DRY RUN — no se cambia nada)' : ''}\n`);

  const report = await runProvision({ dryRun, importNumbers: args.has('--import') });

  const w = report.webhook;
  console.log(`  ${ICONS[w.status]} Webhook SMS  ${w.url}  [${w.status}]${w.detail ? `  ${w.detail}` : ''}`);
  for (const line of report.lines) {
    console.log(`  ${ICONS[line.status]} ${line.phone}  [${line.status}]  ${line.detail}`);
  }

  const count = (s) => report.lines.filter((l) => l.status === s).length;
  console.log(
    `\nResumen: ${count('connected')} conectadas, ${count('dry-run')} simuladas, ${count('skipped')} omitidas, ${report.failures} con error.\n`
  );
  process.exit(report.failures > 0 ? 1 : 0);
}

main().catch((err) => {
  // Nunca se imprimen credenciales: los errores del cliente solo llevan método, ruta y mensaje.
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});
