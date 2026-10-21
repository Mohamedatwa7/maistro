// POST /api/decisions — approve or reject a stage's current version (M2 part
// 2, AUDIT A-05). The server, not the page, decides whether the decision is
// allowed: src/domain/stages.js runs the transition and api/_store.js writes
// the immutable approvals row (one "approved" per version is a database rule).
//
// Body: { pieceId, stage, decision: "approved"|"rejected", name, role, info?,
//         reason?, documents?: { line_manager: {path,sha256,size,contentType,name,at},
//                                 adlcp: {…} } }   // final approvals only
// → 200 { ok, pieceId, stage, versionId, version, state, approvalId, decidedAt }
//   409 { error, code }   when the domain refuses (documents_required,
//                         role_required, self_approval, not_reviewable, …)
//
// { action: "reopen", pieceId, stage, role } reopens an approved stage (admin).
const { requireSession } = require('../_auth.js');
const { decide, reopen, StoreError } = require('../_store.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!requireSession(req, res)) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'storage is not configured' });
  const b = req.body || {};
  try {
    const actorId = req.member ? req.member.id : null;
    const role = req.member && req.member.role ? req.member.role : b.role; // a real member's role outranks the claimed one
    if (b.action === 'reopen') {
      const out = await reopen(String(b.pieceId || ''), String(b.stage || ''), role);
      return res.status(200).json({ ok: true, ...out });
    }
    const out = await decide(String(b.pieceId || ''), String(b.stage || ''), { ...b, role, actorId });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof StoreError) return res.status(e.status).json({ error: e.message, code: e.code });
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
