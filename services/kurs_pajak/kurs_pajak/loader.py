"""Load parsed Kurs Pajak data into Postgres."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional

from .backup import BackupManager
from .config import AppConfig
from .db import FxDatabase
from .logging import get_logger
from .models import FxPeriod
from .scraper import KursPajakScraper
from .time_utils import week_window

logger = get_logger(__name__)


class PeriodLoader:
    def __init__(
        self,
        config: AppConfig,
        scraper: KursPajakScraper,
        database: FxDatabase,
        backup_manager: BackupManager,
    ) -> None:
        self.config = config
        self.scraper = scraper
        self.database = database
        self.backup_manager = backup_manager

    def load_for_date(self, target_date: date) -> bool:
        logger.info("load_for_date", target_date=str(target_date))
        period = self.scraper.get_period_for_date(target_date)
        if not period:
            raise LookupError(f"Tidak menemukan periode untuk tanggal {target_date}")
        return self._store_period(period, reason="cli-date")

    def backfill_since(self, since_date: date) -> int:
        logger.info("backfill_since", since=str(since_date))
        stored = 0
        for period in self.scraper.iter_periods(since=since_date):
            if self._store_period(period, reason="backfill"):
                stored += 1
        logger.info("backfill_completed", count=stored)
        return stored

    def sync_current_window(self) -> bool:
        today = datetime.now(self.config.timezone).date()
        start, _ = week_window(today)
        since = today - timedelta(weeks=self.config.service_lookback_weeks)
        changed = False

        logger.info(
            "service_sync_start",
            today=str(today),
            since=str(since),
            timezone=self.config.timezone_name,
        )
        for period in self.scraper.iter_periods(since=since):
            if period.week_start < since:
                break
            if self._store_period(period, reason="service"):
                changed = True
        logger.info("service_sync_done", changed=changed)
        return changed

    def _store_period(self, period: FxPeriod, reason: str) -> bool:
        period = self._normalize_period(period)
        existing = self.database.fetch_period(period.week_start, period.week_end)
        if existing and _periods_equal(existing, period):
            logger.info(
                "period_up_to_date",
                week_start=str(period.week_start),
                kmk=period.kmk_number,
            )
            return False

        self.backup_manager.backup(reason=f"before_{reason}")
        self.database.upsert_period(period)
        logger.info(
            "period_upserted",
            week_start=str(period.week_start),
            kmk=period.kmk_number,
            rates=len(period.rates),
        )
        return True

    def _normalize_period(self, period: FxPeriod) -> FxPeriod:
        if period.published_at and period.published_at.tzinfo is None:
            period.published_at = period.published_at.replace(tzinfo=self.config.timezone)
        period.ensure_unique_rates()
        return period


def _periods_equal(a: FxPeriod, b: FxPeriod) -> bool:
    if (
        a.kmk_number.strip() != b.kmk_number.strip()
        or a.kmk_url.strip() != b.kmk_url.strip()
    ):
        return False

    if bool(a.published_at) != bool(b.published_at):
        return False

    if a.published_at and b.published_at:
        if a.published_at.replace(tzinfo=None) != b.published_at.replace(tzinfo=None):
            return False

    rates_a = {rate.iso_code.upper(): (rate.unit, _quantize(rate.value_idr)) for rate in a.rates}
    rates_b = {rate.iso_code.upper(): (rate.unit, _quantize(rate.value_idr)) for rate in b.rates}
    return rates_a == rates_b


def _quantize(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"))
