// /api/sentiment — Consumer Sentiment Tracker integration.
//
// POST (Bearer MAISTRO_INGEST_KEY): the tracker pushes post snapshots —
//   one post object or {posts: [...]}. Each snapshot:
//   {
//     postId: "tiktok-7301...",          // required, stable per post
//     platform: "tiktok|instagram|youtube|x",
//     account: "@SamsungGulf",
//     caption: "...", url: "https://...",
//     postedAt: "2026-10-05T18:00:00Z",
//     metrics: { views, likes, comments, shares, er },   // er as fraction, e.g. 0.043
//     sentiment: { pos, neu, neg },                      // fractions summing ~1
//     comments: [ { author, text, sentiment: "pos|neu|neg", likes, at } ]
//   }
//   Snapshots are append-only; the latest snapshot per postId wins on read.
//
// GET (public): latest snapshot per post, newest posts first.

const { insertRow, listRows, queryRows, insertRows } = require('../_supabase.js');
const { bearerMatches, requireSession, refreshMember } = require('../_auth.js');

// 7.1 D-a "Respond": a comment marked handled (or unhandled again). One key for every copy of the comment —
// the post, the author and the message key the twin collapse uses — so a re-collected duplicate or a twin
// stays handled. Append-only rows in audit_log (who, when, note): the latest row per key is the state.
const HANDLERS = ['admin', 'line_manager', 'reviewer']; // ASSUMPTION (2026-10-22, owner to amend): no "responder" role exists; reviewers reply
const postKey = (id) => String(id || '').replace(/^(tiktok|instagram|facebook|x)-/, '');
function commentKey({ postId, author, text, at }) {
  const { messageKey } = require('./track.js');
  const m = messageKey(text), a = String(author || '').trim().toLowerCase();
  return `${postKey(postId)}|${a}|${m == null ? `blank|${at || ''}` : m}`;
}
async function handled(req, res) {
  if (!requireSession(req, res)) return;
  // every row, paged (the database returns at most 1000 per request): a mark older than any window must not
  // silently fall back to unhandled
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const page = await queryRows('audit_log', `select=actor,action,after,at&action=in.(comment.handled,comment.unhandled)&order=id.desc&limit=1000&offset=${off}`);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const state = {};
  for (const r of rows) {
    const k = r.after && r.after.key;
    if (k && !state[k]) state[k] = { handled: r.action === 'comment.handled', by: r.after.by || null, at: r.at, note: r.after.note || null };
  }
  res.status(200).json({ handled: state, rows: rows.length });
}
async function markHandled(req, res, b) {
  if (!requireSession(req, res)) return;
  if (req.member) {
    if (!(await refreshMember(req, res))) return;
    if (!HANDLERS.includes(req.member.role)) { res.status(403).json({ error: `marking a comment handled needs one of: ${HANDLERS.join(', ')}`, code: 'role_required' }); return; }
  }
  if (!b.postId || typeof b.handled !== 'boolean') { res.status(400).json({ error: 'postId and handled (true/false) are required' }); return; }
  const key = commentKey(b);
  const by = req.member ? (req.member.name || req.member.email || req.member.id) : 'password session (no member sign-in)';
  await insertRows('audit_log', [{ actor: req.member ? req.member.id : null, action: b.handled ? 'comment.handled' : 'comment.unhandled', entity: 'comment', entity_id: null, after: { key, postId: postKey(b.postId), author: b.author || null, platform: b.platform || null, note: b.note ? String(b.note).slice(0, 280) : null, by } }]);
  res.status(200).json({ ok: true, key, handled: b.handled, by });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET' && String((req.query || {}).handled || '') === '1') return await handled(req, res);
    if (req.method === 'POST' && req.body && req.body.action === 'comment-handled') return await markHandled(req, res, req.body);
  } catch (err) {
    return res.status(502).json({ error: String((err && err.message) || err) });
  }

  if (req.method === 'POST') {
    const key = process.env.MAISTRO_INGEST_KEY;
    if (!key) {
      res.status(503).json({ error: 'MAISTRO_INGEST_KEY is not configured on the server' });
      return;
    }
    if (!bearerMatches(req.headers.authorization, key)) {
      res.status(401).json({ error: 'missing or invalid Authorization bearer token' });
      return;
    }
    const body = req.body || {};
    const posts = Array.isArray(body.posts) ? body.posts : [body];
    const bad = posts.findIndex((p) => !p || !p.postId);
    if (!posts.length || bad !== -1) {
      res.status(400).json({ error: `every post needs a postId (item ${bad} is missing one)` });
      return;
    }
    try {
      for (const p of posts) {
        await insertRow('sentiment_posts', {
          post_id: String(p.postId),
          platform: p.platform || null,
          account: p.account || null,
          caption: p.caption || null,
          url: p.url || null,
          posted_at: p.postedAt || null,
          metrics: p.metrics || {},
          sentiment: p.sentiment || {},
          comments: Array.isArray(p.comments) ? p.comments : [],
        });
      }
      res.status(200).json({ ok: true, ingested: posts.length });
    } catch (err) {
      res.status(502).json({ error: String((err && err.message) || err) });
    }
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET or POST only' });
    return;
  }

  try {
    const rows = await listRows(
      'sentiment_posts',
      'post_id,platform,account,caption,url,posted_at,metrics,sentiment,comments,at',
      1000, // the daily /api/track snapshot writes ~300 rows per run; keep two runs visible
    );
    // never the tracker's other projects: snapshots before 2026-10-22 stored ifold_ competitor/fan/news
    // posts that the reader now excludes (single-post pushes arrive outside the daily run, so the
    // newest-row-per-post rule stays)
    const FOREIGN = /^(ifold|unpacked|roster)_/;
    const latest = new Map(); // rows come newest-first
    for (const r of rows) {
      if (FOREIGN.test(String(r.post_id))) continue;
      if (!latest.has(r.post_id)) latest.set(r.post_id, r);
    }
    const posts = [...latest.values()]
      .map((r) => ({
        postId: r.post_id,
        platform: r.platform,
        account: r.account,
        caption: r.caption,
        url: r.url,
        postedAt: r.posted_at,
        metrics: r.metrics || {},
        sentiment: r.sentiment || {},
        comments: r.comments || [],
        updatedAt: r.at,
      }))
      .sort((a, b) => new Date(b.postedAt || b.updatedAt) - new Date(a.postedAt || a.updatedAt));
    res.status(200).json({ count: posts.length, posts });
  } catch (err) {
    res.status(502).json({ error: String((err && err.message) || err) });
  }
};
module.exports.commentKey = commentKey;
