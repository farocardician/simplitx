#!/usr/bin/env python3
"""
Stage‑7 — Strict Region‑First Extractor (V3)

Contract (from extractorRefactorV3.md):
- Reads only tokens inside declared segments. No roaming.
- No math. Totals are printed-only from dedicated segments.
- Evidence per field: region id, bbox, page, token span, confidence, warnings.
- Python logic is rigid; behavior controlled only via config file.

Totals routing note (2025-02): totals-like fields are now routed into
``totals_extracted`` when their name or segment matches configurable
allow-lists. Defaults mirror the previous behaviour so existing vendors stay
unchanged, while configs can override the lists or keep header copies if
desired.

Inputs:
  --tokens   Stage 2 normalized tokens JSON
  --segments Stage 3 segments JSON
  --config   Stage 7 config (see sample config & schema stub)
Outputs:
  --out      fields JSON with header & totals_extracted
"""
from __future__ import annotations

import argparse
import json
import re
import string
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


logger = logging.getLogger("s07_extractor")


# -------------------- IO helpers --------------------
def load_json(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8"))


# -------------------- Geometry & tokens --------------------
def tokens_by_page(tokens: List[Dict[str, Any]]) -> Dict[int, List[Dict[str, Any]]]:
    byp: Dict[int, List[Dict[str, Any]]] = {}
    for t in tokens:
        byp.setdefault(int(t.get("page", 1)), []).append(t)
    return byp


def token_text(t: Dict[str, Any], prefer_norm: bool) -> str:
    if prefer_norm:
        v = (t.get("norm") or t.get("text") or "").strip()
    else:
        v = (t.get("text") or t.get("norm") or "").strip()
    return v


def tokens_in_bbox(tokens_by_page: Dict[int, List[Dict[str, Any]]], page: int, bbox: List[float]) -> List[Dict[str, Any]]:
    x0, y0, x1, y1 = bbox
    out: List[Dict[str, Any]] = []
    for t in tokens_by_page.get(page, []):
        b = t.get("bbox") or {}
        if b.get("x1", 0) <= x0 or b.get("x0", 0) >= x1:
            continue
        if b.get("y0", 0) >= y1 or b.get("y1", 0) <= y0:
            continue
        out.append(t)
    # Stable reading order
    out.sort(key=lambda tt: (float(tt["bbox"]["y0"]), float(tt["bbox"]["x0"])) )
    return out


def group_lines(tokens: List[Dict[str, Any]], y_tol: float = 0.004) -> List[List[Dict[str, Any]]]:
    if not tokens:
        return []
    lines: List[List[Dict[str, Any]]] = []
    cur: List[Dict[str, Any]] = []
    cur_y: Optional[float] = None
    for t in tokens:
        y0 = float(t["bbox"]["y0"])
        if cur_y is None or abs(y0 - cur_y) <= y_tol:
            cur.append(t)
            cur_y = y0 if cur_y is None else cur_y
        else:
            lines.append(cur)
            cur = [t]
            cur_y = y0
    if cur:
        lines.append(cur)
    return lines


def join_line(tokens: List[Dict[str, Any]], prefer_norm: bool) -> str:
    return " ".join(token_text(t, prefer_norm) for t in tokens if token_text(t, prefer_norm))


def tokens_bbox(tokens: List[Dict[str, Any]]) -> Optional[List[float]]:
    if not tokens:
        return None
    xs0: List[float] = []
    ys0: List[float] = []
    xs1: List[float] = []
    ys1: List[float] = []
    for t in tokens:
        bb = t.get("bbox") or {}
        try:
            xs0.append(float(bb.get("x0")))
            ys0.append(float(bb.get("y0")))
            xs1.append(float(bb.get("x1")))
            ys1.append(float(bb.get("y1")))
        except (TypeError, ValueError):
            continue
    if not xs0 or not ys0 or not xs1 or not ys1:
        return None
    return [min(xs0), min(ys0), max(xs1), max(ys1)]


# -------------------- Config model --------------------
@dataclass
class Profile:
    name: str
    fail_mode: str  # 'hard' | 'soft'
    required: List[str]
    expected: List[str]
    optional: List[str]


def load_config(cfg_path: Path) -> Dict[str, Any]:
    cfg = load_json(cfg_path)
    # Minimal schema checks
    if not isinstance(cfg, dict):
        raise SystemExit("Config must be a JSON object")

    totals = (cfg.get("totals") or {})
    mode = totals.get("mode")
    if mode and mode != "segments_only":
        raise SystemExit("Unsupported totals.mode. Only 'segments_only' is implemented.")

    if cfg.get("strict_segments") is False:
        # Implementation is strict by design. Warn if config says otherwise.
        pass

    return cfg


def get_profile(cfg: Dict[str, Any]) -> Profile:
    prof = cfg.get("profile") or {}
    return Profile(
        name=str(prof.get("name")) if prof.get("name") else "default",
        fail_mode=(prof.get("fail_mode") or "hard").lower(),
        required=list(prof.get("required_fields") or []),
        expected=list(prof.get("expected_fields") or []),
        optional=list(prof.get("optional_fields") or []),
    )


# -------------------- Cleaning & guards --------------------
# (No global cleaning in segment-only mode)


def apply_guards(field: str, text: str, guards: Dict[str, Any], warnings: List[str]) -> Optional[str]:
    g = (guards or {}).get(field) or {}
    if not g:
        return text
    val = text
    # allowed_chars: treat as character class without brackets
    allowed = g.get("allowed_chars")
    if allowed:
        rx = re.compile(rf"^[{allowed}\s]+$")
        if val and not rx.match(val):
            warnings.append(f"guard_failed.allowed_chars:{allowed}")
            return None
    min_len = g.get("min_len")
    if isinstance(min_len, int) and val and len(val) < min_len:
        warnings.append(f"guard_failed.min_len:{min_len}")
        return None
    max_len = g.get("max_len")
    if isinstance(max_len, int) and val and len(val) > max_len:
        warnings.append(f"guard_failed.max_len:{max_len}")
        return None
    return val


def parse_trivial_number(text: str) -> Optional[float]:
    # Trivial parse only: plain digits with optional leading '-' or surrounding parentheses, optional single '.'
    # Reject thousands separators or mixed punctuation.
    s = text.strip()
    if not s:
        return None
    if re.fullmatch(r"\(?-?\d+(?:\.\d+)?\)?", s):
        neg = s.startswith("(") and s.endswith(")")
        core = s[1:-1] if neg else s
        try:
            v = float(core)
            return -v if neg else v
        except Exception:
            return None
    return None


# -------------------- Confidence --------------------
def confidence_bucket(token_count: int, line_count: int, thresholds: Dict[str, Any]) -> str:
    if token_count == 0:
        return "none"
    th_high = (thresholds or {}).get("high") or {"max_lines": 1, "max_tokens": 15}
    th_med = (thresholds or {}).get("medium") or {"max_lines": 3, "max_tokens": 60}

    if line_count <= int(th_high.get("max_lines", 1)) and token_count <= int(th_high.get("max_tokens", 15)):
        return "high"
    if line_count <= int(th_med.get("max_lines", 3)) and token_count <= int(th_med.get("max_tokens", 60)):
        return "medium"
    return "low"


# -------------------- Core extraction --------------------
def _build_region_map(sdata: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    region_map: Dict[str, Dict[str, Any]] = {}
    for seg in sdata.get("segments", []) or []:
        key = seg.get("label") or seg.get("id")
        if key:
            region_map[str(key)] = seg
    return region_map


 


def extract_strict(tokens_p: Path, segments_p: Path, cfg_p: Path, tokenizer: str) -> Dict[str, Any]:
    cfg = load_config(cfg_p)
    prof = get_profile(cfg)

    tdata = load_json(tokens_p)
    sdata = load_json(segments_p)

    engine_block = tdata.get(tokenizer)
    if not isinstance(engine_block, dict) or not isinstance(engine_block.get("tokens"), list):
        raise SystemExit(f"Tokenizer '{tokenizer}' tokens not found in {tokens_p}")

    prefer_norm = bool(cfg.get("use_stage2_normalized", True))
    guards = (cfg.get("guards") or {})
    conf_th = (cfg.get("confidence", {}) or {}).get("thresholds", {})

    # Build region map from segments (by label or id)
    region_map = _build_region_map(sdata)

    field_map_raw = cfg.get("fields") or {}

    totals_cfg = cfg.get("totals") or {}
    default_total_fields = [
        "subtotal",
        "tax_base",
        "tax_amount",
        "grand_total",
        "total_qty",
        "vat_rate_percent",
    ]
    default_total_segments = [
        "total",
        "totals",
        "subtotal",
        "vat",
        "grand_total",
    ]
    totals_field_names = {
        str(name).strip().lower()
        for name in (totals_cfg.get("field_names") or default_total_fields)
        if str(name).strip()
    }
    totals_segment_names = {
        str(name).strip().lower()
        for name in (totals_cfg.get("segments") or default_total_segments)
        if str(name).strip()
    }
    prefer_totals_bucket = bool(totals_cfg.get("prefer_totals_over_header", True))
    warned_totals_reroute = False

    # Preflight checks
    errors: List[str] = []
    warnings: List[str] = []

    # Verify totals mode
    if (cfg.get("totals") or {}).get("mode", "segments_only") != "segments_only":
        errors.append("totals.mode must be 'segments_only'")

    # Verify mapping points to existing segments
    # Don't preflight per‑field mapping yet; strategy may not use a single segment id
    # Legacy check when value is a direct segment id string
    for f, spec in field_map_raw.items():
        if isinstance(spec, str):
            if spec not in region_map:
                errors.append(f"segment_missing:{f}:{spec}")

    # Check required vs expected vs optional existence
    for f in prof.required:
        if f not in field_map_raw:
            errors.append(f"required_field_not_mapped:{f}")

    if errors and prof.fail_mode == "hard":
        raise SystemExit("Preflight failed: " + "; ".join(errors))
    elif errors:
        warnings.extend(errors)

    # Token index by page
    tbyp = tokens_by_page(engine_block["tokens"])

    # Track strategies actually used (for meta clarity)
    strategies_used: Dict[str, str] = {}

    def extract_one(field: str) -> Dict[str, Any]:
        out_warn: List[str] = []
        spec = field_map_raw.get(field)
        if spec is None:
            out_warn.append("segment_not_mapped")
            return {
                "raw_text": None,
                "value_text": None,
                "page": None,
                "source_region": None,
                "region_bbox": None,
                "token_span": [],
                "confidence": "none",
                "warnings": out_warn,
            }
        # Resolve strategy
        field_post = {}
        flags_cfg: Dict[str, Any] = {}
        if isinstance(spec, dict):
            strategy = (spec.get("strategy") or "strict_full_text").lower()
            field_post = spec.get("post") or {}
            seg_ref = spec.get("segment") or None
            flags_cfg = spec.get("flags") or {}
        else:
            strategy = "strict_full_text"
            field_post = {}
            seg_ref = None
            flags_cfg = {}
        # Record the chosen strategy for this field
        strategies_used[field] = strategy

        def summarize_value(page: Optional[int], bbox: Optional[List[float]], toks: List[Dict[str, Any]], lines: List[str], raw_text: Optional[str], value_override: Optional[str] = None) -> Dict[str, Any]:
            # value_text defaults to raw_text unless overridden (e.g., regex capture)
            value_text = value_override if value_override is not None else (raw_text or None)
            if value_text is not None:
                guarded = apply_guards(field, value_text, guards, out_warn)
                if guarded is None:
                    value_text = None
            value_numeric: Optional[float] = None
            if field in {"subtotal", "tax_base", "tax_amount", "grand_total"} and value_text:
                value_numeric = parse_trivial_number(value_text)
            span_ids = [int(t.get("id")) for t in toks if isinstance(t.get("id"), int)]
            span_ids.sort()
            conf = confidence_bucket(len(toks), len([ln for ln in lines if ln]), conf_th)
            # Required handling
            if (field in prof.required) and (not value_text or str(value_text).strip() == ""):
                msg = "required_field_empty"
                if prof.fail_mode == "hard":
                    raise SystemExit(f"Preflight failed: {field}:{msg}")
                out_warn.append(msg)
            entry = {
                "raw_text": raw_text,
                "value_text": value_text,
                "page": page,
                "source_region": None,
                "region_bbox": bbox,
                "token_span": span_ids,
                "confidence": conf,
                "strategy": strategy,
            }
            if value_numeric is not None:
                entry["value_numeric"] = value_numeric
            if out_warn:
                entry["warnings"] = out_warn
            return entry

        def first_non_empty_line(line_groups: List[List[Dict[str, Any]]]) -> Dict[str, Any]:
            normalize_space_flag = bool(flags_cfg.get("normalize_space"))
            strip_punct_flag = bool(flags_cfg.get("strip_punctuation"))
            raw_candidates: List[str] = []
            for idx, group in enumerate(line_groups):
                candidate = join_line(group, prefer_norm)
                if not candidate:
                    continue
                raw_candidates.append(candidate)
                processed = candidate
                if normalize_space_flag:
                    processed = re.sub(r"\s+", " ", processed).strip()
                else:
                    processed = processed.strip()
                if strip_punct_flag:
                    processed = processed.strip(string.punctuation)
                if not processed:
                    continue
                chk = re.sub(r"\s+", "", processed)
                if chk and all(ch in string.punctuation for ch in chk):
                    continue
                return {
                    "found": True,
                    "line_index": idx,
                    "raw_line": candidate,
                    "prepared_line": processed,
                    "tokens": group,
                    "raw_candidates": raw_candidates,
                }
            return {
                "found": False,
                "line_index": None,
                "raw_line": raw_candidates[0] if raw_candidates else None,
                "prepared_line": None,
                "tokens": [],
                "raw_candidates": raw_candidates,
            }

        # Strategy implementations
        if strategy == "strict_full_text":
            # Legacy path using a single segment id
            if isinstance(spec, str):
                seg_id = spec
            elif seg_ref:
                seg_id = str(seg_ref)
            else:
                out_warn.append("segment_not_mapped")
                return summarize_value(None, None, [], [], None)
            seg = region_map.get(seg_id)
            if not seg:
                out_warn.append("segment_not_found")
                return summarize_value(None, None, [], [], None)
            page = int(seg.get("page", 1))
            bbox = seg.get("bbox", [0, 0, 1, 1])
            toks = tokens_in_bbox(tbyp, page, bbox)
            lines = [join_line(g, prefer_norm) for g in group_lines(toks)]
            raw_text = " ".join([s for s in lines if s]).strip() or None
            entry = summarize_value(page, bbox, toks, lines, raw_text)
            entry["source_region"] = seg_id
            entry["region_bbox"] = bbox
            return entry

        elif strategy == "first_line_pattern":
            patterns = field_post.get("regex_pattern")
            if isinstance(patterns, str):
                patterns = [patterns]
            elif patterns is None:
                patterns = []

            seg_id = str(seg_ref) if seg_ref else (spec if isinstance(spec, str) else None)
            if not seg_id:
                out_warn.append("segment_not_mapped")
                return summarize_value(None, None, [], [], None)
            seg = region_map.get(seg_id)
            if not seg:
                out_warn.append("segment_not_found")
                return summarize_value(None, None, [], [], None)

            page = int(seg.get("page", 1))
            bbox = seg.get("bbox", [0, 0, 1, 1])
            toks = tokens_in_bbox(tbyp, page, bbox)
            line_groups = group_lines(toks)
            picked = first_non_empty_line(line_groups)

            if not picked.get("found"):
                entry = summarize_value(page, bbox, [], [], None)
                entry["source_region"] = seg_id
                entry["region_bbox"] = bbox
                entry.setdefault("meta", {})
                entry["meta"]["confidence_bucket"] = entry.get("confidence")
                entry["meta"].update({
                    "strategy": "first_line_pattern",
                    "line_index": None,
                    "warning": "first_line_pattern: no non-empty line",
                })
                if picked.get("raw_line"):
                    entry["meta"]["sample_line"] = picked.get("raw_line")
                entry["confidence"] = 0.20
                entry["value"] = entry.get("value_text")
                return entry

            prepared_line = picked.get("prepared_line") or ""
            raw_line = picked.get("raw_line") or ""
            prepared_tokens = picked.get("tokens") or []
            line_index = picked.get("line_index")

            if not patterns:
                out_warn.append("first_line_pattern:no_patterns")

            regex_flags = 0
            if flags_cfg.get("ignore_case"):
                regex_flags |= re.IGNORECASE
            if flags_cfg.get("multiline"):
                regex_flags |= re.MULTILINE
            if flags_cfg.get("dotall"):
                regex_flags |= re.DOTALL

            extracted = None
            matched_pattern = None
            matched_index = None
            group_used = 0
            match_span: Optional[List[int]] = None

            for idx, pat in enumerate(patterns or []):
                try:
                    rx = re.compile(pat, flags=regex_flags)
                except re.error:
                    out_warn.append(f"regex_compile_error:{idx}")
                    continue
                m = rx.search(prepared_line)
                if not m:
                    continue
                if m.lastindex:
                    extracted = m.group(1)
                    group_used = 1
                else:
                    extracted = m.group(0)
                    group_used = 0
                matched_pattern = pat
                matched_index = idx
                match_span = [int(m.span(0)[0]), int(m.span(0)[1])]
                break

            entry = summarize_value(page, bbox, prepared_tokens, [raw_line], raw_line, extracted)
            bucket_conf = entry.get("confidence")
            success = extracted is not None and extracted != ""
            entry["confidence"] = 0.90 if success else 0.20
            entry["value"] = entry.get("value_text")
            entry.setdefault("meta", {})
            entry["meta"].update({
                "strategy": "first_line_pattern",
                "confidence_bucket": bucket_conf,
                "line_index": line_index,
                "line_bbox": tokens_bbox(prepared_tokens),
                "line_text_len": len(prepared_line),
                "raw_line": raw_line,
                "pattern_used": matched_pattern,
                "pattern_index": matched_index,
                "group_used": group_used if success else None,
                "match_span": match_span,
                "total_patterns": len(patterns or []),
            })
            if not success:
                entry["meta"]["warning"] = "first_line_pattern: no pattern matched"
                entry["meta"]["sample_line"] = prepared_line or raw_line
            entry["source_region"] = seg_id
            entry["region_bbox"] = bbox
            return entry

        elif strategy == "first_line":
            seg_id = str(seg_ref) if seg_ref else (spec if isinstance(spec, str) else None)
            if not seg_id:
                out_warn.append("segment_not_mapped")
                return summarize_value(None, None, [], [], None)
            seg = region_map.get(seg_id)
            if not seg:
                out_warn.append("segment_not_found")
                return summarize_value(None, None, [], [], None)

            page = int(seg.get("page", 1))
            bbox = seg.get("bbox", [0, 0, 1, 1])
            toks = tokens_in_bbox(tbyp, page, bbox)
            line_groups = group_lines(toks)
            picked = first_non_empty_line(line_groups)
            if not picked.get("found"):
                entry = summarize_value(page, bbox, [], [], None)
                entry["source_region"] = seg_id
                entry["region_bbox"] = bbox
                entry.setdefault("meta", {})
                entry["meta"]["confidence_bucket"] = entry.get("confidence")
                entry["meta"].update({
                    "strategy": "first_line",
                    "line_index": None,
                    "warning": "first_line: no non-empty line",
                })
                if picked.get("raw_line"):
                    entry["meta"]["sample_line"] = picked.get("raw_line")
                entry["confidence"] = 0.20
                entry["value"] = entry.get("value_text")
                return entry

            prepared_line = picked.get("prepared_line")
            raw_line = picked.get("raw_line")
            prepared_tokens = picked.get("tokens") or []
            line_index = picked.get("line_index")

            entry = summarize_value(page, bbox, prepared_tokens, [raw_line], raw_line, prepared_line)
            bucket_conf = entry.get("confidence")
            entry["confidence"] = 0.75
            entry["value"] = entry.get("value_text")
            entry.setdefault("meta", {})
            entry["meta"].update({
                "strategy": "first_line",
                "confidence_bucket": bucket_conf,
                "line_index": line_index,
                "line_bbox": tokens_bbox(prepared_tokens),
                "line_text_len": len(prepared_line or ""),
                "raw_line": raw_line,
            })
            entry["source_region"] = seg_id
            entry["region_bbox"] = bbox
            return entry

        elif strategy == "anchor_value":
            out_warn.append("unsupported_strategy:anchor_value")
            return summarize_value(None, None, [], [], None)

        elif strategy == "constant":
            # Force a literal value from config (per-vendor canonicalization).
            # Uses summarize_value so guards/required/confidence still apply.
            const_val = (field_post.get("value") or field_post.get("literal") or "")
            entry = summarize_value(None, None, [], [], None, const_val)
            # Mark as an override (no source bbox/tokens)
            entry["source_region"] = "override"
            entry["region_bbox"] = None
            return entry

        elif strategy == "regex_capture":
            # Apply regex pattern(s) to text inside a segment bbox
            patterns = field_post.get("regex_pattern")
            if patterns is None:
                legacy = field_post.get("capture_regex")
                if legacy is not None:
                    patterns = [legacy]
            if isinstance(patterns, str):
                patterns = [patterns]
            seg_id = str(seg_ref) if seg_ref else (spec if isinstance(spec, str) else None)
            if not seg_id:
                out_warn.append("segment_not_mapped")
                return summarize_value(None, None, [], [], None)
            seg = region_map.get(seg_id)
            if not seg:
                out_warn.append("segment_not_found")
                return summarize_value(None, None, [], [], None)
            page = int(seg.get("page", 1))
            bbox = seg.get("bbox", [0, 0, 1, 1])
            toks = tokens_in_bbox(tbyp, page, bbox)
            line_text = " ".join([join_line(g, prefer_norm) for g in group_lines(toks) if join_line(g, prefer_norm)])
            raw_text = line_text or None
            extracted = None
            matched_index = None
            matched_pattern = None
            match_span = None
            total_patterns = len(patterns or [])
            if patterns:
                for idx, pat in enumerate(patterns):
                    try:
                        m = re.search(pat, line_text or "", flags=re.IGNORECASE)
                        if m:
                            extracted = m.group(1) if m.groups() else m.group(0)
                            matched_index = idx
                            matched_pattern = pat
                            match_span = list(m.span(0))
                            break
                    except re.error:
                        continue
            entry = summarize_value(page, bbox, toks, [line_text], raw_text, extracted)
            entry["source_region"] = seg_id
            # Add concise regex meta for transparency
            entry["regex"] = {
                "total_patterns": total_patterns,
                "pattern_index": matched_index,
                "matched_pattern": matched_pattern,
                "match_span": match_span,
            }
            return entry

        else:
            out_warn.append(f"unknown_strategy:{strategy}")
            return summarize_value(None, None, [], [], None)

    # Build outputs - dynamic field categorization
    # Fields referencing "total" segment go to totals_extracted
    # All other fields go to header
    header: Dict[str, Any] = {}
    totals_extracted: Dict[str, Any] = {}

    for field_name, field_spec in field_map_raw.items():
        # Determine segment reference
        if isinstance(field_spec, dict):
            segment_ref = field_spec.get("segment")
        else:
            segment_ref = field_spec

        # Extract the field
        field_result = extract_one(field_name)

        segment_key = None
        if isinstance(segment_ref, str):
            segment_key = segment_ref
        elif segment_ref is not None:
            segment_key = str(segment_ref)

        field_key = str(field_name).lower()
        detected_by_name = field_key in totals_field_names
        detected_by_segment = (segment_key or "").lower() in totals_segment_names if segment_key else False
        route_to_totals = detected_by_name or detected_by_segment

        if route_to_totals:
            totals_extracted[field_name] = field_result
            if prefer_totals_bucket:
                header.pop(field_name, None)
            else:
                header[field_name] = field_result
            if detected_by_name and not detected_by_segment and not warned_totals_reroute:
                logger.warning("Found totals field(s) in header; routed to totals_extracted.")
                warned_totals_reroute = True
        else:
            header[field_name] = field_result

    out = {
        "doc_id": tdata.get("doc_id"),
        "version": "3.4-segment-only",
        "meta": {
            "profile": prof.name,
            "fail_mode": prof.fail_mode
        },
        "header": header,
        "totals_extracted": totals_extracted,
    }
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Stage‑7 — Strict Region‑First Extractor")
    ap.add_argument("--tokens", required=True, help="Stage‑2 normalized tokens JSON path")
    ap.add_argument("--segments", required=True, help="Stage‑3 segments JSON path")
    ap.add_argument("--config", required=True, help="Stage‑7 config JSON path")
    ap.add_argument("--out", required=True, help="Output fields JSON path")
    ap.add_argument(
        "--tokenizer",
        required=True,
        choices=["plumber", "pymupdf"],
        help="Tokenizer engine to consume from Stage 2 output",
    )
    args = ap.parse_args()

    tokens_p = Path(args.tokens).resolve()
    segments_p = Path(args.segments).resolve()
    cfg_p = Path(args.config).resolve()
    out_p = Path(args.out).resolve()
    out_p.parent.mkdir(parents=True, exist_ok=True)

    out = extract_strict(tokens_p, segments_p, cfg_p, args.tokenizer)
    out_p.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # Per-field compact summary for logs
    def summarize(section: Dict[str, Any]) -> List[Dict[str, Any]]:
        rows = []
        for k, v in section.items():
            rows.append({
                "field": k,
                "region": v.get("source_region"),
                "page": v.get("page"),
                "tokens": len(v.get("token_span", []) or []),
                "confidence": v.get("confidence"),
                "raw_preview": (v.get("raw_text") or "")[:64],
                "warnings": v.get("warnings", []),
            })
        return rows

    print(json.dumps({
        "stage": "stage7_strict",
        "doc_id": out.get("doc_id"),
        "tokenizer": args.tokenizer,
        "header": summarize(out.get("header", {})),
        "totals": summarize(out.get("totals_extracted", {})),
        "version": out.get("version"),
    }, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
