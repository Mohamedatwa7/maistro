# GOLDEN_SET — Phase 6.10 content evaluation (proposal, not yet run)

Status 2026-10-22: **not authorised — owner decision 2026-10-22: no Higgsfield spend for testing.**
- The golden-set run renders with Higgsfield, so it does not run.
- Free `/estimate` calls (the price card) and tests against the fake stay allowed.
- Real renders happen only when a person generates a piece in the Studio.
- Guards: the adapter refuses submits under `MAISTRO_NO_RENDER=1`, the eval runner sets it, and every script that
  could render refuses to run (`tests/api/no-paid-renders.test.js`).

The set, rubric and budget below stay on file as the builder's proposal in case the owner reverses the decision.
Nothing has been generated.

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

## 5. Budget (from the provider's own prices)

Prices from Higgsfield itself (price card 2026-10-22 08:15 UTC): Soul V2 through `/estimate` — **$0.006 per image,
$0.023 per set of four** (1080p); Seedance 2.5 through its own pricing rule (the estimate returns a sentence, which
Maistro now parses) — **$0.2056 per second at 480p, $0.4622 at 720p, $1.1372 at 1080p** (stated for 16:9 output;
billed on output pixels, so 9:16 is the same).

One full piece (5 shots of 5 s, typical re-renders):

| Part | 720p | 1080p |
|---|---|---|
| Images: moodboard set, thumbnail, 5 keyframes, 2 keyframe re-renders | $0.07 | $0.07 |
| First draft: 5 clips × 5 s | $11.56 | $28.43 |
| 2 clip re-renders during draft review | $4.62 | $11.37 |
| Final: 2 re-renders from the QC plan | $4.62 | $11.37 |
| **Total per piece** | **≈ $20.87** | **≈ $51.24** |

Golden-set runs (20 pieces): **≈ $420 per run at 720p** (≈ $840 for baseline + after-run), ≈ $1,025 per run at
1080p. Claude calls and F1X8 analyses are not Higgsfield-billed and are not included.

**Default per-piece cap — owner decision 2026-10-22:** **$20 for a 720p piece, $50 for a piece rendered at 1080p**
(warning at 80 %), sized for an average video of 10–15 s: 3 shots × 5 s (15 s) + 2 draft re-renders + 2 final
re-renders of 5 s (20 s) = 35 s generated; 35 × $0.4622 = $16.18 at 720p, 35 × $1.1372 = $39.80 at 1080p, images
≈ $0.05; the caps leave ~20 % headroom. The golden-set pieces above are costed at 5 shots (≈ $20.87 / $51.24), so
they exceed the default and **each needs its cap raised for the run** (e.g. $25 at 720p, $60 at 1080p) by a line
manager or admin with Set cap on the piece — the default is not changed for them.

## 6. What the owner decides

1. Approve or amend the set; supply 3–4 Gulf-Arabic trends.
2. Approve the rubric (or name the reviewer who rates).
3. Approve the budget for the baseline run (and the second run after improvements). The default caps are decided ($20 / $50); the run raises each piece's cap.
