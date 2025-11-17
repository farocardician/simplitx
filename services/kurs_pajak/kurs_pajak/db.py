"""Database helpers around Postgres using SQLAlchemy Core."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Iterable, Optional

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, Result
from sqlalchemy.orm import sessionmaker

from .models import FxPeriod, FxRate


@dataclass(slots=True)
class RateSnapshot:
    iso_code: str
    unit: int
    value_idr: Decimal
    source: Optional[str]


class FxDatabase:
    def __init__(self, dsn: str):
        driver_dsn = _ensure_psycopg_driver(dsn)
        self.engine: Engine = create_engine(driver_dsn, future=True, pool_pre_ping=True)
        self.Session = sessionmaker(self.engine, expire_on_commit=False, future=True)

    def dispose(self) -> None:
        self.engine.dispose()

    def fetch_period(self, week_start: date, week_end: date) -> Optional[FxPeriod]:
        with self.Session() as session:
            row = session.execute(
                text(
                    """
                    SELECT id, week_start, week_end, kmk_number, kmk_url, source_url, published_at
                    FROM fx_kurs_period
                    WHERE week_start = :week_start AND week_end = :week_end
                    """
                ),
                {"week_start": week_start, "week_end": week_end},
            ).mappings().first()

            if not row:
                return None

            return self._hydrate_period(session, row)

    def fetch_latest_period(self) -> Optional[FxPeriod]:
        with self.Session() as session:
            row = session.execute(
                text(
                    """
                    SELECT id, week_start, week_end, kmk_number, kmk_url, source_url, published_at
                    FROM fx_kurs_period
                    ORDER BY week_start DESC
                    LIMIT 1
                    """
                )
            ).mappings().first()

            if not row:
                return None

            return self._hydrate_period(session, row)

    def fetch_period_containing(self, target_date: date) -> Optional[FxPeriod]:
        with self.Session() as session:
            row = session.execute(
                text(
                    """
                    SELECT id, week_start, week_end, kmk_number, kmk_url, source_url, published_at
                    FROM fx_kurs_period
                    WHERE week_start <= :target_date AND week_end >= :target_date
                    ORDER BY week_start DESC
                    LIMIT 1
                    """
                ),
                {"target_date": target_date},
            ).mappings().first()

            if not row:
                return None

            return self._hydrate_period(session, row)

    def upsert_period(self, period: FxPeriod) -> None:
        period.ensure_unique_rates()
        with self.engine.begin() as conn:
            period_row = conn.execute(
                text(
                    """
                    INSERT INTO fx_kurs_period (
                        week_start,
                        week_end,
                        kmk_number,
                        kmk_url,
                        source_url,
                        published_at
                    )
                    VALUES (:week_start, :week_end, :kmk_number, :kmk_url, :source_url, :published_at)
                    ON CONFLICT (week_start, week_end)
                    DO UPDATE SET
                        kmk_number = EXCLUDED.kmk_number,
                        kmk_url = EXCLUDED.kmk_url,
                        source_url = EXCLUDED.source_url,
                        published_at = EXCLUDED.published_at
                    RETURNING id
                    """
                ),
                {
                    "week_start": period.week_start,
                    "week_end": period.week_end,
                    "kmk_number": period.kmk_number,
                    "kmk_url": period.kmk_url,
                    "source_url": period.source_url,
                    "published_at": period.published_at,
                },
            ).mappings().one()

            period_id = period_row["id"]

            # Convert Decimal to float for SQLite compatibility
            is_sqlite = "sqlite" in str(self.engine.url)
            rate_params = [
                {
                    "period_id": period_id,
                    "iso_code": rate.iso_code.upper(),
                    "unit": rate.unit,
                    "value_idr": float(rate.value_idr) if is_sqlite else rate.value_idr,
                    "source": rate.source or period.source_url,
                }
                for rate in period.rates
            ]

            for chunk in _chunked(rate_params, 50):
                conn.execute(
                    text(
                        """
                        INSERT INTO fx_kurs_rate (
                            period_id, iso_code, unit, value_idr, source
                        ) VALUES (
                            :period_id, :iso_code, :unit, :value_idr, :source
                        )
                        ON CONFLICT (period_id, iso_code)
                        DO UPDATE SET
                            unit = EXCLUDED.unit,
                            value_idr = EXCLUDED.value_idr,
                            source = EXCLUDED.source,
                            collected_at = CURRENT_TIMESTAMP
                        """
                    ),
                    chunk,
                )

    def find_rate_for(self, target_date: date, iso_code: str) -> Optional[RateSnapshot]:
        iso_upper = iso_code.upper()
        with self.Session() as session:
            row = session.execute(
                text(
                    """
                    SELECT r.iso_code, r.unit, r.value_idr, r.source
                    FROM fx_kurs_rate r
                    JOIN fx_kurs_period p ON p.id = r.period_id
                    WHERE p.week_start <= :target_date
                      AND p.week_end >= :target_date
                      AND r.iso_code = :iso_code
                    ORDER BY p.week_start DESC
                    LIMIT 1
                    """
                ),
                {"target_date": target_date, "iso_code": iso_upper},
            ).mappings().first()

            if not row:
                return None

            return RateSnapshot(
                iso_code=row["iso_code"],
                unit=row["unit"],
                value_idr=row["value_idr"],
                source=row["source"],
            )

    def existing_periods(self) -> Iterable[tuple[date, date]]:
        with self.Session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT week_start, week_end
                    FROM fx_kurs_period
                    ORDER BY week_start DESC
                    """
                )
            ).all()
            for row in rows:
                yield row[0], row[1]


    def _hydrate_period(self, session, row) -> FxPeriod:
        rates_result: Result = session.execute(
            text(
                """
                SELECT iso_code, unit, value_idr, source
                FROM fx_kurs_rate
                WHERE period_id = :period_id
                ORDER BY iso_code
                """
            ),
            {"period_id": row["id"]},
        )

        period = FxPeriod(
            week_start=row["week_start"],
            week_end=row["week_end"],
            kmk_number=row["kmk_number"],
            kmk_url=row["kmk_url"],
            source_url=row["source_url"],
            published_at=row["published_at"],
            rates=[
                FxRate(
                    iso_code=rate_row["iso_code"],
                    unit=rate_row["unit"],
                    value_idr=rate_row["value_idr"],
                    source=rate_row["source"],
                )
                for rate_row in rates_result.mappings()
            ],
        )
        period.ensure_unique_rates()
        return period


def _ensure_psycopg_driver(dsn: str) -> str:
    if dsn.startswith("postgresql://") and "+psycopg" not in dsn:
        return dsn.replace("postgresql://", "postgresql+psycopg://", 1)
    if dsn.startswith("postgres://") and "+psycopg" not in dsn:
        return dsn.replace("postgres://", "postgresql+psycopg://", 1)
    return dsn


def _chunked(items, chunk_size: int):
    bucket = []
    for item in items:
        bucket.append(item)
        if len(bucket) >= chunk_size:
            yield bucket
            bucket = []
    if bucket:
        yield bucket
