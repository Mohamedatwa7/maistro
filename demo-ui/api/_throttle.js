// Login throttling (SECURITY.md F-G, Phase 12). Lockout is per client IP — a salted sha256, never the raw IP:
// after MAX_FAILS failed password attempts in WINDOW_MIN minutes (counted since that IP's last success) the
// login answers 429 with Retry-After. A global failure count only raises an ops alert: a lockout for everyone
// would let an attacker deny the owner access. If the store is unreachable, login still works (fail open,
// logged) — the password itself is the control; the throttle limits guessing.
const crypto = require('node:crypto');
const { queryRows, insertRows, deleteRows } = require('./_supabase.js');

const MAX_FAILS = 10, WINDOW_MIN = 15, GLOBAL_ALERT_PER_H = 50, KEEP_DAYS = 7;

/** The client IP as Vercel reports it: x-real-ip, else the first x-forwarded-for hop. Vercel sets both from the
 *  connection, so a header the client adds cannot choose whose counter it touches. */
function clientIp(req) {
  const h = req.headers || {};
  const real = String(h['x-real-ip'] || '').trim();
  if (real) return real;
  const first = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return first || 'unknown';
}
const ipHash = (ip) => crypto.createHash('sha256').update(`${process.env.MAISTRO_IP_SALT || process.env.MAISTRO_SESSION_SECRET || 'maistro'}|${ip}`).digest('hex');

/** null when allowed; { retryAfterS } when this IP is locked out */
async function check(req, now = Date.now()) {
  const h = ipHash(clientIp(req));
  try {
    const since = new Date(now - WINDOW_MIN * 6e4).toISOString();
    const rows = await queryRows('login_attempts', `select=ok,at&ip_hash=eq.${h}&at=gte.${since}&order=at.desc&limit=200`);
    const fails = [];
    for (const r of rows) { if (r.ok) break; fails.push(r); } // failures since the last success
    if (fails.length < MAX_FAILS) return null;
    const oldest = Date.parse(fails[MAX_FAILS - 1].at);
    return { retryAfterS: Math.max(1, Math.ceil((oldest + WINDOW_MIN * 6e4 - now) / 1000)) };
  } catch (e) { console.error('[login] throttle check failed (allowing):', e.message); return null; }
}

/** record the attempt; on a failure, raise one global alert per hour when failures across all IPs pass the mark */
async function record(req, ok, now = Date.now()) {
  try {
    await insertRows('login_attempts', [{ ip_hash: ipHash(clientIp(req)), ok, at: new Date(now).toISOString() }]);
    if (ok) return;
    const hourAgo = new Date(now - 36e5).toISOString();
    const recent = await queryRows('login_attempts', `select=ok&ok=eq.false&at=gte.${hourAgo}&limit=${GLOBAL_ALERT_PER_H + 1}`);
    if (recent.length > GLOBAL_ALERT_PER_H) {
      const open = await queryRows('ops_alerts', `select=id&kind=eq.login.global_failures&at=gte.${hourAgo}&limit=1`);
      if (!open.length) await insertRows('ops_alerts', [{ at: new Date(now).toISOString(), kind: 'login.global_failures', severity: 'warning', message: `more than ${GLOBAL_ALERT_PER_H} failed logins in the last hour across all addresses (per-address lockout still applies; nobody else is locked out)`, details: { threshold: GLOBAL_ALERT_PER_H } }]);
    }
    if (Math.random() < 0.05) await deleteRows('login_attempts', `at=lt.${new Date(now - KEEP_DAYS * 864e5).toISOString()}`);
  } catch (e) { console.error('[login] throttle record failed:', e.message); }
}

module.exports = { check, record, clientIp, ipHash, MAX_FAILS, WINDOW_MIN, GLOBAL_ALERT_PER_H };
