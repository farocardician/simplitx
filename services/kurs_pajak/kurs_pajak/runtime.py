"""Runtime wiring for CLI and service entrypoints."""

from __future__ import annotations

from dataclasses import dataclass

from .backup import BackupManager
from .config import AppConfig, load_config
from .db import FxDatabase
from .loader import PeriodLoader
from .logging import configure_logging
from .scheduler import Scheduler
from .scraper import KursPajakScraper


@dataclass(slots=True)
class Runtime:
    config: AppConfig
    database: FxDatabase
    scraper: KursPajakScraper
    backup_manager: BackupManager
    loader: PeriodLoader
    scheduler: Scheduler

    def close(self) -> None:
        self.scraper.close()
        self.database.dispose()


def build_runtime(config: AppConfig | None = None) -> Runtime:
    cfg = config or load_config()
    configure_logging(cfg.log_level)

    database = FxDatabase(cfg.database_url)
    backup_manager = BackupManager(
        dsn=cfg.database_url,
        target_url=cfg.backup_target_url,
        encryption_key=cfg.backup_encryption_key,
        retention_days=cfg.backup_retention_days,
        enabled=cfg.backup_enabled,
    )

    scraper = KursPajakScraper(
        base_url=cfg.base_url,
        timeout=cfg.http_timeout,
        retries=cfg.http_retries,
        user_agent=cfg.http_user_agent,
        max_pages=cfg.max_listing_pages,
    )

    loader = PeriodLoader(cfg, scraper, database, backup_manager)
    scheduler = Scheduler(cfg, loader)

    return Runtime(
        config=cfg,
        database=database,
        scraper=scraper,
        backup_manager=backup_manager,
        loader=loader,
        scheduler=scheduler,
    )
