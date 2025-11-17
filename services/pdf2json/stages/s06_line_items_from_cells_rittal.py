#!/usr/bin/env python3
"""Rittal line-item extractor (strategy v2)."""
from __future__ import annotations

import argparse
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:  # Optional PDF path, falls back to s02 tokens-only mode
    import pdfplumber  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    pdfplumber = None

LOGGER = logging.getLogger("rittal-s06-v2")


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
    tokens: List[Token]
    col_text: Dict[str, str]
    raw_text: str
    index_in_page: int


ColumnRanges = Dict[str, Tuple[float, float]]
REQUIRED_COLUMNS = {"sku", "description", "qty", "unit_price", "discount", "amount"}
HEADER_GAP_TOL = 8.0
CLUSTER_GAP = 32.0
ROW_CLUSTER_TOL = 3.5
ROW_FALLBACK_GAP = 18.0
STOP_WORDS = ("sub", "tax", "vat", "total", "prepared", "note", "description", "says", "halaman")
DEFAULT_NOTES = "defaulted uom; defaulted discount_percent"
DEFAULT_UOM = "PCS"


def _tidy_text(parts: Sequence[str]) -> str:
    raw = " ".join(p for p in parts if p)
    raw = re.sub(r"\s+", " ", raw).strip()
    if not raw:
        return ""
    raw = re.sub(r"\s+([,.;:!?])", r"\1", raw)
    raw = re.sub(r"([(@\[])\s+", r"\1", raw)
    raw = re.sub(r"\s+([)\]])", r"\1", raw)
    raw = re.sub(r"\((\d+)\s+", r"(\1", raw)
    raw = raw.replace("³", "3")
    raw = raw.replace("- ", "-")
    return raw.strip()


def _parse_int(text: Optional[str]) -> Optional[int]:
    if not text:
        return None
    cleaned = re.sub(r"[^0-9-]", "", text)
    if cleaned in ("", "-"):
        return None
    try:
        return int(cleaned)
    except ValueError:
        return None


def _load_tokens_from_pdf(pdf_path: Path) -> Tuple[List[Token], Dict[int, Tuple[float, float]], str]:
    if pdfplumber is None:
        raise RuntimeError("pdfplumber is required for PDF inputs")

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
    pages = {int(p["page"]): (float(p.get("width", 0.0)), float(p.get("height", 0.0))) for p in data.get("pages", [])}
    pl_tokens = data.get("plumber", {}).get("tokens", [])
    tokens: List[Token] = []

    for entry in pl_tokens:
        text = (entry.get("text") or "").strip()
        if not text:
            continue
        abs_bbox = entry.get("abs_bbox") or {}
        page = int(entry.get("page", 1))
        width, height = pages.get(page, (float(abs_bbox.get("width", 0.0)), float(abs_bbox.get("height", 0.0))))
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
    return tokens, pages, doc_id


def _group_header_tokens(tokens: List[Token], header_y: float) -> List[List[Token]]:
    band = [t for t in tokens if abs(t.y_mid - header_y) <= HEADER_GAP_TOL]
    band.sort(key=lambda t: t.x_mid)
    clusters: List[List[Token]] = []
    for tok in band:
        if not clusters:
            clusters.append([tok])
            continue
        prev = clusters[-1]
        prev_max_x = max(pt.x1 for pt in prev)
        if tok.x0 - prev_max_x <= CLUSTER_GAP:
            prev.append(tok)
        else:
            clusters.append([tok])
    return clusters


def _classify_header(label: str) -> Optional[str]:
    clean = re.sub(r"[^a-z0-9@]", "", label.lower())
    if not clean:
        return None
    if "article" in clean or "number" in clean:
        return "sku"
    if "item" in clean or "name" in clean or "description" in clean:
        return "description"
    if "qty" in clean:
        return "qty"
    if "discount" in clean:
        return "discount"
    if "total" in clean and "price" in clean:
        return "amount"
    if "price" in clean or "@price" in clean:
        return "unit_price"
    return None


def _build_column_ranges(clusters: List[List[Token]]) -> Optional[Tuple[float, ColumnRanges]]:
    headers: List[Dict[str, float]] = []
    header_y: Optional[float] = None
    for cluster in clusters:
        label = _tidy_text([tok.text for tok in cluster])
        name = _classify_header(label)
        if not name:
            continue
        x_min = min(tok.x0 for tok in cluster)
        x_max = max(tok.x1 for tok in cluster)
        x_center = sum(tok.x_mid for tok in cluster) / len(cluster)
        header_y = header_y or cluster[0].y_mid
        headers.append({"name": name, "x_min": x_min, "x_max": x_max, "x_center": x_center})

    found = {h["name"] for h in headers}
    if not REQUIRED_COLUMNS.issubset(found) or header_y is None:
        return None

    headers.sort(key=lambda h: h["x_center"])
    ranges: ColumnRanges = {}
    meta_by_name = {h["name"]: h for h in headers}
    for idx, col in enumerate(headers):
        if idx == 0:
            left = col["x_min"] - 25.0
        else:
            left = (headers[idx - 1]["x_center"] + col["x_center"]) / 2.0
        if idx == len(headers) - 1:
            right = col["x_max"] + 25.0
        else:
            right = (col["x_center"] + headers[idx + 1]["x_center"]) / 2.0
        ranges[col["name"]] = (left, right)

    if "description" in ranges and "qty" in ranges:
        desc_left, desc_right = ranges["description"]
        qty_left, qty_right = ranges["qty"]
        qty_center = meta_by_name["qty"]["x_center"]
        target_right = qty_center - 18.0
        max_allowed = qty_right - 15.0
        new_right = max(desc_right, target_right)
        new_right = min(new_right, max_allowed)
        if new_right > desc_left + 5:
            ranges["description"] = (desc_left, new_right)
            ranges["qty"] = (new_right, qty_right)

    if "sku" in ranges:
        sku_left, sku_right = ranges["sku"]
        sku_max = meta_by_name["sku"]["x_max"] + 4.0
        ranges["sku"] = (sku_left, min(sku_right, sku_max))

    if "description" in ranges and "sku" in ranges:
        desc_left, desc_right = ranges["description"]
        sku_right = ranges["sku"][1]
        new_left = max(desc_left - 15.0, sku_right + 4.0)
        ranges["description"] = (min(new_left, desc_left), desc_right)
    return header_y, ranges


def _assign_column(tok: Token, ranges: ColumnRanges) -> Optional[str]:
    x = tok.x_mid
    for name, (left, right) in ranges.items():
        if left <= x <= right:
            return name
    return None


def _group_rows(page_tokens: List[Token], header_y: float) -> List[List[Token]]:
    body = [t for t in page_tokens if t.y_mid > header_y + 1.0]
    if not body:
        return []
    body.sort(key=lambda t: t.y_mid)
    rows: List[List[Token]] = []
    current: List[Token] = []
    last_y = None
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
        col = _assign_column(tok, ranges)
        if col in col_texts:
            col_texts[col].append(tok.text)
    combined = {k: _tidy_text(v) for k, v in col_texts.items()}
    raw_text = _tidy_text([tok.text for tok in row_tokens])
    return RowSlice(
        page=page,
        y_mid=sum(t.y_mid for t in row_tokens) / len(row_tokens),
        tokens=row_tokens,
        col_text=combined,
        raw_text=raw_text,
        index_in_page=idx,
    )


def _should_stop_row(row_text: str) -> bool:
    low = row_text.lower()
    if not low:
        return False
    if "total price" in low:  # avoid cutting legitimate numeric rows
        return False
    return any(word in low for word in STOP_WORDS)


def _extract_rows(tokens: List[Token]) -> Tuple[List[List[RowSlice]], Dict[int, ColumnRanges]]:
    by_page: Dict[int, List[Token]] = {}
    for tok in tokens:
        by_page.setdefault(tok.page, []).append(tok)

    pages_rows: List[List[RowSlice]] = []
    page_ranges: Dict[int, ColumnRanges] = {}

    for page in sorted(by_page):
        page_tokens = by_page[page]
        article_tokens = [t for t in page_tokens if t.text.lower().startswith("article")]
        if not article_tokens:
            pages_rows.append([])
            continue
        header_y = min(t.y_mid for t in article_tokens)
        clusters = _group_header_tokens(page_tokens, header_y)
        header_info = _build_column_ranges(clusters)
        if not header_info:
            pages_rows.append([])
            continue
        header_y_exact, ranges = header_info
        page_ranges[page] = ranges
        row_groups = _group_rows(page_tokens, header_y_exact)
        slices: List[RowSlice] = []
        for idx, group in enumerate(row_groups):
            slice_row = _row_to_slice(group, page, idx, ranges)
            if _should_stop_row(slice_row.raw_text):
                break
            slices.append(slice_row)
        pages_rows.append(slices)
    return pages_rows, page_ranges


def _build_output(doc_id: str, items: List[Dict[str, Any]]) -> Dict[str, Any]:
    for idx, item in enumerate(items, start=1):
        item["no"] = idx
    return {
        "doc_id": doc_id,
        "items": items,
        "stage": "line_items",
        "version": "rittal-line-items-v2",
        "notes": DEFAULT_NOTES,
    }


def _number_from_text(text: Optional[str]) -> Optional[int]:
    if not text:
        return None
    cleaned = text.replace(".", "").replace(",", "")
    cleaned = re.sub(r"[^0-9-]", "", cleaned)
    if cleaned in ("", "-"):
        return None
    return int(cleaned)


def _finalize_item(current: Optional[Dict[str, Any]], items: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not current:
        return None
    if current.get("qty") is None or current.get("amount") is None:
        return current
    item = {
        "no": len(items) + 1,
        "hs_code": None,
        "sku": _tidy_text(current.get("article_parts", [])) or None,
        "code": None,
        "description": _tidy_text(current.get("description_parts", [])) or None,
        "type": None,
        "qty": current.get("qty"),
        "uom": DEFAULT_UOM,
        "unit_price": current.get("unit_price"),
        "discount_amount": current.get("discount_amount"),
        "discount_percent": 0,
        "amount": current.get("amount"),
    }
    items.append(item)
    return None


def _process_rows(pages_rows: List[List[RowSlice]]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    for page_rows in pages_rows:
        for row in page_rows:
            article_text = row.col_text.get("sku")
            desc_text = row.col_text.get("description")
            qty_val = _number_from_text(row.col_text.get("qty"))
            unit_val = _number_from_text(row.col_text.get("unit_price"))
            discount_val = _number_from_text(row.col_text.get("discount"))
            amount_val = _number_from_text(row.col_text.get("amount"))
            has_numbers = any(v is not None for v in (qty_val, unit_val, amount_val))

            article_alpha = article_text and not any(ch.isdigit() for ch in article_text)
            if article_text and desc_text and not has_numbers and article_alpha:
                if current:
                    current.setdefault("article_parts", []).append(article_text)
                elif items:
                    items[-1]["sku"] = _tidy_text([items[-1].get("sku") or "", article_text])
                article_text = ""

            if (not current) and desc_text and not article_text and not has_numbers and items:
                compact = desc_text.replace(" ", "")
                if compact.isdigit():
                    existing = items[-1].get("sku") or ""
                    if desc_text.strip() and desc_text.strip() not in existing:
                        items[-1]["sku"] = _tidy_text([existing, desc_text])
                else:
                    items[-1]["description"] = _tidy_text([items[-1].get("description") or "", desc_text])
                continue

            if not current:
                if not (article_text or desc_text or has_numbers):
                    continue
                current = {"article_parts": [], "description_parts": [], "qty": None, "unit_price": None, "discount_amount": None, "amount": None}

            if article_text:
                if current and current.get("qty") is not None and current.get("amount") is not None:
                    current = _finalize_item(current, items)
                    if current is None:
                        current = {"article_parts": [], "description_parts": [], "qty": None, "unit_price": None, "discount_amount": None, "amount": None}
                if current is None:
                    current = {"article_parts": [], "description_parts": [], "qty": None, "unit_price": None, "discount_amount": None, "amount": None}
                current.setdefault("article_parts", []).append(article_text)

            if desc_text:
                if not current:
                    current = {"article_parts": [], "description_parts": [], "qty": None, "unit_price": None, "discount_amount": None, "amount": None}
                current.setdefault("description_parts", []).append(desc_text)

            if has_numbers:
                if not current:
                    current = {"article_parts": [], "description_parts": [], "qty": None, "unit_price": None, "discount_amount": None, "amount": None}
                if qty_val is not None:
                    current["qty"] = qty_val
                if unit_val is not None:
                    current["unit_price"] = unit_val
                if amount_val is not None:
                    current["amount"] = amount_val
                if discount_val not in (None, 0):
                    current["discount_amount"] = discount_val
                else:
                    current["discount_amount"] = None
                current = _finalize_item(current, items)

        if current and current.get("qty") is not None and current.get("amount") is not None:
            current = _finalize_item(current, items)

    if current and current.get("qty") is not None and current.get("amount") is not None:
        current = _finalize_item(current, items)

    return items


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract Rittal line items (strategy v2)")
    parser.add_argument("--input", required=True, help="PDF or s02.json path")
    parser.add_argument("--out", help="Where to write s06.json (default next to input)")
    parser.add_argument("--debug", action="store_true", help="Enable verbose logging")
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
    pages_rows, _ = _extract_rows(tokens)
    items = _process_rows(pages_rows)
    LOGGER.info("Extracted %s items", len(items))

    output = _build_output(doc_id, items)
    out_path.write_text(json.dumps(output, indent=2))
    LOGGER.info("Wrote output to %s", out_path)


if __name__ == "__main__":
    main()
