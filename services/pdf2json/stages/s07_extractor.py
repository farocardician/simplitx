#!/usr/bin/env python3
# Stage 7 — Field Extraction
# Inputs :
#   --cells  /path/to/2508070002-cells_normalized.json
#   --items  /path/to/2508070002-items.json
# Output :
#   --out    /path/to/2508070002-fields.json
#
# Deterministic parsing:
# - Header values are taken from the first page header rows (invoice no/date, seller, buyer).
# - Buyer address lines collected until the table header ("9)NO.") row.
# - Currency inferred from header labels (IDR).
# - Subtotal = sum(item.amount) from items file.
# - Tax/Grand totals are left None if not visible in the grid (grid stops before totals).
#
# Notes:
# - We cite values directly from normalized cells; items are taken as-is from Stage 4b.

from __future__ import annotations
import argparse, json, re
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

INV_NO_RE = re.compile(r"[A-Z0-9]+-[0-9]{6}-[0-9]{4}")
DATE_RE   = re.compile(r"\b[12]\d{3}-\d{2}-\d{2}\b")  # ISO (already normalized)
CUST_PATTERNS = [
    re.compile(r"cust\.?\s*code[: ]*\s*([A-Za-z0-9\-_\/]+)", re.IGNORECASE),
    re.compile(r"customer\s*code[: ]*\s*([A-Za-z0-9\-_\/]+)", re.IGNORECASE),
    re.compile(r"customer\s*id[: ]*\s*([A-Za-z0-9\-_\/]+)",   re.IGNORECASE),
    re.compile(r"buyer\s*id[: ]*\s*([A-Za-z0-9\-_\/]+)",      re.IGNORECASE),
]

def load_json(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8"))

def _celltxt(c: Dict[str,Any]) -> str:
    # prefer normalized text if present
    return (c.get("text_norm") or c.get("text") or "").strip()

def _row_texts(row: Dict[str,Any]) -> List[str]:
    return [_celltxt(c) for c in row.get("cells", [])]

def _find_invoice_fields(page_tbl: Dict[str,Any]) -> Tuple[Optional[str], Optional[str], Optional[str], List[str], Optional[str], Optional[str], Optional[str]]:
    """
    Returns:
      (invoice_no, invoice_date, seller_name, buyer_lines, po_ref, customer_code, payment_terms)
    """
    invoice_no = None
    invoice_date = None
    seller_name = None
    buyer_lines: List[str] = []
    po_ref = None
    cust_code = None
    payment_terms = None

    rows = page_tbl.get("rows", [])
    header_cells = page_tbl.get("header_cells", [])

    # 1) Seller name (usually in header row 0: columns 1..2) and try to spot customer code in header, too
    if header_cells:
        seller_bits = []
        header_joined = []
        for hc in header_cells:
            t = _celltxt(hc)
            if t:
                header_joined.append(t)
            if hc.get("col") in (1, 2):  # "PT Simon", "Elektrik-Indonesia"
                if t:
                    seller_bits.append(t)
        if seller_bits:
            seller_name = " ".join(seller_bits).strip()
        if cust_code is None and header_joined:
            hj = " ".join(header_joined)
            for pat in CUST_PATTERNS:
                m = pat.search(hj)
                if m:
                    cust_code = m.group(1).strip(" :#").rstrip(",.;")
                    break

    # 2) Walk the header block (first ~30 rows) for invoice no/date, PO reference, cust.code, payment terms
    for r in rows[:30]:
        txts = _row_texts(r)
        joined = " ".join(t for t in txts if t)
        # invoice no
        if invoice_no is None:
            m = INV_NO_RE.search(joined)
            if m:
                invoice_no = m.group(0)
        # invoice date
        if invoice_date is None:
            m = DATE_RE.search(joined)
            if m:
                invoice_date = m.group(0)
        # PO reference (look for a single token like "#104 Rev2" or nearby)
        if po_ref is None and ("PO" in joined.upper() or "REFERENCE" in joined.upper() or joined.startswith("#")):
            # if a cell looks like a code with '#'
            for t in txts:
                if t.startswith("#") and len(t) >= 3:
                    po_ref = t
                    break

        # customer code (robust: try multiple label variants and next-cell fallback)
        if cust_code is None:
            # try regex patterns against the whole row
            for pat in CUST_PATTERNS:
                m = pat.search(joined)
                if m:
                    cust_code = m.group(1).strip(" :#").rstrip(",.;")
                    break
            # fallback: if the label is in one cell and value in the next cell
            if cust_code is None:
                lowered = [t.lower().replace(" ", "") for t in txts]
                for i, t in enumerate(lowered):
                    if t in ("cust.code:", "cust.code", "customercode:", "customercode",
                            "customerid:", "customerid", "buyerid:", "buyerid"):
                        if i + 1 < len(txts):
                            val = txts[i + 1].strip(" :#").rstrip(",.;")
                            if val:
                                cust_code = val
                                break

        # payment terms: capture lines after the "8)PAYMENT TERMS" label
        if "8)PAYMENT" in joined.upper() or "TERMS" in joined.upper():
            # also take the next one or two lines if present
            payment_terms = joined
    # try to extend payment terms from the next couple rows if short
    if payment_terms:
        idxs = [i for i,r in enumerate(rows[:15]) if "PAYMENT" in " ".join(_row_texts(r)).upper()]
        if idxs:
            i0 = idxs[0]
            ext = []
            for k in range(i0+1, min(i0+3, len(rows[:15]))):
                line = " ".join([t for t in _row_texts(rows[k]) if t])
                if line: ext.append(line)
            if ext:
                payment_terms = " ".join([payment_terms] + ext)

    # 3) Buyer block: find row where col0 has "2)BUYER", then collect address/name lines until the table header "9)NO."
    begin = None
    end = None
    for i, r in enumerate(rows):
        txts = _row_texts(r)
        if txts and (txts[0].upper().startswith("2)BUYER")):
            begin = i
            break
    if begin is not None:
        for j in range(begin+1, len(rows)):
            txts = _row_texts(rows[j])
            if any("9)NO" in (t.upper()) for t in txts):
                end = j
                break
        if end is None:
            end = min(begin+6, len(rows))
        # gather non-empty cells (skip labels)
        for r in rows[begin:end]:
            parts = [t for t in _row_texts(r)[1:] if t]  # skip col0 label
            if parts:
                buyer_lines.append(" ".join(parts).strip())

    # Clean buyer_lines
    buyer_lines = [s for s in buyer_lines if s]  # drop empties

    return invoice_no, invoice_date, seller_name, buyer_lines, po_ref, cust_code, (payment_terms.strip() if payment_terms else None)

def _infer_currency_from_headers(page_tbl: Dict[str,Any]) -> Optional[str]:
    # Look in the header row above the item table for "IDR"
    rows = page_tbl.get("rows", [])
    for r in rows[:20]:
        joined = " ".join(_row_texts(r)).upper()
        if "AMOUNT IDR" in joined or "PRICE IDR" in joined or "IDR" in joined:
            return "IDR"
    return None

def extract_fields(cells_path: Path, items_path: Path) -> Dict[str, Any]:
    cdata = load_json(cells_path)
    idata = load_json(items_path)

    pages = cdata.get("pages", [])
    first_tbl = (pages[0] or {}).get("table", {}) if pages else {}

    invoice_no, invoice_date, seller_name, buyer_lines, po_ref, cust_code, payment_terms = _find_invoice_fields(first_tbl)
    currency = _infer_currency_from_headers(first_tbl) or "IDR"

    # Buyer name: first non-empty buyer_lines token that starts with "PT" or capital words
    buyer_name = None
    buyer_address = None
    if buyer_lines:
        # typical: first line is the name, following lines are address
        buyer_name = buyer_lines[0]
        if len(buyer_lines) > 1:
            buyer_address = " ".join(buyer_lines[1:]).strip()

    # Subtotal from items
    items = idata.get("items", [])
    subtotal = Decimal("0")
    missing_amounts = 0
    for it in items:
        amt = it.get("amount")
        if isinstance(amt, (int, float)):
            subtotal += Decimal(str(amt))
        else:
            missing_amounts += 1

    # Assemble fields
    header = {
        "invoice_no": invoice_no,
        "invoice_date": invoice_date,
        "seller_name": seller_name,
        "buyer_name": buyer_name,
        "buyer_address": buyer_address,
        "po_reference": po_ref,
        "buyer_id": cust_code,  # expose as buyer_id for downstream consumers
        "payment_terms": payment_terms,
        "currency": currency
    }

    totals = {
        "subtotal": float(subtotal),
        "tax_rate": None,      # grid stops before totals; can be filled in a later step if needed
        "tax_amount": None,
        "grand_total": None
    }

    validations = {
        "item_count": len(items),
        "missing_item_amounts": missing_amounts,
        "notes": []
    }

    if not invoice_no: validations["notes"].append("invoice_no not found in header grid")
    if not invoice_date: validations["notes"].append("invoice_date not found in header grid")
    if not buyer_name: validations["notes"].append("buyer_name not found")
    if not seller_name: validations["notes"].append("seller_name not found")
    if len(items) == 0: validations["notes"].append("no items parsed")

    out = {
        "doc_id": cdata.get("doc_id"),
        "stage": "fields",
        "version": "1.0",
        "header": header,
        "buyer_id": cust_code,
        "totals": totals,
        "items_ref": {
            "path": str(items_path)
        },
        "summary": {
            "item_count": len(items),
            "currency": currency
        },
        "validations": validations
    }
    return out

def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 9 — Field Extraction")
    ap.add_argument("--cells", required=True, help="Path to cells_normalized.json")
    ap.add_argument("--items", required=True, help="Path to items.json")
    ap.add_argument("--out", required=True, help="Path to write fields.json")
    args = ap.parse_args()

    cells_path = Path(args.cells).resolve()
    items_path = Path(args.items).resolve()
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    out = extract_fields(cells_path, items_path)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # print a compact one-line summary
    print(json.dumps({
        "stage": out["stage"],
        "doc_id": out.get("doc_id"),
        "invoice_no": out.get("header", {}).get("invoice_no"),
        "invoice_date": out.get("header", {}).get("invoice_date"),
        "buyer": out.get("header", {}).get("buyer_name"),
        "buyer_id": out.get("buyer_id"),
        "seller": out.get("header", {}).get("seller_name"),
        "currency": out.get("header", {}).get("currency"),
        "item_count": out.get("summary", {}).get("item_count"),
        "subtotal": out.get("totals", {}).get("subtotal"),
        "out": str(out_path)
    }, ensure_ascii=False, separators=(",", ":")))

if __name__ == "__main__":
    main()
