"""Async scheduler that keeps Kurs Pajak data up to date."""

from __future__ import annotations

import asyncio
from datetime import date

from .config import AppConfig
from .loader import PeriodLoader
from .logging import get_logger

logger = get_logger(__name__)


class Scheduler:
    def __init__(self, config: AppConfig, loader: PeriodLoader) -> None:
        self.config = config
        self.loader = loader
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

    async def start(self) -> None:
        if self._task:
            return
        self._stop_event.clear()
        if self.config.service_startup_backfill:
            await self._run_startup_backfill()
        self._task = asyncio.create_task(self._run_loop())
        logger.info("scheduler_started")

    async def stop(self) -> None:
        if not self._task:
            return
        self._stop_event.set()
        await self._task
        self._task = None
        logger.info("scheduler_stopped")

    async def _run_loop(self) -> None:
        interval = self.config.service_poll_interval.total_seconds()
        while not self._stop_event.is_set():
            try:
                await asyncio.to_thread(self.loader.sync_current_window)
            except Exception as exc:  # pragma: no cover
                logger.error("scheduler_tick_error", error=str(exc))
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=interval)
            except asyncio.TimeoutError:
                continue

    async def _run_startup_backfill(self) -> None:
        logger.info("scheduler_startup_backfill")
        await asyncio.to_thread(self.loader.backfill_since, date.min)
