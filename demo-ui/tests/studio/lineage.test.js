// Phase 6.9 — lineage: from the final cut, every shot traces back to its clip, keyframe, storyboard line and generation
// records; the brief, storyboard and moodboard versions, the angle and the trend are named, with the recorded inputs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };

test('GET /api/studio?lineage= traces the final cut to the trend', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const studio = api('studio.js', ENV); const pieces = api('pieces.js', ENV);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-lin', stage: 'plan', artifact: { title: 'L', product: 'Galaxy Z Flip8', msg: 'm', angle: 'reveal', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'L', product: 'Galaxy Z Flip8', angle: 'reveal', trendId: 'snd-1', trendName: 'Deadpan caption reveal' } } }), r);
    const store = require('../../api/_store.js');
    await store.recordVersion('gen-lin', 'mood', { imageUrl: 'https://cdn/m.png', directionVersion: 'mood-direction-v1-2026-10-21', setMode: 'variations' }, {});
    const bv = await store.recordVersion('gen-lin', 'brief', { objective: 'o', msg: 'k', markets: [], platforms: [], mandatories: [], spec: { keyMessage: 'Small enough to disappear', cta: 'Flip it' } }, {});
    await store.recordVersion('gen-lin', 'board', { shots: [{ n: 1, type: 'close_up', camera: 'push-in', action: 'reveal', onScreenText: { en: 'Hook', ar: '' }, line: { en: '', ar: '' }, product: { visible: true, feature: 'FlexWindow' }, keyframe: { assetPath: 'pieces/gen-lin/board/k1.png', jobId: 'aaaaaaaa-0000-0000-0000-000000000001' } }] }, {});
    const fv = await store.recordVersion('gen-lin', 'final', { shots: [{ n: 1, clip: { assetPath: 'pieces/gen-lin/final/c1.mp4', sha256: 'c'.repeat(64), jobId: 'aaaaaaaa-0000-0000-0000-000000000002', fromKeyframe: 'pieces/gen-lin/board/k1.png' }, review: { decision: 'approved', by: 'N' } }], assembled: { assetPath: 'pieces/gen-lin/final/cut.mp4', sha256: 'f'.repeat(64) }, fromDraftVersionId: 'd1', fromQcVersionId: 'q1' }, { producedBy: 'higgsfield_seedance', kind: 'video' });
    const pid = pg.tables.content_pieces[0].id;
    pg.tables.generation_records = [
      { id: 1, at: '2026-10-22T05:00:00Z', piece_id: pid, stage: 'board', kind: 'higgsfield_image', model: null, prompt_name: 'director.prompt', prompt_version: null, params: { seed: 4242 }, seed: null, status: 'succeeded', cost_usd: 0.09, job_id: 'aaaaaaaa-0000-0000-0000-000000000001' },
      { id: 2, at: '2026-10-22T05:10:00Z', piece_id: pid, stage: 'final', kind: 'higgsfield_video', model: null, prompt_name: 'director.prompt', prompt_version: null, params: {}, seed: null, status: 'succeeded', cost_usd: 0.6, job_id: 'aaaaaaaa-0000-0000-0000-000000000002' },
      { id: 3, at: '2026-10-22T04:00:00Z', piece_id: pid, stage: 'brief', kind: 'claude', model: 'claude-opus-5-5', prompt_name: 'studio.brief', prompt_version: 'brief-v1-2026-10-21', params: {}, seed: null, status: 'succeeded', cost_usd: null, job_id: null },
    ];
    r = res(); await studio.handler(req({ method: 'GET', query: { lineage: 'gen-lin' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const L = r.body;
    assert.deepEqual(L.piece.trend, { id: 'snd-1', name: 'Deadpan caption reveal' }); assert.equal(L.piece.angle, 'reveal');
    assert.equal(L.cut.stage, 'final'); assert.equal(L.cut.versionId, fv.versionId); assert.equal(L.cut.sha256, 'f'.repeat(64));
    const s1 = L.shots[0];
    assert.equal(s1.clip.sha256, 'c'.repeat(64)); assert.equal(s1.clip.generation.costUsd, 0.6); assert.equal(s1.keyframe.assetPath, 'pieces/gen-lin/board/k1.png'); assert.equal(s1.keyframe.generation.seed, 4242);
    assert.equal(s1.storyboardLine.action, 'reveal'); assert.equal(s1.storyboardLine.feature, 'FlexWindow'); assert.equal(s1.review.decision, 'approved');
    assert.equal(L.brief.keyMessage, 'Small enough to disappear'); assert.equal(L.brief.generation.promptVersion, 'brief-v1-2026-10-21'); assert.equal(L.moodboard.directionVersion, 'mood-direction-v1-2026-10-21');
    assert.equal(L.stages.board.inputs.brief, bv.versionId, 'the storyboard records the brief it was built from');
    r = res(); await studio.handler(req({ method: 'GET', query: { lineage: 'gen-none' } }), r); assert.equal(r.statusCode, 404);
  } finally { f.restore(); studio.restore(); pieces.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});
