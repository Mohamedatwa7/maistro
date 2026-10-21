// M3 (ADR-004): the job service end to end against the in-memory PostgREST,
// with Higgsfield (v1 reference path, fetch-mockable), F1X8 and Storage mocked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', HF_CREDENTIALS: 'id:secret', MAISTRO_F1X8_BASE_URL: 'https://f1x8.test', CRON_SECRET: 'cron' };
const PLAN = { title: 'T', product: 'P', msg: 'm', markets: ['KSA'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] };
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

function world() {
  const pg = fakePostgrest();
  const hf = { status: 'queued', submits: 0 };
  const stored = [];
  const f = mockFetch([
    ['/v1/text2image/soul', (u, init) => { hf.submits++; hf.lastHeaders = init.headers; return json({ id: 'jobset000001' }); }],
    [/\/(bytedance\/seedance-2\.5\/text-to-video|higgsfield-ai\/soul\/v2\/standard)$/, (u, init) => { hf.submits++; hf.lastHeaders = init.headers; hf.lastBody = JSON.parse(init.body); if (hf.reject) return new Response(JSON.stringify(hf.reject.body), { status: hf.reject.status, headers: { 'x-correlation-id': 'corr-1' } }); return new Response(JSON.stringify({ status: 'queued', request_id: 'req00000001', status_url: 'x', cancel_url: 'y' }), { status: 200, headers: { 'x-correlation-id': 'corr-1' } }); }],
    ['/requests/req00000001/status', () => json({ status: hf.status === 'completed' ? 'completed' : 'in_progress', ...(hf.status === 'completed' ? { video: { url: 'https://d3u0tzju9qaucj.cloudfront.net/out.mp4' } } : {}) })],
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
  return { pg, hf, stored, f, pieces, jobs, post, get, restore: () => { f.restore(); pieces.restore(); jobs.restore(); } };
}
const seedPlan = async (W, id = 'gen-j1') => { const r = res(); await W.pieces.handler(req({ method: 'POST', body: { pieceId: id, stage: 'plan', artifact: PLAN, piece: { title: 'T', product: 'P' } } }), r); assert.equal(r.statusCode, 200); };

test('a render job: created → stage generating → submitted inline → polled by the tick → asset copied in → version recorded with job_id → stage generated', async () => {
  const W = world();
  try {
    await seedPlan(W);
    let r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: 'hero shot', aspect_ratio: '16:9', ref: 'https://ref/photo.jpg', meta: { prompt: 'hero shot', note: 'n', ar: '16:9', res: '1080p', title: 'T', sub: 'm' } } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const job = r.body.job;
    assert.equal(job.state, 'running', 'submitted inline'); assert.equal(job.providerRef, 'jobset000001'); assert.equal(W.hf.submits, 1);
    assert.equal(W.pg.tables.stages.find((s) => s.kind === 'thumb').state, 'generating');
    // not due yet: a read does not call the provider again; the tick finds nothing due
    r = await W.get({ id: job.id }); assert.equal(r.body.job.state, 'running');
    r = await W.get({}, { headers: { authorization: 'Bearer cron' }, session: false }); assert.deepEqual([r.body.ok, r.body.due], [true, 0]);
    // make it due; provider still processing → stays running, next poll pushed out
    W.pg.tables.jobs[0].next_poll_at = new Date(Date.now() - 1000).toISOString(); W.hf.status = 'in_progress';
    r = await W.get({}, { headers: { authorization: 'Bearer cron' }, session: false }); assert.equal(r.body.due, 1); assert.deepEqual(r.body.states, { running: 1 });
    assert.ok(new Date(W.pg.tables.jobs[0].next_poll_at) > new Date(), 'backoff set');
    // completed → copy-in, version, stage generated, job succeeded
    W.pg.tables.jobs[0].next_poll_at = new Date(Date.now() - 1000).toISOString(); W.hf.status = 'completed';
    r = await W.get({ id: job.id });
    const j = r.body.job;
    assert.equal(j.state, 'succeeded', JSON.stringify(j));
    assert.equal(j.result.artifact.imageUrl, 'https://d3u0tzju9qaucj.cloudfront.net/out.png'); assert.equal(j.result.artifact.title, 'T');
    assert.match(j.result.artifact.assetPath, /^pieces\/gen-j1\/thumb\/[a-z0-9]+-[0-9a-f]{12}\.png$/); assert.equal(j.result.artifact.sha256.length, 64); assert.equal(j.result.copiedIn, true);
    assert.equal(W.stored.length, 1); assert.equal(W.stored[0].type, 'image/png'); assert.equal(W.stored[0].bytes, PNG.length);
    const v = W.pg.tables.artifact_versions.find((x) => x.produced_by === 'higgsfield_soul');
    assert.ok(v); assert.equal(v.job_id, job.id); assert.equal(v.kind, 'image'); assert.equal(j.result.version, 1);
    const stage = W.pg.tables.stages.find((s) => s.kind === 'thumb');
    assert.equal(stage.state, 'generated'); assert.equal(stage.current_version_id, v.id);
    assert.ok(W.pg.tables.jobs[0].finished_at); assert.equal(W.pg.tables.jobs[0].next_poll_at, null);
    // a succeeded job is inert for the tick and for reads
    r = await W.get({ id: job.id }); assert.equal(r.body.job.state, 'succeeded'); assert.equal(W.hf.submits, 1);
    // reconcile-on-open lists it
    r = await W.get({ piece: 'gen-j1' }); assert.equal(r.body.count, 1); assert.equal(r.body.jobs[0].state, 'succeeded');
  } finally { W.restore(); }
});

test('order and immutability are enforced at job creation: draft needs brief and board; an approved stage refuses; strict mode needs approvals', async () => {
  const W = world();
  try {
    await seedPlan(W);
    let r = await W.post({ pieceId: 'gen-j1', stage: 'draft', kind: 'higgsfield_video', payload: { prompt: 'p', meta: {} } });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'prerequisites'); assert.match(r.body.error, /needs brief, board first/);
    for (const [stage, artifact] of [['brief', { objective: 'o', msg: 'm', markets: ['KSA'], platforms: ['tiktok'], deadline: 'd', mandatories: [] }], ['board', { imageUrl: 'https://cdn/b.png' }]]) {
      const x = res(); await W.pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-j1', stage, artifact } }), x); assert.equal(x.statusCode, 200);
    }
    r = await W.post({ pieceId: 'gen-j1', stage: 'draft', kind: 'higgsfield_video', payload: { prompt: 'p', meta: {}, strict: true } });
    assert.equal(r.statusCode, 409, 'strict: brief and board are generated, not approved'); assert.equal(r.body.code, 'prerequisites');
    // soft (legacy): prerequisites exist → allowed; the v2 REST submit carries the documented body and the Idempotency-Key = job id
    r = await W.post({ pieceId: 'gen-j1', stage: 'draft', kind: 'higgsfield_video', payload: { prompt: 'p', duration: 8, aspect_ratio: '9:16', resolution: '1080p', meta: { dur: 8 } } });
    assert.equal(r.statusCode, 200); assert.equal(r.body.job.state, 'running'); assert.equal(r.body.job.providerRef, 'req00000001');
    assert.deepEqual(W.hf.lastBody, { prompt: 'p', aspect_ratio: '9:16', resolution: '1080p', duration: 8, generate_audio: true });
    assert.equal(W.hf.lastHeaders['Idempotency-Key'], r.body.job.id); assert.match(W.hf.lastHeaders.Authorization, /^Key id:secret$/);
    assert.equal(W.pg.tables.jobs.find((j) => j.id === r.body.job.id).payload.correlationId, 'corr-1');
    assert.equal(W.pg.tables.stages.find((s) => s.kind === 'draft').state, 'generating');
    // an approved stage refuses a render
    W.pg.tables.stages.find((s) => s.kind === 'board').state = 'approved';
    r = await W.post({ pieceId: 'gen-j1', stage: 'board', kind: 'higgsfield_image', payload: { prompt: 'p', ref: 'https://ref/x.jpg', meta: {} } });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'approved_immutable');
    r = await W.post({ pieceId: 'gen-j1', stage: 'plan', kind: 'higgsfield_image', payload: { prompt: 'p' } }); assert.equal(r.statusCode, 400);
    r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'nope', payload: {} }); assert.equal(r.statusCode, 400);
    r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: 'p', ref: 'https://ref/x.jpg', meta: {} } }, { session: false }); assert.equal(r.statusCode, 401);
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

test('failures: a moderated render fails the job and returns the stage to ready; a submit error retries with backoff then fails after three attempts; a stale running job times out', async () => {
  const W = world();
  try {
    await seedPlan(W);
    let r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: 'p', ref: 'https://ref/x.jpg', meta: {} } });
    const id = r.body.job.id;
    W.pg.tables.jobs[0].next_poll_at = new Date(Date.now() - 1000).toISOString(); W.hf.status = 'nsfw';
    r = await W.get({ id });
    assert.equal(r.body.job.state, 'failed'); assert.match(r.body.job.error, /moderated/);
    assert.equal(W.pg.tables.stages.find((s) => s.kind === 'thumb').state, 'ready');
    // submit path failing with a 5xx → queued with backoff, attempts counted, failed after the third
    W.f.restore();
    const f2 = mockFetch([['/v1/text2image/soul', () => new Response('{"error":"upstream"}', { status: 503 })], W.pg.route]);
    try {
      r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: 'p', ref: 'https://ref/x.jpg', meta: {} } });
      const j2 = W.pg.tables.jobs.find((x) => x.id === r.body.job.id);
      assert.equal(r.body.job.state, 'queued'); assert.equal(j2.attempts, 1); assert.match(j2.error, /503|upstream/);
      for (let i = 0; i < 3; i++) { j2.next_poll_at = new Date(Date.now() - 1000).toISOString(); r = await W.get({ id: j2.id }); }
      assert.equal(r.body.job.state, 'failed'); assert.ok(j2.attempts >= 3);
      assert.equal(W.pg.tables.stages.find((s) => s.kind === 'thumb').state, 'ready');
      // timeout: a running job older than its limit
      W.pg.tables.jobs.push({ id: '00000000-0000-4000-8000-000000000001', piece_id: W.pg.tables.content_pieces[0].id, stage_id: W.pg.tables.stages.find((s) => s.kind === 'thumb').id, kind: 'higgsfield_image', state: 'running', attempts: 1, provider_ref: 'jobset000001', payload: { pieceId: 'gen-j1', stage: 'thumb', v: 1 }, created_at: new Date(Date.now() - 3600 * 1000).toISOString(), started_at: new Date(Date.now() - 3600 * 1000).toISOString(), next_poll_at: new Date(Date.now() - 1000).toISOString() });
      r = await W.get({}, { headers: { authorization: 'Bearer cron' }, session: false });
      assert.equal(r.body.states.timed_out, 1);
    } finally { f2.restore(); }
  } finally { W.restore(); }
});

test('documented error classes: a concurrency 400 and a 503 retry with backoff under the same Idempotency-Key; 403 credits, 422 validation and a plain 400 fail at once with the reason', async () => {
  const W = world();
  try {
    await seedPlan(W);
    W.hf.reject = { status: 400, body: { detail: 'Maximum number of concurrent requests (4) has been reached.' } };
    let r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: 'p', meta: {} } });
    assert.equal(r.statusCode, 200); assert.equal(r.body.job.state, 'queued', 'retry later, not failed'); assert.match(r.body.job.error, /concurrency limit/);
    const row = W.pg.tables.jobs.find((j) => j.id === r.body.job.id);
    assert.ok(new Date(row.next_poll_at) > new Date(), 'backoff set'); assert.equal(W.pg.tables.stages.find((s) => s.kind === 'thumb').state, 'generating', 'the stage waits with the job');
    W.hf.reject = { status: 503, body: { detail: 'model disabled' } };
    row.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = await W.get({ id: row.id }); assert.equal(r.body.job.state, 'queued'); assert.equal(row.attempts, 2);
    W.hf.reject = null;
    row.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = await W.get({ id: row.id }); assert.equal(r.body.job.state, 'running');
    assert.equal(W.hf.lastHeaders['Idempotency-Key'], row.id, 'every attempt replays the same key');
    for (const [status, body, pattern] of [[403, { detail: 'Not enough credits' }, /insufficient credits/], [422, { detail: [{ msg: 'prompt too long' }] }, /validation failed/], [400, { detail: [{ loc: ['aspect_ratio'], msg: 'invalid' }] }, /Higgsfield 400/]]) {
      W.hf.reject = { status, body };
      r = await W.post({ pieceId: 'gen-j1', stage: 'board', kind: 'higgsfield_image', payload: { prompt: 'p', meta: {} } });
      assert.equal(r.body.job.state, 'failed', String(status)); assert.match(r.body.job.error, pattern);
      assert.equal(W.pg.tables.stages.find((s) => s.kind === 'board').state, 'ready');
      W.hf.reject = null;
    }
    const { classify } = require('../../api/_adapters/higgsfield.js');
    assert.equal(classify(423, 'blocked').retryable, true); assert.equal(classify(401, '').retryable, false); assert.equal(classify(404, '').retryable, false);
    assert.equal(classify(400, 'Something transient').retryable, true, 'a plain-string 400 retries within the cap (no wording dependence)');
    assert.equal(classify(400, [{ msg: 'bad field' }]).retryable, false, 'a validation list is permanent');
  } finally { W.restore(); }
});

test('the claim is conditional: a row that is not due, or already taken, is not advanced twice', async () => {
  const W = world();
  try {
    await seedPlan(W);
    const r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: 'p', ref: 'https://ref/x.jpg', meta: {} } });
    const jobs = require('../../api/_jobs.js');
    const row = W.pg.tables.jobs[0];
    row.next_poll_at = new Date(Date.now() - 1000).toISOString(); W.hf.status = 'in_progress';
    const before = W.pg.calls.length;
    const [a, b] = await Promise.all([jobs.advance({ ...row }), jobs.advance({ ...row })]);
    const statusCalls = W.pg.calls.slice(before).filter((c) => c.method === 'PATCH' && c.table === 'jobs' && c.url.includes('next_poll_at=lte.')).length;
    assert.equal(statusCalls, 2, 'both tried to claim');
    assert.deepEqual([a, b].sort(), ['running', 'running']);
    assert.equal(r.body.job.id, row.id);
  } finally { W.restore(); }
});

test('peer items: a stage stranded in generating by a dead job is treated as ready; a completed status with no media fails at once', async () => {
  const W = world();
  try {
    await seedPlan(W);
    // strand the stage: generating, but no queued/running job for it
    W.pg.tables.stages.find((s) => s.kind === 'thumb').state = 'generating';
    let r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: 'p', ref: 'https://ref/x.jpg', meta: {} } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.job.state, 'running');
    // with a live job for the stage the second request is refused (not_ready), not double-started
    r = await W.post({ pieceId: 'gen-j1', stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: 'p', ref: 'https://ref/x.jpg', meta: {} } });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'not_ready');
    // completed without output → failed, stage back to ready
    const row = W.pg.tables.jobs[0];
    row.next_poll_at = new Date(Date.now() - 1000).toISOString(); W.hf.status = 'completed';
    W.f.restore();
    const f2 = mockFetch([['/v1/job-sets/jobset000001', () => json({ jobs: [{ status: 'completed', results: {} }] })], W.pg.route]);
    try {
      r = await W.get({ id: row.id });
      assert.equal(r.body.job.state, 'failed'); assert.match(r.body.job.error, /without any output/);
      assert.equal(W.pg.tables.stages.find((s) => s.kind === 'thumb').state, 'ready');
    } finally { f2.restore(); }
  } finally { W.restore(); }
});
