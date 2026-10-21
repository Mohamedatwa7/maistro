// Characterization: GET /api/trends — kymah page → normalised feed, curation fallback, filters, caching.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, req, res, api, mockFetch, text, anthropicReply } = require('../helpers');

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
