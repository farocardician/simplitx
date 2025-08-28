# PDF to JSON Processing Pipeline - LLM Context

## Project Overview
**What it does**: Converts PDF invoices into structured JSON using a deterministic 10-stage pipeline. Specifically designed for Indonesian invoices with IDR currency, 12% VAT, and electrical product catalogs.

**Architecture**: FastAPI web service that wraps a sequential processing pipeline. Each stage produces intermediate JSON files, ensuring deterministic and debuggable processing.

## Main Entry Points

### `/app/main.py` - FastAPI Web Service
- **Purpose**: REST API wrapper around the pipeline
- **Endpoints**:
  - `GET /health` - Health check
  - `POST /process` - Single PDF → JSON 
  - `POST /batch` - Multiple PDFs → JSON array
- **Key Function**: Calls `processor.process_pdf()` for actual processing
- **Error Handling**: HTTP exceptions with proper status codes

### `/app/processor.py` - Pipeline Orchestrator  
- **Purpose**: Main processing function that coordinates all 10 stages
- **Key Function**: `process_pdf(pdf_bytes: bytes, doc_id: str, include_refs: bool) -> Dict`
- **Process**: 
  1. Creates temp directory
  2. Writes PDF to temp file
  3. Executes stages s01→s10 sequentially via subprocess calls
  4. Returns final JSON result
  5. Cleans up temp files
- **Error Handling**: Catches subprocess errors and raises RuntimeError

## Pipeline Stages (Sequential Processing)

### Stage 1: `s01_tokenizer.py` - PDF Tokenization
- **Input**: PDF file
- **Output**: `tokens.json`
- **Purpose**: Extract words with normalized bounding boxes [0..1]
- **Library**: pdfplumber
- **Key**: Deterministic sorting by (page, y_top, x_left)

### Stage 2: `s02_normalizer.py` - Text Normalization  
- **Input**: `tokens.json`
- **Output**: `normalized.json` (updated tokens)
- **Purpose**: Safe text fixes (NFC/NFKC, NBSP→space, ligatures)
- **Key**: Preserves positions, only normalizes text content

### Stage 3: `s03_segmenter.py` - Band Segmentation
- **Input**: `normalized.json` + PDF
- **Output**: `segmentized.json`
- **Purpose**: Detect header/content/footer bands across pages
- **Key**: Table processing only happens in CONTENT bands

### Stage 4: `s04_camelot_grid.py` - Table Grid Detection
- **Input**: PDF + `normalized.json`
- **Output**: `cells.json`
- **Purpose**: Detect table geometry using Camelot (lattice first, then stream)
- **Key**: Only extracts grid geometry, NOT text (text comes from tokens)
- **Headers**: Maps columns to families: NO, HS, DESC, QTY, UOM, PRICE, AMOUNT

### Stage 5: `s05_normalize_cells.py` - Cell Text Normalization
- **Input**: `cells.json`
- **Output**: `cells_normalized.json`
- **Purpose**: Heavy text normalization (merge wrapped lines, fix hyphens, numbers/dates)
- **Key**: Preserves token backreferences

### Stage 6: `s06_line_items_from_cells.py` - Item Extraction
- **Input**: `cells_normalized.json`
- **Output**: `items.json`
- **Purpose**: Extract line items from table cells
- **Key**: Handles continuation rows (empty NO/HS + filled DESC → append to previous)

### Stage 7: `s07_extractor.py` - Field Extraction ⚠️ **LLM INTEGRATION POINT**
- **Input**: `cells_normalized.json` + `items.json`
- **Output**: `fields.json`
- **Purpose**: Extract header fields (invoice #, date, buyer_id, seller, buyer names)
- **Key Patterns**:
  - Invoice number: `[A-Z0-9]+-[0-9]{6}-[0-9]{4}`
  - Date: `[12]\d{3}-\d{2}-\d{2}` (ISO format)
  - Customer code: Multiple regex patterns for "cust code", "buyer id", etc.
- **⚠️ Future LLM Integration**: This stage could call external LLM service for field extraction

### Stage 8: `s08_validator.py` - Arithmetic Validation
- **Input**: `fields.json` + `items.json`
- **Output**: `validation.json`
- **Purpose**: Validate arithmetic and calculate totals
- **Business Rules**:
  - Tax rate: 12%
  - Tax base: subtotal × 11/12
  - Row validation: qty × unit_price ≈ amount (within tolerances)
- **Tolerances**: 0.5%/1 unit for rows, 0.3%/2 units for subtotals
- **Flags**: TOTALS_MISSING, SUBTOTAL_MISSING, severe errors

### Stage 9: `s09_confidence.py` - Confidence Scoring
- **Input**: `fields.json` + `items.json` + `validation.json`
- **Output**: `confidence.json`
- **Purpose**: Calculate overall confidence score [0..1]
- **Weights**:
  - Anchors matched/aligned: 30%
  - Row arithmetic pass rate: 30%
  - Numeric purity: 20%
  - Grid alignment: 10%
  - Totals reconciliation: 10%

### Stage 10: `s10_parser.py` - Final Assembly
- **Input**: All previous stage outputs
- **Output**: `final.json` + `manifest.json`
- **Purpose**: Assemble final structured JSON output
- **Key**: 
  - Adds token backreferences for provenance
  - Rounds monetary values to 2 decimals
  - Creates manifest with file hashes and metadata

## Data Flow Patterns

### Intermediate Files (per document)
```
/tmp/pdf_process_{doc_id}_{random}/output/
├── tokenizer/{doc_id}.tokens.json
├── normalize/{doc_id}-normalized.json
├── segment/{doc_id}-segmentized.json
├── cells/{doc_id}-cells.json
├── cells/{doc_id}-cells_normalized.json
├── items/{doc_id}-items.json
├── fields/{doc_id}-fields.json
├── validate/{doc_id}-validation.json
├── validate/{doc_id}-confidence.json
├── manifest/{doc_id}-manifest.json
└── final/{doc_id}.json
```

### Final JSON Structure
```json
{
  "doc_id": "2508070002",
  "buyer_id": "C1-2523",
  "invoice": {"number": "70CH-250807-0002", "date": "2025-08-19"},
  "seller": {"name": "PT Simon Elektrik-Indonesia"},
  "buyer": {"name": "PT. Niaga Pura Indonesia"},
  "currency": "IDR",
  "items": [{"no": 10, "hs_code": "8536", "sku": "...", ...}],
  "totals": {"subtotal": 203802775.52, "tax_amount": 22418305.31, ...},
  "issues": [],
  "confidence": {"score": 1.0, "components": {...}},
  "provenance": {"header_refs": {...}, "files": {...}}
}
```

## Key Configuration & Constants

### Business Rules (Template-specific)
- **Currency**: IDR (Indonesian Rupiah)
- **Tax Rate**: 12% VAT
- **Tax Formula**: tax_base = subtotal × 11/12
- **Default UOM**: "PCS" if header shows "(PCS)"
- **Decimal Precision**: 2 decimal places for money, preserve qty decimals

### Validation Tolerances
- **Row tolerance**: max(0.5% or 1 unit)
- **Subtotal tolerance**: max(0.3% or 2 units) 
- **Severe flag threshold**: 3× normal tolerance

## Legacy/Unused Files
- `/app/cli/worker.py` - Original file watcher (unused, replaced by FastAPI)
- `/app/cli/pdf2json.py` - Original CLI orchestrator (replaced by processor.py)
- `/app/config/`, `/app/core/`, `/app/json/` - Empty directories
- `/app/rules/templates/default.yaml` - Minimal template file

## Common Debugging Patterns

### Pipeline Failures
1. **Stage 4 (Camelot) returns 0 rows**: Table detection failed
   - Check if PDF has proper table structure
   - Verify Camelot dependencies installed
   - Review segmenter output for proper content bands

2. **Missing buyer_id**: 
   - Check s07_extractor regex patterns match invoice format
   - Verify s10_parser properly reads from fields.json

3. **False TOTALS_MISSING**: 
   - Check s08_validator logic for when to flag missing totals
   - Verify totals are properly computed vs. extracted

### Performance Issues
- Each stage creates separate subprocess (not optimized for speed)
- Temporary files create I/O overhead
- Camelot table detection is CPU-intensive

### Adding New Features
- **New extraction fields**: Modify s07_extractor.py patterns and s10_parser.py output
- **Different business rules**: Update s08_validator.py constants and formulas
- **LLM integration**: Replace/enhance s07_extractor.py to call external LLM service

## Environment Requirements
- **Python libraries**: pdfplumber, camelot-py, opencv, ghostscript, tesseract
- **System deps**: ghostscript, poppler-utils, tesseract-ocr
- **FastAPI**: uvicorn server running on port 8000
- **Container**: All stages run inside Docker container with mounted volumes