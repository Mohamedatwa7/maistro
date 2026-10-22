# EVALS — Phase 9: the system-wide accuracy suite

Status 2026-10-22: built. `npm run evals` (in `demo-ui`) recomputes every free eval from its committed fixture
and writes `evals-report.json`; CI runs it with `--ci`. **Only the frozen evals block CI.** Every other threshold
is **proposed** and advisory until the owner agrees it (then it is set `blocking: true` in `scripts/evals.js`).

Two kinds of eval, kept apart because they answer different questions:
- **Regression evals** run on fixtures in CI. They guard *our code* against changing behaviour. They do **not**
  measure today's real-world accuracy: a fixture of recorded responses or stored labels only changes when it is
  re-drawn.
- **Live accuracy monitors** run against production data on a schedule. Each one names where its latest result
  lives.

**Verdicts on small samples use the Wilson 95 % interval.** An eval passes only when the whole interval is at or
above the threshold, and fails only when it is wholly below; otherwise it is **inconclusive**. A 13/20 bucket
(interval 0.43–0.82) neither passes nor fails a 0.70 bar by its point value alone.

## 1. Regression evals (fixtures, CI)

| Eval | Guards | Fixture | Result 2026-10-22 | Threshold | Status |
|---|---|---|---|---|---|
| `trend_judge` (5.9) | the grading code on the recorded v1.4 responses — not the model | `judge-eval-v1.4.json` | 10/10 | 10/10 | proposed |
| `twin_false_merges` (7.0) | the collapse key | `twin-audit-2026-10-22.json` | 0 of 13 different pairs merged | 0 | proposed |
| `twin_missed` (7.0) | the collapse key | same | 0 of 58 duplicates left apart (Wilson ≥ 0.938) | ≤ 5 % | **inconclusive** (n too small to show ≤ 5 %) |
| `twin_golden` (7.0) | any change to the collapse rule | `twin-rows.json` | 373 of 402 survive | 373 | **frozen, blocking** |
| `benchmark_rank` (7.2) | the percentile arithmetic | hand-computed | exact | exact | **frozen, blocking** |
| `sentiment_tracker_overall` (7.3) | a snapshot of the *tracker's* labels | `sentiment-audit-2026-10-22.json` | 0.90 weighted; 84/100 (0.76–0.90) | ≥ 0.80 | inconclusive |
| `sentiment_tracker_per_bucket` (7.3) | the same snapshot, per language | same | weakest: Arabic 13/20 (0.43–0.82) | ≥ 0.70 every bucket | inconclusive |
| `themes_product_issue` (7.4) | the theme patterns, on the data they were tuned on | `theme-audit-issues-2026-10-22.json` | 1.00 / 0.97 | P ≥ 0.8, R ≥ 0.7 | pass; **not freezable** until a held-out sample |
| `themes_complaint` (7.4) | the same | same | 0.95 / 0.95 | P ≥ 0.8, R ≥ 0.7 | pass; **not freezable** until a held-out sample |
| `themes_audit_table` (7.4) | that the confidence marks on the page match the measured audit | both theme fixtures (`tests/perf/themes.test.js`) | equal | equal | **frozen, blocking** |
| `boost_backtest` (8a) | precision and recall of Boost / Watch on top performers | snapshots, once they mature | not runnable before ≈ mid-November 2026 | recall ≥ 0.6, precision ≥ 0.5 on ≥ 30 top performers | proposed (BOOST_PROPOSAL.md §4) |

**The tracker's sentiment is the tracker's, not Maistro's code.** It never blocks Maistro CI. A failure routes to
TRACKER_INGESTION.md P4 (backfill and corpus caps) and P5 (prompt), plus the native-speaker check.

**Themes history (complaints · product issues, precision / recall):**

| Version | Complaints | Product issues | Basis |
|---|---|---|---|
| v1 | — | — | price precision 0.31, "wants to buy" 0.13 |
| v2 | 0.86 / 0.86 | 1.00 / 0.87 | first-pass labels |
| v3 | 0.95 / 0.95 | 1.00 / 0.97 | adjudicated labels (optimistic, tuned on this set) |
| **Held-out** | *pending* | *pending* | needs comments collected after 2026-10-22, labelled blind |

The held-out sample needs a signed-in export of comments collected after 2026-10-22. Since 315c2c9 the comment
read needs a session, so this is an owner action (save `/api/track?days=7` while signed in) or a later session.

## 2. Live accuracy monitors (production, scheduled)

| Monitor | What it watches | Where the latest result lives | Latest known |
|---|---|---|---|
| Reconciliation (7.0) | R-1 posts, R-3 comments seen, R-4 matched bound, R-6 unique, R-8 owned only — zero tolerance | `reconciliation_reports`, the newest row (06:30 track cron); `/api/track?reconcile=latest` signed-in | 2026-10-22: all true |
| Judge eval (5.9) | the live judge on the 10 cases, once per prompt version | `audit_log` action `trends.eval` (hourly trends cron) | profile-v1.4: 10/10, 2026-10-22 |
| Price card (6.9) | every render body priced by the provider | `audit_log` action `higgsfield.prices` (daily, retried hourly) | complete, 2026-10-22 09:15 UTC |
| Freshness (R-9) | newest post and comment per platform under 48 h | each reconciliation report; the Performance header pills | **Facebook and X stale since 2026-10-16** (TRACKER_INGESTION F2) |

`npm run evals` reads the newest row of each monitor when the store credentials are present (`SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, e.g. after `vercel env pull`). In CI it prints "not read by this command — see
<table>", never a remembered value. The "Latest known" column above is this document's snapshot, not a live
reading.

The age of each monitor is the timestamp of its newest row. A monitor whose newest row is older than its
schedule is itself a failure (e.g. no reconciliation row for 2 days means the cron stopped).

## 3. Paid evals (on demand, cost first)

| Eval | What | Cost | How |
|---|---|---|---|
| `content_golden_set` (6.10) | the 20-piece golden set rated on the rubric (GOLDEN_SET.md) | ≈ $420 per run at 720p | **not authorised** — owner decision 2026-10-22: no Higgsfield spend for testing (no golden-set run, no eval or benchmark that renders, no "quick check" render); guarded in code |
| `f1x8_consistency` (9) | score spread when the same final is scored repeatedly; proposed 5 finals × 5 runs | F1X8 is not Higgsfield-billed — confirm the Modal cost of 25 analyses first | extend `scripts/f1x8-test.js` with a repeat flag; proposed threshold: spread ≤ 0.5 points per final |

## 4. Owner decisions
1. Agree or amend each proposed threshold.
2. Approve the paid runs and their budgets. Higgsfield-rendering evals are not authorised (2026-10-22); F1X8 consistency spends no Higgsfield money but still needs its cost confirmed.
3. The held-out themes sample (a signed-in export).

Once a threshold is agreed, it becomes blocking in CI.
