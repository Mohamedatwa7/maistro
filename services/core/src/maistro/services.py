"""Creator and operator services — the single business-logic layer both the
MCP server and the REST API call (CONTRACTS.md §2; one service layer, two
surfaces).

Rule of ownership: human-triggered state-machine events (draft.submitted,
creator.final_submitted, approval.*, publish.*, operator.*, cancel) are
transitioned HERE, before the graph is resumed; graph nodes transition only
internal events."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from maistro.gate.rules import BriefConstraints, GateProbe, RulesEngine
from maistro.generated.entities.validation_report import Status, ValidationReport
from maistro.graph.runtime import CampaignRuntime
from maistro.graph.state import CampaignState, CampaignStatus, Platform
from maistro.graph.transitions import CANCEL_EVENT, IllegalTransition
from maistro.store import (
    ApprovalRecord,
    CampaignRecord,
    CampaignStore,
    ContentVersionRecord,
    PublicationRecord,
)

SUBMITTABLE = {CampaignStatus.AWAITING_DRAFT, CampaignStatus.REVISING}


class ServiceError(Exception):
    def __init__(self, status_code: int, code: str, detail: str, extra: Any = None) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.code = code
        self.detail = detail
        self.extra = extra


class OperatorService:
    def __init__(self, store: CampaignStore, runtime: CampaignRuntime) -> None:
        self.store = store
        self.runtime = runtime

    async def create_campaign(
        self,
        *,
        trend_snapshot: dict[str, Any],
        creator_id: str,
        publish_targets: list[str],
        score_threshold: float = 7.0,
        max_iterations: int = 4,
    ) -> CampaignRecord:
        campaign_id = uuid4()
        targets = [Platform(p) for p in publish_targets]
        record = CampaignRecord(
            campaign_id=campaign_id,
            status=CampaignStatus.TREND_SELECTED,
            trend_ref=trend_snapshot,
            creator_id=creator_id,
            max_iterations=max_iterations,
            score_threshold=score_threshold,
            publish_targets=targets,
        )
        await self.store.create_campaign(record)
        state = CampaignState(
            campaign_id=campaign_id,
            status=CampaignStatus.TREND_SELECTED,
            trend=trend_snapshot,  # type: ignore[arg-type]  # validated by CampaignState
            max_iterations=max_iterations,
            score_threshold=score_threshold,
            publish_targets=targets,
        )
        # Runs pick_trend -> generate_brief, then parks at await_draft.
        await self.runtime.start(state)
        return record

    async def _require(self, campaign_id: UUID, statuses: set[CampaignStatus]) -> CampaignRecord:
        campaign = await self.store.get_campaign(campaign_id)
        if campaign is None:
            raise ServiceError(404, "not_found", f"campaign {campaign_id} not found")
        if campaign.status not in statuses:
            raise ServiceError(
                409,
                "wrong_status",
                f"campaign is {campaign.status.value}; expected "
                f"{sorted(s.value for s in statuses)}",
            )
        return campaign

    async def approve(
        self,
        campaign_id: UUID,
        *,
        approver_id: str,
        note: str | None = None,
        brief_fit_rubric: dict[str, bool] | None = None,
    ) -> ApprovalRecord:
        await self._require(campaign_id, {CampaignStatus.AWAITING_APPROVAL})
        version = await self.store.latest_version(campaign_id)
        if version is None:
            raise ServiceError(409, "no_version", "campaign has no content version")
        approval = ApprovalRecord(
            approval_id=uuid4(),
            campaign_id=campaign_id,
            content_version_id=version.content_version_id,
            decision="approved",
            approver_id=approver_id,
            note=note,
            brief_fit_rubric=brief_fit_rubric,
        )
        await self.store.add_approval(approval)
        await self.store.transition(
            campaign_id, "approval.approved", actor=f"approver:{approver_id}"
        )
        await self.runtime.resume(
            campaign_id,
            {
                "decision": "approved",
                "approval": {
                    "approval_id": str(approval.approval_id),
                    "content_version_id": str(version.content_version_id),
                    "decided_at": approval.decided_at.isoformat(),
                },
            },
        )
        return approval

    async def reject(self, campaign_id: UUID, *, approver_id: str, note: str) -> None:
        await self._require(campaign_id, {CampaignStatus.AWAITING_APPROVAL})
        version = await self.store.latest_version(campaign_id)
        if version is None:
            raise ServiceError(409, "no_version", "campaign has no content version")
        await self.store.add_approval(
            ApprovalRecord(
                approval_id=uuid4(),
                campaign_id=campaign_id,
                content_version_id=version.content_version_id,
                decision="rejected",
                approver_id=approver_id,
                note=note,
            )
        )
        await self.store.transition(
            campaign_id, "approval.rejected", actor=f"approver:{approver_id}"
        )
        await self.runtime.resume(campaign_id, {"decision": "rejected", "note": note})

    async def record_publication(
        self, campaign_id: UUID, *, operator_id: str, publications: list[dict[str, Any]]
    ) -> list[PublicationRecord]:
        """Manual-mode publishing: the operator posted the sealed asset and
        records the resulting URLs. Swapped for the automated publish node
        when platform API access lands."""
        campaign = await self._require(campaign_id, {CampaignStatus.APPROVED})
        version = await self.store.latest_version(campaign_id)
        assert version is not None
        actor = f"operator:{operator_id}"
        await self.store.transition(campaign_id, "publish.requested", actor=actor)
        records: list[PublicationRecord] = []
        allowed = {p.value for p in campaign.publish_targets}
        for pub in publications:
            if pub["platform"] not in allowed:
                raise ServiceError(
                    422, "platform_not_targeted", f"{pub['platform']} not in campaign targets"
                )
            records.append(
                PublicationRecord(
                    publish_record_id=uuid4(),
                    campaign_id=campaign_id,
                    content_version_id=version.content_version_id,
                    platform=Platform(pub["platform"]),
                    status="published",
                    platform_post_id=pub.get("platform_post_id"),
                    post_url=pub.get("post_url"),
                    published_at=datetime.now(UTC),
                )
            )
        for record in records:
            await self.store.add_publication(record)
        await self.store.transition(
            campaign_id,
            "publish.confirmed",
            actor=actor,
            detail={"urls": [r.post_url for r in records]},
        )
        await self.runtime.resume(
            campaign_id,
            {
                "publications": [
                    {
                        "platform": r.platform.value,
                        "publish_record_id": str(r.publish_record_id),
                        "status": r.status,
                        "platform_post_id": r.platform_post_id,
                        "post_url": r.post_url,
                    }
                    for r in records
                ]
            },
        )
        return records

    async def monitor_tick(self, campaign_id: UUID, *, day: str) -> None:
        await self._require(campaign_id, {CampaignStatus.MONITORING})
        await self.runtime.resume(campaign_id, {"day": day})

    async def tick_all_monitoring(self, *, day: str) -> int:
        """Scheduler entry point: one daily tick for every monitoring campaign."""
        campaigns = await self.store.list_campaigns(statuses={CampaignStatus.MONITORING})
        for campaign in campaigns:
            await self.monitor_tick(campaign.campaign_id, day=day)
        return len(campaigns)

    async def resolve_escalation(
        self, campaign_id: UUID, *, operator_id: str, action: str
    ) -> None:
        await self._require(campaign_id, {CampaignStatus.ESCALATED})
        actor = f"operator:{operator_id}"
        events = {
            "retry_scoring": "operator.resume_scoring",
            "route_to_approval": "operator.route_to_approval",
            "cancel": CANCEL_EVENT,
        }
        if action not in events:
            raise ServiceError(422, "bad_action", f"unknown escalation action '{action}'")
        try:
            await self.store.transition(campaign_id, events[action], actor=actor)
        except IllegalTransition as exc:
            raise ServiceError(409, "illegal_transition", str(exc)) from exc
        if action == "retry_scoring":
            version = await self.store.latest_version(campaign_id)
            if version is not None:
                version.f1x8_job_id = None
                version.analysis_result = None
        await self.runtime.resume(campaign_id, {"action": action})


class CreatorService:
    def __init__(
        self, store: CampaignStore, runtime: CampaignRuntime, rules: RulesEngine
    ) -> None:
        self.store = store
        self.runtime = runtime
        self.rules = rules

    async def _own_campaign(self, creator_id: str, campaign_id: UUID) -> CampaignRecord:
        campaign = await self.store.get_campaign(campaign_id)
        if campaign is None or campaign.creator_id != creator_id:
            raise ServiceError(404, "not_found", "no such campaign for this creator")
        return campaign

    async def list_assigned_briefs(self, creator_id: str) -> list[dict[str, Any]]:
        campaigns = await self.store.list_campaigns(
            creator_id=creator_id,
            statuses={
                CampaignStatus.AWAITING_DRAFT,
                CampaignStatus.SCORING,
                CampaignStatus.REVISING,
                CampaignStatus.AWAITING_APPROVAL,
            },
        )
        out = []
        for campaign in campaigns:
            brief = (
                await self.store.get_brief(campaign.brief_id) if campaign.brief_id else None
            )
            body = brief.body if brief else {}
            out.append(
                {
                    "campaign_id": str(campaign.campaign_id),
                    "brief_id": str(campaign.brief_id) if campaign.brief_id else None,
                    "trend_summary": body.get("trend", {}).get("name", ""),
                    "format": body.get("format", ""),
                    "deadline": body.get("deadline"),
                    "status": campaign.status.value,
                }
            )
        return out

    async def get_brief(self, creator_id: str, brief_id: UUID) -> dict[str, Any]:
        brief = await self.store.get_brief(brief_id)
        if brief is None:
            raise ServiceError(404, "not_found", "no such brief")
        await self._own_campaign(creator_id, brief.campaign_id)
        return {"brief_id": str(brief_id), "campaign_id": str(brief.campaign_id), **brief.body}

    def _brief_constraints(self, body: dict[str, Any]) -> BriefConstraints:
        constraints = body.get("constraints", {})
        return BriefConstraints(
            duration_cap_s=constraints.get("duration_cap_s"),
            requires_audio=bool(constraints.get("requires_audio", False)),
        )

    async def check_asset(
        self, creator_id: str, brief_id: UUID, probe: GateProbe, media_type: str
    ) -> ValidationReport:
        brief = await self.store.get_brief(brief_id)
        if brief is None:
            raise ServiceError(404, "not_found", "no such brief")
        campaign = await self._own_campaign(creator_id, brief.campaign_id)
        return self.rules.evaluate(
            probe,
            media_type,
            [p.value for p in campaign.publish_targets],
            brief=self._brief_constraints(brief.body),
            brief_id=brief_id,
        )

    async def submit_draft(
        self,
        creator_id: str,
        brief_id: UUID,
        *,
        probe: GateProbe,
        media_type: str,
        asset_ref: str,
        notes: str | None = None,
    ) -> dict[str, Any]:
        brief = await self.store.get_brief(brief_id)
        if brief is None:
            raise ServiceError(404, "not_found", "no such brief")
        campaign = await self._own_campaign(creator_id, brief.campaign_id)
        if campaign.status == CampaignStatus.SCORING:
            raise ServiceError(409, "already_submitted", "a submission is still scoring")
        if campaign.status in (CampaignStatus.CLOSED, CampaignStatus.CANCELLED):
            raise ServiceError(410, "campaign_closed", "campaign is closed")
        if campaign.status not in SUBMITTABLE:
            raise ServiceError(
                409, "wrong_status", f"campaign is {campaign.status.value}"
            )

        # Postability gate (docs/POSTABILITY.md) — a rejected file never
        # becomes a content version and never wakes the graph.
        report = self.rules.evaluate(
            probe,
            media_type,
            [p.value for p in campaign.publish_targets],
            brief=self._brief_constraints(brief.body),
            brief_id=brief_id,
        )
        if report.status == Status.rejected:
            raise ServiceError(
                422,
                "asset_invalid",
                "asset failed the postability gate",
                extra=report.model_dump(by_alias=True, mode="json"),
            )

        iteration = campaign.current_version + 1
        version = ContentVersionRecord(
            content_version_id=uuid4(),
            campaign_id=campaign.campaign_id,
            iteration=iteration,
            asset_ref=asset_ref,
            media_type=media_type,
            submitted_by=creator_id,
            creator_notes=notes,
            validation_report=report.model_dump(by_alias=True, mode="json"),
            asset_sha256=probe.sha256,
        )
        await self.store.add_version(version)
        await self.store.transition(
            campaign.campaign_id,
            "draft.submitted",
            actor=f"creator:{creator_id}",
            detail={"iteration": iteration, "sha256": probe.sha256},
        )
        await self.runtime.resume(
            campaign.campaign_id,
            {
                "kind": "draft",
                "iteration": iteration,
                "draft": {
                    "content_version_id": str(version.content_version_id),
                    "asset_ref": asset_ref,
                    "media_type": media_type,
                },
            },
        )
        updated = await self.store.get_campaign(campaign.campaign_id)
        assert updated is not None
        return {
            "draft_id": str(version.content_version_id),
            "campaign_id": str(campaign.campaign_id),
            "iteration": iteration,
            "status": "scoring" if updated.status == CampaignStatus.SCORING else "scored",
            "validation": report.model_dump(by_alias=True, mode="json"),
        }

    async def get_feedback(self, creator_id: str, draft_id: UUID) -> dict[str, Any]:
        version = await self.store.get_version(draft_id)
        if version is None:
            raise ServiceError(404, "not_found", "no such draft")
        campaign = await self._own_campaign(creator_id, version.campaign_id)
        analysis = version.analysis_result
        if analysis is None:
            return {
                "draft_id": str(draft_id),
                "status": "scoring",
                "validation": version.validation_report,
            }
        verdict = analysis.get("verdict", {})
        outcome = "revise"
        if campaign.status in (
            CampaignStatus.AWAITING_APPROVAL,
            CampaignStatus.APPROVED,
            CampaignStatus.PUBLISHING,
            CampaignStatus.PUBLISHED,
            CampaignStatus.MONITORING,
        ):
            outcome = "proceed_to_approval"
        elif campaign.status == CampaignStatus.REVISING and (
            campaign.current_version >= campaign.max_iterations
        ):
            outcome = "loop_exhausted"
        return {
            "draft_id": str(draft_id),
            "status": "scored",
            "validation": version.validation_report,
            "score": analysis.get("score"),
            "summary": verdict.get("summary"),
            "strengths": verdict.get("strengths", []),
            "risks": verdict.get("risks", []),
            "revision_brief": verdict.get("revision_brief"),
            "brief_fit_score": analysis.get("context_score"),
            "iteration": version.iteration,
            "max_iterations": campaign.max_iterations,
            "outcome": outcome,
        }

    async def submit_final(self, creator_id: str, draft_id: UUID) -> dict[str, Any]:
        version = await self.store.get_version(draft_id)
        if version is None:
            raise ServiceError(404, "not_found", "no such draft")
        campaign = await self._own_campaign(creator_id, version.campaign_id)
        if campaign.status != CampaignStatus.REVISING:
            raise ServiceError(
                409, "wrong_status", f"campaign is {campaign.status.value}, not revising"
            )
        await self.store.transition(
            campaign.campaign_id, "creator.final_submitted", actor=f"creator:{creator_id}"
        )
        await self.runtime.resume(campaign.campaign_id, {"kind": "final"})
        return {"status": "awaiting_approval"}

    async def get_campaign_status(self, creator_id: str, campaign_id: UUID) -> dict[str, Any]:
        campaign = await self._own_campaign(creator_id, campaign_id)
        audit = await self.store.list_audit(campaign_id)
        return {
            "campaign_id": str(campaign_id),
            "status": campaign.status.value,
            "current_iteration": campaign.current_version,
            "timeline": [
                {"event": e.event, "at": e.at.isoformat(), "actor": e.actor} for e in audit
            ],
        }
