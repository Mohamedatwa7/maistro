// M3 (ADR-004): the job service end to end against the in-memory PostgREST,
// with the owner's Hermes bots (the renderer), F1X8 and Storage mocked. Rows made
// by Higgsfield before the switch still finish through the legacy path.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, HERMES_ENV, hermesFake } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', HF_CREDENTIALS: 'id:secret', MAISTRO_F1X8_BASE_URL: 'https://f1x8.test', CRON_SECRET: 'cron', ...HERMES_ENV };
const PLAN = { title: 'T', product: 'P', msg: 'm', markets: ['KSA'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] };
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const due = (row) => { row.next_poll_at = new Date(Date.now() - 1000).toISOString(); };

function world() {
  const pg = fakePostgrest();
  const hf = { status: 'queued' };
  const H = hermesFake();
  const stored = [];
  const f = mockFetch([
    ...H.routes,
    ['/v1/job-sets/jobset000001', () => json(hf.status === 'completed' ? { jobs: [{ status: 'completed', results: { raw: { url: 'https://d3u0tzju9qaucj.cloudfront.net/out.png' } } }] } : { jobs: [{ status: hf.status }] })],
    ['https://d3u0tzju9qaucj.cloudfront.net/out.png', () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
    [/\/storage\/v1\/object\/assets\//, (u, init) => { stored.push({ url: String(u), type: init.headers['Content-Type'], bytes: init.body.length }); return json({ Key: 'ok' }); }],
    ['/api/analyze/image/submit', () => json({ job_id: 'f1x8-job-1' })],
    ['/api/job/f1x8-job-1', () => json(hf.qc || { status: 'analyzing' })],
    pg.route,
  ]);
  const pieces = api('pieces.js', ENV);
  const jobs = api('jobs.js', ENV);
  const post = async (body, extra = {}) => { const r = res(); await jobs.handler(req({ method: 'POST', body, ...extra }), r); return r; };
  const get = async (query, extra = {}) => { const r = res(); await jobs.handler(req({ method: 'GET', query, ...extra }), r); return r; };
  return { pg, hf, H: H.state, stored, f, pieces, jobs, post, get, restore: () => { f.restore(); pieces.restore(); jobs.restore(); } };
}
const seedPlan = async (W, id = 'gen-j1') => { const r = res(); await W.pieces.handler(req({ method: 'POST', body: { pieceId: id, stage: 'plan', artifact: PLAN, piece: { title: 'T', product: 'P' } } }), r); assert.equal(r.statusCode, 200); };

test('a render job: created → stage generating → run submitted to the stage\'s Hermes bot inline → polled by the tick → asset copied in → version recorded (produced by hermes) with job_id → stage generated', async () => {
  const W = world();
  try {
    await seedPlan(W);
    let r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'hermes_image', payload: { prompt: 'hero shot', aspect_ratio: '16:9', resolution: '1080p', ref: 'https://ref.test/photo.jpg', meta: { prompt: 'hero shot', note: 'n', ar: '16:9', res: '1080p', title: 'T', sub: 'm' } } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const job = r.body.job;
    assert.equal(job.state, 'running', 'submitted inline'); assert.equal(job.providerRef, 'thumb:run_0001'); assert.equal(W.H.runs.length, 1);
    const run = W.H.runs[0];
    assert.equal(run.profile, 'thumbnail', 'the thumbnail bot\'s profile'); assert.equal(run.url, 'https://hermes.test/p/thumbnail/v1/runs');
    assert.equal(run.headers.Authorization, 'Bearer hk'); assert.equal(run.headers['Idempotency-Key'], job.id); assert.equal(run.body.session_id, 'maistro-gen-j1-thumb');
    assert.match(run.body.input, /hero shot/); assert.match(run.body.input, /aspect ratio 16:9, 1080p/); assert.match(run.body.input, /PRODUCT REFERENCE PHOTO[^\n]*https:\/\/ref\.test\/photo\.jpg/);
    assert.match(run.body.instructions, /"images": \["<https URL>"\]/, 'the output contract asks for one image');
    assert.equal(W.pg.tables.stages.find((s) => s.kind === 'thumb').state, 'generating');
    // not due yet: a read does not call the bot again; the tick finds nothing due
    r = await W.get({ id: job.id }); assert.equal(r.body.job.state, 'running');
    r = await W.get({}, { headers: { authorization: 'Bearer cron' }, session: false }); assert.deepEqual([r.body.ok, r.body.due], [true, 0]);
    // due; the bot is still working → stays running, next poll pushed out
    due(W.pg.tables.jobs[0]);
    r = await W.get({}, { headers: { authorization: 'Bearer cron' }, session: false }); assert.equal(r.body.due, 1); assert.deepEqual(r.body.states, { running: 1 });
    assert.ok(new Date(W.pg.tables.jobs[0].next_poll_at) > new Date(), 'backoff set');
    // completed → copy-in (the gateway host is an allowed media host), version, stage generated, job succeeded
    due(W.pg.tables.jobs[0]); W.H.status = 'completed';
    r = await W.get({ id: job.id });
    const j = r.body.job;
    assert.equal(j.state, 'succeeded', JSON.stringify(j));
    assert.equal(j.result.artifact.imageUrl, 'https://hermes.test/files/run_0001-1.png'); assert.equal(j.result.artifact.title, 'T');
    assert.deepEqual(j.result.artifact.madeBy, { provider: 'hermes', bot: 'thumbnail', run: 'thumb:run_0001' });
    assert.match(j.result.artifact.assetPath, /^pieces\/gen-j1\/thumb\/[a-z0-9]+-[0-9a-f]{12}\.png$/); assert.equal(j.result.artifact.sha256.length, 64); assert.equal(j.result.copiedIn, true);
    assert.equal(W.stored.length, 1); assert.equal(W.stored[0].type, 'image/png');
    const v = W.pg.tables.artifact_versions.find((x) => x.produced_by === 'hermes');
    assert.ok(v); assert.equal(v.job_id, job.id); assert.equal(v.kind, 'image'); assert.equal(j.result.version, 1);
    const stage = W.pg.tables.stages.find((s) => s.kind === 'thumb');
    assert.equal(stage.state, 'generated'); assert.equal(stage.current_version_id, v.id);
    assert.ok(W.pg.tables.jobs[0].finished_at); assert.equal(W.pg.tables.jobs[0].next_poll_at, null);
    const rec = W.pg.tables.generation_records.find((g) => g.job_id === job.id);
    assert.equal(rec.kind, 'hermes_image'); assert.equal(rec.prompt_name, 'hermes.thumb'); assert.equal(rec.model, 'hermes/thumbnail'); assert.equal(rec.status, 'succeeded');
    // a succeeded job is inert for the tick and for reads
    r = await W.get({ id: job.id }); assert.equal(r.body.job.state, 'succeeded'); assert.equal(W.H.runs.length, 1);
    r = await W.get({ piece: 'gen-j1' }); assert.equal(r.body.count, 1); assert.equal(r.body.jobs[0].state, 'succeeded');
  } finally { W.restore(); }
});

test('order and immutability are enforced at job creation: draft needs brief and board; an approved stage refuses; strict mode needs approvals; Higgsfield kinds can no longer be created', async () => {
  const W = world();
  try {
    await seedPlan(W);
    let r = await W.post({ pieceId: 'gen-j1', stage: 'draft', kind: 'hermes_video', payload: { prompt: 'p', meta: {} } });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'prerequisites'); assert.match(r.body.error, /needs brief, board first/);
    for (const [stage, artifact] of [['brief', { objective: 'o', msg: 'm', markets: ['KSA'], platforms: ['tiktok'], deadline: 'd', mandatories: [] }], ['board', { imageUrl: 'https://cdn/b.png' }]]) {
      const x = res(); await W.pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-j1', stage, artifact } }), x); assert.equal(x.statusCode, 200);
    }
    r = await W.post({ pieceId: 'gen-j1', stage: 'draft', kind: 'hermes_video', payload: { prompt: 'p', meta: {}, strict: true } });
    assert.equal(r.statusCode, 409, 'strict: brief and board are generated, not approved'); assert.equal(r.body.code, 'prerequisites');
    // soft (legacy): prerequisites exist → allowed; the video bot gets the format and the Idempotency-Key = job id
    r = await W.post({ pieceId: 'gen-j1', stage: 'draft', kind: 'hermes_video', payload: { prompt: 'p', duration: 8, aspect_ratio: '9:16', resolution: '1080p', meta: { dur: 8 } } });
    assert.equal(r.statusCode, 200); assert.equal(r.body.job.state, 'running'); assert.equal(r.body.job.providerRef, 'video:run_0001');
    assert.equal(W.H.last.profile, 'video'); assert.match(W.H.last.body.input, /aspect ratio 9:16, 1080p, 8 seconds, native audio/); assert.match(W.H.last.body.instructions, /"video": "<https URL/);
    assert.equal(W.H.last.headers['Idempotency-Key'], r.body.job.id);
    assert.equal(W.pg.tables.jobs.find((j) => j.id === r.body.job.id).payload.bot, 'video');
    assert.equal(W.pg.tables.stages.find((s) => s.kind === 'draft').state, 'generating');
    // an approved stage refuses a render
    W.pg.tables.stages.find((s) => s.kind === 'board').state = 'approved';
    r = await W.post({ pieceId: 'gen-j1', stage: 'board', kind: 'hermes_image', payload: { prompt: 'p', meta: {} } });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'approved_immutable');
    r = await W.post({ pieceId: 'gen-j1', stage: 'plan', kind: 'hermes_image', payload: { prompt: 'p' } }); assert.equal(r.statusCode, 400);
    r = await W.post({ pieceId: 'gen-j1', stage: 'brief', kind: 'hermes_image', payload: { prompt: 'p' } }); assert.equal(r.statusCode, 400, 'the brief is a hermes_brief job');
    r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: 'p' } }); assert.equal(r.statusCode, 400, 'Higgsfield is replaced'); assert.match(r.body.error, /hermes_image/);
    r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'nope', payload: {} }); assert.equal(r.statusCode, 400);
    r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'hermes_image', payload: { prompt: 'p', meta: {} } }, { session: false }); assert.equal(r.statusCode, 401);
  } finally { W.restore(); }
});

test('an F1X8 job: submits the asset from an allowed host, polls, stores the analysis in qc_results against the analysed version, keeps the heatmap out of the row', async () => {
  const W = world();
  try {
    await seedPlan(W);
    const x = res(); await W.pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-j1', stage: 'thumb', artifact: { imageUrl: 'https://d3u0tzju9qaucj.cloudfront.net/out.png', prompt: 'p' } } }), x); assert.equal(x.statusCode, 200);
    let r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'f1x8_image', payload: { assetUrl: 'https://d3u0tzju9qaucj.cloudfront.net/out.png', title: 'T — Thumbnail', description: 'brief' } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.job.state, 'running'); assert.equal(r.body.job.providerRef, 'f1x8-job-1');
    assert.equal(W.pg.tables.stages.find((s) => s.kind === 'thumb').state, 'generated', 'a check never touches the stage state');
    W.pg.tables.jobs[0].next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = await W.get({ id: r.body.job.id }); assert.equal(r.body.job.state, 'running'); assert.deepEqual(r.body.job.result, { providerStatus: 'analyzing' });
    W.hf.qc = { status: 'done', result: { score: 6.4, verdict: { risks: [] }, heatmap: 'data:image/png;base64,' + Buffer.from(PNG).toString('base64'), heatmap_type: 'image/png' } };
    W.pg.tables.jobs[0].next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = await W.get({ id: r.body.job.id });
    const j = r.body.job;
    assert.equal(j.state, 'succeeded'); assert.equal(j.result.score, 6.4); assert.equal(j.result.analysis.heatmap, undefined); assert.match(j.result.heatmapPath, /heatmap-/);
    assert.equal(W.pg.tables.qc_results.length, 1);
    assert.equal(W.pg.tables.qc_results[0].artifact_version_id, W.pg.tables.stages.find((s) => s.kind === 'thumb').current_version_id);
    assert.equal(W.pg.tables.qc_results[0].score, 6.4); assert.equal(W.pg.tables.qc_results[0].job_id, j.id);
    // a disallowed asset host is a permanent failure (no retries)
    r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'f1x8_image', payload: { assetUrl: 'https://evil.test/x.png' } });
    assert.equal(r.statusCode, 200); assert.equal(r.body.job.state, 'failed'); assert.match(r.body.job.error, /not an allowed media host/);
  } finally { W.restore(); }
});

test('failures: a failed Hermes run fails the job with its reason and returns the stage to ready; a submit error retries with backoff then fails after three attempts; a stale running job times out', async () => {
  const W = world();
  try {
    await seedPlan(W);
    let r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'hermes_image', payload: { prompt: 'p', meta: {} } });
    const id = r.body.job.id;
    due(W.pg.tables.jobs[0]); W.H.status = 'failed';
    r = await W.get({ id });
    assert.equal(r.body.job.state, 'failed'); assert.match(r.body.job.error, /tool crashed/);
    assert.equal(W.pg.tables.stages.find((s) => s.kind === 'thumb').state, 'ready');
    // submit path failing with a 5xx → queued with backoff, attempts counted, failed after the third
    W.H.status = 'running'; W.H.reject = { status: 503, body: { error: { message: 'gateway restarting' } } };
    r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'hermes_image', payload: { prompt: 'p', meta: {} } });
    const j2 = W.pg.tables.jobs.find((x) => x.id === r.body.job.id);
    assert.equal(r.body.job.state, 'queued'); assert.equal(j2.attempts, 1); assert.match(j2.error, /503: gateway restarting/);
    for (let i = 0; i < 3; i++) { due(j2); r = await W.get({ id: j2.id }); }
    assert.equal(r.body.job.state, 'failed'); assert.ok(j2.attempts >= 3);
    assert.equal(W.pg.tables.stages.find((s) => s.kind === 'thumb').state, 'ready');
    // timeout: a running job older than its limit
    W.H.reject = null;
    W.pg.tables.jobs.push({ id: '00000000-0000-4000-8000-000000000001', piece_id: W.pg.tables.content_pieces[0].id, stage_id: W.pg.tables.stages.find((s) => s.kind === 'thumb').id, kind: 'hermes_image', state: 'running', attempts: 1, provider_ref: 'thumb:run_0001', payload: { pieceId: 'gen-j1', stage: 'thumb' }, created_at: new Date(Date.now() - 3600 * 1000).toISOString(), started_at: new Date(Date.now() - 3600 * 1000).toISOString(), next_poll_at: new Date(Date.now() - 1000).toISOString() });
    r = await W.get({}, { headers: { authorization: 'Bearer cron' }, session: false });
    assert.equal(r.body.states.timed_out, 1);
  } finally { W.restore(); }
});

test('Hermes error classes: 429 (run limit) and 5xx retry with backoff under the same Idempotency-Key; 401, 404 and a plain 400 fail at once with the reason; a run parked on a Hermes approval keeps polling and says why', async () => {
  const W = world();
  try {
    await seedPlan(W);
    W.H.reject = { status: 429, body: { error: { message: 'max_concurrent_runs reached' } } };
    let r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'hermes_image', payload: { prompt: 'p', meta: {} } });
    assert.equal(r.statusCode, 200); assert.equal(r.body.job.state, 'queued', 'retry later, not failed'); assert.match(r.body.job.error, /run limit/);
    const row = W.pg.tables.jobs.find((j) => j.id === r.body.job.id);
    assert.ok(new Date(row.next_poll_at) > new Date(), 'backoff set'); assert.equal(W.pg.tables.stages.find((s) => s.kind === 'thumb').state, 'generating', 'the stage waits with the job');
    W.H.reject = { status: 502, body: {} };
    due(row); r = await W.get({ id: row.id }); assert.equal(r.body.job.state, 'queued'); assert.equal(row.attempts, 2);
    W.H.reject = null;
    due(row); r = await W.get({ id: row.id }); assert.equal(r.body.job.state, 'running');
    assert.equal(W.H.last.headers['Idempotency-Key'], row.id, 'every attempt replays the same key');
    // parked on an approval inside Hermes: still running, with the reason on the job
    W.H.status = 'waiting_for_approval'; due(row);
    r = await W.get({ id: row.id }); assert.equal(r.body.job.state, 'running'); assert.match(r.body.job.error, /waiting for an approval inside Hermes/);
    for (const [status, body, pattern] of [[401, { error: 'bad key' }, /rejected the key \(401\)/], [404, { error: 'unknown profile' }, /HERMES_BOT_<ROLE>/], [400, { error: { message: 'input too long' } }, /Hermes 400: input too long/]]) {
      W.H.reject = { status, body };
      r = await W.post({ pieceId: 'gen-j1', stage: 'board', kind: 'hermes_image', payload: { prompt: 'p', meta: {} } });
      assert.equal(r.body.job.state, 'failed', String(status)); assert.match(r.body.job.error, pattern);
      assert.equal(W.pg.tables.stages.find((s) => s.kind === 'board').state, 'ready');
      W.H.reject = null;
    }
    const { classify } = require('../../api/_adapters/hermes.js');
    assert.equal(classify(429, '').retryable, true); assert.equal(classify(503, '').retryable, true); assert.equal(classify(403, '').retryable, false); assert.equal(classify(409, '').retryable, false);
  } finally { W.restore(); }
});

test('not configured: without HERMES_API_URL a render fails at once and says what to set (no retries)', async () => {
  const W = world();
  try {
    await seedPlan(W);
    const prev = process.env.HERMES_API_URL; delete process.env.HERMES_API_URL;
    try {
      const r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'hermes_image', payload: { prompt: 'p', meta: {} } });
      assert.equal(r.body.job.state, 'failed'); assert.match(r.body.job.error, /HERMES_API_URL is not configured/); assert.equal(W.H.runs.length, 0);
    } finally { process.env.HERMES_API_URL = prev; }
  } finally { W.restore(); }
});

test('the claim is conditional: a row that is not due, or already taken, is not advanced twice', async () => {
  const W = world();
  try {
    await seedPlan(W);
    const r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'hermes_image', payload: { prompt: 'p', meta: {} } });
    const jobs = require('../../api/_jobs.js');
    const row = W.pg.tables.jobs[0];
    due(row); W.H.status = 'running';
    const before = W.pg.calls.length;
    const [a, b] = await Promise.all([jobs.advance({ ...row }), jobs.advance({ ...row })]);
    const statusCalls = W.pg.calls.slice(before).filter((c) => c.method === 'PATCH' && c.table === 'jobs' && c.url.includes('next_poll_at=lte.')).length;
    assert.equal(statusCalls, 2, 'both tried to claim');
    assert.deepEqual([a, b].sort(), ['running', 'running']);
    assert.equal(r.body.job.id, row.id);
  } finally { W.restore(); }
});

test('peer items: a stage stranded in generating by a dead job is treated as ready; a completed run with no media fails at once', async () => {
  const W = world();
  try {
    await seedPlan(W);
    // strand the stage: generating, but no queued/running job for it
    W.pg.tables.stages.find((s) => s.kind === 'thumb').state = 'generating';
    let r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'hermes_image', payload: { prompt: 'p', meta: {} } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.job.state, 'running');
    // with a live job for the stage the second request is refused (not_ready), not double-started
    r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'hermes_image', payload: { prompt: 'p', meta: {} } });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'not_ready');
    // the bot says done but hands back no usable URL (prose, an http link) → failed, stage back to ready
    const row = W.pg.tables.jobs[0];
    due(row); W.H.status = 'completed'; W.H.output = () => 'All done! I saved it to http://insecure.test/x.png';
    r = await W.get({ id: row.id });
    assert.equal(r.body.job.state, 'failed'); assert.match(r.body.job.error, /without any output/);
    assert.equal(W.pg.tables.stages.find((s) => s.kind === 'thumb').state, 'ready');
  } finally { W.restore(); }
});

test('legacy: a Higgsfield row created before the switch still finishes through the old path (produced by higgsfield_soul)', async () => {
  const W = world();
  try {
    await seedPlan(W);
    const thumb = W.pg.tables.stages.find((s) => s.kind === 'thumb'); thumb.state = 'generating';
    (W.pg.tables.jobs = W.pg.tables.jobs || []).push({ id: '00000000-0000-4000-8000-000000000002', piece_id: W.pg.tables.content_pieces[0].id, stage_id: thumb.id, kind: 'higgsfield_image', state: 'running', attempts: 1, provider_ref: 'jobset000001', payload: { pieceId: 'gen-j1', stage: 'thumb', v: 1, meta: { prompt: 'p' } }, created_at: new Date().toISOString(), started_at: new Date().toISOString(), next_poll_at: new Date(Date.now() - 1000).toISOString() });
    W.hf.status = 'completed';
    const r = await W.get({ id: '00000000-0000-4000-8000-000000000002' });
    assert.equal(r.body.job.state, 'succeeded', JSON.stringify(r.body.job)); assert.equal(r.body.job.result.artifact.imageUrl, 'https://d3u0tzju9qaucj.cloudfront.net/out.png');
    assert.ok(W.pg.tables.artifact_versions.some((v) => v.produced_by === 'higgsfield_soul')); assert.equal(W.H.runs.length, 0);
  } finally { W.restore(); }
});

test('the adapter reads the bot\'s reply: the last ```json block, else the last balanced object; only https URLs count', () => {
  const { parseOutput, renderRun, roleFor } = require('../../api/_adapters/hermes.js');
  assert.deepEqual(parseOutput('draft ```json\n{"images":["https://a/1.png"]}\n``` final ```json\n{"images":["https://a/2.png"]}\n```'), { images: ['https://a/2.png'] });
  assert.deepEqual(parseOutput('Sure — here: {"video": "https://a/v.mp4", "note": "ok {fine}"} thanks'), { video: 'https://a/v.mp4', note: 'ok {fine}' });
  assert.deepEqual(parseOutput({ images: ['https://x/y.png'] }), { images: ['https://x/y.png'] });
  assert.deepEqual(parseOutput('no json here'), { text: 'no json here' });
  assert.deepEqual([roleFor('hermes_image', 'mood'), roleFor('hermes_image', 'board'), roleFor('hermes_video', 'final'), roleFor('hermes_brief', 'brief')], ['mood', 'board', 'video', 'brief']);
  const run = renderRun({ prompt: 'p', batch: 4, aspect_ratio: '4:3', seed: 42, anchorUrls: ['https://a/1.png', 'http://no/2.png'], meta: { changes: 'warmer light' } }, 'mood');
  assert.match(run.instructions, /exactly 4 https URLs/); assert.match(run.input, /4 image variations/); assert.match(run.input, /SEED: 42/); assert.match(run.input, /REVIEWER CHANGES \(apply only these\): warmer light/);
  assert.match(run.input, /https:\/\/a\/1\.png/); assert.doesNotMatch(run.input, /http:\/\/no/, 'only https anchors are passed on');
});

test('an F1X8 job may name the stored copy (assetPath): it is signed at submit time and the signed URL is what gets analysed', async () => {
  const W = world();
  try {
    await seedPlan(W);
    W.f.restore();
    const seen = [];
    const f2 = mockFetch([
      [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', () => { seen.push('sign'); return json({ signedURL: '/object/sign/assets/pieces/gen-j1/thumb/a-b.png?token=t' }); }],
      ['https://sb.test/storage/v1/object/sign/assets/pieces/gen-j1/thumb/a-b.png?token=t', () => { seen.push('fetch-signed'); return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }); }],
      ['/api/analyze/image/submit', () => { seen.push('submit'); return json({ job_id: 'f1x8-job-2' }); }],
      W.pg.route,
    ]);
    try {
      const r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'f1x8_image', payload: { assetPath: 'pieces/gen-j1/thumb/a-b.png', title: 'T', description: 'd' } });
      assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.job.state, 'running');
      assert.deepEqual(seen, ['sign', 'fetch-signed', 'submit']);
    } finally { f2.restore(); }
  } finally { W.restore(); }
});
