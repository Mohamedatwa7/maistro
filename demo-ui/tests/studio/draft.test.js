// Phase 6.6a — First draft: one Seedance image-to-video clip per APPROVED storyboard shot, from its keyframe, through the
// job service (signed once, idempotent body), attached to the draft version's shot slot; per-clip review; one clip re-renders alone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, loadPage } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', HF_CREDENTIALS: 'id:secret', ANTHROPIC_API_KEY: 'k', CRON_SECRET: 'cron' };
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
const shot = (n, durationS, visible, type = 'medium') => ({ n, durationS, type, camera: `camera ${n}`, action: `action ${n}`, product: { visible, feature: visible ? 'FlexWindow' : '' }, onScreenText: { en: n === 1 ? 'Hook' : '', ar: n === 1 ? 'هوك' : '' }, line: { en: '', ar: '' }, audioCue: 'ambient', transition: n === 4 ? 'none' : 'cut', keyframe: { state: 'rendered', url: `https://cdn/k${n}.png`, assetPath: `pieces/gen-dr1/board/k${n}.png`, sha256: 'a'.repeat(64), jobId: `kj${n}` }, review: { decision: 'approved', by: 'N' } });

test('POST /api/studio action draft: refused until every storyboard shot is approved; then one image-to-video job per shot (keyframe signed once and kept on the job, duration clamped to Seedance 4–30 s, no aspect on the body); clips attach to the draft version; per-clip review; one clip re-renders alone', async () => {
  const pg = fakePostgrest();
  const hf = { status: 'in_progress', submits: [] };
  const f = mockFetch([
    [/\/bytedance\/seedance-2\.5\/image-to-video$/, (u, init) => { hf.submits.push({ body: JSON.parse(init.body), idem: init.headers['Idempotency-Key'] }); return json({ status: 'queued', request_id: `vid0000${hf.submits.length}`, status_url: 'x', cancel_url: 'y' }); }],
    [/\/bytedance\/seedance-2\.5\/text-to-video$/, () => { throw new Error('text-to-video must not be used for a keyframe clip'); }],
    [/\/requests\/vid0000\d\/status/, (u) => { const id = String(u).match(/vid0000(\d)/)[1]; return json(hf.status === 'completed' ? { status: 'completed', video: { url: `https://d3u0tzju9qaucj.cloudfront.net/c${id}.mp4` } } : { status: hf.status }); }],
    [/d3u0tzju9qaucj\.cloudfront\.net\/c\d\.mp4$/, () => new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4' } })],
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t${Date.now()}` })],
    [/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-dr1', stage: 'plan', artifact: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', platforms: ['tiktok'], markets: ['UAE'] } } }), r);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft', pieceId: 'gen-dr1' } }), r); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'prerequisites');
    // a storyboard with shots (through the store, as the Studio writes it), shot 3 not yet approved
    const store = require('../../api/_store.js');
    const shots = [shot(1, 2, true, 'close_up'), shot(2, 4, true), shot(3, 5, true, 'wide'), shot(4, 4, false, 'end_card')];
    shots[2].review = null;
    const bv = await store.recordVersion('gen-dr1', 'board', { shots, hookShot: 1, totalS: 15, aspect: '9:16', prompt: 'storyboard of 4 shots', note: 'n', rev: 0 }, { producedBy: 'claude', kind: 'text' });
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft', pieceId: 'gen-dr1' } }), r);
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'prerequisites'); assert.deepEqual(r.body.pending, [3]);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'shot-decide', stage: 'board', pieceId: 'gen-dr1', shot: 3, decision: 'approved', name: 'N' } }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.pending, []);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft', pieceId: 'gen-dr1', resolution: '1080p' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.version, 1); assert.equal(r.body.artifact.version, 'v1'); assert.equal(r.body.artifact.totalS, 15); assert.equal(r.body.artifact.resolution, '1080p'); assert.equal(r.body.artifact.boardVersionId, bv.versionId); assert.equal(r.body.artifact.videoUrl, null); assert.equal(r.body.artifact.shots[0].clip, null); assert.equal(r.body.artifact.shots[0].keyframe.assetPath, 'pieces/gen-dr1/board/k1.png');
    assert.equal(r.body.jobs.length, 4); assert.ok(r.body.jobs.every((j) => j.state === 'running'), JSON.stringify(r.body.jobs.map((j) => [j.state, j.error])));
    const cj = pg.tables.jobs.filter((j) => j.kind === 'higgsfield_video');
    assert.equal(cj.length, 4); assert.deepEqual(cj.map((j) => j.payload.duration), [4, 4, 5, 4], 'Seedance minimum 4 s; the assembly trims to the shot');
    assert.deepEqual(cj.map((j) => j.payload.imageAssetPath), [1, 2, 3, 4].map((n) => `pieces/gen-dr1/board/k${n}.png`));
    assert.ok(cj.every((j) => /^https:\/\/sb\.test\/storage\/v1\/object\/sign\/assets\/pieces\/gen-dr1\/board\/k\d\.png\?token=/.test(j.payload.imageUrl)), 'the keyframe was signed once and kept on the job: ' + cj[0].payload.imageUrl);
    assert.equal(hf.submits.length, 4); assert.equal(hf.submits[0].body.image_url, cj[0].payload.imageUrl); assert.equal(hf.submits[0].body.aspect_ratio, undefined, 'image-to-video takes no aspect'); assert.equal(hf.submits[0].body.duration, 4); assert.equal(hf.submits[0].body.resolution, '1080p'); assert.equal(hf.submits[0].body.generate_audio, true); assert.equal(hf.submits[0].idem, cj[0].id);
    assert.match(cj[0].payload.prompt, /^camera 1\. action 1 The device stays exactly as in the first frame/); assert.match(cj[3].payload.prompt, /^camera 4\. action 4 Present tense/);
    assert.equal(pg.tables.stages.find((s) => s.kind === 'draft').state, 'generating');
    // the clips land one by one on the SAME version; no vision check for clips (frame checks come with assembly)
    hf.status = 'completed'; for (const j of cj) j.next_poll_at = new Date(Date.now() - 1000).toISOString();
    for (const j of cj) { r = res(); await jobs.handler(req({ method: 'GET', query: { id: j.id } }), r); assert.equal(r.body.job.state, 'succeeded', JSON.stringify(r.body.job)); assert.equal(r.body.job.result.artifact, undefined); assert.equal(r.body.job.result.attached.slot, 'clip'); }
    const dv = pg.tables.artifact_versions.find((v) => v.id === r.body.job.result.attached.versionId);
    assert.ok(dv.payload.shots.every((s) => s.clip && s.clip.state === 'rendered' && s.clip.assetPath && s.clip.sha256)); assert.equal(dv.payload.shots[0].clip.durationS, 4); assert.equal(dv.payload.shots[0].clip.fromKeyframe, 'pieces/gen-dr1/board/k1.png'); assert.equal(dv.payload.rev, 4);
    assert.equal(pg.tables.jobs.filter((j) => j.kind === 'vision_check').length, 0); assert.equal(pg.tables.artifact_versions.filter((v) => v.stage_id === pg.tables.stages.find((s) => s.kind === 'draft').id).length, 1);
    assert.equal(pg.tables.stages.find((s) => s.kind === 'draft').state, 'generated');
    r = res(); await studio.handler(req({ method: 'GET', query: { shots: 'gen-dr1', stage: 'draft' } }), r); assert.equal(r.statusCode, 200); assert.equal(r.body.stage, 'draft'); assert.equal(r.body.live, 0); assert.equal(r.body.payload.shots.length, 4);
    // review a clip; re-render one clip with changes (only that one), its approval cleared, history kept
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'shot-decide', stage: 'draft', pieceId: 'gen-dr1', shot: 1, decision: 'approved', name: 'N' } }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft-shot', pieceId: 'gen-dr1', shot: 2, changes: 'slower push-in' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(hf.submits.length, 5); assert.match(hf.submits[4].body.prompt, /Changes requested by the reviewer .*slower push-in/);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft-shot', pieceId: 'gen-dr1', shot: 2 } }), r); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'busy');
    const rj = pg.tables.jobs.filter((j) => j.kind === 'higgsfield_video').at(-1); rj.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await jobs.handler(req({ method: 'GET', query: { id: rj.id } }), r); assert.equal(r.body.job.state, 'succeeded');
    const dv2 = pg.tables.artifact_versions.find((v) => v.id === dv.id);
    assert.equal(dv2.payload.shots[1].clip.jobId, rj.id); assert.equal(dv2.payload.shots[1].clipHistory.length, 1); assert.equal(dv2.payload.shots[1].review, null); assert.equal(dv2.payload.shots[0].review.decision, 'approved');
    assert.ok(pg.tables.generation_records.filter((g) => g.kind === 'higgsfield_video' && g.status === 'succeeded').length >= 5);
    assert.equal(pg.tables.stages.find((s) => s.kind === 'draft').state, 'generated');
  } finally { f.restore(); studio.restore(); jobs.restore(); pieces.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('adapter: a video request with imageUrl goes to image-to-video with no aspect_ratio; without one it stays text-to-video; generateAudio is explicit', async () => {
  const bodies = [];
  const f = mockFetch([[/api\.higgsfield\.ai\/bytedance/, (u, init) => { bodies.push({ url: String(u), body: JSON.parse(init.body) }); return json({ status: 'queued', request_id: 'abcdefgh1234' }); }]]);
  const saved = process.env.HF_CREDENTIALS; process.env.HF_CREDENTIALS = 'id:secret';
  try {
    const hg = require('../../api/_adapters/higgsfield.js');
    await hg.submit({ kind: 'video', prompt: 'p', imageUrl: 'https://x/k.png', endImageUrl: 'https://x/k2.png', duration: 3, resolution: '720p', generateAudio: false }, { idempotencyKey: 'a' });
    assert.match(bodies[0].url, /image-to-video$/); assert.deepEqual(bodies[0].body, { image_url: 'https://x/k.png', prompt: 'p', duration: 4, resolution: '720p', generate_audio: false, bitrate_mode: 'high', end_image_url: 'https://x/k2.png' });
    await hg.submit({ kind: 'video', prompt: 'p', aspect_ratio: '9:16', duration: 8 }, { idempotencyKey: 'b' });
    assert.match(bodies[1].url, /text-to-video$/); assert.deepEqual(bodies[1].body, { prompt: 'p', aspect_ratio: '9:16', resolution: '720p', duration: 8, generate_audio: true });
  } finally { f.restore(); if (saved === undefined) delete process.env.HF_CREDENTIALS; else process.env.HF_CREDENTIALS = saved; }
});

test('page: rDraft renders each clip with its state, review badges and per-clip actions; the draft is requested from the approved storyboard', async () => {
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    const shots = [1, 2, 3].map((n) => ({ n, durationS: 4, type: 'medium', camera: `cam ${n}`, action: `act ${n}`, product: { visible: n < 3, feature: '' }, onScreenText: { en: n === 1 ? 'Hook' : '', ar: '' }, line: { en: '', ar: '' }, audioCue: 'a', transition: 'cut', keyframe: {}, clip: null, review: null }));
    shots[0].clip = { state: 'rendered', url: 'https://cdn/c1.mp4', assetPath: 'pieces/gen-d/draft/c1.mp4', durationS: 4 }; shots[0].review = { decision: 'approved', by: 'N' };
    shots[1].clip = { state: 'failed', error: 'moderated' };
    const p = { id: 'gen-d', generated: true, studio: true, stage: 5, title: 'T', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'Galaxy Z Flip8', msg: 'm', angle: 'a' }, mood: {}, brief: { objective: 'o', msg: 'k', markets: ['UAE'], platforms: ['tiktok'], mandatories: [] }, board: { shots: shots.map((s) => ({ ...s, keyframe: { state: 'rendered' }, review: { decision: 'approved' } })), totalS: 12, aspect: '9:16' },
      draft: { shots, totalS: 12, aspect: '9:16', resolution: '720p', version: 'v1', boardApproved: true, variants: [{ a: '9:16', l: '720p', k: 'seedance', st: 'rendering' }], dur: '12s', audio: 'x' } };
    X.PROJECTS.unshift(p);
    const html = X.stageArtifact(p, 5);
    assert.match(html, /FIRST DRAFT v1 · 3 CLIPS · 12 s · 720p/); assert.match(html, /1\/3 CLIPS RENDERED/); assert.match(html, /1\/3 CLIPS APPROVED/);
    assert.match(html, /<video controls playsinline muted data-asset="pieces\/gen-d\/draft\/c1\.mp4"/); assert.match(html, /SHOT 1 · 4 s \(clip 4 s\)/); assert.match(html, /Render failed — moderated/); assert.match(html, /Seedance is rendering the clip…/);
    assert.match(html, /Overlay at assembly: <b style="color:#fff">Hook<\/b>/); assert.match(html, /shotRejectForm\('gen-d',1,'draft'\)/); assert.match(html, /shotRegenForm\('gen-d',2,'draft'\)/);
    assert.ok(X.BOARD_POLL['gen-d:draft'], 'pending clips start the draft poll'); clearTimeout(X.BOARD_POLL['gen-d:draft']);
  } finally { X.restore(); }
});
