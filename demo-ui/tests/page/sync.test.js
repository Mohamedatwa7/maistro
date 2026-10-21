// M2 part 2 (b): the legacy page writes every artifact through to /api/pieces,
// asks /api/decisions before showing an approval, and reads the server's
// pieces back on login (server wins over the localStorage cache).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, json } = require('../helpers');

function piece(X, extra = {}) {
  const p = { id: 'gen-sync1', generated: true, studio: true, stage: 1, title: 'Deadpan Fold', trend: 'T', trendId: 't1', product: 'Galaxy Z Fold8', markets: ['UAE'], platforms: ['tiktok'], th: ['#000000', '#111111'], map: { product: 'Galaxy Z Fold8', msg: 'm', angle: 'a' }, ...extra };
  X.PROJECTS.unshift(p);
  return p;
}

test('attachTo writes the artifact through to /api/pieces with the piece meta and the right producer', async () => {
  const posts = [];
  const X = loadPage({ fetchImpl: async (u, init) => { if (String(u).includes('/api/pieces')) { posts.push(JSON.parse(init.body)); return json({ ok: true, version: 2, state: 'generated' }); } return new Promise(() => {}); } });
  try {
    const p = piece(X);
    X.attachTo(p, 'mood', { imageUrl: 'https://cdn/m.png', prompt: 'p', note: 'n' }, 'Muse');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].pieceId, 'gen-sync1'); assert.equal(posts[0].stage, 'mood'); assert.equal(posts[0].producedBy, 'higgsfield_soul');
    assert.deepEqual(posts[0].piece, { title: 'Deadpan Fold', product: 'Galaxy Z Fold8', msg: 'm', angle: 'a', markets: ['UAE'], platforms: ['tiktok'], trendId: 't1', trendName: 'T', origin: 'studio' });
    assert.equal(X.DELIVS.find((d) => d.id === 'd-gen-sync1-mood').ver, 'v2', 'the server version number lands on the deliverable');
    assert.equal(X.storeProducer('final', { videoUrl: 'https://cdn/v.mp4' }), 'higgsfield_seedance');
    assert.equal(X.storeProducer('qc', { real: true, runs: {} }), 'f1x8');
    assert.equal(X.storeProducer('brief', { objective: 'o' }), 'claude');
    const slim = X.storeArtifact('qc', { real: true, avg: 6.1, runs: { draft: { score: 6.1, heatmap: 'data:…', verdict: {} } } });
    assert.deepEqual(slim, { real: true, runs: { draft: { score: 6.1, verdict: {} } }, avg: 6.1 });
    assert.equal(X.storeMeta({ id: 'gen-x', title: 't', generated: true, map: {} }).origin, 'hermes_dispatch');
  } finally { X.restore(); }
});

test('a failed write marks the stage unsynced and warns once; external and still-planning pieces are not written', async () => {
  let calls = 0;
  const X = loadPage({ fetchImpl: async (u) => { if (String(u).includes('/api/pieces')) { calls++; return new Response('{"error":"storage is not configured"}', { status: 503 }); } return new Promise(() => {}); } });
  try {
    const p = piece(X);
    await X.syncStage(p, 'thumb', { imageUrl: 'https://cdn/t.png' });
    await X.syncStage(p, 'board', { imageUrl: 'https://cdn/b.png' });
    assert.equal(calls, 2); assert.equal(X.SYNC.err['gen-sync1:thumb'], 'storage is not configured'); assert.equal(X.SYNC.warned, true);
    assert.equal(await X.syncStage({ id: 'ext-1', external: true }, 'thumb', {}), null);
    assert.equal(await X.syncStage({ id: 'gen-2', planning: true }, 'plan', {}), null);
    assert.equal(calls, 2);
  } finally { X.restore(); }
});

test('recordDecision returns the server verdict; a 409 from the gate is surfaced, never applied', async () => {
  const X = loadPage({ fetchImpl: async (u, init) => { const b = JSON.parse(init.body); return b.decision === 'approved' ? new Response(JSON.stringify({ error: 'final needs the line-manager and ADLCP documents attached to this version', code: 'documents_required' }), { status: 409 }) : json({ ok: true, state: 'rejected', versionId: 'v', version: 1, decidedAt: '2026-10-21T10:00:00Z' }); } });
  try {
    const d = { id: 'd-gen-sync1-final', proj: 'gen-sync1', stage: 'final' };
    let r = await X.recordDecision(d, { decision: 'approved', name: 'M', role: 'line_manager' });
    assert.equal(r.ok, false); assert.equal(r.code, 'documents_required'); assert.match(r.error, /ADLCP documents/);
    r = await X.recordDecision(d, { decision: 'rejected', name: 'M', role: 'reviewer', reason: 'x' });
    assert.equal(r.ok, true); assert.equal(r.data.state, 'rejected');
  } finally { X.restore(); }
});

test('applyServerPieces rebuilds a studio piece the browser lost, maps stage states to deliverable statuses, lets the server win over local status, and skips external pieces', () => {
  const X = loadPage();
  try {
    const stage = (state, n, payload, decision, documents) => ({ state, updatedAt: '2026-10-21T09:00:00Z', version: payload ? { id: 'v-' + n, n, kind: 'text', payload, producedBy: 'claude', at: '2026-10-21T08:00:00Z' } : null, decision: decision || null, documents: documents || null });
    const server = [
      { id: 'gen-lost', origin: 'studio', title: 'Lost one', product: 'Galaxy S26', msg: 'msg', angle: 'ang', markets: ['KSA'], platforms: ['tiktok'], trend: 'Tr', trendId: 'tr1', status: 'in_review', stages: {
        plan: stage('approved', 1, { title: 'Lost one', product: 'Galaxy S26', msg: 'msg', angle: 'ang', markets: ['KSA'], platforms: ['tiktok'], th: ['#010101', '#020202'] }, { decision: 'approved', name: 'N. H', role: 'reviewer', at: '2026-10-21T08:30:00Z' }),
        mood: stage('locked', 0, null),
        thumb: stage('rejected', 2, { imageUrl: 'https://cdn/t.png', prompt: 'p' }, { decision: 'rejected', reason: 'logo <missing>', name: 'N. H', role: 'reviewer', at: '2026-10-21T08:40:00Z' }),
        final: stage('approved', 1, { videoUrl: 'https://cdn/v.mp4', version: 'v1', dur: '0:15', audio: 'a', variants: [{ a: '9:16', l: 'EN', k: 'original', st: 'ready' }] }, { decision: 'approved', name: 'M. Line', role: 'line_manager · KSA', at: '2026-10-21T08:50:00Z' }, { line_manager: { path: 'documents/2026/a-b.pdf', sha256: 'f'.repeat(64), size: 10, contentType: 'application/pdf' }, adlcp: { path: 'documents/2026/c-d.pdf', sha256: 'e'.repeat(64), size: 11, contentType: 'application/pdf' } }),
      } },
      { id: 'ext-abc', origin: 'external_hermes', title: 'External', stages: { plan: stage('generated', 1, { title: 'External' }) } },
      { id: 'gen-local', origin: 'studio', title: 'Local', stages: { plan: stage('generated', 1, { title: 'Local' }), board: stage('approved', 3, { imageUrl: 'https://cdn/b.png' }, { decision: 'approved', name: 'R', role: 'reviewer', at: '2026-10-21T08:55:00Z' }) } },
    ];
    const local = piece(X, { id: 'gen-local', title: 'Local' });
    local.board = { imageUrl: 'https://cdn/b-old.png' };
    X.DELIVS.unshift({ id: 'd-gen-local-board', proj: 'gen-local', stage: 'board', title: 'Storyboard', ver: 'v1', by: 'Frame', at: 'Just now', st: 'pending' });
    const changed = X.applyServerPieces(server);
    assert.ok(changed > 0);
    const lost = X.PROJECTS.find((p) => p.id === 'gen-lost');
    assert.ok(lost, 'the lost studio piece is back'); assert.equal(lost.studio, true); assert.deepEqual(lost.th, ['#010101', '#020202']); assert.equal(lost.map.msg, 'msg');
    assert.equal(lost.stage, 7, 'pointer follows the furthest stage'); assert.equal(lost.thumb.imageUrl, 'https://cdn/t.png');
    const thumb = X.DELIVS.find((d) => d.id === 'd-gen-lost-thumb');
    assert.equal(thumb.st, 'rejected'); assert.equal(thumb.ver, 'v2'); assert.equal(thumb.rej, 'logo &lt;missing&gt;', 'reason is escaped like a local rejection');
    const fin = X.DELIVS.find((d) => d.id === 'd-gen-lost-final');
    assert.equal(fin.st, 'approved'); assert.equal(fin.appr.name, 'M. Line'); assert.match(fin.appr.at, /GST$/); assert.equal(fin.appr.adlcp.sha256, 'e'.repeat(64)); assert.equal(fin.appr.lm.name, 'Line-manager approval');
    assert.ok(!X.DELIVS.some((d) => d.id === 'd-gen-lost-plan'), 'plan has no deliverable row');
    assert.ok(!X.PROJECTS.some((p) => p.id === 'ext-abc'), 'external pieces stay with /api/projects');
    const lb = X.DELIVS.find((d) => d.id === 'd-gen-local-board');
    assert.equal(lb.st, 'approved', 'server status wins'); assert.equal(lb.ver, 'v3'); assert.equal(local.board.imageUrl, 'https://cdn/b.png', 'server payload wins');
    assert.equal(X.applyServerPieces(server), 0, 'idempotent on a second pass');
  } finally { X.restore(); }
});
