# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Architecture

This is a microservices-based PDF processing system with a web frontend. The system consists of:

### Core Services
- **Web UI** (Next.js + TypeScript): Frontend application with file upload and job management at `services/web/`
- **Worker** (Node.js): Background job processor that polls for queued jobs at `services/worker/`
- **Gateway** (Python FastAPI): Unified API gateway routing requests to processing services at `services/gateway/`
- **PDF2JSON** (Python FastAPI): PDF document processing service with 10-stage pipeline at `services/pdf2json/`
- **JSON2XML** (Python FastAPI): JSON to XML conversion service with mapping support at `services/json2xml/`

### Database & Storage
- **PostgreSQL**: Job queue and metadata storage with Prisma ORM
- **File System**: Local storage for uploads (`uploads/`) and results (`results/`)

### Processing Pipeline
1. User uploads PDF via web interface
2. File stored in `uploads/`, job created with `queued` status
3. Worker polls database, acquires job with lease-based concurrency
4. Worker calls Gateway service with PDF file and mapping configuration
5. Gateway routes to PDF2JSON service (10-stage processing pipeline)
6. Optionally chains to JSON2XML service for final XML output
7. Results stored in `results/`, job marked as `complete`

## Common Development Commands

### Docker Environment
```bash
# Development environment (with hot reload)
./scripts/dev.sh
# OR
docker-compose -f docker-compose.yaml -f docker-compose.development.yml up --build

# Production environment
./scripts/prod.sh
# OR
docker-compose -f docker-compose.yaml -f docker-compose.production.yml up --build -d

# Clean rebuild
make clean && make build && make up

# View logs
make logs
docker-compose logs -f gateway
```

### Web Service (Next.js)
```bash
cd services/web
npm run dev        # Development server
npm run build      # Production build
npm run start      # Start production server
npm run lint       # ESLint
```

### Worker Service (Node.js)
```bash
cd services/worker
npm run dev        # Development with nodemon
npm start          # Production
npm run build      # TypeScript compilation
npm test           # Jest tests
```

### Database Management
```bash
cd services/web
npx prisma migrate dev     # Run migrations (development)
npx prisma generate        # Generate Prisma client
npx prisma studio          # Database browser
npx prisma db push         # Push schema changes (development)
```

### API Testing
```bash
# Test PDF → JSON conversion
make test-pdf-json

# Test JSON → XML conversion  
make test-json-xml

# Test full PDF → XML pipeline
make test-pdf-xml
```

## Key Technical Details

### Session Management
- Session-based file isolation using `lib/session.ts`
- Jobs are scoped to `ownerSessionId` to prevent cross-user access

### Job Processing Architecture
- Database-driven job queue with optimistic locking (`FOR UPDATE SKIP LOCKED`)
- Worker uses lease-based concurrency with 5-minute timeout
- Job states: `uploaded` → `queued` → `processing` → `complete`/`failed`

### File Handling & Security
- 50MB file size limit (configurable via `MAX_UPLOAD_MB`)
- SHA256-based deduplication prevents duplicate processing
- Path traversal protection for mapping filenames
- Non-root containers with restricted permissions

### API Gateway Rules
- Strict Accept header validation (`application/json` or `application/xml`)
- File type validation (PDF/JSON only)
- Mapping parameter required for XML output
- Automatic routing: PDF→JSON, JSON→XML, or PDF→JSON→XML pipeline

### Database Schema
- Primary model: `Job` with status tracking, file metadata, and processing timestamps
- Unique constraint on `(ownerSessionId, sha256, mapping, bytes)` for deduplication
- Indexed on `status`, `createdAt`, and `leaseExpiresAt` for efficient queries

## Development Environment Setup

The project uses Docker Compose with development and production overrides:
- Development: Volume mounts for hot reload, exposed ports for debugging
- Production: Built images, optimized for deployment

Services communicate via internal Docker network. Only Gateway (8002) and Web (3000) are externally exposed.

## File Locations

### Configuration
- Docker: `docker/` directory with service-specific Dockerfiles
- Compose: Base config in `docker-compose.yaml`, environment-specific in `docker-compose.{development,production}.yml`
- Database: Prisma schema at `services/web/prisma/schema.prisma`

### Processing Pipeline
- PDF processing stages: `services/pdf2json/stages/s01_*.py` through `s10_*.py`
- XML mapping configurations: `services/json2xml/mappings/*.json`
- Template rules: `services/pdf2json/rules/templates/`

## Port Mapping
- 3000: Web UI
- 5432: PostgreSQL
- 8002: Gateway API (external)
- Internal services run on port 8000 within Docker network