## 1) Objectives

* Let users **open a Review page** from Queue, edit invoice details, and **save** one final XML.
* Keep the **existing Download XML buttons** exactly as they are. They should serve the enriched XML right after save (because we overwrite `job.resultPath`).  
* On re-open, the Review page should load the **latest XML at `resultPath`** (so prior edits show up).
* Don’t add or change any **download endpoints** or the bulk ZIP flow. Those already stream files from `resultPath`.  

---

## 2) Phases / Steps

### Phase A — Queue page (small change)

**Goal:** Add a “Review” button that opens `/review/[jobId]` in a new tab. Keep **Download XML** untouched.

* Keep the current **download** behavior exactly as-is (it hits `/api/jobs/[id]/download`, which streams whatever is at `job.resultPath`).  
* Keep **Bulk download** untouched (it zips from `resultPath`).  
* Button “Review” will be enabled after the processing is done.

---

### Phase B — Review route skeleton

**Goal:** New page at `/review/[jobId]` with a **compact header** and **line item cards**.

* **Header format:** `Review Invoice {invoice_no} from {seller} to {buyer} {invoice_date}`. The date is editable via a date picker.
* Render a global **Save XML** (primary) and **Cancel / Back to Queue** (secondary) at the bottom.

**Data loading:**

* **Primary source of truth:** if `job.resultPath` exists, read and parse that XML into a shape your UI can render. If the result file is missing, fall back to JSON (get data from parser_result column final, you can find by job_id)

---

### Phase C — Line item cards and inputs

**Goal:** One compact card per line with the fields below and live validation.

* **Description** (text, required)
* **qty** (number, required)
* **unit_price** (number, required)
* **amount** (read-only = qty × unit_price, live)
* **SKU** (text, optional)
* **HS_Code** (number, required)
* **UOM** (dropdown from a canonical list, required)
* **Type** (chips `[Barang]` or `[Jasa]`, required)

**Hints:**

* Keep an **initial snapshot** of values when the page loads. The global **Save XML** button should stay **disabled** until any field differs from that snapshot.
* I want UOM lists in DB, import it from ./uom.csv
* Use simple inline errors under fields

---

### Phase D — Dirty tracking and validation

**Goal:** Reliable enable/disable for **Save XML** and clear errors.

* **Dirty state:** Compare current UI state vs. the initial snapshot (deep compare by line). If any difference, enable **Save XML**.
* **Validation rules** (examples, tweak as needed):

  * Required: description, qty, unit_price, HS, UOM, Type.
  * `qty` and `unit_price` are finite numbers ≥ 0.
  * `HS_Code` digits only
* If invalid: block save, show inline errors, keep the user on the page.

**Why:** This mirrors your current download behavior that expects a valid result file and avoids partial/broken XML writes. Your download endpoints assume a valid file exists and simply stream it. 

---

### Phase E — Save XML (single action)

**Goal:** When **Save XML** is clicked, regenerate the XML from the on-screen values and **overwrite** `job.resultPath`. Then redirect to `/queue` with a toast.

* **Server work:**

  1. Re-compose an invoice JSON from the UI payload.
  2. Transform it to XML (use the same mapping your pipeline uses for json→xml).
  3. **Write** the XML to the same path used by downloads (`job.resultPath`). Both the single download and bulk ZIP read from there, so you don’t need new endpoints.  
* **Client work:**

  * On success: redirect to `/queue` and show “XML saved.”
  * On failure: show a clear error and **stay** on the Review page.

**Notes:**

* Your existing **download** and **bulk** endpoints already stream/zip `resultPath` files; after save they’ll immediately serve the enriched XML.  

---

### Phase F — Re-editing later

**Goal:** If the user reopens Review for the same job, show the previously saved values.

* **Loader rule:** Try `resultPath` first (parse current XML). If not found, fall back to pipeline JSON/artifacts.  
* **Benefit:** No duplicate effort; the page reflects the last saved state every time.

---

### Phase G — Errors and edge cases

**Goal:** Stay predictable.

* **Validation fails:** keep user on Review, show inline errors.
* **Write fails (file permissions, path missing):** show a readable error; don’t redirect.
* **File missing on download:** Your download route already returns a 404 JSON with `NOT_FOUND`/`EXPIRED` messages when files are gone. Keep that behavior.  

---

## 3) Tools & Resources (optional)

* **Next.js / React** for the page and controlled inputs (you already use these).
* **Prisma** for job lookups and any metadata updates (no changes needed for download code).
* **Date picker:** a simple `<input type="date">` is fine; or a lightweight picker if you need better UX.
* **CSV or DB for UOM list:** choose one canonical source to avoid drift.

(Your bulk and single download endpoints already read and stream from `resultPath`, so nothing to add there.)  

---

## 4) Risks & Considerations

* **Overwriting `resultPath` loses the prior draft.** If you need an audit trail, first copy the pre-save XML to a timestamped file (e.g., under `artifactPath`) and then overwrite `resultPath`. Downloads still use `resultPath`.  
* **Round-tripping XML ↔ JSON.** Be explicit about the mapping so fields don’t drift (e.g., number formatting, decimal places, empty fields).
* **Concurrency.** Two editors saving at once could “last-write-wins.” For MVP, you can accept this. If needed, block save if file timestamp changed since load.
* **CSV drift for UOM.** If multiple services need UOM, consider a small table instead of a CSV to centralize updates.

---

## 5) Expected Output

A reviewer can:

* From **Queue**, click **Review** (new tab) while **Download XML** remains unchanged. 
* See a **compact header** (`Review Invoice …`) with an editable **invoice_date**.
* Edit line items with the fields you listed (amount computed live).
* **Save XML** (enabled only when something changed) → app **writes to `resultPath`** and redirects to **/queue** with a toast. 
* Immediately download the **enriched XML** from the existing **Download XML** button; **bulk download** also includes the saved file with no code changes to those routes.  
* Reopen Review later and see the **latest saved values** (loaded from `resultPath`). 

If you want, I can turn this into a file-by-file checklist next (which files to create/modify, where to read/write, and what each API returns) without writing actual code.
