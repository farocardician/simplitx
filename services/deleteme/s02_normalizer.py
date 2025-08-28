#!/usr/bin/env python3
# Stage 2 — Light Per-Token Normalization
# Inputs : --in  /path/to/2508070002.tokens.json  (output from Stage 1)
# Outputs: --out /path/to/2508070002-normalized.json

from __future__ import annotations
import argparse
import json
import unicodedata
from pathlib import Path
from typing import Dict, Any, List

# Map a few visually-similar punctuation marks to ASCII for stability
PUNCT_MAP = {
    "\u2018": "'", "\u2019": "'", "\u201B": "'",
    "\u201C": '"', "\u201D": '"',
    "\u2013": "-", "\u2014": "-", "\u2212": "-",  # en/em/fraction minus
    "\u00B7": ".", "\u2027": ".",                 # middle dot variants
}

SPACE_CHARS = {
    "\u00A0",  # NBSP
    "\u2007",  # Figure space
    "\u202F",  # Narrow NBSP
    "\u2009",  # Thin space
    "\u2008",  # Punctuation space
    "\u200A",  # Hair space
}

ZERO_WIDTH = {"\u200B", "\u200C", "\u200D", "\uFEFF"}  # ZWSP/ZWNJ/ZWJ/BOM

def normalize_token_text(text: str) -> str:
    # 1) Unicode compatibility normalization (stable across runs)
    t = unicodedata.normalize("NFKC", text)

    # 2) Remove zero-width characters
    for z in ZERO_WIDTH:
        t = t.replace(z, "")

    # 3) Normalize odd space characters to regular space
    for s in SPACE_CHARS:
        t = t.replace(s, " ")

    # 4) Map curly quotes/dashes/etc. to ASCII
    t = "".join(PUNCT_MAP.get(ch, ch) for ch in t)

    # 5) Collapse internal multiple spaces (rare for word tokens) and trim
    t = " ".join(t.split())

    return t

def run(in_path: Path, out_path: Path) -> Dict[str, Any]:
    with in_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    tokens: List[Dict[str, Any]] = data.get("tokens", [])
    changed = 0

    # Preserve order and IDs; add "norm" alongside original "text"
    for tok in tokens:
        raw = tok.get("text", "")
        norm = normalize_token_text(raw)
        tok["norm"] = norm
        if norm != raw:
            changed += 1

    out = {
        "doc_id": data.get("doc_id"),
        "page_count": data.get("page_count"),
        "pages": data.get("pages"),
        "tokens": tokens,
        "stage": "normalizer",
        "version": "1.0",
        "notes": "Light per-token normalization only; geometry and IDs unchanged.",
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    # Short summary for quick inspection
    summary = {
        "stage": "normalizer",
        "doc_id": out["doc_id"],
        "page_count": out["page_count"],
        "token_count": len(tokens),
        "changed_count": changed,
        "in": str(in_path),
        "out": str(out_path),
    }
    print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))
    return summary

def main() -> None:
    ap = argparse.ArgumentParser(description="Stage 2 — Light Per-Token Normalization")
    ap.add_argument("--in", dest="inp", required=True, help="Path to Stage 1 tokens.json")
    ap.add_argument("--out", dest="out", required=True, help="Path to write normalized.json")
    args = ap.parse_args()

    in_path = Path(args.inp).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()
    run(in_path, out_path)

if __name__ == "__main__":
    main()
