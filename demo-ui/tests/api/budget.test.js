// Phase 6.9 — cost control: every render is priced with Higgsfield /estimate on the exact body it submits; the piece's
// budget warns at its threshold and refuses past its cap; failed renders cost nothing; the cost lands on the record.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', HF_CREDENTIALS: 'id:secret', MAISTRO_PIECE_BUDGET_USD: '2' };

test('budget: estimate = the submitted body; warning at 80 %; refusal past the cap before anything is submitted; failed renders are not counted; the budget is editable and audit-logged', async () => {
  const pg = fakePostgrest();
  const est = []; const submits = [];
  const f = mockFetch([
    [/api\.higgsfield\.ai\/estimate\//, (u, init) => { est.push({ url: String(u), body: JSON.parse(init.body) }); return json({ usd: 0.8, credits: 80 }); }],
    [/\/higgsfield-ai\/soul\/v2\/standard$/, (u, init) => { submits.push(JSON.parse(init.body)); return json({ status: 'queued', request_id: `bud0000${submits.length}x`, status_url: 'x', cancel_url: 'y' }); }],
    pg.route,
  ]);
  const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV); const studio = api('studio.js', ENV);
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-bud1', stage: 'plan', artifact: { title: 'B', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] } } }), r);
    const submit = async (n) => { const rr = res(); await jobs.handler(req({ method: 'POST', body: { pieceId: 'gen-bud1', stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: `p${n}`, aspect_ratio: '9:16', resolution: '1080p', seed: 1234 + n } } }), rr); return rr; };
    r = await submit(1);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.job.state, 'running'); assert.equal(r.body.job.estimateUsd, 0.8); assert.equal(r.body.job.budgetWarning, null);
    assert.equal(est.length, 1); assert.match(est[0].url, /estimate\/higgsfield-ai\/soul\/v2\/standard$/); assert.deepEqual(est[0].body, submits[0], 'priced exactly what was submitted');
    // the first render completes → spent 0.8; the second takes it to 1.6 = 80 % → warning
    const j1 = pg.tables.jobs[0]; j1.state = 'succeeded';
    pg.tables.stages.find((s) => s.kind === 'thumb').state = 'generated';
    r = await submit(2);
    assert.equal(r.body.job.state, 'running'); assert.match(r.body.job.budgetWarning, /\$1\.60 of \$2\.00 \(80 %\)/);
    // a third would reach 2.40 > 2.00 → refused before any submit
    pg.tables.jobs[1].state = 'failed'; pg.tables.stages.find((s) => s.kind === 'thumb').state = 'generated'; // failed: not charged, not counted
    r = await submit(3);
    assert.equal(r.body.job.state, 'running', 'the failed render freed its budget');
    pg.tables.stages.find((s) => s.kind === 'thumb').state = 'generated';
    r = await submit(4);
    assert.equal(r.body.job.state, 'failed'); assert.match(r.body.job.error, /budget cap: .*\$2\.40 of its \$2\.00 cap/); assert.equal(submits.length, 3, 'nothing submitted past the cap');
    r = res(); await studio.handler(req({ method: 'GET', query: { budget: 'gen-bud1' } }), r);
    assert.equal(r.body.capUsd, 2); assert.equal(r.body.spentUsd, 0.8); assert.equal(r.body.committedUsd, 0.8);
    // raise the budget (password session = no member), audit-logged with real columns
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'budget', pieceId: 'gen-bud1', budgetUsd: 10, warnPct: 90 } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.capUsd, 10); assert.equal(r.body.warnPct, 90);
    assert.ok(pg.tables.audit_log.some((a) => a.action === 'piece.budget' && a.after.budgetUsd === 10));
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'budget', pieceId: 'gen-bud1', budgetUsd: -1 } }), r); assert.equal(r.statusCode, 400);
    // the refused render keeps its estimate for audit but its generation record is $0 (nothing was generated or charged)
    const refused = pg.tables.jobs[3]; assert.equal(Number(refused.estimate_usd), 0.8);
    const rec = pg.tables.generation_records.find((g) => g.job_id === refused.id); assert.ok(rec, 'a generation record for the refusal'); assert.equal(Number(rec.cost_usd), 0); assert.equal(rec.status, 'failed');
  } finally { f.restore(); jobs.restore(); pieces.restore(); studio.restore(); }
});

test('budget: the v1 reference path has no estimate endpoint — it is charged at the last observed price or a conservative fallback, so it never escapes the cap', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([
    [/api\.higgsfield\.ai\/estimate\//, () => { throw new Error('must not price the v1 path'); }],
    ['/v1/text2image/soul', () => json({ id: 'jobsetv1abc01' })],
    pg.route,
  ]);
  const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV);
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-bud2', stage: 'plan', artifact: { title: 'B', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] } } }), r);
    r = res(); await jobs.handler(req({ method: 'POST', body: { pieceId: 'gen-bud2', stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: 'p', aspect_ratio: '9:16', ref: 'https://sb.test/storage/v1/object/public/refs/x.jpg' } } }), r);
    assert.equal(r.body.job.state, 'running', JSON.stringify(r.body.job)); assert.equal(r.body.job.estimateUsd, 1, 'no estimate endpoint → the conservative fallback, so it still counts');
    assert.match(pg.tables.jobs[0].payload.estimateBasis, /v1 reference path\) → conservative fallback/);
  } finally { f.restore(); jobs.restore(); pieces.restore(); }
});

test('page: budgetLine shows spent + in progress against the cap, coloured at the warning threshold', () => {
  const { loadPage } = require('../helpers');
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    X.BUDGET['gen-b'] = { capUsd: 10, warnPct: 80, spentUsd: 6, committedUsd: 2.5, jobs: 4 };
    const html = X.budgetLine({ id: 'gen-b' });
    assert.match(html, /b-gold">BUDGET \$8\.50 \/ \$10\.00 · 85 %/); assert.match(html, /\$6\.00 spent · \$2\.50 rendering · warns at 80 %/);
  } finally { X.restore(); }
});

test('budget: the estimate is reserved before the comparison — two renders gated together cannot both slip under the cap', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([[/api\.higgsfield\.ai\/estimate\//, () => json({ usd: 1.2, credits: 1 })], [/\/higgsfield-ai\/soul\/v2\/standard$/, () => json({ status: 'queued', request_id: 'res00001x', status_url: 'x', cancel_url: 'y' })], pg.route]);
  const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV);
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-bud3', stage: 'plan', artifact: { title: 'B', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] } } }), r);
    const piece = pg.tables.content_pieces[0]; const stage = pg.tables.stages.find((s) => s.kind === 'board');
    const mk = (n) => ({ id: `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`, piece_id: piece.id, stage_id: stage.id, kind: 'higgsfield_image', state: 'queued', attempts: 0, created_at: new Date().toISOString(), next_poll_at: new Date(Date.now() - 1000).toISOString(), provider_ref: null, estimate_usd: null, payload: { pieceId: 'gen-bud3', stage: 'board', prompt: `p${n}`, aspect_ratio: '9:16', resolution: '1080p' } });
    pg.tables.jobs = [mk(1), mk(2)];
    const { advance } = require('../../api/_jobs.js');
    const states = await Promise.all(pg.tables.jobs.map((j) => advance({ ...j })));
    assert.ok(states.includes('failed'), `$2.40 > $2.00: at least one of the two parallel renders is refused (${states})`);
    const ok = pg.tables.jobs.filter((j) => j.state !== 'failed'); assert.ok(ok.length <= 1);
  } finally { f.restore(); jobs.restore(); pieces.restore(); }
});

test('estimate parser: the documented { credits, usd }, a nested usd one level down, and a body without usd fails naming its keys (not values)', async () => {
  const bodies = [{ usd: 0.5, credits: 8 }, { estimate: { usd: '0.75', credits: 12 } }, { credits: 30, model: 'x' }];
  let i = 0;
  const f = mockFetch([[/api\.higgsfield\.ai\/estimate\//, () => json(bodies[i++])]]);
  const saved = process.env.HF_CREDENTIALS; process.env.HF_CREDENTIALS = 'id:secret';
  try {
    const hg = require('../../api/_adapters/higgsfield.js');
    assert.deepEqual(await hg.estimate('bytedance/seedance-2.5/image-to-video', {}), { usd: 0.5, credits: 8 });
    assert.deepEqual(await hg.estimate('bytedance/seedance-2.5/image-to-video', {}), { usd: 0.75, credits: 12 });
    await assert.rejects(hg.estimate('bytedance/seedance-2.5/image-to-video', {}), (e) => /no usd \(keys: credits,model\)/.test(e.message) && e.credits === 30);
  } finally { f.restore(); if (saved === undefined) delete process.env.HF_CREDENTIALS; else process.env.HF_CREDENTIALS = saved; }
});
