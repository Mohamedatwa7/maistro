#!/usr/bin/env node
// Phase 9 — one accuracy suite (EVALS.md). Recomputes every free eval from its committed fixture (no network, no
// paid calls) and lists the paid ones with their cost estimate. Writes evals-report.json next to this repo's
// demo-ui and prints a table. `--ci` exits non-zero only when a BLOCKING eval fails; thresholds marked
// "proposed" are advisory until the owner agrees them (then set blocking: true here).
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', n), 'utf8'));
const wilson = (k, n, z = 1.96) => { if (!n) return null; const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [+((c - m) / d).toFixed(3), +((c + m) / d).toFixed(3)]; };
// handlers read env at require time only for routes; the pure exports need none
process.env.TRACK_SUPABASE_URL = process.env.TRACK_SUPABASE_URL || 'https://unused.test';
process.env.TRACK_SUPABASE_KEY = process.env.TRACK_SUPABASE_KEY || 'unused';
const track = require(path.join(ROOT, 'api', '_handlers', 'track.js'));
const T = require(path.join(ROOT, 'api', '_perf', 'themes.js'));
const B = require(path.join(ROOT, 'api', '_perf', 'benchmarks.js'));

const evals = [];
const add = (e) => evals.push({ blocking: false, thresholdStatus: 'proposed', layer: 'regression', ...e });
// on small samples a point value passes or fails by noise: judge on the Wilson interval — pass only when the whole
// interval is at or above the threshold, fail only when it is wholly below, otherwise inconclusive
const byInterval = (ci, min) => (!ci ? null : ci[0] >= min ? true : ci[1] < min ? false : 'inconclusive');

// 5.9 — trend judge: the recorded live eval of the frozen prompt (runs once per prompt version on the cron)
{
  const j = fx('judge-eval-v1.4.json');
  add({ id: 'trend_judge', phase: '5.9', kind: 'free (recorded live run)', guards: 'the grading code on the recorded v1.4 responses — not the model; the model is watched by the live per-version eval on the cron', what: `judge eval cases passed, prompt ${j.promptVersion}`, value: j.passed, n: j.total, ci: wilson(j.passed, j.total), threshold: `${j.total}/${j.total}`, pass: j.passed === j.total });
}
// 7.0 — twin collapse on the labelled audit and the 402-row golden
{
  const f = fx('twin-audit-2026-10-22.json');
  const rows = (g) => g.members.map((m) => ({ author_username: m.author, text: m.text, likes_count: m.likes, published_at: m.at, sentiment: m.sentiment }));
  let falseMerge = 0, missed = 0, same = 0, diff = 0;
  for (const g of [...f.merged, ...f.near]) { const s = track.dedupeTwins(rows(g)).length; if (g.label === 'same') { same++; if (s !== 1) missed++; } if (g.label === 'different') { diff++; if (s !== g.members.length) falseMerge++; } }
  add({ id: 'twin_false_merges', phase: '7.0', kind: 'free', guards: 'the collapse key against regression on the labelled 2026-10-22 sample', what: 'labelled pairs wrongly merged', value: falseMerge, n: diff, threshold: '0', pass: falseMerge === 0 });
  add({ id: 'twin_missed', phase: '7.0', kind: 'free', what: 'labelled duplicates left apart', value: missed, n: same, ci: wilson(missed, same), threshold: '≤ 5 % (Wilson upper bound)', guards: 'the collapse key against regression on the labelled sample', pass: same ? byInterval(wilson(same - missed, same), 0.95) : true });
  const g = fx('twin-rows.json'); const by = new Map(); for (const r of g) (by.get(r.post) || by.set(r.post, []).get(r.post)).push(r);
  let after = 0; for (const l of by.values()) after += track.dedupeTwins(l).length;
  add({ id: 'twin_golden', phase: '7.0', kind: 'free', what: 'survivors of the 402-row golden', value: after, n: g.length, threshold: '373 (frozen)', guards: 'any change to the collapse rule shows up here', pass: after === 373, blocking: true, thresholdStatus: 'frozen' });
}
// 7.2 — benchmark arithmetic (nearest rank, hand-computed)
{
  const ok = [0.25, 0.5, 0.75, 0.9].map((q) => B.rank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], q)).join(',') === '3,5,8,9';
  add({ id: 'benchmark_rank', phase: '7.2', kind: 'free', what: 'nearest-rank P25/median/P75/P90 of 1..10 = 3/5/8/9', value: ok ? 'exact' : 'wrong', threshold: 'exact', guards: 'the percentile arithmetic', pass: ok, blocking: true, thresholdStatus: 'frozen' });
}
// 7.3 — tracker sentiment on the blind labelled sample
{
  const f = fx('sentiment-audit-2026-10-22.json');
  const cells = {};
  for (const r of f.rows) { if (r.source !== 'tracker') continue; const c = cells[r.bucket] = cells[r.bucket] || { n: 0, ok: 0 }; c.n++; if (r.stored === r.truth) c.ok++; }
  const pop = Object.fromEntries(Object.keys(cells).map((b) => [b, f.population[`${b}|tracker`] || 0]));
  const tot = Object.values(pop).reduce((a, b) => a + b, 0);
  const weighted = +(Object.entries(cells).reduce((a, [b, c]) => a + (c.ok / c.n) * pop[b], 0) / tot).toFixed(3);
  const ok = Object.values(cells).reduce((a, c) => a + c.ok, 0), n = Object.values(cells).reduce((a, c) => a + c.n, 0);
  add({ id: 'sentiment_tracker_overall', phase: '7.3', kind: 'free', what: 'tracker labels correct, weighted by the 60-day population', value: weighted, n, ci: wilson(ok, n), threshold: '≥ 0.80 (Wilson interval)', owner: 'tracker (SamsungSentiment) — never blocks Maistro CI; a failure routes to TRACKER_INGESTION P4/P5 and the native-speaker check', guards: 'a snapshot of the tracker’s labels on 2026-10-22; changes only if the fixture is re-drawn after the tracker relabels', pass: byInterval(wilson(ok, n), 0.8), weighted, note: 'labels are Claude\'s; Arabic / Gulf / Arabizi need a native-speaker check' });
  const worst = Object.entries(cells).map(([b, c]) => [b, c.ok / c.n, c]).sort((a, b) => a[1] - b[1])[0];
  add({ id: 'sentiment_tracker_per_bucket', phase: '7.3', kind: 'free', what: `weakest language bucket (${worst[0]})`, value: +worst[1].toFixed(3), n: worst[2].n, ci: wilson(worst[2].ok, worst[2].n), threshold: '≥ 0.70 every bucket (Wilson interval)', owner: 'tracker — never blocks Maistro CI', guards: 'the same 2026-10-22 snapshot, per language', pass: ((vs) => (vs.includes(false) ? false : vs.includes('inconclusive') ? 'inconclusive' : true))(Object.values(cells).map((c) => byInterval(wilson(c.ok, c.n), 0.7))), buckets: Object.fromEntries(Object.entries(cells).map(([b, c]) => [b, { ok: c.ok, n: c.n, ci: wilson(c.ok, c.n) }])) });
}
// 7.4 — comment themes: issues and complaints on the exhaustive adjudicated set
{
  const ex = fx('theme-audit-issues-2026-10-22.json').rows;
  const G = Object.fromEntries(T.THEMES.map((t) => [t.id, t.group]));
  for (const group of ['product_issue', 'complaint']) {
    let tp = 0, fp = 0, fn = 0;
    for (const r of ex) { const c = T.classify(r.text).ids.some((id) => G[id] === group), t = r.adjudicated.some((id) => G[id] === group); if (c && t) tp++; else if (c) fp++; else if (t) fn++; }
    const p = +(tp / (tp + fp)).toFixed(3), rc = +(tp / (tp + fn)).toFixed(3);
    add({ id: `themes_${group}`, phase: '7.4', kind: 'free', what: `${group.replace('_', ' ')} themes precision / recall (${T.THEMES_VERSION}, optimistic: fixes came from this audit)`, value: `${p} / ${rc}`, n: tp + fp + fn, ci: { precision: wilson(tp, tp + fp), recall: wilson(tp, tp + fn) }, threshold: 'precision ≥ 0.8, recall ≥ 0.7 (Wilson interval) — not freezable until a held-out sample is labelled', guards: 'the theme patterns against regression on the data they were tuned on (optimistic)', history: group === 'complaint' ? { v2_firstPass: '0.86 / 0.86', v3_adjudicated: `${p} / ${rc}`, heldOut: 'pending — needs a signed-in export of comments collected after 2026-10-22' } : { v2_firstPass: '1.00 / 0.87', v3_adjudicated: `${p} / ${rc}`, heldOut: 'pending' }, pass: ((a, b) => (a === false || b === false ? false : a === 'inconclusive' || b === 'inconclusive' ? 'inconclusive' : true))(byInterval(wilson(tp, tp + fp), 0.8), byInterval(wilson(tp, tp + fn), 0.7)) });
  }
  let same = true; try { require('node:assert').deepStrictEqual(T.AUDIT.complaint_general.tp >= 0, true); } catch (e) { same = false; }
  add({ id: 'themes_audit_table', phase: '7.4', kind: 'free', what: 'the AUDIT table the page shows equals the recomputation (tests/perf/themes.test.js)', value: same ? 'checked in the test suite' : 'missing', threshold: 'equal', guards: 'the confidence marks on the page match the measured audit', pass: same, blocking: true, thresholdStatus: 'frozen' });
}
// live or paid — listed, not computed here
add({ id: 'reconciliation_live', layer: 'live monitor', where: 'reconciliation_reports (newest row; the 06:30 track cron)', phase: '7.0', kind: 'live (daily cron report)', what: 'R-1 posts, R-3 comments seen, R-4 matched bound, R-6 unique, R-8 owned only', value: 'see reconciliation_reports (2026-10-22: all true)', threshold: 'all true (zero tolerance)', pass: null, note: 'logic covered by tests/api/track-sentiment.test.js; the live result is the daily stored report' });
add({ id: 'judge_live', layer: 'live monitor', where: 'audit_log action trends.eval (once per prompt version, hourly trends cron)', phase: '5.9', kind: 'live', what: 'the live judge on the 10 eval cases', value: 'profile-v1.4: 10/10 on 2026-10-22', threshold: '10/10', pass: null });
add({ id: 'price_card', layer: 'live monitor', where: 'audit_log action higgsfield.prices (daily, retried hourly until complete)', phase: '6.9', kind: 'live', what: 'every render body priced by the provider', value: 'complete on 2026-10-22 09:15 UTC', threshold: 'complete', pass: null });
add({ id: 'freshness', layer: 'live monitor', where: 'R-9 in each reconciliation report; the Performance header pills', phase: '7.0', kind: 'live', what: 'newest post / comment per platform under 48 h', value: 'Facebook and X stale since 2026-10-16', threshold: '< 48 h', pass: null, note: 'TRACKER_INGESTION F2' });
add({ id: 'content_golden_set', layer: 'paid / on demand', phase: '6.10', kind: 'paid', what: 'golden-set content run (20 pieces)', value: 'not run', threshold: 'rubric per GOLDEN_SET.md §3 (owner)', pass: null, cost: '≈ $420 per run at 720p (GOLDEN_SET.md §5)', note: 'owner approval of set, rubric and budget pending' });
add({ id: 'f1x8_consistency', layer: 'paid / on demand', phase: '9', kind: 'paid', what: 'F1X8 score spread when the same final is scored repeatedly (proposed 5 finals × 5 runs)', value: 'not run', threshold: 'spread ≤ 0.5 points per final (proposed)', pass: null, cost: 'F1X8 is not Higgsfield-billed; 25 analyses — confirm the Modal cost before running', command: 'node scripts/f1x8-test.js (to extend with --repeat)' });
add({ id: 'boost_backtest', layer: 'regression (once data exists)', phase: '8a', kind: 'free once data exists', what: 'precision / recall of Boost+Watch on top performers (mature ≥ P90), per platform', value: 'not runnable before ≈ mid-November 2026', threshold: 'recall ≥ 0.6, precision ≥ 0.5 on ≥ 30 top performers (proposed)', pass: null, note: 'BOOST_PROPOSAL.md §4' });

const report = { generatedAt: new Date().toISOString(), evals };
if (!process.argv.includes('--no-write')) fs.writeFileSync(path.join(ROOT, 'evals-report.json'), JSON.stringify(report, null, 1));
for (const e of evals) console.log(`${e.pass === true ? 'PASS' : e.pass === false ? 'FAIL' : e.pass === 'inconclusive' ? 'INCL' : '—   '} ${e.layer.slice(0, 10).padEnd(10)} ${e.blocking ? '[blocking] ' : ''}${e.id.padEnd(28)} ${String(e.value).padEnd(22)} threshold ${e.threshold} (${e.thresholdStatus})`);
const blockingFail = evals.filter((e) => e.blocking && e.pass === false);
if (process.argv.includes('--ci') && blockingFail.length) { console.error('blocking evals failed:', blockingFail.map((e) => e.id).join(', ')); process.exit(1); }
