# PDF to JSON Processing Pipeline — Context

## Recent Change
- Refactor s05 to config-driven normalization; add stage5 config + common-words.json; wire CLI/processor.

## Project Overview
Converts PDF invoices into structured JSON using a deterministic 10‑stage pipeline. All stages produce intermediate JSON files for debugging and reproducibility. The service can run via FastAPI or a CLI.

## Main Entry Points
- FastAPI service: `services/pdf2json/main.py` (endpoints: `/health`, `/process`, `/batch`)
- Python orchestrator: `services/pdf2json/processor.py` (used by FastAPI)
- CLI orchestrator: `services/pdf2json/cli/pdf2json.py`

## Pipeline Stages
1) `s01_tokenizer.py` — Tokenization
- Input: PDF. Output: `tokens.json`
- Extracts tokens with normalized [0..1] bbox; deterministic ordering (page, y, x).

2) `s02_normalizer.py` — Token text normalization
- Input: `tokens.json`. Output: `normalized.json`
- Safe fixes: Unicode normalization (NFC/NFKC), NBSP→space, ligatures; preserves geometry.

3) `s03_segmenter.py` — Page band segmentation
- Input: `normalized.json` (+ optional PDF).
- Output: `segmentized.json`
- Detects header/content/footer bands; optionally probes Camelot to refine content bbox.

4) `s04_camelot_grid_configV12.py` — Table grid detection (STRICT, config‑driven)
- Input: PDF + `normalized.json` + `config/invoice_simon_v15.json`
- Output: `cells.json`
- Uses Camelot (lattice→stream) for geometry only; maps columns to families via `header_aliases`; stops at totals. Emits `header_cells[]` with `name` and body `rows[].cells[]` with `col`, `name`, `bbox`, `text`.

5) `s05_normalize_cells.py` — Cell text normalization (CONFIG‑DRIVEN)
- Input: `cells.json` + `--config invoice_simon_v15.json` + `--common-words common-words.json`
- Output: `cells_normalized.json`
- Behavior:
  - Text reconstruction: case‑preserving de‑spacing for words in `config/common-words.json` (e.g., "d engan" → "dengan" while keeping original casing).
  - Column types: `stage5.column_types.by_family` (+ optional `by_position`) drive number vs integer vs text vs date handling.
  - Number format: `stage5.number_format` (decimal, thousands, allow_parens).
  - Dates: `stage5.date_formats` with token patterns like `YYYY-MM-DD`, `DD-MM-YYYY`, `MM/DD/YYYY`; output normalized to `YYYY-MM-DD`.

6) `s06_line_items_from_cellsV2.py` — Line item extraction (CONFIG‑ONLY)
- Input: `cells_normalized.json` + `--config invoice_simon_v15.json`
- Output: `items.json`
- Maps families from header to build items: `no, hs_code, sku, code, description, qty, uom, unit_price, amount`. Derives missing economics per config.

7) Field extraction
- Processor uses: `s07_extractorV2.py` (config‑driven)
- CLI uses: `s07_extractor.py`
- Input: `cells_normalized.json` + `items.json` (+ `--config` for V2)
- Output: `fields.json` with header fields: invoice number/date, buyer_id, seller, buyer, currency.

8) `s08_validator.py` — Arithmetic validation
- Validates row math and computes totals. Tolerances: rows max(0.5% or 1 unit), subtotal max(0.3% or 2 units).

9) `s09_confidence.py` — Confidence scoring
- Combines anchors/grid alignment, row pass rate, numeric purity, totals reconciliation into a 0–1 score.

10) `s10_parser.py` — Final assembly
- Assembles `final.json` + `manifest.json`, keeps provenance backrefs, rounds money to 2 decimals.

## Data Flow & Paths
Per run outputs:
- CLI: `--out <dir>` creates subfolders: `tokenizer/`, `normalize/`, `segment/`, `cells/`, `items/`, `fields/`, `validate/`, `manifest/`, `final/`.
- Processor: uses a temp directory with the same substructure, then returns the final JSON (optionally strips `_refs`).

## Configuration
- Location: `services/pdf2json/config/invoice_simon_v15.json`
- Stage 4:
  - `header_aliases`, `totals_keywords`, `camelot` (flavor_order, line scales), `stop_after_totals`.
- Stage 5:
  - `stage5.column_types` (`by_family`, optional `by_position`, `date_columns`, `currency_columns`).
  - `stage5.number_format` and `stage5.date_formats`.
  - External: `services/pdf2json/config/common-words.json` for case‑preserving de‑spacing.
- Stage 6:
  - `stage6.required_families`, `index_fallback`, `row_filters`, `number_format`, `derivation`, `rounding`.

## Environment Requirements
- Python libs: pdfplumber, camelot‑py, opencv‑python‑headless, ghostscript
- System deps: ghostscript, poppler‑utils, tesseract‑ocr
- Service: FastAPI via uvicorn (port 8000); Docker images provided.

## Debugging Tips
- If Stage 4 finds 0 rows: verify table exists, check Camelot deps, and header aliases coverage.
- If fields missing (e.g., buyer_id): confirm extractor regex/config and parser wiring.
- If totals flagged: inspect `validation.json` computed vs extracted; tolerances above.
