#!/usr/bin/env python3
# Stage 1 — Multi-Engine PDF Tokenization
# Deterministic, geometry-first word tokens (pdfplumber + PyMuPDF) with normalized [0..1] bboxes.
# Inputs : --in  /path/to/invoice.pdf
# Outputs: --out /path/to/tokens.json
#
# Additions in v2.1:
# - Stable engine-namespaced UIDs per token (uid: "pl-000123" / "pm-000123")
# - Optional "lines" preview under each engine block (deterministic grouping by y0 → x0)
# - Page header band heuristic (top 15% per page by default), for prompting only

from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pdfplumber

try:  # PyMuPDF (fitz) is optional but preferred
    import fitz  # type: ignore
except ImportError:  # pragma: no cover - environment dependent
    fitz = None


def _norm(v: float, denom: float) -> float:
    return float(v) / float(denom) if denom else 0.0


def _sort_and_number(tokens: List[Dict[str, Any]]) -> None:
    """
    Sort tokens deterministically and assign contiguous numeric ids starting at 1.
    Keeps existing order semantics used by downstream stages.
    """
    tokens.sort(key=lambda t: (t["page"], t["bbox"]["y0"], t["bbox"]["x0"]))
    for idx, token in enumerate(tokens, start=1):
        token["id"] = idx


def _add_uids(tokens: List[Dict[str, Any]], engine_prefix: str) -> None:
    """
    Add stable, engine-namespaced UIDs without touching numeric id.
    Example uid: pl-000123 / pm-000456
    """
    for token in tokens:
        # Defensive: if id is missing for any reason, backfill with 0 (still deterministic after _sort_and_number)
        tid = int(token.get("id", 0))
        token["uid"] = f"{engine_prefix}-{tid:06d}"


def _extract_pdfplumber(pdf_path: Path) -> Tuple[List[Dict[str, Any]], List[Dict[str, float]]]:
    tokens: List[Dict[str, Any]] = []
    pages: List[Dict[str, float]] = []

    with pdfplumber.open(str(pdf_path)) as pdf:
        for pidx, page in enumerate(pdf.pages):
            width = float(page.width)
            height = float(page.height)
            pages.append({"page": pidx + 1, "width": width, "height": height})

            words = page.extract_words(
                use_text_flow=True,
                keep_blank_chars=False,
                extra_attrs=[],
            )
            words.sort(key=lambda w: (w["top"], w["x0"], w["x1"]))

            for w in words:
                x0 = float(w["x0"])
                x1 = float(w["x1"])
                top = float(w["top"])
                bottom = float(w["bottom"])
                tokens.append({
                    "page": pidx + 1,
                    "text": w["text"],
                    "abs_bbox": {
                        "x0": x0,
                        "y0": top,
                        "x1": x1,
                        "y1": bottom,
                        "width": width,
                        "height": height,
                    },
                    "bbox": {
                        "x0": _norm(x0, width),
                        "y0": _norm(top, height),
                        "x1": _norm(x1, width),
                        "y1": _norm(bottom, height),
                    },
                })

    return tokens, pages


_PYMUPDF_WARNING: Optional[str] = None


def _extract_pymupdf(pdf_path: Path, pages: List[Dict[str, float]]) -> Optional[List[Dict[str, Any]]]:
    if fitz is None:
        return None

    tokens: List[Dict[str, Any]] = []
    dims = {p["page"]: (float(p["width"]), float(p["height"])) for p in pages}

    with fitz.open(pdf_path) as doc:  # type: ignore[attr-defined]
        for pidx in range(doc.page_count):
            page_number = pidx + 1
            page = doc.load_page(pidx)

            width, height = dims.get(
                page_number,
                (float(page.rect.width), float(page.rect.height)),
            )

            words = page.get_text("words") or []
            words.sort(key=lambda w: (w[1], w[0], w[2]))

            for word in words:
                if len(word) < 5:
                    continue

                x0, y0, x1, y1, text, *_ = word
                text = (text or "").strip()
                if not text:
                    continue

                x0f = float(x0)
                y0f = float(y0)
                x1f = float(x1)
                y1f = float(y1)

                tokens.append({
                    "page": page_number,
                    "text": text,
                    "abs_bbox": {
                        "x0": x0f,
                        "y0": y0f,
                        "x1": x1f,
                        "y1": y1f,
                        "width": width,
                        "height": height,
                    },
                    "bbox": {
                        "x0": _norm(x0f, width),
                        "y0": _norm(y0f, height),
                        "x1": _norm(x1f, width),
                        "y1": _norm(y1f, height),
                    },
                })

    return tokens


def _build_lines(tokens: List[Dict[str, Any]], threshold: float = 0.004) -> List[Dict[str, Any]]:
    """
    Build an LLM-oriented 'lines' preview by grouping tokens per page.
    - Deterministic sort: page, y0, x0
    - New line when |y0_current - y0_line_anchor| > threshold
    - Concatenate token 'norm' if present else 'text'
    Emits: [{page, y0, text}, ...] with y0 in normalized coordinate space.
    """
    if not tokens:
        return []

    # Work per page to prevent cross-page grouping.
    by_page: Dict[int, List[Dict[str, Any]]] = {}
    for t in tokens:
        by_page.setdefault(int(t["page"]), []).append(t)

    lines_out: List[Dict[str, Any]] = []

    for page, toks in sorted(by_page.items(), key=lambda kv: kv[0]):
        toks.sort(key=lambda t: (t["bbox"]["y0"], t["bbox"]["x0"]))

        current_line_y0: Optional[float] = None
        current_line_parts: List[str] = []

        def flush():
            nonlocal current_line_y0, current_line_parts
            if current_line_parts and current_line_y0 is not None:
                text = " ".join(p for p in current_line_parts if p)
                # Avoid emitting empty strings after excessive whitespace filtering
                if text:
                    lines_out.append({
                        "page": page,
                        "y0": float(current_line_y0),
                        "text": text,
                    })
            current_line_y0 = None
            current_line_parts = []

        for t in toks:
            ty0 = float(t["bbox"]["y0"])
            part = t.get("norm") or t.get("text") or ""
            if current_line_y0 is None:
                current_line_y0 = ty0
                current_line_parts = [part]
            else:
                if abs(ty0 - current_line_y0) <= threshold:
                    current_line_parts.append(part)
                else:
                    flush()
                    current_line_y0 = ty0
                    current_line_parts = [part]

        # flush remainder
        flush()

    return lines_out


def tokenize(pdf_path: Path, include_lines: bool = True, line_threshold: float = 0.004, header_ratio: float = 0.15) -> Dict[str, Any]:
    global _PYMUPDF_WARNING

    doc_id = pdf_path.name
    _PYMUPDF_WARNING = None

    plumber_tokens, pages = _extract_pdfplumber(pdf_path)
    _sort_and_number(plumber_tokens)
    _add_uids(plumber_tokens, "pl")

    data: Dict[str, Any] = {
        "doc_id": doc_id,
        "page_count": len(pages),
        "pages": pages,
        # Heuristic header band (top X% of each page), for prompting only
        "page_header_band": [
            {"page": p["page"], "bbox": {"y0": 0.0, "y1": float(max(0.0, min(1.0, header_ratio)))}} for p in pages
        ],
        "plumber": {
            "token_count": len(plumber_tokens),
            "tokens": plumber_tokens,
        },
    }

    if include_lines:
        data["plumber"]["lines"] = _build_lines(plumber_tokens, threshold=line_threshold)

    pymupdf_tokens: Optional[List[Dict[str, Any]]] = None
    try:
        pymupdf_tokens = _extract_pymupdf(pdf_path, pages)
    except Exception as exc:  # pragma: no cover - best effort fallback
        _PYMUPDF_WARNING = (
            f"PyMuPDF extraction failed: {exc.__class__.__name__}: {exc}"
        )
        pymupdf_tokens = None

    if pymupdf_tokens is None:
        if fitz is None and _PYMUPDF_WARNING is None:
            _PYMUPDF_WARNING = "PyMuPDF (fitz) not available; plumber-only output produced."
    else:
        _sort_and_number(pymupdf_tokens)
        _add_uids(pymupdf_tokens, "pm")
        data["pymupdf"] = {
            "token_count": len(pymupdf_tokens),
            "tokens": pymupdf_tokens,
        }
        if include_lines:
            data["pymupdf"]["lines"] = _build_lines(pymupdf_tokens, threshold=line_threshold)

    data["stage"] = "tokenizer_mv"
    data["version"] = "2.1"
    data["notes"] = "Always-on multi-engine (plumber + pymupdf). Added uids, lines, and page_header_band."

    return data


def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 1 — Multi-Engine PDF Tokenizer")
    ap.add_argument("--in", dest="inp", required=True, help="Path to input PDF")
    ap.add_argument("--out", dest="out", required=True, help="Path to output tokens.json")

    # New optional controls
    ap.add_argument(
        "--no-lines",
        action="store_true",
        help="Disable LLM-oriented 'lines' preview in engine blocks (enabled by default).",
    )
    ap.add_argument(
        "--line-threshold",
        dest="line_threshold",
        type=float,
        default=0.004,
        help="Vertical y0 threshold for line grouping (default: 0.004 in normalized [0..1] space).",
    )
    ap.add_argument(
        "--header-ratio",
        dest="header_ratio",
        type=float,
        default=0.15,
        help="Top-of-page ratio for the header band heuristic (default: 0.15).",
    )

    args = ap.parse_args()

    pdf_path = Path(args.inp).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    data = tokenize(
        pdf_path,
        include_lines=not args.no_lines,
        line_threshold=float(args.line_threshold),
        header_ratio=float(args.header_ratio),
    )

    if _PYMUPDF_WARNING:
        print(f"WARNING: {_PYMUPDF_WARNING}", file=sys.stderr)

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    # Short deterministic summary for quick inspection
    summary = {
        "stage": data["stage"],
        "doc_id": data["doc_id"],
        "page_count": data["page_count"],
        "plumber_tokens": data["plumber"]["token_count"],
        "out": str(out_path),
        "version": data.get("version"),
    }
    if "pymupdf" in data:
        summary["pymupdf_tokens"] = data["pymupdf"]["token_count"]
    else:
        summary["pymupdf"] = "unavailable"

    print(json.dumps(summary, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    main()
