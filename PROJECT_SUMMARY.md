# PDF Processing Gateway - Complete System Overview

## What This System Does

**A production-ready microservices system that transforms PDF invoices into structured JSON and XML formats using advanced document processing.**

This system automatically extracts data from complex PDF invoices through a sophisticated 10-stage processing pipeline, producing structured data that can be integrated into business systems.

## System Architecture

### Core Processing Services
- **3 Microservices**: Gateway, PDF2JSON, JSON2XML  
- **1 Exposed Port**: 8002 (API gateway only)
- **Docker Compose**: Full container orchestration with health checks
- **Service Isolation**: Internal-only communication between processing services

### Service Details
| Service | Technology | Port | Purpose |
|---------|------------|------|---------|
| **Gateway** | Python FastAPI | 8002 (public) | API routing, validation, orchestration |
| **PDF2JSON** | Python + ML Pipeline | Internal only | 10-stage PDF data extraction |
| **JSON2XML** | Python | Internal only | Format transformation with mappings |

## Core Processing Capabilities

### ✅ Advanced PDF Processing Pipeline
- **10-Stage Processing**: Complete pipeline from PDF tokenization to final structured output
- **Table Extraction**: Uses Camelot library for complex invoice table parsing
- **510 Line Items**: Successfully processes invoices with hundreds of line items
- **Text Normalization**: Handles various PDF encoding and formatting issues
- **Multi-page Support**: Processes complex multi-page invoice documents

### ✅ Flexible Format Conversion
- **PDF → JSON**: Extract complete structured data from PDF invoices
- **JSON → XML**: Transform JSON to XML using configurable mapping templates  
- **PDF → XML**: Single-call end-to-end pipeline combining both conversions
- **Configurable Mappings**: Support for different invoice formats (currently: pt_simon_invoice_v1)
- **Pretty Printing**: Optional XML formatting for human readability

### ✅ Production-Ready API Gateway
- **Unified `/process` endpoint** with intelligent content-type routing
- **Strict validation**: Accept headers, file types, required parameters
- **Error handling**: Proper HTTP status codes (400, 406, 413, 415, 502)
- **Pipeline tracking**: X-Stage headers show processing steps
- **50MB file size limit** with proper validation  

## API Usage Examples

### PDF → JSON
```bash
curl -sS -X POST \
  -F 'file=@invoice.pdf;type=application/pdf' \
  -H 'Accept: application/json' \
  http://localhost:8002/process > output.json
```

### JSON → XML  
```bash
curl -sS -X POST \
  -F 'file=@data.json;type=application/json' \
  -F 'mapping=pt_simon_invoice_v1.json' \
  -F 'pretty=1' \
  -H 'Accept: application/xml' \
  http://localhost:8002/process > output.xml
```

### PDF → XML (Single Call)
```bash
curl -sS -X POST \
  -F 'file=@invoice.pdf;type=application/pdf' \
  -F 'mapping=pt_simon_invoice_v1.json' \
  -F 'pretty=1' \
  -H 'Accept: application/xml' \
  http://localhost:8002/process > output.xml
```

### ✅ Enterprise Security & Reliability
- **Input Validation**: Comprehensive file type, size, and format validation
- **Path Traversal Protection**: Secure filename handling prevents directory attacks
- **Service Isolation**: Internal-only networking between processing services
- **Health Checks**: Prevents race conditions during container startup
- **Error Recovery**: Graceful handling of service failures with proper HTTP status codes
- **50MB File Size Limits**: Prevents resource exhaustion attacks

## Detailed Processing Pipeline

### 10-Stage PDF Processing (PDF2JSON Service)
1. **Tokenizer** - Extract raw text and positioning data from PDF
2. **Normalizer** - Clean and standardize extracted text
3. **Segmenter** - Identify document sections and structure
4. **Camelot Grid** - Extract table structures using computer vision
5. **Normalize Cells** - Clean and format extracted table cells
6. **Line Items** - Identify invoice line items from table data
7. **Extractor** - Extract header fields and metadata
8. **Validator** - Validate extracted data against business rules
9. **Confidence** - Calculate confidence scores for extracted data
10. **Parser** - Generate final structured JSON output

### Gateway Request Routing Logic
The gateway intelligently routes requests based on file type and Accept headers:

- **PDF + Accept: application/json** → Forward to PDF2JSON service
- **PDF + Accept: application/xml + mapping** → PDF2JSON → JSON2XML pipeline  
- **JSON + Accept: application/xml + mapping** → Forward to JSON2XML service
- **Invalid combinations** → Return HTTP 406 Not Acceptable

### Verified Processing Results
✅ **510 line items** successfully extracted from test invoice (2508070002.pdf)
✅ **Indonesian tax invoice format** correctly processed with complete VAT structure
✅ **Multi-service pipeline** executes end-to-end without errors
✅ **All health checks** pass and containers remain stable during processing
✅ **File validation** properly rejects non-PDF/non-JSON files
✅ **Security validation** blocks path traversal attempts in mapping filenames

## Docker Infrastructure & Deployment

### Container Architecture
- **Multi-stage builds** with shared Python base images for efficiency
- **Health checks** ensure services are ready before accepting requests
- **Internal networking** - only gateway exposed on port 8002
- **Volume mounts** for development with live code reloading
- **Environment variables** for service URL configuration

### Make Commands for Operations
```bash
# Build and start all services
make build && make up

# Test individual conversions
make test-pdf-json    # PDF → JSON conversion
make test-json-xml    # JSON → XML conversion  
make test-pdf-xml     # Full PDF → XML pipeline

# Monitor system
make logs             # View gateway logs
make down             # Stop all services
make clean            # Remove containers and images
```

## Integration Ready

**Current Status**: ✅ **Production Ready**
- All core processing services implemented and tested
- API gateway with comprehensive validation and error handling
- Docker orchestration with health checks and service dependencies
- Security hardening with input validation and path traversal protection
- Complete test suite with verified results on real invoice data

**Usage**: System exposes single endpoint at `http://localhost:8002/process` that handles all conversion workflows based on file type and Accept headers.