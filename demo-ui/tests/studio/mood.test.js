// Phase 6.2 — Moodboard: structured direction → Soul set → automated vision check → human selection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, loadPage } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const { validateDirection, tilePrompt } = require('../../api/_studio/mood.js');
const { verdict } = require('../../api/_studio/checks.js');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', HF_CREDENTIALS: 'id:secret', ANTHROPIC_API_KEY: 'k', CRON_SECRET: 'cron' };
const PNG = new Uint8Array([137, 80, 78, 71, 9, 9]);
const DIRECTION = {
  setting: 'sunlit Dubai apartment terrace', lighting: 'warm late-afternoon rim light', mood: 'calm confidence', styling: 'minimal, matte materials', wardrobe: 'modest neutral linen',
  compositionStyle: 'negative space left, product right', cameraFeel: '50 mm, shallow depth', trendAdaptation: 'the deadpan caption beat lands on the FlexWindow', leadingPrinciple: 'Authentically grounded',
  palette: [{ name: 'Samsung Blue', hex: '#1428A0', role: 'dominant' }, { name: 'Porcelain', hex: '#FCF8E6', role: 'secondary' }, { name: 'Persimmon', hex: '#FFC861', role: 'accent' }],
  tiles: [{ tag: 'palette', demonstrates: 'colours and materials', prompt: 'A flat-lay of matte linen and porcelain ceramics in Samsung Blue and Porcelain, warm rim light' }, { tag: 'product', demonstrates: 'the device in its setting', prompt: 'The foldable on a terrace table, half open, warm light' }, { tag: 'light', demonstrates: 'lighting and mood', prompt: 'Terrace at golden hour, long shadows, calm' }, { tag: 'trend', demonstrates: 'the mechanic adapted', prompt: 'A hand pauses mid-reveal above the cover screen' }],
};
const CHECK = { images: [0, 1, 2, 3].map((i) => ({ index: i, productPresent: i === 0 ? 'no' : 'yes', productMatchesCatalog: i === 0 ? 'n/a' : 'yes', consistentWithMood: 'n/a', textSpaceClear: 'n/a', competitorOrLogo: 'no', realPerson: i === 3 ? 'unsure' : 'no', textInImage: 'no', prohibitedImagery: 'no', paletteMatch: i === 2 ? 'partial' : 'yes', lightingMatch: 'yes', culturalOk: 'yes', notes: 'ok' })) };

function world() {
  const pg = fakePostgrest();
  const hf = { status: 'in_progress' };
  const f = mockFetch([
    ['api.anthropic.com', (u, init) => { const b = JSON.parse(init.body); const isCheck = /check generated campaign images/.test(b.system); return json({ content: [{ type: 'text', text: JSON.stringify(isCheck ? CHECK : DIRECTION) }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }); }],
    [/\/higgsfield-ai\/soul\/v2\/standard$/, (u, init) => { hf.body = JSON.parse(init.body); return json({ status: 'queued', request_id: 'req00000002', status_url: 'x', cancel_url: 'y' }); }],
    ['/requests/req00000002/status', () => json(hf.status === 'completed' ? { status: 'completed', images: [1, 2, 3, 4].map((n) => ({ url: `https://d3u0tzju9qaucj.cloudfront.net/t${n}.png` })) } : { status: hf.status })],
    [/d3u0tzju9qaucj\.cloudfront\.net\/t\d\.png$/, () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', () => json({ signedURL: '/object/sign/assets/x?token=t' })],
    [/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV);
  return { pg, hf, f, studio, jobs, pieces, restore: () => { f.restore(); studio.restore(); jobs.restore(); pieces.restore(); } };
}

test('validateDirection enforces the structure (hex palette, exactly four tiles, no competitor names, prompt length); tilePrompt anchors a tile to the direction and the catalog look', () => {
  assert.deepEqual(validateDirection(DIRECTION), []);
  const bad = JSON.parse(JSON.stringify(DIRECTION)); bad.palette[0].hex = 'blue'; bad.tiles.pop(); bad.tiles[0].prompt = 'An iPhone on a table';
  const p = validateDirection(bad);
  assert.ok(p.some((x) => /palette\[0\]\.hex/.test(x))); assert.ok(p.some((x) => /tiles: exactly 4/.test(x))); assert.ok(p.some((x) => /names a competitor/.test(x)));
  const tp = tilePrompt(DIRECTION, DIRECTION.tiles[1], '2026 clamshell flip foldable');
  assert.match(tp, /^The foldable on a terrace table/); assert.match(tp, /Samsung Blue #1428A0/); assert.match(tp, /exactly: 2026 clamshell flip foldable/); assert.match(tp, /No text, no logos/);
});

test('verdict: hard failures fail, "unsure" on safety needs review, off-direction palette is a flag', () => {
  assert.deepEqual(verdict(CHECK.images[1], true), { pass: true, needsReview: false, flags: [] });
  assert.deepEqual(verdict(CHECK.images[0], true).flags, ['product missing']); assert.equal(verdict(CHECK.images[0], true).pass, false);
  assert.deepEqual(verdict(CHECK.images[0], false), { pass: true, needsReview: false, flags: [] }, 'no product expected → no product flag');
  const r3 = verdict(CHECK.images[3], false); assert.equal(r3.needsReview, true); assert.deepEqual(r3.flags, ['person unsure']);
  assert.equal(verdict({ ...CHECK.images[1], competitorOrLogo: 'yes' }, true).pass, false);
});

test('POST /api/studio action mood: direction from Claude with the catalog look and the brand palette, one Soul batch job with the direction on it; completion lists four copied images and queues the vision check; the tick stores stage_checks; the pieces list carries the set', async () => {
  const W = world();
  try {
    let r = res(); await W.pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-mood1', stage: 'plan', artifact: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', trendName: 'Deadpan caption reveal' } } }), r);
    r = res(); await W.studio.handler(req({ method: 'POST', body: { action: 'mood', pieceId: 'gen-mood1', userInput: 'warm, calm' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.direction.leadingPrinciple, 'Authentically grounded'); assert.equal(r.body.promptVersion, 'mood-direction-v1-2026-10-21');
    assert.equal(r.body.job.kind, 'higgsfield_image'); assert.equal(r.body.job.state, 'running');
    assert.equal(W.hf.body.batch_size, 4); assert.equal(W.hf.body.aspect_ratio, '4:3'); assert.match(W.hf.body.prompt, /clamshell flip foldable/, 'the catalog look line is the product description'); assert.match(W.hf.body.prompt, /^sunlit Dubai apartment terrace, featuring the device/, 'the set prompt is the whole direction, not tile 1');
    const job = W.pg.tables.jobs[0];
    assert.equal(job.payload.meta.setMode, 'variations');
    assert.equal(job.payload.autoCheck, true); assert.equal(job.payload.meta.direction.setting, DIRECTION.setting); assert.equal(job.payload.meta.productLook, '2026 clamshell flip foldable, large FlexWindow cover screen when closed');
    assert.ok(W.pg.tables.generation_records.some((g) => g.prompt_name === 'studio.mood.direction' && g.status === 'succeeded'));
    // render completes → version with four images, vision check queued
    W.hf.status = 'completed'; job.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await W.jobs.handler(req({ method: 'GET', query: { id: job.id } }), r);
    assert.equal(r.body.job.state, 'succeeded'); const art = r.body.job.result.artifact;
    assert.equal(art.images.length, 4); assert.ok(art.images.every((im) => im.assetPath && im.sha256)); assert.deepEqual(art.images.map((im) => im.tag), ['variation 1', 'variation 2', 'variation 3', 'variation 4'], 'a Soul batch is four variations of one prompt'); assert.equal(art.setMode, 'variations'); assert.equal(art.imageUrl, art.images[0].url); assert.equal(art.direction.mood, 'calm confidence');
    const check = W.pg.tables.jobs.find((j) => j.kind === 'vision_check');
    assert.ok(check, 'vision check queued'); assert.equal(check.payload.images.length, 4); assert.equal(check.payload.versionId, r.body.job.result.versionId);
    // the tick runs the check
    r = res(); await W.jobs.handler(req({ headers: { authorization: 'Bearer cron' }, session: false }), r);
    assert.equal(r.body.states.succeeded, 1, JSON.stringify(r.body));
    assert.equal(W.pg.tables.stage_checks.length, 1); const sc = W.pg.tables.stage_checks[0];
    assert.equal(sc.kind, 'vision'); assert.equal(sc.passed, false, 'tile 4 is unsure'); assert.equal(sc.results.images[1].pass, true); assert.deepEqual(sc.results.images[3].flags, ['person unsure']);
    assert.equal(sc.results.images[0].pass, false, 'every variation is expected to show the catalog product'); assert.deepEqual(sc.results.images[0].flags, ['product missing']); assert.equal(check.payload.expectProduct, true, 'explicit on the job: the catalog has a look line');
    assert.equal(check.next_poll_at, null); assert.equal(check.state, 'succeeded');
    r = res(); await W.studio.handler(req({ method: 'GET', query: { checks: 'gen-mood1', stage: 'mood' } }), r);
    assert.equal(r.body.count, 1); assert.equal(r.body.checks[0].stage, 'mood');
    // the human selects tiles 2 and 3 with an annotation; the pieces list returns it
    const decisions = api('decisions.js', ENV);
    try {
      r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-mood1', stage: 'mood', decision: 'approved', name: 'N', role: 'reviewer', details: { selectedImages: [1, 2], annotations: 'keep the rim light' } } }), r);
      assert.equal(r.statusCode, 200); assert.deepEqual(W.pg.tables.approvals[0].details, { selectedImages: [1, 2], annotations: 'keep the rim light' });
      r = res(); await W.pieces.handler(req({ method: 'GET' }), r);
      assert.deepEqual(r.body.pieces[0].stages.mood.decision.details, { selectedImages: [1, 2], annotations: 'keep the rim light' });
    } finally { decisions.restore(); }
    r = res(); await W.studio.handler(req({ method: 'POST', body: { action: 'nope' } }), r); assert.equal(r.statusCode, 400);
    r = res(); await W.studio.handler(req({ method: 'POST', body: { action: 'mood', pieceId: 'gen-mood1' }, session: false }), r); assert.equal(r.statusCode, 401);
  } finally { W.restore(); }
});

test('page: rMoodSet renders the four tiles with check badges and the selection, the direction with its palette, and the approve modal offers tile selection', async () => {
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('/api/studio?checks=') ? json({ count: 1, checks: [{ stage: 'mood', passed: false, prompt_version: 'vision-check-v1-2026-10-21', results: { images: [{ index: 0, pass: false, needsReview: false, flags: ['product missing'] }, { index: 1, pass: true, needsReview: false, flags: [] }, { index: 2, pass: true, needsReview: false, flags: [] }, { index: 3, pass: false, needsReview: true, flags: ['person unsure'] }] } }] }) : new Promise(() => {})) });
  try {
    const p = { id: 'gen-m', generated: true, studio: true, stage: 2, title: 'T', trend: 'T', product: 'Galaxy Z Flip8', markets: ['UAE'], platforms: ['tiktok'], th: ['#000000', '#111111'], map: { product: 'Galaxy Z Flip8', msg: 'm', angle: 'a' },
      mood: { images: [1, 2, 3, 4].map((n) => ({ url: `https://cdn/t${n}.png`, assetPath: `pieces/gen-m/mood/t${n}.png`, tag: ['palette', 'product', 'light', 'trend'][n - 1] })), imageUrl: 'https://cdn/t1.png', direction: DIRECTION, directionVersion: 'mood-direction-v1-2026-10-21', selection: { selectedImages: [1], annotations: 'keep the rim light' } } };
    X.PROJECTS.unshift(p);
    let html = X.rMoodSet(p);
    assert.match(html, /CHECKING…/, 'before the check loads');
    await new Promise((r) => setTimeout(r, 20));
    html = X.rMoodSet(p);
    assert.match(html, /TILE 1 · PALETTE/); assert.match(html, /FLAGGED/); assert.match(html, /product missing/); assert.match(html, /CHECKS PASSED/); assert.match(html, /NEEDS A LOOK/); assert.match(html, /person unsure/);
    assert.match(html, /SELECTED/); assert.match(html, /Reviewer:<\/b> keep the rim light/);
    assert.match(html, /Visual direction · Authentically grounded/); assert.match(html, /Samsung Blue #1428A0 · dominant/); assert.match(html, /data-asset="pieces\/gen-m\/mood\/t1\.png"/);
    assert.match(html, /mood-direction-v1-2026-10-21 · check vision-check-v1-2026-10-21 flagged/);
  } finally { X.restore(); }
});
