// Characterization: /api/hermes, /api/director, /api/higgsfield, /api/qc-f1x8, /api/upload, /api/translate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { req, res, api, mockFetch, json, text, anthropicReply } = require('../helpers');

const TREND = { name: 'Setup line then deadpan punchline', type: 'format', markets: ['UAE'], platform: 'tiktok' };

test('hermes: validation and the plan stage mapping (th from themeDark/themeAccent)', async () => {
  const f = mockFetch([['api.anthropic.com', () => anthropicReply({ title: 'Deadpan Fold', product: 'Galaxy Z Fold8', msg: 'Unfold the joke', angle: 'a', markets: ['UAE'], platforms: ['tiktok'], themeDark: '#101010', themeAccent: '#404040' })]]);
  const h = api('hermes.js', { ANTHROPIC_API_KEY: 'k' });
  try {
    let r = res(); await h.handler(req({ method: 'GET' }), r); assert.equal(r.statusCode, 405);
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'nope', trend: TREND } }), r); assert.equal(r.statusCode, 400);
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'plan' } }), r); assert.equal(r.statusCode, 400); assert.match(r.body.error, /missing trend/);
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'plan', trend: TREND } }), r);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { stage: 'plan', agent: 'Hermes', artifact: { title: 'Deadpan Fold', product: 'Galaxy Z Fold8', msg: 'Unfold the joke', angle: 'a', markets: ['UAE'], platforms: ['tiktok'], th: ['#101010', '#404040'] } });
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally { f.restore(); h.restore(); }
});

test('hermes: no key → 503; upstream error → 502', async () => {
  let h = api('hermes.js', { ANTHROPIC_API_KEY: undefined });
  let r = res(); await h.handler(req({ method: 'POST', body: { stage: 'plan', trend: TREND } }), r); assert.equal(r.statusCode, 503); h.restore();
  const f = mockFetch([['api.anthropic.com', () => text('{"error":{"message":"overloaded"}}', 529)]]);
  h = api('hermes.js', { ANTHROPIC_API_KEY: 'k' });
  try {
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'plan', trend: TREND } }), r);
    assert.equal(r.statusCode, 502); assert.ok(r.body.error);
  } finally { f.restore(); h.restore(); }
});

test('hermes: mood/thumb/board mappers reshape the model JSON into the UI shapes', async () => {
  const replies = {
    mood: { note: 'n', tiles: Array.from({ length: 7 }, (_, i) => ({ from: '#000000', to: '#111111', label: 'L' + i })) },
    thumb: { title: 'T', sub: 'S', gFrom: '#000000', gTo: '#222222' },
    board: { frames: Array.from({ length: 8 }, (_, i) => ({ tc: '0:0' + i, d: 'beat', gFrom: '#000000', gTo: '#333333' })) },
  };
  let stage;
  const f = mockFetch([['api.anthropic.com', () => anthropicReply(replies[stage])]]);
  const h = api('hermes.js', { ANTHROPIC_API_KEY: 'k' });
  try {
    stage = 'mood'; let r = res(); await h.handler(req({ method: 'POST', body: { stage, trend: TREND } }), r);
    assert.equal(r.body.artifact.tiles.length, 6, 'tiles capped at 6'); assert.deepEqual(r.body.artifact.tiles[0], ['#000000', '#111111', 'L0']);
    stage = 'thumb'; r = res(); await h.handler(req({ method: 'POST', body: { stage, trend: TREND } }), r);
    assert.deepEqual(r.body.artifact, { title: 'T', sub: 'S', g: ['#000000', '#222222'] });
    stage = 'board'; r = res(); await h.handler(req({ method: 'POST', body: { stage, trend: TREND } }), r);
    assert.equal(r.body.artifact.length, 6, 'frames capped at 6'); assert.deepEqual(r.body.artifact[0], { tc: '0:00', d: 'beat', g: ['#000000', '#333333'] });
    assert.equal(r.body.agent, 'Frame');
  } finally { f.restore(); h.restore(); }
});

test('director: validation, prior context assembly, response shape', async () => {
  let sent;
  const f = mockFetch([['api.anthropic.com', (u, init) => { sent = JSON.parse(init.body); return anthropicReply({ prompt: 'A cinematic prompt', note: 'Went warm.' }); }]]);
  const h = api('director.js', { ANTHROPIC_API_KEY: 'k' });
  try {
    let r = res(); await h.handler(req({ method: 'GET' }), r); assert.equal(r.statusCode, 405);
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'nope', campaign: { title: 'x' } } }), r); assert.equal(r.statusCode, 422);
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'mood', campaign: {} } }), r); assert.equal(r.statusCode, 422);
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'revise', userInput: 'tighter', campaign: { title: 'C', product: 'P' }, context: { mood: { prompt: 'mp', note: 'mn' }, draft: { prompt: 'dp' }, qc: { score: 6.1, fixes: ['#1 fix'], revisionBrief: { objective: 'o' } } } } }), r);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { stage: 'revise', prompt: 'A cinematic prompt', note: 'Went warm.' });
    const user = sent.messages[0].content;
    assert.match(user, /MOODBOARD \(already generated\)/);
    assert.match(user, /FIRST DRAFT VIDEO/);
    assert.match(user, /draft score: 6\.1\/10/);
    assert.match(user, /- #1 fix/);
    assert.match(user, /"tighter"/);
    assert.equal(sent.output_config.format.type, 'json_schema');
  } finally { f.restore(); h.restore(); }
});

test('higgsfield: credentials gate, validation, v2 status mapping, v1 reference path', async () => {
  let h = api('higgsfield.js', { HF_CREDENTIALS: undefined });
  let r = res(); await h.handler(req({ method: 'POST', body: { kind: 'image', prompt: 'x' } }), r); assert.equal(r.statusCode, 503); h.restore();
  const f = mockFetch([
    ['/requests/abcdefgh1234/status', () => json({ status: 'completed', images: [{ url: 'https://cdn/img.png' }] })],
    ['/requests/nsfw00000000/status', () => json({ status: 'nsfw' })],
    ['/v1/job-sets/jobset000001', () => json({ jobs: [{ status: 'completed', results: { raw: { url: 'https://cdn/ref.png' } } }] })],
    ['/v1/text2image/soul', (u, init) => { const b = JSON.parse(init.body); assert.equal(b.params.image_reference.image_url, 'https://ref/photo.jpg'); assert.equal(b.params.width_and_height, '2048x1152'); assert.match(b.params.prompt, /^The device shown MUST be the exact product/); return json({ id: 'jobset000001' }); }],
  ]);
  h = api('higgsfield.js', { HF_CREDENTIALS: 'id:secret' });
  try {
    r = res(); await h.handler(req({ method: 'POST', body: { kind: 'image' } }), r); assert.equal(r.statusCode, 422);
    r = res(); await h.handler(req({ method: 'GET', query: { id: 'bad' } }), r); assert.equal(r.statusCode, 400);
    r = res(); await h.handler(req({ method: 'GET', query: { id: 'abcdefgh1234' } }), r);
    assert.deepEqual(r.body, { status: 'completed', video: null, images: ['https://cdn/img.png'], raw_status: 'completed' });
    r = res(); await h.handler(req({ method: 'GET', query: { id: 'nsfw00000000' } }), r);
    assert.deepEqual(r.body, { status: 'nsfw', video: null, images: null, raw_status: 'nsfw' });
    r = res(); await h.handler(req({ method: 'POST', body: { kind: 'image', prompt: 'p', aspect_ratio: '16:9', ref: 'https://ref/photo.jpg' } }), r);
    assert.deepEqual(r.body, { request_id: 'jobset000001', status: 'queued', v: 1 });
    r = res(); await h.handler(req({ method: 'GET', query: { id: 'jobset000001', v: '1' } }), r);
    assert.deepEqual(r.body, { status: 'completed', video: null, images: ['https://cdn/ref.png'], raw_status: 'completed' });
  } finally { f.restore(); h.restore(); }
});

test('qc-f1x8: validation, submit proxies the asset as multipart, GET maps backend errors', async () => {
  const f = mockFetch([
    ['https://d3u0tzju9qaucj.cloudfront.net/final.mp4', () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'video/mp4' } })],
    ['/api/analyze/video/submit', async (u, init) => { assert.ok(init.body instanceof FormData); assert.equal(init.body.get('role'), 'creative_director'); assert.equal(init.body.get('title'), 'Piece — Final'); return json({ job_id: 'job-1234' }); }],
    ['/api/job/job-1234', () => json({ status: 'error', error: 'model crashed' })],
    ['/api/job/job-5678', () => json({ status: 'analyzing' })],
  ]);
  const h = api('qc-f1x8.js', { MAISTRO_F1X8_BASE_URL: 'https://f1x8.test' });
  try {
    let r = res(); await h.handler(req({ method: 'GET', query: { job: 'x' } }), r); assert.equal(r.statusCode, 400);
    r = res(); await h.handler(req({ method: 'POST', body: { kind: 'video', assetUrl: 'http://insecure' } }), r); assert.equal(r.statusCode, 422);
    r = res(); await h.handler(req({ method: 'POST', body: { kind: 'video', assetUrl: 'https://d3u0tzju9qaucj.cloudfront.net/final.mp4', title: 'Piece — Final', description: 'brief' } }), r);
    assert.deepEqual(r.body, { job_id: 'job-1234' });
    // SSRF guard (M1): only media hosts are fetched
    for (const bad of ['https://169.254.169.254/latest/meta-data', 'https://evil.test/x.mp4', 'https://user:pw@d3u0tzju9qaucj.cloudfront.net/x', 'https://cloudfront.net.evil.test/x']) {
      r = res(); await h.handler(req({ method: 'POST', body: { kind: 'video', assetUrl: bad } }), r);
      assert.equal(r.statusCode, 422, bad); assert.match(r.body.error, /not an allowed media host/);
    }
    const { assetHostAllowed } = h.handler;
    assert.equal(assetHostAllowed('https://maistro.supabase.co/storage/v1/object/public/refs/x.jpg'), false, 'Supabase host only when SUPABASE_URL is set');
    process.env.SUPABASE_URL = 'https://maistro.supabase.co';
    assert.equal(assetHostAllowed('https://maistro.supabase.co/storage/v1/object/public/refs/x.jpg'), true);
    delete process.env.SUPABASE_URL;
    process.env.QC_ASSET_HOSTS = 'media.partner.test';
    assert.equal(assetHostAllowed('https://media.partner.test/a.png'), true);
    assert.equal(assetHostAllowed('https://sub.media.partner.test/a.png'), false, 'exact host unless the entry starts with a dot');
    delete process.env.QC_ASSET_HOSTS;
    r = res(); await h.handler(req({ method: 'GET', query: { job: 'job-1234' } }), r);
    assert.deepEqual(r.body, { status: 'error', error: 'model crashed' }, 'backend error passes through as HTTP 200 {status:error}');
    r = res(); await h.handler(req({ method: 'GET', query: { job: 'job-5678' } }), r);
    assert.deepEqual(r.body, { status: 'analyzing' });
  } finally { f.restore(); h.restore(); }
});

test('upload: validation, bucket ensure, object path and public URL', async () => {
  const calls = [];
  const f = mockFetch([
    ['/storage/v1/bucket', (u, init) => { calls.push('bucket'); return json({ message: 'exists' }, 409); }],
    [/\/storage\/v1\/object\/refs\/products\/[a-z0-9]+-[a-z0-9]{6}\.jpg$/, (u, init) => { calls.push('object:' + init.headers['Content-Type']); return json({ Key: 'ok' }); }],
  ]);
  const h = api('upload.js', { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  try {
    let r = res(); await h.handler(req({ method: 'POST', body: {} }), r); assert.equal(r.statusCode, 422);
    r = res(); await h.handler(req({ method: 'POST', body: { data: Buffer.from('jpegbytes').toString('base64'), contentType: 'image/jpeg' } }), r);
    assert.equal(r.statusCode, 200);
    assert.match(r.body.url, /^https:\/\/sb\.test\/storage\/v1\/object\/public\/refs\/products\/[a-z0-9]+-[a-z0-9]{6}\.jpg$/);
    assert.deepEqual(calls, ['bucket', 'object:image/jpeg']);
    r = res(); await h.handler(req({ method: 'POST', body: { data: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64') } }), r);
    assert.equal(r.statusCode, 413);
  } finally { f.restore(); h.restore(); }
});

test('translate: validation and the gtx response flattening', async () => {
  const f = mockFetch([['translate.googleapis.com', () => json([[['Hello ', 'مرحبا', null, null], ['world', 'عالم', null, null]], null, 'ar'])]]);
  const h = api('translate.js');
  try {
    let r = res(); await h.handler(req({ method: 'POST', body: {} }), r); assert.equal(r.statusCode, 422);
    r = res(); await h.handler(req({ method: 'POST', body: { text: 'مرحبا عالم' } }), r);
    assert.deepEqual(r.body, { translatedText: 'Hello world', detectedLanguage: 'ar' });
    assert.equal(r.headers['cache-control'], 's-maxage=86400');
  } finally { f.restore(); h.restore(); }
});
