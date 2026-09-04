"""The campaign state machine as data (DATA-MODEL.md §1).

Only the transitions listed here are legal; every transition is triggered by
a named event. The DB write + audit event + graph-state update all go
through transition() (implemented against the DB in M2) — this module is the
pure, testable core it will call."""

from __future__ import annotations

from maistro.graph.state import TERMINAL_STATUSES, CampaignStatus

CANCEL_EVENT = "campaign.cancelled"

TRANSITIONS: dict[tuple[CampaignStatus, str], CampaignStatus] = {
    (CampaignStatus.TREND_SELECTED, "brief.generated"): CampaignStatus.BRIEF_GENERATED,
    (CampaignStatus.BRIEF_GENERATED, "brief.assigned"): CampaignStatus.AWAITING_DRAFT,
    (CampaignStatus.AWAITING_DRAFT, "draft.submitted"): CampaignStatus.SCORING,
    (CampaignStatus.SCORING, "f1x8.done"): CampaignStatus.SCORE_EVALUATED,
    (CampaignStatus.SCORING, "f1x8.failed"): CampaignStatus.ESCALATED,
    (CampaignStatus.SCORE_EVALUATED, "score.below_threshold"): CampaignStatus.REVISING,
    (CampaignStatus.SCORE_EVALUATED, "score.passed"): CampaignStatus.AWAITING_APPROVAL,
    (CampaignStatus.SCORE_EVALUATED, "score.loop_exhausted"): CampaignStatus.AWAITING_APPROVAL,
    (CampaignStatus.SCORE_EVALUATED, "creator.final_submitted"): CampaignStatus.AWAITING_APPROVAL,
    (CampaignStatus.REVISING, "draft.submitted"): CampaignStatus.SCORING,
    (CampaignStatus.AWAITING_APPROVAL, "approval.approved"): CampaignStatus.APPROVED,
    (CampaignStatus.AWAITING_APPROVAL, "approval.rejected"): CampaignStatus.REVISING,
    (CampaignStatus.APPROVED, "publish.requested"): CampaignStatus.PUBLISHING,
    (CampaignStatus.PUBLISHING, "publish.confirmed"): CampaignStatus.PUBLISHED,
    (CampaignStatus.PUBLISHING, "publish.failed"): CampaignStatus.ESCALATED,
    (CampaignStatus.PUBLISHED, "monitoring.scheduled"): CampaignStatus.MONITORING,
    (CampaignStatus.MONITORING, "monitoring.complete"): CampaignStatus.LEARNINGS_WRITTEN,
    (CampaignStatus.LEARNINGS_WRITTEN, "campaign.closed"): CampaignStatus.CLOSED,
    # Operator resolutions out of escalation (DATA-MODEL.md §1).
    (CampaignStatus.ESCALATED, "operator.resume_scoring"): CampaignStatus.SCORING,
    (CampaignStatus.ESCALATED, "operator.resume_publishing"): CampaignStatus.PUBLISHING,
    (CampaignStatus.ESCALATED, "operator.route_to_approval"): CampaignStatus.AWAITING_APPROVAL,
}


class IllegalTransition(Exception):
    def __init__(self, current: CampaignStatus, event: str) -> None:
        super().__init__(f"illegal transition: {current.value} --[{event}]--> ?")
        self.current = current
        self.event = event


def next_status(current: CampaignStatus, event: str) -> CampaignStatus:
    """Resolve the next status for an event, or raise IllegalTransition.

    The operator cancel event is legal from any non-terminal state.
    """
    if event == CANCEL_EVENT:
        if current in TERMINAL_STATUSES:
            raise IllegalTransition(current, event)
        return CampaignStatus.CANCELLED
    try:
        return TRANSITIONS[(current, event)]
    except KeyError:
        raise IllegalTransition(current, event) from None


def legal_events(current: CampaignStatus) -> frozenset[str]:
    events = {event for (status, event) in TRANSITIONS if status == current}
    if current not in TERMINAL_STATUSES:
        events.add(CANCEL_EVENT)
    return frozenset(events)
