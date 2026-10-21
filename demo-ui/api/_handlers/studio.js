// /api/studio — the rebuilt Content Studio stages (Phase 6.2+). Each action
// consumes only approved or current outputs of earlier stages through the
// store, writes through the job service, and never talks to a provider in
// the request beyond one bounded submit.
//
//   POST { action: 'mood', pieceId, userInput?, piece? }  (session)
//     → Claude visual direction (structured) → one Soul job rendering the
//       four-tile set (batch) with the direction on the job; completion
//       records the version and queues the vision check.
//     → 200 { ok, direction, job }  · 409 from the store/domain · 502 model
//   POST { action: 'thumb', pieceId, userInput?, refImage?, headline?, headlineAr?, piece? }
//     → prompt anchored to the approved moodboard + the product photo (v1
//       reference path) → one Soul job at the platform's aspect; the vision
//       check compares against the selected mood tiles; the headline is an
//       overlay drawn by the page, never inside the image.
//   POST { action: 'thumb-composite', pieceId, data (base64 PNG), overlay }
//     → stores the composited cover (image + overlay) as a new manual version
//   POST { action: 'brief', pieceId, userInput?, piece? }  (6.4)
//     → Claude writes the structured brief from the approved moodboard,
//       thumbnail, trend profile, catalog, market and platform rules; code
//       checks (claims, duration, hashtags, audio licensing, Arabic,
//       mandatories, deadline) + one model copy check → stage_checks (copy)
//   POST { action: 'brief-edit', pieceId, spec, piece? }
//     → a human's field edits stored as a NEW manual version, re-checked
//   POST { action: 'board', pieceId, userInput?, refImage?, piece? }  (6.5)
//     → shot list from the approved brief (code checks + mechanic check → stage_checks spec),
//       one Soul keyframe job per shot attached to the version (vision check per keyframe,
//       F1X8 on the hook shot)
//   POST { action: 'board-shot', pieceId, shot, changes?, refImage? } → re-render ONE shot
//   POST { action: 'board-shot-decide', pieceId, shot, decision, reason?, reasonCode?, name? }
//   GET  ?board=<pieceId> → the storyboard version with its shots, live job count, hook score
//   GET  ?checks=<pieceId>&stage=<kind>  (session) → the stored checks for the
//       stage's current version
const { requireSession, refreshMember } = require('../_auth.js');
const { createJob, StoreError } = (() => { const j = require('../_jobs.js'); const s = require('../_store.js'); return { createJob: j.createJob, StoreError: s.StoreError }; })();
const { ensurePiece } = require('../_store.js');
const { visualDirection, setPrompt, TILES } = require('../_studio/mood.js');
const thumb = require('../_studio/thumb.js');
const briefMod = require('../_studio/brief.js');
const boardMod = require('../_studio/board.js');
const jobsSvc = require('../_jobs.js');
const storage = require('../_adapters/storage.js');
const { recordVersion } = require('../_store.js');
const { activeDocuments, getDocument } = require('../_kb/index.js');
const { queryRows, insertRows } = require('../_supabase.js');

const ASSET_RE = (legacyId) => new RegExp(`^pieces/${legacyId.replace(/[^a-zA-Z0-9_-]/g, '')}/(mood|thumb|board|draft|final)/[a-z0-9-]+\\.(png|jpg|webp)$`);

/** Store the brief's checks (code + copy) on the version; returns the row shape the page reads. */
async function recordBriefChecks({ piece, legacyId, versionId, brief, ctx, member }) {
  const checks = briefMod.codeChecks(brief, ctx);
  const cc = await briefMod.copyCheck({ brief, ctx, legacyId, memberId: member ? member.id : null });
  const copy = cc.copy || null;
  const flags = [...checks.filter((c) => !c.passed).map((c) => `${c.code}: ${c.detail}`), ...briefMod.copyFlags(copy)];
  const passed = checks.every((c) => c.passed) && Boolean(copy) && copy.arabicFluency !== 'literal' && copy.consistentWithMood !== 'no' && copy.followsTrendMechanic !== 'no';
  const [stage] = await queryRows('stages', `select=id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.brief&limit=1`);
  const results = { codeChecks: checks, copy, copyError: cc.error || null, flags, passed, version: briefMod.VERSION };
  if (stage) await insertRows('stage_checks', [{ piece_id: piece.id, stage_id: stage.id, artifact_version_id: versionId, kind: 'copy', passed, results, model: cc.model || null, prompt_version: briefMod.CHECK_VERSION }]);
  return results;
}

async function kbBits(product) {
  const docs = await activeDocuments();
  const cat = docs.find((d) => d.kind === 'product_catalog' && d.key.toLowerCase() === String(product || '').toLowerCase());
  const colors = (docs.find((d) => d.kind === 'brand_kb' && d.key === 'colors') || {}).content;
  const market = (docs.find((d) => d.kind === 'market_context' && d.key === 'gcc') || {}).content;
  return { productLook: cat ? cat.content.look : null, palette: colors && colors.palette ? colors.palette : {}, rules: market && market.culturalRules ? market.culturalRules : [] };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }
  if (!requireSession(req, res)) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'storage is not configured' });
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.board) {
        const [piece] = await queryRows('content_pieces', `select=id&legacy_id=eq.${encodeURIComponent(String(q.board))}&limit=1`);
        if (!piece) return res.status(404).json({ error: 'piece not found' });
        const [stage] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.board&limit=1`);
        if (!stage || !stage.current_version_id) return res.status(404).json({ error: 'no storyboard yet' });
        const [v] = await queryRows('artifact_versions', `select=id,version,payload,produced_by&id=eq.${encodeURIComponent(stage.current_version_id)}&limit=1`);
        const live = await queryRows('jobs', `select=id,kind,state&stage_id=eq.${encodeURIComponent(stage.id)}&state=in.(queued,running)&limit=20`);
        const hook = await queryRows('qc_results', `select=score,result,heatmap_path,at&artifact_version_id=eq.${encodeURIComponent(stage.current_version_id)}&order=at.desc&limit=1`).catch(() => []);
        return res.status(200).json({ version: v ? v.version : null, versionId: stage.current_version_id, state: stage.state, payload: v ? v.payload : null, live: live.filter((j) => j.kind !== 'vision_check').length, checksPending: live.filter((j) => j.kind === 'vision_check').length, hook: hook[0] ? { score: hook[0].score, summary: hook[0].result && hook[0].result.verdict ? hook[0].result.verdict.summary : null, risks: hook[0].result && hook[0].result.verdict ? (hook[0].result.verdict.risks || []).slice(0, 3) : [], heatmapPath: hook[0].heatmap_path || null, at: hook[0].at } : null });
      }
      if (!q.checks) return res.status(400).json({ error: 'checks=<pieceId> or board=<pieceId> is required' });
      const [piece] = await queryRows('content_pieces', `select=id&legacy_id=eq.${encodeURIComponent(String(q.checks))}&limit=1`);
      if (!piece) return res.status(404).json({ error: 'piece not found' });
      const stages = await queryRows('stages', `select=id,kind,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}${q.stage ? `&kind=eq.${encodeURIComponent(String(q.stage))}` : ''}`);
      const vids = stages.map((s) => s.current_version_id).filter(Boolean);
      const checks = vids.length ? await queryRows('stage_checks', `select=*&artifact_version_id=in.(${vids.map(encodeURIComponent).join(',')})&order=at.desc&limit=50`) : [];
      return res.status(200).json({ count: checks.length, checks: checks.map((c) => ({ ...c, stage: (stages.find((s) => s.current_version_id === c.artifact_version_id) || {}).kind })) });
    }
    if (!(await refreshMember(req, res))) return;
    const b = req.body || {};
    if (!['mood', 'thumb', 'thumb-composite', 'brief', 'brief-edit', 'board', 'board-shot', 'board-shot-decide'].includes(b.action)) return res.status(400).json({ error: 'action must be one of mood, thumb, thumb-composite, brief, brief-edit, board, board-shot, board-shot-decide' });
    const legacyId = String(b.pieceId || '');
    if (b.action === 'thumb-composite') {
      const data = String(b.data || '');
      if (!data) return res.status(422).json({ error: 'data (base64 PNG) is required' });
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || bytes.length > 3 * 1024 * 1024) return res.status(413).json({ error: 'composite must be under 3 MB' });
      const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (bytes.length < 8 || !PNG_SIG.every((v, i) => bytes[i] === v)) return res.status(422).json({ error: 'data must be a PNG' });
      const ov = b.overlay && typeof b.overlay === 'object' ? b.overlay : {};
      const overlay = { headline: String(ov.headline || '').slice(0, 120), headlineAr: String(ov.headlineAr || '').slice(0, 120), side: ov.side === 'right' ? 'right' : 'left', aspect: ['9:16', '16:9', '1:1'].includes(ov.aspect) ? ov.aspect : '16:9', font: String(ov.font || 'system-ui').slice(0, 60), box: ov.box && typeof ov.box === 'object' ? ov.box : null, baseAssetPath: typeof ov.baseAssetPath === 'string' && ASSET_RE(legacyId).test(ov.baseAssetPath) ? ov.baseAssetPath : null };
      if (typeof ov.baseAssetPath === 'string' && ov.baseAssetPath && !overlay.baseAssetPath) return res.status(422).json({ error: 'baseAssetPath must be one of this piece\'s stored assets' });
      if (!overlay.headline && !overlay.headlineAr) return res.status(422).json({ error: 'an overlay needs a headline' });
      const put = await storage.putBlob(`pieces/${legacyId}/thumb/composite-${Date.now().toString(36)}.png`, bytes, 'image/png');
      const out = await recordVersion(legacyId, 'thumb', { imageUrl: null, assetPath: put.path, sha256: put.sha256, size: put.size, overlay, title: overlay.headline || overlay.headlineAr, sub: '', composite: true, baseAssetPath: overlay.baseAssetPath, note: 'Headline overlaid in code (not generated inside the image)' }, { piece: b.piece || {}, producedBy: 'manual', kind: 'image', generatedBy: req.member ? req.member.id : null });
      try { const { syncSpec } = require('../_spec.js'); await syncSpec(legacyId, { memberId: req.member ? req.member.id : null, note: 'thumb composite' }); } catch (e) { /* best effort */ }
      return res.status(200).json({ ok: true, ...out, assetPath: put.path });
    }
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured' });
    const { piece } = await ensurePiece(legacyId, b.piece || {});
    const meta = { id: legacyId, title: piece.title, product: piece.product, msg: piece.key_message, angle: piece.angle, markets: piece.markets, platforms: piece.platforms };
    const bits = await kbBits(piece.product);
    if (b.action === 'board-shot-decide') {
      const n = Number(b.shot);
      const decision = b.decision === 'approved' || b.decision === 'rejected' ? b.decision : null;
      if (!decision || !Number.isInteger(n)) return res.status(400).json({ error: 'shot and decision (approved|rejected) are required' });
      if (decision === 'rejected' && !String(b.reason || '').trim()) return res.status(400).json({ error: 'a written reason is required to reject a shot' });
      const [stage] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.board&limit=1`);
      if (!stage || !stage.current_version_id) return res.status(409).json({ error: 'no storyboard version', code: 'no_version' });
      if (stage.state === 'approved') return res.status(409).json({ error: 'the storyboard is approved; reopen it first', code: 'approved_immutable' });
      const [v] = await queryRows('artifact_versions', `select=id,payload&id=eq.${encodeURIComponent(stage.current_version_id)}&limit=1`);
      if (!v || !Array.isArray(v.payload.shots) || !v.payload.shots[n - 1]) return res.status(404).json({ error: `shot ${n} not found` });
      const shots = v.payload.shots.map((s) => ({ ...s }));
      if (decision === 'approved' && !(shots[n - 1].keyframe && shots[n - 1].keyframe.state === 'rendered')) return res.status(409).json({ error: `shot ${n} has no rendered keyframe to approve`, code: 'no_keyframe' });
      shots[n - 1].review = { decision, reason: String(b.reason || '').slice(0, 2000) || null, reasonCode: b.reasonCode ? String(b.reasonCode).slice(0, 60) : null, by: req.member ? req.member.name || req.member.email : String(b.name || '').slice(0, 120) || null, at: new Date().toISOString(), keyframeJobId: shots[n - 1].keyframe ? shots[n - 1].keyframe.jobId || null : null };
      const { patchRows } = require('../_supabase.js');
      await patchRows('artifact_versions', `id=eq.${encodeURIComponent(v.id)}`, { payload: { ...v.payload, shots } });
      try { await insertRows('audit_log', [{ actor: req.member ? req.member.id : null, action: `board.shot.${decision}`, target: v.id, details: { pieceId: legacyId, shot: n, reasonCode: shots[n - 1].review.reasonCode, reason: shots[n - 1].review.reason } }]); } catch (e) { /* best effort */ }
      return res.status(200).json({ ok: true, shot: n, review: shots[n - 1].review, pending: shots.filter((s) => !s.review || s.review.decision !== 'approved').map((s) => s.n) });
    }
    if (b.action === 'board-shot') {
      const n = Number(b.shot);
      const [stage] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.board&limit=1`);
      if (!stage || !stage.current_version_id) return res.status(409).json({ error: 'no storyboard version', code: 'no_version' });
      if (stage.state === 'approved') return res.status(409).json({ error: 'the storyboard is approved; reopen it first', code: 'approved_immutable' });
      const [v] = await queryRows('artifact_versions', `select=id,payload&id=eq.${encodeURIComponent(stage.current_version_id)}&limit=1`);
      if (!v || !Array.isArray(v.payload.shots) || !v.payload.shots[n - 1]) return res.status(404).json({ error: `shot ${n} not found` });
      const liveRows = await queryRows('jobs', `select=id,kind,payload&stage_id=eq.${encodeURIComponent(stage.id)}&state=in.(queued,running)&limit=50`);
      if (liveRows.some((j) => j.kind === 'higgsfield_image' && j.payload && j.payload.attachTo && Number(j.payload.attachTo.shot) === n)) return res.status(409).json({ error: `shot ${n} is already rendering`, code: 'busy' });
      const mood = await thumb.moodContext(piece.id);
      const refImage = typeof b.refImage === 'string' && /^https:\/\//.test(b.refImage) ? b.refImage : null;
      const shot = v.payload.shots[n - 1];
      const useRef = Boolean(refImage && shot.product.visible);
      const changes = String(b.changes || '').trim();
      const prompt = `${boardMod.keyframePrompt(shot, mood.direction, bits.productLook, useRef)}${changes ? ` Changes requested by the reviewer (apply only these, keep everything else): ${changes}.` : ''}`;
      const anchors = mood.tiles.filter((t) => t.assetPath || t.url).slice(0, 4).map((t) => ({ index: t.index, url: t.url || null, assetPath: t.assetPath || null }));
      const [job] = await insertRows('jobs', [{ piece_id: piece.id, stage_id: stage.id, kind: 'higgsfield_image', state: 'queued', attempts: 0, next_poll_at: new Date().toISOString(), payload: { pieceId: legacyId, stage: 'board', prompt, aspect_ratio: v.payload.aspect || '9:16', resolution: '1080p', ...(useRef ? { ref: refImage } : {}), autoCheck: true, attachTo: { versionId: v.id, shot: n }, generatedBy: req.member ? req.member.id : null, meta: { shot: n, prompt, changes: changes || null, anchors, direction: mood.direction || null, product: piece.product, productLook: bits.productLook, rules: bits.rules, expectProduct: shot.product.visible, hookCheck: n === v.payload.hookShot, title: piece.title } } }], { returning: true });
      const { patchRows } = require('../_supabase.js');
      if (stage.state !== 'generating') await patchRows('stages', `id=eq.${encodeURIComponent(stage.id)}`, { state: 'generating' });
      await jobsSvc.advance(job).catch(() => null);
      const fresh = await jobsSvc.getJob(job.id);
      return res.status(200).json({ ok: true, shot: n, job: jobsSvc.publicJob(fresh || job, legacyId) });
    }
    if (b.action === 'board') {
      const brief = await boardMod.briefFor(piece.id);
      if (!brief) return res.status(409).json({ error: 'the storyboard needs the brief first — the shot list is written from the approved brief', code: 'prerequisites' });
      const bctx = await briefMod.briefContext(piece, legacyId);
      if (!bctx.mood.direction && !bctx.mood.tiles.length && !bctx.mood.note) return res.status(409).json({ error: 'the storyboard needs the moodboard first', code: 'prerequisites' });
      const w = await boardMod.shotList({ piece, brief, mood: bctx.mood, trend: bctx.trend, judgement: bctx.judgement, productLook: bits.productLook, rules: bits.rules, userInput: b.userInput, memberId: req.member ? req.member.id : null, legacyId });
      if (!w.list) return res.status(502).json({ error: w.error, problems: w.problems || [] });
      const aspect = thumb.aspectFor(piece.platforms);
      const artifact = boardMod.artifactFrom(w.list, { promptVersion: w.promptVersion, briefVersionId: brief.versionId, briefApproved: brief.approved, moodApproved: bctx.mood.approved, aspect });
      const out = await recordVersion(legacyId, 'board', artifact, { piece: b.piece || {}, producedBy: 'claude', kind: 'text', generatedBy: req.member ? req.member.id : null });
      // checks on the shot list: arithmetic and coverage in code, mechanic and hook by the model
      let checks = null;
      try {
        const code = boardMod.codeChecks(w.list, brief.payload);
        const mc = await boardMod.mechanicCheck({ list: w.list, brief, trend: bctx.trend, judgement: bctx.judgement, legacyId, memberId: req.member ? req.member.id : null });
        const flags = [...code.filter((c) => !c.passed).map((c) => `${c.code}: ${c.detail}`), ...boardMod.checkFlags(mc.check || null)];
        const passed = code.every((c) => c.passed) && Boolean(mc.check) && mc.check.followsTrendMechanic !== 'no' && mc.check.hookStrength !== 'weak';
        const [stage] = await queryRows('stages', `select=id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.board&limit=1`);
        checks = { codeChecks: code, mechanic: mc.check || null, mechanicError: mc.error || null, flags, passed, version: boardMod.VERSION };
        if (stage) await insertRows('stage_checks', [{ piece_id: piece.id, stage_id: stage.id, artifact_version_id: out.versionId, kind: 'spec', passed, results: checks, model: mc.model || null, prompt_version: boardMod.CHECK_VERSION }]);
      } catch (e) { checks = { error: String(e.message || e).slice(0, 200) }; }
      // one keyframe per shot through the job service
      const refImage = typeof b.refImage === 'string' && /^https:\/\//.test(b.refImage) ? b.refImage : null;
      const anchors = bctx.mood.tiles.filter((t) => t.assetPath || t.url).slice(0, 4).map((t) => ({ index: t.index, url: t.url || null, assetPath: t.assetPath || null }));
      const [stageRow] = await queryRows('stages', `select=id,state&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.board&limit=1`);
      const rows = w.list.shots.map((shot) => {
        const useRef = Boolean(refImage && shot.product.visible);
        const prompt = boardMod.keyframePrompt(shot, bctx.mood.direction, bits.productLook, useRef);
        return { piece_id: piece.id, stage_id: stageRow.id, kind: 'higgsfield_image', state: 'queued', attempts: 0, next_poll_at: new Date().toISOString(), payload: { pieceId: legacyId, stage: 'board', prompt, aspect_ratio: aspect, resolution: '1080p', ...(useRef ? { ref: refImage } : {}), autoCheck: true, attachTo: { versionId: out.versionId, shot: shot.n }, generatedBy: req.member ? req.member.id : null, meta: { shot: shot.n, prompt, anchors, direction: bctx.mood.direction || null, product: piece.product, productLook: bits.productLook, rules: bits.rules, expectProduct: shot.product.visible, hookCheck: shot.n === w.list.hookShot, title: piece.title } } };
      });
      const inserted = await insertRows('jobs', rows, { returning: true });
      const { patchRows } = require('../_supabase.js');
      await patchRows('stages', `id=eq.${encodeURIComponent(stageRow.id)}`, { state: 'generating' });
      const jobs = [];
      for (const j of inserted) { await jobsSvc.advance(j).catch(() => null); const fresh = await jobsSvc.getJob(j.id); jobs.push(jobsSvc.publicJob(fresh || j, legacyId)); }
      try { const { syncSpec } = require('../_spec.js'); await syncSpec(legacyId, { memberId: req.member ? req.member.id : null, note: 'storyboard written' }); } catch (e) { /* best effort */ }
      return res.status(200).json({ ok: true, artifact, version: out.version, versionId: out.versionId, checks, jobs, briefApproved: brief.approved, moodApproved: bctx.mood.approved });
    }
    if (b.action === 'brief' || b.action === 'brief-edit') {
      const ctx = await briefMod.briefContext(piece, legacyId);
      if (!ctx.mood.direction && !ctx.mood.tiles.length && !ctx.mood.note) return res.status(409).json({ error: 'the brief needs the moodboard first — the brief is written from its approved direction', code: 'prerequisites' });
      let brief, meta;
      if (b.action === 'brief-edit') {
        const problems = briefMod.validateShape(b.spec);
        if (problems.length) return res.status(422).json({ error: 'edited brief is incomplete', problems });
        brief = b.spec; meta = { promptVersion: b.briefVersion || briefMod.VERSION, moodApproved: ctx.mood.approved, thumbApproved: Boolean(ctx.thumb && ctx.thumb.approved), editedBy: req.member ? req.member.id : 'password-session' };
      } else {
        const w = await briefMod.writeBrief({ piece, ctx, userInput: b.userInput, memberId: req.member ? req.member.id : null, legacyId });
        if (!w.brief) return res.status(502).json({ error: w.error, problems: w.problems || [] });
        brief = w.brief; meta = { promptVersion: w.promptVersion, moodApproved: ctx.mood.approved, thumbApproved: Boolean(ctx.thumb && ctx.thumb.approved) };
      }
      const artifact = briefMod.artifactFrom(brief, piece, meta);
      const out = await recordVersion(legacyId, 'brief', artifact, { piece: b.piece || {}, producedBy: b.action === 'brief-edit' ? 'manual' : 'claude', kind: 'text', generatedBy: req.member ? req.member.id : null });
      let checks = null;
      try { checks = await recordBriefChecks({ piece, legacyId, versionId: out.versionId, brief, ctx, member: req.member }); } catch (e) { checks = { error: String(e.message || e).slice(0, 200) }; }
      try { const { syncSpec } = require('../_spec.js'); await syncSpec(legacyId, { memberId: req.member ? req.member.id : null, note: `brief ${b.action === 'brief-edit' ? 'edited' : 'written'}` }); } catch (e) { /* best effort */ }
      return res.status(200).json({ ok: true, artifact, version: out.version, versionId: out.versionId, checks, moodApproved: ctx.mood.approved, approvedClaims: ctx.approvedClaims.length });
    }
    if (b.action === 'thumb') {
      const mood = await thumb.moodContext(piece.id);
      if (!mood.direction && !mood.tiles.length) return res.status(409).json({ error: 'the thumbnail needs a moodboard first — generate and approve the moodboard', code: 'prerequisites' });
      const aspect = thumb.aspectFor(piece.platforms);
      const refImage = typeof b.refImage === 'string' && /^https:\/\//.test(b.refImage) ? b.refImage : null;
      const tp = await thumb.thumbPrompt({ piece: meta, mood, productLook: bits.productLook, rules: bits.rules, userInput: b.userInput, refAttached: Boolean(refImage), aspect, memberId: req.member ? req.member.id : null });
      if (!tp.prompt) return res.status(502).json({ error: tp.error, problems: tp.problems || [] });
      const overlay = { headline: String(b.headline || '').slice(0, 120), headlineAr: String(b.headlineAr || '').slice(0, 120), side: tp.textSide, box: thumb.overlayBox(aspect, tp.textSide), aspect };
      const anchors = mood.tiles.filter((t) => t.assetPath || t.url).slice(0, 4).map((t) => ({ index: t.index, url: t.url || null, assetPath: t.assetPath || null }));
      const job = await createJob({ legacyId, stage: 'thumb', kind: 'higgsfield_image', payload: { prompt: tp.prompt, aspect_ratio: aspect, resolution: '1080p', ...(refImage ? { ref: refImage } : {}), autoCheck: true, meta: { prompt: tp.prompt, note: tp.note, title: piece.title, sub: piece.key_message || '', textSide: tp.textSide, overlay, promptVersion: tp.promptVersion, product: piece.product, productLook: bits.productLook, rules: bits.rules, anchors, moodApproved: mood.approved } }, piece: b.piece || {}, member: req.member });
      return res.status(200).json({ ok: true, prompt: tp.prompt, textSide: tp.textSide, note: tp.note, aspect, overlay, moodApproved: mood.approved, anchors: anchors.length, job });
    }
    const trend = piece.trend_name ? { name: piece.trend_name, id: piece.trend_id } : null;
    const dir = await visualDirection({ piece: meta, trend, userInput: b.userInput, productLook: bits.productLook, rules: bits.rules, palette: bits.palette, memberId: req.member ? req.member.id : null });
    if (!dir.direction) return res.status(502).json({ error: dir.error, problems: dir.problems || [] });
    const d = dir.direction;
    // Soul v2 renders ONE prompt as a batch of four, so the set is four
    // VARIATIONS of the whole direction (not one image per tile brief); the
    // tile briefs stay on the direction as text. The product is expected in
    // every variation exactly when the catalog has a look line for it.
    const prompt = setPrompt(d, bits.productLook);
    const job = await createJob({ legacyId, stage: 'mood', kind: 'higgsfield_image', payload: { prompt, aspect_ratio: '4:3', resolution: '1080p', batch: TILES, autoCheck: true, meta: { prompt, note: `${d.leadingPrinciple} · ${d.mood}`, direction: d, directionVersion: dir.promptVersion, setMode: 'variations', expectProduct: Boolean(bits.productLook), product: piece.product, productLook: bits.productLook, rules: bits.rules } }, piece: b.piece || {}, member: req.member });
    return res.status(200).json({ ok: true, direction: d, promptVersion: dir.promptVersion, job });
  } catch (e) {
    if (e instanceof StoreError) return res.status(e.status).json({ error: e.message, code: e.code });
    return res.status(e && e.status ? e.status : 502).json({ error: String((e && e.message) || e) });
  }
};
