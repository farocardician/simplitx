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
#   Base = 0.40·R + 0.10·H + 0.50·T
#   T = 0.70·G + 0.15·V + 0.10·S + 0.05·B
#   Short-circuit: if grand total is printed and wrong -> score = 0.0
#   Penalties (additive, then clamp):
#     - Missing & not-derivable (GT/VAT/Subtotal/TaxBase) capped at 0.10
#     - Arithmetic inconsistency: -0.20
#     - Severe flags: -0.20
#     - Token-span risk: -0.05
#   Score = clamp01(Base - ΣPenalties)
#
# Header score (defaults): fraction present among
#   invoice_number, invoice_date, customer_id, seller, currency
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
from typing import Any, Dict, List, Optional, Tuple

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
        # New weights per Stage-9 refactor
        "weights": {
            "row": 0.40,
            "header": 0.10,
            "totals": 0.50,
            "totals_detail": {"G": 0.70, "V": 0.15, "S": 0.10, "B": 0.05},
        },
        "header_fields": {
            "required": ["invoice_number", "invoice_date", "customer_id"],
            "expected": ["seller", "currency"],
            "optional": [],
        },
        "penalties": {
            # Missing & not-derivable (group cap at 0.10)
            "missing_cap": 0.10,
            "missing_gt": 0.05,
            "missing_vat": 0.03,
            "missing_subtotal": 0.02,
            "missing_taxbase": 0.02,
            # Other penalties
            "arith_inconsistency": 0.20,
            "severe": 0.20,
            "token_span_miss": 0.05,
        },
        "gt_missing_floor": {"both_ok": 0.60, "one_ok": 0.30},
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


# ---- Totals extraction and mapping helpers (pure) ----

def _get_safe(d: Dict[str, Any], path: List[str]) -> Any:
    cur = d
    for p in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur


def _extract_totals_info(v: Dict[str, Any]) -> Dict[str, Any]:
    """Extract printed, computed, and checks for totals from Stage-8.

    Returns dict:
      {
        'printed': {'G': bool, 'V': bool, 'S': bool, 'B': bool},
        'correct': {'G': bool|None, 'V': bool|None, 'S': bool|None, 'B': bool|None},
        'derivable': {'G': bool, 'V': bool, 'S': bool, 'B': bool},
        'values': {
          'printed': {...raw floats or None...},
          'computed': {...raw floats or None...}
        }
      }

    No recomputation; only interprets Stage-8 fields.
    """
    printed = {
        "S": _get_safe(v, ["totals", "printed", "subtotal"]),
        "B": _get_safe(v, ["totals", "printed", "tax_base"]),
        "V": _get_safe(v, ["totals", "printed", "tax_amount"]),
        "G": _get_safe(v, ["totals", "printed", "grand_total"]),
    }
    computed = {
        "S": _get_safe(v, ["totals", "checks", "subtotal", "computed"]),
        "B": _get_safe(v, ["totals", "computed", "tax_base"]),
        "V": _get_safe(v, ["totals", "computed", "tax_amount"]),
        "G": _get_safe(v, ["totals", "computed", "grand_total"]),
    }
    # Subtotal pass (Stage-8 provides checks.subtotal.pass; legacy fallback supported via existing helper if needed elsewhere)
    sub_pass = _get_safe(v, ["totals", "checks", "subtotal", "pass"])

    def printed_ok(key: str) -> bool:
        return printed.get(key) is not None

    def derivable_ok(key: str) -> bool:
        # Derivable means Stage-8 has a computed value we can read
        return computed.get(key) is not None

    def correct_ok(key: str) -> Optional[bool]:
        # Printed and matches computed (Stage-8 rounded values), or Stage-8 explicit pass (for S)
        pv = printed.get(key)
        cv = computed.get(key)
        if key == "S":
            # Use explicit subtotal pass if provided
            if sub_pass is True:
                return True
            if sub_pass is False:
                return False
            # If None, fall back to printed vs computed if both present
        if pv is None:
            return None
        if cv is None:
            # Cannot assess correctness without computed
            return None
        try:
            return float(pv) == float(cv)
        except Exception:
            return None

    printed_flags = {k: bool(printed_ok(k)) for k in ("G", "V", "S", "B")}
    derivable_flags = {k: bool(derivable_ok(k)) for k in ("G", "V", "S", "B")}
    correct_flags = {k: correct_ok(k) for k in ("G", "V", "S", "B")}

    return {
        "printed": printed_flags,
        "correct": correct_flags,
        "derivable": derivable_flags,
        "values": {"printed": printed, "computed": computed},
    }


def _map_signal(printed: bool, correct: Optional[bool], derivable: bool) -> float:
    """Map per-spec to 1.0, 0.6, or 0.0."""
    if printed:
        if correct is True:
            return 1.0
        # printed but wrong (or unknown correctness): 0.0
        return 0.0
    # Missing
    if (not printed) and derivable:
        return 0.6
    return 0.0

def main():
    ap = argparse.ArgumentParser(description="Stage 9 — Confidence Scoring (refactored)")
    ap.add_argument("--fields", "--stage7", dest="fields", required=True, help="Stage 7 fields JSON")
    ap.add_argument("--items", required=True, help="Stage 6 items JSON")
    ap.add_argument("--validation", required=True, help="Stage 8 validation JSON")
    ap.add_argument("--out", required=True, help="Output confidence JSON")
    ap.add_argument("--tokens", required=False, help="Stage 2 normalized tokens (optional cross-check)")
    ap.add_argument("--config", required=False, help="Stage 9 config (weights, header fields, penalties)")
    ap.add_argument(
        "--tokenizer",
        required=False,
        choices=["plumber", "pymupdf"],
        help="Tokenizer engine to use when cross-checking tokens",
    )
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
        if not args.tokenizer:
            raise SystemExit("--tokenizer is required when --tokens is provided")
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
        header_keys = ["invoice_number", "invoice_date", "customer_id", "seller", "currency"]
    header_presence = _get_header_presence(f, header_keys)
    header_present = sum(1 for ok in header_presence.values() if ok)
    header_total = len(header_keys)
    header_score = (header_present / max(1, header_total)) if header_total else 0.0

    # 3) Totals block — extract signals and map per spec
    totals_info = _extract_totals_info(v)
    pr = totals_info["printed"]
    ok = totals_info["correct"]
    drv = totals_info["derivable"]

    # Map signals
    G_signal = _map_signal(pr.get("G", False), ok.get("G"), drv.get("G", False))
    V_signal = _map_signal(pr.get("V", False), ok.get("V"), drv.get("V", False))
    S_signal = _map_signal(pr.get("S", False), ok.get("S"), drv.get("S", False))
    B_signal = _map_signal(pr.get("B", False), ok.get("B"), drv.get("B", False))

    # Short-circuit: GT printed and wrong => score 0.0 immediately
    if pr.get("G") and (ok.get("G") is False):
        out = {
            "doc_id": f.get("doc_id"),
            "stage": "confidence",
            "version": "2.0",
            "components": {
                "row_pass_rate": r6(row_pass_rate),
                "header_score": r6(header_score),
                "totals": {"G": r6(G_signal), "V": r6(V_signal), "S": r6(S_signal), "B": r6(B_signal), "T": r6(0.0)},
                "base_score": r6(0.0),
                "penalties": r6(0.0),
            },
            "score": r6(0.0),
            "flags": v.get("flags", []) or [],
            "severe": v.get("severe", []) or [],
            "reasons": ["gt_wrong_printed"],
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
            "penalties": out["components"]["penalties"],
            "flags": out["flags"],
            "out": str(out_path),
        }, ensure_ascii=False, separators=(",", ":")))
        return

    # When G is missing, apply floor rule based on correct V & S
    if not pr.get("G"):
        both_ok = (ok.get("V") is True) and (ok.get("S") is True)
        one_ok = ((ok.get("V") is True) ^ (ok.get("S") is True))
        floors = cfg.get("gt_missing_floor", {"both_ok": 0.60, "one_ok": 0.30})
        if both_ok:
            G_signal = float(floors.get("both_ok", 0.60))
        elif one_ok:
            G_signal = float(floors.get("one_ok", 0.30))
        else:
            G_signal = 0.0

    # Compute totals block T
    TW = (cfg.get("weights", {}) or {}).get("totals_detail", {}) or {"G": 0.70, "V": 0.15, "S": 0.10, "B": 0.05}
    T = (
        float(TW.get("G", 0.70)) * G_signal
        + float(TW.get("V", 0.15)) * V_signal
        + float(TW.get("S", 0.10)) * S_signal
        + float(TW.get("B", 0.05)) * B_signal
    )

    # Base score
    W = cfg.get("weights", {})
    base = (float(W.get("row", 0.40)) * row_pass_rate) + (float(W.get("header", 0.10)) * header_score) + (float(W.get("totals", 0.50)) * T)

    # Penalties
    penalties = 0.0
    reasons: List[str] = []
    flags = v.get("flags", []) or []
    severe = v.get("severe", []) or []

    P = cfg.get("penalties", {})

    # Missing & not-derivable penalties (capped)
    missing_pen = 0.0
    capped = False
    missing_reasons: List[str] = []
    if (not pr.get("G")) and (not drv.get("G")):
        missing_pen += float(P.get("missing_gt", 0.05))
        missing_reasons.append("gt_missing_nonderivable")
    elif (not pr.get("G")) and drv.get("G"):
        missing_reasons.append("gt_missing_derivable")

    if (not pr.get("V")) and (not drv.get("V")):
        missing_pen += float(P.get("missing_vat", 0.03))
        missing_reasons.append("vat_missing_nonderivable")
    elif (not pr.get("V")) and drv.get("V"):
        missing_reasons.append("vat_missing_derivable")

    if (not pr.get("S")) and (not drv.get("S")):
        missing_pen += float(P.get("missing_subtotal", 0.02))
        missing_reasons.append("subtotal_missing_nonderivable")
    elif (not pr.get("S")) and drv.get("S"):
        missing_reasons.append("subtotal_missing_derivable")

    if (not pr.get("B")) and (not drv.get("B")):
        missing_pen += float(P.get("missing_taxbase", 0.02))
        missing_reasons.append("taxbase_missing_nonderivable")
    elif (not pr.get("B")) and drv.get("B"):
        missing_reasons.append("taxbase_missing_derivable")

    if missing_pen > 0.0:
        cap = float(P.get("missing_cap", 0.10))
        if missing_pen > cap:
            missing_pen = cap
            capped = True
        penalties += missing_pen

    # Arithmetic inconsistency: prefer GT sum rule; if GT printed & matches computed, do not penalize VAT mismatch
    arith_inconsistency = False
    pv = totals_info["values"]["printed"]
    cv = totals_info["values"]["computed"]
    if pv.get("G") is not None and cv.get("G") is not None:
        try:
            arith_inconsistency = float(pv.get("G")) != float(cv.get("G"))
        except Exception:
            arith_inconsistency = False
    elif pv.get("V") is not None and cv.get("V") is not None and pv.get("G") is None:
        # Only consider VAT inconsistency when GT isn't printed
        try:
            arith_inconsistency = float(pv.get("V")) != float(cv.get("V"))
        except Exception:
            arith_inconsistency = False

    if arith_inconsistency:
        penalties += float(P.get("arith_inconsistency", 0.20))

    # Severe flags
    if severe:
        penalties += float(P.get("severe", 0.20))

    # Optional: token span cross-check (verify Stage‑7 header token ids exist in Stage‑2 tokens)
    token_span_missing = False
    if tokens_doc is not None:
        engine_block = tokens_doc.get(args.tokenizer) if args.tokenizer else None
        if not isinstance(engine_block, dict) or not isinstance(engine_block.get("tokens"), list):
            raise SystemExit(f"Tokenizer '{args.tokenizer}' tokens not found in {Path(args.tokens).resolve()}")
        token_ids = {
            int(t.get("id"))
            for t in engine_block.get("tokens", [])
            if isinstance(t.get("id"), int)
        }
        for k in header_keys:
            ent = (f.get("header") or {}).get(k) or {}
            span = ent.get("token_span") if isinstance(ent, dict) else None
            if not span:
                continue
            miss = [tid for tid in span if int(tid) not in token_ids]
            if miss:
                token_span_missing = True
                break
        if token_span_missing:
            penalties += float(P.get("token_span_miss", 0.05))

    # Final score
    score = clamp01(base - penalties)

    # Reasons — deterministic order
    # 1. gt_wrong_printed (would have short-circuited; keep for completeness if needed — not added here)
    # 2-5. Missing reasons in order
    reasons.extend([r for r in (
        ("gt_missing_derivable" if ((not pr.get("G")) and drv.get("G")) else ("gt_missing_nonderivable" if ((not pr.get("G")) and (not drv.get("G"))) else None)),
        ("vat_missing_derivable" if ((not pr.get("V")) and drv.get("V")) else ("vat_missing_nonderivable" if ((not pr.get("V")) and (not drv.get("V"))) else None)),
        ("subtotal_missing_derivable" if ((not pr.get("S")) and drv.get("S")) else ("subtotal_missing_nonderivable" if ((not pr.get("S")) and (not drv.get("S"))) else None)),
        ("taxbase_missing_derivable" if ((not pr.get("B")) and drv.get("B")) else ("taxbase_missing_nonderivable" if ((not pr.get("B")) and (not drv.get("B"))) else None)),
    ) if r is not None])

    # 6. Arithmetic inconsistency
    if arith_inconsistency:
        reasons.append("arith_inconsistency")

    # 7. Severe
    if severe:
        reasons.append("severe")

    # 8. Token span missing
    if token_span_missing:
        reasons.append("token_span_missing")

    # 9. Penalties capped
    if capped:
        reasons.append("penalties_capped_0.10")

    out = {
        "doc_id": f.get("doc_id"),
        "stage": "confidence",
        "version": "2.0",
        "components": {
            "row_pass_rate": r6(row_pass_rate),
            "header_score": r6(header_score),
            "totals": {"G": r6(G_signal), "V": r6(V_signal), "S": r6(S_signal), "B": r6(B_signal), "T": r6(T)},
            "base_score": r6(base),
            "penalties": r6(penalties),
            # Keep legacy subtotal component for backward compatibility (not used in scoring)
            "subtotal_score": r6(1.0 if (_get_subtotal_pass(v) is True) else 0.0),
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
        "penalties": out["components"]["penalties"],
        "flags": out["flags"],
        "out": str(out_path),
    }, ensure_ascii=False, separators=(",", ":")))

if __name__ == "__main__":
    main()
