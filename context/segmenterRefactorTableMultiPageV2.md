Refactor Stage-3 segmentation to be **100% config-driven**. No vendor strings or magic numbers in code. A **single config per client** must handle all their variants (1-page, 2-page with end anchor on next page, and true multi-page tables) without touching Python.

# Non-negotiables

* **No hard-coded patterns** in Python (e.g., “Article Number”, “Says :”, “INVOICE”). All of these live in config.
* **One client = one config file.** That one file must handle multi-variant documents for that client.
* **Engine defaults are also config-based**, not code. Use a global defaults file or a `defaults` block the engine loads first.
* **Best practice**: clear separation of concerns, pure detection functions, schema validation, explicit precedence, rich debug logs.

# High-level behavior (unchanged conceptually)

* Detect table via **line_anchors** with start = “Article Number” and end = “Says :” (patterns from config).
* Use **per-page header floors** as vertical fences on every page; **only page-1 header** contributes values.
* Cross-page span with **unbounded forward lookahead** (unless config limits it).
* Continuations: **skip page header band**, then **skip repeated table header** if present; else **start at first data row**.
* **Drop empty parts**, pick **last page with numeric rows** as canonical, **stitch** for context.

# Config-first design

Implement a **layered config** with **explicit precedence**:

**Precedence (lowest → highest):**

1. Engine built-ins (should be minimal; only essentials like safe numeric regex if absolutely needed)
2. `defaults` (global defaults file or top-level `defaults` block)
3. Client config (`clients/rittal.json`, etc.)
4. CLI overrides (optional)

**If a field is absent at a higher layer, inherit from the lower layer.**

## Config schema (describe in English; codegen should turn into JSON schema)

Top-level keys you must support:

* `metadata`:

  * `client_name` (string), `schema_version` (semver), `notes` (string)

* `defaults`:
  Global knobs that apply unless overridden in `client`:

  * `anchor_scope`: `"auto" | "page" | "document"` (default: `auto`)
  * `max_page_gap`: `null | integer` (default: `null` = unbounded)
  * `skip_page_headers`: `"auto" | true | false` (default: `auto` for line_anchors)
  * `start_rows_below`: integer (default: 1 for line_anchors)
  * `value_part_policy`: `"last_numeric" | "last" | "first_numeric"`
  * `canonical_bbox`: `"value" | "union"`
  * `margins`: `{top, right, bottom, left}` small non-negative numbers
  * `x_policy`: `"full" | "clamped"`
  * `row_patterns`: list of regex (row-looking detection)
  * `numeric_locale`: `{thousands, decimal}` (e.g., `.` and `,`)
  * `header_detection`:

    * `sentinels`: list of line regex (e.g., INVOICE, Number/Date, To:, company name patterns)
    * `ratio_top_fallback`: number (e.g., 0.15)
    * `margin_px`: number
  * `table_header_detection`:

    * `patterns`: list of line regex to recognize the repeated **table** header
    * `search_band_ratio`: number (scan zone below header floor)

* `client`:

  * `anchors`:

    * `start_anchor`:

      * `by`: `"line_anchors"`
      * `patterns`: array of regex (e.g., `^Article\\s+Number$`)
      * `flags`: `{ignore_case, normalize_space, fold_diacritics}`
      * `select`: `"first" | "last"`
    * `end_anchor`:

      * same fields (e.g., `^Says\\s*:$`)
  * `table`:

    * `use_per_page_header_floors`: true
    * `continuation_rules`:

      * `skip_repeated_table_header`: `"auto" | true | false`
      * `first_data_row_strategy`: `"row_patterns"` (use defaults.row_patterns unless overridden)
    * `x_bounds`:

      * `mode`: `"full" | "from_header_columns"`
      * `from_header_columns`: optional list of column titles to infer band (e.g., Article Number, Description, Qty, Unit Price, Amount)
    * `lookahead`:

      * `max_page_gap`: override or inherit
    * `output`:

      * `canonical_bbox`: override or inherit
      * `emit_parts_metadata`: true
  * **Optional** `when` blocks for **conditional tweaks inside a single client config** (still one file):

    * Each `when` has:

      * `match`: list of cues from tokens/lines (e.g., a specific logo word, payment terms phrase, or page size)
      * `overrides`: only the fields that differ (e.g., slightly different table header pattern)
    * If multiple `when` match, highest priority `when` wins (document rule: first match wins)

> Goal: this still counts as **one config per client**. You can cover several internal layouts by using `when` guarded overrides inside the same file, not multiple files.

# Implementation guidance (no code)

1. **Config loader**

   * Load defaults; deep-merge client config; then apply CLI overrides.
   * Validate with a JSON Schema; fail early with clear messages.
   * Expose a resolved, fully-materialized `cfg` object (no `None`s where a default exists).

2. **Per-page header floors**

   * Build `lines_by_page`.
   * For each page: try `header_detection.sentinels` first; else `ratio_top_fallback`.
   * Save `header_floor[page]`.

3. **Anchor resolution**

   * Use `client.anchors.*` patterns and flags.
   * `anchor_scope: auto`: try same page; else forward pages up to `max_page_gap` or end.
   * Keep first match policy per config.

4. **Part construction**

   * For each page in the span:

     * `top = header_floor[page]`
     * On start page, `top = max(top, start_line_y + small_margin)`
     * If repeated table header is present within search band, raise `top` to just below it.
     * If not, raise `top` to the **first data row** that matches `row_patterns` and locale numeric rules.
     * On end page, set `bottom = end_line_y − small_margin`; else `bottom = page_bottom`.
     * Drop if `bottom <= top`.

5. **Part guard & canonical selection**

   * Count row-looking lines inside the part; drop if zero.
   * Canonical by policy (default `last_numeric`).

6. **Output & debug**

   * Return canonical bbox plus stitched union (if asked).
   * Add `metadata.parts` with per-page boxes and page indices.
   * Add `metadata.debug`:

     * which header detection path used (sentinel vs ratio)
     * whether repeated table header found
     * which first data row selected
     * canonical selection reason
     * applied `when` block (if any)

7. **No hard-coding check**

   * Ensure the code has **no literals** for vendor text, money regex, anchor strings, header keywords.
   * All literals must come from `defaults` or `client` config.

# Best-practice guardrails

* **Schema validation**: require/forbid fields; helpful errors.
* **Deterministic**: same input, same output. Avoid nondeterministic ordering.
* **Pure functions**: keep IO and detection separate; pass in `cfg`, `s02`, and return results.
* **Naming**: clear identifiers like `header_floor_by_page`, `continuation.has_repeated_table_header`.
* **Logging**: concise, structured; no spam.
* **Performance**: only linear scans over pages; early exits when possible.

# Acceptance tests (must pass with no Python edits between clients)

Use three fixtures (`s02.json`, `s02-2page.json`, `s02-4page.json`) and **two clients** to prove “one config per client”:

1. **Client A (Rittal)**: one config file handles all three variants.

   * 1-page: start/end on p1; canonical p1; no page header included.
   * 2-page: start p1, end on p2; p2 has no rows → dropped; canonical p1.
   * 4-page: rows on p1–p4; canonical p4; page headers and repeated table headers excluded on continuation pages.

2. **Client B (Different vendor)**: create a new config file (no Python change).

   * Different header sentinels and anchor phrases; same engine works.
   * Prove it can segment 1- and multi-page layouts without code edits.

Assert for each:

* Correct start, end, and canonical pages
* Final bbox doesn’t overlap header floors
* Repeated table header rows excluded on continuation pages
* Debug shows which `when` block (if any) was applied and why


## Test

how to create s03.json:
* `CLIENT=rittal VARIANT=<N> && \
docker exec simplitx-pdf2json-1 python3 stages/s01_tokenizer.py \
  --in /app/training/$CLIENT/$VARIANT/$VARIANT.pdf \
  --out /app/training/$CLIENT/$VARIANT/s01.json && \
docker exec simplitx-pdf2json-1 python3 stages/s02_normalizer.py \
  --in /app/training/$CLIENT/$VARIANT/s01.json \
  --out /app/training/$CLIENT/$VARIANT/s02.json && \
docker exec simplitx-pdf2json-1 python3 stages/s03_segmenter.py \
  --in /app/training/$CLIENT/$VARIANT/s02.json \
  --out /app/training/$CLIENT/$VARIANT/s03.json \
  --config /app/config/s03_invoice_${CLIENT}_segmenter_v1.json \
  --overlay /app/training/$CLIENT/$VARIANT/$VARIANT.pdf \
  --tokenizer plumber`

**Fixtures to verify (client `rittal`):**

* `services/pdf2json/training/rittal/1/s02.json` ↔ `services/pdf2json/training/rittal/1/s03-GOLD.json`
* `services/pdf2json/training/rittal/2/s02.json` ↔ `services/pdf2json/training/rittal/2/s03-GOLD.json`
* `services/pdf2json/training/rittal/3/s02.json` ↔ `services/pdf2json/training/rittal/3/s03-GOLD.json`
* `services/pdf2json/training/rittal/4/s02.json` ↔ `services/pdf2json/training/rittal/4/s03-GOLD.json`


**Fixtures to verify (client `kass`):**
* `services/pdf2json/training/kass/6/s02.json` ↔ `services/pdf2json/training/rittal/6/s03-GOLD.json`
* `services/pdf2json/training/kass/9/s02.json` ↔ `services/pdf2json/training/rittal/9/s03-GOLD.json`
* `services/pdf2json/training/kass/13/s02.json` ↔ `services/pdf2json/training/rittal/13/s03-GOLD.json`

**Run (per variant, rittal 1-4, kass 6 9 13):**
Set `CLIENT=rittal VARIANT=<N> SUBFOLDER=training` then run:

```
python3 scripts/verifySegmen.py \
  --token services/pdf2json/$SUBFOLDER/$CLIENT/$VARIANT/s02.json \
  --segmen services/pdf2json/$SUBFOLDER/$CLIENT/$VARIANT/s03.json \
  --compare services/pdf2json/$SUBFOLDER/$CLIENT/$VARIANT/s03-GOLD.json \
  --region-id table
```

**Pass criteria (all variants):**

* `verifySegmen.py` reports **match** for `--region-id table`.

# Deliverables

* Updated segmenter with **config-only** customization.