## Phase 2 — Implementation plan s06b_line_items_ai.py (Row Lattice Generator)

**Goal**
From **tokens + Phase-1 bands**, deterministically generate **multiple row segmentation hypotheses** (“lattices”) that map tokens into rows and fields, without any ML. We only create candidates here. Scoring/selection happens in Phase 3.

**Why this matters**
Most extraction errors come from off-by-one rows and wrapped descriptions. Good hypotheses now make later reranking + Qwen rock-solid.

---

### 1) Inputs, Outputs, Contracts

**CLI**

* `--in-tokens`: path to `s02-table-pymupdf-tokens.json`
* `--in-bands`: path to `s05_bands.json` (output of Phase 1)
* `--out`: path to write lattice candidates (e.g., `s06_lattices.json`)
* Optional: `--page` (test on one page), `--debug` (emit quick overlays/CSV)

**Config (read-only in this phase)**

* `row.y_merge_tolerances`: e.g., `[0.006, 0.009, 0.012]` (normalized units, 0–1)
* `row.description_merge_policy`: candidates like `["greedy", "conservative"]`
* `row.orphan_attach_policy`: candidates like `["up", "down"]` for single tokens between rows
* `row.min_row_height`: small normalized floor, e.g., `0.008`
* `patterns.numeric`: simple patterns for qty/price/amount (no normalization, just shape)
* (Keep all tunables in vendor config; no hard-coding.)

**Output (Phase-2 artifact)**
Write **all hypotheses** for each page. Example structure:

```
{
  "doc_id": "...",
  "pages": [
    {
      "page_index": 0,
      "bands_order": ["no","description","qty","uom","unit_price","amount"],
      "hypotheses": [
        {
          "hypothesis_id": "y009_greedy_up",
          "params": {"y_merge": 0.009, "desc_merge": "greedy", "orphan": "up"},
          "rows": [
            {
              "row_id": 1,
              "y0": ..., "y1": ...,
              "cells": {
                "no":         {"tokens":[...], "text":"1"},
                "description":{"tokens":[...], "text":"... multi-line joined ..."},
                "qty":        {"tokens":[...], "text":"2"},
                "uom":        {"tokens":[...], "text":"PAX"},
                "unit_price": {"tokens":[...], "text":"19.573.311"},
                "amount":     {"tokens":[...], "text":"39.146.622"}
              },
              "flags": {"has_left_anchor": true, "has_right_anchor": true}
            }
          ],
          "stats": {
            "row_count": 12,
            "avg_row_height": ...,
            "row_completeness_rate": 0.92
          }
        }
      ]
    }
  ],
  "created_at": "ISO8601",
  "config_version": "vX.Y"
}
```

**Acceptance for Phase-2**

* Each hypothesis is strictly **top-to-bottom** (no y-order inversions).
* Every row respects **Phase-1 x-bands** (tokens assigned only within their band).
* You produce multiple distinct hypotheses (at least 3) that differ by parameters.

---

### 2) Step-by-Step Workflow (deterministic, no ML)

#### Step A — Load inputs

* Read tokens and **Phase-1** bands for the target page.
* For each band, record `[x0, x1]` and `field` name. Keep `bands_order`.

#### Step B — Assign tokens to bands

* For each token on the page, find the band where `x0 ≤ token.x_center ≤ x1`.
* If a token straddles edges, prefer the band with the **largest overlap**; if tie, pick the leftmost.
* Discard tokens that fall outside **all** bands (these are not part of the line-item table).

#### Step C — Build parameter grid

Create a small Cartesian product of reasonable values, e.g.:

* `y_merge_tolerances`: `0.006, 0.009, 0.012`
* `description_merge_policy`: `greedy` (swallow more continuation lines) and `conservative` (stop earlier)
* `orphan_attach_policy`: `up` or `down` (attach lone tokens between rows to previous or next row)
  Each combination becomes **one hypothesis**.

#### Step D — Generate rows for one hypothesis

For a given `(y_merge, desc_merge, orphan)`:

1. **Form per-band lines**

   * Within each band, group tokens into text lines by `y_merge`.
   * Keep line bbox (`y0,y1`) and `text` (join with single spaces).

2. **Two-sided anchors**

   * **Left anchor**: a line present in either `no` or `description` band.
   * **Right anchor**: a line present in the `amount` band that **looks like amount-shaped text** (use `patterns.numeric` only; no currency normalization).
   * Mark these as potential row boundaries.

3. **Row assembly (monotonic)**

   * Walk top→bottom and create rows that have **both** a left and a right anchor within a reasonable vertical neighborhood.
   * A row’s vertical span `[y0,y1]` is the union of all cell line bboxes chosen for that row.

4. **Description swallowing (policy)**

   * `greedy`: include any contiguous band-description lines between the chosen left anchor and the first numeric band line (qty/unit_price/amount).
   * `conservative`: include only the first contiguous band-description line unless another is clearly within the row span (overlapping `y` with qty or amount lines).

5. **Cell fill**

   * For each field in `bands_order`, pick lines whose **y** intersects the row span and whose **x** lies within the band.
   * If multiple candidate lines exist in numeric bands, keep **all** for now (Phase 3 will break ties). Store them in order, oldest first.

6. **Orphan attach**

   * If a single unassigned line sits between two rows, attach it according to `orphan` policy if it falls within a small `y` buffer from either neighbor.

7. **Row validity flags**

   * `has_left_anchor` = description/no present
   * `has_right_anchor` = amount-shaped line present
   * Don’t drop rows in Phase 2; just mark flags. Phase 3 will score and can drop.

8. **Stats**

   * Count rows, average row height, per-row completeness (non-empty `description`, `qty`, `unit_price`, `amount`) as raw counters (no ML yet).

#### Step E — Repeat for all hypotheses

* Build the full list of hypotheses for the page.
* Ensure each hypothesis has a unique `hypothesis_id` encoding params (e.g., `y009_greedy_up`).

#### Step F — Write output

* Dump everything into `s06_lattices.json` as shown above.
* If `--debug`, optionally export a lightweight overlay per hypothesis that draws row boxes and band boundaries (optional for MVP).

---

### 3) Guardrails and “don’ts”

* **Don’t normalize** currency or rewrite text here. We’re just grouping tokens.
* **Don’t discard** rows just because they’re incomplete—mark them. The reranker (Phase 3) will decide.
* **Don’t guess** unit price vs amount here. Keep multiple numeric candidates in their band; tag them as a candidate list.

---

### 4) Test plan (quick and clear)

**T1 — Baseline**

* Run Phase 2 with default grid (3 y-merges × 2 desc policies × 2 orphan policies → 12 hypotheses).
* Expect ≥3 hypotheses produced with different `row_count` or different candidate counts per cell.
* Spot-check a few rows: tokens stay within their band; description lines are contiguous and in order.

**T2 — Greedy vs conservative**

* Compare a row with a long wrapped description: `greedy` should swallow more description lines than `conservative`.
* Both must keep numeric cells unchanged.

**T3 — Orphan attach**

* If there’s a single line between two rows, confirm `up` vs `down` attaches differently (row_count remains stable).

**T4 — Monotonicity**

* Verify that for every hypothesis `rows[i].y1 ≤ rows[i+1].y0` (allow tiny tolerance). No inversions.

**Pass criteria**

* All hypotheses valid and monotonic.
* Tokens never assigned outside their Phase-1 band.
* Each row has clear `flags` and candidate lists where ambiguity exists.