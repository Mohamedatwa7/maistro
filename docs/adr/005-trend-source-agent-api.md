# ADR-005 — Trend source: Trend Radar's agent API, cached, read-only

Status: accepted 2026-10-21

## Context
Maistro scrapes kymah.com's page payload; a one-trend board this week blanked the product with no message (AUDIT C-01). Trend Radar exposes `GET /api/agent/trends` (bearer `AGENT_API_KEY`): fit-ranked, with the editorial brief and scored products, documented for exactly this consumer.

## Decision
`KymahSource` calls the agent API; an hourly cron stores the normalised feed in `trends_cache` with `fetched_at`; `/api/trends` serves the cache plus a `stale` flag; the UI shows the age and a stale banner. Collection is never triggered (the API is read-only; `POST /api/agent/brief` is not used because it bills a model call). The page-scrape parser stays behind a flag as a documented fallback.

## Consequences
`AGENT_API_KEY` is needed in Maistro's environment (from the Trend Radar project). Thin boards are shown honestly ("3 trends on the board today") instead of as empty pages.
