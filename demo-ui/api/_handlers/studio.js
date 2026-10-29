// /api/studio — the rebuilt Content Studio stages (Phase 6.2+). Each action
// consumes only approved or current outputs of earlier stages through the
// store, writes through the job service, and never talks to a provider in
// the request beyond one bounded submit.
//
//   POST { action: 'mood', pieceId, userInput?, piece? }  (session)
//     → Claude visual direction (structured) → one Hermes moodboard-bot job
//       making the four-variation set with the direction on the job; completion
//       records the version and queues the vision check.
//     → 200 { ok, direction, job }  · 409 from the store/domain · 502 model
//   POST { action: 'thumb', pieceId, userInput?, refImage?, headline?, headlineAr?, piece? }
//     → prompt anchored to the approved moodboard + the product photo (v1
//       reference photo) → one Hermes thumbnail-bot job at the platform's aspect; the vision
//       check compares against the selected mood tiles; the headline is an
//       overlay drawn by the page, never inside the image.
//   POST { action: 'thumb-composite', pieceId, data (base64 PNG), overlay }
//     → stores the composited cover (image + overlay) as a new manual version
//   POST { action: 'brief', pieceId, userInput?, piece? }  (6.4)
//     → the Hermes brief bot writes the structured brief (a hermes_brief job) from the approved
//       moodboard, thumbnail, trend profile, catalog, market and platform rules; code
//       checks (claims, duration, hashtags, audio licensing, Arabic,
//       mandatories, deadline) + one model copy check → stage_checks (copy)
//   POST { action: 'brief-edit', pieceId, spec, piece? }
//     → a human's field edits stored as a NEW manual version, re-checked
//   POST { action: 'board', pieceId, userInput?, refImage?, piece? }  (6.5)
//     → shot list from the approved brief (code checks + mechanic check → stage_checks spec),
//       one Hermes storyboard-bot keyframe job per shot attached to the version (vision check per keyframe,
//       F1X8 on the hook shot)
//   POST { action: 'board-shot', pieceId, shot, changes?, refImage? } → re-render ONE shot
//   POST { action: 'board-shot-decide', pieceId, shot, decision, reason?, reasonCode?, name? }
//   GET  ?board=<pieceId> → the storyboard version with its shots, live job count, hook score
//   POST { action: 'draft', pieceId, resolution?, piece? }  (6.6)
//     → a first-draft version with one Hermes video-bot image-to-video job per APPROVED
//       storyboard shot (keyframe → clip, attached to the shot slot)
//   POST { action: 'draft-shot', pieceId, shot, changes? } → re-render ONE clip
//   POST { action: 'shot-decide', stage: 'board'|'draft', pieceId, shot, decision, reason?, reasonCode? }
//   GET  ?shots=<pieceId>&stage=board|draft → that stage's version with its shots
//   POST { action: 'draft-overlays', pieceId, overlays: [{ shot, data (base64 PNG), text? }] } → stored per shot
//   POST { action: 'draft-assemble', pieceId } → an `assemble` job over the approved clips (ffmpeg on the tick)
//   GET  ?checks=<pieceId>&stage=<kind>  (session) → the stored checks for the
//       stage's current version
const { requireSession, refreshMember, memberOnly, claimActor, PASSWORD_CLAIM } = require('../_auth.js');
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

// a recorded seed per keyframe (1–1,000,000, passed through to the bot) so a shot can be re-rendered reproducibly (6.9)
const newSeed = () => 1 + Math.floor(Math.random() * 1000000);
const ASSET_RE = (legacyId) => new RegExp(`^pieces/${legacyId.replace(/[^a-zA-Z0-9_-]/g, '')}/(mood|thumb|board|draft|final)/[a-z0-9-]+\\.(png|jpg|webp)$`);

/** Store the brief's checks (code + copy) on the version; returns the row shape the page reads. */
const recordBriefChecks = ({ piece, legacyId, versionId, brief, ctx, member }) => briefMod.recordChecks({ piece, legacyId, versionId, brief, ctx, memberId: member ? member.id : null });

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
      if (q.lineage) {
        // 6.9: trace the final (or the latest cut) back to the trend, through every version, shot and generation record
        const [piece] = await queryRows('content_pieces', `select=*&legacy_id=eq.${encodeURIComponent(String(q.lineage))}&limit=1`);
        if (!piece) return res.status(404).json({ error: 'piece not found' });
        const stages = await queryRows('stages', `select=id,kind,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}`);
        const vids = stages.map((x) => x.current_version_id).filter(Boolean);
        const versions = vids.length ? await queryRows('artifact_versions', `select=id,stage_id,version,kind,produced_by,created_at,job_id,inputs,payload&id=in.(${vids.map(encodeURIComponent).join(',')})`) : [];
        const V = (k) => { const st = stages.find((x) => x.kind === k); return st && st.current_version_id ? versions.find((v) => v.id === st.current_version_id) || null : null; };
        const recs = await queryRows('generation_records', `select=id,at,stage,kind,model,prompt_name,prompt_version,params,seed,status,cost_usd,job_id&piece_id=eq.${encodeURIComponent(piece.id)}&order=at.desc&limit=500`);
        const byJob = new Map(); for (const r0 of recs) if (r0.job_id && !byJob.has(r0.job_id)) byJob.set(r0.job_id, r0);
        const recOf = (jobId) => { const r0 = jobId ? byJob.get(jobId) : null; return r0 ? { kind: r0.kind, model: r0.model, promptName: r0.prompt_name, promptVersion: r0.prompt_version, seed: r0.seed != null ? Number(r0.seed) : (r0.params && r0.params.seed) || null, status: r0.status, costUsd: r0.cost_usd != null ? Number(r0.cost_usd) : null, at: r0.at } : null; };
        const latestClaude = (stage, name) => { const r0 = recs.find((x) => x.stage === stage && x.kind === 'claude' && x.status === 'succeeded' && (!name || x.prompt_name === name)); return r0 ? { model: r0.model, promptName: r0.prompt_name, promptVersion: r0.prompt_version, at: r0.at } : null; };
        const stageView = (k) => { const v = V(k); return v ? { versionId: v.id, version: v.version, producedBy: v.produced_by, state: (stages.find((x) => x.kind === k) || {}).state, inputs: v.inputs || null, at: v.created_at } : null; };
        const finV = V('final'); const fin = finV || V('draft');
        const board = V('board'), brief = V('brief'), mood = V('mood');
        const shots = fin && Array.isArray(fin.payload.shots) ? fin.payload.shots.map((s0) => {
          const b0 = board && Array.isArray(board.payload.shots) ? board.payload.shots.find((x) => x.n === s0.n) : null;
          const kf = s0.keyframe || (b0 && b0.keyframe) || null;
          return {
            n: s0.n,
            clip: s0.clip ? { assetPath: s0.clip.assetPath || null, sha256: s0.clip.sha256 || null, override: Boolean(s0.clip.override), fromKeyframe: s0.clip.fromKeyframe || null, generation: recOf(s0.clip.jobId) } : null,
            keyframe: kf ? { assetPath: kf.assetPath || null, override: Boolean(kf.override), generation: recOf(kf.jobId) } : null,
            storyboardLine: b0 ? { type: b0.type, camera: b0.camera, action: b0.action, onScreenText: b0.onScreenText, line: b0.line, feature: b0.product ? b0.product.feature : null } : null,
            review: s0.review ? { decision: s0.review.decision, by: s0.review.by, at: s0.review.at } : null,
          };
        }) : [];
        return res.status(200).json({
          piece: { legacyId: piece.legacy_id, title: piece.title, trend: { id: piece.trend_id, name: piece.trend_name }, angle: piece.angle, product: piece.product, origin: piece.origin },
          cut: fin ? { stage: finV ? 'final' : 'draft', versionId: fin.id, version: fin.version, assetPath: (fin.payload.assembled || {}).assetPath || null, sha256: (fin.payload.assembled || {}).sha256 || null, fromDraftVersionId: fin.payload.fromDraftVersionId || null, fromQcVersionId: fin.payload.fromQcVersionId || null } : null,
          shots,
          brief: brief ? { ...stageView('brief'), keyMessage: brief.payload.spec ? brief.payload.spec.keyMessage : brief.payload.msg || null, cta: brief.payload.spec ? brief.payload.spec.cta : null, generation: latestClaude('brief', 'studio.brief') } : null,
          storyboard: board ? { ...stageView('board'), generation: latestClaude('board', 'studio.storyboard') } : null,
          moodboard: mood ? { ...stageView('mood'), directionVersion: mood.payload.directionVersion || null, setMode: mood.payload.setMode || null, generation: latestClaude('mood', 'studio.mood.direction') } : null,
          stages: Object.fromEntries(['plan', 'mood', 'thumb', 'brief', 'board', 'draft', 'qc', 'final'].map((k) => [k, stageView(k)])),
        });
      }
      if (q.ops) {
        // Phase 10: generation latency and success per kind, F1X8 latency, stage turnaround, cost per approved piece
        const O = require('../_perf/ops.js');
        const days = Math.min(90, Math.max(1, parseInt(q.days, 10) || 30));
        return res.status(200).json(O.ops({ ...(await O.load(queryRows, days)), days }));
      }
      if (q.calendar) {
        // 8b: planned posts and approved finals waiting for a slot (manual/export mode until Sprinklr)
        const out = await require('../_studio/publishing.js').calendar({ from: q.from ? String(q.from) : null, to: q.to ? String(q.to) : null });
        return res.status(out.status).json(out.body);
      }
      if (q.sprinklr === 'feed') {
        // the Calendar's read-only view of the owned accounts in Sprinklr: posted, scheduled, in approval, drafts
        const out = await require('../_studio/publishing.js').sprinklrFeed({ from: q.from ? String(q.from) : null, to: q.to ? String(q.to) : null });
        return res.status(out.status).json(out.body);
      }
      if (q.sprinklr === 'campaigns') {
        // read-only: the campaigns the owned accounts' posts were filed under, for choosing SPRINKLR_CAMPAIGN_ID
        try { return res.status(200).json(await require('../_studio/sprinklr/feed.js').campaigns({ days: Math.min(365, Math.max(7, Number(q.days) || 90)) })); }
        catch (e) { return res.status(e.status || 502).json({ error: String(e.message || e), code: e.code || null }); }
      }
      if (q.sprinklr === 'check') {
        // ADR-008: read-only credential check (GET /me), admin only
        if (!memberOnly(req, res, ['admin'])) return;
        const out = await require('../_studio/publishing.js').sprinklrCheck();
        return res.status(out.status).json(out.body);
      }
      if (q.posts) {
        // 7.5: the posts this piece became (active and unlinked, newest first)
        const [piece] = await queryRows('content_pieces', `select=id&legacy_id=eq.${encodeURIComponent(String(q.posts))}&limit=1`);
        if (!piece) return res.status(404).json({ error: 'piece not found' });
        const out = await require('../_studio/attribution.js').list(piece.id);
        return res.status(out.status).json(out.body);
      }
      if (q.budget) {
        const [piece] = await queryRows('content_pieces', `select=id&legacy_id=eq.${encodeURIComponent(String(q.budget))}&limit=1`);
        if (!piece) return res.status(404).json({ error: 'piece not found' });
        return res.status(200).json(await jobsSvc.pieceBudget(piece.id));
      }
      if (q.qc) {
        // the QC stage's current report + any running QC job on the draft
        const [piece] = await queryRows('content_pieces', `select=id&legacy_id=eq.${encodeURIComponent(String(q.qc))}&limit=1`);
        if (!piece) return res.status(404).json({ error: 'piece not found' });
        const st = await queryRows('stages', `select=id,kind,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=in.(qc,draft)`);
        const qs = st.find((s) => s.kind === 'qc'), ds = st.find((s) => s.kind === 'draft');
        const [qv] = qs && qs.current_version_id ? await queryRows('artifact_versions', `select=id,version,payload&id=eq.${encodeURIComponent(qs.current_version_id)}&limit=1`) : [];
        const live = ds ? await queryRows('jobs', `select=id,kind,state,error,payload&stage_id=eq.${encodeURIComponent(ds.id)}&kind=eq.f1x8_video&order=created_at.desc&limit=5`) : [];
        const run = live.find((j) => j.payload && j.payload.qcReport) || null;
        return res.status(200).json({ state: qs ? qs.state : null, version: qv ? qv.version : null, versionId: qv ? qv.id : null, report: qv && qv.payload ? qv.payload.report || null : null, job: run ? { id: run.id, state: run.state, error: run.error } : null, draftVersionId: ds ? ds.current_version_id : null });
      }
      if (q.board || q.shots) {
        // ?board=<id> (storyboard) or ?shots=<id>&stage=board|draft — the version whose shots are filling in
        const sk = q.shots && ['draft', 'final'].includes(String(q.stage)) ? String(q.stage) : 'board';
        const [piece] = await queryRows('content_pieces', `select=id&legacy_id=eq.${encodeURIComponent(String(q.shots || q.board))}&limit=1`);
        if (!piece) return res.status(404).json({ error: 'piece not found' });
        const [stage] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.${sk}&limit=1`);
        if (!stage || !stage.current_version_id) return res.status(404).json({ error: sk === 'draft' ? 'no first draft yet' : sk === 'final' ? 'no final yet' : 'no storyboard yet' });
        const [v] = await queryRows('artifact_versions', `select=id,version,payload,produced_by&id=eq.${encodeURIComponent(stage.current_version_id)}&limit=1`);
        const live = await queryRows('jobs', `select=id,kind,state&stage_id=eq.${encodeURIComponent(stage.id)}&state=in.(queued,running)&limit=20`);
        const hook = await queryRows('qc_results', `select=score,result,heatmap_path,at&artifact_version_id=eq.${encodeURIComponent(stage.current_version_id)}&order=at.desc&limit=1`).catch(() => []);
        let diff = null;
        if (sk === 'final' && v && v.payload && v.payload.fromDraftVersionId) { const [dv0] = await queryRows('artifact_versions', `select=payload&id=eq.${encodeURIComponent(v.payload.fromDraftVersionId)}&limit=1`); diff = require('../_studio/final.js').diffShots(dv0 ? dv0.payload.shots : [], v.payload.shots); }
        return res.status(200).json({ stage: sk, diff, version: v ? v.version : null, versionId: stage.current_version_id, state: stage.state, payload: v ? v.payload : null, live: live.filter((j) => j.kind !== 'vision_check').length, checksPending: live.filter((j) => j.kind === 'vision_check').length, hook: hook[0] ? { score: hook[0].score, summary: hook[0].result && hook[0].result.verdict ? hook[0].result.verdict.summary : null, risks: hook[0].result && hook[0].result.verdict ? (hook[0].result.verdict.risks || []).slice(0, 3) : [], heatmapPath: hook[0].heatmap_path || null, at: hook[0].at } : null });
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
    if (!['mood', 'thumb', 'thumb-composite', 'brief', 'brief-edit', 'board', 'board-shot', 'board-shot-decide', 'shot-decide', 'draft', 'draft-shot', 'draft-overlays', 'draft-assemble', 'qc', 'qc-plan-edit', 'qc-sendback', 'final', 'final-verify', 'final-package', 'budget', 'override-sign', 'override', 'post-link', 'post-unlink', 'slot-plan', 'slot-export', 'slot-cancel', 'slot-draft-check'].includes(b.action)) return res.status(400).json({ error: 'action must be one of mood, thumb, thumb-composite, brief, brief-edit, board, board-shot, board-shot-decide, shot-decide, draft, draft-shot' });
    const legacyId = String(b.pieceId || '');
    if (['slot-plan', 'slot-export', 'slot-cancel', 'slot-draft-check', 'post-link', 'post-unlink'].includes(b.action) && !claimActor(req, res)) return; // interim claim; closed by MAISTRO_REQUIRE_MEMBER=1
    if (b.action === 'slot-plan' || b.action === 'slot-export' || b.action === 'slot-cancel' || b.action === 'slot-draft-check') {
      // 8b: plan / export / cancel a post (manual mode: the operator posts and then links the post); in Sprinklr
      // drafts mode the export creates the draft and slot-draft-check reads its status back (preview: true renders one)
      const [piece] = await queryRows('content_pieces', `select=id,legacy_id,title&legacy_id=eq.${encodeURIComponent(legacyId)}&limit=1`);
      if (!piece) return res.status(404).json({ error: 'piece not found' });
      const pub = require('../_studio/publishing.js');
      const out = b.action === 'slot-plan' ? await pub.plan({ piece, b, member: req.member || null })
        : b.action === 'slot-draft-check' ? await pub.draftCheck({ piece, id: b.id, member: req.member || null, preview: b.preview === true, previewId: b.previewId })
        : await pub.setStatus({ piece, id: b.id, to: b.action === 'slot-export' ? 'exported' : 'canceled', member: req.member || null, reason: b.reason });
      return res.status(out.status).json(out.body);
    }
    if (b.action === 'post-link' || b.action === 'post-unlink') {
      // 7.5: link the approved final to the published post (owned accounts only), or unlink it (history kept)
      const [piece] = await queryRows('content_pieces', `select=id&legacy_id=eq.${encodeURIComponent(legacyId)}&limit=1`);
      if (!piece) return res.status(404).json({ error: 'piece not found' });
      const attr = require('../_studio/attribution.js');
      const out = b.action === 'post-link'
        ? await attr.link({ piece, url: b.url, member: req.member || null, resolve: require('./track.js').resolvePostUrl })
        : await attr.unlink({ piece, id: b.id, reason: b.reason, member: req.member || null });
      return res.status(out.status).json(out.body);
    }
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
    // only the actions that call Claude inside this request need the key (reviews, budgets and renders do not)
    if (['mood', 'thumb', 'brief-edit', 'board'].includes(b.action) && !process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured' });
    const { piece } = await ensurePiece(legacyId, b.piece || {});
    const meta = { id: legacyId, title: piece.title, product: piece.product, msg: piece.key_message, angle: piece.angle, markets: piece.markets, platforms: piece.platforms };
    const bits = await kbBits(piece.product);
    if (b.action === 'board-shot-decide' || b.action === 'shot-decide') {
      const sk = b.action === 'shot-decide' && ['draft', 'final'].includes(b.stage) ? b.stage : 'board';
      const slot = sk === 'board' ? 'keyframe' : 'clip';
      const n = Number(b.shot);
      const decision = b.decision === 'approved' || b.decision === 'rejected' ? b.decision : null;
      if (!decision || !Number.isInteger(n)) return res.status(400).json({ error: 'shot and decision (approved|rejected) are required' });
      if (decision === 'rejected' && !String(b.reason || '').trim()) return res.status(400).json({ error: 'a written reason is required to reject a shot' });
      const [stage] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.${sk}&limit=1`);
      if (!stage || !stage.current_version_id) return res.status(409).json({ error: `no ${sk === 'draft' ? 'first draft' : sk === 'final' ? 'final' : 'storyboard'} version`, code: 'no_version' });
      if (stage.state === 'approved') return res.status(409).json({ error: `the ${sk === 'board' ? 'storyboard' : sk} is approved; reopen it first`, code: 'approved_immutable' });
      const [v] = await queryRows('artifact_versions', `select=id,payload&id=eq.${encodeURIComponent(stage.current_version_id)}&limit=1`);
      if (!v || !Array.isArray(v.payload.shots) || !v.payload.shots[n - 1]) return res.status(404).json({ error: `shot ${n} not found` });
      if (decision === 'approved' && !(v.payload.shots[n - 1][slot] && v.payload.shots[n - 1][slot].state === 'rendered')) return res.status(409).json({ error: `shot ${n} has no rendered ${slot} to approve`, code: 'no_keyframe' });
      const review = { decision, reason: String(b.reason || '').slice(0, 2000) || null, reasonCode: b.reasonCode ? String(b.reasonCode).slice(0, 60) : null, by: req.member ? req.member.name || req.member.email : String(b.name || '').slice(0, 120) || null, at: new Date().toISOString(), keyframeJobId: v.payload.shots[n - 1][slot] ? v.payload.shots[n - 1][slot].jobId || null : null };
      // the review binds to the keyframe that was on screen: a keyframe that landed meanwhile is not approved by this click
      const r = await jobsSvc.updateShots(v.id, (payload) => { const shots = payload.shots.map((s) => ({ ...s })); const cur = shots[n - 1][slot] ? shots[n - 1][slot].jobId || null : null; if (decision === 'approved' && cur !== review.keyframeJobId) return null; shots[n - 1] = { ...shots[n - 1], review }; return { ...payload, shots }; });
      if (r.unchanged) return res.status(409).json({ error: `shot ${n} was re-rendered while you reviewed it — look at the new ${slot}`, code: 'keyframe_changed' });
      const shots = r.payload.shots;
      try { await insertRows('audit_log', [{ actor: req.member ? req.member.id : null, action: `${sk}.shot.${decision}`, entity: 'artifact_version', entity_id: v.id, after: { pieceId: legacyId, shot: n, reasonCode: review.reasonCode, reason: review.reason } }]); } catch (e) { /* best effort */ }
      return res.status(200).json({ ok: true, shot: n, review, pending: shots.filter((s) => !s.review || s.review.decision !== 'approved').map((s) => s.n) });
    }
    if (b.action === 'board-shot') {
      const n = Number(b.shot);
      const [stage] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.board&limit=1`);
      if (!stage || !stage.current_version_id) return res.status(409).json({ error: 'no storyboard version', code: 'no_version' });
      if (stage.state === 'approved') return res.status(409).json({ error: 'the storyboard is approved; reopen it first', code: 'approved_immutable' });
      const [v] = await queryRows('artifact_versions', `select=id,payload&id=eq.${encodeURIComponent(stage.current_version_id)}&limit=1`);
      if (!v || !Array.isArray(v.payload.shots) || !v.payload.shots[n - 1]) return res.status(404).json({ error: `shot ${n} not found` });
      const liveRows = await queryRows('jobs', `select=id,kind,payload&stage_id=eq.${encodeURIComponent(stage.id)}&state=in.(queued,running)&limit=50`);
      if (liveRows.some((j) => j.kind === 'hermes_image' && j.payload && j.payload.attachTo && Number(j.payload.attachTo.shot) === n)) return res.status(409).json({ error: `shot ${n} is already rendering`, code: 'busy' });
      const mood = await thumb.moodContext(piece.id);
      const refImage = typeof b.refImage === 'string' && /^https:\/\//.test(b.refImage) ? b.refImage : null;
      const shot = v.payload.shots[n - 1];
      const useRef = Boolean(refImage && shot.product.visible);
      const changes = String(b.changes || '').trim();
      const prompt = `${boardMod.keyframePrompt(shot, mood.direction, bits.productLook, useRef)}${changes ? ` Changes requested by the reviewer (apply only these, keep everything else): ${changes}.` : ''}`;
      const anchors = mood.tiles.filter((t) => t.assetPath || t.url).slice(0, 4).map((t) => ({ index: t.index, url: t.url || null, assetPath: t.assetPath || null }));
      const [job] = await insertRows('jobs', [{ piece_id: piece.id, stage_id: stage.id, kind: 'hermes_image', state: 'queued', attempts: 0, next_poll_at: new Date().toISOString(), payload: { pieceId: legacyId, stage: 'board', prompt, aspect_ratio: v.payload.aspect || '9:16', resolution: '1080p', seed: newSeed(), ...(useRef ? { ref: refImage } : {}), autoCheck: true, attachTo: { versionId: v.id, shot: n }, generatedBy: req.member ? req.member.id : null, meta: { shot: n, prompt, changes: changes || null, anchors, direction: mood.direction || null, product: piece.product, productLook: bits.productLook, rules: bits.rules, expectProduct: shot.product.visible, hookCheck: n === v.payload.hookShot, title: piece.title } } }], { returning: true });
      const { patchRows } = require('../_supabase.js');
      if (stage.state !== 'generating') await patchRows('stages', `id=eq.${encodeURIComponent(stage.id)}`, { state: 'generating' });
      await jobsSvc.advance(job).catch(() => null);
      const fresh = await jobsSvc.getJob(job.id);
      return res.status(200).json({ ok: true, shot: n, job: jobsSvc.publicJob(fresh || job, legacyId) });
    }
    if (b.action === 'override-sign' || b.action === 'override') {
      // 6.9 human override: a person's own asset in place of a generated one — versioned, labelled human-made, re-checked
      const KINDS = { image: { types: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }, max: 15 * 1024 * 1024 }, video: { types: { 'video/mp4': 'mp4', 'video/quicktime': 'mov' }, max: 200 * 1024 * 1024 } };
      const stg = String(b.stage || '');
      const shotN = b.shot == null ? null : Number(b.shot);
      const target = ['mood', 'thumb'].includes(stg) && shotN == null ? { media: 'image', slot: null } : stg === 'board' && Number.isInteger(shotN) ? { media: 'image', slot: 'keyframe' } : ['draft', 'final'].includes(stg) && Number.isInteger(shotN) ? { media: 'video', slot: 'clip' } : null;
      if (!target) return res.status(400).json({ error: 'override: mood/thumb (whole stage), board (a shot keyframe) or draft/final (a shot clip)' });
      const spec = KINDS[target.media];
      if (b.action === 'override-sign') {
        const ext = spec.types[String(b.contentType || '')];
        if (!ext) return res.status(415).json({ error: `contentType must be one of ${Object.keys(spec.types).join(', ')}` });
        const path = `pieces/${legacyId}/${stg}/override-${shotN != null ? `${shotN}-` : ''}${Date.now().toString(36)}.${ext}`;
        return res.status(200).json({ ok: true, ...(await storage.signedUploadUrl(path)), maxBytes: spec.max });
      }
      const path = String(b.path || '');
      if (!new RegExp(`^pieces/${legacyId.replace(/[^a-zA-Z0-9_-]/g, '')}/${stg}/override-[a-z0-9-]+\\.(png|jpg|webp|mp4|mov)$`).test(path)) return res.status(422).json({ error: 'path must be this piece\'s override upload' });
      const bytes = await storage.readObject(path, spec.max);
      const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const isJpg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const isWebp = bytes.length > 12 && bytes.slice(0, 4).toString() === 'RIFF' && bytes.slice(8, 12).toString() === 'WEBP';
      const isMp4 = bytes.length > 12 && bytes.slice(4, 8).toString() === 'ftyp';
      if (target.media === 'image' ? !(isPng || isJpg || isWebp) : !isMp4) return res.status(422).json({ error: `the uploaded file is not a valid ${target.media}` });
      const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
      const by = req.member ? req.member.id : 'password-session';
      const asset = { state: 'rendered', url: null, assetPath: path, sha256, size: bytes.length, override: true, overriddenBy: by, at: new Date().toISOString() };
      if (!target.slot) {
        const out = await recordVersion(legacyId, stg, { imageUrl: null, assetPath: path, sha256, size: bytes.length, override: true, overriddenBy: by, note: 'Uploaded by a person in place of a generated image' }, { piece: b.piece || {}, producedBy: 'manual', kind: 'image', generatedBy: req.member ? req.member.id : null });
        const job = await createJob({ legacyId, stage: stg, kind: 'vision_check', payload: { versionId: out.versionId, images: [{ index: 0, url: null, assetPath: path }], product: piece.product || null, productLook: bits.productLook, rules: bits.rules, expectProduct: stg === 'thumb' && Boolean(bits.productLook), source: 'override' } });
        return res.status(200).json({ ok: true, version: out.version, versionId: out.versionId, asset, checkJob: job.id });
      }
      const [st0] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.${stg}&limit=1`);
      if (!st0 || !st0.current_version_id) return res.status(409).json({ error: `no ${stg} version`, code: 'no_version' });
      if (st0.state === 'approved') return res.status(409).json({ error: `the ${stg} is approved; reopen it first`, code: 'approved_immutable' });
      const r0 = await jobsSvc.updateShots(st0.current_version_id, (payload) => { if (!Array.isArray(payload.shots) || !payload.shots[shotN - 1]) return null; const shots = payload.shots.map((s) => ({ ...s })); const prev = shots[shotN - 1][target.slot]; shots[shotN - 1] = { ...shots[shotN - 1], [target.slot]: asset, [`${target.slot}History`]: [...(shots[shotN - 1][`${target.slot}History`] || []), ...(prev && prev.state === 'rendered' ? [prev] : [])], review: null }; return { ...payload, shots }; });
      if (r0.unchanged) return res.status(404).json({ error: `shot ${shotN} not found` });
      const sh = r0.payload.shots[shotN - 1];
      const check = target.slot === 'clip'
        ? await insertRows('jobs', [{ piece_id: piece.id, stage_id: st0.id, kind: 'clip_check', state: 'queued', attempts: 0, next_poll_at: new Date().toISOString(), payload: { pieceId: legacyId, stage: stg, versionId: st0.current_version_id, shot: shotN, clipAssetPath: path, keyframeAssetPath: sh.keyframe ? sh.keyframe.assetPath : null, product: piece.product, productLook: bits.productLook, rules: bits.rules, expectProduct: Boolean(sh.product && sh.product.visible), source: 'override' } }], { returning: true })
        : await insertRows('jobs', [{ piece_id: piece.id, stage_id: st0.id, kind: 'vision_check', state: 'queued', attempts: 0, next_poll_at: new Date().toISOString(), payload: { pieceId: legacyId, stage: stg, versionId: st0.current_version_id, shot: shotN, images: [{ index: shotN, url: null, assetPath: path }], product: piece.product, productLook: bits.productLook, rules: bits.rules, expectProduct: Boolean(sh.product && sh.product.visible), source: 'override' } }], { returning: true });
      try { await insertRows('audit_log', [{ actor: req.member ? req.member.id : null, action: `${stg}.override`, entity: 'artifact_version', entity_id: st0.current_version_id, after: { pieceId: legacyId, shot: shotN, assetPath: path, sha256 } }]); } catch (e) { /* best effort */ }
      return res.status(200).json({ ok: true, shot: shotN, asset, checkJob: check[0] ? check[0].id : null });
    }
    if (b.action === 'budget') {
      // 6.9: the per-piece cap and warning threshold, set by a line manager or admin (or the interim password session)
      // Phase 11 (S2): raising a budget spends money — member-only, line manager or admin
      if (!memberOnly(req, res, ['admin', 'line_manager'])) return;
      const cap = Number(b.budgetUsd), warn = b.warnPct == null ? null : Number(b.warnPct);
      if (!(cap >= 0 && cap <= 10000)) return res.status(400).json({ error: 'budgetUsd must be 0–10000' });
      if (warn != null && !(Number.isInteger(warn) && warn >= 1 && warn <= 100)) return res.status(400).json({ error: 'warnPct must be an integer 1–100' });
      const { patchRows } = require('../_supabase.js');
      await patchRows('content_pieces', `id=eq.${encodeURIComponent(piece.id)}`, { budget_usd: cap, ...(warn != null ? { budget_warn_pct: warn } : {}) });
      try { await insertRows('audit_log', [{ actor: req.member ? req.member.id : null, action: 'piece.budget', entity: 'content_piece', entity_id: piece.id, after: { budgetUsd: cap, warnPct: warn } }]); } catch (e) { /* best effort */ }
      return res.status(200).json({ ok: true, ...(await jobsSvc.pieceBudget(piece.id)) });
    }
    if (b.action === 'final' || b.action === 'final-verify' || b.action === 'final-package') {
      // Phase 11 (S2): the delivery package is what gets posted — member-only
      if (b.action === 'final-package' && !memberOnly(req, res)) return;
      const finalMod = require('../_studio/final.js');
      const { patchRows } = require('../_supabase.js');
      const st = await queryRows('stages', `select=id,kind,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=in.(qc,draft,final,thumb,brief)`);
      const S = (k) => st.find((x) => x.kind === k) || null;
      const ver = async (k) => { const s0 = S(k); if (!s0 || !s0.current_version_id) return null; const [v] = await queryRows('artifact_versions', `select=id,version,payload&id=eq.${encodeURIComponent(s0.current_version_id)}&limit=1`); return v || null; };
      if (b.action === 'final') {
        // apply ONLY the approved QC plan
        // owner 2026-10-29: the final does not wait for the QC; with no approved QC plan it is the current draft's cut as it stands
        const qcApproved = Boolean(S('qc') && S('qc').state === 'approved');
        const qv = qcApproved ? await ver('qc') : null;
        const report = (qv && qv.payload && qv.payload.report) || null;
        if (qcApproved && !report) return res.status(409).json({ error: 'the approved QC has no fix plan', code: 'prerequisites' });
        const dv = report ? (await queryRows('artifact_versions', `select=id,version,payload&id=eq.${encodeURIComponent(report.draftVersionId)}&limit=1`))[0] : await ver('draft');
        if (!dv || !dv.payload || !Array.isArray(dv.payload.shots)) return res.status(409).json({ error: report ? 'the analysed draft is missing' : 'the final needs a first draft video', code: 'prerequisites' });
        if (!report && !(dv.payload.assembled && dv.payload.assembled.assetPath)) return res.status(409).json({ error: 'the first draft video is still being made', code: 'prerequisites' });
        if (S('final') && S('final').state === 'approved') return res.status(409).json({ error: 'the final is approved; reopen it first', code: 'approved_immutable' });
        const ap = report ? finalMod.applyPlan(dv.payload, report) : { shots: dv.payload.shots, applied: [], notApplied: [], regenShots: [] };
        const nothingToRebuild = !ap.regenShots.length && !ap.applied.length;
        const artifact = { ...dv.payload, shots: ap.shots, fromDraftVersionId: dv.id, fromDraftVersion: dv.version, fromDraftSha256: report ? report.draftSha256 : dv.payload.assembled.sha256, fromQcVersionId: qv ? qv.id : null, qcSkipped: !report, applied: ap.applied, notApplied: ap.notApplied, verification: null, finalVersion: finalMod.VERSION, rev: 0,
          // nothing changed → the draft's cut IS the final (same bytes); otherwise it is re-assembled
          assembled: nothingToRebuild ? dv.payload.assembled : null, assetPath: nothingToRebuild ? dv.payload.assetPath : null, sha256: nothingToRebuild ? dv.payload.sha256 : null, assembledChecks: nothingToRebuild ? dv.payload.assembledChecks : null,
          version: undefined, qcRevised: true, variants: (dv.payload.variants || []).map((x) => ({ ...x, st: nothingToRebuild ? 'ready' : 'rendering' })) };
        delete artifact.version;
        const out = await recordVersion(legacyId, 'final', artifact, { piece: b.piece || {}, producedBy: ap.regenShots.length ? 'hermes' : 'manual', kind: 'video', generatedBy: req.member ? req.member.id : null });
        const fs0 = (await queryRows('stages', `select=id,state&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.final&limit=1`))[0];
        const jobs = [];
        if (ap.regenShots.length) {
          const motion = (x) => `${x.camera}. ${x.action} ${x.product && x.product.visible ? 'The device stays exactly as in the first frame — no morphing, no extra buttons, no logos.' : ''} Fix requested by QC (apply only this, keep everything else): ${x.regenInstruction}. Present tense, one continuous motion, no cuts, no on-screen text, no captions.`.replace(/\s+/g, ' ').trim();
          const rows = ap.regenShots.map((n) => { const x = ap.shots.find((y) => y.n === n); return { piece_id: piece.id, stage_id: fs0.id, kind: 'hermes_video', state: 'queued', attempts: 0, next_poll_at: new Date().toISOString(), payload: { pieceId: legacyId, stage: 'final', prompt: motion(x), ...(x.keyframe && x.keyframe.assetPath ? { imageAssetPath: x.keyframe.assetPath } : { imageUrl: x.keyframe ? x.keyframe.url : null }), duration: Math.min(30, Math.max(4, Math.ceil(Number(x.durationS) || 4))), resolution: dv.payload.resolution || '720p', aspect_ratio: dv.payload.aspect || '9:16', generateAudio: true, autoCheck: true, attachTo: { versionId: out.versionId, shot: n }, generatedBy: req.member ? req.member.id : null, meta: { shot: n, prompt: motion(x), title: piece.title, expectProduct: Boolean(x.product && x.product.visible), product: piece.product, fix: true } } }; });
          const inserted = await insertRows('jobs', rows, { returning: true });
          await patchRows('stages', `id=eq.${encodeURIComponent(fs0.id)}`, { state: 'generating' });
          for (const j0 of inserted) { await jobsSvc.advance(j0).catch(() => null); const fresh = await jobsSvc.getJob(j0.id); jobs.push(jobsSvc.publicJob(fresh || j0, legacyId)); }
        }
        try { const { syncSpec } = require('../_spec.js'); await syncSpec(legacyId, { memberId: req.member ? req.member.id : null, note: 'final: QC fixes applied' }); } catch (e) { /* best effort */ }
        return res.status(200).json({ ok: true, version: out.version, versionId: out.versionId, applied: ap.applied, notApplied: ap.notApplied, regenShots: ap.regenShots, reusedDraftCut: nothingToRebuild, overlaysToRedraw: ap.shots.filter((x) => x.overlayStale).map((x) => x.n), jobs, artifact: { ...artifact, version: `v${out.version}` } });
      }
      const fv = await ver('final');
      if (!fv || !fv.payload) return res.status(409).json({ error: 'no final version', code: 'no_version' });
      if (b.action === 'final-verify') {
        // F1X8 again on the STORED final cut; each original risk verified afterwards
        const asm = fv.payload.assembled;
        if (!asm || !asm.assetPath || !asm.sha256) return res.status(409).json({ error: 'assemble the final first', code: 'prerequisites' });
        if (S('final').state === 'approved') return res.status(409).json({ error: 'the final is approved', code: 'approved_immutable' });
        const job = await createJob({ legacyId, stage: 'final', kind: 'f1x8_video', payload: { assetPath: asm.assetPath, expectSha256: asm.sha256, versionId: fv.id, title: piece.title, description: `Final cut of "${piece.title}" for ${piece.product} after the QC fixes.`, verifyFinal: true, qcVersionId: fv.payload.fromQcVersionId }, piece: b.piece || {}, member: req.member });
        return res.status(200).json({ ok: true, job });
      }
      // final-package: only from an approved final (line-manager + ADLCP documents on that exact version)
      { const { staleFor } = require('../_store.js'); const stale = await staleFor(st.length ? await queryRows('stages', `select=kind,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}`) : []); if (stale.length) return res.status(409).json({ error: `stale stages: ${stale.map((x) => `${x.kind} (built from an older ${x.because.map((b) => b.kind).join('/')})`).join(', ')}`, code: 'stale_inputs', stale }); }
      if (S('final').state !== 'approved') return res.status(409).json({ error: 'the final must be approved with the line-manager and ADLCP documents first', code: 'prerequisites' });
      const docs = await queryRows('adlcp_documents', `select=kind,sha256&artifact_version_id=eq.${encodeURIComponent(fv.id)}`);
      if (!['line_manager', 'adlcp'].every((k) => docs.some((d) => d.kind === k))) return res.status(409).json({ error: 'the ADLCP documents are not linked to this final version', code: 'documents_required' });
      const bv = await ver('brief'), tv = await ver('thumb');
      const qcv = fv.payload.fromQcVersionId ? (await queryRows('artifact_versions', `select=payload&id=eq.${encodeURIComponent(fv.payload.fromQcVersionId)}&limit=1`))[0] : null;
      const ver2 = fv.payload.verification || null;
      const pkg = finalMod.packageManifest({ piece: { ...piece, legacy_id: legacyId }, finalVersion: fv, final: fv.payload, brief: bv ? bv.payload : null, thumb: tv ? tv.payload : null, scores: { draft: qcv && qcv.payload.report ? qcv.payload.report.score : null, final: ver2 ? ver2.score : null, resolved: ver2 ? ver2.risks.filter((r) => r.resolved === 'yes').length + '/' + ver2.risks.length : null } });
      pkg.manifest.adlcp = docs.map((d) => ({ kind: d.kind, sha256: d.sha256 }));
      const body = JSON.stringify(pkg.manifest, null, 1);
      const put = await storage.putBlob(`pieces/${legacyId}/final/package-v${fv.version}-${Date.now().toString(36)}.json`, Buffer.from(body), 'application/json');
      try { await insertRows('audit_log', [{ actor: req.member ? req.member.id : null, action: 'final.package', entity: 'artifact_version', entity_id: fv.id, after: { pieceId: legacyId, assetPath: put.path, sha256: put.sha256 } }]); } catch (e) { /* best effort */ }
      const urls = {};
      for (const [k, pth] of [['video', pkg.manifest.final.video && pkg.manifest.final.video.assetPath], ['thumbnail', pkg.manifest.thumbnail && pkg.manifest.thumbnail.assetPath], ['manifest', put.path]]) if (pth) { try { urls[k] = await storage.signedUrl(pth, 7 * 24 * 3600); } catch (e) { /* unsigned */ } }
      return res.status(200).json({ ok: true, manifest: pkg.manifest, assetPath: put.path, sha256: put.sha256, urls });
    }
    if (b.action === 'qc' || b.action === 'qc-plan-edit' || b.action === 'qc-sendback') {
      const qcMod = require('../_studio/qc.js');
      const hermes = require('../_adapters/hermes.js');
      const { patchRows } = require('../_supabase.js');
      const [ds] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.draft&limit=1`);
      if (b.action === 'qc') {
        // F1X8 on the STORED assembled cut, verified by its sha256; the report is built when F1X8 returns
        const [dv] = ds && ds.current_version_id ? await queryRows('artifact_versions', `select=id,version,payload&id=eq.${encodeURIComponent(ds.current_version_id)}&limit=1`) : [];
        const asm = dv && dv.payload && dv.payload.assembled;
        if (!asm || !asm.assetPath || !asm.sha256) return res.status(409).json({ error: 'QC needs the assembled cut — assemble the first draft first', code: 'prerequisites' });
        const live = await queryRows('jobs', `select=id,kind,payload&stage_id=eq.${encodeURIComponent(ds.id)}&state=in.(queued,running)&limit=50`);
        if (live.some((j) => j.kind === 'f1x8_video' && j.payload && j.payload.qcReport)) return res.status(409).json({ error: 'QC is already running on this draft', code: 'busy' });
        const brief = await boardMod.briefFor(piece.id);
        const sp = brief && brief.payload && brief.payload.spec;
        const description = `Samsung Gulf social video for ${piece.product}. Key message: ${(sp && sp.keyMessage) || piece.key_message || ''}. Trend hook: ${sp ? sp.trendHook.mechanic : piece.trend_name || ''}. Platforms: ${(piece.platforms || []).join(', ')}. Markets: ${(piece.markets || []).join(', ')}. CTA: ${(sp && sp.cta) || ''}.`;
        const job = await createJob({ legacyId, stage: 'draft', kind: 'f1x8_video', payload: { assetPath: asm.assetPath, expectSha256: asm.sha256, versionId: dv.id, title: piece.title, description, qcReport: true }, piece: b.piece || {}, member: req.member });
        return res.status(200).json({ ok: true, job, draftVersionId: dv.id, draftSha256: asm.sha256 });
      }
      const [qs] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.qc&limit=1`);
      const [qv] = qs && qs.current_version_id ? await queryRows('artifact_versions', `select=id,version,payload&id=eq.${encodeURIComponent(qs.current_version_id)}&limit=1`) : [];
      if (!qv || !qv.payload || !qv.payload.report) return res.status(409).json({ error: 'no QC report yet', code: 'no_version' });
      if (qs.state === 'approved') return res.status(409).json({ error: 'the QC is approved; reopen it first', code: 'approved_immutable' });
      if (b.action === 'qc-plan-edit') {
        const report = await qcMod.editPlan(qv.payload.report, Array.isArray(b.edits) ? b.edits.slice(0, 40) : [], { estimate: hermes.estimate });
        const out = await recordVersion(legacyId, 'qc', { ...qv.payload, report: { ...report, editedBy: req.member ? req.member.id : 'password-session' } }, { piece: b.piece || {}, producedBy: 'manual', kind: 'qc_report', generatedBy: req.member ? req.member.id : null });
        return res.status(200).json({ ok: true, version: out.version, versionId: out.versionId, report });
      }
      // send back to an earlier stage: the QC is rejected with the target recorded; an approved target is reopened (admin)
      const toStage = ['brief', 'board', 'draft'].includes(b.toStage) ? b.toStage : null;
      if (!toStage) return res.status(400).json({ error: 'toStage must be brief, board or draft' });
      const reason = String(b.reason || '').trim(); if (!reason) return res.status(400).json({ error: 'a written reason is required' });
      // Phase 11 (S2): the acting role is the member's own, else a password-session claim at reviewer — never b.role
      const sbActor = claimActor(req, res); if (!sbActor) return;
      const role = sbActor.role;
      const { decide, reopen } = require('../_store.js');
      const d = await decide(legacyId, 'qc', { decision: 'rejected', reason: `sent back to ${toStage}: ${reason}`, reasonCode: 'other', role, name: (req.member && req.member.name) || b.name || 'unknown', details: { sendBack: toStage }, actorId: req.member ? req.member.id : null });
      const [ts] = await queryRows('stages', `select=state&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.${toStage}&limit=1`);
      let reopened = false, needsAdmin = false;
      if (ts && ts.state === 'approved') { if (role === 'admin') { await reopen(legacyId, toStage, role); reopened = true; } else needsAdmin = true; }
      return res.status(200).json({ ok: true, decision: d, toStage, reopened, needsAdmin });
    }
    if (b.action === 'draft-overlays' || b.action === 'draft-assemble') {
      // 6.6 (b): the browser draws each shot's text + caption as a PNG (correct Arabic shaping);
      // the PNGs are validated like the thumbnail composite and stored on the shot; assembly
      // then runs as a job over the APPROVED clips only
      const sk = b.stage === 'final' ? 'final' : 'draft'; // 6.8: the final re-uses the overlay and assembly steps
      const [ds] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.${sk}&limit=1`);
      if (!ds || !ds.current_version_id) return res.status(409).json({ error: `no ${sk === 'final' ? 'final' : 'first draft'} version`, code: 'no_version' });
      if (ds.state === 'approved') return res.status(409).json({ error: `the ${sk} is approved; reopen it first`, code: 'approved_immutable' });
      const [dv] = await queryRows('artifact_versions', `select=id,version,payload&id=eq.${encodeURIComponent(ds.current_version_id)}&limit=1`);
      if (!dv || !Array.isArray(dv.payload.shots)) return res.status(409).json({ error: 'the draft has no shot list', code: 'no_version' });
      if (b.action === 'draft-overlays') {
        const list = Array.isArray(b.overlays) ? b.overlays.slice(0, 8) : [];
        if (!list.length) return res.status(422).json({ error: 'overlays[] (shot, data) is required' });
        const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        const stored = [];
        for (const o of list) {
          const n = Number(o.shot); if (!dv.payload.shots[n - 1]) return res.status(404).json({ error: `shot ${n} not found` });
          const bytes = Buffer.from(String(o.data || ''), 'base64');
          if (!bytes.length || bytes.length > 2 * 1024 * 1024) return res.status(413).json({ error: `overlay for shot ${n} must be a PNG under 2 MB` });
          if (bytes.length < 8 || !PNG_SIG.every((x, i) => bytes[i] === x)) return res.status(422).json({ error: `overlay for shot ${n} must be a PNG` });
          const put = await storage.putBlob(`pieces/${legacyId}/${sk}/overlay-${n}-${Date.now().toString(36)}.png`, bytes, 'image/png');
          stored.push({ n, overlay: { assetPath: put.path, sha256: put.sha256, size: put.size, text: o.text && typeof o.text === 'object' ? { en: String(o.text.en || '').slice(0, 200), ar: String(o.text.ar || '').slice(0, 200) } : null, at: new Date().toISOString() } });
        }
        await jobsSvc.updateShots(dv.id, (payload) => { const shots = payload.shots.map((s) => ({ ...s })); for (const x of stored) shots[x.n - 1] = { ...shots[x.n - 1], overlay: x.overlay, overlayStale: false }; return { ...payload, shots }; });
        return res.status(200).json({ ok: true, stored: stored.map((x) => ({ shot: x.n, assetPath: x.overlay.assetPath })) });
      }
      const stale = dv.payload.shots.filter((s) => s.overlayStale).map((s) => s.n);
      if (stale.length) return res.status(409).json({ error: `redraw the text overlays first — shot${stale.length > 1 ? 's' : ''} ${stale.join(', ')} changed`, code: 'overlays_stale', pending: stale });
      // owner 2026-10-29: the cut needs no per-clip approval, and a failed clip is left out (one full video)
      const notReady = dv.payload.shots.filter((s) => !(s.clip && ['rendered', 'failed'].includes(s.clip.state))).map((s) => s.n);
      if (notReady.length) return res.status(409).json({ error: `clips still rendering — shot${notReady.length > 1 ? 's' : ''} ${notReady.join(', ')}`, code: 'prerequisites', pending: notReady });
      if (!dv.payload.shots.some((s) => s.clip && s.clip.state === 'rendered')) return res.status(409).json({ error: 'every clip failed — re-render at least one shot first', code: 'prerequisites' });
      const liveRows = await queryRows('jobs', `select=id,kind&stage_id=eq.${encodeURIComponent(ds.id)}&state=in.(queued,running)&limit=50`);
      if (liveRows.some((j) => j.kind === 'assemble')) return res.status(409).json({ error: 'the cut is already being assembled', code: 'busy' });
      const brief = await boardMod.briefFor(piece.id);
      const targetS = brief && brief.payload && brief.payload.spec && brief.payload.spec.format ? brief.payload.spec.format.targetDurationS : null;
      const [job] = await insertRows('jobs', [{ piece_id: piece.id, stage_id: ds.id, kind: 'assemble', state: 'queued', attempts: 0, next_poll_at: new Date().toISOString(), payload: { pieceId: legacyId, stage: sk, versionId: dv.id, targetS, generatedBy: req.member ? req.member.id : null } }], { returning: true });
      // the job runs on the next tick (ffmpeg inside the job service, not inside this request)
      return res.status(200).json({ ok: true, job: jobsSvc.publicJob(job, legacyId) });
    }
    if (b.action === 'draft' || b.action === 'draft-shot') {
      // 6.6: one image-to-video clip per storyboard shot, from its keyframe (the Hermes video bot).
      // Owner 2026-10-28: the first draft does not wait for the storyboard's approval, and a keyframe that FAILED
      // does not hold it up either — that shot is left out (the draft renumbers 1..k, keeping boardShot). It only
      // waits while a keyframe is still rendering, and needs at least one rendered keyframe.
      // Owner 2026-10-29: the storyboard is optional too. Without one (skipped, or no shot list) the draft is ONE
      // text-to-video clip written from the brief / campaign plan. Either way the clips join into one video by themselves.
      const [bs] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.board&limit=1`);
      const [bv] = bs && bs.current_version_id ? await queryRows('artifact_versions', `select=id,version,payload&id=eq.${encodeURIComponent(bs.current_version_id)}&limit=1`) : [];
      const bshots = b.noBoard ? [] : bv && bv.payload && Array.isArray(bv.payload.shots) ? bv.payload.shots : [];
      const kfRendered = (x) => x.keyframe && x.keyframe.state === 'rendered';
      const kfFailed = (x) => x.keyframe && x.keyframe.state === 'failed';
      const pendingShots = bshots.filter((x) => !kfRendered(x) && !kfFailed(x)).map((x) => x.n);
      if (pendingShots.length) return res.status(409).json({ error: `the storyboard keyframes are still rendering — shot${pendingShots.length > 1 ? 's' : ''} ${pendingShots.join(', ')} pending`, code: 'prerequisites', pending: pendingShots });
      const skippedShots = bshots.filter(kfFailed).map((x) => x.n);
      if (bshots.length && skippedShots.length === bshots.length) return res.status(409).json({ error: 'every storyboard keyframe failed — regenerate at least one shot first', code: 'prerequisites', pending: skippedShots });
      const resolution = ['480p', '720p', '1080p'].includes(b.resolution) ? b.resolution : '720p';
      const motion = (x) => `${x.camera}. ${x.action} ${x.product && x.product.visible ? 'The device stays exactly as in the first frame — no morphing, no extra buttons, no logos.' : ''} Present tense, one continuous motion, no cuts, no on-screen text, no captions.`.replace(/\s+/g, ' ').trim();
      const clipDuration = (x) => Math.min(30, Math.max(4, Math.ceil(Number(x.durationS) || 4))); // 4–30 s clips; the assembly trims to the shot
      const [ds] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.draft&limit=1`);
      const draftAspect = bv && bshots.length && ['9:16', '16:9', '1:1'].includes(bv.payload.aspect) ? bv.payload.aspect : thumb.aspectFor(piece.platforms);
      const clipJob = (versionId, x, extra) => ({ piece_id: piece.id, stage_id: ds.id, kind: 'hermes_video', state: 'queued', attempts: 0, next_poll_at: new Date().toISOString(), payload: { pieceId: legacyId, stage: 'draft', prompt: `${x.textPrompt || motion(x)}${extra ? ` Changes requested by the reviewer (apply only these, keep everything else): ${extra}.` : ''}`, ...(!x.keyframe ? {} : x.keyframe.assetPath ? { imageAssetPath: x.keyframe.assetPath } : { imageUrl: x.keyframe.url }), duration: clipDuration(x), resolution, aspect_ratio: draftAspect, generateAudio: true, attachTo: { versionId, shot: x.n }, generatedBy: req.member ? req.member.id : null, meta: { shot: x.n, prompt: x.textPrompt || motion(x), title: piece.title, shotDurationS: x.durationS, expectProduct: Boolean(x.product && x.product.visible), fromKeyframeJob: (x.keyframe && x.keyframe.jobId) || null } } });
      const { patchRows } = require('../_supabase.js');
      if (b.action === 'draft-shot') {
        const n = Number(b.shot);
        if (!ds || !ds.current_version_id) return res.status(409).json({ error: 'no first draft version', code: 'no_version' });
        if (ds.state === 'approved') return res.status(409).json({ error: 'the draft is approved; reopen it first', code: 'approved_immutable' });
        const [dv] = await queryRows('artifact_versions', `select=id,payload&id=eq.${encodeURIComponent(ds.current_version_id)}&limit=1`);
        if (!dv || !Array.isArray(dv.payload.shots) || !dv.payload.shots[n - 1]) return res.status(404).json({ error: `shot ${n} not found` });
        const liveRows = await queryRows('jobs', `select=id,kind,payload&stage_id=eq.${encodeURIComponent(ds.id)}&state=in.(queued,running)&limit=50`);
        if (liveRows.some((j) => j.kind === 'hermes_video' && j.payload && j.payload.attachTo && Number(j.payload.attachTo.shot) === n)) return res.status(409).json({ error: `shot ${n} is already rendering`, code: 'busy' });
        const bn = dv.payload.shots[n - 1].boardShot || n;
        const x = { ...dv.payload.shots[n - 1], keyframe: dv.payload.shots[n - 1].keyframe || (dv.payload.shots[n - 1].textPrompt ? null : bshots[bn - 1] && bshots[bn - 1].keyframe) };
        if (!x.keyframe && !x.textPrompt) return res.status(409).json({ error: `shot ${n} has no keyframe`, code: 'no_keyframe' });
        const [job] = await insertRows('jobs', [clipJob(dv.id, x, String(b.changes || '').trim())], { returning: true });
        if (ds.state !== 'generating') await patchRows('stages', `id=eq.${encodeURIComponent(ds.id)}`, { state: 'generating' });
        await jobsSvc.advance(job).catch(() => null);
        const fresh = await jobsSvc.getJob(job.id);
        return res.status(200).json({ ok: true, shot: n, job: jobsSvc.publicJob(fresh || job, legacyId) });
      }
      const aspect = draftAspect;
      let shots = bshots.filter(kfRendered).map((x, i) => ({ n: i + 1, boardShot: x.n, durationS: x.durationS, type: x.type, camera: x.camera, action: x.action, product: x.product, onScreenText: x.onScreenText, line: x.line, audioCue: x.audioCue, transition: x.transition, keyframe: { url: x.keyframe.url || null, assetPath: x.keyframe.assetPath || null, sha256: x.keyframe.sha256 || null, jobId: x.keyframe.jobId || null }, clipDurationS: clipDuration(x), clip: null, review: null }));
      if (!shots.length) {
        // no storyboard: one clip for the whole video, from the brief (or the campaign plan when there is no brief)
        const brief0 = await boardMod.briefFor(piece.id);
        const sp = brief0 && brief0.payload && brief0.payload.spec;
        const hook = sp && sp.trendHook ? sp.trendHook.mechanic || sp.trendHook.description || '' : '';
        const targetS = Math.min(15, Math.max(5, Math.round(Number(sp && sp.format && sp.format.targetDurationS) || 10)));
        const textPrompt = [
          `A ${targetS}-second ${aspect === '9:16' ? 'vertical ' : ''}social video for Samsung ${piece.product || ''}.`,
          sp ? `Key message: ${sp.keyMessage || ''}.${hook ? ` Hook: ${hook}.` : ''}${sp.cta ? ` End on: ${sp.cta}.` : ''}` : `Key message: ${piece.key_message || piece.title || ''}.${piece.angle ? ` Angle: ${piece.angle}.` : ''}`,
          piece.trend_name ? `Inspired by the trend "${piece.trend_name}".` : '',
          'The device looks exactly like the real product: no morphing, no extra buttons, no invented logos. No on-screen text, no captions.',
        ].filter(Boolean).join(' ');
        shots = [{ n: 1, boardShot: null, durationS: targetS, type: 'full', camera: '', action: '', product: { visible: true }, onScreenText: null, line: null, audioCue: null, transition: 'none', keyframe: null, textPrompt, clipDurationS: targetS, clip: null, review: null }];
      }
      const totalS = Math.round(shots.reduce((a, x) => a + (Number(x.durationS) || 0), 0) * 10) / 10;
      const artifact = { shots, totalS, aspect, resolution, fromStoryboard: bshots.length > 0, boardVersionId: bshots.length ? bv.id : null, boardVersion: bshots.length ? bv.version : null, boardApproved: bshots.length ? bs.state === 'approved' : null, skippedShots, dur: `${totalS}s`, audio: 'Native audio per clip (Hermes video bot); loudness normalised at assembly', variants: [{ a: aspect, l: resolution, k: 'original', st: 'rendering' }], videoUrl: null, assembled: null, prompt: bshots.length ? `first draft from storyboard v${bv.version}: ${shots.length} clips` : shots[0].textPrompt, note: `${bshots.length ? 'One clip per storyboard shot from the Hermes video bot, driven by its keyframe; the clips join into one video by themselves.' : 'One clip for the whole video from the Hermes video bot (no storyboard).'}${skippedShots.length ? ` Storyboard shot${skippedShots.length > 1 ? 's' : ''} ${skippedShots.join(', ')} left out: the keyframe failed.` : ''}`, draftVersion: 'draft-v1-2026-10-21', rev: 0 };
      const out = await recordVersion(legacyId, 'draft', artifact, { piece: b.piece || {}, producedBy: 'hermes', kind: 'video', generatedBy: req.member ? req.member.id : null });
      const inserted = await insertRows('jobs', shots.map((x) => clipJob(out.versionId, x, '')), { returning: true });
      await patchRows('stages', `id=eq.${encodeURIComponent(ds.id)}`, { state: 'generating' });
      const jobs = [];
      for (const j of inserted) { await jobsSvc.advance(j).catch(() => null); const fresh = await jobsSvc.getJob(j.id); jobs.push(jobsSvc.publicJob(fresh || j, legacyId)); }
      try { const { syncSpec } = require('../_spec.js'); await syncSpec(legacyId, { memberId: req.member ? req.member.id : null, note: 'first draft clips queued' }); } catch (e) { /* best effort */ }
      return res.status(200).json({ ok: true, artifact: { ...artifact, version: `v${out.version}` }, version: out.version, versionId: out.versionId, jobs });
    }
    if (b.action === 'board') {
      // owner 2026-10-29: no step waits for another; without a brief the shot list is written from the campaign plan
      const brief = (await boardMod.briefFor(piece.id)) || { approved: false, versionId: null, version: null, payload: { objective: piece.title, msg: piece.key_message || '', mandatories: [] }, fromPlan: true };
      const bctx = await briefMod.briefContext(piece, legacyId);
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
        return { piece_id: piece.id, stage_id: stageRow.id, kind: 'hermes_image', state: 'queued', attempts: 0, next_poll_at: new Date().toISOString(), payload: { pieceId: legacyId, stage: 'board', prompt, aspect_ratio: aspect, resolution: '1080p', seed: newSeed(), ...(useRef ? { ref: refImage } : {}), autoCheck: true, attachTo: { versionId: out.versionId, shot: shot.n }, generatedBy: req.member ? req.member.id : null, meta: { shot: shot.n, prompt, anchors, direction: bctx.mood.direction || null, product: piece.product, productLook: bits.productLook, rules: bits.rules, expectProduct: shot.product.visible, hookCheck: shot.n === w.list.hookShot, title: piece.title } } };
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
      if (b.action === 'brief') {
        // the Hermes brief bot writes it: Maistro's brief rules + the approved context + the contract to fill;
        // the job validates, records and checks the result exactly like a Studio brief
        const job = await createJob({ legacyId, stage: 'brief', kind: 'hermes_brief', payload: { system: briefMod.SYSTEM, context: briefMod.userMessage(piece, ctx, b.userInput), schema: briefMod.SCHEMA, userInput: b.userInput ? String(b.userInput).slice(0, 2000) : null }, piece: b.piece || {}, member: req.member });
        return res.status(200).json({ ok: true, job, moodApproved: ctx.mood.approved, approvedClaims: ctx.approvedClaims.length });
      }
      const problems = briefMod.validateShape(b.spec);
      if (problems.length) return res.status(422).json({ error: 'edited brief is incomplete', problems });
      const brief = b.spec;
      const meta = { promptVersion: b.briefVersion || briefMod.VERSION, moodApproved: ctx.mood.approved, thumbApproved: Boolean(ctx.thumb && ctx.thumb.approved), editedBy: req.member ? req.member.id : 'password-session' };
      const artifact = briefMod.artifactFrom(brief, piece, meta);
      const out = await recordVersion(legacyId, 'brief', artifact, { piece: b.piece || {}, producedBy: 'manual', kind: 'text', generatedBy: req.member ? req.member.id : null });
      let checks = null;
      try { checks = await recordBriefChecks({ piece, legacyId, versionId: out.versionId, brief, ctx, member: req.member }); } catch (e) { checks = { error: String(e.message || e).slice(0, 200) }; }
      try { const { syncSpec } = require('../_spec.js'); await syncSpec(legacyId, { memberId: req.member ? req.member.id : null, note: 'brief edited' }); } catch (e) { /* best effort */ }
      return res.status(200).json({ ok: true, artifact, version: out.version, versionId: out.versionId, checks, moodApproved: ctx.mood.approved, approvedClaims: ctx.approvedClaims.length });
    }
    if (b.action === 'thumb') {
      const mood = await thumb.moodContext(piece.id);
      const aspect = thumb.aspectFor(piece.platforms);
      const refImage = typeof b.refImage === 'string' && /^https:\/\//.test(b.refImage) ? b.refImage : null;
      const tp = await thumb.thumbPrompt({ piece: meta, mood, productLook: bits.productLook, rules: bits.rules, userInput: b.userInput, refAttached: Boolean(refImage), aspect, memberId: req.member ? req.member.id : null });
      if (!tp.prompt) return res.status(502).json({ error: tp.error, problems: tp.problems || [] });
      const overlay = { headline: String(b.headline || '').slice(0, 120), headlineAr: String(b.headlineAr || '').slice(0, 120), side: tp.textSide, box: thumb.overlayBox(aspect, tp.textSide), aspect };
      const anchors = mood.tiles.filter((t) => t.assetPath || t.url).slice(0, 4).map((t) => ({ index: t.index, url: t.url || null, assetPath: t.assetPath || null }));
      const job = await createJob({ legacyId, stage: 'thumb', kind: 'hermes_image', payload: { prompt: tp.prompt, aspect_ratio: aspect, resolution: '1080p', ...(refImage ? { ref: refImage } : {}), autoCheck: true, meta: { prompt: tp.prompt, note: tp.note, title: piece.title, sub: piece.key_message || '', textSide: tp.textSide, overlay, promptVersion: tp.promptVersion, product: piece.product, productLook: bits.productLook, rules: bits.rules, anchors, moodApproved: mood.approved } }, piece: b.piece || {}, member: req.member });
      return res.status(200).json({ ok: true, prompt: tp.prompt, textSide: tp.textSide, note: tp.note, aspect, overlay, moodApproved: mood.approved, anchors: anchors.length, job });
    }
    const trend = piece.trend_name ? { name: piece.trend_name, id: piece.trend_id } : null;
    const dir = await visualDirection({ piece: meta, trend, userInput: b.userInput, productLook: bits.productLook, rules: bits.rules, palette: bits.palette, memberId: req.member ? req.member.id : null });
    if (!dir.direction) return res.status(502).json({ error: dir.error, problems: dir.problems || [] });
    const d = dir.direction;
    // the moodboard bot renders ONE prompt as a set of four, so the set is four
    // VARIATIONS of the whole direction (not one image per tile brief); the
    // tile briefs stay on the direction as text. The product is expected in
    // every variation exactly when the catalog has a look line for it.
    const prompt = setPrompt(d, bits.productLook);
    const job = await createJob({ legacyId, stage: 'mood', kind: 'hermes_image', payload: { prompt, aspect_ratio: '4:3', resolution: '1080p', batch: TILES, autoCheck: true, meta: { prompt, note: `${d.leadingPrinciple} · ${d.mood}`, direction: d, directionVersion: dir.promptVersion, setMode: 'variations', expectProduct: Boolean(bits.productLook), product: piece.product, productLook: bits.productLook, rules: bits.rules } }, piece: b.piece || {}, member: req.member });
    return res.status(200).json({ ok: true, direction: d, promptVersion: dir.promptVersion, job });
  } catch (e) {
    if (e instanceof StoreError) return res.status(e.status).json({ error: e.message, code: e.code });
    return res.status(e && e.status ? e.status : 502).json({ error: String((e && e.message) || e) });
  }
};
