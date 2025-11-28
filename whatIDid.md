# Session Summary: SQL→XML Testing & ID-Only Migration

## Testing Initial Implementation

### Issues Found & Fixed

**1. Missing Volume Mount** (`docker-compose.development.yml`, `docker-compose.production.yml`)
- **Problem**: sql2xml container couldn't access `/shared/partyThresholds.json`
- **Fix**: Added `- ./services/shared:/shared` volume mount
- **Why**: Party resolver needs threshold config for buyer validation

**2. Type Error in Expression Evaluation** (`services/sql2xml/sql2xml/exporter.py:196-219`)
- **Problem**: Converting decimals to strings, but mapping expressions need numbers for calculations like `(amount / divisor) * multiplier`
- **Fix**: Changed `decimal_to_str()` → `decimal_to_number()`, now converts to float
- **Why**: JSON expressions can't perform arithmetic on string values

**3. Missing invoice_ids Validation** (`services/sql2xml/main.py:104`)
- **Problem**: Validation only checked `invoice_numbers` and `batch_id`, ignored `invoice_ids`
- **Fix**: Updated condition to include `invoice_ids` check
- **Why**: New ID-based downloads were being incorrectly rejected

## ID-Only Migration (Invoice Number Removal)

### Files Changed

**Web API** (`services/web/app/api/tax-invoices/bulk-download/route.ts`)
- Removed `invoiceNumbers` parameter and fallback logic
- Only accepts `invoiceIds` array
- Updated error messages: "No invoice IDs provided" / "No invoices found for provided IDs"

**SQL2XML Service** (`services/sql2xml/main.py`)
- Removed `invoice_numbers` field from `ExportRequest` model
- Updated validation: "Provide invoiceIds or batchId"
- Removed `invoice_numbers` from `export_invoices_to_xml()` call

**Exporter** (`services/sql2xml/sql2xml/exporter.py`)
- Removed `invoice_numbers` parameter from `fetch_invoices()` and `export_invoices_to_xml()`
- Simplified filtering to ID-only: `id = ANY(%s)`
- Updated error messages to reference "IDs" instead of "numbers"

**CLI** (`services/sql2xml/cli.py`)
- Removed `--invoice` argument (kept only `--invoice-id`)
- Removed `invoice_numbers` from function calls

### Why ID-Only?

- **Uniqueness**: Invoice numbers can be non-unique; UUIDs guarantee uniqueness
- **Consistency**: Single source of truth for invoice identification
- **Simplicity**: No fallback logic, clearer API contract

## Test Results

✅ Multi-invoice download (same buyer) with IDs works
✅ Different buyer constraint enforced
✅ ID-based filename generation (`{uuid}.xml` for single, `{mapping}_combined_{date}_{count}.xml` for merged)
✅ Invoice numbers properly rejected with clear error message
✅ XML structure correct (3 merged invoices, natural RefDesc sorting)
✅ OtherTaxBase calculation working ((102726915.0 / 12) * 11 = 94166338.75)

## Script Organization

**Moved Legacy Wrapper** (`services/xls2sql/stages/s01_sql2xml.py` → `services/sql2xml/stages/s01_sql2xml.py`)
- **Why**: Consolidate sql2xml-related code under the sql2xml service
- Script delegates to sql2xml CLI, belongs with that service
- **Fix**: Updated path calculation from `parents[3]` to `parent.parent` for container compatibility
- Works in both container (`/app/stages/`) and host (`services/sql2xml/stages/`) environments

## Final State

- System is fully ID-based (no invoice number support)
- All validations working (completeness, same-buyer, same-TIN)
- Services healthy: sql2xml:8012, web:3000
- Legacy wrapper moved to correct service location
