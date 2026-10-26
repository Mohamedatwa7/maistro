// ADR-011 (Asia/Dubai labels) and AUDIT C-21 (RTL-safe comment/caption rendering) on the live pages.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, json, fixture } = require('../helpers');

test('performance: DATA AS OF and week labels are Gulf time, independent of the viewer locale', async () => {
  const track = fixture('track-14d.json');
  const X = loadPage({ fetchImpl: async (u) => json(String(u).includes('days=14') ? track : { count: 0, posts: [] }), hash: '#/performance' });
  try {
    await new Promise((r) => setTimeout(r, 50));
    // newest comment in the fixture: 2026-10-20T20:51 UTC → 00:51 GST on 21 Oct
    for (const p of X.SENTI.posts) { p.postedAt = '2026-10-20T20:51:47Z'; for (const c of p.comments || []) c.at = '2026-10-20T20:51:47Z'; }
    const html = X.rPerformance();
    assert.match(html, /DATA AS OF 21 Oct 2026, 00:51 GST/);
    assert.ok(!/UTC/.test(html.slice(0, 2000)), 'no UTC stamps in the header');
    assert.match(html, /<span class="mono dim" style="font-size:8\.5px">21 Oct<\/span>/, 'week bucket label in Gulf time');
  } finally { X.restore(); }
});

test('trends header: board time in Gulf time with GST suffix', async () => {
  const feed = { source: 'TrendRadar agent API', fetchedAt: '2026-10-21T09:59:00.000Z', live: true, boardGeneratedAt: '2026-10-21T08:25:58.000Z', boardTotal: 1, curatedBy: 'rules', count: 1, trends: [{ id: 't', name: 'T', status: 'peaking', region: 'Global', lang: 'EN', category: 'c', samsungFit: { strength: 'fit', score: 50, ownableBeat: null, rationale: null, raw: null }, momentumPerDay: 1, viewsPerWeek: null, avgEngagementPct: null, stayingPower: null, mechanic: null, why: null, tags: [], sound: null, clips: [] }] };
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('/api/trends') ? json(feed) : new Promise(() => {})), hash: '#/trends' });
  try {
    await new Promise((r) => setTimeout(r, 30));
    assert.match(X.rTrends(), /BOARD 21 Oct 2026, 12:25 GST/);
  } finally { X.restore(); }
});

test('comments and captions render with dir="auto" so Arabic keeps its punctuation order', async () => {
  const X = loadPage({ hash: '#/performance' });
  try {
    X.SENTI.posts.push({ postId: 'tiktok-1', platform: 'tiktok', account: '@samsunggulf', caption: 'تجربة الكاميرا الجديدة!', url: 'u', postedAt: '2026-10-21T08:00:00Z', metrics: { views: 10, likes: 1, comments: 1, shares: 0, er: 0.2 }, comments: [{ author: 'سارة', text: 'أفضل هاتف جربته، الكاميرا رائعة!', likes: 3, at: '2026-10-21T09:00:00Z', sentiment: 'pos' }] });
    X.STATE.pfTab = 'posts'; X.STATE.openPost = { 'tiktok-1': true }; // the Posts tab, that post's comments opened
    const html = X.rPerformance();
    assert.match(html, /<span dir="auto" style="color:var\(--text\);unicode-bidi:plaintext"> أفضل هاتف جربته، الكاميرا رائعة!<\/span>/);
    assert.match(html, /<p dir="auto" style="font-size:13px;line-height:1\.6;margin-top:7px;unicode-bidi:plaintext">تجربة الكاميرا الجديدة!<\/p>/);
  } finally { X.restore(); }
});
