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

## 6.2 Moodboard — what ships (and a correction from verification)

- Visual direction: schema-validated structure from Claude (`api/_studio/mood.js`, prompt `mood-direction-v1`), palette hexes from the brand KB, the catalog look line as the only product fact, four tile briefs, competitor names rejected.
- The rendered set: ONE Soul V2 job with `batch_size 4`. **Correction (checker finding, 2026-10-21):** a Soul batch renders one prompt as variations, so the set is now rendered from a direction-level `setPrompt()` (setting, product when in the catalog, lighting, styling, palette) and every image is tagged `variation n` with `setMode: 'variations'` on the artifact. The earlier build rendered tile 1's prompt four times while tagging the images with tiles 1–4 and holding only "product" tiles to the product check — the tags claimed facets that were never asked for. The four tile briefs stay on the direction as text for the human. One job per tile (four submits) remains an option if the owner wants one image per facet.
- The product is expected in every variation exactly when the catalog has a look line (`meta.expectProduct`, explicit on the job); the vision check (`vision-check-v1.1`) stores a `stage_checks` row per set.
- Ops fixes from verification: the `vision_check` claim window is 150 s (above the 90 s call bound, so a second tick cannot re-claim a running check) and the job is patched to `running` before the call; vision `max_tokens` 8000; studio default model `claude-opus-5-5` (`MAISTRO_STUDIO_MODEL`).

## 6.3 Thumbnail — what ships

| Decision | What | Why |
|---|---|---|
| Position | Stage slot 2 (after the moodboard, before the brief/storyboard) | The cover must continue the approved direction; the storyboard does not change it. Order to be revisited with evidence from 6.10. |
| Inputs | `moodContext()` reads the mood stage's current version, its `direction`, and the approval's `details.selectedImages` + `annotations` (unselected tiles are dropped); the official product photo goes through the Higgsfield v1 `image_reference` path (`refImage`); the catalog look line is the only text about the device | The thumbnail inherits exactly what the reviewer approved, and the device is never re-described |
| Prompt | `thumb-prompt-v1` (`api/_studio/thumb.js`): one key visual, moodboard palette by hex, reserves clean negative space on one side (`textSide`); validation rejects competitor names and any request for text inside the image (≤110 words) | Text rendered by the image model is wrong for Arabic and unversionable |
| Aspect | `aspectFor(platforms)`: 9:16 unless a landscape platform (YouTube, X, Facebook) is targeted; `1152x2048` on Soul | TikTok/Reels covers are vertical. 4:5/1:1 for the Instagram feed is a follow-up once the feed is a selectable placement. |
| Headline | Entered in the Studio (English + optional Arabic), overlaid by code inside `overlayBox()` = the safe zone (9:16: top 13 %, bottom 34 %, sides 6 % — the conservative union of the TikTok in-feed and Reels templates; 16:9/1:1: 8/12/6 %); the preview is drawn on the page, the composite is drawn on a canvas in the browser (correct Arabic shaping, RTL) | Arabic shaping needs a real text engine; the safe zone keeps the headline out of the platform chrome |
| Stored artifact | `action: 'thumb-composite'` uploads the composited PNG to the private `assets` bucket (`putBlob`, sha256 + size recorded) and records it as a new **manual** version of the thumb stage with the overlay spec and `baseAssetPath` | The bytes the reviewer approves are the bytes in the bucket (checker requirement) |
| Checks | The vision check receives the selected mood tiles as ANCHOR images and the reserved side: `consistentWithMood` and `textSpaceClear` per image, flags `inconsistent with the moodboard` / `reserved text side is not clear`, plus the product-accuracy and safety questions | Consistency with the approved direction is judged against the actual approved pixels |
| Gate | 409 `prerequisites` when the piece has no moodboard version | No cover without a direction |

Open: 4:5/1:1 feed covers; typeface for the overlay (owner input 1); the composite is capped at 3 MB and PNG only.

## Open owner inputs (collected from the seed's `gaps`)

1. Disclaimers by claim type and market; logo and end-card rules; overlay typeface.
2. Catalog facts per device: official names per market, reference images, colours, features, approved claims, specs, availability.
3. Confirm or discard the three hashtag-only device names.
4. Per-market cultural differences; Samsung launch windows per year.
5. Verify the platform specs against the official help centers (or allow a fetch of the official pages).
