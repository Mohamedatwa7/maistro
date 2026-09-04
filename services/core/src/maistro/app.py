"""FastAPI application factory.

Run locally:  uvicorn maistro.app:app --reload --port 8100
The MCP server mounts into this app in M2 (ARCHITECTURE.md §4.3)."""

from fastapi import FastAPI

from maistro import __version__
from maistro.api import router
from maistro.config import Settings, get_settings
from maistro.telemetry import configure_logging


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    application = FastAPI(title="Maistro Core", version=__version__)
    application.include_router(router)
    return application


app = create_app()
