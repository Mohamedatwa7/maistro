# Maistro Roadmap — 5 Months

**Version:** 1.0-draft · **Date:** 2026-09-04
**Parent:** [../ARCHITECTURE.md](../ARCHITECTURE.md)
**Window:** Sept 2026 → Jan 2027, with February 2027 as explicit buffer.

Each month ends with a **quality gate** — a demonstrable, testable outcome.
A gate not met means the next month's scope shrinks; gates are not moved.
Accuracy deliverables (labeling, calibration, review) carry the same weight
as infrastructure deliverables — by design (ACCURACY.md §4).

---

## Month 1 — Foundations (Sept)

**Theme: contracts, plumbing, environments. Plus every long-lead-time item.**

- **W1**
  - File platform API applications: **TikTok Content Posting API, Meta Graph
    (IG/FB publishing), X API v2** — multi-week review lead times; nothing
    else may sit on this critical path. Track status weekly.
  - Repo scaffold per ARCHITECTURE §2.1; CI skeleton (typecheck, tests,
    secret scan); `SECRETS.md` inventory of all existing keys.
- **W2**
  - `packages/contracts/`: author the four adapter OpenAPI specs + shared
    JSON Schemas (CONTRACTS.md §1, §3); wire codegen (`make codegen`) with
    drift check in CI.
  - Staging environment: dedicated Supabase project, staging deploys of
    Maistro core; identify/create staging endpoints for the four tools.
- **W3**
  - Adapters for all four tools: typed clients, boundary validation, retry/
    timeout/circuit-break, recorded fixtures for offline dev.
  - Service-auth middleware added to each upstream tool for the consumed
    endpoints (per-service API keys; CF Access service token for TR).
  - **Finalize the Brief template with the content creator** (CONTRACTS
    §3.2) — a working session, not an email.
- **W4**
  - Contract-test suite green nightly against staging for all four tools.
  - Maistro DB migrations 001–003 (core tables, DATA-MODEL.md §2).
  - Observability baseline: structured logging, Sentry, LangSmith project.

**Gate M1:** CI is green; nightly contract tests pass against all four
staging tools; a script can — through typed adapters only — fetch trends,
generate a brief, submit an asset to F1X8, poll a score, and read sentiment
aggregates. Platform API applications submitted and tracked.

---

## Month 2 — Orchestration + creator interface (Oct)

**Theme: the graph, the interrupts, the MCP surface. Creator onboarded.**

- **W1–W2**
  - LangGraph engine: `CampaignState`, all nodes through `approval_gate`,
    PostgresSaver checkpointing, `transition()` state-machine enforcement,
    `effect_records` idempotency.
  - F1X8 polling node with timeout/resubmit/escalation path.
- **W2–W3**
  - MCP server: all six creator tools (CONTRACTS §2), scoped keys, audit
    logging. REST endpoints for the approval queue.
  - **Onboard the content creator** on staging: real briefs from real TR
    trends, real F1X8 scores, dry-run everything. Their friction reports are
    a first-class input — schedule two feedback sessions.
- **W4**
  - Chaos suite v1: kill-mid-node resume, double-submit, stale-submit,
    expired-interrupt, F1X8-timeout, checkpoint replay (`eval_graph_replay`).
  - Begin golden-dataset labeling for J1 sentiment (ACCURACY §1) —
    sampling + labeling guide this month, annotation runs through M3.

**Gate M2:** A campaign flows end-to-end on staging — trend → brief →
creator submits via MCP from their own machine → F1X8 score → revision loop →
approval — surviving a process kill at every interrupt point. Chaos suite in
nightly CI. Creator has completed ≥ 2 full dry-run campaigns.

---

## Month 3 — Accuracy infrastructure + shadow mode (Nov)

**Theme: make every judgment measurable; produce the first predicted-vs-actual data.**

- **W1–W2**
  - `sentiment-gulf-v1` labeled, adjudicated, κ reported; `eval_sentiment`
    harness gating in CI. **Decision point:** does gpt-4o-mini meet the
    J1 target? If not, execute the upgrade path inside SamsungSentiment and
    re-run.
  - `eval_prompt_regression` + prompt versioning live for all Maistro
    prompts; `eval_brief_quality` dataset started.
- **W2–W4**
  - **Shadow mode: 3–5 real campaigns.** Full pipeline runs; publishing is
    manual (a human posts the approved asset; the operator records the
    post URL into Maistro, which then monitors it normally).
  - Monitoring stage live: daily `campaign_metrics` snapshots from
    SamsungSentiment + platform data; `write_learnings` producing rows.
  - Weekly learnings review ritual starts (candidate → confirmed insights).
  - Publisher module built against platform **sandboxes/dry-run** while app
    approvals land; OAuth token storage + refresh implemented.

**Gate M3:** J1 eval gating in CI with target met (or upgrade executed and
met). ≥ 3 shadow campaigns published (manually) and monitored automatically;
first `learnings` rows exist; `score_threshold` formally calibrated from
shadow data (even if provisional); brief-generation consumes ≥ 1 confirmed
learning.

---

## Month 4 — Live publishing + closed loop (Dec)

**Theme: remove every manual data movement. The loop closes.**

- **W1–W2**
  - Platform drivers live (as approvals permit — TikTok first; Meta/X as
    granted). Idempotency verified with a deliberate double-resume test
    against a sandbox account, then a low-stakes real account.
  - `publish` + `schedule_monitoring` nodes live; dry-run mode remains the
    staging default forever.
- **W2–W4**
  - **≥ 5 fully live campaigns**: trend → … → approval → automated publish →
    automated monitoring → learnings. Zero manual data movement.
  - J2 calibration report v1 (Spearman, threshold precision, CIs) from
    accumulated shadow + live data; adjust threshold per ACCURACY §J2.
  - J3/J4 metrics reporting live (trend persistence, brief-fit rubric in the
    approval flow).
  - Runbook drafts begin (publish failure, stuck campaign, token expiry,
    upstream outage, checkpoint migration).

**Gate M4:** ≥ 5 campaigns fully automated end-to-end with zero manual data
movement; double-publish structurally impossible (test evidence); J1–J4 all
reporting numbers; monitoring runs unattended for 14 days on real posts.
*(If a platform's app approval is still pending, the gate holds with that
platform on the manual fallback — flagged, not silently absorbed.)*

---

## Month 5 — Dashboard, hardening, operability (Jan)

**Theme: no new capabilities. Make what exists excellent and operable.**

- **W1–W2**
  - Maistro dashboard (Next.js): campaign pipeline view, approval queue with
    brief-fit rubric, accuracy metrics (J1–J4), audit timeline per campaign,
    manual controls. Existing tool dashboards linked, not rebuilt.
- **W2–W3**
  - Hardening: load test (20 concurrent campaigns), failure-injection pass
    on every external dependency, security review (authz on every route/MCP
    tool, token encryption, RLS audit, secret rotation drill).
  - Runbooks completed + tested by executing each once. Alerting wired
    (stuck campaigns, contract-test failures, eval regressions, spend).
- **W4**
  - Docs freeze: ADRs current, onboarding doc (new operator can run a
    campaign from docs alone), contract specs vs. reality audit.
  - **Full-cycle acceptance test:** one campaign run by the operator using
    only the dashboard + runbooks, observed end-to-end.

**Gate M5 (project gate):** acceptance test passes; all J-metrics green or
formally accepted with rationale; chaos + contract + eval suites green for
14 consecutive days; runbooks tested; February untouched.

---

## Standing cadence (all months)

- **Weekly:** platform-approval status check (M1–M3); learnings review
  (M3+); triage of nightly contract/eval failures — same-week fix or
  formally logged exception.
- **Monthly:** gate review — met / not met / descope decision, written down.
- **Always:** February is buffer, not a plan extension. Scope flexes;
  the quality bar and the gates do not.
