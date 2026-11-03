const crypto = require('crypto');

/**
 * Bearer-token auth for the line provisioning API (POST/DELETE /lines).
 * Uses its own LINES_API_SECRET so n8n never holds ADMIN_SECRET and it can be
 * rotated on its own. FAILS CLOSED: unlike adminAuth, a missing secret
 * rejects every request instead of letting it through.
 */
function safeEqual(candidate, secret) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(String(secret || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireSecret(req, res, next) {
  const secret = process.env.LINES_API_SECRET;
  if (!secret) {
    return res.status(503).json({ ok: false, error: 'LINES_API_SECRET is not configured on the server.' });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (safeEqual(token, secret)) return next();

  res.status(401).json({ ok: false, error: 'Unauthorized. Send Authorization: Bearer <LINES_API_SECRET>.' });
}

module.exports = requireSecret;
