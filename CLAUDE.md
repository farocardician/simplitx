# Simplitx - Invoice Processing Platform

> **Last Updated**: December 3, 2025
> **Version**: 2.1
> **For**: AI Assistants (Claude, GPT, etc.)

## What is this?

Simplitx is an **invoice processing and data extraction platform** that automates the conversion of invoice documents (PDFs and Excel spreadsheets) into structured XML/database records. The system handles multiple vendors with different invoice formats, with a focus on Indonesian tax invoices (e-Faktur).

**Core Purpose**: Convert unstructured invoice documents → normalized, validated tax invoice data → suitable for downstream systems (tax filing, accounting, supply chain).

## Quick Facts

- **Primary Languages**: Python (backend services), TypeScript (frontend)
- **Frameworks**: Next.js 14 (App Router), FastAPI
- **Database**: PostgreSQL 15 with Prisma ORM
- **Architecture**: Microservices (Docker Compose)
- **Key Pattern**: Config-driven, multi-stage pipelines
- **Vendors Supported**: 12+ (Sensient, Simon, Stahl, Silesia, Rittal, etc.)

## How to Run

```bash
# Start all services
docker-compose -f docker-compose.yaml -f docker-compose.development.yml up -d

# Access web UI
open http://localhost:3000

# View logs
docker-compose logs -f web

# Run database migrations (from inside web container)
docker exec simplitx-web-1 npx prisma migrate dev

# Or enter container and run commands
docker exec -it simplitx-web-1 sh
```

## Running Pipelines

### Quick Test: Gateway API (PDF → JSON → XML)

Process a PDF through the complete pipeline in one API call:

```bash
# Process PDF through gateway (automatic pipeline)
curl -X POST http://localhost:8002/process \
  -H "Accept: application/xml" \
  -F "file=@/path/to/invoice.pdf;filename=test-invoice.pdf" \
  -F "template=invoice_pt_sil.json" \
  -F "pretty=1" \
  --connect-timeout 60 \
  --max-time 180 \
  -o output.xml

# Parameters:
# - template: Config from services/config/ (defines pipeline stages and json2xml profile)
# - mapping: Only needed when you pass JSON directly; ignored when template is present
# - pretty: Format XML with indentation
# - Timeout: 180s max (PDF processing can be slow)
# - Accept header: must be exactly application/xml or application/json (gateway rejects others)
# - Upload limit: gateway enforces MAX_UPLOAD_MB (default 50MB)
```

### Manual Pipeline: Run Stages Individually

For debugging or testing specific stages, run the PDF→JSON pipeline manually:

```bash
# Set variables for your test case
CLIENT=sil        # Client name (sil, esi, simon, etc.)
VARIANT=1         # Variant number
SUBFOLDER=training

# Stage 1: Tokenize PDF (extract text with positions)
docker exec simplitx-pdf2json-1 python3 /app/stages/s01_tokenizer.py \
  --in /app/$SUBFOLDER/$CLIENT/$VARIANT/$VARIANT.pdf \
  --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s01.json

# Stage 2: Normalize tokens (Unicode cleanup, decimal fixes)
docker exec simplitx-pdf2json-1 python3 /app/stages/s02_normalizer.py \
  --in /app/$SUBFOLDER/$CLIENT/$VARIANT/s01.json \
  --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s02.json

# Stage 3: Segment into bands (header/content/footer)
docker exec simplitx-pdf2json-1 python3 /app/stages/s03_segmenter.py \
  --in /app/$SUBFOLDER/$CLIENT/$VARIANT/s02.json \
  --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s03.json \
  --config /app/config/s03_invoice_${CLIENT}_segmenter_v1.json \
  --overlay /app/$SUBFOLDER/$CLIENT/$VARIANT/$VARIANT.pdf \
  --tokenizer plumber

# Stage 7: Extract header fields
docker exec simplitx-pdf2json-1 python3 /app/stages/s07_extractor.py \
  --tokens /app/$SUBFOLDER/$CLIENT/$VARIANT/s02.json \
  --tokenizer plumber \
  --segments /app/$SUBFOLDER/$CLIENT/$VARIANT/s03.json \
  --config /app/config/s07_invoice_${CLIENT}_extractor_v1.json \
  --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s07.json

# View results
docker exec simplitx-pdf2json-1 cat /app/$SUBFOLDER/$CLIENT/$VARIANT/s07.json | python3 -m json.tool | head -50
```

**Important Notes**:
- The `/app/training/` directory may be read-only. Use `/app/results/` or mount a writable volume for new outputs.
- Stage order comes from the pipeline config (`stages` array); stage numbers are sparse by design (e.g., S04/S05 may be unused for some vendors).
- Some stages (s04, s05, s06, s08, s09, s10) may not be configured for all clients.
- Check available configs before running all 10 stages:

```bash
# List available configs for a client
docker exec simplitx-pdf2json-1 ls /app/config/ | grep invoice_sil

# Check which stages are configured
docker exec simplitx-pdf2json-1 ls /app/config/ | grep -E "s0[4-9]|s10" | grep sil
```

### Upload via Web API

Upload and process via the web UI API:

```bash
# Upload Excel file
curl -X POST http://localhost:3000/api/upload-xls \
  -F "file=@/path/to/invoices.xlsx" \
  -F "template=invoice_pt_sensient.json"

# Upload PDF (queued for worker processing)
curl -X POST http://localhost:3000/api/upload \
  -F "file=@/path/to/invoice.pdf" \
  -F "template=invoice_pt_simon.json"
```

## Critical Paths

- **Invoice Configs**: `services/config/invoice_pt_*.json`
- **Database Schema**: `services/web/prisma/schema.prisma`
- **SQL Migrations**: `services/web/prisma/migrations/` (invoice tables, job_config, indexes)
- **Web UI**: `services/web/app/`
- **Pipeline Stages**: `services/pdf2json/stages/`, `services/xls2sql/stages/`
- **API Routes**: `services/web/app/api/`

---

## System Architecture

### Service Map

```
┌─────────────────────────────────────────────────────────────┐
│                       USER INTERFACES                        │
│  Web UI (Next.js) - Port 3000                               │
│  - Upload PDFs/Excel files                                   │
│  - Queue management (filtering, sorting)                     │
│  - Human review interface                                    │
│  - Download XML/CSV exports                                  │
└───────────────────┬─────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
┌───────▼────────┐     ┌────────▼────────┐
│  Worker         │     │  Gateway         │
│  (Node.js)      │     │  (Python/FastAPI)│
│  - Background   │     │  Port 8002       │
│    job processor│     │  - Route requests│
│  - Lease-based  │     │  - Chain services│
└────────┬────────┘     └─────────┬────────┘
         │                        │
         └────────┬───────────────┘
                  │
      ┌───────────┼──────────────────────┐
      │           │                      │
┌─────▼──────┐ ┌──▼────────┐  ┌────────▼──────┐
│ PDF2JSON   │ │ JSON2XML   │  │ SQL2XML       │
│ Port 8000  │ │ Port 8000  │  │ Port 8012     │
│ - 11 stages│ │ - Jinja2   │  │ - DB → XML    │
│ - Geometry │ │   templates│  │ - DB → CSV    │
└─────┬──────┘ └────────────┘  └───────────────┘
      │
┌─────▼──────┐    ┌──────────┐    ┌──────────┐
│ XLS2SQL    │    │ Kurs Pajak│    │ Reranker │
│ Port 8011  │    │ Port 8010 │    │ Port 9000│
│ - 3 stages │    │ - Tax FX  │    │ - ML     │
└────────────┘    └───────────┘    └──────────┘
      │
┌─────▼──────────────────────────────────────┐
│         PostgreSQL 15                       │
│  - tax_invoices, tax_invoice_items         │
│  - parties, hs_codes, uom_aliases          │
│  - jobs, parser_results                    │
└────────────────────────────────────────────┘
```

### Data Flows

**Flow 1: PDF Upload → XML**
```
User uploads PDF → Web UI stores file → Worker polls job →
Worker calls Gateway → Gateway chains (PDF2JSON → JSON2XML) →
Result saved → User downloads XML
```

**Flow 2: Excel Import → Database → Queue**
```
User uploads Excel → XLS2SQL Stage 1 (parse) →
Stage 2 (validate + resolve buyers) →
Stage 3 (build normalized invoices) →
Invoices appear in Queue V2
```

**Flow 3: Queue → Review → Approved XML**
```
User reviews invoice in UI → Edits fields →
Saves to product library → Approves →
SQL2XML generates final XML from database
```

### Technology Stack

**Frontend**
- Next.js 14 (App Router), React 18, TypeScript 5
- TailwindCSS, Headless UI
- Prisma Client, React Hook Form

**Backend Services**
- Python: FastAPI, Uvicorn, pdfplumber, Camelot
- Node.js: Express-like API routes in Next.js
- Worker: Node.js with Prisma

**Database**
- PostgreSQL 15
- Prisma ORM (migrations, type-safe queries)
- Direct psycopg connections (Python services)

**Infrastructure**
- Docker & Docker Compose
- Alpine-based images (Python 3.11, Node 20)
- Shared volumes for file storage

---

## Core Concepts You Must Understand

### Config-Driven Architecture

**Every vendor has a config file** that defines its entire processing pipeline:

```javascript
// services/config/invoice_pt_sensient.json
{
  "enabled": true,
  "document": { "type": "invoice", "vendor": "PT Sensient" },
  "ingestion": {
    "type": "xls",  // or "pdf"
    "pipeline": "xls2sql",
    "stages": [...]  // Pipeline stage scripts
  },
  "queue": { "version": "v2", "filter": { "tin": "..." } },
  "seller": { "id": "uuid", "tax_invoice_opt": "Normal" },
  "tax": { "vat_rate": 12 },
  "rounding": { "qty": { "scale": 3 }, ... },
  "sql2xml": { "mapping": {...} },  // XML generation rules
  "sql2csv": { "enabled": true, "mapping": {...} }  // CSV generation rules
}
```

**Key Principle**: Add new vendors by creating configs, not writing code.

### Multi-Stage Pipeline Pattern

Documents flow through **deterministic, sequential stages**:

**PDF Pipeline (pdf2json, config-driven):**
```
S01 Tokenize → S02 Normalize → S03 Segment →
[opt] S04 Camelot/RAG tables →
S06 Line items from cells → S07 Extract fields →
S08 Validate → S09 Confidence → S10 Parser (final JSON)
```
Stage order lives in `services/config/invoice_pt_*.json` (`stages` array); some pipelines skip optional stages.

**Excel Pipeline (xls2sql):**
```
S01: Import → S02: Validate & Resolve → S03: Build Invoices
```

Each stage:
- Produces verifiable artifacts
- Logs results
- Can fail independently
- Is idempotent where possible

### Vendor-Specific Processing

12+ vendors, each with unique formats:
- **PDF-based**: Simon, Rittal, Silesia (use pdf2json)
- **Excel-based**: Sensient, Stahl, ESI, Kass, Kemas (use xls2sql)
- **Config location**: `services/config/invoice_pt_<vendor>.json`

### Party Resolution & Fuzzy Matching

Invoices reference buyers/sellers by name. The system:
1. Looks up exact match in `parties` table
2. Falls back to fuzzy matching (fuzzywuzzy, threshold 70%)
3. Stores confidence score for review
4. Links invoice to `buyer_party_id`

### Human-in-the-Loop Review

Review V2 system allows humans to:
- Validate extracted data
- Edit fields (HS code, UOM, amount, description)
- Save to **product information library** (future suggestions)
- Approve → generates final XML from database via SQL2XML

---

## Directory Structure & Navigation

### Where to Find Things

```
simplitx/
├── services/
│   ├── config/               # ⭐ Vendor pipeline configs (12 files)
│   ├── web/                  # ⭐ Next.js web UI
│   │   ├── app/             # App Router pages
│   │   │   ├── api/         # API routes
│   │   │   ├── queue-v2/    # Queue management UI
│   │   │   └── review/      # Review interface
│   │   ├── prisma/          # ⭐ Database schema & migrations
│   │   └── lib/             # Utilities (partyResolver, etc.)
│   ├── pdf2json/            # PDF → JSON extraction
│   │   ├── stages/          # ⭐ Pipeline stage scripts (config-driven S01-S10)
│   │   └── config/          # Segmenter/extractor/line-item/parser configs
│   ├── json2xml/            # JSON → XML conversion
│   │   └── mappings/        # XML templates
│   ├── sql2xml/             # DB → XML/CSV export
│   │   ├── sql2xml/         # ⭐ Core export logic
│   │   └── cli.py           # Command-line interface
│   ├── xls2sql/             # Excel → Database
│   │   ├── stages/          # ⭐ S01-S03 pipeline
│   │   └── training/        # Sample Excel files
│   ├── worker/              # Background job processor
│   ├── gateway/             # Service router
│   └── kurs_pajak/          # Tax exchange rates
├── docker/                  # Dockerfiles
├── uploads/                 # Shared volume (PDFs/Excel)
├── results/                 # Shared volume (generated XML)
└── CLAUDE.md               # ⭐ This file
```

### Service Breakdown

| Service | Location | Port | Purpose | Entry Point |
|---------|----------|------|---------|-------------|
| **Web** | `services/web/` | 3000 | UI & API routes | `app/layout.tsx` |
| **PDF2JSON** | `services/pdf2json/` | 8000 | PDF extraction | `main.py` |
| **JSON2XML** | `services/json2xml/` | 8000 | JSON→XML | `main.py` |
| **SQL2XML** | `services/sql2xml/` | 8012 | DB→XML/CSV | `main.py`, `cli.py` |
| **XLS2SQL** | `services/xls2sql/` | 8011 | Excel→DB | `stages/s01_*.py` |
| **Worker** | `services/worker/` | - | Job processor | `src/index.js` |
| **Gateway** | `services/gateway/` | 8002 | Router | `main.py` |
| **Kurs Pajak** | `services/kurs_pajak/` | 8010 | Tax rates | `main.py` |

---

## How to... (Common AI Tasks)

### Add a New Vendor

**1. Create config file:**
```bash
cp services/config/invoice_pt_sensient.json services/config/invoice_pt_newvendor.json
```

**2. Edit config:**
- Change `document.vendor` name
- Update `seller.id` (create party in database first)
- Adjust `queue.filter.tin` to seller TIN
- For Excel configs: update `ingestion.type`/`pipeline`/`stages`
- For PDF configs: update top-level `stages` (scripts + args placeholders)
- Configure `sql2xml.mapping` for XML structure
- (Optional) Add `sql2csv.mapping` for CSV export

**3. If Excel-based:**
- Create stage scripts in `services/xls2sql/stages/s01_postgreimport_newvendor.py`
- Follow pattern from `s01_postgreimport_sensient.py`

**4. If PDF-based:**
- Add segmenter/extractor/line-item configs under `services/pdf2json/config/` (e.g., `s03_invoice_<vendor>_segmenter_v1.json`, `s06_invoice_<vendor>_lineItem_v1.json`, `s07_invoice_<vendor>_extractor_v1.json`, `s10_invoice_<vendor>_parser_v1.json`)
- Reference those configs from the vendor's `stages` array in `services/config/invoice_pt_<vendor>.json`

**5. Test:**
```bash
# For Excel (from inside xls2sql container)
docker exec simplitx-xls2sql-1 python3 /app/stages/s01_postgreimport_newvendor.py /uploads/test.xlsx

# For PDF (from host, calls gateway service)
curl -X POST http://localhost:8002/process \
  -H "Accept: application/xml" \
  -F "file=@test.pdf" \
  -F "template=invoice_pt_newvendor.json" \
  -F "pretty=1"

# Or upload via web UI
curl -X POST http://localhost:3000/api/upload-xls \
  -F "file=@test.xlsx" \
  -F "template=invoice_pt_newvendor.json"
```

### Modify Invoice Validation

**File**: `services/xls2sql/stages/s02_validate_resolve_*.py`

**Key functions**:
- `validate_row()`: Field-level validation
- `resolve_buyer_party()`: Fuzzy match buyers to parties table
- `check_hs_code()`: Validate HS codes against database

**To add validation**:
1. Add check in `validate_row()`
2. Append error to `validation_errors` list
3. Return errors for logging

### Add a Database Field

**Prisma-managed tables (jobs/parties/products, etc.):**
1) Update `services/web/prisma/schema.prisma`.
2) Run `npx prisma migrate dev --name add_<field>` (inside the web container).
3) Regenerate client: `npx prisma generate`.
4) Update TypeScript/Node code that reads the model.

**Invoice tables (`tax_invoices`, `tax_invoice_items`, `job_config`):**
- These are raw SQL tables not modeled in `schema.prisma`; add a new `.sql` migration under `services/web/prisma/migrations/`.
- Keep the `tax_invoices_enriched` view in sync when adding seller/buyer-derived fields.
- Update ingest/export code that touches the column: `services/xls2sql/stages/`, `services/sql2xml/`, and related web API routes.

### Debug a Pipeline Stage

**1. Check stage output:**
```bash
# PDF pipeline artifacts (from host, shared volume)
ls results/<job_id>/stages/

# Excel pipeline (query from postgres container)
docker exec simplitx-postgres-1 psql -U postgres -d pdf_jobs -c \
  "SELECT * FROM temporaryStaging WHERE job_id = 'xxx' LIMIT 10;"
```

**2. View logs:**
```bash
docker-compose logs -f pdf2json
docker-compose logs -f xls2sql
```

**3. Run stage manually:**
```bash
# Excel stage (enter container)
docker exec -it simplitx-xls2sql-1 sh
cd /app
python3 stages/s02_validate_resolve_sensient.py --job-id xxx --dry-run

# Or run directly
docker exec simplitx-xls2sql-1 python3 /app/stages/s02_validate_resolve_sensient.py --job-id xxx --dry-run
```

### Add a New Export Format

**Reference**: `services/sql2xml/sql2xml/csv_exporter.py`

**Steps**:
1. Create `<format>_exporter.py` in `services/sql2xml/sql2xml/`
2. Define `export_invoices_to_<format>()` function
3. Reuse `build_invoice_payload()` from `exporter.py`
4. Add config section to vendor configs: `sql2<format>`
5. Update `main.py` to check `sql2<format>.enabled`
6. Package multiple formats in ZIP if needed

**Example**:
```python
# services/sql2xml/sql2xml/json_exporter.py
from .exporter import build_invoice_payload, fetch_invoices

def export_invoices_to_json(invoice_ids, pipeline):
    config = load_pipeline_config(pipeline)
    # ... fetch data, build payloads, return JSON
```

---

## Database Schema Quick Reference

### Core Tables

**`tax_invoices`**
- **Columns**: id (uuid), job_id (uuid FK job_config), invoice_number, buyer_party_id, tax_invoice_date, tax_invoice_opt, add_info, custom_doc, custom_doc_month_year, ref_desc, facility_stamp, is_complete, missing_fields (jsonb), created_at, updated_at
- **Purpose**: Normalized invoice headers; buyer comes from `buyer_party_id`, seller metadata comes via `job_config.seller_id`
- **Constraint**: UNIQUE (invoice_number, buyer_party_id)

**`tax_invoice_items`**
- **Columns**: id, tax_invoice_id, line_number, opt, code (6-char HS), name, unit, price, qty, total_discount, tax_base, other_tax_base, vat_rate, vat, stlg_rate, stlg, created_at
- **Purpose**: Invoice line items with tax calculations; CASCADE on delete from `tax_invoices`

**`job_config`**
- **Columns**: job_id (uuid PK), config_name (pipeline filename), seller_id (FK parties.id), created_at
- **Purpose**: Maps a job/import to the pipeline config and seller party; used by `tax_invoices_enriched`

**`parties`**
- **Columns**: id, display_name, name_normalized, tin_normalized, buyer_document, buyer_document_number, buyer_idtku/seller_idtku, tax_invoice_opt, transaction_code, country_code, address_full, email, seller link
- **Purpose**: Buyer/seller entities used for fuzzy resolution and seller metadata

**`jobs`**
- **Columns**: id, owner_session_id, user_id, original_filename, content_type, bytes, sha256, mapping (selected template), status, upload_path/result_path/artifact_path, lease fields, timestamps, approval + buyer resolution fields
- **Purpose**: Upload/processing queue for PDFs; UNIQUE on (owner_session_id, sha256, mapping, bytes)

**`tax_invoices_enriched`** (VIEW)
- **Purpose**: Read-only projection joining `tax_invoices` + buyer `parties` + seller `parties` (via `job_config`) + config name
- **Use**: Primary view for queue/search/download endpoints

### Key Relationships

```
job_config ──┐
             ├─→ tax_invoices ──→ tax_invoice_items
parties (seller) ─┘            │
parties (buyer) ◀──────────────┘ (buyer_party_id)
```

### Critical Indexes

- `idx_tax_invoices_buyer_party_id`
- `idx_tax_invoices_job_id`
- `idx_tax_invoices_invoice_number`
- `idx_tax_invoices_date`
- `idx_tax_invoice_items_invoice_id`
- `idx_tax_invoice_items_code` (HS code lookups)

---

## API Endpoints Reference

### Web Service (Next.js) - Port 3000

**POST `/api/upload-xls`**
- **Purpose**: Upload Excel file for processing
- **Request**: FormData with `file` and `template` (config name)
- **Response**: `{ status: "ok", jobId: "uuid", invoices: [...] }`

**POST `/api/upload`**
- **Purpose**: Upload PDF and enqueue worker job
- **Request**: FormData with `file` (PDF) and `template` (pipeline config name), 100MB limit, deduped by (session, sha256, mapping)
- **Response**: `{ job: { id, filename, bytes, status, created_at }, duplicate?: true }`

**GET `/api/tax-invoices`**
- **Purpose**: List invoices with filtering/sorting/pagination
- **Query**: `seller_id`, `buyer_party_id`, `invoice_numbers`, `is_complete`, `sort`, `limit`, `offset`
- **Response**: Array of invoice objects

**POST `/api/tax-invoices/bulk-download`**
- **Purpose**: Download XML (+ CSV if enabled) as ZIP
- **Request**: `{ invoiceIds: ["uuid", ...] }`
- **Response**: ZIP file (application/zip) or XML (application/xml)
- **Validation**: Checks completeness, same buyer, same seller TIN, same job/config

**GET `/api/review-v2/[id]`**
- **Purpose**: Get invoice data for review interface
- **Response**: Invoice header + items + product suggestions

**PUT `/api/review-v2/[id]`**
- **Purpose**: Save reviewed invoice data
- **Request**: Updated invoice fields

### Internal Services

**pdf2json - POST `/process`**
- **Request**: PDF file + optional `template` (pipeline config from `services/config`)
- **Response**: JSON with extracted invoice data + confidence scores

**json2xml - POST `/process`**
- **Request**: JSON data + `pipeline` (pipeline config) and optional `profile` (default)
- **Response**: XML file

**sql2xml - POST `/export`**
- **Request**: `{ invoiceIds: [...], pipeline: "config.json", format: "xml|csv" }`
- **Response**: XML file, CSV file, or ZIP (based on config)

**gateway - POST `/process`**
- **Request**: PDF/JSON file + `template` (pipeline config); Accept must be `application/json` or `application/xml`
- **Response**: JSON (pdf2json) or XML (pdf2json → json2xml chain)

---

## Configuration System

### Config File Anatomy

```javascript
{
  // Vendor metadata
  "enabled": true,
  "document": {
    "type": "invoice",
    "vendor": "PT Vendor Name",
    "version": "1"
  },

  // Data ingestion pipeline
  "ingestion": {
    "type": "xls" | "pdf",  // Choose pipeline
    "pipeline": "xls2sql" | "pdf2json",
    "source": "services/xls2sql",  // Service path
    "stages": [  // Sequential processing stages
      {
        "script": "stages/s01_import.py",
        "args": ["{xls}", "--config", "{config}"],
        "outputs": ["job_id"]
      }
    ]
  },

  // Queue UI configuration
  "queue": {
    "version": "v2",
    "page": "/queue-v2",
    "data_source": "tax_invoices",
    "filter": { "tin": "0021164165056000" },  // Seller TIN filter
    "seller_name": "Display Name"
  },

  // Seller information
  "seller": {
    "id": "uuid-from-parties-table",
    "tax_invoice_opt": "Normal"
  },

  // Tax rules
  "tax": {
    "vat_rate": 12  // Percentage
  },

  // Decimal rounding rules
  "rounding": {
    "qty": { "scale": 3, "mode": "half_up" },
    "unit_price": { "scale": 2, "mode": "half_up" },
    "tax_base": { "scale": 2, "mode": "half_up" },
    "vat": { "scale": 2, "mode": "half_up" }
  },

  // XML generation mapping (JSONPath-based)
  "sql2xml": {
    "mapping": {
      "root": { "tag": "TaxInvoiceBulk", "nsmap": {...} },
      "structure": {
        "TIN": "$.data.invoice.tin",
        "ListOfTaxInvoice": {
          "TaxInvoice": {
            "TaxInvoiceDate": "$.data.invoice.tax_invoice_date",
            // ... more fields
          }
        }
      }
    }
  },

  // CSV generation (optional, NEW)
  "sql2csv": {
    "enabled": true,  // Enable CSV export
    "mapping": {
      "columns": [
        {
          "header": "opt",
          "source": "item",  // "item", "invoice", or "buyer"
          "path": "opt",  // Field name in payload
          "type": "string"  // "string", "decimal", "date", "expression"
        },
        {
          "header": "grand_total",
          "source": "item",
          "path": "grand_total",
          "type": "expression",
          "expr": "tax_base + vat + stlg",  // Calculated field
          "scale": 2
        }
      ],
      "format": {
        "delimiter": ",",
        "quoting": "minimal",
        "encoding": "utf-8"
      }
    }
  }
}
```

PDF pipeline configs also include top-level `stages` plus a `json2xml.profiles.default.mapping` entry used by the gateway for PDF→XML.

### Key Config Sections

- **`ingestion`**: XLS/PDF entrypoint plus `stages` with `args` placeholders (required)
- **`stages`** (top-level for PDF): Sequence of scripts and `args` used by pdf2json runner
- **`queue`**: UI routing and filtering (which invoices appear in queue)
- **`seller`**: Vendor metadata (party UUID, tax options)
- **`tax`**: Tax calculation rules (VAT rate, rounding precision)
- **`upload`**: Optional UI hints (`accept`, `endpoint`, `max_size_mb`)
- **`json2xml.profiles`**: Mapping/profile used by gateway for PDF→XML
- **`sql2xml.mapping`**: JSONPath-based XML generation rules
- **`sql2csv.mapping`**: Column definitions for CSV export

### Adding New Config Options

**Safe approach**:
1. Add optional field with default value
2. Update config loading code to handle missing field gracefully
3. Document in this file under "Recent Changes"

**Example**:
```python
# In Python service
discount_enabled = config.get("features", {}).get("discount", False)
```

---

## Patterns & Conventions

### Config-First Development

✅ **DO**: Add new fields to config files
```javascript
// services/config/invoice_pt_vendor.json
{ "features": { "auto_approve": true } }
```

❌ **DON'T**: Hardcode vendor-specific logic in code
```python
# Bad
if vendor == "Sensient":
    apply_special_rounding()
```

### Token-Based Truth (PDF Processing)

✅ **DO**: Trust pdfplumber tokens as ground truth
```python
# Get actual text from tokens
text = token["text"]
```

❌ **DON'T**: Hallucinate or infer values not in PDF
```python
# Bad - guessing missing data
if not invoice_number:
    invoice_number = f"INV-{random_number()}"
```

### Deterministic Processing

✅ **DO**: Use fixed seeds, sorted iteration, stable tie-breakers
```python
# Stable sorting
items = sorted(items, key=lambda x: (x["line"], x["code"]))

# Fixed random seed for testing
random.seed(42)
```

❌ **DON'T**: Introduce randomness or time-dependent behavior
```python
# Bad
items = random.shuffle(items)  # Non-deterministic
```

### Error Handling

**Standard error response format (JSON)**:
```javascript
{
  "error": {
    "code": "BUYER_MISMATCH",
    "message": "Cannot merge invoices with different buyers"
  },
  "details": {
    "invoices": ["25708001", "25708002"]
  }
}
```

**How to add validation**:
1. Check condition
2. Raise exception with code + message
3. Log error with context
4. Return structured error response

### Testing Approach

**Unit tests**: Python `pytest`, TypeScript `jest`
**Integration tests**: Use `training/` sample files
**Manual testing**: Docker Compose development environment

---

## Troubleshooting

### Common Issues & Solutions

**Issue**: Invoice not appearing in queue
- ✅ Check: `is_complete = true` in database
- ✅ Check: `job_config.config_name` matches vendor config
- ✅ Check: Queue filter `tin` matches invoice seller TIN
- **SQL Debug**:
  ```bash
  # Run from host
  docker exec simplitx-postgres-1 psql -U postgres -d pdf_jobs -c \
    "SELECT id, invoice_number, is_complete, missing_fields, tin FROM tax_invoices_enriched WHERE invoice_number = '25708001';"
  ```

**Issue**: Gateway returns 406/415
- ✅ Check: `Accept` header is exactly `application/json` or `application/xml`
- ✅ Check: PDF uploads use `template` (pipeline config) and content-type `application/pdf`
- ✅ Check: JSON uploads provide `pipeline`/`template` that exists in `services/config/`

**Issue**: XML download fails or returns JSON error
- ✅ Check: `sql2csv.enabled` flag in config (may cause ZIP instead of XML)
- ✅ Check: All selected invoices are complete
- ✅ Check: All invoices have same buyer (buyer_party_id)
- ✅ Check: All invoices have same seller TIN
- ✅ Check: All invoices share the same job/config (job_id) for SQL2XML export
- **API Debug**:
  ```bash
  curl -X POST http://localhost:3000/api/tax-invoices/bulk-download \
    -H "Content-Type: application/json" \
    -d '{"invoiceIds":["uuid"]}'
  ```

**Issue**: Excel import fails at Stage 2
- ✅ Check: Config file exists in `services/config/`
- ✅ Check: Sheet names match expected format
- ✅ Check: Buyer names can be resolved to `parties` table
- **Fuzzy Match Debug**:
  ```bash
  # Run from host
  docker exec simplitx-postgres-1 psql -U postgres -d pdf_jobs -c \
    "SELECT id, display_name FROM parties WHERE display_name ILIKE '%buyer name%';"
  ```

**Issue**: PDF extraction returns low confidence
- ✅ Check: PDF is text-based (not scanned image)
- ✅ Check: Segmenter config matches PDF layout
- ✅ Check: Anchor keywords are correct in config
- **Stage Debug**:
  ```bash
  # View intermediate artifacts
  ls results/<job_id>/stages/
  cat results/<job_id>/stages/s04-anchors.json
  ```

### Debug Commands

**View Docker logs**:
```bash
docker-compose logs -f <service-name>
docker-compose logs --tail=100 web
```

**Database queries**:
```bash
# Connect to PostgreSQL (interactive)
docker exec -it simplitx-postgres-1 psql -U postgres -d pdf_jobs

# Once inside psql, run queries:
# SELECT invoice_number, is_complete, missing_fields
# FROM tax_invoices_enriched
# WHERE is_complete = false LIMIT 10;

# Or run queries directly from host
docker exec simplitx-postgres-1 psql -U postgres -d pdf_jobs -c \
  "SELECT invoice_number, is_complete, missing_fields FROM tax_invoices_enriched WHERE is_complete = false LIMIT 10;"

# Check buyer resolution
docker exec simplitx-postgres-1 psql -U postgres -d pdf_jobs -c \
  "SELECT id, display_name, tin_normalized, country_code FROM parties WHERE display_name ILIKE '%search term%';"
```

**Service health checks**:
```bash
curl http://localhost:3000/api/healthz      # Web
curl http://localhost:8002/health           # Gateway
curl http://localhost:8012/health           # SQL2XML
```

---

## Recent Significant Changes

### Buyer/Seller normalization (December 2025)

**What**: Seller metadata now lives in `parties`; `job_config` links jobs to seller + config; `tax_invoices` no longer stores denormalized buyer/seller fields.

**Files**:
- `services/web/prisma/migrations/007_normalize_buyer_seller.sql`
- `services/xls2sql/stages/s01_postgreimport_*.py`, `s03_build_invoices.py` (persist seller_id into job_config, fetch buyer/seller from parties)
- `services/sql2xml/sql2xml/exporter.py` (reads from `tax_invoices_enriched`)
- Web APIs querying `tax_invoices_enriched` (queue, buyers, uploads, bulk download)

**Behavior**:
- `tax_invoices_enriched` view joins buyer/seller parties + job_config.
- XLS ingest writes `job_config.seller_id` from pipeline config, then resolves buyer/seller from parties when building invoices.
- SQL2XML/export endpoints rely on view fields (tin, seller_idtku, tax_invoice_opt, buyer details) instead of denormalized columns.

### CSV Export Feature (December 2024)

**What**: Config-driven CSV generation for invoice exports

**Files**:
- `services/sql2xml/sql2xml/csv_exporter.py` (NEW)
- `services/sql2xml/main.py` (modified)
- `services/web/app/api/tax-invoices/bulk-download/route.ts` (modified)
- `services/config/invoice_pt_sensient.json` (added `sql2csv` section)

**Config**:
```javascript
"sql2csv": {
  "enabled": true,
  "mapping": {
    "columns": [
      { "header": "opt", "source": "item", "path": "opt", "type": "string" },
      { "header": "price", "source": "item", "path": "price", "type": "decimal", "scale": 2 },
      { "header": "grand_total", "type": "expression", "expr": "tax_base + vat + stlg" }
    ]
  }
}
```

**Behavior**:
- When `sql2csv.enabled = true`, download returns ZIP with both XML and CSV
- When `sql2csv.enabled = false` or missing, download returns XML only
- CSV uses same data source as XML (database via `build_invoice_payload()`)
- Number formatting mirrors XML approach (Decimal → float → formatted with scale)

**How to enable for other vendors**: Edit vendor config, add `sql2csv` section

### Queue V2 Enhancements (November 2024)

**What**: Advanced filtering, sorting, and pagination

**Files**:
- `services/web/app/queue-v2/page.tsx`
- `services/web/app/api/tax-invoices/route.ts`

**Features**:
- Filter by: buyer, invoice numbers, completion status
- Sort by: date, invoice number, buyer name
- Selection modes: none, page, all (with excludes)
- Bulk operations: download, delete

### Review V2 System (October 2024)

**What**: Human-in-the-loop approval workflow

**Files**:
- `services/web/app/review/[id]/page.tsx`
- `services/web/app/api/review-v2/[id]/route.ts`
- Product information library tables

**Features**:
- Edit extracted invoice data
- Save to product library (HS codes, descriptions, UOMs)
- Approve/unapprove invoices
- Generate approved XML via SQL2XML

---

## Guidelines for AI Assistants

### Before Making Changes

1. **Read the relevant config file** (`services/config/invoice_pt_*.json`)
2. **Check existing patterns** in similar code (search for similar functionality)
3. **Verify database schema** impacts (`services/web/prisma/schema.prisma` for Prisma models, SQL migrations under `services/web/prisma/migrations/` for invoice tables)
4. **Consider backward compatibility** (will existing configs still work?)

### When Adding Features

1. **Make it config-driven** if vendor-specific
2. **Add validation** at all entry points (API routes, pipeline stages)
3. **Log important decisions** with structured logging
4. **Update this CLAUDE.md file** (add to "Recent Changes")

### Code Style

**Python**:
- Follow PEP 8
- Use type hints: `def process(data: Dict[str, Any]) -> Result:`
- Docstrings for public functions
- Use `logging` module, not `print()`

**TypeScript**:
- Use strict mode
- Explicit types: `const data: InvoiceData = ...`
- Prefer `const` over `let`
- Use Prisma types: `Prisma.TaxInvoice`

**SQL**:
- Use Prisma for schema definition and migrations
- Use raw SQL (`$queryRaw`) for complex queries only
- Always parameterize queries (prevent SQL injection)

### Testing Checklist

Before submitting changes:
- [ ] Does it work for all affected vendors?
- [ ] Are database migrations included (Prisma or SQL file under `services/web/prisma/migrations/`)?
- [ ] Is error handling comprehensive (try/catch, validation)?
- [ ] Are logs informative (include context like invoice_id, vendor)?
- [ ] Does it follow existing patterns in the codebase?
- [ ] Is the CLAUDE.md file updated?

---

## Critical Files Quick Reference

### Must-Read Files

1. **`services/web/prisma/schema.prisma`** - Database schema (source of truth)
2. **`services/config/invoice_pt_sensient.json`** - Example config (most complete)
3. **`services/pdf2json/PLAN.md`** - PDF pipeline architecture (detailed)
4. **`services/web/CONTEXT.md`** - Web service architecture
5. **`flow.md`** - High-level system flows

### Entry Points

- **Web UI**: `services/web/app/layout.tsx`
- **PDF Processing**: `services/pdf2json/main.py` → `processor.py`
- **Excel Import**: `services/xls2sql/stages/s01_postgreimport_*.py`
- **Worker**: `services/worker/src/index.js`
- **SQL2XML**: `services/sql2xml/main.py` → `sql2xml/exporter.py`

### Configuration Examples

- **PDF-based vendor**: `services/config/invoice_pt_simon.json`
- **Excel-based vendor**: `services/config/invoice_pt_sensient.json`
- **XML mapping**: `services/json2xml/mappings/`
- **Segmenter config**: `services/pdf2json/config/segmenter/`

---

## Keeping CLAUDE.md Updated

When you make significant changes:

1. **Update relevant section** in this file
2. **Add entry to "Recent Significant Changes"** with date and file paths
3. **Update file paths** if files were moved/renamed
4. **Refresh code examples** if APIs changed
5. **Commit with clear message**:
   ```bash
   git add CLAUDE.md
   git commit -m "docs: update CLAUDE.md - added XYZ feature documentation"
   ```

**Review this file**:
- Monthly: Check for accuracy
- After major features: Add documentation
- When onboarding: Read completely

---

## Additional Resources

- **Prisma Docs**: https://www.prisma.io/docs
- **Next.js Docs**: https://nextjs.org/docs
- **FastAPI Docs**: https://fastapi.tiangolo.com
- **pdfplumber**: https://github.com/jsvine/pdfplumber
- **Camelot**: https://camelot-py.readthedocs.io

---

**End of CLAUDE.md** - For questions or clarifications, refer to inline code comments or service-specific CONTEXT.md files.
