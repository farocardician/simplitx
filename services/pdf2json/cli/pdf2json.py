#!/usr/bin/env python3
"""
pdf2json.py — Orchestrate the invoice pipeline (no diff)

Stage order (as requested):
  1) tokenizer.py            (PDF -> tokens.json)
  2) normalizer.py           (tokens.json -> normalized.json)
  3) segmenter.py            (normalized.json + PDF -> segmentized.json)
  4) camelot_grid.py         (PDF + normalized.json -> cells.json)
  5) normalize_cells.py      (cells.json -> cells_normalized.json)
  6) line_items_from_cells.py(cells_normalized.json -> items.json)
  7) extractor.py            (cells_normalized + items -> fields.json)
  8) validator.py            (fields + items -> validation.json)
  9) confidence.py           (validation -> confidence.json)
 10) parser.py               (assemble final.json + manifest.json)

"""
import argparse
import json
import os
import shlex
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, List


# ---------- helpers ----------
def log_cmd(cmd: List[str]) -> None:
    print("$ " + shlex.join(cmd), flush=True)


def run(cmd: List[str]) -> subprocess.CompletedProcess:
    """Run a command, echo it, stream outputs on error, return process."""
    log_cmd(cmd)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.stdout:
        print(proc.stdout.strip(), flush=True)
    if proc.returncode != 0:
        if proc.stderr:
            print(proc.stderr.strip(), file=sys.stderr, flush=True)
        raise SystemExit(f"Command failed ({proc.returncode}): {cmd[0]}")
    return proc


def ensure_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def strip_refs(obj: Any) -> Any:
    """Recursively remove any '_refs' keys from dicts/lists."""
    if isinstance(obj, dict):
        return {k: strip_refs(v) for k, v in obj.items() if k != "_refs"}
    if isinstance(obj, list):
        return [strip_refs(v) for v in obj]
    return obj


# ---------- main ----------
def main():
    ap = argparse.ArgumentParser(
        description=(
            "Orchestrate PDF → JSON pipeline (no diff). "
            "Stages: tokenizer → normalizer → segmenter → camelot_grid → "
            "normalize_cells → line_items_from_cells → extractor → "
            "validator → confidence → parser"
        )
    )
    ap.add_argument("--pdf", required=True, help="Path to input PDF")
    ap.add_argument("--out", required=True, help="Output directory (root)")
    ap.add_argument("--force", action="store_true",
                    help="Re-run all stages even if outputs already exist")
    ap.add_argument("--refs", action="store_true",
                    help="Include `_refs` blocks in the final JSON (default: omit)")
    args = ap.parse_args()

    python_exec = sys.executable
    stages_dir = Path(__file__).resolve().parents[1] / "stages"
    
    pdf_path = Path(args.pdf).resolve()
    if not pdf_path.exists():
        raise SystemExit(f"PDF not found: {pdf_path}")

    out_root = Path(args.out).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    doc_id = pdf_path.stem  # e.g. "2502120006"

    # Output file layout
    tokens_fp         = out_root / "tokenizer" / f"{doc_id}.tokens.json"
    normalized_fp     = out_root / "normalize" / f"{doc_id}-normalized.json"
    segments_fp       = out_root / "segment"   / f"{doc_id}-segmentized.json"
    cells_raw_fp      = out_root / "cells"     / f"{doc_id}-cells.json"
    cells_norm_fp     = out_root / "cells"     / f"{doc_id}-cells_normalized.json"
    items_fp          = out_root / "items"     / f"{doc_id}-items.json"
    fields_fp         = out_root / "fields"    / f"{doc_id}-fields.json"
    validate_dir      = out_root / "validate"
    validation_fp     = validate_dir / f"{doc_id}-validation.json"
    confidence_fp     = validate_dir / f"{doc_id}-confidence.json"
    manifest_fp       = out_root / "manifest"  / f"{doc_id}-manifest.json"
    final_fp          = out_root / "final"     / f"{doc_id}.json"

    # ---------- Stage 1: tokenizer ----------
    if args.force or not tokens_fp.exists():
        ensure_dir(tokens_fp)
        run([
            python_exec, str(stages_dir / "s01_tokenizer.py"),
            "--in", str(pdf_path),
            "--out", str(tokens_fp),
        ])

    # ---------- Stage 2: normalizer ----------
    if args.force or not normalized_fp.exists():
        ensure_dir(normalized_fp)
        run([
            python_exec, str(stages_dir / "s02_normalizer.py"),
            "--in", str(tokens_fp),
            "--out", str(normalized_fp),
        ])

    # ---------- Stage 3: segmenter ----------
    if args.force or not segments_fp.exists():
        ensure_dir(segments_fp)
        run([
            python_exec, str(stages_dir / "s03_segmenter.py"),
            "--in", str(normalized_fp),
            "--pdf", str(pdf_path),
            "--out", str(segments_fp),
        ])

    # ---------- Stage 4: camelot_grid ----------
    if args.force or not cells_raw_fp.exists():
        ensure_dir(cells_raw_fp)
        config_path = stages_dir.parent / "config" / "invoice_simon_v15.json"
        run([
            python_exec, str(stages_dir / "s04_camelot_grid_configV12.py"),
            "--pdf", str(pdf_path),
            "--tokens", str(normalized_fp),
            "--out", str(cells_raw_fp),
            "--config", str(config_path),
        ])

    # ---------- Stage 5: normalize_cells ----------
    if args.force or not cells_norm_fp.exists():
        ensure_dir(cells_norm_fp)
        run([
            python_exec, str(stages_dir / "s05_normalize_cells.py"),
            "--in", str(cells_raw_fp),
            "--out", str(cells_norm_fp),
        ])

    # ---------- Stage 6: line_items_from_cells ----------
    if args.force or not items_fp.exists():
        ensure_dir(items_fp)
        run([
            python_exec, str(stages_dir / "s06_line_items_from_cellsV2.py"),
            "--cells", str(cells_norm_fp),
            "--out", str(items_fp),
            "--config", str(config_path),
        ])

    # ---------- Stage 7: extractor (fields) ----------
    if args.force or not fields_fp.exists():
        ensure_dir(fields_fp)
        run([
            python_exec, str(stages_dir / "s07_extractor.py"),
            "--cells", str(cells_norm_fp),
            "--items", str(items_fp),
            "--out", str(fields_fp),
        ])

    # ---------- Stage 8: validator (no --cells here) ----------
    if args.force or not validation_fp.exists():
        ensure_dir(validation_fp)
        run([
            python_exec, str(stages_dir / "s08_validator.py"),
            "--fields", str(fields_fp),
            "--items", str(items_fp),
            "--out", str(validation_fp),
        ])

    # ---------- Stage 9: confidence ----------
    if args.force or not confidence_fp.exists():
        ensure_dir(confidence_fp)
        run([
            python_exec, str(stages_dir / "s09_confidence.py"),
            "--fields", str(fields_fp),
            "--items", str(items_fp),
            "--validation", str(validation_fp),
            "--out", str(confidence_fp),
        ])

    # ---------- Manifest for parser ----------
    if args.force or not manifest_fp.exists():
        ensure_dir(manifest_fp)
        manifest = {
            "doc_id": doc_id,
            "created_at": datetime.utcnow().isoformat() + "Z",
            "inputs": {
                "pdf": str(pdf_path),
                "tokens": str(tokens_fp),
                "normalized": str(normalized_fp),
                "segments": str(segments_fp),
                "cells": str(cells_norm_fp),
                "items": str(items_fp),
                "fields": str(fields_fp),
                "validation": str(validation_fp),
                "confidence": str(confidence_fp),
            },
            "outputs": {"final": str(final_fp)},
            "version": "1.0",
        }
        with open(manifest_fp, "w", encoding="utf-8") as mf:
            json.dump(manifest, mf, ensure_ascii=False, indent=2)

    # ---------- Stage 10: parser (final) ----------
    ensure_dir(final_fp)
    run([
        python_exec, str(stages_dir / "s10_parser.py"),
        "--fields", str(fields_fp),
        "--items", str(items_fp),
        "--validation", str(validation_fp),
        "--confidence", str(confidence_fp),
        "--cells", str(cells_norm_fp),
        "--final", str(final_fp),
        "--manifest", str(manifest_fp),
    ])

    # ---------- Post-process: optionally remove `_refs` ----------
    try:
        with open(final_fp, "r", encoding="utf-8") as f:
            final_doc = json.load(f)
    except Exception as e:
        raise SystemExit(f"Could not read final JSON: {final_fp}\n{e}")

    if not args.refs:
        final_doc = strip_refs(final_doc)
        with open(final_fp, "w", encoding="utf-8") as f:
            json.dump(final_doc, f, ensure_ascii=False, indent=2)

    # Echo result for convenience
    print(json.dumps(final_doc, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
