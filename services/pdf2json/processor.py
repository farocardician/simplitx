"""
PDF Processing Pipeline

Extracted from pdf2json.py to be used as a reusable function
for FastAPI service integration.
"""

import io
import json
import shlex
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Tuple


def log_cmd(cmd: list[str]) -> None:
    """Log command before execution"""
    print("$ " + shlex.join(cmd), flush=True)


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    """Run a command, echo it, stream outputs on error, return process."""
    log_cmd(cmd)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.stdout:
        print(proc.stdout.strip(), flush=True)
    if proc.returncode != 0:
        if proc.stderr:
            print(proc.stderr.strip(), file=sys.stderr, flush=True)
        raise RuntimeError(f"Command failed ({proc.returncode}): {cmd[0]}")
    return proc


def ensure_dir(path: Path) -> None:
    """Ensure parent directory exists"""
    path.parent.mkdir(parents=True, exist_ok=True)


def strip_refs(obj: Any) -> Any:
    """Recursively remove any '_refs' keys from dicts/lists."""
    if isinstance(obj, dict):
        return {k: strip_refs(v) for k, v in obj.items() if k != "_refs"}
    if isinstance(obj, list):
        return [strip_refs(v) for v in obj]
    return obj


def process_pdf(pdf_bytes: bytes, doc_id: str, include_refs: bool = False) -> Dict[str, Any]:
    """
    Process a PDF through the 10-stage pipeline and return JSON result.
    
    Args:
        pdf_bytes: PDF file content as bytes
        doc_id: Document ID (typically filename stem)
        include_refs: Whether to include _refs in output
        
    Returns:
        Dict containing the processed JSON result
        
    Raises:
        RuntimeError: If any stage fails
    """
    python_exec = sys.executable
    stages_dir = Path(__file__).resolve().parent / "stages"
    
    # Create temporary directory for processing
    with tempfile.TemporaryDirectory(prefix=f"pdf_process_{doc_id}_") as temp_dir:
        temp_path = Path(temp_dir)
        
        # Write PDF to temporary file
        pdf_path = temp_path / f"{doc_id}.pdf"
        pdf_path.write_bytes(pdf_bytes)
        
        # Output file layout
        out_root = temp_path / "output"
        out_root.mkdir(parents=True, exist_ok=True)
        
        tokens_fp = out_root / "tokenizer" / f"{doc_id}.tokens.json"
        normalized_fp = out_root / "normalize" / f"{doc_id}-normalized.json"
        segments_fp = out_root / "segment" / f"{doc_id}-segmentized.json"
        cells_raw_fp = out_root / "cells" / f"{doc_id}-cells.json"
        cells_norm_fp = out_root / "cells" / f"{doc_id}-cells_normalized.json"
        items_fp = out_root / "items" / f"{doc_id}-items.json"
        fields_fp = out_root / "fields" / f"{doc_id}-fields.json"
        validate_dir = out_root / "validate"
        validation_fp = validate_dir / f"{doc_id}-validation.json"
        confidence_fp = validate_dir / f"{doc_id}-confidence.json"
        manifest_fp = out_root / "manifest" / f"{doc_id}-manifest.json"
        final_fp = out_root / "final" / f"{doc_id}.json"
        
        try:
            # Stage 1: tokenizer
            ensure_dir(tokens_fp)
            run([
                python_exec, str(stages_dir / "s01_tokenizer.py"),
                "--in", str(pdf_path),
                "--out", str(tokens_fp),
            ])
            
            # Stage 2: normalizer
            ensure_dir(normalized_fp)
            run([
                python_exec, str(stages_dir / "s02_normalizer.py"),
                "--in", str(tokens_fp),
                "--out", str(normalized_fp),
            ])
            
            # Stage 3: segmenter
            ensure_dir(segments_fp)
            run([
                python_exec, str(stages_dir / "s03_segmenter.py"),
                "--in", str(normalized_fp),
                "--pdf", str(pdf_path),
                "--out", str(segments_fp),
            ])
            
            # Stage 4: camelot_grid
            ensure_dir(cells_raw_fp)
            config_path = stages_dir.parent / "config" / "invoice_simon_v15.json"
            run([
                python_exec, str(stages_dir / "s04_camelot_grid_configV12.py"),
                "--pdf", str(pdf_path),
                "--tokens", str(normalized_fp),
                "--out", str(cells_raw_fp),
                "--config", str(config_path),
            ])
            
            # Stage 5: normalize_cells
            ensure_dir(cells_norm_fp)
            run([
                python_exec, str(stages_dir / "s05_normalize_cells.py"),
                "--in", str(cells_raw_fp),
                "--out", str(cells_norm_fp),
            ])
            
            # Stage 6: line_items_from_cells
            ensure_dir(items_fp)
            run([
                python_exec, str(stages_dir / "s06_line_items_from_cellsV2.py"),
                "--cells", str(cells_norm_fp),
                "--out", str(items_fp),
                "--config", str(config_path),
            ])
            
            # Stage 7: extractor (fields)
            ensure_dir(fields_fp)
            run([
                python_exec, str(stages_dir / "s07_extractorV2.py"),
                "--cells", str(cells_norm_fp),
                "--items", str(items_fp),
                "--out", str(fields_fp),
                "--config", str(config_path),
            ])
            
            # Stage 8: validator
            ensure_dir(validation_fp)
            run([
                python_exec, str(stages_dir / "s08_validator.py"),
                "--fields", str(fields_fp),
                "--items", str(items_fp),
                "--out", str(validation_fp),
            ])
            
            # Stage 9: confidence
            ensure_dir(confidence_fp)
            run([
                python_exec, str(stages_dir / "s09_confidence.py"),
                "--fields", str(fields_fp),
                "--items", str(items_fp),
                "--validation", str(validation_fp),
                "--out", str(confidence_fp),
            ])
            
            # Create manifest for parser
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
            
            # Stage 10: parser (final)
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
            
            # Read and return final result
            with open(final_fp, "r", encoding="utf-8") as f:
                final_doc = json.load(f)
            
            # Optionally remove _refs
            if not include_refs:
                final_doc = strip_refs(final_doc)
            
            return final_doc
            
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"Pipeline stage failed: {e}")
        except Exception as e:
            raise RuntimeError(f"Processing failed: {e}")


def process_pdf_with_artifacts(pdf_bytes: bytes, doc_id: str, include_refs: bool = False) -> Tuple[Dict[str, Any], bytes]:
    """
    Process a PDF through the 10-stage pipeline and return both JSON result and artifacts ZIP.
    
    Args:
        pdf_bytes: PDF file content as bytes
        doc_id: Document ID (typically filename stem)
        include_refs: Whether to include _refs in output
        
    Returns:
        Tuple of (JSON result dict, ZIP bytes containing stage artifacts)
        
    Raises:
        RuntimeError: If any stage fails
    """
    python_exec = sys.executable
    stages_dir = Path(__file__).resolve().parent / "stages"
    
    # Create temporary directory for processing
    with tempfile.TemporaryDirectory(prefix=f"pdf_process_{doc_id}_") as temp_dir:
        temp_path = Path(temp_dir)
        
        # Write PDF to temporary file
        pdf_path = temp_path / f"{doc_id}.pdf"
        pdf_path.write_bytes(pdf_bytes)
        
        # Output file layout
        out_root = temp_path / "output"
        out_root.mkdir(parents=True, exist_ok=True)
        
        tokens_fp = out_root / "tokenizer" / f"{doc_id}.tokens.json"
        normalized_fp = out_root / "normalize" / f"{doc_id}-normalized.json"
        segments_fp = out_root / "segment" / f"{doc_id}-segmentized.json"
        cells_raw_fp = out_root / "cells" / f"{doc_id}-cells.json"
        cells_norm_fp = out_root / "cells" / f"{doc_id}-cells_normalized.json"
        items_fp = out_root / "items" / f"{doc_id}-items.json"
        fields_fp = out_root / "fields" / f"{doc_id}-fields.json"
        validate_dir = out_root / "validate"
        validation_fp = validate_dir / f"{doc_id}-validation.json"
        confidence_fp = validate_dir / f"{doc_id}-confidence.json"
        manifest_fp = out_root / "manifest" / f"{doc_id}-manifest.json"
        final_fp = out_root / "final" / f"{doc_id}.json"
        
        try:
            # Stage 1: tokenizer
            ensure_dir(tokens_fp)
            run([
                python_exec, str(stages_dir / "s01_tokenizer.py"),
                "--in", str(pdf_path),
                "--out", str(tokens_fp),
            ])
            
            # Stage 2: normalizer
            ensure_dir(normalized_fp)
            run([
                python_exec, str(stages_dir / "s02_normalizer.py"),
                "--in", str(tokens_fp),
                "--out", str(normalized_fp),
            ])
            
            # Stage 3: segmenter
            ensure_dir(segments_fp)
            run([
                python_exec, str(stages_dir / "s03_segmenter.py"),
                "--in", str(normalized_fp),
                "--pdf", str(pdf_path),
                "--out", str(segments_fp),
            ])
            
            # Stage 4: camelot_grid
            ensure_dir(cells_raw_fp)
            config_path = stages_dir.parent / "config" / "invoice_simon_v15.json"
            run([
                python_exec, str(stages_dir / "s04_camelot_grid_configV12.py"),
                "--pdf", str(pdf_path),
                "--tokens", str(normalized_fp),
                "--out", str(cells_raw_fp),
                "--config", str(config_path),
            ])
            
            # Stage 5: normalize_cells
            ensure_dir(cells_norm_fp)
            run([
                python_exec, str(stages_dir / "s05_normalize_cells.py"),
                "--in", str(cells_raw_fp),
                "--out", str(cells_norm_fp),
            ])
            
            # Stage 6: line_items_from_cells
            ensure_dir(items_fp)
            run([
                python_exec, str(stages_dir / "s06_line_items_from_cellsV2.py"),
                "--cells", str(cells_norm_fp),
                "--out", str(items_fp),
                "--config", str(config_path),
            ])
            
            # Stage 7: extractor (fields)
            ensure_dir(fields_fp)
            run([
                python_exec, str(stages_dir / "s07_extractorV2.py"),
                "--cells", str(cells_norm_fp),
                "--items", str(items_fp),
                "--out", str(fields_fp),
                "--config", str(config_path),
            ])
            
            # Stage 8: validator
            ensure_dir(validation_fp)
            run([
                python_exec, str(stages_dir / "s08_validator.py"),
                "--fields", str(fields_fp),
                "--items", str(items_fp),
                "--out", str(validation_fp),
            ])
            
            # Stage 9: confidence
            ensure_dir(confidence_fp)
            run([
                python_exec, str(stages_dir / "s09_confidence.py"),
                "--fields", str(fields_fp),
                "--items", str(items_fp),
                "--validation", str(validation_fp),
                "--out", str(confidence_fp),
            ])
            
            # Create manifest for parser
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
            
            # Stage 10: parser (final)
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
            
            # Read final result
            with open(final_fp, "r", encoding="utf-8") as f:
                final_doc = json.load(f)
            
            # Optionally remove _refs
            if not include_refs:
                final_doc = strip_refs(final_doc)
            
            # Create artifacts ZIP
            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
                # Add all stage files to the ZIP
                stage_files = [
                    (tokens_fp, "01-tokens.json"),
                    (normalized_fp, "02-normalized.json"),
                    (segments_fp, "03-segments.json"),
                    (cells_raw_fp, "04-cells-raw.json"),
                    (cells_norm_fp, "05-cells-normalized.json"),
                    (items_fp, "06-items.json"),
                    (fields_fp, "07-fields.json"),
                    (validation_fp, "08-validation.json"),
                    (confidence_fp, "09-confidence.json"),
                    (manifest_fp, "10-manifest.json"),
                    (final_fp, "11-final.json")
                ]
                
                for file_path, archive_name in stage_files:
                    if file_path.exists():
                        zip_file.write(file_path, archive_name)
            
            zip_bytes = zip_buffer.getvalue()
            zip_buffer.close()
            
            return final_doc, zip_bytes
            
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"Pipeline stage failed: {e}")
        except Exception as e:
            raise RuntimeError(f"Processing failed: {e}")


# For testing purposes
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Test PDF processor")
    parser.add_argument("--pdf", required=True, help="PDF file path")
    parser.add_argument("--refs", action="store_true", help="Include refs in output")
    args = parser.parse_args()
    
    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        raise SystemExit(f"PDF not found: {pdf_path}")
    
    pdf_bytes = pdf_path.read_bytes()
    doc_id = pdf_path.stem
    
    result = process_pdf(pdf_bytes, doc_id, include_refs=args.refs)
    print(json.dumps(result, ensure_ascii=False, indent=2))