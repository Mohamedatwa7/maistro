"""PostgresStore + AsyncPostgresSaver tests against a real database.

Runs when MAISTRO_TEST_DATABASE_URL is set (CI provides a postgres service
container); the database NAME must contain 'test' — the fixture drops and
recreates the public schema. Locally without Postgres these skip."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from uuid import UUID, uuid4

import psycopg
import pytest
import pytest_asyncio
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from test_graph_flow import TREND, FakeMetrics, FakeScorer

from maistro.gate.rules import RulesEngine
from maistro.graph.deps import GraphDeps
from maistro.graph.runtime import CampaignRuntime
from maistro.graph.state import CampaignStatus
from maistro.graph.transitions import IllegalTransition
from maistro.services import CreatorService, OperatorService
from maistro.store import CampaignRecord, ContentVersionRecord
from maistro.store_postgres import PostgresStore

DB_URL = os.environ.get("MAISTRO_TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(
    not DB_URL, reason="MAISTRO_TEST_DATABASE_URL not set (CI runs these)"
)


def _guard_test_db() -> None:
    dbname = psycopg.conninfo.conninfo_to_dict(DB_URL).get("dbname", "")
    assert "test" in str(dbname), (
        f"refusing to reset schema of non-test database '{dbname}'"
    )


@pytest_asyncio.fixture()
async def store() -> AsyncIterator[PostgresStore]:
    _guard_test_db()
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "db"))
    from apply import apply_migrations  # type: ignore[import-not-found]

    with psycopg.connect(DB_URL, autocommit=True) as conn:
        conn.execute("drop schema public cascade; create schema public")
    apply_migrations(DB_URL)
    pool = AsyncConnectionPool(DB_URL, open=False)
    await pool.open()
    yield PostgresStore(pool)
    await pool.close()


async def _campaign(store: PostgresStore) -> UUID:
    campaign_id = uuid4()
    await store.create_campaign(
        CampaignRecord(
            campaign_id=campaign_id,
            status=CampaignStatus.TREND_SELECTED,
            trend_ref=TREND,
            creator_id="creator-1",
            publish_targets=["tiktok"],  # type: ignore[list-item]
        )
    )
    return campaign_id


async def test_transition_atomicity_and_audit(store: PostgresStore) -> None:
    campaign_id = await _campaign(store)
    status = await store.transition(
        campaign_id, "brief.generated", actor="service", detail={"n": 1}
    )
    assert status == CampaignStatus.BRIEF_GENERATED
    with pytest.raises(IllegalTransition):
        await store.transition(campaign_id, "publish.confirmed", actor="service")
    # The failed transition rolled back — status unchanged, one audit row.
    campaign = await store.get_campaign(campaign_id)
    assert campaign is not None and campaign.status == CampaignStatus.BRIEF_GENERATED
    audit = await store.list_audit(campaign_id)
    assert [e.event for e in audit] == ["brief.generated"]


async def test_effect_once(store: PostgresStore) -> None:
    campaign_id = await _campaign(store)
    assert await store.effect_once(campaign_id, "publish", "k1") is True
    assert await store.effect_once(campaign_id, "publish", "k1") is False
    assert await store.effect_once(campaign_id, "publish", "k2") is True


async def test_version_jsonb_roundtrip(store: PostgresStore) -> None:
    campaign_id = await _campaign(store)
    version_id = uuid4()
    await store.add_version(
        ContentVersionRecord(
            content_version_id=version_id,
            campaign_id=campaign_id,
            iteration=1,
            asset_ref="a/b.mp4",
            media_type="video",
            submitted_by="creator-1",
            validation_report={"status": "postable", "issues": []},
            asset_sha256="f" * 64,
        )
    )
    await store.set_analysis(version_id, "job-9", None)
    await store.set_analysis(version_id, None, {"score": 8.1, "verdict": {"summary": "ok"}})
    version = await store.get_version(version_id)
    assert version is not None
    assert version.f1x8_job_id == "job-9"
    assert version.analysis_result == {"score": 8.1, "verdict": {"summary": "ok"}}
    assert version.validation_report == {"status": "postable", "issues": []}
    campaign = await store.get_campaign(campaign_id)
    assert campaign is not None and campaign.current_version == 1


async def test_audit_is_append_only(store: PostgresStore) -> None:
    campaign_id = await _campaign(store)
    await store.transition(campaign_id, "brief.generated", actor="service")
    with pytest.raises(psycopg.errors.RaiseException):
        async with store.pool.connection() as conn:
            await conn.execute("delete from audit_events")


async def test_full_lifecycle_on_postgres_with_restart(store: PostgresStore) -> None:
    """The M2 durability prize: the whole campaign lifecycle through real
    Postgres — store AND checkpointer — including a simulated process
    restart at an interrupt."""
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    saver_pool = AsyncConnectionPool(
        DB_URL,
        open=False,
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
    )
    await saver_pool.open()
    try:
        checkpointer = AsyncPostgresSaver(saver_pool)  # type: ignore[arg-type]
        await checkpointer.setup()
        deps = GraphDeps(
            store=store,
            scorer=FakeScorer([6.0, 8.5]),
            metrics_source=FakeMetrics(),
            poll_interval_s=0.01,
            monitoring_days=1,
        )
        runtime = CampaignRuntime(deps, checkpointer=checkpointer)
        operator = OperatorService(store, runtime)
        creator = CreatorService(store, runtime, RulesEngine())

        record = await operator.create_campaign(
            trend_snapshot=TREND, creator_id="creator-1", publish_targets=["tiktok"]
        )
        campaign_id = record.campaign_id
        campaign = await store.get_campaign(campaign_id)
        assert campaign is not None and campaign.status == CampaignStatus.AWAITING_DRAFT

        from test_graph_flow import GOOD_PROBE

        await creator.submit_draft(
            "creator-1",
            campaign.brief_id,  # type: ignore[arg-type]
            probe=GOOD_PROBE.model_copy(update={"sha256": "a1" * 32}),
            media_type="video",
            asset_ref="assets/a1.mp4",
        )
        campaign = await store.get_campaign(campaign_id)
        assert campaign is not None and campaign.status == CampaignStatus.REVISING

        # RESTART: brand-new runtime + services over a NEW saver instance
        # reading the same Postgres checkpoints.
        checkpointer2 = AsyncPostgresSaver(saver_pool)  # type: ignore[arg-type]
        runtime2 = CampaignRuntime(deps, checkpointer=checkpointer2)
        operator2 = OperatorService(store, runtime2)
        creator2 = CreatorService(store, runtime2, RulesEngine())

        await creator2.submit_draft(
            "creator-1",
            campaign.brief_id,  # type: ignore[arg-type]
            probe=GOOD_PROBE.model_copy(update={"sha256": "b2" * 32}),
            media_type="video",
            asset_ref="assets/b2.mp4",
        )
        campaign = await store.get_campaign(campaign_id)
        assert campaign is not None
        assert campaign.status == CampaignStatus.AWAITING_APPROVAL

        await operator2.approve(campaign_id, approver_id="approver-1")
        await operator2.record_publication(
            campaign_id,
            operator_id="op-1",
            publications=[{"platform": "tiktok", "post_url": "https://t.example/1"}],
        )
        await operator2.tick_all_monitoring(day="2026-09-05")

        final = await store.get_campaign(campaign_id)
        assert final is not None and final.status == CampaignStatus.CLOSED
        metrics = await store.list_metrics(campaign_id)
        assert len(metrics) == 1 and metrics[0].views == 1000
        publications = await store.list_publications(campaign_id)
        assert publications[0].post_url == "https://t.example/1"
        events = [e.event for e in await store.list_audit(campaign_id)]
        assert events[-1] == "campaign.closed"
    finally:
        await saver_pool.close()
