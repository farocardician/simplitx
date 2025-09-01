#!/usr/bin/env python3
# Stage 6 — Line-Item Extraction (STRICT, 100% config-driven)
# Inputs :
#   --cells  /path/to/04-cells.json
#   --config /path/to/invoice_layout.json   (REQUIRED)
# Output :
#   --out    /path/to/06-items.json
from __future__ import annotations

import argparse, json, re, sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, List, Optional

# ---------------- Number / text helpers ----------------
def _canon(s: str) -> str:
    return "".join(ch for ch in (s or "").upper() if ch.isalnum())

def _clean_spaces(s: str) -> str:
    s = (s or "").replace("\xa0", " ")
    s = " ".join(s.split())
    return s.strip()

def _strip_currency(s: str, hints: List[str]) -> str:
    if not s: return s
    z = s
    for h in hints or []:
        if not h: continue
        z = z.replace(h, "")
        z = z.replace(h.upper(), "")
        z = z.replace(h.lower(), "")
    return _clean_spaces(z)

def _parse_decimal(s: str, thousands: str = ",", decimal: str = ".", allow_parens: bool = True,
                   currency_hints: Optional[List[str]] = None) -> Optional[Decimal]:
    if s is None: return None
    z = _clean_spaces(str(s))
    if currency_hints:
        z = _strip_currency(z, currency_hints)
    neg = False
    if allow_parens and z.startswith("(") and z.endswith(")"):
        neg = True
        z = z[1:-1]
    # strip any currency-like tokens again after parens handling
    if currency_hints:
        z = _strip_currency(z, currency_hints)
    # remove thousands, normalize decimal
    if thousands and thousands != "":
        z = z.replace(thousands, "")
    if decimal and decimal != ".":
        z = z.replace(decimal, ".")
    # keep digits and one dot
    z = re.sub(r"[^0-9.]", "", z)
    if not z or z == ".":
        return None
    try:
        v = Decimal(z)
        return -v if neg else v
    except InvalidOperation:
        return None

def _parse_int(s: str) -> Optional[int]:
    s = _clean_spaces(s)
    if not s or not re.fullmatch(r"[0-9]+", s):
        return None
    try:
        return int(s)
    except ValueError:
        return None

def _fix_desc(s: str) -> str:
    # Tidy a few wrap artifacts seen in sample docs; keep short
    s = re.sub(r"\bD engan\b", "Dengan", s)
    s = re.sub(r"\bPi ntar\b", "Pintar", s)
    s = re.sub(r"\bTr ack\b", "Track", s)
    return _clean_spaces(s)

# --------------- Config helpers (STRICT) ---------------
def _load_config(cfg_path: Path) -> Dict[str,Any]:
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[ERROR] Failed to read config: {e}", file=sys.stderr)
        sys.exit(2)
    # top-level expectations (shared with Stage 4 philosophy)
    for key in ["header_aliases","totals_keywords","camelot","currency_hints","uom_hints"]:
        if key not in cfg:
            print(f"[WARN] Missing '{key}' in config; proceeding but some features may be limited.", file=sys.stderr)
    # stage6 section is recommended
    stage6 = cfg.get("stage6", {})
    if not isinstance(stage6, dict):
        stage6 = {}
    # fill defaults
    stage6.setdefault("required_families", {"must_have_any": ["DESC","AMOUNT","QTY","PRICE"], "id_field": "NO"})
    stage6.setdefault("index_fallback", {})   # mapping from header cell 'name' -> family
    stage6.setdefault("number_format", {"decimal": ".", "thousands": ",", "allow_parens": True})
    stage6.setdefault("derivation", {"fill_amount_from_qty_price": True, "fill_unit_price_from_amount_qty": True})
    stage6.setdefault("rounding", {"money_decimals": 2})
    stage6.setdefault("row_filters", {"drop_if_matches": ["SUBTOTAL","TOTAL","VAT","PPN","DPP","GRAND TOTAL","NOTE","TERMS"]})
    cfg["stage6"] = stage6
    # sanity: header_aliases dictionary
    if "header_aliases" not in cfg or not isinstance(cfg["header_aliases"], dict):
        cfg["header_aliases"] = {}
    return cfg

def _allowed_families(cfg: Dict[str,Any]) -> set:
    """Build the whitelist of valid family names from CONFIG ONLY."""
    fams = set()
    # From header_aliases keys
    fams.update([str(k).upper() for k in (cfg.get("header_aliases") or {}).keys()])
    st6 = cfg.get("stage6") or {}
    # From index_fallback values (e.g., COL5 -> DESC)
    fams.update([str(v).upper() for v in (st6.get("index_fallback") or {}).values()])
    # From required_families (id_field + must_have_any)
    req = st6.get("required_families") or {}
    idf = req.get("id_field")
    if idf:
        fams.add(str(idf).upper())
    fams.update([str(x).upper() for x in (req.get("must_have_any") or [])])
    # Always include common optional fields if config mentions them anywhere in aliases
    # (Already covered via header_aliases keys/values in most setups.)
    return fams

def _family_from_header_text(text: str, header_aliases: Dict[str,List[str]]) -> Optional[str]:
    c = _canon(text)
    if not c: return None
    best = None; best_len = 0
    for fam, arr in (header_aliases or {}).items():
        fam_up = fam.upper()
        for alias in (arr or []):
            p = _canon(alias)
            if p and p in c and len(p) > best_len:
                best, best_len = fam_up, len(p)
    return best

# --------------- Core extraction ---------------
def _map_columns(header_cells: List[Dict[str,Any]], cfg: Dict[str,Any]) -> Dict[int,str]:
    """
    Returns a dict: col_index -> family name
    Priority (CONFIG ONLY):
      1) Explicit index_fallback mapping by header 'name' (e.g., 'COL5' -> 'DESC')
      2) If header 'name' is already one of the allowed families (from config), use it
      3) Try header text via header_aliases
      4) Else keep generic ('COL#') so later logic can still access by name via index_fallback
    """
    aliases = cfg.get("header_aliases") or {}
    idx_fallback = (cfg.get("stage6") or {}).get("index_fallback") or {}
    allowed = _allowed_families(cfg)

    out: Dict[int,str] = {}
    for hc in header_cells:
        col = int(hc.get("col", len(out)))
        hname = str(hc.get("name") or "").upper()
        htext = str(hc.get("text") or "")

        # 1) layout-provided map by header name
        if hname in idx_fallback:
            out[col] = str(idx_fallback[hname]).upper()
            continue
        # 2) header name is already an allowed family (from config)
        if hname in allowed and hname:
            out[col] = hname
            continue
        # 3) map by header text via aliases
        fam = _family_from_header_text(htext, aliases)
        if fam and fam in allowed:
            out[col] = fam
            continue
        # 4) leave as-is (COL#); Stage 6 may still map it via index_fallback by 'COL#'
        out[col] = hname if hname else f"COL{col+1}"
    return out

def _is_drop_row(text_join: str, cfg: Dict[str,Any]) -> bool:
    drop_phrases = ((cfg.get("stage6") or {}).get("row_filters") or {}).get("drop_if_matches", [])
    can = _canon(text_join)
    return any(_canon(p) in can for p in (drop_phrases or []))

def _infer_uom(header_cells: List[Dict[str,Any]], cfg: Dict[str,Any]) -> str:
    # Try to pick a UOM from header hints like "QTY (PCS)"; else default
    uom_hints = cfg.get("uom_hints") or []
    txts = " ".join(_clean_spaces(h.get("text")) for h in (header_cells or []))
    for u in uom_hints:
        if u and re.search(r"\b" + re.escape(u) + r"\b", txts, flags=re.I):
            return u
    return (uom_hints[0] if uom_hints else "PCS")

def _row_to_item_by_map(texts: List[str], colmap: Dict[int,str], uom_default: str, cfg: Dict[str,Any]) -> Optional[Dict[str,Any]]:
    fam2txt: Dict[str,str] = {}
    for i, t in enumerate(texts):
        fam = colmap.get(i)
        fam2txt[fam or f"COL{i+1}"] = t

    st6 = cfg["stage6"]
    req = st6["required_families"]
    id_field = (req.get("id_field") or "NO").upper()
    must_any = [f.upper() for f in (req.get("must_have_any") or [])]

    # Decide if it's an item row
    id_txt = fam2txt.get(id_field) or ""
    if _parse_int(id_txt) is None:
        return None
    joined = " ".join(_clean_spaces(v) for v in fam2txt.values() if v)
    if _is_drop_row(joined, cfg):
        return None
    if must_any:
        has_any = any(_clean_spaces(fam2txt.get(f,"")) for f in must_any)
        if not has_any:
            return None

    # Parse economic fields
    nf = st6["number_format"]
    cur_hints = cfg.get("currency_hints") or []
    qty_txt = fam2txt.get("QTY")
    price_txt = fam2txt.get("PRICE")
    amount_txt = fam2txt.get("AMOUNT")

    qty = _parse_decimal(qty_txt, thousands=nf["thousands"], decimal=nf["decimal"],
                         allow_parens=nf.get("allow_parens", True), currency_hints=cur_hints)
    # keep integers as int
    qty_out: Optional[Any]
    if qty is not None and qty == qty.to_integral():
        qty_out = int(qty)
    else:
        qty_out = float(qty) if qty is not None else None

    unit_price = _parse_decimal(price_txt, thousands=nf["thousands"], decimal=nf["decimal"],
                                allow_parens=nf.get("allow_parens", True), currency_hints=cur_hints)
    amount = _parse_decimal(amount_txt, thousands=nf["thousands"], decimal=nf["decimal"],
                            allow_parens=nf.get("allow_parens", True), currency_hints=cur_hints)

    # Derivations
    drv = st6["derivation"]
    if amount is None and drv.get("fill_amount_from_qty_price") and qty is not None and unit_price is not None:
        amount = qty * unit_price
    if (unit_price is None and drv.get("fill_unit_price_from_amount_qty")
        and amount is not None and qty is not None and qty != 0):
        try:
            unit_price = amount / qty
        except Exception:
            pass

    mdec = st6["rounding"]["money_decimals"]
    def _to_float(d: Optional[Decimal]) -> Optional[float]:
        return float(round(d, mdec)) if d is not None else None

    item = {
        "no": _parse_int(id_txt),
        "hs_code": _clean_spaces(fam2txt.get("HS")) or None,
        "sku": _clean_spaces(fam2txt.get("SKU")) or None,
        "code": _clean_spaces(fam2txt.get("CODE")) or None,
        "description": _fix_desc(_clean_spaces(fam2txt.get("DESC")) or ""),
        "qty": qty_out,
        "uom": _clean_spaces(fam2txt.get("UOM")) or uom_default,
        "unit_price": _to_float(unit_price),
        "amount": _to_float(amount),
    }

    # If description is empty and all economics are None, drop the row
    if (not item["description"]) and item["qty"] is None and item["unit_price"] is None and item["amount"] is None:
        return None

    return item

def extract_items(cells_path: Path, cfg_path: Path) -> Dict[str,Any]:
    cfg = _load_config(cfg_path)

    data = json.loads(cells_path.read_text(encoding="utf-8"))
    items: List[Dict[str, Any]] = []

    for page in data.get("pages", []):
        table = page.get("table") or {}
        if not table:
            continue

        header_cells = table.get("header_cells") or []
        colmap = _map_columns(header_cells, cfg)
        uom_default = _infer_uom(header_cells, cfg)

        # Some layouts may accidentally hold first data row in header_cells — keep this guard
        if header_cells:
            hvals = [c.get("text","") for c in header_cells]
            maybe = _row_to_item_by_map(hvals, colmap, uom_default, cfg)
            if maybe:
                items.append(maybe)

        for r in table.get("rows", []):
            cells = r.get("cells", [])
            texts = [c.get("text","") for c in cells]
            maybe = _row_to_item_by_map(texts, colmap, uom_default, cfg)
            if maybe:
                items.append(maybe)

    # Sort by NO and stabilize by insertion order for ties
    items.sort(key=lambda it: (it.get("no") or 0))

    out = {
        "doc_id": data.get("doc_id"),
        "items": items,
        "stage": "line_items",
        "version": "2.1-config-only",
        "notes": "Families derived solely from config (Stage 6)."
    }
    return out

def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 6 — Line-Item Extraction (STRICT, 100% config-driven)")
    ap.add_argument("--cells", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--config", required=True, help="Layout config JSON used also by Stage 4")
    args = ap.parse_args()

    out = extract_items(Path(args.cells).resolve(), Path(args.config).resolve())
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    preview = [
        {
            "no": it.get("no"),
            "desc": it.get("description"),
            "qty": it.get("qty"),
            "unit_price": it.get("unit_price"),
            "amount": it.get("amount"),
        }
        for it in out["items"][:3]
    ]
    print(json.dumps({
        "stage": out["stage"],
        "doc_id": out["doc_id"],
        "count": len(out["items"]),
        "first_n": preview,
        "out": str(out_path)
    }, ensure_ascii=False, separators=(",", ":")))

if __name__ == "__main__":
    main()
