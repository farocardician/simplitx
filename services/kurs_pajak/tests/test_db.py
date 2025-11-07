from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import text

from kurs_pajak.db import FxDatabase
from kurs_pajak.models import FxPeriod, FxRate


@pytest.fixture()
def sqlite_db(tmp_path):
    db_path = tmp_path / "test.db"
    database = FxDatabase(f"sqlite:///{db_path}")
    with database.engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE fx_kurs_period (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    week_start DATE NOT NULL,
                    week_end DATE NOT NULL,
                    kmk_number TEXT NOT NULL,
                    kmk_url TEXT NOT NULL,
                    source_url TEXT NOT NULL,
                    published_at TIMESTAMP,
                    UNIQUE (week_start, week_end)
                );
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE fx_kurs_rate (
                    period_id INTEGER NOT NULL,
                    iso_code TEXT NOT NULL,
                    unit INTEGER NOT NULL,
                    value_idr NUMERIC NOT NULL,
                    collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    source TEXT,
                    PRIMARY KEY (period_id, iso_code)
                );
                """
            )
        )
    yield database
    database.dispose()


def test_upsert_period_inserts_and_updates(sqlite_db):
    initial_usd_value = Decimal("16341.00")
    updated_usd_value = Decimal("16400.00")

    period = FxPeriod(
        week_start=date(2024, 10, 16),
        week_end=date(2024, 10, 22),
        kmk_number="KEP-123/MK.10/2024",
        kmk_url="https://example.com/kmk.pdf",
        source_url="https://example.com/detail",
        published_at=None,
        rates=[
            FxRate(iso_code="USD", unit=1, value_idr=initial_usd_value),
            FxRate(iso_code="JPY", unit=100, value_idr=Decimal("10925.30")),
        ],
    )

    sqlite_db.upsert_period(period)

    stored = sqlite_db.fetch_period(period.week_start, period.week_end)
    assert stored is not None
    assert stored.kmk_number == period.kmk_number
    assert stored.kmk_url == period.kmk_url
    assert {rate.iso_code for rate in stored.rates} == {"USD", "JPY"}
    usd_value = next(rate.value_idr for rate in stored.rates if rate.iso_code == "USD")
    # SQLite may return as float, compare with tolerance
    assert abs(float(usd_value) - float(initial_usd_value)) < 0.01

    # Update USD value and ensure upsert overwrites
    period.rates[0].value_idr = updated_usd_value
    sqlite_db.upsert_period(period)

    stored_again = sqlite_db.fetch_period(period.week_start, period.week_end)
    assert stored_again is not None
    usd_value_updated = next(rate.value_idr for rate in stored_again.rates if rate.iso_code == "USD")
    assert abs(float(usd_value_updated) - float(updated_usd_value)) < 0.01
