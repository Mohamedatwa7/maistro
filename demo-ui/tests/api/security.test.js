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
