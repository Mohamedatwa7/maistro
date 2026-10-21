// Shared-secret checks for the functions (M1, AUDIT C-12, D-07).
//
// bearerMatches(header, secret): constant-time comparison of an
// `Authorization: Bearer <token>` header against a configured secret.
// isCron(req): true only for Vercel's cron invocation. Vercel sends
// `Authorization: Bearer ${CRON_SECRET}` when the project has CRON_SECRET;
// without that variable the only signal is the user-agent, which anyone can
// forge, so we log that the install is unprotected and keep the old rule
// until the variable exists (never silently disable the daily snapshot).
const crypto = require('node:crypto');

function bearerMatches(header, secret) {
  if (!secret) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  if (!m) return false;
  const a = Buffer.from(m[1].trim(), 'utf8');
  const b = Buffer.from(String(secret), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

let warnedNoCronSecret = false;
function isCron(req) {
  const headers = (req && req.headers) || {};
  const secret = process.env.CRON_SECRET;
  if (secret) return bearerMatches(headers.authorization, secret);
  if (!warnedNoCronSecret) {
    warnedNoCronSecret = true;
    console.warn('[auth] CRON_SECRET is not configured — cron detection falls back to the spoofable user-agent');
  }
  return /^vercel-cron/i.test(String(headers['user-agent'] || ''));
}

// ---- interim app session (M1, AUDIT D-01) -------------------------------
// Until Supabase Auth lands (ADR-003, milestone M2) the app is gated by ONE
// shared password: POST /api/login sets an HttpOnly cookie carrying an
// expiry and an HMAC over it; every endpoint that spends money or writes
// storage calls requireSession(). The cookie carries no identity (there is
// none yet), so approvals stay unattributed — that is M2's job, not this.
const SESSION_COOKIE = 'maistro_session';
const SESSION_TTL_S = 30 * 24 * 3600;

function sign(secret, payload) {
  return crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
}

function makeSessionCookieValue(secret, nowMs = Date.now(), ttlS = SESSION_TTL_S) {
  const exp = Math.floor(nowMs / 1000) + ttlS;
  return `${exp}.${sign(secret, String(exp))}`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function verifySession(cookieHeader, secret, nowMs = Date.now()) {
  if (!secret) return false;
  const v = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!v) return false;
  const [expS, mac] = v.split('.');
  if (!/^\d+$/.test(expS || '') || !mac) return false;
  if (Number(expS) * 1000 < nowMs) return false;
  const expect = Buffer.from(sign(secret, expS));
  const got = Buffer.from(mac);
  return expect.length === got.length && crypto.timingSafeEqual(expect, got);
}

function sessionCookieHeader(value, maxAgeS = SESSION_TTL_S) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;
}

// Gate for request handlers: true when the session is valid, otherwise the
// 401 is already written. Fails CLOSED when the secret is not configured.
function requireSession(req, res) {
  const secret = process.env.MAISTRO_SESSION_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'login is not configured on the server (MAISTRO_SESSION_SECRET)' });
    return false;
  }
  if (verifySession((req.headers || {}).cookie, secret)) return true;
  res.status(401).json({ error: 'login required' });
  return false;
}

module.exports = { bearerMatches, isCron, makeSessionCookieValue, verifySession, sessionCookieHeader, requireSession, SESSION_COOKIE, SESSION_TTL_S };
