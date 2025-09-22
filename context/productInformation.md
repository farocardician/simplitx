Here’s the whole plan in plain English—high level only, no code.

# Goal

Introduce a human review step after the json→xml mapping process. Flow: On the Queue page, each invoice has a Review button. When clicked, it opens a review screen in new tab showing one card per item (description, qty, unit price, amount, SKU, HS code, UOM, Type). The reviewer can edit any field, then Save the item to store those values in productInformation for next time. When all items are saved, the reviewer clicks Approve to finalize the invoice and download the final reviewed XML. 

# Scope (MVP)

* Deterministic rules, no ML.
* One small reference table we control (`productInformation`) keyed by vendor.
* **XML button behavior (no change to existing flow):**
  * If the invoice **has not** been reviewed/approved, the **XML** button still downloads the **current draft XML** (same as today).
  * After you **Review → Save all items → Approve**, the **same XML** button downloads the **approved (modified) XML** generated from your saved values.
* **Review is mandatory only to mark the invoice “Approved” and to replace the draft with the approved XML.** Without approval, the draft XML remains downloadable but unapproved, and no facts are written to `productInformation`.  
* No extra fallbacks (synonym files, header scrapers) in MVP; we can add later.


# Core concepts

* **productInformation**: our “truth” library of approved facts. Grows over time.

# Data we keep (conceptual)

* `vendorId`
* `sku` (optional)
* `description` (description)
* `uomCode`, `optCode` (item/service), `hsCode`

# How each line gets a suggestion

1. After `pdf2json`, we prepare each line (description, qty, prices, etc.).
2. We try to **suggest** values in this order:

   * Match by `(vendorId, sku)`
   * Else by `(vendorId, description)`

3. Suggestions are just that—**not final**. Reviewer must approve.

# Review workflow (human-in-the-loop)

* Open the invoice’s **Review** page (new tab).
* **Approve** button is **enabled** on load (fast lane when everything looks right).
* Each line shows a card with: description, qty, unit price, amount (calculated), sku, hs code, uom (dropdown), type (dropdown).
* If the reviewer **does nothing**, they can hit **Approve** and finish.
* If the reviewer **edits any field** on a card:

  * That card becomes **Dirty** and its **Save** button enables.
  * The page-level **Approve** button disables until **all** dirty cards are saved.
* Hitting **Save** on a card:

  * Stores the approved values for that line into `productInformation` (under the right key).
  * Shows a tiny “Saved ✓” feedback and returns the card to a clean state (button save disabeld).
* Once **all** cards are clean (no unsaved edits), **Approve** re-enables.
* Clicking **Approve** finalizes the invoice and returns to the queue page in the same tab.

# Keys for saving (most specific wins)

* Prefer `(vendorId, sku)` when a SKU exists.
* Otherwise `(vendorId, description)`.

# Conflict policy (simple)

* If the raw row shows a clear **numeric UOM** conflicting with the suggestion, show a warning and let the reviewer choose. The choice they save becomes truth for next time.
* If both **SKU** and **family** suggestions exist, show **SKU** first (more specific).

Sounds good—keep the Queue exactly as it is today and add one simple column.

# Queue page

## What to show

* Keep all existing columns and actions (including the current **XML** download button).
* **Add one new column:** **Approved**

  * Value: **Yes** or **No**

## What “Approved” means

* **Yes** = the invoice has passed Review and the reviewer clicked **Approve**.
* **No** = never reviewed, or reviewed but not fully saved/approved.

## How it behaves

* **XML button (unchanged):**

  * If **Approved = No** → downloads the current **draft XML** (same as today).
  * If **Approved = Yes** → downloads the **approved XML** (built from saved values).
* After a reviewer clicks **Approve** on the Review page:

  * Set **Approved = Yes**
  * Return to Queue (where the new column shows **Yes** for that invoice).

## Acceptance criteria (quick)

* The Queue renders exactly as before plus an **Approved** column.
* Clicking **Review** → approve → back to Queue shows **Approved = Yes** for that invoice.
* The XML button continues to work exactly as now, with the content switching to approved XML only when **Approved = Yes**.

# What “Approve” does

* Confirms no Dirty cards (every item is either untouched or already Saved). If any card is Dirty, block approval and show a message: “Please save all changes first.”
* Finalizes the invoice for XML generation. Lock the invoice for this review session (no further edits unless you reopen). Mark status = Approved (so the Queue shows Approved = Yes). Generate/attach the Approved XML using the saved values (this is what the existing XML button will download going forward).

# Logging & audit (lightweight)

What to log:
On Save (per line): invoiceId, lineId, action:"save", reviewer, timestamp.
On Approve (per invoice): invoiceId, action:"approve", reviewer, timestamp.

# Rollout plan

1. Add `productInformation`
2. Add the **Review** UI
3. Wire up suggestions (read-only) first; then enable Save/Approve.
4. Run on a few invoices; ensure the loop feels fast and reliable.
5. Roll out to all vendors.

# Success looks like

* **Clear flow is followed:** Queue → **Review** (new tab) → edit cards → **Save** per item → **Approve** → download **final reviewed XML**.
* **Fast when known:** If all items are prefilled from `productInformation`, reviewer can open Review and immediately **Approve**.
* **Fast when new:** For new items, reviewer edits a few fields, hits **Save** on each card, then **Approve**.
* **Accurate output:** Approved invoices always download the **reviewed XML**; unapproved invoices still download the **draft XML**.