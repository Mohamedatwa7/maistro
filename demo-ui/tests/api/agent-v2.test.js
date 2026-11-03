// The agent ingest additions of 2026-11-03 (MAISTRO_OWNER_REQUEST.md, docs/agent-ingest.md): GET /me, the product
// lock with supporting products, carousel slides, video variants, audio tracks, compliance metadata, signed uploads,
// reviewer comments and the webhook, campaign listing, external_ref, and test campaigns with DELETE.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { api, req, res, mockFetch, json, HERMES_ENV } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const KEY = 'agent-test-key-0123456789';
const SECRET = 'hook-secret-abc';
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ...HERMES_ENV, AGENT_INGEST_KEY: KEY, HERMES_WEBHOOK_SECRET: SECRET, HERMES_WEBHOOK_URL: 'https://hooks.test/maistro' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0]);
const MP4B = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 1]);
const M4A = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0]);
const FRIDGE = { title: 'Fridge Girly', trend: { id: 't-fg', name: 'Fridge Girly' }, product: { family: 'Galaxy Z Flip8', colour: 'Pink' }, supporting_products: [{ family: 'Galaxy Buds4', colour: 'White' }], markets: ['UAE'], platforms: ['tiktok'], source: 'hermes', external_ref: 'fridge-girly-2026-11' };
const COMPLIANT = { guidelines_version: '2026-11-02', characters: 'stylised_3d', realistic_humans: false, ai_generated_samsung_device: false, product_sources: [{ product: 'Galaxy Buds4 White', source: 'official_product_image' }, { product: 'Galaxy Z Flip8 box', source: 'ai_render_from_official_box_refs' }], third_party_logos: false, alcohol: false };

function world() {
  const pg = fakePostgrest();
  const uploaded = new Map(); // storage path → bytes Hermes PUT to the signed upload URL
  const hooks = [];
  const f = mockFetch([
    ['https://hermes.test/files/slide1.png', () => new Response(PNG, { status: 200 })],
    ['https://hermes.test/files/slide1b.png', () => new Response(PNG2, { status: 200 })],
    ['https://hermes.test/files/music.mp4', () => new Response(MP4, { status: 200 })],
    ['https://hermes.test/files/silent.mp4', () => new Response(MP4B, { status: 200 })],
    ['https://hermes.test/files/track.m4a', () => new Response(M4A, { status: 200 })],
    [/\/storage\/v1\/object\/upload\/sign\/assets\//, (u) => json({ url: `/object/upload/sign/assets/${String(u).split('/upload/sign/assets/')[1]}?token=up` })],
    [/\/storage\/v1\/object\/sign\/assets\/agent-uploads\/.*\?token=t$/, (u) => { const p = decodeURIComponent(String(u).split('/sign/assets/')[1].split('?')[0]); return uploaded.has(p) ? new Response(uploaded.get(p), { status: 200 }) : new Response('{}', { status: 404 }); }],
    [/\/storage\/v1\/object\/sign\/assets\//, (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/sign/assets/')[1]}?token=t` })],
    [/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })],
    ['https://hooks.test/maistro', (u, init) => { hooks.push({ headers: init.headers, body: init.body }); return json({ ok: true }); }],
    pg.route,
  ]);
  const h = api('[route].js', ENV);
  const call = async (method, path, body, headers = {}, query = {}) => {
    const r = res();
    await h.handler(req({ method, body, query: { route: 'agent', path, ...query }, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers }, session: false }), r);
    return r;
  };
  const studio = async (route, method, body, query = {}) => { const r = res(); await h.handler(req({ method, body, query: { route, ...query } }), r); return r; };
  const draft = async (id) => (await call('GET', `campaigns/${id}`)).body.stages.draft.version.payload;
  return { pg, uploaded, hooks, call, studio, draft, restore: () => { f.restore(); h.restore(); } };
}

test('agent ingest: GET /me checks the key without creating anything and never echoes it (2026-11-03)', async () => {
  const W = world();
  try {
    let r = await W.call('GET', 'me');
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.source, 'hermes'); assert.match(r.body.keyId, /^ak_[0-9a-f]{12}$/); assert.equal(r.body.expiresAt, null);
    assert.ok(r.body.scopes.includes('campaigns:write_drafts')); assert.ok(!r.body.scopes.some((s) => /approve|publish/.test(s)));
    assert.ok(r.body.products.products.includes('Galaxy Z Flip8'));
    assert.ok(!JSON.stringify(r.body).includes(KEY));
    assert.equal((W.pg.tables.content_pieces || []).length, 0);
    assert.equal((await W.call('GET', 'ping')).statusCode, 200);
    r = await W.call('GET', 'me', null, { authorization: 'Bearer nope' });
    assert.equal(r.statusCode, 401);
  } finally { W.restore(); }
});

test('agent ingest: the product lock — known products and colours only, model codes filled, supporting products kept (2026-11-03)', async () => {
  const W = world();
  try {
    let r = await W.call('POST', 'campaigns', { ...FRIDGE, product: { family: 'Galaxy Z Flip9' } });
    assert.equal(r.statusCode, 422); assert.equal(r.body.code, 'unknown_product'); assert.equal(r.body.problems[0], 'unknown_product');
    assert.ok(r.body.allowed.products.includes('Galaxy Buds4')); assert.ok(r.body.allowed.colours['Galaxy Z Flip8'].some((c) => c.colour === 'Pink' && c.model_code === 'SM-F776BLIPMEA'));
    r = await W.call('POST', 'campaigns', { ...FRIDGE, product: { family: 'Galaxy Z Flip8', colour: 'Orange' } });
    assert.equal(r.statusCode, 422); assert.match(r.body.problems.join(), /unknown colour "Orange"/);
    r = await W.call('POST', 'campaigns', { ...FRIDGE, product: { family: 'Galaxy Z Flip8', colour: 'Pink', model_code: 'SM-F776BZKOMEA' } });
    assert.equal(r.statusCode, 422); assert.match(r.body.problems.join(), /model_code/);
    r = await W.call('POST', 'campaigns', { ...FRIDGE, supporting_products: [{ family: 'Toaster' }] });
    assert.equal(r.statusCode, 422); assert.match(r.body.problems.join(), /supporting_products\.0\.family/);

    r = await W.call('POST', 'campaigns', FRIDGE);
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.product, { family: 'Galaxy Z Flip8', colour: 'Pink', model_code: 'SM-F776BLIPMEA' });
    assert.deepEqual(r.body.supportingProducts, [{ family: 'Galaxy Buds4', colour: 'White', model_code: 'SM-R540NZWAMEA' }]);
    const id = r.body.campaignId;
    // a model code alone names the product; an alias names the fridge
    r = await W.call('POST', 'campaigns', { ...FRIDGE, product: { family: 'Bespoke AI Refrigerator', model_code: 'RS80F64G1VRE' }, supporting_products: undefined });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body)); assert.deepEqual(r.body.product, { family: 'Bespoke AI Fridge', colour: 'Snow White', model_code: 'RS80F64G1VRE' });
    r = await W.call('POST', 'campaigns', { ...FRIDGE, product: { family: 'Galaxy Z Flip8', colour: 'Mint' } });
    assert.equal(r.statusCode, 201); assert.equal(r.body.product.model_code, null, 'Mint is known; its code is not confirmed yet');

    r = await W.call('GET', `campaigns/${id}`);
    assert.deepEqual(r.body.supportingProducts, [{ family: 'Galaxy Buds4', colour: 'White', model_code: 'SM-R540NZWAMEA' }]);
    assert.equal(r.body.externalRef, 'fridge-girly-2026-11'); assert.equal(r.body.test, false);
    // the Studio shows the supporting products
    r = await W.studio('pieces', 'GET');
    assert.deepEqual(r.body.pieces.find((p) => p.id === id).supportingProducts.map((s) => s.family), ['Galaxy Buds4']);
  } finally { W.restore(); }
});

test('agent ingest: carousel slides in order, sound variants side by side, audio tracks, compliance enforced (2026-11-03)', async () => {
  const W = world();
  try {
    const id = (await W.call('POST', 'campaigns', FRIDGE)).body.campaignId;
    // the hard rules of the 2026-11-02 guidelines
    let r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'carousel_slide', url: 'https://hermes.test/files/slide1.png', slide_index: 1, slide_count: 6, meta: { compliance: { ...COMPLIANT, realistic_humans: true } } });
    assert.equal(r.statusCode, 422); assert.equal(r.body.code, 'compliance_violation');
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'carousel_slide', url: 'https://hermes.test/files/slide1.png', slide_index: 1, slide_count: 6, meta: { compliance: { ...COMPLIANT, ai_generated_samsung_device: true } } });
    assert.equal(r.statusCode, 422); assert.equal(r.body.code, 'compliance_violation');
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'carousel_slide', url: 'https://hermes.test/files/slide1.png', slide_index: 1, meta: { compliance: { ...COMPLIANT, product_sources: [{ product: 'Galaxy S26 Ultra', source: 'official_product_image' }] } } });
    assert.equal(r.statusCode, 422); assert.equal(r.body.code, 'product_not_in_campaign');
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'carousel_slide', url: 'https://hermes.test/files/slide1.png', slide_index: 1, meta: { compliance: { ...COMPLIANT, characters: 'photoreal' } } });
    assert.equal(r.statusCode, 422); assert.match(r.body.problems.join(), /meta\.compliance\.characters/);
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'carousel_slide', url: 'https://hermes.test/files/slide1.png' });
    assert.equal(r.statusCode, 422); assert.deepEqual(r.body.missing, ['slide_index']);
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'carousel_slide', url: 'https://hermes.test/files/music.mp4', slide_index: 1 });
    assert.equal(r.statusCode, 422, 'a slide is an image');

    // slides 3 and 1 of 6; slide 1 pushed again replaces it and keeps the first in its history
    for (const [n, url] of [[3, 'slide1.png'], [1, 'slide1.png'], [1, 'slide1b.png']]) {
      r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'carousel_slide', url: `https://hermes.test/files/${url}`, slide_index: n, slide_count: 6, meta: { compliance: COMPLIANT, qa: { verdict: 'pass' } } });
      assert.equal(r.statusCode, 201, JSON.stringify(r.body)); assert.equal(r.body.attached.slide, n);
    }
    let d = await W.draft(id);
    assert.deepEqual(d.carousel.slides.map((s) => s.n), [1, 3]); assert.equal(d.carousel.slideCount, 6);
    assert.equal(d.carousel.slides[0].history.length, 1); assert.equal(d.carousel.slides[0].compliance.characters, 'stylised_3d');
    assert.equal(d.shots.length, 0, 'a carousel needs no video');

    // two sound versions of one cut
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'video', url: 'https://hermes.test/files/music.mp4', variant: 'music_a', meta: { audio: { source: 'original_ai_generated', model: 'music-v1', licensing: 'cleared' }, compliance: COMPLIANT } });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body)); assert.equal(r.body.attached.variant, 'music_a');
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'video', url: 'https://hermes.test/files/silent.mp4', variant: 'no_audio', meta: { audio: { source: 'none', licensing: 'none' } } });
    assert.equal(r.statusCode, 201);
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'video', url: 'https://hermes.test/files/music.mp4', variant: 'music_a', meta: { audio: { source: 'original_ai_generated', licensing: 'cleared' } } });
    assert.equal(r.statusCode, 201);
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'video', url: 'https://hermes.test/files/music.mp4', variant: 'x', meta: { audio: { source: 'stolen', licensing: 'cleared' } } });
    assert.equal(r.statusCode, 422); assert.match(r.body.problems.join(), /meta\.audio\.source/);
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'video', url: 'https://hermes.test/files/music.mp4', shot_index: 1, variant: 'x' });
    assert.equal(r.statusCode, 422, 'a variant is a whole cut');
    d = await W.draft(id);
    assert.deepEqual(Object.keys(d.cuts).sort(), ['music_a', 'no_audio']);
    assert.equal(d.cuts.music_a.history.length, 1); assert.equal(d.cuts.no_audio.audio.source, 'none');
    assert.equal(d.assembled.variant, 'music_a', 'the first variant pushed is the cut the review reads');
    assert.equal(d.carousel.slides.length, 2, 'the carousel survives the video pushes');

    // a standalone music track
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'audio', url: 'https://hermes.test/files/track.m4a', meta: { title: 'Fridge loop', audio: { source: 'original_ai_generated', licensing: 'cleared' } } });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body)); assert.equal(r.body.contentType, 'audio/mp4');
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'audio', url: 'https://hermes.test/files/slide1.png' });
    assert.equal(r.statusCode, 422);
    d = await W.draft(id);
    assert.equal(d.audioTracks.length, 1); assert.equal(d.audioTracks[0].title, 'Fridge loop');
  } finally { W.restore(); }
});

test('agent ingest: signed uploads into Maistro storage, checked against the declared sha256 and size (2026-11-03)', async () => {
  const W = world();
  try {
    const id = (await W.call('POST', 'campaigns', FRIDGE)).body.campaignId;
    const sha = crypto.createHash('sha256').update(PNG).digest('hex');
    let r = await W.call('POST', `campaigns/${id}/uploads`, { filename: 'final-slide.png', contentType: 'image/png', size: PNG.length, sha256: sha });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    assert.equal(r.body.method, 'PUT'); assert.match(r.body.uploadUrl, /^https:\/\/sb\.test\/storage\/v1\/object\/upload\/sign\/assets\/agent-uploads\//);
    assert.match(r.body.url, new RegExp(`^https://sb\\.test/storage/v1/object/authenticated/assets/agent-uploads/${id}/`));
    const up = r.body;
    // not PUT yet
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'carousel_slide', url: up.url, slide_index: 1 });
    assert.equal(r.statusCode, 422); assert.equal(r.body.code, 'upload_missing');
    // other bytes than declared
    W.uploaded.set(up.path, PNG2);
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'carousel_slide', url: up.url, slide_index: 1 });
    assert.equal(r.statusCode, 422); assert.equal(r.body.code, 'upload_mismatch');
    W.uploaded.set(up.path, PNG);
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'carousel_slide', url: up.url, slide_index: 1 });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body)); assert.equal(r.body.sha256, sha);
    // another campaign's upload path, or an invented one, is refused
    const other = (await W.call('POST', 'campaigns', { ...FRIDGE, external_ref: 'other' })).body.campaignId;
    r = await W.call('POST', `campaigns/${other}/assets`, { kind: 'carousel_slide', url: up.url, slide_index: 1 });
    assert.equal(r.statusCode, 422);
    r = await W.call('POST', `campaigns/${id}/uploads`, { filename: 'x.gif', contentType: 'image/gif', size: 1, sha256: sha });
    assert.equal(r.statusCode, 422);
    r = await W.call('POST', `campaigns/${id}/uploads`, { filename: 'big.wav', contentType: 'audio/wav', size: 25 * 1024 * 1024, sha256: sha });
    assert.equal(r.statusCode, 413);
  } finally { W.restore(); }
});

test('agent ingest: reviewer comments in GET and a signed webhook on each decision (2026-11-03)', async () => {
  const W = world();
  try {
    const id = (await W.call('POST', 'campaigns', FRIDGE)).body.campaignId;
    await W.call('POST', `campaigns/${id}/assets`, { kind: 'thumbnail', url: 'https://hermes.test/files/slide1.png' });
    let r = await W.studio('decisions', 'POST', { pieceId: id, stage: 'thumb', decision: 'rejected', name: 'R. Reviewer', role: 'reviewer', reason: 'Fridge logo visible top left' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    r = await W.call('GET', `campaigns/${id}`);
    const c = r.body.stages.thumb.comments;
    assert.equal(c.length, 1); assert.equal(c[0].decision, 'rejected'); assert.equal(c[0].text, 'Fridge logo visible top left'); assert.equal(c[0].author, 'R. Reviewer');
    assert.equal(r.body.comments.length, 1);
    assert.equal(W.hooks.length, 1);
    const hook = W.hooks[0];
    const ts = hook.headers['X-Maistro-Timestamp'];
    assert.equal(hook.headers['X-Maistro-Signature'], `sha256=${crypto.createHmac('sha256', SECRET).update(`${ts}.${hook.body}`).digest('hex')}`);
    const ev = JSON.parse(hook.body);
    assert.deepEqual([ev.type, ev.campaignId, ev.stage, ev.decision, ev.comment.text], ['stage.decision', id, 'thumb', 'rejected', 'Fridge logo visible top left']);
    // a Studio campaign's decision sends nothing
    W.pg.tables.content_pieces.push({ id: '00000000-0000-4000-8000-0000000000bb', legacy_id: 'gen-studio2', title: 'S', origin: 'studio' });
    const { notifyHermes } = require('../../api/_agent-hooks.js');
    assert.deepEqual(await notifyHermes({ type: 'stage.decision', campaignId: 'gen-studio2' }), { sent: false, reason: 'not_agent_campaign' });
  } finally { W.restore(); }
});

test('agent ingest: listing, external_ref, test campaigns hidden from review and deletable only as tests (2026-11-03)', async () => {
  const W = world();
  try {
    const real = (await W.call('POST', 'campaigns', FRIDGE)).body.campaignId;
    let r = await W.call('POST', 'campaigns', { ...FRIDGE, external_ref: 'fg-test', test: true });
    assert.equal(r.statusCode, 201); assert.equal(r.body.test, true);
    const t1 = r.body.campaignId;
    r = await W.call('POST', 'campaigns', { ...FRIDGE, external_ref: 'fg-test-2' }, { 'x-maistro-test': '1' });
    const t2 = r.body.campaignId; assert.equal(r.body.test, true);

    r = await W.call('GET', 'campaigns', null, {}, { source: 'hermes', limit: '50' });
    assert.equal(r.statusCode, 200); assert.deepEqual(r.body.campaigns.map((c) => c.campaignId).sort(), [real, t1, t2].sort());
    r = await W.call('GET', 'campaigns', null, {}, { external_ref: 'fridge-girly-2026-11' });
    assert.deepEqual(r.body.campaigns.map((c) => c.campaignId), [real]);
    r = await W.call('GET', 'campaigns', null, {}, { source: 'studio' });
    assert.equal(r.statusCode, 422);

    // the reviewer queue never sees test campaigns
    r = await W.studio('pieces', 'GET');
    assert.deepEqual(r.body.pieces.map((p) => p.id), [real]);

    r = await W.call('DELETE', `campaigns/${real}`);
    assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'not_test_campaign');
    r = await W.call('DELETE', `campaigns/${t1}`);
    assert.deepEqual([r.statusCode, r.body.deleted], [200, true]);
    assert.equal((await W.call('GET', `campaigns/${t1}`)).statusCode, 404);
    assert.equal((await W.call('POST', `campaigns/${t1}/assets`, { kind: 'thumbnail', url: 'https://hermes.test/files/slide1.png' })).statusCode, 404);
    r = await W.call('GET', 'campaigns');
    assert.deepEqual(r.body.campaigns.map((c) => c.campaignId).sort(), [real, t2].sort());
  } finally { W.restore(); }
});
