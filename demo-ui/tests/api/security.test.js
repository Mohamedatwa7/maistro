// Phase 11 — security hardening (SECURITY.md): campaign reads need a session or the ingest key; cookie-gated routes
// carry no open CORS.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json } = require('../helpers');

const SB = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', MAISTRO_INGEST_KEY: 'ingest' };

test('F-B: /api/projects needs the session or the ingest key; no open CORS', async () => {
  const f = mockFetch([['https://sb.test/rest/v1/', () => json([])]]);
  const h = api('projects.js', SB);
  try {
    let r = res(); await h.handler(req({ session: false }), r);
    assert.equal(r.statusCode, 401); assert.equal(r.headers['cache-control'], 'no-store');
    r = res(); await h.handler(req({ session: false, headers: { authorization: 'Bearer ingest' } }), r);
    assert.equal(r.statusCode, 200);
    r = res(); await h.handler(req(), r);
    assert.equal(r.statusCode, 200); assert.equal(r.headers['access-control-allow-origin'], undefined);
  } finally { f.restore(); h.restore(); }
});

test('F-E: no cookie-gated handler sends Access-Control-Allow-Origin: * (only the public trends feed does)', () => {
  const fs = require('node:fs'), path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'api', '_handlers');
  const open = fs.readdirSync(dir).filter((f) => /Access-Control-Allow-Origin', '\*'/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(open, ['trends.js']);
});

test('F-D: queryAll reads past the 1000-row cap (the fake caps reads like Supabase)', async () => {
  const { fakePostgrest } = require('../fake-postgrest');
  const pg = fakePostgrest();
  pg.tables.stages = Array.from({ length: 2500 }, (_, i) => ({ id: `s${String(i).padStart(5, '0')}`, piece_id: 'p', kind: 'brief', state: 'approved' }));
  const f = mockFetch([pg.route]);
  const saved = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  try {
    const { queryRows, queryAll } = require('../../api/_supabase.js');
    assert.equal((await queryRows('stages', 'select=id&limit=5000')).length, 1000, 'one request stops at 1000');
    assert.equal((await queryAll('stages', 'select=id&order=id.asc')).length, 2500);
  } finally {
    f.restore();
    if (saved.u === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved.u;
    if (saved.k === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.k;
  }
});

test('S2: a password session gets 403 member_required on every member-only action, whatever role it claims; a body role of admin changes nothing; MAISTRO_REQUIRE_MEMBER=1 closes the interim claims', async () => {
  const { fakePostgrest } = require('../fake-postgrest');
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const env = { ...SB, MAISTRO_REQUIRE_MEMBER: undefined };
  const decisions = api('decisions.js', env), studio = api('studio.js', env), members = api('members.js', env), pieces = api('pieces.js', env), sentiment = api('sentiment.js', env);
  const post = async (h, body) => { const r = res(); await h.handler(req({ method: 'POST', body }), r); return r; };
  try {
    await post(pieces, { pieceId: 'gen-s2', stage: 'plan', artifact: { title: 'T', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#000000', '#111111'] } });
    await post(pieces, { pieceId: 'gen-s2', stage: 'thumb', artifact: { title: 'X', sub: 's', g: ['#000000', '#111111'] } });
    const memberOnly = [
      ['final approval', decisions, { pieceId: 'gen-s2', stage: 'final', decision: 'approved', name: 'X', role: 'admin', documents: {} }],
      ['reopen', decisions, { action: 'reopen', pieceId: 'gen-s2', stage: 'thumb', role: 'admin' }],
      ['budget raise', studio, { action: 'budget', pieceId: 'gen-s2', budgetUsd: 999, role: 'admin' }],
      ['delivery package', studio, { action: 'final-package', pieceId: 'gen-s2', role: 'admin' }],
      ['members admin', members, { email: 'x@samsung.com', role: 'admin' }],
    ];
    for (const [what, h, body] of memberOnly) {
      const r = await post(h, body);
      assert.equal(r.statusCode, 403, `${what}: ${JSON.stringify(r.body)}`); assert.equal(r.body.code, 'member_required', what);
    }
    // an interim claim with a body role of admin is recorded as a password-session claim at reviewer level
    const r = await post(decisions, { pieceId: 'gen-s2', stage: 'thumb', decision: 'approved', name: 'Someone', role: 'admin' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(pg.tables.approvals.at(-1).role_as_signed, 'password session claim');
    // MAISTRO_REQUIRE_MEMBER=1 closes the interim claims too
    process.env.MAISTRO_REQUIRE_MEMBER = '1';
    const closed = await post(sentiment, { action: 'comment-handled', postId: 'p', author: 'a', text: 't', handled: true });
    assert.equal(closed.statusCode, 403); assert.equal(closed.body.code, 'member_required');
    const closedDecision = await post(decisions, { pieceId: 'gen-s2', stage: 'plan', decision: 'rejected', name: 'S', reason: 'x' });
    assert.equal(closedDecision.statusCode, 403);
  } finally { delete process.env.MAISTRO_REQUIRE_MEMBER; f.restore(); for (const h of [decisions, studio, members, pieces, sentiment]) h.restore(); }
});
