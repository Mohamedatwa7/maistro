// Phase 6.5 — Storyboard: shot list from the approved brief, code checks, one keyframe per shot attached to the
// version through the job service, vision checks anchored to the mood tiles and the previous shot, F1X8 on the hook,
// per-shot review, only rejected shots regenerate, stage approval needs every shot approved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, loadPage, HERMES_ENV, hermesFake } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const BD = require('../../api/_studio/board.js');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'k', CRON_SECRET: 'cron', F1X8_API_KEY: 'f', ...HERMES_ENV };
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
const DIRECTION = { setting: 'terrace', lighting: 'warm rim light', mood: 'calm', styling: 'matte', wardrobe: 'linen', compositionStyle: 'negative space', cameraFeel: '50 mm', trendAdaptation: 'x', leadingPrinciple: 'Boldly lead', palette: [{ name: 'Samsung Blue', hex: '#1428A0', role: 'dominant' }], tiles: [1, 2, 3, 4].map((i) => ({ tag: `t${i}`, demonstrates: 'd', prompt: 'p' })) };
const SPEC = { objective: 'o', successMetric: 'm', audience: { description: 'a', markets: ['UAE'] }, trendHook: { mechanic: 'setup, pause, deadpan reveal', samsungAdaptation: 's' }, keyMessage: 'Small enough to disappear, bold enough to turn heads.', products: [{ name: 'Galaxy Z Flip8', features: ['FlexWindow'] }], claims: [], cta: 'Flip the script', tone: 't', format: { platform: 'tiktok', format: 'f', aspectRatio: '9:16', targetDurationS: 15 }, languagePlan: { onScreenText: 'x', voiceoverOrCaptions: 'y', register: 'gulf_arabic', rationale: 'r' }, audio: { direction: 'd', musicReference: '', licensing: 'none' }, mandatories: ['Hero product', 'Samsung logo end-frame', 'Cleared audio only'], doNots: ['x'], hashtags: { en: ['a'], ar: ['ب'] }, caption: { en: 'c', ar: 'ج' }, deadline: '30 Oct 2026' };
const SHOTS = {
  shots: [
    { n: 1, durationS: 2, type: 'close_up', camera: 'low angle, slow push-in', action: 'A hand pauses over the closed Flip on the terrace table', product: { visible: true, feature: 'FlexWindow' }, onScreenText: { en: 'Small enough to disappear', ar: 'صغير لدرجة يختفي' }, line: { en: '', ar: '' }, audioCue: 'silence', transition: 'cut' },
    { n: 2, durationS: 4, type: 'medium', camera: 'eye level, static', action: 'The caption reveal beat: deadpan look, the Flip opens', product: { visible: true, feature: 'FlexWindow cover screen' }, onScreenText: { en: 'bold enough to turn heads', ar: 'وجريء لدرجة يلفت الأنظار' }, line: { en: 'Setup. Pause.', ar: 'يلا.' }, audioCue: 'dry sting', transition: 'match_cut' },
    { n: 3, durationS: 5, type: 'wide', camera: 'orbit, slow', action: 'Golden hour terrace, the device half open on the table', product: { visible: true, feature: 'FlexWindow' }, onScreenText: { en: '', ar: '' }, line: { en: 'Flip the script', ar: 'اقلب الموضوع' }, audioCue: 'ambient', transition: 'dissolve' },
    { n: 4, durationS: 4, type: 'end_card', camera: 'static', action: 'Samsung logo end card, Samsung Blue, CTA: Flip the script — link in bio', product: { visible: false, feature: '' }, onScreenText: { en: 'Flip the script', ar: 'اقلب الموضوع' }, line: { en: '', ar: '' }, audioCue: 'sting tail', transition: 'none' },
  ], hookShot: 1, notes: 'The reveal beat lands on shot 2.',
};
const MCHECK = { followsTrendMechanic: 'yes', missingBeats: [], hookStrength: 'ok', hookNotes: 'fine', risks: [] };
const VCHECK = (i) => ({ images: [{ index: i, productPresent: 'yes', productMatchesCatalog: 'yes', competitorOrLogo: 'no', realPerson: 'no', textInImage: 'no', prohibitedImagery: 'no', paletteMatch: 'yes', lightingMatch: 'yes', culturalOk: 'yes', consistentWithMood: 'yes', textSpaceClear: 'n/a', notes: 'ok' }] });

test('validateShape and codeChecks: 3–8 numbered shots; duration within ±10 % of the brief, hook in the first 3 s, every brief feature shown, key message and CTA carried, end card last', () => {
  assert.deepEqual(BD.validateShape(SHOTS), []);
  assert.ok(BD.validateShape({ ...SHOTS, shots: SHOTS.shots.slice(0, 2) }).some((p) => /between/.test(p)));
  assert.ok(BD.validateShape({ ...SHOTS, shots: SHOTS.shots.map((s, i) => ({ ...s, n: i + 2 })) }).some((p) => /\.n: must be/.test(p)));
  assert.ok(BD.validateShape({ ...SHOTS, shots: [{ ...SHOTS.shots[0], action: 'An iPhone on a desk' }, ...SHOTS.shots.slice(1)] }).some((p) => /competitor/.test(p)));
  const ok = BD.codeChecks(SHOTS, { spec: SPEC }); assert.ok(ok.every((c) => c.passed), JSON.stringify(ok.filter((c) => !c.passed)));
  const bad = BD.codeChecks({ ...SHOTS, hookShot: 3, shots: [{ ...SHOTS.shots[0], durationS: 6, product: { visible: true, feature: 'camera' } }, { ...SHOTS.shots[1], onScreenText: { en: '', ar: '' }, line: { en: '', ar: '' }, product: { visible: true, feature: 'hinge' } }, { ...SHOTS.shots[2], line: { en: '', ar: '' }, product: { visible: false, feature: '' } }, { ...SHOTS.shots[3], type: 'wide', onScreenText: { en: '', ar: '' }, action: 'fade' }] }, { spec: SPEC });
  assert.deepEqual(bad.filter((c) => !c.passed).map((c) => c.code), ['duration_matches_brief', 'hook_in_first_seconds', 'features_covered', 'key_message_present', 'cta_at_end', 'end_card']);
  const kp = BD.keyframePrompt(SHOTS.shots[0], DIRECTION, '2026 clamshell flip foldable', false);
  assert.match(kp, /^close up shot, low angle, slow push-in\. A hand pauses/); assert.match(kp, /exactly: 2026 clamshell flip foldable, showing FlexWindow/); assert.match(kp, /Samsung Blue #1428A0/); assert.match(kp, /no text, no logos/);
  assert.match(BD.keyframePrompt(SHOTS.shots[0], DIRECTION, 'x', true), /exact product from the reference image/);
  assert.match(BD.keyframePrompt(SHOTS.shots[3], DIRECTION, 'x', false), /end-card frame/);
  assert.deepEqual(BD.checkFlags({ ...MCHECK, followsTrendMechanic: 'partial', missingBeats: ['pause'], hookStrength: 'weak', risks: ['r1'] }), ['trend mechanic partly missing: pause', 'weak hook: fine', 'risk: r1']);
});

test('POST /api/studio action board: needs the brief; shot list version with checks; one keyframe job per shot with attachTo; completed renders fill the shot slots (no new version), queue vision checks anchored to the mood tiles + the previous keyframe and F1X8 on the hook; per-shot review; only the rejected shot regenerates; the stage approval needs every shot approved', async () => {
  const pg = fakePostgrest();
  const H = hermesFake(); const hf = H.state;
  const visionBodies = [];
  const f = mockFetch([
    ['api.anthropic.com', (u, init) => { const b = JSON.parse(init.body); if (/review a storyboard shot list/.test(b.system)) return json({ content: [{ type: 'text', text: JSON.stringify(MCHECK) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); if (/check generated campaign images/.test(b.system)) { visionBodies.push(b); const idx = Number((b.messages[0].content.map((c) => c.text || '').join(' ').match(/IMAGE (\d+):/) || [])[1]); return json({ content: [{ type: 'text', text: JSON.stringify(VCHECK(idx)) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); } return json({ content: [{ type: 'text', text: JSON.stringify(SHOTS) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); }],
    ...H.routes,
    [(u, init) => /\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'GET', () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
    [/d3u0tzju9qaucj\.cloudfront\.net\/k\d\.png$/, () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t` })],
    [/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV); const decisions = api('decisions.js', ENV);
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-bd1', stage: 'plan', artifact: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', platforms: ['tiktok'], markets: ['UAE'] } } }), r);
    r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-bd1', stage: 'mood', artifact: { imageUrl: 'https://cdn/m0.png', images: [0, 1, 2, 3].map((i) => ({ url: `https://cdn/m${i}.png`, assetPath: `pieces/gen-bd1/mood/m${i}.png`, tag: `variation ${i + 1}` })), direction: DIRECTION, prompt: 'p', note: 'n' } } }), r);
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-bd1', stage: 'mood', decision: 'approved', name: 'N', role: 'reviewer', details: { selectedImages: [2], annotations: 'keep the rim light' } } }), r); assert.equal(r.statusCode, 200);
    r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-bd1', stage: 'brief', artifact: { objective: 'o', msg: SPEC.keyMessage, markets: ['UAE'], platforms: ['tiktok'], mandatories: SPEC.mandatories, deadline: '30 Oct 2026', spec: SPEC } } }), r);
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-bd1', stage: 'brief', decision: 'approved', name: 'N', role: 'reviewer' } }), r); assert.equal(r.statusCode, 200);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'board', pieceId: 'gen-bd1', userInput: 'keep it dry', refImage: 'https://sb.test/storage/v1/object/public/refs/products/flip.jpg' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.version, 1); assert.equal(r.body.briefApproved, true); assert.equal(r.body.moodApproved, true);
    assert.equal(r.body.artifact.shots.length, 4); assert.equal(r.body.artifact.totalS, 15); assert.equal(r.body.artifact.aspect, '9:16'); assert.equal(r.body.artifact.shots[0].keyframe, null);
    assert.equal(r.body.checks.passed, true); assert.ok(r.body.checks.codeChecks.every((c) => c.passed)); assert.equal(r.body.checks.mechanic.hookStrength, 'ok');
    assert.equal(r.body.jobs.length, 4); assert.ok(r.body.jobs.every((j) => j.state === 'running'), JSON.stringify(r.body.jobs.map((j) => [j.state, j.error])));
    const sc = pg.tables.stage_checks.at(-1); assert.equal(sc.kind, 'spec'); assert.equal(sc.passed, true);
    const kjobs = pg.tables.jobs.filter((j) => j.kind === 'hermes_image' && j.payload.stage === 'board');
    assert.equal(kjobs.length, 4); assert.deepEqual(kjobs.map((j) => j.payload.attachTo.shot), [1, 2, 3, 4]); assert.ok(kjobs.every((j) => j.payload.attachTo.versionId === r.body.versionId));
    assert.deepEqual(kjobs[0].payload.meta.anchors.map((a) => a.index), [2], 'only the selected mood tile anchors the keyframes'); assert.equal(kjobs[0].payload.meta.hookCheck, true); assert.equal(kjobs[3].payload.meta.hookCheck, false);
    assert.equal(kjobs[0].payload.ref, 'https://sb.test/storage/v1/object/public/refs/products/flip.jpg', 'product visible → reference path'); assert.equal(kjobs[3].payload.ref, undefined, 'end card: no product, no reference'); assert.equal(kjobs[3].payload.meta.expectProduct, false);
    assert.match(kjobs[1].payload.prompt, /^medium shot, eye level, static\. The caption reveal beat/);
    assert.ok(kjobs.every((j) => Number.isInteger(j.payload.seed) && j.payload.seed >= 1 && j.payload.seed <= 1000000), 'a seed per keyframe job'); assert.equal(JSON.parse(hf.runs[3].body.input).seed, kjobs[3].payload.seed, 'each keyframe run carries its seed'); assert.ok(hf.runs.every((x) => x.profile === 'storyboard'), 'the storyboard bot makes the keyframes'); assert.match(kjobs[1].payload.prompt, /exact product from the reference image, showing FlexWindow cover screen/);
    const stageRow = pg.tables.stages.find((s) => s.kind === 'board'); assert.equal(stageRow.state, 'generating');
    assert.ok(pg.tables.generation_records.some((g) => g.prompt_name === 'studio.storyboard' && g.status === 'succeeded'));
    // renders complete one by one: shot slots fill, the version number stays 1, checks queue with the previous keyframe as an anchor
    hf.status = 'completed'; for (const j of kjobs) j.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await jobs.handler(req({ method: 'GET', query: { id: kjobs[0].id } }), r);
    assert.equal(r.body.job.state, 'succeeded'); assert.equal(r.body.job.result.artifact, undefined, 'a keyframe never becomes a stage artifact'); assert.deepEqual(r.body.job.result.attached, { versionId: kjobs[0].payload.attachTo.versionId, shot: 1, slot: 'keyframe' });
    let v = pg.tables.artifact_versions.find((x) => x.id === kjobs[0].payload.attachTo.versionId);
    assert.equal(v.payload.shots[0].keyframe.state, 'rendered'); assert.ok(v.payload.shots[0].keyframe.assetPath); assert.equal(v.payload.shots[0].keyframe.seed, kjobs[0].payload.seed); assert.equal(v.payload.rev, 1); assert.ok(v.payload.shots[0].keyframe.sha256); assert.equal(v.payload.shots[1].keyframe, null);
    assert.equal(pg.tables.artifact_versions.filter((x) => x.stage_id === stageRow.id).length, 1, 'no new version per keyframe');
    assert.equal(pg.tables.stages.find((s) => s.kind === 'board').state, 'generating', 'three shots still rendering');
    const hook = pg.tables.jobs.find((j) => j.kind === 'f1x8_image'); assert.ok(hook, 'F1X8 queued on the hook keyframe'); assert.equal(hook.payload.hookCheck, true); assert.equal(hook.payload.assetPath, v.payload.shots[0].keyframe.assetPath);
    for (const j of kjobs.slice(1)) { r = res(); await jobs.handler(req({ method: 'GET', query: { id: j.id } }), r); assert.equal(r.body.job.state, 'succeeded'); }
    v = pg.tables.artifact_versions.find((x) => x.id === kjobs[0].payload.attachTo.versionId);
    assert.ok(v.payload.shots.every((s) => s.keyframe && s.keyframe.state === 'rendered'));
    assert.equal(pg.tables.stages.find((s) => s.kind === 'board').state, 'generated', 'all keyframes landed');
    const checks = pg.tables.jobs.filter((j) => j.kind === 'vision_check'); assert.equal(checks.length, 4);
    assert.deepEqual(checks[0].payload.anchors.map((a) => a.index), [2]); assert.deepEqual(checks[1].payload.anchors.map((a) => a.index), [2, 0]); assert.match(checks[1].payload.anchors[1].label, /previous shot 1 keyframe/); assert.equal(checks[1].payload.images[0].index, 2);
    // the tick runs the vision checks (the F1X8 job stays queued: its poll is mocked only at submit)
    r = res(); await jobs.handler(req({ headers: { authorization: 'Bearer cron' }, session: false }), r);
    const vrows = pg.tables.stage_checks.filter((c) => c.kind === 'vision'); assert.equal(vrows.length, 4); assert.ok(vrows.every((c) => c.passed));
    assert.match(visionBodies[1].messages[0].content.map((c) => c.text || '').join(' '), /ANCHOR \(previous shot 1 keyframe/);
    r = res(); await studio.handler(req({ method: 'GET', query: { board: 'gen-bd1' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.version, 1); assert.equal(r.body.state, 'generated'); assert.equal(r.body.payload.shots.length, 4); assert.equal(typeof r.body.live, 'number');
    // review: approve 1, 2, 4; reject 3 with a reason; the stage approval is refused until shot 3 is approved
    for (const n of [1, 2, 4]) { r = res(); await studio.handler(req({ method: 'POST', body: { action: 'board-shot-decide', pieceId: 'gen-bd1', shot: n, decision: 'approved', name: 'N' } }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); }
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'board-shot-decide', pieceId: 'gen-bd1', shot: 3, decision: 'rejected', name: 'N' } }), r); assert.equal(r.statusCode, 400, 'a reason is required');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'board-shot-decide', pieceId: 'gen-bd1', shot: 3, decision: 'rejected', reason: 'device too small', reasonCode: 'wrong_product', name: 'N' } }), r);
    assert.equal(r.statusCode, 200); assert.deepEqual(r.body.pending, [3]);
    const audits = pg.tables.audit_log || []; assert.ok(audits.some((a) => a.action === 'board.shot.rejected' && a.entity === 'artifact_version' && a.after.reason === 'device too small'), 'the shot decision is audit-logged with real columns');
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-bd1', stage: 'board', decision: 'approved', name: 'N', role: 'reviewer' } }), r);
    assert.equal(r.statusCode, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'shots_pending');
    // only shot 3 regenerates; its previous keyframe goes to history; the stage returns to generating then generated
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'board-shot', pieceId: 'gen-bd1', shot: 3, changes: 'device bigger in frame', refImage: 'https://sb.test/storage/v1/object/public/refs/products/flip.jpg' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.job.state, 'running');
    const rj = pg.tables.jobs.find((j) => j.id === r.body.job.id); assert.match(rj.payload.prompt, /Changes requested by the reviewer .*device bigger in frame/); assert.equal(rj.payload.attachTo.shot, 3);
    assert.equal(pg.tables.jobs.filter((j) => j.kind === 'hermes_image' && j.payload.stage === 'board').length, 5, 'one new render, not four');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'board-shot', pieceId: 'gen-bd1', shot: 3 } }), r); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'busy');
    rj.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await jobs.handler(req({ method: 'GET', query: { id: rj.id } }), r); assert.equal(r.body.job.state, 'succeeded');
    v = pg.tables.artifact_versions.find((x) => x.id === kjobs[0].payload.attachTo.versionId);
    assert.equal(v.payload.shots[2].keyframe.jobId, rj.id); assert.equal(v.payload.shots[2].keyframeHistory.length, 1); assert.equal(v.payload.shots[2].review, null, 'a new keyframe clears the review');
    assert.equal(v.payload.shots[0].review.decision, 'approved', 'other shots keep their reviews');
    assert.equal(pg.tables.stages.find((s) => s.kind === 'board').state, 'generated');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'board-shot-decide', pieceId: 'gen-bd1', shot: 3, decision: 'approved', name: 'N' } }), r); assert.deepEqual(r.body.pending, []);
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-bd1', stage: 'board', decision: 'approved', name: 'N', role: 'reviewer' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'board-shot', pieceId: 'gen-bd1', shot: 1 } }), r); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'approved_immutable');
    // a failed keyframe marks its shot and never bounces the stage to ready
    const spec = pg.tables.creative_specs.at(-1).spec; assert.equal(spec.stages.board.approved.version, 1);
  } finally { f.restore(); studio.restore(); jobs.restore(); pieces.restore(); decisions.restore(); }
});

test('page: rBoard renders every shot with its keyframe state, check and review badges, the hook score, and per-shot actions; the stage approval is blocked while a shot is pending', async () => {
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('/api/studio?checks=') ? json({ count: 2, checks: [{ stage: 'board', kind: 'spec', passed: false, results: { passed: false, codeChecks: [{ code: 'cta_at_end', passed: false, detail: 'CTA missing' }], flags: ['cta_at_end: CTA missing', 'weak hook: slow'] } }, { stage: 'board', kind: 'vision', passed: true, results: { images: [{ index: 1, pass: true, needsReview: false, flags: [] }] } }] }) : new Promise(() => {})) });
  try {
    const shots = SHOTS.shots.map((s) => ({ ...s, keyframe: null, review: null }));
    shots[0].keyframe = { state: 'rendered', url: 'https://cdn/k1.png', assetPath: 'pieces/gen-x/board/k1.png' }; shots[0].review = { decision: 'approved', by: 'N' };
    shots[1].keyframe = { state: 'failed', error: 'moderated' };
    const p = { id: 'gen-x', generated: true, studio: true, stage: 4, title: 'T', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'Galaxy Z Flip8', msg: 'm', angle: 'a' }, mood: { imageUrl: 'https://cdn/m.png' }, brief: { objective: 'o', msg: 'k', markets: ['UAE'], platforms: ['tiktok'], mandatories: [] },
      board: { shots, hookShot: 1, totalS: 15, aspect: '9:16', version: 'v1', briefApproved: true, hook: { score: 6.4, summary: 'decent hook', risks: [] } } };
    X.PROJECTS.unshift(p);
    let html = X.stageArtifact(p, 4);
    assert.match(html, /STORYBOARD v1 · 4 SHOTS · 15 s/); assert.match(html, /HOOK · F1X8 6\.4\/10/); assert.match(html, /1\/4 SHOTS APPROVED/);
    assert.match(html, /data-asset="pieces\/gen-x\/board\/k1\.png"/); assert.match(html, /SHOT 1 · 2 s/); assert.match(html, /Render failed — moderated/); assert.match(html, /Rendering keyframe…/);
    assert.match(html, /PRODUCT · FlexWindow/); assert.match(html, /<span dir="rtl">صغير لدرجة يختفي<\/span>/); assert.match(html, /APPROVED/); assert.match(html, /Reject<\/button>/); assert.match(html, /↻ Regenerate/);
    await new Promise((r) => setTimeout(r, 20)); html = X.stageArtifact(p, 4);
    assert.match(html, /SHOT LIST NEEDS A LOOK/); assert.match(html, /✗ CTA AT END/); assert.match(html, /weak hook: slow/); assert.match(html, /CHECK OK/);
    assert.ok(X.BOARD_POLL['gen-x:board'], 'pending keyframes start the poll'); clearTimeout(X.BOARD_POLL['gen-x:board']);
  } finally { X.restore(); }
});

test('updateShots: two writers that read the same revision both land (the loser re-reads and re-applies); a recorded seed rides every keyframe job and reaches SOUL V2', async () => {
  const pg = fakePostgrest();
  const hf = { bodies: [] };
  const f = mockFetch([
    [/\/higgsfield-ai\/soul\/v2\/standard$/, (u, init) => { hf.bodies.push(JSON.parse(init.body)); return json({ status: 'queued', request_id: `req00009${hf.bodies.length}`, status_url: 'x', cancel_url: 'y' }); }],
    pg.route,
  ]);
  const jobsMod = require('../../api/_jobs.js');
  const saved = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_SERVICE_ROLE_KEY, h: process.env.HF_CREDENTIALS };
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'; process.env.HF_CREDENTIALS = 'id:secret';
  try {
    pg.tables.artifact_versions = [{ id: 'v-race', payload: { shots: [{ n: 1, keyframe: null }, { n: 2, keyframe: null }], rev: 0 } }];
    // both writers read rev 0 before either writes
    const slow = (n) => jobsMod.updateShots('v-race', (payload) => { const shots = payload.shots.map((s) => ({ ...s })); shots[n - 1] = { ...shots[n - 1], keyframe: { state: 'rendered', jobId: `j${n}` } }; return { ...payload, shots }; });
    const [a, b] = await Promise.all([slow(1), slow(2)]);
    const final = pg.tables.artifact_versions[0].payload;
    assert.equal(final.shots[0].keyframe.jobId, 'j1'); assert.equal(final.shots[1].keyframe.jobId, 'j2'); assert.equal(final.rev, 2); assert.deepEqual([a.rev, b.rev].sort(), [1, 2]);
    const r = await jobsMod.updateShots('v-race', () => null); assert.equal(r.unchanged, true); assert.equal(pg.tables.artifact_versions[0].payload.rev, 2, 'an aborted mutate writes nothing');
    // a seed on the job reaches the SOUL V2 body (v1 has no documented seed)
    const hg = require('../../api/_adapters/higgsfield.js');
    await hg.submit({ kind: 'image', prompt: 'p', aspect_ratio: '9:16', resolution: '1080p', seed: 4242 }, { idempotencyKey: 'k1' });
    assert.equal(hf.bodies[0].seed, 4242);
    await hg.submit({ kind: 'image', prompt: 'p', aspect_ratio: '9:16', resolution: '1080p', seed: 0 }, { idempotencyKey: 'k2' });
    assert.equal(hf.bodies[1].seed, undefined, 'out-of-range seeds are dropped, not sent');
  } finally { f.restore(); for (const [k, v] of [['SUPABASE_URL', saved.u], ['SUPABASE_SERVICE_ROLE_KEY', saved.k], ['HF_CREDENTIALS', saved.h]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});
