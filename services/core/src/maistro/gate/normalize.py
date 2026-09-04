"""FfmpegNormalizer — postability gate stage 4 (docs/POSTABILITY.md).

Deterministic single-pass ffmpeg plan for FIXABLE issues: remux to mp4 +
faststart, transcode to H.264/AAC when required, bake rotation into pixels,
VFR -> CFR, downscale above target maximums, cap bitrate. Never trims,
crops, or tone-maps (those are blockers/warnings by policy).

The normalized artifact is re-probed and re-checked by the caller
(gate/pipeline.py) — a normalization that doesn't converge is a blocker."""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path
from typing import Any

from maistro.errors import ServiceError
from maistro.gate.rules import GateProbe

# Issue codes this normalizer can remediate (everything else is untouched).
FIXABLE_ACTIONS: dict[str, str] = {
    "codec.container_unsupported": "remux_mp4_faststart",
    "codec.video_unsupported": "transcode_h264",
    "audio.codec_unsupported": "transcode_audio_aac_48k",
    "integrity.rotation_metadata": "bake_rotation",
    "integrity.variable_frame_rate": "vfr_to_cfr",
    "resolution.above_max": "downscale_to_target_max",
    "resolution.fps_above_max": "cap_fps",
    "size.above_max": "cap_bitrate",
    "size.bitrate_above_max": "cap_bitrate",
}


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


async def _ffmpeg_version() -> str:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
    )
    stdout, _ = await proc.communicate()
    return stdout.decode().splitlines()[0] if stdout else "unknown"


class FfmpegNormalizer:
    """`available` gates strict-mode escalation in RulesEngine: when this
    normalizer is wired, fixable issues stay fixable and get remediated."""

    available = True

    def __init__(self, *, target_max: tuple[int, int] = (1080, 1920), max_fps: int = 60) -> None:
        self.target_max = target_max
        self.max_fps = max_fps

    def plan(self, issue_codes: set[str]) -> list[str]:
        actions = [
            action for code, action in FIXABLE_ACTIONS.items() if code in issue_codes
        ]
        # Deterministic order regardless of issue order.
        return sorted(set(actions))

    async def normalize(
        self, data: bytes, probe: GateProbe, issue_codes: set[str]
    ) -> tuple[bytes, list[str], str]:
        """Apply the plan in ONE ffmpeg pass. Returns (bytes, applied
        actions, ffmpeg version). Raises ServiceError on ffmpeg failure."""
        if not ffmpeg_available():
            raise ServiceError(
                503, "normalize_unavailable", "ffmpeg is not installed on this host"
            )
        actions = self.plan(issue_codes)
        if not actions:
            return data, [], await _ffmpeg_version()

        needs_video_encode = bool(
            {
                "transcode_h264",
                "bake_rotation",
                "vfr_to_cfr",
                "downscale_to_target_max",
                "cap_fps",
                "cap_bitrate",
            }
            & set(actions)
        )
        needs_audio_encode = "transcode_audio_aac_48k" in actions

        args: list[str] = ["-y", "-i", "IN"]
        filters: list[str] = []
        if "downscale_to_target_max" in actions:
            max_w, max_h = self.target_max
            filters.append(
                f"scale='min({max_w},iw)':'min({max_h},ih)'"
                ":force_original_aspect_ratio=decrease:force_divisible_by=2"
            )
        if needs_video_encode:
            if filters:
                args += ["-vf", ",".join(filters)]
            args += ["-c:v", "libx264", "-preset", "medium", "-crf", "20"]
            if "cap_bitrate" in actions:
                args += ["-maxrate", "16M", "-bufsize", "32M"]
            if "vfr_to_cfr" in actions or "cap_fps" in actions:
                fps = min(int(round(probe.fps or 30)), self.max_fps)
                args += ["-r", str(fps), "-vsync", "cfr"]
            # Baking rotation happens implicitly: re-encoding applies the
            # display matrix and drops the metadata tag (ffmpeg default).
        else:
            args += ["-c:v", "copy"]
        args += (
            ["-c:a", "aac", "-ar", "48000", "-b:a", "192k"]
            if needs_audio_encode
            else ["-c:a", "copy"]
        )
        args += ["-movflags", "+faststart", "-f", "mp4", "OUT"]

        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / f"in.{probe.container or 'bin'}"
            dst = Path(tmp) / "out.mp4"
            src.write_bytes(data)
            cmd = ["ffmpeg"] + [
                str(src) if a == "IN" else str(dst) if a == "OUT" else a for a in args
            ]
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0 or not dst.exists():
                raise ServiceError(
                    422,
                    "normalize_failed",
                    "normalization did not converge — export to spec directly",
                    extra={"ffmpeg_error": stderr.decode(errors="replace")[-500:]},
                )
            return dst.read_bytes(), actions, await _ffmpeg_version()


def summarize_plan(actions: list[str]) -> dict[str, Any]:
    return {"applied": actions}
