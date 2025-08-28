# Deterministic Invoice Parser — Implementation Plan

A geometry-first, deterministic system that converts invoice **PDFs** into structured JSON. Camelot is used only for grid geometry. All strings come from tokens so every value has clean token backrefs and runs are reproducible.

## Core Principles
1. **Geometry first**: Use spatial layout to find tables, then fuse geometry with tokens.
2. **Token-Based Truth**: Text tokens are the source of truth, never hallucinate
3. **Deterministic processing**: Fixed seeds, fixed parameter sets, sorted iteration, stable tie-breakers, centralized rounding.
4. **Multi-Stage Pipeline**: Each stage produces verifiable intermediate artifacts

## Pipeline Stages (deterministic)

### Stage 1 — PDF Tokenization (`stages/tokenizer.py`)

**In:** PDF → **Out:** `tokens.json`

* Extract characters/words with pdfplumber (or equivalent).
* Build word tokens, normalized bboxes `[0..1]`.
* Stable sort by `(page, y_top, x_left)` and assign deterministic token IDs.

### Stage 2 — Light Per-Token Normalization (`stages/normalizer.py`)

**In:** `tokens.json` → **Out:** updated `tokens.json`

* Safe fixes only: NFC/NFKC, NBSP→space, ligatures, decimal symbol unification.
* Do **not** change positions or reading order.

### Stage 3 — Band Segmentation (`stages/segmenter.py`)

**In:** tokens → **Out:** `bands.json`

* Detect repeating y-bands across pages; confirm with anchors in header/footer.
* Emit `header`, `content`, `footer` per page with `band_confidence`.
* All table work (anchors + Camelot) runs **inside CONTENT**.

### Stage 4 — Anchor Detection (region hints) (`stages/anchors.py`)

**In:** tokens, bands → **Out:** `anchors.json`

* Inside **CONTENT**, fuzzy-match column headers:
  `NO`, `HS CODE`, `DESCRIPTION`, `QTY`, `UNIT PRICE`, `AMOUNT`.
* Build **candidate table bounding boxes** per page; score anchor alignment/coverage.

### Stage 5 — Grid Geometry (Camelot; **geometry only**, bounded) (`stages/geometry.py`)

**In:** PDF, bands, anchors → **Out:** `camelot_raw.json`

* Run Camelot **bounded to candidate boxes**.
* **Lattice first** with fixed `line_scale ∈ {40,50,60}` (early-exit when region score ≥ τ).
* Fallback **Stream** with fixed `row_tol/column_tol` (deterministic).
* Emit **columns/rows/cell boxes only**; **never include text**.
* If no region passes: inflate boxes by 5–10% and retry; last resort: page-wide sweep + scoring.

### Stage 6 — Fuse Geometry with Tokens (`stages/fuse.py`)

**In:** tokens, `camelot_raw.json` → **Out:** `fused_grid.json`

* Snap **columns** to token x-clusters; **rows** to token y-gaps.
* Allow merges/splits for wrapped/merged cells; flag continuation rows.
* Record alignment deltas (used by confidence scoring).

### Stage 7 — Cells & Text (tokens only) (`stages/cells.py`)

**In:** tokens, `fused_grid.json` → **Out:** `cells.json`

* For each cell: collect `token_ids` by center-in-polygon; sort in reading order; join to **cell text from tokens**.

### Stage 8 — Heavy Cell Normalization (`stages/normalize_cells.py`)

**In:** `cells.json` → **Out:** `cells_normalized.json`

* Merge wrapped lines; fix soft-hyphen breaks.
* Locale-aware numbers/dates: thousands/decimal marks, negative parentheses.
* Preserve token backrefs.

### Stage 9 — Field Extraction (`stages/extractor.py`)

**In:** `cells_normalized.json`, anchors, bands → **Out:** `fields.json`

* Header: `buyer_id`, `invoice.number`, `invoice.date (YYYY-MM-DD)`.
* Items: `{ no, hs_code, sku, code, description, qty, uom, unit_price, amount }`.
* **Continuation rule:** empty `NO/HS` + non-empty `DESCRIPTION` → append to previous item.
* Totals: extract from **FOOTER** band only.

### Stage 10 — Arithmetic & Totals Validation (`stages/validator.py`)

**In:** `fields.json` → **Out:** `validation.json`

* **Row check:** `qty × unit_price ≈ amount` within **max(0.5% or 1 unit)**.
* **Subtotal:** `Σ amount` within **max(0.3% or 2 units)**.
* **Template rule (this template only):**

  * `tax_rate = 12%`
  * `tax_base = subtotal × 11/12`
  * `tax_amount = (tax_rate/100) × tax_base`
  * `grand_total = subtotal + tax_amount`
* Flag if any discrepancy **> 3×** its tolerance.
* Continue on missing totals; add `TOTALS_MISSING`.

### Stage 11 — Confidence Scoring (`stages/scorer.py`)

**In:** anchors, `validation.json`, `fused_grid.json` → **Out:** `confidence.json`

* Weighted signals (emit `[0..1]`):

  * **Anchors matched/aligned** — 30%
  * **Row arithmetic pass rate** — 30%
  * **Numeric purity** in QTY/PRICE/AMOUNT — 20%
  * **Grid alignment** (snap deltas) — 10%
  * **Totals reconciliation** — 10%
* Emit per-section and overall.

### Stage 12 — Final Assembly (`parser.py`)

**Out:** `final.json`, `manifest.json`

* Build schema output; **include token backrefs** for every populated field (header + each item field).
* Sort keys deterministically; round monetary values to **2 decimals** at export; keep qty decimals if present.
* Create `manifest.json` with schema/pipeline versions, fixed params, and **hashes** of every artifact.

---

## Scoring & Tie-Breakers

### Region/box scoring (deterministic)

```
score = 0.35*header_coverage
      + 0.35*numeric_purity
      + 0.15*alignment_quality
      + 0.10*(1 - empty_cell_rate)
      - 0.05*footer_penalty
```

* **header\_coverage**: required headers present and ordered.
* **numeric\_purity**: % numeric cells in QTY/PRICE/AMOUNT.
* **alignment\_quality**: low variance of row/column boundaries.
* **footer\_penalty**: “thank you”, bank info, page markers detected.

**Ties:** lowest L1 distance between column x’s and token x-clusters, then smallest y0.

### Header field ties

* Prefer span **to the right of the anchor** on the same line; tie → greatest y-overlap; tie → smallest x0.

### Items ordering

* Stable by `(page, top-y, left-x)`.

---

## Template-Specific Rules (this template only)

```python
TEMPLATE = {
  "uom_default": "PCS",         # if QTY header contains "(PCS)"
  "currency": "IDR",            # if UNIT PRICE or AMOUNT header contains "IDR"
  "tax_rate": 12,               # percent
  "tax_base_formula": "subtotal * 11 / 12",
  "tax_amount_formula": "(tax_rate/100) * tax_base",
  "grand_total_formula": "subtotal + tax_amount"
}
```

* When applying defaults, add header token backrefs that triggered them.

---

## Determinism Controls

1. **Fixed random seeds** for any stochastic code paths.
2. **Sorted iteration** (keys, tokens, regions).
3. **Centralized rounding**: money to **2 decimals** at export.
4. **Fixed parameter sets**: lattice `line_scales`, stream `row_tol/column_tol`, score threshold `τ`, inflation pct.
5. **Stable tie-breakers** (as above).
6. **Manifest logging**: include params, seeds, hashes.

---

## Output Schema (final.json — skeleton)
{"doc_id":"...","buyer_id":"...","invoice":{"number":"...","date":"YYYY-MM-DD"},"items":[{"no":10,"hs_code":"8536","sku":"70E7253","code":"61","description":"Stop Kontak Multistandard Dengan USB A+C","qty":30,"uom":"PCS","unit_price":218785.41,"amount":6563562.3}],"totals":{"subtotal":0,"tax_base":0,"tax_label":"VAT","tax_amount":0,"grand_total":0},"issues":[],"confidence":{},"provenance":{}}

## Testing Strategy
I already have Correct json. i want you to create a script that compare correct json with this output json

## Guardrails (quick checklist)

* Geometry first; **tokens are truth**.
* Camelot bounded to content; **geometry only**.
* Locale-aware parsing.
* Determinism: fixed params, seeds, tie-breakers, rounding.
* Never hardcode values not derived from the doc/template rules.
* Never copy gold/expected outputs; use for offline diff only.
