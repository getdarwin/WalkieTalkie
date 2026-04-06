/**
 * Optional admin auth middleware for debug/export endpoints (/logs, /capabilities, /numbers.csv).
 *
 * If ADMIN_SECRET is set in .env, requests must pass it via:
 *   - Query param:  ?secret=<ADMIN_SECRET>
 *   - HTTP header:  Authorization: Bearer <ADMIN_SECRET>
 *
 * If ADMIN_SECRET is not set, all requests pass through (development mode).
 */
module.exports = function adminAuth(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return next();

  const fromQuery = req.query.secret;
  const fromHeader = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (fromQuery === secret || fromHeader === secret) return next();

  res.status(401).json({
    error: 'Unauthorized. Pass ?secret=<ADMIN_SECRET> or Authorization: Bearer <secret>.',
  });
};
