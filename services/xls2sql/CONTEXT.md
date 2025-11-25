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

## Environment Requirements
- Python libs: pandas, openpyxl, psycopg2-binary, fuzzywuzzy + python-Levenshtein (see `docker/python/requirements-xls2sql.txt`); FastAPI/uvicorn for the health endpoint.
- System: network access to PostgreSQL with the tables above; no PDF/Camelot dependencies.

## Debugging Tips
- Empty buyer resolutions: confirm `Customer Group` column imported and party list completeness; inspect `buyer_match_confidence`.
- Amount mismatch warnings: check spreadsheet numeric formatting; tolerance is strict (1%/0.01).
- HS/UOM issues in Stage 3: verify entries in `public.hs_codes` and `public.uom_aliases`; dry-run to see warnings before commit.
- No invoices processed: ensure batch/invoice filters are correct and that the invoice/buyer combo is not already in `tax_invoices`.
