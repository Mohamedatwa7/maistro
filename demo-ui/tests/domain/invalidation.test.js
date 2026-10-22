// Phase 6.9 — lineage and stage invalidation: every version records the upstream versions it was built from;
// replacing an upstream version makes every stage built on it (directly or through a stale stage) stale;
// a stale version cannot be approved; regenerating from the current upstream clears it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, loadPage } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const { staleStages, CONSUMES } = require('../../src/domain/stages.js');

test('staleStages: direct and transitive staleness, pre-lineage versions never claimed stale', () => {
  assert.deepEqual(CONSUMES.brief, ['mood', 'thumb']);
  const stages = [{ kind: 'mood', current_version_id: 'm2' }, { kind: 'thumb', current_version_id: 't1' }, { kind: 'brief', current_version_id: 'b1' }, { kind: 'board', current_version_id: 'old' }];
  const inputs = new Map([['m2', { plan: 'p1' }], ['t1', { mood: 'm1' }], ['b1', { mood: 'm2', thumb: 't1' }], ['old', null]]);
  const st = staleStages([{ kind: 'plan', current_version_id: 'p1' }, ...stages], inputs);
  assert.deepEqual(st.map((x) => x.kind), ['thumb', 'brief']);
  assert.deepEqual(st[0].because, [{ kind: 'mood', built: 'm1', current: 'm2' }]);
  assert.deepEqual(st[1].because, [{ kind: 'thumb', built: 't1', current: 't1', via: ['mood'] }], 'brief is stale through the stale thumbnail');
});

test('store: versions record their inputs; an admin reopen + new moodboard makes the approved thumbnail and the brief stale; approving a stale version is refused; regenerating clears it; listPieces exposes it', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const pieces = api('pieces.js', { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }); const decisions = api('decisions.js', { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  try {
    const store = require('../../api/_store.js');
    await store.recordVersion('gen-inv', 'plan', { title: 'I', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#000000', '#111111'] }, { piece: { title: 'I', product: 'Galaxy Z Flip8' } });
    const approve = async (stage, role = 'reviewer') => { const r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-inv', stage, decision: 'approved', name: 'N', role } }), r); return r; };
    const m1 = await store.recordVersion('gen-inv', 'mood', { imageUrl: 'https://cdn/m1.png' }, {});
    const t1 = await store.recordVersion('gen-inv', 'thumb', { imageUrl: 'https://cdn/t1.png' }, {});
    const b1 = await store.recordVersion('gen-inv', 'brief', { objective: 'o', msg: 'k', markets: ['UAE'], platforms: ['tiktok'], mandatories: [] }, {});
    const v = (id) => pg.tables.artifact_versions.find((x) => x.id === id);
    assert.deepEqual(v(t1.versionId).inputs, { mood: m1.versionId }); assert.deepEqual(v(b1.versionId).inputs, { mood: m1.versionId, thumb: t1.versionId });
    assert.equal((await approve('mood')).statusCode, 200); assert.equal((await approve('thumb')).statusCode, 200);
    // the owner changes the approved moodboard: admin reopen, new version
    await store.reopen('gen-inv', 'mood', 'admin');
    const m2 = await store.recordVersion('gen-inv', 'mood', { imageUrl: 'https://cdn/m2.png' }, {});
    const list = await store.listPieces();
    const pc = list.find((x) => x.id === 'gen-inv');
    assert.deepEqual(pc.stages.thumb.stale, ['mood']); assert.deepEqual(pc.stages.brief.stale, ['mood', 'thumb'], 'the brief: directly (old moodboard) and through the stale thumbnail'); assert.equal(pc.stages.mood.stale, undefined);
    let r = await approve('brief'); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'stale_inputs'); assert.match(r.body.error, /older mood and thumb/);
    // regenerate the thumbnail from the current moodboard (admin reopens the approved one first) → fresh; the brief is now directly stale
    await store.reopen('gen-inv', 'thumb', 'admin');
    const t2 = await store.recordVersion('gen-inv', 'thumb', { imageUrl: 'https://cdn/t2.png' }, {});
    assert.deepEqual(v(t2.versionId).inputs, { mood: m2.versionId });
    const pc2 = (await store.listPieces()).find((x) => x.id === 'gen-inv');
    assert.equal(pc2.stages.thumb.stale, undefined); assert.deepEqual(pc2.stages.brief.stale, ['mood', 'thumb'], 'still built from the old moodboard and thumbnail');
    assert.equal((await approve('thumb')).statusCode, 200);
    await store.recordVersion('gen-inv', 'brief', { objective: 'o2', msg: 'k', markets: ['UAE'], platforms: ['tiktok'], mandatories: [] }, {});
    assert.equal((await approve('brief')).statusCode, 200, 'a brief rebuilt from the current upstream can be approved');
  } finally { f.restore(); pieces.restore(); decisions.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('page: a stale stage shows why and that approval is refused', () => {
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    const p = { id: 'gen-st', generated: true, studio: true, stage: 4, title: 'T', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'p', msg: 'm', angle: 'a' }, brief: { objective: 'o', msg: 'k', markets: ['UAE'], platforms: [], mandatories: ['x'], deadline: '30 Oct 2026' }, stale: { brief: ['thumb'] } };
    X.PROJECTS.unshift(p);
    const html = X.stageArtifact(p, 3);
    assert.match(html, /Out of date\.<\/b> This detailed brief was built from an older thumbnail — regenerate it/i);
  } finally { X.restore(); }
});
