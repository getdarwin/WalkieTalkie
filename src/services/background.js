/**
 * Runs a promise as background work that must survive the HTTP response.
 *
 * On Vercel, serverless functions freeze as soon as the response is sent —
 * any pending promise (recording download, Slack upload, capability sync)
 * would be killed. waitUntil() keeps the function alive until it settles.
 *
 * Locally (long-lived Node process) this is a no-op: the promise just runs.
 */
let vercelWaitUntil = null;
try {
  ({ waitUntil: vercelWaitUntil } = require('@vercel/functions'));
} catch {
  // Package not installed or not on Vercel — plain background execution
}

function backgroundTask(promise) {
  const guarded = promise.catch((err) =>
    console.error('[background] Task failed:', err instanceof Error ? err.message : err)
  );
  if (vercelWaitUntil) {
    try { vercelWaitUntil(guarded); } catch {}
  }
  return guarded;
}

module.exports = { backgroundTask };
