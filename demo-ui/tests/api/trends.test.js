// Characterization: GET /api/trends — kymah page → normalised feed, curation fallback, filters, caching.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, req, res, api, mockFetch, json, text, anthropicReply } = require('../helpers');

const page = fixture('kymah-page.html');

test('rules curation without an Anthropic key: shape, cache headers, CORS', async () => {
  const f = mockFetch([['https://www.kymah.com/', () => text(page)]]);
  const { handler, restore } = api('trends.js', { ANTHROPIC_API_KEY: undefined });
  try {
    const r = res();
    await handler(req(), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.source, 'TrendRadar (kymah.com)');
    assert.equal(r.body.curatedBy, 'rules');
    assert.ok(r.body.count >= 1 && r.body.count <= 10);
    assert.equal(r.body.trends.length, r.body.count);
    const t = r.body.trends[0];
    assert.deepEqual(Object.keys(t).sort(), ['avgEngagementPct', 'category', 'clips', 'id', 'lang', 'mechanic', 'momentumPerDay', 'name', 'region', 'samsungFit', 'sound', 'stayingPower', 'status', 'tags', 'viewsPerWeek', 'why'].sort());
    assert.deepEqual(Object.keys(t.samsungFit).sort(), ['ownableBeat', 'rationale', 'raw', 'score', 'strength']);
    assert.ok(['strong', 'fit'].includes(t.samsungFit.strength));
    for (const c of t.clips) assert.deepEqual(Object.keys(c).sort(), ['handle', 'poster', 'sound', 'vid', 'views']);
    if (t.sound) assert.deepEqual(Object.keys(t.sound).sort(), ['author', 'cleared', 'clearedCheckedAt', 'cue', 'musicId', 'title']);
    assert.equal(r.headers['cache-control'], 's-maxage=900, stale-while-revalidate=3600');
    assert.equal(r.headers['access-control-allow-origin'], '*');
    // rules: score >= 40, sorted by score desc
    const scores = r.body.trends.map((x) => x.samsungFit.score || 0);
    assert.ok(scores.every((s) => s >= 40));
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  } finally { f.restore(); restore(); }
});

test('?all=1 skips curation and returns every named trend sorted by fit', async () => {
  const f = mockFetch([['https://www.kymah.com/', () => text(page)]]);
  const { handler, restore } = api('trends.js', { ANTHROPIC_API_KEY: undefined });
  try {
    const r = res();
    await handler(req({ query: { all: '1' } }), r);
    assert.equal(r.body.curatedBy, 'none');
    assert.equal(r.body.count, 12);
    assert.ok(r.body.trends.every((t) => t.name));
  } finally { f.restore(); restore(); }
});

test('filters: limit, id, minScore', async () => {
  const f = mockFetch([['https://www.kymah.com/', () => text(page)]]);
  const { handler, restore } = api('trends.js', { ANTHROPIC_API_KEY: undefined });
  try {
    let r = res(); await handler(req({ query: { all: '1', limit: '3' } }), r);
    assert.equal(r.body.count, 3);
    const id = r.body.trends[0].id;
    r = res(); await handler(req({ query: { all: '1', id } }), r);
    assert.equal(r.body.count, 1); assert.equal(r.body.trends[0].id, id);
    r = res(); await handler(req({ query: { all: '1', minScore: '1000' } }), r);
    assert.equal(r.body.count, 0);
  } finally { f.restore(); restore(); }
});

test('Claude curation: picks are mapped back by id, curatorNote and hashtags attached, exactly the selected ids', async () => {
  let candidates;
  const f = mockFetch([
    ['https://www.kymah.com/', () => text(page)],
    ['api.anthropic.com', (url, init) => {
      candidates = JSON.parse(init.body);
      const digest = JSON.parse(candidates.messages[0].content.replace(/^CANDIDATES:\n/, '').replace(/\n\nSelect and rank the 10\.$/, ''));
      return anthropicReply({ selected: digest.slice(0, 2).map((d) => ({ id: d.id, reason: 'fixture pick', hashtags: ['a', 'b', 'c'] })) });
    }],
  ]);
  const { handler, restore } = api('trends.js', { ANTHROPIC_API_KEY: 'test-key' });
  try {
    const r = res();
    await handler(req(), r);
    assert.equal(r.body.curatedBy, 'claude');
    assert.equal(r.body.count, 2);
    assert.equal(r.body.trends[0].curatorNote, 'fixture pick');
    assert.ok(Array.isArray(r.body.trends[0].tags));
    assert.equal(candidates.model, 'claude-opus-4-8');
  } finally { f.restore(); restore(); }
});

test('Claude failure degrades to rules silently (curatedBy: rules)', async () => {
  const f = mockFetch([
    ['https://www.kymah.com/', () => text(page)],
    ['api.anthropic.com', () => text('{"error":"boom"}', 500)],
  ]);
  const { handler, restore } = api('trends.js', { ANTHROPIC_API_KEY: 'test-key' });
  try {
    const r = res();
    await handler(req(), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.curatedBy, 'rules');
  } finally { f.restore(); restore(); }
});

test('kymah unreachable or changed → 502 with no-store', async () => {
  const f = mockFetch([['https://www.kymah.com/', () => text('<html>nothing here</html>')]]);
  const { handler, restore } = api('trends.js', { ANTHROPIC_API_KEY: undefined });
  try {
    const r = res();
    await handler(req(), r);
    assert.equal(r.statusCode, 502);
    assert.match(r.body.error, /flight payload/);
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally { f.restore(); restore(); }
});

// ---- M4: Trend Radar agent API as the primary source, page scrape as fallback ----
const agentFeed = () => fixture('agent-trends.json');

test('agent API primary: shape unchanged plus additive fields; board metadata propagated; CORS/cache as before', async () => {
  let authHeader;
  const f = mockFetch([
    ['/api/agent/trends', (u, init) => { authHeader = init.headers.authorization; return json(agentFeed()); }],
    ['https://www.kymah.com/', () => { throw new Error('scrape must not run when the agent API answers'); }],
  ]);
  const { handler, restore } = api('trends.js', { ANTHROPIC_API_KEY: undefined, TRENDRADAR_AGENT_KEY: 'agent-key', TRENDRADAR_BASE_URL: 'https://tr.test' });
  try {
    const r = res();
    await handler(req({ query: { all: '1' } }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(authHeader, 'Bearer agent-key');
    assert.equal(r.body.source, 'TrendRadar agent API');
    assert.equal(r.body.live, true);
    assert.equal(r.body.boardGeneratedAt, agentFeed().generatedAt);
    assert.equal(r.body.boardTotal, agentFeed().total);
    assert.equal(r.body.count, 12);
    const t = r.body.trends[0];
    for (const k of ['id', 'name', 'status', 'region', 'lang', 'category', 'samsungFit', 'momentumPerDay', 'viewsPerWeek', 'avgEngagementPct', 'stayingPower', 'mechanic', 'why', 'tags', 'sound', 'clips']) assert.ok(k in t, k);
    for (const k of ['trendId', 'onBrand', 'signalStrength', 'brief', 'products']) assert.ok(k in t, 'additive ' + k);
    assert.equal(t.id, 'setup-line-then-deadpan-punchline-caption-reveal', 'ids stay the name slugs the external agent filters on');
    assert.equal(t.trendId, 'snd-7686644251815332639');
    assert.deepEqual(t.samsungFit, { strength: 'strong', score: 82, ownableBeat: 'deadpan caption riff with Galaxy AI/Flip product as punchline', rationale: 'Live caption-riff wave; Galaxy Flip fold or Circle to Search as deadpan punchline.', raw: 'Live caption-riff wave; Galaxy Flip fold or Circle to Search as deadpan punchline.' });
    assert.equal(t.momentumPerDay, 1); assert.equal(t.viewsPerWeek, 965000); assert.equal(t.stayingPower, 'ongoing');
    assert.equal(t.sound.title, 'original sound - djprincelex');
    assert.ok(Array.isArray(t.clips));
    assert.equal(r.headers['cache-control'], 's-maxage=900, stale-while-revalidate=3600');
    assert.equal(r.headers['access-control-allow-origin'], '*');
  } finally { f.restore(); restore(); }
});

test('agent API down → the page scrape answers (source says so); live:false from the agent is passed through', async () => {
  const page = fixture('kymah-page.html');
  let f = mockFetch([
    ['/api/agent/trends', () => text('{"error":"read_failed"}', 500)],
    ['https://www.kymah.com/', () => text(page)],
  ]);
  let h = api('trends.js', { ANTHROPIC_API_KEY: undefined, TRENDRADAR_AGENT_KEY: 'agent-key', TRENDRADAR_BASE_URL: 'https://tr.test' });
  try {
    const r = res(); await h.handler(req({ query: { all: '1' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.source, 'TrendRadar (kymah.com)'); assert.equal(r.body.count, 12);
  } finally { f.restore(); h.restore(); }
  f = mockFetch([['/api/agent/trends', () => json({ ...agentFeed(), live: false })]]);
  h = api('trends.js', { ANTHROPIC_API_KEY: undefined, TRENDRADAR_AGENT_KEY: 'agent-key', TRENDRADAR_BASE_URL: 'https://tr.test' });
  try {
    const r = res(); await h.handler(req({ query: { all: '1' } }), r);
    assert.equal(r.body.live, false, 'the consumer must know it is reading the snapshot');
  } finally { f.restore(); h.restore(); }
});

test('no agent key → scrape path exactly as before; an empty board is a 200 with count 0, not a 502', async () => {
  let f = mockFetch([['https://www.kymah.com/', () => text(fixture('kymah-page.html'))]]);
  let h = api('trends.js', { ANTHROPIC_API_KEY: undefined, TRENDRADAR_AGENT_KEY: undefined });
  try {
    const r = res(); await h.handler(req({ query: { all: '1' } }), r);
    assert.equal(r.body.source, 'TrendRadar (kymah.com)'); assert.equal(r.body.count, 12);
  } finally { f.restore(); h.restore(); }
  f = mockFetch([['/api/agent/trends', () => json({ live: true, generatedAt: '2026-10-21T08:00:00.000Z', total: 0, trends: [] })]]);
  h = api('trends.js', { ANTHROPIC_API_KEY: undefined, TRENDRADAR_AGENT_KEY: 'k', TRENDRADAR_BASE_URL: 'https://tr.test' });
  try {
    const r = res(); await h.handler(req(), r);
    assert.equal(r.statusCode, 200); assert.deepEqual([r.body.count, r.body.curatedBy, r.body.boardTotal], [0, 'none', 0]);
    assert.equal(r.headers['cache-control'], 's-maxage=300, stale-while-revalidate=900');
  } finally { f.restore(); h.restore(); }
});

// ---- trends_cache (ADR-005, M4): refresh-on-read, served from the database, stale on outage ----
const { fakePostgrest } = require('../fake-postgrest');
const SBC = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };

test('cache: the first read fills trends_cache with the raw and curated board; a read within the hour is served from it without any upstream or curation call', async () => {
  const pg = fakePostgrest();
  let upstream = 0, claude = 0;
  const f = mockFetch([
    ['/api/agent/trends', () => { upstream++; return json(agentFeed()); }],
    ['api.anthropic.com', () => { claude++; return anthropicReply({ selected: [{ id: 'setup-line-then-deadpan-punchline-caption-reveal', reason: 'r', hashtags: ['deadpan'] }] }); }],
    pg.route,
  ]);
  const h = api('trends.js', { ANTHROPIC_API_KEY: 'k', TRENDRADAR_AGENT_KEY: 'agent-key', TRENDRADAR_BASE_URL: 'https://tr.test', ...SBC });
  try {
    let r = res(); await h.handler(req(), r);
    assert.equal(r.statusCode, 200); assert.equal(upstream, 1); assert.equal(claude, 1);
    assert.deepEqual({ hit: r.body.cache.hit, stale: r.body.cache.stale }, { hit: false, stale: false });
    assert.equal(r.body.curatedBy, 'claude'); assert.equal(r.body.count, 1);
    const row = pg.tables.trends_cache[0];
    assert.equal(row.id, 'board'); assert.equal(row.payload.raw.length, 12); assert.equal(row.payload.curated.length, 1); assert.equal(row.payload.curatedBy, 'claude'); assert.equal(row.source, 'TrendRadar agent API');
    r = res(); await h.handler(req(), r);
    assert.equal(upstream, 1, 'no second upstream call'); assert.equal(claude, 1, 'no second curation call');
    assert.equal(r.body.cache.hit, true); assert.equal(r.body.curatedBy, 'claude'); assert.equal(r.body.trends[0].curatorNote, 'r');
    assert.equal(r.body.boardGeneratedAt, agentFeed().generatedAt); assert.equal(r.body.boardTotal, agentFeed().total);
    r = res(); await h.handler(req({ query: { all: '1' } }), r);
    assert.equal(r.body.count, 12, '?all=1 serves the raw board from the cache'); assert.equal(upstream, 1);
    r = res(); await h.handler(req({ query: { limit: '1', id: 'setup-line-then-deadpan-punchline-caption-reveal' } }), r);
    assert.equal(r.body.count, 1, 'consumer filters still apply on a cache hit');
  } finally { f.restore(); h.restore(); }
});

test('cache: an hour-old board is refreshed on read; when the refresh fails the cached board is served stale with the reason, not a 502', async () => {
  const pg = fakePostgrest();
  let upstream = 0; let fail = false;
  const f = mockFetch([
    ['/api/agent/trends', () => { upstream++; if (fail) return text('{"error":"down"}', 503); return json(agentFeed()); }],
    ['https://www.kymah.com/', () => text('<html>changed</html>', 200)],
    pg.route,
  ]);
  const h = api('trends.js', { ANTHROPIC_API_KEY: undefined, TRENDRADAR_AGENT_KEY: 'agent-key', TRENDRADAR_BASE_URL: 'https://tr.test', ...SBC });
  try {
    let r = res(); await h.handler(req(), r); assert.equal(upstream, 1); assert.equal(r.body.curatedBy, 'rules');
    pg.tables.trends_cache[0].fetched_at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    r = res(); await h.handler(req(), r);
    assert.equal(upstream, 2, 'stale row → refreshed'); assert.equal(r.body.cache.hit, false);
    assert.ok(Date.now() - new Date(pg.tables.trends_cache[0].fetched_at).getTime() < 5000, 'row rewritten');
    pg.tables.trends_cache[0].fetched_at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    fail = true;
    r = res(); await h.handler(req(), r);
    assert.equal(r.statusCode, 200, 'outage with a cached board is not a 502');
    assert.equal(r.body.cache.stale, true); assert.match(r.body.cache.error, /no flight payload|kymah/); assert.equal(r.body.count >= 1, true);
    assert.equal(r.headers['cache-control'], 's-maxage=120, stale-while-revalidate=600');
    assert.match(pg.tables.trends_cache[0].error, /no flight payload|kymah/);
    // no cached board at all → the historical 502
    pg.tables.trends_cache.length = 0;
    r = res(); await h.handler(req(), r);
    assert.equal(r.statusCode, 502);
  } finally { f.restore(); h.restore(); }
});

test('cache: a raw (?all=1) miss stores no curation; the next curated read within the hour curates once and writes it back keeping fetched_at; the hourly cron refreshes unconditionally', async () => {
  const pg = fakePostgrest();
  let upstream = 0, claude = 0;
  const f = mockFetch([
    ['/api/agent/trends', () => { upstream++; return json(agentFeed()); }],
    ['api.anthropic.com', () => { claude++; return anthropicReply({ selected: [{ id: 'setup-line-then-deadpan-punchline-caption-reveal', reason: 'r', hashtags: [] }] }); }],
    pg.route,
  ]);
  const h = api('trends.js', { ANTHROPIC_API_KEY: 'k', TRENDRADAR_AGENT_KEY: 'agent-key', TRENDRADAR_BASE_URL: 'https://tr.test', CRON_SECRET: 'cron', ...SBC });
  try {
    let r = res(); await h.handler(req({ query: { all: '1' } }), r);
    assert.equal(upstream, 1); assert.equal(claude, 0); assert.deepEqual(pg.tables.trends_cache[0].payload.curated, []);
    const stamp = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    pg.tables.trends_cache[0].fetched_at = stamp;
    r = res(); await h.handler(req(), r);
    assert.equal(upstream, 1, 'hit'); assert.equal(claude, 1, 'curated once'); assert.equal(r.body.curatedBy, 'claude'); assert.equal(r.body.cache.hit, true);
    assert.equal(pg.tables.trends_cache[0].payload.curated.length, 1, 'curation written back'); assert.equal(pg.tables.trends_cache[0].fetched_at, stamp, 'fetched_at kept');
    r = res(); await h.handler(req(), r);
    assert.equal(claude, 1, 'no re-curation on the next hit'); assert.equal(r.body.trends[0].curatorNote, 'r');
    // the cron refreshes regardless of age
    r = res(); await h.handler(req({ headers: { authorization: 'Bearer cron' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.refreshed, true); assert.equal(upstream, 2); assert.equal(claude, 2); assert.equal(r.body.curated, 1);
    assert.ok(Date.now() - new Date(pg.tables.trends_cache[0].fetched_at).getTime() < 5000);
  } finally { f.restore(); h.restore(); }
});

test('snapshots (5.0): every fetched board writes one trend_snapshots row per well-formed trend with the computed-in-code signals; malformed records are rejected, not written; cache hits write nothing', async () => {
  const pg = fakePostgrest();
  const feed = agentFeed();
  feed.trends.push({ id: 'broken', name: '' }); // no name → rejected
  const f = mockFetch([['/api/agent/trends', () => json(feed)], pg.route]);
  const h = api('trends.js', { ANTHROPIC_API_KEY: undefined, TRENDRADAR_AGENT_KEY: 'agent-key', TRENDRADAR_BASE_URL: 'https://tr.test', CRON_SECRET: 'cron', ...SBC });
  try {
    let r = res(); await h.handler(req({ query: { all: '1' } }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(pg.tables.trend_snapshots.length, 12, '12 well-formed trends → 12 rows');
    const row = pg.tables.trend_snapshots[0];
    assert.equal(row.trend_id, 'snd-7686644251815332639'); assert.equal(row.stage, 'peaking'); assert.equal(row.growth_pct_per_day, 1); assert.equal(typeof row.eng, 'number');
    assert.equal(row.fit_strength, 82); assert.equal(row.on_brand, true); assert.equal(row.views_wk, 965000); assert.equal(row.sound_music_id, '7686644251815332639');
    assert.equal(row.board_generated_at, feed.generatedAt); assert.equal(row.source, 'TrendRadar agent API'); assert.ok(row.raw && row.raw.name);
    r = res(); await h.handler(req(), r);
    assert.equal(pg.tables.trend_snapshots.length, 12, 'a cache hit writes no snapshot');
    r = res(); await h.handler(req({ headers: { authorization: 'Bearer cron' } }), r);
    assert.equal(r.body.snapshots.written, 12); assert.equal(r.body.snapshots.rejected, 0, 'the nameless record was already dropped by the agent normaliser; the writer guard is exercised below');
    assert.equal(pg.tables.trend_snapshots.length, 24, 'the cron refresh adds a second snapshot per trend');
    assert.equal(h.handler.snapshotRow({ name: 'x' }, { fetchedAt: 'now' }), null, 'no id → rejected');
  } finally { f.restore(); h.restore(); }
});
