// M1 states: the trend feed says when it is empty, unreachable or stale; the Performance page shows data age.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, json, fixture } = require('../helpers');

test('trends: an empty board renders the BOARD EMPTY state with its timestamp, not the forever spinner', async () => {
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('/api/trends') ? json({ source: 'TrendRadar (kymah.com)', fetchedAt: '2026-10-21T08:00:00.000Z', curatedBy: 'rules', count: 0, trends: [] }) : new Promise(() => {})), hash: '#/trends' });
  try {
    await new Promise((r) => setTimeout(r, 30));
    const html = X.rTrends();
    assert.match(html, /BOARD EMPTY · AS OF 12:00 GST/, 'labels are Gulf time (ADR-011)');
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
      assert.match(html, /LIVE · TRENDRADAR · BOARD \d{2} Oct 2026, \d{2}:\d{2} GST/);
    } finally { X.restore(); }
  }
});

test('performance: header shows DATA AS OF the newest post/comment and STALE when older than 48 h', async () => {
  const track = fixture('track-14d.json');
  const X = loadPage({ fetchImpl: async (u) => json(String(u).includes('/api/sentiment') ? { count: 0, posts: [] } : String(u).includes('days=14') ? track : { count: 0, posts: [] }), hash: '#/performance' });
  try {
    await new Promise((r) => setTimeout(r, 50));
    let html = X.rPerformance();
    assert.match(html, /DATA AS OF \d{2} Oct 2026, \d{2}:\d{2} GST/);
    // one pill per platform, each judged on its own newest post/comment (ingestion lags differ by platform)
    const by = X.perfNewestByPlatform(); const now = Date.now();
    assert.ok(Object.keys(by).length >= 1);
    for (const [k, t] of Object.entries(by)) {
      const name = { x: 'X', twitter: 'X', tiktok: 'TIKTOK', instagram: 'INSTAGRAM', facebook: 'FACEBOOK' }[k] || k.toUpperCase();
      const stale = (now - t) / 36e5 > 48;
      assert.equal(new RegExp(`STALE · ${name} · DATA AS OF`).test(html), stale, `${k}: ${stale ? 'stale' : 'fresh'} pill`);
      if (!stale) assert.match(html, new RegExp(`${name} · DATA AS OF`));
    }
    assert.match(html, /CONSUMER SENTIMENT TRACKER · LIVE/);
    // age everything by 10 days → stale
    for (const p of X.SENTI.posts) { p.postedAt = '2026-10-05T00:00:00Z'; for (const c of p.comments || []) c.at = '2026-10-05T00:00:00Z'; }
    html = X.rPerformance();
    assert.match(html, /STALE · [A-Z]+ · DATA AS OF 05 Oct 2026/); assert.ok(!/<span class="pill"><span class="dot"><\/span>[A-Z]+ · DATA AS OF/.test(html), 'every platform stale once everything is 10 days old');
  } finally { X.restore(); }
});

test('scored board (5.5): ranked cards show rank, score, lifecycle, post-by or LATE, product mapping and confidence; tabs split rejected and needs-review; filters apply; no run → honest empty state', async () => {
  const run = { at: '2026-10-21T15:20:00Z', boardGeneratedAt: '2026-10-21T08:25:58Z',
    ranked: [
      { scoreId: 2, trendId: 'snd-2', name: 'Phone flip reveal', status: 'scored', score: 81.5, lifecycle: 'rising', postBy: '2026-10-24T08:25:00Z', product: 'Galaxy Z Flip8', confidence: 'high', vetoes: [], criteria: { momentum: { weight: 20, score: 9.5 }, product: { weight: 15, score: 9 }, gulf: { weight: 12, score: null, note: 'missing' } }, timing: { postByPassed: false, leadDays: 5, leadAssumed: true, remainingDays: 6 }, profile: { whatItIs: 'A reveal format', mechanic: 'flip', whySpreading: 'satisfying', unknowns: ['origin'] }, productMapping: { product: 'Galaxy Z Flip8', feature: 'FlexWindow', catalogMatch: true }, promptVersion: 'profile-v1-2026-10-21', model: 'claude-sonnet-5-5', weightsVersion: 'w1-2026-10-21' },
      { scoreId: 3, trendId: 'snd-3', name: 'Late one', status: 'scored', score: 40, lifecycle: 'peaking', postBy: '2026-10-19T08:25:00Z', product: null, confidence: 'medium', vetoes: [], criteria: {}, timing: { postByPassed: true, leadDays: 5, leadAssumed: true, remainingDays: 1 }, profile: null, productMapping: { product: 'none', feature: '' } },
    ],
    rejected: [{ scoreId: 4, trendId: 'snd-4', name: 'Dangerous stunt', status: 'vetoed', score: null, lifecycle: 'emerging', postBy: null, product: null, confidence: 'high', vetoes: [{ code: 'V-SAFETY', reason: 'dangerous challenge', evidence: ['why: "stunt"'], needsReview: false }], criteria: {}, timing: {}, profile: null, productMapping: null }],
    needsReview: [{ scoreId: 5, trendId: 'snd-5', name: 'Unknown sound', status: 'needs_review', score: null, lifecycle: 'unknown', postBy: null, product: null, confidence: 'low', vetoes: [{ code: 'V-AUDIO', reason: 'commercial-use status unknown', needsReview: true }], criteria: {}, timing: {}, profile: null, productMapping: null }] };
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('view=scored') ? json(run) : String(u).includes('/api/trends') ? json({ source: 'TrendRadar agent API', fetchedAt: '2026-10-21T09:59:00.000Z', live: true, boardGeneratedAt: '2026-10-21T08:25:58.000Z', boardTotal: 1, curatedBy: 'rules', count: 1, trends: [{ id: 'phone-flip-reveal', name: 'Phone flip reveal', status: 'peaking', region: 'Global', lang: 'EN', category: 'c', samsungFit: { strength: 'fit', score: 50, ownableBeat: null, rationale: null, raw: null }, momentumPerDay: 1, viewsPerWeek: null, avgEngagementPct: null, stayingPower: null, mechanic: null, why: null, tags: [], sound: null, clips: [] }] }) : new Promise(() => {})), hash: '#/trends' });
  try {
    await new Promise((r) => setTimeout(r, 30));
    let html = X.rTrends();
    assert.ok(!html.includes('Scored board'), 'not rendered before the scored view is loaded');
    await X.loadScored();
    html = X.rTrends();
    assert.match(html, /Maistro ranking · framework v1/); assert.match(html, /2 ranked · 1 need review · 1 rejected/); assert.match(html, /SCORED 21 Oct 2026, 19:20 GST/);
    assert.match(html, /#1<\/span> Phone flip reveal/); assert.match(html, /81\.5<\/span>/); assert.match(html, /RISING/); assert.match(html, /POST BY 24 OCT/); assert.match(html, /CONFIDENCE HIGH/); assert.match(html, /Galaxy Z Flip8<\/b> — FlexWindow/);
    assert.match(html, /LATE · POST-BY PASSED/); assert.match(html, /1 of 2 ranked trends are past their post-by date/);
    assert.ok(!html.includes('Dangerous stunt'), 'rejected not in the ranked tab');
    X.STATE.scoredTab = 'rejected'; html = X.rTrends();
    assert.match(html, /Dangerous stunt/); assert.match(html, /V-SAFETY/); assert.match(html, /dangerous challenge/); assert.match(html, /VETOED/);
    X.STATE.scoredTab = 'review'; html = X.rTrends();
    assert.match(html, /Unknown sound/); assert.match(html, /V-AUDIO · NEEDS REVIEW/); assert.match(html, /STAGE UNKNOWN/);
    X.STATE.scoredTab = 'ranked'; X.STATE.scoredF = { product: 'Galaxy Z Flip8' };
    assert.deepEqual(X.scoredList().map((x) => x.name), ['Phone flip reveal']);
    X.STATE.scoredF = { lifecycle: 'peaking' }; assert.deepEqual(X.scoredList().map((x) => x.name), ['Late one']);
    X.STATE.scoredF = {}; X.SCORED.open['snd-2'] = true; html = X.rTrends();
    assert.match(html, /Score breakdown · weights vw1-2026-10-21/); assert.match(html, /MOMENTUM & TIMING <span style="color:#fff">9\.5<\/span>\/10 · w20/); assert.match(html, /Not scored \(normalised away\): Gulf relevance/); assert.match(html, /Unknowns:<\/b> origin/);
    assert.match(html, /Pick → Studio/); assert.match(html, /Reject<\/button>/);
    // one page, two lenses: the ranking is the default once a run exists; the live feed cards carry their rank
    assert.match(html, /① · What to make/); assert.match(html, /② · Live feed/);
    X.STATE.trView = 'live'; html = X.rTrends();
    assert.match(html, /MAISTRO #1 · 81\.5\/100/); assert.ok(!html.includes('Maistro ranking · framework v1'), 'the ranking is not repeated above the live feed');
    X.STATE.trView = 'ranked';
    Object.assign(X.SCORED, { at: null, ranked: [], rejected: [], needsReview: [] }); html = X.rTrends();
    assert.match(html, /No scoring run has completed yet/);
  } finally { X.restore(); }
});

test('trend clips: a tile never depends on the expiring TikTok poster (onerror drops it) and plays the clip through the TikTok embed player; scored cards show the sample videos of the live trend', () => {
  const { loadPage } = require('../helpers');
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    const tile = X.rClipTile({ vid: '7693452843465985286', handle: '@a', views: 784000, poster: 'https://p19.tiktokcdn-us.com/x.image?x-expires=1' });
    assert.match(tile, /data-vid="7693452843465985286"/); assert.match(tile, /onerror="this\.remove\(\)"/); assert.match(tile, /784K VIEWS|784\.0K VIEWS|784,000 VIEWS/i);
    assert.match(tile, /https:\/\/www\.tiktok\.com\/%40a\/video\/7693452843465985286/);
    assert.equal(X.rClipTile({ poster: 'https://x' }), '', 'no video id, no tile');
    const el = { dataset: { vid: '7693452843465985286' }, innerHTML: '' };
    X.clipPlay(el); assert.match(el.innerHTML, /<iframe src="https:\/\/www\.tiktok\.com\/player\/v1\/7693452843465985286\?autoplay=1/);
    X.TRENDS.length = 0; X.TRENDS.push({ id: 'x', trendId: 'snd-9', name: 'N', vel: 4, m: { views: 1000, er: null }, clips: [1, 2, 3, 4].map((k) => ({ vid: String(k), handle: '@h' + k })) });
    const card = X.rScoredCard({ trendId: 'snd-9', name: 'N', status: 'scored', score: 70, lifecycle: 'rising', criteria: {}, timing: {}, vetoes: [] }, 0);
    assert.match(card, /Sample videos · tap to play/); assert.equal((card.match(/data-vid=/g) || []).length, 3, 'three clips while collapsed'); assert.match(card, /LIVE <b[^>]*>\+4%\/DAY/);
    const outside = X.rScoredCard({ trendId: 'snd-77', name: 'Not in the top 10', status: 'scored', score: 60, lifecycle: 'rising', criteria: {}, timing: {}, vetoes: [], live: { momentumPerDay: 2.4, viewsPerWeek: 5000, avgEngagementPct: 8, clips: [{ vid: '11', handle: '@a' }, { vid: '12', handle: '@b' }] } }, 3);
    assert.match(outside, /Sample videos · tap to play/, 'a ranked trend outside the curated feed still shows its reference videos'); assert.equal((outside.match(/data-vid=/g) || []).length, 2); assert.match(outside, /LIVE <b[^>]*>\+2%\/DAY/);
  } finally { X.restore(); }
});

test('performance: a platform that never reports views is "not collected", kept out of the total, not shown as zero', () => {
  const { loadPage } = require('../helpers');
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    const list = [{ platform: 'facebook', metrics: { views: 0, comments: 2 }, comments: [] }, { platform: 'facebook', metrics: { views: null }, comments: [] }, { platform: 'tiktok', metrics: { views: 100, comments: 1 }, comments: [] }];
    assert.deepEqual(X.viewsNotCollected(list), ['facebook']);
    const s = X.pfStats(list);
    assert.equal(s.views, 100); assert.deepEqual(s.viewsNotCollected, ['facebook']);
  } finally { X.restore(); }
});
