// 7.5 attribution — link an approved final to the post it became (PERFORMANCE_INSIGHTS.md §5).
// Until Sprinklr returns post ids, a line manager or admin pastes the post URL; it is resolved to the tracker's
// post the same way the reader resolves aliases, and only an owned account's post can be linked (R-8). No fuzzy
// matching makes a link. Storage is piece_posts (migration 018); without it every call answers 503.
const { queryRows, insertRows, patchRows } = require('../_supabase.js');

// PostgREST before the migration: 404 PGRST205 "Could not find the table 'public.piece_posts' in the schema cache"
// (older versions: 42P01 relation does not exist)
function storageMissing(e) {
  const m = String((e && e.message) || e);
  return /piece_posts/.test(m) && /PGRST205|42P01|schema cache|does not exist|\(404\)/.test(m);
}
const MISSING = { status: 503, body: { error: 'attribution storage not migrated (db/migrations/018_piece_posts.sql)', code: 'not_migrated' } };
const LINKERS = ['admin', 'line_manager'];
const who = (member) => (member ? member.name || member.email || member.id : 'password session (no member sign-in)');

async function list(pieceId) {
  try {
    const rows = await queryRows('piece_posts', `select=*&piece_id=eq.${encodeURIComponent(pieceId)}&order=linked_at.desc&limit=200`);
    return { status: 200, body: { links: rows.map((r) => ({ id: r.id, platform: r.platform, postId: r.post_id, url: r.url, account: r.account, source: r.source, linkedBy: r.linked_by_label, linkedAt: r.linked_at, active: !r.unlinked_at, unlinkedBy: r.unlinked_by_label || null, unlinkedAt: r.unlinked_at || null, unlinkReason: r.unlink_reason || null })) } };
  } catch (e) { if (storageMissing(e)) return MISSING; throw e; }
}

async function link({ piece, url, member, resolve }) {
  if (member && !LINKERS.includes(member.role)) return { status: 403, body: { error: 'only a line manager or admin can link a published post', code: 'role_required' } };
  if (!url) return { status: 422, body: { error: 'url (the published post) is required' } };
  // the piece must have an approved final: attribution is for what was actually published
  const [fin] = await queryRows('stages', `select=id,state&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.final&limit=1`);
  if (!fin || fin.state !== 'approved') return { status: 409, body: { error: 'link a post only after the final is approved', code: 'final_not_approved' } };
  const post = await resolve(url);
  if (post && post.error) return { status: post.status || 422, body: { error: post.error } };
  if (!post) return { status: 404, body: { error: 'the tracker holds no post at that URL yet (it collects daily) — try again after the next collection', code: 'post_not_found' } };
  if (!post.owned) return { status: 422, body: { error: `that post belongs to ${post.account || 'an unknown account'}, not an owned account — only owned posts can be attributed`, code: 'not_owned' } };
  try {
    const active = await queryRows('piece_posts', `select=id&piece_id=eq.${encodeURIComponent(piece.id)}&platform=eq.${post.platform}&post_id=eq.${encodeURIComponent(post.postId)}&unlinked_at=is.null&limit=1`);
    if (active.length) return { status: 409, body: { error: 'this post is already linked to this piece', code: 'already_linked', id: active[0].id } };
    const [row] = await insertRows('piece_posts', [{ piece_id: piece.id, platform: post.platform, post_id: post.postId, url: post.url, account: post.account, source: 'manual', linked_by: member ? member.id : null, linked_by_label: who(member) }], { returning: true });
    try { await insertRows('audit_log', [{ actor: member ? member.id : null, action: 'piece.post.link', entity: 'content_piece', entity_id: piece.id, after: { platform: post.platform, postId: post.postId, url: post.url } }]); } catch (e) { /* best effort */ }
    // 8b: the piece's earliest open planned post on that platform is now posted
    const slot = row ? await require('./publishing.js').markPosted({ pieceId: piece.id, platform: post.platform, piecePostId: row.id }) : null;
    return { status: 200, body: { ok: true, id: row ? row.id : null, post, slotPosted: slot ? slot.id : null } };
  } catch (e) {
    if (storageMissing(e)) return MISSING;
    if (/23505|duplicate/.test(String(e.message))) return { status: 409, body: { error: 'this post is already linked to this piece', code: 'already_linked' } };
    throw e;
  }
}

async function unlink({ piece, id, reason, member }) {
  if (member && !LINKERS.includes(member.role)) return { status: 403, body: { error: 'only a line manager or admin can unlink a post', code: 'role_required' } };
  try {
    const rows = await patchRows('piece_posts', `id=eq.${encodeURIComponent(id)}&piece_id=eq.${encodeURIComponent(piece.id)}&unlinked_at=is.null`, { unlinked_at: new Date().toISOString(), unlinked_by: member ? member.id : null, unlinked_by_label: who(member), unlink_reason: reason ? String(reason).slice(0, 280) : null });
    if (!rows.length) return { status: 404, body: { error: 'no active link with that id on this piece' } };
    return { status: 200, body: { ok: true, id } };
  } catch (e) { if (storageMissing(e)) return MISSING; throw e; }
}

module.exports = { list, link, unlink, storageMissing, LINKERS };
