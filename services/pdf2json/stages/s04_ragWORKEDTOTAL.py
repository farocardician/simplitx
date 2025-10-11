"""Multi-region RAG pipeline for invoice metadata extraction.

This module rebuilds reading-order lines from S02 tokens, filters regions
(header, total, etc.) based on S03, indexes them into Postgres/pgvector, and performs
hybrid retrieval (dense + keyword) with optional reranking via Ollama.
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
import math
import os
import re
import sys
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, List, Optional, Pattern, Sequence, Tuple, TypedDict

import psycopg2
from psycopg2.extras import Json
import requests


logger = logging.getLogger(__name__)


class Token(TypedDict):
    """Typed representation of a single OCR token."""

    text: str
    bbox: Tuple[float, float, float, float]
    page: int


@dataclass
class Line:
    """Text line reconstructed from tokens."""

    line_no: int
    text: str
    bbox: Tuple[float, float, float, float]
    tokens: List[Token]


DEFAULT_RAG_CONFIG: Dict[str, object] = {
    "query_synonyms": {
        "buyer_name": [
            "buyer name",
            "bill to",
            "ship to",
            "sold to",
            "to :",
            "attn",
        ],
        "invoice_number": [
            "invoice no",
            "invoice number",
            "inv no",
            "no. faktur",
        ],
        "invoice_date": [
            "invoice date",
            "date :",
            "tanggal invoice",
            "issued on",
        ],
    },
    "fields": {
        "buyer_name": {
            "label_regex": r"\\b(buyer\\s*name|bill\\s*to|ship\\s*to|sold\\s*to|to|attn)\\b[:\\-]*",
            "candidate_regex": r"(?:buyer\\s*name|bill\\s*to|ship\\s*to|sold\\s*to|to|attn)[^A-Za-z0-9]*([A-Za-z0-9 .,\\-/&]+)",
            "trailing_label_regex": r"(?:\\b(buyer\\s*name|bill\\s*to|ship\\s*to|sold\\s*to|to|attn)\\b[:\\-]?\\s*)+$",
            "require_digit": False,
        },
        "invoice_number": {
            "label_regex": r"\\b(invoice\\s*(?:no|number)|inv\\s*no|no\\.\\s*faktur)\\b[:\\-]*",
            "candidate_regex": r"(?:invoice\\s*(?:no\\.?|number)|inv\\s*no|no\\.\\s*faktur)[^A-Za-z0-9]*((?=[A-Za-z0-9/\\-\\.]*\\d)[A-Za-z0-9/\\-\\.]+)",
            "fallback_regex": r"((?=[A-Za-z0-9/\\-\\.]*\\d)[A-Za-z0-9/\\-\\.]+)",
            "require_digit": True,
        },
        "invoice_date": {
            "label_regex": r"\\b(invoice\\s*date|date|tanggal\\s*invoice|issued\\s*on)\\b[:\\-]*",
            "candidate_regex": r"(?:invoice\\s*date|date|tanggal\\s*invoice|issued\\s*on)[^0-9A-Za-z]*([0-9]{1,2}\\s+[A-Za-z]+\\s+[0-9]{4})",
            "fallback_regex": r"([0-9]{1,2}\\s+[A-Za-z]+\\s+[0-9]{4})",
            "require_digit": False,
        },
    },
}

DEFAULT_CONFIG_PATH = "services/pdf2json/config/s04_invoice_esi_rag_v2.json"
CONFIG_MAP: Dict[str, str] = {
    "esi": DEFAULT_CONFIG_PATH,
    "kass": "services/pdf2json/config/s04_invoice_kass_rag_v1.json",
}


@dataclass
class FieldConfig:
    name: str
    label_regex: Optional[Pattern[str]] = None
    candidate_regex: Optional[Pattern[str]] = None
    trailing_label_regex: Optional[Pattern[str]] = None
    fallback_regex: Optional[Pattern[str]] = None
    require_digit: bool = False
    stop_regex: Optional[Pattern[str]] = None
    prefer_fallback: bool = False
    normalizer: Optional[str] = None  # e.g., "currency", "percent", "date"


@dataclass
class RegionConfig:
    name: str
    query_synonyms: Dict[str, Sequence[str]]
    fields: Dict[str, FieldConfig]
    table_name: str  # e.g., "rag_header_lines", "rag_total_lines"


@dataclass
class RagConfig:
    regions: Dict[str, RegionConfig]  # e.g., {"header": ..., "total": ...}

    # Backward compatibility: if only one region, expose it directly
    @property
    def query_synonyms(self) -> Dict[str, Sequence[str]]:
        if "header" in self.regions:
            return self.regions["header"].query_synonyms
        return {}

    @property
    def fields(self) -> Dict[str, FieldConfig]:
        if "header" in self.regions:
            return self.regions["header"].fields
        return {}



def load_json(path: str) -> dict:
    """Load JSON from a path with helpful error messages."""

    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise RuntimeError(f"JSON input not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Failed to parse JSON at {path}: {exc}") from exc


def _compile_pattern(pattern: Optional[str]) -> Optional[Pattern[str]]:
    if not pattern:
        return None
    return re.compile(pattern, re.IGNORECASE)


def _deep_merge_dict(base: Dict[str, object], override: Dict[str, object]) -> Dict[str, object]:
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            base[key] = _deep_merge_dict(base[key], value)  # type: ignore[index]
        else:
            base[key] = value
    return base


def _build_field_config(field_name: str, field_data: dict) -> FieldConfig:
    """Build a FieldConfig from raw dict data."""
    return FieldConfig(
        name=field_name,
        label_regex=_compile_pattern(field_data.get("label_regex")),
        candidate_regex=_compile_pattern(field_data.get("candidate_regex")),
        trailing_label_regex=_compile_pattern(field_data.get("trailing_label_regex")),
        fallback_regex=_compile_pattern(field_data.get("fallback_regex")),
        require_digit=bool(field_data.get("require_digit", False)),
        stop_regex=_compile_pattern(field_data.get("stop_regex")),
        prefer_fallback=bool(field_data.get("prefer_fallback", False)),
        normalizer=field_data.get("normalizer"),
    )


def _parse_region_data(region_name: str, region_data: dict, table_prefix: str = "rag") -> RegionConfig:
    """Parse a region configuration from dict."""
    query_synonyms_raw = region_data.get("query_synonyms") or {}
    if not isinstance(query_synonyms_raw, dict):
        raise RuntimeError(f"Region '{region_name}' query_synonyms must be an object.")

    fields_raw = region_data.get("fields") or {}
    if not isinstance(fields_raw, dict):
        raise RuntimeError(f"Region '{region_name}' fields must be an object.")

    # Build fields
    fields: Dict[str, FieldConfig] = {}
    for field_name, field_data in fields_raw.items():
        if not isinstance(field_data, dict):
            continue
        fields[field_name] = _build_field_config(field_name, field_data)

    # Ensure all fields mentioned in synonyms have configs
    for field_name in query_synonyms_raw.keys():
        if field_name not in fields:
            fields[field_name] = FieldConfig(name=field_name)

    # Normalize query synonyms
    normalized_synonyms: Dict[str, Sequence[str]] = {}
    for field_name, synonyms in query_synonyms_raw.items():
        if isinstance(synonyms, (list, tuple)):
            normalized_synonyms[field_name] = [str(term) for term in synonyms]
        elif isinstance(synonyms, str):
            normalized_synonyms[field_name] = [synonyms]
        else:
            continue

    table_name = region_data.get("table_name", f"{table_prefix}_{region_name}_lines")

    return RegionConfig(
        name=region_name,
        query_synonyms=normalized_synonyms,
        fields=fields,
        table_name=table_name,
    )


def load_rag_config(path: Optional[str]) -> RagConfig:
    """Load RAG config supporting both old (header-only) and new (multi-region) formats."""
    data = copy.deepcopy(DEFAULT_RAG_CONFIG)
    if path:
        override = load_json(path)
        if not isinstance(override, dict):
            raise RuntimeError("RAG config must be a JSON object.")
        data = _deep_merge_dict(data, override)

    regions: Dict[str, RegionConfig] = {}

    # Check if new multi-region format
    if "regions" in data:
        regions_raw = data["regions"]
        if not isinstance(regions_raw, dict):
            raise RuntimeError("RAG config 'regions' must be an object mapping region names.")
        for region_name, region_data in regions_raw.items():
            if not isinstance(region_data, dict):
                continue
            regions[region_name] = _parse_region_data(region_name, region_data)
    else:
        # Old format: treat as header-only for backward compatibility
        regions["header"] = _parse_region_data("header", data, table_prefix="rag")

    if not regions:
        raise RuntimeError("RAG config must define at least one region.")

    return RagConfig(regions=regions)


def _first_not_none(payload: dict, keys: Sequence[str]):
    for key in keys:
        if key in payload and payload[key] is not None:
            return payload[key]
    return None


def _normalize_bbox(value) -> Optional[Tuple[float, float, float, float]]:
    if value is None:
        return None
    if isinstance(value, dict):
        x0 = _first_not_none(value, ("x0", "left", "xmin"))
        y0 = _first_not_none(value, ("y0", "top", "ymin"))
        x1 = _first_not_none(value, ("x1", "right", "xmax"))
        y1 = _first_not_none(value, ("y1", "bottom", "ymax"))
        coords = (x0, y0, x1, y1)
    elif isinstance(value, (list, tuple)) and len(value) >= 4:
        coords = value[:4]
    else:
        return None
    try:
        x0_f, y0_f, x1_f, y1_f = (float(c) for c in coords)
    except (TypeError, ValueError):
        return None
    if x0_f > x1_f:
        x0_f, x1_f = x1_f, x0_f
    if y0_f > y1_f:
        y0_f, y1_f = y1_f, y0_f
    return (x0_f, y0_f, x1_f, y1_f)


def _coerce_page(value, default: Optional[int] = None) -> Optional[int]:
    if value is None:
        return default
    if isinstance(value, bool):
        return default
    try:
        page = int(value)
    except (TypeError, ValueError):
        return default
    if page <= 0:
        return 1
    return page


def find_region_bbox(s03: dict, region_name: str, page: int = 1) -> Optional[Tuple[float, float, float, float]]:
    """Locate and merge bounding boxes for a named region on the requested page.

    Returns None if the region is not found (allowing graceful handling).
    """
    region_boxes: List[Tuple[float, float, float, float]] = []

    def inspect_region(region: dict) -> None:
        if not isinstance(region, dict):
            return
        region_id = region.get("id") or region.get("label") or region.get("name")
        if not region_id or str(region_id).lower() != region_name.lower():
            return
        region_page = _coerce_page(
            region.get("page")
            or region.get("page_number")
            or region.get("pageIndex")
            or region.get("page_index")
        )
        if region_page != page:
            return
        bbox = _normalize_bbox(
            region.get("bbox")
            or region.get("bounds")
            or region.get("bounding_box")
            or region.get("rect")
        )
        if bbox:
            region_boxes.append(bbox)

    def walk(node) -> None:
        if isinstance(node, dict):
            if {"id", "bbox"}.issubset(node.keys()):
                inspect_region(node)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(s03)

    if not region_boxes:
        return None

    x0 = min(box[0] for box in region_boxes)
    y0 = min(box[1] for box in region_boxes)
    x1 = max(box[2] for box in region_boxes)
    y1 = max(box[3] for box in region_boxes)
    return (x0, y0, x1, y1)


def find_header_bbox(s03: dict, page: int = 1) -> Tuple[float, float, float, float]:
    """Locate and merge header bounding boxes on the requested page.

    Raises RuntimeError if header not found (for backward compatibility).
    """
    bbox = find_region_bbox(s03, "header", page)
    if bbox is None:
        raise RuntimeError(
            "Header bbox for page 1 not found in S03; ensure 'header' region exists."
        )
    return bbox


def _quantize_bbox(bbox: Tuple[float, float, float, float], precision: int = 6) -> Tuple[float, float, float, float]:
    return tuple(round(coord, precision) for coord in bbox)


def extract_tokens_page1(s02: dict) -> List[Token]:
    """Extract normalized tokens belonging to page 1."""

    tokens: List[Token] = []
    seen: set = set()

    def add_tokens(raw_tokens, page_hint: Optional[int]) -> None:
        if not isinstance(raw_tokens, list):
            return
        for raw in raw_tokens:
            if not isinstance(raw, dict):
                continue
            text = raw.get("text") or raw.get("value") or raw.get("content")
            if text is None:
                continue
            text_str = str(text).strip()
            if not text_str:
                continue
            bbox = _normalize_bbox(
                raw.get("bbox")
                or raw.get("bounding_box")
                or raw.get("bounds")
                or raw.get("rect")
            )
            if not bbox:
                continue
            raw_page = (
                raw.get("page")
                or raw.get("page_number")
                or raw.get("pageIndex")
                or raw.get("page_index")
            )
            page_val = _coerce_page(raw_page, page_hint)
            if page_val is None:
                page_val = 1
            if page_val != 1:
                continue
            bbox_tuple = _quantize_bbox(tuple(float(coord) for coord in bbox))
            key = (text_str, bbox_tuple, int(page_val))
            if key in seen:
                continue
            seen.add(key)
            token_data: Token = {
                "text": text_str,
                "bbox": bbox_tuple,
                "page": page_val,
            }
            tokens.append(token_data)

    if isinstance(s02, dict):
        pages = s02.get("pages") or s02.get("page")
        if isinstance(pages, list):
            for idx, page_entry in enumerate(pages):
                page_hint = 1
                if isinstance(page_entry, dict):
                    page_hint = _coerce_page(
                        page_entry.get("page")
                        or page_entry.get("page_number")
                        or page_entry.get("index")
                        or page_entry.get("pageIndex"),
                        default=idx + 1,
                    ) or 1
                    add_tokens(page_entry.get("tokens") or page_entry.get("items"), page_hint)
        add_tokens(s02.get("tokens"), None)
        structured = (
            s02.get("plumber"),
            s02.get("pymupdf"),
            s02.get("ocr"),
        )
        for container in structured:
            if isinstance(container, dict):
                add_tokens(container.get("tokens"), None)
                add_tokens(container.get("words"), None)
                pages_like = container.get("pages")
                if isinstance(pages_like, list):
                    for idx, page_entry in enumerate(pages_like):
                        if isinstance(page_entry, dict):
                            page_hint = _coerce_page(
                                page_entry.get("page")
                                or page_entry.get("page_number")
                                or page_entry.get("index")
                                or page_entry.get("pageIndex"),
                                default=idx + 1,
                            ) or 1
                            add_tokens(
                                page_entry.get("tokens")
                                or page_entry.get("words")
                                or page_entry.get("items"),
                                page_hint,
                            )
    elif isinstance(s02, list):
        add_tokens(s02, None)

    if not tokens:
        raise RuntimeError("No tokens found for page 1 in S02 input.")

    return tokens


def rebuild_lines(tokens: List[Token], row_tol: float = 0.003) -> List[Line]:
    """Group tokens into reading-order lines using a vertical tolerance."""

    if not tokens:
        return []

    enumerated = list(enumerate(tokens))
    enumerated.sort(key=lambda item: ((item[1]["bbox"][1] + item[1]["bbox"][3]) / 2.0, item[1]["bbox"][0], item[0]))

    lines: List[Line] = []
    current_tokens: List[Token] = []
    current_line_start_y: Optional[float] = None
    line_no = 1

    def finalize_line(buffer: List[Token], number: int) -> None:
        if not buffer:
            return
        text = _join_tokens(buffer)
        bbox = _merge_bboxes([token["bbox"] for token in buffer])
        lines.append(Line(line_no=number, text=text, bbox=bbox, tokens=list(buffer)))

    for _, token in enumerated:
        bbox = token["bbox"]
        y_center = (bbox[1] + bbox[3]) / 2.0
        if current_tokens:
            assert current_line_start_y is not None
            if abs(y_center - current_line_start_y) > row_tol:
                finalize_line(current_tokens, line_no)
                line_no += 1
                current_tokens = []
                current_line_start_y = y_center
        if not current_tokens:
            current_line_start_y = y_center
        current_tokens.append(token)

    finalize_line(current_tokens, line_no)
    return lines


def _join_tokens(tokens: Sequence[Token]) -> str:
    pieces: List[str] = []
    previous = ""
    for token in tokens:
        text = token["text"].strip()
        if not text:
            continue
        if pieces:
            if _needs_space(previous, text):
                pieces.append(" ")
        pieces.append(text)
        previous = text
    return "".join(pieces).strip()


_NO_SPACE_BEFORE = set(":,.;)")
_NO_SPACE_AFTER = set("(")


def _needs_space(left: str, right: str) -> bool:
    if not left:
        return False
    if left[-1] in _NO_SPACE_AFTER:
        return False
    if right and right[0] in _NO_SPACE_BEFORE:
        return False
    return True


def _merge_bboxes(boxes: Iterable[Tuple[float, float, float, float]]) -> Tuple[float, float, float, float]:
    boxes = list(boxes)
    if not boxes:
        return (0.0, 0.0, 0.0, 0.0)
    x0 = min(box[0] for box in boxes)
    y0 = min(box[1] for box in boxes)
    x1 = max(box[2] for box in boxes)
    y1 = max(box[3] for box in boxes)
    return (x0, y0, x1, y1)


def intersects(b1: Tuple[float, float, float, float], b2: Tuple[float, float, float, float]) -> bool:
    return not (b1[2] <= b2[0] or b1[0] >= b2[2] or b1[3] <= b2[1] or b1[1] >= b2[3])


def filter_lines_in_bbox(lines: Sequence[Line], header_bbox: Tuple[float, float, float, float]) -> List[Line]:
    return [line for line in lines if intersects(line.bbox, header_bbox)]


def pg_connect_from_env():
    """Create a psycopg2 connection using standard environment variables."""

    params = {
        "host": os.getenv("PGHOST", "localhost"),
        "port": int(os.getenv("PGPORT", "5432")),
        "dbname": os.getenv("PGDATABASE", "postgres"),
        "user": os.getenv("PGUSER"),
        "password": os.getenv("PGPASSWORD"),
    }
    try:
        conn = psycopg2.connect(**params)
    except psycopg2.Error as exc:
        raise RuntimeError(f"Failed to connect to Postgres: {exc}") from exc
    conn.autocommit = False
    return conn


def ensure_schema(conn, embed_dim: int, table_name: str = "rag_header_lines") -> None:
    """Ensure pgvector extension and the specified region table exist."""

    with conn.cursor() as cur:
        try:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
        except psycopg2.Error as exc:
            if getattr(exc, "pgcode", "") in {"58P01", "0A000"}:
                raise RuntimeError(
                    "Postgres extension 'vector' (pgvector) is not installed. "
                    "Install pgvector on the server before running s04_rag."
                ) from exc
            raise
        cur.execute(
            """
            SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = %s
            )
            """,
            (table_name,),
        )
        exists = cur.fetchone()[0]
        if exists:
            cur.execute(
                """
                SELECT atttypmod
                FROM pg_attribute
                WHERE attrelid = %s::regclass AND attname = 'embedding'
                """,
                (table_name,),
            )
            row = cur.fetchone()
            if row and row[0] not in (None, -1):
                raw_dim = int(row[0])
                if raw_dim >= embed_dim and raw_dim - embed_dim == 4:
                    current_dim = raw_dim - 4
                else:
                    current_dim = raw_dim
                if current_dim != embed_dim:
                    raise RuntimeError(
                        f"Existing {table_name}.embedding dimension"
                        f" ({current_dim}) does not match EMBED_DIM ({embed_dim})."
                        " Drop or recreate the table with the desired dimension."
                    )
        else:
            cur.execute(
                f"""
                CREATE TABLE {table_name} (
                  id BIGSERIAL PRIMARY KEY,
                  doc_id TEXT NOT NULL,
                  page INT NOT NULL,
                  line_no INT NOT NULL,
                  text TEXT NOT NULL,
                  bbox JSONB NOT NULL,
                  tokens JSONB NOT NULL,
                  ts tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED,
                  embedding vector({embed_dim}) NOT NULL
                )
                """
            )
        cur.execute(
            f"CREATE INDEX IF NOT EXISTS {table_name}_doc_page_idx ON {table_name}(doc_id, page)"
        )
        cur.execute(
            f"CREATE INDEX IF NOT EXISTS {table_name}_ts_idx ON {table_name} USING GIN(ts)"
        )
        cur.execute(
            f"""
            CREATE INDEX IF NOT EXISTS {table_name}_vec_idx
            ON {table_name} USING ivfflat (embedding vector_cosine_ops)
            """
        )
    conn.commit()


def embed_text_ollama(text: str) -> List[float]:
    """Request a dense embedding from Ollama."""

    base_url = os.getenv("OLLAMA_BASE_URL", "http://192.168.86.123:11434")
    model = os.getenv("EMBED_MODEL", "bge-m3")
    embed_dim = int(os.getenv("EMBED_DIM", "1024"))
    try:
        response = requests.post(
            f"{base_url.rstrip('/')}/api/embeddings",
            json={"model": model, "prompt": text},
            timeout=(10, 60),
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"Embedding request failed: {exc}") from exc
    if response.status_code != 200:
        raise RuntimeError(
            f"Embedding request failed with status {response.status_code}: {response.text.strip()}"
        )
    payload = response.json()
    embedding = payload.get("embedding")
    if not isinstance(embedding, list):
        raise RuntimeError("Embedding response missing 'embedding' list.")
    if len(embedding) != embed_dim:
        raise RuntimeError(
            f"Embedding dimension mismatch: expected {embed_dim}, received {len(embedding)}."
        )
    return [float(value) for value in embedding]


def _vector_literal(vec: Sequence[float]) -> str:
    return "[" + ",".join(f"{float(v):.12g}" for v in vec) + "]"


def _line_to_payload(line: Line) -> Tuple[List[float], List[Dict[str, object]]]:
    bbox_list = [float(coord) for coord in line.bbox]
    tokens_payload: List[Dict[str, object]] = []
    for token in line.tokens:
        tokens_payload.append(
            {
                "text": token["text"],
                "bbox": [float(coord) for coord in token["bbox"]],
                "page": int(token["page"]),
            }
        )
    return bbox_list, tokens_payload


def upsert_lines(
    conn,
    doc_id: str,
    page: int,
    lines: Sequence[Line],
    embed: Callable[[str], Sequence[float]],
    table_name: str = "rag_header_lines",
) -> int:
    """Insert region lines with embeddings inside a single transaction."""

    inserted = 0
    with conn.cursor() as cur:
        for line in lines:
            if not line.text:
                continue
            embedding = embed(line.text)
            bbox_json, tokens_json = _line_to_payload(line)
            cur.execute(
                f"""
                INSERT INTO {table_name} (doc_id, page, line_no, text, bbox, tokens, embedding)
                VALUES (%s, %s, %s, %s, %s, %s, %s::vector)
                """,
                (
                    doc_id,
                    page,
                    line.line_no,
                    line.text,
                    Json(bbox_json),
                    Json(tokens_json),
                    _vector_literal(embedding),
                ),
            )
            inserted += 1
    conn.commit()
    return inserted


def dense_candidates(
    conn,
    doc_id: str,
    page: int,
    qvec: Sequence[float],
    topk: int,
    table_name: str = "rag_header_lines",
) -> List[Dict[str, object]]:
    vec_literal = _vector_literal(qvec)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT id, line_no, text, embedding <-> %s::vector AS distance
            FROM {table_name}
            WHERE doc_id = %s AND page = %s
            ORDER BY embedding <-> %s::vector
            LIMIT %s
            """,
            (vec_literal, doc_id, page, vec_literal, topk),
        )
        rows = cur.fetchall()
    results: List[Dict[str, object]] = []
    for row_id, line_no, text, distance in rows:
        dist_value = float(distance)
        dense_score = max(0.0, 1.0 - dist_value)
        results.append(
            {
                "id": int(row_id),
                "line_no": int(line_no),
                "text": text or "",
                "distance": dist_value,
                "dense_score": dense_score,
            }
        )
    return results


def keyword_scores(
    conn,
    doc_id: str,
    page: int,
    query_text: str,
    candidate_ids: Sequence[int],
    table_name: str = "rag_header_lines",
) -> Dict[int, float]:
    if not candidate_ids:
        return {}
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT id, ts_rank(ts, websearch_to_tsquery('simple', %s))
            FROM {table_name}
            WHERE doc_id = %s AND page = %s AND id = ANY(%s)
            """,
            (query_text, doc_id, page, list(candidate_ids)),
        )
        rows = cur.fetchall()
    return {int(row_id): float(score) for row_id, score in rows}


def normalize_scores(values: Dict[int, float]) -> Dict[int, float]:
    if not values:
        return {}
    scores = list(values.values())
    max_score = max(scores)
    min_score = min(scores)
    if math.isclose(max_score, min_score):
        return {key: 1.0 for key in values}
    scale = max_score - min_score
    return {key: (value - min_score) / scale for key, value in values.items()}


def hybrid_rank(
    dense: Dict[int, float],
    keyword: Dict[int, float],
    alpha: float,
) -> List[int]:
    all_ids = set(dense) | set(keyword)
    if not all_ids:
        return []
    alpha_clamped = min(max(alpha, 0.0), 1.0)
    combined_scores = {
        candidate_id: alpha_clamped * dense.get(candidate_id, 0.0)
        + (1.0 - alpha_clamped) * keyword.get(candidate_id, 0.0)
        for candidate_id in all_ids
    }
    return sorted(all_ids, key=lambda candidate_id: (-combined_scores[candidate_id], candidate_id))


_FLOAT_PATTERN = re.compile(r"-?\d+(?:\.\d+)?")
DATE_PATTERN = re.compile(r"(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})")
MONTH_NORMALIZATION = {
    "jan": "Jan",
    "january": "January",
    "feb": "Feb",
    "february": "February",
    "mar": "Mar",
    "march": "March",
    "apr": "Apr",
    "april": "April",
    "may": "May",
    "jun": "Jun",
    "june": "June",
    "jul": "Jul",
    "july": "July",
    "aug": "Aug",
    "august": "August",
    "sep": "Sep",
    "sept": "Sep",
    "september": "September",
    "oct": "Oct",
    "october": "October",
    "nov": "Nov",
    "november": "November",
    "dec": "Dec",
    "december": "December",
}


def _fetch_line_text(
    conn,
    doc_id: str,
    page: int,
    line_no: int,
    cache: Dict[int, str],
    table_name: str = "rag_header_lines",
) -> Optional[str]:
    if line_no in cache:
        return cache[line_no]
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT text FROM {table_name} WHERE doc_id = %s AND page = %s AND line_no = %s",
            (doc_id, page, line_no),
        )
        row = cur.fetchone()
    if row and row[0]:
        cache[line_no] = row[0]
        return row[0]
    return None


def rerank_service(
    query: str,
    candidates: Sequence[Tuple[int, str]],
    model: Optional[str],
    k: int,
) -> Optional[int]:
    """Call the dedicated reranker microservice if configured."""

    if not candidates or not model:
        return None

    base_url = os.getenv("RERANKER_BASE_URL") or os.getenv("FLAG_RERANKER_BASE_URL") or "http://localhost:9000"
    if not base_url:
        return None

    payload = {
        "query": query,
        "model": model,
        "top_k": k,
        "normalize_scores": True,
        "candidates": [{"id": cid, "text": text} for cid, text in candidates],
    }

    try:
        response = requests.post(
            f"{base_url.rstrip('/')}/rerank",
            json=payload,
            timeout=(10, 60),
        )
    except requests.RequestException as exc:
        logger.warning("Reranker service request failed: %s", exc)
        return None

    if response.status_code == 404:
        logger.warning("Reranker service not available at %s", base_url)
        return None
    if response.status_code != 200:
        logger.debug("Reranker service response %s: %s", response.status_code, response.text)
        return None

    try:
        payload_json = response.json()
    except ValueError as exc:
        logger.debug("Failed to decode reranker response: %s", exc)
        return None

    best = payload_json.get("best")
    if not isinstance(best, dict):
        return None

    best_id = best.get("id")
    if isinstance(best_id, int):
        return best_id
    if isinstance(best_id, str):
        try:
            return int(best_id)
        except ValueError:
            logger.debug("Unable to cast reranker id '%s' to int", best_id)
            return None
    return None


def rerank_ollama(
    query: str,
    candidates: Sequence[Tuple[int, str]],
    model: Optional[str],
    k: int,
) -> Optional[int]:
    if not candidates or not model:
        return None
    base_url = os.getenv("OLLAMA_BASE_URL", "http://192.168.86.123:11434")
    best_id: Optional[int] = None
    best_score = -1.0
    for line_id, candidate_text in list(candidates)[: max(k, 0) or 0]:
        prompt = (
            "You are a relevance scorer. Return ONLY a numeric score in [0,1].\n"
            f"Query: {query}\n"
            f"Candidate line: {candidate_text}\n"
            "Score:"
        )
        try:
            response = requests.post(
                f"{base_url.rstrip('/')}/api/generate",
                json={
                    "model": model,
                    "system": "You output only a single numeric relevance score.",
                    "prompt": prompt,
                    "stream": False,
                },
                timeout=(10, 60),
            )
        except requests.RequestException as exc:
            logger.warning("Reranker request failed: %s", exc)
            return None
        if response.status_code == 404:
            logger.warning("Reranker model '%s' not available on Ollama.", model)
            return None
        if response.status_code != 200:
            logger.debug("Reranker response %s: %s", response.status_code, response.text)
            continue
        payload = response.json()
        score_text = str(payload.get("response", "")).strip()
        match = _FLOAT_PATTERN.search(score_text)
        if not match:
            logger.debug("Unable to parse reranker score from: %s", score_text)
            continue
        score = float(match.group())
        score = min(max(score, 0.0), 1.0)
        if score > best_score:
            best_score = score
            best_id = line_id
    return best_id


def _remove_duplicate_phrase(text: str) -> str:
    words = text.split()
    if not words:
        return text
    half = len(words) // 2
    if len(words) % 2 == 0 and words[:half] == words[half:]:
        return " ".join(words[:half])
    return text


def _normalize_date_value(field: str, text: str) -> str:
    if field != "invoice_date" or not text:
        return text
    match = DATE_PATTERN.search(text)
    if not match:
        return text
    day = int(match.group(1))
    month_raw = match.group(2)
    year = match.group(3)
    month_norm = MONTH_NORMALIZATION.get(month_raw.lower(), month_raw.title())
    if len(month_norm) <= 3:
        month_norm = month_norm.title()
    else:
        month_norm = month_norm[0].upper() + month_norm[1:]
    return f"{day:02d} {month_norm} {year}"


def _normalize_currency(text: str) -> str:
    """Normalize currency values.

    Supports formats:
    - Rp 7,000,000.00 (English style: comma grouping, dot decimal)
    - Rp 7.000.000,00 (Indonesian style: dot grouping, comma decimal)
    - 7000000.00 (plain number)

    Returns a normalized string like "7000000.00"
    """
    if not text:
        return ""

    # Remove currency symbols and extra spaces
    cleaned = re.sub(r"(?i)\b(rp|idr|usd|sgd|myr|[$€£¥])\b", "", text)
    cleaned = cleaned.strip()

    # Detect format by looking at last occurrence of . or ,
    dot_pos = cleaned.rfind(".")
    comma_pos = cleaned.rfind(",")

    if dot_pos > comma_pos:
        # English format: 7,000,000.00
        cleaned = cleaned.replace(",", "")
    elif comma_pos > dot_pos:
        # Indonesian format: 7.000.000,00
        cleaned = cleaned.replace(".", "")
        cleaned = cleaned.replace(",", ".")
    else:
        # No separators, just digits
        pass

    # Extract the numeric value
    match = re.search(r"-?\d+(?:\.\d+)?", cleaned)
    if not match:
        return ""

    return match.group(0)


def _normalize_percent(text: str) -> str:
    """Normalize percentage values.

    Supports formats:
    - 11%
    - 11 %
    - 11,00%
    - 11.00%

    Returns a normalized string like "11.00" (without % symbol)
    """
    if not text:
        return ""

    # Remove percent symbol and extra spaces
    cleaned = text.replace("%", "").strip()

    # Replace comma with dot for decimals
    cleaned = cleaned.replace(",", ".")

    # Extract the numeric value
    match = re.search(r"-?\d+(?:\.\d+)?", cleaned)
    if not match:
        return ""

    return match.group(0)


def _apply_normalizer(text: str, normalizer: Optional[str]) -> str:
    """Apply a specific normalizer to a text value."""
    if not normalizer or not text:
        return text

    normalizer_lower = normalizer.lower()
    if normalizer_lower == "currency":
        return _normalize_currency(text)
    elif normalizer_lower == "percent":
        return _normalize_percent(text)
    elif normalizer_lower == "date":
        return text  # Date normalization is handled separately in _normalize_date_value
    else:
        logger.warning("Unknown normalizer: %s", normalizer)
        return text


def _normalize_answer(field: str, text: str, field_cfg: FieldConfig) -> str:
    if not text:
        return ""
    raw = text
    candidate: Optional[str] = None

    if field_cfg.candidate_regex:
        match = field_cfg.candidate_regex.search(raw)
        if match:
            candidate = match.group(1)

    cleaned = raw.replace("\n", " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if field_cfg.label_regex:
        cleaned = field_cfg.label_regex.sub(" ", cleaned)
    cleaned = cleaned.strip()
    cleaned = re.sub(r"^[\s:;-]+", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = _remove_duplicate_phrase(cleaned)

    if field_cfg.trailing_label_regex:
        cleaned = field_cfg.trailing_label_regex.sub("", cleaned).strip()
    if field_cfg.require_digit and not any(ch.isdigit() for ch in cleaned):
        cleaned_fallback = None
        if field_cfg.fallback_regex:
            fallback_match = field_cfg.fallback_regex.search(raw)
            if fallback_match:
                cleaned_fallback = fallback_match.group(1)
        if cleaned_fallback:
            cleaned = cleaned_fallback

    if candidate:
        candidate = re.sub(r"\s+", " ", candidate).strip(" :;-")
        if field_cfg.label_regex:
            candidate = field_cfg.label_regex.sub(" ", candidate)
        candidate = _remove_duplicate_phrase(candidate)
        candidate = re.sub(r"\s+", " ", candidate)
        candidate = re.sub(r"^[\s:;-]+", "", candidate)
        if field_cfg.trailing_label_regex:
            candidate = field_cfg.trailing_label_regex.sub("", candidate).strip()
        if field_cfg.prefer_fallback and field_cfg.fallback_regex:
            fallback_match = field_cfg.fallback_regex.search(raw)
            if fallback_match:
                candidate = fallback_match.group(1)
        if field_cfg.require_digit and not any(ch.isdigit() for ch in candidate):
            if field_cfg.fallback_regex:
                fallback_match = field_cfg.fallback_regex.search(raw)
                if fallback_match:
                    candidate = fallback_match.group(1)
            if not any(ch.isdigit() for ch in candidate):
                candidate = cleaned
        if candidate:
            result = _normalize_date_value(field, candidate.strip())
            result = _apply_normalizer(result, field_cfg.normalizer)
            return result
    result = _normalize_date_value(field, cleaned.strip())
    result = _apply_normalizer(result, field_cfg.normalizer)
    return result


def run_queries(
    conn,
    doc_id: str,
    page: int,
    region_config: RegionConfig,
    echo: bool = False,
) -> Dict[str, str]:
    """Run RAG queries for all fields in a region configuration."""
    topk = int(os.getenv("TOPK", "10"))
    rerank_k = int(os.getenv("RERANK_K", "5"))
    alpha = float(os.getenv("HYBRID_ALPHA", "0.5"))
    rerank_model = os.getenv("RERANK_MODEL", "bge-reranker-v2-m3")

    table_name = region_config.table_name

    answers: Dict[str, str] = {}
    for field, synonyms in region_config.query_synonyms.items():
        line_cache: Dict[int, str] = {}
        answers[field] = ""
        query_text = " OR ".join(synonyms)
        try:
            qvec = embed_text_ollama(query_text)
        except RuntimeError as exc:
            logger.error("Embedding failed for query '%s': %s", field, exc)
            continue
        dense_rows = dense_candidates(conn, doc_id, page, qvec, topk, table_name)
        if echo:
            preview = [f"{row['id']}: {row['text']}" for row in dense_rows[: min(5, len(dense_rows))]]
            logger.info("Dense candidates for %s: %s", field, preview or "<none>")
        if not dense_rows:
            continue
        dense_raw = {row["id"]: row["dense_score"] for row in dense_rows}
        dense_norm = normalize_scores(dense_raw)
        keyword_raw = keyword_scores(conn, doc_id, page, query_text, list(dense_raw.keys()), table_name)
        keyword_norm = normalize_scores(keyword_raw)
        hybrid_ids = hybrid_rank(dense_norm, keyword_norm, alpha)
        if not hybrid_ids:
            answers[field] = ""
            continue
        combined_scores = {
            candidate_id: alpha * dense_norm.get(candidate_id, 0.0)
            + (1.0 - alpha) * keyword_norm.get(candidate_id, 0.0)
            for candidate_id in hybrid_ids
        }
        candidate_map = {row["id"]: row for row in dense_rows}
        if echo:
            ranked_preview: List[str] = []
            for candidate_id in hybrid_ids[: min(5, len(hybrid_ids))]:
                entry = candidate_map.get(candidate_id)
                text_preview = entry["text"] if entry else ""
                ranked_preview.append(
                    f"{candidate_id}:{combined_scores[candidate_id]:.3f}:{text_preview}"
                )
            logger.info("Hybrid ranking for %s: %s", field, ranked_preview or "<none>")
        rerank_input = [(cid, candidate_map[cid]["text"]) for cid in hybrid_ids if cid in candidate_map]
        best_id = rerank_service(query_text, rerank_input, rerank_model, rerank_k)
        if best_id is None:
            best_id = rerank_ollama(query_text, rerank_input, rerank_model, rerank_k)
        if best_id is None and rerank_input:
            best_id = rerank_input[0][0]

        candidate_order: List[int] = []
        if best_id is not None:
            candidate_order.append(best_id)
        for cid, _ in rerank_input:
            if cid not in candidate_order:
                candidate_order.append(cid)

        field_cfg = region_config.fields.get(field, FieldConfig(name=field))
        selected_text: Optional[str] = None
        for cid in candidate_order:
            entry = candidate_map.get(cid, {})
            line_no = entry.get("line_no")

            texts_to_try: List[str] = []
            raw_text = entry.get("text", "")
            if raw_text:
                texts_to_try.append(raw_text)
            if isinstance(line_no, int):
                for offset in (1, 2):
                    neighbor_text = _fetch_line_text(conn, doc_id, page, line_no + offset, line_cache, table_name)
                    if neighbor_text and neighbor_text not in texts_to_try:
                        texts_to_try.append(neighbor_text)

            for candidate_text in texts_to_try:
                # Check if this candidate should be rejected by stop_regex
                if field_cfg.stop_regex and field_cfg.stop_regex.search(candidate_text):
                    if echo:
                        logger.debug("Candidate rejected by stop_regex: %s", candidate_text[:60])
                    continue

                normalized = _normalize_answer(field, candidate_text, field_cfg)
                if normalized:
                    answers[field] = normalized
                    selected_text = candidate_text
                    break
            if selected_text is not None:
                break
        if echo and selected_text is not None:
            logger.info("Selected line for %s: %s", field, selected_text)
            logger.info("Normalized %s: %s", field, answers[field])
    return answers


def _setup_logging(echo: bool) -> None:
    level = logging.DEBUG if echo else logging.INFO
    logging.basicConfig(level=level, format="%(levelname)s: %(message)s")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Multi-region RAG pipeline")
    parser.add_argument("--s02", required=True, help="Path to S02 JSON tokens input")
    parser.add_argument("--s03", required=True, help="Path to S03 JSON segments input")
    parser.add_argument("--doc-id", required=True, help="Document identifier for persistence")
    parser.add_argument("--out", required=True, help="Output JSON path for results")
    parser.add_argument("--reindex", action="store_true", help="Reinsert region lines for doc/page")
    parser.add_argument(
        "--config",
        default="auto",
        help="Path to RAG configuration JSON (per client) or 'auto' to infer from doc-id",
    )
    parser.add_argument("--echo", action="store_true", help="Verbose logging of intermediate steps")

    args = parser.parse_args(argv)
    _setup_logging(args.echo)

    conn = None
    try:
        config_path = args.config
        if config_path.lower() == "auto":
            doc_prefix = str(args.doc_id).split("/", 1)[0].lower()
            config_path = CONFIG_MAP.get(doc_prefix, DEFAULT_CONFIG_PATH)
            if args.echo:
                logger.info(
                    "Auto-selected RAG config '%s' for doc prefix '%s'",
                    config_path,
                    doc_prefix,
                )
        rag_config = load_rag_config(config_path)
        if args.echo:
            logger.info("Loaded RAG config from %s", config_path)
            logger.info("Processing %d region(s): %s", len(rag_config.regions), list(rag_config.regions.keys()))

        s03 = load_json(args.s03)
        s02 = load_json(args.s02)
        tokens = extract_tokens_page1(s02)
        all_lines = rebuild_lines(tokens)

        conn = pg_connect_from_env()
        embed_dim = int(os.getenv("EMBED_DIM", "1024"))

        # Process each region
        all_answers: Dict[str, str] = {}
        for region_name, region_config in rag_config.regions.items():
            if args.echo:
                logger.info("Processing region: %s", region_name)

            # Find region bbox
            region_bbox = find_region_bbox(s03, region_name, page=1)
            if region_bbox is None:
                logger.warning("Region '%s' not found in S03; skipping and setting fields to null.", region_name)
                # Set all fields for this region to empty string (null in JSON)
                for field_name in region_config.query_synonyms.keys():
                    all_answers[field_name] = ""
                continue

            # Filter lines in this region
            region_lines = filter_lines_in_bbox(all_lines, region_bbox)
            if not region_lines:
                logger.warning("No lines detected within %s bbox; setting fields to null.", region_name)
                for field_name in region_config.query_synonyms.keys():
                    all_answers[field_name] = ""
                continue

            # Ensure schema for this region's table
            table_name = region_config.table_name
            ensure_schema(conn, embed_dim, table_name)

            # Check if we need to index
            existing_count = 0
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT COUNT(*) FROM {table_name} WHERE doc_id = %s AND page = %s",
                    (args.doc_id, 1),
                )
                existing_count = cur.fetchone()[0]

            if args.reindex and existing_count:
                with conn.cursor() as cur:
                    cur.execute(
                        f"DELETE FROM {table_name} WHERE doc_id = %s AND page = %s",
                        (args.doc_id, 1),
                    )
                conn.commit()
                existing_count = 0
                logger.info("Existing rows for doc %s page 1 in %s removed for reindex.", args.doc_id, table_name)

            if region_lines and (args.reindex or not existing_count):
                inserted = upsert_lines(conn, args.doc_id, 1, region_lines, embed_text_ollama, table_name)
                if args.echo:
                    logger.info("Inserted %s lines for region %s (doc %s page 1).", inserted, region_name, args.doc_id)
            elif args.echo:
                logger.info("Skipping indexing for %s; existing rows already present.", region_name)

            # Run queries for this region
            region_answers = run_queries(conn, args.doc_id, 1, region_config, echo=args.echo)
            all_answers.update(region_answers)

        # Write output
        out_dir = os.path.dirname(args.out)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(all_answers, handle, ensure_ascii=False, indent=2)

        if args.echo:
            logger.info("Final answers: %s", all_answers)

        return 0
    except Exception as exc:  # pylint: disable=broad-except
        logger.error("s04_rag failed: %s", exc)
        return 1
    finally:
        if conn is not None:
            try:
                conn.close()
            except psycopg2.Error as close_exc:
                logger.debug("Failed to close Postgres connection cleanly: %s", close_exc)


if __name__ == "__main__":
    sys.exit(main())
