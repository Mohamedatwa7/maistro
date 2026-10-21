"""Graph nodes (ARCHITECTURE.md §4.2).

Rules encoded here:
- The store's campaigns.status is the source of truth; every status change
  goes through store.transition() which validates the state machine. Nodes
  mirror the resulting status into graph state.
- Events triggered by humans (draft.submitted, approval.*, publish.*,
  operator.*) are transitioned by the SERVICE before it resumes the graph;
  nodes only transition internal events (brief.*, f1x8.*, score.*,
  monitoring.*, campaign.closed).
- interrupt() re-executes the node body on resume — code before an
  interrupt must be pure or idempotent.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

from langgraph.types import interrupt

from maistro.adapters.base import AdapterError
from maistro.briefs import compose_brief, render_brief_text
from maistro.generated.f1x8 import ImageAnalysisResult, VideoAnalysisResult
from maistro.graph.deps import GraphDeps
from maistro.graph.state import (
    AnalysisResult,
    ApprovalRef,
    CampaignState,
    CampaignStatus,
    DraftRef,
    PublishOutcome,
)
from maistro.store import BriefRecord, LearningRecord
from maistro.telemetry import get_logger

Node = Callable[[CampaignState], Awaitable[dict[str, Any]]]

log = get_logger("graph.nodes")


def _validate_analysis(payload: dict[str, Any], media_type: str) -> AnalysisResult:
    model = VideoAnalysisResult if media_type == "video" else ImageAnalysisResult
    return model.model_validate(payload)


def make_nodes(deps: GraphDeps) -> dict[str, Node]:
    store = deps.store

    async def pick_trend(state: CampaignState) -> dict[str, Any]:
        # The trend snapshot is frozen at kickoff (service). This node exists
        # as the future home of automated selection; today it validates.
        if state.trend is None:  # pragma: no cover - kickoff always sets it
            raise ValueError("campaign started without a trend snapshot")
        return {}

    async def generate_brief(state: CampaignState) -> dict[str, Any]:
        campaign = await store.get_campaign(state.campaign_id)
        assert campaign is not None
        if campaign.brief_id is not None:
            # Replay after crash — brief already composed.
            return {"brief_id": campaign.brief_id, "status": campaign.status}
        body = compose_brief(
            state.trend,
            platforms=[p.value for p in state.publish_targets],
            learnings=state.learnings_context,
        )
        brief = BriefRecord(brief_id=uuid4(), campaign_id=state.campaign_id, body=body)
        await store.save_brief(brief)
        await store.transition(state.campaign_id, "brief.generated", actor="service")
        status = await store.transition(state.campaign_id, "brief.assigned", actor="service")
        log.info("brief_generated", campaign_id=str(state.campaign_id))
        return {"brief_id": brief.brief_id, "status": status}

    async def await_draft(state: CampaignState) -> dict[str, Any]:
        payload = interrupt(
            {
                "kind": "await_draft",
                "campaign_id": str(state.campaign_id),
                "brief_id": str(state.brief_id),
                "next_iteration": state.iteration + 1,
            }
        )
        draft = DraftRef.model_validate(payload["draft"])
        return {
            "current_draft": draft,
            "iteration": payload["iteration"],
            "status": CampaignStatus.SCORING,  # service transitioned draft.submitted
            "final_submitted": False,
            "analysis_result": None,
            "f1x8_job_id": None,
            "poll_attempts": 0,
        }

    async def score_asset(state: CampaignState) -> dict[str, Any]:
        assert state.current_draft is not None
        version = await store.get_version(state.current_draft.content_version_id)
        assert version is not None
        # Crash-replay recovery: results/jobs already recorded win.
        if version.analysis_result is not None:
            analysis = _validate_analysis(version.analysis_result, version.media_type)
            status = await store.transition(
                state.campaign_id, "f1x8.done", actor="service", detail={"score": analysis.score}
            )
            return {"analysis_result": analysis, "status": status}
        if version.f1x8_job_id is not None:
            return {"f1x8_job_id": version.f1x8_job_id}

        brief = await store.get_brief(state.brief_id) if state.brief_id else None
        brief_text = render_brief_text(brief.body) if brief else ""
        try:
            submission = await deps.scorer.submit(version, brief_text)
        except AdapterError as exc:
            status = await store.transition(
                state.campaign_id, "f1x8.failed", actor="service", detail={"error": exc.detail}
            )
            return {"status": status, "escalation_reason": f"scoring failed: {exc.detail}"}
        if submission.result is not None:
            analysis = _validate_analysis(submission.result, version.media_type)
            await store.set_analysis(version.content_version_id, None, submission.result)
            status = await store.transition(
                state.campaign_id, "f1x8.done", actor="service", detail={"score": analysis.score}
            )
            return {"analysis_result": analysis, "status": status}
        assert submission.job_id is not None
        await store.set_analysis(version.content_version_id, submission.job_id, None)
        return {"f1x8_job_id": submission.job_id, "poll_attempts": 0}

    async def poll_f1x8(state: CampaignState) -> dict[str, Any]:
        assert state.f1x8_job_id is not None and state.current_draft is not None
        await asyncio.sleep(deps.poll_interval_s)
        try:
            poll = await deps.scorer.poll(state.f1x8_job_id)
        except AdapterError as exc:
            poll_error = exc.detail
            poll = None
        if poll is not None and poll.status == "done" and poll.result is not None:
            version = await store.get_version(state.current_draft.content_version_id)
            assert version is not None
            analysis = _validate_analysis(poll.result, version.media_type)
            await store.set_analysis(version.content_version_id, None, poll.result)
            status = await store.transition(
                state.campaign_id, "f1x8.done", actor="service", detail={"score": analysis.score}
            )
            return {"analysis_result": analysis, "status": status}
        failed = (
            poll is not None and poll.status in ("error", "not_found")
        ) or state.poll_attempts + 1 >= deps.poll_max_attempts
        if poll is None or failed:
            reason = poll.error or poll.status if poll is not None else poll_error
            status = await store.transition(
                state.campaign_id, "f1x8.failed", actor="service", detail={"error": str(reason)}
            )
            return {"status": status, "escalation_reason": f"scoring failed: {reason}"}
        return {"poll_attempts": state.poll_attempts + 1}

    async def evaluate_score(state: CampaignState) -> dict[str, Any]:
        assert state.analysis_result is not None
        score = state.analysis_result.score
        updates: dict[str, Any] = {}
        if state.final_submitted:
            event = "creator.final_submitted"
        elif score >= state.score_threshold:
            event = "score.passed"
        elif state.iteration >= state.max_iterations:
            event = "score.loop_exhausted"
            updates["loop_exhausted"] = True
        else:
            event = "score.below_threshold"
        status = await store.transition(
            state.campaign_id, event, actor="service", detail={"score": score}
        )
        return {"status": status, **updates}

    async def request_revision(state: CampaignState) -> dict[str, Any]:
        assert state.analysis_result is not None
        verdict = state.analysis_result.verdict
        payload = interrupt(
            {
                "kind": "revision",
                "campaign_id": str(state.campaign_id),
                "iteration": state.iteration,
                "max_iterations": state.max_iterations,
                "score": state.analysis_result.score,
                "summary": verdict.summary,
                "revision_brief": verdict.revision_brief.model_dump(),
            }
        )
        if payload.get("kind") == "final":
            # Service transitioned creator.final_submitted (REVISING -> AWAITING_APPROVAL)
            return {"final_submitted": True, "status": CampaignStatus.AWAITING_APPROVAL}
        draft = DraftRef.model_validate(payload["draft"])
        return {
            "current_draft": draft,
            "iteration": payload["iteration"],
            "status": CampaignStatus.SCORING,
            "analysis_result": None,
            "f1x8_job_id": None,
            "poll_attempts": 0,
        }

    async def approval_gate(state: CampaignState) -> dict[str, Any]:
        assert state.current_draft is not None
        payload = interrupt(
            {
                "kind": "approval",
                "campaign_id": str(state.campaign_id),
                "content_version_id": str(state.current_draft.content_version_id),
                "score": state.analysis_result.score if state.analysis_result else None,
                "loop_exhausted": state.loop_exhausted,
                "final_submitted": state.final_submitted,
            }
        )
        decision = payload.get("decision") or payload.get("action")
        if decision == "approved":
            return {
                "approval": ApprovalRef.model_validate(payload["approval"]),
                "status": CampaignStatus.APPROVED,
            }
        if decision == "rejected":
            return {"status": CampaignStatus.REVISING}
        return {"status": CampaignStatus.CANCELLED}

    async def record_publication(state: CampaignState) -> dict[str, Any]:
        assert state.current_draft is not None
        payload = interrupt(
            {
                "kind": "record_publication",
                "campaign_id": str(state.campaign_id),
                "content_version_id": str(state.current_draft.content_version_id),
                "asset_ref": state.current_draft.asset_ref,
                "platforms": [p.value for p in state.publish_targets],
            }
        )
        outcomes = [PublishOutcome.model_validate(p) for p in payload["publications"]]
        status = await store.transition(
            state.campaign_id, "monitoring.scheduled", actor="service"
        )
        return {
            "publish_results": outcomes,
            "monitoring_ticks_remaining": deps.monitoring_days,
            "status": status,
        }

    async def monitor(state: CampaignState) -> dict[str, Any]:
        if (state.monitoring_ticks_remaining or 0) <= 0:
            status = await store.transition(
                state.campaign_id, "monitoring.complete", actor="service"
            )
            return {"status": status}
        payload = interrupt(
            {
                "kind": "monitor_tick",
                "campaign_id": str(state.campaign_id),
                "ticks_remaining": state.monitoring_ticks_remaining,
            }
        )
        publications = [
            p
            for p in await store.list_publications(state.campaign_id)
            if p.post_url is not None
        ]
        snapshots = await deps.metrics_source.snapshot(
            state.campaign_id, publications, payload["day"]
        )
        for snapshot in snapshots:
            await store.add_metrics(snapshot)
        return {"monitoring_ticks_remaining": (state.monitoring_ticks_remaining or 1) - 1}

    async def write_learnings(state: CampaignState) -> dict[str, Any]:
        assert state.analysis_result is not None
        campaign_metrics = await store.list_metrics(state.campaign_id)
        actual: dict[str, Any] = {
            "snapshots": len(campaign_metrics),
            "views": max((m.views or 0 for m in campaign_metrics), default=0),
            "comment_count": max((m.comment_count or 0 for m in campaign_metrics), default=0),
            "engagement_rate": max(
                (m.engagement_rate or 0.0 for m in campaign_metrics), default=0.0
            ),
        }
        await store.add_learning(
            LearningRecord(
                learning_id=uuid4(),
                campaign_id=state.campaign_id,
                predicted_score=state.analysis_result.score,
                actual_metrics=actual,
                insight=(
                    f"candidate: F1X8 predicted {state.analysis_result.score:.1f}; "
                    f"observed {actual['views']} views, "
                    f"{actual['comment_count']} comments over "
                    f"{actual['snapshots']} snapshots — review weekly (ACCURACY.md §2)"
                ),
            )
        )
        status = await store.transition(state.campaign_id, "campaign.closed", actor="service")
        return {"status": status}

    async def escalate(state: CampaignState) -> dict[str, Any]:
        payload = interrupt(
            {
                "kind": "escalated",
                "campaign_id": str(state.campaign_id),
                "reason": state.escalation_reason,
            }
        )
        # Service applied the operator.* / campaign.cancelled transition.
        action = payload["action"]
        if action == "retry_scoring":
            return {
                "status": CampaignStatus.SCORING,
                "escalation_reason": None,
                "analysis_result": None,
                "f1x8_job_id": None,
                "poll_attempts": 0,
            }
        if action == "route_to_approval":
            return {"status": CampaignStatus.AWAITING_APPROVAL}
        return {"status": CampaignStatus.CANCELLED}

    return {
        "pick_trend": pick_trend,
        "generate_brief": generate_brief,
        "await_draft": await_draft,
        "score_asset": score_asset,
        "poll_f1x8": poll_f1x8,
        "evaluate_score": evaluate_score,
        "request_revision": request_revision,
        "approval_gate": approval_gate,
        "record_publication": record_publication,
        "monitor": monitor,
        "write_learnings": write_learnings,
        "escalate": escalate,
    }
