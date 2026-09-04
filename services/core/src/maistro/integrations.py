"""Production implementations of the graph dependency protocols
(graph/deps.py), wired in app.py. Tests use fakes."""

from __future__ import annotations

from uuid import UUID

from maistro.adapters.f1x8 import F1X8Adapter
from maistro.adapters.sentiment import SentimentAdapter, to_maistro_platform
from maistro.graph.deps import JobPoll, ScoreSubmission
from maistro.store import ContentVersionRecord, MetricsSnapshot, PublicationRecord


class MemoryAssetStore:
    """Asset bytes keyed by asset_ref. Supabase Storage replaces this when
    the dedicated project is provisioned; the interface is get/put."""

    def __init__(self) -> None:
        self._blobs: dict[str, bytes] = {}

    def put(self, asset_ref: str, data: bytes) -> None:
        if asset_ref in self._blobs:
            # Content-addressed keys are immutable (POSTABILITY.md §seal).
            raise ValueError(f"asset_ref already exists: {asset_ref}")
        self._blobs[asset_ref] = data

    def get(self, asset_ref: str) -> bytes:
        return self._blobs[asset_ref]


class F1X8Scorer:
    """Scorer over the F1X8 adapter: sync for images, submit/poll for video.
    The brief text rides along as `description` so F1X8 returns
    context_score (J4 brief-fit)."""

    def __init__(self, adapter: F1X8Adapter, assets: MemoryAssetStore) -> None:
        self.adapter = adapter
        self.assets = assets

    async def submit(self, version: ContentVersionRecord, brief_text: str) -> ScoreSubmission:
        data = self.assets.get(version.asset_ref)
        filename = version.asset_ref.rsplit("/", 1)[-1]
        if version.media_type == "image":
            result = await self.adapter.analyze_image(
                data, filename, description=brief_text or None, format_type="social"
            )
            return ScoreSubmission(result=result.model_dump(mode="json"))
        job = await self.adapter.submit_video(data, filename, description=brief_text or None)
        return ScoreSubmission(job_id=job.job_id)

    async def poll(self, job_id: str) -> JobPoll:
        job = await self.adapter.get_job(job_id)
        return JobPoll(
            status=job.status.value,
            result=job.result.model_dump(mode="json") if job.result is not None else None,
            error=job.error,
        )


class SentimentMetricsSource:
    """Monitoring metrics from the SamsungSentiment corpus, filtered to the
    campaign's recorded post URLs. One corpus fetch per tick (the endpoint
    returns everything — CONTRACTS.md §1.3)."""

    def __init__(self, adapter: SentimentAdapter) -> None:
        self.adapter = adapter

    async def snapshot(
        self, campaign_id: UUID, publications: list[PublicationRecord], day: str
    ) -> list[MetricsSnapshot]:
        if not publications:
            return []
        corpus = await self.adapter.get_corpus()
        by_url = {p.post_url: p for p in publications if p.post_url}
        snapshots: list[MetricsSnapshot] = []
        for post in corpus.posts:
            publication = by_url.get(post.url)
            if publication is None:
                continue
            comments = [c for c in corpus.comments if c.postUrl == post.url]
            scored = [
                c.sentimentScore for c in comments if c.sentimentScore is not None
            ]
            breakdown = {
                "positive": sum(1 for c in comments if c.sentiment.value == "positive"),
                "neutral": sum(1 for c in comments if c.sentiment.value == "neutral"),
                "negative": sum(1 for c in comments if c.sentiment.value == "negative"),
                "mean_score": (sum(scored) / len(scored)) if scored else None,
            }
            views = post.views or 0
            engagement = (post.likes + len(comments)) / views if views else None
            snapshots.append(
                MetricsSnapshot(
                    campaign_id=campaign_id,
                    snapshot_day=day,
                    platform=publication.platform,
                    views=post.views,
                    likes=post.likes,
                    comment_count=len(comments),
                    engagement_rate=engagement,
                    sentiment=breakdown,
                    raw={
                        "post_url": post.url,
                        "source_platform": to_maistro_platform(post.platform.value),
                    },
                )
            )
        return snapshots
