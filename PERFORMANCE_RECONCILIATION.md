# PERFORMANCE_RECONCILIATION — 7.0 data accuracy: method, checks, and what runs where

Phase 7.0 working document, 2026-10-21 (feeds `PERFORMANCE_INSIGHTS.md` at the end of Phase 7). Sources: `demo-ui/api/_handlers/track.js` (the live read), `demo-ui/api/_handlers/sentiment.js` (the daily snapshot), `demo-ui/index.html` (`sentiCompose`, `sentiDedupe`, `sentiFoldAcross`, `pfPosts`, `pfStats`), the tracker's own dashboard route `D:\SamsungSentiment\app\api\dashboard\data\route.ts`, its sync `lib/apify-sync.ts`, and the recorded fixtures in `demo-ui/tests/fixtures/`. No tracker query was run from this machine (the tracker key lives only in Vercel; constraint 6 keeps the tracker read-only).

## 1. The two systems being reconciled

| | Tracker dashboard (samsungtrack) | Maistro Performance page |
|---|---|---|
| Source tables | `social_posts`, `social_comments` (live columns: `external_id`, `published_at`, `views_count`, `likes_count`, `comments_count`, `shares_count`, `caption`, `media_type`, `post_url`, `raw_data`; comments: `external_post_id`, `text`, `author_username`, `sentiment`, `likes_count`, `published_at`) — the repo's `scripts/001_*.sql` still shows the original names (`post_id`, `publish_date`, `comment_text`); the live schema is what both readers select | same tables, read through PostgREST with the tracker's key (`track.js`) plus Maistro's own `sentiment_posts` snapshot (`sentiment.js`) |
| Post population | **all** rows, `select *`, ordered by `published_at` desc (`route.ts:70–80`) — no account filter, no window | **Samsung-owned accounts only**, decided in SQL per platform (`PLATFORM_FILTERS`, `track.js:92–95`: Instagram by `raw_data->>ownerUsername ilike *samsung*`, TikTok/Facebook/X by `post_url` or the author field), window `published_at ≥ now − N days` (N = 14 first, then 60; max 90), keyset-paged 1000 per page, up to 5 pages per platform |
| Comment population | all rows | `published_at ≥ now − (N+3) days`, excluding `external_id` prefixes `unpacked_`, `roster_`, `ifold_` (other corpora in the same table), up to 80 pages; matched to posts through every alias form (`postAliases`/`resolvePost`, `track.js:150–190`: external id, short code ↔ numeric id for Instagram, numeric ids in URLs for TikTok/Facebook) |
| Twin comments | none (stores both copies from different scrapers) | collapsed on `author_username + normalised text` **within a post** (`dedupeTwins`, keeps the analysed then most-liked then earliest copy; golden 402 → 374 rows); the page folds again **across posts** for the alerts and drill-downs only |
| Totals | `posts.length`, `comments.length` over everything (`route.ts:134–135`) | `pfStats`: posts in the filtered list, `views` = Σ `metrics.views`, `cmts` = Σ `metrics.comments` (**the tracker's `comments_count` column, not the matched comments**), `pos/neu/neg` over matched+deduped comments, `posRate`, `avgEr` (mean of per-post `er` = (likes+comments+shares)/views) |
| Sentiment | stored label; unlabelled = none | stored label, else the ported lexicon (`lexSentiment`, `track.js:43–63`) |
| Time | server local | display Asia/Dubai (`fmtTz`), **window filter relative to now** (`pfPosts`: `now − postedAt ≤ days·86400 s`), not calendar days in any zone |
| Snapshot merge | n/a | `sentiCompose`: live read wins; the snapshot (`/api/sentiment`, latest row per `post_id`) fills comments and thumbnails the live read lacks and **appends posts the live read did not return** |

So the tracker's totals and Maistro's totals are **not the same quantity by design** (account filter, window, twins, corpora exclusion). Reconciliation therefore means: for the same definition, the two readers of the same rows must agree exactly; and for each place where Maistro's definition differs from the tracker's, the difference must be explainable row by row.

## 2. Checks (each is a computed number with a tolerance of zero)

| # | Check | How | Expected |
|---|---|---|---|
| R-1 | **Post count per platform in the window** | Maistro: rows returned by `readWindow(N)` per platform. DB: `HEAD social_posts?<same filter>&published_at=gte.<same since>` with `Prefer: count=exact` | equal. A difference means paging truncation (5 × 1000 cap) or a filter that the DB and the reader evaluate differently |
| R-2 | **Σ views / likes / comments_count / shares per platform** | Maistro: sums over the returned rows. DB: same rows re-read with only the four columns (no RPC available for `sum` without a function; PostgREST aggregates need the tracker to enable them — not ours to change) | equal; proves no row is counted twice after the per-platform keyset paging |
| R-3 | **Raw comments in the comment window** | Maistro: `commentsSeen`. DB: `HEAD social_comments?published_at=gte.<floor>&<exclusions>` count=exact | equal unless `commentsPartial` (then the response is `no-store` and the page shows the data-age pill; this check records the shortfall) |
| R-4 | **Matched comments** | Maistro: `commentsMatched`. DB (lower bound): `HEAD social_comments?external_post_id=in.(<canonical post ids>)&published_at=gte.<floor>` | DB ≤ Maistro; the gap is exactly the alias-resolved matches (short-code / numeric / URL forms), reported as a count so a regression in alias logic shows as a drop |
| R-5 | **Twin collapse** | per post: raw matched − deduped = twins removed; golden fixture `twin-rows.json` (402 → 374) locks the rule; a labelled sample (7.0 asks for false merges / missed duplicates) is a human task — proposed sample: 200 comment pairs from one 14-day window, labelled by the owner, scored by the same function | false-merge rate and miss rate reported with the sample size; the rule changes only if a measured improvement beats it |
| R-6 | **Snapshot vs live double counting** | `sentiCompose` keys posts by `sentiId(p)`; a post present in both must appear once; comments are replaced, not concatenated, when the live read has any | posts unique by id in `SENTI.posts`; comments per post = max(live, snapshot), never the sum. Test: `tests/page/performance.test.js` "golden merge" |
| R-7 | **Window boundaries** | posts whose `published_at` lies within ±24 h of the `since` boundary are listed; the page filter (`now − postedAt ≤ N days`) is compared against a calendar-day filter in Asia/Dubai and in UTC | the three counts are reported side by side; today the page uses the rolling rule (documented); a calendar rule is a product decision for 7.1 |
| R-8 | **Display totals = computed totals** | `pfStats(list)` on the served `/api/track` payload must equal the server-side computation of the same formulas on the same rows | equal (same code path on the same data; a harness test already does this with `track-14d.json`) |
| R-9 | **Comment-ingestion freshness** | newest `published_at` per platform among matched comments vs now | shown as the DATA AS OF / STALE pill (> 48 h); reported per platform so the TikTok stall of Sep 27 (fixed upstream 2026-10-21) is visible per source |

## 3. Where it runs

The tracker key exists only in Vercel's production environment, so reconciliation runs **inside the deployed function**: `GET /api/track?reconcile=1&days=N` (ingest-key bearer or cron) performs one `readWindow(N)` and the DB counts of R-1, R-3, R-4 and R-7 in the same invocation, computes R-2 and R-8 on the rows it holds, and returns a JSON report (no page data, no caching). The report is also what Phase 12's monitoring will alert on. It never writes to the tracker.

Until the owner decides the release policy of the expanded mandate, the endpoint is code and tests on the branch (recorded PostgREST responses with `content-range` counts); the first production run needs a deploy. Previews cannot run it (no preview environment variables until the repository is git-connected).

## 4. Known definitional differences to settle in 7.1

1. `cmts` on the KPI deck is the tracker's `comments_count` (platform total), while the sentiment KPIs use the matched comments; the two can differ by thousands for a viral post. Label both, or switch the deck to matched comments.
2. The rolling window (`now − N days`) versus Gulf calendar days: a post from 23:30 GST yesterday is "today" under neither rule but counts differently at the 7-day edge.
3. Engagement rate = (likes + comments + shares) / views, averaged per post; the tracker stores its own `engagement_rate` column (`DECIMAL(5,2)`) with an unknown formula — reconcile or stop showing one of them.
4. Posts the live read did not return but the snapshot has (merge rule "append") are mostly posts that fell out of the window; they should be labelled or excluded, not silently appended.
