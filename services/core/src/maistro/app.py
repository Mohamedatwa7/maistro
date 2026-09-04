"""FastAPI application: REST surface + mounted MCP server (one process,
ARCHITECTURE §4). Creators connect MCP clients to /creator/mcp with their
personal API key; operators use /api/* with X-Operator-Key.

Run locally:  uvicorn maistro.app:app --reload --port 8100

Wiring today: MemoryStore + InMemorySaver (single-process, non-durable
across restarts). PostgresStore + PostgresSaver swap in when
MAISTRO_DATABASE_URL is provisioned — construction happens only here."""

from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from starlette.types import ASGIApp, Receive, Scope, Send

from maistro import __version__
from maistro.adapters import F1X8Adapter, SentimentAdapter
from maistro.api import router
from maistro.config import Settings, get_settings
from maistro.gate.rules import RulesEngine
from maistro.graph.deps import GraphDeps
from maistro.graph.runtime import CampaignRuntime
from maistro.integrations import F1X8Scorer, MemoryAssetStore, SentimentMetricsSource
from maistro.mcp_server import build_mcp_server, current_creator_id
from maistro.services import CreatorService, OperatorService
from maistro.store import CampaignStore, MemoryStore
from maistro.telemetry import configure_logging


class CreatorAuthMiddleware:
    """Resolves the creator identity for the MCP mount: Authorization: Bearer
    <key> or X-Api-Key. Keys are stored hashed (sha256) in the creators
    table; the resolved id lands in the current_creator_id contextvar."""

    def __init__(self, app: ASGIApp, store: CampaignStore) -> None:
        self.app = app
        self.store = store

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        key = headers.get("x-api-key")
        if key is None and headers.get("authorization", "").lower().startswith("bearer "):
            key = headers["authorization"][7:]
        creator = None
        if key:
            creator = await self.store.get_creator_by_key_hash(
                hashlib.sha256(key.encode()).hexdigest()
            )
        if creator is None:
            await send(
                {
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [(b"content-type", b"application/json")],
                }
            )
            await send(
                {
                    "type": "http.response.body",
                    "body": b'{"error": "invalid or missing creator API key"}',
                }
            )
            return
        token = current_creator_id.set(creator.creator_id)
        try:
            await self.app(scope, receive, send)
        finally:
            current_creator_id.reset(token)


def build_state(settings: Settings) -> dict[str, Any]:
    store = MemoryStore()
    assets = MemoryAssetStore()
    f1x8 = F1X8Adapter(settings.f1x8_base_url, settings.f1x8_api_key)
    sentiment = SentimentAdapter(
        settings.sentiment_base_url or "http://localhost:3000",
        settings.sentiment_api_key,
    )
    deps = GraphDeps(
        store=store,
        scorer=F1X8Scorer(f1x8, assets),
        metrics_source=SentimentMetricsSource(sentiment),
    )
    runtime = CampaignRuntime(deps)
    rules = RulesEngine()
    return {
        "store": store,
        "assets": assets,
        "runtime": runtime,
        "operator_service": OperatorService(store, runtime),
        "creator_service": CreatorService(store, runtime, rules),
    }


def create_app(settings: Settings | None = None, state: dict[str, Any] | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    state = state or build_state(settings)

    from mcp.server.transport_security import TransportSecuritySettings

    mcp_server = build_mcp_server(state["creator_service"], state["assets"])
    mcp_app = mcp_server.streamable_http_app(
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            allowed_hosts=settings.mcp_allowed_hosts,
            allowed_origins=[f"https://{h}" for h in settings.mcp_allowed_hosts],
        ),
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        async with mcp_server.session_manager.run():
            yield

    application = FastAPI(title="Maistro Core", version=__version__, lifespan=lifespan)
    for key, value in state.items():
        setattr(application.state, key, value)
    application.include_router(router)
    application.mount("/creator", CreatorAuthMiddleware(mcp_app, state["store"]))
    return application


app = create_app()
