"""
PDF Processing Pipeline (config‑driven)

This module exposes a fully config‑driven runner. All public entry points
delegate to the JSON pipeline definition (e.g., services/config/invoice_pt_simon.json).
Hardcoded stage orders are avoided so the pipeline file is the single source of truth.
"""

import io
import json
import os
import shlex
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Tuple, List, Optional


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
    """Config‑driven wrapper: run using pipeline JSON (env: PIPELINE_CONFIG/DEFAULT_PIPELINE)."""
    pipeline = os.getenv("PIPELINE_CONFIG") or os.getenv("DEFAULT_PIPELINE") or "invoice_pt_simon.json"
    return process_pdf_from_pipeline_config(pdf_bytes, doc_id, pipeline, include_refs=include_refs)


def process_pdf_with_artifacts(pdf_bytes: bytes, doc_id: str, include_refs: bool = False) -> Tuple[Dict[str, Any], bytes]:
    """Config‑driven wrapper: run using pipeline JSON and return (final_json, zip_bytes)."""
    pipeline = os.getenv("PIPELINE_CONFIG") or os.getenv("DEFAULT_PIPELINE") or "invoice_pt_simon.json"
    return process_pdf_from_pipeline_config_with_artifacts(pdf_bytes, doc_id, pipeline, include_refs=include_refs)


# For testing purposes (config‑driven CLI)
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run PDF → JSON with a pipeline config")
    parser.add_argument("--pdf", required=True, help="PDF file path")
    parser.add_argument("--config", "--pipeline", dest="pipeline", required=False,
                        help="Pipeline config JSON filename (e.g., invoice_pt_simon.json). Defaults to $PIPELINE_CONFIG or invoice_pt_simon.json")
    parser.add_argument("--refs", action="store_true", help="Include refs in output")
    parser.add_argument("--artifacts", action="store_true", help="Also produce artifacts ZIP (discarded in CLI)")
    args = parser.parse_args()

    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        raise SystemExit(f"PDF not found: {pdf_path}")

    pdf_bytes = pdf_path.read_bytes()
    doc_id = pdf_path.stem
    pipeline = args.pipeline or os.getenv("PIPELINE_CONFIG") or os.getenv("DEFAULT_PIPELINE") or "invoice_pt_simon.json"

    if args.artifacts:
        result, _zip = process_pdf_from_pipeline_config_with_artifacts(pdf_bytes, doc_id, pipeline, include_refs=args.refs)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        result = process_pdf_from_pipeline_config(pdf_bytes, doc_id, pipeline, include_refs=args.refs)
        print(json.dumps(result, ensure_ascii=False, indent=2))


# -------------------------- Config-driven runner (V2) --------------------------

def _find_pipeline_config(config_filename: str) -> Path:
    """Locate a pipeline config file by name across known directories.

    Search order:
    - $CONFIG_DIR (if set)
    - services/config (sibling to pdf2json service)
    - local config directory (services/pdf2json/config)
    """
    name = Path(config_filename).name

    # Candidate directories
    here = Path(__file__).resolve()
    pdf2json_dir = here.parent
    services_dir = pdf2json_dir.parent

    candidates: List[Path] = []
    env_dir = os.getenv("CONFIG_DIR")
    if env_dir:
        candidates.append(Path(env_dir))
    # services/config (pipeline-level configs)
    candidates.append(services_dir / "config")
    # fallback to service-local config dir
    candidates.append(pdf2json_dir / "config")

    for base in candidates:
        p = (base / name)
        if p.exists():
            return p
    raise FileNotFoundError(f"Pipeline config not found: {name} in {', '.join(str(c) for c in candidates)}")


def process_pdf_from_pipeline_config(
    pdf_bytes: bytes,
    doc_id: str,
    pipeline_config_filename: str,
    include_refs: bool = False,
) -> Dict[str, Any]:
    """Run the 10-stage pipeline using a declarative pipeline config file.

    The config must contain a "stages" array with entries like:
      {"script": "s01_tokenizer.py"}
      {"script": "s03_segmenter.py", "config": "simon_segmenter_configV3.json"}
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

        # Load pipeline config
        cfg_path = _find_pipeline_config(pipeline_config_filename)
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                pipeline_cfg = json.load(f)
        except Exception as e:
            raise RuntimeError(f"Failed to read pipeline config '{cfg_path}': {e}")

        stages: List[Dict[str, Any]] = pipeline_cfg.get("stages") or []
        if not stages:
            raise RuntimeError("Pipeline config missing 'stages' array")

        # Helper to resolve a stage's config file (when present)
        def resolve_stage_config(name: Optional[str]) -> Optional[str]:
            if not name:
                return None
            local = stages_dir.parent / "config" / Path(name).name
            if local.exists():
                return str(local)
            svc = (stages_dir.parent.parent / "config" / Path(name).name)
            if svc.exists():
                return str(svc)
            return str(name)

        def placeholder_map() -> Dict[str, str]:
            common_words = stages_dir.parent / "common" / "common-words.json"
            return {
                "pdf": str(pdf_path),
                "tokens": str(tokens_fp),
                "normalized": str(normalized_fp),
                "segments": str(segments_fp),
                "cells_raw": str(cells_raw_fp),
                "cells": str(cells_norm_fp),
                "items": str(items_fp),
                "fields": str(fields_fp),
                "validation": str(validation_fp),
                "confidence": str(confidence_fp),
                "final": str(final_fp),
                "manifest": str(manifest_fp),
                "common_words": str(common_words) if common_words.exists() else "",
            }

        def format_args(args_tmpl: List[str], mapping: Dict[str, str]) -> List[str]:
            import re
            out: List[str] = []
            for token in args_tmpl:
                def repl(m):
                    key = m.group(1)
                    if key not in mapping:
                        raise RuntimeError(f"Unknown placeholder '{{{key}}}' in args token: {token}")
                    return mapping[key]
                new_token = re.sub(r"\{([A-Za-z0-9_]+)\}", repl, token)
                out.append(new_token)
            return out

        try:
            for step in stages:
                script = step.get("script")
                if not script:
                    raise RuntimeError("Stage entry missing 'script'")
                args_tmpl = step.get("args")
                if not isinstance(args_tmpl, list) or not args_tmpl:
                    raise RuntimeError(f"Stage '{script}' missing non-empty 'args' array (data-driven mode)")
                script_path = stages_dir / script
                if not script_path.exists():
                    raise RuntimeError(f"Stage script not found: {script}")

                # Build placeholders
                mp = placeholder_map()
                stage_cfg_path = resolve_stage_config(step.get("config"))
                if stage_cfg_path:
                    mp["config"] = stage_cfg_path

                # Ensure output directories exist
                for k in ("tokens","normalized","segments","cells_raw","cells","items","fields","validation","confidence","final","manifest"):
                    try:
                        ensure_dir(Path(mp[k]))
                    except Exception:
                        pass

                # Write manifest before parser stage if referenced
                if script == "s10_parser.py" and "manifest" in mp:
                    manifest = {
                        "doc_id": doc_id,
                        "created_at": datetime.utcnow().isoformat() + "Z",
                        "inputs": {
                            "pdf": mp["pdf"],
                            "tokens": mp["tokens"],
                            "normalized": mp["normalized"],
                            "segments": mp["segments"],
                            "cells": mp["cells"],
                            "items": mp["items"],
                            "fields": mp["fields"],
                            "validation": mp["validation"],
                            "confidence": mp["confidence"],
                        },
                        "outputs": {"final": mp["final"]},
                        "version": "1.0",
                    }
                    with open(mp["manifest"], "w", encoding="utf-8") as mf:
                        json.dump(manifest, mf, ensure_ascii=False, indent=2)

                cmd = [python_exec, str(script_path)] + format_args(args_tmpl, mp)
                run(cmd)

            # Read and return final result
            with open(final_fp, "r", encoding="utf-8") as f:
                final_doc = json.load(f)
            if not include_refs:
                final_doc = strip_refs(final_doc)
            return final_doc

        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"Pipeline stage failed: {e}")
        except Exception as e:
            raise RuntimeError(f"Processing failed: {e}")


def process_pdf_from_pipeline_config_with_artifacts(
    pdf_bytes: bytes,
    doc_id: str,
    pipeline_config_filename: str,
    include_refs: bool = False,
) -> Tuple[Dict[str, Any], bytes]:
    """Run the pipeline using a declarative config and return (final_json, zip_bytes)."""

    python_exec = sys.executable
    stages_dir = Path(__file__).resolve().parent / "stages"

    with tempfile.TemporaryDirectory(prefix=f"pdf_process_{doc_id}_") as temp_dir:
        temp_path = Path(temp_dir)
        pdf_path = temp_path / f"{doc_id}.pdf"
        pdf_path.write_bytes(pdf_bytes)

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

        cfg_path = _find_pipeline_config(pipeline_config_filename)
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                pipeline_cfg = json.load(f)
        except Exception as e:
            raise RuntimeError(f"Failed to read pipeline config '{cfg_path}': {e}")

        stages: List[Dict[str, Any]] = pipeline_cfg.get("stages") or []
        if not stages:
            raise RuntimeError("Pipeline config missing 'stages' array")

        def resolve_stage_config(name: Optional[str]) -> Optional[str]:
            if not name:
                return None
            local = stages_dir.parent / "config" / Path(name).name
            if local.exists():
                return str(local)
            svc = (stages_dir.parent.parent / "config" / Path(name).name)
            if svc.exists():
                return str(svc)
            return str(name)

        def placeholder_map() -> Dict[str, str]:
            common_words = stages_dir.parent / "common" / "common-words.json"
            return {
                "pdf": str(pdf_path),
                "tokens": str(tokens_fp),
                "normalized": str(normalized_fp),
                "segments": str(segments_fp),
                "cells_raw": str(cells_raw_fp),
                "cells": str(cells_norm_fp),
                "items": str(items_fp),
                "fields": str(fields_fp),
                "validation": str(validation_fp),
                "confidence": str(confidence_fp),
                "final": str(final_fp),
                "manifest": str(manifest_fp),
                "common_words": str(common_words) if common_words.exists() else "",
            }

        def format_args(args_tmpl: List[str], mapping: Dict[str, str]) -> List[str]:
            import re
            out: List[str] = []
            for token in args_tmpl:
                def repl(m):
                    key = m.group(1)
                    if key not in mapping:
                        raise RuntimeError(f"Unknown placeholder '{{{key}}}' in args token: {token}")
                    return mapping[key]
                new_token = re.sub(r"\{([A-Za-z0-9_]+)\}", repl, token)
                out.append(new_token)
            return out

        try:
            for step in stages:
                script = step.get("script")
                if not script:
                    raise RuntimeError("Stage entry missing 'script'")
                args_tmpl = step.get("args")
                if not isinstance(args_tmpl, list) or not args_tmpl:
                    raise RuntimeError(f"Stage '{script}' missing non-empty 'args' array (data-driven mode)")
                script_path = stages_dir / script
                if not script_path.exists():
                    raise RuntimeError(f"Stage script not found: {script}")
                mp = placeholder_map()
                stage_cfg_path = resolve_stage_config(step.get("config"))
                if stage_cfg_path:
                    mp["config"] = stage_cfg_path

                for k in ("tokens","normalized","segments","cells_raw","cells","items","fields","validation","confidence","final","manifest"):
                    try:
                        ensure_dir(Path(mp[k]))
                    except Exception:
                        pass

                if script == "s10_parser.py" and "manifest" in mp:
                    manifest = {
                        "doc_id": doc_id,
                        "created_at": datetime.utcnow().isoformat() + "Z",
                        "inputs": {
                            "pdf": mp["pdf"],
                            "tokens": mp["tokens"],
                            "normalized": mp["normalized"],
                            "segments": mp["segments"],
                            "cells": mp["cells"],
                            "items": mp["items"],
                            "fields": mp["fields"],
                            "validation": mp["validation"],
                            "confidence": mp["confidence"],
                        },
                        "outputs": {"final": mp["final"]},
                        "version": "1.0",
                    }
                    with open(mp["manifest"], "w", encoding="utf-8") as mf:
                        json.dump(manifest, mf, ensure_ascii=False, indent=2)

                cmd = [python_exec, str(script_path)] + format_args(args_tmpl, mp)
                run(cmd)

            with open(final_fp, "r", encoding="utf-8") as f:
                final_doc = json.load(f)
            if not include_refs:
                final_doc = strip_refs(final_doc)

            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
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
                    (final_fp, "11-final.json"),
                ]
                # Include s03 overlay PDF when available
                overlay_pdf = pdf_path.with_name(f"{pdf_path.stem}-overlay.pdf")
                if overlay_pdf.exists():
                    stage_files.append((overlay_pdf, "03-segments-overlay.pdf"))
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
