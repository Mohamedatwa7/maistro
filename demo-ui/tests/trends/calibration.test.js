// 5.9 eval, first set: the recorded judgements of the 2026-10-21 19:15 UTC run (profile-v1.1, Sonnet 5.5)
// re-scored with today's engine. Measures the needs_review rate before and after the advisory
// culture/origin semantics. The prompt change (v1.2, audioExplicit) needs a live run to measure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers');
const { scoreOne } = require('../../api/_trends/engine.js');

const F = fixture('trend-scores-2026-10-21T1915.json');
const NOW = '2026-10-21T19:15:27.856Z';

function rescore(r) {
  // the stored row carries the judgement and the computed timing; rebuild a minimal trend + snapshot
  const snaps = [{ trend_id: r.trendId, fetched_at: '2026-10-21T08:30:00Z', board_generated_at: '2026-10-21T08:25:58.646Z', stage: r.lifecycle, durability: 'ongoing', growth_pct_per_day: 1, sound_cleared: (r.vetoes || []).some((v) => v.code === 'V-AUDIO' && !v.needsReview && /not cleared/.test(v.reason || '')) ? false : (r.vetoes || []).some((v) => v.code === 'V-AUDIO' && v.needsReview && /commercial-use status/.test(v.reason || '')) ? null : true }];
  const trend = { trendId: r.trendId, name: r.name, sound: { title: 'recorded sound', cleared: snaps[0].sound_cleared, clearedCheckedAt: '2026-10-21T08:00:00Z' } };
  return scoreOne({ trend, snaps, judgement: r.judgement, leadDays: null, stayDays: {}, now: NOW, latestBoardAt: '2026-10-21T08:25:58.646Z' });
}

test('calibration eval on the recorded 19:15 run: culture/origin flags no longer hold trends out of the ranking; safety, audio and hard vetoes are unchanged', () => {
  const judged = F.rows.filter((r) => r.judgement);
  assert.equal(judged.length, 25);
  const before = judged.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  assert.deepEqual(before, { needs_review: 15, scored: 1, vetoed: 9 }, 'as recorded');
  const after = {}; const advisoryOnly = []; const stillReview = [];
  for (const r of judged) {
    const s = rescore(r);
    after[s.status] = (after[s.status] || 0) + 1;
    if (r.status === 'vetoed') assert.equal(s.status, 'vetoed', `${r.name}: a hard veto still rejects`);
    if (s.status === 'scored' && s.reviewBeforeUse.length) { advisoryOnly.push(r.name); assert.equal(s.confidence, 'low', `${r.name}: advisory flags force low confidence`); }
    if (s.status === 'needs_review') { stillReview.push(r.name); assert.ok(s.vetoes.some((v) => v.needsReview && !v.advisory && ['V-SAFETY', 'V-AUDIO'].includes(v.code)), `${r.name}: only safety/audio keep needs_review`); }
  }
  // "What iPad Trend" carries only V-CULTURE → ranked now; the other 14 also carry a safety or audio flag
  assert.ok(advisoryOnly.includes('What iPad Trend'), JSON.stringify(advisoryOnly));
  assert.equal(after.vetoed, 9); assert.equal(after.needs_review, 14); assert.equal(after.scored, 2);
  // the remaining needs_review are almost all the v1.1 "no lyrics" audioExplicit flag that profile v1.2 addresses
  const lyricOnly = judged.filter((r) => stillReview.includes(r.name) && r.judgement.audioExplicit.verdict === 'needsReview' && /lyric/i.test(r.judgement.audioExplicit.rationale) && r.judgement.safety.verdict === 'pass');
  assert.ok(lyricOnly.length >= 10, `${lyricOnly.length} of ${stillReview.length} held only by the lyrics rule`);
});
