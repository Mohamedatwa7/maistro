// Live reference videos per moment (api/_trends/moment-videos.js): TikHub keyword search, past week,
// Gulf creators first, caption blocklist + Claude check, refreshed by the cron only. No real network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, anthropicReply, json, text } = require('../helpers');

const NOW = Date.parse('2026-10-29T08:00:00Z');
const aweme = (id, o = {}) => ({ aweme_info: { aweme_id: String(7700000000000000000n + BigInt(id)), desc: o.caption || `clip ${id} #halloween`, region: o.region || 'US', create_time: Math.floor((NOW - (o.daysOld ?? 2) * 864e5) / 1000), author: { unique_id: o.handle || `creator${id}` }, statistics: { play_count: o.views ?? 100000, digg_count: 10 } } });
const page = (items) => json({ code: 200, data: { data: items } });

test('queries: the main keyword, plus the keyword with the first market\'s city (TikHub honours a city in the query, not its region parameter)', () => {
  const v = require('../../api/_trends/moment-videos.js');
  assert.deepEqual(v.queriesFor({ label: 'Halloween', keywords: ['halloween', 'costume'], markets: ['AE', 'QA'] }), ['halloween', 'halloween dubai']);
  assert.deepEqual(v.queriesFor({ label: 'Saudi Founding Day', keywords: ['founding day', 'يوم التأسيس'], markets: ['SA'] }), ['founding day', 'founding day riyadh']);
  assert.deepEqual(v.queriesFor({ label: 'Dubai Shopping Festival', keywords: ['dubai shopping festival'], markets: ['AE'] }), ['dubai shopping festival'], 'no doubled city');
  assert.deepEqual(v.queriesFor({ label: "Ballon d'Or 2026", keywords: [], markets: [] }), ["ballon d'or 2026"], 'falls back to the label');
});

test('clips: older than 14 days, under 5K views, or a blocked caption or creator are dropped; Gulf creators rank first and one clip per creator', async () => {
  const v = require('../../api/_trends/moment-videos.js');
  const r = await page([aweme(1, { views: 9e6 }), aweme(2, { region: 'AE', views: 2e5 }), aweme(3, { daysOld: 20 }), aweme(4, { views: 100 }), aweme(5, { caption: 'so sexy #halloween' }), aweme(6, { handle: 'sophie rain' }), aweme(7, { region: 'QA', views: 3e5 }), aweme(8, { region: 'AE', views: 1e5, handle: 'creator2' })]).json();
  const clips = v.clipsOf(r, NOW);
  assert.deepEqual(clips.map((c) => c.vid.slice(-1)), ['1', '2', '7', '8']);
  assert.deepEqual(v.rank(clips).map((c) => [c.region, c.handle]), [['QA', '@creator7'], ['AE', '@creator2'], ['US', '@creator1']], 'Gulf first by views; creator2\'s second clip dropped');
  assert.deepEqual(Object.keys(clips[0]).sort(), ['caption', 'handle', 'likes', 'postedAt', 'region', 'vid', 'views'], 'the { vid, handle } shape the trend cards already play');
});

test('refresh: only due moments are searched, within the per-run call cap; Claude keeps only the captions it approves; without a key nothing is spent', async () => {
  const v = require('../../api/_trends/moment-videos.js');
  const searched = [];
  let approve = null;
  const f = mockFetch([
    [/api\.tikhub\.io\/api\/v1\/tiktok\/app\/v3\/fetch_general_search_result/, (u, init) => {
      assert.equal(init.headers.Authorization, 'Bearer tk');
      const q = new URL(u).searchParams; searched.push(q.get('keyword'));
      assert.equal(q.get('publish_time'), '7', 'past week only'); assert.equal(q.get('sort_type'), '1');
      const base = searched.length * 10;
      return page([aweme(base + 1, { region: 'AE' }), aweme(base + 2), aweme(base + 3, { caption: 'off-brand but not blocklisted' })]);
    }],
    ['api.anthropic.com', (u, init) => { const vids = JSON.parse(JSON.parse(init.body).messages[0].content.replace(/^VIDEOS:\n/, '').replace(/\n\nList the vids to keep\.$/, '')).filter((x) => !/off-brand/.test(x.caption)).map((x) => x.vid); approve = vids; return anthropicReply({ ok: vids }); }],
  ]);
  const saved = { t: process.env.TIKHUB_API_KEY, a: process.env.ANTHROPIC_API_KEY };
  try {
    delete process.env.TIKHUB_API_KEY;
    let out = await v.refresh([{ id: 'halloween', label: 'Halloween', keywords: ['halloween'], markets: ['AE'] }], {}, { now: NOW });
    assert.equal(out.calls, 0); assert.match(out.errors[0], /TIKHUB_API_KEY/); assert.equal(searched.length, 0);
    process.env.TIKHUB_API_KEY = 'tk'; process.env.ANTHROPIC_API_KEY = 'k';
    const fresh = { at: new Date(NOW - 3600e3).toISOString(), videos: [{ vid: 'kept' }] };
    out = await v.refresh([
      { id: 'halloween', label: 'Halloween', keywords: ['halloween'], markets: ['AE'] },
      { id: 'diwali', label: 'Diwali', keywords: ['diwali'], markets: ['AE'] },
    ], { byId: { diwali: fresh, gone: fresh } }, { now: NOW });
    assert.deepEqual(searched, ['halloween', 'halloween dubai'], 'diwali was refreshed an hour ago: not due');
    assert.equal(out.calls, 2); assert.equal(out.captionsCheckedBy, 'claude');
    assert.deepEqual(out.byId.diwali, fresh, 'kept as stored'); assert.ok(!out.byId.gone, 'a moment no longer listed drops out');
    const hv = out.byId.halloween.videos;
    assert.ok(hv.length >= 2 && hv.length <= 6 && hv.every((c) => approve.includes(c.vid)), 'only Claude-approved captions');
    assert.ok(!hv.some((c) => /off-brand/.test(c.caption))); assert.equal(hv[0].region, 'AE', 'Gulf creator first');
    // an empty moment retries after an hour; a full one waits six
    searched.length = 0;
    const hourAgo = new Date(NOW - 3700e3).toISOString();
    await v.refresh([{ id: 'a', label: 'A', keywords: ['aaa'], markets: [] }, { id: 'b', label: 'B', keywords: ['bbb'], markets: [] }], { byId: { a: { at: hourAgo, videos: [] }, b: { at: hourAgo, videos: [{ vid: 'x' }] } } }, { now: NOW });
    assert.deepEqual(searched, ['aaa']);
    // the per-run cap: 25 moments × 2 queries never exceeds 40 calls
    searched.length = 0;
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, label: `Moment ${i}`, keywords: [`moment ${i}`], markets: ['SA'] }));
    out = await v.refresh(many, {}, { now: NOW });
    assert.equal(out.calls, 40); assert.equal(searched.length, 40); assert.equal(Object.keys(out.byId).length, 20, 'the rest wait for the next run');
  } finally { f.restore(); for (const [k, e] of [['TIKHUB_API_KEY', saved.t], ['ANTHROPIC_API_KEY', saved.a]]) { if (e === undefined) delete process.env[k]; else process.env[k] = e; } }
});

test('GET /api/moments: the cron refreshes the referenced moments\' videos and stores them; a signed-in read attaches them without searching', async () => {
  const { fakePostgrest } = require('../fake-postgrest');
  const pg = fakePostgrest();
  let tik = 0;
  const f = mockFetch([
    [/trends\.google\.com/, () => text('<rss><channel></channel></rss>')],
    [/wikimedia\.org/, () => json({ items: [{ articles: [] }] })],
    [/api\.tikhub\.io/, () => { tik++; return page([aweme(tik * 10 + 1, { region: 'AE' })]); }],
    ['api.anthropic.com', (u, init) => { const b = JSON.parse(init.body); if (/VIDEOS:/.test(b.messages[0].content)) return anthropicReply({ ok: JSON.parse(b.messages[0].content.replace(/^VIDEOS:\n/, '').replace(/\n\nList the vids to keep\.$/, '')).map((x) => x.vid) }); return anthropicReply({ items: [] }); }],
    pg.route,
  ]);
  const ENV = { ANTHROPIC_API_KEY: 'k', TIKHUB_API_KEY: 'tk', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', CRON_SECRET: 'cron' };
  const RealDate = Date; global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
  let h = api('moments.js', ENV);
  try {
    let r = res(); await h.handler(req({ method: 'GET', headers: { authorization: 'Bearer cron' }, session: false }), r);
    assert.ok(r.body.videos.calls > 0 && r.body.videos.calls <= 40); assert.equal(r.body.videos.captionsCheckedBy, 'claude');
    const row = pg.tables.trends_cache.find((x) => x.id === 'moment-videos');
    assert.ok(row.payload.byId.halloween.videos.length, 'Halloween (in 2 days) has its videos');
    assert.ok(!row.payload.byId.ramadan, 'Ramadan is 102 days out: not referenced yet');
  } finally { h.restore(); }
  h = api('moments.js', ENV);
  try {
    const before = tik;
    const r = res(); await h.handler(req({ method: 'GET' }), r);
    assert.equal(tik, before, 'a read never searches');
    const hw = r.body.upcoming.find((x) => x.id === 'halloween');
    assert.equal(hw.videos[0].region, 'AE'); assert.ok(hw.videosAt); assert.equal(hw.captionsCheckedBy, 'claude');
    assert.ok(!r.body.upcoming.find((x) => x.id === 'ramadan').videos);
  } finally { global.Date = RealDate; f.restore(); h.restore(); }
});
