// Owner 2026-10-29 — a flexible pipeline: every step is optional and no step waits for another's approval.
// The first draft is ONE video (its clips join by themselves, a failed clip is left out); without a storyboard it is
// one text-to-video clip; the final works from the draft when there is no approved QC; a failed storyboard keyframe
// never blocks the storyboard's approval.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, HERMES_ENV, hermesFake } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'k', CRON_SECRET: 'cron', ...HERMES_ENV };
const PLAN = (id) => ({ pieceId: id, stage: 'plan', artifact: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'Folds flat', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'Folds flat', platforms: ['tiktok'], markets: ['UAE'] } });

function setup() {
  const pg = fakePostgrest();
  const H = hermesFake();
  const f = mockFetch([
    ...H.routes,
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t` })],
    [/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })],
    pg.route,
  ]);
  const h = { studio: api('studio.js', ENV), jobs: api('jobs.js', ENV), pieces: api('pieces.js', ENV), decisions: api('decisions.js', ENV) };
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  const call = async (handler, body, method = 'POST') => { const r = res(); await handler.handler(req(method === 'POST' ? { method, body } : { method, query: body }), r); return r; };
  const done = () => { f.restore(); Object.values(h).forEach((x) => x.restore()); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; };
  return { pg, hf: H.state, h, call, done };
}

test('first draft with no storyboard: ONE text-to-video clip from the plan (no first frame); when it lands the cut is assembled by itself; the final takes that cut when there is no approved QC', async () => {
  const { pg, hf, h, call, done } = setup();
  try {
    await call(h.pieces, PLAN('gen-fx1'));
    let r = await call(h.studio, { action: 'draft', pieceId: 'gen-fx1', resolution: '720p' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.artifact.fromStoryboard, false); assert.equal(r.body.artifact.shots.length, 1); assert.equal(r.body.artifact.boardVersionId, null);
    assert.equal(r.body.artifact.aspect, '9:16', 'TikTok → vertical');
    const cj = pg.tables.jobs.filter((j) => j.kind === 'hermes_video'); assert.equal(cj.length, 1);
    assert.equal(cj[0].payload.imageUrl, undefined); assert.equal(cj[0].payload.imageAssetPath, undefined, 'text-to-video: no keyframe');
    assert.match(cj[0].payload.prompt, /social video for Samsung Galaxy Z Flip8/); assert.match(cj[0].payload.prompt, /Folds flat/);
    assert.equal(JSON.parse(hf.runs[0].body.input).first_frame_url, undefined);
    // the clip lands → the assembly is queued by itself (no approval of the clip)
    hf.status = 'completed'; cj[0].next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = await call(h.jobs, { id: cj[0].id }, 'GET'); assert.equal(r.body.job.state, 'succeeded', JSON.stringify(r.body.job));
    const aj = pg.tables.jobs.filter((j) => j.kind === 'assemble'); assert.equal(aj.length, 1); assert.equal(aj[0].payload.auto, true);
    // the final with no QC at all: refused only while the draft video is still being made
    r = await call(h.studio, { action: 'final', pieceId: 'gen-fx1' }); assert.equal(r.statusCode, 409); assert.match(r.body.error, /still being made/);
    const dv = pg.tables.artifact_versions.find((v) => v.id === aj[0].payload.versionId);
    dv.payload = { ...dv.payload, assembled: { assetPath: 'pieces/gen-fx1/draft/cut.mp4', sha256: 'a'.repeat(64), durationS: 10 }, assetPath: 'pieces/gen-fx1/draft/cut.mp4', sha256: 'a'.repeat(64) };
    r = await call(h.studio, { action: 'final', pieceId: 'gen-fx1' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.reusedDraftCut, true); assert.equal(r.body.artifact.qcSkipped, true);
    assert.equal(r.body.artifact.assembled.sha256, 'a'.repeat(64), 'the draft cut IS the final'); assert.equal(r.body.artifact.fromQcVersionId, null);
  } finally { done(); }
});

test('auto-assembly: a failed clip is left out — the other clips still join into one video, assembled once', async () => {
  const { pg, hf, h, call, done } = setup();
  try {
    await call(h.pieces, PLAN('gen-fx2'));
    const store = require('../../api/_store.js');
    const kf = (n) => ({ state: 'rendered', url: `https://cdn/k${n}.png`, assetPath: `pieces/gen-fx2/board/k${n}.png`, sha256: 'f'.repeat(64) });
    const shot = (n) => ({ n, durationS: 3, type: 'medium', camera: `camera ${n}`, action: `action ${n}`, product: { visible: false }, onScreenText: { en: '', ar: '' }, line: { en: '', ar: '' }, audioCue: '', transition: 'cut', keyframe: kf(n), review: null });
    await store.recordVersion('gen-fx2', 'board', { shots: [shot(1), shot(2), shot(3)], totalS: 9, aspect: '9:16', prompt: 'p', note: 'n', rev: 0 }, { producedBy: 'claude', kind: 'text' });
    let r = await call(h.studio, { action: 'draft', pieceId: 'gen-fx2' }); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const cj = pg.tables.jobs.filter((j) => j.kind === 'hermes_video'); assert.equal(cj.length, 3);
    hf.status = (run) => (run === hf.runs[1] ? 'failed' : 'completed');
    for (const j of cj) { j.next_poll_at = new Date(Date.now() - 1000).toISOString(); await call(h.jobs, { id: j.id }, 'GET'); }
    const aj = pg.tables.jobs.filter((j) => j.kind === 'assemble'); assert.equal(aj.length, 1, 'queued once, when the last clip settled');
    const dv = pg.tables.artifact_versions.find((v) => v.id === aj[0].payload.versionId);
    assert.deepEqual(dv.payload.shots.map((s) => s.clip.state), ['rendered', 'failed', 'rendered']);
    assert.match(dv.payload.autoAssembleKey, /^1:.*\|3:/, 'shot 2 left out');
    // the manual assemble action also takes the rendered clips without approvals
    aj[0].state = 'succeeded';
    r = await call(h.studio, { action: 'draft-assemble', pieceId: 'gen-fx2' }); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  } finally { done(); }
});

test('approvals: a storyboard approves with a failed keyframe; a storyboard and brief generate with nothing upstream', async () => {
  const { pg, h, call, done } = setup();
  try {
    await call(h.pieces, PLAN('gen-fx3'));
    const store = require('../../api/_store.js');
    const ok = (n) => ({ n, durationS: 3, keyframe: { state: 'rendered', url: `https://cdn/k${n}.png` }, review: { decision: 'approved', name: 'N' } });
    await store.recordVersion('gen-fx3', 'board', { shots: [ok(1), { n: 2, durationS: 3, keyframe: { state: 'failed', error: 'generator error' }, review: null }, ok(3)], totalS: 9, aspect: '9:16', prompt: 'p', note: 'n', rev: 0 }, { producedBy: 'claude', kind: 'text' });
    let r = await call(h.decisions, { pieceId: 'gen-fx3', stage: 'board', decision: 'approved', name: 'N', role: 'reviewer' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(pg.tables.stages.find((s) => s.kind === 'board').state, 'approved');
    // the brief needs no moodboard
    await store.recordVersion('gen-fx3', 'brief', { objective: 'o', msg: 'k', markets: ['UAE'], platforms: ['tiktok'], mandatories: [] }, {});
    r = await call(h.studio, { action: 'brief', pieceId: 'gen-fx3' }); assert.notEqual(r.body.code, 'prerequisites', 'no moodboard needed for the brief');
  } finally { done(); }
});
