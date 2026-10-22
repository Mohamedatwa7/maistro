// Golden: the Performance page's merge of /api/track with the /api/sentiment snapshot, and its rendering.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadPage, json } = require('../helpers');

const track = fixture('track-14d.json');
const snap = fixture('sentiment-snapshot.json');

function pageWith({ track14 = track, track7 = null, track60 = null, snapshot = snap, bench = null, handled = null } = {}) {
  const fetchImpl = async (url) => {
    const u = String(url);
    const pick = u.includes('handled=1') ? handled : u.includes('benchmarks=1') ? bench : u.includes('/api/sentiment') ? snapshot : u.includes('days=14') ? track14 : u.includes('days=7') ? track7 : u.includes('days=60') ? track60 : null;
    if (!pick) throw new Error('down');
    return json(pick);
  };
  return loadPage({ fetchImpl, hash: '#/performance' });
}

test('golden merge: track wins, snapshot fills missing comments/thumbs and appends unknown posts; twins collapsed', async () => {
  const X = pageWith();
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(X.SENTI.posts.length, 30, 'frozen 2026-10-21 (clock frozen at 2026-10-21T10:00Z): 20 track posts + 10 snapshot-only posts');
    assert.equal(X.SENTI.src, track.source);
    const withComments = X.SENTI.posts.filter((p) => p.comments && p.comments.length).length;
    assert.equal(withComments, 12);
    const list = X.pfPosts();
    const s = X.pfStats(list);
    assert.equal(X.pfState().days, '7');
    assert.deepEqual({ posts: s.posts, cmts: s.cmts, analyzed: s.analyzed, pos: s.pos, neg: s.neg, views: s.views }, { posts: 20, cmts: 81, analyzed: 11, pos: 1, neg: 1, views: 31221 });
    const html = X.rPerformance();
    assert.ok(!html.includes('No posts from the past 7 days'));
    assert.ok(html.includes('Total positive rate'));
  } finally { X.restore(); }
});

test('snapshot only (track down): posts load but the 7-day window is empty → zero KPIs (documented AUDIT C-18)', async () => {
  const X = pageWith({ track14: null, track7: null, track60: null });
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(X.SENTI.posts.length, 10);
    assert.equal(X.SENTI.src, 'sentiment tracker');
    const s = X.pfStats(X.pfPosts());
    assert.equal(s.posts, 0);
  } finally { X.restore(); }
});

test('sentiDedupe keeps the analyzed then most-liked copy and ignores whitespace/case in author', () => {
  const X = loadPage();
  try {
    const out = X.sentiDedupe([
      { author: 'Amal', text: 'great  phone', likes: 1, sentiment: 'neu' },
      { author: 'amal ', text: 'great phone', likes: 5, sentiment: null },
      { author: 'amal', text: 'great phone', likes: 2, sentiment: 'pos' },
      { author: 'ziad', text: 'great phone', likes: 9, sentiment: 'pos' },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((c) => [c.author, c.likes, c.sentiment]), [['amal', 2, 'pos'], ['ziad', 9, 'pos']]);
  } finally { X.restore(); }
});

test('radarToTrend maps the API shape to the card shape (platform always tiktok, audio from sound)', () => {
  const X = loadPage();
  try {
    const t = X.radarToTrend({ id: 'x', name: 'N', status: 'peaking', region: 'Global', lang: 'EN', category: 'Comedy', samsungFit: { strength: 'strong', score: 81, ownableBeat: 'beat', rationale: 'why', raw: 'raw' }, momentumPerDay: 12.4, avgEngagementPct: 7.5, mechanic: 'm', tags: ['a'], sound: { title: 'S', author: 'A', musicId: '1', cue: 'c', cleared: false, clearedCheckedAt: '2026-10-01T00:00:00Z' }, clips: [] }, 0);
    assert.equal(t.platform, 'tiktok');
    assert.deepEqual(t.markets, ['Global', 'EN']);
    assert.equal(t.vel, 12);
    assert.equal(t.fitTag, 'STRONG SAMSUNG FIT');
    assert.deepEqual(t.score, { fit: 81, total: 81, why: 'why' });
    assert.equal(t.audio.status, 'pending');
    assert.equal(t.audio.permits, 'Cue: c', 'a cue wins over the clearance sentence');
    assert.match(t.audio.source, /ID 1 · clearance checked 2026-10-01/);
    assert.equal(t.m.er, 0.075);
  } finally { X.restore(); }
});

test('critical alerts and drill-downs fold the same author+text pasted under several posts into one row (peer finding, 2026-10-21)', () => {
  const X = loadPage({ hash: '#/performance' });
  try {
    const cmt = (likes) => ({ author: 'complainant', text: 'Dear Samsung Pakistan Management, I am writing to formally complain about customer service', likes, at: '2026-10-21T09:00:00Z', sentiment: 'neg' });
    const post = (id, likes) => ({ postId: id, platform: 'instagram', account: '@samsunggulf', caption: 'c', url: 'u', postedAt: '2026-10-21T08:00:00Z', metrics: { views: 10, likes: 1, comments: 1, shares: 0, er: 0.2 }, comments: [cmt(likes)] });
    X.SENTI.posts.push(post('ig-1', 2), post('ig-2', 5));
    const html = X.rPerformance();
    const panel = html.slice(html.indexOf('<span class="kick accent">Critical alerts</span>'), html.indexOf('Comment health — week on week'));
    assert.equal((panel.match(/formally complain/g) || []).length, 1, 'one alert row, not two');
    assert.match(panel, /× 2 POSTS/);
    assert.equal(X.sentiFoldAcross(X.allComments(X.SENTI.posts)).filter((c) => c.author === 'complainant').map((c) => c.likes)[0], 5, 'the most-liked copy survives');
  } finally { X.restore(); }
});

test('7.0 window merge: the 60-day read widens the 14-day one — a post in both takes the later read\'s metrics and keeps comments only the 14-day read had; posts of either read are kept', async () => {
  const c = (author, text, at) => ({ author, text, at, likes: 0, sentiment: 'neu' });
  const post = (id, postedAt, views, comments, collected) => ({ postId: id, platform: 'tiktok', account: 'samsunggulf', caption: id, url: null, postedAt, mediaType: null, metrics: { views, likes: 1, comments: comments.length, shares: 0, er: null, thumb: null }, commentsCollected: collected, comments });
  const fast = { source: track.source, fetchedAt: '2026-10-21T09:58:00Z', days: 14, count: 2, posts: [
    post('both', '2026-10-20T08:00:00Z', 100, [c('a', 'only in the 14-day read', '2026-10-20T09:00:00Z'), c('b', 'in both', '2026-10-20T09:05:00Z')], 2),
    post('fastOnly', '2026-10-19T08:00:00Z', 50, [], 0),
  ] };
  const full = { source: track.source, fetchedAt: '2026-10-21T09:59:00Z', days: 60, count: 2, comments: { partial: true }, posts: [
    post('both', '2026-10-20T08:00:00Z', 140, [c('b', 'in both', '2026-10-20T09:05:00Z'), c('c', 'new since', '2026-10-21T09:50:00Z')], 2),
    post('old', '2026-09-01T08:00:00Z', 900, [c('d', 'old post comment', '2026-09-01T09:00:00Z')], 1),
  ] };
  const X = pageWith({ track14: fast, track60: full, snapshot: null });
  try {
    await new Promise((r) => setTimeout(r, 1800)); // the missing snapshot is retried once after 1.5 s before the 60-day read
    const m = X.sentiMergeWindows(fast, full);
    assert.deepEqual(m.posts.map((p) => p.postId), ['both', 'fastOnly', 'old'], 'every post of either read, newest first');
    const both = m.posts[0];
    assert.equal(both.metrics.views, 140, 'metrics from the read fetched later');
    assert.deepEqual(both.comments.map((x) => x.text).sort(), ['in both', 'new since', 'only in the 14-day read'], 'union of comments, none duplicated');
    assert.equal(both.commentsCollected, 2);
    assert.equal(m.days, 60); assert.equal(m.count, 3);
    // the other order (14-day read fetched later) takes the 14-day metrics
    const late = X.sentiMergeWindows({ ...fast, fetchedAt: '2026-10-21T10:00:00Z' }, full);
    assert.equal(late.posts.find((p) => p.postId === 'both').metrics.views, 100);
    // the page itself ends on the merged window
    assert.deepEqual(X.SENTI.posts.map((p) => p.postId).sort(), ['both', 'fastOnly', 'old']);
    assert.equal(X.SENTI.posts.find((p) => p.postId === 'both').comments.length, 3);
  } finally { X.restore(); }
});

test('7.2 benchmark panel: the server\'s cells as computed (no statistic derived in the page), labelled not boost advice; per-post lines for standing, young, giveaway; the KPI is a median at ≥ 500 views', async () => {
  const id = track.posts[0].postId.replace(/^(tiktok|instagram|facebook|x)-/, '');
  const bench = {
    asOf: '2026-10-21T09:00:00.000Z', windowDays: 90, minN: 20, minViews: 500, snapshotsSince: '2026-10-20T06:30:00Z', excludedLowViews: { tiktok: 42 },
    cells: [
      { platform: 'tiktok', format: 'all', band: 'mature', kind: 'organic', metric: 'er', n: 114, p25: 0.053596, median: 0.069100, p75: 0.081713, p90: 0.098361, excludedLowViews: 42, sharesAssumedZero: 0 },
      { platform: 'x', format: 'text', band: 'mature', kind: 'organic', metric: 'er', n: 3, excludedLowViews: 20, sharesAssumedZero: 0 },
      { platform: 'instagram', format: 'video', band: '3-7d', kind: 'organic', metric: 'er', n: 15, excludedLowViews: 0, sharesAssumedZero: 0 },
      { platform: 'facebook', format: 'all', band: 'mature', kind: 'giveaway', metric: 'engagements', n: 18, excludedLowViews: 0, sharesAssumedZero: 0 },
    ],
    posts: { [id]: { band: 'mature', format: 'all', giveaway: null, standing: { metric: 'er', value: 0.0841, percentile: 80, of: 114, aboveP75: true, note: 'benchmark among mature posts — not boost advice' } } },
  };
  const X = pageWith({ bench });
  try {
    await new Promise((r) => setTimeout(r, 80));
    const html = X.rBenchPanel();
    assert.match(html, /a benchmark, not boost advice/);
    assert.match(html, /TikTok<\/td><td>ER<\/td><td class="num">114<\/td><td class="num">5\.36 %<\/td><td class="num">6\.91 %<\/td><td class="num">8\.17 %<\/td><td class="num">9\.84 %<\/td><td class="num dim">42<\/td>/);
    assert.match(html, /X text<\/td><td>ER<\/td><td class="num">3<\/td><td colspan="4" class="dim">n &lt; 20: count only/);
    assert.match(html, /Instagram video: 3–7 days n = 15/);
    assert.match(html, /Giveaways, counted apart and never ranked: Facebook 18/);
    const p = track.posts[0];
    assert.match(X.benchChip({ ...p, platform: 'tiktok' }), /ER 8\.41 % — P80 of 114 mature TikTok organic posts \(90 d\) · benchmark among mature posts — not boost advice/);
    X.BENCH.data.posts[id] = { band: '0-1d', format: 'video', giveaway: 'suspected', young: { n: 3, expected: '2026-10-29', reason: 'benchmarks for posts under 7 days not yet available' } };
    assert.match(X.benchChip({ ...p, platform: 'instagram' }), /benchmarks for posts under 7 days not yet available — expected 2026-10-29 \(n = 3 of 20\) · suspected giveaway \(comments concentrated\) — confirm/);
    X.BENCH.data.posts[id] = { band: 'mature', format: 'all', giveaway: 'caption' };
    assert.match(X.benchChip(p), /Giveaway — counted apart from organic posts, not ranked/);
    // the headline ER is a nearest-rank median over posts with ≥ 500 views, never a mean
    const s = X.pfStats([{ platform: 'tiktok', metrics: { views: 1000, er: 0.01 } }, { platform: 'tiktok', metrics: { views: 1000, er: 0.02 } }, { platform: 'tiktok', metrics: { views: 1000, er: 0.9 } }, { platform: 'tiktok', metrics: { views: 100, er: 0.5 } }]);
    assert.equal(s.medEr, 0.02); assert.equal(s.ers.length, 3);
  } finally { X.restore(); }
});

test('7.1 decisions strip and "handled": the page key equals the server key for every copy of a comment; flagged rows offer the mark; the strip counts flagged vs handled and says boost is not yet supportable', async () => {
  const path = require('node:path');
  const { commentKey } = require(path.join(__dirname, '..', '..', 'api', '_handlers', 'sentiment.js'));
  const c = { postId: 'instagram-p1', author: 'Amal', text: 'I want a refund, the screen broke!!', at: '2026-10-21T08:00:00Z', platform: 'instagram' };
  const key = commentKey(c);
  const X = pageWith({ handled: { handled: { [key]: { handled: true, by: 'Rev', at: '2026-10-21T09:00:00Z' } }, rows: 1 } });
  try {
    await new Promise((r) => setTimeout(r, 80));
    for (const v of [c, { ...c, postId: 'p1', text: 'I want a refund the screen broke', author: ' amal ' }, { ...c, text: 'I want a refund, the screen broke!! @samsunggulf' }]) assert.equal(X.handledKey(v), commentKey(v), JSON.stringify(v));
    assert.equal(X.handledKey({ ...c, text: '' }), commentKey({ ...c, text: '' }), 'blank text keyed by time on both sides');
    X.loadHandled && (await X.loadHandled());
    const row = X.rCommentRow(c);
    assert.match(row, /✓ HANDLED/); assert.match(row, /by Rev/);
    const other = X.rCommentRow({ ...c, author: 'sara' });
    assert.match(other, /Mark handled/, 'a flagged comment nobody handled offers the mark');
    assert.doesNotMatch(X.rCommentRow({ ...c, author: 'zed', text: 'nice phone' }), /Mark handled/, 'unflagged comments carry no control');
    const strip = X.rDecisions([{ postId: 'instagram-p1', platform: 'instagram', comments: [c, { ...c, author: 'sara' }, { ...c, author: 'zed', text: 'nice phone' }] }], {});
    assert.match(strip, /2 flagged comments · 1 handled/);
    assert.match(strip, /Boost<\/span><div[^>]*>Not yet supportable/);
    assert.match(strip, /Mapped from caption text/);
    assert.match(strip, /What works for which product and market<\/span><div[^>]*>Not yet supportable/);
    assert.match(strip, /Stop<\/span>/);
  } finally { X.restore(); }
});

test('7.3: a comment the tracker has not analysed shows "not analysed" and stays out of every sentiment count', async () => {
  const X = pageWith();
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.match(X.sentiBadge(null), /NOT ANALYSED/); assert.doesNotMatch(X.sentiBadge('neu'), /NOT ANALYSED/);
    const s = X.pfStats([{ platform: 'tiktok', metrics: {}, comments: [{ text: 'a', sentiment: 'pos' }, { text: 'b', sentiment: null }, { text: 'c', sentiment: 'neg' }] }]);
    assert.deepEqual([s.pos, s.neu, s.neg, s.analyzed, s.posRate], [1, 0, 1, 2, 50]);
  } finally { X.restore(); }
});

test('7.3: below 70 % analysed, the sentiment rates carry "based on N of M comments, mostly recent"', async () => {
  const X = pageWith();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const cm = (n, lab) => Array.from({ length: n }, (_, i) => ({ text: `t${lab}${i}`, sentiment: lab }));
    const low = X.pfStats([{ platform: 'tiktok', metrics: {}, comments: [...cm(6, 'pos'), ...cm(4, null)] }]);
    assert.equal(low.coverageLow, true);
    assert.match(X.sentiCoverageWarn(low), /based on 6 of 10 comments \(60 %\), mostly recent/);
    const ok = X.pfStats([{ platform: 'tiktok', metrics: {}, comments: [...cm(7, 'pos'), ...cm(3, null)] }]);
    assert.equal(ok.coverageLow, false); assert.equal(X.sentiCoverageWarn(ok), '');
  } finally { X.restore(); }
});
