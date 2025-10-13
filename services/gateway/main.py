"""
FastAPI Gateway Service

Single /process endpoint that routes to appropriate backend services
based on file type and Accept headers.
"""

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Request
from fastapi.responses import Response

app = FastAPI(
    title="Gateway Service",
    description="Unified /process endpoint for PDF→JSON, JSON→XML, and PDF→XML conversions",
    version="1.0.0"
)

# Configuration
PDF2JSON_URL = os.getenv("PDF2JSON_URL", "http://pdf2json:8000")
JSON2XML_URL = os.getenv("JSON2XML_URL", "http://json2xml:8000")
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "50"))  # Default 50MB limit
DEFAULT_PIPELINE = os.getenv("PIPELINE_CONFIG") or os.getenv("DEFAULT_PIPELINE") or "invoice_pt_simon.json"

_HERE = Path(__file__).resolve()
_SERVICE_DIR = _HERE.parent
_SERVICES_DIR = _SERVICE_DIR.parent
_CONFIG_CANDIDATES = [
    Path(os.getenv("CONFIG_DIR")) if os.getenv("CONFIG_DIR") else None,
    _SERVICES_DIR / "config",
    _SERVICE_DIR / "config",
    _SERVICES_DIR / "pdf2json" / "config",
]
CONFIG_SEARCH_DIRS = [p for p in dict.fromkeys([c for c in _CONFIG_CANDIDATES if c is not None])]


def _find_pipeline_config(filename: str) -> Path:
    """Locate the pipeline config file used by pdf2json/json2xml services."""

    name = Path(filename).name
    for base in CONFIG_SEARCH_DIRS:
        candidate = (base / name).resolve()
        if candidate.exists():
            return candidate
    raise FileNotFoundError(
        f"Pipeline config '{name}' not found in {[str(p) for p in CONFIG_SEARCH_DIRS]}"
    )


@lru_cache(maxsize=16)
def _load_pipeline_config(filename: str) -> dict:
    """Load and cache pipeline configuration JSON."""

    path = _find_pipeline_config(filename)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON in pipeline config '{path}': {exc}") from exc


def _get_confidence_threshold(pipeline_name: str) -> Optional[float]:
    """Extract confidence threshold value from pipeline config."""

    try:
        config = _load_pipeline_config(pipeline_name)
    except (FileNotFoundError, RuntimeError):
        return None

    threshold_value = config.get("confidence_threshold")
    if threshold_value is None:
        confidence_section = config.get("confidence")
        if isinstance(confidence_section, dict):
            threshold_value = (
                confidence_section.get("threshold")
                or confidence_section.get("min_score")
            )

    if threshold_value is None:
        return None

    try:
        return float(threshold_value)
    except (TypeError, ValueError):
        return None


def _extract_confidence_score(processed_data: dict) -> Optional[float]:
    """Retrieve confidence score from pdf2json response payload."""

    confidence_section = processed_data.get("confidence")
    if isinstance(confidence_section, dict):
        score = confidence_section.get("score")
    else:
        score = None

    if score is None:
        return None

    try:
        return float(score)
    except (TypeError, ValueError):
        return None

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "gateway"}

@app.get("/pdf2json/templates")
async def proxy_templates():
    """Proxy templates endpoint to PDF2JSON service"""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(f"{PDF2JSON_URL}/templates")
            
            if response.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"PDF2JSON service error: {response.text}"
                )
            
            return Response(
                content=response.content,
                media_type="application/json",
                headers={"Content-Type": "application/json"}
            )
            
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Backend service connection error: {str(e)}"
        )

@app.post("/process")
async def unified_process(
    request: Request,
    file: UploadFile = File(...),
    mapping: Optional[str] = Form(None),
    template: Optional[str] = Form(None),
    pretty: str = Form("0")
):
    """Unified endpoint for PDF→JSON, JSON→XML, and PDF→XML conversions"""
    
    # Get Accept header
    accept_header = request.headers.get("Accept", "").lower()
    
    # Strict Accept header validation
    if accept_header not in ["application/json", "application/xml"]:
        raise HTTPException(
            status_code=406,
            detail="Accept header must be 'application/json' or 'application/xml'"
        )
    
    # Check file size limit
    file_size = 0
    content = await file.read()
    file_size = len(content)
    await file.seek(0)  # Reset file pointer
    
    if file_size > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size is {MAX_UPLOAD_MB}MB"
        )
    
    # Get file content type
    content_type = file.content_type or ""
    
    # Determine file type from content-type
    is_pdf = content_type == "application/pdf"
    is_json = content_type == "application/json"
    
    # Validate file type
    if not (is_pdf or is_json):
        raise HTTPException(
            status_code=415,
            detail="Unsupported file type. Only PDF and JSON files are supported."
        )
    
    # Gateway routing rules (enforce strictly)
    if is_json and accept_header == "application/json":
        # Reject JSON uploads with Accept: application/json (not supported)
        raise HTTPException(
            status_code=406,
            detail="JSON→JSON conversion is not supported. Use Accept: application/xml for JSON→XML conversion."
        )
    
    # mapping required only when XML is requested
    if accept_header == "application/xml" and not mapping:
        raise HTTPException(
            status_code=400,
            detail="Mapping parameter is required when requesting XML output."
        )
    
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            
            if is_pdf and accept_header == "application/json":
                # Route 1: PDF + Accept: application/json → Forward to pdf2json service
                files = {"file": (file.filename, content, file.content_type)}
                data = {}
                if template:
                    data["template"] = template
                response = await client.post(f"{PDF2JSON_URL}/process", files=files, data=data)
                
                if response.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"PDF2JSON service error: {response.text}"
                    )
                
                return Response(
                    content=response.content,
                    media_type="application/json",
                    headers={"Content-Type": "application/json"}
                )
                
            elif is_pdf and accept_header == "application/xml":
                # Route 2: PDF + Accept: application/xml + mapping → pdf2json → json2xml pipeline

                # Step 1: Call PDF2JSON
                files = {"file": (file.filename, content, file.content_type)}
                data = {}
                if template:
                    data["template"] = template
                pdf_response = await client.post(f"{PDF2JSON_URL}/process", files=files, data=data)

                if pdf_response.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"PDF2JSON service error: {pdf_response.text}"
                    )

                pipeline_name = template or DEFAULT_PIPELINE
                threshold = _get_confidence_threshold(pipeline_name)
                if threshold is None:
                    raise HTTPException(
                        status_code=500,
                        detail=(
                            f"Confidence threshold not configured for pipeline "
                            f"'{Path(pipeline_name).name}'."
                        )
                    )

                try:
                    pdf_payload = pdf_response.json()
                except ValueError as exc:
                    raise HTTPException(
                        status_code=502,
                        detail=f"PDF2JSON response was not valid JSON: {exc}"
                    ) from exc

                processed_data = pdf_payload.get("data")
                if not isinstance(processed_data, dict):
                    raise HTTPException(
                        status_code=502,
                        detail="PDF2JSON response missing 'data' payload."
                    )

                confidence_score = _extract_confidence_score(processed_data)
                if confidence_score is None:
                    raise HTTPException(
                        status_code=422,
                        detail="Confidence score unavailable; JSON→XML conversion was skipped."
                    )

                if confidence_score < threshold:
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            f"Confidence score {confidence_score:.2f} is below the minimum "
                            f"threshold {threshold:.2f}. JSON→XML conversion was skipped."
                        )
                    )

                # Step 2: Call JSON2XML with the JSON result
                json_content = pdf_response.content
                form_data = {
                    "mapping": mapping,
                    "pretty": pretty
                }
                files = {"file": ("converted.json", json_content, "application/json")}
                
                xml_response = await client.post(
                    f"{JSON2XML_URL}/process", 
                    files=files,
                    data=form_data
                )
                
                if xml_response.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"JSON2XML service error: {xml_response.text}"
                    )
                
                return Response(
                    content=xml_response.content,
                    media_type="application/xml",
                    headers={
                        "Content-Type": "application/xml; charset=utf-8",
                        "X-Stage": "pdf2json,json2xml",
                        "X-Confidence-Score": f"{confidence_score:.6f}"
                    }
                )
                
            elif is_json and accept_header == "application/xml":
                # Route 3: JSON + Accept: application/xml + mapping → Forward to json2xml service
                
                form_data = {
                    "mapping": mapping,
                    "pretty": pretty
                }
                files = {"file": (file.filename, content, file.content_type)}
                
                response = await client.post(
                    f"{JSON2XML_URL}/process", 
                    files=files,
                    data=form_data
                )
                
                if response.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"JSON2XML service error: {response.text}"
                    )
                
                return Response(
                    content=response.content,
                    media_type="application/xml",
                    headers={
                        "Content-Type": "application/xml; charset=utf-8",
                        "X-Stage": "json2xml"
                    }
                )
                
            else:
                # This should not happen due to earlier validation, but just in case
                raise HTTPException(
                    status_code=400,
                    detail="Invalid combination of file type and Accept header."
                )
                
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Backend service connection error: {str(e)}"
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Backend service HTTP error: {e.response.status_code} - {e.response.text}"
        )

@app.post("/process-artifacts")
async def process_artifacts(
    request: Request,
    file: UploadFile = File(...),
    mapping: Optional[str] = Form(None),
    template: Optional[str] = Form(None)
):
    """Process PDF and return artifacts as ZIP file"""
    
    # Check file size limit
    content = await file.read()
    file_size = len(content)
    await file.seek(0)  # Reset file pointer
    
    if file_size > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size is {MAX_UPLOAD_MB}MB"
        )
    
    # Get file content type
    content_type = file.content_type or ""
    
    # Only support PDF files for artifacts
    if content_type != "application/pdf":
        raise HTTPException(
            status_code=415,
            detail="Only PDF files are supported for artifact generation."
        )
    
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            # Call PDF2JSON artifacts endpoint
            files = {"file": (file.filename, content, file.content_type)}
            data = {}
            if template:
                data["template"] = template
            response = await client.post(f"{PDF2JSON_URL}/process-with-artifacts", files=files, data=data)
            
            if response.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"PDF2JSON artifacts service error: {response.text}"
                )
            
            return Response(
                content=response.content,
                media_type="application/zip",
                headers={
                    "Content-Type": "application/zip",
                    "Content-Disposition": response.headers.get("Content-Disposition", "attachment; filename=\"artifacts.zip\"")
                }
            )
                
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Backend service connection error: {str(e)}"
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Backend service HTTP error: {e.response.status_code} - {e.response.text}"
        )
