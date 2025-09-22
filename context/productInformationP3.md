**Phase 3 — “Save per item” and “Approve”** plan.

---

## 1) Objectives

* Let reviewers **edit fields** (HS, UOM, Type, SKU) on each item card.
* **Save** per item to `productInformation` using your key order: `(vendorId, sku)` else `(vendorId, description)`.
* Track **Dirty/Clean** at card level; **Approve** is allowed only when all cards are **Clean**.
* On **Approve**, generate the **approved XML** and keep the **existing XML download button** unchanged (same endpoint), so when Approved = Yes the download serves the approved XML via the same `resultPath`. (routes already read from `job.resultPath` for downloads.)

---

## 2) Steps

### Step A — Enable edit controls on the Review page

* **What to show (same layout as Phase 2):**
  
  * **UOM (dropdown):** populate from the `uom` table. Display format:** **`uom.name (uom.code)`**, e.g., **`Piece (UM.0021)`**.
  * Read-only: raw description, amount (amount remains calculated).
  * Editable: **Description (Normalized)**, **SKU (text)**, **HS code (text/number)**, **UOM (dropdown)**, **Type (dropdown: "Barang" or "Jasa")**.
  * Load once on page mount; reuse for all cards. If the list is long, add a simple type-ahead filter (optional).  
* **Guidance:** Keep inputs simple. Let invalid states be obvious (e.g., red outline if HS is non-numeric).

### Step B — Field states (per HS, UOM, Type)

Keep the **five read-only states** from Phase 2 and add two “editing” states. Show a tiny badge per field:

1. **Exact Match** — JSON and DB exist and are equal.
2. **Mismatch** — JSON and DB exist but differ.
3. **Only JSON** — JSON has value, DB empty.
4. **Only DB** — DB has value, JSON empty (a suggestion).
5. **Both Missing** — neither has value.
6. **Edited (dirty)** — user changed field on this card; not saved yet.
7. **Saved** — last change persisted; reflects DB suggestion now.

  * For **UOM**, show the badge against the **code** comparison, but **render** using **`name (code)`** so reviewers see both meaning and canonical ID.
  * Example conflict text: `JSON: Piece • DB: Box (UM.0045)` (DB side always shows `name (code)`).

> Use the color + text so users quickly scan which fields need attention.

### Step C — Dirty/Clean rules at **card level**

* A card flips to **Dirty** whenever any editable field changes from the last saved value.
* The card has a **Save** button:

  * **Enabled** only when card is Dirty.
  * On click, validate minimal rules (HS numeric if provided; UOM/Type within dropdown options).
  * If valid, call your **Save** API (Step D) then show a tiny **“Saved ✓”** micro-feedback and set the card to **Clean**.
* **Page Approve button**:

  * **Disabled** while any card is Dirty.
  * **Enabled** when all cards are Clean (or untouched).

### Step D — Save API (per item)

* **Endpoint shape (concept):** `POST /api/review/save`
* **Input:** `jobId`, `lineId` (or index), `vendorId`, the **final** `sku`, `description`, `uomCode`, `optCode`, `hsCode`.
* **Operation (MVP guidance):**

  * Resolve key: use `(vendorId, sku)` if `sku` present; else `(vendorId, description)`. Upsert into `productInformation`.
  * Return the **canonical values** you stored (echo back) so the UI can refresh the field states to **Saved** and card to **Clean**.
* **Why upsert:** guarantees “edit → Save” is idempotent and keeps per-vendor truth consistent with your plan.
* **Validate:** if `uomCode` is present, it **must exist** in `uom.code`; otherwise reject with “UOM not in list.”
* **Persist:** store **only** `uomCode` in `productInformation`.
* **Echo:** return the saved `uomCode` and its resolved `uom.name` so the UI can re-render **`name (code)`**.

### Step E — Conflict handling (simple, deterministic)

* If inputs conflict with obvious **numeric UOM** on the row (rare in MVP), show a small inline warning, but let user decide. The **saved choice** becomes truth next time.
* If both SKU-based and description-based suggestions exist, **prefer SKU** on display and when saving (more specific).

### Step F — Approve flow

* **Endpoint shape (concept):** `POST /api/review/approve`
* **Pre-checks (server-side):** verify **all** items for this job are saved/clean in this session. If any Dirty, return a clear error (“Please save all changes first.”).
* **On success (MVP):**

  1. Mark job **Approved** (`approved = true` or `approvedAt`).
  2. **Generate approved XML** using the saved values from `productInformation`.

     * Minimal path: **overwrite** the existing `resultPath` file with the approved XML so the current **XML** button and **bulk download** keep working without UI changes. Your routes already read `job.resultPath` and stream files from disk.
  3. Redirect back to Queue; show **Approved = Yes** (your plan).

> Why overwrite `resultPath` for MVP: it avoids new columns or branching logic in the download routes. You can version later if needed. The existing bulk/XML endpoints build ZIPs directly from `resultPath`, so this plugs in cleanly.

### Step G — Queue page behavior (unchanged UX)

* Leave the existing **XML** button untouched. It already downloads from `resultPath`. After Approve, it just serves the **approved** file.
* Add/keep the **Approved** column: **Yes/No**.

### Step H — Minimal validation & messaging

* **HS code**: digits only (allow blank).
* **UOM/Type**: must be from dropdown list.
* If validation fails, block Save with a small message under the field.
* If Save fails (server), show a compact toast with the exact reason.

### Step I — Simple acceptance checklist (you can test this)

* Edit one field → **Dirty** badge shows → **Save** enables → click Save → micro “Saved ✓”, badge goes **Saved**, card **Clean**.
* After all cards are Clean, **Approve** enables.
* Click **Approve** → back to Queue: **Approved = Yes**. XML download now returns approved XML from the **same** button.

---

## 3) Tools & Resources (IF ANY)

* **Next.js/React** — You already use this stack; just add controlled inputs and simple state for Dirty/Clean, plus a color legend for field states.
* **Prisma** — Use upsert for `productInformation` and a flag/timestamp on `job` for approvals.
* **Existing download routes** — Keep as-is. They read `job.resultPath` and stream files; by writing your approved XML to that path, you avoid route changes today.

---

## 4) Risks & Considerations

* **Key accuracy:** Saving under the wrong key (e.g., wrong `vendorId`, missing/incorrect SKU) will pollute lookups. Mitigation: show the **resolved key** on each card during Save (“Saving as: vendor=PT X, key=SKU: 12345”).
* **Overwriting `resultPath`:** MVP is simple, but you lose the draft XML. If you care, stash a timestamped copy before overwrite; still keep `resultPath` pointing to the approved file so the existing button works.
* **Long invoices / N+1 lookups:** When generating approved XML, fetch all `productInformation` rows for that invoice’s keys in one query (SKU set + description set).
* **Concurrent edits:** If two users open the same invoice, the second Approve could win. MVP mitigation: block Approve if `approved` already set, and show “Already approved.”
* **Dropdown sources:** Make sure UOM/Type dropdowns are small and canonical to avoid drift (even in MVP).

---

## 5) Expected Output

* **Review page (editable)** with per-field states and a **Save** button per card.
* **Dirty/Clean** logic works; **Approve** only enables when all cards are Clean.
* **Save** persists to `productInformation` using `(vendorId, sku)` else `(vendorId, description)`; saved values are echoed back and states switch to **Saved**.
* **Approve** sets the job as **Approved**, regenerates the XML using saved values, and **writes it to `resultPath`**, so the existing **XML** button (and bulk download) now serves the **approved XML** without any new UI changes.
* **Queue** shows **Approved = Yes** for that invoice.

That’s it — simple, deterministic, and shippable. If you want, I can map these steps onto your actual routes/files next.
