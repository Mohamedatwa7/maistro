// Phase 12 O4 — monitoring. An hourly cron evaluates every integration from data Maistro already stores (no
// provider calls, no renders) and keeps one open ops_alerts row per kind: raised when a check fails, resolved
// when it passes again. New alerts are POSTed to MAISTRO_ALERT_WEBHOOK when set (a Slack-compatible {text}).
// The checks (RUNBOOK.md):
const CHECKS = {
  trends_stale: { severity: 'warning', label: 'Trend scores stale' },
  trend_feed_stale: { severity: 'warning', label: 'Trend Radar / kymah feed not fetched' },
  higgsfield_failures: { severity: 'warning', label: 'Higgsfield job failure rate' },
  higgsfield_refusals: { severity: 'warning', label: 'Higgsfield refusal spike' },
  spend_ceiling: { severity: 'warning', label: 'Daily render spend near the ceiling' },
  f1x8_timeouts: { severity: 'warning', label: 'F1X8 analyses timing out' },
  tracker_stale: { severity: 'warning', label: 'Tracker data stale' },
  reconciliation: { severity: 'critical', label: 'Performance reconciliation failed or missing' },
  price_card: { severity: 'warning', label: 'Higgsfield price card incomplete or missing' },
};
const H = 36e5;
const age = (iso, now) => (iso ? (now - Date.parse(iso)) / H : Infinity);

/** Pure: which checks fail, with a message each. `d` is what load() read. */
function evaluate(d, now = Date.now()) {
  const out = {};
  const fail = (k, message, details = {}) => { out[k] = { ok: false, message, details }; };
  const pass = (k) => { out[k] = { ok: true }; };
  const ts = age(d.newestScoreAt, now); ts > 2 ? fail('trends_stale', `newest trend score is ${ts === Infinity ? 'missing' : ts.toFixed(1) + ' h old'} (hourly cron)`, { newestScoreAt: d.newestScoreAt }) : pass('trends_stale');
  const tf = age(d.newestSnapshotAt, now); tf > 2 ? fail('trend_feed_stale', `newest Trend Radar fetch is ${tf === Infinity ? 'missing' : tf.toFixed(1) + ' h old'}`, { newestSnapshotAt: d.newestSnapshotAt }) : pass('trend_feed_stale');
  const hj = d.higgsfieldJobs24h || [];
  const bad = hj.filter((j) => j.state === 'failed' || j.state === 'timed_out').length;
  hj.length >= 5 && bad / hj.length > 0.2 ? fail('higgsfield_failures', `${bad} of ${hj.length} Higgsfield jobs failed or timed out in 24 h`, { bad, total: hj.length }) : pass('higgsfield_failures');
  (d.refusals24h || 0) > 3 ? fail('higgsfield_refusals', `${d.refusals24h} renders refused (nsfw) in 24 h`, { refusals: d.refusals24h }) : pass('higgsfield_refusals');
  const sp = d.spend || { usedUsd: 0, ceilingUsd: 0 };
  sp.ceilingUsd > 0 && sp.usedUsd >= 0.8 * sp.ceilingUsd ? fail('spend_ceiling', `today's renders $${sp.usedUsd.toFixed(2)} of the $${sp.ceilingUsd.toFixed(2)} daily ceiling`, sp) : pass('spend_ceiling');
  (d.f1x8Timeouts24h || 0) >= 1 ? fail('f1x8_timeouts', `${d.f1x8Timeouts24h} F1X8 analyses timed out in 24 h`, { timeouts: d.f1x8Timeouts24h }) : pass('f1x8_timeouts');
  const fresh = (d.reconciliation && d.reconciliation.freshness) || {};
  const stale = Object.entries(fresh).filter(([, v]) => age(v.newestPost, now) > 48).map(([k, v]) => `${k} (newest ${String(v.newestPost || 'none').slice(0, 10)})`);
  stale.length ? fail('tracker_stale', `no posts in 48 h: ${stale.join(', ')}`, { stale }) : pass('tracker_stale');
  const rc = d.reconciliation;
  !rc ? fail('reconciliation', 'no reconciliation report stored') : age(rc.at, now) > 26 ? fail('reconciliation', `newest report is ${age(rc.at, now).toFixed(1)} h old (daily 06:30 cron)`, { at: rc.at }) : !rc.ok ? fail('reconciliation', `newest report failed: ${Object.entries(rc.checks || {}).filter(([, v]) => v === false).map(([k]) => k).join(', ')}`, { at: rc.at }) : pass('reconciliation');
  const pc = d.priceCard;
  !pc ? fail('price_card', 'no price card stored') : age(pc.at, now) > 26 ? fail('price_card', `newest price card is ${age(pc.at, now).toFixed(1)} h old`) : !pc.complete ? fail('price_card', 'newest price card is incomplete (some render bodies unpriced)') : pass('price_card');
  return out;
}

async function load(q, now = Date.now()) {
  const since = new Date(now - 24 * H).toISOString();
  const one = async (t, p) => (await q(t, p))[0] || null;
  const score = await one('trend_scores', 'select=at&order=at.desc&limit=1');
  const snap = await one('trend_snapshots', 'select=fetched_at&order=fetched_at.desc&limit=1');
  const hj = await q('jobs', `select=state&kind=in.(higgsfield_image,higgsfield_video)&created_at=gte.${since}&limit=1000`);
  const refusals = await q('generation_records', `select=id&status=eq.refused&at=gte.${since}&limit=1000`);
  const f1 = await q('jobs', `select=id&kind=in.(f1x8_image,f1x8_video)&state=eq.timed_out&created_at=gte.${since}&limit=1000`);
  const rc = await one('reconciliation_reports', 'select=at,ok,report&order=at.desc&limit=1');
  const pc = await one('audit_log', 'select=at,after&action=eq.higgsfield.prices&order=at.desc&limit=1');
  let spend = null; try { spend = await require('../_jobs.js').dailySpend(now); } catch (e) { spend = null; }
  return {
    newestScoreAt: score && score.at, newestSnapshotAt: snap && snap.fetched_at, higgsfieldJobs24h: hj, refusals24h: refusals.length, f1x8Timeouts24h: f1.length, spend,
    reconciliation: rc ? { at: rc.at, ok: rc.ok, checks: (rc.report || {}).checks || {}, freshness: (rc.report || {}).freshness || {} } : null,
    priceCard: pc ? { at: pc.at, complete: Boolean(pc.after && pc.after.complete) } : null,
  };
}

/** Raise / resolve alerts; post new ones to the webhook. Returns a summary. */
async function run({ queryRows, insertRows, patchRows }, now = Date.now()) {
  const results = evaluate(await load(queryRows, now), now);
  const open = await queryRows('ops_alerts', 'select=id,kind,at&resolved_at=is.null&order=at.desc&limit=500');
  const openBy = new Map(open.map((a) => [a.kind, a]));
  const raised = [], resolved = [];
  for (const [kind, r] of Object.entries(results)) {
    const cur = openBy.get(kind);
    if (!r.ok && !cur) {
      const [row] = await insertRows('ops_alerts', [{ at: new Date(now).toISOString(), kind, severity: CHECKS[kind].severity, message: `${CHECKS[kind].label}: ${r.message}`, details: r.details || {} }], { returning: true });
      raised.push({ id: row && row.id, kind, message: `${CHECKS[kind].label}: ${r.message}` });
    } else if (r.ok && cur) {
      await patchRows('ops_alerts', `id=eq.${cur.id}`, { resolved_at: new Date(now).toISOString() });
      resolved.push(kind);
    }
  }
  const hook = process.env.MAISTRO_ALERT_WEBHOOK;
  if (hook && raised.length) {
    try {
      const { fetchT } = require('../_http.js');
      const r = await fetchT(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `Maistro alerts:\n${raised.map((a) => `• ${a.message}`).join('\n')}` }) }, { timeoutMs: 10000 });
      if (r.ok) for (const a of raised) if (a.id) await patchRows('ops_alerts', `id=eq.${a.id}`, { sent_at: new Date(now).toISOString() });
    } catch (e) { console.error('[monitor] webhook failed:', e.message); }
  }
  const status = Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.ok ? 'ok' : 'alert']));
  return { at: new Date(now).toISOString(), status, raised: raised.map((a) => a.kind), resolved };
}

module.exports = { evaluate, load, run, CHECKS };
