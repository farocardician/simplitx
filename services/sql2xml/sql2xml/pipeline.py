"""
Pipeline and mapping resolution for the sql2xml service.

This mirrors the json2xml service helpers so that pipeline config files
in services/config/*.json can be reused without duplicating logic.
"""

from __future__ import annotations

import importlib
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple, Callable

DEFAULT_PIPELINE = os.getenv("PIPELINE_CONFIG") or os.getenv("DEFAULT_PIPELINE") or "invoice_pt_sensient.json"


def _service_paths() -> Tuple[Path, Path, Path]:
    """
    Returns (service_root, project_services_dir, repo_root).
    - service_root: services/sql2xml
    - project_services_dir: services/
    - repo_root: repository root
    """
    here = Path(__file__).resolve()
    package_dir = here.parent
    service_root = package_dir.parent
    if service_root.name == "app":
        project_services_dir = service_root
    else:
        project_services_dir = service_root.parent
    repo_root = project_services_dir.parent
    return service_root, project_services_dir, repo_root


def find_pipeline_config(filename: str) -> Path:
    """Locate a pipeline config by name, searching common locations."""
    name = Path(filename).name
    service_root, project_services_dir, _ = _service_paths()

    candidates = []
    env_dir = os.getenv("CONFIG_DIR")
    if env_dir:
        candidates.append(Path(env_dir))
    candidates.append(project_services_dir / "config")
    candidates.append(service_root / "config")

    for base in candidates:
        candidate = (base / name).resolve()
        if candidate.exists():
            return candidate

    raise FileNotFoundError(f"Pipeline config '{name}' not found in expected directories")


def load_pipeline_config(pipeline_override: Optional[str] = None) -> Tuple[Dict[str, Any], Path]:
    """Load pipeline JSON (default or override) and return (config, path)."""
    config_path = find_pipeline_config(pipeline_override or DEFAULT_PIPELINE)
    try:
        return json.loads(config_path.read_text(encoding="utf-8")), config_path
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON in pipeline config '{config_path}': {exc}") from exc


def _config_search_roots(pipeline_path: Path) -> list[Path]:
    """Directories to search when resolving mapping paths."""
    service_root, project_services_dir, repo_root = _service_paths()
    roots: list[Path] = []

    candidates = [pipeline_path.parent]

    env_dir = os.getenv("CONFIG_DIR")
    if env_dir:
        candidates.append(Path(env_dir))

    candidates.extend(
        [
            project_services_dir,
            project_services_dir / "json2xml",
            project_services_dir / "json2xml" / "mappings",
            service_root,
            service_root / "mappings",
            repo_root,
        ]
    )

    for candidate in candidates:
        if candidate and candidate.exists() and candidate not in roots:
            roots.append(candidate)
    return roots


def resolve_mapping_path(relative_path: str, pipeline_path: Path) -> Path:
    """Resolve mapping path using the same search order as json2xml service."""
    provided = Path(relative_path)
    if provided.is_absolute():
        if not provided.exists():
            raise FileNotFoundError(f"Mapping file '{relative_path}' not found")
        return provided

    for root in _config_search_roots(pipeline_path):
        candidate = (root / provided).resolve()
        if candidate.exists():
            return candidate

    raise FileNotFoundError(f"Mapping file '{relative_path}' not found")


def resolve_profile(pipeline_config: Dict[str, Any], profile: str) -> Dict[str, Any]:
    """Get json2xml profile entry from pipeline config."""
    profiles = (pipeline_config.get("json2xml", {}) or {}).get("profiles", {})
    profile_conf = profiles.get(profile)
    if profile_conf is None:
        raise KeyError(f"Profile '{profile}' not found in pipeline config")
    if "mapping" not in profile_conf:
        raise KeyError(f"Profile '{profile}' missing mapping path")
    return profile_conf


def load_converter(module_name: str, callable_name: str) -> Callable[..., bytes]:
    """Import converter callable defined in profile config."""
    try:
        module = importlib.import_module(module_name)
    except ModuleNotFoundError as exc:
        raise ImportError(f"Converter module '{module_name}' not found") from exc
    try:
        converter = getattr(module, callable_name)
    except AttributeError as exc:
        raise ImportError(f"Converter callable '{callable_name}' not found in module '{module_name}'") from exc
    return converter
