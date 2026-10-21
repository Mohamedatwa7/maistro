"""Maistro's MCP server — the content creator's interface (CONTRACTS.md §2).

Identity: the ASGI auth middleware (app.py) resolves the creator from their
API key and sets `current_creator_id` before the MCP app handles the
request. Tools are thin wrappers over CreatorService — the same layer the
REST API uses."""

from __future__ import annotations

import contextvars
from typing import Any
from uuid import UUID

from mcp.server.mcpserver import MCPServer

from maistro.ingest import download
from maistro.integrations import MemoryAssetStore
from maistro.services import CreatorService, ServiceError

current_creator_id: contextvars.ContextVar[str] = contextvars.ContextVar("current_creator_id")

INSTRUCTIONS = """Maistro — Samsung Gulf content pipeline.
You are connected as a content creator. Workflow:
1. list_assigned_briefs -> see what's assigned to you
2. get_brief -> the full creative brief (hooks, dos/donts, constraints)
3. check_asset -> OPTIONAL pre-flight: validate an export before submitting
4. submit_draft -> submit; the asset is validated (postability gate) and
   scored; a below-threshold score returns a structured revision brief
5. get_feedback -> score, ranked risks, revision plan
6. submit_final -> send your current draft to approval even below threshold
Note: null in any data means NOT MEASURED, never zero."""


def _err(exc: ServiceError) -> dict[str, Any]:
    return {
        "error": {"code": exc.code, "status": exc.status_code, "detail": exc.detail},
        **({"validation": exc.extra} if exc.extra else {}),
    }


def build_mcp_server(creator_service: CreatorService, assets: MemoryAssetStore) -> MCPServer:
    server = MCPServer(name="maistro", title="Maistro", instructions=INSTRUCTIONS)

    @server.tool(description="List briefs assigned to you, with status and deadline.")
    async def list_assigned_briefs() -> list[dict[str, Any]] | dict[str, Any]:
        try:
            return await creator_service.list_assigned_briefs(current_creator_id.get())
        except ServiceError as exc:
            return _err(exc)

    @server.tool(description="Full creative brief: trend, angle, hooks, dos/donts, constraints.")
    async def get_brief(brief_id: str) -> dict[str, Any]:
        try:
            return await creator_service.get_brief(current_creator_id.get(), UUID(brief_id))
        except ServiceError as exc:
            return _err(exc)

    @server.tool(
        description="Pre-flight validation of an asset URL against platform + brief rules. "
        "No submission, unlimited use."
    )
    async def check_asset(brief_id: str, asset_url: str, media_type: str) -> dict[str, Any]:
        try:
            data, filename = await download(asset_url)
            report = await creator_service.check_asset_bytes(
                current_creator_id.get(),
                UUID(brief_id),
                data=data,
                filename=filename,
                media_type=media_type,
            )
            return report.model_dump(by_alias=True, mode="json")
        except ServiceError as exc:
            return _err(exc)

    @server.tool(
        description="Submit a draft for a brief. The file at asset_url is downloaded, "
        "validated (postability gate, incl. auto-normalization of fixable issues), "
        "sealed, and scored. media_type: image|video."
    )
    async def submit_draft(
        brief_id: str, asset_url: str, media_type: str, notes: str | None = None
    ) -> dict[str, Any]:
        try:
            data, filename = await download(asset_url)
            return await creator_service.submit_draft_bytes(
                current_creator_id.get(),
                UUID(brief_id),
                data=data,
                filename=filename,
                media_type=media_type,
                notes=notes,
            )
        except ServiceError as exc:
            return _err(exc)

    @server.tool(
        description="Score and feedback for a submitted draft: ranked risks with "
        "score levers, and the structured revision brief."
    )
    async def get_feedback(draft_id: str) -> dict[str, Any]:
        try:
            return await creator_service.get_feedback(current_creator_id.get(), UUID(draft_id))
        except ServiceError as exc:
            return _err(exc)

    @server.tool(
        description="Declare your current draft final — routes to human approval even "
        "if the score is below threshold."
    )
    async def submit_final(draft_id: str) -> dict[str, Any]:
        try:
            return await creator_service.submit_final(current_creator_id.get(), UUID(draft_id))
        except ServiceError as exc:
            return _err(exc)

    @server.tool(description="Campaign status and full event timeline.")
    async def get_campaign_status(campaign_id: str) -> dict[str, Any]:
        try:
            return await creator_service.get_campaign_status(
                current_creator_id.get(), UUID(campaign_id)
            )
        except ServiceError as exc:
            return _err(exc)

    return server
