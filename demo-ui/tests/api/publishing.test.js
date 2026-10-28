// 8b — publishing in manual/export mode (ADR-008): plan a post for an approved final on an owned account, export,
// cancel; linking the published post marks the slot posted; the calendar lists slots and approved finals waiting
// for a slot with their trend's post-by date; 503 until migration 019; Sprinklr never claims a connection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { api, req, res, mockFetch, json } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const { makeSessionCookieValue, SESSION_COOKIE } = require(path.join(__dirname, '..', '..', 'api', '_auth.js'));

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', TRACK_SUPABASE_URL: 'https://tracker.test', TRACK_SUPABASE_KEY: 'tk', MAISTRO_OWNED_ACCOUNTS: undefined, SPRINKLR_API_KEY: undefined };
const OWNED = { external_id: '7560000000000000001', platform: 'tiktok', post_url: 'https://www.tiktok.com/@samsunggulf/video/7560000000000000001', owner_tt: 'samsunggulf', published_at: '2026-10-25T08:00:00Z' };
const tracker = ['https://tracker.test/rest/v1/social_posts', (u) => json([OWNED].filter((p) => String(u).includes(p.external_id)))];
function seed(pg) {
  (pg.tables.content_pieces = pg.tables.content_pieces || []).push({ id: 'pc-1', legacy_id: 'gen-p1', title: 'Deadpan', product: 'Galaxy Z Flip8', platforms: ['tiktok'], markets: ['UAE'], trend_id: 't1', trend_name: 'Deadpan reveal' }, { id: 'pc-2', legacy_id: 'gen-p2', title: 'Unapproved', trend_id: null });
  (pg.tables.stages = pg.tables.stages || []).push({ id: 'f1', piece_id: 'pc-1', kind: 'final', state: 'approved' }, { id: 'f2', piece_id: 'pc-2', kind: 'final', state: 'generated' });
  (pg.tables.trend_scores = pg.tables.trend_scores || []).push({ id: 1, trend_id: 't1', at: '2026-10-21T08:15:00Z', name: 'Deadpan reveal', prompt_version: 'v', weights_version: 'w', status: 'scored', post_by: '2026-10-28T00:00:00Z' });
}
const post = (studio, body, headers) => { const r = res(); return studio.handler(req({ method: 'POST', body, ...(headers ? { headers, session: false } : {}) }), r).then(() => r); };
const cal = (studio) => { const r = res(); return studio.handler(req({ query: { calendar: '1' } }), r).then(() => r); };

test('manual mode: the calendar says so; an approved final waits with its post-by; plan → export (instruction) → link the post → posted', async () => {
  const pg = fakePostgrest(); seed(pg);
  const f = mockFetch([tracker, pg.route]);
  const studio = api('studio.js', ENV);
  try {
    let r = await cal(studio);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, 'manual_export'); assert.equal(r.body.connected, false); assert.match(r.body.label, /Sprinklr: not connected — manual mode/);
    assert.deepEqual(r.body.unscheduled.map((u) => [u.pieceId, u.postBy]), [['gen-p1', '2026-10-28T00:00:00Z']], 'only the approved final, with its trend\'s post-by');
    assert.deepEqual(r.body.unscheduled[0].media, { videoUrl: null, thumbUrl: null }, 'the composer gets the final media (none stored here)');
    r = await post(studio, { action: 'slot-plan', pieceId: 'gen-p1', platform: 'tiktok', account: '@SamsungGulf', slotAt: '2026-10-25T16:00:00+04:00', caption: 'Wait for it… #GalaxyZFlip8' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.slot.status, r.body.slot.account, r.body.slot.slotAt, r.body.slot.mode], ['planned', 'samsunggulf', '2026-10-25T12:00:00.000Z', 'manual_export']);
    const id = r.body.slot.id;
    r = await cal(studio); assert.equal(r.body.unscheduled.length, 0, 'scheduled now'); assert.equal(r.body.slots.length, 1);
    r = await post(studio, { action: 'slot-export', pieceId: 'gen-p1', id });
    assert.equal(r.body.slot.status, 'exported'); assert.equal(r.body.manual, true); assert.match(r.body.instruction, /post it from the account at the slot time/);
    r = await post(studio, { action: 'post-link', pieceId: 'gen-p1', url: OWNED.post_url });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.slotPosted, id);
    r = await cal(studio);
    assert.deepEqual([r.body.slots[0].status, r.body.slots[0].piecePostId != null], ['posted', true]);
    assert.ok(pg.tables.audit_log.some((a) => a.action === 'publishing.plan'));
  } finally { f.restore(); studio.restore(); }
});

test('planning refused: a non-owned account, a final not approved, a bad time, a viewer; cancel keeps the row', async () => {
  const pg = fakePostgrest(); seed(pg);
  (pg.tables.members = pg.tables.members || []).push({ id: 'u-v', email: 'v@samsung.com', role: 'viewer', active: true });
  const f = mockFetch([tracker, pg.route]);
  const studio = api('studio.js', ENV);
  try {
    let r = await post(studio, { action: 'slot-plan', pieceId: 'gen-p1', platform: 'tiktok', account: 'samsung_galaxy2026', slotAt: '2026-10-25T12:00:00Z' });
    assert.equal(r.statusCode, 422); assert.equal(r.body.code, 'not_owned');
    r = await post(studio, { action: 'slot-plan', pieceId: 'gen-p2', platform: 'tiktok', account: 'samsunggulf', slotAt: '2026-10-25T12:00:00Z' });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'final_not_approved');
    r = await post(studio, { action: 'slot-plan', pieceId: 'gen-p1', platform: 'tiktok', account: 'samsunggulf', slotAt: 'tomorrow-ish' });
    assert.equal(r.statusCode, 422);
    r = await post(studio, { action: 'slot-plan', pieceId: 'gen-p1', platform: 'tiktok', account: 'samsunggulf', slotAt: '2026-10-25T12:00:00Z' }, { cookie: `${SESSION_COOKIE}=${makeSessionCookieValue('test-session', Date.now(), undefined, { id: 'u-v', email: 'v@samsung.com', role: 'viewer' })}` });
    assert.equal(r.statusCode, 403);
    r = await post(studio, { action: 'slot-plan', pieceId: 'gen-p1', platform: 'tiktok', account: 'samsunggulf', slotAt: '2026-10-25T12:00:00Z' });
    r = await post(studio, { action: 'slot-cancel', pieceId: 'gen-p1', id: r.body.slot.id, reason: 'moved to next week' });
    assert.equal(r.body.slot.status, 'canceled'); assert.equal(r.body.slot.cancelReason, 'moved to next week');
    r = await cal(studio);
    assert.equal(r.body.slots.length, 1, 'the canceled row is kept'); assert.equal(r.body.unscheduled.length, 1, 'a canceled slot leaves the final unscheduled');
  } finally { f.restore(); studio.restore(); }
});

test('before migration 019: 503 "publishing storage not migrated"; the Sprinklr adapter is not connected and never publishes', async () => {
  const pg = fakePostgrest(); seed(pg);
  const missing = ['https://sb.test/rest/v1/publishing_slots', () => json({ code: 'PGRST205', message: "Could not find the table 'public.publishing_slots' in the schema cache" }, 404)];
  const f = mockFetch([missing, tracker, pg.route]);
  const studio = api('studio.js', ENV);
  try {
    let r = await cal(studio);
    assert.equal(r.statusCode, 503); assert.equal(r.body.code, 'not_migrated');
    r = await post(studio, { action: 'slot-plan', pieceId: 'gen-p1', platform: 'tiktok', account: 'samsunggulf', slotAt: '2026-10-25T12:00:00Z' });
    assert.equal(r.statusCode, 503);
    const P = require('../../api/_studio/publishing.js');
    assert.equal(P.SprinklrAdapter.connected, false); assert.equal(P.SprinklrAdapter.enabled, false); assert.equal(P.adapter().mode, 'manual_export');
    await assert.rejects(require('../../api/_studio/sprinklr/client.js').call('POST', '/publishing/draft', { body: {} }), (e) => e.status === 503 && e.code === 'sprinklr_not_configured');
  } finally { f.restore(); studio.restore(); }
});
