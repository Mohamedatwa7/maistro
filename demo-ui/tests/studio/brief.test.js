// Phase 6.4 — Brief: structured contract from the approved moodboard/thumbnail, code checks, model copy check, human edits as new versions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, loadPage, HERMES_ENV, hermesFake } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const B = require('../../api/_studio/brief.js');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'k', CRON_SECRET: 'cron', ...HERMES_ENV };
const DIRECTION = { setting: 'terrace', lighting: 'warm rim light', mood: 'calm', styling: 'matte', wardrobe: 'linen', compositionStyle: 'negative space', cameraFeel: '50 mm', trendAdaptation: 'x', leadingPrinciple: 'Boldly lead', palette: [{ name: 'Samsung Blue', hex: '#1428A0', role: 'dominant' }], tiles: [{ tag: 'a', demonstrates: 'a', prompt: 'a' }, { tag: 'b', demonstrates: 'b', prompt: 'b' }, { tag: 'c', demonstrates: 'c', prompt: 'c' }, { tag: 'd', demonstrates: 'd', prompt: 'd' }] };
const fmtDate = (d) => `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const DEADLINE = fmtDate(new Date(Date.now() + 7 * 864e5));
const BRIEF = {
  objective: 'Own the deadpan-reveal beat for Flip8 in the UAE this week.', successMetric: '≥ 8 % engagement rate and 30 % 3-second hold',
  audience: { description: 'Gulf 18–30 TikTok natives who share dry humour', markets: ['UAE'] },
  trendHook: { mechanic: 'setup line, pause, deadpan caption reveal', samsungAdaptation: 'the reveal lands on the FlexWindow cover screen' },
  storyline: { logline: 'A deadpan friend keeps her cool while the group panics over a missed message — until the FlexWindow saves the day.', protagonist: 'a woman in her twenties, modest neutral linen abaya, calm expression', openingScene: 'The group chat explodes; everyone panics except her.', beats: ['She flips the phone closed and reads the reply on the cover screen.', 'A deadpan pause.'], closingScene: 'She shows the FlexWindow to the group; they burst out laughing.' },
  keyMessage: 'Small enough to disappear, bold enough to turn heads.',
  products: [{ name: 'Galaxy Z Flip8', features: ['FlexWindow'] }], claims: [],
  cta: 'Flip the script — link in bio', tone: 'dry, warm, premium',
  format: { platform: 'tiktok', format: 'TikTok in-feed video', aspectRatio: '9:16', targetDurationS: 15 },
  languagePlan: { onScreenText: 'Gulf Arabic', voiceoverOrCaptions: 'captions in Gulf Arabic, English hashtags', register: 'gulf_arabic', rationale: 'UAE youth audience' },
  audio: { direction: 'silence then one dry sting', musicReference: '', licensing: 'none' },
  mandatories: ['Hero product on screen within 2 s', 'Samsung logo end-frame', 'Cleared audio only', 'Caption in Gulf Arabic'], doNots: ['No competitor devices', 'No text inside generated frames'],
  hashtags: { en: ['GalaxyZFlip8', 'SamsungGulf', 'DeadpanReveal'], ar: ['جالكسي_زد_فليب8', 'سامسونج_الخليج'] },
  caption: { en: 'Setup. Pause. Flip.', ar: 'يلا شوف الـفليب' }, deadline: DEADLINE,
};
const CHECK = { arabicFluency: 'native', arabicIssues: [], consistentWithMood: 'yes', moodNotes: 'warm, calm', followsTrendMechanic: 'yes', trendNotes: 'reveal beat kept' };

test('validateShape and codeChecks: every field required; unmapped claims, duration outside the sweet spot, too many hashtags, an unlicensed track, missing Arabic and missing mandatories fail in code', () => {
  assert.deepEqual(B.validateShape(BRIEF), []);
  assert.ok(B.validateShape({ ...BRIEF, caption: undefined }).some((p) => /caption/.test(p)));
  assert.ok(B.validateShape({ ...BRIEF, deadline: 'soon' }).some((p) => /deadline/.test(p)));
  assert.ok(B.validateShape({ ...BRIEF, mandatories: ['x'] }).some((p) => /mandatories/.test(p)));
  // the storyline: optional for briefs written before v2 (flagged in code), whole when given
  assert.deepEqual(B.validateShape({ ...BRIEF, storyline: undefined }), []);
  assert.deepEqual(B.validateShape({ ...BRIEF, storyline: { ...BRIEF.storyline, closingScene: '' } }), ['storyline.closingScene: required']);
  assert.match(B.SYSTEM, /STORYLINE: write the plot/); assert.ok(B.SCHEMA.required.includes('storyline'), 'the bot is asked for it');
  const ctx = { catalogNames: ['Galaxy Z Flip8'], approvedClaims: [], platformRules: B.platformRules('tiktok', []), markets: ['UAE'], now: Date.now() };
  const ok = B.codeChecks(BRIEF, ctx); assert.ok(ok.every((c) => c.passed), JSON.stringify(ok.filter((c) => !c.passed)));
  const bad = B.codeChecks({ ...BRIEF, claims: [{ claim: 'fastest chip', approvedWording: 'fastest chip', disclaimer: '' }], format: { ...BRIEF.format, targetDurationS: 45 }, hashtags: { en: ['a', 'b', 'c', 'd', 'e', 'f'], ar: [] }, audio: { direction: 'x', musicReference: 'Trend Sound', licensing: 'unknown' }, caption: { en: 'x', ar: '' }, mandatories: ['be nice', 'be bold', 'be brief'], products: [{ name: 'Galaxy Z Fold9', features: [] }] }, ctx);
  const failed = bad.filter((c) => !c.passed).map((c) => c.code);
  assert.deepEqual(failed, ['product_in_catalog', 'claims_approved', 'duration_sweet_spot', 'hashtag_limit', 'audio_licensed', 'arabic_copy_present', 'mandatories_complete']);
  const noStory = B.codeChecks({ ...BRIEF, storyline: undefined }, ctx).find((c) => c.code === 'storyline_complete');
  assert.equal(noStory.passed, false); assert.match(noStory.detail, /no storyline/);
  assert.match(ok.find((c) => c.code === 'storyline_complete').detail, /opening, 2 beat\(s\), closing/);
  const mapped = B.codeChecks({ ...BRIEF, claims: [{ claim: 'big screen', approvedWording: 'The largest FlexWindow yet', disclaimer: 'vs Flip7' }] }, { ...ctx, approvedClaims: [{ wording: 'The largest FlexWindow yet' }] });
  assert.equal(mapped.find((c) => c.code === 'claims_approved').passed, true);
  assert.deepEqual(B.platformRules('tiktok', [{ key: 'tiktok', content: { organic: { sweetSpotS: [10, 20], maxHashtags: 4, verified: true } } }]).sweetSpotS, [10, 20]);
  assert.deepEqual(B.copyFlags({ ...CHECK, arabicFluency: 'literal', consistentWithMood: 'partial' }), ['Arabic reads as a literal translation', 'only loosely follows the moodboard']);
});

test('POST /api/studio action brief: needs a moodboard; the Hermes brief bot gets Maistro\'s brief rules, the approved direction + thumbnail (no claims when none are approved) and the contract; its brief is validated, recorded (produced by hermes) and checked as a copy stage_check; brief-edit stores a manual version and re-checks (an added unapproved claim fails)', async () => {
  const pg = fakePostgrest(); const H = hermesFake({ brief: BRIEF });
  let briefCalls = 0, checkCalls = 0;
  const f = mockFetch([
    ['api.anthropic.com', (u, init) => { const b = JSON.parse(init.body); if (/review a Samsung Gulf social-content BRIEF/.test(b.system)) { checkCalls++; return json({ content: [{ type: 'text', text: JSON.stringify(CHECK) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); } briefCalls++; return json({ content: [{ type: 'text', text: JSON.stringify(BRIEF) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); }],
    ...H.routes,
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const pieces = api('pieces.js', ENV); const decisions = api('decisions.js', ENV); const jobs = api('jobs.js', ENV);
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-br1', stage: 'plan', artifact: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', platforms: ['tiktok'], markets: ['UAE'], trendId: 'snd-1', trendName: 'Deadpan caption reveal' } } }), r);
    r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-br1', stage: 'mood', artifact: { imageUrl: 'https://cdn/m0.png', images: [0, 1, 2, 3].map((i) => ({ url: `https://cdn/m${i}.png`, assetPath: `pieces/gen-br1/mood/m${i}.png`, tag: `variation ${i + 1}` })), direction: DIRECTION, prompt: 'p', note: 'n' } } }), r);
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-br1', stage: 'mood', decision: 'approved', name: 'N', role: 'reviewer', details: { selectedImages: [1], annotations: 'keep the rim light' } } }), r); assert.equal(r.statusCode, 200);
    r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-br1', stage: 'thumb', artifact: { imageUrl: 'https://cdn/c.png', overlay: { headline: 'Setup. Pause. Flip.', headlineAr: 'يلا', side: 'left' }, prompt: 'p' } } }), r);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'brief', pieceId: 'gen-br1', userInput: 'keep it dry' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.job.kind, 'hermes_brief'); assert.equal(r.body.job.state, 'running'); assert.equal(r.body.moodApproved, true); assert.equal(r.body.approvedClaims, 0);
    assert.equal(briefCalls, 0, 'Claude no longer writes the brief'); assert.equal(checkCalls, 0, 'nothing to check yet');
    const run = H.state.last; assert.equal(run.profile, 'brief'); assert.equal(run.url, 'https://hermes.test/p/brief/v1/runs');
    assert.equal(run.body.instructions.startsWith(B.SYSTEM), true, 'Maistro\'s brief rules are the bot\'s instructions'); assert.match(run.body.instructions, /\{"brief": <the brief/);
    const sent = run.body.input;
    assert.match(sent, /APPROVED MOODBOARD: /); assert.match(sent, /"selectedTiles": \[\s*"variation 2"/); assert.match(sent, /keep the rim light/); assert.match(sent, /"headline": "Setup\. Pause\. Flip\."/); assert.match(sent, /APPROVED CLAIMS \(the only claims allowed\): \[\]/); assert.match(sent, /sweet spot 9–30 s, max 5 hashtags/); assert.match(sent, /keep it dry/);
    assert.match(sent, /BRIEF JSON SCHEMA[^\n]*\n\{"type":"object"/, 'the contract to fill');
    assert.equal(pg.tables.stages.find((s) => s.kind === 'brief').state, 'generating');
    // the bot replies → validated, recorded, checked
    const job = pg.tables.jobs.find((j) => j.kind === 'hermes_brief'); job.next_poll_at = new Date(Date.now() - 1000).toISOString(); H.state.status = 'completed';
    r = res(); await jobs.handler(req({ method: 'GET', query: { id: job.id } }), r);
    assert.equal(r.body.job.state, 'succeeded', JSON.stringify(r.body.job)); assert.equal(r.body.job.result.version, 1);
    assert.equal(checkCalls, 1);
    const a = r.body.job.result.artifact; assert.equal(a.objective, BRIEF.objective); assert.equal(a.msg, BRIEF.keyMessage); assert.deepEqual(a.markets, ['UAE']); assert.equal(a.deadline, DEADLINE); assert.equal(a.spec.format.targetDurationS, 15); assert.equal(a.briefVersion, 'hermes/brief'); assert.equal(a.thumbApproved, false); assert.equal(a.madeBy.bot, 'brief');
    const checks = r.body.job.result.checks;
    assert.equal(checks.passed, true); assert.ok(checks.codeChecks.every((c) => c.passed)); assert.equal(checks.copy.arabicFluency, 'native');
    const sc = pg.tables.stage_checks.at(-1); assert.equal(sc.kind, 'copy'); assert.equal(sc.passed, true); assert.equal(sc.prompt_version, 'brief-copy-check-v1-2026-10-21'); assert.equal(sc.model, 'claude-sonnet-5-5');
    assert.ok(pg.tables.generation_records.some((g) => g.prompt_name === 'hermes.brief' && g.kind === 'hermes_brief' && g.status === 'succeeded' && g.model === 'hermes/brief'));
    assert.ok(pg.tables.generation_records.some((g) => g.prompt_name === 'studio.brief.check' && g.status === 'succeeded'));
    const v1 = pg.tables.artifact_versions.find((v) => v.id === r.body.job.result.versionId); assert.equal(v1.produced_by, 'hermes'); assert.equal(v1.kind, 'text'); assert.equal(v1.job_id, job.id);
    assert.equal(pg.tables.stages.find((s) => s.kind === 'brief').state, 'generated');
    r = res(); await studio.handler(req({ method: 'GET', query: { checks: 'gen-br1', stage: 'brief' } }), r); assert.equal(r.body.count, 1); assert.equal(r.body.checks[0].stage, 'brief');
    // a human edit: new manual version, re-checked; an unapproved claim fails the claims check
    const edited = JSON.parse(JSON.stringify(BRIEF)); edited.cta = 'Flip it.'; edited.claims = [{ claim: 'biggest cover screen', approvedWording: 'biggest cover screen', disclaimer: '' }];
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'brief-edit', pieceId: 'gen-br1', spec: edited } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.version, 2); assert.equal(H.state.runs.length, 1, 'no bot rewrite on an edit'); assert.equal(checkCalls, 2, 'the copy check runs again');
    const v2 = pg.tables.artifact_versions.find((v) => v.id === r.body.versionId); assert.equal(v2.produced_by, 'manual'); assert.equal(v2.payload.spec.cta, 'Flip it.'); assert.ok(v2.payload.editedBy);
    assert.equal(r.body.checks.passed, false); assert.equal(r.body.checks.codeChecks.find((c) => c.code === 'claims_approved').passed, false); assert.match(r.body.checks.flags[0], /unmapped claim/);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'brief-edit', pieceId: 'gen-br1', spec: { ...edited, deadline: 'whenever' } } }), r); assert.equal(r.statusCode, 422);
    // the Creative Spec carries the brief
    const spec = pg.tables.creative_specs.at(-1).spec; assert.equal(spec.stages.brief.current.version, 2);
  } finally { f.restore(); studio.restore(); pieces.restore(); decisions.restore(); jobs.restore(); }
});

test('the brief bot\'s reply must meet the brief contract: a malformed brief or a reply without one fails the job with the reason and the stage returns to ready', async () => {
  const pg = fakePostgrest(); const H = hermesFake({ brief: { ...BRIEF, caption: undefined, deadline: 'soon' } });
  const f = mockFetch([...H.routes, pg.route]);
  const studio = api('studio.js', ENV); const pieces = api('pieces.js', ENV); const jobs = api('jobs.js', ENV);
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-br2', stage: 'plan', artifact: { title: 'T', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] } } }), r);
    r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-br2', stage: 'mood', artifact: { imageUrl: 'https://cdn/m0.png', direction: DIRECTION, prompt: 'p', note: 'n' } } }), r);
    const poll = async () => { const job = pg.tables.jobs.filter((j) => j.kind === 'hermes_brief').at(-1); job.next_poll_at = new Date(Date.now() - 1000).toISOString(); const x = res(); await jobs.handler(req({ method: 'GET', query: { id: job.id } }), x); return x.body.job; };
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'brief', pieceId: 'gen-br2' } }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    H.state.status = 'completed';
    let j = await poll();
    assert.equal(j.state, 'failed'); assert.match(j.error, /does not match the brief contract: caption: required/);
    assert.equal(pg.tables.stages.find((s) => s.kind === 'brief').state, 'ready'); assert.equal((pg.tables.artifact_versions || []).filter((v) => v.produced_by === 'hermes').length, 0);
    H.state.status = 'running'; H.state.output = () => 'I wrote a lovely brief but forgot the JSON.';
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'brief', pieceId: 'gen-br2' } }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    H.state.status = 'completed';
    j = await poll();
    assert.equal(j.state, 'failed'); assert.match(j.error, /without a "brief" object/);
  } finally { f.restore(); studio.restore(); pieces.restore(); jobs.restore(); }
});

test('thumb-composite: the full 8-byte PNG signature is required and baseAssetPath must be one of this piece\'s stored assets', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([[/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })], pg.route]);
  const studio = api('studio.js', ENV); const pieces = api('pieces.js', ENV);
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-sig', stage: 'plan', artifact: { title: 'T', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] } } }), r);
    const good = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]).toString('base64'); const truncated = Buffer.from([137, 80, 78, 71, 1, 2]).toString('base64');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'thumb-composite', pieceId: 'gen-sig', data: truncated, overlay: { headline: 'x' } } }), r); assert.equal(r.statusCode, 422);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'thumb-composite', pieceId: 'gen-sig', data: good, overlay: { headline: 'x', baseAssetPath: 'pieces/gen-other/thumb/a.png' } } }), r); assert.equal(r.statusCode, 422); assert.match(r.body.error, /this piece/);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'thumb-composite', pieceId: 'gen-sig', data: good, overlay: { headline: 'x', baseAssetPath: 'pieces/gen-sig/thumb/a1b2.png' } } }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(pg.tables.artifact_versions.at(-1).payload.baseAssetPath, 'pieces/gen-sig/thumb/a1b2.png');
  } finally { f.restore(); studio.restore(); pieces.restore(); }
});

test('page: rBrief shows every field with check badges and RTL Arabic, the edit form saves a new version through brief-edit', async () => {
  let posted = null;
  const X = loadPage({ fetchImpl: async (u, init) => { if (String(u).includes('/api/studio?checks=')) return json({ count: 1, checks: [{ stage: 'brief', passed: false, results: { passed: false, codeChecks: [{ code: 'claims_approved', passed: false, detail: 'unmapped claim(s): x' }, { code: 'duration_sweet_spot', passed: true, detail: '15 s' }], copy: CHECK, flags: ['claims_approved: unmapped claim(s): x'] } }] }); if (String(u).endsWith('/api/studio') && init && init.method === 'POST') { posted = JSON.parse(init.body); return json({ ok: true, artifact: { objective: 'o2', msg: 'k', markets: ['UAE'], platforms: ['tiktok'], mandatories: BRIEF.mandatories, deadline: DEADLINE, spec: { ...posted.spec }, briefVersion: 'brief-v1-2026-10-21', editedBy: 'm1' }, version: 2, checks: { passed: true, codeChecks: [{ code: 'claims_approved', passed: true, detail: 'no claims made' }], copy: CHECK, flags: [] } }); } return new Promise(() => {}); } });
  try {
    const p = { id: 'gen-b', generated: true, studio: true, stage: 4, title: 'T', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'Galaxy Z Flip8', msg: 'm', angle: 'a' }, mood: { imageUrl: 'https://cdn/m.png' },
      brief: { objective: BRIEF.objective, msg: BRIEF.keyMessage, markets: ['UAE'], platforms: ['tiktok'], mandatories: BRIEF.mandatories, deadline: DEADLINE, spec: BRIEF, briefVersion: 'brief-v1-2026-10-21', version: 'v1', moodApproved: true } };
    X.PROJECTS.unshift(p);
    let html = X.stageArtifact(p, 3);
    assert.match(html, /BRIEF v1/); assert.match(html, /CHECKING…/); assert.match(html, /Success metric: ≥ 8 %/); assert.match(html, /deadpan caption reveal/); assert.match(html, /No product claims/); assert.match(html, /<b>15 s<\/b>/); assert.match(html, /dir="rtl" style="text-align:right;unicode-bidi:plaintext">يلا شوف الـفليب/); assert.match(html, /#GalaxyZFlip8/); assert.match(html, /Edit fields/);
    await new Promise((r) => setTimeout(r, 20)); html = X.stageArtifact(p, 3);
    assert.match(html, /CHECKS NEED A LOOK/); assert.match(html, /✗ CLAIMS APPROVED/); assert.match(html, /✓ DURATION SWEET SPOT/);
    X.BRIEF_EDIT['gen-b'] = JSON.parse(JSON.stringify(BRIEF)); html = X.stageArtifact(p, 3);
    assert.match(html, /saved as a new version \(v2\)/); assert.match(html, /id="be-captionAr" rows="3" dir="rtl"/); assert.match(html, /Save as new version/);
    // the DOM stub has no real elements: answer the form's selectors from a value map
    const vals = { '#be-objective': BRIEF.objective, '#be-successMetric': BRIEF.successMetric, '#be-keyMessage': BRIEF.keyMessage, '#be-cta': 'Flip it.', '#be-hook': BRIEF.trendHook.samsungAdaptation, '#be-dur': '15', '#be-deadline': DEADLINE, '#be-captionEn': BRIEF.caption.en, '#be-captionAr': BRIEF.caption.ar, '#be-hashEn': 'A, B', '#be-hashAr': BRIEF.hashtags.ar.join('، '), '#be-mandatories': 'Hero product on screen\nSamsung logo end-frame\nCleared audio only', '#be-doNots': BRIEF.doNots.join('\n') };
    const origQS = X.document.querySelector; X.document.querySelector = (sel) => (sel in vals ? { value: vals[sel] } : origQS(sel));
    await X.saveBriefEdit('gen-b');
    assert.equal(posted.action, 'brief-edit'); assert.equal(posted.spec.cta, 'Flip it.'); assert.deepEqual(posted.spec.hashtags.en, ['A', 'B']); assert.equal(posted.spec.mandatories.length, 3);
    assert.equal(p.brief.version, 'v2'); assert.equal(p.brief.editedBy, 'm1'); assert.equal(X.BRIEF_EDIT['gen-b'], undefined); assert.equal(X.CHECKS['gen-b:brief'].passed, true);
    html = X.stageArtifact(p, 3); assert.match(html, /HUMAN-EDITED/); assert.match(html, /ALL CHECKS PASSED/);
  } finally { X.restore(); }
});
