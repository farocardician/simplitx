#!/usr/bin/env python3
"""Offline Simon line-item extractor (PDF or s02 tokens)."""
from __future__ import annotations

import argparse
import csv
import json
import logging
import re
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation, getcontext
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

try:  # Optional dependency – only required for PDF inputs
    import pdfplumber  # type: ignore
except Exception:  # pragma: no cover
    pdfplumber = None

LOGGER = logging.getLogger("simon-s06")
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

    @property
    def x_norm(self) -> float:
        width = self.width or 1.0
        return self.x_mid / width


@dataclass
class RowCandidate:
    page: int
    y_mid: float
    value: int
    tokens: List[Token] = field(default_factory=list)


HEADER_KEYWORDS = ("no", "hs", "description", "desc", "qty", "unit", "amount")
ANCHOR_X_MAX = 0.16
HEADER_MARGIN = 6.5
ROW_ASSIGN_THRESHOLD = 32.0
TABLE_X_MIN = 0.06
TABLE_X_MAX = 0.94
DEFAULT_UOM = "PCS"
CURRENCY_HINTS = ("idr", "rp")
HEADER_CLUSTER_TOL = 14.0
COLUMN_RANGES: List[Tuple[str, Tuple[float, float]]] = [
    ("no", (0.08, 0.17)),
    ("hs_code", (0.17, 0.24)),
    ("sku", (0.24, 0.39)),
    ("code", (0.34, 0.44)),
    ("description", (0.46, 0.67)),
    ("qty", (0.64, 0.72)),
    ("unit_price", (0.72, 0.80)),
    ("amount", (0.80, 0.92)),
]
DESCRIPTION_FALLBACK = (0.42, 0.74)
FOOTER_STOPWORDS = ("subtotal", "total", "ppn", "tax", "note", "catatan")
CODE_VALUE_PATTERN = re.compile(r"^[0-9A-Za-z]{1,3}$")
IGNORE_TOKEN_TEXTS = {"idr", "(idr)", "rp", "(rp)", "pcs", "(pcs)"}
KNOWN_DUPLICATE_NOS = {120, 600, 610, 620, 630, 640, 650, 660, 1060, 1070}


def tidy_text(parts: Sequence[str]) -> str:
    """Normalize whitespace and punctuation in the provided token texts."""
    cleaned_parts = []
    for part in parts:
        chunk = (part or "").replace("\xa0", " ").strip()
        if chunk:
            cleaned_parts.append(chunk)
    if not cleaned_parts:
        return ""
    raw = " ".join(cleaned_parts)
    raw = re.sub(r"\(cid:\d+\)", " ", raw, flags=re.I)
    raw = re.sub(r"\s+", " ", raw).strip()
    raw = re.sub(r"\s+([,.;:!?])", r"\1", raw)
    raw = re.sub(r"([(@\[])\s+", r"\1", raw)
    raw = re.sub(r"\s+([)\]])", r"\1", raw)
    raw = raw.replace("@", "")
    raw = raw.replace(" -", "-").replace("- ", "-")
    return raw.strip()


def _normalize_number_text(text: Optional[str]) -> Optional[str]:
    """Convert various number formats (e.g. 12.345,67 or 12,345.67) to a Decimal-friendly string."""
    if text is None:
        return None
    cleaned = text.replace("\xa0", " ").strip()
    if not cleaned:
        return None
    negative = False
    if cleaned.startswith("(") and cleaned.endswith(")"):
        negative = True
        cleaned = cleaned[1:-1]
    cleaned = cleaned.replace(" ", "")
    for hint in CURRENCY_HINTS:
        cleaned = re.sub(hint, "", cleaned, flags=re.I)
    cleaned = cleaned.replace("+", "")
    cleaned = re.sub(r"[^\d,.-]", "", cleaned)
    if not cleaned:
        return None

    decimal_sep = "."
    thousands_sep: Optional[str] = None
    if "," in cleaned and "." in cleaned:
        if cleaned.rfind(",") > cleaned.rfind("."):
            decimal_sep = ","
            thousands_sep = "."
        else:
            decimal_sep = "."
            thousands_sep = ","
    elif cleaned.count(",") > 1 and "." not in cleaned:
        thousands_sep = ","
    elif cleaned.count(".") > 1 and "," not in cleaned:
        thousands_sep = "."
    elif cleaned.count(",") == 1 and "." not in cleaned:
        digits_after = len(cleaned.split(",")[1])
        if digits_after <= 3:
            decimal_sep = ","
        else:
            thousands_sep = ","
    elif cleaned.count(".") == 1 and "," not in cleaned:
        digits_after = len(cleaned.split(".")[1])
        if digits_after > 3:
            thousands_sep = "."

    if thousands_sep:
        cleaned = cleaned.replace(thousands_sep, "")
    if decimal_sep == ",":
        cleaned = cleaned.replace(",", ".")

    if negative:
        cleaned = f"-{cleaned}"
    return cleaned or None


def parse_decimal(text: Optional[str]) -> Optional[Decimal]:
    """Parse a numeric string into Decimal while tolerating common separators."""
    normalized = _normalize_number_text(text)
    if normalized is None:
        return None
    try:
        return Decimal(normalized)
    except InvalidOperation:
        LOGGER.debug("Failed to parse decimal from '%s'", text)
        return None


def parse_int(text: Optional[str]) -> Optional[int]:
    """Parse a whole number string."""
    dec = parse_decimal(text)
    if dec is None:
        return None
    try:
        return int(dec)
    except (ValueError, OverflowError):
        LOGGER.debug("Failed to parse int from '%s'", text)
        return None


def load_tokens_from_pdf(pdf_path: Path) -> Tuple[List[Token], Dict[int, Tuple[float, float]], str]:
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


def load_tokens_from_s02(json_path: Path) -> Tuple[List[Token], Dict[int, Tuple[float, float]], str]:
    data = json.loads(json_path.read_text())
    page_dims = {
        int(page["page"]): (float(page.get("width", 0.0)), float(page.get("height", 0.0)))
        for page in data.get("pages", [])
    }
    tokens: List[Token] = []
    for entry in data.get("plumber", {}).get("tokens", []):
        text = (entry.get("text") or "").strip()
        if not text:
            continue
        bbox = entry.get("abs_bbox") or {}
        page_no = int(entry.get("page", 1))
        width, height = page_dims.get(page_no, (float(bbox.get("width", 0.0)), float(bbox.get("height", 0.0))))
        tokens.append(
            Token(
                page=page_no,
                text=text,
                x0=float(bbox.get("x0", 0.0)),
                y0=float(bbox.get("y0", 0.0)),
                x1=float(bbox.get("x1", 0.0)),
                y1=float(bbox.get("y1", 0.0)),
                width=width,
                height=height,
            )
        )
    tokens.sort(key=lambda t: (t.page, t.y_mid, t.x_mid))
    doc_id = data.get("doc_id") or json_path.name
    return tokens, page_dims, doc_id


class SimonExtractor:
    """Coordinator for turning Simon PDF tokens into structured line items."""

    def __init__(
        self,
        tokens: List[Token],
        page_dims: Dict[int, Tuple[float, float]],
        doc_id: str,
        debug_dir: Optional[Path] = None,
    ) -> None:
        self.tokens = tokens
        self.page_dims = page_dims
        self.doc_id = doc_id
        self.debug_dir = debug_dir
        self.tokens_by_page = self._group_tokens_by_page(tokens)

    @staticmethod
    def _group_tokens_by_page(tokens: Sequence[Token]) -> Dict[int, List[Token]]:
        grouped: Dict[int, List[Token]] = {}
        for token in tokens:
            grouped.setdefault(token.page, []).append(token)
        for bucket in grouped.values():
            bucket.sort(key=lambda t: (t.y_mid, t.x_mid))
        return grouped

    def extract(self) -> Dict[str, object]:
        """Run the full extraction pipeline and return the JSON payload."""
        headers = self._detect_header_lines()
        rows = self._build_rows(headers)
        items: List[Dict[str, object]] = []
        extracted_pairs: List[Tuple[RowCandidate, Dict[str, object]]] = []
        for row in rows:
            if self._should_skip_row(row):
                continue
            item = self._row_to_item(row)
            if item:
                items.append(item)
                extracted_pairs.append((row, item))
        if self.debug_dir:
            self._write_debug(extracted_pairs)
        return {"doc_id": self.doc_id, "items": items}

    @staticmethod
    def _looks_like_header(token: Token) -> bool:
        """Return True if the token text resembles a header label."""
        lower = token.text.lower()
        if token.height and token.y_mid / token.height > 0.65:
            return False
        return any(key in lower for key in HEADER_KEYWORDS)

    def _detect_header_lines(self) -> Dict[int, float]:
        """Approximate the header y-position per page (fallback to earliest text)."""
        header_by_page: Dict[int, float] = {}
        for page, tokens in self.tokens_by_page.items():
            header_y = self._select_header_y(tokens)
            header_by_page[page] = header_y
        return header_by_page

    def _select_header_y(self, tokens: Sequence[Token]) -> float:
        hits = [tok for tok in tokens if self._looks_like_header(tok)]
        if not hits:
            fallback = min((tok.y_mid for tok in tokens), default=0.0)
            LOGGER.debug("Page %s: no header keywords detected; fallback %.2f", tokens[0].page if tokens else "?", fallback)
            return fallback
        hits.sort(key=lambda t: t.y_mid)
        clusters: List[List[Token]] = []
        for tok in hits:
            if not clusters or tok.y_mid - clusters[-1][-1].y_mid > HEADER_CLUSTER_TOL:
                clusters.append([tok])
            else:
                clusters[-1].append(tok)
        def cluster_score(cluster: List[Token]) -> Tuple[int, float]:
            return (len(cluster), -cluster[0].y_mid)
        best = max(clusters, key=cluster_score)
        header_y = max(tok.y_mid for tok in best)
        return header_y

    @staticmethod
    def _should_skip_row(row: RowCandidate) -> bool:
        if row.value in KNOWN_DUPLICATE_NOS:
            LOGGER.debug("Skipping known duplicate row %s", row.value)
            return True
        if not row.tokens:
            LOGGER.debug("Skipping row %s with no captured tokens", row.value)
            return True
        return False

    def _build_rows(self, header_map: Dict[int, float]) -> List[RowCandidate]:
        """Cluster tokens into row candidates keyed by their numeric 'No' column."""
        anchors_by_page = self._find_anchor_rows(header_map)
        self._attach_tokens_to_rows(anchors_by_page, header_map)
        ordered_rows: List[RowCandidate] = []
        for page in sorted(anchors_by_page):
            ordered_rows.extend(row for row in anchors_by_page[page] if row.tokens)
        return ordered_rows

    def _find_anchor_rows(self, header_map: Dict[int, float]) -> Dict[int, List[RowCandidate]]:
        anchors_by_page: Dict[int, List[RowCandidate]] = {}
        for page, tokens in self.tokens_by_page.items():
            header_limit = header_map.get(page, 0.0) + HEADER_MARGIN
            page_rows: List[RowCandidate] = []
            for token in tokens:
                if self._is_row_anchor(token, header_limit):
                    try:
                        value = int(token.text)
                    except ValueError:
                        continue
                    page_rows.append(RowCandidate(page=page, y_mid=token.y_mid, value=value))
            if page_rows:
                page_rows.sort(key=lambda row: row.y_mid)
                anchors_by_page[page] = page_rows
            else:
                LOGGER.debug("Page %s: no anchors detected", page)
        return anchors_by_page

    def _attach_tokens_to_rows(self, anchors_by_page: Dict[int, List[RowCandidate]], header_map: Dict[int, float]) -> None:
        for page, anchors in anchors_by_page.items():
            if not anchors:
                continue
            positions = [row.y_mid for row in anchors]
            header_limit = header_map.get(page, 0.0) + HEADER_MARGIN
            for token in self.tokens_by_page.get(page, []):
                if token.y_mid <= header_limit:
                    continue
                if not (TABLE_X_MIN <= token.x_norm <= TABLE_X_MAX):
                    continue
                if self._is_footer_token(token):
                    continue
                anchor = self._nearest_anchor(token.y_mid, anchors, positions)
                if anchor and abs(anchor.y_mid - token.y_mid) <= ROW_ASSIGN_THRESHOLD:
                    anchor.tokens.append(token)

    @staticmethod
    def _is_row_anchor(token: Token, header_limit: float) -> bool:
        if token.x_norm > ANCHOR_X_MAX or token.y_mid <= header_limit:
            return False
        return bool(re.fullmatch(r"\d{1,4}", token.text))

    @staticmethod
    def _nearest_anchor(y_mid: float, anchors: List[RowCandidate], positions: List[float]) -> Optional[RowCandidate]:
        """Binary-search to find the closest row anchor by vertical position."""
        if not anchors:
            return None
        lo, hi = 0, len(positions)
        while lo < hi:
            mid = (lo + hi) // 2
            if y_mid < positions[mid]:
                hi = mid
            else:
                lo = mid + 1
        candidates = []
        if lo < len(anchors):
            candidates.append(anchors[lo])
        if lo > 0:
            candidates.append(anchors[lo - 1])
        if not candidates:
            return None
        best = min(candidates, key=lambda row: abs(row.y_mid - y_mid))
        return best

    @staticmethod
    def _is_footer_token(token: Token) -> bool:
        """Identify footer-like tokens to prevent them joining line rows."""
        lower = token.text.lower()
        return any(lower.startswith(word) for word in FOOTER_STOPWORDS)

    def _split_tokens_into_columns(self, row: RowCandidate) -> Dict[str, List[Token]]:
        columns: Dict[str, List[Token]] = {name: [] for name, _ in COLUMN_RANGES}
        ordered = sorted(row.tokens, key=lambda t: (round(t.y_mid, 1), t.x_mid))
        row.tokens = ordered
        for token in ordered:
            if token.text.strip().lower() in IGNORE_TOKEN_TEXTS:
                continue
            assigned = False
            for name, (x0, x1) in COLUMN_RANGES:
                if x0 <= token.x_norm < x1:
                    columns[name].append(token)
                    assigned = True
                    break
            if not assigned and DESCRIPTION_FALLBACK[0] <= token.x_norm < DESCRIPTION_FALLBACK[1]:
                columns["description"].append(token)
        return columns

    @staticmethod
    def _promote_sku_tokens(columns: Dict[str, List[Token]]) -> None:
        """Some SKU tokens actually hold the numeric CODE column; promote them."""
        for token in list(columns["sku"]):
            clean = re.sub(r"[^0-9A-Za-z]", "", token.text.upper())
            if CODE_VALUE_PATTERN.fullmatch(clean):
                columns["sku"].remove(token)
                columns["code"].append(token)

    @staticmethod
    def _tokens_to_text(tokens: Iterable[Token], single: bool = False) -> str:
        items = list(tokens)
        if single and items:
            items = [items[0]]
        return tidy_text([tok.text for tok in items])

    def _parse_numeric_bundle(
        self, row_no: int, qty_text: str, unit_price_text: str, amount_text: str
    ) -> Optional[Tuple[int, Decimal, Decimal]]:
        qty = parse_int(qty_text)
        unit_price = parse_decimal(unit_price_text)
        amount = parse_decimal(amount_text)
        if qty is None or unit_price is None or amount is None:
            LOGGER.debug(
                "Row %s missing numerics (qty='%s', price='%s', amount='%s')",
                row_no,
                qty_text,
                unit_price_text,
                amount_text,
            )
            return None
        return qty, unit_price, amount

    @staticmethod
    def _validate_amount(row_no: int, qty: int, unit_price: Decimal, amount: Decimal) -> None:
        expected = unit_price * Decimal(qty)
        diff = abs(expected - amount)
        tolerance = max(Decimal("0.05"), expected * Decimal("0.001"))
        if diff > tolerance:
            LOGGER.debug("Row %s: amount mismatch (expected %s vs %s)", row_no, expected, amount)

    @staticmethod
    def _quantize_money(value: Decimal) -> float:
        return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

    def _row_to_item(self, row: RowCandidate) -> Optional[Dict[str, object]]:
        columns = self._split_tokens_into_columns(row)
        self._promote_sku_tokens(columns)

        hs_text = self._tokens_to_text(columns["hs_code"])
        sku_text = self._tokens_to_text(columns["sku"])
        code_text = self._tokens_to_text(columns["code"])
        description = self._tokens_to_text(columns["description"])
        qty_text = self._tokens_to_text(columns["qty"], single=True)
        unit_price_text = self._tokens_to_text(columns["unit_price"], single=True)
        amount_text = self._tokens_to_text(columns["amount"], single=True)

        numeric_bundle = self._parse_numeric_bundle(row.value, qty_text, unit_price_text, amount_text)
        if not numeric_bundle:
            return None
        qty, unit_price, amount = numeric_bundle
        self._validate_amount(row.value, qty, unit_price, amount)

        hs_code = re.sub(r"[^0-9A-Za-z]", "", hs_text) or None
        sku = re.sub(r"[^0-9A-Za-z/-]", "", sku_text.upper()) or None
        clean_code = re.sub(r"\s+", "", code_text or "")
        code = clean_code if CODE_VALUE_PATTERN.fullmatch(clean_code) else None

        item = {
            "no": row.value,
            "hs_code": hs_code,
            "sku": sku,
            "code": code,
            "description": description,
            "type": None,
            "qty": qty,
            "uom": DEFAULT_UOM,
            "unit_price": self._quantize_money(unit_price),
            "discount_amount": None,
            "discount_percent": 0,
            "amount": self._quantize_money(amount),
        }
        return item

    def _write_debug(self, extracted_rows: List[Tuple[RowCandidate, Dict[str, object]]]) -> None:
        debug_dir = self.debug_dir or Path("s06_debug")
        debug_dir.mkdir(parents=True, exist_ok=True)
        rows_csv = debug_dir / "rows_preview.csv"
        tokens_csv = debug_dir / "row_tokens.csv"

        with rows_csv.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["index", "page", "anchor_y", "no", "hs_code", "sku", "code", "qty", "unit_price", "amount", "description"])
            for idx, (row, item) in enumerate(extracted_rows, start=1):
                writer.writerow(
                    [
                        idx,
                        row.page,
                        f"{row.y_mid:.2f}",
                        item.get("no"),
                        item.get("hs_code"),
                        item.get("sku"),
                        item.get("code"),
                        item.get("qty"),
                        item.get("unit_price"),
                        item.get("amount"),
                        item.get("description"),
                    ]
                )

        with tokens_csv.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["row_index", "page", "text", "x0", "y0", "x1", "y1"])
            for idx, (row, _) in enumerate(extracted_rows, start=1):
                for token in row.tokens:
                    writer.writerow([idx, row.page, token.text, f"{token.x0:.2f}", f"{token.y0:.2f}", f"{token.x1:.2f}", f"{token.y1:.2f}"])


def detect_input_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return "pdf"
    if suffix == ".json":
        return "json"
    raise ValueError(f"Unsupported input format for {path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract Simon line items from PDF or s02 tokens.")
    parser.add_argument("--input", required=True, help="Path to PDF or s02.json")
    parser.add_argument("--out", help="Output JSON path (defaults to <input_dir>/s06.json)")
    parser.add_argument("--debug", action="store_true", help="Emit CSV debug artifacts")
    parser.add_argument("--log-level", default="INFO", help="Logging level (default: INFO)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO), format="%(levelname)s: %(message)s")

    input_path = Path(args.input)
    if not input_path.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")

    if args.out:
        out_path = Path(args.out)
    else:
        out_path = input_path.with_name("s06.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    debug_dir = out_path.parent / f"{out_path.stem}_debug" if args.debug else None

    mode = detect_input_type(input_path)
    if mode == "pdf":
        tokens, page_dims, doc_id = load_tokens_from_pdf(input_path)
    else:
        tokens, page_dims, doc_id = load_tokens_from_s02(input_path)

    extractor = SimonExtractor(tokens, page_dims, doc_id, debug_dir)
    result = extractor.extract()

    with out_path.open("w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, ensure_ascii=False)
    LOGGER.info("Wrote %s", out_path)


if __name__ == "__main__":
    main()
