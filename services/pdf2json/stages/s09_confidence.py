#!/usr/bin/env python3
# Stage 9 — Confidence Scoring (updated for refactored Stages 6/7/8)
#
# Inputs:
#   --fields|--stage7   Stage‑7 fields JSON (V3 segment‑only supported; V1/V2 fallback)
#   --items             Stage‑6 items JSON
#   --validation        Stage‑8 validation JSON (V2)
#   --out               Path to write confidence JSON
# Optional:
#   --config            Stage‑9 config (weights, header fields, penalties)
#   --tokens            Stage‑2 normalized tokens (optional cross‑check)
#
# Deterministic scoring (defaults; override via --config):
#   base = 0.6*row_pass_rate + 0.2*header_score + 0.2*subtotal_score
#   penalties: -0.05 if totals missing; -0.2 if any severe flags
#   score = clamp01(base - penalties)
#
# Header score (defaults): fraction present among
#   invoice_no, invoice_date, customer_id, seller, currency
# Presence uses Stage‑7 value_text (V3); for legacy V1/V2, raw string value.
#
# Subtotal score = 1 if totals.checks.subtotal.pass is True, else 0 (legacy: subtotal_check.pass)
#
# Notes:
# - All floats rounded to 6 decimals in the file for stable diffs.
# - Reasons list is ordered and deterministic.

from __future__ import annotations
import argparse, json
from pathlib import Path
from typing import Any, Dict, List, Optional

def load_json(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8"))

def _is_present_value(val: Any) -> bool:
    if val is None:
        return False
    if isinstance(val, (list, dict)):
        # For V3 Stage‑7 field objects, presence is based on value_text
        if isinstance(val, dict):
            vt = val.get("value_text") or val.get("raw_text")
            return isinstance(vt, str) and vt.strip() != ""
        # lists are not valid scalar values
        return False
    return str(val).strip() != ""

def clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v

def r6(v: float | None) -> float | None:
    if v is None:
        return None
    return float(f"{v:.6f}")


def _get_row_pass_rate(v: Dict[str, Any]) -> float:
    # New (Stage‑8 V2)
    try:
        r = float(v.get("rows", {}).get("pass_rate", 0.0))
        return r
    except Exception:
        pass
    # Legacy fallback
    try:
        return float(v.get("summary", {}).get("row_pass_rate", 0.0))
    except Exception:
        return 0.0


def _get_subtotal_pass(v: Dict[str, Any]) -> Optional[bool]:
    # New (Stage‑8 V2)
    try:
        sub = v.get("totals", {}).get("checks", {}).get("subtotal", {})
        if isinstance(sub, dict) and "pass" in sub:
            return bool(sub.get("pass"))
    except Exception:
        pass
    # Legacy fallback
    try:
        sub_pass = v.get("subtotal_check", {}).get("pass", None)
        if sub_pass is None:
            return None
        return bool(sub_pass)
    except Exception:
        return None


def _get_header_presence(fields_doc: Dict[str, Any], header_keys: List[str]) -> Dict[str, bool]:
    header = (fields_doc.get("header") or {})
    out: Dict[str, bool] = {}
    for k in header_keys:
        val = header.get(k)
        out[k] = _is_present_value(val)
    return out


def _load_config(cfg_path: Optional[Path]) -> Dict[str, Any]:
    # Defaults are rigid and deterministic; external config may override.
    defaults = {
        "weights": {"row": 0.6, "header": 0.2, "subtotal": 0.2},
        "header_fields": {
            "required": ["invoice_no", "invoice_date", "customer_id"],
            "expected": ["seller", "currency"],
            "optional": [],
        },
        "penalties": {
            "totals_missing": 0.05,
            "severe": 0.20,
            "token_span_miss": 0.05,
        },
        "confidence_map": {"high": 1.0, "medium": 0.66, "low": 0.33, "none": 0.0},
    }
    if not cfg_path:
        return defaults
    try:
        user_cfg = load_json(cfg_path)
        # Shallow merge
        for k, v in (user_cfg or {}).items():
            if isinstance(v, dict) and isinstance(defaults.get(k), dict):
                defaults[k].update(v)
            else:
                defaults[k] = v
        return defaults
    except Exception:
        return defaults

def main():
    ap = argparse.ArgumentParser(description="Stage 9 — Confidence Scoring (refactored)")
    ap.add_argument("--fields", "--stage7", dest="fields", required=True, help="Stage 7 fields JSON")
    ap.add_argument("--items", required=True, help="Stage 6 items JSON")
    ap.add_argument("--validation", required=True, help="Stage 8 validation JSON")
    ap.add_argument("--out", required=True, help="Output confidence JSON")
    ap.add_argument("--tokens", required=False, help="Stage 2 normalized tokens (optional cross-check)")
    ap.add_argument("--config", required=False, help="Stage 9 config (weights, header fields, penalties)")
    args = ap.parse_args()

    fields_path = Path(args.fields).resolve()
    items_path = Path(args.items).resolve()
    validation_path = Path(args.validation).resolve()
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    f = load_json(fields_path)
    v = load_json(validation_path)
    i = load_json(items_path)
    cfg = _load_config(Path(args.config).resolve() if args.config else None)
    tokens_doc = None
    if args.tokens:
        tpath = Path(args.tokens).resolve()
        if tpath.exists():
            try:
                tokens_doc = load_json(tpath)
            except Exception:
                tokens_doc = None

    # 1) Row pass rate (new: v.rows.pass_rate; legacy fallback supported)
    row_pass_rate = float(_get_row_pass_rate(v))

    # 2) Header completeness
    header_keys: List[str] = list(cfg.get("header_fields", {}).get("required", [])) + list(cfg.get("header_fields", {}).get("expected", []))
    # Fallback if config empty
    if not header_keys:
        header_keys = ["invoice_no", "invoice_date", "customer_id", "seller", "currency"]
    header_presence = _get_header_presence(f, header_keys)
    header_present = sum(1 for ok in header_presence.values() if ok)
    header_total = len(header_keys)
    header_score = (header_present / max(1, header_total)) if header_total else 0.0

    # 3) Subtotal check
    sub_pass = _get_subtotal_pass(v)
    subtotal_score = 1.0 if sub_pass is True else 0.0

    # Base score
    W = cfg.get("weights", {})
    base = (float(W.get("row", 0.6)) * row_pass_rate) + (float(W.get("header", 0.2)) * header_score) + (float(W.get("subtotal", 0.2)) * subtotal_score)

    # Penalties
    penalties = 0.0
    reasons: List[str] = []
    flags = v.get("flags", []) or []
    severe = v.get("severe", []) or []

    P = cfg.get("penalties", {})
    if "TOTALS_MISSING" in flags:
        penalties += float(P.get("totals_missing", 0.05))
        reasons.append("totals_missing")

    if severe:
        penalties += float(P.get("severe", 0.20))
        reasons.append("severe_row_mismatch")

    # Optional: token span cross-check (verify Stage‑7 header token ids exist in Stage‑2 tokens)
    if tokens_doc is not None:
        token_ids = {int(t.get("id")) for t in tokens_doc.get("tokens", []) if isinstance(t.get("id"), int)}
        missing_any = False
        for k in header_keys:
            ent = (f.get("header") or {}).get(k) or {}
            span = ent.get("token_span") if isinstance(ent, dict) else None
            if not span:
                continue
            miss = [tid for tid in span if int(tid) not in token_ids]
            if miss:
                missing_any = True
        if missing_any:
            penalties += float(P.get("token_span_miss", 0.05))
            reasons.append("token_span_missing")

    # Final score
    score = clamp01(base - penalties)

    out = {
        "doc_id": f.get("doc_id"),
        "stage": "confidence",
        "version": "2.0",
        "components": {
            "row_pass_rate": r6(row_pass_rate),
            "header_score": r6(header_score),
            "subtotal_score": r6(subtotal_score),
            "base_score": r6(base),
            "penalties": r6(penalties),
        },
        "score": r6(score),
        "flags": flags,
        "severe": severe,
        "reasons": reasons,
        "header_presence": header_presence,
        "meta": {
            "items_count": len(i.get("items", [])),
            "header_present": header_present,
            "header_total": header_total,
            "weights": cfg.get("weights"),
            "inputs": {
                "fields": str(fields_path),
                "items": str(items_path),
                "validation": str(validation_path),
                **({"tokens": str(Path(args.tokens).resolve())} if args.tokens else {}),
                **({"config": str(Path(args.config).resolve())} if args.config else {}),
            }
        }
    }

    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({
        "stage": out["stage"],
        "doc_id": out["doc_id"],
        "score": out["score"],
        "row_pass_rate": out["components"]["row_pass_rate"],
        "header_score": out["components"]["header_score"],
        "subtotal_score": out["components"]["subtotal_score"],
        "penalties": out["components"]["penalties"],
        "flags": out["flags"],
        "out": str(out_path),
    }, ensure_ascii=False, separators=(",", ":")))

if __name__ == "__main__":
    main()
