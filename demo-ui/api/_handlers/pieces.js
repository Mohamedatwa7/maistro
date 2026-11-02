// /api/pieces — the campaign store seen from the website (M2 part 2).
//
//   GET            → { count, pieces:[…] }  every piece with its stages,
//                    current version payloads and latest decisions.
//   POST           → record a stage version pushed by the legacy page
//                    (write-through sync): { pieceId, stage, artifact,
//                    piece?: {title, product, msg, angle, markets, platforms,
//                    trendId, trendName, origin}, producedBy?, kind? }
//                    → { ok, pieceId, stage, versionId, version, state }
//
// Both need the session. An approved stage refuses new versions (409
// approved_immutable) — that is the audit's A-04/A-05 rule, now enforced
// where the data lives.
const { requireSession, refreshMember } = require('../_auth.js');
const { listPieces, recordVersion, getPiece, StoreError } = require('../_store.js');
const { queryRows, patchRows, insertRows } = require('../_supabase.js');
const { validateArtifact } = require('../_schemas.js');
const { STAGE_KINDS } = require('../../src/domain/stages.js');

const MAX_PAYLOAD = 256 * 1024;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!requireSession(req, res)) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'storage is not configured' });
  if (req.method === 'POST' && !(await refreshMember(req, res))) return;
  try {
    if (req.method === 'GET') {
      const pieces = await listPieces(Number((req.query || {}).limit) || 100);
      return res.status(200).json({ count: pieces.length, pieces });
    }
    const b = req.body || {};
    const stage = String(b.stage || '');
    if (!STAGE_KINDS.includes(stage)) return res.status(400).json({ error: `unknown stage "${stage}" — expected one of ${STAGE_KINDS.join(', ')}` });
    if (b.artifact == null) return res.status(400).json({ error: 'missing artifact' });
    if (Buffer.byteLength(JSON.stringify(b.artifact), 'utf8') > MAX_PAYLOAD) return res.status(413).json({ error: `artifact larger than ${MAX_PAYLOAD} bytes` });
    // Documented stage shapes are validated like an ingest push; `draft` is the
    // Studio's first cut (same shape as final) and is checked as such.
    const invalid = validateArtifact(stage === 'draft' ? 'final' : stage, b.artifact);
    if (invalid) return res.status(422).json({ error: invalid.message, problems: invalid.problems });
    // owner 2026-11-02: the campaign's product is locked once anything is approved, and never changes silently.
    // A re-plan before that may change it: the piece follows the plan, and the change is on the audit log.
    const newProduct = stage === 'plan' && b.artifact && typeof b.artifact.product === 'string' ? b.artifact.product.trim().slice(0, 200) : '';
    const before = newProduct ? await getPiece(String(b.pieceId || '')) : null;
    if (before && before.product && before.product !== newProduct && !/^planning/i.test(before.product)) {
      const st = await queryRows('stages', `select=kind,state&piece_id=eq.${encodeURIComponent(before.id)}&state=eq.approved&limit=1`);
      if (st.length) return res.status(409).json({ error: `the product is locked to ${before.product} (the ${st[0].kind} is approved); start a new campaign to use ${newProduct}`, code: 'product_locked' });
    }
    const out = await recordVersion(String(b.pieceId || ''), stage, b.artifact, { piece: b.piece || {}, producedBy: b.producedBy, kind: b.kind, generatedBy: req.member ? req.member.id : null });
    // a new campaign is created with the page's placeholder ("Planning…"): the plan's product replaces it too
    const now = newProduct ? before || (await getPiece(String(b.pieceId || ''))) : null;
    if (now && now.product !== newProduct) {
      await patchRows('content_pieces', `id=eq.${encodeURIComponent(now.id)}`, { product: newProduct });
      try { await insertRows('audit_log', [{ actor: req.member ? req.member.id : null, action: 'piece.product', entity: 'content_piece', entity_id: now.id, before: { product: now.product }, after: { product: newProduct, planVersion: out.version } }]); } catch (e) { /* best effort */ }
      out.productChanged = { from: now.product, to: newProduct };
    }
    // 6.1: the Creative Spec follows the store (best effort)
    try { const { syncSpec } = require('../_spec.js'); out.spec = await syncSpec(out.legacyId, { memberId: req.member ? req.member.id : null, note: `${stage} v${out.version}` }); } catch (e) { console.warn('[pieces] spec sync failed:', e.message); }
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof StoreError) return res.status(e.status).json({ error: e.message, code: e.code });
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
