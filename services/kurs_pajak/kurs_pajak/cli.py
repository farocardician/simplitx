"""Command-line interface for the Kurs Pajak loader."""

from __future__ import annotations

from contextlib import closing
import json
from dataclasses import asdict
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

import typer

from .logging import get_logger
from .runtime import build_runtime

logger = get_logger(__name__)

app = typer.Typer(add_completion=False, help="Kurs Pajak scraper-loader")


@app.command("load")
def load_command(
    date_value: Optional[str] = typer.Option(
        None,
        "--date",
        help="Load a single week containing the given YYYY-MM-DD date",
    ),
    since_value: Optional[str] = typer.Option(
        None,
        "--since",
        help="Backfill weekly periods since the given YYYY-MM-DD date",
    ),
) -> None:
    if date_value and since_value:
        raise typer.BadParameter("--date and --since cannot be used together")

    runtime = build_runtime()
    with closing(runtime):
        if since_value:
            since = _parse_iso_date(since_value)
            inserted = runtime.loader.backfill_since(since)
            typer.echo(f"Backfill completed, {inserted} period(s) stored")
        else:
            target = _parse_iso_date(date_value) if date_value else datetime.now(runtime.config.timezone).date()
            runtime.loader.load_for_date(target)
            typer.echo(f"Period for week of {target} processed")


@app.command("query")
def query_command(
    iso: str = typer.Option(..., "--iso", help="Three-letter ISO currency code"),
    date_value: str = typer.Option(..., "--date", help="Target date (YYYY-MM-DD)"),
) -> None:
    runtime = build_runtime()
    with closing(runtime):
        target_date = _parse_iso_date(date_value)
        snapshot = runtime.database.find_rate_for(target_date, iso)
        if not snapshot:
            raise typer.Exit(code=1)
        per_unit = (snapshot.value_idr / Decimal(snapshot.unit)).quantize(Decimal("0.01"))
        typer.echo(json.dumps({
            "iso_code": snapshot.iso_code,
            "unit": snapshot.unit,
            "value_idr": str(snapshot.value_idr),
            "per_unit_idr": str(per_unit),
            "source": snapshot.source,
        }, ensure_ascii=False))


@app.command("service")
def service_command(
    host: str = typer.Option("0.0.0.0", "--host", help="Service bind host"),
    port: int = typer.Option(8000, "--port", help="Service port"),
) -> None:
    import uvicorn

    uvicorn.run(
        "kurs_pajak.app:create_app",
        host=host,
        port=port,
        factory=True,
        log_level="info",
    )


def _parse_iso_date(value: Optional[str]) -> date:
    if value is None:
        raise typer.BadParameter("Date value is required")
    try:
        return datetime.fromisoformat(value).date()
    except ValueError as exc:  # pragma: no cover - user input guard
        raise typer.BadParameter("Date must be in YYYY-MM-DD format") from exc


def main():
    app()


if __name__ == "__main__":  # pragma: no cover
    main()
