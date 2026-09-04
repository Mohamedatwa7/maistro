"""SamsungSentiment adapter (monitoring stage, read-mostly).

/api/comments takes no parameters and returns the full gzipped corpus —
callers filter client-side and fetch once per monitoring tick, not per
campaign. Platform enum upstream is "twitter"; Maistro uses "x" — map with
to_maistro_platform() at the boundary (CONTRACTS.md §5)."""

from __future__ import annotations

from maistro.adapters.base import BaseAdapter
from maistro.generated.sentiment import CorpusResponse, ScrapersInfo, TriggerResponse

CORPUS_TIMEOUT_S = 60.0


def to_maistro_platform(platform: str) -> str:
    return "x" if platform == "twitter" else platform


def to_sentiment_platform(platform: str) -> str:
    return "twitter" if platform == "x" else platform


class SentimentAdapter(BaseAdapter):
    tool = "sentiment"

    async def get_corpus(self) -> CorpusResponse:
        response = await self._request(
            "GET", "/api/comments", retryable=True, timeout=CORPUS_TIMEOUT_S
        )
        return self._validate(CorpusResponse, response.json())

    async def list_scrapers(self) -> ScrapersInfo:
        return await self._get_model("/api/apify/trigger", ScrapersInfo)

    async def trigger_scrape(
        self,
        platform: str,
        *,
        scrape_type: str = "posts",
        target_username: str | None = None,
    ) -> TriggerResponse:
        # Maistro rate contract: <= 1 trigger per campaign per day — enforced
        # by the graph's effect_records, not here.
        body: dict[str, str] = {
            "platform": to_sentiment_platform(platform),
            "type": scrape_type,
        }
        if target_username is not None:
            body["targetUsername"] = target_username
        return await self._post_model("/api/apify/trigger", TriggerResponse, json=body)
