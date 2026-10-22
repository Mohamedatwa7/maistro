# TREND_FRAMEWORK — how Maistro decides which trends are worth acting on

Phase 5.1 deliverable, 2026-10-21. **Status: builder's initial framework under the owner's delegated gate** (2026-10-21: "go ahead with all the changes necessary for improvement"). Every weight, veto and threshold below is a starting value the owner may amend; calibration (5.7) then moves them on evidence. Grounded in `KYMAH_DATA.md` (what the feed actually carries), `api/_brand.js` (the brand playbook and catalog), and the curation prompt that runs today (`api/_handlers/trends.js claudeCurate`).

## 0. Principles (from the mandate, made operational)

1. A trend is "right" only if it is **alive when we post**, **fits Samsung Gulf**, **maps to a real product**, is **safe**, and **our pipeline can produce it**.
2. **Vetoes beat scores.** A vetoed trend never appears in the ranked view; it appears in the Rejected view with its reason and can be overridden by a human (logged).
3. **Numbers are computed in code** from `trend_snapshots` and the feed; **the LLM judges** fit, meaning and safety, always with evidence and a rationale, never arithmetic.
4. **Every claim is traceable** to a feed field or a snapshot row; if the data does not support a claim, the claim is not made and the criterion carries low confidence.
5. **The feed is TikTok-only in practice, global in scope, with no Gulf-presence signal** (KYMAH_DATA §4). Gulf relevance is therefore a judgement with explicit confidence until Maistro has its own Gulf evidence; no Instagram claim is made.

## 1. Layer 1 — hard filters (any failure = vetoed)

Each veto has a **code**, the **evidence it may use**, who decides, and the confidence rule. "LLM" vetoes use a strict rubric with a mandatory quote of the evidence; "ambiguous" is never "safe" — it is **"needs review"**, which keeps the trend out of the ranked view until a human decides. **Calibration 2026-10-22 (from the first complete run, 19:15 UTC 2026-10-21: 1 ranked of 38, culture needsReview on 16 of 25 judged and origin on 13):** V-CULTURE and V-ORIGIN "needs review" are **advisory** — the trend is scored and ranked with confidence forced to low and a "review before use" badge; "needs review" keeps a trend out of the ranking only for V-SAFETY and V-AUDIO. A hard veto of any code still rejects. Prompt `profile-v1.2`: missing information is not a cue (lower confidence instead); audioExplicit needs a concrete cue in title, name, brief or captions, since the feed never carries lyrics. **v1.3 (same day, checker finding on the first v1.2 run — safety needsReview fell 3 → 0, which was not intended):** the cue rule applies to culture, origin and audioExplicit only; for safety, ambiguous stays needsReview with what a human must check. **v1.4 (06:15 run: safety needsReview 11 of 25, two benign formats held back because "clips are unseen"):** safety needsReview needs a descriptive cue in the evidence (chaotic / unhinged / shocking, suggestive, conflict incl. truncated, real people in a controversy, minors, a sensitive theme); unseen clips alone are not one. Eval principle (agreed with the checker): every production false positive or negative becomes a case — the production deadpan caption trend is now a must-pass and the production POV twist (its own brief says "unhinged" and "deadnamed-by-a-friend") a must-review, both stored exactly as the judge received them. Guard-rail eval: `api/_trends/eval-set.js` (4 must-flag cues, the 2 prior safety flags as must-review, 2 must-pass), run live by `GET /api/trends?view=eval` (session, ≤ 1 per 10 min, never written to `trend_scores`) and recorded as a fixture.

| Code | Veto | Evidence available today | Decided by |
|---|---|---|---|
| V-SAFETY | sexual content; violence; alcohol; gambling; drugs; politics; religion used inappropriately; mockery of groups; tragedy/crisis-linked; hate symbols; dangerous challenges | `name`, `why`, `brief.microTrend/mechanic`, `category`, clip handles and sound title; the upstream gate's `brandSafe` is **not exposed** (folded into `onBrand`), so this is Maistro's own verdict | LLM rubric, per sub-category, with quoted evidence; unknown → needs review |
| V-CULTURE | conflicts with Gulf cultural or religious norms; inappropriate during Ramadan when in Ramadan; gender-representation issues; suggestive or revealing choreography | same as above + the calendar (§4) | LLM rubric; Ramadan rule is deterministic (calendar) × LLM (is the mechanic incompatible with Ramadan?) |
| V-ORIGIN | started from a controversy, a competitor campaign, or a creator with brand-safety issues | `why`, `brief`, clip handles (`clips[].handle`), `sound.author`; competitor names list (code) | code (competitor/handle lists) + LLM (controversy) |
| V-AUDIO | trending sound with explicit lyrics, or not cleared for commercial use | `sound.commercialUse.cleared`: `false` → veto; `null` → **needs review** ("verify in the business account"); `true` → pass; explicit lyrics → LLM on `sound.title` only (lyrics are not in the feed → low confidence, needs review when unsure) | code + LLM |
| V-EXPIRED | the trend's estimated end of life is already behind us | end of life (§3.4) < today. A post-by date that has passed while life remains is **late**, not vetoed: momentum scores 2/10 and the card says so — with the seed median stay (6.5 d) and the assumed 5-day lead time most trends are late by day two, and hiding that would hide the real constraint (our lead time) | code |
| V-UNPRODUCIBLE | a format our pipeline cannot produce credibly | production-feasibility class (§2.6) = `infeasible` | LLM classification into fixed format classes, then code |
| V-DATA | the record fails the minimal schema (no name/id) or the board is `live:false` older than 48 h | code | code |

Vetoed trends keep their full profile and score inputs so the Rejected view can show "why", and overrides are logged (`trend_decisions`, §6).

## 2. Layer 2 — weighted criteria (0–10 each, with evidence)

Initial weights (sum 100). "Code" criteria are deterministic from data; "LLM" criteria use the rubric in §5 and output `{score, evidence[], rationale, confidence}`.

| # | Criterion | Weight | Computed by | Inputs today | Notes |
|---|---|---|---|---|---|
| 2.1 | Momentum & timing | **20** | code | `trend_snapshots`: `growth_pct_per_day` series, `stage`, `durability`, days on board, first/last seen; lead time (§3.3) | lifecycle stage + velocity + acceleration + remaining window vs lead time (§3) |
| 2.2 | Gulf relevance | 12 | LLM (low confidence by design) | `scope`, `lang`, clip handles, `why`; **no GCC engagement signal exists** | until Gulf evidence exists, cap confidence at "medium" and never above 7/10 unless `scope:'local'` or Arabic/Gulf creators are visible in clips |
| 2.3 | Product fit | 15 | LLM + catalog check in code | `brief.adaptations`, `products` (8/38 have matches), `fit.beat`, `api/_brand.js PRODUCT_CATALOG` | the mapping must resolve to a catalog name (code check); forced mappings score ≤ 4 |
| 2.4 | Brand fit | 10 | LLM | `BRAND_PROMPT` (Confident Explorer, Refined Wit, never loud/cutesy) | |
| 2.5 | Audience fit | 6 | LLM | product → segment table (§4.2) | |
| 2.6 | Production feasibility | **15** | LLM classification → code score | format class (§2.6 table) | the single biggest cost driver; see table |
| 2.7 | Platform fit | 5 | LLM + code | feed is TikTok; target platform from the owner's plan | |
| 2.8 | Saturation | 7 | LLM (low confidence) | `why`, clip handles; competitor lane **not projected** | until data: "unknown" = 5/10 at low confidence |
| 2.9 | Calendar alignment | 5 | code | §4.1 calendar vs post-by date | |
| 2.10 | Historical signal | 5 | code | `trend_decisions` + attribution (Phase 7.5) | 0 weight until ≥ 30 attributed posts exist (reported, not hidden) |

**Final score** = Σ weight × score/10 over the criteria that have a value, **normalised to 100 over those criteria's weights** (so the inactive historical weight and a criterion the data cannot support do not cap or zero a trend; the card shows which criteria were normalised away), computed in code, stored with every input (§6). Criteria with confidence `low` are listed under "Unknowns" on the card.

### 2.6 Production-feasibility classes (what Soul + Seedance can credibly make)

| Class | Examples | Score | Why |
|---|---|---|---|
| `product-led visual` | product reveal, satisfying unboxing, before/after, "POV: your phone…", on-screen-text formats, caption-reveal deadpan formats | 9–10 | single subject, text as overlay, short shots |
| `scene / mood` | aesthetic montage, "day in the life" without a recurring face, setting-based humour | 7–8 | Soul keyframes → Seedance image-to-video (HIGGSFIELD.md §2.2) |
| `character-light` | a person in frame but no identity continuity needed across shots | 5–6 | identity drift between shots is the known failure |
| `performance` | dance, lip-sync, choreography, stunts, specific creator faces, duets | 1–2 | generative video cannot do this credibly; route to the **Hermes/external** path if at all |
| `infeasible` | requires real people's likeness, live events, licensed footage, trend hinges on a specific real creator | veto (V-UNPRODUCIBLE) | |

## 3. Timing model (all computed in code from `trend_snapshots`)

3.1 **Velocity** = the feed's `growth_pct_per_day` (counter growth) at the latest snapshot; **acceleration** = velocity(latest) − velocity(previous distinct board), where the feed moves once a day (KYMAH_DATA §2).
3.2 **Lifecycle stage** (Maistro's own, finer than the board's peaking/mature; `unknown` until two distinct boards exist, §3.4b): `emerging` = days on board ≤ 2 and velocity > 0; `rising` = acceleration > 0 and velocity ≥ 2 %/day; `peaking` = velocity ≥ 0 and acceleration ≤ 0; `declining` = velocity < 0 or the trend left the board (last seen < latest board); `evergreen` = `durability:'ongoing'` and ≥ 21 days on board. The upstream `stage` is shown alongside as "Trend Radar says: …".
3.3 **Lead time** = median of (final-approval time − piece creation time) over Maistro's own pieces (`content_pieces.created_at` → `approvals.decided_at` for the final stage), recomputed daily; **until ≥ 5 approved pieces exist, a stated assumption of 5 days is used and the card says "assumed"** — never silently.
3.4 **Remaining window** = estimated end of life − today, where end of life = first seen + the median stay of trends of the same `durability` class in Maistro's history (seed values measured over distinct board dates in the Trend Radar git history, checker measurement 2026-10-21: flash n=56 median 3.0 days, ongoing n=76 median 6.5 days; replaced by live medians once a class has ≥ 20 trends in `trend_snapshots`). **Post-by date** = end of life − lead time. Shown on every card; V-EXPIRED when it is in the past.
3.4b **Cold start:** `trend_snapshots` starts on 2026-10-21, so first-seen and days-on-board are backfilled from the 28 distinct boards in Trend Radar's git history (`scripts/backfill-trend-history.mjs`, source `TrendRadar git history`); a trend with fewer than two distinct boards in its history has stage `unknown` (momentum 5/10) rather than a guessed `emerging`.
3.5 Score 2.1 = f(stage, remaining window ÷ lead time): rising with runway ≥ 2× lead time → 9–10; peaking with runway ≥ 1× → 6–7; declining → 1–2; evergreen → 6 (always producible, rarely urgent).

## 4. Reference tables (code, editable by the owner)

4.1 **Gulf calendar** (dates for moon-sighted events are **estimates to be confirmed** each year): Ramadan 2027 ≈ 7 Feb–8 Mar 2027; Eid al-Fitr 2027 ≈ 9 Mar; Eid al-Adha 2027 ≈ 16 May; Saudi National Day 23 Sep; UAE National Day 2 Dec; Qatar National Day 18 Dec; Bahrain National Day 16 Dec; Oman National Day 18 Nov; Kuwait National/Liberation Days 25–26 Feb; White Friday (Gulf "Black Friday") last week of November; Samsung launch windows: Galaxy Unpacked (Jan/Feb and Jul/Aug historically), to be entered by the owner per year.
4.2 **Product → audience segments** (initial, from the catalog in `api/_brand.js`): foldables and S-series Ultra → premium tech-forward 25–40; A-series → value-conscious 18–30; wearables/Buds → fitness and commute 20–35; TVs/appliances → households and new movers 28–45. The owner's real segment definitions replace these.
4.3 **Competitor lists** for V-ORIGIN and 2.8: Apple/iPhone, Google/Pixel, Xiaomi, Oppo, Huawei, Honor, OnePlus, Nothing, LG (TV), Dyson (home) — handles and campaign hashtags maintained in code.

## 5. LLM rubric and consistency

- One structured call per trend produces the **Trend Profile** (5.2: what it is, mechanic, origin/meaning, lifecycle evidence quoted from snapshots, why it spreads, confidence, explicit unknowns) and the judgement criteria (2.2–2.8) as JSON validated against a schema; every score carries `evidence` (quoted feed fields) and `rationale`; **no numbers are invented** (views, counts and growth come from code and are injected read-only).
- Anchors per criterion: 0–2 "contradicted by evidence", 3–4 "weak/forced", 5 "unknown or neutral (must say why)", 6–7 "clear fit with a stated caveat", 8–10 "evidence-backed, specific product/feature named".
- **Consistency:** the same sample (20 trends) is scored 5× at the pinned prompt version; report the per-criterion standard deviation; if any criterion's σ > 1.0 the rubric is tightened or the median of 3 samples is used (and the cost tripled, stated).
- Arabic / mixed-language trends: the profile is produced in the language of the evidence with an English summary; Gulf dialect and Arabizi hashtags are kept verbatim as evidence.

## 6. Storage and audit (so rankings are reproducible)

- `trend_scores` (one row per trend per scoring run): `trend_id`, `snapshot_id`, `prompt_version`, `model`, `weights_version`, `inputs` (the exact JSON given to the model), `vetoes[]`, `criteria{}`, `final_score`, `post_by`, `lifecycle`, `confidence`, `at`.
- `trend_decisions`: every human pick / skip / rejection / override with a structured reason (5.7).
- Any change to the prompt, model, weights or rubric bumps a version and re-runs the 5.9 eval set as a regression check.
- **Run budget (found 2026-10-21 in production):** a judgement takes ~14 s (Sonnet 5.5, `profile-v1.1`, ~5.8k input / 1.8k output tokens) and the hourly cron runs inside one function invocation (`maxDuration` 300 s) that writes its rows at the end — the 18:15 UTC run judged 18 trends sequentially and was killed before writing anything. Rule: judgements run concurrently (`MAISTRO_JUDGE_CONCURRENCY`, default 4) under a deadline passed by the cron (function limit − 45 s; `MAISTRO_JUDGE_BUDGET_S` 180 s when called without one); trends not reached are stored `unjudged` with `judgeError: deferred…` and judged by the next run (judgements are cached per trend × board × prompt version). Trends hard-vetoed by the deterministic rules (uncleared sound, expired, no data, infeasible) are never sent to the judge: the verdict is final without the model. The summary reports `judged / reused / failed / deferred / skippedVetoed`.

## 7. What the owner may want to change first

1. The weights in §2 (momentum 20, product fit 15, feasibility 15 are the builder's bets).
2. The Ramadan/National Day dates for the coming year and the Unpacked windows.
3. Whether `commercialUse.cleared === null` should veto outright instead of "needs review".
4. The audience segments in §4.2.
