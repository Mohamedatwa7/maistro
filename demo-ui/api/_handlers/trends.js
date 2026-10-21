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

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const r = await fetchT(SOURCE, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; MaistroDemo/1.0)', accept: 'text/html' },
    }, { timeoutMs: 20000, retries: 1 });
    if (!r.ok) throw new Error(`kymah.com responded ${r.status}`);
    const html = await r.text();
    let trends = extractTrendStore(html).map(normalize).filter((t) => t.name);
    if (!trends.length) throw new Error('no trends found in payload');

    let curatedBy = 'none';
    if (!q.all) {
      let picked = null;
      try { picked = await claudeCurate(trends); curatedBy = picked ? 'claude' : 'rules'; }
      catch { curatedBy = 'rules'; }
      trends = picked || ruleCurate(trends);
    } else {
      trends.sort((a, b) => (b.samsungFit.score || 0) - (a.samsungFit.score || 0));
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
      count: trends.length,
      trends,
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(err.message || err) });
  }
};
