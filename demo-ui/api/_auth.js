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

module.exports = { bearerMatches, isCron };
