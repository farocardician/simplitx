"""HTTP scraper for Kurs Pajak listings and detail pages."""

from __future__ import annotations

import time
import threading
from collections.abc import Iterator
from datetime import date
from typing import Iterable, Optional
from urllib.parse import urljoin

import httpx

from .logging import get_logger
from .models import FxPeriod
from .parser import parse_period_detail, parse_listing_page
from .time_utils import week_window

logger = get_logger(__name__)


class KursPajakScraper:
    """Scrapes the public Kurs Pajak pages for weekly FX periods."""

    def __init__(
        self,
        base_url: str,
        timeout: float,
        retries: int,
        user_agent: str,
        max_pages: int,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        self.max_pages = max_pages
        self._client = httpx.Client(
            timeout=timeout,
            headers={"User-Agent": user_agent},
            follow_redirects=True,
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
        )
        self._lock = threading.Lock()

    def close(self) -> None:
        with self._lock:
            self._client.close()

    def iter_periods(
        self,
        since: Optional[date] = None,
        max_pages: Optional[int] = None,
    ) -> Iterator[FxPeriod]:
        since = since or date.min
        seen_periods: set[tuple[date, date]] = set()
        total_pages = max_pages or self.max_pages

        for page_index in range(total_pages):
            listing_url = self._listing_url(page_index)
            logger.info("fetch_listing", url=listing_url, page=page_index)
            listing_html = self._get(listing_url)
            if listing_html is None:
                logger.warning("listing_fetch_failed", url=listing_url)
                break

            # Parse periods directly from the listing page (new website format)
            try:
                periods = parse_listing_page(listing_html, listing_url)
            except Exception as exc:
                logger.error("parse_listing_error", url=listing_url, error=str(exc))
                break

            if not periods:
                logger.info("empty_listing", url=listing_url)
                break

            # Filter out already-seen periods and those before the cutoff date
            new_periods = []
            for period in periods:
                period_key = (period.week_start, period.week_end)
                if period_key in seen_periods:
                    continue
                seen_periods.add(period_key)

                if period.week_end < since:
                    logger.info(
                        "period_before_since",
                        kmk=period.kmk_number,
                        week_start=str(period.week_start),
                    )
                    continue

                new_periods.append(period)

            if not new_periods:
                logger.info("no_new_periods", url=listing_url, page=page_index)
                # If we have seen periods but none are new, we might be done
                if seen_periods:
                    break
                continue

            for period in new_periods:
                yield period

    def get_period_for_date(self, target_date: date) -> Optional[FxPeriod]:
        start, end = week_window(target_date)
        for period in self.iter_periods(since=None):
            if period.week_start == start and period.week_end == end:
                return period
            if period.week_end < start:
                break
        return None

    def _listing_url(self, page_index: int) -> str:
        if page_index == 0:
            return self.base_url
        delimiter = "&" if "?" in self.base_url else "?"
        return f"{self.base_url}{delimiter}page={page_index}"

    def _get(self, url: str) -> Optional[str]:
        for attempt in range(1, self.retries + 1):
            try:
                with self._lock:
                    response = self._client.get(url)
                response.raise_for_status()
                return response.text
            except httpx.HTTPError as exc:
                logger.warning(
                    "http_retry",
                    url=url,
                    attempt=attempt,
                    retries=self.retries,
                    error=str(exc),
                )
                if attempt == self.retries:
                    return None
                backoff = min(60.0, 2 ** (attempt - 1))
                time.sleep(backoff)
        return None


def _extract_detail_links(html: str, base_url: str) -> Iterable[str]:
    try:
        from bs4 import BeautifulSoup
    except Exception:  # pragma: no cover
        return []

    soup = BeautifulSoup(html, "lxml")
    seen: set[str] = set()
    ordered: list[str] = []

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if not href:
            continue
        if href.lower().endswith(".pdf"):
            continue
        if "kurs-pajak" not in href.lower():
            continue
        full_url = urljoin(base_url + "/", href)
        if full_url in seen:
            continue
        seen.add(full_url)
        ordered.append(full_url)

    return ordered
