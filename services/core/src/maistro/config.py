"""Runtime settings. Every value can come from the environment (MAISTRO_*)
or a local .env file; secrets never live in code (ADR D12)."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MAISTRO_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: str = "local"  # local | staging | prod
    log_level: str = "INFO"

    database_url: str | None = None

    # Upstream tools (adapter targets). Keys are per-service credentials
    # issued by the Maistro operator; SamsungSentiment/Lenceus enforcement
    # lands in M1-W3 (verified gap — ARCHITECTURE.md §6).
    trend_radar_base_url: str = "https://kymah.com"
    trend_radar_agent_key: str | None = None

    f1x8_base_url: str = "https://mohamedymay7--fixation-api-fastapi-app.modal.run"
    f1x8_api_key: str | None = None

    sentiment_base_url: str | None = None
    sentiment_api_key: str | None = None

    lenceus_base_url: str = "http://localhost:4000"
    lenceus_api_key: str | None = None

    # Publishing is dry-run everywhere except prod, permanently (CONTRACTS.md §5).
    publish_dry_run: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()
