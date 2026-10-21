"""Graph topology (ARCHITECTURE.md §4.2, publishing deferred to manual
record_publication). Routers read only state that nodes just wrote."""

from __future__ import annotations

from typing import Any, cast

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from maistro.graph.deps import GraphDeps
from maistro.graph.nodes import make_nodes
from maistro.graph.state import CampaignState, CampaignStatus

CompiledCampaignGraph = CompiledStateGraph[Any, Any, Any, Any]


def route_after_score(state: CampaignState) -> str:
    if state.status == CampaignStatus.ESCALATED:
        return "escalate"
    if state.analysis_result is not None:
        return "evaluate_score"
    return "poll_f1x8"


def route_after_poll(state: CampaignState) -> str:
    if state.status == CampaignStatus.ESCALATED:
        return "escalate"
    if state.analysis_result is not None:
        return "evaluate_score"
    return "poll_f1x8"


def route_after_evaluate(state: CampaignState) -> str:
    if state.status == CampaignStatus.REVISING:
        return "request_revision"
    return "approval_gate"


def route_after_revision(state: CampaignState) -> str:
    if state.status == CampaignStatus.AWAITING_APPROVAL:
        return "approval_gate"
    return "score_asset"


def route_after_approval(state: CampaignState) -> str:
    if state.status == CampaignStatus.APPROVED:
        return "record_publication"
    if state.status == CampaignStatus.REVISING:
        return "request_revision"
    return END


def route_after_monitor(state: CampaignState) -> str:
    if state.status == CampaignStatus.LEARNINGS_WRITTEN:
        return "write_learnings"
    return "monitor"


def route_after_escalate(state: CampaignState) -> str:
    if state.status == CampaignStatus.SCORING:
        return "score_asset"
    if state.status == CampaignStatus.AWAITING_APPROVAL:
        return "approval_gate"
    return END


def build_graph(deps: GraphDeps, checkpointer: Any = None) -> CompiledCampaignGraph:
    nodes = make_nodes(deps)
    graph = StateGraph(CampaignState)
    for name, fn in nodes.items():
        graph.add_node(name, cast(Any, fn))

    graph.add_edge(START, "pick_trend")
    graph.add_edge("pick_trend", "generate_brief")
    graph.add_edge("generate_brief", "await_draft")
    graph.add_edge("await_draft", "score_asset")
    # Path maps declare every legal routing target — typos fail at compile
    # time and the graph renders fully in Studio/mermaid.
    graph.add_conditional_edges(
        "score_asset", route_after_score, ["escalate", "evaluate_score", "poll_f1x8"]
    )
    graph.add_conditional_edges(
        "poll_f1x8", route_after_poll, ["escalate", "evaluate_score", "poll_f1x8"]
    )
    graph.add_conditional_edges(
        "evaluate_score", route_after_evaluate, ["request_revision", "approval_gate"]
    )
    graph.add_conditional_edges(
        "request_revision", route_after_revision, ["approval_gate", "score_asset"]
    )
    graph.add_conditional_edges(
        "approval_gate", route_after_approval, ["record_publication", "request_revision", END]
    )
    graph.add_edge("record_publication", "monitor")
    graph.add_conditional_edges("monitor", route_after_monitor, ["write_learnings", "monitor"])
    graph.add_edge("write_learnings", END)
    graph.add_conditional_edges(
        "escalate", route_after_escalate, ["score_asset", "approval_gate", END]
    )

    return graph.compile(checkpointer=checkpointer)
