// Owner 2026-11-02 — how Maistro coordinates the Hermes bots (docs/hermes-integration.md): one locked product on
// every request, keyframes that know their place in the story, ledger-shaped session ids, budgets with QA headroom,
// replies validated (last ```json block, errors routed, extra fields kept), staleness and the review loop.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mockFetch, json, loadPage } = require('../helpers');
const C = require('../../api/_studio/hermes-contract.js');
const H = require('../../api/_adapters/hermes.js');

const S26 = { family: 'Galaxy S26 Ultra', colour: 'Sky Blue', model_code: 'SM-S948BLBIMEA' };
const IMGS = ['https://cdn.test/s26-front.png', 'https://cdn.test/s26-back.png', 'https://cdn.test/s26-side.png'];
const SHOT = (n, extra = {}) => ({ n, beat: n === 1 ? 'opening' : 'story', act: '', durationS: 3, type: 'medium', camera: 'low angle, slow push-in', angle: '', lens: '', move: '', action: `action ${n}`, devicePose: '', product: { visible: true, feature: 'S Pen' }, transition: 'cut', ...extra });

test('session ids: maistro-gen-<alphanumeric campaign>-<role>[-v<n>], the shape the Hermes ledger regex reads', () => {
  const LEDGER = /^maistro-gen-([A-Za-z0-9]+)-([a-z]+)/;
  assert.equal(C.campaignKey('gen-k3x9-ab_2'), 'k3x9ab2', 'hyphens and underscores dropped, the gen- prefix too');
  assert.equal(C.campaignKey('zztest01'), 'zztest01');
  assert.throws(() => C.campaignKey('--__'), /no alphanumeric campaign id/);
  assert.equal(C.sessionId('gen-k3x9', 'board'), 'maistro-gen-k3x9-board');
  assert.equal(C.sessionId('gen-k3x9', 'board', 1), 'maistro-gen-k3x9-board', 'v1 is the bare session');
  assert.equal(C.sessionId('gen-k3x9', 'board', 2), 'maistro-gen-k3x9-board-v2', 'a new campaign version starts a fresh session');
  assert.equal(C.sessionId('gen-k3x9', 'video', 3), 'maistro-gen-k3x9-draft-v3', 'the video bot\'s suffix is draft');
  for (const role of ['brief', 'mood', 'board', 'thumb', 'video']) {
    const sid = C.sessionId('gen-a1-b2', role, 2);
    const m = LEDGER.exec(sid);
    assert.ok(m, sid); assert.equal(m[1], 'a1b2', 'the same campaign id for every bot, so they share one ledger');
    assert.deepEqual(C.parseSessionId(sid), { campaign: 'a1b2', role: C.ROLE_SUFFIX[role], version: 2 });
  }
  assert.throws(() => C.sessionId('gen-a1', 'organizer'), /no session suffix/);
  assert.equal(C.parseSessionId('maistro-gen-a-1-board'), null, 'a hyphenated campaign id is rejected');
  assert.match(C.reviewSessionId('gen-a1', 1700000000000), /^maistro-review-a1-1700000000000$/);
});

test('request builders: every bot gets the locked product + product_image_urls; no seed; moodboard images are look references; budgets with QA headroom', () => {
  const base = { prompt: 'p', productSpec: S26, productImages: IMGS };
  for (const role of ['mood', 'thumb', 'board', 'video']) {
    const run = H.renderRun({ ...base, seed: 42, batch: role === 'mood' ? 2 : undefined, anchorUrls: ['https://cdn.test/mood1.png'] }, role);
    const inp = JSON.parse(run.input);
    assert.deepEqual(inp.product, S26, `${role}: product`); assert.deepEqual(inp.product_image_urls, IMGS, `${role}: official images, front/back/side`);
    assert.equal(inp.seed, undefined, `${role}: no seed`);
    assert.match(run.instructions, /Samsung Galaxy S26 Ultra in Sky Blue \(SM-S948BLBIMEA\)/);
    assert.doesNotMatch(run.instructions + run.input, /2026 flagship bar phone/, 'never the generic device sentence');
    assert.match(run.instructions, /"qa": \{"checked"/, `${role}: the reply contract asks for qa`);
    if (role !== 'video') { assert.deepEqual(inp.moodboard_images, [{ url: 'https://cdn.test/mood1.png', look_reference: true }]); assert.match(run.instructions, /LOOK references only/); assert.match(run.instructions, /official SAMSUNG wordmark on its back stays/); }
  }
  // without a stored spec (older queued jobs) the family still comes from the job; images may be empty but are sent
  const old = JSON.parse(H.renderRun({ prompt: 'p', meta: { product: 'Galaxy Z Flip8' } }, 'thumb').input);
  assert.deepEqual(old.product, { family: 'Galaxy Z Flip8', colour: null, model_code: null }); assert.deepEqual(old.product_image_urls, []);
  // the brief bot gets the same spec in its task
  const br = H.briefRun({ context: 'CTX', schema: {}, system: 'SYS', productSpec: S26, productImages: IMGS });
  assert.match(br.input, /PRODUCT \(locked spec[^)]*\): \{"product":\{"family":"Galaxy S26 Ultra","colour":"Sky Blue","model_code":"SM-S948BLBIMEA"\},"product_image_urls":\["https:\/\/cdn.test\/s26-front.png"/);
  // budgets: keyframe ≥ 6 (two QA re-renders), moodboard 3 × count × 2, thumbnail ≥ 6, video by the clip
  assert.equal(JSON.parse(H.renderRun(base, 'board').input).max_credits, 6);
  assert.equal(JSON.parse(H.renderRun({ ...base, batch: 4 }, 'mood').input).max_credits, 24);
  assert.equal(JSON.parse(H.renderRun(base, 'thumb').input).max_credits, 6);
  assert.equal(JSON.parse(H.renderRun({ ...base, duration: 4, resolution: '720p' }, 'video').input).max_credits, 23, '4 s at 720p ≈ 18 credits + headroom');
  assert.equal(JSON.parse(H.renderRun({ ...base, resolution: '4k' }, 'board').input).max_credits, 12, '4k images cost 4');
  process.env.MAISTRO_HERMES_BUDGETS = '{"keyframe":10,"cap":"x"}';
  try { assert.equal(C.budgetFor('board'), 10, 'configurable in one place'); assert.equal(C.budgets().cap, 150, 'non-numbers ignored'); } finally { delete process.env.MAISTRO_HERMES_BUDGETS; }
});

test('keyframe requests carry shot_index, shot_count, the story, the full shot list and the earlier keyframes; PLAN mode asks for the whole storyboard', () => {
  const shots = [SHOT(1), SHOT(2, { act: 'Act 2', lens: '35mm', devicePose: 'held in the left hand' }), SHOT(3, { type: 'end_card', product: { visible: false, feature: '' } })];
  const story = C.storyFrom(null, { logline: 'L', openingScene: 'O', beats: ['B'], closingScene: 'Z' }, 'KM');
  assert.deepEqual(story, { logline: 'L', product_truth: 'KM', emotional_arc: 'O → B → Z', acts: ['O', 'B', 'Z'] });
  const shotContext = { shot_index: 2, shot_count: 3, story, shot_list: shots.map(C.botShot) };
  const run = H.renderRun({ prompt: 'p', productSpec: S26, productImages: IMGS, shotContext, previousKeyframeUrls: ['https://cdn.test/k1.png', 'http://no/k.png'], fixRequest: 'show more of the phone' }, 'board');
  const inp = JSON.parse(run.input);
  assert.equal(inp.shot_index, 2); assert.equal(inp.shot_count, 3); assert.deepEqual(inp.story, story);
  assert.deepEqual(inp.shot_list[1], { index: 2, act: 'Act 2', beat: 'story', shot_size: 'medium', angle: 'low angle', lens: '35mm', move: 'slow push-in', action: 'action 2', device_pose: 'held in the left hand', duration_s: 3, transition: 'cut' });
  assert.equal(inp.shot_list[0].act, 'Act 1 — setup', 'an act from the beat when the shot list has none'); assert.equal(inp.shot_list[2].device_pose, 'not in frame');
  assert.deepEqual(inp.previous_keyframe_urls, ['https://cdn.test/k1.png']); assert.equal(inp.fix_request, 'show more of the phone');
  assert.match(inp.task, /shot 2 of 3/); assert.match(run.instructions, /"device_pose"/); assert.match(run.instructions, /"story_flag"/);
  const plan = H.renderRun({ prompt: 'p', planMode: true, productSpec: S26, planContext: { brief: { keyMessage: 'k' }, story, targetDurationS: 15 } }, 'board');
  const pin = JSON.parse(plan.input);
  assert.match(pin.task, /^Write the story and shot list, then make all keyframes/); assert.equal(pin.shot_index, undefined); assert.deepEqual(pin.shot_count_range, [4, 8]);
  assert.match(plan.instructions, /\{"story": \{"logline"/); assert.match(plan.instructions, /Never draw the Samsung logo/); assert.equal(pin.max_credits, 48, 'PLAN mode budgets every frame');
});

test('TEST MODE: the dry-run instruction leads the run and max_credits is 1 (below any image), so nothing can be spent', () => {
  const run = H.renderRun({ prompt: 'p', productSpec: S26, testMode: true }, 'video');
  assert.ok(run.instructions.startsWith(C.TEST_MODE_INSTRUCTION)); assert.equal(JSON.parse(run.input).max_credits, 1);
  assert.ok(H.briefRun({ context: 'c', schema: {}, system: 's', testMode: true }).instructions.startsWith('TEST MODE: run every maistro_media.py command with --dry-run only'));
  assert.ok(H.reviewRun('zztest01', { testMode: true }).instructions.startsWith('TEST MODE')); assert.equal(H.reviewRun('gen-zz-test01').input, 'review campaign zztest01');
});

test('replies: the last ```json block wins; errors carry note/error_code/fallback and the new-first-frame ask; extra fields never break parsing', async () => {
  assert.deepEqual(H.parseOutput('plan ```json\n{"frames":[]}\n``` then ```json\n{"frames":[{"index":1,"image":"https://a/1.png"}],"x":1}\n```'), { frames: [{ index: 1, image: 'https://a/1.png' }], x: 1 });
  const ok = C.interpret('board', { frames: [{ index: 2, image: 'https://a/2.png', act: 'Act 2', device_pose: 'in hand', qa: { verdict: 'pass', checked: 3 }, story_flag: 'contradicts shot 1', extra: 'kept' }, { index: 1, image: 'https://a/1.png' }], note: 'n', qa: { checked: 2, passed: 2, regenerated: 0, dropped: 0, product: 'S26U', spec_card: 'Sky Blue', notes: 'ok', verdict: 'pass' }, budget_blocked_retry: true, unknown: { deep: true } });
  assert.equal(ok.kind, 'result'); assert.deepEqual(ok.problems, []); assert.deepEqual(ok.frames.map((f) => f.index), [1, 2], 'sorted by index');
  assert.equal(ok.frames[1].device_pose, 'in hand'); assert.equal(ok.frames[1].qa.verdict, 'pass'); assert.equal(ok.frames[1].story_flag, 'contradicts shot 1'); assert.equal(ok.budgetBlockedRetry, true); assert.equal(ok.qa.spec_card, 'Sky Blue');
  assert.deepEqual(C.validate('video', { duration_s: 4 }), ['video: required']); assert.deepEqual(C.validate('mood', { images: [], qa: { checked: 'x' } }), ['qa.checked: expected num']);
  assert.deepEqual(C.validate('thumb', { images: ['https://a'], note: 'n', anything: [1, 2] }), [], 'unknown fields are ignored');
  const nsfw = C.interpret('video', { error: 'Seedance NSFW filter blocked the first frame', note: 'Please send a new first frame that shows more of the phone and less skin' });
  assert.equal(nsfw.kind, 'error'); assert.equal(nsfw.error.wantsNewFrame, true); assert.equal(nsfw.error.creditsExhausted, false);
  const broke = C.interpret('board', { error: 'no credits', note: 'top up', error_code: 'higgsfield_credits_exhausted', fallback: 'figma_weave' });
  assert.deepEqual([broke.error.creditsExhausted, broke.error.fallback, broke.error.wantsNewFrame], [true, 'figma_weave', false]);
  assert.equal(C.interpret('video', { error: 'timeout', note: 'try again later' }).error.wantsNewFrame, false);
  assert.equal(C.interpret('thumb', { refused: 'policy' }).kind, 'refused');
  // through the adapter: a completed run whose reply is a bot error → failed with the routed error
  const saved = { ...process.env };
  Object.assign(process.env, { HERMES_API_URL: 'https://gw.test', HERMES_API_KEY: 'k' });
  const out = { v: null };
  const f = mockFetch([[/^https:\/\/gw\.test\/p\/maistro-video\/v1\/runs\/r1$/, () => json({ status: 'completed', output: out.v })], [/^https:\/\/gw\.test\/p\/maistro-storyboard\/v1\/runs\/r2$/, () => json({ status: 'completed', output: out.v })]]);
  try {
    out.v = 'Sorry.\n```json\n{"error":"NSFW filter","note":"Please send a new first frame that shows more of the phone","error_code":"nsfw","later":1}\n```';
    const st = await H.status('video:r1');
    assert.equal(st.status, 'failed'); assert.equal(st.raw_status, 'bot_error'); assert.equal(st.botError.wantsNewFrame, true); assert.match(st.error, /maistro-video bot: NSFW filter/);
    out.v = '```json\n{"frames":[{"index":3,"image":"https://cdn.test/k3.png","act":"Act 3","transition":"hold","qa":{"verdict":"warn","notes":"logo plate"}}],"note":"ok","qa":{"checked":1,"passed":1,"regenerated":1,"dropped":0,"product":"p","spec_card":"s","notes":"n"},"budget_blocked_retry":true}\n```';
    const st2 = await H.status('board:r2');
    assert.equal(st2.status, 'completed'); assert.deepEqual(st2.images, ['https://cdn.test/k3.png']); assert.equal(st2.frames[0].act, 'Act 3'); assert.equal(st2.qa.regenerated, 1); assert.equal(st2.budgetBlockedRetry, true);
  } finally { f.restore(); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('the product: one spec from the family, the campaign colour and the catalog; official images front → back → side in that colour first', () => {
  assert.deepEqual(C.productSpec({ family: 'Galaxy S26 Ultra' }), S26, 'the default colourway and its code');
  assert.deepEqual(C.productSpec({ family: 'galaxy s26 ultra', colour: 'sky blue' }), S26, 'matched without case');
  assert.deepEqual(C.productSpec({ family: 'Galaxy S26 Ultra', colour: 'Titanium Black' }), { family: 'Galaxy S26 Ultra', colour: 'Titanium Black', model_code: null }, 'an unknown code is null, never guessed');
  assert.deepEqual(C.productSpec({ family: 'Galaxy Z Flip8', catalog: { colors: ['Mint'], modelCodes: { Mint: 'SM-F000' } } }), { family: 'Galaxy Z Flip8', colour: 'Mint', model_code: 'SM-F000' });
  const catalog = { referenceImages: [{ url: 'https://c/side.png', view: 'side', colour: 'Sky Blue' }, { url: 'https://c/back-black.png', view: 'back', colour: 'Black' }, { url: 'https://c/back.png', view: 'back', colour: 'Sky Blue' }, { url: 'https://c/front.png', view: 'front' }] };
  assert.deepEqual(C.productImages(S26, catalog, ['https://c/model-view.png', 'http://c/x.png']), ['https://c/front.png', 'https://c/back.png', 'https://c/side.png', 'https://c/model-view.png']);
  assert.equal(C.productLine(S26), 'Samsung Galaxy S26 Ultra in Sky Blue (SM-S948BLBIMEA)');
  // the official Sky Blue gallery shots ship with Maistro (/assets, open past the gate); another colourway never gets them
  const sky = C.productImages(C.productSpec({ family: 'Galaxy S26 Ultra' }), null, ['https://c/model-view.png']);
  assert.deepEqual(sky, ['front', 'back', 'side', 'back-three-quarter'].map((v) => `https://www.ma1stro.com/assets/products/galaxy-s26-ultra/sky-blue-${v}.jpg`));
  for (const u of sky) assert.ok(require('fs').existsSync(require('path').join(__dirname, '../..', new URL(u).pathname)), `${u} is in assets/ (copied to public/ at build)`);
  assert.deepEqual(C.productImages(C.productSpec({ family: 'Galaxy S26 Ultra', colour: 'Black' }), null, ['https://c/model-view.png']), ['https://c/model-view.png']);
});

test('staleness and order: a clip made from a replaced keyframe is stale; earlier steps not approved are warned (strict blocks)', () => {
  const board = [{ n: 1, keyframe: { state: 'rendered', assetPath: 'pieces/a/board/k1-new.png', jobId: 'j9' } }, { n: 2, keyframe: { state: 'rendered', assetPath: 'pieces/a/board/k2.png', jobId: 'j2' } }, { n: 3, keyframe: { state: 'rendered', url: 'https://x/k3b.png', jobId: 'j3b' } }];
  const draft = [
    { n: 1, boardShot: 1, keyframe: { assetPath: 'pieces/a/board/k1.png', jobId: 'j1' }, clip: { state: 'rendered', fromKeyframe: 'pieces/a/board/k1.png' } },
    { n: 2, boardShot: 2, keyframe: { assetPath: 'pieces/a/board/k2.png' }, clip: { state: 'rendered', fromKeyframe: 'pieces/a/board/k2.png' } },
    { n: 3, boardShot: 3, keyframe: { url: 'https://x/k3.png' }, clip: { state: 'rendered', fromKeyframe: null } },
    { n: 4, boardShot: null, keyframe: null, clip: { state: 'rendered' } },
  ];
  assert.deepEqual(C.staleClips(board, draft), [{ n: 1, boardShot: 1, from: 'pieces/a/board/k1.png', current: 'pieces/a/board/k1-new.png' }, { n: 3, boardShot: 3, from: 'https://x/k3.png', current: 'https://x/k3b.png' }]);
  assert.equal(C.currentKeyframe({ keyframe: { state: 'rendered' }, review: { decision: 'rejected' } }), null, 'a rejected keyframe is never the first frame');
  assert.deepEqual(C.orderCheck('board', { brief: 'approved', mood: 'generated' }), [{ stage: 'mood', state: 'generated' }]);
  assert.deepEqual(C.orderCheck('draft', { brief: 'approved', mood: 'approved', board: 'approved' }, ['thumb']), [], 'a skipped step counts as done');
  assert.deepEqual(C.orderCheck('brief', {}), []);
  assert.equal(C.orderMode(), 'warn'); process.env.MAISTRO_PIPELINE_ORDER = 'strict'; try { assert.equal(C.orderMode(), 'strict'); } finally { delete process.env.MAISTRO_PIPELINE_ORDER; }
});

test('PLAN-mode frames become storyboard shots; the organizer review maps every fix to the bot run that makes it; logs are redacted', () => {
  const frames = [{ index: 1, act: 'Act 1', beat: 'hook', shot_size: 'ECU', angle: 'top', move: 'push', action: 'a', device_pose: 'in hand', vo: 'hi', transition: 'match cut', duration_s: 2 }, { index: 2, shot_size: 'wide', device_pose: 'not in frame', transition: '' }, { index: 3, shot_size: 'end card', beat: 'end card', device_pose: '' }].map(C.normFrame);
  const shots = C.shotsFromFrames(frames);
  assert.deepEqual(shots.map((s) => [s.beat, s.type, s.transition, s.product.visible]), [['opening', 'macro', 'match_cut', true], ['closing', 'wide', 'none', false], ['end_card', 'end_card', 'none', false]]);
  assert.equal(shots[0].line.en, 'hi'); assert.equal(shots[0].devicePose, 'in hand'); assert.equal(shots[0].camera, 'top, push');
  const rv = C.reviewResult({ review: [{ asset: 'shot 2', verdict: 'fail', defects: ['wrong colour'] }], story_check: 'breaks at shot 3', miscommunications: ['thumbnail used Titanium Black'], fixes_requested: [{ to: 'maistro-storyboard', shot: 2, fix: 'Sky Blue' }, { to: 'maistro-video', shot: 2, fix: 'slower' }, { to: 'maistro-thumbnail', fix: 'Sky Blue colourway' }, { to: 'maistro-mars', fix: '?' }], qa: { verdict: 'warn' }, extra: 1 });
  assert.equal(rv.ok, true); assert.deepEqual(rv.review[0].defects, ['wrong colour']);
  assert.deepEqual(rv.fixes.map((f) => f.run), [{ action: 'board-shot', shot: 2, changes: 'Sky Blue' }, { action: 'draft-shot', shot: 2, changes: 'slower' }, { action: 'thumb', userInput: 'Sky Blue colourway' }, null]);
  assert.equal(C.reviewResult({ error: 'ledger missing', note: 'n' }).ok, false);
  const red = C.redact({ url: 'https://sb.test/storage/v1/object/sign/assets/a.png?token=abc.def&x=1', headers: { Authorization: 'Bearer sk-123' }, note: 'Bearer abc' });
  assert.equal(red.url, 'https://sb.test/storage/v1/object/sign/assets/a.png?token=REDACTED&x=1'); assert.equal(red.headers.Authorization, '[redacted]'); assert.equal(red.note, 'Bearer [redacted]');
});

test('page: the storyboard shows act, device pose, transition and the bot\'s QA; a stale clip offers a re-render from the current keyframe; a "new first frame" ask offers the fix; the review lists runnable fixes', () => {
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    const p = { id: 'gen-hc1', generated: true, studio: true, stage: 5, title: 'T', product: 'Galaxy S26 Ultra', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'p', msg: 'm', angle: 'a' }, productColour: 'Sky Blue',
      board: { version: 'v2', aspect: '9:16', totalS: 6, hookShot: 1, story: { logline: 'The phone that keeps up', product_truth: 'S Pen', emotional_arc: 'a → b', acts: ['set', 'pay'] }, shots: [
        { n: 1, beat: 'opening', act: 'Act 1 — setup', devicePose: 'held low, back to camera', durationS: 3, type: 'close_up', camera: 'low angle', action: 'x', product: { visible: true, feature: '' }, onScreenText: { en: '', ar: '' }, line: { en: '', ar: '' }, audioCue: '', transition: 'cut', keyframe: { state: 'rendered', url: 'https://x/k1.png', qa: { verdict: 'pass', notes: 'colour matches', spec_card: 'Sky Blue' }, storyFlag: 'skips the setup', budgetBlockedRetry: true, frame: { transition: 'match cut' } }, review: null },
      ] },
      draft: { version: 'v1', aspect: '9:16', resolution: '720p', totalS: 6, assembled: { assetPath: 'pieces/gen-hc1/draft/cut.mp4', width: 720, height: 1280, durationS: 6 }, shots: [
        { n: 1, boardShot: 1, durationS: 3, keyframe: { url: 'https://x/k0.png' }, clip: { state: 'rendered', url: 'https://x/c1.mp4', qa: { verdict: 'warn' } }, stale: { reason: 'storyboard shot 1 has a newer keyframe', boardShot: 1 } },
        { n: 2, boardShot: 2, durationS: 3, keyframe: { url: 'https://x/k2.png' }, clip: { state: 'failed', error: 'the maistro-video bot: NSFW filter', botNote: 'send a new first frame that shows more of the phone', needsNewFrame: true } },
      ] } };
    X.PROJECTS.unshift(p);
    const board = X.rBoard(p, false);
    assert.match(board, /Act 1 — setup/); assert.match(board, /Device: held low, back to camera/); assert.match(board, /→ match cut/);
    assert.match(board, /BOT QA · PASS/); assert.match(board, /STORY FLAG/); assert.match(board, /QA RE-RENDER BLOCKED BY BUDGET/); assert.match(board, /Spec card: Sky Blue/);
    assert.match(board, /Story · every keyframe request carries it/); assert.match(board, /Product truth:<\/b> S Pen/);
    const draft = X.rDraftOne(p, false, p.draft, 'gen-hc1:draft', false);
    assert.match(draft, /PART 1 STALE — KEYFRAME CHANGED/); assert.match(draft, /shotRegen\('gen-hc1',1,'draft'\)[^>]*>↻ Re-render from current keyframe/);
    assert.match(draft, /THE VIDEO BOT ASKED FOR A NEW FIRST FRAME/); assert.match(draft, /frameFix\('gen-hc1',2\)/); assert.match(draft, /Video bot:<\/b> send a new first frame/);
    assert.deepEqual(X.campCtx(p), { productColour: 'Sky Blue', skipped: [] });
    X.REVIEW['gen-hc1'] = { result: { ok: true, review: [{ asset: 'thumbnail', verdict: 'fail', defects: ['Titanium Black'] }], storyCheck: 'one story', miscommunications: ['the thumbnail bot had no colour'], fixes: [{ to: 'maistro-thumbnail', shot: null, fix: 'Sky Blue', run: { action: 'thumb', userInput: 'Sky Blue' } }, { to: 'maistro-mars', shot: null, fix: '?', run: null }], qa: null }, done: {} };
    const rv = X.rReview(p);
    assert.match(rv, /🔍 Review campaign/); assert.match(rv, /Titanium Black/); assert.match(rv, /Miscommunications/); assert.match(rv, /reviewFix\('gen-hc1',0\)">Run this fix →/); assert.match(rv, /no bot for this/);
  } finally { X.restore(); }
});
