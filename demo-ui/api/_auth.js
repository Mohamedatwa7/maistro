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

// ---- app session --------------------------------------------------------
// One HttpOnly cookie, HMAC-signed with MAISTRO_SESSION_SECRET.
//   `${exp}.${mac}`                 — the interim shared-password session (M1):
//                                     no identity, approvals unattributed.
//   `${exp}.${member}.${mac}`       — a member session (M2 part 2 c, ADR-003):
//                                     `member` is base64url JSON {id, email,
//                                     role, name} issued after Supabase Auth
//                                     verified the person and the members
//                                     table said they are active.
// The mac covers everything before it, so neither the expiry nor the member
// can be edited client-side. requireSession() puts the member on req.member.
const SESSION_COOKIE = 'maistro_session';
const SESSION_TTL_S = 30 * 24 * 3600;

function sign(secret, payload) {
  return crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
}

function makeSessionCookieValue(secret, nowMs = Date.now(), ttlS = SESSION_TTL_S, member = null) {
  const exp = Math.floor(nowMs / 1000) + ttlS;
  if (!member) return `${exp}.${sign(secret, String(exp))}`;
  const m = Buffer.from(JSON.stringify({ id: member.id, email: member.email, role: member.role, name: member.name || null }), 'utf8').toString('base64url');
  return `${exp}.${m}.${sign(secret, `${exp}.${m}`)}`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Returns { member } (member null for a password session) when the cookie
// is valid, otherwise null.
function readSession(cookieHeader, secret, nowMs = Date.now()) {
  if (!secret) return null;
  const v = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!v) return null;
  const parts = v.split('.');
  if (parts.length !== 2 && parts.length !== 3) return null;
  const mac = parts[parts.length - 1];
  const signed = parts.slice(0, -1).join('.');
  const expS = parts[0];
  if (!/^\d+$/.test(expS || '') || !mac) return null;
  if (Number(expS) * 1000 < nowMs) return null;
  const expect = Buffer.from(sign(secret, signed));
  const got = Buffer.from(mac);
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return null;
  if (parts.length === 2) return { member: null };
  try {
    const m = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!m || !m.id || !m.role) return null;
    return { member: { id: String(m.id), email: String(m.email || ''), role: String(m.role), name: m.name ? String(m.name) : null } };
  } catch (e) { return null; }
}

function verifySession(cookieHeader, secret, nowMs = Date.now()) {
  return readSession(cookieHeader, secret, nowMs) !== null;
}

function sessionCookieHeader(value, maxAgeS = SESSION_TTL_S) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;
}

// Gate for request handlers: true when the session is valid, otherwise the
// 401 is already written. Fails CLOSED when the secret is not configured.
// Sets req.member (null for a password session).
function requireSession(req, res) {
  const secret = process.env.MAISTRO_SESSION_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'login is not configured on the server (MAISTRO_SESSION_SECRET)' });
    return false;
  }
  const s = readSession((req.headers || {}).cookie, secret);
  if (s) { req.member = s.member; return true; }
  res.status(401).json({ error: 'login required' });
  return false;
}

// Stricter gate: a member session with one of the given roles. Password
// sessions are refused (403) — identity is the point.
function requireRole(req, res, roles) {
  if (!requireSession(req, res)) return false;
  if (!req.member) { res.status(403).json({ error: 'a member sign-in is required for this action', code: 'member_required' }); return false; }
  if (roles && roles.length && !roles.includes(req.member.role)) { res.status(403).json({ error: `this action needs one of: ${roles.join(', ')}`, code: 'role_required' }); return false; }
  return true;
}

module.exports = { bearerMatches, isCron, makeSessionCookieValue, readSession, verifySession, sessionCookieHeader, requireSession, requireRole, SESSION_COOKIE, SESSION_TTL_S };
