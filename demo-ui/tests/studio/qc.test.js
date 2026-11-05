// Phase 6.7 — QC: F1X8 on the stored assembled cut verified by sha256, the automated checklist, a located fix plan
// mapped to the smallest regeneration unit, priced (Hermes: from the bots' credit table at an assumed $/credit); edit, send back, and a sign-off bound
// to the analysed draft.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { api, req, res, mockFetch, json, loadPage } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const QC = require('../../api/_studio/qc.js');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', HF_CREDENTIALS: 'id:secret', ANTHROPIC_API_KEY: 'k', CRON_SECRET: 'cron' };
const CUT = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 9, 9, 9, 9]);
const SHA = crypto.createHash('sha256').update(CUT).digest('hex');
const shot = (n, d, tr) => ({ n, durationS: d, type: 'medium', camera: 'c', action: `a${n}`, product: { visible: n < 3, feature: '' }, onScreenText: { en: n === 1 ? 'Hook' : '', ar: '' }, line: { en: '', ar: '' }, audioCue: 'x', transition: tr, clip: { state: 'rendered', assetPath: `pieces/gen-qc1/draft/c${n}.mp4` }, review: { decision: 'approved' } });
const SHOTS = [shot(1, 2, 'cut'), shot(2, 4, 'dissolve'), shot(3, 4, 'none')];
const F1X8 = { score: 5.8, verdict: { summary: 'Slow open; the product lands late.', risks: [{ rank: 1, issue: 'hook is slow', evidence: '0–2 s static', impact: 'drop-off', suggested_fix: 'start on the reveal', confidence: 'high' }, { rank: 2, issue: 'overlay text too small', evidence: 'shot 1 text', impact: 'unreadable', suggested_fix: 'bigger, shorter text', confidence: 'medium' }], revision_brief: { hook_0_3s: 'open on the FlexWindow' } } };
const PLAN = { summary: 'Two fixes.', fixes: [
  { ref: 'risk:1', shot: 1, timestampS: 4.5, element: 'visual', problem: 'slow hook', fixType: 'shot_regen', instruction: 'fast push-in onto the cover screen', newText: null }, // t=4.5 s is shot 2 → code relocates
  { ref: 'risk:2', shot: 1, timestampS: null, element: 'overlay_text', problem: 'text too small', fixType: 'shot_regen', instruction: 'shorter overlay', newText: { en: 'Flip it.', ar: 'اقلبها.' } }, // wrong unit → overlay_edit
] };

test('timeline, shotAt, normalisePlan and estimatePlan: shots from timestamps (dissolve overlap included), units coerced to the cheapest allowed, coverage of every risk and failed check, provider estimates deduplicated per shot', async () => {
  const tl = QC.timeline(SHOTS, ['cut', 'dissolve', 'none']);
  assert.deepEqual(tl, [{ n: 1, startS: 0, endS: 2 }, { n: 2, startS: 2, endS: 6 }, { n: 3, startS: 5.75, endS: 9.75 }]);
  assert.equal(QC.shotAt(tl, 4.5), 2); assert.equal(QC.shotAt(tl, 9.9), 3); assert.equal(QC.shotAt(tl, null), null);
  const failed = [{ code: 'cut_overlays_present', shot: null }];
  const n = QC.normalisePlan(PLAN, { tl, risks: F1X8.verdict.risks, failed });
  assert.equal(n.fixes[0].shot, 2, 'relocated from its timestamp'); assert.equal(n.fixes[1].fixType, 'overlay_edit', 'overlay text is fixed at the overlay');
  assert.equal(n.coverage.complete, false); assert.deepEqual(n.coverage.uncovered, ['check:cut_overlays_present']); assert.equal(n.notes.length, 2);
  const calls = [];
  const estimate = async (endpoint, body) => { calls.push([endpoint, body]); return endpoint.includes('soul') ? { usd: 0.05, credits: 5 } : { usd: 0.4 * body.duration, credits: 40 * body.duration }; };
  const fixes = [...n.fixes, { id: 'fx9', ref: 'risk:1', shot: 2, element: 'visual', fixType: 'shot_regen', instruction: 'x', include: true }, { id: 'fx10', ref: 'x', shot: 0, element: 'audio', fixType: 'audio_swap', instruction: 'y', include: true }, { id: 'fx11', ref: 'x', shot: 3, element: 'pacing', fixType: 'shotlist_change', instruction: 'z', include: true }];
  const cost = await QC.estimatePlan(fixes, { draft: { shots: SHOTS, resolution: '720p', aspect: '9:16' }, estimate });
  assert.equal(calls.filter((c) => c[0].includes('image-to-video')).length, 2, 'shot 2 priced once, plus the shot-list change clip'); assert.equal(calls[0][1].duration, 4);
  assert.equal(cost.totalUsd, 1.6 + 0.05 + 1.6); assert.deepEqual(cost.unknownIds, ['fx10']);
  assert.equal(cost.items.find((i) => i.id === 'fx2').usd, 0); assert.match(cost.items.find((i) => i.id === 'fx9').basis, /shares shot 2/); assert.match(cost.items.find((i) => i.id === 'fx10').basis, /no licensed audio library/);
});

test('POST /api/studio action qc: needs the assembled cut; F1X8 analyses the stored bytes (sha256 verified); the report is built on the tick with the checklist, located fixes and estimates; plan edit and send-back; sign-off refused once the draft changes', async () => {
  const pg = fakePostgrest();
  let f1x8Polls = 0, planUser = '';
  const f = mockFetch([
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t` })],
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\/pieces\/gen-qc1\/draft\/cut\.mp4/.test(u) && (init.method || 'GET') === 'GET', () => new Response(CUT, { status: 200, headers: { 'content-type': 'video/mp4' } })],
    ['/api/analyze/video/submit', () => json({ job_id: 'fx-qc-1' })],
    ['/api/job/fx-qc-1', () => { f1x8Polls++; return json({ status: 'done', result: F1X8 }); }],
    ['api.anthropic.com', (u, init) => { const b = JSON.parse(init.body); planUser = b.messages[0].content; return json({ content: [{ type: 'text', text: JSON.stringify(PLAN) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); }],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV); const decisions = api('decisions.js', ENV);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-qc1', stage: 'plan', artifact: { title: 'QC', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'QC', product: 'Galaxy Z Flip8', msg: 'm', platforms: ['tiktok'], markets: ['UAE'] } } }), r);
    const store = require('../../api/_store.js');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'qc', pieceId: 'gen-qc1' } }), r); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'prerequisites');
    const draft = { shots: SHOTS, totalS: 9.75, aspect: '9:16', resolution: '720p', assembled: { assetPath: 'pieces/gen-qc1/draft/cut.mp4', sha256: SHA, durationS: 9.75, transitions: ['cut', 'dissolve', 'none'], hasAudio: true, loudness: { I: -14, TP: -1 } }, assetPath: 'pieces/gen-qc1/draft/cut.mp4', sha256: SHA, assembledChecks: [{ code: 'overlays_present', passed: false, detail: 'shots without overlay: 1' }, { code: 'export_spec', passed: true, detail: 'ok' }], dur: '9.75s', audio: 'x', variants: [{ a: '9:16', l: '720p', k: 'seedance', st: 'ready' }], videoUrl: null, rev: 0 };
    const dv = await store.recordVersion('gen-qc1', 'draft', draft, { producedBy: 'higgsfield_seedance', kind: 'video' });
    const draftStage = pg.tables.stages.find((s) => s.kind === 'draft');
    for (const s of SHOTS) pg.tables.stage_checks = [...(pg.tables.stage_checks || []), { id: (pg.tables.stage_checks || []).length + 1, at: new Date().toISOString(), piece_id: draftStage.piece_id, stage_id: draftStage.id, artifact_version_id: dv.versionId, kind: 'vision', passed: s.n !== 3, results: { shot: s.n, images: [{ index: 0, flags: s.n === 3 ? ['product or person morphs between frames'] : [] }] } }];
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'qc', pieceId: 'gen-qc1' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.draftSha256, SHA); assert.equal(r.body.job.state, 'running', JSON.stringify(r.body.job));
    const qj = pg.tables.jobs.find((j) => j.kind === 'f1x8_video'); assert.equal(qj.payload.expectSha256, SHA); assert.equal(qj.payload.versionId, dv.versionId); assert.equal(qj.payload.qcReport, true);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'qc', pieceId: 'gen-qc1' } }), r); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'busy');
    qj.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await jobs.handler(req({ headers: { authorization: 'Bearer cron' }, session: false }), r);
    assert.equal(f1x8Polls, 1); const done = pg.tables.jobs.find((j) => j.id === qj.id); assert.equal(done.state, 'succeeded'); assert.ok(done.result.report, JSON.stringify(done.result) + done.error);
    assert.equal(pg.tables.qc_results.at(-1).artifact_version_id, dv.versionId, 'F1X8 bound to the analysed draft version');
    r = res(); await studio.handler(req({ method: 'GET', query: { qc: 'gen-qc1' } }), r);
    const R = r.body.report; assert.equal(r.body.version, 1); assert.equal(R.draftSha256, SHA); assert.equal(R.draftVersionId, dv.versionId); assert.equal(R.score, 5.8);
    assert.ok(R.checklist.some((c) => c.code === 'clip_product_and_artifacts' && c.shot === 3 && !c.passed)); assert.ok(R.checklist.some((c) => c.code === 'cut_overlays_present' && !c.passed));
    assert.equal(R.fixes[0].shot, 2); assert.equal(R.fixes[1].fixType, 'overlay_edit'); assert.equal(R.coverage.complete, false, 'the failed checks are not covered by this plan');
    assert.equal(R.cost.totalUsd, 1.08, 'one 4 s 720p re-render: 18 credits × the assumed $0.06'); assert.match(R.cost.items.find((x) => x.usd > 0).basis, /18 Higgsfield credits \(Seedance 2\.0, 4 s at 720p\) × assumed \$0\.06\/credit/); assert.match(planUser, /"startS": 5\.75/); assert.match(planUser, /FAILED AUTOMATED CHECKS/);
    const qv = pg.tables.artifact_versions.find((v) => v.id === r.body.versionId); assert.equal(qv.produced_by, 'f1x8'); assert.equal(qv.kind, 'qc_report');
    // plan edit: drop the re-render → cost 0, risk 1 uncovered, a manual version
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'qc-plan-edit', pieceId: 'gen-qc1', edits: [{ id: 'fx1', include: false }] } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.version, 2); assert.equal(r.body.report.cost.totalUsd, 0); assert.ok(r.body.report.coverage.uncovered.includes('risk:1'));
    assert.equal(pg.tables.artifact_versions.find((v) => v.id === r.body.versionId).produced_by, 'manual');
    // sign-off binds to the analysed draft: refused once the draft gets a new version
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-qc1', stage: 'qc', decision: 'approved', name: 'N', role: 'reviewer' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    // send-back after approval is refused (approved is immutable); on a fresh report it records a rejection with the target
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'qc-sendback', pieceId: 'gen-qc1', toStage: 'board', reason: 'x' } }), r); assert.equal(r.statusCode, 409);
    await store.recordVersion('gen-qc1', 'draft', { ...draft, assembled: { ...draft.assembled, sha256: 'f'.repeat(64) }, sha256: 'f'.repeat(64) }, { producedBy: 'higgsfield_seedance', kind: 'video' }).catch(() => null);
  } finally { f.restore(); studio.restore(); jobs.restore(); pieces.restore(); decisions.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('QC sign-off is refused when the draft changed after the report (qc_stale); a sha256 mismatch fails the F1X8 submit permanently', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t` })],
    [(u, init) => /\/object\/sign\/assets\/.*cut\.mp4/.test(u) && (init.method || 'GET') === 'GET', () => new Response(Buffer.from('tampered'), { status: 200, headers: { 'content-type': 'video/mp4' } })],
    ['/api/analyze/video/submit', () => { throw new Error('must not upload tampered bytes'); }],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const pieces = api('pieces.js', ENV); const decisions = api('decisions.js', ENV);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-qc2', stage: 'plan', artifact: { title: 'QC', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] } } }), r);
    const store = require('../../api/_store.js');
    const d1 = await store.recordVersion('gen-qc2', 'draft', { shots: SHOTS, assembled: { assetPath: 'pieces/gen-qc2/draft/cut.mp4', sha256: SHA }, sha256: SHA, rev: 0 }, { producedBy: 'higgsfield_seedance', kind: 'video' });
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'qc', pieceId: 'gen-qc2' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.job.state, 'failed', 'tampered bytes never reach F1X8'); assert.match(r.body.job.error, /does not match/);
    // a report bound to d1, then the draft moves on → the QC sign-off is refused
    await store.recordVersion('gen-qc2', 'qc', { real: true, report: { draftVersionId: d1.versionId, draftSha256: SHA, fixes: [], checklist: [], f1x8: { risks: [] }, timeline: [], cost: { totalUsd: 0, items: [], unknownIds: [] }, coverage: { complete: true, uncovered: [] } } }, { producedBy: 'f1x8', kind: 'qc_report' });
    await store.recordVersion('gen-qc2', 'draft', { shots: SHOTS, assembled: { assetPath: 'pieces/gen-qc2/draft/cut2.mp4', sha256: 'e'.repeat(64) }, sha256: 'e'.repeat(64), rev: 0 }, { producedBy: 'higgsfield_seedance', kind: 'video' });
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-qc2', stage: 'qc', decision: 'approved', name: 'N', role: 'reviewer' } }), r);
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'qc_stale');
    // send back: a rejection with the target stage recorded
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'qc-sendback', pieceId: 'gen-qc2', toStage: 'board', reason: 'the hook needs a new shot', name: 'N' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.toStage, 'board');
    const ap = pg.tables.approvals.at(-1); assert.equal(ap.decision, 'rejected'); assert.deepEqual(ap.details, { sendBack: 'board' }); assert.match(ap.reason, /^sent back to board: /);
  } finally { f.restore(); studio.restore(); pieces.restore(); decisions.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('page: rQcPlan shows the score, checks, the located fix table with costs, coverage and the draft binding; edit mode offers include toggles and instructions', () => {
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    const report = { score: 5.8, summary: 'Slow open.', checklist: [{ code: 'clip_product_and_artifacts', passed: false, shot: 3, detail: 'morphs' }, { code: 'overlay_safe_zone', passed: true }], passedChecks: 1, fixes: [{ id: 'fx1', ref: 'risk:1', shot: 2, timestampS: 4.5, element: 'visual', problem: 'slow hook', fixType: 'shot_regen', instruction: 'fast push-in', newText: null, include: true }, { id: 'fx2', ref: 'risk:2', shot: 1, timestampS: null, element: 'overlay_text', problem: 'small text', fixType: 'overlay_edit', instruction: 'shorter', newText: { en: 'Flip it.', ar: 'اقلبها.' }, include: true }], timeline: [{ n: 1, startS: 0, endS: 2 }, { n: 2, startS: 2, endS: 6 }], cost: { totalUsd: 1.6, items: [{ id: 'fx1', usd: 1.6, basis: 'Seedance image-to-video 4s 720p (provider estimate)' }, { id: 'fx2', usd: 0, basis: 're-assembly only' }], unknownIds: [] }, coverage: { complete: false, uncovered: ['check:clip_product_and_artifacts'] }, draftVersion: 3, draftSha256: SHA, f1x8: { risks: [] }, planNotes: ['fx1: shot 1 → 2 from t=4.5s'] };
    const p = { id: 'gen-q', generated: true, studio: true, stage: 6, title: 'T', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'Galaxy Z Flip8', msg: 'm', angle: 'a' }, qc: { real: true, report, version: 'v1' } };
    X.PROJECTS.unshift(p);
    let html = X.stageArtifact(p, 6);
    assert.match(html, /F1X8 5\.8\/10/); assert.match(html, /1\/2 CHECKS PASSED/); assert.match(html, /2 FIXES · EST\. \$1\.60/); assert.match(html, /UNADDRESSED: check:clip_product_and_artifacts/); assert.match(html, new RegExp(`ON DRAFT v3 · SHA ${SHA.slice(0, 10)}`));
    assert.match(html, /Shot 2<div class="dim mono" style="font-size:10px">2–6 s · @4\.5s/); assert.match(html, /SHOT REGEN/); assert.match(html, /\$1\.60/); assert.match(html, /<span dir="rtl">اقلبها\.<\/span>/); assert.match(html, /Plan normalised in code: fx1: shot 1 → 2/); assert.match(html, /✗ CLIP PRODUCT AND ARTIFACTS · SHOT 3/);
    assert.match(html, /Edit plan/); assert.match(html, /Send back/);
    X.QC_EDIT['gen-q'] = 1; html = X.stageArtifact(p, 6);
    assert.match(html, /class="qc-inc" data-id="fx1" checked/); assert.match(html, /class="inp-l qc-ins" data-id="fx2"/); assert.match(html, /Save plan as new version/);
  } finally { X.restore(); }
});

test('QC covers the whole pipeline (2026-11-05): F1X8 also scores the thumbnail, each moodboard direction, every storyboard keyframe and every carousel slide; stills done before the report join it, later ones are merged in', async () => {
  const pg = fakePostgrest();
  let img = 0;
  const f = mockFetch([
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t` })],
    [(u, init) => /\/object\/sign\/assets\/.*cut\.mp4/.test(u) && (init.method || 'GET') === 'GET', () => new Response(CUT, { status: 200, headers: { 'content-type': 'video/mp4' } })],
    [(u, init) => /\/object\/sign\/assets\/.*\.png/.test(u) && (init.method || 'GET') === 'GET', () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]), { status: 200, headers: { 'content-type': 'image/png' } })],
    ['/api/analyze/video/submit', () => json({ job_id: 'fx-cut' })],
    ['/api/analyze/image/submit', () => json({ job_id: `fx-img-${++img}` })],
    ['/api/job/fx-cut', () => json({ status: 'done', result: F1X8 })],
    [(u) => /\/api\/job\/fx-img-\d+/.test(u), (u) => json({ status: 'done', result: { score: 7 + Number(String(u).split('fx-img-')[1]) / 10, verdict: { summary: 'still ok', risks: [] }, kpis: {} } })],
    ['api.anthropic.com', () => json({ content: [{ type: 'text', text: JSON.stringify(PLAN) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  const tick = async () => { const r = res(); await jobs.handler(req({ headers: { authorization: 'Bearer cron' }, session: false }), r); };
  const due = (pred) => { for (const j of pg.tables.jobs.filter(pred)) j.next_poll_at = new Date(Date.now() - 1000).toISOString(); };
  const later = (pred) => { for (const j of pg.tables.jobs.filter(pred)) j.next_poll_at = new Date(Date.now() + 3600e3).toISOString(); };
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-qc3', stage: 'plan', artifact: { title: 'QC', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'QC', product: 'Galaxy Z Flip8', msg: 'm', platforms: ['tiktok'], markets: ['UAE'] } } }), r);
    const store = require('../../api/_store.js');
    await store.recordVersion('gen-qc3', 'thumb', { assetPath: 'pieces/gen-qc3/thumb/t.png' }, { producedBy: 'external_hermes', kind: 'image' });
    await store.recordVersion('gen-qc3', 'mood', { moods: [{ n: 1 }, { n: 2 }, { n: 3 }], images: [{ mood: 1, state: 'rendered', assetPath: 'pieces/gen-qc3/mood/1.png' }, { mood: 2, state: 'rendered', assetPath: 'pieces/gen-qc3/mood/2.png' }, { mood: 3, state: 'pending', assetPath: null }] }, { producedBy: 'external_hermes', kind: 'image' });
    await store.recordVersion('gen-qc3', 'board', { shots: [1, 2, 3].map((n) => ({ n, keyframe: n === 3 ? null : { state: 'rendered', assetPath: `pieces/gen-qc3/board/k${n}.png` } })) }, { producedBy: 'external_hermes', kind: 'image' });
    await store.recordVersion('gen-qc3', 'draft', { shots: SHOTS, assembled: { assetPath: 'pieces/gen-qc3/draft/cut.mp4', sha256: SHA, durationS: 9.75 }, carousel: { slides: [{ n: 1, state: 'rendered', assetPath: 'pieces/gen-qc3/draft/s1.png' }, { n: 2, state: 'rendered', assetPath: 'pieces/gen-qc3/draft/s2.png' }] }, rev: 0 }, { producedBy: 'external_hermes', kind: 'video' });
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'qc', pieceId: 'gen-qc3' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.parts.map((x) => x.part), ['thumb', 'mood:1', 'mood:2', 'board:1', 'board:2', 'slide:1', 'slide:2']);
    const imgs = pg.tables.jobs.filter((j) => j.kind === 'f1x8_image');
    assert.equal(imgs.length, 7); assert.ok(imgs.every((j) => j.payload.qcBatch === r.body.qcBatch && j.state === 'queued'));
    assert.equal(imgs.find((j) => j.payload.qcPart === 'slide:2').stage_id, pg.tables.stages.find((s) => s.kind === 'draft' && s.piece_id === imgs[0].piece_id).id);
    // the stills are submitted by the tick; the cut waits
    later((j) => j.kind === 'f1x8_video'); due((j) => j.kind === 'f1x8_image'); await tick();
    assert.ok(pg.tables.jobs.filter((j) => j.kind === 'f1x8_image').every((j) => j.state === 'running'), JSON.stringify(pg.tables.jobs.filter((j) => j.kind === 'f1x8_image').map((j) => [j.state, j.error])));
    // three stills finish before the report …
    later(() => true); due((j) => j.kind === 'f1x8_image' && ['thumb', 'mood:1', 'board:1'].includes(j.payload.qcPart)); await tick();
    // … the report collects them …
    later(() => true); due((j) => j.kind === 'f1x8_video'); await tick();
    r = res(); await studio.handler(req({ method: 'GET', query: { qc: 'gen-qc3' } }), r);
    assert.ok(r.body.report, JSON.stringify(r.body)); assert.deepEqual(Object.keys(r.body.runs).sort(), ['board:1', 'draft', 'mood:1', 'thumb']);
    assert.equal(r.body.runs['mood:1'].label, 'Moodboard · direction 1'); assert.equal(r.body.parts.filter((x) => x.state === 'running').length, 4);
    // … and the rest are merged into it as they finish
    later(() => true); due((j) => j.kind === 'f1x8_image' && j.state === 'running'); await tick();
    r = res(); await studio.handler(req({ method: 'GET', query: { qc: 'gen-qc3' } }), r);
    assert.deepEqual(Object.keys(r.body.runs).sort(), ['board:1', 'board:2', 'draft', 'mood:1', 'mood:2', 'slide:1', 'slide:2', 'thumb']);
    const scores = Object.values(r.body.runs).map((x) => x.score);
    assert.equal(r.body.avg, Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10);
    assert.equal(r.body.report.score, 5.8, 'the fix plan stays on the cut');
    assert.ok(r.body.parts.every((x) => x.state === 'succeeded'));
  } finally { f.restore(); studio.restore(); jobs.restore(); pieces.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('page: the QC report lists every still F1X8 scored, the pipeline average and the stills still running', () => {
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    const report = { score: 5.8, summary: 's', checklist: [], passedChecks: 0, fixes: [], timeline: [], cost: { totalUsd: 0, items: [], unknownIds: [] }, coverage: { complete: true, uncovered: [] }, draftVersion: 1, draftSha256: SHA, f1x8: { risks: [] } };
    const runs = { draft: { score: 5.8, verdict: {} }, 'board:2': { label: 'Storyboard · shot 2 keyframe', score: 4.2, verdict: { summary: 'the hook frame is busy', risks: [] }, kpis: {} }, thumb: { label: 'Thumbnail', score: 8.1, verdict: {}, kpis: {}, heatmapPath: 'pieces/x/thumb/heatmap.png' } };
    const p = { id: 'gen-qp', generated: true, studio: true, stage: 6, title: 'T', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'Galaxy Z Flip8', msg: 'm', angle: 'a' }, qc: { real: true, report, version: 'v1', runs, avg: 6 } };
    X.PROJECTS.unshift(p);
    X.QC_PARTS['gen-qp'] = [{ part: 'slide:1', label: 'Carousel · slide 1', state: 'running' }, { part: 'mood:1', label: 'Moodboard · direction 1', state: 'failed', error: 'F1X8 reported error' }];
    const html = X.stageArtifact(p, 6);
    assert.match(html, /F1X8 across the pipeline/); assert.match(html, /PIPELINE AVG 6\.0\/10/); assert.match(html, /3 ASSET\(S\) SCORED/);
    assert.match(html, /THUMBNAIL · 8\.1/); assert.match(html, /STORYBOARD · SHOT 2 KEYFRAME · 4\.2/); assert.ok(html.indexOf('THUMBNAIL · 8.1') < html.indexOf('STORYBOARD · SHOT 2'), 'pipeline order');
    assert.match(html, /the hook frame is busy/); assert.match(html, /data-asset="pieces\/x\/thumb\/heatmap\.png"/);
    assert.match(html, /1 STILL ANALYSING/); assert.match(html, /Analysing: Carousel · slide 1/); assert.match(html, /Moodboard · direction 1: F1X8 reported error/);
  } finally { X.restore(); }
});
