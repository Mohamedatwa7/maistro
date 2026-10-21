# CONTENT_STUDIO — stage specs, schemas, checks (Phase 6, in progress)

Living document for Phase 6. Started 2026-10-21 with the 6.0 verification (`HIGGSFIELD.md`) and the 6.1 foundations below; the stage sections (6.2–6.8) are added as each stage is rebuilt and evaluated (6.10). Under the owner's delegated gate, defaults are the builder's and marked for the owner to amend.

## 6.1 Shared foundations — what exists now

| Foundation | Where | State |
|---|---|---|
| 1. Brand Knowledge Base | `kb_documents` kind `brand_kb` (keys `persona`, `essence`, `colors`, `imagery`, `voice`, `do_dont`, `approved_examples`); seed in `demo-ui/api/_kb/seed.js` | Versioned, editable (`PUT /api/kb`, admin), read by every hermes/director prompt on each call. Content distilled from the Samsung Brand Creative Playbook (Apr 2026) as already used in production, plus the playbook's voice DO/DON'T examples and colour/gradient rules. **Gaps the owner must fill:** mandatory legal disclaimers by claim type and market; logo usage (clear space, minimum size, end card); the overlay typeface; approved example pieces. |
| 2. Product Catalog | kind `product_catalog`, one document per device (`Galaxy Z Fold8` …) plus `_candidates` | The 2026 lineup with its catalog "look" line and the mention count in the brand's own captions (2026-09-25 → 10-20: Fold8 31, The Frame 17, Buds4 Pro 10, Tab S12 7, Laundry Combo 6, Watch9 4). **Null until the owner supplies them:** official per-market names, reference images per angle, colour names, key features, approved claims with exact wording, specs, availability and launch dates. Hashtag evidence for three devices not in the catalog (Watch Ultra2, Z Fold8 Ultra, Tab S12 Ultra) is listed under `_candidates` for confirmation. The rule "any product shown must resolve to a catalog entry" is enforced for trends (judge caps) and will be enforced per stage as each stage is rebuilt. |
| 3. Market and Cultural Context | kind `market_context`, key `gcc` | Builder defaults (dress, alcohol/gambling, gender representation, Ramadan rules, language plan) with the calendar in `api/_trends/signals.js`. **Gap:** per-market differences and Samsung launch windows. |
| 4. Platform Specs | kind `platform_specs` (`tiktok`, `instagram_reels`, `instagram_feed`, `instagram_stories`) | Consensus of third-party spec guides, each marked `verified:false` because no official TikTok Business Help Center or Meta Help Center page could be fetched. **Owner or a later fetch must verify** before the assembly step (6.6) relies on them; loudness targets are unknown. |
| 5. Creative Spec | table `creative_specs` (per piece, versioned JSON) | Schema and writer land with 6.1 (b): linked trend and angle, platforms, markets, languages, catalog products, objective, and the approved output of every stage with version history. |
| 6. Prompt Registry | table `prompt_registry` | 6.1 (b): every Claude and Higgsfield template stored with version, variables and change date; the trend judge already carries `profile-v1.1`; director/hermes templates are registered next. |
| 7. Generation Record | table `generation_records` | 6.1 (b): one row per model or render call (prompt version, resolved prompt, params, seed, assets, status, latency, cost, usage, member, correlation id); the job service and the generation handlers write it. |
| 8. Structured Rejection Reasons | kind `rejection_taxonomy`, key `v1` | Fixed codes per stage plus free text; the Production Center's reject modal switches to it in 6.1 (b). |

## Open owner inputs (collected from the seed's `gaps`)

1. Disclaimers by claim type and market; logo and end-card rules; overlay typeface.
2. Catalog facts per device: official names per market, reference images, colours, features, approved claims, specs, availability.
3. Confirm or discard the three hashtag-only device names.
4. Per-market cultural differences; Samsung launch windows per year.
5. Verify the platform specs against the official help centers (or allow a fetch of the official pages).
