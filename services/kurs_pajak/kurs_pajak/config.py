"""Configuration loader for the Kurs Pajak service."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import timedelta
from typing import Optional

from zoneinfo import ZoneInfo


def _get_env(key: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(key)
    if value is not None:
        value = value.strip()
        if value == "":
            return default
        return value
    return default


def _get_int(key: str, default: int) -> int:
    value = _get_env(key)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"Environment variable {key} must be an integer") from exc


def _get_float(key: str, default: float) -> float:
    value = _get_env(key)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"Environment variable {key} must be a number") from exc


def _get_bool(key: str, default: bool) -> bool:
    value = _get_env(key)
    if value is None:
        return default
    value_lower = value.lower()
    if value_lower in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if value_lower in {"0", "false", "f", "no", "n", "off"}:
        return False
    raise ValueError(f"Environment variable {key} must be a boolean")


@dataclass(slots=True)
class AppConfig:
    database_url: str
    base_url: str
    timezone: ZoneInfo
    http_timeout: float
    http_retries: int
    service_poll_interval: timedelta
    service_lookback_weeks: int
    service_startup_backfill: bool
    max_listing_pages: int
    log_level: str
    backup_target_url: Optional[str]
    backup_encryption_key: Optional[str]
    backup_retention_days: int
    backup_enabled: bool
    http_user_agent: str

    @property
    def timezone_name(self) -> str:
        return self.timezone.key


DEFAULT_USER_AGENT = (
    "kurs-pajak-loader/1.0 (+https://fiskal.kemenkeu.go.id/)"
)


def load_config() -> AppConfig:
    database_url = _get_env("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL must be set")

    base_url = _get_env(
        "KURS_PAJAK_BASE_URL",
        "https://fiskal.kemenkeu.go.id/informasi-publik/kurs-pajak",
    )

    tz_name = _get_env("TIMEZONE", "Asia/Jakarta")
    try:
        timezone = ZoneInfo(tz_name)
    except Exception as exc:  # pragma: no cover - defensive guard
        raise ValueError(f"Unable to load timezone '{tz_name}'") from exc

    http_timeout = _get_float("HTTP_TIMEOUT_SECONDS", 30.0)
    http_retries = max(1, _get_int("HTTP_RETRIES", 3))
    poll_interval_seconds = max(60, _get_int("SERVICE_POLL_INTERVAL_SECONDS", 86_400))
    service_lookback_weeks = max(1, _get_int("SERVICE_LOOKBACK_WEEKS", 12))
    service_startup_backfill = _get_bool("SERVICE_STARTUP_BACKFILL", True)
    max_listing_pages = max(1, _get_int("SCRAPER_MAX_PAGES", 40))
    log_level = _get_env("LOG_LEVEL", "INFO").upper()

    backup_target_url = _get_env("BACKUP_TARGET_URL")
    backup_encryption_key = _get_env("BACKUP_ENCRYPTION_KEY")
    backup_retention_days = max(1, _get_int("BACKUP_RETENTION_DAYS", 30))
    backup_enabled = _get_bool("BACKUP_ENABLED", True)
    http_user_agent = _get_env("HTTP_USER_AGENT", DEFAULT_USER_AGENT)

    return AppConfig(
        database_url=database_url,
        base_url=base_url,
        timezone=timezone,
        http_timeout=http_timeout,
        http_retries=http_retries,
        service_poll_interval=timedelta(seconds=poll_interval_seconds),
        service_lookback_weeks=service_lookback_weeks,
        service_startup_backfill=service_startup_backfill,
        max_listing_pages=max_listing_pages,
        log_level=log_level,
        backup_target_url=backup_target_url,
        backup_encryption_key=backup_encryption_key,
        backup_retention_days=backup_retention_days,
        backup_enabled=backup_enabled,
        http_user_agent=http_user_agent,
    )
