"""CSV export functionality for tax invoices.

CRITICAL: This module is 100% config-driven and generic.
NO hardcoded logic for any specific client (Sensient, Stahl, etc.).
All behavior is driven by the sql2csv.mapping section in the pipeline config.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional

from .exporter import (
    build_invoice_payload,
    fetch_invoices,
    fetch_items,
    get_db_connection,
    validate_completeness,
    validate_same_buyer,
    validate_same_seller,
    InvoiceValidationError,
)
from .pipeline import load_pipeline_config


@dataclass
class CsvExportResult:
    """Result of CSV export operation."""
    csv_bytes: bytes
    invoice_numbers: List[str]
    row_count: int
    suggested_filename: str


def _resolve_csv_value(
    item_data: Dict[str, Any],
    invoice_data: Dict[str, Any],
    buyer_data: Dict[str, Any],
    col_spec: Dict[str, Any],
) -> Any:
    """Extract value from payload based on column specification.

    GENERIC: Works for any field in any source (item, invoice, buyer).
    All behavior driven by col_spec config.

    Args:
        item_data: Line item data from payload["data"]["items"][i]
        invoice_data: Invoice header data from payload["data"]["invoice"]
        buyer_data: Buyer data from payload["data"]["buyer"]
        col_spec: Column specification from config with:
            - source: "item", "invoice", or "buyer"
            - path: Field name to extract
            - type: "string", "decimal", "date", or "expression"
            - expr: Expression to evaluate (for type="expression")

    Returns:
        Extracted value or None if not found
    """
    source = col_spec.get("source", "item")
    path = col_spec.get("path")
    col_type = col_spec.get("type", "string")

    # Select data source based on config
    if source == "invoice":
        data = invoice_data
    elif source == "buyer":
        data = buyer_data
    else:  # "item" or default
        data = item_data

    # Handle expression type (calculated fields)
    if col_type == "expression":
        expr = col_spec.get("expr", "")
        return _evaluate_csv_expression(expr, item_data)

    # Extract value via simple path lookup (generic, no hardcoding)
    if isinstance(data, dict):
        return data.get(path)

    return None


def _evaluate_csv_expression(expr: str, item_data: Dict[str, Any]) -> Optional[float]:
    """Safely evaluate a Python expression for calculated fields.

    GENERIC: Supports any Python expression using item fields.

    Args:
        expr: Python expression string (e.g., "tax_base + vat + stlg")
        item_data: Item context with available variables

    Returns:
        Evaluated numeric result or None if evaluation fails
    """
    if not expr:
        return None

    try:
        # Create safe context with only item fields
        # Convert all values to float for arithmetic
        context = {}
        for key, value in item_data.items():
            if value is None:
                context[key] = 0.0
            elif isinstance(value, (int, float)):
                context[key] = float(value)
            elif isinstance(value, Decimal):
                context[key] = float(value)
            else:
                # For non-numeric types, keep as-is but default to 0 in expressions
                context[key] = 0.0

        # Evaluate expression with restricted globals (no builtins for safety)
        result = eval(expr, {"__builtins__": {}}, context)
        return float(result) if result is not None else None

    except Exception:
        # If expression evaluation fails, return None
        return None


def _format_csv_value(value: Any, col_spec: Dict[str, Any]) -> str:
    """Format value according to column type and scale specification.

    GENERIC: Formats any value based on config-specified type and scale.

    Args:
        value: Raw value to format
        col_spec: Column specification with:
            - type: "string", "decimal", "date"
            - scale: Decimal places (for decimal type)

    Returns:
        Formatted string value for CSV
    """
    if value is None:
        return ""

    col_type = col_spec.get("type", "string")

    if col_type == "decimal":
        # Format numeric values with specified scale
        scale = col_spec.get("scale", 2)
        if isinstance(value, (int, float, Decimal)):
            return f"{float(value):.{scale}f}"
        return str(value)

    elif col_type == "date":
        # Format dates as ISO string (YYYY-MM-DD)
        if isinstance(value, date):
            return value.isoformat()
        return str(value)

    else:  # "string" or default
        return str(value)


def export_invoices_to_csv(
    invoice_ids: Optional[List[str]] = None,
    job_id: Optional[str] = None,
    pipeline: Optional[str] = None,
) -> CsvExportResult:
    """Export tax invoices to CSV using config-driven mapping.

    GENERIC: Works for any client/pipeline with sql2csv config.
    NO hardcoded logic for Sensient or any specific client.

    Args:
        invoice_ids: List of invoice IDs to export
        job_id: Optional job ID filter
        pipeline: Pipeline config name (e.g., "invoice_pt_sensient")

    Returns:
        CsvExportResult with CSV bytes and metadata

    Raises:
        ValueError: If sql2csv.mapping not found in config
        InvoiceValidationError: If invoices fail validation
    """
    # Load pipeline config (GENERIC: works for any pipeline)
    pipeline_config, _ = load_pipeline_config(pipeline)

    # Extract CSV config
    csv_config = pipeline_config.get("sql2csv", {}).get("mapping", {})
    if not csv_config:
        raise ValueError(
            f"No sql2csv.mapping found in pipeline config '{pipeline}'. "
            "Add sql2csv section to config to enable CSV export."
        )

    columns = csv_config.get("columns", [])
    format_opts = csv_config.get("format", {})

    if not columns:
        raise ValueError("sql2csv.mapping.columns is empty. Define columns in config.")

    # Fetch and validate invoices (REUSE from exporter.py - already generic)
    with get_db_connection() as conn:
        invoices = fetch_invoices(conn, invoice_ids, job_id)

        if not invoices:
            raise InvoiceValidationError(
                "NOT_FOUND",
                "No invoices found matching the provided filters"
            )

        # Validate completeness, buyer matching, seller matching
        validate_completeness(invoices)
        validate_same_buyer(invoices)
        validate_same_seller(invoices)

        # Fetch line items for all invoices
        invoice_id_list = [str(inv["id"]) for inv in invoices]
        items_by_invoice = fetch_items(conn, invoice_id_list)

    # Build CSV output
    output = io.StringIO()
    delimiter = format_opts.get("delimiter", ",")
    quoting_mode = format_opts.get("quoting", "minimal")

    # Map quoting mode to csv constants
    quoting = csv.QUOTE_MINIMAL if quoting_mode == "minimal" else csv.QUOTE_ALL

    writer = csv.writer(output, delimiter=delimiter, quoting=quoting)

    # Write header row (GENERIC: from config columns)
    headers = [col["header"] for col in columns]
    writer.writerow(headers)

    # Write data rows (GENERIC: one row per item, driven by config)
    row_count = 0
    invoice_numbers = []

    for invoice in invoices:
        # Build payload using existing generic function
        invoice_id = str(invoice["id"])
        invoice_items = items_by_invoice.get(invoice_id, [])
        payload = build_invoice_payload(invoice, invoice_items)

        # Extract invoice and buyer data for column resolution
        invoice_data = payload["data"]["invoice"]
        buyer_data = payload["data"]["buyer"]
        invoice_numbers.append(invoice_data.get("number", ""))

        # Generate one CSV row per line item
        for item in payload["data"]["items"]:
            row = []

            # Process each column from config
            for col_spec in columns:
                # GENERIC: Extract value based on config source and path
                value = _resolve_csv_value(item, invoice_data, buyer_data, col_spec)

                # GENERIC: Format based on config type and scale
                formatted = _format_csv_value(value, col_spec)

                row.append(formatted)

            writer.writerow(row)
            row_count += 1

    # Convert to bytes with specified encoding
    encoding = format_opts.get("encoding", "utf-8")
    csv_bytes = output.getvalue().encode(encoding)

    # Build filename
    if len(invoices) == 1:
        filename = f"{invoice_numbers[0]}.csv"
    else:
        filename = f"invoices_{len(invoices)}.csv"

    return CsvExportResult(
        csv_bytes=csv_bytes,
        invoice_numbers=invoice_numbers,
        row_count=row_count,
        suggested_filename=filename,
    )
