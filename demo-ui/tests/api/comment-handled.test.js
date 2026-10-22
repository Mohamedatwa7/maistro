// 7.1 D-a — a comment marked handled: one key for every copy (twins, re-collected duplicates, a prefixed post
// id), append-only history in audit_log with who and when, reviewer / line manager / admin only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { api, req, res, mockFetch } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const { makeSessionCookieValue, SESSION_COOKIE } = require(path.join(__dirname, '..', '..', 'api', '_auth.js'));

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const cookieFor = (member) => `${SESSION_COOKIE}=${makeSessionCookieValue('test-session', Date.now(), undefined, member)}`;

test('handled: marked once, every copy of the comment shares it; unhandled appends a row; who and when recorded', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const h = api('sentiment.js', ENV);
  try {
    let r = res();
    await h.handler(req({ method: 'POST', body: { action: 'comment-handled', postId: 'instagram-p1', author: 'Amal', text: 'Where is my order?? #Fold8', at: '2026-10-21T08:00:00Z', platform: 'instagram', handled: true, note: 'replied in DM' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const key = r.body.key;
    assert.equal(key, 'p1|amal|whereismyorderfold8');
    assert.equal(r.body.by, 'password session (no member sign-in)');
    // a twin (other whitespace, punctuation, a mention) and a re-collected copy under the unprefixed id map to the key
    const { commentKey } = h.handler;
    assert.equal(commentKey({ postId: 'p1', author: ' amal ', text: 'Where is my order ? #Fold8 @samsunggulf', at: '2026-10-21T08:01:00Z' }), key);
    assert.notEqual(commentKey({ postId: 'p1', author: 'sara', text: 'Where is my order?? #Fold8' }), key, 'another author is another comment');
    r = res(); await h.handler(req({ query: { handled: '1' } }), r);
    assert.equal(r.body.handled[key].handled, true); assert.equal(r.body.handled[key].note, 'replied in DM');
    // undo: a second row, the latest wins, history kept
    r = res(); await h.handler(req({ method: 'POST', body: { action: 'comment-handled', postId: 'p1', author: 'amal', text: 'where is my order #fold8', handled: false } }), r);
    assert.equal(r.body.key, key);
    r = res(); await h.handler(req({ query: { handled: '1' } }), r);
    assert.equal(r.body.handled[key].handled, false); assert.equal(r.body.rows, 2);
    assert.deepEqual(pg.tables.audit_log.map((x) => [x.action, x.entity, x.after.key]), [['comment.handled', 'comment', key], ['comment.unhandled', 'comment', key]]);
    // blank text (a sticker): keyed by its time, never merged with another blank
    assert.notEqual(commentKey({ postId: 'p1', author: 'a', text: '', at: '1' }), commentKey({ postId: 'p1', author: 'a', text: '', at: '2' }));
  } finally { f.restore(); h.restore(); }
});

test('handled: a mark older than 2,500 later events is still handled (the read pages past the 1000-row cap)', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const h = api('sentiment.js', ENV);
  try {
    let r = res(); await h.handler(req({ method: 'POST', body: { action: 'comment-handled', postId: 'old', author: 'a', text: 'refund please', handled: true } }), r);
    const key = r.body.key;
    for (let i = 0; i < 2500; i++) pg.tables.audit_log.push({ id: pg.tables.audit_log.length + 1, actor: null, action: 'comment.handled', entity: 'comment', entity_id: null, after: { key: `p${i}|x|m${i}` }, at: new Date().toISOString() });
    r = res(); await h.handler(req({ query: { handled: '1' } }), r);
    assert.equal(r.body.rows, 2501); assert.equal(r.body.handled[key].handled, true);
  } finally { f.restore(); h.restore(); }
});

test('handled: reviewer, line manager or admin; a viewer is refused; no session → 401; bad body → 400', async () => {
  const pg = fakePostgrest();
  (pg.tables.members = pg.tables.members || []).push({ id: 'u-rev', email: 'rev@samsung.com', role: 'reviewer', active: true, name: 'Rev' }, { id: 'u-view', email: 'view@samsung.com', role: 'viewer', active: true });
  const f = mockFetch([pg.route]);
  const h = api('sentiment.js', ENV);
  try {
    const body = { action: 'comment-handled', postId: 'p2', author: 'x', text: 'help', handled: true };
    let r = res(); await h.handler(req({ method: 'POST', body, headers: { cookie: cookieFor({ id: 'u-view', email: 'view@samsung.com', role: 'viewer' }) }, session: false }), r);
    assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'role_required');
    r = res(); await h.handler(req({ method: 'POST', body, headers: { cookie: cookieFor({ id: 'u-rev', email: 'rev@samsung.com', role: 'reviewer', name: 'Rev' }) }, session: false }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.by, 'Rev');
    assert.equal(pg.tables.audit_log[0].actor, 'u-rev');
    r = res(); await h.handler(req({ method: 'POST', body, session: false }), r); assert.equal(r.statusCode, 401);
    r = res(); await h.handler(req({ query: { handled: '1' }, session: false }), r); assert.equal(r.statusCode, 401);
    r = res(); await h.handler(req({ method: 'POST', body: { action: 'comment-handled', postId: 'p2' } }), r); assert.equal(r.statusCode, 400);
  } finally { f.restore(); h.restore(); }
});
