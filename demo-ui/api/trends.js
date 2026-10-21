// GET /api/trends — pulls trends from TrendRadar (kymah.com) and returns the
// TOP 10 director-safe, Samsung-fit trends, curated by Claude.
//
// TrendRadar has no public API, but its Next.js flight payload embeds its
// trend store as JSON. The store's shape changed in Oct 2026: the legacy
// "trends" array (names + numeric Samsung fit) now holds a single observed
// sound, and the real cards live in "liveCards" (named formats/dances with a
// recipe, the trend SOUND with commercial-clearance status, velocity,
// confidence and example clips), "watchlist" (sounds gaining a format) and
// "topics" (a few of which are classified as a caption format). We read all
// of them, normalise to one shape and de-duplicate by name. Samsung fit is no
// longer scored upstream, so the curator assigns it (see claudeCurate).
//
// Curation (skippable with ?all=1): Claude receives every candidate and
// selects up to 10 that are (a) real, NAMED, re-creatable content formats —
// not news, sports results or IP-ripping fan edits — and (b) safe to put in
// front of Samsung directors: nothing suggestive or revealing, no tragedy or
// fear content, no copyright-risky material. Falls back to deterministic
// rules if the key is missing or the call fails. Edge-cached 15 minutes.

const SOURCE = 'https://www.kymah.com/';
const MODEL = 'claude-opus-4-8';

function parseCount(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? Math.round(s) : null;
  const m = String(s).trim().match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// Concatenate the RSC flight chunks into one decoded string.
function extractPayload(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => m[1]);
  if (!chunks.length) throw new Error('no flight payload found (markup may have changed)');
  let payload = '';
  for (const c of chunks) {
    try { payload += JSON.parse('"' + c + '"'); }
    catch { payload += c.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\'); }
  }
  return payload;
}

// Pull the first `"<key>":[...]` array of objects out of the payload, or [].
function extractArray(payload, key) {
  const k = payload.indexOf('"' + key + '":[{');
  if (k < 0) return [];
  const start = payload.indexOf('[', k);
  let depth = 0, end = -1, inStr = false, escp = false;
  for (let i = start; i < payload.length; i++) {
    const ch = payload[i];
    if (inStr) { if (escp) escp = false; else if (ch === '\\') escp = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (!depth) { end = i; break; } }
  }
  if (end < 0) return [];
  try { return JSON.parse(payload.slice(start, end + 1)); }
  catch { return []; }
}

// Legacy entry point kept for callers/docs: the old "trends" array.
function extractTrendStore(html) {
  return extractArray(extractPayload(html), 'trends');
}

function extractStore(html) {
  const payload = extractPayload(html);
  return {
    trends: extractArray(payload, 'trends'),
    liveCards: extractArray(payload, 'liveCards'),
    watchlist: extractArray(payload, 'watchlist'),
    topics: extractArray(payload, 'topics'),
  };
}

function clipsOf(list, soundTitle) {
  return (list || []).slice(0, 4).map((c) => ({
    handle: c.handle || c.author || null,
    poster: c.poster || null,
    views: parseCount(c.views),
    vid: c.vid || null,
    sound: c.sound || soundTitle || null,
  }));
}

// Mean likes/views across the example clips, as a percentage (legacy `eng`).
function engagementOf(list) {
  const r = (list || []).map((c) => (c.likes > 0 && c.views > 0 ? c.likes / c.views : null)).filter((x) => x != null);
  if (!r.length) return null;
  return Math.round((r.reduce((a, b) => a + b, 0) / r.length) * 1000) / 10;
}

function regionOf(gccShare) {
  return typeof gccShare === 'number' && gccShare >= 0.5 ? 'GCC' : 'Global';
}

// Legacy "trends" entry (numeric Samsung fit, brief, thumbs).
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
    origin: 'trends',
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
    // legacy signalStrength is 0-100; cards use 0-1
    confidence: typeof t.signalStrength === 'number' ? (t.signalStrength > 1 ? t.signalStrength / 100 : t.signalStrength) : null,
    momentumPerDay: growth,
    viewsPerWeek: parseCount(t.viewsWk),
    avgEngagementPct: typeof t.eng === 'number' ? t.eng : null,
    stayingPower: t.durabilityClass || null,
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
    clips: clipsOf(t.thumbs, snd.title),
  };
}

// "liveCards" (named format/dance with recipe + sound) and "watchlist"
// (a sound gaining a format; thinner) entries.
function normalizeCard(c, origin) {
  const cu = c.commercialUse || {};
  const cap = c.captionCluster && c.captionCluster.phrase ? [c.captionCluster.phrase] : [];
  return {
    id: slug(c.name || 'trend'),
    name: c.name || null,
    origin,
    status: c.measuredStage || (origin === 'watchlist' ? 'watchlist' : null),
    region: regionOf(c.gccShare),
    lang: null,
    category: c.verdict || (origin === 'watchlist' ? 'sound' : null),
    samsungFit: { strength: 'fit', score: null, ownableBeat: c.soundCue || null, rationale: null, raw: null },
    confidence: typeof c.confidence === 'number' ? c.confidence : null,
    momentumPerDay: typeof c.velocity === 'number' ? c.velocity : null,
    viewsPerWeek: null,
    avgEngagementPct: engagementOf(c.examples),
    stayingPower: null,
    mechanic: c.recipe || null,
    why: c.onScreenText && c.onScreenText.length ? 'On-screen text seen: ' + c.onScreenText.slice(0, 3).join(' · ') : null,
    tags: cap.map((s) => s.replace(/[^a-z0-9]+/gi, '').toLowerCase()).filter(Boolean),
    sound: c.soundTitle ? {
      title: c.soundTitle,
      author: c.soundAuthor || null,
      musicId: c.musicId || null,
      cue: c.soundCue || null,
      cleared: cu.cleared === true,
      clearedCheckedAt: cu.checkedAt || null,
    } : null,
    clips: clipsOf(c.examples, c.soundTitle),
    creators72h: typeof c.creators72h === 'number' ? c.creators72h : null,
    usage: typeof c.usage === 'number' ? c.usage : null,
  };
}

// "topics" entries that TrendRadar classified as a caption/visual format.
function normalizeTopic(t) {
  const f = t.format || {};
  const cap = f.captionPhrase && f.captionPhrase.phrase ? [f.captionPhrase.phrase] : [];
  return {
    id: slug(t.name || t.tag || 'trend'),
    name: t.name || null,
    origin: 'topics',
    status: t.measuredStage || null,
    region: regionOf(t.gccShare),
    lang: null,
    category: t.category || 'format',
    samsungFit: { strength: 'fit', score: null, ownableBeat: null, rationale: null, raw: null },
    confidence: typeof t.confidence === 'number' ? t.confidence : null,
    momentumPerDay: typeof t.velocity === 'number' ? t.velocity : null,
    viewsPerWeek: null,
    avgEngagementPct: engagementOf(t.examples),
    stayingPower: null,
    mechanic: t.howItsDone || t.whatItIs || null,
    why: t.whatItIs || null,
    tags: [t.tag].concat(cap).filter(Boolean).map((s) => String(s).replace(/^#/, '').trim()).filter(Boolean),
    sound: f.topSound && f.topSound.title ? {
      title: f.topSound.title, author: f.topSound.author || null, musicId: f.topSound.musicId || null,
      cue: null, cleared: false, clearedCheckedAt: null,
    } : null,
    clips: clipsOf(t.examples, null),
  };
}

const DEAD = /cooling|dead|stalled/i;

function candidates(store) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (!t.name || seen.has(t.id)) return;
    if (t.status && DEAD.test(t.status)) return;
    seen.add(t.id);
    out.push(t);
  };
  store.liveCards.forEach((c) => push(normalizeCard(c, 'liveCards')));
  store.topics.filter((t) => t.format && (t.class === 'format' || t.admitted) && t.sensitive !== 'high')
    .forEach((t) => push(normalizeTopic(t)));
  store.trends.forEach((t) => push(normalize(t)));
  store.watchlist.forEach((c) => push(normalizeCard(c, 'watchlist')));
  return out;
}

function ruleCurate(trends) {
  const bad = /death|breach|sad edit|fancam|fan edit|vs\s|betray/i;
  const sporty = /\bgoal\b|football|highlight edit|match ?day|\bfc\b/i;
  return trends
    .filter((t) => t.name && (t.samsungFit.score == null || t.samsungFit.score >= 40))
    .filter((t) => !/sport/i.test(t.category || '') && !sporty.test(t.name))
    .filter((t) => !bad.test(t.name))
    .sort((a, b) => (b.samsungFit.score || 0) - (a.samsungFit.score || 0)
      || (b.confidence || 0) - (a.confidence || 0)
      || (b.avgEngagementPct || 0) - (a.avgEngagementPct || 0))
    .slice(0, 10);
}

async function claudeCurate(trends) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ timeout: 45000 });
  const digest = trends.map((t) => ({
    id: t.id, name: t.name, category: t.category, stage: t.status, origin: t.origin,
    samsungFitScore: t.samsungFit.score, fitReason: t.samsungFit.rationale,
    confidence: t.confidence, velocityPerDay: t.momentumPerDay,
    engagementPct: t.avgEngagementPct,
    mechanic: (t.mechanic || '').slice(0, 400),
    onScreen: (t.why || '').slice(0, 200),
    hashtags: t.tags, sound: t.sound ? { title: t.sound.title, author: t.sound.author, commerciallyCleared: t.sound.cleared } : null,
  }));
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system:
      'You curate the trend feed of MAISTRO, Samsung Gulf\'s content platform. From the candidate ' +
      'trends, select up to 10 (all, if fewer qualify; never pad with unsuitable ones) that Samsung\'s ' +
      'social team should build campaigns on, ranked most to least suitable.\n' +
      'MUST be: a real, NAMED, re-creatable content format a brand can produce its own version of.\n' +
      'EXCLUDE: news and sports results (not creatable formats); fan edits of licensed film/TV/music IP; ' +
      'anything a Samsung director would object to — suggestive or revealing choreography/posing, ' +
      'tragedy, death or grief themes, fear/scare content (e.g. data-breach panic), crude humor, ' +
      'gambling, politics or religion.\n' +
      'PREFER: higher samsungFitScore when present, higher confidence, active/peaking stage, higher ' +
      'engagement, sounds that are original or commercially cleared.\n' +
      'For each selected trend assign samsungFitScore 0-100: how naturally Samsung Gulf could own the ' +
      'format with its products (Galaxy phones and foldables, watches, buds, TVs, home appliances) ' +
      'without forcing it — 70+ only when a product is a natural prop or payoff — and fitReason, one ' +
      'short line naming the ownable beat. Keep an upstream samsungFitScore when one is provided.\n' +
      'Also list the 3-5 hashtags the community actually posts it under (lowercase, no # prefix — ' +
      'the trend\'s own tag plus the obvious companions, e.g. a makeup trend → its named tag, ' +
      '"makeuptrend", "beautytok"). Use the provided hashtags when present.',
    messages: [{ role: 'user', content: 'CANDIDATES:\n' + JSON.stringify(digest, null, 1) + '\n\nSelect and rank up to 10.' }],
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
                  samsungFitScore: { type: 'integer', description: '0-100 Samsung Gulf fit' },
                  fitReason: { type: 'string', description: 'One short line: the ownable Samsung beat' },
                  hashtags: { type: 'array', items: { type: 'string' }, description: '3-5 community hashtags, lowercase, no # prefix' },
                },
                required: ['id', 'reason', 'samsungFitScore', 'fitReason', 'hashtags'],
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
    let samsungFit = t.samsungFit;
    if (samsungFit.score == null && Number.isInteger(s.samsungFitScore)) {
      const score = Math.max(0, Math.min(100, s.samsungFitScore));
      samsungFit = {
        ...samsungFit,
        score,
        strength: score >= 70 ? 'strong' : 'fit',
        rationale: s.fitReason || null,
        raw: s.fitReason || null,
        ownableBeat: samsungFit.ownableBeat || s.fitReason || null,
      };
    }
    return { ...t, samsungFit, curatorNote: s.reason, tags };
  }).filter(Boolean).slice(0, 10);
  return picked.length ? picked : null;
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const r = await fetch(SOURCE, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; MaistroDemo/1.0)', accept: 'text/html' },
    });
    if (!r.ok) throw new Error(`kymah.com responded ${r.status}`);
    const html = await r.text();
    const store = extractStore(html);
    let trends = candidates(store);
    if (!trends.length) throw new Error('no trends found in payload');

    let curatedBy = 'none';
    if (!q.all) {
      let picked = null;
      try { picked = await claudeCurate(trends); curatedBy = picked ? 'claude' : 'rules'; }
      catch { curatedBy = 'rules'; }
      trends = picked || ruleCurate(trends);
    } else {
      trends.sort((a, b) => (b.samsungFit.score || 0) - (a.samsungFit.score || 0) || (b.confidence || 0) - (a.confidence || 0));
    }

    // consumer filters kept for the external Hermes agent
    if (q.strength) trends = trends.filter((t) => t.samsungFit.strength === q.strength);
    if (q.minScore) trends = trends.filter((t) => (t.samsungFit.score || 0) >= parseInt(q.minScore, 10));
    if (q.id) trends = trends.filter((t) => t.id === q.id);
    if (q.limit) trends = trends.slice(0, Math.max(1, parseInt(q.limit, 10) || trends.length));

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
      source: 'TrendRadar (kymah.com)',
      fetchedAt: new Date().toISOString(),
      curatedBy,
      candidates: { liveCards: store.liveCards.length, topics: store.topics.length, trends: store.trends.length, watchlist: store.watchlist.length },
      count: trends.length,
      trends,
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(err.message || err) });
  }
};

module.exports.extractTrendStore = extractTrendStore;
module.exports.extractStore = extractStore;
module.exports.candidates = candidates;
module.exports.ruleCurate = ruleCurate;
