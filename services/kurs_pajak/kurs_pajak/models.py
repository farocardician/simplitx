"""Domain models for Kurs Pajak periods and exchange rates."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import List, Optional


@dataclass(slots=True)
class FxRate:
    """Single FX rate entry parsed from the official Kurs Pajak table."""

    iso_code: str
    value_idr: Decimal
    unit: int = 1
    source: Optional[str] = None

    def normalized_value(self) -> Decimal:
        """Return the per-1 unit IDR value, adjusting for the unit."""
        if self.unit <= 0:
            raise ValueError("unit must be positive")
        return self.value_idr / Decimal(self.unit)


@dataclass(slots=True)
class FxPeriod:
    """Collected FX rates for a given weekly period."""

    week_start: date
    week_end: date
    kmk_number: str
    kmk_url: str
    source_url: str
    published_at: Optional[datetime] = None
    rates: List[FxRate] = field(default_factory=list)

    def key(self) -> tuple[date, date]:
        """Return the unique (week_start, week_end) key."""
        return (self.week_start, self.week_end)

    def ensure_unique_rates(self) -> None:
        """Ensure only one rate per ISO code is stored, keeping the latest occurrence."""
        latest: dict[str, FxRate] = {}
        for rate in self.rates:
            latest[rate.iso_code.upper()] = rate
        self.rates = list(latest.values())

    def iso_codes(self) -> List[str]:
        return sorted({rate.iso_code.upper() for rate in self.rates})
