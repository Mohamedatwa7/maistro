"""Shared service-layer error type (RFC 9457-adjacent; surfaced as Problem
by REST and as structured error payloads by MCP tools)."""

from __future__ import annotations

from typing import Any


class ServiceError(Exception):
    def __init__(self, status_code: int, code: str, detail: str, extra: Any = None) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.code = code
        self.detail = detail
        self.extra = extra
