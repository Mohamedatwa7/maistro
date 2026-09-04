"""Typed adapters over the four upstream tools (ARCHITECTURE.md §4.1).

Every adapter validates responses against packages/contracts at the boundary
— malformed data is rejected before it can enter a checkpoint."""

from maistro.adapters.base import AdapterError, BaseAdapter, BoundaryValidationError
from maistro.adapters.f1x8 import F1X8Adapter
from maistro.adapters.lenceus import LenceusAdapter
from maistro.adapters.sentiment import SentimentAdapter
from maistro.adapters.trend_radar import TrendRadarAdapter

__all__ = [
    "AdapterError",
    "BaseAdapter",
    "BoundaryValidationError",
    "F1X8Adapter",
    "LenceusAdapter",
    "SentimentAdapter",
    "TrendRadarAdapter",
]
