"""
Helper functions for invoice processing.

This module provides utilities for:
- HS code parsing and validation
- UOM resolution
- Tax calculations
"""

import re
from decimal import Decimal
from typing import Tuple, Dict, Optional
import psycopg2


def parse_hs_code(hs_code_raw: Optional[str]) -> Tuple[str, str]:
    """
    Extract opt (letter) and code (6 digits) from hs_code.

    Examples:
        "A320400" -> ("A", "320400")
        "B123456" -> ("B", "123456")
        "320400"  -> ("", "320400")
        None      -> ("", "")

    Args:
        hs_code_raw: Raw HS code string from Excel/staging

    Returns:
        Tuple of (opt_letter, six_digit_code)
    """
    if not hs_code_raw:
        return ("", "")

    hs_code_raw = str(hs_code_raw).strip().upper()

    # Pattern: optional letter + 6 digits
    match = re.match(r'^([A-Z])?(\d{6})$', hs_code_raw)
    if match:
        opt_letter = match.group(1) or ""
        six_digits = match.group(2)
        return (opt_letter, six_digits)

    # If no match, try to extract just digits
    digits_only = re.sub(r'\D', '', hs_code_raw)
    if len(digits_only) >= 6:
        return ("", digits_only[:6])

    return ("", "")


def validate_hs_code(code: str, conn) -> bool:
    """
    Check if 6-digit HS code exists in public.hs_codes table.

    Args:
        code: 6-digit HS code
        conn: Database connection

    Returns:
        True if code exists, False otherwise
    """
    if not code or len(code) != 6:
        return False

    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM public.hs_codes WHERE code = %s LIMIT 1",
            (code,)
        )
        return cur.fetchone() is not None


def resolve_uom(input_uom: Optional[str], conn) -> Optional[str]:
    """
    Resolve UOM alias to standardized uom_code.

    Examples:
        "KG" -> "UM.0003"
        "GRAM" -> "UM.0004"
        "kg" -> "UM.0003" (case-insensitive)

    Args:
        input_uom: Raw UOM string from staging
        conn: Database connection

    Returns:
        Standardized UOM code (e.g., "UM.0003") or None if not found
    """
    if not input_uom:
        return None

    # Normalize: uppercase and strip whitespace
    input_uom_normalized = str(input_uom).strip().upper()

    with conn.cursor() as cur:
        cur.execute(
            "SELECT uom_code FROM public.uom_aliases WHERE UPPER(alias) = %s LIMIT 1",
            (input_uom_normalized,)
        )
        result = cur.fetchone()
        return result[0] if result else None


def compute_item_calculations(price: Decimal, qty: Decimal) -> Dict[str, Decimal]:
    """
    Compute tax calculations for an invoice item.

    Formula:
        tax_base = price * qty
        other_tax_base = (11/12) * tax_base
        vat = (12/100) * other_tax_base

    Args:
        price: Unit price
        qty: Quantity

    Returns:
        Dictionary with calculated values:
        {
            'tax_base': Decimal,
            'other_tax_base': Decimal,
            'vat': Decimal
        }
    """
    tax_base = price * qty
    other_tax_base = (Decimal('11') / Decimal('12')) * tax_base
    vat = (Decimal('12') / Decimal('100')) * other_tax_base

    return {
        'tax_base': tax_base,
        'other_tax_base': other_tax_base,
        'vat': vat
    }


def get_buyer_name(party_row: tuple) -> str:
    """
    Get buyer name from party record.
    Prefer name_normalized, fallback to display_name.

    Args:
        party_row: Tuple from parties query
                   Expected: (name_normalized, display_name, ...)

    Returns:
        Best available buyer name
    """
    name_normalized, display_name = party_row[0], party_row[1]

    # Prefer name_normalized if not empty
    if name_normalized and name_normalized.strip():
        return name_normalized

    # Fallback to display_name
    return display_name if display_name else ""
