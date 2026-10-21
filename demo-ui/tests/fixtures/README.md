# Recorded fixtures

All fixtures were captured from the real systems on 2026-10-21 and trimmed; nothing is invented. Tests run against these only — never against kymah, Anthropic, Higgsfield, F1X8 or either Supabase.

| File | Source | Trim / anonymisation |
|---|---|---|
| `kymah-page.html` | `GET https://www.kymah.com/` after the board heal (38 trends on the board) | The `"trends"` array of the Next.js flight payload re-emitted as one `self.__next_f.push([1,"…"])` chunk, first 12 trends, ≤ 2 clips each, `spark/sources/examples/basis` dropped. Exercises `api/trends.js` `extractTrendStore()` exactly as production markup does. |
| `track-14d.json` | `GET https://www.ma1stro.com/api/track?days=14` | First 20 posts, ≤ 5 comments each; comment authors replaced by `user<i>_<j>`. |
| `sentiment-snapshot.json` | `GET https://www.ma1stro.com/api/sentiment` | First 10 posts, ≤ 5 comments each; authors replaced by `snap<i>_<j>`. Newest post 2026-10-08 — older than the page's 7-day window on purpose (documents AUDIT C-18). |
| `twin-rows.json` | comments of `GET /api/track?days=60` (before the twin collapse), mapped back to the tracker's row shape | 402 rows from posts with ≥ 4 comments; authors replaced by a deterministic md5-derived token so twins stay twins. The golden count (374 survivors) was frozen from `dedupeTwins` on 2026-10-21. |

Regenerate only when behaviour is meant to change, and update the frozen numbers in the tests in the same commit, stating why.
