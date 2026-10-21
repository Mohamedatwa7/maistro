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
//   GET  ?checks=<pieceId>&stage=<kind>  (session) → the stored checks for the
//       stage's current version
const { requireSession, refreshMember } = require('../_auth.js');
const { createJob, StoreError } = (() => { const j = require('../_jobs.js'); const s = require('../_store.js'); return { createJob: j.createJob, StoreError: s.StoreError }; })();
const { ensurePiece } = require('../_store.js');
const { visualDirection, setPrompt, TILES } = require('../_studio/mood.js');
const thumb = require('../_studio/thumb.js');
const storage = require('../_adapters/storage.js');
const { recordVersion } = require('../_store.js');
const { activeDocuments, getDocument } = require('../_kb/index.js');
const { queryRows } = require('../_supabase.js');

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
      if (!q.checks) return res.status(400).json({ error: 'checks=<pieceId> is required' });
      const [piece] = await queryRows('content_pieces', `select=id&legacy_id=eq.${encodeURIComponent(String(q.checks))}&limit=1`);
      if (!piece) return res.status(404).json({ error: 'piece not found' });
      const stages = await queryRows('stages', `select=id,kind,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}${q.stage ? `&kind=eq.${encodeURIComponent(String(q.stage))}` : ''}`);
      const vids = stages.map((s) => s.current_version_id).filter(Boolean);
      const checks = vids.length ? await queryRows('stage_checks', `select=*&artifact_version_id=in.(${vids.map(encodeURIComponent).join(',')})&order=at.desc&limit=50`) : [];
      return res.status(200).json({ count: checks.length, checks: checks.map((c) => ({ ...c, stage: (stages.find((s) => s.current_version_id === c.artifact_version_id) || {}).kind })) });
    }
    if (!(await refreshMember(req, res))) return;
    const b = req.body || {};
    if (!['mood', 'thumb', 'thumb-composite'].includes(b.action)) return res.status(400).json({ error: 'action must be mood, thumb or thumb-composite' });
    const legacyId = String(b.pieceId || '');
    if (b.action === 'thumb-composite') {
      const data = String(b.data || '');
      if (!data) return res.status(422).json({ error: 'data (base64 PNG) is required' });
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || bytes.length > 3 * 1024 * 1024) return res.status(413).json({ error: 'composite must be under 3 MB' });
      if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return res.status(422).json({ error: 'data must be a PNG' });
      const ov = b.overlay && typeof b.overlay === 'object' ? b.overlay : {};
      const overlay = { headline: String(ov.headline || '').slice(0, 120), headlineAr: String(ov.headlineAr || '').slice(0, 120), side: ov.side === 'right' ? 'right' : 'left', aspect: ['9:16', '16:9', '1:1'].includes(ov.aspect) ? ov.aspect : '16:9', font: String(ov.font || 'system-ui').slice(0, 60), box: ov.box && typeof ov.box === 'object' ? ov.box : null, baseAssetPath: typeof ov.baseAssetPath === 'string' ? ov.baseAssetPath.slice(0, 200) : null };
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
