#!/usr/bin/env python3
# Stage 2 — Light Per-Token Normalization
# Inputs : --in  /path/to/2508070002.tokens.json  (output from Stage 1)
# Outputs: --out /path/to/2508070002-normalized.json

from __future__ import annotations
import argparse
import json
import sys
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional

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


def _normalize_tokens(tokens: List[Dict[str, Any]]) -> int:
    changed = 0
    for tok in tokens:
        raw = tok.get("text", "")
        norm = normalize_token_text(raw)
        tok["norm"] = norm
        if norm != raw:
            changed += 1
    return changed

def run(in_path: Path, out_path: Path) -> Dict[str, Any]:
    with in_path.open("r", encoding="utf-8") as f:
        data: Dict[str, Any] = json.load(f)

    engine_keys: List[str] = []
    engines: Dict[str, Dict[str, Any]] = {}
    for key, value in data.items():
        if isinstance(value, dict) and isinstance(value.get("tokens"), list):
            engine_keys.append(key)
            engines[key] = value

    legacy_tokens: Optional[List[Dict[str, Any]]] = None
    if not engine_keys and isinstance(data.get("tokens"), list):
        legacy_tokens = data["tokens"]  # legacy single-engine shape

    if not engine_keys and legacy_tokens is None:
        print(
            "No tokens found: expected engine blocks with tokens or root tokens list.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    engine_stats: Dict[str, Dict[str, int]] = {}

    for name in engine_keys:
        engine_data = engines[name]
        tokens = engine_data.get("tokens", [])
        if not isinstance(tokens, list):
            tokens = []
            engine_data["tokens"] = tokens
        changed = _normalize_tokens(tokens)
        engine_data["token_count"] = len(tokens)
        engine_stats[name] = {"tokens": len(tokens), "changed": changed}

    if legacy_tokens is not None:
        legacy_changed = _normalize_tokens(legacy_tokens)
        engine_stats["legacy"] = {
            "tokens": len(legacy_tokens),
            "changed": legacy_changed,
        }

    out: Dict[str, Any] = {}
    for key, value in data.items():
        if key in {"stage", "version", "notes"}:
            continue
        if engine_keys and key in engines:
            out[key] = value
            continue
        if legacy_tokens is not None and key == "tokens":
            out[key] = value
            continue
        if key not in engines:
            out[key] = value

    out["stage"] = "normalizer_mv"
    out["version"] = "2.0"
    out["notes"] = "Text normalized per engine; geometry and IDs unchanged."

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    summary = {
        "stage": out["stage"],
        "doc_id": out.get("doc_id"),
        "engines": engine_stats,
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
