"""Adapter base: retry with backoff+jitter, timeout, boundary validation.

Retry policy (ARCHITECTURE.md §4.1): transport errors and 5xx/429 are
retryable; other 4xx are not. Only calls the caller marks retryable (GETs
and idempotent analysis submissions) are retried — the graph's
effect_records idempotency handles everything else."""

from __future__ import annotations

import asyncio
import random
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from maistro.telemetry import get_logger

M = TypeVar("M", bound=BaseModel)


class AdapterError(Exception):
    """Normalized upstream failure (adapters map tool errors toward Problem)."""

    def __init__(
        self,
        tool: str,
        detail: str,
        *,
        retryable: bool,
        status: int | None = None,
        upstream: Any = None,
    ) -> None:
        super().__init__(f"{tool}: {detail}")
        self.tool = tool
        self.detail = detail
        self.retryable = retryable
        self.status = status
        self.upstream = upstream


class BoundaryValidationError(AdapterError):
    """Upstream response failed contract validation — rejected at the boundary
    so bad data can never be persisted into a checkpoint (ADR D6)."""

    def __init__(self, tool: str, detail: str, upstream: Any = None) -> None:
        super().__init__(tool, detail, retryable=False, upstream=upstream)


class BaseAdapter:
    tool: str = "base"

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        *,
        timeout: float = 30.0,
        retries: int = 3,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._client = client or httpx.AsyncClient(
            base_url=base_url, headers=headers, timeout=timeout
        )
        self._retries = retries
        self._log = get_logger(f"adapter.{self.tool}")

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        retryable: bool = False,
        attempts: int | None = None,
        **kwargs: Any,
    ) -> httpx.Response:
        max_attempts = attempts if attempts is not None else (self._retries if retryable else 1)
        delay = 0.5
        failure = AdapterError(self.tool, f"{method} {path}: no attempt made", retryable=True)
        for attempt in range(1, max_attempts + 1):
            try:
                response = await self._client.request(method, path, **kwargs)
            except httpx.HTTPError as exc:
                failure = AdapterError(
                    self.tool, f"transport error on {method} {path}: {exc}", retryable=True
                )
            else:
                if response.status_code < 400:
                    return response
                failure = self._http_error(response, method, path)
                if not failure.retryable:
                    raise failure
            self._log.warning(
                "adapter_retry",
                method=method,
                path=path,
                attempt=attempt,
                max_attempts=max_attempts,
                error=failure.detail,
            )
            if attempt < max_attempts:
                await asyncio.sleep(delay + random.random() * delay)
                delay *= 2
        raise failure

    def _http_error(self, response: httpx.Response, method: str, path: str) -> AdapterError:
        body = response.text[:500]
        retryable = response.status_code >= 500 or response.status_code == 429
        return AdapterError(
            self.tool,
            f"{method} {path} -> HTTP {response.status_code}: {body}",
            retryable=retryable,
            status=response.status_code,
            upstream=body,
        )

    def _validate(self, model: type[M], payload: Any) -> M:
        try:
            return model.model_validate(payload)
        except ValidationError as exc:
            raise BoundaryValidationError(
                self.tool,
                f"response failed contract validation for {model.__name__}: "
                f"{exc.errors()[:5]}",
                upstream=payload,
            ) from exc

    async def _get_model(
        self, path: str, model: type[M], *, params: dict[str, Any] | None = None
    ) -> M:
        response = await self._request("GET", path, retryable=True, params=params)
        return self._validate(model, response.json())

    async def _post_model(
        self,
        path: str,
        model: type[M],
        *,
        json: Any | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        retryable: bool = False,
        attempts: int | None = None,
        timeout: float | None = None,
    ) -> M:
        kwargs: dict[str, Any] = {}
        if json is not None:
            kwargs["json"] = json
        if data is not None:
            kwargs["data"] = data
        if files is not None:
            kwargs["files"] = files
        if timeout is not None:
            kwargs["timeout"] = timeout
        response = await self._request(
            "POST", path, retryable=retryable, attempts=attempts, **kwargs
        )
        return self._validate(model, response.json())
