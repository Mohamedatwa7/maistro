# PERFORMANCE_INSIGHTS — Phase 7 (benchmarks and the decisions the Performance page supports)

Status 2026-10-22: §2 (benchmarks, 7.2) is implemented as `GET /api/track?benchmarks=1` (`api/_perf/benchmarks.js`,
tests in `tests/perf/benchmarks.test.js`). The page panel, §1 (decisions, 7.1) and §3–§6 (7.3–7.6) follow.
Every number here is computed in code from the tracker's rows and Maistro's daily snapshots, never by a model.

## 2. Benchmarks (7.2) — definitions, settled with the checker on 2026-10-22

| # | Rule | Why |
|---|---|---|
| D1 | **Metric per cell.** Engagements = likes + comments + shares; **Instagram = likes + comments** (shares are never collected: null on 200 of 200 posts). ER = engagements / views where views are collected **and ≥ 500** (TikTok, X, IG video). **Facebook and IG images/carousels are ranked on engagements**, labelled; ER is "not computable" there. No views = 0, and no follower-based ER (the tracker holds no follower counts). | ER on a few hundred views is noise; comparing unlike quantities misleads |
| D1a | Shares are read from the tracker's raw share count (`metrics.sharesRaw`, 0 included); the reader's `shares` maps 0 to null. Where only `shares` exists (snapshots stored before 2026-10-22), a missing share counts as 0 and the cell reports how many (`sharesAssumedZero`). | a real 0 is not an assumption |
| D2 | **Nearest-rank P25 / median / P75 / P90**; no means anywhere. | a few viral posts dominate a mean |
| D3 | A cell shows percentiles only at **n ≥ 20**; below that, the count only. | |
| D4 | **Cells**: platform × format (IG video vs image/carousel; X video vs text; TikTok and Facebook one format each) × age band × organic/giveaway. | IG mixes Reels and images (149 video and 51 image or carousel of 200 in 90 days) |
| D5 | **Giveaways** never pooled with organic posts, and counts only (4–10 per platform: they never reach 20). Classified by a word-bounded caption pattern in English and Arabic ("win" but not window / winter / twin / Galaxy Win; "سحب" only as "السحب" / "سحب على"), with a tested false-positive list. A second signal — at least 20 comments collected, ≥ 50 % of them short (≤ 60 chars) and voices / collected ≤ 0.6 — marks a post **"suspected giveaway — confirm"**; it stays in the organic cell until a person confirms. | in 60 days, giveaways carried 11,161 of 12,258 Instagram comments and 8,700 of 8,811 on X |
| D6 | **Age** = observation time − published_at; bands 0–1 d, 1–3 d, 3–7 d, ≥ 7 d (mature). A post is compared only with posts observed in the same band. Mature cells use current metrics; young cells use the daily snapshots (one observation per post per band, the latest). | |
| D7 | **Timing.** Boosting pays in the first 24–72 h, but young bands exist only since the snapshots began (2026-10-20 06:30 UTC). Until a young band reaches n ≥ 20 the page says "benchmarks for posts under 7 days not yet available — n = k" with the date it is expected to (from the platform's posting rate since snapshots began). For a platform whose newest data is older than 48 h it says "no recent data — tracker last collected <date>" and gives no date. **Mature standings are labelled "benchmark among mature posts — not boost advice".** | a recommendation after the boost window is not one |
| D8 | **Window**: the last 90 days, rolling (the reader's maximum); every figure carries its window and as-of time. | |
| D9 | **Population**: the live read is post-fix (owned accounts only, R-8). Snapshot rows are re-filtered to owned accounts and non-ifold/unpacked/roster ids on read, so rows stored before the 2026-10-22 population fix drop out; stored aggregates are never reused. | the TikTok figures before the fix were ~6× too high |
| D10 | **Standing**: a post's percentile within its own cell, shown as e.g. "ER 1.6 % — P80 of 20 mature TikTok organic posts (90 d)"; "above P75" is the quantitative half of "Recommended to boost" only once young bands are populated. | |

Not yet: a line manager / admin flag to confirm or clear a giveaway (needs a stored flag); young-band history
fills daily from the 06:30 snapshot.
