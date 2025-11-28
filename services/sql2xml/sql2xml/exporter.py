from __future__ import annotations

import copy
import os
import sys
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from functools import cmp_to_key
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import psycopg
from psycopg.rows import dict_row

from .pipeline import (
    _service_paths,
    load_converter,
    load_pipeline_config,
    resolve_mapping_path,
    resolve_profile,
)

# Ensure local json2xml package is importable (supports repo and container layouts)
service_root, project_services_dir, repo_root = _service_paths()
json2xml_candidates = [
    project_services_dir / "json2xml",
    service_root / "json2xml",
    repo_root / "services" / "json2xml",
]
for candidate in json2xml_candidates:
    if candidate.exists() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))
        break

from json2xml.mapping import load_mapping


class Sql2XmlError(Exception):
    """Base error for sql2xml operations."""


class InvoiceNotFoundError(Sql2XmlError):
    """Raised when no invoices match the provided filters."""


class InvoiceValidationError(Sql2XmlError):
    """Raised when invoices fail validation (e.g., completeness or buyer mismatch)."""

    def __init__(self, code: str, message: str, invoices: Optional[List[str]] = None):
        super().__init__(message)
        self.code = code
        self.invoices = invoices or []


@dataclass
class ExportResult:
    xml_bytes: bytes
    invoice_numbers: List[str]
    mapping_path: str
    merged: bool
    suggested_filename: str


def _build_conninfo() -> str:
    """Build connection string from environment."""
    database_url = os.getenv("DATABASE_URL")
    if database_url:
        return database_url

    host = os.getenv("PGHOST") or os.getenv("DB_HOST", "localhost")
    port = os.getenv("PGPORT") or os.getenv("DB_PORT", "5432")
    db = os.getenv("PGDATABASE") or os.getenv("DB_NAME", "pdf_jobs")
    user = os.getenv("PGUSER") or os.getenv("DB_USER", "postgres")
    password = os.getenv("PGPASSWORD") or os.getenv("DB_PASSWORD", "postgres")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def get_db_connection():
    """Create a psycopg connection with dict rows."""
    conn = psycopg.connect(_build_conninfo(), row_factory=dict_row)
    conn.autocommit = True
    return conn


def normalize_invoice_numbers(raw: Optional[Sequence[str]]) -> List[str]:
    """Split comma-delimited invoice numbers and trim whitespace."""
    if not raw:
        return []
    numbers: List[str] = []
    for val in raw:
        parts = [p.strip() for p in str(val).split(",") if p.strip()]
        numbers.extend(parts)
    # Preserve ordering but drop exact duplicates
    seen = set()
    deduped: List[str] = []
    for num in numbers:
        if num not in seen:
            deduped.append(num)
            seen.add(num)
    return deduped


def fetch_invoices(
    conn,
    invoice_ids: Optional[Sequence[str]],
    batch_id: Optional[str],
) -> List[Dict[str, Any]]:
    """Fetch tax_invoices filtered by invoice IDs and/or batch_id."""
    where = []
    params: List[Any] = []

    if invoice_ids:
        where.append("id = ANY(%s)")
        params.append(list(invoice_ids))
    if batch_id:
        where.append("batch_id = %s")
        params.append(batch_id)

    if not where:
        raise InvoiceValidationError("INVALID_FILTER", "At least one filter (invoice IDs or batch) is required")

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
            buyer_idtku,
            is_complete,
            missing_fields
        FROM tax_invoices
        WHERE {" AND ".join(where)}
        ORDER BY invoice_number
    """

    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


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

    grouped: Dict[str, List[Dict[str, Any]]] = {}
    with conn.cursor() as cur:
        cur.execute(sql, (ids,))
        for row in cur.fetchall():
            grouped.setdefault(str(row["tax_invoice_id"]), []).append(row)
    return grouped


def decimal_to_number(value: Optional[Decimal]) -> Optional[float]:
    """Convert Decimal to float for JSON serialization and expression evaluation."""
    if value is None:
        return None
    return float(value)


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
                "unit_price": decimal_to_number(item.get("price")),
                "qty": decimal_to_number(item.get("qty")),
                "amount": decimal_to_number(item.get("tax_base")),
                "other_tax_base": decimal_to_number(item.get("other_tax_base")),
                "vat": decimal_to_number(item.get("vat")),
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
                "ref_desc": invoice.get("ref_desc") or invoice.get("invoice_number"),
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
            "invoice_id": str(invoice.get("id")),
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


def chunkify(value: str) -> List[Tuple[str, bool]]:
    """Split string into digit/non-digit chunks for natural sorting."""
    import re

    parts = re.findall(r"\d+|\D+", value)
    if not parts:
        return [(value, False)]
    return [(part, part.isdigit()) for part in parts]


def compare_ref_desc(a_raw: str, b_raw: str) -> int:
    """Natural sort comparator ported from web/lib/xmlMerge."""
    a = (a_raw or "").strip()
    b = (b_raw or "").strip()

    a_chunks = chunkify(a)
    b_chunks = chunkify(b)
    max_len = max(len(a_chunks), len(b_chunks))

    for i in range(max_len):
        a_chunk = a_chunks[i] if i < len(a_chunks) else None
        b_chunk = b_chunks[i] if i < len(b_chunks) else None

        if a_chunk is None and b_chunk is None:
            return 0
        if a_chunk is None:
            return -1
        if b_chunk is None:
            return 1

        if a_chunk[1] and b_chunk[1]:
            a_num = int(a_chunk[0])
            b_num = int(b_chunk[0])
            if a_num != b_num:
                return a_num - b_num
            if len(a_chunk[0]) != len(b_chunk[0]):
                return len(a_chunk[0]) - len(b_chunk[0])
            continue

        if a_chunk[1] != b_chunk[1]:
            return -1 if a_chunk[1] else 1

        if a_chunk[0] != b_chunk[0]:
            return -1 if a_chunk[0].lower() < b_chunk[0].lower() else 1

    return len(a_chunks) - len(b_chunks)


def sort_payloads_by_ref(payloads: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Sort payloads by ref_desc using natural ordering."""
    return sorted(
        payloads,
        key=cmp_to_key(
            lambda a, b: compare_ref_desc(
                a["data"]["invoice"].get("ref_desc") or "",
                b["data"]["invoice"].get("ref_desc") or "",
            )
        ),
    )


def derive_buyer_key(invoice: Dict[str, Any]) -> Optional[str]:
    """Determine buyer identity for merge validation."""
    for key in ("buyer_party_id", "buyer_tin", "buyer_name"):
        value = invoice.get(key)
        if value:
            return str(value).strip().lower()
    return None


def validate_same_buyer(invoices: List[Dict[str, Any]]) -> None:
    """Ensure all invoices belong to the same buyer before merge. Missing buyer info counts as a mismatch."""
    buyers: Dict[str, List[str]] = {}

    for inv in invoices:
        key = derive_buyer_key(inv) or "__missing__"
        buyers.setdefault(key, []).append(inv.get("invoice_number") or "?")

    if len(buyers) > 1:
        details = {k: v for k, v in buyers.items()}
        sample = ", ".join(next(iter(details.values())))
        raise InvoiceValidationError(
            "BUYER_MISMATCH",
            f"Merging requires the same buyer. Found {len(buyers)} buyers (e.g., {sample}).",
            invoices=[inv for vals in buyers.values() for inv in vals],
        )

    if "__missing__" in buyers:
        raise InvoiceValidationError(
            "BUYER_UNKNOWN",
            "Cannot merge invoices because buyer information is missing.",
            invoices=buyers["__missing__"],
        )


def validate_same_seller(invoices: List[Dict[str, Any]]) -> None:
    """Avoid mixing different seller TINs in one XML."""
    tins = {inv.get("tin") for inv in invoices if inv.get("tin")}
    if len(tins) > 1:
        raise InvoiceValidationError("TIN_MISMATCH", f"Multiple seller TINs found in selection: {tins}")


def validate_completeness(invoices: List[Dict[str, Any]]) -> None:
    """Ensure all invoices marked complete before conversion."""
    incomplete = [inv.get("invoice_number") or "?" for inv in invoices if inv.get("is_complete") is not True]
    if incomplete:
        raise InvoiceValidationError(
            "INCOMPLETE_INVOICE",
            f"Cannot generate XML for incomplete invoices: {', '.join(incomplete[:5])}",
            invoices=incomplete,
        )


def build_merged_filename(mapping_path: Path, count: int) -> str:
    """Match queue V1 merged naming convention."""
    safe_mapping = mapping_path.stem
    date_part = datetime.utcnow().strftime("%d%m%y")
    return f"{safe_mapping}_combined_{date_part}_{count}.xml"


def export_invoices_to_xml(
    invoice_ids: Optional[Sequence[str]] = None,
    batch_id: Optional[str] = None,
    *,
    mapping_override: Optional[str] = None,
    pipeline: Optional[str] = None,
    profile: str = "default",
    pretty: bool = False,
    params: Optional[Dict[str, Any]] = None,
) -> ExportResult:
    """
    Export one or many invoices to XML using json2xml mappings.

    - invoice_ids: list of invoice UUIDs to export
    - batch_id: optional batch filter
    - mapping_override: absolute path to mapping JSON (bypass pipeline mapping)
    - pipeline: pipeline config filename (default from env/constant)
    - profile: json2xml profile name inside the pipeline config
    - pretty: pretty-print XML output
    - params: optional override params for converter
    """
    normalized_ids = normalize_invoice_numbers(invoice_ids)

    pipeline_config, pipeline_path = load_pipeline_config(pipeline)
    profile_conf = resolve_profile(pipeline_config, profile)
    mapping_rel = profile_conf["mapping"]
    converter_conf = profile_conf.get("converter", {})
    converter_module = converter_conf.get("module", "json2xml.converter")
    converter_callable = converter_conf.get("callable", "convert_json_to_xml")
    converter = load_converter(converter_module, converter_callable)
    profile_params = profile_conf.get("params") or {}
    combined_params = dict(profile_params)
    if params:
        combined_params.update(params)
    params_payload = combined_params or None

    if mapping_override:
        mapping_path = Path(mapping_override).expanduser().resolve()
        if not mapping_path.exists():
            raise FileNotFoundError(f"Mapping file '{mapping_override}' not found")
    else:
        mapping_path = resolve_mapping_path(mapping_rel, pipeline_path)
    mapping = load_mapping(str(mapping_path))

    with get_db_connection() as conn:
        if not normalized_ids and not batch_id:
            raise InvoiceValidationError("INVALID_FILTER", "Provide invoice IDs or batch_id")

        invoices = fetch_invoices(conn, normalized_ids or None, batch_id)

        if not invoices:
            raise InvoiceNotFoundError("No invoices found for provided filters.")

        validate_completeness(invoices)

        items_by_invoice = fetch_items(conn, (inv["id"] for inv in invoices))

    payloads: List[Dict[str, Any]] = []
    for inv in invoices:
        inv_items = items_by_invoice.get(str(inv["id"]), [])
        payloads.append(build_invoice_payload(inv, inv_items))

    inject_invoice_constants(mapping, invoices[0])

    if len(payloads) == 1:
        xml_bytes = converter(payloads[0], mapping, params=params_payload, pretty=pretty)
        invoice_meta = payloads[0]["data"]
        filename_base = invoice_meta.get("invoice_id") or invoice_meta.get("invoice", {}).get("number") or "invoice"
        filename = f"{filename_base}.xml"
        return ExportResult(
            xml_bytes=xml_bytes,
            invoice_numbers=[payloads[0]["data"]["invoice"].get("number") or ""],
            mapping_path=str(mapping_path),
            merged=False,
            suggested_filename=filename,
        )

    validate_same_seller(invoices)
    validate_same_buyer(invoices)

    bulk_mapping = patch_mapping_for_bulk(mapping)
    sorted_payloads = sort_payloads_by_ref(payloads)
    bulk_payload = {"data": sorted_payloads}

    xml_bytes = converter(bulk_payload, bulk_mapping, params=params_payload, pretty=pretty)
    filename = build_merged_filename(mapping_path, len(payloads))

    return ExportResult(
        xml_bytes=xml_bytes,
        invoice_numbers=[p["data"]["invoice"].get("number") or "" for p in sorted_payloads],
        mapping_path=str(mapping_path),
        merged=True,
        suggested_filename=filename,
    )
