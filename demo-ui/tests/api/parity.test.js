// Phase 6.9 — Hermes parity: artifacts pushed through /api/ingest run the same automated checks as Studio ones.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const ENV = { MAISTRO_INGEST_KEY: 'k1', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const push = async (h, body) => { const r = res(); await h.handler(req({ method: 'POST', body, headers: { Authorization: 'Bearer k1' }, session: false }), r); return r; };

test('ingest parity: a pushed image is copied in and vision-checked like a Studio one; an image on a disallowed host is recorded as unchecked (failing); a legacy brief fails "structured brief missing"; a structured brief gets the code checks', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([
    [/d3u0tzju9qaucj\.cloudfront\.net\/hermes-thumb\.png$/, () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
    [/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })],
    [/\/rest\/v1\/campaign_events/, () => json([{ id: 1 }])],
    pg.route,
  ]);
  const h = api('ingest.js', ENV);
  try {
    let r = await push(h, { stage: 'plan', artifact: { title: 'Hermes piece', product: 'Galaxy Z Flip8', msg: 'm', angle: 'a', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, trend: { id: 't1', name: 'Trend' } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); const projectId = r.body.projectId;
    r = await push(h, { projectId, stage: 'thumb', artifact: { imageUrl: 'https://d3u0tzju9qaucj.cloudfront.net/hermes-thumb.png', title: 'T' } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.stored, true);
    assert.equal(r.body.checks[0].kind, 'vision'); assert.equal(r.body.checks[0].queued, true); assert.match(r.body.checks[0].assetPath, new RegExp(`^pieces/${projectId}/thumb/`));
    const vj = pg.tables.jobs.find((j) => j.kind === 'vision_check'); assert.equal(vj.payload.source, 'ingest'); assert.equal(vj.payload.expectProduct, true); assert.equal(vj.payload.images[0].assetPath, r.body.checks[0].assetPath);
    r = await push(h, { projectId, stage: 'mood', artifact: { imageUrl: 'https://evil.example.com/x.png' } });
    assert.equal(r.statusCode, 200); assert.equal(r.body.checks[0].queued, false); assert.match(r.body.checks[0].reason, /could not be checked/);
    const failed = pg.tables.stage_checks.find((c) => c.kind === 'vision' && c.passed === false); assert.ok(failed, 'an unchecked push is a failing check, never silence');
    r = await push(h, { projectId, stage: 'brief', artifact: { objective: 'o', msg: 'k', markets: ['UAE'], platforms: ['tiktok'], mandatories: ['a', 'b', 'c'], deadline: '30 Oct 2026' } });
    assert.equal(r.statusCode, 200); assert.match(r.body.checks[0].reason, /structured brief missing/);
  } finally { f.restore(); h.restore(); }
});
