// GET /api/track — reads the Consumer Sentiment Tracker's (samsungtrack)
// Supabase DIRECTLY, so Maistro rides the tracker's existing daily Apify
// schedule instead of running duplicate pulls. Returns the Samsung-account
// posts of the window plus their comments, with the tracker's stored
// sentiment (lexicon fallback matching the samsungtrack dashboard when a
// comment was never analyzed).
//
//   ?days=60   window in days (default 60, max 90)
//
// Env: TRACK_SUPABASE_URL + TRACK_SUPABASE_KEY (the tracker project's
// Supabase — NOT Maistro's own). Edge-cached 10 minutes, served stale for
// a day while it revalidates.
//
// Daily persistence: the Vercel cron (vercel.json) calls this once a day
// after the tracker's own 05:42 UTC sync; that run also writes every post
// as a snapshot into Maistro's sentiment_posts table (the same table the
// tracker's push bridge fills), so /api/sentiment always holds yesterday's
// full picture and the Performance page renders instantly even when this
// live read is slow or the tracker DB is timing out. A manual store needs
// the MAISTRO_INGEST_KEY bearer.
//
// Comment → post matching mirrors samsungtrack's /api/comments resolver:
// different actors key a comment's parent by numeric id, Instagram
// shortcode, or the post URL itself (Facebook pfbid links carry no numeric
// id at all), so every alias of a post is indexed and a comment resolves
// through any of them. Matching on external_id alone dropped every comment
// on a URL-keyed post.
//
// Query shape matters on this DB (8s statement timeout, big raw_data JSONB):
// never select raw_data whole — project the handful of subfields needed —
// filter to Samsung accounts in SQL with ONE cheap predicate per platform
// (post_url first, a single JSON field only where the URL has no account),
// and page along the published_at index, never ORDER BY id.

const { insertRow } = require('./_supabase.js');
const { bearerMatches, isCron: isCronRequest } = require('./_auth.js');
const { fetchT } = require('./_http.js');

const DAYS_MAX = 90;
const FALLBACK_DAYS = 14; // cron snapshot window when the full read fails or is partial
const PAGE = 1000;

// ── sentiment lexicon, ported 1:1 from samsungtrack's dashboard route ──
const POS = [
  /love|amazing|awesome|excellent|fantastic|great|best|perfect|beautiful|stunning/i,
  /impressed|happy|excited|recommend|worth|incredible|brilliant/i,
  /thank|appreciate|satisfied|pleased|delighted/i,
];
const NEG = [
  /hate|terrible|worst|awful|horrible|disappointing|waste|garbage|trash/i,
  /broken|defective|useless|poor|bad|fail|sucks|regret/i,
  /angry|frustrated|annoyed|upset|unhappy|dissatisfied/i,
  /refund|return|complaint|issue|problem|bug|error|crash/i,
];
function lexSentiment(text) {
  const s = String(text || '');
  let p = 0, n = 0;
  for (const re of POS) if (re.test(s)) p++;
  for (const re of NEG) if (re.test(s)) n++;
  return p > n ? 'pos' : n > p ? 'neg' : 'neu';
}

const SENT_MAP = { positive: 'pos', neutral: 'neu', negative: 'neg' };

// raw_data subfields, projected out as flat columns (alias → JSON path).
// Projections only run on result rows, so they are cheap; filters are not.
const POST_COLUMNS = [
  'external_id,platform,post_url,caption,media_type,media_url,likes_count,comments_count,shares_count,views_count,published_at',
  'short_code:raw_data->>shortCode',
  'owner_ig:raw_data->>ownerUsername',
  'owner_tt:raw_data->authorMeta->>name',
  'owner_x:raw_data->author->>userName',
  'owner_fb:raw_data->>pageName',
  'owner_u:raw_data->user->>username',
  'owner_au:raw_data->>authorUsername',
  'owner_un:raw_data->>username',
  'thumb_cover_url:raw_data->videoMeta->>coverUrl',
  'thumb_cover2:raw_data->videoMeta->>cover',
  'thumb_covers0:raw_data->covers->>0',
  'thumb_cover3:raw_data->>coverUrl',
  'thumb_cover4:raw_data->>cover',
  'thumb_display:raw_data->>displayUrl',
  'thumb_full:raw_data->>fullPicture',
  'thumb_full2:raw_data->>full_picture',
  'thumb_url:raw_data->>thumbnailUrl',
].join(',');

// Samsung-owned accounts only, decided in SQL so the DB never ships
// retailer/operator rows (and their JSON) across the wire. Instagram URLs
// carry no account, so that one needs the JSON owner field.
const PLATFORM_FILTERS = {
  instagram: 'platform=eq.instagram&raw_data->>ownerUsername=ilike.*samsung*',
  tiktok: 'platform=eq.tiktok&or=(post_url.ilike.*samsung*,raw_data->authorMeta->>name.ilike.*samsung*)',
  facebook: 'platform=eq.facebook&or=(post_url.ilike.*samsung*,raw_data->>pageName.ilike.*samsung*)',
  twitter: 'platform=eq.twitter&or=(post_url.ilike.*samsung*,raw_data->author->>userName.ilike.*samsung*)',
};

const COMMENT_COLUMNS = [
  'id,external_post_id,platform,author_username,text,sentiment,likes_count,published_at',
  'raw_post_ref:raw_data->>postId',
  'raw_post_url:raw_data->>postUrl',
  'raw_post_url2:raw_data->>post_url',
  'raw_input_url:raw_data->>inputUrl',
  'raw_fb_url:raw_data->>facebookUrl',
  'raw_video_url:raw_data->>video_url',
].join(',');

function author(p) {
  return p.owner_ig || p.owner_tt || p.owner_x || p.owner_fb || p.owner_u || p.owner_au || p.owner_un || null;
}
function thumbOf(p) {
  return p.media_url || p.thumb_cover_url || p.thumb_cover2 || p.thumb_covers0 || p.thumb_cover3
    || p.thumb_cover4 || p.thumb_display || p.thumb_full || p.thumb_full2 || p.thumb_url || null;
}

// ── Instagram id ⇄ shortcode (two encodings of one number), ported from
//    samsungtrack lib/instagram-id.ts ──
const IG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function igIdToShortcode(id) {
  if (!/^\d+$/.test(id)) return null;
  try {
    let n = BigInt(id), s = '';
    while (n > 0n) { s = IG_ALPHABET[Number(n % 64n)] + s; n /= 64n; }
    return s || null;
  } catch { return null; }
}
function igShortcodeToId(sc) {
  if (!/^[A-Za-z0-9\-_]{5,15}$/.test(sc)) return null;
  try {
    let n = 0n;
    for (const c of sc) { const i = IG_ALPHABET.indexOf(c); if (i < 0) return null; n = n * 64n + BigInt(i); }
    return n.toString();
  } catch { return null; }
}
function igShortcodeFromUrl(url) {
  const m = String(url || '').match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9\-_]+)/);
  return m ? m[1] : null;
}

// Every key a comment might use to reference this post.
function postAliases(p) {
  const keys = new Set();
  const add = (k) => { if (k) keys.add(String(k)); };
  const url = String(p.post_url || '');
  add(p.external_id);
  add(url);
  add(url.replace(/\/+$/, ''));
  if (p.platform === 'facebook') {
    // reel/{id}, videos/{id}, posts/{id} all name the same item
    for (const m of url.matchAll(/\/(\d{10,})/g)) add(m[1]);
  }
  if (p.platform === 'instagram') {
    const ext = String(p.external_id || '');
    add(p.short_code);
    if (/^\d+$/.test(ext)) add(igIdToShortcode(ext)); else add(igShortcodeToId(ext));
    const sc = igShortcodeFromUrl(url);
    add(sc);
    if (sc) add(igShortcodeToId(sc));
  }
  return [...keys];
}

// Resolve a comment's parent through any alias form, like samsungtrack does.
function resolvePost(index, c) {
  const refs = [c.external_post_id, c.raw_post_ref, c.raw_post_url, c.raw_post_url2, c.raw_input_url, c.raw_fb_url, c.raw_video_url];
  for (const ref of refs) {
    if (!ref) continue;
    const key = String(ref);
    let hit = index.get(key) || index.get(key.replace(/\/+$/, ''));
    if (!hit && c.platform === 'instagram') {
      hit = index.get((/^\d+$/.test(key) ? igIdToShortcode(key) : igShortcodeToId(key)) || '');
    }
    if (!hit) { const sc = igShortcodeFromUrl(key); if (sc) hit = index.get(sc) || index.get(igShortcodeToId(sc) || ''); }
    if (!hit && (c.platform === 'facebook' || c.platform === 'tiktok')) {
      for (const m of key.matchAll(/\/(\d{10,})/g)) { hit = index.get(m[1]); if (hit) break; }
    }
    if (hit) return hit;
  }
  return null;
}

// Twin comments. Different actors key the same comment differently (a
// synthetic shortcode_user_timestamp id vs the real numeric id) and stamp it
// with different times (one gives the exact second, the other a minute-
// rounded or scrape-relative time), so one comment is stored several times
// with different likes and only one copy sentiment-analyzed. In the 60-day
// window 22% of all comments were such twins — Instagram alone 1.4k — and
// keying on the publish second (the previous rule) caught almost none of
// them: the copies sit a median 60 s apart. So collapse on author + text
// within a post regardless of time. A real same-user repeat ("giveaway spam"
// posted twice) is collapsed too; for a sentiment dashboard that is the
// right call — one voice, one comment. Keep the analyzed copy, then the one
// with more likes, then the earliest.
const normText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
function dedupeTwins(rows) {
  const best = new Map();
  for (const c of rows) {
    const k = `${String(c.author_username || '').trim().toLowerCase()}|${normText(c.text)}`;
    const cur = best.get(k);
    if (!cur) { best.set(k, c); continue; }
    const curA = !!SENT_MAP[cur.sentiment], cA = !!SENT_MAP[c.sentiment];
    const curL = +cur.likes_count || 0, cL = +c.likes_count || 0;
    if ((cA && !curA) || (cA === curA && (cL > curL || (cL === curL && String(c.published_at || '') < String(cur.published_at || ''))))) best.set(k, c);
  }
  return [...best.values()];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const base = process.env.TRACK_SUPABASE_URL;
  const key = process.env.TRACK_SUPABASE_KEY;
  if (!base || !key) return res.status(503).json({ error: 'tracker DB is not configured (TRACK_SUPABASE_URL / TRACK_SUPABASE_KEY)' });
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  const headers = req.headers || {};
  const isCron = isCronRequest(req);
  const ingestKey = process.env.MAISTRO_INGEST_KEY;
  const authorized = bearerMatches(headers.authorization, ingestKey);
  const q = req.query || {};
  const wantStore = isCron || (authorized && String(q.store || '') === '1');

  // A cold-cache page can trip the tracker DB's 8s statement timeout; the
  // failed attempt warms the buffers, so retry before giving up (same
  // approach as samsungtrack's own payload routes).
  const timings = [];
  const get = async (path) => {
    let last = '';
    const t0 = Date.now();
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetchT(`${base}/rest/v1/${path}`, { headers: H }, { timeoutMs: 30000 });
      const j = await r.json().catch(() => null);
      if (r.ok && Array.isArray(j)) {
        timings.push({ q: path.split('?')[0] + ':' + (path.match(/platform=eq\.(\w+)/) || [])[1], rows: j.length, ms: Date.now() - t0, attempts: attempt + 1 });
        return j;
      }
      last = JSON.stringify(j).slice(0, 160);
      if (!/statement timeout|57014/.test(last)) break;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    timings.push({ q: path.split('?')[0], failed: last, ms: Date.now() - t0 });
    throw new Error(`${path.split('?')[0]} query failed: ${last}`);
  };

  // One window read: posts + comments + matching. Throws when a posts query
  // fails for good; a failed comments page only marks the result partial.
  const readWindow = async (days) => {
    const since = new Date(Date.now() - days * 864e5).toISOString();

    // Samsung posts of the window per platform, newest first, keyset-paged
    // on published_at.
    const ours = [];
    for (const filter of Object.values(PLATFORM_FILTERS)) {
      let cur = null;
      for (let page = 0; page < 5; page++) {
        const rows = await get(
          `social_posts?select=${POST_COLUMNS}&${filter}&published_at=gte.${since}`
          + `&order=published_at.desc&limit=${PAGE}${cur ? `&published_at=lt.${encodeURIComponent(cur)}` : ''}`);
        ours.push(...rows);
        if (rows.length < PAGE) break;
        cur = rows[rows.length - 1].published_at;
      }
    }
    ours.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));

    const byId = new Map(ours.map((p) => [String(p.external_id), []]));
    const index = new Map();
    for (const p of ours) {
      const slot = byId.get(String(p.external_id));
      for (const k of postAliases(p)) if (!index.has(k)) index.set(k, slot);
    }

    // Comments of the window, newest first along the published_at index
    // (keyset on published_at, ties broken by id). Comments keep arriving
    // after a post is published, so the window is the post window plus a
    // few days of slack. Unpacked / roster / iFold corpora (other pipelines
    // sharing the table) are excluded with cheap text predicates.
    const floor = new Date(Date.now() - (days + 3) * 864e5).toISOString();
    const excl = ['unpacked', 'roster', 'ifold'].map((x) => `&external_id=not.like.${x}${encodeURIComponent('\\_')}*`).join('');
    let cursor = null, commentsSeen = 0, commentsMatched = 0, commentsPartial = false;
    for (let page = 0; page < 80; page++) {
      let rows;
      try {
        rows = await get(
          `social_comments?select=${COMMENT_COLUMNS}&published_at=gte.${floor}${excl}`
          + `&order=published_at.desc,id.desc&limit=${PAGE}`
          + (cursor ? `&or=(published_at.lt.${encodeURIComponent(cursor.at)},and(published_at.eq.${encodeURIComponent(cursor.at)},id.lt.${encodeURIComponent(cursor.id)}))` : ''));
      } catch (e) {
        // keep what was gathered rather than failing the whole page
        console.error('[track] comments page failed:', e.message);
        commentsPartial = true;
        break;
      }
      if (!rows.length) break;
      commentsSeen += rows.length;
      for (const c of rows) {
        const slot = resolvePost(index, c);
        if (slot) { slot.push(c); commentsMatched++; }
      }
      const lastRow = rows[rows.length - 1];
      cursor = { at: lastRow.published_at, id: lastRow.id };
      if (rows.length < PAGE || !lastRow.published_at) break;
    }

    const out = ours.map((p) => {
      const cmts = dedupeTwins(byId.get(String(p.external_id)) || []).map((c) => ({
        author: c.author_username || 'anonymous',
        text: c.text || '',
        likes: c.likes_count ?? null,
        at: c.published_at || null,
        sentiment: SENT_MAP[c.sentiment] || lexSentiment(c.text),
      })).sort((a, b) => (b.likes || 0) - (a.likes || 0));
      const views = +p.views_count || 0, likes = +p.likes_count || 0,
        cn = +p.comments_count || 0, shares = +p.shares_count || 0;
      return {
        postId: String(p.external_id),
        platform: p.platform === 'twitter' ? 'x' : p.platform,
        account: author(p),
        caption: p.caption || '',
        url: p.post_url || null,
        postedAt: p.published_at,
        mediaType: p.media_type || null,
        metrics: {
          views: views || null, likes: likes || null, comments: cn || null, shares: shares || null,
          er: views ? (likes + cn + shares) / views : null,
          thumb: thumbOf(p),
        },
        comments: cmts,
      };
    });
    return { out, commentsSeen, commentsMatched, commentsPartial };
  };

  try {
    let days = Math.min(DAYS_MAX, Math.max(1, parseInt(isCron ? 60 : q.days, 10) || 60));
    let R;
    try {
      R = await readWindow(days);
    } catch (e) {
      if (!isCron || days <= FALLBACK_DAYS) throw e;
      console.error(`[track] ${days}-day cron read failed (${e.message}) — retrying with ${FALLBACK_DAYS} days`);
      R = null;
    }
    // The 60-day cron read pages through ~14k comments; one statement
    // timeout marks it partial and a partial run is never stored, which left
    // the snapshot stale for days. A 14-day read is ~20x cheaper and covers
    // the Performance page's default week, so store that instead.
    if (isCron && (!R || R.commentsPartial) && days > FALLBACK_DAYS) {
      if (R) console.error('[track] 60-day cron read was partial — re-reading 14 days for the snapshot');
      days = FALLBACK_DAYS;
      R = await readWindow(days);
    }
    const { out, commentsSeen, commentsMatched, commentsPartial } = R;

    // Daily snapshot into Maistro's own sentiment_posts (append-only; the
    // /api/sentiment reader keeps the newest row per post).
    let stored = null;
    if (wantStore && !commentsPartial && out.length) {
      try {
        const rows = out.map((p) => {
          const n = { pos: 0, neu: 0, neg: 0 };
          for (const c of p.comments) if (n[c.sentiment] != null) n[c.sentiment]++;
          const tot = n.pos + n.neu + n.neg;
          return {
            post_id: p.postId, platform: p.platform, account: p.account, caption: p.caption, url: p.url,
            posted_at: p.postedAt, metrics: p.metrics,
            sentiment: tot ? { pos: n.pos / tot, neu: n.neu / tot, neg: n.neg / tot } : {},
            comments: p.comments,
          };
        });
        await insertRow('sentiment_posts', rows); // PostgREST bulk insert
        stored = { rows: rows.length };
      } catch (e) {
        console.error('[track] snapshot store failed:', e.message);
        stored = { error: e.message };
      }
    }

    res.setHeader('Cache-Control', commentsPartial ? 'no-store' : 's-maxage=600, stale-while-revalidate=86400');
    return res.status(200).json({
      source: 'samsungtrack DB (daily Apify schedule — no duplicate pulls)',
      fetchedAt: new Date().toISOString(),
      days,
      count: out.length,
      comments: { seen: commentsSeen, matched: commentsMatched, partial: commentsPartial },
      stored,
      timings,
      posts: out,
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: e.message || 'tracker read failed', timings });
  }
};

module.exports.dedupeTwins = dedupeTwins; // exposed for tests
