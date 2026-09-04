# Maistro

Unified content-automation platform orchestrating the full content lifecycle
— trend selection → brief → human creation → scoring → revision → approval →
publishing → measurement → learnings — on top of four existing production
tools: **Trend Radar**, **F1X8**, **SamsungSentiment**, and **Lenceus**.

**Status (2026-09-04):** Architecture spec drafted. `packages/contracts/`
written and validated (4 OpenAPI adapter specs with shapes extracted from
the real codebases + 8 JSON Schemas). **Service scaffold running** —
`services/core` (FastAPI + typed adapters for all four tools + campaign
state machine), codegen pipeline with CI drift check, `db/migrations/001`,
live contract-test suite + nightly drift workflow. Repo:
[Mohamedatwa7/maistro](https://github.com/Mohamedatwa7/maistro) (private) —
CI green (contracts + core + secret scan). The `staging` GitHub environment
exists but needs its vars/secrets filled (see SECRETS.md) before the nightly
contract tests do anything. Next: platform API applications (M1-W1),
service-auth middleware on Sentiment/Lenceus + staging deploys (M1-W3).

## Read this first

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Master spec — system context, architecture, key decisions (ADRs), component design, security, engineering standards, risks |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | All contracts: the four tool adapters, MCP creator tools, shared data schemas, LangGraph state rules, publishing |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Campaign state machine, Postgres DDL, LangGraph state object |
| [docs/ACCURACY.md](docs/ACCURACY.md) | The four judgment points (J1–J4), golden datasets, eval harnesses, targets, the learnings loop |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 5-month plan (Sept 2026 → Jan 2027) with monthly quality gates |

## Core architectural stance

1. **Orchestration layer, not a merge** — the four tools stay independent;
   Maistro integrates via their HTTP APIs only.
2. **LangGraph (Python)** with Postgres checkpointing drives the campaign
   graph; `interrupt()` handles the human-in-the-loop pauses (creator,
   approver).
3. **The content creator works through MCP** — briefs pulled, drafts
   submitted, feedback received via Maistro's MCP server from any MCP client.
4. **Contract-first** — every boundary has an OpenAPI/JSON-Schema contract;
   typed clients are generated; contract tests run nightly in CI.
5. **Accuracy is measured, not assumed** — every LLM judgment point is
   eval-gated against golden datasets; predicted-vs-actual per campaign
   drives calibration and future briefs.
6. **Permanent human approval gate** before any publish; idempotency-keyed
   publishing makes double-posting structurally impossible.

## Contracts

`packages/contracts/` is the source of truth for every boundary — see its
[README](packages/contracts/README.md). All upstream shapes were verified
against the four codebases on 2026-09-04; notable verified facts: Trend
Radar trends already embed an editorial brief with per-product adaptations
(Maistro composes the creator Brief from it); F1X8's `verdict` carries a
structured `revision_brief` + ranked risks with `score_lever` weights;
F1X8 image analysis is synchronous, video is submit/poll; SamsungSentiment
and Lenceus currently have **no API auth** (M1-W3 deliverable to add it).

## Next step

Roadmap M1-W1: file the platform API applications (TikTok/Meta/X — long lead
times), then the monorepo service scaffold with codegen + CI (M1-W2).
