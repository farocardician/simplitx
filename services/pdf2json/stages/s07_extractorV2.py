#!/usr/bin/env python3
# Stage 7 — Field Extraction (STRICT, 100% config-driven)
# Inputs :
#   --cells  /path/to/04-cells.json
#   --items  /path/to/06-items.json
#   --config /path/to/layout.json  (REQUIRED; must include stage7 section)
# Output :
#   --out    /path/to/07-fields.json
from __future__ import annotations

import argparse, json, re, sys
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional

# ---------------- helpers ----------------
def _txt(cell_or_row: Dict[str,Any]) -> str:
    return (cell_or_row.get("text_norm") or cell_or_row.get("text") or "").strip()

def _row_texts(row: Dict[str,Any]) -> List[str]:
    return [_txt(c) for c in row.get("cells", [])]

def _canon(s: str) -> str:
    return "".join(ch for ch in (s or "").upper() if ch.isalnum())

def _clean(s: str) -> str:
    return " ".join((s or "").replace("\\xa0", " ").split()).strip()

def _load_json(p: Path) -> Dict[str,Any]:
    return json.loads(p.read_text(encoding="utf-8"))

# ---------------- config ----------------
def _load_config(cfg_path: Path) -> Dict[str,Any]:
    try:
        cfg = _load_json(cfg_path)
    except Exception as e:
        print(f"[ERROR] Failed to read config: {e}", file=sys.stderr); sys.exit(2)

    st7 = cfg.get("stage7")
    if not isinstance(st7, dict):
        print("[ERROR] Config must include a 'stage7' object for Stage 7 extraction.", file=sys.stderr)
        sys.exit(2)

    # Validate minimal keys (keep it lean; everything else optional)
    req_keys = ["invoice_no_patterns", "date_patterns"]
    missing = [k for k in req_keys if k not in st7]
    if missing:
        print(f"[ERROR] stage7 is missing required keys: {', '.join(missing)}", file=sys.stderr)
        sys.exit(2)

    # Defaults
    st7.setdefault("header_rows_to_scan", 40)
    st7.setdefault("currency_order", [])
    st7.setdefault("seller_from_header_cols", [])
    st7.setdefault("po_patterns", [])
    st7.setdefault("customer_code_patterns", [])
    # buyer_block defaults
    if "buyer_block" in st7:
        bb = st7["buyer_block"]
        bb.setdefault("start_label_contains", [])
        bb.setdefault("stop_when_contains", [])
        bb.setdefault("max_lines", 10)
    # payment terms defaults  
    if "payment_terms" in st7:
        pt = st7["payment_terms"]
        pt.setdefault("label_contains", [])
        pt.setdefault("include_next_n_rows", 0)
    # totals scan defaults
    st7.setdefault("totals_scan", {"enabled": False})

    cfg["stage7"] = st7
    return cfg

# ---------------- extraction pieces ----------------
def _scan_rows(rows: List[Dict[str,Any]], limit: int) -> List[str]:
    out = []
    for r in rows[:max(0, limit)]:
        parts = [t for t in _row_texts(r) if t]
        if parts:
            out.append(" ".join(parts))
    return out

def _find_by_patterns(texts: List[str], patterns: List[str]) -> Optional[str]:
    for pat in patterns or []:
        try:
            rx = re.compile(pat, flags=re.IGNORECASE)
        except re.error:
            continue
        for line in texts:
            m = rx.search(line)
            if m:
                return (m.group(1) if m.groups() else m.group(0)).strip()
    return None

def _find_currency(texts: List[str], currency_order: List[str], currency_hints: List[str]) -> Optional[str]:
    # prefer explicit order; else any hint that appears
    up = "\n".join(texts).upper()
    for c in (currency_order or []):
        if c and c.upper() in up:
            return c.upper()
    for h in (currency_hints or []):
        if h and h.upper() in up:
            return h.upper()
    return None

def _seller_from_header(header_cells: List[Dict[str,Any]], cols: List[int]) -> Optional[str]:
    if not header_cells or not cols:
        return None
    bits = []
    for hc in header_cells:
        if int(hc.get("col", -1)) in cols:
            t = _txt(hc)
            if t: bits.append(t)
    return " ".join(bits).strip() if bits else None

def _extract_buyer(rows: List[Dict[str,Any]], bb_cfg: Dict[str,Any]) -> List[str]:
    start_labels = [s.upper() for s in (bb_cfg.get("start_label_contains") or [])]
    stop_tokens = [s.upper() for s in (bb_cfg.get("stop_when_contains") or [])]
    max_lines = int(bb_cfg.get("max_lines", 10))

    begin = None
    for i, r in enumerate(rows):
        if any(lbl in " ".join(_row_texts(r)).upper() for lbl in start_labels if lbl):
            begin = i
            break
    if begin is None:
        return []

    lines: List[str] = []
    for j in range(begin+1, min(len(rows), begin+1+max_lines)):
        joined = " ".join([t for t in _row_texts(rows[j]) if t])
        if not joined:
            continue
        if any(tok in joined.upper() for tok in stop_tokens if tok):
            break
        # drop the first cell if it's a label-like (e.g., "2)BUYER")
        cells = _row_texts(rows[j])
        if cells and re.match(r"^[0-9]+\)", cells[0]):
            cells = cells[1:]
        line = " ".join([t for t in cells if t]).strip()
        if line:
            lines.append(line)
    return lines

def _scan_totals(rows: List[Dict[str,Any]], totals_cfg: Dict[str,Any]) -> Dict[str,Any]:
    """Scan last rows of table for totals patterns and extract values"""
    if not totals_cfg.get("enabled"):
        return {}
    
    patterns = totals_cfg.get("patterns", {})
    totals = {}
    
    # Scan last 10 rows for totals
    for row in rows[-10:]:
        row_text = " ".join(_row_texts(row)).upper()
        cells = row.get("cells", [])
        
        # Look for tax base (DPP)
        if any(pattern.upper() in row_text for pattern in patterns.get("tax_base", [])):
            if len(cells) >= 7:  # COL7 is AMOUNT column
                amount_text = _txt(cells[6])  # COL7 (0-indexed)
                amount = _extract_number_from_text(amount_text)
                if amount is not None:
                    totals["tax_base"] = amount
        
        # Look for tax amount (PPN/VAT)
        if any(pattern.upper() in row_text for pattern in patterns.get("tax_amount", [])):
            if len(cells) >= 7:
                amount_text = _txt(cells[6])  # COL7 (0-indexed)
                amount = _extract_number_from_text(amount_text)
                if amount is not None:
                    totals["tax_amount"] = amount
                    # Extract tax rate from text (e.g., "VAT 12%" -> 12)
                    rate_match = re.search(r'(\d+)%', row_text)
                    if rate_match:
                        totals["tax_rate"] = float(rate_match.group(1))
        
        # Look for grand total
        if any(pattern.upper() in row_text for pattern in patterns.get("grand_total", [])):
            if len(cells) >= 7:
                amount_text = _txt(cells[6])  # COL7 (0-indexed)
                amount = _extract_number_from_text(amount_text)
                if amount is not None:
                    totals["grand_total"] = amount
        
        # Set tax label
        if any(pattern.upper() in row_text for pattern in patterns.get("tax_label", [])):
            for pattern in patterns.get("tax_label", []):
                if pattern.upper() in row_text:
                    totals["tax_label"] = pattern
                    break
    
    return totals

def _extract_number_from_text(text: str) -> Optional[float]:
    """Extract numeric value from text, handling Indonesian formatting"""
    if not text:
        return None
    
    # Remove currency symbols and clean up
    clean_text = re.sub(r'[A-Z]{2,3}\s*', '', text)  # Remove currency codes
    clean_text = re.sub(r'[^\d\.,\-]', '', clean_text)  # Keep only digits, comma, dot, minus
    
    if not clean_text:
        return None
    
    try:
        # Handle Indonesian formatting (comma as thousands separator, dot as decimal)
        if ',' in clean_text and '.' in clean_text:
            # Both comma and dot present, assume comma is thousands separator
            clean_text = clean_text.replace(',', '')
        elif ',' in clean_text and clean_text.count(',') == 1:
            # Single comma, check if it's decimal separator
            parts = clean_text.split(',')
            if len(parts[1]) <= 2:  # Likely decimal separator
                clean_text = clean_text.replace(',', '.')
            else:  # Likely thousands separator
                clean_text = clean_text.replace(',', '')
        
        return float(clean_text)
    except ValueError:
        return None

# ---------------- main extraction ----------------
def extract_fields(cells_path: Path, items_path: Path, cfg_path: Path) -> Dict[str,Any]:
    cfg = _load_config(cfg_path)
    st7 = cfg["stage7"]

    cdata = _load_json(cells_path)
    idata = _load_json(items_path)
    pages = cdata.get("pages", [])
    first_tbl = (pages[0] or {}).get("table", {}) if pages else {}

    rows = first_tbl.get("rows", [])
    header_cells = first_tbl.get("header_cells", [])
    header_scan = _scan_rows(rows, st7.get("header_rows_to_scan", 40))

    # invoice_no / date / po / customer_code / payment_terms
    invoice_no  = _find_by_patterns(header_scan, st7.get("invoice_no_patterns") or [])
    invoice_date = _find_by_patterns(header_scan, st7.get("date_patterns") or [])
    po_ref       = _find_by_patterns(header_scan, st7.get("po_patterns") or [])
    cust_code    = _find_by_patterns(header_scan, st7.get("customer_code_patterns") or [])

    # payment terms: first line with label, plus next N rows joined
    pterms = None
    labels = [s for s in (st7.get("payment_terms", {}).get("label_contains") or []) if s]
    if labels:
        idx = None
        for i, line in enumerate(header_scan):
            LU = line.upper()
            if any(l.upper() in LU for l in labels):
                idx = i; break
        if idx is not None:
            take = [header_scan[idx]]
            more = int(st7.get("payment_terms", {}).get("include_next_n_rows", 0))
            for k in range(1, more+1):
                if idx + k < len(header_scan):
                    take.append(header_scan[idx+k])
            pterms = " ".join(take).strip()

    # seller name from config-specified header columns (optional)
    seller_name = _seller_from_header(header_cells, st7.get("seller_from_header_cols") or [])

    # currency: scan header area with preferences
    currency = _find_currency(header_scan, st7.get("currency_order") or [], cfg.get("currency_hints") or [])

    # subtotal from items
    items = idata.get("items", [])
    subtotal = Decimal("0")
    for it in items:
        amt = it.get("amount")
        if isinstance(amt, (int, float)):
            subtotal += Decimal(str(amt))

    # scan for totals in table rows if enabled
    scanned_totals = _scan_totals(rows, st7.get("totals_scan", {}))

    # buyer lines via configured block (only if buyer_block exists)
    buyer_lines = []
    if "buyer_block" in st7:
        buyer_lines = _extract_buyer(rows, st7.get("buyer_block") or {})

    buyer_name = buyer_lines[0] if buyer_lines else None
    buyer_address = " ".join(buyer_lines[1:]).strip() if len(buyer_lines) > 1 else None

    header = {
        "invoice_no": invoice_no,
        "invoice_date": invoice_date,
        "seller_name": seller_name,
        "buyer_name": buyer_name,
        "buyer_address": buyer_address,
        "po_reference": po_ref,
        "buyer_id": cust_code,
        "payment_terms": pterms,
        "currency": currency
    }

    totals = {
        "subtotal": float(subtotal),
        "tax_rate": scanned_totals.get("tax_rate"),
        "tax_amount": scanned_totals.get("tax_amount"),
        "tax_base": scanned_totals.get("tax_base"),
        "tax_label": scanned_totals.get("tax_label"),
        "grand_total": scanned_totals.get("grand_total")
    }

    out = {
        "doc_id": cdata.get("doc_id"),
        "stage": "fields",
        "version": "2.0-config",
        "header": header,
        "buyer_id": cust_code,
        "totals": totals,
        "items_ref": {"path": str(items_path)},
        "summary": {"item_count": len(items), "currency": currency},
        "validations": {
            "notes": [k for k,v in header.items() if v in (None, "", [])]
        }
    }
    return out

def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 7 — Field Extraction (STRICT, config-driven)")
    ap.add_argument("--cells", required=True)
    ap.add_argument("--items", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--config", required=True, help="Layout config JSON with a 'stage7' section")
    args = ap.parse_args()

    out = extract_fields(Path(args.cells).resolve(), Path(args.items).resolve(), Path(args.config).resolve())
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

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
