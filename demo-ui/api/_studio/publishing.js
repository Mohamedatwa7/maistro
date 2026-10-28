// 8b — publishing (ADR-008): a PublishingAdapter with the manual/export adapter by default and a Sprinklr
// drafts adapter once SPRINKLR_* credentials are set and SPRINKLR_DRAFTS=1. In drafts mode an export also creates
// the Sprinklr draft (sprinklr/client.js, built from the vendored v3 spec); a person schedules it in Sprinklr, so
// Maistro never puts a post live. Slots live in publishing_slots (migration 019, Sprinklr columns 023); without
// it every call is a 503.
const { queryRows, queryAll, insertRows, patchRows } = require('../_supabase.js');
const sprinklr = require('./sprinklr/client.js');
const { buildDraft, campaignId } = require('./sprinklr/draft.js');

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
  get connected() { return sprinklr.config().configured; },
  // drafts mode needs the credentials, the owner's opt-in and a campaign to file the drafts under
  get enabled() { return this.connected && process.env.SPRINKLR_DRAFTS === '1' && Boolean(campaignId()); },
  label: 'Sprinklr: drafts only — export creates the Sprinklr draft; schedule it in Sprinklr (Maistro never posts)',
  // the slot's draft: created once (a repeated export reuses it); a failure is recorded on the slot, not thrown
  async publish({ slot, piece }) {
    if (slot.sprinklr_draft_id) return { sprinklr: { draftId: slot.sprinklr_draft_id, reused: true } };
    let draftId = null, error = null, code = null;
    try {
      const built = buildDraft({ slot, piece, ...(await finalMedia(piece.id)) });
      if (built.error) ({ error, code } = built);
      else draftId = await sprinklr.createDraft(built.message);
    } catch (e) { error = e.message; code = e.code || 'sprinklr_error'; }
    await patchRows('publishing_slots', `id=eq.${encodeURIComponent(slot.id)}`, draftId ? { sprinklr_draft_id: draftId, sprinklr_error: null } : { sprinklr_error: `${code}: ${error}`.slice(0, 500) });
    return { sprinklr: draftId ? { draftId } : { error, code } };
  },
};
const adapter = () => (SprinklrAdapter.enabled ? SprinklrAdapter : ManualExportAdapter);
// manual mode with Sprinklr connected for reading (the Calendar shows the accounts' posts) but drafts not on yet
const READ_ONLY_LABEL = 'Sprinklr: connected, read-only — drafts not on yet (export the package, post by hand, then link the published post)';
const modeLabel = () => (adapter() === ManualExportAdapter && SprinklrAdapter.connected ? READ_ONLY_LABEL : adapter().label);

/** signed URLs (7 days, like the delivery package) for the approved final's video and the thumbnail */
async function finalMedia(pieceId) {
  const storage = require('../_adapters/storage.js');
  const st = await queryRows('stages', `select=kind,current_version_id&piece_id=eq.${encodeURIComponent(pieceId)}&kind=in.(final,thumb)`);
  const payload = async (k) => { const s = st.find((x) => x.kind === k); if (!s || !s.current_version_id) return null; const [v] = await queryRows('artifact_versions', `select=payload&id=eq.${encodeURIComponent(s.current_version_id)}&limit=1`); return v ? v.payload : null; };
  const fin = await payload('final'), th = await payload('thumb');
  const sign = async (p) => { if (!p) return null; try { return await storage.signedUrl(p, 7 * 24 * 3600); } catch (e) { return null; } };
  return { videoUrl: await sign(fin && fin.assembled && fin.assembled.assetPath), thumbUrl: await sign(th && th.assetPath), durationS: fin && fin.assembled ? fin.assembled.durationS : undefined };
}

function slotView(s, piece) {
  return { id: s.id, pieceId: piece ? piece.legacy_id : null, title: piece ? piece.title : null, platform: s.platform, account: s.account, slotAt: s.slot_at, caption: s.caption, mode: s.mode, status: s.status, createdBy: s.created_by_label, exportedAt: s.exported_at, postedAt: s.posted_at, piecePostId: s.piece_post_id, canceledAt: s.canceled_at, cancelReason: s.cancel_reason, sprinklrDraftId: s.sprinklr_draft_id || null, sprinklrStatus: s.sprinklr_status || null, sprinklrCheckedAt: s.sprinklr_checked_at || null, sprinklrError: s.sprinklr_error || null };
}
const sprinklrView = () => ({ configured: SprinklrAdapter.connected, drafts: SprinklrAdapter.enabled, livePublishing: false });

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
    // the composer previews the real post: the final's video and the thumbnail, signed for this read
    const media = new Map(await Promise.all([...new Set([...finals.map((f) => f.piece_id), ...slots.filter((s) => s.status !== 'canceled').map((s) => s.piece_id)])]
      .map(async (id) => { try { const m = await finalMedia(id); return [id, { videoUrl: m.videoUrl, thumbUrl: m.thumbUrl }]; } catch (e) { return [id, null]; } })));
    const unscheduled = finals.filter((f) => !open.has(f.piece_id)).map((f) => { const p = byId.get(f.piece_id) || {}; return { pieceId: p.legacy_id, title: p.title, product: p.product, platforms: p.platforms || [], markets: p.markets || [], trend: p.trend_name, postBy: postBy[p.trend_id] || null, media: media.get(f.piece_id) || null }; })
      .sort((a, b) => String(a.postBy || '9').localeCompare(String(b.postBy || '9')));
    return { status: 200, body: { mode: adapter().mode, connected: adapter().connected, label: modeLabel(), sprinklrConfigured: SprinklrAdapter.connected, sprinklr: sprinklrView(), owned: Object.fromEntries(Object.entries(ownedByPlatform()).map(([k, v]) => [k, [...v]])), slots: slots.map((s) => ({ ...slotView(s, byId.get(s.piece_id)), media: media.get(s.piece_id) || null })), unscheduled } };
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
    const out = to === 'exported' ? await adapter().publish({ slot: rows[0], piece }) : {};
    const [slot] = out.sprinklr ? await queryRows('publishing_slots', `select=*&id=eq.${encodeURIComponent(rows[0].id)}&limit=1`) : rows;
    return { status: 200, body: { ok: true, slot: slotView(slot || rows[0], piece), ...out } };
  } catch (e) { if (storageMissing(e)) return MISSING; throw e; }
}

/** the slot's Sprinklr draft: its status (recorded on the slot) and, with preview, a rendered preview of it */
async function draftCheck({ piece, id, member, preview, previewId }) {
  if (member && !PLANNERS.includes(member.role)) return { status: 403, body: { error: 'only a line manager or admin can check a Sprinklr draft', code: 'role_required' } };
  if (!SprinklrAdapter.connected) return { status: 409, body: { error: 'Sprinklr is not configured', code: 'sprinklr_not_configured' } };
  try {
    const [slot] = await queryRows('publishing_slots', `select=*&id=eq.${encodeURIComponent(id)}&piece_id=eq.${encodeURIComponent(piece.id)}&limit=1`);
    if (!slot) return { status: 404, body: { error: 'no planned post with that id on this piece' } };
    if (!slot.sprinklr_draft_id) return { status: 409, body: { error: 'this planned post has no Sprinklr draft yet — export it in drafts mode', code: 'no_draft' } };
    const d = await sprinklr.getDraft(slot.sprinklr_draft_id);
    const status = d && d.status ? String(d.status) : null;
    const [row] = await patchRows('publishing_slots', `id=eq.${encodeURIComponent(slot.id)}`, { sprinklr_status: status, sprinklr_checked_at: new Date().toISOString() });
    let pv = null;
    if (preview) pv = previewId ? await sprinklr.previewStatus(String(previewId)) : { id: await sprinklr.previewGenerate(slot.sprinklr_draft_id), status: 'requested', url: null };
    return { status: 200, body: { ok: true, slot: slotView(row || slot, piece), draft: { id: slot.sprinklr_draft_id, status, scheduleDate: d && d.scheduleDate ? new Date(d.scheduleDate).toISOString() : null }, ...(pv ? { preview: pv } : {}) } };
  } catch (e) {
    if (storageMissing(e)) return MISSING;
    if (/^sprinklr_/.test(e.code || '')) return { status: e.status || 502, body: { error: e.message, code: e.code } };
    throw e;
  }
}

/** read-only credential check (GET /me) */
async function sprinklrCheck() {
  if (!SprinklrAdapter.connected) return { status: 200, body: { ...sprinklrView(), ok: false, error: 'not configured' } };
  try { return { status: 200, body: { ...sprinklrView(), ok: true, me: await sprinklr.me() } }; }
  catch (e) { return { status: 200, body: { ...sprinklrView(), ok: false, error: e.message, code: e.code } }; }
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

/** what the owned accounts posted and have lined up in Sprinklr (read-only, sprinklr/feed.js) */
async function sprinklrFeed({ from, to }) {
  if (!SprinklrAdapter.connected) return { status: 200, body: { configured: false, items: [] } };
  try { return { status: 200, body: { configured: true, ...(await require('./sprinklr/feed.js').feed({ from: Date.parse(from), to: Date.parse(to) })) } }; }
  catch (e) { return { status: 200, body: { configured: true, items: [], error: e.message, code: e.code || 'sprinklr_error' } }; }
}

module.exports = { calendar, plan, setStatus, draftCheck, sprinklrCheck, sprinklrFeed, markPosted, ManualExportAdapter, SprinklrAdapter, adapter, storageMissing };
