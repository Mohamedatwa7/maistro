from datetime import UTC, datetime
from uuid import UUID

from test_graph_flow import build_world, get_brief_id, start_campaign, submit

from maistro.graph.state import CampaignStatus
from maistro.scheduler import MonitoringScheduler


def test_seconds_until_next_run() -> None:
    scheduler = MonitoringScheduler(operator=None, hour_utc=6)  # type: ignore[arg-type]
    before = datetime(2026, 9, 4, 5, 0, tzinfo=UTC)
    assert scheduler.seconds_until_next_run(before) == 3600
    after = datetime(2026, 9, 4, 6, 0, 1, tzinfo=UTC)
    assert 0 < scheduler.seconds_until_next_run(after) <= 86400


async def test_tick_advances_monitoring_campaigns() -> None:
    world = build_world(scores=[9.0])
    campaign_id = await start_campaign(world)
    brief_id = await get_brief_id(world, campaign_id)
    result = await submit(world, brief_id, sha="a" * 64)
    assert UUID(result["draft_id"])
    await world["operator"].approve(campaign_id, approver_id="approver-1")
    await world["operator"].record_publication(
        campaign_id,
        operator_id="op-1",
        publications=[{"platform": "tiktok", "post_url": "https://t.example/2"}],
    )
    scheduler = MonitoringScheduler(world["operator"], hour_utc=6)
    assert await scheduler.tick() == 1  # monitoring_days=2 -> still monitoring
    campaign = await world["store"].get_campaign(campaign_id)
    assert campaign.status == CampaignStatus.MONITORING
    assert await scheduler.tick() == 1  # second tick completes the window
    campaign = await world["store"].get_campaign(campaign_id)
    assert campaign.status == CampaignStatus.CLOSED
