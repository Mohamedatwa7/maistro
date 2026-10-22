// 7.5 — attribution records (trend score at decision time, F1X8, revision rounds, stage history, standing) and
// the analysis rules (mature organic standings only, n ≥ 20 for a median, no weights below 30 attributed posts).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../api/_perf/attribution.js');

function rows() {
  return {
    links: [{ id: 1, piece_id: 'pc', platform: 'tiktok', post_id: '75', url: 'u', account: 'samsunggulf', linked_by_label: 'Lina', linked_at: '2026-10-25T09:00:00Z', source: 'manual' }],
    pieces: [{ id: 'pc', legacy_id: 'gen-1', title: 'Deadpan', product: 'Galaxy Z Flip8', markets: ['UAE'], platforms: ['tiktok'], angle: 'caption reveal', trend_id: 't1', trend_name: 'Deadpan reveal', origin: 'studio', created_at: '2026-10-21T10:00:00Z' }],
    stages: [
      { id: 's-brief', piece_id: 'pc', kind: 'brief', state: 'approved', current_version_id: 'v-b2' },
      { id: 's-qc', piece_id: 'pc', kind: 'qc', state: 'approved', current_version_id: 'v-q1' },
      { id: 's-final', piece_id: 'pc', kind: 'final', state: 'approved', current_version_id: 'v-f1' },
    ],
    versions: [
      { id: 'v-b1', stage_id: 's-brief', version: 1, payload: {} }, { id: 'v-b2', stage_id: 's-brief', version: 2, payload: {} },
      { id: 'v-q1', stage_id: 's-qc', version: 1, payload: {} },
      { id: 'v-f1', stage_id: 's-final', version: 1, payload: { verification: { score: 8.4, scoreBefore: 7.1 } } },
    ],
    approvals: [
      { artifact_version_id: 'v-b1', decision: 'rejected', reason_code: 'off_brief', name_as_signed: 'Lina', role_as_signed: 'line_manager', decided_at: '2026-10-21T11:00:00Z' },
      { artifact_version_id: 'v-b2', decision: 'approved', name_as_signed: 'Lina', role_as_signed: 'line_manager', decided_at: '2026-10-21T12:00:00Z' },
      { artifact_version_id: 'v-f1', decision: 'approved', name_as_signed: 'Omar', role_as_signed: 'adlcp_approver', decided_at: '2026-10-24T12:00:00Z' },
    ],
    qc: [{ artifact_version_id: 'v-q1', score: 7.1, created_at: '2026-10-23T10:00:00Z' }, { artifact_version_id: 'v-q1', score: 6.0, created_at: '2026-10-23T08:00:00Z' }],
    decisions: [{ trend_id: 't1', score_id: 11, decision: 'pick', at: '2026-10-21T09:00:00Z' }],
    scores: [{ id: 11, trend_id: 't1', at: '2026-10-21T08:15:00Z', status: 'scored', final_score: 71.5, confidence: 'high' }, { id: 12, trend_id: 't1', at: '2026-10-22T08:15:00Z', status: 'scored', final_score: 60, confidence: 'med' }],
  };
}

test('record: trend score from the pick decision (not a later re-score), F1X8 QC (newest) and final, rounds per stage, history in time order, standing joined', () => {
  const posts = { 'tiktok|75': { postedAt: '2026-10-25T07:00:00Z', metrics: { views: 5000, er: 0.08 }, mediaType: 'video' } };
  const bench = { posts: { 75: { band: 'mature', format: 'all', giveaway: null, standing: { metric: 'er', value: 0.08, percentile: 74, of: 114, note: 'benchmark among mature posts — not boost advice' } } } };
  const [r] = A.records({ ...rows(), posts, bench });
  assert.deepEqual(r.trend, { id: 't1', name: 'Deadpan reveal', score: 71.5, confidence: 'high', status: 'scored', scoredAt: '2026-10-21T08:15:00Z', basis: 'pick decision' });
  assert.deepEqual(r.f1x8, { qc: 7.1, final: 8.4, finalBefore: 7.1 });
  assert.deepEqual(r.revisionRounds, { brief: 1, qc: 0, final: 0 }); assert.equal(r.totalRounds, 1);
  assert.deepEqual(r.stageHistory.map((h) => [h.stage, h.version, h.decision, h.by]), [['brief', 1, 'rejected', 'Lina'], ['brief', 2, 'approved', 'Lina'], ['final', 1, 'approved', 'Omar']]);
  assert.equal(r.piece.path, 'Studio'); assert.equal(r.standing.percentile, 74); assert.equal(r.performance.metrics.views, 5000);
  // without a pick decision: the newest score made before the piece, labelled so
  const [r2] = A.records({ ...rows(), decisions: [] });
  assert.deepEqual([r2.trend.score, r2.trend.basis], [71.5, 'latest score before the piece']);
  assert.equal(r2.performance, null, 'post not in the window: no performance, still attributed');
});

test('analysis: only mature organic standings are ranked; a median needs n ≥ 20 in the group; weights withheld below 30 attributed posts', () => {
  const mk = (i, path, pct, band = 'mature', giveaway = null) => ({ link: { platform: 'tiktok' }, piece: { path, product: 'Galaxy Z Flip8', angle: 'a' }, trend: { confidence: 'high' }, totalRounds: i % 4, standing: { band, format: 'all', giveaway, percentile: pct } });
  const recs = [...Array.from({ length: 20 }, (_, i) => mk(i, 'Studio', i + 1)), mk(0, 'Hermes', 90), mk(0, 'Studio', 99, '0-1d'), mk(0, 'Studio', 99, 'mature', 'caption')];
  const a = A.analysis(recs);
  assert.equal(a.attributed, 23); assert.equal(a.ranked, 21); assert.equal(a.weightsWithheld, true);
  assert.deepEqual(a.byAttribute.path, [{ value: 'Studio', attributed: 22, ranked: 20, medianPercentile: 10 }, { value: 'Hermes', attributed: 1, ranked: 1 }]);
  assert.deepEqual(a.byAttribute.revisionRounds.map((g) => g.value).sort(), ['0', '1–2', '3+']);
  assert.equal(A.analysis(Array.from({ length: 30 }, (_, i) => mk(i, 'Studio', 50))).weightsWithheld, false);
});
