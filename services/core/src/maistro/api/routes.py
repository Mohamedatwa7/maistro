from fastapi import APIRouter

from maistro import __version__
from maistro.config import get_settings

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    settings = get_settings()
    return {
        "status": "ok",
        "service": "maistro-core",
        "version": __version__,
        "env": settings.env,
    }
