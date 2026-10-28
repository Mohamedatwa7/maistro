// Phase 6.9 — Hermes parity: artifacts pushed through /api/ingest run the same automated checks as Studio ones.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, HERMES_ENV, hermesFake } = require('../helpers');
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

test('policy refusal: a render the bot declines ({"refused": reason}) fails uncharged with the reason, an explanation and a compliant rewrite on the job (never resubmitted)', async () => {
  const pg = fakePostgrest();
  const H = hermesFake({ status: 'completed', output: () => '```json\n{"refused": "bare skin breaks the brand content policy"}\n```' });
  const f = mockFetch([
    ...H.routes,
    ['api.anthropic.com', () => json({ content: [{ type: 'text', text: JSON.stringify({ reason: '"bare shoulders" reads as body focus.', rewrite: 'A woman in a modest linen abaya holds the foldable on a sunlit terrace.' }) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })],
    pg.route,
  ]);
  const env = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'k', ...HERMES_ENV };
  const jobs = api('jobs.js', env); const pieces = api('pieces.js', env);
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-nsfw', stage: 'plan', artifact: { title: 'N', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] } } }), r);
    r = res(); await jobs.handler(req({ method: 'POST', body: { pieceId: 'gen-nsfw', stage: 'thumb', kind: 'hermes_image', payload: { prompt: 'a woman with bare shoulders holding the phone', aspect_ratio: '9:16' } } }), r);
    const j = pg.tables.jobs[0]; j.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await jobs.handler(req({ method: 'GET', query: { id: j.id } }), r);
    assert.equal(r.body.job.state, 'failed'); assert.match(r.body.job.error, /^moderated by the bot \(bare skin breaks the brand content policy\) — nothing was generated$/);
    const row = pg.tables.jobs[0]; assert.match(row.result.refusal.reason, /body focus/); assert.match(row.result.refusal.rewrite, /modest linen abaya/); assert.match(row.result.refusal.refusedPrompt, /bare shoulders/);
    assert.equal(H.state.runs.length, 1, 'never resubmitted automatically'); assert.match(H.state.runs[0].body.instructions, /\{"refused": "<one-line reason>"\}/, 'the bot is told how to decline');
    const rec = pg.tables.generation_records.find((g) => g.job_id === j.id && g.status === 'refused'); assert.ok(rec); assert.equal(Number(rec.cost_usd), 0, 'moderated renders are not charged');
  } finally { f.restore(); jobs.restore(); pieces.restore(); }
});
