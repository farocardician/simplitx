from datetime import date
from decimal import Decimal
from pathlib import Path

from kurs_pajak.models import FxPeriod
from kurs_pajak.parser import parse_period_detail

FIXTURE = Path(__file__).parent / "fixtures" / "sample_detail.html"


def test_parse_period_detail_extracts_metadata_and_rates():
    html = FIXTURE.read_text(encoding="utf-8")
    period = parse_period_detail(html, "https://example.com/detail")

    assert period.week_start == date(2024, 10, 16)
    assert period.week_end == date(2024, 10, 22)
    assert period.kmk_number == "KEP-123/MK.10/2024"
    assert period.kmk_url.endswith("kmk-123.pdf")
    assert period.published_at is not None
    assert {rate.iso_code for rate in period.rates} == {"USD", "JPY", "EUR"}

    usd = next(rate for rate in period.rates if rate.iso_code == "USD")
    assert usd.value_idr == Decimal("16341.00")
    assert usd.unit == 1

    jpy = next(rate for rate in period.rates if rate.iso_code == "JPY")
    assert jpy.unit == 100
    assert jpy.value_idr == Decimal("10925.30")
