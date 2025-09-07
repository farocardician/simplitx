#!/usr/bin/env python3
# Stage 6 — Line-Item Extraction from Camelot Cells
# Inputs :
#   --cells  /path/to/2508070002-cells.json
# Output :
#   --out    /path/to/2508070002-items.json
#
# Deterministic, geometry-first. Uses only Camelot cell grid for row/col,
# pulls text already filled from normalized tokens in Stage 3b.

from __future__ import annotations
import argparse, json, re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, List, Optional

UOM_DEFAULT = "PCS"  # from header "11)QTY. (PCS)"

def _canon(s: str) -> str:
    return "".join(ch for ch in s.upper() if ch.isalnum())

def _parse_num(s: str) -> Optional[Decimal]:
    s = (s or "").strip()
    if not s:
        return None
    neg = s.startswith("(") and s.endswith(")")
    core = s.strip("()").replace(",", "")
    try:
        v = Decimal(core)
        return -v if neg else v
    except InvalidOperation:
        return None

def _as_int(s: str) -> Optional[int]:
    s = (s or "").strip()
    if not s.isdigit():
        return None
    try:
        return int(s)
    except ValueError:
        return None

def _fix_desc(s: str) -> str:
    # tidy common line-wrap artifacts seen in the PDF
    s = re.sub(r"\bD engan\b", "Dengan", s)
    s = re.sub(r"\bPi ntar\b", "Pintar", s)
    s = re.sub(r"\bTr ack\b", "Track", s)
    s = " ".join(s.split())  # normalize whitespace first
    s = re.sub(r"-\s+", "-", s)  # then fix dash followed by space(s) -> dash only
    return s.strip()

def _row_to_item(cells: List[str]) -> Optional[Dict[str, Any]]:
    """
    cells: [NO, HS, SKU, CODE, DESC, QTY, UNIT_PRICE, AMOUNT]
    Returns item dict or None if row is not an item.
    """
    if len(cells) < 8:
        return None
    no = _as_int(cells[0])
    if no is None:
        return None  # not a line item row

    hs = cells[1].strip() or None
    sku = cells[2].strip() or None
    code = cells[3].strip() or None
    desc = _fix_desc(cells[4])

    qty = _parse_num(cells[5])
    qty_i = int(qty) if qty is not None and qty == qty.to_integral() else None

    unit_price = _parse_num(cells[6])
    amount = _parse_num(cells[7])

    return {
        "no": no,
        "hs_code": hs if hs and hs.isdigit() else hs,  # keep as-is
        "sku": sku,
        "code": code if code else None,
        "description": desc if desc else None,
        "qty": qty_i,
        "uom": UOM_DEFAULT,
        "unit_price": float(unit_price) if unit_price is not None else None,
        "amount": float(amount) if amount is not None else None,
    }

def extract_from_cells(cells_path: Path) -> Dict[str, Any]:
    data = json.loads(cells_path.read_text(encoding="utf-8"))
    items: List[Dict[str, Any]] = []

    for page in data.get("pages", []):
        table = page.get("table") or {}
        if not table:
            continue

        # 1) Some pages (e.g., page 2) have the first item in header_cells.
        header_cells = table.get("header_cells") or []
        if header_cells and len(header_cells) >= 8:
            hvals = [c.get("text_norm", c.get("text", "")) for c in header_cells]
            maybe_item = _row_to_item(hvals)
            if maybe_item:
                items.append(maybe_item)

        # 2) Regular rows
        for r in table.get("rows", []):
            cells = r.get("cells", [])
            texts = [c.get("text_norm", c.get("text", "")) for c in cells]
            maybe_item = _row_to_item(texts)
            if maybe_item:
                items.append(maybe_item)

    # Sort by NO and stabilize by insertion order for ties
    items.sort(key=lambda it: it.get("no", 0))

    return {
        "doc_id": data.get("doc_id"),
        "items": items,
        "stage": "line_items_cells",
        "version": "1.0",
        "notes": "Parsed from Camelot grid; header row used as item when numeric; UOM defaulted to PCS."
    }

def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 4b — Line-Item Extraction from Camelot Cells")
    ap.add_argument("--cells", required=True, help="Path to Stage 3b cells JSON")
    ap.add_argument("--out", required=True, help="Path to write items JSON")
    args = ap.parse_args()

    cells_path = Path(args.cells).resolve()
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    out = extract_from_cells(cells_path)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # Print compact summary
    preview = [
        {
            "no": it.get("no"),
            "hs": it.get("hs_code"),
            "sku": it.get("sku"),
            "code": it.get("code"),
            "desc": (it.get("description") or "")[:80],
            "qty": it.get("qty"),
            "uom": it.get("uom"),
            "unit_price": it.get("unit_price"),
            "amount": it.get("amount"),
        }
        for it in out["items"][:3]
    ]
    print(json.dumps({
        "stage": out["stage"],
        "doc_id": out["doc_id"],
        "count": len(out["items"]),
        "first_n": preview,
        "out": str(out_path)
    }, ensure_ascii=False, separators=(",", ":")))

if __name__ == "__main__":
    main()