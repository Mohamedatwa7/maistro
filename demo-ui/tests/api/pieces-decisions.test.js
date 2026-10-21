// M2 part 2: the campaign store (api/_store.js) behind /api/pieces and
// /api/decisions, driven end to end against an in-memory PostgREST.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const SB = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const PLAN = { title: 'Snap & Charge', product: 'Galaxy S26 Ultra', msg: 'Power that snaps on', angle: 'a', markets: ['KSA'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] };
const THUMB = { title: 'SNAP.', sub: 'hook', g: ['#0c1418', '#1d5a63'] };
const FINAL = { version: 'v1', dur: '0:15', audio: 'track', variants: [{ a: '9:16', l: 'EN', k: 'original', st: 'ready' }], videoUrl: 'https://cdn/v.mp4' };
const DOC = (n) => ({ path: `documents/2026/abc${n}-def123.pdf`, sha256: 'a'.repeat(64), size: 1234, contentType: 'application/pdf', name: `${n}.pdf`, at: '2026-10-21T10:00:00Z' });

function setup() {
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  const pieces = api('pieces.js', SB);
  const decisions = api('decisions.js', SB);
  const call = async (h, body, extra = {}) => { const r = res(); await h.handler(req({ method: 'POST', body, ...extra }), r); return r; };
  return { pg, f, pieces, decisions, call, restore: () => { f.restore(); pieces.restore(); decisions.restore(); } };
}

test('pieces: a legacy Studio campaign syncs into content_pieces with eight stages; each push appends a version and the list reads it back', async () => {
  const S = setup();
  try {
    let r = await S.call(S.pieces, { pieceId: 'gen-abc123', stage: 'plan', artifact: PLAN, piece: { title: PLAN.title, product: PLAN.product, msg: PLAN.msg, markets: PLAN.markets, platforms: PLAN.platforms, trendId: 't1', trendName: 'T', origin: 'studio' } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.version, 1); assert.equal(r.body.state, 'generated');
    assert.equal(S.pg.tables.content_pieces.length, 1); assert.equal(S.pg.tables.content_pieces[0].origin, 'studio');
    assert.equal(S.pg.tables.stages.length, 8);
    assert.deepEqual(S.pg.tables.stages.map((s) => s.kind), ['plan', 'mood', 'thumb', 'brief', 'board', 'draft', 'qc', 'final']);
    // a regenerated thumbnail is a second version, never an overwrite (A-04)
    r = await S.call(S.pieces, { pieceId: 'gen-abc123', stage: 'thumb', artifact: THUMB, producedBy: 'higgsfield_soul', kind: 'image' });
    assert.equal(r.body.version, 1);
    r = await S.call(S.pieces, { pieceId: 'gen-abc123', stage: 'thumb', artifact: { ...THUMB, title: 'SNAP. v2' } });
    assert.equal(r.body.version, 2);
    assert.equal(S.pg.tables.artifact_versions.length, 3);
    assert.equal(S.pg.tables.artifact_versions[1].produced_by, 'higgsfield_soul'); assert.equal(S.pg.tables.artifact_versions[1].kind, 'image');
    const list = res(); await S.pieces.handler(req({ method: 'GET' }), list);
    assert.equal(list.statusCode, 200); assert.equal(list.body.count, 1);
    const p = list.body.pieces[0];
    assert.equal(p.id, 'gen-abc123'); assert.equal(p.status, 'planning');
    assert.equal(p.stages.thumb.version.n, 2); assert.equal(p.stages.thumb.version.payload.title, 'SNAP. v2'); assert.equal(p.stages.thumb.state, 'generated');
    assert.equal(p.stages.mood.state, 'locked'); assert.equal(p.stages.mood.version, null);
    // validation still guards the door
    r = await S.call(S.pieces, { pieceId: 'gen-abc123', stage: 'nope', artifact: {} }); assert.equal(r.statusCode, 400);
    r = await S.call(S.pieces, { pieceId: 'gen-abc123', stage: 'mood', artifact: { note: 'x' } }); assert.equal(r.statusCode, 422);
    r = await S.call(S.pieces, { pieceId: 'x', stage: 'mood', artifact: { imageUrl: 'https://cdn/m.png' } }); assert.equal(r.statusCode, 400); assert.equal(r.body.code, 'bad_id');
    r = await S.call(S.pieces, { pieceId: 'gen-abc123', stage: 'mood', artifact: { imageUrl: 'https://cdn/m.png' } }, { session: false }); assert.equal(r.statusCode, 401);
  } finally { S.restore(); }
});

test('decisions: approval goes through the domain rules — reviewer approves a stage once, final needs both documents and a line-manager/ADLCP role, rejection needs a reason, an approved stage is immutable until an admin reopens it', async () => {
  const S = setup();
  try {
    await S.call(S.pieces, { pieceId: 'gen-abc123', stage: 'plan', artifact: PLAN, piece: { title: PLAN.title } });
    await S.call(S.pieces, { pieceId: 'gen-abc123', stage: 'thumb', artifact: THUMB });
    await S.call(S.pieces, { pieceId: 'gen-abc123', stage: 'final', artifact: FINAL, producedBy: 'higgsfield_seedance' });
    // viewer cannot approve
    let r = await S.call(S.decisions, { pieceId: 'gen-abc123', stage: 'thumb', decision: 'approved', name: 'N. Haddad', role: 'viewer' });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'role_required');
    // reviewer approves the thumbnail; the row is immutable and a second approval of the same version is refused
    r = await S.call(S.decisions, { pieceId: 'gen-abc123', stage: 'thumb', decision: 'approved', name: 'N. Haddad', role: 'reviewer', info: 'Content lead · KSA' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.state, 'approved'); assert.ok(r.body.approvalId);
    assert.equal(S.pg.tables.approvals[0].role_as_signed, 'reviewer · Content lead · KSA');
    r = await S.call(S.decisions, { pieceId: 'gen-abc123', stage: 'thumb', decision: 'approved', name: 'N. Haddad', role: 'reviewer' });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'not_reviewable');
    // a new version on an approved stage is refused (A-04/A-05)
    r = await S.call(S.pieces, { pieceId: 'gen-abc123', stage: 'thumb', artifact: THUMB });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'approved_immutable');
    // final: documents and role are enforced server-side
    r = await S.call(S.decisions, { pieceId: 'gen-abc123', stage: 'final', decision: 'approved', name: 'M. Line', role: 'line_manager', documents: { line_manager: DOC('lm') } });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'documents_required');
    r = await S.call(S.decisions, { pieceId: 'gen-abc123', stage: 'final', decision: 'approved', name: 'R. View', role: 'reviewer', documents: { line_manager: DOC('lm'), adlcp: DOC('ad') } });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'role_required');
    r = await S.call(S.decisions, { pieceId: 'gen-abc123', stage: 'final', decision: 'approved', name: 'M. Line', role: 'line_manager', documents: { line_manager: { ...DOC('lm'), sha256: 'nope' }, adlcp: DOC('ad') } });
    assert.equal(r.statusCode, 409, 'a document without a real checksum does not count'); assert.equal(r.body.code, 'documents_required');
    r = await S.call(S.decisions, { pieceId: 'gen-abc123', stage: 'final', decision: 'approved', name: 'M. Line', role: 'line_manager', documents: { line_manager: DOC('lm'), adlcp: DOC('ad') } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.state, 'approved');
    assert.equal(S.pg.tables.adlcp_documents.length, 2);
    assert.deepEqual(S.pg.tables.adlcp_documents.map((d) => d.kind).sort(), ['adlcp', 'line_manager']);
    // rejection needs a reason and records it
    r = await S.call(S.decisions, { pieceId: 'gen-abc123', stage: 'plan', decision: 'rejected', name: 'N. Haddad', role: 'reviewer', reason: '  ' });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'reason_required');
    r = await S.call(S.decisions, { pieceId: 'gen-abc123', stage: 'plan', decision: 'rejected', name: 'N. Haddad', role: 'reviewer', reason: 'wrong product' });
    assert.equal(r.statusCode, 200); assert.equal(r.body.state, 'rejected');
    // reopen is admin-only; afterwards a new version may land
    r = await S.call(S.decisions, { action: 'reopen', pieceId: 'gen-abc123', stage: 'thumb', role: 'reviewer' });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'role_required');
    r = await S.call(S.decisions, { action: 'reopen', pieceId: 'gen-abc123', stage: 'thumb', role: 'admin' });
    assert.equal(r.statusCode, 200); assert.equal(r.body.state, 'ready');
    r = await S.call(S.pieces, { pieceId: 'gen-abc123', stage: 'thumb', artifact: THUMB });
    assert.equal(r.statusCode, 200); assert.equal(r.body.version, 2, 'reopened stage takes the next version');
    // the list carries the latest decision and the documents
    const list = res(); await S.pieces.handler(req({ method: 'GET' }), list);
    const p = list.body.pieces[0];
    assert.equal(p.stages.final.state, 'approved'); assert.equal(p.stages.final.decision.name, 'M. Line'); assert.ok(p.stages.final.documents.adlcp.sha256);
    assert.equal(p.stages.plan.state, 'rejected'); assert.equal(p.stages.plan.decision.reason, 'wrong product');
    // unknown piece / stage without a version
    r = await S.call(S.decisions, { pieceId: 'gen-nope', stage: 'thumb', decision: 'approved', name: 'x', role: 'reviewer' }); assert.equal(r.statusCode, 404);
    r = await S.call(S.decisions, { pieceId: 'gen-abc123', stage: 'mood', decision: 'approved', name: 'x', role: 'reviewer' }); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'no_version');
    r = await S.call(S.decisions, { pieceId: 'gen-abc123', stage: 'mood', decision: 'maybe', name: 'x', role: 'reviewer' }); assert.equal(r.statusCode, 400);
  } finally { S.restore(); }
});

test('ingest: an accepted external push is also recorded in the campaign store as origin external_hermes; a store failure never fails the push', async () => {
  const pg = fakePostgrest();
  const events = [];
  const f = mockFetch([
    ['https://sb.test/rest/v1/campaign_events', (u, init) => (init.method === 'POST' ? (events.push(JSON.parse(init.body)), new Response('', { status: 201 })) : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))],
    pg.route,
  ]);
  const h = api('ingest.js', { MAISTRO_INGEST_KEY: 'k1', ...SB });
  try {
    let r = res(); await h.handler(req({ method: 'POST', body: { stage: 'plan', artifact: PLAN, trend: { id: 't1', name: 'T' } }, headers: { Authorization: 'Bearer k1' }, session: false }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.stored, true); assert.equal(events.length, 1);
    const id = r.body.projectId;
    assert.equal(pg.tables.content_pieces[0].origin, 'external_hermes'); assert.equal(pg.tables.content_pieces[0].legacy_id, id); assert.equal(pg.tables.content_pieces[0].trend_name, 'T');
    assert.equal(pg.tables.artifact_versions[0].produced_by, 'external_hermes');
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'thumb', projectId: id, artifact: THUMB }, headers: { Authorization: 'Bearer k1' }, session: false }), r);
    assert.equal(r.body.stored, true); assert.equal(pg.tables.artifact_versions.length, 2);
    // break the store: the push is still accepted and says so
    pg.tables.content_pieces[0].legacy_id = 'moved';
    const orig = pg.handler; const broken = async (u, init) => { if (String(u).includes('/stages') && (init.method || 'GET') === 'GET') throw new Error('db down'); return orig(u, init); };
    pg.route[1] = broken;
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'brief', projectId: id, artifact: { objective: 'o', msg: 'm', markets: ['KSA'], platforms: ['tiktok'], deadline: 'd', mandatories: [] } }, headers: { Authorization: 'Bearer k1' }, session: false }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.stored, false); assert.match(r.body.storeError, /db down/); assert.equal(events.length, 3);
  } finally { f.restore(); h.restore(); }
});
