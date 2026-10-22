// 7.6 — the loop's gates: withheld below 30 attributed posts; a proposal only for a group with n ≥ 20 ranked whose
// median differs from the rest by ≥ 15 points AND in both halves of the window; every proposal is a hypothesis with
// the number of groups compared; never from unranked standings.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../api/_perf/learnings.js');

const day = (i) => new Date(Date.parse('2026-11-01T00:00:00Z') + i * 864e5).toISOString();
const rec = (path, pct, i, conf = 'high', band = 'mature') => ({ link: { platform: 'tiktok', linkedAt: day(i) }, performance: { postedAt: day(i) }, piece: { path, angle: null, product: null }, trend: { confidence: conf }, totalRounds: 0, standing: { band, format: 'all', giveaway: null, percentile: pct } });
// Studio and Hermes posts interleaved in time, so both halves of the window hold both groups
const mixed = (studio, hermes, conf = ['high', 'low']) => [...Array.from({ length: 20 }, (_, i) => rec('Studio', studio(i), 2 * i, conf[0])), ...Array.from({ length: 20 }, (_, i) => rec('Hermes', hermes(i), 2 * i + 1, conf[1]))];

test('29 attributed posts: withheld, no proposals, the count says how far', () => {
  const r = L.learnings(Array.from({ length: 29 }, (_, i) => rec('Studio', 90 + (i % 5), i)));
  assert.deepEqual(r, { withheld: true, attributed: 29, needed: 30, proposals: [] });
});

test('40 posts with a gap that holds in both halves → hypotheses per loop, with n and groups compared', () => {
  const r = L.learnings(mixed((i) => 70 + i, (i) => 30 + i));
  assert.equal(r.withheld, false); assert.equal(r.groupsCompared, 4, 'path ×2 and confidence ×2; rounds and format put every post in one group, so there is no rest to compare');
  const by = Object.fromEntries(r.proposals.map((p) => [`${p.attribute}=${p.value}`, p]));
  const s = by['path=Studio'];
  assert.deepEqual([s.target, s.medianPercentile, s.restMedianPercentile, s.gap, s.n, s.groupsCompared], ['content', 79, 39, 40, 20, 4]);
  assert.ok(s.halfGaps.every((g) => g >= 15));
  assert.match(s.statement, /^Hypothesis — path = Studio/); assert.match(s.statement, /in each half of the window/); assert.match(s.statement, /not an automatic change/);
  assert.equal(by['trendConfidence=high'].target, 'trend_calibration');
});

test('no proposal: a small gap; a gap only in one half of the window; young standings', () => {
  assert.deepEqual(L.learnings(mixed((i) => 40 + i, (i) => 42 + i)).proposals, [], 'a 2-point gap is not a learning');
  // Studio outperforms only in the first half: early Studio posts high, late ones level with Hermes
  const oneHalf = L.learnings(mixed((i) => (i < 10 ? 90 + i : 45 + i), (i) => 40 + i));
  assert.deepEqual(oneHalf.proposals.filter((p) => p.attribute === 'path'), [], 'the gap must hold in both halves');
  const young = L.learnings([...Array.from({ length: 20 }, (_, i) => rec('Studio', 70 + i, 2 * i, 'high', '0-1d')), ...Array.from({ length: 20 }, (_, i) => rec('Hermes', 30 + i, 2 * i + 1, 'low'))]);
  assert.deepEqual(young.proposals, [], 'young standings are not ranked, so neither group reaches 20');
});
