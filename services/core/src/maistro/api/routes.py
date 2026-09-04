"""REST surface: health + operator/approver endpoints (ARCHITECTURE §4.5).

Operator auth: X-Operator-Key checked against MAISTRO_OPERATOR_API_KEY when
set; unset = open (local dev only — staging/prod set it, SECRETS.md)."""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from maistro import __version__
from maistro.config import get_settings
from maistro.services import OperatorService, ServiceError

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


def _operator(request: Request, key: str | None) -> OperatorService:
    expected = get_settings().operator_api_key
    if expected and key != expected:
        raise HTTPException(status_code=401, detail="invalid operator key")
    service: OperatorService = request.app.state.operator_service
    return service


def _http(exc: ServiceError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={"code": exc.code, "detail": exc.detail, "extra": exc.extra},
    )


OperatorKey = Annotated[str | None, Header(alias="X-Operator-Key")]


class CreateCampaignRequest(BaseModel):
    trend_snapshot: dict[str, Any]
    creator_id: str
    publish_targets: list[str] = Field(default_factory=lambda: ["tiktok"])
    score_threshold: float = 7.0
    max_iterations: int = 4


@router.post("/api/campaigns", status_code=201)
async def create_campaign(
    body: CreateCampaignRequest, request: Request, x_operator_key: OperatorKey = None
) -> dict[str, Any]:
    operator = _operator(request, x_operator_key)
    try:
        record = await operator.create_campaign(
            trend_snapshot=body.trend_snapshot,
            creator_id=body.creator_id,
            publish_targets=body.publish_targets,
            score_threshold=body.score_threshold,
            max_iterations=body.max_iterations,
        )
    except ServiceError as exc:
        raise _http(exc) from exc
    campaign = await operator.store.get_campaign(record.campaign_id)
    assert campaign is not None
    return {
        "campaign_id": str(record.campaign_id),
        "status": campaign.status.value,
        "brief_id": str(campaign.brief_id) if campaign.brief_id else None,
    }


@router.get("/api/campaigns")
async def list_campaigns(request: Request, x_operator_key: OperatorKey = None) -> dict[str, Any]:
    operator = _operator(request, x_operator_key)
    campaigns = await operator.store.list_campaigns()
    return {
        "campaigns": [
            {
                "campaign_id": str(c.campaign_id),
                "status": c.status.value,
                "creator_id": c.creator_id,
                "current_version": c.current_version,
                "created_at": c.created_at.isoformat(),
            }
            for c in campaigns
        ]
    }


@router.get("/api/campaigns/{campaign_id}")
async def get_campaign(
    campaign_id: UUID, request: Request, x_operator_key: OperatorKey = None
) -> dict[str, Any]:
    operator = _operator(request, x_operator_key)
    campaign = await operator.store.get_campaign(campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="not found")
    audit = await operator.store.list_audit(campaign_id)
    version = await operator.store.latest_version(campaign_id)
    return {
        "campaign_id": str(campaign_id),
        "status": campaign.status.value,
        "creator_id": campaign.creator_id,
        "brief_id": str(campaign.brief_id) if campaign.brief_id else None,
        "current_version": campaign.current_version,
        "latest_score": (version.analysis_result or {}).get("score") if version else None,
        "timeline": [
            {"event": e.event, "actor": e.actor, "at": e.at.isoformat(), "detail": e.detail}
            for e in audit
        ],
    }


@router.get("/api/campaigns/{campaign_id}/state")
async def get_campaign_state(
    campaign_id: UUID, request: Request, x_operator_key: OperatorKey = None
) -> dict[str, Any]:
    """Live orchestration view: the graph's current state, the interrupt it
    is parked on (if any), and the legal next events."""
    operator = _operator(request, x_operator_key)
    campaign = await operator.store.get_campaign(campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="not found")
    from maistro.graph.transitions import legal_events

    runtime = request.app.state.runtime
    state = await runtime.get_state(campaign_id)
    interrupt = await runtime.pending_interrupt(campaign_id)
    return {
        "campaign_id": str(campaign_id),
        "status": campaign.status.value,
        "legal_events": sorted(legal_events(campaign.status)),
        "pending_interrupt": interrupt,
        "graph_state": state.model_dump(mode="json") if state else None,
    }


class DecisionRequest(BaseModel):
    approver_id: str
    note: str | None = None
    brief_fit_rubric: dict[str, bool] | None = None


@router.post("/api/campaigns/{campaign_id}/approve")
async def approve(
    campaign_id: UUID,
    body: DecisionRequest,
    request: Request,
    x_operator_key: OperatorKey = None,
) -> dict[str, Any]:
    operator = _operator(request, x_operator_key)
    try:
        approval = await operator.approve(
            campaign_id,
            approver_id=body.approver_id,
            note=body.note,
            brief_fit_rubric=body.brief_fit_rubric,
        )
    except ServiceError as exc:
        raise _http(exc) from exc
    return {"approval_id": str(approval.approval_id), "status": "approved"}


@router.post("/api/campaigns/{campaign_id}/reject")
async def reject(
    campaign_id: UUID,
    body: DecisionRequest,
    request: Request,
    x_operator_key: OperatorKey = None,
) -> dict[str, Any]:
    operator = _operator(request, x_operator_key)
    try:
        await operator.reject(campaign_id, approver_id=body.approver_id, note=body.note or "")
    except ServiceError as exc:
        raise _http(exc) from exc
    return {"status": "rejected"}


class PublicationRequest(BaseModel):
    operator_id: str
    publications: list[dict[str, Any]]


@router.post("/api/campaigns/{campaign_id}/publication")
async def record_publication(
    campaign_id: UUID,
    body: PublicationRequest,
    request: Request,
    x_operator_key: OperatorKey = None,
) -> dict[str, Any]:
    operator = _operator(request, x_operator_key)
    try:
        records = await operator.record_publication(
            campaign_id, operator_id=body.operator_id, publications=body.publications
        )
    except ServiceError as exc:
        raise _http(exc) from exc
    return {"recorded": [str(r.publish_record_id) for r in records], "status": "monitoring"}


class EscalationRequest(BaseModel):
    operator_id: str
    action: str  # retry_scoring | route_to_approval | cancel


@router.post("/api/campaigns/{campaign_id}/escalation")
async def resolve_escalation(
    campaign_id: UUID,
    body: EscalationRequest,
    request: Request,
    x_operator_key: OperatorKey = None,
) -> dict[str, Any]:
    operator = _operator(request, x_operator_key)
    try:
        await operator.resolve_escalation(
            campaign_id, operator_id=body.operator_id, action=body.action
        )
    except ServiceError as exc:
        raise _http(exc) from exc
    return {"status": "resolved", "action": body.action}


class TickRequest(BaseModel):
    day: str  # ISO date


@router.post("/api/monitoring/tick")
async def monitoring_tick(
    body: TickRequest, request: Request, x_operator_key: OperatorKey = None
) -> dict[str, Any]:
    operator = _operator(request, x_operator_key)
    ticked = await operator.tick_all_monitoring(day=body.day)
    return {"ticked": ticked, "day": body.day}
