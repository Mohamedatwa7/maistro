# GOLDEN_SET — Phase 6.10 content evaluation (proposal, not yet run)

Status 2026-10-22: **proposal for the owner.** Nothing in this document has been generated; the baseline run is a paid
spend (Higgsfield renders) and waits for the owner's approval of the set, the rubric and the budget below. The
mandate asks for the set to be chosen "with me" — this is the builder's starting point, to be amended.

## 1. Source and constraints

- Trend history: `trend_snapshots`, 133 distinct trends on 28 Trend Radar boards, 2026-09-15 → 2026-10-21.
- Languages in history: EN 126, MIXED 7, **Arabic / Gulf 0.** The feed is TikTok-first and global; an Arabic slice
  cannot be drawn from history. **Owner input needed: 3–4 real Gulf-Arabic trends** (or permission to source them).
- Categories in history: entertainment 57, other 33, sport 23, beauty 6, fashion 4, food 2, family 2, lifestyle 2,
  tech 2, finance 1, education 1. Sport and news-event trends are mostly vetoed as unproducible (real events,
  licensed footage), so they are under-represented on purpose.
- Products: the set spreads across the 2026 catalog (foldables, S26 Ultra, Tab S12, Buds4 Pro, Watch9, a TV /
  Bespoke appliance). The product per trend is the builder's mapping; the judge's mapping is shown where it exists.
- Platforms: TikTok and Instagram Reels (both 9:16); one Instagram feed piece if the owner wants 4:5 covered.

## 2. Proposed set (16 from history + 4 owner-supplied = 20)

| # | Trend (board date) | Category · lang | Product (builder) | Why it is in the set |
|---|---|---|---|---|
| 1 | Setup line then deadpan punchline caption reveal (10-21) | entertainment · EN | Galaxy Z Flip8 | the one trend ranked under every prompt version; caption-reveal mechanic |
| 2 | POV Sudden Betrayal or Twist Reveal (10-21) | entertainment · EN | Galaxy S26 Ultra | top v1.2 score; POV narrative |
| 3 | Upside Down Hand Transition (10-21) | entertainment · EN | Galaxy Z Fold8 | transition mechanic, product-led |
| 4 | Outfit or Look Transition Reveal Edit (10-21) | fashion · EN | Galaxy Watch9 | outfit reveal, wearable fit |
| 5 | Wash Day Hair Transformation Labels (10-21) | beauty · EN | Galaxy Z Flip8 | judge-mapped product; label overlays (text-heavy) |
| 6 | Captioned Portrait Punchline Meme (10-21) | entertainment · EN | Galaxy S26 Ultra | "review before use" culture flag — tests the advisory path |
| 7 | CapCut Pioneer Template Reveal (10-21) | other · EN | Galaxy Tab S12 | template / editing mechanic |
| 8 | Reaction clip with caption setup and punchline (10-21) | entertainment · EN | Galaxy Buds4 Pro | audio-led; a prior safety flag |
| 9 | Thank You Baby money reaction meme (10-21) | entertainment · EN | Galaxy Z Flip8 | sung-line hook, audio clearance |
| 10 | Kick Transition Outfit Reveal (09-28) | fashion · EN | Galaxy Watch9 | older board — tests timing on a stale trend |
| 11 | Recipe reveal montage with ingredient shot (09-28) | food · EN | Bespoke AI fridge | appliance, montage format |
| 12 | Healing Eyes Drawing Trend (09-28) | beauty · EN | Galaxy Tab S12 (S Pen) | creative / drawing, product as tool |
| 13 | What Makes You Happy montage (10-14) | lifestyle · EN | The Frame TV | montage, home |
| 14 | First Week of School Outfit Check (09-28) | fashion · EN | Galaxy Buds4 Pro | seasonal |
| 15 | Saudi National Day tribute overlay (09-25) | other · MIXED | Galaxy S26 Ultra | Gulf calendar moment; national symbols (cultural rules) |
| 16 | International Coffee Day promos (10-15) | food · MIXED | Bespoke appliance | calendar moment, mixed language |
| 17–20 | **owner-supplied Gulf-Arabic trends** | Arabic | to map | Arabic copy, RTL overlays, Gulf fluency checks |

Excluded on purpose: vetoed real-event / sport / news trends (unproducible), and the 3 trends whose sounds are flagged
not cleared — unless the owner wants them as must-stop cases.

## 3. Human rating rubric (to agree with the owner before scoring)

Each stage output is rated 1–5 by the owner (or a named reviewer) at its approval, with the structured rejection
reason when below 4. First-pass approval = approved without a regeneration.

| Stage | 5 = | 3 = | 1 = |
|---|---|---|---|
| Moodboard | direction is on-brand, specific to the trend and the Gulf; usable as is | usable after one change | off-brand or generic |
| Thumbnail | stops the scroll, product exact, headline legible on a phone, safe zone clear | one fix needed | wrong product / illegible |
| Brief | every field right; claims none or approved; Arabic native | one field to edit | contract wrong |
| Storyboard | follows the trend beat by beat, every feature, hook < 3 s | 1–2 shots to redo | not the trend |
| First draft | product stable in every shot, no artefacts, pacing right | 1–2 clips to redo | unusable |
| QC plan | every real problem located at the right unit, cost plausible | misses one | wrong |
| Final | every QC risk resolved or honestly reported, postable | one more fix | not postable |

## 4. Metrics (computed in code from the store)

Per stage and overall: first-pass approval rate · rejection reasons (taxonomy codes) · regeneration rounds · product
accuracy rate (vision / clip checks passed on product) · Arabic quality (brief copy check + owner rating) · F1X8 at QC
and at final · cost per approved piece (generation_records.cost_usd) · time per approved piece (first version →
final approval). The before/after table compares the baseline run with the run after improvements; a stage change
ships only if it beats the baseline without regressing another metric.

## 5. Budget (from the provider's own price card)

Per piece, the Studio submits roughly: 1 moodboard set (Soul V2 ×4), 1 thumbnail (Soul, v1 reference path when a
product photo is attached), 4–6 storyboard keyframes (Soul ×1), 4–6 first-draft clips (Seedance image-to-video,
4–8 s at 720p), 1–2 final re-renders, plus Claude calls and F1X8 analyses (not Higgsfield-billed).

Unit prices from the provider's own `/estimate` (price card of 2026-10-22 06:17 UTC):

| Item | Provider estimate |
|---|---|
| Soul V2, 1 image, 1080p | $0.006 (0.09 credits) |
| Soul V2, set of 4, 1080p (moodboard) | $0.023 (0.36 credits) |
| Seedance 2.5 image-to-video, 4–8 s, 720p / 1080p | **not priced by the provider** — `/estimate` answers `{ type, pricing_description }` with no number. **Budgeting assumption until real prices:** $0.50 per second of clip (`MAISTRO_UNPRICED_VIDEO_USD_PER_S`), i.e. a 5 s clip = $2.50 |

Image cost per piece (Soul only): moodboard $0.023 + thumbnail $0.006 + 5 keyframes $0.030 + a few re-renders ≈ **$0.07**,
i.e. ≈ $1.40 for 20 pieces — negligible. The baseline budget is dominated by the video clips (≈ 6–8 per piece incl.
re-renders). Under the assumption above: ≈ 7 clips × 5 s × $0.50 = **≈ $17.50 per piece**, ≈ **$350 for the 20-piece baseline** and the same again for the after-run — an upper-bound guess to be replaced by the provider's pricing rule. Claude calls and F1X8 analyses are not
Higgsfield-billed (Anthropic usage is on the generation records; F1X8 runs on our own service).

## 6. What the owner decides

1. Approve or amend the set; supply 3–4 Gulf-Arabic trends.
2. Approve the rubric (or name the reviewer who rates).
3. Approve the budget for the baseline run (and the second run after improvements).
