#!/usr/bin/env python3
"""Invoice RAG pipeline (S04) runnable as a standalone CLI.

This script follows the requirements in `context/ragInvoice.md` and keeps the
entire retrieval process in memory. Acceptance expectations (documented in the
requirements) include:

* Default run with provided samples yields structured header/table/total output.
* Tokenizer filtering (`--tokenizer plumber`, `--tokenizer plumber,pymupdf`) is
  respected and merges sources when requested.
* `--page` filtering limits processing to selected pages.
* Reranker failures fall back to hybrid ordering without aborting the run.
* Validation flags expose line-total and grand-total discrepancies with notes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import re
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, MutableMapping, Optional, Sequence, Set, Tuple

# ---------------------------------------------------------------------------
# Type aliases and small utilities
# ---------------------------------------------------------------------------

BoundingBox = Tuple[float, float, float, float]
_WORD_RE = re.compile(r"\w+", re.UNICODE)


class RagError(RuntimeError):
    """Raised for fatal RAG pipeline errors (invalid config, missing data)."""


@dataclass
class Token:
    """Minimal token representation used for line reconstruction."""

    page: int
    text: str
    bbox: BoundingBox
    source: str


@dataclass
class Line:
    """Reading-order line reconstructed from tokens."""

    page: int
    line_no: int
    text: str
    bbox: BoundingBox
    tokens: List[Token]

    @property
    def y_center(self) -> float:
        return (self.bbox[1] + self.bbox[3]) / 2.0

    @property
    def x_center(self) -> float:
        return (self.bbox[0] + self.bbox[2]) / 2.0


@dataclass
class Candidate:
    """Candidate text unit used for scoring and reranking."""

    id: str
    text: str
    source_line: Line
    bbox: BoundingBox
    origin: str
    embedding: Optional[List[float]] = None
    lexical_terms: Optional[Set[str]] = None
    dense_score: Optional[float] = None
    lexical_score: Optional[float] = None
    hybrid_score: Optional[float] = None


# ---------------------------------------------------------------------------
# Configuration handling
# ---------------------------------------------------------------------------


def _load_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:  # pragma: no cover - defensive
        raise RagError(f"JSON file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RagError(f"Failed to parse JSON at {path}: {exc}") from exc


@dataclass
class EmbeddingConfig:
    provider: str
    model: str
    timeout_sec: float
    batch_size: Optional[int]


@dataclass
class RerankerConfig:
    base_url: str
    model: str
    timeout_sec: float


@dataclass
class RetrievalConfig:
    dense_topk: int
    rerank_topk: int
    hybrid_alpha: float


@dataclass
class DefaultsConfig:
    tokenizer: Optional[str]
    pages: Optional[Sequence[int]]


@dataclass
class LocaleConfig:
    decimal_separator: str
    thousand_separator: str


@dataclass
class BehaviorConfig:
    header_fields: List[str]
    header_query_synonyms: Dict[str, List[str]]
    header_normalize: Dict[str, Dict[str, Any]]
    table_columns: List[Dict[str, Any]]
    table_header_synonyms: Dict[str, List[str]]
    table_row_detection: Dict[str, Any]
    table_normalize: Dict[str, Dict[str, Any]]
    total_keys: List[str]
    total_query_synonyms: Dict[str, List[str]]
    total_normalize: Dict[str, Dict[str, Any]]
    validation: Dict[str, Any]


@dataclass
class PipelineConfig:
    embedding: EmbeddingConfig
    reranker: RerankerConfig
    retrieval: RetrievalConfig
    defaults: DefaultsConfig
    locale: LocaleConfig
    behavior: BehaviorConfig


REQUIRED_CONFIG_PATHS = {
    "embedding.provider",
    "embedding.model",
    "embedding.timeout_sec",
    "reranker.base_url",
    "reranker.model",
    "reranker.timeout_sec",
    "retrieval.dense_topk",
    "retrieval.rerank_topk",
    "locale.decimal_separator",
    "locale.thousand_separator",
    "header.fields",
    "header.query_synonyms",
    "header.normalize",
    "table.columns",
    "table.header_synonyms",
    "table.row_detection",
    "table.normalize",
    "total.keys",
    "total.query_synonyms",
    "total.normalize",
    "validation.tolerance.line_total",
    "validation.tolerance.grand_total",
    "validation.behavior_on_mismatch",
}


def _dig(config: MutableMapping[str, Any], dotted: str) -> Any:
    cursor: Any = config
    for part in dotted.split('.'):
        if not isinstance(cursor, MutableMapping) or part not in cursor:
            raise RagError(f"Config missing required key '{dotted}'")
        cursor = cursor[part]
    return cursor


def load_config(path: Path) -> PipelineConfig:
    raw_cfg = _load_json(path)
    if not isinstance(raw_cfg, MutableMapping):
        raise RagError("Config root must be a JSON object")

    for dotted_key in REQUIRED_CONFIG_PATHS:
        _dig(raw_cfg, dotted_key)

    embedding = EmbeddingConfig(
        provider=str(raw_cfg["embedding"]["provider"]),
        model=str(raw_cfg["embedding"]["model"]),
        timeout_sec=float(raw_cfg["embedding"].get("timeout_sec", 30)),
        batch_size=(
            int(raw_cfg["embedding"].get("batch_size"))
            if raw_cfg["embedding"].get("batch_size") is not None
            else None
        ),
    )

    reranker = RerankerConfig(
        base_url=str(raw_cfg["reranker"]["base_url"]).rstrip('/'),
        model=str(raw_cfg["reranker"]["model"]),
        timeout_sec=float(raw_cfg["reranker"].get("timeout_sec", 30)),
    )

    retrieval = RetrievalConfig(
        dense_topk=int(raw_cfg["retrieval"].get("dense_topk", 20)),
        rerank_topk=int(raw_cfg["retrieval"].get("rerank_topk", 5)),
        hybrid_alpha=float(raw_cfg["retrieval"].get("hybrid_alpha", 0.5)),
    )
    if not 0.0 <= retrieval.hybrid_alpha <= 1.0:
        raise RagError("retrieval.hybrid_alpha must be within [0,1]")

    defaults_cfg = raw_cfg.get("defaults", {}) or {}
    default_pages = defaults_cfg.get("pages")
    if isinstance(default_pages, str) and default_pages.lower() == "all":
        parsed_pages: Optional[Sequence[int]] = None
    elif isinstance(default_pages, Sequence) and not isinstance(default_pages, (str, bytes)):
        parsed_pages = [int(page) for page in default_pages]
    elif default_pages is None:
        parsed_pages = None
    else:
        raise RagError("defaults.pages must be 'all' or an array of ints")

    defaults = DefaultsConfig(
        tokenizer=(str(defaults_cfg["tokenizer"]) if "tokenizer" in defaults_cfg else None),
        pages=parsed_pages,
    )

    locale_cfg = raw_cfg["locale"]
    locale = LocaleConfig(
        decimal_separator=str(locale_cfg["decimal_separator"]),
        thousand_separator=str(locale_cfg["thousand_separator"]),
    )

    behavior = BehaviorConfig(
        header_fields=[str(x) for x in raw_cfg["header"]["fields"]],
        header_query_synonyms={
            key: [str(v) for v in value]
            for key, value in raw_cfg["header"]["query_synonyms"].items()
        },
        header_normalize={key: dict(value) for key, value in raw_cfg["header"]["normalize"].items()},
        table_columns=[dict(item) for item in raw_cfg["table"]["columns"]],
        table_header_synonyms={
            key: [str(v) for v in value]
            for key, value in raw_cfg["table"]["header_synonyms"].items()
        },
        table_row_detection=dict(raw_cfg["table"]["row_detection"]),
        table_normalize={key: dict(value) for key, value in raw_cfg["table"]["normalize"].items()},
        total_keys=[str(x) for x in raw_cfg["total"]["keys"]],
        total_query_synonyms={
            key: [str(v) for v in value]
            for key, value in raw_cfg["total"]["query_synonyms"].items()
        },
        total_normalize={key: dict(value) for key, value in raw_cfg["total"]["normalize"].items()},
        validation=dict(raw_cfg["validation"]),
    )

    return PipelineConfig(
        embedding=embedding,
        reranker=reranker,
        retrieval=retrieval,
        defaults=defaults,
        locale=locale,
        behavior=behavior,
    )


# ---------------------------------------------------------------------------
# Token + line processing
# ---------------------------------------------------------------------------


def _normalize_bbox(payload: Dict[str, Any], page_metrics: Dict[int, Tuple[float, float]]) -> BoundingBox:
    if "bbox" in payload and isinstance(payload["bbox"], Sequence):
        x0, y0, x1, y1 = payload["bbox"]
        return float(x0), float(y0), float(x1), float(y1)
    if "bbox" in payload and isinstance(payload["bbox"], MutableMapping):
        bbox = payload["bbox"]
        return float(bbox["x0"]), float(bbox["y0"]), float(bbox["x1"]), float(bbox["y1"])
    if "abs_bbox" in payload and isinstance(payload["abs_bbox"], MutableMapping):
        abs_bbox = payload["abs_bbox"]
        page = int(payload.get("page", 1))
        width, height = page_metrics.get(page, (abs_bbox.get("width"), abs_bbox.get("height")))
        if not width or not height:
            raise RagError("Cannot normalize abs_bbox without page width/height")
        x0 = float(abs_bbox["x0"]) / float(width)
        y0 = float(abs_bbox["y0"]) / float(height)
        x1 = float(abs_bbox["x1"]) / float(width)
        y1 = float(abs_bbox["y1"]) / float(height)
        return x0, y0, x1, y1
    raise RagError("Token payload missing bbox information")


def _collect_page_metrics(s02: Dict[str, Any]) -> Dict[int, Tuple[float, float]]:
    metrics: Dict[int, Tuple[float, float]] = {}
    pages = s02.get("pages") or []
    for entry in pages:
        if not isinstance(entry, MutableMapping):
            continue
        page_num = int(entry.get("page", len(metrics) + 1))
        width = float(entry.get("width", 0))
        height = float(entry.get("height", 0))
        if width and height:
            metrics[page_num] = (width, height)
    return metrics


def _extract_tokens_from_container(container: MutableMapping[str, Any], source: str, page_metrics: Dict[int, Tuple[float, float]]) -> List[Token]:
    tokens: List[Token] = []
    seen: Set[Tuple[int, float, float, float, float, str]] = set()

    def _append_token(raw: MutableMapping[str, Any]) -> None:
        if not isinstance(raw, MutableMapping):
            return
        text = str(raw.get("text") or raw.get("norm") or "").strip()
        if not text:
            return
        page = int(raw.get("page", 1))
        try:
            bbox = _normalize_bbox(raw, page_metrics)
        except RagError:
            return
        key = (
            page,
            round(bbox[0], 4),
            round(bbox[1], 4),
            round(bbox[2], 4),
            round(bbox[3], 4),
            text.lower(),
        )
        if key in seen:
            return
        seen.add(key)
        tokens.append(Token(page=page, text=text, bbox=bbox, source=source))

    if "tokens" in container and isinstance(container["tokens"], Sequence):
        for raw in container["tokens"]:
            _append_token(raw)
    if "words" in container and isinstance(container["words"], Sequence):
        for raw in container["words"]:
            _append_token(raw)
    if "pages" in container and isinstance(container["pages"], Sequence):
        for page_entry in container["pages"]:
            if not isinstance(page_entry, MutableMapping):
                continue
            if "tokens" in page_entry and isinstance(page_entry["tokens"], Sequence):
                for raw in page_entry["tokens"]:
                    raw = dict(raw)
                    raw.setdefault("page", page_entry.get("page"))
                    _append_token(raw)
            if "words" in page_entry and isinstance(page_entry["words"], Sequence):
                for raw in page_entry["words"]:
                    raw = dict(raw)
                    raw.setdefault("page", page_entry.get("page"))
                    _append_token(raw)
    return tokens


def _collect_tokens(s02: MutableMapping[str, Any], sources: Sequence[str]) -> Tuple[List[Token], List[str]]:
    page_metrics = _collect_page_metrics(s02)
    available_sources: Dict[str, MutableMapping[str, Any]] = {}
    for name in ("plumber", "pymupdf", "ocr"):
        if name in s02 and isinstance(s02[name], MutableMapping):
            available_sources[name] = s02[name]

    chosen_sources: List[str] = []
    aggregated: List[Token] = []

    for source in sources:
        if source == "all":
            selected = list(available_sources.keys())
        else:
            selected = [source]
        for item in selected:
            container = available_sources.get(item)
            if not container:
                logging.debug("Token source '%s' not available", item)
                continue
            extracted = _extract_tokens_from_container(container, item, page_metrics)
            if not extracted:
                logging.debug("Token source '%s' yielded no tokens", item)
                continue
            aggregated.extend(extracted)
            if item not in chosen_sources:
                chosen_sources.append(item)
    if not aggregated:
        available = ", ".join(sorted(available_sources.keys())) or "none"
        raise RagError(f"No usable token sources. Available sources: {available}")

    dedup: Dict[Tuple[int, float, float, str], Token] = {}
    for token in aggregated:
        key = (
            token.page,
            round(token.bbox[0], 2),
            round(token.bbox[1], 2),
            token.text.lower(),
        )
        if key not in dedup:
            dedup[key] = token
    unique_tokens = list(dedup.values())
    unique_tokens.sort(key=lambda t: (t.page, t.bbox[1], t.bbox[0]))
    return unique_tokens, chosen_sources


def _group_tokens_into_lines(tokens: List[Token], line_y_tolerance: float = 0.004) -> List[Line]:
    lines: List[Line] = []
    current_tokens: List[Token] = []
    current_page: Optional[int] = None
    current_y: Optional[float] = None
    line_no = 0

    def flush() -> None:
        nonlocal line_no, current_tokens
        if not current_tokens:
            return
        line_no += 1
        text_parts: List[str] = []
        last_x1: Optional[float] = None
        for token in current_tokens:
            if last_x1 is not None and token.bbox[0] - last_x1 > 0.005:
                text_parts.append(" ")
            text_parts.append(token.text)
            last_x1 = token.bbox[2]
        text = "".join(text_parts).strip()
        min_x = min(t.bbox[0] for t in current_tokens)
        min_y = min(t.bbox[1] for t in current_tokens)
        max_x = max(t.bbox[2] for t in current_tokens)
        max_y = max(t.bbox[3] for t in current_tokens)
        lines.append(
            Line(
                page=current_tokens[0].page,
                line_no=line_no,
                text=text,
                bbox=(min_x, min_y, max_x, max_y),
                tokens=list(current_tokens),
            )
        )
        current_tokens = []

    for token in tokens:
        if current_page is None:
            current_page = token.page
            current_y = token.bbox[1]
        if token.page != current_page:
            flush()
            current_tokens = [token]
            current_page = token.page
            current_y = token.bbox[1]
            continue
        if current_y is None:
            current_tokens.append(token)
            current_y = token.bbox[1]
            continue
        if abs(token.bbox[1] - current_y) > line_y_tolerance:
            flush()
            current_tokens = [token]
            current_y = token.bbox[1]
        else:
            current_tokens.append(token)
            current_y = (current_y + token.bbox[1]) / 2.0
    flush()
    lines.sort(key=lambda line: (line.page, line.line_no))
    return lines


# ---------------------------------------------------------------------------
# Candidate scoring utilities
# ---------------------------------------------------------------------------


def _tokenize(text: str) -> Set[str]:
    return {match.group(0).lower() for match in _WORD_RE.finditer(text)}


def _normalize_key(text: str) -> str:
    return re.sub(r"\W+", "", text.lower())


def _join_tokens(tokens: Sequence[Token]) -> str:
    """Join tokens in reading order while skipping near-duplicate placements."""

    if not tokens:
        return ""
    tokens_sorted = sorted(
        tokens,
        key=lambda token: (
            token.page,
            round(token.bbox[1], 3),
            round(token.bbox[0], 4),
        ),
    )
    seen: Set[Tuple[int, float, float, str]] = set()
    parts: List[str] = []
    for token in tokens_sorted:
        key = (token.page, round(token.bbox[0], 2), round(token.bbox[1], 2), token.text.lower())
        if key in seen:
            continue
        seen.add(key)
        parts.append(token.text)
    text = " ".join(parts)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    return False


def _candidate_matches_synonyms(candidate: Candidate, synonyms: Sequence[str]) -> bool:
    if not synonyms:
        return True
    if candidate.lexical_terms is None:
        candidate.lexical_terms = _tokenize(candidate.text)
    candidate_terms = candidate.lexical_terms
    normalized_text = _normalize_key(candidate.text)
    for synonym in synonyms:
        normalized_syn = _normalize_key(synonym)
        if normalized_syn and len(normalized_syn) > 2 and normalized_syn in normalized_text:
            return True
        tokens = _tokenize(synonym)
        token_set = {token for token in tokens if len(token) > 2} or tokens
        if token_set & candidate_terms:
            return True
    return False


def _cosine_similarity(vec_a: Sequence[float], vec_b: Sequence[float]) -> float:
    dot = sum(a * b for a, b in zip(vec_a, vec_b))
    norm_a = math.sqrt(sum(a * a for a in vec_a))
    norm_b = math.sqrt(sum(b * b for b in vec_b))
    if not norm_a or not norm_b:
        return 0.0
    return dot / (norm_a * norm_b)


class EmbeddingClient:
    """Deterministic in-memory embedding generator honoring config settings."""

    def __init__(self, config: EmbeddingConfig):
        self._provider = config.provider
        self._model = config.model
        self._timeout = config.timeout_sec
        self._batch_size = config.batch_size or 0
        self._memo: Dict[str, List[float]] = {}
        self._dimension = 384

    def embed(self, texts: Sequence[str]) -> List[List[float]]:
        vectors: List[List[float]] = []
        for text in texts:
            vectors.append(self._embed_single(text))
        return vectors

    def _embed_single(self, text: str) -> List[float]:
        if text in self._memo:
            return self._memo[text]
        seed = f"{self._provider}:{self._model}:{text}".encode("utf-8", errors="ignore")
        vector: List[float] = []
        # Deterministic pseudo-embedding based on cryptographic hashing.
        for i in range(self._dimension):
            digest = hashlib.blake2b(seed + i.to_bytes(4, "little"), digest_size=8).digest()
            integer = int.from_bytes(digest, "little", signed=False)
            value = (integer / (2**64 - 1)) * 2.0 - 1.0
            vector.append(value)
        self._memo[text] = vector
        return vector


class HybridScorer:
    """Combine dense and lexical similarity using a weighted strategy."""

    def __init__(self, embedder: EmbeddingClient, alpha: float):
        self._embedder = embedder
        self._alpha = alpha

    def score(self, query: str, candidates: Sequence[Candidate]) -> None:
        if not candidates:
            return
        query_vec = self._embedder.embed([query])[0]
        query_terms = _tokenize(query)
        dense_values: List[float] = []
        lexical_values: List[float] = []

        for candidate in candidates:
            if candidate.embedding is None:
                candidate.embedding = self._embedder.embed([candidate.text])[0]
            if candidate.lexical_terms is None:
                candidate.lexical_terms = _tokenize(candidate.text)
            candidate.dense_score = _cosine_similarity(query_vec, candidate.embedding)
            intersection = len(query_terms & candidate.lexical_terms)
            union = len(query_terms | candidate.lexical_terms)
            candidate.lexical_score = (intersection / union) if union else 0.0
            dense_values.append(candidate.dense_score)
            lexical_values.append(candidate.lexical_score)

        dense_min, dense_max = min(dense_values), max(dense_values)
        lexical_min, lexical_max = min(lexical_values), max(lexical_values)
        for candidate in candidates:
            dense = candidate.dense_score or 0.0
            lexical = candidate.lexical_score or 0.0
            dense_norm = (dense - dense_min) / (dense_max - dense_min) if dense_max > dense_min else 0.0
            lexical_norm = (lexical - lexical_min) / (lexical_max - lexical_min) if lexical_max > lexical_min else 0.0
            candidate.hybrid_score = self._alpha * dense_norm + (1.0 - self._alpha) * lexical_norm


class RerankerClient:
    """HTTP-based reranker client with graceful fallback."""

    def __init__(self, config: RerankerConfig):
        self._base_url = config.base_url.rstrip('/')
        self._model = config.model
        self._timeout = config.timeout_sec

    def rerank(self, query: str, candidates: Sequence[Candidate], top_k: int) -> Optional[List[str]]:
        if not candidates:
            return None
        payload = {
            "query": query,
            "model": self._model,
            "top_k": top_k,
            "candidates": [
                {"id": candidate.id, "text": candidate.text}
                for candidate in candidates
            ],
        }
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            url=f"{self._base_url}/rerank",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                raw = response.read()
        except Exception as exc:  # pragma: no cover - network failure path
            logging.error("Reranker request failed: %s", exc)
            return None
        try:
            decoded = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            logging.error("Unable to decode reranker response: %s", exc)
            return None
        results = decoded.get("results")
        if not isinstance(results, list):
            logging.error("Reranker response missing 'results'")
            return None
        ordered_ids = []
        for item in results:
            identifier = item.get("id")
            ordered_ids.append(str(identifier))
        return ordered_ids


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------


def _strip_labels(value: str) -> str:
    if ":" in value:
        parts = value.split(":", 1)
        if len(parts[0].split()) <= 4:
            return parts[1].strip()
    return value.strip()


def _apply_regex_extract(value: str, patterns: Sequence[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, value)
        if match:
            groups = [g for g in match.groups() if g]
            if groups:
                return groups[0].strip()
            return match.group(0).strip()
    return value


def _apply_case(value: str, mode: str) -> str:
    normalized = mode.lower()
    if normalized == "upper":
        return value.upper()
    if normalized == "lower":
        return value.lower()
    if normalized == "title":
        return value.title()
    return value


def _normalize_number(value: str, locale_cfg: LocaleConfig) -> Optional[float]:
    cleaned = value.strip()
    if not cleaned:
        return None
    cleaned = cleaned.replace("\u00a0", "")
    cleaned = cleaned.replace(" ", "")
    if locale_cfg.thousand_separator:
        cleaned = cleaned.replace(locale_cfg.thousand_separator, "")
    alt_thousand = "," if locale_cfg.thousand_separator != "," else "."
    if alt_thousand and alt_thousand != locale_cfg.decimal_separator:
        cleaned = cleaned.replace(alt_thousand, "")
    if locale_cfg.decimal_separator:
        cleaned = cleaned.replace(locale_cfg.decimal_separator, ".")
    if cleaned.count(".") > 1:
        parts = cleaned.split(".")
        cleaned = "".join(parts[:-1]) + "." + parts[-1]
    cleaned = re.sub(r"[^0-9.+-]", "", cleaned)
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


class Normalizer:
    """Apply field-specific normalization rules."""

    def __init__(self, locale_cfg: LocaleConfig):
        self._locale = locale_cfg

    def normalize(self, raw_value: str, rules: Dict[str, Any], target_type: Optional[str] = None) -> Any:
        value = raw_value.strip()
        if not value:
            return ""
        if rules.get("strip_label", True):
            value = _strip_labels(value)
        regex_rules = rules.get("regex_extract") or []
        if isinstance(regex_rules, str):
            regex_rules = [regex_rules]
        if regex_rules:
            value = _apply_regex_extract(value, regex_rules)
        replacements = rules.get("replace") or {}
        if isinstance(replacements, MutableMapping):
            for needle, repl in replacements.items():
                value = value.replace(str(needle), str(repl))
        if rules.get("split_camelcase"):
            value = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", value)
            value = re.sub(r"\s+", " ", value)
        case_rule = rules.get("case")
        if isinstance(case_rule, str):
            value = _apply_case(value, case_rule)
        if rules.get("strip"):
            value = value.strip()
        if target_type == "number" or rules.get("as_number"):
            parsed = _normalize_number(value, self._locale)
            if parsed is None:
                return ""
            if float(parsed).is_integer():
                return int(parsed)
            return parsed
        if rules.get("date_formats"):
            value = self._normalize_date(value, rules.get("date_formats"))
        if rules.get("require_digit") and not re.search(r"\d", value):
            return ""
        return value

    def _normalize_date(self, value: str, formats: Any) -> str:
        from datetime import datetime

        if isinstance(formats, str):
            formats = [formats]
        for fmt in formats or []:
            try:
                parsed = datetime.strptime(value, fmt)
                return parsed.strftime("%Y-%m-%d")
            except ValueError:
                continue
        return value


# ---------------------------------------------------------------------------
# Segment handling (S03)
# ---------------------------------------------------------------------------


def _collect_regions(s03: MutableMapping[str, Any]) -> Dict[str, Dict[int, List[BoundingBox]]]:
    regions: Dict[str, Dict[int, List[BoundingBox]]] = {"header": {}, "table": {}, "total": {}}
    segments = s03.get("segments") or []
    for segment in segments:
        if not isinstance(segment, MutableMapping):
            continue
        label = str(segment.get("label") or segment.get("id") or "").lower()
        if label not in regions:
            continue
        page = int(segment.get("page", 1))
        bbox_raw = segment.get("bbox")
        if isinstance(bbox_raw, Sequence):
            bbox = tuple(float(v) for v in bbox_raw)
        elif isinstance(bbox_raw, MutableMapping):
            bbox = (
                float(bbox_raw["x0"]),
                float(bbox_raw["y0"]),
                float(bbox_raw["x1"]),
                float(bbox_raw["y1"]),
            )
        else:
            continue
        regions.setdefault(label, {}).setdefault(page, []).append(bbox)  # type: ignore[call-arg]
    return regions


def _pages_from_regions(regions: Dict[str, Dict[int, List[BoundingBox]]]) -> Set[int]:
    pages: Set[int] = set()
    for label_regions in regions.values():
        pages.update(label_regions.keys())
    return pages


def _bbox_intersects(a: BoundingBox, b: BoundingBox) -> bool:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return (ax0 < bx1 and ax1 > bx0 and ay0 < by1 and ay1 > by0)


# ---------------------------------------------------------------------------
# Retrieval helpers
# ---------------------------------------------------------------------------


def _lines_in_regions(lines: Sequence[Line], bbox_list: Sequence[BoundingBox], page: int) -> List[Line]:
    collected: List[Line] = []
    for line in lines:
        if line.page != page:
            continue
        for bbox in bbox_list:
            if _bbox_intersects(line.bbox, bbox):
                collected.append(line)
                break
    return collected


def _build_candidates(lines: Sequence[Line], origin: str) -> List[Candidate]:
    candidates: List[Candidate] = []
    for index, line in enumerate(lines):
        candidate_id = f"{line.page}:{line.line_no}:{origin}:{index}"
        candidates.append(
            Candidate(
                id=candidate_id,
                text=line.text,
                source_line=line,
                bbox=line.bbox,
                origin=origin,
            )
        )
    return candidates


def _rank_candidates(
    query: str,
    candidates: List[Candidate],
    scorer: HybridScorer,
    reranker: RerankerClient,
    retrieval_cfg: RetrievalConfig,
) -> List[Candidate]:
    if not candidates:
        return []
    scorer.score(query, candidates)
    sorted_candidates = sorted(
        candidates,
        key=lambda item: (
            item.hybrid_score or 0.0,
            -(item.source_line.page),
            -(item.source_line.line_no),
        ),
        reverse=True,
    )
    top_limit = max(1, retrieval_cfg.dense_topk)
    top_subset = sorted_candidates[:top_limit]
    reranked_order = reranker.rerank(query, top_subset, retrieval_cfg.rerank_topk)
    if reranked_order:
        order_map: Dict[str, int] = {cid: idx for idx, cid in enumerate(reranked_order)}
        top_subset.sort(
            key=lambda item: (
                order_map.get(item.id, len(order_map)),
                item.source_line.page,
                item.source_line.line_no,
            )
        )
    seen_ids = {candidate.id for candidate in top_subset}
    remainder = [candidate for candidate in sorted_candidates if candidate.id not in seen_ids]
    return top_subset + remainder


def _select_best_candidate(query: str, candidates: List[Candidate], scorer: HybridScorer, reranker: RerankerClient, retrieval_cfg: RetrievalConfig) -> Optional[Candidate]:
    ranked = _rank_candidates(query, candidates, scorer, reranker, retrieval_cfg)
    return ranked[0] if ranked else None


# ---------------------------------------------------------------------------
# Table processing
# ---------------------------------------------------------------------------

@dataclass
class ColumnBand:
    column_id: str
    x_center: float
    x_min: float
    x_max: float


class TableProcessor:
    """Derive table rows and normalized cells from table regions."""

    def __init__(self, behavior: BehaviorConfig, scorer: HybridScorer, reranker: RerankerClient, retrieval_cfg: RetrievalConfig, normalizer: Normalizer):
        self._behavior = behavior
        self._scorer = scorer
        self._reranker = reranker
        self._retrieval = retrieval_cfg
        self._normalizer = normalizer

    def process(self, table_regions: Dict[int, List[BoundingBox]], lines: Sequence[Line], locale_cfg: LocaleConfig) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        all_rows: List[Dict[str, Any]] = []
        diagnostics: Dict[str, Any] = {"rows": 0, "columns_detected": [col["id"] for col in self._behavior.table_columns]}
        for page, bbox_list in sorted(table_regions.items()):
            region_lines = _lines_in_regions(lines, bbox_list, page)
            if not region_lines:
                continue
            header_line = self._select_header_line(region_lines)
            if not header_line:
                logging.debug("No header line detected on page %s table region", page)
                continue
            bands = self._derive_column_bands(header_line)
            body_lines = [line for line in region_lines if line.line_no != header_line.line_no]
            grouped = self._group_lines_into_rows(body_lines)
            for row_lines in grouped:
                row = self._extract_row(row_lines, bands, locale_cfg)
                numeric_ids = [col["id"] for col in self._behavior.table_columns if col.get("type") == "number"]
                has_numeric = all(
                    isinstance(row.get(col_id), (int, float)) and row.get(col_id) not in (0, 0.0)
                    for col_id in numeric_ids if col_id in {"unit_price", "total_price"}
                )
                if not row.get("article_no") or not has_numeric:
                    continue
                all_rows.append(row)
        diagnostics["rows"] = len(all_rows)
        return all_rows, diagnostics

    def _select_header_line(self, lines: Sequence[Line]) -> Optional[Line]:
        best_line: Optional[Line] = None
        best_score = -1
        for line in lines:
            terms = _tokenize(line.text)
            score = 0
            for column in self._behavior.table_columns:
                column_id = column.get("id")
                synonyms = self._behavior.table_header_synonyms.get(column_id, [])
                for synonym in synonyms:
                    tokens = set(_tokenize(synonym))
                    if tokens & terms:
                        score += 1
                        break
            if score > best_score:
                best_score = score
                best_line = line
            elif score == best_score and best_line is not None:
                if (line.page, line.line_no) < (best_line.page, best_line.line_no):
                    best_line = line
        return best_line

    def _derive_column_bands(self, header_line: Line) -> List[ColumnBand]:
        matched_positions: Dict[str, float] = {}
        normalized_header_tokens = [(_normalize_key(token.text), token) for token in header_line.tokens]
        for column in self._behavior.table_columns:
            column_id = column.get("id")
            synonyms = self._behavior.table_header_synonyms.get(column_id, []) + [column.get("name", "")]
            normalized_synonyms = [_normalize_key(text) for text in synonyms if text]
            token_positions: List[Token] = []
            for synonym in synonyms:
                terms = [term for term in re.findall(r"\w+", synonym.lower()) if term]
                normalized_terms = [_normalize_key(term) for term in terms if _normalize_key(term)]
                if not normalized_terms:
                    continue
                window = len(normalized_terms)
                for start in range(len(normalized_header_tokens) - window + 1):
                    segment = normalized_header_tokens[start : start + window]
                    if all(segment[idx][0] == normalized_terms[idx] for idx in range(window)):
                        token_positions.extend(token for _, token in segment)
            if token_positions:
                matched_positions[column_id] = sum((token.bbox[0] + token.bbox[2]) / 2.0 for token in token_positions) / len(token_positions)
                continue
            for normalized_token, token in normalized_header_tokens:
                if not normalized_token:
                    continue
                if any(normalized_syn and normalized_syn in normalized_token for normalized_syn in normalized_synonyms):
                    token_positions.append(token)
            if not token_positions:
                header_terms = _tokenize(header_line.text)
                match_tokens: Set[str] = set()
                for synonym in synonyms:
                    tokens = set(_tokenize(synonym))
                    if tokens & header_terms:
                        match_tokens = tokens
                        break
                if match_tokens:
                    token_positions = [token for token in header_line.tokens if _tokenize(token.text) & match_tokens]
            if token_positions:
                avg_x = sum((token.bbox[0] + token.bbox[2]) / 2.0 for token in token_positions) / len(token_positions)
                matched_positions[column_id] = avg_x
        centers: List[float] = []
        bands: List[ColumnBand] = []
        default_step = 1.0 / max(1, len(self._behavior.table_columns))
        for index, column in enumerate(self._behavior.table_columns):
            column_id = column.get("id")
            center = matched_positions.get(column_id, min(0.98, default_step * (index + 0.5)))
            centers.append(center)
        sorted_centers = sorted((value, idx) for idx, value in enumerate(centers))
        boundaries: List[Tuple[float, float, float]] = []
        for pos, (center, idx) in enumerate(sorted_centers):
            left = 0.0 if pos == 0 else (center + sorted_centers[pos - 1][0]) / 2.0
            right = 1.0 if pos == len(sorted_centers) - 1 else (center + sorted_centers[pos + 1][0]) / 2.0
            boundaries.append((idx, max(0.0, left), min(1.0, right)))
        for idx, left, right in boundaries:
            column_id = self._behavior.table_columns[idx].get("id")
            bands.append(
                ColumnBand(
                    column_id=column_id,
                    x_center=centers[idx],
                    x_min=left,
                    x_max=right,
                )
            )
        bands.sort(key=lambda band: band.x_center)
        for band in bands:
            if band.column_id == "description":
                band.x_max = min(1.0, band.x_max + 0.04)
        return bands

    def _group_lines_into_rows(self, lines: Sequence[Line]) -> List[List[Line]]:
        if not lines:
            return []
        max_gap = float(self._behavior.table_row_detection.get("max_gap", 0.02))
        sorted_lines = sorted(lines, key=lambda line: (line.y_center, line.x_center))
        groups: List[List[Line]] = []
        current: List[Line] = [sorted_lines[0]]
        for line in sorted_lines[1:]:
            if line.y_center - current[-1].y_center > max_gap:
                groups.append(current)
                current = [line]
            else:
                current.append(line)
        groups.append(current)
        min_cells = int(self._behavior.table_row_detection.get("min_cells", 1))
        filtered: List[List[Line]] = [group for group in groups if len(group) >= min_cells or len(groups) == 1]
        if not filtered:
            return groups
        return filtered

    def _extract_row(self, row_lines: Sequence[Line], bands: Sequence[ColumnBand], locale_cfg: LocaleConfig) -> Dict[str, Any]:
        row: Dict[str, Any] = {}
        ordered_lines = sorted(row_lines, key=lambda line: (line.y_center, line.x_center))
        for band in bands:
            column_id = band.column_id
            column_conf = next((col for col in self._behavior.table_columns if col.get("id") == column_id), {})
            normalize_rules = self._behavior.table_normalize.get(column_id, {})
            target_type = column_conf.get("type")
            band_tokens: List[Token] = []
            reference_line = ordered_lines[0] if ordered_lines else None
            for line in ordered_lines:
                tokens_in_band = [token for token in line.tokens if band.x_min <= (token.bbox[0] + token.bbox[2]) / 2.0 <= band.x_max]
                if not tokens_in_band:
                    continue
                if target_type == "number" or column_id != "description":
                    band_tokens = tokens_in_band
                    reference_line = line
                    break
                if band_tokens and any(":" in token.text for token in tokens_in_band):
                    break
                band_tokens.extend(tokens_in_band)
                if reference_line is None:
                    reference_line = line
            if not band_tokens:
                row[column_id] = ""
                continue
            text = _join_tokens(band_tokens)
            if not text:
                row[column_id] = ""
                continue
            line_ref = reference_line or (ordered_lines[0] if ordered_lines else None)
            bbox = (
                band_tokens[0].bbox[0],
                band_tokens[0].bbox[1],
                band_tokens[-1].bbox[2],
                band_tokens[-1].bbox[3],
            )
            candidate = Candidate(
                id=f"{line_ref.page if line_ref else 0}:{line_ref.line_no if line_ref else 0}:{column_id}",
                text=text,
                source_line=line_ref if line_ref else row_lines[0],
                bbox=bbox,
                origin="table-cell",
            )
            value = self._normalizer.normalize(candidate.text, normalize_rules, target_type)
            row[column_id] = value
        return row


# ---------------------------------------------------------------------------
# Header & total processing helpers
# ---------------------------------------------------------------------------


def _neighbor_lines(line: Line, lines_by_page: Dict[int, Dict[int, Line]], offsets: Sequence[int]) -> List[Line]:
    neighbors: List[Line] = []
    page_lines = lines_by_page.get(line.page, {})
    for offset in offsets:
        candidate = page_lines.get(line.line_no + offset)
        if candidate:
            neighbors.append(candidate)
    return neighbors


def _lines_index(lines: Sequence[Line]) -> Dict[int, Dict[int, Line]]:
    index: Dict[int, Dict[int, Line]] = {}
    for line in lines:
        index.setdefault(line.page, {})[line.line_no] = line
    return index


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def _within_tolerance(expected: float, observed: float, tolerance: float) -> bool:
    if tolerance < 0:
        return False
    if expected == 0:
        return abs(observed) <= tolerance
    return abs(expected - observed) <= max(tolerance * abs(expected), tolerance)


class Validator:
    """Perform numeric validation on table rows and totals."""

    def __init__(self, tolerance_line: float, tolerance_total: float, behavior: str):
        self._tol_line = tolerance_line
        self._tol_total = tolerance_total
        self._behavior = behavior

    def validate(self, table_rows: Sequence[Dict[str, Any]], totals: Dict[str, Any]) -> Dict[str, Any]:
        diagnostics = {
            "line_checks_passed": True,
            "subtotal_match": True,
            "grand_total_match": True,
            "notes": [],
        }
        qty_keys = {"qty", "quantity"}
        unit_price_keys = {"unit_price", "price", "unitprice"}
        line_total_keys = {"line_total", "total", "amount", "total_price"}
        qty_key = next((key for key in table_rows[0].keys() if key.lower() in qty_keys), None) if table_rows else None
        unit_key = next((key for key in table_rows[0].keys() if key.lower() in unit_price_keys), None) if table_rows else None
        line_key = next((key for key in table_rows[0].keys() if key.lower() in line_total_keys), None) if table_rows else None
        subtotal_value = self._as_number(totals.get("subtotal"))
        grand_total_value = self._as_number(totals.get("grand_total"))
        row_sum = 0.0
        for idx, row in enumerate(table_rows, start=1):
            qty = self._as_number(row.get(qty_key)) if qty_key else None
            unit_price = self._as_number(row.get(unit_key)) if unit_key else None
            line_total = self._as_number(row.get(line_key)) if line_key else None
            if qty is not None and unit_price is not None and line_total is not None:
                expected = qty * unit_price
                if not _within_tolerance(expected, line_total, self._tol_line):
                    diagnostics["line_checks_passed"] = False
                    diagnostics["notes"].append(
                        f"Row {idx}: qty*unit_price mismatch (expected {expected:.2f}, got {line_total:.2f})"
                    )
            if line_total is not None:
                row_sum += line_total
        if subtotal_value is not None and not _within_tolerance(row_sum, subtotal_value, self._tol_total):
            diagnostics["subtotal_match"] = False
            diagnostics["notes"].append(
                f"Subtotal mismatch (rows {row_sum:.2f} vs subtotal {subtotal_value:.2f})"
            )
        adjustments = 0.0
        for key, value in totals.items():
            if key in {"subtotal", "grand_total", "vat_base", "currency"}:
                continue
            numeric = self._as_number(value)
            if numeric is not None:
                adjustments += numeric
        if grand_total_value is not None and subtotal_value is not None:
            expected_grand = subtotal_value + adjustments
            if not _within_tolerance(expected_grand, grand_total_value, self._tol_total):
                diagnostics["grand_total_match"] = False
                diagnostics["notes"].append(
                    f"Grand total mismatch (subtotal + adjustments {expected_grand:.2f} vs grand total {grand_total_value:.2f})"
                )
        if not all([diagnostics["line_checks_passed"], diagnostics["subtotal_match"], diagnostics["grand_total_match"]]):
            logging.error("Validation exceeded tolerance (%s). Notes: %s", self._behavior, ", ".join(diagnostics["notes"]))
        return diagnostics

    @staticmethod
    def _as_number(value: Any) -> Optional[float]:
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value)
            except ValueError:
                return None
        return None


# ---------------------------------------------------------------------------
# Main pipeline orchestration
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="In-memory RAG extraction for invoices (S04).")
    parser.add_argument("--token", required=True, help="Path to S02 JSON (tokens)")
    parser.add_argument("--segment", required=True, help="Path to S03 JSON (regions)")
    parser.add_argument("--config", required=True, help="Path to pipeline config JSON")
    parser.add_argument("--out", required=True, help="Path to output JSON")
    parser.add_argument("--tokenizer", help="Token sources to load (plumber,pymupdf,ocr,all)")
    parser.add_argument("--page", help="Comma-separated list of pages or 'all'")
    parser.add_argument("--echo", action="store_true", help="Enable verbose diagnostics and DEBUG logging")
    return parser.parse_args(argv)


class RagPipeline:
    """Orchestrates the end-to-end RAG flow for invoices."""

    def __init__(self, config: PipelineConfig, echo: bool = False):
        self.config = config
        self.echo = echo
        self.embedder = EmbeddingClient(config.embedding)
        self.scorer = HybridScorer(self.embedder, config.retrieval.hybrid_alpha)
        self.reranker = RerankerClient(config.reranker)
        self.normalizer = Normalizer(config.locale)
        tolerance_line = float(config.behavior.validation.get("tolerance", {}).get("line_total", config.behavior.validation.get("line_total", 0.0)))
        tolerance_grand = float(config.behavior.validation.get("tolerance", {}).get("grand_total", config.behavior.validation.get("grand_total", 0.0)))
        self.validator = Validator(
            tolerance_line=tolerance_line,
            tolerance_total=tolerance_grand,
            behavior=str(config.behavior.validation.get("behavior_on_mismatch", "warn")),
        )

    def run(self, s02_path: Path, s03_path: Path, output_path: Path, tokenizer_override: Optional[str], page_override: Optional[str]) -> None:
        s02 = _load_json(s02_path)
        if not isinstance(s02, MutableMapping):
            raise RagError("S02 payload must be a JSON object")
        s03 = _load_json(s03_path)
        if not isinstance(s03, MutableMapping):
            raise RagError("S03 payload must be a JSON object")

        token_sources = self._resolve_token_sources(tokenizer_override, s02)
        tokens, used_sources = _collect_tokens(s02, token_sources)
        lines = _group_tokens_into_lines(tokens)
        logging.info("Token sources used: %s", ", ".join(used_sources))

        regions = _collect_regions(s03)
        default_pages = self._resolve_default_pages(page_override, regions)
        selected_pages = sorted(default_pages)
        logging.info("Pages processed: %s", selected_pages)

        lines_by_page = [line for line in lines if line.page in selected_pages]
        lines_index = _lines_index(lines_by_page)

        header_candidates = self._collect_candidates(lines_by_page, regions.get("header", {}), "header")
        total_candidates = self._collect_candidates(lines_by_page, regions.get("total", {}), "total")
        table_processor = TableProcessor(self.config.behavior, self.scorer, self.reranker, self.config.retrieval, self.normalizer)
        table_rows, table_diag = table_processor.process(regions.get("table", {}), lines_by_page, self.config.locale)

        header_values, header_diag = self._process_region("header", header_candidates, lines_index)
        total_values, total_diag = self._process_region("total", total_candidates, lines_index)

        validation_diag = self.validator.validate(table_rows, total_values)

        meta_diag: Dict[str, Any] = {
            "pages_processed": selected_pages,
            "token_sources_used": used_sources,
        }
        diagnostics: Dict[str, Any] = {"validation": validation_diag}
        if self.echo:
            diagnostics.update({"header": header_diag, "table": table_diag, "total": total_diag})
        meta_diag["diagnostics"] = diagnostics

        output = {
            "header": header_values,
            "table": table_rows,
            "total": total_values,
            "meta": meta_diag,
        }
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("w", encoding="utf-8") as handle:
            json.dump(output, handle, indent=2, ensure_ascii=False)
        logging.info("Wrote output JSON to %s", output_path)

    def _resolve_token_sources(self, tokenizer_override: Optional[str], s02: MutableMapping[str, Any]) -> List[str]:
        if tokenizer_override:
            raw = tokenizer_override
        elif self.config.defaults.tokenizer:
            raw = self.config.defaults.tokenizer
        else:
            return ["all"]
        allowed = {"plumber", "pymupdf", "ocr", "all"}
        parts = [part.strip() for part in raw.split(",") if part.strip()]
        for part in parts:
            if part not in allowed:
                raise RagError(f"Unknown tokenizer source '{part}'")
        return parts or ["all"]

    def _resolve_default_pages(self, page_override: Optional[str], regions: Dict[str, Dict[int, List[BoundingBox]]]) -> Set[int]:
        all_pages = _pages_from_regions(regions)
        if page_override:
            if page_override.lower() == "all":
                return all_pages
            pages = {int(value.strip()) for value in page_override.split(",") if value.strip()}
            missing = pages - all_pages
            for missing_page in sorted(missing):
                logging.debug("Requested page %s has no regions; skipping", missing_page)
            return pages & all_pages
        if self.config.defaults.pages:
            return {int(page) for page in self.config.defaults.pages if page in all_pages}
        return all_pages

    def _collect_candidates(self, lines: Sequence[Line], regions: Dict[int, List[BoundingBox]], origin: str) -> List[Candidate]:
        candidates: List[Candidate] = []
        for page, bbox_list in sorted(regions.items()):
            region_lines = _lines_in_regions(lines, bbox_list, page)
            candidates.extend(_build_candidates(region_lines, origin))
        logging.info("Collected %s %s candidates", len(candidates), origin)
        return candidates

    def _process_region(self, region: str, candidates: List[Candidate], lines_index: Dict[int, Dict[int, Line]]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        values: Dict[str, Any] = {}
        diagnostics: Dict[str, Any] = {}
        if region == "header":
            fields = self.config.behavior.header_fields
            query_synonyms = self.config.behavior.header_query_synonyms
            normalize_rules = self.config.behavior.header_normalize
        else:
            fields = self.config.behavior.total_keys
            query_synonyms = self.config.behavior.total_query_synonyms
            normalize_rules = self.config.behavior.total_normalize
        for field_id in fields:
            synonyms = query_synonyms.get(field_id) or [field_id]
            query = " OR ".join(synonyms)
            ranked = _rank_candidates(query, list(candidates), self.scorer, self.reranker, self.config.retrieval)
            rules = normalize_rules.get(field_id, {})
            target_type = rules.get("type")
            selected_candidate: Optional[Candidate] = None
            selected_line: Optional[Line] = None
            normalized_value: Any = ""

            def _normalize_candidate_text(text: str) -> Any:
                return self.normalizer.normalize(text, rules, target_type)

            for candidate in ranked:
                if not _candidate_matches_synonyms(candidate, synonyms):
                    continue
                tentative = _normalize_candidate_text(candidate.text)
                if _is_empty(tentative):
                    continue
                selected_candidate = candidate
                selected_line = candidate.source_line
                normalized_value = tentative
                break

            if selected_candidate is None and isinstance(rules.get("peek_neighbors"), int):
                peek_range = int(rules.get("peek_neighbors"))
                offsets = []
                for offset in range(1, peek_range + 1):
                    offsets.extend([offset, -offset])
                for candidate in ranked:
                    if not _candidate_matches_synonyms(candidate, synonyms):
                        continue
                    for neighbor in _neighbor_lines(candidate.source_line, lines_index, offsets):
                        tentative = _normalize_candidate_text(neighbor.text)
                        if _is_empty(tentative):
                            continue
                        selected_candidate = candidate
                        selected_line = neighbor
                        normalized_value = tentative
                        break
                    if selected_candidate is not None:
                        break

            if selected_candidate is None:
                for candidate in ranked:
                    tentative = _normalize_candidate_text(candidate.text)
                    if _is_empty(tentative):
                        continue
                    selected_candidate = candidate
                    selected_line = candidate.source_line
                    normalized_value = tentative
                    break

            if selected_candidate is None or _is_empty(normalized_value) or selected_line is None:
                values[field_id] = ""
                continue

            values[field_id] = normalized_value
            diagnostics[field_id] = {
                "chosen_page": selected_line.page,
                "chosen_line_no": selected_line.line_no,
            }
        return values, diagnostics


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def configure_logging(echo: bool) -> None:
    level = logging.DEBUG if echo else logging.INFO
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(message)s")


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    configure_logging(args.echo)
    try:
        config = load_config(Path(args.config))
        pipeline = RagPipeline(config=config, echo=args.echo)
        pipeline.run(
            s02_path=Path(args.token),
            s03_path=Path(args.segment),
            output_path=Path(args.out),
            tokenizer_override=args.tokenizer,
            page_override=args.page,
        )
        return 0
    except RagError as exc:
        logging.error("Fatal error: %s", exc)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
