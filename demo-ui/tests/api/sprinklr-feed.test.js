// The Calendar's Sprinklr feed: what the owned accounts posted and have lined up, read-only. Future and past are
// separate reporting queries (feed posts only, MESSAGE_TYPE 2); a sent post keeps its permalink; a MESSAGE_ row
// counts only while it is a draft or in approval; nothing but reads reach Sprinklr; 10-minute cache.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const SP = 'https://api3.sprinklr.com/prod/api/v3';
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SPRINKLR_API_KEY: 'sk', SPRINKLR_ACCESS_TOKEN: 'st', SPRINKLR_ENV: 'prod', SPRINKLR_FEED_ACCOUNTS: undefined };
const NOW = Date.parse('2026-10-26T12:00:00Z');
function double() {
  const s = { calls: [] };
  const route = [SP, (u, init) => {
    const url = new URL(u); const key = `${init.method || 'GET'} ${url.pathname.replace('/prod/api/v3', '')}`;
    const body = init.body ? JSON.parse(init.body) : null;
    s.calls.push({ key, url, body });
    if (key === 'POST /reports/query') {
      const future = body.startTime >= NOW;
      return json({ data: { data: future
        ? [{ UNIQUE_MESSAGE_ID: 'POST_501', ACCOUNT_ID: '53027', OUTBOUND_STATUS: 'SCHEDULED', SCHEDULE_DATE: String(Date.parse('2026-10-28T07:30:00Z')) },
          { UNIQUE_MESSAGE_ID: 'MESSAGE_500', ACCOUNT_ID: '53027', OUTBOUND_STATUS: 'CONVERTED_TO_POSTS', SCHEDULE_DATE: String(Date.parse('2026-10-28T07:30:00Z')) },
          { UNIQUE_MESSAGE_ID: 'MESSAGE_600', ACCOUNT_ID: '1776286', OUTBOUND_STATUS: 'DRAFT', SCHEDULE_DATE: String(Date.parse('2026-10-30T10:00:00Z')) }]
        : [{ UNIQUE_MESSAGE_ID: 'POST_401', ACCOUNT_ID: '1776286', OUTBOUND_STATUS: 'SENT', SCHEDULE_DATE: String(Date.parse('2026-10-26T09:00:03Z')) },
          { UNIQUE_MESSAGE_ID: 'POST_402', ACCOUNT_ID: '999', OUTBOUND_STATUS: 'SENT', SCHEDULE_DATE: String(Date.parse('2026-10-25T09:00:00Z')) },
          { UNIQUE_MESSAGE_ID: 'POST_403', ACCOUNT_ID: '6625', OUTBOUND_STATUS: 'RECALLED', SCHEDULE_DATE: String(Date.parse('2026-10-25T08:00:00Z')) }], hasMore: false }, errors: [] });
    }
    if (key === 'GET /publishing/post') return json({ data: url.searchParams.get('id').split(',').map((id) => ({ id: Number(id), content: { text: `post ${id}`, attachment: { type: 'VIDEO' } }, permalink: id === '401' ? 'https://www.tiktok.com/@samsunggulf/video/1' : undefined })) });
    if (key === 'GET /publishing/draft') return json({ data: url.searchParams.get('id').split(',').map((id) => ({ id: Number(id), content: { text: `draft ${id}` } })) });
    return json({ errors: [{ message: 'unexpected' }] }, 404);
  }];
  return { s, route };
}

test('feed: scheduled and draft ahead, posted behind, feed posts only; reads only; cached', async () => {
  const sp = double();
  const f = mockFetch([sp.route]);
  const studio = api('studio.js', ENV);
  try {
    const F = require('../../api/_studio/sprinklr/feed.js');
    const out = await F.feed({ now: NOW });
    assert.deepEqual(out.items.map((i) => [i.id, i.platform, i.status]), [['600', 'tiktok', 'draft'], ['501', 'instagram', 'scheduled'], ['401', 'tiktok', 'posted']], 'newest first; the other account, the recalled post and the converted parent are left out');
    assert.equal(out.items[2].permalink, 'https://www.tiktok.com/@samsunggulf/video/1'); assert.equal(out.items[2].text, 'post 401'); assert.equal(out.items[2].media, 'VIDEO');
    assert.equal(out.items[0].text, 'draft 600');
    const reports = sp.s.calls.filter((c) => c.key === 'POST /reports/query');
    assert.equal(reports.length, 2, 'future and past are separate queries');
    assert.ok(reports[0].body.startTime >= NOW && reports[1].body.endTime <= NOW, 'the future first');
    for (const r of reports) {
      assert.deepEqual(r.body.filters.find((x) => x.dimensionName === 'MESSAGE_TYPE').values, ['2'], 'feed posts only, no replies or messages');
      assert.deepEqual([...r.body.filters.find((x) => x.dimensionName === 'ACCOUNT_ID').values].sort(), ['1776286', '53027', '6625', '7952', '7953']);
      assert.ok(!r.body.groupBys.some((g) => g.dimensionName === 'PUBLISHED_TIME'), 'a group on PUBLISHED_TIME would drop the scheduled posts');
    }
    const C = require('../../api/_studio/sprinklr/client.js');
    assert.ok(sp.s.calls.every((c) => C.ALLOWED.has(c.key) && !C.WRITES.has(c.key)), 'reads only');
    const n = sp.s.calls.length;
    await F.feed({ now: NOW + 60000 });
    assert.equal(sp.s.calls.length, n, 'served from the 10-minute cache');
  } finally { f.restore(); studio.restore(); }
});

test('feed route: session-gated JSON; not configured says so; a Sprinklr failure is reported, not thrown', async () => {
  let sp = double();
  let f = mockFetch([sp.route, fakePostgrest().route]);
  let studio = api('studio.js', { ...ENV, SPRINKLR_ACCESS_TOKEN: undefined });
  try {
    const r = res(); await studio.handler(req({ query: { sprinklr: 'feed' } }), r);
    assert.deepEqual([r.statusCode, r.body.configured, r.body.items], [200, false, []]);
    assert.equal(sp.s.calls.length, 0);
    const r2 = res(); await studio.handler(req({ query: { sprinklr: 'feed' }, session: false }), r2);
    assert.equal(r2.statusCode, 401, 'needs a session');
  } finally { f.restore(); studio.restore(); }

  f = mockFetch([[SP, () => json({ errors: [{ message: 'token.expired' }] }, 401)], fakePostgrest().route]);
  studio = api('studio.js', ENV);
  try {
    const r = res(); await studio.handler(req({ query: { sprinklr: 'feed' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.configured, true); assert.match(r.body.error, /answered 401: token\.expired/);
  } finally { f.restore(); studio.restore(); }
});
