// Phase 12 (SECURITY.md F-G): per-address lockout after 10 failed password attempts in 15 minutes; the IP comes from
// Vercel's x-real-ip (else the first x-forwarded-for hop); a forged header cannot reset someone else's counter; the
// global failure count raises one alert and locks nobody out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', MAISTRO_SESSION_SECRET: 'test-session', MAISTRO_APP_PASSWORD: 'right-horse-battery', SUPABASE_ANON_KEY: undefined };
const login = async (h, password, headers) => { const r = res(); await h.handler(req({ method: 'POST', body: { password }, headers, session: false }), r); return r; };

test('10 failures from one address lock that address (429 + Retry-After); another address is not affected; a success clears only its own address', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const h = api('login.js', ENV);
  try {
    const A = { 'x-real-ip': '203.0.113.7' }, B = { 'x-real-ip': '198.51.100.9' };
    for (let i = 0; i < 10; i++) assert.equal((await login(h, 'guess' + i, A)).statusCode, 401);
    let r = await login(h, 'right-horse-battery', A);
    assert.equal(r.statusCode, 429, 'locked even with the right password'); assert.equal(r.body.code, 'throttled');
    assert.ok(Number(r.headers['retry-after']) > 0 && Number(r.headers['retry-after']) <= 900);
    assert.equal((await login(h, 'right-horse-battery', B)).statusCode, 204, 'another address signs in');
    // a forged header: the attacker's real address is C (x-real-ip), x-forwarded-for claims A — the success is C's
    assert.equal((await login(h, 'right-horse-battery', { 'x-real-ip': '192.0.2.50', 'x-forwarded-for': '203.0.113.7' })).statusCode, 204);
    assert.equal((await login(h, 'right-horse-battery', A)).statusCode, 429, 'A is still locked: a forged x-forwarded-for did not reset it');
    // without x-real-ip, the first x-forwarded-for hop is the address
    for (let i = 0; i < 10; i++) await login(h, 'x', { 'x-forwarded-for': '100.64.0.1, 10.0.0.1' });
    assert.equal((await login(h, 'right-horse-battery', { 'x-forwarded-for': '100.64.0.1, 10.0.0.2' })).statusCode, 429);
    assert.ok(pg.tables.login_attempts.every((x) => /^[0-9a-f]{64}$/.test(x.ip_hash) && !('ip' in x)), 'only salted hashes are stored');
  } finally { f.restore(); h.restore(); }
});

test('more than 50 failures in an hour across addresses raise one ops alert and lock nobody else out', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const h = api('login.js', ENV);
  try {
    for (let i = 0; i < 55; i++) await login(h, 'x', { 'x-real-ip': `203.0.113.${i}` });
    const alerts = (pg.tables.ops_alerts || []).filter((a) => a.kind === 'login.global_failures');
    assert.equal(alerts.length, 1, 'one alert per hour, not one per failure');
    assert.equal((await login(h, 'right-horse-battery', { 'x-real-ip': '198.51.100.200' })).statusCode, 204, 'the owner is not locked out by a global count');
  } finally { f.restore(); h.restore(); }
});
