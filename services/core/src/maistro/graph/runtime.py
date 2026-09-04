"""Campaign runtime: one durable graph run per campaign
(thread_id == campaign_id). The checkpointer is injected — InMemorySaver for
tests/dev, PostgresSaver (schema `langgraph`) once MAISTRO_DATABASE_URL is
provisioned; the runtime code is identical for both."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from maistro.graph.builder import build_graph
from maistro.graph.deps import GraphDeps
from maistro.graph.state import CampaignState


def _config(campaign_id: UUID) -> RunnableConfig:
    return {"configurable": {"thread_id": str(campaign_id)}}


class CampaignRuntime:
    def __init__(self, deps: GraphDeps, checkpointer: Any = None) -> None:
        self.deps = deps
        self.checkpointer = checkpointer or InMemorySaver()
        self.graph = build_graph(deps, checkpointer=self.checkpointer)

    async def start(self, state: CampaignState) -> CampaignState:
        """Run a new campaign until its first interrupt (await_draft)."""
        result = await self.graph.ainvoke(state, _config(state.campaign_id))
        return CampaignState.model_validate(result)

    async def resume(self, campaign_id: UUID, payload: dict[str, Any]) -> CampaignState:
        """Resume a parked campaign with an interrupt payload."""
        result = await self.graph.ainvoke(Command(resume=payload), _config(campaign_id))
        return CampaignState.model_validate(result)

    async def get_state(self, campaign_id: UUID) -> CampaignState | None:
        snapshot = await self.graph.aget_state(_config(campaign_id))
        if not snapshot or not snapshot.values:
            return None
        return CampaignState.model_validate(snapshot.values)

    async def pending_interrupt(self, campaign_id: UUID) -> dict[str, Any] | None:
        """The payload of the interrupt the campaign is parked on, if any."""
        snapshot = await self.graph.aget_state(_config(campaign_id))
        if not snapshot:
            return None
        for task in snapshot.tasks:
            for intr in getattr(task, "interrupts", ()):  # noqa: B007
                value = getattr(intr, "value", None)
                if isinstance(value, dict):
                    return value
        return None
