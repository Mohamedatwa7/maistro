// Phase 6.1 (b): every model or render call leaves a generation record; prompts are registered;
// rejection reasons carry a structured code.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, anthropicReply, loadPage } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const SB = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'k' };

test('hermes and director write a generation record (prompt name/version, resolved prompt, params, usage, latency) and register their prompt once', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([['api.anthropic.com', (u, init) => { const b = JSON.parse(init.body); return /AI Creative Director/.test(b.system) ? anthropicReply({ prompt: 'p', note: 'n' }) : anthropicReply({ title: 'T', product: 'Galaxy Z Fold8', msg: 'm', angle: 'a', markets: ['UAE'], platforms: ['tiktok'], themeDark: '#000000', themeAccent: '#111111' }); }], pg.route]);
  const h = api('hermes.js', SB); const d = api('director.js', SB);
  try {
    let r = res(); await h.handler(req({ method: 'POST', body: { stage: 'plan', trend: { name: 'T' }, project: { id: 'gen-rec1' } } }), r); assert.equal(r.statusCode, 200);
    r = res(); await d.handler(req({ method: 'POST', body: { stage: 'mood', userInput: 'desert', campaign: { id: 'gen-rec1', title: 'C' } } }), r); assert.equal(r.statusCode, 200);
    const recs = pg.tables.generation_records;
    assert.equal(recs.length, 2);
    const hr = recs.find((x) => x.prompt_name === 'hermes.plan'), dr = recs.find((x) => x.prompt_name === 'director.mood');
    assert.equal(hr.kind, 'claude'); assert.equal(hr.status, 'succeeded'); assert.equal(hr.prompt_version, 'hermes-v1-2026-10-21'); assert.equal(hr.legacy_piece_id, 'gen-rec1'); assert.match(hr.resolved_prompt, /TREND \(from TrendRadar\)/); assert.ok(hr.latency_ms >= 0); assert.deepEqual(hr.usage, { input_tokens: 10, output_tokens: 10 });
    assert.equal(dr.params.referenceImageAttached, false); assert.match(dr.resolved_prompt, /ARTIFACT TO CREATE: /);
    const prompts = pg.tables.prompt_registry;
    assert.deepEqual(prompts.map((p) => [p.name, p.version]).sort(), [['director.mood', 'director-v1-2026-10-21'], ['hermes.plan', 'hermes-v1-2026-10-21']]);
    assert.match(prompts.find((p) => p.name === 'hermes.plan').template, /\{\{PRODUCTS_PROMPT\}\}/, 'the template keeps variables, the record keeps the resolved text');
    // a failure is recorded too
    f.restore();
    const f2 = mockFetch([['api.anthropic.com', () => new Response('{"error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 })], pg.route]);
    try {
      r = res(); await d.handler(req({ method: 'POST', body: { stage: 'mood', userInput: 'x', campaign: { title: 'C' } } }), r);
      assert.notEqual(r.statusCode, 200);
      const last = pg.tables.generation_records.at(-1); assert.equal(last.status, 'failed'); assert.match(last.error, /Overloaded|529/);
    } finally { f2.restore(); }
  } finally { h.restore(); d.restore(); }
});

test('jobs write a generation record on completion and on failure (render and F1X8), with assets and the job id', async () => {
  const pg = fakePostgrest();
  let hfStatus = 'in_progress';
  const PNG = new Uint8Array([137, 80, 78, 71, 1]);
  const f = mockFetch([
    ['/v1/text2image/soul', () => json({ id: 'jobset000001' })],
    ['/v1/job-sets/jobset000001', () => json(hfStatus === 'completed' ? { jobs: [{ status: 'completed', results: { raw: { url: 'https://d3u0tzju9qaucj.cloudfront.net/out.png' } } }] } : { jobs: [{ status: hfStatus }] })],
    ['https://d3u0tzju9qaucj.cloudfront.net/out.png', () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
    [/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })],
    pg.route,
  ]);
  const pieces = api('pieces.js', SB); const jobs = api('jobs.js', { ...SB, HF_CREDENTIALS: 'id:secret' });
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-r2', stage: 'plan', artifact: { title: 'T', product: 'P', msg: 'm', markets: ['KSA'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] } } }), r);
    r = res(); await jobs.handler(req({ method: 'POST', body: { pieceId: 'gen-r2', stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: 'hero', ref: 'https://ref/x.jpg', aspect_ratio: '16:9', meta: {} } } }), r);
    const id = r.body.job.id;
    assert.equal((pg.tables.generation_records || []).length, 0, 'nothing recorded while running');
    pg.tables.jobs[0].next_poll_at = new Date(Date.now() - 1000).toISOString(); hfStatus = 'completed';
    r = res(); await jobs.handler(req({ method: 'GET', query: { id } }), r); assert.equal(r.body.job.state, 'succeeded');
    const rec = pg.tables.generation_records[0];
    assert.equal(rec.kind, 'higgsfield_image'); assert.equal(rec.status, 'succeeded'); assert.equal(rec.job_id, id); assert.equal(rec.resolved_prompt, 'hero'); assert.equal(rec.params.ref, true); assert.deepEqual(rec.input_assets, ['https://ref/x.jpg']);
    assert.equal(rec.output_assets[0].url, 'https://d3u0tzju9qaucj.cloudfront.net/out.png'); assert.ok(rec.output_assets[0].assetPath); assert.equal(rec.legacy_piece_id, 'gen-r2');
    // a moderated render is a refusal
    r = res(); await jobs.handler(req({ method: 'POST', body: { pieceId: 'gen-r2', stage: 'board', kind: 'higgsfield_image', payload: { prompt: 'p', ref: 'https://ref/x.jpg', meta: {} } } }), r);
    const j2 = pg.tables.jobs.find((x) => x.id === r.body.job.id); j2.next_poll_at = new Date(Date.now() - 1000).toISOString(); hfStatus = 'nsfw';
    r = res(); await jobs.handler(req({ method: 'GET', query: { id: j2.id } }), r); assert.equal(r.body.job.state, 'failed');
    assert.equal(pg.tables.generation_records.at(-1).status, 'refused');
  } finally { f.restore(); pieces.restore(); jobs.restore(); }
});

test('a rejection carries its taxonomy code into approvals.reason_code and back out in the pieces list; the page offers stage-specific codes from the knowledge base', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const pieces = api('pieces.js', SB); const decisions = api('decisions.js', SB);
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-r3', stage: 'plan', artifact: { title: 'T', product: 'P', msg: 'm', markets: ['KSA'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] } } }), r);
    r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-r3', stage: 'thumb', artifact: { imageUrl: 'https://cdn/t.png' } } }), r);
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-r3', stage: 'thumb', decision: 'rejected', name: 'N', role: 'reviewer', reason: 'logo cut', reasonCode: 'safe_zone' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(pg.tables.approvals[0].reason_code, 'safe_zone');
    r = res(); await pieces.handler(req({ method: 'GET' }), r);
    assert.equal(r.body.pieces[0].stages.thumb.decision.reasonCode, 'safe_zone');
  } finally { f.restore(); pieces.restore(); decisions.restore(); }
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('/api/kb') ? json({ documents: [{ content: { common: ['other'], byStage: { thumb: ['wrong_product', 'safe_zone'] }, labels: { safe_zone: 'Safe zone violated' } } }] }) : new Promise(() => {})) });
  try {
    assert.deepEqual(X.rejectOptions('thumb').map((o) => o.code), ['wrong_product', 'wrong_color', 'off_brand_tone', 'cultural_issue', 'claim_not_approved', 'text_error', 'artifact', 'off_trend', 'weak_hook', 'too_long', 'other'], 'fallback before the knowledge base loads');
    await X.loadKb();
    assert.deepEqual(X.rejectOptions('thumb'), [{ code: 'wrong_product', label: 'Wrong product' }, { code: 'safe_zone', label: 'Safe zone violated' }]);
    assert.deepEqual(X.rejectOptions('final').map((o) => o.code), ['other'], 'stages without a list fall back to the common codes');
  } finally { X.restore(); }
});
