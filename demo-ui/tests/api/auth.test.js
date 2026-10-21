// api/_auth.js: constant-time bearer match; cron detection prefers CRON_SECRET.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bearerMatches, isCron } = require('../../api/_auth.js');
const { api, req, res, mockFetch, json } = require('../helpers');

test('bearerMatches: exact token only, case-insensitive scheme, no secret → false', () => {
  assert.equal(bearerMatches('Bearer abc', 'abc'), true);
  assert.equal(bearerMatches('bearer abc', 'abc'), true);
  assert.equal(bearerMatches('Bearer abd', 'abc'), false);
  assert.equal(bearerMatches('Bearer ab', 'abc'), false);
  assert.equal(bearerMatches('abc', 'abc'), false);
  assert.equal(bearerMatches('Bearer abc', ''), false);
  assert.equal(bearerMatches(undefined, 'abc'), false);
});

test('isCron: with CRON_SECRET only the bearer counts; without it the user-agent rule remains', () => {
  process.env.CRON_SECRET = 's3cret';
  assert.equal(isCron({ headers: { 'user-agent': 'vercel-cron/1.0' } }), false, 'forged UA is not enough');
  assert.equal(isCron({ headers: { authorization: 'Bearer s3cret' } }), true);
  delete process.env.CRON_SECRET;
  assert.equal(isCron({ headers: { 'user-agent': 'vercel-cron/1.0' } }), true);
  assert.equal(isCron({ headers: { 'user-agent': 'Mozilla/5.0' } }), false);
});

test('track: with CRON_SECRET set, a forged cron user-agent does not store; the real bearer does', async () => {
  const stores = [];
  const f = mockFetch([
    ['https://maistro.test/rest/v1/sentiment_posts', (u, init) => { stores.push(1); return new Response('', { status: 201 }); }],
    ['/social_posts?', (u) => json(u.includes('platform=eq.instagram') ? [{ external_id: 'p1', platform: 'instagram', post_url: 'https://www.instagram.com/p/ABC/', published_at: new Date(Date.now() - 864e5).toISOString(), caption: 'x', views_count: 1, likes_count: 0, comments_count: 0, shares_count: 0, raw_data: {} }] : [])],
    ['/social_comments?', () => json([])],
  ]);
  const h = api('track.js', { TRACK_SUPABASE_URL: 'https://tracker.test', TRACK_SUPABASE_KEY: 'k', SUPABASE_URL: 'https://maistro.test', SUPABASE_SERVICE_ROLE_KEY: 'k', MAISTRO_INGEST_KEY: 'ingest', CRON_SECRET: 'cron-s' });
  try {
    let r = res(); await h.handler(req({ headers: { 'user-agent': 'vercel-cron/1.0' } }), r);
    assert.equal(r.body.stored, null); assert.equal(stores.length, 0); assert.equal(r.body.days, 60);
    r = res(); await h.handler(req({ headers: { authorization: 'Bearer cron-s' } }), r);
    assert.deepEqual(r.body.stored, { rows: 1 }); assert.equal(stores.length, 1);
  } finally { f.restore(); h.restore(); }
});
