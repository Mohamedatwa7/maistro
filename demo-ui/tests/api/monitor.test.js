// Phase 12 O4 — the monitor: each check from stored data, one open alert per kind (raised once, resolved when it
// passes), new alerts posted to the webhook and marked sent; the route runs only for the cron.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const M = require('../../api/_ops/monitor.js');

const NOW = Date.parse('2026-10-22T12:00:00Z');
const h = (x) => new Date(NOW - x * 36e5).toISOString();
const healthy = () => ({
  newestScoreAt: h(0.5), newestSnapshotAt: h(0.5), higgsfieldJobs24h: Array.from({ length: 10 }, () => ({ state: 'succeeded' })), refusals24h: 0, f1x8Timeouts24h: 0,
  spend: { usedUsd: 10, ceilingUsd: 100 }, reconciliation: { at: h(5), ok: true, checks: {}, freshness: { tiktok: { newestPost: h(10) } } }, priceCard: { at: h(3), complete: true },
});

test('evaluate: healthy data passes every check; each failure is reported with its reason', () => {
  assert.ok(Object.values(M.evaluate(healthy(), NOW)).every((r) => r.ok));
  const d = healthy();
  d.newestScoreAt = h(3); d.newestSnapshotAt = null;
  d.higgsfieldJobs24h = [...Array(7).fill({ state: 'succeeded' }), ...Array(3).fill({ state: 'failed' })];
  d.refusals24h = 4; d.f1x8Timeouts24h = 1; d.spend = { usedUsd: 85, ceilingUsd: 100 };
  d.reconciliation = { at: h(30), ok: true, checks: {}, freshness: { x: { newestPost: h(24 * 6) }, tiktok: { newestPost: h(5) } } };
  d.priceCard = { at: h(2), complete: false };
  const r = M.evaluate(d, NOW);
  assert.deepEqual(Object.entries(r).filter(([, v]) => !v.ok).map(([k]) => k).sort(), ['f1x8_timeouts', 'higgsfield_failures', 'higgsfield_refusals', 'price_card', 'reconciliation', 'spend_ceiling', 'tracker_stale', 'trend_feed_stale', 'trends_stale']);
  assert.match(r.tracker_stale.message, /x \(newest 2026-10-16\)/); assert.doesNotMatch(r.tracker_stale.message, /tiktok/);
  assert.match(r.higgsfield_failures.message, /3 of 10/); assert.match(r.reconciliation.message, /30\.0 h old/);
  // fewer than 5 Higgsfield jobs: no failure-rate verdict
  assert.ok(M.evaluate({ ...healthy(), higgsfieldJobs24h: [{ state: 'failed' }] }, NOW).higgsfield_failures.ok);
});

test('run: an alert is raised once, posted to the webhook and marked sent; resolved when the check passes again', async () => {
  const pg = fakePostgrest();
  const posts = [];
  const f = mockFetch([['https://hooks.example/alert', (u, init) => { posts.push(JSON.parse(init.body)); return new Response('ok', { status: 200 }); }], pg.route]);
  const saved = { ...process.env };
  Object.assign(process.env, { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', MAISTRO_ALERT_WEBHOOK: 'https://hooks.example/alert' });
  try {
    const S = require('../../api/_supabase.js');
    pg.tables.trend_scores = [{ id: 1, at: h(5), trend_id: 't', name: 'n', prompt_version: 'v', weights_version: 'w', status: 'scored' }];
    let out = await M.run(S, NOW);
    assert.ok(out.raised.includes('trends_stale')); assert.equal(out.status.trends_stale, 'alert');
    const first = pg.tables.ops_alerts.filter((a) => a.kind === 'trends_stale');
    assert.equal(first.length, 1); assert.ok(first[0].sent_at, 'posted and marked sent');
    assert.match(posts[0].text, /Trend scores stale: newest trend score is 5\.0 h old/);
    out = await M.run(S, NOW + 60e3);
    assert.equal(pg.tables.ops_alerts.filter((a) => a.kind === 'trends_stale').length, 1, 'not raised twice');
    pg.tables.trend_scores[0].at = new Date(NOW).toISOString();
    out = await M.run(S, NOW + 120e3);
    assert.ok(out.resolved.includes('trends_stale')); assert.ok(pg.tables.ops_alerts.find((a) => a.kind === 'trends_stale').resolved_at);
  } finally { f.restore(); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('route: the cron runs the checks; a signed-in GET lists open alerts; anything else is 401', async () => {
  const pg = fakePostgrest();
  (pg.tables.ops_alerts = []).push({ id: 1, at: h(1), kind: 'tracker_stale', severity: 'warning', message: 'x stale', resolved_at: null });
  const f = mockFetch([pg.route]);
  const hh = api('monitor.js', { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', CRON_SECRET: 'cron', MAISTRO_ALERT_WEBHOOK: undefined });
  try {
    let r = res(); await hh.handler(req({ session: false }), r); assert.equal(r.statusCode, 401);
    r = res(); await hh.handler(req(), r); assert.equal(r.statusCode, 200); assert.equal(r.body.open[0].kind, 'tracker_stale');
    r = res(); await hh.handler(req({ headers: { authorization: 'Bearer cron' }, session: false }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.ok(r.body.status && 'reconciliation' in r.body.status);
  } finally { f.restore(); hh.restore(); }
});
