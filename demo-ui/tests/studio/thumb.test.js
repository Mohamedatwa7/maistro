// Phase 6.3 — Thumbnail: anchored to the approved moodboard, platform aspect, headline as a code overlay
// inside the safe zone, vision check against the selected mood tiles, composite stored as a manual version.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, loadPage, HERMES_ENV, hermesFake } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const T = require('../../api/_studio/thumb.js');
const { verdict } = require('../../api/_studio/checks.js');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'k', CRON_SECRET: 'cron', ...HERMES_ENV };
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
const DIRECTION = { setting: 'terrace', lighting: 'warm rim light', mood: 'calm', styling: 'matte', wardrobe: 'linen', compositionStyle: 'negative space', cameraFeel: '50 mm', trendAdaptation: 'x', leadingPrinciple: 'Boldly lead', palette: [{ name: 'Samsung Blue', hex: '#1428A0', role: 'dominant' }], tiles: [{ tag: 'palette', demonstrates: 'colours', prompt: 'a' }, { tag: 'product', demonstrates: 'device', prompt: 'b' }, { tag: 'light', demonstrates: 'light', prompt: 'c' }, { tag: 'trend', demonstrates: 'mechanic', prompt: 'd' }] };
const THUMB = { prompt: 'The exact product from the reference image half-open on a terrace at golden hour, Samsung Blue #1428A0 accents, warm rim light, shallow depth, clean negative space on the left', textSide: 'left', note: 'Continues the moodboard: warm rim light and the blue accent.' };
const CHECK = { images: [{ index: 0, productPresent: 'yes', productMatchesCatalog: 'yes', competitorOrLogo: 'no', realPerson: 'no', textInImage: 'no', prohibitedImagery: 'no', paletteMatch: 'yes', lightingMatch: 'yes', culturalOk: 'yes', consistentWithMood: 'partial', textSpaceClear: 'yes', notes: 'ok' }] };

test('aspectFor follows the platforms; overlayBox stays inside the safe zone; validateThumb rejects text-in-image asks and competitors', () => {
  assert.equal(T.aspectFor(['tiktok', 'instagram']), '9:16'); assert.equal(T.aspectFor(['tiktok', 'youtube']), '16:9'); assert.equal(T.aspectFor([]), '16:9');
  const b = T.overlayBox('9:16', 'right');
  assert.equal(b.top, 0.13); assert.equal(b.bottom, 0.34); assert.ok(b.left + b.width <= 1 - 0.06 + 1e-9); assert.equal(b.width, 0.84);
  assert.deepEqual(T.validateThumb(THUMB), []);
  assert.ok(T.validateThumb({ ...THUMB, prompt: 'A bold headline reading SNAP over the phone' }).some((p) => /text inside the image/.test(p)));
  assert.ok(T.validateThumb({ ...THUMB, prompt: 'An iPhone on a desk' }).some((p) => /competitor/.test(p)));
  assert.ok(T.validateThumb({ ...THUMB, textSide: 'top' }).some((p) => /textSide/.test(p)));
  assert.deepEqual(verdict({ ...CHECK.images[0], consistentWithMood: 'no', textSpaceClear: 'no' }, true).flags, ['inconsistent with the moodboard', 'reserved text side is not clear']);
});

test('POST /api/studio action thumb: needs a moodboard; anchors to the approved selection; platform aspect; product photo on the reference path; overlay spec on the artifact; vision check with anchors; composite stored as a manual version', async () => {
  const pg = fakePostgrest();
  const H = hermesFake(); const hf = H.state; let visionBody = null;
  const f = mockFetch([
    ['api.anthropic.com', (u, init) => { const b = JSON.parse(init.body); if (/check generated campaign images/.test(b.system)) { visionBody = b; return json({ content: [{ type: 'text', text: JSON.stringify(CHECK) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); } return json({ content: [{ type: 'text', text: JSON.stringify(THUMB) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); }],
    ...H.routes,
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t` })],
    [/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV); const decisions = api('decisions.js', ENV);
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-th1', stage: 'plan', artifact: { title: 'Slim', product: 'Galaxy Z Flip8', msg: 'Slimness check', markets: ['UAE'], platforms: ['tiktok', 'instagram'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'Slim', product: 'Galaxy Z Flip8', msg: 'Slimness check', platforms: ['tiktok', 'instagram'], markets: ['UAE'] } } }), r);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'thumb', pieceId: 'gen-th1' } }), r);
    assert.equal(r.statusCode, 409, 'no moodboard yet'); assert.equal(r.body.code, 'prerequisites');
    // a moodboard set, approved with tiles 1 and 2 selected
    r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-th1', stage: 'mood', artifact: { imageUrl: 'https://cdn/m0.png', images: [0, 1, 2, 3].map((i) => ({ url: `https://cdn/m${i}.png`, assetPath: `pieces/gen-th1/mood/m${i}.png`, tag: DIRECTION.tiles[i].tag })), direction: DIRECTION, prompt: 'p', note: 'n' } } }), r); assert.equal(r.statusCode, 200);
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-th1', stage: 'mood', decision: 'approved', name: 'N', role: 'reviewer', details: { selectedImages: [1, 2], annotations: 'keep the rim light' } } }), r); assert.equal(r.statusCode, 200);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'thumb', pieceId: 'gen-th1', userInput: 'bold', headline: 'Slimness check: passed.', headlineAr: 'اختبار النحافة: ناجح', refImage: 'https://sb.test/storage/v1/object/public/refs/products/flip.jpg' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.aspect, '9:16', 'TikTok + Reels → vertical cover'); assert.equal(r.body.moodApproved, true); assert.equal(r.body.anchors, 2); assert.equal(r.body.textSide, 'left');
    assert.equal(hf.last.profile, 'thumbnail'); assert.match(hf.last.body.input, /PRODUCT REFERENCE PHOTO[^.]*: https:\/\/sb\.test\/storage\/v1\/object\/public\/refs\/products\/flip\.jpg/, 'the product photo goes to the bot'); assert.match(hf.last.body.input, /aspect ratio 9:16, 1080p/);
    assert.match(hf.last.body.input, /APPROVED MOODBOARD IMAGES[\s\S]*m1\.png\?token=t[\s\S]*m2\.png\?token=t/, 'the selected mood tiles, signed, are the bot’s style anchors');
    const job = pg.tables.jobs.find((j) => j.kind === 'hermes_image' && j.payload.stage === 'thumb');
    assert.equal(job.payload.meta.overlay.headline, 'Slimness check: passed.'); assert.equal(job.payload.meta.overlay.headlineAr, 'اختبار النحافة: ناجح'); assert.equal(job.payload.meta.overlay.box.top, 0.13); assert.deepEqual(job.payload.meta.anchors.map((a) => a.index), [1, 2]);
    assert.ok(pg.tables.generation_records.some((g) => g.prompt_name === 'studio.thumb.prompt' && g.status === 'succeeded' && g.params.refAttached === true && g.params.aspect === '9:16'));
    // render completes → overlay spec on the artifact, vision check queued with the two anchors
    hf.status = 'completed'; job.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await jobs.handler(req({ method: 'GET', query: { id: job.id } }), r);
    assert.equal(r.body.job.state, 'succeeded'); const art = r.body.job.result.artifact;
    assert.equal(art.overlay.headline, 'Slimness check: passed.'); assert.equal(art.textSide, 'left'); assert.equal(art.promptVersion, 'thumb-prompt-v1-2026-10-21'); assert.equal(art.moodApproved, true); assert.ok(art.assetPath);
    const check = pg.tables.jobs.find((j) => j.kind === 'vision_check');
    assert.equal(check.payload.anchors.length, 2); assert.equal(check.payload.textSide, 'left'); assert.equal(check.payload.expectProduct, true);
    r = res(); await jobs.handler(req({ headers: { authorization: 'Bearer cron' }, session: false }), r);
    assert.equal(r.body.states.succeeded, 1, JSON.stringify(r.body));
    assert.equal(visionBody.messages[0].content.filter((c) => c.type === 'image').length, 3, 'two anchors + the candidate'); assert.match(visionBody.messages[0].content[0].text, /ANCHOR \(approved moodboard tile 2\)/);
    const sc = pg.tables.stage_checks.at(-1); assert.equal(sc.passed, true); assert.equal(sc.results.images[0].consistentWithMood, 'partial'); assert.equal(sc.prompt_version, 'vision-check-v1.2-2026-10-21');
    // composite: the page draws the headline and stores the PNG as a manual version
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'thumb-composite', pieceId: 'gen-th1', data: Buffer.from(PNG).toString('base64'), overlay: { ...art.overlay, baseAssetPath: art.assetPath } } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.version, 2); assert.match(r.body.assetPath, /^pieces\/gen-th1\/thumb\/composite-/);
    const v2 = pg.tables.artifact_versions.find((v) => v.id === r.body.versionId);
    assert.equal(v2.produced_by, 'manual'); assert.equal(v2.payload.composite, true); assert.equal(v2.payload.baseAssetPath, art.assetPath); assert.equal(v2.payload.overlay.headlineAr, 'اختبار النحافة: ناجح');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'thumb-composite', pieceId: 'gen-th1', data: Buffer.from('notpng').toString('base64'), overlay: { headline: 'x' } } }), r); assert.equal(r.statusCode, 422);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'thumb-composite', pieceId: 'gen-th1', data: Buffer.from(PNG).toString('base64'), overlay: {} } }), r); assert.equal(r.statusCode, 422, 'needs a headline');
  } finally { f.restore(); studio.restore(); jobs.restore(); pieces.restore(); decisions.restore(); }
});

test('page: the cover renders the headline overlay inside the safe-zone box with RTL for Arabic, badges for aspect/check/composite, and offers compositing only when there is a stored copy and a headline', async () => {
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('/api/studio?checks=') ? json({ count: 1, checks: [{ stage: 'thumb', passed: true, results: { images: [{ index: 0, pass: true, needsReview: false, flags: [] }] } }] }) : new Promise(() => {})) });
  try {
    assert.equal(X.thumbAspectFor({ platforms: ['tiktok'] }), '9:16'); assert.equal(X.thumbAspectFor({ platforms: ['tiktok', 'youtube'] }), '16:9');
    const p = { id: 'gen-t', generated: true, studio: true, stage: 3, title: 'T', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'Galaxy Z Flip8', msg: 'm', angle: 'a' },
      mood: { imageUrl: 'https://cdn/m.png' }, thumb: { imageUrl: 'https://cdn/c.png', assetPath: 'pieces/gen-t/thumb/c.png', overlay: { headline: 'Slimness check: passed.', headlineAr: 'اختبار', side: 'left', aspect: '9:16', box: { top: 0.13, bottom: 0.34, left: 0.06, width: 0.84, safeZone: { top: 0.13, bottom: 0.34, left: 0.06, right: 0.06 } } }, textSide: 'left', moodApproved: true, note: 'n' } };
    X.PROJECTS.unshift(p);
    let html = X.stageArtifact(p, 2);
    assert.match(html, /aspect-ratio:9\/16/); assert.match(html, /left:6%;top:13%;width:84%;bottom:34%/); assert.match(html, /dir="rtl"[^>]*>اختبار</); assert.match(html, /dir="ltr"[^>]*>Slimness check: passed\.</);
    assert.match(html, /9:16 COVER/); assert.match(html, /OVERLAY PREVIEW · SAFE ZONE/); assert.match(html, /Compose cover with headline/); assert.match(html, /CHECKING…/);
    await new Promise((r) => setTimeout(r, 20)); html = X.stageArtifact(p, 2); assert.match(html, /CHECKS PASSED/);
    p.thumb = { ...p.thumb, composite: true, imageUrl: null, version: 'v2' }; html = X.stageArtifact(p, 2);
    assert.match(html, /HEADLINE COMPOSITED/); assert.ok(!/Compose cover with headline/.test(html)); assert.ok(!/left:6%;top:13%/.test(html), 'no preview overlay on the composited cover');
  } finally { X.restore(); }
});
