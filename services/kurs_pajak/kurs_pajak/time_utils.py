"""Time helpers for Kurs Pajak weekly windows."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

__all__ = ["as_jakarta", "week_window", "daterange"]


def as_jakarta(dt: datetime, tz: ZoneInfo) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=tz)
    return dt.astimezone(tz)


def week_window(target_date: date, week_start_weekday: int = 2) -> tuple[date, date]:
    """
    Return the inclusive week (start, end) containing target_date.

    week_start_weekday defaults to Wednesday (2 when Monday=0).
    """

    weekday = target_date.weekday()
    delta = (weekday - week_start_weekday) % 7
    start = target_date - timedelta(days=delta)
    end = start + timedelta(days=6)
    return start, end


def daterange(start: date, end: date, step_days: int = 7):
    current = start
    delta = timedelta(days=step_days)
    while current <= end:
        yield current
        current += delta
