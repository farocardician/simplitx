#!/usr/bin/env python3
"""
Stage 06 – Line-Item Structuring (deterministic, config-driven)

Contract (see context/refactor-s06_line_items_from_cells.md):
- Input A: 05-cells-normalized.json
  - pages[] -> table{ header_cells[], rows[] }, coords relative [0..1]
- Input B: vendor config (JSON) with fields mapping + parsing rules
- Output: items JSON matching GOLD shape used in sample vendors

Global rules implemented:
- Case-insensitive, Unicode regex
- Round half up to currency_decimals at each monetary step
- notes: short string join with '; '
- No ML. All vendor logic lives in config.

Key features:
- Column mapping via header_synonyms first, then position_hint (x-center)
- Row filtering with row_filters regex
- Parsers: parse_int, parse_number, parse_money, parse_percent,
  split_qty_uom, strip_nonprint, normalize_sku
- UOM resolution precedence: row -> header unit suffix -> doc patterns -> default
- Discounts & Proration (two-pass) per config
- Validation and numbering fallback

CLI:
python s06_line_items.py \
  --input 05-cells-normalized.json \
  --config vendor.json \
  --out 06-items.json
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation, getcontext
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Ensure sufficient precision for currency math
getcontext().prec = 28


# ---------------------------- helpers: strings, regex ----------------------------
def _clean(s: Optional[str]) -> str:
    if s is None:
        return ""
    s = s.replace("\xa0", " ")
    s = " ".join(s.split())
    return s.strip()


def _canon(s: str) -> str:
    return "".join(ch for ch in (s or "").upper() if ch.isalnum())


def _join_header_texts(header_cells: List[Dict[str, Any]]) -> str:
    return " ".join(_clean(c.get("text_norm") or c.get("text") or "") for c in (header_cells or []))


def _adapt_pattern(pattern: str) -> str:
    # Convert PCRE-style named groups (?<name>...) to Python (?P<name>...)
    try:
        return re.sub(r"\(\?<([a-zA-Z_][a-zA-Z0-9_]*)>", r"(?P<\1>", pattern)
    except re.error:
        return pattern


def _regex_search(pattern: str, text: str) -> Optional[re.Match]:
    pat = _adapt_pattern(pattern)
    try:
        return re.search(pat, text, flags=re.I | re.U)
    except re.error as e:
        raise ValueError(f"Invalid regex '{pattern}': {e}")


def _regex_findall(pattern: str, text: str) -> List[re.Match]:
    pat = _adapt_pattern(pattern)
    try:
        return list(re.finditer(pat, text, flags=re.I | re.U))
    except re.error as e:
        raise ValueError(f"Invalid regex '{pattern}': {e}")


def _is_whole_token_match(text: str, m: re.Match) -> bool:
    # whole token = non-alnum boundaries around match (or start/end)
    start, end = m.span()
    left_ok = start == 0 or not (text[start - 1].isalnum())
    right_ok = end == len(text) or not (end < len(text) and text[end].isalnum())
    return left_ok and right_ok


# ---------------------------- helpers: numbers & rounding ----------------------------
def _to_decimal(s: Optional[str], thousands: str = ",", decimal: str = ".", allow_parens: bool = True,
                currency_hints: Optional[List[str]] = None) -> Optional[Decimal]:
    if s is None:
        return None
    z = _clean(str(s))
    if z == "":
        return None
    if allow_parens and z.startswith("(") and z.endswith(")"):
        z = z[1:-1]
        neg = True
    else:
        neg = False
    if currency_hints:
        for h in currency_hints:
            if not h:
                continue
            for hh in (h, h.upper(), h.lower()):
                z = z.replace(hh, "")
    if thousands:
        z = z.replace(thousands, "")
    if decimal and decimal != ".":
        z = z.replace(decimal, ".")
    z = re.sub(r"[^0-9.+-]", "", z)
    if z in ("", ".", "+", "-"):
        return None
    try:
        v = Decimal(z)
    except InvalidOperation:
        return None
    return -v if neg else v


def _first_numeric_token(s: Optional[str]) -> Optional[str]:
    if s is None:
        return None
    z = _clean(str(s))
    if z == "":
        return None
    m = re.search(r"-?\d[\d.,]*", z)
    if not m:
        return None
    token = m.group(0)
    start, end = m.span()
    if start > 0 and z[start - 1] == "(":
        if end < len(z) and z[end] == ")":
            token = "(" + token + ")"
    return token


def _round_half_up(d: Decimal, places: int) -> Decimal:
    q = Decimal(1).scaleb(-places)  # 10^-places
    return d.quantize(q, rounding=ROUND_HALF_UP)


def _num_out(d: Optional[Decimal]) -> Optional[Any]:
    if d is None:
        return None
    # Emit int if integral, else float
    if d == d.to_integral_value():
        return int(d)
    return float(d)


# ---------------------------- parsing pipeline ----------------------------
class ParseContext:
    def __init__(self, raw: str):
        self.raw = raw
        self.values: Dict[str, Any] = {}


def parse_int(ctx: ParseContext, cfg: Dict[str, Any]) -> None:
    s = re.sub(r"[^0-9]", "", _clean(ctx.raw))
    if s:
        try:
            ctx.values[ctx.values.get("_target_field", "")] = int(s)
        except Exception:
            pass


def parse_number(ctx: ParseContext, cfg: Dict[str, Any]) -> None:
    nf = cfg.get("number_format", {})
    v = _to_decimal(ctx.raw, thousands=nf.get("thousands", ","), decimal=nf.get("decimal", "."),
                    allow_parens=nf.get("allow_parens", True))
    if v is not None:
        ctx.values[ctx.values.get("_target_field", "")] = v


def parse_money(ctx: ParseContext, cfg: Dict[str, Any]) -> None:
    nf = cfg.get("number_format", {})
    cur_hints = cfg.get("currency_hints") or []
    v = _to_decimal(ctx.raw, thousands=nf.get("thousands", ","), decimal=nf.get("decimal", "."),
                    allow_parens=nf.get("allow_parens", True), currency_hints=cur_hints)
    if v is not None:
        ctx.values[ctx.values.get("_target_field", "")] = v


def parse_first_number(ctx: ParseContext, cfg: Dict[str, Any]) -> None:
    token = _first_numeric_token(ctx.raw)
    if token is None:
        return
    nf = cfg.get("number_format", {})
    v = _to_decimal(token, thousands=nf.get("thousands", ","), decimal=nf.get("decimal", "."),
                    allow_parens=nf.get("allow_parens", True))
    if v is not None:
        ctx.values[ctx.values.get("_target_field", "")] = v


def parse_first_money(ctx: ParseContext, cfg: Dict[str, Any]) -> None:
    token = _first_numeric_token(ctx.raw)
    if token is None:
        return
    nf = cfg.get("number_format", {})
    cur_hints = cfg.get("currency_hints") or []
    v = _to_decimal(token, thousands=nf.get("thousands", ","), decimal=nf.get("decimal", "."),
                    allow_parens=nf.get("allow_parens", True), currency_hints=cur_hints)
    if v is not None:
        ctx.values[ctx.values.get("_target_field", "")] = v


def parse_percent(ctx: ParseContext, cfg: Dict[str, Any]) -> None:
    s = _clean(ctx.raw)
    m = _regex_search(r"([0-9]+(?:[.,][0-9]+)?)\s*%", s)
    if m:
        val = m.group(1)
        val = val.replace(",", ".")
        try:
            ctx.values[ctx.values.get("_target_field", "")] = Decimal(val) / Decimal(100)
        except InvalidOperation:
            pass


def split_qty_uom(ctx: ParseContext, cfg: Dict[str, Any]) -> None:
    s = _clean(ctx.raw)
    # common patterns: "6.90/KG", "6 KG", "6KG"
    m = _regex_search(r"([0-9]+(?:[.,][0-9]+)?)\s*[/\s]?\s*([A-Z]{1,6})\b", s)
    if not m:
        return
    qty_s = m.group(1).replace(",", ".")
    uom_s = m.group(2).upper()
    try:
        qty_d = Decimal(qty_s)
    except InvalidOperation:
        return
    ctx.values["qty"] = qty_d
    ctx.values["uom"] = uom_s


def strip_nonprint(ctx: ParseContext, cfg: Dict[str, Any]) -> None:
    s = ctx.raw or ""
    s = re.sub(r"[\x00-\x1F\x7F]", "", s)
    ctx.values[ctx.values.get("_target_field", "")] = _clean(s)


def normalize_sku(ctx: ParseContext, cfg: Dict[str, Any]) -> None:
    s = ctx.raw or ""
    s = _clean(s)
    if not s:
        ctx.values[ctx.values.get("_target_field", "")] = None
        return
    # Normalize hyphens/spaces
    s = s.replace(" – ", "-").replace(" — ", "-").replace("–", "-").replace("—", "-")
    s = re.sub(r"\s*-\s*", "-", s)

    # Extract leading SKU-like token
    m = re.match(r"^(?P<sku>[A-Za-z0-9][A-Za-z0-9\-]{2,})\b", s)
    sku = m.group("sku") if m else None

    # Remove SKU and optional parenthesized block just after it (e.g., "(120)")
    desc = s
    if sku:
        desc = desc[len(sku):].lstrip()
    desc = re.sub(r"^\(.*?\)\s*", "", desc)

    # Remove known boilerplate if present (no-space variants too)
    # Examples from sample: "This document is generated by computer. No signature is required."
    desc_nospace = re.sub(r"\s+", "", desc).lower()
    boiler_starts = [
        ("thisdocumentisgeneratedbycomputer", re.compile(r"this\s*document\s*is\s*generated\s*by\s*computer", re.I)),
        ("nosignatureisrequired", re.compile(r"no\s*signature\s*is\s*required\.?", re.I)),
    ]
    for key, pat in boiler_starts:
        if key in desc_nospace:
            desc = pat.split(desc)[0].strip()
            break

    # Improve readability: insert spaces at case and digit boundaries
    desc = re.sub(r"([a-z])([A-Z])", r"\1 \2", desc)
    desc = re.sub(r"([A-Za-z])([0-9])", r"\1 \2", desc)
    desc = re.sub(r"([0-9])([A-Za-z])", r"\1 \2", desc)
    desc = re.sub(r"\s*:\s*", ": ", desc)
    desc = re.sub(r"\s{2,}", " ", desc).strip()

    # Assign outputs
    if sku:
        ctx.values["sku"] = sku
    if desc:
        ctx.values.setdefault("description", desc)
    # Also set the target field if it is sku
    target = ctx.values.get("_target_field", "")
    if target:
        if target == "sku":
            ctx.values[target] = sku
        elif target == "description":
            ctx.values[target] = desc


PARSER_FUNCS = {
    "parse_int": parse_int,
    "parse_number": parse_number,
    "parse_money": parse_money,
    "parse_first_number": parse_first_number,
    "parse_first_money": parse_first_money,
    "parse_percent": parse_percent,
    "split_qty_uom": split_qty_uom,
    "strip_nonprint": strip_nonprint,
    "normalize_sku": normalize_sku,
}


# ---------------------------- data structures ----------------------------
@dataclass
class FieldSpec:
    name: str
    header_synonyms: List[str]
    position_hint: Optional[Tuple[float, float]]  # (x0,x1) relative [0..1]
    parsers: List[str]
    required: bool
    merge: bool


# ---------------------------- column mapping ----------------------------
def _compute_column_centers(table: Dict[str, Any]) -> Dict[int, float]:
    centers: Dict[int, float] = {}
    cols_data: Dict[int, List[float]] = {}
    for r in table.get("rows", []) or []:
        for c in r.get("cells", []) or []:
            col = int(c.get("col", 0))
            bbox = c.get("bbox") or {}
            x0 = bbox.get("x0")
            x1 = bbox.get("x1")
            if x0 is None or x1 is None:
                continue
            xcenter = (float(x0) + float(x1)) / 2.0
            cols_data.setdefault(col, []).append(xcenter)
    for col, xs in cols_data.items():
        if xs:
            centers[col] = sum(xs) / len(xs)
    # Fallback: try header_cells if row cells had no bbox
    if not centers:
        for c in (table.get("header_cells") or []):
            col = int(c.get("col", 0))
            x0 = c.get("x0")
            x1 = c.get("x1")
            if x0 is None or x1 is None:
                continue
            centers[col] = (float(x0) + float(x1)) / 2.0
    return centers


def _concat_header_by_col(table: Dict[str, Any]) -> Dict[int, str]:
    # Concatenate header text per column index
    by_col: Dict[int, str] = {}
    for hc in (table.get("header_cells") or []):
        col = int(hc.get("col", 0))
        txt = _clean(hc.get("text_norm") or hc.get("text") or "")
        by_col[col] = (by_col.get(col, "") + " " + txt).strip()
    return by_col


def _map_columns(table: Dict[str, Any], cfg: Dict[str, Any]) -> Dict[int, str]:
    fields_cfg = cfg.get("fields") or {}
    # Build specs
    specs: Dict[str, FieldSpec] = {}
    for fname, spec in fields_cfg.items():
        specs[fname] = FieldSpec(
            name=fname,
            header_synonyms=list(spec.get("header_synonyms", []) or []),
            position_hint=(
                float(spec.get("position_hint", {}).get("x0")) if spec.get("position_hint") else None,
                float(spec.get("position_hint", {}).get("x1")) if spec.get("position_hint") else None,
            ) if spec.get("position_hint") else None,
            parsers=list(spec.get("parsers", []) or []),
            required=bool(spec.get("required", False)),
            merge=bool(spec.get("merge", False)),
        )

    header_by_col = _concat_header_by_col(table)
    col_centers = _compute_column_centers(table)

    # First pass: header_synonyms scoring
    mapping: Dict[int, Tuple[str, Tuple[int, int]]] = {}
    # store (field_name, (priority, match_len)) per col; priority: 2 whole-token, 1 partial

    for col, htxt in header_by_col.items():
        best: Optional[Tuple[str, Tuple[int, int]]] = None
        for fname, fs in specs.items():
            for syn in fs.header_synonyms:
                for m in _regex_findall(syn, htxt):
                    whole = _is_whole_token_match(htxt, m)
                    score = (2 if whole else 1, len(m.group(0)))
                    cand = (fname, score)
                    if best is None or score > best[1]:
                        best = cand
        if best is not None:
            mapping[col] = best

    # Resolve per-column best field from mapping
    final_map: Dict[int, str] = {col: name for col, (name, _) in mapping.items()}

    # Second pass: position_hint for missing/ambiguous fields
    for fname, fs in specs.items():
        if not fs.position_hint:
            continue
        # skip if already mapped (any column currently mapped to this field)
        if fname in final_map.values():
            continue
        x0, x1 = fs.position_hint
        mid = (x0 + x1) / 2.0
        best_col = None
        best_dist = None
        for col, xc in col_centers.items():
            if xc < x0 or xc > x1:
                continue
            dist = abs(xc - mid)
            if best_dist is None or dist < best_dist or (dist == best_dist and (best_col is None or col < best_col)):
                best_col = col
                best_dist = dist
        if best_col is not None and best_col not in final_map:
            final_map[best_col] = fname

    return final_map


# ---------------------------- row filtering ----------------------------
def _is_drop_row(row_text: str, cfg: Dict[str, Any]) -> bool:
    patterns = cfg.get("row_filters", []) or []
    for p in patterns:
        if _regex_search(p, row_text):
            return True
    # also drop fully blank rows
    if _clean(row_text) == "":
        return True
    return False


# ---------------------------- UOM resolution ----------------------------
def _resolve_uom(row_vals: Dict[str, Any], header_text: str, cfg: Dict[str, Any]) -> Optional[str]:
    # row
    if row_vals.get("uom"):
        return str(row_vals["uom"]).upper()

    uom_cfg = cfg.get("uom", {})
    # header unit suffix
    for pat in uom_cfg.get("header_suffix_patterns", []) or []:
        for m in _regex_findall(pat, header_text):
            u = m.groupdict().get("uom")
            if u:
                return u.upper()

    # doc patterns over header_text (or provided region; not supplied here)
    for pat in uom_cfg.get("doc_patterns", []) or []:
        for m in _regex_findall(pat, header_text):
            u = m.groupdict().get("uom")
            if u:
                return u.upper()

    # default
    default_uom = cfg.get("defaults", {}).get("uom")
    return default_uom.upper() if isinstance(default_uom, str) and default_uom else default_uom


# ---------------------------- discounts & proration ----------------------------
@dataclass
class DiscountInfo:
    doc_percent: Optional[Decimal]
    doc_amount: Optional[Decimal]
    price_already_discounted: bool
    applies_before_tax: bool
    prorate_base: str  # "pre_discount_amount" | "qty"
    rounding: str      # currently unused granularity flag, kept for contract
    reconcile: str     # e.g., "largest_line"


def _detect_doc_discounts(header_text: str, cfg: Dict[str, Any]) -> Tuple[Optional[Decimal], Optional[Decimal]]:
    dc = cfg.get("discount", {})
    pct = None
    amt = None
    for pat in dc.get("doc_percent_patterns", []) or []:
        m = _regex_search(pat, header_text)
        if m:
            g = m.groupdict().get("pct") or m.group(1) if m.groups() else None
            if g:
                try:
                    pct = Decimal(g.replace(",", ".")) / Decimal(100)
                    break
                except InvalidOperation:
                    pass
    for pat in dc.get("doc_amount_patterns", []) or []:
        m = _regex_search(pat, header_text)
        if m:
            g = m.groupdict().get("amt") or m.group(1) if m.groups() else None
            if g:
                try:
                    g2 = re.sub(r"[^0-9.,]", "", g).replace(",", "")
                    amt = Decimal(g2)
                    break
                except InvalidOperation:
                    pass
    return pct, amt


def _apply_discounts(items: List[Dict[str, Any]], cfg: Dict[str, Any], notes: List[str]) -> None:
    if not items:
        return
    currency_decimals = int(cfg.get("currency_decimals", 2) or 0)
    disc_cfg = cfg.get("discount", {})
    doc_pct = disc_cfg.get("_doc_percent")
    doc_amt = disc_cfg.get("_doc_amount")
    if doc_pct is None or doc_amt is None:
        # Nothing detected; try patterns via cached header_text
        pass

    price_already_discounted = bool(disc_cfg.get("price_already_discounted", False))
    applies_before_tax = bool(disc_cfg.get("applies_before_tax", True))
    prorate_base = str((disc_cfg.get("prorate") or {}).get("base") or "pre_discount_amount")
    rounding_mode = str(disc_cfg.get("rounding") or "per_line")
    reconcile_target = str(disc_cfg.get("reconcile") or "largest_line")

    # Pass 1
    weights: List[Decimal] = []
    for it in items:
        qty = it.get("qty")
        up = it.get("unit_price")
        # qty/up here are Decimal in temp fields; at this point items store Decimal in _d fields
        qty_d: Optional[Decimal] = it.get("_qty_d")
        up_d: Optional[Decimal] = it.get("_unit_price_d")
        if qty_d is None or up_d is None:
            it["_line_base"] = Decimal(0)
            weights.append(Decimal(0))
            continue
        line_base = _round_half_up(qty_d * up_d, currency_decimals)
        it["_line_base"] = line_base

        row_pct: Optional[Decimal] = it.get("_discount_percent_d")
        row_amt: Optional[Decimal] = it.get("_discount_amount_d")
        row_discount = Decimal(0)
        if row_pct is not None:
            row_discount = _round_half_up(row_pct * line_base, currency_decimals)
        if row_amt is not None:
            row_discount = max(row_discount, _round_half_up(row_amt, currency_decimals))
        weight = max(line_base - row_discount, Decimal(0))
        it["_row_discount"] = row_discount
        weights.append(weight)

    sum_weight = sum(weights) if weights else Decimal(0)

    # Pass 2: allocate doc-level discounts
    allocations: List[Decimal] = [Decimal(0)] * len(items)
    if disc_cfg.get("doc_percent") is not None:
        doc_pct = Decimal(disc_cfg.get("doc_percent"))
    if disc_cfg.get("doc_amount") is not None:
        doc_amt = Decimal(disc_cfg.get("doc_amount"))

    if doc_pct is not None:
        for i, w in enumerate(weights):
            allocations[i] = _round_half_up((doc_pct * w), currency_decimals)
    elif doc_amt is not None and sum_weight > 0:
        # proportional split
        raw_allocs = [doc_amt * (w / sum_weight) for w in weights]
        rounded = [_round_half_up(a, currency_decimals) for a in raw_allocs]
        diff = _round_half_up(doc_amt - sum(rounded), currency_decimals)
        if diff != 0:
            # reconcile remainder on target
            idx = 0
            if reconcile_target == "largest_line":
                # choose largest line_base after row_discount
                idx = max(range(len(items)), key=lambda i: (weights[i], i))
            rounded[idx] = _round_half_up(rounded[idx] + diff, currency_decimals)
        allocations = rounded

    # Finalize per line
    for i, it in enumerate(items):
        row_discount = it.get("_row_discount") or Decimal(0)
        alloc = allocations[i]
        discount_total = _round_half_up(row_discount + alloc, currency_decimals)
        if discount_total != 0:
            it["discount_amount"] = _num_out(discount_total)
        # Derive percent if base>0 and row percent missing, only when non-zero
        line_base = it.get("_line_base") or Decimal(0)
        if line_base > 0 and it.get("_discount_percent_d") is None and discount_total != 0:
            pct = (discount_total / line_base) if line_base != 0 else None
            it["discount_percent"] = _num_out(_round_half_up(pct, 6)) if pct is not None else None
        elif it.get("_discount_percent_d") is not None:
            it["discount_percent"] = _num_out(it.get("_discount_percent_d"))


# ---------------------------- core processing ----------------------------
def _parse_field_value(raw: str, field_name: str, field_spec: FieldSpec, cfg: Dict[str, Any]) -> Dict[str, Any]:
    ctx = ParseContext(raw)
    # Mark current target field
    ctx.values["_target_field"] = field_name
    for p in field_spec.parsers:
        fn = PARSER_FUNCS.get(p)
        if not fn:
            raise ValueError(f"Unknown parser: {p}")
        fn(ctx, cfg)
    # Remove internal marker
    ctx.values.pop("_target_field", None)
    return ctx.values


def _build_item_from_row(row_cells: List[Dict[str, Any]], colmap: Dict[int, str], cfg: Dict[str, Any],
                         header_text: str, field_specs: Dict[str, FieldSpec], notes: List[str],
                         from_header: bool = False) -> Optional[Dict[str, Any]]:
    # Gather raw text per mapped field
    raw_by_field: Dict[str, str] = {}
    for c in row_cells:
        col = int(c.get("col", 0))
        f = colmap.get(col)
        if not f:
            continue
        raw_by_field[f] = _clean(c.get("text_norm") or c.get("text") or "")

    # Row-level filtering
    row_text = " ".join(_clean(c.get("text_norm") or c.get("text") or "") for c in row_cells)
    if not from_header and _is_drop_row(row_text, cfg):
        return None

    # Parse fields
    parsed: Dict[str, Any] = {}
    for fname, raw in raw_by_field.items():
        fs = field_specs.get(fname)
        if not fs:
            continue
        vals = _parse_field_value(raw, fname, fs, cfg)
        parsed.update(vals)

    # Required fields defaulting
    defaults = cfg.get("defaults", {}) or {}
    for fname, fs in field_specs.items():
        if fs.required and (fname not in parsed or parsed.get(fname) in (None, "")):
            if fname in defaults and defaults[fname] is not None:
                parsed[fname] = defaults[fname]
                notes.append(f"defaulted {fname}")

    # UOM resolution
    uom_val = _resolve_uom(parsed, header_text, cfg)
    if uom_val is not None:
        parsed["uom"] = uom_val

    # Build item output structure
    currency_decimals = int(cfg.get("currency_decimals", 2) or 0)
    # Convert typed numerics from Decimal to output types and cache Decimals for arithmetic
    def as_dec(v: Any) -> Optional[Decimal]:
        if v is None:
            return None
        if isinstance(v, Decimal):
            return v
        if isinstance(v, (int, float)):
            try:
                return Decimal(str(v))
            except Exception:
                return None
        if isinstance(v, str):
            return _to_decimal(v)
        return None

    no_val = parsed.get("no")
    if isinstance(no_val, Decimal):
        try:
            parsed["no"] = int(no_val)
        except Exception:
            parsed["no"] = None

    qty_d = as_dec(parsed.get("qty"))
    up_d = as_dec(parsed.get("unit_price"))
    amt_d = as_dec(parsed.get("amount"))
    disc_pct_d = as_dec(parsed.get("discount_percent"))
    disc_amt_d = as_dec(parsed.get("discount_amount"))

    item: Dict[str, Any] = {
        "no": parsed.get("no"),
        "hs_code": parsed.get("hs_code"),
        "sku": parsed.get("sku"),
        "code": parsed.get("code"),
        "description": parsed.get("description"),
        "qty": _num_out(qty_d) if qty_d is not None else None,
        "uom": parsed.get("uom"),
        "unit_price": _num_out(_round_half_up(up_d, currency_decimals)) if up_d is not None else None,
        "discount_amount": None,
        "discount_percent": None,
        "amount": None,
        # internal decimals for further processing
        "_qty_d": qty_d,
        "_unit_price_d": up_d,
        "_amount_d": amt_d,
        "_discount_percent_d": disc_pct_d,
        "_discount_amount_d": disc_amt_d,
    }

    if (cfg.get("row_split") or {}).get("enabled", False):
        item["_raw_fields"] = raw_by_field

    # Normalize empty strings to None for text fields
    for key in ("hs_code", "sku", "code", "description"):
        if isinstance(item.get(key), str) and item.get(key) == "":
            item[key] = None

    # Additional gating to avoid non-item rows: require economic coherence
    has_desc = bool(_clean(item.get("description") or ""))
    has_qty = item.get("_qty_d") is not None
    has_up = item.get("_unit_price_d") is not None
    has_amt = item.get("_amount_d") is not None
    if not ((has_desc and (has_qty or has_up or has_amt)) or (has_qty and has_up)):
        return None

    return item


def _split_multivalue_item(item: Dict[str, Any], cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    split_cfg = cfg.get("row_split") or {}
    if not split_cfg.get("enabled", False):
        item.pop("_raw_fields", None)
        return [item]

    fields_cfg: Dict[str, str] = split_cfg.get("fields") or {}
    if not fields_cfg:
        item.pop("_raw_fields", None)
        return [item]

    raw_fields: Dict[str, str] = item.get("_raw_fields") or {}
    splits: Dict[str, List[str]] = {}
    max_len = 0
    for field, pattern in fields_cfg.items():
        raw = raw_fields.get(field)
        if not raw:
            continue
        pat = pattern or r"\s+"
        tokens = [tok for tok in re.split(pat, raw) if tok and _clean(tok)]
        if not tokens:
            continue
        if field != "sku":
            numeric_tokens = [tok for tok in tokens if any(ch.isdigit() for ch in tok)]
            if numeric_tokens:
                tokens = numeric_tokens
            else:
                continue
        if field == "sku":
            tokens = [tok for tok in tokens if any(ch.isalnum() for ch in tok)]
            if not tokens:
                continue
            if any(not any(ch.isdigit() for ch in tok) for tok in tokens):
                continue
        if len(tokens) > 1:
            splits[field] = tokens
            if len(tokens) > max_len:
                max_len = len(tokens)

    if max_len <= 1:
        item.pop("_raw_fields", None)
        return [item]

    nf = cfg.get("number_format") or {}
    thousands = nf.get("thousands", ",")
    decimal_sep = nf.get("decimal", ".")
    allow_parens = nf.get("allow_parens", True)
    currency_decimals = int(cfg.get("currency_decimals", 2) or 0)
    currency_hints = cfg.get("currency_hints") or []

    results: List[Dict[str, Any]] = []
    for idx in range(max_len):
        clone = copy.deepcopy(item)
        for field, tokens in splits.items():
            token = tokens[idx] if idx < len(tokens) else tokens[-1]
            token = token.strip()
            if field in ("sku", "description", "code"):
                clone[field] = token or clone.get(field)
                continue
            if field == "qty":
                val = _to_decimal(token, thousands=thousands, decimal=decimal_sep, allow_parens=allow_parens)
                clone["_qty_d"] = val
                clone["qty"] = _num_out(val) if val is not None else None
                continue
            if field in ("unit_price", "amount", "discount_amount"):
                val = _to_decimal(token, thousands=thousands, decimal=decimal_sep,
                                  allow_parens=allow_parens, currency_hints=currency_hints)
                if field == "unit_price":
                    clone["_unit_price_d"] = val
                    clone["unit_price"] = _num_out(_round_half_up(val, currency_decimals)) if val is not None else None
                elif field == "amount":
                    clone["_amount_d"] = val
                    clone["amount"] = _num_out(_round_half_up(val, currency_decimals)) if val is not None else None
                else:  # discount_amount
                    clone["_discount_amount_d"] = val
                    clone["discount_amount"] = _num_out(_round_half_up(val, currency_decimals)) if val is not None else None
                continue
            # Fallback text field
            clone[field] = token or clone.get(field)
        clone.pop("_raw_fields", None)
        results.append(clone)

    return results


def _finalize_amounts_and_validate(items: List[Dict[str, Any]], cfg: Dict[str, Any], notes: List[str]) -> None:
    tolerances = ((cfg.get("tolerances") or {}).get("amount_from_qty_price") or {"abs": 0, "rel": 0})
    abs_tol = Decimal(str(tolerances.get("abs", 0)))
    rel_tol = Decimal(str(tolerances.get("rel", 0)))
    currency_decimals = int(cfg.get("currency_decimals", 2) or 0)

    for it in items:
        it.pop("_raw_fields", None)
        qty = it.get("_qty_d")
        up = it.get("_unit_price_d")
        amt_src = it.get("_amount_d")
        computed = None
        if qty is not None and up is not None:
            computed = _round_half_up(qty * up, currency_decimals)
        if computed is None:
            it["amount"] = _num_out(amt_src) if amt_src is not None else None
            continue
        # Compare if src amount exists
        if amt_src is not None:
            diff = abs(computed - amt_src)
            thresh = abs_tol + (rel_tol * (abs(computed)))
            if diff > thresh:
                notes.append("amount recomputed from qty*unit_price")
        it["amount"] = _num_out(computed)


def _maybe_parse_header_as_row(table: Dict[str, Any], cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    # Convert header_cells into a pseudo-row only when it clearly contains line data
    header_cells = table.get("header_cells") or []
    if not header_cells:
        return []
    header_text = _join_header_texts(header_cells)
    header_opts = cfg.get("header_row") or {}
    force_as_row = bool(header_opts.get("as_data", False))
    allow_detect = header_opts.get("allow_detect", True)
    if not allow_detect and not force_as_row:
        return []
    looks_like_line = force_as_row or bool(
        (_regex_search(r"\b\d+(?:[.,]\d+)?\s*/\s*[A-Za-z]{1,6}\b", header_text) or
         _regex_search(r"\bUSD\b\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?", header_text)) if allow_detect else False
    )
    if not looks_like_line:
        return []
    hdr = []
    for hc in header_cells:
        hdr.append({
            "col": int(hc.get("col", 0)),
            "text": hc.get("text"),
            "text_norm": hc.get("text_norm"),
        })
    return [{"cells": hdr, "_from_header": True}]


def process(input_path: Path, config_path: Path) -> Dict[str, Any]:
    data = json.loads(input_path.read_text(encoding="utf-8"))
    cfg = json.loads(config_path.read_text(encoding="utf-8"))

    notes: List[str] = []

    # cache header text corpus (for UOM/doc discount detection)
    header_text_corpus = []
    items: List[Dict[str, Any]] = []

    for page in data.get("pages", []) or []:
        table = (page.get("table") or {})
        if not table:
            continue

        header_text = _join_header_texts(table.get("header_cells") or [])
        header_text_corpus.append(header_text)

        colmap = _map_columns(table, cfg)

        # Build field specs for parsing
        field_specs: Dict[str, FieldSpec] = {}
        for fname, spec in (cfg.get("fields") or {}).items():
            field_specs[fname] = FieldSpec(
                name=fname,
                header_synonyms=list(spec.get("header_synonyms", []) or []),
                position_hint=(
                    float(spec.get("position_hint", {}).get("x0")) if spec.get("position_hint") else None,
                    float(spec.get("position_hint", {}).get("x1")) if spec.get("position_hint") else None,
                ) if spec.get("position_hint") else None,
                parsers=list(spec.get("parsers", []) or []),
                required=bool(spec.get("required", False)),
                merge=bool(spec.get("merge", False)),
            )

        # Try header row as a potential data row first (handles one-row tables)
        pseudo_rows = _maybe_parse_header_as_row(table, cfg)
        for r in pseudo_rows + (table.get("rows") or []):
            cells = r.get("cells") or []
            item = _build_item_from_row(
                cells,
                colmap,
                cfg,
                header_text,
                field_specs,
                notes,
                from_header=bool(r.get("_from_header"))
            )
            if item:
                for expanded in _split_multivalue_item(item, cfg):
                    items.append(expanded)

    # Assign sequential NO if missing
    seq = 1
    for it in items:
        if it.get("no") in (None, ""):
            it["no"] = seq
            seq += 1

    # Detect doc-level discounts from header corpus
    header_all = " ".join(header_text_corpus)
    doc_pct, doc_amt = _detect_doc_discounts(header_all, cfg)
    if doc_pct is not None:
        cfg.setdefault("discount", {})["doc_percent"] = doc_pct
    if doc_amt is not None:
        cfg.setdefault("discount", {})["doc_amount"] = doc_amt

    # Compute discounts (two-pass)
    _apply_discounts(items, cfg, notes)

    # Finalize amounts and validate
    _finalize_amounts_and_validate(items, cfg, notes)

    # Build final items (drop internal keys)
    final_items: List[Dict[str, Any]] = []
    for it in items:
        out = {
            "no": it.get("no"),
            "hs_code": it.get("hs_code"),
            "sku": it.get("sku"),
            "code": it.get("code"),
            "description": it.get("description"),
            "qty": it.get("qty"),
            "uom": it.get("uom"),
            "unit_price": it.get("unit_price"),
            "discount_amount": it.get("discount_amount"),
            "discount_percent": it.get("discount_percent"),
            "amount": it.get("amount"),
        }
        final_items.append(out)

    # Compose notes (≤200 chars)
    note_str = "; ".join(dict.fromkeys([_clean(n) for n in notes if _clean(n)]))[:200]
    if not note_str:
        note_str = "Families derived solely from config (Stage 6)."

    # Output JSON aligned with GOLD structure
    out = {
        "doc_id": data.get("doc_id"),
        "items": final_items,
        "stage": "line_items",
        "version": "2.1-config-only",
        "notes": note_str or ""
    }
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 06 – Line-Item Structuring (deterministic)")
    ap.add_argument("--input", required=True, help="05-cells-normalized.json")
    ap.add_argument("--config", required=True, help="vendor config JSON")
    ap.add_argument("--out", required=True, help="output 06-items.json")
    args = ap.parse_args()

    out = process(Path(args.input), Path(args.config))
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # print small preview
    preview = [{
        "no": it.get("no"),
        "desc": it.get("description"),
        "qty": it.get("qty"),
        "unit_price": it.get("unit_price"),
        "amount": it.get("amount"),
    } for it in out.get("items", [])[:3]]
    print(json.dumps({"stage": out.get("stage"), "doc_id": out.get("doc_id"), "count": len(out.get("items", [])), "first_n": preview, "out": str(out_path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
