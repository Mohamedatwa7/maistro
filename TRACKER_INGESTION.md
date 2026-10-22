# TRACKER_INGESTION — Phase 8c: why comments and posts stop arriving (diagnosis and fix plan)

Status 2026-10-22: **diagnosis only.** SamsungSentiment was read but not changed. The fix plan below needs the
owner's approval before anything changes in that repo, its Apify account or its database. Evidence comes from
three sources:
- the tracker's code (`D:\SamsungSentiment`, HEAD `39d2568`, local);
- its own public status routes, read at 2026-10-22 11:44 UTC: `GET /api/apify/status`, and `GET
  /api/apify/sync` without the cron secret, which returns status only and starts nothing;
- Maistro's reconciliation freshness check (R-9) and its 2026-10-22 reads.

## Findings

### F1 — Sentiment labels: 500 a day, newest first, last 30 days only
`lib/apify-sync.ts` `analyzeUnanalyzedComments(limit = 500)` (lines 1158–1213) runs after every sync:
- it selects comments with `sentiment_analyzed_at is null`, `published_at >= now − 30 days`, newest first, up to
  500;
- the code comment calls the older backlog "a one-off backfill, not the daily sync's job", and that backfill has
  not been run;
- the query does not exclude the other corpora sharing `social_comments` (ifold_ / unpacked_ / roster_), so
  Samsung Gulf comments compete with them for the 500.

**Evidence:** of the 60-day comments Maistro reads, the tracker labelled 96 % of those under 7 days old, 81 % at
7–14 days, 51 % at 14–30 days, and **30 % of those older than 30 days**. Overall, 1,975 were labelled and 4,092
were not (67 % unlabelled; Maistro read, 2026-10-22). Keyword sentiment, used for the rest, scored 43 / 100
(PERFORMANCE_INSIGHTS.md §3).

### F2 — X and Facebook posts stopped at 2026-10-16 while their scrapers "succeed" every day
**Evidence:**
- Maistro's freshness check (R-9, 2026-10-21): newest posts for X and Facebook are **2026-10-16**. TikTok and
  Instagram are 2026-10-20 or later.
- The 90-day read on 2026-10-22: 0 X and 0 Facebook posts published since 2026-10-20, against about 2 a day
  before that.
- At the same time, the scheduled scrapers have run and **SUCCEEDED** daily (`/api/apify/sync` status, last 3
  runs each): X `Fo9GoU5wC270BgcBr` at 00:15 on 10-20, 10-21 and 10-22; Facebook `KoJrdxJCTtpon81KY` at 04:00
  and 00:15 each day. Each run lasts under a minute.

**Why nothing notices:** `getLatestRuns()` reads only `status=SUCCEEDED` runs, and `syncTwitterPosts` /
`syncFacebookPosts` upsert whatever those datasets hold. A run that succeeds with an empty or stale dataset
leaves no trace. The sync log (`apify_sync_log`) records only an aggregate for `platform: all` (e.g. 3,196
processed on 10-22), never per platform, so one platform going quiet cannot be seen.

**Most likely cause, to confirm in the Apify console:** the two scrapers return no new items. The usual reasons
are a login wall or rate block on the source, an expired cookie or session input, or an input change such as a
date or "max posts" filter. Each run's dataset item count and log will show which. The run list does not carry
item counts and the tracker's routes do not expose datasets, so this report cannot settle it.

### F3 — The scheduled TikTok comments scraper has no successful runs
`SCHEDULED_ACTORS.tiktok` (`Zk4NL09KuDccV11Z4`, "TikTok COMMENTS scraper") returns **no** SUCCEEDED runs in the
status read. TikTok comments are still arriving (newest 2026-10-20 at R-9) through the URL-driven
`startCommentScrapes()` path and `syncLateComments`, so this actor is either dead weight or failing silently.
Either way it reads as healthy, because nothing reports a missing run.

### F4 — Facebook comments follow the posts
`facebookComments` (`us5srxAYnsrkgUv2v`) last succeeded on 2026-10-19. It is URL-driven: `startCommentScrapes()`
scrapes recent post URLs. With no Facebook posts after 10-16, it runs out of URLs. This follows from F2 and is not
a separate fault.

### F5 — The status routes are public and their counts are wrong
`GET /api/apify/status` and `GET /api/apify/sync` (without the cron secret) answer anyone:
- sync logs, actor ids and run ids;
- per-platform post and comment counts, read with an unbounded select that Supabase caps at 1,000 rows. They
  report `facebook: 1000 posts, 1000 comments` and nothing else, which is wrong.

There is no customer text, but it is operational detail and the numbers mislead.

## Fix plan (proposal — needs approval; nothing below has been done)

| # | Change | Where | Effort | Cost |
|---|---|---|---|---|
| P1 | **Confirm F2:** open the last runs of the X and Facebook scrapers in the Apify console; read the dataset item counts and the run logs (login wall? cookie? input filter?) and fix the input. | Apify account | 15 min | none |
| P2 | **A freshness alarm in the sync:** after each run, record per platform the newest `published_at` ingested and the item count. Mark the sync log `stale` when a platform's newest post is more than 48 h old, or when a SUCCEEDED run has 0 items. | `lib/apify-sync.ts`, `apify_sync_log` | half a day | none |
| P3 | **Remove or repair the dead TikTok comments actor** (F3), so the schedule only holds actors that produce data. | Apify schedule, `SCHEDULED_ACTORS` | 30 min | none |
| P4 | **Sentiment coverage:** exclude the other corpora from the brand sync's 500 cap (or give them their own); run the existing resumable backfill (`POST /api/analyze-sentiment/run`) for Samsung Gulf comments older than 30 days (about 4,000); estimate the LLM cost first. | `lib/apify-sync.ts`; one manual run | 1 h + run | paid, estimate before |
| P5 | **Sentiment prompt:** giveaway entries and bare product names are neutral (the tracker's main error, 12 of 34 neutrals called positive); add Arabic and Gulf examples; re-measure on `tests/fixtures/sentiment-audit-2026-10-22.json` after a native-speaker re-label. | `lib/sentiment.ts` | half a day | small |
| P6 | **Status routes:** put them behind the cron or an admin check, and count with `count: exact` (head request), not a capped select. | `app/api/apify/status`, `app/api/apify/sync` | 1 h | none |
| P7 | **Push** the already-committed `39d2568` (the Maistro read-back script sends the ingest key). | git push (deploys the tracker) | 1 min | none |

**What Maistro already does:** it flags X and Facebook as STALE (data older than 48 h) with "no recent data —
tracker last collected 2026-10-16". It shows "not analysed" instead of guessing sentiment, and warns when a
window's sentiment rests on less than 70 % of comments.
