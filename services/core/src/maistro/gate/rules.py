"""Postability rules engine (docs/POSTABILITY.md stages 2-3).

Pure logic: a GateProbe (however obtained — ffprobe in production, literal in
tests) is evaluated against the STRICTEST UNION of platform rules for the
campaign's publish targets plus brief-derived rules, producing a
contract-typed ValidationReport."""

from __future__ import annotations

from fractions import Fraction
from pathlib import Path
from typing import Any, Protocol

import yaml
from pydantic import BaseModel

from maistro.generated.entities.validation_report import (
    CheckedAgainst,
    Class,
    Issue,
    Platform,
    Probe,
    Status,
    ValidationReport,
)

RULES_PATH = (
    Path(__file__).resolve().parents[5] / "packages" / "contracts" / "publishing-rules.yaml"
)

# Codec/format aliases: ffprobe names -> rules-file names.
_CODEC_ALIASES = {"avc1": "h264", "h265": "hevc", "mjpeg": "jpeg"}


class GateProbe(BaseModel):
    """Technical facts about an asset (POSTABILITY.md stage 2)."""

    container: str
    video_codec: str | None = None
    audio_codec: str | None = None
    duration_s: float | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    vfr: bool | None = None
    rotation: int | None = None
    hdr: bool | None = None
    bitrate_kbps: float | None = None
    audio_sample_rate: int | None = None
    sha256: str
    size_bytes: int


class BriefConstraints(BaseModel):
    """Brief-derived rules (POSTABILITY.md stage 3b)."""

    duration_cap_s: float | None = None
    requires_audio: bool = False


class Normalizer(Protocol):
    """Stage 4. NullNormalizer = strict mode; FfmpegNormalizer is next."""

    available: bool


class NullNormalizer:
    available = False


def _ratio(text: str) -> float:
    if ":" in text:
        num, den = text.split(":")
        return float(Fraction(float(num) / float(den)).limit_denominator(10000))
    return float(text)


def _norm_codec(codec: str | None) -> str | None:
    if codec is None:
        return None
    lowered = codec.lower()
    return _CODEC_ALIASES.get(lowered, lowered)


class RulesEngine:
    def __init__(self, rules_path: Path = RULES_PATH, normalizer: Normalizer | None = None):
        raw = yaml.safe_load(rules_path.read_text(encoding="utf-8"))
        self.rules_version: str = raw["rules_version"]
        self._video_rules: dict[str, dict[str, Any]] = raw.get("video", {})
        self._image_rules: dict[str, dict[str, Any]] = raw.get("image", {})
        self._normalizer = normalizer or NullNormalizer()

    def evaluate(
        self,
        probe: GateProbe,
        media_type: str,
        platforms: list[str],
        brief: BriefConstraints | None = None,
        brief_id: Any | None = None,
    ) -> ValidationReport:
        issues: list[Issue] = []
        rules = self._video_rules if media_type == "video" else self._image_rules
        for platform in platforms:
            platform_rules = rules.get(platform)
            if platform_rules is None:
                continue
            if media_type == "video":
                issues.extend(self._check_video(probe, platform, platform_rules))
            else:
                issues.extend(self._check_image(probe, platform, platform_rules))
        if brief is not None:
            issues.extend(self._check_brief(probe, media_type, brief))

        if not self._normalizer.available:
            # Strict mode (docs/POSTABILITY.md): without a normalization
            # pipeline, fixable issues become creator-actionable blockers —
            # never silently waved through.
            issues = [
                issue.model_copy(
                    update={
                        "class_": Class.blocker,
                        "fix_hint": (issue.fix_hint or "")
                        + " [auto-fix not yet available — export to spec directly]",
                    }
                )
                if issue.class_ == Class.fixable
                else issue
                for issue in issues
            ]

        has_blocker = any(i.class_ == Class.blocker for i in issues)
        has_fix = any(i.class_ == Class.fixable for i in issues)
        status = (
            Status.rejected
            if has_blocker
            else Status.postable_after_fixes
            if has_fix
            else Status.postable
        )
        return ValidationReport(
            status=status,
            checked_against=CheckedAgainst(
                platforms=[Platform(p) for p in platforms],
                rules_version=self.rules_version,
                brief_id=brief_id,
            ),
            probe=Probe.model_validate(probe.model_dump()),
            issues=issues,
            normalization=None,
            final=probe.model_dump() if status != Status.rejected else None,
        )

    def _issue(
        self,
        code: str,
        klass: Class,
        detail: str,
        platform: str,
        fix_hint: str | None = None,
    ) -> Issue:
        return Issue(
            code=code,
            class_=klass,
            detail=detail,
            fix_hint=fix_hint,
            platforms=[platform],
            auto_fixed=False,
        )

    def _check_video(  # noqa: C901 - explicit rule-by-rule checks, kept flat on purpose
        self, probe: GateProbe, platform: str, r: dict[str, Any]
    ) -> list[Issue]:
        issues: list[Issue] = []
        if probe.container.lower() not in r.get("containers", [probe.container.lower()]):
            issues.append(
                self._issue(
                    "codec.container_unsupported",
                    Class.fixable,
                    f"container '{probe.container}' not accepted by {platform}; remux to mp4",
                    platform,
                )
            )
        codec = _norm_codec(probe.video_codec)
        if codec is not None and codec not in r.get("video_codecs", [codec]):
            issues.append(
                self._issue(
                    "codec.video_unsupported",
                    Class.fixable,
                    f"video codec '{codec}' not accepted by {platform}; transcode to h264",
                    platform,
                )
            )
        audio = _norm_codec(probe.audio_codec)
        if audio is not None and audio not in r.get("audio_codecs", [audio]):
            issues.append(
                self._issue(
                    "audio.codec_unsupported",
                    Class.fixable,
                    f"audio codec '{audio}' not accepted by {platform}; transcode to aac",
                    platform,
                )
            )
        duration = r.get("duration_s", {})
        if probe.duration_s is not None:
            if "max" in duration and probe.duration_s > duration["max"]:
                issues.append(
                    self._issue(
                        "duration.above_max",
                        Class.blocker,
                        f"{probe.duration_s:.1f}s exceeds {platform} max {duration['max']}s",
                        platform,
                        fix_hint=f"re-edit to <= {duration['max']}s — we never trim silently",
                    )
                )
            if "min" in duration and probe.duration_s < duration["min"]:
                issues.append(
                    self._issue(
                        "duration.below_min",
                        Class.blocker,
                        f"{probe.duration_s:.1f}s is under {platform} minimum {duration['min']}s",
                        platform,
                        fix_hint=f"extend to >= {duration['min']}s",
                    )
                )
        size = r.get("size_bytes", {})
        if "max" in size and probe.size_bytes > size["max"]:
            issues.append(
                self._issue(
                    "size.above_max",
                    Class.fixable,
                    f"{probe.size_bytes} bytes exceeds {platform} max {size['max']}; "
                    "re-encode at lower bitrate",
                    platform,
                )
            )
        fps = r.get("fps", {})
        if probe.fps is not None:
            if "max" in fps and probe.fps > fps["max"]:
                issues.append(
                    self._issue(
                        "resolution.fps_above_max",
                        Class.fixable,
                        f"{probe.fps:.0f}fps exceeds {platform} max {fps['max']}",
                        platform,
                    )
                )
            if "min" in fps and probe.fps < fps["min"]:
                issues.append(
                    self._issue(
                        "resolution.fps_below_min",
                        Class.blocker,
                        f"{probe.fps:.0f}fps is under {platform} minimum {fps['min']}",
                        platform,
                        fix_hint="re-export at a standard frame rate (24/30/60)",
                    )
                )
        resolution = r.get("resolution", {})
        if probe.width is not None and probe.height is not None:
            if probe.width < resolution.get("min_width", 0) or probe.height < resolution.get(
                "min_height", 0
            ):
                issues.append(
                    self._issue(
                        "resolution.below_min",
                        Class.blocker,
                        f"{probe.width}x{probe.height} below {platform} minimum",
                        platform,
                        fix_hint="re-export at >= 1080x1920 for vertical",
                    )
                )
            if probe.width > resolution.get("max_width", 10**6) or probe.height > resolution.get(
                "max_height", 10**6
            ):
                issues.append(
                    self._issue(
                        "resolution.above_max",
                        Class.fixable,
                        f"{probe.width}x{probe.height} exceeds {platform} maximum; downscale",
                        platform,
                    )
                )
        aspect = r.get("aspect", {})
        if (
            probe.width
            and probe.height
            and ("min" in aspect or "max" in aspect)
        ):
            ratio = probe.width / probe.height
            if ("min" in aspect and ratio < _ratio(str(aspect["min"]))) or (
                "max" in aspect and ratio > _ratio(str(aspect["max"]))
            ):
                issues.append(
                    self._issue(
                        "aspect.out_of_range",
                        Class.blocker,
                        f"aspect {probe.width}:{probe.height} outside {platform} accepted range",
                        platform,
                        fix_hint="reframe the edit — we never crop silently",
                    )
                )
        bitrate = r.get("bitrate_kbps", {})
        if (
            probe.bitrate_kbps is not None
            and "max" in bitrate
            and probe.bitrate_kbps > bitrate["max"]
        ):
            issues.append(
                self._issue(
                    "size.bitrate_above_max",
                    Class.fixable,
                    f"{probe.bitrate_kbps:.0f}kbps exceeds {platform} max {bitrate['max']}",
                    platform,
                )
            )
        if probe.rotation:
            issues.append(
                self._issue(
                    "integrity.rotation_metadata",
                    Class.fixable,
                    f"rotation metadata ({probe.rotation}°) — platforms disagree on honoring "
                    "it; bake into pixels",
                    platform,
                )
            )
        if probe.vfr:
            issues.append(
                self._issue(
                    "integrity.variable_frame_rate",
                    Class.fixable,
                    "variable frame rate; convert to constant",
                    platform,
                )
            )
        if probe.hdr:
            issues.append(
                self._issue(
                    "codec.hdr_color",
                    Class.warning,
                    "HDR/BT.2020 color — tone-mapping shifts brand colors; choose: "
                    "tonemap or re-export SDR",
                    platform,
                )
            )
        return issues

    def _check_image(self, probe: GateProbe, platform: str, r: dict[str, Any]) -> list[Issue]:
        issues: list[Issue] = []
        fmt = _norm_codec(probe.container)
        if fmt not in r.get("formats", [fmt]):
            # Silent server-side conversion would break score-what-you-post.
            issues.append(
                self._issue(
                    "codec.image_format_unsupported",
                    Class.blocker,
                    f"format '{fmt}' not accepted by {platform}",
                    platform,
                    fix_hint=f"export as {'/'.join(r.get('formats', []))}",
                )
            )
        size = r.get("size_bytes", {})
        if "max" in size and probe.size_bytes > size["max"]:
            issues.append(
                self._issue(
                    "size.above_max",
                    Class.blocker,
                    f"{probe.size_bytes} bytes exceeds {platform} max {size['max']}",
                    platform,
                    fix_hint="re-export at higher compression",
                )
            )
        aspect = r.get("aspect", {})
        if probe.width and probe.height and ("min" in aspect or "max" in aspect):
            ratio = probe.width / probe.height
            if ("min" in aspect and ratio < _ratio(str(aspect["min"]))) or (
                "max" in aspect and ratio > _ratio(str(aspect["max"]))
            ):
                issues.append(
                    self._issue(
                        "aspect.out_of_range",
                        Class.blocker,
                        f"aspect outside {platform} accepted range "
                        f"({aspect.get('min')}..{aspect.get('max')})",
                        platform,
                        fix_hint="reframe the export — we never crop silently",
                    )
                )
        resolution = r.get("resolution", {})
        if probe.width is not None and probe.width < resolution.get("min_width", 0):
            issues.append(
                self._issue(
                    "resolution.below_min",
                    Class.blocker,
                    f"width {probe.width}px below {platform} minimum "
                    f"{resolution['min_width']}px",
                    platform,
                    fix_hint="export at higher resolution",
                )
            )
        return issues

    def _check_brief(
        self, probe: GateProbe, media_type: str, brief: BriefConstraints
    ) -> list[Issue]:
        issues: list[Issue] = []
        if (
            brief.duration_cap_s is not None
            and probe.duration_s is not None
            and probe.duration_s > brief.duration_cap_s
        ):
            issues.append(
                Issue(
                    code="brief.duration_over_cap",
                    class_=Class.blocker,
                    detail=f"{probe.duration_s:.1f}s exceeds the brief's "
                    f"{brief.duration_cap_s:.0f}s cap",
                    fix_hint="re-edit to the brief's duration cap",
                    platforms=[],
                    auto_fixed=False,
                )
            )
        if brief.requires_audio and media_type == "video" and probe.audio_codec is None:
            issues.append(
                Issue(
                    code="brief.audio_required",
                    class_=Class.blocker,
                    detail="the brief is sound-led but the video has no audio track",
                    fix_hint="add the trend sound per the brief's sound_use",
                    platforms=[],
                    auto_fixed=False,
                )
            )
        return issues
