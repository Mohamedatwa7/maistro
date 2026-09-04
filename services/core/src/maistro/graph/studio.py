"""LangGraph Studio dev harness (repo-root `langgraph.json` points here).

`langgraph dev` serves this graph with Studio attached — the visual,
step-through view of the orchestration. NOT used by the production app.

In production the SERVICE layer creates the campaign/version records and
applies human-event transitions (draft.submitted, approval.*, publish.*)
before resuming the graph. In Studio you drive the raw graph, so DemoStore
stands in for the service layer: it auto-creates records on first access
and bridges the human events a service would have applied. Demo-only —
production nodes stay strict.

Driving a run in Studio (inputs -> interrupt resumes):
1. input: {"campaign_id": <uuid>, "status": "trend_selected", "trend": {...}}
2. resume: {"kind": "draft", "iteration": 1,
            "draft": {"content_version_id": <uuid>,
                      "asset_ref": "demo/a.mp4", "media_type": "video"}}
   -> scores 6.0, loops to request_revision
3. resume: same shape, new ids, iteration 2 -> scores 8.5 -> approval_gate
4. resume: {"decision": "approved",
            "approval": {"approval_id": <uuid>,
                         "content_version_id": <same as step 3>,
                         "decided_at": "2026-09-04T12:00:00Z"}}
5. resume: {"publications": [{"platform": "tiktok",
            "publish_record_id": <uuid>, "status": "published",
            "post_url": "https://tiktok.com/@demo/1"}]}
6. resume: {"day": "2026-09-05"} twice -> learnings written, closed.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from maistro.graph.builder import build_graph
from maistro.graph.deps import GraphDeps, JobPoll, ScoreSubmission
from maistro.graph.state import CampaignStatus, Platform
from maistro.graph.transitions import IllegalTransition, next_status
from maistro.store import (
    CampaignRecord,
    ContentVersionRecord,
    MemoryStore,
    MetricsSnapshot,
)

# Human events a service would have applied before the graph reaches the
# internal event, keyed by the store's current status. Demo bridging only.
_BRIDGES: dict[CampaignStatus, list[str]] = {
    CampaignStatus.AWAITING_DRAFT: ["draft.submitted"],
    CampaignStatus.REVISING: ["draft.submitted"],
    CampaignStatus.AWAITING_APPROVAL: [
        "approval.approved",
        "publish.requested",
        "publish.confirmed",
    ],
    CampaignStatus.APPROVED: ["publish.requested", "publish.confirmed"],
    CampaignStatus.PUBLISHING: ["publish.confirmed"],
}


class DemoStore(MemoryStore):
    async def get_campaign(self, campaign_id: UUID) -> CampaignRecord:
        campaign = await super().get_campaign(campaign_id)
        if campaign is None:
            campaign = CampaignRecord(
                campaign_id=campaign_id,
                status=CampaignStatus.TREND_SELECTED,
                trend_ref={"studio": True},
                creator_id="studio-creator",
                publish_targets=[Platform.TIKTOK],
            )
            await super().create_campaign(campaign)
        return campaign

    async def get_version(self, content_version_id: UUID) -> ContentVersionRecord:
        version = await super().get_version(content_version_id)
        if version is None:
            campaign_id = next(iter(self.campaigns), uuid4())
            version = ContentVersionRecord(
                content_version_id=content_version_id,
                campaign_id=campaign_id,
                iteration=len(self.versions) + 1,
                asset_ref=f"studio/{content_version_id}.mp4",
                media_type="video",
                submitted_by="studio-creator",
            )
            self.versions[content_version_id] = version
        return version

    async def transition(
        self, campaign_id: UUID, event: str, *, actor: str, detail: dict[str, Any] | None = None
    ) -> CampaignStatus:
        campaign = await self.get_campaign(campaign_id)
        try:
            next_status(campaign.status, event)
        except IllegalTransition:
            for bridge in _BRIDGES.get(campaign.status, []):
                await super().transition(
                    campaign_id, bridge, actor="studio-bridge", detail={"for": event}
                )
        return await super().transition(campaign_id, event, actor=actor, detail=detail)


def _demo_analysis(score: float) -> dict[str, Any]:
    return {
        "score": score,
        "engagement_potential": score,
        "funnel_stage": "upper",
        "kpis": {
            "emotional_pull": {"score": score, "label": "Emotional Pull", "methodology": "demo"}
        },
        "verdict": {
            "summary": f"demo verdict, scored {score}",
            "strengths": ["demo strength"],
            "risks": [],
            "revision_brief": {"objective": "demo revision objective"},
        },
    }


class DemoScorer:
    """Scores 6.0 first (drives the revision loop), then 8.5."""

    def __init__(self) -> None:
        self.calls = 0

    async def submit(self, version: ContentVersionRecord, brief_text: str) -> ScoreSubmission:
        self.calls += 1
        return ScoreSubmission(result=_demo_analysis(6.0 if self.calls == 1 else 8.5))

    async def poll(self, job_id: str) -> JobPoll:  # pragma: no cover - demo only
        return JobPoll(status="done", result=_demo_analysis(8.5))


class DemoMetrics:
    async def snapshot(self, campaign_id: Any, publications: Any, day: str) -> list[Any]:
        return [
            MetricsSnapshot(
                campaign_id=campaign_id,
                snapshot_day=day,
                platform=p.platform,
                views=1200,
                likes=90,
                comment_count=14,
                engagement_rate=0.087,
                raw={"demo": True},
            )
            for p in publications
        ]


def build_demo_deps() -> GraphDeps:
    return GraphDeps(
        store=DemoStore(),
        scorer=DemoScorer(),
        metrics_source=DemoMetrics(),
        poll_interval_s=0.1,
        monitoring_days=2,
    )


# `langgraph dev` supplies its own checkpointer — compile without one.
graph = build_graph(build_demo_deps())
