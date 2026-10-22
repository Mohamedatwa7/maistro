// Phase 6.9 — human override: a person's own asset in place of a generated one, uploaded straight to the private bucket
// through a signed upload URL, validated by its bytes, recorded as human-made, and re-checked like a generated one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5]);
const MP4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1]);

test('override: sign → (browser upload) → validate bytes → a manual thumbnail version with a vision check; a shot clip replaced in place with history and a clip check; wrong types and foreign paths refused', async () => {
  const pg = fakePostgrest();
  const objects = {};
  const f = mockFetch([
    [/\/storage\/v1\/object\/upload\/sign\/assets\//, (u) => json({ url: `/object/upload/sign/assets/${String(u).split('/upload/sign/assets/')[1]}?token=up` })],
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t` })],
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'GET', (u) => { const p = decodeURIComponent(String(u).split('/object/sign/assets/')[1].split('?')[0]); return objects[p] ? new Response(objects[p], { status: 200 }) : new Response('nf', { status: 404 }); }],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const pieces = api('pieces.js', ENV);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-ov1', stage: 'plan', artifact: { title: 'O', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'O', product: 'Galaxy Z Flip8' } } }), r);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'override-sign', pieceId: 'gen-ov1', stage: 'thumb', contentType: 'image/gif' } }), r); assert.equal(r.statusCode, 415);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'override-sign', pieceId: 'gen-ov1', stage: 'thumb', contentType: 'image/png' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.match(r.body.path, /^pieces\/gen-ov1\/thumb\/override-[a-z0-9]+\.png$/); assert.match(r.body.uploadUrl, /\/storage\/v1\/object\/upload\/sign\/assets\/.*token=up/);
    const p1 = r.body.path;
    objects[p1] = Buffer.from('GIF89a not a png');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'override', pieceId: 'gen-ov1', stage: 'thumb', path: p1 } }), r); assert.equal(r.statusCode, 422, 'bytes, not the extension, decide');
    objects[p1] = PNG;
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'override', pieceId: 'gen-ov1', stage: 'thumb', path: 'pieces/gen-other/thumb/override-x.png' } }), r); assert.equal(r.statusCode, 422, 'only this piece\'s override uploads');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'override', pieceId: 'gen-ov1', stage: 'thumb', path: p1 } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.asset.override, true); assert.match(r.body.asset.sha256, /^[0-9a-f]{64}$/);
    const v = pg.tables.artifact_versions.find((x) => x.id === r.body.versionId); assert.equal(v.produced_by, 'manual'); assert.equal(v.payload.override, true); assert.equal(v.payload.assetPath, p1);
    const vj = pg.tables.jobs.find((j) => j.kind === 'vision_check'); assert.equal(vj.payload.source, 'override'); assert.equal(vj.payload.images[0].assetPath, p1);
    // a shot clip on a draft
    const store = require('../../api/_store.js');
    const dv = await store.recordVersion('gen-ov1', 'draft', { shots: [{ n: 1, durationS: 3, product: { visible: true }, keyframe: { assetPath: 'pieces/gen-ov1/board/k1.png' }, clip: { state: 'rendered', assetPath: 'pieces/gen-ov1/draft/c1.mp4', sha256: 'a'.repeat(64) }, review: { decision: 'approved' } }], rev: 0 }, { producedBy: 'higgsfield_seedance', kind: 'video' });
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'override-sign', pieceId: 'gen-ov1', stage: 'draft', shot: 1, contentType: 'video/mp4' } }), r);
    const p2 = r.body.path; assert.match(p2, /^pieces\/gen-ov1\/draft\/override-1-[a-z0-9]+\.mp4$/); objects[p2] = MP4;
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'override', pieceId: 'gen-ov1', stage: 'draft', shot: 1, path: p2 } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const d = pg.tables.artifact_versions.find((x) => x.id === dv.versionId);
    assert.equal(d.payload.shots[0].clip.assetPath, p2); assert.equal(d.payload.shots[0].clip.override, true); assert.equal(d.payload.shots[0].clipHistory[0].sha256, 'a'.repeat(64)); assert.equal(d.payload.shots[0].review, null, 'a replaced clip needs a fresh approval');
    const cc = pg.tables.jobs.find((j) => j.kind === 'clip_check'); assert.equal(cc.payload.clipAssetPath, p2); assert.equal(cc.payload.keyframeAssetPath, 'pieces/gen-ov1/board/k1.png');
    assert.ok(pg.tables.audit_log.some((a) => a.action === 'draft.override' && a.after.assetPath === p2));
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'override-sign', pieceId: 'gen-ov1', stage: 'brief', contentType: 'image/png' } }), r); assert.equal(r.statusCode, 400);
  } finally { f.restore(); studio.restore(); pieces.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});
