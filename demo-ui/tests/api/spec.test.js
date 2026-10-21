// Phase 6.1 item 5: the Creative Spec is derived from the store and versioned only on change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const { syncSpec, latestSpec } = require('../../api/_spec.js');

const SB = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const PLAN = { title: 'Snap & Charge', product: 'Galaxy S26 Ultra', msg: 'Power that snaps on', angle: 'one sentence', markets: ['KSA', 'UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] };

test('syncSpec: a piece gets a spec from its plan; a new stage version changes it (new spec version); a re-sync with nothing new writes nothing; approvals and rejections appear per stage', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const pieces = api('pieces.js', SB); const decisions = api('decisions.js', SB);
  process.env.SUPABASE_URL = SB.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = SB.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-spec1', stage: 'plan', artifact: PLAN, piece: { title: PLAN.title, product: PLAN.product, msg: PLAN.msg, angle: PLAN.angle, markets: PLAN.markets, platforms: PLAN.platforms, trendId: 't1', trendName: 'Trend', origin: 'studio' } } }), r);
    assert.equal(r.statusCode, 200);
    assert.equal((pg.tables.creative_specs || []).length, 1, 'the pieces handler syncs the spec');
    let spec = pg.tables.creative_specs[0].spec;
    assert.equal(spec.legacyId, 'gen-spec1'); assert.deepEqual(spec.trend, { id: 't1', name: 'Trend' }); assert.deepEqual(spec.products, ['Galaxy S26 Ultra']); assert.deepEqual(spec.languages, ['en', 'ar']);
    assert.equal(spec.stages.plan.current.version, 1); assert.equal(spec.stages.mood.state, 'locked'); assert.equal(spec.stages.mood.current, null);
    let s = await syncSpec('gen-spec1'); assert.equal(s.changed, false, 'nothing new → no new version');
    r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-spec1', stage: 'thumb', artifact: { imageUrl: 'https://cdn/t.png', prompt: 'hero', assetPath: 'pieces/gen-spec1/thumb/a.png' } } }), r);
    assert.equal(pg.tables.creative_specs.length, 2); spec = pg.tables.creative_specs[1].spec;
    assert.deepEqual(spec.stages.thumb.current.summary, { image: true, assetPath: 'pieces/gen-spec1/thumb/a.png', prompt: 'hero' }); assert.equal(spec.stages.thumb.state, 'generated');
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-spec1', stage: 'thumb', decision: 'rejected', name: 'N', role: 'reviewer', reason: 'logo cut', reasonCode: 'safe_zone' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(pg.tables.creative_specs.length, 3);
    spec = pg.tables.creative_specs[2].spec;
    assert.deepEqual(spec.stages.thumb.lastRejection, { reasonCode: 'safe_zone', reason: 'logo cut', by: 'N', at: spec.stages.thumb.lastRejection.at }); assert.equal(spec.stages.thumb.approved, null);
    r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-spec1', stage: 'thumb', artifact: { imageUrl: 'https://cdn/t2.png' } } }), r);
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-spec1', stage: 'thumb', decision: 'approved', name: 'N', role: 'reviewer' } }), r);
    assert.equal(r.statusCode, 200);
    const latest = await latestSpec('gen-spec1');
    assert.equal(latest.version, 5); assert.equal(latest.spec.stages.thumb.approved.version, 2); assert.equal(latest.spec.stages.thumb.approved.by, 'N'); assert.equal(latest.spec.stages.thumb.lastRejection, null, 'the approved version carries no rejection');
    assert.equal(await syncSpec('gen-nope'), null);
    // jsonb comes back with its own key order: still "unchanged"
    const { canonical } = require('../../api/_spec.js');
    const stored = pg.tables.creative_specs.at(-1);
    const reorder = (v) => (Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reorder(v[k])])) : v);
    const shuffled = reorder(stored.spec);
    assert.notEqual(JSON.stringify(shuffled), JSON.stringify(stored.spec), 'the shuffled copy stringifies differently');
    assert.equal(canonical(shuffled), canonical(stored.spec));
    stored.spec = shuffled;
    const again = await syncSpec('gen-spec1'); assert.equal(again.changed, false, 'key order alone never makes a new version');
  } finally { f.restore(); pieces.restore(); decisions.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});
