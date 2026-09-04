"""The Studio harness must survive raw-graph driving (no service layer) —
this replays exactly the resume sequence documented in graph/studio.py, so
the Studio walkthrough can never silently break again."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from maistro.graph.builder import build_graph
from maistro.graph.state import CampaignStatus
from maistro.graph.studio import build_demo_deps

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


def _draft(iteration: int) -> dict[str, Any]:
    return {
        "kind": "draft",
        "iteration": iteration,
        "draft": {
            "content_version_id": str(uuid4()),
            "asset_ref": f"demo/{iteration}.mp4",
            "media_type": "video",
        },
    }


async def test_studio_walkthrough_raw_graph() -> None:
    deps = build_demo_deps()
    graph = build_graph(deps, checkpointer=InMemorySaver())
    campaign_id = uuid4()
    config: RunnableConfig = {"configurable": {"thread_id": str(campaign_id)}}

    # 1. Initial input — exactly what a Studio user types.
    result = await graph.ainvoke(
        {"campaign_id": campaign_id, "status": "trend_selected", "trend": TREND}, config
    )
    assert result["status"] == CampaignStatus.AWAITING_DRAFT
    assert result["brief_id"] is not None

    # 2. First draft -> demo scorer gives 6.0 -> revision loop.
    result = await graph.ainvoke(Command(resume=_draft(1)), config)
    assert result["status"] == CampaignStatus.REVISING

    # 3. Second draft -> 8.5 -> approval gate.
    result = await graph.ainvoke(Command(resume=_draft(2)), config)
    assert result["status"] == CampaignStatus.AWAITING_APPROVAL
    version_id = result["current_draft"].content_version_id

    # 4. Approve -> parks at the record_publication interrupt.
    result = await graph.ainvoke(
        Command(
            resume={
                "decision": "approved",
                "approval": {
                    "approval_id": str(uuid4()),
                    "content_version_id": str(version_id),
                    "decided_at": "2026-09-04T12:00:00Z",
                },
            }
        ),
        config,
    )
    assert result["status"] == CampaignStatus.APPROVED

    # 5. Record the manual publication (DemoStore bridges the publish
    #    events a service would have applied) -> monitoring.
    result = await graph.ainvoke(
        Command(
            resume={
                "publications": [
                    {
                        "platform": "tiktok",
                        "publish_record_id": str(uuid4()),
                        "status": "published",
                        "post_url": "https://tiktok.com/@demo/1",
                    }
                ]
            }
        ),
        config,
    )
    assert result["status"] == CampaignStatus.MONITORING

    # 6. Two monitoring ticks close it out.
    result = await graph.ainvoke(Command(resume={"day": "2026-09-05"}), config)
    assert result["status"] == CampaignStatus.MONITORING
    result = await graph.ainvoke(Command(resume={"day": "2026-09-06"}), config)
    assert result["status"] == CampaignStatus.CLOSED
    assert len(deps.store.learnings) == 1
