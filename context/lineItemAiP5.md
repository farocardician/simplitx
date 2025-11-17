# Phase 5 — Implementation Plan s06e_line_items_ai.py (Qwen extraction → final JSON)

**Goal**
Turn the resolved rows from Phase 4 into the **final `items[]` JSON** that matches your schema (same shape as your golden). Qwen’s job is **pure formatting/extraction**: join description spans, carry over field texts, and parse numerics to integers. No matching/normalization beyond parsing numerics; no arithmetic.

**Why now**
All hard structural choices (rows, fields, unit_price vs amount) are already done. Qwen just emits clean, schema-strict JSON.

---

## 1) Inputs, Outputs, Contracts

**CLI**

* `--in-rows`: path to `s08_rows_resolved.json` (Phase 4 output)
* `--out`: path for final JSON, e.g., `s09_qwen_output.json`
* `--config`: vendor key (loads prompt, schema format, few-shots, options)
* Optional:

  * `--mode {table,row}` (default `table` for short tables; `row` for long)
  * `--ollama-url` (default `http://192.168.86.123:11434`)
  * `--model` (default `qwen2.5:7b-instruct-q5_1`)
  * `--max-rows-per-call` (when chunking)

**Input contract**

* `s08_rows_resolved.json` contains pages → chosen `hypothesis_id` → `rows[]` with `cells.{no,description,qty,uom,unit_price,amount}.text`, and `flags.unresolved_fields` (possibly empty). Use the **texts** exactly as provided; do not re-segment rows. 

**Output contract**

* Final JSON strictly matching your vendor schema (`items[]` with fields like `no, sku, description, qty, uom, unit_price, amount`, plus your top-level metadata as in your plan/golden).
* All numeric fields parsed to integers (e.g., `"Rp 19.573.311"` → `19573311`).
* If an input field has **no digits**, output **`null`** for that field (don’t invent values).

---

## 2) Config you’ll use (read-only here)

* **Prompt template**: short base instruction that says “return **JSON only** that conforms to this schema; do not include extra keys; do not infer missing values; set non-numeric numeric fields to `null`.”
* **Schema/format**: the exact JSON shape you already defined (names and types).
* **Few-shots**: at most 1–2 tiny examples (optional).
* **Numbers policy**: text notes stating that currency symbols and thousands separators must be removed and decimals dropped (whole-number rupiah).
* **LLM options**: `temperature=0`, fixed seed if supported, short `max_tokens` appropriate for outputs.

(These live in your vendor config alongside other phases; re-use.)

---

## 3) Step-by-step workflow

### Step A — Load rows

* Read `s08_rows_resolved.json`. For each page, iterate the `rows[]` from the chosen hypothesis. **Do not** change row order or content. 

### Step B — Build the LLM input(s)

Two modes:

* **Table mode (default for short tables)**
  Build one compact table view including the header names and every row, with each cell’s **resolved text**. Keep it compact and machine-readable, e.g.:

  ```
  HEADER: NO | DESCRIPTION | QTY | UOM | UNIT_PRICE | AMOUNT
  ROW 1: NO="1" DESC="..." QTY="1" UOM="PAX" UNIT_PRICE="Rp 19.573.311" AMOUNT="Rp 19.573.311"
  ROW 2: ...
  ROW 3: ...
  ```

  Also include a one-line **field policy block**:

  * “If `QTY`, `UNIT_PRICE`, or `AMOUNT` contains no digits, set that field to `null`.”
  * “Parse numbers by removing `Rp`/spaces/`.`/`,` and output integers.”

* **Row mode (for long tables)**
  Send **N rows per call** (e.g., 20) with the same structure; collect and concatenate `items` across calls. Use `--max-rows-per-call` to control chunking.

### Step C — Compose the message using your config

* System content (if your runner supports it): “You are a strict JSON formatter.”
* User content:

  1. The **short base instruction** from config (JSON only, schema-strict, no inference).
  2. The **schema/format** (the minimal definition, not verbose).
  3. Optional: one tiny **few-shot** showing exactly how to parse a rupiah string.
  4. The **table/rows** payload built in Step B.
* **Do not** include any prior phases’ candidates/scores or free-text commentary—keep input lean.

### Step D — Call Qwen via Ollama

* POST to your Ollama host (`--ollama-url`, e.g., `http://192.168.86.123:11434`) with `model = qwen2.5:7b-instruct-q5_1`, `temperature=0`.
* If your runner supports “structured output” or a `format` field, pass your schema; otherwise rely on prompt + validation.

### Step E — Parse & validate

* Parse the response as JSON.
* Validate against your schema:

  * Required fields exist.
  * `qty`, `unit_price`, `amount` are **integers** or `null`.
  * Strings are strings; description is present (can be empty if input was empty).
* **One retry rule**: If parsing fails or types don’t match, resend **once** with the exact same rows plus a brief correction note (“Return valid JSON only; fix types; set non-numeric fields to null.”). If still invalid, stop and raise a clear error.

### Step F — Write output + light metrics

* Save `s09_qwen_output.json`.
* Side-log metrics (debug file): row count, null rates per numeric field, and whether a retry happened.

---

## 4) Guardrails and “don’ts”

* **Don’t** do arithmetic or matching. If `qty`×`unit_price` ≠ `amount`, still output what’s in the rows; Phase 5 is extraction only.
* **Don’t** re-rank or re-segment anything here—Phase 4 already decided the cells.
* **Don’t** silently coerce words to numbers. If the field text has **no digits**, output `null` (your prompt will direct Qwen to do this).

---

## 5) Test plan (fast)

**T1 — Your sample (3 rows)**

* Expect Row 1 & Row 2 to parse cleanly: `qty=1`, `unit_price=19573311`, `amount=19573311`.
* Row 3: `qty` likely becomes `null` (no digits), `uom` stays `"And"` (string), `unit_price=null`, `amount=39146622`. Confirm JSON validates. 

**T2 — Long table**

* Switch to `--mode row` or chunked table mode; ensure concatenated `items` preserves order and formatting.

**T3 — Invalid JSON retry**

* Temporarily perturb the prompt to force one invalid emission; confirm exactly **one** retry then success/fail with a clear message.

---

## 6) Operational notes

* **No extra services** needed beyond Ollama (Qwen) and your existing reranker (not used in this phase).
* Keep everything **stateless**; this phase can run as a pure CLI in CI.
* If you later want a confidence score per field, you can carry forward Phase-4 reranker scores in a sidecar file—but that’s optional.
