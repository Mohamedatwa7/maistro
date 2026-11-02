// Phase 6.9 — lineage and stage invalidation: every version records the upstream versions it was built from;
// replacing an upstream version makes every stage built on it (directly or through a stale stage) stale;
// a stale version cannot be approved; regenerating from the current upstream clears it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, loadPage } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const { staleStages, CONSUMES } = require('../../src/domain/stages.js');

test('staleStages: direct and transitive staleness along brief → mood → board → thumb (owner 2026-11-02), pre-lineage versions never claimed stale', () => {
  assert.deepEqual(CONSUMES.brief, ['plan']); assert.deepEqual(CONSUMES.mood, ['plan', 'brief']); assert.deepEqual(CONSUMES.board, ['brief', 'mood']); assert.deepEqual(CONSUMES.thumb, ['brief', 'mood']);
  const stages = [{ kind: 'brief', current_version_id: 'b2' }, { kind: 'mood', current_version_id: 'm1' }, { kind: 'thumb', current_version_id: 't1' }, { kind: 'board', current_version_id: 'old' }];
  const inputs = new Map([['b2', { plan: 'p1' }], ['m1', { plan: 'p1', brief: 'b1' }], ['t1', { brief: 'b2', mood: 'm1' }], ['old', null]]);
  const st = staleStages([{ kind: 'plan', current_version_id: 'p1' }, ...stages], inputs);
  assert.deepEqual(st.map((x) => x.kind), ['mood', 'thumb'], 'a new brief: the moodboard directly, the thumbnail through it; the pre-lineage storyboard never');
  assert.deepEqual(st[0].because, [{ kind: 'brief', built: 'b1', current: 'b2' }]);
  assert.deepEqual(st[1].because, [{ kind: 'mood', built: 'm1', current: 'm1', via: ['brief'] }], 'the thumbnail is stale through the stale moodboard');
});

test('store: versions record their inputs; an admin reopen + new brief makes the approved moodboard and the thumbnail stale; a stale version can still be approved; regenerating clears it; listPieces exposes it', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const pieces = api('pieces.js', { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }); const decisions = api('decisions.js', { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  try {
    const store = require('../../api/_store.js');
    const p1 = await store.recordVersion('gen-inv', 'plan', { title: 'I', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#000000', '#111111'] }, { piece: { title: 'I', product: 'Galaxy Z Flip8' } });
    const approve = async (stage, role = 'reviewer') => { const r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-inv', stage, decision: 'approved', name: 'N', role } }), r); return r; };
    const BRIEF = (o) => ({ objective: o, msg: 'k', markets: ['UAE'], platforms: ['tiktok'], mandatories: [] });
    const b1 = await store.recordVersion('gen-inv', 'brief', BRIEF('o'), {});
    const m1 = await store.recordVersion('gen-inv', 'mood', { imageUrl: 'https://cdn/m1.png' }, {});
    const t1 = await store.recordVersion('gen-inv', 'thumb', { imageUrl: 'https://cdn/t1.png' }, {});
    const v = (id) => pg.tables.artifact_versions.find((x) => x.id === id);
    assert.deepEqual(v(m1.versionId).inputs, { plan: p1.versionId, brief: b1.versionId }); assert.deepEqual(v(t1.versionId).inputs, { brief: b1.versionId, mood: m1.versionId });
    assert.equal((await approve('brief')).statusCode, 200); assert.equal((await approve('mood')).statusCode, 200);
    // the owner changes the approved brief: admin reopen — before the new version lands the moodboard says "upstream reopened"
    await store.reopen('gen-inv', 'brief', 'admin');
    const pc0 = (await store.listPieces()).find((x) => x.id === 'gen-inv');
    assert.deepEqual(pc0.stages.mood.upstreamReopened, ['brief']); assert.equal(pc0.stages.mood.stale, undefined, 'not stale yet: the version is unchanged');
    const b2 = await store.recordVersion('gen-inv', 'brief', BRIEF('o2'), {});
    const pc = (await store.listPieces()).find((x) => x.id === 'gen-inv');
    assert.deepEqual(pc.stages.mood.stale, ['brief']); assert.deepEqual(pc.stages.thumb.stale, ['brief', 'mood'], 'the thumbnail: directly (old brief) and through the stale moodboard'); assert.equal(pc.stages.brief.stale, undefined);
    // regenerate the moodboard from the current brief (admin reopens the approved one first) → fresh; the thumbnail is now directly stale
    await store.reopen('gen-inv', 'mood', 'admin');
    const m2 = await store.recordVersion('gen-inv', 'mood', { imageUrl: 'https://cdn/m2.png' }, {});
    assert.deepEqual(v(m2.versionId).inputs, { plan: p1.versionId, brief: b2.versionId });
    const pc2 = (await store.listPieces()).find((x) => x.id === 'gen-inv');
    assert.equal(pc2.stages.mood.stale, undefined); assert.deepEqual(pc2.stages.thumb.stale, ['brief', 'mood'], 'still built from the old brief and moodboard');
    // owner 2026-10-29: no approval depends on the step before — a stale thumbnail can still be approved (the page says it is out of date)
    assert.equal((await approve('thumb')).statusCode, 200);
    await store.reopen('gen-inv', 'thumb', 'admin');
    await store.recordVersion('gen-inv', 'thumb', { imageUrl: 'https://cdn/t2.png' }, {});
    assert.equal((await store.listPieces()).find((x) => x.id === 'gen-inv').stages.thumb.stale, undefined, 'a thumbnail rebuilt from the current upstream is fresh');
  } finally { f.restore(); pieces.restore(); decisions.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('page: a stale stage shows why, and that it can still be approved', () => {
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    const p = { id: 'gen-st', generated: true, studio: true, stage: 4, title: 'T', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'p', msg: 'm', angle: 'a' }, brief: { objective: 'o', msg: 'k', markets: ['UAE'], platforms: [], mandatories: ['x'], deadline: '30 Oct 2026' }, stale: { brief: ['thumb'] } };
    X.PROJECTS.unshift(p);
    const html = X.stageArtifact(p, 3);
    assert.match(html, /Out of date\.<\/b> This detailed brief was built from an older thumbnail — regenerate it/i); assert.match(html, /you can still approve it as it is/);
  } finally { X.restore(); }
});
