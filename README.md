# PDF Processing Gateway

A unified gateway service that provides PDF→JSON, JSON→XML, and PDF→XML conversions through a single `/process` endpoint.

## Architecture

- **Gateway Service** (Port 8002) - Single exposed endpoint that routes requests
- **PDF2JSON Service** (Internal) - Converts PDF files to structured JSON
- **JSON2XML Service** (Internal) - Converts JSON to XML using mapping configurations
- **Docker Compose** - Orchestrates all services with health checks

## Quick Start

```bash
# Build and start all services
make build
make up

# Check logs
make logs

# Stop services
make down
```

## API Usage

### PDF → JSON
```bash
curl -sS -X POST \
  -F 'file=@pdf/2508070002.pdf;type=application/pdf' \
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
  -F 'file=@pdf/2508070002.pdf;type=application/pdf' \
  -F 'mapping=pt_simon_invoice_v1.json' \
  -F 'pretty=1' \
  -H 'Accept: application/xml' \
  http://localhost:8002/process > output.xml
```

## Gateway Rules

- **Accept Headers**: Must be `application/json` or `application/xml`
- **File Types**: Only PDF and JSON files supported
- **Mapping**: Required when requesting XML output
- **Security**: Mapping filenames validated, no path traversal allowed
- **File Size**: Default 50MB limit (configurable via `MAX_UPLOAD_MB`)

## Error Codes

- `400` - Missing mapping parameter or invalid request
- `406` - Invalid Accept header or unsupported conversion
- `413` - File too large
- `415` - Unsupported file type
- `502` - Backend service error

## Testing

```bash
# Test all conversions
make test-pdf-json    # PDF → JSON
make test-json-xml    # JSON → XML  
make test-pdf-xml     # PDF → XML (pipeline)
```

## Development

```bash
# Clean rebuild
make clean
make build
make up

# View gateway logs
make logs
```

## Directory Structure

```
/workspace/
├── docker/                    # Docker build configurations
│   ├── python/               # Base Docker requirements
│   ├── worker.Dockerfile     # PDF2JSON service build
│   ├── json2xml.Dockerfile   # JSON2XML service build
│   └── gateway.Dockerfile    # Gateway service build
├── services/
│   ├── pdf2json/             # PDF→JSON processing service
│   ├── json2xml/             # JSON→XML conversion service  
│   └── gateway/              # Unified API gateway service
├── pdf/                      # Sample test files
├── docker-compose.yaml       # Service orchestration (only gateway exposed)
├── Makefile                  # Development convenience commands
├── PLAN1.md                  # Implementation plan documentation
└── README.md                 # This file
```

## Security Features

- Non-root user in containers
- No external ports for internal services
- Input validation and sanitization
- Path traversal protection
- File size limits