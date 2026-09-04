"""Structured JSON logging (ARCHITECTURE.md §7): every log line carries a
campaign_id when one is in scope — bind it with
structlog.contextvars.bind_contextvars(campaign_id=...)."""

import logging
from typing import cast

import structlog


def configure_logging(level: str = "INFO") -> None:
    logging.basicConfig(level=level.upper(), format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelNamesMapping().get(level.upper(), logging.INFO)
        ),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> structlog.types.FilteringBoundLogger:
    return cast(structlog.types.FilteringBoundLogger, structlog.get_logger(name))
