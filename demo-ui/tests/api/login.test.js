// Interim login (M1): session cookie issuance/verification and the gate on spend endpoints.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, anthropicReply } = require('../helpers');
const { makeSessionCookieValue, verifySession, SESSION_COOKIE } = require('../../api/_auth.js');

const ENV = { MAISTRO_SESSION_SECRET: 'sess-secret', MAISTRO_APP_PASSWORD: 'open-sesame' };
const cookieFor = (secret, nowMs) => `${SESSION_COOKIE}=${makeSessionCookieValue(secret, nowMs)}`;

test('login: GET reports configured/authenticated; POST sets an HttpOnly Secure cookie; wrong password 401; DELETE clears', async () => {
  const h = api('login.js', ENV);
  try {
    let r = res(); await h.handler(req({ session: false }), r);
    assert.deepEqual(r.body, { configured: true, authenticated: false });
    r = res(); await h.handler(req({ method: 'POST', body: { password: 'nope' }, session: false }), r);
    assert.equal(r.statusCode, 401);
    r = res(); await h.handler(req({ method: 'POST', body: { password: 'open-sesame' } }), r);
    assert.equal(r.statusCode, 204);
    const setCookie = r.headers['set-cookie'];
    assert.match(setCookie, /^maistro_session=\d+\.[A-Za-z0-9_-]+; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
    const cookie = setCookie.split(';')[0];
    r = res(); await h.handler(req({ headers: { cookie } }), r);
    assert.deepEqual(r.body, { configured: true, authenticated: true });
    r = res(); await h.handler(req({ method: 'DELETE' }), r);
    assert.equal(r.statusCode, 204); assert.match(r.headers['set-cookie'], /Max-Age=0/);
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally { h.restore(); }
});

test('login: unconfigured server → 503 on POST, configured:false on GET', async () => {
  const h = api('login.js', { MAISTRO_SESSION_SECRET: undefined, MAISTRO_APP_PASSWORD: undefined });
  try {
    let r = res(); await h.handler(req({ method: 'POST', body: { password: 'x' } }), r); assert.equal(r.statusCode, 503);
    r = res(); await h.handler(req({ session: false }), r); assert.deepEqual(r.body, { configured: false, authenticated: false });
  } finally { h.restore(); }
});

test('verifySession: expiry, tampering and a different secret all fail', () => {
  const now = Date.UTC(2026, 9, 21, 10);
  const c = cookieFor('s', now);
  assert.equal(verifySession(c, 's', now), true);
  assert.equal(verifySession(c, 's', now + 31 * 24 * 3600 * 1000), false, 'expired');
  assert.equal(verifySession(c, 'other', now), false, 'wrong secret');
  assert.equal(verifySession(c.replace(/\.(.)/, '.x'), 's', now), false, 'tampered mac');
  assert.equal(verifySession(c.replace(/=\d+/, '=9999999999'), 's', now), false, 'tampered expiry');
  assert.equal(verifySession('other=1', 's', now), false);
  assert.equal(verifySession(c, '', now), false, 'no secret configured');
});

test('gate: hermes, director, higgsfield, qc-f1x8, upload, translate refuse without a session (401), 503 when unconfigured', async () => {
  const f = mockFetch([['api.anthropic.com', () => anthropicReply({ title: 't', product: 'p', msg: 'm', angle: 'a', markets: [], platforms: [], themeDark: '#000000', themeAccent: '#111111' })]]);
  const cases = [
    ['hermes.js', { method: 'POST', body: { stage: 'plan', trend: { name: 'T' } } }, { ANTHROPIC_API_KEY: 'k' }],
    ['director.js', { method: 'POST', body: { stage: 'mood', campaign: { title: 'C' } } }, { ANTHROPIC_API_KEY: 'k' }],
    ['higgsfield.js', { method: 'POST', body: { kind: 'image', prompt: 'p' } }, { HF_CREDENTIALS: 'a:b' }],
    ['higgsfield.js', { method: 'GET', query: { id: 'abcdefgh1234' } }, { HF_CREDENTIALS: 'a:b' }],
    ['qc-f1x8.js', { method: 'GET', query: { job: 'job-1' } }, {}],
    ['upload.js', { method: 'POST', body: { data: 'aGk=' } }, { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }],
    ['translate.js', { method: 'POST', body: { text: 'hi' } }, {}],
  ];
  try {
    for (const [file, request, env] of cases) {
      let h = api(file, { ...env, MAISTRO_SESSION_SECRET: 'sess' });
      let r = res(); await h.handler(req({ ...request, session: false }), r);
      assert.equal(r.statusCode, 401, `${file} without cookie`); assert.deepEqual(r.body, { error: 'login required' });
      r = res(); await h.handler(req({ ...request, headers: { cookie: cookieFor('sess') } }), r);
      assert.notEqual(r.statusCode, 401, `${file} with a valid cookie passes the gate`);
      h.restore();
      h = api(file, { ...env, MAISTRO_SESSION_SECRET: undefined });
      r = res(); await h.handler(req({ ...request, headers: { cookie: cookieFor('sess') } }), r);
      assert.equal(r.statusCode, 503, `${file} fails closed when unconfigured`);
      h.restore();
    }
    // the public contracts stay open: trends (external agent), ingest (bearer), projects/sentiment/track GET
  } finally { f.restore(); }
});
