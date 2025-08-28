#!/usr/bin/env python3
# Stage 1 — PDF Tokenization
# Deterministic, geometry-first word tokens with normalized [0..1] bboxes.
# Inputs : --in  /path/to/invoice.pdf
# Outputs: --out /path/to/tokens.json

from __future__ import annotations
import argparse
import json
from pathlib import Path
from typing import Dict, List, Any
import pdfplumber

def _norm(v: float, denom: float) -> float:
    return float(v) / float(denom) if denom else 0.0

def tokenize(pdf_path: Path) -> Dict[str, Any]:
    # Open and extract words (pdfplumber groups chars into words deterministically)
    doc_id = pdf_path.name
    tokens: List[Dict[str, Any]] = []
    page_summaries: List[Dict[str, Any]] = []

    with pdfplumber.open(str(pdf_path)) as pdf:
        for pidx, page in enumerate(pdf.pages):
            W = float(page.width)
            H = float(page.height)

            # pdfplumber.extract_words yields dicts with x0, x1, top, bottom, text
            # We avoid any text normalization here; Stage 2 handles that.
            words = page.extract_words(
                use_text_flow=True,            # stable grouping by flow
                keep_blank_chars=False,        # tokens are words, not whitespace
                extra_attrs=[],
            )

            # Stable, deterministic per-page sort by (top, x0)
            words.sort(key=lambda w: (w["top"], w["x0"], w["x1"]))

            for w in words:
                x0 = float(w["x0"])
                x1 = float(w["x1"])
                top = float(w["top"])
                bottom = float(w["bottom"])
                tokens.append({
                    # assigned later: id
                    "page": pidx + 1,  # 1-based page index
                    "text": w["text"],

                    # absolute PDF space (for debugging/traceability)
                    "abs_bbox": {
                        "x0": x0, "y0": top, "x1": x1, "y1": bottom,
                        "width": W, "height": H
                    },

                    # normalized bbox [0..1] with y increasing downward
                    "bbox": {
                        "x0": _norm(x0, W),
                        "y0": _norm(top, H),
                        "x1": _norm(x1, W),
                        "y1": _norm(bottom, H),
                    },
                })

            page_summaries.append({
                "page": pidx + 1,
                "width": W,
                "height": H,
                "token_count": len(words),
            })

    # Global deterministic ordering: (page, y0, x0)
    tokens.sort(key=lambda t: (t["page"], t["bbox"]["y0"], t["bbox"]["x0"]))

    # Deterministic sequential IDs
    for i, t in enumerate(tokens, start=1):
        t["id"] = i

    return {
        "doc_id": doc_id,
        "page_count": len(page_summaries),
        "pages": page_summaries,
        "tokens": tokens,
        "stage": "tokenizer",
        "version": "1.0",
        "notes": "Raw tokens only. No text normalization; positions unchanged.",
    }

def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 1 — PDF Tokenizer")
    ap.add_argument("--in", dest="inp", required=True, help="Path to input PDF")
    ap.add_argument("--out", dest="out", required=True, help="Path to output tokens.json")
    args = ap.parse_args()

    pdf_path = Path(args.inp).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    data = tokenize(pdf_path)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    # Short deterministic summary for quick inspection
    print(json.dumps({
        "stage": "tokenizer",
        "doc_id": data["doc_id"],
        "page_count": data["page_count"],
        "token_count": len(data["tokens"]),
        "out": str(out_path),
    }, separators=(",", ":"), ensure_ascii=False))

if __name__ == "__main__":
    main()

