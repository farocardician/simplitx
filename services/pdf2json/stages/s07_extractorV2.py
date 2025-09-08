#!/usr/bin/env python3
from __future__ import annotations

import argparse, json, re, sys
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional


def _tok_text(t: Dict[str, Any]) -> str:
    return (t.get("norm") or t.get("text") or "").strip()


def _load_json(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8"))


def _load_config(cfg_path: Path) -> Dict[str, Any]:
    try:
        cfg = _load_json(cfg_path)
    except Exception as e:
        print(f"[ERROR] Failed to read config: {e}", file=sys.stderr); sys.exit(2)

    st7 = cfg.get("stage7")
    if not isinstance(st7, dict):
        print("[ERROR] Config must include a 'stage7' object for Stage 7 extraction.", file=sys.stderr)
        sys.exit(2)

    # Validate minimal keys (keep it lean; everything else optional)
    req_keys = ["invoice_no_patterns", "date_patterns"]
    missing = [k for k in req_keys if k not in st7]
    if missing:
        print(f"[ERROR] stage7 is missing required keys: {', '.join(missing)}", file=sys.stderr)
        sys.exit(2)

    # Defaults
    st7.setdefault("currency_order", [])
    st7.setdefault("po_patterns", [])
    st7.setdefault("customer_code_patterns", [])
    # Regions map: segmenter IDs
    st7.setdefault("regions", {
        "invoice_no": "invoice_no",
        "invoice_date": "invoice_date",
        "customer_id": "customer_id",
        "seller": "seller",
        "header": "header"
    })
    # payment terms defaults
    if "payment_terms" in st7:
        pt = st7["payment_terms"]
        pt.setdefault("label_contains", [])
        pt.setdefault("include_next_n_rows", 0)

    cfg["stage7"] = st7
    return cfg


# ---------------- region/tokens helpers ----------------

def _group_lines(tokens: List[Dict[str, Any]], y_tol: float = 0.004) -> List[List[Dict[str, Any]]]:
    if not tokens:
        return []
    toks = sorted(tokens, key=lambda t: (t["bbox"]["y0"], t["bbox"]["x0"]))
    lines: List[List[Dict[str, Any]]] = []
    cur: List[Dict[str, Any]] = []
    cur_y: Optional[float] = None
    for t in toks:
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


def _text_from_tokens(tokens: List[Dict[str, Any]]) -> str:
    return " ".join(_tok_text(t) for t in sorted(tokens, key=lambda x: (x["bbox"]["y0"], x["bbox"]["x0"])) if _tok_text(t))


def _lines_from_tokens(tokens: List[Dict[str, Any]]) -> List[str]:
    lines = _group_lines(tokens)
    out = []
    for line in lines:
        s = " ".join(_tok_text(t) for t in line if _tok_text(t))
        if s:
            out.append(s)
    return out


def _tokens_in_region(tokens_by_page: Dict[int, List[Dict[str, Any]]], page: int, bbox: List[float]) -> List[Dict[str, Any]]:
    x0, y0, x1, y1 = bbox
    out: List[Dict[str, Any]] = []
    for t in tokens_by_page.get(page, []):
        b = t["bbox"]
        if b["x1"] <= x0 or b["x0"] >= x1:
            continue
        if b["y0"] >= y1 or b["y1"] <= y0:
            continue
        out.append(t)
    return out


def _find_by_patterns(texts: List[str], patterns: List[str]) -> Optional[str]:
    for pat in patterns or []:
        try:
            rx = re.compile(pat, flags=re.IGNORECASE)
        except re.error:
            continue
        for line in texts:
            m = rx.search(line)
            if m:
                return (m.group(1) if m.groups() else m.group(0)).strip()
    return None


def _find_currency(texts: List[str], currency_order: List[str], currency_hints: List[str]) -> Optional[str]:
    up = "\n".join(texts).upper()
    for c in (currency_order or []):
        if c and c.upper() in up:
            return c.upper()
    for h in (currency_hints or []):
        if h and h.upper() in up:
            return h.upper()
    return None


# ---------------- main extraction ----------------

def extract_fields(tokens_path: Path, segments_path: Path, items_path: Path, cfg_path: Path) -> Dict[str, Any]:
    cfg = _load_config(cfg_path)
    st7 = cfg["stage7"]

    tdata = _load_json(tokens_path)
    sdata = _load_json(segments_path)
    idata = _load_json(items_path)

    # Build tokens index by page
    tokens_by_page: Dict[int, List[Dict[str, Any]]] = {}
    for t in tdata.get("tokens", []):
        tokens_by_page.setdefault(int(t.get("page", 1)), []).append(t)

    # Find regions (by id or label)
    regions = {seg.get("label") or seg.get("id"): seg for seg in sdata.get("segments", [])}
    regmap = st7.get("regions") or {}

    def get_region_tokens(key: str) -> List[Dict[str, Any]]:
        seg_id = regmap.get(key)
        if not seg_id or seg_id not in regions:
            return []
        seg = regions[seg_id]
        page = int(seg.get("page", 1))
        bbox = seg.get("bbox", [0, 0, 1, 1])
        return _tokens_in_region(tokens_by_page, page, bbox)

    # Extract texts/lines from regions
    inv_tokens = get_region_tokens("invoice_no")
    date_tokens = get_region_tokens("invoice_date")
    cust_tokens = get_region_tokens("customer_id")
    seller_tokens = get_region_tokens("seller")
    header_tokens = get_region_tokens("header")

    inv_text = _text_from_tokens(inv_tokens)
    date_text = _text_from_tokens(date_tokens)
    cust_text = _text_from_tokens(cust_tokens)
    seller_lines = _lines_from_tokens(seller_tokens)
    header_lines = _lines_from_tokens(header_tokens)

    # Patterns against region texts/lines
    invoice_no = _find_by_patterns([inv_text] + header_lines, st7.get("invoice_no_patterns") or [])
    invoice_date = _find_by_patterns([date_text] + header_lines, st7.get("date_patterns") or [])
    po_ref = _find_by_patterns(header_lines, st7.get("po_patterns") or [])
    cust_code = _find_by_patterns([cust_text] + header_lines, st7.get("customer_code_patterns") or [])

    # Payment terms from header lines
    pterms = None
    labels = [s for s in (st7.get("payment_terms", {}).get("label_contains") or []) if s]
    if labels and header_lines:
        idx = None
        for i, line in enumerate(header_lines):
            LU = line.upper()
            if any(l.upper() in LU for l in labels):
                idx = i; break
        if idx is not None:
            take = [header_lines[idx]]
            more = int(st7.get("payment_terms", {}).get("include_next_n_rows", 0))
            for k in range(1, more + 1):
                if idx + k < len(header_lines):
                    take.append(header_lines[idx + k])
            pterms = " ".join(take).strip()

    # Seller from region (first line)
    seller_name = seller_lines[0] if seller_lines else None

    # Currency scan
    currency = _find_currency(header_lines, st7.get("currency_order") or [], cfg.get("currency_hints") or [])

    # Subtotal from Stage 6 items
    items = idata.get("items", [])
    subtotal = Decimal("0")
    for it in items:
        amt = it.get("amount")
        if isinstance(amt, (int, float)):
            subtotal += Decimal(str(amt))

    header = {
        "invoice_no": invoice_no,
        "invoice_date": invoice_date,
        "seller_name": seller_name,
        "buyer_name": None,
        "buyer_address": None,
        "po_reference": po_ref,
        "buyer_id": cust_code,
        "payment_terms": pterms,
        "currency": currency,
    }

    totals = {
        "subtotal": float(subtotal),
        "tax_rate": None,
        "tax_amount": None,
        "tax_base": None,
        "tax_label": None,
        "grand_total": None,
    }

    out = {
        "doc_id": tdata.get("doc_id"),
        "stage": "fields",
        "version": "3.0-regions+tokens",
        "header": header,
        "buyer_id": cust_code,
        "totals": totals,
        "items_ref": {"path": str(items_path)},
        "summary": {"item_count": len(items), "currency": currency},
        "validations": {"notes": [k for k, v in header.items() if v in (None, "", [])]},
    }
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 7 — Field Extraction (Regions + Tokens)")
    ap.add_argument("--tokens", required=True, help="02-normalized.json")
    ap.add_argument("--segments", required=True, help="03-segments.json")
    ap.add_argument("--items", required=True, help="06-items.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--config", required=True, help="Layout config JSON with a 'stage7' section")
    args = ap.parse_args()

    out = extract_fields(Path(args.tokens).resolve(), Path(args.segments).resolve(), Path(args.items).resolve(), Path(args.config).resolve())
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(json.dumps({
        "stage": out["stage"],
        "doc_id": out.get("doc_id"),
        "invoice_no": out.get("header", {}).get("invoice_no"),
        "invoice_date": out.get("header", {}).get("invoice_date"),
        "buyer": out.get("header", {}).get("buyer_name"),
        "buyer_id": out.get("buyer_id"),
        "seller": out.get("header", {}).get("seller_name"),
        "currency": out.get("header", {}).get("currency"),
        "item_count": out.get("summary", {}).get("item_count"),
        "subtotal": out.get("totals", {}).get("subtotal"),
        "out": str(out_path),
    }, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
