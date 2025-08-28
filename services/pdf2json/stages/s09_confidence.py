#!/usr/bin/env python3
# Stage 9 — Confidence Scoring
# Inputs:
#   --fields      /path/to/fields.json
#   --items       /path/to/items.json
#   --validation  /path/to/validation.json
# Output:
#   --out         /path/to/confidence.json
#
# Deterministic scoring:
#   base = 0.6*row_pass_rate + 0.2*header_score + 0.2*subtotal_score
#   penalties: -0.05 if totals missing; -0.2 if any severe flags
#   clamp to [0,1]
#
# Header score = fraction of present fields among:
#   invoice_no, invoice_date, buyer_name, seller_name, currency
#
# Subtotal score = 1 if subtotal_check.pass is True, else 0
#
# Notes:
# - All floats rounded to 6 decimals in the file for stable diffs.
# - Reasons list is ordered and deterministic.

from __future__ import annotations
import argparse, json
from pathlib import Path

def load_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))

def present(x) -> bool:
    return x is not None and str(x).strip() != ""

def clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v

def r6(v: float | None) -> float | None:
    if v is None:
        return None
    return float(f"{v:.6f}")

def main():
    ap = argparse.ArgumentParser(description="Stage 11 — Confidence Scoring")
    ap.add_argument("--fields", required=True)
    ap.add_argument("--items", required=True)
    ap.add_argument("--validation", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    fields_path = Path(args.fields).resolve()
    items_path = Path(args.items).resolve()
    validation_path = Path(args.validation).resolve()
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    f = load_json(fields_path)
    v = load_json(validation_path)
    i = load_json(items_path)

    # 1) Row pass rate
    row_pass_rate = float(v.get("summary", {}).get("row_pass_rate", 0.0))

    # 2) Header completeness
    hdr = f.get("header", {}) or {}
    header_fields = {
        "invoice_no": hdr.get("invoice_no"),
        "invoice_date": hdr.get("invoice_date"),
        "buyer_name": hdr.get("buyer_name"),
        "seller_name": hdr.get("seller_name"),
        "currency": hdr.get("currency"),
    }
    header_present = sum(1 for x in header_fields.values() if present(x))
    header_total = len(header_fields)
    header_score = header_present / max(1, header_total)

    # 3) Subtotal check
    sub_pass = v.get("subtotal_check", {}).get("pass", None)
    subtotal_score = 1.0 if sub_pass is True else 0.0

    # Base score
    base = (0.6 * row_pass_rate) + (0.2 * header_score) + (0.2 * subtotal_score)

    # Penalties
    penalties = 0.0
    reasons: list[str] = []
    flags = v.get("flags", []) or []
    severe = v.get("severe", []) or []

    if "TOTALS_MISSING" in flags:
        penalties += 0.05
        reasons.append("totals_missing")

    if severe:
        penalties += 0.20
        reasons.append("severe_row_mismatch")

    # Final score
    score = clamp01(base - penalties)

    out = {
        "doc_id": f.get("doc_id"),
        "stage": "confidence",
        "version": "1.0",
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
        "meta": {
            "items_count": len(i.get("items", [])),
            "header_present": header_present,
            "header_total": header_total,
            "inputs": {
                "fields": str(fields_path),
                "items": str(items_path),
                "validation": str(validation_path),
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
