# ADR-007 — Keep "Dispatch to Hermes" as a first-class auto-pilot path; remove the simulated QC

Status: accepted 2026-10-21 (owner decision: keep the dispatch)

## Context
The dispatch chain (seven sequential Claude calls) and the Studio coexist with different QC: the chain's QC is Claude-simulated with an invented human reviewer (AUDIT B-02). The owner wants the dispatch kept.

## Options
1. **Keep dispatch, re-base it on the job model, real F1X8 QC, real Higgsfield draft** — one pipeline, one QC, every piece reviewable.
2. Keep dispatch as-is (text-only artifacts, simulated QC with an invented reviewer) — cheapest, but presents fabricated scores and sign-offs next to real ones (B-02, B-03).
3. Retire dispatch; Studio only — simplest code; the owner wants the one-click path kept.

## Decision
Option 1. Dispatch becomes origin `hermes_dispatch` on the same content-piece and stage model: one `hermes_stage` job per stage in order (plan → mood → thumb → brief → board), each producing a version like any other path; its `draft` is rendered by Higgsfield from the generated plan so every piece has a real asset; QC is the real F1X8 on that draft; the `final` is the fix-implementing re-render verified by a second F1X8 run (AUDIT B-03). The simulated QC artifact and the fabricated reviewer are removed. The prompts stay, versioned under `prompts/hermes/`.

## Consequences
A dispatch costs about 5 Opus calls plus one Seedance render and one or two F1X8 runs instead of 7 Opus calls; it is slower end to end but produces a real, reviewable piece.
