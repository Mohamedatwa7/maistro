"""Campaign persistence.

`CampaignStore` is the protocol the graph, services, and API depend on;
`MemoryStore` is the in-process implementation used for tests and local dev.
`PostgresStore` (same protocol, backed by db/migrations/001_core.sql via the
dedicated Supabase project) lands when MAISTRO_DATABASE_URL is provisioned —
nothing above this module changes when it does.

Source-of-truth rule (DATA-MODEL.md §3): ALL status changes go through
`transition()`, which validates against the state machine and writes the
audit event atomically with the status update."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID, uuid4

from pydantic import BaseModel, Field

from maistro.graph.state import CampaignStatus, Platform
from maistro.graph.transitions import next_status


def _now() -> datetime:
    return datetime.now(UTC)


class CampaignRecord(BaseModel):
    campaign_id: UUID
    status: CampaignStatus
    trend_ref: dict[str, Any]
    brief_id: UUID | None = None
    creator_id: str
    current_version: int = 0
    max_iterations: int = 4
    score_threshold: float = 7.0
    publish_targets: list[Platform]
    state_version: int = 1
    created_at: datetime = Field(default_factory=_now)
    closed_at: datetime | None = None


class BriefRecord(BaseModel):
    brief_id: UUID
    campaign_id: UUID
    body: dict[str, Any]
    generated_at: datetime = Field(default_factory=_now)


class ContentVersionRecord(BaseModel):
    content_version_id: UUID
    campaign_id: UUID
    iteration: int
    asset_ref: str
    media_type: str
    submitted_by: str
    submitted_at: datetime = Field(default_factory=_now)
    creator_notes: str | None = None
    f1x8_job_id: str | None = None
    analysis_result: dict[str, Any] | None = None
    validation_report: dict[str, Any] | None = None
    asset_sha256: str | None = None


class ApprovalRecord(BaseModel):
    approval_id: UUID
    campaign_id: UUID
    content_version_id: UUID
    decision: str
    approver_id: str
    note: str | None = None
    brief_fit_rubric: dict[str, bool] | None = None
    decided_at: datetime = Field(default_factory=_now)
    revoked_at: datetime | None = None


class PublicationRecord(BaseModel):
    publish_record_id: UUID
    campaign_id: UUID
    content_version_id: UUID
    platform: Platform
    status: str  # published | failed | skipped_duplicate (manual mode: published)
    platform_post_id: str | None = None
    post_url: str | None = None
    published_at: datetime | None = None


class AuditEvent(BaseModel):
    event_id: UUID
    campaign_id: UUID | None
    actor: str
    event: str
    detail: dict[str, Any] | None = None
    at: datetime = Field(default_factory=_now)


class MetricsSnapshot(BaseModel):
    campaign_id: UUID
    snapshot_day: str  # ISO date
    platform: Platform
    views: int | None = None
    likes: int | None = None
    shares: int | None = None
    comment_count: int | None = None
    engagement_rate: float | None = None
    sentiment: dict[str, Any] | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class LearningRecord(BaseModel):
    learning_id: UUID
    campaign_id: UUID
    predicted_score: float
    actual_metrics: dict[str, Any]
    insight: str
    insight_status: str = "candidate"
    created_at: datetime = Field(default_factory=_now)


class CreatorRecord(BaseModel):
    creator_id: str
    display_name: str
    api_key_hash: str
    active: bool = True


class CampaignStore(Protocol):
    async def create_campaign(self, record: CampaignRecord) -> None: ...
    async def get_campaign(self, campaign_id: UUID) -> CampaignRecord | None: ...
    async def list_campaigns(
        self, *, creator_id: str | None = None, statuses: set[CampaignStatus] | None = None
    ) -> list[CampaignRecord]: ...
    async def transition(
        self, campaign_id: UUID, event: str, *, actor: str, detail: dict[str, Any] | None = None
    ) -> CampaignStatus: ...
    async def save_brief(self, record: BriefRecord) -> None: ...
    async def get_brief(self, brief_id: UUID) -> BriefRecord | None: ...
    async def add_version(self, record: ContentVersionRecord) -> None: ...
    async def get_version(self, content_version_id: UUID) -> ContentVersionRecord | None: ...
    async def latest_version(self, campaign_id: UUID) -> ContentVersionRecord | None: ...
    async def set_analysis(
        self, content_version_id: UUID, job_id: str | None, analysis: dict[str, Any] | None
    ) -> None: ...
    async def add_approval(self, record: ApprovalRecord) -> None: ...
    async def add_publication(self, record: PublicationRecord) -> None: ...
    async def add_metrics(self, snapshot: MetricsSnapshot) -> None: ...
    async def add_learning(self, record: LearningRecord) -> None: ...
    async def append_audit(self, event: AuditEvent) -> None: ...
    async def list_audit(self, campaign_id: UUID) -> list[AuditEvent]: ...
    async def effect_once(self, campaign_id: UUID, node: str, attempt_key: str) -> bool: ...
    async def get_creator_by_key_hash(self, api_key_hash: str) -> CreatorRecord | None: ...


class MemoryStore:
    """In-process CampaignStore. Single asyncio lock keeps transition+audit
    atomic; fine for one-process dev/test, replaced by Postgres transactions
    in PostgresStore."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self.campaigns: dict[UUID, CampaignRecord] = {}
        self.briefs: dict[UUID, BriefRecord] = {}
        self.versions: dict[UUID, ContentVersionRecord] = {}
        self.approvals: dict[UUID, ApprovalRecord] = {}
        self.publications: list[PublicationRecord] = []
        self.metrics: list[MetricsSnapshot] = []
        self.learnings: list[LearningRecord] = []
        self.audit: list[AuditEvent] = []
        self.effects: set[tuple[UUID, str, str]] = set()
        self.creators: dict[str, CreatorRecord] = {}

    async def create_campaign(self, record: CampaignRecord) -> None:
        self.campaigns[record.campaign_id] = record

    async def get_campaign(self, campaign_id: UUID) -> CampaignRecord | None:
        return self.campaigns.get(campaign_id)

    async def list_campaigns(
        self, *, creator_id: str | None = None, statuses: set[CampaignStatus] | None = None
    ) -> list[CampaignRecord]:
        result = list(self.campaigns.values())
        if creator_id is not None:
            result = [c for c in result if c.creator_id == creator_id]
        if statuses is not None:
            result = [c for c in result if c.status in statuses]
        return sorted(result, key=lambda c: c.created_at)

    async def transition(
        self, campaign_id: UUID, event: str, *, actor: str, detail: dict[str, Any] | None = None
    ) -> CampaignStatus:
        async with self._lock:
            campaign = self.campaigns[campaign_id]
            new_status = next_status(campaign.status, event)
            campaign.status = new_status
            if new_status in (CampaignStatus.CLOSED, CampaignStatus.CANCELLED):
                campaign.closed_at = _now()
            self.audit.append(
                AuditEvent(
                    event_id=uuid4(),
                    campaign_id=campaign_id,
                    actor=actor,
                    event=event,
                    detail={"to": new_status.value, **(detail or {})},
                )
            )
            return new_status

    async def save_brief(self, record: BriefRecord) -> None:
        self.briefs[record.brief_id] = record
        self.campaigns[record.campaign_id].brief_id = record.brief_id

    async def get_brief(self, brief_id: UUID) -> BriefRecord | None:
        return self.briefs.get(brief_id)

    async def add_version(self, record: ContentVersionRecord) -> None:
        self.versions[record.content_version_id] = record
        campaign = self.campaigns[record.campaign_id]
        campaign.current_version = max(campaign.current_version, record.iteration)

    async def get_version(self, content_version_id: UUID) -> ContentVersionRecord | None:
        return self.versions.get(content_version_id)

    async def latest_version(self, campaign_id: UUID) -> ContentVersionRecord | None:
        versions = [v for v in self.versions.values() if v.campaign_id == campaign_id]
        return max(versions, key=lambda v: v.iteration) if versions else None

    async def set_analysis(
        self, content_version_id: UUID, job_id: str | None, analysis: dict[str, Any] | None
    ) -> None:
        version = self.versions[content_version_id]
        if job_id is not None:
            version.f1x8_job_id = job_id
        if analysis is not None:
            version.analysis_result = analysis

    async def add_approval(self, record: ApprovalRecord) -> None:
        self.approvals[record.approval_id] = record

    async def add_publication(self, record: PublicationRecord) -> None:
        self.publications.append(record)

    async def add_metrics(self, snapshot: MetricsSnapshot) -> None:
        self.metrics.append(snapshot)

    async def add_learning(self, record: LearningRecord) -> None:
        self.learnings.append(record)

    async def append_audit(self, event: AuditEvent) -> None:
        self.audit.append(event)

    async def list_audit(self, campaign_id: UUID) -> list[AuditEvent]:
        return [e for e in self.audit if e.campaign_id == campaign_id]

    async def effect_once(self, campaign_id: UUID, node: str, attempt_key: str) -> bool:
        """True exactly once per (campaign, node, key) — the idempotency
        primitive nodes use before causing external effects."""
        async with self._lock:
            key = (campaign_id, node, attempt_key)
            if key in self.effects:
                return False
            self.effects.add(key)
            return True

    async def get_creator_by_key_hash(self, api_key_hash: str) -> CreatorRecord | None:
        for creator in self.creators.values():
            if creator.api_key_hash == api_key_hash and creator.active:
                return creator
        return None
