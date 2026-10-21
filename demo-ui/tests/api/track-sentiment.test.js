// Characterization + golden: /api/track (cron fallback, cache, twin collapse) and /api/sentiment.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { req, res, api, mockFetch, json, fixture } = require('../helpers');

const ENV = { TRACK_SUPABASE_URL: 'https://tracker.test', TRACK_SUPABASE_KEY: 'k', SUPABASE_URL: 'https://maistro.test', SUPABASE_SERVICE_ROLE_KEY: 'k', MAISTRO_INGEST_KEY: 'ingest' };

// One Samsung post + comments; the comments query fails with a statement timeout for a given window when asked.
function trackerRoutes({ failCommentsForDays = null, stores = [] } = {}) {
  return [
    ['https://maistro.test/rest/v1/sentiment_posts', (u, init) => { stores.push(JSON.parse(init.body)); return new Response('', { status: 201 }); }],
    ['/social_posts?', (u) => {
      if (!u.includes('platform=eq.instagram')) return json([]);
      return json([{ external_id: 'p1', platform: 'instagram', post_url: 'https://www.instagram.com/p/ABC/', published_at: new Date(Date.now() - 2 * 864e5).toISOString(), caption: 'x', views_count: 10, likes_count: 1, comments_count: 2, shares_count: 0, raw_data: {} }]);
    }],
    ['/social_comments?', (u) => {
      const m = u.match(/published_at=gte\.([^&]+)/);
      const days = Math.round((Date.now() - new Date(decodeURIComponent(m[1]))) / 864e5) - 3;
      if (failCommentsForDays && Math.abs(days - failCommentsForDays) <= 1) return json({ message: 'canceling statement due to statement timeout', code: '57014' }, 500);
      return json([
        { id: 1, external_post_id: 'p1', platform: 'instagram', author_username: 'amal', text: 'Love it', sentiment: 'positive', likes_count: 3, published_at: new Date(Date.now() - 864e5).toISOString() },
        { id: 2, external_post_id: 'p1', platform: 'instagram', author_username: 'amal', text: 'Love it', sentiment: null, likes_count: 1, published_at: new Date(Date.now() - 864e5 + 61000).toISOString() }, // twin, a minute apart
      ]);
    }],
  ];
}

async function run(ua, query, opts) {
  const stores = [];
  const f = mockFetch(trackerRoutes({ ...opts, stores }));
  const h = api('track.js', ENV);
  try {
    const r = res();
    await h.handler(req({ query, headers: { 'user-agent': ua, ...(opts && opts.auth ? { authorization: opts.auth } : {}) } }), r);
    return { r, stores, calls: f.calls };
  } finally { f.restore(); h.restore(); }
}

test('browser read: shape, twin collapse (author+text, a minute apart), cache header, nothing stored', async () => {
  const { r, stores, calls } = await run('Mozilla/5.0', { days: '14' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.days, 14);
  assert.equal(r.body.count, 1);
  assert.deepEqual(r.body.comments, { seen: 2, matched: 2, partial: false });
  const p = r.body.posts[0];
  assert.deepEqual(Object.keys(p).sort(), ['account', 'caption', 'comments', 'mediaType', 'metrics', 'platform', 'postId', 'postedAt', 'url']);
  assert.deepEqual(Object.keys(p.metrics).sort(), ['comments', 'er', 'likes', 'shares', 'thumb', 'views']);
  assert.equal(p.comments.length, 1, 'the twin collapsed');
  assert.equal(p.comments[0].sentiment, 'pos', 'the analyzed copy wins; sentiment mapped to pos/neu/neg');
  assert.equal(p.comments[0].likes, 3);
  assert.equal(r.headers['cache-control'], 's-maxage=600, stale-while-revalidate=86400');
  assert.equal(stores.length, 0);
  assert.equal(r.body.stored, null);
  assert.ok(calls.some((c) => c.url.includes('platform=eq.instagram&raw_data->>ownerUsername=ilike.*samsung*')), 'Samsung-account predicate');
});

test('cron: 60-day read stored; partial 60-day read falls back to 14 days and stores that', async () => {
  let out = await run('vercel-cron/1.0', {});
  assert.equal(out.r.body.days, 60); assert.deepEqual(out.r.body.stored, { rows: 1 }); assert.equal(out.stores.length, 1);
  assert.equal(out.stores[0][0].post_id, 'p1');
  out = await run('vercel-cron/1.0', {}, { failCommentsForDays: 60 });
  assert.equal(out.r.body.days, 14); assert.deepEqual(out.r.body.stored, { rows: 1 }); assert.equal(out.r.body.comments.partial, false);
});

test('browser partial read is served with no-store and never stored; authorized ?store=1 stores', async () => {
  let out = await run('Mozilla/5.0', { days: '60' }, { failCommentsForDays: 60 });
  assert.equal(out.r.statusCode, 200); assert.equal(out.r.body.comments.partial, true); assert.equal(out.r.headers['cache-control'], 'no-store'); assert.equal(out.stores.length, 0);
  out = await run('Mozilla/5.0', { days: '14', store: '1' }, { auth: 'Bearer ingest' });
  assert.deepEqual(out.r.body.stored, { rows: 1 });
});

test('missing env → 503', async () => {
  const h = api('track.js', { TRACK_SUPABASE_URL: undefined, TRACK_SUPABASE_KEY: undefined });
  try { const r = res(); await h.handler(req(), r); assert.equal(r.statusCode, 503); } finally { h.restore(); }
});

test('golden: dedupeTwins on 402 recorded rows', () => {
  const { dedupeTwins } = api('track.js', ENV).handler;
  const rows = fixture('twin-rows.json');
  const byPost = new Map();
  for (const r of rows) (byPost.get(r.post) || byPost.set(r.post, []).get(r.post)).push(r);
  let before = 0, after = 0;
  for (const list of byPost.values()) { before += list.length; after += dedupeTwins(list).length; }
  assert.equal(before, 402);
  assert.equal(after, 374, 'frozen on 2026-10-21 from the live 60-day payload; a change here is a behaviour change');
  // invariant: never two survivors with the same author+normalised text in one post
  for (const list of byPost.values()) {
    const seen = new Set();
    for (const c of dedupeTwins(list)) {
      const k = String(c.author_username).trim().toLowerCase() + '|' + String(c.text).replace(/\s+/g, ' ').trim();
      assert.ok(!seen.has(k)); seen.add(k);
    }
  }
});

test('sentiment GET: latest snapshot per post, sorted newest post first; POST needs the ingest key', async () => {
  const rows = [ // at.desc
    { post_id: 'a', platform: 'tiktok', account: '@samsunggulf', caption: 'new', url: 'u', posted_at: '2026-10-10T00:00:00Z', metrics: { views: 2 }, sentiment: {}, comments: [], at: '2026-10-12T00:00:00Z' },
    { post_id: 'a', platform: 'tiktok', account: '@samsunggulf', caption: 'old', url: 'u', posted_at: '2026-10-10T00:00:00Z', metrics: { views: 1 }, sentiment: {}, comments: [], at: '2026-10-11T00:00:00Z' },
    { post_id: 'b', platform: 'instagram', account: '@samsunggulf', caption: 'b', url: 'u', posted_at: '2026-10-11T00:00:00Z', metrics: {}, sentiment: {}, comments: [], at: '2026-10-11T00:00:00Z' },
  ];
  const f = mockFetch([['https://maistro.test/rest/v1/sentiment_posts', (u, init) => (init.method === 'POST' ? new Response('', { status: 201 }) : json(rows))]]);
  const h = api('sentiment.js', ENV);
  try {
    let r = res(); await h.handler(req(), r);
    assert.equal(r.body.count, 2);
    assert.deepEqual(r.body.posts.map((p) => [p.postId, p.caption]), [['b', 'b'], ['a', 'new']]);
    assert.deepEqual(Object.keys(r.body.posts[0]).sort(), ['account', 'caption', 'comments', 'metrics', 'platform', 'postId', 'postedAt', 'sentiment', 'updatedAt', 'url']);
    r = res(); await h.handler(req({ method: 'POST', body: { postId: 'x' } }), r); assert.equal(r.statusCode, 401);
    r = res(); await h.handler(req({ method: 'PUT' }), r); assert.equal(r.statusCode, 405);
  } finally { f.restore(); h.restore(); }
});
