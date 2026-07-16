const crypto = require('crypto');

/**
 * Optional admin auth middleware for debug/export endpoints (/logs, /capabilities, /numbers.csv).
 *
 * If ADMIN_SECRET is set in .env, requests must pass it via:
 *   - Query param:  ?secret=<ADMIN_SECRET>
 *   - HTTP header:  Authorization: Bearer <ADMIN_SECRET>
 *
 * If ADMIN_SECRET is not set, all requests pass through (development mode).
 */

/** Constant-time string comparison — prevents timing attacks on the secret. */
function safeEqual(candidate, secret) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(String(secret || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = function adminAuth(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return next();

  const fromQuery = req.query.secret;
  const fromHeader = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (safeEqual(fromQuery, secret) || safeEqual(fromHeader, secret)) return next();

  res.status(401).json({
    error: 'Unauthorized. Pass ?secret=<ADMIN_SECRET> or Authorization: Bearer <secret>.',
  });
};
