// Live reference videos for each moment: TikToks posted in the past week, from TikHub's keyword
// post search (the endpoint Trend Radar uses, flat $0.001 a call; config.json in Trend Radar).
// Two searches per moment: its main keyword worldwide, and the keyword plus its first market's
// city, because TikHub's region parameter is not honoured but a city in the query is (measured
// 2026-10-29: "halloween dubai" → UAE and Qatar creators; Arabic keywords return almost nothing).
// Gulf creators rank first, then views. Captions pass a word blocklist, then one Claude check
// when it is available (`captionsCheckedBy` says which). Only the hourly cron calls this, at
// most every REFRESH_MS per moment and MAX_CALLS per run; page reads never spend.
const { fetchT } = require('../_http.js');

const BASE = 'https://api.tikhub.io';
const SEARCH = '/api/v1/tiktok/app/v3/fetch_general_search_result';
const GULF = ['AE', 'SA', 'KW', 'QA', 'BH', 'OM'];
const CITY = { AE: 'dubai', SA: 'riyadh', KW: 'kuwait', QA: 'qatar', BH: 'bahrain', OM: 'oman' };
const REFRESH_MS = 6 * 3600e3, EMPTY_RETRY_MS = 3600e3, MAX_CALLS = 40, PER_MOMENT = 6, MIN_PLAYS = 5000, MAX_AGE_DAYS = 14;
const MODEL = () => process.env.MAISTRO_MOMENTS_MODEL || 'claude-sonnet-5-5';
// captions a consumer-electronics brand should never put in front of its team as a reference
const BLOCK = /\b(nsfw|onlyfans|only fans|18\+|sexy|nude|naked|lingerie|bikini|twerk|gore|murder|kill(ing)?|drunk|weed|vape|casino|bet(ting)?|sophie rain|aishah sofey)\b/i;

/** The queries for one moment: its main keyword, and that keyword with its first market's city. */
function queriesFor(m) {
  const kw = String((m.keywords && m.keywords.find((k) => /[a-z]/i.test(k) && k.length >= 3)) || m.label || '').trim().toLowerCase();
  if (!kw) return [];
  const city = CITY[(m.markets || [])[0]];
  return [kw, city && !kw.includes(city) ? `${kw} ${city}` : null].filter(Boolean);
}

/** A TikHub search response → our clip shape (the same { vid, handle } the trend cards play). */
function clipsOf(data, now = Date.now()) {
  const d = (data && data.data) || {};
  const list = (Array.isArray(d.data) ? d.data : Array.isArray(d.aweme_list) ? d.aweme_list : []).map((r) => (r && (r.aweme_info || r.item)) || r).filter(Boolean);
  return list.map((a) => ({
    vid: String(a.aweme_id || ''),
    handle: a.author && a.author.unique_id ? `@${a.author.unique_id}` : null,
    region: a.region || null,
    views: Number(a.statistics && a.statistics.play_count) || 0,
    likes: Number(a.statistics && a.statistics.digg_count) || 0,
    postedAt: a.create_time ? new Date(a.create_time * 1000).toISOString() : null,
    caption: String(a.desc || '').slice(0, 200),
  })).filter((c) => /^\d{8,25}$/.test(c.vid) && c.postedAt && now - new Date(c.postedAt).getTime() <= MAX_AGE_DAYS * 864e5 && c.views >= MIN_PLAYS && !BLOCK.test(c.caption) && !BLOCK.test(c.handle || ''));
}

async function search(keyword) {
  const key = process.env.TIKHUB_API_KEY;
  const qs = new URLSearchParams({ keyword, count: '20', offset: '0', sort_type: '1', publish_time: '7' });
  const r = await fetchT(`${BASE}${SEARCH}?${qs}`, { headers: { Authorization: `Bearer ${key}`, accept: 'application/json' } }, { timeoutMs: 20000, retries: 1 });
  if (!r.ok) throw new Error(`TikHub search "${keyword}": ${r.status}`);
  return clipsOf(await r.json());
}

/** Gulf creators first, then views; one clip per creator. */
function rank(clips) {
  const seen = new Set(), out = [];
  for (const c of clips.slice().sort((a, b) => (GULF.includes(b.region) - GULF.includes(a.region)) || b.views - a.views)) {
    if (seen.has(c.vid) || (c.handle && seen.has(c.handle))) continue;
    seen.add(c.vid); if (c.handle) seen.add(c.handle);
    out.push(c);
  }
  return out;
}

const CAPTION_SCHEMA = { type: 'object', properties: { ok: { type: 'array', items: { type: 'string' }, description: 'the vids whose caption and creator are fine for a Samsung team to watch as a reference' } }, required: ['ok'], additionalProperties: false };
/** One Claude pass over every caption: keeps what a Samsung Gulf team could watch as a reference. Null when unavailable. */
async function checkCaptions(clips, { client } = {}) {
  if (!clips.length) return new Set();
  if (!client && !process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 60000, maxRetries: 1 });
  const response = await c.messages.create({
    model: MODEL(),
    max_tokens: 4000,
    // 2026-10-29: "when unsure, leave it out" rejected every Halloween video (costumes, decorations): only clear signals count now
    system: 'You screen TikTok reference videos for Samsung Gulf\'s social team by caption and creator handle. These are creative ' +
      'references for a moment (a holiday, a sale, a race, a festival), so ordinary content fits: costumes, decorations, food, outfits, ' +
      'events, vlogs, humour, products, dances. Leave a video out only when its caption or creator clearly signals sexual or suggestive ' +
      'content, an adult-content creator, gore, drugs, alcohol, gambling, politics, mocking religion, hate, or a dangerous stunt.',
    messages: [{ role: 'user', content: `VIDEOS:\n${JSON.stringify(clips.map((x) => ({ vid: x.vid, creator: x.handle, caption: x.caption })), null, 1)}\n\nList the vids to keep.` }],
    output_config: { format: { type: 'json_schema', schema: CAPTION_SCHEMA }, effort: 'low' },
  });
  const text = response.content && response.content.find((b) => b.type === 'text');
  if (!text) return null;
  return new Set((JSON.parse(text.text).ok || []).map(String));
}

/** Refresh the videos of the moments that are due. `stored` is the previous { byId }; returns the new one.
 *  moments: [{ id, label, keywords, markets }] — the upcoming ones worth referencing plus the breaking ones. */
async function refresh(moments, stored = {}, { now = Date.now(), client } = {}) {
  const errors = [];
  if (!process.env.TIKHUB_API_KEY) return { byId: stored.byId || {}, calls: 0, errors: ['TIKHUB_API_KEY is not configured'], captionsCheckedBy: 'none' };
  const prev = stored.byId || {};
  const byId = {};
  for (const m of moments) if (prev[m.id]) byId[m.id] = prev[m.id]; // moments no longer listed drop out
  // a moment that came back empty retries after an hour, not six
  const due = moments.filter((m) => !prev[m.id] || now - new Date(prev[m.id].at).getTime() >= ((prev[m.id].videos || []).length ? REFRESH_MS : EMPTY_RETRY_MS))
    .sort((a, b) => (prev[a.id] ? new Date(prev[a.id].at).getTime() : 0) - (prev[b.id] ? new Date(prev[b.id].at).getTime() : 0));
  let calls = 0;
  const found = {};
  for (const m of due) {
    const qs = queriesFor(m);
    if (!qs.length || calls + qs.length > MAX_CALLS) continue;
    const clips = [];
    for (const q of qs) {
      calls++;
      try { clips.push(...await search(q)); } catch (e) { errors.push(String(e.message || e)); }
    }
    found[m.id] = { queries: qs, clips: rank(clips).slice(0, PER_MOMENT * 2) };
  }
  const all = Object.values(found).flatMap((f) => f.clips);
  let ok = null, captionsCheckedBy = 'blocklist';
  try { ok = await checkCaptions(all, { client }); if (ok) captionsCheckedBy = 'claude'; } catch (e) { errors.push(`caption check: ${String(e.message || e)}`); }
  for (const [id, f] of Object.entries(found)) {
    const kept = f.clips.filter((c) => !ok || ok.has(c.vid));
    byId[id] = { at: new Date(now).toISOString(), queries: f.queries, captionsCheckedBy, screenedOut: f.clips.length - kept.length, videos: kept.slice(0, PER_MOMENT) };
  }
  return { byId, calls, errors, captionsCheckedBy };
}

module.exports = { queriesFor, clipsOf, rank, checkCaptions, refresh, REFRESH_MS, MAX_CALLS, PER_MOMENT };
