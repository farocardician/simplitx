You are a senior Python engineer working locally. Build a single-file CLI tool from scratch (name it `s04_rag.py`) that performs **in-memory** RAG extraction for invoices across **multiple pages**. No database, no pgvector, no env vars.

---

# OBJECTIVE

Given:

* **Tokens JSON** (S02-style) via `--token`
* **Segments JSON** (S03-style) via `--segment`
* **Config JSON** via `--config`

Produce one **output JSON** at `--out` with three sections:

1. `header` (e.g., `invoice_number`, `invoice_date`, `buyer_name`)
2. `table` (normalized line items)
3. `total` (e.g., `subtotal`, `tax`, `grand_total`)

All retrieval and scoring must be **in memory**:

* Dense similarity (embeddings + cosine)
* Lexical score (token overlap / Jaccard)
* Hybrid combine (weighted)
* Rerank top candidates via an HTTP reranker service from config

Default behavior processes **all pages**; `--page` limits to specific pages.

---

# CLI REQUIREMENTS

Implement argparse with:

* `--token` (required): path to S02 JSON (tokens)
* `--segment` (required): path to S03 JSON (regions)
* `--config` (required): path to config JSON
* `--out` (required): path to output JSON

Optional:

* `--tokenizer` (optional): which S02 sources to load. Allowed values:

  * `plumber`, `pymupdf`, `ocr`, `all`, or a comma list (e.g., `plumber,pymupdf`)
  * Include both `*.tokens` and `*.words` if present
  * If a requested source is missing, skip quietly and log at DEBUG
  * If none are available after filtering, exit with a helpful error that lists available sources
* `--page` (optional): page selector

  * Default: `all` (process every page that has at least one of the regions)
  * Examples: `--page 1`, `--page 1,3,5`

**Do not implement** `--doc-id`, `--reindex`, or any DB flags. There is no Postgres in this project.

---

# CONFIG REQUIREMENTS

All infrastructure and behavior lives in the config (no env vars). Validate required keys and provide clear error messages if missing.

**Infrastructure section** (examples of keys; use these exact names):

* `embedding.provider` (e.g., `"ollama"`)
* `embedding.model` (string)
* `embedding.timeout_sec` (int, default sensible)
* `embedding.batch_size` (int, optional)
* `reranker.base_url` (string, like `"http://localhost:9000"`)
* `reranker.model` (string, e.g., `"bge-reranker-v2-m3"`)
* `reranker.timeout_sec` (int, default sensible)
* `retrieval.dense_topk` (int, e.g., 20)
* `retrieval.rerank_topk` (int, e.g., 5)
* `retrieval.hybrid_alpha` (float in [0,1], weight for dense vs lexical; default 0.5)

**Behavior section**:

* `defaults.tokenizer` (optional, fallback if CLI not provided)
* `defaults.pages` (optional, `"all"` or list of ints)
* `locale.decimal_separator` (e.g., `"."`)
* `locale.thousand_separator` (e.g., `","`)
* `header.fields` (array of field ids, e.g., `["invoice_number","invoice_date","buyer_name"]`)
* `header.query_synonyms` (object: field -> array of strings)
* `header.normalize` (object: field -> normalization rules; regex patterns, date formats, casing rules)
* `table.columns` (array of objects: `id`, `name`, `type`)
* `table.header_synonyms` (object: column id -> array of synonyms)
* `table.row_detection` (y-gap thresholds, min cells per row, wrap/merge rules)
* `table.normalize` (object: column id -> normalization rules for numbers/currency/UOM)
* `total.keys` (array of key ids, e.g., `["subtotal","tax","grand_total"]`)
* `total.query_synonyms` (object: key -> array of strings)
* `total.normalize` (object: key -> normalization rules)
* `validation.tolerance.line_total` (float; allowed relative or absolute error)
* `validation.tolerance.grand_total` (float)
* `validation.behavior_on_mismatch` (e.g., `"warn"` or `"diagnose"`)

**Behavior**: CLI overrides config defaults for tokenizer and pages.

---

# INPUT FILE EXPECTATIONS

**S02 (tokens)**

* May contain top-level `pages` or `tokens`
* May contain nested containers: `plumber`, `pymupdf`, `ocr`

  * Each container may have `tokens`, `words`, and/or `pages[i].tokens / pages[i].words`
* Tokens/words have at least:

  * page number or inferable page index
  * text
  * bbox (x0,y0,x1,y1) in normalized page coordinates [0..1] (assume normalized; do not rescale)
* You must rebuild **reading-order lines** from tokens/words per page

**S03 (segments)**

* For each page, there may be zero or more region entries for:

  * `header` (single bbox per page typical)
  * `table` (one or more bboxes per page)
  * `total` (single bbox per page typical)
* Region bboxes are normalized [0..1] page coordinates

Handle missing regions gracefully (skip that region for that page).

---

# OUTPUT JSON REQUIREMENTS

Write a single JSON with this shape:

```
{
  "header": { "<field>": "<normalized_value>", ... },
  "table": [
    { "<columnId>": "<normalized_value>", ... },
    ...
  ],
  "total": { "<key>": "<normalized_value>", ... },
  "meta": {
    "pages_processed": [1, 2, ...],
    "token_sources_used": ["plumber","pymupdf",...],
    "diagnostics": {
      "header": { "<field>": { "chosen_page": 1, "chosen_line_no": 12 } },
      "table": { "rows": <int>, "columns_detected": ["sku","qty","unit_price","line_total"] },
      "total": { "<key>": { "chosen_page": 1, "chosen_line_no": 47 } },
      "validation": {
        "line_checks_passed": <bool>,
        "subtotal_match": <bool>,
        "grand_total_match": <bool>,
        "notes": [ "subtotal off by 0.7%", ... ]
      }
    }
  }
}
```

If `--echo` is not requested, you can omit the verbose parts of `meta.diagnostics` but keep `pages_processed` and `token_sources_used`.

---

# HIGH-LEVEL ALGORITHM

1. **Parse CLI** and **load config**. Apply CLI overrides (`--tokenizer`, `--page`) on top of config defaults.

2. **Load S02** and **select token sources**:

   * If `--tokenizer` provided:

     * Allowed: `plumber`, `pymupdf`, `ocr`, `all`, or comma list
     * If `all`, include all that exist among the three
     * Include both `*.tokens` and `*.words` when present
     * Missing sources → DEBUG log and skip
     * If none usable → EXIT with clear error listing available sources
   * If not provided: use `defaults.tokenizer` from config if present, else include all available

3. **Load S03** and create the **page set**:

   * If `--page` not provided: `all` pages that contain at least one region (header/table/total)
   * If user specified pages, use those; if a requested page has no regions, skip with DEBUG log

4. **Rebuild reading-order lines per page** from chosen tokens/words:

   * Group tokens into lines by y-proximity and x ordering
   * Preserve a stable `line_no` per page (reading order)

5. **Slice lines by region bboxes** per page:

   * **Header**: collect lines intersecting the `header` bbox
   * **Table**: per table bbox, collect candidate lines inside it (one pool per table region)
   * **Total**: collect lines intersecting the `total` bbox

6. **Union across pages**:

   * Header: union all header-candidate lines from selected pages into one pool
   * Table: maintain a list of table-region pools; combine later if config declares a single logical table
   * Total: union all total-candidate lines into one pool

7. **Hybrid retrieval + rerank (in memory)**:

   * **Embedding**:

     * Build an embedding adapter that returns a vector for a string using `embedding.*` settings
     * Memoize: if the same text is embedded multiple times, reuse the vector
     * Batch if `embedding.batch_size` provided
   * **Lexical score**:

     * Compute token-overlap/Jaccard (lowercase, split on non-word)
   * **Combine**:

     * Normalize dense and lexical to [0,1] (min-max on the candidate set)
     * `hybrid_score = alpha * dense + (1 - alpha) * lexical` where `alpha = retrieval.hybrid_alpha`
   * **Top-K and rerank**:

     * For a query, take top `retrieval.dense_topk` by hybrid score
     * Call reranker (`reranker.base_url`, `reranker.model`) with the query text and candidate strings
     * Reranker returns a ranking; choose the top candidate
     * If reranker fails, log ERROR and fallback to the current hybrid order (do not crash)
   * **Queries**:

     * **Header fields**: build query text as “OR-joined” synonyms or pass list; pick one best line; also attempt neighbor lines (+1, +2) when normalizing if configured
     * **Total keys**: same as header but applied to `total` pool
     * **Table**:

       * Detect table header line inside the table region:

         * Choose the line with the highest aggregate match against `table.header_synonyms`
       * Derive **column bands** either:

         * From matched header tokens/segments, or
         * From x-clustering of text positions
       * For each remaining line, assign it to a row by y-gaps
       * For each row and each column band, shortlist texts that fall inside the x-band; apply the same hybrid + rerank to pick the best cell text
       * Join wrapped cell fragments if needed, then normalize per column rules

8. **Normalization** (per field/column/key):

   * Apply regex extractions, trim labels, standardize dates (respect locale if given), parse numbers with `locale.decimal_separator` and `locale.thousand_separator`, normalize currency symbols and UOMs
   * Ensure numeric columns become numbers in the final JSON (not strings)

9. **Validation & reconciliation**:

   * For each row: check `qty * unit_price ≈ line_total` within tolerance
   * For totals:

     * `sum(line_total) ≈ subtotal` within tolerance
     * `subtotal ± adjustments (discount, shipping, tax, …) ≈ grand_total` within tolerance
   * If mismatches exceed tolerance, set `meta.diagnostics.validation.* = false`, add human-readable notes, and (per `validation.behavior_on_mismatch`) either warn or include diagnostic fields—do not crash

10. **Determinism & ties**:

* If scores tie after rerank (or fallback), prefer **lower page number**, then earlier **reading order** (lower `line_no`)
* Keep ordering deterministic across runs

11. **Logging**:

* `INFO`: pages processed, token sources actually used, counts of header/table/total candidates, number of table rows emitted, validation status
* `DEBUG`: skipped sources, per-stage timings, table header chosen, derived column bands, and top-K candidate snippets (only when a `--echo` flag is present; include `--echo` in argparse)
* `ERROR`: unknown tokenizer name, no usable sources, reranker unreachable, embedding failures, validation over tolerance (with clear next steps)

12. **Write output JSON** to `--out` with the exact shape specified above.

13. **Exit codes**:

* 0 on success
* Non-zero on fatal errors (bad CLI, unreadable files, no usable token sources, invalid config)

---

# FUNCTIONAL SCOPE PER REGION

**Header**

* One best normalized value per requested field
* Use neighbor-line peek (+1, +2) when configured (attempt normalizing those if main line fails)

**Table**

* Robust header detection using synonyms
* Stable column band derivation
* Row grouping by y-gaps; configurable thresholds
* Cell selection by x-band + hybrid + rerank
* Normalized numeric types

**Total**

* One best normalized value per requested key

---

# PERFORMANCE & ROBUSTNESS

* Memoize embeddings within the run
* Optional batching for embeddings and rerank calls
* Cap candidate pools if needed (configurable)
* Timeouts and retries for HTTP calls (embedding if remote, reranker)
* Clear, concise errors with actionable advice

---

# ACCEPTANCE TESTS (baked into docstrings or comments)

* Default run (`--page all`, no `--tokenizer`) yields correct header/table/total on provided samples
* `--tokenizer plumber` limits sources and still succeeds
* `--tokenizer plumber,pymupdf` merges sources correctly
* `--page 1` only uses page 1; `--page 1,3` uses those pages only
* Reranker failures gracefully fallback; outputs still produced
* Validation flags discrepancies with clear notes

---

# EXAMPLE CLI (for docs/help strings; do not hardcode paths)

* `python3 s04_rag.py --token <path/to/s02.json> --segment <path/to/s03.json> --config <cfg.json> --out <result.json>`
* `python3 s04_rag.py --token ... --segment ... --config ... --out ... --tokenizer plumber,pymupdf`
* `python3 s04_rag.py --token ... --segment ... --config ... --out ... --page 1`

---

# TEST

Vendor ESI Varian 1:
services/pdf2json/results/esi/1/s02.json
services/pdf2json/results/esi/1/s03.json

Vendor ESI Varian 2:
services/pdf2json/results/esi/2/s02.json
services/pdf2json/results/esi/2/s03.json

Vendor KASS Varian 1:
services/pdf2json/results/kass/1/s02.json
services/pdf2json/results/kass/1/s02.json

Vendor KASS Varian 9:
services/pdf2json/results/kass/9/s02.json
services/pdf2json/results/kass/9/s02.json

---

# IMPLEMENTATION NOTES

* Organize code into small, well-named functions with docstrings and following best practice
* Use clear type hints and meaningful error messages
* Avoid external dependencies beyond standard libraries and whatever minimal HTTP/JSON you need
* Make sure this is Config-Driven Design. Keep all business logic driven by configuration files. Do not hardcode any client-specific logic — new clients should only require adding or editing a config file

**Do not include any database or environment-variable logic.** Everything must be in memory and configured via the config JSON.

---

**Deliverable**: a single executable Python script `s04_rag.py` that implements the CLI and behavior above and writes the output JSON in the specified shape.
