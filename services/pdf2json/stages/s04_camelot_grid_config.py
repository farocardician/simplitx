#!/usr/bin/env python3
from __future__ import annotations
"""Stage 4 + 4.5 — Camelot grid with deterministic row fixer."""

import argparse
import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from statistics import median
from typing import Any, Dict, Iterable, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------


def _canon(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = s.casefold()
    return "".join(ch for ch in s if ch.isalnum())


def _token_text(t: Dict[str, Any]) -> str:
    return t.get("norm") or t.get("text") or ""


def _tok_center(t: Dict[str, Any]) -> Tuple[float, float]:
    b = t["bbox"]
    return (float(b["x0"] + b["x1"]) / 2.0, float(b["y0"] + b["y1"]) / 2.0)


def _tok_right(t: Dict[str, Any]) -> float:
    return float(t["bbox"]["x1"])


def _tok_left(t: Dict[str, Any]) -> float:
    return float(t["bbox"]["x0"])


def _tok_top(t: Dict[str, Any]) -> float:
    return float(t["bbox"]["y0"])


def _tok_bottom(t: Dict[str, Any]) -> float:
    return float(t["bbox"]["y1"])


def _points_to_norm(points: float, page_height: float) -> float:
    if not page_height:
        return 0.0
    return float(points) / float(page_height)


# ---------------------------------------------------------------------------
# Configuration structures
# ---------------------------------------------------------------------------


NUMERIC_FAMILIES = {"QTY", "UNIT_PRICE", "DISCOUNT", "TOTAL_PRICE", "TOTAL", "AMOUNT"}
NUMERIC_ANCHOR_RE = re.compile(r"^[0-9][0-9.,]*$")
NUMERIC_X_THRESHOLD_FRACTION = 0.45


@dataclass
class CamelotConfig:
    flavor_order: List[str]
    lattice_line_scale: int
    stream_row_tol: Optional[float]
    stream_line_scale: Optional[int]


@dataclass
class RowFixOptions:
    enabled: bool = False
    shadow_mode: bool = False
    continuation_gap_points: float = 6.0
    header_margin_points: float = 3.0
    numeric_column_mode: str = "right_edge_cluster"
    numeric_band_tolerance_points: float = 4.0
    partno_regex_list: List[str] = field(default_factory=list)
    arithmetic_abs_tol: float = 1.0
    arithmetic_rel_tol: float = 0.005
    subtotal_abs_tol: float = 2.0
    subtotal_rel_tol: float = 0.003
    use_llm_hints: bool = False
    debug_dump: bool = False
    cache_enabled: bool = True


@dataclass
class TemplateConfig:
    header_aliases: Dict[str, List[str]]
    totals_keywords: List[str]
    camelot: CamelotConfig
    stop_after_totals: bool
    page_stop_keywords: Dict[int, List[str]]
    page_row_limit: Dict[int, int]
    row_fix: RowFixOptions


def _validate_config(cfg: Dict[str, Any]) -> TemplateConfig:
    missing = []
    if "header_aliases" not in cfg or not isinstance(cfg["header_aliases"], dict) or not cfg["header_aliases"]:
        missing.append("header_aliases (non-empty dict)")
    if "totals_keywords" not in cfg or not isinstance(cfg["totals_keywords"], list) or not cfg["totals_keywords"]:
        missing.append("totals_keywords (non-empty list)")

    camelot_cfg = cfg.get("camelot")
    if not isinstance(camelot_cfg, dict):
        missing.append("camelot (dict)")
    else:
        if not isinstance(camelot_cfg.get("flavor_order"), list) or not camelot_cfg["flavor_order"]:
            missing.append("camelot.flavor_order (non-empty list)")
        if "line_scale" not in camelot_cfg:
            missing.append("camelot.line_scale (int)")

    if missing:
        raise ValueError("Config missing required fields: " + "; ".join(missing))

    stop_after_totals = bool(cfg.get("stop_after_totals", True))
    page_stop_keywords = {}
    for k, v in (cfg.get("page_stop_keywords") or {}).items():
        try:
            page_stop_keywords[int(k)] = list(v or [])
        except Exception:
            continue

    page_row_limit = {}
    for k, v in (cfg.get("page_row_limit") or {}).items():
        try:
            vk = int(k)
            vv = int(v)
            if vv >= 0:
                page_row_limit[vk] = vv
        except Exception:
            continue

    row_fix_cfg = cfg.get("row_fix") or {}
    row_fix = RowFixOptions(
        enabled=bool(row_fix_cfg.get("enabled", False)),
        shadow_mode=bool(row_fix_cfg.get("shadow_mode", False)),
        continuation_gap_points=float(row_fix_cfg.get("continuation_gap_points", 6.0)),
        header_margin_points=float(row_fix_cfg.get("header_margin_points", 3.0)),
        numeric_column_mode=str(row_fix_cfg.get("numeric_column_mode", "right_edge_cluster")),
        numeric_band_tolerance_points=float(row_fix_cfg.get("numeric_band_tolerance_points", 4.0)),
        partno_regex_list=list(row_fix_cfg.get("partno_regex_list", []) or []),
        arithmetic_abs_tol=float(row_fix_cfg.get("arithmetic_abs_tolerance", 1.0)),
        arithmetic_rel_tol=float(row_fix_cfg.get("arithmetic_rel_tolerance", 0.005)),
        subtotal_abs_tol=float(row_fix_cfg.get("subtotal_abs_tolerance", 2.0)),
        subtotal_rel_tol=float(row_fix_cfg.get("subtotal_rel_tolerance", 0.003)),
        use_llm_hints=bool(row_fix_cfg.get("use_llm_hints", False)),
        debug_dump=bool(row_fix_cfg.get("debug_dump", False)),
        cache_enabled=bool(row_fix_cfg.get("cache_enabled", True)),
    )

    return TemplateConfig(
        header_aliases={str(k): list(v or []) for k, v in cfg["header_aliases"].items()},
        totals_keywords=list(cfg["totals_keywords"]),
        camelot=CamelotConfig(
            flavor_order=list(camelot_cfg["flavor_order"]),
            lattice_line_scale=int(camelot_cfg.get("line_scale", 40)),
            stream_row_tol=(camelot_cfg.get("row_tol_stream") if camelot_cfg.get("row_tol_stream") is not None else None),
            stream_line_scale=(int(camelot_cfg.get("line_scale_stream")) if camelot_cfg.get("line_scale_stream") is not None else None),
        ),
        stop_after_totals=stop_after_totals,
        page_stop_keywords=page_stop_keywords,
        page_row_limit=page_row_limit,
        row_fix=row_fix,
    )


# ---------------------------------------------------------------------------
# Token loading helpers
# ---------------------------------------------------------------------------


@dataclass
class TokensData:
    doc_id: Optional[str]
    tokens: List[Dict[str, Any]]
    page_meta: Dict[int, Tuple[float, float]]


def load_tokens(tokens_path: Path) -> TokensData:
    try:
        raw = json.loads(tokens_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Failed to read tokens file: {exc}")

    tokens = []
    if "tokens" in raw and isinstance(raw["tokens"], list):
        tokens = raw["tokens"]
    elif "plumber" in raw and isinstance(raw["plumber"], dict) and isinstance(raw["plumber"].get("tokens"), list):
        tokens = raw["plumber"]["tokens"]
    else:
        raise RuntimeError("Tokens JSON missing 'tokens' list")

    pages_meta = {}
    for entry in raw.get("pages", []):
        try:
            pn = int(entry.get("page"))
            pw = float(entry.get("width"))
            ph = float(entry.get("height"))
            pages_meta[pn] = (pw, ph)
        except Exception:
            continue

    return TokensData(doc_id=raw.get("doc_id"), tokens=tokens, page_meta=pages_meta)


# ---------------------------------------------------------------------------
# Camelot runner — geometry first
# ---------------------------------------------------------------------------


def run_camelot_tables(pdf_path: Path, cfg: TemplateConfig, tokens: TokensData) -> Dict[int, List[Tuple[Any, str]]]:
    import camelot  # type: ignore

    flavor_order = cfg.camelot.flavor_order
    lattice_ls = cfg.camelot.lattice_line_scale
    stream_row_tol = cfg.camelot.stream_row_tol
    stream_line_scale = cfg.camelot.stream_line_scale

    def safe_read_page(flavor: str, page: int):
        try:
            if flavor == "lattice":
                return camelot.read_pdf(str(pdf_path), pages=str(page), flavor="lattice", line_scale=lattice_ls)
            if flavor == "stream":
                kwargs = {}
                # Priority: use line_scale if specified (Simon-style), otherwise use row_tol (Rittal-style)
                if stream_line_scale is not None:
                    kwargs["line_scale"] = stream_line_scale
                elif stream_row_tol is not None:
                    kwargs["row_tol"] = stream_row_tol
                return camelot.read_pdf(str(pdf_path), pages=str(page), flavor="stream", **kwargs)
            return []
        except Exception:
            return []

    by_page: Dict[int, List[Tuple[Any, str]]] = {}
    pages = sorted({int(t["page"]) for t in tokens.tokens})
    for page_no in pages:
        tables: List[Tuple[Any, str]] = []
        for flavor in flavor_order:
            got = safe_read_page(flavor, page_no) or []
            if got:
                for tb in got:
                    tables.append((tb, flavor))
        by_page[page_no] = tables
    return by_page


# ---------------------------------------------------------------------------
# Base table reconstruction (Stage 4)
# ---------------------------------------------------------------------------


def _build_family_matcher(header_aliases: Dict[str, List[str]]):
    canon_map: Dict[str, List[str]] = {}
    for fam, aliases in header_aliases.items():
        canon_map[fam] = [_canon(a) for a in (aliases or [])]

    def _match(text: str) -> Optional[str]:
        c = _canon(text)
        if not c:
            return None
        hit_fam = None
        hit_len = 0
        for fam, patterns in canon_map.items():
            for pattern in patterns:
                if pattern and pattern in c:
                    if len(pattern) > hit_len:
                        hit_fam = fam
                        hit_len = len(pattern)
        return hit_fam

    return _match


@dataclass
class BaseTable:
    page: int
    flavor: Optional[str]
    header_row_index: Optional[int]
    header_cells: List[Dict[str, Any]]
    rows: List[Dict[str, Any]]
    bbox: Dict[str, float]


def build_base_tables(pdf_path: Path, tokens_path: Path, out_path: Path, cfg: TemplateConfig, tokens: TokensData) -> List[BaseTable]:
    by_page_tokens: Dict[int, List[Dict[str, Any]]] = {}
    for t in tokens.tokens:
        by_page_tokens.setdefault(int(t["page"]), []).append(t)

    tables_by_page = run_camelot_tables(pdf_path, cfg, tokens)
    family_of_header = _build_family_matcher(cfg.header_aliases)
    totals_keys = {_canon(k) for k in cfg.totals_keywords if k}

    def get_page_dims(tb, page_no: int) -> Tuple[float, float]:
        pr = getattr(tb, "parsing_report", {}) or {}
        pw = pr.get("page_width")
        ph = pr.get("page_height")
        if not pw or not ph:
            if page_no in tokens.page_meta:
                return tokens.page_meta[page_no]
            pts = by_page_tokens.get(page_no, [])
            if pts:
                ab = pts[0].get("abs_bbox", {})
                w = ab.get("width")
                h = ab.get("height")
                if w and h:
                    return float(w), float(h)
        return float(pw or 0.0), float(ph or 0.0)

    def get_cell_bbox(tb, r: int, c: int, pw: float, ph: float) -> Tuple[float, float, float, float]:
        cell = tb.cells[r][c]
        x0 = float(cell.x1) / pw
        x1 = float(cell.x2) / pw
        y0 = 1.0 - (float(cell.y2) / ph)
        y1 = 1.0 - (float(cell.y1) / ph)
        return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))

    def row_text(tb, r: int, page_no: int, pw: float, ph: float, page_tokens: List[Dict[str, Any]]) -> List[str]:
        cols = tb.shape[1]
        pieces: List[str] = []
        for c in range(cols):
            bx = get_cell_bbox(tb, r, c, pw, ph)
            texts = []
            for tok in page_tokens:
                cx, cy = _tok_center(tok)
                if bx[0] - 1e-6 <= cx <= bx[2] + 1e-6 and bx[1] - 1e-6 <= cy <= bx[3] + 1e-6:
                    texts.append(_token_text(tok))
            joined = " ".join(z for z in texts if z).strip()
            joined = " ".join(joined.split())
            pieces.append(joined)
        return pieces

    pages_out: List[BaseTable] = []
    processed_pages = sorted({int(t["page"]) for t in tokens.tokens})
    prev_col_map: Optional[List[str]] = None
    prev_header_texts: Optional[List[str]] = None

    for page_no in processed_pages:
        page_tokens = sorted(by_page_tokens.get(page_no, []), key=lambda t: (t["bbox"]["y0"], t["bbox"]["x0"]))
        tables = tables_by_page.get(page_no, [])

        best = None
        best_score = (-1, -1)
        best_idx = None
        best_dims = (None, None)
        best_flavor = None

        for tb, flavor in tables:
            pw, ph = get_page_dims(tb, page_no)
            if not pw or not ph:
                continue
            rows, cols = tb.shape
            local_best = (-1, -1)
            local_idx = None
            for r in range(min(rows, 12)):
                texts = row_text(tb, r, page_no, pw, ph, page_tokens)
                fam_hits = set()
                for txt in texts:
                    fam = family_of_header(txt)
                    if fam:
                        fam_hits.add(fam)
                def _row_text(rr: int) -> List[str]:
                    return row_text(tb, rr, page_no, pw, ph, page_tokens)
                stop_at = rows
                if cfg.stop_after_totals:
                    for rr in range(r + 1, rows):
                        joined = _canon(" ".join(_row_text(rr)))
                        if joined and any(k in joined for k in totals_keys):
                            stop_at = rr
                            break
                body_count = max(0, stop_at - (r + 1))
                cand = (body_count, len(fam_hits))
                if cand > local_best:
                    local_best = cand
                    local_idx = r
            if local_idx is not None and local_best > best_score:
                best_score = local_best
                best = tb
                best_idx = local_idx
                best_dims = (pw, ph)
                best_flavor = flavor

        if best is None:
            pages_out.append(BaseTable(page=page_no, flavor=None, header_row_index=None, header_cells=[], rows=[], bbox={}))
            continue

        tb = best
        pw, ph = best_dims
        rows, cols = tb.shape
        header_idx = best_idx if best_idx is not None else 0

        if hasattr(tb, "_bbox") and tb._bbox and all(tb._bbox):
            x1, y1, x2, y2 = tb._bbox
            tbx0 = float(x1) / pw
            tbx1 = float(x2) / pw
            tby0 = 1.0 - (float(y2) / ph)
            tby1 = 1.0 - (float(y1) / ph)
        else:
            xs0: List[float] = []
            ys0: List[float] = []
            xs1: List[float] = []
            ys1: List[float] = []
            for r in range(rows):
                for c in range(cols):
                    x0, y0, x1, y1 = get_cell_bbox(tb, r, c, pw, ph)
                    xs0.append(x0)
                    ys0.append(y0)
                    xs1.append(x1)
                    ys1.append(y1)
            tbx0 = min(xs0) if xs0 else 0.0
            tby0 = min(ys0) if ys0 else 0.0
            tbx1 = max(xs1) if xs1 else 1.0
            tby1 = max(ys1) if ys1 else 1.0

        table_bbox = {"x0": tbx0, "y0": tby0, "x1": tbx1, "y1": tby1}
        header_texts = row_text(tb, header_idx, page_no, pw, ph, page_tokens)
        col_map: List[str] = []
        header_hits = 0
        for c in range(cols):
            fam = family_of_header(header_texts[c])
            if fam:
                header_hits += 1
            col_map.append(fam or f"COL{c+1}")

        reuse_prev = False
        if header_hits == 0:
            if prev_col_map is not None:
                reuse_prev = True
                col_map = prev_col_map[:]
                if prev_header_texts is not None:
                    header_texts = prev_header_texts[:]
                else:
                    header_texts = [col_map[c] for c in range(cols)]
            else:
                header_texts = [col_map[c] for c in range(cols)]

        data_start = header_idx + 1
        if reuse_prev:
            data_start = header_idx

        def row_text_list(r: int) -> List[str]:
            return row_text(tb, r, page_no, pw, ph, page_tokens)

        stop_at = rows
        if cfg.stop_after_totals:
            scan_start = data_start
            extra_keys = {_canon(k) for k in cfg.page_stop_keywords.get(page_no, []) if k}
            for r in range(scan_start, rows):
                joined = _canon(" ".join(row_text_list(r)))
                if joined and any(k in joined for k in totals_keys):
                    stop_at = r
                    break
                if extra_keys and joined and any(k in joined for k in extra_keys):
                    stop_at = r
                    break

        grid_rows: List[Dict[str, Any]] = []
        for r in range(data_start, stop_at):
            texts = row_text_list(r)
            cells = []
            for c in range(cols):
                x0, y0, x1, y1 = get_cell_bbox(tb, r, c, pw, ph)
                cells.append({
                    "col": c,
                    "name": col_map[c],
                    "bbox": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
                    "text": texts[c],
                })
            grid_rows.append({"row": r, "cells": cells})

        limit = cfg.page_row_limit.get(page_no)
        if limit is not None:
            grid_rows = grid_rows[:limit]

        pages_out.append(BaseTable(
            page=page_no,
            flavor=best_flavor,
            header_row_index=header_idx,
            header_cells=[{"col": c, "text": header_texts[c], "name": col_map[c]} for c in range(cols)],
            rows=grid_rows,
            bbox=table_bbox,
        ))

        prev_col_map = col_map[:]
        prev_header_texts = header_texts[:]

    return pages_out


# ---------------------------------------------------------------------------
# Row fixer (Stage 4.5)
# ---------------------------------------------------------------------------


@dataclass
class ColumnBand:
    index: int
    name: str
    x0: float
    x1: float

    def center(self) -> float:
        return (self.x0 + self.x1) / 2.0


@dataclass
class RowBand:
    index: int
    y0: float
    y1: float
    tokens: List[Dict[str, Any]]
    column_tokens: Dict[int, List[Dict[str, Any]]] = field(default_factory=dict)
    has_numeric: bool = False
    merged_from: List[int] = field(default_factory=list)


class TemplateCache:
    def __init__(self, cfg_path: Path, enabled: bool) -> None:
        self.cfg_path = cfg_path
        self.enabled = enabled
        self.cache_path = cfg_path.with_name(cfg_path.stem + "_cache.json")
        self.data: Dict[str, Any] = {}
        if enabled:
            self._load()

    def _load(self) -> None:
        if not self.cache_path.exists():
            self.data = {}
            return
        try:
            self.data = json.loads(self.cache_path.read_text(encoding="utf-8"))
        except Exception:
            self.data = {}

    def get_entry(self, fingerprint: str) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            return None
        return self.data.get(fingerprint)

    def save_entry(self, fingerprint: str, value: Dict[str, Any]) -> None:
        if not self.enabled:
            return
        self.data[fingerprint] = value
        try:
            self.cache_path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass


class RowFixer:
    def __init__(self, cfg: TemplateConfig, cfg_path: Path, tokens: TokensData, base_tables: List[BaseTable]) -> None:
        self.cfg = cfg
        self.cfg_path = cfg_path
        self.tokens = tokens
        self.base_tables = base_tables
        self.tokens_by_page: Dict[int, List[Dict[str, Any]]] = {}
        for tok in tokens.tokens:
            self.tokens_by_page.setdefault(int(tok["page"]), []).append(tok)
        self.fix_report: List[Dict[str, Any]] = []
        self.after_vs_before: List[Dict[str, Any]] = []
        self.debug_rows: Dict[int, List[Dict[str, Any]]] = {}
        self.debug_columns: Dict[int, List[Dict[str, Any]]] = {}
        self.cache = TemplateCache(cfg_path, cfg.row_fix.cache_enabled)
        self.partno_regexes = [re.compile(p, re.IGNORECASE) for p in cfg.row_fix.partno_regex_list if p]

    def apply(self) -> List[BaseTable]:
        result: List[BaseTable] = []
        for table in self.base_tables:
            if not table.rows:
                result.append(table)
                continue
            page_tokens = self.tokens_by_page.get(table.page, [])
            page_meta = self.tokens.page_meta.get(table.page, (None, None))
            fixed = self._fix_page(table, page_tokens, page_meta)
            result.append(fixed)
        return result

    # Core fixing per page
    def _fix_page(self, base: BaseTable, page_tokens: List[Dict[str, Any]], page_meta: Tuple[Optional[float], Optional[float]]) -> BaseTable:
        width, height = page_meta
        if not width or not height:
            width = width or 1.0
            height = height or 1.0
        fingerprint = self._header_fingerprint(base)
        cached_entry = self.cache.get_entry(fingerprint)

        if base.rows:
            header_bottom = min((cell["bbox"]["y0"] for cell in base.rows[0]["cells"] if cell.get("bbox")), default=base.bbox.get("y0", 0.0))
        else:
            header_bottom = base.bbox.get("y0", 0.0)
        table_top = base.bbox.get("y0", 0.0)
        header_gap_norm = _points_to_norm(self.cfg.row_fix.header_margin_points, height)
        slack = max(header_gap_norm, 0.02)
        body_top = max(table_top, header_bottom - slack)
        table_bottom = base.bbox.get("y1", body_top + 0.5)

        totals_keys = {_canon(k) for k in self.cfg.totals_keywords if k}
        totals_y_candidates: List[float] = []
        for tok in page_tokens:
            cy = _tok_center(tok)[1]
            if cy <= body_top:
                continue
            canon = _canon(_token_text(tok))
            if canon and any(k in canon for k in totals_keys):
                totals_y_candidates.append(_tok_top(tok))
        body_bottom = min(totals_y_candidates) if totals_y_candidates else table_bottom
        if body_bottom <= body_top:
            body_bottom = table_bottom

        table_tokens = [tok for tok in page_tokens if body_top <= _tok_center(tok)[1] <= body_bottom and base.bbox.get("x0", 0.0) - 0.02 <= _tok_center(tok)[0] <= base.bbox.get("x1", 1.0) + 0.02]
        table_tokens.sort(key=lambda t: (_tok_top(t), _tok_left(t)))

        columns = self._build_columns(base, cached_entry)

        gap_norm = _points_to_norm(self.cfg.row_fix.continuation_gap_points, height)
        if cached_entry and isinstance(cached_entry.get("median_row_gap"), (int, float)):
            cached_gap = float(cached_entry["median_row_gap"])
            if cached_gap > 0:
                gap_norm = cached_gap
        row_bands = self._build_row_bands(table_tokens, columns, body_top, body_bottom, height, base.bbox, gap_norm)
        self._assign_tokens_to_columns(row_bands, columns)
        self._refine_numeric_columns(columns, row_bands, height, base.bbox)
        self._assign_tokens_to_columns(row_bands, columns)
        self.debug_columns[base.page] = [{"name": col.name, "x0": col.x0, "x1": col.x1} for col in columns]
        merged_rows = self._merge_continuations(row_bands, columns, gap_norm)
        rows_with_cells = self._build_cells_from_rows(merged_rows, columns)

        arithmetic = self._run_arithmetic(rows_with_cells)
        subtotal_status = self._check_subtotal(arithmetic)

        self.debug_rows[base.page] = rows_with_cells
        self.fix_report.append({
            "page": base.page,
            "header_fingerprint": fingerprint,
            "arithmetic": arithmetic,
            "subtotal": subtotal_status,
        })

        before_rows = [[cell.get("text", "") for cell in row["cells"]] for row in base.rows]
        after_rows = [[cell.get("text", "") for cell in row["cells"]] for row in rows_with_cells]
        self.after_vs_before.append({
            "page": base.page,
            "before": before_rows,
            "after": after_rows,
        })

        row_heights = [row["y1"] - row["y0"] for row in rows_with_cells]
        row_gaps = [rows_with_cells[i + 1]["y0"] - rows_with_cells[i]["y1"] for i in range(len(rows_with_cells) - 1)]
        cache_payload = {
            "columns": [{"name": col.name, "x0": col.x0, "x1": col.x1} for col in columns],
            "updated_at": datetime.utcnow().isoformat(timespec="seconds"),
        }
        if row_heights:
            cache_payload["median_row_height"] = median(row_heights)
        if row_gaps:
            med_gap = median(row_gaps)
            if med_gap > 0:
                cache_payload["median_row_gap"] = med_gap
        self.cache.save_entry(fingerprint, cache_payload)

        if self.cfg.row_fix.shadow_mode:
            return base

        return BaseTable(
            page=base.page,
            flavor=base.flavor,
            header_row_index=base.header_row_index,
            header_cells=base.header_cells,
            rows=[{"row": idx, "cells": row["cells"]} for idx, row in enumerate(rows_with_cells)],
            bbox=base.bbox,
        )

    def _build_columns(self, base: BaseTable, cached_entry: Optional[Dict[str, Any]]) -> List[ColumnBand]:
        cols = []
        for idx, header in enumerate(base.header_cells):
            bbox = None
            # locate representative bbox from body to cover entire column width
            for row in base.rows:
                for cell in row.get("cells", []):
                    if int(cell.get("col", -1)) == idx:
                        bbox = cell.get("bbox")
                        break
                if bbox:
                    break
            if not bbox:
                bbox = header.get("bbox") or {}
            x0 = float(bbox.get("x0", header.get("bbox", {}).get("x0", base.bbox.get("x0", 0.0))))
            x1 = float(bbox.get("x1", header.get("bbox", {}).get("x1", base.bbox.get("x1", 1.0))))
            cols.append(ColumnBand(index=idx, name=header.get("name") or header.get("text") or f"COL{idx+1}", x0=x0, x1=x1))
        cols.sort(key=lambda c: c.x0)

        if cached_entry and isinstance(cached_entry.get("columns"), list):
            cached_map = {str(col.get("name")).upper(): col for col in cached_entry["columns"]}
            for col in cols:
                cached_col = cached_map.get(col.name.upper())
                if cached_col:
                    try:
                        col.x0 = float(cached_col.get("x0", col.x0))
                        col.x1 = float(cached_col.get("x1", col.x1))
                    except Exception:
                        continue
            cols.sort(key=lambda c: c.x0)
        return cols

    def _header_fingerprint(self, base: BaseTable) -> str:
        names = []
        for cell in base.header_cells:
            label = cell.get("name") or cell.get("text") or ""
            names.append(_canon(label))
        return "|".join(names)

    def _build_row_bands(self, table_tokens: List[Dict[str, Any]], columns: List[ColumnBand], body_top: float, body_bottom: float, page_height: float, table_bbox: Dict[str, Any], fallback_gap: float) -> List[RowBand]:
        bands = self._build_row_bands_from_numeric(table_tokens, body_top, body_bottom, table_bbox, page_height)
        if bands:
            return bands
        return self._cluster_rows(table_tokens, fallback_gap)

    def _build_row_bands_from_numeric(self, table_tokens: List[Dict[str, Any]], body_top: float, body_bottom: float, table_bbox: Dict[str, Any], page_height: float) -> List[RowBand]:
        x0 = float(table_bbox.get("x0", 0.0))
        x1 = float(table_bbox.get("x1", 1.0))
        threshold = x0 + (x1 - x0) * NUMERIC_X_THRESHOLD_FRACTION
        anchor_tokens: List[Dict[str, Any]] = []
        for tok in table_tokens:
            text = _token_text(tok).strip()
            if not text:
                continue
            simple = text.replace(" ", "").replace("(", "").replace(")", "")
            if not NUMERIC_ANCHOR_RE.fullmatch(simple):
                continue
            cx = _tok_center(tok)[0]
            if cx < threshold:
                continue
            anchor_tokens.append(tok)
        if not anchor_tokens:
            return []
        anchor_tokens.sort(key=lambda t: _tok_center(t)[1])
        anchor_tol = max(_points_to_norm(self.cfg.row_fix.continuation_gap_points, page_height) * 0.5, 0.003)
        clusters: List[List[Dict[str, Any]]] = []
        for tok in anchor_tokens:
            cy = _tok_center(tok)[1]
            if not clusters:
                clusters.append([tok])
                continue
            last_cluster = clusters[-1]
            last_cy = _tok_center(last_cluster[-1])[1]
            if abs(cy - last_cy) <= anchor_tol:
                last_cluster.append(tok)
            else:
                clusters.append([tok])
        centers = [median([_tok_center(tok)[1] for tok in cluster]) for cluster in clusters]
        ranges = [
            (
                min(_tok_top(tok) for tok in cluster),
                max(_tok_bottom(tok) for tok in cluster)
            )
            for cluster in clusters
        ]
        if not centers:
            return []
        default_half = max(_points_to_norm(self.cfg.row_fix.continuation_gap_points, page_height), 0.01)
        bounds: List[Tuple[float, float]] = []
        for idx, center in enumerate(centers):
            prev_center = centers[idx - 1] if idx > 0 else None
            next_center = centers[idx + 1] if idx + 1 < len(centers) else None
            lower = ranges[idx][0]
            upper = ranges[idx][1]
            if prev_center is not None:
                lower = (prev_center + center) / 2.0
            else:
                lower = center - default_half
            if next_center is not None:
                upper = (center + next_center) / 2.0
            else:
                upper = center + default_half
            lower = max(body_top, min(lower, ranges[idx][0]))
            upper = min(body_bottom, max(upper, ranges[idx][1]))
            if upper <= lower:
                upper = lower + max(default_half * 0.5, 0.005)
            bounds.append((lower, upper))

        row_bands = [RowBand(index=i, y0=low, y1=high, tokens=[]) for i, (low, high) in enumerate(bounds)]
        for tok in table_tokens:
            cy = _tok_center(tok)[1]
            assigned = None
            for idx, (low, high) in enumerate(bounds):
                if low - 1e-6 <= cy <= high + 1e-6:
                    assigned = idx
                    break
            if assigned is None:
                distances = [abs(cy - center) for center in centers]
                assigned = distances.index(min(distances))
            band = row_bands[assigned]
            band.tokens.append(tok)
            band.y0 = min(band.y0, _tok_top(tok))
            band.y1 = max(band.y1, _tok_bottom(tok))

        filtered = [band for band in row_bands if band.tokens]
        for idx, band in enumerate(filtered):
            band.index = idx
        return filtered

    def _cluster_rows(self, tokens: List[Dict[str, Any]], gap_norm: float) -> List[RowBand]:
        bands: List[RowBand] = []
        current: Optional[RowBand] = None
        for tok in tokens:
            top = _tok_top(tok)
            bottom = _tok_bottom(tok)
            if current is None:
                current = RowBand(index=0, y0=top, y1=bottom, tokens=[tok])
                continue
            gap = top - current.y1
            if gap > gap_norm:
                bands.append(current)
                current = RowBand(index=current.index + 1, y0=top, y1=bottom, tokens=[tok])
            else:
                current.tokens.append(tok)
                current.y1 = max(current.y1, bottom)
        if current is not None:
            bands.append(current)
        return bands

    def _assign_tokens_to_columns(self, row_bands: List[RowBand], columns: List[ColumnBand]) -> None:
        boundaries: List[float] = []
        for i in range(len(columns) - 1):
            boundaries.append((columns[i].x1 + columns[i + 1].x0) / 2.0)
        for row in row_bands:
            row.column_tokens = {col.index: [] for col in columns}
            for tok in row.tokens:
                cx = _tok_center(tok)[0]
                col_idx = None
                for i, boundary in enumerate(boundaries):
                    if cx < boundary:
                        col_idx = columns[i].index
                        break
                if col_idx is None:
                    col_idx = columns[-1].index
                row.column_tokens[col_idx].append(tok)
            self._fold_placeholder_columns(row.column_tokens, columns)
            row.has_numeric = any(self._tokens_have_numeric(row.column_tokens.get(col.index, [])) for col in columns if col.name.upper() in NUMERIC_FAMILIES)

    def _refine_numeric_columns(self, columns: List[ColumnBand], row_bands: List[RowBand], page_height: float, table_bbox: Dict[str, Any]) -> None:
        numeric_cols = [col for col in columns if col.name.upper() in NUMERIC_FAMILIES]
        if not numeric_cols:
            return
        threshold = float(table_bbox.get("x0", 0.0)) + (float(table_bbox.get("x1", 1.0)) - float(table_bbox.get("x0", 0.0))) * NUMERIC_X_THRESHOLD_FRACTION
        tol = _points_to_norm(self.cfg.row_fix.numeric_band_tolerance_points, page_height or 1.0)
        candidates: List[Dict[str, float]] = []
        for row in row_bands:
            for tok in row.tokens:
                text = _token_text(tok).strip()
                if not text:
                    continue
                simple = text.replace(" ", "").replace("(", "").replace(")", "")
                if not NUMERIC_ANCHOR_RE.fullmatch(simple):
                    continue
                cx = _tok_center(tok)[0]
                if cx < threshold:
                    continue
                candidates.append({"right": _tok_right(tok), "left": _tok_left(tok)})
        if not candidates:
            return
        candidates.sort(key=lambda item: item["right"])
        clusters: List[Dict[str, List[float]]] = []
        for item in candidates:
            right = item["right"]
            left = item["left"]
            if not clusters:
                clusters.append({"rights": [right], "lefts": [left]})
                continue
            last = clusters[-1]
            if abs(right - last["rights"][-1]) <= tol:
                last["rights"].append(right)
                last["lefts"].append(left)
            else:
                clusters.append({"rights": [right], "lefts": [left]})
        if not clusters:
            return
        numeric_cols_sorted = sorted(numeric_cols, key=lambda c: c.x0)
        if len(clusters) != len(numeric_cols_sorted):
            return
        for col, cluster in zip(numeric_cols_sorted, clusters):
            rights = cluster["rights"]
            lefts = cluster["lefts"]
            new_x1 = sum(rights) / len(rights)
            new_x0 = min([col.x0] + lefts)
            col.x0 = max(0.0, new_x0)
            col.x1 = min(1.0, new_x1)
        columns.sort(key=lambda c: c.x0)

    def _tokens_have_numeric(self, toks: List[Dict[str, Any]]) -> bool:
        for tok in toks:
            txt = _token_text(tok)
            if any(ch.isdigit() for ch in txt):
                return True
        return False

    def _fold_placeholder_columns(self, column_tokens: Dict[int, List[Dict[str, Any]]], columns: List[ColumnBand]) -> None:
        for idx, col in enumerate(columns):
            name = col.name.upper()
            if not name.startswith("COL"):
                continue
            moved = False
            if idx > 0:
                left = columns[idx - 1]
                if left.name.upper() in {"QTY", "UNIT_PRICE", "DISCOUNT"}:
                    column_tokens.setdefault(left.index, []).extend(column_tokens.get(col.index, []))
                    moved = True
            if not moved and idx + 1 < len(columns):
                right = columns[idx + 1]
                if right.name.upper() in {"UNIT_PRICE", "DISCOUNT", "TOTAL_PRICE", "TOTAL", "AMOUNT"}:
                    column_tokens.setdefault(right.index, []).extend(column_tokens.get(col.index, []))
                    moved = True
            if moved:
                column_tokens[col.index] = []

    def _merge_continuations(self, rows: List[RowBand], columns: List[ColumnBand], gap_norm: float) -> List[RowBand]:
        merged: List[RowBand] = []
        last_kept: Optional[RowBand] = None
        numeric_cols = {col.index for col in columns if col.name.upper() in NUMERIC_FAMILIES}
        desc_cols = [col.index for col in columns if col.name.upper() not in NUMERIC_FAMILIES]
        for row in rows:
            if last_kept is None:
                merged.append(row)
                last_kept = row
                continue
            gap = row.y0 - last_kept.y1
            row_numeric = any(self._tokens_have_numeric(row.column_tokens.get(idx, [])) for idx in numeric_cols)
            if (not row_numeric) and gap <= gap_norm * 1.2:
                for idx in desc_cols:
                    last_kept.column_tokens.setdefault(idx, []).extend(row.column_tokens.get(idx, []))
                last_kept.tokens.extend(row.tokens)
                last_kept.y1 = max(last_kept.y1, row.y1)
                last_kept.merged_from.append(row.index)
                self.fix_report.append({
                    "type": "description_continuation",
                    "from_row": row.index,
                    "into": last_kept.index,
                })
            else:
                merged.append(row)
                last_kept = row
        return merged

    def _split_token_lines(self, toks: Iterable[Dict[str, Any]]) -> List[List[Tuple[float, str]]]:
        items: List[Tuple[float, float, str]] = []
        for tok in toks:
            txt = _token_text(tok)
            if not txt:
                continue
            items.append((_tok_top(tok), _tok_left(tok), txt))
        if not items:
            return []
        items.sort(key=lambda item: (item[0], item[1]))
        lines: List[List[Tuple[float, str]]] = []
        current_y: Optional[float] = None
        y_tol = 0.003
        for y, x, txt in items:
            if current_y is None or abs(y - current_y) > y_tol:
                lines.append([])
                current_y = y
            lines[-1].append((x, txt))
        for line in lines:
            line.sort(key=lambda item: item[0])
        return lines

    def _compose_text_from_lines(self, lines: List[List[Tuple[float, str]]]) -> Tuple[str, List[str]]:
        segments: List[str] = []
        for line in lines:
            text = " ".join(token for _, token in line if token)
            text = " ".join(text.split())
            if text:
                segments.append(text)
        joined = " ".join(segments).strip()
        if not joined:
            return "", []
        cleaned = self._clean_text(joined)
        return cleaned, segments

    def _clean_text(self, text: str) -> str:
        text = re.sub(r"\s+([,.;:])", r"\1", text)
        text = re.sub(r"\(\s+", "(", text)
        text = re.sub(r"\s+\)", ")", text)
        text = re.sub(r"(?<=\()([0-9]+)\s+([A-Z])", r"\1\2", text)
        text = re.sub(r"\s{2,}", " ", text)
        return text.strip()

    def _normalize_part_ref(self, text: str) -> str:
        return re.sub(r"\s+", "", text or "")

    def _looks_like_part_number(self, text: str) -> bool:
        candidate = self._normalize_part_ref(text)
        if not candidate:
            return False
        for pattern in self.partno_regexes:
            if pattern.fullmatch(candidate):
                return True
        return bool(re.fullmatch(r"[0-9]{6,}", candidate))

    def _line_is_part_number(self, line: List[Tuple[float, str]]) -> bool:
        texts = [token for _, token in line if token]
        if not texts:
            return False
        return all(self._looks_like_part_number(token) for token in texts)

    def _join_tokens(self, toks: Iterable[Dict[str, Any]]) -> str:
        lines = self._split_token_lines(toks)
        text, _ = self._compose_text_from_lines(lines)
        return text

    def _build_cells_from_rows(self, rows: List[RowBand], columns: List[ColumnBand]) -> List[Dict[str, Any]]:
        out_rows: List[Dict[str, Any]] = []
        for idx, row in enumerate(rows):
            cells = []
            column_meta: Dict[int, Dict[str, Any]] = {}
            for col in columns:
                toks = row.column_tokens.get(col.index, [])
                lines = self._split_token_lines(toks)
                text, segments = self._compose_text_from_lines(lines)
                cell_entry = {
                    "col": col.index,
                    "name": col.name,
                    "bbox": {"x0": col.x0, "y0": row.y0, "x1": col.x1, "y1": row.y1},
                    "text": text,
                }
                cells.append(cell_entry)
                column_meta[col.index] = {
                    "lines": lines,
                    "segments": segments,
                    "tokens": toks,
                }
            article_cell = next((cell for cell in cells if cell["name"].upper() in {"ARTICLE", "ARTICLE_NO", "ARTICLE NO", "SKU", "CODE"}), None)
            desc_cell = next((cell for cell in cells if cell["name"].upper() in {"ITEM", "ITEM NAME", "DESCRIPTION", "ITEM_DESCRIPTION", "ITEM DESCRIPTION", "DESC"}), None)
            if article_cell and desc_cell and not article_cell.get("text") and desc_cell.get("text"):
                for pattern in self.partno_regexes:
                    match = pattern.search(desc_cell["text"])
                    if match:
                        article_cell["text"] = match.group(0).strip()
                        before = desc_cell["text"][: match.start()].strip()
                        after = desc_cell["text"][match.end():].strip()
                        desc_cell["text"] = " ".join(x for x in [before, after] if x)
                        break
            if article_cell and desc_cell and desc_cell.get("text"):
                meta = column_meta.get(desc_cell["col"])
                lines = meta.get("lines") if meta else None
                if lines:
                    last_line = lines[-1]
                    if last_line and self._line_is_part_number(last_line):
                        article_norm = self._normalize_part_ref(article_cell.get("text", ""))
                        line_norm = self._normalize_part_ref("".join(token for _, token in last_line))
                        if article_norm and article_norm == line_norm:
                            remaining_segments = (meta.get("segments") or [])
                            if remaining_segments:
                                remaining_segments = remaining_segments[:-1]
                                new_text = self._clean_text(" ".join(remaining_segments)) if remaining_segments else ""
                                desc_cell["text"] = new_text
            out_rows.append({"index": idx, "cells": cells, "y0": row.y0, "y1": row.y1})
        return out_rows

    def _parse_number(self, text: str) -> Optional[Decimal]:
        if text is None:
            return None
        s = text.strip()
        if not s:
            return None
        negative = False
        if s.startswith("(") and s.endswith(")"):
            negative = True
            s = s[1:-1]
        s = s.replace(" ", "")
        if s.startswith("-"):
            negative = True
            s = s[1:]
        if not any(ch.isdigit() for ch in s):
            return None
        if "," in s and "." in s:
            # assume dot thousands, comma decimals
            s = s.replace(".", "")
            s = s.replace(",", ".")
        elif "," not in s and "." in s:
            parts = s.split(".")
            if len(parts) > 1 and all(len(part) == 3 for part in parts[1:]):
                s = "".join(parts)
            elif s.count(".") >= 2:
                s = s.replace(".", "")
        elif "." not in s and s.count(",") >= 2:
            s = s.replace(",", "")
        elif "." not in s and s.count(",") == 1:
            s = s.replace(",", ".")
        try:
            val = Decimal(s)
        except InvalidOperation:
            return None
        if negative:
            val = -val
        return val

    def _run_arithmetic(self, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        abs_tol = Decimal(str(self.cfg.row_fix.arithmetic_abs_tol))
        rel_tol = Decimal(str(self.cfg.row_fix.arithmetic_rel_tol))
        row_results = []
        totals = Decimal("0")
        for row in rows:
            cells = {cell["name"].upper(): cell for cell in row["cells"]}
            qty = self._parse_number(cells.get("QTY", {}).get("text"))
            price = self._parse_number(cells.get("UNIT_PRICE", {}).get("text"))
            discount = self._parse_number(cells.get("DISCOUNT", {}).get("text")) or Decimal("0")
            total = self._parse_number(cells.get("TOTAL_PRICE", {}).get("text"))
            if total is None and self._parse_number(cells.get("TOTAL", {}).get("text")) is not None:
                total = self._parse_number(cells.get("TOTAL", {}).get("text"))
            if qty is None or price is None or total is None:
                row_results.append({"row": row["index"], "status": "skipped"})
                continue
            expected = qty * price - discount
            diff = expected - total
            tolerance = max(abs_tol, (abs(expected) * rel_tol).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))
            ok = abs(diff) <= tolerance
            row_results.append({
                "row": row["index"],
                "qty": str(qty),
                "unit_price": str(price),
                "discount": str(discount),
                "total": str(total),
                "diff": str(diff),
                "tolerance": str(tolerance),
                "ok": ok,
            })
            if ok:
                totals += total
        return {"rows": row_results, "sum_line_totals": str(totals)}

    def _check_subtotal(self, arithmetic_result: Dict[str, Any]) -> Dict[str, Any]:
        try:
            sum_total = Decimal(arithmetic_result.get("sum_line_totals", "0"))
        except InvalidOperation:
            sum_total = Decimal("0")
        printed = self._find_printed_subtotal()
        if printed is None:
            return {"status": "missing"}
        abs_tol = Decimal(str(self.cfg.row_fix.subtotal_abs_tol))
        rel_tol = Decimal(str(self.cfg.row_fix.subtotal_rel_tol))
        tolerance = max(abs_tol, abs(printed) * rel_tol)
        diff = printed - sum_total
        ok = abs(diff) <= tolerance
        return {
            "status": "ok" if ok else "mismatch",
            "printed": str(printed),
            "sum": str(sum_total),
            "diff": str(diff),
            "tolerance": str(tolerance),
        }

    def _find_printed_subtotal(self) -> Optional[Decimal]:
        for page_no, tokens in self.tokens_by_page.items():
            clusters = self._cluster_rows(sorted(tokens, key=lambda t: (_tok_top(t), _tok_left(t))), 0.01)
            for row in clusters:
                words = [(_token_text(tok) or "").strip().casefold() for tok in row.tokens if _token_text(tok)]
                if not words:
                    continue
                joined = " ".join(words)
                if "subtotal" in joined or ("sub" in words and "total" in words):
                    numbers = [self._parse_number(_token_text(tok)) for tok in row.tokens]
                    numbers = [n for n in numbers if n is not None]
                    if numbers:
                        return max(numbers)
        return None

    def dump_debug(self, out_path: Path, doc_id: Optional[str]) -> None:
        debug_dir = out_path.parent / "row_fix_debug"
        debug_dir.mkdir(parents=True, exist_ok=True)
        (debug_dir / "columns_bands.json").write_text(json.dumps(self.debug_columns, ensure_ascii=False, indent=2), encoding="utf-8")
        (debug_dir / "row_bands.json").write_text(json.dumps(self.debug_rows, ensure_ascii=False, indent=2), encoding="utf-8")
        (debug_dir / "fix_report.json").write_text(json.dumps(self.fix_report, ensure_ascii=False, indent=2), encoding="utf-8")
        (debug_dir / "after_vs_before.json").write_text(json.dumps(self.after_vs_before, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def build_cells(pdf_path: Path, tokens_path: Path, out_path: Path, config_path: Path) -> Dict[str, Any]:
    cfg = _validate_config(json.loads(config_path.read_text(encoding="utf-8")))
    tokens = load_tokens(tokens_path)
    base_tables = build_base_tables(pdf_path, tokens_path, out_path, cfg, tokens)

    final_tables = base_tables
    fixer = None
    if cfg.row_fix.enabled:
        fixer = RowFixer(cfg, config_path, tokens, base_tables)
        final_tables = fixer.apply()

    pages_out = []
    for table in final_tables:
        pages_out.append({
            "page": table.page,
            "flavor_used": table.flavor,
            "table": {
                "bbox": table.bbox,
                "header_row_index": table.header_row_index,
                "header_cells": table.header_cells,
                "rows": table.rows,
            },
        })

    out = {
        "doc_id": tokens.doc_id,
        "stage": "camelot_grid",
        "version": "2.0-rowfix",
        "pages": pages_out,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    summary = {
        "stage": "camelot_grid_rowfix",
        "doc_id": tokens.doc_id,
        "pages": [
            {
                "page": p.get("page"),
                "rows": len(p.get("table", {}).get("rows", [])),
                "header_idx": p.get("table", {}).get("header_row_index"),
                "cols": len(p.get("table", {}).get("header_cells", [])),
                "flavor": p.get("flavor_used"),
            }
            for p in pages_out
        ],
    }
    print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))

    if fixer and cfg.row_fix.debug_dump:
        fixer.dump_debug(out_path, tokens.doc_id)

    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 4 + 4.5 Camelot grid with deterministic row fixer")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--tokens", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--tokenizer", required=False, help="Token source identifier (ignored; kept for compatibility)")
    args = ap.parse_args()

    build_cells(
        Path(args.pdf).resolve(),
        Path(args.tokens).resolve(),
        Path(args.out).resolve(),
        Path(args.config).resolve(),
    )


if __name__ == "__main__":
    main()
