// Phase 6.6 (b) — the assembly and clip-check jobs end to end with the bundled ffmpeg on synthetic clips:
// overlays validated and stored per shot, assembly only over approved clips, the cut stored in the private bucket
// with its sha256 on the draft version, assembled checks as a spec stage_check, clip frames through the vision check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { api, req, res, mockFetch, json } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const A = require('../../api/_studio/assemble.js');

const have = (() => { try { return fs.existsSync(A.ffmpegPath()); } catch { return false; } })();
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', HF_CREDENTIALS: 'id:secret', ANTHROPIC_API_KEY: 'k', CRON_SECRET: 'cron' };
const IMG = (i, morph) => ({ index: i, productPresent: 'yes', productMatchesCatalog: 'yes', competitorOrLogo: 'no', realPerson: 'no', textInImage: 'no', prohibitedImagery: 'no', paletteMatch: 'yes', lightingMatch: 'yes', culturalOk: 'yes', consistentWithMood: 'yes', textSpaceClear: 'n/a', morphing: morph ? 'yes' : 'no', artifacts: 'no', notes: 'ok' });

test('draft-overlays → draft-assemble → the tick assembles approved clips into a stored cut with checks; a clip_check extracts frames and flags morphing', { skip: !have && 'ffmpeg binary not available' }, async () => {
  const dir = A.tmpDir('maistro-flow-');
  const pg = fakePostgrest();
  const files = {};
  const synth = async (name, sec) => { const f = path.join(dir, name); await A.run(['-f', 'lavfi', '-i', `testsrc=duration=${sec}:size=180x320:rate=30`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${sec}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]); return fs.readFileSync(f); };
  files['pieces/gen-as1/draft/c1.mp4'] = await synth('c1.mp4', 4); files['pieces/gen-as1/draft/c2.mp4'] = await synth('c2.mp4', 4);
  const ovPng = path.join(dir, 'ov.png'); await A.run(['-f', 'lavfi', '-i', 'color=c=blue@0.5:s=120x60:d=1,format=rgba', '-frames:v', '1', ovPng]); const ovBytes = fs.readFileSync(ovPng);
  const puts = [];
  let visionBody = null;
  const f = mockFetch([
    ['api.anthropic.com', (u, init) => { visionBody = JSON.parse(init.body); return json({ content: [{ type: 'text', text: JSON.stringify({ images: [IMG(0, false), IMG(1, false), IMG(2, true)] }) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); }],
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t` })],
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'GET', (u) => { const p = decodeURIComponent(String(u).split('/object/sign/assets/')[1].split('?')[0]); const b = files[p]; if (!b) return new Response('missing ' + p, { status: 404 }); return new Response(b, { status: 200, headers: { 'content-type': p.endsWith('.png') ? 'image/png' : 'video/mp4' } }); }],
    [(u, init) => /\/storage\/v1\/object\/assets\//.test(u) && init.method === 'POST', (u, init) => { const p = decodeURIComponent(String(u).split('/object/assets/')[1]); const body = init.body; const buf = Buffer.isBuffer(body) ? body : Buffer.from(body instanceof ArrayBuffer ? new Uint8Array(body) : body); files[p] = buf; puts.push({ p, size: buf.length }); return json({ Key: 'ok' }); }],
    pg.route,
  ]);
  const studio = api('studio.js', ENV); const jobs = api('jobs.js', ENV); const pieces = api('pieces.js', ENV);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-as1', stage: 'plan', artifact: { title: 'Cut', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'Cut', product: 'Galaxy Z Flip8', msg: 'm', platforms: ['tiktok'], markets: ['UAE'] } } }), r);
    const store = require('../../api/_store.js');
    const shot = (n, approved) => ({ n, durationS: 2, type: 'medium', camera: 'c', action: 'a', product: { visible: true, feature: '' }, onScreenText: { en: n === 1 ? 'Hook' : '', ar: '' }, line: { en: '', ar: '' }, audioCue: 'x', transition: n === 1 ? 'dissolve' : 'none', keyframe: { assetPath: `pieces/gen-as1/board/k${n}.png`, jobId: `kj${n}` }, clipDurationS: 4, clip: { state: 'rendered', url: `https://cdn/c${n}.mp4`, assetPath: `pieces/gen-as1/draft/c${n}.mp4`, sha256: 'b'.repeat(64), jobId: `cj${n}` }, review: approved ? { decision: 'approved', by: 'N' } : null });
    const dv = await store.recordVersion('gen-as1', 'draft', { shots: [shot(1, true), shot(2, false)], totalS: 4, aspect: '9:16', resolution: '720p', dur: '4s', audio: 'x', variants: [{ a: '9:16', l: '720p', k: 'seedance', st: 'rendering' }], videoUrl: null, assembled: null, rev: 0 }, { producedBy: 'higgsfield_seedance', kind: 'video' });
    // overlays: PNG signature and size enforced; stored on the shot
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft-overlays', pieceId: 'gen-as1', overlays: [{ shot: 1, data: Buffer.from('notapng').toString('base64') }] } }), r); assert.equal(r.statusCode, 422);
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft-overlays', pieceId: 'gen-as1', overlays: [{ shot: 1, data: ovBytes.toString('base64'), text: { en: 'Hook', ar: '' } }] } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.match(r.body.stored[0].assetPath, /^pieces\/gen-as1\/draft\/overlay-1-/);
    let v = pg.tables.artifact_versions.find((x) => x.id === dv.versionId); assert.equal(v.payload.shots[0].overlay.assetPath, r.body.stored[0].assetPath); assert.equal(v.payload.shots[0].overlay.text.en, 'Hook'); assert.equal(v.payload.rev, 1);
    // owner 2026-10-29: assembly needs no per-clip approval (the approval below is just recorded)
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'shot-decide', stage: 'draft', pieceId: 'gen-as1', shot: 2, decision: 'approved', name: 'N' } }), r); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft-assemble', pieceId: 'gen-as1' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.job.kind, 'assemble'); assert.equal(r.body.job.state, 'queued', 'ffmpeg runs on the tick, not in the request');
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft-assemble', pieceId: 'gen-as1' } }), r); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'busy');
    const aj = pg.tables.jobs.find((j) => j.kind === 'assemble');
    r = res(); await jobs.handler(req({ headers: { authorization: 'Bearer cron' }, session: false }), r);
    assert.equal(r.body.states.succeeded, 1, JSON.stringify(r.body) + ' ' + JSON.stringify(pg.tables.jobs.map((j) => [j.kind, j.state, j.error])));
    const done = pg.tables.jobs.find((j) => j.id === aj.id); assert.equal(done.state, 'succeeded'); assert.equal(done.next_poll_at, null);
    assert.ok(done.result.artifact.assembled.assetPath.startsWith('pieces/gen-as1/draft/cut-')); assert.match(done.result.artifact.assembled.sha256, /^[0-9a-f]{64}$/); assert.equal(done.result.artifact.version, 'v1');
    v = pg.tables.artifact_versions.find((x) => x.id === dv.versionId);
    assert.equal(v.payload.assetPath, done.result.artifact.assembled.assetPath); assert.equal(v.payload.sha256, done.result.artifact.assembled.sha256); assert.equal(v.payload.variants[0].st, 'ready'); assert.equal(v.payload.videoUrl, null);
    assert.equal(v.payload.assembled.width, 720); assert.equal(v.payload.assembled.height, 1280); assert.ok(Math.abs(v.payload.assembled.durationS - 3.75) < 0.35, `dissolve: 2 + 2 − 0.25 = 3.75, got ${v.payload.assembled.durationS}`); assert.deepEqual(v.payload.assembled.overlays, [1]); assert.deepEqual(v.payload.assembled.transitions, ['dissolve', 'none']);
    const stored = puts.find((x) => x.p === v.payload.assetPath); assert.ok(stored && stored.size > 1000, 'the cut was uploaded to the private bucket');
    const spec = pg.tables.stage_checks.find((c) => c.kind === 'spec' && c.artifact_version_id === dv.versionId); assert.ok(spec); assert.ok(spec.results.codeChecks.find((c) => c.code === 'every_shot_in_order').passed); assert.ok(spec.results.codeChecks.find((c) => c.code === 'overlays_present').passed);
    assert.equal(pg.tables.stages.find((s) => s.kind === 'draft').state, 'generated');
    assert.ok(pg.tables.generation_records.some((g) => g.kind === 'assemble' && g.status === 'succeeded'));
    // a clip check: three frames of clip 2 with its keyframe as the anchor; frame 2 morphs → flagged
    files['pieces/gen-as1/board/k2.png'] = ovBytes;
    pg.tables.jobs.push({ id: 'cc-1111-2222-3333-444444444444', piece_id: v.piece_id, stage_id: v.stage_id, kind: 'clip_check', state: 'queued', attempts: 0, created_at: new Date().toISOString(), next_poll_at: new Date(Date.now() - 1000).toISOString(), provider_ref: null, payload: { pieceId: 'gen-as1', stage: 'draft', versionId: dv.versionId, shot: 2, clipAssetPath: 'pieces/gen-as1/draft/c2.mp4', keyframeAssetPath: 'pieces/gen-as1/board/k2.png', product: 'Galaxy Z Flip8', productLook: 'look', rules: [], expectProduct: true } });
    r = res(); await jobs.handler(req({ headers: { authorization: 'Bearer cron' }, session: false }), r);
    const cc = pg.tables.jobs.find((j) => j.kind === 'clip_check'); assert.equal(cc.state, 'succeeded', cc.error);
    const vis = pg.tables.stage_checks.find((c) => c.kind === 'vision' && c.artifact_version_id === dv.versionId);
    assert.ok(vis); assert.equal(vis.results.shot, 2); assert.equal(vis.results.frames.length, 3); assert.equal(vis.passed, false); assert.deepEqual(vis.results.images[2].flags, ['product or person morphs between frames']); assert.equal(vis.prompt_version, 'vision-check-v1.3-2026-10-29');
    assert.equal(visionBody.messages[0].content.filter((c) => c.type === 'image').length, 4, 'keyframe anchor + 3 frames'); assert.match(visionBody.messages[0].content.map((c) => c.text || '').join(' '), /MODE: CLIP/);
    assert.equal(puts.filter((x) => /\/frames-2-\d-/.test(x.p)).length, 3, 'frames stored for the model to read');
  } finally { f.restore(); studio.restore(); jobs.restore(); pieces.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; fs.rmSync(dir, { recursive: true, force: true }); }
});
