#!/usr/bin/env python3
# Stage 4 — Camelot Grid (cells) [patched for missing page dims/_bbox]
from __future__ import annotations
import argparse, json, re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

FAMS = ["NO","HS","DESC","QTY","UOM","PRICE","AMOUNT"]
Y_LINE_TOL = 0.006

def _canon(s: str) -> str:
    return "".join(ch for ch in s.upper() if ch.isalnum())

def _token_text(t: Dict[str,Any]) -> str:
    return t.get("norm") or t.get("text","")

def _tok_center(t: Dict[str,Any]) -> Tuple[float,float]:
    b = t["bbox"]; return ((b["x0"]+b["x1"])/2.0, (b["y0"]+b["y1"])/2.0)

def _inside(cell_bbox: Tuple[float,float,float,float], x: float, y: float) -> bool:
    x0,y0,x1,y1 = cell_bbox
    return (x0-1e-6) <= x <= (x1+1e-6) and (y0-1e-6) <= y <= (y1+1e-6)

def _family_of_header(text: str) -> Optional[str]:
    c = _canon(text)
    if not c: return None
    if "HSCODE" in c or ("HS" in c and "CODE" in c): return "HS"
    if "DESCRIPTION" in c or "GOODS" in c: return "DESC"
    if c.startswith("NO") or c=="NO": return "NO"
    if "QTY" in c or "QUANTITY" in c: return "QTY"
    if "UOM" in c or "UNITOFMEASURE" in c: return "UOM"
    if "UNITPRICE" in c or ("UNIT" in c and ("PRICE" in c or "PRI" in c)): return "PRICE"
    if "AMOUNT" in c or "LINETOTAL" in c or "TOTAL" in c: return "AMOUNT"
    return None

def _join(words: List[str]) -> str:
    import re as _re
    z = " ".join(w for w in words if w).strip()
    z = _re.sub(r"\bD engan\b", "Dengan", z)
    z = " ".join(z.split())
    return z

def build_cells(pdf_path: Path, tokens_path: Path, out_path: Path) -> Dict[str,Any]:
    # Load normalized tokens (with page meta from Stage 1)
    tdata = json.loads(tokens_path.read_text(encoding="utf-8"))
    tokens: List[Dict[str,Any]] = tdata["tokens"]
    doc_id = tdata.get("doc_id")
    page_meta = {int(p["page"]): (float(p["width"]), float(p["height"])) for p in tdata.get("pages", [])}

    by_page_tokens: Dict[int, List[Dict[str,Any]]] = {}
    for t in tokens:
        by_page_tokens.setdefault(int(t["page"]), []).append(t)

    import camelot  # type: ignore

    # Parse all pages (prefer lattice, then stream)
    def safe_read(flavor: str):
        try:
            return camelot.read_pdf(str(pdf_path), pages="1-end", flavor=flavor, line_scale=40 if flavor=="lattice" else 15)
        except Exception:
            return []
    all_tables = safe_read("lattice")
    if not all_tables:
        all_tables = safe_read("stream")

    # Group by page
    by_page_tables: Dict[int, List[Any]] = {}
    for tb in (all_tables or []):
        page_no = int(getattr(tb, "parsing_report", {}).get("page", 1))
        by_page_tables.setdefault(page_no, []).append(tb)

    pages_out: List[Dict[str,Any]] = []

    # Utility: get page dims with robust fallbacks
    def get_page_dims(tb, page_no: int) -> Tuple[float,float]:
        pr = getattr(tb, "parsing_report", {}) or {}
        pw, ph = pr.get("page_width"), pr.get("page_height")
        if not pw or not ph:
            if page_no in page_meta:
                return page_meta[page_no]
            # ultimate fallback: sample a token on this page and read its abs width/height
            pts = by_page_tokens.get(page_no, [])
            if pts:
                ab = pts[0].get("abs_bbox", {})
                w = ab.get("width"); h = ab.get("height")
                if w and h:
                    return float(w), float(h)
        return float(pw), float(ph)

    def get_cell_bbox(tb, r: int, c: int, pw: float, ph: float) -> Tuple[float,float,float,float]:
        cell = tb.cells[r][c]
        # Camelot cell coords are in PDF space (origin bottom-left)
        x0 = float(cell.x1) / pw
        x1 = float(cell.x2) / pw
        y0 = 1.0 - (float(cell.y2) / ph)
        y1 = 1.0 - (float(cell.y1) / ph)
        return (min(x0,x1), min(y0,y1), max(x0,x1), max(y0,y1))

    def row_text(tb, r: int, page_no: int, pw: float, ph: float, page_tokens: List[Dict[str,Any]]) -> List[str]:
        cols = tb.shape[1]
        pieces = []
        for c in range(cols):
            bx = get_cell_bbox(tb, r, c, pw, ph)
            txts = []
            for t in page_tokens:
                cx, cy = _tok_center(t)
                if _inside(bx, cx, cy):
                    txts.append(_token_text(t))
            pieces.append(_join(txts))
        return pieces

    # Choose the best table per page by header coverage
    for page_no in sorted({int(t["page"]) for t in tokens}):
        page_tokens = sorted(by_page_tokens.get(page_no, []), key=lambda t: (t["bbox"]["y0"], t["bbox"]["x0"]))
        tables = by_page_tables.get(page_no, [])

        best = None
        best_score = -1
        best_header_idx = None
        best_dims = (None, None)

        for tb in tables:
            pw, ph = get_page_dims(tb, page_no)
            if not pw or not ph:
                continue  # cannot normalize this table safely
            rows, cols = tb.shape
            local_best = -1
            local_idx = None
            for r in range(min(rows, 12)):  # header usually near top
                parts = row_text(tb, r, page_no, pw, ph, page_tokens)
                fam_hits = set()
                for ptxt in parts:
                    fam = _family_of_header(ptxt)
                    if fam: fam_hits.add(fam)
                if len(fam_hits) > local_best:
                    local_best = len(fam_hits)
                    local_idx = r
            if local_best > best_score:
                best_score = local_best
                best = tb
                best_header_idx = local_idx
                best_dims = (pw, ph)

        if best is None:
            pages_out.append({"page": page_no, "tables": []})
            continue

        tb = best
        pw, ph = best_dims  # guaranteed not None here
        rows, cols = tb.shape
        h_idx = best_header_idx if best_header_idx is not None else 0

        # Table bbox: use tb._bbox if available, else derive from cells
        if hasattr(tb, "_bbox") and tb._bbox and all(tb._bbox):
            x1, y1, x2, y2 = tb._bbox
            tbx0 = float(x1) / pw
            tbx1 = float(x2) / pw
            tby0 = 1.0 - (float(y2) / ph)
            tby1 = 1.0 - (float(y1) / ph)
        else:
            # derive from all cell corners
            xs0, ys0, xs1, ys1 = [], [], [], []
            for r in range(rows):
                for c in range(cols):
                    x0,y0,x1,y1 = get_cell_bbox(tb, r, c, pw, ph)
                    xs0.append(x0); ys0.append(y0); xs1.append(x1); ys1.append(y1)
            tbx0 = min(xs0) if xs0 else 0.0
            tby0 = min(ys0) if ys0 else 0.0
            tbx1 = max(xs1) if xs1 else 1.0
            tby1 = max(ys1) if ys1 else 1.0

        table_bbox = {"x0": tbx0, "y0": tby0, "x1": tbx1, "y1": tby1}

        # Map columns by header families
        header_cells = row_text(tb, h_idx, page_no, pw, ph, page_tokens)
        col_map: List[str] = []
        for c in range(cols):
            fam = _family_of_header(header_cells[c])
            col_map.append(fam or f"COL{c+1}")

        # Stop at totals
        def row_text_list(r: int) -> List[str]:
            return row_text(tb, r, page_no, pw, ph, page_tokens)
        TOTALS_KEYS = {"SUBTOTAL","TOTAL","VAT","PPN","AMOUNTDUE","GRANDTOTAL","BASISPAJAK","DASARPAJAK","DPP"}
        stop_at = rows
        for r in range(h_idx+1, rows):
            joined = _canon(" ".join(row_text_list(r)))
            if joined and any(k in joined for k in TOTALS_KEYS):
                stop_at = r
                break

        grid_rows: List[Dict[str,Any]] = []
        for r in range(h_idx+1, stop_at):
            texts = row_text_list(r)
            cells = []
            for c in range(cols):
                x0,y0,x1,y1 = get_cell_bbox(tb, r, c, pw, ph)
                cells.append({
                    "col": c,
                    "name": col_map[c],
                    "bbox": {"x0":x0,"y0":y0,"x1":x1,"y1":y1},
                    "text": texts[c]
                })
            grid_rows.append({"row": r, "cells": cells})

        pages_out.append({
            "page": page_no,
            "table": {
                "bbox": table_bbox,
                "header_row_index": h_idx,
                "header_cells": [{"col": c, "text": header_cells[c], "name": col_map[c]} for c in range(cols)],
                "rows": grid_rows
            }
        })

    out = {"doc_id": doc_id, "stage": "camelot_grid", "version": "1.1", "pages": pages_out}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({
        "stage": "camelot_grid",
        "doc_id": doc_id,
        "pages": [{"page": p["page"],
                   "rows": len(p.get("table",{}).get("rows",[])),
                   "header_idx": p.get("table",{}).get("header_row_index", None),
                   "cols": len(p.get("table",{}).get("header_cells",[]))}
                  for p in pages_out]
    }, ensure_ascii=False, separators=(",", ":")))
    return out

def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 3b — Camelot Grid (cells)")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--tokens", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    build_cells(Path(args.pdf).resolve(), Path(args.tokens).resolve(), Path(args.out).resolve())

if __name__ == "__main__":
    main()
