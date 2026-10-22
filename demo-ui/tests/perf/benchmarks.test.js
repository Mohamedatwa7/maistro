// Phase 7.2 — benchmarks on hand-computed fixtures: nearest rank, the n ≥ 20 cut, the ≥ 500 views filter and its
// exclusion count, giveaway captions (and false positives in both languages), suspected giveaways staying
// organic, young bands with their expected date, and the stale-platform wording.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../../api/_perf/benchmarks.js');

const NOW = Date.parse('2026-10-22T12:00:00Z');
const ago = (d) => new Date(NOW - d * 864e5).toISOString();
let seq = 0;
const post = (o) => ({ postId: `p${++seq}`, platform: 'tiktok', mediaType: 'video', caption: 'organic', postedAt: ago(10), metrics: { views: 1000, likes: 0, comments: 0, shares: null, sharesRaw: 0 }, comments: [], commentsCollected: 0, ...o });

test('nearest rank by hand: 1..10 → P25 = 3, median = 5, P75 = 8, P90 = 9; 1..20 → P25 = 5, median = 10, P75 = 15, P90 = 18', () => {
  const s10 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual([0.25, 0.5, 0.75, 0.9].map((q) => B.rank(s10, q)), [3, 5, 8, 9]);
  const s20 = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.deepEqual(B.stats(s20.slice().reverse()), { n: 20, p25: 5, median: 10, p75: 15, p90: 18 });
  assert.deepEqual(B.stats(s20.slice(0, 19)), { n: 19 }, 'n = 19: count only, no percentiles');
});

test('giveaway captions: word-bounded terms in English and Arabic; explicit false positives are not giveaways', () => {
  for (const t of ['Enter our GIVEAWAY now', 'Win a Galaxy Z Flip8', 'Winners announced Friday', 'Join the contest', 'مسابقة سامسونج الخليج', 'اربح جالكسي', 'السحب يوم الجمعة', 'سحب على ٣ أجهزة'])
    assert.equal(B.isGiveawayCaption(t), true, t);
  for (const t of ['Light from the window', 'Winter look with Watch9', 'Twin cameras, one shot', 'Galaxy Wink filter', 'Meet the Galaxy Win', 'سحب الهاتف من الجيب بسهولة', 'Twinkle lights for the holidays', 'swing into the weekend'])
    assert.equal(B.isGiveawayCaption(t), false, t);
});

test('cells: ER only at ≥ 500 views (exclusions counted), percentiles at n ≥ 20, giveaways counts only and never pooled, IG split by format and IG shares ignored, FB on engagements', () => {
  seq = 0;
  // 20 mature organic TikTok posts, ER = k / 1000 for k = 1..20 (likes = k, comments 0, shares 0)
  const tk = Array.from({ length: 20 }, (_, i) => post({ metrics: { views: 1000, likes: i + 1, comments: 0, shares: null, sharesRaw: 0 } }));
  const low = [post({ metrics: { views: 499, likes: 400, comments: 0, sharesRaw: 0 } }), post({ metrics: { views: null, likes: 5, comments: 0, sharesRaw: 0 } })];
  const give = [post({ caption: 'Giveaway! win a Fold8', metrics: { views: 1000, likes: 900, comments: 0, sharesRaw: 0 } })];
  const igV = post({ platform: 'instagram', mediaType: 'Video', metrics: { views: 1000, likes: 10, comments: 5, shares: 999 } });
  const igI = post({ platform: 'instagram', mediaType: 'Sidecar', metrics: { views: null, likes: 30, comments: 2, shares: 999 } });
  const fb = post({ platform: 'facebook', mediaType: 'post', metrics: { views: null, likes: 7, comments: 2, shares: null, sharesRaw: 1 } });
  const r = B.benchmarks({ posts: [...tk, ...low, ...give, igV, igI, fb], now: NOW, newestByPlatform: { tiktok: ago(0.1) } });
  const cell = (pl, f, kind = 'organic') => r.cells.find((c) => c.platform === pl && c.format === f && c.band === 'mature' && c.kind === kind);
  const t = cell('tiktok', 'all');
  assert.deepEqual({ n: t.n, p25: t.p25, median: t.median, p75: t.p75, p90: t.p90, metric: t.metric, excludedLowViews: t.excludedLowViews }, { n: 20, p25: 0.005, median: 0.01, p75: 0.015, p90: 0.018, metric: 'er', excludedLowViews: 2 });
  assert.deepEqual(r.excludedLowViews, { tiktok: 2 });
  assert.deepEqual(cell('tiktok', 'all', 'giveaway'), { platform: 'tiktok', format: 'all', band: 'mature', kind: 'giveaway', metric: 'er', n: 1, excludedLowViews: 0, sharesAssumedZero: 0 }, 'giveaway: count only');
  assert.equal(cell('instagram', 'video').n, 1); assert.equal(cell('instagram', 'image').metric, 'engagements');
  assert.equal(B.engagements(igV), 15, 'IG shares are never collected: ignored even if present');
  assert.equal(B.engagements(igI), 32);
  assert.equal(cell('facebook', 'all').metric, 'engagements'); assert.equal(B.engagements(fb), 10, 'raw share count used');
  // standing: the post with ER 0.016 sits at P80 of 20, above P75; mature → "not boost advice"
  const st = r.posts[tk[15].postId].standing;
  assert.deepEqual(st, { metric: 'er', value: 0.016, percentile: 80, of: 20, aboveP75: true, note: 'benchmark among mature posts — not boost advice' });
  assert.equal(r.posts[low[0].postId].excluded, 'views < 500'); assert.equal(r.posts[low[0].postId].standing, undefined);
  assert.equal(r.posts[give[0].postId].giveaway, 'caption'); assert.equal(r.posts[give[0].postId].standing, undefined, 'giveaways are not ranked');
});

test('suspected giveaway (comment concentration) is flagged for confirmation but stays in the organic cell', () => {
  seq = 100;
  const tk = Array.from({ length: 19 }, (_, i) => post({ metrics: { views: 1000, likes: i + 1, comments: 0, sharesRaw: 0 } }));
  const entries = Array.from({ length: 12 }, (_, i) => ({ author: `a${i}`, text: 'Fold8 + Watch9 #GalaxyZFold8' }));
  const sus = post({ metrics: { views: 1000, likes: 20, comments: 0, sharesRaw: 0 }, comments: entries, commentsCollected: 30 });
  const r = B.benchmarks({ posts: [...tk, sus], now: NOW, newestByPlatform: { tiktok: ago(0.1) } });
  const e = r.posts[sus.postId];
  assert.equal(e.giveaway, 'suspected'); assert.deepEqual(e.concentration, { suspected: true, collected: 30, voices: 12, shortShare: 1, voiceRatio: 0.4 });
  const organic = r.cells.find((c) => c.platform === 'tiktok' && c.band === 'mature' && c.kind === 'organic');
  assert.equal(organic.n, 20, 'counted in the organic cell'); assert.ok(!r.cells.some((c) => c.kind === 'giveaway'));
  assert.equal(e.standing.of, 20);
  assert.equal(B.concentration({ comments: entries.slice(0, 5), commentsCollected: 5 }).suspected, false, 'below 20 collected: never suspected');
});

test('young posts: no percentile below n = 20, expected date from the posting rate since snapshots began; a stale platform says so and gives no date', () => {
  seq = 200;
  // two TikTok posts since snapshots began (2 days ago) → 1 post/day; the 0–1 d band has 1 observation
  const young = post({ postedAt: ago(0.5) }), other = post({ postedAt: ago(1.5) });
  const snapshots = [{ post_id: other.postId, platform: 'tiktok', posted_at: other.postedAt, at: ago(1), metrics: { views: 2000, likes: 40, comments: 0, sharesRaw: 0 } }];
  const r = B.benchmarks({ posts: [young, other], snapshots, now: NOW, newestByPlatform: { tiktok: ago(0.5) } });
  const y = r.posts[young.postId];
  assert.equal(y.band, '0-1d');
  // rate = 2 posts / 2.229 d since 2026-10-20T06:30Z; (20 − 1) / rate ≈ 21.2 d → 2026-11-12
  assert.deepEqual(y.young, { n: 1, expected: '2026-11-12', reason: 'benchmarks for posts under 7 days not yet available' });
  assert.equal(y.standing, undefined);
  const s = B.benchmarks({ posts: [young], now: NOW, newestByPlatform: { tiktok: '2026-10-17T08:00:00Z' } });
  assert.deepEqual(s.posts[young.postId].young, { n: 0, expected: null, reason: 'no recent data — tracker last collected 2026-10-17' });
});
