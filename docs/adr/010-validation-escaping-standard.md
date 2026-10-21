# ADR-010 — Boundary validation and output encoding standard

Status: accepted 2026-10-21

## Context
Inputs are trusted (ingest artifacts, model JSON) and outputs are interpolated into HTML with a two-character escaper (AUDIT D-02, C-05, C-12).

## Decision
zod schemas for every request body, query, cron payload, provider response and prompt output; rejections are 4xx with a structured error `{code, message, details}`; React rendering only (no `dangerouslySetInnerHTML`) except a sanitizer for model prose; `Idempotency-Key` on every write that can be retried; `timingSafeEqual` for every shared secret; CORS limited to the app origin; request size limits per route.

## Consequences
`src/domain/schemas` becomes the single description of every shape, from which `API.md` is generated.
