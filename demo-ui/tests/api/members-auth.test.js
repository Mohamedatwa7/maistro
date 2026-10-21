// M2 part 2 (c): member sessions (Supabase Auth exchange), bootstrap admins,
// admin-only invitations, and the session role replacing the claimed one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const { makeSessionCookieValue, readSession, SESSION_COOKIE } = require('../../api/_auth.js');

const ENV = { MAISTRO_SESSION_SECRET: 'sess-secret', MAISTRO_APP_PASSWORD: 'open-sesame', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon', MAISTRO_ADMIN_EMAILS: 'owner@samsung.com, Boss@Example.com' };
const USERS = { 'tok-owner-0000000000000000': { id: 'u-owner', email: 'Owner@samsung.com' }, 'tok-guest-0000000000000000': { id: 'u-guest', email: 'guest@samsung.com' }, 'tok-rev-000000000000000000': { id: 'u-rev', email: 'rev@samsung.com', user_metadata: { full_name: 'N. Haddad' } } };
const gotrue = (invites) => [(u) => String(u).startsWith('https://sb.test/auth/v1/'), (u, init) => {
  const url = String(u);
  if (url.endsWith('/auth/v1/user')) { const t = (init.headers.Authorization || '').replace('Bearer ', ''); return USERS[t] ? json(USERS[t]) : new Response('{"msg":"invalid"}', { status: 401 }); }
  if (url.endsWith('/auth/v1/invite')) { const b = JSON.parse(init.body); invites.push(b); return json({ id: 'u-' + b.email.split('@')[0], email: b.email }); }
  if (url.includes('/auth/v1/otp')) { invites.push({ otp: JSON.parse(init.body).email, url }); return json({}); }
  throw new Error('unexpected gotrue call ' + url);
}];
const cookieFor = (member, secret = 'sess-secret') => `${SESSION_COOKIE}=${makeSessionCookieValue(secret, Date.now(), undefined, member)}`;

test('session cookie: a member payload is signed with the expiry and cannot be edited; password sessions still verify as member-less', () => {
  const v = makeSessionCookieValue('s', 1000000, 60, { id: 'u1', email: 'a@b', role: 'admin', name: 'A' });
  assert.deepEqual(readSession(`${SESSION_COOKIE}=${v}`, 's', 1000000), { member: { id: 'u1', email: 'a@b', role: 'admin', name: 'A' } });
  const [exp, payload, mac] = v.split('.');
  const forged = Buffer.from(JSON.stringify({ id: 'u1', email: 'a@b', role: 'admin', name: 'A', x: 1 })).toString('base64url');
  assert.equal(readSession(`${SESSION_COOKIE}=${exp}.${forged}.${mac}`, 's', 1000000), null, 'edited payload fails the mac');
  assert.equal(readSession(`${SESSION_COOKIE}=${v}`, 's', 1000000 + 61000), null, 'expired');
  assert.equal(readSession(`${SESSION_COOKIE}=${v}`, 'other', 1000000), null, 'other secret');
  assert.deepEqual(readSession(`${SESSION_COOKIE}=${makeSessionCookieValue('s', 1000000)}`, 's', 1000000), { member: null });
});

test('login: GET exposes the public auth config; POST access_token verifies with GoTrue, bootstraps an admin, refuses a stranger, and issues a member cookie', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([gotrue([]), pg.route]);
  const h = api('login.js', ENV);
  try {
    let r = res(); await h.handler(req({ session: false }), r);
    assert.deepEqual(r.body, { configured: true, authenticated: false, member: null, auth: { magicLink: true, password: true } });
    r = res(); await h.handler(req({ method: 'POST', body: { access_token: 'tok-bogus-000000000000000' }, session: false }), r);
    assert.equal(r.statusCode, 401);
    r = res(); await h.handler(req({ method: 'POST', body: { access_token: 'tok-guest-0000000000000000' }, session: false }), r);
    assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'not_a_member'); assert.equal(pg.tables.members.length, 0);
    r = res(); await h.handler(req({ method: 'POST', body: { access_token: 'tok-owner-0000000000000000' }, session: false }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.member, { email: 'owner@samsung.com', role: 'admin', name: null });
    assert.equal(pg.tables.members.length, 1); assert.equal(pg.tables.members[0].role, 'admin'); assert.equal(pg.tables.members[0].id, 'u-owner');
    const cookie = r.headers['set-cookie'].split(';')[0];
    assert.deepEqual(readSession(cookie, 'sess-secret').member, { id: 'u-owner', email: 'owner@samsung.com', role: 'admin', name: null });
    r = res(); await h.handler(req({ headers: { cookie }, session: false }), r);
    assert.equal(r.body.authenticated, true); assert.equal(r.body.member.role, 'admin');
    // a deactivated member is refused even with a valid token
    pg.tables.members[0].active = false;
    r = res(); await h.handler(req({ method: 'POST', body: { access_token: 'tok-owner-0000000000000000' }, session: false }), r);
    assert.equal(r.statusCode, 403);
    // the password path still works while the password is configured
    r = res(); await h.handler(req({ method: 'POST', body: { password: 'open-sesame' }, session: false }), r);
    assert.equal(r.statusCode, 204);
  } finally { f.restore(); h.restore(); }
});

test('login {email}: a link goes out only for an active member or a bootstrap admin, and the answer never reveals which', async () => {
  const pg = fakePostgrest();
  const sent = [];
  const f = mockFetch([gotrue(sent), pg.route]);
  const h = api('login.js', ENV);
  (pg.tables.members = pg.tables.members || []).push({ id: 'u-rev', email: 'rev@samsung.com', role: 'reviewer', active: true }, { id: 'u-old', email: 'old@samsung.com', role: 'viewer', active: false });
  try {
    for (const [email, expectSent] of [['Owner@samsung.com', true], ['rev@samsung.com', true], ['old@samsung.com', false], ['stranger@evil.example', false]]) {
      const before = sent.length;
      const r = res(); await h.handler(req({ method: 'POST', body: { email }, headers: { 'x-forwarded-host': 'www.ma1stro.com' }, session: false }), r);
      assert.equal(r.statusCode, 200, email); assert.deepEqual(r.body, { ok: true });
      assert.equal(sent.length - before, expectSent ? 1 : 0, `${email} sent=${expectSent}`);
      if (expectSent) { assert.equal(sent.at(-1).otp, email.toLowerCase()); assert.match(sent.at(-1).url, /\?redirect_to=https%3A%2F%2Fwww\.ma1stro\.com%2F$/); }
    }
    const r = res(); await h.handler(req({ method: 'POST', body: { email: 'nope' }, session: false }), r); assert.equal(r.statusCode, 422);
  } finally { f.restore(); h.restore(); }
});

test('a member session is re-checked on every role-gated call: demotion and deactivation take effect at once; an admin cannot demote themselves', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([gotrue([]), pg.route]);
  const h = api('members.js', ENV);
  const admin = { id: 'u-owner', email: 'owner@samsung.com', role: 'admin', name: null };
  (pg.tables.members = pg.tables.members || []).push({ id: 'u-owner', email: 'owner@samsung.com', role: 'admin', active: true, created_at: '2026-10-21T00:00:00Z' });
  try {
    let r = res(); await h.handler(req({ headers: { cookie: cookieFor(admin) }, session: false }), r); assert.equal(r.statusCode, 200);
    r = res(); await h.handler(req({ method: 'PATCH', body: { id: 'u-owner', role: 'viewer' }, headers: { cookie: cookieFor(admin) }, session: false }), r);
    assert.equal(r.statusCode, 422, 'no self-demotion');
    pg.tables.members[0].role = 'viewer'; // demoted by another admin
    r = res(); await h.handler(req({ headers: { cookie: cookieFor(admin) }, session: false }), r);
    assert.equal(r.statusCode, 403, 'the 30-day cookie still says admin; the row wins'); assert.equal(r.body.code, 'role_required');
    pg.tables.members[0].role = 'admin'; pg.tables.members[0].active = false;
    r = res(); await h.handler(req({ headers: { cookie: cookieFor(admin) }, session: false }), r);
    assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'member_inactive');
    // decisions re-check too
    const decisions = api('decisions.js', ENV);
    try {
      r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-x', stage: 'thumb', decision: 'approved' }, headers: { cookie: cookieFor(admin) }, session: false }), r);
      assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'member_inactive');
    } finally { decisions.restore(); }
  } finally { f.restore(); h.restore(); }
});

test('login without a password configured: only the member path remains', async () => {
  const pg = fakePostgrest();
  const f = mockFetch([gotrue([]), pg.route]);
  const h = api('login.js', { ...ENV, MAISTRO_APP_PASSWORD: undefined });
  try {
    let r = res(); await h.handler(req({ session: false }), r);
    assert.equal(r.body.configured, true); assert.equal(r.body.auth.password, false);
    r = res(); await h.handler(req({ method: 'POST', body: { password: 'anything' }, session: false }), r);
    assert.equal(r.statusCode, 401); assert.match(r.body.error, /retired/);
  } finally { f.restore(); h.restore(); }
});

test('members: admin-only; invite goes through GoTrue and creates the row with the role; duplicates 409; self-deactivation refused; PATCH changes role/active', async () => {
  const pg = fakePostgrest();
  const invites = [];
  const f = mockFetch([gotrue(invites), pg.route]);
  const h = api('members.js', ENV);
  const admin = { id: 'u-owner', email: 'owner@samsung.com', role: 'admin', name: null };
  (pg.tables.members = pg.tables.members || []).push({ id: 'u-owner', email: 'owner@samsung.com', role: 'admin', active: true, created_at: '2026-10-21T00:00:00Z' });
  try {
    let r = res(); await h.handler(req({ session: false }), r); assert.equal(r.statusCode, 401);
    r = res(); await h.handler(req({ headers: { cookie: cookieFor(null) }, session: false }), r); assert.equal(r.statusCode, 403, 'password session has no identity'); assert.equal(r.body.code, 'member_required');
    pg.tables.members.push({ id: 'u-rv', email: 'rv@samsung.com', role: 'reviewer', active: true, created_at: '2026-10-21T00:00:00Z' });
    r = res(); await h.handler(req({ headers: { cookie: cookieFor({ id: 'u-rv', email: 'rv@samsung.com', role: 'reviewer', name: null }) }, session: false }), r); assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'role_required');
    r = res(); await h.handler(req({ headers: { cookie: cookieFor({ ...admin, role: 'reviewer' }) }, session: false }), r); assert.equal(r.statusCode, 200, 'the members row, not the cookie, decides the role');
    r = res(); await h.handler(req({ headers: { cookie: cookieFor(admin) }, session: false }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.count, 2);
    r = res(); await h.handler(req({ method: 'POST', body: { email: 'Rev@samsung.com', role: 'reviewer', name: 'N. Haddad' }, headers: { cookie: cookieFor(admin), 'x-forwarded-host': 'www.ma1stro.com' }, session: false }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.member.email, 'rev@samsung.com'); assert.equal(r.body.member.role, 'reviewer');
    assert.deepEqual(invites[0], { email: 'rev@samsung.com', data: { role: 'reviewer', full_name: 'N. Haddad' }, redirect_to: 'https://www.ma1stro.com/' });
    r = res(); await h.handler(req({ method: 'POST', body: { email: 'rev@samsung.com', role: 'viewer' }, headers: { cookie: cookieFor(admin) }, session: false }), r);
    assert.equal(r.statusCode, 409);
    r = res(); await h.handler(req({ method: 'POST', body: { email: 'nope', role: 'viewer' }, headers: { cookie: cookieFor(admin) }, session: false }), r); assert.equal(r.statusCode, 422);
    r = res(); await h.handler(req({ method: 'POST', body: { email: 'x@y.z', role: 'god' }, headers: { cookie: cookieFor(admin) }, session: false }), r); assert.equal(r.statusCode, 422);
    r = res(); await h.handler(req({ method: 'PATCH', body: { id: 'u-owner', active: false }, headers: { cookie: cookieFor(admin) }, session: false }), r); assert.equal(r.statusCode, 422);
    r = res(); await h.handler(req({ method: 'PATCH', body: { id: 'u-rev', role: 'line_manager' }, headers: { cookie: cookieFor(admin) }, session: false }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.member.role, 'line_manager');
    r = res(); await h.handler(req({ method: 'PATCH', body: { id: 'u-rev', active: false }, headers: { cookie: cookieFor(admin) }, session: false }), r);
    assert.equal(r.body.member.active, false);
    // the invited member can now sign in with their own role
    const login = api('login.js', ENV);
    try {
      pg.tables.members.find((m) => m.id === 'u-rev').active = true;
      r = res(); await login.handler(req({ method: 'POST', body: { access_token: 'tok-rev-000000000000000000' }, session: false }), r);
      assert.equal(r.statusCode, 200); assert.equal(r.body.member.role, 'line_manager');
    } finally { login.restore(); }
  } finally { f.restore(); h.restore(); }
});

test('decisions: a member session supplies the role and name itself (the claimed role is ignored); MAISTRO_REQUIRE_MEMBER closes the password path', async () => {
  const pg = fakePostgrest();
  (pg.tables.members = pg.tables.members || []).push({ id: 'u-v', email: 'v@samsung.com', role: 'viewer', active: true }, { id: 'u-r', email: 'r@samsung.com', role: 'reviewer', active: true, display_name: 'N. Haddad' });
  const f = mockFetch([pg.route]);
  // the harness's default cookie is signed with its own secret; member cookies below use the same one
  const SB = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
  const pieces = api('pieces.js', SB);
  const decisions = api('decisions.js', SB);
  const PLAN = { title: 'T', product: 'P', msg: 'm', markets: ['KSA'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] };
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-m1', stage: 'plan', artifact: PLAN } }), r); assert.equal(r.statusCode, 200);
    r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-m1', stage: 'thumb', artifact: { title: 't', sub: 's', g: ['#000000', '#111111'] } } }), r);
    const viewer = cookieFor({ id: 'u-v', email: 'v@samsung.com', role: 'viewer', name: 'V. Iewer' }, 'test-session');
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-m1', stage: 'thumb', decision: 'approved', name: 'x', role: 'admin' }, headers: { cookie: viewer }, session: false }), r);
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'role_required', 'claimed admin is ignored for a signed-in viewer');
    const reviewer = cookieFor({ id: 'u-r', email: 'r@samsung.com', role: 'reviewer', name: 'N. Haddad' }, 'test-session');
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-m1', stage: 'thumb', decision: 'approved', role: 'admin' }, headers: { cookie: reviewer }, session: false }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const row = pg.tables.approvals[0];
    assert.equal(row.decided_by, 'u-r'); assert.equal(row.name_as_signed, 'N. Haddad'); assert.equal(row.role_as_signed, 'reviewer');
    // the generator cannot approve their own version
    r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-m1', stage: 'board', artifact: { imageUrl: 'https://cdn/b.png' } }, headers: { cookie: reviewer }, session: false }), r);
    assert.equal(pg.tables.artifact_versions.at(-1).generated_by, 'u-r');
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-m1', stage: 'board', decision: 'approved' }, headers: { cookie: reviewer }, session: false }), r);
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'self_approval');
    // password sessions are closed once MAISTRO_REQUIRE_MEMBER is set
    process.env.MAISTRO_REQUIRE_MEMBER = '1';
    r = res(); await decisions.handler(req({ method: 'POST', body: { pieceId: 'gen-m1', stage: 'board', decision: 'rejected', reason: 'r', name: 'x', role: 'reviewer' } }), r);
    assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'member_required');
  } finally { delete process.env.MAISTRO_REQUIRE_MEMBER; f.restore(); pieces.restore(); decisions.restore(); }
});
