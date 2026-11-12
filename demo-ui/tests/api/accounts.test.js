// Named accounts (api/_accounts.js): samsung.mena signs in with a username + password and is view-only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res } = require('../helpers');

const ENV = { MAISTRO_SESSION_SECRET: 'sess-secret', MAISTRO_APP_PASSWORD: 'open-sesame' };

async function signIn(password) {
  const h = api('login.js', ENV);
  try {
    const r = res(); await h.handler(req({ method: 'POST', body: { username: 'Samsung.MENA', password }, session: false }), r);
    return r;
  } finally { h.restore(); }
}

test('accounts: samsung.mena signs in as a viewer member; a wrong password is 401', async () => {
  let r = await signIn('wrong');
  assert.equal(r.statusCode, 401);
  r = await signIn('annaho123');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.member, { email: 'samsung.mena', role: 'viewer', name: 'Samsung MENA' });
  const cookie = r.headers['set-cookie'].split(';')[0];
  const { readSession } = require('../../api/_auth.js');
  assert.equal(readSession(cookie, 'sess-secret').member.id, 'acct:samsung.mena');
});

test('accounts: a viewer may read but every generate/change call is 403 not_permitted', async () => {
  const cookie = (await signIn('annaho123')).headers['set-cookie'].split(';')[0];
  const h = api('[route].js', ENV);
  try {
    for (const route of ['studio', 'hermes', 'director', 'higgsfield', 'jobs', 'pieces', 'decisions', 'translate']) {
      const r = res(); await h.handler(req({ method: 'POST', query: { route }, body: { action: 'draft' }, headers: { cookie } }), r);
      assert.equal(r.statusCode, 403, route); assert.equal(r.body.code, 'not_permitted', route);
    }
    const r = res(); await h.handler(req({ method: 'GET', query: { route: 'login' }, headers: { cookie } }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.member.role, 'viewer');
    const out = res(); await h.handler(req({ method: 'DELETE', query: { route: 'login' }, headers: { cookie } }), out);
    assert.equal(out.statusCode, 204, 'signing out is still allowed');
  } finally { h.restore(); }
});

test('accounts: refreshMember resolves an account session without the members table', async () => {
  const h = api('_auth.js', ENV);
  try {
    const rq = { member: { id: 'acct:samsung.mena', email: 'samsung.mena', role: 'viewer' } };
    assert.equal(await h.handler.refreshMember(rq, res()), true);
    assert.equal(rq.member.role, 'viewer');
    const gone = { member: { id: 'acct:nobody', role: 'admin' } }; const r = res();
    assert.equal(await h.handler.refreshMember(gone, r), false); assert.equal(r.statusCode, 403);
  } finally { h.restore(); }
});
