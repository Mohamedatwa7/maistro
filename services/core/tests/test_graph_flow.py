"""End-to-end graph tests: the full campaign lifecycle through the real
LangGraph engine + services, with fake scorer/metrics. Includes the chaos
scenarios from ARCHITECTURE.md §7: process-restart resume at an interrupt,
double-submit, loop exhaustion, escalation recovery."""

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from maistro.adapters.base import AdapterError
from maistro.gate.rules import GateProbe, RulesEngine
from maistro.graph.deps import GraphDeps, JobPoll, ScoreSubmission
from maistro.graph.runtime import CampaignRuntime
from maistro.graph.state import CampaignStatus
from maistro.services import CreatorService, OperatorService, ServiceError
from maistro.store import ContentVersionRecord, MemoryStore, MetricsSnapshot, PublicationRecord

TREND = {
    "id": "t1",
    "name": "Pass the phone",
    "kind": "trend",
    "stage": "rising",
    "growth": "+120%",
    "onBrand": True,
    "why": "Measured velocity across UAE creators.",
    "tags": ["mechanic"],
    "products": [
        {"product": "Galaxy Z Flip8", "line": "Foldable", "reason": "fits", "score": 80}
    ],
}


def make_analysis(score: float) -> dict[str, Any]:
    """Minimal payload that validates as ImageAnalysisResult (contract-typed)."""
    return {
        "score": score,
        "engagement_potential": score,
        "funnel_stage": "upper",
        "kpis": {
            "emotional_pull": {"score": score, "label": "Emotional Pull", "methodology": "judged"}
        },
        "verdict": {
            "summary": f"scored {score}",
            "strengths": ["clean hook"],
            "risks": [
                {
                    "rank": 1,
                    "issue": "payoff lands late",
                    "suggested_fix": "move payoff to second 2",
                    "score_lever": "hook_strength (weight 0.31)",
                    "confidence": "high",
                }
            ],
            "revision_brief": {"objective": "move the payoff earlier"},
        },
        "context_score": 7.5,
    }


class FakeScorer:
    """Returns queued scores; sync (image-style) by default, async job mode
    optional. Raises queued exceptions to drive escalation tests."""

    def __init__(self, scores: list[float | Exception], job_mode: bool = False) -> None:
        self.queue: list[float | Exception] = list(scores)
        self.job_mode = job_mode
        self.jobs: dict[str, float] = {}
        self.poll_countdown = 2  # polls before "done"

    async def submit(self, version: ContentVersionRecord, brief_text: str) -> ScoreSubmission:
        item = self.queue.pop(0)
        if isinstance(item, Exception):
            raise item
        if self.job_mode:
            job_id = f"job-{len(self.jobs)}"
            self.jobs[job_id] = item
            return ScoreSubmission(job_id=job_id)
        return ScoreSubmission(result=make_analysis(item))

    async def poll(self, job_id: str) -> JobPoll:
        self.poll_countdown -= 1
        if self.poll_countdown > 0:
            return JobPoll(status="analyzing")
        return JobPoll(status="done", result=make_analysis(self.jobs[job_id]))


class FakeMetrics:
    async def snapshot(
        self, campaign_id: UUID, publications: list[PublicationRecord], day: str
    ) -> list[MetricsSnapshot]:
        return [
            MetricsSnapshot(
                campaign_id=campaign_id,
                snapshot_day=day,
                platform=p.platform,
                views=1000,
                likes=80,
                comment_count=12,
                engagement_rate=0.092,
                raw={"post_url": p.post_url},
            )
            for p in publications
        ]


GOOD_PROBE = GateProbe(
    container="mp4",
    video_codec="h264",
    audio_codec="aac",
    duration_s=14.0,
    width=1080,
    height=1920,
    fps=30.0,
    vfr=False,
    rotation=0,
    hdr=False,
    bitrate_kbps=8000,
    sha256="a" * 64,
    size_bytes=40_000_000,
)


def build_world(
    scores: list[float | Exception], *, job_mode: bool = False, max_iterations: int = 4
) -> dict[str, Any]:
    store = MemoryStore()
    scorer = FakeScorer(scores, job_mode=job_mode)
    deps = GraphDeps(
        store=store,
        scorer=scorer,
        metrics_source=FakeMetrics(),
        poll_interval_s=0.01,
        poll_max_attempts=5,
        monitoring_days=2,
    )
    checkpointer = InMemorySaver()
    runtime = CampaignRuntime(deps, checkpointer=checkpointer)
    rules = RulesEngine()
    return {
        "store": store,
        "deps": deps,
        "checkpointer": checkpointer,
        "runtime": runtime,
        "operator": OperatorService(store, runtime),
        "creator": CreatorService(store, runtime, rules),
        "scorer": scorer,
        "max_iterations": max_iterations,
    }


async def start_campaign(world: dict[str, Any]) -> UUID:
    record = await world["operator"].create_campaign(
        trend_snapshot=TREND,
        creator_id="creator-1",
        publish_targets=["tiktok"],
        max_iterations=world["max_iterations"],
    )
    return record.campaign_id


async def submit(world: dict[str, Any], brief_id: UUID, sha: str = "b" * 64) -> dict[str, Any]:
    probe = GOOD_PROBE.model_copy(update={"sha256": sha})
    return await world["creator"].submit_draft(
        "creator-1",
        brief_id,
        probe=probe,
        media_type="video",
        asset_ref=f"assets/{sha}.mp4",
    )


async def get_brief_id(world: dict[str, Any], campaign_id: UUID) -> UUID:
    campaign = await world["store"].get_campaign(campaign_id)
    assert campaign.brief_id is not None
    return campaign.brief_id


async def test_full_lifecycle_with_restart() -> None:
    world = build_world(scores=[6.0, 8.2])
    campaign_id = await start_campaign(world)

    campaign = await world["store"].get_campaign(campaign_id)
    assert campaign.status == CampaignStatus.AWAITING_DRAFT
    briefs = await world["creator"].list_assigned_briefs("creator-1")
    assert len(briefs) == 1 and briefs[0]["trend_summary"] == "Pass the phone"

    brief_id = await get_brief_id(world, campaign_id)
    result = await submit(world, brief_id, sha="1" * 64)
    assert (await world["store"].get_campaign(campaign_id)).status == CampaignStatus.REVISING

    feedback = await world["creator"].get_feedback("creator-1", UUID(result["draft_id"]))
    assert feedback["outcome"] == "revise"
    assert feedback["revision_brief"]["objective"] == "move the payoff earlier"
    assert feedback["brief_fit_score"] == 7.5

    # CHAOS: simulate process restart — new runtime over the same checkpointer.
    runtime2 = CampaignRuntime(world["deps"], checkpointer=world["checkpointer"])
    from maistro.gate.rules import RulesEngine as RE

    world["runtime"] = runtime2
    world["operator"] = OperatorService(world["store"], runtime2)
    world["creator"] = CreatorService(world["store"], runtime2, RE())

    result2 = await submit(world, brief_id, sha="2" * 64)
    assert (
        await world["store"].get_campaign(campaign_id)
    ).status == CampaignStatus.AWAITING_APPROVAL
    feedback2 = await world["creator"].get_feedback("creator-1", UUID(result2["draft_id"]))
    assert feedback2["outcome"] == "proceed_to_approval"

    # Double submit while awaiting approval is rejected cleanly.
    with pytest.raises(ServiceError) as excinfo:
        await submit(world, brief_id, sha="3" * 64)
    assert excinfo.value.status_code == 409

    await world["operator"].approve(
        campaign_id,
        approver_id="approver-1",
        brief_fit_rubric={"hook_present": True, "format_followed": True},
    )
    assert (await world["store"].get_campaign(campaign_id)).status == CampaignStatus.APPROVED

    await world["operator"].record_publication(
        campaign_id,
        operator_id="op-1",
        publications=[{"platform": "tiktok", "post_url": "https://tiktok.com/@x/video/1"}],
    )
    assert (await world["store"].get_campaign(campaign_id)).status == CampaignStatus.MONITORING

    ticked = await world["operator"].tick_all_monitoring(day="2026-09-05")
    assert ticked == 1
    await world["operator"].tick_all_monitoring(day="2026-09-06")

    final = await world["store"].get_campaign(campaign_id)
    assert final.status == CampaignStatus.CLOSED
    assert len(world["store"].metrics) == 2
    assert len(world["store"].learnings) == 1
    learning = world["store"].learnings[0]
    assert learning.predicted_score == 8.2
    assert learning.insight_status == "candidate"

    events = [e.event for e in await world["store"].list_audit(campaign_id)]
    assert events[0] == "brief.generated"
    assert "approval.approved" in events
    assert events[-1] == "campaign.closed"


async def test_gate_blocker_never_creates_a_version() -> None:
    world = build_world(scores=[9.0])
    campaign_id = await start_campaign(world)
    brief_id = await get_brief_id(world, campaign_id)
    bad = GOOD_PROBE.model_copy(update={"duration_s": 200.0, "sha256": "c" * 64})
    with pytest.raises(ServiceError) as excinfo:
        await world["creator"].submit_draft(
            "creator-1", brief_id, probe=bad, media_type="video", asset_ref="assets/bad.mp4"
        )
    assert excinfo.value.status_code == 422
    assert excinfo.value.extra["status"] == "rejected"
    codes = {i["code"] for i in excinfo.value.extra["issues"]}
    assert "brief.duration_over_cap" in codes
    assert await world["store"].latest_version(campaign_id) is None
    assert (
        await world["store"].get_campaign(campaign_id)
    ).status == CampaignStatus.AWAITING_DRAFT


async def test_loop_exhaustion_routes_to_approval() -> None:
    world = build_world(scores=[5.0, 5.5], max_iterations=2)
    campaign_id = await start_campaign(world)
    brief_id = await get_brief_id(world, campaign_id)
    await submit(world, brief_id, sha="4" * 64)
    assert (await world["store"].get_campaign(campaign_id)).status == CampaignStatus.REVISING
    await submit(world, brief_id, sha="5" * 64)
    campaign = await world["store"].get_campaign(campaign_id)
    assert campaign.status == CampaignStatus.AWAITING_APPROVAL
    state = await world["runtime"].get_state(campaign_id)
    assert state.loop_exhausted is True


async def test_submit_final_reaches_approval() -> None:
    world = build_world(scores=[5.0])
    campaign_id = await start_campaign(world)
    brief_id = await get_brief_id(world, campaign_id)
    result = await submit(world, brief_id, sha="6" * 64)
    await world["creator"].submit_final("creator-1", UUID(result["draft_id"]))
    assert (
        await world["store"].get_campaign(campaign_id)
    ).status == CampaignStatus.AWAITING_APPROVAL


async def test_scoring_failure_escalates_and_recovers() -> None:
    world = build_world(
        scores=[AdapterError("f1x8", "GPU pool exhausted", retryable=True), 9.0]
    )
    campaign_id = await start_campaign(world)
    brief_id = await get_brief_id(world, campaign_id)
    await submit(world, brief_id, sha="7" * 64)
    assert (await world["store"].get_campaign(campaign_id)).status == CampaignStatus.ESCALATED

    await world["operator"].resolve_escalation(
        campaign_id, operator_id="op-1", action="retry_scoring"
    )
    assert (
        await world["store"].get_campaign(campaign_id)
    ).status == CampaignStatus.AWAITING_APPROVAL


async def test_escalation_cancel() -> None:
    world = build_world(scores=[AdapterError("f1x8", "down", retryable=True)])
    campaign_id = await start_campaign(world)
    brief_id = await get_brief_id(world, campaign_id)
    await submit(world, brief_id, sha="8" * 64)
    await world["operator"].resolve_escalation(campaign_id, operator_id="op-1", action="cancel")
    assert (await world["store"].get_campaign(campaign_id)).status == CampaignStatus.CANCELLED


async def test_video_job_polling_path() -> None:
    world = build_world(scores=[8.5], job_mode=True)
    campaign_id = await start_campaign(world)
    brief_id = await get_brief_id(world, campaign_id)
    await submit(world, brief_id, sha="9" * 64)
    assert (
        await world["store"].get_campaign(campaign_id)
    ).status == CampaignStatus.AWAITING_APPROVAL
    version = await world["store"].latest_version(campaign_id)
    assert version.f1x8_job_id == "job-0"
    assert version.analysis_result["score"] == 8.5


async def test_rejection_routes_back_to_revision() -> None:
    world = build_world(scores=[8.0, 9.0])
    campaign_id = await start_campaign(world)
    brief_id = await get_brief_id(world, campaign_id)
    await submit(world, brief_id, sha="d" * 64)
    await world["operator"].reject(campaign_id, approver_id="approver-1", note="hook off-brand")
    assert (await world["store"].get_campaign(campaign_id)).status == CampaignStatus.REVISING
    await submit(world, brief_id, sha="e" * 64)
    assert (
        await world["store"].get_campaign(campaign_id)
    ).status == CampaignStatus.AWAITING_APPROVAL
