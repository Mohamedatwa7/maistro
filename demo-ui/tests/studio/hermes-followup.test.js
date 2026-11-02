// Owner 2026-11-02 follow-up (Khaled): the storyboard is in the pipeline and the video starts on its keyframe;
// every bot gets official product images; production budgets have floors; the Galaxy Z Fold8 family is the
// weighted default for new ideas; a campaign's product is locked once anything is approved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { api, req, res, mockFetch, json, loadPage } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const C = require('../../api/_studio/hermes-contract.js');
const H = require('../../api/_adapters/hermes.js');

const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test('dry run: brief → moodboard → storyboard → thumbnail → video → review; the video request carries first_frame_url (the storyboard keyframe); every request has the official product images and max_credits 1', async () => {
  const { runPipeline } = require('../../scripts/hermes-dryrun.js');
  const replies = { 'maistro-storyboard': null };
  const f = mockFetch([
    [(u, init) => /^https:\/\/gw\.test\/p\/[\w-]+\/v1\/runs$/.test(u) && init.method === 'POST', (u) => json({ run_id: `run_${u.split('/p/')[1].split('/')[0]}`, status: 'queued' }, 202)],
    [/^https:\/\/gw\.test\/p\/([\w-]+)\/v1\/runs\/run_/, (u) => {
      const prof = /\/p\/([\w-]+)\//.exec(u)[1];
      const body = prof === 'maistro-organizer' ? { review: [], story_check: 'ok', miscommunications: [], fixes_requested: [] }
        : prof === 'maistro-brief' ? { brief: { keyMessage: 'k' } }
        : prof === 'maistro-video' ? { video: 'dry-run', note: 'dry run', qa: { verdict: 'warn' } }
        : prof === 'maistro-storyboard' && replies[prof] ? { frames: [{ index: 2, image: replies[prof] }], note: 'n' }
        : { images: ['dry-run'], note: 'dry run', qa: { verdict: 'warn' }, budget_blocked_retry: true };
      return json({ status: 'completed', output: '```json\n' + JSON.stringify(body) + '\n```' });
    }],
  ]);
  try {
    await withEnv({ HERMES_API_URL: 'https://gw.test', HERMES_API_KEY: 'k', MAISTRO_NO_RENDER: '' }, async () => {
      let o = await runPipeline({ pollMs: 1 });
      assert.deepEqual(o.order, ['maistro-brief', 'maistro-moodboard', 'maistro-storyboard', 'maistro-thumbnail', 'maistro-video', 'maistro-organizer'], 'the storyboard runs, before the thumbnail and the video');
      assert.deepEqual(o.product, { family: 'Galaxy Z Fold8', colour: 'Cream', model_code: 'SM-F971BZWIMEA' });
      for (const [step, inp] of Object.entries(o.requests)) {
        if (step === 'brief' || step === 'review') continue; // text tasks: the brief carries the images in its task text
        assert.ok(inp.product_image_urls.length >= 2 && inp.product_image_urls.length <= 4, `${step}: 2–4 official images`);
        assert.equal(inp.max_credits, 1, `${step}: TEST MODE cap`);
      }
      assert.match(JSON.stringify(o.requests.brief), /galaxy-z-fold8\/cream-front\.jpg/, 'the brief bot gets the images too');
      const b = o.requests.board;
      assert.equal(b.shot_index, 2); assert.equal(b.shot_count, 3); assert.ok(b.story.logline); assert.equal(b.shot_list.length, 3); assert.deepEqual(b.previous_keyframe_urls, []);
      assert.ok(o.requests.video.first_frame_url, 'the video always gets a first frame'); assert.equal(o.firstFrame.standIn, true, 'TEST MODE: the storyboard made no image, the official front stands in');
      assert.equal(o.requests.video.first_frame_url, o.productImages[0]);
      // when the storyboard bot returns a keyframe, the video starts on exactly that frame
      replies['maistro-storyboard'] = 'https://cdn.test/keyframe-2.png';
      o = await runPipeline({ pollMs: 1, only: ['board', 'video'] });
      assert.deepEqual(o.order, ['maistro-storyboard', 'maistro-video']); assert.equal(o.requests.video.first_frame_url, 'https://cdn.test/keyframe-2.png'); assert.equal(o.firstFrame.standIn, false);
      await assert.rejects(runPipeline({ campaign: 'gen-real1' }), /zz… test campaign/);
    });
  } finally { f.restore(); }
});

test('official images: every product with a spec × every colourway × every bot gets 2–4 https images that ship in assets/ (folds include the open view); other colourways never get them', () => {
  for (const [family, spec] of Object.entries(C.PRODUCT_SPECS)) {
    for (const colour of Object.keys(spec.codes)) {
      const ps = C.productSpec({ family, colour });
      assert.equal(ps.model_code, spec.codes[colour]);
      const imgs = C.productImages(ps, null, []);
      assert.ok(imgs.length >= 2 && imgs.length <= 4, `${family} ${colour}: ${imgs.length} images`);
      for (const u of imgs) {
        assert.match(u, /^https:\/\/www\.ma1stro\.com\/assets\/products\//);
        assert.ok(fs.existsSync(path.join(__dirname, '../..', new URL(u).pathname)), `${u} ships in assets/`);
      }
      if (/fold/i.test(family)) assert.ok(imgs.some((u) => /open-front/.test(u)), `${family} ${colour}: the open view`);
      for (const role of ['mood', 'thumb', 'board', 'video']) {
        const inp = JSON.parse(H.renderRun({ prompt: 'p', productSpec: ps, productImages: imgs }, role).input);
        assert.ok(inp.product_image_urls.length >= 2, `${family} ${colour} → ${role}: product_image_urls is never empty`);
      }
    }
  }
  assert.deepEqual(C.productSpec({ family: 'Galaxy Z Fold8 Ultra', colour: 'violet shadow' }), { family: 'Galaxy Z Fold8 Ultra', colour: 'Violet Shadow', model_code: 'SM-F976BZVOMEA' });
  assert.deepEqual(C.productSpec({ family: 'Galaxy Z Fold8' }).colour, 'Cream', 'the default colourway');
  assert.ok(C.productImages(C.productSpec({ family: 'Galaxy Z Fold8', colour: 'Graphite' }), null, []).every((u) => /graphite-/.test(u)), 'only that colourway');
  assert.deepEqual(C.coloursOf('galaxy z fold8 ultra'), ['Cream', 'Graphite', 'Violet Shadow']);
});

test('production budgets never go below the floors (keyframe ≥ 6, thumbnail ≥ 6, moodboard ≥ count × 2 × 3, 4 s 720p video 18–23), whatever the overrides; the env TEST MODE switch is ignored in production', async () => {
  const floors = (role, payload) => JSON.parse(H.renderRun({ prompt: 'p', ...payload }, role).input).max_credits;
  const check = () => {
    assert.ok(floors('board', {}) >= 6); assert.ok(floors('thumb', {}) >= 6);
    for (const n of [1, 2, 4, 8]) assert.ok(floors('mood', { batch: n }) >= (n > 1 ? n : 1) * 2 * 3, `moodboard ×${n}`);
    const v = floors('video', { duration: 4, resolution: '720p' }); assert.ok(v >= 18 && v <= 23, `video ${v}`);
  };
  check();
  await withEnv({ VERCEL_ENV: 'production', MAISTRO_HERMES_TEST_MODE: '1', MAISTRO_HERMES_BUDGETS: '{"keyframe":1,"thumb":1,"moodPerImage":1,"videoHeadroom":0.5,"cap":2}' }, async () => {
    check();
    assert.doesNotMatch(H.renderRun({ prompt: 'p' }, 'board').instructions, /TEST MODE/, 'production never runs in TEST MODE from the env');
    assert.equal(JSON.parse(H.renderRun({ prompt: 'p', testMode: true }, 'board').input).max_credits, 1, 'only an explicit test job carries the cap');
  });
  await withEnv({ VERCEL_ENV: 'preview', MAISTRO_HERMES_TEST_MODE: '1' }, async () => { assert.equal(floors('board', {}), 1, 'outside production the env switch still works for tests'); });
});

test('Z Fold8 focus: about half of new ideas (MAISTRO_FOCUS_WEIGHT) feature the Fold8 family with the unfold as the moment — never when the user named a product; the catalog has the Fold8 Ultra even before the KB does', () => {
  assert.equal(C.focusWeight(), 0.5);
  let hits = 0; for (let i = 0; i < 1000; i++) if (C.focusPick({ rand: () => i / 1000 })) hits++;
  assert.equal(hits, 500, 'half by default');
  assert.equal(C.focusPick({ userProduct: 'Galaxy S26 Ultra', rand: () => 0 }), false, 'the user picked a product');
  assert.equal(C.focusPick({ userText: 'a funny ad for the Bespoke AI Fridge', rand: () => 0 }), false);
  assert.equal(C.focusPick({ userText: 'something for the s26', rand: () => 0 }), false);
  assert.equal(C.focusPick({ userText: 'Ramadan night drive', rand: () => 0 }), true);
  process.env.MAISTRO_FOCUS_WEIGHT = '0'; try { assert.equal(C.focusPick({ rand: () => 0 }), false); } finally { delete process.env.MAISTRO_FOCUS_WEIGHT; }
  process.env.MAISTRO_FOCUS_WEIGHT = '1'; try { assert.equal(C.focusPick({ rand: () => 0.999 }), true); } finally { delete process.env.MAISTRO_FOCUS_WEIGHT; }
  assert.match(C.FOCUS_INSTRUCTION, /Galaxy Z Fold8 or the Galaxy Z Fold8 Ultra/); assert.match(C.FOCUS_INSTRUCTION, /UNFOLD is the story's product moment/);
  const { PRODUCT_CATALOG } = require('../../api/_brand.js');
  assert.ok(PRODUCT_CATALOG.some((p) => p.name === 'Galaxy Z Fold8 Ultra'));
  const { buildPrompts } = require('../../api/_kb/seed.js');
  const kbWithoutUltra = [{ kind: 'product_catalog', key: 'Galaxy Z Fold8', content: { name: 'Galaxy Z Fold8', look: 'kb look' } }];
  const pp = buildPrompts(kbWithoutUltra).PRODUCTS_PROMPT;
  assert.match(pp, /- Galaxy Z Fold8: kb look/, 'the KB entry wins'); assert.match(pp, /- Galaxy Z Fold8 Ultra: /, 'the code catalog fills in what the KB lacks');
});

test('the product lock: a re-plan before any approval changes the campaign product (on the audit log, never silently); once anything is approved a different product is refused', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  const pieces = api('pieces.js', ENV); const decisions = api('decisions.js', ENV);
  const PLAN = (product) => ({ pieceId: 'gen-lock1', stage: 'plan', artifact: { title: 'L', product, msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#000000', '#111111'] }, piece: { title: 'L', product: 'Planning…' } });
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: PLAN('Galaxy S26 Ultra') }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const piece = () => pg.tables.content_pieces.find((x) => x.legacy_id === 'gen-lock1');
    assert.equal(piece().product, 'Galaxy S26 Ultra', 'the placeholder "Planning…" is replaced by the planned product');
    r = res(); await pieces.handler(req({ method: 'POST', body: PLAN('Galaxy Z Fold8') }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(piece().product, 'Galaxy Z Fold8'); assert.deepEqual(r.body.productChanged, { from: 'Galaxy S26 Ultra', to: 'Galaxy Z Fold8' });
    assert.ok(pg.tables.audit_log.some((a) => a.action === 'piece.product' && a.after.product === 'Galaxy Z Fold8' && a.before.product === 'Galaxy S26 Ultra'));
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-lock1', stage: 'plan', decision: 'approved', name: 'N', role: 'reviewer' } }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    r = res(); await pieces.handler(req({ method: 'POST', body: PLAN('Galaxy Z Flip8') }), r);
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'product_locked'); assert.match(r.body.error, /locked to Galaxy Z Fold8/); assert.equal(piece().product, 'Galaxy Z Fold8');
  } finally { f.restore(); pieces.restore(); decisions.restore(); }
});

test('page: the moodboard bot\'s Fold8 swap ideas show "Try with Z Fold8" (a new campaign — this one keeps its product); the colour field offers the known colourways', () => {
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    const p = { id: 'gen-sw1', generated: true, studio: true, stage: 2, title: 'Night Drive', product: 'Galaxy S26 Ultra', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'Galaxy S26 Ultra', msg: 'm', angle: 'a' },
      mood: { setMode: 'moods', version: 'v1', images: [{ mood: 1, state: 'rendered', url: 'https://x/1.png' }], moods: [{ n: 1, name: 'Dusk', state: 'rendered', direction: { setting: 'rooftop' }, swapProposals: ['Swap the phone for the Galaxy Z Fold8 Ultra half unfolded on the ledge', 'Warmer light'] }] } };
    X.PROJECTS.unshift(p);
    const html = X.rMoodPick(p, false);
    assert.match(html, /Swap ideas from the moodboard bot \(2\)/); assert.match(html, /foldTry\('gen-sw1',1,0\)[^>]*>Try with Z Fold8 Ultra →/);
    assert.equal((html.match(/foldTry\(/g) || []).length, 1, 'only the Fold8 idea gets the button');
    p.product = 'Galaxy Z Fold8'; assert.doesNotMatch(X.rMoodPick(p, false), /foldTry\(/, 'already a Fold8 campaign');
    assert.match(X.rColour({ id: 'c1', product: 'Galaxy Z Fold8 Ultra' }), /<option value="Violet Shadow">/);
  } finally { X.restore(); }
});
