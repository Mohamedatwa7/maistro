// App login.
//
//   GET    /api/login   → { configured, authenticated, member|null,
//                           auth: { url, anonKey, magicLink: boolean } }
//                         (the anon key is public by design; the page needs
//                         it to request a magic link from GoTrue)
//   POST   /api/login   { access_token }  → member session (Supabase Auth,
//                                            ADR-003): 204 + Set-Cookie;
//                                            401 bad token; 403 not a member
//          /api/login   { password }      → interim shared-password session
//                                            (M1) while MAISTRO_APP_PASSWORD
//                                            is set; unset it to retire it
//   DELETE /api/login   → 204, cookie cleared
const { bearerMatches, makeSessionCookieValue, readSession, sessionCookieHeader } = require('../_auth.js');
const { cfg, verifyAccessToken, memberForUser } = require('../_members.js');

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
      auth: { url: auth.url || null, anonKey: auth.ready ? auth.anon : null, magicLink: auth.ready, password: Boolean(password) },
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
  const given = String(b.password || '');
  if (!given || !bearerMatches(`Bearer ${given}`, password)) {
    return res.status(401).json({ error: 'wrong password' });
  }
  res.setHeader('Set-Cookie', sessionCookieHeader(makeSessionCookieValue(secret)));
  return res.status(204).end();
};
