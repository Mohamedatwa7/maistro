# ADR-010 — Boundary validation and output encoding standard

Status: accepted 2026-10-21

## Context
Inputs are trusted (ingest artifacts, model JSON) and outputs are interpolated into HTML with a two-character escaper (AUDIT D-02, C-05, C-12).

## Options
1. **zod at every boundary + React escaping + sanitizer for model prose** — one schema source, generated docs, XSS removed by construction.
2. Hand-written checks per route plus a fixed `esc()` helper — fast to add to the legacy file (done in M1 as an interim), but drifts and still relies on remembering to escape.
3. A full API framework (tRPC/OpenAPI codegen) — more machinery than a dozen routes justify today; zod schemas can feed OpenAPI later.

## Decision
Option 1. zod schemas for every request body, query, cron payload, provider response and prompt output; rejections are 4xx with a structured error `{code, message, details}`; React rendering only (no `dangerouslySetInnerHTML`) except a sanitizer for model prose; `Idempotency-Key` on every write that can be retried; `timingSafeEqual` for every shared secret; CORS limited to the app origin; request size limits per route.

## Consequences
`src/domain/schemas` becomes the single description of every shape, from which `API.md` is generated.
