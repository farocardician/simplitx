#!/usr/bin/env python3
"""
Export tax_invoices + tax_invoice_items to XML using json2xml mappings.

Features:
- Filter by invoice number(s) or batch_id.
- Generates a single XML containing one or many TaxInvoice entries.
- Uses json2xml mappings in services/json2xml/mappings/*.json for output shape.
"""

import argparse
import copy
import json
import os
import sys
from collections import defaultdict
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import psycopg2
from psycopg2.extras import RealDictCursor

# Make json2xml package importable (lives in services/json2xml/json2xml)
REPO_ROOT = Path(__file__).resolve().parents[3]
JSON2XML_DIR = REPO_ROOT / "services" / "json2xml"
if str(JSON2XML_DIR) not in sys.path:
    sys.path.insert(0, str(JSON2XML_DIR))

from json2xml.mapping import load_mapping  # type: ignore
from json2xml.converter import convert_json_to_xml  # type: ignore

DEFAULT_MAPPING = JSON2XML_DIR / "mappings" / "pt_simon_invoice_v1.json"


# Database connection parameters
DB_CONFIG = {
    "host": os.getenv("PGHOST") or os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("PGPORT") or os.getenv("DB_PORT", "5432")),
    "database": os.getenv("PGDATABASE") or os.getenv("DB_NAME", "pdf_jobs"),
    "user": os.getenv("PGUSER") or os.getenv("DB_USER", "postgres"),
    "password": os.getenv("PGPASSWORD") or os.getenv("DB_PASSWORD", "postgres"),
}


def get_db_connection():
    """Create and return a database connection."""
    return psycopg2.connect(**DB_CONFIG)


def fetch_invoices(
    conn,
    invoice_numbers: Optional[Sequence[str]],
    batch_id: Optional[str],
) -> List[Dict[str, Any]]:
    """Fetch tax_invoices filtered by invoice numbers and/or batch_id."""
    where = []
    params: List[Any] = []

    if invoice_numbers:
        where.append("invoice_number = ANY(%s)")
        params.append(list(invoice_numbers))
    if batch_id:
        where.append("batch_id = %s")
        params.append(batch_id)

    if not where:
        raise ValueError("Must supply at least one filter: --invoice or --batch-id")

    sql = f"""
        SELECT
            id,
            batch_id,
            invoice_number,
            buyer_party_id,
            tin,
            tax_invoice_date,
            tax_invoice_opt,
            trx_code,
            add_info,
            custom_doc,
            custom_doc_month_year,
            ref_desc,
            facility_stamp,
            seller_idtku,
            buyer_tin,
            buyer_document,
            buyer_country,
            buyer_document_number,
            buyer_name,
            buyer_address,
            buyer_email,
            buyer_idtku
        FROM tax_invoices
        WHERE {" AND ".join(where)}
        ORDER BY invoice_number
    """

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    return rows


def fetch_items(conn, invoice_ids: Iterable[str]) -> Dict[str, List[Dict[str, Any]]]:
    """Fetch tax_invoice_items grouped by tax_invoice_id."""
    ids = list(invoice_ids)
    if not ids:
        return {}

    sql = """
        SELECT
            tax_invoice_id,
            line_number,
            opt,
            code,
            name,
            unit,
            price,
            qty,
            total_discount,
            tax_base,
            other_tax_base,
            vat_rate,
            vat,
            stlg_rate,
            stlg
        FROM tax_invoice_items
        WHERE tax_invoice_id = ANY(%s)
        ORDER BY tax_invoice_id, line_number
    """

    grouped: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (ids,))
        for row in cur.fetchall():
            grouped[str(row["tax_invoice_id"])].append(row)
    return grouped


def decimal_to_str(value: Optional[Decimal]) -> Optional[str]:
    """Convert Decimal to string while preserving scale."""
    if value is None:
        return None
    return format(value, "f")


def build_invoice_payload(invoice: Dict[str, Any], items: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Transform DB rows into the JSON shape expected by mappings."""
    item_payloads = []
    for item in items:
        hs_code = f"{item.get('opt') or ''}{item.get('code') or ''}"
        item_payloads.append(
            {
                "line_number": item.get("line_number"),
                "hs_code": hs_code,
                "description": item.get("name"),
                "uom": item.get("unit"),
                "unit_price": decimal_to_str(item.get("price")),
                "qty": decimal_to_str(item.get("qty")),
                # Mapping uses "amount" for TaxBase/OtherTaxBase/VAT computations
                "amount": decimal_to_str(item.get("tax_base")),
                "other_tax_base": decimal_to_str(item.get("other_tax_base")),
                "vat": decimal_to_str(item.get("vat")),
            }
        )

    invoice_date = invoice.get("tax_invoice_date")
    if isinstance(invoice_date, date):
        invoice_date = invoice_date.isoformat()

    payload = {
        "data": {
            "invoice": {
                "number": invoice.get("invoice_number"),
                "date": invoice_date,
                "opt": invoice.get("tax_invoice_opt"),
                "trx_code": invoice.get("trx_code"),
                "ref_desc": invoice.get("ref_desc"),
                "add_info": invoice.get("add_info"),
                "custom_doc": invoice.get("custom_doc"),
                "custom_doc_month_year": invoice.get("custom_doc_month_year"),
                "facility_stamp": invoice.get("facility_stamp"),
                "tin": invoice.get("tin"),
                "seller_idtku": invoice.get("seller_idtku"),
            },
            "buyer": {
                "name": invoice.get("buyer_name"),
                "tin": invoice.get("buyer_tin"),
                "document": invoice.get("buyer_document"),
                "country": invoice.get("buyer_country"),
                "document_number": invoice.get("buyer_document_number"),
                "address": invoice.get("buyer_address"),
                "email": invoice.get("buyer_email"),
                "idtku": invoice.get("buyer_idtku"),
            },
            "items": item_payloads,
        }
    }
    return payload


def patch_mapping_for_bulk(mapping: Dict[str, Any]) -> Dict[str, Any]:
    """Adjust mapping to allow multiple TaxInvoice entries in one XML."""
    patched = copy.deepcopy(mapping)
    structure = patched.get("structure")
    if not structure or "ListOfTaxInvoice" not in structure:
        raise ValueError("Mapping missing expected 'ListOfTaxInvoice' structure")

    list_node = structure["ListOfTaxInvoice"]
    if not isinstance(list_node, dict) or "TaxInvoice" not in list_node:
        raise ValueError("Mapping missing 'TaxInvoice' definition under ListOfTaxInvoice")

    structure["ListOfTaxInvoice"] = {
        "_array": "$.data[*]",
        "TaxInvoice": list_node["TaxInvoice"],
    }
    return patched


def inject_invoice_constants(mapping: Dict[str, Any], example_invoice: Dict[str, Any]) -> None:
    """Override static TIN/SellerIDTKU in mapping with database values for correctness."""
    structure = mapping.get("structure")
    if not structure:
        return
    if "TIN" in structure and example_invoice.get("tin"):
        structure["TIN"] = example_invoice["tin"]
    tax_invoice_node = structure.get("ListOfTaxInvoice", {}).get("TaxInvoice") or {}
    if "SellerIDTKU" in tax_invoice_node and example_invoice.get("seller_idtku"):
        tax_invoice_node["SellerIDTKU"] = example_invoice["seller_idtku"]


def normalize_invoice_numbers(raw: Optional[List[str]]) -> List[str]:
    """Split comma-delimited values and strip whitespace."""
    if not raw:
        return []
    numbers: List[str] = []
    for val in raw:
        parts = [p.strip() for p in val.split(",") if p.strip()]
        numbers.extend(parts)
    return numbers


def write_output(xml_bytes: bytes, output_path: Optional[str]) -> None:
    """Write XML to file or stdout."""
    if output_path:
        Path(output_path).write_bytes(xml_bytes)
        print(f"✓ XML written to {output_path}")
    else:
        # stdout for piping
        sys.stdout.buffer.write(xml_bytes)


def main():
    parser = argparse.ArgumentParser(description="Export tax invoices to XML using mapping files")
    parser.add_argument(
        "--invoice",
        action="append",
        help="Invoice number to export (repeatable or comma-separated)",
    )
    parser.add_argument(
        "--batch-id",
        help="Batch ID to export (all invoices in batch)",
    )
    parser.add_argument(
        "--mapping",
        default=str(DEFAULT_MAPPING),
        help="Path to mapping JSON (default: pt_simon_invoice_v1.json)",
    )
    parser.add_argument(
        "--output",
        help="Output XML file path (default: stdout)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print XML",
    )

    args = parser.parse_args()
    invoice_numbers = normalize_invoice_numbers(args.invoice)

    conn = get_db_connection()
    try:
        invoices = fetch_invoices(conn, invoice_numbers, args.batch_id)
        if not invoices:
            print("No invoices found for provided filters.")
            sys.exit(1)

        items_by_invoice = fetch_items(conn, (inv["id"] for inv in invoices))

        payloads: List[Dict[str, Any]] = []
        for inv in invoices:
            inv_items = items_by_invoice.get(str(inv["id"]), [])
            payloads.append(build_invoice_payload(inv, inv_items))

        mapping = load_mapping(args.mapping)
        # Ensure TIN/SellerIDTKU reflect database values
        inject_invoice_constants(mapping, invoices[0])

        if len(payloads) == 1:
            xml_bytes = convert_json_to_xml(payloads[0], mapping, pretty=args.pretty)
        else:
            # Enforce same seller across invoices to avoid mixed-TIN XML
            tins = {inv["tin"] for inv in invoices if inv.get("tin")}
            if len(tins) > 1:
                print(f"Error: Multiple TINs found in selection: {tins}")
                sys.exit(1)

            bulk_mapping = patch_mapping_for_bulk(mapping)
            bulk_payload = {"data": payloads}
            xml_bytes = convert_json_to_xml(bulk_payload, bulk_mapping, pretty=args.pretty)

        write_output(xml_bytes, args.output)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
