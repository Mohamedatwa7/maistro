"""Monitoring scheduler: one daily tick for every campaign in monitoring
(ARCHITECTURE §4.6). Runs as an asyncio task inside the app lifespan — no
external cron needed; /api/monitoring/tick remains available for manual and
catch-up ticks."""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime, timedelta

from maistro.services import OperatorService
from maistro.telemetry import get_logger

log = get_logger("scheduler")


class MonitoringScheduler:
    def __init__(self, operator: OperatorService, *, hour_utc: int = 6) -> None:
        self.operator = operator
        self.hour_utc = hour_utc
        self._task: asyncio.Task[None] | None = None

    def seconds_until_next_run(self, now: datetime | None = None) -> float:
        now = now or datetime.now(UTC)
        target = now.replace(hour=self.hour_utc, minute=0, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        return (target - now).total_seconds()

    async def tick(self) -> int:
        day = datetime.now(UTC).date().isoformat()
        try:
            ticked = await self.operator.tick_all_monitoring(day=day)
        except Exception:
            log.exception("monitoring_tick_failed", day=day)
            return 0
        log.info("monitoring_tick", day=day, campaigns=ticked)
        return ticked

    async def _run_forever(self) -> None:
        while True:
            await asyncio.sleep(self.seconds_until_next_run())
            await self.tick()

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run_forever())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
