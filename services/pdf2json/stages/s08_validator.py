#!/usr/bin/env python3
# Stage 8 — Arithmetic & Totals Validation (supports --items override)

from __future__ import annotations
import argparse, json
from decimal import Decimal, ROUND_HALF_UP, getcontext
from pathlib import Path
from typing import Any, Dict, List

TAX_RATE = Decimal("12")       # percent
ROW_PCT_TOL = Decimal("0.005") # 0.5%
ROW_ABS_TOL = Decimal("1.00")
SUB_PCT_TOL = Decimal("0.003") # 0.3%
SUB_ABS_TOL = Decimal("2.00")
getcontext().prec = 28

def D(x): return Decimal(str(x)) if x is not None else None
def money(x: Decimal) -> Decimal: return x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
def load_json(p: Path) -> Dict[str, Any]: return json.loads(p.read_text(encoding="utf-8"))

def main():
    ap = argparse.ArgumentParser(description="Stage 10 — Arithmetic & Totals Validation")
    ap.add_argument("--fields", required=True, help="fields.json")
    ap.add_argument("--items", required=False, help="items.json (overrides items_ref in fields.json)")
    ap.add_argument("--out",    required=True, help="validation.json")
    args = ap.parse_args()

    fields_path = Path(args.fields).resolve()
    items_cli = Path(args.items).resolve() if args.items else None
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    fdata = load_json(fields_path)
    items_source = "cli" if items_cli else "fields"
    if items_cli:
        items_path = items_cli
    else:
        ref = (fdata.get("items_ref") or {}).get("path")
        if not ref:
            raise SystemExit("No --items provided and fields.json has no items_ref.path")
        items_path = (fields_path.parent / ref).resolve() if not Path(ref).is_absolute() else Path(ref).resolve()

    idata = load_json(items_path) if items_path.exists() else {"items": []}
    currency = (fdata.get("header") or {}).get("currency") or "IDR"
    reported_subtotal = fdata.get("totals", {}).get("subtotal")

    # Sort items deterministically
    items = idata.get("items", [])
    for idx, it in enumerate(items):
        it["_idx"] = idx
    def _key(it):
        try: return (int(it.get("no", 10**9)), it["_idx"])
        except Exception: return (10**9, it["_idx"])
    items_sorted = sorted(items, key=_key)

    # Row checks
    row_checks: List[Dict[str, Any]] = []
    row_pass = row_fail = 0
    severe_flags: List[str] = []
    sum_amounts = Decimal("0")

    for it in items_sorted:
        no = it.get("no")
        qty = D(it.get("qty"))
        unit_price = D(it.get("unit_price"))
        amount = D(it.get("amount"))

        computed = qty * unit_price if (qty is not None and unit_price is not None) else None
        if amount is not None: sum_amounts += amount

        if computed is not None and amount is not None:
            tol = max(abs(computed) * ROW_PCT_TOL, ROW_ABS_TOL)
            diff = abs(computed - amount)
            ok = diff <= tol
        else:
            tol = diff = None
            ok = False

        row_checks.append({
            "no": no,
            "qty": float(qty) if qty is not None else None,
            "unit_price": float(unit_price) if unit_price is not None else None,
            "amount": float(amount) if amount is not None else None,
            "computed_amount": float(money(computed)) if computed is not None else None,
            "diff": float(money(diff)) if diff is not None else None,
            "tolerance": float(money(tol)) if tol is not None else None,
            "pass": bool(ok)
        })
        if ok: row_pass += 1
        else:
            row_fail += 1
            if diff is not None and tol is not None and diff > (tol * 3):
                severe_flags.append(f"ROW_{no}_SEVERE")

    row_pass_rate = row_pass / max(1, (row_pass + row_fail))

    # Subtotal check
    computed_sub = sum_amounts
    sub_tol = max(abs(computed_sub) * SUB_PCT_TOL, SUB_ABS_TOL)
    if reported_subtotal is not None:
        reported_sub = D(reported_subtotal)
        sub_diff = abs(computed_sub - reported_sub)
        sub_pass = sub_diff <= sub_tol
        if sub_diff > (sub_tol * 3):
            severe_flags.append("SUBTOTAL_SEVERE")
    else:
        reported_sub = None
        sub_diff = None
        sub_pass = None

    # Template totals
    subtotal_for_totals = reported_sub if reported_sub is not None else computed_sub
    tax_base = subtotal_for_totals * Decimal(11) / Decimal(12)
    tax_amount = (TAX_RATE / Decimal(100)) * tax_base
    grand_total = subtotal_for_totals + tax_amount

    flags = []
    f_tot = fdata.get("totals", {})
    # Only flag TOTALS_MISSING if we cannot compute totals (missing required fields)
    # We can always compute if we have items, so only flag if there are no items or no subtotal
    if not items or (reported_subtotal is None and sum_amounts == 0):
        flags.append("TOTALS_MISSING")
    if reported_subtotal is None:
        flags.append("SUBTOTAL_MISSING")

    out = {
        "doc_id": fdata.get("doc_id"),
        "stage": "validation",
        "version": "1.1",
        "currency": currency,
        "items_source": items_source,
        "items_path": str(items_path),
        "row_checks": row_checks,
        "summary": {
            "rows_total": row_pass + row_fail,
            "rows_pass": row_pass,
            "rows_fail": row_fail,
            "row_pass_rate": round(row_pass_rate, 6),
        },
        "subtotal_check": {
            "computed": float(money(computed_sub)),
            "reported": float(money(reported_sub)) if reported_sub is not None else None,
            "diff": float(money(sub_diff)) if sub_diff is not None else None,
            "tolerance": float(money(sub_tol)),
            "pass": sub_pass if sub_pass is not None else None
        },
        "template_totals": {
            "tax_rate_percent": float(TAX_RATE),
            "tax_base": float(money(tax_base)),
            "tax_amount": float(money(tax_amount)),
            "grand_total": float(money(grand_total))
        },
        "flags": flags,
        "severe": severe_flags
    }

    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({
        "stage": out["stage"],
        "doc_id": out["doc_id"],
        "items_source": items_source,
        "rows": f"{row_pass}/{row_pass+row_fail} pass",
        "row_pass_rate": out["summary"]["row_pass_rate"],
        "subtotal_pass": out["subtotal_check"]["pass"],
        "computed_subtotal": out["subtotal_check"]["computed"],
        "template_grand_total": out["template_totals"]["grand_total"],
        "flags": out["flags"],
        "out": str(out_path)
    }, ensure_ascii=False, separators=(",", ":")))
if __name__ == "__main__":
    main()
