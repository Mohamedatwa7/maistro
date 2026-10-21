// Interim app login (M1, AUDIT D-01) — one shared password, one HttpOnly
// session cookie. Replaced by Supabase Auth + roles in milestone M2.
//
//   GET    /api/login   → { authenticated: boolean, configured: boolean }
//   POST   /api/login   { password } → 204 + Set-Cookie, or 401 / 503
//   DELETE /api/login   → 204, cookie cleared
const { bearerMatches, makeSessionCookieValue, verifySession, sessionCookieHeader } = require('../_auth.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.MAISTRO_SESSION_SECRET;
  const password = process.env.MAISTRO_APP_PASSWORD;
  const configured = Boolean(secret && password);

  if (req.method === 'GET') {
    return res.status(200).json({ configured, authenticated: configured && verifySession((req.headers || {}).cookie, secret) });
  }
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', sessionCookieHeader('', 0));
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!configured) return res.status(503).json({ error: 'login is not configured on the server' });
  const given = String((req.body && req.body.password) || '');
  if (!given || !bearerMatches(`Bearer ${given}`, password)) {
    return res.status(401).json({ error: 'wrong password' });
  }
  res.setHeader('Set-Cookie', sessionCookieHeader(makeSessionCookieValue(secret)));
  return res.status(204).end();
};
