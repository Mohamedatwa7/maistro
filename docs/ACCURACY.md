# Maistro Accuracy Framework

**Version:** 1.0-draft · **Date:** 2026-09-04
**Parent:** [../ARCHITECTURE.md](../ARCHITECTURE.md)

"Highest accuracy" is a measurable engineering goal here, not a slogan. This
document defines what accuracy means at each judgment point, how it is
measured, the initial targets, and the harnesses that gate changes.

Guiding principle (adopted platform-wide from Trend Radar): **measurement
first** — LLMs describe and act on what measurement has surfaced; they do not
silently become the measurement. Every LLM touchpoint is eval-gated (ADR D10).

---

## 1. The four judgment points

### J1 — Sentiment classification (SamsungSentiment, currently gpt-4o-mini)

*Why it matters:* post-publish success/failure reads, and half of the
learnings loop's "actual" signal.
*Known risk:* gpt-4o-mini on Gulf-region comment text — dialectal Arabic,
Arabizi (Arabic in Latin script), Arabic/English code-switching — is
unverified. This is the platform's most likely weak link.

- **Golden dataset** `datasets/sentiment-gulf-v1/`: ~1,000 real comments
  sampled from the existing Supabase corpus, stratified by platform ×
  language (Arabic script / Arabizi / English / mixed) × product context.
  Double-labeled (two annotators; adjudicate disagreements; report
  inter-annotator agreement — if humans agree < 0.8 Cohen's κ, the label
  taxonomy is refined before blaming the model).
- **Metric:** macro-F1 across positive/neutral/negative; per-language-slice
  F1 reported separately (an aggregate can hide an Arabic-slice failure).
- **Initial target:** macro-F1 ≥ 0.85 overall, ≥ 0.80 on every language
  slice. If gpt-4o-mini misses, the upgrade path (better model, or
  Arabic-tuned prompt with few-shot dialect examples) is isolated inside
  SamsungSentiment's analyze route and re-evaluated against the same set.

### J2 — Engagement prediction (F1X8)

*Why it matters:* the revise loop and the score threshold rest entirely on
this number meaning something.
*Existing basis:* F1X8's ranker reports holdout AUC 0.851 on its benchmark
cohorts (12k+ online ads, 15k e-paper). That validates *relative ranking on
its corpus* — not calibration to **our** content on **our** channels.

- **Measurement:** for every published campaign, record F1X8's final
  pre-publish score and the realized engagement percentile (vs. our own
  campaign history + channel baseline) → `learnings` table. This is the
  predicted-vs-actual series.
- **Metrics:** Spearman correlation (does higher score → better outcome?);
  threshold precision (of campaigns that scored ≥ threshold, what fraction
  landed above-median?).
- **Initial targets (to calibrate, not to assume):** Spearman ρ ≥ 0.5 by
  end of M4 (n will be small — report confidence intervals, don't
  over-read); threshold precision ≥ 0.7.
- **Calibration actions:** M3 shadow campaigns produce the first data; the
  `score_threshold` default (7.0) is a placeholder until then and is
  formally set at the M3 gate. If correlation is weak, the response is
  investigative (which KPI components correlate? does funnel-stage
  classification match our intent?) — F1X8's per-KPI methodology fields
  exist precisely to support this.

### J3 — Trend selection quality (Trend Radar + Maistro's pick logic)

*Why it matters:* a perfectly executed piece on a dead trend still fails.

- **Metric 1 — persistence:** of trends Maistro selected, % still
  `rising`/`peaking` in TR's own lifecycle data 7 days after selection.
  Target: ≥ 60%.
- **Metric 2 — outcome attribution:** median engagement of trend-led
  campaigns vs. channel baseline. Reported from M4; no target until n ≥ 10.
- TR's internal detection integrity is its own project's concern; Maistro
  measures only its *selection* on top of TR's feed.

### J4 — Brief → content fit (new in Maistro)

*Why it matters:* diagnoses *where* a failure happened. A low-performing
piece with high brief-fit indicts the brief/trend; low brief-fit indicts the
handoff. Without this, the learnings loop can't assign cause.

- **Method:** structured rubric (hook present? format followed? do's/don'ts
  respected? angle preserved?) scored at approval time — approver checks 4–6
  boxes in the approval UI; optionally an LLM pre-fills, human confirms.
- **Metric:** rubric score per campaign, correlated against outcomes from M4.
- Also serves as feedback on brief *quality*: consistently unmet fields mean
  the brief template (CONTRACTS §3.2) needs work with the creator.

---

## 2. The learnings loop (the accuracy engine)

```
F1X8 predicted score ──┐
                       ├─► learnings row (predicted vs actual, delta, insight)
actual metrics ────────┘          │
(SamsungSentiment +               │  human review (M3–M4: weekly, 15 min)
 platform APIs)                   ▼
                        candidate → confirmed insights
                                  │
                                  ▼
                 injected into generate_brief (learnings_context)
                 + threshold recalibration + J1–J4 metric updates
```

Rules:

- Insights are **candidate** until human-confirmed (M3–M4 weekly review);
  only **confirmed** insights are injected into briefs. Retire insights that
  stop holding (`insight_status = retired`).
- Injection is bounded: top-K (K=5) most recent confirmed insights, so briefs
  don't accrete an ever-growing prompt.
- Every quantity in this loop is queryable from the `learnings` +
  `campaign_metrics` tables; the M5 dashboard exposes J1–J4 as first-class
  metrics.

---

## 3. Eval harnesses & CI gating

Located in `services/core/evals/`. All runnable locally and in CI.

| Harness | Dataset | Runs | Gates |
|---|---|---|---|
| `eval_sentiment` | sentiment-gulf-v1 | Nightly + on any change to SamsungSentiment's analyze prompt/model | Fails if macro-F1 drops > 0.02 vs. last accepted baseline |
| `eval_brief_quality` | briefs-golden-v1 (~30 hand-rated briefs, built M2–M3) | On any change to brief prompt or learnings-injection logic | LLM-judge rubric score, human-anchored; fails on regression > 5% |
| `eval_score_calibration` | learnings table (live) | Weekly report (not a CI gate — it's an outcome measure) | Alerts if Spearman ρ trend declines 2 weeks running |
| `eval_graph_replay` | Recorded campaign fixtures | Per PR touching graph/state | Replays in-flight checkpoints against new code; fails on resume error |
| `eval_prompt_regression` | Per-prompt fixture sets | Per PR touching any versioned prompt | Golden-output comparison with LLM-judge tolerance |

Prompt governance:

- Every prompt lives in `services/core/prompts/` with a semver header and
  changelog; runtime loads by version.
- A prompt/model change PR must include its eval run output. No eval, no
  merge.
- LangSmith traces record prompt version + node + inputs for every
  production call, so any bad output is attributable in one lookup.

---

## 4. Dataset governance

- Datasets are versioned directories (`datasets/<name>-v<N>/`) with a
  `MANIFEST.json` (source, sampling method, annotator ids, κ score, date).
  Never edited in place — corrections create v(N+1).
- Labeling guides live beside the data; disagreement adjudication is logged.
- PII: comments are already public-platform data, but datasets strip
  usernames/handles before commit; raw ids stay in the source DB only.
- **Effort warning (named risk in ARCHITECTURE §8):** labeling and weekly
  learnings review are scheduled, named deliverables in the roadmap with the
  same weight as infrastructure gates — this is the work "no shortcuts"
  actually refers to. Gold-plating infra while J1's dataset sits unlabeled is
  the failure mode to guard against.
