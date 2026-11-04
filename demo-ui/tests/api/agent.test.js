// The agent ingest API (docs/agent-ingest.md): Hermes creates campaigns and pushes a brief, assets and a
// storyboard through /api/agent/*, against the in-memory PostgREST with Storage and the asset host mocked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, HERMES_ENV } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const KEY = 'agent-test-key-0123456789';
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ...HERMES_ENV, AGENT_INGEST_KEY: KEY };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0]);
const GIF = Buffer.from('GIF89a........');
const CAMPAIGN = { title: 'Unfold the skyline', trend: { id: 't-42', name: 'Skyline reveal' }, product: { family: 'Galaxy Z Fold8', colour: 'Cream' }, markets: ['UAE'], platforms: ['tiktok'], source: 'hermes' };
const BRIEF = {
  objective: 'Show the unfold', successMetric: 'completion rate', audience: { description: 'young UAE professionals', markets: ['UAE'] },
  trendHook: { mechanic: 'reveal', samsungAdaptation: 'the unfold is the reveal' }, keyMessage: 'One move from phone to big screen',
  products: [{ name: 'Galaxy Z Fold8' }], claims: [], cta: 'Discover more', tone: 'warm', format: { platform: 'tiktok', targetDurationS: 10, aspect: '9:16' },
  languagePlan: { register: 'gulf_arabic', primary: 'ar' }, audio: { licensing: 'none' }, mandatories: ['logo end card', 'legal line', 'product name'],
  doNots: [], hashtags: { en: ['#GalaxyZFold8'], ar: [] }, caption: { en: 'Unfold it', ar: 'افتحه' }, deadline: '12 Nov 2026',
};

function world() {
  const pg = fakePostgrest();
  const stored = [];
  const f = mockFetch([
    ['https://hermes.test/files/kf.png', () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
    ['https://hermes.test/files/clip.mp4', () => new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4' } })],
    ['https://hermes.test/files/anim.gif', () => new Response(GIF, { status: 200, headers: { 'content-type': 'image/png' } })],
    [/\/storage\/v1\/object\/assets\//, (u, init) => { stored.push({ url: String(u), type: init.headers['Content-Type'], bytes: init.body.length }); return json({ Key: 'ok' }); }],
    pg.route,
  ]);
  const h = api('[route].js', ENV);
  const call = async (method, path, body, headers = {}) => {
    const r = res();
    await h.handler(req({ method, body, query: { route: 'agent', path }, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers }, session: false }), r);
    return r;
  };
  return { pg, stored, f, call, restore: () => { f.restore(); h.restore(); } };
}

test('agent ingest: a campaign is created, briefed, given assets and a storyboard, all as drafts, and reads back whole (2026-11-02)', async () => {
  const W = world();
  try {
    let r = await W.call('POST', 'campaigns', CAMPAIGN, { 'idempotency-key': 'camp-1' });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    const id = r.body.campaignId;
    assert.match(id, /^gen-h[0-9a-f]{12}$/); assert.equal(r.body.source, 'hermes');
    const piece = W.pg.tables.content_pieces.find((p) => p.legacy_id === id);
    assert.equal(piece.product, 'Galaxy Z Fold8'); assert.equal(piece.trend_name, 'Skyline reveal'); assert.equal(piece.origin, 'studio');
    // the same Idempotency-Key replays the first answer and makes nothing new
    const again = await W.call('POST', 'campaigns', { ...CAMPAIGN, title: 'changed' }, { 'idempotency-key': 'camp-1' });
    assert.deepEqual([again.statusCode, again.body], [201, r.body]); assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal(W.pg.tables.content_pieces.length, 1);

    r = await W.call('POST', `campaigns/${id}/brief`, { brief: BRIEF });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body)); assert.equal(r.body.state, 'generated'); assert.equal(r.body.needsReview, true);

    // keyframe first (no storyboard yet): a draft storyboard is made around it from meta.shot_list
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'keyframe', url: 'https://hermes.test/files/kf.png', shot_index: 2, shot_count: 3, meta: { qa: { checked: 1, passed: 1, verdict: 'pass', notes: 'device matches' }, note: 'shot 2', story: { logline: 'A night out opens up' } } });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    const kfId = r.body.assetId;
    assert.match(r.body.assetPath, new RegExp(`^pieces/${id}/board/[a-z0-9]+-[0-9a-f]{12}\\.png$`)); assert.equal(r.body.contentType, 'image/png');
    assert.ok(W.stored.some((s) => s.url.includes(`/assets/pieces/${id}/board/`) && s.type === 'image/png'), 'copied into the private bucket');

    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'moodboard', url: 'https://hermes.test/files/kf.png', direction: 2, meta: { variation_plan: ['warm'], swap_proposals: ['Try with Z Fold8 Ultra'], qa: { verdict: 'warn' } } });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'thumbnail', url: 'https://hermes.test/files/kf.png', meta: { qa: { verdict: 'pass' } } });
    assert.equal(r.statusCode, 201);
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'video', url: 'https://hermes.test/files/clip.mp4', shot_index: 2, shot_count: 3, meta: { duration_s: 4 } });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body)); assert.equal(r.body.contentType, 'video/mp4');

    r = await W.call('POST', `campaigns/${id}/storyboard`, { story: { logline: 'A night out opens up', product_truth: 'phone to big screen in one move', emotional_arc: 'anticipation → delight' }, shots: [1, 2, 3].map((index) => ({ index, act: `Act ${index}`, beat: 'b', duration_s: 3, shot_size: 'medium', angle: 'eye level', lens: '50mm', move: 'static', action: 'a', device_pose: 'p', ...(index === 2 ? { keyframe_asset_id: kfId } : {}) })) });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body)); assert.deepEqual([r.body.shots, r.body.keyframes], [3, 1]);

    r = await W.call('GET', `campaigns/${id}`);
    assert.equal(r.statusCode, 200);
    const c = r.body;
    assert.deepEqual(c.product, { family: 'Galaxy Z Fold8', colour: 'Cream', model_code: 'SM-F971BZWIMEA' });
    assert.equal(c.source, 'hermes'); assert.equal(c.assets.length, 4);
    // the Studio's board view reads these as objects/strings; null broke it (2026-11-04)
    assert.ok(c.stages.board.version.payload.shots.every((sh) => sh.onScreenText && sh.line && typeof sh.audioCue === 'string' && sh.product && typeof sh.transition === 'string'));
    assert.ok(c.assets.every((a) => /^as_[0-9a-f]{24}$/.test(a.assetId) && a.assetPath && a.sha256 && a.sourceUrl));
    for (const k of ['plan', 'brief', 'mood', 'thumb', 'board', 'draft']) {
      assert.equal(c.stages[k].state, 'generated', `${k} is a draft`); assert.equal(c.stages[k].version.producedBy, 'external_hermes'); assert.equal(c.stages[k].decision, null);
    }
    const board = c.stages.board.version.payload;
    assert.equal(board.source, 'hermes'); assert.equal(board.story.logline, 'A night out opens up'); assert.equal(board.shots[1].keyframe.agentAssetId, kfId);
    assert.equal(board.shots[1].keyframe.qa.verdict, 'pass'); assert.equal(board.shots[1].devicePose, 'p');
    const mood = c.stages.mood.version.payload;
    assert.equal(mood.moods[1].state, 'rendered'); assert.deepEqual(mood.moods[1].swapProposals, ['Try with Z Fold8 Ultra']); assert.equal(mood.images[2].state, 'rendered');
    assert.equal(c.stages.thumb.version.payload.qa.verdict, 'pass');
    assert.equal(c.stages.draft.version.payload.shots[1].clip.durationS, 4);
    // nothing was approved, and no approval rows exist
    assert.equal((W.pg.tables.approvals || []).length, 0);
  } finally { W.restore(); }
});

test('agent ingest: auth, scope, validation (422 with the missing fields), types, approved stages and the rate limit (2026-11-02)', async () => {
  const W = world();
  try {
    let r = await W.call('POST', 'campaigns', CAMPAIGN, { authorization: 'Bearer wrong' });
    assert.equal(r.statusCode, 401);
    r = await W.call('POST', 'campaigns', { title: 'x', source: 'hermes' });
    assert.equal(r.statusCode, 422);
    assert.deepEqual(r.body.missing.sort(), ['markets', 'platforms', 'product', 'trend']);
    r = await W.call('POST', 'campaigns', { ...CAMPAIGN, source: 'studio' });
    assert.equal(r.statusCode, 422); assert.match(r.body.problems.join(), /source/);
    r = await W.call('POST', 'campaigns', CAMPAIGN);
    const id = r.body.campaignId;
    r = await W.call('POST', `campaigns/${id}/brief`, { brief: { objective: 'x' } });
    assert.equal(r.statusCode, 422); assert.ok(r.body.missing.includes('brief.keyMessage'));
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'keyframe', url: 'https://hermes.test/files/kf.png' });
    assert.equal(r.statusCode, 422); assert.deepEqual(r.body.missing, ['shot_index']);
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'thumbnail', url: 'https://evil.example/x.png' });
    assert.equal(r.statusCode, 422); assert.equal(r.body.code, 'host_not_allowed');
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'thumbnail', url: 'https://hermes.test/files/anim.gif' });
    assert.equal(r.statusCode, 415, 'the real bytes decide the type, not the Content-Type header');
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'thumbnail', url: 'https://hermes.test/files/clip.mp4' });
    assert.equal(r.statusCode, 422);
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'thumbnail', url: 'https://hermes.test/files/kf.png' }, { 'content-type': 'multipart/form-data; boundary=x' });
    assert.equal(r.statusCode, 415);
    // a storyboard naming an asset this campaign does not have
    r = await W.call('POST', `campaigns/${id}/storyboard`, { story: { logline: 'l', product_truth: 'p', emotional_arc: 'a' }, shots: [{ index: 1, act: 'a', beat: 'b', duration_s: 3, shot_size: 'm', angle: 'a', lens: '', move: 'm', action: 'a', device_pose: 'd', keyframe_asset_id: 'as_000000000000000000000000' }] });
    assert.equal(r.statusCode, 422);
    // an approved stage is never written by the agent
    const piece = W.pg.tables.content_pieces.find((p) => p.legacy_id === id);
    W.pg.tables.stages.find((s) => s.piece_id === piece.id && s.kind === 'thumb').state = 'approved';
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'thumbnail', url: 'https://hermes.test/files/kf.png' });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'approved_immutable');
    // campaigns made in the Studio are out of the key's reach
    W.pg.tables.content_pieces.push({ id: '00000000-0000-4000-8000-0000000000aa', legacy_id: 'gen-studio1', title: 'S', origin: 'studio' });
    r = await W.call('GET', 'campaigns/gen-studio1');
    assert.equal(r.statusCode, 403);
    // no endpoint approves or publishes
    for (const p of [`campaigns/${id}/approve`, `campaigns/${id}/publish`, `campaigns/${id}/decisions`]) assert.equal((await W.call('POST', p, {})).statusCode, 404);
    // 60 a minute
    const now = new Date().toISOString();
    for (let i = 0; i < 60; i++) W.pg.tables.audit_log.push({ id: 1000 + i, action: 'agent.request', entity: 'agent_ingest', after: {}, at: now });
    r = await W.call('GET', `campaigns/${id}`);
    assert.equal(r.statusCode, 429); assert.equal(r.headers['retry-after'], '60');
  } finally { W.restore(); }
});

test('agent ingest: off without AGENT_INGEST_KEY, and the key is never logged', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const h = api('[route].js', { ...ENV, AGENT_INGEST_KEY: undefined });
  try {
    const r = res();
    await h.handler(req({ method: 'GET', query: { route: 'agent', path: 'campaigns/gen-x1' }, headers: { authorization: `Bearer ${KEY}` }, session: false }), r);
    assert.equal(r.statusCode, 503);
  } finally { f.restore(); h.restore(); }
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'api', '_handlers', 'agent.js'), 'utf8');
  assert.ok(!/console\.\w+\([^)]*(AGENT_INGEST_KEY|authorization|key\b)/i.test(src), 'no log line carries the key or the Authorization header');
});

test('agent ingest: a whole video reads its size and length from the mp4 and lands as a one-part draft cut', async () => {
  const W = world();
  // ftyp + moov{ mvhd(v0: timescale 1000, duration 4000) + trak{ tkhd(84 bytes, 720×1280) } }
  const box = (type, body) => { const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(8 + body.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8); return b; };
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(4000, 16);
  const tkhd = Buffer.alloc(76); tkhd.writeUInt32BE(720 << 16, 68); tkhd.writeUInt32BE(1280 << 16, 72);
  const mp4 = Buffer.concat([box('ftyp', Buffer.from('mp42\0\0\0\0')), box('moov', Buffer.concat([box('mvhd', mvhd), box('trak', box('tkhd', tkhd))]))]);
  W.f.restore();
  const f = mockFetch([['https://hermes.test/files/cut.mp4', () => new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } })], [/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })], W.pg.route]);
  try {
    let r = await W.call('POST', 'campaigns', CAMPAIGN);
    const id = r.body.campaignId;
    r = await W.call('POST', `campaigns/${id}/assets`, { kind: 'video', url: 'https://hermes.test/files/cut.mp4', meta: { qa: { verdict: 'pass' } } });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    r = await W.call('GET', `campaigns/${id}`);
    const d = r.body.stages.draft.version.payload;
    assert.deepEqual([d.assembled.width, d.assembled.height, d.assembled.durationS], [720, 1280, 4]);
    assert.equal(d.shots.length, 1); assert.equal(d.shots[0].clip.state, 'rendered'); assert.equal(d.qa.verdict, 'pass');
  } finally { f.restore(); W.restore(); }
});

test('board code checks take Hermes shots with no on-screen text or line (2026-11-04)', () => {
  const { codeChecks } = require('../../api/_studio/board.js');
  const shots = [1, 2].map((n) => ({ n, durationS: 3, type: 'medium', action: 'a', beat: n === 1 ? 'opening' : 'closing', onScreenText: null, line: null, product: null }));
  const out = codeChecks({ shots, hookShot: 1 }, null);
  assert.ok(Array.isArray(out) && out.length > 0);
});
