# PERFORMANCE_INSIGHTS — Phase 7 (benchmarks and the decisions the Performance page supports)

Status 2026-10-22: every section's code is built and tested.
- §1 decisions (7.1), §2 benchmarks (7.2), §3 sentiment quality (7.3) and §4 comment insight (7.4) run on
  live data.
- §5 attribution (7.5) and §6 closing the loop (7.6) wait on migration 018 and on posts being linked: 0 of 30
  attributed today.

Every number here is computed in code from the tracker's rows and Maistro's daily snapshots, never by a model.
Each live figure carries the date it was measured.

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

## 4. Comment insight (7.4) — themes counted in code (themes-v3-2026-10-22)

`GET /api/track?themes=1&days=N` (signed-in only, never cached) and the **What people are saying** panel.
Themes are word-bounded English / Arabic / Arabizi patterns in `api/_perf/themes.js`; every count is computed in
code and no model estimates one. The rules settled with the checker:
- **Questions** are a flag on a theme; a question with no theme is "other question".
- **Purchase intent** needs a price or availability object ("how much I love it" and "كم حلو" are not purchase
  intent).
- **Product issues and complaints carry a product**: a device named in the comment wins, else the post's caption
  (labelled), else "product unknown". Complaints about an S23 arrive under Fold8 posts.
- **Brand replies are excluded.** The Facebook page replies as "Samsung", and those offers had made up most of the
  first pattern's price and availability hits.
- **Comments on giveaway posts are entries, not praise.** Complaints and issues on those posts still count.
- Product shares only at n ≥ 20. Examples (top 3 by likes and 3 seeded random) are shown on demand.

**Accuracy (measured, recomputed by `tests/perf/themes.test.js` from two anonymised fixtures).**
- **Product issues and complaints**: *every* distinct customer text that the patterns or a loose keyword net
  caught (244) was labelled. The first pass was blind on the first 150 characters; every disagreement was then
  re-read in full. That second pass is not blind, and both labels are kept in the fixture.
- **The other themes**: a seeded sample of 221 comments (brand replies removed), labelled blind.
- The v3 patterns fixed misses found in this same audit, so the v3 figures below are **optimistic**; the next
  window's audit confirms them.

| Theme | Precision | Recall | Basis |
|---|---|---|---|
| Product issues (all) | 37/37 · 1.00 | 37/38 · 0.97 | exhaustive |
| — screen / display lines | 1.00 | 0.97 | exhaustive |
| Complaints (all) | 63/66 · 0.95 | 63/66 · 0.95 | exhaustive |
| — customer service | **0.79 (low)** | 0.96 | exhaustive |
| — repair / warranty | 0.97 | 0.97 | exhaustive |
| — brand complaint / don't buy | 1.00 | 0.96 | exhaustive |
| Price / affordability | **0.64 (low)** | 0.78 | sample |
| Wants to buy | 1.00 | 0.83 | sample |
| Asks for a free device | 1.00 | 0.57 | sample |
| Design / colour | **0.69 (low)** | 0.72 | sample |
| Multitasking | 0.96 | 0.90 | sample |
| Ecosystem / combo | 0.89 | 0.73 | sample |

Before the fixes, v2 on the first-pass labels had complaints at 0.86 / 0.86 and product issues at 1.00 / 0.87.
v1 (the first pattern set) had price precision 0.31 and "wants to buy" 0.13, both driven by brand replies and
"don't buy" warnings. Recall is measured within the loose keyword net, so it is an upper bound. Themes under 0.8
precision show **LOW CONFIDENCE**; complaint or issue themes under 0.7 recall would show **may be undercounted**
(none today). Not covered yet: network and app problems, camera fog, appliances, feature requests (6, 3 and 3
in the audit), and Portuguese and Spanish complaints.

**Live, 60 days (2026-10-22 11:00 UTC).** 6,038 customer comments (29 brand replies left out): 4,556 giveaway
entries (75 %), 1,249 (21 %) with no theme. Brand complaints 82, repair / warranty 58, customer service 58,
screen / display 57, update-caused 11, battery 6, price 41, wants to buy 12, asks for a free device 26.

## 5. Attribution (7.5) — in progress

**Step 1 (done): linking a final to the post it became.** Sprinklr is not live, so no post id comes back
automatically. On an approved final, a line manager or admin pastes the published post's URL (**Published as**),
and the link is set up as follows:
- **Resolution:** the URL is resolved to the tracker's post the same way the reader resolves aliases (query
  strings, trailing slashes and `m.` hosts don't matter; Instagram shortcodes and ids both work).
- **Owned accounts only:** a post on a non-owned account is refused (R-8).
- **One active link per (piece, post):** a unique index in migration 018. An unlink keeps the row (who, when,
  why), and a relink adds a new one.
- **No guessing:** no caption guessing makes a link, and historic posts not made in Maistro stay unattributed.
- **Storage:** `piece_posts` (`db/migrations/018_piece_posts.sql`). **Until the migration is applied, every
  attribution call answers 503 "attribution storage not migrated"** and the page says so.

**Step 2 (done, waits on the migration for real data): the attribution record and analysis.**
`GET /api/track?attribution=1` (signed-in only, never cached) and the **Attribution** panel. Each active link
carries:
- **the trend**, with its score and confidence at decision time — the pick decision's score row, else the newest
  score made before the piece, labelled with which;
- **the piece:** angle, product, markets, creation path (Studio / Hermes);
- **quality checks:** F1X8 at QC (the newest result) and at final (with the score before the fixes);
- **process:** revision rounds per stage (versions − 1) and the stage history (each approval or rejection, with
  who, role, reason code and when);
- **performance:** the post's metrics and its 7.2 standing (band, format, percentile in its own cell, or "too
  young" / "not ranked" / "not in the 90-day read").

The analysis groups attributed posts by creation path, product, platform and format, trend confidence, revision
rounds (0 / 1–2 / 3+) and angle:
- Only mature organic standings are ranked.
- A group shows a median percentile only at **n ≥ 20 ranked**; counts otherwise.
- **No attribute is weighted until 30 posts are attributed**, shown as "N of 30" on the panel.

Today 0 posts are linked. Built and tested against the test fake: `tests/perf/attribution.test.js`, and the
route test in `tests/api/track-sentiment.test.js`.

## 6. Closing the loop (7.6) and the Phase 7 report

**The loop (built, gated).** `api/_perf/learnings.js` turns the 7.5 analysis into proposals for trend
calibration (5.7), content generation (6.10) and the boost recommendation (8a). They appear on the Attribution
panel and in `GET /api/track?attribution=1` (`learnings`). The gates are tested in `tests/perf/learnings.test.js`:
- **Withheld below 30 attributed posts.** Today the panel reads "withheld — 0 of 30".
- **A proposal needs:** a group with ≥ 20 ranked mature organic posts and ≥ 20 in the rest; a median gap of
  ≥ 15 percentile points (a fixed threshold, not a significance claim); and the same direction and size in
  **both halves of the window**, split at the median post date.
- **Every proposal is labelled a hypothesis**, with its n and the number of groups compared (with six
  attributes, some group clears a gap by chance).
- **Nothing is applied automatically.** The 5.7 judge prompt stays frozen behind its eval; a calibration change
  is a person's decision, made with this evidence beside it. 6.10 and 8a consume the same field.
- **No learning, calibration change or boost recommendation has been made from real data.** There are no
  attributed posts yet.

**Three decisions the page supports now that it could not before** (live figures, measured 2026-10-22):

| Decision | What the page shows now | Before the rebuild |
|---|---|---|
| **Respond**: which comments need a reply | 3 complaint themes and 5 product-issue themes, each located by product (named in the comment, else the post), with examples and a **handled** mark that survives duplicates. 60 days at 11:00 UTC: brand complaints 82, repair / warranty 58, customer service 58, screen / display 57 | a comment count; 64 % of the sentiment labels were keyword guesses (43 % accurate) |
| **What to make more of** (format and platform mix) | mature organic benchmarks per platform and format at 11:38 UTC (90 days): TikTok median ER 6.91 % (n = 114), Instagram video 4.19 % (n = 83), X video 1.08 % (n = 53), Instagram image median 98 engagements (n = 37), Facebook 66 (n = 177); giveaways counted apart | one mean "engagement" over every post, with giveaways (11,161 of 12,258 Instagram comments in 60 days) mixed in |
| **Trust the numbers** | per-platform data-as-of pills: Facebook and X stale since 2026-10-16 (tracker collection). **The 60-day sentiment rests on 33 % of comments** (measured 2026-10-22 10:45 UTC: 1,975 tracker-labelled of 6,067), and the page says so beside the rates | no staleness warning; the keyword fallback silently filled the gap |

**Waiting on attribution:** what to boost (young-post benchmarks also need n ≥ 20 per band; the page gives the
dates), what to stop by product and market, which trends and formats work for which products and markets, and
every learning above.

**Data reconciliation (7.0).** The 2026-10-22 runs reconcile the reader against the tracker DB itself:
- Posts per platform match (R-1), raw comments in the window match (R-3, 12,375 = 12,375 at 09:24 UTC), the
  canonical-id matches bound the alias matches (R-4), posts are unique (R-6), and every counted post is from an
  owned account (R-8; 0 foreign after the population fix that had overstated TikTok reach about 6×).
- The twin-collapse audit: 0 false merges and 23 of 36 missed duplicates under the old rule, 0 and 0 under the
  message key (on the labelled sample).
- Widening from 14 to 60 days merges and never replaces: 0 metric differences and 0 lost comments live.

**Sentiment accuracy (7.3).**
- Tracker labels: 84 / 100 (76–90 %), 90 % weighted by the population. Arabic is weakest at 65 %. The main error
  is neutral giveaway entries labelled positive.
- Maistro's keyword fallback: 43 / 100, so it was dropped. Unanalysed comments now show "not analysed".
- The Arabic, Gulf, Arabizi and sarcasm labels are a model's and need a native-speaker check.

**Owner decisions this phase leaves open:**
- apply migration 018, then link finals to their posts;
- the tracker's sentiment backfill (paid; estimate the cost first) and pushing SamsungSentiment `39d2568`;
- a native-speaker check of the 7.3 and 7.4 labels;
- the "responder" role (reviewers handle comments today);
- confirm or amend the decision list in §1.
