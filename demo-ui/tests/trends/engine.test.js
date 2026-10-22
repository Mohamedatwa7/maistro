// TREND_FRAMEWORK.md §1–§6 as code: veto-then-score, judgement validation and caps, caching per board,
// storage of every input, the scored view, and the hourly hook — against the in-memory PostgREST.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, fixture } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const { validateJudgement, enforceCaps } = require('../../api/_trends/judge.js');
const { scoreBoard, scoreOne, latestScores } = require('../../api/_trends/engine.js');
const { normalizeAgent } = require('../../api/_handlers/trends.js');
const { PRODUCT_CATALOG } = require('../../api/_brand.js');

const NOW = '2026-10-21T10:00:00.000Z';
const good = (over = {}) => ({
  profile: { whatItIs: 'Deadpan caption reveal', mechanic: 'setup line, beat, punchline in caption', originAndMeaning: 'comedic format', whySpreading: 'low effort, high relatability', languages: ['en'], confidence: 'high', unknowns: [] },
  safety: { verdict: 'pass', evidence: ['why: "comedy"'], rationale: 'harmless' }, culture: { verdict: 'pass', evidence: ['mechanic'], rationale: 'fine' }, origin: { verdict: 'pass', evidence: ['clips'], rationale: 'organic' }, audioExplicit: { verdict: 'pass', evidence: ['sound.title'], rationale: 'instrumental' },
  feasibilityClass: 'product-led visual',
  criteria: {
    gulf: { score: 6, evidence: ['scope: global'], rationale: 'adaptable', confidence: 'medium' },
    product: { score: 9, evidence: ['fit.beat'], rationale: 'Flip as the punchline', confidence: 'high', product: 'Galaxy Z Flip8', feature: 'FlexWindow' },
    brand: { score: 8, evidence: ['why'], rationale: 'refined wit', confidence: 'high' },
    audience: { score: 7, evidence: ['category'], rationale: 'young', confidence: 'medium' },
    platform: { score: 8, evidence: ['clips'], rationale: 'tiktok native', confidence: 'high' },
    saturation: { score: 5, evidence: [], rationale: 'unknown', confidence: 'low' },
  },
  ...over,
});

test('validateJudgement rejects malformed answers (missing fields, bad enums, scores without evidence, a veto without evidence)', () => {
  assert.deepEqual(validateJudgement(good()), []);
  assert.ok(validateJudgement({}).length > 5);
  assert.ok(validateJudgement(good({ feasibilityClass: 'dance' })).some((p) => /feasibilityClass/.test(p)));
  const noEv = good(); noEv.criteria.brand.evidence = [];
  assert.ok(validateJudgement(noEv).some((p) => /brand: a score ≥ 6 needs evidence/.test(p)));
  const veto = good({ safety: { verdict: 'veto', evidence: [], rationale: 'x' } });
  assert.ok(validateJudgement(veto).some((p) => /safety: a veto needs evidence/.test(p)));
  const bad = good(); bad.criteria.gulf.score = 11;
  assert.ok(validateJudgement(bad).some((p) => /gulf.score/.test(p)));
});

test('enforceCaps: Gulf is capped at 7/medium without Gulf evidence; a non-catalog product caps fit at 4; "none" caps at 3', () => {
  const j = good(); j.criteria.gulf.score = 9; j.criteria.gulf.confidence = 'high';
  let notes = enforceCaps(j, { catalog: PRODUCT_CATALOG, gulfEvidence: false });
  assert.equal(j.criteria.gulf.score, 7); assert.equal(j.criteria.gulf.confidence, 'medium'); assert.equal(notes.length, 2);
  const k = good(); k.criteria.product.product = 'Galaxy Z Flip7';
  notes = enforceCaps(k, { catalog: PRODUCT_CATALOG, gulfEvidence: true });
  assert.equal(k.criteria.product.score, 4); assert.equal(k.criteria.product.catalogMatch, false); assert.match(notes[0], /not a catalog name/);
  const n = good(); n.criteria.product.product = 'none';
  enforceCaps(n, { catalog: PRODUCT_CATALOG, gulfEvidence: true }); assert.equal(n.criteria.product.score, 3);
});

test('scoreOne: vetoes come before scores; a judged trend gets a weighted final; a vetoed one keeps its inputs but no final; needsReview is neither', () => {
  const trend = normalizeAgent(fixture('agent-trends.json').trends[0]);
  const snaps = [{ trend_id: trend.trendId, fetched_at: '2026-10-20T09:00:00Z', board_generated_at: '2026-10-20T08:25:00Z', growth_pct_per_day: 1, durability: 'ongoing', sound_cleared: true }, { trend_id: trend.trendId, fetched_at: '2026-10-21T09:00:00Z', board_generated_at: '2026-10-21T08:25:00Z', growth_pct_per_day: 1, durability: 'ongoing', sound_cleared: true }];
  let r = scoreOne({ trend, snaps, judgement: good(), leadDays: null, stayDays: {}, now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  assert.equal(r.status, 'scored'); assert.equal(r.vetoes.length, 0); assert.ok(r.final.score > 50 && r.final.score <= 95, String(r.final.score));
  assert.equal(r.criteria.feasibility, 9.5); assert.equal(r.criteria.product, 9); assert.deepEqual(r.productMapping, { product: 'Galaxy Z Flip8', feature: 'FlexWindow', catalogMatch: true });
  assert.equal(r.timing.leadAssumed, true); assert.equal(r.lifecycle.stage, 'emerging');
  r = scoreOne({ trend, snaps, judgement: good({ safety: { verdict: 'veto', evidence: ['why'], rationale: 'tragedy-linked' } }), leadDays: null, stayDays: {}, now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  assert.equal(r.status, 'vetoed'); assert.deepEqual(r.vetoes.map((v) => v.code), ['V-SAFETY']); assert.ok(r.final.score != null, 'inputs kept for the rejected view');
  // culture/origin unsure is advisory: scored, confidence low, review before use (calibration 2026-10-22)
  r = scoreOne({ trend, snaps, judgement: good({ culture: { verdict: 'needsReview', evidence: ['mechanic'], rationale: 'ambiguous in Ramadan' } }), leadDays: null, stayDays: {}, now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  assert.equal(r.status, 'scored'); assert.equal(r.confidence, 'low'); assert.deepEqual(r.reviewBeforeUse, ['V-CULTURE']);
  // safety unsure still holds the trend back
  r = scoreOne({ trend, snaps, judgement: good({ safety: { verdict: 'needsReview', evidence: ['name'], rationale: 'possible dare' } }), leadDays: null, stayDays: {}, now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  assert.equal(r.status, 'needs_review'); assert.deepEqual(r.reviewBeforeUse, []);
  r = scoreOne({ trend, snaps, judgement: null, leadDays: null, stayDays: {}, now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  assert.equal(r.status, 'unjudged'); assert.equal(r.criteria.gulf, null);
});

test('scoreBoard: judges each trend once per board and prompt version (cached on re-run), stores every input, counts malformed answers, and latestScores splits ranked / rejected / needs review', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const feed = fixture('agent-trends.json');
  const board = { raw: feed.trends.slice(0, 4).map(normalizeAgent), source: 'TrendRadar agent API', live: true, boardGeneratedAt: feed.generatedAt, total: 4 };
  for (const t of board.raw) for (const day of ['2026-10-19', '2026-10-20', '2026-10-21']) pg.tables.trend_snapshots = pg.tables.trend_snapshots || [], pg.tables.trend_snapshots.push({ id: pg.tables.trend_snapshots.length + 1, trend_id: t.trendId, fetched_at: `${day}T09:00:00Z`, board_generated_at: `${day}T08:25:00Z`, growth_pct_per_day: 1 + (day.endsWith('21') ? 1 : 0), durability: 'ongoing', sound_cleared: true, stage: 'peaking' });
  let calls = 0;
  const judge = async ({ trend }) => {
    calls++;
    if (trend.trendId === board.raw[1].trendId) return { error: 'judgement failed validation', problems: ['criteria.gulf.score: integer 0–10'] };
    if (trend.trendId === board.raw[2].trendId) return { judgement: good({ safety: { verdict: 'veto', evidence: ['name'], rationale: 'dangerous challenge' } }), model: 'test', promptVersion: require('../../api/_trends/prompts/profile-v1.js').VERSION, usage: { input_tokens: 100, output_tokens: 50 } };
    return { judgement: good(), model: 'test', promptVersion: require('../../api/_trends/prompts/profile-v1.js').VERSION, usage: { input_tokens: 100, output_tokens: 50 } };
  };
  const saved = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  try {
    let out = await scoreBoard(board, { now: NOW, judge });
    assert.equal(calls, 4); assert.deepEqual([out.summary.judged, out.summary.failed, out.summary.reused, out.summary.stored], [3, 1, 0, 4]);
    assert.equal(out.summary.lead.leadDays, null, 'no approved pieces yet → lead time assumed'); assert.deepEqual(out.summary.stayDays, {}, 'fewer than 20 trends per class → seed medians');
    assert.equal(pg.tables.trend_scores.length, 4);
    const statuses = pg.tables.trend_scores.map((r) => r.status).sort();
    assert.deepEqual(statuses, ['scored', 'scored', 'unjudged', 'vetoed']);
    const stored = pg.tables.trend_scores.find((r) => r.status === 'scored');
    assert.equal(stored.inputs.timing.basis, 'seed median'); assert.deepEqual(stored.inputs.staySamples, { ongoing: 4 });
    assert.equal(stored.prompt_version, require('../../api/_trends/prompts/profile-v1.js').VERSION); assert.equal(stored.weights_version, 'w1-2026-10-21'); assert.equal(stored.inputs.snapshots, 3); assert.ok(stored.judgement.profile); assert.ok(stored.post_by);
    const failedRow = pg.tables.trend_scores.find((r) => r.status === 'unjudged'); assert.match(failedRow.inputs.judgeError, /failed validation/);
    assert.equal(out.results[0].status, 'scored', 'ranked first');
    // second run on the same board: judgements reused, no new calls
    out = await scoreBoard(board, { now: '2026-10-21T11:00:00.000Z', judge });
    assert.equal(calls, 5, 'only the previously failed trend is judged again'); assert.equal(out.summary.reused, 3);
    const view = await latestScores();
    assert.equal(view.ranked.length, 2); assert.equal(view.rejected.length, 1); assert.equal(view.needsReview.length, 1);
    assert.equal(view.rejected[0].vetoes[0].code, 'V-SAFETY'); assert.ok(view.ranked[0].score >= view.ranked[1].score); assert.equal(view.ranked[0].productMapping.product, 'Galaxy Z Flip8');
  } finally { f.restore(); if (saved.u === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved.u; if (saved.k === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.k; }
});

test('hourly refresh runs the scoring after the snapshots (MAISTRO_TREND_SCORING=0 disables it); ?view=scored needs a session and returns the latest run', async () => {
  const pg = fakePostgrest();
  const feed = fixture('agent-trends.json');
  const f = mockFetch([
    ['/api/agent/trends', () => json(feed)],
    ['api.anthropic.com', (u, init) => { const body = JSON.parse(init.body); if (/Select and rank/.test(JSON.stringify(body))) return json({ content: [{ type: 'text', text: JSON.stringify({ selected: [] }) }], stop_reason: 'end_turn' }); return json({ content: [{ type: 'text', text: JSON.stringify(good()) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); }],
    pg.route,
  ]);
  const h = api('trends.js', { ANTHROPIC_API_KEY: 'k', TRENDRADAR_AGENT_KEY: 'agent-key', TRENDRADAR_BASE_URL: 'https://tr.test', CRON_SECRET: 'cron', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  try {
    let r = res(); await h.handler(req({ headers: { authorization: 'Bearer cron' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.refreshed, true);
    assert.equal(r.body.scoring.error, undefined, JSON.stringify(r.body.scoring));
    assert.equal(r.body.scoring.trends, 12); assert.equal(r.body.scoring.judged, 9, 'three fixture trends are hard-vetoed by the deterministic rules and never sent to the judge'); assert.equal(r.body.scoring.skippedVetoed, 3); assert.equal(r.body.scoring.deferred, 0); assert.equal(pg.tables.trend_scores.length, 12);
    // the guard-rail eval ran once for this prompt version and is recorded with real audit_log columns
    assert.ok(r.body.eval && r.body.eval.total === 8, JSON.stringify(r.body.eval));
    const evalRows = (pg.tables.audit_log || []).filter((a) => a.action === 'trends.eval'); assert.equal(evalRows.length, 1); assert.equal(evalRows[0].after.promptVersion, require('../../api/_trends/prompts/profile-v1.js').VERSION); assert.equal(evalRows[0].after.results.length, 8);
    r = res(); await h.handler(req({ headers: { authorization: 'Bearer cron' } }), r);
    assert.equal(r.body.eval, null, 'not re-run for the same prompt version'); assert.equal((pg.tables.audit_log || []).filter((a) => a.action === 'trends.eval').length, 1);
    r = res(); await h.handler(req({ query: { view: 'scored' }, session: false }), r); assert.equal(r.statusCode, 401);
    r = res(); await h.handler(req({ query: { view: 'scored' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.ranked.length + r.body.rejected.length + r.body.needsReview.length, 12); assert.equal(r.headers['cache-control'], 'no-store');
    process.env.MAISTRO_TREND_SCORING = '0';
    r = res(); await h.handler(req({ headers: { authorization: 'Bearer cron' } }), r);
    assert.equal(r.body.scoring, null); assert.equal(pg.tables.trend_scores.length, 24, 'two scored refreshes, the third disabled');
  } finally { delete process.env.MAISTRO_TREND_SCORING; f.restore(); h.restore(); }
});

test('POST /api/trends records a human decision (5.7): session required, enum and reason rules, member identity when present', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const h = api('trends.js', { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', TRENDRADAR_AGENT_KEY: 'agent-key' });
  const { makeSessionCookieValue, SESSION_COOKIE } = require('../../api/_auth.js');
  try {
    let r = res(); await h.handler(req({ method: 'POST', body: { trendId: 'snd-1', decision: 'pick' }, session: false }), r); assert.equal(r.statusCode, 401);
    r = res(); await h.handler(req({ method: 'POST', body: { trendId: 'snd-1', decision: 'maybe' } }), r); assert.equal(r.statusCode, 400);
    r = res(); await h.handler(req({ method: 'POST', body: { trendId: 'snd-1', decision: 'reject', reasonCode: 'off_brand' } }), r); assert.equal(r.statusCode, 400, 'reject needs a written reason');
    r = res(); await h.handler(req({ method: 'POST', body: { trendId: 'snd-1', decision: 'reject', reasonCode: 'nope', reason: 'x' } }), r); assert.equal(r.statusCode, 400, 'reason code enum');
    r = res(); await h.handler(req({ method: 'POST', body: { trendId: 'snd-1', scoreId: 7, decision: 'pick', name: 'N. Haddad' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(pg.tables.trend_decisions.length, 1); assert.equal(pg.tables.trend_decisions[0].score_id, 7); assert.equal(pg.tables.trend_decisions[0].name_as_signed, 'N. Haddad'); assert.equal(pg.tables.trend_decisions[0].decided_by, null);
    (pg.tables.members = pg.tables.members || []).push({ id: 'u-r', email: 'r@samsung.com', role: 'reviewer', active: true, display_name: 'R. Viewer' });
    const cookie = `${SESSION_COOKIE}=${makeSessionCookieValue('test-session', Date.now(), undefined, { id: 'u-r', email: 'r@samsung.com', role: 'reviewer', name: 'R. Viewer' })}`;
    r = res(); await h.handler(req({ method: 'POST', body: { trendId: 'snd-2', decision: 'override_veto', reasonCode: 'veto_wrong', reason: 'the sound is original' }, headers: { cookie }, session: false }), r);
    assert.equal(r.statusCode, 200); assert.equal(pg.tables.trend_decisions[1].decided_by, 'u-r'); assert.equal(pg.tables.trend_decisions[1].name_as_signed, 'R. Viewer'); assert.equal(pg.tables.trend_decisions[1].reason_code, 'veto_wrong');
    r = res(); await h.handler(req({ method: 'PUT' }), r); assert.equal(r.statusCode, 405);
  } finally { f.restore(); h.restore(); }
});

test('the API-facing judgement schema carries no integer bounds (the first live run failed 38/38 on minimum/maximum); our validator still enforces 0–10', () => {
  const { SCHEMA } = require('../../api/_trends/prompts/profile-v1.js');
  assert.ok(!JSON.stringify(SCHEMA).includes('"minimum"') && !JSON.stringify(SCHEMA).includes('"maximum"'));
  const j = good(); j.criteria.gulf.score = 11;
  assert.ok(validateJudgement(j).some((p) => /gulf.score/.test(p)));
});

test('scoreBoard: judges concurrently under a deadline — trends not reached are stored unjudged as deferred and judged by the next run; deterministically hard-vetoed trends are never sent to the judge', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const feed = fixture('agent-trends.json');
  const raw = feed.trends.slice(0, 6).map(normalizeAgent);
  raw[5] = { ...raw[5], sound: { title: 'Uncleared Sound', cleared: false, clearedCheckedAt: '2026-10-21T08:00:00Z' } }; // V-AUDIO hard veto before any model call
  const board = { raw, source: 'TrendRadar agent API', live: true, boardGeneratedAt: feed.generatedAt, total: 6 };
  for (const t of board.raw) for (const day of ['2026-10-19', '2026-10-20', '2026-10-21']) pg.tables.trend_snapshots = pg.tables.trend_snapshots || [], pg.tables.trend_snapshots.push({ id: pg.tables.trend_snapshots.length + 1, trend_id: t.trendId, fetched_at: `${day}T09:00:00Z`, board_generated_at: `${day}T08:25:00Z`, growth_pct_per_day: 1 + (day.endsWith('21') ? 1 : 0), durability: 'ongoing', sound_cleared: t.sound ? t.sound.cleared : true, stage: 'peaking' });

  const PV = require('../../api/_trends/prompts/profile-v1.js').VERSION;
  let calls = 0, inFlight = 0, maxInFlight = 0;
  const judge = async () => { calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 30)); inFlight--; return { judgement: good(), model: 'test', promptVersion: PV, usage: { input_tokens: 1, output_tokens: 1 } }; };
  const saved = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  try {
    // two workers, a deadline that lets exactly the first wave through
    let out = await scoreBoard(board, { now: NOW, judge, concurrency: 2, deadline: Date.now() + 15 });
    assert.equal(maxInFlight, 2, 'two judgements in flight'); assert.equal(calls, 2, 'the first wave only');
    assert.equal(out.summary.judged, 2); assert.equal(out.summary.deferred, 3); assert.equal(out.summary.skippedVetoed, 1); assert.equal(out.summary.stored, 6, 'the whole board is still written');
    const rows = pg.tables.trend_scores; assert.equal(rows.length, 6);
    assert.equal(rows.filter((r) => r.status === 'scored').length, 2); assert.equal(rows.filter((r) => r.status === 'vetoed').length, 1);
    const def = rows.filter((r) => r.status === 'unjudged'); assert.equal(def.length, 3); assert.match(def[0].inputs.judgeError, /deferred/);
    const vetoedRow = rows.find((r) => r.status === 'vetoed'); assert.equal(vetoedRow.vetoes[0].code, 'V-AUDIO'); assert.equal(vetoedRow.judgement, null, 'never judged');
    // the next run reuses the two judgements and finishes the three deferred ones; the vetoed trend is still not judged
    out = await scoreBoard(board, { now: '2026-10-21T11:00:00.000Z', judge, concurrency: 4 });
    assert.equal(calls, 5); assert.deepEqual([out.summary.judged, out.summary.reused, out.summary.deferred, out.summary.skippedVetoed], [3, 2, 0, 1]);
    const view = await latestScores(); assert.equal(view.ranked.length, 5); assert.equal(view.rejected.length, 1); assert.equal(view.needsReview.length, 0);
  } finally { f.restore(); if (saved.u === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved.u; if (saved.k === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.k; }
});
