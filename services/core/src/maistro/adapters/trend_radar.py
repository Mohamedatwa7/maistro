"""Trend Radar (kymah.com) adapter — read-only by policy (ADR D9).

Auth: agent key as bearer. Brief authoring is rate-limited upstream at
4/min and 30/hr per key; the graph layer budgets <= 20/hr (M2)."""

from __future__ import annotations

from typing import Any

from maistro.adapters.base import BaseAdapter
from maistro.generated.trend_radar import (
    AuthorBriefRequest,
    AuthorBriefResponse,
    SingleTrendResponse,
    SoundsFeedResponse,
    TermsFeedResponse,
    TrendListResponse,
)


class TrendRadarAdapter(BaseAdapter):
    tool = "trend_radar"

    async def list_trends(
        self,
        *,
        on_brand: bool | None = None,
        kind: str | None = None,
        category: str | None = None,
        q: str | None = None,
        limit: int | None = None,
    ) -> TrendListResponse:
        params: dict[str, Any] = {}
        if on_brand is not None:
            params["onBrand"] = on_brand
        if kind is not None:
            params["kind"] = kind
        if category is not None:
            params["category"] = category
        if q is not None:
            params["q"] = q
        if limit is not None:
            params["limit"] = limit
        return await self._get_model("/api/agent/trends", TrendListResponse, params=params)

    async def get_trend(self, trend_id: str) -> SingleTrendResponse:
        return await self._get_model(
            "/api/agent/trends", SingleTrendResponse, params={"id": trend_id}
        )

    async def get_sounds(self, *, limit: int | None = None) -> SoundsFeedResponse:
        params = {"limit": limit} if limit is not None else None
        return await self._get_model("/api/agent/feed/sounds", SoundsFeedResponse, params=params)

    async def get_terms(self, *, limit: int | None = None) -> TermsFeedResponse:
        params = {"limit": limit} if limit is not None else None
        return await self._get_model("/api/agent/feed/terms", TermsFeedResponse, params=params)

    async def author_brief(self, request: AuthorBriefRequest) -> AuthorBriefResponse:
        # Not retried: TR rate-limits hard (429 carries retryAfterSeconds);
        # the caller decides whether to reschedule.
        return await self._post_model(
            "/api/agent/brief",
            AuthorBriefResponse,
            json=request.model_dump(exclude_none=True),
        )
