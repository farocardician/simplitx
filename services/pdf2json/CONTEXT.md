# PDF → Structured JSON Pipeline

### 1. Ingest

* Hash file, assign `doc_id`, store PDF.

### 2. Tokenize

* Extract raw tokens (xywh, page, font flags).
* No heavy cleanup yet.

### 3. Light per-token normalization

* Safe fixes only: NFC/NFKC, NBSP→space, ligatures, numeric decimals.

### 4. Anchor detection (region hints)

* Detect header anchors: `NO`, `HS CODE`, `DESCRIPTION`, `QTY`, `UNIT PRICE`, `AMOUNT`.
* Use these anchors to define **candidate bounding boxes** (per page).
* Store region coordinates for Camelot.

### 5. Camelot (bounded to anchor regions)

* Try **lattice** first.
* If lattice fails, run **stream**.
* Reject raw Camelot text → **use only grid geometry (rows, columns, bounding boxes).**
* Score each region: numeric column purity, row/col alignment, empty-cell rate.
* Choose highest-scoring region per page.

### 6. Fuse grid with tokens

* Snap Camelot’s column dividers to token x-clusters.
* Snap Camelot’s row lines to token y-gaps.
* Adjust if tokens contradict Camelot (continuation rows, merged cells).

### 7. Refill cells from tokens

* Collect token centers inside each grid cell.
* Join tokens in reading order.
* Rebuilt cell text = **tokens only** (Camelot text ignored).

### 8. Heavy cell normalization

* Merge wrapped lines.
* Fix hyphen breaks.
* Normalize numbers and dates.
* Keep backrefs to token IDs.

### 9. Field build

* From normalized cells, build:

  * **Header fields** (buyer\_id, invoice number, date).
  * **Items**: `no, hs_code, sku, code, description, qty, uom, unit_price, amount`.

### 10. Reconcile with soft arithmetic

* Validate each row: `qty × unit_price ≈ amount`.
* Total Quantity = sum of row Quantity.
* Subtotal = sum of row amounts.
* Tax base = Subtotal/12*11
* Tax Amount = Tax Rate * Tax base
* Grand Total = Subtotal + Tax Amount
* Tolerances:
  * Row: max(0.5% or 1 unit).
  * Subtotal: max(0.3% or 2 units).
  * Totals: within same subtotal tolerance.
* Flag if >3× tolerance.

### 11. Confidence scoring

* Header anchors matched and aligned (30%).
* Row arithmetic pass rate (30%).
* Numeric type purity in QTY/PRICE/AMOUNT (20%).
* Camelot grid alignment score (10%).
* Totals reconciliation (10%).
* Emit per-field confidence + overall (0–1).

### 13. Export + lineage

* Output JSON with `issues[]`, `confidence{}`, token backrefs.
* Persist artifacts:
  * pdf, tokens.json, camelot\_raw\.json, fused\_grid.json, cells.json, final.json, manifest.json.
* Manifest includes `schema_version`, `pipeline_version`, and per-stage hashes.

**Template-specific constants (this template only):**

* **UOM default = `PCS`** if header shows `QTY` with `(PCS)` nearby.
  Source patterns (line-break tolerant):

  * `"11)QTY.\n(PCS)"` or any `QTY` header cell containing `(` `PCS` `)`.
    Action: if an item row’s UOM is blank, set `uom = "PCS"` and add backrefs to the header tokens that yielded `(PCS)`.
* **Currency = `IDR`** if header shows either `UNIT PRICE … IDR` or `AMOUNT … IDR`.
  Source patterns (line-break tolerant):

  * `"12)UNIT PRI\nCE \nIDR"` or `"13)AMOUNT \nIDR"` (any variant where `UNIT PRICE` or `AMOUNT` cell also contains `IDR`).
    Action: set **parsing currency context** to `IDR` for all monetary fields; if your schema includes it, emit `invoice.currency = "IDR"`. Keep backrefs to the header tokens that yielded `IDR`.

## Guardrails

* **Geometry first**: Camelot grid is mandatory, guided by anchors.
* **Text truth = tokens**. Camelot is geometry only.
* Locale-aware numeric parsing: thousands separators, decimals, negative parentheses.
* Continuation rows: if NO/HS empty but DESC filled → append to previous row.
* Determinism: fixed seeds, tie-breakers, centralized rounding (2 decimals at export).
* Failure handling:

  * If subtotal missing → export items, add `ISSUE: TOTALS_MISSING`.
  * If QTY missing but amount ÷ unit\_price exact → derive QTY, mark `DERIVED_QTY`.
  * If all numeric fields disagree beyond tolerance → send to review.



