// Phase 6.8 — Final: only the approved QC plan is applied, at each fix's unit; untouched shots keep their bytes;
// F1X8 re-run on the stored final cut and every original risk verified; per-shot diff; package only after the
// line-manager + ADLCP approval on that exact version.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { api, req, res, mockFetch, json, loadPage, HERMES_ENV, hermesFake } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const FM = require('../../api/_studio/final.js');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'k', CRON_SECRET: 'cron', ...HERMES_ENV };
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3, 4]);
const FINALCUT = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 7, 7, 7, 7]);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const shot = (n) => ({ n, durationS: 3, type: 'medium', camera: `cam ${n}`, action: `act ${n}`, product: { visible: true, feature: '' }, onScreenText: { en: n === 1 ? 'Hook' : '', ar: '' }, line: { en: '', ar: '' }, audioCue: 'x', transition: 'cut', keyframe: { assetPath: `pieces/gen-fn1/board/k${n}.png`, jobId: `kj${n}` }, clip: { state: 'rendered', assetPath: `pieces/gen-fn1/draft/c${n}.mp4`, sha256: `${n}`.repeat(64), jobId: `cj${n}` }, overlay: n === 1 ? { assetPath: 'pieces/gen-fn1/draft/overlay-1-a.png', sha256: 'd'.repeat(64) } : null, review: { decision: 'approved' } });
const REPORT = (draftVersionId, draftSha256) => ({ score: 5.8, summary: 's', draftVersionId, draftSha256, f1x8: { risks: [{ rank: 1, issue: 'small text' }, { rank: 2, issue: 'slow middle' }, { rank: 3, issue: 'no music' }] }, timeline: [{ n: 1, startS: 0, endS: 3 }, { n: 2, startS: 3, endS: 6 }, { n: 3, startS: 6, endS: 9 }], checklist: [], cost: { totalUsd: 1.6, items: [], unknownIds: [] }, coverage: { complete: true, uncovered: [] },
  fixes: [
    { id: 'fx1', ref: 'risk:1', shot: 1, element: 'overlay_text', fixType: 'overlay_edit', instruction: 'shorter', newText: { en: 'Flip it.', ar: 'اقلبها.' }, include: true },
    { id: 'fx2', ref: 'risk:2', shot: 2, element: 'visual', fixType: 'shot_regen', instruction: 'faster push-in', newText: null, include: true },
    { id: 'fx3', ref: 'risk:3', shot: 0, element: 'audio', fixType: 'audio_swap', instruction: 'add a bed', newText: null, include: true },
    { id: 'fx4', ref: 'risk:2', shot: 3, element: 'visual', fixType: 'shot_regen', instruction: 'dropped by the reviewer', newText: null, include: false },
  ] });

// a signed-in member (Phase 11 S2: final approval, budget raise and the package are member-only)
const asMember = (pg, role, name = `M. ${role}`) => { const path = require('node:path'); const { makeSessionCookieValue, SESSION_COOKIE } = require(path.join(__dirname, '..', '..', 'api', '_auth.js')); const m = { id: `u-${role}`, email: `${role}@samsung.com`, role, name, active: true }; if (!(pg.tables.members || []).some((x) => x.id === m.id)) (pg.tables.members = pg.tables.members || []).push(m); return { headers: { cookie: `${SESSION_COOKIE}=${makeSessionCookieValue('test-session', Date.now(), undefined, m)}` }, session: false }; };

test('applyPlan and diffShots: text edits change the shot and mark its overlay stale; one re-render per named shot; audio swaps and shot-list changes are reported, not applied; excluded fixes are ignored; untouched shots keep their exact clip and overlay', () => {
  const draft = { shots: [shot(1), shot(2), shot(3)] };
  const ap = FM.applyPlan(draft, REPORT('v', 'x'));
  assert.deepEqual(ap.regenShots, [2]); assert.deepEqual(ap.applied.map((a) => a.id).sort(), ['fx1', 'fx2']); assert.deepEqual(ap.notApplied.map((a) => [a.id, a.fixType]), [['fx3', 'audio_swap']]);
  assert.deepEqual(ap.shots[0].onScreenText, { en: 'Flip it.', ar: 'اقلبها.' }); assert.equal(ap.shots[0].overlay, null); assert.equal(ap.shots[0].overlayStale, true);
  assert.deepEqual(ap.shots[1].clip, { state: 'pending' }); assert.equal(ap.shots[1].clipHistory[0].sha256, '2'.repeat(64)); assert.equal(ap.shots[1].review, null); assert.match(ap.shots[1].regenInstruction, /faster push-in/);
  assert.strictEqual(ap.shots[2].clip, draft.shots[2].clip, 'shot 3 keeps the same clip object (fx4 was excluded)'); assert.equal(ap.shots[2].review.decision, 'approved');
  const finalShots = ap.shots.map((s) => (s.n === 2 ? { ...s, clip: { state: 'rendered', assetPath: 'pieces/gen-fn1/final/c2b.mp4', sha256: 'e'.repeat(64) } } : s));
  const d = FM.diffShots(draft.shots, finalShots);
  assert.deepEqual(d.map((x) => x.status), ['text_changed', 'clip_regenerated', 'unchanged']); assert.deepEqual(d[0].textChanges, ['onScreenText']); assert.equal(d[2].clipSame, true);
  const sl = FM.applyPlan(draft, { fixes: [{ id: 'a', ref: 'risk:9', shot: 2, element: 'pacing', fixType: 'shotlist_change', instruction: 'x', include: true }] });
  assert.match(sl.notApplied[0].reason, /storyboard/); assert.deepEqual(sl.regenShots, []);
});

test('POST /api/studio final → re-render only shot 2 → overlays for shot 1 → verify on the stored final cut (every original risk answered) → package refused until the final is approved with both documents, then a hashed manifest', async () => {
  const pg = fakePostgrest();
  const H = hermesFake({ status: 'completed' }); const hf = H.state; const puts = [];
  const f = mockFetch([
    ...H.routes,
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t` })],
    [(u, init) => /\/object\/sign\/assets\/pieces\/gen-fn1\/final\/cut\.mp4/.test(u) && (init.method || 'GET') === 'GET', () => new Response(FINALCUT, { status: 200, headers: { 'content-type': 'video/mp4' } })],
    [(u, init) => /\/storage\/v1\/object\/assets\//.test(u) && init.method === 'POST', (u, init) => { puts.push({ p: decodeURIComponent(String(u).split('/object/assets/')[1]), body: init.body }); return json({ Key: 'ok' }); }],
    ['/api/analyze/video/submit', () => json({ job_id: 'fx-fin-1' })],
    ['/api/job/fx-fin-1', () => json({ status: 'done', result: { score: 7.4, verdict: { summary: 'better', risks: [{ rank: 1, issue: 'no music bed' }] } } })],
    ['api.anthropic.com', () => json({ content: [{ type: 'text', text: JSON.stringify({ risks: [{ ref: 'risk:1', resolved: 'yes', evidence: 'text no longer flagged' }, { ref: 'risk:2', resolved: 'yes', evidence: 'pacing not flagged' }] }) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV); const decisions = api('decisions.js', ENV);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-fn1', stage: 'plan', artifact: { title: 'Fin', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'Fin', product: 'Galaxy Z Flip8', msg: 'm', platforms: ['tiktok'], markets: ['UAE'] } } }), r);
    const store = require('../../api/_store.js');
    const DSHA = 'c'.repeat(64);
    const dv = await store.recordVersion('gen-fn1', 'draft', { shots: [shot(1), shot(2), shot(3)], aspect: '9:16', resolution: '720p', totalS: 9, assembled: { assetPath: 'pieces/gen-fn1/draft/cut.mp4', sha256: DSHA, transitions: ['cut', 'cut', 'cut'] }, assetPath: 'pieces/gen-fn1/draft/cut.mp4', sha256: DSHA, rev: 0 }, { producedBy: 'higgsfield_seedance', kind: 'video' });
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'final', pieceId: 'gen-fn1' } }), r); assert.equal(r.statusCode, 409, 'no approved QC'); assert.equal(r.body.code, 'prerequisites');
    await store.recordVersion('gen-fn1', 'qc', { real: true, report: REPORT(dv.versionId, DSHA) }, { producedBy: 'f1x8', kind: 'qc_report' });
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-fn1', stage: 'qc', decision: 'approved', name: 'N', role: 'reviewer' } }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'final', pieceId: 'gen-fn1' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.regenShots, [2]); assert.deepEqual(r.body.overlaysToRedraw, [1]); assert.equal(r.body.reusedDraftCut, false); assert.equal(r.body.notApplied[0].fixType, 'audio_swap');
    assert.equal(hf.runs.length, 1, 'exactly one re-render'); assert.equal(hf.runs[0].profile, 'video'); assert.match(hf.runs[0].body.input, /Fix requested by QC .*faster push-in/); assert.ok(!/dropped by the reviewer/.test(hf.runs[0].body.input));
    const fvId = r.body.versionId; let fv = () => pg.tables.artifact_versions.find((v) => v.id === fvId);
    assert.equal(fv().payload.fromDraftVersionId, dv.versionId); assert.equal(fv().payload.assembled, null);
    assert.deepEqual(fv().payload.shots[2].clip, shot(3).clip, 'shot 3 untouched: same asset, same sha256');
    // the clip lands; assembly refuses while shot 1's overlay is stale and shot 2 is unreviewed
    const fj = pg.tables.jobs.find((j) => j.kind === 'hermes_video' && j.payload.stage === 'final'); fj.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await jobs.handler(req({ method: 'GET', query: { id: fj.id } }), r); assert.equal(r.body.job.state, 'succeeded', JSON.stringify(r.body.job));
    assert.equal(fv().payload.shots[1].clip.state, 'rendered'); assert.equal(pg.tables.stages.find((s) => s.kind === 'final').state, 'generated');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft-assemble', stage: 'final', pieceId: 'gen-fn1' } }), r); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'overlays_stale');
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString('base64');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft-overlays', stage: 'final', pieceId: 'gen-fn1', overlays: [{ shot: 1, data: PNG }] } }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.match(r.body.stored[0].assetPath, /^pieces\/gen-fn1\/final\/overlay-1-/);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft-assemble', stage: 'final', pieceId: 'gen-fn1' } }), r); assert.equal(r.statusCode, 409); assert.deepEqual(r.body.pending, [2]);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'shot-decide', stage: 'final', pieceId: 'gen-fn1', shot: 2, decision: 'approved', name: 'N' } }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft-assemble', stage: 'final', pieceId: 'gen-fn1' } }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const aj = pg.tables.jobs.find((j) => j.kind === 'assemble'); assert.equal(aj.payload.stage, 'final'); assert.equal(aj.payload.versionId, fvId);
    // (the assembly itself is covered by assemble-flow.test.js) — simulate its result on the version, then verify
    aj.state = 'succeeded';
    const FSHA = sha(FINALCUT);
    await require('../../api/_jobs.js').updateShots(fvId, (p) => ({ ...p, assembled: { assetPath: 'pieces/gen-fn1/final/cut.mp4', sha256: FSHA, durationS: 9, width: 720, height: 1280, fps: 30 }, assetPath: 'pieces/gen-fn1/final/cut.mp4', sha256: FSHA }));
    r = res(); await studio.handler(req({ method: 'GET', query: { shots: 'gen-fn1', stage: 'final' } }), r);
    assert.deepEqual(r.body.diff.map((d) => d.status), ['text_changed', 'clip_regenerated', 'unchanged']);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'final-verify', pieceId: 'gen-fn1' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.job.state, 'running', JSON.stringify(r.body.job));
    const vj = pg.tables.jobs.find((j) => j.kind === 'f1x8_video' && j.payload.verifyFinal); assert.equal(vj.payload.expectSha256, FSHA); vj.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await jobs.handler(req({ headers: { authorization: 'Bearer cron' }, session: false }), r);
    const ver = fv().payload.verification; assert.ok(ver, 'verification stored on the final version');
    assert.equal(ver.score, 7.4); assert.equal(ver.scoreBefore, 5.8); assert.equal(ver.cutSha256, FSHA);
    assert.deepEqual(ver.risks.map((x) => [x.ref, x.resolved]), [['risk:1', 'yes'], ['risk:2', 'yes'], ['risk:3', 'no']], 'a risk the verifier skipped is reported unresolved');
    assert.deepEqual(ver.unresolved, ['risk:3']); assert.equal(ver.notApplied[0].fixType, 'audio_swap');
    // package: refused before the approval; the approval needs both documents on this version
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'final-package', pieceId: 'gen-fn1' } }), r); assert.equal(r.statusCode, 403, 'the package is member-only'); assert.equal(r.body.code, 'member_required');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'final-package', pieceId: 'gen-fn1' }, ...asMember(pg, 'line_manager', 'LM') }), r); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'prerequisites');
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-fn1', stage: 'final', decision: 'approved', name: 'LM' }, ...asMember(pg, 'line_manager', 'LM') }), r); assert.equal(r.statusCode, 409, 'documents required');
    const doc = (k) => ({ path: `documents/2026/${k === 'adlcp' ? 'adlcp' : 'lmanager'}-abc123.pdf`, sha256: (k === 'adlcp' ? 'a' : 'b').repeat(64), size: 10, contentType: 'application/pdf' });
    r = res(); await decisions.handler(req({ method: 'POST', ...asMember(pg, 'line_manager', 'LM'), body: { pieceId: 'gen-fn1', stage: 'final', decision: 'approved', name: 'LM', documents: { line_manager: doc('lm'), adlcp: doc('adlcp') } } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(pg.tables.adlcp_documents.filter((d) => d.artifact_version_id === fvId).length, 2, 'both documents linked to this exact version');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'final-package', pieceId: 'gen-fn1' }, ...asMember(pg, 'line_manager', 'LM') }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const m = r.body.manifest; assert.equal(m.final.versionId, fvId); assert.equal(m.final.video.sha256, FSHA); assert.equal(m.scores.f1x8Draft, 5.8); assert.equal(m.scores.f1x8Final, 7.4); assert.equal(m.scores.risksResolved, '2/3'); assert.equal(m.adlcp.length, 2);
    assert.match(r.body.assetPath, /^pieces\/gen-fn1\/final\/package-v1-/); assert.match(r.body.urls.manifest, /token=/);
    const stored = puts.find((x) => x.p === r.body.assetPath); assert.equal(crypto.createHash('sha256').update(Buffer.from(stored.body)).digest('hex'), r.body.sha256);
    // any change after the ADLCP approval is refused (approved is immutable)
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'final', pieceId: 'gen-fn1' } }), r); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'approved_immutable');
  } finally { f.restore(); studio.restore(); jobs.restore(); pieces.restore(); decisions.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('page: rFinal shows what was applied and not, the per-shot diff, the risk verification and the shot grid', async () => {
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('/api/studio?shots=') ? json({ version: 1, diff: [{ n: 1, status: 'text_changed', textChanges: ['onScreenText'], before: { onScreenText: { en: 'Hook' } }, after: { onScreenText: { en: 'Flip it.', ar: 'اقلبها.' } } }, { n: 2, status: 'clip_regenerated', textChanges: [], before: {}, after: {}, finalClip: { sha256: 'e'.repeat(64) } }, { n: 3, status: 'unchanged', textChanges: [], before: {}, after: {} }] }) : new Promise(() => {})) });
  try {
    const shots = [1, 2, 3].map((n) => ({ n, durationS: 3, type: 'medium', camera: 'c', action: 'a', product: { visible: true }, onScreenText: { en: '', ar: '' }, line: { en: '', ar: '' }, audioCue: 'x', transition: 'cut', clip: { state: 'rendered', assetPath: `pieces/g/final/c${n}.mp4` }, review: { decision: 'approved' } }));
    const p = { id: 'gen-fx', generated: true, studio: true, stage: 7, title: 'T', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'p', msg: 'm', angle: 'a' },
      final: { shots, fromDraftVersion: 2, applied: [{ id: 'fx1' }, { id: 'fx2' }], notApplied: [{ ref: 'risk:3', fixType: 'audio_swap', reason: 'no licensed audio library' }], assembled: { assetPath: 'pieces/g/final/cut.mp4' }, aspect: '9:16', resolution: '720p', version: 'v1', totalS: 9, verification: { score: 7.4, scoreBefore: 5.8, risks: [{ ref: 'risk:1', resolved: 'yes', evidence: 'ok' }, { ref: 'risk:3', resolved: 'no', evidence: 'not applied' }], unresolved: ['risk:3'] } } };
    X.PROJECTS.unshift(p);
    await new Promise((r) => setTimeout(r, 0)); X.stageArtifact(p, 7); await new Promise((r) => setTimeout(r, 20));
    const html = X.stageArtifact(p, 7);
    assert.match(html, /FROM DRAFT v2 · 2 FIX\(ES\) APPLIED/); assert.match(html, /1 NOT APPLIED/); assert.match(html, /risk:3<\/b> audio swap not applied — no licensed audio library/);
    assert.match(html, /F1X8 5\.8 → 7\.4 · 1\/2 RISKS RESOLVED/); assert.match(html, /UNCHANGED · SAME BYTES/); assert.match(html, /CLIP RE-RENDERED/); assert.match(html, /“Hook” → “<b style="color:#fff">Flip it\.<\/b>”/); assert.match(html, /risk:3 · NO/);
    assert.match(html, /FINAL v1 · 3 CLIPS/); assert.match(html, /shotRegenForm\('gen-fx',1,'final'\)/);
  } finally { X.restore(); }
});
