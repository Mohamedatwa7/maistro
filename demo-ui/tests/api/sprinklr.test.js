// ADR-008 (amendment 2026-10-26): the Sprinklr drafts adapter. An export in drafts mode creates one Sprinklr draft
// per slot (checked against the vendored v3 spec's required fields), the draft's status and preview read back, and
// nothing can schedule or publish: the client refuses every call that is not on its allowlist before any fetch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { api, req, res, mockFetch, json } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const { makeSessionCookieValue, SESSION_COOKIE } = require(path.join(__dirname, '..', '..', 'api', '_auth.js'));
const SPEC = require(path.join(__dirname, '..', '..', '..', 'docs', 'vendor', 'sprinklr-v3-publishing.json'));

const SP = 'https://api3.sprinklr.com/prod2/api/v3';
const ENV = {
  SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', MAISTRO_OWNED_ACCOUNTS: undefined,
  SPRINKLR_API_KEY: 'sk', SPRINKLR_ACCESS_TOKEN: 'st', SPRINKLR_ENV: 'prod2', SPRINKLR_DRAFTS: '1', SPRINKLR_CAMPAIGN_ID: 'camp-1',
  SPRINKLR_ACCOUNT_GROUPS: 'tiktok:samsunggulf=ag-tt, instagram:@SamsungGulf=ag-ig',
};
function seed(pg) {
  (pg.tables.content_pieces = pg.tables.content_pieces || []).push({ id: 'pc-1', legacy_id: 'gen-p1', title: 'Deadpan', product: 'Galaxy Z Flip8', platforms: ['tiktok'], markets: ['UAE'], trend_id: null });
  (pg.tables.stages = pg.tables.stages || []).push({ id: 'f1', piece_id: 'pc-1', kind: 'final', state: 'approved', current_version_id: 'v-f' }, { id: 't1', piece_id: 'pc-1', kind: 'thumb', state: 'approved', current_version_id: 'v-t' });
  (pg.tables.artifact_versions = pg.tables.artifact_versions || []).push({ id: 'v-f', version: 2, payload: { assembled: { assetPath: 'pieces/gen-p1/final/cut.mp4', sha256: 'a'.repeat(64), durationS: 14.5 } } }, { id: 'v-t', version: 1, payload: { assetPath: 'pieces/gen-p1/thumb/t.png' } });
  (pg.tables.members = pg.tables.members || []).push({ id: 'u-a', email: 'a@samsung.com', role: 'admin', active: true });
}
const sign = ['https://sb.test/storage/v1/object/sign/', (u) => json({ signedURL: `/object/sign/${String(u).split('/sign/')[1]}?token=t` })];
// a Sprinklr double: records every call; draft status and preview answers can be changed by the test
function sprinklrDouble() {
  const s = { calls: [], status: 'APPROVAL', fail: null };
  const route = [SP, (u, init) => {
    const url = new URL(u); const key = `${init.method || 'GET'} ${url.pathname.replace('/prod2/api/v3', '')}`;
    s.calls.push({ key, url, init, body: init.body ? JSON.parse(init.body) : null });
    if (s.fail) return json({ errors: [{ id: '0'.repeat(24), code: s.fail, message: 'token.expired' }] }, s.fail);
    if (key === 'POST /publishing/draft') return json('dr-' + s.calls.filter((c) => c.key === key).length);
    if (key === 'GET /publishing/draft') return json([{ id: 900, status: s.status, scheduleDate: Date.parse('2026-10-25T12:00:00Z') }]);
    if (key === 'GET /publishing/preview/generate') return json('pv-1');
    if (key === 'GET /publishing/preview/status') return json({ id: 'pv-1', status: 'COMPLETED', url: 'https://sprinklr.test/preview.png' });
    if (key === 'GET /me') return json('maistro-api@samsung.com');
    return json({ error: 'unexpected' }, 404);
  }];
  return { s, route };
}
const post = (studio, body, headers) => { const r = res(); return studio.handler(req({ method: 'POST', body, ...(headers ? { headers, session: false } : {}) }), r).then(() => r); };
const get = (studio, query, headers) => { const r = res(); return studio.handler(req({ query, ...(headers ? { headers, session: false } : {}) }), r).then(() => r); };
const admin = { cookie: `${SESSION_COOKIE}=${makeSessionCookieValue('test-session', Date.now(), undefined, { id: 'u-a', email: 'a@samsung.com', role: 'admin' })}` };
const planBody = { action: 'slot-plan', pieceId: 'gen-p1', platform: 'tiktok', account: 'samsunggulf', slotAt: '2026-10-25T16:00:00+04:00', caption: 'Wait for it… #GalaxyZFlip8' };

test('drafts mode: export creates one Sprinklr draft that meets the spec; status and preview read back; never scheduled', async () => {
  const pg = fakePostgrest(); seed(pg);
  const sp = sprinklrDouble();
  const f = mockFetch([sp.route, sign, pg.route]);
  const studio = api('studio.js', ENV);
  try {
    let r = await get(studio, { calendar: '1' });
    assert.equal(r.body.mode, 'sprinklr'); assert.match(r.body.label, /^Sprinklr: drafts only/);
    assert.deepEqual(r.body.sprinklr, { configured: true, drafts: true, livePublishing: false });
    r = await post(studio, planBody);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.slot.mode, 'sprinklr');
    const id = r.body.slot.id;
    r = await post(studio, { action: 'slot-export', pieceId: 'gen-p1', id });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.sprinklr.draftId, 'dr-1'); assert.equal(r.body.slot.sprinklrDraftId, 'dr-1'); assert.equal(r.body.slot.status, 'exported');

    const [create] = sp.s.calls.filter((c) => c.key === 'POST /publishing/draft');
    assert.equal(create.init.headers.authorization, 'Bearer st'); assert.equal(create.init.headers.key, 'sk');
    const m = create.body, schemas = SPEC.components.schemas;
    for (const k of schemas.OutboundMessage.required) assert.ok(m[k] != null, `OutboundMessage.${k} is required by the spec`);
    for (const k of schemas.VideoAttachment.required) assert.ok(m.content.attachment[k] != null, `VideoAttachment.${k} is required by the spec`);
    assert.ok(Object.keys(m.content.attachment).every((k) => k in schemas.VideoAttachment.properties), 'only VideoAttachment fields');
    assert.equal(m.content.attachment.type, 'VIDEO'); assert.match(m.content.attachment.url, /^https:\/\/sb\.test\/storage\/v1\/object\/sign\/assets\/pieces\/gen-p1\/final\/cut\.mp4\?token=t$/);
    assert.match(m.content.attachment.previewUrl, /thumb\/t\.png/); assert.equal(m.content.attachment.duration, 14.5);
    assert.equal(m.content.text, planBody.caption); assert.equal(m.scheduleDate, Date.parse('2026-10-25T12:00:00Z'));
    assert.deepEqual(m.accountGroupIds, ['ag-tt']); assert.equal(m.taxonomy.campaignId, 'camp-1'); assert.equal(m.externalId, `maistro-slot-${id}`);
    assert.ok(!('status' in m), 'the draft asks for no status (no SCHEDULED)');

    r = await post(studio, { action: 'slot-export', pieceId: 'gen-p1', id });
    assert.equal(r.body.sprinklr.reused, true);
    assert.equal(sp.s.calls.filter((c) => c.key === 'POST /publishing/draft').length, 1, 'a repeated export reuses the draft');

    r = await post(studio, { action: 'slot-draft-check', pieceId: 'gen-p1', id });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.draft.status, r.body.slot.sprinklrStatus, r.body.draft.scheduleDate], ['APPROVAL', 'APPROVAL', '2026-10-25T12:00:00.000Z']);
    assert.equal(sp.s.calls.find((c) => c.key === 'GET /publishing/draft').url.searchParams.get('id'), 'dr-1');
    r = await post(studio, { action: 'slot-draft-check', pieceId: 'gen-p1', id, preview: true });
    assert.deepEqual(r.body.preview, { id: 'pv-1', status: 'requested', url: null });
    assert.equal(sp.s.calls.find((c) => c.key === 'GET /publishing/preview/generate').url.searchParams.get('messageId'), 'dr-1');
    r = await post(studio, { action: 'slot-draft-check', pieceId: 'gen-p1', id, preview: true, previewId: 'pv-1' });
    assert.deepEqual(r.body.preview, { id: 'pv-1', status: 'COMPLETED', url: 'https://sprinklr.test/preview.png' });

    const C = require('../../api/_studio/sprinklr/client.js');
    assert.ok(sp.s.calls.every((c) => C.ALLOWED.has(c.key)), 'every Sprinklr call is on the allowlist');
  } finally { f.restore(); studio.restore(); }
});

test('no live posts: scheduling, publishing and messaging are refused before any request leaves', async () => {
  const sp = sprinklrDouble();
  const f = mockFetch([sp.route]);
  const studio = api('studio.js', ENV);
  try {
    const C = require('../../api/_studio/sprinklr/client.js');
    for (const [m, p] of [['POST', '/publishing/post'], ['POST', '/publishing/draft/schedule'], ['POST', '/publishing/message'], ['POST', '/publishing/reply'], ['PUT', '/publishing/draft/workflow'], ['DELETE', '/publishing/draft'], ['POST', '/media/upload/url']]) {
      assert.ok(!C.ALLOWED.has(`${m} ${p}`), `${m} ${p} is not allowed`);
      await assert.rejects(C.call(m, p, { body: {} }), (e) => e.status === 403 && e.code === 'sprinklr_call_blocked');
    }
    assert.equal(sp.s.calls.length, 0, 'nothing reached Sprinklr');
    assert.ok([...C.ALLOWED].every((k) => k.startsWith('GET ') || k === 'POST /publishing/draft' || k === 'POST /reports/query'), 'the only write is creating a draft; the reporting query is a read');
    assert.deepEqual([...C.WRITES], ['POST /publishing/draft']);
  } finally { f.restore(); studio.restore(); }
});

test('fallbacks: no opt-in stays manual; an unmapped account or a Sprinklr error is recorded on the slot, the export still stands', async () => {
  const sp = sprinklrDouble();
  // configured but SPRINKLR_DRAFTS unset: manual mode, no Sprinklr calls
  let pg = fakePostgrest(); seed(pg);
  let f = mockFetch([sp.route, sign, pg.route]);
  let studio = api('studio.js', { ...ENV, SPRINKLR_DRAFTS: undefined });
  try {
    let r = await get(studio, { calendar: '1' });
    assert.equal(r.body.mode, 'manual_export'); assert.deepEqual(r.body.sprinklr, { configured: true, drafts: false, livePublishing: false });
    r = await post(studio, planBody);
    r = await post(studio, { action: 'slot-export', pieceId: 'gen-p1', id: r.body.slot.id });
    assert.equal(r.body.manual, true); assert.equal(r.body.sprinklr, undefined);
    assert.equal(sp.s.calls.length, 0);
  } finally { f.restore(); studio.restore(); }

  pg = fakePostgrest(); seed(pg);
  f = mockFetch([sp.route, sign, pg.route]);
  studio = api('studio.js', { ...ENV, SPRINKLR_ACCOUNT_GROUPS: 'instagram:samsunggulf=ag-ig' });
  try {
    let r = await post(studio, planBody); const id = r.body.slot.id;
    r = await post(studio, { action: 'slot-export', pieceId: 'gen-p1', id });
    assert.equal(r.statusCode, 200); assert.equal(r.body.slot.status, 'exported');
    assert.equal(r.body.sprinklr.code, 'sprinklr_account_unmapped'); assert.match(r.body.slot.sprinklrError, /^sprinklr_account_unmapped: no Sprinklr account group for tiktok:samsunggulf/);
    assert.equal(sp.s.calls.length, 0);
    r = await post(studio, { action: 'slot-draft-check', pieceId: 'gen-p1', id });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'no_draft');
  } finally { f.restore(); studio.restore(); }

  pg = fakePostgrest(); seed(pg);
  f = mockFetch([sp.route, sign, pg.route]);
  studio = api('studio.js', ENV);
  try {
    sp.s.fail = 401;
    let r = await post(studio, planBody);
    r = await post(studio, { action: 'slot-export', pieceId: 'gen-p1', id: r.body.slot.id });
    assert.equal(r.statusCode, 200); assert.equal(r.body.sprinklr.code, 'sprinklr_error');
    assert.match(r.body.slot.sprinklrError, /answered 401: token\.expired/); assert.equal(r.body.slot.sprinklrDraftId, null);
  } finally { f.restore(); studio.restore(); }
});

test('credential check (GET /me) is admin only and read-only', async () => {
  const pg = fakePostgrest(); seed(pg);
  const sp = sprinklrDouble();
  const f = mockFetch([sp.route, pg.route]);
  const studio = api('studio.js', ENV);
  try {
    let r = await get(studio, { sprinklr: 'check' });
    assert.equal(r.statusCode, 403, 'the shared password cannot');
    r = await get(studio, { sprinklr: 'check' }, admin);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.ok, r.body.me, r.body.livePublishing], [true, 'maistro-api@samsung.com', false]);
    assert.deepEqual(sp.s.calls.map((c) => c.key), ['GET /me']);
  } finally { f.restore(); studio.restore(); }
});
