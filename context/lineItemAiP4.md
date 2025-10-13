# Phase 4 — Implementation Plan s06d_line_items_ai.py (Row Field Tie-Breaking)

**Goal**
For each row in the **selected** hypothesis, resolve any **ambiguous fields** (especially `unit_price` vs `amount`, sometimes `qty`/`uom`) by creating small candidate sets and using the **BGE reranker** to choose the best candidate per field. Then **freeze** the choice. No LLMs here, no normalization, just selection.

**Why this matters**
Most remaining errors come from rows that contain multiple plausible numbers or malformed tokens. Tight, per-field reranking removes guesswork before Qwen formats JSON.

---

## 1) Inputs, Outputs, Contracts

**CLI**

* `--in-selected`: path to `s07_table_selected.json` (Phase-3 output)
* `--in-lattices`: path to `s06_lattices.json` (Phase-2 output; used to pull all raw candidates within the chosen hypothesis)
* `--out`: path to `s08_rows_resolved.json`
* `--config`: vendor key (prompts, thresholds)
* Optional: `--page` (single page), `--reranker-url` (default `http://localhost:9000`), `--debug`

**Assumptions**

* Phase-3 output embeds the entire **selected hypothesis** (rows, cells, tokens). If Phase-2 did not keep multi-candidate lists, Phase-4 will **reconstruct** candidates from Phase-2’s band-assigned tokens in the same row span. 

**Output**
`s08_rows_resolved.json`:

```
{
  "doc_id": "...",
  "pages": [
    {
      "page_index": 0,
      "hypothesis_id": "y006_greedy_up",
      "rows": [
        {
          "row_id": 2,
          "cells": {
            "qty":        {"text": "1"},
            "uom":        {"text": "PAX"},
            "unit_price": {"text": "Rp 19.573.311"},
            "amount":     {"text": "Rp 19.573.311"}
          },
          "tie_break": {
            "unit_price": {
              "candidates": ["Rp 19.573.311", "19.573.311"],
              "scores": [0.71, 0.65],
              "chosen_index": 0
            },
            "amount": {
              "candidates": ["Rp 19.573.311"],
              "scores": [1.00],
              "chosen_index": 0
            }
          },
          "flags": {"unresolved_fields": []}
        },
        {
          "row_id": 3,
          "cells": { ... },
          "flags": {"unresolved_fields": ["unit_price"]}  // no numeric candidates found
        }
      ]
    }
  ],
  "created_at": "ISO8601",
  "config_version": "vX.Y"
}
```

* Include per-field candidate lists, scores, and which index won.
* If a field has **zero** valid candidates (e.g., row 3 `unit_price` is text like “Fifty Rupiah Sub”), add it to `unresolved_fields`. This is expected in messy docs; Qwen will receive `null` or the raw text later, depending on your Phase-5 choice.

**Acceptance**

* Every row has either a frozen value per target field or a clear `unresolved_fields` entry.
* No mutation of row boundaries or tokens; only selecting among in-row candidates.

---

## 2) Step-by-Step Workflow

### Step A — Load inputs

* Read `s07_table_selected.json` and get, per page, the **chosen** hypothesis id and its rows. 
* Load `s06_lattices.json` and locate the **full** chosen hypothesis object by id, so you can access **all band-assigned lines** inside each row span (not just the already-assembled “cell text”). This is important when reconstructing candidate sets that Phase-2 may have trimmed. (You already produced the full lattice set in Phase-2.) 

### Step B — Build per-field candidate sets (row-local)

For each row:

1. **Within the row’s vertical span** `[y0,y1]`, and within each **target band** (“qty”, “uom”, “unit_price”, “amount”), gather all band-assigned token **lines** from the chosen hypothesis (prefer Phase-2’s per-band lines if present).
2. For **numeric fields**:

   * `unit_price` and `amount`: extract text candidates where the line contains **≥3 digits** or standard separators (., ,). Keep currency tokens like “Rp” together with the number if adjacent in the same line.
   * If nothing numeric is found, allow one fallback candidate: the **longest line** in the band (so you can still log it as unresolved).
3. For **qty**:

   * Prefer pure digit strings (1–2 tokens). If none, and a wordy qty exists (“Seven Hundred”), include it but mark as **weak**.
4. For **uom**:

   * Prefer short alphabetic tokens (≤10 chars), deduplicate (`PAX`, `PCS`, `DAY`, etc.).
5. Deduplicate identical strings (trimmed) while preserving first occurrence order.
6. Cap each candidate list at 3 items per field (head-bias).

### Step C — Rerank candidates (field-specific, tiny prompts)

For any field with **k ≥ 2** candidates, call the reranker with a **short, literal** query. Provide a compact **row summary** plus the **candidate list** for that field only.

Suggested templates (configurable):

* **unit_price**
  Query: “Select the **unit price** (price per one unit) for this row. It is the per-unit number, not the total.”
  Row context string (built from the row):
  `DESC="{desc}" QTY="{qty_candidate_if_any}" UOM="{uom_candidate_if_any}" AMOUNT="{amount_top_candidate_if_any}"`

* **amount**
  Query: “Select the **total amount** for this row (row total). It usually appears in the rightmost amount column and may include currency.”
  Context: `DESC="{desc}" QTY="{qty}" UOM="{uom}" UNIT_PRICE="{unit_price_top_candidate_if_any}"`

* **qty**
  Query: “Select the **quantity** for this row (integer count).”
  Context: `DESC="{desc}" UOM="{uom}" UNIT_PRICE="{unit_price}" AMOUNT="{amount}"`

* **uom**
  Query: “Select the **unit of measure** (short code like PAX, PCS, DAY).”
  Context: `DESC="{desc}" QTY="{qty}"`

Send `query` + `texts=[candidate_1, candidate_2, ...]`, get back scores, and record them.

> Keep candidates short; truncate descriptions in context (~60 chars). Use the same reranker service you used in Phase-3. 

### Step D — Freeze or mark unresolved

* If a field had **k ≥ 2**, choose `argmax(score)` and set `cells[field].text` to that candidate.
* If **k = 1**, freeze it as is.
* If **k = 0**, add field name to `flags.unresolved_fields`. Do **not** invent a value.

### Step E — Write output

* Emit `s08_rows_resolved.json` with the structure shown above.
* Include `tie_break` sections per row for transparency (candidates, scores, chosen index).
* Keep everything page-scoped and hypothesis-scoped; do not touch other pages.

---

## 3) Guardrails & “don’ts”

* **Don’t** change row spans or bands. This phase only chooses among **in-row** candidates.
* **Don’t** normalize currency or compute totals. The task is extraction only.
* **Don’t** call embeddings here. The cross-encoder is sufficient for these tiny decisions.

---

## 4) Test plan (fast)

**T1 — Clean numeric row**

* A row like your row 2 has clear digits for `qty`, `unit_price`, and `amount`. Expect each field to end up with **k=1** or a decisive reranker pick with `chosen_index=0`. 

**T2 — Ambiguous numbers**

* Create a row with two numbers in the unit-price band (e.g., formatted and unformatted). Expect reranker to pick the per-unit value and log both candidates with scores.

**T3 — Wordy qty / missing unit_price**

* Your row 3 is wordy for qty and has a non-numeric “unit_price”. Expect `qty` to be flagged as weak (but still a candidate), and `unit_price` to be **unresolved** if no numeric line exists in its band. 

**Pass criteria**

* Every field is either frozen to a specific candidate or listed in `unresolved_fields`.
* No rows are dropped or re-segmented.
* Output is deterministic across runs with the same config.