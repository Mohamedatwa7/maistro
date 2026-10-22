// Phase 10 — generation-side efficiency computed from stored rows: per-kind success and latency (n ≥ 5 for
// percentiles), F1X8 latency, stage turnaround (first version → first approval), cost per approved piece.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const O = require('../../api/_perf/ops.js');

test('ops: latency percentiles only at n ≥ 5, success rates, turnaround from first version to approval, cost per approved piece', () => {
  const rec = (kind, status, ms, cost, piece) => ({ kind, status, latency_ms: ms, cost_usd: cost, piece_id: piece });
  const records = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => rec('f1x8', 'succeeded', s * 60000, null, 'a')),
    rec('higgsfield_video', 'succeeded', 90000, 2.311, 'a'), rec('higgsfield_video', 'succeeded', 120000, 2.311, 'a'), rec('higgsfield_video', 'failed', 30000, 0, 'b'),
    rec('higgsfield_image', 'succeeded', 40000, 0.006, 'b'),
  ];
  const stages = [{ id: 'sa', piece_id: 'a', kind: 'brief', state: 'approved' }, { id: 'fa', piece_id: 'a', kind: 'final', state: 'approved' }, { id: 'fb', piece_id: 'b', kind: 'final', state: 'generated' }];
  const versions = [{ id: 'v1', stage_id: 'sa', created_at: '2026-10-21T08:00:00Z' }, { id: 'v2', stage_id: 'sa', created_at: '2026-10-21T09:00:00Z' }, { id: 'vf', stage_id: 'fa', created_at: '2026-10-22T08:00:00Z' }];
  const approvals = [{ artifact_version_id: 'v1', decision: 'rejected', decided_at: '2026-10-21T08:30:00Z' }, { artifact_version_id: 'v2', decision: 'approved', decided_at: '2026-10-21T10:00:00Z' }, { artifact_version_id: 'vf', decision: 'approved', decided_at: '2026-10-22T09:30:00Z' }];
  const r = O.ops({ records, stages, versions, approvals, days: 30 });
  assert.deepEqual(r.f1x8LatencyS, { n: 10, p50: 300, p90: 540 }, 'nearest rank over 60..600 s');
  assert.deepEqual(r.kinds.higgsfield_video.latencyS, { n: 3 }, 'n = 3: count only');
  assert.equal(r.kinds.higgsfield_video.successRate, 0.67); assert.equal(r.kinds.higgsfield_video.costUsd, 4.62);
  assert.deepEqual(r.turnaroundH, { brief: { n: 1 }, final: { n: 1 } }, 'one piece per stage: counts only');
  assert.deepEqual([r.cost.approvedPieces, r.cost.perApprovedPieceUsd, r.cost.allPiecesUsd], [1, 4.62, 4.63]);
});

test('ops: turnaround hours run from the first version to the first approval (approvals 1–5 h after → P50 3 h, P90 5 h)', () => {
  const stages = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, piece_id: `p${i}`, kind: 'brief', state: 'approved' }));
  const versions = stages.map((s, i) => ({ id: `v${i}`, stage_id: s.id, created_at: '2026-10-21T08:00:00Z' }));
  const approvals = versions.map((v, i) => ({ artifact_version_id: v.id, decision: 'approved', decided_at: new Date(Date.parse('2026-10-21T08:00:00Z') + (i + 1) * 36e5).toISOString() }));
  assert.deepEqual(O.ops({ records: [], stages, versions, approvals, days: 30 }).turnaroundH.brief, { n: 5, p50: 3, p90: 5 });
});

test('ops route: GET /api/studio?ops=1 is signed-in only and reads the stored rows', async () => {
  const { api, req, res, mockFetch } = require('../helpers');
  const { fakePostgrest } = require('../fake-postgrest');
  const pg = fakePostgrest();
  (pg.tables.generation_records = []).push({ id: 1, kind: 'f1x8', status: 'succeeded', latency_ms: 60000, cost_usd: null, piece_id: null, at: new Date().toISOString() });
  const f = mockFetch([pg.route]);
  const studio = api('studio.js', { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  try {
    let r = res(); await studio.handler(req({ query: { ops: '1' }, session: false }), r);
    assert.equal(r.statusCode, 401);
    r = res(); await studio.handler(req({ query: { ops: '1', days: '7' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.days, 7); assert.deepEqual(r.body.f1x8LatencyS, { n: 1 });
  } finally { f.restore(); studio.restore(); }
});
