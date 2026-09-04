"""LangGraph state contract (DATA-MODEL.md §3).

Versioned via state_version: checkpoints persist for days, so changes are
additive-only or ship with a checkpoint migration + chaos-suite replay
(CONTRACTS.md §4). The database campaigns.status is the source of truth;
this state mirrors it via transitions.transition()."""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from maistro.generated.entities.problem import Problem
from maistro.generated.f1x8 import ImageAnalysisResult, VideoAnalysisResult
from maistro.generated.trend_radar import AgentTrend

AnalysisResult = ImageAnalysisResult | VideoAnalysisResult

STATE_VERSION = 1


class Platform(StrEnum):
    TIKTOK = "tiktok"
    INSTAGRAM = "instagram"
    FACEBOOK = "facebook"
    X = "x"


class CampaignStatus(StrEnum):
    TREND_SELECTED = "trend_selected"
    BRIEF_GENERATED = "brief_generated"
    AWAITING_DRAFT = "awaiting_draft"
    SCORING = "scoring"
    SCORE_EVALUATED = "score_evaluated"
    REVISING = "revising"
    AWAITING_APPROVAL = "awaiting_approval"
    APPROVED = "approved"
    PUBLISHING = "publishing"
    PUBLISHED = "published"
    MONITORING = "monitoring"
    LEARNINGS_WRITTEN = "learnings_written"
    CLOSED = "closed"
    CANCELLED = "cancelled"
    ESCALATED = "escalated"


TERMINAL_STATUSES = frozenset({CampaignStatus.CLOSED, CampaignStatus.CANCELLED})


class DraftRef(BaseModel):
    content_version_id: UUID
    asset_ref: str
    media_type: Literal["image", "video"]


class ApprovalRef(BaseModel):
    approval_id: UUID
    content_version_id: UUID
    decided_at: datetime


class PublishOutcome(BaseModel):
    platform: Platform
    publish_record_id: UUID
    status: Literal["published", "failed", "skipped_duplicate"]
    platform_post_id: str | None = None
    post_url: str | None = None


class CampaignState(BaseModel):
    state_version: int = STATE_VERSION

    campaign_id: UUID
    status: CampaignStatus
    trend: AgentTrend
    brief_id: UUID | None = None

    iteration: int = 0
    max_iterations: int = 4
    score_threshold: float = 7.0  # placeholder until M3 calibration (ACCURACY.md J2)

    current_draft: DraftRef | None = None
    f1x8_job_id: str | None = None
    analysis_result: AnalysisResult | None = None
    loop_exhausted: bool = False
    final_submitted: bool = False

    approval: ApprovalRef | None = None
    publish_targets: list[Platform] = Field(default_factory=lambda: [Platform.TIKTOK])
    publish_results: list[PublishOutcome] = Field(default_factory=list)

    monitoring_until: date | None = None
    learnings_context: list[str] = Field(default_factory=list)

    last_error: Problem | None = None
    escalation_reason: str | None = None
