// Moments: the big, shared occasions a brand plans around, next to kymah's micro trends.
//
// Two kinds:
//  - upcoming(): the planned calendar below (owner-editable). Each moment has the
//    markets it suits, how long production needs (leadDays) and a fit note, and
//    rolls to its next occurrence when `yearly`. `estimate` marks dates that move
//    (lunar, organiser-announced) and must be confirmed before booking work.
//  - fetchBreaking(): what is spiking right now, from Google Trends' daily
//    trending searches in the six Gulf markets and Wikipedia's most-viewed pages
//    (English and Arabic, yesterday against a week earlier). One Claude pass names
//    each item, merges duplicates across languages and sources, and decides brand
//    safety; without it the items are returned unchecked and say so.
// No keys are needed for the sources. Nothing here is written to the database.
const { fetchT } = require('../_http.js');

const DAY = 864e5;
const GULF = ['AE', 'SA', 'KW', 'QA', 'BH', 'OM'];
const GEO_NAME = { AE: 'UAE', SA: 'KSA', KW: 'Kuwait', QA: 'Qatar', BH: 'Bahrain', OM: 'Oman' };
const MODEL = () => process.env.MAISTRO_MOMENTS_MODEL || 'claude-sonnet-5-5';

// ---- the planned calendar (owner-editable) ----
// yearly: from/to give the month and day; the year rolls forward. Otherwise the dates are absolute.
const MOMENTS = [
  { id: 'halloween', keywords: ['halloween', 'costume', 'spooky', 'trick or treat', 'pumpkin', 'calabaza'], label: 'Halloween', from: '2026-10-31', to: '2026-10-31', yearly: true, category: 'culture', markets: ['AE', 'QA', 'BH'], leadDays: 14, note: 'Big with UAE expat audiences; low-key or sensitive in KSA and Kuwait. Keep it playful (costumes, night-mode camera), never gory.' },
  { id: 'riyadh-season', keywords: ['riyadh season', 'موسم الرياض'], label: 'Riyadh Season', from: '2026-10-10', to: '2027-03-31', category: 'culture', markets: ['SA'], leadDays: 21, estimate: true, note: 'Months of concerts, events and boulevard zones in Riyadh: on-ground content and creator collaborations.' },
  { id: 'diwali', keywords: ['diwali', 'deepavali'], label: 'Diwali', from: '2026-11-08', to: '2026-11-08', category: 'culture', markets: ['AE', 'OM', 'QA', 'KW', 'BH'], leadDays: 14, estimate: true, note: 'Large South Asian audiences across the Gulf: lights, family and gifting.' },
  { id: 'singles-day', keywords: ['11.11', 'singles day', "singles' day"], label: "Singles' Day (11.11)", from: '2026-11-11', to: '2026-11-11', yearly: true, category: 'retail', markets: GULF, leadDays: 21, note: 'Noon and Amazon run 11.11 sales across the Gulf.' },
  { id: 'oman-national-day', keywords: ['oman national day', 'العيد الوطني العماني'], label: 'Oman National Day', from: '2026-11-18', to: '2026-11-18', yearly: true, category: 'national', markets: ['OM'], leadDays: 30, note: 'National pride: flag colours and heritage, respectful tone.' },
  { id: 'white-friday', keywords: ['white friday', 'black friday', 'cyber monday'], label: 'White Friday / Black Friday', from: '2026-11-20', to: '2026-11-30', category: 'retail', markets: GULF, leadDays: 30, estimate: true, note: "The Gulf's biggest sales week, through Cyber Monday. Retailer windows vary, so confirm with the retail team." },
  { id: 'qatar-gp', keywords: ['qatar grand prix', 'lusail', 'formula 1', 'f1'], label: 'Formula 1 Qatar Grand Prix', from: '2026-11-27', to: '2026-11-29', category: 'sport', markets: ['QA', 'AE', 'SA', 'KW', 'BH', 'OM'], leadDays: 14, note: 'Night race at Lusail: speed, low-light and slow-motion camera stories.' },
  { id: 'uae-national-day', keywords: ['uae national day', 'eid al etihad', 'عيد الاتحاد', 'national day'], label: 'UAE National Day (Eid Al Etihad)', from: '2026-12-02', to: '2026-12-03', yearly: true, category: 'national', markets: ['AE'], leadDays: 30, note: "The UAE's biggest national moment: unity, heritage, flag colours." },
  { id: 'abu-dhabi-gp', keywords: ['abu dhabi grand prix', 'yas marina', 'formula 1', 'f1'], label: 'Formula 1 Abu Dhabi Grand Prix (season finale)', from: '2026-12-04', to: '2026-12-06', category: 'sport', markets: GULF, leadDays: 14, note: 'Yas Marina twilight race: night shots, speed, the title decider.' },
  { id: 'dubai-shopping-festival', keywords: ['dubai shopping festival', 'dsf'], label: 'Dubai Shopping Festival', from: '2026-12-04', to: '2027-01-17', category: 'retail', markets: ['AE'], leadDays: 21, estimate: true, note: 'City-wide retail festival with fireworks and drone shows.' },
  { id: 'gitex', keywords: ['gitex'], label: 'GITEX Global (Dubai)', from: '2026-12-07', to: '2026-12-11', category: 'tech', markets: ['AE'], leadDays: 21, estimate: true, note: "The region's largest tech show: AI, devices and B2B. Confirm this year's dates." },
  { id: 'bahrain-national-day', keywords: ['bahrain national day'], label: 'Bahrain National Day', from: '2026-12-16', to: '2026-12-16', yearly: true, category: 'national', markets: ['BH'], leadDays: 30, note: 'National pride, respectful tone.' },
  { id: 'qatar-national-day', keywords: ['qatar national day'], label: 'Qatar National Day', from: '2026-12-18', to: '2026-12-18', yearly: true, category: 'national', markets: ['QA'], leadDays: 30, note: 'National pride, maroon and white, respectful tone.' },
  { id: 'christmas', keywords: ['christmas', 'xmas', 'santa'], label: 'Christmas and the gifting season', from: '2026-12-25', to: '2026-12-25', yearly: true, category: 'culture', markets: ['AE', 'BH', 'QA'], leadDays: 21, note: 'Expat gifting season. Keep it secular: gifting, family, the year in photos.' },
  { id: 'new-year', keywords: ['new year', 'nye', 'countdown', 'fireworks'], label: "New Year's Eve", from: '2026-12-31', to: '2027-01-01', yearly: true, category: 'culture', markets: GULF, leadDays: 21, note: 'Burj Khalifa fireworks: night photography and the year-in-review.' },
  { id: 'asian-cup', keywords: ['asian cup', 'afc'], label: 'AFC Asian Cup (hosted by Saudi Arabia)', from: '2027-01-07', to: '2027-02-05', category: 'sport', markets: GULF, leadDays: 30, estimate: true, note: "Asia's football championship in KSA, with every Gulf team in the region: fan content and watch parties." },
  { id: 'galaxy-unpacked', keywords: ['unpacked', 'galaxy s27'], label: 'Galaxy Unpacked (S series)', from: '2027-02-01', to: '2027-02-25', category: 'tech', markets: GULF, leadDays: 30, estimate: true, note: "Samsung's own launch moment. Set the date once HQ confirms it." },
  { id: 'valentines', keywords: ['valentine'], label: "Valentine's Day", from: '2027-02-14', to: '2027-02-14', yearly: true, category: 'retail', markets: ['AE', 'QA', 'BH', 'KW', 'OM'], leadDays: 21, note: 'Gifting. Keep it light and non-romantic for conservative audiences.' },
  { id: 'saudi-founding-day', keywords: ['founding day', 'يوم التأسيس'], label: 'Saudi Founding Day', from: '2027-02-22', to: '2027-02-22', yearly: true, category: 'national', markets: ['SA'], leadDays: 30, note: 'Heritage and history (distinct from National Day): traditional dress, Diriyah.' },
  { id: 'kuwait-national-days', keywords: ['kuwait national day', 'liberation day'], label: 'Kuwait National and Liberation Days', from: '2027-02-25', to: '2027-02-26', yearly: true, category: 'national', markets: ['KW'], leadDays: 30, note: 'National pride, respectful tone.' },
  { id: 'ramadan', keywords: ['ramadan', 'رمضان', 'iftar', 'suhoor'], label: 'Ramadan', from: '2027-02-08', to: '2027-03-09', category: 'religious', markets: GULF, leadDays: 45, estimate: true, note: 'The biggest content season of the year: night-time viewing, family, giving. Dates follow the moon sighting.' },
  { id: 'eid-al-fitr', keywords: ['eid al fitr', 'eid mubarak', 'عيد الفطر'], label: 'Eid al-Fitr', from: '2027-03-10', to: '2027-03-13', category: 'religious', markets: GULF, leadDays: 30, estimate: true, note: 'Celebration, family visits, gifting. Dates follow the moon sighting.' },
  { id: 'arab-mothers-day', keywords: ["mother's day", 'mothers day', 'عيد الأم'], label: "Mother's Day (Arab world)", from: '2027-03-21', to: '2027-03-21', yearly: true, category: 'culture', markets: GULF, leadDays: 21, note: 'Gifting and family moments.' },
  { id: 'eid-al-adha', keywords: ['eid al adha', 'عيد الأضحى'], label: 'Eid al-Adha', from: '2027-05-16', to: '2027-05-19', category: 'religious', markets: GULF, leadDays: 30, estimate: true, note: 'Family and travel. Dates follow the moon sighting.' },
  { id: 'ucl-final', keywords: ['champions league'], label: 'UEFA Champions League final', from: '2027-05-29', to: '2027-05-29', category: 'sport', markets: GULF, leadDays: 14, estimate: true, note: 'Huge Gulf viewership: watch parties and fan reactions.' },
  { id: 'saudi-national-day', keywords: ['saudi national day', 'اليوم الوطني'], label: 'Saudi National Day', from: '2026-09-23', to: '2026-09-23', yearly: true, category: 'national', markets: ['SA'], leadDays: 30, note: 'National pride, green and white, respectful tone.' },
];

const iso = (d) => d.toISOString().slice(0, 10);
const atUtc = (s) => new Date(`${s}T00:00:00Z`);

/** The next occurrence of a moment (on or after `today`), as { from, to } Dates. */
function occurrence(m, today) {
  if (!m.yearly) return { from: atUtc(m.from), to: atUtc(m.to) };
  const md = (s) => s.slice(5);
  const spans = md(m.to) < md(m.from); // e.g. New Year's Eve 12-31 → 01-01
  for (const y of [today.getUTCFullYear() - 1, today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
    const from = atUtc(`${y}-${md(m.from)}`), to = atUtc(`${spans ? y + 1 : y}-${md(m.to)}`);
    if (to >= today) return { from, to };
  }
  return { from: atUtc(m.from), to: atUtc(m.to) };
}

/** The calendar from `now`, soonest first: moments under way or starting within `horizonDays`.
 *  status: 'live' (under way), 'prep' (inside its production lead time), 'later'. */
function upcoming(now = new Date(), { horizonDays = 150, moments = MOMENTS } = {}) {
  const today = atUtc(iso(now));
  return moments.map((m) => {
    const { from, to } = occurrence(m, today);
    const daysUntil = Math.round((from - today) / DAY);
    const prepBy = new Date(from.getTime() - (m.leadDays || 21) * DAY);
    const status = from <= today && today <= to ? 'live' : today >= prepBy ? 'prep' : 'later';
    return { id: m.id, label: m.label, keywords: m.keywords || [], category: m.category, markets: m.markets, from: iso(from), to: iso(to), daysUntil, prepBy: iso(prepBy), leadDays: m.leadDays || 21, status, estimate: Boolean(m.estimate), note: m.note };
  })
    .filter((m) => m.to >= iso(today) && m.daysUntil <= horizonDays)
    .sort((a, b) => a.from.localeCompare(b.from) || a.label.localeCompare(b.label));
}

// ---- breaking: Google Trends (Gulf) + Wikipedia spikes ----

/** "20K+" → 20000; "100+" → 100. */
function parseTraffic(s) {
  const m = /^([\d.,]+)\s*([KkMm])?\+?$/.exec(String(s || '').trim());
  if (!m) return 0;
  return Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1));
}
const tag = (xml, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return m ? decode(m[1].trim()) : ''; };
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Google Trends' daily trending-searches RSS for one market → [{ title, traffic, news }]. */
function parseTrendsRss(xml) {
  return String(xml || '').split('<item>').slice(1).map((it) => {
    const news = it.split('<ht:news_item>').slice(1).map((n) => ({ title: tag(n, 'ht:news_item_title'), url: tag(n, 'ht:news_item_url'), source: tag(n, 'ht:news_item_source') })).filter((n) => n.title);
    return { title: tag(it, 'title'), traffic: parseTraffic(tag(it, 'ht:approx_traffic')), pubDate: tag(it, 'pubDate'), picture: tag(it, 'ht:picture'), news: news.slice(0, 2) };
  }).filter((x) => x.title);
}

async function googleTrends(geo) {
  const r = await fetchT(`https://trends.google.com/trending/rss?geo=${geo}`, { headers: { 'user-agent': 'Mozilla/5.0 (Maistro moments)' } }, { timeoutMs: 8000, retries: 1 });
  if (!r.ok) throw new Error(`Google Trends ${geo}: ${r.status}`);
  return parseTrendsRss(await r.text()).map((x) => ({ ...x, geo }));
}

// pages that are always near the top (portals, search, bots) and say nothing about a moment
const WIKI_NOISE = /^(Main_Page|الصفحة_الرئيسية|Special:|Wikipedia:|File:|Portal:|Help:|Template:|Category:|خاص:|ويكيبيديا:|ملف:|بوابة:|مساعدة:|قالب:|تصنيف:)|^\.xxx$|^XXX|^Cleopatra$|^Bible$|^Pornhub/i;

async function wikiTop(project, day) {
  const [y, m, d] = iso(day).split('-');
  const r = await fetchT(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${project}/all-access/${y}/${m}/${d}`, { headers: { 'user-agent': 'Maistro/1.0 (Samsung Gulf content platform; moments feed)' } }, { timeoutMs: 8000, retries: 1 });
  if (!r.ok) throw new Error(`Wikipedia ${project} ${iso(day)}: ${r.status}`);
  const j = await r.json();
  return ((j.items && j.items[0] && j.items[0].articles) || []).filter((a) => !WIKI_NOISE.test(a.article));
}

/** Pages that spiked: in `latest`'s top `top`, and absent from the week-earlier list or at ≥ 3× its views. */
function wikiSpikes(latest, weekAgo, { top = 60 } = {}) {
  const before = new Map(weekAgo.map((a) => [a.article, a.views]));
  return latest.slice(0, top).filter((a) => !before.has(a.article) || a.views >= 3 * before.get(a.article))
    .map((a) => ({ title: a.article.replace(/_/g, ' '), views: a.views, weekAgo: before.get(a.article) || null }));
}

/** Wikipedia's latest complete day (yesterday, else the day before) against the same weekday a week earlier. */
async function wikiBreaking(project, now) {
  for (const back of [1, 2]) {
    const day = new Date(atUtc(iso(now)).getTime() - back * DAY);
    try {
      const [latest, weekAgo] = await Promise.all([wikiTop(project, day), wikiTop(project, new Date(day.getTime() - 7 * DAY))]);
      return { day: iso(day), spikes: wikiSpikes(latest, weekAgo) };
    } catch (e) { if (back === 2) throw e; }
  }
  return { day: null, spikes: [] };
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Raw candidates before classification: Google items merged by title across markets, plus Wikipedia spikes. */
function candidates({ google = [], wiki = {} }) {
  const byTitle = new Map();
  for (const g of google) {
    const k = norm(g.title);
    const c = byTitle.get(k) || { id: `g:${k}`, title: g.title, source: 'google', geos: [], traffic: 0, news: [], picture: g.picture || null };
    if (!c.geos.includes(g.geo)) c.geos.push(g.geo);
    c.traffic += g.traffic || 0;
    for (const n of g.news || []) if (c.news.length < 2 && !c.news.some((x) => x.url === n.url)) c.news.push(n);
    byTitle.set(k, c);
  }
  const out = [...byTitle.values()];
  for (const [project, w] of Object.entries(wiki)) {
    for (const s of (w && w.spikes) || []) out.push({ id: `w:${project}:${norm(s.title)}`, title: s.title, source: 'wikipedia', project, views: s.views, weekAgo: s.weekAgo, geos: [], traffic: 0, news: [] });
  }
  return out;
}

const CATEGORIES = ['sport', 'entertainment', 'tech', 'culture', 'holiday', 'retail', 'lifestyle', 'politics', 'conflict', 'tragedy', 'crime', 'finance', 'religion', 'adult', 'other'];
const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string', description: 'The moment in plain English, a few words (e.g. "Ballon d\'Or 2026 ceremony"). Items about the same moment get the identical label.' },
          category: { type: 'string', enum: CATEGORIES },
          moment: { type: 'boolean', description: 'true for a shared moment many people talk about; false for a routine daily search' },
          brandSafe: { type: 'boolean' },
          gulfRelevance: { type: 'integer', description: '0–10' }, // the API rejects minimum/maximum on integers (see prompts/profile-v1.js): clamped below
          why: { type: 'string', description: 'One short line: what happened and why people are searching' },
          samsungAngle: { type: 'string', description: 'One short line a Samsung Gulf social team could build on; empty when not brand-safe' },
          keywords: { type: 'array', items: { type: 'string' }, description: '1–4 lowercase words or phrases a social post about this moment would contain (e.g. "ballon d or", "halloween")' },
        },
        required: ['id', 'label', 'category', 'moment', 'brandSafe', 'gulfRelevance', 'why', 'samsungAngle', 'keywords'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};
const SYSTEM =
  'You screen what is spiking right now for Samsung Gulf\'s social team (UAE, KSA, Kuwait, Qatar, Bahrain, Oman). ' +
  'Each candidate is a Google search trending in one or more Gulf markets, or a Wikipedia page whose views spiked. ' +
  'For every candidate: name the moment in plain English (identical labels for the same moment across languages and sources), ' +
  'categorise it, and decide moment and brandSafe. moment is true only for a shared occasion people across the region are talking ' +
  'about: a final, a derby or title decider, an awards night (e.g. the Ballon d\'Or), a major launch, a festival, a holiday, a viral ' +
  'cultural event. It is false for routine daily searches: regular league or season fixtures and scores, the weather, prayer times, ' +
  'school or government portals, exchange rates, and one person searched for an ordinary reason. brandSafe is false for politics, elections, war or conflict, deaths, accidents, disasters, ' +
  'crime, scandals, religion, finance or crypto speculation, gambling and adult content, and for any single private person. ' +
  'It is true for sport, entertainment, tech, culture, holidays and seasonal moments a consumer-electronics brand can join without ' +
  'controversy. gulfRelevance is 0–10 for how much Gulf audiences care. samsungAngle is one concrete, light idea (a Galaxy feature, a ' +
  'format), or empty when not brand-safe. If you do not know what a candidate refers to, say so in why and set brandSafe false.';

/** One Claude pass over the candidates. Returns Map(id → classification), or null when unavailable. */
async function classify(cands, { client } = {}) {
  if (!cands.length) return new Map();
  if (!client && !process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 60000, maxRetries: 1 });
  const digest = cands.map((x) => ({ id: x.id, title: x.title, source: x.source, markets: x.geos.map((g) => GEO_NAME[g]), searches: x.traffic || undefined, wikipediaViews: x.views || undefined, wikipedia: x.project, headlines: x.news.map((n) => n.title) }));
  const response = await c.messages.create({
    model: MODEL(),
    max_tokens: 12000,
    system: SYSTEM,
    messages: [{ role: 'user', content: `CANDIDATES:\n${JSON.stringify(digest, null, 1)}\n\nClassify every candidate.` }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'low' },
  });
  const text = response.content && response.content.find((b) => b.type === 'text');
  if (!text) return null;
  const j = JSON.parse(text.text);
  return new Map((j.items || []).filter((i) => i && typeof i.id === 'string').map((i) => [i.id, { ...i, gulfRelevance: Math.max(0, Math.min(10, Math.round(Number(i.gulfRelevance) || 0))) }]));
}

/** Breadth score: how widely a moment is being felt (markets, search volume, both sources, Gulf relevance). */
function reach(m) {
  return m.markets.length * 2 + (m.traffic ? Math.log10(m.traffic) : 0) + (m.wikiViews ? Math.log10(m.wikiViews) - 3 : 0) + (m.sources.length > 1 ? 2 : 0) + (m.gulfRelevance || 0) / 2;
}

/** Candidates + classifications → moments merged by label, safest and widest first. */
function assemble(cands, cls) {
  const groups = new Map();
  for (const x of cands) {
    const k = cls ? cls.get(x.id) : null;
    if (cls && !k) continue; // the model skipped it: nothing to show without a safety decision
    const label = k ? k.label : x.title;
    const key = norm(label);
    const g = groups.get(key) || { id: key.replace(/ /g, '-').slice(0, 80), label, category: k ? k.category : null, moment: k ? k.moment : null, brandSafe: k ? k.brandSafe : null, gulfRelevance: k ? k.gulfRelevance : null, why: k ? k.why : '', samsungAngle: k ? k.samsungAngle : '', keywords: [], markets: [], traffic: 0, wikiViews: 0, sources: [], searches: [], news: [], picture: null };
    if (k) { g.moment = g.moment || k.moment; g.brandSafe = g.brandSafe === false || k.brandSafe === false ? false : true; g.gulfRelevance = Math.max(g.gulfRelevance || 0, k.gulfRelevance || 0); if (!g.samsungAngle && k.samsungAngle) g.samsungAngle = k.samsungAngle; }
    for (const w of (k && Array.isArray(k.keywords) ? k.keywords : [])) { const v = String(w).toLowerCase().trim().slice(0, 40); if (v.length >= 3 && g.keywords.length < 6 && !g.keywords.includes(v)) g.keywords.push(v); }
    for (const geo of x.geos) if (!g.markets.includes(geo)) g.markets.push(geo);
    g.traffic += x.traffic || 0; g.wikiViews += x.views || 0;
    const src = x.source === 'wikipedia' ? `wikipedia-${x.project === 'ar.wikipedia' ? 'ar' : 'en'}` : 'google';
    if (!g.sources.includes(src)) g.sources.push(src);
    if (!g.searches.includes(x.title)) g.searches.push(x.title);
    for (const n of x.news) if (g.news.length < 2 && !g.news.some((y) => y.url === n.url)) g.news.push(n);
    g.picture = g.picture || x.picture || null;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, markets: g.markets.sort((a, b) => GULF.indexOf(a) - GULF.indexOf(b)), scale: g.markets.length >= 2 || g.sources.length > 1 || g.traffic >= 20000 || g.wikiViews >= 200000 ? 'macro' : 'local', reach: Math.round(reach({ ...g }) * 10) / 10 }))
    .sort((a, b) => (b.brandSafe === true) - (a.brandSafe === true) || b.reach - a.reach);
}

const corroborated = (m) => m.markets.length > 0 || m.sources.length >= 2;

/** Everything spiking now. Source failures are reported, not thrown, unless every source failed. */
async function fetchBreaking({ now = new Date(), client } = {}) {
  const errors = [];
  const settle = (p, label) => p.catch((e) => { errors.push(`${label}: ${String(e.message || e)}`); return null; });
  const [g, en, ar] = await Promise.all([
    Promise.all(GULF.map((geo) => settle(googleTrends(geo), `Google Trends ${geo}`))),
    settle(wikiBreaking('en.wikipedia', now), 'Wikipedia (en)'),
    settle(wikiBreaking('ar.wikipedia', now), 'Wikipedia (ar)'),
  ]);
  const google = g.filter(Boolean).flat();
  if (!google.length && !en && !ar) throw new Error(`every moments source failed: ${errors.join('; ')}`);
  const cands = candidates({ google, wiki: { ...(en ? { 'en.wikipedia': en } : {}), ...(ar ? { 'ar.wikipedia': ar } : {}) } });
  let cls = null, classifiedBy = 'none';
  try { cls = await classify(cands, { client }); classifiedBy = cls ? 'claude' : 'none'; } catch (e) { errors.push(`brand check: ${String(e.message || e)}`); }
  const all = assemble(cands, cls);
  return {
    classifiedBy,
    // unchecked (no Claude): the widest few, labelled as unchecked by the page
    // a moment needs a search spike in a Gulf market or a second source: one Wikipedia page alone is too thin
    items: (cls ? all.filter((m) => m.moment && m.brandSafe) : all.filter((m) => m.scale === 'macro').slice(0, 12)).filter(corroborated),
    hidden: all.filter((m) => m.moment && m.brandSafe === false).map((m) => ({ label: m.label, category: m.category })),
    routine: all.filter((m) => m.moment === false).length,
    sources: { googleMarkets: GULF.filter((geo, i) => g[i]), wikipediaDay: (en && en.day) || (ar && ar.day) || null },
    errors,
  };
}

module.exports = { MOMENTS, GULF, upcoming, occurrence, parseTraffic, parseTrendsRss, wikiSpikes, candidates, classify, assemble, fetchBreaking, SCHEMA };
