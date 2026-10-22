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

const { insertRow, queryRows } = require('../_supabase.js');
const { requireSession, bearerMatches, isCron: isCronRequest } = require('../_auth.js');
const { fetchT } = require('../_http.js');

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

// The tracker DB also holds other projects' rows, tagged by external_id prefix (SamsungSentiment
// lib/ifold-sync.ts: competitor and fan accounts, YouTube and news under platform=twitter). Comments
// already excluded them; posts did not, so fan accounts matching *samsung* and news URLs got in —
// 22 of 397 posts, 3.74M of 4.49M TikTok views (found 2026-10-22). Same escaped exclusion for both.
const PROJECT_EXCL = ['unpacked', 'roster', 'ifold'].map((x) => `&external_id=not.like.${x}${encodeURIComponent('\\_')}*`).join('');

const COMMENT_COLUMNS = [
  'id,external_id,external_post_id,platform,author_username,text,sentiment,likes_count,published_at',
  'raw_post_ref:raw_data->>postId',
  'raw_post_url:raw_data->>postUrl',
  'raw_post_url2:raw_data->>post_url',
  'raw_input_url:raw_data->>inputUrl',
  'raw_fb_url:raw_data->>facebookUrl',
  'raw_video_url:raw_data->>video_url',
].join(',');

// One spelling per account: the tracker stores the same account as "samsunggulf" and "@samsunggulf", and
// X posts often carry no owner field at all although the URL names the account (x.com/SamsungGulf/status/…).
function author(p) {
  const raw = p.owner_ig || p.owner_tt || p.owner_x || p.owner_fb || p.owner_u || p.owner_au || p.owner_un || null;
  if (raw) return String(raw).replace(/^@/, '');
  try {
    const u = new URL(p.post_url || '');
    const seg = (u.pathname.split('/').filter(Boolean)[0] || '').replace(/^@/, '');
    if (/^(x|twitter)\.com$|tiktok\.com$/.test(u.hostname.replace(/^www\./, '')) && seg && !['status', 'video', 'i'].includes(seg)) return seg;
  } catch (e) { /* no URL */ }
  return null;
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

// Twin comments: one voice, one comment. The collapse was written for storage twins (one comment keyed
// twice by different actors, a synthetic shortcode_user_timestamp id vs the real numeric id, a median 60 s
// apart). The labelled audit of 2026-10-22 (tests/fixtures/twin-audit-2026-10-22.json, 72 sampled cases of
// a 60-day window) found none of those any more: every merged group was the same author posting the same
// text under distinct numeric ids — giveaway entries re-posted, a complaint sent twice — and the rule
// missed 23 of 36 near-duplicates, the same entries re-posted with a dot, an emoji, a friend's @mention or
// the text pasted several times (exact text was the old key). So the key is the author plus the message with
// punctuation, symbols and emoji, combining marks, @mentions, whitespace and case removed, and a verbatim
// self-repeat folded to one copy. Added or changed words stay separate comments; another author is always another
// voice. A text that is only emoji falls back to its exact form; blank text (a sticker, an image) is never
// merged, since what it says is unknown. Keep the analyzed copy, then the one with more likes, then the
// earliest.
const normText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
function messageKey(text) {
  const exact = normText(text);
  let c = exact.normalize('NFKC').toLowerCase().replace(/@[\w.]+/g, ' ')
    .replace(/[\p{P}\p{S}\p{M}\s\u200b-\u200d\u2060\ufeff]+/gu, '');
  // a text pasted several times (the last copy may be cut off) is the text once
  for (let n = 1; n <= c.length / 2; n++) {
    let rep = true;
    for (let i = n; i < c.length && rep; i++) rep = c[i] === c[i % n];
    if (rep) { c = c.slice(0, n); break; }
  }
  return c || exact || null;
}
let blankSeq = 0;
const twinKey = (c) => { const m = messageKey(c.text); return m == null ? `\u0000blank${blankSeq++}` : `${String(c.author_username || '').trim().toLowerCase()}|${m}`; };
function dedupeTwins(rows) {
  const best = new Map();
  for (const c of rows) {
    const k = twinKey(c);
    const cur = best.get(k);
    if (!cur) { best.set(k, c); continue; }
    const curA = !!SENT_MAP[cur.sentiment], cA = !!SENT_MAP[c.sentiment];
    const curL = +cur.likes_count || 0, cL = +c.likes_count || 0;
    if ((cA && !curA) || (cA === curA && (cL > curL || (cL === curL && String(c.published_at || '') < String(cur.published_at || ''))))) best.set(k, c);
  }
  return [...best.values()];
}

// 7.0 twin-collapse audit: the reconciliation keeps a random, platform-stratified sample of both collapse
// outcomes — groups dedupeTwins merged, and near-duplicates it kept apart — so the rule's false-merge and
// missed-duplicate rates can be measured on hand-labelled rows (tests/fixtures/twin-audit-*.json). Counts are
// over the whole window; the sample is seeded by the window start, so a re-run of the same window draws the
// same rows.
const zw = /[\u200b-\u200d\u2060\ufeff\ufe0e\ufe0f]/g;
const looseText = (t) => normText(t).normalize('NFKC').replace(zw, '').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
const looseAuthor = (a) => String(a || '').trim().toLowerCase().replace(/^@/, '');
const idForm = (id) => (id == null ? 'none' : /^\d+$/.test(String(id)) ? 'numeric' : /_\d{9,}$/.test(String(id)) ? 'synthetic' : 'other');
function seeded(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function twinAudit(lists, { seed = '', perPlatform = 12 } = {}) {
  const rnd = seeded(seed);
  const row = (c) => ({ commentId: c.external_id ?? null, idForm: idForm(c.external_id), author: c.author_username || null, text: String(c.text || '').slice(0, 200), at: c.published_at || null, likes: c.likes_count ?? null, sentiment: c.sentiment || null });
  const merged = [], near = [], counts = { groupsMerged: 0, rowsRemoved: 0, nearPairs: { loose: 0, truncated: 0, otherAuthor: 0 } };
  for (const { postId, platform, rows } of lists) {
    const groups = new Map();
    for (const c of rows) { const k = twinKey(c); (groups.get(k) || groups.set(k, []).get(k)).push(c); }
    for (const g of groups.values()) if (g.length > 1) { counts.groupsMerged++; counts.rowsRemoved += g.length - 1; merged.push({ postId, platform, members: g.map(row) }); }
    const kept = dedupeTwins(rows);
    for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) {
      const a = kept[i], b = kept[j], ta = looseText(a.text), tb = looseText(b.text);
      if (!ta || !tb) continue;
      const sameA = looseAuthor(a.author_username) === looseAuthor(b.author_username);
      const dt = Math.abs(Date.parse(a.published_at) - Date.parse(b.published_at));
      let kind = null;
      if (sameA && ta === tb) kind = 'loose';
      else if (sameA && Math.min(ta.length, tb.length) >= 20 && (ta.startsWith(tb) || tb.startsWith(ta))) kind = 'truncated';
      else if (!sameA && ta === tb && ta.length >= 15 && dt <= 10 * 60e3) kind = 'otherAuthor';
      if (kind) { counts.nearPairs[kind]++; near.push({ postId, platform, kind, dtSec: Number.isFinite(dt) ? Math.round(dt / 1000) : null, members: [row(a), row(b)] }); }
    }
  }
  const pick = (xs) => {
    const by = new Map();
    for (const x of xs) (by.get(x.platform) || by.set(x.platform, []).get(x.platform)).push(x);
    const outp = [];
    for (const [plat, arr] of [...by].sort()) {
      for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
      outp.push(...arr.slice(0, perPlatform).map((x) => ({ ...x, platformTotal: arr.length })));
      void plat;
    }
    return outp;
  };
  const byPlat = (xs) => xs.reduce((m, x) => ((m[x.platform] = (m[x.platform] || 0) + 1), m), {});
  return { counts: { ...counts, mergedByPlatform: byPlat(merged), nearByPlatform: byPlat(near) }, sample: { merged: pick(merged), near: pick(near) } };
}

// Exact row count of a PostgREST filter without transferring rows
// (HEAD + Prefer: count=exact → Content-Range: 0-0/N).
async function countRows(base, H, path) {
  const r = await fetchT(`${base}/rest/v1/${path}`, { method: 'HEAD', headers: { ...H, Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } }, { timeoutMs: 30000, retries: 2 });
  if (!r.ok && r.status !== 206 && r.status !== 416) throw new Error(`count failed (${r.status}) for ${path.split('?')[0]}`);
  const cr = r.headers.get('content-range') || '';
  const m = cr.match(/\/(\d+|\*)$/);
  return m && m[1] !== '*' ? Number(m[1]) : null;
}

const TRACKER_PLATFORM = { x: 'twitter' };
async function reconcile(days, R, get, H, base) {
  const { out, commentsSeen, commentsMatched, commentsPartial } = R;
  // the database is counted over the EXACT window the reader used: recomputing "now − N days" a minute or
  // two later shifts both edges and makes the counts differ by whatever was posted in that slice (R-3 was
  // off by one on 2026-10-22 06:49 and 07:43 for exactly this reason)
  const since = R.since || new Date(Date.now() - days * 864e5).toISOString();
  const floor = R.floor || new Date(Date.now() - (days + 3) * 864e5).toISOString();
  const excl = ['unpacked', 'roster', 'ifold'].map((x) => `&external_id=not.like.${x}${encodeURIComponent('\\_')}*`).join('');
  const report = { days, since, commentFloor: floor, at: new Date().toISOString(), posts: {}, sums: {}, comments: {}, boundary: {}, freshness: {}, checks: {} };

  // R-1 / R-2: posts and sums per platform, reader vs database
  for (const [plat, filter] of Object.entries(PLATFORM_FILTERS)) {
    const mine = out.filter((p) => (TRACKER_PLATFORM[p.platform] || p.platform) === plat);
    let db = null, err = null;
    try { db = await countRows(base, H, `social_posts?select=external_id&${filter}${PROJECT_EXCL}&published_at=gte.${since}`); } catch (e) { err = e.message; }
    report.posts[plat] = { reader: mine.length, db, ...(err ? { error: err } : {}), equal: db != null && db === mine.length };
    const sum = (k) => mine.reduce((s, p) => s + (+(p.metrics || {})[k] || 0), 0);
    report.sums[plat] = { views: sum('views'), likes: sum('likes'), commentsCount: sum('comments'), shares: sum('shares') };
  }
  report.checks.R1_posts = Object.values(report.posts).every((x) => x.equal);

  // R-3: raw comments in the comment window
  let dbSeen = null;
  // counted in 7-day windows: one exact count over 60+ days of comments exceeded the tracker database's
  // statement limit (500 on 2026-10-22); every window must succeed or the check reports the error
  try {
    dbSeen = 0;
    for (let t = Date.parse(floor); t < Date.now(); t += 7 * 864e5) {
      // the last window is open-ended, exactly like the reader (published_at >= floor, no upper bound),
      // so a comment timestamped in the future is counted on both sides
      const a = new Date(t).toISOString(), last = t + 7 * 864e5 >= Date.now();
      const n = await countRows(base, H, `social_comments?select=id&published_at=gte.${a}${last ? '' : `&published_at=lt.${new Date(t + 7 * 864e5).toISOString()}`}${excl}`);
      if (n == null) throw new Error(`count unavailable for ${a.slice(0, 10)}`);
      dbSeen += n;
    }
  } catch (e) { report.comments.seenError = e.message; dbSeen = null; }
  // R-4: canonical-id matches (lower bound; alias forms are the gap)
  const ids = out.map((p) => p.postId);
  let dbMatchedCanonical = 0;
  try {
    for (let i = 0; i < ids.length; i += 10) { // small chunks: 40 ids per exact count also hit the statement limit
      const chunk = ids.slice(i, i + 10).map(encodeURIComponent).join(',');
      dbMatchedCanonical += (await countRows(base, H, `social_comments?select=id&external_post_id=in.(${chunk})&published_at=gte.${floor}`)) || 0;
    }
  } catch (e) { report.comments.matchedError = e.message; dbMatchedCanonical = null; }
  const deduped = out.reduce((s, p) => s + p.comments.length, 0);
  report.comments = { ...report.comments, seen: commentsSeen, dbSeen, partial: commentsPartial, matched: commentsMatched, dbMatchedCanonical, aliasOnly: dbMatchedCanonical == null ? null : commentsMatched - dbMatchedCanonical, deduped, twinsRemoved: commentsMatched - deduped, matchRate: commentsSeen ? +(commentsMatched / commentsSeen).toFixed(4) : null };
  report.checks.R3_commentsSeen = !commentsPartial && dbSeen != null && dbSeen === commentsSeen;
  report.checks.R4_matchedLowerBound = dbMatchedCanonical != null && dbMatchedCanonical <= commentsMatched;

  // R-7: window boundary — rolling (the page), calendar Asia/Dubai, calendar UTC
  const dayKey = (iso, tz) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
  const cutoff = (tz) => { const d = new Date(Date.now() - (days - 1) * 864e5); return dayKey(d.toISOString(), tz); };
  const rolling = out.filter((p) => p.postedAt && Date.now() - new Date(p.postedAt) <= days * 864e5).length;
  const calDubai = out.filter((p) => p.postedAt && dayKey(p.postedAt, 'Asia/Dubai') >= cutoff('Asia/Dubai')).length;
  const calUtc = out.filter((p) => p.postedAt && dayKey(p.postedAt, 'UTC') >= cutoff('UTC')).length;
  const edge = out.filter((p) => p.postedAt && Math.abs(new Date(p.postedAt) - new Date(since)) <= 864e5).map((p) => ({ postId: p.postId, platform: p.platform, postedAt: p.postedAt }));
  report.boundary = { rolling, calendarDubai: calDubai, calendarUtc: calUtc, withinADayOfSince: edge };

  // R-9: freshness per platform
  for (const p of out) {
    const f = report.freshness[p.platform] = report.freshness[p.platform] || { newestPost: null, newestComment: null };
    if (p.postedAt && (!f.newestPost || p.postedAt > f.newestPost)) f.newestPost = p.postedAt;
    for (const c of p.comments) if (c.at && (!f.newestComment || c.at > f.newestComment)) f.newestComment = c.at;
  }
  // twin-collapse audit sample (labelled offline; see the function)
  if (R.raw) { try { report.twins = twinAudit(R.raw, { seed: since }); } catch (e) { report.twins = { error: e.message }; } }
  report.checks.R6_postsUniqueById = new Set(ids).size === ids.length;
  // R-8 population: every counted post belongs to an owned account (the two-sided counts agree even on a
  // wrong population — the ifold_ rows passed R-1 until 2026-10-22). MAISTRO_OWNED_ACCOUNTS overrides,
  // as "platform:account,…"; default: the Samsung Gulf accounts on the four platforms.
  const owned = new Set(String(process.env.MAISTRO_OWNED_ACCOUNTS || 'tiktok:samsunggulf,instagram:samsunggulf,facebook:samsunggulf,x:samsunggulf,twitter:samsunggulf').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean));
  const foreign = out.filter((p) => !owned.has(`${String(p.platform).toLowerCase()}:${String(p.account || '').toLowerCase().replace(/^@/, '')}`));
  report.population = { owned: [...owned], foreign: foreign.length, sample: foreign.slice(0, 5).map((p) => ({ postId: p.postId, platform: p.platform, account: p.account || null, url: p.url })) };
  report.checks.R8_ownedAccountsOnly = foreign.length === 0;
  report.ok = Boolean(report.checks.R1_posts && report.checks.R3_commentsSeen && report.checks.R4_matchedLowerBound && report.checks.R6_postsUniqueById && report.checks.R8_ownedAccountsOnly);
  return report;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const base = process.env.TRACK_SUPABASE_URL;
  const key = process.env.TRACK_SUPABASE_KEY;
  if (!base || !key) return res.status(503).json({ error: 'tracker DB is not configured (TRACK_SUPABASE_URL / TRACK_SUPABASE_KEY)' });
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  const headers = req.headers || {};
  const isCron = isCronRequest(req);
  // the cron URL is only for the cron: anything else asking for it gets a non-cacheable 401, so no request can
  // put a cacheable payload at /api/track?cron=1 ahead of the 06:30 run (checker finding)
  if ((req.query || {}).cron !== undefined && !isCron) { res.setHeader('Cache-Control', 'no-store'); return res.status(401).json({ error: 'cron only' }); }
  const ingestKey = process.env.MAISTRO_INGEST_KEY;
  const authorized = bearerMatches(headers.authorization, ingestKey);
  const q = req.query || {};
  const wantStore = isCron || (authorized && String(q.store || '') === '1');

  // The latest stored reconciliation report (session holders: the ops view)
  if (String(q.reconcile || '') === 'latest') {
    if (!requireSession(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const rows = await queryRows('reconciliation_reports', 'select=id,at,days,ok,report&order=at.desc&limit=14');
      return res.status(200).json({ count: rows.length, reports: rows });
    } catch (e) { return res.status(502).json({ error: e.message }); }
  }

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
          `social_posts?select=${POST_COLUMNS}&${filter}${PROJECT_EXCL}&published_at=gte.${since}`
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
    return { out, commentsSeen, commentsMatched, commentsPartial, since, floor, raw: ours.map((p) => ({ postId: String(p.external_id), platform: p.platform === 'twitter' ? 'x' : p.platform, rows: byId.get(String(p.external_id)) || [] })) };
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

    // 7.0 reconciliation (PERFORMANCE_RECONCILIATION.md §2): the same rows
    // counted two ways — by this reader and by the database itself — plus
    // the definitional differences made visible. Ingest key or cron only;
    // never cached; never writes.
    if (String(q.reconcile || '') === '1' && (isCron || authorized)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(await reconcile(days, R, get, H, base));
    }

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

    // 7.0: the cron run also reconciles the window it just read and keeps
    // the report as a row, so accuracy is a daily measured series.
    let reconciled = null;
    if (isCron) {
      try {
        const rep = await reconcile(days, R, get, H, base);
        await insertRow('reconciliation_reports', { days, ok: rep.ok, report: rep });
        reconciled = { ok: rep.ok, checks: rep.checks };
      } catch (e) {
        console.error('[track] reconciliation failed:', e.message);
        reconciled = { error: e.message };
      }
    }

    // a cron response is never cached: the edge cache once answered the 06:30 cron from a page read, so the
    // function (snapshot store + reconciliation) never ran (found 2026-10-22: zero reconciliation_reports rows)
    res.setHeader('Cache-Control', isCron || commentsPartial ? 'no-store' : 's-maxage=600, stale-while-revalidate=86400');
    return res.status(200).json({
      source: 'samsungtrack DB (daily Apify schedule — no duplicate pulls)',
      fetchedAt: new Date().toISOString(),
      days,
      count: out.length,
      comments: { seen: commentsSeen, matched: commentsMatched, partial: commentsPartial },
      stored,
      reconciled,
      timings,
      posts: out,
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: e.message || 'tracker read failed', timings });
  }
};

module.exports.dedupeTwins = dedupeTwins; // exposed for tests
module.exports.twinAudit = twinAudit;
module.exports.messageKey = messageKey;
