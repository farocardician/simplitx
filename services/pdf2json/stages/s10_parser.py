#!/usr/bin/env python3
# Stage 10 — Final Assembly
# Inputs (explicit, portable):
#   --fields      /path/to/<doc>-fields.json
#   --items       /path/to/<doc>-items.json
#   --validation  /path/to/<doc>-validation.json
#   --confidence  /path/to/<doc>-confidence.json
#   --cells       /path/to/<doc>-cells_normalized.json
# Outputs:
#   --final       /path/to/<doc>-final.json
#   --manifest    /path/to/<doc>-manifest.json
#
# Notes:
# - Deterministic: sorted iteration, stable tie-breakers, 2-dec rounding for money.
# - Token backrefs (via cell geometry): for header + each item field we attach the
#   page index and normalized cell bbox (x0,y0,x1,y1). We match items by NO.
# - Totals: if fields.json is missing tax/grand totals, we fill from validation.template_totals.
# - Schema matches PLAN.md Stage 12 skeleton.  (final.json + manifest)  [PLAN]  # noqa

from __future__ import annotations
import argparse, json, hashlib
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

def money(x: Decimal | float | int | None) -> float | None:
    if x is None: return None
    q = Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return float(q)

def loadj(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8"))

def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(131072), b""):
            h.update(chunk)
    return h.hexdigest()

def is_int_str(s: str) -> bool:
    s = (s or "").strip()
    return s.isdigit()

def cells_iter(cells_doc: Dict[str, Any]):
    """Yield (page_no, header_cells, rows) with normalized text."""
    for page in cells_doc.get("pages", []):
        tbl = page.get("table") or {}
        hdr = tbl.get("header_cells") or []
        rows = tbl.get("rows") or []
        yield int(page.get("page")), hdr, rows

def cell_text(c: Dict[str, Any]) -> str:
    return (c.get("text_norm") or c.get("text") or "").strip()

def row_texts(row: Dict[str, Any]) -> List[str]:
    return [cell_text(c) for c in row.get("cells", [])]

def bbox_of(c: Dict[str, Any]) -> Dict[str, float]:
    b = c.get("bbox") or {}
    return {"x0": b.get("x0", 0.0), "y0": b.get("y0", 0.0), "x1": b.get("x1", 0.0), "y1": b.get("y1", 0.0)}

def map_item_rows_by_no(cells_doc: Dict[str, Any]) -> Dict[int, Dict[str, Any]]:
    """
    Build a mapping: NO -> {"page": int, "cells": [cells...]}.
    We consider both header_cells (some pages start with an item row there) and body rows.
    """
    out: Dict[int, Dict[str, Any]] = {}
    for page_no, hdr, rows in cells_iter(cells_doc):
        # header-as-item (rare but seen on this template for page 2 sometimes)
        if hdr and len(hdr) >= 8 and is_int_str(cell_text(hdr[0])):
            no = int(cell_text(hdr[0]))
            out.setdefault(no, {"page": page_no, "cells": [{"col": hc.get("col"), "text": cell_text(hc), "bbox": bbox_of(hc)} for hc in hdr]})
        # normal rows
        for r in rows:
            cells = r.get("cells", [])
            if len(cells) >= 8:
                t0 = cell_text(cells[0])
                if is_int_str(t0):
                    no = int(t0)
                    out.setdefault(no, {"page": page_no, "cells": [{"col": c.get("col"), "text": cell_text(c), "bbox": bbox_of(c)} for c in cells]})
    return out

def header_backrefs(cells_doc: Dict[str, Any], inv_no: Optional[str], inv_date: Optional[str]) -> Dict[str, Any]:
    """Find the cell bbox for invoice number and date on the first page."""
    refs = {}
    if inv_no is None and inv_date is None:
        return refs
    # scan page 1 only (header lives there)
    for page_no, hdr, rows in cells_iter(cells_doc):
        if page_no != 1: continue
        # search header + first ~25 rows
        search_cells = []
        search_cells.extend(hdr)
        for r in rows[:25]:
            search_cells.extend(r.get("cells", []))
        for c in search_cells:
            t = cell_text(c)
            if inv_no and ("70CH" in inv_no) and (inv_no in t) and "invoice_no" not in refs:
                refs["invoice_no"] = {"page": page_no, "bbox": bbox_of(c)}
            if inv_date and inv_date in t and "invoice_date" not in refs:
                refs["invoice_date"] = {"page": page_no, "bbox": bbox_of(c)}
        break
    return refs

def main():
    ap = argparse.ArgumentParser(description="Stage 12 — Final Assembly")
    ap.add_argument("--fields", required=True)
    ap.add_argument("--items", required=True)
    ap.add_argument("--validation", required=True)
    ap.add_argument("--confidence", required=True)
    ap.add_argument("--cells", required=True)
    ap.add_argument("--final", required=True)
    ap.add_argument("--manifest", required=True)
    args = ap.parse_args()

    fields_p = Path(args.fields).resolve()
    items_p = Path(args.items).resolve()
    validation_p = Path(args.validation).resolve()
    confidence_p = Path(args.confidence).resolve()
    cells_p = Path(args.cells).resolve()
    final_p = Path(args.final).resolve()
    manifest_p = Path(args.manifest).resolve()
    final_p.parent.mkdir(parents=True, exist_ok=True)

    f = loadj(fields_p)
    i = loadj(items_p)
    v = loadj(validation_p)
    c = loadj(confidence_p)
    cells_doc = loadj(cells_p)

    # Header
    hdr = f.get("header", {}) or {}
    invoice_no = hdr.get("invoice_no")
    invoice_date = hdr.get("invoice_date")
    buyer_name = hdr.get("buyer_name")
    seller_name = hdr.get("seller_name")
    currency = hdr.get("currency") or "IDR"

    # Items (already deterministic order in previous stage)
    items = i.get("items", [])
    items_sorted = sorted(enumerate(items), key=lambda kv: (kv[1].get("no", 10**9), kv[0]))

    # Map row geometry backrefs by item NO
    rowmap = map_item_rows_by_no(cells_doc)

    # Build items with per-field backrefs (page + bbox from the matched cell)
    def ref_for(no: int, col: int) -> Optional[Dict[str, Any]]:
        e = rowmap.get(no)
        if not e: return None
        cells = e["cells"]
        if col >= len(cells): return None
        return {"page": e["page"], "bbox": cells[col]["bbox"]}

    items_out: List[Dict[str, Any]] = []
    for _, it in items_sorted:
        no = it.get("no")
        entry = {
            "no": it.get("no"),
            "hs_code": it.get("hs_code"),
            "sku": it.get("sku"),
            "code": it.get("code"),
            "description": it.get("description"),
            "qty": it.get("qty"),
            "uom": it.get("uom"),
            "unit_price": money(it.get("unit_price")),
            "amount": money(it.get("amount")),
            "_refs": {
                "no": ref_for(no, 0),
                "hs_code": ref_for(no, 1),
                "sku": ref_for(no, 2),
                "code": ref_for(no, 3),
                "description": ref_for(no, 4),
                "qty": ref_for(no, 5),
                "unit_price": ref_for(no, 6),
                "amount": ref_for(no, 7),
            }
        }
        items_out.append(entry)

    # Totals
    tot_in = f.get("totals", {}) or {}
    tax_label = "VAT"
    if any(tot_in.get(k) in (None, "") for k in ("tax_rate", "tax_amount", "grand_total")):
        ttpl = v.get("template_totals", {}) or {}
        totals = {
            "subtotal": money(tot_in.get("subtotal")),
            "tax_base": money(ttpl.get("tax_base")),
            "tax_label": tax_label,
            "tax_amount": money(ttpl.get("tax_amount")),
            "grand_total": money(ttpl.get("grand_total")),
        }
    else:
        totals = {
            "subtotal": money(tot_in.get("subtotal")),
            "tax_base": None,
            "tax_label": tax_label,
            "tax_amount": money(tot_in.get("tax_amount")),
            "grand_total": money(tot_in.get("grand_total")),
        }

    # Issues & confidence
    flags = v.get("flags", []) or []
    severe = v.get("severe", []) or []
    issues = list(dict.fromkeys(flags + severe))  # deterministic de-dup
    confidence = {
        "score": c.get("score"),
        "components": c.get("components"),
        "flags": c.get("flags", [])
    }

    # Header backrefs
    hdr_refs = header_backrefs(cells_doc, invoice_no, invoice_date)

    final = {
        "doc_id": f.get("doc_id"),
        "buyer_id": f.get("header", {}).get("buyer_id"),
        "invoice": {"number": invoice_no, "date": invoice_date},
        "seller": {"name": seller_name},
        "buyer": {"name": buyer_name},
        "currency": currency,
        "items": items_out,
        "totals": totals,
        "issues": issues,
        "confidence": confidence,
        "provenance": {
            "header_refs": hdr_refs,
            "files": {
                "fields": str(fields_p),
                "items": str(items_p),
                "validation": str(validation_p),
                "confidence": str(confidence_p),
                "cells": str(cells_p)
            }
        },
        "stage": "final",
        "version": "1.0"
    }

    # Manifest with hashes
    manifest = {
        "doc_id": f.get("doc_id"),
        "outputs": {
            "final": str(final_p),
            "manifest": str(manifest_p)
        },
        "inputs": {
            "fields": {"path": str(fields_p), "sha256": sha256_file(fields_p)},
            "items": {"path": str(items_p), "sha256": sha256_file(items_p)},
            "validation": {"path": str(validation_p), "sha256": sha256_file(validation_p)},
            "confidence": {"path": str(confidence_p), "sha256": sha256_file(confidence_p)},
            "cells": {"path": str(cells_p), "sha256": sha256_file(cells_p)},
        },
        "schema": {
            "money_rounding": "2dp",
            "template": "PT Simon Elektrik-Indonesia (IDR, VAT 12%)"
        },
        "stage": "final",
        "version": "1.0"
    }

    final_p.write_text(json.dumps(final, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    manifest_p.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(json.dumps({
        "stage": "final",
        "doc_id": final["doc_id"],
        "items": len(items_out),
        "subtotal": totals["subtotal"],
        "grand_total": totals["grand_total"],
        "confidence": confidence.get("score"),
        "issues": issues,
        "final": str(final_p),
        "manifest": str(manifest_p)
    }, ensure_ascii=False, separators=(",", ":")))
if __name__ == "__main__":
    main()
