#!/usr/bin/env python3
# Stage 4 — Camelot Grid (cells) — STRICT config mode
from __future__ import annotations
import argparse, json, sys, unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

def _canon(s: str) -> str:
    # Canonicalize text for case-insensitive matching:
    # - Normalize width/compatibility (NFKC)
    # - casefold() for robust, Unicode-aware case-insensitivity
    # - Keep only letters and digits for matching
    s = unicodedata.normalize("NFKC", s or "")
    s = s.casefold()
    return "".join(ch for ch in s if ch.isalnum())

def _token_text(t: Dict[str,Any]) -> str:
    return t.get("norm") or t.get("text","")

def _tok_center(t: Dict[str,Any]) -> Tuple[float,float]:
    b = t["bbox"]; return ((b["x0"]+b["x1"])/2.0, (b["y0"]+b["y1"])/2.0)

def _inside(cell_bbox: Tuple[float,float,float,float], x: float, y: float) -> bool:
    x0,y0,x1,y1 = cell_bbox
    return (x0-1e-6) <= x <= (x1+1e-6) and (y0-1e-6) <= y <= (y1+1e-6)

def _validate_config(cfg: Dict[str,Any]) -> Dict[str,Any]:
    missing = []
    if "header_aliases" not in cfg or not isinstance(cfg["header_aliases"], dict) or not cfg["header_aliases"]:
        missing.append("header_aliases (non-empty dict)")
    if "totals_keywords" not in cfg or not isinstance(cfg["totals_keywords"], list) or not cfg["totals_keywords"]:
        missing.append("totals_keywords (non-empty list)")
    camelot_cfg = cfg.get("camelot")
    if not isinstance(camelot_cfg, dict):
        missing.append("camelot (dict with flavor_order, line_scale, line_scale_stream)")
    else:
        if not camelot_cfg.get("flavor_order") or not isinstance(camelot_cfg.get("flavor_order"), list):
            missing.append("camelot.flavor_order (list)")
        if "line_scale" not in camelot_cfg:
            missing.append("camelot.line_scale (int)")
        if "line_scale_stream" not in camelot_cfg:
            missing.append("camelot.line_scale_stream (int)")
    if missing:
        raise ValueError("Config missing required fields: " + "; ".join(missing))
    # default flags
    if "stop_after_totals" not in cfg:
        cfg["stop_after_totals"] = True
    return cfg

def _build_family_matcher(header_aliases: Dict[str, List[str]]):
    # Build canonical alias sets per family (Unicode-insensitive, case-insensitive)
    canon_map: Dict[str, List[str]] = {}
    for fam, alist in header_aliases.items():
        fam_label = fam  # preserve label for output
        canon_map[fam_label] = [_canon(a) for a in (alist or [])]

    def _by_alias(text: str) -> Optional[str]:
        c = _canon(text)
        if not c:
            return None
        hit_fam = None
        hit_len = 0
        for fam, patterns in canon_map.items():
            for p in patterns:
                if p and p in c:
                    if len(p) > hit_len:
                        hit_fam, hit_len = fam, len(p)
        return hit_fam
    return _by_alias

def build_cells(pdf_path: Path, tokens_path: Path, out_path: Path, config_path: Path) -> Dict[str,Any]:
    # ----- Load and validate config (STRICT) -----
    try:
        cfg_raw = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[ERROR] Failed to read config: {e}", file=sys.stderr)
        sys.exit(2)

    try:
        cfg = _validate_config(cfg_raw)
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(2)

    header_aliases: Dict[str, List[str]] = cfg["header_aliases"]
    totals_keywords: List[str] = cfg["totals_keywords"]
    camelot_cfg: Dict[str,Any] = cfg["camelot"]
    stop_after_totals: bool = bool(cfg.get("stop_after_totals", True))
    page_stop_keywords: Dict[str, List[str]] = cfg.get("page_stop_keywords", {}) or {}
    page_row_limit: Dict[str, int] = cfg.get("page_row_limit", {}) or {}

    family_of_header = _build_family_matcher(header_aliases)
    TOTALS_KEYS_CANON = { _canon(k) for k in totals_keywords if k }
    PAGE_TOTALS_KEYS_CANON: Dict[int, set[str]] = {}
    for k, v in page_stop_keywords.items():
        try:
            pn = int(k)
        except Exception:
            continue
        PAGE_TOTALS_KEYS_CANON[pn] = { _canon(s) for s in (v or []) if s }

    # ----- Load normalized tokens -----
    tdata = json.loads(tokens_path.read_text(encoding="utf-8"))
    tokens: List[Dict[str,Any]] = tdata["tokens"]
    doc_id = tdata.get("doc_id")
    page_meta = {int(p["page"]): (float(p["width"]), float(p["height"])) for p in tdata.get("pages", [])}

    by_page_tokens: Dict[int, List[Dict[str,Any]]] = {}
    for t in tokens:
        by_page_tokens.setdefault(int(t["page"]), []).append(t)

    import camelot  # type: ignore

    # ----- Read tables with Camelot (per-page flavor fallback) -----
    flavor_order = list(camelot_cfg.get("flavor_order"))
    lattice_ls = camelot_cfg.get("line_scale")
    stream_row_tol = camelot_cfg.get("row_tol_stream")

    def safe_read_page(flavor: str, page: int):
        try:
            if flavor == "lattice":
                return camelot.read_pdf(str(pdf_path), pages=str(page), flavor="lattice", line_scale=lattice_ls)
            else:
                # For stream flavor, Camelot does not accept line_scale; use defaults
                kwargs = {}
                if isinstance(stream_row_tol, (int, float)) and stream_row_tol is not None:
                    kwargs["row_tol"] = stream_row_tol
                return camelot.read_pdf(str(pdf_path), pages=str(page), flavor="stream", **kwargs)
        except Exception:
            return []

    # Build tables per page, trying all flavors and selecting best later
    by_page_tables: Dict[int, List[Tuple[Any, str]]] = {}
    flavor_used: Dict[int, Optional[str]] = {}
    for page_no in sorted(by_page_tokens.keys()):
        any_found = False
        for fl in flavor_order:
            got = safe_read_page(fl, page_no) or []
            if got:
                any_found = True
                for tb in got:
                    by_page_tables.setdefault(page_no, []).append((tb, fl))
        if not any_found:
            by_page_tables.setdefault(page_no, [])

    pages_out: List[Dict[str,Any]] = []

    # Helper fns
    def get_page_dims(tb, page_no: int) -> Tuple[float,float]:
        pr = getattr(tb, "parsing_report", {}) or {}
        pw, ph = pr.get("page_width"), pr.get("page_height")
        if not pw or not ph:
            if page_no in page_meta:
                return page_meta[page_no]
            pts = by_page_tokens.get(page_no, [])
            if pts:
                ab = pts[0].get("abs_bbox", {})
                w = ab.get("width"); h = ab.get("height")
                if w and h:
                    return float(w), float(h)
        return float(pw or 0.0), float(ph or 0.0)

    def get_cell_bbox(tb, r: int, c: int, pw: float, ph: float) -> Tuple[float,float,float,float]:
        cell = tb.cells[r][c]
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
            # compact spacing
            s = " ".join(z for z in (txts or []) if z).strip()
            s = " ".join(s.split())
            pieces.append(s)
        return pieces

    # ----- Choose the best table per page by header coverage -----
    prev_col_map: Optional[List[str]] = None
    prev_header_texts: Optional[List[str]] = None

    for page_no in sorted({int(t["page"]) for t in tokens}):
        page_tokens = sorted(by_page_tokens.get(page_no, []), key=lambda t: (t["bbox"]["y0"], t["bbox"]["x0"]))
        tables = by_page_tables.get(page_no, [])

        best = None
        best_score = (-1, -1)  # (body_count, header_hits)
        best_header_idx = None
        best_dims = (None, None)
        best_flavor = None

        for tb, tb_flavor in tables:
            pw, ph = get_page_dims(tb, page_no)
            if not pw or not ph:
                continue
            rows, cols = tb.shape
            local_best_tuple = (-1, -1)  # (body_count, header_hits)
            local_idx = None
            for r in range(min(rows, 12)):
                parts = row_text(tb, r, page_no, pw, ph, page_tokens)
                fam_hits = set()
                for ptxt in parts:
                    fam = family_of_header(ptxt)
                    if fam: fam_hits.add(fam)
                # Estimate body rows by scanning for totals after header
                # Determine stop_at just like below
                def _row_text_list(rr: int) -> List[str]:
                    return row_text(tb, rr, page_no, pw, ph, page_tokens)
                stop_at_est = rows
                if stop_after_totals:
                    for rr in range(r+1, rows):
                        joined = _canon(" ".join(_row_text_list(rr)))
                        if joined and any(k in joined for k in TOTALS_KEYS_CANON):
                            stop_at_est = rr
                            break
                body_count = max(0, stop_at_est - (r + 1))
                cand_tuple = (body_count, len(fam_hits))
                if cand_tuple > local_best_tuple:
                    local_best_tuple = cand_tuple
                    local_idx = r
            if local_idx is not None and local_best_tuple > best_score:
                best_score = local_best_tuple
                best = tb
                best_header_idx = local_idx
                best_dims = (pw, ph)
                best_flavor = tb_flavor

        if best is None:
            pages_out.append({"page": page_no, "tables": [], "flavor_used": None})
            continue

        tb = best
        pw, ph = best_dims
        rows, cols = tb.shape
        h_idx = best_header_idx if best_header_idx is not None else 0

        # Table bbox
        if hasattr(tb, "_bbox") and tb._bbox and all(tb._bbox):
            x1, y1, x2, y2 = tb._bbox
            tbx0 = float(x1) / pw
            tbx1 = float(x2) / pw
            tby0 = 1.0 - (float(y2) / ph)
            tby1 = 1.0 - (float(y1) / ph)
        else:
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

        # Map columns by header families (strictly via config)
        header_texts = row_text(tb, h_idx, page_no, pw, ph, page_tokens)
        col_map: List[str] = []
        header_hits = 0
        for c in range(cols):
            fam = family_of_header(header_texts[c])
            if fam:
                header_hits += 1
            col_map.append(fam or f"COL{c+1}")

        reuse_prev_header = False
        if header_hits == 0:
            if prev_col_map is None:
                # No usable header detected yet: synthesize canonical labels for downstream stages
                header_texts = [col_map[c] for c in range(cols)]
            else:
                # Continuation page without header row: reuse previous mapping and keep first row as data
                reuse_prev_header = True
                col_map = prev_col_map[:]
                if prev_header_texts is not None:
                    header_texts = prev_header_texts[:]
                else:
                    header_texts = [col_map[c] for c in range(cols)]

        # Determine data start before totals scanning
        data_start = h_idx + 1
        if reuse_prev_header:
            data_start = h_idx

        # Stop at totals
        def row_text_list(r: int) -> List[str]:
            return row_text(tb, r, page_no, pw, ph, page_tokens)

        stop_at = rows
        if stop_after_totals:
            scan_start = data_start  # include reused-header rows when previous header is reused
            for r in range(scan_start, rows):
                joined = _canon(" ".join(row_text_list(r)))
                if joined and any(k in joined for k in TOTALS_KEYS_CANON):
                    stop_at = r
                    break
                # Per-page extra stop keys (e.g., to cut headers on continuation pages)
                extra_keys = PAGE_TOTALS_KEYS_CANON.get(page_no)
                if joined and extra_keys and any(k in joined for k in extra_keys):
                    stop_at = r
                    break

        grid_rows: List[Dict[str,Any]] = []
        for r in range(data_start, stop_at):
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

        # Apply per-page row limit override if configured
        limit = None
        try:
            if str(page_no) in page_row_limit:
                v = page_row_limit[str(page_no)]
                if isinstance(v, int) and v >= 0:
                    limit = v
        except Exception:
            limit = None
        if limit is not None:
            grid_rows = grid_rows[:limit]

        pages_out.append({
            "page": page_no,
            "flavor_used": best_flavor,
            "table": {
                "bbox": table_bbox,
                "header_row_index": h_idx,
                "header_cells": [{"col": c, "text": header_texts[c], "name": col_map[c]} for c in range(cols)],
                "rows": grid_rows
            }
        })

        prev_col_map = col_map[:]
        prev_header_texts = header_texts[:]

    out = {"doc_id": doc_id, "stage": "camelot_grid", "version": "1.3-config-strict", "pages": pages_out}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({
        "stage": "camelot_grid",
        "doc_id": doc_id,
        "pages": [{
            "page": p.get("page"),
            "rows": len(p.get("table",{}).get("rows",[])),
            "header_idx": p.get("table",{}).get("header_row_index", None),
            "cols": len(p.get("table",{}).get("header_cells",[])),
            "flavor": p.get("flavor_used")
        } for p in pages_out]
    }, ensure_ascii=False, separators=(",", ":")))
    return out

def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 4 — Camelot Grid (STRICT config mode)")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--tokens", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--config", required=True, help="JSON config with header aliases, totals keywords, and Camelot params (required)")
    args = ap.parse_args()

    build_cells(Path(args.pdf).resolve(),
                Path(args.tokens).resolve(),
                Path(args.out).resolve(),
                Path(args.config).resolve())

if __name__ == "__main__":
    main()
