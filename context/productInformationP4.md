**Phase 4 — Save & Approve (write to DB + swap XML)**. 

---

## 1) Objectives

* Let reviewers **edit per-line fields** (SKU, HS, UOM, Type, qty, unit price) and **Save** them into `productInformation`.
* When all items are saved, **Approve** the invoice:

  * mark the invoice as **Approved** so the Queue shows **Approved = Yes**,
  * **regenerate XML using the saved values**, and
  * **replace the downloadable XML** so the existing **XML** button serves the approved file without changing its route or the user flow. Your web app already downloads the XML via the button and reads from `resultPath`, so we’ll keep using that.  

---

## 2) Steps

### A) Data model and flags

* **Add a review status to Job**; Boolean (isApproved). Column: isApproved BOOLEAN DEFAULT false. Meaning: false = invoice is still draft/unreviewed, true = invoice approved.
* **Keep using `resultPath`** as the single source for “what the XML button downloads.” On approval, write the approved XML back to `resultPath`. This keeps the current download endpoints and the **XML** button working as-is.

### B) API surface

Create three small endpoints:

1. **GET /api/review/{jobId}**

   * Returns: invoice metadata + line items + **suggestions** pulled from `productInformation` + **per-field states** (see below).
   * The front end uses this to populate the Review page.

2. **POST /api/review/{jobId}/line/{lineId}**

   * Body: the edited fields (SKU, HS, UOM, Type, qty, unit\_price).
   * Action: write into `productInformation` under the correct key (prefer `(vendorId, sku)` or else `(vendorId, description)`), return a tiny success payload for the “Saved ✓” feedback.

3. **POST /api/review/{jobId}/approve**

   * Preconditions: no “Dirty” cards (all edited lines are saved).
   * Actions:

     * set `reviewStatus = approved`,
     * rebuild XML using the now-confirmed values from `productInformation`,
     * **overwrite `resultPath`** with the approved XML so the existing XML download button and bulk ZIP keep working with zero UI changes.
   * Response: success + where the UI should navigate (back to Queue).

### C) Review page behavior (now editable)

* **Per-line cards** show "raw description" (read-only), "Description (Normalized)" (editable), qty, unit price, amount (read-only calculation), SKU, HS, UOM (dropdown), Type (dropdown).
* **Save** per card:

  * enabled when any field changes,
  * on click, write to DB and show “Saved ✓”, then disable until values change again.
* **Approve** at page level:

  * enabled on load,
  * disabled when any card becomes Dirty,
  * re-enabled only when **all** cards are saved,
  * on click, calls Approve endpoint and returns to Queue.

### D) Per-field states (HS, UOM, Type)

Show a small status chip on each field so it’s obvious what the system did:

1. **Match**
   JSON value exists, DB suggestion exists, and both are the same. No action needed.

2. **Divergent**
   JSON value exists, DB suggestion exists, but they differ. Show both, user decides which to keep. Saving writes the chosen value to `productInformation` for next time.

3. **JSON-only**
   JSON value exists, DB has nothing. If user trusts it, Save writes it to DB.

4. **DB-only**
   JSON missing, DB has a suggestion. If it looks right, Save accepts the DB value.

5. **Missing**
   Neither JSON nor DB has a value. User must fill it, then Save.

“Description” has two layers:
    * Raw = informational (not used for DB save).
    * Normalized = compared against DB and used as fallback key if SKU missing.

These states are visual only in Phase 4 (no auto-merge). They guide the reviewer to the minimum necessary edits before Approve.

### E) Queue page integration

* Keep the UI the same and add one **Approved** column (Yes/No).
* After Approve:

  * set **Approved = Yes** in the grid,
  * keep the **XML** button exactly as-is. It already calls the download route which streams from `resultPath`. Because we overwrite `resultPath` on Approve, the same button now serves the approved XML. 

### F) Approve flow

* When regenerating XML:
   * Use SKU if present.
   * Else use **Normalized Description** from `productInformation`.
   * Do **not** use raw description.

---

## 3) Tools & Resources (if helpful)

* **Prisma migration** to add `reviewStatus`/`isApproved` on `Job`, plus any simple logging you want. Your Prisma schema already includes `resultPath` and `artifactPath`, which we reuse.
* **Next.js API routes** for the three endpoints above.
* **React UI** changes inside the Queue and a new Review page. You already have action buttons for **XML** that enable/disable based on canDownload. Keep that behavior.

---

## 4) Risks & Considerations

* **Overwriting the draft XML:** simplest path for MVP. If you want to keep the draft, copy it to `artifactPath` before writing the approved file.
* **Partial saves:** Approve must be blocked if any card is Dirty. Show a clear toast: “Please save all changes first.”
* **Concurrency:** If two reviewers open the same invoice, the second Approve should fail gracefully with a message like “Invoice already approved.”
* **Validation:** qty and unit\_price are numbers; amount is computed and non-editable. Reject bad values with a clear inline error.
* **Bulk download:** It zips up `resultPath` files. Since we overwrite `resultPath` on Approve, bulk exports will automatically pick up the approved XML for approved jobs and the draft XML for unapproved ones. No extra work needed. 

---

## 5) Expected Output

By the end of Phase 4 you should be able to:

* Open **Review**, edit any fields, **Save** per line, then **Approve** once all cards are saved.
* Return to **Queue** and see **Approved = Yes**.
* Click the **XML** button and download the **approved** XML for approved invoices, and the **draft** XML for unapproved ones (same buttons, same routes). The button and routes already exist and rely on `resultPath`, which we now populate with the approved XML after Approve. 

If that lines up with how you want to work, we can lock this and move to the tiny migration + endpoints list.
