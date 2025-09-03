# Template Dropdown Implementation Plan

## Overview
Add a template selector dropdown above the PDF dropzone that dynamically reads from `services/pdf2json/config/*.json` files and displays them as "$name V$version".

## Files to Modify (4 files total)

### 1. `services/pdf2json/main.py` (ADD endpoint)
```python
@app.get("/templates")
async def get_templates():
    """Get available processing templates"""
    # Read all JSON files from config/ directory
    # Return [{name, version, filename}] array
```

### 2. `services/gateway/main.py` (ADD route)  
```python
@app.get("/pdf2json/templates")
async def proxy_templates():
    # Forward to pdf2json service /templates endpoint
```

### 3. `services/web/components/dropzone/PDFDropzone.tsx` (MODIFY)
- Add template state: `const [selectedTemplate, setSelectedTemplate] = useState('')`
- Add `useEffect` to fetch templates from `/api/gateway/pdf2json/templates` 
- Add simple `<select>` dropdown above dropzone
- Pass selectedTemplate to upload hook

### 4. `services/web/components/dropzone/PDFDropzone.module.css` (MODIFY)
- Add `.templateSelector` styles for dropdown
- Maintain minimal, modern design consistent with dropzone

## Key Benefits
✅ **Simple**: Only 4 file changes, minimal code  
✅ **Scalable**: Adding new config files auto-appears in dropdown    
✅ **Best Practice**: Follows existing microservices routing pattern  
✅ **Minimal Change**: Uses existing Gateway proxy pattern  
✅ **Dynamic**: Config file changes reflect immediately  

## Implementation Details
- Template format: "Invoice PT Simon V1.3", "Invoice Stahl V3" 
- Dropdown positioned above dropzone with clean styling
- No new components/services needed
- Leverages existing Gateway→PDF2JSON routing

## Current Config Files Found
- `invoice_simon_v15.json`: "Invoice PT Simon" V1.3
- `invoice_stahl_v3.json`: "Invoice Stahl" V3