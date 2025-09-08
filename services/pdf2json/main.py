"""
FastAPI PDF Processing Service

Endpoints:
- POST /process - Single PDF → JSON
- POST /batch - Multiple PDFs → JSON array  
- GET /health - Health check
"""

import io
import json
import os
import tempfile
from pathlib import Path
from typing import List

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse, Response

from processor import process_pdf, process_pdf_with_artifacts

app = FastAPI(
    title="PDF to JSON Processor",
    description="Convert PDF invoices to structured JSON using 10-stage pipeline",
    version="1.0.0"
)

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "pdf2json"}

@app.get("/templates")
async def get_templates():
    """Get available processing templates"""
    try:
        candidates = [
            Path(os.getenv("CONFIG_DIR", "/config")),  # external mount or explicit
            Path("config"),                             # local/dev execution
        ]

        def list_templates(dir_path: Path):
            items = []
            if dir_path.exists():
                for config_file in dir_path.glob("*.json"):
                    try:
                        with open(config_file, "r") as f:
                            cfg = json.load(f)
                            name = (
                                cfg.get("name")
                                or cfg.get("document", {}).get("vendor")
                                or config_file.stem
                            )
                            version = (
                                cfg.get("version")
                                or cfg.get("document", {}).get("version")
                                or "1"
                            )
                            items.append({
                                "name": name,
                                "version": version,
                                "filename": config_file.name,
                                "display_name": f"{name} V{version}",
                            })
                    except (json.JSONDecodeError, FileNotFoundError):
                        continue
            return items

        templates = []
        chosen_dir = None
        for p in candidates:
            items = list_templates(p)
            if items:
                templates = items
                chosen_dir = p
                break
        if not templates:
            chosen_dir = next((p for p in candidates if p.exists()), candidates[0])
            templates = list_templates(chosen_dir)

        try:
            print(f"[pdf2json] templates dir: {chosen_dir} count={len(templates)}")
        except Exception:
            pass

        return {"templates": templates}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read templates: {str(e)}")

@app.post("/process")
async def process_single_pdf(file: UploadFile = File(...)):
    """Process a single PDF file and return JSON"""
    
    # Validate file type
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="File must be a PDF")
    
    try:
        # Read file content
        pdf_bytes = await file.read()
        doc_id = Path(file.filename).stem
        
        # Process PDF through pipeline
        processed_data = process_pdf(pdf_bytes, doc_id, include_refs=False)
        
        result = {
            "doc_id": doc_id,
            "filename": file.filename,
            "status": "success",
            "data": processed_data
        }
        
        return JSONResponse(content=result)
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Processing failed: {str(e)}")

@app.post("/process-with-artifacts")
async def process_pdf_with_artifacts_endpoint(file: UploadFile = File(...)):
    """Process a single PDF file and return artifacts as ZIP"""
    
    # Validate file type
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="File must be a PDF")
    
    try:
        # Read file content
        pdf_bytes = await file.read()
        doc_id = Path(file.filename).stem
        
        # Process PDF through pipeline and get artifacts
        processed_data, zip_bytes = process_pdf_with_artifacts(pdf_bytes, doc_id, include_refs=False)
        
        # Return ZIP file with artifacts
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": f"attachment; filename=\"{doc_id}-artifacts.zip\""
            }
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Processing failed: {str(e)}")

@app.post("/batch")
async def process_batch_pdfs(files: List[UploadFile] = File(...)):
    """Process multiple PDF files and return array of JSON results"""
    
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")
    
    results = []
    
    for file in files:
        try:
            # Validate file type
            if not file.filename.lower().endswith('.pdf'):
                results.append({
                    "filename": file.filename,
                    "status": "error", 
                    "error": "File must be a PDF"
                })
                continue
            
            # Read file content
            pdf_bytes = await file.read()
            doc_id = Path(file.filename).stem
            
            # Process PDF through pipeline
            processed_data = process_pdf(pdf_bytes, doc_id, include_refs=False)
            
            result = {
                "doc_id": doc_id,
                "filename": file.filename,
                "status": "success",
                "data": processed_data
            }
            
            results.append(result)
            
        except Exception as e:
            results.append({
                "filename": file.filename,
                "status": "error",
                "error": str(e)
            })
    
    return JSONResponse(content={"results": results, "total": len(files), "processed": len(results)})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)