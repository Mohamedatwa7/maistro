// Phase 6.6a — First draft: one image-to-video clip (the Hermes video bot) per APPROVED storyboard shot, from its keyframe, through the
// job service (signed once, idempotent body), attached to the draft version's shot slot; per-clip review; one clip re-renders alone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, loadPage, HERMES_ENV, hermesFake } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'k', CRON_SECRET: 'cron', ...HERMES_ENV };
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
const shot = (n, durationS, visible, type = 'medium') => ({ n, durationS, type, camera: `camera ${n}`, action: `action ${n}`, product: { visible, feature: visible ? 'FlexWindow' : '' }, onScreenText: { en: n === 1 ? 'Hook' : '', ar: n === 1 ? 'هوك' : '' }, line: { en: '', ar: '' }, audioCue: 'ambient', transition: n === 4 ? 'none' : 'cut', keyframe: { state: 'rendered', url: `https://cdn/k${n}.png`, assetPath: `pieces/gen-dr1/board/k${n}.png`, sha256: 'a'.repeat(64), jobId: `kj${n}` }, review: { decision: 'approved', by: 'N' } });

test('POST /api/studio action draft: refused while a keyframe is missing; an unreviewed shot does not hold it (owner 2026-11-05: no storyboard approval needed); then ONE continuous take through every scene keyframe (owner 2026-11-05: one flowing video, not clips joined together; keyframes signed once and kept on the job, the first scene as the first frame); the take lands on every scene as its slice; re-rendering a scene renders the whole take', async () => {
  const pg = fakePostgrest();
  const H = hermesFake(); const hf = H.state;
  const f = mockFetch([
    ...H.routes,
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t${Date.now()}` })],
    [/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-dr1', stage: 'plan', artifact: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', platforms: ['tiktok'], markets: ['UAE'] } } }), r);
    // a storyboard with shots (through the store, as the Studio writes it): shot 3's keyframe still rendering
    const store = require('../../api/_store.js');
    const shots = [shot(1, 2, true, 'close_up'), shot(2, 4, true), shot(3, 5, true, 'wide'), shot(4, 4, false, 'end_card')];
    const k3 = shots[2].keyframe; shots[2].keyframe = { state: 'rendering' };
    await store.recordVersion('gen-dr1', 'board', { shots, hookShot: 1, totalS: 15, aspect: '9:16', prompt: 'storyboard of 4 shots', note: 'n', rev: 0 }, { producedBy: 'claude', kind: 'text' });
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft', pieceId: 'gen-dr1' } }), r);
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'prerequisites'); assert.deepEqual(r.body.pending, [3], 'a clip needs its keyframe');
    // every keyframe rendered, shot 3 NOT reviewed: the first draft starts anyway (owner 2026-11-05: no storyboard approval needed)
    shots[2].keyframe = k3; shots[2].review = null;
    const bv = await store.recordVersion('gen-dr1', 'board', { shots, hookShot: 1, totalS: 15, aspect: '9:16', prompt: 'storyboard of 4 shots', note: 'n', rev: 1 }, { producedBy: 'claude', kind: 'text' });
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft', pieceId: 'gen-dr1', resolution: '1080p' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.version, 1); assert.equal(r.body.artifact.version, 'v1'); assert.equal(r.body.artifact.totalS, 15); assert.equal(r.body.artifact.resolution, '1080p'); assert.equal(r.body.artifact.boardVersionId, bv.versionId); assert.equal(r.body.artifact.videoUrl, null); assert.equal(r.body.artifact.shots[0].clip, null); assert.equal(r.body.artifact.shots[0].keyframe.assetPath, 'pieces/gen-dr1/board/k1.png');
    // owner 2026-11-05: the 4 scenes (15 s) render as ONE continuous take, not 4 clips joined together
    assert.equal(r.body.artifact.oneTake, true); assert.deepEqual(r.body.artifact.takes, [{ lead: 1, shots: [1, 2, 3, 4], durationS: 15 }]);
    assert.ok(r.body.artifact.shots.every((s) => s.take === 1 && s.transition === 'cut')); assert.equal(r.body.artifact.shots[3].boardTransition, 'none');
    assert.equal(r.body.jobs.length, 1); assert.equal(r.body.jobs[0].state, 'running', JSON.stringify(r.body.jobs));
    const cj = pg.tables.jobs.filter((j) => j.kind === 'hermes_video');
    assert.equal(cj.length, 1); assert.equal(cj[0].payload.duration, 15); assert.equal(cj[0].payload.imageAssetPath, 'pieces/gen-dr1/board/k1.png');
    assert.deepEqual(cj[0].payload.sceneKeyframes.map((k) => k.assetPath), [1, 2, 3, 4].map((n) => `pieces/gen-dr1/board/k${n}.png`));
    assert.ok(/sign\/assets\/pieces\/gen-dr1\/board\/k1\.png\?token=/.test(cj[0].payload.imageUrl), 'the first keyframe was signed once and kept on the job');
    assert.equal(cj[0].payload.sceneKeyframeUrls.length, 4); cj[0].payload.sceneKeyframeUrls.forEach((u, i) => assert.match(u, new RegExp(`sign/assets/pieces/gen-dr1/board/k${i + 1}\\.png\\?token=`)));
    assert.equal(cj[0].payload.endImageUrl, undefined, 'one take: no end frame');
    assert.equal(hf.runs.length, 1); assert.equal(hf.runs[0].profile, 'video');
    const input = JSON.parse(hf.runs[0].body.input);
    assert.equal(input.first_frame_url, cj[0].payload.imageUrl, 'the first scene is the first frame'); assert.deepEqual(input.scene_keyframe_urls, cj[0].payload.sceneKeyframeUrls); assert.equal(input.single_take, true); assert.equal(input.end_frame_url, undefined);
    assert.deepEqual((({ aspect, resolution, duration, audio }) => ({ aspect, resolution, duration, audio }))(input), { aspect: '9:16', resolution: '1080p', duration: 15, audio: true }); assert.equal(hf.runs[0].headers['Idempotency-Key'], cj[0].id);
    assert.match(input.task, /ONE continuous single-take video that flows through the 4 storyboard scenes in order/);
    assert.match(cj[0].payload.prompt, /^ONE continuous single-take video of about 15 seconds/); assert.match(cj[0].payload.prompt, /scene 1 \(0–2 s\): camera 1\. action 1; scene 2 \(2–6 s\): camera 2\. action 2/);
    assert.match(cj[0].payload.prompt, /One continuous soundtrack/); assert.match(cj[0].payload.prompt, /The device stays exactly as in the keyframes/);
    assert.equal(pg.tables.stages.find((s) => s.kind === 'draft').state, 'generating');
    // the take lands on every scene, each with its slice of the take (the assembly cuts them out of the one file)
    hf.status = 'completed'; cj[0].next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await jobs.handler(req({ method: 'GET', query: { id: cj[0].id } }), r); assert.equal(r.body.job.state, 'succeeded', JSON.stringify(r.body.job)); assert.equal(r.body.job.result.attached.slot, 'clip');
    const dv = pg.tables.artifact_versions.find((v) => v.id === r.body.job.result.attached.versionId);
    assert.ok(dv.payload.shots.every((s) => s.clip && s.clip.state === 'rendered' && s.clip.assetPath && s.clip.assetPath === dv.payload.shots[0].clip.assetPath), 'one file for every scene');
    assert.deepEqual(dv.payload.shots.map((s) => [s.clip.take.from, s.clip.take.to]), [[0, 0.1333], [0.1333, 0.4], [0.4, 0.7333], [0.7333, 1]]);
    assert.deepEqual(dv.payload.shots.map((s) => s.clip.fromKeyframe), [1, 2, 3, 4].map((n) => `pieces/gen-dr1/board/k${n}.png`), 'each scene names its own keyframe (staleness per scene)');
    const auto = pg.tables.jobs.filter((j) => j.kind === 'assemble'); assert.equal(auto.length, 1); assert.equal(auto[0].payload.auto, true); assert.equal(auto[0].payload.versionId, dv.id); auto[0].state = 'succeeded';
    assert.equal(pg.tables.stages.find((s) => s.kind === 'draft').state, 'generated');
    r = res(); await studio.handler(req({ method: 'GET', query: { shots: 'gen-dr1', stage: 'draft' } }), r); assert.equal(r.statusCode, 200); assert.equal(r.body.live, 0); assert.equal(r.body.payload.shots.length, 4);
    // re-rendering a scene renders its whole take again (one continuous shot), with the reviewer's changes
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft-shot', pieceId: 'gen-dr1', shot: 2, changes: 'slower push-in' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.shot, 1); assert.deepEqual(r.body.take, [1, 2, 3, 4]);
    assert.equal(hf.runs.length, 2); assert.match(hf.runs[1].body.input, /Changes requested by the reviewer .*slower push-in/); assert.match(hf.runs[1].body.input, /scene_keyframe_urls/);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft-shot', pieceId: 'gen-dr1', shot: 3 } }), r); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'busy');
    const rj = pg.tables.jobs.filter((j) => j.kind === 'hermes_video').at(-1); rj.next_poll_at = new Date(Date.now() - 1000).toISOString();
    r = res(); await jobs.handler(req({ method: 'GET', query: { id: rj.id } }), r); assert.equal(r.body.job.state, 'succeeded');
    const dv2 = pg.tables.artifact_versions.find((v) => v.id === dv.id);
    assert.ok(dv2.payload.shots.every((s) => s.clip.jobId === rj.id && s.clipHistory.length === 1 && s.review === null));
    assert.ok(pg.tables.generation_records.filter((g) => g.kind === 'hermes_video' && g.status === 'succeeded').length >= 2);
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

test('page: the first draft shows one video — its parts render and join by themselves, a failed part is left out, no per-clip approval', async () => {
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    const shots = [1, 2, 3].map((n) => ({ n, durationS: 4, type: 'medium', camera: `cam ${n}`, action: `act ${n}`, product: { visible: n < 3, feature: '' }, onScreenText: { en: n === 1 ? 'Hook' : '', ar: '' }, line: { en: '', ar: '' }, audioCue: 'a', transition: 'cut', keyframe: {}, clip: null, review: null }));
    shots[0].clip = { state: 'rendered', url: 'https://cdn/c1.mp4', assetPath: 'pieces/gen-d/draft/c1.mp4', durationS: 4 }; shots[0].review = { decision: 'approved', by: 'N' };
    shots[1].clip = { state: 'failed', error: 'moderated' };
    const p = { id: 'gen-d', generated: true, studio: true, stage: 5, title: 'T', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'Galaxy Z Flip8', msg: 'm', angle: 'a' }, mood: {}, brief: { objective: 'o', msg: 'k', markets: ['UAE'], platforms: ['tiktok'], mandatories: [] }, board: { shots: shots.map((s) => ({ ...s, keyframe: { state: 'rendered' }, review: { decision: 'approved' } })), totalS: 12, aspect: '9:16' },
      draft: { shots, totalS: 12, aspect: '9:16', resolution: '720p', version: 'v1', boardApproved: true, variants: [{ a: '9:16', l: '720p', k: 'seedance', st: 'rendering' }], dur: '12s', audio: 'x' } };
    X.PROJECTS.unshift(p);
    const html = X.stageArtifact(p, 5);
    // owner 2026-10-29: the first draft is ONE video; its parts render and join by themselves (no per-clip approval)
    assert.match(html, /FIRST DRAFT v1 · 12 s · 720p/); assert.match(html, /Rendering 1\/3 parts…/); assert.match(html, /join into one video by themselves/); assert.match(html, /PART 2 LEFT OUT/);
    assert.match(html, /<video controls playsinline muted data-asset="pieces\/gen-d\/draft\/c1\.mp4"/); assert.match(html, /Render failed — left out of the video\. moderated/);
    assert.match(html, /shotRegenForm\('gen-d',2,'draft'\)/); assert.ok(!/shotDecide\('gen-d',\d,'approved','draft'\)|Approve clip/.test(html), 'no per-clip approval');
    // assembled → the one video leads
    p.draft = { ...p.draft, shots: shots.map((s) => ({ ...s, clip: { state: 'rendered', url: 'https://cdn/c.mp4', assetPath: 'pieces/gen-d/draft/c.mp4' } })), assembled: { assetPath: 'pieces/gen-d/draft/cut.mp4', sha256: 'a'.repeat(64), durationS: 12, width: 720, height: 1280 } };
    const one = X.stageArtifact(p, 5); assert.match(one, /ONE VIDEO · 720×1280/); assert.match(one, /<video controls playsinline data-asset="pieces\/gen-d\/draft\/cut\.mp4"/);
    assert.ok(X.BOARD_POLL['gen-d:draft'], 'pending clips start the draft poll'); clearTimeout(X.BOARD_POLL['gen-d:draft']);
  } finally { X.restore(); }
});

test('POST /api/studio action draft: a FAILED storyboard keyframe does not stop the first draft — that shot is left out and the rest renumber 1..k (boardShot kept); all failed → 409', async () => {
  const pg = fakePostgrest();
  const H = hermesFake(); const hf = H.state;
  const f = mockFetch([
    ...H.routes,
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t${Date.now()}` })],
    [/\/storage\/v1\/object\/assets\//, () => json({ Key: 'ok' })],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-dr1', stage: 'plan', artifact: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'Deadpan Flip', product: 'Galaxy Z Flip8', msg: 'm', platforms: ['tiktok'], markets: ['UAE'] } } }), r);
    const store = require('../../api/_store.js');
    const shots = [shot(1, 2, true, 'close_up'), shot(2, 4, true), shot(3, 5, true, 'wide'), shot(4, 4, false, 'end_card')];
    shots[1].keyframe = { state: 'failed', error: 'the storyboard bot: generator error' }; shots[1].review = null;
    await store.recordVersion('gen-dr1', 'board', { shots, hookShot: 1, totalS: 15, aspect: '9:16', prompt: 'p', note: 'n', rev: 0 }, { producedBy: 'claude', kind: 'text' });
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft', pieceId: 'gen-dr1' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.artifact.shots.map((x) => [x.n, x.boardShot]), [[1, 1], [2, 3], [3, 4]]); assert.deepEqual(r.body.artifact.skippedShots, [2]);
    assert.equal(r.body.artifact.totalS, 11); assert.match(r.body.artifact.note, /shot 2 left out: the keyframe failed/);
    const cj = pg.tables.jobs.filter((j) => j.kind === 'hermes_video');
    // one continuous take through the scenes that are left (owner 2026-11-05)
    assert.deepEqual(cj.map((j) => [j.payload.attachTo.shot, j.payload.imageAssetPath]), [[1, 'pieces/gen-dr1/board/k1.png']]);
    assert.deepEqual(cj[0].payload.sceneKeyframes.map((k) => [k.n, k.assetPath]), [[1, 'pieces/gen-dr1/board/k1.png'], [2, 'pieces/gen-dr1/board/k3.png'], [3, 'pieces/gen-dr1/board/k4.png']]);
    assert.equal(cj[0].payload.duration, 11);
    // every keyframe failed: nothing to animate
    for (const x of shots) x.keyframe = { state: 'failed' };
    await store.recordVersion('gen-dr1', 'board', { shots, hookShot: 1, totalS: 15, aspect: '9:16', prompt: 'p', note: 'n', rev: 1 }, { producedBy: 'claude', kind: 'text' });
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft', pieceId: 'gen-dr1' } }), r);
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'prerequisites'); assert.match(r.body.error, /no usable storyboard keyframe/);
  } finally { f.restore(); studio.restore(); jobs.restore(); pieces.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('page (owner 2026-11-05): a one-take first draft says it renders one continuous take through its scenes, counted by take, not by scene', async () => {
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    const shots = [1, 2, 3].map((n) => ({ n, durationS: 4, type: 'medium', camera: `cam ${n}`, action: `act ${n}`, product: { visible: false }, onScreenText: { en: '', ar: '' }, line: { en: '', ar: '' }, audioCue: '', transition: 'cut', take: 1, keyframe: {}, clip: null, review: null }));
    const p = { id: 'gen-ot', generated: true, studio: true, stage: 5, title: 'T', platforms: ['tiktok'], markets: ['UAE'], th: ['#000000', '#111111'], map: { product: 'Galaxy Z Flip8', msg: 'm', angle: 'a' }, mood: {}, brief: { objective: 'o', msg: 'k', markets: ['UAE'], platforms: ['tiktok'], mandatories: [] }, board: { shots: shots.map((s) => ({ ...s, keyframe: { state: 'rendered' } })), totalS: 12, aspect: '9:16' },
      draft: { shots, totalS: 12, aspect: '9:16', resolution: '720p', version: 'v1', oneTake: true, takes: [{ lead: 1, shots: [1, 2, 3], durationS: 12 }], variants: [{ a: '9:16', l: '720p', k: 'o', st: 'rendering' }], dur: '12s', audio: 'x' } };
    X.PROJECTS.unshift(p);
    const html = X.stageArtifact(p, 5);
    assert.match(html, /ONE CONTINUOUS TAKE/); assert.match(html, /Rendering one continuous take through 3 scenes…/); assert.match(html, /one soundtrack/); assert.ok(!/Rendering 0\/3 parts/.test(html));
    clearTimeout(X.BOARD_POLL['gen-ot:draft']);
  } finally { X.restore(); }
});
