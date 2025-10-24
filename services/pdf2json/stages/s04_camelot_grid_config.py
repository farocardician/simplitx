#!/usr/bin/env python3
from __future__ import annotations
"""Stage 4 + 4.5 — Camelot grid with deterministic row fixer.

This stage now ranks Camelot candidates with an anchor-guided band that is
configured per vendor. The s04 config exposes two tuning blocks:

- ``items_region`` defines how to locate the line-item band via start/end
  anchors, optional margins, and a minimal height fallback.
- ``ranking`` adjusts feature weights (header hits, overlap, numeric-right,
  row count, totals-below), controls the ROI experiment, and limits
  candidates.

The chosen table per page is still emitted in ``s04`` format. A sidecar file
``candidate_ranking.json`` captures every scored candidate along with the
band that drove the decision so downstream reviewers can trace outcomes.
"""

import argparse
import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from statistics import median
from typing import Any, Dict, Iterable, List, Optional, Tuple, Pattern

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


def _trim_numeric_tail(text: str) -> str:
    if not text:
        return text
    match = NUMERIC_TOKEN_RE.search(text)
    if not match:
        return text.strip()
    start = match.start()
    end = match.end()
    prefix_start = start
    if start > 0 and text[start - 1] == "(":
        prefix_start = start - 1
        closing = text.find(")", end)
        if closing != -1:
            end = closing + 1
    # Include trailing unit tokens (e.g., "KG", "PCS", "IDR") if present
    suffix = text[end:]
    if suffix:
        unit_match = re.match(r"(?:\s*/?\s*[A-Z]{1,6})+", suffix)
        if unit_match and unit_match.group(0).strip():
            end += unit_match.end()
    return text[prefix_start:end].strip()


def _strip_alias_prefix(text: str, aliases: Iterable[str]) -> str:
    if not text:
        return text
    stripped = text.lstrip()
    leading = len(text) - len(stripped)
    for alias in aliases:
        alias_norm = (alias or "").strip()
        if not alias_norm:
            continue
        pattern = r"^(?:" + re.escape(alias_norm) + r")(?:\s*[:.\-])?\s+"
        if re.match(pattern, stripped, flags=re.IGNORECASE):
            stripped = re.sub(pattern, "", stripped, count=1, flags=re.IGNORECASE)
            break
    return (" " * leading) + stripped


def _strip_overlap_prefix(prev_text: str, curr_text: str) -> str:
    prev = (prev_text or "").strip()
    curr = (curr_text or "").strip()
    if not prev or not curr:
        return curr
    prev_tokens = prev.split()
    curr_lower = curr.casefold()
    for cut in range(len(prev_tokens), 0, -1):
        candidate = " ".join(prev_tokens[-cut:]).strip()
        if len(candidate) < 4:
            continue
        cand_lower = candidate.casefold()
        if curr_lower.startswith(cand_lower):
            trimmed = curr[len(candidate):].lstrip(" -,:;")
            return trimmed or curr
    return curr


def _cleanup_description(text: Optional[str]) -> str:
    value = (text or "").strip()
    if not value:
        return ""
    return value


def _is_repeat_header_row(texts: List[str], col_map: List[str], prefix_map: Dict[str, List[str]]) -> bool:
    hits = 0
    total = 0
    numeric_hits = 0
    numeric_total = 0
    for text, col_name in zip(texts, col_map):
        if not text:
            continue
        total += 1
        col_upper = (col_name or "").upper()
        if col_upper in NUMERIC_FAMILIES:
            numeric_total += 1
            if not any(ch.isdigit() for ch in text):
                numeric_hits += 1
            continue
        prefixes = prefix_map.get(col_upper, [])
        canon_text = _canon(text)
        if prefixes and any(canon_text.startswith(_canon(alias)) for alias in prefixes):
            hits += 1
    if total == 0:
        return False
    if numeric_total and numeric_hits == numeric_total and (hits + numeric_hits) >= max(2, total - 1):
        return True
    return False


def _split_trailing_fragment(text: Optional[str]) -> Tuple[str, Optional[str]]:
    value = (text or "").strip()
    if not value:
        return "", None
    match = re.search(r"\b([A-Z][A-Z/&()\-\s]{3,})$", value)
    if not match:
        return value, None
    fragment = match.group(1).strip()
    head = value[: match.start(1)].rstrip()
    if not head or not fragment:
        return value, None
    if any(ch.isdigit() for ch in fragment) and fragment.casefold() == fragment.lower():
        return value, None
    return head, fragment


# ---------------------------------------------------------------------------
# Configuration structures
# ---------------------------------------------------------------------------


NUMERIC_FAMILIES = {"QTY", "UNIT_PRICE", "DISCOUNT", "TOTAL_PRICE", "TOTAL", "AMOUNT"}
NUMERIC_ANCHOR_RE = re.compile(r"^[0-9][0-9.,]*$")
NUMERIC_X_THRESHOLD_FRACTION = 0.45
NUMERIC_TOKEN_RE = re.compile(r"-?\d[\d.,]*")
DESC_FAMILIES = {"ITEM", "ITEM_NAME", "ITEM NAME", "DESCRIPTION", "ITEM_DESCRIPTION", "ITEM DESCRIPTION", "DESC"}


@dataclass
class CamelotConfig:
    flavor_order: List[str]
    lattice_line_scale: int
    stream_row_tol: Optional[float]
    stream_line_scale: Optional[int]


@dataclass
class ItemsRegionConfig:
    detect_by: str = "anchors"
    start_patterns: List[str] = field(default_factory=list)
    end_patterns: List[str] = field(default_factory=list)
    ignore_case: bool = True
    select: str = "next_below"
    x_policy: str = "full"
    margin_top: float = 0.01
    margin_bottom: float = 0.02
    margin_left: float = 0.0
    margin_right: float = 0.0
    min_height: float = 0.25


@dataclass
class RankingConfig:
    weights: Dict[str, float] = field(default_factory=dict)
    overlap_threshold: float = 0.2
    max_candidates: int = 6
    use_items_roi: bool = True


@dataclass
class ColumnOverrideRule:
    match_index: Optional[int] = None
    match_name_regex: Optional[Pattern[str]] = None
    match_text_regex: Optional[Pattern[str]] = None
    set_name: Optional[str] = None
    set_text: Optional[str] = None

    def matches(self, column: "ColumnBand", header_texts: Iterable[str]) -> bool:
        if self.match_index is not None and column.index != self.match_index:
            return False

        if self.match_name_regex is not None:
            names = [n for n in (column.name, getattr(column, "original_name", None)) if n]
            if not any(self.match_name_regex.search(name) for name in names):
                return False

        if self.match_text_regex is not None:
            texts = [t for t in header_texts if t]
            if not any(self.match_text_regex.search(text) for text in texts):
                return False

        return True


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
    column_overrides: List[ColumnOverrideRule] = field(default_factory=list)


@dataclass
class StopDecision:
    rule: str = "none"
    stop_index: int = 0
    clip_y: Optional[float] = None


@dataclass
class TemplateConfig:
    header_aliases: Dict[str, List[str]]
    totals_keywords: List[str]
    camelot: CamelotConfig
    items_region: ItemsRegionConfig
    ranking: RankingConfig
    stop_after_totals: bool
    page_stop_keywords: Dict[int, List[str]]
    page_row_limit: Dict[int, int]
    row_fix: RowFixOptions
    token_engine: str


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

    override_rules: List[ColumnOverrideRule] = []
    for entry in row_fix_cfg.get("column_overrides", []) or []:
        if not isinstance(entry, dict):
            continue
        match_cfg = entry.get("match") or {}
        if not match_cfg:
            simple_match = {k: entry.get(k) for k in ("name", "header_name", "text", "header_text", "index") if entry.get(k) is not None}
            match_cfg = simple_match
        if not isinstance(match_cfg, dict):
            match_cfg = {}
        set_cfg = entry.get("set") or entry.get("assign") or {}
        if not set_cfg:
            simple_set = {}
            if entry.get("set_name") is not None:
                simple_set["name"] = entry.get("set_name")
            if entry.get("rename") is not None:
                simple_set["name"] = entry.get("rename")
            if entry.get("new_name") is not None:
                simple_set["name"] = entry.get("new_name")
            if entry.get("set_text") is not None:
                simple_set["text"] = entry.get("set_text")
            if entry.get("text_to") is not None:
                simple_set["text"] = entry.get("text_to")
            if entry.get("rename_text") is not None:
                simple_set["text"] = entry.get("rename_text")
            set_cfg = simple_set
        if not isinstance(set_cfg, dict):
            set_cfg = {}

        if not set_cfg.get("name") and set_cfg.get("text") is None:
            continue

        match_index = None
        try:
            if match_cfg.get("index") is not None:
                match_index = int(match_cfg.get("index"))
        except Exception:
            match_index = None

        def _compile_regex(value: Any) -> Optional[Pattern[str]]:
            if value is None:
                return None
            try:
                return re.compile(str(value), re.IGNORECASE)
            except re.error:
                return None

        match_name_regex = _compile_regex(match_cfg.get("name") or match_cfg.get("header_name"))
        match_text_regex = _compile_regex(match_cfg.get("text") or match_cfg.get("header_text"))
        set_name = set_cfg.get("name")
        if isinstance(set_name, str):
            set_name = set_name.strip() or None
        else:
            set_name = str(set_name).strip() if set_name is not None else None
        set_text = set_cfg.get("text")
        if set_text is not None:
            set_text = str(set_text)

        if not set_name and set_text is None:
            continue

        override_rules.append(
            ColumnOverrideRule(
                match_index=match_index,
                match_name_regex=match_name_regex,
                match_text_regex=match_text_regex,
                set_name=set_name,
                set_text=set_text,
            )
        )

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
        column_overrides=override_rules,
    )

    region_cfg_raw = cfg.get("items_region") or {}
    region_detect = (region_cfg_raw.get("detect") or {})
    detect_by = str(region_detect.get("by") or region_cfg_raw.get("detect_by") or "anchors").strip().lower()
    start_patterns = [str(p) for p in (region_cfg_raw.get("start_anchor") or {}).get("patterns", []) if p]
    end_patterns = [str(p) for p in (region_cfg_raw.get("end_anchor") or {}).get("patterns", []) if p]
    flags_cfg = region_cfg_raw.get("flags") or {}
    ignore_case = bool(flags_cfg.get("ignore_case", True))
    select_val = str((region_cfg_raw.get("end_anchor") or {}).get("select") or region_cfg_raw.get("select") or "next_below").strip().lower()
    x_policy = str(region_cfg_raw.get("x_policy") or "full").strip().lower()
    margin_cfg = region_cfg_raw.get("margin") or {}
    def _get_margin(name: str, default: float) -> float:
        try:
            return float(margin_cfg.get(name, default))
        except Exception:
            return default
    margin_top = max(0.0, _get_margin("top", 0.01))
    margin_bottom = max(0.0, _get_margin("bottom", 0.02))
    margin_left = max(0.0, _get_margin("left", 0.0))
    margin_right = max(0.0, _get_margin("right", 0.0))
    try:
        min_height = float(region_cfg_raw.get("min_height", 0.25))
    except Exception:
        min_height = 0.25
    min_height = max(0.05, min_height)

    items_region = ItemsRegionConfig(
        detect_by=detect_by,
        start_patterns=start_patterns,
        end_patterns=end_patterns,
        ignore_case=ignore_case,
        select=select_val,
        x_policy=x_policy,
        margin_top=margin_top,
        margin_bottom=margin_bottom,
        margin_left=margin_left,
        margin_right=margin_right,
        min_height=min_height,
    )

    ranking_cfg_raw = cfg.get("ranking") or {}
    default_weights = {
        "header": 3.0,
        "overlap_items_region": 2.0,
        "numeric_right": 1.0,
        "rows": 1.0,
        "totals_below": 0.5,
    }
    weights_raw = ranking_cfg_raw.get("weights") or {}
    weights: Dict[str, float] = {}
    for key, default_val in default_weights.items():
        try:
            weights[key] = float(weights_raw.get(key, default_val))
        except Exception:
            weights[key] = default_val
    for key, value in weights_raw.items():
        if key in weights:
            continue
        try:
            weights[key] = float(value)
        except Exception:
            continue
    try:
        overlap_threshold = float(ranking_cfg_raw.get("overlap_threshold", 0.2))
    except Exception:
        overlap_threshold = 0.2
    overlap_threshold = max(0.0, overlap_threshold)
    try:
        max_candidates = int(ranking_cfg_raw.get("max_candidates", 6))
    except Exception:
        max_candidates = 6
    if max_candidates < 0:
        max_candidates = 0
    ranking = RankingConfig(
        weights=weights,
        overlap_threshold=overlap_threshold,
        max_candidates=max_candidates,
        use_items_roi=bool(ranking_cfg_raw.get("use_items_roi", True)),
    )

    token_cfg = cfg.get("tokens") or {}
    token_engine = token_cfg.get("engine") if isinstance(token_cfg, dict) else None
    if not token_engine:
        token_engine = cfg.get("token_engine")
    if not isinstance(token_engine, str):
        token_engine = "plumber"
    token_engine = token_engine.strip().lower()
    if token_engine not in {"plumber", "pymupdf", "combined"}:
        token_engine = "plumber"

    return TemplateConfig(
        header_aliases={str(k): list(v or []) for k, v in cfg["header_aliases"].items()},
        totals_keywords=list(cfg["totals_keywords"]),
        camelot=CamelotConfig(
            flavor_order=list(camelot_cfg["flavor_order"]),
            lattice_line_scale=int(camelot_cfg.get("line_scale", 40)),
            stream_row_tol=(camelot_cfg.get("row_tol_stream") if camelot_cfg.get("row_tol_stream") is not None else None),
            stream_line_scale=(int(camelot_cfg.get("line_scale_stream")) if camelot_cfg.get("line_scale_stream") is not None else None),
        ),
        items_region=items_region,
        ranking=ranking,
        stop_after_totals=stop_after_totals,
        page_stop_keywords=page_stop_keywords,
        page_row_limit=page_row_limit,
        row_fix=row_fix,
        token_engine=token_engine,
    )


# ---------------------------------------------------------------------------
# Token loading helpers
# ---------------------------------------------------------------------------


@dataclass
class TokensData:
    doc_id: Optional[str]
    tokens: List[Dict[str, Any]]
    page_meta: Dict[int, Tuple[float, float]]
    engine: str = "plumber"


def load_tokens(tokens_path: Path, preferred_engine: Optional[str] = None) -> TokensData:
    try:
        raw = json.loads(tokens_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Failed to read tokens file: {exc}")

    engine_used = "plumber"
    tokens: Optional[List[Dict[str, Any]]] = None

    if isinstance(raw.get("tokens"), list):
        tokens = raw["tokens"]
        engine_used = "combined"

    def _engine_tokens(name: str) -> Optional[List[Dict[str, Any]]]:
        payload = raw.get(name)
        if isinstance(payload, dict):
            toks = payload.get("tokens")
            if isinstance(toks, list):
                return toks
        return None

    candidates: List[str] = []
    if preferred_engine:
        candidates.append(preferred_engine.strip().lower())
    candidates.extend(["plumber", "pymupdf"])

    seen: set[str] = set()
    candidates = [c for c in candidates if not (c in seen or seen.add(c))]

    if tokens is None:
        for candidate in candidates:
            toks = _engine_tokens(candidate)
            if toks:
                tokens = toks
                engine_used = candidate
                break

    if tokens is None:
        raise RuntimeError("Tokens JSON missing usable 'tokens' list")

    pages_meta = {}
    for entry in raw.get("pages", []):
        try:
            pn = int(entry.get("page"))
            pw = float(entry.get("width"))
            ph = float(entry.get("height"))
            pages_meta[pn] = (pw, ph)
        except Exception:
            continue

    return TokensData(doc_id=raw.get("doc_id"), tokens=tokens, page_meta=pages_meta, engine=engine_used)


def load_totals_guardrails(tokens_path: Path, totals_keywords: Iterable[str]) -> Dict[int, float]:
    s03_path = tokens_path.with_name("s03.json")
    if not s03_path.exists():
        return {}
    try:
        payload = json.loads(s03_path.read_text(encoding="utf-8"))
    except Exception:
        return {}

    totals_canon = [_canon(k) for k in totals_keywords if k]
    guardrails: Dict[int, float] = {}
    segments = payload.get("segments")
    if not isinstance(segments, list):
        return guardrails

    for seg in segments:
        if not isinstance(seg, dict):
            continue
        if seg.get("type") and str(seg.get("type")).lower() not in {"region", "cell"}:
            continue
        try:
            page = int(seg.get("page"))
        except Exception:
            continue
        bbox = seg.get("bbox")
        if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
            continue
        try:
            y0 = float(bbox[1])
            y1 = float(bbox[3])
        except Exception:
            continue
        top = min(y0, y1)
        if not (0.0 <= top <= 1.0):
            continue
        label = str(seg.get("label") or "")
        meta = seg.get("metadata") or {}
        anchor_text = str(meta.get("start_anchor") or meta.get("anchor") or "")
        haystack = _canon(label + " " + anchor_text)
        if haystack and any(tkn and tkn in haystack for tkn in totals_canon):
            current = guardrails.get(page)
            guardrails[page] = top if current is None else min(current, top)

    return guardrails


# ---------------------------------------------------------------------------
# Items region resolver
# ---------------------------------------------------------------------------


def _compile_patterns(patterns: List[str], ignore_case: bool) -> List[re.Pattern[str]]:
    flags = re.IGNORECASE if ignore_case else 0
    compiled: List[re.Pattern[str]] = []
    for pattern in patterns:
        try:
            compiled.append(re.compile(pattern, flags))
        except re.error:
            continue
    return compiled


def _cluster_tokens_by_line(tokens: List[Dict[str, Any]], tolerance: float = 0.004) -> List[Dict[str, Any]]:
    lines: List[Dict[str, Any]] = []
    if not tokens:
        return lines
    sorted_tokens = sorted(tokens, key=lambda t: (_tok_top(t), _tok_left(t)))
    for tok in sorted_tokens:
        cy = (_tok_top(tok) + _tok_bottom(tok)) / 2.0
        if not lines or abs(cy - lines[-1]["center"]) > tolerance:
            lines.append({
                "center": cy,
                "tokens": [tok],
                "y0": _tok_top(tok),
                "y1": _tok_bottom(tok),
            })
            continue
        line = lines[-1]
        line["tokens"].append(tok)
        line["y0"] = min(line["y0"], _tok_top(tok))
        line["y1"] = max(line["y1"], _tok_bottom(tok))
        line["center"] = (line["center"] * (len(line["tokens"]) - 1) + cy) / len(line["tokens"])
    for line in lines:
        texts = [(_token_text(tok) or "").strip() for tok in line["tokens"] if _token_text(tok)]
        normalized = " ".join(" ".join(texts).split())
        line["text"] = normalized
    return lines


def _resolve_items_band_for_page(page: int, tokens: List[Dict[str, Any]], cfg: ItemsRegionConfig) -> Optional[Dict[str, Any]]:
    if cfg.detect_by != "anchors" or not cfg.start_patterns:
        return None
    lines = _cluster_tokens_by_line(tokens)
    if not lines:
        return None
    start_regexes = _compile_patterns(cfg.start_patterns, cfg.ignore_case)
    end_regexes = _compile_patterns(cfg.end_patterns, cfg.ignore_case)
    if not start_regexes:
        return None

    start_candidates: List[Dict[str, Any]] = []
    for line in lines:
        text = line.get("text", "")
        start_hits = sum(1 for rgx in start_regexes if rgx.search(text))
        line["start_hits"] = start_hits
        line["end_hits"] = sum(1 for rgx in end_regexes if rgx.search(text)) if end_regexes else 0
        if start_hits:
            start_candidates.append(line)

    if not start_candidates:
        return None

    multi_hits = [ln for ln in start_candidates if ln.get("start_hits", 0) >= 2]
    if multi_hits:
        start_line = max(multi_hits, key=lambda ln: ln["center"])
    else:
        start_line = max(start_candidates, key=lambda ln: (ln.get("start_hits", 0), ln["center"]))

    end_line = None
    if end_regexes and start_line is not None:
        for line in lines:
            if line["center"] <= start_line["center"]:
                continue
            if line.get("end_hits"):
                end_line = line
                break

    tks = start_line.get("tokens", []) if start_line else []
    if not tks:
        return None
    start_bottom = max(_tok_bottom(tok) for tok in tks)
    start_top = min(_tok_top(tok) for tok in tks)
    header_pad = min(0.03, max(0.0, start_bottom - start_top))
    band_top_base = max(0.0, start_bottom - header_pad)
    band_top = band_top_base + cfg.margin_top
    small_margin = 0.01
    if end_line is not None:
        end_top = min(_tok_top(tok) for tok in end_line.get("tokens", []))
        band_bottom = end_top - cfg.margin_bottom
    else:
        band_bottom = start_bottom + cfg.min_height
    band_top = max(0.0, min(band_top, 1.0 - small_margin))
    band_bottom = max(band_top + 0.001, min(band_bottom, 1.0 - small_margin))
    if band_bottom - band_top < cfg.min_height:
        band_bottom = band_top + cfg.min_height
    band_bottom = min(band_bottom, 1.0 - small_margin)
    if band_bottom <= band_top:
        band_bottom = min(1.0 - small_margin, band_top + max(cfg.min_height, 0.05))

    if cfg.x_policy == "full":
        x0 = max(0.0, min(cfg.margin_left, 1.0))
        x1 = min(1.0, max(1.0 - cfg.margin_right, 0.0))
    else:
        x0 = max(0.0, min(cfg.margin_left, 1.0))
        x1 = min(1.0, max(1.0 - cfg.margin_right, 0.0))
    if x1 - x0 < 0.1:
        x0 = 0.0
        x1 = 1.0

    band = {
        "page": page,
        "x0": x0,
        "x1": x1,
        "y0": max(0.0, min(band_top, 1.0)),
        "y1": max(0.0, min(band_bottom, 1.0)),
        "start_anchor": {
            "text": start_line.get("text"),
            "y0": start_line.get("y0"),
            "y1": start_line.get("y1"),
            "hits": start_line.get("start_hits"),
        },
        "end_anchor": None,
    }
    if end_line is not None:
        band["end_anchor"] = {
            "text": end_line.get("text"),
            "y0": end_line.get("y0"),
            "y1": end_line.get("y1"),
            "hits": end_line.get("end_hits"),
        }
    return band


def resolve_items_regions(cfg: ItemsRegionConfig, tokens_by_page: Dict[int, List[Dict[str, Any]]]) -> Dict[int, Dict[str, Any]]:
    regions: Dict[int, Dict[str, Any]] = {}
    if cfg.detect_by != "anchors" or not cfg.start_patterns:
        return regions
    for page, toks in tokens_by_page.items():
        band = _resolve_items_band_for_page(page, toks, cfg)
        if band:
            regions[page] = band
    return regions


def band_to_table_area(band: Dict[str, Any], page_dims: Optional[Tuple[float, float]]) -> Optional[str]:
    if not band or not page_dims:
        return None
    pw, ph = page_dims
    if not pw or not ph:
        return None
    x0 = max(0.0, min(1.0, float(band.get("x0", 0.0)))) * pw
    x1 = max(0.0, min(1.0, float(band.get("x1", 1.0)))) * pw
    y0 = max(0.0, min(1.0, float(band.get("y0", 0.0))))
    y1 = max(0.0, min(1.0, float(band.get("y1", 1.0))))
    if x1 <= x0 or y1 <= y0:
        return None
    top = (1.0 - y0) * ph
    bottom = (1.0 - y1) * ph
    return f"{x0:.2f},{top:.2f},{x1:.2f},{bottom:.2f}"


def _clip_between(prev_bottom: Optional[float], boundary: float) -> float:
    boundary = max(0.0, min(1.0, boundary))
    if prev_bottom is None:
        return max(0.0, min(boundary - 0.001, boundary))
    prev_bottom = max(0.0, min(1.0, prev_bottom))
    if boundary <= prev_bottom:
        return min(1.0, prev_bottom + 0.002)
    midpoint = prev_bottom + (boundary - prev_bottom) * 0.5
    return max(0.0, min(midpoint, boundary - 0.001))


def apply_stop_rules(
    row_layouts: List[Dict[str, Any]],
    header_idx: int,
    data_start: int,
    default_stop: int,
    band: Optional[Dict[str, Any]],
    totals_guard: Optional[float],
    numeric_cols: Iterable[int],
) -> StopDecision:
    rows_count = len(row_layouts)
    header_bottom = row_layouts[header_idx]["y1"] if 0 <= header_idx < rows_count else 0.0

    def clamp_stop(idx: int) -> int:
        return max(data_start, min(idx, rows_count))

    numeric_cols = sorted({c for c in numeric_cols if isinstance(c, int) and c >= 0})
    decision = StopDecision(rule="none", stop_index=clamp_stop(default_stop), clip_y=None)

    anchor_y0 = None
    if band and isinstance(band, dict):
        end_anchor = band.get("end_anchor")
        if isinstance(end_anchor, dict):
            try:
                anchor_y0 = float(end_anchor.get("y0"))
            except Exception:
                anchor_y0 = None

    anchor_tol = 0.002
    if anchor_y0 is not None and anchor_y0 > header_bottom + 0.001:
        anchor_stop = None
        for idx in range(data_start, rows_count):
            row_info = row_layouts[idx]
            if row_info["y0"] >= anchor_y0 - anchor_tol or row_info["y1"] >= anchor_y0 - anchor_tol:
                anchor_stop = idx
                break
        if anchor_stop is None:
            anchor_stop = rows_count
        anchor_stop = clamp_stop(anchor_stop)
        prev_bottom = row_layouts[anchor_stop - 1]["y1"] if anchor_stop - 1 >= data_start else row_layouts[header_idx]["y1"]
        clip_y = _clip_between(prev_bottom, anchor_y0)
        return StopDecision(rule="end_anchor", stop_index=anchor_stop, clip_y=clip_y)

    if totals_guard is not None and totals_guard > header_bottom + 0.001:
        guard_tol = 0.0015
        guard_stop = None
        for idx in range(data_start, rows_count):
            row_info = row_layouts[idx]
            if row_info["y0"] >= totals_guard - guard_tol or row_info["y1"] >= totals_guard - guard_tol:
                guard_stop = idx
                break
        if guard_stop is None:
            guard_stop = rows_count
        guard_stop = clamp_stop(guard_stop)
        prev_bottom = row_layouts[guard_stop - 1]["y1"] if guard_stop - 1 >= data_start else row_layouts[header_idx]["y1"]
        clip_y = _clip_between(prev_bottom, totals_guard)
        return StopDecision(rule="totals_guard", stop_index=guard_stop, clip_y=clip_y)

    seen_numeric = False
    last_numeric_idx: Optional[int] = None
    note_idx: Optional[int] = None
    note_keywords = {"says", "description", "declare", "catatan", "note"}
    for idx in range(data_start, rows_count):
        texts = row_layouts[idx]["texts"]
        joined = _canon(" ".join(texts))
        has_digits = False
        if numeric_cols:
            for col in numeric_cols:
                if col < len(texts) and any(ch.isdigit() for ch in texts[col] or ""):
                    has_digits = True
                    break
        else:
            for cell_text in texts:
                if any(ch.isdigit() for ch in cell_text or ""):
                    has_digits = True
                    break
        if has_digits:
            seen_numeric = True
            last_numeric_idx = idx
            continue
        if seen_numeric and joined and any(keyword in joined for keyword in note_keywords):
            note_idx = idx
            break
        if not seen_numeric:
            continue

    if note_idx is not None:
        stop_idx = clamp_stop(min(note_idx, default_stop))
        prev_idx = max(data_start, stop_idx - 1)
        prev_bottom = row_layouts[prev_idx]["y1"] if prev_idx < rows_count else row_layouts[header_idx]["y1"]
        boundary = row_layouts[stop_idx]["y0"] if stop_idx < rows_count else prev_bottom + 0.01
        clip_y = _clip_between(prev_bottom, boundary)
        return StopDecision(rule="numeric_fallback", stop_index=stop_idx, clip_y=clip_y)

    if last_numeric_idx is None:
        stop_idx = clamp_stop(default_stop)
        return StopDecision(rule="numeric_fallback", stop_index=stop_idx, clip_y=None)

    stop_idx = clamp_stop(min(last_numeric_idx + 1, default_stop))
    return StopDecision(rule="numeric_fallback", stop_index=stop_idx, clip_y=None)


# ---------------------------------------------------------------------------
# Camelot runner — geometry first
# ---------------------------------------------------------------------------


def run_camelot_tables(
    pdf_path: Path,
    cfg: TemplateConfig,
    tokens: TokensData,
    table_areas: Optional[Dict[int, str]] = None,
    fallback_on_empty: bool = False,
) -> Dict[int, List[Tuple[Any, str, str]]]:
    import camelot  # type: ignore

    flavor_order = cfg.camelot.flavor_order
    lattice_ls = cfg.camelot.lattice_line_scale
    stream_row_tol = cfg.camelot.stream_row_tol
    stream_line_scale = cfg.camelot.stream_line_scale

    def safe_read_page(flavor: str, page: int, areas: Optional[List[str]]):
        try:
            if flavor == "lattice":
                kwargs: Dict[str, Any] = {"line_scale": lattice_ls}
                if areas:
                    kwargs["table_areas"] = areas
                return camelot.read_pdf(str(pdf_path), pages=str(page), flavor="lattice", **kwargs)
            if flavor == "stream":
                kwargs = {}
                # Priority: use line_scale if specified (Simon-style), otherwise use row_tol (Rittal-style)
                if stream_line_scale is not None:
                    kwargs["line_scale"] = stream_line_scale
                elif stream_row_tol is not None:
                    kwargs["row_tol"] = stream_row_tol
                if areas:
                    kwargs["table_areas"] = areas
                return camelot.read_pdf(str(pdf_path), pages=str(page), flavor="stream", **kwargs)
            return []
        except Exception:
            return []

    by_page: Dict[int, List[Tuple[Any, str, str]]] = {}
    pages = sorted({int(t["page"]) for t in tokens.tokens})
    for page_no in pages:
        tables: List[Tuple[Any, str, str]] = []
        area = table_areas.get(page_no) if table_areas else None
        if area:
            for flavor in flavor_order:
                got = safe_read_page(flavor, page_no, [area]) or []
                for tb in got:
                    tables.append((tb, flavor, "roi"))
            if tables or not fallback_on_empty:
                by_page[page_no] = tables
                continue
            tables = []
        for flavor in flavor_order:
            got = safe_read_page(flavor, page_no, None) or []
            for tb in got:
                tables.append((tb, flavor, "full" if area else "default"))
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

    totals_guardrails = load_totals_guardrails(tokens_path, cfg.totals_keywords)
    items_regions = resolve_items_regions(cfg.items_region, by_page_tokens)
    table_areas: Dict[int, str] = {}
    if cfg.ranking.use_items_roi:
        for page, band in items_regions.items():
            area = band_to_table_area(band, tokens.page_meta.get(page))
            if area:
                table_areas[page] = area

    tables_by_page = run_camelot_tables(
        pdf_path,
        cfg,
        tokens,
        table_areas=table_areas if table_areas else None,
        fallback_on_empty=bool(table_areas),
    )

    family_of_header = _build_family_matcher(cfg.header_aliases)
    header_prefix_map: Dict[str, List[str]] = {}
    for fam, aliases in cfg.header_aliases.items():
        values = [a for a in aliases if a]
        values.append(fam)
        uniq = {v.strip() for v in values if v and v.strip()}
        header_prefix_map[fam.upper()] = sorted(uniq, key=lambda s: (-len(s), s.lower()))
    totals_keys = {_canon(k) for k in cfg.totals_keywords if k}
    totals_pattern_seed = [k for k in cfg.totals_keywords if k]
    totals_pattern_seed.extend(cfg.items_region.end_patterns)
    totals_regexes = _compile_patterns(list(dict.fromkeys(totals_pattern_seed)), True)

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

    def analyze_candidate(
        tb,
        flavor: str,
        source: str,
        page_no: int,
        page_tokens: List[Dict[str, Any]],
        band: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        pw, ph = get_page_dims(tb, page_no)
        if not pw or not ph:
            return None
        try:
            rows, cols = tb.shape
        except Exception:
            return None
        if rows <= 0 or cols <= 0:
            return None

        row_cache: Dict[int, List[str]] = {}

        def row_text_cached(idx: int) -> List[str]:
            if idx not in row_cache:
                row_cache[idx] = row_text(tb, idx, page_no, pw, ph, page_tokens)
            return row_cache[idx]

        row_layouts: List[Dict[str, Any]] = []
        for r in range(rows):
            texts = row_text_cached(r)
            row_min = float("inf")
            row_max = 0.0
            for c in range(cols):
                x0, y0, x1, y1 = get_cell_bbox(tb, r, c, pw, ph)
                row_min = min(row_min, y0)
                row_max = max(row_max, y1)
            if row_min == float("inf"):
                row_min = 0.0
            row_layouts.append({"index": r, "texts": texts, "y0": row_min, "y1": row_max})

        best_idx: Optional[int] = None
        best_decision: Optional[StopDecision] = None
        best_score = (-1, -1)
        best_fam_hits: set = set()
        row_candidates: List[Dict[str, Any]] = []
        totals_guard = totals_guardrails.get(page_no) if cfg.stop_after_totals else None
        extra_keys = {_canon(k) for k in cfg.page_stop_keywords.get(page_no, []) if k}

        for r in range(min(rows, 12)):
            texts = row_layouts[r]["texts"]
            fam_hits: set = set()
            col_families: List[Optional[str]] = []
            for txt in texts:
                fam = family_of_header(txt)
                col_families.append(fam)
                if fam:
                    fam_hits.add(fam)

            data_start = r + 1
            default_stop = rows
            if extra_keys and data_start < rows:
                for rr in range(data_start, rows):
                    joined = _canon(" ".join(row_text_cached(rr)))
                    if joined and any(k in joined for k in extra_keys):
                        default_stop = rr
                        break

            numeric_cols = [idx for idx, fam in enumerate(col_families) if fam in NUMERIC_FAMILIES]
            decision = apply_stop_rules(
                row_layouts=row_layouts,
                header_idx=r,
                data_start=data_start,
                default_stop=default_stop,
                band=band,
                totals_guard=totals_guard,
                numeric_cols=numeric_cols,
            )

            body_count = max(0, decision.stop_index - data_start)
            cand_score = (body_count, len(fam_hits))
            row_candidates.append({
                "idx": r,
                "body": body_count,
                "fam_hits": set(fam_hits),
                "decision": decision,
            })
            if cand_score > best_score:
                best_score = cand_score
                best_idx = r
                best_decision = decision
                best_fam_hits = fam_hits

        if best_idx is None:
            return None

        if not best_fam_hits:
            alt = None
            for cand in row_candidates:
                if not cand["fam_hits"]:
                    continue
                key = (len(cand["fam_hits"]), cand["body"])
                if not alt or key > (len(alt["fam_hits"]), alt["body"]):
                    alt = cand
            if alt:
                best_idx = alt["idx"]
                best_decision = alt["decision"]
                best_fam_hits = alt["fam_hits"]
                best_score = (alt["body"], len(alt["fam_hits"]))

        if best_decision is None:
            best_decision = StopDecision(rule="none", stop_index=min(rows, (best_idx or 0) + 1), clip_y=None)

        header_hits = len(best_fam_hits)
        body_rows = best_score[0]

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

        table_height = max(1e-6, tby1 - tby0)
        overlap = 0.0
        if band:
            band_top = float(band.get("y0", 0.0))
            band_bottom = float(band.get("y1", 1.0))
            inter_top = max(band_top, tby0)
            inter_bottom = min(band_bottom, tby1)
            if inter_bottom > inter_top:
                overlap = max(0.0, min(1.0, (inter_bottom - inter_top) / table_height))

        numeric_rows = 0
        numeric_hits = 0
        stop_limit = best_decision.stop_index if best_decision else rows
        for rr in range(best_idx + 1, stop_limit):
            texts = row_text_cached(rr)
            if not texts:
                continue
            right_text = (texts[-1] or "").strip()
            if not right_text:
                continue
            numeric_rows += 1
            simple = right_text.replace(" ", "").replace("(", "").replace(")", "")
            if NUMERIC_ANCHOR_RE.fullmatch(simple) or any(ch.isdigit() for ch in right_text):
                numeric_hits += 1
        numeric_right = (numeric_hits / numeric_rows) if numeric_rows else 0.0

        totals_flag = 0.0
        if totals_regexes:
            bottom = tby1
            for tok in page_tokens:
                if _tok_top(tok) <= bottom + 1e-3:
                    continue
                text = _token_text(tok)
                if text and any(rgx.search(text) for rgx in totals_regexes):
                    totals_flag = 1.0
                    break

        candidate = {
            "table": tb,
            "flavor": flavor,
            "source": source,
            "header_idx": best_idx,
            "stop_at": best_decision.stop_index if best_decision else rows,
            "body_rows": body_rows,
            "header_hits": header_hits,
            "bbox": {"x0": tbx0, "y0": tby0, "x1": tbx1, "y1": tby1},
            "features": {
                "header_hits": float(header_hits),
                "overlap": float(overlap),
                "numeric_right": float(numeric_right),
                "rows": float(body_rows),
                "totals_below": float(totals_flag),
            },
            "stop_rule": best_decision.rule,
            "clip_y": best_decision.clip_y,
            "_stop_decision": best_decision,
        }
        return candidate

    pages_out: List[BaseTable] = []
    ranking_records: List[Dict[str, Any]] = []
    processed_pages = sorted(by_page_tokens.keys())
    prev_col_map: Optional[List[str]] = None
    prev_header_texts: Optional[List[str]] = None

    for page_no in processed_pages:
        page_tokens = sorted(by_page_tokens.get(page_no, []), key=lambda t: (t["bbox"]["y0"], t["bbox"]["x0"]))
        band = items_regions.get(page_no)
        tables = tables_by_page.get(page_no, [])
        page_candidates: List[Dict[str, Any]] = []
        for idx, item in enumerate(tables):
            tb, flavor, source = item
            candidate = analyze_candidate(tb, flavor, source, page_no, page_tokens, band)
            if not candidate:
                continue
            candidate["index"] = idx
            candidate["eligible"] = True
            candidate["score"] = None
            page_candidates.append(candidate)

        limit = cfg.ranking.max_candidates or 0
        eligible_candidates: List[Dict[str, Any]] = []
        for ordinal, cand in enumerate(page_candidates):
            if limit and ordinal >= limit:
                cand["eligible"] = False
                continue
            eligible_candidates.append(cand)

        overlap_ok = any(cand["features"].get("overlap", 0.0) >= cfg.ranking.overlap_threshold for cand in eligible_candidates)
        weights = cfg.ranking.weights
        for cand in eligible_candidates:
            feats = cand["features"]
            score = (
                float(weights.get("header", 0.0)) * float(feats.get("header_hits", 0.0))
                + (float(weights.get("overlap_items_region", 0.0)) * float(feats.get("overlap", 0.0)) if overlap_ok else 0.0)
                + float(weights.get("numeric_right", 0.0)) * float(feats.get("numeric_right", 0.0))
                + float(weights.get("rows", 0.0)) * float(feats.get("rows", 0.0))
                + float(weights.get("totals_below", 0.0)) * float(feats.get("totals_below", 0.0))
            )
            cand["score"] = score

        winner: Optional[Dict[str, Any]] = None
        if eligible_candidates:
            winner = max(
                eligible_candidates,
                key=lambda c: (
                    float(c.get("score") or 0.0),
                    float(c["features"].get("header_hits", 0.0)),
                    float(c["features"].get("rows", 0.0)),
                ),
            )

        if winner:
            tb = winner["table"]
            flavor = winner.get("flavor")
            header_idx = int(winner.get("header_idx", 0))
            pw, ph = get_page_dims(tb, page_no)
            if not pw or not ph:
                base_table = BaseTable(page=page_no, flavor=None, header_row_index=None, header_cells=[], rows=[], bbox={})
                pages_out.append(base_table)
            else:
                rows, cols = tb.shape
                header_texts = row_text(tb, header_idx, page_no, pw, ph, page_tokens)
                col_map: List[str] = []
                header_hits = 0
                for c in range(cols):
                    fam = family_of_header(header_texts[c])
                    if fam:
                        header_hits += 1
                    col_map.append(fam or f"COL{c+1}")

                reuse_prev = False
                header_contains_totals = any((_canon(text) and any(k in _canon(text) for k in totals_keys)) for text in header_texts)
                if header_hits == 0 or header_contains_totals:
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
                    data_start = 0

                decision_obj = winner.get("_stop_decision")
                if not isinstance(decision_obj, StopDecision):
                    decision_obj = StopDecision(rule="none", stop_index=rows, clip_y=None)
                stop_at = max(data_start, min(rows, int(decision_obj.stop_index or rows)))
                clip_limit = decision_obj.clip_y
                if clip_limit is not None:
                    clip_thresh = max(0.0, min(1.0, float(clip_limit))) + 1e-4
                    effective_tokens = [tok for tok in page_tokens if _tok_center(tok)[1] <= clip_thresh]
                else:
                    effective_tokens = page_tokens

                def row_text_list(r: int) -> List[str]:
                    return row_text(tb, r, page_no, pw, ph, effective_tokens)

                grid_rows: List[Dict[str, Any]] = []
                for r in range(data_start, stop_at):
                    texts = row_text_list(r)
                    if _is_repeat_header_row(texts, col_map, header_prefix_map):
                        continue
                    cells = []
                    for c in range(cols):
                        x0, y0, x1, y1 = get_cell_bbox(tb, r, c, pw, ph)
                        value = texts[c]
                        prefixes = header_prefix_map.get(col_map[c].upper(), []) if col_map[c] else []
                        if prefixes:
                            value = _strip_alias_prefix(value, prefixes)
                        name_upper = (col_map[c] or "").upper()
                        if name_upper in NUMERIC_FAMILIES:
                            value = _trim_numeric_tail(value)
                        cells.append({
                            "col": c,
                            "name": col_map[c],
                            "bbox": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
                            "text": value,
                        })
                    grid_rows.append({"row": r, "cells": cells})

                limit = cfg.page_row_limit.get(page_no)
                if limit is not None:
                    grid_rows = grid_rows[:limit]

                bbox = dict(winner.get("bbox", {}))
                if decision_obj.clip_y is not None:
                    clip_y_val = max(0.0, min(1.0, float(decision_obj.clip_y)))
                    current_y1 = float(bbox.get("y1", clip_y_val))
                    bbox["y1"] = min(current_y1, clip_y_val)
                    bbox["_clip_y"] = clip_y_val
                else:
                    bbox = dict(bbox)

                pages_out.append(BaseTable(
                    page=page_no,
                    flavor=flavor,
                    header_row_index=header_idx,
                    header_cells=[{"col": c, "text": header_texts[c], "name": col_map[c]} for c in range(cols)],
                    rows=grid_rows,
                    bbox=bbox,
                ))

                prev_col_map = col_map[:]
                prev_header_texts = header_texts[:]
        else:
            pages_out.append(BaseTable(page=page_no, flavor=None, header_row_index=None, header_cells=[], rows=[], bbox={}))

        selected_index = winner.get("index") if winner else None
        band_record = None
        if band:
            band_record = {
                "x0": band.get("x0"),
                "x1": band.get("x1"),
                "y0": band.get("y0"),
                "y1": band.get("y1"),
                "start_anchor": band.get("start_anchor"),
                "end_anchor": band.get("end_anchor"),
            }

        page_record = {
            "page": page_no,
            "items_region": band_record,
            "candidates": [],
            "selected_index": selected_index,
        }
        if not tables:
            page_record["note"] = "no_tables_detected"
        elif not page_candidates:
            page_record["note"] = "no_valid_candidates"
        for cand in page_candidates:
            summary = {
                "index": cand.get("index"),
                "source": cand.get("source"),
                "flavor": cand.get("flavor"),
                "bbox": cand.get("bbox"),
                "features": cand.get("features"),
                "score": cand.get("score"),
                "eligible": cand.get("eligible", True),
                "header_row_index": cand.get("header_idx"),
                "body_rows": cand.get("body_rows"),
                "header_hits": cand.get("header_hits"),
                "selected": bool(selected_index is not None and cand.get("index") == selected_index),
            }
            summary["stop_rule"] = cand.get("stop_rule")
            summary["stop_at"] = cand.get("stop_at")
            if cand.get("clip_y") is not None:
                summary["clip_y"] = cand.get("clip_y")
            if not cand.get("eligible", True):
                summary["note"] = "skipped_by_limit"
            page_record["candidates"].append(summary)
        ranking_records.append(page_record)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    ranking_path = out_path.parent / "candidate_ranking.json"
    ranking_path.write_text(json.dumps(ranking_records, ensure_ascii=False, indent=2), encoding="utf-8")

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
    original_name: Optional[str] = None
    original_text: Optional[str] = None

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
        self.header_prefix_map: Dict[str, List[str]] = {}
        for fam, aliases in cfg.header_aliases.items():
            values = [a for a in aliases if a]
            values.append(fam)
            uniq = {v.strip() for v in values if v and v.strip()}
            self.header_prefix_map[fam.upper()] = sorted(uniq, key=lambda s: (-len(s), s.lower()))

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
        clip_limit = base.bbox.get("_clip_y")
        clip_value: Optional[float] = None
        if clip_limit is not None:
            try:
                clip_value = float(clip_limit)
                table_bottom = min(table_bottom, clip_value)
            except Exception:
                clip_value = None

        if clip_value is not None:
            body_bottom = min(table_bottom, clip_value)
        else:
            body_bottom = table_bottom

        table_tokens = [tok for tok in page_tokens if body_top <= _tok_center(tok)[1] <= body_bottom and base.bbox.get("x0", 0.0) - 0.02 <= _tok_center(tok)[0] <= base.bbox.get("x1", 1.0) + 0.02]
        table_tokens.sort(key=lambda t: (_tok_top(t), _tok_left(t)))
        if not table_tokens:
            return base

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
        cols: List[ColumnBand] = []
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
            base_name = header.get("name") or header.get("text") or f"COL{idx+1}"
            header_text = header.get("text") or None
            cols.append(
                ColumnBand(
                    index=idx,
                    name=base_name,
                    x0=x0,
                    x1=x1,
                    original_name=base_name,
                    original_text=header_text,
                )
            )
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
        self._apply_column_overrides(cols, base)
        return cols

    def _apply_column_overrides(self, columns: List[ColumnBand], base: BaseTable) -> None:
        rules = self.cfg.row_fix.column_overrides
        if not rules:
            return
        for col in columns:
            header = base.header_cells[col.index] if 0 <= col.index < len(base.header_cells) else None
            header_texts: List[str] = []
            if header is not None:
                for key in ("text", "text_norm"):
                    value = header.get(key)
                    if isinstance(value, str) and value:
                        header_texts.append(value)
            original_text = getattr(col, "original_text", None)
            if isinstance(original_text, str) and original_text:
                header_texts.append(original_text)
            for rule in rules:
                if not rule.matches(col, header_texts):
                    continue
                if rule.set_name:
                    col.name = rule.set_name
                    if header is not None:
                        header["name"] = rule.set_name
                if rule.set_text is not None and header is not None:
                    header["text"] = rule.set_text
                    if header.get("text_norm") is not None:
                        header["text_norm"] = rule.set_text
                break

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
            if not row_numeric and self._row_is_header_repeat(row, columns):
                self.fix_report.append({"type": "skip_repeated_header", "row": row.index})
                continue
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

    def _row_is_header_repeat(self, row: RowBand, columns: List[ColumnBand]) -> bool:
        hits = 0
        total = 0
        for col in columns:
            toks = row.column_tokens.get(col.index, [])
            if not toks:
                continue
            text = " ".join((_token_text(tok) or "").strip() for tok in toks).strip()
            if not text:
                continue
            total += 1
            prefixes = self.header_prefix_map.get(col.name.upper(), []) if col.name else []
            canon_text = _canon(text)
            if prefixes and any(canon_text.startswith(_canon(alias)) for alias in prefixes):
                hits += 1
        if total == 0:
            return False
        return hits >= max(2, total - 1)

    def _looks_like_fragment(self, text: str) -> bool:
        sample = (text or "").strip()
        if not sample or any(ch.isdigit() for ch in sample):
            return False
        return sample.isupper() or sample.replace("(", "").replace(")", "").isupper()

    def _detach_leading_fragment(self, text: Optional[str]) -> Tuple[Optional[str], str]:
        value = (text or "").strip()
        if not value:
            return None, ""
        for marker in (" SZ ", " TS "):
            idx = value.find(marker)
            if idx > 0:
                prefix = value[:idx].strip()
                remainder = value[idx:].lstrip()
                if prefix and prefix.upper() == prefix and not any(ch.isdigit() for ch in prefix):
                    return prefix, remainder
        return None, value

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
                prefixes = self.header_prefix_map.get(col.name.upper(), []) if col.name else []
                if prefixes and segments:
                    first_seg = segments[0]
                    cleaned_first = _strip_alias_prefix(first_seg, prefixes).strip()
                    if cleaned_first != first_seg:
                        segments = [cleaned_first] + segments[1:]
                if prefixes:
                    text = _strip_alias_prefix(text, prefixes).strip()
                if col.name.upper() in NUMERIC_FAMILIES:
                    text = _trim_numeric_tail(text)
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
            desc_cell = next((cell for cell in cells if (cell.get("name") or "").upper() in DESC_FAMILIES), None)
            if desc_cell and out_rows[:-1]:
                prev_desc = None
                prev_desc_cell = None
                prev_cells = out_rows[-2]["cells"] if len(out_rows) >= 2 else []
                for c in prev_cells:
                    if (c.get("name") or "").upper() in DESC_FAMILIES:
                        prev_desc = c.get("text")
                        prev_desc_cell = c
                        break
                if prev_desc:
                    meta_curr = column_meta.get(desc_cell["col"], {})
                    segments = list(meta_curr.get("segments") or [])
                    if segments and self._looks_like_fragment(segments[0]):
                        fragment = segments[0].strip()
                        if fragment and prev_desc_cell is not None:
                            prev_text = prev_desc_cell.get("text", "")
                            prev_desc_cell["text"] = (prev_text + " " + fragment).strip()
                            prev_desc = prev_desc_cell["text"]
                        segments = segments[1:]
                        desc_cell["text"] = self._clean_text(" ".join(segments)) if segments else ""
                        meta_curr["segments"] = segments
                    desc_cell["text"] = _strip_overlap_prefix(prev_desc, desc_cell.get("text"))
                fragment, remainder = self._detach_leading_fragment(desc_cell.get("text"))
                if fragment and prev_desc_cell is not None:
                    prev_text = prev_desc_cell.get("text", "")
                    prev_desc_cell["text"] = (prev_text + " " + fragment).strip()
                    prev_desc = prev_desc_cell["text"]
                if fragment:
                    desc_cell["text"] = remainder
            if desc_cell:
                desc_cell["text"] = _cleanup_description(desc_cell.get("text"))
        for idx in range(1, len(out_rows)):
            curr_desc_cell = next((cell for cell in out_rows[idx]["cells"] if (cell.get("name") or "").upper() in DESC_FAMILIES), None)
            prev_desc_cell = next((cell for cell in out_rows[idx - 1]["cells"] if (cell.get("name") or "").upper() in DESC_FAMILIES), None)
            if not curr_desc_cell or not prev_desc_cell:
                continue
            fragment, remainder = self._detach_leading_fragment(curr_desc_cell.get("text"))
            if fragment and remainder != curr_desc_cell.get("text"):
                prev_text = prev_desc_cell.get("text", "")
                prev_desc_cell["text"] = (prev_text + " " + fragment).strip()
                curr_desc_cell["text"] = remainder
            if not curr_desc_cell.get("text"):
                head, trailing = _split_trailing_fragment(prev_desc_cell.get("text"))
                if trailing:
                    prev_desc_cell["text"] = head
                    curr_desc_cell["text"] = trailing
        for idx in range(len(out_rows) - 1):
            curr_desc_cell = next((cell for cell in out_rows[idx]["cells"] if (cell.get("name") or "").upper() in DESC_FAMILIES), None)
            next_desc_cell = next((cell for cell in out_rows[idx + 1]["cells"] if (cell.get("name") or "").upper() in DESC_FAMILIES), None)
            if not curr_desc_cell or not next_desc_cell:
                continue
            head, fragment = _split_trailing_fragment(curr_desc_cell.get("text"))
            if fragment and fragment != curr_desc_cell.get("text"):
                curr_desc_cell["text"] = head
                combined = (fragment + " " + (next_desc_cell.get("text") or "")).strip()
                next_desc_cell["text"] = combined
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


def build_cells(pdf_path: Path, tokens_path: Path, out_path: Path, config_path: Path, token_engine: Optional[str] = None) -> Dict[str, Any]:
    cfg = _validate_config(json.loads(config_path.read_text(encoding="utf-8")))
    preferred_engine = token_engine or cfg.token_engine
    tokens = load_tokens(tokens_path, preferred_engine=preferred_engine)
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
        "token_engine": tokens.engine,
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
    ap.add_argument("--tokenizer", required=False, help="Token source override (plumber, pymupdf, combined)")
    args = ap.parse_args()

    token_engine = args.tokenizer.strip().lower() if getattr(args, "tokenizer", None) else None

    build_cells(
        Path(args.pdf).resolve(),
        Path(args.tokens).resolve(),
        Path(args.out).resolve(),
        Path(args.config).resolve(),
        token_engine=token_engine,
    )


if __name__ == "__main__":
    main()
