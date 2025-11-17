from decimal import Decimal

import pytest

from kurs_pajak.numeral import extract_unit, parse_idr_amount


def test_parse_idr_amount_handles_indonesian_format():
    assert parse_idr_amount("16.341,00") == Decimal("16341.00")
    assert parse_idr_amount("1.234.567,89") == Decimal("1234567.89")


def test_parse_idr_amount_rejects_empty():
    with pytest.raises(ValueError):
        parse_idr_amount("")


def test_extract_unit_defaults_and_parses():
    assert extract_unit("JPY (100)") == 100
    assert extract_unit("USD") == 1
    assert extract_unit("CNY (10)") == 10
