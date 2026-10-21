// api/[route].js: every legacy URL still reaches its handler; unknown routes 404; `route` never leaks into handler queries.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res } = require('../helpers');

test('dispatcher maps the fifteen routes and strips its own query parameter', async () => {
  const h = api('[route].js', { MAISTRO_SESSION_SECRET: undefined });
  try {
    assert.deepEqual(Object.keys(h.handler.ROUTES).sort(), ['decisions', 'director', 'health', 'hermes', 'higgsfield', 'ingest', 'login', 'pieces', 'projects', 'qc-f1x8', 'sentiment', 'track', 'translate', 'trends', 'upload']);
    let r = res(); await h.handler(req({ query: { route: 'nope' }, session: false }), r);
    assert.equal(r.statusCode, 404); assert.deepEqual(r.body, { error: 'unknown route /api/nope' });
    r = res(); await h.handler(req({ query: { route: '../_http' }, session: false }), r);
    assert.equal(r.statusCode, 404, 'no path traversal');
    r = res(); await h.handler(req({ query: { route: 'health' }, session: false }), r);
    assert.equal(r.statusCode, 503); assert.equal(r.body.ok, false); assert.ok(r.body.missing.includes('ANTHROPIC_API_KEY'));
    r = res(); await h.handler(req({ method: 'POST', query: { route: 'ingest' }, body: {}, session: false }), r);
    assert.equal(r.statusCode, 503, 'ingest handler reached (no key configured → 503)');
    const q = { route: 'qc-f1x8', job: 'x' };
    r = res(); await h.handler(req({ method: 'GET', query: q, session: false }), r);
    assert.equal(r.statusCode, 503, 'gated handler reached; fails closed without session secret');
    assert.equal(q.route, undefined, 'route parameter removed before the handler sees the query');
  } finally { h.restore(); }
});

test('health reports every configured name when all are present', async () => {
  const env = Object.fromEntries(['ANTHROPIC_API_KEY', 'HF_CREDENTIALS', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TRACK_SUPABASE_URL', 'TRACK_SUPABASE_KEY', 'MAISTRO_INGEST_KEY', 'CRON_SECRET', 'MAISTRO_SESSION_SECRET', 'MAISTRO_APP_PASSWORD', 'MAISTRO_DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'].map((k) => [k, 'x']));
  const h = api('health.js', env);
  try {
    const r = res(); await h.handler(req({ session: false }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.ok, true); assert.deepEqual(r.body.missing, []);
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally { h.restore(); }
});
