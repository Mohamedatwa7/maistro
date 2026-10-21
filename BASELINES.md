# Baselines (Phase 3) — measured 2026-10-21 against production (www.ma1stro.com)

Method: `curl` from the development machine (UAE), 3 samples per cached endpoint after a warm-up, single sample for cold paths with a cache-busting query. Phase 7 re-measures against these numbers; a change is only an improvement if it moves these.

## Page and API latency

| Target | TTFB | Total | Payload | Notes |
|---|---|---|---|---|
| `GET /` (index.html) | 0.21 s | 0.26 s | 275,613 B | single file, uncompressed size on disk; plus `assets/landing-smoke.png` 538,150 B on the landing route |
| `GET /api/trends` (edge HIT) | 0.14 s | 0.14 s | 26,667 B | `s-maxage=900` |
| `GET /api/trends` (cold: kymah scrape + Claude curation) | — | **28.6 s** | — | paid every cache miss / deploy |
| `GET /api/sentiment` | 2.27 s | 3.37 s | 1,676,222 B | `no-store`; grows with every snapshot (AUDIT A-07) |
| `GET /api/projects` | 1.03 s | 1.03 s | 25 B | empty table; `no-store` |
| `GET /api/track?days=14` (edge HIT) | 0.14 s | 0.17 s | 115,143 B | `s-maxage=600` |
| `GET /api/track?days=14` (cold) | — | 1.6 s | — | 2026-10-21 10:40 UTC; 1.4–3.8 s observed across the day |
| `GET /api/track?days=60` (edge HIT) | 0.15 s | 0.31 s | 1,590,354 B | |
| `GET /api/track?days=60` (cold) | — | 51–80 s | — | measured 2026-10-20/21; one 502 (statement timeout) observed in the Vercel log on 2026-10-20 |

## Generation and QC durations (as implemented; from code constants and the 2026-10-20/21 runs)

| Step | Duration | Source |
|---|---|---|
| Hermes stage call (`/api/hermes`, one Opus call) | 10–40 s | `API.md`; client abort at 120 s |
| Director prompt (`/api/director`) | 10–30 s | same model/thinking; not pinned |
| Higgsfield Soul image | ~1 min typical | client copy "Images usually land within a minute"; polled every 8 s, cap 8 min |
| Higgsfield Seedance video (5–10 s clip) | 1–3 min | client copy; polled every 8 s, cap 8 min |
| F1X8 image analysis | minutes; 10–20+ min on cold start | `qcPoll` 10 s × 180 (30 min cap); adapter policy note in memory |
| F1X8 video analysis | 10–30 min | same |
| Full Hermes dispatch (7 sequential Opus calls) | ~2–5 min | 7 × 10–40 s |

These are not yet instrumented; M3 adds per-job `started_at`/`finished_at` so Phase 7 measures real distributions.

## Cost per content piece (call counts — pricing to be instrumented, not estimated)

| Path | Calls |
|---|---|
| Trend feed cold refresh | 1 Opus call (curation, `max_tokens` 3000) per cache miss |
| Hermes dispatch | 7 Opus calls (`max_tokens` 8000 each); no media |
| Studio piece, full pipeline | 5 director Opus calls (mood, thumb, board, draft, final) + 2 Hermes Opus calls (brief, qc text) + 3 Soul images + 2 Seedance videos + 5 F1X8 analyses (3 image, 2 video) |
| Regeneration | +1 Opus + 1 Higgsfield job per regenerate |
| Daily operations | 1 tracker cron read (60-day, 300 s function) |

## Test suite

| Suite | Count | Runtime |
|---|---|---|
| `node --test "tests/**/*.test.js"` | 34 tests (API characterization 15, page golden/characterization 18, smoke wrapper 1 incl. 67 checks) | ~5 s (two track tests wait on the endpoint's 500 ms retry backoff) |
