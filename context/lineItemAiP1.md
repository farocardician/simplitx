# Phase 1 — Implementation Plan s06_line_items_ai.py (Header & Column Bands)

**Goal**
From `services/pdf2json/results/esi/1/s02-table-pymupdf-tokens.json`, deterministically identify the correct header row and produce precise **x-bands** for each field. No models used in this phase.

**Why this matters**
If bands are right, you fence where tokens are allowed to live. That prevents off-by-one rows and unit_price/amount swaps later.

---

## 1) Inputs, Outputs, Contracts

**Input**

* `--in`: path to `services/pdf2json/results/esi/1/s02-table-pymupdf-tokens.json` (PyMuPDF tokens with page, text, bbox, order).
* `--config`: config key (to load synonyms and required fields).
* Optional: `--page` to restrict to one page during testing (default: all pages).

**Config (read-only in this phase)**

* `header_synonyms`: map of logical fields → list of possible header tokens per field

  * e.g., `no: ["no", "no.", "item", "line"]`, `qty: ["qty","quantity"]`, etc.
* `required_fields`: list such as `["no","description","qty","uom","unit_price","amount"]`
* `y_tolerance_header`: default 4–8 px (or fraction of page height) for forming lines
* `x_margin_ratio`: band padding ratio (e.g., 0.03 of page width)

**Output (Phase 1 artifact)**

* `--out`: `s05_bands.json` (name is up to you) with structure:

```
{
  "doc_id": "...",
  "pages": [
    {
      "page_index": 0,
      "header": {
        "line_index": 12,              // line index within the page’s lines array
        "text": "NO  DESCRIPTION  QTY  UOM  UNIT PRICE  TOTAL",
        "tokens_used": [/* token ids */]
      },
      "bands": [
        {"field": "no",          "x0": ..., "x1": ..., "header_tokens": ["NO"], "confidence": 1.0},
        {"field": "sku",         "x0": ..., "x1": ..., "header_tokens": ["ARTICLE","NO."], "confidence": 1.0},
        {"field": "description", "x0": ..., "x1": ..., "header_tokens": ["DESCRIPTION"], "confidence": 1.0},
        {"field": "qty",         "x0": ..., "x1": ..., "header_tokens": ["QTY"], "confidence": 0.9},
        {"field": "uom",         "x0": ..., "x1": ..., "header_tokens": ["UOM"], "confidence": 0.9},
        {"field": "unit_price",  "x0": ..., "x1": ..., "header_tokens": ["UNIT","PRICE"], "confidence": 0.8},
        {"field": "amount",      "x0": ..., "x1": ..., "header_tokens": ["TOTAL","AMOUNT"], "confidence": 0.8}
      ],
      "bands_order": ["no","description","qty","uom","unit_price","amount"]
    }
  ],
  "config_version": "vX.Y",
  "created_at": "ISO8601"
}
```

**Debug (optional but recommended)**

* `--overlay`: write `s05_bands_overlay.pdf` per page with vertical band lines and the chosen header highlighted. This makes QA trivial.

**Acceptance**

* The correct header line is selected (visually obvious in overlay).
* Bands cleanly bracket tokens for each field (no crossing).
* `bands_order` is strictly left→right and matches the visible header.

---

## 2) Step-by-Step Workflow

### Step A — Load & Normalize Tokens

* Load tokens, grouped by page.
* Ensure all bbox coordinates are in the same reference frame (after rotation fix, if your pipeline does that earlier).
* Keep token order as in source; do not alter text.

### Step B — Form Text Lines (deterministic)

* Group tokens into lines by y-proximity using `y_tolerance_header` from config.
* For each line, produce: `line_index`, `y_center`, `bbox_union`, `text` (tokens joined with single spaces), and `token_ids`.
* Keep the page’s line list sorted top-to-bottom by `y_center`.

### Step C — Header Candidates (scoring)

For each line on the page, compute a **header score**:

* **Synonym hits**: lowercased `text` must contain at least N distinct fields from `required_fields` via their `header_synonyms`.
* **Coverage score**: fraction of required fields found (e.g., 5/6 = 0.83).
* **Density score**: number of uppercase tokens and separators (often headers are dense and short).
* **Position prior**: bonus for being in the top 25% of the page height.
* **Penalty** for lines containing obviously non-header phrases (“invoice”, “date”, “customer”), if present.

Combine into a simple weighted score. Keep the **top 3 lines** as candidates.

### Step D — Break Ties Robustly

If multiple lines are close in score, apply tie-breakers in order:

1. Highest coverage of distinct required fields.
2. Widest x-span (headers usually span the table width).
3. Higher on the page.
   Select **one** header line. If none meets a minimal threshold, fail Phase 1 with a clear error: “No header found on page X.”

### Step E — Build Column Bands from Header Tokens

* For each required field, find the **header token(s)** in the chosen line that match any of the field’s synonyms.
* Compute the field’s **x-range** `[x0, x1]` from the union bbox of its matched header token(s).
* If a field’s header is two words (“UNIT PRICE”), the union should cover both.
* Apply `x_margin_ratio` padding to each band (expand a bit on both sides).
* Sort bands by `x0`. Ensure strict left→right ordering.

**If a field header is missing (rare):**

* Infer missing band by splitting gaps between known neighbors (e.g., between `uom` and `amount` for `unit_price`).
* Mark its `confidence` lower (e.g., 0.6) and include `header_tokens: []`.

### Step F — Sanity Rules & Fixups

* **No overlap** rule: if any band overlaps its neighbor by more than a small threshold, shrink both toward their centers.
* **Minimum width** rule: enforce a small minimum width so later steps don’t crash.
* **Rightmost numeric band** should be `amount` if both `unit_price` and `amount` exist; if not, switch them.
* Ensure `bands_order` reflects the sorted order.

### Step G — Write Outputs

* Produce `s05_bands.json` with the structure above.
* If `--overlay` was set, render a quick SVG/PNG with vertical lines at each band edge and highlight the selected header line.
* Exit 0 on success; non-zero with a human-readable error if header detection failed.

---

## 3) Test Plan (Beginner-friendly)

**T1 — Happy path (the attached sample)**

* Run Phase 1 on your provided tokens.
* Open the overlay and visually confirm: the chosen header equals the real table header; vertical band lines slice the table in the expected columns.
* Check `bands_order` is exactly `["no","description","qty","uom","unit_price","amount"]` (or your config schema).

**T2 — Header near top, faint synonyms**

* Temporarily remove one synonym from config and rerun.
* Expect the same header chosen (coverage still high enough).
* Bands should remain stable.

**T3 — Missing “UNIT PRICE” text**

* Simulate by removing “UNIT PRICE” tokens from the header line (copy tokens file and edit text).
* Expect the band inferred from neighbors with lower confidence and a clear note in output.

**T4 — Overlap guard**

* Simulate slightly overlapping header words (duplicate spacing) and rerun.
* Expect bands to auto-shrink to remove overlap.

**Pass criteria for Phase 1**

* For each test, header is correct, `bands_order` is correct, and bands fence the expected token regions with no large overlaps.
* Output JSON validates against a small schema (field names, numeric x’s, order).

---

## 4) Handover Notes (Interfaces for Phase 2+)

* **Input for Phase 2**: `s05_bands.json` + original tokens.
* Phase 2 will **never** compute bands; it consumes them.
* Each row in later phases must place tokens **only** inside these bands when proposing lattices.
* Maintain `config_version` to detect drift.

---

## 5) Operational Tips

* Keep all thresholds in the config (`y_tolerance_header`, `x_margin_ratio`, min coverage).
* Log scores for the top 5 header lines to a small debug file; this makes failures easy to diagnose.
* Prefer page-by-page processing so multi-page invoices can have different headers/bands if needed.

---

If this looks good, say “approve Phase 1” and I’ll flesh out Phase 2 (Row Lattice Generator) with the same level of clarity.
