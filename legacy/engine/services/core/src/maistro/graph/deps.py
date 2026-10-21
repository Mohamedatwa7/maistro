"""Dependency protocols the graph nodes run against.

Real implementations (F1X8Scorer over the adapter, SentimentMetricsSource
over the corpus) live in maistro/integrations.py; tests inject fakes. Nodes
never touch adapters directly — this seam is what makes the graph testable
and the chaos suite possible."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol
from uuid import UUID

from pydantic import BaseModel

from maistro.store import CampaignStore, ContentVersionRecord, MetricsSnapshot, PublicationRecord


class ScoreSubmission(BaseModel):
    result: dict[str, Any] | None = None  # sync (image) — raw AnalysisResult payload
    job_id: str | None = None  # async (video)


class JobPoll(BaseModel):
    status: str  # fetching | analyzing | done | error | not_found
    result: dict[str, Any] | None = None
    error: str | None = None


class Scorer(Protocol):
    async def submit(self, version: ContentVersionRecord, brief_text: str) -> ScoreSubmission: ...
    async def poll(self, job_id: str) -> JobPoll: ...


class MetricsSource(Protocol):
    async def snapshot(
        self, campaign_id: UUID, publications: list[PublicationRecord], day: str
    ) -> list[MetricsSnapshot]: ...


@dataclass
class GraphDeps:
    store: CampaignStore
    scorer: Scorer
    metrics_source: MetricsSource
    poll_interval_s: float = 30.0
    poll_max_attempts: int = 60  # x30s = 30 min budget (ARCHITECTURE §4.1)
    monitoring_days: int = 14
    extras: dict[str, Any] = field(default_factory=dict)
