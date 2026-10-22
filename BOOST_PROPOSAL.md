# BOOST_PROPOSAL — Phase 8a: data and method for the boost recommendation (proposal, no code)

Status 2026-10-22: **for the owner's sign-off** (the mandate: "Show me the data and method before building").
Nothing here is built. The recommendation cannot produce real output until the data below exists. The earliest
dates are in §5.

## 1. The decision
**Boost** (put paid spend behind an organic post) within the window where it pays: the first 24–72 h. The
output for a post is **Boost / Watch / Don't boost**. Each comes with a rationale that lists every check and its
number, and a confidence. It is advice for a person to act on in Sprinklr or the ad manager; Maistro spends
nothing.

## 2. Data
| Input | Source | Available today |
|---|---|---|
| Early performance: ER (or engagements on Facebook and IG images) at age 0–1 d and 1–3 d | the daily snapshots (`sentiment_posts`, since 2026-10-20) and the live read, through the 7.2 young-band cells | **no** — no young band has reached n ≥ 20 yet (largest: IG video 3–7 d, n = 15) |
| Peer baseline: the same platform × format × age band, organic only, last 90 days | 7.2 benchmarks | yes for mature posts; young bands fill daily |
| Qualitative score: F1X8 at final, and unresolved QC risks | the final's verification (Content Studio 6.8) | only for posts made in Maistro and linked (`piece_posts`) — **0 today** |
| Brand-safety signal: share of the post's comments in complaint or product-issue themes | 7.4 themes (complaints 0.95 / 0.95 on the adjudicated audit) | yes |
| Giveaway flag | 7.2 / 7.4 | yes; giveaways are never recommended (their engagement is the entry mechanic) |
| Data freshness | R-9 | yes; **Facebook and X are stale since 2026-10-16 (TRACKER_INGESTION F2), so no recommendation for them until P1 is fixed** |

## 3. Method (all computed in code)
1. **Eligible:** an organic post; not a giveaway; its platform's data is under 48 h old; age under 72 h.
2. **Quantitative check:** the post's standing in its young-band cell (nearest rank), only where the cell has
   n ≥ 20. **Pass** = at or above P75 of the cell; **strong** = at or above P90. ER uses views ≥ 500, as in 7.2.
3. **Qualitative check** (posts made in Maistro): F1X8 final ≥ *T_f1x8* and no unresolved high-severity QC
   risk. For posts not made in Maistro this check is **absent**, not passed. Those posts can reach at most
   "Watch", unless the owner decides otherwise.
4. **Brand safety:** complaint plus product-issue themes under *T_safety* % of the post's comments, with at least
   10 comments (otherwise "not enough comments", which does not block).
5. **Recommendation:**

   | Result | Conditions |
   |---|---|
   | **Boost** | quantitative pass, qualitative pass, safety pass |
   | **Watch** | quantitative pass with qualitative absent, or quantitative strong with safety unproven |
   | **Don't boost** | any failed check |

   The rationale lists each check with its number, e.g. "ER 9.1 % at 1–3 d — P86 of 24 TikTok organic posts;
   F1X8 8.4 (≥ 7.5); complaints 2 % of 51 comments".
6. **Confidence:** high when the cell n ≥ 40 and the margin over P75 is ≥ 10 points; medium when the cell
   n ≥ 20; otherwise no recommendation.

*T_f1x8* (proposed **7.5**) and *T_safety* (proposed **10 %**) are owner decisions.

## 4. Validation before it ships (the mandate: "would it have flagged the real top performers early enough")
- **Backtest set:** posts that have a 0–1 d or 1–3 d snapshot **and** a mature (≥ 7 d) outcome.
- **"Real top performer"** = mature standing ≥ P90 of its cell.
- **Flagged early** = Boost or Watch at its young band.
- **Report:** precision and recall, each with a Wilson 95 % interval, per platform; plus the lead time (hours
  from posting to the flag).
- **Acceptance (proposed, owner to set):** recall ≥ 0.6 and precision ≥ 0.5 on n ≥ 30 top performers per
  platform. The interval is shown, never just the point.
- The same backtest runs in CI on recorded snapshots once they exist (Phase 9).

## 5. When it can run
- **Snapshots** began 2026-10-20. A post needs one young snapshot and 7 more days to mature. At about 2 posts
  per day per platform, a platform reaches 20 young observations around 2026-10-30 to 11-01. The page computes
  the expected date per band.
- **The first backtest** (about 30 matured posts with young snapshots per platform) is possible around
  **mid-November 2026** for TikTok and Instagram. Facebook and X wait on the ingestion fix.
- **The qualitative half** needs linked posts (attribution, 7.5). Until then a recommendation can be at most
  "Watch".

## 6. What the owner signs off
1. The three outputs and the rule in §3.5.
2. *T_f1x8* and *T_safety*.
3. Whether posts not made in Maistro can ever reach "Boost" on quantitative evidence alone.
4. The acceptance thresholds in §4.

Then the "Boost Loop" label is replaced by the working feature.
