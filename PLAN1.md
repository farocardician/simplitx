# Single `/process` Gateway Implementation Plan - Final Structure

## Architecture Overview
Create a unified `/process` endpoint that handles PDF→JSON, JSON→XML, and PDF→XML conversions based on input file type and Accept headers, using a multi-stage Docker build strategy with shared minimal base image.

## Final Directory Structure

```
/workspace/
├── docker/
│   ├── python/
│   │   ├── Dockerfile.base              # Minimal Python base + common deps only
│   │   ├── requirements-base.txt        # fastapi, uvicorn[standard], httpx, python-multipart, pydantic
│   │   ├── requirements-worker.txt      # pdfminer.six, pdfplumber, camelot-py, opencv-python-headless, pytesseract, ghostscript, python-dateutil
│   │   └── requirements-json2xml.txt    # lxml
│   ├── worker.Dockerfile                # FROM base → add PDF processing deps + copy pdf2json service
│   ├── json2xml.Dockerfile              # FROM base → add lxml + copy json2xml service  
│   └── gateway.Dockerfile               # FROM base → copy gateway service
├── services/
│   ├── pdf2json/                        # Renamed from worker/ (existing PDF→JSON service)
│   │   ├── main.py                      # Existing FastAPI app - adapt paths
│   │   ├── processor.py                 # Existing - no changes needed
│   │   ├── cli/                         # Existing directory structure
│   │   ├── stages/                      # Existing directory structure  
│   │   └── ...                          # All existing worker files moved here
│   ├── json2xml/
│   │   ├── main.py                      # New FastAPI /process endpoint
│   │   ├── json2xml/                    # Complete json2xml library copied locally
│   │   │   ├── __init__.py
│   │   │   ├── converter.py
│   │   │   ├── formatting.py
│   │   │   ├── mapping.py
│   │   │   └── ...
│   │   └── mappings/                    # All mapping files copied locally
│   │       └── pt_simon_invoice_v1.json
│   └── gateway/
│       └── main.py                      # New FastAPI gateway with routing logic
├── docker-compose.yaml                  # Only exposes gateway :8002, includes healthchecks
├── Makefile                             # Convenience build/run targets
└── README.md                            # Updated documentation
```

## Container Architecture

### 1. Base Image (`docker/python/Dockerfile.base`)
- **Minimal**: Python 3.11-slim + basic system tools only
- **No heavy dependencies**: PDF processing tools go in worker.Dockerfile only
- Common web dependencies: FastAPI, uvicorn, httpx, pydantic
- Shared by all service containers for efficient caching

### 2. PDF2JSON Container (Internal Port 8000)
- FROM base → add PDF processing system dependencies + Python packages
- Copy `/services/pdf2json/` → `/app/`
- **Heavy deps**: ghostscript, poppler-utils, tesseract-ocr, opencv, camelot, etc.
- **Healthcheck**: GET /health endpoint
- Internal service only

### 3. JSON2XML Container (Internal Port 8000)  
- FROM base → add lxml package only
- Copy `/services/json2xml/` → `/app/` (includes local json2xml lib + mappings)
- **Lightweight**: Only lxml added to base
- **Healthcheck**: GET /health endpoint  
- Internal service only

### 4. Gateway Container (External Port 8000)
- FROM base (no additional packages needed)
- Copy `/services/gateway/` → `/app/`
- **Depends on**: pdf2json and json2xml services (service_healthy)
- **Only exposed port** - single entry point

## Implementation Steps

### Step 1: Create Docker Structure

**Base Dockerfile** (`docker/python/Dockerfile.base`):
```dockerfile
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY docker/python/requirements-base.txt /tmp/requirements.txt
RUN pip install --upgrade pip && pip install -r /tmp/requirements.txt
RUN useradd -m appuser
USER appuser
```

**Requirements files**:
- `requirements-base.txt`: fastapi>=0.104.0, uvicorn[standard]>=0.24.0, httpx>=0.25.0, python-multipart>=0.0.6, pydantic>=2.0.0
- `requirements-worker.txt`: All existing PDF processing packages
- `requirements-json2xml.txt`: lxml>=4.9.3

**Service Dockerfiles**:
- `docker/worker.Dockerfile`: FROM base → add system deps + worker requirements → copy pdf2json service
- `docker/json2xml.Dockerfile`: FROM base → add lxml → copy json2xml service  
- `docker/gateway.Dockerfile`: FROM base → copy gateway service

### Step 2: Reorganize Services

**Move and rename**:
- `worker/` → `services/pdf2json/`
- Update any imports/paths in `services/pdf2json/main.py` if needed
- Add healthcheck endpoint to existing FastAPI app

**Copy json2xml library locally**:
- `json2xml/` → `services/json2xml/json2xml/` (complete copy, no symlinks)
- `json2xml/mappings/` → `services/json2xml/mappings/` (complete copy)
- Consistent service layout matching pdf2json structure

### Step 3: Service Implementations

**PDF2JSON Service** (add to existing `services/pdf2json/main.py`):
```python
@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "pdf2json"}
```

**JSON2XML Service** (`services/json2xml/main.py`):
only allow filenames that exist under ./mappings and match ^[A-Za-z0-9_.\-]+$. Reject .. traversal. This prevents path escape.
```python
@app.post("/process")
async def process_json_to_xml(
    file: UploadFile = File(...),
    mapping: str = Form(...), 
    pretty: str = Form("0")
):
    # Load JSON from uploaded file
    # Load mapping from local mappings/ directory
    # Convert using local json2xml library
    # Return XML with proper content-type

@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "json2xml"}
```

**Gateway Service** (`services/gateway/main.py`):
Gateway rules (enforce strictly)
• Accept must be application/json or application/xml → return 406 otherwise.
• mapping required only when XML is requested → 400 if missing.
• Reject JSON uploads with Accept: application/json (not supported) → 406.
• Add MAX_UPLOAD_MB cap → 413 if exceeded.
```python
@app.post("/process")
async def unified_process(
    file: UploadFile = File(...),
    mapping: Optional[str] = Form(None),
    pretty: str = Form("0"),
    request: Request
):
    # Route based on content-type and Accept header
    # Forward to appropriate backend service
    # Stream response with proper headers and X-Stage
```

### Step 4: Docker Compose Configuration
```yaml
services:
  pdf2json:
    build:
      context: .
      dockerfile: docker/worker.Dockerfile
    volumes:
      - ./services/pdf2json:/app
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    # NO external port exposure
    
  json2xml:
    build:
      context: .
      dockerfile: docker/json2xml.Dockerfile
    volumes:
      - ./services/json2xml:/app
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
    # NO external port exposure
    
  gateway:
    build:
      context: .
      dockerfile: docker/gateway.Dockerfile
    volumes:
      - ./services/gateway:/app
    ports:
      - "8002:8000"
    environment:
      - PDF2JSON_URL=http://pdf2json:8000
      - JSON2XML_URL=http://json2xml:8000
    depends_on:
      pdf2json:
        condition: service_healthy
      json2xml:
        condition: service_healthy
```

### Step 5: Gateway Routing Logic
1. **PDF + Accept: application/json** → Forward to pdf2json service
2. **PDF + Accept: application/xml + mapping** → pdf2json → json2xml pipeline, set `X-Stage: pdf2json,json2xml`  
3. **JSON + Accept: application/xml + mapping** → Forward to json2xml service, set `X-Stage: json2xml`
4. **Error handling**: 400 (missing mapping), 406 (bad Accept), 415 (bad file type), 413 (too large), 502 (downstream failure)

### Step 6: Convenience Tools

**Makefile**:
```makefile
.PHONY: build up down logs clean test-pdf-json test-json-xml test-pdf-xml

build:
	docker-compose build

up:
	docker-compose up -d

down:
	docker-compose down

logs:
	docker-compose logs -f gateway

clean:
	docker-compose down -v --rmi all

test-pdf-json:
	curl -sS -X POST \
	  -F 'file=@pdf/2508070002.pdf;type=application/pdf' \
	  -H 'Accept: application/json' \
	  http://localhost:8002/process > /tmp/test-output.json

test-json-xml:
	curl -sS -X POST \
	  -F 'file=@pdf/2508070002.json;type=application/json' \
	  -F 'mapping=pt_simon_invoice_v1.json' \
	  -F 'pretty=1' \
	  -H 'Accept: application/xml' \
	  http://localhost:8002/process > /tmp/test-output.xml

test-pdf-xml:
	curl -sS -X POST \
	  -F 'file=@pdf/2508070002.pdf;type=application/pdf' \
	  -F 'mapping=pt_simon_invoice_v1.json' \
	  -F 'pretty=1' \
	  -H 'Accept: application/xml' \
	  http://localhost:8002/process > /tmp/test-output.xml
```

## API Contract (Unchanged)
All curl commands work identically, targeting localhost:8002/process with appropriate form data and headers.

## Benefits
- ✅ No symlinks - consistent service layout across pdf2json and json2xml
- ✅ Minimal base image with heavy deps isolated to specific services
- ✅ Healthchecks prevent gateway startup failures
- ✅ Complete local copies avoid volume mounting complexity
- ✅ Efficient Docker layer caching with shared base
- ✅ Cross-platform compatibility (Mac/Linux/CI)
- ✅ Single exposed port (8002) for security
- ✅ Clean microservices architecture