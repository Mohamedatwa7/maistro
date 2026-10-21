// Characterization: POST /api/ingest (external Hermes door) and GET /api/projects (aggregation).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { req, res, api, mockFetch, json } = require('../helpers');

const SB = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
const PLAN = { title: 'Pocket Dimension', product: 'Galaxy Z Fold8', msg: 'More than two apps', markets: ['KSA', 'UAE'], platforms: ['tiktok'], th: ['#111111', '#222222'] };

test('ingest: method, key, auth, stage and artifact validation (observed status codes)', async () => {
  const f = mockFetch([]);
  try {
    let h = api('ingest.js', { MAISTRO_INGEST_KEY: undefined, ...SB });
    let r = res(); await h.handler(req({ method: 'GET' }), r); assert.equal(r.statusCode, 405); h.restore();
    h = api('ingest.js', { MAISTRO_INGEST_KEY: undefined, ...SB });
    r = res(); await h.handler(req({ method: 'POST', body: {} }), r); assert.equal(r.statusCode, 503); h.restore();
    h = api('ingest.js', { MAISTRO_INGEST_KEY: 'k1', ...SB });
    r = res(); await h.handler(req({ method: 'POST', body: {} }), r); assert.equal(r.statusCode, 401);
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'nope', artifact: {} }, headers: { Authorization: 'Bearer k1' } }), r);
    assert.equal(r.statusCode, 400); assert.match(r.body.error, /unknown stage/);
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'mood', artifact: { note: 'x' } }, headers: { Authorization: 'Bearer k1' } }), r);
    assert.equal(r.statusCode, 422); assert.match(r.body.error, /missing: tiles/);
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'board', artifact: [{ d: 'no tc' }] }, headers: { Authorization: 'Bearer k1' } }), r);
    assert.equal(r.statusCode, 422);
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'mood', projectId: 'bad id!', artifact: { note: 'x', tiles: [] } }, headers: { Authorization: 'Bearer k1' } }), r);
    assert.equal(r.statusCode, 400); assert.match(r.body.error, /projectId must be/);
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'mood', artifact: { note: 'x', tiles: [] } }, headers: { Authorization: 'Bearer k1' } }), r);
    assert.equal(r.statusCode, 400); assert.match(r.body.error, /missing projectId/);
    h.restore();
  } finally { f.restore(); }
});

test('ingest: plan mints an ext- projectId and inserts one campaign_events row; later stages reuse it', async () => {
  const inserted = [];
  const f = mockFetch([['https://sb.test/rest/v1/campaign_events', (url, init) => {
    if (init.method === 'POST') { inserted.push(JSON.parse(init.body)); return new Response('', { status: 201 }); }
    // GET: the latest stored event for (project, stage) — what the idempotency check reads
    const m = url.match(/project_id=eq\.([^&]+)&stage=eq\.([^&]+)/);
    const latest = [...inserted].reverse().find((e) => e.project_id === decodeURIComponent(m[1]) && e.stage === decodeURIComponent(m[2]));
    return json(latest ? [{ agent: latest.agent, artifact: latest.artifact, at: '2026-10-21T10:00:00Z' }] : []);
  }]]);
  const h = api('ingest.js', { MAISTRO_INGEST_KEY: 'k1', ...SB });
  try {
    let r = res();
    await h.handler(req({ method: 'POST', body: { stage: 'plan', trend: { id: 't1', name: 'Trend' }, artifact: PLAN }, headers: { Authorization: 'Bearer k1' } }), r);
    assert.equal(r.statusCode, 200);
    assert.match(r.body.projectId, /^ext-[a-z0-9]+$/);
    assert.deepEqual([r.body.stage, r.body.agent, r.body.ok], ['plan', 'Hermes', true]);
    assert.equal(inserted[0].project_id, r.body.projectId);
    assert.equal(inserted[0].stage, 'plan');
    assert.deepEqual(inserted[0].trend, { id: 't1', name: 'Trend' });
    const pid = r.body.projectId;
    r = res();
    await h.handler(req({ method: 'POST', body: { projectId: pid, stage: 'brief', agent: 'Quill', artifact: { objective: 'o', msg: 'm', markets: [], platforms: [], deadline: 'd', mandatories: [] } }, headers: { Authorization: 'Bearer k1' } }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(inserted[1].project_id, pid);
    // M1 idempotency (AUDIT C-11): an identical re-push is acknowledged, not inserted again
    r = res();
    await h.handler(req({ method: 'POST', body: { projectId: pid, stage: 'brief', artifact: { mandatories: [], deadline: 'd', platforms: [], markets: [], msg: 'm', objective: 'o' } }, headers: { Authorization: 'Bearer k1' } }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.duplicate, true, 'key order does not matter — the comparison is structural');
    assert.equal(inserted.length, 2);
    // a CHANGED artifact for the same stage is a new version and is inserted
    r = res();
    await h.handler(req({ method: 'POST', body: { projectId: pid, stage: 'brief', artifact: { objective: 'o2', msg: 'm', markets: [], platforms: [], deadline: 'd', mandatories: [] } }, headers: { Authorization: 'Bearer k1' } }), r);
    assert.equal(r.body.duplicate, undefined);
    assert.equal(inserted.length, 3);
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally { f.restore(); h.restore(); }
});

test('projects: first event per stage wins (rows arrive newest-first), stage pointer, plan required, sorted by pushedAt', async () => {
  const at = (d) => `2026-10-${d}T10:00:00Z`;
  const events = [ // newest first, as PostgREST returns with order=at.desc
    { project_id: 'ext-b', stage: 'mood', agent: 'Muse', trend: null, artifact: { note: 'v2', tiles: [] }, at: at('20') },
    { project_id: 'ext-b', stage: 'mood', agent: 'Muse', trend: null, artifact: { note: 'v1', tiles: [] }, at: at('19') },
    { project_id: 'ext-b', stage: 'plan', agent: 'Hermes', trend: { id: 't', name: 'T' }, artifact: PLAN, at: at('18') },
    { project_id: 'ext-c', stage: 'mood', agent: 'Muse', trend: null, artifact: { note: 'orphan', tiles: [] }, at: at('17') }, // no plan → dropped
    { project_id: 'ext-a', stage: 'qc', agent: 'Sentinel', trend: null, artifact: { f1x8: [], f1x8Note: '', human: 'x', humanNote: '' }, at: at('16') },
    { project_id: 'ext-a', stage: 'plan', agent: 'Hermes', trend: null, artifact: { ...PLAN, title: 'A' }, at: at('10') },
  ];
  const f = mockFetch([['https://sb.test/rest/v1/campaign_events', () => json(events)]]);
  const h = api('projects.js', SB);
  try {
    const r = res();
    await h.handler(req(), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.count, 2);
    const [b, a] = r.body.projects; // sorted by plan.at desc → ext-b (18) before ext-a (10)
    assert.equal(b.id, 'ext-b');
    assert.equal(b.mood.note, 'v2', 'the newest push wins because the first row seen per stage wins');
    assert.equal(b.stage, 1, 'mood is STAGE_ORDER index 0 → stage 1');
    assert.equal(b.trend, 'T');
    assert.deepEqual(b.agents.mood, { agent: 'Muse', at: at('20') });
    assert.equal(a.id, 'ext-a');
    assert.equal(a.stage, 6, 'qc forces stage 6');
    assert.equal(a.trend, 'A', 'no trend → title');
    assert.equal(a.external, true);
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally { f.restore(); h.restore(); }
});

test('projects: Supabase failure → 502 {error}', async () => {
  const f = mockFetch([['https://sb.test/rest/v1/campaign_events', () => new Response('nope', { status: 500 })]]);
  const h = api('projects.js', SB);
  try {
    const r = res(); await h.handler(req(), r);
    assert.equal(r.statusCode, 502); assert.match(r.body.error, /supabase select failed \(500\)/);
  } finally { f.restore(); h.restore(); }
});
