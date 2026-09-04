"""Lenceus banner-monitor adapter — read-only (Maistro never calls
POST /api/run; Lenceus has its own daily schedule). Share-percentage fields
are nullable: null means NOT MEASURED, never zero."""

from __future__ import annotations

from maistro.adapters.base import BaseAdapter
from maistro.generated.lenceus import HealthResponse, LogResponse, SitesResponse


class LenceusAdapter(BaseAdapter):
    tool = "lenceus"

    async def health(self) -> HealthResponse:
        return await self._get_model("/api/health", HealthResponse)

    async def list_sites(self) -> SitesResponse:
        return await self._get_model("/api/sites", SitesResponse)

    async def get_log(self, *, limit: int | None = None) -> LogResponse:
        params = {"limit": limit} if limit is not None else None
        return await self._get_model("/api/log", LogResponse, params=params)
