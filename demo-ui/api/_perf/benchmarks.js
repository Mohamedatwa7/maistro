// Phase 7.2 — Performance benchmarks (PERFORMANCE_INSIGHTS.md §2). Pure functions: every number on the page's
// benchmark panel is computed here from the tracker's posts and Maistro's daily snapshots, never by a model.
//
// Definitions (settled with the checker 2026-10-22):
// - Cells: platform × format (IG video vs image/carousel, X video vs text) × age band; giveaways never pooled.
// - Engagements: likes + comments + shares; Instagram shares are never collected, so IG = likes + comments.
//   Shares are read from the raw share count (`metrics.sharesRaw`) when the reader supplies it, so a real 0 is
//   a 0; without it a missing share count counts as 0 and the cell says so (`sharesAssumedZero`).
// - ER = engagements / views, only where views are collected and ≥ MIN_VIEWS (500); Facebook (no views) and
//   IG images are ranked on engagements, labelled; never views = 0, never a follower ER (no follower data).
// - Statistics: nearest-rank P25 / median / P75 / P90 — no means. A cell shows percentiles only at n ≥ MIN_N (20);
//   giveaway cells show counts only (4–10 posts per platform: they never reach 20).
// - Age = observation time − published_at; bands 0–1 d, 1–3 d, 3–7 d, ≥ 7 d (mature). Mature cells use each
//   post's current metrics; young cells use the daily snapshots (one observation per post per band), which only
//   exist since SNAPSHOTS_SINCE, so young bands fill slowly — the expected date of n ≥ 20 is reported, and none
//   while the tracker's data for the platform is stale (> 48 h).
// - Mature standings are benchmarks, not boost advice: the window to boost closes before a post is 7 days old.
// - Giveaways: a word-bounded caption pattern classifies; comment concentration only flags "suspected" for a
//   person to confirm, and a suspected post stays in the organic cell.
const MIN_N = 20, MIN_VIEWS = 500, STALE_H = 48;
const SNAPSHOTS_SINCE = '2026-10-20T06:30:00Z';
const BANDS = [['0-1d', 0, 1], ['1-3d', 1, 3], ['3-7d', 3, 7], ['mature', 7, Infinity]];

// Prize-entry wording, not prize-adjacent words. The first, word-bounded pattern ("win", "contest",
// "competition", "giveaways") flagged 60 of 732 posts on the live 90-day read (2026-10-22); read by hand, 3 were
// wrong — an event recap ("games, giveaways & plenty of fun") and a sponsored bouldering competition (twice) —
// and 2 giveaways were missed ("لربح جهاز Galaxy", "you might walk away with an exciting prize"). So: a giveaway,
// a raffle, an entry instruction or a chance to win. Never window / winter / twin / Galaxy Wink / the "Galaxy
// Win" name; "سحب" (also pull / withdraw) only as a draw; "ربح" (also profit) only as "اربح" / "لربح".
const GIVEAWAY_RE = new RegExp([
  String.raw`\bgive\s?away\b`, String.raw`\braffle\b`, String.raw`\bhow to enter\b`,
  String.raw`\b(?:enter|join) (?:the |a |our )?(?:raffle|draw|giveaway|contest|competition)\b`,
  String.raw`\bchance to win\b`, String.raw`\b(?:could|might|can) (?:still |even )?win\b`, String.raw`\b(?:comment|share|tag|reply)\b[^.!?\n]{0,30}\band win\b`,
  String.raw`^\s*win\b`, String.raw`\bwinners? (?:will be|announced)\b`, String.raw`\b(?:could|might|can) walk away with\b`,
  'مسابق[ةه]', 'اربح', 'لربح', String.raw`(?:^|\s)فز\s?ب`, 'السحب', String.raw`سحب\s+على`,
].join('|'), 'i');
const isGiveawayCaption = (caption) => GIVEAWAY_RE.test(String(caption || ''));

// second signal: mostly short entries and many repeats → suspected, for a person to confirm (stays organic)
function concentration(post) {
  const cm = post.comments || [];
  const collected = Number(post.commentsCollected) || cm.length;
  if (collected < MIN_N || !cm.length) return { suspected: false, collected, voices: cm.length };
  const short = cm.filter((c) => String(c.text || '').replace(/\s+/g, ' ').trim().length <= 60).length / cm.length;
  const ratio = cm.length / collected;
  return { suspected: short >= 0.5 && ratio <= 0.6, collected, voices: cm.length, shortShare: Math.round(short * 1000) / 1000, voiceRatio: Math.round(ratio * 1000) / 1000 };
}

function format(p) {
  const m = String(p.mediaType || '').toLowerCase();
  if (p.platform === 'instagram') return m === 'video' ? 'video' : 'image';
  if (p.platform === 'x') return m === 'text' ? 'text' : 'video';
  return 'all';
}
const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
function engagements(p, m = p.metrics || {}) {
  if (p.platform === 'instagram') return num(m.likes) + num(m.comments);
  return num(m.likes) + num(m.comments) + num(m.sharesRaw != null ? m.sharesRaw : m.shares);
}
function metricOf(p, m = p.metrics || {}) {
  if (p.platform === 'facebook' || (p.platform === 'instagram' && format(p) === 'image')) return { metric: 'engagements', value: engagements(p, m) };
  const views = Number(m.views) || 0;
  if (views < MIN_VIEWS) return { metric: 'er', value: null, excluded: `views < ${MIN_VIEWS}` };
  return { metric: 'er', value: engagements(p, m) / views };
}
const bandOf = (ageDays) => (BANDS.find(([, a, b]) => ageDays >= a && ageDays < b) || BANDS[0])[0];

// nearest rank: the smallest value with at least q of the sample at or below it
const rank = (sorted, q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
const r6 = (v) => Math.round(v * 1e6) / 1e6;
function stats(values) {
  const s = values.slice().sort((a, b) => a - b);
  return s.length >= MIN_N ? { n: s.length, p25: r6(rank(s, 0.25)), median: r6(rank(s, 0.5)), p75: r6(rank(s, 0.75)), p90: r6(rank(s, 0.9)) } : { n: s.length };
}

/** posts: /api/track posts (owned; comments + commentsCollected); snapshots: sentiment_posts rows
 *  ({post_id, platform, posted_at, metrics, at, caption}) already filtered to owned accounts;
 *  newestByPlatform: {platform: ISO of the newest post the tracker holds} for the staleness rule. */
function benchmarks({ posts, snapshots = [], now = Date.now(), windowDays = 90, newestByPlatform = {} }) {
  const live = new Map(posts.map((p) => [String(p.postId), p]));
  const gw = new Map(posts.map((p) => [String(p.postId), isGiveawayCaption(p.caption)]));
  const obs = [];
  for (const p of posts) {
    const age = (now - Date.parse(p.postedAt)) / 864e5;
    if (age >= 7) obs.push({ p, band: 'mature', m: p.metrics || {}, ...metricOf(p) });
  }
  const seen = new Set();
  for (const s of snapshots.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))) { // latest per post per band
    const id = String(s.post_id), lp = live.get(id);
    const p = { postId: id, platform: s.platform === 'twitter' ? 'x' : s.platform, mediaType: lp ? lp.mediaType : null, caption: lp ? lp.caption : s.caption, postedAt: s.posted_at };
    const age = (Date.parse(s.at) - Date.parse(s.posted_at)) / 864e5;
    if (!(age >= 0) || age >= 7) continue;
    const band = bandOf(age), k = `${id}|${band}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!gw.has(id)) gw.set(id, isGiveawayCaption(p.caption));
    obs.push({ p, band, m: s.metrics || {}, ...metricOf(p, s.metrics || {}) });
  }
  const kindOf = (p) => (gw.get(String(p.postId)) ? 'giveaway' : 'organic');
  const keyOf = (p, band) => [p.platform, format(p), band, kindOf(p)].join('|');
  const cells = new Map();
  for (const o of obs) {
    const key = keyOf(o.p, o.band);
    const c = cells.get(key) || cells.set(key, { platform: o.p.platform, format: format(o.p), band: o.band, kind: kindOf(o.p), metric: o.metric, values: [], excludedLowViews: 0, sharesAssumedZero: 0 }).get(key);
    if (o.p.platform !== 'instagram' && o.m.sharesRaw == null && o.m.shares == null) c.sharesAssumedZero++;
    if (o.value == null) { c.excludedLowViews++; continue; }
    c.values.push(o.value);
  }
  const bandIdx = (b) => BANDS.findIndex((x) => x[0] === b);
  const out = [...cells.values()].map((c) => ({
    platform: c.platform, format: c.format, band: c.band, kind: c.kind, metric: c.metric,
    ...(c.kind === 'giveaway' ? { n: c.values.length } : stats(c.values)),
    excludedLowViews: c.excludedLowViews, sharesAssumedZero: c.sharesAssumedZero,
  })).sort((a, b) => a.platform.localeCompare(b.platform) || a.format.localeCompare(b.format) || bandIdx(a.band) - bandIdx(b.band) || a.kind.localeCompare(b.kind));
  const excludedLowViews = {};
  for (const c of out) if (c.excludedLowViews) excludedLowViews[c.platform] = (excludedLowViews[c.platform] || 0) + c.excludedLowViews;

  const sinceDays = Math.max(1 / 24, (now - Date.parse(SNAPSHOTS_SINCE)) / 864e5);
  const perPost = {};
  for (const p of posts) {
    const id = String(p.postId), age = (now - Date.parse(p.postedAt)) / 864e5, band = age >= 7 ? 'mature' : bandOf(Math.max(0, age));
    const conc = concentration(p);
    const entry = { band, format: format(p), giveaway: gw.get(id) ? 'caption' : conc.suspected ? 'suspected' : null, ...(conc.suspected ? { concentration: conc } : {}) };
    const c = out.find((x) => x.platform === p.platform && x.format === format(p) && x.band === band && x.kind === kindOf(p));
    if (band !== 'mature') {
      const n = c ? c.n : 0;
      const newest = newestByPlatform[p.platform];
      const stale = !newest || now - Date.parse(newest) > STALE_H * 36e5;
      const rate = posts.filter((q) => q.platform === p.platform && format(q) === format(p) && q.postedAt >= SNAPSHOTS_SINCE).length / sinceDays;
      entry.young = n >= MIN_N ? { n } : stale
        ? { n, expected: null, reason: `no recent data — tracker last collected ${newest ? newest.slice(0, 10) : 'never'}` }
        : rate > 0
          ? { n, expected: new Date(now + ((MIN_N - n) / rate) * 864e5).toISOString().slice(0, 10), reason: 'benchmarks for posts under 7 days not yet available' }
          : { n, expected: null, reason: `benchmarks for posts under 7 days not yet available — no ${format(p) === 'all' ? '' : `${format(p)} `}posts since snapshots began, so no expected date` };
    }
    const mv = metricOf(p);
    if (mv.excluded) entry.excluded = mv.excluded;
    if (c && c.p75 != null && mv.value != null && kindOf(p) === 'organic') {
      const vals = obs.filter((o) => o.band === band && o.value != null && keyOf(o.p, o.band) === keyOf(p, band)).map((o) => o.value);
      entry.standing = { metric: mv.metric, value: r6(mv.value), percentile: Math.round((vals.filter((v) => v <= mv.value).length / vals.length) * 100), of: c.n, aboveP75: mv.value >= c.p75, note: band === 'mature' ? 'benchmark among mature posts — not boost advice' : null };
    }
    perPost[id] = entry;
  }
  return { asOf: new Date(now).toISOString(), windowDays, minN: MIN_N, minViews: MIN_VIEWS, snapshotsSince: SNAPSHOTS_SINCE, excludedLowViews, cells: out, posts: perPost };
}

module.exports = { benchmarks, isGiveawayCaption, concentration, format, engagements, metricOf, bandOf, rank, stats, MIN_N, MIN_VIEWS, SNAPSHOTS_SINCE };
