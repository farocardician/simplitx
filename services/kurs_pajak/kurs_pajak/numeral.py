"""Helpers for parsing Indonesian formatted numbers."""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

__all__ = ["parse_id_number", "parse_idr_amount", "extract_unit"]

_THOUSAND_PATTERN = re.compile(r"[.\u202F\s]")
_DECIMAL_SEP_PATTERN = re.compile(r",(?=\d{0,2}(?:\D|$))")
_UNIT_PATTERN = re.compile(r"\((\d+)\)")


def parse_id_number(raw: str) -> Decimal:
    """Parse an Indonesian formatted numeric string into a Decimal."""
    if raw is None:
        raise ValueError("value is required")
    value = raw.strip()
    if not value:
        raise ValueError("value is required")

    # Normalize decimal separator and remove thousands separators
    normalized = _THOUSAND_PATTERN.sub("", value)
    normalized = normalized.replace(",", ".")

    try:
        return Decimal(normalized)
    except InvalidOperation as exc:  # pragma: no cover - defensive guard
        raise ValueError(f"unable to parse numeric value from '{raw}'") from exc


def parse_idr_amount(raw: str) -> Decimal:
    """Parse an IDR currency string such as '16.341,00'."""
    return parse_id_number(raw)


def extract_unit(text: str, default: int = 1) -> int:
    """Extract unit information from a textual label, e.g. 'JPY (100)'."""
    if not text:
        return default
    match = _UNIT_PATTERN.search(text)
    if not match:
        return default
    try:
        unit = int(match.group(1))
    except ValueError:
        return default
    return unit or default
