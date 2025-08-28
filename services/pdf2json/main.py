"""
FastAPI PDF Processing Service

Endpoints:
- POST /process - Single PDF → JSON
- POST /batch - Multiple PDFs → JSON array  
- GET /health - Health check
"""

import io
import tempfile
from pathlib import Path
from typing import List

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse

from processor import process_pdf

app = FastAPI(
    title="PDF to JSON Processor",
    description="Convert PDF invoices to structured JSON using 10-stage pipeline",
    version="1.0.0"
)

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "pdf2json"}

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