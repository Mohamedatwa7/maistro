"""The state machine is a contract (DATA-MODEL.md §1) — these tests pin it."""

import pytest

from maistro.graph.state import TERMINAL_STATUSES, CampaignStatus
from maistro.graph.transitions import (
    CANCEL_EVENT,
    TRANSITIONS,
    IllegalTransition,
    legal_events,
    next_status,
)

HAPPY_PATH = [
    (CampaignStatus.TREND_SELECTED, "brief.generated", CampaignStatus.BRIEF_GENERATED),
    (CampaignStatus.BRIEF_GENERATED, "brief.assigned", CampaignStatus.AWAITING_DRAFT),
    (CampaignStatus.AWAITING_DRAFT, "draft.submitted", CampaignStatus.SCORING),
    (CampaignStatus.SCORING, "f1x8.done", CampaignStatus.SCORE_EVALUATED),
    (CampaignStatus.SCORE_EVALUATED, "score.passed", CampaignStatus.AWAITING_APPROVAL),
    (CampaignStatus.AWAITING_APPROVAL, "approval.approved", CampaignStatus.APPROVED),
    (CampaignStatus.APPROVED, "publish.requested", CampaignStatus.PUBLISHING),
    (CampaignStatus.PUBLISHING, "publish.confirmed", CampaignStatus.PUBLISHED),
    (CampaignStatus.PUBLISHED, "monitoring.scheduled", CampaignStatus.MONITORING),
    (CampaignStatus.MONITORING, "monitoring.complete", CampaignStatus.LEARNINGS_WRITTEN),
    (CampaignStatus.LEARNINGS_WRITTEN, "campaign.closed", CampaignStatus.CLOSED),
]


def test_happy_path_is_legal() -> None:
    for current, event, expected in HAPPY_PATH:
        assert next_status(current, event) == expected


def test_revision_loop() -> None:
    assert (
        next_status(CampaignStatus.SCORE_EVALUATED, "score.below_threshold")
        == CampaignStatus.REVISING
    )
    assert next_status(CampaignStatus.REVISING, "draft.submitted") == CampaignStatus.SCORING


def test_rejection_routes_back_to_revising() -> None:
    assert (
        next_status(CampaignStatus.AWAITING_APPROVAL, "approval.rejected")
        == CampaignStatus.REVISING
    )


def test_loop_exhaustion_and_final_submit_reach_approval() -> None:
    for event in ("score.loop_exhausted", "creator.final_submitted"):
        assert next_status(CampaignStatus.SCORE_EVALUATED, event) == (
            CampaignStatus.AWAITING_APPROVAL
        )


def test_failures_escalate() -> None:
    assert next_status(CampaignStatus.SCORING, "f1x8.failed") == CampaignStatus.ESCALATED
    assert next_status(CampaignStatus.PUBLISHING, "publish.failed") == CampaignStatus.ESCALATED


def test_illegal_transitions_raise() -> None:
    with pytest.raises(IllegalTransition):
        next_status(CampaignStatus.TREND_SELECTED, "publish.confirmed")
    with pytest.raises(IllegalTransition):
        next_status(CampaignStatus.PUBLISHED, "draft.submitted")


def test_cancel_from_any_non_terminal_state() -> None:
    for status in CampaignStatus:
        if status in TERMINAL_STATUSES:
            with pytest.raises(IllegalTransition):
                next_status(status, CANCEL_EVENT)
        else:
            assert next_status(status, CANCEL_EVENT) == CampaignStatus.CANCELLED


def test_terminal_states_have_no_outgoing_transitions() -> None:
    for status in TERMINAL_STATUSES:
        assert legal_events(status) == frozenset()


def test_every_status_is_reachable() -> None:
    reachable = {CampaignStatus.TREND_SELECTED, CampaignStatus.CANCELLED}
    reachable.update(TRANSITIONS.values())
    assert reachable == set(CampaignStatus)
