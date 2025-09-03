## Implementation Plan for Simplified Invoice Config (Revised)

### Overview
Create a minimal configuration `invoice_simon_min.json` that extracts essential fields. Due to current code limitations, totals extraction requires a minimal Stage 7 code modification. The plan accounts for this reality.

### Critical Blockers and Solutions

#### **Blocker 1: Totals Extraction**
Current Stage 7 only calculates subtotal by summing items. Tax fields remain null. 

**Solution (Option A - Recommended):**
1. Set `stop_after_totals: false` in config to include totals rows in table data
2. Keep Stage 6's `row_filters` to exclude totals from items  
3. Add minimal Stage 7 code to:
   - Scan last 5-10 rows of table for totals patterns
   - Match keywords: "DPP"→tax_base, "PPN/VAT"→tax_amount/tax_label, "GRAND TOTAL"→grand_total
   - Parse percentages for tax_rate (e.g., "VAT 12%" → 12)
   - Extract values from appropriate columns

#### **Blocker 2: Header Key Names**
Stage 7 outputs `invoice_no` (hardcoded), not `invoice number`.

**Solution:** Accept `invoice_no` in output or add downstream remapping. Changing hardcoded keys requires code modification beyond minimal scope.

### Phase 1: Fix Critical Config Issues

**Fix index_fallback mapping:**
- Current config has suspicious `"NO": "PRICE"` mapping
- Review actual column positions from 04-cells-raw.json
- Correct mapping should be: COL7 → PRICE (not NO → PRICE)

**Correct column mapping (based on data):**
```
COL1 → NO
COL2 → HS  
COL3 → SKU
COL4 → CODE
COL5 → DESC
COL6 → QTY
COL7 → PRICE
COL8 → AMOUNT
```

### Phase 2: Configuration Structure

**header_aliases Section:**
- Keep only: NO, HS, SKU, CODE, DESC, QTY, UOM, PRICE, AMOUNT
- Maintain sufficient aliases for robust column detection
- Remove unused families (BATCH, SERIAL, TAX_RATE, etc.)

**totals_keywords Section:**
- Essential for identifying totals rows
- Keep: "DPP", "PPN", "VAT", "GRAND TOTAL", "SUB TOTAL"
- Add: "TOTAL TAX BASED", "BASIS PAJAK" for tax_base detection

**camelot Section:**
- Keep unchanged (critical for table extraction)
- Set `stop_after_totals: false` to capture totals rows

**stage5 Configuration:**
- Simplify column_types to only: QTY, PRICE, AMOUNT (number), NO (integer), others (text)
- Keep number_format unchanged (handles Indonesian formatting)
- Remove unused date configurations

**stage6 Configuration:**
- **Critical:** Fix index_fallback mapping
- Keep required_families minimal
- Maintain row_filters to exclude totals from items
- Keep derivation rules

**stage7 Configuration:**
- Simplify patterns to only needed fields
- Add `totals_scan` configuration:
  ```
  "totals_scan": {
    "enabled": true,
    "patterns": {
      "tax_base": ["DPP", "DASAR PAJAK", "TOTAL TAX BASED"],
      "tax_amount": ["PPN", "VAT"],
      "grand_total": ["GRAND TOTAL"],
      "tax_label": ["PPN", "VAT"]
    }
  }
  ```

### Phase 3: Minimal Code Addition for Totals

**Stage 7 Enhancement (pseudocode logic):**
1. After calculating subtotal from items
2. If `totals_scan.enabled` in config:
   - Get last 10 rows from first table
   - For each row, check if text matches totals patterns
   - Extract numeric value from AMOUNT column (col 7)
   - For tax rows, check for percentage (e.g., "12%") for tax_rate
   - Map to appropriate totals fields

### Phase 4: Testing Strategy

**Iteration 1:** Fix column mapping
- Correct index_fallback based on actual data
- Verify items extraction with fixed mapping

**Iteration 2:** Simplify config
- Remove unused sections while keeping structure
- Test items and header extraction

**Iteration 3:** Add totals extraction
- Set stop_after_totals: false
- Implement minimal Stage 7 totals scanner
- Test totals parsing from table rows

### Phase 5: Final Config Elements

**Essential to Keep:**
```
- header_aliases (minimal but sufficient)
- totals_keywords (expanded for totals detection)
- currency_hints: ["IDR", "RP"]
- uom_hints: ["PCS"]
- camelot (unchanged except stop_after_totals)
- stage5.column_types (simplified)
- stage5.number_format (unchanged)
- stage6.index_fallback (CORRECTED)
- stage6.required_families
- stage6.row_filters
- stage7 (simplified + totals_scan config)
```

**Remove:**
- Unused header_aliases families
- Complex date parsing configurations
- Redundant customer_code patterns
- Seller extraction from header columns
- Payment terms extraction

### Implementation Notes

1. **Column Mapping is Critical**: Must fix the NO→PRICE error in index_fallback before anything else works correctly.

2. **Totals Require Code**: Accept that minimal Stage 7 modification is necessary for totals extraction.

3. **Header Key Names**: Use `invoice_no` not `invoice number` unless adding remapping code.

4. **stop_after_totals Setting**: Must be `false` to include totals rows for parsing.

5. **Test Iteratively**: Start with fixing column mapping, then simplify, then add totals logic.
