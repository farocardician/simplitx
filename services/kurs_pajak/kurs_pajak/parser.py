"""HTML parsing for Kurs Pajak detail pages."""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal
from typing import List, Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup, NavigableString, Tag
import dateparser

from .logging import get_logger
from .models import FxPeriod, FxRate
from .numeral import extract_unit, parse_idr_amount

logger = get_logger(__name__)

DATE_CONNECTORS = re.compile(
    r"(?:\bsampai(?:\s+dengan)?\b|\bs\.?d\.?\b|\bs/d\b|\bsdg\b|\bhingga\b|\bto\b|-)",
    re.IGNORECASE,
)
MONTH_FALLBACK = {
    "okt": "Oktober",
    "des": "Desember",
    "agt": "Agustus",
    "mei": "Mei",
}
ISO_PATTERN = re.compile(r"\b([A-Z]{3})\b")
NUMBER_PATTERN = re.compile(r"\d")

FIELD_LABELS = {
    "tanggal": ["tanggal berlaku", "periode", "berlaku"],
    "kmk": ["kmk", "keputusan", "nomor", "kep"],
}


def parse_listing_page(html: str, source_url: str) -> List[FxPeriod]:
    """Parse periods directly from the listing page (new website format)."""
    soup = BeautifulSoup(html, "lxml")
    periods: List[FxPeriod] = []

    # Find all KMK blocks - they start with <p><strong>KMK Nomor...
    kmk_headers = soup.find_all("p")

    for header in kmk_headers:
        strong = header.find("strong")
        if not strong:
            continue

        text = strong.get_text(strip=True)
        if not text.upper().startswith("KMK NOMOR"):
            continue

        # Extract KMK number
        kmk_number = text.replace("KMK Nomor", "").strip()
        if not kmk_number:
            continue

        # Find the date range (next <em> tag)
        date_elem = header.find_next_sibling()
        if not date_elem:
            continue

        date_text = date_elem.get_text(strip=True)
        if "Tanggal Berlaku:" not in date_text:
            continue

        # Extract date range
        date_range = date_text.replace("Tanggal Berlaku:", "").strip()
        try:
            week_start, week_end = _parse_period_range(date_range)
        except ValueError as e:
            logger.warning("parse_date_failed", kmk=kmk_number, date=date_range, error=str(e))
            continue

        # Find the PDF link (next <a> with href containing .pdf)
        kmk_url = ""
        pdf_link = date_elem.find_next("a", href=lambda x: x and ".pdf" in x.lower())
        if pdf_link:
            kmk_url = urljoin(source_url, pdf_link["href"])

        # Find the table (next <table>)
        table = date_elem.find_next("table")
        if not table:
            logger.warning("no_table_found", kmk=kmk_number)
            continue

        # Parse rates from table
        rates = _parse_rates_from_table(table, source_url)
        if not rates:
            logger.warning("no_rates_found", kmk=kmk_number)
            continue

        period = FxPeriod(
            week_start=week_start,
            week_end=week_end,
            kmk_number=kmk_number,
            kmk_url=kmk_url,
            source_url=source_url,
            published_at=None,
            rates=rates,
        )
        period.ensure_unique_rates()
        periods.append(period)
        logger.info("parsed_period", kmk=kmk_number, start=str(week_start), end=str(week_end), rates=len(rates))

    return periods


def parse_period_detail(html: str, source_url: str) -> FxPeriod:
    soup = BeautifulSoup(html, "lxml")

    tanggal_text = _extract_field_value(soup, FIELD_LABELS["tanggal"])
    if not tanggal_text:
        raise ValueError("Tidak menemukan informasi Tanggal Berlaku")
    week_start, week_end = _parse_period_range(tanggal_text)

    kmk_number = _extract_field_value(soup, FIELD_LABELS["kmk"]) or _find_kmk_number(soup)
    if not kmk_number:
        raise ValueError("Tidak menemukan nomor KMK")
    kmk_number = kmk_number.strip().upper()

    kmk_url = _find_kmk_url(soup, source_url)
    rates = _parse_rates(soup, source_url)
    if not rates:
        raise ValueError("Tidak menemukan tabel kurs pajak")

    published_at = _extract_published_at(soup, week_start)

    period = FxPeriod(
        week_start=week_start,
        week_end=week_end,
        kmk_number=kmk_number,
        kmk_url=kmk_url,
        source_url=source_url,
        published_at=published_at,
        rates=rates,
    )
    period.ensure_unique_rates()
    return period


def _extract_field_value(soup: BeautifulSoup, labels: List[str]) -> Optional[str]:
    label_pattern = re.compile("|".join(labels), re.IGNORECASE)

    # Preferred: Drupal-style field containers
    for container in soup.find_all(class_=re.compile("field")):
        label_node = container.find(class_=re.compile("field__label"))
        if label_node and label_pattern.search(label_node.get_text(" ", strip=True)):
            item_node = container.find(class_=re.compile("field__item"))
            if item_node:
                value = item_node.get_text(" ", strip=True)
                if value:
                    return value

    # Fallback: search for label text and extract neighbour
    for node in soup.find_all(string=label_pattern):
        value = _collect_associated_text(node)
        if value:
            return value
    return None


def _collect_associated_text(node: NavigableString) -> Optional[str]:
    # Try direct siblings first
    for sibling in node.next_siblings:
        if isinstance(sibling, NavigableString):
            text = sibling.strip(" :\n\t")
            if text:
                return text
        elif isinstance(sibling, Tag):
            text = sibling.get_text(" ", strip=True)
            if text:
                return text

    parent = node.parent
    if not parent:
        return None

    for sibling in parent.next_siblings:
        if isinstance(sibling, NavigableString):
            text = sibling.strip(" :\n\t")
            if text:
                return text
        elif isinstance(sibling, Tag):
            text = sibling.get_text(" ", strip=True)
            if text:
                return text

    grandparent = parent.parent
    if isinstance(grandparent, Tag):
        for child in grandparent.find_all(True, recursive=False):
            if child is parent:
                continue
            text = child.get_text(" ", strip=True)
            if text and text != node:
                return text
    return None


def _parse_period_range(raw: str) -> tuple[datetime.date, datetime.date]:
    text = raw.strip()
    if not text:
        raise ValueError("Tanggal Berlaku kosong")

    normalized = text
    for short, full in MONTH_FALLBACK.items():
        normalized = re.sub(rf"\b{short}\b", full, normalized, flags=re.IGNORECASE)

    parts = [part.strip(" ,:;" ) for part in DATE_CONNECTORS.split(normalized) if part.strip()]

    if len(parts) == 1:
        raise ValueError(f"Rentang tanggal tidak lengkap: {raw}")
    if len(parts) > 2:
        parts = [parts[0], parts[-1]]

    start_raw, end_raw = parts
    end_date = _parse_indonesian_date(end_raw)

    # When start lacks month/year, borrow from end date
    if re.fullmatch(r"\d{1,2}", start_raw):
        start_raw = f"{start_raw} {end_date.strftime('%B %Y')}"
    elif re.fullmatch(r"\d{1,2}\s+[A-Za-z]+", start_raw):
        start_raw = f"{start_raw} {end_date.year}"

    start_date = _parse_indonesian_date(start_raw)
    if start_date > end_date:
        # Handle year rollover (e.g. Dec-Jan)
        start_date = start_date.replace(year=start_date.year - 1)
    return start_date, end_date


def _parse_indonesian_date(text: str) -> datetime.date:
    clean = text.strip()
    clean = re.sub(r"\s+", " ", clean)
    parsed = dateparser.parse(
        clean,
        languages=["id", "en"],
        settings={"DATE_ORDER": "DMY", "STRICT_PARSING": True},
    )
    if parsed is None:
        raise ValueError(f"Tidak dapat mengurai tanggal dari '{text}'")
    return parsed.date()


def _find_kmk_number(soup: BeautifulSoup) -> Optional[str]:
    text = soup.get_text(" ", strip=True)
    kmk_pattern = re.compile(
        r"((?:KEP|KMK)[^0-9A-Z]{0,2}[0-9]{1,4}[A-Z0-9/.-]*)",
        re.IGNORECASE,
    )
    match = kmk_pattern.search(text)
    if match:
        return match.group(1).upper()
    return None


def _find_kmk_url(soup: BeautifulSoup, base_url: str) -> str:
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if href.lower().endswith(".pdf"):
            return urljoin(base_url + "/", href)
    raise ValueError("Tidak menemukan tautan PDF KMK")


def _parse_rates_from_table(table: Tag, source_url: str) -> List[FxRate]:
    """Parse rates from a specific table element (new website format)."""
    rates: List[FxRate] = []

    # Find tbody or use table directly
    tbody = table.find("tbody") or table

    for row in tbody.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue

        # Extract ISO code from the currency name cell (usually 2nd cell, index 1)
        currency_cell = cells[1] if len(cells) > 1 else cells[0]
        currency_text = currency_cell.get_text(" ", strip=True)

        iso_code = _extract_iso_code([currency_text])
        if not iso_code:
            continue

        # Extract value from the value cell (usually 3rd cell, index 2)
        value_cell = cells[2] if len(cells) > 2 else cells[-1]
        # The value might be in a div within the cell
        value_div = value_cell.find("div")
        value_text = value_div.get_text(strip=True) if value_div else value_cell.get_text(strip=True)

        if not value_text or not NUMBER_PATTERN.search(value_text):
            continue

        try:
            value_idr = parse_idr_amount(value_text)
            unit = extract_unit(currency_text, 1)

            rate = FxRate(
                iso_code=iso_code,
                unit=unit,
                value_idr=value_idr,
                source=source_url,
            )
            rates.append(rate)
        except (ValueError, TypeError) as e:
            logger.warning("parse_rate_failed", text=value_text, error=str(e))
            continue

    return rates


def _parse_rates(soup: BeautifulSoup, source_url: str) -> List[FxRate]:
    tables = soup.find_all("table")
    rates: list[FxRate] = []

    for table in tables:
        headers = [cell.get_text(" ", strip=True).lower() for cell in table.find_all("th")]
        if headers and not any("kurs" in header or "nilai" in header for header in headers):
            continue

        for row in table.find_all("tr"):
            cells = [cell.get_text(" ", strip=True) for cell in row.find_all(["td", "th"])]
            if len(cells) < 2:
                continue
            if row.find("th"):
                continue

            iso_code = _extract_iso_code(cells)
            if not iso_code:
                continue

            value_text = _extract_value_text(cells)
            if not value_text:
                continue
            try:
                value = parse_idr_amount(value_text)
            except ValueError:
                logger.warning("value_parse_failed", iso=iso_code, value=value_text)
                continue

            unit = extract_unit(" ".join(cells), default=1)
            if iso_code.upper() == "JPY" and unit == 1:
                unit = 100

            rates.append(
                FxRate(
                    iso_code=iso_code.upper(),
                    unit=unit,
                    value_idr=value,
                    source=source_url,
                )
            )

        if rates:
            break

    return rates


def _extract_iso_code(cells: List[str]) -> Optional[str]:
    for cell in cells:
        match = ISO_PATTERN.search(cell.upper())
        if match:
            candidate = match.group(1)
            if candidate not in {"SD", "S/D", "DGN"}:
                return candidate
    return None


def _extract_value_text(cells: List[str]) -> Optional[str]:
    for cell in reversed(cells):
        text = cell.strip()
        if not text:
            continue
        if "%" in text:
            continue
        if not NUMBER_PATTERN.search(text):
            continue
        if "," in text or "." in text:
            return text
    return None


def _extract_published_at(soup: BeautifulSoup, week_start: date) -> Optional[datetime]:
    text = soup.get_text(" ", strip=True)
    pattern = re.compile(r"(\d{1,2}\s+[A-Za-z]+\s+\d{4})")
    candidates = pattern.findall(text)

    for candidate in candidates:
        try:
            parsed = _parse_indonesian_date(candidate)
        except ValueError:
            continue
        if parsed <= week_start:
            return datetime.combine(parsed, datetime.min.time())
    return None
