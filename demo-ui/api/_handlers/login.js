// App login.
//
//   GET    /api/login   → { configured, authenticated, member|null,
//                           auth: { magicLink, password } }
//   POST   /api/login   { email }         → sends a magic link when the
//                                            address is an active member or a
//                                            bootstrap admin; answers 200
//                                            {ok} either way (no enumeration)
//   POST   /api/login   { access_token }  → member session (Supabase Auth,
//                                            ADR-003): 204 + Set-Cookie;
//                                            401 bad token; 403 not a member
//          /api/login   { password }      → interim shared-password session
//                                            (M1) while MAISTRO_APP_PASSWORD
//                                            is set; unset it to retire it
//   DELETE /api/login   → 204, cookie cleared
const { bearerMatches, makeSessionCookieValue, readSession, sessionCookieHeader } = require('../_auth.js');
const { cfg, verifyAccessToken, memberForUser, requestLink } = require('../_members.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.MAISTRO_SESSION_SECRET;
  const password = process.env.MAISTRO_APP_PASSWORD;
  const auth = cfg();
  const configured = Boolean(secret && (password || auth.ready));

  if (req.method === 'GET') {
    const s = secret ? readSession((req.headers || {}).cookie, secret) : null;
    return res.status(200).json({
      configured,
      authenticated: Boolean(s),
      member: s && s.member ? { email: s.member.email, role: s.member.role, name: s.member.name } : null,
      auth: { magicLink: auth.ready, password: Boolean(password) },
    });
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
  const b = req.body || {};

  if (b.email && !b.access_token && !b.password) {
    try {
      const proto = String(req.headers['x-forwarded-proto'] || 'https');
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
      await requestLink(String(b.email), host ? `${proto}://${host}/` : undefined);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(e && e.status ? e.status : 502).json({ error: String((e && e.message) || e) });
    }
  }

  if (b.access_token) {
    if (!auth.ready) return res.status(503).json({ error: 'member sign-in is not configured on the server' });
    try {
      const user = await verifyAccessToken(String(b.access_token));
      if (!user) return res.status(401).json({ error: 'sign-in link is invalid or expired' });
      const member = await memberForUser(user);
      if (!member || !member.active) return res.status(403).json({ error: `${user.email} is not a Maistro member — ask an admin to invite you`, code: 'not_a_member' });
      res.setHeader('Set-Cookie', sessionCookieHeader(makeSessionCookieValue(secret, Date.now(), undefined, member)));
      return res.status(200).json({ ok: true, member: { email: member.email, role: member.role, name: member.name } });
    } catch (e) {
      return res.status(502).json({ error: String((e && e.message) || e) });
    }
  }

  if (!password) return res.status(401).json({ error: 'password login is retired — use your sign-in link' });
  // Phase 12 (SECURITY.md F-G): per-address lockout after repeated failures
  const throttle = require('../_throttle.js');
  const locked = await throttle.check(req);
  if (locked) {
    res.setHeader('Retry-After', String(locked.retryAfterS));
    return res.status(429).json({ error: `too many failed attempts from this address — try again in ${Math.ceil(locked.retryAfterS / 60)} min, or use your sign-in link`, code: 'throttled', retryAfterS: locked.retryAfterS });
  }
  const given = String(b.password || '');
  if (!given || !bearerMatches(`Bearer ${given}`, password)) {
    await throttle.record(req, false);
    return res.status(401).json({ error: 'wrong password' });
  }
  await throttle.record(req, true);
  res.setHeader('Set-Cookie', sessionCookieHeader(makeSessionCookieValue(secret)));
  return res.status(204).end();
};
