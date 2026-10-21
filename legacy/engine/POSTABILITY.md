# The Postability Gate

**Version:** 1.0-draft · **Date:** 2026-09-04
**Parent:** [../ARCHITECTURE.md](../ARCHITECTURE.md) · Contracts: [CONTRACTS.md](CONTRACTS.md)

Every asset a creator submits passes a deterministic validation + normalization
pipeline **before** it is scored, so that by the time content reaches the
approval gate it is *guaranteed technically postable* on every platform the
campaign targets. No approved asset can ever bounce off a platform for
technical reasons (codec, duration, size, aspect), and nothing the platforms
receive differs from what was scored and approved.

## The core invariant

> **Score-what-you-post:** the bytes that F1X8 scores == the bytes the
> approver approves == the bytes that get posted. SHA-256-verified at every
> hop.

This forces the pipeline order: **normalize first, then score.** If the gate
transcodes or remuxes anything, the *normalized* artifact becomes the content
version — the original upload is retained for forensics but never scored or
posted.

## Where the gate runs

Inside the `submit_draft` handler, **before** the graph resumes — a file that
fails the gate never becomes a content version, never consumes an iteration,
and never wakes the graph. The creator gets the rejection (with exact fixes)
as the direct response to their submission.

```
submit_draft(brief_id, asset)
      │
      ▼
┌─ 1 INGEST ────────────────────────────────────────────────┐
│ URL mode: server-side download, Content-Length check,     │
│ 3 retries. Upload mode: pre-signed PUT already landed.    │
│ → SHA-256 computed; duplicate of an existing iteration    │
│   detected here (friendly "identical to iteration N").    │
└──────────────┬────────────────────────────────────────────┘
               ▼
┌─ 2 INTEGRITY PROBE (ffprobe / image decode) ──────────────┐
│ • MIME sniffed from magic bytes — extension is ignored    │
│ • file fully parses; video: every stream decodable,       │
│   duration readable, no truncation (moov atom present)    │
│ • extract: container, video codec, audio codec, duration, │
│   width×height, rotation metadata, fps (VFR detected),    │
│   bitrate, pixel format / HDR, audio sample rate/channels │
└──────────────┬────────────────────────────────────────────┘
               ▼
┌─ 3 RULES CHECK ───────────────────────────────────────────┐
│ Probe results evaluated against the UNION of:             │
│ a) platform rules for every platform in                   │
│    campaign.publish_targets (publishing-rules.yaml)       │
│ b) brief rules: durationCap from the Brief, expected      │
│    aspect from Brief.format, audio-required when the      │
│    Brief is sound-led                                     │
│ Each violation classified: BLOCKER / FIXABLE / WARNING    │
└──────────────┬────────────────────────────────────────────┘
               ▼
      any BLOCKER? ──yes──► 422 asset_invalid + full report
               │no                 (graph never woke; nothing stored
               ▼                    as a content version)
┌─ 4 NORMALIZE (only if FIXABLE issues exist) ──────────────┐
│ Deterministic ffmpeg plan, applied in one pass:           │
│ • remux to mp4 + faststart (moov to front)                │
│ • audio → AAC 48 kHz stereo                               │
│ • H.265/VP9 → H.264 (when a target requires H.264)        │
│ • bake rotation metadata into pixels (the #1 phone-video  │
│   gotcha — platforms disagree on honoring rotation tags)  │
│ • VFR → CFR at the measured average fps                   │
│ • downscale above platform max (e.g. 4K → 1080×1920)      │
│ • cap bitrate at the strictest target's max               │
│ Runs async for large files: submit_draft returns          │
│ status "normalizing"; get_feedback reports completion.    │
│ Output re-probed and re-checked (stage 2+3) — a           │
│ normalization that doesn't converge is a BLOCKER.         │
└──────────────┬────────────────────────────────────────────┘
               ▼
┌─ 5 SEAL ──────────────────────────────────────────────────┐
│ Final artifact → campaign-assets bucket (immutable key    │
│ {campaign_id}/{iteration}/{sha256}.{ext}); original       │
│ retained at .../original/; ValidationReport stored on the │
│ content_versions row; graph resumes → score_asset.        │
└───────────────────────────────────────────────────────────┘
```

## Issue classification

| Class | Meaning | Examples | Outcome |
|---|---|---|---|
| **BLOCKER** | Only the creator can fix it — remaking, not re-encoding | Too long for a target even after trim tolerance; wrong orientation (16:9 for a 9:16 brief); resolution below platform minimum; missing audio on a sound-led brief; corrupt/truncated file | `422 asset_invalid`, per-issue `fix_hint`, nothing stored as a version |
| **FIXABLE** | Deterministic server-side transform, quality-preserving | Wrong container (mov→mp4); H.265 where H.264 required; non-AAC audio; rotation metadata; VFR; 4K oversize; missing faststart | Auto-normalized; every applied fix listed in the report (creator and approver both see what changed) |
| **WARNING** | Postable, but flagged | HDR/BT.2020 color (tone-mapping shifts brand colors — creator chooses: auto-tonemap or resubmit SDR); duration within 5% of a cap; bitrate near max; aspect accepted-but-not-recommended by a target | Proceeds; warnings surface in `get_feedback` and in the approver's view |

HDR is deliberately **not** silently auto-fixed: tone-mapping alters color on
brand content where Samsung blue is a hard rule. The report offers the choice
explicitly.

## The rules file — `packages/contracts/publishing-rules.yaml`

Rules are **data, not code**: per platform × media type, versioned in the
contracts package, loaded by the validator at startup. Platform limits change
(and API limits ≠ app limits — TikTok's API allows what the app UI doesn't and
vice versa), so:

> ⚠ **Every rule in the file carries `verified: <date>`. Seeded values are
> last-known as of 2026-09; re-verifying each against the platform's current
> API documentation is a named task before that platform's publishing (or
> manual posting reliance) goes live.** The nightly contract-test workflow is
> the model: when a rule is re-verified, bump the date; a rules file with any
> `verified` older than 90 days fails a CI freshness check once publishing is
> live.

Seeded highlights (full detail in the file):

| Target | Video | Duration | Size | Aspect / resolution |
|---|---|---|---|---|
| TikTok (API) | mp4/mov/webm, H.264/265, AAC | 3 s – 600 s | ≤ 4 GB | 9:16 rec., ≥ 540×960, 23–60 fps |
| IG Reels (Graph API) | mp4/mov, H.264, AAC | 3 s – 15 min | ≤ 1 GB | 9:16 rec., min width 540, ≤ 60 fps |
| Facebook video | mp4/mov, H.264, AAC | ≤ 240 min | ≤ 4 GB | flexible; 9:16 / 1:1 / 16:9 |
| X (API v2) | mp4, H.264, AAC | ≤ 140 s | ≤ 512 MB | 1:3 – 3:1, ≤ 1920×1200, ≤ 60 fps, ≤ 25 Mbps |
| IG image | JPEG (API converts others → forced BLOCKER for non-JPEG to keep bytes stable) | — | ≤ 8 MB | 4:5 – 1.91:1, width 320–1440 |
| X image | jpg/png/webp | — | ≤ 5 MB | — |

The validator always applies the **strictest union**: a campaign targeting
TikTok + X must satisfy both (so ≤ 140 s and ≤ 512 MB apply even though TikTok
alone allows more). `list_assigned_briefs` includes the effective merged
constraints so the creator knows the envelope *before* shooting, not at
submission — the brief itself states them under `format`.

## The ValidationReport contract

Stored on `content_versions.validation_report`, returned by `submit_draft` /
`get_feedback` / `check_asset`, shown in the approval queue. Schema:
`packages/contracts/schemas/validation-report.json`.

```jsonc
{
  "status": "postable | postable_after_fixes | rejected",
  "checked_against": { "platforms": ["tiktok", "x"], "rules_version": "2026.09", "brief_id": "…" },
  "probe": { "container": "mov", "video_codec": "hevc", "audio_codec": "aac",
             "duration_s": 14.8, "width": 3840, "height": 2160, "fps": 29.97,
             "vfr": false, "rotation": 90, "hdr": false, "bitrate_kbps": 44000,
             "sha256": "…", "size_bytes": 812345678 },
  "issues": [
    { "code": "codec.h265_not_universal", "class": "fixable",
      "detail": "HEVC not accepted by X; transcoding to H.264",
      "platforms": ["x"], "auto_fixed": true },
    { "code": "resolution.above_max", "class": "fixable",
      "detail": "3840x2160 exceeds 1080x1920 target; downscaling",
      "platforms": ["tiktok", "x"], "auto_fixed": true }
  ],
  "normalization": { "applied": ["transcode_h264", "downscale_1080x1920", "faststart", "bake_rotation"],
                     "output_sha256": "…", "output_size_bytes": 48123456 },
  "final": { "sha256": "…", "container": "mp4", "video_codec": "h264", "…": "…" }
}
```

Error codes are a stable, documented enum (`codec.*`, `duration.*`, `size.*`,
`aspect.*`, `resolution.*`, `audio.*`, `integrity.*`, `brief.*`) — the creator's
Claude can pattern-match them into plain-language guidance.

## Pre-flight for the creator: `check_asset`

A seventh MCP tool: `check_asset(brief_id, asset)` runs stages 1–3 (probe +
rules, **no** normalization, no storage, no graph interaction) and returns the
same ValidationReport. The creator can sanity-check an export before formally
submitting. Cheap (seconds), unlimited use, and it means rejections at
`submit_draft` become rare rather than routine.

## How this guarantees postability end-to-end

1. **At submission** — gate enforces the strictest union of target-platform
   rules + brief rules; only `postable`/`postable_after_fixes` artifacts
   become content versions.
2. **At scoring** — F1X8 receives the sealed, normalized artifact (so the
   score reflects the exact deliverable, including any downscale).
3. **At approval** — approver sees the ValidationReport alongside the score;
   the approval row pins the sealed artifact's `content_version_id`.
4. **At posting** (manual for now) — the operator's `record_publication` step
   serves the sealed file for download with its SHA-256; when automated
   publishing lands, the driver re-verifies the checksum before upload and
   re-runs the rules check against the *then-current* rules file (catching a
   platform limit that changed between approval and posting — that mismatch
   escalates rather than posts).
5. **Nothing mutates in between** — asset keys are content-addressed
   (`{sha256}.{ext}`) and the bucket policy forbids overwrite.

## Testing (added to the chaos/unit suites)

- Golden media fixtures: rotated phone video, VFR clip, HEVC 4K, mov
  container, truncated file, HDR clip, silent video against a sound-led
  brief, 141-second clip targeting X, 9 MB JPEG for IG — one fixture per
  error code, each asserting class + outcome.
- Normalization convergence: every FIXABLE fixture, after normalization,
  re-passes stages 2–3 clean.
- Determinism: same input → byte-identical normalized output (pinned ffmpeg
  version in the container image; ffmpeg version recorded in the report).
- Duplicate detection: same file twice → friendly dedup, no second version.
