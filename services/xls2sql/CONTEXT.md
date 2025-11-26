# XLS to SQL Import Pipeline — Context

## Purpose
Ingest Sensient Excel workbooks into PostgreSQL and populate normalized tax invoice tables. The service exposes only a health endpoint; all work is done via the stage CLIs.

## Main Entry Points
- FastAPI health: `services/xls2sql/main.py` (`/health`)
- Stage 1 — import Excel ➜ staging: `services/xls2sql/stages/s01_postgreimport_sensient.py`
- Stage 2 — validate + resolve buyers: `services/xls2sql/stages/s02_validate_resolve_sensient.py`
- Stage 3 — build tax invoices/items: `services/xls2sql/stages/s03_build_invoices.py`

## Pipeline
1) Stage s01 — Excel ➜ `public."temporaryStaging"`
- Input: Sensient workbook (see `training/sen/sensient.xlsx` for format).
- Skips non‑data sheets (`Sheet1`, `Data Seller`, `Rittal`, `Simon`, `Silesia`, etc.) and reads data with `skiprows=5`.
- Required columns: Invoice, Ship Date, Item Description, Input Quantity, Input UOM, Total KG, Unit Price, Amount, Currency. Optional: HS-Code. Must also have Customer Group (captured as `buyer_name_raw`).
- Normalizes column names (handles HS-Code variants), coerces invoice to string int, numeric columns to numbers, drops rows missing invoice/buyer/qty/price/amount.
- Adds `batch_id` (UUID) per run, adds placeholder buyer fields, ensures staging columns (`buyer_name_raw`, `buyer_match_confidence`) exist.
- Output: rows inserted into `public."temporaryStaging"` with the batch_id; prints counts for sheets processed/skipped, unique buyers, rows inserted.

2) Stage s02 — validation + buyer resolution
- Input: `batch_id` against `public."temporaryStaging"`.
- Validates required fields and checks `amount` vs `input_quantity * unit_price` with tolerance `max(1%, 0.01)`.
- Loads `public.parties` and resolves `buyer_party_id` via exact match on normalized name, else fuzzy match (fuzzywuzzy ratio ≥ 70). Writes confidence to `buyer_match_confidence`; low/conflicting matches are stored as NULL.
- Output: updates staging rows in place; prints counts of validation issues and resolved/unresolved buyers.

3) Stage s03 — build normalized invoices
- Input: staging rows filtered by `--batch-id` or `--invoice`; skips groups that already exist in `tax_invoices`.
- For each (invoice_number, buyer_party_id): fetches buyer details (`public.parties`), staging items, and prepares header data with fixed seller constants (`TIN=0021164165056000`, `seller_idtku=0021164165056000000000`, VAT 12%).
- HS codes: parsed to `(opt, 6-digit code)`; validates existence in `public.hs_codes` (logs warning if missing). UOM: resolved via `public.uom_aliases` (falls back to original if not found).
- Economics: uses `unit_price` and `total_kg` as price/qty; computes `tax_base = price*qty`, `other_tax_base = 11/12 * tax_base`, `vat = 12% of other_tax_base`.
- Persists with UPSERT into `tax_invoices`, deletes existing `tax_invoice_items` for idempotency, then inserts items (line_number order). `--dry-run` performs all steps without committing.

## Data Flow
- Excel → `public."temporaryStaging"` (Stage 1) → validated/resolved staging (Stage 2) → `tax_invoices` + `tax_invoice_items` (Stage 3).
- Grouping key: `(invoice, buyer_party_id)`; batch_id keeps runs isolated. Stage 3 skips invoices already present for that buyer.

## Configuration & Defaults
- Column mapping lives in `s01_postgreimport_sensient.py` (`COLUMN_MAPPING`, `REQUIRED_COLUMNS`, `OPTIONAL_COLUMNS`, `SKIP_SHEETS`).
- Buyer resolution thresholds: fuzzy ratio ≥ 70 to accept; tolerance for amount mismatch: 1% or 0.01 absolute.
- DB connection env:
  - Stages 1–2: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (defaults to postgres/localhost).
  - Stage 3: `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD` (falls back to DB_*; default DB is `pdf_jobs`).
- Expected tables: `public."temporaryStaging"`, `public.parties`, `public.hs_codes`, `public.uom_aliases`, `tax_invoices`, `tax_invoice_items`.

## How to Run
- Stage 1 (import): `python services/xls2sql/stages/s01_postgreimport_sensient.py <path/to/workbook.xlsx>`
- Stage 2 (validate/resolve buyers): `python services/xls2sql/stages/s02_validate_resolve_sensient.py --batch-id <uuid-from-stage1>`
- Stage 3 (build invoices/items): `python services/xls2sql/stages/s03_build_invoices.py --batch-id <uuid>` (or `--invoice <number>`, add `--dry-run` to preview)

## Testing the Full Workflow

### Database Connection via Docker

The PostgreSQL database runs in Docker. Use this command pattern to connect:
```bash
docker exec $(docker ps -q -f name=simplitx-postgres-1) psql -U postgres -d pdf_jobs -c "SQL QUERY"
```

Example queries:
```bash
# Check staging row count
docker exec $(docker ps -q -f name=simplitx-postgres-1) psql -U postgres -d pdf_jobs -c "SELECT COUNT(*) FROM \"temporaryStaging\""

# Check invoice count
docker exec $(docker ps -q -f name=simplitx-postgres-1) psql -U postgres -d pdf_jobs -c "SELECT COUNT(*) FROM tax_invoices"

# Check specific invoice items
docker exec $(docker ps -q -f name=simplitx-postgres-1) psql -U postgres -d pdf_jobs -c "SELECT invoice_number, (SELECT COUNT(*) FROM tax_invoice_items WHERE tax_invoice_id = ti.id) as items FROM tax_invoices ti WHERE invoice_number = '25708584'"
```

### Running the Full Pipeline with Environment Variables

**Prerequisites**: Ensure Docker containers are running (`docker ps` should show `simplitx-postgres-1`)

**Database Environment Variables**:
- Stages 1 & 2: `DB_HOST=localhost DB_PORT=5432 DB_NAME=pdf_jobs DB_USER=postgres DB_PASSWORD=postgres`
- Stage 3: `PGHOST=localhost PGPORT=5432 PGDATABASE=pdf_jobs PGUSER=postgres PGPASSWORD=postgres`

**Complete Test Workflow**:

```bash
# Navigate to xls2sql directory
cd /path/to/simplitx/services/xls2sql

# Stage 1: Import Excel file
env DB_HOST=localhost DB_PORT=5432 DB_NAME=pdf_jobs DB_USER=postgres DB_PASSWORD=postgres \
  python3 stages/s01_postgreimport_sensient.py training/sen/sensient.xlsx

# Note the Batch ID from output (e.g., ad25c210-2c46-4648-9164-a87088509897)

# Stage 2: Validate and resolve buyers
env DB_HOST=localhost DB_PORT=5432 DB_NAME=pdf_jobs DB_USER=postgres DB_PASSWORD=postgres \
  python3 stages/s02_validate_resolve_sensient.py --batch-id <BATCH_ID>

# Stage 3: Build invoices and cleanup staging
env PGHOST=localhost PGPORT=5432 PGDATABASE=pdf_jobs PGUSER=postgres PGPASSWORD=postgres \
  python3 stages/s03_build_invoices.py --batch-id <BATCH_ID>
```

### Verifying Results

**1. Check Staging Cleanup** (should be 0 after Stage 3):
```bash
docker exec $(docker ps -q -f name=simplitx-postgres-1) psql -U postgres -d pdf_jobs -c "SELECT COUNT(*) FROM \"temporaryStaging\""
```

**2. Check Invoice Creation** (should be 672 for sensient.xlsx):
```bash
docker exec $(docker ps -q -f name=simplitx-postgres-1) psql -U postgres -d pdf_jobs -c "SELECT COUNT(*) FROM tax_invoices"
```

**3. Verify No Item Accumulation** (test delete and re-upload):
```bash
# Delete all invoices
docker exec $(docker ps -q -f name=simplitx-postgres-1) psql -U postgres -d pdf_jobs -c "DELETE FROM tax_invoices"

# Re-run the full pipeline (Stages 1-3 with new batch_id)
# Then check a specific invoice - item count should remain consistent
docker exec $(docker ps -q -f name=simplitx-postgres-1) psql -U postgres -d pdf_jobs -c \
  "SELECT invoice_number, (SELECT COUNT(*) FROM tax_invoice_items WHERE tax_invoice_id = ti.id) as items \
   FROM tax_invoices ti WHERE invoice_number = '25708584'"
```

### Staging Cleanup Behavior

**Important**: Stage 3 automatically cleans up `temporaryStaging` rows after successful processing:
- Cleanup runs ONLY when `--batch-id` is provided (not with `--invoice` mode)
- Cleanup happens AFTER successful commit
- Cleanup is skipped in `--dry-run` mode
- You should see: `✓ Cleaned up X staging rows for batch <batch_id>` in the output

**Why Cleanup Matters**: Without cleanup, staging rows accumulate across uploads. When Stage 3 processes an invoice, it would fetch items from ALL historical batches, causing item duplication (e.g., 1 item becomes 2, then 3, then 4 with each upload).

### Common Testing Pitfalls

1. **Wrong Port**: PostgreSQL runs on port **5432** (not 5433)
2. **Environment Variable Names**: Stages 1-2 use `DB_*`, Stage 3 uses `PG*`
3. **Working Directory**: Run scripts from `services/xls2sql/` directory
4. **Relative Paths**: XLS file path is relative to working directory: `training/sen/sensient.xlsx`
5. **Batch ID Reuse**: Each Stage 1 run creates a NEW batch_id; don't reuse old batch_ids
6. **Container Name**: If `simplitx-postgres-1` doesn't exist, check with `docker ps | grep postgres`

## Environment Requirements
- Python libs: pandas, openpyxl, psycopg2-binary, fuzzywuzzy + python-Levenshtein (see `docker/python/requirements-xls2sql.txt`); FastAPI/uvicorn for the health endpoint.
- System: network access to PostgreSQL with the tables above; no PDF/Camelot dependencies.

## Debugging Tips
- Empty buyer resolutions: confirm `Customer Group` column imported and party list completeness; inspect `buyer_match_confidence`.
- Amount mismatch warnings: check spreadsheet numeric formatting; tolerance is strict (1%/0.01).
- HS/UOM issues in Stage 3: verify entries in `public.hs_codes` and `public.uom_aliases`; dry-run to see warnings before commit.
- No invoices processed: ensure batch/invoice filters are correct and that the invoice/buyer combo is not already in `tax_invoices`.
