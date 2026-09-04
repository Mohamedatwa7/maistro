"""Asset ingestion (POSTABILITY.md stages 1-2): fetch bytes, hash, probe.

ffprobe (ships with ffmpeg) is the probe backend for both video and images.
If it isn't installed the gate cannot run — that's a loud 503, never a
skipped check."""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import tempfile
from fractions import Fraction
from pathlib import Path
from typing import Any

import httpx

from maistro.gate.rules import GateProbe
from maistro.services import ServiceError

MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024  # hard ingest cap; platform caps are stricter

_HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}


def _fraction(text: str | None) -> float | None:
    if not text or text in ("0/0", "N/A"):
        return None
    try:
        return float(Fraction(text))
    except (ValueError, ZeroDivisionError):
        return None


def ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


async def probe_bytes(data: bytes, filename_hint: str) -> GateProbe:
    if not ffprobe_available():
        raise ServiceError(
            503, "probe_unavailable", "ffprobe is not installed on this host — "
            "the postability gate cannot run (install ffmpeg)"
        )
    suffix = Path(filename_hint).suffix or ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = Path(tmp.name)
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe",
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            str(tmp_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise ServiceError(
                422,
                "asset_invalid",
                "file could not be parsed as media (truncated or corrupt?)",
                extra={"probe_error": stderr.decode(errors="replace")[:500]},
            )
        info: dict[str, Any] = json.loads(stdout.decode())
    finally:
        tmp_path.unlink(missing_ok=True)

    fmt = info.get("format", {})
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    container = (Path(filename_hint).suffix.lstrip(".") or "").lower()
    if not container:
        container = str(fmt.get("format_name", "unknown")).split(",")[0]

    rotation = 0
    fps = avg_fps = None
    if video is not None:
        for side in video.get("side_data_list", []):
            if "rotation" in side:
                rotation = int(side["rotation"]) % 360
        fps = _fraction(video.get("r_frame_rate"))
        avg_fps = _fraction(video.get("avg_frame_rate"))

    bitrate = fmt.get("bit_rate")
    return GateProbe(
        container=container,
        video_codec=video.get("codec_name") if video else None,
        audio_codec=audio.get("codec_name") if audio else None,
        duration_s=float(fmt["duration"]) if fmt.get("duration") else None,
        width=video.get("width") if video else None,
        height=video.get("height") if video else None,
        fps=avg_fps or fps,
        vfr=(fps is not None and avg_fps is not None and abs(fps - avg_fps) > 0.5),
        rotation=rotation or None,
        hdr=(
            video is not None and video.get("color_transfer") in _HDR_TRANSFERS
        )
        or None,
        bitrate_kbps=float(bitrate) / 1000 if bitrate else None,
        audio_sample_rate=int(audio["sample_rate"]) if audio and audio.get("sample_rate") else None,
        sha256=hashlib.sha256(data).hexdigest(),
        size_bytes=len(data),
    )


async def download(url: str) -> tuple[bytes, str]:
    """Fetch an asset URL server-side (POSTABILITY.md stage 1). Returns
    (bytes, filename_hint)."""
    async with httpx.AsyncClient(follow_redirects=True, timeout=120.0) as client:
        try:
            response = await client.get(url)
        except httpx.HTTPError as exc:
            raise ServiceError(
                422, "asset_fetch_failed", f"could not download asset: {exc}"
            ) from exc
    if response.status_code >= 400:
        raise ServiceError(
            422, "asset_fetch_failed", f"asset URL returned HTTP {response.status_code}"
        )
    if len(response.content) > MAX_DOWNLOAD_BYTES:
        raise ServiceError(422, "asset_invalid", "asset exceeds the 600 MB ingest cap")
    filename = Path(httpx.URL(url).path).name or "asset.bin"
    return response.content, filename
