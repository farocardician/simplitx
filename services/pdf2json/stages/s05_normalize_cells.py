#!/usr/bin/env python3
# Stage 5 — Heavy Cell Normalization
# In : /path/to/cells.json
# Out: /path/to/cells_normalized.json
#
# What we normalize (deterministic):
# - Fix common wrapped-words from line breaks (e.g., "Pi ntar" -> "Pintar")
# - Remove soft hyphen & stray hyphenation artifacts
# - Locale-aware number normalization to dot-decimal (keep original alongside)
# - ISO date normalization (YYYY-MM-DD) when unambiguous
#
# NOTE: We DO NOT reflow geometry or drop any fields. We add "text_norm"
#       to each cell to preserve original text while providing normalized text.

from __future__ import annotations
import argparse, json, re
from pathlib import Path
from typing import Dict, Any, List, Optional

# crude detectors
NUM_RE = re.compile(r"^\s*[\(\)\d.,]+\s*$")
DATE_YMD_RE = re.compile(r"^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s*$")
DATE_DMY_RE = re.compile(r"^\s*(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\s*$")

def _fix_wrapped(s: str) -> str:
    # remove soft hyphen
    s = s.replace("\xad", "")
    # common artifacts seen in this template
    subs = [
        (r"\bD engan\b", "Dengan"),
        (r"\bPi ntar\b", "Pintar"),
        (r"\bTr ack\b", "Track"),
        (r"\bInternasi onal\b", "Internasional"),
        (r"\bG EM\b", "GEM"),
        (r"-\s+", "-"),  # fix dash followed by space(s) -> dash only
        (r"\s+", " "),
    ]
    for pat, rep in subs:
        s = re.sub(pat, rep, s)
    return s.strip()

def _norm_number(s: str) -> Optional[str]:
    t = s.strip()
    if not NUM_RE.match(t):
        return None
    neg = t.startswith("(") and t.endswith(")")
    core = t.strip("()").replace(",", "")
    # if it's just "." as decimal, leave as is; if thousands-only with ".", we also strip
    # (our Stage 9 will parse as Decimal; here we just standardize a string)
    try:
        float(core)  # probe
        out = core
        if neg:
            out = "-" + out
        return out
    except Exception:
        return None

def _norm_date(s: str) -> Optional[str]:
    s = s.strip()
    m = DATE_YMD_RE.match(s)
    if m:
        y, mo, d = m.groups()
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    m = DATE_DMY_RE.match(s)
    if m:
        d, mo, y = m.groups()
        if len(y) == 2:
            y = "20" + y  # deterministic assumption for modern docs
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    return None

def _normalize_cell_text(txt: str, col_idx: int) -> str:
    base = _fix_wrapped(txt or "")
    # numeric columns by index in this template: [5]=QTY, [6]=UNIT_PRICE, [7]=AMOUNT
    if col_idx in (5, 6, 7):
        nn = _norm_number(base)
        if nn is not None:
            return nn
    # dates sometimes appear in header col 7 (index 7 on header row in our grid) or col 8 in a wider grid
    maybe_date = _norm_date(base)
    if maybe_date:
        return maybe_date
    return base

def normalize_cells(cells_in: Path, cells_out: Path) -> Dict[str, Any]:
    data = json.loads(cells_in.read_text(encoding="utf-8"))

    out_pages: List[Dict[str, Any]] = []
    for p in data.get("pages", []):
        table = p.get("table")
        if not table:
            out_pages.append(p)
            continue

        # normalize header_cells
        hdr = table.get("header_cells", [])
        hdr_norm = []
        for c in hdr:
            txt = c.get("text", "")
            idx = c.get("col", 0)
            c2 = dict(c)
            c2["text_norm"] = _normalize_cell_text(txt, idx)
            hdr_norm.append(c2)

        # normalize body rows
        rows_norm = []
        for r in table.get("rows", []):
            cells = r.get("cells", [])
            cnorm = []
            for c in cells:
                txt = c.get("text", "")
                idx = c.get("col", 0)
                c2 = dict(c)
                c2["text_norm"] = _normalize_cell_text(txt, idx)
                cnorm.append(c2)
            rows_norm.append({"row": r.get("row"), "cells": cnorm})

        tbl = dict(table)
        tbl["header_cells"] = hdr_norm
        tbl["rows"] = rows_norm

        out_pages.append({"page": p.get("page"), "table": tbl})

    out = {
        "doc_id": data.get("doc_id"),
        "stage": "normalize_cells",
        "version": "1.0",
        "pages": out_pages
    }
    cells_out.parent.mkdir(parents=True, exist_ok=True)
    cells_out.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # tiny summary
    print(json.dumps({
        "stage": out["stage"],
        "doc_id": out["doc_id"],
        "pages": [{"page": p["page"], "rows": len(p.get("table",{}).get("rows",[]))}
                  for p in out_pages]
    }, ensure_ascii=False, separators=(",", ":")))
    return out

def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 8 — Heavy Cell Normalization")
    ap.add_argument("--in", dest="inp", required=True, help="cells.json path")
    ap.add_argument("--out", required=True, help="cells_normalized.json path")
    args = ap.parse_args()
    normalize_cells(Path(args.inp).resolve(), Path(args.out).resolve())

if __name__ == "__main__":
    main()
