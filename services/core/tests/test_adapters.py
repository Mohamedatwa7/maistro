"""Adapter unit tests against recorded/mocked responses.

These verify boundary behavior (parse, validate, error mapping) — the
nightly contract tests against live staging endpoints are a separate suite
(tests/contract/, M1-W4)."""

import httpx
import pytest
import respx

from maistro.adapters import (
    AdapterError,
    BoundaryValidationError,
    F1X8Adapter,
    LenceusAdapter,
    SentimentAdapter,
    TrendRadarAdapter,
)
from maistro.adapters.sentiment import to_maistro_platform, to_sentiment_platform

MINIMAL_TREND = {
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


@respx.mock
async def test_trend_radar_list_trends_parses() -> None:
    respx.get("http://tr.test/api/agent/trends").mock(
        return_value=httpx.Response(
            200,
            json={"generatedAt": None, "live": True, "total": 1, "trends": [MINIMAL_TREND]},
        )
    )
    adapter = TrendRadarAdapter("http://tr.test", "key")
    result = await adapter.list_trends(on_brand=True, limit=10)
    assert result.total == 1
    assert result.trends[0].id == "t1"
    assert result.trends[0].products[0].score == 80
    await adapter.aclose()


@respx.mock
async def test_trend_radar_rejects_contract_violation() -> None:
    # "trends" missing entirely — must be rejected at the boundary, not
    # propagated into state (ADR D6).
    respx.get("http://tr.test/api/agent/trends").mock(
        return_value=httpx.Response(200, json={"generatedAt": None, "live": True})
    )
    adapter = TrendRadarAdapter("http://tr.test", "key")
    with pytest.raises(BoundaryValidationError):
        await adapter.list_trends()
    await adapter.aclose()


@respx.mock
async def test_f1x8_maps_200_bodied_error() -> None:
    respx.post("http://f8.test/api/analyze/image").mock(
        return_value=httpx.Response(200, json={"error": "boom", "trace": "..."})
    )
    adapter = F1X8Adapter("http://f8.test")
    with pytest.raises(AdapterError) as excinfo:
        await adapter.analyze_image(b"png-bytes", "kv.png", description="brief text")
    assert excinfo.value.retryable is True
    assert "boom" in excinfo.value.detail
    await adapter.aclose()


@respx.mock
async def test_f1x8_job_polling_shape() -> None:
    respx.get("http://f8.test/api/job/j1").mock(
        return_value=httpx.Response(200, json={"status": "analyzing"})
    )
    adapter = F1X8Adapter("http://f8.test")
    job = await adapter.get_job("j1")
    assert job.status.value == "analyzing"
    assert job.result is None
    await adapter.aclose()


@respx.mock
async def test_sentiment_corpus_and_platform_mapping() -> None:
    respx.get("http://ss.test/api/comments").mock(
        return_value=httpx.Response(
            200,
            json={
                "posts": [],
                "comments": [],
                "meta": {
                    "totalPosts": 0,
                    "totalComments": 0,
                    "analyzedComments": 0,
                    "unanalyzedComments": 0,
                },
            },
        )
    )
    adapter = SentimentAdapter("http://ss.test")
    corpus = await adapter.get_corpus()
    assert corpus.meta.analyzedComments == 0
    assert to_maistro_platform("twitter") == "x"
    assert to_sentiment_platform("x") == "twitter"
    assert to_maistro_platform("tiktok") == "tiktok"
    await adapter.aclose()


@respx.mock
async def test_lenceus_log() -> None:
    respx.get("http://ln.test/api/log").mock(
        return_value=httpx.Response(
            200,
            json={
                "events": [
                    {
                        "id": 1,
                        "site_id": "du",
                        "site": "du",
                        "run_at": "2026-09-04T05:00:00Z",
                        "count": 4,
                        "deviceSharePct": None,
                        "searchSharePct": 41.2,
                    }
                ]
            },
        )
    )
    adapter = LenceusAdapter("http://ln.test")
    log = await adapter.get_log(limit=10)
    assert log.events[0].count == 4
    # null means NOT MEASURED — the generated type keeps it None, never 0.
    assert log.events[0].deviceSharePct is None
    await adapter.aclose()


@respx.mock
async def test_retryable_get_retries_then_raises() -> None:
    route = respx.get("http://tr.test/api/agent/trends").mock(
        return_value=httpx.Response(500, text="upstream down")
    )
    adapter = TrendRadarAdapter("http://tr.test", "key", retries=2)
    with pytest.raises(AdapterError) as excinfo:
        await adapter.list_trends()
    assert route.call_count == 2
    assert excinfo.value.retryable is True
    assert excinfo.value.status == 500
    await adapter.aclose()


@respx.mock
async def test_4xx_is_not_retried() -> None:
    route = respx.get("http://tr.test/api/agent/trends").mock(
        return_value=httpx.Response(401, json={"error": "auth"})
    )
    adapter = TrendRadarAdapter("http://tr.test", "bad-key", retries=3)
    with pytest.raises(AdapterError) as excinfo:
        await adapter.list_trends()
    assert route.call_count == 1
    assert excinfo.value.retryable is False
    await adapter.aclose()
