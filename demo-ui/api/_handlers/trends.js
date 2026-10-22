const { fetchT } = require('../_http.js');
// GET /api/trends — pulls trends from TrendRadar (kymah.com) and returns the
// TOP 10 director-safe, Samsung-fit trends, curated by Claude.
//
// TrendRadar has no public API, but its Next.js flight payload embeds the full
// trend store as JSON (names, numeric fit 0-100 with reasons, stage, growth,
// engagement, hashtags, the trend SOUND with commercial-clearance status, the
// format mechanic, and creator clips). We parse that instead of the markup —
// far richer and far less brittle.
//
// Curation (skippable with ?all=1): Claude receives every trend and selects
// exactly 10 that are (a) real, NAMED, re-creatable content formats — not
// news, sports results or IP-ripping fan edits — and (b) safe to put in
// front of Samsung directors: nothing suggestive or revealing, no tragedy or
// fear content, no copyright-risky material. Falls back to deterministic
// rules if the key is missing or the call fails. Edge-cached 15 minutes.

const SOURCE = 'https://www.kymah.com/';
const MODEL = 'claude-opus-4-8';

// trends_cache (ADR-005, M4): the last good board — raw and curated — lives
// in Maistro's database. A read younger than CACHE_FRESH_S is served from
// it (no upstream call, no curation call); older, the board is refreshed on
// read and the cache rewritten; when the refresh fails the cached board is
// served with stale:true instead of a 502. On the Hobby plan there is no
// hourly cron, so refresh-on-read is the whole mechanism. Caching is skipped
// when the database is not configured (tests, local runs).
const { queryRows, upsertRows } = require('../_supabase.js');
const { isCron } = require('../_auth.js');
const CACHE_KEY = 'board';
const CACHE_FRESH_S = 3600;
const cacheConfigured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

async function readCache() {
  if (!cacheConfigured()) return null;
  try {
    const rows = await queryRows('trends_cache', `select=*&id=eq.${CACHE_KEY}&limit=1`);
    const row = rows[0];
    if (!row || !row.payload || !Array.isArray(row.payload.raw)) return null;
    return { ...row.payload, fetchedAt: row.fetched_at, ageS: Math.max(0, Math.round((Date.now() - new Date(row.fetched_at).getTime()) / 1000)), lastError: row.error || null };
  } catch (e) {
    console.warn('[trends] cache read failed:', e.message);
    return null;
  }
}
async function writeCache(payload, error, fetchedAt) {
  if (!cacheConfigured()) return;
  try {
    await upsertRows('trends_cache', [{ id: CACHE_KEY, payload, source: payload.source || null, board_generated_at: payload.boardGeneratedAt || null, fetched_at: fetchedAt || new Date().toISOString(), error: error || null }], 'id');
  } catch (e) {
    console.warn('[trends] cache write failed:', e.message);
  }
}
// Phase 5.0: every fetched board also lands as per-trend snapshot rows, so
// lifecycle math (velocity, acceleration, age, days on board) is computed
// in code from Maistro's own history. Records that fail the minimal schema
// (a name and an id) are counted and logged, never written.
const { insertRows } = require('../_supabase.js');
function snapshotRow(t, meta) {
  if (!t || typeof t !== 'object' || !t.name || !(t.trendId || t.id)) return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    fetched_at: meta.fetchedAt, board_generated_at: meta.boardGeneratedAt || null, source: meta.source || 'unknown',
    trend_id: String(t.trendId || t.id), name: String(t.name).slice(0, 300), stage: t.status || null, kind: t.kind || null, category: t.category || null,
    growth_pct_per_day: n(t.momentumPerDay), eng: n(t.avgEngagementPct), views_wk: n(t.viewsPerWeek) == null ? null : Math.round(t.viewsPerWeek),
    fit_strength: t.samsungFit && n(t.samsungFit.score) != null ? Math.round(t.samsungFit.score) : null,
    on_brand: typeof t.onBrand === 'boolean' ? t.onBrand : null, signal_strength: n(t.signalStrength) == null ? null : Math.round(t.signalStrength),
    durability: t.stayingPower || null, sound_music_id: t.sound && t.sound.musicId ? String(t.sound.musicId) : null,
    sound_cleared: t.sound && typeof t.sound.cleared === 'boolean' ? t.sound.cleared : null,
    raw: t,
  };
}
async function writeSnapshots(board) {
  if (!cacheConfigured() || !board || !Array.isArray(board.raw)) return { written: 0, rejected: 0 };
  const meta = { fetchedAt: new Date().toISOString(), boardGeneratedAt: board.boardGeneratedAt, source: board.source };
  const rows = []; let rejected = 0;
  for (const t of board.raw) { const r = snapshotRow(t, meta); if (r) rows.push(r); else rejected++; }
  if (rejected) console.warn(`[trends] ${rejected} malformed trend record(s) rejected from the snapshot`);
  try { if (rows.length) await insertRows('trend_snapshots', rows); } catch (e) { console.warn('[trends] snapshot write failed:', e.message); return { written: 0, rejected, error: e.message }; }
  return { written: rows.length, rejected };
}
async function markCacheError(error) {
  if (!cacheConfigured()) return;
  try {
    const { patchRows } = require('../_supabase.js');
    await patchRows('trends_cache', `id=eq.${CACHE_KEY}`, { error: String(error).slice(0, 300) });
  } catch (e) { /* the stale answer still goes out */ }
}

// Pull the board from upstream: agent API first, page scrape as fallback.
async function fetchBoard() {
  let trends = null, source = null, live = true, boardGeneratedAt = null, total = null;
  try {
    const a = await agentTrends();
    if (a) { trends = a.trends; source = 'TrendRadar agent API'; live = a.live; boardGeneratedAt = a.boardGeneratedAt; total = a.total; }
  } catch (e) {
    console.warn('[trends] agent API failed, falling back to the page scrape:', e.message);
  }
  if (!trends) {
    const r = await fetchT(SOURCE, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; MaistroDemo/1.0)', accept: 'text/html' },
    }, { timeoutMs: 20000, retries: 1 });
    if (!r.ok) throw new Error(`kymah.com responded ${r.status}`);
    const html = await r.text();
    trends = extractTrendStore(html).map(normalize).filter((t) => t.name);
    source = 'TrendRadar (kymah.com)';
    total = trends.length;
  }
  return { raw: trends, source, live, boardGeneratedAt, total };
}

// Primary source (M4, ADR-005): Trend Radar's agent API — read-only,
// bearer-gated, fit-ranked, carries the editorial brief, scored products,
// reference clips and the sound's commercial-use read. The page scrape below
// stays as the fallback when the key is missing or the API fails, so the feed
// never goes blank because one path broke (2026-10-20 lesson). Collection is
// never triggered: this is a GET of the published board.
const AGENT_BASE = (process.env.TRENDRADAR_BASE_URL || 'https://trend-radar-iota-one.vercel.app').replace(/\/$/, '');

function parseGrowth(g) {
  const m = String(g || '').match(/([+\-−]?[\d.]+)\s*%/);
  return m ? parseFloat(m[1].replace('−', '-')) : null;
}

// AgentTrend → the shape this endpoint has always returned (API.md), plus
// additive fields the agent carries that the page never had.
function normalizeAgent(t) {
  const fit = t.fit || null;
  const snd = t.sound || null;
  const cu = (snd && snd.commercialUse) || null;
  const score = fit && typeof fit.strength === 'number' ? fit.strength : null;
  return {
    id: slug(t.name || t.id || 'trend'),
    name: t.name || null,
    status: t.stage || null,
    region: t.scope === 'global' ? 'Global' : (t.scope || null),
    lang: (t.lang || '').toUpperCase() || null,
    category: t.category || t.kind || null,
    samsungFit: {
      strength: score != null && score >= 70 ? 'strong' : 'fit',
      score,
      ownableBeat: fit ? fit.beat || null : null,
      rationale: fit ? fit.reason || null : null,
      raw: fit ? fit.reason || null : null,
    },
    momentumPerDay: parseGrowth(t.growth),
    viewsPerWeek: parseCount(t.viewsWk),
    avgEngagementPct: typeof t.eng === 'number' ? t.eng : null,
    stayingPower: t.durabilityClass || null,
    mechanic: (t.brief && t.brief.mechanic) || (t.format && t.format.mechanic) || null,
    why: t.why || null,
    tags: Array.isArray(t.tags) ? t.tags.filter(Boolean) : [],
    sound: snd && snd.title ? {
      title: snd.title,
      author: snd.author || null,
      musicId: snd.musicId || null,
      cue: snd.cue || null,
      cleared: cu ? cu.cleared === true : false,
      clearedCheckedAt: cu ? cu.checkedAt || null : null,
    } : null,
    clips: (t.clips || []).slice(0, 4).map((c) => ({
      handle: c.handle || null,
      poster: c.poster || null,
      views: parseCount(c.views),
      vid: c.vid || null,
      sound: c.sound || null,
    })),
    // additive (agent API only)
    trendId: t.id || null,
    onBrand: typeof t.onBrand === 'boolean' ? t.onBrand : null,
    signalStrength: typeof t.signalStrength === 'number' ? t.signalStrength : null,
    brief: t.brief || null,
    products: Array.isArray(t.products) ? t.products : [],
  };
}

async function agentTrends() {
  const key = process.env.TRENDRADAR_AGENT_KEY;
  if (!key) return null;
  const r = await fetchT(`${AGENT_BASE}/api/agent/trends?limit=200`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': 'MaistroDemo/1.0' },
  }, { timeoutMs: 20000, retries: 1 });
  if (!r.ok) throw new Error(`agent API responded ${r.status}`);
  const d = await r.json();
  if (!d || !Array.isArray(d.trends)) throw new Error('agent API returned no trends array');
  return {
    live: d.live !== false,
    boardGeneratedAt: d.generatedAt || null,
    total: typeof d.total === 'number' ? d.total : d.trends.length,
    trends: d.trends.map(normalizeAgent).filter((t) => t.name),
  };
}

function parseCount(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function extractTrendStore(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => m[1]);
  if (!chunks.length) throw new Error('no flight payload found (markup may have changed)');
  let payload = '';
  for (const c of chunks) {
    try { payload += JSON.parse('"' + c + '"'); }
    catch { payload += c.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\'); }
  }
  const k = payload.indexOf('"trends":[{');
  if (k < 0) throw new Error('no trends array in payload');
  const start = payload.indexOf('[', k);
  let depth = 0, end = -1, inStr = false, escp = false;
  for (let i = start; i < payload.length; i++) {
    const ch = payload[i];
    if (inStr) { if (escp) escp = false; else if (ch === '\\') escp = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (!depth) { end = i; break; } }
  }
  if (end < 0) throw new Error('unterminated trends array');
  return JSON.parse(payload.slice(start, end + 1));
}

function normalize(t) {
  const fit = t.fit || {};
  const snd = t.sound || {};
  const cu = snd.commercialUse || {};
  const brief = t.brief || {};
  const growth = (() => {
    const m = String(t.growth || '').match(/([+\-−]?[\d.]+)\s*%/);
    return m ? parseFloat(m[1].replace('−', '-')) : null;
  })();
  const fitScore = typeof fit.strength === 'number' ? fit.strength : null;
  return {
    id: slug(t.name || t.id || 'trend'),
    name: t.name || null,
    status: t.stage || null,
    region: t.scope === 'global' ? 'Global' : (t.scope || null),
    lang: (t.lang || '').toUpperCase() || null,
    category: brief.category || t.kind || null,
    samsungFit: {
      strength: fitScore != null && fitScore >= 70 ? 'strong' : 'fit',
      score: fitScore,
      ownableBeat: fit.beat || null,
      rationale: fit.reason || null,
      raw: fit.reason || null,
    },
    momentumPerDay: growth,
    viewsPerWeek: null,
    avgEngagementPct: typeof t.eng === 'number' ? t.eng : null,
    stayingPower: null,
    mechanic: brief.mechanic || null,
    why: t.why || null,
    tags: Array.isArray(t.tags) ? t.tags.filter(Boolean) : [],
    sound: snd.title ? {
      title: snd.title,
      author: snd.author || null,
      musicId: snd.musicId || null,
      cue: snd.cue || null,
      cleared: cu.cleared === true,
      clearedCheckedAt: cu.checkedAt || null,
    } : null,
    clips: (t.thumbs || []).slice(0, 4).map((c) => ({
      handle: c.handle || null,
      poster: c.poster || null,
      views: parseCount(c.views),
      vid: c.vid || null,
      sound: c.sound || null,
    })),
  };
}

function ruleCurate(trends) {
  const bad = /death|breach|sad edit|fancam|vs\s|betray/i;
  return trends
    .filter((t) => t.name && (t.samsungFit.score || 0) >= 40)
    .filter((t) => !/sport/i.test(t.category || ''))
    .filter((t) => !bad.test(t.name))
    .sort((a, b) => (b.samsungFit.score || 0) - (a.samsungFit.score || 0) || (b.avgEngagementPct || 0) - (a.avgEngagementPct || 0))
    .slice(0, 10);
}

async function claudeCurate(trends) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ timeout: 45000 });
  const digest = trends.map((t) => ({
    id: t.id, name: t.name, category: t.category, stage: t.status,
    samsungFitScore: t.samsungFit.score, fitReason: t.samsungFit.rationale,
    engagementPct: t.avgEngagementPct,
    mechanic: (t.mechanic || '').slice(0, 300),
    hashtags: t.tags, sound: t.sound ? { title: t.sound.title, author: t.sound.author, commerciallyCleared: t.sound.cleared } : null,
  }));
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    thinking: { type: 'adaptive' },
    system:
      'You curate the trend feed of MAISTRO, Samsung Gulf\'s content platform. From the candidate ' +
      'trends, select EXACTLY 10 (or all, if fewer qualify) that Samsung\'s social team should build ' +
      'campaigns on, ranked most to least suitable.\n' +
      'MUST be: a real, NAMED, re-creatable content format a brand can produce its own version of.\n' +
      'EXCLUDE: news and sports results (not creatable formats); fan edits of licensed film/TV/music IP; ' +
      'anything a Samsung director would object to — suggestive or revealing choreography/posing, ' +
      'tragedy, death or grief themes, fear/scare content (e.g. data-breach panic), crude humor, ' +
      'gambling, politics or religion.\n' +
      'PREFER: higher samsungFitScore, peaking stage, higher engagement, sounds that are original or ' +
      'commercially cleared.\n' +
      'For each selected trend also list the 3-5 hashtags the community actually posts it under ' +
      '(lowercase, no # prefix — the trend\'s own tag plus the obvious companions, e.g. a makeup ' +
      'trend → its named tag, "makeuptrend", "beautytok"). Use the provided hashtags when present.',
    messages: [{ role: 'user', content: 'CANDIDATES:\n' + JSON.stringify(digest, null, 1) + '\n\nSelect and rank the 10.' }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            selected: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  reason: { type: 'string', description: 'One short line: why it made the cut' },
                  hashtags: { type: 'array', items: { type: 'string' }, description: '3-5 community hashtags, lowercase, no # prefix' },
                },
                required: ['id', 'reason', 'hashtags'],
                additionalProperties: false,
              },
            },
          },
          required: ['selected'],
          additionalProperties: false,
        },
      },
    },
  });
  const text = response.content.find((b) => b.type === 'text');
  if (!text) return null;
  const out = JSON.parse(text.text);
  const byId = new Map(trends.map((t) => [t.id, t]));
  const picked = out.selected.map((s) => {
    const t = byId.get(s.id);
    if (!t) return null;
    const tags = t.tags.length ? t.tags
      : (s.hashtags || []).map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 5);
    return { ...t, curatorNote: s.reason, tags };
  }).filter(Boolean).slice(0, 10);
  return picked.length ? picked : null;
}

const DECISIONS = ['pick', 'skip', 'reject', 'override_veto', 'override_score'];
const REASON_CODES = ['off_brand', 'unsafe', 'cultural', 'no_product', 'too_late', 'unproducible', 'saturated', 'audio', 'weak_hook', 'other', 'veto_wrong', 'score_wrong', 'good_opportunity'];

module.exports = async (req, res) => {
  const startedAt = Date.now();
  try {
    const q = req.query || {};
    // 5.7: every human pick / skip / rejection / override is a row (session)
    if (req.method === 'POST') {
      const { requireSession, refreshMember } = require('../_auth.js');
      if (!requireSession(req, res)) return;
      if (!(await refreshMember(req, res))) return;
      res.setHeader('Cache-Control', 'no-store');
      if (!cacheConfigured()) return res.status(503).json({ error: 'storage is not configured' });
      const b = req.body || {};
      if (!DECISIONS.includes(b.decision)) return res.status(400).json({ error: `decision must be one of ${DECISIONS.join(', ')}` });
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(b.trendId || ''))) return res.status(400).json({ error: 'trendId is required' });
      const needsReason = ['reject', 'override_veto', 'override_score'].includes(b.decision);
      if (needsReason && !REASON_CODES.includes(b.reasonCode)) return res.status(400).json({ error: `reasonCode must be one of ${REASON_CODES.join(', ')}` });
      if (needsReason && !String(b.reason || '').trim()) return res.status(400).json({ error: 'a written reason is required' });
      try {
        const { insertRows } = require('../_supabase.js');
        const [row] = await insertRows('trend_decisions', [{
          trend_id: String(b.trendId), score_id: Number.isInteger(b.scoreId) ? b.scoreId : null, decision: b.decision,
          reason_code: b.reasonCode || null, reason: b.reason ? String(b.reason).slice(0, 2000) : null,
          decided_by: req.member ? req.member.id : null, name_as_signed: (req.member && req.member.name) || String(b.name || '').slice(0, 120) || null,
        }], { returning: true });
        return res.status(200).json({ ok: true, decision: row || null });
      } catch (e) { return res.status(502).json({ error: String(e.message || e) }); }
    }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }
    // Hourly cron (Pro plan, vercel.json): refresh the stored board and its
    // curation unconditionally, so reads in the next hour are all hits.
    if (isCron(req)) {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const board = await fetchBoard();
        let curated = [], curatedBy = 'none';
        if (board.raw.length) {
          try { const picked = await claudeCurate(board.raw); curated = picked || ruleCurate(board.raw); curatedBy = picked ? 'claude' : 'rules'; }
          catch { curated = ruleCurate(board.raw); curatedBy = 'rules'; }
        }
        await writeCache({ ...board, curated, curatedBy });
        const snap = await writeSnapshots(board);
        // 5.4: veto-then-score the board (judgements cached per trend × board × prompt version)
        let scoring = null;
        if (cacheConfigured() && process.env.MAISTRO_TREND_SCORING !== '0') {
          // the whole cron (fetch, curation, snapshots, scoring, write) must end
          // inside the function's maxDuration; scoring gets the remainder minus a margin
          const maxS = Number(process.env.MAISTRO_FUNCTION_MAX_S || 300);
          try { const { scoreBoard } = require('../_trends/engine.js'); scoring = (await scoreBoard(board, { deadline: startedAt + (maxS - 45) * 1000 })).summary; }
          catch (e) { scoring = { error: String(e.message || e).slice(0, 200) }; }
        }
        return res.status(200).json({ ok: true, refreshed: true, source: board.source, boardTotal: board.total, curated: curated.length, curatedBy, snapshots: snap, scoring, at: new Date().toISOString() });
      } catch (e) {
        await markCacheError(e.message || e);
        return res.status(502).json({ ok: false, refreshed: false, error: String(e.message || e) });
      }
    }
    // 5.5: the scored view (ranked / rejected / needs review) for session holders
    // 5.9: the judge's guard-rail eval (synthetic must-flag / must-pass trends) with the live prompt;
    // session-gated, at most once per 10 minutes, never written to trend_scores
    if (String(q.view || '') === 'eval') {
      const { requireSession } = require('../_auth.js');
      if (!requireSession(req, res)) return;
      res.setHeader('Cache-Control', 'no-store');
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured' });
      try {
        const { queryRows } = require('../_supabase.js');
        const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const recent = cacheConfigured() ? await queryRows('generation_records', `select=id&kind=eq.trend_judge&params->>trendId=eq.eval-explicit-sound&at=gte.${encodeURIComponent(since)}&limit=1`) : [];
        if (recent.length) return res.status(429).json({ error: 'the eval ran in the last 10 minutes' });
        const { CASES, grade } = require('../_trends/eval-set.js');
        const { judgeTrend } = require('../_trends/judge.js');
        const { PRODUCT_CATALOG } = require('../_brand.js');
        const P = require('../_trends/prompts/profile-v1.js');
        const computed = { lifecycle: { stage: 'rising' }, timing: { postBy: null, remainingDays: 7 }, calendarEvents: [], snapshotsSeen: 2 };
        const results = await Promise.all(CASES.map(async (c) => {
          try { const r = await judgeTrend({ trend: c.trend, computed, catalog: PRODUCT_CATALOG, calendarNote: '' }); if (!r || !r.judgement) return { id: c.id, ok: false, detail: r ? r.error : 'no answer' }; const g = grade(c, r.judgement); return { id: c.id, expect: c.expect, ...g, rationale: Object.fromEntries(['safety', 'culture', 'origin', 'audioExplicit'].map((k) => [k, r.judgement[k].rationale.slice(0, 200)])) }; }
          catch (e) { return { id: c.id, ok: false, detail: String(e.message || e).slice(0, 200) }; }
        }));
        return res.status(200).json({ promptVersion: P.VERSION, passed: results.filter((r) => r.ok).length, total: results.length, results });
      } catch (e) { return res.status(502).json({ error: String(e.message || e) }); }
    }
    if (String(q.view || '') === 'scored') {
      const { requireSession } = require('../_auth.js');
      if (!requireSession(req, res)) return;
      res.setHeader('Cache-Control', 'no-store');
      if (!cacheConfigured()) return res.status(503).json({ error: 'storage is not configured' });
      try { const { latestScores } = require('../_trends/engine.js'); return res.status(200).json(await latestScores()); }
      catch (e) { return res.status(502).json({ error: String(e.message || e) }); }
    }
    let board = null, cache = { hit: false, stale: false, fetchedAt: null, ageS: null };
    const cached = await readCache();
    if (cached && cached.ageS < CACHE_FRESH_S) {
      board = cached; cache = { hit: true, stale: false, fetchedAt: cached.fetchedAt, ageS: cached.ageS };
    } else {
      try {
        board = await fetchBoard();
        cache = { hit: false, stale: false, fetchedAt: new Date().toISOString(), ageS: 0 };
        await writeSnapshots(board);
      } catch (e) {
        if (!cached) throw e;
        // upstream is down but we hold a board: serve it, say so, remember why
        board = cached; cache = { hit: true, stale: true, fetchedAt: cached.fetchedAt, ageS: cached.ageS, error: String(e.message || e) };
        await markCacheError(e.message || e);
      }
    }
    const { source, live, boardGeneratedAt, total } = board;
    let trends = board.raw.slice();
    if (!trends.length) {
      // an empty board is a state, not an error (the page renders BOARD EMPTY)
      if (!cache.hit) await writeCache({ ...board, curated: [], curatedBy: 'none' });
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({ source, fetchedAt: new Date().toISOString(), live, boardGeneratedAt, boardTotal: 0, curatedBy: 'none', count: 0, trends: [], cache });
    }

    let curatedBy = 'none';
    if (!q.all) {
      if (cache.hit && Array.isArray(board.curated) && board.curated.length) {
        trends = board.curated.slice(); curatedBy = board.curatedBy || 'rules';
      } else {
        let picked = null;
        try { picked = await claudeCurate(trends); curatedBy = picked ? 'claude' : 'rules'; }
        catch { curatedBy = 'rules'; }
        trends = picked || ruleCurate(trends);
        // a fresh board: write it with its curation; a hit whose row had no
        // curation yet (filled by a raw read): write the curation back but
        // keep the row's fetched_at so the hour does not restart
        if (!cache.hit) await writeCache({ ...board, curated: trends, curatedBy });
        else if (!cache.stale) await writeCache({ raw: board.raw, source, live, boardGeneratedAt, total, curated: trends, curatedBy }, null, board.fetchedAt);
      }
    } else {
      trends.sort((a, b) => (b.samsungFit.score || 0) - (a.samsungFit.score || 0));
      // a raw miss stores the new board WITHOUT a curation (the previous top
      // 10 may name trends no longer on the board); the next curated read fills it
      if (!cache.hit) await writeCache({ ...board, curated: [], curatedBy: 'none' });
    }

    // consumer filters kept for the external Hermes agent
    if (q.strength) trends = trends.filter((t) => t.samsungFit.strength === q.strength);
    if (q.minScore) trends = trends.filter((t) => (t.samsungFit.score || 0) >= parseInt(q.minScore, 10));
    if (q.id) trends = trends.filter((t) => t.id === q.id);
    if (q.limit) trends = trends.slice(0, Math.max(1, parseInt(q.limit, 10) || trends.length));

    res.setHeader('Cache-Control', cache.stale ? 's-maxage=120, stale-while-revalidate=600' : 's-maxage=900, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
      source,
      fetchedAt: cache.fetchedAt || new Date().toISOString(),
      live,
      boardGeneratedAt,
      boardTotal: total,
      curatedBy,
      count: trends.length,
      trends,
      cache,
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(err.message || err) });
  }
};

module.exports.normalizeAgent = normalizeAgent; // exposed for tests
module.exports.snapshotRow = snapshotRow;
