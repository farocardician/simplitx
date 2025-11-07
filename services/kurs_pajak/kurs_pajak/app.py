"""FastAPI application exposing Kurs Pajak data."""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from decimal import Decimal

from fastapi import Depends, FastAPI, HTTPException, Query, Request

from .logging import get_logger
from .runtime import Runtime, build_runtime

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    runtime = build_runtime()
    app.state.runtime = runtime
    try:
        await runtime.scheduler.start()
        yield
    finally:
        await runtime.scheduler.stop()
        runtime.close()


def get_runtime(request: Request) -> Runtime:
    runtime: Runtime = request.app.state.runtime
    return runtime


def create_app() -> FastAPI:
    api = FastAPI(title="Kurs Pajak Service", version="1.0.0", lifespan=lifespan)

    @api.get("/health")
    def health(runtime: Runtime = Depends(get_runtime)) -> dict:
        return {
            "status": "healthy",
            "timezone": runtime.config.timezone_name,
            "base_url": runtime.config.base_url,
        }

    @api.get("/rate")
    def rate(
        iso: str = Query(..., min_length=3, max_length=3, description="ISO 4217 code"),
        date_str: str = Query(..., alias="date", description="Target date YYYY-MM-DD"),
        runtime: Runtime = Depends(get_runtime),
    ) -> dict:
        try:
            target_date = datetime.fromisoformat(date_str).date()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid date format") from exc

        snapshot = runtime.database.find_rate_for(target_date, iso)
        if not snapshot:
            raise HTTPException(status_code=404, detail="Rate not found")

        per_unit = (snapshot.value_idr / Decimal(snapshot.unit)).quantize(Decimal("0.01"))
        return {
            "iso_code": snapshot.iso_code,
            "unit": snapshot.unit,
            "value_idr": str(snapshot.value_idr),
            "per_unit_idr": str(per_unit),
            "source": snapshot.source,
            "date": target_date.isoformat(),
        }

    @api.get("/period/latest")
    def latest_period(
        date_str: str | None = Query(
            None,
            alias="date",
            description="Optional target date (YYYY-MM-DD) to load containing period",
        ),
        runtime: Runtime = Depends(get_runtime),
    ) -> dict:
        target_date = None
        if date_str:
            try:
                target_date = datetime.fromisoformat(date_str).date()
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="Invalid date format") from exc

        if target_date:
            period = runtime.database.fetch_period_containing(target_date)
        else:
            period = runtime.database.fetch_latest_period()

        if not period:
            raise HTTPException(status_code=404, detail="Period not found")

        return {
            "week_start": period.week_start.isoformat(),
            "week_end": period.week_end.isoformat(),
            "kmk_number": period.kmk_number,
            "kmk_url": period.kmk_url,
            "source_url": period.source_url,
            "published_at": period.published_at.isoformat() if period.published_at else None,
            "rates": [
                {
                    "iso_code": rate.iso_code,
                    "unit": rate.unit,
                    "value_idr": str(rate.value_idr.quantize(Decimal("0.01"))),
                    "per_unit_idr": str((rate.value_idr / Decimal(rate.unit)).quantize(Decimal("0.01"))),
                    "source": rate.source,
                }
                for rate in sorted(period.rates, key=lambda r: r.iso_code)
            ],
        }

    @api.post("/scrape/latest")
    def scrape_latest(
        runtime: Runtime = Depends(get_runtime),
    ) -> dict:
        """Trigger scraping of the latest Kurs Pajak data."""
        try:
            from datetime import date
            today = date.today()
            success = runtime.loader.load_for_date(today)

            if not success:
                return {
                    "success": False,
                    "message": "Data already exists for this period",
                }

            # Fetch the period that was just loaded
            period = runtime.database.fetch_latest_period()
            if not period:
                raise HTTPException(status_code=500, detail="Data scraped but could not retrieve")

            return {
                "success": True,
                "message": "Latest data scraped successfully",
                "week_start": period.week_start.isoformat(),
                "week_end": period.week_end.isoformat(),
                "rates_count": len(period.rates),
            }
        except LookupError as exc:
            # No data found for this date
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            logger.error("scrape_failed", error=str(exc))
            raise HTTPException(status_code=500, detail=f"Scraping failed: {str(exc)}") from exc

    return api


app = create_app()
