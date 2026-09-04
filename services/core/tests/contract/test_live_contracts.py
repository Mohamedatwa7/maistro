"""Live contract tests (CONTRACTS.md §6): call each STAGING endpoint and
validate the real response against the contract models.

These are the nightly drift tripwire, not unit tests. Each tool's tests run
only when its staging URL/key is configured (MAISTRO_* env vars) — locally
they skip, in the nightly workflow the staging environment provides them.

A failure here means one side drifted: read the BoundaryValidationError to
see the endpoint, field, and spec, then decide which side changed
(packages/contracts/README.md)."""

from __future__ import annotations

import os

import pytest

from maistro.adapters import (
    F1X8Adapter,
    LenceusAdapter,
    SentimentAdapter,
    TrendRadarAdapter,
)

pytestmark = pytest.mark.contract


def _env(name: str) -> str | None:
    value = os.environ.get(name)
    return value if value else None


requires_trend_radar = pytest.mark.skipif(
    not (_env("MAISTRO_TREND_RADAR_BASE_URL") and _env("MAISTRO_TREND_RADAR_AGENT_KEY")),
    reason="Trend Radar staging not configured",
)
requires_f1x8 = pytest.mark.skipif(
    not _env("MAISTRO_F1X8_BASE_URL"),
    reason="F1X8 staging not configured",
)
requires_sentiment = pytest.mark.skipif(
    not _env("MAISTRO_SENTIMENT_BASE_URL"),
    reason="SamsungSentiment staging not configured",
)
requires_lenceus = pytest.mark.skipif(
    not _env("MAISTRO_LENCEUS_BASE_URL"),
    reason="Lenceus staging not configured",
)


@requires_trend_radar
async def test_trend_radar_trends_contract() -> None:
    adapter = TrendRadarAdapter(
        os.environ["MAISTRO_TREND_RADAR_BASE_URL"],
        os.environ["MAISTRO_TREND_RADAR_AGENT_KEY"],
    )
    try:
        result = await adapter.list_trends(limit=5)
        # Boundary validation already ran; assert the envelope invariants.
        assert result.total >= 0
        assert len(result.trends) <= 5
        if not result.live:
            pytest.xfail("Trend Radar returned live=false (build-time snapshot)")
    finally:
        await adapter.aclose()


@requires_trend_radar
async def test_trend_radar_sounds_contract() -> None:
    adapter = TrendRadarAdapter(
        os.environ["MAISTRO_TREND_RADAR_BASE_URL"],
        os.environ["MAISTRO_TREND_RADAR_AGENT_KEY"],
    )
    try:
        result = await adapter.get_sounds(limit=5)
        assert len(result.sounds) <= 5
    finally:
        await adapter.aclose()


@requires_trend_radar
async def test_trend_radar_terms_contract() -> None:
    adapter = TrendRadarAdapter(
        os.environ["MAISTRO_TREND_RADAR_BASE_URL"],
        os.environ["MAISTRO_TREND_RADAR_AGENT_KEY"],
    )
    try:
        result = await adapter.get_terms(limit=5)
        assert result.terms is not None
    finally:
        await adapter.aclose()


@requires_f1x8
async def test_f1x8_health_and_job_shape() -> None:
    adapter = F1X8Adapter(
        os.environ["MAISTRO_F1X8_BASE_URL"],
        _env("MAISTRO_F1X8_API_KEY"),
    )
    try:
        # Health is the cheap liveness check; unknown job pins the
        # not_found contract without spending GPU time.
        response = await adapter._request("GET", "/health")
        assert response.json().get("status") == "ok"
        job = await adapter.get_job("maistro-contract-test-nonexistent")
        assert job.status.value == "not_found"
    finally:
        await adapter.aclose()


@requires_sentiment
async def test_sentiment_corpus_contract() -> None:
    adapter = SentimentAdapter(
        os.environ["MAISTRO_SENTIMENT_BASE_URL"],
        _env("MAISTRO_SENTIMENT_API_KEY"),
    )
    try:
        corpus = await adapter.get_corpus()
        meta = corpus.meta
        assert meta.totalComments == meta.analyzedComments + meta.unanalyzedComments
    finally:
        await adapter.aclose()


@requires_sentiment
async def test_sentiment_scrapers_contract() -> None:
    adapter = SentimentAdapter(
        os.environ["MAISTRO_SENTIMENT_BASE_URL"],
        _env("MAISTRO_SENTIMENT_API_KEY"),
    )
    try:
        info = await adapter.list_scrapers()
        assert "instagram" in info.scrapers
    finally:
        await adapter.aclose()


@requires_lenceus
async def test_lenceus_contract() -> None:
    adapter = LenceusAdapter(
        os.environ["MAISTRO_LENCEUS_BASE_URL"],
        _env("MAISTRO_LENCEUS_API_KEY"),
    )
    try:
        health = await adapter.health()
        assert health.backend.value in ("sqlite", "supabase")
        sites = await adapter.list_sites()
        assert len(sites.sites) >= 1
        log = await adapter.get_log(limit=5)
        assert len(log.events) <= 5
    finally:
        await adapter.aclose()
