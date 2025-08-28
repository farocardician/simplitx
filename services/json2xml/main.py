"""
FastAPI JSON to XML Processing Service

Endpoints:
- POST /process - Single JSON → XML using mapping
- GET /health - Health check
"""

import json
import os
import re
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.responses import Response

from json2xml import convert_json_to_xml, load_mapping
from json2xml.converter import ConversionError
from json2xml.mapping import MappingError

app = FastAPI(
    title="JSON to XML Processor",
    description="Convert JSON to XML using mapping configurations",
    version="1.0.0"
)

# Security: Only allow safe mapping filenames
SAFE_FILENAME_PATTERN = re.compile(r'^[A-Za-z0-9_.\-]+$')

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "json2xml"}

@app.post("/process")
async def process_json_to_xml(
    file: UploadFile = File(...),
    mapping: str = Form(...), 
    pretty: str = Form("0")
):
    """Process JSON file to XML using specified mapping"""
    
    # Security: Validate mapping filename to prevent path traversal
    if not SAFE_FILENAME_PATTERN.match(mapping):
        raise HTTPException(
            status_code=400, 
            detail="Invalid mapping filename. Only alphanumeric, underscore, dot, and dash characters allowed."
        )
    
    if '..' in mapping:
        raise HTTPException(
            status_code=400, 
            detail="Path traversal not allowed in mapping filename."
        )
    
    try:
        # Check if mapping file exists in local mappings directory
        mapping_path = f"mappings/{mapping}"
        if not os.path.exists(mapping_path):
            raise HTTPException(
                status_code=404,
                detail=f"Mapping file '{mapping}' not found."
            )
        
        # Read and parse JSON from uploaded file
        json_content = await file.read()
        try:
            json_data = json.loads(json_content.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid JSON file: {str(e)}"
            )
        
        # Load mapping configuration
        mapping_config = load_mapping(mapping_path)
        
        # Convert JSON to XML
        is_pretty = pretty == "1"
        xml_bytes = convert_json_to_xml(
            json_data,
            mapping_config,
            pretty=is_pretty
        )
        
        # Return XML with proper content-type
        return Response(
            content=xml_bytes,
            media_type="application/xml",
            headers={"Content-Type": "application/xml; charset=utf-8"}
        )
        
    except MappingError as e:
        raise HTTPException(
            status_code=422,
            detail=f"Mapping error: {str(e)}"
        )
    except ConversionError as e:
        if "missing" in str(e).lower() or "invalid" in str(e).lower():
            raise HTTPException(
                status_code=400,
                detail=f"Invalid input data: {str(e)}"
            )
        else:
            raise HTTPException(
                status_code=422,
                detail=f"Conversion constraint violation: {str(e)}"
            )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {str(e)}"
        )