"""Postability rules engine tests (docs/POSTABILITY.md).

Strict mode is in force (NullNormalizer): fixable issues escalate to
blockers with an explicit hint — these tests pin that behavior so swapping
in FfmpegNormalizer later is a visible, deliberate change."""

from maistro.gate.rules import BriefConstraints, GateProbe, RulesEngine
from maistro.generated.entities.validation_report import Class, Status

ENGINE = RulesEngine()


def probe(**overrides: object) -> GateProbe:
    base = {
        "container": "mp4",
        "video_codec": "h264",
        "audio_codec": "aac",
        "duration_s": 14.0,
        "width": 1080,
        "height": 1920,
        "fps": 30.0,
        "vfr": False,
        "rotation": 0,
        "hdr": False,
        "bitrate_kbps": 8000,
        "sha256": "a" * 64,
        "size_bytes": 40_000_000,
    }
    base.update(overrides)
    return GateProbe.model_validate(base)


def test_conformant_video_is_postable() -> None:
    report = ENGINE.evaluate(probe(), "video", ["tiktok"])
    assert report.status == Status.postable
    assert report.issues == []
    assert report.final is not None


def test_strict_mode_escalates_fixable_to_blocker() -> None:
    report = ENGINE.evaluate(probe(video_codec="hevc"), "video", ["x"])
    assert report.status == Status.rejected
    issue = next(i for i in report.issues if i.code == "codec.video_unsupported")
    assert issue.class_ == Class.blocker
    assert "auto-fix not yet available" in (issue.fix_hint or "")


def test_strictest_union_across_targets() -> None:
    # 200s is fine for TikTok (600s cap) but a blocker once X (140s) joins.
    long_video = probe(duration_s=200.0)
    assert ENGINE.evaluate(long_video, "video", ["tiktok"]).status == Status.postable
    report = ENGINE.evaluate(long_video, "video", ["tiktok", "x"])
    assert report.status == Status.rejected
    issue = next(i for i in report.issues if i.code == "duration.above_max")
    assert issue.platforms == ["x"]


def test_hdr_is_a_warning_not_silently_fixed() -> None:
    report = ENGINE.evaluate(probe(hdr=True), "video", ["tiktok"])
    assert report.status == Status.postable  # warnings don't block
    issue = next(i for i in report.issues if i.code == "codec.hdr_color")
    assert issue.class_ == Class.warning


def test_rotation_metadata_flagged() -> None:
    report = ENGINE.evaluate(probe(rotation=90), "video", ["tiktok"])
    assert any(i.code == "integrity.rotation_metadata" for i in report.issues)


def test_brief_duration_cap_is_a_blocker() -> None:
    report = ENGINE.evaluate(
        probe(duration_s=22.0),
        "video",
        ["tiktok"],
        brief=BriefConstraints(duration_cap_s=15.0),
    )
    assert report.status == Status.rejected
    assert any(i.code == "brief.duration_over_cap" for i in report.issues)


def test_sound_led_brief_requires_audio() -> None:
    report = ENGINE.evaluate(
        probe(audio_codec=None),
        "video",
        ["tiktok"],
        brief=BriefConstraints(requires_audio=True),
    )
    assert report.status == Status.rejected
    assert any(i.code == "brief.audio_required" for i in report.issues)


def test_instagram_image_rules() -> None:
    jpeg = probe(container="jpg", video_codec=None, audio_codec=None, duration_s=None)
    oversized = jpeg.model_copy(update={"size_bytes": 9_000_000, "width": 1080, "height": 1350})
    report = ENGINE.evaluate(oversized, "image", ["instagram"])
    assert report.status == Status.rejected
    assert any(i.code == "size.above_max" for i in report.issues)
    # PNG on IG is a blocker — silent conversion would break score-what-you-post.
    png = jpeg.model_copy(update={"container": "png"})
    report2 = ENGINE.evaluate(png, "image", ["instagram"])
    assert any(i.code == "codec.image_format_unsupported" for i in report2.issues)


def test_resolution_below_minimum_blocks() -> None:
    report = ENGINE.evaluate(probe(width=480, height=854), "video", ["tiktok"])
    assert report.status == Status.rejected
    assert any(i.code == "resolution.below_min" for i in report.issues)
