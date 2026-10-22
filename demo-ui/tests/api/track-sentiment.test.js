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
      // the tracker also holds other projects' rows (ifold_ competitor/fan/news posts): only an excluding query avoids them
      if (u.includes('platform=eq.tiktok') && !u.includes('external_id=not.like.ifold%5C_*')) return json([{ external_id: 'ifold_7682900409832262945', platform: 'tiktok', post_url: 'https://www.tiktok.com/@samsung_galaxy2026/video/7682900409832262945', published_at: new Date(Date.now() - 864e5).toISOString(), caption: 'iPhone Fold vs Z Fold8', views_count: 1126218, likes_count: 9, comments_count: 0, shares_count: 0 }]);
      if (!u.includes('platform=eq.instagram')) return json([]);
      return json([{ external_id: 'p1', platform: 'instagram', owner_ig: 'samsunggulf', post_url: 'https://www.instagram.com/p/ABC/', published_at: new Date(Date.now() - 2 * 864e5).toISOString(), caption: 'x', views_count: 10, likes_count: 1, comments_count: 2, shares_count: 0, raw_data: {} }]);
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
    { post_id: 'ifold_7682900409832262945', platform: 'tiktok', account: 'samsung_galaxy2026', caption: 'iPhone Fold vs Z Fold8', url: 'u', posted_at: '2026-10-11T00:00:00Z', metrics: { views: 1126218 }, sentiment: {}, comments: [], at: '2026-10-11T00:00:00Z' }, // stored before the fix
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

test('reconcile (7.0): reader counts vs database counts, twins removed, alias-only matches, window boundary rules and freshness; ingest key or cron only; never cached', async () => {
  const counts = { posts: { instagram: 1, tiktok: 0, facebook: 0, twitter: 0 }, commentsSeen: 2, canonical: 2 }; const windows = [];
  const headRoute = [(u, init) => (init.method || 'GET') === 'HEAD', (u) => {
    let n = 0;
    if (u.includes('/social_posts?')) { const m = u.match(/platform=eq\.(\w+)/); n = counts.posts[m[1]] ?? 0; }
    else if (u.includes('external_post_id=in.')) n = counts.canonical;
    else if (u.includes('/social_comments?')) { const ge = u.match(/published_at=gte\.([^&]+)/), lt = u.match(/published_at=lt\.([^&]+)/); const at = Date.now() - 864e5; const a = ge ? Date.parse(decodeURIComponent(ge[1])) : 0, b = lt ? Date.parse(decodeURIComponent(lt[1])) : Infinity; n = at >= a && at < b ? counts.commentsSeen : 0; windows.push([a, b]); }
    return new Response('', { status: 206, headers: { 'content-range': `0-0/${n}` } });
  }];
  const f = mockFetch([headRoute, ...trackerRoutes()]);
  const h = api('track.js', ENV);
  try {
    let r = res(); await h.handler(req({ query: { days: '14', reconcile: '1' }, headers: { 'user-agent': 'Mozilla/5.0' } }), r);
    assert.equal(r.statusCode, 200); assert.ok(Array.isArray(r.body.posts), 'without the key reconcile is ignored and the normal payload is served');
    r = res(); await h.handler(req({ query: { days: '14', reconcile: '1' }, headers: { 'user-agent': 'Mozilla/5.0', authorization: 'Bearer ingest' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.headers['cache-control'], 'no-store');
    const R = r.body;
    assert.equal(R.days, 14); assert.deepEqual(R.posts.instagram, { reader: 1, db: 1, equal: true }); assert.equal(R.posts.tiktok.equal, true);
    assert.deepEqual(R.sums.instagram, { views: 10, likes: 1, commentsCount: 2, shares: 0 });
    assert.equal(R.comments.seen, 2); assert.equal(R.comments.dbSeen, 2); assert.equal(R.comments.matched, 2); assert.equal(R.comments.dbMatchedCanonical, 2); assert.equal(R.comments.aliasOnly, 0);
    assert.equal(R.comments.deduped, 1); assert.equal(R.comments.twinsRemoved, 1); assert.equal(R.comments.matchRate, 1);
    assert.deepEqual(R.checks, { R1_posts: true, R3_commentsSeen: true, R4_matchedLowerBound: true, R6_postsUniqueById: true, R8_ownedAccountsOnly: true }); assert.equal(R.ok, true);
    assert.equal(R.boundary.rolling, 1); assert.equal(R.boundary.calendarDubai, 1); assert.equal(R.boundary.calendarUtc, 1); assert.deepEqual(R.boundary.withinADayOfSince, []);
    assert.ok(R.freshness.instagram.newestPost); assert.ok(R.freshness.instagram.newestComment);
    // a database count that disagrees shows up as a failed check, with the numbers
    counts.posts.instagram = 3; counts.commentsSeen = 5;
    r = res(); await h.handler(req({ query: { days: '14', reconcile: '1' }, headers: { 'user-agent': 'Mozilla/5.0', authorization: 'Bearer ingest' } }), r);
    assert.equal(r.body.ok, false); assert.deepEqual(r.body.posts.instagram, { reader: 1, db: 3, equal: false }); assert.equal(r.body.checks.R3_commentsSeen, false); assert.equal(r.body.comments.dbSeen, 5); assert.ok(windows.length >= 3 && windows.every(([a, b]) => b === Infinity || b - a <= 7 * 864e5), 'counted in windows of at most 7 days'); assert.equal(windows.at(-1)[1], Infinity, 'the last window is open-ended like the reader');
    assert.equal(r.body.posts, r.body.posts); assert.equal('posts' in r.body && !Array.isArray(r.body.posts), true, 'a report, not page data');
  } finally { f.restore(); h.restore(); }
});

test('reconcile (7.0): the daily cron stores a reconciliation report row next to the snapshot; ?reconcile=latest reads the series back for a session holder', async () => {
  const reports = [];
  // comment counts are per 7-day window: only the window holding the fixture comments (a day old) counts them
  const inWindow = (u) => { const ge = u.match(/published_at=gte\.([^&]+)/), lt = u.match(/published_at=lt\.([^&]+)/); const at = Date.now() - 864e5; return (!ge || at >= Date.parse(decodeURIComponent(ge[1]))) && (!lt || at < Date.parse(decodeURIComponent(lt[1]))); };
  const headRoute = [(u, init) => (init.method || 'GET') === 'HEAD', (u) => new Response('', { status: 206, headers: { 'content-range': u.includes('/social_posts?') ? (u.includes('platform=eq.instagram') ? '0-0/1' : '0-0/0') : (inWindow(u) ? '0-0/2' : '0-0/0') } })];
  const f = mockFetch([
    headRoute,
    ['https://maistro.test/rest/v1/reconciliation_reports', (u, init) => { if (init.method === 'POST') { reports.push(JSON.parse(init.body)); return new Response('', { status: 201 }); } return json(reports.map((r, i) => ({ id: i + 1, at: '2026-10-21T06:30:00Z', ...r }))); }],
    ...trackerRoutes(),
  ]);
  const h = api('track.js', { ...ENV, CRON_SECRET: 'cron' });
  try {
    let r = res(); await h.handler(req({ query: { cron: '1' } }), r); assert.equal(r.statusCode, 401, 'the cron URL is cron-only'); assert.equal(r.headers['cache-control'], 'no-store');
    r = res(); await h.handler(req({ query: { cron: '1' }, headers: { authorization: 'Bearer cron' } }), r);
    assert.equal(r.headers['cache-control'], 'no-store', 'a cron response is never cached (the edge cache once swallowed the 06:30 cron)');
    const vj = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'vercel.json'), 'utf8')); assert.ok(vj.crons.some((c) => c.path.startsWith('/api/track?cron=1') && c.schedule === '30 6 * * *'), 'the track cron has its own URL, distinct from the page read');
    assert.equal(r.statusCode, 200); assert.deepEqual(r.body.reconciled, { ok: true, checks: { R1_posts: true, R3_commentsSeen: true, R4_matchedLowerBound: true, R6_postsUniqueById: true, R8_ownedAccountsOnly: true } });
    assert.equal(reports.length, 1); assert.equal(reports[0].ok, true); assert.equal(reports[0].days, 60); assert.equal(reports[0].report.comments.twinsRemoved, 1);
    r = res(); await h.handler(req({ query: { reconcile: 'latest' }, session: false }), r); assert.equal(r.statusCode, 401);
    r = res(); await h.handler(req({ query: { reconcile: 'latest' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.count, 1); assert.equal(r.body.reports[0].ok, true); assert.equal(r.headers['cache-control'], 'no-store');
  } finally { f.restore(); h.restore(); }
});

test('population: posts from other tracker projects (ifold_ competitor, fan and news rows) never reach the Performance data', async () => {
  const out = await run('Mozilla/5.0', { days: '14' });
  assert.equal(out.r.statusCode, 200);
  assert.ok(out.r.body.posts.length >= 1, 'the Samsung post is there');
  assert.ok(out.r.body.posts.every((p) => !String(p.postId).startsWith('ifold_')), JSON.stringify(out.r.body.posts.map((p) => p.postId)));
});

test('reconcile R-8: a counted post outside the owned accounts fails the report and is named', async () => {
  const headRoute = [(u, init) => (init.method || 'GET') === 'HEAD', (u) => new Response('', { status: 206, headers: { 'content-range': u.includes('/social_posts?') ? (u.includes('platform=eq.instagram') ? '0-0/1' : '0-0/0') : '0-0/0' } })];
  const f = mockFetch([headRoute, ...trackerRoutes()]);
  const h = api('track.js', { ...ENV, MAISTRO_OWNED_ACCOUNTS: 'tiktok:samsunggulf' });
  try {
    const r = res(); await h.handler(req({ query: { days: '14', reconcile: '1' }, headers: { authorization: 'Bearer ingest' } }), r);
    assert.equal(r.body.checks.R8_ownedAccountsOnly, false); assert.equal(r.body.ok, false);
    assert.equal(r.body.population.foreign, 1); assert.deepEqual(r.body.population.sample[0], { postId: 'p1', platform: 'instagram', account: 'samsunggulf', url: 'https://www.instagram.com/p/ABC/' });
  } finally { f.restore(); h.restore(); }
});

test('twinAudit (7.0): counts merged groups and kept-apart near-duplicates; sample is platform-stratified and seeded', () => {
  const { twinAudit } = api('track.js', ENV).handler;
  const t = (s) => new Date(Date.parse('2026-10-20T10:00:00Z') + s * 1000).toISOString();
  const lists = [
    { postId: 'p1', platform: 'instagram', rows: [
      { external_id: '18012345678901234', author_username: 'amal', text: 'Love it', likes_count: 1, published_at: t(0), sentiment: 'positive' },
      { external_id: 'DAbc_amal_1760954460', author_username: 'amal', text: 'Love  it', likes_count: 0, published_at: t(60) }, // merged twin
      { external_id: '3', author_username: 'Amal', text: 'love it!', likes_count: 0, published_at: t(120) }, // same author, text differs only in case and punctuation → kept apart, a loose near-duplicate
      { external_id: '4', author_username: 'sara', text: 'When is it available in Dubai?', published_at: t(0) },
      { external_id: '5', author_username: 'sara', text: 'When is it available in Dubai? Also price', published_at: t(30) }, // truncated
      { external_id: '6', author_username: 'omar', text: 'Totally worth the upgrade', published_at: t(5) },
      { external_id: '7', author_username: 'omar.k', text: 'Totally worth the upgrade', published_at: t(65) }, // other author, same text
    ] },
    { postId: 'p2', platform: 'tiktok', rows: [
      { external_id: '8', author_username: 'x', text: 'wow', published_at: t(0) },
      { external_id: '9', author_username: 'x', text: 'wow', published_at: t(9) },
    ] },
  ];
  const a = twinAudit(lists, { seed: 's' });
  assert.equal(a.counts.groupsMerged, 2); assert.equal(a.counts.rowsRemoved, 2);
  assert.deepEqual(a.counts.nearPairs, { loose: 1, truncated: 1, otherAuthor: 1 });
  assert.deepEqual(a.counts.mergedByPlatform, { instagram: 1, tiktok: 1 });
  assert.deepEqual(a.sample.merged.find((g) => g.postId === 'p1').members.map((m) => m.idForm), ['numeric', 'synthetic']);
  assert.deepEqual(twinAudit(lists, { seed: 's' }), a, 'same seed, same sample');
  assert.equal(twinAudit(lists, { seed: 's', perPlatform: 1 }).sample.near.length, 1);
});
