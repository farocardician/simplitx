#!/usr/bin/env python3
"""Locate the header region on a PT KASS invoice using Ollama."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.error import URLError, HTTPError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


@dataclass
class Token:
    token_id: int
    text: str
    page: int
    bbox_norm: Dict[str, float]
    abs_bbox: Optional[Dict[str, float]]

    @property
    def x0(self) -> float:
        return self.bbox_norm["x0"]

    @property
    def y0(self) -> float:
        return self.bbox_norm["y0"]

    @property
    def x1(self) -> float:
        return self.bbox_norm["x1"]

    @property
    def y1(self) -> float:
        return self.bbox_norm["y1"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Detect the header region on a tokenized PT KASS invoice."
    )
    parser.add_argument("--tokens", required=True, type=Path, help="Token JSON file (s02 stage)")
    parser.add_argument("--host", required=True, help="Ollama host, e.g. http://localhost:11434")
    parser.add_argument("--model", required=True, help="Ollama model name")
    parser.add_argument("--out", required=True, type=Path, help="Output S03-Lite JSON path")
    parser.add_argument("--page", type=int, default=1, help="1-indexed page number to analyze")
    parser.add_argument(
        "--overlay",
        type=Path,
        help="Source PDF for overlay (overlay saved alongside as <stem>-overlay.pdf)",
    )
    return parser.parse_args()


def load_tokens(tokens_path: Path, page: int) -> Tuple[List[Token], Optional[Tuple[float, float]]]:
    with tokens_path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)

    raw_tokens: List[Dict[str, Any]] = []
    dims: Optional[Tuple[float, float]] = None

    def collect(source: Iterable[Dict[str, Any]]) -> None:
        nonlocal dims
        for entry in source:
            if int(entry.get("page", 0)) != page:
                continue
            raw_tokens.append(entry)
            if dims is None:
                dims = _extract_dims(entry)

    if isinstance(data, dict):
        if isinstance(data.get("plumber"), dict) and isinstance(data["plumber"].get("tokens"), list):
            collect(data["plumber"]["tokens"])
        elif isinstance(data.get("tokens"), list):
            collect(data["tokens"])

    if not raw_tokens:
        raise ValueError(f"No tokens found for page {page} in {tokens_path}")

    if dims is None and isinstance(data.get("pages"), list):
        for page_info in data["pages"]:
            if int(page_info.get("page", 0)) == page:
                width = float(page_info.get("width"))
                height = float(page_info.get("height"))
                dims = (width, height)
                break

    tokens: List[Token] = []
    seen_ids: set[int] = set()
    for entry in raw_tokens:
        token_id = entry.get("id")
        if token_id is None:
            continue
        token_id = int(token_id)
        if token_id in seen_ids:
            continue
        seen_ids.add(token_id)
        bbox_norm = _normalize_bbox(entry)
        text = str(entry.get("text", ""))
        token = Token(
            token_id=token_id,
            text=text,
            page=int(entry.get("page", page)),
            bbox_norm=bbox_norm,
            abs_bbox=entry.get("abs_bbox"),
        )
        tokens.append(token)

    tokens.sort(key=lambda t: (t.y0, t.x0, t.token_id))
    return tokens, dims


def _extract_dims(entry: Dict[str, Any]) -> Optional[Tuple[float, float]]:
    abs_bbox = entry.get("abs_bbox")
    if isinstance(abs_bbox, dict):
        width = abs_bbox.get("width")
        height = abs_bbox.get("height")
        if width and height:
            return float(width), float(height)
    return None


def _normalize_bbox(entry: Dict[str, Any]) -> Dict[str, float]:
    if isinstance(entry.get("bbox"), dict):
        bbox = entry["bbox"]
        coords = {k: float(bbox.get(k, 0.0)) for k in ("x0", "y0", "x1", "y1")}
        if not any(math.isnan(v) for v in coords.values()):
            if max(coords.values()) <= 1.5:
                return coords
    abs_bbox = entry.get("abs_bbox")
    if not isinstance(abs_bbox, dict):
        raise ValueError("Token missing bbox information")
    width = float(abs_bbox.get("width"))
    height = float(abs_bbox.get("height"))
    x0 = float(abs_bbox.get("x0")) / width
    y0 = float(abs_bbox.get("y0")) / height
    x1 = float(abs_bbox.get("x1")) / width
    y1 = float(abs_bbox.get("y1")) / height
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def select_top_tokens(tokens: Sequence[Token], ratio_limit: float = 0.38, max_count: int = 180) -> List[Token]:
    """Return top-of-page tokens, widening until header keywords (incl. subject) appear."""
    cues = ("bill", "commercial", "invoice")
    cutoff = ratio_limit
    top = [tok for tok in tokens if tok.y0 <= cutoff]

    def has_cues(sample: Sequence[Token]) -> bool:
        sample_text = [tok.text.lower() for tok in sample]
        if any("subject" in text for text in sample_text):
            return True
        return any(any(cue in text for cue in cues) for text in sample_text)

    while cutoff < 0.55 and not has_cues(top):
        cutoff += 0.03
        top = [tok for tok in tokens if tok.y0 <= cutoff]

    if not top:
        top = list(tokens[:max_count])
    if len(top) > max_count:
        top = top[:max_count]
    return top


def group_tokens_by_line(tokens: Sequence[Token], tolerance: float = 0.004) -> List[List[Token]]:
    lines: List[List[Token]] = []
    for token in tokens:
        placed = False
        for line in lines:
            if abs(line[0].y0 - token.y0) <= tolerance:
                line.append(token)
                placed = True
                break
        if not placed:
            lines.append([token])
    for line in lines:
        line.sort(key=lambda t: (t.x0, t.token_id))
    lines.sort(key=lambda line: (line[0].y0, line[0].x0))
    return lines


def build_prompt_snippet(tokens: Sequence[Token]) -> str:
    lines = group_tokens_by_line(tokens)
    snippet_lines: List[str] = []
    for idx, line in enumerate(lines, 1):
        pieces = []
        for token in line:
            clean_text = re.sub(r"\s+", " ", token.text).strip()
            clean_text = clean_text.replace("|", "/")
            pieces.append(f"{clean_text}#{token.token_id}")
        snippet_lines.append(f"L{idx:02d} y={line[0].y0:.3f}: {' '.join(pieces)}")
        if len(snippet_lines) >= 90:
            break
    return "\n".join(snippet_lines)


def build_prompts(snippet: str) -> Tuple[str, str]:
    system_prompt = (
        "You identify header tokens on PT KASS invoices. "
        "Return compact JSON only: {\"header_token_ids\": [int, ...]}."
    )
    user_prompt = (
        "Select token ids forming the HEADER region (top of page). "
        "Must Include: Seller name (PT KASS INDONESIA IP SERVICES), Invoice number and date lines, Buyer Name (Bill to), Buyer address, and Subject.\n"
        "The region should end right above the token line (# Item & Description Qty Rate Amount)\n"
        "Tokens are listed as text#id with y-order (top first).\n"
        f"Tokens:\n{snippet}"
    )
    return system_prompt, user_prompt

def call_ollama(host: str, model: str, system_prompt: str, user_prompt: str) -> Tuple[str, str]:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "options": {"temperature": 0.0, "top_p": 0.9},
        "stream": False,
    }
    body = json.dumps(payload).encode("utf-8")
    url = urljoin(host if host.endswith("/") else host + "/", "api/chat")
    request = Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=30) as response:
            response_data = response.read().decode("utf-8")
    except HTTPError as err:
        raise RuntimeError(f"Ollama request failed: {err.code} {err.reason}") from err
    except URLError as err:
        raise RuntimeError(f"Ollama host unreachable: {err.reason}") from err
    try:
        data = json.loads(response_data)
    except json.JSONDecodeError as err:
        raise RuntimeError(f"Invalid Ollama response: {err}") from err
    model_name = str(data.get("model", model))
    message = data.get("message") or {}
    content = message.get("content")
    if not isinstance(content, str):
        raise RuntimeError("Ollama response missing assistant content")
    return model_name, content.strip()


def parse_header_ids(response_text: str) -> List[int]:
    match = re.search(r"\{.*\}", response_text, re.DOTALL)
    candidate = match.group(0) if match else response_text
    try:
        data = json.loads(candidate)
    except json.JSONDecodeError as err:
        raise RuntimeError(f"Assistant response must be JSON: {err}") from err
    ids = data.get("header_token_ids")
    if not isinstance(ids, list):
        raise RuntimeError("Assistant JSON missing 'header_token_ids' list")
    result: List[int] = []
    for value in ids:
        try:
            result.append(int(value))
        except (TypeError, ValueError):
            continue
    return result


def fallback_header_tokens(tokens: Sequence[Token]) -> List[Token]:
    keywords = [
        "pt",
        "kass",
        "commercial",
        "invoice",
        "ti",
        "bill",
        "subject",
        "date",
        "no",
        "our",
        "ref",
        "prima",
        "karya",
        "berjaya",
    ]
    hits = []
    for token in tokens:
        text = token.text.lower()
        if any(kw in text for kw in keywords):
            hits.append(token)
    if hits:
        return hits
    return list(tokens[: min(12, len(tokens))])


def compute_union_bbox(tokens: Sequence[Token]) -> List[float]:
    x0 = min(tok.x0 for tok in tokens)
    y0 = min(tok.y0 for tok in tokens)
    x1 = max(tok.x1 for tok in tokens)
    y1 = max(tok.y1 for tok in tokens)
    bbox = [x0, y0, x1, y1]
    return [max(0.0, min(1.0, float(coord))) for coord in bbox]


def build_output_json(bbox: Sequence[float], page: int, model_name: str, prompt: str) -> Dict[str, Any]:
    return {
        "schema_version": "s3.v3",
        "coords": {"normalized": True, "y_origin": "top"},
        "segments": [
            {
                "id": "header",
                "type": "region",
                "page": page,
                "bbox": [round(c, 6) for c in bbox],
                "label": "header",
            }
        ],
        "meta": {
            "stage": "segmenter",
            "model": model_name,
            "prompt": prompt,
        },
    }


def ensure_parent(path: Path) -> None:
    if not path.parent.exists():
        path.parent.mkdir(parents=True, exist_ok=True)


def write_overlay(source_pdf: Path, bbox: Sequence[float], dims: Optional[Tuple[float, float]]) -> Optional[Path]:
    if dims is None:
        return None
    width, height = dims
    x0, y0, x1, y1 = bbox
    rect_width = (x1 - x0) * width
    rect_height = (y1 - y0) * height
    if rect_width <= 0 or rect_height <= 0:
        return None
    abs_x0 = x0 * width
    abs_y0 = height - y1 * height

    content = (
        "q\n"
        "1 0 0 1 0 0 cm\n"
        "1 0 0 RG\n"
        f"{abs_x0:.2f} {abs_y0:.2f} {rect_width:.2f} {rect_height:.2f} re\n"
        "S\n"
        "Q\n"
    )
    content_bytes = content.encode("ascii")

    buffer = BytesIO()
    write = buffer.write
    write(b"%PDF-1.4\n")
    offsets: List[int] = []

    def add_object(object_number: int, body: bytes) -> None:
        offsets.append(buffer.tell())
        write(f"{object_number} 0 obj\n".encode("ascii"))
        write(body)
        if not body.endswith(b"\n"):
            write(b"\n")
        write(b"endobj\n")

    add_object(1, b"<< /Type /Catalog /Pages 2 0 R >>\n")
    add_object(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n")
    page_dict = f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.2f} {height:.2f}] /Contents 4 0 R >>\n"
    add_object(3, page_dict.encode("ascii"))
    contents_dict = f"<< /Length {len(content_bytes)} >>\nstream\n".encode("ascii") + content_bytes + b"endstream\n"
    add_object(4, contents_dict)

    xref_start = buffer.tell()
    write(b"xref\n")
    write(f"0 {len(offsets) + 1}\n".encode("ascii"))
    write(b"0000000000 65535 f \n")
    for offset in offsets:
        write(f"{offset:010d} 00000 n \n".encode("ascii"))
    write(b"trailer\n")
    write(f"<< /Size {len(offsets) + 1} /Root 1 0 R >>\n".encode("ascii"))
    write(b"startxref\n")
    write(f"{xref_start}\n".encode("ascii"))
    write(b"%%EOF\n")

    overlay_path = source_pdf.with_name(f"{source_pdf.stem}-overlay.pdf")
    ensure_parent(overlay_path)
    overlay_path.write_bytes(buffer.getvalue())
    return overlay_path


def main() -> None:
    args = parse_args()
    tokens, dims = load_tokens(args.tokens, args.page)
    top_tokens = select_top_tokens(tokens)
    snippet = build_prompt_snippet(top_tokens)
    system_prompt, user_prompt = build_prompts(snippet)

    model_name = args.model
    response_text: Optional[str] = None
    header_ids: List[int] = []
    try:
        model_name, response_text = call_ollama(args.host, args.model, system_prompt, user_prompt)
        header_ids = parse_header_ids(response_text)
    except Exception as exc:  # noqa: BLE001
        print(f"Warning: Ollama call failed ({exc}). Falling back to heuristics.", file=sys.stderr)

    token_by_id = {token.token_id: token for token in tokens}
    header_tokens: List[Token] = [token_by_id[token_id] for token_id in header_ids if token_id in token_by_id]

    if not header_tokens:
        header_tokens = fallback_header_tokens(top_tokens)

    subject_tokens = [tok for tok in top_tokens if 'subject' in tok.text.lower()]
    if subject_tokens:
        seen = {tok.token_id for tok in header_tokens}
        for tok in subject_tokens:
            if tok.token_id not in seen:
                header_tokens.append(tok)
                seen.add(tok.token_id)

    bbox = compute_union_bbox(header_tokens)
    prompt_record = user_prompt.strip()
    if len(prompt_record) > 2000:
        prompt_record = prompt_record[:1997] + "..."

    output_payload = build_output_json(bbox, args.page, model_name, prompt_record)
    ensure_parent(args.out)
    with args.out.open("w", encoding="utf-8") as fh:
        json.dump(output_payload, fh, indent=2)
        fh.write("\n")

    overlay_path: Optional[Path] = None
    if args.overlay:
        try:
            overlay_path = write_overlay(args.overlay, bbox, dims)
        except Exception as exc:  # noqa: BLE001
            print(f"Warning: failed to write overlay ({exc})", file=sys.stderr)

    bbox_str = ", ".join(f"{value:.4f}" for value in bbox)
    summary = f"header bbox [{bbox_str}] -> {args.out}"
    if overlay_path:
        summary += f"; overlay {overlay_path}"
    print(summary)


if __name__ == "__main__":
    main()
