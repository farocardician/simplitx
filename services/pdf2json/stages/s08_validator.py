#!/usr/bin/env python3
# Stage 8 — Arithmetic & Totals Validation (segment-only Stage 7 aware)

from __future__ import annotations
import argparse
import json
import re
from decimal import Decimal, ROUND_HALF_UP, getcontext
from pathlib import Path
from typing import Any, Dict, List, Optional

getcontext().prec = 28


def D(x: Any) -> Optional[Decimal]:
    return Decimal(str(x)) if x is not None else None


def money(x: Optional[Decimal], dp: int = 2) -> Optional[Decimal]:
    if x is None:
        return None
    q = Decimal(1).scaleb(-dp)
    return x.quantize(q, rounding=ROUND_HALF_UP)


def load_json(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8"))


def parse_number(text: Any) -> Optional[Decimal]:
    """Parse a printed number like 24,250,086.72 or 2.667.509,54 or (123.45)."""
    if text is None:
        return None
    s = str(text).strip()
    if s == "":
        return None
    # Parentheses negative
    neg = False
    if s.startswith("(") and s.endswith(")"):
        s = s[1:-1]
        neg = True
    # Remove spaces
    s = re.sub(r"\s+", "", s)
    # If both comma and dot present, assume the last one is the decimal separator
    if "," in s and "." in s:
        last_comma = s.rfind(",")
        last_dot = s.rfind(".")
        if last_comma > last_dot:
            # comma decimal, dot thousands
            s = s.replace(".", "")
            s = s.replace(",", ".")
        else:
            # dot decimal, comma thousands
            s = s.replace(",", "")
    else:
        # Only one kind or none
        if "," in s and "." not in s:
            # Use comma as decimal
            s = s.replace(",", ".")
        elif "." in s and "," not in s:
            # Treat dot as thousands unless it appears to be a decimal separator (single dot, <=2 decimals)
            if s.count(".") == 1 and len(s.split(".")[-1]) <= 2:
                # keep as decimal separator
                pass
            else:
                s = s.replace(".", "")
        else:
            # Remove thousand separators (commas)
            s = s.replace(",", "")
    try:
        v = Decimal(s)
        return -v if neg else v
    except Exception:
        return None


def get_field_value_text(stage7: Dict[str, Any], field: str) -> Optional[str]:
    ent = (stage7.get("header") or {}).get(field) or {}
    return ent.get("value_text")


def get_total_value_text(stage7: Dict[str, Any], name: str) -> Optional[str]:
    ent = (stage7.get("totals_extracted") or {}).get(name) or {}
    return ent.get("value_text")


def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 8 — Arithmetic & Totals Validation (segment-only)")
    ap.add_argument("--stage7", "--fields", dest="stage7", required=True, help="Stage 7 JSON (segment-only)")
    ap.add_argument("--items", required=True, help="Stage 6 items JSON")
    ap.add_argument("--out", required=True, help="Output validation JSON path")
    ap.add_argument("--config", required=False, help="Validator config JSON (tolerances, tax, etc.)")
    ap.add_argument("--tokens", required=False, help="Stage 2 normalized tokens JSON (optional cross-check)")
    ap.add_argument(
        "--tokenizer",
        required=False,
        choices=["plumber", "pymupdf"],
        help="Tokenizer engine to use when cross-checking tokens",
    )
    args = ap.parse_args()

    stage7_path = Path(args.stage7).resolve()
    items_path = Path(args.items).resolve()
    out_path = Path(args.out).resolve()
    cfg_path = Path(args.config).resolve() if args.config else None
    tokens_path = Path(args.tokens).resolve() if args.tokens else None
    out_path.parent.mkdir(parents=True, exist_ok=True)

    s7 = load_json(stage7_path)
    items_doc = load_json(items_path) if items_path.exists() else {"items": []}
    cfg = load_json(cfg_path) if cfg_path and cfg_path.exists() else {}
    if tokens_path and not args.tokenizer:
        raise SystemExit("--tokenizer is required when --tokens is provided")

    tokens_doc = load_json(tokens_path) if tokens_path and tokens_path.exists() else None

    # Config defaults
    tax_rate_percent = Decimal(str(cfg.get("tax_rate_percent", 12)))
    tax_base_ratio = Decimal(str(cfg.get("tax_base_ratio", Decimal(11) / Decimal(12))))
    money_decimals = int(cfg.get("money_decimals", 2))
    tol_row_rel = Decimal(str(cfg.get("tolerances", {}).get("row", {}).get("rel", 0.005)))
    tol_row_abs = Decimal(str(cfg.get("tolerances", {}).get("row", {}).get("abs", 1.00)))
    tol_sub_rel = Decimal(str(cfg.get("tolerances", {}).get("subtotal", {}).get("rel", 0.003)))
    tol_sub_abs = Decimal(str(cfg.get("tolerances", {}).get("subtotal", {}).get("abs", 2.00)))
    enable_token_cross = bool(cfg.get("enable_token_crosscheck", False))
    cross_fields = cfg.get("crosscheck_fields", ["invoice_no", "invoice_date", "customer_id"]) or []

    # Currency from Stage 7 header (value_text)
    currency = get_field_value_text(s7, "currency") or "IDR"

    # Items list
    items = items_doc.get("items", [])
    # Sort deterministically by (no, original index)
    for idx, it in enumerate(items):
        it["_idx"] = idx
    def _key(it):
        try:
            return (int(it.get("no", 10**9)), it["_idx"])
        except Exception:
            return (10**9, it["_idx"])
    items_sorted = sorted(items, key=_key)

    # Row validations
    row_checks: List[Dict[str, Any]] = []
    row_pass = row_fail = 0
    severe_flags: List[str] = []
    subtotal_computed = Decimal("0")

    for it in items_sorted:
        no = it.get("no")
        qty = parse_number(it.get("qty"))
        unit_price = parse_number(it.get("unit_price"))
        amount = parse_number(it.get("amount"))
        if amount is not None:
            subtotal_computed += amount

        computed = qty * unit_price if (qty is not None and unit_price is not None) else None
        if computed is not None and amount is not None:
            tol = max(abs(computed) * tol_row_rel, tol_row_abs)
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
            "computed_amount": float(money(computed, money_decimals)) if computed is not None else None,
            "diff": float(money(diff, money_decimals)) if diff is not None else None,
            "tolerance": float(money(tol, money_decimals)) if tol is not None else None,
            "pass": bool(ok)
        })
        if ok:
            row_pass += 1
        else:
            row_fail += 1
            if diff is not None and tol is not None and diff > (tol * 3):
                severe_flags.append(f"ROW_{no}_SEVERE")

    row_pass_rate = row_pass / max(1, (row_pass + row_fail))

    # Stage 7 printed totals
    printed_subtotal = parse_number(get_total_value_text(s7, "subtotal"))
    printed_tax_base = parse_number(get_total_value_text(s7, "tax_base"))
    printed_tax_amount = parse_number(get_total_value_text(s7, "tax_amount"))
    printed_grand_total = parse_number(get_total_value_text(s7, "grand_total"))
    printed_total_qty = parse_number(get_total_value_text(s7, "total_qty"))
    printed_vat_rate = get_total_value_text(s7, "vat_rate")
    vat_from_print = None
    if printed_vat_rate:
        m = re.search(r"([0-9]{1,2})\s*%", str(printed_vat_rate))
        if m:
            vat_from_print = Decimal(m.group(1))

    # Subtotal check (computed from items vs printed)
    sub_tol = max(abs(subtotal_computed) * tol_sub_rel, tol_sub_abs)
    if printed_subtotal is not None:
        sub_diff = abs(subtotal_computed - printed_subtotal)
        sub_pass = sub_diff <= sub_tol
        if sub_diff > (sub_tol * 3):
            severe_flags.append("SUBTOTAL_SEVERE")
    else:
        sub_diff = None
        sub_pass = None

    # Template totals using config
    subtotal_for_totals = printed_subtotal if printed_subtotal is not None else subtotal_computed
    tax_base_templ = subtotal_for_totals * tax_base_ratio
    tax_rate_eff = vat_from_print if vat_from_print is not None else tax_rate_percent
    tax_amount_templ = (tax_rate_eff / Decimal(100)) * tax_base_templ
    grand_total_templ = subtotal_for_totals + tax_amount_templ

    # Flags
    flags = []
    if not items_sorted:
        flags.append("NO_ITEMS")
    if printed_subtotal is None and subtotal_computed == 0:
        flags.append("TOTALS_MISSING")
    if printed_subtotal is None:
        flags.append("SUBTOTAL_MISSING")

    # Optional token cross-check
    token_cross: Dict[str, Any] = {}
    if enable_token_cross and tokens_doc is not None:
        engine_block = tokens_doc.get(args.tokenizer) if args.tokenizer else None
        if not isinstance(engine_block, dict) or not isinstance(engine_block.get("tokens"), list):
            raise SystemExit(f"Tokenizer '{args.tokenizer}' tokens not found in {tokens_path}")
        token_ids = {
            int(t.get("id"))
            for t in engine_block.get("tokens", [])
            if isinstance(t.get("id"), int)
        }
        for fname in cross_fields:
            ent = (s7.get("header") or {}).get(fname) or {}
            span = ent.get("token_span") or []
            missing = [tid for tid in span if tid not in token_ids]
            if missing:
                token_cross[fname] = {"missing_ids": missing, "total": len(span)}

    out = {
        "doc_id": s7.get("doc_id"),
        "stage": "validation",
        "version": "2.0",
        "currency": currency,
        "items_path": str(items_path),
        "rows": {
            "total": row_pass + row_fail,
            "pass": row_pass,
            "fail": row_fail,
            "pass_rate": float(Decimal(str(row_pass_rate)).quantize(Decimal("0.000001"))),
            "checks": row_checks
        },
        "totals": {
            "printed": {
                "subtotal": float(money(printed_subtotal, money_decimals)) if printed_subtotal is not None else None,
                "tax_base": float(money(printed_tax_base, money_decimals)) if printed_tax_base is not None else None,
                "tax_amount": float(money(printed_tax_amount, money_decimals)) if printed_tax_amount is not None else None,
                "grand_total": float(money(printed_grand_total, money_decimals)) if printed_grand_total is not None else None,
                "total_qty": float(printed_total_qty) if printed_total_qty is not None else None,
                "vat_rate_percent": float(vat_from_print) if vat_from_print is not None else None
            },
            "computed": {
                "tax_rate_percent": float(tax_rate_eff),
                "tax_base_ratio": float(tax_base_ratio),
                "tax_base": float(money(tax_base_templ, money_decimals)) if tax_base_templ is not None else None,
                "tax_amount": float(money(tax_amount_templ, money_decimals)) if tax_amount_templ is not None else None,
                "grand_total": float(money(grand_total_templ, money_decimals)) if grand_total_templ is not None else None
            },
            "checks": {
                "subtotal": {
                    "computed": float(money(subtotal_computed, money_decimals)) if subtotal_computed is not None else None,
                    "printed": float(money(printed_subtotal, money_decimals)) if printed_subtotal is not None else None,
                    "diff": float(money(abs(subtotal_computed - printed_subtotal), money_decimals)) if printed_subtotal is not None else None,
                    "tolerance": float(money(sub_tol, money_decimals)),
                    "pass": sub_pass if sub_pass is not None else None
                }
            }
        },
        "flags": flags,
        "severe": severe_flags,
    }
    if token_cross:
        out["token_crosscheck"] = token_cross

    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({
        "stage": out["stage"],
        "doc_id": out["doc_id"],
        "rows": f"{row_pass}/{row_pass+row_fail} pass",
        "row_pass_rate": out["rows"]["pass_rate"],
        "subtotal_pass": out["totals"]["checks"]["subtotal"]["pass"],
        "grand_total_printed": out["totals"]["printed"]["grand_total"],
        "grand_total_computed": out["totals"]["computed"]["grand_total"],
        "flags": out["flags"],
        "out": str(out_path)
    }, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
