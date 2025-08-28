#!/usr/bin/env python3
# Stage 3 — Band / Region Segmentation (patched header matcher)
# Inputs :
#   --in  /path/to/2508070002-normalized.json
#   --pdf /path/to/2508070002.pdf   (optional, for Camelot refinement)
# Output:
#   --out /path/to/2508070002-segmentized.json

from __future__ import annotations
import argparse, json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Families we want to detect on the header row
FAMS = ["NO", "HS", "DESC", "QTY", "UOM", "PRICE", "AMOUNT"]

TOTALS_KEYWORDS = [
    "SUBTOTAL", "SUB TOTAL", "TOTAL", "AMOUNT DUE", "VAT", "PPN", "TAX", "GRAND TOTAL"
]

# Tolerances in normalized [0..1]
Y_LINE_TOL = 0.006
X_PAD = 0.004

def _canon_alnum(s: str) -> str:
    return "".join(ch for ch in s.upper() if ch.isalnum())

def _canon_for_header_token(s: str) -> str:
    c = _canon_alnum(s)
    # strip leading digits like "9NO", "10DESCRIPTION"
    i = 0
    while i < len(c) and c[i].isdigit():
        i += 1
    return c[i:]

def _group_rows(tokens: List[Dict[str, Any]], page: int) -> List[List[Dict[str, Any]]]:
    page_tokens = [t for t in tokens if t["page"] == page]
    page_tokens.sort(key=lambda t: (t["bbox"]["y0"], t["bbox"]["x0"]))
    rows: List[List[Dict[str, Any]]] = []
    cur: List[Dict[str, Any]] = []
    last_y: Optional[float] = None
    for tok in page_tokens:
        y = float(tok["bbox"]["y0"])
        if last_y is None or abs(y - last_y) <= Y_LINE_TOL:
            cur.append(tok); last_y = y if last_y is None else min(last_y, y)
        else:
            rows.append(cur); cur = [tok]; last_y = y
    if cur: rows.append(cur)
    for r in rows: r.sort(key=lambda t: t["bbox"]["x0"])
    return rows

def _row_span_xy(row: List[Dict[str, Any]]) -> Tuple[Tuple[float,float], Tuple[float,float]]:
    y0 = min(t["bbox"]["y0"] for t in row); y1 = max(t["bbox"]["y1"] for t in row)
    x0 = min(t["bbox"]["x0"] for t in row); x1 = max(t["bbox"]["x1"] for t in row)
    return (x0, x1), (y0, y1)

def _row_text_canons(row: List[Dict[str, Any]]) -> List[Tuple[int, str, float]]:
    """Return [(idx_in_row, canon_text_no_leading_digits, x0)] left->right."""
    out = []
    for i, t in enumerate(row):
        raw = t.get("norm", t.get("text",""))
        out.append((i, _canon_for_header_token(raw), t["bbox"]["x0"]))
    return out

def _row_contains_any(canons: List[Tuple[int,str,float]], needle: str) -> Optional[Tuple[int,float]]:
    """Find leftmost token whose canon contains needle; return (idx, x0)."""
    hits = [(i, x0) for (i, c, x0) in canons if needle in c]
    if not hits: return None
    return sorted(hits, key=lambda p: p[1])[0]

def _match_header_row(rows: List[List[Dict[str, Any]]]) -> Tuple[Optional[int], Dict[str, Dict[str, float]]]:
    """
    We match using robust, substring-based logic:
      - NO: token contains "NO"
      - HS: token contains "HS" and row also contains "CODE" OR a token contains "HSCODE"
      - DESC: contains "DESCRIPTION" OR "GOODS"
      - QTY: contains "QTY"
      - UOM: contains common UOM hints on header like "(PCS)", "UOM" (optional)
      - PRICE: contains "UNITPRICE" or ("UNIT" and "PRICE") or "PRI" as prefix of PRICE
      - AMOUNT: contains "AMOUNT"
    We record the leftmost x0 for each family present.
    """
    best_idx = None
    best_score = -1
    best_hits: Dict[str, Dict[str, float]] = {}

    for ridx, row in enumerate(rows):
        canons = _row_text_canons(row)
        row_join = "".join(c for (_, c, _) in canons)  # entire row, glued

        fam_hits: Dict[str, Dict[str, float]] = {}

        # NO
        hit = _row_contains_any(canons, "NO")
        if hit: fam_hits["NO"] = {"x0": hit[1]}

        # HS (HS + CODE, or HSCODE)
        hs = _row_contains_any(canons, "HS")
        hscode = _row_contains_any(canons, "HSCODE")
        code = _row_contains_any(canons, "CODE")
        if hscode or (hs and code) or ("HSCODE" in row_join):
            x0s = [x for x in (hs[1] if hs else None, code[1] if code else None, hscode[1] if hscode else None) if x is not None]
            if x0s: fam_hits["HS"] = {"x0": min(x0s)}

        # DESC (DESCRIPTION or GOODS)
        d1 = _row_contains_any(canons, "DESCRIPTION")
        d2 = _row_contains_any(canons, "GOODS")
        if d1 or d2:
            fam_hits["DESC"] = {"x0": min([x for x in (d1[1] if d1 else None, d2[1] if d2 else None) if x is not None])}

        # QTY
        q = _row_contains_any(canons, "QTY")
        if q: fam_hits["QTY"] = {"x0": q[1]}

        # PRICE (UNITPRICE or UNIT+PRICE/PRI)
        up = _row_contains_any(canons, "UNITPRICE")
        unit = _row_contains_any(canons, "UNIT")
        price = _row_contains_any(canons, "PRICE")
        pri = _row_contains_any(canons, "PRI")  # some PDFs cut "PRICE" to "PRI"
        if up or (unit and (price or pri)) or ("UNITPRICE" in row_join):
            xs = [x for x in (up[1] if up else None, unit[1] if unit else None, price[1] if price else None, pri[1] if pri else None) if x is not None]
            if xs: fam_hits["PRICE"] = {"x0": min(xs)}

        # AMOUNT
        amt = _row_contains_any(canons, "AMOUNT")
        if amt: fam_hits["AMOUNT"] = {"x0": amt[1]}

        score = len(fam_hits)
        if score > best_score:
            best_score, best_idx, best_hits = score, ridx, fam_hits

    if best_score >= 3:
        # assign an x1 for sorting later: use small epsilon over x0 to maintain structure
        for v in best_hits.values():
            v["x1"] = v["x0"] + 1e-4
        return best_idx, best_hits
    return None, {}

def _find_totals_row_idx(rows: List[List[Dict[str, Any]]], start_row_idx: int) -> Optional[int]:
    for i in range(start_row_idx + 1, len(rows)):
        words = "".join(_canon_alnum(tok.get("norm", tok.get("text",""))) for tok in rows[i])
        for k in TOTALS_KEYWORDS:
            if _canon_alnum(k) in words:
                return i
    return None

def _derive_columns_from_header(row: List[Dict[str, Any]], fam_hits: Dict[str, Dict[str,float]],
                                table_x0: float, table_x1: float) -> List[Dict[str, Any]]:
    # order families by x0
    ordered = sorted([(name, d["x0"]) for name, d in fam_hits.items()], key=lambda x: x[1])
    centers = [x for (_, x) in ordered]
    if not centers:
        # fallback: use all tokens in row
        centers = [t["bbox"]["x0"] for t in row]
    centers = sorted(set(centers))
    bounds = [table_x0]
    for a, b in zip(centers, centers[1:]): bounds.append((a+b)/2.0)
    bounds.append(table_x1)

    names = [name for (name, _) in ordered]
    cols: List[Dict[str, Any]] = []
    for i in range(len(bounds)-1):
        nm = names[i] if i < len(names) else f"COL{i+1}"
        cols.append({"name": nm, "x0": bounds[i], "x1": bounds[i+1]})
    return cols

def _maybe_camelot_bbox(pdf_path: Optional[Path], page: int) -> Optional[Tuple[float,float,float,float]]:
    if pdf_path is None: return None
    try:
        import camelot  # type: ignore
    except Exception:
        return None
    try:
        tabs = camelot.read_pdf(str(pdf_path), pages=str(page), flavor="stream")
        if not tabs or len(tabs) == 0: return None
        idx = max(range(len(tabs)), key=lambda i: (tabs[i].shape[0] * tabs[i].shape[1], i))
        tb = tabs[idx]
        if hasattr(tb, "_bbox") and tb._bbox and hasattr(tb, "parsing_report"):
            x1,y1,x2,y2 = tb._bbox
            pw = tb.parsing_report.get("page_width"); ph = tb.parsing_report.get("page_height")
            if pw and ph:
                nx0 = float(x1)/float(pw); nx1 = float(x2)/float(pw)
                ny0 = 1.0 - (float(y2)/float(ph)); ny1 = 1.0 - (float(y1)/float(ph))
                return (nx0, ny0, nx1, ny1)
    except Exception:
        return None
    return None

def segment(in_path: Path, out_path: Path, pdf_path: Optional[Path]) -> Dict[str, Any]:
    data = json.loads(in_path.read_text(encoding="utf-8"))
    tokens = data.get("tokens", [])
    page_count = int(data.get("page_count", 0))

    out_pages: List[Dict[str, Any]] = []

    for page in range(1, page_count + 1):
        rows = _group_rows(tokens, page)
        header_row_idx, fam_hits = _match_header_row(rows)

        if header_row_idx is None:
            # fallback: treat everything as content; no table region
            first_y = rows[0][0]["bbox"]["y0"] if rows else 0.08
            out_pages.append({
                "page": page,
                "bands": {"header": {"y0": 0.0, "y1": first_y},
                          "content": {"y0": 0.0, "y1": 1.0},
                          "footer": {"y0": 1.0, "y1": 1.0}},
                "table_regions": [],
                "anchors": {"header_row_idx": None, "totals_row_idx": None},
                "source": {"camelot_used": False, "header_fams": []}
            })
            continue

        header_row = rows[header_row_idx]
        (hx0, hx1), (hy0, hy1) = _row_span_xy(header_row)
        # start from header row extents
        table_x0 = max(0.0, hx0 - X_PAD); table_x1 = min(1.0, hx1 + X_PAD)

        # totals if any (cap table bottom just above totals)
        totals_row_idx = _find_totals_row_idx(rows, header_row_idx)

        if totals_row_idx is not None:
            _, (ty0, ty1) = _row_span_xy(rows[totals_row_idx])
            table_y0, table_y1 = hy0, max(hy1, ty0 - (Y_LINE_TOL * 1.5))
        else:
            # heuristic bottom: last row whose left edge is roughly aligned with header left
            aligned = [r for r in rows[header_row_idx+1:] if abs(_row_span_xy(r)[0][0] - hx0) <= 0.06]
            if aligned:
                _, (ly0, ly1) = _row_span_xy(aligned[-1])
                table_y0, table_y1 = hy0, max(hy1, ly1 + (Y_LINE_TOL * 2))
            else:
                table_y0, table_y1 = hy0, min(1.0, hy1 + 0.25)

        # optional Camelot refinement (intersect)
        camelot_bbox = _maybe_camelot_bbox(pdf_path, page)
        camelot_used = camelot_bbox is not None
        if camelot_used:
            cx0, cy0, cx1, cy1 = camelot_bbox
            table_x0 = max(table_x0, cx0); table_x1 = min(table_x1, cx1)
            table_y0 = max(table_y0, cy0); table_y1 = min(table_y1, cy1)

        # columns
        columns = _derive_columns_from_header(header_row, fam_hits, table_x0, table_x1)

        header_band = {"y0": 0.0, "y1": max(0.0, hy0 - (Y_LINE_TOL * 2))}
        content_band = {"y0": header_band["y1"], "y1": min(1.0, table_y1 + (Y_LINE_TOL * 2))}
        footer_band = {"y0": content_band["y1"], "y1": 1.0}

        out_pages.append({
            "page": page,
            "bands": {"header": header_band, "content": content_band, "footer": footer_band},
            "table_regions": [{
                "bbox": {"x0": table_x0, "y0": table_y0, "x1": table_x1, "y1": table_y1},
                "header_row": {"y0": hy0, "y1": hy1, "token_ids": [t["id"] for t in header_row]},
                "columns": columns,
                "source": "camelot" if camelot_used else "heuristic",
            }],
            "anchors": {"header_row_idx": header_row_idx, "totals_row_idx": totals_row_idx},
            "source": {"camelot_used": camelot_used, "header_fams": sorted(list(fam_hits.keys()))}
        })

    out = {
        "doc_id": data.get("doc_id"),
        "page_count": page_count,
        "pages": out_pages,
        "stage": "segmenter",
        "version": "1.1",
        "notes": "Robust header matching (enumerated labels, substrings); optional Camelot refinement."
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(json.dumps({
        "stage": "segmenter",
        "doc_id": out["doc_id"],
        "page_count": page_count,
        "pages_summarized": [
            {
                "page": p["page"],
                "camelot_used": p["source"]["camelot_used"],
                "header_fams": p["source"]["header_fams"],
                "table_bbox": p["table_regions"][0]["bbox"] if p["table_regions"] else None,
                "columns": [c["name"] for c in (p["table_regions"][0]["columns"] if p["table_regions"] else [])],
            } for p in out_pages
        ],
        "out": str(out_path)
    }, ensure_ascii=False, separators=(",", ":")))
    return out

def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 3 — Band / Region Segmentation (patched)")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--pdf", dest="pdf", required=False)
    args = ap.parse_args()
    in_path = Path(args.inp).resolve()
    out_path = Path(args.out).resolve()
    pdf_path = Path(args.pdf).resolve() if args.pdf else None
    segment(in_path, out_path, pdf_path)

if __name__ == "__main__":
    main()
