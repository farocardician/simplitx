Getting **correct line items** from messy tokens.

# 1) What “good” looks like

* Input is your PyMuPDF tokens with coords. We never normalize or “fix” content here. We only extract. 
* Output is a clean JSON with `items[]` and strict fields like `no, sku, description, qty, uom, unit_price, amount` that match your golden. 
* The schema and prompt are owned by your vendor config so you add or tweak vendors in one place. Qwen must return JSON only and follow that schema.  

# 2) Who does what

* **BGE-m3 embeddings** – creates cheap semantic signals that label tokens and shortlists candidates. Think of it as “soft type hints” for qty, uom, unit price, amount, description.
* **BGE-reranker-v2-m3** – makes the hard choices. It picks one header line, one table segmentation, and breaks ties when a row has multiple number candidates for a field.
* **Qwen 2.5** – turns the preselected row cells into the final JSON that fits your exact schema and few-shot style. It joins multi-line descriptions and parses prices like “Rp 39.146.622,00” into integers. 

# 3) The high-level flow

1. **Detect header and column bands**

   * Use the actual header tokens in the file to lock column x-bands for NO, DESCRIPTION, QTY, UOM, UNIT PRICE, TOTAL. This fences future decisions. 

2. **Build several row candidates**

   * Create 3 to 5 “row lattices” by varying y-tolerance and description merge rules. Each lattice must respect top-down order and keep amounts in the rightmost band.
   * Why several lattices? Because wrapped descriptions and right-aligned numbers are the source of off-by-one errors.

3. **Score and pick the best lattice**

   * BGE-m3 gives quick per-row field-type scores.
   * Reranker compares lattices and selects the single table that looks like proper line items with clear qty, uom, unit price and total. This mirrors the multi-hypothesis then rerank idea you liked from Perplexity. 

4. **Resolve remaining field ties per row**

   * If a row has two plausible numbers on the right, ask the reranker small questions like “which is unit price” and “which is total amount”.
   * Freeze those selections so Qwen does not have to guess.

5. **Ask Qwen once**

   * Send the minimal cleaned table view and your vendor config’s schema and few-shots. Tell it to return JSON only. Qwen joins description text and parses numbers, then emits the exact `items[]` you expect. 

6. **Validate and finish**

   * Validate against your config `format` and required fields. If a row fails, try the second-best lattice only for that row’s y-region once, then leave nulls if still uncertain. 

That’s the whole pipeline in one paragraph: **embeddings label, reranker chooses, Qwen formats**.

---

## 4) The line-item core, spelled out

### 4.1 Lock columns early

* From the header line in the tokens, compute x-bands for each field. Now any token that sits outside a band is not eligible for that field. This one step prevents price and amount swaps later. 

### 4.2 Two-sided row anchoring

* Every row must have a left anchor (NO or start of DESCRIPTION) and a right anchor (amount-looking token in the TOTAL band, often “Rp … big number”). If either side is missing, that row is suspicious. 

### 4.3 Build 3 to 5 row lattices

* Vary the y-merge threshold and how aggressively you swallow description lines between the description band and the numeric bands. Your golden shows descriptions that include things like dates and places; keep them intact. 

### 4.4 Scoring per lattice

* **Embeddings** – quick priors: qty looks numeric, uom looks like PAX, unit price and total look like currency or big numbers.
* **Reranker** – pick the lattice that gives one clean item per row with all required fields present.

### 4.5 Field tie-breaking

* For any row with multiple candidates in a band, let the reranker choose. Example prompts: “Select the per-unit price” and “Select the total amount for the row”.

### 4.6 Qwen as the last mile

* Compose the single message using your config format, prompt, and optional few-shots, then send the final table view so Qwen’s job is simple: join description text and output valid JSON. Your config already defines how to construct that message and enforce the schema.  

---

## 5) Practical details you’ll care about

### 5.1 Inputs and outputs are already well-defined

* Input tokens show real headers and currency text, which is why the band and right-anchor approach works here.  
* Output schema lists all required fields, so validation is straightforward. 

### 5.2 Using your config-driven tool

* Keep prompt, schema `format`, golden pairs, and options in a vendor config. Override model and host via CLI when needed. Your plan already documents the structure, flags, and testing flow.  

### 5.3 When to call Qwen once vs per row

* Small tables – call Qwen once with the full table.
* Long tables – call per row to keep context short, then concatenate `items`.

### 5.4 Determinism knobs

* Temperature 0, fixed seed, schema `format` on. Keep prompts short and explicit about “JSON only” and the exact fields. 

### 5.5 Failure and retry

* If JSON fails validation, try the second-best lattice only for that row. If it still fails, set the uncertain fields to null and move on. This keeps the run predictable. 

---

## 6) How this blends your plan and the Perplexity idea

* You keep the **config-driven** composition and strict schema from your plan. Qwen returns what the schema demands. 
* You keep Perplexity’s **multi-hypothesis then rerank** spirit, but center it tightly on **row segmentation** and **field disambiguation**, which is where accuracy is won or lost. 

---

## 7) Minimal checklists

**Extraction checklist**

* Columns locked from header tokens
* Build 3 to 5 row lattices
* Embedding priors per row and field
* Reranker picks best lattice
* Reranker breaks any field ties
* Qwen outputs JSON under the vendor schema
* Validate. One local retry on failure. Done

**Quality checklist**

* Off-by-one rows eliminated by two-sided anchors
* Unit price vs total chosen by reranker, not guessed
* Description is the full span between bands, same as golden 
* All required fields present or null, never hallucinated 

---

## 8) What to measure

* Lattice pick accuracy – percent of tables where top-1 lattice passes validation first try
* Per-row field tie rate – how often reranker had to decide unit price vs total
* Qwen parse failures – should be near zero with schema `format` on
* End-to-end pass rate against goldens in your config set 

---

## 9) How to extend

* New vendor – copy a config, tune header synonyms, prompt style, few-shots, and you’re set. The line-item core stays the same. 

---

### One-liner summary

Use embeddings to label, reranker to choose, and Qwen to format. Lock columns from the real header, build multiple row lattices, let the reranker pick the best grid and break ties, then have Qwen output exactly your schema.


# Phases (short and testable)

1. **Header & Column Bands (Deterministic)**
   Find the true header row from tokens and lock left-to-right **x-bands** for: NO, DESCRIPTION, QTY, UOM, UNIT PRICE, TOTAL (or your vendor’s schema). Output a small JSON with band coordinates and metadata.

2. **Row Lattice Generator (Multi-Hypothesis)**
   Build 3–5 candidate row segmentations by varying y-tolerance and description merge rules. Each “lattice” is an ordered list of rows, each row holding tokens grouped by the bands from Phase 1.

3. **Table Selection (Embeddings + Reranker)**
   Score each lattice with BGE-m3 signals (field-type fit, completeness). Ask the BGE reranker to pick the single best table hypothesis. Output the chosen lattice and a short score report.

4. **Row Field Tie-Breaking (Reranker, Row-Level)**
   For rows that still have ambiguous numbers (e.g., which is **unit_price** vs **amount**), generate tiny k-way candidates and let the reranker choose. Freeze those picks. Output “resolved rows.”

5. **Qwen Extraction (Schema-Strict JSON)**
   Compose the single user message from config (schema format + short few-shot). Send either the full table or per-row to Qwen (temperature 0). Output the final `items[]` JSON.

6. **Validation, Retry, and Metrics (Deterministic)**
   Validate types/required fields. If a row fails, retry once with the second-best local lattice for that row’s y-window. Emit final JSON + a metrics log (pass/fail counts, tie-break frequency, reranker scores).