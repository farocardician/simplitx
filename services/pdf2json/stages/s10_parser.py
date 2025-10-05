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
import argparse, json, hashlib, os, re, sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

MONEY_QUANT = Decimal("0.01")

def money(x: Decimal | float | int | None) -> float | None:
    if x is None: return None
    q = Decimal(str(x)).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
    return float(q)

def set_money_precision(places: int) -> None:
    global MONEY_QUANT
    try:
        MONEY_QUANT = Decimal("1").scaleb(-int(places))
    except Exception:
        MONEY_QUANT = Decimal("0.01")

def loadj(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8"))

def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(131072), b""):
            h.update(chunk)
    return h.hexdigest()

def load_config(p: Path) -> Dict[str, Any]:
    cfg = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(cfg, dict):
        raise ValueError("Config root must be an object")
    cfg.setdefault("metadata", {})
    cfg.setdefault("defaults", {})
    cfg.setdefault("header", {})
    cfg.setdefault("items", {})
    cfg.setdefault("totals", {})
    cfg.setdefault("manifest", {})
    return cfg


def persist_to_database(doc_id: str, final_doc: Dict[str, Any], manifest: Dict[str, Any]) -> None:
    """Persist the parser output to Postgres when DATABASE_URL is configured."""
    if not doc_id:
        return

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        return

    try:
        import psycopg
        from psycopg.types.json import Json
    except ImportError:
        print("[s10_parser] psycopg not installed; skipping database persistence", file=sys.stderr)
        return

    try:
        with psycopg.connect(database_url, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS parser_results (
                        doc_id TEXT PRIMARY KEY,
                        final JSONB NOT NULL,
                        manifest JSONB NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                cur.execute(
                    """
                    INSERT INTO parser_results (doc_id, final, manifest)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (doc_id) DO UPDATE
                    SET final = EXCLUDED.final,
                        manifest = EXCLUDED.manifest,
                        updated_at = NOW()
                    """,
                    (doc_id, Json(final_doc), Json(manifest))
                )
    except Exception as exc:
        print(f"[s10_parser] failed to persist results for doc_id={doc_id}: {exc}", file=sys.stderr)


def get_nested(data: Any, path: List[str]) -> Any:
    cur = data
    for key in path:
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(key)
        else:
            return None
    return cur

def parse_field_from_text(text: str, cfg: Dict[str, Any]) -> Optional[Any]:
    s = (text or "").strip()
    if s == "":
        return None
    typ = cfg.get("type", "string")
    if typ == "int":
        return int(s) if is_int_str(s) else None
    if typ == "decimal":
        try:
            return float(s)
        except ValueError:
            return None
    if typ == "string":
        return s
    return s

def normalize_value(val: Any, cfg: Dict[str, Any]) -> Any:
    if val is None:
        return None
    typ = cfg.get("type", "string")
    if typ == "int":
        if isinstance(val, int):
            return val
        if isinstance(val, str) and is_int_str(val):
            return int(val.strip())
    if typ == "decimal":
        try:
            return float(val)
        except (TypeError, ValueError):
            return val
    if typ == "string" and isinstance(val, str):
        s = val.strip()
        return s if s else None
    return val

def apply_transform(val: Any, transform: Optional[str]) -> Any:
    if transform is None:
        return val
    if transform == "money":
        return money(val)
    if transform == "int":
        if val is None:
            return None
        if isinstance(val, int):
            return val
        if isinstance(val, str) and is_int_str(val):
            return int(val.strip())
        if isinstance(val, (float, Decimal)):
            return int(val)
        return val
    if transform == "string" and isinstance(val, str):
        s = val.strip()
        return s if s else None
    return val

def text_matches_rule(text: str, target: str, rule: Dict[str, Any]) -> bool:
    match_type = (rule.get("match") or "contains").lower()
    if not target:
        return False
    case_sensitive = rule.get("case_sensitive", False)
    if not case_sensitive:
        text_cmp = (text or "").lower()
        target_cmp = target.lower()
    else:
        text_cmp = text or ""
        target_cmp = target
    if match_type == "equals":
        return text_cmp == target_cmp
    if match_type == "regex":
        pattern = rule.get("pattern") or target
        flags = 0 if case_sensitive else re.IGNORECASE
        return re.search(pattern, text or "", flags=flags) is not None
    # default contains
    return target_cmp in text_cmp

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

def map_item_rows_by_no(cells_doc: Dict[str, Any], item_cfg: Dict[str, Any]) -> Dict[Any, Dict[str, Any]]:
    """Build a mapping: item key -> {"page": int, "cells": [cells...]}."""
    fields_cfg: List[Dict[str, Any]] = item_cfg.get("fields") or []
    field_map = {f.get("name"): f for f in fields_cfg if f.get("name") is not None}
    if not field_map:
        return {}
    key_field = item_cfg.get("key_field") or (fields_cfg[0].get("name") if fields_cfg else None)
    key_info = field_map.get(key_field)
    if not key_info:
        return {}
    key_col = key_info.get("column")
    if key_col is None:
        return {}
    min_columns = item_cfg.get("min_columns", 0)
    header_as_items = bool(item_cfg.get("header_rows_can_hold_items"))
    max_required_col = max([cfg.get("column", -1) for cfg in field_map.values()] + [key_col])

    def collect_row(cells: List[Dict[str, Any]], page_no: int) -> None:
        if not cells:
            return
        normalized = [{"col": c.get("col"), "text": cell_text(c), "bbox": bbox_of(c)} for c in cells]
        if len(normalized) <= max_required_col:
            return
        if min_columns and len(normalized) < min_columns:
            return
        key_cell = normalized[key_col]
        key_val = parse_field_from_text(key_cell["text"], key_info)
        if key_val is None:
            return
        out.setdefault(key_val, {"page": page_no, "cells": normalized})

    out: Dict[Any, Dict[str, Any]] = {}
    for page_no, hdr, rows in cells_iter(cells_doc):
        if header_as_items and hdr:
            collect_row(hdr, page_no)
        for r in rows:
            collect_row(r.get("cells", []), page_no)
    return out

def header_backrefs(cells_doc: Dict[str, Any], field_values: Dict[str, Optional[str]], header_cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Find cell bbox references for configured header fields."""
    refs: Dict[str, Any] = {}
    if not field_values:
        return refs
    pages = header_cfg.get("pages") or [1]
    max_rows = header_cfg.get("search_row_limit", 25)
    fields_cfg = header_cfg.get("fields") or {}
    pages_set = set(pages) if pages else set()
    seen_pages: set[int] = set()
    for page_no, hdr, rows in cells_iter(cells_doc):
        if pages_set and page_no not in pages_set:
            continue
        search_cells: List[Dict[str, Any]] = []
        search_cells.extend(hdr)
        row_limit = max_rows if max_rows is not None else len(rows)
        for r in rows[:row_limit]:
            search_cells.extend(r.get("cells", []))
        for c in search_cells:
            text = cell_text(c)
            for field_name, target in field_values.items():
                if target is None or field_name in refs:
                    continue
                rule = fields_cfg.get(field_name, {})
                if text_matches_rule(text, target, rule):
                    alias = rule.get("alias") or field_name
                    refs[alias] = {"page": page_no, "bbox": bbox_of(c)}
        seen_pages.add(page_no)
        if pages_set and pages_set.issubset(seen_pages):
            break
    return refs


def s7_value_text(field_entry: Any) -> Optional[str]:
    """Extract value_text from Stage-7 field entry (V3), or return the scalar if already a string."""
    if field_entry is None:
        return None
    if isinstance(field_entry, dict):
        val = field_entry.get("value_text") or field_entry.get("raw_text")
        return val if isinstance(val, str) and val.strip() != "" else None
    if isinstance(field_entry, str):
        s = field_entry.strip()
        return s if s else None
    return None

def main():
    ap = argparse.ArgumentParser(description="Stage 12 — Final Assembly")
    ap.add_argument("--fields", required=True)
    ap.add_argument("--items", required=True)
    ap.add_argument("--validation", required=True)
    ap.add_argument("--confidence", required=True)
    ap.add_argument("--cells", required=True)
    ap.add_argument("--final", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--config", required=True)
    args = ap.parse_args()

    fields_p = Path(args.fields).resolve()
    items_p = Path(args.items).resolve()
    validation_p = Path(args.validation).resolve()
    confidence_p = Path(args.confidence).resolve()
    cells_p = Path(args.cells).resolve()
    final_p = Path(args.final).resolve()
    manifest_p = Path(args.manifest).resolve()
    config_p = Path(args.config).resolve()
    final_p.parent.mkdir(parents=True, exist_ok=True)

    f = loadj(fields_p)
    i = loadj(items_p)
    v = loadj(validation_p)
    c = loadj(confidence_p)
    cells_doc = loadj(cells_p)
    config = load_config(config_p)

    metadata_cfg = config.get("metadata", {})
    defaults_cfg = config.get("defaults", {})
    money_places = metadata_cfg.get("money_rounding")
    if money_places is None:
        money_places = defaults_cfg.get("money_rounding")
    if money_places is None:
        money_places = 2
    money_places = int(money_places)
    set_money_precision(money_places)

    # Header
    hdr = f.get("header", {}) or {}
    # Support Stage-7 V3 (field objects with value_text) and legacy scalars
    invoice_number = s7_value_text(hdr.get("invoice_number"))
    invoice_date = s7_value_text(hdr.get("invoice_date"))
    # Some profiles expose customer ID as 'customer_id' (map to buyer_id)
    buyer_id = s7_value_text(hdr.get("buyer_id")) or s7_value_text(hdr.get("customer_id"))
    # Buyer name/address may be absent in segment-only V3
    buyer_name = s7_value_text(hdr.get("buyer_name"))
    seller_name = s7_value_text(hdr.get("seller_name")) or s7_value_text(hdr.get("seller"))
    currency = s7_value_text(hdr.get("currency")) or v.get("currency") or defaults_cfg.get("currency")

    # Items (already deterministic order in previous stage)
    items = i.get("items", [])
    items_cfg = config.get("items", {})
    items_fields_cfg: List[Dict[str, Any]] = items_cfg.get("fields") or []
    item_field_map = {f.get("name"): f for f in items_fields_cfg if f.get("name") is not None}
    key_field = items_cfg.get("key_field") or (items_fields_cfg[0].get("name") if items_fields_cfg else None)

    def sort_key(kv: Tuple[int, Dict[str, Any]]) -> Tuple[int, int, Any, int]:
        idx, item_entry = kv
        if key_field and key_field in item_field_map:
            raw_val = item_entry.get(key_field)
            normalized = normalize_value(raw_val, item_field_map[key_field])
            if isinstance(normalized, (int, float)):
                return (0, 0, float(normalized), idx)
            if normalized is None:
                return (1, 0, 0, idx)
            return (0, 1, str(normalized), idx)
        return (1, 0, 0, idx)

    items_sorted = sorted(enumerate(items), key=sort_key)

    # Map row geometry backrefs by item NO
    rowmap = map_item_rows_by_no(cells_doc, items_cfg)

    # Build items with per-field backrefs (page + bbox from the matched cell)
    def ref_for(key_val: Any, field_name: str) -> Optional[Dict[str, Any]]:
        if key_val is None:
            return None
        field_info = item_field_map.get(field_name)
        if not field_info:
            return None
        col = field_info.get("column")
        if col is None:
            return None
        entry = rowmap.get(key_val)
        if not entry:
            return None
        cells = entry.get("cells", [])
        if col >= len(cells):
            return None
        return {"page": entry.get("page"), "bbox": cells[col]["bbox"]}

    items_out: List[Dict[str, Any]] = []
    for _, it in items_sorted:
        key_val = None
        if key_field and key_field in item_field_map:
            key_val = normalize_value(it.get(key_field), item_field_map[key_field])
        entry: Dict[str, Any] = {}
        refs: Dict[str, Any] = {}
        for field_def in items_fields_cfg:
            name = field_def.get("name")
            if not name:
                continue
            transform = field_def.get("transform")
            value = apply_transform(it.get(name), transform)
            entry[name] = value
            refs[name] = ref_for(key_val, name)
        entry["_refs"] = refs
        items_out.append(entry)

    # Totals (prefer Stage‑8 printed; fallback to computed)
    totals_cfg = config.get("totals", {})
    tax_label = totals_cfg.get("tax_label") or defaults_cfg.get("tax_label")
    v_tot = (v.get("totals") or {})
    printed = (v_tot.get("printed") or {})
    computed = (v_tot.get("computed") or {})
    checks = (v_tot.get("checks") or {})
    totals_sources = {
        "printed": printed,
        "computed": computed,
        "checks": checks
    }

    def resolve_total(field_name: str) -> Any:
        field_cfg = totals_cfg.get("fields", {}).get(field_name)
        if field_cfg is None:
            return None
        sources = field_cfg if isinstance(field_cfg, list) else [field_cfg]
        for src in sources:
            if isinstance(src, dict):
                source_path = src.get("source")
            else:
                source_path = src
            if not source_path:
                continue
            if isinstance(source_path, str):
                parts = source_path.split(".")
            else:
                parts = list(source_path)
            if not parts:
                continue
            root = totals_sources.get(parts[0])
            value = get_nested(root, parts[1:]) if parts[1:] else root
            if value is not None:
                return value
        return None

    subtotal_val = resolve_total("subtotal")
    totals = {
        "subtotal": money(subtotal_val),
        "tax_base": money(resolve_total("tax_base")),
        "tax_label": tax_label,
        "tax_amount": money(resolve_total("tax_amount")),
        "grand_total": money(resolve_total("grand_total")),
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
    header_values = {
        "invoice_number": invoice_number,
        "invoice_date": invoice_date,
    }
    hdr_refs = header_backrefs(cells_doc, header_values, config.get("header", {}))

    final = {
        "doc_id": f.get("doc_id"),
        "buyer_id": buyer_id,
        "invoice": {"number": invoice_number, "date": invoice_date},
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
                "cells": str(cells_p),
                "config": str(config_p)
            }
        },
        "stage": "final",
        "version": "1.0"
    }

    # Manifest with hashes
    schema_cfg = config.get("manifest", {})
    template_name = schema_cfg.get("schema_template") or metadata_cfg.get("template") or ""
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
            "config": {"path": str(config_p), "sha256": sha256_file(config_p)},
        },
        "schema": {
            "money_rounding": f"{money_places}dp",
            "template": template_name
        },
        "stage": "final",
        "version": "1.0"
    }

    final_p.write_text(json.dumps(final, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    manifest_p.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    persist_to_database(final.get("doc_id"), final, manifest)

    print(json.dumps({
        "stage": "final",
        "doc_id": final["doc_id"],
        "items": len(items_out),
        "subtotal": totals["subtotal"],
        "grand_total": totals["grand_total"],
        "confidence": confidence.get("score"),
        "issues": issues,
        "final": str(final_p),
        "manifest": str(manifest_p),
        "config": str(config_p)
    }, ensure_ascii=False, separators=(",", ":")))
if __name__ == "__main__":
    main()
