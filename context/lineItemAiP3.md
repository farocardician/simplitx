# Phase 3 — Implementation Plan s06c_line_items_ai.py (Table Selection with Embeddings + Reranker)

**Goal**
From `s06_lattices.json`, pick **one** best table hypothesis per page (the grid that represents true line items) using lightweight embedding signals and your local BGE cross-encoder reranker at `http://localhost:9000`. No LLMs here.

**Why**
Good selection now makes Phase 4 (tie-breaking) trivial and Phase 5 (Qwen) deterministic.

---

## 1) Inputs, Outputs, Contracts

**CLI**

* `--in-lattices`: path to `s06_lattices.json` (Phase 2 output)
* `--out`: path to `s07_table_selected.json`
* `--config`: vendor key (loads prototypes and scoring weights)
* Optional: `--page` (single page), `--debug` (dump a small scoreboard per page)

**Config (read-only here)**

* `prototypes` (short strings):

  * `qty_like`: e.g., “integer quantity”, “count of items”
  * `uom_like`: e.g., “unit of measure”, “PAX”, “PCS”, “DAY”
  * `unit_price_like`: e.g., “price per unit”, “unit price number”
  * `amount_like`: e.g., “total amount for the row”, “row total”
* `penalties`: small weights for anomalies (e.g., text tokens in numeric fields)
* `reranker.query_templates`: short natural-language prompts for hypothesis and field scoring
* `score_weights`: weights for combining signals (completeness, type-fit, consistency)

**Output**
`s07_table_selected.json`

```
{
  "doc_id": "...",
  "pages": [
    {
      "page_index": 0,
      "chosen": {
        "hypothesis_id": "y009_greedy_up",
        "score": 0.87,
        "reason": "highest completeness and field-type fit; rows look like 1 item each"
      },
      "alternates": [
        {"hypothesis_id": "y006_conservative_up", "score": 0.79},
        {"hypothesis_id": "y012_greedy_down", "score": 0.74}
      ],
      "diagnostics": {
        "row_level": [
          {
            "row_id": 2,
            "flags": {"has_left_anchor": true, "has_right_anchor": true},
            "field_anomalies": ["qty_text_has_letters"]
          }
        ]
      }
    }
  ],
  "created_at": "ISO8601",
  "config_version": "vX.Y"
}
```

**Acceptance**

* Exactly one hypothesis chosen per page.
* A short score breakdown saved (enough to debug).
* No tokens or structure are modified; you only select.

---

## 2) Step-by-Step Workflow

### Step A — Load

* Read `s06_lattices.json`. For each page, gather its `hypotheses` and `bands_order`. 

### Step B — Cheap per-row signals (embeddings optional, fast heuristics mandatory)

For each hypothesis, compute these **deterministic** features per row, then average/sum to hypothesis-level:

1. **Completeness**

   * Row has non-empty `description`, `qty`, `uom`, `unit_price`, `amount`. (Binary per row; aggregate as rate.)
2. **Type-shape checks** (no normalization):

   * `qty`: mostly digits (allow 1 token).
   * `uom`: short alphabetic token (e.g., `PAX`, `PCS`).
   * `unit_price` and `amount`: look “amount-shaped” (≥3 digits or separators).
   * Count anomalies like letters in numeric fields or too many tokens in `qty`.
3. **Band discipline** (should already hold): ensure cell tokens remain inside bands.

> Keep these rules forgiving; they nudge, not gate.

### Step C — Embedding “fit” scores (using `bge-m3`)

For each **cell text**, compute cosine similarity to the appropriate prototype(s) and record the max per field:

* `qty` vs `qty_like`
* `uom` vs `uom_like`
* `unit_price` vs `unit_price_like`
* `amount` vs `amount_like`

Aggregate per row (mean of fields), then per hypothesis. Cache embeddings across runs.

> Hint: Treat prototypes as fixed strings kept in config. Compute their embeddings once at startup. Do not call the LLM here.

### Step D — Build a short **candidate string** per hypothesis (for reranker)

Construct a compact text snippet summarizing the header and the **first N rows (e.g., 5)**:

```
Header: NO | DESCRIPTION | QTY | UOM | UNIT PRICE | AMOUNT
Row1: [desc="..."] [qty="1"] [uom="PAX"] [unit_price="Rp 19.573.311"] [amount="Rp 19.573.311"]
Row2: ...
```

* Keep it brief. Avoid dumping all rows to the reranker; use N head rows plus N tail rows if the table is long (e.g., 3 head + 2 tail).
* This keeps the cross-encoder context small and consistent across hypotheses.

### Step E — Reranker call (cross-encoder at `http://localhost:9000`)

Send **one query** with the instruction from config, e.g.:

> “Select the table segmentation where each row corresponds to exactly one line item with coherent DESCRIPTION, QTY, UOM, UNIT PRICE, and AMOUNT. Prefer hypotheses with fewer anomalies in numeric fields and clearer per-row structure.”

Provide the list of hypothesis snippets as candidates; get back relevance scores. (Batch per page.)

> Hint: Use the same request shape you already use for your reranker service in other tools; if the API supports “query + list of texts → scores,” use that. No need to overthink it.

### Step F — Combine signals → final score

For each hypothesis `h`:

```
score(h) =
  w1 * reranker_score(h)
+ w2 * completeness_rate(h)
+ w3 * mean_field_type_fit(h)          // from embeddings
- w4 * anomaly_rate(h)                 // from Step B
```

* Keep weights simple and in config (e.g., `w1=0.6, w2=0.2, w3=0.15, w4=0.05`).
* Rank hypotheses by `score(h)`. Choose **top-1**; record top-3 as alternates.

### Step G — Diagnostics (lightweight)

For the chosen hypothesis, emit a small per-row diagnostic list:

* `flags.has_left_anchor/has_right_anchor` (copied from Phase 2)
* Any anomalies detected (e.g., “qty_text_has_letters”, “amount_missing_digits”)

### Step H — Write output

Save `s07_table_selected.json` with chosen hypothesis id and a tiny scoreboard per page (as in the Output schema above).

---

## 3) Guardrails and “don’ts”

* **Don’t** mutate rows or cells in Phase 3. You only **score and select**.
* **Don’t** normalize currency or run math here. Keep it extraction-only.
* **Don’t** send entire pages to the reranker. Keep snippets short and uniform across hypotheses.

---

## 4) Test Plan (quick)

**T1 — Single page (your sample)**

* Expect a clear top-1 hypothesis. Verify the one with more wrapped description captured (often `greedy` + mid `y_merge`) tends to win. 

**T2 — Hypotheses tie**

* If two are close, reranker score should break the tie. Confirm alternates list contains the runner-up with a slightly lower final score.

**T3 — Anomaly stress**

* Manually inject letters into a qty cell in one hypothesis; confirm its anomaly penalty drops it below a cleaner hypothesis.

**Pass criteria**

* Exactly one winner per page, alternates recorded, and consistent scoring across re-runs (same config).
