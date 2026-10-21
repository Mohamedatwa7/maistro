// M1 states: the trend feed says when it is empty, unreachable or stale; the Performance page shows data age.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, json, fixture } = require('../helpers');

test('trends: an empty board renders the BOARD EMPTY state with its timestamp, not the forever spinner', async () => {
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('/api/trends') ? json({ source: 'TrendRadar (kymah.com)', fetchedAt: '2026-10-21T08:00:00.000Z', curatedBy: 'rules', count: 0, trends: [] }) : new Promise(() => {})), hash: '#/trends' });
  try {
    await new Promise((r) => setTimeout(r, 30));
    const html = X.rTrends();
    assert.match(html, /BOARD EMPTY · AS OF 08:00 UTC/);
    assert.match(html, /has no trends on its board right now/);
    assert.ok(!html.includes('Syncing with TrendRadar'));
  } finally { X.restore(); }
});

test('trends: a failed request renders FEED UNREACHABLE with the reason', async () => {
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('/api/trends') ? new Response('{"error":"kymah.com responded 503"}', { status: 502 }) : new Promise(() => {})), hash: '#/trends' });
  try {
    await new Promise((r) => setTimeout(r, 30));
    const html = X.rTrends();
    assert.match(html, /FEED UNREACHABLE/);
    assert.match(html, /api 502/);
  } finally { X.restore(); }
});

test('trends: a board older than 36 h carries a STALE pill and the header shows the board time; a fresh one does not', async () => {
  const feed = (boardGeneratedAt) => ({ source: 'TrendRadar agent API', fetchedAt: '2026-10-21T09:59:00.000Z', live: true, boardGeneratedAt, boardTotal: 1, curatedBy: 'rules', count: 1, trends: [{ id: 't', name: 'T', status: 'peaking', region: 'Global', lang: 'EN', category: 'c', samsungFit: { strength: 'fit', score: 50, ownableBeat: null, rationale: null, raw: null }, momentumPerDay: 1, viewsPerWeek: null, avgEngagementPct: null, stayingPower: null, mechanic: null, why: null, tags: [], sound: null, clips: [] }] });
  for (const [at, stale] of [['2026-10-19T08:00:00.000Z', true], ['2026-10-21T08:25:58.000Z', false]]) {
    const X = loadPage({ fetchImpl: async (u) => (String(u).includes('/api/trends') ? json(feed(at)) : new Promise(() => {})), hash: '#/trends' });
    try {
      await new Promise((r) => setTimeout(r, 30));
      const html = X.rTrends();
      assert.equal(/STALE · \d+H OLD/.test(html), stale, at);
      assert.match(html, /LIVE · TRENDRADAR · BOARD \d{2} Oct 2026 \d{2}:\d{2} UTC/);
    } finally { X.restore(); }
  }
});

test('performance: header shows DATA AS OF the newest post/comment and STALE when older than 48 h', async () => {
  const track = fixture('track-14d.json');
  const X = loadPage({ fetchImpl: async (u) => json(String(u).includes('/api/sentiment') ? { count: 0, posts: [] } : String(u).includes('days=14') ? track : { count: 0, posts: [] }), hash: '#/performance' });
  try {
    await new Promise((r) => setTimeout(r, 50));
    let html = X.rPerformance();
    assert.match(html, /DATA AS OF \d{2} Oct 2026 \d{2}:\d{2} UTC/);
    assert.ok(!/STALE ·/.test(html), 'fixture is fresh relative to the frozen clock');
    assert.match(html, /CONSUMER SENTIMENT TRACKER · LIVE/);
    // age everything by 10 days → stale
    for (const p of X.SENTI.posts) { p.postedAt = '2026-10-05T00:00:00Z'; for (const c of p.comments || []) c.at = '2026-10-05T00:00:00Z'; }
    html = X.rPerformance();
    assert.match(html, /STALE · DATA AS OF 05 Oct 2026/);
  } finally { X.restore(); }
});
