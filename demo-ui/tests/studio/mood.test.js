// Phase 6.2 — Moodboard: three moods (owner 2026-10-29) → one Hermes moodboard-bot set per mood, held to the product's
// 3D model → automated vision check → the person picks the mood the video follows. v1 single-direction sets still render.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, loadPage, HERMES_ENV, hermesFake } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const { validateDirection, validateMoods, setPrompt, tilePrompt } = require('../../api/_studio/mood.js');
const { verdict } = require('../../api/_studio/checks.js');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'k', CRON_SECRET: 'cron', ...HERMES_ENV };
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
  const H = hermesFake(); const hf = H.state;
  const f = mockFetch([
    ['api.anthropic.com', (u, init) => { const b = JSON.parse(init.body); const isCheck = /check generated campaign images/.test(b.system); return json({ content: [{ type: 'text', text: JSON.stringify(isCheck ? CHECK : DIRECTION) }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }); }],
    ...H.routes,
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

const MOOD = (name, setting, mood) => ({ ...Object.fromEntries(Object.entries(DIRECTION).filter(([k]) => k !== 'tiles')), name, pitch: `${name}: a one-line pitch`, setting, mood });
const OPTIONS = { options: [MOOD('Terrace Calm', 'sunlit Dubai apartment terrace', 'calm confidence'), MOOD('Neon Souk Rush', 'neon-lit souk alley at night', 'bold energy'), MOOD('Family Majlis Warmth', 'warm family majlis at dusk', 'warm and everyday')] };
const VIEW = (n) => `https://sb.test/storage/v1/object/public/refs/v${n}.jpg`;
const INDEX = { models: { 'galaxy-z-flip8': { slug: 'galaxy-z-flip8', product: 'Galaxy Z Flip8', views: [{ angle: 'front ¾', url: VIEW(1), hero: true }, { angle: 'back', url: VIEW(2) }] } } };
const CHECK6 = { images: [0, 1, 2, 3, 4, 5].map((i) => ({ ...CHECK.images[1], index: i, productMatchesCatalog: i === 1 ? 'no' : 'yes' })) };

function moodsWorld() {
  const pg = fakePostgrest();
  const H = hermesFake(); const hf = H.state;
  const visionCalls = [];
  const f = mockFetch([
    ['api.anthropic.com', (u, init) => { const b = JSON.parse(init.body); const isCheck = /check generated campaign images/.test(b.system); if (isCheck) visionCalls.push(b); return json({ content: [{ type: 'text', text: JSON.stringify(isCheck ? CHECK6 : OPTIONS) }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }); }],
    ...H.routes,
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\/products\/index\.json/.test(u) && (init.method || 'GET') === 'GET', () => new Response(JSON.stringify(INDEX), { status: 200 })],
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t` })],
    [/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV);
  return { pg, hf, f, visionCalls, studio, jobs, pieces, restore: () => { f.restore(); studio.restore(); jobs.restore(); pieces.restore(); } };
}

test('validateMoods: exactly three complete, differently named moods', () => {
  assert.deepEqual(validateMoods(OPTIONS), []);
  assert.ok(validateMoods({ options: OPTIONS.options.slice(0, 2) }).includes('options: exactly 3'));
  assert.ok(validateMoods({ options: [OPTIONS.options[0], OPTIONS.options[0], OPTIONS.options[1]] }).includes('options: the moods need different names'));
  assert.ok(validateMoods({ options: [{ ...OPTIONS.options[0], pitch: '' }, ...OPTIONS.options.slice(1)] }).includes('options[0].pitch: required'));
  assert.ok(validateMoods({ options: [{ ...OPTIONS.options[0], setting: 'a desk with an iPhone' }, ...OPTIONS.options.slice(1)] }).some((p) => /names a competitor/.test(p)));
  assert.match(setPrompt(OPTIONS.options[0], 'clamshell', true), /exact product from the reference renders of its 3D model \(identical shape, proportions, size/);
  assert.match(setPrompt(OPTIONS.options[0], 'clamshell', false), /exactly: clamshell/);
});

test('POST /api/studio action mood: three moods from Claude, one Hermes moodboard-bot job per mood (two images, the 3D model views as the strict product reference) submitted at once; each mood lands in its slots as it renders (the page poll drives it), a failed mood does not hold the others; vision checks hold the product to the 3D model; the person picks the mood and everything downstream follows it', async () => {
  const W = moodsWorld();
  const q = (sql) => sql; // readability
  try {
    let r = res(); await W.pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-mood1', stage: 'plan', artifact: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', trendName: 'Deadpan caption reveal' } } }), r);
    r = res(); await W.studio.handler(req({ method: 'POST', body: { action: 'mood', pieceId: 'gen-mood1', userInput: 'warm, calm' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.promptVersion, 'mood-direction-v2-2026-10-29'); assert.equal(r.body.productModel, 'galaxy-z-flip8');
    const art = r.body.artifact;
    assert.equal(art.setMode, 'moods'); assert.deepEqual(art.moods.map((m) => m.name), ['Terrace Calm', 'Neon Souk Rush', 'Family Majlis Warmth']); assert.equal(art.images.length, 6);
    assert.deepEqual(art.images.map((im) => im.mood), [1, 1, 2, 2, 3, 3]); assert.ok(art.images.every((im) => im.state === 'pending'));
    assert.equal(r.body.jobs.length, 3); assert.ok(r.body.jobs.every((j) => j.state === 'running'), 'all three submitted inside the request');
    assert.equal(W.hf.runs.length, 3); assert.ok(W.hf.runs.every((x) => x.profile === 'moodboard'));
    const in1 = JSON.parse(W.hf.runs[0].body.input);
    assert.equal(in1.count, 2); assert.equal(in1.aspect, '4:3'); assert.deepEqual(in1.product_image_urls, [VIEW(1), VIEW(2)], 'the 3D model views are the product reference');
    assert.match(in1.prompt, /^sunlit Dubai apartment terrace, featuring the exact product from the reference renders of its 3D model/); assert.match(JSON.parse(W.hf.runs[1].body.input).prompt, /^neon-lit souk alley at night/);
    assert.match(W.hf.runs[0].body.instructions, /STRICT PRODUCT RULE/); assert.match(W.hf.runs[0].body.instructions, /keep it out of frame rather than show a different one/);
    const claude = W.pg.tables.generation_records.find((g) => g.prompt_name === 'studio.mood.direction');
    assert.equal(claude.status, 'succeeded'); assert.match(claude.resolved_prompt || JSON.stringify(claude), /3D MODEL: yes/);
    const jobs = W.pg.tables.jobs.filter((j) => j.kind === 'hermes_image');
    assert.deepEqual(jobs.map((j) => j.payload.attachTo.mood), [1, 2, 3]); assert.ok(jobs.every((j) => j.payload.batch === 2 && j.payload.productModel === 'galaxy-z-flip8'));
    assert.equal(W.pg.tables.stages.find((s) => s.kind === 'mood').state, 'generating');
    // mood 1 renders first: the page's poll (not the minute tick) collects it
    const runOf = (j) => W.hf.runs.find((x) => j.provider_ref.endsWith(x.id));
    const states = {}; W.hf.status = (run) => states[run.id] || 'running';
    states[runOf(jobs[0]).id] = 'completed';
    for (const j of jobs) j.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await W.studio.handler(req({ method: 'GET', query: { shots: 'gen-mood1', stage: 'mood' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    let pl = r.body.payload;
    assert.equal(pl.moods[0].state, 'rendered'); assert.equal(pl.moods[1].state, 'pending'); assert.equal(r.body.live, 2);
    assert.ok(pl.images.slice(0, 2).every((im) => im.state === 'rendered' && im.assetPath && im.sha256)); assert.ok(pl.images.slice(2).every((im) => im.state === 'pending'));
    assert.equal(pl.version, undefined); assert.equal(r.body.version, 1, 'the images land in the same version');
    const vc1 = W.pg.tables.jobs.find((j) => j.kind === 'vision_check' && j.payload.mood === 1);
    assert.ok(vc1, 'mood 1 is checked as soon as it lands'); assert.deepEqual(vc1.payload.images.map((i) => i.index), [0, 1]); assert.deepEqual(vc1.payload.productViews, [VIEW(1), VIEW(2)]);
    // mood 2 fails, mood 3 renders: the stage settles with what rendered
    states[runOf(jobs[1]).id] = 'failed'; states[runOf(jobs[2]).id] = 'completed';
    for (const j of jobs) if (j.state === 'running') j.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await W.studio.handler(req({ method: 'GET', query: { shots: 'gen-mood1', stage: 'mood' } }), r);
    pl = r.body.payload;
    assert.equal(r.body.live, 0); assert.equal(pl.moods[1].state, 'failed'); assert.match(pl.moods[1].error, /tool crashed/); assert.deepEqual(pl.images.map((im) => im.state), ['rendered', 'rendered', 'failed', 'failed', 'rendered', 'rendered']);
    assert.equal(W.pg.tables.stages.find((s) => s.kind === 'mood').state, 'generated');
    // the tick runs both vision checks, with the 3D model views shown first
    r = res(); await W.jobs.handler(req({ headers: { authorization: 'Bearer cron' }, session: false }), r);
    assert.equal(r.body.states.succeeded, 2, JSON.stringify(r.body));
    const sc = W.pg.tables.stage_checks.filter((c) => c.kind === 'vision');
    assert.deepEqual(sc.map((c) => c.results.mood).sort(), [1, 3]); assert.ok(sc.every((c) => c.results.productModel === true));
    const sc1 = sc.find((c) => c.results.mood === 1);
    assert.deepEqual(sc1.results.images.find((i) => i.index === 1).flags, ['product does not match the 3D model']); assert.equal(sc1.results.images.find((i) => i.index === 1).pass, false);
    assert.equal(W.visionCalls[0].messages[0].content[0].text, 'PRODUCT 3D MODEL VIEW 1 (the exact product every image must show):'); assert.equal(W.visionCalls[0].messages[0].content[1].source.url, VIEW(1));
    assert.match(W.visionCalls[0].messages[0].content.at(-1).text, /PRODUCT 3D MODEL: 2 view\(s\) shown first/);
    // until a pick, the first rendered mood stands in downstream
    const { moodContext } = require('../../api/_studio/thumb.js');
    const pieceUuid = W.pg.tables.content_pieces.find((p) => p.legacy_id === 'gen-mood1').id;
    let mc = await moodContext(pieceUuid);
    assert.deepEqual(mc.chosen, { n: 1, name: 'Terrace Calm', pitch: 'Terrace Calm: a one-line pitch', picked: false }); assert.equal(mc.direction.setting, 'sunlit Dubai apartment terrace'); assert.deepEqual(mc.tiles.map((t) => t.index), [0, 1]);
    // the person picks: a failed mood cannot be picked; mood 3 can, and the brief, storyboard and cover follow it
    r = res(); await W.studio.handler(req({ method: 'POST', body: { action: 'mood-pick', pieceId: 'gen-mood1', mood: 2 } }), r);
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'not_ready');
    r = res(); await W.studio.handler(req({ method: 'POST', body: { action: 'mood-pick', pieceId: 'gen-mood1', mood: 3 } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.chosen, 3); assert.equal(r.body.payload.direction.setting, 'warm family majlis at dusk');
    mc = await moodContext(pieceUuid);
    assert.deepEqual(mc.chosen, { n: 3, name: 'Family Majlis Warmth', pitch: 'Family Majlis Warmth: a one-line pitch', picked: true }); assert.deepEqual(mc.tiles.map((t) => t.index), [4, 5]);
    assert.ok(W.pg.tables.audit_log.some((a) => a.action === 'mood.pick'));
    // the approval names the mood; it wins over the earlier pick, and an approved moodboard cannot be re-picked
    const decisions = api('decisions.js', ENV);
    try {
      r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-mood1', stage: 'mood', decision: 'approved', name: 'N', role: 'reviewer', details: { chosenMood: 1, selectedImages: [0, 1], annotations: 'keep the rim light' } } }), r);
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    } finally { decisions.restore(); }
    mc = await moodContext(pieceUuid);
    assert.equal(mc.chosen.n, 1); assert.equal(mc.approved, true); assert.equal(mc.annotations, 'keep the rim light');
    r = res(); await W.studio.handler(req({ method: 'POST', body: { action: 'mood-pick', pieceId: 'gen-mood1', mood: 3 } }), r);
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'approved_immutable');
    void q;
  } finally { W.restore(); }
});

test('page: three moods to pick from — each card shows its images as they land (spinner while rendering), check badges, palette and pitch; "Use this mood" on the others; the picked one is marked', async () => {
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('/api/studio?checks=') ? json({ count: 1, checks: [{ kind: 'vision', stage: 'mood', results: { mood: 1, productModel: true, images: [{ index: 0, pass: true, needsReview: false, flags: [] }, { index: 1, pass: false, needsReview: false, flags: ['product does not match the 3D model'] }] } }] })
    : String(u).includes('/api/studio?shots=') ? json({ stage: 'mood', live: 0, checksPending: 0, version: 1, payload: null }) // the poll a rendering mood starts ends at once
    : new Promise(() => {})) });
  try {
    const moods = OPTIONS.options.map((o, i) => ({ n: i + 1, name: o.name, pitch: o.pitch, direction: o, state: i === 2 ? 'pending' : 'rendered' }));
    const images = [1, 1, 2, 2, 3, 3].map((m, i) => ({ mood: m, state: m === 3 ? 'pending' : 'rendered', url: m === 3 ? null : `https://cdn/m${i}.png`, assetPath: m === 3 ? null : `pieces/gen-m/mood/m${i}.png`, tag: `x · ${i}` }));
    const p = { id: 'gen-m', generated: true, studio: true, stage: 1, title: 'T', trend: 'T', product: 'Galaxy Z Flip8', markets: ['UAE'], platforms: ['tiktok'], th: ['#000000', '#111111'], map: { product: 'Galaxy Z Flip8', msg: 'm', angle: 'a' },
      mood: { setMode: 'moods', moods, images, chosen: 2, direction: moods[1].direction, directionVersion: 'mood-direction-v2-2026-10-29' } };
    X.PROJECTS.unshift(p);
    X.BOARD_POLL['gen-m:mood'] = 1; // a poll already running: the render must not start a second one
    X.rMoodSet(p, false);
    await new Promise((r) => setTimeout(r, 20));
    const html = X.rMoodSet(p, false);
    assert.match(html, /Terrace Calm/); assert.match(html, /Neon Souk Rush/); assert.match(html, /Family Majlis Warmth/); assert.match(html, /Terrace Calm: a one-line pitch/);
    assert.match(html, /MOOD 2<\/span><span[^>]*>✓ THE VIDEO FOLLOWS THIS MOOD/); assert.match(html, /follow <b>Neon Souk Rush<\/b>/);
    assert.equal((html.match(/Use this mood/g) || []).length, 1, 'only the other rendered mood can be picked (mood 3 is still rendering)');
    assert.match(html, /onclick="moodPick\('gen-m',1\)"/); assert.match(html, /Rendering…/);
    assert.match(html, /product does not match the 3D model/); assert.match(html, /✓ CHECKS/); assert.match(html, /data-asset="pieces\/gen-m\/mood\/m0\.png"/);
    assert.match(html, /Picked mood · Neon Souk Rush/); assert.match(html, /background:#1428A0/);
    assert.doesNotMatch(X.rMoodSet(p, true), /Use this mood/, 'an approved moodboard is not re-picked');
  } finally { X.restore(); }
});

test('page (v1 sets): rMoodSet renders the four tiles with check badges and the selection, the direction with its palette, and the approve modal offers tile selection', async () => {
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
