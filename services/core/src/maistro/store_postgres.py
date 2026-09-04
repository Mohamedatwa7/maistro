"""PostgresStore — CampaignStore over the dedicated Maistro Postgres
(db/migrations/001_core.sql). Drop-in replacement for MemoryStore: nothing
above the protocol changes.

Atomicity: transition() runs SELECT ... FOR UPDATE + status UPDATE + audit
INSERT in one transaction — the same guarantee MemoryStore's lock provides,
now durable."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from psycopg.rows import dict_row
from psycopg.types.json import Json
from psycopg_pool import AsyncConnectionPool

from maistro.graph.state import CampaignStatus, Platform
from maistro.graph.transitions import next_status
from maistro.store import (
    ApprovalRecord,
    AuditEvent,
    BriefRecord,
    CampaignRecord,
    ContentVersionRecord,
    CreatorRecord,
    LearningRecord,
    MetricsSnapshot,
    PublicationRecord,
)


def _jsonb(value: Any) -> Json | None:
    return Json(value) if value is not None else None


class PostgresStore:
    def __init__(self, pool: AsyncConnectionPool) -> None:
        self.pool = pool

    # -- campaigns ---------------------------------------------------------

    async def create_campaign(self, record: CampaignRecord) -> None:
        async with self.pool.connection() as conn:
            await conn.execute(
                """insert into campaigns (campaign_id, status, trend_ref, creator_id,
                     current_version, max_iterations, score_threshold, state_version,
                     created_at, publish_targets)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    record.campaign_id,
                    record.status.value,
                    Json(record.trend_ref),
                    record.creator_id,
                    record.current_version,
                    record.max_iterations,
                    record.score_threshold,
                    record.state_version,
                    record.created_at,
                    [p.value for p in record.publish_targets],
                ),
            )

    def _campaign_from_row(self, row: dict[str, Any]) -> CampaignRecord:
        return CampaignRecord(
            campaign_id=row["campaign_id"],
            status=CampaignStatus(row["status"]),
            trend_ref=row["trend_ref"],
            brief_id=row["brief_id"],
            creator_id=row["creator_id"],
            current_version=row["current_version"],
            max_iterations=row["max_iterations"],
            score_threshold=float(row["score_threshold"]),
            publish_targets=[Platform(p) for p in (row["publish_targets"] or [])],
            state_version=row["state_version"],
            created_at=row["created_at"],
            closed_at=row["closed_at"],
        )

    async def get_campaign(self, campaign_id: UUID) -> CampaignRecord | None:
        async with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cursor:
            await cursor.execute(
                "select * from campaigns where campaign_id = %s", (campaign_id,)
            )
            row = await cursor.fetchone()
        return self._campaign_from_row(row) if row else None

    async def list_campaigns(
        self, *, creator_id: str | None = None, statuses: set[CampaignStatus] | None = None
    ) -> list[CampaignRecord]:
        clauses: list[str] = []
        params: list[Any] = []
        if creator_id is not None:
            clauses.append("creator_id = %s")
            params.append(creator_id)
        if statuses is not None:
            clauses.append("status = any(%s)")
            params.append([s.value for s in statuses])
        where = f"where {' and '.join(clauses)}" if clauses else ""
        async with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cursor:
            await cursor.execute(
                f"select * from campaigns {where} order by created_at",  # noqa: S608
                params,
            )
            rows = await cursor.fetchall()
        return [self._campaign_from_row(r) for r in rows]

    async def transition(
        self, campaign_id: UUID, event: str, *, actor: str, detail: dict[str, Any] | None = None
    ) -> CampaignStatus:
        async with self.pool.connection() as conn, conn.transaction():
            cursor = await conn.execute(
                "select status from campaigns where campaign_id = %s for update",
                (campaign_id,),
            )
            row = await cursor.fetchone()
            if row is None:
                raise KeyError(f"campaign {campaign_id} not found")
            new_status = next_status(CampaignStatus(row[0]), event)
            closing = new_status in (CampaignStatus.CLOSED, CampaignStatus.CANCELLED)
            await conn.execute(
                "update campaigns set status = %s, closed_at = case when %s then now() "
                "else closed_at end where campaign_id = %s",
                (new_status.value, closing, campaign_id),
            )
            await conn.execute(
                "insert into audit_events (event_id, campaign_id, actor, event, detail) "
                "values (%s, %s, %s, %s, %s)",
                (
                    uuid4(),
                    campaign_id,
                    actor,
                    event,
                    Json({"to": new_status.value, **(detail or {})}),
                ),
            )
        return new_status

    # -- briefs ------------------------------------------------------------

    async def save_brief(self, record: BriefRecord) -> None:
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "insert into briefs (brief_id, campaign_id, body, generated_at) "
                "values (%s, %s, %s, %s)",
                (record.brief_id, record.campaign_id, Json(record.body), record.generated_at),
            )
            await conn.execute(
                "update campaigns set brief_id = %s where campaign_id = %s",
                (record.brief_id, record.campaign_id),
            )

    async def get_brief(self, brief_id: UUID) -> BriefRecord | None:
        async with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cursor:
            await cursor.execute(
                "select * from briefs where brief_id = %s", (brief_id,)
            )
            row = await cursor.fetchone()
        if row is None:
            return None
        return BriefRecord(
            brief_id=row["brief_id"],
            campaign_id=row["campaign_id"],
            body=row["body"],
            generated_at=row["generated_at"],
        )

    # -- content versions --------------------------------------------------

    async def add_version(self, record: ContentVersionRecord) -> None:
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                """insert into content_versions (content_version_id, campaign_id, iteration,
                     asset_ref, media_type, submitted_by, submitted_at, creator_notes,
                     f1x8_job_id, analysis_result, validation_report, asset_sha256)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    record.content_version_id,
                    record.campaign_id,
                    record.iteration,
                    record.asset_ref,
                    record.media_type,
                    record.submitted_by,
                    record.submitted_at,
                    record.creator_notes,
                    record.f1x8_job_id,
                    _jsonb(record.analysis_result),
                    _jsonb(record.validation_report),
                    record.asset_sha256,
                ),
            )
            await conn.execute(
                "update campaigns set current_version = greatest(current_version, %s) "
                "where campaign_id = %s",
                (record.iteration, record.campaign_id),
            )

    def _version_from_row(self, row: dict[str, Any]) -> ContentVersionRecord:
        return ContentVersionRecord(
            content_version_id=row["content_version_id"],
            campaign_id=row["campaign_id"],
            iteration=row["iteration"],
            asset_ref=row["asset_ref"],
            media_type=row["media_type"],
            submitted_by=row["submitted_by"],
            submitted_at=row["submitted_at"],
            creator_notes=row["creator_notes"],
            f1x8_job_id=row["f1x8_job_id"],
            analysis_result=row["analysis_result"],
            validation_report=row["validation_report"],
            asset_sha256=row["asset_sha256"],
        )

    async def get_version(self, content_version_id: UUID) -> ContentVersionRecord | None:
        async with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cursor:
            await cursor.execute(
                "select * from content_versions where content_version_id = %s",
                (content_version_id,),
            )
            row = await cursor.fetchone()
        return self._version_from_row(row) if row else None

    async def latest_version(self, campaign_id: UUID) -> ContentVersionRecord | None:
        async with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cursor:
            await cursor.execute(
                "select * from content_versions where campaign_id = %s "
                "order by iteration desc limit 1",
                (campaign_id,),
            )
            row = await cursor.fetchone()
        return self._version_from_row(row) if row else None

    async def set_analysis(
        self, content_version_id: UUID, job_id: str | None, analysis: dict[str, Any] | None
    ) -> None:
        async with self.pool.connection() as conn:
            await conn.execute(
                "update content_versions set "
                "f1x8_job_id = coalesce(%s, f1x8_job_id), "
                "analysis_result = coalesce(%s, analysis_result) "
                "where content_version_id = %s",
                (job_id, _jsonb(analysis), content_version_id),
            )

    # -- approvals / publications / metrics / learnings --------------------

    async def add_approval(self, record: ApprovalRecord) -> None:
        async with self.pool.connection() as conn:
            await conn.execute(
                """insert into approvals (approval_id, campaign_id, content_version_id,
                     decision, approver_id, note, brief_fit_rubric, decided_at)
                   values (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    record.approval_id,
                    record.campaign_id,
                    record.content_version_id,
                    record.decision,
                    record.approver_id,
                    record.note,
                    _jsonb(record.brief_fit_rubric),
                    record.decided_at,
                ),
            )

    async def add_publication(self, record: PublicationRecord) -> None:
        async with self.pool.connection() as conn:
            approval = await (
                await conn.execute(
                    "select approval_id from approvals where campaign_id = %s "
                    "and decision = 'approved' and revoked_at is null "
                    "order by decided_at desc limit 1",
                    (record.campaign_id,),
                )
            ).fetchone()
            if approval is None:
                raise ValueError("publication without an unrevoked approval (ADR D7)")
            await conn.execute(
                """insert into publish_records (publish_record_id, idempotency_key,
                     campaign_id, content_version_id, approval_id, platform, status,
                     platform_post_id, post_url, published_at)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    record.publish_record_id,
                    f"{record.campaign_id}:{record.platform.value}:{record.content_version_id}",
                    record.campaign_id,
                    record.content_version_id,
                    approval[0],
                    record.platform.value,
                    record.status,
                    record.platform_post_id,
                    record.post_url,
                    record.published_at,
                ),
            )

    async def list_publications(self, campaign_id: UUID) -> list[PublicationRecord]:
        async with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cursor:
            await cursor.execute(
                "select * from publish_records where campaign_id = %s order by created_at",
                (campaign_id,),
            )
            rows = await cursor.fetchall()
        return [
            PublicationRecord(
                publish_record_id=r["publish_record_id"],
                campaign_id=r["campaign_id"],
                content_version_id=r["content_version_id"],
                platform=Platform(r["platform"]),
                status=r["status"],
                platform_post_id=r["platform_post_id"],
                post_url=r["post_url"],
                published_at=r["published_at"],
            )
            for r in rows
        ]

    async def add_metrics(self, snapshot: MetricsSnapshot) -> None:
        async with self.pool.connection() as conn:
            await conn.execute(
                """insert into campaign_metrics (campaign_id, snapshot_day, platform, views,
                     likes, shares, comment_count, engagement_rate, sentiment, raw)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   on conflict (campaign_id, snapshot_day, platform) do update set
                     views = excluded.views, likes = excluded.likes,
                     shares = excluded.shares, comment_count = excluded.comment_count,
                     engagement_rate = excluded.engagement_rate,
                     sentiment = excluded.sentiment, raw = excluded.raw""",
                (
                    snapshot.campaign_id,
                    snapshot.snapshot_day,
                    snapshot.platform.value,
                    snapshot.views,
                    snapshot.likes,
                    snapshot.shares,
                    snapshot.comment_count,
                    snapshot.engagement_rate,
                    _jsonb(snapshot.sentiment),
                    Json(snapshot.raw),
                ),
            )

    async def list_metrics(self, campaign_id: UUID) -> list[MetricsSnapshot]:
        async with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cursor:
            await cursor.execute(
                "select * from campaign_metrics where campaign_id = %s order by snapshot_day",
                (campaign_id,),
            )
            rows = await cursor.fetchall()
        return [
            MetricsSnapshot(
                campaign_id=r["campaign_id"],
                snapshot_day=r["snapshot_day"].isoformat(),
                platform=Platform(r["platform"]),
                views=r["views"],
                likes=r["likes"],
                shares=r["shares"],
                comment_count=r["comment_count"],
                engagement_rate=(
                    float(r["engagement_rate"]) if r["engagement_rate"] is not None else None
                ),
                sentiment=r["sentiment"],
                raw=r["raw"],
            )
            for r in rows
        ]

    async def add_learning(self, record: LearningRecord) -> None:
        async with self.pool.connection() as conn:
            await conn.execute(
                """insert into learnings (learning_id, campaign_id, predicted_score,
                     actual_metrics, insight, insight_status, created_at)
                   values (%s, %s, %s, %s, %s, %s, %s)""",
                (
                    record.learning_id,
                    record.campaign_id,
                    record.predicted_score,
                    Json(record.actual_metrics),
                    record.insight,
                    record.insight_status,
                    record.created_at,
                ),
            )

    # -- audit / effects / creators ----------------------------------------

    async def append_audit(self, event: AuditEvent) -> None:
        async with self.pool.connection() as conn:
            await conn.execute(
                "insert into audit_events (event_id, campaign_id, actor, event, detail, at) "
                "values (%s, %s, %s, %s, %s, %s)",
                (
                    event.event_id,
                    event.campaign_id,
                    event.actor,
                    event.event,
                    _jsonb(event.detail),
                    event.at,
                ),
            )

    async def list_audit(self, campaign_id: UUID) -> list[AuditEvent]:
        async with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cursor:
            await cursor.execute(
                "select * from audit_events where campaign_id = %s order by at",
                (campaign_id,),
            )
            rows = await cursor.fetchall()
        return [
            AuditEvent(
                event_id=r["event_id"],
                campaign_id=r["campaign_id"],
                actor=r["actor"],
                event=r["event"],
                detail=r["detail"],
                at=r["at"],
            )
            for r in rows
        ]

    async def effect_once(self, campaign_id: UUID, node: str, attempt_key: str) -> bool:
        async with self.pool.connection() as conn:
            cursor = await conn.execute(
                "insert into effect_records (campaign_id, node, attempt_key) "
                "values (%s, %s, %s) on conflict do nothing",
                (campaign_id, node, attempt_key),
            )
            return cursor.rowcount == 1

    async def get_creator_by_key_hash(self, api_key_hash: str) -> CreatorRecord | None:
        async with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cursor:
            await cursor.execute(
                "select * from creators where api_key_hash = %s and active",
                (api_key_hash,),
            )
            row = await cursor.fetchone()
        if row is None:
            return None
        return CreatorRecord(
            creator_id=row["creator_id"],
            display_name=row["display_name"],
            api_key_hash=row["api_key_hash"],
            active=row["active"],
        )
