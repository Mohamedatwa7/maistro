# KYMAH_DATA — what Trend Radar (kymah.com) exposes, verified by inspection

Phase 5.0 deliverable, 2026-10-21. Every statement below was read from the Trend Radar repository (`D:\Trend Radar\samsungtrend`, GitHub `Mohamedatwa7/trend-radar`), its daily data commits, or measured on the published board file `apps/web/app/lib/trends.generated.json` (38 trends, generated 2026-10-21T08:25:58Z). Nothing here is assumed. Where a signal is missing, it says so.

## 1. How the data reaches Maistro

| Surface | Used by Maistro | Notes |
|---|---|---|
| `GET {TRENDRADAR_BASE_URL}/api/agent/trends?limit=200` (bearer `TRENDRADAR_AGENT_KEY`) | **primary** (`demo-ui/api/_handlers/trends.js:74`) | Trend Radar's machine projection of the published board (`apps/web/app/lib/agent/feed.ts`, type `AgentTrend`). Read-only. Rate limit 60/min per IP. `live:false` = Trend Radar's database read failed and its build-time snapshot answered. |
| kymah.com page payload (Next.js flight data) | fallback only (`trends.js:154`) | same board, scraped; brittle; kept behind the primary path |
| `POST /api/agent/brief`, MCP `author_brief` | **not used** | bills a Sonnet call per invocation; Maistro authors its own briefs |
| `GET /api/agent/feed/sounds`, `/terms` | not used yet | sound chart and keyword surfaces (candidates for 5.3 clustering evidence) |

**Collection is never triggered.** Trend Radar's collection runs as its own GitHub Actions workflow (`.github/workflows/daily-collect.yml`); the agent API and the page only read the published board. Maistro has no code path that calls any Trend Radar write endpoint; the only POST endpoints on the agent surface are `brief` and MCP, neither of which Maistro calls (tests: `demo-ui/tests/api/trends.test.js` mock every outbound call and assert the agent URL only).

## 2. Update frequency

- Collection: one GitHub Actions run per UTC day, primary slot **01:07 UTC (05:07 Gulf)**, retry slots 02:27 and 04:37 UTC (GitHub drops scheduled runs under load; a precheck makes retries no-ops once the day succeeded). The run pulls Google Trends (AE+SA), keywords, the sound extractor (TikTok charts + deep pulls + Instagram Reels lane), publishes the board (`tools/sound-trends/board-publish.ts`), ticks the forward collector (snapshots + decay), runs the competitor and TikTok Business lanes, and commits the state back to the repository.
- Publication time observed: the board's `generatedAt` is ~08:25–08:31 UTC on recent days (the run takes hours after 01:07). **So the board changes once a day**; Maistro's hourly refresh exists to pick up that one change within the hour and to recover from outages, not because the data moves hourly.
- Board history is in git: one data commit per day (`data: daily collection YYYY-MM-DD`), 40 commits since 2026-09-15. That history is Maistro's only source of lifecycle evidence until Maistro's own snapshots accumulate (§6).

## 3. Field dictionary (agent projection `AgentTrend`)

Coverage measured on the 38-trend board of 2026-10-21. "Empty" counts `null`, `''`, `[]`, `{}`.

| Field | Type | Meaning (from the producer's code/comments) | Coverage on 38 | Reliability notes |
|---|---|---|---|---|
| `id` | string | Trend Radar's id (`snd-<musicId>`, `top-…`, `ig-…`) | 38/38 | stable across days (used for history joins) |
| `name` | string | board title | 38/38 | |
| `kind` | `trend` \| `category` \| `moment` | trend = measured sound/format cohort; moment = short-lived event; category = topic family | trend 29, moment 9 | |
| `stage` | string | **board** stage mapped from the measured stage: `rising` → rising; `active` → **peaking**; cooling/evergreen → **mature** (`board-layout.ts:42`) | peaking 31, mature 7 | only three values ever appear on the board; the finer measured stages (early/rising/active/cooling/evergreen) live in the ledger, not in the feed |
| `growth` | string `"+N%/day"` | counter growth %/day: the external usage counter's growth vs the ledger's prior readings, else sampled growth, else velocity (`promote.ts:55 growthOf`) | 38/38 | a string; Maistro parses it (`parseGrowth`). Only positive values seen |
| `category` | string | topic family (entertainment, sport, tech, beauty, fashion, food, other) | 38/38 | 20/38 entertainment, 9 other |
| `scope` | `global` \| `local` | geographic reading | global 36, local 2 | "local" is rare; GCC presence is **not** a field |
| `lang` | string | language of the sampled posts | en 36, mixed 2 | no Arabic-only trend on this board |
| `onBrand` | boolean | passed the Samsung relevance gate: brandSafe AND `fit.strength ≥ 50` AND a named Galaxy beat, and not sensitive-blocked or demoted (`board-enrich.ts:100–107, 506`) | true 11 / false 27 | the gate is an LLM verdict with a prompt version; cached per trend |
| `fit` | `{strength 0–100, beat, reason}` \| null | the gate's "how ownable is the Galaxy hook" score, the beat, one-line reason | 29 present, **9 null (never gated)** | null = UNKNOWN, not zero. Range on this board 0–82; 11 ≥ 50 |
| `signalStrength` | 0–100 \| null | hand-weighted evidence composite (sources, verification, clips, growth measured) — **not** a probability | 38/38 | do not treat as a quality score |
| `durabilityClass` | `flash` \| `seasonal` \| `ongoing` \| null | `spanDays < 14` → flash else ongoing (`board-publish.ts:265`); categories always ongoing; moments always flash | ongoing 25, flash 13 | `seasonal` never produced on this board |
| `viewsWk` | string (`"2.7M"`) \| null | sum of views of the **sampled** example posts aged ≤ 7 days (`board-layout.ts:267`) | 28 present, **10 null** | a sample, not the platform total; null = no post in the window |
| `eng` | number \| null | likes per 100 views averaged over sampled clips with both counters (`board-layout.ts:279`) | 38/38 | sample-based; typical 5–22 |
| `sound` | `{title, author, cue, musicId, commercialUse:{cleared, checkedAt}}` \| null | the trend's sound; `commercialUse.cleared` is **TikTok's own flag** read from the music page, null = never read | 29 present, 9 null; cleared true 16 / false 13; musicId 29/29 | not legal clearance — the in-app business-account check stays the final word (producer's own caveat) |
| `clips` | array ≤ 6 of `{vid, handle, views, sound, role, poster}` | the board's reference clips (roles: top, recent-top, earliest-observed, origin, reference) | **0 clips in the published file** (the projection fills them from `thumbs`, 6 per trend; posters were absent on 2026-10-21) | TikTok video ids + handles; views as strings |
| `format` | `{mechanic, payoff, props, secondsToPayoff, basis}` \| null | the observed format read | **0/38** | not populated on the current board |
| `why` | string | one-line "why it is spreading" | 38/38 | LLM-authored |
| `tags` | string[] | hashtags | **9/38 non-empty** | mostly empty; Maistro's curation asks Claude to supply community hashtags when missing |
| `firstSeen` | ISO \| null | from `tracked.firstSeenAt` | null in the recorded feed; the raw file has `tracked.firstSeenAt` + `runsSeen` for 29/38 | first observation by Trend Radar, not on-platform origin |
| `runsSeen` | number \| null | daily runs the trend has been measured in | as above (`runsSeen` 1–5 observed) | |
| `brief` | `{microTrend, mechanic, adaptations[], onBrand[]}` \| null | pre-authored editorial brief with per-product adaptations | 38/38 | LLM-authored; free to read |
| `products` | array of `{product, line, reason, score}` | exact-model Galaxy matches | **8/38 non-empty** | only gated trends get matches |

Raw-only fields (in the published file, not in the projection): `basis` (how momentum/freshness/acceleration were measured), `carried` (carry-over state from the previous day, 30/38), `tracked`, `pos` (board x/y), `sources` (count), `showable`, `measured`, `hopOn`, `thumbs`, `spark` (always null), and a board-level `audit` block (published/reboarded/stillMoving/completed/drifting/unmeasured counts, `verifiedPct`).

## 4. Platform coverage — TikTok yes, Instagram effectively no

- TikTok: the sound extractor's charts and deep pulls (TikHub-backed), the TikTok Business lane, and the clip-liveness probe (oEmbed; the 2026-10-20 collapse and its probe-health gate are in `trend-radar-board-pipeline` notes). `data/tiktok-raw`: 178 files.
- Instagram: a Reels radar lane exists (`tools/instagram/ig-radar.ts`, since 2026-09-16) and joins rows as `ig-…`; **on the current board 0 of 38 trends are Instagram-origin**, and `data/instagram/ig-radar.json` holds sightings/counters but no board rows. Treat the feed as **TikTok-only** for planning purposes until the IG lane produces board members; Maistro must not claim Instagram evidence it does not have.
- Regions: `scope` is global for 36/38; there is **no GCC-presence signal** (no per-country engagement, no Gulf-creator flag). Gulf relevance in 5.1 has to come from Maistro's own judgement plus the keywords/Google-Trends AE+SA lanes if we pull them (not consumed today).
- Languages: `lang` en/mixed only on this board; Arabic trend detection is not evidenced in the feed.

## 5. Signals: present, derived, missing

| Signal the framework (5.1) wants | Status |
|---|---|
| Views | `viewsWk` sampled 7-day sum (28/38); per-clip `views` on ≤ 6 clips |
| Posts count / creators count | **missing** from the feed (the ledger has sampled creators; not projected) |
| Growth / velocity | `growth` %/day (38/38), string |
| Acceleration | **missing** (producer measures it; not projected) |
| Lifecycle stage | coarse board stage (3 values) + `durabilityClass`; finer measured stage **not projected** |
| Age / first seen | `tracked.firstSeenAt` + `runsSeen` in the raw file (29/38); Trend Radar's first observation, not platform origin |
| Sound usage and licensing | `sound.musicId`, TikTok's `commercialUse.cleared` (29/38) |
| Hashtags | `tags` 9/38 |
| Example posts | `clips` (6/trend) |
| Region | `scope` only (global/local) |
| Brand safety verdict | folded into `onBrand` (brandSafe is part of the gate) but **not exposed separately**; a trend can fail the gate for weak fit, not for safety — Maistro cannot tell which from the feed |
| Competitor saturation | **missing** (a competitor lane exists upstream; not projected) |

Consequences for 5.1: momentum and timing must be computed by Maistro from its own snapshot history (§6); Gulf relevance, audience fit and saturation have no upstream signal and will be LLM judgements with explicit low confidence until data exists; the safety veto must be Maistro's own (the upstream gate conflates safety with fit).

## 6. Snapshot history — what Trend Radar's git history already shows

Reconstructed from the daily data commits of `trends.generated.json` (2026-09-18 → 2026-10-21, 40 commits; the 2026-10-20 commit is the one-trend collapse, 2026-10-01 to 10-05 are a 12-trend plateau from a different incident):

- Board size per day: 27 → 60 (late September) → 12 (early October plateau) → 28–39 (October).
- 133 distinct trend ids over the period. Days on board: 24 ids seen on one day only, 31 for 2–5 days, 50 for 6–15 days, 15 for 16–37 days. The median trend stays about a week; a quarter are one-day visitors.
- This is enough to **define** lifecycle math (first seen, last seen, days on board, stage transitions) but the upstream board stage is too coarse (peaking/mature) to validate "emerging/rising/declining" against it. Maistro's own snapshots (below) must capture `growth`, `eng`, `viewsWk`, `fit`, `signalStrength`, `onBrand` and the raw record per trend per fetch so velocity and acceleration are computed in code over time.

## 7. Robustness today (Maistro side)

- Validation: every agent trend is normalised by `normalizeAgent` with typed defaults; malformed records become `null` fields, not crashes. **Gap:** there is no per-record schema that *rejects and logs* a malformed trend (5.0 asks for one) — to add with the snapshot writer.
- Structural change detection: the scrape path throws on a missing flight payload; the agent path throws on a missing `trends` array; both surface as `cache.stale` with the reason once a cached board exists, and the page shows FEED UNREACHABLE / STALE. **Gap:** no alert beyond the UI state (ops phase).
- Rate and caching: one upstream read per hour at most (`trends_cache`, hourly cron); 20 s timeout, 1 retry; well under the 60/min limit.
- Freshness: `boardGeneratedAt` drives the STALE pill (> 36 h) and the header time on the page.

## 8. Decisions proposed for 5.1 (to agree with the owner)

1. Treat the feed as TikTok-only evidence; Instagram claims require the IG lane to produce board rows.
2. Maistro keeps its own per-trend, per-fetch snapshots (`trend_snapshots`, written by the hourly refresh) and computes velocity, acceleration, age and days-on-board in code from them.
3. The safety veto is Maistro's own (an explicit, separate verdict with reasons), not inferred from `onBrand`.
4. Sound clearance: `commercialUse.cleared === true` is a positive signal, `false` a veto candidate, `null` "unknown — verify in the business account" shown as such.
5. Fields never populated on the current board (`format`, `tags` mostly, `seasonal`) are not relied upon.
