"""
CLI wrapper around sql2xml exporter for local/legacy usage.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional

from sql2xml.exporter import (
    ExportResult,
    InvoiceNotFoundError,
    InvoiceValidationError,
    export_invoices_to_xml,
    normalize_invoice_numbers,
)


def _write_output(result: ExportResult, output_path: Optional[str]) -> None:
    if output_path:
        Path(output_path).write_bytes(result.xml_bytes)
        print(f"✓ XML written to {output_path}")
    else:
        sys.stdout.buffer.write(result.xml_bytes)


def run_cli(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Export tax invoices to XML using json2xml mappings")
    parser.add_argument("--invoice-id", action="append", help="Invoice ID (UUID) to export (repeatable or comma-separated)")
    parser.add_argument("--batch-id", help="Batch ID to export (all invoices in batch)")
    parser.add_argument("--mapping", help="Override mapping JSON path")
    parser.add_argument("--pipeline", help="Pipeline config file (default from env/constant)")
    parser.add_argument("--profile", default="default", help="json2xml profile name (default: default)")
    parser.add_argument("--output", help="Output XML file path (default: stdout)")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print XML")

    args = parser.parse_args(argv)
    invoice_ids = normalize_invoice_numbers(args.invoice_id)

    try:
        result = export_invoices_to_xml(
            invoice_ids=invoice_ids,
            batch_id=args.batch_id,
            mapping_override=args.mapping,
            pipeline=args.pipeline,
            profile=args.profile,
            pretty=args.pretty,
        )
        _write_output(result, args.output)
        return 0
    except (InvoiceValidationError, InvoiceNotFoundError, FileNotFoundError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # pragma: no cover - defensive logging
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(run_cli())
