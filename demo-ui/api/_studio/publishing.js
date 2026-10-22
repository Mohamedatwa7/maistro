// 8b — publishing (ADR-008): a PublishingAdapter with the manual/export adapter active and a Sprinklr adapter
// gated by SPRINKLR_* credentials. Sprinklr's developer documentation is not public (no access yet), so the
// Sprinklr adapter makes no calls: it answers "not configured" until the contract is confirmed against the real
// API — no guessed endpoints. Slots live in publishing_slots (migration 019); without it every call is a 503.
const { queryRows, queryAll, insertRows, patchRows } = require('../_supabase.js');

const PLANNERS = ['admin', 'line_manager'];
const PLATFORMS = ['tiktok', 'instagram', 'facebook', 'x'];
const who = (m) => (m ? m.name || m.email || m.id : require('../_auth.js').PASSWORD_CLAIM);
function storageMissing(e) {
  const m = String((e && e.message) || e);
  return /publishing_slots/.test(m) && /PGRST205|42P01|schema cache|does not exist|\(404\)/.test(m);
}
const MISSING = { status: 503, body: { error: 'publishing storage not migrated (db/migrations/019_publishing_slots.sql)', code: 'not_migrated' } };
// owned accounts per platform, the same list R-8 uses ("platform:account,…")
function ownedByPlatform() {
  const out = {};
  for (const x of String(process.env.MAISTRO_OWNED_ACCOUNTS || 'tiktok:samsunggulf,instagram:samsunggulf,facebook:samsunggulf,x:samsunggulf').toLowerCase().split(',')) {
    const [p, a] = x.trim().split(':'); if (p && a) (out[p === 'twitter' ? 'x' : p] = out[p === 'twitter' ? 'x' : p] || new Set()).add(a.replace(/^@/, ''));
  }
  return out;
}

const ManualExportAdapter = {
  mode: 'manual_export',
  connected: false,
  label: 'Sprinklr: not connected — manual mode (export the package, post by hand, then link the published post)',
  // the operator posts; Maistro only records the plan, the export and, via "Published as", the post
  async publish() { return { manual: true, instruction: 'Export the delivery package, post it from the account at the slot time, then link the published post on the final ("Published as").' }; },
};
const SprinklrAdapter = {
  mode: 'sprinklr',
  get connected() { return Boolean(process.env.SPRINKLR_API_KEY && process.env.SPRINKLR_API_SECRET && process.env.SPRINKLR_ENV); },
  async publish() { const e = new Error('Sprinklr publishing is not implemented: the API contract must be confirmed against Sprinklr\'s developer documentation once access is granted'); e.status = 501; e.code = 'sprinklr_not_implemented'; throw e; },
};
// Sprinklr is used only when it is both configured and implemented; today it is neither
const adapter = () => ManualExportAdapter;

function slotView(s, piece) {
  return { id: s.id, pieceId: piece ? piece.legacy_id : null, title: piece ? piece.title : null, platform: s.platform, account: s.account, slotAt: s.slot_at, caption: s.caption, mode: s.mode, status: s.status, createdBy: s.created_by_label, exportedAt: s.exported_at, postedAt: s.posted_at, piecePostId: s.piece_post_id, canceledAt: s.canceled_at, cancelReason: s.cancel_reason };
}

/** GET ?calendar=1: slots in [from, to) plus approved finals with no open slot, each with its trend's post-by date */
async function calendar({ from, to }) {
  try {
    const q = [`select=*`, `order=slot_at.asc,id.asc`];
    if (from) q.push(`slot_at=gte.${encodeURIComponent(from)}`);
    const slots = (await queryAll('publishing_slots', q.join('&'))).filter((s) => !to || String(s.slot_at) < String(to));
    const finals = await queryAll('stages', 'select=piece_id,state&kind=eq.final&state=eq.approved&order=id.asc');
    const pids = [...new Set([...slots.map((s) => s.piece_id), ...finals.map((f) => f.piece_id)])];
    const pieces = pids.length ? await queryAll('content_pieces', `select=id,legacy_id,title,product,platforms,markets,trend_id,trend_name&id=in.(${pids.map(encodeURIComponent).join(',')})&order=id.asc`) : [];
    const byId = new Map(pieces.map((p) => [p.id, p]));
    const open = new Set(slots.filter((s) => s.status !== 'canceled').map((s) => s.piece_id));
    const tids = [...new Set(pieces.map((p) => p.trend_id).filter(Boolean))];
    const scores = tids.length ? await queryAll('trend_scores', `select=trend_id,post_by,at&trend_id=in.(${tids.map(encodeURIComponent).join(',')})&order=at.desc,id.desc`) : [];
    const postBy = {}; for (const s of scores) if (s.post_by && !postBy[s.trend_id]) postBy[s.trend_id] = s.post_by;
    const unscheduled = finals.filter((f) => !open.has(f.piece_id)).map((f) => { const p = byId.get(f.piece_id) || {}; return { pieceId: p.legacy_id, title: p.title, product: p.product, platforms: p.platforms || [], markets: p.markets || [], trend: p.trend_name, postBy: postBy[p.trend_id] || null }; })
      .sort((a, b) => String(a.postBy || '9').localeCompare(String(b.postBy || '9')));
    return { status: 200, body: { mode: adapter().mode, connected: adapter().connected, label: adapter().label, sprinklrConfigured: SprinklrAdapter.connected, owned: Object.fromEntries(Object.entries(ownedByPlatform()).map(([k, v]) => [k, [...v]])), slots: slots.map((s) => slotView(s, byId.get(s.piece_id))), unscheduled } };
  } catch (e) { if (storageMissing(e)) return MISSING; throw e; }
}

async function plan({ piece, b, member }) {
  if (member && !PLANNERS.includes(member.role)) return { status: 403, body: { error: 'only a line manager or admin can plan a post', code: 'role_required' } };
  const [fin] = await queryRows('stages', `select=state&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.final&limit=1`);
  if (!fin || fin.state !== 'approved') return { status: 409, body: { error: 'plan a post only after the final is approved', code: 'final_not_approved' } };
  const platform = String(b.platform || '').toLowerCase(), account = String(b.account || '').trim().replace(/^@/, '').toLowerCase();
  if (!PLATFORMS.includes(platform)) return { status: 422, body: { error: `platform must be one of ${PLATFORMS.join(', ')}` } };
  const owned = ownedByPlatform()[platform];
  if (!owned || !owned.has(account)) return { status: 422, body: { error: `${account || 'that account'} is not an owned ${platform} account`, code: 'not_owned' } };
  const at = Date.parse(b.slotAt);
  if (!Number.isFinite(at)) return { status: 422, body: { error: 'slotAt must be a date-time' } };
  try {
    const [row] = await insertRows('publishing_slots', [{ piece_id: piece.id, platform, account, slot_at: new Date(at).toISOString(), caption: b.caption ? String(b.caption).slice(0, 2200) : null, mode: adapter().mode, status: 'planned', created_by: member ? member.id : null, created_by_label: who(member) }], { returning: true });
    try { await insertRows('audit_log', [{ actor: member ? member.id : null, action: 'publishing.plan', entity: 'content_piece', entity_id: piece.id, after: { slotId: row && row.id, platform, account, slotAt: new Date(at).toISOString() } }]); } catch (e) { /* best effort */ }
    return { status: 200, body: { ok: true, slot: slotView(row, piece) } };
  } catch (e) { if (storageMissing(e)) return MISSING; throw e; }
}

async function setStatus({ piece, id, to, member, reason }) {
  if (member && !PLANNERS.includes(member.role)) return { status: 403, body: { error: 'only a line manager or admin can change a planned post', code: 'role_required' } };
  const from = 'status=in.(planned,exported)'; // an export can be repeated; a posted or canceled slot is closed
  const patch = to === 'exported' ? { status: 'exported', exported_at: new Date().toISOString() } : { status: 'canceled', canceled_at: new Date().toISOString(), cancel_reason: reason ? String(reason).slice(0, 280) : null };
  try {
    const rows = await patchRows('publishing_slots', `id=eq.${encodeURIComponent(id)}&piece_id=eq.${encodeURIComponent(piece.id)}&${from}`, patch);
    if (!rows.length) return { status: 404, body: { error: 'no open planned post with that id on this piece' } };
    return { status: 200, body: { ok: true, slot: slotView(rows[0], piece), ...(to === 'exported' ? await adapter().publish() : {}) } };
  } catch (e) { if (storageMissing(e)) return MISSING; throw e; }
}

/** called when a published post is linked: the piece's earliest open slot on that platform becomes posted */
async function markPosted({ pieceId, platform, piecePostId }) {
  try {
    const open = await queryRows('publishing_slots', `select=id&piece_id=eq.${encodeURIComponent(pieceId)}&platform=eq.${platform}&status=in.(planned,exported)&order=slot_at.asc&limit=1`);
    if (!open.length) return null;
    const rows = await patchRows('publishing_slots', `id=eq.${open[0].id}`, { status: 'posted', posted_at: new Date().toISOString(), piece_post_id: piecePostId });
    return rows[0] || null;
  } catch (e) { if (storageMissing(e)) return null; throw e; }
}

module.exports = { calendar, plan, setStatus, markPosted, ManualExportAdapter, SprinklrAdapter, adapter, storageMissing };
