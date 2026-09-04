"""LangGraph Studio dev harness (repo-root `langgraph.json` points here).

`langgraph dev` serves this graph with Studio attached — the visual,
step-through view of the orchestration. It runs with in-memory deps and a
demo scorer so you can drive a campaign through every node and interrupt
without touching real services. NOT used by the production app (app.py
builds the graph with real deps)."""

from __future__ import annotations

from typing import Any

from maistro.graph.builder import build_graph
from maistro.graph.deps import GraphDeps, JobPoll, ScoreSubmission
from maistro.store import ContentVersionRecord, MemoryStore, MetricsSnapshot


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


_deps = GraphDeps(
    store=MemoryStore(),
    scorer=DemoScorer(),
    metrics_source=DemoMetrics(),
    poll_interval_s=0.1,
    monitoring_days=2,
)

# `langgraph dev` supplies its own checkpointer — compile without one.
graph = build_graph(_deps)
