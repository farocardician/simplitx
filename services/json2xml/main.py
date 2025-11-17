"""
Config-driven JSON→XML conversion service.

Endpoints:
- POST /process — Convert uploaded JSON using a profile defined in the pipeline config
- GET /health — Health check
"""

import importlib
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.responses import Response

from json2xml.mapping import load_mapping, MappingError
from json2xml.converter import ConversionError

DEFAULT_PIPELINE = os.getenv("PIPELINE_CONFIG") or os.getenv("DEFAULT_PIPELINE") or "invoice_pt_simon.json"


def _find_pipeline_config(filename: str) -> Path:
    name = Path(filename).name
    here = Path(__file__).resolve()
    service_dir = here.parent
    services_dir = service_dir.parent

    candidates = []
    env_dir = os.getenv("CONFIG_DIR")
    if env_dir:
        candidates.append(Path(env_dir))
    candidates.append(services_dir / "config")
    candidates.append(service_dir / "config")

    for base in candidates:
        if base is None:
            continue
        candidate = base / name
        if candidate.exists():
            return candidate

    raise FileNotFoundError(f"Pipeline config '{name}' not found in expected directories")


def _load_pipeline() -> tuple[Dict[str, Any], Path]:
    config_path = _find_pipeline_config(DEFAULT_PIPELINE)
    try:
        return json.loads(config_path.read_text(encoding="utf-8")), config_path
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON in pipeline config '{config_path}': {exc}") from exc


PIPELINE_CONFIG, PIPELINE_PATH = _load_pipeline()
SERVICE_DIR = Path(__file__).resolve().parent
PROJECT_SERVICES_DIR = SERVICE_DIR.parent
PIPELINE_DIR = PIPELINE_PATH.parent

CONFIG_SEARCH_ROOTS = []
if PIPELINE_DIR not in CONFIG_SEARCH_ROOTS:
    CONFIG_SEARCH_ROOTS.append(PIPELINE_DIR)
env_dir = os.getenv("CONFIG_DIR")
if env_dir:
    env_path = Path(env_dir)
    if env_path not in CONFIG_SEARCH_ROOTS:
        CONFIG_SEARCH_ROOTS.append(env_path)
if PROJECT_SERVICES_DIR not in CONFIG_SEARCH_ROOTS:
    CONFIG_SEARCH_ROOTS.append(PROJECT_SERVICES_DIR)
project_json2xml_dir = PROJECT_SERVICES_DIR / "json2xml"
if project_json2xml_dir not in CONFIG_SEARCH_ROOTS:
    CONFIG_SEARCH_ROOTS.append(project_json2xml_dir)
if SERVICE_DIR not in CONFIG_SEARCH_ROOTS:
    CONFIG_SEARCH_ROOTS.append(SERVICE_DIR)
service_mappings_dir = SERVICE_DIR / "mappings"
if service_mappings_dir not in CONFIG_SEARCH_ROOTS:
    CONFIG_SEARCH_ROOTS.append(service_mappings_dir)

JSON2XML_PROFILES: Dict[str, Dict[str, Any]] = (
    PIPELINE_CONFIG.get("json2xml", {}) or {}
).get("profiles", {})


app = FastAPI(
    title="JSON to XML Processor",
    description="Convert JSON to XML using config-driven mappings",
    version="1.0.0"
)


def _resolve_profile(profile: str) -> Dict[str, Any]:
    profile_conf = JSON2XML_PROFILES.get(profile)
    if profile_conf is None:
        raise HTTPException(status_code=404, detail=f"Profile '{profile}' not found")
    if "mapping" not in profile_conf:
        raise HTTPException(status_code=500, detail=f"Profile '{profile}' missing mapping path")
    return profile_conf


def _load_converter(module_name: str, callable_name: str):
    try:
        module = importlib.import_module(module_name)
    except ModuleNotFoundError as exc:
        raise HTTPException(status_code=500, detail=f"Converter module '{module_name}' not found") from exc
    try:
        return getattr(module, callable_name)
    except AttributeError as exc:
        raise HTTPException(status_code=500, detail=f"Converter callable '{callable_name}' not found in module '{module_name}'") from exc


def _resolve_mapping_path(relative_path: str) -> Path:
    provided = Path(relative_path)
    if provided.is_absolute():
        if not provided.exists():
            raise HTTPException(status_code=404, detail=f"Mapping file '{relative_path}' not found")
        return provided

    for root in CONFIG_SEARCH_ROOTS:
        candidate = (root / provided).resolve()
        if candidate.exists():
            return candidate

    raise HTTPException(status_code=404, detail=f"Mapping file '{relative_path}' not found")


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "json2xml"}


@app.post("/process")
async def process_json_to_xml(
    file: UploadFile = File(...),
    profile: str = Form("default"),
    pretty: str = Form("0"),
    params: Optional[str] = Form(None)
):
    """Convert JSON payload to XML using a configured profile."""

    profile_conf = _resolve_profile(profile)
    mapping_rel = profile_conf["mapping"]
    converter_conf = profile_conf.get("converter", {})
    module_name = converter_conf.get("module", "json2xml.converter")
    callable_name = converter_conf.get("callable", "convert_json_to_xml")

    converter = _load_converter(module_name, callable_name)
    mapping_path = _resolve_mapping_path(mapping_rel)

    base_params = profile_conf.get("params") or {}
    request_params: Optional[Dict[str, Any]] = None
    if params:
        try:
            request_params = json.loads(params)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid params payload: {exc}")

    try:
        json_content = await file.read()
        try:
            json_data = json.loads(json_content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail=f"Invalid JSON file: {exc}") from exc

        mapping_config = load_mapping(str(mapping_path))

        is_pretty = pretty == "1"

        combined_params = dict(base_params)
        if request_params:
            combined_params.update(request_params)

        params_payload = combined_params if combined_params else None

        xml_bytes = converter(
            json_data,
            mapping_config,
            params=params_payload,
            pretty=is_pretty
        )

        return Response(
            content=xml_bytes,
            media_type="application/xml",
            headers={"Content-Type": "application/xml; charset=utf-8"}
        )

    except MappingError as exc:
        raise HTTPException(status_code=422, detail=f"Mapping error: {exc}") from exc
    except ConversionError as exc:
        message = str(exc)
        if "missing" in message.lower() or "invalid" in message.lower():
            raise HTTPException(status_code=400, detail=f"Invalid input data: {message}") from exc
        raise HTTPException(status_code=422, detail=f"Conversion constraint violation: {message}") from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Internal server error: {exc}") from exc
