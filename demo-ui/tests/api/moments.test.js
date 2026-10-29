// /api/moments: the planned calendar and the breaking feed (Google Trends in the Gulf + Wikipedia spikes,
// screened by one Claude pass). No real network: every source is mocked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, anthropicReply, text, json } = require('../helpers');

const M = () => require('../../api/_trends/moments.js');

const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map(([title, traffic, news]) => `<item><title>${title}</title><ht:approx_traffic>${traffic}</ht:approx_traffic>${news ? `<ht:news_item><ht:news_item_title>${news}</ht:news_item_title><ht:news_item_url>https://news.test/${encodeURIComponent(title)}</ht:news_item_url><ht:news_item_source>News</ht:news_item_source></ht:news_item>` : ''}</item>`).join('')}</channel></rss>`;
const wikiDay = (articles) => json({ items: [{ articles: articles.map(([article, views], i) => ({ article, views, rank: i + 1 })) }] });

test('upcoming: yearly moments roll to their next date; status is live, prep (inside the lead time) or later; the horizon bounds the list', () => {
  const m = M();
  const now = new Date('2026-10-29T08:00:00Z');
  const u = m.upcoming(now);
  const hw = u.find((x) => x.id === 'halloween');
  assert.deepEqual([hw.from, hw.daysUntil, hw.status, hw.prepBy], ['2026-10-31', 2, 'prep', '2026-10-17']);
  assert.equal(u.find((x) => x.id === 'riyadh-season').status, 'live', 'under way since 10 Oct');
  assert.equal(u.find((x) => x.id === 'uae-national-day').status, 'later');
  assert.ok(u.every((x) => x.daysUntil <= 150), 'nothing past the horizon');
  assert.ok(!u.some((x) => x.id === 'eid-al-adha'), 'May 2027 is beyond 150 days');
  assert.ok(u.find((x) => x.id === 'ramadan').estimate, 'moon-sighting dates are marked as estimates');
  for (let i = 1; i < u.length; i++) assert.ok(u[i - 1].from <= u[i].from, 'soonest first');
  // a week after Halloween it has rolled to next year (and is out of the 150-day window)
  assert.ok(!m.upcoming(new Date('2026-11-05T00:00:00Z')).some((x) => x.id === 'halloween'));
  assert.equal(m.occurrence(m.MOMENTS.find((x) => x.id === 'halloween'), new Date('2026-11-05T00:00:00Z')).from.toISOString().slice(0, 10), '2027-10-31');
  // a moment spanning the year end keeps its end in the next year
  const ny = m.occurrence(m.MOMENTS.find((x) => x.id === 'new-year'), new Date('2027-12-01T00:00:00Z'));
  assert.deepEqual([ny.from.toISOString().slice(0, 10), ny.to.toISOString().slice(0, 10)], ['2027-12-31', '2028-01-01']);
});

test('parsing: Google Trends traffic and RSS items; Wikipedia spikes drop pages that are always on top', () => {
  const m = M();
  assert.deepEqual(['100+', '2K+', '20K+', '1M+', 'x'].map(m.parseTraffic), [100, 2000, 20000, 1000000, 0]);
  const items = m.parseTrendsRss(rss([['ballon d&#39;or', '50K+', 'Dembélé wins'], ['weather', '10K+']]));
  assert.deepEqual(items.map((x) => [x.title, x.traffic, x.news.length]), [["ballon d'or", 50000, 1], ['weather', 10000, 0]]);
  const spikes = m.wikiSpikes([{ article: 'Ballon_d%27Or_2026', views: 900000 }, { article: 'Steady_page', views: 300000 }, { article: 'Tripled', views: 90000 }], [{ article: 'Steady_page', views: 280000 }, { article: 'Tripled', views: 30000 }]);
  assert.deepEqual(spikes.map((s) => s.title), ['Ballon d%27Or 2026', 'Tripled'], 'new pages and ≥3× pages spike; a steady page does not');
  assert.ok(!/"(minimum|maximum)"/.test(JSON.stringify(m.SCHEMA)), 'the structured-output API rejects integer bounds (prompts/profile-v1.js v1.1)');
});

function sources({ claude, failAll, extra = [] } = {}) {
  let sent = null;
  const f = mockFetch([
    ...extra,
    [/trends\.google\.com\/trending\/rss\?geo=(AE|SA|KW|QA|BH|OM)/, (u) => {
      if (failAll) return text('down', 503);
      const geo = /geo=(\w+)/.exec(u)[1];
      const base = [['liverpool vs chelsea', '2K+'], ['weather', '10K+']];
      if (['AE', 'SA', 'QA'].includes(geo)) base.push(["ballon d'or", '20K+', 'Dembélé wins the Ballon d’Or']);
      if (geo === 'SA') base.push(['الكرة الذهبية', '50K+']);
      if (geo === 'AE') base.push(['election results', '5K+']);
      return text(rss(base));
    }],
    [/wikimedia\.org\/api\/rest_v1\/metrics\/pageviews\/top\/(en|ar)\.wikipedia/, (u) => {
      if (failAll) return text('down', 503);
      const latest = /\/2026\/10\/28$/.test(u);
      if (u.includes('/ar.wikipedia/')) return wikiDay(latest ? [['الصفحة_الرئيسية', 900000], ['الكرة_الذهبية_2026', 80000]] : [['الصفحة_الرئيسية', 880000]]);
      return wikiDay(latest ? [['Main_Page', 4000000], ['Special:Search', 700000], ['Ballon_d%27Or_2026', 600000], ['Some_politician', 400000], ['Obscure_festival', 90000]] : [['Main_Page', 3900000], ['Special:Search', 690000]]);
    }],
    ['api.anthropic.com', (u, init) => { sent = JSON.parse(init.body); return claude ? anthropicReply(claude(sent)) : text('no', 500); }],
  ]);
  return { f, sent: () => sent };
}

// what the screen would decide for each candidate the mock sources produce
function screen(body) {
  const cands = JSON.parse(body.messages[0].content.replace(/^CANDIDATES:\n/, '').replace(/\n\nClassify every candidate\.$/, ''));
  return {
    items: cands.map((c) => {
      const t = c.title.toLowerCase();
      if (/ballon|الكرة الذهبية/.test(t)) return { id: c.id, label: "Ballon d'Or 2026", category: 'sport', moment: true, brandSafe: true, gulfRelevance: 8, why: 'The Ballon d’Or was awarded.', samsungAngle: 'Galaxy AI photo remaster of a golden moment' };
      if (/obscure/.test(t)) return { id: c.id, label: 'Obscure festival', category: 'culture', moment: true, brandSafe: true, gulfRelevance: 2, why: 'A page spiked.', samsungAngle: 'x' };
      if (/election|politician/.test(t)) return { id: c.id, label: 'Election', category: 'politics', moment: true, brandSafe: false, gulfRelevance: 3, why: 'An election.', samsungAngle: '' };
      return { id: c.id, label: c.title, category: 'sport', moment: false, brandSafe: true, gulfRelevance: 4, why: 'Routine.', samsungAngle: '' };
    }),
  };
}

test('GET /api/moments: Gulf searches and Wikipedia spikes are merged into one moment per label, routine searches and unsafe topics are left out, signed-in only, and a warm instance reuses the read (one brand check per 30 minutes)', async (t) => {
  const s = sources({ claude: screen });
  const h = api('moments.js', { ANTHROPIC_API_KEY: 'k' });
  const RealDate = Date; global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : ['2026-10-29T08:00:00Z'])); } static now() { return new RealDate('2026-10-29T08:00:00Z').getTime(); } };
  try {
    const r = res(); await h.handler(req({ method: 'GET' }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['cache-control'], 'private, max-age=600');
    const b = r.body.breaking;
    assert.equal(b.classifiedBy, 'claude'); assert.deepEqual(b.errors, []);
    assert.deepEqual(b.items.map((x) => x.label), ["Ballon d'Or 2026"], 'one moment; fixtures and the weather are routine, the election is screened out, and a lone Wikipedia page is too thin');
    const bo = b.items[0];
    assert.deepEqual(bo.markets, ['AE', 'SA', 'QA']); assert.equal(bo.scale, 'macro');
    assert.deepEqual(bo.sources.sort(), ['google', 'wikipedia-ar', 'wikipedia-en']);
    assert.equal(bo.traffic, 110000, 'searches summed across markets and languages');
    assert.equal(bo.wikiViews, 680000); assert.equal(bo.news.length, 1); assert.match(bo.samsungAngle, /Galaxy/);
    assert.deepEqual(b.hidden, [{ label: 'Election', category: 'politics' }], 'what was screened out is listed, not silently dropped');
    assert.ok(b.routine >= 2);
    assert.deepEqual(b.sources, { googleMarkets: ['AE', 'SA', 'KW', 'QA', 'BH', 'OM'], wikipediaDay: '2026-10-28' });
    const sent = s.sent();
    assert.ok(!/Main_Page|Special:Search|الصفحة_الرئيسية/.test(sent.messages[0].content), 'portal pages never reach the model');
    assert.equal(sent.output_config.format.type, 'json_schema');
    assert.ok(r.body.upcoming.some((x) => x.id === 'halloween'));
    const calls = s.f.calls.length;
    const again = res(); await h.handler(req({ method: 'GET' }), again);
    assert.deepEqual(again.body.breaking, b); assert.equal(s.f.calls.length, calls, 'no source or Claude call on a repeat read');
    const anon = res(); await h.handler(req({ method: 'GET', session: false }), anon);
    assert.equal(anon.statusCode, 401, 'signed-in only: a fresh read costs a Claude call');
  } finally { global.Date = RealDate; s.f.restore(); h.restore(); }
});

test('GET /api/moments: without the brand check the widest items are returned unchecked; when every source fails the calendar still answers', async () => {
  let s = sources();
  let h = api('moments.js', { ANTHROPIC_API_KEY: undefined });
  try {
    const r = res(); await h.handler(req({ method: 'GET' }), r);
    const b = r.body.breaking;
    assert.equal(b.classifiedBy, 'none');
    assert.ok(b.items.length && b.items.every((x) => x.brandSafe === null && x.scale === 'macro'), 'unchecked, and only the multi-market ones');
  } finally { s.f.restore(); h.restore(); }
  s = sources({ failAll: true });
  h = api('moments.js', {});
  try {
    const r = res(); await h.handler(req({ method: 'GET' }), r);
    assert.equal(r.statusCode, 200);
    assert.match(r.body.breaking.error, /every moments source failed/);
    assert.equal(r.headers['cache-control'], 'private, max-age=60', 'a failure is kept briefly');
    assert.ok(r.body.upcoming.length > 0);
    r.body = null;
    const r2 = res(); await h.handler(req({ method: 'GET', query: { view: 'upcoming' } }), r2);
    assert.equal(r2.body.breaking, null, '?view=upcoming skips the live sources');
    const r3 = res(); await h.handler(req({ method: 'POST' }), r3);
    assert.equal(r3.statusCode, 405);
  } finally { s.f.restore(); h.restore(); }
});

test('the hourly cron prepares the breaking read and stores it; a signed-in read serves the stored copy without touching the sources, and reads live only when it is over 75 minutes old', async () => {
  const { fakePostgrest } = require('../fake-postgrest');
  const pg = fakePostgrest();
  const ENV = { ANTHROPIC_API_KEY: 'k', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', CRON_SECRET: 'cron' };
  const s = sources({ claude: screen, extra: [pg.route] });
  const live = () => s.f.calls.filter((c) => /trends\.google|wikimedia|anthropic/.test(c.url)).length;
  let h = api('moments.js', ENV);
  try {
    let r = res(); await h.handler(req({ method: 'GET', headers: { authorization: 'Bearer cron' }, session: false }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.ok, true); assert.equal(r.body.items, 1); assert.equal(r.body.classifiedBy, 'claude');
    const row = pg.tables.trends_cache.find((x) => x.id === 'moments');
    assert.equal(row.payload.breaking.items[0].label, "Ballon d'Or 2026");
    r = res(); await h.handler(req({ method: 'GET', headers: { authorization: 'Bearer nope' }, session: false }), r);
    assert.equal(r.statusCode, 401, 'a wrong cron secret is just an anonymous read');
  } finally { h.restore(); }
  h = api('moments.js', ENV); // a cold instance: no memo
  try {
    const before = live();
    let r = res(); await h.handler(req({ method: 'GET' }), r);
    assert.equal(live(), before, 'served from the stored copy: no source or Claude call');
    assert.equal(r.body.breaking.items[0].label, "Ballon d'Or 2026"); assert.ok(r.body.breaking.preparedAt);
  } finally { h.restore(); }
  pg.tables.trends_cache.find((x) => x.id === 'moments').fetched_at = new Date(Date.now() - 2 * 3600e3).toISOString();
  h = api('moments.js', ENV);
  try {
    const before = live();
    const r = res(); await h.handler(req({ method: 'GET' }), r);
    assert.ok(live() > before, 'a copy over 75 minutes old is read live again');
    assert.ok(Date.now() - new Date(pg.tables.trends_cache.find((x) => x.id === 'moments').fetched_at).getTime() < 60e3, 'and stored');
  } finally { s.f.restore(); h.restore(); }
});

test('when the brand check fails, a checked copy under a day old is kept (not replaced by unchecked searches), and the refresh says why', async () => {
  const { fakePostgrest } = require('../fake-postgrest');
  const pg = fakePostgrest();
  const ENV = { ANTHROPIC_API_KEY: 'k', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', CRON_SECRET: 'cron' };
  let claudeUp = true;
  const s = sources({ claude: (b) => (claudeUp ? screen(b) : null), extra: [pg.route] });
  let h = api('moments.js', ENV);
  try {
    let r = res(); await h.handler(req({ method: 'GET', headers: { authorization: 'Bearer cron' }, session: false }), r);
    assert.equal(r.body.classifiedBy, 'claude');
  } finally { h.restore(); }
  claudeUp = false; // the mock now answers 500, like the credit running out
  h = api('moments.js', ENV);
  try {
    let r = res(); await h.handler(req({ method: 'GET', headers: { authorization: 'Bearer cron' }, session: false }), r);
    assert.equal(r.body.kept, true); assert.match(r.body.refreshSkipped, /brand check/);
    const row = pg.tables.trends_cache.find((x) => x.id === 'moments');
    assert.equal(row.payload.breaking.classifiedBy, 'claude', 'the checked copy stays stored');
    row.fetched_at = new Date(Date.now() - 2 * 3600e3).toISOString(); // past 75 min: a signed-in read refreshes, fails the check, keeps the copy
  } finally { h.restore(); }
  h = api('moments.js', ENV);
  try {
    const r = res(); await h.handler(req({ method: 'GET' }), r);
    assert.equal(r.body.breaking.classifiedBy, 'claude'); assert.equal(r.body.breaking.items[0].label, "Ballon d'Or 2026");
    assert.match(r.body.breaking.refreshSkipped, /brand check/);
    assert.ok(Date.now() - new Date(r.body.breaking.preparedAt).getTime() > 3600e3, 'preparedAt is the kept copy\'s time');
  } finally { s.f.restore(); h.restore(); }
});
