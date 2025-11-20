"""
FastAPI Gateway Service

Single /process endpoint that routes to appropriate backend services
based on file type and Accept headers.
"""

import json
import os
from typing import Optional

import httpx
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

app = FastAPI(
    title="Gateway Service",
    description="Unified /process endpoint for PDF→JSON, JSON→XML, and PDF→XML conversions",
    version="1.0.0"
)

# Configuration
PDF2JSON_URL = os.getenv("PDF2JSON_URL", "http://pdf2json:8000")
JSON2XML_URL = os.getenv("JSON2XML_URL", "http://json2xml:8000")
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "50"))  # Default 50MB limit

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
                    # Try to parse structured validation errors from pdf2json
                    try:
                        error_data = response.json()
                        if isinstance(error_data, dict) and error_data.get("detail"):
                            detail = error_data["detail"]
                            # Check if it's a structured validation error
                            if isinstance(detail, dict) and detail.get("type") == "validation_error":
                                raise HTTPException(
                                    status_code=response.status_code,
                                    detail=detail  # Pass through structured error
                                )
                    except (json.JSONDecodeError, KeyError):
                        pass

                    # Fallback to generic error
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
                    # Try to parse structured validation errors from pdf2json
                    try:
                        error_data = pdf_response.json()
                        if isinstance(error_data, dict) and error_data.get("detail"):
                            detail = error_data["detail"]
                            # Check if it's a structured validation error
                            if isinstance(detail, dict) and detail.get("type") == "validation_error":
                                raise HTTPException(
                                    status_code=pdf_response.status_code,
                                    detail=detail  # Pass through structured error
                                )
                    except (json.JSONDecodeError, KeyError):
                        pass

                    # Fallback to generic error
                    raise HTTPException(
                        status_code=502,
                        detail=f"PDF2JSON service error: {pdf_response.text}"
                    )
                
                # Step 2: Call JSON2XML with the JSON result
                json_content = pdf_response.content
                # Use template/mapping to determine which JSON2XML pipeline config to use
                # The template name (e.g., "invoice_pt_sil.json") corresponds to a pipeline config
                # that contains the correct mapping for that invoice type
                pipeline_config = template or mapping

                form_data = {
                    "pipeline": pipeline_config,
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
                        "X-Stage": "pdf2json,json2xml"
                    }
                )
                
            elif is_json and accept_header == "application/xml":
                # Route 3: JSON + Accept: application/xml + mapping/template → Forward to json2xml service
                pipeline_config = template or mapping

                form_data = {
                    "pipeline": pipeline_config,
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
