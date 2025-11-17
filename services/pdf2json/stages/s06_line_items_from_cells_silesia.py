#!/usr/bin/env python3
"""Offline extractor for Silesia invoice line items (PDF or s02 tokens)."""
from __future__ import annotations

import argparse
import csv
import json
import logging
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, getcontext
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:  # Optional; s02 path works without it
    import pdfplumber  # type: ignore
except Exception:  # pragma: no cover
    pdfplumber = None

LOGGER = logging.getLogger("silesia-s06")
getcontext().prec = 28


@dataclass
class Token:
    page: int
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    width: float
    height: float

    @property
    def x_mid(self) -> float:
        return (self.x0 + self.x1) / 2.0

    @property
    def y_mid(self) -> float:
        return (self.y0 + self.y1) / 2.0


@dataclass
class RowSlice:
    page: int
    y_mid: float
    index_in_page: int
    col_text: Dict[str, str]
    raw_text: str


ColumnRanges = Dict[str, Tuple[float, float]]
REQUIRED_COLUMNS = ("item", "description", "qty", "unit_price", "amount")
HEADER_GAP_TOL = 6.0
CLUSTER_GAP = 48.0
ROW_CLUSTER_TOL = 3.8
FOOTER_Y_THRESHOLD = 650.0
FOOTER_STOP_PATTERNS = (
    "swift code",
    "account name",
    "account number",
    "pt. silesia",
    "bank dbs",
    "pergudangan",
)
HS_CODE = 330200
DEFAULT_UOM = "KG"
DEFAULT_NOTES = "defaulted discount_percent"
PACKAGING_KEYWORDS = (
    "country of origin",
    "plastic",
    "packaging",
    "evoh",
    "ex-protection",
    "carton box",
    "pe-inlined",
)


def _tidy_text(parts: Sequence[str]) -> str:
    raw = " ".join(p for p in parts if p)
    raw = raw.replace("\xa0", " ")
    raw = re.sub(r"\s+", " ", raw).strip()
    if not raw:
        return ""
    raw = re.sub(r"\s+([,.;:!?])", r"\1", raw)
    raw = re.sub(r"([(@\[])\s+", r"\1", raw)
    raw = re.sub(r"\s+([)\]])", r"\1", raw)
    raw = re.sub(r"\((\d+)\s+", r"(\1", raw)
    raw = raw.replace("- ", "-")
    return raw.strip()


def _parse_number(text: Optional[str]) -> Optional[int]:
    if not text:
        return None
    cleaned = text.replace("\xa0", "").replace(" ", "")
    cleaned = cleaned.replace(".", "").replace(",", ".")
    if not cleaned:
        return None
    try:
        value = Decimal(cleaned)
    except InvalidOperation:
        return None
    if value == value.to_integral_value():
        return int(value)
    return float(value)


def _load_tokens_from_pdf(pdf_path: Path) -> Tuple[List[Token], Dict[int, Tuple[float, float]], str]:
    if pdfplumber is None:
        raise RuntimeError("pdfplumber is required to read PDF inputs")
    tokens: List[Token] = []
    page_dims: Dict[int, Tuple[float, float]] = {}
    with pdfplumber.open(str(pdf_path)) as pdf:
        for idx, page in enumerate(pdf.pages, start=1):
            width = float(page.width)
            height = float(page.height)
            page_dims[idx] = (width, height)
            words = page.extract_words(use_text_flow=True, keep_blank_chars=False, extra_attrs=[])
            words.sort(key=lambda w: (w.get("top", 0.0), w.get("x0", 0.0)))
            for w in words:
                text = (w.get("text") or "").strip()
                if not text:
                    continue
                tokens.append(
                    Token(
                        page=idx,
                        text=text,
                        x0=float(w.get("x0", 0.0)),
                        y0=float(w.get("top", 0.0)),
                        x1=float(w.get("x1", 0.0)),
                        y1=float(w.get("bottom", 0.0)),
                        width=width,
                        height=height,
                    )
                )
    tokens.sort(key=lambda t: (t.page, t.y_mid, t.x_mid))
    return tokens, page_dims, pdf_path.name


def _load_tokens_from_s02(json_path: Path) -> Tuple[List[Token], Dict[int, Tuple[float, float]], str]:
    data = json.loads(json_path.read_text())
    page_dims = {int(p["page"]): (float(p.get("width", 0.0)), float(p.get("height", 0.0))) for p in data.get("pages", [])}
    tokens: List[Token] = []
    for entry in data.get("plumber", {}).get("tokens", []):
        text = (entry.get("text") or "").strip()
        if not text:
            continue
        abs_bbox = entry.get("abs_bbox") or {}
        page = int(entry.get("page", 1))
        width, height = page_dims.get(page, (float(abs_bbox.get("width", 0.0)), float(abs_bbox.get("height", 0.0))))
        tokens.append(
            Token(
                page=page,
                text=text,
                x0=float(abs_bbox.get("x0", 0.0)),
                y0=float(abs_bbox.get("y0", 0.0)),
                x1=float(abs_bbox.get("x1", 0.0)),
                y1=float(abs_bbox.get("y1", 0.0)),
                width=width,
                height=height,
            )
        )
    tokens.sort(key=lambda t: (t.page, t.y_mid, t.x_mid))
    doc_id = data.get("doc_id") or json_path.name
    return tokens, page_dims, doc_id


def _group_header_tokens(tokens: List[Token], header_y: float) -> List[List[Token]]:
    band = [t for t in tokens if abs(t.y_mid - header_y) <= HEADER_GAP_TOL]
    band.sort(key=lambda t: t.x_mid)
    clusters: List[List[Token]] = []
    for tok in band:
        stripped = tok.text.replace(" ", "")
        if stripped and set(stripped) <= {"_", "-"}:
            continue
        clusters.append([tok])
    return clusters


def _classify_header(text: str) -> Optional[str]:
    clean = re.sub(r"[^a-z/ ]", "", text.lower())
    if not clean:
        return None
    if "material" in clean or "denomination" in clean:
        return "description"
    if "quantity" in clean:
        return "qty"
    if "idr" in clean:
        return "unit_price"
    if "total" in clean or "value" in clean:
        return "amount"
    if "item" in clean:
        return "item"
    return None


def _build_column_ranges(clusters: List[List[Token]]) -> Optional[Tuple[float, ColumnRanges]]:
    header_y: Optional[float] = None
    headers: List[Dict[str, float]] = []
    for cluster in clusters:
        label = _tidy_text([tok.text for tok in cluster])
        name = _classify_header(label)
        if not name:
            continue
        x_min = min(tok.x0 for tok in cluster)
        x_max = max(tok.x1 for tok in cluster)
        header_y = header_y or cluster[0].y_mid
        if headers and headers[-1]["name"] == name:
            headers[-1]["x_min"] = min(headers[-1]["x_min"], x_min)
            headers[-1]["x_max"] = max(headers[-1]["x_max"], x_max)
            headers[-1]["x_center"] = (headers[-1]["x_min"] + headers[-1]["x_max"]) / 2.0
        else:
            headers.append({"name": name, "x_min": x_min, "x_max": x_max, "x_center": (x_min + x_max) / 2.0})
    names = {h["name"] for h in headers}
    if not set(REQUIRED_COLUMNS).issubset(names) or header_y is None:
        return None
    headers.sort(key=lambda h: h["x_center"])
    ranges: ColumnRanges = {}
    for idx, col in enumerate(headers):
        if idx == 0:
            left = col["x_min"] - 20.0
        else:
            left = (headers[idx - 1]["x_center"] + col["x_center"]) / 2.0
        if idx == len(headers) - 1:
            right = col["x_max"] + 20.0
        else:
            right = (col["x_center"] + headers[idx + 1]["x_center"]) / 2.0
        ranges[col["name"]] = (left, right)
    return header_y, ranges


def _group_rows(page_tokens: List[Token], header_y: float) -> List[List[Token]]:
    body = [t for t in page_tokens if t.y_mid > header_y + 1.0]
    body.sort(key=lambda t: t.y_mid)
    rows: List[List[Token]] = []
    current: List[Token] = []
    last_y: Optional[float] = None
    for tok in body:
        if last_y is None or tok.y_mid - last_y <= ROW_CLUSTER_TOL:
            current.append(tok)
        else:
            rows.append(current)
            current = [tok]
        last_y = tok.y_mid
    if current:
        rows.append(current)
    return rows


def _row_to_slice(row_tokens: List[Token], page: int, idx: int, ranges: ColumnRanges) -> RowSlice:
    col_texts: Dict[str, List[str]] = {name: [] for name in REQUIRED_COLUMNS}
    for tok in sorted(row_tokens, key=lambda t: t.x_mid):
        for name, (x0, x1) in ranges.items():
            if x0 <= tok.x_mid <= x1:
                col_texts[name].append(tok.text)
                break
    combined = {name: _tidy_text(parts) for name, parts in col_texts.items()}
    raw_text = _tidy_text([tok.text for tok in row_tokens])
    y_mid = sum(tok.y_mid for tok in row_tokens) / len(row_tokens)
    return RowSlice(page=page, y_mid=y_mid, index_in_page=idx, col_text=combined, raw_text=raw_text)


def _extract_rows(tokens: List[Token]) -> List[List[RowSlice]]:
    by_page: Dict[int, List[Token]] = {}
    for tok in tokens:
        by_page.setdefault(tok.page, []).append(tok)
    pages: List[List[RowSlice]] = []
    for page in sorted(by_page):
        page_tokens = by_page[page]
        header_tokens = [t for t in page_tokens if "material/denomination" in t.text.lower()]
        if not header_tokens:
            pages.append([])
            continue
        header_y = min(t.y_mid for t in header_tokens)
        clusters = _group_header_tokens(page_tokens, header_y)
        header_info = _build_column_ranges(clusters)
        if not header_info:
            pages.append([])
            continue
        header_y_exact, ranges = header_info
        row_groups = _group_rows(page_tokens, header_y_exact)
        slices: List[RowSlice] = []
        for idx, group in enumerate(row_groups):
            slice_row = _row_to_slice(group, page, idx, ranges)
            if not slice_row.raw_text:
                continue
            slices.append(slice_row)
        pages.append(slices)
    return pages


def _process_rows(pages: List[List[RowSlice]]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    def _is_packaging_line(row: RowSlice) -> bool:
        text = row.raw_text.lower()
        if any(pat in text for pat in PACKAGING_KEYWORDS):
            return True
        qty_text = (row.col_text.get("qty") or "").lower()
        if any(k in qty_text for k in ("kg", "can", "l", "carton", "box")) and any(ch.isdigit() for ch in qty_text):
            return True
        desc_text = (row.col_text.get("description") or "").lower()
        if any(pat in desc_text for pat in PACKAGING_KEYWORDS):
            return True
        return False

    def new_current() -> Dict[str, Any]:
        return {
            "sku_parts": [],
            "description_parts": [],
            "qty": None,
            "unit_price": None,
            "amount": None,
            "ready": False,
        }

    def finalize_current() -> None:
        nonlocal current
        if not current:
            return
        if current["qty"] is None or current["amount"] is None:
            return
        sku = _tidy_text(current.get("sku_parts", [])) or None
        description = _tidy_text(current.get("description_parts", [])) or None
        items.append(
            {
                "no": len(items) + 1,
                "hs_code": HS_CODE,
                "sku": sku,
                "code": None,
                "description": description,
                "type": None,
                "qty": current["qty"],
                "uom": DEFAULT_UOM,
                "unit_price": current["unit_price"],
                "discount_amount": None,
                "discount_percent": 0,
                "amount": current["amount"],
            }
        )
        current = None

    for page_rows in pages:
        for row in page_rows:
            if row.y_mid > FOOTER_Y_THRESHOLD:
                break
            lower = row.raw_text.lower()
            if row.raw_text.count("_") > 5:
                continue
            if any(pat in lower for pat in FOOTER_STOP_PATTERNS):
                break
            item_text = row.col_text.get("item", "")
            desc_text = row.col_text.get("description", "")
            raw_qty = row.col_text.get("qty")
            raw_unit = row.col_text.get("unit_price")
            raw_amount = row.col_text.get("amount")

            # Skip ancillary packaging/origin lines so descriptions stay concise
            if _is_packaging_line(row):
                continue

            qty_val = _parse_number(raw_qty)
            unit_val = _parse_number(raw_unit)
            amount_val = _parse_number(raw_amount)
            has_numbers = any(v is not None for v in (qty_val, unit_val, amount_val))

            if not has_numbers:
                extra_desc: List[str] = []
                for value, parsed in ((raw_qty, qty_val), (raw_unit, unit_val), (raw_amount, amount_val)):
                    if value and parsed is None and re.search(r"[a-zA-Z]", value):
                        extra_desc.append(value)
                if extra_desc:
                    desc_text = _tidy_text([desc_text, " ".join(extra_desc)]) if desc_text else _tidy_text(extra_desc)

            if item_text and not has_numbers and re.search(r"[a-zA-Z]", item_text):
                if current:
                    current.setdefault("description_parts", []).append(item_text)
                elif items:
                    items[-1]["description"] = _tidy_text([items[-1]["description"], item_text])
                else:
                    current = new_current()
                    current.setdefault("description_parts", []).append(item_text)
                item_text = ""

            if has_numbers and current and current.get("ready"):
                finalize_current()

            if has_numbers:
                current = current or new_current()
                if item_text:
                    current.setdefault("sku_parts", []).append(item_text)
                if desc_text:
                    current.setdefault("description_parts", []).append(desc_text)
                if qty_val is not None:
                    current["qty"] = qty_val
                if unit_val is not None:
                    current["unit_price"] = unit_val
                if amount_val is not None:
                    current["amount"] = amount_val
                current["ready"] = True
                continue

            if item_text and current and current.get("ready"):
                finalize_current()

            if item_text:
                current = current or new_current()
                current.setdefault("sku_parts", []).append(item_text)

            if desc_text:
                if current:
                    current.setdefault("description_parts", []).append(desc_text)
                elif items:
                    items[-1]["description"] = _tidy_text([items[-1]["description"], desc_text])
                else:
                    current = new_current()
                    current.setdefault("description_parts", []).append(desc_text)

        # keep current open across pages for continuation

    if current and current.get("ready"):
        finalize_current()

    return items


def _write_debug_csv(rows: List[List[RowSlice]], path: Path) -> None:
    headers = ["page", "row_index", "y_mid", "item", "description", "qty", "unit_price", "amount", "raw_text"]
    with path.open("w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(headers)
        for page_rows in rows:
            for row in page_rows:
                writer.writerow([
                    row.page,
                    row.index_in_page,
                    f"{row.y_mid:.2f}",
                    row.col_text.get("item", ""),
                    row.col_text.get("description", ""),
                    row.col_text.get("qty", ""),
                    row.col_text.get("unit_price", ""),
                    row.col_text.get("amount", ""),
                    row.raw_text,
                ])


def _build_output(doc_id: str, items: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "doc_id": doc_id,
        "items": items,
        "stage": "line_items",
        "version": "silesia-line-items-1.0",
        "notes": DEFAULT_NOTES,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract Silesia line items from PDF or s02 tokens.")
    parser.add_argument("--input", required=True, help="Path to PDF or s02.json")
    parser.add_argument("--out", help="Optional path for s06.json (default: alongside input)")
    parser.add_argument("--debug", action="store_true", help="Emit debug CSV of extracted rows")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO, format="%(levelname)s: %(message)s")

    input_path = Path(args.input)
    if not input_path.exists():
        raise FileNotFoundError(input_path)

    out_path = Path(args.out) if args.out else input_path.parent / "s06.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if input_path.suffix.lower() == ".pdf":
        tokens, _, doc_id = _load_tokens_from_pdf(input_path)
    else:
        tokens, _, doc_id = _load_tokens_from_s02(input_path)

    LOGGER.info("Loaded %s tokens across %s pages", len(tokens), len({t.page for t in tokens}))
    pages = _extract_rows(tokens)
    if args.debug:
        debug_csv = out_path.with_name(out_path.stem + "_debug_rows.csv")
        _write_debug_csv(pages, debug_csv)
        LOGGER.info("Wrote debug rows CSV to %s", debug_csv)
    items = _process_rows(pages)
    LOGGER.info("Extracted %s items", len(items))
    output = _build_output(doc_id, items)
    out_path.write_text(json.dumps(output, indent=2))
    LOGGER.info("Wrote %s", out_path)


if __name__ == "__main__":
    main()
