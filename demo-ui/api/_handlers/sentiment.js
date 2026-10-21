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

const { insertRow, listRows } = require('../_supabase.js');
const { bearerMatches } = require('../_auth.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

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
    const latest = new Map(); // rows come newest-first
    for (const r of rows) {
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
