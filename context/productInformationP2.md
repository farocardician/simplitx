**Phase 2 — Review page (read-only suggestions)**. 


## 1) Objectives

* Add a **Review** screen (new tab) that shows one card per line item.
* Display **suggested** values for `<HS Code>`, `<UOM>`, and `<Type>` using the keys you set in Phase 1 (`(vendorId, sku)` first, else `(vendorId, description)`).
* Clearly indicate **status** for each field (match/mismatch/missing) so a reviewer understands what will likely be saved in Phase 3.
* Do **not** allow edits in this phase—just preview suggestions and states.
* Keep the **Queue** and **XML download** flows as they are today (no behavior change). Repo already serves XML from `job.resultPath`, so nothing breaks while we add this read-only layer. 

---

## 2) Steps

### Step A — Add a Review route (page shell)

* Create a new **Review** page that opens from the Queue (new tab). Use the existing job id to load the parsed invoice JSON (the same one used to produce the current XML).
* Show a simple header with: **Invoice #**, **Date**, **Vendor**, and item count.
* Rationale: this keeps Phase 2 isolated—no edits or DB writes yet. The goal is a safe “preview layer.”

### Step B — Fetch inputs needed to render

* **From job**: the parsed items with `description`, `qty`, `unit_price`, `amount`, and whatever your json→xml step already outputs (these exist today and feed the XML).
* **From DB**: query `productInformation` using the Phase 1 keys:

  * Try `(vendorId, sku)` first, else `(vendorId, description)`.
  * The matching order is exactly what you documented; reuse that ordering when computing suggestions so future phases align. 

### Step C — Compute **per-field states** (HS, UOM, Type)

For each field (HS/UOM/Type), compare the **JSON value** (what the pipeline extracted) vs the **DB suggestion** (what Phase 1 lookup returns). Assign a state:

1. **Exact Match**

   * JSON has value, DB has value, **and they’re equal**. Show a small green “Match”.
2. **Mismatch**

   * JSON has value, DB has value, **but differ**. Show amber “Mismatch”.
3. **Only JSON**

   * JSON has value, DB **has none**. Show blue “From JSON only”.
4. **Only DB**

   * JSON **missing**, DB has value. Show purple “Suggested from DB”.
5. **Both Missing**

   * Neither JSON nor DB has a value. Show gray “Missing”.

> Keep the **same three fields** everywhere to avoid scope creep. This mirrors the “keys and conflicts” in plan and will later feed the “Save” logic.

### Step D — Render line-item cards (read-only)

* One card per item, showing:

  * `description`, `qty`, `unit_price`, `amount` (amount is derived; read-only)
  * `sku` (if any)
  * `hs_code`, `uom`, `type` as **read-only** fields
  * A tiny state badge per HS/UOM/Type (from Step C; colors + text) 
* No Save/Approve here (Phase 3 will enable those). The point is to **visually verify** that suggestions resolve as expected before we wire persistence.

### Step E — Wire from Queue → Review (no queue changes to behavior)

* Add a **Review** button that opens the new page in a **new tab**.
* Do **not** change the **XML** button behavior. It still streams `job.resultPath` as implemented today, so you can test Phase 2 without touching downloads.


## 3) Risks & Considerations

* **Key collisions**: If both `(vendorId, sku)` and `(vendorId, description)` return different rows, make sure your **display** still prefers SKU (you already set this rule in the plan). In Phase 2, just **show** the preference and mismatch—no writes yet.
* **Performance**: Batch DB lookups by invoice (one query per vendor + list of SKUs/descriptions) to avoid N+1 queries on long invoices.
* **UX overload**: Keep badges small with a top legend; don’t spam alerts. The user only needs to see what will need attention in Phase 3.
* **Drift with XML**: We are not altering downloads yet; Review is informational only, so the current XML flow remains stable. Your download endpoint already guards on `resultPath` and job status.

---

## 4) Expected Output

* A working **Review page (read-only)** that:

  * Opens from the Queue in a new tab.
  * Shows a **card per item** with the three fields (HS/UOM/Type).
  * Displays one of **five states** per field (Exact Match, Mismatch, Only JSON, Only DB, Both Missing) with colors + text.
  * **No** Save or Approve yet; XML downloads remain unchanged from the Queue.
* This matches your Phase plan and the earlier spec about keys, conflict policy, and keeping queue/download behavior intact. 