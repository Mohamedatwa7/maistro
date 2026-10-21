"""F1X8 adapter. Image analysis is synchronous (~10-30s); video is
submit -> poll. Errors come back 200-bodied as {error, trace} — mapped to
AdapterError here.

Policy (CONTRACTS.md §1.2): always pass the Maistro Brief text as
`description` so the response carries context_score (brief-fit, feeds J4).
Analysis is a pure function of the asset, so the sync call is safely
retryable (2 attempts, 120s timeout)."""

from __future__ import annotations

from typing import Any

from maistro.adapters.base import AdapterError, BaseAdapter
from maistro.generated.f1x8 import (
    ImageAnalysisResult,
    JobStatus,
    JobSubmitted,
)

IMAGE_TIMEOUT_S = 120.0
IMAGE_ATTEMPTS = 2
VIDEO_POLL_BUDGET_S = 30 * 60  # graph-level polling budget (ARCHITECTURE §4.1)


class F1X8Adapter(BaseAdapter):
    tool = "f1x8"

    def _reject_error_body(self, payload: Any) -> Any:
        if isinstance(payload, dict) and "error" in payload and "score" not in payload:
            raise AdapterError(
                self.tool,
                f"analysis failed upstream: {payload.get('error')}",
                retryable=True,
                upstream=payload,
            )
        return payload

    async def analyze_image(
        self,
        file: bytes,
        filename: str,
        *,
        title: str | None = None,
        description: str | None = None,
        format_type: str = "kv",
        lite: bool = False,
    ) -> ImageAnalysisResult:
        data: dict[str, Any] = {"format_type": format_type}
        if title is not None:
            data["title"] = title
        if description is not None:
            data["description"] = description
        if lite:
            data["lite"] = "1"
        response = await self._request(
            "POST",
            "/api/analyze/image",
            retryable=True,
            attempts=IMAGE_ATTEMPTS,
            data=data,
            files={"file": (filename, file)},
            timeout=IMAGE_TIMEOUT_S,
        )
        payload = self._reject_error_body(response.json())
        return self._validate(ImageAnalysisResult, payload)

    async def submit_video(
        self,
        file: bytes,
        filename: str,
        *,
        title: str | None = None,
        description: str | None = None,
    ) -> JobSubmitted:
        data: dict[str, Any] = {}
        if title is not None:
            data["title"] = title
        if description is not None:
            data["description"] = description
        return await self._post_model(
            "/api/analyze/video/submit",
            JobSubmitted,
            data=data,
            files={"file": (filename, file)},
        )

    async def submit_video_url(
        self,
        url: str,
        *,
        title: str | None = None,
        description: str | None = None,
    ) -> JobSubmitted:
        data: dict[str, Any] = {"url": url}
        if title is not None:
            data["title"] = title
        if description is not None:
            data["description"] = description
        return await self._post_model("/api/analyze/video-url/submit", JobSubmitted, data=data)

    async def get_job(self, job_id: str) -> JobStatus:
        return await self._get_model(f"/api/job/{job_id}", JobStatus)
