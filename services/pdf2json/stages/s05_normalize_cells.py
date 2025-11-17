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
import argparse, json, re, sys
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

# crude detectors
NUM_RE = re.compile(r"^\s*[\(\)\d.,]+\s*$")
DATE_YMD_RE = re.compile(r"^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s*$")
DATE_DMY_RE = re.compile(r"^\s*(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\s*$")

def _load_common_words(path: Optional[Path]) -> List[str]:
    if not path:
        return []
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if isinstance(data, list):
            return [str(w) for w in data if isinstance(w, str) and w]
    except Exception:
        pass
    return []

def _fix_wrapped(s: str, config: Optional[Dict[str, Any]] = None, common_words: Optional[List[str]] = None) -> str:
    """Apply text reconstruction rules from config (common pattern fixes)."""
    s = (s or "").replace("\xad", "")  # remove soft hyphen artifacts

    # First, normalize broken common words from an external list
    cw_list = [w for w in (common_words or []) if isinstance(w, str) and w]
    for w in cw_list:
        letters = list(w)
        # Build pattern that tolerates spaces between letters, word-bounded
        pat = r"\b" + r"\s*".join(re.escape(ch) for ch in letters) + r"\b"
        try:
            # Replace matched segment by removing whitespace inside, preserving original letter cases
            s = re.sub(pat, lambda m: re.sub(r"\s+", "", m.group(0)), s, flags=re.IGNORECASE)
        except re.error:
            continue

    # Generic spacing/hyphen fixes
    rules: List[Tuple[str, str]] = [
        (r"-\s+", "-"),
        (r"\s+", " "),
    ]

    for pat, rep in rules:
        try:
            s = re.sub(pat, rep, s)
        except re.error:
            # Skip invalid patterns
            continue
    return s.strip()

def _norm_number(s: str, config: Dict[str, Any]) -> Optional[str]:
    """Normalize number based on config settings (stage5.number_format)."""
    t = (s or "").strip()
    if not NUM_RE.match(t):
        return None

    nf = (config.get("stage5", {}) or {}).get("number_format", {})
    decimal = nf.get("decimal", ".")
    thousands = nf.get("thousands", ",")
    allow_parens = bool(nf.get("allow_parens", True))

    neg = allow_parens and t.startswith("(") and t.endswith(")")
    core = t[1:-1] if neg else t

    if thousands:
        core = core.replace(thousands, "")
    if decimal != ".":
        core = core.replace(decimal, ".")

    try:
        float(core)
        return ("-" + core) if neg else core
    except Exception:
        return None

def _norm_integer(s: str, config: Dict[str, Any]) -> Optional[str]:
    """Normalize integer using number rules but ensure integral output."""
    n = _norm_number(s, config)
    if n is None:
        return None
    try:
        f = float(n)
        if f.is_integer():
            return str(int(f))
        # if it has decimals, not an integer
        return None
    except Exception:
        return None

def _compile_token_date_pattern(pat: str) -> Tuple[re.Pattern, Tuple[str, str, str]]:
    """Compile token pattern like 'YYYY-MM-DD' to regex and return group order."""
    pat = pat.strip().upper()
    # Support common separators '-' or '/'
    if pat == "YYYY-MM-DD":
        return re.compile(r"^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$"), ("Y","M","D")
    if pat == "DD-MM-YYYY":
        return re.compile(r"^\s*(\d{1,2})-(\d{1,2})-(\d{4})\s*$"), ("D","M","Y")
    if pat == "MM/DD/YYYY":
        return re.compile(r"^\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*$"), ("M","D","Y")
    if pat == "YYYY/MM/DD":
        return re.compile(r"^\s*(\d{4})/(\d{1,2})/(\d{1,2})\s*$"), ("Y","M","D")
    if pat == "DD/MM/YY":
        return re.compile(r"^\s*(\d{1,2})/(\d{1,2})/(\d{2})\s*$"), ("D","M","Y")
    # Fallback to strict Y-M-D and D-M-Y regex if unknown
    return re.compile(r"^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s*$"), ("Y","M","D")

def _norm_date(s: str, config: Dict[str, Any]) -> Optional[str]:
    """Normalize dates based on config (stage5.date_formats)."""
    s = (s or "").strip()
    if not s:
        return None

    date_cfg = (config.get("stage5", {}) or {}).get("date_formats")
    patterns: List[Tuple[re.Pattern, Tuple[str,str,str]]] = []
    output_fmt = "YYYY-MM-DD"
    cutoff = 50
    if isinstance(date_cfg, dict):
        output_fmt = str(date_cfg.get("output_format", "YYYY-MM-DD"))
        try:
            cutoff = int(date_cfg.get("century_cutoff", 50))
        except Exception:
            cutoff = 50
        for p in (date_cfg.get("input_patterns") or []):
            if not isinstance(p, str):
                continue
            P = p.strip()
            # If contains Y/M/D tokens, compile as token pattern
            if any(tok in P.upper() for tok in ("YYYY","YY","MM","DD")):
                rx, order = _compile_token_date_pattern(P)
                patterns.append((rx, order))
            else:
                # Treat as regex; infer order heuristically after match
                try:
                    rx = re.compile(P)
                    # Use placeholder; we will detect by group lengths
                    patterns.append((rx, ("?","?","?")))
                except re.error:
                    continue
    else:
        # Defaults (regex-based): Y-M-D and D-M-Y
        patterns = [
            (DATE_YMD_RE, ("Y","M","D")),
            (DATE_DMY_RE, ("D","M","Y")),
        ]

    def _century_fix(y: int) -> int:
        if y < 100:
            return (1900 + y) if y >= cutoff else (2000 + y)
        return y

    for rx, order in patterns:
        m = rx.match(s)
        if not m:
            continue
        g1, g2, g3 = m.groups()[:3]
        # detect order if unknown using length heuristic
        o1, o2, o3 = order
        if o1 == o2 == o3 == "?":
            if len(g1) == 4:
                order = ("Y","M","D")
            elif len(g3) == 4:
                # Assume MDY as common if separator is '/'; otherwise DMY
                sep = "/" if "/" in s else "-"
                order = ("M","D","Y") if sep == "/" else ("D","M","Y")
            else:
                # Fallback
                order = ("Y","M","D")
        y = mo = d = None
        mapping = {"Y": None, "M": None, "D": None}
        mapping[order[0]] = g1
        mapping[order[1]] = g2
        mapping[order[2]] = g3
        try:
            y = _century_fix(int(mapping["Y"]))
            mo = int(mapping["M"]) if mapping["M"] is not None else None
            d = int(mapping["D"]) if mapping["D"] is not None else None
        except Exception:
            continue
        if y and mo and d:
            # Only output YYYY-MM-DD regardless of output_fmt for now (as specified)
            return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    return None

def _normalize_cell_text(txt: str, col_idx: int, col_name: str, config: Dict[str, Any], common_words: Optional[List[str]] = None) -> str:
    """Normalize a cell's text based on config-defined column types."""
    base = _fix_wrapped(txt or "", config, common_words)

    st5 = (config.get("stage5", {}) or {})
    col_types = st5.get("column_types", {}) if isinstance(st5, dict) else {}
    by_family = (col_types.get("by_family") or {}) if isinstance(col_types, dict) else {}
    by_position = (col_types.get("by_position") or {}) if isinstance(col_types, dict) else {}

    ctype = by_family.get(str(col_name))
    # override by position if present
    if str(col_idx) in by_position:
        ctype = by_position.get(str(col_idx))

    if ctype == "number":
        nn = _norm_number(base, config)
        if nn is not None:
            return nn
    elif ctype == "integer":
        ni = _norm_integer(base, config)
        if ni is not None:
            return ni

    # Handle dates when explicitly listed in date_columns
    date_cols = (col_types.get("date_columns") or []) if isinstance(col_types, dict) else []
    if col_name in date_cols:
        maybe_date = _norm_date(base, config)
        if maybe_date:
            return maybe_date

    return base

def _load_config(config_path: Optional[Path]) -> Dict[str, Any]:
    if config_path is None:
        return {}
    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[WARN] Could not read config: {e}", file=sys.stderr)
        return {}

def normalize_cells(cells_in: Path, cells_out: Path, config_path: Optional[Path] = None, common_words_path: Optional[Path] = None) -> Dict[str, Any]:
    data = json.loads(cells_in.read_text(encoding="utf-8"))
    config = _load_config(config_path)
    common_words = _load_common_words(common_words_path)

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
            name = c.get("name", f"COL{idx+1}")
            c2 = dict(c)
            c2["text_norm"] = _normalize_cell_text(txt, idx, name, config, common_words)
            hdr_norm.append(c2)

        # normalize body rows
        rows_norm = []
        for r in table.get("rows", []):
            cells = r.get("cells", [])
            cnorm = []
            for c in cells:
                txt = c.get("text", "")
                idx = c.get("col", 0)
                name = c.get("name", f"COL{idx+1}")
                c2 = dict(c)
                c2["text_norm"] = _normalize_cell_text(txt, idx, name, config, common_words)
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
    ap = argparse.ArgumentParser(description="Stage 5 — Heavy Cell Normalization (config-driven)")
    ap.add_argument("--in", dest="inp", required=True, help="cells.json path")
    ap.add_argument("--out", required=True, help="cells_normalized.json path")
    ap.add_argument("--config", required=False, help="Layout config JSON (same used by Stage 4/6)")
    ap.add_argument("--common-words", dest="common_words", required=False, help="Path to JSON list of common words for de-spacing (e.g., ['dengan'])")
    args = ap.parse_args()
    cfg = Path(args.config).resolve() if getattr(args, "config", None) else None
    cw = Path(args.common_words).resolve() if getattr(args, "common_words", None) else None
    normalize_cells(Path(args.inp).resolve(), Path(args.out).resolve(), cfg, cw)

if __name__ == "__main__":
    main()
