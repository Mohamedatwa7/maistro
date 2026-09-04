"""REST + MCP surface smoke tests over the fake-scorer world."""

from __future__ import annotations

import hashlib
from typing import Any

from fastapi.testclient import TestClient
from test_graph_flow import TREND, FakeMetrics, FakeScorer

from maistro.app import create_app
from maistro.config import Settings
from maistro.gate.rules import RulesEngine
from maistro.graph.deps import GraphDeps
from maistro.graph.runtime import CampaignRuntime
from maistro.integrations import MemoryAssetStore
from maistro.services import CreatorService, OperatorService
from maistro.store import CreatorRecord, MemoryStore

TEST_SETTINGS = Settings(mcp_allowed_hosts=["testserver"])
CREATOR_KEY = "creator-secret-key"


def build_app_state(scores: list[float]) -> dict[str, Any]:
    store = MemoryStore()
    store.creators["creator-1"] = CreatorRecord(
        creator_id="creator-1",
        display_name="Test Creator",
        api_key_hash=hashlib.sha256(CREATOR_KEY.encode()).hexdigest(),
    )
    deps = GraphDeps(
        store=store,
        scorer=FakeScorer(scores),
        metrics_source=FakeMetrics(),
        poll_interval_s=0.01,
        monitoring_days=1,
    )
    runtime = CampaignRuntime(deps)
    return {
        "store": store,
        "assets": MemoryAssetStore(),
        "runtime": runtime,
        "operator_service": OperatorService(store, runtime),
        "creator_service": CreatorService(store, runtime, RulesEngine()),
    }


def test_rest_campaign_lifecycle_endpoints() -> None:
    state = build_app_state(scores=[8.0])
    with TestClient(create_app(settings=TEST_SETTINGS, state=state)) as client:
        created = client.post(
            "/api/campaigns",
            json={"trend_snapshot": TREND, "creator_id": "creator-1"},
        )
        assert created.status_code == 201
        body = created.json()
        assert body["status"] == "awaiting_draft"
        assert body["brief_id"] is not None

        listing = client.get("/api/campaigns")
        assert listing.status_code == 200
        assert len(listing.json()["campaigns"]) == 1

        detail = client.get(f"/api/campaigns/{body['campaign_id']}")
        assert detail.status_code == 200
        events = [e["event"] for e in detail.json()["timeline"]]
        assert events == ["brief.generated", "brief.assigned"]

        # Approval on a campaign that isn't awaiting approval -> clean 409.
        wrong = client.post(
            f"/api/campaigns/{body['campaign_id']}/approve",
            json={"approver_id": "approver-1"},
        )
        assert wrong.status_code == 409


def test_mcp_mount_auth_and_tools() -> None:
    state = build_app_state(scores=[8.0])
    with TestClient(create_app(settings=TEST_SETTINGS, state=state)) as client:
        headers = {
            "Authorization": f"Bearer {CREATOR_KEY}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        # No key -> 401 before the MCP app is reached.
        anon = client.post(
            "/creator/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers={k: v for k, v in headers.items() if k != "Authorization"},
        )
        assert anon.status_code == 401

        response = client.post(
            "/creator/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers=headers,
        )
        assert response.status_code == 200
        tools = {t["name"] for t in response.json()["result"]["tools"]}
        assert tools == {
            "list_assigned_briefs",
            "get_brief",
            "check_asset",
            "submit_draft",
            "get_feedback",
            "submit_final",
            "get_campaign_status",
        }


def test_mcp_list_briefs_tool_call() -> None:
    state = build_app_state(scores=[8.0])
    with TestClient(create_app(settings=TEST_SETTINGS, state=state)) as client:
        client.post(
            "/api/campaigns", json={"trend_snapshot": TREND, "creator_id": "creator-1"}
        )
        response = client.post(
            "/creator/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "list_assigned_briefs", "arguments": {}},
            },
            headers={
                "Authorization": f"Bearer {CREATOR_KEY}",
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            },
        )
        assert response.status_code == 200
        result = response.json()["result"]
        assert result.get("isError") is not True
        assert "Pass the phone" in str(result)
