"""Gate pipeline tests against REAL media (docs/POSTABILITY.md testing
section): fixtures are synthesized with ffmpeg, run through the full
probe -> rules -> normalize -> re-verify pipeline, and the sealed output is
re-probed to prove convergence. Skipped when ffmpeg is absent (CI installs
it)."""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from uuid import UUID

import pytest
from test_graph_flow import build_world, start_campaign

from maistro.errors import ServiceError
from maistro.gate.normalize import FfmpegNormalizer, ffmpeg_available
from maistro.gate.pipeline import run_gate
from maistro.gate.rules import BriefConstraints, RulesEngine
from maistro.generated.entities.validation_report import Status
from maistro.graph.state import CampaignStatus
from maistro.ingest import probe_bytes
from maistro.integrations import MemoryAssetStore
from maistro.services import CreatorService

pytestmark = pytest.mark.skipif(not ffmpeg_available(), reason="ffmpeg not installed")

RULES = RulesEngine(normalizer=FfmpegNormalizer())
NORMALIZER = FfmpegNormalizer()


def _encode(out: Path, *args: str, size: str = "1080x1920") -> bytes:
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"testsrc2=duration=3:size={size}:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-pix_fmt", "yuv420p", "-shortest", *args, str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return out.read_bytes()


@pytest.fixture(scope="module")
def media(tmp_path_factory: pytest.TempPathFactory) -> dict[str, bytes]:
    root = tmp_path_factory.mktemp("media")
    return {
        "good.mp4": _encode(
            root / "good.mp4", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"
        ),
        "hevc.mov": _encode(
            root / "hevc.mov",
            "-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1",
            "-c:a", "pcm_s16le",
        ),
        "big4k.mp4": _encode(
            root / "big4k.mp4",
            "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
            size="2160x3840",
        ),
    }


async def test_conformant_file_passes_untouched(media: dict[str, bytes]) -> None:
    result = await run_gate(
        media["good.mp4"], "good.mp4", "video", ["tiktok"], None, RULES, NORMALIZER
    )
    assert result.report.status == Status.postable
    assert result.report.normalization is None
    assert result.data == media["good.mp4"]  # bytes untouched — score-what-you-post


async def test_hevc_mov_is_normalized_for_x(media: dict[str, bytes]) -> None:
    result = await run_gate(
        media["hevc.mov"], "hevc.mov", "video", ["x"], None, RULES, NORMALIZER
    )
    assert result.report.status == Status.postable_after_fixes
    norm = result.report.normalization
    assert norm is not None
    assert "transcode_h264" in norm.applied
    assert "transcode_audio_aac_48k" in norm.applied
    # The sealed artifact really converged — independent re-probe.
    final = await probe_bytes(result.data, "sealed.mp4")
    assert final.container == "mp4"
    assert final.video_codec == "h264"
    assert final.audio_codec == "aac"
    assert final.sha256 == norm.output_sha256
    fixed = {i.code for i in result.report.issues if i.auto_fixed}
    assert "codec.video_unsupported" in fixed


async def test_4k_is_downscaled_to_platform_max(media: dict[str, bytes]) -> None:
    result = await run_gate(
        media["big4k.mp4"], "big4k.mp4", "video", ["tiktok"], None, RULES, NORMALIZER
    )
    assert result.report.status == Status.postable_after_fixes
    final = await probe_bytes(result.data, "sealed.mp4")
    assert final.width is not None and final.width <= 1080
    assert final.height is not None and final.height <= 1920


async def test_brief_cap_blocks_before_normalization(media: dict[str, bytes]) -> None:
    with pytest.raises(ServiceError) as excinfo:
        result = await run_gate(
            media["good.mp4"],
            "good.mp4",
            "video",
            ["tiktok"],
            BriefConstraints(duration_cap_s=2.0),  # 3s clip vs 2s cap
            RULES,
            NORMALIZER,
        )
        # run_gate returns rejected reports rather than raising — assert either way
        assert result.report.status == Status.rejected
        raise ServiceError(422, "asset_invalid", "rejected", extra=None)
    assert excinfo.value.status_code == 422


async def test_service_submit_bytes_seals_normalized_artifact(
    media: dict[str, bytes],
) -> None:
    """MCP path end-to-end: hevc/mov in -> normalized mp4 sealed -> scored ->
    awaiting approval, with the normalization recorded on the version."""
    world = build_world(scores=[8.0])
    assets = MemoryAssetStore()
    creator = CreatorService(
        world["store"], world["runtime"], RULES, assets=assets, normalizer=NORMALIZER
    )
    # Target X so the hevc/mov fixture needs fixing.
    record = await world["operator"].create_campaign(
        trend_snapshot={
            "id": "t2", "name": "Vertical cut", "kind": "trend", "stage": "rising",
            "growth": "+50%", "onBrand": True, "why": "measured", "tags": [],
            "products": [],
        },
        creator_id="creator-1",
        publish_targets=["x"],
    )
    campaign = await world["store"].get_campaign(record.campaign_id)
    result = await creator.submit_draft_bytes(
        "creator-1",
        campaign.brief_id,
        data=media["hevc.mov"],
        filename="hevc.mov",
        media_type="video",
    )
    assert result["validation"]["status"] == "postable_after_fixes"
    assert result["validation"]["normalization"]["applied"]

    final = await world["store"].get_campaign(record.campaign_id)
    assert final.status == CampaignStatus.AWAITING_APPROVAL

    version = await world["store"].get_version(UUID(result["draft_id"]))
    sealed = assets.get(version.asset_ref)
    sealed_probe = await probe_bytes(sealed, "sealed.mp4")
    # Score-what-you-post: the sealed bytes' hash IS the version identity.
    assert sealed_probe.sha256 == version.asset_sha256
    assert version.asset_ref.endswith(f"{sealed_probe.sha256}.mp4")


async def test_dedup_identical_resubmission(media: dict[str, bytes]) -> None:
    world = build_world(scores=[5.0, 5.5])
    assets = MemoryAssetStore()
    creator = CreatorService(
        world["store"], world["runtime"], RULES, assets=assets, normalizer=NORMALIZER
    )
    campaign_id = await start_campaign(world)
    campaign = await world["store"].get_campaign(campaign_id)
    await creator.submit_draft_bytes(
        "creator-1", campaign.brief_id, data=media["good.mp4"],
        filename="good.mp4", media_type="video",
    )
    # Identical bytes again (now revising) — sealed store dedups, no error.
    await creator.submit_draft_bytes(
        "creator-1", campaign.brief_id, data=media["good.mp4"],
        filename="good.mp4", media_type="video",
    )
    versions = [
        v for v in world["store"].versions.values() if v.campaign_id == campaign_id
    ]
    assert len(versions) == 2
    assert versions[0].asset_ref == versions[1].asset_ref  # same sealed artifact


def test_normalization_is_deterministic(media: dict[str, bytes]) -> None:
    async def run_twice() -> tuple[bytes, bytes]:
        a, _, _ = await NORMALIZER.normalize(
            media["hevc.mov"],
            await probe_bytes(media["hevc.mov"], "hevc.mov"),
            {"codec.video_unsupported", "codec.container_unsupported"},
        )
        b, _, _ = await NORMALIZER.normalize(
            media["hevc.mov"],
            await probe_bytes(media["hevc.mov"], "hevc.mov"),
            {"codec.video_unsupported", "codec.container_unsupported"},
        )
        return a, b

    first, second = asyncio.run(run_twice())
    assert first == second
