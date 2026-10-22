// 7.5 — attribution links: an approved final → the published post, resolved like the reader's aliases, owned
// accounts only (R-8), one active link per (piece, post), unlink keeps history, 503 until migration 018 exists.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { api, req, res, mockFetch, json } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const { makeSessionCookieValue, SESSION_COOKIE } = require(path.join(__dirname, '..', '..', 'api', '_auth.js'));

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', TRACK_SUPABASE_URL: 'https://tracker.test', TRACK_SUPABASE_KEY: 'tk', MAISTRO_OWNED_ACCOUNTS: undefined };
const OWNED = { external_id: '7560000000000000001', platform: 'tiktok', post_url: 'https://www.tiktok.com/@samsunggulf/video/7560000000000000001', owner_tt: 'samsunggulf', published_at: '2026-10-21T08:00:00Z' };
const FAN = { external_id: '7560000000000000002', platform: 'tiktok', post_url: 'https://www.tiktok.com/@samsung_galaxy2026/video/7560000000000000002', owner_tt: 'samsung_galaxy2026', published_at: '2026-10-21T08:00:00Z' };
const tracker = ['https://tracker.test/rest/v1/social_posts', (u) => json([OWNED, FAN].filter((p) => String(u).includes(p.external_id)))];
function seed(pg, finalState = 'approved') {
  (pg.tables.content_pieces = pg.tables.content_pieces || []).push({ id: 'pc-1', legacy_id: 'gen-at1', title: 'T' });
  (pg.tables.stages = pg.tables.stages || []).push({ id: 'st-f', piece_id: 'pc-1', kind: 'final', state: finalState });
}
const post = (studio, body, headers) => { const r = res(); return studio.handler(req({ method: 'POST', body: { pieceId: 'gen-at1', ...body }, ...(headers ? { headers, session: false } : {}) }), r).then(() => r); };
const get = (studio) => { const r = res(); return studio.handler(req({ query: { posts: 'gen-at1' } }), r).then(() => r); };

test('link: a messy URL (query, trailing slash, m.) resolves to the owned post; a second link is refused; unlink keeps history; relink after unlink works', async () => {
  const pg = fakePostgrest(); seed(pg);
  const f = mockFetch([tracker, pg.route]);
  const studio = api('studio.js', ENV);
  try {
    let r = await post(studio, { action: 'post-link', url: 'https://m.tiktok.com/@samsunggulf/video/7560000000000000001/?is_from_webapp=1&sender_device=pc' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.post, { postId: '7560000000000000001', platform: 'tiktok', url: OWNED.post_url, account: 'samsunggulf', owned: true });
    r = await post(studio, { action: 'post-link', url: OWNED.post_url });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'already_linked');
    r = await get(studio);
    assert.equal(r.body.links.length, 1); assert.equal(r.body.links[0].active, true); assert.equal(r.body.links[0].linkedBy, 'password session claim');
    r = await post(studio, { action: 'post-unlink', id: r.body.links[0].id, reason: 'wrong post' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    r = await post(studio, { action: 'post-link', url: OWNED.post_url });
    assert.equal(r.statusCode, 200, 'relink after unlink');
    r = await get(studio);
    assert.deepEqual(r.body.links.map((l) => l.active).sort(), [false, true], 'history kept: one unlinked, one active');
    assert.ok(pg.tables.audit_log.some((a) => a.action === 'piece.post.link'));
  } finally { f.restore(); studio.restore(); }
});

test('link refused: a non-owned account (R-8), a URL the tracker does not hold, a non-post URL, a final not yet approved, a viewer', async () => {
  const pg = fakePostgrest(); seed(pg);
  (pg.tables.members = pg.tables.members || []).push({ id: 'u-v', email: 'v@samsung.com', role: 'viewer', active: true });
  const f = mockFetch([tracker, pg.route]);
  const studio = api('studio.js', ENV);
  try {
    let r = await post(studio, { action: 'post-link', url: FAN.post_url });
    assert.equal(r.statusCode, 422); assert.equal(r.body.code, 'not_owned'); assert.match(r.body.error, /samsung_galaxy2026/);
    r = await post(studio, { action: 'post-link', url: 'https://www.tiktok.com/@samsunggulf/video/7569999999999999999' });
    assert.equal(r.statusCode, 404); assert.equal(r.body.code, 'post_not_found');
    r = await post(studio, { action: 'post-link', url: 'https://example.com/a' });
    assert.equal(r.statusCode, 422);
    r = await post(studio, { action: 'post-link', url: OWNED.post_url }, { cookie: `${SESSION_COOKIE}=${makeSessionCookieValue('test-session', Date.now(), undefined, { id: 'u-v', email: 'v@samsung.com', role: 'viewer' })}` });
    assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'role_required');
    pg.tables.stages[0].state = 'generated';
    r = await post(studio, { action: 'post-link', url: OWNED.post_url });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'final_not_approved');
    assert.equal((pg.tables.piece_posts || []).length, 0, 'nothing stored');
  } finally { f.restore(); studio.restore(); }
});

test('before migration 018: list and link answer 503 "attribution storage not migrated"', async () => {
  const pg = fakePostgrest(); seed(pg);
  const missing = ['https://sb.test/rest/v1/piece_posts', () => json({ code: 'PGRST205', message: "Could not find the table 'public.piece_posts' in the schema cache" }, 404)];
  const f = mockFetch([missing, tracker, pg.route]);
  const studio = api('studio.js', ENV);
  try {
    let r = await get(studio);
    assert.equal(r.statusCode, 503); assert.equal(r.body.code, 'not_migrated');
    r = await post(studio, { action: 'post-link', url: OWNED.post_url });
    assert.equal(r.statusCode, 503); assert.equal(r.body.code, 'not_migrated');
  } finally { f.restore(); studio.restore(); }
});
