#!/usr/bin/env python3
"""
pdf2json.py — Config-driven CLI wrapper around the processor pipeline.

Uses a pipeline JSON (e.g., services/config/invoice_pt_simon.json) to run the
pipeline and writes artifacts to the provided output directory.
"""
import argparse
import json
import os
import zipfile
import io as pyio
from pathlib import Path

from processor import (
    process_pdf_from_pipeline_config_with_artifacts,
)


def main() -> None:
    ap = argparse.ArgumentParser(description="Run PDF → JSON using a pipeline config (data-driven)")
    ap.add_argument("--pdf", required=True, help="Path to input PDF")
    ap.add_argument("--out", required=True, help="Output directory to write artifacts")
    ap.add_argument("--template", "--pipeline", dest="pipeline", required=False,
                    help="Pipeline config filename (default: $PIPELINE_CONFIG or invoice_pt_simon.json)")
    ap.add_argument("--refs", action="store_true", help="Include _refs in the final JSON")
    args = ap.parse_args()

    pdf_path = Path(args.pdf).resolve()
    if not pdf_path.exists():
        raise SystemExit(f"PDF not found: {pdf_path}")

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    pipeline = args.pipeline or os.getenv("PIPELINE_CONFIG") or os.getenv("DEFAULT_PIPELINE") or "invoice_pt_simon.json"

    final_doc, zip_bytes = process_pdf_from_pipeline_config_with_artifacts(pdf_path.read_bytes(), pdf_path.stem, pipeline, include_refs=args.refs)

    # Extract artifacts into out_dir
    with zipfile.ZipFile(pyio.BytesIO(zip_bytes), 'r') as zf:
        zf.extractall(out_dir)

    # Write final.json for convenience
    final_path = out_dir / "11-final.json"
    final_path.write_text(json.dumps(final_doc, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"out": str(out_dir), "final": str(final_path), "pipeline": pipeline}, ensure_ascii=False))


if __name__ == "__main__":
    main()
