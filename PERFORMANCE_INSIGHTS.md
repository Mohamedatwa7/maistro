# PERFORMANCE_INSIGHTS — Phase 7 (benchmarks and the decisions the Performance page supports)

Status 2026-10-22: §1 (decisions, 7.1), §2 (benchmarks, 7.2) and §3 (sentiment quality, 7.3) are done; §2 is `GET /api/track?benchmarks=1` (`api/_perf/benchmarks.js`,
tests in `tests/perf/benchmarks.test.js`). The page panel, §1 (decisions, 7.1) and §3–§6 (7.3–7.6) follow.
Every number here is computed in code from the tracker's rows and Maistro's daily snapshots, never by a model.

## 1. The decisions the page supports (7.1) — builder default, owner to amend

A strip at the top of Performance names each decision, its state and its evidence.

| Decision | Supported by | Missing / caveat |
|---|---|---|
| D-a **Respond** — which comments need a reply now | flagged comments (critical alerts) with a **handled** mark: append-only rows in `audit_log` (`comment.handled` / `comment.unhandled`, who, when, note). The key is post + author + message (the twin-collapse message key), so twins and re-collected duplicates share it. | **ASSUMPTION — owner to confirm:** there is no "responder" role, so **reviewers** (plus line managers and admins) mark comments handled; a dedicated role needs a migration and an ADR-003 amendment. Under the interim password session the mark records "password session (no member sign-in)", not a person. |
| D-b **Boost** — which young post to put money behind | — | **Not yet supportable.** Benchmarks for posts under 7 days need n ≥ 20 per band; the strip and panel give the expected dates. |
| D-c **Format & platform mix** | mature benchmark cells (§2) | A benchmark for the next plan, not a boost signal; the call is the owner's. |
| D-d **Product sentiment** | comments by device | **Mapped from caption text**: a comment counts for the device its post's caption names. The share of comments on posts naming no device is shown, and each device shows its analysed n, so a device with few mapped comments is not read as low praise. |
| D-e **Trust the numbers** | per-platform data-as-of pills; "no recent data" | Facebook and X stale since 2026-10-16 (tracker collection). |

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

**Giveaway classifier, hand-read on the live 90-day captions (2026-10-22, 732 posts).** The first word-bounded
pattern flagged 60. Read by hand, 3 were not giveaways (an event recap mentioning "games, giveaways & plenty of
fun", and a sponsored bouldering competition posted twice) and 2 giveaways were missed ("لربح جهاز Galaxy",
"you might walk away with an exciting prize"). The pattern now needs prize-entry wording (a giveaway, a raffle, an
entry instruction, a chance to win). It flags 59, and a scan of every unflagged caption containing a prize-adjacent
word (win / winning / prize / reward / raffle / ربح / سحب …) found no giveaway left. These captions are in the
test's true and false lists. The classification was read by Claude, so the owner may re-read it.

**Live read with the corrected pattern (2026-10-22 10:09 UTC, 90 days, 3,373 owned snapshot rows).** Mature organic cells with
percentiles:

| Platform · format | Metric | n | P25 | Median | P75 | P90 | Left out (views < 500) |
|---|---|---|---|---|---|---|---|
| TikTok | ER | 114 | 5.36 % | 6.91 % | 8.17 % | 9.84 % | 42 |
| Instagram video | ER | 83 | 2.50 % | 4.19 % | 10.0 % | 15.2 % | 50 |
| X video | ER | 53 | 0.87 % | 1.08 % | 1.38 % | 1.74 % | 55 |
| Instagram image / carousel | engagements | 37 | 64 | 98 | 204 | 291 | — |
| Facebook | engagements | 177 | 27 | 66 | 165 | 305 | — |

X text (3 posts) and every giveaway cell show counts only. No young band has reached n ≥ 20 yet: the largest is
Instagram video at 3–7 d, with n = 15. Facebook and X have been stale since 2026-10-16 (tracker collection), so
their young posts show "no recent data" and no expected date.

Not yet: a line manager / admin flag to confirm or clear a giveaway (needs a stored flag); young-band history
fills daily from the 06:30 snapshot.

## 3. Sentiment quality (7.3) — audit of 2026-10-22

**Method.** I took the live 60-day read at 10:45 UTC: 6,067 comments after the twin collapse. Each comment was
bucketed by language after removing @mentions, #hashtags and links: emoji-only, Arabic script, mixed Arabic and
Latin, Arabizi (Latin with 2/3/5/7 letter-digits or a Gulf word list), and English (other Latin). Each was also
classed by whose label it carried: the **tracker's model**, or **Maistro's keyword fallback** where the tracker
had none. I drew a seeded sample of 20 comments per bucket × source (200 in all). Claude labelled them **blind**:
the stored labels were hidden while labelling and joined afterwards. The labelling rule is written into the
fixture (`tests/fixtures/sentiment-audit-2026-10-22.json`; authors tokenised, no ids, names in text redacted).
Every figure below is recomputed by `tests/perf/sentiment-audit.test.js`. 645 comments with no letters and no
emoji (hashtags or numbers only, once mentions are removed) are outside the buckets.

| Bucket | Tracker | Keyword fallback |
|---|---|---|
| English | 18/20 · 90 % (70–97 %) | 14/20 · 70 % (48–86 %) |
| Emoji only | 19/20 · 95 % (76–99 %) | **1/20 · 5 % (1–24 %)** |
| Arabizi | 17/20 · 85 % (64–95 %) | 7/20 · 35 % (18–57 %) |
| Mixed Arabic + Latin | 17/20 · 85 % (64–95 %) | 11/20 · 55 % (34–74 %) |
| Arabic | **13/20 · 65 % (43–82 %)** | 10/20 · 50 % (30–70 %) |
| **All sampled** | 84/100 · 84 % (76–90 %); **90 %** weighted by the population | **43/100 · 43 % (34–53 %)**; 64 % weighted |

Wilson 95 % intervals in brackets. The population-weighted figure weights each bucket by its share of the real
60-day comments: tracker-labelled 1,801, fallback-labelled 3,621.

- **Tracker, per class:** positive recall 96 % / precision 81 %; neutral recall **62 %** / precision 88 %;
  negative 93 % / 93 %. Its main error is calling neutral comments positive (12 of 34): giveaway entries and bare
  product names. Arabic is its weakest bucket. Sarcasm: 5 comments flagged, 4 of them the same Arabic
  customer-service complaint ("تخيلو الروعه"); the tracker read all 5 by intent.
- **Keyword fallback:** it called 53 of 64 positive comments neutral, scored 19 of 20 emoji-only comments wrong,
  and found neither negative comment. **It carried 64 % of the comments in the 60-day view.** Since 2026-10-22
  it is no longer used. A comment the tracker has not analysed is shown as **"not analysed"** and left out of
  every sentiment rate; the pill reads "N analysed · M comments".
- **Why the tracker leaves comments unlabelled** (read-only look at SamsungSentiment `lib/apify-sync.ts`
  `analyzeUnanalyzedComments`): the daily sync labels at most 500 comments, newest first, from the **last 30
  days only**. Coverage in the live read is 96 % for comments under 7 days old, 81 % at 7–14 days, 51 % at
  14–30 days and 30 % beyond 30 days. The older backlog is described in the code as "a one-off backfill, not the
  daily sync's job", and it has not been run.
- **Model labels — needs a native-speaker check:** the Arabic, Gulf-dialect, Arabizi, mixed-language and sarcasm
  calls are the least trustworthy part of this audit, and they are on the owner gate.

**Fix plan for SamsungSentiment (proposal only; that repo is not changed without approval):**
1. Run the existing resumable backfill (`POST /api/analyze-sentiment/run`, in batches until `remaining` = 0)
   for Samsung Gulf comments older than 30 days. This is a paid LLM run over about 4,000 comments; the cost
   should be estimated first.
2. Exclude the other corpora (ifold_ / unpacked_ / roster_) from the brand sync's 500-comment cap, or give them
   their own cap, so brand comments are not crowded out.
3. Tell the model that a giveaway entry or a bare product name is neutral, and re-measure against this fixture.
4. Add Arabic and Gulf-dialect examples to the prompt, then have a native speaker re-label the Arabic bucket
   before re-measuring.
5. The tracker's own dashboard uses the same keyword list Maistro dropped, so the same "not analysed"
   treatment applies there.
